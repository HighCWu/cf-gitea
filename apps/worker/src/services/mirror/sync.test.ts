/**
 * Pull-mirror sync consumer (SPEC-0009 §2.6) — the success-settle battery on
 * real D1 + real engine DOs (workerd, @cloudflare/vitest-plugin), plus the
 * §2.7 webhook-notification battery.
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
 *
 * §2.7 focus: the post-settle webhook fan-out from the applied updates delta.
 * The advertisements are built from buildHistoryPack's REAL commit oids (the
 * pack bytes are real; the engine's receive and the cell's commit walk are
 * real), so the payloads' commit lists are read out of genuine engine state.
 * Notifications are asserted over the webhook_deliveries D1 rows — the
 * delivery log IS the source of truth (SPEC-0005 §3.6); no queue consumer
 * runs here.
 */

import { env } from "cloudflare:workers";

/** Payload origin per the service's instanceOrigin(): the wrangler APP_URL
 *  var when configured (tests ride the real config), upstream's default
 *  ROOT_URL otherwise. */
const EXPECTED_ORIGIN = ((env as { APP_URL?: string }).APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { asc, eq } from "drizzle-orm";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { repoMirrors, repositories, webhookDeliveries, webhooks } from "../../db/schema";
import { getRepoLicenses } from "../repo-licenses";
import { LICENSE_CORPUS_TEXTS } from "../license-corpus";
import { buildHistoryPack, ensureSeededRepo, type SeedCommit } from "../../ui/testing/seed-repo";
import { UPLOAD_PACK_ADVERTISEMENT_CT, UPLOAD_PACK_RESULT_CT, type FetchImpl } from "./gitclient";
import { SYNCING_SWEEP_AFTER_SEC, enqueueDueMirrorSyncs, handleMirrorSync } from "./sync";

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
const NOW_SEC = 1700000100;

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

/** An active repo-scoped webhook subscribed to everything (`send_everything`
 *  matches push/create/delete alike — the §2.6 HasEvent port). */
async function seedPushWebhook(): Promise<number> {
  const inserted = await drizzle(env.DB)
    .insert(webhooks)
    .values({
      repoId: "7401",
      url: "https://hooks.example.com/receive",
      events: JSON.stringify({ send_everything: true }),
      isActive: true,
    })
    .returning({ id: webhooks.id })
    .all();
  return inserted[0]!.id;
}

/** The delivery log, oldest first — the §2.7 assertion surface (the rows are
 *  the pipeline's source of truth; no queue consumer runs in tests). */
const deliveries = () =>
  drizzle(env.DB)
    .select()
    .from(webhookDeliveries)
    .orderBy(asc(webhookDeliveries.id))
    .all();

/** Wipe the delivery log between two syncs of one test. */
const clearDeliveries = () => env.DB.prepare("DELETE FROM webhook_deliveries").run();

const repoRow = () => drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "7401")).get();
const mirrorRow = () => drizzle(env.DB).select().from(repoMirrors).where(eq(repoMirrors.repoId, "7401")).get();

/** MIRROR_SYNC_QUEUE stub — records sendBatch bodies (the push-sync.test.ts
 *  shape; test-file copies are the precedent). */
function recordingQueue(): Queue & { batches: unknown[][] } {
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  const batches: unknown[][] = [];
  return {
    batches,
    send: () => Promise.resolve({ metadata }),
    sendBatch: (messages: MessageSendRequest[]) => {
      batches.push(messages.map((m) => m.body));
      return Promise.resolve({ metadata });
    },
    metrics: () => Promise.resolve({ backlogCount: 0, backlogBytes: 0 }),
  };
}

const envWithQueue = (queue: Queue): Parameters<typeof enqueueDueMirrorSyncs>[0] => ({ ...env, MIRROR_SYNC_QUEUE: queue });

