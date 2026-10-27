import type { Context, MiddlewareHandler } from "hono";
import { createRoute, z } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";

import type { ApiEnv } from "../env";
import { ApiError, apiErrorSchema } from "../errors";
import { branchRef, engineReads, refTipMap, resolveNamedRef } from "../services/engine";
import { toContentsEntry, toPerson, base64Decode, type FileChange } from "../services/git-models";
import {
  applyFileChanges,
  defaultChangeMessage,
  editorconfigSection,
  lastCommitForPath,
  listIssueTemplates,
  resolveRawPath,
} from "../services/contents";
import {
  changeFilesOptionsSchema,
  contentsListSchema,
  contentsResponseSchema,
  createFileOptionsSchema,
  fileCommitResponseSchema,
  deleteFileOptionsSchema,
  fileDeleteResponseSchema,
  fileResponseSchema,
  filesResponseSchema,
  issueTemplateSchema,
  updateFileOptionsSchema,
  type ContentsResponse,
} from "../models/contents";
import { assertNotArchived, requireVisibleRepo } from "../services/repo-access";

/**
 * Tier-1 contents routes (SPEC-0004 §2.4 rows repoGetContentsList /
 * repoGetContents / repoCreateFile / repoUpdateFile / repoDeleteFile /
 * repoChangeFiles / repoGetRawFile / repoGetRawFileOrLFS /
 * repoGetEditorConfig / repoGetIssueTemplates — 6 paths, 10 operations).
 *
 * Reads ride the engine's content RPCs (listTree/readBlob/listLog for the
 * last-commit enrichment); writes build the commit Worker-side
 * (services/contents.applyFileChanges → putApiObjects + commitApiChange) and
 * answer the contract's FileResponse shapes.
 *
 * Upstream behavior mirrored (routers/api/v1/repo/file.go):
 *   - the UNION response: GET contents/{filepath} answers an ARRAY for a
 *     directory and an OBJECT for a file (SPEC-0004 §4 — never normalized);
 *   - the default branch is the implicit `ref` (an unresolvable ref → 404);
 *   - PUT updates when `sha` is set, CREATES when absent (200 vs 201);
 *   - DELETE answers 200 with FileDeleteResponse (not 204 — the FIXME quirk);
 *   - mutations on an archived repo → 423; missing write permission → 403
 *     "user should have a permission to write to the target branch";
 *   - raw/media resolve the legacy `{ref}/{filepath}` embedded form (the
 *     plain-hono catchalls below, outside the generated doc — the imports.ts
 *     precedent) plus the `ref` query param (the openapi route); media is
 *     LFS-aware upstream and stays a byte-for-byte raw twin here (SPEC-0006).
 *
 * Runtime-only emissions (undeclared; the orchestrator-owned
 * RUNTIME_ONLY_RESPONSES tables are not extended by this batch): 404 on the
 * reads for invisible repositories (upstream repo-group middleware).
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
  description: "validationError",
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

const refQuery = {
  ref: z.string().optional().openapi({ description: "The name of the commit/branch/tag. Default to the repository’s default branch" }),
} as const;

const bindValidationHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

type RepoPair = Awaited<ReturnType<typeof requireVisibleRepo>>;

/** Resolve the effective ref target (`ref` param or the default branch).
 *  Upstream file.go resolveRefCommit: the default branch applies ONLY to the
 *  absent param (util.IfZero); a non-empty ref that fails ResolveRefCommit's
 *  branch→tag→oid check is the APIErrorAuto 404. */
async function refTargetOf(c: Context<ApiEnv>, pair: RepoPair, refParam: string | null): Promise<string> {
  const tips = refTipMap(await engineReads(c.env, pair.repo).listRefs());
  const target =
    refParam === null || refParam === ""
      ? tips.get(branchRef(pair.repo.defaultBranch))?.target
      : resolveNamedRef(tips, refParam)?.target;
  if (target === undefined) {
    throw new ApiError(404, "The target couldn't be found.");
  }
  return target;
}

// ---------------------------------------------------------------------------
// GET payload builders (the openapi handlers wrap them in c.json; the plain
// catchalls in a raw Response)
// ---------------------------------------------------------------------------

