import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

import { createDurableGit, Registry, RepoCell } from "@cf-gitea/git-engine";
import { resolveAuth, tokenRouter } from "./auth";
import {
  rejectPublicOnly,
  rejectPublicOnlyUserAssignment,
  sudo,
} from "./auth/middleware";
import { createApiRouter } from "./api/router";
import { createPackagesProtocolRouter } from "./api/routes/packages";
import { createContainerProtocolRouter, createEcosystemProtocolRouter } from "./api/routes/packages-protocols";
import { createActionsRouter } from "./services/actions/routes";
import { createArtifactsV1Router } from "./services/actions/artifacts-v1";
import { ARTIFACT_V4_ROUTE_BASE, createArtifactsV4Router } from "./services/actions/artifacts-v4";
import { authorize } from "./git-http/authorize";
import { gitHttpGate } from "./git-http/gate";
import { handleRepoTasks } from "./repos/purge";
import { repoTasksDlqHandler } from "./repos/dlq";
import { handleUserPushEvent } from "./services/webhooks-push";
import { handleActionsPushEvent } from "./services/actions/trigger";
import { enqueuePushMirrorSyncsOnCommit } from "./services/mirror/push-sync";
import { handleScheduledCron } from "./services/demo-sweep";
import { handleIncomingEmail } from "./services/mail/inbound";
import { armsForEntry, recordArmsFailure, recordArmsSuccess } from "./services/cron-state";
import { handlesUiRoute, uiRouter } from "./ui";
import { sessionRouter } from "./ui/session";
import { oauth2AuthorizeRouter } from "./ui/oauth2-authorize";
import { oauth2LoginRouter } from "./web/oauth2-login";
import { firstRunRouter } from "./ui/first-run";
import { avatarServingRouter } from "./web/avatar-serving";
import { attachmentsServingRouter } from "./web/attachments-serving";
import { oauth2Router } from "./web/oauth2-token";
import { wellKnownRouter } from "./api/routes/federation";
import { securityHeaders, withSecurityHeaders } from "./web/security-headers";
import { webhookDlqHandler } from "./webhooks/dlq";
import { webhookQueueHandler } from "./webhooks/consumer";
import { renderNotFoundShellResponse, renderServerErrorShellResponse } from "./ui/not-found-response";

/**
 * Git smart-HTTP engine mount (SPEC-0001 M1).
 *
 * The engine handler owns every repository-scoped path. With `namespaces`
 * repositories are /:owner/:repo[.git]/... (Gitea/GitHub-style two-segment
 * names): `info/refs`, `git-upload-pack`, `git-receive-pack`, the repo admin
 * endpoints (config/gc/DELETE) and the repo JSON API — everything the handler
 * classifies as protocol/api/admin.
 *
 * - `ui: false` runs it headless: repo pages 404 so the Tier-2 UI router
 *   (SPEC-0008, src/ui) owns the page families (AGENTS.md project overview —
 *   the official Gitea frontend is the frontend; uiRouter renders the shell).
 * - `cors` unset: no cross-origin engine API yet.
 * - `onPush` (SPEC-0005 §3, wired fff6094): after finalizeReceive commits,
 *   the engine fires the hook in waitUntil with the APPLIED updates delta —
 *   the user-push webhook family (pusher = repo owner until the engine
 *   plumbs authenticated identity) and, beside it, the M3 Actions trigger
 *   chain (SPEC-0012 §2.9, `handleActionsPushEvent` — its own never-fail
 *   posture: the applied push stands). Mirror/import receives use their own
 *   engine instances without the hook (no double emission).
 * - `REPO_PACKS` (R2) is bound and used by the engine's receive path for
 *   pack staging + final packs (SPEC-0001a §3 Step 1). The full-clone cache
 *   key family (`clone-cache/`) stays unwritten until M4 (SPEC-0001 §10).
 */
const gitHttp = createDurableGit<Env>({
  authorize,
  ui: false,
  namespaces: true,
  onPush: async (event, env) => {
    // Sync-on-commit producer (SPEC specs/push-mirror-outbound.md §4.1;
    // upstream syncPushMirrorWithSyncOnCommit, mirror_push.go:250-260) —
    // best-effort enqueue, never fails the push (the helper catches its own).
    void enqueuePushMirrorSyncsOnCommit(env, event.repo);
    await handleUserPushEvent(env, event);
    // The Actions trigger (SPEC-0012 M3 tier P) — the same waitUntil, the
    // same never-fail-the-push posture (it catches its own errors).
    await handleActionsPushEvent(env, event);
  },
});

