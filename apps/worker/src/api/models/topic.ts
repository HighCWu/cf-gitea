import { z } from "@hono/zod-openapi";

/**
 * Mirrors of the vendored contract's topic definitions
 * (gitea/templates/swagger/v1-swagger.generated.json
 * #/definitions/{TopicName,RepoTopicOptions}), field-for-field.
 */

/** `TopicName` — the GET /repos/{owner}/{repo}/topics response. */
export const topicNamesSchema = z.object({
  topics: z.array(z.string()).optional().openapi({ description: "List of topic names" }),
});

export type TopicNames = z.infer<typeof topicNamesSchema>;

/** `RepoTopicOptions` — the PUT /repos/{owner}/{repo}/topics body. */
export const repoTopicOptionsSchema = z.object({
  topics: z.array(z.string()).optional().openapi({ description: "list of topic names" }),
});

export type RepoTopicOptions = z.infer<typeof repoTopicOptionsSchema>;
