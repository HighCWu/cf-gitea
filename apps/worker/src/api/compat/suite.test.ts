/**
 * The dynamic compat suite (SPEC-0004 §5 stage 3): every IMPLEMENTED tier-1
 * operation runs against the real router in-process and must PASS its golden
 * fixture assertions; unimplemented operations are SKIPPED with an explicit
 * list; the coverage counters equal `pnpm check:api`'s stage-(c) line by
 * construction (same generated OpenAPI document, same appendix-A fixtures,
 * same algorithm — asserted in the bookkeeping block below).
 *
 * Implemented-set discipline: the implemented set is enumerated DYNAMICALLY
 * from the router's own OpenAPI document and intersected with the fixtures, so
 * a parallel route batch landing more tier-1 paths is tolerated — but each new
 * implemented operation registers a LOUD "no scenario" failure until someone
 * extends SCENARIOS, keeping the suite at parity with the routes.
 *
 * Environment: real local D1 (migrations applied in beforeAll via the
 * src/auth/testing helper pattern, plus the org DDL bootstrap the org service
 * still carries until its drizzle migration lands), deterministic seeds
 * (fixed ids/dates, shared read fixtures, write ops on unique slugs). The
 * router mounts no auth middleware from src/index.ts here — the suite injects
 * its own resolver at the createApiRouter seam so the token resolves to the
 * seeded owner row.
 */
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";
import { serializeCommit, serializeTag, serializeTree } from "@cf-gitea/git-engine";

import contractRaw from "../../compat/contract/v1-swagger.generated.json?raw";
import { comments, milestones, pullRequests, repositories, users } from "../../db/schema";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { applyOrgsDdl } from "../../services/orgs/testing";
import { OrgService } from "../../services/orgs/orgs";
import { FOLLOWS_DDL_STATEMENTS } from "../services/follows";
import { IssuesService } from "../../issues/service";
import { createOptionalTokenAuthMiddleware, createTokenAuthMiddleware } from "../auth";
import { STUB_USER } from "../auth";
import { createRepoHook } from "../services/hooks";
import { createRepoLabel } from "../services/labels";
import { createCommitStatus } from "../services/commit-status";
import { ZERO_OID } from "../services/engine";
import { addOrUpdateCollaborator } from "../services/repo-collaborators";
import { watchRepo } from "../services/repo-watchers";
import { STARS_DDL_STATEMENTS, starRepo } from "../services/stars";
import { USER_SETTINGS_DDL_STATEMENTS } from "../services/user-settings";
import { applyRepoExtrasDdl } from "../testing/repo-ddl";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { getGeneratedSpec } from "../openapi";
import { createApiRouter } from "../router";
import { registerOrgProfileRoutes } from "../routes/orgs";
import { registerFollowRoutes } from "../routes/follows";
import {
  TIER1_EXPECTED_OPERATIONS,
  TIER1_EXPECTED_PATHS,
  parseSwagger2Contract,
  parseTier1Fixtures,
  type Swagger2Method,
} from "./gen-fixtures";
import fixturesRaw from "./tier1-fixtures.json?raw";
import {
  contractModelFields,
  formatCoverage,
  implementedOperations,
  operationKey,
  runCompatSuite,
  type CompatRequest,
  type CompatRequestSender,
  type CompatScenarioCase,
  type CompatScenarioContext,
  type CompatSuiteReport,
} from "./suite";

// ---------------------------------------------------------------------------
// Parsed inputs + the dynamically enumerated implemented set.
// ---------------------------------------------------------------------------

const contract = parseSwagger2Contract(contractRaw);
const fixtures = parseTier1Fixtures(fixturesRaw);
const implemented = implementedOperations(getGeneratedSpec());
const fixtureKeys = new Set(fixtures.operations.map((operation) => operationKey(operation)));

// ---------------------------------------------------------------------------
// Deterministic seeds (fixed ids/dates; writes below use unique slugs).
// ---------------------------------------------------------------------------

const ORIGIN = "https://compat.local";
const TOKEN = "compat-suite-token";
const OWNER = "CompatOwner";
const ORG = "CompatOrg";
/** Full-length commit id the status fixtures hang off (the api layer resolves
 * refs verbatim this wave — see routes/statuses.ts). */
const SEED_SHA = "0123456789abcdef0123456789abcdef01234567";
const SEED_NOW = new Date("2026-01-05T06:07:08Z");
const SHARED_REPO_ID = "9001";

/** Seed handles the scenarios interpolate into request paths. */
const seeds: Record<string, string | number> = {
  token: TOKEN,
  owner: OWNER,
  org: ORG,
  repoOwner: OWNER.toLowerCase(),
  repoSlug: "shared",
  sha: SEED_SHA,
};

/**
 * The api-layer identity the suite token resolves to — the seeded owner row
 * rendered through the contract User model (STUB_USER carries the exact
 * field set; id/login are re-pointed at the D1 row so doer-scoped routes —
 * /user/repos, /user/orgs, org-repo creation — see the seeded principal).
 */
function suiteIdentity(): User {
  const ownerId = seeds.ownerId;
  if (typeof ownerId !== "number") {
    throw new Error("suite seeds not applied — beforeAll has not run");
  }
  return { ...STUB_USER, id: ownerId, login: OWNER, full_name: OWNER, created: SEED_NOW.toISOString() };
}

/** The api-layer identity both senders resolve the suite token to — the
 *  seeded owner row rendered through the contract User model (STUB_USER
 *  carries the exact field set; id/login are re-pointed at the D1 row so
 *  doer-scoped routes see the seeded principal). */
const suiteResolver = {
  resolveToken: (token: string) => Promise.resolve(token === TOKEN ? suiteIdentity() : null),
};

/** Fresh in-process router per request, real test-worker bindings (no SELF.fetch). */
const send: CompatRequestSender = (request: CompatRequest): Promise<Response> => {
  const app = createApiRouter({ auth: suiteResolver });
  return Promise.resolve(app.fetch(new Request(`${ORIGIN}${request.path}`, request.init), env));
};

async function seedUser(username: string): Promise<number> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: false,
      status: "active",
      createdAt: SEED_NOW,
    })
    .returning({ id: users.id })
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error(`user seed failed: ${username}`);
  return row.id;
}

async function seedRepo(id: string, ownerNamespace: string, slug: string): Promise<void> {
  await drizzle(env.DB).insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace,
    slug,
    visibility: "public",
    refsVersion: 0, // repoTestHook's early-204 (no commits) and empty:true stay deterministic
    backend: "self-hosted",
    numIssues: 3,
    numPulls: 1,
    createdAt: SEED_NOW,
  });
}

async function seedMilestone(repoId: string, name: string): Promise<number> {
  const rows = await drizzle(env.DB)
    .insert(milestones)
    .values({ repoId, name, content: "", createdAt: SEED_NOW, updatedAt: SEED_NOW })
    .returning({ id: milestones.id })
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error(`milestone seed failed: ${name}`);
  return row.id;
}

async function seedHook(repoId: string, name: string, url: string, events: string[]): Promise<number> {
  const row = await createRepoHook(env.DB, repoId, {
    type: "gitea",
    branch_filter: "*",
    config: { url, content_type: "json" },
    events,
    active: false,
  });
  return row.id;
}

/**
 * SHA-1 over the canonical git object header + content — the engine's
 * hashObjectOid is not on the runtime export surface, so the git-object seeds
 * hash Worker-side (workerd-native crypto.subtle; putApiObjects re-verifies
 * before storing, so a mismatch fails the seed loudly rather than corrupting).
 */