const app = new Hono<{ Bindings: Env }>();

// THE 500 CHROME ARM (usability sweep, 2026-10-29): every unhandled handler
// error used to fall to Hono's default onError — a bare plain-text
// "Internal Server Error" — so a browser on a failing route saw a naked line,
// exactly like the pre-carve 404s did. Upstream answers the same failure from
// its GLOBAL recovery: ProtocolMiddlewares (routers/common/middleware.go:26-28)
// mounts RequestContextHandler, whose `defer recover()` (middleware.go:83-85)
// calls renderPanicErrorPage (routers/common/errpage.go:59-90), wired
// tree-wide — web AND api — at routers/init.go:178; the handler-invoked twin
// is Context.ServerError (services/context/context_response.go:173-192).
// The negotiation mirrors upstream per-header-part `text/html` sniffing
// (errpage.go:43-48): status/500 chrome for browsers (the shell builder in
// ui/not-found-response.tsx), the plain `Internal Server Error` line
// otherwise (errpage.go:114's prod plainMsg — byte-identical to Hono's
// default body, pinned here). The error + its stack go to the LOG only
// (errpage.go:66-67's log.Error("PANIC: %v", …)); the body never carries
// them — upstream's dev/admin leak branch (errpage.go:118-122) is deliberately
// not ported. The actions sub-app keeps its own onError
// (services/actions/routes.ts:291), so its errors stay connect-shaped and
// never reach this arm.
app.onError(async (error, c) => {
  // A thrown HTTPException carries its own crafted response (the protocol
  // families' 401 challenges among them) — pass it through untouched instead
  // of wrapping it as a 500 (the OCI walk's live find: every family's thrown
  // challenge rendered 500 here while their vitest parents honored it).
  if (error instanceof HTTPException) return error.getResponse();
  console.error(`500 answering ${c.req.method} ${c.req.url}`, error);
  const headers = {
    // SetCacheControlInHeader zero-options (errpage.go:87 → httpcache.go:29-31).
    "cache-control": "max-age=0, private, must-revalidate",
  };
  const acceptsHtml = (c.req.header("accept") ?? "").includes("text/html");
  if (!acceptsHtml) {
    // The security-headers ride below (web/security-headers.ts): an onError
    // response bypasses post-`next()` middleware stamping (the same reason
    // this arm hand-sets cache-control) — upstream's plain error renders
    // carry nosniff verbatim (services/context/base.go:134).
    return withSecurityHeaders(c.text("Internal Server Error", 500, headers));
  }
  // The template-render failure fallback (errpage.go:91-101): a shell that
  // cannot render answers the plain log-and-report line — never a half
  // response, never the stack. c.executionCtx is unavailable under direct
  // router.request() test invocations — the resolver then settles inline
  // (the web/attachments-serving.ts dispatch pattern).
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined;
  }
  try {
    // The 500 shell is text/html — withSecurityHeaders adds the page CSP on
    // top of the shell's own headers (upstream's 500.tmpl carries the CSP
    // meta, templates/status/500.tmpl:11; base.go:205-210's header twin).
    return withSecurityHeaders(await renderServerErrorShellResponse(c.env, c.req.raw, { waitUntil }));
  } catch (renderError) {
    console.error("500 shell render failed", renderError);
    return withSecurityHeaders(
      c.text(
        "Internal server error but failed to render error page template, please collect error logs and report to Gitea issue tracker",
        500,
        headers,
      ),
    );
  }
});

// THE SECURITY-HEADERS MIDDLEWARE (usability F2, docs/usability/findings-latency-health.md):
// upstream stamps `X-Content-Type-Options: nosniff` + `X-Frame-Options:
// SAMEORIGIN` on EVERY response leaving Gitea — SecurityHeadersHandler
// (routers/common/middleware.go:48-64) rides ProtocolMiddlewares
// (middleware.go:29), wired tree-wide at routers/init.go:178, defaults from
// modules/setting/security.go:27-28 — and carries the general CSP on HTML
// (`WebContentSecurityPolicy`, services/context/context_template.go:116-141;
// head meta on pages, templates/base/head.tmpl:4; response header via
// SetHeaderContentSecurityPolicyGeneral, services/context/base.go:205-210).
// Mounted FIRST so every merged sub-app route (uiRouter, session, first-run,
// avatars, attachments, the api trees, healthz) unwinds through it; the
// nonce → 'unsafe-inline' adaptation and the non-Hono exits
// (gitHttpGate / 404 shell / onError) are documented in web/security-headers.ts.
app.use("*", securityHeaders());

