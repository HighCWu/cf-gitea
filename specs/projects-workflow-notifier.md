# Project Workflow Execution — the upstream surface record and the as-built port

**Status**: IMPLEMENTED (v1.5.4, Wave K1). The workflow surface is CRUD plus
EXECUTION: the mutation seams emit into the reducer
(`apps/worker/src/services/projects-workflow.ts`), which runs each touched
project's enabled workflows through the filter grammar and executes their
actions through the same service writes the human arms use. The CRUD half
(routes/projects-repo.ts + services/projects.ts over `project_workflows`,
migration 0024) is unchanged. This record keeps Wave H's derivation and adds
the as-built section; any future shape change lands here in the same commit.
Source: the ⑯ review (docs/compat/v1.5.2-ledger.md §1.5 P2-3), Wave H's
derivation, this port's derivation against the pin.

## The upstream surface (gitea pin)

`services/projects/workflow_notifier.go` — a `workflowNotifier`
(NullNotifier) registered via `notify_service.RegisterNotifier`, reacting to
the **8 WorkflowEvent values** (`models/project/workflows.go:18-28`):

1. `item_added_to_project` — IssueChangeProjects, per added project id;
2. `item_removed_from_project` — IssueChangeProjects, per removed id;
3. `item_reopened` / 4. `item_closed` — IssueChangeStatus
   (`util.Iif(isClosed, Closed, Reopened)`);
5. `item_column_changed` — IssueChangeProjectColumn, carrying
   `{sourceColumnID, targetColumnID}` as the trigger;
6. `code_changes_requested` / 7. `code_review_approved` — PullRequestReview,
   official approve/reject reviews only;
8. `pull_request_merged` — MergePullRequest (AutoMergePullRequest delegates
   to it).

## The reducer

`runWorkflows` / `runIssueProjectsWorkflows` / `matchWorkflowFilters` /
`executeWorkflowActions`:

- Skip when the issue has no projects, or the context is a workflow's own
  mutation (`IsProjectWorkflowContext` — the re-entrancy guard; workflow
  actions run under `WithProjectWorkflow`).
