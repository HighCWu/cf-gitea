import { z } from "@hono/zod-openapi";

import { payloadCommitVerificationSchema } from "./git";

/**
 * Mirrors of the vendored contract's contents family
 * (gitea/templates/swagger/v1-swagger.generated.json
 * #/definitions/{FileLinksResponse, ContentsResponse, FileCommitResponse,
 * FileResponse, FileDeleteResponse, FilesResponse, ChangeFileOperation,
 * ChangeFilesOptions, CreateFileOptions, UpdateFileOptions, DeleteFileOptions,
 * IssueTemplate, IssueTemplateStringSlice, IssueFormField}) plus the write
 * bodies. The contract declares no `required` fields on the response models;
 * the schemas mirror that literally. The union shape (GET contents → object
 * for a file, array for a directory) is carried by the ROUTES declaring both
 * response schemas — not normalized here (SPEC-0004 §4).
 *
 * The four write bodies each re-declare the shared option fields (branch,
 * new_branch, message, author, committer, dates, signoff, force_push) — the
 * contract itself repeats them per definition, so the schemas do too.
 */

/** `#/definitions/FileLinksResponse` — the `_links` block. */
export const fileLinksResponseSchema = z.object({
  git: z.string().optional(),
  html: z.string().optional(),
  self: z.string().optional(),
});

/**
 * `#/definitions/ContentsResponse` — file/dir/symlink/submodule view.
 * `content` is base64 with `encoding: "base64"` (files under the render cap
 * only); `target` carries the symlink destination; `submodule_git_url` the
 * gitlink URL; the `last_commit_*` enrichment names the last commit that
 * touched the path.
 */
export const contentsResponseSchema = z.object({
  _links: fileLinksResponseSchema.optional(),
  content: z.string().nullable().optional(),
  download_url: z.string().nullable().optional(),
  encoding: z.string().nullable().optional(),
  git_url: z.string().optional(),
  html_url: z.string().optional(),
  last_author_date: z.string().optional().openapi({ format: "date-time" }),
  last_commit_message: z.string().optional(),
  last_commit_sha: z.string().optional(),
  last_committer_date: z.string().optional().openapi({ format: "date-time" }),
  lfs_oid: z.string().optional(),
  lfs_size: z.number().int().optional().openapi({ format: "int64" }),
  mode: z.string().optional(),
  name: z.string().optional(),
  path: z.string().optional(),
  sha: z.string().optional(),
  size: z.number().int().optional().openapi({ format: "int64" }),
  submodule_git_url: z.string().optional(),
  target: z.string().nullable().optional(),
  type: z.string().optional(),
  url: z.string().optional(),
});

export type ContentsResponse = z.infer<typeof contentsResponseSchema>;

/** `#/responses/ContentsListResponse` — plain `ContentsResponse[]` (directories). */
export const contentsListSchema = z.array(contentsResponseSchema);

/** `#/definitions/CommitUser` block as re-declared inside FileCommitResponse. */
const commitUserBlock = z
  .object({
    date: z.string().optional(),
    email: z.string().optional(),
    name: z.string().optional(),
  })
  .optional();

/** `#/definitions/CommitMeta` block as re-declared inside FileCommitResponse. */
const commitMetaBlock = z
  .object({
    created: z.string().optional().openapi({ format: "date-time" }),
    sha: z.string().optional(),
    url: z.string().optional(),
  })
  .optional();

/** `#/definitions/FileCommitResponse` — the commit a file change produced. */
export const fileCommitResponseSchema = z.object({
  author: commitUserBlock,
  committer: commitUserBlock,
  created: z.string().optional().openapi({ format: "date-time" }),
  html_url: z.string().optional(),
  message: z.string().optional(),
  parents: z.array(commitMetaBlock).optional(),
  sha: z.string().optional(),
  tree: commitMetaBlock,
  url: z.string().optional(),
});

export type FileCommitResponse = z.infer<typeof fileCommitResponseSchema>;

/** `#/definitions/FileResponse` — single-file create/update result. */
export const fileResponseSchema = z.object({
  commit: fileCommitResponseSchema.optional(),
  content: contentsResponseSchema.nullable().optional(),
  verification: payloadCommitVerificationSchema.nullable().optional(),
});

export type FileResponse = z.infer<typeof fileResponseSchema>;

/**
 * `#/definitions/FileDeleteResponse` — delete result; the contract leaves
 * `content` untyped (upstream marshals nil → null).
 */
export const fileDeleteResponseSchema = z.object({
  commit: fileCommitResponseSchema.optional(),
  content: z.null().optional(),
  verification: payloadCommitVerificationSchema.nullable().optional(),
});

export type FileDeleteResponse = z.infer<typeof fileDeleteResponseSchema>;

/** `#/definitions/FilesResponse` — the batch change result (POST /contents). */
export const filesResponseSchema = z.object({
  commit: fileCommitResponseSchema.optional(),
  files: z.array(contentsResponseSchema).optional(),
  verification: payloadCommitVerificationSchema.nullable().optional(),
});

export type FilesResponse = z.infer<typeof filesResponseSchema>;

// ---------------------------------------------------------------------------
// Write bodies
// ---------------------------------------------------------------------------