app.get("/healthz", (c) => c.json({ ok: true }));

// /api/v1 (SPEC-0002/0004): resolveAuth parses credentials (anonymous stays
// anonymous; its D1-verified identity wins inside the api middlewares);
// tokenRouter carries token CRUD; createApiRouter mounts the zod-openapi
// tier-1 surface (version/user/repos/users/markdown + batches), declared
// against the frozen contract (pnpm check:api).
app.use("/api/v1/*", resolveAuth());

// Upstream's tree-wide sudo() wrap: the entire v1 tree sits inside one
// m.Group closed by `}, sudo())` (api.go:999–1872), so admin impersonation
// via `?sudo=`/`Sudo` runs after credential resolution and before every
// route gate. The impersonated doer keeps the ADMIN token's scope, and the
// public-only gates below evaluate that effective credential — upstream
// keeps `ExtDoerData` on the swapped doer the same way (api.go:129–139).
app.use("/api/v1/*", sudo());

// Upstream rejectPublicOnly() placements — one mount per chi group / single
// route arm at the pin, never blanket-applied (a public-only token carries
// the restriction bit; anonymous and other tokens pass untouched):
//   /notifications group — the mailbox mixes public and private repo events
//     (api.go:1044–1051);
//   /user/settings (1101), /user/emails (1106), /user/actions (1138),
//     /user/keys (1156), /user/applications (1167), /user/gpg_keys (1175),
//     /user/gpg_key_token (1176), /user/gpg_key_verify (1177);
//   POST /user/repos only — the sibling GET stays public-only-visible
//     (api.go:1181);
//   /user/times (1192), /user/stopwatches (1193), /user/teams (1195),
//     /user/hooks (1202), /user/avatar (1207), /user/blocks (1216);
//   POST /org/{org}/repos deprecated shape (1224), POST /repos/migrate
//     (1237), POST the generate route (1245), POST /orgs (1723), POST
//     /orgs/{org}/repos (1731);
//   the whole /admin group (1867). Not wired here: upstream's
//     reqOrgOwnership inner gate (api.go:425) and the /user group's
//     contextAuthenticatedUser wrap (api.go:1217) — route-file-owned
//     placements recorded as the follow-up.
app.use("/api/v1/notifications/*", rejectPublicOnly());
app.use("/api/v1/user/settings/*", rejectPublicOnly());
app.use("/api/v1/user/emails/*", rejectPublicOnly());
app.use("/api/v1/user/actions/*", rejectPublicOnly());
app.use("/api/v1/user/keys/*", rejectPublicOnly());
app.use("/api/v1/user/applications/*", rejectPublicOnly());
app.use("/api/v1/user/gpg_keys/*", rejectPublicOnly());
app.use("/api/v1/user/gpg_key_token", rejectPublicOnly());
app.use("/api/v1/user/gpg_key_verify", rejectPublicOnly());
app.use("/api/v1/user/repos", rejectPublicOnly("POST"));
app.use("/api/v1/user/times", rejectPublicOnly());
app.use("/api/v1/user/stopwatches", rejectPublicOnly());
app.use("/api/v1/user/teams", rejectPublicOnly());
app.use("/api/v1/user/hooks/*", rejectPublicOnly());
app.use("/api/v1/user/avatar/*", rejectPublicOnly());
app.use("/api/v1/user/blocks/*", rejectPublicOnly());
app.use("/api/v1/org/:org/repos", rejectPublicOnly("POST"));
app.use("/api/v1/repos/migrate", rejectPublicOnly("POST"));
app.use("/api/v1/repos/:template_owner/:template_repo/generate", rejectPublicOnly("POST"));
app.use("/api/v1/orgs", rejectPublicOnly("POST"));
app.use("/api/v1/orgs/:org/repos", rejectPublicOnly("POST"));
app.use("/api/v1/admin/*", rejectPublicOnly());

