/**
 * The issue/PULL DETAIL page's TIMELINE + HEADER WRITES — census gap #1,
 * part TWO (the remainder after pages/issue-sidebar-writes.ts), upstream
 * routers/web/web.go at the pin (the `addIssuesPullsUpdateRoutes` group
 * mounted under BOTH `/{type:issues}` and `/{type:pulls}` plus the
 * repo-scoped `/comments/{id}` trio at web.go:1411-1414):
 *
 *   - POST /{owner}/{repo}/{issues|pulls}/{index}/ref                repo.UpdateIssueRef           (web.go:1369)
 *   - POST /{owner}/{repo}/{issues|pulls}/{index}/dependency/add     repo.AddDependency            (web.go:1373)
 *   - POST /{owner}/{repo}/{issues|pulls}/{index}/dependency/delete  repo.RemoveDependency         (web.go:1374)
 *   - POST /{owner}/{repo}/{issues|pulls}/{index}/times/add          repo.AddTimeManually          (web.go:1378)
 *   - POST /{owner}/{repo}/{issues|pulls}/{index}/times/{timeid}/delete  repo.DeleteTime           (web.go:1379)
 *   - POST /{owner}/{repo}/{issues|pulls}/{index}/times/stopwatch/start   repo.IssueStartStopwatch  (web.go:1381)
 *   - POST /{owner}/{repo}/{issues|pulls}/{index}/times/stopwatch/stop    repo.IssueStopStopwatch   (web.go:1382)
 *   - POST /{owner}/{repo}/{issues|pulls}/{index}/times/stopwatch/cancel  repo.CancelStopwatch      (web.go:1383)
 *   - POST /{owner}/{repo}/{issues|pulls}/{index}/time_estimate      repo.UpdateIssueTimeEstimate  (web.go:1386)
 *   - POST /{owner}/{repo}/{issues|pulls}/{index}/reactions/{action} repo.ChangeIssueReaction      (web.go:1387)
 *   - POST /{owner}/{repo}/{issues|pulls}/{index}/delete             repo.DeleteIssue              (web.go:1390, reqRepoAdmin)
 *   - POST /{owner}/{repo}/{issues|pulls}/projects/column            repo.UpdateIssueProjectColumn (web.go:1400)
 *   - POST /{owner}/{repo}/{issues|pulls}/delete                     repo.BatchDeleteIssues        (web.go:1403, reqRepoAdmin)
 *   - POST /{owner}/{repo}/comments/{id}                             repo.UpdateCommentContent     (web.go:1412)
 *   - POST /{owner}/{repo}/comments/{id}/delete                      repo.DeleteComment            (web.go:1413)
 *   - POST /{owner}/{repo}/comments/{id}/reactions/{action}          repo.ChangeCommentReaction    (web.go:1414)
 *
 * NOT BUILT (adjudicated STOP — no substrate): POST
 * `/{owner}/{repo}/{issues|pulls}/{index}/viewed-files` (web.go:1371,
 * repo.UpdateViewedFiles). Upstream persists per-file viewed state in the
 * `review_state` table (pull_model.ViewedState); this backend has NO such
 * table (the pull-files page already documents its checkbox as a JS island
 * — pages/pull-files.tsx header), and a route that answers 200 without
 * writing would be a false write. The three-step flip recipe, for the
 * session-table owner at that wave: (1) the `review_state` D1 migration
 * (user_id, pull_id, commit_sha, path, state — upstream
 * models/pull/review_state.go:20-33), (2) the JSON handler port
 * (pull_review.go:302-341: `{files: {path: bool}, headCommitSHA}` body;
 * an empty headCommitSHA fills the PR's head commit; a malformed body
 * answers 400), (3) the pull-files checkbox render posting it.
 *
 * This is part one's handoff pattern (pages/issue-sidebar-writes.ts): the
 * index.ts router is the ORCHESTRATOR's fold window, so the POST handlers
 * live HERE — self-contained (origin guard → session → repo resolution →
 * gate → service seam → respond), JSX-free, importing only leaf modules.
 * The mount recipe below is executed at the fold. The RENDER half (the
 * reaction bars, the comment edit/delete forms, the dependency block, the
 * timetracker block, the ref block, the delete button) lives in pages/
 * issue-detail.tsx; the dependency is strictly one-way (this module → that
 * one's exports), never cyclic.
 *
 * ## Mount recipe (the exact hunks)
 *
 * 1. Import the handlers beside the other page-module imports:
 *
 *      import {
 *        issueRefSubmit,
 *        dependencyAddSubmit,
 *        dependencyRemoveSubmit,
 *        timeAddSubmit,
 *        timeDeleteSubmit,
 *        stopwatchStartSubmit,
 *        stopwatchStopSubmit,
 *        stopwatchCancelSubmit,
 *        timeEstimateSubmit,
 *        issueReactionSubmit,
 *        issueDeleteSubmit,
 *        batchDeleteIssuesSubmit,
 *        projectColumnMoveSubmit,
 *        commentUpdateSubmit,
 *        commentDeleteSubmit,
 *        commentReactionSubmit,
 *      } from "./pages/issue-timeline-writes";
 *
 * 2. Route union (beside IssueSidebarWriteRoute). One interface:
 *
 *      /** The census-gap-#1 timeline/header write families (pages/
 *       *  issue-timeline-writes.ts): upstream addIssuesPullsUpdateRoutes'
 *       *  remainder + the /comments/{id} trio (web.go:1369-1414).
 *       *  POST-only; `{action}` is upstream's react|unreact literal. *\/
 *      export interface IssueTimelineWriteRoute {
 *        family:
 *          | "issue-ref"            // POST /{issues|pulls}/{index}/ref
 *          | "dependency-add"       // POST /{issues|pulls}/{index}/dependency/add
 *          | "dependency-remove"    // POST /{issues|pulls}/{index}/dependency/delete
 *          | "time-add"             // POST /{issues|pulls}/{index}/times/add
 *          | "time-delete"          // POST /{issues|pulls}/{index}/times/{timeid}/delete
 *          | "stopwatch-start"      // POST /{issues|pulls}/{index}/times/stopwatch/start
 *          | "stopwatch-stop"       // POST /{issues|pulls}/{index}/times/stopwatch/stop
 *          | "stopwatch-cancel"     // POST /{issues|pulls}/{index}/times/stopwatch/cancel
 *          | "time-estimate"        // POST /{issues|pulls}/{index}/time_estimate
 *          | "issue-reaction"       // POST /{issues|pulls}/{index}/reactions/{action}
 *          | "issue-delete"         // POST /{issues|pulls}/{index}/delete
 *          | "batch-delete"         // POST /{issues|pulls}/delete
 *          | "project-column-move"  // POST /{issues|pulls}/projects/column
 *          | "comment-update"       // POST /comments/{id}
 *          | "comment-delete"       // POST /comments/{id}/delete
 *          | "comment-reaction";    // POST /comments/{id}/reactions/{action}
 *        owner: string;
 *        repo: string;
 *        urlKind: "issues" | "pulls";
 *        /** The {index} path param (the index-bearing families). *\/
 *        index?: number;
 *        /** The {timeid} path param (time-delete). *\/
 *        timeId?: number;
 *        /** The react|unreact literal (issue-reaction, comment-reaction). *\/
 *        action?: string;
 *        /** The {id} path param (the /comments/{id} trio — the comment ROW
 *         *  id, not an issue index). *\/
 *        commentId?: number;
 *      }
 *
 * 3. `parseUiRoute`'s `head === "issues" || head === "pulls"` arm:
 *
 *    in the length-1 static block (beside the sidebar-write literals — the
 *    static literals outrank the dynamic :index, the wave-5 rule):
 *
 *      // Census gap #1 part two: the repo-scope combo POSTs
 *      // (web.go:1400/1403). Static-before-dynamic.
 *      if (rest[0] === "delete") return { family: "batch-delete", owner, repo, urlKind: head };
 *      if (rest[0] === "projects" && rest[1] === "column") return { family: "project-column-move", owner, repo, urlKind: head };
 *
 *    in the length-2 {index} block (beside the sidebar {index} writes):
 *
 *      // Census gap #1 part two {index}-bearing writes (web.go:1369/1386/1390).
 *      if (rest[1] === "ref") return { family: "issue-ref", owner, repo, urlKind: head, index };
 *      if (rest[1] === "time_estimate") return { family: "time-estimate", owner, repo, urlKind: head, index };
 *      if (rest[1] === "delete") return { family: "issue-delete", owner, repo, urlKind: head, index };
 *
 *    in the length-3 block (beside the unpin tail):
 *
 *      // Census gap #1 part two: dependency add/delete + the time add +
 *      // the reactions pair (web.go:1373-1374/1378/1387).
 *      if (rest[1] === "dependency" && rest[2] === "add") return { family: "dependency-add", owner, repo, urlKind: head, index };
 *      if (rest[1] === "dependency" && rest[2] === "delete") return { family: "dependency-remove", owner, repo, urlKind: head, index };
 *      if (rest[1] === "times" && rest[2] === "add") return { family: "time-add", owner, repo, urlKind: head, index };
 *      if (rest[1] === "reactions" && (rest[2] === "react" || rest[2] === "unreact")) {
 *        return { family: "issue-reaction", owner, repo, urlKind: head, index, action: rest[2] };
 *      }
 *
 *    in the length-4 block:
 *
 *      // Census gap #1 part two: the stopwatch trio + the time-delete tail
 *      // (web.go:1379/1381-1383).
 *      if (rest[1] === "times" && rest[2] === "stopwatch" && (rest[3] === "start" || rest[3] === "stop" || rest[3] === "cancel")) {
 *        return {
 *          family: rest[3] === "start" ? "stopwatch-start" : rest[3] === "stop" ? "stopwatch-stop" : "stopwatch-cancel",
 *          owner, repo, urlKind: head, index,
 *        };
 *      }
 *      if (rest[1] === "times" && /^-?\d+$/.test(rest[2] as string) && rest[3] === "delete") {
 *        return { family: "time-delete", owner, repo, urlKind: head, index, timeId: Number.parseInt(rest[2] as string, 10) };
 *      }
 *
 *    in the length-2/3 `comments` prefix (beside the landed
 *    /comments/{id}/attachments claim — web.go:1337):
 *
 *      // Census gap #1 part two: the comment trio (web.go:1411-1414). The
 *      // comment ROW id rides {id}; /comments/{id}/attachments stays the
 *      // landed claim (the parse order must leave it untouched).
 *      if (rest[0] === "comments" && /^-?\d+$/.test(rest[1] as string)) {
 *        if (rest.length === 2) return { family: "comment-update", owner, repo, urlKind: head, commentId: Number.parseInt(rest[1] as string, 10) };
 *        if (rest[2] === "delete") return { family: "comment-delete", owner, repo, urlKind: head, commentId: Number.parseInt(rest[1] as string, 10) };
 *        if (rest[2] === "reactions" && (rest[3] === "react" || rest[3] === "unreact")) {
 *          return { family: "comment-reaction", owner, repo, urlKind: head, commentId: Number.parseInt(rest[1] as string, 10), action: rest[3] };
 *        }
 *      }
 *
 *    (`viewed-files` stays engine-owned — the STOP adjudication above.)
 * 4. Register beside the landed write families — the static repo-scope
 *    literals (`/issues/delete`, `/issues/projects/column`) BEFORE the
 *    dynamic `/issues/:index` GET line (the wave-9 RegExpRouter rule), the
 *    {index} writes beside the sidebar {index} pairs, the /comments/:id
 *    trio beside the landed attachments pair. Per family BOTH URL kinds
 *    and the chi-405 GET twin (the sidebar recipe's shape):
 *
 *      // Census gap #1 part two (pages/issue-timeline-writes.ts) —
 *      // static-before-dynamic; both URL families.
 *      uiRouter.post("/:owner/:repo/issues/delete", (c) => batchDeleteIssuesSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/delete", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/pulls/delete", (c) => batchDeleteIssuesSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/delete", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/issues/projects/column", (c) => projectColumnMoveSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/projects/column", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/pulls/projects/column", (c) => projectColumnMoveSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/projects/column", () => methodNotAllowed("POST"));
 *      // {index}-bearing writes — the same pair-shape per tail per family:
 *      uiRouter.post("/:owner/:repo/issues/:index/ref", (c) => issueRefSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/:index/ref", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/pulls/:index/ref", (c) => issueRefSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/:index/ref", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/issues/:index/dependency/add", (c) => dependencyAddSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/:index/dependency/add", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/pulls/:index/dependency/add", (c) => dependencyAddSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/:index/dependency/add", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/issues/:index/dependency/delete", (c) => dependencyRemoveSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/:index/dependency/delete", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/pulls/:index/dependency/delete", (c) => dependencyRemoveSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/:index/dependency/delete", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/issues/:index/times/add", (c) => timeAddSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/:index/times/add", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/pulls/:index/times/add", (c) => timeAddSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/:index/times/add", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/issues/:index/times/:timeid/delete", (c) => timeDeleteSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/:index/times/:timeid/delete", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/pulls/:index/times/:timeid/delete", (c) => timeDeleteSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/:index/times/:timeid/delete", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/issues/:index/times/stopwatch/start", (c) => stopwatchStartSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/:index/times/stopwatch/start", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/pulls/:index/times/stopwatch/start", (c) => stopwatchStartSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/:index/times/stopwatch/start", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/issues/:index/times/stopwatch/stop", (c) => stopwatchStopSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/:index/times/stopwatch/stop", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/pulls/:index/times/stopwatch/stop", (c) => stopwatchStopSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/:index/times/stopwatch/stop", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/issues/:index/times/stopwatch/cancel", (c) => stopwatchCancelSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/:index/times/stopwatch/cancel", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/pulls/:index/times/stopwatch/cancel", (c) => stopwatchCancelSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/:index/times/stopwatch/cancel", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/issues/:index/time_estimate", (c) => timeEstimateSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/:index/time_estimate", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/pulls/:index/time_estimate", (c) => timeEstimateSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/:index/time_estimate", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/issues/:index/reactions/:action", (c) => issueReactionSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/:index/reactions/:action", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/pulls/:index/reactions/:action", (c) => issueReactionSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/:index/reactions/:action", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/issues/:index/delete", (c) => issueDeleteSubmit(c));
 *      uiRouter.get("/:owner/:repo/issues/:index/delete", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/pulls/:index/delete", (c) => issueDeleteSubmit(c));
 *      uiRouter.get("/:owner/:repo/pulls/:index/delete", () => methodNotAllowed("POST"));
 *      // The /comments/{id} trio (repo-scoped; the landed attachments GET
 *      // on the {id} prefix stays untouched).
 *      uiRouter.post("/:owner/:repo/comments/:id", (c) => commentUpdateSubmit(c));
 *      uiRouter.get("/:owner/:repo/comments/:id", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/comments/:id/delete", (c) => commentDeleteSubmit(c));
 *      uiRouter.get("/:owner/:repo/comments/:id/delete", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/comments/:id/reactions/:action", (c) => commentReactionSubmit(c));
 *      uiRouter.get("/:owner/:repo/comments/:id/reactions/:action", () => methodNotAllowed("POST"));
 *
 *    (`/issues/:index/viewed-files` is NOT registered — the STOP
 *    adjudication above; the tail stays engine-owned.)
 *
 * ## Pin lines that flip at THIS fold (test-side; edited at the fold, not
 *    here — this unit's tests drive the module's recipe router directly)
 *
 *    - apps/worker/src/ui/pages/issue-detail.matrix.test.tsx — THIS UNIT's
 *      file; the census-gap-#1-part-two describe (added in this window,
 *      render-half only) gains the LIVE write pins at the fold: the
 *      reaction toggle round-trip, the comment edit/delete round-trips,
 *      the stopwatch start/cancel and the manual-add, the estimate set,
 *      the ref set, the dependency add/remove, the admin issue delete's
 *      303 onto the family LIST — all on THROWAWAY rows (the 7187797
 *      lesson: live writes must not disturb the shared fixture's seeded
 *      sidebar/timeline state the display arms read).
 *    - apps/worker/src/ui/index.test.ts — grepped at build time: NO null
 *      pins exist for any shape this module claims (the grep matrix over
 *      `ref|viewed-files|times|time_estimate|reactions|dependency|
 *      projects/column|/comments/{n}` returned only unrelated admin shapes).
 *      NO pin flips there.
 *    - apps/worker/src/ui/__tests__/goldens/*.html — ALL THREE issue-family
 *      goldens grow this window's render arms (the anonymous pair gains the
 *      dependency block + the ref line on the issue golden; the signed-in
 *      golden additionally gains the timetracker block, the reaction bars'
 *      picker, the comment edit/delete forms, the delete button). Regenerate
 *      at a quiet tree at the fold: `node src/ui/__tests__/update-goldens.mjs`
 *      (goldens.test.ts stays RED until then; that file's header carries the
 *      procedure). THE DRIFT IS REPORTED, NOT RE-BASELINED, by this unit.
 *
 * ## Behavior (upstream handlers at the pin, reduced to the landed posture)
 *
 * - Gates. The `addIssuesPullsUpdateRoutes` group carries the unit-reader +
 *   `RepoMustNotBeArchived` middlewares — every non-comment handler here
 *   answers the archived repo with the §4.5 404 shell BEFORE the handler
 *   (the sidebar module's posture). The `/comments/{id}` trio
 *   (web.go:1411-1414) carries ONLY `reqRepoIssuesOrPullsReader` — NO
 *   archived arm upstream; parity keeps it out. Anonymous → the §2.5 login
 *   303 on every family (upstream's handlers assume a doer — an anonymous
 *   write nil-derefs there). Per-handler gates:
 *     · ref / time_estimate: signed && (poster || CanWriteIssuesOrPulls)
 *       else upstream HTTPError(403) — answered STATUS-EXACT as the
 *       plain-text 403 with upstream's generic forbidden text (the HTML
 *       error page is chrome; the JSONError-vs-HTTPError split below).
 *     · dependency add/delete: upstream has NO middleware gate — the
 *       in-handler `CanCreateIssueDependencies` (dependencies-enabled —
 *       always true landed — && CanWriteIssuesOrPulls) answers
 *       JSONError(error.permission_denied), a MESSAGE-channel arm: the
 *       landed re-render convention (200 re-render, message in the comment
 *       form's error slot).
 *     · times add/delete + the stopwatch trio: upstream's
 *       CanUseTimetracker → NotFound. Under the default settings the
 *       predicate is TRUE for every signed-in viewer (timetracker enabled,
 *       AllowOnlyContributorsToTrackTime=false — no settings module landed,
 *       so the gate is the bare session; the 404 arm materializes only when
 *       the timetracker settings land).
 *     · issue delete / batch delete: reqRepoAdmin → the sidebar admin gate
 *       (canAdminRepo, the settings predicate; archived → 404 shell first).
 *     · projects/column: reqRepoIssuesOrPullsWriter + reqRepoProjectsWriter
 *       — the landed matrix has no separate projects-write bit; the writer
 *       gate is the whole predicate (the part-one projects posture).
 *     · the reaction pair: canSelfChangeOrAccessContent(issue|comment's
 *       issue, poster, Read) — any reader passes, EXCEPT the locked-issue
 *       arm (locked && !writer → 403). The comment trio's update/delete
 *       getters use accessMode=WRITE (poster || writer) with the same
 *       locked arm, and `HasContentSupport` else HTTPError(400) — answered
 *       STATUS-EXACT as the plain-text 400 (the system comments are not
 *       editable content).
 * - The JSONError-vs-HTTPError answer split. Upstream's message-channel
 *   failures (ctx.JSONError: dependency refusals, the already_changed
 *   CAS refusal, the time/estimate format errors) re-render the detail
 *   page at 200 with the upstream message in the comment form's error
 *   slot (the landed issueLabelsSubmit convention — the only message
 *   channel the no-JS page has). Upstream's HTTPError status pages
 *   (403 forbidden, 400 content-support) answer STATUS-EXACT as the
 *   plain-text body (compare.tsx's honest-500 posture family).
 * - Success answers. Upstream answers JSONOK()/JSONRedirect("")/JSON
 *   payloads the form-fetch JS turns into reloads or DOM swaps; the landed
 *   no-JS convention is the 303. The {index} writes and the comment trio
 *   303 onto the row's OWN canonical family page (`/{owner}/{repo}/
 *   {issues|pulls}/{index}` — Issue.Link()); the two LIST-shaped writes
 *   answer their own list: issue delete 303s onto
 *   `/{owner}/{repo}/{pulls|issues}` (upstream ctx.Redirect(repo.Link()+
 *   "/pulls", 303) verbatim — issue_new.go:222-226), batch delete 303s
 *   onto the ADDRESSED family's list (upstream JSONOK, the list reload).
 * - UpdateIssueRef (issue.go:302-321): `ref` FormTrim'd (empty = clear);
 *   issues ONLY — a pull row is the 403 arm (upstream `|| issue.IsPull`);
 *   the landed changeIssueRef writes the row + the change_issue_ref (33)
 *   comment. The success JSON {ref} is the JS display swap this 303
 *   replaces.
 * - AddDependency / RemoveDependency (issue_dependency.go:14-152): the
 *   dependency id is GLOBAL (GetIssueByID — a missing id answers
 *   JSONError "Dependent issue does not exist." on ADD, ServerError on
 *   REMOVE — the plain-text 500 posture); AllowCrossRepositoryDependencies
 *   defaults FALSE → a cross-repo pair answers "Both issues must be in the
 *   same repository." (the landed default; the upstream default-flip would
 *   add the read-permission arm); self-dependency "You cannot make an
 *   issue depend on itself."; the duplicate/circular guards answer the
 *   upstream model messages; the remove's dependencyType is blockedBy
 *   (edge: this issue depends on dep) | blocking (edge: dep depends on
 *   this issue) else the literal "invalid dependency type" JSONError; the
 *   writes ride the landed edge shape (models/issues/dependency.go:124/157
 *   — the edge + the two type-19/20 comments in one batch, re-ported from
 *   the API port's file-private seams — the ONE write-logic duplication in
 *   this unit, disclosed beside part one's pin re-port for the
 *   orchestrator's seam-extraction call).
 * - AddTimeManually (issue_timetrack.go:21-51): hours/minutes parse to
 *   seconds (h*3600+m*60); total <= 0 answers "No time was entered."
 *   (repo.issues.add_time_sum_to_small); the write is the landed
 *   tracked_time port (the add_time_manual (14) comment with the
 *   `|{seconds}` marker, models/issues/tracked_time.go:185-193). The
 *   form-bind refusals (non-numeric/out-of-range hours) collapse into the
 *   same sum-small channel — the bind message is framework chrome, the
 *   outcome (refusal, nothing written) matches.
 * - DeleteTime (issue_timetrack.go:53-86): the (issue, timeid) lookup is
 *   NotFound 404 upstream (the 404 shell); only the entry's owner or a
 *   site admin may delete (HTTPError 403 "not allowed" — status-exact
 *   plain text); the delete is SOFT (tracked_time.deleted flips — the
 *   landed deleteTimeRoute shape) with the del_time_manual (26) comment
 *   posted by the ENTRY'S owner (upstream Doer: t.User). The success flash
 *   (repo.issues.del_time_history) has no session-flash channel landed —
 *   dropped, documented.
 * - The stopwatch trio (issue_stopwatch.go): CreateIssueStopwatch
 *   (stopwatch.go:172-206) — at most ONE running stopwatch per USER: a
 *   start on this issue while IT runs is ok=false (upstream flashes
 *   "The timer for this issue already exists" — the flash channel is
 *   dropped, the 303 stands); a start while ANOTHER issue's runs FINISHES
 *   that one first (the tracked_time + the stop_tracking (13) comment
 *   with the SecToHours content) then starts here (the start_tracking
 *   (12) comment). Stop: finish (bank elapsed, comment 13, delete row);
 *   a non-running stop is ok=false upstream ("already stopped" flash —
 *   dropped, still 303: JSONRedirect answers regardless). Cancel: delete
 *   the row + the cancel_tracking (15) comment; a non-running cancel is
 *   the silent no-op (models/issues/stopwatch.go CancelStopwatch's
 *   !exists arm answers ok=false with no write — still 303).
 * - UpdateIssueTimeEstimate (issue_timetrack.go:88-118): TimeEstimateParse
 *   — the `(?i)(\d+)\s*([hms])` full-string chain, EMPTY = 0 (a valid
 *   clear), whitespace between units allowed, anything else invalid →
 *   "Time estimate format is invalid"; the unchanged value is the no-op;
 *   the write is the ChangeIssueTimeEstimate port (issue.go:785-806): the
 *   time_estimate column + the change_time_estimate (38) comment with the
 *   DECIMAL SECONDS as content.
 * - ChangeIssueReaction / ChangeCommentReaction (issue.go:488-547,
 *   issue_comment.go:258+): action react|unreact|else-404; the content
 *   must be in the instance's allowed set (ALLOWED_REACTIONS — upstream
 *   setting.UI.Reactions default; a foreign code is upstream's
 *   ErrForbiddenIssueReaction → ServerError 500 → the plain-text 500
 *   posture, status-exact with the landed API's own 403 for ITS surface);
 *   react runs the blocked-user guard (IsUserBlockedBy(doer, poster,
 *   owner[, comment poster]) → ServerError 500 — the landed isUserBlockedBy
 *   probe); the writes ride the landed createIssueReaction (the
 *   reactions_target_uq idempotence — a duplicate stays success, upstream
 *   logs-and-continues) and deleteIssueReaction (silent). Success JSON
 *   {html} (the bar swap) → the canonical 303.
 * - UpdateCommentContent (issue_comment.go:179-241): the strict
 *   content_version CAS check precedes everything (mismatch → JSONError
 *   "Unable to save changes..." — the re-render channel; the landed
 *   updateCommentBody re-checks its own CAS, the version compare here is
 *   upstream's exact first arm); the unchanged content skips the write;
 *   attachments (files[]) are NOT carried by the no-JS form — the
 *   ignore_attachments semantics hold trivially (the attachments family
 *   rides issue-attachments-write.tsx); the success JSON {content,
 *   contentVersion, attachments} is the JS swap this 303 replaces.
 * - DeleteComment (issue_comment.go:243-256): the landed deleteComment
 *   (unlink + num_comments decrement + the content-history hard-delete);
 *   upstream answers Status(200) to the JS removal — the no-JS 303
 *   canonical replaces it.
 * - DeleteIssue (issue_new.go:207-227): the landed deleteIssueCascade
 *   (the full §4.12 cascade) WITH the webhook emission threaded through
 *   the fabricated ApiContext (the sidebar module's apiContextFor bridge —
 *   the emission parity the API route carries); the 303 target is
 *   upstream's literal: the repo's family LIST.
 * - BatchDeleteIssues (issue_list.go:311-321): the `issue_ids` form value
 *   set (comma-joined; the checkbox multi-value shape parses too — the
 *   positiveIntIdSet superset); a non-integer piece is upstream's
 *   ServerError (the plain-text 500); a missing/foreign id is
 *   getActionIssues' NotFound (the 404 shell); each delete rides the same
 *   cascade+emission seam; success 303 onto the addressed family's list.
 * - UpdateIssueProjectColumn (projects.go:484-510): `issue_id` is the
 *   repo-scoped INDEX (GetIssueByRepoID) — a miss 404-shells (the
 *   repo-scoped-lookup rule); `id` is the GLOBAL column id — a miss is
 *   upstream's ServerError (the plain-text 500); the column's project
 *   must be one of the issue's projects (else NotFound — the 404 shell);
 *   the move rides the landed moveIssueToColumn (the project-column (31)
 *   comment). NO detail-page UI drives it (upstream's driver is the
 *   project board's per-card column select — a board-surface island; the
 *   board modules are outside this unit's ownership) — the handler lands
 *   ready for that surface, like part one's move_pin.
 *
 * ## The resolution prologue
 *
 * Re-assembled from the same leaf modules exactly like part one
 * (pages/issue-sidebar-writes.ts) — resolveViewer/resolveRepositoryForViewer
 * + the ctx flags the re-rendered page carries; the failure re-renders
 * ride pages/issue-detail.tsx's loader + access resolver + render entry.
 */

