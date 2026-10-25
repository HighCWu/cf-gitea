/**
 * User-push webhook notifications (SPEC-0005 §3.5 "push pipeline") — the
 * push/create/delete family emitted from the engine's `onPush` seam, over
 * REAL pushes through the SPEC-0003 gitHttpGate (real D1 + real engine DOs +
 * real R2; the established integration pattern of push-create.test.ts and
 * gate.test.ts).
 *
 * The engine under test is constructed with the EXACT composition the
 * entrypoint wiring adds (index.ts, orchestrator-owned):
 *
 *   createDurableGit<Env>({ authorize, ui: false, namespaces: true,
 *     onPush: (event, env) => handleUserPushEvent(env, event) })
 *
 * so the receive → finalize → onPush → fan-out path is the production path —
 * the only stub is the ExecutionContext's waitUntil, collected and drained
 * deterministically instead of relying on runner timing. Deliveries are
 * asserted over the webhook_deliveries D1 rows — the delivery log IS the
 * source of truth (§3.6); no queue consumer runs here.
 *
 * Covered: the per-created-ref zero-commit push + create pair, the updated-ref
 * capped push payload (newest-first commit list, added/removed/modified
 * enrichment, head_commit, compare_url), the delete event, the
 * pull_request_sync family (an updated PR head branch syncs every open
 * github-flow PR on it with the delta; created refs, non-PR branches and
 * closed PRs stay silent; the subscription gates), the refs/pull/*
 * exclusion on a mixed receive, the subscription gates (push_only,
 * branch_filter, inactive, no hooks), owner-level hook resolution, the
 * never-fail-the-push guarantees (the engine's hook catch + the fan-out's
 * per-ref resilience), the pusher identity (the gate-threaded authenticated
 * pusher — a non-owner collaborator names himself; owner pushes unchanged;
 * client-forged x-push-user headers ignored on both the gated and the
 * engine-native path; the owner fallback for identity-less receives; the
 * explicit users-row override) and the missing-owner/unknown-repo degrades.
 */

import { env } from "cloudflare:workers";

/** Payload origin per the service's instanceOrigin(): the wrangler APP_URL
 *  var when configured (tests ride the real config), upstream's default
 *  ROOT_URL otherwise. */
const EXPECTED_ORIGIN = ((env as { APP_URL?: string }).APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDurableGit, type DurableGitHandler } from "@cf-gitea/git-engine";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { basicHeader, basicTokenHeader, mintFor, seedVerifiedUser } from "../auth/testing/seeds";
import { findRepositoryById } from "../api/services/repository";
import { TeamsService } from "../api/routes/org-teams";
import { users, webhookDeliveries, webhooks } from "../db/schema";
import { IssuesService } from "../issues/service";
import { authorize } from "../git-http/authorize";
import { gitHttpGate } from "../git-http/gate";
import { OrgService } from "../services/orgs/orgs";
import { RepoService, type RepoRow } from "../repos/service";
import {
  emitPushFamilyUpdates,
  handleUserPushEvent,
  handleUserPushNotifications,
  PUSH_ZERO_OID,
  type WebhookPushWalk,
} from "./webhooks-push";

// ---------------------------------------------------------------------------
// The engine under test — the entrypoint wiring's exact composition
// ---------------------------------------------------------------------------

/** The production shape: gate → engine with the onPush seam wired to the
 *  adapter (the one-line wiring this wave recommends for src/index.ts). */
const wiredEngine = createDurableGit<Env>({
  authorize,
  ui: false,
  namespaces: true,
  onPush: (event, env2) => handleUserPushEvent(env2, event),
});

/** The seam's failure half (packages/git-engine mod.ts:1051 catches hook
 *  rejections off the response path): a push must land even when the hook
 *  explodes. The fan-out's own never-throw posture is pinned separately. */
const rejectingEngine = createDurableGit<Env>({
  authorize,
  ui: false,
  namespaces: true,
  onPush: () => Promise.reject(new Error("webhook fan-out exploded")),
});

// ---------------------------------------------------------------------------
// ExecutionContext stub — real waitUntil collection (sync.ts's NOOP_CTX
// shape, with a collecting sink so onPush is deterministic in tests)
// ---------------------------------------------------------------------------

class NoopSpan {
  get isTraced(): boolean {
    return false;
  }
  spanContext(): TracingSpanContext {
    return { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 };
  }
  setAttribute(_key: string, _value: boolean | number | string): this {
    return this;
  }
  setAttributes(_attributes: Record<string, boolean | number | string | undefined>): this {
    return this;
  }
  recordException(
    _exception: string | { code: string | number; name?: string; message?: string; stack?: string },
  ): void {}
  updateName(_name: string): this {
    return this;
  }
  setStatus(_status: TracingSpanStatus): this {
    return this;
  }
  end(): void {}
}

/** ctx.exports is the runtime-built loopback over the entry module's own
 *  exports — nothing on this path reads it (sync.ts's deliberate assertion). */
const EXPORTS_HOLE = undefined as never;

const pendingWaits: Promise<unknown>[] = [];

const ctx: ExecutionContext = {
  waitUntil: (promise) => {
    pendingWaits.push(Promise.resolve(promise));
  },
  passThroughOnException: () => {},
  abort: () => {},
  exports: EXPORTS_HOLE,
  props: undefined,
  tracing: {
    enterSpan: <T, A extends unknown[]>(_name: string, callback: (span: NoopSpan, ...args: A) => T, ...args: A): T =>
      callback(new NoopSpan(), ...args),
    startActiveSpan: <T, A extends unknown[]>(
      _name: string,
      callback: (span: NoopSpan, ...args: A) => T,
      ...args: A
    ): T => callback(new NoopSpan(), ...args),
    startSpan: (_name: string) => new NoopSpan(),
    getActiveSpan: () => undefined,
    Span: NoopSpan,
  },
};

/** Await everything the gate/engine scheduled (limiter touches, the onPush
 *  fan-out) — deterministic, no runner-timing dependence. */
