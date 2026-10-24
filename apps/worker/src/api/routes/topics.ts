import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { repoTopicOptionsSchema, topicNamesSchema } from "../models/topic";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { assertNotArchived, requireRepoAdmin, requireVisibleRepo } from "../services/repo-access";
import {
  listRepoTopics,
  MAX_TOPICS_PER_REPO,
  replaceRepoTopics,
  sanitizeAndValidateTopics,
} from "../services/repo-topics";

/**
 * Tier-1 repo-topic routes (SPEC-0004 §2.4 rows repoListTopics /
 * repoUpdateTopics; upstream routers/api/v1/repo/topic.go on the
 * `repo_topics` raw-D1 store — services/repo-topics.ts documents the schema
 * gap and the storage decision).
 *
 * Auth (upstream registration, routers/api/v1/api.go:1532–1538): the group is
 * `reqAnyRepoReader` — anonymous reads on public repositories; PUT carries
 * `reqToken + reqAdmin + mustNotBeArchived` (the admin gate in
 * services/repo-access.ts).
 *
 * Declared responses mirror the vendored contract exactly. The 422
 * invalidTopicsError body is NOT the {message, url} family: upstream renders
 * `{message, invalidTopics}` directly (topic.go UpdateTopics ctx.JSON), no
 * url field — the route writes that exact body by hand (ApiError's envelope
 * would add `url` and drift from both upstream and the frozen fixture).
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

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

/** Body bind hook: upstream's Go bind answers malformed bodies with 422. */
const topicsBodyHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

const listTopicsRoute = (optionalAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "get",
    path: "/repos/{owner}/{repo}/topics",
    middleware: [optionalAuth],
    tags: ["repository"],
    summary: "Get list of topics that a repository has",
    operationId: "repoListTopics",
    request: {
      params: z.object(ownerRepoParams),
      query: z.object({
        page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
        limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
      }),
    },
    responses: {
      200: { description: "TopicNames", content: { "application/json": { schema: topicNamesSchema } } },
      404: notFoundResponse,
    },
  });

const updateTopicsRoute = (requireAuth: MiddlewareHandler<ApiEnv>) =>
  createRoute({
    method: "put",
    path: "/repos/{owner}/{repo}/topics",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Replace list of topics for a repository",
    operationId: "repoUpdateTopics",
    request: {
      params: z.object(ownerRepoParams),
      body: { content: { "application/json": { schema: repoTopicOptionsSchema } } },
    },
    responses: {
      204: emptyResponse,
      404: notFoundResponse,
      422: invalidTopicsResponse,
      423: repoArchivedResponse,
    },
  });

export function registerTopicRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  app.openapi(listTopicsRoute(optionalAuth), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    const listOptions = parseListOptions(new URL(c.req.url));
    const topics = await listRepoTopics(c.env.DB, found.repo.id);
    // Upstream paginates the name list (FindAndCount + SetTotalCountHeader);
    // the 25-topic cap makes the slice a formality, the headers are not.
    const total = topics.length;
    const start = (listOptions.page - 1) * listOptions.limit;
    setPaginationHeaders(c, total, listOptions);
    return c.json({ topics: topics.slice(start, start + listOptions.limit) }, 200);
  });

  app.openapi(
    updateTopicsRoute(requireAuth),
    async (c) => {
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      assertNotArchived(found);
      await requireRepoAdmin(c, found);
      const form = c.req.valid("json");
      const { valid, invalid } = sanitizeAndValidateTopics(form.topics ?? []);

      // Guard order is upstream's: the count cap fires before the validity
      // split (topic.go UpdateTopics). Both 422 bodies are the hand-built
      // {message, invalidTopics} shape (module header).
      if (valid.length > MAX_TOPICS_PER_REPO) {
        return c.json({ message: "Exceeding maximum number of topics per repo", invalidTopics: null }, 422);
      }
      if (invalid.length > 0) {
        return c.json({ message: "Topic names are invalid", invalidTopics: [...invalid] }, 422);
      }

      await replaceRepoTopics(c.env.DB, found.repo.id, valid);
      return c.body(null, 204);
    },
    topicsBodyHook,
  );
}
