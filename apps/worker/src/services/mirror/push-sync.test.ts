/**
 * Outbound push-mirror sync (SPEC specs/push-mirror-outbound.md §4/§7) on
 * real D1 + real engine DOs (workerd, @cloudflare/vitest-plugin).
 *
 * THE ROUND-TRIP ORACLE (§7): the sync's `fetchImpl` seam is pointed at the
 * WORKER'S OWN ENGINE — the test constructs a second createDurableGit mount
 * over the test env (the entrypoint's shape) and rewrites
 * `https://mirror.test/<repo>.git/...` onto trusted-internal loopback
 * requests (markGateCleared). Zero mocks beyond transport: the client reads
 * the engine's REAL receive-pack advertisement, the loopback upload-pack
 * generates a real pack from real R2-backed packs, and the POST lands in the
 * engine's real receive server in a SECOND seeded repo. Assertions run over
 * genuine engine state: the remote's listRefs matches ours, report-status is
 * all-ok, the row settles, a second sync is a no-op, a local deletion prunes
 * the remote (deletes-only → no packfile), and a local rewind force-pushes
 * over the diverged remote tip (the loopback answers a valid 0-object pack —
 * §6.14).
 *
 * THE IN-TEST MINI RECEIVE-PACK SERVER (§7): a workerd-compatible HTTP
 * handler (advertisement + POST command-parse + pack object-sink +
 * report-status responder with configurable per-ref ok/ng/unpack-error and
 * optional Basic auth) drives the failure arms — 401 advertisement, `ng
 * non-fast-forward` — and the diverged-remote command capture (old := the
 * remote's advertised tip).
 *
 * The state-machine battery runs against real D1: the cron producer's
 * due-select + CAS enqueue (archived excluded, interval-0 never scheduled),
 * the busy skip on a lost claim, the failure settle leaving `next_sync_at`
 * due with sanitized `last_error`, the success settle scheduling
 * `now + interval`, and the sync-on-commit producer's `sync_on_commit`
 * eligibility. NO real network anywhere: the only stubs are the fetchImpl
 * seam and the recording queue.
 */

import { env } from "cloudflare:workers";

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { createDurableGit } from "@cf-gitea/git-engine";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { pushMirrors, repositories } from "../../db/schema";
import { authorize } from "../../git-http/authorize";
import { markGateCleared } from "../../git-http/gate";
import { ensureSeededRepo, type SeedCommit } from "../../ui/testing/seed-repo";import { SmartHttpError, ZERO_OID, type FetchImpl } from "./gitclient";
import { RECEIVE_PACK_ADVERTISEMENT_CT, RECEIVE_PACK_RESULT_CT } from "./pushclient";
import {
  enqueueDuePushMirrorSyncs,
  enqueuePushMirrorSyncsOnCommit,
  handlePushMirrorSync,
  isPushMirrorSyncMessage,
} from "./push-sync";
import { NOOP_CTX, SYNCING_SWEEP_AFTER_SEC } from "./sync";

// ---------------------------------------------------------------------------
// Byte helpers (the sync.test.ts precedent — test-file copies)
// ---------------------------------------------------------------------------

const TE = new TextEncoder();
const TD = new TextDecoder();

function pkt(payload: string | Uint8Array): Uint8Array {
  const bytes = typeof payload === "string" ? TE.encode(payload) : payload;
  const out = new Uint8Array(bytes.length + 4);
  out.set(TE.encode(`${(bytes.length + 4).toString(16).padStart(4, "0")}`), 0);
  out.set(bytes, 4);
  return out;
}

const FLUSH_PKT = TE.encode("0000");

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Strict 4-hex pkt-line length over a buffer (the engine's PktParser rules). */
function framesOf(buf: Uint8Array): { kind: "flush"; next: number } | { kind: "line"; text: string; next: number } | { kind: "short" } {
  if (buf.length < 4) return { kind: "short" };
  let len = 0;
  for (let i = 0; i < 4; i++) {
    const c = buf[i]!;
    const d = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x61 && c <= 0x66 ? c - 0x57 : c >= 0x41 && c <= 0x5a ? c - 0x37 : -1;
    if (d < 0) return { kind: "short" };
    len = (len << 4) | d;
  }
  if (len === 0) return { kind: "flush", next: 4 };
  if (len < 4 || buf.length < len) return { kind: "short" };
  return { kind: "line", text: TD.decode(buf.subarray(4, len)).trimEnd(), next: len };
}

// ---------------------------------------------------------------------------
// The engine loopback — the round-trip oracle's transport (§7)
// ---------------------------------------------------------------------------

const MIRROR_HOST = "mirror.test";

/** The engine handler, the entrypoint's twin (authorize + headless +
 *  namespaced) — plays the REMOTE in the oracle tests. */
const remoteEngine = createDurableGit<Env>({ authorize, ui: false, namespaces: true });

/** Rewrite `https://mirror.test/<repo>.git/...` onto a trusted-internal
 *  engine request — the SPEC §7 seam ("rewrites into the trusted-internal
 *  loopback form"). Any other host is a test bug. */
function engineSeam(): FetchImpl {
  return (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== MIRROR_HOST) return Promise.reject(new Error(`unexpected fetch ${url.href}`));
    const req = new Request(`https://loopback.internal${url.pathname}${url.search}`, init);
    markGateCleared(req);
    return remoteEngine.fetch(req, env, NOOP_CTX);
  };
}