async function renderContentsEntry(
  c: Context<ApiEnv>,
  pair: RepoPair,
  refTarget: string,
  args: { path: string; name: string; mode: string; oid: string; kind: "file" | "dir" | "symlink" | "submodule"; size: number | null; content?: Uint8Array | null; target?: string },
): Promise<ContentsResponse> {
  const lastCommit = await lastCommitForPath(engineReads(c.env, pair.repo), refTarget, args.path);
  return toContentsEntry(
    {
      path: args.path,
      name: args.name,
      mode: args.mode,
      oid: args.oid,
      type: args.kind,
      size: args.size,
      content: args.content ?? null,
      ...(lastCommit === null ? {} : { lastCommit }),
      ...(args.target === undefined ? {} : { target: args.target }),
    },
    pair,
    new URL(c.req.url).origin,
  );
}

async function contentsListPayload(c: Context<ApiEnv>, owner: string, repo: string, refParam: string | null): Promise<ContentsResponse[]> {
  const pair = await requireVisibleRepo(c, { owner, repo });
  const refTarget = await refTargetOf(c, pair, refParam);
  const tree = await engineReads(c.env, pair.repo).listTree(refTarget);
  if (tree === null) {
    throw new ApiError(404, "not found");
  }
  return Promise.all(
    tree.entries.map((entry) =>
      renderContentsEntry(c, pair, refTarget, {
        path: entry.name,
        name: entry.name,
        mode: entry.mode,
        oid: entry.oid,
        kind: entry.type === "tree" ? "dir" : entry.type === "commit" ? "submodule" : "file",
        size: entry.size ?? null,
      }),
    ),
  );
}

/** The union payload: ARRAY for a directory, OBJECT for a file (SPEC-0004 §4). */
async function contentsPayload(
  c: Context<ApiEnv>,
  owner: string,
  repo: string,
  filepath: string,
  refParam: string | null,
): Promise<ContentsResponse | ContentsResponse[]> {
  const pair = await requireVisibleRepo(c, { owner, repo });
  const refTarget = await refTargetOf(c, pair, refParam);
  const reads = engineReads(c.env, pair.repo);

  const dir = await reads.listTree(refTarget, filepath);
  if (dir !== null) {
    return Promise.all(
      dir.entries.map((entry) =>
        renderContentsEntry(c, pair, refTarget, {
          path: `${filepath}/${entry.name}`,
          name: entry.name,
          mode: entry.mode,
          oid: entry.oid,
          kind: entry.type === "tree" ? "dir" : entry.type === "commit" ? "submodule" : "file",
          size: entry.size ?? null,
        }),
      ),
    );
  }
  const blob = await reads.readBlob(refTarget, filepath);
  if (blob === null) {
    throw new ApiError(404, "The target couldn't be found.");
  }
  const kind: "file" | "symlink" | "submodule" = blob.mode === "120000" ? "symlink" : blob.mode === "160000" ? "submodule" : "file";
  const name = filepath.split("/").pop() ?? filepath;
  return renderContentsEntry(c, pair, refTarget, {
    path: filepath,
    name,
    mode: blob.mode,
    oid: blob.oid,
    kind,
    size: blob.data.byteLength,
    content: blob.data,
    ...(kind === "symlink" ? { target: new TextDecoder().decode(blob.data) } : {}),
  });
}

// ---------------------------------------------------------------------------
// Write handler (shared): POST/PUT/DELETE {filepath} + POST batch — all
// reduce to upstream ChangeRepoFiles through applyFileChanges. Returns the
// FileResponse-family payload + status for c.json.
// ---------------------------------------------------------------------------

function doerIdentity(c: Context<ApiEnv>): { name: string; email: string } {
  const doer = c.get("authUser");
  const hostname = new URL(c.req.url).hostname;
  if (doer === undefined) {
    return { name: "Gitea", email: `gitea@noreply.${hostname}` };
  }
  const email = doer.email === undefined || doer.email === "" ? `${doer.login ?? "gitea"}@noreply.${hostname}` : doer.email;
  return { name: doer.login ?? "gitea", email };
}

/** The unverified verification block every file-change response carries. */
const UNVERIFIED_COMMIT = { verified: false, reason: "gpg.error.not_signed_commit", signature: "", signer: null, payload: "" };

