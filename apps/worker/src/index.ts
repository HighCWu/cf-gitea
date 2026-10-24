import { Hono } from "hono";

import { createDurableGit, Registry, RepoCell } from "@cf-gitea/git-engine";
import { resolveAuth, tokenRouter } from "./auth";
import { authorize } from "./git-http/authorize";
import { gitHttpGate } from "./git-http/gate";

/**
 * Git smart-HTTP engine mount (SPEC-0001 M1).
 *
 * The engine handler owns every repository-scoped path. With `namespaces`
 * repositories are /:owner/:repo[.git]/... (Gitea/GitHub-style two-segment
 * names): `info/refs`, `git-upload-pack`, `git-receive-pack`, the repo admin
 * endpoints (config/gc/DELETE) and the repo JSON API — everything the handler
 * classifies as protocol/api/admin.
 *
 * - `ui: false` runs it headless: repo pages 404 so the official Gitea
 *   frontend owns the UI (AGENTS.md project overview).
 * - `cors` unset: no cross-origin engine API yet.
 * - `onPush` unset: repo bookkeeping stays inside the engine (registry DO)
 *   until SPEC-0003 wires repo lifecycle to D1.
 * - `PACK_CACHE` (R2 full-clone fast path) intentionally not bound yet —
 *   SPEC-0001 §10 defers the clone cache; the engine degrades to the DO path.
 */
const gitHttp = createDurableGit<Env>({ authorize, ui: false, namespaces: true });

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => c.json({ ok: true }));

// /api/v1 (SPEC-0002/0004): resolveAuth parses credentials (anonymous stays
// anonymous); tokenRouter carries the token CRUD. The zod-openapi API router
// (version/user, then tier-1 batches) mounts alongside once its real auth
// resolver wiring lands with the tier-1 batch work.
app.use("/api/v1/*", resolveAuth());
app.route("/api/v1", tokenRouter);

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(req.url);
    const segments = pathname.slice(1).split("/");

    // Repository-scoped requests (/owner/repo[/...]) first run the
    // SPEC-0003 M1 gitHttpGate pipeline (parse → go-get/HEAD → resolve repo
    // in D1 → ACL matrix §2.4): it answers the matrix/go-get/HEAD routes
    // itself and otherwise delegates to the engine. Repositories without a
    // D1 row (everything predating lifecycle, incl. the e2e suite) pass
    // through to the engine verbatim — method, URL and body untouched so
    // push bodies stream straight into the storage DO (AGENTS.md Workers
    // rules). The engine parses the exact repo/sub-path and answers 404 for
    // malformed, reserved, or unknown non-push paths.
    // "api" stays in Hono-land for /api/v1 (SPEC-0004).
    const isRepoScoped =
      segments.length >= 2 && segments[1] !== "" && segments[0] !== "api";
    if (isRepoScoped) return gitHttpGate(req, env, ctx, gitHttp);

    // Everything else (healthz, future /api/v1, bare paths) is Hono's, whose
    // default is a 404.
    return app.fetch(req, env, ctx);
  },
} satisfies ExportedHandler<Env>;

// Durable Object classes must be exported from the Worker entry point.
// RepoCell = per-repo git storage engine (SPEC-0001); Registry = repo index.
export { Registry, RepoCell };
