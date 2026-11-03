# SPEC-0005: Issues, Pull Requests, Releases & Webhooks (D1 model, PR engine semantics, Queue delivery)

Status: **draft** · Date: 2026-10-24. Implements ADR-0001 D3 (issue/PR/release/webhook
allocation to D1 + Queue) and closes the open questions SPEC-0004 §3.1/§6.5 (table list,
id scoping) and §6.4 (fork PR object sharing). Upstream reference: submodule pin
`fc4936884584` (v29.0.0-dev era; citations below are file paths in `gitea/` at this pin).
Contract: `gitea/templates/swagger/v1-swagger.generated.json` — categories (d) issues/PRs/
comments/releases/labels/milestones/statuses (70 paths) and (e) webhooks (9 paths), of
which SPEC-0004 tier 1 ships ~33 paths (§2.2 there); this SPEC defines the full data
model and write-path semantics for all of category (d)+(e), tier 1 and tier 2 alike.

## 1. Problem and scope

SPEC-0004 fixed *which* endpoints exist and what they return. This SPEC fixes *where the
state lives and how it moves*: the D1 schema for issues, PRs, comments (with Gitea's
41-value comment-type system), labels, milestones, reactions, releases + assets,
subscriptions, webhooks and their delivery log; the concurrency-safe per-repo issue/PR
number allocation; the PR lifecycle against the SPEC-0001 engine (head refs, merge-base,
diffs, conflict checks, merge execution); close-via-commit on push; and webhook
fan-out/delivery on Cloudflare Queues with byte-compatible Gitea payloads and signatures.

In scope:

- D1 (Drizzle) schema for all category-(d)/(e) state, incl. the counter design and
  id-space decisions resolving SPEC-0004 §6.5 (§3.1–3.2).
- PR semantics on our engine: `refs/pull/N/head` management, mergeability state machine,
  divergence, diff/patch reads, merge execution (§2.4, §3.4).
- Push-integrated behaviors: close/reopen via commit message, `commit_ref` comments,
  PR head-sync on pushes (§2.5).
- Webhook model: event catalog, payload shapes (exact field names from
  `modules/structs/hook.go`), signature header set, Queue-based delivery worker,
  delivery log, replay (§2.6–2.7, §3.5–3.6).
- Release lifecycle incl. draft/pre-release semantics and R2-backed assets with
  presigned checksum-bound uploads (§2.3, §3.3).
- Edge cases and failure modes (§4), testing plan (§5), open questions (§6).

Out of scope (their own SPECs or explicitly deferred): repo/branch/tag/contents routes
(SPEC-0004), auth scopes (SPEC-0002), fork object-sharing base mechanics for cloning
(SPEC-0003 §2.4 — §2.4 here only adds what a *PR from a fork* needs), reviews (API
`/pulls/{index}/reviews*` — tier 2; the `comments` table carries the `review_id` column
now so the reviews SPEC needs no migration), projects, times/stopwatches, dependencies,
notifications, email, Actions (all tier 3 / later SPECs). Issue/PR *search* endpoints
are listed as API surface but their full-text ranking is out of scope (LIKE-based
matching only, §2.2).

## 2. API surface (with upstream behavior notes)

### 2.1 Routes owned by this SPEC

All routes are declared in SPEC-0004 (appendix A); the ones whose **behavior** is
specified here, grouped:

- Issues: `GET/POST /repos/{owner}/{repo}/issues`, `GET/PATCH/DELETE …/issues/{index}`,
  `GET/POST …/issues/{index}/comments`, `GET/PUT/POST/DELETE …/issues/{index}/labels`,
  `GET …/issues/{index}/timeline`, `GET/PATCH/DELETE …/issues/comments/{id}`,
  `GET …/issues/comments`, `GET /repos/issues/search`, label + milestone CRUD,
  `GET …/assignees`; tier-2: lock/pin, assignees set, deadline, blocks/dependencies,
  reactions, subscriptions, stopwatch/times, assets.
- PRs: `GET/POST /repos/{owner}/{repo}/pulls`, `GET/PATCH …/pulls/{index}`,
  `GET …/pulls/{base}/{head}`, `GET …/pulls/{index}.{diffType}`,
  `GET …/pulls/{index}/commits`, `GET …/pulls/{index}/files`,
  `GET/POST …/pulls/{index}/merge`, `POST …/merge-upstream`; tier-2: reviews,
  requested reviewers, update.
- Releases: `GET/POST …/releases`, `GET …/releases/latest`,
  `GET/DELETE …/releases/tags/{tag}`, `GET/PATCH/DELETE …/releases/{id}`,
  `GET/POST …/releases/{id}/assets` (multipart or octet-stream; tier-2 asset-by-id ops).
- Statuses: `GET/POST …/statuses/{sha}`, `GET …/commits/{ref}/status(es)` (data model
  included here in §3.2; the combined-status aggregation follows SPEC-0004 §2.4).
- Webhooks: `GET/POST …/hooks`, `GET/PATCH/DELETE …/hooks/{id}`,
  `POST …/hooks/{id}/tests`, `GET …/hooks/{id}/deliveries` (+ tier-2
  `GET …/hooks/{id}/deliveries/{uuid}`, org/user hooks).

Cross-cutting conventions (pagination clamps 30/50, `X-Total-Count` + `Link` headers,
error body `{message, url}`, 423 archived, 412 issues-disabled, RFC3339 timestamps) are
SPEC-0004 §2.5 and are not repeated here.

### 2.2 Issues — upstream behavior notes

Citations: `gitea/models/issues/issue.go`, `issue_update.go`, `issue_index.go`,
`services/issue/issue.go`, `models/db/index.go`.

