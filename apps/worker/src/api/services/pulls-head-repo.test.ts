/**
 * The PR converter's head-repo render (services/pulls.ts headBranchInfo) over
 * the real router — upstream's hidden-head-repo rule (services/convert/
 * pull.go:187-199 single, :435-450 list; both share the gate): a cross-repo
 * (fork) head renders `head.repo` + the numeric `head.repo_id` exactly when
 * the doer's permission ON THE HEAD REPO passes
 * `HasAnyUnitAccessOrPublicAccess` (models/perm/access/repo_permission.go:77
 * — anonymous gets AccessModeRead on a public repo, :468-472, and None on a
 * private one, :442-446; an authenticated stranger gets Read via
 * models/perm/access/access.go:53-54). An unreadable head keeps
 * `repo_id: -1` with `repo` omitted (Go marshals the nil pointer as null; our
 * JSON writer drops the undefined key) while `label`/`ref`/`sha` stay set —
 * the branch name survives the hide, upstream pull.go:118-121.
 *
 * The second block ports the payload escape hatch: `ToPayloadPullRequest`
 * (pull.go:33-37, the :197 `isPayload` disjunct) — webhook payload emitters
 * render the head repo REGARDLESS of the doer, proved differentially (the
 * same private-fork PR hidden on the API GET, shown in the payload).
 *
 * Colocated with the converter: the broader PR fixtures live in the
 * sibling-owned src/api/pulls.test.ts / src/api/routes/pulls.test.ts (the
 * wave-34 render split). Mounting convention = src/api/pulls.test.ts over the
 * full router; the stub identity STUB_USER (id 1) answers ANY token
 * (createStubAuthResolver), so the private-fork OWNER arm below uses a
 * stub-owned private fork — a stranger-authenticated doer is not reachable in
 * this rig (the real SPEC-0002 middleware replaces the stub resolver).
 * Wave-36 amendment: the trailing suite mints a DISTINCT authenticated
 * stranger through the test rig (src/auth/testing/identities.ts) and routes
 * its token through the SAME resolver seam (`createApiRouter({ auth })`), so
 * the identity-differentiated arms (stranger Read render on the public fork,
 * stranger hide on the stub-owned private fork its owner still sees) are
 * covered.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { serializeCommit, serializeTree } from "@cf-gitea/git-engine";

import { labels, repoCounters, repositories, users, webhookDeliveries, webhooks } from "../../db/schema";
import { handleUserPushNotifications, type WebhookPushWalk } from "../../services/webhooks-push";
import { IssuesService } from "../../issues/service";
import { ZERO_OID, branchRef, engineReads, refTipMap } from "./engine";
import { createApiRouter } from "../router";
import { createIdentityAuthResolver, seedIdentity, tokenHeader } from "../../auth/testing/identities";

// wave-129 full-run contention budget: this file's heaviest closure measured
// 4.01s of the 30s default IN a green 8-worker full run (the payload-emitter
// walks over real fork PRs; the suite's 260-isolate spawn storm spikes
// closures up to ~12x their solo time). File-local 90s budgets;
// vitest.config.ts keeps 30s for every other file. Membership: the measured
// >=4s in-run closure/hook set (full-suite junit run, 2026-10-27).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["pull_requests", "issues", "action", "repo_counters", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // The stub token identity is STUB_USER (id 1); pin an explicit id-1 row.
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  // The DO cells persist across tests (only D1 is wiped) — drop the PR head
  // refs the create flow lands on the BASE cells so the next per-repo index
  // cannot CAS-conflict (the pulls.test.ts convention).
  for (const cellName of [
    "cf-gitea-stub/hpr-base",
    "cf-gitea-stub/hpr-priv",
    "cf-gitea-stub/hpr-pay",
    "cf-gitea-stub/hpr-lab",
    // the wave-36 stranger-arm slugs (their trailing suite's bases)
    "cf-gitea-stub/hpr-s1",
    "cf-gitea-stub/hpr-s2",
    // the wave-38 live-create slugs (the opened-payload + merge tests below)
    "cf-gitea-stub/hpr-open",
    "cf-gitea-stub/hpr-mrg",
  ]) {
    const cell = env.REPO.getByName(cellName);
    const { refs } = await cell.listRefs();
    for (const ref of refs) {
      if (!ref.name.startsWith("refs/pull/")) {
        continue;
      }
      const deleted = await cell.deleteApiRef({ ref: ref.name, expectedOid: ref.target });
      if (deleted.tag === "invalid") {
        throw new Error(`seed ref cleanup failed: ${ref.name} (${deleted.reason})`);
      }
    }
  }
});

const db = () => drizzle(env.DB);

const TOKEN = "stub-token"; // any token resolves STUB_USER (id 1)
const authHeaders = { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" };
const anonHeaders = { "Content-Type": "application/json" };

let repoSeq = 9700;

async function seedRepo(
  ownerId: number,
  ownerNamespace: string,
  slug: string,
  visibility: "public" | "private" = "public",
): Promise<string> {
  const id = String(repoSeq++);
  await db().insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace,
    ownerId,
    slug,
    visibility,
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  await db().insert(repoCounters).values({ repoId: id, issueIndex: 0 });
  return id;
}

/** Worker-side object hash (workerd crypto.subtle; putApiObjects re-verifies). */
async function gitObjectOid(type: string, data: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${type} ${data.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + data.byteLength);
  bytes.set(header, 0);
  bytes.set(data, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Land `refs/heads/main` once per cell with a slug-independent commit — the
 *  SAME oid lands in the base and the fork cell (content addressing), which
 *  IS the fork relationship's shared history (forks are full copies,
 *  SPEC-0001b §5.2; the a16f60e fixture shape). */
async function seedSharedMain(pair: { ownerNamespace: string; slug: string }, readme: string): Promise<string> {
  const cell = env.REPO.getByName(`${pair.ownerNamespace}/${pair.slug}`);
  const existing = refTipMap(await engineReads(env, pair).listRefs()).get(branchRef("main"));
  if (existing !== undefined) return existing.target;
  const blob = new TextEncoder().encode(readme);
  const blobOid = await gitObjectOid("blob", blob);
  const tree = serializeTree([{ mode: "100644", name: "README.md", oid: blobOid }]);
  const person = { name: "seed", email: "seed@pulls.invalid", time: 1761000002, tz: "+0000" };
  const commit = serializeCommit({ tree: tree.oid, parents: [], author: person, committer: person, message: "shared base\n" });
  const put = await cell.putApiObjects([
    { oid: blobOid, type: "blob", data: blob },
    { oid: tree.oid, type: "tree", data: tree.data },
    { oid: commit.oid, type: "commit", data: commit.data },
  ]);
  if (put.tag !== "ok") throw new Error(`shared main putApiObjects failed: ${put.tag}`);
  const landed = await cell.commitApiChange({ ref: branchRef("main"), expectedOldOid: ZERO_OID, newOid: commit.oid });
  if (landed.tag !== "committed") throw new Error(`shared main landing failed: ${landed.tag}`);
  const head = await cell.setHead("main");
  if (head.tag !== "ok") throw new Error("shared main setHead failed");
  return commit.oid;
}

/** One divergent child commit on the fork's `feature` branch (lands once). */
async function seedCommitOnBranch(pair: { ownerNamespace: string; slug: string }, parentTip: string): Promise<string> {
  const cell = env.REPO.getByName(`${pair.ownerNamespace}/${pair.slug}`);
  const existing = refTipMap(await engineReads(env, pair).listRefs()).get(branchRef("feature"));
  if (existing !== undefined) return existing.target;
  const readme = new TextEncoder().encode(`# ${pair.slug}\n`);
  const readmeOid = await gitObjectOid("blob", readme);
  const extra = new TextEncoder().encode("from the fork\n");
  const extraOid = await gitObjectOid("blob", extra);
  const tree = serializeTree([
    { mode: "100644", name: "README.md", oid: readmeOid },
    { mode: "100644", name: "feature.txt", oid: extraOid },
  ]);
  const person = { name: "seed", email: "seed@pulls.invalid", time: 1761000003, tz: "+0000" };
  const commit = serializeCommit({ tree: tree.oid, parents: [parentTip], author: person, committer: person, message: "feature\n" });
  const put = await cell.putApiObjects([
    { oid: readmeOid, type: "blob", data: readme },
    { oid: extraOid, type: "blob", data: extra },
    { oid: tree.oid, type: "tree", data: tree.data },
    { oid: commit.oid, type: "commit", data: commit.data },
  ]);
  if (put.tag !== "ok") throw new Error(`feature commit putApiObjects failed: ${put.tag}`);
  const landed = await cell.commitApiChange({ ref: branchRef("feature"), expectedOldOid: ZERO_OID, newOid: commit.oid });
  if (landed.tag !== "committed") throw new Error(`feature landing failed: ${landed.tag}`);
  return commit.oid;
}

interface ForkFixture {
  baseId: string;
  forkId: string;
  featureTip: string;
}

/** The stub's public base + a fork with one divergent `feature` branch.
 *  `owner = "alice"` → a PUBLIC fork readable by everyone (private with the
 *  `private` flag — the stranger-doer hide arm, reachable because the stub
 *  doer is NOT alice); `owner = "stub"` → the stub's own PRIVATE fork (the
 *  owner arm of the gate — the only authenticated doer the stub resolver can
 *  produce). */
async function seedForkWithFeature(baseSlug: string, fork: { owner: "alice" | "stub"; private?: boolean }): Promise<ForkFixture> {
  const baseId = await seedRepo(1, "cf-gitea-stub", baseSlug);
  let forkOwnerNamespace = "cf-gitea-stub";
  let forkOwnerId = 1;
  let forkSlug = baseSlug;
  let visibility: "public" | "private" = "public";
  if (fork.owner === "alice") {
    const rows = await db()
      .insert(users)
      .values({ username: "alice", usernameLower: "alice", isAdmin: false, status: "active", createdAt: new Date("2026-01-01T00:00:00Z") })
      .returning()
      .all();
    const alice = rows[0];
    if (alice === undefined) throw new Error("alice seed failed");
    forkOwnerNamespace = "alice";
    forkOwnerId = alice.id;
    if (fork.private === true) {
      visibility = "private";
    }
  } else {
    forkSlug = `${baseSlug}-fork`;
    visibility = "private";
  }
  const forkId = await seedRepo(forkOwnerId, forkOwnerNamespace, forkSlug, visibility);
  await db().update(repositories).set({ forkParent: baseId }).where(eq(repositories.id, forkId));
  const readme = `# ${baseSlug}\n`;
  const sharedTip = await seedSharedMain({ ownerNamespace: "cf-gitea-stub", slug: baseSlug }, readme);
  await seedSharedMain({ ownerNamespace: forkOwnerNamespace, slug: forkSlug }, readme);
  const featureTip = await seedCommitOnBranch({ ownerNamespace: forkOwnerNamespace, slug: forkSlug }, sharedTip);
  return { baseId, forkId, featureTip };
}

const router = () => {
  const app = createApiRouter();
  return async (path: string, init?: RequestInit): Promise<Response> => app.fetch(new Request(`https://example.com${path}`, init), env);
};

async function createForkPull(baseSlug: string, head: string): Promise<Response> {
  return router()(`/repos/cf-gitea-stub/${baseSlug}/pulls`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ title: "fork PR", head, base: "main" }),
  });
}

