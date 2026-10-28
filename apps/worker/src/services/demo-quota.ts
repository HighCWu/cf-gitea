/**
 * The gated in-app demo quota (SPEC-0014 §4.3, milestone M2): the per-owner
 * repository-count cap, enforced at exactly the TWO create paths the SPEC
 * names — the API create (`POST /api/v1/user/repos`,
 * api/routes/user-repos.ts) and the push-create settle (git-http/gate.ts).
 * Both resolve through `RepoService.create`, but the check rides the call
 * sites (not the service) because RepoService carries no `env` — the SPEC's
 * "Two call sites, one helper, one indexed query".
 *
 * Upstream shape at the pin (`fc4936884584`), which this module mirrors:
 *
 *   - the limit check is `doer.CanCreateRepoIn(owner)`
 *     (gitea/models/user/user.go:285-295) — **a site-admin doer bypasses it
 *     with no count at all** (user.go:289-291), and otherwise the count is
 *     over the OWNER's repositories against `owner.MaxCreationLimit()`;
 *   - the refusal is `repo_model.ErrReachLimitOfRepo{Limit}`
 *     (gitea/models/repo/update.go:48-64) whose `Error()` text this module
 *     reproduces verbatim; it unwraps to `util.ErrPermissionDenied`, which
 *     the API create route maps to **403 + err.Error()**
 *     (gitea/routers/api/v1/repo/repo.go:256-258) — the mapping
 *     api/routes/user-repos.ts performs;
 *   - the push-create arm maps EVERY PushCreateRepo error to a bare 404
 *     (gitea/routers/web/repo/githttp.go:235-238) — the mask the gate's
 *     existing catch already performs, which the thrown error rides.
 *
 * The admin bypass is what keeps the demo operable: §6.2/§6.4 place the
 * demo's standing fixtures under the bootstrap ADMIN (whose repos are also
 * sweep-exempt), and upstream-faithfully an admin's creates are never
 * counted. Visitors (is_admin=false) hit the cap from both create paths.
 *
 * The §2 invariant governs: `assertDemoRepoQuota` begins with the
 * `demoModeEnabled` gate (the ONE gate function, services/demo-sweep.ts) and
 * returns before its FIRST D1 read when the gate is off — a default
 * deployment performs zero quota checks at either create path (the §4.3
 * reading of the hard invariant's "never rate-limits beyond the platform
 * plan"), pinned by the tripwire test in demo-quota.test.ts.
 *
 * TOCTOU note (honest scope): COUNT-then-create is not atomic — two
 * concurrent creates can both observe room and both land. Upstream has the
 * same check-then-insert shape (a repo-count race needs simultaneous
 * create bursts from one account, far below a demo's abuse horizon, and the
 * WAF layer of §4.1 bounds the request rate). Disclosed, not solved.
 */

import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories } from "../db/schema";
import { demoModeEnabled } from "./demo-sweep";

/**
 * The demo cap: repositories per owner (user or org) before creation is
 * refused. The SPEC (§4.3) prescribes the MECHANISM but leaves the number to
 * implementation — upstream's own default is unlimited
 * (`MAX_CREATION_LIMIT` defaults -1, gitea/modules/setting/repository.go:310),
 * which is exactly what a public writable demo cannot afford. 5 is generous
 * for a display session (create, push, open issues, show a friend) while
 * bounding the garbage a throwaway account can accumulate between the 72 h
 * sweeps; in code, not a var, per the §3.3 one-gate-one-constant posture.
 */
export const DEMO_MAX_REPOS_PER_OWNER = 5;

/**
 * The typed refusal — upstream `ErrReachLimitOfRepo.Error()` verbatim
 * (`user has reached maximum limit of repositories [limit: N]`,
 * gitea/models/repo/update.go:59-61). Callers map it: the API create route
 * answers 403 with exactly this message (repo.go:256-258, through the
 * ErrPermissionDenied unwrap), and the push-create catch masks it into the
 * bare 404 (githttp.go:235-238).
 */
export class DemoRepoQuotaError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`user has reached maximum limit of repositories [limit: ${limit}]`);
    this.name = "DemoRepoQuotaError";
    this.limit = limit;
  }
}

/**
 * The env slice the quota reads (the DemoSweepProducerEnv posture — both
 * members optional so the gate-off invariant tests can drive unset
 * structurally; the generated Env satisfies it). The DB binding rides in
 * explicitly because the call sites already hold it (the routes' `c.env.DB`,
 * the gate's `env.DB`).
 */
export type DemoQuotaEnv = {
  DEMO_MODE?: string;
};

/** The doer identity the check needs — `isAdmin` only (the
 * `CanCreateRepoIn` bypass reads nothing else; both landed doer shapes —
 * the users row and the gate's verified user — carry it). */
export type DemoQuotaDoer = {
  isAdmin?: boolean | null;
};

/**
 * The gated check (§4.3): refuse creation past `DEMO_MAX_REPOS_PER_OWNER`
 * repositories for `ownerId`. Gate OFF (or an admin doer — the upstream
 * bypass) → return with ZERO D1 reads. Armed and non-admin → one COUNT
 * over the indexed `repositories_owner_id_idx` (schema.ts:223), and at the
 * cap a `DemoRepoQuotaError` carrying the upstream text.
 */
export async function assertDemoRepoQuota(
  env: DemoQuotaEnv,
  db: D1Database,
  doer: DemoQuotaDoer,
  ownerId: number,
): Promise<void> {
  // THE GATE (§2, the §4.3 arm) — before the first D1 read: a default
  // deployment's create paths run exactly as before this module existed.
  if (!demoModeEnabled(env)) return;
  // The upstream admin bypass (user.go:289-291): a site-admin doer creates
  // freely — no count, no refusal. This is also what keeps the demo's
  // admin-owned fixtures mintable past the cap (§6.2).
  if (doer.isAdmin === true) return;
  const totals = await drizzle(db)
    .select({ n: count() })
    .from(repositories)
    .where(eq(repositories.ownerId, ownerId));
  const n = totals[0]?.n ?? 0;
  if (n >= DEMO_MAX_REPOS_PER_OWNER) {
    throw new DemoRepoQuotaError(DEMO_MAX_REPOS_PER_OWNER);
  }
}
