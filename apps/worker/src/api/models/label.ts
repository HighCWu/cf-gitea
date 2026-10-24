import { z } from "@hono/zod-openapi";

/**
 * Mirrors of the vendored contract's label definitions
 * (gitea/templates/swagger/v1-swagger.generated.json
 * #/definitions/{Label,CreateLabelOption,EditLabelOption}), field-for-field.
 * Only `CreateLabelOption` declares `required: [name, color]`; the wire
 * `Label` and `EditLabelOption` have none (schemas mirror that literally).
 * Note the wire `color` is bare hex upstream (`strings.TrimLeft(color, "#")`,
 * gitea/services/convert/issue.go:264) while the create/edit options document
 * the `#00aabb` form — normalization is the route's job.
 */
export const labelSchema = z.object({
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

export type Label = z.infer<typeof labelSchema>;

/** `#/responses/LabelList` — plain `Label[]`. */
export const labelListSchema = z.array(labelSchema);

export const createLabelOptionSchema = z.object({
  color: z.string().openapi({ description: "Color is the display color, example: #00aabb" }),
  description: z
    .string()
    .optional()
    .openapi({ description: "Description provides additional context about the label's purpose" }),
  exclusive: z.boolean().optional(),
  is_archived: z.boolean().optional(),
  name: z.string().openapi({ description: "Name is the display name for the new label" }),
});

export type CreateLabelOption = z.infer<typeof createLabelOptionSchema>;

/**
 * All fields are Go pointers upstream (`*string` / `*bool`): absent AND
 * JSON-null both mean "leave unchanged" — the handlers update only non-nil
 * fields. The schema accepts null so Go-style payloads never 400; the route
 * treats it exactly like an absent field.
 */
export const editLabelOptionSchema = z.object({
  color: z.string().nullable().optional().openapi({ description: "Color is the display color, example: #00aabb" }),
  description: z
    .string()
    .nullable()
    .optional()
    .openapi({ description: "Description provides additional context about the label's purpose" }),
  exclusive: z.boolean().nullable().optional(),
  is_archived: z.boolean().nullable().optional(),
  name: z.string().nullable().optional().openapi({ description: "Name is the new display name for the label" }),
});

export type EditLabelOption = z.infer<typeof editLabelOptionSchema>;
