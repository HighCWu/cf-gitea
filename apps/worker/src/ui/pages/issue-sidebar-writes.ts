/**
 * The issue/PULL DETAIL page's SIDEBAR COMBO-LIST WRITES + HEADER BUTTONS —
 * census gap #1, part one (the L cluster split), upstream
 * routers/web/web.go:1362-1405 at the pin (the `addIssuesPullsUpdateRoutes`
 * group mounted under BOTH `/{type:issues}` and `/{type:pulls}`):
 *
 *   - POST /{owner}/{repo}/{issues|pulls}/milestone      repo.UpdateIssueMilestone   (web.go:1398)
 *   - POST /{owner}/{repo}/{issues|pulls}/projects       repo.UpdateIssueProject     (web.go:1399)
 *   - POST /{owner}/{repo}/{issues|pulls}/assignee       repo.UpdateIssueAssignee    (web.go:1401)
 *   - POST /{owner}/{repo}/{issues|pulls}/{index}/deadline  repo.UpdateIssueDeadline (web.go:1367)
 *   - POST /{owner}/{repo}/{issues|pulls}/{index}/watch     repo.IssueWatch          (web.go:1368)
 *   - POST /{owner}/{repo}/{issues|pulls}/{index}/lock      repo.LockIssue           (web.go:1388)
 *   - POST /{owner}/{repo}/{issues|pulls}/{index}/unlock    repo.UnlockIssue         (web.go:1389)
 *   - POST /{owner}/{repo}/{issues|pulls}/{index}/pin       repo.IssuePinOrUnpin     (web.go:1370, reqRepoAdmin)
 *   - DELETE /{owner}/{repo}/{issues|pulls}/unpin/{index}   repo.IssueUnpin          (web.go:1404, reqRepoAdmin)
 *   - POST /{owner}/{repo}/{issues|pulls}/move_pin          repo.IssuePinMove        (web.go:1405, reqRepoAdmin)
 *
 * This is the b91dd1c handoff pattern (pages/issue-write-tails.ts is the
 * freshest twin): the index.ts router is owned by a flying sibling, so the
 * POST handlers live HERE — self-contained (origin guard → session → repo
 * resolution → write gate → service seam → respond), JSX-free, importing
 * only leaf modules — while the index.ts recipe below is executed at the
 * fold. The RENDER half (the sidebar/header form controls posting to these
 * routes) lives in pages/issue-detail.tsx's IssueSidebar; the dependency is
 * strictly one-way (this module → that one's render entry), never cyclic.
 *
 * ## Mount recipe (the exact hunks; positions beside the landed claims)
 *
 * 1. Import the handlers beside the other page-module imports:
 *
 *      import {
 *        issueMilestoneSubmit,
 *        issueProjectsSubmit,
 *        issueAssigneeSubmit,
 *        issueDeadlineSubmit,
 *        issueWatchSubmit,
 *        issueLockSubmit,
 *        issueUnlockSubmit,
 *        issuePinSubmit,
 *        issueUnpinSubmit,
 *        issueMovePinSubmit,
 *      } from "./pages/issue-sidebar-writes";
 *
 * 2. Route unions (beside IssueCommentRoute/IssueLabelsRoute, the wave-5
 *    write-family block ~line 2021-2040). One interface:
 *
 *      /** The census-gap-#1 sidebar/header write families (pages/
 *       *  issue-sidebar-writes.ts): upstream addIssuesPullsUpdateRoutes
 *       *  (web.go:1362-1405) — POST-only except the DELETE unpin tail;
 *       *  `urlKind` records the addressing family, the redirect target is
 *       *  always the row's OWN canonical family (upstream Issue.Link()). *\/
 *      export interface IssueSidebarWriteRoute {
 *        family:
 *          | "issue-milestone"     // POST /{issues|pulls}/milestone
 *          | "issue-projects"      // POST /{issues|pulls}/projects
 *          | "issue-assignee"      // POST /{issues|pulls}/assignee
 *          | "issue-move-pin"      // POST /{issues|pulls}/move_pin (JSON body)
 *          | "issue-deadline"      // POST /{issues|pulls}/{index}/deadline
 *          | "issue-watch"         // POST /{issues|pulls}/{index}/watch
 *          | "issue-lock"          // POST /{issues|pulls}/{index}/lock
 *          | "issue-unlock"        // POST /{issues|pulls}/{index}/unlock
 *          | "issue-pin"           // POST /{issues|pulls}/{index}/pin
 *          | "issue-unpin";        // DELETE /{issues|pulls}/unpin/{index}
 *        owner: string;
 *        repo: string;
 *        urlKind: "issues" | "pulls";
 *        /** The {index} path param (the {index}-bearing families; the
 *         *  repo-scope combos carry the issue id on the form instead). *\/
 *        index?: number;
 *      }
 *
 * 3. `parseUiRoute`'s `head === "issues" || head === "pulls"` arm: in the
 *    length-1 static block (the wave-5 labels / wave-11 review / wave-2e
 *    aux statics, around line 4904-4915) add
 *
 *      // Census gap #1: the repo-scope sidebar combo POSTs + the pin
 *      // reorder tail (web.go:1398-1405). The static literals outrank the
 *      // dynamic :index (the wave-5 label-write rule).
 *      if (rest[0] === "milestone") return { family: "issue-milestone", owner, repo, urlKind: head };
 *      if (rest[0] === "projects") return { family: "issue-projects", owner, repo, urlKind: head };
 *      if (rest[0] === "assignee") return { family: "issue-assignee", owner, repo, urlKind: head };
 *      if (rest[0] === "move_pin") return { family: "issue-move-pin", owner, repo, urlKind: head };
 *
 *    and in the length-2 `{index}` block (the wave-5 comments/files block,
 *    around line 4923-4933) add
 *
 *      // Census gap #1: the {index}-bearing sidebar/header writes
 *      // (web.go:1367-1370/1388-1389).
 *      if (rest[1] === "deadline") return { family: "issue-deadline", owner, repo, urlKind: head, index };
 *      if (rest[1] === "watch") return { family: "issue-watch", owner, repo, urlKind: head, index };
 *      if (rest[1] === "lock") return { family: "issue-lock", owner, repo, urlKind: head, index };
 *      if (rest[1] === "unlock") return { family: "issue-unlock", owner, repo, urlKind: head, index };
 *      if (rest[1] === "pin") return { family: "issue-pin", owner, repo, urlKind: head, index };
 *
 *    and in the length-3 block (the content-history block, around line
 *    4934-4961) add
 *
 *      // Census gap #1: the DELETE unpin tail (web.go:1404 — a
 *      // THREE-segment shape: /{family}/unpin/{index}; the index rides the
 *      // THIRD segment here, unlike every {index} route above).
 *      if (rest[1] === "unpin" && /^-?\d+$/.test(rest[2] as string)) {
 *        return { family: "issue-unpin", owner, repo, urlKind: head, index: Number.parseInt(rest[2] as string, 10) };
 *      }
 *
 *    (claim only the exact literal tails; every other tail stays
 *    engine-owned exactly as the arm's doc says — `/status`, `/title`,
 *    `/content`, `/ref`, `/viewed-files`, `/dependency/*`, `/times/*`,
 *    `/time_estimate`, `/reactions/*`, `/delete`, `/projects/column` and
 *    the comment-update cluster remain the later parts' surface).
 * 4. Register beside the landed write families — the static repo-scope
 *    literals AFTER the dynamic `/issues/:index` GET line is NOT an option
 *    (the wave-9 RegExpRouter note: a static registered after the dynamic
 *    :index LOSES to it), so the four repo-scope POST/405 pairs go beside
 *    the wave-5 label-write/review-write statics (around line 16073-16081),
 *    and the {index} writes beside the wave-5 comments pairs (around line
 *    16096-16099):
 *
 *      // Census gap #1 sidebar writes (pages/issue-sidebar-writes.ts) —
 *      // static-before-dynamic (the wave-5 label-write rule); both URL
 *      // families (upstream mounts the group on both; the templates always
 *      // post the combos through /issues/*).
 *      uiRouter.post("/:owner/:repo/issues/milestone", (c) => issueMilestoneSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/milestone", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/pulls/milestone", (c) => issueMilestoneSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/milestone", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/issues/projects", (c) => issueProjectsSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/projects", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/pulls/projects", (c) => issueProjectsSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/projects", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/issues/assignee", (c) => issueAssigneeSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/assignee", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/pulls/assignee", (c) => issueAssigneeSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/assignee", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/issues/move_pin", (c) => issueMovePinSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/move_pin", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/pulls/move_pin", (c) => issueMovePinSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/move_pin", () => methodNotAllowed("POST"));
 *
 *      // Census gap #1 {index}-bearing writes — beside the wave-5 comments
 *      // pairs; the DELETE unpin's GET twin answers chi's 405.
 *      uiRouter.post("/:owner/:repo/issues/:index/deadline", (c) => issueDeadlineSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/:index/deadline", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/pulls/:index/deadline", (c) => issueDeadlineSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/:index/deadline", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/issues/:index/watch", (c) => issueWatchSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/:index/watch", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/pulls/:index/watch", (c) => issueWatchSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/:index/watch", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/issues/:index/lock", (c) => issueLockSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/:index/lock", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/pulls/:index/lock", (c) => issueLockSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/:index/lock", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/issues/:index/unlock", (c) => issueUnlockSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/:index/unlock", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/pulls/:index/unlock", (c) => issueUnlockSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/:index/unlock", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/issues/:index/pin", (c) => issuePinSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/:index/pin", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/pulls/:index/pin", (c) => issuePinSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/:index/pin", () => methodNotAllowed("POST"));
 *      uiRouter.delete("/:owner/:repo/issues/unpin/:index", (c) => issueUnpinSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/unpin/:index", () => methodNotAllowed("DELETE"));
 *      uiRouter.delete("/:owner/:repo/pulls/unpin/:index", (c) => issueUnpinSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/unpin/:index", () => methodNotAllowed("DELETE"));
 *
 *    (the DELETE unpin is a /unpin/ LITERAL + dynamic :index — registered
 *    beside the statics it also outranks nothing; both orders are safe for
 *    a literal-prefixed dynamic tail).
 *
 * ## Pin lines that flip at THIS fold (test-side; edited at the fold, not
 *    here — this unit's tests stay green pre-fold by driving the module's
 *    recipe router directly)
 *
 *    - apps/worker/src/ui/pages/issue-detail.matrix.test.tsx — THIS UNIT's
 *      file; the three unclaimed-write pins flip in this window (the
 *      census-gap-#1 describe there carries the new pins):
 *        · "upstream's milestone/assignee/status sidebar write POSTs stay
 *          unclaimed" — milestone/assignee flip to the claimed ladders;
 *          `/issues/status` STAYS unclaimed (out of this unit's scope).
 *        · "the subscribe seam's upstream POST tails stay unclaimed" —
 *          /{issues,pulls}/{n}/watch flip to the 303+write ladder.
 *        · "the assignee/participant/subscribe sections render nothing" —
 *          the Assignees display list now renders for every reader;
 *          Participants stays absent; Subscribe/Unsubscribe flip to the
 *          signed-in button arm (that test's anonymous GETs stay
 *          button-less, so only the Assignees half flips).
 *    - apps/worker/src/ui/index.test.ts — the parse pins for the newly
 *      claimed shapes. Grepped at build time: index.test.ts carries NO
 *      null pins for `/{issues,pulls}/milestone|projects|assignee|move_pin`
 *      or `/{issues,pulls}/{n}/{deadline,watch,lock,unlock,pin}` or
 *      `/unpin/{n}` (its issue-family pins are the detail/comments/labels
 *      shapes — landed claims). NO pin flips there. The wave-2 unclaimed
 *      pins hold too: `/pulls/7/8` (a numeric second segment) and
 *      `/issues/5/labels` (the label write lives on the bare /issues/labels
 *      literal) collide with none of the claimed literals above.
 *    - apps/worker/src/ui/__tests__/goldens/*.html — the three issue-family
 *      goldens (issue-detail.html anonymous, pull-detail.html anonymous,
 *      pull-review-signed-in.html owner-signed-in) grow the new sidebar
 *      sections/forms and MUST be regenerated at the fold:
 *      `node src/ui/__tests__/update-goldens.mjs` (the script rewrites ALL
 *      goldens — run it ONLY at a quiet tree, never mid-wave; goldens.test.ts
 *      stays RED until then, that file's header carries the procedure).
 *
 * ## Behavior (upstream handlers at the pin, reduced to the landed posture)
 *
 * - Gates. Upstream's group carries NO sign-in middleware (the handlers
 *   assume a doer; an anonymous watch POST would nil-deref upstream) and
 *   per-route `reqRepoIssuesOrPullsWriter` (milestone/projects/assignee/
 *   lock/unlock) or `reqRepoAdmin` (pin/unpin/move_pin); watch and deadline
 *   sit on the bare group (deadline checks the writer INSIDE the handler,
 *   answering a 403 HTML error — answered here as the landed writer gate's
 *   404 shell, the repoLabelsWriteGate posture applied uniformly). The
 *   landed posture everywhere (issueCommentSubmit/repoLabelsWriteGate):
 *   anonymous → the §2.5 login 303; archived or non-writer/non-admin → the
 *   §4.5 404 shell. `canWriteRepo` (the file-editor bridge onto the landed
 *   canWriteRepository) stands in for RequireUnitWriter(issues, pulls);
 *   `canAdminRepo` (the settings predicate, the issue-detail label-form's
 *   documented stand-in) for RequireRepoAdmin.
 * - Success answers. Upstream answers JSONRedirect(issue.Link()) /
 *   JSONOK() — a 200 JSON body the form-fetch JS turns into a redirect or
 *   a sidebar reload. The landed no-JS convention (issueCommentSubmit): a
 *   303 onto the row's OWN canonical family page
 *   `/{owner}/{repo}/{issues|pulls}/{index}` (the combo writes and the
 *   JSONOK arms included — the JS reload this redirect replaces). The
 *   unpin/move_pin tails answer upstream's Status(204) verbatim.
 * - Failure answers. Upstream's JSONError messages (lock duplicate, unlock
 *   error, max-pinned) and the in-handler 403s (unassignable user) re-render
 *   the detail page at 200 with the upstream message in the comment form's
 *   error slot (the landed issueLabelsSubmit convention — the only message
 *   channel the no-JS page has). Handler-internal ServerErrors (foreign
 *   milestone id, missing move_pin issue/pin) are upstream 500s — answered
 *   as the plain-text 500 (compare.tsx's honest-500 posture) or the 404
 *   shell where upstream's own lookup was repo-scoped (deadline, unpin).
 * - The combos' wire (repo-issue-sidebar-combolist.ts, the upstream JS this
 *   reduction replaces): the "all" algo posts ONE `id=<comma-joined>` field;
 *   the "diff" algo posts per-item `action=attach|detach` + `id` toggles.
 *   The no-JS forms post the FULL set (`issue_ids` + multi-value or
 *   comma-joined `id`) and the writes diff server-side — the landed label
 *   form's documented reduction ("one diff-based write with the same end
 *   state", pages/issue-detail.tsx wave-5 header). Parsers accept BOTH
 *   shapes (multi-value getAll + comma-split per value) so upstream's JS
 *   wire stays byte-compatible.
 * - UpdateIssueMilestone (issue.go:403-433): the same-milestone submit is
 *   the no-op arm (`if oldMilestoneID == milestoneID continue` — no write,
 *   no comment); a positive id resolves repo-scoped (GetMilestoneByRepoID —
 *   a foreign/missing id is upstream's ServerError 500, answered here as
 *   the 404 shell, the landed uniform not-found); the change rides the
 *   landed `changeIssueMilestone` (the milestone(8) comment + the counter
 *   moves, api/services/issues.ts:1466).
 * - UpdateIssueProject (projects.go:448-481 over IssueAssignOrRemoveProject,
 *   models/issues/issue_project.go): the posted project-id set diffs the
 *   current memberships; adds resolve the project UNSCOPED (upstream
 *   GetProjectsMapByIDs) and a missing id is upstream's ServerError 500
 *   (the plain-text 500 here); a project the repo cannot access
 *   (CanBeAccessedByOwnerRepo — repo-scoped, or owner-scoped with matching
 *   ownerId) is upstream's permission-denied SKIP arm (the write still
 *   succeeds — the failedIssues log-and-continue); adds land through the
 *   landed `addIssueToColumn` into the default column (the landed seam that
 *   already ports the add arm + the project(30) comment), removals through
 *   `removeIssueFromColumn` with the membership's own column row (the
 *   landed remove seam + comment). The `/projects/column` column-move tail
 *   (web.go:1400) is NOT this unit's surface — no column select renders.
 * - UpdateIssueAssignee (issue.go:436-477): `action=clear` clears every
 *   assignee (DeleteNotPassedAssignee — the landed removeIssueAssignees
 *   over the current set); otherwise the posted ids resolve through the
 *   users table, an ORG row or a canBeAssigned refusal is the upstream
 *   403 "User {id} cannot be assigned to this issue" (the re-render
 *   message), and the diff (posted − current attaches, current − posted
 *   detaches) rides the landed `addIssueAssignees`/`removeIssueAssignees`
 *   (the type-9 comments ride inside; their internal requireAssignable is
 *   the belt to this handler's suspenders). Upstream toggles per single id
 *   — the JS diff direction made each toggle net-correct; the server-side
 *   diff is the same end state (the labels reduction note). Every
 *   ACTUALLY-changed assignee emits the upstream webhook family through
 *   the landed `emitAssignEvent` (routes/issues.ts — the same emitter the
 *   /assignees trio routes call) over a fabricated API context (the
 *   repo-grants bridge pattern), best-effort — a webhook failure never
 *   fails the write (compare.tsx's emission posture). The landed trio's
 *   posture is webhook-only (the mail arm rides IssuesService.changeAssignees,
 *   the create-path seam) — mirrored here.
 * - UpdateIssueDeadline (issue.go:377-400): `deadline` parses as
 *   yyyy-mm-dd END-OF-DAY UTC (the landed milestones parser's zone rule —
 *   upstream uses setting.DefaultUILocation, our deployments are UTC);
 *   empty OR unparseable clears (upstream IGNORES the parse error — the
 *   zero timestamp clears, common/deadline.go:15-24); the unchanged
 *   deadline is the no-op arm (models/issues/issue_update.go:531-535 "if
 *   the deadline hasn't changed, do nothing"); the change rides the landed
 *   `changeIssueDeadline` (the added/modified/removed comments 16/17/18).
 * - IssueWatch (issue_watch.go:19-34): `watch` reads from the QUERY STRING
 *   (the upstream watching.tmpl button's data-fetch-url shape — FormBool
 *   reads query params too) through the landed `setIssueSubscription`
 *   (the CreateOrUpdateIssueWatch upsert); upstream re-renders the
 *   tplWatching fragment (a JS island) — the landed answer is the canonical
 *   303. Any signed-in viewer (upstream's bare-group posture reduced to
 *   the session gate).
 * - LockIssue/UnlockIssue (issue_lock.go:15-60): the duplicate-lock and
 *   unlock-not-locked guards answer upstream's exact messages ("An issue
 *   cannot be locked twice." / "Cannot unlock an issue that is not
 *   locked.") as the 200 re-render; the flips ride the landed
 *   `lockIssue`/`unlockIssue` (issue-extras.ts — the Lock/Unlock system
 *   comments; the `reason` field is accepted and NOT stored — the landed
 *   issue-extras header's documented no-column divergence). The reason
 *   select renders upstream's default set ("Too heated", "Off-topic",
 *   "Spam", "Resolved" — modules/setting/repository.go:222).
 * - IssuePinOrUnpin (issue_pin.go:17-53): the TOGGLE — unpinned pins (the
 *   cap arm answers upstream's "You can't pin more issues" re-render;
 *   MaxPinned default 3 per type), pinned unpins; both redirect canonical.
 *   The write is the upstream port (the pin row at max+1 + the pin(36)
 *   comment / the delete + the unpin(37) comment, num_comments folded) —
 *   the statements live in api/services/issue-extras.ts (the shared seam
 *   beside lockIssue; c1391ce's duplication note resolved) and both this
 *   module and api/routes/issue-write-t2.ts call them.
 * - IssueUnpin (issue_pin.go:56-77): repo-scoped index lookup (a miss is
 *   the 404 shell — upstream ServerError), the unpinned no-op is the
 *   silent success, answer 204.
 * - IssuePinMove (issue_pin.go:80-116): the JSON body {id, position}
 *   verbatim — anonymous 403 JSON ("Only signed in users are allowed to
 *   perform this action."), the admin gate after it (upstream's order: the
 *   doer check precedes reqRepoAdmin), a missing issue or pin the upstream
 *   500s, a repo mismatch upstream's 404, position < 1 upstream's "The
 *   Position can't be lower than 1" 500, same-position the silent no-op,
 *   success 204. No detail-page UI drives it (upstream's pinned-list drag
 *   is a list-surface JS island); the handler lands ready for that surface.
 *
 * ## The resolution prologue
 *
 * `resolveUiSession`/`resolveUiRequest` are index.ts-internal; this module
 * re-assembles their halves from the same leaf modules exactly like
 * issue-write-tails.ts does (viewer.ts's resolveViewer, repo-view.ts's
 * resolveRepositoryForViewer, the settings/watch/star ctx flags the
 * re-rendered page carries). The failure re-renders ride
 * pages/issue-detail.tsx's loader + access resolver + render entry (the
 * landed issueLabelsSubmit shape).
 */

