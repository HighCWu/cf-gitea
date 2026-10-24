import { z } from "@hono/zod-openapi";

/**
 * Mirrors of the vendored contract's milestone definitions
 * (gitea/templates/swagger/v1-swagger.generated.json
 * #/definitions/{Milestone,CreateMilestoneOption,EditMilestoneOption}),
 * field-for-field. The contract declares no `required` fields; the schemas
 * mirror that literally. Nullable date fields (`updated_at`, `closed_at`,
 * `due_on`) are Go `*time.Time` — serialized as JSON null when unset.
 */
export const milestoneSchema = z.object({
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

export type Milestone = z.infer<typeof milestoneSchema>;

/** `#/responses/MilestoneList` — plain `Milestone[]`. */
export const milestoneListSchema = z.array(milestoneSchema);

export const createMilestoneOptionSchema = z.object({
  description: z.string().optional().openapi({ description: "Description provides details about the milestone" }),
  due_on: z
    .string()
    .nullable()
    .optional()
    .openapi({ format: "date-time", description: "Deadline is the due date for the milestone" }),
  state: z
    .enum(["open", "closed"])
    .optional()
    .openapi({ description: "State indicates the initial state of the milestone" }),
  title: z.string().optional().openapi({ description: "Title is the title of the new milestone" }),
});

export type CreateMilestoneOption = z.infer<typeof createMilestoneOptionSchema>;

/**
 * `due_on` is Go `optional.Option[*string]` (json `due_on,omitzero`): absent
 * = keep, `null`/`""` = remove the deadline, a value = parse it. `state` is a
 * plain `*string` — absent/null = unchanged. Everything else mirrors EditLabelOption's pointer rule (null = unchanged).
 */
export const editMilestoneOptionSchema = z.object({
  description: z
    .string()
    .nullable()
    .optional()
    .openapi({ description: "Description provides updated details about the milestone" }),
  due_on: z
    .string()
    .nullable()
    .optional()
    .openapi({
      format: "date-time",
      description: "Deadline is the due date for the milestone, use null or empty string to remove the deadline",
    }),
  state: z.enum(["open", "closed"]).nullable().optional().openapi({ description: "State indicates the updated state of the milestone" }),
  title: z.string().nullable().optional().openapi({ description: "Title is the updated title of the milestone" }),
});

export type EditMilestoneOption = z.infer<typeof editMilestoneOptionSchema>;