async function drainWaits(): Promise<void> {
  for (let round = 0; round < 10 && pendingWaits.length > 0; round++) {
    const batch = pendingWaits.splice(0, pendingWaits.length);
    await Promise.allSettled(batch);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // The full generated migration ledger — webhooks + webhook_deliveries exist.
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of [
    // Team tables first (gate.test.ts's sweep order); org_members cascades
    // with the users delete below, but team_repo_access.repo_id declares no
    // FK and is swept explicitly.
    "team_repo_access",
    "team_members",
    "teams",
    "personal_access_tokens",
    "repo_units",
    "repo_transfer",
    "repo_redirects",
    "repo_counters",
    "pull_requests",
    "issues",
    "repositories",
    "webhook_deliveries",
    "webhooks",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
});

/** A ready D1 repo owned by Alice + a write-scope token for the pushes.
 *  Idempotent on the owner row (tests that seed several repos reuse Alice). */
async function seedRepoWithToken(slug: string): Promise<{ row: RepoRow; token: string }> {
  const existing = await drizzle(env.DB).select({ id: users.id, username: users.username }).from(users).where(eq(users.usernameLower, "alice")).get();
  const alice = existing ?? (await seedVerifiedUser({ username: "Alice" }));
  const service = new RepoService(env.DB, { registry: env.REGISTRY.getByName("registry") });
  const row = await service.create({ owner: { id: alice.id, usernameLower: "alice" }, name: slug, isPrivate: false });
  const token = (await mintFor(alice.id, `${slug}-write`, "write:repository")).plaintext;
  return { row, token };
}

/** An active webhook row; defaults to the repo-scoped send-everything shape
 *  (§2.6 HasEvent: matches push/create/delete alike). */
async function seedHook(hook: {
  repoId?: string | null;
  ownerId?: number | null;
  events?: Record<string, unknown>;
  isActive?: boolean;
}): Promise<number> {
  const inserted = await drizzle(env.DB)
    .insert(webhooks)
    .values({
      repoId: hook.repoId ?? null,
      ownerId: hook.ownerId ?? null,
      url: "https://hooks.example.com/receive",
      events: JSON.stringify(hook.events ?? { send_everything: true }),
      isActive: hook.isActive ?? true,
    })
    .returning({ id: webhooks.id })
    .all();
  return inserted[0]!.id;
}

/** An open github-flow PR through the landed service (the pulls.test.ts
 *  seedPull shape) — head in the SAME repo unless told otherwise. */
async function seedPull(
  repoId: string,
  title: string,
  options: { headBranch?: string; baseBranch?: string; closed?: boolean; posterId?: number | null } = {},
): Promise<{ issueId: number; index: number }> {
  const service = new IssuesService(env.DB);
  await service.ensureRepoCounters(repoId);
  const { issue } = await service.createPullRequest({
    repoId,
    title,
    posterId: options.posterId ?? null,
    headRepoId: repoId,
    baseBranch: options.baseBranch ?? "main",
    headBranch: options.headBranch ?? "feature",
  });
  if (options.closed === true) {
    await service.closeIssue(issue.id, { actorId: null });
  }
  return { issueId: issue.id, index: issue.index };
}

/** The delivery log, oldest first — the assertion surface (§3.6). */
const deliveries = () => drizzle(env.DB).select().from(webhookDeliveries).orderBy(asc(webhookDeliveries.id)).all();

const clearDeliveries = () => env.DB.prepare("DELETE FROM webhook_deliveries").run();

// ---------------------------------------------------------------------------
// Pack primitives — test-file copies (seed-repo.ts / git-pack.ts keep their
// byte helpers private); the chain builder adds what neither exports: a
// commit chained ON TOP of an existing tip, the incremental-append shape of
// a real branch update (the pack carries ONLY the new objects — parents
// resolve from the receiving cell, per the connectivity check's contract).
// ---------------------------------------------------------------------------

const TE = new TextEncoder();

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-1", bytes));
}

async function sha1Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
}

/** zlib-deflate (git object storage format) via the workerd-native stream. */
async function zlibDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function be32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function rawOid(oidHex: string): Uint8Array {
  const raw = new Uint8Array(20);
  for (let i = 0; i < 20; i++) raw[i] = Number.parseInt(oidHex.slice(i * 2, i * 2 + 2), 16);
  return raw;
}

/** The type/size varint header of one packed object entry. */
function objectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  let rest = size >> 4;
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest >>= 7;
  }
  bytes.push(first);
  return new Uint8Array(bytes);
}

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;

export interface ChainFile {
  path: string;
  content: string;
}

export interface ChainCommit {
  message: string;
  files: ChainFile[];
  /** Committer/author unix seconds — keep distinct per commit. */
  time: number;
}

/**
 * Build `commits` chained on top of `parent` (null = root history): full flat
 * tree per commit, deduplicated objects, ONE self-contained pack carrying
 * only these commits' objects. Tips are oldest → newest.
 */
async function buildChainPack(parent: string | null, commits: ChainCommit[]): Promise<{ tips: string[]; pack: Uint8Array }> {
  const objects = new Map<string, { type: number; body: Uint8Array }>();
  const store = async (type: number, body: Uint8Array): Promise<string> => {
    const typeName = type === OBJ_COMMIT ? "commit" : type === OBJ_TREE ? "tree" : "blob";
    const raw = concatBytes(TE.encode(`${typeName} ${body.length}\0`), body);
    const oid = await sha1Hex(raw);
    if (!objects.has(oid)) objects.set(oid, { type, body });
    return oid;
  };

  const tips: string[] = [];
  let parentOid = parent;
  for (const commit of commits) {
    const entries: { sortKey: string; bytes: Uint8Array }[] = [];
    for (const file of commit.files) {
      const blobOid = await store(OBJ_BLOB, TE.encode(file.content));
      entries.push({ sortKey: file.path, bytes: concatBytes(TE.encode(`100644 ${file.path}\0`), rawOid(blobOid)) });
    }
    entries.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    const treeOid = await store(OBJ_TREE, concatBytes(...entries.map((e) => e.bytes)));
    const person = (who: "author" | "committer") => `${who} Test User <test@example.com> ${commit.time} +0000`;
    const commitBody =
      `tree ${treeOid}\n` +
      (parentOid !== null ? `parent ${parentOid}\n` : "") +
      `${person("author")}\n${person("committer")}\n\n${commit.message}\n`;
    const commitOid = await store(OBJ_COMMIT, TE.encode(commitBody));
    parentOid = commitOid;
    tips.push(commitOid);
  }

  const chunks: Uint8Array[] = [TE.encode("PACK"), be32(2), be32(objects.size)];
  for (const obj of objects.values()) {
    chunks.push(objectHeader(obj.type, obj.body.length));
    chunks.push(await zlibDeflate(obj.body));
  }
  chunks.push(await sha1Bytes(concatBytes(...chunks)));
  return { tips, pack: concatBytes(...chunks) };
}

