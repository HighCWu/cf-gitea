import { z } from "@hono/zod-openapi";

/**
 * Mirror of the vendored contract's `AddCollaboratorOption` definition
 * (gitea/templates/swagger/v1-swagger.generated.json
 * #/definitions/AddCollaboratorOption). `permission` is optional — upstream
 * `AddOrUpdateCollaborator` defaults a nil permission to write
 * (perm.ParseAccessMode with the read/write/admin allowlist).
 */
export const addCollaboratorOptionSchema = z.object({
  permission: z
    .enum(["read", "write", "admin"])
    .optional()
    .openapi({
      description:
        "Permission level to grant the collaborator" +
        ' — read RepoWritePermissionRead, write RepoWritePermissionWrite, admin RepoWritePermissionAdmin',
    }),
});

export type AddCollaboratorOption = z.infer<typeof addCollaboratorOptionSchema>;