- Skip archived repos.
- `FindEnabledWorkflows` (enabled + event match); re-fetch the issue ONCE
  and match ALL workflows against that snapshot ("filters see the item as
  the event left it, not as earlier workflows changed it").
- Filters: an unsupported rule → no match; `issue_type`;
  `source/target_column_id`; `label_ids` (ALL must be present).
- Actions: move to column (no-op when already there or the column vanished —
  `GetColumnByIDAndProjectID`'s not-found arm); add/remove labels; close;
  reopen (reopen gated to non-PR issues — PRs need the pull handlers'
  checks).
- Errors log and continue per workflow; a failing action never blocks its
  siblings.

## Our trigger sites when implemented

The landed issue/PR mutation seams — create-with-projects + PATCH projects
diff (the issues service's `AssignOrRemoveProjects` twin), status flips,
project-column add/remove/move (services/projects.ts), PR merge, and the
official review arms. The actions the workflows take must reuse the same
service writes as the human arms so audit/webhook/mail parity is inherited,
and every action site must set the re-entrancy context the guard reads.

## As-built (Wave K1)

### The reducer module

`apps/worker/src/services/projects-workflow.ts` ports the notifier as plain
async functions (no ambient context exists on the Workers runtime):

- Ports (the trigger sites call these after their writes commit):
  `notifyIssueChangeProjects` (removed-first-then-added order,
  workflow_notifier.go:32-35), `notifyIssueChangeStatus`,
  `notifyIssueChangeProjectColumn`, `notifyMergePullRequest`,
  `notifyPullRequestReview` (the official approve/reject gate lives in the
  port, :56-59).
- Internals mirror upstream 1:1: `runIssueProjectsWorkflows` (the issue's
  CURRENT project ids), `runWorkflows` (repo load + archived skip +
  `findEnabledWorkflows` + the once-per-event snapshot re-fetch + label
  load + filter match + the action loop), `matchWorkflowFilters`,
  `executeWorkflowActions` (per-action log-and-continue with upstream's
  `Project workflow %d: ...` prefixes), `moveIssueByWorkflow` (the raw
  membership column compare for the no-op — a legacy-0 row reads as 0 — and
  the vanished-column warn arm), `changeLabelsByWorkflow`.
- `findEnabledWorkflows` (workflows.go:220-231): enabled + event-matched +
  OPEN projects holding the repo's items —
  `repo_id = ? OR (owner_id = ? AND repo_id = '')` (the landed '' encodes
  upstream's `repo_id = 0` owner-scope marker) — ordered
  `project_id ASC, id ASC`. Joined with the project row (the landed
  `moveIssueToColumn` signature needs it).
- `unsupportedWorkflowRule` (workflows.go:171-184) lives in
  api/services/projects.ts beside the capability table; the private
  filters/actions JSON parsers are exported for the reducer (one parser).

### The re-entrancy mark

Upstream threads Go's `context` (`WithProjectWorkflow` /
`IsProjectWorkflowContext`, comment.go:259-270). The landed equivalent is
the explicit `viaWorkflow` value:

- the reducer builds `{ viaWorkflow: event, mailEnv }` per workflow and
  passes it to every write its actions perform;
- a mutation seam that receives the mark skips its own emission — a
  workflow's close cannot re-trigger `item_closed`, its move cannot
  re-trigger `item_column_changed` (`TransitionOptions.viaWorkflow` on the
  issues service, `WorkflowSeamOptions` on the projects columns arms);
- upstream checks the context at both notifier entries; ours checks at the
  seam — the only writes an action performs are the marked ones.

### The trigger sites wired

| Event | Seam | Upstream |
|---|---|---|
| `item_added_to_project` / `item_removed_from_project` | `assignOrRemoveIssueProjects` (api/services/issues.ts) — removals emit here (removed-first position); adds ride `addIssueToColumn`'s own attach emission | services/issue/project.go:17 (PATCH), services/issue/issue.go:88 (create tail), services/projects/issue.go:46/:97 |
| `item_added_to_project` + `item_column_changed` (attach + place) | `addIssueToColumn` (api/services/projects.ts) — notifyColumnMoves ordering (projects first, then the column) | services/projects/issue.go:45-46 |
| `item_removed_from_project` | `removeIssueFromColumn` | services/projects/issue.go:97 |
| `item_column_changed` | `moveIssueToColumn` — real column changes only (`moveIssueWithinProject` returns `{oldColumnId, moved}`) | services/projects/issue.go:120 (:177-189 collects only real moves) |
| `item_closed` / `item_reopened` | `IssuesService.transitionClosed` (issues/service.ts) — every real close/reopen seam funnels through it (PATCH arms, push-close, workflow state actions) | services/issue/status.go:43/:56 |
| `pull_request_merged` | `notifyMergePullRequest` — called from the merge family's winning arm (see Open item below) | merge.go:406 |
| `code_review_approved` / `code_changes_requested` | `PullReviewsService.submitReview` (api/services/pull-reviews.ts) after the review lands | services/pull/review.go:321 |

NOT wired, deliberately: `deleteColumnById`'s bulk move
("bulk moves intentionally don't trigger project workflows",
models/project/column.go:200 comment) and the column reorder
(`moveColumns`) — no per-issue column change upstream either.

### Actions reuse the human arms

- move-to-column → `moveIssueToColumn` (the type-31 comment, the legacy-0
  resolution and the sorting write are inherited);
- add/remove labels → `IssuesService.replaceLabels` (the PUT /labels write:
  type-7 trail, counters, the exclusive-scope dedupe). The target set is
  `current − remove + add` with adds positioned LAST so an add evicts its
  scope's occupant positionally; missing label ids drop silently
  (`GetLabelsByIDs`, models/issues/label.go:317-330); a target equal to the
  current set writes nothing;
- close/reopen → `IssuesService.closeIssue` / `reopenIssue` (the system
  comment, CAS and counters are inherited), gated on the SNAPSHOT
  (`!isClosed` / `isClosed && !isPull`, workflow_notifier.go:161-165).

### Guards (all verified by tests)

no projects → skip; archived repo → skip; `FindEnabledWorkflows`
predicate (enabled + event + open project + holds-repo); the filter
grammar incl. the unsupported-rule no-match; the once-per-event snapshot;
per-action log-and-continue; the vanished-column warn arm; the move no-op;
the reopen non-PR gate; the re-entrancy mark; the merge close's silence.

### Intentional adaptations (documented divergences)

1. **Merge close emits nothing** — upstream's merge close is the
   model-level `SetIssueAsClosed` (merge.go:838, no IssueChangeStatus
   notify); the merge's `pull_request_merged` notification carries the
   workflows instead. The landed `transitionClosed` keys the skip on the
   merge arm's `MergePull` comment type.
2. **The merge arm call site** (pull-engine.ts `mergePullRequest`, inside
   its `merged.length > 0` winner guard, next to the mail arm) — see
   "Open item" below.
3. **Mail env is inherited where the trigger has one** — `transitionClosed`
   and `submitReview` pass their service mail env into the emission, so a
   workflow's close/reopen action mails exactly when the human arm would.
   The projects columns arms and the projects-diff writer are env-less by
   signature (they take bare `D1Database`); their emissions run
   mail-less. An optional trailing `mailEnv` parameter exists on
   `assignOrRemoveIssueProjects`; the columns arms take
   `WorkflowSeamOptions.mailEnv`. Route hunks to pass `c.env` are a
   follow-up (one-line changes at the three projects route files' five
   call sites).
4. **Workflow-driven label changes do not emit webhooks/activity rows** —
   the landed label webhook (`issue_label`) and the close/reopen webhook
   ride the ROUTE arms (`emitIssueEvent`/`emitLabelEvent`), which machine
   arms do not run. Upstream's `AddRemoveLabels` notifies IssueChangeLabels
   and the actions notifier records activity rows. The system comments
   (types 2/3/7) ARE written — the audit trail is the comment stream, same
   as the landed merge-close posture (bare service, no mail env).
5. **The exclusive-scope dedupe applies to workflow label actions** —
   upstream `AddRemoveLabels` (NewIssueLabels + DeleteIssueLabel) leaves
   two same-scope labels attached; the landed write path (`replaceLabels`)
   dedupes positionally with the add winning. The net set is identical for
   disjoint add/remove configs (the only legal ones — the create/edit
   validation never sees scope conflicts).
6. **The timeline's special "ProjectWorkflow" doer rendering is not
   landed** — upstream stamps workflow comments with
   `CommentMetaData.special_doer_name` (comment.go:244-248, :849-859);
   the landed comments table has no meta column and migrations are out of
   scope. Workflow comments post as the triggering doer (poster_id = the
   event's doer), matching the landed nullable-poster convention.

### Testing

- `apps/worker/src/services/projects-workflow.test.ts` (20): the
  FindEnabledWorkflows predicate matrix, the filter grammar (issue_type,
  source/target via the trigger payload, label_ids ALL-present, the
  unsupported rule), the once-per-event snapshot, the action set (move +
  no-op + vanished column, labels with the type-7 trail, close with
  counters, reopen + the isPull gate), the guards (archived, no projects,
  both re-entrancy marks, the merge silence), the review port's gate, and
  the projects-diff writer seam.
- `apps/worker/src/api/routes/projects-repo.test.ts` (+3): the column add,
  column move and issue PATCH projects routes firing workflows end-to-end
  through real D1.

### Open item (orchestrator hunk)

`pull_request_merged` fires once pull-engine.ts's winning-merge arm calls
the port — the exact hunk (inside `if (merged.length > 0)`, beside
`notifyMailMergePullRequest`, api/services/pull-engine.ts:678):

```ts
    // The project-workflow arm (workflow_notifier.go:44-50): the merge's
    // MergePullRequest notification's workflow consumer — pull_request_merged
    // over the RELOADED closed issue (markAsMergedPostProcess's position,
    // merge.go:406). Best-effort past the landed merge: the port's reducer
    // logs per-action and never throws.
    try {
      await notifyMergePullRequest(c.env.DB, { issue: mergedIssue, doerId: opts.doerId, now: opts.now, mailEnv: c.env });
    } catch (error) {
      console.error(`[pull-engine] project workflow notify failed (issue ${issue.id}): ${error instanceof Error ? error.message : String(error)}`);
    }
```

with `import { notifyMergePullRequest } from "../../services/projects-workflow";`
added to pull-engine.ts's imports. The scheduled automerge inherits the
event through the same entry (it merges via `mergePullRequest`;
upstream AutoMergePullRequest delegates, workflow_notifier.go:52-54). The
direct-merge tests' close assertions stay unaffected (the reducer only
touches project-coupled rows).
