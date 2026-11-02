/**
 * The RELEASE REACTIONS web write (ledger R16(f)) — upstream's
 * `POST /{owner}/{repo}/releases/{id}/reactions/{action}` mount
 * (routers/web/web.go:1515, `repo.ChangeReleaseReaction`,
 * routers/web/repo/release.go:708-755) over the release-reactions service
 * (api/services/release-reactions.ts — upstream services/release/reaction.go
 * + models/issues/reaction.go's release arms). This is the issue family's
 * handoff pattern (pages/issue-timeline-writes.ts): the index.ts router is
 * the ORCHESTRATOR's fold window, so the POST handler lives HERE —
 * self-contained (origin guard → session → repo resolution → gate → service
 * seam → respond), JSX-free, importing only leaf modules. The mount recipe
 * below is executed at the fold. The RENDER half (the shared/reactions.tmpl
 * bar on the release rows) lives in pages/releases.tsx; the dependency is
 * strictly one-way (the bar's render never imports this module), never
 * cyclic.
 *
 * ## The upstream surface at the pin (web-only — NO API twin)
 *
 * The v1 API carries reactions for issues and comments only
 * (routers/api/v1/api.go:1585/:1641 — `/issues/{index}/reactions` and
 * `/issues/comments/{id}/reactions`); there is no release-reactions API
 * route in the OpenAPI spec. The WEB family is the whole surface:
 *
 *   POST /{owner}/{repo}/releases/{id}/reactions/{action}
 *     group gates (web.go:1510-1515): optSignIn + RepoAssignment +
 *     MustBeNotEmpty + reqRepoReleaseReader (the landed releasesReadGate
 *     pair: `is_empty` + the releases unit);
 *     route gates: reqSignIn + RepoMustNotBeArchived.
 *     `action` ∈ {react, unreact} (else NotFound — release.go:736-739's
 *     switch default);
 *     body: the fetch-action ReactionForm `{content}` (Required —
 *     services/forms/repo_form.go:360-363; a bind refusal answers 400).
 *     Target: GetReleaseForRepoByID (repo-scoped global id);
 *     `rel.IsTag || rel.IsDraft → NotFound` (release.go:719-722 — drafts
 *     and tag-only rows are unreactable, exactly the template's render gate
 *     `{{if not (or $release.IsTag $release.IsDraft)}}`,
 *     templates/repo/release/list.tmpl:110).
 *     react → release_service.CreateReleaseReaction (services/release/
 *     reaction.go:19-29): the blocked-user probe (IsUserBlockedBy(doer,
 *     rel.PublisherID, rel.Repo.OwnerID) → ErrBlockedUser) then
 *     CreateReaction over UI.ReleaseReactionsLookup (a foreign content →
 *     ErrForbiddenIssueReaction). BOTH unwrap `util.ErrPermissionDenied`
 *     (reaction.go:38-40; block.go:21 via NewPermissionDeniedErrorf) and
 *     the handler answers that class with HTTPError(403)
 *     (release.go:726-729) — the RELEASE arm's status-exact divergence from
 *     the ISSUE arm (issue.go:497-501 ServerErrors the same pair → the
 *     landed issue twin's plain-text 500). ErrReactionAlreadyExist is
 *     tolerated (release.go:730's `!errors.Is(..., util.ErrAlreadyExist)`
 *     pass) — the duplicate react is a success.
 *     unreact → issues_model.DeleteReleaseReaction (:247-251) — the silent
 *     delete (no rows is still success).
 *     Success re-renders the reactions partial
 *     (`renderReactions(ctx, "{repo}/releases/{id}/reactions", ...)`,
 *     release.go:743-755 → issue.go:543-555's `ctx.JSON(200, {"html": ...})`)
 *     — the JS bar swap; the landed no-JS convention is the 303 onto the
 *     row's own canonical page (the issue twin's posture,
 *     issue-timeline-writes.ts) — Release.Link() =
 *     `{repoLink}/releases/tag/{tag}` (models/repo/release.go:130-155, the
 *     /releases/latest redirect's target shape).
 *
 * ## The allowed set
 *
 * `setting.UI.ReleaseReactions` default (modules/setting/ui.go:103): the
 * issue set MINUS `-1`/`confused` — `+1, laugh, hooray, heart, rocket,
 * eyes`. The picker renders this order; a `-1`/`confused` POST is the
 * foreign-content 403 (the instance default IS the set — no settings
 * module landed, the issue-extras.ts posture).
 *
 * ## Gates (the landed family order — releasesWriteGate's shape)
 *
 * sameOriginGuard (§2.8) → anonymous → the login 303 (the family's write
 * arms' landed order: the sign-in gate FIRST, releasesWriteGate's
 * "anonymous already went to the login 303 before this check") → archived
 * OR the releases read gate (`is_empty` + `hasReleases`) → the 404 shell
 * (upstream RepoMustNotBeArchived answers 403 — the file-editor reduction,
 * the family's carried posture; MustBeNotEmpty + reqRepoReleaseReader are
 * the releasesReadGate pair verbatim). The repo-scoped-lookup rule (the
 * issue family's carried reduction) answers a missing/foreign release id
 * with the 404 shell — upstream's lookup miss is a ServerError(500)
 * (release.go:712-715), the tree's established ServerError-on-miss
 * reduction, documented here.
 *
 * ## Mount recipe (the exact hunks — index.ts is the orchestrator's)
 *
 * 1. Import the handler beside the other page-module imports:
 *
 *      import { releaseReactionSubmit } from "./pages/release-reaction-writes";
 *
 * 2. parseUiRoute's releases block (the `head === "releases"` arm, beside
 *    the edit/tag claims — upstream chi matches the 3-segment
 *    `{id}/reactions/{action}` shape, values validated in-handler;
 *    PathParamInt64's junk id lands the lookup miss):
 *
 *      if (rest.length === 3 && rest[1] === "reactions") {
 *        return { family: "release-reaction", owner, repo, id: rest[0], action: rest[2] };
 *      }
 *
 *    with the interface (the ReleaseDownloadRoute pattern — a separate
 *    route shape, added to the UiRoute union beside it):
 *
 *      export interface ReleaseReactionRoute {
 *        family: "release-reaction";
 *        owner: string;
 *        repo: string;
 *        /** The raw id segment (strict-decimal validated in-handler). *\/
 *        id: string;
 *        /** The raw action segment (react|unreact validated in-handler). *\/
 *        action: string;
 *      }
 *
 *    and the releases block's standing note (index.ts ~:2415) flips: the
 *    `{id}/reactions` POST is CLAIMED from this wave — only the
 *    `/generate-notes` + `/attachments*` write tails stay unclaimed.
 *
 * 3. The registrations beside the family's POSTs (index.ts ~:20123; the
 *    chi-405 GET twin per the issue family's convention):
 *
 *      uiRouter.post("/:owner/:repo/releases/:id/reactions/:action", (c) => releaseReactionSubmit(c));
 *      uiRouter.get("/:owner/:repo/releases/:id/reactions/:action", () => methodNotAllowed("POST"));
 *
 *    (No precedence hazard: the static POST literals `/releases/new`,
 *    `/releases/edit/*`, `/releases/delete` are 3-4 segments; this is 5.)
 *
 * 4. GOLDENS: the render half's signed-in golden drifts at this unit's
 *    landing (the release bar's picker now renders for signed-in viewers):
 *    `src/ui/__tests__/goldens/releases-writer.html` — the anonymous pair
 *    (`releases.html`, `release-detail.html`) is byte-identical (no fixture
 *    reactions, anonymous cannot react). Regenerate at a quiet tree at the
 *    fold: `node src/ui/__tests__/update-goldens.mjs`. THE DRIFT IS
 *    REPORTED, NOT RE-BASELINED, by this unit (the issue-family precedent).
 *
 * ## Behavior pins (the test matrix carries each)
 *
 * - The form parse: `content` Required — empty/garbage = the bind refusal,
 *   the plain-text 400 (the issue twin's carried reduction of upstream's
 *   fetch-action JSONErrorWithField 400).
 * - react: allowed-set check → the blocked-user probe (publisher + repo
 *   owner, `IsUserBlockedBy`'s admin short-circuit riding) → the guarded
 *   insert (a duplicate stays success). Both refusal arms answer
 *   STATUS-EXACT 403 as the plain text (upstream HTTPError(403) — the HTML
 *   error page is chrome, the compare.tsx honest-status posture).
 * - unreact: the silent delete — a no-row unreact is still the 303.
 * - The 303 target: `/releases/tag/{pathEscapeSegments(tag)}`.
 * - NO reaction render is attached to the write answer (upstream's JSON
 *   `html` payload is the JS swap; the no-JS page refetches via the 303).
 */

