import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";

import type { ApiEnv } from "../env";
import { ApiError, apiErrorSchema } from "../errors";
import { requireRepoAdmin, requireVisibleRepo } from "../services/repo-access";

/**
 * The server-side git-hooks API family (remaining-API inventory §repository
 * RUNTIME-ONLY batch — `wave-api-git-hooks`; 4 table-free operations over the
 * repositories we already serve). Upstream ports:
 *
 *   - handlers  routers/api/v1/repo/git_hook.go (ListGitHooks / GetGitHook /
 *               EditGitHook / DeleteGitHook; group mounted at
 *               routers/api/v1/api.go:1269-1277 with
 *               `reqToken(), reqAdmin(), reqGitHook(), ReferencesGitRepo(true)`);
 *   - model     gitea/modules/git/hook.go (hookNames vocabulary, GetHook /
 *               Update / ListHooks — the filesystem read/write of
 *               `hooks/<name>` plus the `hooks/<name>.sample` fallback);
 *   - converter services/convert/convert.go ToGitHook (Name/IsActive/Content
 *               straight off the struct, structs/git_hook.go — `content`
 *               carries Go's omitempty).
 *
 * R2 layout (the avatars precedent — services/avatars.ts — one bucket, a
 * per-feature key prefix, the storage-service boundary rule of AGENTS.md;
 * no table, no migration):
 *
 *   githooks/<repositories.id>/<hook_name>   — one text object per hook that
 *               has a PERSISTED EDIT (the port of the active hook file
 *               `<repo>/hooks/<name>`); its absence is the port of the
 *               inactive state (file removed, upstream hook.go Update()'s
 *               empty-content arm).
 *
 * The honest degenerate surface, documented divergences:
 *
 *   1. SAMPLES VERBATIM — upstream's API returns `content: ""` for inactive
 *      hooks (the `.sample` text only reaches the web edit form's textarea,
 *      gitea/templates/repo/settings/githook_edit.tmpl); cf-gitea has no
 *      filesystem to read `<repo>/hooks/<name>.sample` from, so GET/LIST
 *      surface the sample text VERBATIM as `content` for hooks without a
 *      persisted edit — the same data the upstream editor would pre-fill.
 *      `is_active` stays the truthful enabled/disabled signal.
 *   2. SAMPLE SET — upstream reads the samples the host `git init` template
 *      dir materialized. The samples below are git's canonical template
 *      content (verified byte-identical against the git 2.43
 *      /usr/share/git-core/templates/hooks/ set): modern git ships
 *      pre-receive.sample and update.sample only — there is NO
 *      post-receive.sample any more, so the post-receive sample is the empty
 *      string and `content` is OMITTED for an inactive post-receive (matching
 *      what upstream renders on a current host).
 *   3. EDIT QUIRK PORTED — upstream Update() strips `\r` for the file it
 *      writes but leaves `h.Content` (the PATCH response body) with the form
 *      text verbatim (gitea/modules/git/hook.go:88) — a later GET then reads
 *      the stripped file back. Ported exactly: PATCH answers the form
 *      content as-sent; the R2 object (and every later GET) carries the
 *      `\r`-stripped copy.
 *   4. reqGitHook NOT PORTED — upstream chains `reqGitHook()`
 *      (CanEditGitHook = !DisableGitHooks && (IsAdmin || AllowGitHook),
 *      models/user/user.go:306-308, 403 "must be allowed to edit Git hooks")
 *      AFTER reqAdmin. The per-user `allow_git_hook` flag has no column and
 *      there is no settings model (table-free batch), so the landed gate is
 *      the repo-admin class only (requireRepoAdmin — `reqAdmin`'s exact 403
 *      text); every repo admin passes where upstream would demand the site
 *      flag too. Gate ORDER follows the landed families
 *      (requireVisibleRepo's anti-enumeration 404 BEFORE the 403 — the
 *      tag-protections batch convention; upstream's middleware order would
 *      403 first).
 *   5. RUNTIME-ONLY codes the handlers can emit that the vendored contract
 *      omits (declared sets mirror the contract exactly: list/get/patch
 *      {200|204 + 404} shapes below): 401 on every op (upstream reqToken)
 *      and 403 for the non-admin gate (reqAdmin) — the orchestrator-owned
 *      RUNTIME_ONLY_RESPONSES table carries them, this module does not
 *      declare them.
 *
 * DELETE has no 404 arm for a VALID hook name (upstream GetHook succeeds via
 * the sample fallback even when the hook file is absent, then Update()
 * removes nothing): only an unknown id 404s (ErrNotValidHook →
 * APIErrorNotFound — the plain shared 404, services/context/api.go:137).
 */