/** A trusted-internal receive into an engine repo (the sync.ts runReceive
 *  composition) — test-side ref surgery (rewinds, deletes) on OUR repo. */
async function engineReceive(
  repoName: string,
  commands: { old: string; next: string; ref: string }[],
  pack: Uint8Array | null,
): Promise<string> {
  let section = "";
  commands.forEach((cmd, i) => {
    const line = i === 0 ? `${cmd.old} ${cmd.next} ${cmd.ref}\0report-status` : `${cmd.old} ${cmd.next} ${cmd.ref}`;
    section += `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
  });
  section += "0000";
  const sectionBytes = TE.encode(section);
  const body = pack === null ? sectionBytes : concatBytes(sectionBytes, pack);
  const req = new Request(`https://loopback.internal/${repoName}.git/git-receive-pack`, {
    method: "POST",
    headers: {
      "content-type": "application/x-git-receive-pack-request",
      ...(pack === null ? { "content-length": String(sectionBytes.length) } : {}),
    },
    body,
    ...(pack === null ? {} : { duplex: "half" as const }),
  });
  markGateCleared(req);
  const response = await remoteEngine.fetch(req, env, NOOP_CTX);
  const text = TD.decode(await response.arrayBuffer());
  if (response.status !== 200 || text.includes("ng ")) {
    throw new Error(`engine receive failed: ${response.status} ${text.slice(0, 300)}`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// The mini receive-pack server (§7) — failure arms + command capture
// ---------------------------------------------------------------------------

interface MiniRemote {
  fetchImpl: FetchImpl;
  /** The advertised (and, on success, applied) ref state. */
  refs: Map<string, string>;
  /** Every receive-pack POST's parsed commands + requested caps + pack size. */
  received: { commands: { old: string; next: string; ref: string }[]; caps: string[]; packBytes: number }[];
}

function miniReceiveServer(options: {
  refs: [string, string][];
  /** Required Authorization header value — mismatch/absence → 401. */
  authHeader?: string;
  caps?: string;
  /** Per-ref refusal (report-status ng <ref> <message>). */
  reject?: Record<string, string>;
  /** Whole-pack refusal (report-status `unpack <error>`). */
  unpackError?: string;
}): MiniRemote {
  const refs = new Map(options.refs);
  const caps = options.caps ?? "report-status delete-refs agent=git/2.45";
  const received: MiniRemote["received"] = [];

  const advertisement = (): Response => {
    const parts: Uint8Array[] = [pkt("# service=git-receive-pack\n"), FLUSH_PKT];
    const entries = [...refs.entries()];
    if (entries.length === 0) {
      parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    } else {
      entries.forEach(([name, oid], i) => {
        parts.push(pkt(i === 0 ? `${oid} ${name}\0${caps}\n` : `${oid} ${name}\n`));
      });
    }
    parts.push(FLUSH_PKT);
    return new Response(new Uint8Array(concatBytes(...parts)), {
      status: 200,
      headers: { "content-type": RECEIVE_PACK_ADVERTISEMENT_CT },
    });
  };

  const unauthorized = (): Response => new Response("unauthorized", { status: 401 });

  const fetchImpl: FetchImpl = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== MIRROR_HOST) throw new Error(`unexpected fetch ${url.href}`);
    // The client passes plain-object headers (runRequest's shape).
    const headers = init?.headers;
    const authorization =
      headers instanceof Headers ? headers.get("authorization") : ((headers as Record<string, string> | undefined)?.authorization ?? null);
    if (options.authHeader !== undefined && authorization !== options.authHeader) {
      return unauthorized();
    }
    if (url.pathname.endsWith("/info/refs")) return advertisement();
    if (!url.pathname.endsWith("/git-receive-pack")) throw new Error(`unexpected path ${url.pathname}`);

    // POST: parse the command section (pkt frames to the flush), count the
    // remaining bytes as the pack (the object sink — never parsed here), apply
    // the commands CAS-ly, answer report-status.
    const body = new Uint8Array(await new Request(url, init).arrayBuffer());
    const commands: { old: string; next: string; ref: string }[] = [];
    const requestCaps: string[] = [];
    let pos = 0;
    for (;;) {
      const frame = framesOf(body.subarray(pos));
      if (frame.kind === "short") throw new Error("malformed command section");
      if (frame.kind === "flush") {
        pos += frame.next;
        break;
      }
      const [head, capText] = frame.text.split("\0");
      const sp = (head ?? "").indexOf(" ");
      if (sp < 0) throw new Error(`malformed command line: ${frame.text.slice(0, 60)}`);
      const old = head!.slice(0, sp);
      const rest = head!.slice(sp + 1);
      const sp2 = rest.indexOf(" ");
      commands.push({ old, next: rest.slice(0, sp2 < 0 ? rest.length : sp2), ref: rest.slice(sp2 < 0 ? rest.length : sp2 + 1) });
      if (capText !== undefined && capText !== "") requestCaps.push(...capText.split(" "));
      pos += frame.next;
    }
    const packBytes = body.length - pos;
    received.push({ commands, caps: requestCaps, packBytes });

    let report: Uint8Array;
    if (options.unpackError !== undefined) {
      report = concatBytes(pkt(`unpack ${options.unpackError}\n`), FLUSH_PKT);
    } else {
      const lines: Uint8Array[] = [];
      for (const cmd of commands) {
        const rejected = options.reject?.[cmd.ref];
        if (rejected !== undefined) {
          lines.push(pkt(`ng ${cmd.ref} ${rejected}\n`));
          continue;
        }
        const current = refs.get(cmd.ref) ?? ZERO_OID; // an empty remote CASes creates against the zero id
        if (current !== cmd.old) {
          lines.push(pkt(`ng ${cmd.ref} fetch first\n`));
          continue;
        }
        if (cmd.next === ZERO_OID) refs.delete(cmd.ref);
        else refs.set(cmd.ref, cmd.next);
        lines.push(pkt(`ok ${cmd.ref}\n`));
      }
      report = concatBytes(pkt("unpack ok\n"), ...lines, FLUSH_PKT);
    }
    return new Response(new Uint8Array(report), { status: 200, headers: { "content-type": RECEIVE_PACK_RESULT_CT } });
  };

  return { fetchImpl, refs, received };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const NOW = new Date(1700000100000); // unix 1700000100
const NOW_SEC = 1700000100;

const SEED_COMMITS: SeedCommit[] = [
  { message: "seed base\n", files: [{ path: "README.md", content: "push mirror source base\n" }], time: 1700000000 },
  { message: "seed tip\n", files: [{ path: "README.md", content: "push mirror source tip\n" }], time: 1700000001 },
];

let slugSeq = 0;

async function repoIdOf(owner: string, slug: string): Promise<{ repoId: string; row: typeof repositories.$inferSelect }> {
  const row = await drizzle(env.DB)
    .select()
    .from(repositories)
    .where(eq(repositories.ownerNamespace, owner.toLowerCase()))
    .all()
    .then((rows) => rows.find((r) => r.slug === slug));
  if (row === undefined) throw new Error(`repo row missing: ${owner}/${slug}`);
  return { repoId: row.id, row };
}

/** One push mirror row over the D1 defaults (idle / unscheduled). */
async function seedPushMirror(repoId: string, remoteAddress: string, overrides: Partial<typeof pushMirrors.$inferInsert> = {}): Promise<number> {
  const inserted = await drizzle(env.DB)
    .insert(pushMirrors)
    .values({
      repoId,
      remoteName: `remote_mirror_t${(slugSeq = (slugSeq + 1) % 100000)}`.padEnd(23, "0"),
      remoteAddress,
      syncOnCommit: false,
      intervalSeconds: 600,
      createdAt: new Date(),
      lastUpdateUnix: null,
      lastError: "",
      ...overrides,
    })
    .returning({ id: pushMirrors.id });
  return inserted[0]!.id;
}

const mirrorRow = (id: number) => drizzle(env.DB).select().from(pushMirrors).where(eq(pushMirrors.id, id)).get();

/** MIRROR_SYNC_QUEUE stub — records sends/batches; flips to failing on demand. */
function recordingQueue(options: { failSends?: boolean } = {}): Queue & { sent: unknown[]; batches: unknown[][] } {
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  const sent: unknown[] = [];
  const batches: unknown[][] = [];
  return {
    sent,
    batches,
    send: (body: unknown) => {
      if (options.failSends === true) return Promise.reject(new Error("queue unavailable"));
      sent.push(body);
      return Promise.resolve({ metadata });
    },
    sendBatch: (messages: MessageSendRequest[]) => {
      batches.push(messages.map((m) => m.body));
      return Promise.resolve({ metadata });
    },
    metrics: () => Promise.resolve({ backlogCount: 0, backlogBytes: 0 }),
  };
}

/** The env with the queue binding swapped for a stub (the real test env has no
 *  live queue consumer; producers must be observable). */
const envWithQueue = (queue: Queue): Parameters<typeof enqueueDuePushMirrorSyncs>[0] => ({ ...env, MIRROR_SYNC_QUEUE: queue });

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["push_mirrors", "repo_counters", "repositories", "personal_access_tokens"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users").run();
});

// ---------------------------------------------------------------------------
// THE ROUND-TRIP ORACLE (§7) — full protocol, zero mocks beyond transport
// ---------------------------------------------------------------------------

describe("handlePushMirrorSync loopback oracle (engine-to-engine)", () => {
  it("E2E: configures a mirror, syncs, and the loopback remote's received refs match ours (creates + update)", async () => {
    const source = await ensureSeededRepo({
      owner: "push-src",
      slug: "oracle-origin",
      commits: SEED_COMMITS,
      tags: [{ name: "v1", commitIndex: 0 }],
    });
    // The remote: a real second engine cell with DIFFERENT main content —
    // the sync must update it and create the tag.
    await ensureSeededRepo({
      owner: "push-dest",
      slug: "oracle-remote",
      commits: [{ message: "remote base\n", files: [{ path: "README.md", content: "remote content\n" }], time: 1700000000 }],
    });

    const { repoId } = await repoIdOf("push-src", "oracle-origin");
    const mirrorId = await seedPushMirror(repoId, `https://${MIRROR_HOST}/push-dest/oracle-remote.git`);
    const result = await handlePushMirrorSync(env, { repoId, pushMirrorId: mirrorId, fetchImpl: engineSeam(), now: NOW });
    expect(result).toEqual({ ok: true, created: 1, updated: 1, deleted: 0, deletesSkipped: 0 });

    // THE ORACLE: the remote's refs match OURS (the pushed refset).
    const ours = await env.REPO.getByName("push-src/oracle-origin").listRefs();
    const theirs = await env.REPO.getByName("push-dest/oracle-remote").listRefs();
    const refset = (rows: { name: string; target: string }[]) =>
      Object.fromEntries(rows.filter((r) => r.name.startsWith("refs/heads/") || r.name.startsWith("refs/tags/")).map((r) => [r.name, r.target]));
    expect(refset(theirs.refs)).toEqual(refset(ours.refs));
    expect(theirs.refs.find((r) => r.name === "refs/heads/main")?.target).toBe(source.tips[1]);
    expect(theirs.refs.find((r) => r.name === "refs/tags/v1")?.target).toBe(source.tips[0]);

    // The row settled: idle, scheduled, clean, attempted-at stamped.
    const row = await mirrorRow(mirrorId);
    expect(row!.syncState).toBe("idle");
    expect(row!.lastUpdateUnix?.getTime()).toBe(NOW_SEC * 1000);
    expect(row!.nextSyncAt).toBe(NOW_SEC + 600);
    expect(row!.lastError).toBe("");
  });

  it("E2E: a second sync is a no-op (zero commands, schedule advanced)", async () => {
    await ensureSeededRepo({ owner: "push-src", slug: "noop-origin", commits: SEED_COMMITS });
    await ensureSeededRepo({
      owner: "push-dest",
      slug: "noop-remote",
      commits: [{ message: "remote\n", files: [{ path: "README.md", content: "remote\n" }], time: 1700000000 }],
    });
    const { repoId } = await repoIdOf("push-src", "noop-origin");
    const mirrorId = await seedPushMirror(repoId, `https://${MIRROR_HOST}/push-dest/noop-remote.git`);
    const first = await handlePushMirrorSync(env, { repoId, pushMirrorId: mirrorId, fetchImpl: engineSeam(), now: NOW });
    expect(first.ok).toBe(true);

    const second = await handlePushMirrorSync(env, { repoId, pushMirrorId: mirrorId, fetchImpl: engineSeam(), now: NOW });
    expect(second).toEqual({ ok: true, skipped: "no-changes", created: 0, updated: 0, deleted: 0, deletesSkipped: 0 });
    const row = await mirrorRow(mirrorId);
    expect(row!.lastUpdateUnix?.getTime()).toBe(NOW_SEC * 1000); // still advances (§4.4)
    expect(row!.nextSyncAt).toBe(NOW_SEC + 600);
  });

  it("E2E: an empty remote receives every ref as a create (full-clone haves=[]) ", async () => {
    const source = await ensureSeededRepo({ owner: "push-src", slug: "fresh-origin", commits: SEED_COMMITS });
    const { repoId } = await repoIdOf("push-src", "fresh-origin");
    // No seeding of the destination — a fresh cell advertises the zero-id
    // capabilities^{} line (§6.7) and takes the loopback full-clone path.
    const mirrorId = await seedPushMirror(repoId, `https://${MIRROR_HOST}/push-dest/fresh-cell-${Date.now()}.git`);
    const result = await handlePushMirrorSync(env, { repoId, pushMirrorId: mirrorId, fetchImpl: engineSeam(), now: NOW });
    expect(result).toEqual({ ok: true, created: 1, updated: 0, deleted: 0, deletesSkipped: 0 });
    const theirs = await env.REPO.getByName(
      (await mirrorRow(mirrorId))!.remoteAddress.replace(`https://${MIRROR_HOST}/`, "").replace(/\.git$/, ""),
    ).listRefs();
    expect(theirs.refs.find((r) => r.name === "refs/heads/main")?.target).toBe(source.tips[1]);
  });

  it("E2E: deleting a local ref prunes the remote — deletes-only sync carries NO packfile", async () => {
    const source = await ensureSeededRepo({
      owner: "push-src",
      slug: "prune-origin",
      commits: SEED_COMMITS,
      tags: [{ name: "v1", commitIndex: 0 }],
    });
    await ensureSeededRepo({
      owner: "push-dest",
      slug: "prune-remote",
      commits: [{ message: "remote\n", files: [{ path: "README.md", content: "remote\n" }], time: 1700000000 }],
    });
    const { repoId } = await repoIdOf("push-src", "prune-origin");
    const mirrorId = await seedPushMirror(repoId, `https://${MIRROR_HOST}/push-dest/prune-remote.git`);
    expect((await handlePushMirrorSync(env, { repoId, pushMirrorId: mirrorId, fetchImpl: engineSeam(), now: NOW })).ok).toBe(true);

    // Local surgery: delete the tag (objects stay; the command section alone
    // is a legal receive when the objects exist).
    const tagTip = source.tips[0]!;
    await engineReceive("push-src/prune-origin", [{ old: tagTip, next: ZERO_OID, ref: "refs/tags/v1" }], null);
    expect((await env.REPO.getByName("push-src/prune-origin").listRefs()).refs.some((r) => r.name === "refs/tags/v1")).toBe(false);

    const result = await handlePushMirrorSync(env, { repoId, pushMirrorId: mirrorId, fetchImpl: engineSeam(), now: NOW });
    expect(result).toEqual({ ok: true, created: 0, updated: 0, deleted: 1, deletesSkipped: 0 });
    const theirs = await env.REPO.getByName("push-dest/prune-remote").listRefs();
    expect(theirs.refs.some((r) => r.name === "refs/tags/v1")).toBe(false); // pruned (the engine advertises delete-refs)
    expect(theirs.refs.find((r) => r.name === "refs/heads/main")?.target).toBe(source.tips[1]); // the rest untouched
  });

  it("E2E: a local rewind force-pushes over the diverged remote tip (0-object pack, §6.14)", async () => {
    const source = await ensureSeededRepo({ owner: "push-src", slug: "force-origin", commits: SEED_COMMITS });
    await ensureSeededRepo({
      owner: "push-dest",
      slug: "force-remote",
      commits: [{ message: "remote\n", files: [{ path: "README.md", content: "remote\n" }], time: 1700000000 }],
    });
    const { repoId } = await repoIdOf("push-src", "force-origin");
    const mirrorId = await seedPushMirror(repoId, `https://${MIRROR_HOST}/push-dest/force-remote.git`);
    expect((await handlePushMirrorSync(env, { repoId, pushMirrorId: mirrorId, fetchImpl: engineSeam(), now: NOW })).ok).toBe(true);

    // Rewind our main tips[1] → tips[0] (the objects exist locally).
    const baseTip = source.tips[0]!;
    const headTip = source.tips[1]!;
    await engineReceive("push-src/force-origin", [{ old: headTip, next: baseTip, ref: "refs/heads/main" }], null);

    const result = await handlePushMirrorSync(env, { repoId, pushMirrorId: mirrorId, fetchImpl: engineSeam(), now: NOW });
    expect(result).toEqual({ ok: true, created: 0, updated: 1, deleted: 0, deletesSkipped: 0 }); // force is client-side (§2.2)
    const theirs = await env.REPO.getByName("push-dest/force-remote").listRefs();
    expect(theirs.refs.find((r) => r.name === "refs/heads/main")?.target).toBe(source.tips[0]); // rewound on the remote
  });
});

// ---------------------------------------------------------------------------
// Failure arms over the mini receive-pack server (§7)
// ---------------------------------------------------------------------------

describe("handlePushMirrorSync failure arms (mini receive-pack server)", () => {
  async function seedPair(slug: string): Promise<{ repoId: string; mirrorId: number; tips: string[] }> {
    const { tips } = await ensureSeededRepo({ owner: "push-src", slug, commits: SEED_COMMITS });
    const { repoId } = await repoIdOf("push-src", slug);
    const mirrorId = await seedPushMirror(repoId, `https://${MIRROR_HOST}/dest/${slug}.git`);
    return { repoId, mirrorId, tips };
  }

  it("401 advertisement → terminal failure, sanitized last_error, next_sync_at left due", async () => {
    const remote = miniReceiveServer({ refs: [], authHeader: "Basic c2VjcmV0OnZhbHVl" }); // "secret:value"
    const { repoId, mirrorId } = await seedPair("fail-401");
    await drizzle(env.DB).update(pushMirrors).set({ nextSyncAt: 1234 }).where(eq(pushMirrors.id, mirrorId));

    const result = await handlePushMirrorSync(env, { repoId, pushMirrorId: mirrorId, fetchImpl: remote.fetchImpl, now: NOW });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("401");
    const row = await mirrorRow(mirrorId);
    expect(row!.syncState).toBe("idle"); // released (the next cron retries)
    expect(row!.lastError).toContain("401");
    expect(row!.nextSyncAt).toBe(1234); // UNCHANGED — left due (§4.4 failure posture)
    expect(row!.lastUpdateUnix?.getTime()).toBe(NOW_SEC * 1000); // attempts are recorded
  });

  it("stored credentials authenticate the mirror target (Basic from the sealed envelope)", async () => {
    const remote = miniReceiveServer({ refs: [], authHeader: "Basic dXNlcjpwYXNz" }); // user:pass
    const { repoId, mirrorId } = await seedPair("fail-auth-ok");
    // Seal the same envelope the API wave stores: AES-256-GCM(nonce||plain), AAD id:repoId.
    const kek = btoa(Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => String.fromCharCode(b)).join(""));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey("raw", Uint8Array.from(atob(kek), (c) => c.charCodeAt(0)), "AES-GCM", false, ["encrypt"]);
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: TE.encode(`${mirrorId}:${repoId}`), tagLength: 128 },
        key,
        TE.encode("Basic dXNlcjpwYXNz"),
      ),
    );
    const framed = new Uint8Array(nonce.length + sealed.length);
    framed.set(nonce);
    framed.set(sealed, 12);
    await drizzle(env.DB)
      .update(pushMirrors)
      .set({ credentialsCiphertext: btoa(Array.from(framed, (b) => String.fromCharCode(b)).join("")) })
      .where(eq(pushMirrors.id, mirrorId));

    // The KEK rides the env the consumer reads (wrangler secret posture).
    const result = await handlePushMirrorSync({ ...env, MIRROR_CREDENTIAL_KEY: kek }, {
      repoId,
      pushMirrorId: mirrorId,
      fetchImpl: remote.fetchImpl,
      now: NOW,
    });
    expect(result).toEqual({ ok: true, created: 1, updated: 0, deleted: 0, deletesSkipped: 0 });
    expect(remote.refs.get("refs/heads/main")).toBe((await env.REPO.getByName("push-src/fail-auth-ok").listRefs()).refs.find((r) => r.name === "refs/heads/main")?.target);
  });

  it("report-status ng non-fast-forward → terminal failure naming the ref; remote state untouched", async () => {
    const remote = miniReceiveServer({ refs: [], reject: { "refs/heads/main": "non-fast-forward" } });
    const { repoId, mirrorId, tips } = await seedPair("fail-ng");
    const result = await handlePushMirrorSync(env, { repoId, pushMirrorId: mirrorId, fetchImpl: remote.fetchImpl, now: NOW });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("refs/heads/main");
    expect(result.error).toContain("non-fast-forward");
    expect(remote.refs.has("refs/heads/main")).toBe(false); // the refused command did not apply
    expect(tips[1]).toBeDefined();
    const row = await mirrorRow(mirrorId);
    expect(row!.lastError).toContain("non-fast-forward");
    expect(row!.nextSyncAt).toBe(0); // failure leaves the schedule untouched (due)
  });

  it("report-status unpack error → terminal failure (§6.5)", async () => {
    const remote = miniReceiveServer({ refs: [], unpackError: "index-pack failed" });
    const { repoId, mirrorId } = await seedPair("fail-unpack");
    const result = await handlePushMirrorSync(env, { repoId, pushMirrorId: mirrorId, fetchImpl: remote.fetchImpl, now: NOW });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unpack index-pack failed");
    expect(remote.received[0]!.packBytes).toBeGreaterThan(0); // a pack WAS sent (creates need objects)
  });

  it("diverged remote: the update command carries old := the remote's advertised tip, and force lands", async () => {
    const remoteTip = "f".repeat(40);
    const remote = miniReceiveServer({ refs: [["refs/heads/main", remoteTip]] });
    const { repoId, mirrorId, tips } = await seedPair("fail-diverged");
    const result = await handlePushMirrorSync(env, { repoId, pushMirrorId: mirrorId, fetchImpl: remote.fetchImpl, now: NOW });
    expect(result).toEqual({ ok: true, created: 0, updated: 1, deleted: 0, deletesSkipped: 0 });
    // The CAS old-value is the REMOTE's tip (never ours) — force semantics (§2.2).
    expect(remote.received[0]!.commands).toEqual([{ old: remoteTip, next: tips[1], ref: "refs/heads/main" }]);
    expect(remote.received[0]!.caps).toContain("report-status");
    expect(remote.received[0]!.caps).toContain("delete-refs");
    expect(remote.refs.get("refs/heads/main")).toBe(tips[1]);
  });

  it("an empty local repo skips the whole sync and never touches the remote (§6.6)", async () => {
    // A D1-only repo row whose cell has no refs — the divergence guard must
    // fire BEFORE the advertisement fetch.
    await env.DB.prepare(
      "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (9, 'pushempty', 'pushempty', 0, 'active', 0)",
    ).run();
    await drizzle(env.DB).insert(repositories).values({
      id: "8801",
      storageKey: "r_8801",
      ownerNamespace: "pushempty",
      ownerId: 9,
      slug: "empty-origin",
      visibility: "public",
      refsVersion: 1,
      backend: "self-hosted",
    });
    const mirrorId = await seedPushMirror("8801", `https://${MIRROR_HOST}/dest/empty-origin.git`);
    const result = await handlePushMirrorSync(env, {
      repoId: "8801",
      pushMirrorId: mirrorId,
      fetchImpl: () => Promise.reject(new Error("NO FETCH MAY HAPPEN")),
      now: NOW,
    });
    expect(result).toEqual({ ok: true, skipped: "empty-local", created: 0, updated: 0, deleted: 0 });
    const row = await mirrorRow(mirrorId);
    expect(row!.lastUpdateUnix?.getTime()).toBe(NOW_SEC * 1000);
    expect(row!.nextSyncAt).toBe(NOW_SEC + 600);
  });

  it("a lost claim (another producer is syncing) acks as busy", async () => {
    const { repoId, mirrorId } = await seedPair("fail-busy");
    await drizzle(env.DB).update(pushMirrors).set({ syncState: "syncing" }).where(eq(pushMirrors.id, mirrorId));
    const result = await handlePushMirrorSync(env, {
      repoId,
      pushMirrorId: mirrorId,
      fetchImpl: () => Promise.reject(new Error("NO FETCH MAY HAPPEN")),
      now: NOW,
    });
    expect(result).toEqual({ ok: false, skipped: "busy" });
  });

  it("a deleted mirror row (or repo) acks as missing-row", async () => {
    const { repoId } = await seedPair("fail-gone");
    expect(await handlePushMirrorSync(env, { repoId, pushMirrorId: 999999, fetchImpl: engineSeam(), now: NOW })).toEqual({
      ok: false,
      skipped: "missing-row",
    });
    expect(await handlePushMirrorSync(env, { repoId: "nope", pushMirrorId: 1, fetchImpl: engineSeam(), now: NOW })).toEqual({
      ok: false,
      skipped: "missing-row",
    });
  });

  it("an egress-denied stored URL is a recorded failure (per-sync re-validation, §5.2)", async () => {
    const { repoId, mirrorId } = await seedPair("fail-egress");
    await drizzle(env.DB).update(pushMirrors).set({ remoteAddress: "http://insecure.example.com/repo.git" }).where(eq(pushMirrors.id, mirrorId));
    const result = await handlePushMirrorSync(env, { repoId, pushMirrorId: mirrorId, fetchImpl: engineSeam(), now: NOW });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("only https");
    const row = await mirrorRow(mirrorId);
    expect(row!.lastError).toContain("only https");
  });
});

