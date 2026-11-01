import { z } from "@hono/zod-openapi";

/**
 * `#/definitions/ApplyDiffPatchFileOptions` — the repoApplyDiffPatch body:
 * the shared write-option fields (the contract re-declares them per
 * definition, so the schemas do too — models/contents.ts convention) plus the
 * patch text itself. NOTE the contract quirk: `content` here is the RAW PATCH
 * TEXT (x-go-name Content), NOT base64 like the contents family.
 */

/** The `Identity` block (`#/definitions/Identity`). */
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

/** `#/definitions/ApplyDiffPatchFileOptions`. */
export const applyDiffPatchFileOptionsSchema = z.object({
  author: identityBlock,
  branch: z.string().optional().openapi({ description: "branch (optional) is the base branch for the changes. If not supplied, the default branch is used" }),
  committer: identityBlock,
  content: z.string().openapi({ description: "the unified-diff patch text to apply" }),
  dates: commitDateBlock,
  force_push: z.boolean().nullable().optional(),
  message: z.string().optional().openapi({ description: "commit message (defaults to apply-patch, like upstream)" }),
  new_branch: z.string().optional().openapi({ description: "commit onto a new branch created from `branch`" }),
  signoff: z.boolean().optional().openapi({
    description: "signoff (optional): append the `Signed-off-by: <committer>` trailer to the commit message (upstream CommitTree's SignOff block, services/repository/files/temp_repo.go:312-317 — the identity is the commit's committer)",
  }),
});

export type ApplyDiffPatchFileOptions = z.infer<typeof applyDiffPatchFileOptionsSchema>;
