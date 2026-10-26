import { Hono } from "hono";

import { createDurableGit, Registry, RepoCell } from "@cf-gitea/git-engine";
import { resolveAuth, tokenRouter } from "./auth";
import { createApiRouter } from "./api/router";
import { authorize } from "./git-http/authorize";
import { gitHttpGate } from "./git-http/gate";
import { handleRepoTasks } from "./repos/purge";
import { enqueueDueMirrorSyncs } from "./services/mirror/sync";
import { handleUserPushEvent } from "./services/webhooks-push";
import { enqueueDuePushMirrorSyncs, enqueuePushMirrorSyncsOnCommit } from "./services/mirror/push-sync";
import { handlesUiRoute, uiRouter } from "./ui";
import { sessionRouter } from "./ui/session";
import { avatarServingRouter } from "./web/avatar-serving";
import { attachmentsServingRouter } from "./web/attachments-serving";
import { webhookDlqHandler } from "./webhooks/dlq";
import { webhookQueueHandler } from "./webhooks/consumer";

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

app.get("/healthz", (c) => c.json({ ok: true }));

// /api/v1 (SPEC-0002/0004): resolveAuth parses credentials (anonymous stays
// anonymous; its D1-verified identity wins inside the api middlewares);
// tokenRouter carries token CRUD; createApiRouter mounts the zod-openapi
// tier-1 surface (version/user/repos/users/markdown + batches), declared
// against the frozen contract (pnpm check:api).
app.use("/api/v1/*", resolveAuth());
app.route("/api/v1", tokenRouter);
app.route("/api/v1", createApiRouter());

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
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    await enqueueDueMirrorSyncs(env, {});
    // Push-mirror cadence (SPEC §4): same 30 s cron CPU shape — SELECT +
    // enqueue only; the REPO_TASKS consumer performs the pushes.
    await enqueueDuePushMirrorSyncs(env, {});
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
    await handleRepoTasks(batch, env);
  },
} satisfies ExportedHandler<Env>;

// Durable Object classes must be exported from the Worker entry point.
// RepoCell = per-repo git storage engine (SPEC-0001); Registry = repo index.
export { Registry, RepoCell };