// ---------------------------------------------------------------------------
// The state machine (§3.2/§4.1/§4.4)
// ---------------------------------------------------------------------------

describe("push-mirror state machine (cron producer, claims, commit hook)", () => {
  it("isPushMirrorSyncMessage narrows the queue body", () => {
    expect(isPushMirrorSyncMessage({ kind: "push-mirror-sync", repoId: "r1", pushMirrorId: 3 })).toBe(true);
    expect(isPushMirrorSyncMessage({ kind: "push-mirror-sync", repoId: "r1" })).toBe(false);
    expect(isPushMirrorSyncMessage({ kind: "mirror-sync", repoId: "r1" })).toBe(false);
    expect(isPushMirrorSyncMessage(null)).toBe(false);
  });

  it("cron producer: due + never-synced rows enqueue (CAS idle→queued); interval-0, archived and busy rows do not", async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (6, 'cronowner', 'cronowner', 0, 'active', 0)",
    ).run();
    const insertRepo = async (id: string, slug: string, archived = false) => {
      await drizzle(env.DB).insert(repositories).values({
        id,
        storageKey: `r_${id}`,
        ownerNamespace: "cronowner",
        ownerId: 6,
        slug,
        visibility: "public",
        refsVersion: 1,
        backend: "self-hosted",
        isArchived: archived,
      });
    };
    await insertRepo("9001", "due-zero"); // never synced, interval 600 → DUE (§3.2 wake-up)
    await insertRepo("9002", "due-past");
    await insertRepo("9003", "future"); // next_sync_at in the future
    await insertRepo("9004", "nointerval"); // interval 0 → commit-hook only
    await insertRepo("9005", "archived", true); // excluded by the join (§6.12)
    await insertRepo("9006", "queued");
    const dueZero = await seedPushMirror("9001", "https://dest.example.com/a.git", { intervalSeconds: 600, nextSyncAt: 0 });
    const duePast = await seedPushMirror("9002", "https://dest.example.com/b.git", { intervalSeconds: 600, nextSyncAt: NOW_SEC - 10 });
    await seedPushMirror("9003", "https://dest.example.com/c.git", { intervalSeconds: 600, nextSyncAt: NOW_SEC + 9999 });
    await seedPushMirror("9004", "https://dest.example.com/d.git", { intervalSeconds: 0, nextSyncAt: 0 });
    await seedPushMirror("9005", "https://dest.example.com/e.git", { intervalSeconds: 600, nextSyncAt: 0 });
    // A FRESH syncing claim (stamped 1 min ago) is busy — mid-flight, the
    // sweep must not touch it (the 9006 arm of the sweep battery below).
    await seedPushMirror("9006", "https://dest.example.com/f.git", {
      intervalSeconds: 600,
      nextSyncAt: 0,
      syncState: "syncing",
      lastUpdateUnix: new Date((NOW_SEC - 60) * 1000),
    });

    const queue = recordingQueue();
    const enqueued = await enqueueDuePushMirrorSyncs(envWithQueue(queue), { now: NOW });
    expect(enqueued).toBe(2); // 9001 + 9002
    expect(queue.batches[0]).toEqual([
      { kind: "push-mirror-sync", repoId: "9001", pushMirrorId: dueZero },
      { kind: "push-mirror-sync", repoId: "9002", pushMirrorId: duePast },
    ]);
    // The claims stuck: both rows are queued (no double-enqueue next sweep).
    for (const id of [dueZero, duePast]) {
      expect((await mirrorRow(id))!.syncState).toBe("queued");
    }
    // A second sweep enqueues nothing (every due row lost its idle state).
    const queue2 = recordingQueue();
    expect(await enqueueDuePushMirrorSyncs(envWithQueue(queue2), { now: NOW })).toBe(0);
    expect(queue2.batches).toEqual([]);
  });

  it("cron producer without the queue binding throws (the caller's retry signal)", async () => {
    const bare = { ...env, MIRROR_SYNC_QUEUE: undefined } as unknown as Parameters<typeof enqueueDuePushMirrorSyncs>[0];
    await expect(enqueueDuePushMirrorSyncs(bare, { now: NOW })).rejects.toBeInstanceOf(SmartHttpError);
  });

  it("commit hook: sync_on_commit rows enqueue (interval-0 eligible); others do not; best-effort on queue failure", async () => {
    await env.DB.prepare(
      "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (7, 'hookowner', 'hookowner', 0, 'active', 0)",
    ).run();
    await drizzle(env.DB).insert(repositories).values({
      id: "9101",
      storageKey: "r_9101",
      ownerNamespace: "hookowner",
      ownerId: 7,
      slug: "hooked",
      visibility: "public",
      refsVersion: 1,
      backend: "self-hosted",
    });
    await seedPushMirror("9101", "https://dest.example.com/on.git", { syncOnCommit: true, intervalSeconds: 0 });
    const offId = await seedPushMirror("9101", "https://dest.example.com/off.git", { syncOnCommit: false, intervalSeconds: 600 });

    const queue = recordingQueue();
    const enqueued = await enqueuePushMirrorSyncsOnCommit(envWithQueue(queue), "hookowner/hooked");
    expect(enqueued).toBe(1);
    expect(queue.sent.length).toBe(1);
    const message = queue.sent[0] as { kind: string; repoId: string; pushMirrorId: number };
    expect(message.kind).toBe("push-mirror-sync");
    expect(message.repoId).toBe("9101");
    expect(message.pushMirrorId).not.toBe(offId); // only the sync_on_commit row

    // Unknown repo / malformed name → 0, never a throw (the push stands).
    expect(await enqueuePushMirrorSyncsOnCommit(envWithQueue(recordingQueue()), "hookowner/missing")).toBe(0);
    expect(await enqueuePushMirrorSyncsOnCommit(envWithQueue(recordingQueue()), "garbage")).toBe(0);

    // Queue failure → 0, never a throw (upstream's fire-and-forget, §4.1).
    const failing = recordingQueue({ failSends: true });
    expect(await enqueuePushMirrorSyncsOnCommit(envWithQueue(failing), "hookowner/hooked")).toBe(0);
  });

  it("success on interval 0 keeps the mirror unscheduled (commit-triggered only, §7 state battery)", async () => {
    const remote = miniReceiveServer({ refs: [] });
    const { tips } = await ensureSeededRepo({ owner: "push-src", slug: "state-zero", commits: SEED_COMMITS });
    const { repoId } = await repoIdOf("push-src", "state-zero");
    const mirrorId = await seedPushMirror(repoId, `https://${MIRROR_HOST}/dest/state-zero.git`, { intervalSeconds: 0 });
    const result = await handlePushMirrorSync(env, { repoId, pushMirrorId: mirrorId, fetchImpl: remote.fetchImpl, now: NOW });
    expect(result.ok).toBe(true);
    const row = await mirrorRow(mirrorId);
    expect(row!.syncState).toBe("idle");
    expect(row!.nextSyncAt).toBe(0); // interval 0 → never cron-scheduled
    expect(row!.lastError).toBe("");
    expect(tips[1]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// The stuck-syncing sweep (the sqlite-locked-2026-10-26 §4/§5.3 fix brief,
// push half): a settle-step error or a dead consumer used to wedge a row in
// `syncing` forever. The producer reclaims stale claims; the claim itself
// stamps `last_update_unix` so a post-claim death leaves an ageable stamp.
// ---------------------------------------------------------------------------

describe("stuck-syncing sweep (push cron producer)", () => {
  /** D1-only repo — the §6.6 empty-local guard settles the retried sync
   *  before any remote fetch (no engine cell needed). */
  async function seedSweepRepo(id: string, slug: string): Promise<void> {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (8, 'sweepowner', 'sweepowner', 0, 'active', 0)",
    ).run();
    await drizzle(env.DB).insert(repositories).values({
      id,
      storageKey: `r_${id}`,
      ownerNamespace: "sweepowner",
      ownerId: 8,
      slug,
      visibility: "public",
      refsVersion: 1,
      backend: "self-hosted",
    });
  }

  it("stale (beyond the timeout) and stamp-less (pre-fix wedge) syncing rows are reclaimed and re-enqueued; the retry settles", async () => {
    await seedSweepRepo("9201", "sweep-stale");
    const staleId = await seedPushMirror("9201", "https://dest.example.com/stale.git", {
      intervalSeconds: 600,
      nextSyncAt: NOW_SEC - 10,
      syncState: "syncing",
      lastUpdateUnix: new Date((NOW_SEC - SYNCING_SWEEP_AFTER_SEC - 60) * 1000), // 1 min beyond the budget
    });
    await seedSweepRepo("9202", "sweep-null");
    const nullId = await seedPushMirror("9202", "https://dest.example.com/null.git", {
      intervalSeconds: 600,
      nextSyncAt: NOW_SEC - 10,
      syncState: "syncing",
      lastUpdateUnix: null, // a claim from before the claim-stamp — cannot be mid-flight
    });

    const queue = recordingQueue();
    const enqueued = await enqueueDuePushMirrorSyncs(envWithQueue(queue), { now: NOW });
    expect(enqueued).toBe(2);
    // Due-SELECT order: coalesce(last_update_unix, 0) — the stamp-less row first.
    expect(queue.batches[0]).toEqual([
      { kind: "push-mirror-sync", repoId: "9202", pushMirrorId: nullId },
      { kind: "push-mirror-sync", repoId: "9201", pushMirrorId: staleId },
    ]);
    expect((await mirrorRow(staleId))!.syncState).toBe("queued"); // swept idle, re-claimed
    expect((await mirrorRow(nullId))!.syncState).toBe("queued");

    // The retried sync settles the row (empty local → the §6.6 skip → idle).
    const result = await handlePushMirrorSync(env, {
      repoId: "9201",
      pushMirrorId: staleId,
      fetchImpl: () => Promise.reject(new Error("NO FETCH MAY HAPPEN")),
      now: NOW,
    });
    expect(result).toEqual({ ok: true, skipped: "empty-local", created: 0, updated: 0, deleted: 0 });
    const row = await mirrorRow(staleId);
    expect(row!.syncState).toBe("idle");
    expect(row!.nextSyncAt).toBe(NOW_SEC + 600); // schedule advanced by the settle
  });

  it("a FRESH syncing row (claim within the timeout) is not touched; a message acks busy", async () => {
    await seedSweepRepo("9203", "sweep-fresh");
    const freshId = await seedPushMirror("9203", "https://dest.example.com/fresh.git", {
      intervalSeconds: 600,
      nextSyncAt: NOW_SEC - 10,
      syncState: "syncing",
      lastUpdateUnix: new Date((NOW_SEC - 60) * 1000), // claimed 1 min ago — may be mid-sync
    });

    const queue = recordingQueue();
    expect(await enqueueDuePushMirrorSyncs(envWithQueue(queue), { now: NOW })).toBe(0);
    expect(queue.batches).toEqual([]);
    expect((await mirrorRow(freshId))!.syncState).toBe("syncing"); // untouched

    const result = await handlePushMirrorSync(env, {
      repoId: "9203",
      pushMirrorId: freshId,
      fetchImpl: () => Promise.reject(new Error("NO FETCH MAY HAPPEN")),
      now: NOW,
    });
    expect(result).toEqual({ ok: false, skipped: "busy" });
  });
});