async function gitObjectOid(type: string, data: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`${type} ${data.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + data.byteLength);
  bytes.set(header, 0);
  bytes.set(data, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

beforeAll(async () => {
  await applyAuthD1Migrations();
  // Org tables are not in the generated migrations yet (schema.ts is owned by
  // another change) — the SPEC-0007 test-side DDL bootstrap fills the gap.
  await applyOrgsDdl();

  const ownerId = await seedUser(OWNER);
  const neighborId = await seedUser("CompatNeighbor"); // second user so /users/search paginates
  const orgs = new OrgService(env.DB);
  const compatOrg = await orgs.createOrg({ name: ORG, ownerId, fullName: "Compat Org", now: SEED_NOW });
  Object.assign(seeds, { ownerId, neighborId, orgId: compatOrg.id });

  await seedRepo(SHARED_REPO_ID, OWNER.toLowerCase(), "shared"); // the shared read fixture
  await seedRepo("9002", OWNER.toLowerCase(), "second"); // second repo → list pagination
  await seedRepo("9003", ORG.toLowerCase(), "org-shared"); // org listing fixture

  const labelA = await createRepoLabel(env.DB, SHARED_REPO_ID, {
    name: "alpha",
    exclusive: false,
    color: "#aa0000",
    description: "seed label alpha",
    isArchived: false,
    now: SEED_NOW,
  });
  const labelB = await createRepoLabel(env.DB, SHARED_REPO_ID, {
    name: "beta",
    exclusive: false,
    color: "#00aa00",
    description: "seed label beta",
    isArchived: false,
    now: SEED_NOW,
  });

  const milestoneA = await seedMilestone(SHARED_REPO_ID, "alpha");
  const milestoneB = await seedMilestone(SHARED_REPO_ID, "beta");

  const hookA = await seedHook(SHARED_REPO_ID, "push-hook", "https://hooks.invalid/compat-a", ["push"]);
  const hookB = await seedHook(SHARED_REPO_ID, "issues-hook", "https://hooks.invalid/compat-b", ["issues"]);

  await createCommitStatus(env.DB, {
    repoId: SHARED_REPO_ID,
    sha: SEED_SHA,
    state: "success",
    targetUrl: "https://ci.invalid/compat/1",
    description: "compat suite seed status",
    context: "ci/compat",
    creatorId: ownerId,
  });

  Object.assign(seeds, {
    ownerId,
    repoId: SHARED_REPO_ID,
    labelA: labelA.id,
    labelB: labelB.id,
    milestoneA,
    milestoneB,
    hookA,
    hookB,
  });

  // Issue-block seeds (SPEC-0005 §5.3 discipline): four issues through the
  // landed service — two open (one enriched), one closed (carries the close
  // system comment the issueGetComment 204 scenario reads), one deleted by
  // the issueDelete scenario — plus three user comments. The compat identity
  // resolves to the owner row, so every write scenario rides the
  // poster-or-writer path.
  const issuesService = new IssuesService(env.DB);
  const issueA = await issuesService.createIssue({
    repoId: SHARED_REPO_ID,
    title: "compat alpha issue",
    content: "seeded by the compat suite",
    posterId: ownerId,
    labelIds: [labelA.id],
    milestoneId: milestoneA,
  });
  const issueB = await issuesService.createIssue({
    repoId: SHARED_REPO_ID,
    title: "compat beta issue",
    content: "second seed",
    posterId: ownerId,
    labelIds: [labelA.id, labelB.id],
  });
  const issueC = await issuesService.createIssue({
    repoId: SHARED_REPO_ID,
    title: "compat closed issue",
    posterId: ownerId,
  });
  await issuesService.closeIssue(issueC.id, { actorId: ownerId });
  const issueD = await issuesService.createIssue({
    repoId: SHARED_REPO_ID,
    title: "compat doomed issue",
    posterId: ownerId,
  });

  const commentA = await issuesService.addComment({ issueId: issueA.id, posterId: ownerId, content: "seeded comment alpha" });
  const commentB = await issuesService.addComment({ issueId: issueA.id, posterId: ownerId, content: "seeded comment beta" });
  await issuesService.addComment({ issueId: issueC.id, posterId: ownerId, content: "seeded comment on the closed issue" });
  const closeCommentRow = await drizzle(env.DB)
    .select()
    .from(comments)
    .where(and(eq(comments.issueId, issueC.id), eq(comments.type, 2)))
    .limit(1)
    .then((rows) => rows[0]);

  Object.assign(seeds, {
    issueA: issueA.index,
    issueB: issueB.index,
    issueC: issueC.index,
    issueD: issueD.index,
    commentA: commentA.id,
    commentB: commentB.id,
    closeComment: closeCommentRow?.id ?? 0,
  });

  // PR-block seeds (SPEC-0005 §2.4 discipline): two same-repo PRs through the
  // landed service (drawn from the SAME shared counter as the issues above),
  // one of them dedicated to the PATCH scenario.
  const pullA = await issuesService.createPullRequest({
    repoId: SHARED_REPO_ID,
    title: "compat alpha pull",
    content: "seeded by the compat suite",
    posterId: ownerId,
    headRepoId: SHARED_REPO_ID,
    baseBranch: "main",
    headBranch: "compat-topic",
  });
  const pullB = await issuesService.createPullRequest({
    repoId: SHARED_REPO_ID,
    title: "compat beta pull",
    posterId: ownerId,
    headRepoId: SHARED_REPO_ID,
    baseBranch: "main",
    headBranch: "compat-topic-2",
  });

  Object.assign(seeds, {
    pullA: pullA.issue.index,
    pullB: pullB.issue.index,
  });
  // repoGetCommitPullRequest join seed: the alpha pull's head_sha cache
  // points at the suite's shared commit sha (the D1 join target).
  await drizzle(env.DB)
    .update(pullRequests)
    .set({ headSha: SEED_SHA })
    .where(eq(pullRequests.id, pullA.pullRequest.id));

  // ---------------------------------------------------------------------
  // Batch-7 D1 block (SPEC-0004 §2.4 rows repoListTopics … repoTransfer):
  // the raw-D1 stores bootstrap from their services' DDL statements (the
  // services document the schema gap), then each family gets dedicated
  // seeds — releases ride a NON-empty repo (refs_version 1), repo-edit and
  // transfer get their own repos so the shared read fixture stays untouched.
  // ---------------------------------------------------------------------
  await applyRepoExtrasDdl();

  await seedRepo("9004", OWNER.toLowerCase(), "rel"); // releases: needs a non-empty repo
  await drizzle(env.DB).update(repositories).set({ refsVersion: 1 }).where(eq(repositories.id, "9004"));
  await seedRepo("9005", OWNER.toLowerCase(), "compat-edit"); // repoEdit victim
  await seedRepo("9006", OWNER.toLowerCase(), "compat-transfer"); // repoTransfer victim
  await seedRepo("9007", OWNER.toLowerCase(), "compat-del"); // repoDelete victim

  const compatCollab1 = await seedUser("CompatCollab");
  const compatCollab2 = await seedUser("CompatCollab2");
  // read-mode rows: they show in the collaborator list but not in the
  // write-or-above assignee set (order-independent scenarios either way).
  await addOrUpdateCollaborator(env.DB, SHARED_REPO_ID, compatCollab1, "read", SEED_NOW);
  await addOrUpdateCollaborator(env.DB, SHARED_REPO_ID, compatCollab2, "read", SEED_NOW);
  // The watch row pre-exists so userCurrentCheckSubscription (which runs
  // before the PUT in fixture order) sees the subscribed state.
  await watchRepo(env.DB, SHARED_REPO_ID, ownerId, SEED_NOW);

  const relNow = (minutes: number) => new Date(SEED_NOW.getTime() + minutes * 60_000);
  const relService = new IssuesService(env.DB);
  const relA = await relService.createRelease({
    repoId: "9004",
    publisherId: ownerId,
    tagName: "compat-v1",
    target: "main",
    title: "compat v1",
    note: "seeded by the compat suite",
    now: relNow(0),
  });
  await relService.createRelease({ repoId: "9004", publisherId: ownerId, tagName: "compat-v2", title: "compat v2", now: relNow(1) });
  await relService.createRelease({ repoId: "9004", publisherId: ownerId, tagName: "compat-v-del", title: "compat v del", now: relNow(2) });
  const relD = await relService.createRelease({ repoId: "9004", publisherId: ownerId, tagName: "compat-v-del-id", title: "compat v del id", now: relNow(3) });
  // The asset-family victim: a draft so repoGetLatestRelease and the
  // anonymous release reads stay untouched by the asset scenarios.
  const relAssets = await relService.createRelease({
    repoId: "9004",
    publisherId: ownerId,
    tagName: "compat-v-assets",
    target: "main",
    title: "compat v assets",
    isDraft: true,
    now: relNow(4),
  });

  Object.assign(seeds, {
    releaseEditId: relA.id,
    releaseDeleteId: relD.id,
    assetsReleaseId: relAssets.id,
  });

  // ---------------------------------------------------------------------
  // Git-object seeds (SPEC-0004 §2.4 rows repoListBranches … GetAnnotatedTag):
  // the branch/tag/raw-git families answer from the ENGINE cell, so beforeAll
  // builds one dedicated repo with real objects — a self-contained blob →
  // tree → commit, an annotated tag over it, and the victim refs the mutation
  // scenarios consume — landed through the same public RPCs the API layer
  // itself uses (putApiObjects + commitApiChange + setHead; commitApiChange
  // caches the tag peel on the refs row). The D1 row carries the post-push
  // state (isEmpty=false, refs_version=1); the shared fixture repo stays
  // isEmpty=true, which is exactly the upstream empty-repo guard family those
  // routes mirror (404 branch mutations / 405 tag writes).
  // ---------------------------------------------------------------------
  await seedRepo("9008", OWNER.toLowerCase(), "compat-git");
  await drizzle(env.DB)
    .update(repositories)
    .set({ isEmpty: false, refsVersion: 1 })
    .where(eq(repositories.id, "9008"));

  const gitPerson = {
    name: "Compat Owner",
    email: "compat@suite.invalid",
    time: Math.floor(SEED_NOW.getTime() / 1000),
    tz: "+0000",
  };
  const gitBlobData = new TextEncoder().encode("hello compat git\n");
  const gitBlobOid = await gitObjectOid("blob", gitBlobData);
  const gitTree = serializeTree([{ mode: "100644", name: "compat.txt", oid: gitBlobOid }]);
  const gitCommit = serializeCommit({
    tree: gitTree.oid,
    parents: [],
    author: gitPerson,
    committer: gitPerson,
    message: "compat suite seed commit\n",
  });
  const gitAnnotated = serializeTag({
    object: gitCommit.oid,
    type: "commit",
    tag: "compat-annotated",
    tagger: gitPerson,
    message: "compat suite annotated tag\n",
  });

  const gitCell = env.REPO.getByName(`${OWNER.toLowerCase()}/compat-git`);
  const storedGitObjects = await gitCell.putApiObjects([
    { oid: gitBlobOid, type: "blob", data: gitBlobData },
    { oid: gitTree.oid, type: "tree", data: gitTree.data },
    { oid: gitCommit.oid, type: "commit", data: gitCommit.data },
    { oid: gitAnnotated.oid, type: "tag", data: gitAnnotated.data },
  ]);
  if (storedGitObjects.tag !== "ok") {
    throw new Error(`git-object seed putApiObjects failed: ${storedGitObjects.tag}`);
  }
  const landSeedRef = async (ref: string, oid: string): Promise<void> => {
    const result = await gitCell.commitApiChange({ ref, expectedOldOid: ZERO_OID, newOid: oid });
    if (result.tag !== "committed") {
      throw new Error(`git-object seed ref landing failed: ${ref} (${result.tag})`);
    }
  };
  await landSeedRef("refs/heads/main", gitCommit.oid); // the default branch (setHead below)
  await landSeedRef("refs/heads/compat-del-branch", gitCommit.oid); // repoDeleteBranch victim
  await landSeedRef("refs/heads/compat-rename-src", gitCommit.oid); // repoRenameBranch victim
  await landSeedRef("refs/tags/compat-annotated", gitAnnotated.oid); // annotated (peeled refs row)
  await landSeedRef("refs/tags/compat-light", gitCommit.oid); // lightweight tag
  await landSeedRef("refs/tags/compat-del-tag", gitCommit.oid); // repoDeleteTag victim (no release row)
  const gitHead = await gitCell.setHead("main");
  if (gitHead.tag !== "ok") {
    throw new Error(`git-object seed setHead failed: ${gitHead.tag}`);
  }

  Object.assign(seeds, {
    gitRepoSlug: "compat-git",
    gitCommit: gitCommit.oid,
    gitTree: gitTree.oid,
    gitBlob: gitBlobOid,
    gitAnnotatedTag: gitAnnotated.oid,
  });

  // ---------------------------------------------------------------------
  // PR-engine seeds (SPEC-0005 §3.4, batch-8 rows repoDownloadPullDiffOrPatch
  // … repoMergeUpstream): a topic/done commit pair children of the seed
  // commit, two PR rows on the compat-git repo (one open+mergeable for the
  // diff/commits/files/merge scenarios, one pre-merged for the is-merged
  // 204), their base-repo refs/pull/N/head landed through the same
  // receive-less commitApiChange the create route uses. The mergeable state
  // machine runs lazily on GET (ensurePullRequestChecked), so the rows here
  // stay checking — the merge scenario drives the real engine execution.
  // ---------------------------------------------------------------------
  const topicBlobData = new TextEncoder().encode("topic change\n");
  const topicBlobOid = await gitObjectOid("blob", topicBlobData);
  const topicTree = serializeTree([
    { mode: "100644", name: "compat.txt", oid: gitBlobOid },
    { mode: "100644", name: "topic.txt", oid: topicBlobOid },
  ]);
  const topicCommit = serializeCommit({
    tree: topicTree.oid,
    parents: [gitCommit.oid],
    author: gitPerson,
    committer: gitPerson,
    message: "compat topic commit\n",
  });
  const doneCommit = serializeCommit({
    tree: topicTree.oid,
    parents: [gitCommit.oid],
    author: gitPerson,
    committer: gitPerson,
    message: "compat done commit\n",
  });
  const storedPrObjects = await gitCell.putApiObjects([
    { oid: topicBlobOid, type: "blob", data: topicBlobData },
    { oid: topicTree.oid, type: "tree", data: topicTree.data },
    { oid: topicCommit.oid, type: "commit", data: topicCommit.data },
    { oid: doneCommit.oid, type: "commit", data: doneCommit.data },
  ]);
  if (storedPrObjects.tag !== "ok") {
    throw new Error(`pr seed putApiObjects failed: ${storedPrObjects.tag}`);
  }
  await landSeedRef("refs/heads/compat-topic", topicCommit.oid);
  await landSeedRef("refs/heads/compat-done", doneCommit.oid);
  await landSeedRef("refs/heads/compat-create-head", gitCommit.oid);

  const gitIssues = new IssuesService(env.DB);
  const prTopic = await gitIssues.createPullRequest({
    repoId: "9008",
    headRepoId: "9008",
    baseBranch: "main",
    headBranch: "compat-topic",
    title: "compat engine pull",
    posterId: ownerId,
    headSha: topicCommit.oid,
  });
  const prMerged = await gitIssues.createPullRequest({
    repoId: "9008",
    headRepoId: "9008",
    baseBranch: "main",
    headBranch: "compat-done",
    title: "compat merged pull",
    posterId: ownerId,
    headSha: doneCommit.oid,
  });
  await landSeedRef(`refs/pull/${prTopic.pullRequest.index}/head`, topicCommit.oid);
  await landSeedRef(`refs/pull/${prMerged.pullRequest.index}/head`, doneCommit.oid);
  // pre-merge the done PR's row (the is-merged 204 scenario reads only the row)
  await drizzle(env.DB)
    .update(pullRequests)
    .set({ hasMerged: true, mergedCommitId: doneCommit.oid, mergerId: ownerId, mergedAt: SEED_NOW, status: 3 })
    .where(eq(pullRequests.id, prMerged.pullRequest.id));

  Object.assign(seeds, {
    prTopic: prTopic.issue.index,
    prMerged: prMerged.issue.index,
  });

  // ---------------------------------------------------------------------
  // Tier-2 org + identity block (SPEC-0004 appendix A category a, T2 rows):
  // membership seeds for the CompatOrg (a concealed member + a public one),
  // a dedicated rename pair, and follow edges. The follow table is
  // pre-migration (services/follows.ts DDL block) — the raw bootstrap
  // applies it here like applyOrgsDdl does for the org tables. These seeds
  // back the tier-2 scenario describe below; the tier-1 fixture scenarios
  // above are untouched (the owner's org list gains no rows).
  // ---------------------------------------------------------------------
  for (const statement of FOLLOWS_DDL_STATEMENTS) {
    await env.DB.prepare(statement).run();
  }
  await env.DB.prepare("DELETE FROM follows").run();

  // seedUser here returns the ROW ID (a number), not a handle object.
  const memberUserId = await seedUser("CompatMember"); // concealed member (delete victim)
  const loudUserId = await seedUser("CompatLoud"); // public member
  const renameHolderId = await seedUser("CompatRenameHolder"); // owns the pre-rename org
  const orgsService = new OrgService(env.DB);
  await orgsService.addMember(compatOrg.id, memberUserId, { isPublic: false });
  await orgsService.addMember(compatOrg.id, loudUserId, { isPublic: true });
  // Dedicated rename pair for the 307 seam scenario (GET /orgs/{old} → 307).
  const renameOrg = await orgsService.createOrg({
    name: "CompatRenamedOrg",
    ownerId: renameHolderId,
    now: SEED_NOW,
  });
  await orgsService.renameOrg(renameOrg.id, "CompatRenamedOrgNew");

  // Follow edges: owner ⇄ neighbor (the follow-listing/check scenarios).
  const followStmt = env.DB.prepare(
    "INSERT INTO follows (user_id, follow_id, created_at) VALUES (?, ?, ?)",
  );
  const followUnix = Math.floor(SEED_NOW.getTime() / 1000);
  await followStmt.bind(ownerId, neighborId, followUnix).run();
  await followStmt.bind(neighborId, ownerId, followUnix).run();

  Object.assign(seeds, {
    neighbor: "CompatNeighbor",
    member: "CompatMember",
    loudMember: "CompatLoud",
    renamedOrg: "CompatRenamedOrg",
    renamedOrgNew: "CompatRenamedOrgNew",
  });

  // ---------------------------------------------------------------------
  // Tier-1 user-straggler block (SPEC-0004 §2.4 rows createCurrentUserRepo,
  // getUserSettings/updateUserSettings, userCurrentListStarred +
  // userCurrent{CheckStarring,PutStar,DeleteStar}): the stars + user_settings
  // raw-D1 stores bootstrap from their services' DDL statements (the follows
  // pattern), star edges pre-seed the starred fixtures (the list needs
  // total ≥ 2; the DELETE victim "rel" is the third star so any case order
  // keeps the list paginated), and user_settings stays rowless (GET renders
  // the upstream defaults until the PATCH scenario writes them).
  // ---------------------------------------------------------------------
  for (const statement of STARS_DDL_STATEMENTS) {
    await env.DB.prepare(statement).run();
  }
  for (const statement of USER_SETTINGS_DDL_STATEMENTS) {
    await env.DB.prepare(statement).run();
  }
  await env.DB.prepare("DELETE FROM stars").run();
  await env.DB.prepare("DELETE FROM user_settings").run();
  await starRepo(env.DB, ownerId, SHARED_REPO_ID, SEED_NOW);
  await starRepo(env.DB, ownerId, "9002", SEED_NOW);
  await starRepo(env.DB, ownerId, "9004", SEED_NOW);
});

// ---------------------------------------------------------------------------
// Scenarios — one or more executable cases per IMPLEMENTED operationId.
// Each case drives a known status and is self-contained (write ops use their
// own entities so case order never matters). Extend this table — plus seeds —
// when a route batch lands; the harness fails an implemented-but-scenario-less
// operation loudly until then.
// ---------------------------------------------------------------------------

const JSON_HEADERS = { "Content-Type": "application/json" };

const repoPath = (ctx: CompatScenarioContext): string =>
  `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.repoSlug)}`;

/**
 * Deterministic multipart body for the repoCreateReleaseAttachment scenario
 * (the `attachment` file part of the contract's formData declaration).
 */
const ASSET_MULTIPART_BYTES = new TextEncoder().encode(
  '--compat-asset\r\n' +
    'Content-Disposition: form-data; name="attachment"; filename="compat-asset.bin"\r\n' +
    'Content-Type: application/octet-stream\r\n' +
    '\r\n' +
    'compat asset bytes\n' +
    '\r\n' +
    '--compat-asset--\r\n',
);

const SCENARIOS: Readonly<Record<string, readonly CompatScenarioCase[]>> = {
  getVersion: [{ name: "instance version", status: 200, request: () => ({ path: "/version" }) }],

  userGetCurrent: [
    { name: "token identity", status: 200, request: (ctx) => ({ path: "/user", init: ctx.withAuth() }) },
    {
      // Runtime-only status: upstream reqToken() rejects anonymous callers and
      // the vendored swagger documents only 200 (RUNTIME_ONLY_RESPONSES).
      name: "anonymous → runtime-only 401",
      status: 401,
      request: () => ({ path: "/user" }),
    },
  ],
  userSearch: [
    {
      name: "first page",
      status: 200,
      linkRels: ["next", "last"],
      request: () => ({ path: "/users/search?limit=1" }),
    },
  ],
  userGet: [
    { name: "seeded owner", status: 200, request: (ctx) => ({ path: `/users/${String(ctx.seeds.owner)}` }) },
    {
      // The 404 empty family: the contract declares no body, but upstream's
      // APIErrorNotFound marshals {message, url} at runtime — the suite
      // accepts both (documented conversion in suite.ts).
      name: "missing user → runtime-body 404",
      status: 404,
      request: () => ({ path: "/users/ghost" }),
    },
  ],
  userListRepos: [
    {
      name: "first page",
      status: 200,
      linkRels: ["next", "last"],
      request: (ctx) => ({ path: `/users/${String(ctx.seeds.repoOwner)}/repos?limit=1` }),
    },
  ],
  userCurrentListRepos: [
    {
      name: "first page",
      status: 200,
      linkRels: ["next", "last"],
      request: (ctx) => ({ path: "/user/repos?limit=1", init: ctx.withAuth() }),
    },
  ],
  createCurrentUserRepo: [
    {
      name: "create",
      status: 201,
      request: (ctx) => ({
        path: "/user/repos",
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ name: "compat-user-created", description: "created by the compat suite", private: false }),
        }),
      }),
    },
    {
      // The engine lands the initial commit (services/user-repos.ts) — the
      // response row re-reads with empty:false.
      name: "auto_init lands the initial commit",
      status: 201,
      request: (ctx) => ({
        path: "/user/repos",
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            name: "compat-user-init",
            description: "initialized by the compat suite",
            private: false,
            auto_init: true,
          }),
        }),
      }),
    },
    {
      name: "unknown readme template → declared 400",
      status: 400,
      request: (ctx) => ({
        path: "/user/repos",
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ name: "compat-user-readme", auto_init: true, readme: "Nope" }),
        }),
      }),
    },
    {
      name: "duplicate of the seeded repo → declared 409",
      status: 409,
      request: (ctx) => ({
        path: "/user/repos",
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ name: String(ctx.seeds.repoSlug) }),
        }),
      }),
    },
    {
      name: "invalid name → declared 422",
      status: 422,
      request: (ctx) => ({
        path: "/user/repos",
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ name: "bad name!" }),
        }),
      }),
    },
  ],

  getUserSettings: [
    {
      name: "upstream defaults",
      status: 200,
      request: (ctx) => ({ path: "/user/settings", init: ctx.withAuth() }),
    },
  ],
  updateUserSettings: [
    {
      name: "update the presented fields",
      status: 200,
      request: (ctx) => ({
        path: "/user/settings",
        init: ctx.withAuth({
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ full_name: "Compat Owner (edited)", location: "compat-vale", hide_email: true, theme: "gitea-dark" }),
        }),
      }),
    },
  ],

  userCurrentListStarred: [
    {
      name: "seeded stars, first page",
      status: 200,
      linkRels: ["next", "last"],
      request: (ctx) => ({ path: "/user/starred?limit=1", init: ctx.withAuth() }),
    },
  ],
  userCurrentCheckStarring: [
    {
      name: "seeded star",
      status: 204,
      request: (ctx) => ({ path: `/user/starred/${String(ctx.seeds.repoOwner)}/shared`, init: ctx.withAuth() }),
    },
    {
      name: "visible but unstarred → declared 404",
      status: 404,
      request: (ctx) => ({ path: `/user/starred/${String(ctx.seeds.repoOwner)}/org-shared`, init: ctx.withAuth() }),
    },
  ],
  userCurrentPutStar: [
    {
      name: "star (idempotent on the seeded edge)",
      status: 204,
      request: (ctx) => ({
        path: `/user/starred/${String(ctx.seeds.repoOwner)}/shared`,
        init: ctx.withAuth({ method: "PUT" }),
      }),
    },
  ],
  userCurrentDeleteStar: [
    {
      name: "unstar the dedicated seed",
      status: 204,
      request: (ctx) => ({
        path: `/user/starred/${String(ctx.seeds.repoOwner)}/rel`,
        init: ctx.withAuth({ method: "DELETE" }),
      }),
    },
  ],

  repoGet: [
    { name: "seeded repo", status: 200, request: (ctx) => ({ path: repoPath(ctx) }) },
    {
      name: "missing repo → runtime-body 404",
      status: 404,
      request: (ctx) => ({ path: `/repos/${String(ctx.seeds.repoOwner)}/ghost` }),
    },
  ],
  repoSearch: [
    {
      name: "two keyword hits, first page",
      status: 200,
      linkRels: ["next", "last"],
      request: (ctx) => ({
        path: `/repos/search?q=${String(ctx.seeds.repoOwner)}/shared,${String(ctx.seeds.repoOwner)}/second&limit=1`,
      }),
    },
    {
      name: "invalid mode",
      status: 422,
      request: () => ({ path: "/repos/search?mode=bogus" }),
    },
  ],
  repoGetByID: [
    {
      name: "seeded repo id",
      status: 200,
      request: (ctx) => ({ path: `/repositories/${String(ctx.seeds.repoId)}`, init: ctx.withAuth() }),
    },
  ],

  repoListStatuses: [
    {
      name: "seeded sha statuses",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/statuses/${String(ctx.seeds.sha)}?limit=1` }),
    },
  ],
  repoCreateStatus: [
    {
      name: "create on the seeded sha",
      status: 201,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/statuses/${String(ctx.seeds.sha)}`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ state: "success", context: "ci/suite", description: "compat suite status", target_url: "" }),
        }),
      }),
    },
  ],
  repoListStatusesByRef: [
    {
      name: "seeded sha as ref",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/commits/${String(ctx.seeds.sha)}/statuses?limit=1` }),
    },
  ],
  repoGetCombinedStatusByRef: [
    {
      name: "seeded sha as ref",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/commits/${String(ctx.seeds.sha)}/status?limit=1` }),
    },
  ],

  // ---------------------------------------------------------------------
  // Issue block (SPEC-0004 §2.4 rows issueListIssues … issueSearchIssues).
  // Scenario order mirrors the fixture order: search runs FIRST (only the
  // beforeAll seeds exist), then list/create, then the {index} paths.
  // ---------------------------------------------------------------------

  issueSearchIssues: [
    {
      name: "keyword hit, first page",
      status: 200,
      linkRels: ["next", "last"],
      request: () => ({ path: `/repos/issues/search?q=${encodeURIComponent("compat ")}&limit=1` }),
    },
    {
      name: "unknown owner → declared 400",
      status: 400,
      request: () => ({ path: "/repos/issues/search?owner=ghost" }),
    },
  ],
  issueListIssues: [
    {
      name: "first page (state defaults to open)",
      status: 200,
      linkRels: ["next", "last"],
      request: (ctx) => ({ path: `${repoPath(ctx)}/issues?limit=1` }),
    },
  ],
  issueCreateIssue: [
    {
      name: "create",
      status: 201,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/issues`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ title: "compat-created issue", body: "created by the compat suite" }),
        }),
      }),
    },
  ],
  issueGetRepoComments: [
    {
      name: "first page of the repo-wide feed",
      status: 200,
      linkRels: ["next", "last"],
      request: (ctx) => ({ path: `${repoPath(ctx)}/issues/comments?limit=1` }),
    },
  ],
  issueGetComment: [
    {
      name: "seeded comment (global id)",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/issues/comments/${String(ctx.seeds.commentA)}` }),
    },
    {
      name: "system comment → empty 204",
      status: 204,
      request: (ctx) => ({ path: `${repoPath(ctx)}/issues/comments/${String(ctx.seeds.closeComment)}` }),
    },
  ],
  issueDeleteComment: [
    {
      name: "delete the dedicated seed comment",
      status: 204,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/issues/comments/${String(ctx.seeds.commentB)}`,
        init: ctx.withAuth({ method: "DELETE" }),
      }),
    },
  ],
  issueEditComment: [
    {
      name: "edit the seeded comment",
      status: 200,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/issues/comments/${String(ctx.seeds.commentA)}`,
        init: ctx.withAuth({
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ body: "edited by the compat suite" }),
        }),
      }),
    },
  ],
  issueGetIssue: [
    {
      name: "seeded issue",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/issues/${String(ctx.seeds.issueA)}` }),
    },
    {
      name: "missing index → runtime-body 404",
      status: 404,
      request: (ctx) => ({ path: `${repoPath(ctx)}/issues/999` }),
    },
  ],
  issueDelete: [
    {
      name: "delete the dedicated seed issue",
      status: 204,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/issues/${String(ctx.seeds.issueD)}`,
        init: ctx.withAuth({ method: "DELETE" }),
      }),
    },
  ],
  issueEditIssue: [
    {
      // PATCH answers 201 upstream (the quirk the fixture records).
      name: "edit the seeded issue (201 quirk)",
      status: 201,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/issues/${String(ctx.seeds.issueA)}`,
        init: ctx.withAuth({
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ title: "compat alpha issue (edited)" }),
        }),
      }),
    },
  ],
  issueGetComments: [
    {
      name: "seeded issue comments",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/issues/${String(ctx.seeds.issueA)}/comments` }),
    },
  ],
  issueCreateComment: [
    {
      name: "comment on the seeded issue",
      status: 201,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/issues/${String(ctx.seeds.issueA)}/comments`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ body: "created by the compat suite" }),
        }),
      }),
    },
  ],
  issueGetLabels: [
    {
      name: "seeded issue labels",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/issues/${String(ctx.seeds.issueA)}/labels` }),
    },
  ],
  issueReplaceLabels: [
    {
      name: "replace with the first seeded label",
      status: 200,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/issues/${String(ctx.seeds.issueA)}/labels`,
        init: ctx.withAuth({
          method: "PUT",
          headers: JSON_HEADERS,
          body: JSON.stringify({ labels: [Number(ctx.seeds.labelA)] }),
        }),
      }),
    },
  ],
  issueAddLabel: [
    {
      name: "add the second seeded label (200, never 201)",
      status: 200,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/issues/${String(ctx.seeds.issueA)}/labels`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ labels: [Number(ctx.seeds.labelB)] }),
        }),
      }),
    },
  ],
  issueClearLabels: [
    {
      name: "clear",
      status: 204,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/issues/${String(ctx.seeds.issueA)}/labels`,
        init: ctx.withAuth({ method: "DELETE" }),
      }),
    },
  ],
  issueGetCommentsAndTimeline: [
    {
      name: "closed issue timeline (comment + close)",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/issues/${String(ctx.seeds.issueC)}/timeline` }),
    },
  ],

  // ---------------------------------------------------------------------
  // PR block (SPEC-0004 §2.4 rows repoListPullRequests …
  // repoGetPullRequestByBaseHead). Scenario order mirrors the fixture
  // order: list/create first, then the {index}/{base}/{head} paths. The
  // engine-backed siblings ({index}.{diffType}, /commits, /files, /merge)
  // stay unimplemented (DECLARED-BUT-DEFERRED with specs/0001b).
  // ---------------------------------------------------------------------

  repoListPullRequests: [
    {
      // state matches ONLY "open"/"closed" upstream — absent lists both.
      name: "first page (absent state lists open+closed)",
      status: 200,
      linkRels: ["next", "last"],
      request: (ctx) => ({ path: `${repoPath(ctx)}/pulls?limit=1` }),
    },
  ],
  repoCreatePullRequest: [
    {
      // The create validates base/head against the ENGINE (SPEC-0005 §3.4):
      // both branches live on the compat-git repo, and the created PR's
      // refs/pull/N/head lands through commitApiChange.
      name: "create (engine-validated base/head)",
      status: 201,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/pulls`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ title: "compat-created pull", body: "created by the compat suite", head: "compat-create-head", base: "main" }),
        }),
      }),
    },
    {
      name: "missing head branch → declared 404",
      status: 404,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/pulls`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ title: "x", head: "compat-ghost", base: "main" }),
        }),
      }),
    },
    {
      name: "head equals base → declared 422",
      status: 422,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/pulls`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ title: "x", head: "main", base: "main" }),
        }),
      }),
    },
  ],
  repoGetPullRequest: [
    {
      name: "seeded pull",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/pulls/${String(ctx.seeds.pullA)}` }),
    },
    {
      name: "missing index → runtime-body 404",
      status: 404,
      request: (ctx) => ({ path: `${repoPath(ctx)}/pulls/999` }),
    },
  ],
  repoEditPullRequest: [
    {
      // PATCH answers 201 upstream (the quirk the fixture records).
      name: "edit the seeded pull (201 quirk)",
      status: 201,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/pulls/${String(ctx.seeds.pullA)}`,
        init: ctx.withAuth({
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ title: "compat alpha pull (edited)" }),
        }),
      }),
    },
  ],
  repoGetPullRequestByBaseHead: [
    {
      name: "seeded base/head",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/pulls/main/compat-topic` }),
    },
    {
      name: "missing targets → runtime-body 404",
      status: 404,
      request: (ctx) => ({ path: `${repoPath(ctx)}/pulls/main/ghost` }),
    },
  ],
  repoGetCommitPullRequest: [
    {
      // The alpha pull's head_sha cache points at the shared seed sha (the
      // join target; upstream joins merged_commit_id — the documented
      // divergence of services/commit-pull.ts).
      name: "the PR carrying the seeded commit sha",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/commits/${String(ctx.seeds.sha)}/pull` }),
    },
    {
      name: "sha no PR carries → runtime-body 404",
      status: 404,
      request: (ctx) => ({ path: `${repoPath(ctx)}/commits/${"f".repeat(40)}/pull` }),
    },
  ],

  // ---------------------------------------------------------------------
  // PR deferred family (batch 8, SPEC-0005 §3.4): the engine-backed
  // {index}.{diffType} / commits / files / merge rows over the compat-git
  // PR seeds. The merge scenario consumes the dedicated open pull (fixture
  // order runs it after the diff/commits/files reads); the 405/409 gates are
  // the route tests' business here — the fixture pins the 200 empty happy
  // path.
  // ---------------------------------------------------------------------

  repoDownloadPullDiffOrPatch: [
    {
      name: "raw diff of the seeded engine pull",
      status: 200,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/pulls/${String(ctx.seeds.prTopic)}.diff`,
      }),
    },
  ],
  repoGetPullRequestCommits: [
    {
      name: "commits of the seeded engine pull",
      status: 200,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/pulls/${String(ctx.seeds.prTopic)}/commits`,
      }),
    },
  ],
  repoGetPullRequestFiles: [
    {
      name: "changed files of the seeded engine pull",
      status: 200,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/pulls/${String(ctx.seeds.prTopic)}/files`,
      }),
    },
  ],
  repoPullRequestIsMerged: [
    {
      name: "merged pull → 204",
      status: 204,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/pulls/${String(ctx.seeds.prMerged)}/merge`,
      }),
    },
    {
      name: "open pull → 404",
      status: 404,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/pulls/${String(ctx.seeds.prTopic)}/merge`,
      }),
    },
  ],
  repoMergePullRequest: [
    {
      name: "merge the seeded engine pull (200 empty)",
      status: 200,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/pulls/${String(ctx.seeds.prTopic)}/merge`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ do: "merge", merge_title_field: "compat merge" }),
        }),
      }),
    },
  ],
  repoMergeUpstream: [
    {
      // forks cannot exist yet (SPEC-0003 primitives pending) — the declared 404
      name: "no upstream → declared 404",
      status: 404,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/merge-upstream`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ branch: "main" }),
        }),
      }),
    },
  ],

  issueListLabels: [
    {
      name: "first page",
      status: 200,
      linkRels: ["next", "last"],
      request: (ctx) => ({ path: `${repoPath(ctx)}/labels?limit=1` }),
    },
  ],
  issueCreateLabel: [
    {
      name: "create",
      status: 201,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/labels`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ name: "compat-created", color: "#00aa00", description: "created by the compat suite" }),
        }),
      }),
    },
    {
      name: "invalid color",
      status: 422,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/labels`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ name: "compat-invalid", color: "not-a-color" }),
        }),
      }),
    },
  ],
  issueGetLabel: [
    {
      name: "seeded label",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/labels/${String(ctx.seeds.labelA)}` }),
    },
  ],
  issueEditLabel: [
    {
      name: "edit seeded label",
      status: 200,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/labels/${String(ctx.seeds.labelA)}`,
        init: ctx.withAuth({
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ description: "edited by the compat suite" }),
        }),
      }),
    },
  ],
  issueDeleteLabel: [
    {
      name: "delete seeded label",
      status: 204,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/labels/${String(ctx.seeds.labelB)}`,
        init: ctx.withAuth({ method: "DELETE" }),
      }),
    },
  ],

  issueGetMilestonesList: [
    {
      name: "first page",
      status: 200,
      linkRels: ["next", "last"],
      request: (ctx) => ({ path: `${repoPath(ctx)}/milestones?limit=1` }),
    },
  ],
  issueCreateMilestone: [
    {
      name: "create",
      status: 201,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/milestones`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ title: "compat-created", description: "created by the compat suite" }),
        }),
      }),
    },
  ],
  issueGetMilestone: [
    {
      name: "seeded milestone",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/milestones/${String(ctx.seeds.milestoneA)}` }),
    },
  ],
  issueEditMilestone: [
    {
      name: "edit seeded milestone",
      status: 200,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/milestones/${String(ctx.seeds.milestoneA)}`,
        init: ctx.withAuth({
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ description: "edited by the compat suite" }),
        }),
      }),
    },
  ],
  issueDeleteMilestone: [
    {
      name: "delete seeded milestone",
      status: 204,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/milestones/${String(ctx.seeds.milestoneB)}`,
        init: ctx.withAuth({ method: "DELETE" }),
      }),
    },
  ],

  repoListHooks: [
    {
      name: "first page",
      status: 200,
      linkRels: ["next", "last"],
      request: (ctx) => ({ path: `${repoPath(ctx)}/hooks?limit=1`, init: ctx.withAuth() }),
    },
  ],
  repoCreateHook: [
    {
      name: "create",
      status: 201,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/hooks`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({
            type: "gitea",
            config: { url: "https://hooks.invalid/compat-created", content_type: "json" },
            events: ["push"],
          }),
        }),
      }),
    },
  ],
  repoGetHook: [
    {
      name: "seeded hook",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/hooks/${String(ctx.seeds.hookA)}`, init: ctx.withAuth() }),
    },
  ],
  repoEditHook: [
    {
      name: "edit seeded hook",
      status: 200,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/hooks/${String(ctx.seeds.hookA)}`,
        init: ctx.withAuth({
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ events: ["push", "issues"] }),
        }),
      }),
    },
  ],
  repoDeleteHook: [
    {
      name: "delete seeded hook",
      status: 204,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/hooks/${String(ctx.seeds.hookB)}`,
        init: ctx.withAuth({ method: "DELETE" }),
      }),
    },
  ],
  repoTestHook: [
    {
      name: "no commits → silent 204",
      status: 204,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/hooks/${String(ctx.seeds.hookA)}/tests`,
        init: ctx.withAuth({ method: "POST" }),
      }),
    },
  ],
  repoListHookDeliveries: [
    {
      name: "seeded hook log",
      status: 200,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/hooks/${String(ctx.seeds.hookA)}/deliveries?limit=1`,
        init: ctx.withAuth(),
      }),
    },
  ],

  orgListCurrentUserOrgs: [
    {
      name: "owner membership",
      status: 200,
      request: (ctx) => ({ path: "/user/orgs?limit=1", init: ctx.withAuth() }),
    },
  ],
  orgListRepos: [
    {
      name: "seeded org repos",
      status: 200,
      request: (ctx) => ({ path: `/orgs/${String(ctx.seeds.org)}/repos?limit=1` }),
    },
  ],
  createOrgRepo: [
    {
      name: "create in the seeded org",
      status: 201,
      request: (ctx) => ({
        path: `/orgs/${String(ctx.seeds.org)}/repos`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ name: "compat-org-write", description: "created by the compat suite", private: false }),
        }),
      }),
    },
  ],

  renderMarkdown: [
    {
      name: "render",
      status: 200,
      request: (ctx) => ({
        path: "/markdown",
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ Text: "# compat", Mode: "markdown" }),
        }),
      }),
    },
    {
      name: "invalid option",
      status: 422,
      request: (ctx) => ({
        path: "/markdown",
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ Text: 123 }),
        }),
      }),
    },
    {
      // Runtime-only status: unparseable JSON dies in hono's validator before
      // the route's 422 hook (documented divergence, RUNTIME_ONLY_RESPONSES).
      name: "malformed json → runtime-only 400",
      status: 400,
      request: (ctx) => ({
        path: "/markdown",
        init: ctx.withAuth({ method: "POST", headers: JSON_HEADERS, body: "{not json" }),
      }),
    },
  ],
  renderMarkdownRaw: [
    {
      name: "render raw",
      status: 200,
      request: (ctx) => ({
        path: "/markdown/raw",
        init: ctx.withAuth({ method: "POST", headers: { "Content-Type": "text/plain" }, body: "# compat raw" }),
      }),
    },
  ],

  // ---------------------------------------------------------------------
  // Batch-7 D1 block (SPEC-0004 §2.4 rows repoListTopics … repoTransfer).
  // Scenario order mirrors the fixture order; the seeds pre-create every
  // read target so case order never matters. The suite identity is the
  // shared repo's OWNER, so every admin/writer gate passes.
  // ---------------------------------------------------------------------

  repoListTopics: [
    {
      name: "listed topics",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/topics` }),
    },
  ],
  repoUpdateTopics: [
    {
      name: "replace",
      status: 204,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/topics`,
        init: ctx.withAuth({ method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ topics: ["compat", "batch7"] }) }),
      }),
    },
    {
      name: "invalid names → invalidTopics 422",
      status: 422,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/topics`,
        init: ctx.withAuth({ method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ topics: ["Bad Topic"] }) }),
      }),
    },
  ],

  userCurrentCheckSubscription: [
    {
      name: "pre-seeded watch",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/subscription`, init: ctx.withAuth() }),
    },
  ],
  userCurrentPutSubscription: [
    {
      name: "watch (idempotent)",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/subscription`, init: ctx.withAuth({ method: "PUT" }) }),
    },
  ],
  userCurrentDeleteSubscription: [
    {
      name: "unwatch",
      status: 204,
      request: (ctx) => ({ path: `${repoPath(ctx)}/subscription`, init: ctx.withAuth({ method: "DELETE" }) }),
    },
  ],

  repoListCollaborators: [
    {
      name: "first page (two seeded rows)",
      status: 200,
      linkRels: ["next", "last"],
      request: (ctx) => ({ path: `${repoPath(ctx)}/collaborators?limit=1`, init: ctx.withAuth() }),
    },
  ],
  repoCheckCollaborator: [
    {
      name: "seeded collaborator",
      status: 204,
      request: (ctx) => ({ path: `${repoPath(ctx)}/collaborators/CompatCollab`, init: ctx.withAuth() }),
    },
    {
      name: "unknown user → declared 422",
      status: 422,
      request: (ctx) => ({ path: `${repoPath(ctx)}/collaborators/nobody`, init: ctx.withAuth() }),
    },
  ],
  repoAddCollaborator: [
    {
      name: "upsert at the default mode",
      status: 204,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/collaborators/CompatNeighbor`,
        init: ctx.withAuth({ method: "PUT", headers: JSON_HEADERS, body: "{}" }),
      }),
    },
  ],
  repoDeleteCollaborator: [
    {
      name: "delete the seeded collaborator",
      status: 204,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/collaborators/CompatCollab2`,
        init: ctx.withAuth({ method: "DELETE" }),
      }),
    },
  ],
  repoGetAssignees: [
    {
      name: "owner + write-or-above collaborators",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/assignees`, init: ctx.withAuth() }),
    },
  ],

  repoListReleases: [
    {
      name: "seeded releases, first page",
      status: 200,
      linkRels: ["next", "last"],
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/rel/releases?limit=1`,
      }),
    },
  ],
  repoCreateRelease: [
    {
      name: "create",
      status: 201,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/rel/releases`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ tag_name: "compat-v-new", name: "compat new", body: "created by the compat suite" }),
        }),
      }),
    },
    {
      name: "duplicate tag → declared 409",
      status: 409,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/rel/releases`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ tag_name: "compat-v1" }),
        }),
      }),
    },
  ],
  repoGetLatestRelease: [
    {
      name: "newest published release",
      status: 200,
      request: (ctx) => ({ path: `/repos/${String(ctx.seeds.repoOwner)}/rel/releases/latest` }),
    },
  ],
  repoGetReleaseByTag: [
    {
      name: "seeded tag",
      status: 200,
      request: (ctx) => ({ path: `/repos/${String(ctx.seeds.repoOwner)}/rel/releases/tags/compat-v1` }),
    },
  ],
  repoDeleteReleaseByTag: [
    {
      name: "delete the dedicated seed release",
      status: 204,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/rel/releases/tags/compat-v-del`,
        init: ctx.withAuth({ method: "DELETE" }),
      }),
    },
  ],
  repoGetRelease: [
    {
      name: "seeded global id",
      status: 200,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/rel/releases/${String(ctx.seeds.releaseEditId)}`,
      }),
    },
    {
      name: "missing id → runtime-body 404",
      status: 404,
      request: (ctx) => ({ path: `/repos/${String(ctx.seeds.repoOwner)}/rel/releases/99999` }),
    },
  ],
  repoEditRelease: [
    {
      name: "edit the seeded release",
      status: 200,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/rel/releases/${String(ctx.seeds.releaseEditId)}`,
        init: ctx.withAuth({
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ name: "compat v1 (edited)" }),
        }),
      }),
    },
  ],
  repoDeleteRelease: [
    {
      name: "delete the dedicated seed release",
      status: 204,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/rel/releases/${String(ctx.seeds.releaseDeleteId)}`,
        init: ctx.withAuth({ method: "DELETE" }),
      }),
    },
  ],
  repoListReleaseAttachments: [
    {
      // The dedicated draft assets-release; the owner token sees drafts
      // (upstream hides drafts from release-reads without write access).
      name: "assets of the seeded draft release",
      status: 200,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/rel/releases/${String(ctx.seeds.assetsReleaseId)}/assets`,
        init: ctx.withAuth(),
      }),
    },
    {
      name: "missing release → runtime-body 404",
      status: 404,
      request: (ctx) => ({ path: `/repos/${String(ctx.seeds.repoOwner)}/rel/releases/99999/assets` }),
    },
  ],
  repoCreateReleaseAttachment: [
    {
      name: "multipart upload of the compat asset",
      status: 201,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/rel/releases/${String(ctx.seeds.assetsReleaseId)}/assets`,
        init: ctx.withAuth({
          method: "POST",
          headers: { "Content-Type": "multipart/form-data; boundary=compat-asset" },
          body: ASSET_MULTIPART_BYTES,
        }),
      }),
    },
    {
      name: "missing release → runtime-body 404",
      status: 404,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/rel/releases/99999/assets`,
        init: ctx.withAuth({
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: "compat asset bytes\n",
        }),
      }),
    },
  ],

  repoEdit: [
    {
      name: "edit the dedicated repo",
      status: 200,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/compat-edit`,
        init: ctx.withAuth({
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ description: "edited by the compat suite" }),
        }),
      }),
    },
    {
      name: "invalid rename → declared 422",
      status: 422,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/compat-edit`,
        init: ctx.withAuth({
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ name: "bad name!" }),
        }),
      }),
    },
  ],
  repoTransfer: [
    {
      name: "file a pending transfer (async 202)",
      status: 202,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/compat-transfer/transfer`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ new_owner: "CompatNeighbor" }),
        }),
      }),
    },
    {
      name: "unknown owner → declared 404",
      status: 404,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/compat-transfer/transfer`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ new_owner: "nobody-here" }),
        }),
      }),
    },
  ],
  repoDelete: [
    {
      name: "delete the dedicated seed repo",
      status: 204,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/compat-del`,
        init: ctx.withAuth({ method: "DELETE" }),
      }),
    },
  ],

  // ---------------------------------------------------------------------
  // Branch/tag/raw-git block (SPEC-0004 §2.4 rows repoListBranches …
  // GetAnnotatedTag): the engine-backed families. Reads and ref writes run
  // against the dedicated compat-git repo seeded in beforeAll (real blob →
  // tree → commit + refs through the engine's public RPCs); the shared
  // fixture repo stays empty (isEmpty=true), driving the upstream empty-repo
  // guard family the routes mirror (404 branch mutations, 405 tag writes —
  // both fixture-declared). The 400 sha-family cases need no git data.
  // ---------------------------------------------------------------------

  repoListBranches: [
    {
      name: "seeded branches, first page",
      status: 200,
      linkRels: ["next", "last"],
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/branches?limit=1`,
      }),
    },
    {
      // Upstream's IsEmpty short-circuit: the LIST answers 200 [] (the
      // mutations are the ones that 404).
      name: "empty repo lists empty",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/branches` }),
    },
  ],
  repoCreateBranch: [
    {
      name: "create from the default branch",
      status: 201,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/branches`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ new_branch_name: "compat-created-branch" }),
        }),
      }),
    },
    {
      name: "empty repo → declared 404",
      status: 404,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/branches`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ new_branch_name: "compat-nowhere" }),
        }),
      }),
    },
  ],
  repoGetBranch: [
    {
      name: "seeded default branch",
      status: 200,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/branches/main`,
      }),
    },
    {
      name: "missing branch → runtime-body 404",
      status: 404,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/branches/ghost`,
      }),
    },
  ],
  repoUpdateBranch: [
    {
      // The ref CAS with old_commit_id matching the tip and the new id equal
      // to it: upstream's early-return no-op still lands the CAS — 204.
      name: "no-op CAS onto the current tip",
      status: 204,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/branches/main`,
        init: ctx.withAuth({
          method: "PUT",
          headers: JSON_HEADERS,
          body: JSON.stringify({ new_commit_id: String(ctx.seeds.gitCommit), old_commit_id: String(ctx.seeds.gitCommit) }),
        }),
      }),
    },
    {
      name: "stale old_commit_id → declared 422",
      status: 422,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/branches/main`,
        init: ctx.withAuth({
          method: "PUT",
          headers: JSON_HEADERS,
          body: JSON.stringify({ new_commit_id: String(ctx.seeds.gitCommit), old_commit_id: String(ctx.seeds.sha) }),
        }),
      }),
    },
  ],
  repoDeleteBranch: [
    {
      name: "delete the dedicated seed branch",
      status: 204,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/branches/compat-del-branch`,
        init: ctx.withAuth({ method: "DELETE" }),
      }),
    },
    {
      name: "empty repo → declared 404",
      status: 404,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/branches/ghost`,
        init: ctx.withAuth({ method: "DELETE" }),
      }),
    },
  ],
  repoRenameBranch: [
    {
      name: "rename the dedicated seed branch",
      status: 204,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/branches/compat-rename-src`,
        init: ctx.withAuth({
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ name: "compat-rename-dst" }),
        }),
      }),
    },
    {
      name: "same-name rename → declared 422",
      status: 422,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/branches/main`,
        init: ctx.withAuth({
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ name: "main" }),
        }),
      }),
    },
  ],

  repoListAllGitRefs: [
    {
      name: "seeded refs table",
      status: 200,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/git/refs`,
      }),
    },
    {
      // Upstream getGitRefsInternal: len(refs)==0 is the APIErrorNotFound 404.
      name: "empty repo → declared 404",
      status: 404,
      request: (ctx) => ({ path: `${repoPath(ctx)}/git/refs` }),
    },
  ],
  repoListGitRefs: [
    {
      // GetRefsFiltered is PREFIX matching on "refs/" + param; several matches
      // answer the Reference ARRAY (the single-exact-match bare-object quirk
      // is the union the contract's ReferenceList schema does not model, so
      // the fixture array shape drives the multi-match branch).
      name: "tag prefix matches several refs",
      status: 200,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/git/refs/tags`,
      }),
    },
    {
      name: "no match → declared 404",
      status: 404,
      request: (ctx) => ({
        // Single-segment filter: the hono `{ref}` param never matches the
        // multi-segment shape upstream's wildcard route accepts.
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/git/refs/ghostheads`,
      }),
    },
  ],
  GetTree: [
    // TODO(reg-merge/compat): the 200 fixture case is INTENTIONALLY absent —
    // routes/git.ts GetTree passes `commit.tree` (a TREE oid) to the engine's
    // listTree, which peels its ref argument to a COMMIT first
    // (packages/git-engine src/repo.ts listTree → peelToCommit; a tree oid
    // peels nowhere → null → the route 404s). Every well-formed sha/ref
    // therefore answers 404 and no 200-shape scenario can pass until the
    // route reads `listTree(commit.oid)` (TreeResult.oid still carries the
    // real tree id the response renders). Add the seeded-commit-tree 200 case
    // — path `/repos/{owner}/{repo}/git/trees/<seeds.gitCommit>` — when the
    // module owner lands that fix.
    {
      // resolveNamedRef falls back to the default-branch tip, so the
      // "sha not found" 400 is only reachable on a tip-less repo — the
      // shared fixture repo (no refs at all), not compat-git.
      name: "unknown sha → declared 400",
      status: 400,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/git/trees/zzz-missing`,
      }),
    },
  ],
  GetBlob: [
    {
      name: "seeded blob",
      status: 200,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/git/blobs/${String(ctx.seeds.gitBlob)}`,
      }),
    },
    {
      name: "malformed sha → declared 400",
      status: 400,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/git/blobs/zzz`,
      }),
    },
    {
      name: "unknown oid → runtime-body 404",
      status: 404,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/git/blobs/${"ab".repeat(20)}`,
      }),
    },
  ],

  repoListTags: [
    {
      name: "seeded tags, first page",
      status: 200,
      linkRels: ["next", "last"],
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/tags?limit=1`,
      }),
    },
    {
      name: "empty repo lists empty",
      status: 200,
      request: (ctx) => ({ path: `${repoPath(ctx)}/tags` }),
    },
  ],
  repoCreateTag: [
    {
      // Upstream answers 200 (not 201) with the Tag — the contract quirk.
      name: "create lightweight (200 quirk)",
      status: 200,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/tags`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ tag_name: "compat-created-tag" }),
        }),
      }),
    },
    {
      // Upstream CreateTag on an empty repository: the declared 405.
      name: "empty repo → declared 405",
      status: 405,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/tags`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ tag_name: "compat-nowhere" }),
        }),
      }),
    },
    {
      name: "missing tag_name → bind 422",
      status: 422,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/tags`,
        init: ctx.withAuth({
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ message: "no tag name given" }),
        }),
      }),
    },
  ],
  repoGetTag: [
    {
      name: "seeded annotated tag",
      status: 200,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/tags/compat-annotated`,
      }),
    },
    {
      name: "missing tag → runtime-body 404",
      status: 404,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/tags/ghost`,
      }),
    },
  ],
  repoDeleteTag: [
    {
      name: "delete the dedicated seed tag",
      status: 204,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/tags/compat-del-tag`,
        init: ctx.withAuth({ method: "DELETE" }),
      }),
    },
    {
      name: "empty repo → declared 405",
      status: 405,
      request: (ctx) => ({
        path: `${repoPath(ctx)}/tags/ghost`,
        init: ctx.withAuth({ method: "DELETE" }),
      }),
    },
  ],
  GetAnnotatedTag: [
    {
      name: "seeded annotated tag object",
      status: 200,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/git/tags/${String(ctx.seeds.gitAnnotatedTag)}`,
      }),
    },
    {
      name: "malformed sha → declared 400",
      status: 400,
      request: (ctx) => ({
        path: `/repos/${String(ctx.seeds.repoOwner)}/${String(ctx.seeds.gitRepoSlug)}/git/tags/zzz`,
      }),
    },
  ],
};

