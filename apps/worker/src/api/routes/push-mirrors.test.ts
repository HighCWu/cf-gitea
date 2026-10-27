/**
 * The repo push-mirror family (routes/push-mirrors.ts — the inventory batch 7
 * `wave-api-push-mirrors` batch) on real D1 (migration 0023's `push_mirrors`):
 * all five contract ops over the standalone-mount convention (the routes ARE
 * registered in router.ts by the orchestrator after this batch).
 *
 * Per-arm contract verification: every REACHABLE declared response code of
 * every op is exercised — list {200,403,404}, get {200,404}, add
 * {200,400,403,404}, delete {204} (the declared 400/404 are the
 * repo-resolution arms, exercised via the gates; the NAME arm itself 204s —
 * upstream's idempotent delete, models/repo/pushmirror.go DeletePushMirrors
 * never errors on zero rows), sync {200,403,404,422}. The runtime-only
 * 401/423/500 codes stay undeclared per the module header, asserted as
 * behavior, not contract.
 *
 * The storage split is pinned end-to-end: the generated `remote_mirror_…`
 * name, the SANITIZED remote_address (userinfo never stored), and the §4.2
 * credential envelope decrypted back through the documented
 * nonce[12]||AES-256-GCM format with AAD `${id}:${repoId}` — proving the
 * encrypt half satisfies sync.ts's mirrorAuthHeader contract byte-for-byte
 * (the consumer that will one day push OUT is follow-up scope; the envelope
 * format is pinned NOW so that consumer can land without a migration).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { pushMirrors, repositories } from "../../db/schema";
import { createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import { registerPushMirrorRoutes } from "./push-mirrors";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["push_mirrors", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const [id, username, isAdmin, type] of [
    [1, "doer", 0, "user"], // a plain authenticated non-admin
    [3, "chief", 1, "user"], // site admin
    [4, "alice", 0, "user"], // the repo owner (the family's admin)
  ] as const) {
    await env.DB.prepare("INSERT INTO users (id, username, username_lower, is_admin, status, type, created_at) VALUES (?, ?, ?, ?, 'active', ?, 0)")
      .bind(id, username, username, isAdmin, type)
      .run();
  }
});

const db = () => drizzle(env.DB);

const TARGET_URL = "https://dest.example.com/org/repo.git";

/** The §4.2 KEK — 32 bytes, base64 (what `wrangler secret put` would hold). */
const KEK = btoa(
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => String.fromCharCode(b)).join(""),
);

const OWNER_TOKEN = "token-alice"; // the repo owner
const DOER_TOKEN = "token-doer"; // a plain authenticated user
const ADMIN_TOKEN = "token-chief"; // the site admin

const IDENTITY_TOKENS: Record<string, { id: number; login: string; is_admin: boolean }> = {
  [OWNER_TOKEN]: { id: 4, login: "alice", is_admin: false },
  [DOER_TOKEN]: { id: 1, login: "doer", is_admin: false },
  [ADMIN_TOKEN]: { id: 3, login: "chief", is_admin: true },
};

const resolver: AuthResolver = { resolveToken: (token: string) => Promise.resolve(IDENTITY_TOKENS[token] ?? null) };

interface RecordingQueue extends Queue {
  sent: unknown[];
  failSends: boolean;
}

/** MIRROR_SYNC_QUEUE stub — the "remote" of these fixtures is this recorder
 *  plus the D1 rows; nothing here performs a network fetch. */
function recordingQueue(failSends = false): RecordingQueue {
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  const sent: unknown[] = [];
  return {
    sent,
    failSends,
    send: (body: unknown) => {
      if (failSends) return Promise.reject(new Error("queue unavailable"));
      sent.push(body);
      return Promise.resolve({ metadata });
    },
    sendBatch: () => Promise.resolve({ metadata }),
    metrics: () => Promise.resolve({ backlogCount: 0, backlogBytes: 0 }),
  };
}

type App = (path: string, init?: RequestInit) => Promise<Response>;

/** Local mount of the orchestrator's registration seam (requireAuth only —
 *  the whole family is reqToken+reqAdmin upstream, api.go:1431-1437). The
 *  registry paths are relative to the /api/v1 mount, so fetched paths strip
 *  the prefix. */
function makeApp(queue: RecordingQueue, extraEnv: Record<string, string | undefined> = {}): App {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerPushMirrorRoutes(app, createTokenAuthMiddleware(resolver));
  return (path, init) =>
    Promise.resolve(
      app.fetch(new Request(`https://example.com${path.replace(/^\/api\/v1/, "")}`, init), {
        ...env,
        MIRROR_SYNC_QUEUE: queue,
        ...extraEnv,
      }),
    );
}

const authed = (token: string, init?: RequestInit): RequestInit => ({
  ...init,
  headers: { ...(init?.headers ?? {}), Authorization: `token ${token}`, "Content-Type": "application/json" },
});

async function jsonBody<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text()) as T;
}

let repoSeq = 9100;

/** One user-owned repo (alice/visibleN, public, not archived). */
async function seedRepo(overrides: Partial<typeof repositories.$inferInsert> = {}): Promise<{ slug: string; repoId: string }> {
  const repoId = String(repoSeq++);
  const slug = `visible${repoId}`;
  await db().insert(repositories).values({
    id: repoId,
    storageKey: `r_${repoId}`,
    ownerNamespace: "alice",
    ownerId: 4,
    slug,
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
    ...overrides,
  });
  return { slug, repoId };
}