import { Context, Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";

import type { ApiEnv } from "../../api/env";
import { isUserBlockedBy } from "../../api/services/blocks";
import {
  ALLOWED_REACTIONS,
  createIssueReaction,
  deleteIssueReaction,
} from "../../api/services/issue-extras";
import {
  changeIssueRef,
  commentHasContentSupport,
  deleteComment,
  deleteIssueCascade,
  findRepoCommentById,
  issueDeleteEmission,
  updateCommentBody,
} from "../../api/services/issues";
import { findIssueByIdGlobally, moveIssueToColumn } from "../../api/services/projects";
import { loadRepoSettings } from "../../api/services/repo-settings";
import { getWatch } from "../../api/services/repo-watchers";
import { isStarring } from "../../api/services/stars";
import {
  comments,
  issueDependencies,
  issueStopwatches,
  issues,
  projectColumns,
  projectIssues,
  projects,
  trackedTimes,
} from "../../db/schema";
import { CommentType } from "../../issues/comment-types";
import type { CommentRow, IssueRow } from "../../issues/service";
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
  loadIssueDetailData,
  renderIssueDetailPage,
  resolveIssueDetailAccess,
} from "./issue-detail";
import { countUnreadNotifications } from "./notifications";
import { positiveIntIdSet } from "./issue-sidebar-writes";
import { canAdminRepo } from "./settings";

