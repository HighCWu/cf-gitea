/**
 * Shared fixtures + render harness for the U5 goldens and a11y tests
 * (SPEC-0008 §5.2/§5.5, §5.1 seeding pattern): REAL pushed engine content
 * through the landed receive flow (testing/seed-repo.ts), D1 from the
 * generated migrations, and the synthetic ASSETS manifest fetcher — the same
 * fixture shape as pages.test.ts, with fixed dates/contents so every render
 * is byte-deterministic (§5.2: same seed fixtures → byte-identical HTML).
 *
 * Slugs are distinct from pages.test.ts's ("golden" / "golden-alt") so the
 * two files' fixtures never share repo rows, and the committed goldens are
 * stable no matter which files ran before.
 *
 * Golden-update mechanism (§5.2 regeneration): workerd tests have no
 * filesystem writes and shell env vars do not reach the worker (verified
 * 2026-10-24: `process.env` inside the vitest workerd context carries only
 * miniflare bindings + Vite's own vars), so the env-var pattern is not
 * available. Instead `update-goldens.mjs` (same directory) drops a sentinel
 * file, runs vitest, and extracts marker-delimited renders from stdout.
 */

import { env } from "cloudflare:test";
import { SELF } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { issues, pullReviews, repositories, repoMirrors, users } from "../../db/schema";
import { type UiManifest } from "../manifest";
import { uiRouter, type UiAssetsFetcher } from "../index";
import {
  buildHistoryPack,
  buildReceivePackBody,
  ensureSeededRepo,
  type SeedCommit,
} from "../testing/seed-repo";
import { IssuesService } from "../../issues/service";
import { createRepoLabel } from "../../api/services/labels";
import { isWatchingRepo, watchRepo } from "../../api/services/repo-watchers";
import { saveRepoSettings } from "../../api/services/repo-settings";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { OrgService } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";

// --- deterministic fixtures (mirrors pages.test.ts's seeding) -----------------

/** Synthetic manifest shaped like the real Vite output; the fixed pseudo-
 *  hashes make goldens stable across asset rebuilds without normalization
 *  (SPEC-0008 §5.2's normalization exists for the real-manifest case). */
export const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": {
    file: "js/index.deadbeef.js",
    imports: ["web_src/js/secondary.ts"],
    css: ["css/index.1111aaaa.css"],
  },
  "web_src/js/secondary.ts": { file: "js/secondary.2222bbbb.js", css: ["css/secondary.3333cccc.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

export const fakeAssets: UiAssetsFetcher = {
  fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })),
};

type UiTestEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
export const uiEnv: UiTestEnv = { ...env, ASSETS: fakeAssets };

/** Fixed epoch: 2023-11-14T22:13:20Z — every date on every golden derives
 *  from this constant (pages.test.ts's T0), never from Date.now(). */
export const T0 = 1_700_000_000;

export const README = [
  "# Hello cf-gitea",
  "",
  "Some *markdown* with a [relative link](docs/guide.md).",
  "",
  "## Details",
  "",
  "Plain paragraph.",
  "",
].join("\n");

const APP_TS = [
  "export function main(): void {",
  '  console.log("hello cf-gitea");',
  "}",
  "",
].join("\n");

const GUIDE_MD = ["# Guide", "", "Walkthrough text.", ""].join("\n");

/** Null-byte-leading bytes: the §4.2 binary sniff fires, the .png extension
 *  picks the image media branch. */
const LOGO_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

/** Commit 1 writes the README, commit 2 everything else — §3.5 per-entry
 *  enrichment resolves DIFFERENT commits per row (pages.test.ts's shape). */
const GOLDEN_COMMITS: SeedCommit[] = [
  { message: "initial commit: add README", time: T0, files: [{ path: "README.md", content: README }] },
  {
    message: "add app source and docs",
    time: T0 + 120,
    files: [
      { path: "README.md", content: README },
      { path: "app.ts", content: APP_TS },
      { path: "docs/guide.md", content: GUIDE_MD },
      { path: "logo.png", content: LOGO_PNG },
    ],
  },
];

/** A DIFFERENT seed (one commit, different file/subject/time) — the
 *  determinism guard renders two seeds and requires different bytes. */