- **Numbering**: an issue's public identity is the per-repo `index` (`issues/{index}`
  URLs, webhook payload field `number`), not the global row `id`. Upstream allocates
  from a counter table `issue_index (group_id = repo_id, max_index)` **inside the
  creation transaction** (`models/issues/issue_update.go:456`
  `db.GetNextResourceIndex(ctx, "issue_index", repo.ID)`; allocation algorithms
  `models/db/index.go:56–166` — the MySQL form is
  `INSERT … ON DUPLICATE KEY UPDATE max_index = max_index+1` then re-read; the generic
  form is `UPDATE … SET max_index = max_index+1 WHERE group_id=?` relying on the
  transaction's row write-lock). `(repo_id, index)` is `UNIQUE`
  (`Issue.RepoID … UNIQUE(repo_index)`, `issue.go:53–55`). Counters are never reused:
  deletion does not rewind the counter; only a recovery tool
  (`RecalculateIssueIndexForRepo`, `issue_index.go:14`) re-syncs `max_index` to
  `MAX(index)` of surviving rows.
- **PRs share the counter**: `NewPullRequest` calls the same
  `GetNextResourceIndex(ctx, "issue_index", repo.ID)` (`models/issues/pull.go:468`) —
  issues and PRs draw from one monotonic sequence per repo. This is the contract every
  client relies on (`#123` can be a PR).
- **States**: `is_closed` bool + `closed_unix`; close/reopen write a system comment
  (`CommentTypeClose=2` / `CommentTypeReopen=1` / `CommentTypeMergePull=28`) and
  maintain denormalized counters on repo (`num_issues/num_pulls/num_closed_*`,
  `models/repo/repo.go:170–176`) and milestone/label (`models/issues/issue_update.go`
  `updateIssueNumbers`). Close is CAS-guarded
  (`UPDATE … WHERE is_closed = false` → 0 rows = `ErrIssueAlreadyChanged`).
- **Title/body**: title truncated at 255 chars (`util.EllipsisDisplayString`,
  `issue_update.go:453`); edits bump `content_version` and write `change_title`
  (type 10) comments with `old_title/new_title`; body edits are tracked by
  `content_history` rows upstream (UI feature — cf-gitea keeps only
  `content_version`; history API is tier 3).
- **Locking**: `is_locked` restricts commenting to write-access users; lock/unlock
  writes comment types 23/24 with the reason in `content`
  (`models/issues/issue_lock.go`). API: `PUT/DELETE …/issues/{index}/lock` (tier 2).
- **Pinning**: `issue_pin` rows carry a per-repo `pin_order` (types 36/37 comments;
  `models/issues/issue_pin.go`). API tier 2.
- **Cross-references**: modeled as comment rows **on the referenced issue** with types
  `issue_ref` (3) / `pull_ref` (6) and origin columns
  `ref_repo_id/ref_issue_id/ref_comment_id/ref_action` (`models/issues/comment.go`
  Comment struct; writer `models/issues/issue_xref.go AddCrossReferences`). `ref_action`
  ∈ none(0)/closes(1)/reopens(2)/neutered(3) (`modules/references/references.go:66–76`).
  Reference syntax parsed from title/body: `#N`, `owner/repo#N`, `!N` (external
  tracker), `ABC-1234` alphanumerics, `owner/repo@sha`
  (`modules/references/references.go:35–41` regex set). Editing content re-runs the
  scan and "neuters" stale references (sets `ref_action=neutered`).
- **Subscriptions**: `issue_watch (user_id, issue_id) UNIQUE, is_watching`
  (`models/issues/issue_watch.go`). Repo-level watch is the SPEC-0004
  `/repos/{owner}/{repo}/subscription` endpoint (watch table owned by SPEC-0003's
  registry section; the issue-level table is defined in §3.2 here).
- **Deletion**: `DELETE /repos/{owner}/{repo}/issues/{index}` cascades a long list
  (`services/issue/issue.go deleteIssue`: comments, issue_labels, reactions, watches,
  pins, assignees, pull_request row, xref comments in **both** directions
  (`RefIssueID`/`DependentIssueID`), attachments; and for PRs removes the
  `refs/pull/N/head` ref). The counter is *not* rewound.

### 2.3 Releases — upstream behavior notes

Citations: `gitea/models/repo/release.go`, `models/repo/attachment.go`,
`services/release/release.go`.

- **Identity**: global autoincrement `id` (not per-repo); `(repo_id, tag_name)` unique
  (`UNIQUE(n)` on the Release struct). Resolvable by tag name
  (`/releases/tags/{tag}`) or id. `lower_tag_name` is stored for case-insensitive
  lookup.
- **Tag coupling**: creating a release for a nonexistent tag creates the tag at
  `target_commitish` (`services/release/release.go createTag`); deleting a *tag-only*
  record deletes the tag, while deleting a release keeps the tag by default
  (API semantics per swagger). `is_tag=true` marks a pure tag record with no release
  metadata (created when only tags exist; converted on first release edit).
  **As-built (findings-links N2, 2026-10-30)**: the API create path lands the tag
  through the shared tag-store service (`apps/worker/src/api/services/tags.ts` —
  the same `resolveTagTarget`/`writeTagRef` primitives POST /repos/{o}/{r}/tags
  uses; no re-implementation), in upstream's exact order: duplicate release row →
  409 **before** any git write; then, for published releases only (drafts defer the
  tag to their publish moment — createTag's `!rel.IsDraft` gate, release.go:78),
  git tag exists → **ride it** (no duplicate, release.go:78); protected tag → 422
  `release tag name is protected [tag_name: …]` (release.go:87-102 + the handler
  answer at release.go:281-282); unresolvable target → 404 `target not found` with
  NO release row created (release.go:104-113 + release.go:283-284); absent
  `target_commitish` → the default branch; a `tag_message` creates the ANNOTATED
  tag object (release.go:110-121). A created tag fires the tags-API's byte-identical
  `push` + `create` ref-webhook pair (upstream createTag's PushCommits +
  CreateRef, release.go:131-143) — the TAG-CREATE shape, not a bare
  zero-everything pair: the push event fires FIRST (release.go:136) with a
  zero commit LIST (`total_commits` 0) but a real `head_commit` — the tagged
  (peeled) commit (`commits.HeadCommit = CommitToPushCommit(commit)`, release.go:132)
  — and a real `compare_url` over the zero base
  (`ComposeCompareURL(zero, commit.ID)`, release.go:133); the `create` event
  follows (:143). The SAME shape rides a tag created by a user push
  (`services/repository/push.go:123-136` — push-then-create there too; CORRECTED
  2026-11-02: this passage's earlier "zero-commit" reading described the bare
  mirror shape and mis-stated the cited arm). The fill (`sha1`/`num_commits`/the commit-dated
  `created_unix`, release.go:150-157) and the EDIT path's tag arm (upstream
  UpdateRelease → createTag, release.go:262/269) LANDED with the UpdateRelease tag
  wave; only DELETE's `delTag` arm remains D1-only (the API passes `delTag=false`).
  createTag's
  MustNotBeArchived arm IS replicated (as-built, the v1.3.2 board's P2-5,
  2026-10-31): the release subtree registers NO route-level mustNotBeArchived
  (`api.go:1408–1429` — only `mustEnableUnit(TypeReleases)`, so the middleware's
  423 never fires here), and the refusal is the in-service gate at
  `services/release/release.go:75–78`, reached by BOTH surfaces
  (CreateRelease `release.go:187`, UpdateRelease `release.go:269`) AFTER the
  duplicate 409 and BEFORE the `!IsDraft` gate (drafts included); neither
  handler maps `ErrRepoIsArchived`, so it answers `ctx.APIErrorInternal` →
  bare **500** (`routers/api/v1/repo/release.go:285–287` create, `:379–382`
  edit) — our untyped throw → the house 500 body (the ef2c049 convention).
- **Drafts/pre-releases**: `is_draft` rows are hidden from the public list and from
  `GET /releases/latest` (`GetLatestReleaseByRepoID` filters
  `is_draft=false AND is_prerelease=false AND is_tag=false`,
  `models/repo/release.go:338–357`); drafts are visible to repo-writers.
  **Draft → publish fires the `release` webhook only at publish time**:
  `CreateRelease` notifies only `if !rel.IsDraft`
  (`services/release/release.go:198`); `UpdateRelease` fires `NewRelease` (published)
  if the update created/converted the tag, else `UpdateRelease` (updated)
  (`release.go:355–367`).
- **Ordering**: lists are `created_unix DESC, id DESC` (`FindReleasesOptions.ToOrders`).
- **Attachments** (`models/repo/attachment.go`): one shared `attachment` table for
  release/issue/comment assets — `uuid` (unique), `repo_id`, `release_id`,
  `issue_id`/`comment_id`, `uploader_id`, `name`, `download_count`, `size`,
  `created_unix`; storage addressed by uuid sub-path. Duplicate asset **names within a
  release are allowed** but flagged (`hasDuplicateName`). Download counts increment on
  each download.

### 2.4 Pull requests — upstream behavior notes

Citations: `gitea/models/issues/pull.go`, `services/pull/pull.go`, `check.go`,
`patch.go`, `merge_tree.go`, `merge.go`, `modules/git/ref.go`.

- **A PR is an issue**: `pull_request` rows join `issue_id` → `issues`; the issue row
  carries `is_pull=true`, the shared `index`, title/body/labels/milestone/comments.
  The API `PullRequest` object embeds the issue fields; `GET …/issues?type=pulls`
  lists PRs.
- **Head/base**: `head_repo_id/head_branch/base_repo_id/base_branch` +
  `merge_base VARCHAR(64)`; `head_sha` is *not* stored — it is resolved from the git
  ref (below) or from `HeadCommitID` for agit flow. `flow` ∈ github (branch exists) |
  agit (pushed via `refs/for/<branch>`, head ref written directly).
- **The head ref lives in the BASE repo**: `refs/pull/<index>/head`
  (`GetGitHeadRefName`, `models/issues/pull.go:405–407`;
  `PullPrefix = "refs/pull/"`, `modules/git/ref.go:21`). On PR creation
  `PushToBaseRepo` fetches the head commit from the head repo into the base repo's
  object store and points the ref at it (`services/pull/pull.go:542–563`); on every
  push to a branch, `UpdatePullsRefs` re-points the refs of all *open* PRs whose head
  branch matches (`pull.go:565–584`); on PR deletion the ref is removed
  (`services/issue/issue.go:178`). Creation failure cleans the ref up
  (`services/pull/pull.go:157–162`). Clients can `git fetch origin
  refs/pull/N/head`.
- **Mergeability state machine** (`PullRequestStatus`,
  `models/issues/pull.go:44–57`): `conflict(0), checking(1), mergeable(2),
  manually_merged(3), error(4), empty(5), ancestor(6)`. At creation the check runs
  inline (`checkPullRequestBranchMergeable`); later re-checks run async on a queue
  (`prPatchCheckerQueue`, `services/pull/check.go`). The modern path
  (`checkPullRequestMergeableByMergeTree`, `services/pull/merge_tree.go:52`):
  1. resolve head sha (from head branch or `refs/pull/N/head`);
  2. `merge-base(baseCommit, headCommit)` → store `merge_base`; no merge base →
     treat as empty; head == merge base → status `ancestor` (nothing to merge);
  3. `git merge-tree` (read-only) → conflict? store `conflicted_files`, status
     `conflict`;
  4. `diff-tree -r --quiet mergedTree baseCommit` → no diff ⇒ `empty` (already
     applied), else `mergeable`.
  Divergence (`commits_ahead/behind`) is recomputed on head/base pushes
  (`syncCommitDivergence`, `git rev-list --left-right --count`).
- **Merged detection**: `merge-base --is-ancestor <refs/pull/N/head> <baseBranch>` —
  exit 0 ⇒ the head is already in base (→ `manually_merged` / `has_merged`); then the
  merge commit is located by walking from base tip down to `merge_base`
  (`services/pull/check.go getMergeCommit`, `check.go:299–330`).
- **Merge styles** (`POST …/pulls/{index}/merge`, body `do`): `merge`, `rebase`,
  `rebase-merge`, `squash`, `fast-forward-only`, `manually-merged`
  (`services/pull/merge.go`); not-mergeable → **405** (empty body); WIP-title PRs are
  refused (`HasWorkInProgressPrefix`); merged PR closes its issue with a
  `merge_pull` (28) comment and fires the `pull_request` webhook with
  `action="closed"`, `pull_request.merged=true` (`services/webhook/notifier.go:741–855`).
  Deleting the head branch afterwards writes a `delete_branch` (11) comment.
- **Merge body wire casing (as-built, 2026-10-30)**: the documented body keys are the
  swagger's lowercase names (`do`, `merge_title_field`, …), and the runtime also
  accepts the legacy PascalCase aliases `Do`/`MergeTitleField`/`MergeMessageField`/
  `MergeCommitID` through the form's custom `UnmarshalJSON`
  (`services/forms/repo_form.go:431–463` — go-sdk/tea clients send that form).
  Lowercase wins on collision (Go `util.IfZero`; `merge_message_field` is
  pointer-typed, so a present lowercase value, even `""`, wins); the remaining
  fields are lowercase-only. The emitted OpenAPI document declares only the
  lowercase names.
- **Merge commit message (as-built, 2026-11-02; template arm 2026-11-02)**: a
  trimmed `merge_title_field` wins; empty/absent falls to the style's default
  (`GetDefaultMergeMessage`, `services/pull/merge.go:54–165`). THE TEMPLATE ARM
  (resolved 2026-11-02, both surfaces): the `.gitea/default_merge_message/`
  resolution upstream runs first (`merge.go:116–122` →
  `resolveMergeMessageTemplate :150–166`) is modeled in the shared builder —
  `{UPPER STYLE}_TEMPLATE.md` is read off the BASE repo's default-branch tip,
  `DEFAULT_TEMPLATE.md` the fallback, each read truncated at
  `DefaultMergeMessageSize` (5 KiB); a found template's first line IS the
  default title and its trimmed remainder the default body, both expanded
  shell-like (`vars.ExpandShellLike`, `${VAR}`/`$VAR`, missing keys verbatim)
  over the upstream vars map (`BaseRepoOwnerName` … `PullRequestReference`,
  `ReviewedOn`, `ReviewedBy`, and `ClosingIssues` — the latest
  closes/reopens xref per source issue kept, close-actions joined
  `close #N, …`; `merge.go:88–114`). Template-less defaults: rebase → `""`,
  squash → `{title} (#{index})`, otherwise
  `Merge pull request '{title}' (#{index}) from {head} into {base}` with the fork
  form `from {owner}/{name}:{head}` and `<deleted>:{head}` for a deleted head repo
  (`routers/api/v1/repo/pull.go:966–986`); a non-empty trimmed
  `merge_message_field` appends as `\n\n{field}`. THE SQUASH DEFAULT BODY
  (upstream's `useDefaultSquashBody`, `pull.go:966–983` — resolved 2026-11-02,
  both paths): when the `merge_message_field` KEY IS ABSENT from the request
  (`!HasMergeMessageField && !Req.Form.Has` — a present-even-empty value
  suppresses the arm, `services/forms/repo_form.go:455–457`) and the style is
  squash, the route composes `CommitMessageMerge(GetSquashMergeCommitMessages,
  defaultBody)` — the aggregated commit bullets + co-author trailers + the
  default body (the template's expanded remainder when a template exists) —
  through the merge box's shared builders (ui/pages/pull-merge-box.tsx exports;
  the api→page seam). The web merge-box path always carries the field
  (prefilled verbatim, upstream web `pull.go:1116–1129` has no default-body
  arm) — the arm is API-only, exactly upstream. The UI prefill (SPEC-0008's
  merge box, the U31 seam) composes the identical bytes, so the divergence is
  closed on BOTH paths. Remaining divergences: template/engine read failures
  degrade to the template-less shape (the box loader's disclosed err-arm
  posture) instead of upstream's `APIErrorInternal` 500; the squash walk's
  newest-50 window (`pull.go:759–761`, `DefaultMergeMessageCommitsLimit`) is
  exact within a 1000-commit walk ceiling (the engine answers the range
  oldest-first — the read takes the whole in-range set at the ceiling and
  slices the newest 50; ranges past the ceiling keep the oldest-first page),
  and the co-author scan iterates that window newest-first (upstream's
  rev-list order, `pull.go:796`) with both signature ends derived from the
  one `NewGitSig` port (the contents-route commit stamps stamp the same
  derivation, `temp_repo.go:236–250`). manually-merged composes no message
  (upstream returns before it).
- **Work-in-progress**: titles prefixed `WIP:`, `[WIP]`, `Draft`, etc. block merge
  (`models/issues/pull.go HasWorkInProgressPrefix`).

### 2.5 Push-integrated issue behaviors

Citations: `gitea/services/repository/push.go:185–197`, `services/issue/commit.go`,
`modules/references/references.go`.

- On every branch push, upstream walks the **new commits' messages in reverse order**
  (`UpdateIssuesCommit`, `services/issue/commit.go:126`), extracts all references, and:
  - writes a `commit_ref` (4) comment on each referenced issue with a link to the
    commit (`CreateRefComment`);
  - closes/reopens referenced issues when the message contains closing/reopening
    keywords before the `#N` reference (`findActionKeywords`), gated by permission
    (`canclose = repo admin/owner | canWriteIssuesOrPulls | issue poster`,
    `commit.go:171`), by `repo.CloseIssuesViaCommitInAnyBranch`
    (`models/repo/repo.go:209` — when false, only pushes to the issue's `ref` branch,
    or the default branch if unset, may close), and by a self-reference guard (a PR's
    own merge commit mentioning `#N` does not close N, `isSelfReference`).
  This runs over **all** new commits (before the feed cap below).
- The push **webhook** payload's `commits` array is capped at `UI.FeedMaxCommitNum`
  (**default 5**, `modules/setting/ui.go:92`, applied at
  `services/repository/push.go:190–192`) while `total_commits` carries the true count;
  commits are listed newest-first; `head_commit` is the new tip. The Len nuance is a
  posture split (CLARIFIED 2026-11-02): the USER-push arms walk UNCAPPED —
  `pushUpdateBranch`'s `CommitsBetween(new, old, -1)` (push.go:279) makes
  `total_commits` the FULL delta count while the array caps at 5 (:190-192 trims the
  ARRAY only, `GitToPushCommits` sets `Len` from the walk, commits.go:150) — whereas
  the MIRROR arm's own walk is capped (`CommitsBetween(new, old, FeedMaxCommitNum)`,
  mirror_pull.go:363), so its Len ≤ 5.
- Ref create/delete pushes fire `create`/`delete` webhooks with
  `ref_type ∈ branch|tag` and the short ref name
  (`services/webhook/notifier.go:822–858`). CREATED refs split by posture and kind
  (spelled out 2026-11-02 — the mirror arm and the user-push arms differ in shape
  AND order):
  - MIRROR created ref (mirror_pull.go:347-352): the bare zero-everything `push`
    event FIRST (empty `NewPushCommits()` — no head, no compare URL, Len 0), then
    `create`.
  - USER-push BRANCH create (push.go:255-276): `create` FIRST (CreateRef inside
    pushNewBranch, :274, after the walk), then the `push` payload of the real
    `CommitsBeforeLimit(10)` walk (:270) — array = the newest 5 of that walk,
    `total_commits` = the walk length (≤10), `head_commit` = the tip (:182),
    `compare_url` real (getCompareURL, :188/:227-253 — the oldest walked commit's
    first parent, falling to the default-branch name for a root, and to the bare
    AppURL when neither resolves).
  - USER-push TAG create (push.go:123-136): the zero-list `push` event FIRST
    (:127-133) carrying `head_commit` = the peeled tip (:124) and
    `compare/{zero}...{new}` (:125) — the §2.3 tag-create shape — then `create`
    (:136).

### 2.6 Webhooks — upstream model and event catalog

