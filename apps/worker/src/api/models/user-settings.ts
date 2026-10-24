import { z } from "@hono/zod-openapi";

/**
 * Mirrors of the vendored contract's `UserSettings` and `UserSettingsOptions`
 * definitions (gitea/templates/swagger/v1-swagger.generated.json
 * #/definitions/UserSettings{,Options}) — field-for-field. The contract
 * declares no `required` fields on either; the schemas mirror that literally.
 * `UserSettings` is the GET/PATCH response; `UserSettingsOptions` is the PATCH
 * body (upstream `api.UserSettingsOptions` — every field is a Go POINTER, so
 * only the presented keys are applied; absent keys keep their stored value,
 * which the route encodes as plain `undefined`).
 */
export const userSettingsSchema = z.object({
  description: z.string().optional(),
  diff_view_style: z.string().optional(),
  full_name: z.string().optional(),
  hide_activity: z.boolean().optional(),
  hide_email: z.boolean().optional().openapi({ description: "Privacy" }),
  language: z.string().optional(),
  location: z.string().optional(),
  theme: z.string().optional(),
  website: z.string().optional(),
});

export type UserSettings = z.infer<typeof userSettingsSchema>;

export const userSettingsOptionsSchema = z.object({
  description: z.string().optional(),
  diff_view_style: z.string().optional(),
  full_name: z.string().optional(),
  hide_activity: z.boolean().optional(),
  hide_email: z.boolean().optional().openapi({ description: "Privacy" }),
  language: z.string().optional(),
  location: z.string().optional(),
  theme: z.string().optional(),
  website: z.string().optional(),
});

export type UserSettingsOptions = z.infer<typeof userSettingsOptionsSchema>;
