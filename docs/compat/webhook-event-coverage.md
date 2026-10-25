# Webhook Event Coverage Audit — upstream pin vs. emitted

Audit refreshed 2026-10-25 (first edition 2026-10-24). Emission set current through `7242825`
(release + label + status `705eb9c`; repository/fork/pull_request_sync `308fa21`; API branch/tag
create/delete `c16f1e5`; comment edit/delete + tag push pairs + branch rename pair `1ea2b12`;
milestone + assign events `812f999`/`7242825` — the wave that was in-flight when this refresh
started landed mid-audit, so its rows are marked EMITTED, not "in-flight"). Upstream pin: `gitea`
submodule at `fc4936884584a41931906553d96c2601d750e6ef` (v1.22.0-rc1-3919-gfc49368845) — unchanged
since the first edition; every upstream and worker citation below was re-verified in-tree at HEAD.

- **Canonical upstream list**: `HookEventType` enum, `gitea/modules/webhook/type.go:10-48`; the
  wire-relevant set is `AllEvents()` (26 types, `type.go:50-77` — it includes `workflow_run`/
  `workflow_job`; only `schedule` is outside, `type.go:44`) — the `pull_request_review` group
  pseudo-type (`type.go:47`) is subscription vocabulary, not a wire event. Payload shapes:
  `gitea/modules/structs/hook.go` (struct lines cited per row).
- **Our side**: `HookEventType` union + `webhookHasEvent` (`apps/worker/src/issues/webhooks.ts:25-49`,
  `:95-100`); fan-out `emitWebhookDeliveries` (`webhooks.ts:177`). Since the first edition the emit
  call sites are consolidated behind three family seams: `emitIssueEvent`
  (`apps/worker/src/services/issue-events.ts:113`; the UI new-issue path rides it too, `:237`),
  `emitRepoEvent`/`emitRepoEventInline` (`apps/worker/src/services/repo-events.ts:118`/`:152`,
  fan-out `:93`→`emitWebhookDeliveries:100`), and `emitPushFamilyUpdates`
  (`apps/worker/src/services/webhooks-push.ts:234`).
- **Status vocabulary**: EMITTED (real events, all reachable trigger paths) / EMITTED-PARTIAL
  (emitted from a subset of upstream's trigger paths or actions) / NOT-EMITTED (the feature exists,
  only the webhook is missing) / N/A (the triggering feature itself does not exist yet).
- **Citation drift warning**: worker line numbers below are pinned at HEAD `7242825`. This audit
  watched issues.ts shift twice under it while sibling waves landed; re-verify with grep before
  trusting any line on a hot file.
- Note: upstream has **no `tag_push` type** (that name is Gogs/GitLab vocabulary) — tag pushes
  arrive as `push` + `create`/`delete` on `refs/tags/*`, which our push-family builder and (since
  `c16f1e5`/`1ea2b12`) our API tag routes both produce.

## Audit table

