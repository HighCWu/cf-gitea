import { z } from "@hono/zod-openapi";

import { embeddedUserSchema, issueLabelSchema, issueMilestoneSchema } from "./issue";
import { repositorySchema } from "./repository";

/**
 * Mirrors of the vendored contract's pull-request definitions
 * (gitea/templates/swagger/v1-swagger.generated.json
 * #/definitions/{PullRequest, PRBranchInfo, CreatePullRequestOption,
 * EditPullRequestOption}), field-for-field. The contract declares no
 * `required` fields on the response models; the schemas mirror that
 * literally. The `User`/`Label`/`Milestone` blocks are the same embedded
 * schemas models/issue.ts declares (byte-identical re-use, matching the
 * contract's own refs), and `PRBranchInfo.repo` is the registered
 * `Repository` component (models/repository.ts) so the emitted document
 * carries ONE Repository schema instead of a second copy.
 *
 * Go-nullability notes baked into the TS types (upstream marshals absent Go
 * values as null, never omits them — these struct fields carry no
 * `omitempty`): `user`/`assignee`/`milestone`/`merged_by`/`base`/`head`/
 * `closed_at`/`due_date`/`merged_at`/`merge_commit_sha` are null when unset;
 * `labels`/`requested_reviewers`/`requested_reviewers_teams` render `[]`
 * (upstream: "output [] rather than null to align to github outputs",
 * services/convert/pull.go). The upstream-`omitempty` fields
 * (`review_comments`, `additions`, `deletions`, `changed_files`) are
 * optional and omitted at runtime until the engine wave supplies real
 * values (list never sets them: services/convert/pull.go:488-492).
 *
 * Documented deviation (SPEC-0005 §3.4 — mergeability is the 0001b engine
 * wave): the contract types `mergeable` as boolean, but upstream's value is
 * computed from the async mergeability state machine; until the engine RPCs
 * land we render `null` (unknown) per upstream's checking-status semantics.
 */

/** `#/definitions/PRBranchInfo` — base/head branch block. */
export const prBranchInfoSchema = z.object({
  label: z.string().optional().openapi({ description: "The display name of the branch" }),
  ref: z.string().optional().openapi({ description: "The git reference of the branch" }),
  sha: z.string().optional().openapi({ description: "The commit SHA of the branch head" }),
  repo_id: z.number().int().optional().openapi({ format: "int64", description: "The unique identifier of the repository" }),
  repo: repositorySchema.optional(),
});

export type PRBranchInfo = z.infer<typeof prBranchInfoSchema>;

/** `#/definitions/PullRequest` — upstream `api.PullRequest` (structs/pull.go). */
export const pullRequestSchema = z.object({
  additions: z.number().int().optional().openapi({ format: "int64", description: "The number of lines added in the pull request" }),
  allow_maintainer_edit: z.boolean().optional().openapi({ description: "Whether maintainers can edit the pull request" }),
  assignee: embeddedUserSchema.nullable().optional(),
  assignees: z.array(embeddedUserSchema).nullable().optional(),
  base: prBranchInfoSchema.optional(),
  body: z.string().optional(),
  changed_files: z.number().int().optional().openapi({ format: "int64", description: "The number of files changed in the pull request" }),
  closed_at: z.string().nullable().optional().openapi({ format: "date-time" }),
  comments: z.number().int().optional().openapi({ format: "int64" }),
  content_version: z.number().int().optional().openapi({ format: "int64" }),
  created_at: z.string().optional().openapi({ format: "date-time" }),
  deletions: z.number().int().optional().openapi({ format: "int64", description: "The number of lines deleted in the pull request" }),
  diff_url: z.string().optional().openapi({ description: "The URL to download the diff patch" }),
  draft: z.boolean().optional().openapi({ description: "Whether the pull request is a draft" }),
  due_date: z.string().nullable().optional().openapi({ format: "date-time" }),
  head: prBranchInfoSchema.optional(),
  html_url: z.string().optional(),
  id: z.number().int().optional().openapi({ format: "int64", description: "The unique identifier of the pull request" }),
  is_locked: z.boolean().optional().openapi({ description: "Whether the pull request conversation is locked" }),
  labels: z.array(issueLabelSchema).optional(),
  merge_base: z.string().optional().openapi({ description: "The merge base commit SHA" }),
  merge_commit_sha: z.string().nullable().optional().openapi({ description: "The SHA of the merge commit" }),
  mergeable: z
    .boolean()
    .nullable()
    .optional()
    .openapi({ description: "Whether the pull request can be merged (null = unknown — the mergeability check has not run)" }),
  merged: z.boolean().optional().openapi({ description: "Whether the pull request has been merged" }),
  merged_at: z.string().nullable().optional().openapi({ format: "date-time" }),
  merged_by: embeddedUserSchema.nullable().optional(),
  milestone: issueMilestoneSchema.nullable().optional(),
  number: z.number().int().optional().openapi({ format: "int64", description: "The pull request number" }),
  patch_url: z.string().optional().openapi({ description: "The URL to download the patch file" }),
  pin_order: z.number().int().optional().openapi({ format: "int64" }),
  requested_reviewers: z.array(embeddedUserSchema).optional().openapi({ description: "The users requested to review the pull request" }),
  requested_reviewers_teams: z.array(z.unknown()).optional().openapi({ description: "The teams requested to review the pull request" }),
  review_comments: z
    .number()
    .int()
    .optional()
    .openapi({ format: "int64", description: "number of review comments made on the diff of a PR review" }),
  state: z.enum(["open", "closed"]).optional(),
  title: z.string().optional(),
  updated_at: z.string().optional().openapi({ format: "date-time" }),
  url: z.string().optional().openapi({ description: "The API URL of the pull request" }),
  user: embeddedUserSchema.nullable().optional(),
});