type RouteContext = Context<{ Bindings: Env }>;
type ApiContext = Context<ApiEnv>;

/** Page chrome text (component-local; the strings are the upstream locale
 *  strings verbatim — the keys cite locale_en-US.json). */
export const issueTimelineLocale = {
  permission_denied: "Permission denied.", // "error.permission_denied"
  not_allowed: "Not allowed", // DeleteTime's HTTPError title, issue_timetrack.go:76
  dep_not_exist_target: "Dependent issue does not exist.", // "repo.issues.dependency.add_error_dep_issue_not_exist"
  dep_not_same_repo: "Both issues must be in the same repository.", // "repo.issues.dependency.add_error_dep_not_same_repo"
  dep_same_issue: "You cannot make an issue depend on itself.", // "repo.issues.dependency.add_error_same_issue"
  dep_exists: "Dependency already exists.", // "repo.issues.dependency.add_error_dep_exists"
  dep_circular: "You cannot create a dependency with two issues that block each other.", // "repo.issues.dependency.add_error_cannot_create_circular"
  dep_not_exist: "Dependency does not exist.", // "repo.issues.dependency.add_error_dep_not_exist"
  dep_invalid_type: "invalid dependency type", // issue_dependency.go:105's literal
  add_time_too_small: "No time was entered.", // "repo.issues.add_time_sum_to_small"
  estimate_invalid: "Time estimate format is invalid", // "repo.issues.time_estimate_invalid"
  reaction_forbidden: "no permission to change reaction", // models/issues/reaction.go ErrForbiddenIssueReaction text
  comment_already_changed:
    "Unable to save changes to the comment. It appears the content has already been changed by another user. Please refresh the page and try editing again to avoid overwriting their changes", // "repo.comments.edit.already_changed"
  content_required: "content is required", // ReactionForm's Required bind refusal (issue_reaction forms)
} as const;

// ---------------------------------------------------------------------------
// Form parsers (the upstream field names)
// ---------------------------------------------------------------------------

/** `ref` — FormTrim'd (upstream ctx.FormTrim; whitespace-only = clear). */
export function parseIssueRefForm(params: URLSearchParams): string {
  return (params.get("ref") ?? "").trim();
}

/** `newDependency` — the GLOBAL dependency issue id; non-numeric = null. */
export function parseDependencyAddForm(params: URLSearchParams): number | null {
  const raw = (params.get("newDependency") ?? "").trim();
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
}

export interface DependencyRemoveForm {
  dependencyId: number | null;
  /** "blockedBy" | "blocking" | "" (upstream's switch default arm). */
  dependencyType: "blockedBy" | "blocking" | "";
}

