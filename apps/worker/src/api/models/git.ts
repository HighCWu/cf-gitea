import { z } from "@hono/zod-openapi";

import { embeddedUserSchema } from "./issue";

/**
 * Mirrors of the vendored contract's git-object definitions
 * (gitea/templates/swagger/v1-swagger.generated.json
 * #/definitions/{PayloadUser, PayloadCommitVerification, PayloadCommit,
 * CommitMeta, CommitUser, Identity, CommitStats, RepoCommit, Commit,
 * GitObject, Reference, GitEntry, GitTreeResponse, GitBlobResponse,
 * AnnotatedTagObject, AnnotatedTag, Branch, Tag, Compare, ChangedFile}),
 * field-for-field. The contract declares no `required` fields on response
 * models; the schemas mirror that literally.
 */

/** `#/definitions/Identity` — author/committer name+email block on write bodies. */
export const identitySchema = z.object({
  email: z.string().optional().openapi({ format: "email" }),
  name: z.string().optional(),
});

export type Identity = z.infer<typeof identitySchema>;

/** `#/definitions/CommitDateOptions`. */
export const commitDateOptionsSchema = z.object({
  author: z.string().optional().openapi({ format: "date-time" }),
  committer: z.string().optional().openapi({ format: "date-time" }),
});

export type CommitDateOptions = z.infer<typeof commitDateOptionsSchema>;

/** `#/definitions/PayloadUser` — commit author/committer block (PayloadCommit). */
export const payloadUserSchema = z.object({
  email: z.string().optional(),
  name: z.string().optional(),
  username: z.string().optional(),
});

export type PayloadUser = z.infer<typeof payloadUserSchema>;

/** `#/definitions/PayloadCommitVerification` — gpg state; always unverified here. */
export const payloadCommitVerificationSchema = z.object({
  payload: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  signature: z.string().nullable().optional(),
  signer: payloadUserSchema.nullable().optional(),
  verified: z.boolean().optional(),
});

export type PayloadCommitVerification = z.infer<typeof payloadCommitVerificationSchema>;

/** `#/definitions/CommitMeta` — {sha, url, created} reference block. */
export const commitMetaSchema = z.object({
  created: z.string().optional().openapi({ format: "date-time" }),
  sha: z.string().optional(),
  url: z.string().optional(),
});

export type CommitMeta = z.infer<typeof commitMetaSchema>;

/** `#/definitions/CommitUser` — git identity + RFC3339 date (RepoCommit block). */
export const commitUserSchema = z.object({
  date: z.string().optional(),
  email: z.string().optional(),
  name: z.string().optional(),
});

export type CommitUser = z.infer<typeof commitUserSchema>;

/** `#/definitions/CommitStats` — diff line counters (stat=true rendering). */
export const commitStatsSchema = z.object({
  additions: z.number().int().optional(),
  deletions: z.number().int().optional(),
  total: z.number().int().optional(),
});

export type CommitStats = z.infer<typeof commitStatsSchema>;

/** `#/definitions/RepoCommit` — the git commit object view (Commit.commit). */
export const repoCommitSchema = z.object({
  author: commitUserSchema.optional(),
  committer: commitUserSchema.optional(),
  message: z.string().optional(),
  tree: commitMetaSchema.optional(),
  url: z.string().optional(),
  verification: payloadCommitVerificationSchema.nullable().optional(),
});

export type RepoCommit = z.infer<typeof repoCommitSchema>;

/** `#/definitions/CommitAffectedFiles` — per-commit touched-file entries. */
export const commitAffectedFilesSchema = z.object({
  filename: z.string().optional(),
  status: z.string().optional(),
});

/** `#/definitions/PayloadCommit` — branch/tag/commit summary used across payloads. */
export const payloadCommitSchema = z.object({
  added: z.array(z.string()).optional(),
  author: payloadUserSchema.optional(),
  committer: payloadUserSchema.optional(),
  id: z.string().optional(),
  message: z.string().optional(),
  modified: z.array(z.string()).optional(),
  removed: z.array(z.string()).optional(),
  timestamp: z.string().optional().openapi({ format: "date-time" }),
  url: z.string().optional(),
  verification: payloadCommitVerificationSchema.nullable().optional(),
});

export type PayloadCommit = z.infer<typeof payloadCommitSchema>;

/** `#/definitions/Commit` — the rich commit view (commits list/single, PR commits). */
export const commitSchema = z.object({
  author: embeddedUserSchema.nullable().optional(),
  committer: embeddedUserSchema.nullable().optional(),
  created: z.string().optional().openapi({ format: "date-time" }),
  files: z.array(commitAffectedFilesSchema).optional(),
  html_url: z.string().optional(),
  parents: z.array(commitMetaSchema).optional(),
  sha: z.string().optional(),
  stats: commitStatsSchema.optional(),
  url: z.string().optional(),
  // The contract models Commit.commit as a `*RepositoryCommit` (RepoCommit).
  commit: repoCommitSchema.optional(),
});

export type Commit = z.infer<typeof commitSchema>;

/** `#/responses/CommitList` — plain `Commit[]` (the only X-* header family). */
export const commitListSchema = z.array(commitSchema);

/** `#/definitions/GitObject` — {sha, type, url} for Reference.object. */
export const gitObjectSchema = z.object({
  sha: z.string().optional(),
  type: z.string().optional(),
  url: z.string().optional(),
});

/** `#/definitions/Reference` — the raw git-ref read (git/refs family). */
export const referenceSchema = z.object({
  object: gitObjectSchema.optional(),
  ref: z.string().optional(),
  url: z.string().optional(),
});

export type Reference = z.infer<typeof referenceSchema>;

