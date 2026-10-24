import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context, MiddlewareHandler } from "hono";
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import { releases } from "../../db/schema";
import type { ApiEnv } from "../env";
import { ApiError, apiErrorSchema } from "../errors";
import {
  branchRef,
  commitApiChangeError,
  deleteApiRefError,
  engineCell,
  engineReads,
  refTipMap,
  tagRef,
  ZERO_OID,
} from "../services/engine";
import { toAnnotatedTag, toTag } from "../services/git-models";
import { annotatedTagSchema, createTagOptionSchema, tagSchema } from "../models/git";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { assertNotArchived, canWriteRepository, requireVisibleRepo } from "../services/repo-access";
import { viewerOf } from "../services/repository";
import { serializeTag } from "@cf-gitea/git-engine";

/**
 * Tier-1 tag routes (SPEC-0004 §2.4 rows repoListTags / repoCreateTag /
 * repoGetTag / repoDeleteTag / GetAnnotatedTag — 3 paths, 5 operations).
 * Reads render straight from the engine refs table (targets + the peel cache
 * distinguish annotated from lightweight without reading objects); creation
 * builds the tag object Worker-side through the engine's canonical
 * `serializeTag` and lands it via putApiObjects + commitApiChange (the
 * SPEC-0004 §3.4 commit-builder mapping); deletion is deleteApiRef.
 *
 * Upstream behavior mirrored (routers/api/v1/repo/tag.go):
 *   - POST answers **200** (not 201) with the Tag — the contract quirk;
 *   - POST on an empty repo → **405**; a missing `target` → 404
 *     "target not found: …"; a duplicate tag → 409 "tag already exists";
 *   - DELETE refuses a tag that has a release attached with 409 "a tag
 *     attached to a release cannot be deleted directly" (the releases table
 *     lookup the release routes share);
 *   - GET /git/tags/{sha} is annotated tag OBJECTS only — lightweight tags
 *     (no peel on the refs row) and unknown oids → 404; a malformed param →
 *     the declared 400 "SHA not provided" family.
 *
 * Documented deviation (services/git-models.ts toTag/toAnnotatedTag): the tag
 * message and tagger render "" / null — annotated-tag object bytes are
 * engine-resident and the landed public RPC surface exposes targets + the
 * peel cache only. Webhook fan-out (create/delete ref events) is the push
 * pipeline's job upstream; the API-side writes do not fan out yet
 * (SPEC-0005 §3.5 gap).
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const repoArchivedResponse = {
  description: "repoArchivedError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const pageLimitQuery = {
  page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
  limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
} as const;

const bindValidationHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

interface TagTip {
  name: string;
  target: string;
  peeled?: string;
}

/** Tag refs sorted by name — the engine's list order is unspecified. */
async function sortedTags(c: Context<ApiEnv>, pair: { ownerNamespace: string; slug: string }): Promise<TagTip[]> {
  const refs = await engineReads(c.env, pair).listRefs();
  return (refs?.refs ?? [])
    .filter((ref) => ref.name.startsWith("refs/tags/"))
    .map((ref) => ({
      name: ref.name.slice("refs/tags/".length),
      target: ref.target,
      ...(ref.peeled === undefined ? {} : { peeled: ref.peeled }),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The peeled commit a tag points at (tag objects read via readCommit's peel). */
async function tagCommitSha(c: Context<ApiEnv>, pair: { ownerNamespace: string; slug: string }, tip: TagTip): Promise<string | null> {
  if (tip.peeled !== undefined) return tip.peeled;
  const commit = await engineReads(c.env, pair).readCommit(tip.target);
  return commit === null ? null : commit.oid;
}

/** True when a release row is attached to the tag (upstream release coupling). */
async function hasRelease(d1: D1Database, repoId: string, tagName: string): Promise<boolean> {
  const row = await drizzle(d1)
    .select({ id: releases.id })
    .from(releases)
    .where(and(eq(releases.repoId, repoId), eq(releases.tagName, tagName)))
    .limit(1)
    .then((rows) => rows[0]);
  return row !== undefined;
}

export function registerTagRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/tags (repoListTags)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/tags",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "List a repository's tags",
      operationId: "repoListTags",
      request: {
        params: z.object({
          owner: z.string().min(1).openapi({ description: "owner of the repo" }),
          repo: z.string().min(1).openapi({ description: "name of the repo" }),
        }),
        query: z.object({
          page: pageLimitQuery.page,
          limit: pageLimitQuery.limit,
        }),
      },
      responses: {
        200: { description: "TagList", content: { "application/json": { schema: z.array(tagSchema) } } },
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      const listOptions = parseListOptions(new URL(c.req.url));
      const tags = await sortedTags(c, pair.repo);
      setPaginationHeaders(c, tags.length, listOptions);
      const start = (listOptions.page - 1) * listOptions.limit;
      const page = tags.slice(start, start + listOptions.limit);
      const viewer = viewerOf(c);
      const rendered = await Promise.all(
        page.map(async (tip) => {
          const sha = await tagCommitSha(c, pair.repo, tip);
          return sha === null ? null : toTag(tip.name, tip, sha, pair, viewer.origin);
        }),
      );
      return c.json(rendered.filter((tag) => tag !== null), 200);
    },
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/tags (repoCreateTag) — 200 quirk
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/tags",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Create a tag",
      operationId: "repoCreateTag",
      request: {
        params: z.object({
          owner: z.string().min(1).openapi({ description: "owner of the repo" }),
          repo: z.string().min(1).openapi({ description: "name of the repo" }),
        }),
        body: { content: { "application/json": { schema: createTagOptionSchema } } },
      },
      responses: {
        200: { description: "Tag", content: { "application/json": { schema: tagSchema } } },
        404: notFoundResponse,
        405: { description: "empty" },
        409: { description: "conflict" },
        422: validationErrorResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      assertNotArchived(pair);
      if (pair.repo.isEmpty) {
        throw new ApiError(405, "Git Repository is empty.");
      }
      if (!(await canWriteRepository(c, pair))) {
        throw new ApiError(403, "user should have a permission to write to the target branch");
      }
      const form = c.req.valid("json");
      const name = form.tag_name;

      const reads = engineReads(c.env, pair.repo);
      const tips = refTipMap(await reads.listRefs());

      // Target resolution: explicit `target` (a branch/tag name, full ref, or
      // oid) or the default branch (CreateTag → GetTargetCommit).
      const explicit = form.target !== undefined && form.target !== "";
      const refParam = explicit ? (form.target as string) : pair.repo.defaultBranch;
      let commitSha: string;
      const tip = tips.get(branchRef(refParam)) ?? tips.get(tagRef(refParam)) ?? (explicit ? tips.get(refParam) : undefined);
      if (tip !== undefined) {
        const sha = await tagCommitSha(c, pair.repo, { name: refParam, target: tip.target, ...(tip.peeled === undefined ? {} : { peeled: tip.peeled }) });
        if (sha === null) throw new ApiError(404, `target not found: ${refParam}`);
        commitSha = sha;
      } else if (/^[0-9a-f]{40}$/.test(refParam)) {
        commitSha = refParam;
      } else {
        throw new ApiError(404, `target not found: ${refParam}`);
      }

      if (tips.has(tagRef(name))) {
        throw new ApiError(409, "tag already exists");
      }

      // A message creates the ANNOTATED tag object (serializeTag →
      // putApiObjects → ref CAS); without one the tag is lightweight.
      let newTarget = commitSha;
      if (form.message !== undefined && form.message !== "") {
        const doerRow = c.get("authUser");
        const now = Math.floor(Date.now() / 1000);
        const tag = serializeTag({
          object: commitSha,
          type: "commit",
          tag: name,
          tagger:
            doerRow === undefined
              ? null
              : {
                  name: doerRow.login ?? "gitea",
                  email:
                    doerRow.email === undefined || doerRow.email === ""
                      ? `${doerRow.login ?? "gitea"}@noreply.${new URL(c.req.url).hostname}`
                      : doerRow.email,
                  time: now,
                  tz: "+0000",
                },
          message: form.message,
        });
        const stored = await engineCell(c.env, pair.repo).putApiObjects([{ oid: tag.oid, type: tag.type, data: tag.data }]);
        if (stored.tag !== "ok") {
          throw new ApiError(422, stored.tag === "invalid" ? stored.reason : "tag object too large");
        }
        newTarget = tag.oid;
      }

      const result = await engineCell(c.env, pair.repo).commitApiChange({
        ref: tagRef(name),
        expectedOldOid: ZERO_OID,
        newOid: newTarget,
      });
      if (result.tag !== "committed") {
        if (result.tag === "invalid") {
          throw new ApiError(422, result.reason);
        }
        throw commitApiChangeError(result);
      }

      const viewer = viewerOf(c);
      return c.json(
        toTag(
          name,
          newTarget === commitSha ? { target: newTarget } : { target: newTarget, peeled: commitSha },
          commitSha,
          pair,
          viewer.origin,
        ),
        200,
      );
    },
    bindValidationHook,
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/tags/{tag} (repoGetTag)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/tags/{tag}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get an existing tag",
      operationId: "repoGetTag",
      request: {
        params: z.object({
          owner: z.string().min(1).openapi({ description: "owner of the repo" }),
          repo: z.string().min(1).openapi({ description: "name of the repo" }),
          tag: z.string().min(1).openapi({ description: "name of tag" }),
        }),
      },
      responses: {
        200: { description: "Tag", content: { "application/json": { schema: tagSchema } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      const tagName = c.req.valid("param").tag;
      const tip = refTipMap(await engineReads(c.env, pair.repo).listRefs()).get(tagRef(tagName));
      if (tip === undefined) {
        throw new ApiError(404, "tag doesn't exist: " + tagName);
      }
      const sha = await tagCommitSha(c, pair.repo, { name: tagName, target: tip.target, ...(tip.peeled === undefined ? {} : { peeled: tip.peeled }) });
      if (sha === null) {
        throw new ApiError(404, "tag doesn't exist: " + tagName);
      }
      return c.json(toTag(tagName, tip, sha, pair, viewerOf(c).origin), 200);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /repos/{owner}/{repo}/tags/{tag} (repoDeleteTag) — 204
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/repos/{owner}/{repo}/tags/{tag}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Delete an existing tag (must be an annotated tag)",
      operationId: "repoDeleteTag",
      request: {
        params: z.object({
          owner: z.string().min(1).openapi({ description: "owner of the repo" }),
          repo: z.string().min(1).openapi({ description: "name of the repo" }),
          tag: z.string().min(1).openapi({ description: "name of tag" }),
        }),
      },
      responses: {
        204: { description: "empty" },
        404: notFoundResponse,
        405: { description: "empty" },
        409: validationErrorResponse,
        422: validationErrorResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      assertNotArchived(pair);
      if (pair.repo.isEmpty) {
        throw new ApiError(405, "Git Repository is empty.");
      }
      if (!(await canWriteRepository(c, pair))) {
        throw new ApiError(403, "user should have a permission to write to the target branch");
      }
      const tagName = c.req.valid("param").tag;
      if ((await hasRelease(c.env.DB, pair.repo.id, tagName))) {
        throw new ApiError(409, "a tag attached to a release cannot be deleted directly");
      }
      const tip = refTipMap(await engineReads(c.env, pair.repo).listRefs()).get(tagRef(tagName));
      if (tip === undefined) {
        throw new ApiError(404, "not found");
      }
      const result = await engineCell(c.env, pair.repo).deleteApiRef({ ref: tagRef(tagName), expectedOid: tip.target });
      if (result.tag !== "deleted") {
        const error = deleteApiRefError(result);
        if (error !== null) throw error;
      }
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/git/tags/{sha} (GetAnnotatedTag) — annotated
  // tag objects only; lightweight tags peel nowhere → 404.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/git/tags/{sha}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Gets the tag object of an annotated tag (not lightweight tags)",
      operationId: "GetAnnotatedTag",
      request: {
        params: z.object({
          owner: z.string().min(1).openapi({ description: "owner of the repo" }),
          repo: z.string().min(1).openapi({ description: "name of the repo" }),
          sha: z.string().min(1).openapi({ description: "sha of the tag. The Git SHA of the tag object, not the Git commit" }),
        }),
      },
      responses: {
        200: { description: "AnnotatedTag", content: { "application/json": { schema: annotatedTagSchema } } },
        400: validationErrorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      const sha = c.req.valid("param").sha;
      if (!/^[0-9a-f]{40}$/.test(sha)) {
        throw new ApiError(400, "SHA not provided");
      }
      const tags = await sortedTags(c, pair.repo);
      const tip = tags.find((tag) => tag.target === sha);
      if (tip === undefined || tip.peeled === undefined) {
        // unknown oid or a lightweight tag (no peel on the refs row)
        throw new ApiError(404, "not found");
      }
      return c.json(toAnnotatedTag(tip.name, tip, tip.peeled, pair, viewerOf(c).origin), 200);
    },
  );
}