Citations: `gitea/models/webhook/webhook.go`, `models/webhook/hooktask.go`,
`modules/webhook/type.go`, `modules/webhook/events.go`, `services/webhook/webhook.go`,
`deliver.go`, `notifier.go`, `modules/setting/webhook.go`.

- **Webhook row**: `repo_id` (0 = org/user or system), `owner_id`, `is_system_webhook`,
  `url`, `http_method` (POST default; GET/PUT special forms), `content_type`
  (`json`=1 | `form`=2), `secret`, `events` (JSON: `push_only`, `send_everything`,
  `choose_events`, `branch_filter`, `events` map), `is_active`, `type`
  (`gitea, gogs, slack, discord, dingtalk, telegram, msteams, feishu, matrix,
  wechatwork, packagist` — `modules/setting/webhook.go:43`), `meta`, `last_status`,
  optional encrypted `Authorization` header. `CreateHookOption.active` defaults to
  **false** in the swagger (SPEC-0004 §2.4).
- **Event matching** (`Webhook.HasEvent`, `webhook.go:171–185`): `send_everything`
  matches all; `push_only` matches only `push`; the three review event types share the
  `pull_request_review` subscription flag; everything else is a direct flag on
  `events`. `branch_filter` is a glob matched against branch names **and** full ref
  names, applied only to payloads that carry a ref (push, create, delete;
  `services/webhook/webhook.go:49–69, 114–130`).
- **Event types** (`modules/webhook/type.go:14–46`): `create, delete, fork, push,
  issues, issue_assign, issue_label, issue_milestone, issue_comment, pull_request,
  pull_request_assign, pull_request_label, pull_request_milestone,
  pull_request_comment, pull_request_review_approved, pull_request_review_rejected,
  pull_request_review_comment, pull_request_sync, pull_request_review_request, wiki,
  repository, release, package, status` (+ Actions-only schedule/workflow_run/
  workflow_job — deferred). The `X-Gitea-Event` header carries the *group* name
  (`Event()`: issues/issue_assign/… → `issues`; pull_request* sub-events →
  `pull_request`; *_comment → `issue_comment`), `X-Gitea-Event-Type` the specific one.
- **Fan-out** (`PrepareWebhooks`, `services/webhook/webhook.go:207`): repo hooks ∪
  owner(user/org) hooks ∪ system hooks, all `is_active`; per-hook gates: `HasEvent`,
  (for push) zero-commit payloads skipped for non-gitea/gogs types, branch filter;
  then one `hook_task` row **per webhook** is inserted and enqueued. Payload JSON is
  produced once per event by the payload structs' `JSONPayload()`
  (`modules/structs/hook.go` — `MarshalIndent(p, "", "  ")`, i.e. **2-space
  pretty-printed**) and stored in the task (`payload_version=2` stores the original
  event; the gitea/gogs types send it verbatim).
- **Delivery worker** (`services/webhook/deliver.go`): a unique in-process queue
  ("webhook_sender", length 1000); startup re-scans **undelivered** tasks
  (`populateWebhookSendingQueue`, `deliver.go:292`) for crash recovery. Delivery:
  `MarkTaskDelivered` CAS (`is_delivered`) prevents double-send; POST `application/json`
  or `application/x-www-form-urlencoded` (`payload=<urlencoded>`); GET puts the payload
  into the query string. Success = **2xx**; response body stored capped at 1 MiB
  (`util.ReadWithLimit(resp.Body, 1024*1024)`); timeout `webhook.DELIVER_TIMEOUT`
  default **5 s** (`modules/setting/webhook.go:31`). **No automatic retry**: a failed
  attempt marks the task `is_delivered=true, is_succeed=false` and is terminal —
  redelivery exists only as an explicit user action (`ReplayHookTask` inserts a copy
  with a new UUID, `models/webhook/hooktask.go:180`).
- **Signature & headers** (`addDefaultHeaders`, `deliver.go:94–143`), over the exact
  bytes sent: `X-Gitea-Delivery: <uuid>`, `X-Gitea-Event: <group>`,
  `X-Gitea-Event-Type: <specific>`, `X-Gitea-Signature: <hex hmac-sha256>`,
  `X-Gitea-Hook-Installation-Target-Type: system|repository|organization|user`;
  the same quartet under `X-Gogs-*`; `X-GitHub-Delivery/Event/Event-Type/
  Hook-Installation-Target-Type`; `X-Hub-Signature: sha1=<hex>` and
  `X-Hub-Signature-256: sha256=<hex>` (HMAC-SHA1/256 of the body with the secret).
  A webhook `secret` that looks like `Bearer …`/`token …` becomes an `Authorization`
  header and is masked (`******`) in the stored request info.
- **Trigger points** (the full catalog, `services/webhook/notifier.go`): issue
  opened/closed/reopened/edited (`issues`), assignee change (`issue_assign`),
  labels (`issue_label`, actions `label_updated`/`label_cleared`), milestone
  (`issue_milestone`, `milestoned`/`demilestoned`), title/body edits carry
  `changes: {title|body: {from}}`; comment created/edited/deleted (`issue_comment`,
  incl. PR comments as `pull_request_comment` with `is_pull=true`); PR
  opened/edited/closed/reopened (`pull_request`), synced on head-branch push
  (`pull_request_sync` with `before/after`), merged (→ `closed` + `merged=true`),
  target-branch change, review approved/rejected/comment, review request;
  push (`push`), branch/tag create/delete (`create`/`delete`), release
  published/updated/deleted (`release`; never for drafts), commit status (`status`),
  repository created/deleted/renamed/forked (`repository`, `fork`).

### 2.7 Payload shapes (compat-frozen)

Exact JSON field sets come from `modules/structs/hook.go` and are frozen as fixtures
(§5.3). The ones tier-1 write paths must emit:

- `PushPayload`: `ref, before, after, compare_url, commits[], total_commits,
  head_commit, repository, pusher, sender`; `commits[]/head_commit` are
  `PayloadCommit{id, message, url, author{name,email,username},
  committer{…}, verification{verified,reason,signature,signer,payload}, timestamp,
  added[], removed[], modified[]}` (`modules/structs/hook.go:154–176`).
- `IssuePayload`: `action, number (= index), changes{title{from}, body{from},
  ref{from}, added_labels[], removed_labels[], added_assignees[], removed_assignees[]},
  issue (the API Issue object), repository, sender, commit_id`
  (`modules/structs/hook.go:435–451`); actions
  `opened, closed, reopened, edited, deleted, assigned, unassigned, label_updated,
  label_cleared, synchronized, milestoned, demilestoned, reviewed,
  review_requested, review_request_removed`.
- `IssueCommentPayload`: `action (created|edited|deleted), issue, pull_request?,
  comment, changes?, repository, sender, is_pull` (`hook.go:297–315`).
- `PullRequestPayload`: `action, before?, after?, number, changes?, pull_request
  (API PullRequest object), requested_reviewer, repository, sender, commit_id, review
  {type, content}` (`hook.go:484–508`).
- `ReleasePayload`: `action (published|updated|deleted), release, repository, sender`.
- `CreatePayload`: `sha, ref, ref_type (branch|tag), repository, sender`;
  `DeletePayload`: `ref, ref_type, pusher_type ("user"), repository, sender`.
- `RepositoryPayload` and `ForkPayload` (repository events) follow the API `Repository`
  object.

`repository`/`sender`/embedded objects are the same serializers as the REST API
(`services/convert`), so once SPEC-0004's response models exist the payloads are a
composition — the payload-level fixtures pin *these* wrappers and the 2-space pretty
format.

## 3. Data model

### 3.1 Number allocation — decision (resolves SPEC-0004 §6.5)

**Per-repo monotonic counters, allocated in D1.** A `repo_counters` row per repository
holds `issue_index` (shared by issues and PRs, exactly like upstream's `issue_index`
table). Allocation is part of the creation statement batch:

```sql
-- one D1 batch([...]) = one SQLite transaction; D1 serializes writers
UPDATE repo_counters SET issue_index = issue_index + 1 WHERE repo_id = ? RETURNING issue_index;
INSERT INTO issues (id, repo_id, index, …) VALUES (NULL, ?, :idx, …);
```

Justification:

- **Upstream parity**: upstream's own mechanism is a per-repo counter row read-modified
  inside the creation transaction (`models/db/index.go:114–166`); we mirror it with
  D1's tools. The `RETURNING` form collapses upstream's MySQL two-step
  (upsert + re-read) into one statement.
- **Concurrency**: D1 executes batches atomically and serializes writers per database,
  so two concurrent `POST /issues` on one repo produce strictly sequential indexes with
  no gaps (a failed insert rolls back its counter bump) and no duplicates — the exact
  guarantee upstream gets from the transaction row-lock.
- **Rejected: DO allocation.** The per-repo RepoDO serializes *git pushes*, not API
  writes; routing every issue creation through the DO adds a cross-region RTT to the
  hot path and couples issue numbering to DO availability for no correctness gain —
  D1 alone already provides the required serialization. (A DO *is* used where upstream
  needs one: merge/PR-check coordination, §3.4.)
- **Rejected: global-id-only.** `issues/{index}` URLs and payload `number` are the
  public contract; global `id` also exists (payload `issue.id`, comment endpoints) and
  is a separate D1 `INTEGER PRIMARY KEY AUTOINCREMENT` space — both id spaces must
  exist (SPEC-0004 §2.4 gotcha).
- **Bootstrapping**: `repo_counters` row is created with the repository
  (`issue_index = 0`); a legacy-import path can `SyncMaxResourceIndex`-style repair
  (`UPDATE … WHERE issue_index < ?`). Release ids, comment ids, label ids, milestone
  ids, webhook ids are **global** autoincrement (matches upstream: comments/releases
  have global ids per SPEC-0004; labels/milestones are addressed by repo-scoped numbers
  that happen to be global upstream ids — we keep global to avoid a second counter).

### 3.2 D1 tables (Drizzle)

All timestamps `integer` unix seconds (UTC); booleans `integer` 0/1 (SQLite); JSON
columns `text`. `id` columns are `integer primary key autoincrement` unless noted.

- `repo_counters(repo_id pk→repositories.id, issue_index integer not null default 0)`
- `issues(id, repo_id not null, index not null, poster_id, original_author text,
  original_author_id, title text not null, content text, content_version integer not
  null default 0, milestone_id, priority integer default 0, is_closed integer not null
  default 0, is_pull integer not null default 0, num_comments integer not null default
  0, ref text default '', is_locked integer not null default 0, time_estimate integer
  not null default 0, deadline_unix, created_unix, updated_unix, closed_unix,
  unique(repo_id, index))` — mirrors `Issue` (`models/issues/issue.go:52–115`);
  `pin_order` lives in `issue_pins` (tier 2).
- `pull_requests(id, issue_id unique not null, index not null, status integer not null
  default 1 /* checking */, conflicted_files text /* JSON array */, commits_ahead
  integer default 0, commits_behind integer default 0, head_repo_id not null,
  base_repo_id not null, head_branch text not null, base_branch text not null,
  merge_base text, head_sha text, allow_maintainer_edit integer not null default 0,
  has_merged integer not null default 0, merged_commit_id text, merger_id,
  merged_unix, flow integer not null default 0)` — mirrors `PullRequest`
  (`models/issues/pull.go:120–152`). **`head_sha` is a cf-gitea addition**: a
  denormalized cache of the `refs/pull/N/head` target used by
  `GET /commits/{sha}/pull` joins and by list endpoints to avoid per-PR engine reads;
  the engine ref remains authoritative (bumped in the same flow, §3.4).
- `comments(id, type integer not null /* CommentType 0–38 */, poster_id, issue_id not
  null, label_id, old_milestone_id, milestone_id, assignee_id, removed_assignee
  integer default 0, resolve_doer_id, old_title text, new_title text, old_ref text,
  new_ref text, dependent_issue_id, line integer, tree_path text, content text,
  content_version integer not null default 0, patch text, commit_sha text, review_id
  integer default 0, invalidated integer not null default 0, ref_repo_id, ref_issue_id,
  ref_comment_id, ref_action integer, ref_is_pull integer not null default 0,
  created_unix, updated_unix)` + indexes `(issue_id)`, `(ref_issue_id)`,
  `(ref_repo_id)`. The xref columns (types 3/4/5/6) and the mutation-metadata columns
  mirror the upstream `Comment` struct (`models/issues/comment.go:246–328`); the
  `pull_push` (29) content stores `PushActionContent` JSON
  (`{is_force_push, commit_ids}`).
- `labels(id, repo_id, org_id default 0, name not null, exclusive integer not null
  default 0, exclusive_order integer default 0, description text default '', color
  text /* #RRGGBB */, num_issues integer default 0, num_closed_issues integer default
  0, archived_unix)` — org labels (`repo_id=0, org_id>0`) supported from day 1 (they
  participate in issue creation and the `label.RepoID != repo.ID && label.OrgID !=
  owner` drop rule, `models/issues/issue_update.go:424–429`).