const ALT_COMMITS: SeedCommit[] = [
  {
    message: "alt seed: single commit",
    time: T0 + 300,
    files: [{ path: "only.txt", content: "alt content\n" }],
  },
];

// --- render helper -------------------------------------------------------------

/** Route-level render through the mounted uiRouter — the real production
 *  path (parse → resolve → load → renderPage), with the synthetic manifest. */
export async function renderRoute(path: string, init?: RequestInit): Promise<{ status: number; html: string }> {
  const res = await uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
  return { status: res.status, html: await res.text() };
}

/** A signed-in render of one golden case: the session cookie rides the
 *  request when the case says so (the wave-9 dashboard golden; anonymous is
 *  every pre-wave-9 case). */
export async function renderCase(golden: GoldenCase): Promise<{ status: number; html: string }> {
  if (golden.signedIn !== true) return renderRoute(golden.path);
  return renderRoute(golden.path, { headers: { cookie: `${SESSION_COOKIE_NAME}=${await aliceSessionCookie()}` } });
}

/** Alice's session cookie, minted once per module (the wave-4 pattern; the
 *  value is never rendered). */
let aliceSession: string | null = null;
export async function aliceSessionCookie(): Promise<string> {
  if (aliceSession === null) {
    const alice = await drizzle(env.DB)
      .select({ id: users.id })
      .from(users)
      .where(eq(users.usernameLower, "alice"))
      .get();
    if (alice === undefined) throw new Error("golden owner row missing before the session mint");
    aliceSession = await mintSession(env.DB, alice.id);
  }
  return aliceSession;
}

// --- the golden inventory (§5.2: three pages + 404 shell + bare shell) ---------

export interface GoldenCase {
  /** Committed file name under __tests__/goldens/. */
  file: string;
  /** Route rendered into the golden. */
  path: string;
  /** Expected HTTP status (404 shells are goldens too, §4.5). */
  status: number;
  /** Render signed-in (pages wave 9 — the dashboard golden): the route
   *  request carries alice's session cookie. The cookie value itself is
   *  crypto-random per run and never rendered, so the bytes stay stable
   *  (§5.2 determinism is a fixture property). */
  signedIn?: boolean;
}