/** The hook vocabulary — `hookNames` (gitea/modules/git/hook.go:19-23). */
export const GIT_HOOK_NAMES = ["pre-receive", "update", "post-receive"] as const;

export type GitHookName = (typeof GIT_HOOK_NAMES)[number];

/**
 * git's canonical hook samples (divergence note 2): the `hooks/<name>.sample`
 * content upstream reads through `git init`'s template materialization.
 * Byte-verbatim from the git 2.43 template set; `${` escapes are shell
 * parameter expansions, not interpolations.
 */

/** templates/hooks/pre-receive.sample (git 2.43). */
export const PRE_RECEIVE_SAMPLE = `#!/bin/sh
#
# An example hook script to make use of push options.
# The example simply echoes all push options that start with 'echoback='
# and rejects all pushes when the "reject" push option is used.
#
# To enable this hook, rename this file to "pre-receive".

if test -n "$GIT_PUSH_OPTION_COUNT"
then
	i=0
	while test "$i" -lt "$GIT_PUSH_OPTION_COUNT"
	do
		eval "value=\\$GIT_PUSH_OPTION_$i"
		case "$value" in
		echoback=*)
			echo "echo from the pre-receive-hook: \${value#*=}" >&2
			;;
		reject)
			exit 1
		esac
		i=$((i + 1))
	done
fi
`;

/** templates/hooks/update.sample (git 2.43). */
export const UPDATE_SAMPLE = `#!/bin/sh
#
# An example hook script to block unannotated tags from entering.
# Called by "git receive-pack" with arguments: refname sha1-old sha1-new
#
# To enable this hook, rename this file to "update".
#
# Config
# ------
# hooks.allowunannotated
#   This boolean sets whether unannotated tags will be allowed into the
#   repository.  By default they won't be.
# hooks.allowdeletetag
#   This boolean sets whether deleting tags will be allowed in the
#   repository.  By default they won't be.
# hooks.allowmodifytag
#   This boolean sets whether a tag may be modified after creation. By default
#   it won't be.
# hooks.allowdeletebranch
#   This boolean sets whether deleting branches will be allowed in the
#   repository.  By default they won't be.
# hooks.denycreatebranch
#   This boolean sets whether remotely creating branches will be denied
#   in the repository.  By default this is allowed.
#

# --- Command line
refname="$1"
oldrev="$2"
newrev="$3"

# --- Safety check
if [ -z "$GIT_DIR" ]; then
	echo "Don't run this script from the command line." >&2
	echo " (if you want, you could supply GIT_DIR then run" >&2
	echo "  $0 <ref> <oldrev> <newrev>)" >&2
	exit 1
fi

if [ -z "$refname" -o -z "$oldrev" -o -z "$newrev" ]; then
	echo "usage: $0 <ref> <oldrev> <newrev>" >&2
	exit 1
fi

# --- Config
allowunannotated=$(git config --type=bool hooks.allowunannotated)
allowdeletebranch=$(git config --type=bool hooks.allowdeletebranch)
denycreatebranch=$(git config --type=bool hooks.denycreatebranch)
allowdeletetag=$(git config --type=bool hooks.allowdeletetag)
allowmodifytag=$(git config --type=bool hooks.allowmodifytag)

# check for no description
projectdesc=$(sed -e '1q' "$GIT_DIR/description")
case "$projectdesc" in
"Unnamed repository"* | "")
	echo "*** Project description file hasn't been set" >&2
	exit 1
	;;
esac

# --- Check types
# if $newrev is 0000...0000, it's a commit to delete a ref.
zero=$(git hash-object --stdin </dev/null | tr '[0-9a-f]' '0')
if [ "$newrev" = "$zero" ]; then
	newrev_type=delete
else
	newrev_type=$(git cat-file -t $newrev)
fi

case "$refname","$newrev_type" in
	refs/tags/*,commit)
		# un-annotated tag
		short_refname=\${refname##refs/tags/}
		if [ "$allowunannotated" != "true" ]; then
			echo "*** The un-annotated tag, $short_refname, is not allowed in this repository" >&2
			echo "*** Use 'git tag [ -a | -s ]' for tags you want to propagate." >&2
			exit 1
		fi
		;;
	refs/tags/*,delete)
		# delete tag
		if [ "$allowdeletetag" != "true" ]; then
			echo "*** Deleting a tag is not allowed in this repository" >&2
			exit 1
		fi
		;;
	refs/tags/*,tag)
		# annotated tag
		if [ "$allowmodifytag" != "true" ] && git rev-parse $refname > /dev/null 2>&1
		then
			echo "*** Tag '$refname' already exists." >&2
			echo "*** Modifying a tag is not allowed in this repository." >&2
			exit 1
		fi
		;;
	refs/heads/*,commit)
		# branch
		if [ "$oldrev" = "$zero" -a "$denycreatebranch" = "true" ]; then
			echo "*** Creating a branch is not allowed in this repository" >&2
			exit 1
		fi
		;;
	refs/heads/*,delete)
		# delete branch
		if [ "$allowdeletebranch" != "true" ]; then
			echo "*** Deleting a branch is not allowed in this repository" >&2
			exit 1
		fi
		;;
	refs/remotes/*,commit)
		# tracking branch
		;;
	refs/remotes/*,delete)
		# delete tracking branch
		if [ "$allowdeletebranch" != "true" ]; then
			echo "*** Deleting a tracking branch is not allowed in this repository" >&2
			exit 1
		fi
		;;
	*)
		# Anything else (is there anything else?)
		echo "*** Update hook: unknown type of update to ref $refname of type $newrev_type" >&2
		exit 1
		;;
esac

# --- Finished
exit 0
`;

