# API Parity Review — Core `/api/v1` Surface (semantic, beyond the frozen contract)

Read-only review, 2026-10-30, submodule pin `fc4936884584a41931906553d96c2601d750e6ef`.
Scope: the 15 highest-traffic core endpoints (+ `GET /user` and the tags/releases
lists as an appendix), compared handler-vs-handler and struct-vs-serializer for
**field completeness vs upstream json tags** (nested objects, null-vs-omitted
semantics, zero-value dates), **error shapes**, **pagination/sort**, and
**permission gates**. This deliberately looks at what `scripts/check-openapi.mjs`
cannot see: wire keys upstream emits at runtime but does not declare in swagger,
value semantics inside declared keys, and cross-route inconsistencies.

Severity: **parity** (aligned) / **cosmetic** (naming/message-text only, no
client behavior change) / **drift** (a real behavioral difference a client would
notice). A drift marked *(documented)* is already disclosed in a SPEC/module
header — listed here so the semantic ledger is complete.

Known-divergent, excluded per brief: the `id:0` UUID seam, PAT-only auth, absent
password fields, transfer-202 async posture.

Upstream cites are `gitea/<path>:<line>`; ours `apps/worker/src/<path>:<line>`.

---

## E1 — `GET /repos/{owner}/{repo}` (repoGet)

Upstream: `routers/api/v1/api.go:1242` (`reqAnyRepoReader()`), `routers/api/v1/repo/repo.go:499` (`Get`), `services/convert/repository.go:26` (`innerToRepo`), struct `modules/structs/repo.go:59-146`.
Ours: `apps/worker/src/api/routes/repo.ts:374-394`, converter `services/repository.ts:631-778` (via `toApiRepositoryFull`, :558).

