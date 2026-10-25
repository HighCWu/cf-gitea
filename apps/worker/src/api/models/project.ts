import { z } from "@hono/zod-openapi";

import { embeddedUserSchema } from "./issue";

/**
 * Mirrors of the vendored contract's project definitions
 * (apps/worker/src/compat/contract/v1-swagger.generated.json
 * #/definitions/{Project,ProjectColumn,ProjectWorkflow,*Option}), field for
 * field against upstream modules/structs/{project,project_workflow}.go at the
 * pinned commit. Only the Create options declare `required` (title /
 * column title / event); the wire models and Edit options have none — the
 * schemas mirror that literally. Go pointer fields (`*string`, `*bool`) on
 * the Edit options accept null so Go-style payloads never 400; the routes
 * treat null exactly like an absent field (the labels-family tri-state).
 */

export const projectSchema = z.object({
  id: z.number().int().openapi({ format: "int64" }),
  title: z.string(),
  description: z.string(),
  owner_id: z.number().int().openapi({ format: "int64" }),
  repo_id: z.number().int().openapi({ format: "int64" }),
  creator: embeddedUserSchema.optional(),
  creator_id: z.number().int().openapi({ format: "int64", description: "Deprecated: use Creator instead" }),
  state: z.enum(["open", "closed"]),
  is_closed: z.boolean().openapi({ description: "Deprecated: use State instead" }),
  template_type: z.string().openapi({ description: 'Template type: "none", "basic_kanban" or "bug_triage"' }),
  card_type: z.string().openapi({ description: 'Card type: "text_only" or "images_and_text"' }),
  type: z.string().openapi({ description: 'Project type: "individual", "repository" or "organization"' }),
  num_open_issues: z.number().int().openapi({ format: "int64" }),
  num_closed_issues: z.number().int().openapi({ format: "int64" }),
  num_issues: z.number().int().openapi({ format: "int64" }),
  created_at: z.string().openapi({ format: "date-time" }),
  updated_at: z.string().openapi({ format: "date-time" }).nullable().optional(),
  closed_at: z.string().openapi({ format: "date-time" }).nullable().optional(),
  html_url: z.string().optional(),
});

export type Project = z.infer<typeof projectSchema>;

/** `#/responses/ProjectList` — plain `Project[]`. */
export const projectListSchema = z.array(projectSchema);

export const projectColumnSchema = z.object({
  id: z.number().int().openapi({ format: "int64" }),
  title: z.string(),
  default: z.boolean(),
  sorting: z.number().int().openapi({ format: "int64" }),
  color: z.string().optional(),
  project_id: z.number().int().openapi({ format: "int64" }),
  creator: embeddedUserSchema.optional(),
  created_at: z.string().openapi({ format: "date-time" }),
  updated_at: z.string().openapi({ format: "date-time" }).nullable().optional(),
});

export type ProjectColumn = z.infer<typeof projectColumnSchema>;

/** `#/responses/ProjectColumnList` — plain `ProjectColumn[]`. */
export const projectColumnListSchema = z.array(projectColumnSchema);

export const projectWorkflowFiltersSchema = z.object({
  issue_type: z.string().optional().openapi({ description: '"issue" or "pull_request", empty matches both' }),
  source_column_id: z
    .number()
    .int()
    .optional()
    .openapi({ format: "int64", description: "only for item_column_changed" }),
  target_column_id: z
    .number()
    .int()
    .optional()
    .openapi({ format: "int64", description: "only for item_column_changed" }),
  label_ids: z
    .array(z.number().int().openapi({ format: "int64" }))
    .optional()
    .openapi({ description: "the item must have all of these labels" }),
});

export type ProjectWorkflowFilters = z.infer<typeof projectWorkflowFiltersSchema>;

export const projectWorkflowActionsSchema = z.object({
  column_id: z.number().int().optional().openapi({ format: "int64" }),
  add_label_ids: z.array(z.number().int().openapi({ format: "int64" })).optional(),
  remove_label_ids: z.array(z.number().int().openapi({ format: "int64" })).optional(),
  issue_state: z.string().optional().openapi({ description: '"close" or "reopen"' }),
});

