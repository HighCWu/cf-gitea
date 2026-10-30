import { z } from "@hono/zod-openapi";

/**
 * Mirrors of the vendored contract's issue-block definitions
 * (gitea/templates/swagger/v1-swagger.generated.json
 * #/definitions/{Issue, Comment, TimelineComment, Attachment,
 * RepositoryMeta, PullRequestMeta, CreateIssueOption, EditIssueOption,
 * CreateIssueCommentOption, EditIssueCommentOption, IssueLabelsOption}),
 * field-for-field. The contract declares no `required` fields on the
 * response models; the schemas mirror that literally. The `User`,
 * `Label`, and `Milestone` blocks are inlined (byte-identical to
 * models/user.ts / models/label.ts / models/milestone.ts) so the model file
 * mirrors the contract's own embedding.
 *
 * Go-nullability notes baked into the TS types (upstream marshals absent Go
 * values as null, never omits them — these structs carry no `omitempty`):
 * `milestone`/`assignee`/`assignees`/`closed_at`/`due_date`/
 * `pull_request`/`projects` are null when unset; `labels`/`assets` are the
 * upstream `util.SliceNilAsEmpty`/`make(…, 0)` empties and always render
 * `[]` (services/convert/issue.go toIssue + convert/attachment.go).
 */

/** `#/definitions/Attachment` — no assets exist yet; always rendered `[]`. */
export const attachmentSchema = z.object({
  browser_download_url: z.string().optional(),
  created_at: z.string().optional().openapi({ format: "date-time" }),
  download_count: z.number().int().optional(),
  id: z.number().int().optional().openapi({ format: "int64" }),
  name: z.string().optional(),
  size: z.number().int().optional().openapi({ format: "int64" }),
});

export type Attachment = z.infer<typeof attachmentSchema>;

/** `#/definitions/User` — inlined (identical to models/user.ts). */
export const embeddedUserSchema = z.object({
  active: z.boolean().optional(),
  avatar_url: z.string().optional(),
  created: z.string().optional().openapi({ format: "date-time" }),
  description: z.string().optional(),
  email: z.string().optional(),
  followers_count: z.number().int().optional().openapi({ format: "int64" }),
  following_count: z.number().int().optional().openapi({ format: "int64" }),
  full_name: z.string().optional(),
  html_url: z.string().optional(),
  id: z.number().int().optional().openapi({ format: "int64" }),
  is_admin: z.boolean().optional(),
  language: z.string().optional(),
  last_login: z.string().optional().openapi({ format: "date-time" }),
  location: z.string().optional(),
  login: z.string().optional(),
  login_name: z.string().optional(),
  prohibit_login: z.boolean().optional(),
  restricted: z.boolean().optional(),
  source_id: z.number().int().optional().openapi({ format: "int64" }),
  starred_repos_count: z.number().int().optional().openapi({ format: "int64" }),
  type: z.enum(["User", "Organization", "Bot"]).optional(),
  visibility: z.enum(["public", "limited", "private"]).optional(),
  website: z.string().optional(),
});

/** `#/definitions/RepositoryMeta` — the embedded issue.repository block. */
export const repositoryMetaSchema = z.object({
  full_name: z.string().optional(),
  id: z.number().int().optional().openapi({ format: "int64" }),
  name: z.string().optional(),
  owner: z.string().optional(),
});

export type RepositoryMeta = z.infer<typeof repositoryMetaSchema>;

/** `#/definitions/PullRequestMeta` — the embedded issue.pull_request block. */
export const pullRequestMetaSchema = z.object({
  draft: z.boolean().optional(),
  html_url: z.string().optional(),
  merged: z.boolean().optional(),
  merged_at: z.string().nullable().optional().openapi({ format: "date-time" }),
});

export type PullRequestMeta = z.infer<typeof pullRequestMetaSchema>;

/**
 * `#/definitions/Label` — same wire shape as the repo-label routes'
 * labelSchema (src/api/models/label.ts); re-declared so the Issue model is
 * self-contained, mirroring the contract's own embedding.
 */
export const issueLabelSchema = z.object({
  color: z.string().optional().openapi({ description: "Color is the display color, without the leading '#'" }),
  description: z
    .string()
    .optional()
    .openapi({ description: "Description provides additional context about the label's purpose" }),
  exclusive: z.boolean().optional(),
  id: z.number().int().optional().openapi({ format: "int64", description: "ID is the unique identifier for the label" }),
  is_archived: z.boolean().optional(),
  name: z.string().optional().openapi({ description: "Name is the display name of the label" }),
  url: z.string().optional().openapi({ description: "URL is the API endpoint for accessing this label" }),
});

/**
 * `#/definitions/Milestone` — same wire shape as the milestone routes'
 * milestoneSchema (src/api/models/milestone.ts); re-declared so the Issue
 * model is self-contained.
 */
