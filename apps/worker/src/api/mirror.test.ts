/**
 * Mirror/migrate routes (SPEC-0009 §2.2/§2.3) on real D1 — the repo-scoped
 * non-contract surface (POST migrate into an existing empty repo, GET the
 * sync_state row, POST mirror-sync).
 *
 * NO REAL REMOTE anywhere: the routes never fetch (the sync runs on the
 * queue consumer), so the "remote" in these fixtures is the recording
 * MIRROR_SYNC_QUEUE stub plus the D1 rows it implies. The one deliberate
 * crossing into the sync module is the §4.2 envelope verification — the
 * encrypted ciphertext is decrypted back through sync.ts's
 * `mirrorAuthHeader`, proving the service's encrypt half satisfies the
 * consumer's exact contract (AAD binding included).
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { OpenAPIHono } from "@hono/zod-openapi";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { repoImports, repoMirrors, repositories, users } from "../db/schema";
import { createStubAuthResolver, createTokenAuthMiddleware, type AuthResolver } from "./auth";
import type { ApiEnv } from "./env";
import { giteaErrorHandler } from "./errors";
import { registerMirrorRoutes } from "./routes/mirror";
import { mirrorAuthHeader } from "../services/mirror/sync";
import {
  MIRROR_MIN_INTERVAL_SECONDS,
  MirrorCredentialKeyError,
  MirrorValidationError,
  parseGoDuration,
  parsePatchMirrorInterval,
  renderGoDuration,
  updateMirrorSettings,
} from "./services/mirror";

const TOKEN = "stub-token"; // STUB_USER (id 1) — the repo owner
const TOKEN_OTHER = "other-token"; // 'other' — a plain user
const SOURCE_URL = "https://src.example.com/org/repo.git";

/** The §4.2 KEK — 32 bytes, base64 (what `wrangler secret put` would hold). */
const KEK = btoa(
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => String.fromCharCode(b)).join(""),
);

let otherUserId = 0;

function userIdentity(id: number, login: string) {
  return {
    id,
    login,
    email: "",
    full_name: login,
    avatar_url: "",
    html_url: "",
    language: "en-US",
    location: "",
    website: "",
    description: "",
    active: true,
    is_admin: false,
    prohibit_login: false,
    restricted: false,
    login_name: "",
    source_id: 0,
    followers_count: 0,
    following_count: 0,
    starred_repos_count: 0,
    created: "2026-01-01T00:00:00Z",
    last_login: "0001-01-01T00:00:00Z",
    type: "User" as const,
    visibility: "public" as const,
  };
}

interface RecordingQueue extends Queue {
  sent: unknown[];
}

/** MIRROR_SYNC_QUEUE stub — the "remote" of these fixtures is this recorder
 *  plus the D1 rows; nothing here performs a network fetch. */
function recordingQueue(): RecordingQueue {
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  const sent: unknown[] = [];
  return {
    sent,
    send: (body: unknown) => {
      sent.push(body);
      return Promise.resolve({ metadata });
    },
    sendBatch: () => Promise.resolve({ metadata }),
    metrics: () => Promise.resolve({ backlogCount: 0, backlogBytes: 0 }),
  };
}

type App = (path: string, init?: RequestInit) => Promise<Response>;

function makeApp(queue: RecordingQueue, extraEnv: Record<string, string | undefined> = {}): App {
  const resolver: AuthResolver = {
    resolveToken: (token) => {
      if (token === TOKEN) return createStubAuthResolver().resolveToken(token);
      if (token === TOKEN_OTHER) return Promise.resolve(userIdentity(otherUserId, "other"));
      return Promise.resolve(null);
    },
  };
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerMirrorRoutes(app, createTokenAuthMiddleware(resolver));
  return (path, init) =>
    Promise.resolve(
      app.fetch(new Request(`https://example.com${path}`, init), {
        ...env,
        MIRROR_SYNC_QUEUE: queue,
        ...extraEnv,
      }),
    );
}

function migrateBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { clone_addr: SOURCE_URL, mirror: true, ...extra };
}

async function seedRepo(overrides: Partial<typeof repositories.$inferInsert> = {}): Promise<void> {
  await drizzle(env.DB).insert(repositories).values({
    id: "7401",
    storageKey: "r_7401",
    ownerNamespace: "cf-gitea-stub",
    ownerId: 1,
    slug: "mirror-me",
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    ...overrides,
  });
}

async function seedMirrorRow(overrides: Partial<typeof repoMirrors.$inferInsert> = {}): Promise<void> {
  await drizzle(env.DB).insert(repoMirrors).values({
    repoId: "7401",
    intervalSeconds: 28800,
    enablePrune: true,
    remoteAddress: SOURCE_URL,
    syncState: "idle",
    nextSyncAt: 0,
    ...overrides,
  });
}

