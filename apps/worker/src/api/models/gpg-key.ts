import { z } from "@hono/zod-openapi";

/**
 * Mirrors of the vendored contract's GPG-key definitions
 * (gitea/templates/swagger/v1-swagger.generated.json
 * #/definitions/{GPGKey,GPGKeyEmail}, upstream
 * modules/structs/user_gpgkey.go), field-for-field. `gpgKeyListSchema` is
 * `#/responses/GPGKeyList` (the plain array).
 *
 * STUB SURFACE — cf-gitea has no GPG machinery (no key storage, no signing
 * verification): the list routes render the contract's empty array with the
 * documented divergence (routes/identity.ts header). One documented
 * reduction: the recursive `subkeys` arm is typed `unknown[]` (a z.lazy
 * self-reference overflows zod-to-openapi's metadata walk when the document
 * is generated); the shape is unobservable while the array is always empty,
 * and a real GPG wave replaces the stub wholesale.
 */

/** `GPGKeyEmail` — an email attached to a GPGKey. */
export const gpgKeyEmailSchema = z.object({
  email: z.string().optional().openapi({ description: "The email address associated with the GPG key" }),
  verified: z.boolean().optional().openapi({ description: "Whether the email address has been verified" }),
});

export type GpgKeyEmail = z.infer<typeof gpgKeyEmailSchema>;

export const gpgKeySchema = z.object({
  id: z.number().int().optional().openapi({ format: "int64", description: "The unique identifier of the GPG key" }),
  primary_key_id: z.string().optional().openapi({ description: "The primary key ID of the GPG key" }),
  key_id: z.string().optional().openapi({ description: "The key ID of the GPG key" }),
  public_key: z.string().optional().openapi({ description: "The public key content in armored format" }),
  emails: z.array(gpgKeyEmailSchema).optional().openapi({
    description: "List of email addresses associated with this GPG key",
  }),
  /** Recursive upstream (`GPGKey[]`); typed unknown[] while the stub is
   * always empty (see header — the z.lazy reduction). */
  subkeys: z.array(z.unknown()).optional().openapi({ description: "List of subkeys of this GPG key" }),
  can_sign: z.boolean().optional().openapi({ description: "Whether the key can be used for signing" }),
  can_encrypt_comms: z
    .boolean()
    .optional()
    .openapi({ description: "Whether the key can be used for encrypting communications" }),
  can_encrypt_storage: z
    .boolean()
    .optional()
    .openapi({ description: "Whether the key can be used for encrypting storage" }),
  can_certify: z.boolean().optional().openapi({ description: "Whether the key can be used for certification" }),
  verified: z.boolean().optional().openapi({ description: "Whether the GPG key has been verified" }),
  created_at: z
    .string()
    .optional()
    .openapi({ format: "date-time", description: "The date and time when the GPG key was created" }),
  expires_at: z
    .string()
    .optional()
    .openapi({ format: "date-time", description: "The date and time when the GPG key expires" }),
});

export type GpgKey = z.infer<typeof gpgKeySchema>;

/** `#/responses/GPGKeyList` — plain `GPGKey[]` (the GPG-key listing). */
export const gpgKeyListSchema = z.array(gpgKeySchema);

export type GpgKeyList = z.infer<typeof gpgKeyListSchema>;
