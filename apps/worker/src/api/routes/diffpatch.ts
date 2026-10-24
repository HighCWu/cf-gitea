/**
 * POST /repos/{owner}/{repo}/diffpatch (repoApplyDiffPatch — SPEC-0004 §2.4
 * row): apply a unified diff as one commit. Upstream
 * routers/api/v1/repo/patch.go ApplyDiffPatch runs `git apply --index …` in a
 * temporary clone and commits the resulting tree; here the patch applies
 * Worker-side (services/diffpatch.ts parse + hunk applier) into the same
 * FileChange list the contents-write family feeds to applyFileChanges
 * (buildFileChangeCommit → putApiObjects → commitApiChange), so the commit
 * lands through the identical all-or-nothing seam (SPEC-0004 §3.4).
 *
 * Mirrored upstream behavior:
 *   - the default base branch is the repository default; `new_branch`
 *     commits onto a fresh ref created from the base (applyFileChanges'
 *     branch/new_branch mapping); `branch` must exist (404 family, the
 *     ErrBranchNotExist of patch.go Validate);
 *   - the commit message defaults to "apply-patch"
 *     (util.IfZero(apiOpts.Message, "apply-patch"));
 *   - author/committer: the body identities, falling back to the doer
 *     (the contract's own note on ApplyDiffPatchFileOptions);
 *   - archived repositories refuse with the declared 423 (MustNotBeArchived);
 *   - the response is the FileResponse {commit, verification} — `content`
 *     marshals null upstream (no single file to render).
 *
 * Documented divergences (the fixture pins the contract's 200):
 *   - status: upstream's code answers 201 for this POST while the vendored
 *     contract declares 200 — the contract shape is served here (a 201 would
 *     be neither fixture-declared nor a documented runtime-only response).
 *   - an unapplicable patch answers 422 "patch does not apply"; upstream's
 *     git-apply failure surfaces as a 500 (handleChangeRepoFilesError has no
 *     apply-failure mapping). 422 is the declared-on-siblings validation
 *     code; 422/400 runtime emissions stay in the undeclared runtime-only
 *     class the orchestrator's tables own.
 *   - binary patches / mode changes are refused (422) — upstream applies
 *     binaries via --binary.
 *
 * Auth: requireAuth (the write-family stand-in for upstream's
 * reqRepoWriter + doer identity; hooks-routes convention).
 */

import type { Context, MiddlewareHandler } from "hono";
import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";

import type { ApiEnv } from "../env";
import { ApiError, apiErrorSchema } from "../errors";
import { applyDiffPatchFileOptionsSchema } from "../models/diffpatch";
import { fileCommitResponseSchema, fileResponseSchema } from "../models/contents";
import { engineReads } from "../services/engine";
import { applyFileChanges } from "../services/contents";
import { patchToFileChanges } from "../services/diffpatch";
import { toPerson } from "../services/git-models";
import { assertNotArchived, canWriteRepository, requireVisibleRepo } from "../services/repo-access";

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const repoArchivedResponse = {
  description: "repoArchivedError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const bindValidationHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

/** The doer identity fallback (the contents-route convention). */
function doerIdentity(c: Context<ApiEnv>): { name: string; email: string } {
  const doer = c.get("authUser");
  const hostname = new URL(c.req.url).hostname;
  if (doer === undefined) {
    return { name: "Gitea", email: `gitea@noreply.${hostname}` };
  }
  const email = doer.email === undefined || doer.email === "" ? `${doer.login ?? "gitea"}@noreply.${hostname}` : doer.email;
  return { name: doer.login ?? "gitea", email };
}

export function registerDiffPatchRoutes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
): void {
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/diffpatch",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Apply diff patch to repository",
      operationId: "repoApplyDiffPatch",
      request: {
        params: z.object({
          owner: z.string().min(1).openapi({ description: "owner of the repo" }),
          repo: z.string().min(1).openapi({ description: "name of the repo" }),
        }),
        body: { content: { "application/json": { schema: applyDiffPatchFileOptionsSchema } } },
      },
      responses: {
        200: { description: "FileResponse", content: { "application/json": { schema: fileResponseSchema } } },
        404: notFoundResponse,
        423: repoArchivedResponse,
      },
    }),
    async (c) => {
      const { owner, repo } = c.req.valid("param");
      const form = c.req.valid("json");
      const pair = await requireVisibleRepo(c, { owner, repo });
      assertNotArchived(pair);
      if (!(await canWriteRepository(c, pair))) {
        throw new ApiError(403, "user should have a permission to write to the target branch");
      }

      const reads = engineReads(c.env, pair.repo);
      // the base tip the patch applies against: branch (or the default branch)
      const baseBranch = form.branch === undefined || form.branch === "" ? pair.repo.defaultBranch : form.branch;
      const tips = await reads.listRefs();
      const baseTip = tips?.refs.find((ref) => ref.name === `refs/heads/${baseBranch}`)?.target;
      if (baseTip === undefined) {
        throw new ApiError(404, `branch does not exist [name: ${baseBranch}]`);
      }

      const changes = await patchToFileChanges(reads, baseTip, form.content);
      const identity = doerIdentity(c);
      // upstream TrimSpaces the message at commit time (gitPatchCommitPush)
      const message = (form.message === undefined || form.message === "" ? "apply-patch" : form.message).trim();
      const result = await applyFileChanges(c, pair, { branch: form.branch, new_branch: form.new_branch }, changes, {
        message,
        author: toPerson(form.author, identity.name, identity.email, form.dates?.author),
        committer: toPerson(form.committer ?? form.author, identity.name, identity.email, form.dates?.committer),
      });

      const commit = await reads.readCommit(result.refTarget);
      if (commit === null) {
        throw new ApiError(500, "");
      }
      const origin = new URL(c.req.url).origin;
      const ownerEnc = encodeURIComponent(pair.repo.ownerNamespace);
      const slugEnc = encodeURIComponent(pair.repo.slug);
      return c.json(
        {
          commit: {
            sha: commit.oid,
            message: commit.message.trim(),
            html_url: `${origin}/${ownerEnc}/${slugEnc}/commit/${commit.oid}`,
            url: `${origin}/api/v1/repos/${ownerEnc}/${slugEnc}/git/commits/${commit.oid}`,
            created: new Date(commit.committer.time * 1000).toISOString(),
            author: { name: commit.author.name, email: commit.author.email, date: new Date(commit.author.time * 1000).toISOString() },
            committer: { name: commit.committer.name, email: commit.committer.email, date: new Date(commit.committer.time * 1000).toISOString() },
            tree: { sha: commit.tree, url: `${origin}/api/v1/repos/${ownerEnc}/${slugEnc}/git/trees/${commit.tree}` },
            parents: commit.parents.map((oid) => ({ sha: oid, url: `${origin}/api/v1/repos/${ownerEnc}/${slugEnc}/git/commits/${oid}` })),
          } satisfies z.infer<typeof fileCommitResponseSchema>,
          content: null,
          verification: { verified: false, reason: "gpg.error.not_signed_commit", signature: "", signer: null, payload: "" },
        },
        200,
      );
    },
    bindValidationHook,
  );
}