interface WriteOptions {
  branch?: string;
  new_branch?: string;
  message?: string;
  author?: { name?: string; email?: string } | null;
  committer?: { name?: string; email?: string } | null;
  dates?: { author?: string; committer?: string };
}

interface WriteResult {
  /** the FileCommitResponse block (fileCommitResponseSchema shape) */
  commit: z.infer<typeof fileCommitResponseSchema>;
  /** per-change contents; the single-file routes take [0], delete ignores */
  contents: Array<ContentsResponse | null>;
}

async function applyAndRespond(
  c: Context<ApiEnv>,
  owner: string,
  repo: string,
  filepath: string | null,
  options: WriteOptions,
  specs: Array<{ operation: "create" | "update" | "delete"; path?: string; content?: string; sha?: string; from_path?: string }>,
  deleted: boolean,
  status?: 200 | 201,
): Promise<WriteResult> {
  const pair = await requireVisibleRepo(c, { owner, repo });
  assertNotArchived(pair);
  const doer = doerIdentity(c);
  const changes: FileChange[] = [];
  for (const spec of specs) {
    const path = filepath ?? spec.path;
    if (path === undefined || path === "") {
      throw new ApiError(422, "path is required");
    }
    let content: Uint8Array | undefined;
    if (spec.content !== undefined) {
      try {
        content = base64Decode(spec.content);
      } catch {
        throw new ApiError(422, "invalid base64 content");
      }
    }
    changes.push({ operation: spec.operation, path, content, sha: spec.sha, fromPath: spec.from_path });
  }
  void status;
  const result = await applyFileChanges(c, pair, options, changes, {
    message:
      options.message === undefined || options.message === "" ? defaultChangeMessage(changes) : options.message,
    author: toPerson(options.author, doer.name, doer.email, options.dates?.author),
    committer: toPerson(options.committer ?? options.author, doer.name, doer.email, options.dates?.committer),
  });

  const reads = engineReads(c.env, pair.repo);
  const commit = await reads.readCommit(result.built.commitOid);
  if (commit === null) {
    throw new ApiError(500, "");
  }
  const origin = new URL(c.req.url).origin;
  const ownerEnc = encodeURIComponent(pair.repo.ownerNamespace);
  const slugEnc = encodeURIComponent(pair.repo.slug);
  const fileCommit: z.infer<typeof fileCommitResponseSchema> = {
    sha: commit.oid,
    message: commit.message,
    html_url: `${origin}/${ownerEnc}/${slugEnc}/commit/${commit.oid}`,
    url: `${origin}/api/v1/repos/${ownerEnc}/${slugEnc}/git/commits/${commit.oid}`,
    created: new Date(commit.committer.time * 1000).toISOString(),
    author: { name: commit.author.name, email: commit.author.email, date: new Date(commit.author.time * 1000).toISOString() },
    committer: { name: commit.committer.name, email: commit.committer.email, date: new Date(commit.committer.time * 1000).toISOString() },
    tree: { sha: commit.tree, url: `${origin}/api/v1/repos/${ownerEnc}/${slugEnc}/git/trees/${commit.tree}` },
    parents: commit.parents.map((oid) => ({ sha: oid, url: `${origin}/api/v1/repos/${ownerEnc}/${slugEnc}/git/commits/${oid}` })),
  };

  if (deleted) {
    return { commit: fileCommit, contents: [] };
  }

  // The changed files render from the landed ref (reads back the objects
  // putApiObjects just stored).
  const contents = await Promise.all(
    result.paths.map(async (path) => {
      const blob = await reads.readBlob(result.refTarget, path);
      if (blob === null) return null;
      const lastCommit = await lastCommitForPath(reads, result.refTarget, path);
      return toContentsEntry(
        {
          path,
          name: path.split("/").pop() ?? path,
          mode: blob.mode,
          oid: blob.oid,
          type: blob.mode === "120000" ? "symlink" : "file",
          size: blob.data.byteLength,
          content: blob.data,
          ...(lastCommit === null ? {} : { lastCommit }),
        },
        pair,
        origin,
      );
    }),
  );

  return { commit: fileCommit, contents };
}