// ---------------------------------------------------------------------------
// The real push flow through the SPEC-0003 gate
// ---------------------------------------------------------------------------

const ORIGIN = "https://example.com";
const RECEIVE_CT = "application/x-git-receive-pack-request";

interface PushCommand {
  /** Current tip (zero oid = create); the engine CASes against it. */
  old: string;
  oid: string;
  ref: string;
}

/** Command section with per-command old oids (capabilities ride the first
 *  command, like git) — the general form of git-pack.ts's create-only body. */
function commandSection(commands: PushCommand[]): Uint8Array {
  let section = "";
  commands.forEach((cmd, i) => {
    const line = i === 0 ? `${cmd.old} ${cmd.oid} ${cmd.ref}\0report-status side-band-64k` : `${cmd.old} ${cmd.oid} ${cmd.ref}`;
    section += `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
  });
  return TE.encode(`${section}0000`);
}

/** Real client flow through the gate: GET advert (also the DO cell's first
 *  contact — meta.repo binds here), then the POST receive. Drains every
 *  waitUntil before returning, so the onPush fan-out has fully settled. */
async function pushThroughGate(
  row: RepoRow,
  engine: DurableGitHandler<Env>,
  commands: PushCommand[],
  pack: Uint8Array | null,
  token: string,
): Promise<Response> {
  const base = `${ORIGIN}/${row.ownerNamespace}/${row.slug}.git`;
  const advert = await gitHttpGate(
    new Request(`${base}/info/refs?service=git-receive-pack`, { headers: { authorization: basicTokenHeader(token) } }),
    env,
    ctx,
    engine,
  );
  expect(advert.status).toBe(200);

  const section = commandSection(commands);
  const body = pack === null ? section : concatBytes(section, pack);
  const response = await gitHttpGate(
    new Request(`${base}/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body,
    }),
    env,
    ctx,
    engine,
  );
  await drainWaits();
  return response;
}

/** The engine now really holds `ref` at `oid` (the receive was real). */
async function expectRef(ownerNamespace: string, slug: string, ref: string, oid: string): Promise<void> {
  const refs = await env.REPO.getByName(`${ownerNamespace}/${slug}`).listRefs();
  expect(refs.refs.find((r) => r.name === ref)?.target).toBe(oid);
}

// ---------------------------------------------------------------------------
// The battery
// ---------------------------------------------------------------------------