- `issue_labels(issue_id, label_id, primary key(issue_id, label_id))`
- `milestones(id, repo_id not null, name not null, content text default '',
  is_closed integer not null default 0, num_issues integer default 0,
  num_closed_issues integer default 0, completeness integer default 0, deadline_unix,
  closed_date_unix, created_unix, updated_unix)`
- `reactions(id, user_id not null, issue_id not null, comment_id integer not null
  default 0, release_id integer not null default 0, type text not null, created_unix,
  unique(user_id, issue_id, comment_id, release_id, type))` — mirrors
  `Reaction` (`models/issues/reaction.go:62–74`, which also allows release reactions).
- `releases(id, repo_id not null, publisher_id not null, tag_name not null,
  lower_tag_name not null, target text default '', title text not null default '',
  sha1 text, num_commits integer default 0, note text default '', is_draft integer not
  null default 0, is_prerelease integer not null default 0, is_tag integer not null
  default 0, created_unix, published_unix integer not null default 0,
  unique(repo_id, tag_name))` — mirrors `Release`; index on `(repo_id, created_unix
  desc)`.
- `release_assets(id, uuid unique, repo_id not null, release_id not null,
  uploader_id, name not null, size integer not null default 0, download_count integer
  not null default 0, r2_key text not null, checksum_sha256 text, created_unix)`
  + index `(release_id)`. (Upstream keeps one shared `attachment` table; we split
  release assets out because their storage path, presign flow and size limits differ
  from issue attachments — tier 2 issue/comment attachments can later reuse the same
  pattern with a separate table, not a shared row shape.)
- `issue_subscriptions(id, user_id not null, issue_id not null, is_watching integer
  not null, created_unix, updated_unix, unique(user_id, issue_id))`
- `commit_statuses(id, repo_id not null, sha text not null, target_url text,
  description text default '', context text not null default 'default',
  state text not null /* pending|success|failure|warning|skipped|error */,
  creator_id, created_unix, updated_unix, index (repo_id, sha))` — sort orders and the
  combined-status worst-of aggregation per SPEC-0004 §2.4.
- `issue_pins(issue_id pk, repo_id, pin_order integer not null)` (tier 2 surface, table
  now).

Counters on `repositories` (`num_issues, num_closed_issues, num_pulls,
num_closed_pulls, num_milestones`) are maintained columns (SPEC-0004 §3.2
recommendation) updated in the same D1 batch as the state change; label and milestone
counts likewise (`updateIssueNumbers` pattern).

