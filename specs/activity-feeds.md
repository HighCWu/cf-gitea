# SPEC: Activity Feeds (`action` table + the three `/activities/feeds` endpoints)

Status: implemented (wave-23 `wave-api-feeds`)
Upstream pin: fc4936884584 (`gitea/` submodule)
Contract authority: `apps/worker/src/compat/contract/v1-swagger.generated.json`

## 1. Problem and scope

Upstream Gitea keeps an instance-wide activity log in the `action` table
(`gitea/models/activities/action.go:135-151`); every webhook-family mutation
also writes feed rows through the notifier fan-out
(`gitea/services/feed/notifier.go` → `NotifyWatchers`,
`gitea/services/feed/feed.go:32-100`). Three frozen-contract operations read
that table:

| operationId | path | upstream handler |
|---|---|---|
| `repoListActivityFeeds` | GET /repos/{owner}/{repo}/activities/feeds | `routers/api/v1/repo/repo.go:1262-1316` |
| `orgListActivityFeeds` | GET /orgs/{org}/activities/feeds | `routers/api/v1/org/org.go:448-512` |
| `userListActivityFeeds` | GET /users/{username}/activities/feeds | `routers/api/v1/user/user.go:164-219` |

This SPEC ports the storage (`action` table), the write seam (insert hooks
inside the landed event emitters `services/repo-events.ts` /
`services/issue-events.ts`), and the three read endpoints.

**In scope**: the table; the emitter insert hooks; the three GET endpoints;
the `Activity` payload converter; pagination + visibility semantics.

**Out of scope**: mounting in `router.ts` (orchestrator does the one-line
registration, the tier2-extras.test.ts convention); the org-team feeds
sibling op (`orgListTeamActivityFeeds`, upstream `org/team.go:835` — needs
team resolution, not in this batch); feeds on the WEB UI (no `/feeds`
rendering here); heatmap recomputation over `action` (the landed heatmap in
`routes/user-read-t2.ts` keeps its issues+comments aggregation — its header
documents that deviation; switching it to this table is a follow-up, not a
silent behavior change).

**Honest-scope discipline**: rows exist ONLY for action types the landed
emitters produce (§3.3 matrix). The endpoints never fake activity; a fresh
instance feeds populate as users create issues, comment, create/rename repos,
and review PRs.

## 2. API surface

All three ops share the response `#/responses/ActivityFeedsList` — a **plain
JSON array** of `#/definitions/Activity` (verified in the frozen contract; no
wrapper object), plus upstream's runtime list headers
(`X-Total-Count`, `Link` — `ctx.SetTotalCountHeader(count)`,
`user.go:212-216`; we reuse `api/pagination.ts setPaginationHeaders`).
Declared codes per contract: **200, 404** for each op (404 body = the
`notFound` ApiError shape `{message, url}`). Runtime-only 401/500 stay
undeclared (the social-t2 convention; nothing added to the orchestrator's
RUNTIME_ONLY_RESPONSES table).

### Parameters (contract-exact)

- `repoListActivityFeeds`: `owner`, `repo` (path, required); `date` (query,
  `YYYY-MM-DD`); `page`, `limit` (query).
- `orgListActivityFeeds`: `org` (path); `date`, `page`, `limit` (query).
- `userListActivityFeeds`: `username` (path); `only-performed-by` (query
  boolean — `ctx.FormBool`, so anything non-"1"/"true" is false);
  `date`, `page`, `limit` (query).

All three are optional-auth upstream (`api.go:1073/1545/1776` — no
`reqToken` on the route): anonymous callers get public feeds; auth does not
fail the request.

### Semantics per endpoint (upstream)