export type PullRequest = z.infer<typeof pullRequestSchema>;

/** `#/responses/PullRequestList` — plain `PullRequest[]`. */
export const pullRequestListSchema = z.array(pullRequestSchema);

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

/**
 * `#/definitions/CreatePullRequestOption` — `head`/`base`/`title` required
 * (bind failure → the declared 422). `head` may be `<username>:<branch>`
 * (fork form); forks do not exist yet, so the fork form resolves to the
 * documented 422 until SPEC-0003's fork primitives land.
 */
export const createPullRequestOptionSchema = z.object({
  allow_maintainer_edit: z.boolean().nullable().optional(),
  assignee: z.string().optional().openapi({ description: "deprecated (use assignees)" }),
  assignees: z.array(z.string()).optional(),
  base: z.string().openapi({ description: "The base branch for the pull request" }),
  body: z.string().optional(),
  due_date: z.string().nullable().optional().openapi({ format: "date-time" }),
  head: z
    .string()
    .openapi({ description: "The head branch for the pull request, it could be a branch name on the base repository or a form like `<username>:<branch>`" }),
  labels: z.array(z.number().int()).optional().openapi({ description: "The list of label IDs" }),
  milestone: z.number().int().optional().openapi({ format: "int64", description: "The milestone ID" }),
  reviewers: z.array(z.string()).optional(),
  team_reviewers: z.array(z.string()).optional(),
  title: z.string().openapi({ description: "The title of the pull request" }),
});

export type CreatePullRequestOption = z.infer<typeof createPullRequestOptionSchema>;

/**
 * `#/definitions/EditPullRequestOption` — all fields are Go pointers/values
 * upstream: absent AND JSON-null both mean "leave unchanged" (the schema
 * accepts null so Go-style payloads never fail bind). `state` ∈ open|closed
 * (412 once merged); `base` retargets (engine-gated upstream — deferred);
 * `content_version` enables the optimistic body-edit lock (409 on mismatch).
 */
export const editPullRequestOptionSchema = z.object({
  allow_maintainer_edit: z.boolean().nullable().optional(),
  assignee: z.string().nullable().optional().openapi({ description: "deprecated (use assignees)" }),
  assignees: z.array(z.string()).nullable().optional(),
  base: z.string().nullable().optional().openapi({ description: "The new base branch for the pull request" }),
  body: z.string().nullable().optional(),
  content_version: z.number().int().nullable().optional().openapi({
    format: "int64",
    description: "optimistic locking for body edits; a stale version fails the request with 409 Conflict",
  }),
  due_date: z.string().nullable().optional().openapi({ format: "date-time" }),
  labels: z.array(z.number().int()).nullable().optional(),
  milestone: z.number().int().nullable().optional().openapi({ format: "int64" }),
  state: z.string().nullable().optional().openapi({ description: "open or closed; transitions close/reopen" }),
  title: z.string().nullable().optional(),
  unset_due_date: z.boolean().nullable().optional(),
});

export type EditPullRequestOption = z.infer<typeof editPullRequestOptionSchema>;

/** `#/definitions/MergePullRequestOption` — POST …/pulls/{index}/merge body. */
export const mergePullRequestOptionSchema = z.object({
  delete_branch_after_merge: z.boolean().optional(),
  do: z
    .enum(["merge", "rebase", "rebase-merge", "squash", "fast-forward-only", "manually-merged"])
    .openapi({ description: "merge style" }),
  force_merge: z.boolean().optional(),
  head_commit_id: z.string().optional(),
  merge_commit_id: z.string().optional().openapi({ description: "manually-merged: the commit the caller merged" }),
  merge_message_field: z.string().optional(),
  merge_title_field: z.string().optional(),
  merge_when_checks_succeed: z.boolean().optional(),
});

export type MergePullRequestOption = z.infer<typeof mergePullRequestOptionSchema>;

/** `#/definitions/MergeUpstreamRequest` — POST /merge-upstream body. */
export const mergeUpstreamRequestSchema = z.object({
  branch: z.string().openapi({ description: "branch to merge into" }),
  ff_only: z.boolean().optional(),
});

export type MergeUpstreamRequest = z.infer<typeof mergeUpstreamRequestSchema>;

/** `#/definitions/MergeUpstreamResponse`. */
export const mergeUpstreamResponseSchema = z.object({
  merge_type: z.string().optional(),
});

export type MergeUpstreamResponse = z.infer<typeof mergeUpstreamResponseSchema>;