// ---------------------------------------------------------------------------
// Raw bytes (shared by the openapi routes and the plain catchalls). The
// contract's binary response family is content-typed octet-stream, so the
// openapi handlers return the raw Response (zod-openapi maps non-json/text
// content types to a bare Response return).
// ---------------------------------------------------------------------------

async function getRawBytes(c: Context<ApiEnv>, owner: string, repo: string, rawPath: string, refParam: string | null): Promise<Response> {
  const pair = await requireVisibleRepo(c, { owner, repo });
  if (pair.repo.isEmpty) {
    throw new ApiError(404, "not found");
  }
  const reads = engineReads(c.env, pair.repo);
  const resolved = resolveRawPath(refTipMap(await reads.listRefs()), rawPath, refParam, pair.repo.defaultBranch);
  if (resolved === null || resolved.filepath === "") {
    throw new ApiError(404, "not found");
  }
  const blob = await reads.readBlob(resolved.target, resolved.filepath);
  if (blob === null) {
    throw new ApiError(404, "not found");
  }
  return new Response(new Uint8Array(blob.data), {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Gitea-Object-Type": blob.mode === "120000" ? "symlink" : "blob",
    },
  });
}

/**
 * The `IssueTemplateStringSlice` front-matter value: a YAML flow list
 * (`[bug, ui]`) or a comma-separated string — both arrive as arrays.
 */
function templateList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  const flow = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return flow
    .split(",")
    .map((part) => part.trim().replace(/^"(.*)"$/, "$1"))
    .filter((part) => part !== "");
}

/** The repo-relative tail of a plain catchall path (owner/repo may contain case). */
function tailAfter(c: Context<ApiEnv>, prefix: string): string {
  const index = c.req.path.indexOf(prefix);
  return decodeURIComponent(index < 0 ? "" : c.req.path.slice(index + prefix.length));
}