describe("user pushes emit the push/create/delete family (the engine onPush seam)", () => {
  it("a first push emits the zero-commit push event + create event per created ref", async () => {
    const { row, token } = await seedRepoWithToken("pushweb");
    const hookId = await seedHook({ repoId: row.id });
    const { tips, pack } = await buildChainPack(null, [
      { message: "seed one", files: [{ path: "README.md", content: "one\n" }], time: 1700000000 },
      { message: "seed two", files: [{ path: "README.md", content: "two\n" }], time: 1700000001 },
    ]);
    const tip = tips[1]!;

    // One receive creating a branch AND a tag — the per-ref split.
    const response = await pushThroughGate(
      row,
      wiredEngine,
      [
        { old: PUSH_ZERO_OID, oid: tip, ref: "refs/heads/main" },
        { old: PUSH_ZERO_OID, oid: tip, ref: "refs/tags/v1" },
      ],
      pack,
      token,
    );
    expect(response.status).toBe(200);
    await expectRef(row.ownerNamespace, row.slug, "refs/heads/main", tip);

    const rows = await deliveries();
    // Upstream's emission order per ref: the zero-commit push event FIRST,
    // then the create event (mirror_pull.go:347, 352).
    expect(rows.map((r) => [r.hookId, r.eventType, r.eventGroup, r.state])).toEqual([
      [hookId, "push", "push", "pending"],
      [hookId, "create", "create", "pending"],
      [hookId, "push", "push", "pending"],
      [hookId, "create", "create", "pending"],
    ]);

    // The branch's zero-commit push payload (§2.7 PushPayload field set;
    // APP_URL unset → upstream's default ROOT_URL origin).
    const branchPush = JSON.parse(rows[0]!.payloadContent) as Record<string, unknown>;
    expect(branchPush).toMatchObject({
      ref: "refs/heads/main",
      before: PUSH_ZERO_OID,
      after: tip,
      compare_url: `${EXPECTED_ORIGIN}/`,
      commits: [],
      total_commits: 0,
      head_commit: null,
    });
    expect((branchPush.repository as { full_name: string }).full_name).toBe("alice/pushweb");
    // The authenticated pusher (gate-threaded, PushEvent.pusherId) — Alice
    // pushed on her own token, so the payload coincides with the owner shape.
    expect((branchPush.pusher as { login: string }).login).toBe("Alice");
    expect((branchPush.sender as { login: string }).login).toBe("Alice");

    const tagCreate = JSON.parse(rows[3]!.payloadContent) as Record<string, unknown>;
    expect(tagCreate).toMatchObject({ sha: tip, ref: "v1", ref_type: "tag" });
    expect((tagCreate.sender as { login: string }).login).toBe("Alice");
  });

  it("an updated ref emits the push event with the capped, enriched commit list", async () => {
    const { row, token } = await seedRepoWithToken("pushupdate");
    await seedHook({ repoId: row.id });

    // Initial history A → B on main.
    const initial = await buildChainPack(null, [
      { message: "base", files: [{ path: "README.md", content: "base\n" }], time: 1700000010 },
      { message: "tip b", files: [{ path: "README.md", content: "b\n" }], time: 1700000011 },
    ]);
    const first = await pushThroughGate(
      row,
      wiredEngine,
      [{ old: PUSH_ZERO_OID, oid: initial.tips[1]!, ref: "refs/heads/main" }],
      initial.pack,
      token,
    );
    expect(first.status).toBe(200);
    await clearDeliveries();

    // The update: C adds a file, D modifies README — chained ON TOP of B, so
    // the range walk B..D is a real fast-forward ancestry.
    const append = await buildChainPack(initial.tips[1]!, [
      {
        message: "add docs",
        files: [
          { path: "README.md", content: "c\n" },
          { path: "docs/new.md", content: "fresh\n" },
        ],
        time: 1700000012,
      },
      {
        message: "edit readme",
        files: [
          { path: "README.md", content: "d\n" },
          { path: "docs/new.md", content: "fresh\n" },
        ],
        time: 1700000013,
      },
    ]);
    const newTip = append.tips[1]!;
    const before = initial.tips[1]!;
    const second = await pushThroughGate(
      row,
      wiredEngine,
      [{ old: before, oid: newTip, ref: "refs/heads/main" }],
      append.pack,
      token,
    );
    expect(second.status).toBe(200);

    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventType).toBe("push");

    const payload = JSON.parse(rows[0]!.payloadContent) as {
      ref: string;
      before: string;
      after: string;
      compare_url: string;
      total_commits: number;
      commits: Array<{ id: string; added: string[]; removed: string[]; modified: string[] }>;
      head_commit: { id: string } | null;
      pusher: { login: string };
    };
    expect(payload.ref).toBe("refs/heads/main");
    expect(payload.before).toBe(before);
    expect(payload.after).toBe(newTip);
    // ComposeCompareURL + the AppURL prefix (mirror_pull.go:375).
    expect(payload.compare_url).toBe(`${EXPECTED_ORIGIN}/alice/pushupdate/compare/${before}...${newTip}`);
    // Newest-first (rev-list order) over the oldest-first range walk.
    expect(payload.commits.map((c) => c.id)).toEqual([newTip, append.tips[0]!]);
    expect(payload.total_commits).toBe(2);
    // head_commit names the tip regardless of the cap (push.go:185-192).
    expect(payload.head_commit?.id).toBe(newTip);
    // The enrichment: D vs C modifies README (docs/new.md unchanged → absent).
    expect(payload.commits[0]!.modified).toEqual(["README.md"]);
    expect(payload.commits[0]!.added).toEqual([]);
    // C vs B adds docs/new.md and modifies README.
    expect(payload.commits[1]!.added).toEqual(["docs/new.md"]);
    expect(payload.commits[1]!.modified).toEqual(["README.md"]);
    expect(payload.pusher.login).toBe("Alice");
  });

  it("a deleted ref emits the delete event", async () => {
    const { row, token } = await seedRepoWithToken("pushdelete");
    await seedHook({ repoId: row.id });
    const { tips, pack } = await buildChainPack(null, [
      { message: "doomed", files: [{ path: "README.md", content: "bye\n" }], time: 1700000020 },
    ]);
    const tip = tips[0]!;
    expect((await pushThroughGate(row, wiredEngine, [{ old: PUSH_ZERO_OID, oid: tip, ref: "refs/heads/side" }], pack, token)).status).toBe(200);
    await clearDeliveries();

    // A delete receive carries NO pack (the mirror prune-only shape).
    const response = await pushThroughGate(
      row,
      wiredEngine,
      [{ old: tip, oid: PUSH_ZERO_OID, ref: "refs/heads/side" }],
      null,
      token,
    );
    expect(response.status).toBe(200);

    const rows = await deliveries();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventType).toBe("delete");
    const payload = JSON.parse(rows[0]!.payloadContent) as Record<string, unknown>;
    expect(payload).toMatchObject({ ref: "side", ref_type: "branch", pusher_type: "user" });
    expect((payload.repository as { full_name: string }).full_name).toBe("alice/pushdelete");
    expect((payload.sender as { login: string }).login).toBe("Alice");
  });

  it("refs/pull/* deltas are never notified (mixed receive)", async () => {
    const { row, token } = await seedRepoWithToken("pushpull");
    await seedHook({ repoId: row.id });
    const { tips, pack } = await buildChainPack(null, [
      { message: "agit-ish", files: [{ path: "patch.txt", content: "pr\n" }], time: 1700000030 },
    ]);
    const tip = tips[0]!;

    // The engine accepts refs/pull/* pushes (no ref-space validation), so the
    // exclusion filter is load-bearing: one receive, one PR ref + one branch.
    const response = await pushThroughGate(
      row,
      wiredEngine,
      [
        { old: PUSH_ZERO_OID, oid: tip, ref: "refs/pull/9/head" },
        { old: PUSH_ZERO_OID, oid: tip, ref: "refs/heads/side" },
      ],
      pack,
      token,
    );
    expect(response.status).toBe(200);
    await expectRef(row.ownerNamespace, row.slug, "refs/pull/9/head", tip);

    const rows = await deliveries();
    // Only the branch's push + create pair; nothing names refs/pull/9/head.
    // (The push payload carries the full ref, the create payload the short
    // name — hence the sha fallback below.)
    const familyOf = (row: { eventType: string; payloadContent: string }): [string, string] => {
      const payload = JSON.parse(row.payloadContent) as { ref?: string; sha?: string };
      return [row.eventType, payload.ref ?? payload.sha ?? ""];
    };
    expect(rows.map(familyOf)).toEqual([
      ["push", "refs/heads/side"],
      ["create", "side"],
    ]);
    expect(rows.map((r) => r.payloadContent.includes("refs/pull")).some(Boolean)).toBe(false);
  });

  it("repositories without matching hooks are unaffected", async () => {
    // No hooks at all.
    const bare = await seedRepoWithToken("pushnohook");
    const barePack = await buildChainPack(null, [
      { message: "quiet", files: [{ path: "README.md", content: "quiet\n" }], time: 1700000040 },
    ]);
    expect(
      (
        await pushThroughGate(
          bare.row,
          wiredEngine,
          [{ old: PUSH_ZERO_OID, oid: barePack.tips[0]!, ref: "refs/heads/main" }],
          barePack.pack,
          bare.token,
        )
      ).status,
    ).toBe(200);
    expect(await deliveries()).toHaveLength(0);

    // Hook present but INACTIVE, plus one subscribed to the wrong family.
    const picky = await seedRepoWithToken("pushpicky");
    await seedHook({ repoId: picky.row.id, isActive: false });
    await seedHook({ repoId: picky.row.id, events: { choose_events: true, events: { issues: true } } });
    const pickyPack = await buildChainPack(null, [
      { message: "picky", files: [{ path: "README.md", content: "picky\n" }], time: 1700000041 },
    ]);
    expect(
      (
        await pushThroughGate(
          picky.row,
          wiredEngine,
          [{ old: PUSH_ZERO_OID, oid: pickyPack.tips[0]!, ref: "refs/heads/main" }],
          pickyPack.pack,
          picky.token,
        )
      ).status,
    ).toBe(200);
    expect(await deliveries()).toHaveLength(0);
  });

  it("push_only and branch_filter subscriptions gate the real fan-out", async () => {
    const { row, token } = await seedRepoWithToken("pushfilter");
    const pushOnly = await seedHook({ repoId: row.id, events: { push_only: true } });
    const releaseOnly = await seedHook({ repoId: row.id, events: { send_everything: true, branch_filter: "release/*" } });

    // main is outside release/*: the push-only hook takes the push event, the
    // branch-filtered hook is silent (create suppressed for push_only, filter
    // suppresses everything for the other).
    const mainPack = await buildChainPack(null, [
      { message: "main", files: [{ path: "README.md", content: "main\n" }], time: 1700000050 },
    ]);
    expect(
      (
        await pushThroughGate(
          row,
          wiredEngine,
          [{ old: PUSH_ZERO_OID, oid: mainPack.tips[0]!, ref: "refs/heads/main" }],
          mainPack.pack,
          token,
        )
      ).status,
    ).toBe(200);
    let rows = await deliveries();
    expect(rows.map((r) => [r.hookId, r.eventType])).toEqual([[pushOnly, "push"]]);

    await clearDeliveries();
    // release/1 matches the filter: the filtered hook takes push + create.
    const relPack = await buildChainPack(null, [
      { message: "rel", files: [{ path: "README.md", content: "rel\n" }], time: 1700000051 },
    ]);
    expect(
      (
        await pushThroughGate(
          row,
          wiredEngine,
          [{ old: PUSH_ZERO_OID, oid: relPack.tips[0]!, ref: "refs/heads/release/1" }],
          relPack.pack,
          token,
        )
      ).status,
    ).toBe(200);
    rows = await deliveries();
    expect(rows.map((r) => [r.hookId, r.eventType])).toEqual([
      [pushOnly, "push"],
      [releaseOnly, "push"],
      [releaseOnly, "create"],
    ]);
  });

  it("owner-level hooks receive the events (repo ∪ owner ∪ system resolution)", async () => {
    const { row, token } = await seedRepoWithToken("pushowner");
    const alice = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "alice")).get();
    const ownerIdHook = await seedHook({ repoId: null, ownerId: alice!.id });
    const { tips, pack } = await buildChainPack(null, [
      { message: "owner hook", files: [{ path: "README.md", content: "owner\n" }], time: 1700000060 },
    ]);
    expect(
      (await pushThroughGate(row, wiredEngine, [{ old: PUSH_ZERO_OID, oid: tips[0]!, ref: "refs/heads/main" }], pack, token)).status,
    ).toBe(200);
    const rows = await deliveries();
    expect(rows.map((r) => [r.hookId, r.eventType])).toEqual([
      [ownerIdHook, "push"],
      [ownerIdHook, "create"],
    ]);
  });

  it("notification failure never fails the push (the engine's hook catch)", async () => {
    const { row, token } = await seedRepoWithToken("pushpoison");
    const { tips, pack } = await buildChainPack(null, [
      { message: "survivor", files: [{ path: "README.md", content: "survive\n" }], time: 1700000070 },
    ]);
    const response = await pushThroughGate(
      row,
      rejectingEngine,
      [{ old: PUSH_ZERO_OID, oid: tips[0]!, ref: "refs/heads/main" }],
      pack,
      token,
    );
    // The hook rejected — the applied push still answers 200 with its ref.
    expect(response.status).toBe(200);
    await expectRef(row.ownerNamespace, row.slug, "refs/heads/main", tips[0]!);
  });

  it("a poisoned walk never throws and never silences the other refs (per-ref resilience)", async () => {
    const { row } = await seedRepoWithToken("pushresilience");
    await seedHook({ repoId: row.id });
    const pair = (await findRepositoryById(env.DB, row.id))!;

    const poisoned: WebhookPushWalk = {
      listCommitsRange: () => Promise.reject(new Error("walk exploded")),
      readDiff: () => Promise.reject(new Error("diff exploded")),
      readCommit: () => Promise.reject(new Error("tip exploded")),
    };
    const identity = { repository: { full_name: "alice/pushresilience" }, pusher: { login: "Alice" }, sender: { login: "Alice" } };
    // Mixed delta: the updated ref's walk explodes (skipped + logged), the
    // created ref still gets its push + create pair. Resolves, never throws.
    await expect(
      emitPushFamilyUpdates(
        env,
        pair,
        identity,
        [
          { ref: "refs/heads/broken", old: "1".repeat(40), next: "2".repeat(40) },
          { ref: "refs/heads/fresh", old: PUSH_ZERO_OID, next: "3".repeat(40) },
        ],
        poisoned,
        { log: () => {} },
      ),
    ).resolves.toBeUndefined();

    const rows = await deliveries();
    const refOf = (row: { eventType: string; payloadContent: string }): [string, string] => [
      row.eventType,
      (JSON.parse(row.payloadContent) as { ref?: string }).ref ?? "",
    ];
    expect(rows.map(refOf)).toEqual([
      ["push", "refs/heads/fresh"],
      ["create", "fresh"],
    ]);
  });
});