export function parseDependencyRemoveForm(params: URLSearchParams): DependencyRemoveForm {
  const raw = (params.get("removeDependencyID") ?? "").trim();
  const type = params.get("dependencyType") ?? "";
  return {
    dependencyId: /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null,
    dependencyType: type === "blockedBy" || type === "blocking" ? type : "",
  };
}

/** hours/minutes — the Range(0,1000) ints. An ABSENT field is upstream's
 *  zero (binding only refuses PRESENT-but-unparseable values); a present
 *  empty/non-numeric/out-of-range value is the never-totaling null (the
 *  bind refusal collapsed into the sum-small channel — the module
 *  header's documented note). */
export interface AddTimeForm {
  hours: number | null;
  minutes: number | null;
}

function rangeInt(raw: string | null): number | null {
  if (raw === null) return 0;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^-?\d+$/.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 10);
  return value >= 0 && value <= 1000 ? value : null;
}

export function parseAddTimeForm(params: URLSearchParams): AddTimeForm {
  return { hours: rangeInt(params.get("hours")), minutes: rangeInt(params.get("minutes")) };
}

/** Upstream TimeEstimateParse (modules/util/time_str.go:42-79): the
 *  `(?i)(\d+)\s*([hms])` chain over the trimmed string; empty = 0; only
 *  whitespace may sit between units; any other shape is invalid (null). */
export function parseTimeEstimateForm(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return 0;
  const re = /(\d+)\s*([hms])/gi;
  let total = 0;
  let prevEnd = 0;
  let matched = false;
  let lastEnd = -1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(trimmed)) !== null) {
    if (!matched && match.index !== 0) return null;
    matched = true;
    if (trimmed.slice(prevEnd, match.index).trim() !== "") return null;
    prevEnd = match.index + match[0].length;
    lastEnd = prevEnd;
    const unit = match[2]!.toLowerCase();
    total += Number.parseInt(match[1]!, 10) * (unit === "h" ? 3600 : unit === "m" ? 60 : 1);
  }
  if (!matched || lastEnd !== trimmed.length) return null;
  return total;
}

/** The reaction pair: action comes from the PATH; content is the form's
 *  Required field (empty/garbage = null → the bind-refusal 400 arm). */
export function parseReactionForm(params: URLSearchParams): string | null {
  const raw = params.get("content") ?? "";
  return raw === "" ? null : raw;
}

export interface CommentUpdateForm {
  content: string;
  /** FormInt's zero for absent/garbage (upstream ctx.FormInt). */
  contentVersion: number;
}

export function parseCommentUpdateForm(params: URLSearchParams): CommentUpdateForm {
  const raw = (params.get("content_version") ?? "").trim();
  return {
    content: params.get("content") ?? "",
    contentVersion: /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0,
  };
}

/** BatchDeleteIssues' `issue_ids` — the comma-joined global id set (the
 *  positiveIntIdSet superset parse: multi-value + comma-split, dupes
 *  collapsed). */
export function parseBatchDeleteForm(params: URLSearchParams): number[] {
  return positiveIntIdSet(params, "issue_ids");
}

export interface ProjectColumnMoveForm {
  /** The repo-scoped issue INDEX (upstream GetIssueByRepoID's third arg). */
  issueIndex: number | null;
  /** The GLOBAL column id. */
  columnId: number | null;
}

export function parseProjectColumnMoveForm(params: URLSearchParams): ProjectColumnMoveForm {
  const issue = (params.get("issue_id") ?? "").trim();
  const column = (params.get("id") ?? "").trim();
  return {
    issueIndex: /^\d+$/.test(issue) ? Number.parseInt(issue, 10) : null,
    columnId: /^\d+$/.test(column) ? Number.parseInt(column, 10) : null,
  };
}

// ---------------------------------------------------------------------------
// The time-format + stopwatch reads (re-exported from the render module —
// the render→write import direction keeps the pair acyclic)
// ---------------------------------------------------------------------------

import { secToHours, stopwatchOfIssue, stopwatchOfUser, timeEstimateString } from "./issue-detail";
export { secToHours, stopwatchOfIssue, stopwatchOfUser, timeEstimateString };

// ---------------------------------------------------------------------------
// The write seams (one per upstream handler; D1-only, the landed services)
// ---------------------------------------------------------------------------

/** ChangeIssueRef — the landed seam (the change_issue_ref (33) comment).
 *  Upstream guards PR rows at the handler (the 403 arm); issues only. */
export async function applyIssueRefWrite(d1: D1Database, issue: IssueRow, ref: string, actorId: number, now: Date): Promise<void> {
  await changeIssueRef(d1, issue, ref, actorId, now);
}

/** CreateIssueDependency (models/issues/dependency.go:124-156) — the
 *  duplicate/circular guards answer upstream's model-error texts (the
 *  caller pre-checked same-issue and cross-repo, upstream's handler
 *  order); the edge + the two type-19/20 comments in ONE batch. Re-ported
 *  from the API port's file-private createDependencyEdge over the same
 *  upstream lines (the module header's duplication note). */
export type DependencyAddResult = { outcome: "applied" } | { outcome: "exists" } | { outcome: "circular" };

export async function applyDependencyAddWrite(
  d1: D1Database,
  actorId: number,
  target: IssueRow,
  dependency: IssueRow,
  now: Date,
): Promise<DependencyAddResult> {
  const existing = await drizzle(d1)
    .select({ id: issueDependencies.id })
    .from(issueDependencies)
    .where(and(eq(issueDependencies.issueId, target.id), eq(issueDependencies.dependencyId, dependency.id)))
    .limit(1)
    .then((rows) => rows[0]);
  if (existing !== undefined) return { outcome: "exists" };
  const circular = await drizzle(d1)
    .select({ id: issueDependencies.id })
    .from(issueDependencies)
    .where(and(eq(issueDependencies.issueId, dependency.id), eq(issueDependencies.dependencyId, target.id)))
    .limit(1)
    .then((rows) => rows[0]);
  if (circular !== undefined) return { outcome: "circular" };
  const type = CommentType.AddDependency;
  await drizzle(d1).batch([
    drizzle(d1).insert(issueDependencies).values({ userId: actorId, issueId: target.id, dependencyId: dependency.id, createdAt: now }),
    drizzle(d1).insert(comments).values({
      type,
      posterId: actorId,
      issueId: target.id,
      dependentIssueId: dependency.id,
      content: "",
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, target.id)),
    drizzle(d1).insert(comments).values({
      type,
      posterId: actorId,
      issueId: dependency.id,
      dependentIssueId: target.id,
      content: "",
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, dependency.id)),
  ] as const);
  return { outcome: "applied" };
}

/** RemoveIssueDependency (dependency.go:157-183): blockedBy → the edge
 *  (target depends on dependency); blocking → the edge (dependency
 *  depends on target); the 0-row guard is the not-exists arm; the two
 *  removal comments ride. */
export type DependencyRemoveResult = { outcome: "applied" } | { outcome: "not-exists" };

export async function applyDependencyRemoveWrite(
  d1: D1Database,
  actorId: number,
  target: IssueRow,
  dependency: IssueRow,
  dependencyType: "blockedBy" | "blocking",
  now: Date,
): Promise<DependencyRemoveResult> {
  const edge =
    dependencyType === "blockedBy"
      ? and(eq(issueDependencies.issueId, target.id), eq(issueDependencies.dependencyId, dependency.id))
      : and(eq(issueDependencies.issueId, dependency.id), eq(issueDependencies.dependencyId, target.id));
  const removed = await drizzle(d1).delete(issueDependencies).where(edge).returning({ id: issueDependencies.id });
  if (removed.length === 0) return { outcome: "not-exists" };
  const type = CommentType.RemoveDependency;
  await drizzle(d1).batch([
    drizzle(d1).insert(comments).values({
      type,
      posterId: actorId,
      issueId: target.id,
      dependentIssueId: dependency.id,
      content: "",
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, target.id)),
    drizzle(d1).insert(comments).values({
      type,
      posterId: actorId,
      issueId: dependency.id,
      dependentIssueId: target.id,
      content: "",
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, dependency.id)),
  ] as const);
  return { outcome: "applied" };
}

/** AddTime (models/issues/tracked_time.go:164-193, the landed API port's
 *  shape): the tracked_time row + the add_time_manual (14) comment with
 *  the `|{seconds}` marker + the counter fold. */
export async function applyTimeAddWrite(d1: D1Database, issue: IssueRow, userId: number, seconds: number, now: Date): Promise<void> {
  await drizzle(d1).batch([
    drizzle(d1).insert(trackedTimes).values({ issueId: issue.id, userId, seconds, createdAt: now }),
    drizzle(d1).insert(comments).values({
      type: CommentType.AddTimeManual,
      posterId: userId,
      issueId: issue.id,
      content: `|${seconds}`,
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, issue.id)),
  ] as const);
}

/** The (issue, timeid) row — GetTrackedTimeByID over LIVE rows only (the
 *  landed list filter; a soft-deleted id is upstream's ErrNotExist). */
export async function trackedTimeOf(d1: D1Database, issueId: number, timeId: number): Promise<{ id: number; userId: number; seconds: number } | null> {
  const row = await drizzle(d1)
    .select({ id: trackedTimes.id, userId: trackedTimes.userId, seconds: trackedTimes.seconds })
    .from(trackedTimes)
    .where(and(eq(trackedTimes.issueId, issueId), eq(trackedTimes.id, timeId), eq(trackedTimes.deleted, false)))
    .limit(1)
    .then((rows) => rows[0]);
  return row ?? null;
}

/** DeleteTime (tracked_time.go DeleteTime + :310-379's soft-delete shape):
 *  `deleted` flips, the del_time_manual (26) comment posts by the ENTRY'S
 *  owner (upstream Doer: t.User), the counter folds. */
export async function applyTimeDeleteWrite(d1: D1Database, issue: IssueRow, entry: { id: number; userId: number; seconds: number }, now: Date): Promise<void> {
  await drizzle(d1).batch([
    drizzle(d1).update(trackedTimes).set({ deleted: true }).where(eq(trackedTimes.id, entry.id)),
    drizzle(d1).insert(comments).values({
      type: CommentType.DeleteTimeManual,
      posterId: entry.userId,
      issueId: issue.id,
      content: `|${entry.seconds}`,
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, issue.id)),
  ] as const);
}

// stopwatchOfUser/stopwatchOfIssue are the render module's reads (re-
// exported at the top — the single definitions live there).

/** finishIssueStopwatch (stopwatch.go:145-169): bank the elapsed time, the
 *  stop_tracking (13) comment with the SecToHours content, the counter
 *  fold, the row delete — one batch (the time_id back-reference has no
 *  landed column — the landed API port's documented deviation). */
