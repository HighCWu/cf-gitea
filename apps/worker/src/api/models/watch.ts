import { z } from "@hono/zod-openapi";

/**
 * Mirror of the vendored contract's `WatchInfo` definition
 * (gitea/templates/swagger/v1-swagger.generated.json #/definitions/WatchInfo),
 * field-for-field. `reason` is untyped in the contract (Go `any`; upstream
 * sends nil) — modeled as `unknown` nullable so the null render is legal.
 */
export const watchInfoSchema = z.object({
  created_at: z
    .string()
    .optional()
    .openapi({ format: "date-time", description: "The timestamp when the watch status was created" }),
  ignored: z
    .boolean()
    .optional()
    .openapi({ description: "Whether notifications for the repository are ignored" }),
  reason: z.unknown().nullable().optional().openapi({ description: "The reason for the current watch status" }),
  repository_url: z.string().optional().openapi({ description: "The URL of the repository being watched" }),
  subscribed: z.boolean().optional().openapi({ description: "Whether the repository is being watched for notifications" }),
  url: z.string().optional().openapi({ description: "The URL for managing the watch status" }),
});

export type WatchInfo = z.infer<typeof watchInfoSchema>;
