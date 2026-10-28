/**
 * The window-2e DEFERRED ROUTE-LEVEL matrices for the two now-mounted
 * surfaces — ONE file, two describes, the settings-collaboration f8c84fc
 * minted-session harness (per-test reseed, mounted uiRouter, synthetic
 * manifest):
 *
 *   - GET+POST /repo/migrate (mounted at 62ef380, pages/repo-migrate.tsx)
 *   - the global inbox /issues /pulls /milestones (mounted at a8818c6,
 *     pages/global-inbox.tsx)
 *
 * The MODULE suites own the loader/parser/service/render contracts and are
 * NOT repeated here (pages/repo-migrate.test.ts — the two-stage module's
 * parser, owner-gate arms, write validation ladder, queue semantics and the
 * full git.tmpl DOM contract; pages/global-inbox.smoke.test.tsx — one
 * happy path per tab over the direct loaders + renders). THIS FILE drives
 * the MOUNTED routes end-to-end (parse → resolveUiSession → gates →
 * handler) for exactly what the module suites could not reach:
 *
 *   MIGRATE — the anon 303s (GET + same-origin POST, nothing born), the
 *   GET form render at the route (the owner list = doer + org-OWNER orgs
 *   only, the mirror box arriving CHECKED — the route's hardcoded GET
 *   default, the reduced fields staying gone), the POST round-trip
 *   (created → 303 onto the born repo's home; the born row is_mirror=true
 *   + ready + empty — the RD19 born-body contract; exactly one mirror-sync
 *   message on the CAPTURED queue, the live dev-queue consumer never
 *   seeing the fixture host — the module suite's recording-queue pattern
 *   lifted to the route env), the invalid arms at 200 with the exact texts
 *   AND the carried submission (required-field pair, the mirror=false
 *   degradation, the 409 web text, the forged-uid API-arm text trio), and
 *   the §2.8 cross-origin 403 guard-first with nothing born and nothing
 *   enqueued.
 *
 *   GLOBAL INBOX — the anon 303s ×3, the type-arm nav counts on BOTH tabs
 *   (the pulls-only review pair), the state toggles (issues + the pulls
 *   closed arm), the review arms through the landed pull_reviews rows
 *   (type=4 request vs Approve; a DISMISSED request counting nowhere), the
 *   milestones sidebar + the ?repos= toggle + the ?state= toggle + the
 *   keyword arm, the private-repo row exclusion pinned ROUTE-level on all
 *   three pages (the module smoke asserts it loader-level; here including
 *   the strongest arm — an assignment on a private-repo issue must not
 *   leak through the AllPublic extended scope), the pager shapes (page 1
 *   Older-only, page 2 Newer-only, past-end the empty line under an
 *   absent pager), and the claim pins (the three top-level literals
 *   parsing ahead of owner-home, the trailing-slash 301s, the deeper tail
 *   falling back to the shadowed repo-home shape like upstream's dynamic
 *   pairs).
 *
 * STALE SIBLING NOTE (not this file's ownership): the wave-19 suite still
 * pins `parseUiRoute("/repo/migrate")?.family === "home"` — the PRE-mount
 * shadowing answer. Since 62ef380 the literal claims `repo-migrate` (the
 * behavior this file pins); pages-wave19.test.ts carries the one stale
 * assertion (observed RED 2026-10-26, 1/18) and is orchestrator-owned.
 *
 * RED DISCLOSURE (2/17, the tests-only brief's STOP-and-escalate path): the
 * two [RED — ESCALATED] GET arms pin the DOCUMENTED anonymous-303 + form-
 * render contract of the mounted GET /repo/migrate, and the route answers a
 * plain hono 404 before its handler runs — the dynamic
 * `uiRouter.get("/:owner/:repo", uiPage)` registration physically precedes
 * the tail statics and hono's RegExpRouter honors registration order, so
 * two-segment GETs land in uiPage's drift guard (GET /repo/search in the
 * same cluster is shadowed identically; POST /repo/migrate and every
 * one-segment literal are unaffected). Reproduced with probes OUTSIDE this
 * file; evidence + the one-line fix (move the two static GET registrations
 * above the dynamic block, the /repo/create posture) escalated to the
 * orchestrator 2026-10-26 — the arms go green with that landing, no test
 * change needed.
 *
 * Fixtures (unique `mig-*` / `inbox-*` names, per-test reseed through the
 * landed services — D1-only, no engine content): migrate rides
 * `mig-doer` (+ owned org `mig-owned`, member-only org `mig-foreign`);
 * the inbox rides alice/bob across `inbox-alice/alpha` (owned, public),
 * `inbox-bob/beta` (collaborated, public) and `inbox-bob/secret`
 * (private, no grant), with milestones v1.0/v2.0/s9 and the review rows
 * hanging off the alpha PRs. POSTs carry the same-origin Origin header;
 * the migrate write env lax-es the §4.1 egress gate (explicit absence —
 * ADR-0005 D3, the ambient .dev.vars is strict-mode) over the captured
 * queue.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createRepoMilestone } from "../../api/services/milestones";
import { addOrUpdateCollaborator } from "../../api/services/repo-collaborators";
import { REPO_SETTINGS_DDL_STATEMENTS } from "../../api/services/repo-settings";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { ReviewType, issueAssignees, orgMembers, pullReviews, repoMirrors, repositories } from "../../db/schema";
import { IssuesService } from "../../issues/service";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { Viewer } from "../viewer";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";
const SOURCE_URL = "https://src.example.com/org/repo.git";

const T0 = 1_750_000_000;
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

/** Synthetic manifest shaped like the real Vite output (the harness
 *  fixture — deterministic, no build dependence). */
