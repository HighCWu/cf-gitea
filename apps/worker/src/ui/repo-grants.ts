/**
 * The UI render gates' bridge onto the landed repo-access service predicates
 * (SPEC-0008 tier-2; the UI half of the SPEC-0007 §3.5 write/admin team-arm
 * tail — commit 5f6d798's flagged gap): every page that decides whether to
 * RENDER a write/admin control (the file view's Edit/Delete + New File
 * chrome, the editor routes, the settings family incl. the wave-15 branches
 * panel, the milestones New button, the issue-page admin forms) evaluates
 * the SAME predicate the write seams enforce
 * (`canWriteRepository`/`isRepositoryAdmin`, src/api/services/repo-access.ts)
 * — never a session-viewer fork of the matrix, so a write/admin-mode
 * org-team member (and the org owner through the Owners-team bridge) sees
 * exactly the controls the API seams already admitted.
 *
 * The bridge is the ONE adaptation point between the page world (the
 * `Viewer` principal + the resolved `RepoRow`) and the service world (an API
 * `Context` whose `authUser` the predicates read through `viewerOf`): the
 * session viewer projects onto the three `User` fields the grant path reads
 (`id`/`login`/`is_admin` — the wire type's remaining fields are optional
 * and unread here), the repo pair re-resolves through the same
 * `findRepositoryById` join the editor write path uses, and the grant
 * function itself is injected by the caller so this module imports no
 * predicate (no import cycle, one call shape).
 */

import { Context } from "hono";

import type { ApiEnv } from "../api/env";
import type { User } from "../api/models/user";
import { findRepositoryById, type RepositoryWithOwner } from "../api/services/repository";
import type { RepoRow } from "./ui-context";
import type { Viewer } from "./viewer";

/**
 * The service-side identity of the session viewer: the `User` projection the
 * repo-access grants read (`requesterLoginLower`'s owner fold, `is_admin`'s
 * site-admin arm, `id`'s team-grant resolution).
 */
function sessionApiUser(viewer: Extract<Viewer, { kind: "user" }>): User {
  return { id: viewer.id, login: viewer.username, is_admin: viewer.isAdmin };
}

/**
 * Evaluate one repo-access grant for the page viewer. Anonymous viewers are
 * refused with ZERO D1 reads (the anonymous goldens' byte- and cost-stability
 * arm); a signed-in viewer pays one indexed pair read (repo × owner — the
 * editor write path's own resolution), then the injected service predicate
 * runs its landed arms verbatim (pure matrix → collaborator row → the
 * §3.5 team arm). A pair that does not resolve (an orphaned repo row) is
 * the §4.8 invisible-for-every-viewer refusal.
 *
 * The `Context` is requestless by design: the predicates read `authUser`,
 * `env.DB` and never the request — the fabricated URL's origin feeds only
 * `viewerOf`'s unused URL builder (the commitFileFromForm re-wrap precedent,
 * pages/file-editor.tsx).
 */
export async function sessionRepoGrant(
  env: Env,
  repo: RepoRow,
  viewer: Viewer,
  grant: (c: Context<ApiEnv>, pair: RepositoryWithOwner) => Promise<boolean>,
): Promise<boolean> {
  if (viewer.kind !== "user") return false;
  const pair = await findRepositoryById(env.DB, repo.id);
  if (pair === null) return false;
  const c = new Context<ApiEnv>(new Request("http://repo-grants.local/"), { env });
  c.set("authUser", sessionApiUser(viewer));
  return grant(c, pair);
}
