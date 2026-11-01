/**
 * The branch RESTORE write — upstream `RestoreBranchPost`
 * (routers/web/repo/branch.go:108-135, web.go:1485's
 * `m.Post("/restore", repo.RestoreBranchPost)` under the web.go:1484-1489
 * group's gates `RepoMustNotBeArchived, reqRepoCodeWriter,
 * MustBeNotEmpty`) replayed over migration 0059's `deleted_branches`
 * substrate. This module completes the branches.tsx header's recorded
 * 3-step trigger: the delete arm writes the row PRE-CAS
 * (applyBranchDelete's step 4.5), the list renders the flagged rows with
 * their restore forms, and THIS module replays the ref creation from the
 * stored sha.
 *
 * ## The replay, in upstream's order
 *
 * 1. `GetDeletedBranchByID` (models/git/branch.go:209-217): the row by id
 *    AND repo_id — anything else is `missing` (upstream's
 *    ErrBranchNotExist → JSONErrorAuto's 404 family; existence stays
 *    hidden). The writer grant rides the same surface: a non-writer is a
 *    `missing` too (the reqRepoCodeWriter posture — the delete arm's
 *    non-writer 404 convention).
 * 2. The protected-name refusal: upstream has NO explicit check — its
 *    PushManaged goes through the real push pipeline and the branch
 *    protection hooks refuse the push, landing in the generic error arm
 *    (`restore_failed`; there is no dedicated restore-protection flash
 *    key). Our commitApiChange carries no hook, so the rule match is
 *    checked here and folded into the SAME observable: `refused-protected`
 *    → the handler maps it onto `?restore_error=failed` (restore_failed's
 *    text). Without this arm the module would be a protection-defeating
 *    path through the surface — the invariant branches.tsx's delete arm
 *    already holds. The render gate (list.tmpl's `{{if
 *    not .IsProtected}}`) hides the button; this is the write seam's
 *    defense-in-depth twin.
 * 3. The push replayed as the landed engine ref-write seam:
 *    `commitApiChange({ref: "refs/heads/{name}", expectedOldOid: ZERO_OID,
 *    newOid: commitId})` — the CAS create-on-empty IS "restore at the
 *    recorded sha". Result mapping:
 *      - `committed` → `restored`;
 *      - `ref_conflict` → the ref exists again → `already-exists`
 *        (upstream's push error containing "already exists" — the name
 *        was re-pushed or re-created since the delete);
 *      - `invalid` (refname junk in a corrupted row, or the recorded
 *        commit object gone from the store) and `importing` (mid-import
 *        cell) → `failed` (upstream's any-other-error arm).
 * 4. On success, the create-event webhook (the module header's trigger
 *    wording: the DeleteRef-style fan-out for the create event) —
 *    upstream's success path re-synthesizes the push update
 *    (PushUpdates, empty OldCommitID → the sha as NewCommitID) whose
 *    notifyBranchCreated lands as CreateRef; pages/branches.tsx's
 *    replayBranchRefWebhook carries the API create arm's exact payload
 *    shape (`{sha, ref, ref_type: "branch", repository, sender}`).
 *
 * ## ROUTE-SEAM HANDOFF (the orchestrator's fold — ui/index.ts)
 *
 * The module is landed; the POST tail is not registered yet. The branches
 * header's HANDOFF carries the three index.ts hunks (the `branch-restore`
 * family claim, the handler beside branchDeleteSubmit with the group
 * gates, the GET handler's two new flash params). Outcome → response
 * mapping for the handler: `missing` → the 404 shell; `restored` → 303
 * `?restored={name}`; `already-exists` → 303
 * `?restore_error=already_exists&name={name}`; `refused-protected` /
 * `failed` → 303 `?restore_error=failed&name={name}`. BranchesFlash
 * renders all three arms from the display-only params already (the props
 * are optional — the current call site compiles unchanged).
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { branchRef, engineCell, ZERO_OID } from "../../api/services/engine";
import { deletedBranches } from "../../db/schema";
import { listRepoRules, principalAccessOfRow } from "../../services/branch-protection";
import type { RepoRow } from "../ui-context";
import type { Viewer } from "../viewer";
import { firstMatchRule, protectionDoer, replayBranchRefWebhook, type BranchDeleteInput } from "./branches";

export type BranchRestoreResult =
  | { outcome: "restored"; name: string }
  | { outcome: "missing"; branchId: number } // unknown id / other repo / non-writer → the 404 shell
  | { outcome: "already-exists"; name: string } // the ref exists again — upstream's already_exists flash
  | { outcome: "refused-protected"; name: string } // the name matches a rule — folds into restore_failed's flash
  | { outcome: "failed"; name: string }; // invalid/importing — upstream's restore_failed flash

/**
 * The restore write, in RestoreBranchPost's order (the module header):
 * the row lookup, the writer grant, the protected-name refusal, the
 * `commitApiChange` create-on-empty replay, then the create-event webhook.
 */