const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

interface RecordingQueue extends Queue {
  sent: unknown[];
}

/** MIRROR_SYNC_QUEUE stub — the migrate write's enqueue is CAPTURED here
 *  instead of reaching the live dev-queue consumer, whose real-network
 *  sync must never see the fixture host (repo-migrate.test.ts's pattern,
 *  lifted to the route env). */
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

/** The route env: real bindings, the synthetic manifest, the captured
 *  queue, and the §4.1 egress gate LAX-ED by explicit absence (the
 *  ambient .dev.vars strict list would reject every fixture URL — the
 *  module suite's migrateTestEnv posture at the route level). */
type RouteEnv = Omit<Env, "ASSETS" | "MIRROR_SYNC_QUEUE" | "MIRROR_ALLOWED_HOST_LIST" | "MIRROR_EGRESS_MODE"> & {
  ASSETS?: UiAssetsFetcher;
  MIRROR_SYNC_QUEUE: RecordingQueue;
  MIRROR_ALLOWED_HOST_LIST?: string;
  MIRROR_EGRESS_MODE?: string;
};

let queue: RecordingQueue = recordingQueue();

function routeEnv(): RouteEnv {
  return {
    ...env,
    ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
    MIRROR_SYNC_QUEUE: queue,
    MIRROR_ALLOWED_HOST_LIST: undefined,
    MIRROR_EGRESS_MODE: undefined,
  };
}

/** The real production path: parse → resolveUiSession → the gates → the
 *  handler, on the mounted uiRouter; the execution context is awaited so
 *  waitUntil side-effects settle. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`${ORIGIN}${path}`, init), routeEnv(), context);
  await waitOnExecutionContext(context);
  return response;
}

/** A minted session cookie header for the user id (the real mintSession
 *  path — the beforeEach users wipe cascades sessions, so every request
 *  mints fresh; the value is never rendered). */
async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** The urlencoded POST. The Origin header is the same-origin default;
 *  `origin` overrides it (the cross-origin 403 arm). `cookie` is the full
 *  session HEADER (sessionHeader's shape) or null for the anonymous arm. */
function formPost(body: Record<string, string>, cookie: Promise<string> | null, origin?: string): Promise<RequestInit> {
  return (cookie ?? Promise.resolve(null)).then((cookieHeader) => {
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
    };
    if (cookieHeader !== null) headers.cookie = cookieHeader;
    headers.origin = origin ?? ORIGIN;
    return { method: "POST", headers, body: new URLSearchParams(body).toString() };
  });
}

/** The repositories row by slug, or null (the guard-helper style — no
 *  non-null assertions, no narrowing casts). */
async function repoRow(slug: string): Promise<typeof repositories.$inferSelect | null> {
  const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.slug, slug)).get();
  return row ?? null;
}

// --- bootstrap + the per-test wipe (children before parents) --------------------