/** templates/hooks/post-receive.sample — modern git ships none (divergence 2). */
export const POST_RECEIVE_SAMPLE = "";

/** The name → sample table, in the LIST order (hookNames order upstream). */
export const GIT_HOOK_SAMPLES: Record<GitHookName, string> = {
  "pre-receive": PRE_RECEIVE_SAMPLE,
  update: UPDATE_SAMPLE,
  "post-receive": POST_RECEIVE_SAMPLE,
};

/** Repositories.id shape gate — both key segments are format-checked so the
 *  `githooks/` prefix can never be escaped (the avatars.ts discipline). */
const REPO_ID_RE = /^[A-Za-z0-9_-]+$/;

/**
 * IsValidHookName (gitea/modules/git/hook.go:29-31): the exact vocabulary
 * check — anything else is ErrNotValidHook → the plain shared 404.
 */
export function asGitHookName(id: string): GitHookName | null {
  return (GIT_HOOK_NAMES as readonly string[]).includes(id) ? (id as GitHookName) : null;
}

/** The R2 object key (module header layout). */
function gitHookKey(repoId: string, name: GitHookName): string {
  if (!REPO_ID_RE.test(repoId)) {
    throw new Error(`invalid repo id for a git-hook key: ${repoId}`);
  }
  return `githooks/${repoId}/${name}`;
}

/** The stored (persisted) hook content, or null when the hook is inactive. */
async function readGitHook(bucket: R2Bucket, repoId: string, name: GitHookName): Promise<string | null> {
  const object = await bucket.get(gitHookKey(repoId, name));
  return object === null ? null : await object.text();
}

