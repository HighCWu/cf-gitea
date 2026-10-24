import { z } from "@hono/zod-openapi";

/**
 * Mirror of the vendored contract's `ServerVersion` definition
 * (gitea/templates/swagger/v1-swagger.generated.json #/definitions/ServerVersion).
 * The contract declares no `required` fields; the schema mirrors that
 * literally — the contract check diffs declarations against the vendored
 * file, not against runtime behavior.
 */
export const serverVersionSchema = z.object({
  version: z
    .string()
    .optional()
    .openapi({ description: "Version is the server version string" }),
});

export type ServerVersion = z.infer<typeof serverVersionSchema>;
