import { ApiError } from "../errors";
import { loadRepoSettings } from "./repo-settings";
import type { RepositoryWithOwner } from "./repository";

/**
 * The issue/pull UNIT gates (not the scope gates — api/scope-gate.ts is a
 * different layer). Upstream mounts them as GROUP middleware on the API's
 * issue/pull subtrees, after `repoAssignment` and before every handler:
 *
 *   - `/repos/{username}/{reponame}/issues…` closes with
 *     `mustEnableIssuesOrPulls` (routers/api/v1/api.go:1674; the guard
 *     itself api.go:720-746): 404 unless the issues unit is readable OR
 *     (`CanEnablePulls()` AND the pulls unit is readable).
 *   - `/repos/{username}/{reponame}/pulls…` closes with
 *     `mustAllowPulls, reqRepoReader(unit.TypeCode)` (api.go:1478; the guard
 *     itself api.go:697-722): 404 unless `CanEnablePulls()` AND the pulls
 *     unit is readable.
 *   - the repo-level `/labels` and `/milestones` groups (api.go:1675-1688)
 *     carry NO unit gate — reads answer 200 on unit-less repos; only their
 *     write arms demand a writer of the issues-or-pulls units
 *     (`reqRepoWriter(unit.TypeIssues, unit.TypePullRequests)`).
 *
 * Both guards answer `ctx.APIErrorNotFound()` — the bare 404
 * `{"message":"not found","url":<swagger>}` (services/context/api.go:137-142)
 * — and both consult `ctx.Repo.Permission.CanRead(unit)`, which reads the
 * repo's ENABLED unit rows: a disabled unit is unreadable to EVERYONE (the
 * permission's units map carries enabled units only — owner and site admin
 * included, GetIndividualUserRepoPermission
 * models/perm/access/repo_permission.go:435-477 + UnitAccessMode :86-101).
 *
 * Storage reduction at this pin: the issues/pulls enabled state rides the
 * `repo_settings` flags (`has_issues` / `has_pull_requests`, written by
 * PATCH /repos/{owner}/{repo} through saveRepoSettings — the same store the
 * releases family's `mustEnableUnit` gate reads), not `repo_units` rows:
 * our repo_units table carries only the row-backed units (code / packages /
 * actions, src/db/schema.ts). Missing settings row = upstream's
 * DefaultRepoUnits posture (issues and pulls on) — every pre-seed repo stays
 * gated-open. `CanEnablePulls()` (models/repo/repo.go:583-585) reduces to
 * `!IsMirror && !IsArchived`: upstream also demands `!IsEmpty`, but our
 * `is_empty` flag is only maintained by the mirror-sync writer (repos are
 * created `isEmpty: true` and the push path never flips it), so the
 * emptiness arm would 404 the subtree on every pushed repo — it lands with
 * the isEmpty-maintenance fix, not before (documented divergence).
 *
 * `reqRepoReader(unit.TypeCode)` (the pulls group's second gate) is vacuous
 * here: every repo carries a seeded code unit row and the visibility
 * predicate the resolver already passed IS the code-unit read (the
 * has_code-flag reduction — PATCH accepts `has_code` but the stored posture
 * never drops the row).
 */

/** The gate inputs for one repo — the two unit flags plus the pull-enable
 *  precondition, resolved once per request. */
export interface IssuePullUnits {
  /** The issues unit is enabled (`repo_settings.has_issues`). */
  issues: boolean;
  /** The pulls unit is enabled (`repo_settings.has_pull_requests`). */
  pulls: boolean;
  /** Upstream `Repository.CanEnablePulls()` (repo.go:583-585) — the
   *  mirror/archived arms; the IsEmpty arm is the documented divergence. */
  canEnablePulls: boolean;
}

/** Resolve the gate inputs for one repo (one `repo_settings` read; a missing
 *  row renders the all-on default). */
export async function issuePullUnits(d1: D1Database, found: RepositoryWithOwner): Promise<IssuePullUnits> {
  const settings = await loadRepoSettings(d1, found.repo.id);
  return {
    issues: settings.hasIssues,
    pulls: settings.hasPullRequests,
    canEnablePulls: !found.repo.isMirror && !found.repo.isArchived,
  };
}

/**
 * `mustEnableIssuesOrPulls` (api.go:720-746, group close api.go:1674) — 404
 * "not found" unless the issues unit is readable or the pulls fallback
 * covers the repo. Returns the resolved units so callers that need the
 * handler-level narrowing (the list `type` filter, the per-issue check)
 * reuse them instead of re-reading the settings row.
 */
export async function assertIssuesOrPullsUnit(d1: D1Database, found: RepositoryWithOwner): Promise<IssuePullUnits> {
  const units = await issuePullUnits(d1, found);
  if (!units.issues && !(units.canEnablePulls && units.pulls)) {
    throw notFound();
  }
  return units;
}

/**
 * `mustAllowPulls` (api.go:697-722, group close api.go:1478) — 404 "not
 * found" unless the repo can enable pulls (not a mirror, not archived) and
 * the pulls unit is readable. Mounted on the whole `/pulls` subtree, this is
 * also why upstream answers the ARCHIVED repo's pulls reads AND writes
 * (including POST's `mustNotBeArchived` 423 family) with a 404: the group
 * gate runs first and `CanEnablePulls()` is false.
 */
export async function assertPullsUnit(d1: D1Database, found: RepositoryWithOwner): Promise<IssuePullUnits> {
  const units = await issuePullUnits(d1, found);
  if (!(units.canEnablePulls && units.pulls)) {
    throw notFound();
  }
  return units;
}

/**
 * The per-route `reqRepoReader(unit.TypeIssues)` arm of POST /issues
 * (api.go:1576) and GET /issues/pinned (api.go:1577) — 404 "not found" when
 * the issues unit itself is off, even though the group gate passed via the
 * pulls fallback.
 */
export async function assertIssuesUnitReadable(d1: D1Database, found: RepositoryWithOwner): Promise<IssuePullUnits> {
  const units = await issuePullUnits(d1, found);
  if (!units.issues) {
    throw notFound();
  }
  return units;
}

/**
 * ListIssues' `type` narrowing (routers/api/v1/repo/issue.go:375-390): an
 * explicit `type` against a unit the viewer cannot read is the 404; without
 * a type, the filter collapses to the readable side (only pulls readable →
 * `true`, only issues readable → `false`). Input/output use the parse
 * convention of services/issues.ts (`null` = no filter).
 */
export function narrowIssueListType(units: IssuePullUnits, isPull: boolean | null): boolean | null {
  if (isPull !== null) {
    if (!(isPull ? units.pulls : units.issues)) {
      throw notFound();
    }
    return isPull;
  }
  if (!units.issues) return units.pulls ? true : null;
  if (!units.pulls) return false;
  return null;
}

/**
 * `getRepoIssueByIndexForDoer`'s narrowing (issue.go:998-1009) — the
 * per-issue unit check every issue-by-index handler runs after the lookup:
 * 404 "not found" unless the issue's OWN unit (issues vs pulls) is readable.
 * This is what hides plain issues on a repo whose issues unit is off while
 * the pulls fallback keeps the subtree serving PRs.
 */
export function assertIssueRowUnit(units: IssuePullUnits, isPull: boolean): void {
  if (!(isPull ? units.pulls : units.issues)) {
    throw notFound();
  }
}

/** `ctx.APIErrorNotFound()` — the shared 404 body (services/context/api.go:137-142). */
function notFound(): ApiError {
  return new ApiError(404, "not found");
}
