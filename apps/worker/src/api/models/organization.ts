import { z } from "@hono/zod-openapi";

/**
 * Mirror of the vendored contract's `Organization` definition
 * (gitea/templates/swagger/v1-swagger.generated.json
 * #/definitions/Organization), field-for-field including formats, enums, and
 * descriptions. The contract declares no `required` fields; the schema mirrors
 * that literally (referenced by `Team.organization`, which `RepoTransfer`
 * reaches through its `teams` list). Organization routes themselves are tier-2
 * (SPEC-0004 appendix A).
 */
export const organizationSchema = z.object({
  avatar_url: z
    .string()
    .optional()
    .openapi({ description: "The URL of the organization's avatar" }),
  description: z.string().optional().openapi({ description: "The description of the organization" }),
  email: z.string().optional().openapi({ description: "The email address of the organization" }),
  full_name: z.string().optional().openapi({ description: "The full display name of the organization" }),
  id: z
    .number()
    .int()
    .optional()
    .openapi({ format: "int64", description: "The unique identifier of the organization" }),
  location: z.string().optional().openapi({ description: "The location of the organization" }),
  name: z.string().optional().openapi({ description: "The name of the organization" }),
  repo_admin_change_team_access: z
    .boolean()
    .optional()
    .openapi({ description: "Whether repository administrators can change team access" }),
  username: z
    .string()
    .optional()
    .openapi({ description: "username of the organization\ndeprecated" }),
  visibility: z
    .enum(["public", "limited", "private"])
    .optional()
    .openapi({ description: "The visibility level of the organization (public, limited, private)" }),
  website: z.string().optional().openapi({ description: "The website URL of the organization" }),
});

export type Organization = z.infer<typeof organizationSchema>;

/** `#/responses/OrganizationList` — plain `Organization[]` (GET /user/orgs). */
export const organizationListSchema = z.array(organizationSchema);

export type OrganizationList = z.infer<typeof organizationListSchema>;

/**
 * Mirror of the vendored contract's `EditOrgOption` definition
 * (#/definitions/EditOrgOption), field-for-field: every field optional (Go
 * pointers — absent ⇔ "leave unchanged"; empty string ⇔ "clear").
 *
 * The Go struct's `binding` tags (full_name MaxSize(100), email/description/
 * website MaxSize(255), location MaxSize(50), website ValidUrl, visibility
 * In(public,limited,private)) are NOT mirrored as zod rejections: the
 * contract declares only {200, 404} for PATCH /orgs/{org}, so an oversized or
 * non-URL body would produce a runtime-only 4xx upstream sends as 422 (see
 * routes/orgs.ts). The visibility enum IS mirrored — it is part of the
 * contract schema, and an out-of-enum value dies in the request validator
 * (documented runtime-only 400 divergence, routes/orgs.ts header).
 */
export const editOrgOptionSchema = z.object({
  description: z.string().optional().openapi({ description: "The description of the organization" }),
  email: z
    .string()
    .optional()
    .openapi({ description: "The email address of the organization; use empty string to clear" }),
  full_name: z.string().optional().openapi({ description: "The full display name of the organization" }),
  location: z.string().optional().openapi({ description: "The location of the organization" }),
  repo_admin_change_team_access: z
    .boolean()
    .optional()
    .openapi({ description: "Whether repository administrators can change team access" }),
  visibility: z
    .enum(["public", "limited", "private"])
    .optional()
    .openapi({ description: "possible values are `public`, `limited` or `private`" }),
  website: z.string().optional().openapi({ description: "The website URL of the organization" }),
});

export type EditOrgOption = z.infer<typeof editOrgOptionSchema>;