export const GOLDEN_CASES: GoldenCase[] = [
  { file: "home.html", path: "/alice/golden", status: 200 },
  { file: "commits.html", path: "/alice/golden/commits", status: 200 },
  { file: "file-view-code.html", path: "/alice/golden/src/branch/main/app.ts", status: 200 },
  // The code-tree listing (wave 2): the DOM the /tree family redirects onto
  // (pages/repo-home.tsx — a redirect itself has no DOM to snapshot).
  { file: "tree-dir.html", path: "/alice/golden/src/branch/main/docs", status: 200 },
  // Issues list (wave 2): open (the default), closed (the second tab), and
  // the pulls list reusing the same component over is_pull rows.
  { file: "issues-open.html", path: "/alice/golden/issues", status: 200 },
  { file: "issues-closed.html", path: "/alice/golden/issues?state=closed", status: 200 },
  { file: "pulls-open.html", path: "/alice/golden/pulls", status: 200 },
  // Issue/PR detail (wave 3): the labeled+milestone+commented issue #1 and
  // the PR #4 (checking mergeability) through the same is_pull component.
  { file: "issue-detail.html", path: "/alice/golden/issues/1", status: 200 },
  { file: "pull-detail.html", path: "/alice/golden/pulls/4", status: 200 },
  // PR review interactions (wave 11): the SIGNED-IN PR detail — alice is the
  // poster, so the verdict form renders with the disabled approve/reject
  // options, the request-review control renders (the poster's grant), and
  // morgan's REQUEST + APPROVED rows render with the remove/dismiss forms.
  { file: "pull-review-signed-in.html", path: "/alice/golden/pulls/4", status: 200, signedIn: true },
  // PR files diff view (wave 5): the PR #4 range diff (the seedGoldenPullDiff
  // fixture pushes docs-seed + refs/pull/4/head ahead of main).
  { file: "pull-files.html", path: "/alice/golden/pulls/4/files", status: 200 },
  // 404 shell WITH repo context (the repo resolved, the ref did not, §4.5).
  { file: "not-found-repo.html", path: "/alice/golden/commits/branch/nope", status: 404 },
  // Bare shell: 404 for an unknown owner/repo — navbar/main/footer, no repo
  // header, no discriminator class.
  { file: "bare-shell.html", path: "/nobody/nothing", status: 404 },
  // Org home (wave 6): the public acme org's visible list (anonymous — the
  // private fixture repo stays hidden), and the zero-repo empty placeholder.
  { file: "org-home.html", path: "/acme", status: 200 },
  { file: "org-home-empty.html", path: "/emptyorg", status: 200 },
  // User profile (wave 7): the USER half of the single-segment family —
  // alice's public repos (golden/golden-alt/golden-ms, no descriptions,
  // updatedAt never stamped → no "Updated" lines, byte-stable).
  { file: "user-profile.html", path: "/alice", status: 200 },
  // Milestones list (wave 6): the open default (a 50% progress bar, an
  // overdue-red past deadline, "No due date") and the closed tab (the
  // closed-stamp line + the 100% milestone).
  { file: "milestones-open.html", path: "/alice/golden-ms/milestones", status: 200 },
  { file: "milestones-closed.html", path: "/alice/golden-ms/milestones?state=closed", status: 200 },
  // Site root + explore (wave 9): the anonymous landing, the signed-in
  // dashboard (alice — own repos + the watched anvil + the anvil activity
  // line), and the two explore pages (anonymous — public rows, active
  // individual users).
  { file: "landing.html", path: "/", status: 200 },
  { file: "dashboard.html", path: "/", status: 200, signedIn: true },
  { file: "explore-repos.html", path: "/explore/repos", status: 200 },
  { file: "explore-users.html", path: "/explore/users", status: 200 },
  // Notifications (wave 10): the signed-in unread tab (alice's one anvil
  // thread — the derived-thread read, the tab badge and the mark-all button)
  // and the empty read tab (upstream's empty-placeholder branch). Both
  // signed-in — the mailbox is per-user; the bell renders in the navbar.
  { file: "notifications-unread.html", path: "/notifications?type=unread", status: 200, signedIn: true },
  { file: "notifications-read.html", path: "/notifications?type=read", status: 200, signedIn: true },
  // Mirror panel (wave 10): the signed-in admin view of alice/golden's
  // mirror row (the table, the status lines, the honest-absence note).
  { file: "settings-mirror.html", path: "/alice/golden/settings/mirror", status: 200, signedIn: true },
];

/** Marker frame the update script extracts golden bodies from (a single
 *  console.log per golden keeps the block contiguous in vitest's stream). */
export const GOLDEN_MARKER_START = "@@GOLDEN:";
export const GOLDEN_MARKER_END = "@@END-GOLDEN@@";

let seeded = false;

/**
 * Deterministic issue-block fixtures for the wave-2 goldens (issues-open,
 * issues-closed, pulls-open): two labels, one milestone, three issues (two
 * open — one carrying both labels, the milestone and a comment — one closed
 * via the landed transition), and one pull request (is_pull, so /pulls shows
 * it while /issues hides it). Every write passes a fixed `now`, so the
 * rendered event lines and counts are byte-stable (§5.2).
 *
 * Idempotent like ensureSeededRepo: the presence of ANY issue row for the
 * golden repo skips the whole block (issue numbers draw from the per-repo
 * monotonic counter — re-running would duplicate, not converge).
 */
