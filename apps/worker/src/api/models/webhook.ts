import { z } from "@hono/zod-openapi";

/**
 * Mirrors of the vendored contract's webhook definitions
 * (gitea/templates/swagger/v1-swagger.generated.json
 * #/definitions/{Hook,CreateHookOption,EditHookOption,HookDelivery,
 * HookDeliveryRequest,HookDeliveryResponse}), field-for-field including
 * formats, enums, and descriptions. The contract declares no `required`
 * fields on the response models; those mirror that literally.
 * `CreateHookOption` mirrors its `required: [type, config]` and the `type`
 * enum of 10 providers (upstream `CreateHookOption`, modules/structs/hook.go —
 * note `matrix`/`wechatwork`-era drift: the vendored enum is exactly
 * dingtalk/discord/gitea/gogs/msteams/slack/telegram/feishu/wechatwork/packagist).
 */

/** `#/definitions/Hook.config` — a free string map (`url`, `content_type`, `secret`, ...). */
const hookConfigSchema = z.record(z.string(), z.string()).optional().openapi({
  description: "Configuration settings for the webhook",
});

/**
 * `#/definitions/Hook` — a webhook of a repository (upstream `api.Hook`,
 * modules/structs/hook.go). `authorization_header` is always rendered empty:
 * the stored value is a secret and must never be returned by the API
 * (`services/webhook/general.go ToHook`).
 */
export const hookSchema = z
  .object({
    active: z.boolean().optional().openapi({ description: "Whether the webhook is active and will be triggered" }),
    authorization_header: z
      .string()
      .optional()
      .openapi({ description: "Authorization header to include in webhook requests" }),
    branch_filter: z
      .string()
      .optional()
      .openapi({ description: "Branch filter pattern to determine which branches trigger the webhook" }),
    config: hookConfigSchema,
    created_at: z.string().optional().openapi({ format: "date-time", description: "The date and time when the webhook was created" }),
    events: z
      .array(z.string())
      .optional()
      .openapi({ description: "List of events that trigger this webhook" }),
    id: z.number().int().optional().openapi({ format: "int64", description: "The unique identifier of the webhook" }),
    name: z.string().optional().openapi({ description: "Optional human-readable name for the webhook" }),
    type: z
      .string()
      .optional()
      .openapi({ description: "The type of the webhook (e.g., gitea, slack, discord)" }),
    updated_at: z
      .string()
      .optional()
      .openapi({ format: "date-time", description: "The date and time when the webhook was last updated" }),
  })
  .openapi("Hook");

export type Hook = z.infer<typeof hookSchema>;

/** `#/responses/HookList` — plain `Hook[]`. */
export const hookListSchema = z.array(hookSchema);

export type HookList = z.infer<typeof hookListSchema>;

/**
 * `#/definitions/CreateHookOptionConfig` — a free string map; upstream
 * requires the `url` and `content_type` keys (validated in
 * `routers/api/v1/utils/hook.go checkCreateHookOption`, not by the schema).
 */
export const createHookOptionConfigSchema = z
  .record(z.string(), z.string())
  .openapi({
    description:
      'CreateHookOptionConfig has all config options in it\nrequired are "content_type" and "url" Required',
  });

/** The `type` enum of the vendored contract (10 providers). */
export const HOOK_TYPES = [
  "dingtalk",
  "discord",
  "gitea",
  "gogs",
  "msteams",
  "slack",
  "telegram",
  "feishu",
  "wechatwork",
  "packagist",
] as const;

/**
 * `#/definitions/CreateHookOption` — `active` defaults to **false**
 * (SPEC-0004 §2.4); `branch_filter` is a glob accepted and stored as-is
 * (upstream binding `GlobPattern`); events default to `["push"]` when empty
 * (`updateHookEvents`, routers/api/v1/utils/hook.go).
 */