**As-built: the schema-wide divergence families (ADR-0007 FN-13 record,
2026-11-03).** ADR-0007 classifies every schema divergence from upstream as
platform-adapted / intentional-recorded / drift, and a divergence without a SPEC
record is drift — so the three schema-wide naming/strictness families are
recorded HERE as intentional-recorded (this block owns the largest D1 table set
and the schema.ts conventions header points here). The per-column census and
verification cites live in `docs/research/table-alignment-audit.md` §7 (the
audit's FN-13 disposition); this note is the normative record:

1. **NOT-NULL strictness, ours stricter — kept.** Upstream xorm leaves a column
   nullable unless its struct tag says `NOT NULL` (~269 of ~1081 columns at the
   pin); ours declares `notNull()` far more widely (~715 of 1010). The stricter
   shape is kept, not relaxed: xorm INSERTs write every mapped field with Go
   zero values (no model-layer NULLs in upstream's effective row shape), and
   xorm reads SQL NULL back as the Go zero value — no ADR-0002-frozen API
   surface can observe the difference. **The inverse arm is NOT blessed**: where
   OURS is the nullable side against upstream `NOT NULL`, that stays drift
   unless separately recorded. Known members: `issue_subscriptions.created_unix`/
   `updated_unix` (upstream `IssueWatch.CreatedUnix/UpdatedUnix NOT NULL`,
   `models/issues/issue_watch.go:20-21`; schema.ts:999-1000 — drift, queued for
   tightening, audit FN-12) and `issue_pins.repo_id` (upstream NOT NULL int64,
   `models/issues/issue_pin.go:20`; ours nullable TEXT id-family column,
   schema.ts:1096 — drift, audit FN-10). `users.email` /
   `users.avatar_email` are separately recorded (SPEC-0002 §4.6 item 16).
2. **Timestamp column names — upstream's `*_unix` names are the rule; the
   `*_at` tables are the recorded exception.** Upstream renders its timestamp
   columns `created_unix`/`updated_unix` (GonicMapper of `CreatedUnix`/
   `UpdatedUnix`) and literally `created`/`updated` on the whole actions family
   (fields `Created`/`Updated`, `models/actions/run.go:74-75` et al.); the
   SPEC-0005 block above and every later port follow those names verbatim — the
   table sketches above are that record, and the `*_at` suffixes on the Drizzle
   PROPERTY names never reach SQL. The exception is the early-instance tables
   that kept `created_at`/`updated_at` SQL names where upstream has the
   `*_unix` names — recorded, NOT renamed (no API surface reads SQL column
   names; a ~16-table rename buys nothing): `repositories`, `repo_transfer`,
   `users` (incl. `last_login_at` ← upstream `last_login_unix`,
   `models/user/user.go:124`), `personal_access_tokens`, `lfs_objects`,
   `lfs_locks` (upstream column is `created`, `models/git/lfs_lock.go:27`),
   `repo_watchers`, `repo_collaborators`, `follows`, `stars`, `repo_mirrors`
   (incl. `next_sync_at`/`last_sync_at`), `notification_states` (updated_at),
   `user_blocking`, `push_mirrors.next_sync_at` (its `created_unix` is parity).
   Ours-extra tables/columns with `-_at` names (`repo_settings`, `repo_imports`,
   `email_outbox`, `email_inbound`, `sessions`, `federation_followers`,
   `repo_redirects.created_at`, `user_redirects.created_at`, PAT
   `last_used_at`/`expires_at`) have no upstream counterpart — convention
   members, not divergences.
3. **`uid` → `user_id` — recorded rename.** Upstream's `UID int64` columns
   render `uid` under GonicMapper (confirmed by upstream's own SQL:
   `models/repo/star.go:73` `builder.Eq{"uid": …}`, `models/auth/
   twofactor.go:161`); ours renames them `user_id` in `personal_access_tokens`
   (SPEC-0002 §3), `stars`, `org_members`, `issue_user`, `team_members`,
   `email_addresses`, `two_factor` — clearer name (upstream's own newer tables
   use `UserID`: `models/user/follow.go:17`), zero API surface. `follow` is NOT
   a member (upstream `Follow.UserID` is already `user_id`), and
   `oauth2_application.uid` keeps upstream's name verbatim (parity exception).
4. **Association-table renames recorded** (upstream table → ours, beyond the
   plural rule): `hook_task` → `webhook_deliveries` (§3.6), `issue_watch` →
   `issue_subscriptions`, `review` → `pull_reviews`, `collaboration` →
   `repo_collaborators`, `watch` → `repo_watchers`, `team_user` →
   `team_members`, `team_repo` → `team_repo_access`, `org_user` →
   `org_members`, `mirror` → `repo_mirrors` (SPEC-0009 §3), `lfs_meta_object`
   → `lfs_objects` (SPEC-0006 §3), `upload`/`attachment` → `issue_attachments`
   + `release_assets` (§3.2 above), `notice` → `system_notices` (SPEC-0018
   §4.1), `access_token` → `personal_access_tokens` (SPEC-0002 §2.7),
   `user_setting` → `user_settings_kv` (user-notification-settings.md),
   `notification` → `notification_states` (email-outbound.md).

### 3.3 R2 key layout (additions)

```
repos/<storage_key>/release-assets/<release_id>/<asset_uuid>   # release asset blobs
repos/<storage_key>/attachments/<attachment_id>/<name>         # issue/comment attachment blobs
```

Bare keys only in D1 (`release_assets.r2_key`); `storage_key` keeps rename/transfer
inert (SPEC-0003 rule). Upload flow: `POST …/releases/{id}/assets` with
`multipart/form-data` (Worker streams the part straight to R2 via the storage service
layer) or `application/octet-stream` + `?name=`; for bodies above a threshold
(16 MiB, aligned with the SPEC-0001 multipart part size) the Worker instead issues a
**presigned R2 PUT bound to the announced size and `x-amz-checksum-sha256`** (gitorange
pattern, `docs/research/tech-route-survey.md` LFS section) and returns the upload URL;
the client confirms, the Worker verifies the R2 checksum, then inserts the D1 row.
Max asset size mirrors the `attachment` setting (default production cap 2048 MiB
upstream; ours fixed at 512 MiB until a settings SPEC) — over-limit → **413** before
streaming starts when `Content-Length` is known (SPEC-0001 T1 pattern).

The second key family above is the issue/comment attachment store (the landed
`issue_attachments` table, migration 0014, routes/issue-attachments.ts — the
`issueList/Create/Get/Edit/DeleteIssue(Comment)Attachment` ops): row-first landing
(the id is part of the key, so the row exists before the bytes and `r2_key` flips on
completion), the same 512 MiB cap, and the SPEC-0006 relay shapes — an inline
multipart/octet-stream POST (upstream's formData wire) or a body-less POST that
answers 201 + a `Location` upload URL into the worker-internal relay PUT
(`…/issues/attachments/{id}/blob`, plain-hono outside the frozen contract), with the
bytes served back by the matching GET under the issue-read ACL (download-count
increment parity with upstream's web ServeAttachment). Presigned PUTs remain a
release-assets-only deferral; the issue family ships relay-only from day one because
its payloads are small and the relay needs no S3 credentials. Upload allowed-types
whitelist reduced: upstream verifies the stored name's extension against
`ALLOWED_TYPES` and answers 422 on a miss (services/attachment/attachment.go:59,78
in the pinned tree — `upload.Verify(buf, attach.Name, allowedTypes)` over
`setting.Attachment.AllowedTypes`; pre-restructure cites
issue_attachment.go:196-198), while this instance gates attachment types at no
point (the release-assets posture), so the declared 422 arms are unreachable.

### 3.4 PR engine semantics (engine deltas)

Decisions, building on SPEC-0001's receive/serve paths and SPEC-0004 §6.2's
commit-builder flag:

- **We do create `refs/pull/N/head` in the base repo** (decision). Rationale: upstream
  clients and our own endpoints (diff, patch, commits, files, merge checks) all resolve
  the PR head through a git ref; fetchability of `refs/pull/N/head` is part of the
  observable contract (`services/pull/pull.go:542`); and per-repo-DO refs storage makes
  it cheap. The ref is written via the RepoDO ref transaction (same CAS machinery as a
  push), not D1.
- **Creation flow** (`POST /pulls`): validate base/head refs exist (engine read) →
  allocate index + insert `issues` + `pull_requests` in one D1 batch (status
  `checking`) → for fork PRs, the head objects move into the base repo via the
  **fork→PR relay** (`specs/0001b-merge-fork-primitives.md` §5.4: the fork's
  upload-pack feeds the base's receive-pack with a synthetic `refs/pull/N/head`
  command over our own protocol paths — zero new engine code; no cross-repo pack
  sharing, per the fork-model decision in 0001b §5.2) → RepoDO ref CAS write
  `refs/pull/N/head → headSha` (zero-id create) → run mergeability check inline
  (same as upstream's create-time check) → fan out webhooks. Ref-write failure after
  D1 commit: the D1 row is deleted again (upstream's cleanup order is the mirror:
  `services/pull/pull.go:157`).
- **Sync pushes**: at `finalizeReceive` (SPEC-0001 §5), for each branch-ref update the
  Worker looks up open PRs whose `(head_repo_id, head_branch)` matches (fork pushes
  included — the fork's own receive triggers it), and per PR: engine ref CAS
  `refs/pull/N/head old→new` (in the same RepoDO transaction as the branch commit —
  base-repo pushes that are a PR's own head touch nothing), update `pull_requests
  .head_sha`, recompute `commits_ahead/behind` (engine `rev-list --left-right --count`
  equivalent), set `status=checking`, enqueue the mergeability check (Queue), write a
  `pull_push` (29) comment (with `PushActionContent`), fire `pull_request_sync`.
  Force pushes mark the comment `is_force_push`. This mirrors `UpdatePullsRefs` +
  `CreatePushPullComment`.
- **Mergeability worker** (Queue consumer, per-PR message): engine-resident,
  read-only — one `checkMergeability(base, head)` RPC per PR
  (`specs/0001b-merge-fork-primitives.md` §4.3: bounded two-sided-BFS merge-base,
  three-way tree check, tree-oid equality for emptiness; **checks write nothing
  durable** — locked rule, 0001b §4.6). The Queue worker drives the RPC and results CAS-written to
  D1 (`status`, `conflicted_files`, `merge_base`, divergence) with the
  `UpdateColsIfNotMerged` guard (never overwrite a merged PR's row). A crashed check
  self-heals: any `GET …/pulls/{index}` observing `status=checking` re-enqueues.
- **Diff/patch/commits/files reads**: `GET …/pulls/{index}.{diffType}` and
  `/files` render `merge_base...refs/pull/N/head` (three-dot) through the engine diff
  builder (SPEC-0004 already routes these to the engine; this SPEC pins the *range*).
- **Merge execution**: `POST …/pulls/{index}/merge` requires `status=mergeable` (405
  otherwise), not WIP, not merged; then per style: `fast-forward-only` = engine ref CAS
  base→head (405 if not FF); `merge` = engine `mergeCommit(base, head)` two-parent
  commit + ref CAS; `squash`/`rebase`/`rebase-merge` = engine commit-builder replay of
  head commits (commit-builder per SPEC-0004 §6.2) + ref CAS; `manually-merged` =
  verify the given `MergeCommitID` is an ancestor of base (upstream semantics) or set
  `manually_merged`. All merges: mark `has_merged, merged_commit_id, merger_id,
  merged_unix`, close the issue with `merge_pull` comment, delete the base-repo PR
  head ref only on explicit head-branch deletion (upstream keeps the ref for merged
  PRs until the PR row is deleted), fire the `pull_request` closed/merged webhook, and
  bump `refs_version`-mirroring cache keys per SPEC-0004 §3.3. THE MERGE CLOSE'S
  ERROR SHAPE (as-built 2026-11-02, the manual-mark-on-deps-blocked fix): the close
  is upstream's `SetIssueAsClosed` INSIDE `MarkAsMerged`'s transaction
  (`services/pull/merge.go:838–843` — every failure wraps `ChangeIssueStatus: %w`
  and fails the WHOLE mark), so a close failure must not let the PR mark proceed:
  the ONE tolerated case is the already-closed race (a concurrent close loses the
  close CAS — `IssueAlreadyChangedError` — and the mark proceeds), everything else
  propagates. `DependenciesLeftError` reaches the close through the manually-merged
  style (upstream's `CheckPullMergeable` skips the dependencies arm for the
  Manually check type, `check.go:161–165`) and through a dependency added between
  the engine's pre-gate and the close; it lands NOTHING (the deps gate sits before
  the close CAS and the PR update never runs) — the web handler's
  `MergedManually` default arm ServerErrors and the API falls to
  `APIErrorInternal` (500).

### 3.5 Webhook fan-out in our write paths

A single service boundary `notify.emit(event, payload, repo)` (mirroring
`services/notify` + `services/webhook/notifier.go`):

1. resolve matching hooks: repo hooks ∪ owner hooks ∪ system hooks where `is_active`
   and `HasEvent(event)` and branch-filter passes (D1 read);
2. build the payload JSON once (2-space `JSON.stringify`-equivalent formatting to
   match upstream's `MarshalIndent(p, "", "  ")` byte shape);
3. one D1 batch inserting one `webhook_deliveries` row per hook
   (`state='pending'`, `uuid = crypto.randomUUID()`, `payload_content`, `event_type`)
   — fired **after** the mutation's own transaction commits (inside
   `ctx.waitUntil`), so webhook failure can never roll back the mutation (upstream
   likewise inserts tasks after the fact);
4. enqueue one Queue message `{deliveryId}` per row (batch send).

Fan-out points, mapped to our service modules: issue create/close/reopen/edit/delete;
label/milestone/assignee change; comment create/edit/delete; PR create/sync(push)/
merge/target-change/review(tier 2)/review-request(tier 2); push pipeline
(`push`, `create`, `delete` + close-via-commit §2.5); release publish/update/delete;
status create; repo create/delete/rename/fork (repository events).

### 3.6 Webhook delivery (Cloudflare Queues)

- **Queue**: `webhook-delivery` (producer: API/Worker write paths; consumer: delivery
  worker). Message: `{deliveryId}` only — the payload lives in D1, so retries always
  read fresh config and the delivery log is complete regardless of queue state.
- **Consumer algorithm** per message:
  1. CAS `UPDATE webhook_deliveries SET state='delivering', attempts=attempts+1 WHERE
     id=? AND state='pending'` — 0 rows ⇒ already handled ⇒ ack (idempotent redelivery
     guard, mirrors upstream `MarkTaskDelivered`);
  2. read webhook row; `is_active=false` ⇒ record `state='skipped'`, ack;
  3. sign: `hmac-sha256` and `hmac-sha1` over the stored `payload_content` bytes with
     the secret (WebCrypto `crypto.subtle`); build headers per §2.6 (delivery uuid,
     event group/type, target type, signatures, `X-Hub-Signature(-256)`);
  4. POST `application/json` (or form/GET variants for parity), 5 s timeout via
     `AbortSignal.timeout(5_000)`;
  5. read response headers + body **capped at 1 MiB**; record `request_content` /
     `response_content` JSON (headers, status, body; Authorization masked);
     `state='delivered'`, `is_succeed = 2xx`; update `webhooks.last_status`.
- **Retry policy — mirrors upstream: failed deliveries do not retry.** A network
  error or non-2xx is terminal: the row stays `is_succeed=0, state='delivered'` and
  surfaces in `GET …/hooks/{id}/deliveries`; the user replays explicitly (re-enqueue a
  copy with a new uuid — upstream `ReplayHookTask`). Rationale: upstream behavior is
  the compat contract (§2.6), and auto-retrying arbitrary third-party endpoints from a
  queue fans outage load. Queue-level redelivery exists only for **consumer crashes**
  (message not acked): max 3 delivery attempts with Queues exponential delay; the CAS
  in step 1 makes those no-ops if the first attempt actually completed.
- **Poison / DLQ**: a consumer that cannot persist its outcome (D1 unavailable) leaves
  the message un-acked; after max deliveries Cloudflare moves it to the configured
  **dead-letter queue** (`webhook-delivery-dlq`), whose consumer logs and marks the
  stuck rows `state='failed'` on the next sweep (RepoDO-alarm-style periodic job) so
  the delivery list never shows a perpetual `delivering`. A maliciously bad target URL
  (e.g. unreachable host) costs one attempt per event, never a retry loop.
- **`POST …/hooks/{id}/tests`**: builds the payload from current repo state (upstream
  sends a representative payload per selected event) and enqueues directly,
  bypassing event subscriptions and branch filter (upstream `PrepareTestWebhook`,
  `services/webhook/webhook.go:132–137`).
- **Egress**: webhook fetches run in the Queue consumer's own subrequest budget
  (SPEC-0004 §4 rule); an event hitting N hooks costs N messages, not N subrequests in
  one request context. SSRF: target URL validated against the instance allow-list
  setting (upstream `security.ALLOWED_HOST_LIST` semantics); loopback/metadata
  addresses denied by default.

## 4. Edge cases, limits, and failure modes

| # | Case | Behavior |
|---|---|---|
| 4.1 | **Concurrent issue creation on one repo** | Both requests run `repo_counters` bump + insert in their own D1 batch; D1's single-writer serialization orders them; each gets a distinct, strictly increasing `index`. A failed batch rolls back its bump (no gaps). Verify with a 20-parallel-create test asserting a 1..20 permutation (§5.2). |
| 4.2 | **Concurrent create vs close** | Close is CAS-guarded (`WHERE is_closed=0`) exactly as upstream; a close racing a reopen produces one `ErrIssueAlreadyChanged`-equivalent 409-free no-op for the loser (upstream surfaces it as an error to the API caller — we map to a 409 with the standard error body). |
| 4.3 | **PR sync force-push** | `refs/pull/N/head` CAS `old→new` against the *recorded* head_sha; mismatch ⇒ re-read (the recorded value is a cache). Divergence recomputed; `pull_push` comment with `is_force_push=true`. |
| 4.4 | **Head branch deleted while PR open** | The PR stays open; `refs/pull/N/head` still resolves (objects are base-local after the 0001b §5.4 relay / same-repo PR pushes, and the ref is untouched by a branch delete — upstream behavior, `services/repository/push.go pushDeleteBranch` does not touch PR refs; the base-local guarantee is `specs/0001b-merge-fork-primitives.md` §5.5). Merge of a head-less PR: base re-resolves via stored `head_sha`; only GC of a *merged-and-cleaned* PR can void objects (refs are reachability roots while the ref exists — M3 compaction policy, no new mechanism). |
| 4.5 | **Base branch retarget / base pushed** | `status` recomputed by the mergeability worker (merge-base moves); `ancestor` status ⇒ UI/API shows "already merged" semantics; merge attempt → 405. |
| 4.6 | **closeViaCommit on a push to a non-default branch** | Honors `CloseIssuesViaCommitInAnyBranch` (repo column, default false): closes only if the pushed branch is the issue's `ref` branch or the repo default; PR merge commits referencing their own PR are skipped (`isSelfReference`). Permission: closer must be repo admin/owner, have issue-write, or be the issue poster. |
| 4.7 | **Comment editing** | Upstream imposes **no time window** on comment edits; edits bump `content_version` + `updated_unix` and (for title/body-level edits) rewrite xref scans (neutering stale ones). We mirror: no window; `changes{body:{from}}` in the `issue_comment` edited webhook payload. |
| 4.8 | **Webhook target down / slow** | One attempt, 5 s timeout, terminal failure recorded with the error text in `response_content.body` (upstream stores `Delivery: <err>`); no retry storm; replayable by the user. Consumer crashes → Queues redelivery → CAS no-op. |
| 4.9 | **Delivery log growth** | Upstream cleans `hook_task` by cron (`OlderThan`/`PerWebhook`, `models/webhook/hooktask.go:218–280`, the registered `cleanup_hook_task_table` task, `services/cron/tasks_basic.go:124–135`). As-built there is no separate "D1 maintenance queue": `cleanupWebhookDeliveries` (keep the newest 100 terminal rows per webhook, drop terminal rows older than 30 days — function options, defaults = upstream's) AND the §3.6 `sweepStuckDeliveries` pass are driven through REPO_TASKS. Producer: the hourly cron entry (`0 * * * *`, the services/demo-sweep.ts dispatcher's webhook-maintenance block) runs TWO existence probes — any `delivering` row older than the 15-minute stuck threshold (`WEBHOOK_STUCK_AFTER_SECONDS`), any terminal row older than the 30-day age cutoff (`WEBHOOK_DELIVERY_AGE_DAYS`) — and enqueues at most ONE `{kind: "webhook-maintenance"}` message; no work → zero sends (a quiet tick costs two LIMIT-1 reads). Consumer: the serialized REPO_TASKS arm (repos/purge.ts) runs the stuck sweep FIRST — a delivery consumer dying between the §3.6 pending→delivering CAS and the outcome write leaves the row in `delivering` forever (the delivery-queue redelivery CAS no-op-acks it), so the sweep is the designed safety net and must precede the cleanup — then the cleanup, and acks; a throw retries the idempotent message. |
| 4.10 | **Release asset upload interrupted** | Presigned PUTs expire (1 h); an R2 object with no confirmed D1 row is swept by the storage-layer orphan sweep (SPEC-0001 pattern, prefix `release-assets/`, mtime > 24 h). Checksum mismatch at confirm → delete object, 422. |
| 4.11 | **Release/tag divergence** | Creating a release for an existing tag attaches to it (upstream reads the sha from the tag; as-built the fill LANDED with the UpdateRelease tag wave — `sha1`/`num_commits`/the commit-dated `created_unix` fill from the tagged commit on published creates and re-fill on every published edit, drafts staying null until the publish-from-draft edit fills them; §2.3 as-built note); `409` when the repo already has a release row for the tag (upstream `ErrReleaseAlreadyExist`). A fresh `tag_name` creates the git tag from `target_commitish` via the shared tag-store service (§2.3 as-built note). Deleting a release keeps the tag; deleting a tag-only record (`is_tag`) deletes the tag via the engine ref CAS. |
| 4.12 | **Issue delete cascade** | One D1 batch: comments (incl. xref rows where `ref_issue_id` or `dependent_issue_id` points here), `issue_labels`, `reactions`, `issue_subscriptions`, `issue_pins`, `pull_requests` (+ RepoDO `removeRef refs/pull/N/head` for PRs, `waitUntil`), status rows untouched (they are sha-scoped). Counter rows are *not* rewound. |
| 4.13 | **Repo delete** | Webhook rows + deliveries die with the repo's D1 purge (SPEC-0003 §2.5); in-flight Queue messages hit missing rows and ack as `skipped`; R2 `release-assets/<release_id>/` keys are covered by the `repos/<storage_key>/` prefix purge — hence assets live **under** the repo prefix. |
| 4.14 | **Archived repo** | Every mutation in this SPEC's surface → 423 (SPEC-0004 §4); includes issue create/comment/label ops, PR create/merge, webhook CRUD, `hooks/{id}/tests`. EXCEPTION — release create/edit → **500** (upstream gates them INSIDE `createTag`, `services/release/release.go:75–78`, not with the 423 middleware; §2.3). |
| 4.15 | **Issues disabled (`has_issues=false`)** | Issue/label/milestone routes → 412; PR routes stay live (external-tracker pattern, SPEC-0004 §4). |
| 4.16 | **Payload size limits** | Webhook payload stored in full in D1 (`payload_content` text); a push payload is bounded by the 5-commit cap (§2.5) + `PayloadCommit` shape; issue/comment `content` capped by API limits (mirroring upstream LONGTEXT reality — enforce 16 MiB request-body cap at the router). |

## 5. Testing plan

### 5.1 Unit (D1-backed, `@cloudflare/vitest-pool-workers`)

Real local D1/DO/R2 per ADR D4. Per service module:

- Number allocation: parallel `POST /issues` (20×, `Promise.all`) on one repo →
  unique, dense 1..20; PR-then-issue interleave shares one sequence; delete + recreate
  does not reuse an index; counter repair function re-syncs after manual row delete.
- Issue lifecycle: open→close→reopen transitions, counters on repo/milestone/label,
  CAS close-race loser behavior, title truncation at 255, lock gating.
- xref scanner: golden table of `#N`, `owner/repo#N`, `ABC-123`, keyword forms
  (`fixes/closes/resolves`, `reopens`) over title/body/comment, neutering on edit —
  port test vectors from `gitea/models/issues/issue_xref_test.go` and
  `modules/references/references_test.go`.
- Releases: draft visibility (writer-only), `latest` filter (draft/prerelease/tag
  excluded), tag-create coupling, duplicate-tag 409, asset name duplication allowed.
- Delivery record: CAS semantics (double-consume no-op), signature computation vs
  known HMAC vectors, masked Authorization in stored request.

### 5.2 Integration (worker + engine + queue, local receiver)

- **Webhook delivery integration test**: the Worker under test registers a repo hook
  pointing at an in-test HTTP receiver (a `fetch` handler stub served from the same
  workerd test via a stub-queue consumer driving the delivery function directly, plus
  one true end-to-end pass against `wrangler dev` + a local `netcat`-style receiver in
  CI). Assert: exact headers (§2.6), signature verifies against the received raw body,
  2xx → `is_succeed`, 500 + timeout → terminal failure recorded, replay endpoint
  re-delivers with a new uuid, inactive hook skipped, branch filter suppresses a
  `push` to a non-matching branch.
- **PR flow e2e**: push base (e2e harness SPEC-0001 §6) → create PR (API) → assert
  `refs/pull/1/head` fetchable via `git fetch` → push to head branch → head ref moved,
  status `checking`, `pull_request_sync` payload recorded → make conflict →
  `conflict` + `conflicted_files` → resolve via push → `mergeable` → merge (each
  style) → base branch advanced, issue closed, `merge_pull` comment, closed/merged
  webhook payload recorded.
- **closeViaCommit e2e**: push commit with `fixes #1` to default branch (closes), to a
  side branch (no close, `commit_ref` comment only), flip `CloseIssuesViaCommitInAnyBranch`
  → closes.

### 5.3 Contract tests against upstream payload fixtures

Extract from `gitea/services/webhook/general_test.go` (committed verbatim into
`src/compat/fixtures/webhook/`): `pushTestPayload()` (PushPayload with
`2020558f…` commit pair, `refs/heads/test`), `issueTestPayload()` (IssuePayload
`number:2` + embedded Issue/Repository/Sender), `issueCommentTestPayload()`
(created + `is_pull` PR variant). Test: our notifier built from equivalent fixture
entities serializes to **byte-identical JSON** (2-space indent) for the gitea type,
and JSON-equal for the embeddable API objects; regression-locked per event type
(issue opened/closed, comment created, push, create, release published).

Route/response conformance for the category-(d)/(e) endpoints rides SPEC-0004 §5's
three CI stages (route check, schema diff, dynamic compat suite) — this SPEC adds the
payload-fixture stage above as a fourth check in the same job.

## 6. Open questions

1. **Engine diff/merge primitives** (§3.4): the Worker-side three-way merge check and
   diff builder need SPEC-0001 amendment alongside the commit-builder entry point
   (SPEC-0004 §6.2) — one combined engine-spec addendum before PR routes are
   implemented.
   **Resolved 2026-10-24: `specs/0001b-merge-fork-primitives.md`** (merge-base,
   three-way tree merge, mergeability classification, merge execution, rebase replay,
   range walks, CAS ref delete — engine-resident typed RPCs; §3.4 above updated).
2. **`copyObjects` op cost model** (§3.4): reachable-set pack copy for fork PRs on
   large forks — measure; if too heavy for the create path, defer to the
   mergeability worker (PR visible as `checking` until the ref lands) or adopt lazy
   cross-repo object resolution in the engine (touches the storage interface; decide
   at implementation with numbers).
   **Resolved 2026-10-24: replaced by the fork→PR relay** (0001b §5.4) — no
   reachable-set pack writer exists or is needed; PR-visible cost is one
   protocol-level transfer per PR creation.
3. **Webhook `GET`/`form` method variants**: upstream supports GET-webhooks (payload
   in query) and form content type; they are rarely used. Ship JSON POST first and
   document the divergence, or full parity from day 1? Recommendation: full parity —
   it is ~20 lines in the delivery worker.
4. **Issue search ranking** (§1): `GET /repos/issues/search` semantics beyond
   LIKE-matching (upstream uses indexers); revisit at tier 2.
5. **Combined-status aggregation order** for `commits/{ref}/status`: follow SPEC-0004
   §6.6's oracle-run decision; the table here only stores the rows.
6. **Reaction endpoints** are tier 2 (SPEC-0004 appendix A); the `reactions` table
   ships now so issue payloads carrying `reactions` counts (API Issue object) can be
   maintained incrementally instead of computed per read. If counts drift, a
   recount-job (upstream's `UpdateIssueReactions` pattern) is the fallback.

## 7. FN-2 port (as-built)

**Status: LANDED (FN-2 port unit, 2026-11-03).** Derived by the FN-2
derivation-prep unit (GJ, 2026-11-03) from the upstream pin `fc4936884584`
and the then-current worktree; the full write-site matrix with file:line
cites lives in `docs/research/table-alignment-audit.md` §4 `comment` (the
entry's FN-2 derivation expansion). The section keeps the derived plan's
structure; **As-built** notes record where the port deviated or resolved an
open point. The landed artifacts: the five `comments` columns
(`src/db/schema.ts`), migration `0067_comment-mutation-metadata.sql` (+ the
snapshot + journal entry), the write seams (`api/services/projects.ts`,
`api/services/issues.ts`, `api/routes/pull-reviews.ts`, the time twins in
`ui/pages/issue-timeline-writes.ts` + `api/routes/issue-tables-t2.ts`), the
de-hardcoded read arms (`api/services/issues.ts`'s timeline render), and the
test battery (`src/db/schema.test.ts`'s FN-2 describe; the FN-2 describes in
`ui/pages/issue-timeline-writes.test.ts`, `api/routes/issue-tables-t2.test.ts`,
`api/routes/pull-reviews.test.ts`, `src/api/issues.test.ts`).

**The audit-count correction this plan is built on:** upstream has NO
`patch_quoted` column — the Go field `PatchQuoted` carries the xorm
column-name override `xorm:"LONGTEXT patch"` (`models/issues/comment.go:330`),
so upstream's persisted column is literally `patch`, and ours
(`comments.patch`, §3.2) is PARITY, not ours-extra. FN-2 therefore adds **7
columns**, and `comments.patch` needs no DDL and no writer change.

### 7.1 Scope

- **In**: the 7 `comments` columns (§7.2); threading the live write seams
  (§7.3); de-hardcoding the timeline render arms (§7.4); one generated
  migration with the row backfills (§7.5); the test battery (§7.6).
- **Out (recorded, not planned blind)**:
  - `original_author`/`original_author_id` WRITERS — no comment-migration
    inflow exists here (upstream's only writer is the repo-migration
    uploader's `RemapExternalUser`, comment.go:1279-1283 via
    `services/migrations/gitea_uploader.go:1010-1026`; readers: `ToAuthor`
    ghost-fallback `services/convert/user.go:53-58`, migrated-author
    template `comments_authorlink.tmpl:1-8`, `HasOriginalAuthor` role
    descriptor comment.go:1295-1298). Port-when-read, with the FN-9 family.
  - CODEOWNERS review-request attribution (`SpecialDoerName` in
    `comment_meta_data`, review.go:756/:867) — no CODEOWNERS surface here.
  - Project-workflow comment metadata (the ctx carrier, comment.go:261-266 +
    `workflow_notifier.go:145`) — our workflows reuse the human write path
    (`services/projects-workflow.ts:510-560`); the reader arms (workflow
    author attribution `MetaSpecialDoerTr` comment.go:806-819; the
    label-merge guard `sameCommentMetaData`, `routers/web/repo/
    issue_view.go:221-231) do not exist in our surface (the UI renders no
    label or type-31 timeline events this wave, `ui/pages/
    issue-detail.tsx:734-746`).
  - Upstream's invalid-UTF-8 `strconv.Quote` guard on the patch column
    (comment.go:402-415/:418-426) — ours stores the raw engine diff; a
    no-op for valid UTF-8. Record, do not build.

### 7.2 Schema (the DDL the port unit lands)

`comments` gains, in upstream column-name/case (`models/issues/comment.go`
field order):

| column | upstream field (cite) | DDL |
|---|---|---|
| `original_author` | `OriginalAuthor string` (comment.go:280) | `text` NULL — **land-or-defer decision below** |
| `original_author_id` | `OriginalAuthorID int64` (comment.go:281) | `integer` NULL — same decision |
| `old_project_id` | `OldProjectID int64` (comment.go:291) | `integer` NULL |
| `project_id` | `ProjectID int64` (comment.go:292) | `integer` NULL |
| `time_id` | `TimeID int64` (comment.go:301) | `integer` NULL |
| `assignee_team_id` | `AssigneeTeamID int64` (comment.go:307) | `integer` NOT NULL DEFAULT 0 (the tag's literal) |
| `comment_meta_data` | `CommentMetaData *CommentMetaData` JSON (comment.go:360) | `text` NULL, JSON-serialized `CommentMetaData` `{project_column_id?, project_column_title?, project_title?, project_workflow_event?, special_doer_name?}` (struct :249-257) |

- None of the 7 carries an upstream index tag — add none.
- **original_author pair decision point**: DEFER is cleaner (port-when-read,
  zero readers/writers); LAND-now buys table-parity in one migration and no
  later DDL revisit. Recommendation: DEFER to FN-9 (the family carrier) —
  the audit classifies the pair port-when-read, and ADR-0007 queues
  port-when-read with its reader. The port unit should surface the choice
  in its SPEC record either way.
  **As-built: DEFER taken** — the migration and schema carry five columns;
  the pair is FN-9's carrier per SPEC-0005 §9 (the audit's §7.11 record).
- `comments.patch`: **no DDL, no change** (the §7-parity erratum).
  **As-built: held** — the column rides untouched; the battery pins it
  (schema.test.ts's column list + the pull-reviews patch-store regression
  pin).

### 7.3 Write seams to thread (our seam → upstream writer)

1. **Type-30 project comments** — ours: `writeProjectComment`
   (`api/services/projects.ts:820-840`, type-30 cells at :914 add /
   :967 remove) and the issues-service twin `writeIssueProjectComment`
   (`api/services/issues.ts:2249-2266`, cells :2359 remove / the add arm
   via `addIssueToColumn` → projects.ts:914). Upstream:
   `models/issues/issue_project.go:90-99` (remove:
   `OldProjectID: projectID, ProjectID: 0`) and :138-147 (add:
   `OldProjectID: 0, ProjectID: projectID`). Port: write the ids into the
   columns and set `content` to `''` (upstream's type-30 content is empty —
   ours carries the JSON payload, which today LEAKS into the timeline API's
   `body` via `timelineBodyOf`'s passthrough, `issues.ts:1143-1157`).
2. **Type-31 column-move comments** — ours: `moveIssueWithinProject`
   (`api/services/projects.ts:1055-1062`, payload
   `{project_id, project_column_id, project_column_title}`). Upstream:
   `services/projects/issue.go:180-191` (opts `ProjectID`/`ProjectTitle`/
   `ProjectColumnID`/`ProjectColumnTitle` → `buildCreateCommentMetaData`,
   comment.go:847-864). Port: `project_id` → the column;
   `{project_column_id, project_column_title, project_title}` →
   `comment_meta_data`; `content` → `''`. **Add `project_title`** — ours
   omits it today; upstream's metadata carries it and the type-31 template
   reads it (`comments.tmpl:586-591`). **As-built: exactly this** — the
   move arm already receives the project row, so `project_title` lands with
   no signature change.
3. **Time-family comments** — ours: `applyTimeAddWrite`
   (`ui/pages/issue-timeline-writes.ts:759-773`) and the API-port twins
   (`api/routes/issue-tables-t2.ts:1541-1549` add; `finishStopwatch`
   :1070-1093 stop; the web twin `ui/pages/issue-timeline-writes.ts:815-833`
   stop). Upstream: add-time-manual stamps `TimeID: t.ID`
   (`tracked_time.go:180-189`, cell :188) and stop-tracking stamps
   `TimeID: tt.ID` (`stopwatch.go:156-164`, cell :162); the delete/start/
   cancel arms stamp none (tracked_time.go:256-263, :280-287;
   stopwatch.go:194-201, :222-230). Port: the trackedTimes INSERT and the
   comment ride the same drizzle batch — add `.returning({ id })` to the
   trackedTimes leg and stamp `time_id` from it. delete/start/cancel arms
   stay column-less (parity). **As-built: the batch SPLIT instead** — a
   drizzle batch leg cannot reference a prior leg's returning id, so the
   trackedTimes insert runs alone and the comment/fold batch follows
   (upstream's own statement order; in the `finishStopwatch` twins the
   stopwatch delete stays LAST in the follow-up batch so a phase-1 failure
   cannot bank time while losing a running stopwatch). The stamps are
   exactly the plan's.
4. **Team review-request comments** — ours: the API team arms
   (`api/routes/pull-reviews.ts:1596-1602` add, :1699-1706 remove — both
   write neither id arm today). Upstream: `models/issues/review.go:859-869`
   (add, `AssigneeTeamID: reviewer.ID`) and :916-928 (remove, same stamp).
   Port: stamp `assigneeTeamId = team.id` in both arms; the user-request
   arms (`api/services/pull-reviews.ts:498-507`/:585-594) keep
   `assigneeId` (upstream's AssigneeID path, review.go:748-758) untouched.
   **As-built: exactly this.**

### 7.4 Read arms to de-hardcode

- `toTimelineComment` (`api/services/issues.ts:1335-1442`):
  - `old_project_id: 0` / `project_id: 0` (:1421-1422) → the row's values.
    Contract shape unchanged (`modules/structs/issue_comment.go:68-69`) —
    ADR-0002-safe.
  - `assignee_team: null` (:1437) → when `assigneeTeamId > 0`, resolve the
    team row (one batched map alongside the existing preload maps, the
    milestone/label/assignee pattern) and render the contract `Team` shape
    (upstream `ToTeam`, `services/convert/issue_comment.go:179-181`).
  - `trackedTimeOfComment` (:1207) → read `time_id` FIRST (exact-row
    linkage, upstream `LoadTime` comment.go:732-739); keep the
    (poster, seconds, second) correlation ONLY as the legacy-row fallback
    while pre-migration rows exist, then drop (§7.7).
- **No UI arm changes**: `issue-detail.tsx:734-746` renders types
  0/1/2/28 only this wave; nothing to thread there.

**As-built (§7.4)**: all three arms landed in `api/services/issues.ts` —
the project ids read the row's columns (the Go zero for NULL), the team arm
resolves through `prefetchTimelineContext`'s batched `teams` map (the
milestone/label/assignee pattern, with a dangling id DROPPING the row —
upstream LoadAssigneeUserAndTeam's GetPossibleTeamByID error arm →
ToTimelineComment's nil — and the render being convert.go's ToTeam with no
org load, replicated in the service since routes/org-teams.ts's `toApiTeam`
is route-local), and `trackedTimeOfComment` reads `time_id` first with the
correlation demoted to the fallback (its docstring is the removal marker).
One precision beyond the plan: the LoadTime call now gates on
`time_id > 0` for ANY row type (upstream LoadTime's own early return is
TimeID == 0 — not a type gate), with the correlation arms still scoped to
the 13/14 family.

### 7.5 The migration (one generated migration + backfills)

DDL first (§7.2), then, in the same migration, idempotent backfills:

1. **Type-30/31 content → columns**: for `type IN (30, 31)` rows whose
   `content` parses as the landed payload JSON: `old_project_id`/
   `project_id` from the payload keys (`{old_project_id, project_id}` —
   `projects.ts:914/:967`; `{project_id, project_column_id,
   project_column_title}` — :1060), type-31 also fills `comment_meta_data`
   with `{project_column_id, project_column_title}`; then set
   `content = ''` for the migrated rows (upstream-parity body). A
   non-parsing or missing-key row is left verbatim (conservative arm — no
   crash, recorded).
2. **`time_id` backfill**: type-14 rows with the `|<seconds>` content —
   the newest live `tracked_times` row matching
   `(issue_id, user_id = poster_id, seconds)` at or before the comment's
   `created_unix`; type-13 rows — the newest live row created in the
   comment's own second. This is exactly `trackedTimeOfComment`'s
   documented correlation (`issues.ts:1183-1196`) applied once; rows it
   cannot pin stay NULL and keep riding the fallback reader.
3. **`assignee_team_id` backfill**: type-27 rows with `assignee_id` NULL
   and `review_id > 0` — join `pull_reviews.reviewer_team_id`
   (`schema.ts:2447`; the team-add arm writes `reviewId: review.id`,
   `pull-reviews.ts:1596-1601`). `assignee_team_id` defaults 0 elsewhere.

**As-built (§7.5)**: migration `0067_comment-mutation-metadata.sql` — five
ALTERs (upstream ALTER order: old_project_id, project_id, time_id,
assignee_team_id, comment_meta_data — SQLite appends, so the physical order
is the ALTER order, not the struct order), then the four backfill UPDATEs.
Two recorded precisions beyond the plan: (a) every JSON gate pins BOTH the
`json_valid` parse AND the payload key KINDS (`json_type` = 'integer'/'real'
for ids, 'text' for the column title — a null/string id or a non-object
payload fails the row untouched, widening the conservative arm), and (b) the
type-31 backfilled metadata carries the TWO recoverable keys only —
`project_title` is not reconstructible from the old payload (the writers'
pre-port payloads never carried it); only rows written by the new writer
carry the three-key metadata. Verified applied + backfilled on seeded
old-shape rows in the local D1, and pinned by the schema.test.ts FN-2
describe (the backfill statements verbatim, the FN-6 technique).

### 7.6 Test battery design (names + asserted shapes; no code)

All D1-backed (`@cloudflare/vitest-pool-workers`), `pnpm test` per file,
never cited as suite-green (ADR-0006):

1. `fn2-schema-columns-present` — after the migration,
   `table_info(comments)` carries the 7 columns; `assignee_team_id`
   NOT NULL DEFAULT 0, the other 6 NULLable; no new indexes.
2. `fn2-project-comment-columns` — both type-30 arms (add/remove, both
   services) write `project_id`/`old_project_id` per the arm matrix,
   `content === ''`, `comment_meta_data` NULL; `num_comments` unchanged
   (the type-30 no-count rule, issues.ts:2241-2247).
3. `fn2-project-column-comment-metadata` — a real column move writes the
   type-31 row with `project_id` set, `comment_meta_data` =
   `{project_column_id, project_column_title, project_title}`,
   `content === ''`; a no-op move (same column) writes nothing.
4. `fn2-time-comments-time-id` — add-time writes `time_id` = the
   batch-mate `tracked_times.id`; stop-tracking writes `time_id` = the
   banked entry's id; delete/start/cancel leave `time_id` NULL.
5. `fn2-timeline-time-render-exact` — `toTimelineComment` renders
   `tracked_time` from the EXACT `time_id` row (assert `user_name`/
   `seconds` of the pinned entry, not a heuristic twin); a dangling
   `time_id` reproduces upstream's drop-the-row arm (the row filtered
   from the timeline, `issues.ts:1306-1316` shape).
6. `fn2-team-review-request-assignee-team` — team request add → type-27
   row with `assignee_team_id = team.id`, `assignee_id` NULL,
   `review_id` set; remove → `assignee_team_id` set +
   `removed_assignee = 1`; user-request rows keep `assignee_id` and
   `assignee_team_id = 0`.
7. `fn2-timeline-assignee-team-render` — a team-request row's timeline
   entry carries `assignee_team` (the contract Team shape: `id`, `name`,
   and `ToTeam`'s emitted fields), `assignee` null; a user-request row
   renders `assignee` and `assignee_team` null.
8. `fn2-timeline-project-ids-render` — timeline entries emit real
   `old_project_id`/`project_id` for type-30/31 rows (fresh + backfilled)
   and `0` for every other type; the type-30 `body` is `""` (not JSON).
9. `fn2-backfill-from-content-json` — seed pre-migration rows (type-30
   JSON payloads from both writer shapes, type-31 payload, type-14
   `|<seconds>`, type-13, type-27 with `review_id`) → run the migration →
   every backfill lands and migrated 30/31 rows have `content = ''`.
10. `fn2-backfill-conservative-arms` — a type-31 row with non-JSON
    content, and a type-14 row with no matching `tracked_times` entry:
    migration leaves them verbatim/NULL, no failure.
11. `fn2-patch-parity-unchanged` — code-comment create + reply still
    write and render `comments.patch` (regression guard pinning the
    "no DDL on patch" erratum).
12. `fn2-timeline-body-passthrough-regression` — non-project types keep
    the `timelineBodyOf` behavior (time humanization, estimate string,
    verbatim bodies) — the port must not widen the body rewrite to
    non-project types.

**As-built (§7.6)**: all twelve landed, D1-backed; the file homes —
1 → `schema.test.ts` (DDL, types/defaults, the untouched `patch`, the four
pre-0067 indexes pinned exactly); 2/3 → the FN-2 describe in
`ui/pages/issue-timeline-writes.test.ts` (service-level, both arms + the
no-op move); 4 → the FN-2 describes in `issue-timeline-writes.test.ts` (web
twins) and `api/routes/issue-tables-t2.test.ts` (API twins); 5/7/8/12 → the
FN-2 describe in `src/api/issues.test.ts` (route-level renders over
`prefetchTimelineContext`'s batched path); 6 → the FN-2 describe in
`api/routes/pull-reviews.test.ts`; 9/10 → `schema.test.ts` (the backfill
statements verbatim against seeded old-shape rows, the conservative arms
including the wrong-kind-payload cases); 11 → `pull-reviews.test.ts` (the
patch-store regression pin beside the existing diff-hunk battery). The
schema describe additionally pins `assignee_team_id`'s DEFAULT-0 read and
the migration's no-new-index invariant. The stale pre-port assertions that
pinned the type-30/31 content JSON (issues.test.ts's ⑯-P3-4 pair,
projects-repo/org.test.ts's column-issues ladders) were updated to the
columns shape in the same change — they were pins of the superseded
adaptation, not independent parity arms.

### 7.7 Open items for the port unit — all RESOLVED as-built

- The `trackedTimeOfComment` heuristic: keep as legacy fallback through one
  release after the backfill (rows the backfill could not pin), then drop;
  the docstring at `issues.ts:1183-1196` is the removal marker.
  **RESOLVED: the fallback is IN PLACE** (the exact `time_id` arm reads
  first); the docstring carries the removal marker — the drop is a future
  unit's cleanup, not this port's.
- `finishStopwatch`'s batch needs the trackedTimes leg switched to
  `.returning({ id })` in BOTH twins (web + API ports) — batch leg ordering
  is preserved by drizzle, but verify the returned id is the comment's
  batch-mate (same batch, sequential).
  **RESOLVED: the batch split** (§7.3 as-built) — the insert runs alone,
  the returning id is then a plain constant in the comment batch; the
  battery asserts the stamp equals the batch-mate entry's id in all four
  writers (web add/stop, API add/stop).
- The `project_title` addition to type-31 metadata (§7.3 item 2) — confirm
  the board UI's move entry passes the project row (it does today via
  `moveIssueToColumn(project, …)`). **RESOLVED: confirmed + asserted** (the
  metadata toEqual pins all three keys).
- The original_author DEFER-vs-LAND decision (§7.2) — the port unit's SPEC
  record states the choice; FN-9 remains the family carrier if deferred.
  **RESOLVED: DEFER** (§7.2 as-built; SPEC-0005 §9 is the record, FN-9 the
  family carrier).

## 8. FN-5 rename plan — PLAN ONLY

**Status: PLAN ONLY. Nothing is built; no migration has been generated.**
Derived by the GM-resume unit (2026-11-03) from the upstream pin
`fc49368845`; the derivation record (per-member verification, the
same-class sweep, blast-radius counts, and the drizzle migration-shape
evidence) is the audit doc's §7.10. This section is the port unit's
normative plan.

### 8.1 Scope — the 18 renames (17 columns + 1 table)

Ours → upstream's literal DDL. Ours cites are schema.ts snapshots
(working-tree, per the audit's own convention); upstream cites verified
at the pin. Every tag reading applies the audit §1 override rule
(GonicMapper runs only when the tag does not name the column; a quoted
first token pins a legacy name).

| # | table (ours) | column rename | upstream cite | ours cite | note |
|---|---|---|---|---|---|
| 1 | `repo_transfer` | `team_ids` → `team_i_ds` | models/repo/transfer.go:72 (`TeamIDs` untagged) | :332 | mapper |
| 2 | `protected_tags` | `allowlist_team_ids` → `allowlist_team_i_ds` | models/git/protected_tag.go:28 (`JSON TEXT` tokens only) | :3133 | mapper |
| 3 | `protected_tags` | `allowlist_user_ids` → `allowlist_user_i_ds` | models/git/protected_tag.go:27 (same) | :3131 | mapper |
| 4 | `protected_branches` | `rule_name` → `branch_name` | models/git/protected_branch.go:34 (quoted `'branch_name' UNIQUE(s)`) | :2573 | quoted pin |
| 5 | `protected_branches` | `rules` → `config` | models/git/protected_branch.go:38 (quoted `'config' JSON LONGTEXT`) | :2579 | quoted pin |
| 6 | `project_columns` | TABLE → `project_board` | models/project/column.go:66-68 (`TableName()` override; upstream TODO keeps the legacy name) | :2995 | table rename |
| 7 | `project_columns` | `is_default` → `default` | models/project/column.go:52 (`Default`, `NOT NULL DEFAULT false` tokens only) | :3004 | mapper |
| 8 | `project_issues` | `project_column_id` → `project_board_id` | models/project/issue.go:21 (quoted `'project_board_id' INDEX`) | :3048 | quoted pin |
| 9 | `project_workflows` | `event` → `workflow_event` | models/project/workflows.go:163 (`WorkflowEvent`, no tag) | :3078 | mapper |
| 10 | `project_workflows` | `filters` → `workflow_filters` | models/project/workflows.go:164 (`TEXT JSON` tokens only) | :3081 | mapper |
| 11 | `project_workflows` | `actions` → `workflow_actions` | models/project/workflows.go:165 (`TEXT JSON` tokens only) | :3084 | mapper |
| 12 | `tracked_time` | `seconds` → `time` | models/issues/tracked_time.go:30 (`Time`, `NOT NULL` only) | :1920 | mapper |
| 13 | `issues` | `title` → `name` | models/issues/issue.go:63 (`Title xorm:"name"` — the explicit column-NAME tag; upstream's own SQL binds it, issue_update.go:198 + issue.go:536) | :624 | column-NAME tag |
| 14 | `pull_auto_merges` | `issue_id` → `pull_id` | models/pull/automerge.go:19 (`PullID xorm:"UNIQUE"`) | :4994 | NAME+VALUE-SPACE |
| 15 | `pull_auto_merges` | `merge_message` → `message` | models/pull/automerge.go:23 (`Message xorm:"LONGTEXT"`) | :5004 | mapper |
| 16 | `audit_event` | `created_unix` → `timestamp_unix` | models/audit/audit_event.go:37 (`TimestampUnix xorm:"INDEX NOT NULL"`) | :3552 | mapper |
| 17 | `repo_transfer` | `new_owner_id` → `recipient_id` | models/repo/transfer.go:68 (`RecipientID` untagged; upstream's own query binds it, :177) | :313 | sweep addition (audit §7.10) |
| 18 | `review_state` | `issue_id` → `pull_id` | models/pull/review_state.go:44 (`PullID`, type tokens only; binds :71,:132,:143) | :4971 | NAME+VALUE-SPACE; sweep addition (audit §7.10) |

Out of scope, with the reason:

- `issue_subscriptions` → `issue_watch` table rename: DECLINED — the
  association rename is recorded intentional (audit §7.5, the SPEC-0005
  §3.2 block). Not a member.
- The withdrawn members stay withdrawn (audit §7.8): `redirect_ur_is`
  and the package_blobs `hash_*` quartet — upstream pins those column
  names via explicit first-token xorm overrides ours already matches
  verbatim.
- The VALUE-SPACE arms of members 14 and 18 (ours `issue_id` stores
  `issues.id`; upstream `pull_id` stores `pull_request.id`) are NOT
  moved by this plan — the FN-3 landing's note stands (safe while the
  rows stay 1:1; audit §4 review_state). This plan renames columns only.
- FN-7 (`pull_auto_merges.merged_commit_id` port) rides the same unit
  per the backlog's dependency note; its DDL is additive, not a rename.

### 8.2 The property-kept contract (zero application-code edits)

Drizzle property names and table export names are KEPT: upstream's Go
field names map to ours drizzle properties (`Title`→`title`,
`TeamIDs`→`teamIds`), so the batch edits ONLY the explicit column-name
strings in `src/db/schema.ts` (18 mapping strings) plus raw-SQL test
fixtures. Production source has ZERO raw-SQL column bindings for any
member (audit §7.10.3). All string hits for these names outside
schema.ts are upstream-parity HTTP surfaces that MUST NOT change: the
`?rule_name=` query param, the transfer form's `team_ids` key, the
merge `merge_message_field` form key, the type-31 comment-meta content
JSON's `project_column_id` key, and the `[pull_id: …]` auto-merge error
text (upstream's exact string, api/routes/pulls.ts:1704). The
`projectColumns` export name stays even though the SQL table becomes
`project_board` (ours-side ergonomics; the audit's census compares SQL
names, not exports). Index names stay ours (`protected_branches_repo_rule_uq`
keeps its name; drizzle re-emits it over the renamed column).

### 8.3 The migration (one generated migration, ALTERs-only)

The migration-shape verdict (audit §7.10.4, trial `/tmp/fn5-drizzle-trial`
+ drizzle-kit 0.31.11 dist): drizzle-kit's SQLite dialect generates
`ALTER TABLE … RENAME COLUMN` / `ALTER TABLE … RENAME TO` when its
interactive rename prompt is answered — never drop+add; under a non-TTY
stdin generate FAILS LOUD (no silent data-loss path). The port unit's
flow:

1. Flip the 18 schema.ts mapping strings (properties/exports untouched).
2. Run `pnpm db:generate` in an interactive TTY; answer each
   renamed-or-created prompt with the rename candidate (17 column
   prompts + 1 table prompt). drizzle-kit emits
   `rename_table` first, then `rename_column`, then the rest, and
   rebuilds affected indexes (drop + create under the new column names —
   `protected_branches_repo_rule_uq` moves onto `branch_name`).
3. Post-generate gate: read the emitted SQL with your own eyes —
   ALTERs-only, no `CREATE TABLE`, no `DROP COLUMN`, no data-copy
   staging (the FN-6/0066 rebuild lesson does not apply here).
4. Apply and prove preservation: seed a local dev D1 (rows in every
   member table), `pnpm db:migrate:local`, then assert the rows read
   back under the new names (the fixtures in §8.4 double as this
   battery).
5. `pnpm db:migrate:remote` is the deploy-time step per the house
   deploy discipline.

### 8.4 Test plan (names + asserted shapes; no code)

- ~26 raw-SQL fixture lines across 6 test files carry the OLD names and
  flip mechanically with the migration: bench-d1.test.ts:2144
  (`SELECT id, rule_name FROM protected_branches`) and :2198
  (`FROM project_columns`); audit.test.ts:130 INSERT + :417/:436/:442
  EXPLAIN witnesses (`created_unix` → `timestamp_unix`);
  schema.test.ts:1045 (`review_state` `issue_id`) and :1454-1479
  (`tracked_time` `seconds` ×6); activity-feeds.test.tsx:98 and ~13
  sibling `INSERT INTO issues (… title …)` fixtures; and
  settings-danger-zone.matrix.test.tsx:120 (`repo_transfer.new_owner_id`).
- The schema.test FN-3 describe pins stay green except the
  review_state INSERT fixture named above; no new DDL-pin describes are
  required — the renames carry no shape change (types, nullability,
  defaults, and pks are all untouched by a rename).
- Full-suite verdict per ADR-0006 (`pnpm test:full`), with the renamed
  fixtures' scopes attributed.

### 8.5 Open items for the port unit

- The rename prompts must be answered deliberately: drizzle-kit
  offers "created" as the default-arm; choosing it for any member would
  emit DROP COLUMN + ADD COLUMN and destroy data — the §8.3 step-3 gate
  exists to catch exactly that.
- Optional ours-side follow-up (NOT this unit): FN-7 may rename the
  `pullAutoMerges.issueId`/`reviewState.issueId` drizzle properties to
  match their new columns — a code refactor riding FN-7's additive DDL,
  not an FN-5 deliverable.
- The bench-d1 raw SELECTs (:2144, :2198) are benchmark witnesses —
  after the rename they must still hit the same plans (the index under
  `protected_branches_repo_rule_uq` is rebuilt over the renamed column;
  re-run the bench file, not just the unit tests).

## 9. FN-9 disposition — the original_author family: RECORD (intentional-recorded-absent)

**Status: RECORD. Nothing to build; no migration is planned.** Derived by
the FN-9 derivation-prep unit (GN, 2026-11-03) from the upstream pin
`fc4936884584`; the full writer/reader matrix with file:line cites lives
in `docs/research/table-alignment-audit.md` §7.11 (the normative
column-level disposition). This section is the SPEC carrier per the
FN-13 supersession rule (a divergence is intentional only once a SPEC
records it).

**The record.** Upstream's `original_author`/`original_author_id` pair
(`issue`, `comment`, `review`, `reaction`, `release`) has exactly one
writer: the forge-metadata migration importer's `remapUser`
(`services/migrations/gitea_uploader.go:1007-1022`), reached through each
struct's `RemapExternalUser` (issue.go:720-724, comment.go:1279-1283,
review.go:1086-1090, reaction.go:91-95, release.go:495-499). It writes
`("", 0)` for authors mapped to local users (the clear arm, :1020) or
`(externalName, externalID)` for unmapped external authors (:1022); no
native create/edit path ever writes the pair, so the mark is permanent.
Every upstream reader (`ToAuthor`'s ghost fallback
`services/convert/user.go:53-58` and its eight call sites; the
`HasOriginalAuthor` role gates; the reaction pseudo-user and delete
guards, reaction.go:221-233) keys off non-empty values and degrades to
the plain local arm when the pair is `("", 0)`.

Our surface has no forge-metadata importer and its single entry point
refuses one: SPEC-0009 §1 scopes `POST /api/v1/repos/migrate` as
git-data-only and records the forge-metadata migration as an
out-of-scope deferral; §2.2 makes the refusal contractual (`422`
"metadata migration is not supported for this service", implemented
`src/services/migrate.ts:185-194`, pinned by
`src/services/migrate.test.ts:574`). No SPEC, ledger, roadmap row, or
open question schedules the importer. No reader exists here either
(grep 0; our renders go straight to the poster row). With no writer that
can ever fire and observable parity at the empty-columns arm, porting
the columns would add permanently-NULL state — **the family is
intentional-recorded-absent, not port-when-read**: the two arms share one
trigger (imported content existing), and that trigger belongs to the
deferred SPEC-0009 forge-metadata extension, not to an FN-9 port unit.

Consequently:

- **FN-2 resolution (§7.2's decision point, §7.7's open item): DEFER
  wins.** The `comments.original_author`/`original_author_id` pair stays
  out of FN-2's migration and out of every plan; the FN-2 port unit's
  SPEC record cites this section. §4's comment-entry verdict cells for
  the pair (port-when-read) are superseded by audit §7.11's record.
- **The `issues` twin (schema.ts:676-678, present-but-unwritten) is
  RESERVED, not dead drift** — same ground (no importer surface), house
  precedent SPEC-0009's `lfs_enabled`/`lfs_endpoint` "created now and
  reserved" (0009 §1 + §3.1). Kept: dropping two all-NULL columns costs a
  table-rebuild migration to remove state that the importer extension
  would re-add. §3.2's `issues` DDL line (:503-504) carries the pair;
  this section adds its unwritten-by-design ground.
- **The port trigger, named:** if the forge-metadata migration surface
  is ever SPEC'd, that SPEC owns the family end-to-end — the additive
  NULLable pairs on `comment`/`review`/`reaction`/`release` (verifying
  the `issues` twin), the `remapUser`-equivalent writer, the `ToAuthor`
  ghost arm at the poster render seams, and the reaction delete guards
  + dedup-key widening (reaction.go:221-233; reaction.go:63-70). Until
  that SPEC exists, the absence of the family is the recorded, correct
  state.