async function seedGoldenIssues(): Promise<void> {
  const db = drizzle(env.DB);
  const repo = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "golden")))
    .get();
  if (repo === undefined) throw new Error("golden repo row missing before issue seeding");
  const existing = await db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, repo.id)).limit(1).all();
  if (existing.length > 0) return;

  const owner = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(eq(users.usernameLower, "alice"))
    .get();
  if (owner === undefined) throw new Error("golden owner row missing before issue seeding");

  const svc = new IssuesService(env.DB);
  const t = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);
  const bug = await createRepoLabel(env.DB, repo.id, {
    name: "bug",
    exclusive: false,
    color: "#ee0701",
    description: "Something is broken",
    isArchived: false,
    now: t(0),
  });
  const enhancement = await createRepoLabel(env.DB, repo.id, {
    name: "enhancement",
    exclusive: false,
    color: "#84b6eb",
    description: "New feature or request",
    isArchived: false,
    now: t(0),
  });
  const milestone = await svc.createMilestone({ repoId: repo.id, name: "v1.0", now: t(0) });

  const labeled = await svc.createIssue({
    repoId: repo.id,
    title: "open: dark mode toggles twice",
    content: "Toggling the theme flips it back.",
    posterId: owner.id,
    milestoneId: milestone.id,
    labelIds: [bug.id, enhancement.id],
    now: t(10),
  });
  await svc.createIssue({
    repoId: repo.id,
    title: "open: document the seed format",
    posterId: owner.id,
    now: t(20),
  });
  const closed = await svc.createIssue({
    repoId: repo.id,
    title: "closed: duplicate welcome banner",
    posterId: owner.id,
    now: t(30),
  });
  await svc.closeIssue(closed.id, { now: t(40) });
  await svc.createPullRequest({
    repoId: repo.id,
    title: "pull: add seed format docs",
    posterId: owner.id,
    headRepoId: repo.id,
    baseBranch: "main",
    headBranch: "docs-seed",
    now: t(50),
  });
  await svc.addComment({ issueId: labeled.id, posterId: owner.id, content: "Reproduced on two machines.", now: t(60) });
}

/**
 * The wave-5 PR-diff fixture for the pull-files golden: PR #4's head branch
 * gets REAL content ahead of main — a third commit whose first two commits
 * are byte-identical to GOLDEN_COMMITS (same fixed times/contents → the
 * same oids, so the merge base IS the pushed main tip) plus a guide edit
 * (del + add lines) and a created file (all-add lines). The refs push once
 * through the REAL receive flow, guarded on the branch's existence like
 * ensureSeededRepo.
 */
const GOLDEN_GUIDE_V2 = ["# Guide", "", "Walkthrough text.", "", "## Seeding", "", "How the seed format works.", ""].join("\n");
const GOLDEN_EXTRA_MD = "# Extra page\n\nLinked from the guide.\n";

const GOLDEN_DIFF_COMMITS: SeedCommit[] = [
  ...GOLDEN_COMMITS,
  {
    message: "docs: expand the guide, add the extra page",
    time: T0 + 180,
    files: [
      { path: "README.md", content: README },
      { path: "app.ts", content: APP_TS },
      { path: "docs/guide.md", content: GOLDEN_GUIDE_V2 },
      { path: "docs/extra.md", content: GOLDEN_EXTRA_MD },
      { path: "logo.png", content: LOGO_PNG },
    ],
  },
];

async function seedGoldenPullDiff(): Promise<void> {
  const db = drizzle(env.DB);
  const refs = await env.REPO.getByName("alice/golden").listRefs();
  const refNames = new Set((refs?.refs ?? []).map((ref) => ref.name));
  if (refNames.has("refs/heads/docs-seed")) return;
  const owner = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.usernameLower, "alice"))
    .get();
  if (owner === undefined) throw new Error("golden owner row missing before the PR-diff push");
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(owner.id, "ui-page-seed-golden-diff")
    .run();
  const token = (await mintFor(owner.id, "ui-page-seed-golden-diff", "write:repository")).plaintext;
  const { tips, pack } = await buildHistoryPack(GOLDEN_DIFF_COMMITS);
  const response = await SELF.fetch("https://test.local/alice/golden.git/git-receive-pack", {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
    body: buildReceivePackBody(
      [
        { ref: "refs/heads/docs-seed", oid: tips[2] as string },
        { ref: "refs/pull/4/head", oid: tips[2] as string },
      ],
      pack,
    ),
  });
  const body = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
  if (response.status !== 200 || body.includes("ng ")) {
    throw new Error(`golden PR-diff push failed: ${response.status} ${body.slice(0, 400)}`);
  }
}

/**
 * The wave-6 org fixture: the public `acme` org (owned by a dedicated
 * `morgan` user) with three repositories — two public (one archived, for the
 * row badge) and one private (hidden from the anonymous golden; the signed-in
 * wave-6 route tests see it) — plus the zero-repo `emptyorg`. D1-only rows
 * through the landed services (the org page never reads engine content, so
 * no receive-pack is needed), every timestamp pinned to T0-derived values.
 *
 * Idempotent: the org lookup gates the whole block (org creation arbitrates
 * the shared username namespace — re-running would collide, not converge).
 */