- **repo**: repo resolved via repoAssignment (invisible/missing = the
  anti-enumeration 404); `IncludePrivate = true` always
  (`repo.go:1299-1304`); the query pins the "original" rows only
  (`repo_id = ? AND user_id = act_user_id` — `action.go:517-521`, the
  dedup against NotifyWatchers' per-receiver fan-out).
- **user**: subject = user row (404 when missing; `UserAssignmentAPI`
  parity for visibility — public subjects to everyone, `limited` to signed
  callers, `private` to self/admin only, the anti-enumeration 404);
  `IncludePrivate = signed && (admin || self)` (`user.go:197`);
  `OnlyPerformedBy = FormBool("only-performed-by")` (the ParseBool value
  rule, `formBoolValue`).
- **org**: subject = org user row (404 when missing);
  `IncludePrivate = signed && (admin || org member)` (`org.go:477-489`).

### Activity payload (contract `#/definitions/Activity`)

`convert.ToActivity` (`gitea/services/convert/activity.go:17-44`):
`id`, `user_id` (the RECEIVER row id — the contract's "user who
receives/sees this activity"), `op_type` (string), `act_user_id`, `act_user`
(`ToUser` over the acting user), `repo_id` + `repo` (`ToRepo` under the
CALLER's permission on that repo), `comment_id` (always serializes — Go's
zero-value 0, no omitempty) + `comment` (the embedded object renders ONLY
when the action carries a live comment row, `activity.go:42-46`),
`ref_name`, `is_private`, `content`, `created` (RFC3339 from `created_unix`).

Upstream `ToRepo(ac.Repo, p)` renders the FULL repository object; we reuse
`toApiRepository(viewer, pair)` (reduced permission matrix — the standard
landed converter). Actions whose repository row is GONE are skipped at read
(upstream soft-keeps deleted repos; our cascade deletes rows — §4).

## 3. Data model

### 3.1 The `action` table (port of `models/activities/action.go:135-151`)

```ts
export const actions = sqliteTable("action", {
  id: integer primary key autoincrement,
  user_id: integer not null,          // RECEIVER (act_user for original rows)
  op_type: integer not null,          // upstream ActionType 1..27
  act_user_id: integer not null,      // performer
  repo_id: text not null,             // cf-gitea TEXT repositories.id
  comment_id: integer not null default 0,
  is_deleted: integer boolean not null default false,
  ref_name: text not null default "",
  is_private: integer boolean not null default false,
  content: text not null default "",  // "index|excerpt" / old repo name / ...
  created_unix: timestamp not null,
});
```

- `repo_id` is the landed TEXT key per the repo-scoped-table convention
  (`repo_license` precedent; upstream is int64). No FK (conventions).
- Indexes: upstream declares five (`action.go:157-175`); we port the three
  the endpoints use — `(repo_id, user_id, is_deleted)` (upstream `r_u_d`),
  `(user_id, is_deleted, created_unix)` (upstream `cuIndex`/`c_u_d` shape),
  `(act_user_id, created_unix, user_id)` (upstream `au_c_u`). The remaining
  two (`au_r_c_u_d`, `c_u_d`) are dashboard/heatmap-shaped and land with
  their consumers. Documented reduction.
- `is_deleted`: schema-faithful column, read-filtered
  (`is_deleted = false` everywhere); NOTHING sets it true at this tier —
  upstream doesn't either outside schema migrations (verified: no writer in
  `models/`/`services/repository/`). Repo deletion cascades the rows away
  with the repo row (§4).

### 3.2 How rows get written — the emitter insert hooks

Upstream writes actions inside the same notifier fan-out that creates
webhook deliveries (`services/feed/notifier.go`), so the landed webhook
emission seams are the exact cf-gitea equivalent: **`emitRepoEvent` /
`emitRepoEventInline` (services/repo-events.ts)** and **`emitIssueEvent`
(services/issue-events.ts)** gain an additive, best-effort `recordAction*`
hook (same failure posture as the fan-out: awaited inline, caught, logged,
never propagated — the delivery-row insert precedent).

The hooks derive the action fields from what the emitters already carry
(`repoId` TEXT key, `eventType`, the rendered §2.7 payload): act_user =
`payload.sender.id`, is_private = `payload.repository.private === true`,
issue coordinates = `payload.issue.number`/`title` (or `payload.number`),
comment = `payload.comment.id`/`body`, old repo name =
`payload.changes.name.from`, review text = `payload.review.content`.

**Fan-out (the NotifyWatchers port, `feed.go:32-100`)** — one logical action
inserts one row per RECEIVER:

1. the ORIGINAL row: `user_id = act_user_id` (the row repo feeds read);
2. the ORG row: `user_id = owner.id` when the owner is an org user row
   (`users.type = 'org'`) and `owner.id ≠ act_user_id`;
3. WATCHER rows: one per `repo_watchers` edge of the repo (skipping the
   actor and the org owner) — this is what makes watched-repo activity show
   up in `/users/{username}/activities/feeds`.

Deviation (documented): upstream filters each watcher row at WRITE time by
per-watcher unit permissions and notification prefs (`permCode/permIssue/
permPR`, `watcher.IncludeIssues` …). cf-gitea has no per-unit permission
model and `repo_watchers` carries no notification prefs (schema note), so
every watcher row is written unconditionally; per-caller read filters (§3.4)
reproduce the visibility under our model.

### 3.3 Wired-vs-deferred action-type matrix

Upstream `ActionType` (`action.go:23-56`), numeric values preserved:

| # | op_type | wired now | producer (the seam that writes it) |
|---|---|---|---|
| 1 | create_repo | YES | repo-events `repository` action=created (user/org/admin create arms, mirror-import create, push-create settle) + `fork` event (upstream ForkRepository → ActionCreateRepo, notifier.go:194-205) |
| 2 | rename_repo | YES | repo-events `repository` action=renamed (content = old name, `payload.changes.name.from`) |
| 3 | star_repo | never | nothing upstream writes it either (constant + display code only — verified) |
| 4 | watch_repo | never | same — never written upstream |
| 5 | commit_repo | DEFERRED | git-http push path — outside this batch's file ownership (`git-http/**` untouchable) |
| 6 | create_issue | YES | issue-events `issues` action=opened |
| 7 | create_pull_request | WIRED (pulls.ts/releases.ts local seams since 64ade9f; recounted 14/27 at the v1.3 final sync) | PR opens emit through routes/pulls.ts' LOCAL `emitPullWebhook` seam, not `emitIssueEvent` |
| 8 | transfer_repo | DEFERRED | transfer is a pending-202 with NO emission (repo-events header: upstream's webhook parity is equally silent) |
| 9 | push_tag | DEFERRED | git-http push path |
| 10 | comment_issue | YES | issue-events `issue_comment` action=created (content `index|body`) |
| 11 | merge_pull_request | WIRED (pulls.ts/releases.ts local seams since 64ade9f; recounted 14/27 at the v1.3 final sync) | pulls.ts local seam |
| 12 | close_issue | YES | issue-events `issues` action=closed (content `index|`) |
| 13 | reopen_issue | YES | issue-events `issues` action=reopened |
| 14 | close_pull_request | WIRED (pulls.ts/releases.ts local seams since 64ade9f; recounted 14/27 at the v1.3 final sync) | pulls.ts local seam |
| 15 | reopen_pull_request | WIRED (pulls.ts/releases.ts local seams since 64ade9f; recounted 14/27 at the v1.3 final sync) | pulls.ts local seam |
| 16 | delete_tag | DEFERRED | git-http push path |
| 17 | delete_branch | DEFERRED | git-http push path |
| 18-20 | mirror_sync_* | DEFERRED | import/mirror path emits `repository` created instead (documented divergence) |
| 21 | approve_pull_request | YES | issue-events `pull_request_review_approved` (content `index|review body`) |
| 22 | reject_pull_request | YES | issue-events `pull_request_review_rejected` |
| 23 | comment_pull | YES | issue-events `pull_request_comment` created + `pull_request_review_comment` (upstream: PR comments and review comments are both ActionCommentPull, notifier.go:99-124/207-275) |
| 24 | publish_release | WIRED (pulls.ts/releases.ts local seams since 64ade9f; recounted 14/27 at the v1.3 final sync) | releases.ts LOCAL `emitReleaseWebhook` seam |
| 25 | pull_review_dismissed | DEFERRED | no webhook event type exists for dismissals (HookEventType union has none) |
| 26 | pull_request_ready_for_review | DEFERRED | no landed seam (pulls.ts) |
| 27 | auto_merge_pull_request | DEFERRED | pull-automerge arm, pulls.ts family |

Issue-vs-PR discrimination inside the `issues` event arm follows the
payload: `payload.issue.pull_request != null` ⇒ the PR variants (defensive —
the landed `issues` emitter currently only fires for plain issues; PR
lifecycle goes through pulls.ts).

Comment edits/deletes, label/milestone/assign/review-request events write NO
action rows — upstream has no notifier actions for them either
(notifier.go has none).

### 3.4 Read semantics (the `GetFeeds` port, `action_list.go:207-260` + `action.go:463-562`)

Fast path (`action_list.go:215`): actor is site admin OR the requested
user/org themself ⇒ no act-user/repo visibility filters.

General path (everything else), each condition ported:

1. **Act-user visibility** (`action.go:473-497`, our `keep_activity_private`
   mapping = `users.visibility = 'private'`, the heatmap precedent in
   routes/user-read-t2.ts):
   - anonymous (or public-only token ⇒ anonymous-equivalent):
     `act_user_id IN (users WHERE visibility = 'public')`;
   - signed non-admin: `visibility IN ('public','limited') OR act_user_id =
     actor.id` plus the requested-subject OR-branches (requested org ⇒
     `act_user_id = requested.id`; requested user ⇒ `act_user_id IN (orgs
     the user belongs to)` — `org_members`);
2. **Repo accessibility** (`action.go:499-501`): `repo_id IN (accessible
   repos)` = public repos ∪ actor-owned ∪ `repo_collaborators` rows ∪
   team-granted (`team_members` ⋈ `team_repo_access`); computed as a bounded
   id list (D1 host parameters chunked), not a subquery;
3. `is_private = false` when `!IncludePrivate` (per-endpoint rule above);
4. `is_deleted = false`;
5. `user_id = requested.id` (user/org) or `repo_id = ? AND user_id =
   act_user_id` (repo);
6. `OnlyPerformedBy` ⇒ `act_user_id = requested.id`;
7. **date** (`FeedDateCond`, `action.go:445-461`): `created_unix` within the
   UTC day `[date 00:00:00, date 23:59:59]`; unparsable date ⇒ filter
   skipped exactly like upstream's warn-and-continue.

Order `created_unix DESC` (rowid tiebreak), `LIMIT limit OFFSET (page-1)*limit`
with the landed clamping (`parseListOptions`: page<1→1, limit<1→30, limit>50→50);
`X-Total-Count` counts the same predicate without pagination. Dashboard-only
`DontCount` semantics do not apply (never -1 for these three ops).

## 4. Edge cases, limits, failure modes

- **Plain array body**: `[]` (never `null`) when empty — the contract type
  is `array`; converters preserve Go's `make([]*api.Activity, 0, …)`
  non-nil shape.
- **Deleted/missing referenced rows at read**: repository row gone (our hard
  cascade) ⇒ the action row is skipped (upstream soft-keeps the repo row;
  skipping is the honest equivalent once the cascade ran). Acting user row
  gone ⇒ skip (cannot render `act_user`). Comment referenced by
  `comment_id` gone ⇒ `comment`/`comment_id` stay unset (Go-zero 0/""),
  mirroring upstream's `if ac.Comment != nil` gate (`activity.go:42-46`).
- **Fan-out failure**: action-row inserts never fail a mutation — caught,
  logged, dropped (the webhook fan-out posture). A lost insert means a feed
  gap, not an API error.
- **In-process callers** (tests, no executionCtx): hooks await inline; rows
  are visible when the response lands.
- **Row multiplication**: one action × (1 + org? + watchers) rows, upstream's
  own design; `repo_watchers` are bounded by instance size. No cap added
  (no upstream cap to port).
- **`content` truncation**: upstream clamps to 64 KiB (MySQL TEXT,
  `feed.go:38-47`); comment excerpts render through the API body as-is
  (SQLite has no practical TEXT limit; D1 row limit ~1 MB is far away).
  The FeedExcerpt markdown flattening is NOT ported — the raw body ships
  (documented divergence; the field is display-only).
- **Timezone**: `date` filtering uses UTC; upstream uses
  `setting.DefaultUILocation` (also UTC by default). Documented equality.
- **Visibility of the repo endpoint's embedded `repo` object**: rendered
  with the caller as viewer (reduced permission matrix), matching upstream's
  `GetDoerRepoPermission(ac.Repo, doer)` intent.
- **Schema-appender concurrency**: the `action` DDL appends at the END of
  `db/schema.ts`; the migration accepts whatever `pnpm db:generate` numbers
  it (sibling waves append concurrently; filename collisions are fine).

## 5. Testing plan

Colocated tests (`apps/worker/src/api/routes/activity-feeds.test.ts`), real
D1 via the vitest plugin (`cloudflare:workers` env + `TEST_MIGRATIONS` +
`applyRepoExtrasDdl()`), standalone mount per the tier2-extras convention
(orchestrator registers the family in `router.ts` after landing):

1. **Write path (red→green over the emitters)**: create an issue via the
   issue-create service/route emission ⇒ `action` rows exist (original +
   org for an org-owned repo + watcher rows); comment on it ⇒ comment_issue
   row; close/reopen ⇒ close/reopen rows; submit an approving review ⇒
   approve_pull_request row; rename a repo ⇒ rename_repo row with old-name
   content; fork ⇒ create_repo row. Comment edit ⇒ NO new row.
2. **Read path**: the three endpoints return the contract `Activity` shape
   (plain array; `op_type` string; embedded `act_user`/`repo`;
   `content` = `index|excerpt`; `created` RFC3339), with
   `X-Total-Count`/`Link` headers; `page`/`limit` clamping; `date` window;
   `only-performed-by`.
3. **Visibility**: anonymous sees public-only; private-repo actions hidden
   unless the actor can read the repo (404 repo endpoint for strangers);
   private-visibility subject's own actions hidden from others; admin sees
   everything; org member vs stranger on the org endpoint.
4. **Emitter regression**: the existing `services/issue-events.test.ts` and
   repo-event-family tests stay green (hooks are additive + failure-tolerant).

Self-verification gates: throwaway standalone mount asserting every op's
presence in the frozen contract with declared codes ⊆ contract codes;
`node scripts/check-openapi.mjs`; `pnpm typecheck` (0 attributed errors);
eslint on touched files; `pnpm test` on the family + emitter suites.
