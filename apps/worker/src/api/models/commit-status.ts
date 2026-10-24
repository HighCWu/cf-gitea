import { z } from "@hono/zod-openapi";

import { repositorySchema } from "./repository";
import { userSchema } from "./user";

/**
 * Mirrors of the vendored contract's status definitions
 * (gitea/templates/swagger/v1-swagger.generated.json
 * #/definitions/{CommitStatus,CombinedStatus,CreateStatusOption}),
 * field-for-field including the `status` JSON key (the Go field is named
 * State; the json tag wins). The contract declares no `required` fields; the
 * schemas mirror that literally. The `repository` field reuses the registered
 * `Repository` schema (emitted as a `$ref`, like SearchResults does).
 */
export const COMMIT_STATUS_STATES = ["pending", "success", "error", "failure", "warning", "skipped"] as const;

export type CommitStatusState = (typeof COMMIT_STATUS_STATES)[number];

export const commitStatusSchema = z.object({
  context: z
    .string()
    .optional()
    .openapi({ description: "Context is the unique context identifier for the status" }),
  created_at: z.string().optional().openapi({ format: "date-time" }),
  creator: userSchema
    .nullable()
    .optional()
    .openapi({ description: "Creator is the user who created the status" }),
  description: z.string().optional().openapi({ description: "Description provides a brief description of the status" }),
  id: z
    .number()
    .int()
    .optional()
    .openapi({ format: "int64", description: "ID is the unique identifier for the commit status" }),
  status: z
    .enum(COMMIT_STATUS_STATES)
    .optional()
    .openapi({ description: "State represents the status state (pending, success, error, failure)" }),
  target_url: z.string().optional().openapi({ description: "TargetURL is the URL to link to for more details" }),
  updated_at: z.string().optional().openapi({ format: "date-time" }),
  url: z.string().optional().openapi({ description: "URL is the API URL for this status" }),
});

export type CommitStatus = z.infer<typeof commitStatusSchema>;

/** `#/responses/CommitStatusList` — plain `CommitStatus[]`. */
export const commitStatusListSchema = z.array(commitStatusSchema);

export const combinedStatusSchema = z.object({
  commit_url: z.string().optional().openapi({ description: "CommitURL is the API URL for the commit" }),
  repository: repositorySchema.optional().openapi({ description: "Repository is the repository this status belongs to" }),
  sha: z.string().optional().openapi({ description: "SHA is the commit SHA this status applies to" }),
  state: z
    .enum(COMMIT_STATUS_STATES)
    .optional()
    .openapi({ description: "State is the overall combined status state" }),
  statuses: z
    .array(commitStatusSchema)
    .optional()
    .openapi({ description: "Statuses contains all individual commit statuses" }),
  total_count: z
    .number()
    .int()
    .optional()
    .openapi({ format: "int64", description: "TotalCount is the total number of statuses" }),
  url: z.string().optional().openapi({ description: "URL is the API URL for this combined status" }),
});

export type CombinedStatus = z.infer<typeof combinedStatusSchema>;

export const createStatusOptionSchema = z.object({
  context: z
    .string()
    .optional()
    .openapi({ description: "Context is the unique context identifier for the status" }),
  description: z.string().optional().openapi({ description: "Description provides a brief description of the status" }),
  state: z
    .enum(COMMIT_STATUS_STATES)
    .optional()
    .openapi({ description: "State represents the status state to set (pending, success, error, failure)" }),
  target_url: z.string().optional().openapi({ description: "TargetURL is the URL to link to for more details" }),
});

export type CreateStatusOption = z.infer<typeof createStatusOptionSchema>;
