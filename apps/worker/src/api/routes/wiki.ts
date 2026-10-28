import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";

import { AvatarBase64Error, decodeStrictBase64 } from "../../services/avatars";
import {
  createWikiPage,
  deleteWikiPage,
  editWikiPage,
  formInt,
  listWikiPageRevisions,
  listWikiPages,
  readWikiPage,
  webPathFromRequest,
  WIKI_DEFAULT_PAGING_NUM,
} from "../../services/wiki";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { setPaginationHeaders } from "../pagination";
import { assertNotArchived, canWriteRepository, requireVisibleRepo } from "../services/repo-access";

/**
 * The six repository-wiki operations of the remaining-API inventory's batch
 * 10 (`wave-api-wiki`; specs/wiki.md — the design record for the sibling
 * `owner/slug.wiki` engine cell and the WebPath codec):
 *
 *   GET    /repos/{owner}/{repo}/wiki/pages                (repoGetWikiPages)
 *   GET    /repos/{owner}/{repo}/wiki/page/{pageName}      (repoGetWikiPage)
 *   GET    /repos/{owner}/{repo}/wiki/revisions/{pageName} (repoGetWikiPageRevisions)
 *   POST   /repos/{owner}/{repo}/wiki/new                  (repoCreateWikiPage)
 *   PATCH  /repos/{owner}/{repo}/wiki/page/{pageName}      (repoEditWikiPage)
 *   DELETE /repos/{owner}/{repo}/wiki/page/{pageName}      (repoDeleteWikiPage)
 *
 * Upstream gates (routers/api/v1/api.go:1389-1396): the reads run under
 * repoAssignment visibility only; the writes chain reqToken →
 * mustNotBeArchived → reqRepoWriter(unit.TypeWiki) — the landed trio
 * requireAuth → assertNotArchived → canWriteRepository, in that order (the
 * archive gate answers 423 before the write grant's 403, like upstream).
 *
 * Declared response sets are EXACTLY the frozen contract's. Runtime-only
 * emissions for the orchestrator's RUNTIME_ONLY_RESPONSES ledger (the landed
 * contents/avatars-family posture): 401 (reqToken) on the three writes; 422
 * on a schema-invalid body (Go bind class) and on the engine's change-size
 * budget; 500 (the APIErrorInternal class — including a reserved title on
 * PATCH, upstream wiki.go router maps the service error the same way); 409
 * on a lost ref CAS race.
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "error",
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

const pageNameParam = {
  pageName: z.string().openapi({ description: "name of the page" }),
} as const;

const pageQuery = {
  page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
} as const;

const pagesQuery = {
  page: z.string().optional().openapi({ type: "integer", description: "page number of results to return (1-based)" }),
  limit: z.string().optional().openapi({ type: "integer", description: "page size of results" }),
} as const;

/** `#/definitions/WikiCommit` — upstream's one-t `commiter` kept verbatim. */
const wikiCommitUserSchema = z.object({
  name: z.string(),
  email: z.string(),
  date: z.string(),
});

const wikiCommitSchema = z.object({
  sha: z.string().openapi({ description: "The commit SHA hash" }),
  author: wikiCommitUserSchema,
  commiter: wikiCommitUserSchema,
  message: z.string().openapi({ description: "The commit message" }),
});

/** `#/definitions/WikiPageMetaData`. */
const wikiPageMetaDataSchema = z.object({
  title: z.string().openapi({ description: "The title of the wiki page" }),
  html_url: z.string().openapi({ description: "The HTML URL to view the wiki page" }),
  sub_url: z.string().openapi({ description: "The sub URL path for the wiki page" }),
  last_commit: wikiCommitSchema.nullable(),
});

/** `#/definitions/WikiPage`. */
const wikiPageSchema = wikiPageMetaDataSchema.extend({
  content_base64: z.string().openapi({ description: "Page content, base64 encoded" }),
  commit_count: z.number().int().openapi({ description: "The number of commits that modified this page" }),
  sidebar: z.string().openapi({ description: "The sidebar content for the wiki page" }),
  footer: z.string().openapi({ description: "The footer content for the wiki page" }),
});