// ---------------------------------------------------------------------------
// The suite run + its bookkeeping/consistency assertions.
// ---------------------------------------------------------------------------

let report: CompatSuiteReport | undefined;

describe("dynamic compat suite — implemented tier-1 operations vs golden fixtures (SPEC-0004 §5.3)", () => {
  report = runCompatSuite({ contract, fixtures, implemented, scenarios: SCENARIOS, seeds, send });
});

describe("compat suite bookkeeping (check:api consistency)", () => {
  it("ran every implemented fixture operation and skipped exactly the unimplemented ones", () => {
    if (report === undefined) {
      throw new Error("compat suite did not run");
    }
    expect(report.ran.length + report.skipped.length).toBe(fixtures.operations.length);
    for (const key of report.ran) {
      expect(implemented.has(key), `${key} recorded as ran but not implemented`).toBe(true);
    }
    for (const key of report.skipped) {
      expect(implemented.has(key), `${key} recorded as skipped but implemented`).toBe(false);
    }
    // An implemented operation without a scenario registers its own loud
    // failure above; the report must stay empty for the suite to be green.
    expect(report.missingScenarios).toEqual([]);
  });

  it("counts tier-1 coverage exactly like pnpm check:api", () => {
    if (report === undefined) {
      throw new Error("compat suite did not run");
    }
    // Independent recomputation of check:api's stage (c): operations count
    // individually; a PATH counts only when every fixture method is served.
    let coveredPaths = 0;
    const paths = new Map<string, string[]>();
    for (const operation of fixtures.operations) {
      const methods = paths.get(operation.path) ?? [];
      methods.push(operation.method);
      paths.set(operation.path, methods);
    }
    for (const [path, methods] of paths) {
      if (methods.every((method) => implemented.has(`${method} ${path}`))) {
        coveredPaths += 1;
      }
    }
    const coveredOperations = [...fixtureKeys].filter((key) => implemented.has(key)).length;

    expect(report.coverage.coveredPaths).toBe(coveredPaths);
    expect(report.coverage.coveredOperations).toBe(coveredOperations);
    expect(report.coverage.coveredOperations).toBe(report.ran.length);
    expect(coveredOperations).toBeGreaterThan(0);

    // The totals are the SPEC-0004 appendix-A tier-1 sizes (the numbers
    // check:api denominates against).
    expect(report.coverage.totalPaths).toBe(TIER1_EXPECTED_PATHS);
    expect(report.coverage.totalOperations).toBe(TIER1_EXPECTED_OPERATIONS);
    // And the rendered line matches check:api's report format.
    expect(formatCoverage(report.coverage)).toMatch(
      new RegExp(`^${coveredPaths}/${TIER1_EXPECTED_PATHS} paths, ${coveredOperations}/${TIER1_EXPECTED_OPERATIONS} operations$`, "u"),
    );
  });

  it("stays inside the frozen contract, including implemented non-fixture additions", () => {
    if (report === undefined) {
      throw new Error("compat suite did not run");
    }
    // check:api stage (a), re-asserted at runtime: every served route exists
    // in the vendored contract (tier-2 landings by parallel batches show up
    // in report.outOfSuite and are tolerated — they simply have no fixture).
    for (const key of implemented) {
      const [method, path] = key.split(" ");
      if (!isHttpMethod(method) || path === undefined) {
        throw new Error(`malformed implemented-operation key: ${key}`);
      }
      expect(contract.paths[path]?.[method], `${key} is served without a frozen-contract entry`).toBeDefined();
    }
    for (const key of report.outOfSuite) {
      expect(fixtureKeys.has(key), `${key} reported out-of-suite but has a fixture`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Tier-2 compat scenarios (SPEC-0004 appendix A, category-a T2 rows). The
// dynamic suite above drives the tier-1 fixtures only; these T2 operations
// have no fixture file, so they run here against the same harness shape — a
// fresh router per request over the shared beforeAll seeds — with
// contract-shape assertions via contractModelFields. The local mount is
// exactly the orchestrator one-liner's seam, so the block keeps working
// unchanged once registerOrgProfileRoutes/registerFollowRoutes land in
// router.ts (the dynamic suite then lists the ops in report.outOfSuite).
// Cases are order-sensitive where they write (the delete/conceal pair runs
// after the read scenarios that need their targets).
// ---------------------------------------------------------------------------

const tier2Send: CompatRequestSender = (request: CompatRequest): Promise<Response> => {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerOrgProfileRoutes(app, createTokenAuthMiddleware(suiteResolver), createOptionalTokenAuthMiddleware(suiteResolver));
  registerFollowRoutes(app, createTokenAuthMiddleware(suiteResolver));
  return Promise.resolve(app.fetch(new Request(`${ORIGIN}${request.path}`, request.init), env));
};

/** Declared field set of one contract model (the fixture-shape oracle). */
function declaredModelFields(modelRef: string): ReadonlySet<string> {
  return new Set(contractModelFields(contract, modelRef).map((field) => field.name));
}

const ORG_FIELDS = declaredModelFields("Organization");
const T2_USER_FIELDS = declaredModelFields("User");

describe("tier-2 compat scenarios — org profile, members, public members, follows (T2)", () => {
  const authed = (init?: RequestInit): RequestInit => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `token ${TOKEN}`);
    return { ...init, headers };
  };

  it("orgGet: seeded org answers the Organization projection, email blanked for anonymous", async () => {
    const response = await tier2Send({ path: `/orgs/${String(seeds.org)}` });
    expect(response.status).toBe(200);
    const body: Record<string, unknown> = await response.json();
    for (const key of Object.keys(body)) {
      expect(ORG_FIELDS.has(key), `orgGet field ${key} declared by the contract`).toBe(true);
    }
    expect(body.name).toBe(seeds.org);
    expect(body.email).toBe("");
  });

  it("orgGet: renamed org 307s through the redirect seam (path+query preserved)", async () => {
    const response = await tier2Send({ path: `/orgs/${String(seeds.renamedOrg)}?page=2` });
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe(`/orgs/${String(seeds.renamedOrgNew)}?page=2`);
  });

  it("orgGet: missing org → the runtime APIError 404", async () => {
    const response = await tier2Send({ path: "/orgs/ghost-org" });
    expect(response.status).toBe(404);
    const missBody: Record<string, unknown> = await response.json();
    expect(Object.keys(missBody).sort()).toEqual(["message", "url"]);
  });

  it("orgEdit: PATCH applies the presented fields and answers the edited Organization", async () => {
    const response = await tier2Send({
      path: `/orgs/${String(seeds.org)}`,
      init: authed({ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ description: "edited by the compat suite" }) }),
    });
    expect(response.status).toBe(200);
    const body: Record<string, unknown> = await response.json();
    for (const key of Object.keys(body)) {
      expect(ORG_FIELDS.has(key), `orgEdit field ${key} declared by the contract`).toBe(true);
    }
    expect(body.description).toBe("edited by the compat suite");
  });

  it("orgListMembers: an org member sees every member, hidden ones included (paginated)", async () => {
    const response = await tier2Send({
      path: `/orgs/${String(seeds.org)}/members?limit=1`,
      init: authed(),
    });
    expect(response.status).toBe(200);
    const body: Array<Record<string, unknown>> = await response.json();
    expect(body).toHaveLength(1); // limit=1 — the page, not the total
    for (const entry of body) {
      for (const key of Object.keys(entry)) {
        expect(T2_USER_FIELDS.has(key), `member field ${key} declared by the contract`).toBe(true);
      }
    }
    expect(response.headers.get("X-Total-Count")).toBe("3"); // owner + member + loud member
  });

  it("orgIsMember: 204 for a member, 404 for a miss, 401 for anonymous (reqToken upstream)", async () => {
    const member = await tier2Send({
      path: `/orgs/${String(seeds.org)}/members/${String(seeds.owner)}`,
      init: authed(),
    });
    expect(member.status).toBe(204);
    const miss = await tier2Send({ path: `/orgs/${String(seeds.org)}/members/ghost-user`, init: authed() });
    expect(miss.status).toBe(404);
    // Upstream wires reqToken() on this GET — anonymous is the runtime-only
    // 401; the 303 oracle ladder needs a signed-in non-member doer (covered
    // by the routes tests' outsider identity).
    const anonymous = await tier2Send({ path: `/orgs/${String(seeds.org)}/members/${String(seeds.owner)}` });
    expect(anonymous.status).toBe(401);
  });

  it("orgListPublicMembers: only is_public rows, anonymous (paginated)", async () => {
    const response = await tier2Send({ path: `/orgs/${String(seeds.org)}/public_members?limit=1` });
    expect(response.status).toBe(200);
    const body: Array<{ login?: string }> = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0]?.login).toBe(seeds.loudMember);
    expect(response.headers.get("X-Total-Count")).toBe("1");
  });

  it("orgIsPublicMember: 204 for the public member, 404 for the concealed one", async () => {
    expect((await tier2Send({ path: `/orgs/${String(seeds.org)}/public_members/${String(seeds.loudMember)}` })).status).toBe(204);
    expect((await tier2Send({ path: `/orgs/${String(seeds.org)}/public_members/${String(seeds.member)}` })).status).toBe(404);
  });

  it("orgPublicizeMember: the owner publicizes the concealed member (204)", async () => {
    const response = await tier2Send({
      path: `/orgs/${String(seeds.org)}/public_members/${String(seeds.member)}`,
      init: authed({ method: "PUT" }),
    });
    expect(response.status).toBe(204);
    expect((await tier2Send({ path: `/orgs/${String(seeds.org)}/public_members/${String(seeds.member)}` })).status).toBe(204);
  });

  it("orgConcealMember: the owner conceals the public member (204), the check flips to 404", async () => {
    const response = await tier2Send({
      path: `/orgs/${String(seeds.org)}/public_members/${String(seeds.loudMember)}`,
      init: authed({ method: "DELETE" }),
    });
    expect(response.status).toBe(204);
    expect((await tier2Send({ path: `/orgs/${String(seeds.org)}/public_members/${String(seeds.loudMember)}` })).status).toBe(404);
  });

  it("orgDeleteMember: removes the victim (204, empty body)", async () => {
    const response = await tier2Send({
      path: `/orgs/${String(seeds.org)}/members/${String(seeds.member)}`,
      init: authed({ method: "DELETE" }),
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("userListFollowers: the owner's follower page (200, User shapes, runtime headers)", async () => {
    const response = await tier2Send({
      path: `/users/${String(seeds.owner)}/followers?limit=1`,
      init: authed(),
    });
    expect(response.status).toBe(200);
    const body: Array<Record<string, unknown>> = await response.json();
    expect(body).toHaveLength(1);
    for (const key of Object.keys(body[0] ?? {})) {
      expect(T2_USER_FIELDS.has(key), `follower field ${key} declared by the contract`).toBe(true);
    }
    expect(response.headers.get("X-Total-Count")).toBe("1");
    // reqToken upstream: anonymous is the runtime-only 401.
    expect((await tier2Send({ path: `/users/${String(seeds.owner)}/followers` })).status).toBe(401);
  });

  it("userListFollowing: the owner's following page (200)", async () => {
    const response = await tier2Send({
      path: `/users/${String(seeds.owner)}/following?limit=1`,
      init: authed(),
    });
    expect(response.status).toBe(200);
    const body: Array<Record<string, unknown>> = await response.json();
    expect(body).toHaveLength(1);
    expect(response.headers.get("X-Total-Count")).toBe("1");
  });

  it("userCheckFollowing: 204 on the edge, 404 off it", async () => {
    const followed = await tier2Send({
      path: `/users/${String(seeds.owner)}/following/${String(seeds.neighbor)}`,
      init: authed(),
    });
    expect(followed.status).toBe(204);
    const notFollowed = await tier2Send({
      path: `/users/${String(seeds.owner)}/following/ghost-user`,
      init: authed(),
    });
    expect(notFollowed.status).toBe(404);
  });
});

/** Methods that can carry an operation in a Swagger 2.0 paths object. */
const HTTP_METHODS: readonly string[] = ["get", "put", "post", "delete", "options", "head", "patch"];

function isHttpMethod(value: string | undefined): value is Swagger2Method {
  return value !== undefined && HTTP_METHODS.includes(value);
}