const jsonAuth = { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" };
const repoBase = "/repos/cf-gitea-stub/mirror-me";

beforeAll(async () => {
  // Applies the full generated migration ledger (0010 included) — the
  // repo_mirrors table and the repositories mirror columns exist here.
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["repo_mirrors", "repo_imports", "repositories", "personal_access_tokens"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users").run();
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  const other = await drizzle(env.DB)
    .insert(users)
    .values({ username: "other", usernameLower: "other", status: "active", createdAt: new Date() })
    .returning({ id: users.id })
    .all();
  otherUserId = other[0]!.id;
});

// ---------------------------------------------------------------------------
// duration helpers (the mirror_interval grammar)
// ---------------------------------------------------------------------------

describe("Go-duration helpers", () => {
  it("parses the compound units and the 0-disable form", () => {
    expect(parseGoDuration("0")).toBe(0);
    expect(parseGoDuration("45s")).toBe(45);
    expect(parseGoDuration("30m")).toBe(1800);
    expect(parseGoDuration("8h30m")).toBe(30600);
    expect(parseGoDuration("2h")).toBe(7200);
    expect(parseGoDuration("1500ms")).toBe(1);
  });

  it("rejects signed, float, empty and unknown-unit forms", () => {
    for (const raw of ["", "-5m", "5.5m", "soon", "10", "1w", "0s0x"]) {
      expect(parseGoDuration(raw), raw).toBeNull();
    }
  });

  it("renders the Duration.String() whole-second form", () => {
    expect(renderGoDuration(0)).toBe("0");
    expect(renderGoDuration(28800)).toBe("8h0m0s");
    expect(renderGoDuration(1800)).toBe("30m0s");
    expect(renderGoDuration(45)).toBe("45s");
  });
});

// ---------------------------------------------------------------------------
// POST /repos/{owner}/{repo}/migrate
// ---------------------------------------------------------------------------

describe("POST /repos/{owner}/{repo}/migrate", () => {
  it("registers the mirror row, flips the repo, and kicks exactly one sync message (202)", async () => {
    await seedRepo();
    const queue = recordingQueue();
    const app = makeApp(queue, { MIRROR_CREDENTIAL_KEY: KEK });

    const res = await app(`${repoBase}/migrate`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify(migrateBody({ auth_token: "tok-123" })),
    });
    expect(res.status).toBe(202);
    const body = await res.json<Record<string, unknown>>();
    expect(body.remote_address).toBe(SOURCE_URL);
    expect(body.original_url).toBe(SOURCE_URL);
    expect(body.sync_state).toBe("idle");
    expect(body.mirror_interval).toBe("8h0m0s");
    expect(body.interval_seconds).toBe(28800);
    expect(body.enable_prune).toBe(true);
    expect(body.next_sync_at).toBeGreaterThan(0);
    expect(body.last_sync_at).toBeNull();
    // the credential NEVER appears on any response surface (§4.2)
    expect(JSON.stringify(body)).not.toContain("tok-123");

    const row = await drizzle(env.DB).select().from(repoMirrors).where(eq(repoMirrors.repoId, "7401")).get();
    expect(row).toBeDefined();
    expect(row!.remoteAddress).toBe(SOURCE_URL);
    expect(row!.credentialsCiphertext).not.toBeNull();
    expect(row!.syncState).toBe("idle");

    const repo = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "7401")).get();
    expect(repo!.isMirror).toBe(true);
    expect(repo!.originalUrl).toBe(SOURCE_URL);

    expect(queue.sent).toEqual([{ kind: "mirror-sync", repoId: "7401" }]);
  });

  it("seals basic credentials in the §4.2 envelope — decrypts through the sync consumer's mirrorAuthHeader", async () => {
    await seedRepo();
    const app = makeApp(recordingQueue(), { MIRROR_CREDENTIAL_KEY: KEK });
    const res = await app(`${repoBase}/migrate`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify(migrateBody({ auth_username: "user", auth_password: "pass" })),
    });
    expect(res.status).toBe(202);

    const row = await drizzle(env.DB).select().from(repoMirrors).where(eq(repoMirrors.repoId, "7401")).get();
    expect(row!.credentialsUsername).toBe("user");
    const header = await mirrorAuthHeader({ ...env, MIRROR_CREDENTIAL_KEY: KEK }, row!);
    expect(header).toBe(`Basic ${btoa("user:pass")}`);
  });

  // wave-polish-matrix-12 — the pull channel's remaining auth field shapes
  // (deriveMirrorAuthHeader, api/services/mirror.ts:222-230): each half alone
  // composes its Basic value; the empty pair derives NULL — anonymous, no KEK
  // consulted, nothing sealed.
  it("seals username-only and password-only credentials; the empty pair stays anonymous", async () => {
    await seedRepo();
    const app = makeApp(recordingQueue(), { MIRROR_CREDENTIAL_KEY: KEK });
    const post = (extra: Record<string, unknown>) =>
      app(`${repoBase}/migrate`, {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify(migrateBody(extra)),
      });
    const readRow = () => drizzle(env.DB).select().from(repoMirrors).where(eq(repoMirrors.repoId, "7401")).get();
    const reset = () =>
      Promise.all([
        env.DB.prepare("DELETE FROM repo_mirrors").run(),
        env.DB.prepare("UPDATE repositories SET is_mirror = 0, original_url = NULL").run(),
      ]);

    await post({ auth_username: "user" });
    let row = await readRow();
    expect(row!.credentialsUsername).toBe("user");
    expect(await mirrorAuthHeader({ ...env, MIRROR_CREDENTIAL_KEY: KEK }, row!)).toBe(`Basic ${btoa("user:")}`);
    await reset();

    await post({ auth_password: "pass" });
    row = await readRow();
    expect(row!.credentialsUsername).toBeNull(); // only auth_username lands in the column
    expect(await mirrorAuthHeader({ ...env, MIRROR_CREDENTIAL_KEY: KEK }, row!)).toBe(`Basic ${btoa(":pass")}`);
    await reset();

    // The empty pair: derives null — no ciphertext even with the KEK present.
    await post({ auth_username: "", auth_password: "" });
    row = await readRow();
    expect(row!.credentialsCiphertext).toBeNull();
  });

  it("prefers the bearer token when both auth forms arrive (documented divergence)", async () => {
    await seedRepo();
    const app = makeApp(recordingQueue(), { MIRROR_CREDENTIAL_KEY: KEK });
    await app(`${repoBase}/migrate`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify(
        migrateBody({ auth_token: "tok", auth_username: "user", auth_password: "pass" }),
      ),
    });
    const row = await drizzle(env.DB).select().from(repoMirrors).where(eq(repoMirrors.repoId, "7401")).get();
    expect(await mirrorAuthHeader({ ...env, MIRROR_CREDENTIAL_KEY: KEK }, row!)).toBe("Bearer tok");
  });

  it("stores no ciphertext for an anonymous mirror and never needs the KEK", async () => {
    await seedRepo();
    const app = makeApp(recordingQueue()); // no MIRROR_CREDENTIAL_KEY
    const res = await app(`${repoBase}/migrate`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify(migrateBody()),
    });
    expect(res.status).toBe(202);
    const row = await drizzle(env.DB).select().from(repoMirrors).where(eq(repoMirrors.repoId, "7401")).get();
    expect(row!.credentialsCiphertext).toBeNull();
  });

  it("fails cleanly (500) when credentials arrive without a usable KEK — before any write", async () => {
    await seedRepo();
    const queue = recordingQueue();
    // Explicit absence (ADR-0005 D3): the ambient env may carry
    // MIRROR_CREDENTIAL_KEY from .dev.vars — the test needs it unset.
    const app = makeApp(queue, { MIRROR_CREDENTIAL_KEY: undefined });
    const res = await app(`${repoBase}/migrate`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify(migrateBody({ auth_token: "tok" })),
    });
    expect(res.status).toBe(500);
    const mirrored = await drizzle(env.DB).select().from(repoMirrors).where(eq(repoMirrors.repoId, "7401")).get();
    expect(mirrored).toBeUndefined();
    const repo = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "7401")).get();
    expect(repo!.isMirror).toBe(false);
    expect(queue.sent).toEqual([]);
  });

  it("rejects a malformed KEK (not 32 bytes) the same way", async () => {
    await seedRepo();
    const app = makeApp(recordingQueue(), { MIRROR_CREDENTIAL_KEY: btoa("short") });
    const res = await app(`${repoBase}/migrate`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify(migrateBody({ auth_token: "tok" })),
    });
    expect(res.status).toBe(500);
  });

  it("422s the §2.2 validation family and writes nothing", async () => {
    await seedRepo();
    const queue = recordingQueue();
    const app = makeApp(queue, { MIRROR_CREDENTIAL_KEY: KEK });
    const cases: [Record<string, unknown>, string][] = [
      [{ clone_addr: "http://src.example.com/r.git" }, "The provided URL is invalid."],
      [{ clone_addr: "https://user:pass@src.example.com/r.git" }, "The provided URL is invalid."],
      [{ clone_addr: "not a url" }, "The provided URL is invalid."],
      [migrateBody({ clone_addr: "https://10.0.0.1/r.git" }), "You can not import from disallowed hosts."],
      [migrateBody({ mirror_interval: "soon" }), "invalid mirror_interval"],
      [migrateBody({ mirror_interval: "5m" }), "below the minimum"],
      [migrateBody({ service: "github" }), "unsupported service"],
      [migrateBody({ issues: true }), "metadata migration is not supported for this service"],
      [migrateBody({ wiki: true }), "metadata migration is not supported for this service"],
      [{ clone_addr: SOURCE_URL }, "requires mirror=true"],
      [migrateBody({ mirror: false }), "requires mirror=true"],
      [{}, "invalid migrate options"],
    ];
    for (const [body, message] of cases) {
      const res = await app(`${repoBase}/migrate`, {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(422);
      const errBody = await res.json<{ message: string }>();
      expect(errBody.message).toContain(message);
    }
    expect(queue.sent).toEqual([]);
    const row = await drizzle(env.DB).select().from(repoMirrors).where(eq(repoMirrors.repoId, "7401")).get();
    expect(row).toBeUndefined();
  });

  it("accepts a custom interval and the 0-disable form", async () => {
    await seedRepo();
    const app = makeApp(recordingQueue(), { MIRROR_CREDENTIAL_KEY: KEK });
    for (const [interval, seconds, rendered] of [
      ["30m", 1800, "30m0s"],
      ["0", 0, "0"],
    ] as const) {
      const res = await app(`${repoBase}/migrate`, {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify(migrateBody({ mirror_interval: interval })),
      });
      expect(res.status, interval).toBe(202);
      const body = await res.json<Record<string, unknown>>();
      expect(body.interval_seconds, interval).toBe(seconds);
      expect(body.mirror_interval, interval).toBe(rendered);
      // reset for the next round
      await env.DB.prepare("DELETE FROM repo_mirrors").run();
      await env.DB.prepare("UPDATE repositories SET is_mirror = 0, original_url = NULL").run();
    }
  });

  it("stores the gated lfs_endpoint and the lfs flag", async () => {
    await seedRepo();
    const app = makeApp(recordingQueue(), { MIRROR_CREDENTIAL_KEY: KEK });
    const res = await app(`${repoBase}/migrate`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify(migrateBody({ lfs: true, lfs_endpoint: "https://lfs.example.com/git/lfs" })),
    });
    expect(res.status).toBe(202);
    const body = await res.json<Record<string, unknown>>();
    expect(body.lfs_enabled).toBe(true);
    expect(body.lfs_endpoint).toBe("https://lfs.example.com/git/lfs");
  });

  it("422s a disallowed lfs_endpoint with the same gate", async () => {
    await seedRepo();
    const app = makeApp(recordingQueue(), { MIRROR_CREDENTIAL_KEY: KEK });
    const res = await app(`${repoBase}/migrate`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify(migrateBody({ lfs_endpoint: "https://foo.internal/lfs" })),
    });
    expect(res.status).toBe(422);
  });

  it("409s on: an existing mirror, a non-empty repo, an archived repo, a migrating repo, an active import", async () => {
    await seedRepo();
    const app = makeApp(recordingQueue(), { MIRROR_CREDENTIAL_KEY: KEK });
    const call = () =>
      app(`${repoBase}/migrate`, { method: "POST", headers: jsonAuth, body: JSON.stringify(migrateBody()) });

    // an active import (the import channel's arbitration, §2.2 row 5)
    await drizzle(env.DB).insert(repoImports).values({
      repoId: "7401",
      importTokenSha256: "0".repeat(64),
      state: "staged",
      chunkCap: 1024,
      totalBytes: 0,
      staged: "{}",
      heartbeatAt: new Date(),
    });
    expect((await call()).status).toBe(409);
    await env.DB.prepare("DELETE FROM repo_imports").run();

    expect((await call()).status).toBe(202); // the first registration wins
    expect((await call()).status).toBe(409); // second migrate — already a mirror

    // non-empty / archived / migrating all lose the batch CAS (row 5 family)
    for (const overrides of [{ isEmpty: false }, { isArchived: true }, { status: "migrating" as const }]) {
      await env.DB.prepare("DELETE FROM repo_mirrors").run();
      await env.DB.prepare("UPDATE repositories SET is_mirror = 0, original_url = NULL").run();
      await drizzle(env.DB)
        .update(repositories)
        .set(overrides)
        .where(eq(repositories.id, "7401"));
      expect((await call()).status, JSON.stringify(overrides)).toBe(409);
    }
  });

  it("accepts-and-ignores the create-shaped fields (repo_name, description, private)", async () => {
    await seedRepo();
    const app = makeApp(recordingQueue(), { MIRROR_CREDENTIAL_KEY: KEK });
    const res = await app(`${repoBase}/migrate`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify(
        migrateBody({ repo_name: "other-name", repo_owner: "someone", description: "x", private: true, uid: 7 }),
      ),
    });
    expect(res.status).toBe(202);
  });

  it("401s anonymous, 403s a non-owner on a public repo, 404s an invisible private repo", async () => {
    await seedRepo();
    const queue = recordingQueue();
    const owner = makeApp(queue, { MIRROR_CREDENTIAL_KEY: KEK });
    expect(
      (await owner(`${repoBase}/migrate`, { method: "POST", body: JSON.stringify(migrateBody()) })).status,
    ).toBe(401);

    const otherHeaders = { Authorization: `token ${TOKEN_OTHER}`, "Content-Type": "application/json" };
    const other = makeApp(queue, { MIRROR_CREDENTIAL_KEY: KEK });
    expect((await other(`${repoBase}/migrate`, { method: "POST", headers: otherHeaders, body: "{}" })).status).toBe(
      403,
    );

    await drizzle(env.DB)
      .update(repositories)
      .set({ visibility: "private" })
      .where(eq(repositories.id, "7401"));
    expect((await other(`${repoBase}/migrate`, { method: "POST", headers: otherHeaders, body: "{}" })).status).toBe(
      404,
    );
  });
});

// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo}/mirror
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/mirror", () => {
  it("renders the sync_state row after a migrate (and never the credentials)", async () => {
    await seedRepo();
    const app = makeApp(recordingQueue(), { MIRROR_CREDENTIAL_KEY: KEK });
    await app(`${repoBase}/migrate`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify(migrateBody({ auth_token: "tok-123", mirror_interval: "30m" })),
    });
    const res = await app(repoBase + "/mirror", { headers: { Authorization: `token ${TOKEN}` } });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.remote_address).toBe(SOURCE_URL);
    expect(body.mirror_interval).toBe("30m0s");
    expect(body.sync_state).toBe("idle");
    expect(body.last_error).toBeNull();
    expect(JSON.stringify(body)).not.toContain("tok-123");
  });

  it("404s when the repo has no mirror row", async () => {
    await seedRepo();
    const app = makeApp(recordingQueue());
    const res = await app(repoBase + "/mirror", { headers: { Authorization: `token ${TOKEN}` } });
    expect(res.status).toBe(404);
    const body = await res.json<{ message: string }>();
    expect(body.message).toBe("repository has no mirror");
  });

  it("403s a non-owner (the status read is an owner/admin surface)", async () => {
    await seedRepo();
    await seedMirrorRow();
    const app = makeApp(recordingQueue());
    const res = await app(repoBase + "/mirror", { headers: { Authorization: `token ${TOKEN_OTHER}` } });
    expect(res.status).toBe(403);
  });

  // wave-polish-matrix-12 — the settled row's display arms: the sync's
  // UpdateMirrorSyncStatus columns (last_error verbatim, the unix last/next
  // stamps) pass straight through getMirrorStatus, and the repository's
  // original_url rides in from the repositories row so the response is
  // self-contained (api/services/mirror.ts getMirrorStatus, §2.3).
  it("renders the settled row: last_error, the sync stamps, and the repo's original_url", async () => {
    await seedRepo();
    await seedMirrorRow();
    await drizzle(env.DB)
      .update(repoMirrors)
      .set({ lastError: "boom: fetch failed", lastSyncAt: 1_760_000_000, nextSyncAt: 1_760_000_600 })
      .where(eq(repoMirrors.repoId, "7401"));
    await drizzle(env.DB)
      .update(repositories)
      .set({ isMirror: true, originalUrl: SOURCE_URL })
      .where(eq(repositories.id, "7401"));

    const app = makeApp(recordingQueue());
    const res = await app(repoBase + "/mirror", { headers: { Authorization: `token ${TOKEN}` } });
    expect(res.status).toBe(200);
    const body = await res.json<Record<string, unknown>>();
    expect(body.last_error).toBe("boom: fetch failed");
    expect(body.last_sync_at).toBe(1_760_000_000);
    expect(body.next_sync_at).toBe(1_760_000_600);
    expect(body.original_url).toBe(SOURCE_URL);
    expect(body.remote_address).toBe(SOURCE_URL);
    expect(body.sync_state).toBe("idle");
  });

  // wave-polish-matrix-12 — the in-flight states render verbatim: the
  // sync_state enum's queued/syncing arms (schema.ts's CHECK'd triple) are
  // exactly what a consumer-claim cycle puts in the column.
  it("renders the queued and syncing states verbatim", async () => {
    await seedRepo();
    await seedMirrorRow();
    const app = makeApp(recordingQueue());
    for (const state of ["queued", "syncing"] as const) {
      await drizzle(env.DB).update(repoMirrors).set({ syncState: state }).where(eq(repoMirrors.repoId, "7401"));
      const res = await app(repoBase + "/mirror", { headers: { Authorization: `token ${TOKEN}` } });
      expect(res.status, state).toBe(200);
      expect((await res.json<Record<string, unknown>>()).sync_state, state).toBe(state);
    }
  });

  // wave-polish-matrix-12 — the disabled mirror (interval 0, next_sync_at 0,
  // §2.6's "0 = disabled" form): the status renders the zero interval and the
  // MANUAL sync trigger still enqueues — the POST only consults the row's
  // existence, never the schedule (routes/mirror.ts's mirror-sync handler).
  it("renders the disabled (interval 0) mirror; the manual trigger still enqueues", async () => {
    await seedRepo();
    await drizzle(env.DB).insert(repoMirrors).values({
      repoId: "7401",
      intervalSeconds: 0,
      remoteAddress: SOURCE_URL,
      syncState: "idle",
      nextSyncAt: 0,
    });
    const app = makeApp(recordingQueue());
    const status = await app(repoBase + "/mirror", { headers: { Authorization: `token ${TOKEN}` } });
    expect(status.status).toBe(200);
    const body = await status.json<Record<string, unknown>>();
    expect(body.mirror_interval).toBe("0");
    expect(body.interval_seconds).toBe(0);
    expect(body.next_sync_at).toBe(0);

    const queue = recordingQueue();
    const synced = await makeApp(queue)(`${repoBase}/mirror-sync`, { method: "POST", headers: jsonAuth });
    expect(synced.status).toBe(200);
    expect(queue.sent).toEqual([{ kind: "mirror-sync", repoId: "7401" }]);
  });
});