async function seedGoldenOrg(): Promise<void> {
  const orgs = new OrgService(env.DB);
  if ((await orgs.getOrgByUsername("acme")) !== null) return;

  const morgan = await seedVerifiedUser({ username: "morgan" });
  await orgs.createOrg({
    name: "acme",
    ownerId: morgan.id,
    visibility: "public",
    fullName: "Acme Corporation",
    description: "Everything the coyote orders.",
    location: "Desert Mesa",
    website: "https://acme.example",
    now: new Date(T0 * 1000),
  });
  const org = await orgs.getOrgByUsername("acme");
  if (org === null) throw new Error("acme org row missing after create");

  const service = new RepoService(env.DB);
  const repos: Array<{ slug: string; isPrivate: boolean; isArchived: boolean; description: string; updated: number }> = [
    { slug: "anvil", isPrivate: false, isArchived: false, description: "Drop-tested delivery hardware.", updated: T0 + 60 },
    { slug: "rocket-skates", isPrivate: false, isArchived: true, description: "", updated: T0 + 120 },
    { slug: "bird-seed", isPrivate: true, isArchived: false, description: "Supercharged, members only.", updated: T0 + 180 },
  ];
  for (const repo of repos) {
    const row = await service.create({
      owner: { id: org.id, usernameLower: "acme" },
      name: repo.slug,
      isPrivate: repo.isPrivate,
      status: "ready",
    });
    await drizzle(env.DB)
      .update(repositories)
      .set({ createdAt: new Date(T0 * 1000), updatedAt: new Date(repo.updated * 1000), isArchived: repo.isArchived })
      .where(eq(repositories.id, row.id));
    if (repo.description !== "") {
      await saveRepoSettings(env.DB, row.id, { description: repo.description }, new Date(T0 * 1000));
    }
  }

  await orgs.createOrg({ name: "emptyorg", ownerId: morgan.id, visibility: "public", now: new Date(T0 * 1000) });
}

/** One engine-seeded commit for the golden milestones repo (content is
 *  irrelevant — the milestones page reads D1 only; the seed exists so the
 *  repo row + ownership resolve exactly like every other golden repo). */
const GOLDEN_MS_COMMITS: SeedCommit[] = [
  { message: "seed: milestone fixture repo", time: T0, files: [{ path: "README.md", content: "# golden-ms\n" }] },
];

/**
 * The wave-6 milestone fixtures for `alice/golden-ms`: three milestones with
 * maintained counters — `v1.0` open at 50% (one open + one closed issue),
 * `past-due` open with a fixed past deadline (the overdue-red line, zero
 * issues), `v0.9` closed at 100% (one closed issue; closed-date stamped).
 * Every write passes a fixed `now`, so progress bars, stamps and tab counts
 * are byte-stable (§5.2); the deadline is decades in the past, so the
 * overdue branch is stable for the lifetime of the fixtures.
 *
 * Idempotent like seedGoldenIssues: any issue row for the repo skips the
 * block (the milestones are created first, so the leaf write's presence
 * implies the whole block).
 */
