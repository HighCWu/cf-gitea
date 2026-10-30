import { z } from "@hono/zod-openapi";

/**
 * Mirror of the vendored contract's `AddCollaboratorOption` definition
 * (gitea/templates/swagger/v1-swagger.generated.json
 * #/definitions/AddCollaboratorOption). `permission` is optional — upstream
 * `AddOrUpdateCollaborator` defaults a nil permission to write
 * (perm.ParseAccessMode with the read/write/admin allowlist).
 *
 * The declared enum documents the contract only; the RUNTIME does not enforce
 * it, and neither do we: upstream's Go bind decodes any string into
 * `*RepoWritePermission` (modules/structs/repo_collaborator.go:32-35 — plain
 * JSON decode, no binding-tag validation), then `ParseAccessMode` maps
 * unknown values ("owner", the empty string, typos) to `AccessModeNone`
 * (models/perm/access_mode.go:46-61) and the service's range check turns that
 * into `ErrInvalidAccessMode` → the blanked APIErrorInternal 500
 * (services/repository/collaboration.go:27-30 via collaborators.go:188-196).
 * The parse lives in services/repo-collaborators.ts
 * (`parseCollaboratorMode`); a strict z.enum here would 422 where upstream
 * 500s.
 */
export const addCollaboratorOptionSchema = z.object({
  permission: z
    .string()
    .optional()
    .openapi({
      enum: ["read", "write", "admin"],
      description:
        "Permission level to grant the collaborator" +
        ' — read RepoWritePermissionRead, write RepoWritePermissionWrite, admin RepoWritePermissionAdmin' +
        " (declared contract enum; unknown runtime values parse to the service's ErrInvalidAccessMode 500)",
    }),
});

export type AddCollaboratorOption = z.infer<typeof addCollaboratorOptionSchema>;
