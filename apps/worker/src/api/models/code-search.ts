import { z } from "@hono/zod-openapi";

import { repositorySchema } from "./repository";

/**
 * Mirrors of the vendored contract's code-search definitions
 * (gitea/templates/swagger/v1-swagger.generated.json
 * #/definitions/{CodeSearchResults, CodeSearchResultItem,
 * CodeSearchTextMatch, CodeSearchTextMatchTerm} — the 38389f00be pair),
 * field-for-field. Struct field order is the Go marshal order; `language`
 * carries upstream's omitempty (a git-grep result never sets it, so the
 * rendered item omits the key entirely).
 */

/** `CodeSearchTextMatchTerm` — one matched term inside a fragment. */
export const codeSearchTextMatchTermSchema = z.object({
  text: z.string().openapi({ description: "The matched text" }),
  /** Start and end UTF-8 byte offsets in the fragment, end-exclusive */
  indices: z.array(z.number().int()).openapi({ description: "Matches text's start and end indices" }),
});
export type CodeSearchTextMatchTerm = z.infer<typeof codeSearchTextMatchTermSchema>;

/** `CodeSearchTextMatch` — one matching fragment of a file's content. */
export const codeSearchTextMatchSchema = z.object({
  object_url: z.string().openapi({ description: "URL to the object" }),
  object_type: z.string().openapi({ description: "Type of the object" }),
  property: z.string().openapi({ description: "Property of the object" }),
  fragment: z.string().openapi({ description: "Fragment" }),
  matches: z.array(codeSearchTextMatchTermSchema).openapi({ description: "Matched terms" }),
});
export type CodeSearchTextMatch = z.infer<typeof codeSearchTextMatchSchema>;

/** `CodeSearchResultItem` — one matching file. */
export const codeSearchResultItemSchema = z.object({
  name: z.string().openapi({ description: "The file base name" }),
  path: z.string().openapi({ description: "The file full path" }),
  /** Contents API URL at the searched commit */
  url: z.string().openapi({ description: "The URL" }),
  /** File URL at the searched commit */
  html_url: z.string().openapi({ description: "The HTML URL" }),
  /** Programming language (Gitea extension) — omitempty upstream */
  language: z.string().optional().openapi({ description: "The language" }),
  repository: repositorySchema.openapi({ description: "The repository" }),
  text_matches: z.array(codeSearchTextMatchSchema).openapi({ description: "The text matches" }),
});
export type CodeSearchResultItem = z.infer<typeof codeSearchResultItemSchema>;

/** `CodeSearchResults` — the search envelope. */
export const codeSearchResultsSchema = z.object({
  total_count: z.number().int().openapi({ description: "Total number of matches" }),
  /** Search stopped early */
  incomplete_results: z.boolean().openapi({ description: "Whether the results are incomplete" }),
  items: z.array(codeSearchResultItemSchema).openapi({ description: "The matching files" }),
});
export type CodeSearchResults = z.infer<typeof codeSearchResultsSchema>;