| Aspect | Verdict | Severity | Notes + cites |
|---|---|---|---|
| Status/404 semantics | parity | — | missing ≡ invisible-private → same `{message:"not found",url}` body; anti-enumeration upstream `repo.go:521` vs our `routes/repo.ts:379-388` |
| Permission gate | parity-with-note | cosmetic | upstream gate is "reader of ANY unit"; a repo with every unit disabled would 404 upstream but 200 here (unit gates not consulted) |
| Declared fields | parity | — | all 90 keys of `structs/repo.go:59-146` present, incl. the deliberate `link:""` (`repository.ts:691` — upstream never assigns it, `structs/repo.go:79` never filled by converter) |
| `topics` | **always `[]`** | **drift** | `repo_topics` table + `PUT /repos/{o}/{r}/topics` landed (`services/repo-topics.ts`), but the converter hardcodes `topics: []` (`services/repository.ts:774`); upstream renders the stored topics (`structs/repo.go:145`, `convert/repository.go`). Round-trip drift: topics set via API vanish from every repo payload |
| `licenses` | **always `[]`** | **drift** | the license-sync service exists (`services/repo-licenses.ts`, fed by repoEdit's default-branch arm) but the render hardcodes `[]` (`repository.ts:775`); upstream renders detected licenses (`structs/repo.go:146`) |
| `branch_count` / `release_counter` / `language` | always 0 / 0 / `""` | drift *(documented)* | upstream renders `CountBranches` (`convert/repository.go:160`), release count, primary language (`repo.go:71-77`); ours TODO(SPEC-0005) (`repository.ts:712,716,686`) |
| `updated_at` / `archived_at` | = created / `0001-01-01T00:00:00Z` | drift *(documented)* | upstream bumps `updated_unix` on edits and stores the archive time (`repo.go:133-134`); ours renders `createdIso`/GO-zero (`repository.ts:719,721`) |
| `parent` (forks) | gated, upstream is not | drift *(documented)* | upstream loads the base **unconditionally** — a private base leaks (`convert/repository.go:46-57`, their own FIXME); ours renders only when the doer can read the base (`repository.ts:505-524`). Deliberate "empty is better than wrong" |
| `permissions` | parity | — | always rendered on both sides (`convert/repository.go:41-45`); our matrix folds org/team/collaborator grants (`repository.ts:362-375`) |
| `has_code` | always `true` | drift | upstream mirrors the code unit (`repo.go:135`); our PATCH accepts `has_code` but the render ignores it (`repository.ts:723`) |
| `internal_tracker` | always rendered | cosmetic | upstream omits when the issues unit is off (`convert/repository.go:62-71`); ours always renders defaults (`repository.ts:725-729`) |
| Mirror triple (`mirror_interval/updated/last_sync_at`) | parity on single GET | — | `toApiRepositoryFull` resolves the `repo_mirrors` row (`repository.ts:565-569`) — same gating as `convert/repository.go:161-170` |
| Zero-value dates | parity | — | GO-zero convention mirrors Go's `time.Time{}` marshaling (`repository.ts:97`) |

## E2 — `POST /user/repos` (createCurrentUserRepo)

Upstream: `api.go` /user group (`rejectPublicOnly()` + reqToken), `repo/repo.go:281` (`Create`) → `:231` (`CreateUserRepo`), struct `modules/structs/repo.go:152-180` (`CreateRepoOption`).
Ours: `routes/user-repos.ts:179-246`, service `services/user-repos.ts:170-231`.

| Aspect | Verdict | Severity | Notes + cites |
|---|---|---|---|
| Status codes | parity | — | 201 + Repository; 409 exact upstream message; 422 reserved/invalid name; 400 readme template (`repo.go:237-240` vs `user-repos.ts:74-83`, message verbatim `[Default]`) |
| Permission gate | parity | — | reqToken stand-in; 401 `token is required` |
| 201 body | parity | — | re-read row + settings overlay = upstream's reload (`repo.go:270-274`); creator permission triple = `Permission{Owner}` (`repo.go:276` via `toCreatedOrgRepository`) |
| `gitignores` / `license` / `issue_labels` | accepted, never rendered | drift *(documented)* | upstream renders them into the auto-init tree (`services/repository/create.go initRepository`); ours builds README.md only (`user-repos.ts:139-148`) — an `auto_init` repo is missing the LICENSE/.gitignore the client asked for |
| `template` | accepted, ignored | drift | upstream creates `IsTemplate` repos (`repo.go:246`); ours drops the flag at create (`user-repos.ts:59-60` header) even though `is_template` landed for PATCH/generate |
| `object_format_name` | ignored (`sha1` only) | cosmetic | upstream accepts sha256 (`repo.go:248`); drift only for clients that request sha256, which then silently get sha1 (`repository.ts:776` renders `sha1`) |
| Name validation | parity | cosmetic | messages differ from Go error strings (documented); statuses aligned |

## E3 — `PATCH /repos/{owner}/{repo}` (repoEdit)

Upstream: `api.go:1243-1245` (reqToken + `reqAdmin()`, no mustNotBeArchived), `repo/repo.go:571` (`Edit`) → `updateBasicProperties :640` / `updateRepoUnits :754`.
Ours: `routes/repo.ts:443-603`, schema `models/repository.ts:261-358`.

| Aspect | Verdict | Severity | Notes + cites |
|---|---|---|---|
| Gate | parity | — | repo-admin required both sides (`routes/repo.ts:447`) |
| Applied subset | parity | — | name-rename (case-fold rule, `repo.go:655`), private flip + star/watch zeroing (`repo.go` → `services/repository/repository.go:172-181`), `default_branch`, `archived`, `template`, description/website, has_* flags |
| PR-merge configuration (`allow_*`, `default_merge_style`, `default_update_style`, `squash_merge_commit_message`, `autodetect_manual_merge`, `default_allow_maintainer_edit`, `default_delete_branch_after_merge`, `ignore_whitespace_conflicts`) | accepted-and-ignored | **drift** *(documented)* | upstream persists them via `updateRepoUnits` (`repo.go:754-985`); ours silently drops them (`models/repository.ts:251-259`) and GET renders hardcoded defaults (`repository.ts:737-752`). A client that disables squash-merge gets 200, then reads `allow_squash_merge: true` back; actual merge gating never changes |
| `internal_tracker` / `external_tracker` / `external_wiki` | accepted, ignored | drift *(documented)* | upstream rewrites unit config (`repo.go:754`) |
| `mirror_interval` / `enable_prune` / mirror auth | accepted, ignored | drift *(documented)* | mirrors set the schedule out-of-band upstream too; PATCH round-trip still differs |
| `default_branch` existence gate | applies without engine-side branch check | drift *(documented)* | upstream only applies when the branch exists or repo empty (`repo.go:713-746`); ours applies and lets the engine reject out-of-band |
| `has_code` | accepted, ignored (GET always `true`) | drift | see E1 |
| 200 body | parity | cosmetic | re-rendered Repository; note it rides the sync converter — a fork's `parent` and a mirror's schedule fields are absent from the PATCH response but present on the following GET (`routes/repo.ts:600` vs `:393`) |
| Transfer (`POST …/transfer` 202) | documented divergence | drift *(documented)* | upstream answers 201 (immediate-or-pending, `repo/transfer.go`); ours SPEC-pins 202 + pending row (`routes/repo.ts:298-334`) — excluded per brief, listed for completeness |

## E4 — `GET /repos/search` (repoSearch)

Upstream: `api.go:1234` (anonymous allowed), `repo/repo.go:49` (`Search`), conditions `models/repo/repo_list.go` (`SearchRepositoryCondition`).
Ours: `routes/repo.ts:396-423`, query `services/repository.ts:1063-1178`.

| Aspect | Verdict | Severity | Notes + cites |
|---|---|---|---|
| Envelope / headers | parity | — | `{ok:true, data:[…]}` + `X-Total-Count`/`Link`; default sort alpha-ASC (`utils/sort.go` `SearchOrderByAlphabetically`) |
| Permission gate | parity | — | anonymous → public only; `private=true` for signed callers (`resolveIncludePrivate`, `repo.go:93-105`) |
| `mode` / `template` / `archived` filters | parity | — | fork/mirror/source real; `collaborative` empty (no collaborator edge in the WHERE — but see below, rows exist) |
| Item render | **list path uses the sync converter** | **drift** | `routes/repo.ts:422` renders `toApiRepository` without relations: fork results omit `parent` and mirror results render zero `mirror_*` fields, where upstream runs the same parent/mirror arms on search results (`convert/repository.go:46-57,161-170`) |
| Item `topics`/`licenses` | always `[]` | drift | same hardcode as E1 |
| `q` keyword | name-only substring | drift *(documented)* | upstream also matches description (`includeDesc`) and renders via LIKE on lower_name; ours `instr()` on slug (`repository.ts:1123-1145`, the D1 50-byte LIKE cap workaround) |
| `topic=true` / `starredBy` / `team_id` | always empty | drift *(documented)* | upstream matches topics/stars/teams; ours `0=1` conditions (`repository.ts:1110-1123`) |
| `exclusive` | ignored | drift | upstream `exclusive=false` widens uid to "owns or contributes to" (`repo_list.go` AccessibleRepositoryCondition); ours always owner-only regardless (`repository.ts:1116-1120`) |
| `sort=updated|size|git_size|lfs_size|stars|forks` | id-order stand-in | drift *(documented)* | no backing columns; deterministic but wrong order (`repository.ts:926-938`) |
| Errors | parity | — | `invalid search mode` 422; invalid sort/order 422 with Go-%q messages |

## E5 — `GET /repos/{owner}/{repo}/issues` (issueListIssues)

Upstream: `api.go:1571-1576`, `repo/issue.go:251` (`ListIssues`), struct `modules/structs/issue.go:56-93`.
Ours: `routes/issues.ts:1034-1088`, converter `services/issues.ts:408-459`.

| Aspect | Verdict | Severity | Notes + cites |
|---|---|---|---|
| Gate | parity-with-note | cosmetic | upstream additionally narrows `type` against unit readability (404, `issue.go:375-390`) and the group's `mustEnableIssuesOrPulls` 404s unit-less repos; ours never consults `has_issues`/`has_pull_requests` (`routes/issues.ts:131-132` admits the 412 family is unreachable) — after a PATCH disables the unit, upstream 404s, ours 200s |
| Filters (`state`,`labels`,`q`,`type`,`milestones`,`since`,`before`,`created_by`) | parity | — | names→ids resolution with silent discards, RFC3339-or-422 (`services/issues.ts:778-810`), `created_by` unknown-login 404 in upstream order (`issue.go:398-406`) |
| `assigned_by` / `mentioned_by` | **always empty set** | **drift** | upstream filters the indexer by assignee/mention ids (`issue.go:398-406` + `routers/common/issue_filter.go`); ours maps both to "match nothing" (`routes/issues.ts:1045-1066`) **even though the assignee table landed** (`issue_assignees` + PATCH assignees). `?assigned_by=X` on issues genuinely assigned to X returns `[]` |
| Sort | parity | — | `created_unix DESC, id DESC` = `SortByCreatedDesc` (`services/issues.ts:991`) |
| Pagination | parity | — | 30/50 clamp, headers |
| Item fields | parity except two | drift | `assets: []` hardcoded (`services/issues.ts:437`) though the issue-attachment family landed (upstream embeds `Attachments`, `structs/issue.go:66`); `projects: null` always (`services/issues.ts:440`, tier-3, upstream renders project boards) |
| Null-vs-omitted | parity | — | `assignee`/`assignees` null when empty (upstream nil marshaling, `issue.go:104-113`); `closed_at`/`due_date` null; `pin_order` −1→0 (`convert/issue.go`) |
| `content_version` / `time_estimate` | parity | — | rendered from real columns |

## E6 — `POST /repos/{owner}/{repo}/issues` (issueCreateIssue)

Upstream: `repo/issue.go:558` (`CreateIssue`), option struct `structs/issue.go:95-113`.
Ours: `routes/issues.ts:1093-1183`.

| Aspect | Verdict | Severity | Notes + cites |
|---|---|---|---|
| Gate | parity | — | reqToken + mustNotBeArchived + reader-of-issues (upstream `api.go:1576-1577`) |
| `assignee` / `assignees` | **dropped** | drift *(documented)* | upstream resolves logins→ids and assigns (`issue.go:587` `loadAssigneeUserIDs`); ours drops both (`routes/issues.ts:1112-1118` header). A client creating an assigned issue silently loses the assignees |
| `labels` / `milestone` for non-writers | applied unconditionally | drift | upstream clears labels for non-writers and refuses the write-gated arms (`issue.go:597-601`); ours applies `labels`/`milestone` for any authenticated reader — a reader can label/milestone where upstream silently cannot |
| `projects` | dropped | drift *(documented)* | upstream passes them into `NewIssue` (`issue.go:606`) |
| `closed:true` | parity | — | close-after-create, `opened`+`closed` webhook order (`issue.go:630-641`); the open-dependencies 412 arm is unverified here |
| Bad `due_date` | parity | — | 400 `invalid date format` (runtime-only status, documented) |
| 201 body | parity | — | same render as GET |

## E7 — `GET /repos/{owner}/{repo}/issues/{index}` (issueGetIssue)

Upstream: `repo/issue.go:484`.
Ours: `routes/issues.ts:1324-1328`.

| Aspect | Verdict | Severity | Notes + cites |
|---|---|---|---|
| Everything | parity | — | inherits E5's field verdicts (`assets`/`projects`) and the `issue does not exist [id: 0, …]` error message shape |

## E8 — `GET /repos/{owner}/{repo}/issues/{index}/comments` (issueGetComments)

Upstream: `repo/issue_comment.go:28` (`ListIssueComments`, no pagination, X-Total-Count set).
Ours: `routes/issues.ts:1571-1591`, converter `services/issues.ts:495-517`.

| Aspect | Verdict | Severity | Notes + cites |
|---|---|---|---|
| Envelope | parity | — | full thread, `X-Total-Count` without `Link`, `since`/`before` |
| Comment fields | parity | — | `html_url` anchor `#issuecomment-<id>`; `issue_url` "" for PRs / `pull_request_url` "" for issues (`convert/issue_comment.go`) |
| `assets` | always `[]` | drift | same embed gap as E5 (upstream `structs/issue_comment.go:24`) |

Repo-wide sibling `GET /repos/{o}/{r}/issues/comments` (`issue_comment.go:226`): parity (paginated + headers + id-ASC).

## E9 — `POST /repos/{owner}/{repo}/issues/{index}/comments` (issueCreateComment)

Upstream: `repo/issue_comment.go:335` (`CreateIssueComment`).
Ours: `routes/issues.ts:1594-1620`.

| Aspect | Verdict | Severity | Notes + cites |
|---|---|---|---|
| Gate | parity | — | reqToken + mustNotBeArchived; blocked-user 403 `user is blocked` (`comments.go:63-65` port) |
| Locked-issue gate | **missing** | drift | upstream 403s non-writers on locked issues (`issue_comment.go:381` `repo.issues.comment_on_locked`); ours has no `is_locked` check on the create path |
| Empty body | accepted | drift | upstream bind `Required` 422s `""` (`structs/issue_comment.go:41-43`); our schema is `z.string()` (`models/issue.ts:288`) so an empty comment lands 201 |
| 201 body / webhooks | parity | — | rendered Comment; `issue_comment` vs `pull_request_comment` event split |

## E10 — `GET /repos/{owner}/{repo}/pulls` (repoListPullRequests)

Upstream: `api.go:1441-1443`, `repo/pull.go` `ListPullRequests`, converter `services/convert/pull.go:320-400`.
Ours: `routes/pulls.ts:736-795`, converter `services/pulls.ts:501-590`.

| Aspect | Verdict | Severity | Notes + cites |
|---|---|---|---|
| Gate | parity | — | reader-of-code upstream (`api.go:1443`), anonymous list allowed |
| Filters (`state`,`sort`,`labels`(ids),`milestone`,`poster`,`base_branch`) | parity | — | sort values incl. `recentclose`/`priority` (`services/pulls.ts:216-235`); default created-DESC |
| `review_comments` | **omitted always** | **drift** | upstream renders the review-comment count in BOTH converters (`convert/pull.go:92,373` — `omitempty` hides only the zero value); ours never emits it (`services/pulls.ts` header). Any client counting review comments reads nothing |
| `additions` / `deletions` / `changed_files` | omitted | parity (list) | upstream deliberately skips them on lists too (`convert/pull.go:488-491` panics if set) |
| `assignees` null-vs-`[]` | parity | — | list keeps raw null = `ToAPIPullRequests` (`pull.go:358`); single/payload use `[]` = `SliceNilAsEmpty` — the three-converter split is ported exactly (`services/pulls.ts:556-560`) |
| `base.repo` embed | parity | — | full Repository with the doer's permission view, every row (`convert/pull.go:352-356` vs `baseBranchInfo`, `services/pulls.ts:372-382`) |
| `head.repo` hidden-fork rule | parity | — | `repo_id:-1` + omitted `repo` for unreadable forks (`pull.go:120` port, `services/pulls.ts:463-473`) |
| `mergeable` | **null while checking** | drift *(documented)* | upstream's field is a plain bool — checking renders `false` (`structs/pull.go:65`); ours renders `null` (SPEC-0005 §3.4 state machine) |
| `draft` | parity | — | WIP-prefix rule both sides |

## E11 — `GET /repos/{owner}/{repo}/pulls/{index}` (repoGetPullRequest)

Upstream: `repo/pull.go` `GetPullRequest` + `convert/pull.go:36-253`.
Ours: `routes/pulls.ts` single arm via `toApiPullRequest(…, "single", extras)`.

| Aspect | Verdict | Severity | Notes + cites |
|---|---|---|---|
| Core fields | parity | — | `url` = HTML URL (upstream `pull.go:79` — the field holds the HTML URL despite the name); `merged_by`/`merged_at`/`merge_commit_sha`; `allow_maintainer_edit`; `base.sha` resolved from the engine tip |
| `additions` / `deletions` / `changed_files` | **omitted** | **drift** | upstream computes `GetDiffShortStat` on the single GET (`convert/pull.go:245-253`); ours omits all three (`services/pulls.ts` header). Diff-stat readers (badges, dashboards) get nothing on the single endpoint |
| `head.sha` / `head.ref` | parity | — | `refs/pull/{n}/head` fallback ported |
| `mergeable` | null-vs-false | drift *(documented)* | see E10 |

## E12 — `GET /repos/{owner}/{repo}/pulls/{index}/reviews` (repoListPullReviews)

Upstream: `api.go:1457`, `repo/pull_review.go` (`ListPullReviews`), converter `services/convert/pull_review.go:16-63`.
Ours: `routes/pull-reviews.ts:1196-1218`.

| Aspect | Verdict | Severity | Notes + cites |
|---|---|---|---|
| Gate | parity | — | GET anonymous-capable (no reqToken on the Get arm, `api.go:1458-1459`) |
| Pending-review privacy | parity | — | pending rows hidden from non-author/non-admin viewers (`convert/pull_review.go:69-73`) |
| Sort | parity | — | `created_unix ASC, id ASC` (`review_list.go:120-137`) |
| `X-Total-Count` | visible-set only | drift *(documented)* | upstream counts unfiltered (pending included, `pull_review.go:91`); ours counts visible rows — deliberate anti-leak, disclosed in the route comment |
| Review fields | parity | — | `state` mapping table, `official`/`stale`/`dismissed`, `submitted_at`/`updated_at`, reviewer-team null, `comments_count` |

## E13 — `GET /users/{username}` (userGet)

Upstream: `api.go:1057-1058` (`reqExploreSignIn()` + UserAssignmentAPI), `user/user.go:97` (`GetInfo`), struct `modules/structs/user.go:22-67`, converter `services/convert/user.go:80-118`.
Ours: `routes/users.ts:134-149`, converter `apiUserFromRow` (`services/repository.ts:420-453`).

| Aspect | Verdict | Severity | Notes + cites |
|---|---|---|---|
| 404 semantics | parity | — | missing ≡ restricted ≡ invisible → same fake-404 (`user.go:109-112`) |
| **`username` compat key** | **missing** | **drift** | upstream's `User.MarshalJSON` adds a runtime-only `username` duplicate of `login` on EVERY User payload (`structs/user.go:68-75`) — declared nowhere in swagger, so the contract check cannot see it. Ours never emits it (`models/user.ts`). Any consumer reading `.username` (Gogs-era tooling, ad-hoc scripts) gets `undefined` on repo owners, issue posters, comment users, org members… |
| `email` | "" vs placeholder | drift | upstream renders the deterministic noreply placeholder `<id>+<lower>@<noreply-address>` for everyone and the REAL email to any signed-in caller when the user's email is public (`convert/user.go:91-95` + `models/user/user.go:241-243`); ours renders `""` unless self/admin (`repository.ts:431`) — clients can never render a reply-to identity for third-party users |
| `followers_count` / `following_count` | always 0 | **drift** *(documented)* | upstream renders maintained counters (`user.go:52-53`, `convert/user.go:103-104`); ours hardcodes 0 (`repository.ts:445-446`) while the follow edges exist (`services/follows.ts:98-101` "counter halves skipped") — a profile can list followers yet claim 0 |
| `last_login` | GO-zero always | drift *(documented)* | real for authed viewers upstream (`convert/user.go:111`); no column here (`repository.ts:436`) |
| `starred_repos_count` | parity | — | maintained column both sides (`repository.ts:451`) |
| `language` | "" vs real-for-authed | cosmetic | upstream shows the user's locale to self/admin only (`convert/user.go:113`); ours never renders it |
| `is_admin`/`active`/`prohibit_login` gating | parity | — | authed-viewer gate both sides (`convert/user.go:109-117`); note ours intentionally does NOT copy `ToUserWithAccessMode`'s hardcoded `authed=false` (documented in `repository.ts:407-410`) |
| `type`/`visibility` | parity | — | org rows render `Organization` (`repository.ts:394-396`) |

## E13b — `GET /user` (userGetCurrent)

Upstream: `user/user.go:124` (`GetAuthenticatedUser`) → `convert.ToUser(ctx, doer, doer)` (authed=true).
Ours: `routes/user.ts:41-49`, serializer `auth.ts:50-76` (`toApiUser`).

| Aspect | Verdict | Severity | Notes + cites |
|---|---|---|---|
| **Serializer identity** | **uses the auth projection, not the canonical converter** | **drift** | GET `/users/{username}` renders `apiUserFromRow` (rich), GET `/user` renders `auth.ts:toApiUser` — two User serializers that disagree, where upstream routes both through the single `toUser` |
| `avatar_url` / `html_url` | **empty strings** | **drift** | upstream always renders the avatar link and profile URL (`convert/user.go:86-88`); ours renders `""` (`auth.ts:56-57`) — a client booting against `/user` has no profile/avatar URL for the signed-in identity |
| `starred_repos_count` | 0 even when row counts exist | drift | `auth.ts:70` hardcodes 0; `apiUserFromRow` renders the maintained `numStars` — the same identity gets different counts on the two endpoints |
| `visibility` | hardcoded `"public"` | drift | `auth.ts:74`; a limited/private user's self-view lies |
| `type` | hardcoded `"User"` | drift | `auth.ts:73` — an org-scoped identity would misrender (upstream `UserTypeToString`) |
| `language` | hardcoded `"en-US"` | cosmetic | `auth.ts:58`; upstream renders the real locale (possibly "") |
| `last_login` | GO-zero | drift *(documented)* | real upstream for self |
| `email` | real email rendered | parity | correct for the self-view (`convert/user.go:95` authed arm) |

## E14 — `GET /orgs/{org}` (orgGet)

Upstream: `api.go:1726` (anonymous allowed), `org/org.go` `Get` (+ `HasOrgOrUserVisible` 404, email blanked for anonymous), struct `modules/structs/org.go:9-29`, converter `services/convert/convert.go:928-942`.
Ours: `routes/orgs.ts:202-` + `services/org-repos.ts:66-77` (`toApiOrganization`).

| Aspect | Verdict | Severity | Notes + cites |
|---|---|---|---|
| Fields | parity | — | all 10 keys incl. the deprecated `username` alias (`convert.go:933` — here the alias IS declared in swagger and rendered) |
| Anonymous email blanking | parity | — | `org.Get` blanks `Email` for `ctx.Doer == nil`; ours `includeEmail:false` |
| Visibility 404 | parity | — | private/limited orgs fake-404 upstream (`HasOrgOrUserVisible`); ours same-body 404 |
| Renamed org | parity | — | 307 redirect both sides (our `renamedOrgRedirect` via prepared HTTPException) |
| PATCH gate | parity | — | `reqOrgOwnership` ↔ owner check |

## E15 — `GET /repos/{owner}/{repo}/branches` (repoListBranches)

Upstream: `api.go:1315-1321` (group `reqRepoReader(TypeCode)`, GET anonymous), `repo/branch.go` `ListBranches`, ordering `models/git/branch_list.go:89-97` (`commit_time DESC, name ASC`), struct `modules/structs/repo_branch.go:11-33`.
Ours: `routes/branches.ts:324-366`, render `:209-247`, converter `services/git-models.ts` (`toBranch`).

| Aspect | Verdict | Severity | Notes + cites |
|---|---|---|---|
| **Sort order** | **alphabetical** | **drift** | upstream lists most-recently-committed first (`branch_list.go:89-97` default `commit_time DESC, name ASC`); ours sorts by name (`routes/branches.ts:353`). Page 1 of a multi-branch repo differs — a client paginating sees a different ordering than Gitea |
| **`q` filter** | **ignored** | **drift** | upstream filters by branch-name substring (`branch.go:30-38` declared param + `FindBranchOptions.Keyword`); ours accepts only page/limit (`routes/branches.ts:337-340`) — `?q=release` silently returns the unfiltered list |
| Empty repo | parity | — | `[]` + X-Total-Count 0 both sides (upstream skips the branch walk on `IsEmpty`) |
| Protection fields (`protected`, `required_approvals`, `user_can_push`, `user_can_merge`, `effective_branch_protection_name`, `enable_status_check`, `status_check_contexts`) | parity | cosmetic | SPEC-0013 §3.6 renders the rule name unconditionally where upstream gates it on repo-admin (`branch.go` → `convert.go:106-108`) — disclosed in `routes/branches.ts:106-110` |
| Total vs missing branches | parity | — | upstream decrements the total when a branch's commit vanished mid-list; ours filters null renders (same observable count when stable) |

## Appendix — `GET /repos/{owner}/{repo}/tags` and `GET /repos/{owner}/{repo}/releases`

**Tags** (upstream `repo/tag.go` `ListTags` → `GetTagInfos` for-each-ref refname order; struct `structs/repo_tag.go:11-21`; ours `routes/tags.ts:418-427`, `services/git-models.ts:317-334`):

| Aspect | Verdict | Severity |
|---|---|---|
| Shape (`name`,`id`,`commit.sha`,`commit.url`,`zipball_url`,`tarball_url`) | parity (id = tag-object oid for annotated, commit oid for lightweight — upstream-faithful) | — |
| `message` | always `""` — upstream parses the annotated tag message (`repo_tag.go:141`) | drift (minor) |
| Ordering | parity — for-each-ref refname byte order ≈ our name sort | — |
| Gate | parity — anonymous reader, writes reqToken+writer+not-archived | — |

**Releases** (upstream `repo/release.go` `ListReleases` + `models/repo/release.go` `created_unix DESC, id DESC`; ours `routes/releases.ts` + `services/releases.ts:175`):

| Aspect | Verdict | Severity |
|---|---|---|
| Ordering | parity — `created_unix DESC, id DESC` both sides | — |
| Draft gating | parity — drafts hidden from non-writers (upstream `canAccessReleaseDraft`), 412 when the releases unit is off (`mustEnableUnit` ↔ `routes/releases.ts:141-143`) | — |
| `draft`/`pre-release`/`tag_filter` params | declared + handled | — |

---

## Top-10 drift list (ranked by client impact)

1. **`GET /user` renders the degenerate auth serializer** (`auth.ts:50-76`): `avatar_url`/`html_url` empty, `visibility`/`type` hardcoded, `starred_repos_count` 0, and it disagrees with `GET /users/{username}` for the same identity. The single most-called endpoint in every client session; profile/avatar consumers break at boot.
2. **`username` compat key missing from every User payload** (upstream `structs/user.go:68-75` MarshalJSON; undeclared in swagger, so invisible to the contract check). Repo owners, issue posters, comment users, org members — all lack it.
3. **`Repository.topics`/`licenses` hardcoded `[]`** (`services/repository.ts:774-775`) while the topics API and license sync both store real data — PUT-then-GET round-trip lies; UI tag chips and license badges go blank.
4. **`followers_count`/`following_count` always 0** (`repository.ts:445-446`) although follow edges and listings exist — profiles contradict their own follower lists.
5. **repoEdit's PR-merge configuration accepted-and-ignored** (`models/repository.ts:251-259` vs upstream `repo.go:754`): clients disabling merge styles read the old defaults back and actual merge gating never changes.
6. **`assigned_by` issue filter returns empty** (`routes/issues.ts:1045-1066`) even though the assignee table landed — the indexer-side filter was never wired to `issue_assignees`. (Sibling: `mentioned_by`, no mention data yet.)
7. **Pull diff-stat fields omitted**: single GET lacks `additions`/`deletions`/`changed_files` (upstream `convert/pull.go:245-253`), and `review_comments` is never emitted anywhere (`convert/pull.go:92,373`).
8. **Branch list: `q` ignored + alphabetical order** (`routes/branches.ts:337-353`) vs upstream `commit_time DESC, name ASC` with a substring filter (`branch_list.go:89-97`) — page-1 contents differ and filters silently no-op.
9. **Search/list repo render is the query-flat converter**: `/repos/search` results omit `parent` and zero the mirror schedule (`routes/repo.ts:422`) where upstream resolves both per row (`convert/repository.go:46-57,161-170`); same list path never renders topics/licenses.
10. **Unit gates + field-application permissions**: issue/pull routes never consult `has_issues`/`has_pull_requests` (200 vs upstream 404 after a PATCH disables the unit; `routes/issues.ts:131-132`), any reader can set labels/milestone on issue create (upstream clears them for non-writers, `issue.go:597-601`), and `has_code`/`template`(create) silently no-op.

Honorable mentions (documented divergences kept on the ledger): `mergeable: null` while checking (upstream bool `false`), review-list `X-Total-Count` counts only visible rows, transfer 202 vs 201, `parent` permission-gating, auto-init repos missing `gitignores`/`license` files, user email never rendered (upstream noreply placeholder), comment-create accepts an empty body and misses the locked-issue 403, annotated tag `message` always empty, `default_branch` applied without an existence gate.

## Cross-cutting verdicts

- **Pagination** is uniformly parity: 30/50 clamp (`pagination.ts` = `services/context/utils.go ToCorrectPageSize`), `X-Total-Count` + ordered `Link` relations everywhere upstream sends them.
- **Error shape** is uniformly parity: `{message, url}` from `ApiError` (`errors.ts:72-87`), with the documented `internal server error` substitution for upstream's blank-message 500s.
- **Permission gates** (who sees private, admin arms) are parity on all 15: anonymous read of public, anti-enumeration 404s, reqToken on writes, repo-admin on repoEdit/issue-delete/org-delete, writer on branch/tag/release writes, plus the org-team/collaborator grant folds — the gaps are narrower (unit gates and writer-gated field application above), not broader.