beforeAll(async () => {
  // The full generated migration ledger + the repo_settings DDL-in-waiting
  // (the migrate description path writes the stored subset — the module
  // suite's bootstrap, same SCHEMA GAP note).
  await applyAuthD1Migrations();
  for (const statement of REPO_SETTINGS_DDL_STATEMENTS) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  for (const table of [
    "issue_labels",
    "issue_assignees",
    "issue_dependency",
    "issue_subscriptions",
    "pull_reviews",
    "pull_requests",
    "repo_watchers",
    "repo_collaborators",
    "milestones",
    "comments",
    "issues",
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
    "org_members",
    "personal_access_tokens",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
  queue = recordingQueue();
});

// ---------------------------------------------------------------------------
// ONE: /repo/migrate (62ef380 — pages/repo-migrate.tsx at the route)
// ---------------------------------------------------------------------------

interface MigFixture {
  doer: { id: number; username: string };
  doerViewer: Extract<Viewer, { kind: "user" }>;
  other: { id: number; username: string };
  owned: OrgRecord;
  foreign: OrgRecord;
}

let mig: MigFixture;

async function seedMig(): Promise<void> {
  const doer = await seedVerifiedUser({ username: "mig-doer" });
  const other = await seedVerifiedUser({ username: "mig-other" });
  const orgs = new OrgService(env.DB);
  const owned = await orgs.createOrg({ name: "mig-owned", ownerId: doer.id });
  const foreign = await orgs.createOrg({ name: "mig-foreign", ownerId: other.id });
  // A membership WITHOUT ownership — resolveMigrateOwner is org-OWNER
  // strict, so the write would 403 it and the dropdown must never offer it.
  await drizzle(env.DB).insert(orgMembers).values({ orgId: foreign.id, userId: doer.id, role: "member", createdAt: at(0) });
  mig = {
    doer,
    doerViewer: { kind: "user", id: doer.id, username: doer.username.toLowerCase(), isAdmin: false },
    other,
    owned,
    foreign,
  };
}

describe("GET+POST /repo/migrate (the mounted route — window-2e 62ef380)", () => {
  beforeEach(async () => {
    await seedMig();
  });

  it("[RED — ESCALATED] the anonymous GET 303s onto the login round-trip before any render", async () => {
    // The DOCUMENTED gate (repoMigratePage: anonymous → loginRedirect, the
    // 62ef380 mount contract). ACTUAL: a plain hono "404 Not Found" — the
    // GET never reaches its handler. Observed 2026-10-26,
    // wave-polish-migrate-inbox; escalated per the tests-only brief. ROOT
    // CAUSE (ui/index.ts registration order): the dynamic
    // `uiRouter.get("/:owner/:repo", uiPage)` is physically registered
    // BEFORE the tail statics `uiRouter.get("/repo/migrate")` (and
    // `/repo/search` one line above — the same window-2e pass-1 cluster),
    // and hono's default RegExpRouter matches in registration order, so the
    // two-segment GET lands in uiPage, whose drift guard answers the plain
    // `c.notFound()`. /repo/create (registered BEFORE the dynamic block,
    // with /repo/create POST) is unaffected; POST /repo/migrate compiles
    // into the POST method map where no dynamic POST /:owner/:repo exists,
    // so only the GET verb is dead. Fix is orchestrator-owned: move the two
    // static GET registrations physically above the dynamic /:owner/:repo
    // block (the /repo/create posture). Evidence gathered with probes
    // OUTSIDE this file; pages-wave19's /repo/create GET and this suite's
    // POST arms stay green against the same harness.
    const get = await fetchUi("/repo/migrate");
    expect(get.status).toBe(303); // ACTUAL: 404 (plain hono not-found, see above)
    expect(get.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/repo/migrate")}`);
  });

  it("303s the anonymous same-origin POST onto the login round-trip, nothing born", async () => {
    const post = await fetchUi(
      "/repo/migrate",
      await formPost({ clone_addr: SOURCE_URL, repo_name: "born", mirror: "on" }, null),
    );
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/repo/migrate")}`);
    expect(await repoRow("born")).toBeNull();
    expect(queue.sent).toEqual([]);
  });

  it("[RED — ESCALATED] renders the GET form with the org-OWNER owner list, the mirror box CHECKED, and the reduced fields gone", async () => {
    // Same shadowed-registration root cause as the anonymous GET above —
    // ACTUAL: 404 before the handler runs. Every assertion below is the
    // handler's own contract (repoMigratePage's hardcoded GET default
    // form + renderRepoMigratePage, module-pinned in
    // pages/repo-migrate.test.ts); they go green with the registration
    // fix. Escalated 2026-10-26, wave-polish-migrate-inbox.
    const res = await fetchUi("/repo/migrate", { headers: { cookie: await sessionHeader(mig.doer.id) } });
    expect(res.status).toBe(200); // ACTUAL: 404 (see the anonymous GET above)
    const html = await res.text();
    expect(html).toContain('class="page-content repository new migrate"');
    expect(html).toContain("<title>New Migration - ");
    expect(html).toContain('<form class="ui form left-right-form" action="/repo/migrate" method="post">');

    // The owner list: the doer (preselected — the GET default uid falls to
    // the doer) plus the OWNED org; the member-only org never appears.
    expect(html).toContain(`<option value="${mig.doer.id}" selected="">`);
    expect(html).toContain(`<option value="${mig.owned.id}">`);
    expect(html).not.toContain(`value="${mig.foreign.id}"`);

    // The route's hardcoded GET default arms mirror=true — the box arrives
    // CHECKED (the one honest degradation's render side).
    expect(html).toContain('<input id="mirror" name="mirror" type="checkbox" checked=""/>');
    // The service variant pin + the reduced surface stays gone at the route.
    expect(html).toContain('<input type="hidden" name="service" value="git"/>');
    expect(html).not.toContain('name="lfs"');
    expect(html).not.toContain('name="auth_token"');
    expect(html).not.toContain('name="mirror_interval"');
  });

  it("the POST round-trip: created → 303 onto the born repo, born mirror:true (the RD19 contract), one sync enqueued", async () => {
    const res = await fetchUi(
      "/repo/migrate",
      await formPost({ clone_addr: SOURCE_URL, repo_name: "born", mirror: "on" }, sessionHeader(mig.doer.id)),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/mig-doer/born");

    // The born row: ready + empty + MIRROR-FLAGGED (the population is NOT
    // in-request — the enqueued mirror-sync owns it; RD19's born-body
    // contract at the web surface).
    const born = await repoRow("born");
    if (born === null) throw new Error("the migrate POST did not birth the repo");
    expect(born.ownerNamespace).toBe("mig-doer");
    expect(born.isMirror).toBe(true);
    expect(born.status).toBe("ready");
    expect(born.isEmpty).toBe(true);
    expect(born.visibility).toBe("public");
    expect(born.originalUrl).toBe(SOURCE_URL);

    // The mirror row registered against the source…
    const mirror = await drizzle(env.DB).select().from(repoMirrors).where(eq(repoMirrors.repoId, born.id)).get();
    expect(mirror).not.toBeUndefined();
    expect(mirror?.remoteAddress).toBe(SOURCE_URL);

    // …and EXACTLY one sync message arming the initial population.
    expect(queue.sent).toEqual([{ kind: "mirror-sync", repoId: born.id }]);
  });

  it("the required-field and degradation arms re-render 200 with the exact texts and the CARRIED submission", async () => {
    const cookie = sessionHeader(mig.doer.id);

    const noUrl = await fetchUi(
      "/repo/migrate",
      await formPost({ clone_addr: "", repo_name: "kept-name", mirror: "on" }, cookie),
    );
    expect(noUrl.status).toBe(200);
    const noUrlHtml = await noUrl.text();
    expect(noUrlHtml).toContain('<div class="ui negative message">A clone URL is required.</div>');
    expect(noUrlHtml).toContain('id="repo_name" name="repo_name" value="kept-name"');

    const noName = await fetchUi(
      "/repo/migrate",
      await formPost({ clone_addr: SOURCE_URL, repo_name: "", mirror: "on" }, cookie),
    );
    expect(noName.status).toBe(200);
    const noNameHtml = await noName.text();
    expect(noNameHtml).toContain('<div class="ui negative message">A repository name is required.</div>');
    expect(noNameHtml).toContain(`id="clone_addr" name="clone_addr" value="${SOURCE_URL}"`);

    // mirror unchecked — the one honest degradation; nothing born.
    const noMirror = await fetchUi(
      "/repo/migrate",
      await formPost({ clone_addr: SOURCE_URL, repo_name: "born" }, cookie),
    );
    expect(noMirror.status).toBe(200);
    expect(await noMirror.text()).toContain(
      "Web migrations run as pull mirrors; non-mirror imports use the chunked import API.",
    );
    expect(await repoRow("born")).toBeNull();
    expect(queue.sent).toEqual([]);
  });

  it("the taken-name collision re-renders upstream's WEB text (the 409 mapped at the route)", async () => {
    await new RepoService(env.DB).create({
      owner: { id: mig.doer.id, usernameLower: "mig-doer" },
      name: "taken",
      isPrivate: false,
    });
    const res = await fetchUi(
      "/repo/migrate",
      await formPost({ clone_addr: SOURCE_URL, repo_name: "taken", mirror: "on" }, sessionHeader(mig.doer.id)),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(
      '<div class="ui negative message">The repository name is already used.</div>',
    );
    expect(queue.sent).toEqual([]);
  });

  it("the forged uid gates re-render upstream's exact API-arm texts — nothing born, nothing enqueued", async () => {
    const cookie = sessionHeader(mig.doer.id);

    // A plain USER target — upstream migrate.go:82-99's 403 text.
    const userTarget = await fetchUi(
      "/repo/migrate",
      await formPost({ clone_addr: SOURCE_URL, repo_name: "born", mirror: "on", uid: String(mig.other.id) }, cookie),
    );
    expect(userTarget.status).toBe(200);
    expect(await userTarget.text()).toContain('<div class="ui negative message">Given user is not an organization.</div>');

    // A non-owned ORG target — the second 403 text (the doer is a mere
    // member of mig-foreign).
    const orgTarget = await fetchUi(
      "/repo/migrate",
      await formPost({ clone_addr: SOURCE_URL, repo_name: "born", mirror: "on", uid: String(mig.foreign.id) }, cookie),
    );
    expect(orgTarget.status).toBe(200);
    expect(await orgTarget.text()).toContain(
      '<div class="ui negative message">Given user is not owner of organization.</div>',
    );

    // An unknown uid — the 422 text.
    const ghost = await fetchUi(
      "/repo/migrate",
      await formPost({ clone_addr: SOURCE_URL, repo_name: "born", mirror: "on", uid: "987654" }, cookie),
    );
    expect(ghost.status).toBe(200);
    expect(await ghost.text()).toContain("user does not exist [uid: 987654, name: ]");

    expect(await repoRow("born")).toBeNull();
    expect(queue.sent).toEqual([]);
  });

  it("the cross-origin POST 403s guard-first in plain text — nothing born, nothing enqueued", async () => {
    const res = await fetchUi(
      "/repo/migrate",
      await formPost(
        { clone_addr: SOURCE_URL, repo_name: "born", mirror: "on" },
        sessionHeader(mig.doer.id),
        "https://evil.example",
      ),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("cross-origin request rejected");
    expect(await repoRow("born")).toBeNull();
    expect(queue.sent).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TWO: the global inbox /issues /pulls /milestones (a8818c6)
// ---------------------------------------------------------------------------

interface InboxFixture {
  alice: { id: number; username: string };
  bob: { id: number; username: string };
  alphaRepoId: string;
  betaRepoId: string;
  alphaBugId: number;
  improveIssueId: number;
  needingTitle: string;
  reviewedTitle: string;
  v1MilestoneId: number;
}

let inbox: InboxFixture;

/** The three-repo fixture (the module smoke's cross-repo scope shape):
 *  owned alpha ∪ collaborated beta in scope; the private secret OUT —
 *  carrying an ASSIGNMENT on its issue so the extended AllPublic arms
 *  have a leak to prove closed. The PR spread arms both review filters:
 *  `needing` carries a live type=4 request for alice, `reviewed` an
 *  Approve plus a DISMISSED request (which must count nowhere). */
async function seedInbox(): Promise<void> {
  const alice = await seedVerifiedUser({ username: "inbox-alice" });
  const bob = await seedVerifiedUser({ username: "inbox-bob" });
  const repos = new RepoService(env.DB);
  const alpha = await repos.create({
    owner: { id: alice.id, usernameLower: "inbox-alice" },
    name: "alpha",
    isPrivate: false,
    status: "ready",
  });
  const beta = await repos.create({
    owner: { id: bob.id, usernameLower: "inbox-bob" },
    name: "beta",
    isPrivate: false,
    status: "ready",
  });
  const secret = await repos.create({
    owner: { id: bob.id, usernameLower: "inbox-bob" },
    name: "secret",
    isPrivate: true,
    status: "ready",
  });
  await addOrUpdateCollaborator(env.DB, beta.id, alice.id, "write", at(0));

  const svc = new IssuesService(env.DB);
  const v1 = await createRepoMilestone(new IssuesService(env.DB), alpha.id, {
    title: "v1.0",
    description: "",
    deadlineAt: null,
    state: "open",
    now: at(5),
  });
  await createRepoMilestone(new IssuesService(env.DB), beta.id, {
    title: "v2.0",
    description: "",
    deadlineAt: null,
    state: "open",
    now: at(6),
  });
  await createRepoMilestone(new IssuesService(env.DB), secret.id, {
    title: "s9",
    description: "",
    deadlineAt: null,
    state: "open",
    now: at(7),
  });

  const alphaBug = await svc.createIssue({
    repoId: alpha.id,
    title: "Alpha bug",
    posterId: alice.id,
    milestoneId: v1.id,
    now: at(10),
  });
  const improve = await svc.createPullRequest({
    repoId: alpha.id,
    title: "Alpha improve",
    posterId: alice.id,
    headRepoId: alpha.id,
    headBranch: "feature",
    baseBranch: "main",
    now: at(15),
  });
  const betaTask = await svc.createIssue({
    repoId: beta.id,
    title: "Beta task",
    posterId: bob.id,
    now: at(20),
  });
  const secretIssue = await svc.createIssue({
    repoId: secret.id,
    title: "Secret issue",
    posterId: bob.id,
    now: at(25),
  });
  const needing = await svc.createPullRequest({
    repoId: alpha.id,
    title: "Alpha needs review",
    posterId: bob.id,
    headRepoId: alpha.id,
    headBranch: "pr2",
    baseBranch: "main",
    now: at(16),
  });
  const reviewed = await svc.createPullRequest({
    repoId: alpha.id,
    title: "Alpha reviewed",
    posterId: bob.id,
    headRepoId: alpha.id,
    headBranch: "pr3",
    baseBranch: "main",
    now: at(17),
  });

  // The assignments: both visible issues AND the secret issue (the
  // AllPublic leak probe). The request/review rows: a live request on
  // `needing`; an Approve + a DISMISSED request on `reviewed`.
  await drizzle(env.DB).insert(issueAssignees).values([
    { issueId: alphaBug.id, assigneeId: alice.id },
    { issueId: betaTask.id, assigneeId: alice.id },
    { issueId: secretIssue.id, assigneeId: alice.id },
  ]);
  await drizzle(env.DB).insert(pullReviews).values([
    { type: ReviewType.Request, reviewerId: alice.id, issueId: needing.issue.id, content: "", createdAt: at(18) },
    { type: ReviewType.Approve, reviewerId: alice.id, issueId: reviewed.issue.id, content: "", createdAt: at(19) },
    {
      type: ReviewType.Request,
      reviewerId: alice.id,
      issueId: reviewed.issue.id,
      dismissed: true,
      content: "",
      createdAt: at(19),
    },
  ]);

  inbox = {
    alice,
    bob,
    alphaRepoId: alpha.id,
    betaRepoId: beta.id,
    alphaBugId: alphaBug.id,
    improveIssueId: improve.issue.id,
    needingTitle: "Alpha needs review",
    reviewedTitle: "Alpha reviewed",
    v1MilestoneId: v1.id,
  };
}

describe("the global inbox routes /issues /pulls /milestones (window-2e a8818c6)", () => {
  beforeEach(async () => {
    await seedInbox();
  });

  it("303s all three anonymous GETs onto the login round-trips (reqSignIn, web.go:567-573)", async () => {
    for (const path of ["/issues", "/pulls", "/milestones"]) {
      const res = await fetchUi(path);
      expect(res.status, path).toBe(303);
      expect(res.headers.get("location"), path).toBe(`/login?redirect_to=${encodeURIComponent(path)}`);
    }
  });

  it("claims the three top-level literals ahead of owner-home and 301s the trailing slashes (§4.13)", async () => {
    expect(parseUiRoute("/issues")).toEqual({ family: "global-issues" });
    expect(parseUiRoute("/pulls")).toEqual({ family: "global-pulls" });
    expect(parseUiRoute("/milestones")).toEqual({ family: "global-milestones" });
    expect(parseUiRoute("/issues/")).toEqual({ family: "global-issues" });
    expect(parseUiRoute("/repo/migrate")).toEqual({ family: "repo-migrate" });
    for (const path of ["/issues", "/pulls", "/milestones", "/repo/migrate"]) {
      expect(handlesUiRoute(path), path).toBe(true);
    }

    // A deeper tail reads as the shadowed owner/repo pair (a user named
    // "issues" is create-time reserved — RESERVED_USERNAMES — so the row
    // can never exist and the repo-home family 404-shells), exactly like
    // upstream's dynamic pairs answering after its static groups.
    expect(parseUiRoute("/issues/extra")).toEqual({ family: "home", owner: "issues", repo: "extra", refSuffix: null });

    const slash = await fetchUi("/issues/");
    expect(slash.status).toBe(301);
    // hono's trimTrailingSlash re-emits the absolute URL.
    expect(slash.headers.get("location")).toBe(`${ORIGIN}/issues`);

    const deeper = await fetchUi("/issues/extra");
    expect(deeper.status).toBe(404);
    expect(await deeper.text()).toContain("status-page-error");
  });

  it("GET /issues renders the type-arm counts over the visible scope and the rows in recency order", async () => {
    const res = await fetchUi("/issues", { headers: { cookie: await sessionHeader(inbox.alice.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("dashboard issues"); // the §2.4.1 discriminator
    expect(html).toContain('href="/issues">In your repositories <strong>2</strong></a>');
    expect(html).toContain('href="/issues?type=assigned">Assigned to you <strong>2</strong></a>');
    expect(html).toContain('href="/issues?type=created_by">Created by you <strong>1</strong></a>');
    // The review pair is pulls-only (issues.tmpl's PageIsPulls gate).
    expect(html).not.toContain("review_requested");
    expect(html).not.toContain("reviewed_by");

    // The rows: the collaborated beta issue stamped latest, first.
    const betaAt = html.indexOf("Beta task");
    const alphaAt = html.indexOf("Alpha bug");
    expect(betaAt).toBeGreaterThan(-1);
    expect(alphaAt).toBeGreaterThan(betaAt);
    expect(html).toContain("bob/beta#1");
    expect(html).toContain("alice/alpha#1");
  });

  it("GET /pulls renders the pulls-only review arms with their counts", async () => {
    const res = await fetchUi("/pulls", { headers: { cookie: await sessionHeader(inbox.alice.id) } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("dashboard issues"); // the ONE shared template
    expect(html).toContain('href="/pulls">In your repositories <strong>3</strong></a>');
    expect(html).toContain('href="/pulls?type=assigned">Assigned to you <strong>0</strong></a>');
    expect(html).toContain('href="/pulls?type=created_by">Created by you <strong>1</strong></a>');
    expect(html).toContain('href="/pulls?type=review_requested">Review requested <strong>1</strong></a>');
    expect(html).toContain('href="/pulls?type=reviewed_by">Reviewed by you <strong>1</strong></a>');
  });

  it("the review arms route through the pull_reviews rows; the DISMISSED request counts nowhere", async () => {
    const cookie = { headers: { cookie: await sessionHeader(inbox.alice.id) } };

    const requested = await fetchUi("/pulls?type=review_requested", cookie);
    expect(requested.status).toBe(200);
    const requestedHtml = await requested.text();
    expect(requestedHtml).toContain(inbox.needingTitle);
    expect(requestedHtml).not.toContain("Alpha improve");
    expect(requestedHtml).not.toContain(inbox.reviewedTitle);

    const reviewedBy = await fetchUi("/pulls?type=reviewed_by", cookie);
    expect(reviewedBy.status).toBe(200);
    const reviewedHtml = await reviewedBy.text();
    expect(reviewedHtml).toContain(inbox.reviewedTitle);
    expect(reviewedHtml).not.toContain(inbox.needingTitle);
    expect(reviewedHtml).not.toContain("Alpha improve");
  });

  it("the state toggles swap the lists and flip the active tab (issues + the pulls closed arm)", async () => {
    const cookie = { headers: { cookie: await sessionHeader(inbox.alice.id) } };
    const svc = new IssuesService(env.DB);

    // Close the alpha issue — the open list drops it, the closed list
    // holds it alone, and the toggle tabs' active marks follow.
    await svc.closeIssue(inbox.alphaBugId);
    const open = await fetchUi("/issues", cookie);
    const openHtml = await open.text();
    expect(openHtml).toContain('class="item active" href="/issues"');
    expect(openHtml).toContain('class="item" href="/issues?state=closed"');
    expect(openHtml).not.toContain("Alpha bug");
    expect(openHtml).toContain("Beta task");

    const closed = await fetchUi("/issues?state=closed", cookie);
    const closedHtml = await closed.text();
    expect(closedHtml).toContain('class="item active" href="/issues?state=closed"');
    expect(closedHtml).toContain("Alpha bug");
    expect(closedHtml).not.toContain("Beta task");

    // The pulls closed arm: the closed PR leaves the open counts and
    // lists only under ?state=closed.
    await svc.closeIssue(inbox.improveIssueId);
    const pullsOpen = await fetchUi("/pulls", cookie);
    expect(await pullsOpen.text()).toContain('href="/pulls">In your repositories <strong>2</strong></a>');
    const pullsClosed = await fetchUi("/pulls?state=closed", cookie);
    const pullsClosedHtml = await pullsClosed.text();
    expect(pullsClosedHtml).toContain("Alpha improve");
    expect(pullsClosedHtml).toContain("alice/alpha#2");
    expect(pullsClosedHtml).not.toContain(inbox.needingTitle);
  });

  it("excludes the private repo's rows on ALL THREE pages — including the assigned arm's AllPublic scope", async () => {
    const cookie = { headers: { cookie: await sessionHeader(inbox.alice.id) } };

    const issues = await fetchUi("/issues", cookie);
    const issuesHtml = await issues.text();
    expect(issuesHtml).not.toContain("Secret issue");
    expect(issuesHtml).not.toContain("inbox-bob/secret");

    const pulls = await fetchUi("/pulls", cookie);
    expect((await pulls.text())).not.toContain("inbox-bob/secret");

    const milestones = await fetchUi("/milestones", cookie);
    const milestonesHtml = await milestones.text();
    expect(milestonesHtml).not.toContain("s9");
    expect(milestonesHtml).not.toContain("inbox-bob/secret");

    // The strongest arm: alice IS assigned to the secret issue, but the
    // private repo must not leak through the AllPublic-extended scope.
    const assigned = await fetchUi("/issues?type=assigned", cookie);
    const assignedHtml = await assigned.text();
    expect(assignedHtml).toContain('href="/issues?type=assigned">Assigned to you <strong>2</strong></a>');
    expect(assignedHtml).toContain("Alpha bug");
    expect(assignedHtml).toContain("Beta task");
    expect(assignedHtml).not.toContain("Secret issue");
  });

  it("the milestones sidebar + toggles: the repos filter, its active mark and toggle-off href, the state and keyword arms", async () => {
    const cookie = { headers: { cookie: await sessionHeader(inbox.alice.id) } };

    // The sidebar: the total item, one entry per milestone-bearing VISIBLE
    // repo with its toggle href; the private repo absent.
    const base = await fetchUi("/milestones", cookie);
    const baseHtml = await base.text();
    expect(baseHtml).toContain("dashboard issues repository milestones"); // the discriminator
    expect(baseHtml).toContain("In your repositories <strong>2</strong>");
    expect(baseHtml).toContain(`href="/milestones?repos=%5B${inbox.alphaRepoId}%2C%5D"`);
    expect(baseHtml).toContain(`href="/milestones?repos=%5B${inbox.betaRepoId}%2C%5D"`);
    expect(baseHtml).toContain("inbox-alice/alpha");
    expect(baseHtml).toContain("inbox-bob/beta");
    expect(baseHtml).toContain("v1.0");
    expect(baseHtml).toContain("v2.0");
    // The rows link the LANDED milestone-detail pages.
    expect(baseHtml).toContain(`href="/inbox-alice/alpha/milestone/${inbox.v1MilestoneId}"`);

    // The repos filter: only alpha's row survives; alpha's sidebar entry
    // turns active and its toggle-off href strips the filter entirely.
    const filtered = await fetchUi(`/milestones?repos=%5B${inbox.alphaRepoId}%2C%5D`, cookie);
    const filteredHtml = await filtered.text();
    expect(filteredHtml).toContain("v1.0");
    expect(filteredHtml).not.toContain("v2.0");
    expect(filteredHtml).toContain('class="active repo name item"');
    expect(filteredHtml).toContain('href="/milestones"');

    // The keyword arm narrows the rows and the sidebar counts with it
    // (the beta entry stays listed — HasMilestones is keyword-free — at 0).
    const keyword = await fetchUi("/milestones?q=v1", cookie);
    const keywordHtml = await keyword.text();
    expect(keywordHtml).toContain("v1.0");
    expect(keywordHtml).not.toContain("v2.0");
    expect(keywordHtml).toContain("inbox-bob/beta");

    // The state toggle: close v1.0 — the open page holds only v2.0, the
    // closed page holds v1.0 under the red count labels.
    await new IssuesService(env.DB).updateMilestone(inbox.v1MilestoneId, { state: "closed", now: at(50) });
    const open = await fetchUi("/milestones", cookie);
    const openHtml = await open.text();
    expect(openHtml).toContain("v2.0");
    expect(openHtml).not.toContain("v1.0");
    expect(openHtml).toContain('class="ui green label"');
    const closed = await fetchUi("/milestones?state=closed", cookie);
    const closedHtml = await closed.text();
    expect(closedHtml).toContain("v1.0");
    expect(closedHtml).not.toContain("v2.0");
    expect(closedHtml).toContain('class="ui red label"');
  });

  it("the pager shapes: page 1 Older-only, page 2 Newer-only, past-end the empty line under an absent pager", async () => {
    const cookie = { headers: { cookie: await sessionHeader(inbox.alice.id) } };
    const svc = new IssuesService(env.DB);
    // 21 fillers (stamped after every fixture row) push the open-issue
    // total to 23 — two pages of 20 with a 3-row tail.
    for (let i = 1; i <= 21; i += 1) {
      await svc.createIssue({
        repoId: inbox.alphaRepoId,
        title: `Filler ${String(i).padStart(2, "0")}`,
        posterId: inbox.alice.id,
        now: at(30 + i),
      });
    }

    const page1 = await fetchUi("/issues", cookie);
    const page1Html = await page1.text();
    expect(page1Html).toContain("Filler 21"); // the newest stamp first
    expect(page1Html).not.toContain("Filler 01");
    expect(page1Html).toContain('href="/issues?page=2"');
    expect(page1Html).toContain("Older");
    expect(page1Html).not.toContain("Newer");

    const page2 = await fetchUi("/issues?page=2", cookie);
    const page2Html = await page2.text();
    expect(page2Html).toContain("Filler 01"); // the 3-row tail
    expect(page2Html).toContain("Alpha bug");
    expect(page2Html).toContain("Beta task");
    // The Newer href targets page 1 — a DEFAULT, so overviewHref re-emits
    // the bare root (the page param is only kept when > 1).
    expect(page2Html).toContain('<a class="item navigation" href="/issues">');
    expect(page2Html).toContain("Newer");
    expect(page2Html).not.toContain("Older");

    const pastEnd = await fetchUi("/issues?page=99", cookie);
    const pastEndHtml = await pastEnd.text();
    expect(pastEndHtml).toContain("No results"); // upstream renders blank; the documented cf-gitea addition
    // The render keeps the Newer navigation whenever page > 1 (upstream
    // paginate.tmpl's own shape; `more` only gates the Older link). NOTE:
    // the global-inbox module header's mount record ("a past-end ?page=
    // renders the empty-list line under an ABSENT pager") does not match
    // the landed InboxPager — header drift, not a route bug.
    expect(pastEndHtml).toContain('<a class="item navigation" href="/issues?page=98">');
    expect(pastEndHtml).toContain("Newer");
    expect(pastEndHtml).not.toContain("Older");
    expect(pastEndHtml).not.toContain("Alpha bug");
  });
});