export const createHookOptionSchema = z
  .object({
    type: z.enum(HOOK_TYPES).openapi({ description: "The type of the webhook to create" }),
    config: createHookOptionConfigSchema,
    events: z
      .array(z.string())
      .optional()
      .openapi({ description: "List of events that will trigger this webhook" }),
    branch_filter: z
      .string()
      .optional()
      .openapi({ description: "Branch filter pattern to determine which branches trigger the webhook" }),
    authorization_header: z
      .string()
      .optional()
      .openapi({ description: "Authorization header to include in webhook requests" }),
    active: z
      .boolean()
      .optional()
      .openapi({ description: "Whether the webhook should be active upon creation", default: false }),
    name: z.string().optional().openapi({ description: "Optional human-readable name for the webhook" }),
  })
  .openapi("CreateHookOption");

export type CreateHookOption = z.infer<typeof createHookOptionSchema>;

/**
 * `#/definitions/EditHookOption` — every field optional. Upstream quirk kept
 * (`editHook`, routers/api/v1/utils/hook.go): `events` and `branch_filter`
 * are applied UNCONDITIONALLY — a PATCH without them RESETS the subscription
 * to push-only and CLEARS the branch filter.
 */
export const editHookOptionSchema = z
  .object({
    active: z.boolean().optional().openapi({ description: "Whether the webhook is active and will be triggered" }),
    authorization_header: z
      .string()
      .optional()
      .openapi({ description: "Authorization header to include in webhook requests" }),
    branch_filter: z
      .string()
      .optional()
      .openapi({ description: "Branch filter pattern to determine which branches trigger the webhook" }),
    config: hookConfigSchema,
    events: z
      .array(z.string())
      .optional()
      .openapi({ description: "List of events that trigger this webhook" }),
    name: z.string().optional().openapi({ description: "Optional human-readable name" }),
  })
  .openapi("EditHookOption");

export type EditHookOption = z.infer<typeof editHookOptionSchema>;

/** `#/definitions/HookDeliveryRequest` (upstream `HookRequest` JSON). */
export const hookDeliveryRequestSchema = z.object({
  url: z.string().optional().openapi({ description: "The URL the delivery was sent to" }),
  http_method: z.string().optional().openapi({ description: "The HTTP method used for the delivery" }),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .openapi({ description: "The headers sent with the delivery" }),
  body: z.string().optional().openapi({ description: "The body sent with the delivery" }),
});

export type HookDeliveryRequest = z.infer<typeof hookDeliveryRequestSchema>;

/** `#/definitions/HookDeliveryResponse` (upstream `HookResponse` JSON). */
export const hookDeliveryResponseSchema = z.object({
  status: z.number().int().optional().openapi({ format: "int64", description: "The HTTP status code of the response" }),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .openapi({ description: "The headers received in the response" }),
  body: z.string().optional().openapi({ description: "The body received in the response" }),
});

export type HookDeliveryResponse = z.infer<typeof hookDeliveryResponseSchema>;

/** `#/definitions/HookDelivery` — one delivery attempt (upstream `api.HookDelivery`). */
export const hookDeliverySchema = z
  .object({
    uuid: z.string().optional().openapi({ description: "The unique identifier of the delivery" }),
    event_type: z.string().optional().openapi({ description: "The event type that triggered this delivery" }),
    is_delivered: z.boolean().optional().openapi({ description: "Whether the delivery has been sent" }),
    is_succeeded: z.boolean().optional().openapi({ description: "Whether the delivery was successful (2xx response)" }),
    // Nullable at runtime like upstream (`Delivered *time.Time` — the nil
    // pointer renders JSON null for an undelivered row, general.go ToHookDelivery).
    delivered_at: z
      .string()
      .nullable()
      .optional()
      .openapi({ format: "date-time", description: "The date and time when the delivery was sent" }),
    request: hookDeliveryRequestSchema.optional(),
    response: hookDeliveryResponseSchema.optional(),
  })
  .openapi("HookDelivery");

export type HookDelivery = z.infer<typeof hookDeliverySchema>;

/** `#/responses/HookDeliveryList` — plain `HookDelivery[]`. */
export const hookDeliveryListSchema = z.array(hookDeliverySchema);

export type HookDeliveryList = z.infer<typeof hookDeliveryListSchema>;
