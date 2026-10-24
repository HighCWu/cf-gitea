/**
 * Pull-mirror sync consumer (SPEC-0009 §2.6) — the success-settle battery on
 * real D1 + real engine DOs (workerd, @cloudflare/vitest-plugin).
 *
 * The SOURCE is real pushed content via the seed pattern (ui/testing/
 * seed-repo.ts): deterministic pack bytes pushed through the landed git-http
 * receive flow into a source cell, whose ACTUAL refs (read back through
 * env.REPO) become the v0 advertisement the outbound client sees. The only
 * stub is the fetchImpl seam (NO real network — the established webhook
 * consumer pattern, Workers tests cannot bind sockets): it answers the
 * advertisement and serves the same deterministic pack bytes the source
 * holds, so the mirror's internal receive lands REAL objects in the mirror
 * cell — the engine's connectivity verdict is real — and the settle's
 * listRefs re-check decides over genuine engine state.
 *
 * Regression focus: the population settle. A fresh mirror of a non-empty
 * source must render empty:false at GET /repos/... (is_empty=false + the
 * engine's HEAD branch), while a source that legitimately syncs zero refs
 * stays empty.
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { repoMirrors, repositories } from "../../db/schema";
import { buildHistoryPack, ensureSeededRepo, type SeedCommit } from "../../ui/testing/seed-repo";
import { UPLOAD_PACK_ADVERTISEMENT_CT, UPLOAD_PACK_RESULT_CT, type FetchImpl } from "./gitclient";
import { handleMirrorSync } from "./sync";

// ---------------------------------------------------------------------------
// Byte fixtures (the gitclient.test.ts local helpers — deliberately not
// exported there; these are test-file copies, the seed-repo.ts precedent)
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

/** A v0 advertisement over the source cell's REAL refs: HEAD (resolved
 *  through headSymref) on the capabilities line, then one line per ref. */
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

/** The v0 empty-source advertisement (capabilities^{} + unborn HEAD). */
function v0EmptyAdvertBytes(): Uint8Array {
  return concatBytes(
    pkt(`# service=git-upload-pack\n`),
    FLUSH_PKT,
    pkt(`${"0".repeat(40)} capabilities^{}\0shallow side-band-64k unborn HEAD refs/heads/main agent=git/2.45\n`),
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

const SOURCE_URL = "https://src.example.com/org/repo.git";
/** Fixed settle clock (unix seconds → 1700000100). */
const NOW = new Date(1700000100000);

const SEED_COMMITS: SeedCommit[] = [
  {
    message: "seed main\n",
    files: [{ path: "README.md", content: "mirror source content\n" }],
    time: 1700000000,
  },
];

async function seedMirrorTarget(slug: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  await drizzle(env.DB).insert(repositories).values({
    id: "7401",
    storageKey: "r_7401",
    ownerNamespace: "cf-gitea-stub",
    ownerId: 1,
    slug,
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
  });
  await drizzle(env.DB).insert(repoMirrors).values({
    repoId: "7401",
    intervalSeconds: 28800,
    enablePrune: true,
    remoteAddress: SOURCE_URL,
    syncState: "idle",
    nextSyncAt: 0,
  });
}

const repoRow = () => drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "7401")).get();
const mirrorRow = () => drizzle(env.DB).select().from(repoMirrors).where(eq(repoMirrors.repoId, "7401")).get();

beforeAll(async () => {
  // The full generated migration ledger (0010 included) — repo_mirrors and
  // the repositories mirror columns exist here.
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["repo_mirrors", "repo_counters", "repositories", "personal_access_tokens"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users").run();
});

// ---------------------------------------------------------------------------
// The population settle (§2.6 step 5)
// ---------------------------------------------------------------------------

describe("handleMirrorSync population settle", () => {
  it("a fresh mirror of a non-empty source lands the refs and settles empty:false + the engine's HEAD branch", async () => {
    // The source: real pushed content through the real receive flow; the
    // advertisement below is built from its actual refs, not a canned tip.
    await ensureSeededRepo({ owner: "mirror-src", slug: "upstream", commits: SEED_COMMITS });
    const sourceRefs = await env.REPO.getByName("mirror-src/upstream").listRefs();
    expect(sourceRefs.refs.map((r) => r.name)).toContain("refs/heads/main");

    await seedMirrorTarget("mirror-target");
    expect((await repoRow())!.isEmpty).toBe(true); // the fresh-mirror premise

    const { fetchImpl } = stubFetch([
      advertResponse(v0AdvertBytes(sourceRefs.refs, sourceRefs.head)),
      resultResponse(packResponseBytes((await buildHistoryPack(SEED_COMMITS)).pack)),
    ]);
    const result = await handleMirrorSync(env, { repoId: "7401", fetchImpl, now: NOW });
    expect(result).toEqual({ ok: true, created: 1, updated: 0, deleted: 0 });

    // The engine really holds the mirrored ref (the receive was real).
    const mirrored = await env.REPO.getByName("cf-gitea-stub/mirror-target").listRefs();
    expect(mirrored.head).toBe("refs/heads/main");
    expect(mirrored.refs.find((r) => r.name === "refs/heads/main")?.target).toBe(
      sourceRefs.refs.find((r) => r.name === "refs/heads/main")?.target,
    );

    // THE REGRESSION: the repositories row no longer renders as empty, and
    // the default branch is the engine's HEAD — settleDone's shape.
    const repo = await repoRow();
    expect(repo!.isEmpty).toBe(false);
    expect(repo!.defaultBranch).toBe("main");
    expect(repo!.status).toBe("ready"); // mirrors never leave ready

    // The mirror row itself settled (CAS released, schedule advanced).
    const mirror = await mirrorRow();
    expect(mirror!.syncState).toBe("idle");
    expect(mirror!.lastSyncAt).toBe(1700000100);
    expect(mirror!.nextSyncAt).toBe(1700000100 + 28800);
    expect(mirror!.lastError).toBeNull();

    // Steady state: the next sync of an unchanged source is a no-changes
    // settle that leaves the populated row untouched (no flip, no extra RPC
    // beyond the settle re-check gate on is_empty — already false here).
    const again = stubFetch([advertResponse(v0AdvertBytes(sourceRefs.refs, sourceRefs.head))]);
    const second = await handleMirrorSync(env, { repoId: "7401", fetchImpl: again.fetchImpl, now: NOW });
    expect(second).toEqual({ ok: true, skipped: "no-changes", created: 0, updated: 0, deleted: 0 });
    expect((await repoRow())!.isEmpty).toBe(false);
  });

  it("keeps a repo whose source legitimately advertises zero refs empty", async () => {
    // A dedicated cell: DO storage outlives the D1 rows across this file's
    // tests, and a prune sync of an empty source must not trip over the
    // other test's leftover refs.
    await seedMirrorTarget("mirror-empty");
    const { fetchImpl } = stubFetch([advertResponse(v0EmptyAdvertBytes())]);
    const result = await handleMirrorSync(env, { repoId: "7401", fetchImpl, now: NOW });
    expect(result).toEqual({ ok: true, skipped: "no-changes", created: 0, updated: 0, deleted: 0 });

    const repo = await repoRow();
    expect(repo!.isEmpty).toBe(true); // an empty source must NOT populate the row
    expect(repo!.status).toBe("ready");
    const mirror = await mirrorRow();
    expect(mirror!.syncState).toBe("idle");
    expect(mirror!.lastSyncAt).toBe(1700000100); // still a successful sync
  });
});