describe("pull_request_sync — PR-head branch updates ride the push (notifier.go:835-845)", () => {
  /** The two-push shape: seed the PR, create its head branch (no sync —
   *  created refs never sync, push.go:292), then UPDATE it and return the
   *  delivery log. */
  async function pushPrHead(slug: string, title: string): Promise<{ rows: Awaited<ReturnType<typeof deliveries>>; before: string; after: string; index: number }> {
    const { row, token } = await seedRepoWithToken(slug);
    await seedHook({ repoId: row.id });
    const { index } = await seedPull(row.id, title, { headBranch: "feature", baseBranch: "main" });

    const initial = await buildChainPack(null, [
      { message: "seed", files: [{ path: "README.md", content: "seed\n" }], time: 1700000100 },
    ]);
    expect(
      (await pushThroughGate(row, wiredEngine, [{ old: PUSH_ZERO_OID, oid: initial.tips[0]!, ref: "refs/heads/feature" }], initial.pack, token)).status,
    ).toBe(200);
    await clearDeliveries();

    const append = await buildChainPack(initial.tips[0]!, [
      { message: "pr work", files: [{ path: "README.md", content: "work\n" }], time: 1700000101 },
    ]);
    expect(
      (await pushThroughGate(row, wiredEngine, [{ old: initial.tips[0]!, oid: append.tips[0]!, ref: "refs/heads/feature" }], append.pack, token)).status,
    ).toBe(200);
    return { rows: await deliveries(), before: initial.tips[0]!, after: append.tips[0]!, index };
  }

  it("an update to a PR head branch emits push, then pull_request_sync with the delta", async () => {
    const { rows, before, after, index } = await pushPrHead("syncbasic", "sync me");
    // Upstream's order: the push event, then the sync task's event.
    expect(rows.map((r) => [r.eventType, r.eventGroup])).toEqual([
      ["push", "push"],
      ["pull_request_sync", "pull_request"],
    ]);
    const payload = JSON.parse(rows[1]!.payloadContent) as {
      action: string;
      before: string;
      after: string;
      number: number;
      pull_request: { title: string };
      repository: { full_name: string };
      sender: { login: string };
      commit_id: string;
    };
    expect(payload.action).toBe("synchronized");
    expect(payload.before).toBe(before);
    expect(payload.after).toBe(after);
    expect(payload.number).toBe(index);
    expect(payload.pull_request.title).toBe("sync me");
    expect(payload.repository.full_name).toBe("alice/syncbasic");
    // The push family's identity: the authenticated pusher (Alice — also the
    // owner here, where the fallback shape is indistinguishable).
    expect(payload.sender.login).toBe("Alice");
    expect(payload.commit_id).toBe("");
  });

  it("created refs, non-PR branches and closed PRs stay silent", async () => {
    const { row, token } = await seedRepoWithToken("syncquiet");
    await seedHook({ repoId: row.id });
    const { index: openIndex } = await seedPull(row.id, "open pr", { headBranch: "feature" });
    await seedPull(row.id, "closed pr", { headBranch: "feature", closed: true });

    const initial = await buildChainPack(null, [
      { message: "seed", files: [{ path: "README.md", content: "seed\n" }], time: 1700000110 },
    ]);
    // Creating a branch never syncs — even the PR's own head branch.
    expect(
      (await pushThroughGate(row, wiredEngine, [{ old: PUSH_ZERO_OID, oid: initial.tips[0]!, ref: "refs/heads/feature" }], initial.pack, token)).status,
    ).toBe(200);
    expect((await deliveries()).map((r) => r.eventType)).toEqual(["push", "create"]);
    await clearDeliveries();

    // Updating a branch with NO open PR head is just a push.
    const other = await buildChainPack(null, [
      { message: "other", files: [{ path: "docs.md", content: "other\n" }], time: 1700000111 },
    ]);
    expect(
      (await pushThroughGate(row, wiredEngine, [{ old: PUSH_ZERO_OID, oid: other.tips[0]!, ref: "refs/heads/other" }], other.pack, token)).status,
    ).toBe(200);
    expect((await deliveries()).map((r) => r.eventType)).toEqual(["push", "create"]);
    await clearDeliveries();

    // Updating the PR head branch syncs the OPEN PR only (the closed one is
    // unmerged-but-closed — GetUnmergedPullRequestsByHeadInfo filters it).
    const append = await buildChainPack(initial.tips[0]!, [
      { message: "work", files: [{ path: "README.md", content: "work\n" }], time: 1700000112 },
    ]);
    expect(
      (await pushThroughGate(row, wiredEngine, [{ old: initial.tips[0]!, oid: append.tips[0]!, ref: "refs/heads/feature" }], append.pack, token)).status,
    ).toBe(200);
    const rows = await deliveries();
    expect(rows.map((r) => r.eventType)).toEqual(["push", "pull_request_sync"]);
    const payload = JSON.parse(rows[1]!.payloadContent) as { number: number };
    expect(payload.number).toBe(openIndex);
  });

  it("a pull_request_sync subscription gates the event; a push_only hook never sees it", async () => {
    const { row, token } = await seedRepoWithToken("syncsubs");
    const syncOnly = await seedHook({ repoId: row.id, events: { choose_events: true, events: { pull_request_sync: true } } });
    const pushOnly = await seedHook({ repoId: row.id, events: { push_only: true } });
    await seedPull(row.id, "subscribed", { headBranch: "feature" });

    const initial = await buildChainPack(null, [
      { message: "seed", files: [{ path: "README.md", content: "seed\n" }], time: 1700000120 },
    ]);
    expect(
      (await pushThroughGate(row, wiredEngine, [{ old: PUSH_ZERO_OID, oid: initial.tips[0]!, ref: "refs/heads/feature" }], initial.pack, token)).status,
    ).toBe(200);
    // The created-ref push notifies the push_only hook only (choose-events
    // with just pull_request_sync has no push subscription).
    expect((await deliveries()).map((r) => [r.hookId, r.eventType])).toEqual([[pushOnly, "push"]]);
    await clearDeliveries();

    const append = await buildChainPack(initial.tips[0]!, [
      { message: "work", files: [{ path: "README.md", content: "work\n" }], time: 1700000121 },
    ]);
    expect(
      (await pushThroughGate(row, wiredEngine, [{ old: initial.tips[0]!, oid: append.tips[0]!, ref: "refs/heads/feature" }], append.pack, token)).status,
    ).toBe(200);
    // The update notifies BOTH: the push_only hook takes the push event, the
    // sync-subscribed hook takes the sync event (the group flag check).
    expect((await deliveries()).map((r) => [r.hookId, r.eventType])).toEqual([
      [pushOnly, "push"],
      [syncOnly, "pull_request_sync"],
    ]);
  });
});

