import { z } from "@hono/zod-openapi";

import { userSchema } from "./user";

/**
 * Mirror of the vendored contract's `PublicKey` definition
 * (gitea/templates/swagger/v1-swagger.generated.json
 * #/definitions/PublicKey, upstream modules/structs/user_key.go PublicKey),
 * field-for-field. `publicKeyListSchema` is `#/responses/PublicKeyList`
 * (the plain array).
 *
 * STUB SURFACE — cf-gitea has no SSH-key storage (no `public_key` table, no
 * key CRUD): the list routes render the contract's empty array with the
 * documented divergence (routes/identity.ts header). The schema exists so
 * the declaration mirrors the frozen contract shape and a real-keys wave
 * inherits the exact target.
 */

export const publicKeySchema = z.object({
  id: z.number().int().optional().openapi({ format: "int64", description: "ID is the unique identifier for the public key" }),
  key: z.string().optional().openapi({ description: "Key contains the actual SSH public key content" }),
  url: z.string().optional().openapi({ description: "URL is the API URL for this key" }),
  title: z.string().optional().openapi({ description: "Title is the human-readable name for the key" }),
  fingerprint: z.string().optional().openapi({ description: "Fingerprint is the key's fingerprint" }),
  created_at: z.string().optional().openapi({ format: "date-time", description: "Created is the time when the key was added" }),
  last_used_at: z.string().optional().openapi({ format: "date-time", description: "Updated is the time when the key was last used" }),
  user: userSchema.nullable().optional().openapi({ description: "Owner is the user who owns this key" }),
  read_only: z.boolean().optional().openapi({ description: "ReadOnly indicates if the key has read-only access" }),
  key_type: z.string().optional().openapi({ description: "KeyType indicates the type of the SSH key" }),
});

export type PublicKey = z.infer<typeof publicKeySchema>;

/** `#/responses/PublicKeyList` — plain `PublicKey[]` (the keys listing). */
export const publicKeyListSchema = z.array(publicKeySchema);

export type PublicKeyList = z.infer<typeof publicKeyListSchema>;
