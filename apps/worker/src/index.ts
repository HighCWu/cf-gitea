import { Hono } from "hono";

import { createDurableGit, Registry, RepoCell } from "@cf-gitea/git-engine";
import { resolveAuth, tokenRouter } from "./auth";
import {
  rejectPublicOnly,
  rejectPublicOnlyUserAssignment,
  sudo,
} from "./auth/middleware";
import { createApiRouter } from "./api/router";
import { createPackagesProtocolRouter } from "./api/routes/packages";
import { createEcosystemProtocolRouter } from "./api/routes/packages-protocols";
import { createActionsRouter } from "./services/actions/routes";
import { authorize } from "./git-http/authorize";
import { gitHttpGate } from "./git-http/gate";
import { handleRepoTasks } from "./repos/purge";
import { repoTasksDlqHandler } from "./repos/dlq";
import { handleUserPushEvent } from "./services/webhooks-push";
import { enqueuePushMirrorSyncsOnCommit } from "./services/mirror/push-sync";
import { handleScheduledCron } from "./services/demo-sweep";
import { handlesUiRoute, uiRouter } from "./ui";
import { sessionRouter } from "./ui/session";
import { firstRunRouter } from "./ui/first-run";
import { avatarServingRouter } from "./web/avatar-serving";
import { attachmentsServingRouter } from "./web/attachments-serving";
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
 *   plumbs authenticated identity). Mirror/import receives use their own
 *   engine instances without the hook (no double emission).
 * - `REPO_PACKS` (R2) is bound and used by the engine's receive path for
 *   pack staging + final packs (SPEC-0001a §3 Step 1). The full-clone cache
 *   key family (`clone-cache/`) stays unwritten until M4 (SPEC-0001 §10).
 */
const gitHttp = createDurableGit<Env>({
  authorize,
  ui: false,
  namespaces: true,
  onPush: (event, env) => {
    // Sync-on-commit producer (SPEC specs/push-mirror-outbound.md §4.1;
    // upstream syncPushMirrorWithSyncOnCommit, mirror_push.go:250-260) —
    // best-effort enqueue, never fails the push (the helper catches its own).
    void enqueuePushMirrorSyncsOnCommit(env, event.repo);
    return handleUserPushEvent(env, event);
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
  console.error(`500 answering ${c.req.method} ${c.req.url}`, error);
  const headers = {
    // SetCacheControlInHeader zero-options (errpage.go:87 → httpcache.go:29-31).
    "cache-control": "max-age=0, private, must-revalidate",
  };
  const acceptsHtml = (c.req.header("accept") ?? "").includes("text/html");
  if (!acceptsHtml) {
    return c.text("Internal Server Error", 500, headers);
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
    return await renderServerErrorShellResponse(c.env, c.req.raw, { waitUntil });
  } catch (renderError) {
    console.error("500 shell render failed", renderError);
    return c.text(
      "Internal server error but failed to render error page template, please collect error logs and report to Gitea issue tracker",
      500,
      headers,
    );
  }
});

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

// /api/actions (SPEC-0012 §2.1, M1a): the runner protocol — the ping echo +
// the connect-RPC RunnerService mounts under /<service-name>/<Method>
// (upstream actions.go:22-26), with the runner interceptor living inside the
// sub-app (x-runner-uuid/token auth + debounced heartbeats). No resolveAuth
// mount: the runner protocol's credential model is its own (registration
// tokens + runner polling tokens, NOT /api/v1 tokens). UpdateTask/UpdateLog
// authenticate, then answer unimplemented until M1b.
app.route("/api/actions", createActionsRouter());

// Avatar serving (web mux at the pin — routers/web/base.go): mounted BEFORE
// uiRouter so its literal /avatar, /avatars and /user/avatar routes always
// win over the UI's /:owner/:repo parser shape.
app.route("/", avatarServingRouter);
// Attachments serving (web.go:912): plain Hono seam — mounted before uiRouter
// so the literal /attachments/:uuid route wins over any page-parser shape.
app.route("/", attachmentsServingRouter);
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
// SPEC-0010: /login + /logout are single-segment top-level routes (§2.1) —
// never repo-scoped, so the dispatcher and the engine never see them.
app.route("/", sessionRouter);

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
    const isRepoScoped =
      segments.length >= 2 && segments[1] !== "" && segments[0] !== "api" && !isAvatarServing && !isAttachmentServing;
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
      if (
        !engineAdminRootDelete &&
        (lastcommitTrailingSlash || (!pathname.endsWith("/") && handlesUiRoute(pathname)))
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
          return renderNotFoundShellResponse(env, req, { waitUntil: ctx.waitUntil.bind(ctx) });
        }
      }
      return gitHttpGate(req, env, ctx, gitHttp);
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
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    // SPEC-0014 M1 dispatch: the hourly string runs ONLY the demo sweep
    // producer (gate-checked, silent when off); every other cadence runs the
    // mirror producers unconditionally (their CAS absorbs overlaps).
    await handleScheduledCron(controller, env);
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
} satisfies ExportedHandler<Env>;

// Durable Object classes must be exported from the Worker entry point.
// RepoCell = per-repo git storage engine (SPEC-0001); Registry = repo index.
export { Registry, RepoCell };
