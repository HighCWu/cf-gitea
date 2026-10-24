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