import { Context, Hono } from "hono";

import { isUserBlockedBy } from "../../api/services/blocks";
import { findReleaseForRepoById } from "../../api/services/releases";
import {
  ALLOWED_RELEASE_REACTIONS_SET,
  createReleaseReaction,
  deleteReleaseReaction,
} from "../../api/services/release-reactions";
import { loadRepoSettings } from "../../api/services/repo-settings";
import { demoModeEnabled } from "../../services/demo-sweep";
import { packagesQuotaFromEnv } from "../../services/packages/model";
import { readUrlEncodedForm } from "../forms";
import { assetsBinding, assetsNotBuilt } from "../index";
import { AssetBuildError, loadManifest } from "../manifest";
import { pathEscapeSegments } from "../page-data";
import { renderNotFound } from "../render";
import { resolveRepositoryForViewer } from "../repo-view";
import { sameOriginGuard } from "../session";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";
import { resolveViewer, type Viewer } from "../viewer";

type RouteContext = Context<{ Bindings: Env }>;

/** Page chrome text (component-local; the strings are the upstream texts
 *  verbatim — the reaction refusals cite their model error texts). */
export const releaseReactionLocale = {
  /** models/issues/reaction.go:34-37 ErrForbiddenIssueReaction.Error() —
   *  the plain-text 403 body (status-exact, the HTML page is chrome). */
  reaction_forbidden: "is not an allowed reaction",
  /** models/user/block.go:21 ErrBlockedUser's text ("user is blocked") —
   *  the same 403 channel. */
  blocked_user: "user is blocked",
  /** ReactionForm's Required bind refusal (issue_reaction forms) — the
   *  issue twin's carried 400 text. */
  content_required: "content is required",
} as const;