import { Context, Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import type { ApiEnv } from "../../api/env";
import {
  deleteIssuePin,
  insertIssuePin,
  lockIssue,
  moveIssuePin,
  pinOfIssue,
  pinStats,
  setIssueSubscription,
  unlockIssue,
} from "../../api/services/issue-extras";
import {
  addIssueAssignees,
  canBeAssigned,
  changeIssueDeadline,
  changeIssueMilestone,
  listIssueAssignees,
  removeIssueAssignees,
} from "../../api/services/issues";
import { emitAssignEvent } from "../../api/routes/issues";
import {
  addIssueToColumn,
  findColumnByIdAndProject,
  mustDefaultColumn,
  removeIssueFromColumn,
  type ProjectRow,
} from "../../api/services/projects";
import { findRepositoryById, type RepositoryWithOwner, type UserRow } from "../../api/services/repository";
import { loadRepoSettings } from "../../api/services/repo-settings";
import { getWatch } from "../../api/services/repo-watchers";
import { isStarring } from "../../api/services/stars";
import { projectIssues, projects, users } from "../../db/schema";
import type { IssueRow } from "../../issues/service";
import { IssuesService } from "../../issues/service";
import { demoModeEnabled } from "../../services/demo-sweep";
import { packagesQuotaFromEnv } from "../../services/packages/model";
import { readUrlEncodedForm } from "../forms";
import { AssetBuildError, loadManifest } from "../manifest";
import { renderNotFound } from "../render";
import { sameOriginGuard } from "../session";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";
import { resolveRepositoryForViewer } from "../repo-view";
import { resolveViewer, type Viewer } from "../viewer";
import { canWriteRepo } from "./file-editor";
import {
  ISSUE_DETAIL_MAX_PINNED,
  loadIssueDetailData,
  renderIssueDetailPage,
  resolveIssueDetailAccess,
} from "./issue-detail";
import { countUnreadNotifications } from "./notifications";
import { canAdminRepo } from "./settings";

type RouteContext = Context<{ Bindings: Env }>;
type ApiContext = Context<ApiEnv>;

/** Page chrome text (component-local; the strings are the upstream locale
 *  strings verbatim — the keys cite locale_en-US.json). */
export const issueSidebarLocale = {
  lock_duplicate: "An issue cannot be locked twice.", // "repo.issues.lock_duplicate"
  unlock_error: "Cannot unlock an issue that is not locked.", // "repo.issues.unlock_error"
  max_pinned: "You can't pin more issues", // "repo.issues.max_pinned"
  unassignable: (userId: number): string => `User ${userId} cannot be assigned to this issue`, // issue.go:465's HTTPError text
} as const;

// ---------------------------------------------------------------------------
// Form parsers (the upstream field names; multi-value + comma-joined `id`
// accepted — the combo-wire note in the module header)
// ---------------------------------------------------------------------------

/** The decimal positive-int set from ONE urlencoded key: every value of the
 *  key is comma-split then parsed (upstream FormStringInt64s reads the first
 *  value comma-joined; the no-JS checkbox group posts separate values —
 *  both shapes land in the same set), dupes collapsed, non-positive dropped
 *  (the parseIssueLabelForm convention). */
export function positiveIntIdSet(params: URLSearchParams, key: string): number[] {
  const ids = new Set<number>();
  for (const raw of params.getAll(key)) {
    for (const piece of raw.split(",")) {
      const trimmed = piece.trim();
      if (!/^\d+$/.test(trimmed)) continue;
      const id = Number.parseInt(trimmed, 10);
      if (id > 0) ids.add(id);
    }
  }
  return [...ids];
}

/** The single global issue id (`issue_ids` first value — the landed
 *  parseIssueLabelForm shape; non-numeric = the never-matching null). */
export function parseIssueIdsSelector(params: URLSearchParams): number | null {
  const raw = (params.get("issue_ids") ?? "").trim();
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
}

export interface IssueMilestoneForm {
  issueId: number | null;
  /** Positive = set; null = clear (upstream FormInt64's "" / garbage → 0). */
  milestoneId: number | null;
}

export function parseIssueMilestoneForm(params: URLSearchParams): IssueMilestoneForm {
  const raw = (params.get("id") ?? "").trim();
  return {
    issueId: parseIssueIdsSelector(params),
    milestoneId: /^\d+$/.test(raw) && Number.parseInt(raw, 10) > 0 ? Number.parseInt(raw, 10) : null,
  };
}

export interface IssueProjectForm {
  issueId: number | null;
  projectIds: number[];
}

export function parseIssueProjectForm(params: URLSearchParams): IssueProjectForm {
  return { issueId: parseIssueIdsSelector(params), projectIds: positiveIntIdSet(params, "id") };
}

export interface IssueAssigneeForm {
  issueId: number | null;
  assigneeIds: number[];
  /** Upstream's `action` — only "clear" is special (issue.go:446); the
   *  attach/detach values the JS posts are toggle noise the server diff
   *  replaces. */
  action: string;
}

export function parseIssueAssigneeForm(params: URLSearchParams): IssueAssigneeForm {
  return { issueId: parseIssueIdsSelector(params), assigneeIds: positiveIntIdSet(params, "id"), action: params.get("action") ?? "" };
}

export interface IssueDeadlineForm {
  /** yyyy-mm-dd END-OF-DAY UTC; null = clear (empty AND unparseable —
   *  upstream ignores the parse error, the zero timestamp clears). */
  deadline: Date | null;
}

export function parseIssueDeadlineForm(params: URLSearchParams): IssueDeadlineForm {
  const raw = (params.get("deadline") ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match === null) return { deadline: null };
  const year = Number.parseInt(match[1]!, 10);
  const month = Number.parseInt(match[2]!, 10);
  const day = Number.parseInt(match[3]!, 10);
  // Rollover-guarded construction (upstream time.Parse rejects month 13 /
  // day 32 — the same rejection lands in the clear arm).
  const deadline = new Date(0);
  deadline.setUTCFullYear(year, month - 1, day);
  deadline.setUTCHours(23, 59, 59, 0);
  if (deadline.getUTCFullYear() !== year || deadline.getUTCMonth() !== month - 1 || deadline.getUTCDate() !== day) {
    return { deadline: null };
  }
  return { deadline };
}

export interface IssueLockForm {
  reason: string;
}

export function parseIssueLockForm(params: URLSearchParams): IssueLockForm {
  return { reason: params.get("reason") ?? "" };
}

/** `watch` — upstream FormBool reads "1"/"true"/"on" (base_form.go:62-67). */
export function parseIssueWatchForm(params: URLSearchParams): boolean {
  const raw = params.get("watch") ?? "";
  return raw === "1" || raw === "true" || raw.toLowerCase() === "on";
}

export interface MovePinBody {
  id: number | null;
  position: number | null;
}

/** The move_pin JSON body (issue_pin.go:86-95's decoded struct; absent or
 *  non-integer fields are the never-matching nulls). */
export function parseMovePinBody(body: unknown): MovePinBody {
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const id = record.id;
  const position = record.position;
  return {
    id: typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null,
    position: typeof position === "number" && Number.isInteger(position) ? position : null,
  };
}

// ---------------------------------------------------------------------------
// The pin write seam rides services/issue-extras.ts — insertIssuePin /
// deleteIssuePin / moveIssuePin (+ the pinOfIssue/pinStats reads) moved there
// verbatim (the c1391ce seam extraction), so this module imports the SAME
// statements the API routes call; the module header's duplication note is
// history.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The write seams (one per upstream handler; D1-only, the landed services)
// ---------------------------------------------------------------------------

export type MilestoneWriteResult = { outcome: "applied" } | { outcome: "missing-milestone" };

/** UpdateIssueMilestone (issue.go:403-433): the same-id no-op arm, the
 *  repo-scoped milestone resolve (missing/foreign → "missing-milestone",
 *  the module header's 404-shell note), then the landed
 *  changeIssueMilestone (the milestone(8) comment + the counter moves). */
export async function applyIssueMilestoneWrite(
  d1: D1Database,
  repo: RepoRow,
  issue: IssueRow,
  milestoneId: number | null,
  actorId: number,
  now: Date,
): Promise<MilestoneWriteResult> {
  const oldMilestoneId = issue.milestoneId;
  if ((oldMilestoneId ?? null) === milestoneId) {
    return { outcome: "applied" };
  }
  if (milestoneId !== null) {
    const milestone = await new IssuesService(d1).getMilestone(milestoneId);
    if (milestone === null || milestone.repoId !== repo.id) {
      return { outcome: "missing-milestone" };
    }
  }
  await changeIssueMilestone(d1, issue, milestoneId, oldMilestoneId, actorId, now);
  return { outcome: "applied" };
}

export type AssigneeWriteResult =
  | { outcome: "applied" }
  | { outcome: "unassignable"; message: string };

/** UpdateIssueAssignee (issue.go:436-477) over the landed assignee seams:
 *  action=clear removes every current assignee; otherwise the posted ids
 *  resolve (a missing user row is upstream's GetUserByID ServerError —
 *  skipped here, a stale checkbox must not 500 the form) and the org/
 *  canBeAssigned refusal carries upstream's exact 403 text; the diff rides
 *  addIssueAssignees/removeIssueAssignees (their internal validate/skip
 *  arms + the type-9 comments), and every ACTUALLY-changed assignee emits
 *  the webhook family best-effort through the landed emitAssignEvent. */
export async function applyIssueAssigneeWrite(
  d1: D1Database,
  pair: RepositoryWithOwner,
  issue: IssueRow,
  form: IssueAssigneeForm,
  doer: { id: number; isAdmin: boolean },
  apiContext: ApiContext,
): Promise<AssigneeWriteResult> {
  const current = await listIssueAssignees(d1, issue.id);
  if (form.action === "clear") {
    if (current.length === 0) return { outcome: "applied" };
    const removed = await removeIssueAssignees(d1, issue, current, doer.id);
    await emitAssigneeEvents(apiContext, pair, issue, removed, true);
    return { outcome: "applied" };
  }

  const currentIds = new Set(current.map((user) => user.id));
  const postedIds = new Set(form.assigneeIds);
  const toAddIds = [...postedIds].filter((id) => !currentIds.has(id));
  const toRemoveIds = [...currentIds].filter((id) => !postedIds.has(id));

  const candidates =
    toAddIds.length === 0 ? [] : await drizzle(d1).select().from(users).where(inArray(users.id, toAddIds)).all();
  for (const id of toAddIds) {
    const user = candidates.find((row) => row.id === id);
    if (user === undefined) continue; // stale id — the upstream GetUserByID ServerError arm, degraded to a skip
    if (user.type === "org" || !(await canBeAssigned(d1, pair, { id: user.id, isAdmin: doer.isAdmin }))) {
      return { outcome: "unassignable", message: issueSidebarLocale.unassignable(id) };
    }
  }

  const assigneeRows = candidates.filter((row) => toAddIds.includes(row.id));
  const added = assigneeRows.length === 0 ? [] : await addIssueAssignees(d1, pair, issue, assigneeRows, doer);
  const removeRows = current.filter((user) => toRemoveIds.includes(user.id));
  const removed = removeRows.length === 0 ? [] : await removeIssueAssignees(d1, issue, removeRows, doer.id);
  await emitAssigneeEvents(apiContext, pair, issue, removed, true);
  await emitAssigneeEvents(apiContext, pair, issue, added, false);
  return { outcome: "applied" };
}

/** The IssueChangeAssignee webhook fan-out (services/webhook/notifier.go:
 *  161-202 through the landed emitter) — best-effort, never fails the
 *  write (the compare.tsx emission posture). */
async function emitAssigneeEvents(
  apiContext: ApiContext,
  pair: RepositoryWithOwner,
  issue: IssueRow,
  changed: UserRow[],
  removed: boolean,
): Promise<void> {
  for (const user of changed) {
    try {
      await emitAssignEvent(apiContext, pair, issue, user, removed);
    } catch {
      // Best-effort (the emitter's own failure posture covers delivery).
    }
  }
}

export type ProjectWriteResult = { outcome: "applied" } | { outcome: "missing-project" };

/** UpdateIssueProject (projects.go:448-481 over IssueAssignOrRemoveProject):
 *  the posted set diffs the current memberships; adds resolve the project
 *  unscoped (missing → "missing-project", the module header's 500 note),
 *  an inaccessible project is upstream's skip arm (silent), attaches ride
 *  the landed addIssueToColumn into the default column, removals the
 *  landed removeIssueFromColumn with the membership's own column. */
export async function applyIssueProjectWrite(
  d1: D1Database,
  repo: RepoRow,
  issue: IssueRow,
  projectIds: number[],
  doerId: number,
  now: Date,
): Promise<ProjectWriteResult> {
  const membershipRows = await drizzle(d1)
    .select({ projectId: projectIssues.projectId, columnId: projectIssues.projectColumnId })
    .from(projectIssues)
    .where(eq(projectIssues.issueId, issue.id))
    .all();
  const currentIds = new Set(membershipRows.map((row) => row.projectId));
  const postedIds = new Set(projectIds);

  const toAdd = [...postedIds].filter((id) => !currentIds.has(id));
  const toRemove = [...currentIds].filter((id) => !postedIds.has(id));

  for (const projectId of toAdd) {
    // The unscoped id lookup (upstream GetProjectsMapByIDs — any scope).
    const projectRows = await drizzle(d1).select().from(projects).where(eq(projects.id, projectId)).limit(1);
    const project = projectRows[0];
    if (project === undefined) return { outcome: "missing-project" };
    if (!projectCanBeAccessedByOwnerRepo(repo, project)) continue; // upstream's permission-denied SKIP arm
    const defaultColumn = await mustDefaultColumn(d1, project, now);
    await addIssueToColumn(d1, project, issue, defaultColumn, doerId, now);
  }

  for (const projectId of toRemove) {
    const membership = membershipRows.find((row) => row.projectId === projectId);
    const projectRows = await drizzle(d1).select().from(projects).where(eq(projects.id, projectId)).limit(1);
    const project = projectRows[0];
    if (project === undefined || membership === undefined) continue; // raced/garbage row — nothing to remove
    const column =
      (await findColumnByIdAndProject(d1, membership.columnId, project.id)) ?? (await mustDefaultColumn(d1, project, now));
    await removeIssueFromColumn(d1, project, issue, column, doerId, now);
  }
  return { outcome: "applied" };
}

/** CanBeAccessedByOwnerRepo (models/project/project.go:209-216) over the
 *  landed columns: repo-scoped rows match on repoId, owner-scoped on the
 *  owning user/org id. */
function projectCanBeAccessedByOwnerRepo(repo: RepoRow, project: ProjectRow): boolean {
  if (project.repoId !== "") return project.repoId === repo.id;
  return repo.ownerId !== null && project.ownerId === repo.ownerId;
}

export type DeadlineWriteResult = { outcome: "applied" };

/** UpdateIssueDeadline (issue.go:377-400 + issue_update.go:531-535): the
 *  unchanged deadline is the no-op arm; the change rides the landed
 *  changeIssueDeadline (the added/modified/removed comments). */
export async function applyIssueDeadlineWrite(
  d1: D1Database,
  issue: IssueRow,
  deadline: Date | null,
  actorId: number,
  now: Date,
): Promise<DeadlineWriteResult> {
  const previous = issue.deadlineAt ?? null;
  if (deadline?.getTime() === previous?.getTime()) {
    return { outcome: "applied" };
  }
  await changeIssueDeadline(d1, issue, deadline, previous, actorId, now);
  return { outcome: "applied" };
}

export type WatchWriteResult = { outcome: "applied" };

/** IssueWatch (issue_watch.go:19-34): the CreateOrUpdateIssueWatch upsert
 *  through the landed setIssueSubscription. */
export async function applyIssueWatchWrite(
  d1: D1Database,
  userId: number,
  issue: IssueRow,
  watching: boolean,
  now: Date,
): Promise<WatchWriteResult> {
  await setIssueSubscription(d1, { userId, issueId: issue.id, watching }, now);
  return { outcome: "applied" };
}

export type LockWriteResult = { outcome: "applied" } | { outcome: "duplicate" };
export type UnlockWriteResult = { outcome: "applied" } | { outcome: "not-locked" };

/** LockIssue (issue_lock.go:15-37): the duplicate arm carries upstream's
 *  exact message; the flip rides the landed lockIssue (the Lock system
 *  comment; the reason is accepted but not stored — the issue-extras
 *  divergence). */
export async function applyIssueLockWrite(d1: D1Database, issue: IssueRow, actorId: number, now: Date): Promise<LockWriteResult> {
  if (issue.isLocked) return { outcome: "duplicate" };
  await lockIssue(d1, issue.id, actorId, now);
  return { outcome: "applied" };
}

/** UnlockIssue (issue_lock.go:40-60): the mirror arm + the landed
 *  unlockIssue. */
export async function applyIssueUnlockWrite(d1: D1Database, issue: IssueRow, actorId: number, now: Date): Promise<UnlockWriteResult> {
  if (!issue.isLocked) return { outcome: "not-locked" };
  await unlockIssue(d1, issue.id, actorId, now);
  return { outcome: "applied" };
}

export type PinToggleResult = { outcome: "applied" } | { outcome: "max-pinned" };

/** IssuePinOrUnpin (issue_pin.go:17-53): the toggle. Unpinned pins through
 *  the cap-checked insert (the cap arm carries upstream's message); pinned
 *  unpins (the unpin(37) comment rides). */
export async function applyIssuePinToggleWrite(d1: D1Database, issue: IssueRow, actorId: number, now: Date): Promise<PinToggleResult> {
  const existing = await pinOfIssue(d1, issue.id);
  if (existing === null) {
    const { count } = await pinStats(d1, issue.repoId, issue.isPull);
    if (count >= ISSUE_DETAIL_MAX_PINNED) {
      return { outcome: "max-pinned" };
    }
    await insertIssuePin(d1, issue, actorId, now);
    return { outcome: "applied" };
  }
  await deleteIssuePin(d1, issue, actorId, now);
  return { outcome: "applied" };
}

export type UnpinResult = { outcome: "applied" };

/** IssueUnpin (issue_pin.go:56-77): the repo-scoped lookup is the caller's;
 *  an unpinned issue is the silent success (the delete's 0-row guard). */
export async function applyIssueUnpinWrite(d1: D1Database, issue: IssueRow, actorId: number, now: Date): Promise<UnpinResult> {
  await deleteIssuePin(d1, issue, actorId, now);
  return { outcome: "applied" };
}

export type MovePinWriteResult = { outcome: "applied" } | { outcome: "no-pin" } | { outcome: "bad-position" };

/** MovePin (issue_pin.go:134-163): position < 1 the upstream refusal, the
 *  same position the silent no-op, an unpinned issue "no-pin" (upstream's
 *  GetIssuePin ErrNotExist 500 — the caller answers it), otherwise the
 *  neighbour shift. */
export async function applyIssueMovePinWrite(d1: D1Database, issue: IssueRow, position: number): Promise<MovePinWriteResult> {
  if (position < 1) return { outcome: "bad-position" };
  const pin = await pinOfIssue(d1, issue.id);
  if (pin === null) return { outcome: "no-pin" };
  await moveIssuePin(d1, issue, pin.pinOrder, position);
  return { outcome: "applied" };
}

// ---------------------------------------------------------------------------
// The resolution prologue (issue-write-tails.ts's leaf-only twin — the
// module header's duplication note)
// ---------------------------------------------------------------------------

/** ui/index.ts's UiAssetsFetcher declared locally (the issue-write-tails
 *  posture — the test harness injects the synthetic manifest through it). */
export interface SidebarAssetsFetcher {
  fetch(input: RequestInfo): Promise<Response>;
}

function assetsBinding(env: Pick<Env, "ASSETS">): SidebarAssetsFetcher | undefined {
  if ("ASSETS" in env) {
    const binding: unknown = env.ASSETS;
    if (typeof binding === "object" && binding !== null && "fetch" in binding) {
      return binding as SidebarAssetsFetcher;
    }
  }
  return undefined;
}

function assetsNotBuilt(error: AssetBuildError): Response {
  return new Response(`${error.message}\n`, {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

/** index.ts's loginRedirect verbatim (the SPEC-0010 §2.5 round-trip). */
function loginRedirect(requestUri: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `/login?redirect_to=${encodeURIComponent(requestUri)}` },
  });
}

interface ResolvedSession {
  ok: true;
  url: URL;
  ctx: UiContext;
  viewer: Viewer;
  respond: (res: Response) => Response;
}

/** The session half of resolveUiSession (the issue-write-tails twin):
 *  viewer + manifest + bell count + the set-cookie-attaching respond. */
async function resolveSidebarSession(c: RouteContext): Promise<ResolvedSession | { ok: false; response: Response }> {
  const url = new URL(c.req.url);
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined;
  }
  let ctx: UiContext;
  let setCookie: string | null = null;
  let viewer: Viewer;
  try {
    const [manifest, resolution] = await Promise.all([
      loadManifest(assetsBinding(c.env), url.origin),
      resolveViewer(c.env, c.req.raw, { waitUntil }),
    ]);
    setCookie = resolution.setCookie;
    viewer = resolution.viewer;
    let notificationCount: number | null = null;
    if (viewer.kind === "user") {
      try {
        notificationCount = await countUnreadNotifications(c.env.DB, viewer.id);
      } catch {
        notificationCount = null;
      }
    }
    ctx = {
      viewer: resolution.viewer,
      origin: url.origin,
      notificationCount,
      demoMode: demoModeEnabled(c.env),
      packagesEnabled: packagesQuotaFromEnv(c.env).packagesEnabled,
      assets: shellAssetsFromManifest(manifest),
    };
  } catch (error) {
    if (error instanceof AssetBuildError) return { ok: false, response: assetsNotBuilt(error) };
    throw error;
  }
  const respond = (res: Response): Response => {
    if (setCookie === null) return res;
    const headers = new Headers(res.headers);
    headers.append("set-cookie", setCookie);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
  return { ok: true, url, ctx, viewer, respond };
}

interface ResolvedRepo {
  ok: true;
  url: URL;
  ctx: UiContext;
  viewer: Viewer;
  respond: (res: Response) => Response;
  repo: RepoRow;
}

/** The repo prologue (the issue-write-tails twin): session → §2.5 repo read
 *  → the ctx flags the re-rendered page's shell carries. The WRITE GATE is
 *  NOT here — the handlers apply it after the resolution (upstream's
 *  RepoAssignment → middleware order). */
async function resolveSidebarRepo(c: RouteContext): Promise<ResolvedRepo | { ok: false; response: Response }> {
  const session = await resolveSidebarSession(c);
  if (!session.ok) return session;
  const { url, ctx, viewer, respond } = session;
  const owner = c.req.param("owner");
  const repoName = c.req.param("repo");
  if (owner === undefined || repoName === undefined) return { ok: false, response: respond(await c.notFound()) };
  const repo = await resolveRepositoryForViewer(c.env, viewer, owner, repoName);
  if (repo === null) return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  ctx.repo = repo;
  const settings = await loadRepoSettings(c.env.DB, repo.id);
  ctx.repoHasProjects = settings.hasProjects;
  ctx.repoHasPackages = settings.hasPackages;
  ctx.repoHasActions = settings.hasActions;
  ctx.repoHasWiki = settings.hasWiki;
  if (viewer.kind === "user") {
    const [repoWatch, starring] = await Promise.all([
      getWatch(c.env.DB, repo.id, viewer.id),
      isStarring(c.env.DB, viewer.id, repo.id),
    ]);
    ctx.viewerRepoWatch = repoWatch;
    ctx.viewerStarsRepo = starring;
  }
  return { ok: true, url, ctx, viewer, respond, repo };
}

/** The signed-in viewer the gates hand back (the narrowing the handlers
 *  write against — every gate passed means a user viewer). */
type UserViewer = Extract<Viewer, { kind: "user" }>;

interface GatePassed {
  ok: true;
  url: URL;
  ctx: UiContext;
  viewer: UserViewer;
  respond: (res: Response) => Response;
  repo: RepoRow;
}

/** The labels-write gate verbatim (index.ts's repoLabelsWriteGate —
 *  anonymous → the login 303, archived or non-writer → the 404 shell). */
async function sidebarWriterGate(c: RouteContext, resolved: Extract<ResolvedRepo, { ok: true }>): Promise<GatePassed | { response: Response }> {
  const { url, ctx, viewer, respond, repo } = resolved;
  if (viewer.kind === "anonymous") return { response: respond(loginRedirect(url.pathname + url.search)) };
  if (repo.isArchived || !(await canWriteRepo(c.env, repo, viewer))) {
    return { response: respond(c.html(renderNotFound(ctx), 404)) };
  }
  return { ok: true, url, ctx, viewer, respond, repo };
}

/** The admin gate (the wave-5 label-write ladder — issueLabelsSubmit:
 *  anonymous → the login 303, then the archived/non-admin 404 shell over
 *  `canAdminRepo`, the settings predicate standing in for upstream
 *  RequireRepoAdmin). */
async function sidebarAdminGate(c: RouteContext, resolved: Extract<ResolvedRepo, { ok: true }>): Promise<GatePassed | { response: Response }> {
  const { url, ctx, viewer, respond, repo } = resolved;
  if (viewer.kind === "anonymous") return { response: respond(loginRedirect(url.pathname + url.search)) };
  if (repo.isArchived || !(await canAdminRepo(c.env, repo, viewer))) {
    return { response: respond(c.html(renderNotFound(ctx), 404)) };
  }
  return { ok: true, url, ctx, viewer, respond, repo };
}

/** The row's canonical page (upstream Issue.Link() — the redirect target of
 *  every JSONRedirect arm; a POST through the twin family lands canonically,
 *  the issueCommentSubmit rule). */
function canonicalIssuePath(repo: RepoRow, issue: IssueRow): string {
  return `/${repo.ownerNamespace}/${repo.slug}/${issue.isPull ? "pulls" : "issues"}/${issue.index}`;
}

/** The {index} path param — strict decimal or the 404 shell (upstream
 *  PathParamInt64's zero lands in GetIssueByIndex's miss). */
async function issueFromIndexParam(
  c: RouteContext,
  resolved: Extract<ResolvedRepo, { ok: true }>,
): Promise<{ issue: IssueRow } | { response: Response }> {
  const { ctx, respond, repo } = resolved;
  const raw = c.req.param("index") ?? "";
  if (!/^\d+$/.test(raw)) return { response: respond(c.html(renderNotFound(ctx), 404)) };
  const issue = await new IssuesService(c.env.DB).getIssueByIndex(repo.id, Number.parseInt(raw, 10));
  if (issue === null) return { response: respond(c.html(renderNotFound(ctx), 404)) };
  return { issue };
}

/** The `issue_ids` form selector → the GLOBAL issue row scoped to THIS repo
 *  (upstream getActionIssues' repo check; a foreign/missing id 404-shells). */
async function issueFromFormSelector(
  c: RouteContext,
  resolved: Extract<ResolvedRepo, { ok: true }>,
  issueId: number | null,
): Promise<{ issue: IssueRow } | { response: Response }> {
  const { ctx, respond, repo } = resolved;
  const issue = issueId === null ? null : await new IssuesService(c.env.DB).getIssueById(issueId);
  if (issue === null || issue.repoId !== repo.id) return { response: respond(c.html(renderNotFound(ctx), 404)) };
  return { issue };
}

/** The failure re-render (the landed issueLabelsSubmit shape): the fresh
 *  read + access + the message in the comment form's error slot, 200. */
async function reRenderDetailWithMessage(
  c: RouteContext,
  resolved: Extract<ResolvedRepo, { ok: true }>,
  issue: IssueRow,
  message: string,
): Promise<Response> {
  const { ctx, viewer, respond, repo, url } = resolved;
  const data = await loadIssueDetailData(c.env.DB, repo, issue.isPull ? "pulls" : "issues", issue.index, url.origin, viewer);
  if (data === null) return respond(c.html(renderNotFound(ctx), 404));
  const access = await resolveIssueDetailAccess(c.env, repo, viewer, issue);
  return respond(c.html(renderIssueDetailPage(ctx, data, access, { content: "", error: message }), 200));
}

/** The fabricated API context the webhook emitter reads (the repo-grants
 *  bridge pattern — authUser carries the doer projection, the real request
 *  URL keeps the emitter's origin). */
function apiContextFor(c: RouteContext, viewer: Viewer): ApiContext {
  const apiContext = new Context<ApiEnv>(c.req.raw, { env: c.env });
  if (viewer.kind === "user") {
    apiContext.set("authUser", { id: viewer.id, login: viewer.username, is_admin: viewer.isAdmin });
  }
  return apiContext;
}

// ---------------------------------------------------------------------------
// The ten POST/DELETE handlers
// ---------------------------------------------------------------------------

/**
 * POST /{owner}/{repo}/{issues|pulls}/milestone (upstream
 * repo.UpdateIssueMilestone, issue.go:403-433): the §2.8 Origin guard, the
 * writer gate, then the `issue_ids` selector + `id` through the landed
 * changeIssueMilestone — same-id the silent no-op, a foreign/missing
 * milestone id the 404 shell (upstream's ServerError arm — the module
 * header), success the canonical 303.
 */
export async function issueMilestoneSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveSidebarRepo(c);
  if (!resolved.ok) return resolved.response;
  const gate = await sidebarWriterGate(c, resolved);
  if ("response" in gate) return gate.response;
  const { respond, repo, viewer } = gate;

  const form = parseIssueMilestoneForm(await readUrlEncodedForm(c.req.raw));
  const selected = await issueFromFormSelector(c, resolved, form.issueId);
  if ("response" in selected) return selected.response;
  const issue = selected.issue;

  const result = await applyIssueMilestoneWrite(c.env.DB, repo, issue, form.milestoneId, viewer.id, new Date());
  if (result.outcome === "missing-milestone") return respond(c.html(renderNotFound(resolved.ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: canonicalIssuePath(repo, issue) } }));
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/projects (upstream
 * repo.UpdateIssueProject, projects.go:448-481): the writer gate, then the
 * diff write — a missing project id is the plain-text 500 (upstream's
 * ServerError arm), everything else the canonical 303.
 */