export const issueMilestoneSchema = z.object({
  closed_at: z.string().nullable().optional().openapi({ format: "date-time" }),
  closed_issues: z
    .number()
    .int()
    .optional()
    .openapi({ format: "int64", description: "ClosedIssues is the number of closed issues in this milestone" }),
  created_at: z.string().optional().openapi({ format: "date-time" }),
  description: z.string().optional().openapi({ description: "Description provides details about the milestone" }),
  due_on: z.string().nullable().optional().openapi({ format: "date-time" }),
  id: z
    .number()
    .int()
    .optional()
    .openapi({ format: "int64", description: "ID is the unique identifier for the milestone" }),
  open_issues: z
    .number()
    .int()
    .optional()
    .openapi({ format: "int64", description: "OpenIssues is the number of open issues in this milestone" }),
  state: z
    .enum(["open", "closed"])
    .optional()
    .openapi({ description: "State indicates if the milestone is open or closed" }),
  title: z.string().optional().openapi({ description: "Title is the title of the milestone" }),
  updated_at: z.string().nullable().optional().openapi({ format: "date-time" }),
});

/** `#/definitions/Issue` — upstream `api.Issue` (modules/structs/issue.go). */
export const issueSchema = z.object({
  assets: z.array(attachmentSchema).optional(),
  assignee: embeddedUserSchema.nullable().optional(),
  assignees: z.array(embeddedUserSchema).nullable().optional(),
  body: z.string().optional(),
  closed_at: z.string().nullable().optional().openapi({ format: "date-time" }),
  comments: z.number().int().optional().openapi({ format: "int64" }),
  content_version: z.number().int().optional().openapi({ format: "int64" }),
  created_at: z.string().optional().openapi({ format: "date-time" }),
  due_date: z.string().nullable().optional().openapi({ format: "date-time" }),
  html_url: z.string().optional(),
  id: z.number().int().optional().openapi({ format: "int64" }),
  is_locked: z.boolean().optional(),
  labels: z.array(issueLabelSchema).optional(),
  milestone: issueMilestoneSchema.nullable().optional(),
  number: z.number().int().optional().openapi({ format: "int64" }),
  pin_order: z.number().int().optional().openapi({ format: "int64" }),
  projects: z.array(z.unknown()).nullable().optional(),
  pull_request: pullRequestMetaSchema.nullable().optional(),
  ref: z.string().optional(),
  repository: repositoryMetaSchema.nullable().optional(),
  state: z.enum(["open", "closed"]).optional(),
  time_estimate: z.number().int().optional().openapi({ format: "int64" }),
  title: z.string().optional(),
  updated_at: z.string().optional().openapi({ format: "date-time" }),
  url: z.string().optional(),
  user: embeddedUserSchema.nullable().optional(),
});

export type Issue = z.infer<typeof issueSchema>;

/** `#/responses/IssueList` — plain `Issue[]`. */
export const issueListSchema = z.array(issueSchema);

/** `#/definitions/Comment` — upstream `api.Comment` (issue_comment.go). */
export const commentSchema = z.object({
  assets: z.array(attachmentSchema).optional(),
  body: z.string().optional(),
  created_at: z.string().optional().openapi({ format: "date-time" }),
  html_url: z.string().optional(),
  id: z.number().int().optional().openapi({ format: "int64" }),
  issue_url: z.string().optional(),
  pull_request_url: z.string().optional(),
  updated_at: z.string().optional().openapi({ format: "date-time" }),
  user: embeddedUserSchema.nullable().optional(),
});

export type Comment = z.infer<typeof commentSchema>;

/** `#/responses/CommentList` — plain `Comment[]`. */
export const commentListSchema = z.array(commentSchema);

/**
 * `#/definitions/TimelineComment` — upstream `api.TimelineComment`
 * (issue_comment.go:47). Our comment rows carry the per-type metadata
 * columns, so the emitted subset covers: plain comments, close/reopen,
 * change_title (old/new_title), labels (label), milestones (old_milestone/
 * milestone), change_issue_ref (old_ref/new_ref), xrefs (ref_issue/
 * ref_commit_sha/ref_action), assignees (assignee/removed_assignee). The
 * schema mirrors the full contract model; deferred metadata (projects,
 * tracked times, reviews, teams) stays null at runtime — documented in
 * services/issues.ts.
 */
