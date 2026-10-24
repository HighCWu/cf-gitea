import { z } from "@hono/zod-openapi";

import { organizationSchema } from "./organization";

/**
 * Mirror of the vendored contract's `Team` definition
 * (gitea/templates/swagger/v1-swagger.generated.json #/definitions/Team),
 * field-for-field including formats, enums, and descriptions. The contract
 * declares no `required` fields; the schema mirrors that literally. Referenced
 * by `Repository.repo_transfer.teams` (pending transfers do not exist in the
 * D1 registry yet — SPEC-0005 — the model is declared so the Repository
 * mirror is complete).
 */
export const teamSchema = z.object({
  can_create_org_repo: z
    .boolean()
    .optional()
    .openapi({ description: "Whether the team can create repositories in the organization" }),
  description: z.string().optional().openapi({ description: "The description of the team" }),
  id: z
    .number()
    .int()
    .optional()
    .openapi({ format: "int64", description: "The unique identifier of the team" }),
  includes_all_repositories: z
    .boolean()
    .optional()
    .openapi({ description: "Whether the team has access to all repositories in the organization" }),
  name: z.string().optional().openapi({ description: "The name of the team" }),
  organization: organizationSchema.optional(),
  permission: z
    .enum(["none", "read", "write", "admin", "owner"])
    .optional(),
  units: z
    .array(z.string())
    .optional()
    .openapi({
      description:
        "Deprecated: This variable should be replaced by UnitsMap and will be dropped in later versions.",
    }),
  units_map: z.record(z.string(), z.string()).optional(),
  visibility: z
    .enum(["public", "limited", "private"])
    .optional()
    .openapi({
      description:
        'Team visibility within the organization. "private" teams are only\nlistable by members and org owners; "limited" teams are listable by\nany organization member; "public" teams are listable by any signed-in\nuser.',
    }),
});

export type Team = z.infer<typeof teamSchema>;
