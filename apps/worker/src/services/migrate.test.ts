/**
 * Server-driven migrate (SPEC-0009 §2.2) — POST /repos/migrate on real D1 +
 * real engine DOs (workerd, @cloudflare/vitest-plugin): the CONTRACT path the
 * repo-scoped family deliberately is not (upstream's migrate creates the
 * target; this route owns the repositories INSERT).
 *
 * Both shapes run the full async flow:
 *
 *   mirror=true   201 (born ready+empty, mirror row due now) → the enqueued
 *                 sync driven by hand with a STUBBED fetch (sync.test.ts's
 *                 fake-source pattern: the advertisement is a real source
 *                 cell's actual refs, the pack bytes are real) → the
 *                 population settle flips is_empty — the "poll → settle" leg.
 *   mirror=false  201 (born migrating, `import` bootstrap in the body) → the
 *                 chunked channel driven through the REAL relay endpoints
 *                 (imports.test.ts's pattern: real pack bytes, real R2, real
 *                 engine receive) → the channel's settle flips ready.
 *
 * The single-emission assertion rides an OWNER-level send-everything hook
 * seeded BEFORE the POST (the fan-out matches owner hooks — issues/webhooks.ts
 * — so the birth emission is observable even though the repo row does not
 * exist until the request): the hook must see `repository` created EXACTLY
 * ONCE across birth + settle, while the mirror sync's push-family events flow
 * separately (and the import channel stays fully silent — the f5406c3 guard,
 * now covering this route's arm too).
 */