async function seedGoldenMilestones(): Promise<void> {
  const db = drizzle(env.DB);
  const repo = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "golden-ms")))
    .get();
  if (repo === undefined) throw new Error("golden-ms repo row missing before milestone seeding");
  const existing = await db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, repo.id)).limit(1).all();
  if (existing.length > 0) return;

  const owner = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.usernameLower, "alice"))
    .get();
  if (owner === undefined) throw new Error("golden owner row missing before milestone seeding");

  const svc = new IssuesService(env.DB);
  const t = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

  const v1 = await svc.createMilestone({ repoId: repo.id, name: "v1.0", now: t(0) });
  await svc.createMilestone({
    repoId: repo.id,
    name: "past-due",
    deadlineAt: t(86_400), // T0 + 1 day — fixed past → the overdue branch
    now: t(0),
  });
  const v09 = await svc.createMilestone({ repoId: repo.id, name: "v0.9", now: t(0) });

  await svc.createIssue({
    repoId: repo.id,
    title: "open: wired to v1.0",
    posterId: owner.id,
    milestoneId: v1.id,
    now: t(10),
  });
  const v1Closed = await svc.createIssue({
    repoId: repo.id,
    title: "closed: wired to v1.0",
    posterId: owner.id,
    milestoneId: v1.id,
    now: t(20),
  });
  await svc.closeIssue(v1Closed.id, { now: t(30) });

  const v09Closed = await svc.createIssue({
    repoId: repo.id,
    title: "closed: wired to v0.9",
    posterId: owner.id,
    milestoneId: v09.id,
    now: t(50),
  });
  await svc.closeIssue(v09Closed.id, { now: t(60) });
  await svc.updateMilestone(v09.id, { state: "closed", now: t(70) });
}

/**
 * The wave-9 dashboard fixtures (the signed-in `/` golden): alice watches
 * the public `acme/anvil`, and morgan (the org owner) files one issue on it
 * at a fixed time — the watcher-arm recipient with foreign activity behind
 * the dashboard's single activity line. Both writes are idempotent, and
 * NEITHER touches a committed golden: anvil has no repo-scoped golden (the
 * org home renders the open-pulls counter only), so the new issue row and
 * the watcher row change no existing bytes.
 */
async function seedGoldenDashboard(): Promise<void> {
  const db = drizzle(env.DB);
  const anvil = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "acme"), eq(repositories.slug, "anvil")))
    .get();
  const morgan = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.usernameLower, "morgan"))
    .get();
  const alice = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.usernameLower, "alice"))
    .get();
  if (anvil === undefined || morgan === undefined || alice === undefined) {
    throw new Error("golden dashboard fixture rows missing (org seed must run first)");
  }
  if (!(await isWatchingRepo(env.DB, anvil.id, alice.id))) {
    await watchRepo(env.DB, anvil.id, alice.id, new Date(T0 * 1000));
  }
  const existing = await db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, anvil.id)).limit(1).all();
  if (existing.length === 0) {
    await new IssuesService(env.DB).createIssue({
      repoId: anvil.id,
      title: "anvil: orders bounce at the cliff edge",
      content: "Every delivery so far has ended at the bottom of the mesa.",
      posterId: morgan.id,
      now: new Date((T0 + 200) * 1000),
    });
  }
  // The explore-users golden renders "Joined on" from the users rows — pin
  // morgan's like alice's (seedVerifiedUser stamps wall-clock time; §5.2
  // determinism is a fixture property).
  await drizzle(env.DB).update(users).set({ createdAt: new Date(T0 * 1000) }).where(eq(users.id, morgan.id));
}

/**
 * The wave-10 mirror fixture: alice/golden carries a pull-mirror row with
 * every timestamp pinned to T0-derived values (the settings/mirror page
 * renders them verbatim — §5.2 determinism is a fixture property). The row
 * is read only by the mirror panel and the sync sweep (never by another
 * golden), so adding it changes no existing bytes. Idempotent by the
 * repo_id UNIQUE.
 */
async function seedGoldenMirror(): Promise<void> {
  const db = drizzle(env.DB);
  const repo = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "golden")))
    .get();
  if (repo === undefined) throw new Error("golden repo row missing before mirror seeding");
  const existing = await db.select({ repoId: repoMirrors.repoId }).from(repoMirrors).where(eq(repoMirrors.repoId, repo.id)).get();
  if (existing !== undefined) return;
  await db.insert(repoMirrors).values({
    repoId: repo.id,
    intervalSeconds: 28800,
    enablePrune: true,
    lfsEnabled: false,
    lfsEndpoint: null,
    remoteAddress: "https://mirrors.example/golden.git",
    credentialsUsername: null,
    credentialsCiphertext: null,
    syncState: "idle",
    nextSyncAt: T0 + 28800,
    lastSyncAt: T0,
    lastError: null,
    createdAt: new Date(T0 * 1000),
    updatedAt: new Date((T0 + 60) * 1000),
  });
}