beforeAll(async () => {
  // The full generated migration ledger (0010 included) — repo_mirrors and
  // the repositories mirror columns exist here.
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["repo_mirrors", "repo_counters", "repo_license", "repositories", "personal_access_tokens", "webhook_deliveries", "webhooks"]) {
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

// ---------------------------------------------------------------------------
// §2.7 — webhook notifications from the applied updates delta
// ---------------------------------------------------------------------------

/** Two real commits — the create battery's source (branch at tips[1]). */
const CREATE_SOURCE: SeedCommit[] = [
  { message: "create-base\n", files: [{ path: "README.md", content: "create base\n" }], time: 1700000000 },
  { message: "create-tip\n", files: [{ path: "README.md", content: "create tip\n" }], time: 1700000001 },
];

/** Seven real commits — the capped-update battery: a tips[0]→tips[6] delta
 *  carries 6 in-range commits, one past the FeedMaxCommitNum cap of 5. */
const UPDATE_SOURCE: SeedCommit[] = Array.from({ length: 7 }, (_, i) => ({
  message: `c${i}\n`,
  files: [{ path: "README.md", content: `update content ${i}\n` }],
  time: 1700000000 + i,
}));

const ZERO40 = "0".repeat(40);

/** Typed views of the stored payload JSON — the §2.7 wire shapes the
 *  assertions navigate (JSON.parse alone is `any`; eslint forbids reaching
 *  into it untyped). */
interface PayloadUserJson {
  name: string;
  email: string;
  username: string;
}

interface PayloadCommitJson {
  id: string;
  message: string;
  author: PayloadUserJson;
  committer: PayloadUserJson;
  timestamp: string;
  verification: Record<string, unknown>;
  url: string;
}

interface PushPayloadJson {
  ref: string;
  before: string;
  after: string;
  compare_url: string;
  commits: PayloadCommitJson[];
  total_commits: number;
  head_commit: PayloadCommitJson | null;
  repository: { full_name: string };
  pusher: { login: string };
  sender: { login: string };
}

interface CreatePayloadJson {
  sha: string;
  ref: string;
  ref_type: string;
  repository: { full_name: string };
  sender: { login: string };
}

interface DeletePayloadJson {
  ref: string;
  ref_type: string;
  pusher_type: string;
  repository: { full_name: string };
  sender: { login: string };
}

const parsePush = (payloadContent: string): PushPayloadJson => JSON.parse(payloadContent) as PushPayloadJson;
const parseCreate = (payloadContent: string): CreatePayloadJson => JSON.parse(payloadContent) as CreatePayloadJson;
const parseDelete = (payloadContent: string): DeletePayloadJson => JSON.parse(payloadContent) as DeletePayloadJson;

/** The two deliveries one created ref emits, in upstream's order
 *  (mirror_pull.go:347 zero-commit push, :352 create). */
function expectCreatePair(rows: { eventType: string; payloadContent: string }[], fullRef: string, shortName: string, refType: string, sha: string, repository: unknown, sender: unknown): void {
  const [pushRow, createRow] = rows;
  expect(rows).toHaveLength(2);
  expect(pushRow!.eventType).toBe("push");
  const push = parsePush(pushRow!.payloadContent);
  // The zero-commit push event (upstream SyncPushCommits with an empty
  // PushCommits rendered by services/webhook/notifier.go:909-920).
  expect(push).toMatchObject({
    ref: fullRef,
    before: ZERO40,
    after: sha,
    commits: [],
    total_commits: 0,
    head_commit: null,
    repository,
    pusher: sender,
    sender,
  });
  expect(createRow!.eventType).toBe("create");
  // The create event (upstream CreateRef, notifier.go:821-836: sha, short
  // ref name, ref_type).
  expect(parseCreate(createRow!.payloadContent)).toEqual({
    sha,
    ref: shortName,
    ref_type: refType,
    repository,
    sender,
  });
}

describe("handleMirrorSync webhook notifications (§2.7)", () => {
  it("emits the zero-commit push event + create event per created ref, with the repo owner as pusher/sender", async () => {
    const { tips, pack } = await buildHistoryPack(CREATE_SOURCE);
    await seedMirrorTarget("mirror-create");
    await seedPushWebhook();

    const refs = [
      { name: "refs/heads/main", target: tips[1]! },
      { name: "refs/tags/v1", target: tips[0]! },
    ];
    const { fetchImpl } = stubFetch([
      advertResponse(v0AdvertBytes(refs, "refs/heads/main")),
      resultResponse(packResponseBytes(pack)),
    ]);
    const result = await handleMirrorSync(env, { repoId: "7401", fetchImpl, now: NOW });
    expect(result).toEqual({ ok: true, created: 2, updated: 0, deleted: 0 });

    // Two refs × (push + create), in command order (branch first — the
    // advertisement's order), each pair push-then-create (upstream :347/:352).
    const rows = await deliveries();
    expect(rows.map((r) => r.eventType)).toEqual(["push", "create", "push", "create"]);

    // Sender identity: upstream passes m.Repo.MustOwner(ctx) as the pusher of
    // every mirror notification (mirror_pull.go:347,352) and the webhook
    // renderer sets BOTH pusher and sender to it (notifier.go:919-920).
    const sender = parsePush(rows[0]!.payloadContent).sender;
    expect(sender.login).toBe("cf-gitea-stub");
    const repository = parsePush(rows[0]!.payloadContent).repository;
    expect(repository.full_name).toBe("cf-gitea-stub/mirror-create");

    expectCreatePair(rows.slice(0, 2), "refs/heads/main", "main", "branch", tips[1]!, repository, sender);
    expectCreatePair(rows.slice(2, 4), "refs/tags/v1", "v1", "tag", tips[0]!, repository, sender);

    // The compat-frozen 2-space byte shape (SPEC-0005 §2.7).
    expect(rows[0]!.payloadContent).toContain('\n  "ref"');

    // The settle stands: notifications never disturb it.
    expect((await mirrorRow())!.syncState).toBe("idle");
    expect((await mirrorRow())!.lastError).toBeNull();
  });

  it("emits the push event with the capped old→new commit list for an updated ref", async () => {
    const { tips, pack } = await buildHistoryPack(UPDATE_SOURCE);
    await seedMirrorTarget("mirror-update");
    await seedPushWebhook();

    // Sync 1 lands the base tip (a create — its deliveries are wiped below).
    const { fetchImpl } = stubFetch([
      advertResponse(v0AdvertBytes([{ name: "refs/heads/main", target: tips[0]! }], "refs/heads/main")),
      resultResponse(packResponseBytes(pack)),
    ]);
    expect(await handleMirrorSync(env, { repoId: "7401", fetchImpl, now: NOW })).toEqual({
      ok: true,
      created: 1,
      updated: 0,
      deleted: 0,
    });
    await clearDeliveries();

    // Sync 2: the source moved main tips[0] → tips[6]; the same deterministic
    // pack carries every object (the receive is real, the delta is real).
    const second = stubFetch([
      advertResponse(v0AdvertBytes([{ name: "refs/heads/main", target: tips[6]! }], "refs/heads/main")),
      resultResponse(packResponseBytes(pack)),
    ]);
    expect(await handleMirrorSync(env, { repoId: "7401", fetchImpl: second.fetchImpl, now: NOW })).toEqual({
      ok: true,
      created: 0,
      updated: 1,
      deleted: 0,
    });

    const rows = await deliveries();
    expect(rows.map((r) => r.eventType)).toEqual(["push"]); // no create/delete for an update
    const push = parsePush(rows[0]!.payloadContent);
    expect(push.ref).toBe("refs/heads/main");
    expect(push.before).toBe(tips[0]);
    expect(push.after).toBe(tips[6]);
    expect(push.compare_url).toBe(`${EXPECTED_ORIGIN}/cf-gitea-stub/mirror-update/compare/${tips[0]}...${tips[6]}`);

    // The capped commit list. DEVIATION (documented in sync.ts): the engine's
    // listCommitsRange caps the OLDEST-first topological order, so the 6-commit
    // delta's window carries the five OLDEST commits (tips[1..5]) — upstream's
    // rev-list --max-count keeps the newest five. Still exactly 5, still
    // newest-first within the window.
    expect(push.total_commits).toBe(5);
    expect(push.commits.map((c) => c.id)).toEqual([tips[5], tips[4], tips[3], tips[2], tips[1]]);
    // head_commit always names the true new tip (the separate tip read —
    // upstream's own GetCommit(newCommitID), mirror_pull.go:373).
    expect(push.head_commit!.id).toBe(tips[6]);
    expect(push.pusher.login).toBe("cf-gitea-stub");
    expect(push.sender.login).toBe("cf-gitea-stub");

    // PayloadCommit shape (convert.ToPayloadCommit port): git identity,
    // author-date timestamp, unverified signature, instance-shaped url.
    const commit = push.commits[0]!;
    expect(commit.id).toBe(tips[5]);
    expect(commit.message.startsWith("c5")).toBe(true);
    expect(commit.author).toEqual({ name: "Test User", email: "test@example.com", username: "" });
    expect(commit.committer).toEqual({ name: "Test User", email: "test@example.com", username: "" });
    expect(commit.timestamp).toBe(new Date(1700000005 * 1000).toISOString());
    expect(commit.verification).toEqual({
      verified: false,
      reason: "gpg.error.not_signed_commit",
      signature: "",
      signer: null,
      payload: "",
    });
    expect(commit.url).toBe(`${EXPECTED_ORIGIN}/cf-gitea-stub/mirror-update/commit/${tips[5]}`);
  });

  it("emits the delete event for a pruned ref", async () => {
    const { tips, pack } = await buildHistoryPack(CREATE_SOURCE);
    await seedMirrorTarget("mirror-prune");
    await seedPushWebhook();

    // Sync 1 lands main + legacy.
    const firstRefs = [
      { name: "refs/heads/main", target: tips[1]! },
      { name: "refs/heads/legacy", target: tips[0]! },
    ];
    const first = stubFetch([advertResponse(v0AdvertBytes(firstRefs, "refs/heads/main")), resultResponse(packResponseBytes(pack))]);
    expect(await handleMirrorSync(env, { repoId: "7401", fetchImpl: first.fetchImpl, now: NOW })).toEqual({
      ok: true,
      created: 2,
      updated: 0,
      deleted: 0,
    });
    await clearDeliveries();

    // Sync 2: the source no longer advertises legacy; prune deletes it. No
    // missing tips → the prune-only refs-only receive (no fetch POST — the
    // stub serves the advert alone and rejects any further call).
    const second = stubFetch([advertResponse(v0AdvertBytes([firstRefs[0]!], "refs/heads/main"))]);
    expect(await handleMirrorSync(env, { repoId: "7401", fetchImpl: second.fetchImpl, now: NOW })).toEqual({
      ok: true,
      created: 0,
      updated: 0,
      deleted: 1,
    });

    const rows = await deliveries();
    expect(rows.map((r) => r.eventType)).toEqual(["delete"]);
    const payload = parseDelete(rows[0]!.payloadContent);
    // Upstream DeleteRef (notifier.go:858-870): short ref name, ref_type,
    // pusher_type "user".
    expect(payload).toMatchObject({
      ref: "legacy",
      ref_type: "branch",
      pusher_type: "user",
    });
    expect(payload.sender.login).toBe("cf-gitea-stub");
    expect(payload.repository.full_name).toBe("cf-gitea-stub/mirror-prune");
  });

  it("fetches refs/pull/* deltas but never notifies them", async () => {
    const { tips, pack } = await buildHistoryPack(CREATE_SOURCE);
    await seedMirrorTarget("mirror-pullref");
    await seedPushWebhook();

    // A GitHub-ride-along PR ref: fetched into the mirror, excluded from the
    // notifications (upstream mirror_pull.go:334-337).
    const refs = [
      { name: "refs/heads/main", target: tips[1]! },
      { name: "refs/pull/7/head", target: tips[0]! },
    ];
    const { fetchImpl } = stubFetch([
      advertResponse(v0AdvertBytes(refs, "refs/heads/main")),
      resultResponse(packResponseBytes(pack)),
    ]);
    const result = await handleMirrorSync(env, { repoId: "7401", fetchImpl, now: NOW });
    expect(result).toEqual({ ok: true, created: 2, updated: 0, deleted: 0 });

    // The PR ref really landed in the mirror cell (fetched, not dropped).
    const mirrored = await env.REPO.getByName("cf-gitea-stub/mirror-pullref").listRefs();
    expect(mirrored.refs.find((r) => r.name === "refs/pull/7/head")?.target).toBe(tips[0]);

    // Only the branch's pair was notified; no payload names a refs/pull/* ref.
    const rows = await deliveries();
    expect(rows.map((r) => r.eventType)).toEqual(["push", "create"]);
    expect(parsePush(rows[0]!.payloadContent).ref).toBe("refs/heads/main");
    for (const row of rows) {
      expect(row.payloadContent).not.toContain("refs/pull/");
    }
  });

  it("keeps the sync and settle green when the notification fan-out fails", async () => {
    const { tips, pack } = await buildHistoryPack(CREATE_SOURCE);
    await seedMirrorTarget("mirror-notifyfail");
    await seedPushWebhook();

    // Break the fan-out's storage: the delivery insert will throw. The
    // §2.7 posture (post-settle best-effort) must absorb it.
    await env.DB.prepare("DROP TABLE webhook_deliveries").run();

    const refs = [{ name: "refs/heads/main", target: tips[1]! }];
    const { fetchImpl } = stubFetch([
      advertResponse(v0AdvertBytes(refs, "refs/heads/main")),
      resultResponse(packResponseBytes(pack)),
    ]);
    const result = await handleMirrorSync(env, { repoId: "7401", fetchImpl, now: NOW });
    expect(result).toEqual({ ok: true, created: 1, updated: 0, deleted: 0 });

    // The sync itself stands: mirror row settled, refs landed.
    const mirror = await mirrorRow();
    expect(mirror!.syncState).toBe("idle");
    expect(mirror!.lastError).toBeNull();
    expect(mirror!.lastSyncAt).toBe(1700000100);
    const mirrored = await env.REPO.getByName("cf-gitea-stub/mirror-notifyfail").listRefs();
    expect(mirrored.refs.find((r) => r.name === "refs/heads/main")?.target).toBe(tips[1]);

    // Restore the table (migration 0002's DDL) so later runs of this file
    // start from the landed schema regardless of storage isolation.
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
      hook_id integer NOT NULL,
      repo_id text NOT NULL,
      uuid text NOT NULL,
      event_type text NOT NULL,
      event_group text NOT NULL,
      payload_content text NOT NULL,
      state text DEFAULT 'pending' NOT NULL,
      attempts integer DEFAULT 0 NOT NULL,
      is_succeed integer DEFAULT false NOT NULL,
      request_content text,
      response_content text,
      created_unix integer,
      delivered_unix integer
    )`).run();
  });
});

// ---------------------------------------------------------------------------
// The license settle (mirror_pull.go:406-413) — upstream enqueues the license
// updater unconditionally on the SyncMirrors success path; the consumer-shaped
// walk (services/repo-licenses.ts, license.go:70-102) scans the settled
// default branch and diffs repo_license at its tip.
// ---------------------------------------------------------------------------

/** The corpus MIT text — a real detectable license for the settle scan. */
const MIT_TEXT = LICENSE_CORPUS_TEXTS.find(([id]) => id === "MIT")![1];

const LICENSE_SOURCE: SeedCommit[] = [
  {
    message: "licensed source\n",
    files: [
      { path: "README.md", content: "licensed mirror source\n" },
      { path: "LICENSE", content: MIT_TEXT },
    ],
    time: 1700000000,
  },
];

describe("handleMirrorSync license settle (mirror_pull.go:406-413)", () => {
  it("a completed sync populates repo_license from the mirrored default branch", async () => {
    // The source: real pushed content carrying an MIT LICENSE; the
    // advertisement is built from its actual refs (the population-settle
    // harness shape).
    await ensureSeededRepo({ owner: "mirror-src", slug: "licensed", commits: LICENSE_SOURCE });
    const sourceRefs = await env.REPO.getByName("mirror-src/licensed").listRefs();
    const sourceTip = sourceRefs.refs.find((r) => r.name === "refs/heads/main")!.target;

    await seedMirrorTarget("mirror-licensed");
    const { fetchImpl } = stubFetch([
      advertResponse(v0AdvertBytes(sourceRefs.refs, sourceRefs.head)),
      resultResponse(packResponseBytes((await buildHistoryPack(LICENSE_SOURCE)).pack)),
    ]);
    const result = await handleMirrorSync(env, { repoId: "7401", fetchImpl, now: NOW });
    expect(result).toEqual({ ok: true, created: 1, updated: 0, deleted: 0 });

    const rendered = () =>
      getRepoLicenses(env.DB, "7401").then((rows) =>
        rows.map((r) => ({ license: r.license, licensePath: r.licensePath, commitId: r.commitId })),
      );
    expect(await rendered()).toEqual([{ license: "MIT", licensePath: "LICENSE", commitId: sourceTip }]);

    // The no-changes resync — upstream's enqueue is unconditional on the
    // success path — rescans and rewrites the same row in place; the table
    // does not grow.
    const again = stubFetch([advertResponse(v0AdvertBytes(sourceRefs.refs, sourceRefs.head))]);
    const second = await handleMirrorSync(env, { repoId: "7401", fetchImpl: again.fetchImpl, now: NOW });
    expect(second).toEqual({ ok: true, skipped: "no-changes", created: 0, updated: 0, deleted: 0 });
    expect(await rendered()).toEqual([{ license: "MIT", licensePath: "LICENSE", commitId: sourceTip }]);
  });

  it("a sync whose source legitimately stays empty writes no rows (the unborn-default skip, license.go:79-81)", async () => {
    await seedMirrorTarget("mirror-licensed-empty");
    const { fetchImpl } = stubFetch([advertResponse(v0EmptyAdvertBytes())]);
    const result = await handleMirrorSync(env, { repoId: "7401", fetchImpl, now: NOW });
    expect(result).toEqual({ ok: true, skipped: "no-changes", created: 0, updated: 0, deleted: 0 });
    expect(await getRepoLicenses(env.DB, "7401")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The stuck-syncing sweep (the sqlite-locked-2026-10-26 §4/§5.3 fix brief):
// a settle-step error or a dead consumer used to wedge a row in `syncing`
// forever — the claim requires `idle|queued`, the retry acks `busy`, the
// cron SELECT takes `idle` only. The producer now reclaims stale claims.
// ---------------------------------------------------------------------------

describe("stuck-syncing sweep (pull cron producer)", () => {
  /** Force the harness mirror row into the wedge shape: a syncing claim with
   *  a given claim stamp and schedule (seedMirrorTarget's row is idle). */
  const setSyncing = async (claimedAtSec: number, nextSyncAt: number) => {
    await drizzle(env.DB)
      .update(repoMirrors)
      .set({ syncState: "syncing", updatedAt: new Date(claimedAtSec * 1000), nextSyncAt })
      .where(eq(repoMirrors.repoId, "7401"));
  };

  it("a syncing row older than the timeout is reclaimed and re-enqueued in the same tick; the retried sync settles", async () => {
    await seedMirrorTarget("sweep-stale");
    // The wedge: claimed 1 min beyond the budget, consumer died before any
    // settle — next_sync_at still due (claims never advance it).
    await setSyncing(NOW_SEC - SYNCING_SWEEP_AFTER_SEC - 60, NOW_SEC - 10);

    const queue = recordingQueue();
    const enqueued = await enqueueDueMirrorSyncs(envWithQueue(queue), { now: NOW });
    expect(enqueued).toBe(1);
    expect(queue.batches[0]).toEqual([{ kind: "mirror-sync", repoId: "7401" }]);
    // The two-step discipline: swept `syncing → idle`, then the producer's
    // own due-SELECT + CAS re-claimed it `idle → queued`.
    expect((await mirrorRow())!.syncState).toBe("queued");

    // The retried sync settles the row (empty source → no-changes → idle).
    const { fetchImpl } = stubFetch([advertResponse(v0EmptyAdvertBytes())]);
    const result = await handleMirrorSync(env, { repoId: "7401", fetchImpl, now: NOW });
    expect(result).toEqual({ ok: true, skipped: "no-changes", created: 0, updated: 0, deleted: 0 });
    const row = await mirrorRow();
    expect(row!.syncState).toBe("idle");
    expect(row!.lastError).toBeNull();
    expect(row!.nextSyncAt).toBe(NOW_SEC + 28800); // schedule advanced by the settle
  });

  it("a FRESH syncing row (claim within the timeout) is not touched; the producer skips it and a message acks busy", async () => {
    await seedMirrorTarget("sweep-fresh");
    await setSyncing(NOW_SEC - 60, NOW_SEC - 10); // claimed 1 min ago — may be mid-sync

    const queue = recordingQueue();
    expect(await enqueueDueMirrorSyncs(envWithQueue(queue), { now: NOW })).toBe(0);
    expect(queue.batches).toEqual([]);
    expect((await mirrorRow())!.syncState).toBe("syncing"); // untouched

    // The consumer-side proof: a (redelivered) message acks busy, it may own it.
    const result = await handleMirrorSync(env, {
      repoId: "7401",
      fetchImpl: () => Promise.reject(new Error("NO FETCH MAY HAPPEN")),
      now: NOW,
    });
    expect(result).toEqual({ ok: false, skipped: "busy" });
  });

  it("a due QUEUED row is left for its in-flight message (the sweep reclaims syncing only)", async () => {
    await seedMirrorTarget("sweep-queued");
    await drizzle(env.DB)
      .update(repoMirrors)
      .set({ syncState: "queued", nextSyncAt: NOW_SEC - 10 })
      .where(eq(repoMirrors.repoId, "7401"));

    const queue = recordingQueue();
    expect(await enqueueDueMirrorSyncs(envWithQueue(queue), { now: NOW })).toBe(0);
    expect(queue.batches).toEqual([]);
    expect((await mirrorRow())!.syncState).toBe("queued");
  });
});