// ---------------------------------------------------------------------------
// The resolution prologue (the resolveTimelineRepo twin, reduced to the
// arms this family answers — no re-rendered page, so no watch/starring
// flags and no unread count beyond the shell default)
// ---------------------------------------------------------------------------

interface ResolvedRepo {
  ok: true;
  url: URL;
  ctx: UiContext;
  viewer: Viewer;
  respond: (res: Response) => Response;
  repo: RepoRow;
}

/** The session half of resolveUiSession (the part-one twin): viewer +
 *  manifest + the set-cookie-attaching respond. */
async function resolveReactionSession(c: RouteContext): Promise<
  { ok: true; url: URL; ctx: UiContext; viewer: Viewer; respond: (res: Response) => Response } | { ok: false; response: Response }
> {
  const url = new URL(c.req.url);
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined;
  }
  let ctx: UiContext;
  let setCookie: string | null = null;
  let viewer: Viewer;
  try {
    const [manifest, resolution] = await Promise.all([
      loadManifest(assetsBinding(c.env), url.origin),
      resolveViewer(c.env, c.req.raw, { waitUntil }),
    ]);
    setCookie = resolution.setCookie;
    viewer = resolution.viewer;
    ctx = {
      viewer: resolution.viewer,
      origin: url.origin,
      notificationCount: null,
      demoMode: demoModeEnabled(c.env),
      packagesEnabled: packagesQuotaFromEnv(c.env).packagesEnabled,
      assets: shellAssetsFromManifest(manifest),
    };
  } catch (error) {
    if (error instanceof AssetBuildError) return { ok: false, response: assetsNotBuilt(error) };
    throw error;
  }
  const respond = (res: Response): Response => {
    if (setCookie === null) return res;
    const headers = new Headers(res.headers);
    headers.append("set-cookie", setCookie);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
  return { ok: true, url, ctx, viewer, respond };
}

/** The repo prologue (the resolveTimelineRepo twin): session → §2.5 repo
 *  read → the ctx.repo the 404 shell's chrome carries. */