| Event type | Upstream emission (all `gitea/services/webhook/notifier.go` unless noted) | Payload shape | Our status | Evidence / remaining seam | Prio |
|---|---|---|---|---|---|
| `push` | PushCommits:660→:668 (user push — `services/repository/push.go:194` branch arm, `:105`/`:127` tag zero-commit arms); zero-commit push on ref create rides CreateRef:821→:824 (`push.go:127-136`, `:274`); SyncPushCommits:901→:909 (mirror, `services/mirror/mirror_pull.go:347`, `:379`) | PushPayload (`structs/hook.go:349`) | **EMITTED** — `services/webhooks-push.ts:234` (`emitPushFamilyUpdates`): updated-ref push `:391`, zero-commit on create `:286`; wired from the engine `onPush` seam (`src/index.ts:42` → `handleUserPushEvent:570`, notifications `:522`→`:546`); mirror delegates to the same builder (`services/mirror/sync.ts:390`); manual test-fire also sends `push` (`api/routes/hooks.ts:326` → `api/services/hooks.ts:643`) | landed; tests: `webhooks-push.test.ts`, `mirror/sync.test.ts`, `engine-read.test.ts:730` | P1 |
| `create` | CreateRef:821→:824 — push path `services/repository/push.go:136` (tag) / `:274` (branch); API branch create `services/repository/branch.go:493`; API tag create `services/release/release.go:136-143` (zero-commit PushCommits :136, then CreateRef :143); mirror SyncCreateRef:960 (delegates; `mirror_pull.go:352`) | CreatePayload (`hook.go:206`) | **EMITTED** (was EMITTED-PARTIAL, closed `c16f1e5`/`1ea2b12`) — push family `webhooks-push.ts:287-297` (push→create pair); API branch POST `api/routes/branches.ts:338`; API tag POST `api/routes/tags.ts:399` (zero-commit push) + `:406`; branch-rename pair `branches.ts:633`/`:646` (delete→create, upstream's order); mirror `sync.ts:390` | tests: `engine-read.test.ts:650` (branch create), `:761` (tag push+create order), `webhooks-push.test.ts` | P1 |
| `delete` | DeleteRef:858→:861 — push path `push.go:114` (tag) / `:306` (branch); API branch delete rides the same notifier; API tag delete `release.go:396-403` (PushCommits :396, then DeleteRef :403); mirror SyncDeleteRef:964 (`mirror_pull.go:358`) | DeletePayload (`hook.go:253`) | **EMITTED** (was EMITTED-PARTIAL, closed `c16f1e5`/`1ea2b12`) — push family `webhooks-push.ts:303-310`; API branch DELETE `branches.ts:526`; API tag DELETE `tags.ts:528` (push) + `:534`; rename delete arm `branches.ts:633`; mirror `sync.ts:390` | tests: `engine-read.test.ts:675`, `:719`, `:802` (tag push+delete order) | P1 |
| `fork` | ForkRepository:86→:91 (EventSource = the SOURCE repo) | ForkPayload (`hook.go:272`) | **EMITTED** (was NOT-EMITTED, closed `308fa21`) — `src/repos/fork-task.ts:160` (`emitRepoEventInline` + `forkEventPayload`, forkee = source per the notifier) through `services/repo-events.ts:152`/`:100` | emission site verified; no dedicated delivery assertion yet (`fork-dispatch.test.ts` covers only the dispatch/ack) | P2 |
| `issues` | NewIssue:291→:302; IssueChangeStatus:249→:284; IssueChangeTitle:209→:230; IssueChangeContent:376→:402; DeleteIssue:313→:338 (`action=deleted`; models-layer only — upstream v1 has no DELETE issue route) | IssuePayload (`hook.go:435`) | **EMITTED** — `api/routes/issues.ts`: opened `:968`, closed-when-`form.closed` `:975` (the NewIssue→Close order), title edited `:1151` (`changes.title.from`), body edited `:1170` (`changes.body.from`), closed `:1233`, reopened `:1246` — all through `emitIssueEvent`; the UI new-issue write emits opened too (`services/issue-events.ts:237`); issue deletion doesn't exist on either API surface | landed (issues write routes); tests: `api/issues.test.ts`, `services/issue-events.test.ts` | P1 |
| `issue_assign` | IssueChangeAssignee:161→:202 | IssuePayload | **EMITTED** (closed `812f999`; was N/A at the first edition — the assignee feature landed in between) — `api/routes/issue-tables-t2.ts` `emitAssignEvent:892` (issue arm `:928`): one `assigned`/`unassigned` event per actually-changed assignee (`changes.added_assignees`/`changes.removed_assignees`), POST `:1304` / DELETE `:1325` of `…/issues/{index}/assignees`. Documented deviation: PATCH `form.assignee(s)` still ignores the field (`issues.ts:1221`) — upstream's PATCH arm notifies too, ours has no PATCH-assignee feature | tests: `issue-tables-t2.test.ts` | P2 |
| `issue_label` | IssueChangeLabels:572→:605; IssueClearLabels:46→:73 | IssuePayload | **EMITTED** (closed `705eb9c`) — `issues.ts` `emitLabelEvent:353`: attach `:1361` / replace `:1394` (`label_updated`), clear `:1422` (`label_cleared`); detach via `api/routes/issue-write-t2.ts:303` (emit `:329`, called `:580`) | tests: `api/issues.test.ts`, `issue-write-t2.test.ts` | P2 |
| `issue_milestone` | IssueChangeMilestone:618→:647 | IssuePayload | **EMITTED** (closed `812f999`) — `issues.ts` `emitMilestoneEvent:397` (issue arm `:426`): PATCH milestone arm emits `:1217`, `milestoned`/`demilestoned` on actual change only, no `changes` block (upstream sets none) | tests: `api/issues.test.ts` | P2 |
| `issue_comment` | CreateIssueComment:463→:480 (pick `:466-476`); UpdateComment:420→:445 (pick `:435-441`; `changes.body.from`); DeleteComment:493→:521 (pick `:511-517`; no `changes`) — arrows corrected ±this audit (first edition said :476/:517) | IssueCommentPayload (`hook.go:297`) | **EMITTED — full triple** (was `created` only; edit/delete closed `1ea2b12`) — `issues.ts`: created `:1303` (pick `:1301`), edited `:1060` (`changes.body.from`), deleted `:1099` (no `changes`); shared helper `emitCommentEvent:318`, IsPull discriminant `:330` | landed; tests: `api/issues.test.ts` | P2 |
| `pull_request` | NewPullRequest:350→:365; IssueChangeStatus:249→:270; IssueChangeTitle:209→:217; IssueChangeContent:376→:389; AutoMergePullRequest:684→:721 (unreachable here — see status); PullRequestChangeTargetBranch:726→:735 (feature absent); DeleteIssue PR arm:313→:320 | PullRequestPayload (`hook.go:484`) | **EMITTED** — `api/routes/pulls.ts` `emitPullWebhook:309` (→ `emitWebhookDeliveries:321`): opened `:698`, title edited `:766`, body edited `:790`, milestone `:841`, closed `:869`, reopened `:888`, merged→closed with `commit_id` `:1135`. Upstream's auto-merge arm has no reachable trigger on our side — the backend never schedules a merge (POST …/merge refuses `merge_when_checks_succeed` with the declared 409; `pull-automerge.ts` only mirrors the cancel route's not-scheduled 404), so the first edition's "auto-merge gap" is feature-absence, not a silent path | landed; tests: `api/pulls.test.ts` | P1 |
| `pull_request_assign` | IssueChangeAssignee:161→:187 | PullRequestPayload | **EMITTED** (closed `812f999`; was N/A at the first edition) — same `emitAssignEvent` as `issue_assign` (PR arm `:912`, the IsPull discriminant), POST/DELETE of the shared assignees routes | tests: `issue-tables-t2.test.ts`; same PATCH-assignee deviation as `issue_assign` (`pulls.ts:821`) | P2 |
| `pull_request_label` | IssueChangeLabels:572→:597; IssueClearLabels:46→:65 | PullRequestPayload | **EMITTED** (closed `705eb9c`) — `issues.ts` pull arm `:365-:368`; detach `issue-write-t2.ts:314` | tests: `api/issues.test.ts`, `issue-write-t2.test.ts` | P2 |
| `pull_request_milestone` | IssueChangeMilestone:618→:639 | PullRequestPayload | **EMITTED** (closed `812f999`/`7242825`) — `pulls.ts` PATCH milestone arm emits `:841` through the shared `emitMilestoneEvent` (exported from `routes/issues.ts:397`, PR arm `:412`), same `milestoned`/`demilestoned` discriminant | tests: `api/pulls.test.ts` | P2 |
| `pull_request_comment` | event picks: created :469 (CreateIssueComment), edited :438 (UpdateComment), deleted :514 (DeleteComment) — first edition had created/edited swapped | IssueCommentPayload | **EMITTED — full triple** (was `created` only; closed `1ea2b12`) — the same emissions as `issue_comment`, discriminated at `issues.ts:330` (created `:1303`, edited `:1060`, deleted `:1099`) | landed; tests: `api/issues.test.ts` | P2 |
| `pull_request_review_approved` | PullRequestReview:751 (pick `:756`, PrepareWebhooks `:777`) | PullRequestPayload (+ReviewPayload `hook.go:515`) | **N/A** — no PR-review routes exist anywhere in `src/api/routes/` (re-verified this audit) | the future PR-review routes wave (subscription flag already modeled: `webhooks.ts` HookEventConfig `pull_request_review`) | P2 |
| `pull_request_review_rejected` | PullRequestReview:751 (pick `:760`) | PullRequestPayload | **N/A** — same | same | P2 |
| `pull_request_review_comment` | PullRequestReview:751 (pick `:758`) | PullRequestPayload | **N/A** — same | same | P2 |
| `pull_request_sync` | PullRequestSynchronized:835→:845 (fired by the push that updates a PR head branch; EventSource = the PR's BASE repo) | PullRequestPayload | **EMITTED** (was NOT-EMITTED, closed `308fa21`) — `webhooks-push.ts` `emitPullRequestSyncs:430`, emit `:479-489` (action `synchronized`, before/after oids, base-repo routing for fork heads, open github-flow PRs whose head is the pushed branch), invoked `:393-395` on branch updates inside `emitPushFamilyUpdates`; rides both trigger paths (`:546` user push, `mirror/sync.ts:390` mirror) | landed; tests: `webhooks-push.test.ts:800-831` | P2 |
| `pull_request_review_request` | PullRequestReviewRequest:793→:815 | PullRequestPayload | **N/A** — no review-request feature | PR-review wave | P2 |
| `wiki` | NewWikiPage:534→:536; EditWikiPage:547→:549; DeleteWikiPage:560→:562 (callers `routers/web/repo/wiki.go:683` etc.) | WikiPayload (`hook.go:535`) | **N/A** — no wiki feature (no wiki routes in `src/api/routes/`) | the future wiki wave (routes own the seam) | P2 |
| `repository` | CreateRepository:114→:116; DeleteRepository:126→:127; RenameRepository:137→:138; MigrateRepository:149→:151 (fork case: :103) | RepositoryPayload (`hook.go:566`) | **EMITTED-PARTIAL** (was NOT-EMITTED; create/rename/delete closed `308fa21`/`9e23010`) — `services/repo-events.ts` (`emitRepoEvent:118`, `emitRepoEventInline:152`): created `api/routes/user-repos.ts:209` + `api/routes/org-repos.ts:225` + push-create settle `src/git-http/gate.ts:621`; renamed `api/routes/repo.ts:439` (`changes.name.from`); deleted `repo.ts:535`. Partial because the migrate route (`api/routes/imports.ts`) landed and emits nothing (0 emit calls); transfer stays silent upstream-faithfully (NullNotifier no-op, documented in the repo-events header) | tests: `api/repo-edit.test.ts:288`/`:376`, `git-http/gate.test.ts:540-580`; remaining seam: one `emitRepoEvent` in the migrate-completion path | P2 |
| `release` | sendReleaseHook:872→:879 (shared; NewRelease:889, UpdateRelease:893, DeleteRelease:897; callers `services/release/release.go:198`, `:363`, `:366`, `:437`) | ReleasePayload (`hook.go:332`) | **EMITTED** (was NOT-EMITTED, closed `705eb9c`) — `api/routes/releases.ts` `emitReleaseWebhook:191` (→ `:203`), `emitReleaseEvent:236` with the drafts-stay-silent guard `:241`: published `:459` (POST create), updated / draft→published flip `:545` (PATCH), deleted `:499` (by-tag) / `:558` (by-id) | landed; tests: `api/releases.test.ts` (`:464` published shape, `:488` ["updated","published"], `:527` ["deleted","deleted"]) | P1 |
| `package` | PackageCreate:968 / PackageDelete:972 → shared notifyPackage:976→:993 (callers `routers/api/packages/container/manifest.go:95` and the debian/rpm/conan registries) | PackagePayload (`hook.go:595`) | **N/A** — no package-registry feature | the future package-registry wave | P2 |
| `status` | CreateCommitStatus:925→:955 (caller `services/repository/commitstatus/commitstatus.go:104`) | CommitStatusPayload (`hook.go:647`) | **EMITTED** (was NOT-EMITTED, closed `705eb9c`) — `api/routes/statuses.ts:327` | landed; tests: `api/statuses.test.ts` | P2 |
| `schedule` (Actions-only, not in AllEvents) | `services/actions/notifier_helper.go:84` | WorkflowDispatchPayload | **N/A** — no Actions; deliberately absent from our union (`webhooks.ts:24`) | Gitea-Actions wave | P2 |
| `workflow_run` (Actions-only) | `services/actions/notifier.go` → shared `webhook/notifier.go:1070` (WorkflowRunStatusUpdate:1039) | WorkflowRunPayload (`hook.go:681`) | **N/A** — no Actions | Gitea-Actions wave | P2 |
| `workflow_job` (Actions-only) | `webhook/notifier.go:1028` (WorkflowJobStatusUpdate:1003) | WorkflowJobPayload (`hook.go:704`) | **N/A** — no Actions | Gitea-Actions wave | P2 |

## Coverage ratio

Over the 26 wire event types of `AllEvents()` (`type.go:50-77`), at HEAD `7242825`:

- **Fully emitted: 17/26** (`push`, `create`, `delete`, `fork`, `issues`, `issue_assign`,
  `issue_label`, `issue_milestone`, `issue_comment`, `pull_request`, `pull_request_assign`,
  `pull_request_label`, `pull_request_milestone`, `pull_request_comment`, `pull_request_sync`,
  `release`, `status`) — **65%** (3/26 at the first edition, 7/26 partially).
- **At least partially emitted: 18/26** — the above plus `repository` (created ×3 paths /
  renamed / deleted emit; the migrate route is silent) — **69%**.
- **NOT-EMITTED with the triggering feature already present: 0/26** — the bucket the first
  edition filled with 9 types is empty; its last occupants (milestone/assign) closed with
  `812f999`/`7242825`.
- **N/A, feature absent: 8/26** — the three PR-review events + `pull_request_review_request`,
  `wiki`, `package`, `workflow_run`, `workflow_job`.

## Remaining work (ranked)

The first edition's shortlist (release / labels / pull_request_sync / repository+fork / status)
and the follow-up milestone+assign wave are all landed as of `7242825`. What remains, ranked:

1. **`repository` migrate arm** — one `emitRepoEvent` call in the migrate-completion path
   (`api/routes/imports.ts`) upgrades `repository` from EMITTED-PARTIAL to fully EMITTED
   (upstream MigrateRepository:149→:151; the fork case :103 is already covered by the `fork`
   event). After it, every feature-backed type emits.
2. **PR-review wave** (four N/A types) — needs the review routes themselves first; the
   subscription vocabulary (`pull_request_review` group flag) is already modeled.
3. **Wiki / package-registry waves** — same shape: the triggering feature is the prerequisite;
   the emission seam pattern (`emitRepoEvent`-style family module) is established.
4. **Gitea-Actions wave** — `workflow_run`/`workflow_job` (+ `schedule`, outside `AllEvents`)
   arrive only with Actions itself.
5. **Housekeeping**: PATCH-assignee support (`issues.ts:1221`/`pulls.ts:821` still ignore
   `form.assignee(s)`) would let the assign emissions ride the PATCH path like upstream; the
   `fork` event still lacks a dedicated delivery assertion in the test suite.