export async function issueProjectsSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveSidebarRepo(c);
  if (!resolved.ok) return resolved.response;
  const gate = await sidebarWriterGate(c, resolved);
  if ("response" in gate) return gate.response;
  const { respond, repo, viewer } = gate;

  const form = parseIssueProjectForm(await readUrlEncodedForm(c.req.raw));
  const selected = await issueFromFormSelector(c, resolved, form.issueId);
  if ("response" in selected) return selected.response;
  const issue = selected.issue;

  const result = await applyIssueProjectWrite(c.env.DB, repo, issue, form.projectIds, viewer.id, new Date());
  if (result.outcome === "missing-project") {
    return respond(new Response("project not found\n", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } }));
  }
  return respond(new Response(null, { status: 303, headers: { location: canonicalIssuePath(repo, issue) } }));
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/assignee (upstream
 * repo.UpdateIssueAssignee, issue.go:436-477): the writer gate, then the
 * diff/clear write — the unassignable refusal re-renders with upstream's
 * 403 text (the landed re-render convention), success the canonical 303.
 */
export async function issueAssigneeSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveSidebarRepo(c);
  if (!resolved.ok) return resolved.response;
  const gate = await sidebarWriterGate(c, resolved);
  if ("response" in gate) return gate.response;
  const { respond, repo, viewer } = gate;

  const form = parseIssueAssigneeForm(await readUrlEncodedForm(c.req.raw));
  const selected = await issueFromFormSelector(c, resolved, form.issueId);
  if ("response" in selected) return selected.response;
  const issue = selected.issue;

  const pair = await findRepositoryById(c.env.DB, repo.id);
  if (pair === null) return respond(c.html(renderNotFound(resolved.ctx), 404));
  const result = await applyIssueAssigneeWrite(
    c.env.DB,
    pair,
    issue,
    form,
    { id: viewer.id, isAdmin: viewer.isAdmin },
    apiContextFor(c, viewer),
  );
  if (result.outcome === "unassignable") return reRenderDetailWithMessage(c, resolved, issue, result.message);
  return respond(new Response(null, { status: 303, headers: { location: canonicalIssuePath(repo, issue) } }));
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/{index}/deadline (upstream
 * repo.UpdateIssueDeadline, issue.go:377-400): the writer gate (upstream's
 * in-handler 403 — the module header's uniform-gate note), then the
 * end-of-day parse through the landed changeIssueDeadline, success the
 * canonical 303 (upstream's JSONRedirect("") reload).
 */
export async function issueDeadlineSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveSidebarRepo(c);
  if (!resolved.ok) return resolved.response;
  const gate = await sidebarWriterGate(c, resolved);
  if ("response" in gate) return gate.response;
  const { respond, repo, viewer } = gate;

  const selected = await issueFromIndexParam(c, resolved);
  if ("response" in selected) return selected.response;
  const issue = selected.issue;

  const form = parseIssueDeadlineForm(await readUrlEncodedForm(c.req.raw));
  await applyIssueDeadlineWrite(c.env.DB, issue, form.deadline, viewer.id, new Date());
  return respond(new Response(null, { status: 303, headers: { location: canonicalIssuePath(repo, issue) } }));
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/{index}/watch (upstream
 * repo.IssueWatch, issue_watch.go:19-34): the session gate (any signed-in
 * viewer; upstream's bare-group posture — anonymous would nil-deref there,
 * the module header), the query-string `watch` bool through the landed
 * setIssueSubscription, the canonical 303 (upstream's tplWatching fragment
 * is the JS island this replaces).
 */
export async function issueWatchSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveSidebarRepo(c);
  if (!resolved.ok) return resolved.response;
  const { url, ctx, respond, repo, viewer } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  if (repo.isArchived) return respond(c.html(renderNotFound(ctx), 404)); // the group's RepoMustNotBeArchived arm

  const selected = await issueFromIndexParam(c, resolved);
  if ("response" in selected) return selected.response;
  const issue = selected.issue;

  const watching = parseIssueWatchForm(url.searchParams);
  await applyIssueWatchWrite(c.env.DB, viewer.id, issue, watching, new Date());
  return respond(new Response(null, { status: 303, headers: { location: canonicalIssuePath(repo, issue) } }));
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/{index}/lock (upstream
 * repo.LockIssue, issue_lock.go:15-37): the writer gate, the duplicate arm
 * re-renders with upstream's message, the flip rides the landed lockIssue,
 * success the canonical 303.
 */
export async function issueLockSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveSidebarRepo(c);
  if (!resolved.ok) return resolved.response;
  const gate = await sidebarWriterGate(c, resolved);
  if ("response" in gate) return gate.response;
  const { respond, repo, viewer } = gate;

  const selected = await issueFromIndexParam(c, resolved);
  if ("response" in selected) return selected.response;
  const issue = selected.issue;

  parseIssueLockForm(await readUrlEncodedForm(c.req.raw)); // the reason is accepted, not stored (the issue-extras divergence)
  const result = await applyIssueLockWrite(c.env.DB, issue, viewer.id, new Date());
  if (result.outcome === "duplicate") return reRenderDetailWithMessage(c, resolved, issue, issueSidebarLocale.lock_duplicate);
  return respond(new Response(null, { status: 303, headers: { location: canonicalIssuePath(repo, issue) } }));
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/{index}/unlock (upstream
 * repo.UnlockIssue, issue_lock.go:40-60): the mirror of the lock arm with
 * its own not-locked message.
 */
export async function issueUnlockSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveSidebarRepo(c);
  if (!resolved.ok) return resolved.response;
  const gate = await sidebarWriterGate(c, resolved);
  if ("response" in gate) return gate.response;
  const { respond, repo, viewer } = gate;

  const selected = await issueFromIndexParam(c, resolved);
  if ("response" in selected) return selected.response;
  const issue = selected.issue;

  const result = await applyIssueUnlockWrite(c.env.DB, issue, viewer.id, new Date());
  if (result.outcome === "not-locked") return reRenderDetailWithMessage(c, resolved, issue, issueSidebarLocale.unlock_error);
  return respond(new Response(null, { status: 303, headers: { location: canonicalIssuePath(repo, issue) } }));
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/{index}/pin (upstream
 * repo.IssuePinOrUnpin, issue_pin.go:17-53): the admin gate, the TOGGLE
 * (pin with the cap arm / unpin), the cap refusal re-renders with
 * upstream's message, success the canonical 303.
 */
export async function issuePinSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveSidebarRepo(c);
  if (!resolved.ok) return resolved.response;
  const gate = await sidebarAdminGate(c, resolved);
  if ("response" in gate) return gate.response;
  const { respond, repo, viewer } = gate;

  const selected = await issueFromIndexParam(c, resolved);
  if ("response" in selected) return selected.response;
  const issue = selected.issue;

  const result = await applyIssuePinToggleWrite(c.env.DB, issue, viewer.id, new Date());
  if (result.outcome === "max-pinned") return reRenderDetailWithMessage(c, resolved, issue, issueSidebarLocale.max_pinned);
  return respond(new Response(null, { status: 303, headers: { location: canonicalIssuePath(repo, issue) } }));
}

/**
 * DELETE /{owner}/{repo}/{issues|pulls}/unpin/{index} (upstream
 * repo.IssueUnpin, issue_pin.go:56-77): the admin gate, the repo-scoped
 * lookup (a miss the 404 shell), the silent no-op kept, answer 204
 * (upstream Status(204)).
 */
export async function issueUnpinSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveSidebarRepo(c);
  if (!resolved.ok) return resolved.response;
  const gate = await sidebarAdminGate(c, resolved);
  if ("response" in gate) return gate.response;
  const { respond, viewer } = gate;

  const selected = await issueFromIndexParam(c, resolved);
  if ("response" in selected) return selected.response;
  const issue = selected.issue;

  await applyIssueUnpinWrite(c.env.DB, issue, viewer.id, new Date());
  return respond(new Response(null, { status: 204 }));
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/move_pin (upstream
 * repo.IssuePinMove, issue_pin.go:80-116): the JSON body {id, position}
 * verbatim — anonymous the 403 JSON, the admin gate after it (upstream's
 * order: the doer check precedes reqRepoAdmin), the repo mismatch the 404
 * shell, position < 1 and the missing pin the upstream 500 texts, success
 * 204. No detail-page UI drives it yet (the module header).
 */
export async function issueMovePinSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveSidebarRepo(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond, repo, viewer } = resolved;
  if (viewer.kind === "anonymous") {
    // Upstream's literal JSON answer (issue_pin.go:81-84).
    return respond(new Response(JSON.stringify("Only signed in users are allowed to perform this action."), {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8" },
    }));
  }
  const adminGate = await sidebarAdminGate(c, resolved);
  if ("response" in adminGate) return adminGate.response;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return respond(new Response("Decode\n", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } }));
  }
  const form = parseMovePinBody(body);

  const issue = form.id === null ? null : await new IssuesService(c.env.DB).getIssueById(form.id);
  if (issue === null) {
    // Upstream GetIssueByID ServerError (issue_pin.go:97-101).
    return respond(new Response("GetIssueByID\n", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } }));
  }
  if (issue.repoId !== repo.id) {
    // Upstream Status(404) + the log line (issue_pin.go:103-107).
    return respond(c.html(renderNotFound(ctx), 404));
  }
  if (form.position === null) {
    // Go's json.Decoder leaves the zero struct — position 0 is the
    // bad-position refusal either way.
    return respond(
      new Response("The Position can't be lower than 1\n", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } }),
    );
  }
  const result = await applyIssueMovePinWrite(c.env.DB, issue, form.position);
  if (result.outcome === "bad-position") {
    return respond(
      new Response("The Position can't be lower than 1\n", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } }),
    );
  }
  if (result.outcome === "no-pin") {
    return respond(new Response("pin for the issue does not exist\n", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } }));
  }
  return respond(new Response(null, { status: 204 }));
}