async function resolveReactionRepo(c: RouteContext): Promise<ResolvedRepo | { ok: false; response: Response }> {
  const session = await resolveReactionSession(c);
  if (!session.ok) return session;
  const { url, ctx, viewer, respond } = session;
  const owner = c.req.param("owner");
  const repoName = c.req.param("repo");
  if (owner === undefined || repoName === undefined) return { ok: false, response: respond(await c.notFound()) };
  const repo = await resolveRepositoryForViewer(c.env, viewer, owner, repoName);
  if (repo === null) return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  ctx.repo = repo;
  return { ok: true, url, ctx, viewer, respond, repo };
}

/** index.ts's loginRedirect verbatim (the SPEC-0010 §2.5 round-trip). */
function loginRedirect(requestUri: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `/login?redirect_to=${encodeURIComponent(requestUri)}` },
  });
}

/** The releases family's read gate verbatim (index.ts releasesReadGate —
 *  upstream's group middleware pair: `repo.MustBeNotEmpty` + the releases
 *  unit). */
async function releasesReadGate(db: D1Database, repo: RepoRow): Promise<boolean> {
  if (repo.isEmpty) return false;
  return (await loadRepoSettings(db, repo.id)).hasReleases;
}

/** The signed-in viewer the gate hands back. */
type UserViewer = Extract<Viewer, { kind: "user" }>;

interface GatePassed {
  ok: true;
  url: URL;
  ctx: UiContext;
  viewer: UserViewer;
  respond: (res: Response) => Response;
  repo: RepoRow;
}

/** The family's write-gate order (releasesWriteGate minus the writer grant —
 *  reqSignIn + RepoMustNotBeArchived + the group's read pair): anonymous →
 *  the login 303; archived or the read gate refused → the 404 shell. */
async function reactionGate(c: RouteContext, resolved: Extract<ResolvedRepo, { ok: true }>): Promise<GatePassed | { response: Response }> {
  const { url, ctx, viewer, respond, repo } = resolved;
  if (viewer.kind === "anonymous") return { response: respond(loginRedirect(url.pathname + url.search)) };
  if (repo.isArchived || !(await releasesReadGate(c.env.DB, repo))) {
    return { response: respond(c.html(renderNotFound(ctx), 404)) };
  }
  return { ok: true, url, ctx, viewer, respond, repo };
}

/** The status-exact plain-text error (upstream ctx.HTTPError(status, msg)
 *  reduced — the HTML error page is chrome; the STATUS is the contract). */