/** `#/definitions/WikiCommitList`. */
const wikiCommitListSchema = z.object({
  commits: z.array(wikiCommitSchema),
  count: z.number().int().openapi({ description: "The total count of commits" }),
});

/** `#/definitions/CreateWikiPageOptions` — the create and edit body. */
const createWikiPageOptionsSchema = z.object({
  title: z.string().optional().openapi({ description: "page title. leave empty to keep unchanged" }),
  content_base64: z.string().optional().openapi({ description: "content must be base64 encoded" }),
  message: z.string().optional().openapi({ description: "optional commit message summarizing the change" }),
});
type CreateWikiPageOptions = z.infer<typeof createWikiPageOptionsSchema>;

/** Go bind parity (api.go bind → 422; a runtime-only class for this family). */
const wikiBodyHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

/** The doer's git identity — the contents-family derivation (author ==
 *  committer == doer, like upstream's doer.NewGitSig() on both sides). */
function wikiDoer(c: Context<ApiEnv>): { name: string; email: string } {
  const doer = c.get("authUser");
  const hostname = new URL(c.req.url).hostname;
  if (doer === undefined) {
    return { name: "Gitea", email: `gitea@noreply.${hostname}` };
  }
  const email = doer.email === undefined || doer.email === "" ? `${doer.login ?? "gitea"}@noreply.${hostname}` : doer.email;
  return { name: doer.login ?? "gitea", email };
}

/** Decode `content_base64` (strict StdEncoding — Go CorruptInputError 400s). */
function decodeContent(form: CreateWikiPageOptions): Uint8Array {
  const raw = form.content_base64 ?? "";
  try {
    return decodeStrictBase64(raw);
  } catch (error) {
    if (error instanceof AvatarBase64Error) {
      throw new ApiError(400, error.message);
    }
    throw error;
  }
}

/** The write gates, in upstream's order: 401 (middleware) → 423 → 403. */
async function wikiWriteGuard(c: Context<ApiEnv>, owner: string, repo: string) {
  const pair = await requireVisibleRepo(c, { owner, repo });
  assertNotArchived(pair);
  if (!(await canWriteRepository(c, pair))) {
    throw new ApiError(403, "user should have a permission to write to the target branch");
  }
  return pair;
}