/**
 * The wave-11 review fixtures for the PR-detail goldens: morgan carries a
 * REQUEST row and an APPROVED row on alice/golden's PR (the sidebar
 * Reviewers section renders them — one item per row, upstream's
 * CurrentPullReviewers shape). Direct `pull_reviews` inserts (no comments,
 * no counter changes — the timeline and tab counts stay byte-stable), every
 * timestamp pinned to T0-derived values. Runs AFTER the org seed (morgan is
 * the org owner's user row). Idempotent by the per-issue row presence.
 */
async function seedGoldenPullReviews(): Promise<void> {
  const db = drizzle(env.DB);
  const repo = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "golden")))
    .get();
  const morgan = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "morgan")).get();
  if (repo === undefined || morgan === undefined) throw new Error("golden review fixture rows missing");
  const pr = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.repoId, repo.id), eq(issues.isPull, true)))
    .get();
  if (pr === undefined) throw new Error("golden PR row missing before review seeding");
  const existing = await db.select({ id: pullReviews.id }).from(pullReviews).where(eq(pullReviews.issueId, pr.id)).all();
  if (existing.length > 0) return;
  await db.insert(pullReviews).values([
    { type: 4, reviewerId: morgan.id, issueId: pr.id, content: "", official: false, createdAt: new Date((T0 + 55) * 1000), updatedAt: new Date((T0 + 55) * 1000) },
    { type: 1, reviewerId: morgan.id, issueId: pr.id, content: "Seeded approval.", official: false, createdAt: new Date((T0 + 56) * 1000), updatedAt: new Date((T0 + 56) * 1000) },
  ]);
}

/** Idempotent seeding for both files (goldens.test.ts + a11y.test.ts). */
export function setupGoldenFixtures(): void {
  beforeAll(async () => {
    if (seeded) return;
    seeded = true;
    await applyAuthD1Migrations();
    for (const slug of ["golden", "golden-alt", "golden-ms"]) {
      await ensureSeededRepo({
        owner: "alice",
        slug,
        commits: slug === "golden" ? GOLDEN_COMMITS : slug === "golden-alt" ? ALT_COMMITS : GOLDEN_MS_COMMITS,
        tags: slug === "golden" ? [{ name: "v1", commitIndex: 1 }] : undefined,
      });
      // The shell renders the row's `created_at` ("Created <relative-time…>");
      // fresh rows stamp unixepoch(), which would put wall-clock time into
      // the goldens. Pin it to the fixed epoch — determinism is a fixture
      // property (§5.2), the shell renders whatever the row carries.
      await drizzle(env.DB)
        .update(repositories)
        .set({ createdAt: new Date(T0 * 1000) })
        .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, slug)));
    }
    // Wave 7: the user-profile golden renders alice's "Joined on" from her
    // users row — pin it to the fixed epoch like the repo rows (seedVerifiedUser
    // stamps wall-clock createdAt; §5.2 determinism is a fixture property).
    const alice = await drizzle(env.DB)
      .select({ id: users.id })
      .from(users)
      .where(eq(users.usernameLower, "alice"))
      .get();
    if (alice === undefined) throw new Error("golden owner row missing before the createdAt pin");
    await drizzle(env.DB).update(users).set({ createdAt: new Date(T0 * 1000) }).where(eq(users.id, alice.id));
    await seedGoldenIssues();
    await seedGoldenPullDiff();
    await seedGoldenOrg();
    await seedGoldenMilestones();
    await seedGoldenDashboard();
    await seedGoldenMirror();
    // Wave-11: the PR-detail goldens' review rows (morgan requested +
    // approved on golden's PR) — after the org seed that creates morgan.
    await seedGoldenPullReviews();
    // Wave 7: the user-profile golden renders the shared/repo/list rows'
    // "Updated {TimeSince}" from `repositories.updated_at` — the issue and
    // milestone seeders above stamp it with wall-clock time (the counter-
    // maintenance batches). Pin alice's rows to the fixed epoch like the
    // createdAt pins (§5.2: determinism is a fixture property; the repo-
    // scoped goldens never read this column, so they are unaffected).
    await drizzle(env.DB)
      .update(repositories)
      .set({ updatedAt: new Date(T0 * 1000) })
      .where(eq(repositories.ownerNamespace, "alice"));
  });
}