/** hook.Update()'s write arm (hook.go:83-93): `\r` stripped for the stored copy. */
async function storeGitHook(bucket: R2Bucket, repoId: string, name: GitHookName, content: string): Promise<void> {
  await bucket.put(gitHookKey(repoId, name), content.replaceAll("\r", ""), {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
}

/** hook.Update()'s empty-content arm: "empty content means to remove the
 *  file" (hook.go:74-82) — the R2 delete of an absent key is a no-op. */
async function clearGitHook(bucket: R2Bucket, repoId: string, name: GitHookName): Promise<void> {
  await bucket.delete(gitHookKey(repoId, name));
}

/** The rendered GitHook (ToGitHook, convert.go:899-904) with the sample
 *  divergence: inactive hooks render the embedded sample as `content`
 *  (omitted when the sample is empty — Go's omitempty). */
function renderGitHook(name: GitHookName, stored: string | null): {
  name: string;
  is_active: boolean;
  content?: string;
} {
  if (stored !== null) {
    return { name, is_active: true, content: stored };
  }
  const sample = GIT_HOOK_SAMPLES[name];
  return sample === "" ? { name, is_active: false } : { name, is_active: false, content: sample };
}

// ---------------------------------------------------------------------------
// Wire schemas (route-local: the module owns its contract shapes).
// ---------------------------------------------------------------------------

/** GitHook (structs/git_hook.go:7-14) — `content` is omitempty upstream and
 *  the contract declares no required fields. */
export const gitHookSchema = z.object({
  name: z.string().openapi({ description: "Name is the name of the Git hook" }),
  is_active: z.boolean().openapi({ description: "IsActive indicates if the hook is active" }),
  content: z.string().optional().openapi({ description: "Content contains the script content of the hook" }),
});

/** EditGitHookOption (structs/git_hook.go:20-23) — a plain (non-pointer)
 *  string: an absent field binds to Go's zero "" (the remove arm). */
const editGitHookOptionSchema = z.object({
  content: z.string().optional().openapi({ description: "Content is the new script content for the hook" }),
});

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

/** The {id} path param — a plain string in the contract; a non-vocabulary
 *  value reaches the handler and answers the ErrNotValidHook 404. */
const gitHookIdParam = (description: string) => ({
  id: z.string().min(1).openapi({ description }),
});

/** Body bind hook: upstream's Go bind answers malformed/invalid bodies with
 *  422 (api.go bind → APIErrorValidation); runtime-only — the contract
 *  declares {200,404} for repoEditGitHook, so this stays undeclared. */
const bindValidationHook = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

/** The ErrNotValidHook arm — upstream APIErrorNotFound's plain shared 404
 *  (services/context/api.go:137-142, message "not found"). */
function requireHookName(id: string): GitHookName {
  const name = asGitHookName(id);
  if (name === null) {
    throw new ApiError(404, "not found");
  }
  return name;
}

// ---------------------------------------------------------------------------
// The routes.
// ---------------------------------------------------------------------------

export function registerGitHookRoutes(app: OpenAPIHono<ApiEnv>, requireAuth: MiddlewareHandler<ApiEnv>): void {
  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/hooks/git (repoListGitHooks) — ListGitHooks
  // renders the fixed three-name set in hookNames order (git.go:97-113);
  // upstream's missing-hooks-dir 500 has no Worker arm (there is always a
  // degenerate hooks surface here).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/hooks/git",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "List the Git hooks in a repository",
      operationId: "repoListGitHooks",
      request: { params: z.object(ownerRepoParams) },
      responses: {
        200: {
          description: "GitHookList",
          content: { "application/json": { schema: z.array(gitHookSchema) } },
        },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoAdmin(c, pair);
      const rendered = await Promise.all(
        GIT_HOOK_NAMES.map(async (name) => renderGitHook(name, await readGitHook(c.env.REPO_PACKS, pair.repo.id, name))),
      );
      return c.json(rendered, 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/hooks/git/{id} (repoGetGitHook)
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/hooks/git/{id}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Get a Git hook",
      operationId: "repoGetGitHook",
      request: { params: z.object({ ...ownerRepoParams, ...gitHookIdParam("id of the hook to get") }) },
      responses: {
        200: { description: "GitHook", content: { "application/json": { schema: gitHookSchema } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoAdmin(c, pair);
      const name = requireHookName(c.req.valid("param").id);
      return c.json(renderGitHook(name, await readGitHook(c.env.REPO_PACKS, pair.repo.id, name)), 200);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /repos/{owner}/{repo}/hooks/git/{id} (repoEditGitHook) — hook.GetHook
  // (validity 404 first), then Update(): TrimSpace-empty content removes the
  // stored object (inactive, sample back); otherwise the `\r`-stripped copy
  // persists and the RESPONSE carries the form content verbatim (divergence 3).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "patch",
      path: "/repos/{owner}/{repo}/hooks/git/{id}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Edit a Git hook in a repository",
      operationId: "repoEditGitHook",
      request: {
        params: z.object({ ...ownerRepoParams, ...gitHookIdParam("id of the hook to get") }),
        body: { content: { "application/json": { schema: editGitHookOptionSchema } } },
      },
      responses: {
        200: { description: "GitHook", content: { "application/json": { schema: gitHookSchema } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoAdmin(c, pair);
      const name = requireHookName(c.req.valid("param").id);
      const form = c.req.valid("json");
      const content = form.content ?? "";
      if (content.trim() === "") {
        await clearGitHook(c.env.REPO_PACKS, pair.repo.id, name);
        return c.json(renderGitHook(name, null), 200);
      }
      await storeGitHook(c.env.REPO_PACKS, pair.repo.id, name, content);
      return c.json(renderGitHook(name, content), 200);
    },
    bindValidationHook,
  );

  // -------------------------------------------------------------------------
  // DELETE /repos/{owner}/{repo}/hooks/git/{id} (repoDeleteGitHook) — Update()
  // with empty content: the stored object is removed (no-op when already
  // absent) and the hook falls back to its sample. No 404 arm for a valid
  // name (module header).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "delete",
      path: "/repos/{owner}/{repo}/hooks/git/{id}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Delete a Git hook in a repository",
      operationId: "repoDeleteGitHook",
      request: { params: z.object({ ...ownerRepoParams, ...gitHookIdParam("id of the hook to get") }) },
      responses: {
        204: { description: "empty" },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const pair = await requireVisibleRepo(c, c.req.valid("param"));
      await requireRepoAdmin(c, pair);
      const name = requireHookName(c.req.valid("param").id);
      await clearGitHook(c.env.REPO_PACKS, pair.repo.id, name);
      return c.body(null, 204);
    },
  );
}