export async function applyBranchRestore(
  env: Env,
  repo: RepoRow,
  viewer: Viewer,
  branchId: number,
  input: BranchDeleteInput,
): Promise<BranchRestoreResult> {
  // 1. GetDeletedBranchByID's port (id + repo_id — upstream's keyed lookup;
  //    the name column carries the branch's exact name, slashes included).
  const row = await drizzle(env.DB)
    .select()
    .from(deletedBranches)
    .where(and(eq(deletedBranches.id, branchId), eq(deletedBranches.repoId, repo.id)))
    .get();
  if (row === undefined) {
    return { outcome: "missing", branchId };
  }
  // The writer grant (reqRepoCodeWriter's posture — the delete arm's
  // non-writer 404 convention; the render gate never offers the button).
  const access = await principalAccessOfRow(env.DB, repo, protectionDoer(viewer));
  if (!access.write) {
    return { outcome: "missing", branchId };
  }
  // 2. The protected-name refusal (the module header's note: upstream's
  //    push-hook refusal — ANY rule on the name refuses the restored push
  //    unless whitelisted, and the template offers the control on
  //    non-protected rows only; folded into the restore_failed arm
  //    downstream).
  const rule = firstMatchRule(await listRepoRules(env.DB, repo.id), row.name);
  if (rule !== null) {
    return { outcome: "refused-protected", name: row.name };
  }
  // 3. The replay: create-on-empty AT THE RECORDED SHA (a WRITE RPC — a
  //    transport failure propagates, the honest 500).
  const result = await engineCell(env, input.pair.repo).commitApiChange({
    ref: branchRef(row.name),
    expectedOldOid: ZERO_OID,
    newOid: row.commitId,
  });
  if (result.tag === "ref_conflict") {
    return { outcome: "already-exists", name: row.name };
  }
  if (result.tag !== "committed") {
    // `invalid` (junk refname / the recorded commit gone from the store)
    // and `importing` land here — upstream's any-other-error arm.
    return { outcome: "failed", name: row.name };
  }
  // 4. The create-event webhook (upstream's PushUpdates re-synthesis →
  //    notifyBranchCreated; failures logged, never propagated). The row
  //    STAYS (invisible — the loader's live-ref filter stops rendering it;
  //    a re-delete overwrites it — the schema's upsert contract).
  await replayBranchRefWebhook(env, input, "create", row.name, row.commitId);
  return { outcome: "restored", name: row.name };
}

/** Parse the restore form (upstream's `ctx.FormInt64("branch_id")`): an
 *  integer parse or null — the handler 404-shells a null, exactly where a
 *  junk value's lookup miss would land upstream (FormInt64's 0 →
 *  ErrBranchNotExist → JSONErrorAuto). */
export function parseBranchRestoreForm(params: URLSearchParams): number | null {
  const raw = (params.get("branch_id") ?? "").trim();
  if (!/^-?\d+$/.test(raw)) return null;
  const id = Number.parseInt(raw, 10);
  return Number.isSafeInteger(id) ? id : null;
}
