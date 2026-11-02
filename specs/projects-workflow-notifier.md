# Project Workflow Execution — the DEFERRED upstream surface record

**Status**: DEFERRED (SPEC-gated, ledger P2-3). The workflow surface at this
pin is CRUD-only (routes/projects-repo.ts + services/projects.ts over
`project_workflows`, migration 0024); `runs_as_hint`-style presentation is
live, but no execution fires. This record captures the upstream surface so
the future implementation SPEC lands the port without re-derivation.
Source: the ⑯ review (docs/compat/v1.5.2-ledger.md §1.5 P2-3), Wave H's
derivation against the pin.

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
