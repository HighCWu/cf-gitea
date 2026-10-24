/**
 * Upstream comment-type system (SPEC-0005 §3.2 `comments.type`) — the 39
 * values 0–38 of `CommentType` (gitea/models/issues/comment.go). System
 * comments share the `comments` table with user comments; the value is the
 * discriminator, never a separate table.
 */
export const CommentType = {
  /** 0 Plain comment (with optional commit_sha / line). */
  Comment: 0,
  /** 1 Reopen. */
  Reopen: 1,
  /** 2 Close. */
  Close: 2,
  /** 3 Reference from an issue. */
  IssueRef: 3,
  /** 4 Reference from a commit (not part of a pull request). */
  CommitRef: 4,
  /** 5 Reference from a comment. */
  CommentRef: 5,
  /** 6 Reference from a pull request. */
  PullRef: 6,
  /** 7 Labels changed. */
  Label: 7,
  /** 8 Milestone changed. */
  Milestone: 8,
  /** 9 Assignees changed. */
  Assignees: 9,
  /** 10 Change title. */
  ChangeTitle: 10,
  /** 11 Delete branch. */
  DeleteBranch: 11,
  /** 12 Start a stopwatch for time tracking. */
  StartTracking: 12,
  /** 13 Stop a stopwatch for time tracking. */
  StopTracking: 13,
  /** 14 Add time manually. */
  AddTimeManual: 14,
  /** 15 Cancel a stopwatch for time tracking. */
  CancelTracking: 15,
  /** 16 Added a due date. */
  AddedDeadline: 16,
  /** 17 Modified the due date. */
  ModifiedDeadline: 17,
  /** 18 Removed a due date. */
  RemovedDeadline: 18,
  /** 19 Dependency added. */
  AddDependency: 19,
  /** 20 Dependency removed. */
  RemoveDependency: 20,
  /** 21 Comment on a line of code. */
  Code: 21,
  /** 22 Review of a pull request (general feedback). */
  Review: 22,
  /** 23 Lock an issue (collaborators-only commenting, §2.2). */
  Lock: 23,
  /** 24 Unlock a previously locked issue. */
  Unlock: 24,
  /** 25 Change pull request's target branch. */
  ChangeTargetBranch: 25,
  /** 26 Delete tracked time manually. */
  DeleteTimeManual: 26,
  /** 27 Review request added/removed. */
  ReviewRequest: 27,
  /** 28 Pull request merged (closes the issue, §2.4). */
  MergePull: 28,
  /** 29 Push to PR head branch — `content` holds PushActionContent JSON. */
  PullRequestPush: 29,
  /** 30 Project changed. */
  Project: 30,
  /** 31 Project column changed. */
  ProjectColumn: 31,
  /** 32 Review dismissed. */
  DismissReview: 32,
  /** 33 Change issue ref. */
  ChangeIssueRef: 33,
  /** 34 PR scheduled to auto merge. */
  PRScheduledToAutoMerge: 34,
  /** 35 PR unscheduled from auto merge. */
  PRUnscheduledToAutoMerge: 35,
  /** 36 Pin issue/PR. */
  Pin: 36,
  /** 37 Unpin issue/PR. */
  Unpin: 37,
  /** 38 Change time estimate. */
  ChangeTimeEstimate: 38,
} as const;

export type CommentTypeValue = (typeof CommentType)[keyof typeof CommentType];

/** Cross-reference actions (§2.2, gitea/modules/references/references.go:66–76). */
export const RefAction = {
  None: 0,
  Closes: 1,
  Reopens: 2,
  Neutered: 3,
} as const;
