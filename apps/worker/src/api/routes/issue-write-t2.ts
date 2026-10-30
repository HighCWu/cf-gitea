import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { and, eq, gt, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { z } from "zod";

import { comments, issueLabels, issuePins, issues, labels, pullRequests } from "../../db/schema";
import { CommentType } from "../../issues/comment-types";
import { IssueNotExistError } from "../../issues/errors";
import type { IssueRow, LabelRow, PullRequestRow } from "../../issues/service";
import { emitIssueEvent, issueEventIdentity, issueEventPayload, type IssueEventIdentity } from "../../services/issue-events";
import { findIssueByRepoAndIndex, issueErrorToApiError, toApiIssue } from "../services/issues";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { pullRequestDiffShortStat } from "../services/pull-engine";
import { toApiPullRequest } from "../services/pulls";
import { assertIssueRowUnit, assertIssuesOrPullsUnit, type IssuePullUnits } from "../services/issue-unit-gates";
import { canWriteRepository } from "../services/repo-access";
import { canViewRepositoryWithTeams, findRepositoryByPath, viewerOf } from "../services/repository";
import type { RepositoryWithOwner } from "../services/repository";

/**
 * Tier-2 issue write-family routes riding the ALREADY-MIGRATED stores — the
 * single-label detach on an issue plus the pin/unpin/move-pin write trio
 * (SPEC-0004 appendix A category d rows issueRemoveLabel / pinIssue /
 * unpinIssue / moveIssuePin; the labels/pins/reactions/subscriptions family
 * around them landed in routes/issues.ts and routes/issue-t2.ts).
 *
 * Upstream mirrored (submodule pin fc4936884584):
 *   - DELETE …/issues/{index}/labels/{id} — routers/api/v1/repo/issue_label.go
 *     DeleteIssueLabel:125 (registered `reqToken(), mustNotBeArchived` at
 *     api.go:1620): the writer gate answers the bare 403 (issue_label.go:170),
 *     the label is resolved repo-scoped with the owner-org fallback
 *     (GetLabelInRepoOrOrgByID, models/issues/label.go:348 — a foreign id is
 *     indistinguishable from a missing one), and the detach is a guarded
 *     deleteIssueLabel (models/issues/issue_label.go:158): 0 rows = silent
 *     204, otherwise the label (7) comment — content "" marks the REMOVAL,
 *     the add path writes "1" (issue_label.go:45-52) — plus the label
 *     counter fold (updateLabelCols).
 *   - POST/DELETE …/issues/{index}/pin — routers/api/v1/repo/issue_pin.go
 *     PinIssue:16 / UnpinIssue:52 over models/issues/issue_pin.go PinIssue:61
 *     (max-pin cap + pin_order = max + 1 + the pin (36) comment), UnpinIssue:99
 *     (0-row delete = silent no-op; the unpin (37) comment otherwise).
 *   - PATCH …/issues/{index}/pin/{position} — issue_pin.go MoveIssuePin:88
 *     over MovePin (issue_pin.go:134): position < 1 refuses; same position is
 *     a no-op; the neighbours shift by one and the pin takes the slot.
 *
 * Auth mirrors upstream registration: every route here is a write behind
 * `reqToken()`; the pin group additionally carries `reqAdmin()`
 * (api.go:1663-1667) which collapses into the landed writer matrix
 * (canWriteRepository — repo owner / site admin / write collaborator), the
 * issue-t2 lock-group precedent. The label detach's in-handler
 * CanWriteIssuesOrPulls check reduces to the same matrix (the landed
 * EditIssueComment poster-or-writer rule without the poster arm — deleting a
 * label attachment is a repo-write act, not a content-authoring one).
 *
 * Declared responses mirror the vendored contract exactly (the label
 * detach's 422 is unreachable in practice — no bind, no query parse — but
 * stays declared per contract). RUNTIME-ONLY codes the handlers can still
 * emit (undeclared, NOT added to the orchestrator RUNTIME_ONLY_RESPONSES
 * tables by this batch — the landed convention):
 *   - pin over the per-type cap → 500 "the max number of pinned issues has
 *     been readched" (upstream ErrIssueMaxPinReached via APIErrorInternal,
 *     issue_pin.go:26/69 — the exact upstream message, typo included);
 *   - re-pinning a pinned issue → 500 (upstream 500s on the raw
 *     UNIQUE(repo_id, issue_id) violation; ours answers the deterministic
 *     "issue is already pinned" message, same undeclared arm);
 *   - move-pin with a position < 1 (including a non-integer path segment —
 *     Go PathParamInt parses it to 0, services/context/base_path.go:40) or
 *     an unpinned issue (GetIssuePin ErrNotExist) → 500, both upstream
 *     APIErrorInternal arms (issue_pin.go:137/146).
 *
 * Divergences: the pin cap is the hardcoded upstream default 3
 * (`setting.Repository.Issue.MaxPinned`, modules/setting/repository.go:223 —
 * no settings module yet); the archived-repo gate is wired on the label
 * detach only (upstream registers mustNotBeArchived there and NOT on the pin
 * group — the asymmetry is mirrored); the pin shift filters the issue/pull
 * split through an issues join because our `issue_pins` carries no is_pull
 * column (the landed listPinnedIssues does the same join).
 *
 * Webhook trigger (SPEC-0005 §3.5, the wave that lifted the old
 * "label detach emits nothing" deviation): the detach emits `issue_label` /
 * `pull_request_label` through the SHARED issue-family seam emitIssueEvent
 * (src/services/issue-events.ts) — see emitLabelDetachEvent. Upstream's
 * RemoveLabel (services/issue/label.go:56-75 → IssueChangeLabels,
 * services/webhook/notifier.go:572) notifies after the models-layer delete
 * with NO affected-rows guard, so the not-attached (silent-204) path emits
 * too; the payload is the shared Issue/PullRequest wrapper with action
 * "label_updated" and no `changes` block, the `issue.IsPull` discriminant
 * picks the event type.
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const repoArchivedResponse = {
  description: "repoArchivedError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const emptyResponse = { description: "empty" } as const;

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

const issueIndexParams = {
  ...ownerRepoParams,
  index: z.string().min(1).openapi({ type: "integer", format: "int64", description: "index of the issue" }),
} as const;

// ---------------------------------------------------------------------------
// Route declarations
// ---------------------------------------------------------------------------

const removeIssueLabelRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/issues/{index}/labels/{id}",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Remove a label from an issue",
    operationId: "issueRemoveLabel",
    request: {
      params: z.object({
        ...issueIndexParams,
        id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the label to remove" }),
      }),
    },
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
      422: validationErrorResponse,
      423: repoArchivedResponse,
    },
  });

const pinIssueRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "post",
    path: "/repos/{owner}/{repo}/issues/{index}/pin",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Pin an Issue",
    operationId: "pinIssue",
    request: {
      params: z.object({
        ...issueIndexParams,
        index: z
          .string()
          .min(1)
          .openapi({ type: "integer", format: "int64", description: "index of issue to pin" }),
      }),
    },
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const unpinIssueRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/issues/{index}/pin",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Unpin an Issue",
    operationId: "unpinIssue",
    request: {
      params: z.object({
        ...issueIndexParams,
        index: z
          .string()
          .min(1)
          .openapi({ type: "integer", format: "int64", description: "index of issue to unpin" }),
      }),
    },
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

const moveIssuePinRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "patch",
    path: "/repos/{owner}/{repo}/issues/{index}/pin/{position}",
    middleware: [requireAuth],
    tags: ["issue"],
    summary: "Moves the Pin to the given Position",
    operationId: "moveIssuePin",
    request: {
      params: z.object({
        ...issueIndexParams,
        index: z.string().min(1).openapi({ type: "integer", format: "int64", description: "index of issue" }),
        position: z.string().min(1).openapi({ type: "integer", format: "int64", description: "the new position" }),
      }),
    },
    responses: {
      204: emptyResponse,
      403: forbiddenResponse,
      404: notFoundResponse,
    },
  });

// ---------------------------------------------------------------------------
// Shared guards + plumbing (the issue-t2 file-local copies)
// ---------------------------------------------------------------------------

/** Go PathParamInt64 — non-integer strings become 0 (lookup miss → 404). */
function pathId(raw: string): number {
  if (!/^-?\d+$/.test(raw)) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

/** Go PathParamInt (services/context/base_path.go:40) — non-integer → 0. */
function pathInt(raw: string): number {
  return pathId(raw);
}

/** Repo resolution + visibility — the anti-enumeration 404. */
async function requireVisibleRepoPair(c: Context<ApiEnv>, path: { owner: string; repo: string }) {
  const viewer = viewerOf(c);
  const found = await findRepositoryByPath(c.env.DB, path.owner, path.repo);
  if (found === null || !(await canViewRepositoryWithTeams(c.env.DB, viewer, found.repo))) {
    throw new ApiError(404, "not found");
  }
  // The issues-group UNIT gate (mustEnableIssuesOrPulls, api.go:1674 +
  // api.go:720-746) at upstream's chain position — every route in this file
  // sits in upstream's /issues subtree, so the gate rides the shared
  // resolver: unit-less repos 404 before any handler logic. The resolved
  // units ride along for requireIssue's per-issue narrowing (one settings
  // read per request) (services/issue-unit-gates.ts).
  const units = await assertIssuesOrPullsUnit(c.env.DB, found);
  return { viewer, found, units };
}

/** Issue-by-index lookup answering the upstream ErrIssueNotExist 404, then
 *  `getRepoIssueByIndexForDoer`'s unit narrowing (issue.go:998-1009): an
 *  issue whose own unit (issues vs pulls) is unreadable is the same bare 404
 *  — plain issues hide on a pulls-fallback repo (services/issue-unit-gates.ts). */
async function requireIssue(c: Context<ApiEnv>, found: RepositoryWithOwner, rawIndex: string, units: IssuePullUnits): Promise<IssueRow> {
  const index = pathId(rawIndex);
  const issue = await findIssueByRepoAndIndex(c.env.DB, found.repo.id, index);
  if (issue === null) {
    throw issueErrorToApiError(new IssueNotExistError({ repoId: found.repo.id, index }));
  }
  assertIssueRowUnit(units, issue.isPull);
  return issue;
}

/** The signed-in doer id (requireAuth guarantees the identity; the id-less
 *  corner is the silent-auth-failure 401). */
function requireDoerId(c: Context<ApiEnv>): number {
  const id = c.get("authUser")?.id;
  if (id === undefined) {
    throw new ApiError(401, "token is required");
  }
  return id;
}

/** The reqAdmin() collapse — the upstream middleware message
 *  (routers/api/v1/api.go:386). */
async function requireRepoWriter(c: Context<ApiEnv>, found: RepositoryWithOwner): Promise<void> {
  if (!(await canWriteRepository(c, found))) {
    throw new ApiError(403, "user should be an owner or a collaborator with admin write of a repository");
  }
}

/** `mustNotBeArchived` (routers/api/v1/api.go:816) — 423 with that message. */
function assertNotArchived(found: RepositoryWithOwner): void {
  if (found.repo.isArchived) {
    throw new ApiError(423, "repo is archived");
  }
}

// ---------------------------------------------------------------------------
// Webhook trigger (issue_label / pull_request_label) — the SHARED issue-family
// seam (src/services/issue-events.ts); this module keeps only the payload
// assembly the detach route needs.
// ---------------------------------------------------------------------------

/** The single PR row of an issue (upstream `issue.LoadPullRequest`). */
async function findPullRequestRowByIssueId(d1: D1Database, issueId: number): Promise<PullRequestRow | null> {
  const rows = await drizzle(d1).select().from(pullRequests).where(eq(pullRequests.issueId, issueId)).limit(1).all();
  return rows[0] ?? null;
}

/**
 * The detach's webhook (`issue_label`, or `pull_request_label` for PRs — the
 * upstream `issue.IsPull` discriminant, notifier.go IssueChangeLabels:572-
 * 605). Payload = the shared Issue/PullRequest wrapper, action
 * "label_updated", no `changes` block — exactly the family shape routes/
 * issues.ts's emitLabelEvent emits (the assign/replace/clear twin; since the
 * emission-align wave BOTH sites ride the default wire render, so the
 * assignee blocks match too: issue-side the real set / empty-set Go nils,
 * PR-side real set with SliceNilAsEmpty's empty-[]). A missing PR row skips
 * the emission (upstream's LoadPullRequest failure logs and returns before
 * PrepareWebhooks). Never throws.
 */
async function emitLabelDetachEvent(c: Context<ApiEnv>, found: RepositoryWithOwner, issue: IssueRow): Promise<void> {
  const identity: IssueEventIdentity = issueEventIdentity(viewerOf(c), found, c.get("authUser"));
  try {
    if (issue.isPull) {
      const pr = await findPullRequestRowByIssueId(c.env.DB, issue.id);
      if (pr === null) {
        return;
      }
      // The payload conversion carries the diff-stat trio like every
      // ToPayloadPullRequest render (convert/pull.go:230-254, not gated on
      // isPayload; the omit arms — no merge base, truncated walk, engine
      // failure :247-250 — stay omitted).
      const diffStats = await pullRequestDiffShortStat(c, found, pr);
      await emitIssueEvent(c, {
        repoId: found.repo.id,
        ownerId: identity.ownerId,
        eventType: "pull_request_label",
        payload: {
          action: "label_updated",
          number: issue.index,
          // ToPayloadPullRequest (pull.go:30-37) — the webhook payload renders
          // the head repo regardless of the doer's visibility.
          pull_request: await toApiPullRequest(c.env.DB, viewerOf(c), found, issue, pr, "payload", diffStats === null ? undefined : { diffStats }),
          repository: identity.repository,
          sender: identity.sender,
          commit_id: "",
        },
      });
      return;
    }
    await emitIssueEvent(c, {
      repoId: found.repo.id,
      ownerId: identity.ownerId,
      eventType: "issue_label",
      payload: issueEventPayload(
        "label_updated",
        await toApiIssue(c.env.DB, viewerOf(c), found, issue),
        issue.index,
        identity.repository,
        identity.sender,
      ),
    });
  } catch (error) {
    console.error(`[issue-write-t2] webhook fan-out failed (issue_label): ${errorMessage(error)}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Label detach (deleteIssueLabel, models/issues/issue_label.go:158)
// ---------------------------------------------------------------------------

/**
 * GetLabelInRepoOrOrgByID (models/issues/label.go:348): the repo-scoped
 * lookup falls back to the owning org's labels when the owner is an org; a
 * foreign-but-existing id is indistinguishable from a missing one. Null on
 * the miss (the route renders the exact upstream 404 message).
 */
async function findLabelInRepoOrOrgById(d1: D1Database, found: RepositoryWithOwner, labelId: number): Promise<LabelRow | null> {
  if (labelId <= 0) {
    return null;
  }
  const byRepo = await drizzle(d1)
    .select()
    .from(labels)
    .where(and(eq(labels.id, labelId), eq(labels.repoId, found.repo.id)))
    .limit(1)
    .then((rows) => rows[0]);
  if (byRepo !== undefined) {
    return byRepo;
  }
  if (found.owner.type !== "org") {
    return null;
  }
  const byOrg = await drizzle(d1)
    .select()
    .from(labels)
    .where(and(eq(labels.id, labelId), isNull(labels.repoId), eq(labels.orgId, found.owner.id)))
    .limit(1)
    .then((rows) => rows[0]);
  return byOrg ?? null;
}

/** The upstream 404s of the label lookup — ErrRepoLabelNotExist /
 *  ErrOrgLabelNotExist (models/issues/label.go). */
function labelNotExistError(labelId: number, found: RepositoryWithOwner): ApiError {
  if (found.owner.type === "org") {
    return new ApiError(404, `label does not exist [label_id: ${labelId}, org_id: ${found.owner.id}]`);
  }
  return new ApiError(404, `label does not exist [label_id: ${labelId}, repo_id: ${found.repo.id}]`);
}

/**
 * deleteIssueLabel (issue_label.go:158-184) reduced to the modeled surface:
 * the link delete RETURNING is the guard — 0 rows means the label was not
 * attached and everything upstream skips (comment + counter fold) stays
 * skipped — else the label (7) removal comment (content "", upstream's
 * removed marker vs the add path's "1") and the closed-state-aware label
 * counter fold (updateLabelCols) in one batch.
 */
async function removeIssueLabel(d1: D1Database, issue: IssueRow, label: LabelRow, actorId: number, now: Date): Promise<boolean> {
  const removed = await drizzle(d1)
    .delete(issueLabels)
    .where(and(eq(issueLabels.issueId, issue.id), eq(issueLabels.labelId, label.id)))
    .returning({ labelId: issueLabels.labelId });
  if (removed.length === 0) {
    return false;
  }
  await drizzle(d1).batch([
    drizzle(d1).insert(comments).values({
      type: CommentType.Label,
      posterId: actorId,
      issueId: issue.id,
      labelId: label.id,
      content: "",
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1)
      .update(labels)
      .set(
        issue.isClosed
          ? { numIssues: sql`MAX(num_issues - 1, 0)`, numClosedIssues: sql`MAX(num_closed_issues - 1, 0)` }
          : { numIssues: sql`MAX(num_issues - 1, 0)` },
      )
      .where(eq(labels.id, label.id)),
    drizzle(d1)
      .update(issues)
      .set({ numComments: sql`num_comments + 1` })
      .where(eq(issues.id, issue.id)),
  ] as const);
  return true;
}

// ---------------------------------------------------------------------------
// Pins (models/issues/issue_pin.go)
// ---------------------------------------------------------------------------

/** `setting.Repository.Issue.MaxPinned` default (modules/setting/repository.go:223). */
const MAX_PINNED_PER_TYPE = 3;

/** One pin row (GetIssuePin, issue_pin.go:37) — null when unpinned. */
async function pinOfIssue(d1: D1Database, issueId: number): Promise<{ pinOrder: number } | null> {
  const row = await drizzle(d1)
    .select({ pinOrder: issuePins.pinOrder })
    .from(issuePins)
    .where(eq(issuePins.issueId, issueId))
    .limit(1)
    .then((rows) => rows[0]);
  return row ?? null;
}

/** Count + max(pin_order) over one repo's issue/pull half
 *  (getPinnedIssuesNum / getPinnedIssuesMaxPinOrder, issue_pin.go:119-131). */
async function pinStats(d1: D1Database, repoId: string, isPull: boolean): Promise<{ count: number; maxOrder: number }> {
  const rows = await drizzle(d1)
    .select({ pinOrder: issuePins.pinOrder })
    .from(issuePins)
    .innerJoin(issues, eq(issues.id, issuePins.issueId))
    .where(and(eq(issuePins.repoId, repoId), eq(issues.isPull, isPull)))
    .all();
  return { count: rows.length, maxOrder: rows.reduce((max, row) => Math.max(max, row.pinOrder), 0) };
}

/** The `is_pull` half-condition of the upstream pin updates — our issue_pins
 *  has no is_pull column, so the split rides an issues join (the landed
 *  listPinnedIssues does the same join). */
function sameTypeIssues(db: DrizzleD1Database, isPull: boolean) {
  return inArray(issuePins.issueId, db.select({ id: issues.id }).from(issues).where(eq(issues.isPull, isPull)));
}

/** PinIssue (issue_pin.go:61): the pin row at max + 1 plus the pin (36)
 *  comment, one batch. The caller ran the cap and duplicate checks. */
async function insertIssuePin(d1: D1Database, issue: IssueRow, actorId: number, now: Date): Promise<void> {
  const { maxOrder } = await pinStats(d1, issue.repoId, issue.isPull);
  await drizzle(d1).batch([
    drizzle(d1)
      .insert(issuePins)
      .values({ issueId: issue.id, repoId: issue.repoId, pinOrder: maxOrder + 1 })
      .onConflictDoNothing(),
    drizzle(d1).insert(comments).values({
      type: CommentType.Pin,
      posterId: actorId,
      issueId: issue.id,
      content: "",
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1)
      .update(issues)
      .set({ numComments: sql`num_comments + 1` })
      .where(eq(issues.id, issue.id)),
  ] as const);
}

/** UnpinIssue (issue_pin.go:99): the row delete is the guard — 0 rows = a
 *  silent no-op (upstream returns before the comment); otherwise the unpin
 *  (37) comment. True when something was unpinned. */
async function deleteIssuePin(d1: D1Database, issue: IssueRow, actorId: number, now: Date): Promise<boolean> {
  const removed = await drizzle(d1)
    .delete(issuePins)
    .where(eq(issuePins.issueId, issue.id))
    .returning({ issueId: issuePins.issueId });
  if (removed.length === 0) {
    return false;
  }
  await drizzle(d1).batch([
    drizzle(d1).insert(comments).values({
      type: CommentType.Unpin,
      posterId: actorId,
      issueId: issue.id,
      content: "",
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1)
      .update(issues)
      .set({ numComments: sql`num_comments + 1` })
      .where(eq(issues.id, issue.id)),
  ] as const);
  return true;
}

/**
 * MovePin (issue_pin.go:134) port: the neighbours between the old and new
 * slot shift by one, then the pin takes the new slot — one batch, the ranges
 * exclude the pin's own current order so the statements never self-interfere.
 * newPosition >= 1 and an existing pin are the caller's checks.
 */
async function moveIssuePin(d1: D1Database, issue: IssueRow, currentOrder: number, newPosition: number): Promise<void> {
  if (currentOrder === newPosition) {
    return;
  }
  const db = drizzle(d1);
  await db.batch([
    db
      .update(issuePins)
      .set({ pinOrder: currentOrder > newPosition ? sql`pin_order + 1` : sql`pin_order - 1` })
      .where(
        and(
          eq(issuePins.repoId, issue.repoId),
          sameTypeIssues(db, issue.isPull),
          currentOrder > newPosition
            ? and(gte(issuePins.pinOrder, newPosition), lt(issuePins.pinOrder, currentOrder))
            : and(gt(issuePins.pinOrder, currentOrder), gte(issuePins.pinOrder, newPosition)),
        ),
      ),
    db
      .update(issuePins)
      .set({ pinOrder: newPosition })
      .where(eq(issuePins.issueId, issue.id)),
  ] as const);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function registerIssueWriteT2Routes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  // -------------------------------------------------------------------------
  // DELETE …/issues/{index}/labels/{id} (issueRemoveLabel) — writer-only,
  // repo/org-scoped label lookup, guarded detach with the label (7) removal
  // comment; detaching a label that is not attached is the silent 204.
  // -------------------------------------------------------------------------
  app.openapi(removeIssueLabelRoute(requireAuth), async (c) => {
    const { found, units } = await requireVisibleRepoPair(c, c.req.valid("param"));
    assertNotArchived(found);
    const issue = await requireIssue(c, found, c.req.valid("param").index, units);
    if (!(await canWriteRepository(c, found))) {
      // Upstream DeleteIssueLabel: bare Status(403), empty message.
      throw new ApiError(403, "");
    }
    const labelId = pathId(c.req.valid("param").id);
    const label = await findLabelInRepoOrOrgById(c.env.DB, found, labelId);
    if (label === null) {
      throw labelNotExistError(labelId, found);
    }
    await removeIssueLabel(c.env.DB, issue, label, requireDoerId(c), new Date());
    // Webhook: IssueChangeLabels (notifier.go:572 via services/issue/
    // label.go:71-75) — the notify has no affected-rows guard, so the
    // not-attached silent-204 path emits too.
    await emitLabelDetachEvent(c, found, issue);
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // POST …/issues/{index}/pin (pinIssue) — reqToken + reqAdmin upstream; the
  // per-type cap and the duplicate-pin arm are the upstream 500s.
  // -------------------------------------------------------------------------
  app.openapi(pinIssueRoute(requireAuth), async (c) => {
    const { found, units } = await requireVisibleRepoPair(c, c.req.valid("param"));
    await requireRepoWriter(c, found);
    const issue = await requireIssue(c, found, c.req.valid("param").index, units);
    const { count } = await pinStats(c.env.DB, issue.repoId, issue.isPull);
    if (count >= MAX_PINNED_PER_TYPE) {
      // Upstream ErrIssueMaxPinReached via APIErrorInternal (issue_pin.go:69).
      throw new ApiError(500, "the max number of pinned issues has been readched");
    }
    if ((await pinOfIssue(c.env.DB, issue.id)) !== null) {
      // Upstream 500s on the UNIQUE(repo_id, issue_id) violation; the
      // deterministic message stands in for the driver text.
      throw new ApiError(500, "issue is already pinned");
    }
    await insertIssuePin(c.env.DB, issue, requireDoerId(c), new Date());
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // DELETE …/issues/{index}/pin (unpinIssue) — unpinning an unpinned issue is
  // the silent 204 (issue_pin.go:105-108).
  // -------------------------------------------------------------------------
  app.openapi(unpinIssueRoute(requireAuth), async (c) => {
    const { found, units } = await requireVisibleRepoPair(c, c.req.valid("param"));
    await requireRepoWriter(c, found);
    const issue = await requireIssue(c, found, c.req.valid("param").index, units);
    await deleteIssuePin(c.env.DB, issue, requireDoerId(c), new Date());
    return c.body(null, 204);
  });

  // -------------------------------------------------------------------------
  // PATCH …/issues/{index}/pin/{position} (moveIssuePin) — position < 1
  // (non-integer parses to 0, Go PathParamInt) and moving an unpinned issue
  // are the upstream 500 arms; the same position is the silent no-op.
  // -------------------------------------------------------------------------
  app.openapi(moveIssuePinRoute(requireAuth), async (c) => {
    const { found, units } = await requireVisibleRepoPair(c, c.req.valid("param"));
    await requireRepoWriter(c, found);
    const issue = await requireIssue(c, found, c.req.valid("param").index, units);
    const newPosition = pathInt(c.req.valid("param").position);
    if (newPosition < 1) {
      // MovePin's exact refusal (issue_pin.go:136), via APIErrorInternal.
      throw new ApiError(500, "The Position can't be lower than 1");
    }
    const pin = await pinOfIssue(c.env.DB, issue.id);
    if (pin === null) {
      // GetIssuePin's ErrNotExist via APIErrorInternal (issue_pin.go:141).
      throw new ApiError(500, "pin for the issue does not exist");
    }
    await moveIssuePin(c.env.DB, issue, pin.pinOrder, newPosition);
    return c.body(null, 204);
  });
}