// The userAssignment public-only arm (services/context/user.go:61–64) for
// the /users/{username} resolve paths — upstream chains UserAssignmentAPI
// onto these groups (api.go:1074, 1715, 1722) while our directory routes
// resolve the context user themselves. A public-only token resolving a
// limited/private target answers the masked ErrUserRedirectNotExist 404;
// the arm skips unknown targets (routes own their miss 404s) and the
// `search` segment (upstream's static /users/search registration wins over
// the /{username} param group — static-over-param precedence, api.go:1062).
app.use("/api/v1/users/:username/*", rejectPublicOnlyUserAssignment());

app.route("/api/v1", tokenRouter);
app.route("/api/v1", createApiRouter());

// /api/packages (SPEC-0016 §3.2): the generic registry protocol — upstream
// mounts it OUTSIDE /api/v1 (api.go:91's "not /api/v1/packages" note) and so
// do we. No resolveAuth mount: the protocol router carries its own credential
// pass (the LFS seam — parse + verify + ScopeSet) because its upstream gate
// (reqPackageAccess) needs the TOKEN SCOPE, which the ApiEnv seam does not
// carry; anonymous requests flow through so public-owner downloads work and
// everything insufficient answers the 401 + WWW-Authenticate challenge
// (§5.10) that makes real package-manager clients re-prompt. run_worker_first
// pins /api/* so the asset tree never shadows these paths.
app.route("/api/packages", createPackagesProtocolRouter());

// SPEC-0016 M3: the pypi + helm protocol families ride the SAME /api/packages
// mount (upstream's CommonRoutes groups at api.go:417-421 / api.go:337-341) —
// a second sub-app beside the generic router, with the same credential-pass
// gate (no resolveAuth mount; the 401 + WWW-Authenticate challenge arms live
// inside).
app.route("/api/packages", createEcosystemProtocolRouter());

// /v2 (SPEC-0016 §7 M6): the container (OCI) registry family — upstream mounts
// ContainerRoutes on /v2 at the ROOT (api.go:509-547; container.go:117: "container
// registry requires that the /v2 must be in the root"), beside the
// /api/packages families.
app.route("/v2", createContainerProtocolRouter());

// /api/actions (SPEC-0012 §2.1, M1a): the runner protocol — the ping echo +
// the connect-RPC RunnerService mounts under /<service-name>/<Method>
// (upstream actions.go:22-26), with the runner interceptor living inside the
// sub-app (x-runner-uuid/token auth + debounced heartbeats). No resolveAuth
// mount: the runner protocol's credential model is its own (registration
// tokens + runner polling tokens, NOT /api/v1 tokens). M1b adds the OIDC
// issuer group (/api/actions/oidc — actions.go:16-20) inside the same sub-app.
app.route("/api/actions", createActionsRouter());

// /api/actions_pipeline (SPEC-0012 §2.1/§2.4, M1b): the artifacts-v1 family
// + job summaries (init.go:203-204 — upstream's own "only artifact is used
// for now" note rides the same mount). The Bearer runtime-token gate lives
// inside the sub-app.
app.route("/api/actions_pipeline", createArtifactsV1Router());

// /twirp/github.actions.results.api.v1.ArtifactService (SPEC-0012 §2.5, M1b):
// the artifacts-v4 family (init.go:205-206). Authenticated twirp posts +
// HMAC-signed unauthenticated upload/download, all inside the sub-app.
app.route(ARTIFACT_V4_ROUTE_BASE, createArtifactsV4Router());

