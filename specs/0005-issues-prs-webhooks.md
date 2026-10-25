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
  commits are listed newest-first; `head_commit` is the new tip.
- Ref create/delete pushes fire `create`/`delete` webhooks with
  `ref_type ∈ branch|tag` and the short ref name
  (`services/webhook/notifier.go:822–858`).

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
its payloads are small and the relay needs no S3 credentials.

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
  bump `refs_version`-mirroring cache keys per SPEC-0004 §3.3.

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
| 4.9 | **Delivery log growth** | Upstream cleans `hook_task` by cron (`OlderThan`/`PerWebhook`, `models/webhook/webhook.go:72–100`). We add `cleanupWebhookDeliveries` to the periodic job: keep the newest 100 per webhook or 30 days (config), swept in the D1 maintenance queue. |
| 4.10 | **Release asset upload interrupted** | Presigned PUTs expire (1 h); an R2 object with no confirmed D1 row is swept by the storage-layer orphan sweep (SPEC-0001 pattern, prefix `release-assets/`, mtime > 24 h). Checksum mismatch at confirm → delete object, 422. |
| 4.11 | **Release/tag divergence** | Creating a release for an existing tag attaches to it (sha from the tag); `409` when the repo already has a release row for the tag (upstream `ErrReleaseAlreadyExist`). Deleting a release keeps the tag; deleting a tag-only record (`is_tag`) deletes the tag via the engine ref CAS. |
| 4.12 | **Issue delete cascade** | One D1 batch: comments (incl. xref rows where `ref_issue_id` or `dependent_issue_id` points here), `issue_labels`, `reactions`, `issue_subscriptions`, `issue_pins`, `pull_requests` (+ RepoDO `removeRef refs/pull/N/head` for PRs, `waitUntil`), status rows untouched (they are sha-scoped). Counter rows are *not* rewound. |
| 4.13 | **Repo delete** | Webhook rows + deliveries die with the repo's D1 purge (SPEC-0003 §2.5); in-flight Queue messages hit missing rows and ack as `skipped`; R2 `release-assets/<release_id>/` keys are covered by the `repos/<storage_key>/` prefix purge — hence assets live **under** the repo prefix. |
| 4.14 | **Archived repo** | Every mutation in this SPEC's surface → 423 (SPEC-0004 §4); includes issue create/comment/label ops, PR create/merge, release edits, webhook CRUD, `hooks/{id}/tests`. |
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
