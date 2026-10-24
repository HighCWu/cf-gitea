import { z } from "@hono/zod-openapi";

/**
 * Mirror of the vendored contract's `MarkdownOption` definition
 * (gitea/templates/swagger/v1-swagger.generated.json
 * #/definitions/MarkdownOption, Go struct modules/structs/miscellaneous.go),
 * field-for-field including the capitalized Go field names (the struct
 * carries no json tags, so the wire keys are the Go names). The contract
 * declares no `required` fields; the schema mirrors that literally — absent
 * fields mean Go zero values ("" / false) at runtime.
 */
export const markdownOptionSchema = z.object({
  Context: z
    .string()
    .optional()
    .openapi({
      description:
        "URL path for rendering issue, media and file links\nExpected format: /subpath/{user}/{repo}/src/{branch, commit, tag}/{identifier/path}/{file/dir}",
    }),
  Mode: z
    .string()
    .optional()
    .openapi({ description: "Mode to render (markdown, comment, wiki, file)" }),
  Text: z.string().optional().openapi({ description: "Text markdown to render" }),
  Wiki: z
    .boolean()
    .optional()
    .openapi({ description: "Is it a wiki page? (use mode=wiki instead)", deprecated: true }),
});

export type MarkdownOption = z.infer<typeof markdownOptionSchema>;