import { SELF, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { createTokenAuthMiddleware } from "../api/auth";
import { REPO_SETTINGS_DDL_STATEMENTS } from "../api/services/repo-settings";
import { mintFor, seedVerifiedUser } from "../auth/testing/seeds";
import { repoMirrors, repoSettings, repositories, users, webhookDeliveries, webhooks } from "../db/schema";
import { OrgService } from "./orgs/orgs";
import { MirrorCredentialKeyError } from "../api/services/mirror";
import type { ServerMigrateOptions } from "./migrate";
import { migrateRepository } from "./migrate";
import { handleMirrorSync, mirrorAuthHeader } from "./mirror/sync";
import { ImportService } from "../repos/imports/service";
import { indexChunk } from "../repos/imports/pipeline";
import { RepoService } from "../repos/service";
import { buildHistoryPack, ensureSeededRepo, type SeedCommit } from "../ui/testing/seed-repo";
import { UPLOAD_PACK_ADVERTISEMENT_CT, UPLOAD_PACK_RESULT_CT, type FetchImpl } from "./mirror/gitclient";
import { registerMirrorRoutes } from "../api/routes/mirror";
import { giteaErrorHandler } from "../api/errors";
import type { ApiEnv } from "../api/env";
import { OpenAPIHono } from "@hono/zod-openapi";

// ---------------------------------------------------------------------------
// Byte fixtures (sync.test.ts's local helpers — deliberately not exported
// there; these are test-file copies, the seed-repo.ts precedent)
// ---------------------------------------------------------------------------

const TE = new TextEncoder();
const FLUSH_PKT = TE.encode("0000");

function pkt(payload: string | Uint8Array): Uint8Array {
  const bytes = typeof payload === "string" ? TE.encode(payload) : payload;
  return concatBytes(TE.encode(`${(bytes.length + 4).toString(16).padStart(4, "0")}`), bytes);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Sideband-frame one band's payload (band byte + pkt-line framing). */
function sideband(band: number, payload: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let i = 0; i < payload.length; i += 1000) {
    frames.push(pkt(concatBytes(new Uint8Array([band]), payload.slice(i, i + 1000))));
  }
  return frames.length === 0 ? [pkt(new Uint8Array([band]))] : frames;
}

function advertResponse(body: Uint8Array): Response {
  return new Response(new Uint8Array(body), { status: 200, headers: { "content-type": UPLOAD_PACK_ADVERTISEMENT_CT } });
}

function resultResponse(body: Uint8Array): Response {
  return new Response(new Uint8Array(body), { status: 200, headers: { "content-type": UPLOAD_PACK_RESULT_CT } });
}

/** A v0 advertisement over the source cell's REAL refs: HEAD (resolved on the
 *  capabilities line), then one line per ref — the sync.test.ts shape. */
function v0AdvertBytes(refs: { name: string; target: string }[], head: string | null): Uint8Array {
  const caps =
    "multi_ack_detailed no-done shallow side-band-64k thin-pack ofs-delta" +
    (head !== null ? ` symref=HEAD:${head}` : "") +
    " agent=git/2.45";
  const headTarget = head !== null ? (refs.find((r) => r.name === head)?.target ?? refs[0]!.target) : refs[0]!.target;
  return concatBytes(
    pkt(`# service=git-upload-pack\n`),
    FLUSH_PKT,
    pkt(`${headTarget} HEAD\0${caps}\n`),
    ...refs.map((r) => pkt(`${r.target} ${r.name}\n`)),
    FLUSH_PKT,
  );
}

/** A v0 upload-pack response: NAK, the pack sidebanded on band 1, flush. */
function packResponseBytes(pack: Uint8Array): Uint8Array {
  return concatBytes(pkt("NAK\n"), ...sideband(1, pack), FLUSH_PKT);
}

/** The fetch stub answering one canned response per call, in order. */
function stubFetch(responses: Response[]): { fetchImpl: FetchImpl } {
  let calls = 0;
  return {
    fetchImpl: () => {
      const response = responses[calls];
      calls += 1;
      if (response === undefined) return Promise.reject(new Error(`unexpected fetch #${calls + 1}`));
      return Promise.resolve(response);
    },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const API = "https://example.com/api/v1";
const SOURCE_URL = "https://src.example.com/org/repo.git";
/** Fixed settle clock (unix seconds → 1700000100), the sync.test.ts shape. */
const NOW = new Date(1700000100000);
const DEFAULT_INTERVAL = 28800;

/** The §4.2 KEK — 32 bytes, base64 (service-level tests inject it; the
 *  SELF-level flow tests use an anonymous source so no KEK is needed). */
const KEK = btoa(
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => String.fromCharCode(b)).join(""),
);

const SEED_COMMITS: SeedCommit[] = [
  {
    message: "migrate source\n",
    files: [{ path: "README.md", content: "migrate source content\n" }],
    time: 1700000000,
  },
];

let doerId = 0;
let doerToken = "";

async function seedDoer(): Promise<{ id: number; username: string }> {
  const doer = await seedVerifiedUser({ username: "Miller" });
  doerId = doer.id;
  doerToken = (await mintFor(doer.id, "w", "write:repository")).plaintext;
  return doer;
}

/** An owner-level hook created BEFORE the migrate POST — the birth emission's
 *  observer (the repo row does not exist until the request, so the hook must
 *  hang off the OWNER, which the fan-out matches). */
async function seedOwnerEverythingHook(ownerId: number): Promise<void> {
  await drizzle(env.DB).insert(webhooks).values({
    ownerId,
    url: "https://hooks.example.com/migrate",
    events: JSON.stringify({ send_everything: true }),
    isActive: true,
  });
}

/** The delivery log, oldest first — the emission assertion surface. */
const deliveries = () =>
  drizzle(env.DB).select().from(webhookDeliveries).orderBy(webhookDeliveries.id).all();

/** The `repository` action=created rows — the single-emission counter. The
 *  delivery log stores upstream's 2-space MarshalIndent shape, so the match
 *  tolerates the whitespace after the colon. */
const createdEmissions = async (): Promise<typeof webhookDeliveries.$inferSelect[]> => {
  const rows = await deliveries();
  return rows.filter(
    (row) => row.eventType === "repository" && /"action":\s*"created"/.test(row.payloadContent),
  );
};

const repoRow = (slug: string) =>
  drizzle(env.DB).select().from(repositories).where(eq(repositories.slug, slug)).get();

function migrateBody(extra: Partial<ServerMigrateOptions> = {}): ServerMigrateOptions {
  return { clone_addr: SOURCE_URL, repo_name: "migrated", ...extra };
}

async function postMigrate(body: ServerMigrateOptions, token = doerToken): Promise<Response> {
  return SELF.fetch(`${API}/repos/migrate`, {
    method: "POST",
    headers: token === "" ? { "content-type": "application/json" } : { authorization: `token ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  // The full generated migration ledger + the repo_settings DDL-in-waiting
  // (the description path writes the stored subset — the imports.test.ts
  // bootstrap, same SCHEMA GAP note).
  await applyAuthD1Migrations();
  for (const statement of REPO_SETTINGS_DDL_STATEMENTS) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  for (const table of [
    "repo_mirrors",
    "repo_imports",
    "repo_settings",
    "repo_counters",
    "repo_units",
    "repo_redirects",
    "repo_transfer",
    "webhook_deliveries",
    "webhooks",
    "repositories",
    "personal_access_tokens",
    "org_members",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
  await seedDoer();
});

// ---------------------------------------------------------------------------
// The mirror arm (mirror=true) — 201 → the sync's population settle
// ---------------------------------------------------------------------------

interface RecordingQueue extends Queue {
  sent: unknown[];
}

/** MIRROR_SYNC_QUEUE stub — the route's enqueue is CAPTURED here instead of
 *  reaching the live dev-queue consumer, whose real-network sync would hang
 *  the sync_state CAS this test's manual drive needs (the SELF-level arms
 *  below are queue-independent and stay on the real worker). */
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

/** The contract-`User` projection the auth middleware hands handlers (the
 *  mirror.test.ts userIdentity shape) for the seeded doer. */
function contractUser(id: number, login: string) {
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

/** The local route app: the mirror family + a token resolver for the seeded
 *  doer, real bindings + the recording queue + the injectable KEK (the
 *  mirror.test.ts makeApp pattern). */
function makeFlowApp(queue: RecordingQueue, user: ReturnType<typeof contractUser>): (path: string, init?: RequestInit) => Promise<Response> {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerMirrorRoutes(app, createTokenAuthMiddleware({ resolveToken: (token) => Promise.resolve(token === "flow-token" ? user : null) }));
  return (path, init) =>
    Promise.resolve(
      app.fetch(new Request(`https://example.com${path}`, init), {
        ...env,
        MIRROR_SYNC_QUEUE: queue,
        MIRROR_CREDENTIAL_KEY: KEK,
      }),
    );
}

describe("POST /repos/migrate — mirror arm (mirror=true)", () => {
  it("creates the repository, registers the mirror due-now, kicks exactly one sync, and settles through it", async () => {
    // The source: real pushed content; its ACTUAL refs become the advert.
    await ensureSeededRepo({ owner: "migrate-src", slug: "upstream", commits: SEED_COMMITS });
    await seedOwnerEverythingHook(doerId);
    const queue = recordingQueue();
    const app = makeFlowApp(queue, contractUser(doerId, "miller"));

    const res = await app("/repos/migrate", {
      method: "POST",
      headers: { authorization: "token flow-token", "content-type": "application/json" },
      body: JSON.stringify(migrateBody({ mirror: true, repo_name: "mirrored", description: "mirrored from upstream", auth_token: "tok-123" })),
    });
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body.full_name).toBe("miller/mirrored");
    expect(body.empty).toBe(true);
    // The born body renders the POST-ATTACH state (RD19's finding 1): upstream
    // births the row with IsMirror already set (routers/api/v1/repo/migrate.go
    // CreateRepositoryDirectly receives IsMirror: opts.Mirror) and renders the
    // migrated repo in the 201, so a mirror=true request's born body carries
    // mirror:true — the detail GET was already the honest arm; the route's
    // pre-registerMirror snapshot rendered mirror:false.
    expect(body.mirror).toBe(true);
    expect(JSON.stringify(body)).not.toContain("tok-123"); // credentials never echo (§4.2)
    expect(body.import).toBeUndefined(); // the bootstrap is the mirror=false arm's

    // Exactly ONE sync message armed the initial population (§2.6).
    const repo = await repoRow("mirrored");
    expect(repo).toBeDefined();
    expect(queue.sent).toEqual([{ kind: "mirror-sync", repoId: repo!.id }]);

    // The born row: ready + empty + mirror-flagged + sanitized origin.
    expect(repo!.ownerNamespace).toBe("miller");
    expect(repo!.isMirror).toBe(true);
    expect(repo!.originalUrl).toBe(SOURCE_URL);
    expect(repo!.status).toBe("ready"); // mirrors never leave ready (sync settle writes no status)
    expect(repo!.isEmpty).toBe(true);

    // The mirror row: registered due immediately, credentials sealed.
    const mirror = await drizzle(env.DB).select().from(repoMirrors).where(eq(repoMirrors.repoId, repo!.id)).get();
    expect(mirror).toBeDefined();
    expect(mirror!.remoteAddress).toBe(SOURCE_URL);
    expect(mirror!.syncState).toBe("idle");
    expect(mirror!.nextSyncAt).toBeGreaterThan(0);
    expect(mirror!.credentialsCiphertext).not.toBeNull();

    // The description rides the repo-edit stored subset.
    const settings = await drizzle(env.DB).select().from(repoSettings).where(eq(repoSettings.repoId, repo!.id)).get();
    expect(settings?.description).toBe("mirrored from upstream");

    // THE SINGLE BIRTH EMISSION: exactly one repository-created, in-request.
    expect(await createdEmissions()).toHaveLength(1);
    expect((await createdEmissions())[0]!.payloadContent).toMatch(/"name":\s*"mirrored"/);

    // Poll leg: the repo renders empty before the sync lands.
    const before = await SELF.fetch(`${API}/repos/miller/mirrored`);
    expect(before.status).toBe(200);
    expect((await before.json<Record<string, unknown>>()).empty).toBe(true);

    // Settle leg: drive the captured sync by hand (stubbed source fetch —
    // no live consumer ever saw the recorded message).
    const sourceRefs = await env.REPO.getByName("migrate-src/upstream").listRefs();
    const { pack } = await buildHistoryPack(SEED_COMMITS);
    const { fetchImpl } = stubFetch([
      advertResponse(v0AdvertBytes(sourceRefs.refs, sourceRefs.head)),
      resultResponse(packResponseBytes(pack)),
    ]);
    const result = await handleMirrorSync(
      // The ciphertext was sealed with the injected KEK — the sync must
      // decrypt with the same one (the ambient .dev.vars KEK would fail).
      { ...env, MIRROR_CREDENTIAL_KEY: KEK },
      { repoId: repo!.id, fetchImpl, now: NOW },
    );
    expect(result).toEqual({ ok: true, created: 1, updated: 0, deleted: 0 });

    // The population settle flipped the row; the schedule advanced.
    const settled = await repoRow("mirrored");
    expect(settled!.isEmpty).toBe(false);
    expect(settled!.status).toBe("ready");
    const mirrorAfter = await drizzle(env.DB).select().from(repoMirrors).where(eq(repoMirrors.repoId, repo!.id)).get();
    expect(mirrorAfter!.lastSyncAt).toBe(1700000100);
    expect(mirrorAfter!.nextSyncAt).toBe(1700000100 + DEFAULT_INTERVAL);

    // Poll: empty:false after the settle.
    const after = await SELF.fetch(`${API}/repos/miller/mirrored`);
    expect((await after.json<Record<string, unknown>>()).empty).toBe(false);

    // STILL exactly one created — the settle must not double-fire (f5406c3).
    // The sync's push-family events flow separately (§2.7).
    expect(await createdEmissions()).toHaveLength(1);
    const pushRows = (await deliveries()).filter((row) => row.eventType !== "repository");
    expect(pushRows.length).toBeGreaterThan(0);
  });

  it("zeroes the metadata flags for mirror=true (upstream migrate.go:159-166 parity)", async () => {
    const res = await postMigrate(migrateBody({ mirror: true, issues: true, wiki: true, releases: true }));
    expect(res.status).toBe(201);
    const repo = await repoRow("migrated");
    expect(repo!.isMirror).toBe(true);
  });

  it("seals source credentials in the §4.2 envelope (service level — the KEK is injectable)", async () => {
    const outcome = await migrateRepository(
      env.DB,
      { ...env, MIRROR_CREDENTIAL_KEY: KEK },
      (await drizzle(env.DB).select().from(users).where(eq(users.id, doerId)).get())!,
      migrateBody({ mirror: true, auth_token: "tok-123" }),
      new Date(),
    );
    const row = await drizzle(env.DB).select().from(repoMirrors).where(eq(repoMirrors.repoId, outcome.repo.id)).get();
    expect(row!.credentialsCiphertext).not.toBeNull();
    expect(await mirrorAuthHeader({ ...env, MIRROR_CREDENTIAL_KEY: KEK }, row!)).toBe("Bearer tok-123");
    expect(JSON.stringify(outcome.mirror)).not.toContain("tok-123");
  });

  it("fails the credential pre-flight BEFORE the birth write when the KEK is missing", async () => {
    // Explicit absence (ADR-0005 D3): defeat ambient .dev.vars values.
    await expect(
      migrateRepository(
        env.DB,
        { ...env, MIRROR_CREDENTIAL_KEY: undefined },
        (await drizzle(env.DB).select().from(users).where(eq(users.id, doerId)).get())!,
        migrateBody({ mirror: true, auth_token: "tok-123" }),
        new Date(),
      ),
    ).rejects.toBeInstanceOf(MirrorCredentialKeyError);
    expect(await repoRow("migrated")).toBeUndefined(); // no stranded born row
    expect(await createdEmissions()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The plain-import arm (mirror=false) — 201 migrating → the chunked channel
// ---------------------------------------------------------------------------

describe("POST /repos/migrate — plain-import arm (mirror=false)", () => {
  it("creates the migrating repository, bootstraps the import channel, and settles ready through it", async () => {
    await seedOwnerEverythingHook(doerId);

    const res = await postMigrate(migrateBody({ mirror: false, repo_name: "imported", description: "imported once" }));
    expect(res.status).toBe(201);
    const body = await res.json<Record<string, unknown>>();
    expect(body.full_name).toBe("miller/imported");
    expect(body.empty).toBe(true); // the migrating repo renders like upstream's

    // The §2.2 divergence's bootstrap: the one-time token the caller drives
    // the chunked channel with (documented `import` extension field).
    const bootstrap = body.import as {
      import_id: number;
      import_token: string;
      chunk_size_cap: number;
      chunk_count_cap: number;
      upload: string;
    };
    expect(bootstrap.import_id).toBeTypeOf("number");
    expect(bootstrap.import_token).toMatch(/^imp_[0-9a-f]{40}$/);
    expect(bootstrap.chunk_count_cap).toBe(200);
    expect(bootstrap.upload).toContain(`/repos/miller/imported/imports/${bootstrap.import_id}/chunks/{n}`);

    // The born row: migrating + original_url, NOT mirror-flagged, no mirror row.
    const repo = await repoRow("imported");
    expect(repo).toBeDefined();
    expect(repo!.status).toBe("migrating");
    expect(repo!.isEmpty).toBe(true);
    expect(repo!.isMirror).toBe(false);
    expect(repo!.originalUrl).toBe(SOURCE_URL);
    const mirror = await drizzle(env.DB).select().from(repoMirrors).where(eq(repoMirrors.repoId, repo!.id)).get();
    expect(mirror).toBeUndefined();

    // Exactly one birth emission; the import channel's own create stays silent.
    expect(await createdEmissions()).toHaveLength(1);

    // Drive the chunked channel through the REAL relay endpoints.
    const { tips, pack } = await buildHistoryPack(SEED_COMMITS);
    const tip = tips[tips.length - 1]!;
    const digest = await crypto.subtle.digest("SHA-1", pack.subarray(0, pack.length - 20));
    const sha1Hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    // The upload template is mount-absolute (/api/v1/...) — strip the mount
    // prefix SELF already carries in API.
    const putUrl = `${API}${bootstrap.upload.replace(/^\/api\/v1/, "").replace("{n}", "0")}`;
    const put = await SELF.fetch(putUrl, {
      method: "PUT",
      headers: {
        "x-import-token": bootstrap.import_token,
        "x-chunk-sha1": sha1Hex,
        "content-type": "application/octet-stream",
      },
      body: pack,
    });
    expect(put.status).toBe(200);

    // Start via the SERVICE (no queue fan-out): the relay endpoints' start
    // arm is imports.test.ts's coverage — here the channel must run without
    // racing the live dev-queue consumer, which would double-run the chunk
    // receive and fail the create on its own "fetch first".
    const started = await new ImportService(env.DB).start(bootstrap.import_id, {
      head: "main",
      refs: { "refs/heads/main": tip },
      chunks: [{ n: 0, bytes: pack.length, sha1: sha1Hex, tip }],
      totalBytes: pack.length,
    });
    expect(started.pending).toEqual([0]);

    // The consumer leg (indexChunk → finalize → settleDone), driven by hand.
    expect(await indexChunk(env, bootstrap.import_id, repo!.id, 0)).toBe(true);

    const settled = await repoRow("imported");
    expect(settled!.status).toBe("ready");
    expect(settled!.isEmpty).toBe(false);
    expect(settled!.defaultBranch).toBe("main");

    // The settle emitted NOTHING (the f5406c3 silence guard on this route's
    // arm): the delivery log still holds exactly the one created.
    expect(await createdEmissions()).toHaveLength(1);
    expect(await deliveries()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ACL + validation arms (the §2.2 restricted shape)
// ---------------------------------------------------------------------------

describe("POST /repos/migrate — ACL and validation arms", () => {
  it("401s anonymous", async () => {
    expect((await postMigrate(migrateBody({ mirror: true }), "")).status).toBe(401);
    expect(await createdEmissions()).toHaveLength(0);
  });

  it("403s a target that is another USER (upstream text), 422s an unknown owner", async () => {
    const other = await seedVerifiedUser({ username: "Other" });
    const denied = await postMigrate(migrateBody({ mirror: true, repo_owner: other.username }));
    expect(denied.status).toBe(403);
    expect(((await denied.json<{ message: string }>())).message).toBe("Given user is not an organization.");

    const ghost = await postMigrate(migrateBody({ mirror: true, repo_owner: "ghost" }));
    expect(ghost.status).toBe(422);
    expect(((await ghost.json<{ message: string }>())).message).toBe("user does not exist [name: ghost]");
    expect(await createdEmissions()).toHaveLength(0);
  });

  it("403s a non-owner org target and 201s an owned one (org owners migrate)", async () => {
    const orgs = new OrgService(env.DB);
    const other = await seedVerifiedUser({ username: "OrgOwner" });
    await orgs.createOrg({ name: "acme", ownerId: other.id });

    const denied = await postMigrate(migrateBody({ mirror: true, repo_owner: "acme" }));
    expect(denied.status).toBe(403);
    expect(((await denied.json<{ message: string }>())).message).toBe("Given user is not owner of organization.");

    // The doer owns their own org: the repo is born under it.
    await orgs.createOrg({ name: "mine", ownerId: doerId });
    const ok = await postMigrate(migrateBody({ mirror: true, repo_owner: "mine", repo_name: "org-repo" }));
    expect(ok.status).toBe(201);
    const repo = await repoRow("org-repo");
    expect(repo!.ownerNamespace).toBe("mine");
  });

  it("422s the URL-shape and option families (route level, env-independent arms)", async () => {
    const cases: [ServerMigrateOptions, string][] = [
      [migrateBody({ clone_addr: "http://src.example.com/r.git", mirror: true }), "The provided URL is invalid."],
      [migrateBody({ clone_addr: "https://user:pass@src.example.com/r.git", mirror: true }), "The provided URL is invalid."],
      [migrateBody({ mirror: true, mirror_interval: "soon" }), "invalid mirror_interval"],
      [migrateBody({ mirror: true, mirror_interval: "5m" }), "below the minimum"],
      [migrateBody({ mirror: true, service: "github" }), "unsupported service"],
      [migrateBody({ mirror: false, issues: true }), "metadata migration is not supported for this service"],
    ];
    for (const [body, message] of cases) {
      const res = await postMigrate(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(((await res.json<{ message: string }>())).message).toContain(message);
    }
    // Bind: upstream's Go bind answers malformed/missing-required with 422.
    const noName = await postMigrate({ clone_addr: SOURCE_URL, mirror: true, repo_name: "" });
    expect(noName.status).toBe(422);
    expect(((await noName.json<{ message: string }>())).message).toContain("invalid migrate options");

    expect(await repoRow("migrated")).toBeUndefined();
    expect(await createdEmissions()).toHaveLength(0);
  });

  it("422s the private-range egress arm (service level — the gate env is injectable)", async () => {
    await expect(
      migrateRepository(
        env.DB,
        // Explicit absence (ADR-0005 D3): defeat ambient .dev.vars lists.
        { ...env, MIRROR_ALLOWED_HOST_LIST: undefined, MIRROR_EGRESS_MODE: undefined },
        (await drizzle(env.DB).select().from(users).where(eq(users.id, doerId)).get())!,
        migrateBody({ clone_addr: "https://10.0.0.1/r.git", mirror: true }),
        new Date(),
      ),
    ).rejects.toThrow("You can not import from disallowed hosts.");
    expect(await repoRow("r")).toBeUndefined();
  });

  it("409s a name collision with upstream's exact text and 422s an unusable name", async () => {
    await new RepoService(env.DB).create({ owner: { id: doerId, usernameLower: "miller" }, name: "dup", isPrivate: false });
    const collision = await postMigrate(migrateBody({ mirror: true, repo_name: "dup" }));
    expect(collision.status).toBe(409);
    expect(((await collision.json<{ message: string }>())).message).toBe(
      "The repository with the same name already exists.",
    );

    const invalid = await postMigrate(migrateBody({ mirror: true, repo_name: "in valid" }));
    expect(invalid.status).toBe(422);
    expect(((await invalid.json<{ message: string }>())).message).toContain("repository name is not allowed");

    // The colliding arm's mirror row never registered either.
    const mirrors = await drizzle(env.DB).select().from(repoMirrors).all();
    expect(mirrors).toHaveLength(0);
    expect(await createdEmissions()).toHaveLength(0);
  });

  it("uid targets the owner by id (upstream's repo_owner → uid → doer order)", async () => {
    const other = await seedVerifiedUser({ username: "ByUid" });
    // uid of another plain user + non-admin doer → the same 403 family.
    const denied = await postMigrate(migrateBody({ mirror: true, uid: other.id }));
    expect(denied.status).toBe(403);
    // The doer's own uid → born.
    const ok = await postMigrate(migrateBody({ mirror: true, repo_name: "by-uid", uid: doerId }));
    expect(ok.status).toBe(201);
    expect((await repoRow("by-uid"))!.ownerNamespace).toBe("miller");
  });

  it("private=true births a private repository", async () => {
    await seedOwnerEverythingHook(doerId);
    const res = await postMigrate(migrateBody({ mirror: true, private: true }));
    expect(res.status).toBe(201);
    expect((await repoRow("migrated"))!.visibility).toBe("private");
    // The delivery fan-out still sees the owner hook for the private birth.
    expect(await createdEmissions()).toHaveLength(1);
  });

  it("counts exactly zero emissions when every arm fails before the birth", async () => {
    await seedOwnerEverythingHook(doerId);
    for (const body of [
      migrateBody({ clone_addr: "http://src.example.com/r.git", mirror: true }),
      migrateBody({ mirror: true, repo_owner: "ghost" }),
      migrateBody({ mirror: true, repo_name: "dup", mirror_interval: "soon" }),
    ]) {
      const res = await postMigrate(body);
      expect(res.status).toBe(422);
    }
    expect(await deliveries()).toHaveLength(0);
  });
});