// ---------------------------------------------------------------------------
// POST /repos/{owner}/{repo}/mirror-sync
// ---------------------------------------------------------------------------

describe("POST /repos/{owner}/{repo}/mirror-sync", () => {
  it("enqueues exactly one sync message and answers 200 empty (upstream AddPullMirrorToQueue shape)", async () => {
    await seedRepo();
    await seedMirrorRow();
    const queue = recordingQueue();
    const app = makeApp(queue);
    const res = await app(`${repoBase}/mirror-sync`, { method: "POST", headers: jsonAuth });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(queue.sent).toEqual([{ kind: "mirror-sync", repoId: "7401" }]);
  });

  it("400s 'Repository is not a mirror' (upstream text) when there is no mirror row", async () => {
    await seedRepo();
    const queue = recordingQueue();
    const app = makeApp(queue);
    const res = await app(`${repoBase}/mirror-sync`, { method: "POST", headers: jsonAuth });
    expect(res.status).toBe(400);
    const body = await res.json<{ message: string }>();
    expect(body.message).toBe("Repository is not a mirror");
    expect(queue.sent).toEqual([]);
  });

  it("409s an archived mirror repo", async () => {
    await seedRepo({ isArchived: true });
    await seedMirrorRow();
    const app = makeApp(recordingQueue());
    const res = await app(`${repoBase}/mirror-sync`, { method: "POST", headers: jsonAuth });
    expect(res.status).toBe(409);
  });

  it("403s a caller without write access, 401s anonymous, 404s invisible repos", async () => {
    await seedRepo({ visibility: "private" });
    await seedMirrorRow();
    const queue = recordingQueue();
    const app = makeApp(queue);
    const otherHeaders = { Authorization: `token ${TOKEN_OTHER}` };
    expect((await app(`${repoBase}/mirror-sync`, { method: "POST", headers: otherHeaders })).status).toBe(404);
    expect(
      (await app(`${repoBase}/mirror-sync`, { method: "POST", headers: { Authorization: `token ${TOKEN}` } }))
        .status,
    ).toBe(200);

    await env.DB.prepare("UPDATE repositories SET visibility = 'public'").run();
    expect((await app(`${repoBase}/mirror-sync`, { method: "POST", headers: otherHeaders })).status).toBe(403);
    expect((await app(`${repoBase}/mirror-sync`, { method: "POST" })).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// updateMirrorSettings — the settings WRITE arm (SPEC-0009 §2.3.1): the
// field matrix over the landed repo_mirrors row. Upstream updateMirror
// (routers/api/v1/repo/repo.go:1023-1135) + handleSettingsPostMirror
// (routers/web/repo/setting/setting.go:279-372) semantics.
// ---------------------------------------------------------------------------

/** A MirrorSettingsEnv over the workerd env (KEK armed; the egress policy
 *  fields default to the lax posture). */
function settingsEnv(extra: Record<string, string | undefined> = {}): MirrorSettingsTestEnv {
  return { ...env, MIRROR_SYNC_QUEUE: recordingQueue(), ...extra };
}
type MirrorSettingsTestEnv = Parameters<typeof updateMirrorSettings>[1];

/** Seeds the mirror row WITH credentials by riding the into-empty migrate
 *  route (the sealing half is the register arm's; the matrix then exercises
 *  the decrypt-recompose-reseal chain through the §4.2 envelope). */
async function seedCredentialedMirror(
  auth: { username?: string; password?: string; token?: string } = {},
): Promise<void> {
  await seedRepo();
  const queue = recordingQueue();
  const body: Record<string, unknown> = { clone_addr: SOURCE_URL, mirror: true };
  if (auth.username !== undefined) body.auth_username = auth.username;
  if (auth.password !== undefined) body.auth_password = auth.password;
  if (auth.token !== undefined) body.auth_token = auth.token;
  const res = await makeApp(queue, { MIRROR_CREDENTIAL_KEY: KEK })(`${repoBase}/migrate`, {
    method: "POST",
    headers: jsonAuth,
    body: JSON.stringify(body),
  });
  if (res.status !== 202) throw new Error(`seedCredentialedMirror failed: ${res.status} ${await res.text()}`);
}

const mirrorRow = () => drizzle(env.DB).select().from(repoMirrors).where(eq(repoMirrors.repoId, "7401")).get();

/** Decrypts the stored envelope through the sync consumer's half (the row
 *  carries the AAD halves — never a hardcoded id under AUTOINCREMENT). */
async function storedAuthHeader(): Promise<string | null> {
  const row = await mirrorRow();
  return mirrorAuthHeader({ ...env, MIRROR_CREDENTIAL_KEY: KEK }, row!);
}

describe("parsePatchMirrorInterval (the PATCH validation texts)", () => {
  it("carries the API arm's exact refusal texts (repo.go:1044-1057)", () => {
    const below = (() => {
      try {
        parsePatchMirrorInterval("5m");
        return null;
      } catch (error) {
        return error as MirrorValidationError;
      }
    })();
    expect(below?.message).toBe(
      `invalid mirror interval: 5m0s is below minimum interval: ${renderGoDuration(MIRROR_MIN_INTERVAL_SECONDS)}`,
    );
    expect(below?.field).toBe("interval");
    try {
      parsePatchMirrorInterval("soon");
      expect.unreachable();
    } catch (error) {
      expect((error as MirrorValidationError).message).toBe('time: invalid duration "soon"');
    }
    // "0" disables; a compound form parses to seconds.
    expect(parsePatchMirrorInterval("0")).toBe(0);
    expect(parsePatchMirrorInterval("8h30m")).toBe(30600);
  });

  it("our grammar refuses signed forms as unparseable (the register-arm divergence — upstream parses them into the below-minimum arm; same 422)", () => {
    try {
      parsePatchMirrorInterval("-5m");
      expect.unreachable();
    } catch (error) {
      expect((error as MirrorValidationError).message).toBe('time: invalid duration "-5m"');
    }
  });
});

describe("updateMirrorSettings — interval (the reschedule arm)", () => {
  it("writes seconds and re-arms next_sync_at = now + interval (ScheduleNextUpdate, mirror.go:71-77)", async () => {
    await seedRepo();
    await seedMirrorRow();
    const before = Math.floor(Date.now() / 1000);
    const status = await updateMirrorSettings(env.DB, settingsEnv(), "7401", { interval: "30m" });
    expect(status?.interval_seconds).toBe(1800);
    expect(status?.mirror_interval).toBe("30m0s");
    const row = await mirrorRow();
    expect(row?.intervalSeconds).toBe(1800);
    expect(Math.abs((row?.nextSyncAt ?? 0) - (before + 1800))).toBeLessThanOrEqual(2);
    // The write touches nothing else: sync_state stays, no message enqueued.
    expect(row?.syncState).toBe("idle");
  });

  it("interval 0 disables scheduling (next_sync_at = 0)", async () => {
    await seedRepo();
    await seedMirrorRow({ nextSyncAt: 1700000000 });
    const status = await updateMirrorSettings(env.DB, settingsEnv(), "7401", { interval: "0" });
    expect(status?.interval_seconds).toBe(0);
    expect(status?.next_sync_at).toBe(0);
  });

  it("refuses a below-minimum interval with the upstream text and writes nothing", async () => {
    await seedRepo();
    await seedMirrorRow({ intervalSeconds: 28800, nextSyncAt: 1700000000 });
    await expect(updateMirrorSettings(env.DB, settingsEnv(), "7401", { interval: "5m" })).rejects.toThrow(
      MirrorValidationError,
    );
    const row = await mirrorRow();
    expect(row?.intervalSeconds).toBe(28800); // untouched
    expect(row?.nextSyncAt).toBe(1700000000); // untouched
  });
});

describe("updateMirrorSettings — prune (no reschedule)", () => {
  it("flips enable_prune without touching the schedule", async () => {
    await seedRepo();
    await seedMirrorRow({ enablePrune: true, nextSyncAt: 1700000000 });
    const status = await updateMirrorSettings(env.DB, settingsEnv(), "7401", { enablePrune: false });
    expect(status?.enable_prune).toBe(false);
    const row = await mirrorRow();
    expect(row?.nextSyncAt).toBe(1700000000);
  });
});

describe("updateMirrorSettings — the silent non-mirror skip", () => {
  it("returns null when there is no mirror row (repo.go:1029-1033)", async () => {
    await seedRepo();
    const status = await updateMirrorSettings(env.DB, settingsEnv(), "7401", { interval: "30m", enablePrune: false });
    expect(status).toBeNull();
    const rows = await drizzle(env.DB).select().from(repoMirrors).all();
    expect(rows).toEqual([]);
  });
});

describe("updateMirrorSettings — credentials (the recomposition matrix)", () => {
  it("keeps the stored password on a username-only unchanged-or-blank write, resealed (repo.go:1083-1090)", async () => {
    await seedCredentialedMirror({ username: "alice", password: "s3cret" });
    const before = await storedAuthHeader();
    expect(before).toContain("Basic");

    const status = await updateMirrorSettings(env.DB, settingsEnv({ MIRROR_CREDENTIAL_KEY: KEK }), "7401", {
      username: "alice",
    });
    expect(status?.credentials_username).toBe("alice");
    expect(status?.has_credentials).toBe(true);
    const after = await storedAuthHeader();
    expect(after).toBe(before); // the same Authorization header, a FRESH envelope (re-sealed)
  });

  it("a NEW username drops the stored password (the empty-password compose — mirror_password_help)", async () => {
    await seedCredentialedMirror({ username: "alice", password: "s3cret" });
    await updateMirrorSettings(env.DB, settingsEnv({ MIRROR_CREDENTIAL_KEY: KEK }), "7401", { username: "bob" });
    const row = await mirrorRow();
    expect(row?.credentialsUsername).toBe("bob");
    // Basic base64("bob:")
    expect(await storedAuthHeader()).toBe(`Basic ${btoa("bob:")}`);
  });

  it("the token wins as the Bearer form (repo.go:1091-1092)", async () => {
    await seedCredentialedMirror({ username: "alice", password: "s3cret" });
    await updateMirrorSettings(env.DB, settingsEnv({ MIRROR_CREDENTIAL_KEY: KEK }), "7401", { token: "tok-1" });
    expect(await storedAuthHeader()).toBe("Bearer tok-1");
  });

  it("an explicit empty username+password composes the anonymous form (the envelope clears)", async () => {
    await seedCredentialedMirror({ username: "alice", password: "s3cret" });
    const status = await updateMirrorSettings(env.DB, settingsEnv({ MIRROR_CREDENTIAL_KEY: KEK }), "7401", {
      username: "",
      password: "",
    });
    expect(status?.credentials_username).toBeNull();
    expect(status?.has_credentials).toBe(false);
    expect((await mirrorRow())?.credentialsCiphertext).toBeNull();
  });

  it("an absent credential trio leaves the envelope byte-stable", async () => {
    await seedCredentialedMirror({ username: "alice", password: "s3cret" });
    const before = (await mirrorRow())?.credentialsCiphertext;
    await updateMirrorSettings(env.DB, settingsEnv({ MIRROR_CREDENTIAL_KEY: KEK }), "7401", { enablePrune: false });
    expect((await mirrorRow())?.credentialsCiphertext).toBe(before);
  });

  it("the KEK-missing credential write fails closed (the 500 family)", async () => {
    await seedCredentialedMirror({ username: "alice", password: "s3cret" });
    await expect(
      updateMirrorSettings(env.DB, settingsEnv({ MIRROR_CREDENTIAL_KEY: undefined }), "7401", { password: "new" }),
    ).rejects.toBeInstanceOf(MirrorCredentialKeyError);
  });

  it("the auth arm re-runs the egress gate on the stored address (repo.go:1108-1112)", async () => {
    await seedCredentialedMirror({ username: "alice", password: "s3cret" });
    await expect(
      updateMirrorSettings(env.DB, settingsEnv({ MIRROR_CREDENTIAL_KEY: KEK, MIRROR_EGRESS_MODE: "strict" }), "7401", {
        password: "new",
      }),
    ).rejects.toThrow(MirrorValidationError);
  });
});

describe("updateMirrorSettings — the web-only address + LFS arms", () => {
  it("moves remote_address AND repositories.original_url (UpdateAddress's halves), with NO reschedule", async () => {
    await seedRepo();
    await seedMirrorRow({ nextSyncAt: 1700000000 });
    const status = await updateMirrorSettings(env.DB, settingsEnv(), "7401", {
      address: "https://other.example.com/org/repo.git",
    });
    expect(status?.remote_address).toBe("https://other.example.com/org/repo.git");
    const row = await mirrorRow();
    expect(row?.remoteAddress).toBe("https://other.example.com/org/repo.git");
    expect(row?.nextSyncAt).toBe(1700000000); // an address change never re-arms
    const repo = await drizzle(env.DB).select({ originalUrl: repositories.originalUrl }).from(repositories).where(eq(repositories.id, "7401")).get();
    expect(repo?.originalUrl).toBe("https://other.example.com/org/repo.git");
  });

  it("refuses an invalid address with the URL text and writes nothing", async () => {
    await seedRepo();
    await seedMirrorRow();
    await expect(
      updateMirrorSettings(env.DB, settingsEnv(), "7401", { address: "http://insecure.example.com/x.git" }),
    ).rejects.toThrow(/The provided URL is invalid/);
    expect((await mirrorRow())?.remoteAddress).toBe(SOURCE_URL);
  });

  it("refuses a disallowed host with the egress text", async () => {
    await seedRepo();
    await seedMirrorRow();
    await expect(
      updateMirrorSettings(env.DB, settingsEnv({ MIRROR_EGRESS_MODE: "strict" }), "7401", {
        address: "https://src.example.com/org/repo.git",
      }),
    ).rejects.toThrow(/disallowed hosts/);
  });

  it("stores the LFS toggle + a gated endpoint (empty clears to null)", async () => {
    await seedRepo();
    await seedMirrorRow();
    const status = await updateMirrorSettings(env.DB, settingsEnv(), "7401", {
      lfs: true,
      lfsEndpoint: "https://lfs.example.com/api/lfs",
    });
    expect(status?.lfs_enabled).toBe(true);
    expect(status?.lfs_endpoint).toBe("https://lfs.example.com/api/lfs");

    const cleared = await updateMirrorSettings(env.DB, settingsEnv(), "7401", { lfs: false, lfsEndpoint: "" });
    expect(cleared?.lfs_enabled).toBe(false);
    expect(cleared?.lfs_endpoint).toBeNull();
  });
});