interface HeadBlock {
  label: string;
  ref: string;
  sha: string;
  repo_id: number;
  repo?: Record<string, unknown>;
}

describe("PR converter head.repo — the cross-repo read-gate render (convert/pull.go:187-199)", () => {
  it("renders the readable public fork's repo block (owner login, slug, numeric id, pull-only permissions) for the authenticated doer", async () => {
    const { forkId, featureTip } = await seedForkWithFeature("hpr-base", { owner: "alice" });
    const created = await createForkPull("hpr-base", "alice:feature");
    expect(created.status).toBe(201);

    const got = await router()("/repos/cf-gitea-stub/hpr-base/pulls/1", { headers: authHeaders });
    expect(got.status).toBe(200);
    const body = await got.json<{ head: HeadBlock; base: HeadBlock }>();
    // The branch fields stay the PR-ref shape; the fork's identity renders.
    expect(body.head).toMatchObject({ label: "feature", ref: "refs/pull/1/head", sha: featureTip, repo_id: Number(forkId) });
    expect(body.head.repo).toMatchObject({
      name: "hpr-base",
      full_name: "alice/hpr-base",
      private: false,
      owner: { login: "alice" },
      // the doer (stub) is a stranger on alice's fork: read-only block,
      // upstream AccessModeRead → ToRepo permissions
      permissions: { admin: false, push: false, pull: true },
    });
    // the base side still renders the base repo
    expect(body.base.repo).toMatchObject({ full_name: "cf-gitea-stub/hpr-base" });
  });

  it("renders the same head repo in the LIST converter (ToAPIPullRequests shares the gate, pull.go:435-450)", async () => {
    const { forkId, featureTip } = await seedForkWithFeature("hpr-base", { owner: "alice" });
    const created = await createForkPull("hpr-base", "alice:feature");
    expect(created.status).toBe(201);

    const listed = await router()("/repos/cf-gitea-stub/hpr-base/pulls", { headers: authHeaders });
    expect(listed.status).toBe(200);
    const items = await listed.json<Array<{ head: HeadBlock }>>();
    expect(items).toHaveLength(1);
    expect(items[0]?.head).toMatchObject({ label: "feature", ref: "refs/pull/1/head", sha: featureTip, repo_id: Number(forkId) });
    expect(items[0]?.head.repo).toMatchObject({ full_name: "alice/hpr-base", owner: { login: "alice" } });
  });

  it("renders the public fork's repo for an ANONYMOUS doer too — upstream grants anonymous Read on a public repo (repo_permission.go:468-472)", async () => {
    const { forkId, featureTip } = await seedForkWithFeature("hpr-base", { owner: "alice" });
    const created = await createForkPull("hpr-base", "alice:feature");
    expect(created.status).toBe(201);

    const got = await router()("/repos/cf-gitea-stub/hpr-base/pulls/1", { headers: anonHeaders });
    expect(got.status).toBe(200);
    const body = await got.json<{ head: HeadBlock }>();
    expect(body.head).toMatchObject({ label: "feature", ref: "refs/pull/1/head", sha: featureTip, repo_id: Number(forkId) });
    expect(body.head.repo).toMatchObject({
      full_name: "alice/hpr-base",
      permissions: { admin: false, push: false, pull: true },
    });
  });

  it("renders a PRIVATE fork's repo for its OWNER (the stub-owned fork; admin/push/pull block) and hides it from anonymous doers", async () => {
    const { forkId, featureTip } = await seedForkWithFeature("hpr-priv", { owner: "stub" });
    // the owner/name fork form — the fork's slug differs from the base's
    const created = await createForkPull("hpr-priv", "cf-gitea-stub/hpr-priv-fork:feature");
    expect(created.status).toBe(201);

    const owned = await router()("/repos/cf-gitea-stub/hpr-priv/pulls/1", { headers: authHeaders });
    expect(owned.status).toBe(200);
    const ownedBody = await owned.json<{ head: HeadBlock }>();
    expect(ownedBody.head).toMatchObject({ label: "feature", ref: "refs/pull/1/head", sha: featureTip, repo_id: Number(forkId) });
    expect(ownedBody.head.repo).toMatchObject({
      full_name: "cf-gitea-stub/hpr-priv-fork",
      private: true,
      // the doer OWNS the head repo: upstream AccessModeOwner → ToRepo
      permissions: { admin: true, push: true, pull: true },
    });

    // anonymous on a private head repo: None (:442-446) → the -1/nil shape
    // with the branch fields intact (pull.go:118-121)
    const anon = await router()("/repos/cf-gitea-stub/hpr-priv/pulls/1", { headers: anonHeaders });
    expect(anon.status).toBe(200);
    const anonBody = await anon.json<{ head: HeadBlock }>();
    expect(anonBody.head).toMatchObject({ label: "feature", ref: "refs/pull/1/head", sha: featureTip, repo_id: -1 });
    expect(anonBody.head.repo).toBeUndefined();

    // the list converter hides the same way
    const listed = await router()("/repos/cf-gitea-stub/hpr-priv/pulls", { headers: anonHeaders });
    expect(listed.status).toBe(200);
    const items = await listed.json<Array<{ head: HeadBlock }>>();
    expect(items[0]?.head).toMatchObject({ label: "feature", repo_id: -1 });
    expect(items[0]?.head.repo).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The payload mode — upstream `ToPayloadPullRequest` (convert/pull.go:33-37,
// "keeps the head repository regardless of the doer, for webhook and Actions
// payloads"): the :197 disjunction `isPayload || HeadRepoID == BaseRepoID ||
// HasAnyUnitAccessOrPublicAccess()` bypasses the visibility gate for payload
// emitters, because payloads go to CONFIGURED RECEIVERS, not the requesting
// doer. The differential IS the proof: the SAME private-fork PR hides
// `head.repo` on the API GET and shows it in the webhook payload.
// ---------------------------------------------------------------------------

/** Minimal walk stub — the sync arm is a pure D1 query; the push event's
 *  commit-list fidelity is the webhooks-push suite's business. */
const stubWalk: WebhookPushWalk = {
  listCommitsRange: () => Promise.resolve({ commits: [], more: false }),
  readDiff: () => Promise.resolve(null),
  readCommit: () => Promise.resolve(null),
};

/** The webhook tables outlive the D1 wipe (beforeEach covers the PR family
 *  only) — the payload tests clear them for a hermetic delivery log. */
async function clearWebhookTables(): Promise<void> {
  await env.DB.prepare("DELETE FROM webhook_deliveries").run();
  await env.DB.prepare("DELETE FROM webhooks").run();
}

/** An active send-everything hook on one repo (the webhooks-push.test.ts
 *  seedHook shape) — without a matching hook nothing is delivered. */
async function seedRepoHook(repoId: string): Promise<number> {
  const inserted = await db()
    .insert(webhooks)
    .values({
      repoId,
      ownerId: null,
      url: "https://hooks.example.com/receive",
      events: JSON.stringify({ send_everything: true }),
      isActive: true,
    })
    .returning({ id: webhooks.id })
    .all();
  return inserted[0]!.id;
}

/** The delivery log, oldest first (the §3.6 assertion surface). */
const deliveryRows = () => drizzle(env.DB).select().from(webhookDeliveries).orderBy(asc(webhookDeliveries.id)).all();

describe("the payload mode — ToPayloadPullRequest renders the head repo regardless (convert/pull.go:33-37, :197)", () => {
  it("the SAME private-fork PR: the anonymous API GET hides head.repo, the pull_request_sync payload shows it (webhooks-push emitPullRequestSyncs)", async () => {
    const { forkId, featureTip } = await seedForkWithFeature("hpr-pay", { owner: "stub" });
    const created = await createForkPull("hpr-pay", "cf-gitea-stub/hpr-pay-fork:feature");
    expect(created.status).toBe(201);

    // API side (the 0466356 case, re-anchored on this PR): the anonymous doer
    // holds None on the private fork (repo_permission.go:442-446) — the
    // -1/nil head.
    const anon = await router()("/repos/cf-gitea-stub/hpr-pay/pulls/1", { headers: anonHeaders });
    expect(anon.status).toBe(200);
    const anonBody = await anon.json<{ head: HeadBlock }>();
    expect(anonBody.head).toMatchObject({ label: "feature", repo_id: -1 });
    expect(anonBody.head.repo).toBeUndefined();

    // Payload side: an update to the fork's feature branch fans the
    // pull_request_sync event out through the fork (the pushed pair); the
    // fan-out's viewer is anonymous, and the isPayload arm must render the
    // fork anyway.
    await clearWebhookTables();
    await seedRepoHook(forkId);
    const forkRow = await db().select().from(repositories).where(eq(repositories.id, forkId)).get();
    if (forkRow === undefined) throw new Error("fork row seed failed");
    await handleUserPushNotifications(env, forkRow, [{ ref: "refs/heads/feature", old: "1".repeat(40), next: featureTip }], null, {
      walk: stubWalk,
    });

    const rows = await deliveryRows();
    const sync = rows.find((row) => row.eventType === "pull_request_sync");
    if (sync === undefined) {
      throw new Error(`no pull_request_sync delivery among: ${rows.map((row) => row.eventType).join(",")}`);
    }
    const payload = JSON.parse(sync.payloadContent) as {
      action: string;
      pull_request: { head: HeadBlock };
      repository: { full_name: string };
    };
    expect(payload.action).toBe("synchronized");
    expect(payload.pull_request.head.repo_id).toBe(Number(forkId));
    expect(payload.pull_request.head.repo).toMatchObject({
      full_name: "cf-gitea-stub/hpr-pay-fork",
      private: true,
      // the anonymous doer's view on the fork — upstream still feeds the
      // doer's permission to ToRepo in payload mode (pull.go:186-190), here
      // AccessModeNone: every arm false
      permissions: { admin: false, push: false, pull: false },
    });
    // the event itself still routes through the BASE repository (notifier.go:843)
    expect(payload.repository).toMatchObject({ full_name: "cf-gitea-stub/hpr-pay" });
  });

  it("the SAME stranger-private-fork PR: the pull_request_label payload shows head.repo where the API hides it (routes/issues.ts emitLabelEvent)", async () => {
    const fixture = await seedForkWithFeature("hpr-lab", { owner: "alice", private: true });
    // Seeded through the service, NOT the API: the POST /pulls create route's
    // anti-enumeration CanRead guard (a16f60e) rightly 404s a head repo the
    // doer cannot read, while the ROW itself is a legal state upstream's
    // notifiers must still render (webhooks-push.test.ts's seedPull shape).
    const service = new IssuesService(env.DB);
    await service.ensureRepoCounters(fixture.baseId);
    const seeded = await service.createPullRequest({
      repoId: fixture.baseId,
      title: "stranger fork PR",
      posterId: null,
      headRepoId: fixture.forkId,
      baseBranch: "main",
      headBranch: "feature",
    });
    expect(seeded.issue.index).toBe(1);

    // API side — the authenticated stub doer is a STRANGER on alice's private
    // fork (and anonymous is None): both renders hide it.
    for (const headers of [authHeaders, anonHeaders]) {
      const got = await router()("/repos/cf-gitea-stub/hpr-lab/pulls/1", { headers });
      expect(got.status).toBe(200);
      const body = await got.json<{ head: HeadBlock }>();
      expect(body.head.repo_id).toBe(-1);
      expect(body.head.repo).toBeUndefined();
    }

    // Payload side: the stub labels the PR on the BASE repo it owns — the
    // pull_request_label emission renders ToPayloadPullRequest (notifier.go
    // IssueChangeLabels:600), so alice's private fork shows to the receivers.
    await clearWebhookTables();
    await seedRepoHook(fixture.baseId);
    const labelRows = await db()
      .insert(labels)
      .values({ repoId: fixture.baseId, name: "bug", color: "#00aabb", description: "", numIssues: 0, numClosedIssues: 0 })
      .returning({ id: labels.id })
      .all();
    const labelId = labelRows[0]!.id;
    const attached = await router()("/repos/cf-gitea-stub/hpr-lab/issues/1/labels", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ labels: [labelId] }),
    });
    expect(attached.status).toBe(200);

    const rows = await deliveryRows();
    const label = rows.find((row) => row.eventType === "pull_request_label");
    if (label === undefined) {
      throw new Error(`no pull_request_label delivery among: ${rows.map((row) => row.eventType).join(",")}`);
    }
    const payload = JSON.parse(label.payloadContent) as { action: string; pull_request: { head: HeadBlock } };
    expect(payload.action).toBe("label_updated");
    expect(payload.pull_request.head.repo_id).toBe(Number(fixture.forkId));
    expect(payload.pull_request.head.repo).toMatchObject({
      full_name: "alice/hpr-lab",
      private: true,
      // the stub doer is a stranger on the private fork: AccessModeNone block
      permissions: { admin: false, push: false, pull: false },
    });
  });
});

// ---------------------------------------------------------------------------
// The authenticated-stranger arms (wave-36 rig, src/auth/testing/identities.ts):
// `createStubAuthResolver` maps ANY token to STUB_USER, so every doer above is
// the same principal. The rig mints a DISTINCT seeded identity and resolves
// its token through the SAME seam (`createApiRouter({ auth })` — header-parse
// → middleware → resolveToken, nothing bypassed), giving the matrix its
// second authenticated row: stranger vs owner on the SAME repo.
// Slugs are per-test (hpr-s1/hpr-s2): the DO cells persist across tests and
// this block stays append-only to the sibling-owned beforeEach cleanup list.
// ---------------------------------------------------------------------------

/** The default stub router PLUS one stranger identity on the same seam. */
async function routerWithStranger() {
  const stranger = await seedIdentity({ username: "stranger" });
  const app = createApiRouter({ auth: createIdentityAuthResolver({ [stranger.token]: stranger.user }) });
  return {
    stranger,
    get: async (path: string): Promise<Response> =>
      app.fetch(new Request(`https://example.com${path}`, { headers: tokenHeader(stranger) }), env),
  };
}

describe("PR converter head.repo — the AUTHENTICATED-STRANGER arms (wave-36 multi-identity rig)", () => {
  it("renders the public fork's Read block for an authenticated STRANGER — a distinct principal, not the stub (repo_permission.go:468-472 + access.go:53-54)", async () => {
    // (stranger unused here — only `get`; lint: no-unused-vars)
    const { get } = await routerWithStranger();
    const { forkId, featureTip } = await seedForkWithFeature("hpr-s1", { owner: "alice" });
    const created = await createForkPull("hpr-s1", "alice:feature");
    expect(created.status).toBe(201);

    const got = await get("/repos/cf-gitea-stub/hpr-s1/pulls/1");
    expect(got.status).toBe(200);
    const body = await got.json<{ user: { login: string }; head: HeadBlock; base: HeadBlock }>();
    // the doer IS the minted stranger (id ≠ 1): the BASE repo is stub-owned,
    // yet the rendered base permissions block is pull-only — the stub owner
    // would render admin/push/pull there (repositoryPermissions' owner arm)
    expect(body.user).toMatchObject({ login: "cf-gitea-stub" }); // the PR author stays the stub creator
    expect(body.base.repo).toMatchObject({
      full_name: "cf-gitea-stub/hpr-s1",
      permissions: { admin: false, push: false, pull: true },
    });
    // the public head fork renders the Read block for the stranger too
    expect(body.head).toMatchObject({ label: "feature", ref: "refs/pull/1/head", sha: featureTip, repo_id: Number(forkId) });
    expect(body.head.repo).toMatchObject({
      full_name: "alice/hpr-s1",
      private: false,
      owner: { login: "alice" },
      permissions: { admin: false, push: false, pull: true },
    });
  });

  it("hides the stub-owned PRIVATE fork from the authenticated stranger while its owner (a second identity) still sees it — the differential the single-stub rig could not express", async () => {
    const { get } = await routerWithStranger();
    const { forkId, featureTip } = await seedForkWithFeature("hpr-s2", { owner: "stub" });
    const created = await createForkPull("hpr-s2", "cf-gitea-stub/hpr-s2-fork:feature");
    expect(created.status).toBe(201);

    // owner side (the stub token): the private head repo renders, admin block
    const owned = await router()("/repos/cf-gitea-stub/hpr-s2/pulls/1", { headers: authHeaders });
    expect(owned.status).toBe(200);
    const ownedBody = await owned.json<{ head: HeadBlock }>();
    expect(ownedBody.head).toMatchObject({ label: "feature", sha: featureTip, repo_id: Number(forkId) });
    expect(ownedBody.head.repo).toMatchObject({
      full_name: "cf-gitea-stub/hpr-s2-fork",
      private: true,
      permissions: { admin: true, push: true, pull: true },
    });

    // stranger side (the minted token): an authenticated doer with no access
    // row on a private repo holds None (repo_permission.go:442-446) — the
    // -1/nil head with the branch fields intact (pull.go:118-121), the SAME
    // render anonymous gets while the owner render above stays.
    const hidden = await get("/repos/cf-gitea-stub/hpr-s2/pulls/1");
    expect(hidden.status).toBe(200); // the public BASE is readable — only the head hides
    const hiddenBody = await hidden.json<{ head: HeadBlock }>();
    expect(hiddenBody.head).toMatchObject({ label: "feature", ref: "refs/pull/1/head", sha: featureTip, repo_id: -1 });
    expect(hiddenBody.head.repo).toBeUndefined();

    // the list converter hides the same way for the stranger
    const listed = await get("/repos/cf-gitea-stub/hpr-s2/pulls");
    expect(listed.status).toBe(200);
    const items = await listed.json<Array<{ head: HeadBlock }>>();
    expect(items[0]?.head).toMatchObject({ label: "feature", repo_id: -1 });
    expect(items[0]?.head.repo).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Wave-37 emitter sweep: the REMAINING issue-family webhook emitters must ride
// toApiPullRequest's "payload" mode like emitLabelEvent above — the label
// DETACH (routes/issue-write-t2.ts emitLabelDetachEvent), the assignee
// add/remove (routes/issue-tables-t2.ts emitAssignEvent) and the review
// submission + review-request pair (routes/pull-reviews.ts emitReviewSubmitted
// / reviewRequestArm). One differential per family, the emitLabelEvent test's
// shape: the SAME stranger-private-fork PR hides head.repo on the API GET and
// shows it in THAT family's payload. Append-only slugs (hpr-det/hpr-asn/
// hpr-rev); their PRs are service-seeded (no refs/pull land on the cells), so
// the beforeEach cleanup list stays untouched.
// ---------------------------------------------------------------------------

/** The stranger-private-fork fixture + the service-seeded PR at index 1. */
async function seedPrivateForkPull(baseSlug: string): Promise<ForkFixture> {
  const fixture = await seedForkWithFeature(baseSlug, { owner: "alice", private: true });
  const service = new IssuesService(env.DB);
  await service.ensureRepoCounters(fixture.baseId);
  const seeded = await service.createPullRequest({
    repoId: fixture.baseId,
    title: "stranger fork PR",
    posterId: null,
    headRepoId: fixture.forkId,
    baseBranch: "main",
    headBranch: "feature",
  });
  expect(seeded.issue.index).toBe(1);
  return fixture;
}

/** The API-hide arm: both doers (the stub owner of the base — a stranger on
 *  alice's private fork — and anonymous) see the -1/nil head. */
async function expectApiHidesHead(baseSlug: string): Promise<void> {
  for (const headers of [authHeaders, anonHeaders]) {
    const got = await router()(`/repos/cf-gitea-stub/${baseSlug}/pulls/1`, { headers });
    expect(got.status).toBe(200);
    const body = await got.json<{ head: HeadBlock }>();
    expect(body.head.repo_id).toBe(-1);
    expect(body.head.repo).toBeUndefined();
  }
}

/** The family payload assertion: the private fork renders to the receivers
 *  with the stub stranger's AccessModeNone block (pull.go:186-190). */
type FamilyPayload = { action: string; pull_request: { head: HeadBlock } };

function expectPayloadShowsHead(payload: FamilyPayload, action: string, forkId: string, fullName: string): void {
  expect(payload.action).toBe(action);
  expect(payload.pull_request.head.repo_id).toBe(Number(forkId));
  expect(payload.pull_request.head.repo).toMatchObject({
    full_name: fullName,
    private: true,
    permissions: { admin: false, push: false, pull: false },
  });
}

describe("the payload emitters — every issue/assignee/review webhook family renders the hidden head repo (wave-37)", () => {
  it("the label DETACH payload shows head.repo where the API hides it (routes/issue-write-t2.ts emitLabelDetachEvent)", async () => {
    const fixture = await seedPrivateForkPull("hpr-det");
    await expectApiHidesHead("hpr-det");

    // Attach first (hookless — the delivery log stays empty), then arm the
    // hook and detach: exactly one pull_request_label delivery answers.
    const labelRows = await db()
      .insert(labels)
      .values({ repoId: fixture.baseId, name: "bug", color: "#00aabb", description: "", numIssues: 0, numClosedIssues: 0 })
      .returning({ id: labels.id })
      .all();
    const labelId = labelRows[0]!.id;
    const attached = await router()("/repos/cf-gitea-stub/hpr-det/issues/1/labels", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ labels: [labelId] }),
    });
    expect(attached.status).toBe(200);

    await clearWebhookTables();
    await seedRepoHook(fixture.baseId);
    const detached = await router()(`/repos/cf-gitea-stub/hpr-det/issues/1/labels/${labelId}`, {
      method: "DELETE",
      headers: authHeaders,
    });
    expect(detached.status).toBe(204);

    const rows = await deliveryRows();
    const label = rows.find((row) => row.eventType === "pull_request_label");
    if (label === undefined) {
      throw new Error(`no pull_request_label delivery among: ${rows.map((row) => row.eventType).join(",")}`);
    }
    expectPayloadShowsHead(JSON.parse(label.payloadContent) as FamilyPayload, "label_updated", fixture.forkId, "alice/hpr-det");
  });

  it("the assignee payload shows head.repo where the API hides it (routes/issue-tables-t2.ts emitAssignEvent)", async () => {
    const fixture = await seedPrivateForkPull("hpr-asn");
    await expectApiHidesHead("hpr-asn");

    await clearWebhookTables();
    await seedRepoHook(fixture.baseId);
    const assigned = await router()("/repos/cf-gitea-stub/hpr-asn/issues/1/assignees", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ assignees: ["alice"] }),
    });
    expect(assigned.status).toBe(201);

    const rows = await deliveryRows();
    const assign = rows.find((row) => row.eventType === "pull_request_assign");
    if (assign === undefined) {
      throw new Error(`no pull_request_assign delivery among: ${rows.map((row) => row.eventType).join(",")}`);
    }
    expectPayloadShowsHead(JSON.parse(assign.payloadContent) as FamilyPayload, "assigned", fixture.forkId, "alice/hpr-asn");
  });

  it("the review payloads show head.repo where the API hides it — submission AND review_request (routes/pull-reviews.ts)", async () => {
    const fixture = await seedPrivateForkPull("hpr-rev");
    await expectApiHidesHead("hpr-rev");

    await clearWebhookTables();
    await seedRepoHook(fixture.baseId);

    // The submission emitter (emitReviewSubmitted).
    const submitted = await router()("/repos/cf-gitea-stub/hpr-rev/pulls/1/reviews", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ event: "APPROVED", body: "lgtm" }),
    });
    expect(submitted.status).toBe(200);

    // The review-request emitter (the user-add arm; its apiPullRequest render
    // is shared with the team arm and the user-remove arm).
    const requested = await router()("/repos/cf-gitea-stub/hpr-rev/pulls/1/requested_reviewers", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ reviewers: ["alice"] }),
    });
    expect(requested.status).toBe(201);

    const rows = await deliveryRows();
    const approval = rows.find((row) => row.eventType === "pull_request_review_approved");
    const request = rows.find((row) => row.eventType === "pull_request_review_request");
    if (approval === undefined || request === undefined) {
      throw new Error(`missing review deliveries among: ${rows.map((row) => row.eventType).join(",")}`);
    }
    expectPayloadShowsHead(JSON.parse(approval.payloadContent) as FamilyPayload, "reviewed", fixture.forkId, "alice/hpr-rev");
    expectPayloadShowsHead(JSON.parse(request.payloadContent) as FamilyPayload, "review_requested", fixture.forkId, "alice/hpr-rev");
  });
});