// Avatar serving (web mux at the pin — routers/web/base.go): mounted BEFORE
// uiRouter so its literal /avatar, /avatars and /user/avatar routes always
// win over the UI's /:owner/:repo parser shape.
app.route("/", avatarServingRouter);
// Attachments serving (web.go:912): plain Hono seam — mounted before uiRouter
// so the literal /attachments/:uuid route wins over any page-parser shape.
app.route("/", attachmentsServingRouter);
// The /.well-known pair (federation Tier A — SPEC federation.md §6.1.1's
// mount, the same plain-Hono seam shape): nodeinfo + webfinger, the
// FEDERATION_ENABLED gate answers 404 when off (the web pair's disabled arm).
app.route("/", wellKnownRouter);
// The OAuth2 provider's stateless JSON arms (SPEC specs/oauth2-provider.md
// §2.3/§2.6, W2's route-home decision in web/oauth2-token.ts's header):
// POST /login/oauth/access_token, POST /login/oauth/introspect,
// GET/POST /login/oauth/userinfo, GET /login/oauth/keys + the bare-OPTIONS
// 405 deny arms. Mounted BEFORE uiRouter (the first-run HANDOFF's
// precedence finding) and carved out of the repo-scoped branch (the
// isLoginPath carve above); W3's authorize/consent arms join this family
// and W4 wraps the group in the OAUTH2_ENABLED 403 (web.go:631's
// oauth2Enabled — ungated until then).
app.route("/", oauth2Router);
// Tier-2 UI (SPEC-0008 §2.2): the sub-app claims only the page families its
// parser owns (/:owner/:repo[/commits|/src]); the dispatcher consults
// handlesUiRoute BEFORE Hono routes, so a miss here can never swallow an
// engine route. api registrations stay first; healthz is unaffected.
// SPEC-0010 §6 first-run amendment: the zero-user install window (/install)
// and the ALLOW_SIGNUP-gated /user/sign_up. MUST mount BEFORE uiRouter:
// /user/sign_up is two segments and Hono's RegExpRouter gives the dynamic
// /:owner/:repo pair precedence over a static registered in a LATER-mounted
// router (the /explore rule documented at uiRouter's literal block — the
// first-run HANDOFF's "order immaterial" claim was wrong for this path).
app.route("/", firstRunRouter);
app.route("/", uiRouter);
// SPEC-0010: /login + /logout are single-segment top level routes (§2.1) —
// never repo-scoped, so the dispatcher and the engine never see them.
app.route("/", sessionRouter);
// The OAuth2 authorize pair (SPEC oauth2-provider.md W3): /login/oauth/
// authorize + /login/oauth/grant — session-bound UI routes in the session
// family; the oauth2Enabled 403 wrap rides W4 (the commented slot at the
// router export).
app.route("/", oauth2AuthorizeRouter);
// The EXTERNAL-AUTH login pair (SPEC external-auth-sources.md W2):
// /user/oauth2/{source} + its /callback — the OIDC client flow's legs
// (web.go:768-771's mounts).
app.route("/", oauth2LoginRouter);

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(req.url);
    const segments = pathname.slice(1).split("/");

    // Repository-scoped requests (/owner/repo[/...]) first run the
    // SPEC-0003 gitHttpGate pipeline (parse → go-get/HEAD → resolve repo in
    // D1 (+ redirects, row 13) → ACL matrix §2.4 → push-create rows 15-20):
    // it answers the matrix/go-get/HEAD/push-create routes itself and
    // otherwise delegates to the engine. Repositories without a D1 row
    // (everything predating lifecycle, incl. the e2e suite) pass through to
    // the engine verbatim — method, URL and body untouched so push bodies
    // stream straight into the storage DO (AGENTS.md Workers rules). The
    // engine parses the exact repo/sub-path and answers 404 for malformed,
    // reserved, or unknown non-push paths.
    // "api" stays in Hono-land for /api/v1 (SPEC-0004). UI page families
    // (SPEC-0008 §2.2 — src/ui is the single source of route truth) are
    // GET-only (§2.1) and canonical (§4.13: the UI never emits trailing
    // slashes), so the UI claims exactly that shape: every other method (the
    // engine admin DELETE, the JSON API's non-GET surfaces) and every
    // trailing-slash URL keeps its pre-UI owner — the engine passthrough the
    // e2e suite runs against stays byte-identical. ONE documented exception
    // (the lastcommit carve in the repo-scoped branch below — RD19): upstream's
    // LastCommitLoaderURL carries a trailing slash for root listings and its
    // own wildcard route serves that shape, so the faithful emit is slashed.
    // Avatar serving carve-out (routers/web/base.go + web.go:265/760/775 at
    // the pin): /avatar/{hash}, /avatars/* and /user/avatar/{username}/{size}
    // are single-concern web routes — never repo-scoped, never the engine's.
    // Without this the two-segment shapes fall into the repo-scoped branch
    // and the headless engine 404s them.
    const isAvatarServing =
      segments[0] === "avatar" ||
      segments[0] === "avatars" ||
      (segments[0] === "user" && segments[1] === "avatar");
    // Attachments carve-out (web.go:912 — the site-level /attachments/:uuid
    // download route): never repo-scoped, never the engine's.
    const isAttachmentServing = segments[0] === "attachments";
    // The /.well-known family (federation Tier A — the nodeinfo/webfinger
    // pair rides wellKnownRouter; SPEC federation.md §6.1.1's mount): carved
    // out of the repo-scoped branch so the two-segment shapes stop falling
    // to the headless engine's 404.
    const isWellKnown = segments[0] === ".well-known";
    // The /login family carve (SPEC specs/oauth2-provider.md §2.1/§6 W2):
    // the OAuth2 provider group (/login/oauth/* — web.go:617-631) and the
    // session router's /login live in Hono-land; without the carve the
    // multi-segment /login/oauth/* shapes fall into the repo-scoped branch
    // and the headless engine 404s them (the /.well-known carve's twin —
    // the W3 authorize/consent arms ride the same mount family).
    const isLoginPath = segments[0] === "login";
    // THE ASSET-MISS FALLBACK TARGET (web.go:264 + modules/public/public.go —
    // the v1.2-carried "no /assets fallback target" residual closed): the
    // wrangler assets binding serves every HIT edge-side with
    // not_found_handling "none", so a /assets/* request reaching THIS
    // dispatcher is by construction a MISS — and upstream answers misses
    // itself: FileHandlerFunc's non-GET/HEAD arm 405s (public.go:46-48),
    // handleRequest's not-exist and directory arms are the BARE empty 404
    // (:78-79/:93-94 — no styled shell; the browser's asset request never
    // gets HTML), and OPTIONS rides web.go:264's AssetsCors() preflight
    // (public.go:33-39 — AllowedOrigins *, methods HEAD/GET, MaxAge 86400).
    // Without this carve the miss fell to the unclaimed-path shell/engine
    // pair below — a browser received styled HTML for an asset path.
    const isAssetMiss = segments[0] === "assets" && segments.length >= 2;
    if (isAssetMiss) {
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "HEAD,GET",
            "access-control-max-age": "86400",
          },
        });
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response(null, { status: 405 });
      }
      return new Response(null, { status: 404 });
    }
    // "twirp" joins "api" in Hono-land: the artifacts-v4 mount (SPEC-0012
    // §2.1, init.go:205-206) lives at /twirp/github.actions.results.api.v1.
    // ArtifactService and is never repo-scoped.
    const isRepoScoped =
      segments.length >= 2 &&
      segments[1] !== "" &&
      segments[0] !== "api" &&
      segments[0] !== "twirp" &&
      segments[0] !== "v2" && // the OCI root mount (api.go:509) — /v2/{owner}/… is NOT repo-scoped
      !isAvatarServing &&
      !isAttachmentServing &&
      !isWellKnown &&
      !isLoginPath;
    if (isRepoScoped) {
      // All methods for the UI's write families (new/edit/delete file,
      // new-issue, comments, settings, milestones — waves 4-8 are POSTs on
      // 3+-segment paths parseUiRoute owns; it never claims git-protocol
      // routes). ONE carve-out: a bare two-segment DELETE is the engine
      // admin wipe (the vendored e2e suite's repo-clearing channel and the
      // D1-missing transitional population's only delete) — the gate's
      // engine-path branch owns it (D1-resolved repos get the §2.5.5
      // cascade there). The UI has no DELETE handlers, so the carve-out
      // costs nothing. Trailing-slash rule keeps pre-UI ownership identical —
      // except the lastcommit carve directly below (RD19), the one family
      // whose upstream-faithful emit is slashed.
      const engineAdminRootDelete = req.method === "DELETE" && segments.length === 2;
      // THE LASTCOMMIT CARVE (RD19): the wave-46 file-list component emits the
      // loader URL exactly as upstream's view.go:277 builds it — RepoLink +
      // "/lastcommit/" + PathEscape(CommitID) + "/" + PathEscapeSegments(
      // TreePath) — and for ROOT listings TreePath is "", so the URL keeps the
      // trailing slash; upstream serves that shape through its own wildcard
      // (web.go:1761 m.Get("/lastcommit/*")), so the slashed emit IS the
      // upstream-faithful bytes. The blanket rule above would hand every
      // repo-scoped slash path to the engine (404) before the sub-app's
      // `/:owner/:repo/lastcommit/*` route — which matches the slash form and
      // answers it in place, upstream parity — ever saw it. The exception is
      // deliberately NARROW: only the third-segment lastcommit head, only
      // when the TRIMMED path is one the parser claims (handlesUiRoute stays
      // the single source of route truth — the sub-app is never handed
      // something its parser disowns), and the engine keeps every other
      // trailing-slash shape (the pinned /:owner/:repo/ passthrough included).
      const lastcommitTrailingSlash =
        pathname.endsWith("/") && segments[2] === "lastcommit" && handlesUiRoute(pathname.slice(0, -1));
      // The wiki-scoped twin (usability sweep, 2026-10-30): upstream's wiki
      // itself EMITS slashed URLs — the missing-page fold's
      // RepoLink+"/wiki/?action=_pages" (wiki.go:238/340/400) and the view
      // dropdown's Pages item (view.tmpl:25) — and chi's Combo("/*") matches
      // every slashed wiki tail, so the carve is WIDE (any /wiki/…/ shape
      // the parser claims trimmed), not the exact-bare-emit narrower form.
      const wikiTrailingSlash =
        pathname.endsWith("/") && segments[2] === "wiki" && handlesUiRoute(pathname.slice(0, -1));
      if (
        !engineAdminRootDelete &&
        (lastcommitTrailingSlash || wikiTrailingSlash || (!pathname.endsWith("/") && handlesUiRoute(pathname)))
      ) {
        return app.fetch(req, env, ctx);
      }
      // THE UNCLAIMED-PATH 404 CARVE (usability sweep, 2026-10-29): a GET
      // whose shape no router claims used to reach the headless engine,
      // whose classify (packages/git-engine mod.ts) bare-404s (`not found\n`
      // plain text) everything that is not git-protocol/LFS/engine-JSON —
      // a browser on a mistyped repo URL saw naked text. Upstream answers
      // from the web router's NotFound with full 404 chrome for HTML
      // requests and a plain `Not found.` line otherwise
      // (routers/web/web.go:1819, context_response.go:129-151) — so the
      // negotiation below keeps the plain arm exactly where it was (the
      // gate/engine answer, byte-identical: git clients, curl, HEAD, POST,
      // trailing slashes, the e2e passthrough) and renders the shell only
      // for an HTML GET that the engine provably cannot serve. The tail
      // test mirrors the engine's escape set: `info/refs` and `HEAD` (the
      // gate's git routes), `info/lfs/*` (the gate's LFS branch),
      // `api/*` (the engine JSON surface) stay delegated; everything else —
      // junk tails AND unclaimed bare pairs (/explore/junk — the reserved
      // owner never parses, and the engine headless-404s the repo root
      // shape too) — is pages-shaped. `?go-get=1` stays delegated on any
      // shape — the go tool's meta probe must never get HTML.
      if (req.method === "GET" && !pathname.endsWith("/") && new URL(req.url).searchParams.get("go-get") !== "1") {
        const acceptsHtml = (req.headers.get("accept") ?? "").includes("text/html");
        const tail = `/${segments.slice(2).join("/")}`;
        const engineServed =
          tail === "/info/refs" ||
          tail === "/HEAD" ||
          tail.startsWith("/info/lfs/") ||
          tail.startsWith("/api/");
        if (acceptsHtml && !engineServed) {
          // Direct dispatcher exit — never routed through Hono, so the
          // security-headers stamp rides here (web/security-headers.ts; the
          // shell is text/html → nosniff + SAMEORIGIN + the page CSP).
          return withSecurityHeaders(
            await renderNotFoundShellResponse(env, req, { waitUntil: ctx.waitUntil.bind(ctx) }),
          );
        }
      }
      // The gate/engine passthrough: git-protocol, LFS, engine-JSON and the
      // plain `not found\n` arms — upstream's SecurityHeadersHandler is
      // tree-wide (its git endpoints leave through it too), so the stamp
      // rides the exit: headers only, the engine's bytes and protocol
      // surface untouched (body carried by reference, never buffered).
      return withSecurityHeaders(await gitHttpGate(req, env, ctx, gitHttp));
    }

    // Everything else (healthz, /api/v1, bare paths) is Hono's, whose
    // default is a 404.
    return app.fetch(req, env, ctx);
  },

  // Cron producer (SPEC-0009 §2.6): the 10-minute mirror cadence selects the
  // due repo_mirrors rows, CAS-claims each idle → queued and enqueues one
  // {kind: "mirror-sync"} message per claim. Sub-hour crons get a 30 s CPU
  // budget (AGENTS.md Workers rules) — SELECT + enqueue ONLY here; the sync
  // itself runs in the REPO_TASKS consumer (handleRepoTasks →
  // handleMirrorSync).
  //
  // THE TICK STATE (usability F3, docs/usability/findings-latency-health.md):
  // after each entry resolves, every arm the entry carries (services/
  // cron-state.ts armsForEntry — the exact handleScheduledCron dispatch
  // mirror) gets ONE multi-row upsert recording the completed tick (cheap,
  // ctx.waitUntil — the entry's real work already happened, the recording
  // never fails it). A REJECTED entry stamps last_error on the same arms and
  // RETHROWS untouched — the platform's error visibility is exactly the
  // pre-F3 behavior. The granularity is ENTRY-ATOMIC by construction (the
  // recorder wraps the one delegation; per-producer attribution lives only
  // in the dispatcher's own log lines) — services/cron-state.ts's module
  // header pins the semantics. The admin monitor's cron page reads the rows
  // (loadAdminMonitorCronRunState) — "did the crons run today" is
  // certifiable from the product surface.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // SPEC-0014 M1 dispatch + the sanctioned extensions: the hourly string
    // runs the FULL census arms — the demo sweep producer (gate-checked,
    // silent when off) plus the audit/packages/actions-retention producers
    // and the actions-abandoned + ephemeral pair; every other cadence runs
    // the mirror producers unconditionally (their CAS absorbs overlaps)
    // joined by the zombie/endless stop producers. services/cron-state.ts's
    // armsForEntry is the census mirror of exactly this dispatch.
    const arms = armsForEntry(controller.cron);
    try {
      await handleScheduledCron(controller, env);
    } catch (error) {
      ctx.waitUntil(
        recordArmsFailure(env.DB, arms, error).catch((recordError) => {
          console.error("[cron-state] failure stamp not recorded", recordError);
        }),
      );
      throw error;
    }
    ctx.waitUntil(
      recordArmsSuccess(env.DB, arms).catch((recordError) => {
        console.error("[cron-state] success tick not recorded", recordError);
      }),
    );
  },

  // Queue consumers: REPO_TASKS = delete purge (SPEC-0003 §2.5.5), import
  // tasks (§2.6) and mirror syncs (SPEC-0009 §2.6) — one serialized dispatch
  // (handleRepoTasks); webhook-delivery (+dlq) = SPEC-0005 §3.6 deliveries.
  // The runtime delivers MessageBatch<unknown>; each consumer narrows to its
  // own type.
  async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext) {
    if (batch.queue === "webhook-delivery-dlq") {
      return webhookDlqHandler(batch as unknown as Parameters<typeof webhookDlqHandler>[0], env, _ctx);
    }
    if (batch.queue === "webhook-delivery") {
      return webhookQueueHandler(batch as unknown as Parameters<typeof webhookQueueHandler>[0], env, _ctx);
    }
    // SPEC-0014 §3.0 M0: the repo-tasks DLQ — log-and-ack, the record for
    // manual redrive (the handler takes MessageBatch<unknown> natively).
    if (batch.queue === "repo-tasks-dlq") {
      return repoTasksDlqHandler(batch, env, _ctx);
    }
    await handleRepoTasks(batch, env);
  },

  // Inbound email (specs/email-inbound.md §3.1/§6): Cloudflare Email
  // Routing delivers to this arm — NO binding, NO wrangler config (the
  // export is the whole story; `send_email` in the config schema is the
  // outbound-only binding the outbound SPEC already rejected). Thin mount
  // by construction: the vitest plugin cannot deliver to an email handler
  // (no runtime email test exists), so ALL behavior lives in
  // services/mail/inbound.ts behind the structural InboundEmailMessage
  // surface and the suite drives it at the service level. A persistence
  // failure THROWS out (the platform processing-failure signal); every
  // other outcome is logged + recorded in `email_inbound` and consumed.
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleIncomingEmail(env, message);
  },
} satisfies ExportedHandler<Env>;

// Durable Object classes must be exported from the Worker entry point.
// RepoCell = per-repo git storage engine (SPEC-0001); Registry = repo index.
export { Registry, RepoCell };
