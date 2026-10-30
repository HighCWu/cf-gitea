import { z } from "@hono/zod-openapi";

import { userSchema } from "./user";

/**
 * Mirrors of the vendored contract's release definitions
 * (gitea/templates/swagger/v1-swagger.generated.json
 * #/definitions/{Attachment,Release,CreateReleaseOption,EditReleaseOption}),
 * field-for-field including formats and descriptions. The contract declares
 * no `required` fields on the response models; the schemas mirror that
 * literally. `CreateReleaseOption.tag_name` is the one required body field.
 */

/** `#/definitions/Attachment` — release assets render the empty list until
 *  the R2 asset wave (SPEC-0004 open question 3). */
export const attachmentSchema = z.object({
  browser_download_url: z
    .string()
    .optional()
    .openapi({ description: "DownloadURL is the URL to download the attachment" }),
  created_at: z.string().optional().openapi({ format: "date-time", description: "Created is the time when the attachment was uploaded" }),
  download_count: z
    .number()
    .int()
    .optional()
    .openapi({ format: "int64", description: "DownloadCount is the number of times the attachment has been downloaded" }),
  id: z.number().int().optional().openapi({ format: "int64", description: "ID is the unique identifier for the attachment" }),
  name: z.string().optional().openapi({ description: "Name is the filename of the attachment" }),
  size: z.number().int().optional().openapi({ format: "int64", description: "Size is the file size in bytes" }),
  uuid: z.string().optional().openapi({ description: "UUID is the unique identifier for the attachment file" }),
});

export type Attachment = z.infer<typeof attachmentSchema>;

/** `#/definitions/Release` — field-for-field. */
export const releaseSchema = z.object({
  assets: z.array(attachmentSchema).optional().openapi({ description: "The files attached to the release" }),
  author: userSchema.nullable().optional(),
  body: z.string().optional().openapi({ description: "The release notes or description" }),
  created_at: z.string().optional().openapi({ format: "date-time" }),
  draft: z.boolean().optional().openapi({ description: "Whether the release is a draft" }),
  html_url: z.string().optional().openapi({ description: "The HTML URL to view the release" }),
  id: z.number().int().optional().openapi({ format: "int64", description: "The unique identifier of the release" }),
  name: z.string().optional().openapi({ description: "The display title of the release" }),
  prerelease: z.boolean().optional().openapi({ description: "Whether the release is a prerelease" }),
  published_at: z.string().nullable().optional().openapi({ format: "date-time" }),
  tag_name: z.string().optional().openapi({ description: "The name of the git tag associated with the release" }),
  tarball_url: z.string().optional().openapi({ description: "The URL to download the tarball archive" }),
  target_commitish: z.string().optional().openapi({ description: "The target commitish for the release" }),
  upload_url: z.string().optional().openapi({ description: "The URL template for uploading release assets" }),
  url: z.string().optional().openapi({ description: "The API URL of the release" }),
  zipball_url: z.string().optional().openapi({ description: "The URL to download the zip archive" }),
});

export type Release = z.infer<typeof releaseSchema>;

/** `#/responses/ReleaseList` — plain `Release[]`. */
export const releaseListSchema = z.array(releaseSchema);

export type ReleaseList = z.infer<typeof releaseListSchema>;

/** `#/definitions/CreateReleaseOption` — `tag_name` required. */
export const createReleaseOptionSchema = z.object({
  body: z.string().optional().openapi({ description: "The release notes or description" }),
  draft: z.boolean().optional().openapi({ description: "Whether to create the release as a draft" }),
  name: z.string().optional().openapi({ description: "The display title of the release" }),
  prerelease: z.boolean().optional().openapi({ description: "Whether to mark the release as a prerelease" }),
  tag_message: z.string().optional().openapi({ description: "The message for the git tag" }),
  tag_name: z.string().openapi({ description: "The name of the git tag associated with the release" }),
  target_commitish: z.string().optional().openapi({ description: "The target commitish for the release" }),
});

export type CreateReleaseOption = z.infer<typeof createReleaseOptionSchema>;

/**
 * `#/definitions/EditReleaseOption` — every field optional; upstream applies
 * only the SET fields (empty strings leave the stored value untouched).
 * The `tag_name` rename lands the NEW git tag (a lightweight write —
 * UpdateRelease's empty-message createTag, services/releases.ts); upstream
 * never deletes the old ref.
 */
export const editReleaseOptionSchema = z.object({
  body: z.string().optional().openapi({ description: "The new release notes or description" }),
  draft: z.boolean().optional().openapi({ description: "Whether to change the draft status" }),
  name: z.string().optional().openapi({ description: "The new display title of the release" }),
  prerelease: z.boolean().optional().openapi({ description: "Whether to change the prerelease status" }),
  tag_name: z.string().optional().openapi({ description: "The new name of the git tag" }),
  target_commitish: z.string().optional().openapi({ description: "The new target commitish for the release" }),
});

export type EditReleaseOption = z.infer<typeof editReleaseOptionSchema>;
