# SPEC: Issue Content History (per-revision snapshots + the list/detail fragments)

Status: implemented (this change).
Upstream pin: go-gitea/gitea @ fc49368845 — `models/issues/content_history.go`,
`routers/web/repo/issue_content_history.go`, `routers/web/web.go:1319-1334`,
write paths `models/issues/issue_update.go:315-350` (`ChangeIssueContent`) and
`services/issue/comments.go:97-140` (`UpdateComment`), cleanup
`models/issues/comment.go:1208-1219` (`DeleteComment`).

## 1. Problem and scope

The official Gitea web UI renders an "edited" dropdown on every edited issue
body and comment (web_src/js/features/repo-issue-content.ts). Opening it
fetches the per-revision history list; picking a revision fetches a diff
against the previous revision. Both need **stored snapshot rows** — one per
content revision — which the landed store did not have (only the
`content_version` edit counters existed, answering the overview fragment).
This SPEC adds the snapshot table, the write-path hooks that fill it, and the
two remaining content-history fragment arms (`list`, `detail`).

**In scope**

- The `issue_content_history` D1 table (upstream `ContentHistory` mirrored).
- Write-path hooks in the landed edit services:
  - issue body edit (`changeIssueBody`, rides both the issue and PR PATCH
    routes — upstream's `ChangeIssueContent` is shared the same way);
  - comment body edit (`updateCommentBody` — upstream's `UpdateComment`
    service hook);
  - comment delete (`deleteComment` — upstream's `DeleteComment` model hook
    hard-deletes the comment's history rows).
- The `content-history/list` fragment arm (`GetContentHistoryList`).
- The `content-history/detail` fragment arm (`GetContentHistoryDetail`).
- Switching the already-implemented `content-history/overview` arm from the
  counter reconstruction to the real `HAVING count(1) > 1` table query
  (upstream `QueryIssueContentHistoryEditedCountMap`) — the table now exists,
  and keeping the counter reconstruction would make the overview and the list
  disagree once retention or soft-deletes enter the picture.

**Out of scope**

- The `POST .../content-history/soft-delete` arm (upstream
  `SoftDeleteContentHistory`, web.go:1329): it is a POST, not one of the two
  GET fragments of this wave; rows can still be soft-deleted by a later wave
  (the write path and the `is_deleted` column exist and the list/detail arms
  already honor the flag). Mount recipe in §6.
- A history snapshot on comment **create**: upstream has none (the first
  revision is back-filled lazily on first edit, §3) — ported as-is.
- Editing/creating issues or comments themselves (landed in SPEC-0005).

## 2. API surface (the web fragments, web.go:1322-1328)

Both arms ride upstream's shared `{type:issues|pulls}/{index}` group
(web.go:1333-1334, mounted twice with `optSignIn + RepoAssignment +
RequireUnitReader(...)`); handlers resolve the issue row by index alone with
no isPull cross-check (upstream's own FIXME) — the landed dispatcher
convention (the index namespace is shared, SPEC-0005 §3.1). Query parameters
are Go `FormInt64` semantics: missing/non-numeric parses to `0`.

### GET /{username}/{reponame}/{type}/{index}/content-history/list?comment_id={id}

Upstream `GetContentHistoryList` (issue_content_history.go:42-82):

```
200 {"results": [ {"name": <HTML string>, "value": <historyId number>}, ... ]}
```

- One entry per revision of (issue, comment_id), `edited_unix DESC`
  (`FetchIssueContentHistoryList`, content_history.go:149-171 — LEFT JOIN the
  user row for editor identity).
- `name` is the pre-rendered dropdown item HTML: `avatar + <strong>userName</strong>
  + (fullName) + action + timeSince` (issue_content_history.go:51-77):
  - avatar: `templates.AvatarHTML(link, 24, "ui avatar tw-align-middle tw-mr-2", userName)`
    → `<img loading="lazy" alt class="{class}" src="{link}" title="{userName}" width="24" height="24">`;
    the link is `/user/avatar/{username}/0` when the user row exists
    (`GenerateUserAvatarFastLink`), else `/assets/img/avatar_default.png`
    (`DefaultAvatarLink`, the LEFT-JOIN-miss / poster-id-less arm);
  - fullName segment only when the trimmed full name is non-empty:
    ` (<span class="tw-inline-flex tw-max-w-[160px]"><span class="gt-ellipsis">{fullName}</span></span>)`;
  - action: deleted → `<i data-history-is-deleted="1">deleted</i>`;
    first-created → `created`; otherwise `edited`
    (locale `repo.issues.content_history.*` at the pin);
  - timeSince: upstream `TimeSince` →
    `<relative-time prefix="" tense="past" datetime="{RFC3339}" data-tooltip-content data-tooltip-interactive="true">{2006-01-02 15:04:05 -07:00 stamp}</relative-time>`
    (server-local zone; the Worker's zone is UTC → `+00:00`, the landed
    `timeSinceParts(unix, "+0000")` convention);
  - `userName` sinks through HTMLFormat's string escaping; the HTML segments
    pass through raw.
- Empty history → upstream marshals the nil slice as `{"results": null}`
  (ported verbatim; fomantic's dropdown treats it as no items).
- The issue-miss arm is the family 404 (HTML shell, `GetActionIssue` →
  ctx.NotFound) — the mount's posture, same as the overview sibling.

### GET /{username}/{reponame}/{type}/{index}/content-history/detail?comment_id={id}&history_id={id}

Upstream `GetContentHistoryDetail` (issue_content_history.go:141-180):

```
200 {"canSoftDelete": <bool>, "historyId": <n>, "prevHistoryId": <n>, "diffHtml": <HTML string>}
404 {"message": "Can not find the content history"}   (history miss or issue mismatch)
```

- `history` resolves as `WHERE id = ? AND issue_id = ?`
  (`GetIssueContentHistoryAndPrev`); miss → the JSON 404 above (NOT the HTML
  shell — upstream writes ctx.JSON here).
- `prevHistory` = the newest **non-deleted** revision of the same
  (issue_id, comment_id) with `edited_unix < history.edited_unix`, limit 1;
  absent → `prevHistoryId: 0` and the diff runs against the empty string.
- `diffHtml` = `diffContentHistory(prev.ContentText, history.ContentText)`
  (:112-138): NormalizeStringEOL both sides, diffmatchpatch
  `DiffMain(old, new, checklines=false)` + `DiffCleanupEfficiency`, rendered
  as `<pre class="chroma">` with insertions wrapped in `<span class="gi">`,
  deletions in `<span class="gd">`, equal text bare — every text run
  HTML-escaped (the HTMLBuilder's WriteString arm). This port carries a
  module-private faithful port of the dmp core (common prefix/suffix trim,
  the contains fast path, half-match, Myers bisect, cleanup-merge) plus the
  upstream-called cleanup-efficiency step. Divergences: (a) span boundaries
  may differ from go-diff in rare equal-cost cases — heuristic quality only,
  never correctness (the frontend renders the HTML verbatim); (b) inputs
  whose combined length exceeds 200,000 UTF-16 units skip the bisect and
  render as a single delete+insert pair (upstream bounds the same work with a
  1 s deadline).
- `canSoftDelete` = upstream `canSoftDeleteContentHistory` (:84-110):
  repo-write (IsOwner or CanWriteIssuesOrPulls — the landed
  `canWriteRepository` grant through the sessionRepoGrant bridge) OR a
  signed-in viewer who is the issue poster (comment_id = 0 case) or the
  comment poster / the revision's poster (comment case), scope-checked
  (history.IssueID == issue.ID, history.CommentID == comment.ID). Anonymous
  non-writers → false.
- The comment-row read for a comment-scoped history
  (GetCommentByID, :157-164) cannot miss in practice: the delete hook (§3)
  removes history rows with their comment. Upstream's miss arm logs and
  returns an EMPTY 200 body; mirrored (documented quirk).

## 3. Data model

### D1 table `issue_content_history` (upstream `ContentHistory`, content_history.go:19-34)

| column | type | notes |
|---|---|---|
| id | integer PK autoincrement | `HistoryID` on the wire |
| poster_id | integer | who the revision is attributed to (see hooks) |
| issue_id | integer NOT NULL, indexed | |
| comment_id | integer NOT NULL, indexed | 0 = the issue body |
| edited_unix | integer timestamp, indexed | the revision's timestamp |
| content_text | text NOT NULL | the snapshot body |
| is_first_created | boolean NOT NULL | the back-filled original snapshot |
| is_deleted | boolean NOT NULL | soft-delete flag (soft-delete arm is a later wave) |

`content_text` is NOT NULL here where upstream uses LONGTEXT nullable: every
insert path supplies a string, and `SoftDeleteIssueContentHistory` empties it
to `""` (not NULL) — the narrower column documents the invariant.

### Write-path hooks (upstream semantics, ported into the landed services)

**Lazy first revision** (both issue and comment paths): history rows exist
only from the first EDIT onward. The first edit back-fills the ORIGINAL
content as `is_first_created = 1`, attributed to the row's poster at the
row's creation timestamp (issue: `poster_id`, `created_unix`, comment_id = 0;
comment: `comment.poster_id`, `comment.created_unix`); then the new content
is stored as a regular revision attributed to the **editing** user at "now"
(upstream doer.ID / timeutil.TimeStampNow). Subsequent edits skip the
back-fill (`HasIssueContentHistory` check).

- `changeIssueBody` (services/issues.ts — upstream `ChangeIssueContent`,
  issue_update.go:316-350): the CAS UPDATE runs FIRST — a stale version (0
  rows) returns with NOTHING written, upstream's `ErrIssueAlreadyChanged`
  arm; after a successful update the back-fill snapshot (when no history
  exists for (issue_id, 0)) and the new revision commit together in one
  atomic batch, followed by the retention limiter. `actorId` attributes the
  edited revision — falls back to the issue poster when the caller omits it
  (documented divergence §5).
- `updateCommentBody` (services/issues.ts — upstream `UpdateComment`,
  comments.go:97-140): loads the prior row (old content, poster, created_unix,
  type), gate `needsContentHistory = oldContent != newContent &&
  commentHasContentSupport(type)` (upstream `c.Type.HasContentSupport()` —
  plain comments, code comments, reviews, dismiss-reviews; system comments
  never snapshot), then back-fill + UPDATE + new revision + limiter. Same
  optional actor parameter.
- `deleteComment` (services/issues.ts — upstream `DeleteComment`,
  comment.go:1215-1219): the existing batch gains the history hard-delete
  (`WHERE comment_id = ?`), so a comment's revisions never outlive it.

**Retention** (upstream `KeepLimitedContentHistory`, content_history.go:56-106,
ported verbatim): after each insert, keep at most **20** revisions per
(issue_id, comment_id); the first and last revisions are never deleted; the
surplus is removed middle-first, each time deleting the revision with the
smallest interval to its predecessor (preserves the sparsest edit history).
One SELECT (id, edited_unix ASC) + per-surplus deletes.

### Overview arm switch

`loadContentHistoryOverviewFragment` becomes the direct port of
`QueryIssueContentHistoryEditedCountMap` (content_history.go:110-133):
`SELECT comment_id, COUNT(1) … WHERE issue_id = ? GROUP BY comment_id HAVING
count(1) > 1`. Key "0" = the issue body. The `content_version` counters stay
(they feed the /api/v1 structs, as upstream's do); the overview no longer
reads them. Consequence: with retention saturation (21+ edits) the map value
caps at 20 exactly like upstream, and a soft-deleted revision still counts
(upstream's query has no is_deleted filter) — both parity wins.

## 4. Edge cases, limits, failure modes

- **`comment_id` parse**: missing/non-numeric/negative-INT64-overflow → 0
  (Go FormInt64), i.e. the issue body namespace.
- **history_id parse** (detail): same → 0 → the history query misses → the
  JSON 404.
- **Issue/comment namespace**: revisions resolve strictly through
  (issue_id, comment_id); the detail arm additionally pins `issue_id` in the
  history query, so a foreign history id 404s (upstream's `AND issue_id=?`).
- **Comment deleted between list and detail**: impossible — the delete hook
  removes the comment's history rows in the same batch as the comment.
- **Orphaned user row** (LEFT JOIN miss on poster): name/fullName empty,
  default avatar link, avatar title falls back to "avatar"
  (`util.IfZero(name, "avatar")`).
- **Equal successive contents**: `needsContentHistory` is false → no
  revision, no counter bump (the landed services already bump the counter
  unconditionally on write — upstream bumps it in the same UPDATE too; only
  the snapshot gate is content-gated).
- **Concurrency**: the comment-edit hook runs has-history + back-fill +
  update + new revision in one D1 batch (atomic), but the preceding
  prior-row/existence reads are separate statements — two concurrent FIRST
  edits can each back-fill a `created` snapshot, and an interleaved edit can
  miss a revision (upstream serializes in a tx). Benign (duplicate or
  missing intermediate snapshot; ids distinct); documented divergence, no
  unique guard. The issue-body hook runs the CAS UPDATE first and the
  history writes after, so a lost CAS race can in principle leave the
  updated content without its revision row — self-heals on the next edit
  (the back-fill then snapshots the current content); no unique guard.
- **Crash window (issue-body hook)**: the update and the history rows are
  two commits (D1 batches have no conditional abort); a crash between them
  loses the revision for that edit, not the content. Upstream keeps one tx.
- **Diff size**: combined > 200k chars → single delete+insert rendering (§2).
- **Time zone**: `relative-time` text stamp renders in the server zone (UTC
  on Workers) — upstream renders server-local too; divergence is only the
  zone.

## 5. Intentional divergences (summary)

1. The edit-revision `poster_id` honors an optional actor parameter the
   current route callers do not pass yet — it falls back to the row's poster
   (the back-fill snapshot's attribution semantics), so until routes thread
   the real editor the "edited" list entries show the issue/comment poster.
   Route threading is a caller-side follow-up (§6 handoff); no schema or
   service-shape change needed.
2. Diff span boundaries may differ from go-diff (§2) — presentation-only.
3. Oversized diffs degrade to whole-replace (§2/§4).
4. First-edit race can duplicate the `created` snapshot (§4).
5. `content_text` NOT NULL vs upstream LONGTEXT nullable (§3).

## 6. Testing plan and mount handoff

**Tests**

- Fragment smoke (issue-content-fragments.smoke.test.ts): one happy path per
  arm — list (dropdown item HTML across deleted/created/edited arms, user
  join, DESC order, `{"results": null}` on an empty namespace) and detail
  (diffHtml gi/gd spans, prevHistoryId chaining, canSoftDelete arms, the
  JSON 404 on a foreign history id); overview re-asserted against the real
  table via the landed write hooks.
- Service hook tests (api services suite): issue-body first edit produces
  exactly two rows (created-at + edited-at, correct attribution);
  second edit adds one and skips the back-fill; comment edit gates on
  content change and content-support type; comment delete removes the
  comment's revisions; retention collapses to 20 middle-first keeping both
  ends.
- Migrations apply locally through the vitest D1 harness
  (`applyAuthD1Migrations`).

**Mount handoff (index-owned — this module stays unmounted for the two new
arms; ui/index.ts already claims only `content-history/overview` at
`rest = [<index>, "content-history", "overview"]`)**

Inside the same `rest.length === 3` arm of the route parser
(ui/index.ts:2976-2982), add:

- `rest[1] === "content-history" && rest[2] === "list"` → family
  `"issue-content-history-list"` (extend the `IssueAuxRoute` family union),
  then a handler beside `issueContentOverviewRoute` (ui/index.ts:4550-4560):
  `resolveUiRequest` → `resolveFragmentIssue(db, repo, route.index)` (null →
  `c.html(renderNotFound(ctx), 404)`) → parse `comment_id` from
  `new URL(c.req.raw.url).searchParams` (FormInt64: `Number.parseInt` with
  NaN → 0) → `loadContentHistoryListFragment(db, issue, commentId)` →
  `contentHistoryListFragmentResponse(data)`.
- `rest[1] === "content-history" && rest[2] === "detail"` → family
  `"issue-content-history-detail"`, handler likewise with `comment_id` AND
  `history_id` params → `loadContentHistoryDetailFragment(db, repo, issue,
  viewer, commentId, historyId)` → `contentHistoryDetailFragmentResponse`
  (ok → 200 JSON; `"notFound"` → 404 JSON `{"message": "Can not find the
  content history"}`; the empty-200 comment-miss quirk rides inside the
  loader's ok arm).

  > **Errata (wave-126, landed):** the export's FIRST parameter is `env`,
  > not bare `db` (issue-content-fragments.ts — the write-grant arm rides
  > `sessionRepoGrant`), and the outcome literal is `"historyNotFound"`.
  > The line cites drifted with sibling landings (the parser arm is now
  > `ui/index.ts`'s `rest.length === 3` block, the overview handler its
  > neighbor) — the shapes held and the mount followed them.
- Optional follow-up (soft-delete wave): `POST .../soft-delete` → family
  `"issue-content-history-soft-delete"` driving a `softDeleteContentHistory`
  service export (permission math in §2's canSoftDelete).
- Optional route threading for edit attribution (§5.1): pass the acting
  user's id as the new optional `actorId` argument at
  routes/issues.ts PATCH issue / PATCH+DELETE comment, routes/pulls.ts PATCH
  pull, routes/issue-t2.ts PATCH+DELETE comment.
