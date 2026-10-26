import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";

import { RepoNameCollisionError, RepoNameInvalidError } from "../../repos/service";
import { OrgService } from "../../services/orgs/orgs";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { repositorySchema } from "../models/repository";
import { generateOptionSelected, generateRepoFromTemplate, type GenerateRepoForm } from "../services/generate-repo";
import {
  canViewRepositoryWithTeams,
  findRepositoryByPath,
  findUserByName,
  toApiRepository,
  viewerOf,
} from "../services/repository";

/**
 * `POST /repos/{template_owner}/{template_repo}/generate` (generateRepo —
 * long-tail batch; the service half is api/services/generate-repo.ts, the
 * content copy rides the fork machinery's replicateRepoCopy pass). Upstream
 * handler: routers/api/v1/repo/repo.go:311-413 (Generate), mounted inside
 * the reqToken'd repo group with repoAssignment on the TEMPLATE.
 *
 * Guard order (upstream-exact):
 *   1. 404 anti-enumeration when the template is missing/invisible
 *      (repoAssignment + reqRepoReader);
 *   2. 422 "this is not a template repo" when `IsTemplate` is false
 *      (repo.go:343-346 — upstream uses UNPROCESSABLE here, not the 403 the
 *      summary implies);
 *   3. 422 "not allowed creating repository for organization" when the DOER
 *      is an org row (repo.go:348-351);
 *   4. 422 "must select at least one template item" when every
 *      GenerateRepoOption unit is false (repo.go:367-371 — IsValid);
 *   5. owner resolution (repo.go:373-398): absent or the doer's own name →
 *      the doer; otherwise GetUserByName — miss → 404
 *      {error: "request owner `x` does not exist"} (upstream's raw JSON
 *      body, NOT the {message,url} envelope); an individual target needs
 *      site admin (403 "Only admin can generate repository for other
 *      user."); an org target needs the create-repo grant (403 "Given user
 *      is not allowed to create repository in organization.");
 *   6. 409 "The repository with the same name already exists." /
 *      422 err.Error() from the create (repo.go:400-409).
 *
 * The response is 201 with the created Repository (the contract; upstream
 * GenerateRepository is synchronous — ours replicates the git content
 * inline on the same wall-clock-unlimited request, so the body describes a
 * ready repo; api/services/generate-repo.ts documents the copy-level
 * divergences: no variable substitution, full-ref copy, inert non-git
 * units).
 *
 * Declared responses mirror the contract exactly: {201,403,404,409,422}.
 * The 401 arm (reqToken) is runtime-only, as is the 422 a malformed body
 * gets before route mapping (the bindValidationHook texts).
 */

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

/** Body bind hook (Go bind parity; the contract declares 422). */
const bindValidationHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

/**
 * Mirror of the frozen contract's GenerateRepoOption — field-for-field
 * (`required: [owner, name]` is the CONTRACT's body-level requirement on
 * owner; upstream's handler reads the same struct with owner optional at
 * the type level and `form.Owner != ctxUser.Name` deciding the lookup —
 * the zod schema keeps owner optional so a body without it generates for
 * the doer, matching the handler, while the contract's required-marker
 * stays a documented looseness).
 */
const generateRepoOptionSchema = z.object({
  owner: z.string().optional().openapi({ description: "the organization's name or individual user's name who will own the new repository" }),
  name: z.string().openapi({ description: "name of the repository to create" }),
  default_branch: z.string().optional().openapi({ description: "Default branch of the new repository" }),
  description: z.string().optional().openapi({ description: "Description of the repository to create" }),
  private: z.boolean().optional().openapi({ description: "Whether the repository is private" }),
  git_content: z.boolean().optional().openapi({ description: "include git content of default branch in template repo" }),
  git_hooks: z.boolean().optional().openapi({ description: "include git hooks in template repo" }),
  webhooks: z.boolean().optional().openapi({ description: "include webhooks in template repo" }),
  topics: z.boolean().optional().openapi({ description: "include topics in template repo" }),
  avatar: z.boolean().optional().openapi({ description: "include avatar of the template repo" }),
  labels: z.boolean().optional().openapi({ description: "include labels in template repo" }),
  protected_branch: z.boolean().optional().openapi({ description: "include protected branches in template repo" }),
});