export async function finishStopwatch(d1: D1Database, issue: IssueRow, userId: number, stopwatch: { id: number; createdAt: Date }, now: Date): Promise<void> {
  const elapsed = Math.max(0, Math.floor((now.getTime() - stopwatch.createdAt.getTime()) / 1000));
  await drizzle(d1).batch([
    drizzle(d1).insert(trackedTimes).values({ issueId: issue.id, userId, seconds: elapsed, createdAt: now }),
    drizzle(d1).insert(comments).values({
      type: CommentType.StopTracking,
      posterId: userId,
      issueId: issue.id,
      content: secToHours(elapsed),
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, issue.id)),
    drizzle(d1).delete(issueStopwatches).where(eq(issueStopwatches.id, stopwatch.id)),
  ] as const);
}

/** CreateIssueStopwatch (stopwatch.go:172-206): at most one running
 *  stopwatch per user — a re-start here is "already-running" (upstream's
 *  ok=false flash arm); a start while ANOTHER issue's runs finishes that
 *  one first (the banked time + comment 13) then starts here. */
export type StopwatchStartResult = { outcome: "started" } | { outcome: "already-running" };

export async function applyStopwatchStartWrite(d1: D1Database, issue: IssueRow, userId: number, now: Date): Promise<StopwatchStartResult> {
  const running = await stopwatchOfUser(d1, userId);
  if (running !== null && running.issueId === issue.id) {
    return { outcome: "already-running" };
  }
  if (running !== null) {
    const other = await findIssueByIdGlobally(d1, running.issueId);
    if (other !== null) {
      await finishStopwatch(d1, other, userId, running, now);
    } else {
      // Orphaned stopwatch row (the issue cascade missed it) — drop it so
      // the start can proceed (the API port's shape).
      await drizzle(d1).delete(issueStopwatches).where(eq(issueStopwatches.id, running.id));
    }
  }
  await drizzle(d1).batch([
    drizzle(d1).insert(issueStopwatches).values({ issueId: issue.id, userId, createdAt: now }),
    drizzle(d1).insert(comments).values({
      type: CommentType.StartTracking,
      posterId: userId,
      issueId: issue.id,
      content: "",
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, issue.id)),
  ] as const);
  return { outcome: "started" };
}

/** FinishIssueStopwatch: "stopped" banks the time; "not-running" is
 *  upstream's ok=false arm (the flash-and-continue — the caller still
 *  answers the redirect). */
export type StopwatchStopResult = { outcome: "stopped" } | { outcome: "not-running" };

export async function applyStopwatchStopWrite(d1: D1Database, issue: IssueRow, userId: number, now: Date): Promise<StopwatchStopResult> {
  const stopwatch = await stopwatchOfIssue(d1, userId, issue.id);
  if (stopwatch === null) return { outcome: "not-running" };
  await finishStopwatch(d1, issue, userId, stopwatch, now);
  return { outcome: "stopped" };
}

/** CancelStopwatch (stopwatch.go:208-241): delete the row + the
 *  cancel_tracking (15) comment; a non-running cancel is the silent no-op
 *  (upstream's !exists arm answers ok=false, no write). */
export type StopwatchCancelResult = { outcome: "canceled" } | { outcome: "not-running" };

export async function applyStopwatchCancelWrite(d1: D1Database, issue: IssueRow, userId: number, now: Date): Promise<StopwatchCancelResult> {
  const stopwatch = await stopwatchOfIssue(d1, userId, issue.id);
  if (stopwatch === null) return { outcome: "not-running" };
  await drizzle(d1).batch([
    drizzle(d1).delete(issueStopwatches).where(eq(issueStopwatches.id, stopwatch.id)),
    drizzle(d1).insert(comments).values({
      type: CommentType.CancelTracking,
      posterId: userId,
      issueId: issue.id,
      content: "",
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, issue.id)),
  ] as const);
  return { outcome: "canceled" };
}

/** ChangeIssueTimeEstimate (models/issues/issue.go:785-806): the
 *  time_estimate column + the change_time_estimate (38) comment with the
 *  DECIMAL SECONDS as content + the counter fold. */
export async function applyTimeEstimateWrite(d1: D1Database, issue: IssueRow, seconds: number, actorId: number, now: Date): Promise<void> {
  await drizzle(d1).batch([
    drizzle(d1).update(issues).set({ timeEstimate: seconds }).where(eq(issues.id, issue.id)),
    drizzle(d1).insert(comments).values({
      type: CommentType.ChangeTimeEstimate,
      posterId: actorId,
      issueId: issue.id,
      content: String(seconds),
      createdAt: now,
      updatedAt: now,
    }),
    drizzle(d1).update(issues).set({ numComments: sql`num_comments + 1` }).where(eq(issues.id, issue.id)),
  ] as const);
}

export type ReactionApplyResult =
  | { outcome: "applied" }
  | { outcome: "forbidden-reaction" }
  | { outcome: "blocked-user" };

/** ChangeIssueReaction/ChangeCommentReaction's write half: the content
 *  allow-list and the blocked-user guard answer upstream's ServerError
 *  arms (the caller renders the plain-text 500); the idempotent create is
 *  success either way (upstream logs-and-continues on a duplicate). */
export async function applyReactionWrite(
  d1: D1Database,
  target: { issueId: number; commentId: number },
  action: string,
  content: string,
  doer: { id: number; isAdmin: boolean },
  blockerIds: number[],
  now: Date,
): Promise<ReactionApplyResult> {
  if (!ALLOWED_REACTIONS.has(content)) return { outcome: "forbidden-reaction" };
  if (await isUserBlockedBy(d1, doer, ...blockerIds)) return { outcome: "blocked-user" };
  if (action === "react") {
    await createIssueReaction(d1, { userId: doer.id, issueId: target.issueId, commentId: target.commentId, type: content }, now);
    return { outcome: "applied" };
  }
  if (action === "unreact") {
    await deleteIssueReaction(d1, { userId: doer.id, issueId: target.issueId, commentId: target.commentId, type: content });
    return { outcome: "applied" };
  }
  return { outcome: "forbidden-reaction" };
}

/** UpdateCommentContent's write half: the unchanged content skips (no
 *  version bump — upstream's `if newContent != comment.Content` guard);
 *  the change rides the landed updateCommentBody (the content-history
 *  hook + the version bump). */
export type CommentUpdateResult = { outcome: "applied" };

export async function applyCommentUpdateWrite(
  d1: D1Database,
  comment: CommentRow,
  content: string,
  actorId: number,
  now: Date,
): Promise<CommentUpdateResult> {
  if (content !== comment.content) {
    await updateCommentBody(d1, comment.id, content, now, actorId);
  }
  return { outcome: "applied" };
}

/** DeleteIssue's write half — the landed §4.12 cascade WITH the webhook
 *  emission threaded through the fabricated ApiContext (the sidebar
 *  module's bridge; the API route's `issueDeleteEmission(c)` shape). */
export async function applyIssueDeleteWrite(apiContext: ApiContext, issue: IssueRow): Promise<void> {
  await deleteIssueCascade(apiContext.env.DB, apiContext.env.REPO_PACKS, issue, issueDeleteEmission(apiContext));
}

export type ProjectColumnMoveResult =
  | { outcome: "applied" }
  | { outcome: "missing-column" }
  | { outcome: "not-in-project" };

/** UpdateIssueProjectColumn's write half (projects.go:484-510): the bare
 *  GetColumn probe (a miss is the caller's 500), the membership-contains
 *  guard (a miss is the caller's 404 shell), then the landed
 *  moveIssueToColumn (the project-column (31) comment). */
export async function applyProjectColumnMoveWrite(
  d1: D1Database,
  issue: IssueRow,
  columnId: number,
  doerId: number,
  now: Date,
): Promise<ProjectColumnMoveResult> {
  const column = await drizzle(d1)
    .select()
    .from(projectColumns)
    .where(eq(projectColumns.id, columnId))
    .limit(1)
    .then((rows) => rows[0]);
  if (column === undefined) return { outcome: "missing-column" };
  const membership = await drizzle(d1)
    .select({ projectId: projectIssues.projectId })
    .from(projectIssues)
    .where(and(eq(projectIssues.issueId, issue.id), eq(projectIssues.projectId, column.projectId)))
    .limit(1)
    .then((rows) => rows[0]);
  if (membership === undefined) return { outcome: "not-in-project" };
  const projectRows = await drizzle(d1).select().from(projects).where(eq(projects.id, column.projectId)).limit(1);
  const project = projectRows[0];
  if (project === undefined) return { outcome: "not-in-project" };
  await moveIssueToColumn(d1, project, issue, column, null, doerId, now);
  return { outcome: "applied" };
}

// ---------------------------------------------------------------------------
// The resolution prologue (part one's leaf-only twin — the module header)
// ---------------------------------------------------------------------------

/** ui/index.ts's UiAssetsFetcher declared locally (the part-one posture —
 *  the test harness injects the synthetic manifest through it). */
export interface TimelineAssetsFetcher {
  fetch(input: RequestInfo): Promise<Response>;
}

