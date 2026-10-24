import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { assertNotArchived, requireRepoAdmin, requireVisibleRepo } from "../services/repo-access";
import {
  listRepoTopics,
  MAX_TOPICS_PER_REPO,
  replaceRepoTopics,
  sanitizeAndValidateTopics,
} from "../services/repo-topics";

/**
 * Tier-2 repo-topic item routes (SPEC-0004 appendix A row
 * `/repos/{owner}/{repo}/topics/{topic}` — upstream routers/api/v1/repo/
 * topic.go AddTopic / DeleteTopic).
 *
 * Auth matches the landed tier-1 topic group exactly (upstream registers both
 * in the same `reqToken + reqAdmin` group, api.go:1532–1538): writes are
 * requireAuth + requireRepoAdmin + mustNotBeArchived.
 *
 * Semantics (topic.go:169–204 / 238–262):
 *   - the path topic is trimmed + lower-cased, then validated — invalid names
 *     answer the hand-written `{invalidTopics, message}` 422 body (NOT the
 *     {message, url} envelope — the UpdateTopics quirk routes/topics.ts
 *     documents);
 *   - PUT answers 204 even when the topic already exists (AddTopic returns
 *     the existing row); the 25-topic cap answers a bare-message 422;
 *   - DELETE answers the empty-family 404 when the repo doesn't carry the
 *     topic (DeleteTopic's APIErrorNotFound arm).
 *
 * Declared responses mirror the vendored contract (PUT/DELETE
 * 204/404/422/423); the 423 repoArchivedError IS reachable (archived
 * repositories exist).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const emptyResponse = { description: "empty" } as const;

const invalidTopicsResponse = {
  description: "invalidTopicsError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const repoArchivedResponse = {
  description: "repoArchivedError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const topicParams = {
  params: z.object({
    owner: z.string().min(1).openapi({ description: "owner of the repo" }),
    repo: z.string().min(1).openapi({ description: "name of the repo" }),
    topic: z.string().min(1).openapi({ description: "name of the topic to add" }),
  }),
} as const;

const addTopicRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "put",
    path: "/repos/{owner}/{repo}/topics/{topic}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Add a topic to a repository",
    operationId: "repoAddTopic",
    request: topicParams,
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
      422: invalidTopicsResponse,
      423: repoArchivedResponse,
    },
  });

const deleteTopicRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "delete",
    path: "/repos/{owner}/{repo}/topics/{topic}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Delete a topic from a repository",
    operationId: "repoDeleteTopic",
    request: topicParams,
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
      422: invalidTopicsResponse,
      423: repoArchivedResponse,
    },
  });

/** Upstream's inline `{invalidTopics: [name], message: "Topic name is
 *  invalid"}` body — hand-written like the UpdateTopics 422 (no url field;
 *  ApiError's envelope would add one). */
function invalidTopicBody(c: Context<ApiEnv>, topic: string): Response {
  return c.json({ message: "Topic name is invalid", invalidTopics: [topic] }, 422);
}

export function registerTopicItemRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  // PUT /repos/{owner}/{repo}/topics/{topic} — AddTopic (topic.go:137–204):
  // validate → cap check → add (the existing-topic arm is AddTopic returning
  // the row → 204 either way).
  app.openapi(addTopicRoute(requireAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    assertNotArchived(found);
    await requireRepoAdmin(c, found);
    const { topic: rawTopic } = c.req.valid("param");
    const topic = rawTopic.trim().toLowerCase();
    const { valid, invalid } = sanitizeAndValidateTopics([topic]);
    const name = valid[0];
    if (invalid.length > 0 || name === undefined) {
      return invalidTopicBody(c, topic);
    }
    const current = await listRepoTopics(c.env.DB, found.repo.id);
    if (current.includes(name)) {
      return c.body(null, 204);
    }
    if (current.length >= MAX_TOPICS_PER_REPO) {
      // Upstream AddTopic's cap body carries no invalidTopics arm.
      return c.json({ message: "Exceeding maximum allowed topics per repo.", invalidTopics: null }, 422);
    }
    await replaceRepoTopics(c.env.DB, found.repo.id, [...current, name]);
    return c.body(null, 204);
  });

  // DELETE /repos/{owner}/{repo}/topics/{topic} — DeleteTopic (topic.go:
  // 206–262): validate → delete; the missing-topic arm is the 404.
  app.openapi(deleteTopicRoute(requireAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    assertNotArchived(found);
    await requireRepoAdmin(c, found);
    const { topic: rawTopic } = c.req.valid("param");
    const topic = rawTopic.trim().toLowerCase();
    const { valid, invalid } = sanitizeAndValidateTopics([topic]);
    const name = valid[0];
    if (invalid.length > 0 || name === undefined) {
      return invalidTopicBody(c, topic);
    }
    const current = await listRepoTopics(c.env.DB, found.repo.id);
    if (!current.includes(name)) {
      throw new ApiError(404, "not found");
    }
    await replaceRepoTopics(
      c.env.DB,
      found.repo.id,
      current.filter((entry) => entry !== name),
    );
    return c.body(null, 204);
  });
}