// ---------------------------------------------------------------------------
// The fold-time router (the recipe step 4 assembled — the direct-test
// harness's subject AND a mount-ready sub-app; the explicit-registration
// form is the recipe's primary, the landed families register inline)
// ---------------------------------------------------------------------------

/** chi's 405 (index.ts's methodNotAllowed twin — the issue-write-tails
 *  shape: empty body + the allow header). */
function methodNotAllowedTail(allow: string): Response {
  return new Response(null, { status: 405, headers: { allow } });
}

/** All ten writes on one sub-app, registered exactly as the recipe's step 4
 *  (the static repo-scope literals, then the {index} writes; the DELETE
 *  unpin carries its GET 405 twin). */
export function createIssueSidebarWritesRouter(): Hono<{ Bindings: Env }> {
  const router = new Hono<{ Bindings: Env }>();
  const families: Array<"issues" | "pulls"> = ["issues", "pulls"];
  for (const family of families) {
    router.post(`/:owner/:repo/${family}/milestone`, (c) => issueMilestoneSubmit(c));
    router.get(`/:owner/:repo/${family}/milestone`, () => methodNotAllowedTail("POST"));
    router.post(`/:owner/:repo/${family}/projects`, (c) => issueProjectsSubmit(c));
    router.get(`/:owner/:repo/${family}/projects`, () => methodNotAllowedTail("POST"));
    router.post(`/:owner/:repo/${family}/assignee`, (c) => issueAssigneeSubmit(c));
    router.get(`/:owner/:repo/${family}/assignee`, () => methodNotAllowedTail("POST"));
    router.post(`/:owner/:repo/${family}/move_pin`, (c) => issueMovePinSubmit(c));
    router.get(`/:owner/:repo/${family}/move_pin`, () => methodNotAllowedTail("POST"));
    router.post(`/:owner/:repo/${family}/:index/deadline`, (c) => issueDeadlineSubmit(c));
    router.get(`/:owner/:repo/${family}/:index/deadline`, () => methodNotAllowedTail("POST"));
    router.post(`/:owner/:repo/${family}/:index/watch`, (c) => issueWatchSubmit(c));
    router.get(`/:owner/:repo/${family}/:index/watch`, () => methodNotAllowedTail("POST"));
    router.post(`/:owner/:repo/${family}/:index/lock`, (c) => issueLockSubmit(c));
    router.get(`/:owner/:repo/${family}/:index/lock`, () => methodNotAllowedTail("POST"));
    router.post(`/:owner/:repo/${family}/:index/unlock`, (c) => issueUnlockSubmit(c));
    router.get(`/:owner/:repo/${family}/:index/unlock`, () => methodNotAllowedTail("POST"));
    router.post(`/:owner/:repo/${family}/:index/pin`, (c) => issuePinSubmit(c));
    router.get(`/:owner/:repo/${family}/:index/pin`, () => methodNotAllowedTail("POST"));
    router.delete(`/:owner/:repo/${family}/unpin/:index`, (c) => issueUnpinSubmit(c));
    router.get(`/:owner/:repo/${family}/unpin/:index`, () => methodNotAllowedTail("DELETE"));
  }
  return router;
}