/** The `Identity` block re-declared in every write body (`#/definitions/Identity`). */
const identityBlock = z
  .object({
    email: z.string().optional().openapi({ format: "email" }),
    name: z.string().optional(),
  })
  .optional();

/** `#/definitions/CommitDateOptions` block. */
const commitDateBlock = z
  .object({
    author: z.string().optional().openapi({ format: "date-time" }),
    committer: z.string().optional().openapi({ format: "date-time" }),
  })
  .optional();

/** `#/definitions/CreateFileOptions` — `content` (base64) required. */
export const createFileOptionsSchema = z.object({
  author: identityBlock,
  branch: z.string().optional().openapi({ description: "branch (defaults to the repository default branch)" }),
  committer: identityBlock,
  content: z.string().openapi({ description: "base64 content of the file" }),
  dates: commitDateBlock,
  force_push: z.boolean().nullable().optional(),
  message: z.string().optional().openapi({ description: "commit message (a default is synthesized when empty)" }),
  new_branch: z.string().optional().openapi({ description: "commit onto a new branch created from `branch`" }),
  signoff: z.boolean().optional(),
});

export type CreateFileOptions = z.infer<typeof createFileOptionsSchema>;

/** `#/definitions/UpdateFileOptions` — `content` required, `sha` CAS, `from_path` rename. */
export const updateFileOptionsSchema = z.object({
  author: identityBlock,
  branch: z.string().optional().openapi({ description: "branch (defaults to the repository default branch)" }),
  committer: identityBlock,
  content: z.string().openapi({ description: "base64 content of the file" }),
  dates: commitDateBlock,
  force_push: z.boolean().nullable().optional(),
  from_path: z.string().optional().openapi({ description: "original path when renaming" }),
  message: z.string().optional().openapi({ description: "commit message (a default is synthesized when empty)" }),
  new_branch: z.string().optional().openapi({ description: "commit onto a new branch created from `branch`" }),
  sha: z.string().optional().openapi({ description: "sha of the replaced file; absent = create" }),
  signoff: z.boolean().optional(),
});

export type UpdateFileOptions = z.infer<typeof updateFileOptionsSchema>;

/** `#/definitions/DeleteFileOptions` — `sha` required. */
export const deleteFileOptionsSchema = z.object({
  author: identityBlock,
  branch: z.string().optional().openapi({ description: "branch (defaults to the repository default branch)" }),
  committer: identityBlock,
  dates: commitDateBlock,
  force_push: z.boolean().nullable().optional(),
  message: z.string().optional().openapi({ description: "commit message (a default is synthesized when empty)" }),
  new_branch: z.string().optional().openapi({ description: "commit onto a new branch created from `branch`" }),
  sha: z.string().openapi({ description: "sha of the file to delete (CAS)" }),
  signoff: z.boolean().optional(),
});

export type DeleteFileOptions = z.infer<typeof deleteFileOptionsSchema>;

/** `#/definitions/ChangeFileOperation` — one batch entry. */
export const changeFileOperationSchema = z.object({
  content: z.string().optional().openapi({ description: "base64 content (create/update)" }),
  from_path: z.string().optional().openapi({ description: "original path (rename)" }),
  operation: z.enum(["create", "update", "delete"]).openapi({ description: "the operation to perform" }),
  path: z.string().openapi({ description: "path of the file" }),
  sha: z.string().optional().openapi({ description: "sha of the replaced/deleted file (CAS)" }),
});

export type ChangeFileOperation = z.infer<typeof changeFileOperationSchema>;

/** `#/definitions/ChangeFilesOptions` — the batch body. */
export const changeFilesOptionsSchema = z.object({
  author: identityBlock,
  branch: z.string().optional().openapi({ description: "branch (defaults to the repository default branch)" }),
  committer: identityBlock,
  dates: commitDateBlock,
  files: z.array(changeFileOperationSchema).min(1).openapi({ description: "the file operations, committed as one change" }),
  force_push: z.boolean().nullable().optional(),
  message: z.string().optional().openapi({ description: "commit message (a default is synthesized when empty)" }),
  new_branch: z.string().optional().openapi({ description: "commit onto a new branch created from `branch`" }),
  signoff: z.boolean().optional(),
});

export type ChangeFilesOptions = z.infer<typeof changeFilesOptionsSchema>;

// ---------------------------------------------------------------------------
// Issue templates
// ---------------------------------------------------------------------------

/**
 * `#/definitions/IssueTemplateStringSlice` — string OR string[] upstream
 * (swagger types it `[]string` with a custom unmarshaller); rendered as an
 * array here.
 */
export const issueTemplateStringSliceSchema = z.array(z.string()).optional();

/**
 * `#/definitions/IssueFormField` — form-type template bodies; opaque for this
 * surface (the array entries are echoed as parsed-JSON blobs).
 */
export const issueFormFieldSchema = z.unknown().optional();

/** `#/definitions/IssueTemplate` — issue_templates list entries. */
export const issueTemplateSchema = z.object({
  about: z.string().nullable().optional(),
  assignees: issueTemplateStringSliceSchema,
  body: z.array(issueFormFieldSchema).optional(),
  content: z.string().nullable().optional(),
  file_name: z.string().optional(),
  labels: issueTemplateStringSliceSchema,
  name: z.string().nullable().optional(),
  ref: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
});

export type IssueTemplate = z.infer<typeof issueTemplateSchema>;