// ---------------------------------------------------------------------------
// Wave-38: the pulls.ts routes' OWN payload assemblies. Upstream converts TWICE
// per mutation — the API body serializes convert.ToAPIPullRequest (the
// doer-gated "single" render) while the notifier builds the payload with
// ToPayloadPullRequest ("payload"; create: pull.go:558 vs notifier.go:368 —
// the route's response and its notifier are separate conversions upstream
// too). The three arms covered here: the POST create dual-use split, the merge
// "closed"+merged payload (upstream's only PR render on that path — the route
// answers a bare StatusOK, pull.go MergePullRequest → notifier.go:715), and
// the PATCH edited/closed/reopened payloads (notifier.go:225/:397/:260).
// Slugs hpr-open/hpr-mrg are LIVE creates — their refs/pull land on the base
// cells, so both joined the beforeEach cleanup list (append-only).
// ---------------------------------------------------------------------------

describe("the pulls.ts payload assemblies — create dual-use, merge + PATCH payloads render the head repo (wave-38)", () => {
  it("the create route converts TWICE — the 201 response keeps the single render and the opened payload gets its own (pull.go:558 vs notifier.go:368)", async () => {
    // The stub creates a PR from its OWN private fork: the create route's
    // anti-enumeration CanRead guard (a16f60e) means the creating doer always
    // passes the head-read gate, so a live hide/show differential is
    // unreachable at create — upstream has the same property (NewPullRequest
    // renders with the poster). The assertion is the DUAL-USE split itself:
    // both surfaces carry the fork, each from its own conversion.
    const fixture = await seedForkWithFeature("hpr-open", { owner: "stub" });
    await clearWebhookTables();
    await seedRepoHook(fixture.baseId);
    const created = await createForkPull("hpr-open", "cf-gitea-stub/hpr-open-fork:feature");
    expect(created.status).toBe(201);

    // API side (the "single" render — the creating doer OWNS the fork: owner block).
    const body = await created.json<{ head: HeadBlock }>();
    expect(body.head).toMatchObject({ label: "feature", repo_id: Number(fixture.forkId) });
    expect(body.head.repo).toMatchObject({
      full_name: "cf-gitea-stub/hpr-open-fork",
      private: true,
      permissions: { admin: true, push: true, pull: true },
    });

    // Payload side (the "payload" render): the opened delivery carries the
    // fork block from its OWN render — not a borrowed API response object.
    const rows = await deliveryRows();
    const opened = rows.find((row) => row.eventType === "pull_request");
    if (opened === undefined) {
      throw new Error(`no pull_request delivery among: ${rows.map((row) => row.eventType).join(",")}`);
    }
    const payload = JSON.parse(opened.payloadContent) as FamilyPayload;
    expect(payload.action).toBe("opened");
    expect(payload.pull_request.head.repo_id).toBe(Number(fixture.forkId));
    expect(payload.pull_request.head.repo).toMatchObject({
      full_name: "cf-gitea-stub/hpr-open-fork",
      private: true,
      permissions: { admin: true, push: true, pull: true },
    });
  });

  it("the merge payload shows the head repo the API hides — the visibility-flip differential (MergePullRequest, notifier.go:715)", async () => {
    // Created LIVE (alice's PUBLIC fork — the stub passes the create gate and
    // the fork objects carry into the base cell), then the fork flips PRIVATE:
    // the legal row state the create route cannot produce live. The stub doer
    // becomes a stranger on the head fork — the flip-back-sensitive shape:
    // the pre-wave shared "single" render HID the fork in this payload.
    const fixture = await seedForkWithFeature("hpr-mrg", { owner: "alice" });
    const created = await createForkPull("hpr-mrg", "alice:feature");
    expect(created.status).toBe(201);
    await db().update(repositories).set({ visibility: "private" }).where(eq(repositories.id, fixture.forkId));
    await expectApiHidesHead("hpr-mrg");

    await clearWebhookTables();
    await seedRepoHook(fixture.baseId);
    const merged = await router()("/repos/cf-gitea-stub/hpr-mrg/pulls/1/merge", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ do: "merge" }),
    });
    expect(merged.status).toBe(200);

    const rows = await deliveryRows();
    const closed = rows.find((row) => row.eventType === "pull_request");
    if (closed === undefined) {
      throw new Error(`no pull_request delivery among: ${rows.map((row) => row.eventType).join(",")}`);
    }
    const payload = JSON.parse(closed.payloadContent) as FamilyPayload & { pull_request: { merged: boolean } };
    expect(payload.action).toBe("closed");
    expect(payload.pull_request.merged).toBe(true);
    expect(payload.pull_request.head.repo_id).toBe(Number(fixture.forkId));
    expect(payload.pull_request.head.repo).toMatchObject({
      full_name: "alice/hpr-mrg",
      private: true,
      // the stub stranger's block on the now-private fork (pull.go:186-190)
      permissions: { admin: false, push: false, pull: false },
    });
  });

  it("the PATCH payloads show the hidden head repo — edited (title+body), closed, reopened (notifier.go:225/:397/:260)", async () => {
    const fixture = await seedPrivateForkPull("hpr-pat");
    await expectApiHidesHead("hpr-pat");

    await clearWebhookTables();
    await seedRepoHook(fixture.baseId);
    const patch = (json: Record<string, unknown>) =>
      router()("/repos/cf-gitea-stub/hpr-pat/pulls/1", { method: "PATCH", headers: authHeaders, body: JSON.stringify(json) });
    expect((await patch({ title: "renamed fork PR" })).status).toBe(201);
    expect((await patch({ body: "new body" })).status).toBe(201);
    expect((await patch({ state: "closed" })).status).toBe(201);
    expect((await patch({ state: "open" })).status).toBe(201);

    const rows = await deliveryRows();
    const pulls = rows.filter((row) => row.eventType === "pull_request");
    const parsed = pulls.map((row) => JSON.parse(row.payloadContent) as FamilyPayload & { changes?: Record<string, unknown> });
    expect(parsed.map((payload) => payload.action)).toEqual(["edited", "edited", "closed", "reopened"]);
    // the two edited deliveries carry their upstream `changes` halves
    expect(parsed[0]?.changes).toMatchObject({ title: { from: "stranger fork PR" } });
    expect(parsed[1]?.changes).toMatchObject({ body: { from: "" } });
    // EVERY delivery renders the stranger-private fork for the receivers
    for (const payload of parsed) {
      expect(payload.pull_request.head.repo_id).toBe(Number(fixture.forkId));
      expect(payload.pull_request.head.repo).toMatchObject({
        full_name: "alice/hpr-pat",
        private: true,
        permissions: { admin: false, push: false, pull: false },
      });
    }
  });
});
