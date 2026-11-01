# SPEC-0023: Scoped (exclusive) label semantics

Status: implemented in this change
Owner: issues data layer + issue-detail sidebar
Upstream pin: go-gitea/gitea submodule (read-only reference)

## 1. Problem and scope

The schema carries `labels.exclusive` + `labels.exclusive_order` and the API
advertises `exclusive`, but no exclusive semantics ever run: two same-scope
exclusive labels coexist on an issue, the replace arm does not dedupe scopes,
and the sidebar renders no exclusive handling at all.

In scope:

- The attach arms — single (`IssuesService.setLabel`) and the multi attach
  (the API route loops `setLabel` per requested id, which composes upstream's
  per-label `newIssueLabels` loop exactly).
- The replace arm (`IssuesService.replaceLabels`) — including the UI sidebar
  write that funnels through it.
- The label (type 7) timeline comments these arms now produce (adds and
  removals).
- The issue-detail sidebar label picker: upstream's scope-sorted, scope-grouped
  rendering and the tri-state selection rule, reduced to our no-JS form.
- Pure helpers: `labelExclusiveScope`, `removeDuplicateExclusiveLabels`,
  `sortLabelsForDisplay` in `api/services/labels.ts`.

Out of scope:

- Issue-creation-time attach (`issueCreationStatements`): upstream's `NewIssue`
  inserts labels via `newIssueLabel` DIRECTLY (models/issues/issue_update.go:
  423-433) — no `RemoveDuplicateExclusiveIssueLabels`, no scope dedupe at
  creation. Mirrored: creation stays as landed.
- Rendering type-7 comments in the timeline (the module header's documented
  reduction set — they stay omitted; the rows land so parity catches up when
  that wave opens).
- The issues-list filter dropdown's tri-state (`LoadSelectedLabelsAfterClick`
  over `?labels=`) — no landed filter-label UI yet.

## 2. Upstream semantics (the pins)

### 2.1 Scope resolution — `Label.ExclusiveScope`

`gitea/models/issues/label.go:184-191`: a non-exclusive label has no scope.
For an exclusive label, cut the name at the LAST `/`; scope = the part before
it. Either half empty → no scope: `scope/` and `/name` are scope-less;
`a/b/c` has scope `a/b`.

The rule is purely NAME-based — there is no repo/org dimension. A repo label
`priority/high` and an org label `priority/low` share scope `priority` and
exclude each other on the same issue.

### 2.2 Attach — `RemoveDuplicateExclusiveIssueLabels` + `NewIssueLabel` /
`newIssueLabels`

`gitea/models/issues/issue_label.go:63-83`: before inserting the new link,
every OTHER attached label whose exclusive scope equals the incoming label's
scope is detached via `deleteIssueLabel` — the same path as an explicit
detach: link delete, then the type-7 (CommentTypeLabel) removal comment
(content ""), then the closed-state-aware label counter fold
(`updateLabelCols`). Upstream `NewIssueLabel` (:85-111) runs this BEFORE
`newIssueLabel` (:33-62), which inserts the link and writes the type-7 ADD
comment (content `"1"`) + counter bump. Already-attached labels short-circuit
(`HasIssueLabel` → nil, no dedupe, no comments).

`newIssueLabels` (:113-140) loops the requested list in order, per label:
skip already-present/invalid → dedupe scope → insert + add comment. Because
each iteration re-reads the issue's labels (the previous iteration's insert
is visible via `issue.Labels = append(...)` in `newIssueLabel`), a request
`[A(scope s), B(scope s)]` produces: add A, remove A, add B — the LAST label
in the request wins, and every transition is commented. Our route loops
`setLabel` over the request in order, so per-label processing reproduces this
exactly.

### 2.3 Replace — `RemoveDuplicateExclusiveLabels`