/**
 * The owner-resolution arm (repo.go:373-398) — returns the target owner or
 * answers the request itself (the 404 {error} body). Doer re-read mirrors
 * forks.ts: the token identity is only trusted after the D1 row confirms.
 */
async function resolveTargetOwner(
  c: Context<ApiEnv>,
  doer: { id: number; username: string; isAdmin: boolean },
  form: GenerateRepoForm,
): Promise<{ id: number; usernameLower: string } | Response> {
  const ownerName = form.owner ?? doer.username;
  if (ownerName === doer.username) {
    return { id: doer.id, usernameLower: doer.username.toLowerCase() };
  }
  const target = await findUserByName(c.env.DB, ownerName);
  if (target === null) {
    // Upstream's raw JSON 404 (repo.go:381-387) — NOT the {message,url}
    // envelope; kept byte-faithful.
    return c.json({ error: `request owner \`${ownerName}\` does not exist` }, 404);
  }
  if (!doer.isAdmin) {
    if (target.type !== "org") {
      throw new ApiError(403, "Only admin can generate repository for other user.");
    }
    if (!(await new OrgService(c.env.DB).canCreateOrgRepo(target.id, doer.id))) {
      throw new ApiError(403, "Given user is not allowed to create repository in organization.");
    }
  }
  return { id: target.id, usernameLower: target.usernameLower };
}

export function registerGenerateRepoRoute(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
): void {
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{template_owner}/{template_repo}/generate",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Create a repository using a template",
      operationId: "generateRepo",
      request: {
        params: z.object({
          template_owner: z.string().min(1).openapi({ description: "owner of the template repository" }),
          template_repo: z.string().min(1).openapi({ description: "name of the template repository" }),
        }),
        body: { content: { "application/json": { schema: generateRepoOptionSchema } } },
      },
      responses: {
        201: { description: "Repository", content: { "application/json": { schema: repositorySchema } } },
        403: forbiddenResponse,
        // The 404 carries two runtime bodies (the plain anti-enum envelope
        // for a missing template; upstream's raw {error} for a missing
        // owner — see resolveTargetOwner), so the schema stays unpinned.
        404: { description: "notFound" },
        409: { description: "The repository with the same name already exists." },
        422: validationErrorResponse,
      },
    }),
    async (c) => {
      const { template_owner, template_repo } = c.req.valid("param");
      const doerIdentity = c.get("authUser");
      const template = await findRepositoryByPath(c.env.DB, template_owner, template_repo);
      const viewer = viewerOf(c);
      if (
        template === null ||
        !(await canViewRepositoryWithTeams(c.env.DB, viewer, template.repo))
      ) {
        throw new ApiError(404, "not found"); // the reqRepoReader anti-enum arm
      }
      const doerRow =
        doerIdentity.id === undefined || doerIdentity.login === undefined
          ? null
          : await findUserByName(c.env.DB, doerIdentity.login);
      if (doerRow === null) {
        throw new ApiError(401, "token is required"); // the silent-auth-failure convention
      }

      // Guard order per the module header (repo.go:343-371).
      if (template.repo.isTemplate !== true) {
        throw new ApiError(422, "this is not a template repo");
      }
      if (doerRow.type === "org") {
        throw new ApiError(422, "not allowed creating repository for organization");
      }
      const form: GenerateRepoForm = c.req.valid("json");
      if (!generateOptionSelected(form)) {
        throw new ApiError(422, "must select at least one template item");
      }

      const owner = await resolveTargetOwner(c, { id: doerRow.id, username: doerRow.username, isAdmin: doerRow.isAdmin }, form);
      if (owner instanceof Response) {
        return owner;
      }

      const { repo } = await generateRepoFromTemplate(c.env, { template, targetOwner: owner, form }).catch(
        (error: unknown) => {
          if (error instanceof RepoNameCollisionError) {
            throw new ApiError(409, "The repository with the same name already exists.");
          }
          if (error instanceof RepoNameInvalidError) {
            // upstream 422s err.Error() for reserved/pattern violations; our
            // ported message text differs from Go's error strings (forks.ts
            // divergence note).
            throw new ApiError(422, error.message);
          }
          throw error;
        },
      );

      const pair = await findRepositoryByPath(c.env.DB, repo.ownerNamespace, repo.slug);
      if (pair === null) {
        throw new ApiError(500, "generated repo row vanished after creation");
      }
      return c.json(toApiRepository(viewer, pair), 201);
    },
    bindValidationHook,
  );
}
