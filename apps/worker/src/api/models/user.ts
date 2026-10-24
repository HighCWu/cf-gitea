import { z } from "@hono/zod-openapi";

/**
 * Mirror of the vendored contract's `User` definition
 * (gitea/templates/swagger/v1-swagger.generated.json #/definitions/User),
 * field-for-field including formats, enums, and descriptions. The contract
 * declares no `required` fields; the schema mirrors that literally (the
 * contract check diffs declarations against the vendored file, not runtime).
 */
export const userSchema = z.object({
  active: z.boolean().optional().openapi({ description: "Is user active" }),
  avatar_url: z.string().optional().openapi({ description: "URL to the user's avatar" }),
  created: z.string().optional().openapi({ format: "date-time" }),
  description: z.string().optional().openapi({ description: "the user's description" }),
  email: z.string().optional().openapi({ format: "email" }),
  followers_count: z
    .number()
    .int()
    .optional()
    .openapi({ format: "int64", description: "user counts" }),
  following_count: z.number().int().optional().openapi({ format: "int64" }),
  full_name: z.string().optional().openapi({ description: "the user's full name" }),
  html_url: z.string().optional().openapi({ description: "URL to the user's gitea page" }),
  id: z.number().int().optional().openapi({ format: "int64", description: "the user's id" }),
  is_admin: z.boolean().optional().openapi({ description: "Is the user an administrator" }),
  language: z.string().optional().openapi({ description: "User locale" }),
  last_login: z.string().optional().openapi({ format: "date-time" }),
  location: z.string().optional(),
  login: z.string().optional().openapi({ description: "login of the user, same as `username`" }),
  login_name: z
    .string()
    .optional()
    .openapi({
      description: "identifier of the user, provided by the external authenticator (if configured)",
    }),
  prohibit_login: z.boolean().optional().openapi({ description: "Is user login prohibited" }),
  restricted: z.boolean().optional().openapi({ description: "Is user restricted" }),
  source_id: z
    .number()
    .int()
    .optional()
    .openapi({ format: "int64", description: "The ID of the user's Authentication Source" }),
  starred_repos_count: z.number().int().optional().openapi({ format: "int64" }),
  type: z
    .enum(["User", "Organization", "Bot"])
    .optional()
    .openapi({ description: "the user type" }),
  visibility: z
    .enum(["public", "limited", "private"])
    .optional()
    .openapi({ description: "User visibility level option: public, limited, private" }),
  website: z.string().optional(),
});

export type User = z.infer<typeof userSchema>;