`gitea/models/issues/issue_label.go:356-373`: the REQUESTED set is filtered
to one label per scope BEFORE diffing — a label is kept only if NO LATER
entry in the requested array has the same scope ("labels at the end of the
array getting preference over earlier ones"). The filtered set then goes
through the normal diff: additions via `newIssueLabels`, removals via
`deleteIssueLabel`, adds commented before removes (services order:
`ReplaceIssueLabels` processes toAdd first, then toRemove;
issue_label.go:396-414). A requested set of only scope-less labels therefore
clears every scope label as plain diff removals, each commented and counted.

**Ordering rule (read at the pin):** `exclusive_order` does NOT break
attach/replace ties. The tie-break is positional — request order for replace
(:356-373), processing order for attach (:113-140). `ExclusiveOrder` is read
ONLY by display ordering (`CompareLabelForDisplay` / `SortLabelsForDisplay`,
label.go:196-230): scope-less labels first, then scope groups by scope name;
within a scope, `exclusive_order` ascending with order <= 0 treated as last,
falling back to name.

### 2.4 Sidebar tri-state

Server-rendered rule the pin implements: `LoadSelectedLabelsAfterClick`
(models/issues/label.go:143-171) computes per-label selection after a click —
clicking an exclusive label selects it exclusive-of-scope (same-scope
selections drop out), clicking the selected exclusive label clears it. The
client-side sidebar dropdown (web_src/js/features/
repo-issue-sidebar-combolist.ts:162-185, `onItemClick`) implements the same
rule live: a scoped item clicked while checked toggles OFF; otherwise all
same-scope items uncheck and the clicked one checks. There are NO alt-click
semantics in either implementation. The picker list is scope-sorted with
scope dividers (templates/repo/issue/sidebar/label_list.tmpl:23-39) and each
item carries `data-scope` (label_list_item.tmpl:4) — the attribute the JS
keys on.

## 3. Data model

No migration. Existing columns: `labels.exclusive` (boolean),
`labels.exclusive_order` (integer, 0 = none), `labels.name` (scope source),
`issue_labels(issue_id, label_id)`, `comments(type=7, label_id, content)`.

## 4. Our arms

### 4.1 `labelExclusiveScope(label)` — api/services/labels.ts

Port of §2.1. `""` for non-exclusive, no `/`, empty leading or trailing half.

### 4.2 `removeDuplicateExclusiveLabels(list, scopeOf)` — api/services/labels.ts

Port of §2.3: positional filter, later request entries win. `exclusive_order`
plays no role here (§2.3's ordering rule).

### 4.3 `setLabel` (attach single) — issues/service.ts

Order mirrors §2.2's `NewIssueLabel`:

1. Validity checks as landed (missing/foreign label throws).
2. Already attached → return false, nothing written (`HasIssueLabel`).
3. Scope dedupe first: each attached label sharing the incoming label's
   non-empty scope is detached via the seam shape of
   `removeIssueLabel` (issue-write-t2.ts:430-462, U5-owned, composed not
   edited): link delete `.returning()` guard, then a type-7 removal comment
   (content `""`) + closed-state-aware label counter fold
   (`MAX(num_issues - 1, 0)` shape) + `issues.num_comments + 1`.
4. Attach: link insert `.returning()` guard → type-7 ADD comment
   (content `"1"`) + counter increment + `issues.num_comments + 1`.
5. `issues.updated_at` bump; return attached-or-not.

Multi attach composes: the API route loops `setLabel` in request order, so
the last same-scope id in the request wins with the full add/remove comment
trail of §2.2.

### 4.4 `replaceLabels` (replace) — issues/service.ts

1. Validate + dedupe requested ids as landed.
2. Fetch the requested rows; filter through `removeDuplicateExclusiveLabels`
   (§2.3, positional).
3. Diff the filtered set against current (unchanged logic).
4. Comments in upstream's replace order — toAdd first, then toRemove — each
   through the same returning-guard + type-7 comment + counter + num_comments
   seam as §4.3.
5. `ReplaceLabelsResult` shape unchanged (`added`/`removed` are the ids the
   diff actually applied, post-filter).

### 4.5 Sidebar (issue-detail.tsx)

The no-JS checkbox reduction collapses upstream's client-side click rule into
its server-visible results:

- The picker list is ordered by `sortLabelsForDisplay` (the §2.3 display
  order — scope-less first, scope groups, `exclusive_order` asc with <= 0
  last, name tie-break; routers/web/repo/issue_page_meta.go:605-613 applies
  exactly this to the sidebar's repo and org lists).
- Scope-group dividers render between differing scopes
  (sidebar/label_list.tmpl:23-39), each carrying `data-scope`.
- Every item carries `data-scope` (label_list_item.tmpl:4) — scoped items are
  mutually exclusive by construction; submitting two same-scope ids (HTML
  checkboxes cannot click-intercept) resolves per §4.4 with the LAST DOM
  position winning, which is the post-click state upstream's JS produces for
  the clicked label being the last interaction.
- The submitted set flows through `applyIssueLabels` → `replaceLabels`, so
  the tri-state outcome ("click selects exclusive-of-scope; re-click clears;
  a different same-scope click replaces") is enforced server-side.

## 5. Edge cases

- Non-exclusive labels: `exclusiveScope() === ""` — never removed by dedupe,
  never filtered from a replace set.
- Scope-less exclusive labels (names without a qualifying `/` split):
  exclusive flag is inert — treated exactly like non-exclusive labels by
  every arm (upstream identical: the scope guard is the only gate).
- Mixed repo+org sets: scope is name-only (§2.1), so repo and org labels in
  the same scope exclude each other. Validity still follows the landed
  repo/org drop rule (`labelAppliesToRepo`).
- Attaching an already-attached exclusive label: no dedupe, no comments
  (upstream `HasIssueLabel` short-circuit) — even if it is the current
  same-scope occupant.
- Replace with a duplicated same-scope pair where one is already attached:
  positional filter resolves it (e.g. current `L1`, request `[L2, L1]` →
  keeps `L1`, no-op; request `[L1, L2]` → keeps `L2`, removes `L1`, adds
  `L2`).
- Clear (replace with `[]`): every attached label becomes a diff removal,
  commented and counted (upstream `clearIssueLabels` → `deleteIssueLabel`
  each).

## 6. Testing plan

Service suite (`issues/service.test.ts`):

- Attach two same-scope exclusives (two `setLabel` calls): only the second
  remains, counters net right, comment trail = add A / remove A / add B.
- Attach a non-exclusive label alongside an exclusive one: both remain.
- Attach single: removal of the previous scope occupant precedes the add
  comment (type 7, content "" then "1"), `num_comments` counts them.
- Replace with two same-scope ids in the request: one-per-scope applied,
  positional winner pinned; result ids reported post-filter.
- Replace with a scope-less set: scope labels leave as removals (comments +
  counter folds).
- Replace keeping the current occupant (order `[new, current]`): no-op.
- `exclusive_order` pinned as display-only: attach ignores it entirely.
- `labelExclusiveScope` unit pins: `a/b` → `a`, `a/b/c` → `a/b`, `scope/` and
  `/name` and no-slash and non-exclusive → `""`.

UI suite (`issue-detail.matrix.test.tsx`):

- Rendered states: picker items carry `data-scope`; scope dividers render;
  scope-less labels list before scoped groups; within a scope,
  `exclusive_order` sorts with 0-order labels last.
- Submit two same-scope ids via the sidebar form: only the later DOM position
  survives (the §4.4 server-side tri-state).