export function registerWikiRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/wiki/pages (repoGetWikiPages)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/wiki/pages",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get all wiki pages",
      operationId: "repoGetWikiPages",
      request: { params: z.object(ownerRepoParams), query: z.object(pagesQuery) },
      responses: {
        200: { description: "WikiPageList", content: { "application/json": { schema: z.array(wikiPageMetaDataSchema) } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { owner, repo } = c.req.valid("param");
      const pair = await requireVisibleRepo(c, { owner, repo });
      const url = new URL(c.req.url);
      const page = Math.max(formInt(url, "page"), 1);
      const rawLimit = formInt(url, "limit");
      const limit = rawLimit <= 1 ? WIKI_DEFAULT_PAGING_NUM : rawLimit;
      const list = await listWikiPages(c.env, pair, page, limit, url.origin);
      setPaginationHeaders(c, list.totalEntries, { page, limit });
      return c.json(list.pages, 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/wiki/page/{pageName} (repoGetWikiPage)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/wiki/page/{pageName}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get a wiki page",
      operationId: "repoGetWikiPage",
      request: { params: z.object({ ...ownerRepoParams, ...pageNameParam }) },
      responses: {
        200: { description: "WikiPage", content: { "application/json": { schema: wikiPageSchema } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { owner, repo, pageName } = c.req.valid("param");
      const pair = await requireVisibleRepo(c, { owner, repo });
      const wikiName = webPathFromRequest(pageName);
      const page = await readWikiPage(c.env, pair, wikiName, new URL(c.req.url).origin);
      if (page === null) {
        throw new ApiError(404, "not found");
      }
      return c.json(page, 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/wiki/revisions/{pageName}
  // (repoGetWikiPageRevisions) — empty pageName falls back to "Home"
  // (upstream ListPageRevisions); X-Total-Count only (upstream's missing
  // SetLinkHeader FIXME).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/wiki/revisions/{pageName}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get revisions of a wiki page",
      operationId: "repoGetWikiPageRevisions",
      request: { params: z.object({ ...ownerRepoParams, ...pageNameParam }), query: z.object(pageQuery) },
      responses: {
        200: { description: "WikiCommitList", content: { "application/json": { schema: wikiCommitListSchema } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { owner, repo, pageName } = c.req.valid("param");
      const pair = await requireVisibleRepo(c, { owner, repo });
      let wikiName = webPathFromRequest(pageName);
      if (wikiName === "") wikiName = "Home";
      const url = new URL(c.req.url);
      const page = Math.max(formInt(url, "page"), 1);
      const revisions = await listWikiPageRevisions(c.env, pair, wikiName, page);
      if (revisions === null) {
        throw new ApiError(404, "not found");
      }
      c.header("X-Total-Count", String(revisions.count));
      return c.json(revisions, 200);
    },
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/wiki/new (repoCreateWikiPage) — 201
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/wiki/new",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Create a wiki page",
      operationId: "repoCreateWikiPage",
      request: {
        params: z.object(ownerRepoParams),
        body: { content: { "application/json": { schema: createWikiPageOptionsSchema } } },
      },
      responses: {
        201: { description: "WikiPage", content: { "application/json": { schema: wikiPageSchema } } },
        400: validationErrorResponse,
        403: forbiddenResponse,
        404: notFoundResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const { owner, repo } = c.req.valid("param");
      const pair = await wikiWriteGuard(c, owner, repo);
      const form = c.req.valid("json");
      const title = (form.title ?? "").trim();
      if (title === "") {
        // upstream binding:"TrimSpace;Required" → Go bind 422 (runtime-only)
        throw new ApiError(422, "invalid request body");
      }
      const content = decodeContent(form);
      const page = await createWikiPage(
        c.env,
        pair,
        wikiDoer(c),
        { title, content, message: form.message ?? "" },
        new URL(c.req.url).origin,
      );
      return c.json(page, 201);
    },
    wikiBodyHook,
  );

  // -------------------------------------------------------------------------
  // PATCH /repos/{owner}/{repo}/wiki/page/{pageName} (repoEditWikiPage)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "patch",
      path: "/repos/{owner}/{repo}/wiki/page/{pageName}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Edit a wiki page",
      operationId: "repoEditWikiPage",
      request: {
        params: z.object({ ...ownerRepoParams, ...pageNameParam }),
        body: { content: { "application/json": { schema: createWikiPageOptionsSchema } } },
      },
      responses: {
        200: { description: "WikiPage", content: { "application/json": { schema: wikiPageSchema } } },
        400: validationErrorResponse,
        403: forbiddenResponse,
        404: notFoundResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const { owner, repo, pageName } = c.req.valid("param");
      const pair = await wikiWriteGuard(c, owner, repo);
      const form = c.req.valid("json");
      const oldWikiName = webPathFromRequest(pageName);
      const content = decodeContent(form);
      const page = await editWikiPage(
        c.env,
        pair,
        wikiDoer(c),
        oldWikiName,
        { content, message: form.message ?? "", title: form.title ?? "" },
        new URL(c.req.url).origin,
      );
      return c.json(page, 200);
    },
    wikiBodyHook,
  );

  // -------------------------------------------------------------------------
  // DELETE /repos/{owner}/{repo}/wiki/page/{pageName} (repoDeleteWikiPage)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/repos/{owner}/{repo}/wiki/page/{pageName}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Delete a wiki page",
      operationId: "repoDeleteWikiPage",
      request: { params: z.object({ ...ownerRepoParams, ...pageNameParam }) },
      responses: {
        204: { description: "empty" },
        403: forbiddenResponse,
        404: notFoundResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const { owner, repo, pageName } = c.req.valid("param");
      const pair = await wikiWriteGuard(c, owner, repo);
      // The request origin rides into the `wiki` deleted payload's URL fields
      // (create/edit reuse their `origin` argument; delete carries none).
      await deleteWikiPage(c.env, pair, wikiDoer(c), webPathFromRequest(pageName), {
        origin: new URL(c.req.url).origin,
      });
      return c.body(null, 204);
    },
  );
}