describe("pusher identity and degrades", () => {
  it("an explicit authenticated pusher overrides the owner in the payload identity", async () => {
    const { row } = await seedRepoWithToken("pushident");
    await seedHook({ repoId: row.id });
    const bob = await seedVerifiedUser({ username: "Bob" });
    const bobRow = await drizzle(env.DB).select().from(users).where(eq(users.id, bob.id)).get();

    await handleUserPushNotifications(
      env,
      row,
      [{ ref: "refs/heads/main", old: PUSH_ZERO_OID, next: "a".repeat(40) }],
      bobRow, // the fan-out's pusher seam (the engine's PushEvent.pusherId resolves here)
    );
    const rows = await deliveries();
    expect(rows).toHaveLength(2); // push + create
    const payload = JSON.parse(rows[0]!.payloadContent) as { pusher: { login: string }; sender: { login: string }; repository: { owner: { login: string } } };
    expect(payload.pusher.login).toBe("Bob");
    expect(payload.sender.login).toBe("Bob");
    // The repository object stays the repo's real owner.
    expect(payload.repository.owner.login).toBe("Alice");
  });

  it("a missing owner row (org-shaped) degrades to a log; unknown repos no-op silently", async () => {
    const { row } = await seedRepoWithToken("pushghost");
    await seedHook({ repoId: row.id });
    // findRepositoryById is an INNER join: a row id that resolves nowhere
    // (org-owned shape / deleted row) degrades to the log-and-skip path.
    await expect(
      handleUserPushNotifications(env, { ...row, id: "no-such-repo" }, [
        { ref: "refs/heads/main", old: PUSH_ZERO_OID, next: "b".repeat(40) },
      ]),
    ).resolves.toBeUndefined();
    await expect(
      handleUserPushEvent(env, { repo: "ghost/none", updates: [{ ref: "refs/heads/main", old: PUSH_ZERO_OID, new: "c".repeat(40) }], commitTime: 0 }),
    ).resolves.toBeUndefined();
    expect(await deliveries()).toHaveLength(0);
  });
});