function assetsBinding(env: Pick<Env, "ASSETS">): TimelineAssetsFetcher | undefined {
  if ("ASSETS" in env) {
    const binding: unknown = env.ASSETS;
    if (typeof binding === "object" && binding !== null && "fetch" in binding) {
      return binding as TimelineAssetsFetcher;
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

/** The session half of resolveUiSession (the part-one twin): viewer +
 *  manifest + bell count + the set-cookie-attaching respond. */
async function resolveTimelineSession(c: RouteContext): Promise<ResolvedSession | { ok: false; response: Response }> {
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

/** The repo prologue (the part-one twin): session → §2.5 repo read → the
 *  ctx flags the re-rendered page's shell carries. The WRITE GATE is NOT
 *  here — the handlers apply it after the resolution. */
async function resolveTimelineRepo(c: RouteContext): Promise<ResolvedRepo | { ok: false; response: Response }> {
  const session = await resolveTimelineSession(c);
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
    const [repoWatch, starring] = await Promise.all([getWatch(c.env.DB, repo.id, viewer.id), isStarring(c.env.DB, viewer.id, repo.id)]);
    ctx.viewerRepoWatch = repoWatch;
    ctx.viewerStarsRepo = starring;
  }
  return { ok: true, url, ctx, viewer, respond, repo };
}

/** The signed-in viewer the gates hand back. */
type UserViewer = Extract<Viewer, { kind: "user" }>;

interface GatePassed {
  ok: true;
  url: URL;
  ctx: UiContext;
  viewer: UserViewer;
  respond: (res: Response) => Response;
  repo: RepoRow;
}

/** The session gate (the part-one watch arm's shape): anonymous → the
 *  login 303; `archived` = the group's RepoMustNotBeArchived arm (the
 *  /comments trio passes false — upstream's group carries no such
 *  middleware there). */
function timelineSessionGate(
  c: RouteContext,
  resolved: Extract<ResolvedRepo, { ok: true }>,
  archived: boolean,
): GatePassed | { response: Response } {
  const { url, ctx, viewer, respond, repo } = resolved;
  if (viewer.kind === "anonymous") return { response: respond(loginRedirect(url.pathname + url.search)) };
  if (archived && repo.isArchived) return { response: respond(c.html(renderNotFound(ctx), 404)) };
  return { ok: true, url, ctx, viewer, respond, repo };
}

/** The labels-write gate verbatim (anonymous → the login 303, archived or
 *  non-writer → the 404 shell). */
async function timelineWriterGate(c: RouteContext, resolved: Extract<ResolvedRepo, { ok: true }>): Promise<GatePassed | { response: Response }> {
  const { url, ctx, viewer, respond, repo } = resolved;
  if (viewer.kind === "anonymous") return { response: respond(loginRedirect(url.pathname + url.search)) };
  if (repo.isArchived || !(await canWriteRepo(c.env, repo, viewer))) {
    return { response: respond(c.html(renderNotFound(ctx), 404)) };
  }
  return { ok: true, url, ctx, viewer, respond, repo };
}

/** The admin gate (the wave-5 label-write ladder — canAdminRepo, the
 *  settings predicate, standing in for upstream RequireRepoAdmin). */
async function timelineAdminGate(c: RouteContext, resolved: Extract<ResolvedRepo, { ok: true }>): Promise<GatePassed | { response: Response }> {
  const { url, ctx, viewer, respond, repo } = resolved;
  if (viewer.kind === "anonymous") return { response: respond(loginRedirect(url.pathname + url.search)) };
  if (repo.isArchived || !(await canAdminRepo(c.env, repo, viewer))) {
    return { response: respond(c.html(renderNotFound(ctx), 404)) };
  }
  return { ok: true, url, ctx, viewer, respond, repo };
}

/** The row's canonical page (upstream Issue.Link() — the redirect target
 *  of every JSONRedirect arm). */
function canonicalIssuePath(repo: RepoRow, issue: IssueRow): string {
  return `/${repo.ownerNamespace}/${repo.slug}/${issue.isPull ? "pulls" : "issues"}/${issue.index}`;
}

/** The repo's family LIST (upstream ctx.Redirect(repo.Link()+"/pulls")) —
 *  the delete family's target. */
function familyListPath(repo: RepoRow, isPull: boolean): string {
  return `/${repo.ownerNamespace}/${repo.slug}/${isPull ? "pulls" : "issues"}`;
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

/** The status-exact plain-text error (upstream ctx.HTTPError(status, msg)
 *  reduced — the HTML error page is chrome; the STATUS is the contract). */
function httpErrorText(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

/** The fabricated API context the delete emission reads (part one's
 *  apiContextFor bridge — authUser carries the doer projection, the real
 *  request URL keeps the emitter's origin). */
function apiContextFor(c: RouteContext, viewer: Viewer): ApiContext {
  const apiContext = new Context<ApiEnv>(c.req.raw, { env: c.env });
  if (viewer.kind === "user") {
    apiContext.set("authUser", { id: viewer.id, login: viewer.username, is_admin: viewer.isAdmin });
  }
  return apiContext;
}

// ---------------------------------------------------------------------------
// The POST handlers
// ---------------------------------------------------------------------------

/**
 * POST /{owner}/{repo}/{issues|pulls}/{index}/ref (upstream
 * repo.UpdateIssueRef, issue.go:302-321): the session gate + the group's
 * archived arm, then the in-handler 403 ladder (issues only — a PR row is
 * upstream's 403; poster-or-writer), then the FormTrim'd ref through the
 * landed changeIssueRef — success the canonical 303 (upstream's JSON {ref}
 * is the JS display swap).
 */
export async function issueRefSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveTimelineRepo(c);
  if (!resolved.ok) return resolved.response;
  const gate = timelineSessionGate(c, resolved, true);
  if ("response" in gate) return gate.response;
  const { respond, repo, viewer } = gate;

  const selected = await issueFromIndexParam(c, resolved);
  if ("response" in selected) return selected.response;
  const issue = selected.issue;

  if (issue.isPull || issue.posterId !== viewer.id && !(await canWriteRepo(c.env, repo, viewer))) {
    return respond(httpErrorText(403, issueTimelineLocale.permission_denied));
  }

  const form = parseIssueRefForm(await readUrlEncodedForm(c.req.raw));
  await applyIssueRefWrite(c.env.DB, issue, form, viewer.id, new Date());
  return respond(new Response(null, { status: 303, headers: { location: canonicalIssuePath(repo, issue) } }));
}

/** The dependency family's shared prologue: the session gate + archived
 *  arm, the {index} row, the in-handler CanCreateIssueDependencies gate
 *  (JSONError permission_denied → the re-render channel). */
async function dependencyGate(
  c: RouteContext,
  resolved: Extract<ResolvedRepo, { ok: true }>,
): Promise<{ gate: GatePassed; issue: IssueRow } | { response: Response }> {
  const gate = timelineSessionGate(c, resolved, true);
  if ("response" in gate) return gate;
  const { viewer } = gate;
  const selected = await issueFromIndexParam(c, resolved);
  if ("response" in selected) return selected;
  if (!(await canWriteRepo(c.env, resolved.repo, viewer))) {
    return { response: await reRenderDetailWithMessage(c, resolved, selected.issue, issueTimelineLocale.permission_denied) };
  }
  return { gate, issue: selected.issue };
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/{index}/dependency/add (upstream
 * repo.AddDependency, issue_dependency.go:14-83): the writer gate (the
 * re-render channel), then the GLOBAL dependency resolve (a missing id
 * the "Dependent issue does not exist." re-render), the cross-repo
 * refusal (the landed default: cross-repo dependencies disabled), the
 * self-dependency refusal, then the edge write with the duplicate/
 * circular messages — every refusal re-renders with upstream's exact
 * text, success the canonical 303.
 */
export async function dependencyAddSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveTimelineRepo(c);
  if (!resolved.ok) return resolved.response;
  const gated = await dependencyGate(c, resolved);
  if ("response" in gated) return gated.response;
  const { respond, repo } = resolved;
  const viewer = gated.gate.viewer;

  const form = parseDependencyAddForm(await readUrlEncodedForm(c.req.raw));
  const dependency = form === null ? null : await findIssueByIdGlobally(c.env.DB, form);
  if (dependency === null) {
    return reRenderDetailWithMessage(c, resolved, gated.issue, issueTimelineLocale.dep_not_exist_target);
  }
  if (dependency.repoId !== gated.issue.repoId) {
    return reRenderDetailWithMessage(c, resolved, gated.issue, issueTimelineLocale.dep_not_same_repo);
  }
  if (dependency.id === gated.issue.id) {
    return reRenderDetailWithMessage(c, resolved, gated.issue, issueTimelineLocale.dep_same_issue);
  }
  const result = await applyDependencyAddWrite(c.env.DB, viewer.id, gated.issue, dependency, new Date());
  if (result.outcome === "exists") {
    return reRenderDetailWithMessage(c, resolved, gated.issue, issueTimelineLocale.dep_exists);
  }
  if (result.outcome === "circular") {
    return reRenderDetailWithMessage(c, resolved, gated.issue, issueTimelineLocale.dep_circular);
  }
  return respond(new Response(null, { status: 303, headers: { location: canonicalIssuePath(repo, gated.issue) } }));
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/{index}/dependency/delete (upstream
 * repo.RemoveDependency, issue_dependency.go:85-152): the writer gate,
 * the dependencyType literal ("blockedBy"|"blocking" — anything else the
 * "invalid dependency type" re-render), the GLOBAL dependency resolve (a
 * missing id is upstream's ServerError — the plain-text 500), the
 * not-exists guard (the re-render), success the canonical 303.
 */
export async function dependencyRemoveSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveTimelineRepo(c);
  if (!resolved.ok) return resolved.response;
  const gated = await dependencyGate(c, resolved);
  if ("response" in gated) return gated.response;
  const { respond, repo } = resolved;
  const viewer = gated.gate.viewer;

  const form = parseDependencyRemoveForm(await readUrlEncodedForm(c.req.raw));
  if (form.dependencyType === "") {
    return reRenderDetailWithMessage(c, resolved, gated.issue, issueTimelineLocale.dep_invalid_type);
  }
  const dependency = form.dependencyId === null ? null : await findIssueByIdGlobally(c.env.DB, form.dependencyId);
  if (dependency === null) {
    // Upstream GetIssueByID ServerError (issue_dependency.go:120-123).
    return respond(httpErrorText(500, "GetIssueByID"));
  }
  const result = await applyDependencyRemoveWrite(c.env.DB, viewer.id, gated.issue, dependency, form.dependencyType, new Date());
  if (result.outcome === "not-exists") {
    return reRenderDetailWithMessage(c, resolved, gated.issue, issueTimelineLocale.dep_not_exist);
  }
  return respond(new Response(null, { status: 303, headers: { location: canonicalIssuePath(repo, gated.issue) } }));
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/{index}/times/add (upstream
 * repo.AddTimeManually, issue_timetrack.go:21-51): the session gate (the
 * default-settings CanUseTimetracker is true for every signed-in viewer —
 * the module header), the hours/minutes sum (total <= 0 the "No time was
 * entered." re-render), the landed AddTime port, the canonical 303.
 */
export async function timeAddSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveTimelineRepo(c);
  if (!resolved.ok) return resolved.response;
  const gate = timelineSessionGate(c, resolved, true);
  if ("response" in gate) return gate.response;
  const { respond, repo, viewer } = gate;

  const selected = await issueFromIndexParam(c, resolved);
  if ("response" in selected) return selected.response;
  const issue = selected.issue;

  const form = parseAddTimeForm(await readUrlEncodedForm(c.req.raw));
  const total = (form.hours ?? 0) * 3600 + (form.minutes ?? 0) * 60;
  if (form.hours === null || form.minutes === null || total <= 0) {
    return reRenderDetailWithMessage(c, resolved, issue, issueTimelineLocale.add_time_too_small);
  }
  await applyTimeAddWrite(c.env.DB, issue, viewer.id, total, new Date());
  return respond(new Response(null, { status: 303, headers: { location: canonicalIssuePath(repo, issue) } }));
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/{index}/times/{timeid}/delete
 * (upstream repo.DeleteTime, issue_timetrack.go:53-86): the session gate,
 * the (issue, timeid) live-row lookup (a miss the 404 shell — upstream's
 * NotFound), the owner-or-site-admin refusal (HTTPError 403 "not allowed"
 * — status-exact plain text), the SOFT delete with the owner-attributed
 * del_time_manual (26) comment, the canonical 303 (the success flash has
 * no landed channel — dropped).
 */
export async function timeDeleteSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveTimelineRepo(c);
  if (!resolved.ok) return resolved.response;
  const gate = timelineSessionGate(c, resolved, true);
  if ("response" in gate) return gate.response;
  const { ctx, respond, repo, viewer } = gate;

  const selected = await issueFromIndexParam(c, resolved);
  if ("response" in selected) return selected.response;
  const issue = selected.issue;

  const raw = c.req.param("timeid") ?? "";
  const timeId = /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0;
  const entry = await trackedTimeOf(c.env.DB, issue.id, timeId);
  if (entry === null) return respond(c.html(renderNotFound(ctx), 404));
  if (!viewer.isAdmin && entry.userId !== viewer.id) {
    return respond(httpErrorText(403, issueTimelineLocale.not_allowed));
  }
  await applyTimeDeleteWrite(c.env.DB, issue, entry, new Date());
  return respond(new Response(null, { status: 303, headers: { location: canonicalIssuePath(repo, issue) } }));
}

/** The stopwatch trio's shared prologue (the session gate + archived arm +
 *  the {index} row). */
async function stopwatchGate(
  c: RouteContext,
  resolved: Extract<ResolvedRepo, { ok: true }>,
): Promise<{ gate: GatePassed; issue: IssueRow } | { response: Response }> {
  const gate = timelineSessionGate(c, resolved, true);
  if ("response" in gate) return gate;
  const selected = await issueFromIndexParam(c, resolved);
  if ("response" in selected) return selected;
  return { gate, issue: selected.issue };
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/{index}/times/stopwatch/start
 * (upstream repo.IssueStartStopwatch, issue_stopwatch.go:13-35): the
 * CreateIssueStopwatch port — a re-start here stays 303 (upstream's
 * "already exists" flash is dropped); a start while another issue's runs
 * banks that one first. Success the canonical 303.
 */
export async function stopwatchStartSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveTimelineRepo(c);
  if (!resolved.ok) return resolved.response;
  const gated = await stopwatchGate(c, resolved);
  if ("response" in gated) return gated.response;
  const { respond, repo } = resolved;
  await applyStopwatchStartWrite(c.env.DB, gated.issue, gated.gate.viewer.id, new Date());
  return respond(new Response(null, { status: 303, headers: { location: canonicalIssuePath(repo, gated.issue) } }));
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/{index}/times/stopwatch/stop
 * (upstream repo.IssueStopStopwatch, issue_stopwatch.go:37-58): the
 * finish arm banks the elapsed time; a non-running stop is upstream's
 * ok=false arm — still the 303 (JSONRedirect answers regardless).
 */
export async function stopwatchStopSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveTimelineRepo(c);
  if (!resolved.ok) return resolved.response;
  const gated = await stopwatchGate(c, resolved);
  if ("response" in gated) return gated.response;
  const { respond, repo } = resolved;
  await applyStopwatchStopWrite(c.env.DB, gated.issue, gated.gate.viewer.id, new Date());
  return respond(new Response(null, { status: 303, headers: { location: canonicalIssuePath(repo, gated.issue) } }));
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/{index}/times/stopwatch/cancel
 * (upstream repo.CancelStopwatch, issue_stopwatch.go:60-78): discard the
 * stopwatch WITHOUT banking the time (the cancel_tracking (15) comment);
 * a non-running cancel is the silent no-op, still the 303.
 */
export async function stopwatchCancelSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveTimelineRepo(c);
  if (!resolved.ok) return resolved.response;
  const gated = await stopwatchGate(c, resolved);
  if ("response" in gated) return gated.response;
  const { respond, repo } = resolved;
  await applyStopwatchCancelWrite(c.env.DB, gated.issue, gated.gate.viewer.id, new Date());
  return respond(new Response(null, { status: 303, headers: { location: canonicalIssuePath(repo, gated.issue) } }));
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/{index}/time_estimate (upstream
 * repo.UpdateIssueTimeEstimate, issue_timetrack.go:88-118): the session
 * gate, the poster-or-writer 403 (status-exact plain text), the
 * TimeEstimateParse chain (invalid the "Time estimate format is invalid"
 * re-render; empty = 0 — a valid clear), the unchanged no-op, then the
 * landed ChangeIssueTimeEstimate port (the change_time_estimate (38)
 * comment with the decimal seconds), the canonical 303.
 */
export async function timeEstimateSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveTimelineRepo(c);
  if (!resolved.ok) return resolved.response;
  const gate = timelineSessionGate(c, resolved, true);
  if ("response" in gate) return gate.response;
  const { respond, repo, viewer } = gate;

  const selected = await issueFromIndexParam(c, resolved);
  if ("response" in selected) return selected.response;
  const issue = selected.issue;

  if (issue.posterId !== viewer.id && !(await canWriteRepo(c.env, repo, viewer))) {
    return respond(httpErrorText(403, issueTimelineLocale.permission_denied));
  }

  const form = await readUrlEncodedForm(c.req.raw);
  const seconds = parseTimeEstimateForm(form.get("time_estimate") ?? "");
  if (seconds === null) {
    return reRenderDetailWithMessage(c, resolved, issue, issueTimelineLocale.estimate_invalid);
  }
  if (issue.timeEstimate !== seconds) {
    await applyTimeEstimateWrite(c.env.DB, issue, seconds, viewer.id, new Date());
  }
  return respond(new Response(null, { status: 303, headers: { location: canonicalIssuePath(repo, issue) } }));
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/{index}/reactions/{action} (upstream
 * repo.ChangeIssueReaction, issue.go:488-547): the session gate + the
 * archived arm, the locked-issue writer arm (canSelfChangeOrAccessContent
 * — the 403 status-exact), then react|unreact|404 with the allow-list and
 * blocked-user 500s (status-exact plain text), success the canonical 303
 * (upstream's {html} bar swap).
 */
export async function issueReactionSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveTimelineRepo(c);
  if (!resolved.ok) return resolved.response;
  const gate = timelineSessionGate(c, resolved, true);
  if ("response" in gate) return gate.response;
  const { ctx, respond, repo, viewer } = gate;

  const selected = await issueFromIndexParam(c, resolved);
  if ("response" in selected) return selected.response;
  const issue = selected.issue;

  const action = c.req.param("action") ?? "";
  if (action !== "react" && action !== "unreact") return respond(c.html(renderNotFound(ctx), 404));
  const content = parseReactionForm(await readUrlEncodedForm(c.req.raw));
  if (content === null) return respond(httpErrorText(400, issueTimelineLocale.content_required));
  if (issue.isLocked && !(await canWriteRepo(c.env, repo, viewer))) {
    return respond(httpErrorText(403, issueTimelineLocale.permission_denied));
  }

  const result = await applyReactionWrite(
    c.env.DB,
    { issueId: issue.id, commentId: 0 },
    action,
    content,
    { id: viewer.id, isAdmin: viewer.isAdmin },
    [issue.posterId ?? 0, resolved.repo.ownerId ?? 0].filter((id) => id !== 0),
    new Date(),
  );
  if (result.outcome !== "applied") {
    // Upstream's ServerError arms (blocked user / forbidden reaction) —
    // the plain-text 500 posture, the error NAME as the body.
    return respond(httpErrorText(500, "ChangeIssueReaction"));
  }
  return respond(new Response(null, { status: 303, headers: { location: canonicalIssuePath(repo, issue) } }));
}

/** The /comments/{id} trio's shared prologue: the session gate (NO
 *  archived arm — upstream's group carries only the reader middleware),
 *  the repo-scoped comment lookup (a miss the 404 shell — upstream's
 *  GetCommentWithRepoID ServerError reduced by the repo-scoped-lookup
 *  rule), then the content gate (accessMode per caller + HasContentSupport
 *  — the 400 status-exact). */
async function commentGate(
  c: RouteContext,
  resolved: Extract<ResolvedRepo, { ok: true }>,
  accessMode: "read" | "write",
): Promise<{ gate: GatePassed; comment: CommentRow; issue: IssueRow } | { response: Response }> {
  const gate = timelineSessionGate(c, resolved, false);
  if ("response" in gate) return gate;
  const { ctx, respond, repo, viewer } = gate;
  const raw = c.req.param("id") ?? "";
  if (!/^\d+$/.test(raw)) return { response: respond(c.html(renderNotFound(ctx), 404)) };
  const found = await findRepoCommentById(c.env.DB, repo.id, Number.parseInt(raw, 10));
  if (found === null) return { response: respond(c.html(renderNotFound(ctx), 404)) };
  if (!commentHasContentSupport(found.comment.type)) {
    return { response: respond(httpErrorText(400, "comment does not support content")) };
  }
  // canSelfChangeOrAccessContent (services/issue/issue.go:322-337) reduced:
  // the repo resolution proved read access; the self-change arm accepts
  // the content's poster; accessMode=WRITE needs a repo writer.
  const allowed =
    found.comment.posterId === viewer.id ||
    (accessMode === "read" ? true : await canWriteRepo(c.env, repo, viewer));
  if (!allowed) return { response: respond(httpErrorText(403, issueTimelineLocale.permission_denied)) };
  // The locked-issue arm — a writer for everyone (the same service line).
  if (found.issue.isLocked && !(await canWriteRepo(c.env, repo, viewer))) {
    return { response: respond(httpErrorText(403, issueTimelineLocale.permission_denied)) };
  }
  return { gate, comment: found.comment, issue: found.issue };
}

/**
 * POST /{owner}/{repo}/comments/{id} (upstream repo.UpdateCommentContent,
 * issue_comment.go:179-241): the write-access content gate, the STRICT
 * content_version CAS refusal ("Unable to save changes..." — the
 * re-render channel, upstream's exact first arm), the unchanged-content
 * skip, the landed updateCommentBody (the content-history hook), the
 * canonical 303 of the COMMENT'S issue (the success JSON is the JS swap;
 * the attachments half is not carried by the no-JS form — the module
 * header).
 */
export async function commentUpdateSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveTimelineRepo(c);
  if (!resolved.ok) return resolved.response;
  const gated = await commentGate(c, resolved, "write");
  if ("response" in gated) return gated.response;
  const { respond, repo } = resolved;
  const { gate, comment, issue } = gated;

  const form = parseCommentUpdateForm(await readUrlEncodedForm(c.req.raw));
  if (form.contentVersion !== comment.contentVersion) {
    return reRenderDetailWithMessage(c, resolved, issue, issueTimelineLocale.comment_already_changed);
  }
  await applyCommentUpdateWrite(c.env.DB, comment, form.content, gate.viewer.id, new Date());
  return respond(new Response(null, { status: 303, headers: { location: canonicalIssuePath(repo, issue) } }));
}

/**
 * POST /{owner}/{repo}/comments/{id}/delete (upstream repo.DeleteComment,
 * issue_comment.go:243-256): the write-access content gate, the landed
 * deleteComment (unlink + the num_comments decrement + the history
 * hard-delete), the canonical 303 of the comment's issue (upstream's
 * Status(200) is the JS node removal this replaces).
 */
export async function commentDeleteSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveTimelineRepo(c);
  if (!resolved.ok) return resolved.response;
  const gated = await commentGate(c, resolved, "write");
  if ("response" in gated) return gated.response;
  const { respond, repo } = resolved;
  await deleteComment(c.env.DB, gated.comment, new Date());
  return respond(new Response(null, { status: 303, headers: { location: canonicalIssuePath(repo, gated.issue) } }));
}

/**
 * POST /{owner}/{repo}/comments/{id}/reactions/{action} (upstream
 * repo.ChangeCommentReaction, issue_comment.go:258+): the read-access
 * content gate, then the same reaction ladder as the issue surface with
 * the comment-poster blocker added (upstream IsUserBlockedBy's third
 * arm), success the canonical 303 of the comment's issue.
 */
export async function commentReactionSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveTimelineRepo(c);
  if (!resolved.ok) return resolved.response;
  const gated = await commentGate(c, resolved, "read");
  if ("response" in gated) return gated.response;
  const { respond, repo } = resolved;
  const { gate, comment, issue } = gated;
  const viewer = gate.viewer;

  const action = c.req.param("action") ?? "";
  if (action !== "react" && action !== "unreact") return respond(c.html(renderNotFound(resolved.ctx), 404));
  const content = parseReactionForm(await readUrlEncodedForm(c.req.raw));
  if (content === null) return respond(httpErrorText(400, issueTimelineLocale.content_required));

  const result = await applyReactionWrite(
    c.env.DB,
    { issueId: issue.id, commentId: comment.id },
    action,
    content,
    { id: viewer.id, isAdmin: viewer.isAdmin },
    [issue.posterId ?? 0, resolved.repo.ownerId ?? 0, comment.posterId ?? 0].filter((id) => id !== 0),
    new Date(),
  );
  if (result.outcome !== "applied") {
    return respond(httpErrorText(500, "ChangeCommentReaction"));
  }
  return respond(new Response(null, { status: 303, headers: { location: canonicalIssuePath(repo, issue) } }));
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/{index}/delete (upstream
 * repo.DeleteIssue, issue_new.go:207-227): the admin gate, then the
 * landed deleteIssueCascade WITH the webhook emission (the fabricated
 * ApiContext bridge), the 303 onto the repo's family LIST (upstream's
 * literal redirect).
 */
export async function issueDeleteSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveTimelineRepo(c);
  if (!resolved.ok) return resolved.response;
  const gate = await timelineAdminGate(c, resolved);
  if ("response" in gate) return gate.response;
  const { respond, repo, viewer } = gate;

  const selected = await issueFromIndexParam(c, resolved);
  if ("response" in selected) return selected.response;
  const issue = selected.issue;

  await applyIssueDeleteWrite(apiContextFor(c, viewer), issue);
  return respond(new Response(null, { status: 303, headers: { location: familyListPath(repo, issue.isPull) } }));
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/delete (upstream
 * repo.BatchDeleteIssues, issue_list.go:311-321): the admin gate, the
 * `issue_ids` set (a non-integer piece upstream's ServerError — the
 * plain-text 500), each row resolved (a missing/foreign id
 * getActionIssues' NotFound — the 404 shell), then the cascade+emission
 * loop, the 303 onto the addressed family's list (upstream JSONOK — the
 * list reload this replaces).
 */
export async function batchDeleteIssuesSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveTimelineRepo(c);
  if (!resolved.ok) return resolved.response;
  const gate = await timelineAdminGate(c, resolved);
  if ("response" in gate) return gate.response;
  const { ctx, respond, repo, viewer } = gate;

  const form = await readUrlEncodedForm(c.req.raw);
  const raw = form.getAll("issue_ids").join(",");
  for (const piece of raw.split(",")) {
    if (piece.trim() !== "" && !/^\d+$/.test(piece.trim())) {
      // Upstream getActionIssues' ParseInt ServerError.
      return respond(httpErrorText(500, "ParseInt"));
    }
  }
  const ids = parseBatchDeleteForm(form);
  for (const id of ids) {
    const issue = await findIssueByIdGlobally(c.env.DB, id);
    if (issue === null || issue.repoId !== repo.id) {
      // getActionIssues' NotFound arms (missing + foreign RepoID).
      return respond(c.html(renderNotFound(ctx), 404));
    }
  }
  for (const id of ids) {
    const issue = await findIssueByIdGlobally(c.env.DB, id);
    if (issue !== null) {
      await applyIssueDeleteWrite(apiContextFor(c, viewer), issue);
    }
  }
  // Upstream answers JSONOK (the list JS reloads); the no-JS 303 lands on
  // the ADDRESSED family's list (the /pulls/delete literal or the issues
  // twin).
  const family = new URL(c.req.url).pathname.includes("/pulls/delete") ? "pulls" : "issues";
  return respond(new Response(null, { status: 303, headers: { location: `/${repo.ownerNamespace}/${repo.slug}/${family}` } }));
}

/**
 * POST /{owner}/{repo}/{issues|pulls}/projects/column (upstream
 * repo.UpdateIssueProjectColumn, projects.go:484-510): the writer gate,
 * the repo-scoped `issue_id` index (a miss the 404 shell), the GLOBAL
 * column id (a miss the plain-text 500), the membership-contains guard
 * (a miss the 404 shell), the landed moveIssueToColumn (the
 * project-column (31) comment), the canonical 303 of the moved issue.
 * No detail-page UI drives it (the board's card menus own the surface —
 * the module header).
 */
export async function projectColumnMoveSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveTimelineRepo(c);
  if (!resolved.ok) return resolved.response;
  const gate = await timelineWriterGate(c, resolved);
  if ("response" in gate) return gate.response;
  const { ctx, respond, repo, viewer } = gate;

  const form = parseProjectColumnMoveForm(await readUrlEncodedForm(c.req.raw));
  const issue = form.issueIndex === null ? null : await new IssuesService(c.env.DB).getIssueByIndex(repo.id, form.issueIndex);
  if (issue === null) return respond(c.html(renderNotFound(ctx), 404));
  if (form.columnId === null) return respond(httpErrorText(500, "GetColumn"));
  const result = await applyProjectColumnMoveWrite(c.env.DB, issue, form.columnId, viewer.id, new Date());
  if (result.outcome === "missing-column") return respond(httpErrorText(500, "GetColumn"));
  if (result.outcome === "not-in-project") return respond(c.html(renderNotFound(ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: canonicalIssuePath(repo, issue) } }));
}

// ---------------------------------------------------------------------------
// The fold-time router (the recipe step 4 assembled — the direct-test
// harness's subject AND a mount-ready sub-app)
// ---------------------------------------------------------------------------

/** chi's 405 (the part-one methodNotAllowedTail twin). */
function methodNotAllowedTail(allow: string): Response {
  return new Response(null, { status: 405, headers: { allow } });
}

/** All sixteen write families on one sub-app, registered exactly as the
 *  recipe's step 4 (the static repo-scope literals first, then the
 *  {index} writes, then the /comments/:id trio; every POST carries its
 *  GET 405 twin; both URL families). */
export function createIssueTimelineWritesRouter(): Hono<{ Bindings: Env }> {
  const router = new Hono<{ Bindings: Env }>();
  const families: Array<"issues" | "pulls"> = ["issues", "pulls"];
  for (const family of families) {
    // The static repo-scope literals (static-before-dynamic, the wave-9 rule).
    router.post(`/:owner/:repo/${family}/delete`, (c) => batchDeleteIssuesSubmit(c));
    router.get(`/:owner/:repo/${family}/delete`, () => methodNotAllowedTail("POST"));
    router.post(`/:owner/:repo/${family}/projects/column`, (c) => projectColumnMoveSubmit(c));
    router.get(`/:owner/:repo/${family}/projects/column`, () => methodNotAllowedTail("POST"));
    // The {index}-bearing writes.
    router.post(`/:owner/:repo/${family}/:index/ref`, (c) => issueRefSubmit(c));
    router.get(`/:owner/:repo/${family}/:index/ref`, () => methodNotAllowedTail("POST"));
    router.post(`/:owner/:repo/${family}/:index/dependency/add`, (c) => dependencyAddSubmit(c));
    router.get(`/:owner/:repo/${family}/:index/dependency/add`, () => methodNotAllowedTail("POST"));
    router.post(`/:owner/:repo/${family}/:index/dependency/delete`, (c) => dependencyRemoveSubmit(c));
    router.get(`/:owner/:repo/${family}/:index/dependency/delete`, () => methodNotAllowedTail("POST"));
    router.post(`/:owner/:repo/${family}/:index/times/add`, (c) => timeAddSubmit(c));
    router.get(`/:owner/:repo/${family}/:index/times/add`, () => methodNotAllowedTail("POST"));
    router.post(`/:owner/:repo/${family}/:index/times/:timeid/delete`, (c) => timeDeleteSubmit(c));
    router.get(`/:owner/:repo/${family}/:index/times/:timeid/delete`, () => methodNotAllowedTail("POST"));
    router.post(`/:owner/:repo/${family}/:index/times/stopwatch/start`, (c) => stopwatchStartSubmit(c));
    router.get(`/:owner/:repo/${family}/:index/times/stopwatch/start`, () => methodNotAllowedTail("POST"));
    router.post(`/:owner/:repo/${family}/:index/times/stopwatch/stop`, (c) => stopwatchStopSubmit(c));
    router.get(`/:owner/:repo/${family}/:index/times/stopwatch/stop`, () => methodNotAllowedTail("POST"));
    router.post(`/:owner/:repo/${family}/:index/times/stopwatch/cancel`, (c) => stopwatchCancelSubmit(c));
    router.get(`/:owner/:repo/${family}/:index/times/stopwatch/cancel`, () => methodNotAllowedTail("POST"));
    router.post(`/:owner/:repo/${family}/:index/time_estimate`, (c) => timeEstimateSubmit(c));
    router.get(`/:owner/:repo/${family}/:index/time_estimate`, () => methodNotAllowedTail("POST"));
    router.post(`/:owner/:repo/${family}/:index/reactions/:action`, (c) => issueReactionSubmit(c));
    router.get(`/:owner/:repo/${family}/:index/reactions/:action`, () => methodNotAllowedTail("POST"));
    router.post(`/:owner/:repo/${family}/:index/delete`, (c) => issueDeleteSubmit(c));
    router.get(`/:owner/:repo/${family}/:index/delete`, () => methodNotAllowedTail("POST"));
  }
  // The /comments/:id trio (repo-scoped; the landed attachments GET on the
  // same prefix stays untouched).
  router.post("/:owner/:repo/comments/:id", (c) => commentUpdateSubmit(c));
  router.get("/:owner/:repo/comments/:id", () => methodNotAllowedTail("POST"));
  router.post("/:owner/:repo/comments/:id/delete", (c) => commentDeleteSubmit(c));
  router.get("/:owner/:repo/comments/:id/delete", () => methodNotAllowedTail("POST"));
  router.post("/:owner/:repo/comments/:id/reactions/:action", (c) => commentReactionSubmit(c));
  router.get("/:owner/:repo/comments/:id/reactions/:action", () => methodNotAllowedTail("POST"));
  return router;
}