/** `#/definitions/GitEntry` — one GitTreeResponse entry (path/sha, not name/oid). */
export const gitEntrySchema = z.object({
  mode: z.string().optional(),
  path: z.string().optional(),
  sha: z.string().optional(),
  size: z.number().int().nullable().optional().openapi({ format: "int64" }),
  type: z.string().optional(),
  url: z.string().optional(),
});

export type GitEntry = z.infer<typeof gitEntrySchema>;

/** `#/definitions/GitTreeResponse` — git/trees read (page/per_page pagination). */
export const gitTreeResponseSchema = z.object({
  page: z.number().int().optional(),
  sha: z.string().optional(),
  total_count: z.number().int().optional(),
  tree: z.array(gitEntrySchema).optional(),
  truncated: z.boolean().optional(),
  url: z.string().optional(),
});

export type GitTreeResponse = z.infer<typeof gitTreeResponseSchema>;

/** `#/definitions/GitBlobResponse` — git/blobs read (base64 content). */
export const gitBlobResponseSchema = z.object({
  content: z.string().optional(),
  encoding: z.string().optional(),
  lfs_oid: z.string().optional(),
  lfs_size: z.number().int().optional().openapi({ format: "int64" }),
  sha: z.string().optional(),
  size: z.number().int().optional().openapi({ format: "int64" }),
  url: z.string().optional(),
});

export type GitBlobResponse = z.infer<typeof gitBlobResponseSchema>;

/** `#/definitions/AnnotatedTagObject` — the peeled commit behind a tag object. */
export const annotatedTagObjectSchema = z.object({
  sha: z.string().optional(),
  type: z.string().optional(),
  url: z.string().optional(),
});

/** `#/definitions/AnnotatedTag` — git/tags/{sha} (annotated tag objects only). */
export const annotatedTagSchema = z.object({
  message: z.string().optional(),
  object: annotatedTagObjectSchema.optional(),
  sha: z.string().optional(),
  tag: z.string().optional(),
  tagger: commitUserSchema.nullable().optional(),
  url: z.string().optional(),
  verification: payloadCommitVerificationSchema.nullable().optional(),
});

export type AnnotatedTag = z.infer<typeof annotatedTagSchema>;

/** `#/definitions/Branch` — branches family (protection flags default to off). */
export const branchSchema = z.object({
  commit: payloadCommitSchema.optional(),
  effective_branch_protection_name: z.string().optional(),
  enable_status_check: z.boolean().optional(),
  name: z.string().optional(),
  protected: z.boolean().optional(),
  required_approvals: z.number().int().optional(),
  status_check_contexts: z.array(z.string()).optional(),
  user_can_merge: z.boolean().optional(),
  user_can_push: z.boolean().optional(),
});

export type Branch = z.infer<typeof branchSchema>;

/** `#/definitions/Tag` — tags family (`commit` is the CommitMeta of the target). */
export const tagSchema = z.object({
  commit: commitMetaSchema.optional(),
  id: z.string().optional(),
  message: z.string().nullable().optional(),
  name: z.string().optional(),
  tarball_url: z.string().optional(),
  zipball_url: z.string().optional(),
});

export type Tag = z.infer<typeof tagSchema>;

/** `#/definitions/Compare` — compare/{basehead} (commits + their count). */
export const compareSchema = z.object({
  commits: z.array(commitSchema).optional(),
  total_commits: z.number().int().optional(),
});

export type Compare = z.infer<typeof compareSchema>;

/** `#/definitions/ChangedFile` — pulls/{index}/files entries. */
export const changedFileSchema = z.object({
  additions: z.number().int().optional(),
  changes: z.number().int().optional(),
  contents_url: z.string().optional(),
  deletions: z.number().int().optional(),
  filename: z.string().optional(),
  html_url: z.string().optional(),
  previous_filename: z.string().nullable().optional(),
  raw_url: z.string().optional(),
  status: z.string().optional(),
});

export type ChangedFile = z.infer<typeof changedFileSchema>;

/** `#/responses/ChangedFileList` — plain `ChangedFile[]` (X-* header family). */
export const changedFileListSchema = z.array(changedFileSchema);

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

/** `#/definitions/CreateBranchRepoOption` — old_ref_name supersedes old_branch_name. */
export const createBranchOptionSchema = z.object({
  new_branch_name: z.string().openapi({ description: "name of the branch to create" }),
  old_branch_name: z.string().optional().openapi({ description: "deprecated (use old_ref_name)" }),
  old_ref_name: z.string().optional().openapi({ description: "name of the old branch/tag/commit to create from" }),
});

export type CreateBranchOption = z.infer<typeof createBranchOptionSchema>;

/** `#/definitions/UpdateBranchRepoOption` — the ref-CAS body. */
export const updateBranchOptionSchema = z.object({
  force: z.boolean().optional().openapi({ description: "force update (bypass the fast-forward check)" }),
  new_commit_id: z.string().openapi({ description: "the new commit id" }),
  old_commit_id: z.string().optional().openapi({ description: "the commit id the branch is expected on (CAS)" }),
});

export type UpdateBranchOption = z.infer<typeof updateBranchOptionSchema>;

/** `#/definitions/RenameBranchRepoOption`. */
export const renameBranchOptionSchema = z.object({
  name: z.string().openapi({ description: "new name of the branch" }),
});

export type RenameBranchOption = z.infer<typeof renameBranchOptionSchema>;

/** `#/definitions/CreateTagOption` — annotated tag when a message is given. */
export const createTagOptionSchema = z.object({
  message: z.string().optional().openapi({ description: "message of the tag object" }),
  tag_name: z.string().openapi({ description: "git tag name" }),
  target: z.string().optional().openapi({ description: "target ref/commit; defaults to the default branch" }),
});

export type CreateTagOption = z.infer<typeof createTagOptionSchema>;