describe("the gate threads the authenticated pusher (the identity-gap closure)", () => {
  /** An org-owned repo (`<org>` owned by Alice) with Bob as a write-mode team
   *  collaborator — the SPEC-0007 §3.5 grant that lets a non-owner push. */
  async function seedOrgRepoWithCollaborator(
    slug: string,
  ): Promise<{ row: RepoRow; orgName: string; collabToken: string }> {
    const orgs = new OrgService(env.DB);
    const teams = new TeamsService(env.DB);
    const existing = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get();
    const alice = existing ?? (await seedVerifiedUser({ username: "Alice" }));
    const orgName = `acme-${slug}`;
    const org = await orgs.createOrg({ name: orgName, ownerId: alice.id });
    const service = new RepoService(env.DB, { registry: env.REGISTRY.getByName("registry") });
    const row = await service.create({ owner: { id: org.id, usernameLower: org.usernameLower }, name: slug, isPrivate: false });
    const bob = await seedVerifiedUser({ username: "Bob" });
    const writers = await teams.createTeam(org, { name: "writers", permission: "write" });
    await teams.addTeamRepo(writers, row.id);
    await teams.addTeamMember(writers, bob.id);
    return { row, orgName, collabToken: (await mintFor(bob.id, `${slug}-collab`, "write:repository")).plaintext };
  }

  it("a non-owner collaborator's push names the collaborator, not the owner", async () => {
    const fx = await seedOrgRepoWithCollaborator("pushcollab");
    await seedHook({ repoId: fx.row.id });

    // First push (branch create) by Bob: the zero-commit push + create pair.
    const initial = await buildChainPack(null, [
      { message: "seed", files: [{ path: "README.md", content: "seed\n" }], time: 1700000130 },
    ]);
    expect(
      (
        await pushThroughGate(
          fx.row,
          wiredEngine,
          [{ old: PUSH_ZERO_OID, oid: initial.tips[0]!, ref: "refs/heads/main" }],
          initial.pack,
          fx.collabToken,
        )
      ).status,
    ).toBe(200);
    await expectRef(fx.row.ownerNamespace, fx.row.slug, "refs/heads/main", initial.tips[0]!);

    let rows = await deliveries();
    expect(rows.map((r) => r.eventType)).toEqual(["push", "create"]);
    const created = JSON.parse(rows[0]!.payloadContent) as {
      pusher: { login: string };
      sender: { login: string };
      repository: { owner: { login: string } };
    };
    expect(created.pusher.login).toBe("Bob");
    expect(created.sender.login).toBe("Bob");
    // The repository object stays the repo's real owner (the org), upstream
    // push.go shape: Pusher is the doer, Repository.Owner the namespace.
    expect(created.repository.owner.login).toBe(fx.orgName);

    // An UPDATE by Bob: the push payload again names the collaborator.
    await clearDeliveries();
    const append = await buildChainPack(initial.tips[0]!, [
      { message: "work", files: [{ path: "README.md", content: "work\n" }], time: 1700000131 },
    ]);
    expect(
      (
        await pushThroughGate(
          fx.row,
          wiredEngine,
          [{ old: initial.tips[0]!, oid: append.tips[0]!, ref: "refs/heads/main" }],
          append.pack,
          fx.collabToken,
        )
      ).status,
    ).toBe(200);
    rows = await deliveries();
    expect(rows.map((r) => r.eventType)).toEqual(["push"]);
    const updated = JSON.parse(rows[0]!.payloadContent) as { pusher: { login: string }; sender: { login: string } };
    expect(updated.pusher.login).toBe("Bob");
    expect(updated.sender.login).toBe("Bob");
  });

  it("a client-forged x-push-user header never names the pusher (owner push unchanged)", async () => {
    const { row, token } = await seedRepoWithToken("pushforge");
    await seedHook({ repoId: row.id });
    const bob = await seedVerifiedUser({ username: "Bob" });

    // Alice (the owner) pushes with a FORGED identity header naming Bob. The
    // gate reads no such header (the identity rides the engine call argument,
    // gate.ts resolvePushPusher), so the payload must name the real
    // authenticated pusher — Alice — never the client-supplied identity.
    const forged = { "x-push-user": `${bob.id}:bob` };
    const { tips, pack } = await buildChainPack(null, [
      { message: "honest", files: [{ path: "README.md", content: "honest\n" }], time: 1700000140 },
    ]);
    const base = `${ORIGIN}/${row.ownerNamespace}/${row.slug}.git`;
    const advert = await gitHttpGate(
      new Request(`${base}/info/refs?service=git-receive-pack`, {
        headers: { authorization: basicTokenHeader(token), ...forged },
      }),
      env,
      ctx,
      wiredEngine,
    );
    expect(advert.status).toBe(200);
    const response = await gitHttpGate(
      new Request(`${base}/git-receive-pack`, {
        method: "POST",
        headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT, ...forged },
        body: concatBytes(commandSection([{ old: PUSH_ZERO_OID, oid: tips[0]!, ref: "refs/heads/main" }]), pack),
      }),
      env,
      ctx,
      wiredEngine,
    );
    expect(response.status).toBe(200);
    await drainWaits();

    const rows = await deliveries();
    expect(rows.map((r) => r.eventType)).toEqual(["push", "create"]);
    for (const row2 of rows) {
      const payload = JSON.parse(row2.payloadContent) as { pusher?: { login: string }; sender?: { login: string } };
      expect(payload.pusher?.login ?? payload.sender?.login).toBe("Alice");
    }
  });

  it("an anonymous forged-header push is challenged before any identity is read", async () => {
    const { row } = await seedRepoWithToken("pushanonforge");
    const bob = await seedVerifiedUser({ username: "Bob" });
    const response = await gitHttpGate(
      new Request(`${ORIGIN}/${row.ownerNamespace}/${row.slug}.git/git-receive-pack`, {
        method: "POST",
        headers: { "content-type": RECEIVE_CT, "x-push-user": `${bob.id}:bob` },
        body: commandSection([{ old: PUSH_ZERO_OID, oid: "d".repeat(40), ref: "refs/heads/main" }]),
      }),
      env,
      ctx,
      wiredEngine,
    );
    // Row 2/3: pushes always need identity — 401 before the engine, so the
    // forged header never reaches a receive, and nothing is notified.
    expect(response.status).toBe(401);
    expect(await deliveries()).toHaveLength(0);
  });

  it("an engine-native receive (no gate) carries no identity: owner fallback, forged header ignored", async () => {
    const { row, token } = await seedRepoWithToken("pushnative");
    await seedHook({ repoId: row.id });
    const bob = await seedVerifiedUser({ username: "Bob" });

    // Direct to the engine — the mirror/import/e2e shape: no gate-cleared
    // mark, no internal argument, raw client headers (with a forged identity
    // header aboard). The engine invents no pusher from them: PushEvent
    // carries none, and the fan-out falls back to the repository owner.
    const { tips, pack } = await buildChainPack(null, [
      { message: "native", files: [{ path: "README.md", content: "native\n" }], time: 1700000150 },
    ]);
    const base = `${ORIGIN}/${row.ownerNamespace}/${row.slug}.git`;
    // The engine's native credential shape: the token as the Basic PASSWORD
    // (the engine's parseBasic reads the password side — the gate's
    // token-as-username shape never appears on this path). Plus the forged
    // identity header.
    const forged = { authorization: basicHeader("git", token), "x-push-user": `${bob.id}:bob` };
    const advert = await wiredEngine.fetch(new Request(`${base}/info/refs?service=git-receive-pack`, { headers: forged }), env, ctx);
    expect(advert.status).toBe(200);
    const response = await wiredEngine.fetch(
      new Request(`${base}/git-receive-pack`, {
        method: "POST",
        headers: { ...forged, "content-type": RECEIVE_CT },
        body: concatBytes(commandSection([{ old: PUSH_ZERO_OID, oid: tips[0]!, ref: "refs/heads/main" }]), pack),
      }),
      env,
      ctx,
    );
    expect(response.status).toBe(200);
    await drainWaits();
    await expectRef(row.ownerNamespace, row.slug, "refs/heads/main", tips[0]!);

    const rows = await deliveries();
    expect(rows.map((r) => r.eventType)).toEqual(["push", "create"]);
    for (const row2 of rows) {
      const payload = JSON.parse(row2.payloadContent) as { pusher?: { login: string }; sender?: { login: string } };
      expect(payload.pusher?.login ?? payload.sender?.login).toBe("Alice");
    }
  });
});