function httpErrorText(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

// ---------------------------------------------------------------------------
// The form parse + the write seam
// ---------------------------------------------------------------------------

/** The reaction pair's form: action comes from the PATH; content is the
 *  form's Required field (empty/garbage = null → the bind-refusal 400 arm)
 *  — the issue twin's parseReactionForm shape (issue-timeline-writes.ts),
 *  re-ported to keep this module's import graph leaf-only. */
export function parseReleaseReactionForm(params: URLSearchParams): string | null {
  const raw = params.get("content") ?? "";
  return raw === "" ? null : raw;
}

export type ReleaseReactionApplyResult =
  | { outcome: "applied" }
  | { outcome: "forbidden-reaction" }
  | { outcome: "blocked-user" };

/**
 * ChangeReleaseReaction's write half (release.go:723-741 over
 * services/release/reaction.go:19-29): the content allow-list and the
 * blocked-user guard ride the REACT arm only (upstream's shape — react goes
 * through CreateReleaseReaction's CreateReaction allowed-set check + the
 * IsUserBlockedBy probe; unreact calls DeleteReleaseReaction directly, NO
 * checks — a foreign-content unreact is the silent no-op success there).
 * Both refusal arms answer upstream's `util.ErrPermissionDenied` → 403
 * (STATUS-EXACT — the release handler's divergence from the issue handler's
 * ServerError 500); the idempotent create is success either way (upstream
 * tolerates ErrReactionAlreadyExist, release.go:730); the unreact is the
 * silent delete (no rows is still success); any other action is the
 * handler's NotFound (the caller answers it before reaching here — this
 * seam re-checks for the direct callers).
 */
export async function applyReleaseReactionWrite(
  d1: D1Database,
  target: { releaseId: number },
  action: string,
  content: string,
  doer: { id: number; isAdmin: boolean },
  blockerIds: number[],
  now: Date,
): Promise<ReleaseReactionApplyResult> {
  if (action === "react") {
    if (!ALLOWED_RELEASE_REACTIONS_SET.has(content)) return { outcome: "forbidden-reaction" };
    if (await isUserBlockedBy(d1, doer, ...blockerIds)) return { outcome: "blocked-user" };
    await createReleaseReaction(d1, { userId: doer.id, releaseId: target.releaseId, type: content }, now);
    return { outcome: "applied" };
  }
  if (action === "unreact") {
    await deleteReleaseReaction(d1, { userId: doer.id, releaseId: target.releaseId, type: content });
    return { outcome: "applied" };
  }
  return { outcome: "forbidden-reaction" };
}

// ---------------------------------------------------------------------------
// The POST handler
// ---------------------------------------------------------------------------

/**
 * POST /{owner}/{repo}/releases/{id}/reactions/{action} (upstream
 * repo.ChangeReleaseReaction, release.go:708-755): the §2.8 Origin guard,
 * the family's gate order (anonymous → login 303; archived/read → the 404
 * shell), then the repo-scoped release lookup by the GLOBAL id (a missing
 * or foreign id — or the tag/draft refusal — 404-shells: release.go:719-722
 * is status-exact NotFound; the lookup miss is the tree's
 * ServerError-on-miss reduction), then the action pair over the write seam,
 * success the canonical 303 onto the release's own page (Release.Link()).
 */
export async function releaseReactionSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveReactionRepo(c);
  if (!resolved.ok) return resolved.response;
  const gated = await reactionGate(c, resolved);
  if ("response" in gated) return gated.response;
  const { ctx, respond, repo, viewer } = gated;

  const rawId = c.req.param("id") ?? "";
  if (!/^\d+$/.test(rawId)) return respond(c.html(renderNotFound(ctx), 404));
  const row = await findReleaseForRepoById(c.env.DB, repo.id, Number.parseInt(rawId, 10));
  if (row === null || row.isTag || row.isDraft) return respond(c.html(renderNotFound(ctx), 404));

  const action = c.req.param("action") ?? "";
  if (action !== "react" && action !== "unreact") return respond(c.html(renderNotFound(ctx), 404));
  const content = parseReleaseReactionForm(await readUrlEncodedForm(c.req.raw));
  if (content === null) return respond(httpErrorText(400, releaseReactionLocale.content_required));

  const result = await applyReleaseReactionWrite(
    c.env.DB,
    { releaseId: row.id },
    action,
    content,
    { id: viewer.id, isAdmin: viewer.isAdmin },
    [row.publisherId ?? 0, repo.ownerId ?? 0].filter((id) => id !== 0),
    new Date(),
  );
  if (result.outcome === "forbidden-reaction") {
    return respond(httpErrorText(403, `'${content}' ${releaseReactionLocale.reaction_forbidden}`));
  }
  if (result.outcome === "blocked-user") {
    return respond(httpErrorText(403, releaseReactionLocale.blocked_user));
  }
  return respond(
    new Response(null, {
      status: 303,
      headers: { location: `/${repo.ownerNamespace}/${repo.slug}/releases/tag/${pathEscapeSegments(row.tagName)}` },
    }),
  );
}

// ---------------------------------------------------------------------------
// The recipe router (the issue-timeline-writes test posture — the mounted
// uiRouter carries none of it until the orchestrator's fold)
// ---------------------------------------------------------------------------

/** The GET twin's chi-405 (methodNotAllowed's local tail — the private
 *  helper stays in index.ts; the recipe router mirrors the answer). */
function methodNotAllowedTail(allow: string): Response {
  return new Response(null, { status: 405, headers: { allow } });
}

/**
 * The module's recipe router: the mounted-shape POST + the chi-405 GET
 * twin, driven DIRECTLY by release-reaction-writes.test.ts (the
 * createIssueTimelineWritesRouter posture).
 */
export function createReleaseReactionWritesRouter(): Hono<{ Bindings: Env }> {
  const router = new Hono<{ Bindings: Env }>();
  router.post("/:owner/:repo/releases/:id/reactions/:action", (c) => releaseReactionSubmit(c));
  router.get("/:owner/:repo/releases/:id/reactions/:action", () => methodNotAllowedTail("POST"));
  return router;
}