async function seedMirrorRow(repoId: string, remoteName: string): Promise<number> {
  const inserted = await db()
    .insert(pushMirrors)
    .values({
      repoId,
      remoteName,
      remoteAddress: TARGET_URL,
      syncOnCommit: false,
      intervalSeconds: 600,
      createdAt: new Date("2026-02-03T04:05:06Z"),
      lastUpdateUnix: null,
      lastError: "",
    })
    .returning({ id: pushMirrors.id });
  return inserted[0]!.id;
}

interface MirrorWire {
  repo_name: string;
  remote_name: string;
  remote_address: string;
  created: string;
  last_update: string | null;
  last_error: string;
  interval: string;
  sync_on_commit: boolean;
}

/** The §4.2 envelope's decrypt half (sync.ts mirrorAuthHeader's documented
 *  format): base64( nonce[12] || AES-256-GCM ), AAD `${id}:${repoId}`. */
async function decryptCredentials(
  kek: string,
  row: { id: number; repoId: string; credentialsCiphertext: string },
): Promise<string> {
  const raw = atob(row.credentialsCiphertext);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const keyBytes = atob(kek);
  const keyRaw = new Uint8Array(keyBytes.length);
  for (let i = 0; i < keyBytes.length; i++) keyRaw[i] = keyBytes.charCodeAt(i);
  const key = await crypto.subtle.importKey("raw", keyRaw, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytes.slice(0, 12),
      additionalData: new TextEncoder().encode(`${row.id}:${row.repoId}`),
      tagLength: 128,
    },
    key,
    bytes.slice(12),
  );
  return new TextDecoder().decode(plain);
}

const addBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  remote_address: TARGET_URL,
  interval: "8h",
  sync_on_commit: true,
  ...extra,
});

// ---------------------------------------------------------------------------
// repoAddPushMirror — POST /repos/{owner}/{repo}/push_mirrors
// ---------------------------------------------------------------------------