export const timelineCommentSchema = z.object({
  assignee: embeddedUserSchema.nullable().optional(),
  assignee_team: z.unknown().optional(),
  body: z.string().optional(),
  created_at: z.string().optional().openapi({ format: "date-time" }),
  dependent_issue: issueSchema.nullable().optional(),
  html_url: z.string().optional(),
  id: z.number().int().optional().openapi({ format: "int64" }),
  issue_url: z.string().optional(),
  label: issueLabelSchema.nullable().optional(),
  milestone: issueMilestoneSchema.nullable().optional(),
  new_ref: z.string().optional(),
  new_title: z.string().optional(),
  old_milestone: issueMilestoneSchema.nullable().optional(),
  old_project_id: z.number().int().optional().openapi({ format: "int64" }),
  old_ref: z.string().optional(),
  old_title: z.string().optional(),
  project_id: z.number().int().optional().openapi({ format: "int64" }),
  pull_request_url: z.string().optional(),
  ref_action: z.string().optional(),
  ref_comment: commentSchema.nullable().optional(),
  ref_commit_sha: z.string().optional(),
  ref_issue: issueSchema.nullable().optional(),
  removed_assignee: z.boolean().optional(),
  resolve_doer: embeddedUserSchema.nullable().optional(),
  review_id: z.number().int().optional().openapi({ format: "int64" }),
  tracked_time: z.unknown().nullable().optional(),
  type: z.string().optional(),
  updated_at: z.string().optional().openapi({ format: "date-time" }),
  user: embeddedUserSchema.nullable().optional(),
});

export type TimelineComment = z.infer<typeof timelineCommentSchema>;

/** `#/responses/TimelineList` — plain `TimelineComment[]`. */
export const timelineCommentListSchema = z.array(timelineCommentSchema);

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

/**
 * `#/definitions/CreateIssueOption` — `title` is the only required field
 * (bind failure → the declared 422); `labels` are label ids.
 */
export const createIssueOptionSchema = z.object({
  assignee: z.string().optional().openapi({ description: "deprecated (use assignees)" }),
  assignees: z.array(z.string()).optional(),
  body: z.string().optional(),
  closed: z.boolean().optional(),
  due_date: z
    .string()
    .optional()
    .openapi({ format: "date-time", description: "only the date is taken into account, time of day ignored" }),
  labels: z.array(z.number().int()).optional().openapi({ description: "list of label ids" }),
  milestone: z.number().int().optional().openapi({ format: "int64", description: "milestone id" }),
  projects: z.array(z.number().int()).optional(),
  ref: z.string().optional(),
  title: z.string().openapi({ description: "title of the issue" }),
});

export type CreateIssueOption = z.infer<typeof createIssueOptionSchema>;

/**
 * `#/definitions/EditIssueOption` — all fields are Go pointers upstream:
 * absent AND JSON-null both mean "leave unchanged" (the schema accepts null
 * so Go-style payloads never fail bind; the route treats them alike).
 * `unset_due_date: true` removes the deadline; `state` ∈ open|closed;
 * `content_version` enables the optimistic body-edit lock (409 on mismatch).
 */
export const editIssueOptionSchema = z.object({
  assignee: z.string().nullable().optional().openapi({ description: "deprecated (use assignees)" }),
  assignees: z.array(z.string()).nullable().optional(),
  body: z.string().nullable().optional(),
  content_version: z.number().int().nullable().optional().openapi({
    format: "int64",
    description: "optimistic locking for body edits; a stale version fails the request with 409 Conflict",
  }),
  due_date: z.string().nullable().optional().openapi({ format: "date-time" }),
  milestone: z.number().int().nullable().optional().openapi({ format: "int64" }),
  projects: z.array(z.number().int()).nullable().optional(),
  ref: z.string().nullable().optional(),
  state: z.string().nullable().optional().openapi({ description: "open or closed; transitions close/reopen" }),
  title: z.string().nullable().optional(),
  unset_due_date: z.boolean().nullable().optional(),
});

export type EditIssueOption = z.infer<typeof editIssueOptionSchema>;

/** `#/definitions/CreateIssueCommentOption` — `body` required (bind → 422):
 *  upstream's `binding:"Required"` (structs/issue_comment.go:37) fires on the
 *  zero value, so BOTH an absent and an empty string body fail the bind with
 *  422 (api.go:838-845) — the `.min(1)` is that rule. */
export const createIssueCommentOptionSchema = z.object({
  body: z.string().min(1).openapi({ description: "the comment text content" }),
});

export type CreateIssueCommentOption = z.infer<typeof createIssueCommentOptionSchema>;

/** `#/definitions/EditIssueCommentOption` — same `binding:"Required"` rule on
 *  the edit arm (structs/issue_comment.go:45): an empty/absent body 422s in
 *  the bind middleware before the handler runs. */
export const editIssueCommentOptionSchema = z.object({
  body: z.string().min(1).openapi({ description: "the updated comment text content" }),
});

export type EditIssueCommentOption = z.infer<typeof editIssueCommentOptionSchema>;

/**
 * `#/definitions/IssueLabelsOption` — upstream declares `labels` as a bare
 * array of objects (swagger-go cannot model the union): entries may be
 * integer label ids OR label names, never mixed (prepareForReplaceOrAdd
 * answers the mix with the runtime 400 "labels should be an array of
 * strings or integers"). The zod schema models the union; the route
 * enforces the homogeneity.
 */
export const issueLabelsOptionSchema = z.object({
  labels: z.array(z.union([z.number().int(), z.string()])).optional(),
});

export type IssueLabelsOption = z.infer<typeof issueLabelsOptionSchema>;