export type ProjectWorkflowActions = z.infer<typeof projectWorkflowActionsSchema>;

export const projectWorkflowSchema = z.object({
  id: z.number().int().openapi({ format: "int64" }),
  event: z.string().openapi({
    description:
      "one of item_added_to_project, item_removed_from_project, item_reopened, item_closed, item_column_changed,\ncode_changes_requested, code_review_approved, pull_request_merged",
  }),
  enabled: z.boolean(),
  filters: projectWorkflowFiltersSchema,
  actions: projectWorkflowActionsSchema,
  created_at: z.string().openapi({ format: "date-time" }),
  updated_at: z.string().openapi({ format: "date-time" }),
});

export type ProjectWorkflow = z.infer<typeof projectWorkflowSchema>;

/** `#/responses/ProjectWorkflowList` — plain `ProjectWorkflow[]`. */
export const projectWorkflowListSchema = z.array(projectWorkflowSchema);

export const createProjectOptionSchema = z.object({
  title: z.string().openapi({ description: "Name is the display title for the new project" }),
  description: z.string().optional(),
  template_type: z
    .string()
    .optional()
    .openapi({ description: 'Template type: "none", "basic_kanban" or "bug_triage"' }),
  card_type: z.string().optional().openapi({ description: 'Card type: "text_only" or "images_and_text"' }),
});

export type CreateProjectOption = z.infer<typeof createProjectOptionSchema>;

export const editProjectOptionSchema = z.object({
  title: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  card_type: z.string().nullable().optional().openapi({ description: 'Card type: "text_only" or "images_and_text"' }),
  state: z.enum(["open", "closed"]).nullable().optional(),
});

export type EditProjectOption = z.infer<typeof editProjectOptionSchema>;

export const createProjectColumnOptionSchema = z.object({
  title: z.string(),
  color: z.string().optional().openapi({ description: "Column color in 6-digit hex format, e.g. #FF0000" }),
});

export type CreateProjectColumnOption = z.infer<typeof createProjectColumnOptionSchema>;

export const editProjectColumnOptionSchema = z.object({
  title: z.string().nullable().optional(),
  color: z
    .string()
    .nullable()
    .optional()
    .openapi({ description: "Column color in 6-digit hex format, e.g. #FF0000" }),
  sorting: z
    .number()
    .int()
    .nullable()
    .optional()
    .openapi({ format: "int64", description: "Position of the column within the project, between -128 and 127" }),
});

export type EditProjectColumnOption = z.infer<typeof editProjectColumnOptionSchema>;

export const moveProjectColumnsOptionSchema = z.object({
  column_ids: z
    .array(z.number().int().openapi({ format: "int64" }))
    .openapi({ description: "Every column ID of the project, in the desired left-to-right order" }),
});

export type MoveProjectColumnsOption = z.infer<typeof moveProjectColumnsOptionSchema>;

export const moveProjectIssueOptionSchema = z.object({
  column_id: z.number().int().openapi({ format: "int64", description: "Target column to move the issue into" }),
  sorting: z
    .number()
    .int()
    .nullable()
    .optional()
    .openapi({
      format: "int64",
      description:
        "Position within the column, ascending. Omit to append. Negative values sort above\nthe rest, equal values are ordered newest first.",
    }),
});

export type MoveProjectIssueOption = z.infer<typeof moveProjectIssueOptionSchema>;

export const createProjectWorkflowOptionSchema = z.object({
  event: z.string(),
  enabled: z.boolean().optional().openapi({ description: "defaults to true" }),
  filters: projectWorkflowFiltersSchema.optional(),
  actions: projectWorkflowActionsSchema.optional(),
});

export type CreateProjectWorkflowOption = z.infer<typeof createProjectWorkflowOptionSchema>;

export const editProjectWorkflowOptionSchema = z.object({
  enabled: z.boolean().nullable().optional(),
  filters: projectWorkflowFiltersSchema.nullable().optional(),
  actions: projectWorkflowActionsSchema.nullable().optional(),
});

export type EditProjectWorkflowOption = z.infer<typeof editProjectWorkflowOptionSchema>;