describe("repoAddPushMirror (POST /repos/{owner}/{repo}/push_mirrors)", () => {
  it("200: creates a mirror with a generated remote name, sanitized address, and a sealed credential envelope", async () => {
    const { slug, repoId } = await seedRepo();
    const app = makeApp(recordingQueue(), { MIRROR_CREDENTIAL_KEY: KEK });
    const res = await app(
      `/api/v1/repos/alice/${slug}/push_mirrors`,
      authed(OWNER_TOKEN, { method: "POST", body: JSON.stringify(addBody({ remote_username: "git", remote_password: "s3cret" })) }),
    );
    expect(res.status).toBe(200);
    const body = await jsonBody<MirrorWire>(res);
    expect(body.repo_name).toBe(slug);
    expect(body.remote_name).toMatch(/^remote_mirror_[A-Za-z0-9]{10}$/);
    expect(body.remote_address).toBe(TARGET_URL);
    expect(body.created).toBe(new Date(body.created).toISOString());
    expect(body.last_update).toBeNull();
    expect(body.last_error).toBe("");
    expect(body.interval).toBe("8h0m0s");
    expect(body.sync_on_commit).toBe(true);
    // The Authorization value never appears anywhere in the response.
    const text = JSON.stringify(body);
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("Basic");

    // Storage: one row, remote_address sanitized, the secret ONLY as the
    // §4.2 envelope — decrypted through the documented format with the AAD
    // bound to (row id, repo id), the sync consumer's exact contract.
    const row = (await db().select().from(pushMirrors).where(eq(pushMirrors.repoId, repoId)).all())[0]!;
    expect(row.remoteName).toBe(body.remote_name);
    expect(row.credentialsUsername).toBe("git");
    expect(row.credentialsCiphertext).not.toBeNull();
    expect(
      await decryptCredentials(KEK, { id: row.id, repoId, credentialsCiphertext: row.credentialsCiphertext! }),
    ).toBe("Basic " + btoa("git:s3cret"));
  });

  it("200: anonymous mirror needs no KEK and stores no ciphertext", async () => {
    const { slug, repoId } = await seedRepo();
    const app = makeApp(recordingQueue(), { MIRROR_CREDENTIAL_KEY: undefined });
    const res = await app(`/api/v1/repos/alice/${slug}/push_mirrors`, authed(OWNER_TOKEN, { method: "POST", body: JSON.stringify(addBody()) }));
    expect(res.status).toBe(200);
    const row = (await db().select().from(pushMirrors).where(eq(pushMirrors.repoId, repoId)).all())[0]!;
    expect(row.credentialsUsername).toBeNull();
    expect(row.credentialsCiphertext).toBeNull();
  });

  // wave-polish-matrix-12 — the auth field shapes' remaining arms (upstream
  // composes the Basic header whenever EITHER field is non-empty,
  // modules/git/remote.go:84-87 → derivePushMirrorAuthHeader): each half alone
  // seals, the empty pair is anonymous even with a KEK present, and the
  // envelope round-trips non-ASCII through its UTF-8 bytes.
  it("200: username-only and password-only each seal — the empty pair stays anonymous", async () => {
    const app = makeApp(recordingQueue(), { MIRROR_CREDENTIAL_KEY: KEK });

    // Username only: the header value is Basic base64("git:").
    const userOnly = await seedRepo();
    const resUser = await app(
      `/api/v1/repos/alice/${userOnly.slug}/push_mirrors`,
      authed(OWNER_TOKEN, { method: "POST", body: JSON.stringify(addBody({ remote_username: "git" })) }),
    );
    expect(resUser.status).toBe(200);
    const rowUser = (await db().select().from(pushMirrors).where(eq(pushMirrors.repoId, userOnly.repoId)).all())[0]!;
    expect(rowUser.credentialsUsername).toBe("git");
    expect(
      await decryptCredentials(KEK, { id: rowUser.id, repoId: userOnly.repoId, credentialsCiphertext: rowUser.credentialsCiphertext! }),
    ).toBe("Basic " + btoa("git:"));

    // Password only: no stored username, still a sealed envelope.
    const passOnly = await seedRepo();
    const resPass = await app(
      `/api/v1/repos/alice/${passOnly.slug}/push_mirrors`,
      authed(OWNER_TOKEN, { method: "POST", body: JSON.stringify(addBody({ remote_password: "s3cret" })) }),
    );
    expect(resPass.status).toBe(200);
    const rowPass = (await db().select().from(pushMirrors).where(eq(pushMirrors.repoId, passOnly.repoId)).all())[0]!;
    expect(rowPass.credentialsUsername).toBeNull();
    expect(
      await decryptCredentials(KEK, { id: rowPass.id, repoId: passOnly.repoId, credentialsCiphertext: rowPass.credentialsCiphertext! }),
    ).toBe("Basic " + btoa(":s3cret"));

    // The empty-string pair derives a NULL auth header — anonymous, no KEK
    // consulted, nothing sealed even though a KEK IS configured. The landed
    // username column keeps the EMPTY STRING verbatim (`?? null` guards only
    // undefined — addPushMirror's credentialsUsername arm), the derive half's
    // empty-meets-empty is the anonymous gate.
    const empty = await seedRepo();
    const resEmpty = await app(
      `/api/v1/repos/alice/${empty.slug}/push_mirrors`,
      authed(OWNER_TOKEN, {
        method: "POST",
        body: JSON.stringify(addBody({ remote_username: "", remote_password: "" })),
      }),
    );
    expect(resEmpty.status).toBe(200);
    const rowEmpty = (await db().select().from(pushMirrors).where(eq(pushMirrors.repoId, empty.repoId)).all())[0]!;
    expect(rowEmpty.credentialsUsername).toBe("");
    expect(rowEmpty.credentialsCiphertext).toBeNull();
  });

  // wave-polish-matrix-12 — non-ASCII credentials ride the RFC 7617 value's
  // UTF-8 bytes (derivePushMirrorAuthHeader's TextEncoder step); the decrypt
  // half must see exactly those bytes.
  it("200: a unicode password seals through its UTF-8 bytes — the decrypt round-trips", async () => {
    const { slug, repoId } = await seedRepo();
    const app = makeApp(recordingQueue(), { MIRROR_CREDENTIAL_KEY: KEK });
    const res = await app(
      `/api/v1/repos/alice/${slug}/push_mirrors`,
      authed(OWNER_TOKEN, { method: "POST", body: JSON.stringify(addBody({ remote_username: "git", remote_password: "pässwörd🔐" })) }),
    );
    expect(res.status).toBe(200);
    const row = (await db().select().from(pushMirrors).where(eq(pushMirrors.repoId, repoId)).all())[0]!;
    const utf8 = new TextEncoder().encode("git:pässwörd🔐");
    expect(
      await decryptCredentials(KEK, { id: row.id, repoId, credentialsCiphertext: row.credentialsCiphertext! }),
    ).toBe(`Basic ${btoa(String.fromCharCode(...utf8))}`);
  });

  // wave-polish-matrix-12 — the interval grammar's remaining wire edges:
  // exactly-at-the-floor passes, the negative and float forms PARSE (Go
  // ParseDuration accepts both) and so fail the min check rather than the
  // parse one, and the huge hour form renders upstream's Duration.String().
  it("200/400: at-floor passes; negative and float forms parse then fail the floor; huge hours render", async () => {
    const { slug } = await seedRepo();
    const app = makeApp(recordingQueue());

    const atFloor = await app(`/api/v1/repos/alice/${slug}/push_mirrors`, authed(OWNER_TOKEN, { method: "POST", body: JSON.stringify(addBody({ interval: "10m" })) }));
    expect(atFloor.status).toBe(200);
    expect((await jsonBody<MirrorWire>(atFloor)).interval).toBe("10m0s");

    // "-5m" parses to -300 (parsePushMirrorInterval's sign arm) — nonzero
    // below the floor, so the MINIMUM text, not the invalid-duration one.
    const negative = await app(`/api/v1/repos/alice/${slug}/push_mirrors`, authed(OWNER_TOKEN, { method: "POST", body: JSON.stringify(addBody({ interval: "-5m" })) }));
    expect(negative.status).toBe(400);
    expect((await jsonBody<{ message: string }>(negative)).message).toBe("interval is shorter than minimum 10m0s");

    // "1.5m" parses to 90 via the float component — the same minimum bucket.
    const float = await app(`/api/v1/repos/alice/${slug}/push_mirrors`, authed(OWNER_TOKEN, { method: "POST", body: JSON.stringify(addBody({ interval: "1.5m" })) }));
    expect(float.status).toBe(400);
    expect((await jsonBody<{ message: string }>(float)).message).toBe("interval is shorter than minimum 10m0s");

    // A huge hour count round-trips through goDurationString's h-only form.
    const huge = await app(`/api/v1/repos/alice/${slug}/push_mirrors`, authed(OWNER_TOKEN, { method: "POST", body: JSON.stringify(addBody({ interval: "999999h" })) }));
    expect(huge.status).toBe(200);
    expect((await jsonBody<MirrorWire>(huge)).interval).toBe("999999h0m0s");
  });

  // wave-polish-matrix-12 — an entirely absent remote_address hits the same
  // IsURLError bucket as an unparseable one (checkPushMirrorTarget's
  // new URL("") throw, services/push-mirrors.ts:187-193).
  it("400: an absent remote_address is the Invalid Url bucket", async () => {
    const { slug } = await seedRepo();
    const app = makeApp(recordingQueue());
    const res = await app(
      `/api/v1/repos/alice/${slug}/push_mirrors`,
      authed(OWNER_TOKEN, { method: "POST", body: JSON.stringify(addBody({ remote_address: undefined })) }),
    );
    expect(res.status).toBe(400);
    expect((await jsonBody<{ message: string }>(res)).message).toBe("Invalid Url ");
  });

  // wave-polish-matrix-12 — the 64 KiB declared-cap (routes/push-mirrors.ts
  // PUSH_MIRROR_BODY_MAX_BYTES) dies BEFORE the zod parse — the migrate cap
  // pattern's runtime-only 413, this family's first pin of it. The cap reads
  // the DECLARED header (the shape real ingress always provides; workerd's
  // Request only carries it when explicitly set — probed 2026-10-27).
  it("413 (runtime-only): a declared oversized body dies at the cap, unwritten", async () => {
    const { slug, repoId } = await seedRepo();
    const app = makeApp(recordingQueue());
    const res = await app(`/api/v1/repos/alice/${slug}/push_mirrors`, {
      method: "POST",
      headers: { Authorization: `token ${OWNER_TOKEN}`, "Content-Type": "application/json", "content-length": String(70 * 1024) },
      body: JSON.stringify(addBody()),
    });
    expect(res.status).toBe(413);
    expect((await jsonBody<{ message: string }>(res)).message).toContain(`push mirror options exceed the ${64 * 1024} byte cap`);
    expect((await db().select().from(pushMirrors).where(eq(pushMirrors.repoId, repoId)).all()).length).toBe(0);
  });

  // wave-polish-matrix-12 — the pull channel's malformed-KEK arm
  // (mirror.test.ts "rejects a malformed KEK") has a push twin: readyKek's
  // 32-byte check fails closed before any row exists.
  it("500 (runtime-only): a wrong-sized KEK fails closed before any write", async () => {
    const { slug, repoId } = await seedRepo();
    const app = makeApp(recordingQueue(), { MIRROR_CREDENTIAL_KEY: btoa("short") });
    const res = await app(
      `/api/v1/repos/alice/${slug}/push_mirrors`,
      authed(OWNER_TOKEN, { method: "POST", body: JSON.stringify(addBody({ remote_username: "git", remote_password: "s3cret" })) }),
    );
    expect(res.status).toBe(500);
    expect((await db().select().from(pushMirrors).where(eq(pushMirrors.repoId, repoId)).all()).length).toBe(0);
  });

  it("200: the site admin can add, and names do not collide across mirrors of the same repo", async () => {
    const { slug } = await seedRepo();
    const app = makeApp(recordingQueue());
    const first = await app(`/api/v1/repos/alice/${slug}/push_mirrors`, authed(ADMIN_TOKEN, { method: "POST", body: JSON.stringify(addBody()) }));
    const second = await app(`/api/v1/repos/alice/${slug}/push_mirrors`, authed(ADMIN_TOKEN, { method: "POST", body: JSON.stringify(addBody({ interval: "30m", sync_on_commit: false })) }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = (await jsonBody<MirrorWire>(first)).remote_name;
    const secondBody = await jsonBody<MirrorWire>(second);
    const b = secondBody.remote_name;
    expect(a).not.toBe(b);
    expect(secondBody.interval).toBe("30m0s");
  });

  it("400: a missing/empty interval fails ParseDuration with upstream's exact text", async () => {
    const { slug } = await seedRepo();
    const app = makeApp(recordingQueue());
    for (const body of [addBody({ interval: undefined }), addBody({ interval: "" }), addBody({ interval: "soon" })]) {
      const res = await app(`/api/v1/repos/alice/${slug}/push_mirrors`, authed(OWNER_TOKEN, { method: "POST", body: JSON.stringify(body) }));
      expect(res.status).toBe(400);
      const err = await jsonBody<{ message: string }>(res);
      expect(err.message.startsWith("invalid interval: time: invalid duration")).toBe(true);
    }
  });

  it("400: a nonzero interval below the 10 m floor carries upstream's minimum text; 0 means disabled", async () => {
    const { slug, repoId } = await seedRepo();
    const app = makeApp(recordingQueue());
    const res = await app(`/api/v1/repos/alice/${slug}/push_mirrors`, authed(OWNER_TOKEN, { method: "POST", body: JSON.stringify(addBody({ interval: "5m" })) }));
    expect(res.status).toBe(400);
    expect((await jsonBody<{ message: string }>(res)).message).toBe("interval is shorter than minimum 10m0s");

    const zero = await app(`/api/v1/repos/alice/${slug}/push_mirrors`, authed(OWNER_TOKEN, { method: "POST", body: JSON.stringify(addBody({ interval: "0" })) }));
    expect(zero.status).toBe(200);
    expect((await jsonBody<MirrorWire>(zero)).interval).toBe("0s");
    expect((await db().select().from(pushMirrors).where(eq(pushMirrors.repoId, repoId)).all()).length).toBe(1);
  });

  it("400: URL-shape failures carry upstream's HandleRemoteAddressError texts", async () => {
    const { slug } = await seedRepo();
    const app = makeApp(recordingQueue());
    const post = (address: string, extra: Record<string, unknown> = {}) =>
      app(`/api/v1/repos/alice/${slug}/push_mirrors`, authed(OWNER_TOKEN, { method: "POST", body: JSON.stringify(addBody({ remote_address: address, ...extra })) }));

    // Unparseable → the IsURLError bucket, exact text INCLUDING the trailing
    // space (routers/api/v1/repo/mirror.go:398).
    const bad = await post("not a url at all");
    expect(bad.status).toBe(400);
    expect((await jsonBody<{ message: string }>(bad)).message).toBe("Invalid Url ");

    // Embedded userinfo → rejected (structured fields are the only channel).
    const userinfo = await post("https://user:pass@dest.example.com/org/repo.git");
    expect(userinfo.status).toBe(400);
    expect((await jsonBody<{ message: string }>(userinfo)).message).toBe("Invalid Url ");

    // Non-https schemes → the IsProtocolInvalid bucket (https-only is the
    // documented cf-gitea divergence — see the service header).
    for (const address of ["http://dest.example.com/org/repo.git", "git://dest.example.com/org/repo.git", "ssh://git@dest.example.com/org/repo.git"]) {
      const res = await post(address);
      expect(res.status, address).toBe(400);
      expect((await jsonBody<{ message: string }>(res)).message).toBe("Invalid mirror protocol");
    }
  });

  it("401: an egress-policy denial is the IsPermissionDenied bucket", async () => {
    const { slug } = await seedRepo();
    const app = makeApp(recordingQueue());
    const res = await app(
      `/api/v1/repos/alice/${slug}/push_mirrors`,
      authed(OWNER_TOKEN, { method: "POST", body: JSON.stringify(addBody({ remote_address: "https://127.0.0.1/org/repo.git" })) }),
    );
    expect(res.status).toBe(401);
    expect((await jsonBody<{ message: string }>(res)).message).toBe("Permission denied");
  });

  it("403: a plain authenticated user is reqAdmin-rejected with upstream's message", async () => {
    const { slug } = await seedRepo();
    const app = makeApp(recordingQueue());
    const res = await app(`/api/v1/repos/alice/${slug}/push_mirrors`, authed(DOER_TOKEN, { method: "POST", body: JSON.stringify(addBody()) }));
    expect(res.status).toBe(403);
    expect((await jsonBody<{ message: string }>(res)).message).toBe(
      "user should be an owner or a collaborator with admin write of a repository",
    );
  });

  it("404: an invisible or missing repo is the anti-enumeration 404", async () => {
    await seedRepo();
    const app = makeApp(recordingQueue());
    expect((await app("/api/v1/repos/alice/missing/push_mirrors", authed(OWNER_TOKEN, { method: "POST", body: JSON.stringify(addBody()) }))).status).toBe(404);
    // A private repo of another owner is invisible to alice... to DOER.
    await seedRepo({ ownerNamespace: "chief", ownerId: 3, slug: "private-repo", visibility: "private" });
    expect((await app("/api/v1/repos/chief/private-repo/push_mirrors", authed(DOER_TOKEN, { method: "POST", body: JSON.stringify(addBody()) }))).status).toBe(404);
  });

  it("423 (runtime-only): an archived repo rejects the write", async () => {
    const { slug } = await seedRepo({ isArchived: true });
    const app = makeApp(recordingQueue());
    const res = await app(`/api/v1/repos/alice/${slug}/push_mirrors`, authed(OWNER_TOKEN, { method: "POST", body: JSON.stringify(addBody()) }));
    expect(res.status).toBe(423);
  });

  it("500 (runtime-only): credentials without a configured KEK fail closed", async () => {
    const { slug } = await seedRepo();
    const app = makeApp(recordingQueue(), { MIRROR_CREDENTIAL_KEY: undefined });
    const res = await app(
      `/api/v1/repos/alice/${slug}/push_mirrors`,
      authed(OWNER_TOKEN, { method: "POST", body: JSON.stringify(addBody({ remote_username: "git", remote_password: "s3cret" })) }),
    );
    expect(res.status).toBe(500);
    expect((await db().select().from(pushMirrors).all()).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// repoListPushMirrors — GET /repos/{owner}/{repo}/push_mirrors
// ---------------------------------------------------------------------------

describe("repoListPushMirrors (GET /repos/{owner}/{repo}/push_mirrors)", () => {
  it("200: lists the repo's mirrors in id order with the pagination headers", async () => {
    const { slug, repoId } = await seedRepo();
    await seedMirrorRow(repoId, "remote_mirror_aaaa1");
    await seedMirrorRow(repoId, "remote_mirror_bbbb2");
    await seedMirrorRow(repoId, "remote_mirror_cccc3");

    const app = makeApp(recordingQueue());
    const res = await app(`/api/v1/repos/alice/${slug}/push_mirrors?page=2&limit=2`, authed(OWNER_TOKEN));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("3");
    const body = await jsonBody<MirrorWire[]>(res);
    expect(body.length).toBe(1);
    expect(body[0]!.remote_name).toBe("remote_mirror_cccc3");
    expect(body[0]!.repo_name).toBe(slug);
    expect(body[0]!.remote_address).toBe(TARGET_URL);
    expect(body[0]!.interval).toBe("10m0s");
    expect(body[0]!.created).toBe("2026-02-03T04:05:06.000Z");
  });

  it("200: an empty list is an empty array (upstream's empty GetPushMirrorsByRepoID)", async () => {
    const { slug } = await seedRepo();
    const app = makeApp(recordingQueue());
    const res = await app(`/api/v1/repos/alice/${slug}/push_mirrors`, authed(OWNER_TOKEN));
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual([]);
  });

  // wave-polish-matrix-12 — the pagination grammar's unproven arms: the
  // ROUTE-level default page size is parseListOptions' DEFAULT_PAGING_NUM 30
  // (api/pagination.ts — limit absent parses to 30, so the service's `?? 10`
  // fallback is unreachable through this route), and a page past the end is
  // an empty array with the total INTACT (the offset over-count arm — never
  // a 400).
  it("200: the default page size is 30; a beyond-the-end page is empty with the total intact", async () => {
    const { slug, repoId } = await seedRepo();
    for (let i = 1; i <= 12; i++) {
      await seedMirrorRow(repoId, `remote_mirror_n${String(i).padStart(2, "0")}`);
    }
    const app = makeApp(recordingQueue());
    const res = await app(`/api/v1/repos/alice/${slug}/push_mirrors`, authed(OWNER_TOKEN));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("12");
    const body = await jsonBody<MirrorWire[]>(res);
    expect(body.length).toBe(12); // the 30-default holds every row
    expect(body[0]!.remote_name).toBe("remote_mirror_n01"); // id order — the first seeded name
    expect(body[11]!.remote_name).toBe("remote_mirror_n12");

    const past = await app(`/api/v1/repos/alice/${slug}/push_mirrors?page=5&limit=10`, authed(OWNER_TOKEN));
    expect(past.status).toBe(200);
    expect(await jsonBody<MirrorWire[]>(past)).toEqual([]);
    expect(past.headers.get("X-Total-Count")).toBe("12");
  });

  it("403/404: the reqAdmin and visibility gates", async () => {
    const { slug } = await seedRepo();
    const app = makeApp(recordingQueue());
    expect((await app(`/api/v1/repos/alice/${slug}/push_mirrors`, authed(DOER_TOKEN))).status).toBe(403);
    expect((await app("/api/v1/repos/alice/missing/push_mirrors", authed(OWNER_TOKEN))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// repoGetPushMirrorByRemoteName — GET /repos/{owner}/{repo}/push_mirrors/{name}
// ---------------------------------------------------------------------------

describe("repoGetPushMirrorByRemoteName (GET /repos/{owner}/{repo}/push_mirrors/{name})", () => {
  it("200: the exact (repo_id, remote_name) row", async () => {
    const { slug, repoId } = await seedRepo();
    await seedMirrorRow(repoId, "remote_mirror_exact1");
    const app = makeApp(recordingQueue());
    const res = await app(`/api/v1/repos/alice/${slug}/push_mirrors/remote_mirror_exact1`, authed(OWNER_TOKEN));
    expect(res.status).toBe(200);
    expect((await jsonBody<MirrorWire>(res)).remote_name).toBe("remote_mirror_exact1");
  });

  it("404: an unknown name — and another repo's row is unreachable through this repo", async () => {
    const { slug, repoId } = await seedRepo();
    const other = await seedRepo();
    await seedMirrorRow(repoId, "remote_mirror_mine1");
    await seedMirrorRow(other.repoId, "remote_mirror_theirs");
    const app = makeApp(recordingQueue());
    expect(
      (await app(`/api/v1/repos/alice/${slug}/push_mirrors/remote_mirror_unknown`, authed(OWNER_TOKEN))).status,
    ).toBe(404);
    expect(
      (await app(`/api/v1/repos/alice/${slug}/push_mirrors/remote_mirror_theirs`, authed(OWNER_TOKEN))).status,
    ).toBe(404);
  });

  it("403: the reqAdmin gate", async () => {
    const { slug, repoId } = await seedRepo();
    await seedMirrorRow(repoId, "remote_mirror_mine1");
    const app = makeApp(recordingQueue());
    expect((await app(`/api/v1/repos/alice/${slug}/push_mirrors/remote_mirror_mine1`, authed(DOER_TOKEN))).status).toBe(403);
  });

  // wave-polish-matrix-12 — the settled row's display arms: lastUpdateUnix
  // renders as the RFC 3339 date-time, last_error rides verbatim, and the
  // interval renders from the row's SECONDS (goDurationString — not the
  // requested form). The fresh-row nulls are pinned by the POST tests; these
  // are the post-sync shapes (UpdatePushMirrorSyncStatus's columns).
  it("200: a settled row renders its last_update, last_error, and the row interval", async () => {
    const { slug, repoId } = await seedRepo();
    const id = await seedMirrorRow(repoId, "remote_mirror_settled");
    await db()
      .update(pushMirrors)
      .set({
        lastUpdateUnix: new Date("2026-02-04T05:06:07Z"),
        lastError: "boom: push rejected",
        intervalSeconds: 3600,
      })
      .where(eq(pushMirrors.id, id));

    const app = makeApp(recordingQueue());
    const res = await app(`/api/v1/repos/alice/${slug}/push_mirrors/remote_mirror_settled`, authed(OWNER_TOKEN));
    expect(res.status).toBe(200);
    const body = await jsonBody<MirrorWire>(res);
    expect(body.last_update).toBe("2026-02-04T05:06:07.000Z");
    expect(body.last_error).toBe("boom: push rejected");
    expect(body.interval).toBe("1h0m0s");
  });
});

// ---------------------------------------------------------------------------
// repoDeletePushMirror — DELETE /repos/{owner}/{repo}/push_mirrors/{name}
// ---------------------------------------------------------------------------

describe("repoDeletePushMirror (DELETE /repos/{owner}/{repo}/push_mirrors/{name})", () => {
  it("204: removes the row — the sealed credentials cascade with it", async () => {
    const { slug, repoId } = await seedRepo();
    const id = await seedMirrorRow(repoId, "remote_mirror_gone1");
    await db()
      .update(pushMirrors)
      .set({ credentialsUsername: "git", credentialsCiphertext: "sealed" })
      .where(eq(pushMirrors.id, id));

    const app = makeApp(recordingQueue());
    const res = await app(`/api/v1/repos/alice/${slug}/push_mirrors/remote_mirror_gone1`, authed(OWNER_TOKEN, { method: "DELETE" }));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(await db().select().from(pushMirrors).where(eq(pushMirrors.repoId, repoId)).all()).toEqual([]);
  });

  it("204: an unknown name is STILL 204 — upstream's idempotent delete", async () => {
    const { slug, repoId } = await seedRepo();
    await seedMirrorRow(repoId, "remote_mirror_stays");
    const app = makeApp(recordingQueue());
    const res = await app(`/api/v1/repos/alice/${slug}/push_mirrors/remote_mirror_unknown`, authed(OWNER_TOKEN, { method: "DELETE" }));
    expect(res.status).toBe(204);
    // The existing row survives.
    expect((await db().select().from(pushMirrors).where(eq(pushMirrors.repoId, repoId)).all()).length).toBe(1);
  });

  it("403/423: the reqAdmin and mustNotBeArchived gates", async () => {
    const { slug, repoId } = await seedRepo();
    await seedMirrorRow(repoId, "remote_mirror_gone2");
    const app = makeApp(recordingQueue());
    expect(
      (await app(`/api/v1/repos/alice/${slug}/push_mirrors/remote_mirror_gone2`, authed(DOER_TOKEN, { method: "DELETE" }))).status,
    ).toBe(403);

    const archived = await seedRepo({ isArchived: true, slug: `arch${repoId}` });
    await seedMirrorRow(archived.repoId, "remote_mirror_gone3");
    expect(
      (await app(`/api/v1/repos/alice/arch${repoId}/push_mirrors/remote_mirror_gone3`, authed(OWNER_TOKEN, { method: "DELETE" }))).status,
    ).toBe(423);
  });
});

// ---------------------------------------------------------------------------
// repoPushMirrorSync — POST /repos/{owner}/{repo}/push_mirrors-sync
// ---------------------------------------------------------------------------

describe("repoPushMirrorSync (POST /repos/{owner}/{repo}/push_mirrors-sync)", () => {
  it("200: enqueues one push-mirror-sync message per mirror (documented shape, ids in order)", async () => {
    const { slug, repoId } = await seedRepo();
    const id1 = await seedMirrorRow(repoId, "remote_mirror_sync1");
    const id2 = await seedMirrorRow(repoId, "remote_mirror_sync2");
    const queue = recordingQueue();
    const app = makeApp(queue);
    const res = await app(`/api/v1/repos/alice/${slug}/push_mirrors-sync`, authed(OWNER_TOKEN, { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(queue.sent).toEqual([
      { kind: "push-mirror-sync", repoId, pushMirrorId: id1 },
      { kind: "push-mirror-sync", repoId, pushMirrorId: id2 },
    ]);
  });

  it("200: a repo with no push mirrors enqueues nothing (upstream's empty loop)", async () => {
    const { slug } = await seedRepo();
    const queue = recordingQueue();
    const app = makeApp(queue);
    const res = await app(`/api/v1/repos/alice/${slug}/push_mirrors-sync`, authed(OWNER_TOKEN, { method: "POST" }));
    expect(res.status).toBe(200);
    expect(queue.sent).toEqual([]);
  });

  it("422: a failed enqueue collects the remote names under upstream's exact text", async () => {
    const { slug, repoId } = await seedRepo();
    await seedMirrorRow(repoId, "remote_mirror_fail1");
    await seedMirrorRow(repoId, "remote_mirror_fail2");
    const app = makeApp(recordingQueue(true));
    const res = await app(`/api/v1/repos/alice/${slug}/push_mirrors-sync`, authed(OWNER_TOKEN, { method: "POST" }));
    expect(res.status).toBe(422);
    expect((await jsonBody<{ message: string }>(res)).message).toBe(
      "error occurred when syncing push mirrors: remote_mirror_fail1, remote_mirror_fail2",
    );
  });

  // wave-polish-matrix-12 — the sync gate's PARTIAL-failure arm: the loop
  // keeps sending after a rejection (enqueuePushMirrorSyncs, services/
  // push-mirrors.ts:439-447), so the delivered send stays in the recorder and
  // only the FAILED name enters upstream's collection.
  it("422: a partial enqueue failure names only the failed mirror — the delivered send stays sent", async () => {
    const { slug, repoId } = await seedRepo();
    const id1 = await seedMirrorRow(repoId, "remote_mirror_okay1");
    const id2 = await seedMirrorRow(repoId, "remote_mirror_fail2");
    const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
    const sent: unknown[] = [];
    const queue = {
      sent,
      failSends: false,
      send: (body: unknown) => {
        const message = body as { pushMirrorId: number };
        if (message.pushMirrorId === id2) return Promise.reject(new Error("queue unavailable"));
        sent.push(body);
        return Promise.resolve({ metadata });
      },
      sendBatch: () => Promise.resolve({ metadata }),
      metrics: () => Promise.resolve({ backlogCount: 0, backlogBytes: 0 }),
    } as unknown as RecordingQueue;

    const app = makeApp(queue);
    const res = await app(`/api/v1/repos/alice/${slug}/push_mirrors-sync`, authed(OWNER_TOKEN, { method: "POST" }));
    expect(res.status).toBe(422);
    expect((await jsonBody<{ message: string }>(res)).message).toBe(
      "error occurred when syncing push mirrors: remote_mirror_fail2",
    );
    expect(queue.sent).toEqual([{ kind: "push-mirror-sync", repoId, pushMirrorId: id1 }]);
  });

  // wave-polish-matrix-12 — the trigger's missing-binding arm (routes/
  // push-mirrors.ts:297-298): the runtime-only 500 the frozen contract omits.
  it("500 (runtime-only): a missing MIRROR_SYNC_QUEUE binding fails the trigger", async () => {
    const { slug, repoId } = await seedRepo();
    await seedMirrorRow(repoId, "remote_mirror_noq");
    const app = makeApp(recordingQueue(), { MIRROR_SYNC_QUEUE: undefined });
    const res = await app(`/api/v1/repos/alice/${slug}/push_mirrors-sync`, authed(OWNER_TOKEN, { method: "POST" }));
    expect(res.status).toBe(500);
    expect((await jsonBody<{ message: string }>(res)).message).toBe("MIRROR_SYNC_QUEUE binding missing");
  });

  it("403/404: the reqAdmin and visibility gates", async () => {
    const { slug } = await seedRepo();
    const app = makeApp(recordingQueue());
    expect((await app(`/api/v1/repos/alice/${slug}/push_mirrors-sync`, authed(DOER_TOKEN, { method: "POST" }))).status).toBe(403);
    expect((await app("/api/v1/repos/alice/missing/push_mirrors-sync", authed(OWNER_TOKEN, { method: "POST" }))).status).toBe(404);
  });

  it("423 (runtime-only): an archived repo rejects the trigger", async () => {
    const { slug, repoId } = await seedRepo({ isArchived: true });
    await seedMirrorRow(repoId, "remote_mirror_arch");
    const app = makeApp(recordingQueue());
    expect((await app(`/api/v1/repos/alice/${slug}/push_mirrors-sync`, authed(OWNER_TOKEN, { method: "POST" }))).status).toBe(423);
  });
});

// ---------------------------------------------------------------------------
// duration helpers (the interval grammar this family owns)
// ---------------------------------------------------------------------------

describe("push-mirror interval helpers", () => {
  it("parses the Go forms upstream's ParseDuration accepts", async () => {
    const { parsePushMirrorInterval, goDurationString } = await import("../services/push-mirrors");
    expect(parsePushMirrorInterval("0")).toBe(0);
    expect(parsePushMirrorInterval("45s")).toBe(45);
    expect(parsePushMirrorInterval("30m")).toBe(1800);
    expect(parsePushMirrorInterval("8h30m")).toBe(30600);
    expect(parsePushMirrorInterval("1.5h")).toBe(5400);
    expect(parsePushMirrorInterval("-5m")).toBe(-300);
    expect(parsePushMirrorInterval("+90s")).toBe(90);
    expect(parsePushMirrorInterval("1500ms")).toBe(1);
    expect(parsePushMirrorInterval("100ns")).toBe(0);
    for (const raw of ["", "soon", "10", "1w", "0s0x"]) {
      expect(parsePushMirrorInterval(raw), raw).toBeNull();
    }
    expect(goDurationString(0)).toBe("0s");
    expect(goDurationString(28800)).toBe("8h0m0s");
    expect(goDurationString(1800)).toBe("30m0s");
    expect(goDurationString(45)).toBe("45s");
    // wave-polish-matrix-12 — the mixed-component render and the at-floor
    // value (the wire form every GET of a 10 m mirror carries).
    expect(goDurationString(3661)).toBe("1h1m1s");
    expect(goDurationString(600)).toBe("10m0s");
    // The sub-second units parse to a truncated 0 (the ns/us/µs arm of the
    // switch — the comment's "far below the min floor either way").
    expect(parsePushMirrorInterval("1µs")).toBe(0);
    expect(parsePushMirrorInterval("500us")).toBe(0);
    // A three-component compound and a trailing-space form.
    expect(parsePushMirrorInterval("2h15m30s")).toBe(8130);
    expect(parsePushMirrorInterval("8h ")).toBeNull();
  });
});