export function registerContentsRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/contents (repoGetContentsList) — array
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/contents",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "List a repo's contents for a path ref",
      operationId: "repoGetContentsList",
      request: { params: z.object(ownerRepoParams), query: z.object(refQuery) },
      responses: {
        200: { description: "ContentsListResponse", content: { "application/json": { schema: contentsListSchema } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { owner, repo } = c.req.valid("param");
      return c.json(await contentsListPayload(c, owner, repo, c.req.valid("query").ref ?? null), 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/contents/{filepath} (repoGetContents) — the
  // union: object for a file, array for a directory.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/contents/{filepath}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Gets the contents of a file or directory in a repository",
      operationId: "repoGetContents",
      request: {
        params: z.object({ ...ownerRepoParams, filepath: z.string().openapi({ description: "path of the file to get; it will be responded as a file or a directory listing" }) }),
        query: z.object(refQuery),
      },
      responses: {
        200: { description: "ContentsResponse", content: { "application/json": { schema: z.union([contentsResponseSchema, contentsListSchema]) } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { owner, repo, filepath } = c.req.valid("param");
      const payload: ContentsResponse | ContentsResponse[] = await contentsPayload(c, owner, repo, filepath, c.req.valid("query").ref ?? null);
      return c.json(payload, 200);
    },
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/contents/{filepath} (repoCreateFile) — 201
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/contents/{filepath}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Create a file in a repository",
      operationId: "repoCreateFile",
      request: {
        params: z.object({ ...ownerRepoParams, filepath: z.string().min(1).openapi({ description: "path of the file to create" }) }),
        body: { content: { "application/json": { schema: createFileOptionsSchema } } },
      },
      responses: {
        201: { description: "FileResponse", content: { "application/json": { schema: fileResponseSchema } } },
        403: forbiddenResponse,
        404: notFoundResponse,
        422: validationErrorResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const { owner, repo, filepath } = c.req.valid("param");
      const form = c.req.valid("json");
      const result = await applyAndRespond(c, owner, repo, filepath, form, [{ operation: "create", content: form.content }], false);
      return c.json({ commit: result.commit, content: result.contents[0] ?? null, verification: UNVERIFIED_COMMIT }, 201);
    },
    bindValidationHook,
  );

  // -------------------------------------------------------------------------
  // PUT /repos/{owner}/{repo}/contents/{filepath} (repoUpdateFile) — updates
  // when `sha` is set (200), creates when absent (201).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "put",
      path: "/repos/{owner}/{repo}/contents/{filepath}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Update a file in a repository if SHA is set, or create the file if SHA is not set",
      operationId: "repoUpdateFile",
      request: {
        params: z.object({ ...ownerRepoParams, filepath: z.string().min(1).openapi({ description: "path of the file to update" }) }),
        body: { content: { "application/json": { schema: updateFileOptionsSchema } } },
      },
      responses: {
        200: { description: "FileResponse", content: { "application/json": { schema: fileResponseSchema } } },
        201: { description: "FileResponse", content: { "application/json": { schema: fileResponseSchema } } },
        403: forbiddenResponse,
        404: notFoundResponse,
        422: validationErrorResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const { owner, repo, filepath } = c.req.valid("param");
      const form = c.req.valid("json");
      const updating = form.sha !== undefined && form.sha !== "";
      const result = await applyAndRespond(c, owner, repo, filepath, form, [{ operation: updating ? "update" : "create", content: form.content, sha: form.sha, from_path: form.from_path }], false);
      const payload = { commit: result.commit, content: result.contents[0] ?? null, verification: UNVERIFIED_COMMIT };
      return updating ? c.json(payload, 200) : c.json(payload, 201);
    },
    bindValidationHook,
  );

  // -------------------------------------------------------------------------
  // DELETE /repos/{owner}/{repo}/contents/{filepath} (repoDeleteFile) — 200
  // with FileDeleteResponse (not 204 — the upstream FIXME quirk).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/repos/{owner}/{repo}/contents/{filepath}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Delete a file in a repository",
      operationId: "repoDeleteFile",
      request: {
        params: z.object({ ...ownerRepoParams, filepath: z.string().min(1).openapi({ description: "path of the file to delete" }) }),
        body: { content: { "application/json": { schema: deleteFileOptionsSchema } } },
      },
      responses: {
        200: { description: "FileDeleteResponse", content: { "application/json": { schema: fileDeleteResponseSchema } } },
        400: validationErrorResponse,
        403: forbiddenResponse,
        404: notFoundResponse,
        422: validationErrorResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const { owner, repo, filepath } = c.req.valid("param");
      const form = c.req.valid("json");
      const result = await applyAndRespond(c, owner, repo, filepath, form, [{ operation: "delete", sha: form.sha }], true);
      return c.json({ commit: result.commit, content: null, verification: UNVERIFIED_COMMIT }, 200);
    },
    bindValidationHook,
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/contents (repoChangeFiles) — the batch body.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/contents",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Modify multiple files in a repository",
      operationId: "repoChangeFiles",
      request: {
        params: z.object(ownerRepoParams),
        body: { content: { "application/json": { schema: changeFilesOptionsSchema } } },
      },
      responses: {
        201: { description: "FilesResponse", content: { "application/json": { schema: filesResponseSchema } } },
        403: forbiddenResponse,
        404: notFoundResponse,
        422: validationErrorResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const { owner, repo } = c.req.valid("param");
      const form = c.req.valid("json");
      const result = await applyAndRespond(c, owner, repo, null, form, form.files, false);
      return c.json({ commit: result.commit, files: result.contents.filter((entry) => entry !== null), verification: UNVERIFIED_COMMIT }, 201);
    },
    bindValidationHook,
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/raw/{filepath} (repoGetRawFile) — raw bytes.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/raw/{filepath}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get a file from a repository",
      operationId: "repoGetRawFile",
      request: {
        params: z.object({ ...ownerRepoParams, filepath: z.string().openapi({ description: "path of the file to get, it should be \"{ref}/{filepath}\". If there is no ref could be inferred, it will be treated as the default branch" }) }),
        query: z.object(refQuery),
      },
      responses: {
        200: { description: "Returns raw file content.", content: { "application/octet-stream": { schema: z.string() } } },
        404: notFoundResponse,
      },
    }),
    (c) => {
      const { owner, repo, filepath } = c.req.valid("param");
      return getRawBytes(c, owner, repo, filepath, c.req.valid("query").ref ?? null);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/media/{filepath} (repoGetRawFileOrLFS) — the
  // raw-or-LFS twin; byte-identical pre-LFS (SPEC-0006 resolves pointers).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/media/{filepath}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get a file or it's LFS object from a repository",
      operationId: "repoGetRawFileOrLFS",
      request: {
        params: z.object({ ...ownerRepoParams, filepath: z.string().openapi({ description: "path of the file to get, it should be \"{ref}/{filepath}\". If there is no ref could be inferred, it will be treated as the default branch" }) }),
        query: z.object(refQuery),
      },
      responses: {
        200: { description: "Returns raw file content.", content: { "application/octet-stream": { schema: z.string() } } },
        404: notFoundResponse,
      },
    }),
    (c) => {
      const { owner, repo, filepath } = c.req.valid("param");
      return getRawBytes(c, owner, repo, filepath, c.req.valid("query").ref ?? null);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/editorconfig/{filepath} (repoGetEditorConfig)
  // — the matching section's key-values (upstream renders the JSON map; the
  // frozen fixture models the 200 schema-less, so the compat suite drives the
  // 404 case only).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/editorconfig/{filepath}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get the EditorConfig definitions of a file in a repository",
      operationId: "repoGetEditorConfig",
      request: {
        params: z.object({ ...ownerRepoParams, filepath: z.string().min(1).openapi({ description: "filepath of file to get" }) }),
        query: z.object(refQuery),
      },
      responses: {
        200: { description: "success", content: { "application/json": { schema: z.record(z.string(), z.string()) } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { owner, repo, filepath } = c.req.valid("param");
      const pair = await requireVisibleRepo(c, { owner, repo });
      const reads = engineReads(c.env, pair.repo);
      const refTarget = await refTargetOf(c, pair, c.req.valid("query").ref ?? null);
      const blob = await reads.readBlob(refTarget, ".editorconfig");
      if (blob === null) {
        throw new ApiError(404, "not found");
      }
      const section = editorconfigSection(new TextDecoder().decode(blob.data), filepath);
      if (section === null) {
        throw new ApiError(404, "not found");
      }
      return c.json(section, 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/issue_templates (repoGetIssueTemplates)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/issue_templates",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get an issue templates of a repository",
      operationId: "repoGetIssueTemplates",
      request: { params: z.object(ownerRepoParams), query: z.object(refQuery) },
      responses: {
        200: { description: "IssueTemplates", content: { "application/json": { schema: z.array(issueTemplateSchema) } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { owner, repo } = c.req.valid("param");
      const pair = await requireVisibleRepo(c, { owner, repo });
      const reads = engineReads(c.env, pair.repo);
      const refTarget = await refTargetOf(c, pair, c.req.valid("query").ref ?? null);
      const templates = await listIssueTemplates(reads, refTarget);
      return c.json(
        templates.map((template) => ({
          file_name: template.fileName,
          name: template.frontMatter.name ?? null,
          about: template.frontMatter.about ?? template.frontMatter.description ?? null,
          title: template.frontMatter.title ?? null,
          ref: template.frontMatter.ref ?? null,
          labels: templateList(template.frontMatter.labels),
          assignees: templateList(template.frontMatter.assignees),
          content: template.content === "" ? null : template.content,
        })),
        200,
      );
    },
  );

  // -------------------------------------------------------------------------
  // Plain-hono catchalls OUTSIDE the generated doc (imports.ts precedent):
  // the multi-segment legacy forms the zod-openapi single-param routes cannot
  // match. The openapi routes win their shared single-segment requests by
  // registration order; these only answer the leftovers.
  // -------------------------------------------------------------------------
  app.get("/repos/:owner/:repo/contents/*", (c) => {
    const { owner, repo } = c.req.param();
    return contentsPayload(c, owner, repo, tailAfter(c, `/${owner}/${repo}/contents/`), c.req.query("ref") ?? null).then(
      (payload) => c.json(payload, 200),
    );
  });
  app.get("/repos/:owner/:repo/raw/*", (c) => {
    const { owner, repo } = c.req.param();
    return getRawBytes(c, owner, repo, tailAfter(c, `/${owner}/${repo}/raw/`), c.req.query("ref") ?? null);
  });
  app.get("/repos/:owner/:repo/media/*", (c) => {
    const { owner, repo } = c.req.param();
    return getRawBytes(c, owner, repo, tailAfter(c, `/${owner}/${repo}/media/`), c.req.query("ref") ?? null);
  });
}
