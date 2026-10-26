/**
 * Pages wave 25 route tests — the UI-parity survey's TOP-2 dispatchable
 * rows (docs/compat/ui-parity-survey.md, the regenerated edition):
 *
 *   - `GET .../tags` (survey family C, web.go:1493-1496) — the tags listing
 *     over the ENGINE ref universe (the repoListTags API's read), the
 *     release-coupled Detail/New-Release links, `?q=` filter, the MustBeNotEmpty
 *     empty-repo 404, and the release_tag_header menu's Tags item this wave
 *     adds to the releases page;
 *   - `GET .../labels` + the `/labels/{new,edit,delete}` writes (survey
 *     family D, web.go:1338 + web.go:1417-1422) — the repo labels management
 *     page over the landed repo-label family, the writer-gated write trio
 *     (anonymous 303s onto login, archived/non-writer 404-shells), the
 *     org-labels section on an org-owned repo, the silent `?sort=`, and the
 *     milestones navbar's reciprocal Labels item.
 *
 * Fixture recipe mirrors pages-wave16 (engine content) + pages-wave24 (D1
 * rows through the landed services): tags pushed through the REAL receive
 * flow (testing/seed-repo.ts's tag support), labels riding createRepoLabel,
 * the release-backed tag through the landed IssuesService.createRelease,
 * identities riding minted session cookies, POSTs carrying the same-origin
 * Origin header.
 */

import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { addOrUpdateCollaborator } from "../../api/services/repo-collaborators";
import { createRepoLabel, listRepoLabels } from "../../api/services/labels";
import { createOrgLabel } from "../../api/services/labels-t2";
import { repositories } from "../../db/schema";
import { IssuesService } from "../../issues/service";
import { OrgService } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { runA11y } from "./a11y";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const withCookie = (path: string, cookie: string): RequestInit => ({
  headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
});

const formPost = (path: string, body: Record<string, string>, cookie: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    origin: "https://test.local",
    cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
  },
  body: new URLSearchParams(body).toString(),
});

// --- fixtures -----------------------------------------------------------------

const WAVE25_COMMITS: SeedCommit[] = [
  { message: "seed: first", time: T0, files: [{ path: "README.md", content: "# wave25\n\nTags fixture.\n" }] },
  { message: "seed: second", time: T0 + 60, files: [{ path: "README.md", content: "# wave25\n\nTags fixture, second.\n" }] },
];

interface Wave25Fixture {
  ownerCookie: string; // wave25-owner — owns labeled
  writerCookie: string; // wave25-writer — write collaborator on labeled
  readCookie: string; // wave25-read — read collaborator on labeled
  orgOwnerCookie: string; // wave25-orgowner — owns wave25org/canvas
  labeledId: string;
  canvasId: string;
  bugLabelId: number;
  questionLabelId: number;
  tips: string[];
}

let wave25Fixture: Wave25Fixture | null = null;

async function ensureWave25Fixtures(): Promise<Wave25Fixture> {
  if (wave25Fixture !== null) return wave25Fixture;
  await applyAuthD1Migrations();

  const owner = await seedVerifiedUser({ username: "wave25-owner" });
  const writer = await seedVerifiedUser({ username: "wave25-writer" });
  const read = await seedVerifiedUser({ username: "wave25-read" });
  const orgOwner = await seedVerifiedUser({ username: "wave25-orgowner" });

  const now = new Date(1_700_000_000 * 1000);
  const service = new RepoService(env.DB);

  // The engine-content repo: two commits + two lightweight tags through the
  // REAL receive flow (v1.0.0 on the first commit, v2.0.0-rc on the second).
  // The push-create makes the D1 row; ensureSeededRepo settles it and flips
  // it public (§2.5.2).
  const seeded = await ensureSeededRepo({
    owner: "wave25-owner",
    slug: "labeled",
    commits: WAVE25_COMMITS,
    tags: [
      { name: "v1.0.0", commitIndex: 0 },
      { name: "v2.0.0-rc", commitIndex: 1 },
    ],
  });

  const labeledRow = await drizzle(env.DB)
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "wave25-owner"), eq(repositories.slug, "labeled")))
    .get();
  if (labeledRow === undefined) throw new Error("wave25 labeled row missing");

  // The org-owned repo (D1-only — the labels page reads no git data).
  const org = await new OrgService(env.DB).createOrg({
    name: "wave25org",
    ownerId: orgOwner.id,
    visibility: "public",
    fullName: "Wave 25 Org",
    now,
  });
  const canvas = await service.create({
    owner: { id: org.id, usernameLower: "wave25org" },
    name: "canvas",
    isPrivate: false,
    status: "ready",
  });

  // The collaborators: write + read on labeled.
  await addOrUpdateCollaborator(env.DB, labeledRow.id, writer.id, "write", now);
  await addOrUpdateCollaborator(env.DB, labeledRow.id, read.id, "read", now);

  // The labels: two repo labels on labeled (default alphabetical order),
  // one org label on wave25org.
  const bug = await createRepoLabel(env.DB, labeledRow.id, {
    name: "bug",
    exclusive: false,
    color: "#ee0701",
    description: "Something is broken",
    isArchived: false,
    now,
  });
  await createRepoLabel(env.DB, labeledRow.id, {
    name: "enhancement",
    exclusive: false,
    color: "#84b6eb",
    description: "",
    isArchived: false,
    now,
  });
  const question = await createRepoLabel(env.DB, labeledRow.id, {
    name: "question",
    exclusive: false,
    color: "#cc317c",
    description: "Further information is requested",
    isArchived: false,
    now,
  });
  await createOrgLabel(env.DB, org.id, { name: "org-wide", exclusive: false, color: "#5319e7", description: "" });

  // The release-backed tag: v1.0.0 gains a REAL release row (the landed
  // create arm) — the tags page's Detail arm; v2.0.0-rc stays tag-only (the
  // New Release arm).
  await new IssuesService(env.DB).createRelease({
    repoId: labeledRow.id,
    publisherId: owner.id,
    tagName: "v1.0.0",
    target: "main",
    title: "Wave 25 v1",
    note: "The tagged release.",
    isDraft: false,
    isPrerelease: false,
    now,
  });

  wave25Fixture = {
    ownerCookie: await mintSession(env.DB, owner.id),
    writerCookie: await mintSession(env.DB, writer.id),
    readCookie: await mintSession(env.DB, read.id),
    orgOwnerCookie: await mintSession(env.DB, orgOwner.id),
    labeledId: labeledRow.id,
    canvasId: canvas.id,
    bugLabelId: bug.id,
    questionLabelId: question.id,
    tips: seeded.tips,
  };
  return wave25Fixture;
}

beforeAll(async () => {
  await ensureWave25Fixtures();
});

// --- the parser claims (the route registry's shape contract) --------------------

describe("wave-25 parser claims", () => {
  it("claims exactly the tags and repo-labels shapes", () => {
    expect(parseUiRoute("/wave25-owner/labeled/tags")).toEqual({
      family: "tags",
      owner: "wave25-owner",
      repo: "labeled",
    });
    expect(parseUiRoute("/wave25-owner/labeled/labels")).toEqual({
      family: "repo-labels",
      owner: "wave25-owner",
      repo: "labeled",
    });
    expect(parseUiRoute("/wave25-owner/labeled/labels/new")).toEqual({
      family: "repo-label-new",
      owner: "wave25-owner",
      repo: "labeled",
    });
    expect(parseUiRoute("/wave25-owner/labeled/labels/edit")).toEqual({
      family: "repo-label-edit",
      owner: "wave25-owner",
      repo: "labeled",
    });
    expect(parseUiRoute("/wave25-owner/labeled/labels/delete")).toEqual({
      family: "repo-label-delete",
      owner: "wave25-owner",
      repo: "labeled",
    });
    // The sibling shapes stay unclaimed (the engine's 404): the /tags/list
    // aux JSON, the .rss feed tail, the /tags/delete write, the
    // /labels/initialize template loader and any deeper label tail.
    expect(parseUiRoute("/wave25-owner/labeled/tags/list")).toBeNull();
    expect(parseUiRoute("/wave25-owner/labeled/tags.rss")).toBeNull();
    expect(parseUiRoute("/wave25-owner/labeled/tags/delete")).toBeNull();
    expect(parseUiRoute("/wave25-owner/labeled/labels/initialize")).toBeNull();
    expect(parseUiRoute("/wave25-owner/labeled/labels/other")).toBeNull();
    expect(parseUiRoute("/wave25-owner/labeled/tags/extra")).toBeNull();
    // handlesUiRoute (the dispatcher's gate) answers the same.
    expect(handlesUiRoute("/wave25-owner/labeled/tags")).toBe(true);
    expect(handlesUiRoute("/wave25-owner/labeled/labels")).toBe(true);
    expect(handlesUiRoute("/wave25-owner/labeled/labels/new")).toBe(true);
    expect(handlesUiRoute("/wave25-owner/labeled/tags/list")).toBe(false);
    // The wave-14 org literal keeps its second-segment claim: a TWO-segment
    // /{owner}/labels is the org page, never the repo page.
    expect(parseUiRoute("/wave25-owner/labels")).toEqual({ family: "org-labels", owner: "wave25-owner" });
  });
});

// --- the tags page ---------------------------------------------------------------

describe("tags page /{owner}/{repo}/tags", () => {
  it("the anonymous list renders the header menu, the count, and both link arms", async () => {
    const fixture = await ensureWave25Fixtures();
    const res = await fetchUi("/wave25-owner/labeled/tags");
    expect(res.status).toBe(200);
    const html = await res.text();
    // The template's pageClass + the release_tag_header compact menu
    // (Releases item, Tags active).
    expect(html).toContain('class="page-content repository tags"');
    expect(html).toContain('href="/wave25-owner/labeled/releases"');
    expect(html).toContain('class="active item" href="/wave25-owner/labeled/tags"');
    expect(html).toContain("1 Release");
    expect(html).toContain("2 Tags");
    // The count header carries the FILTERED (unfiltered here) count.
    expect(html).toContain("2 Tags</h3>");
    // The release-backed tag links onto the release detail (upstream's
    // canReadReleases arm — the row exists) and carries the Detail link;
    // the tag-only tag falls to upstream's OWN else-arm target (the landed
    // release detail 404s tag-only rows — the module header).
    expect(html).toContain('href="/wave25-owner/labeled/releases/tag/v1.0.0"');
    expect(html).not.toContain('href="/wave25-owner/labeled/releases/tag/v2.0.0-rc"');
    expect(html).toContain('href="/wave25-owner/labeled/src/tag/v2.0.0-rc"');
    expect(html).toContain("Detail");
    // The commit links resolve to the seeded tips (short-sha line, full oid
    // in the href).
    expect(html).toContain(`href="/wave25-owner/labeled/src/commit/${fixture.tips[0]}"`);
    expect(html).toContain(`href="/wave25-owner/labeled/src/commit/${fixture.tips[1]}"`);
    // The anonymous viewer holds no CanCreateRelease — no New Release links.
    expect(html).not.toContain("/releases/new?tag=");
    // No archive or delete-tag dead links (the module header's reductions).
    expect(html).not.toContain("archive/");
    expect(html).not.toContain("tags/delete");
  });

  it("the writer sees the per-row New Release link on the tag-only tag", async () => {
    const fixture = await ensureWave25Fixtures();
    const res = await fetchUi("/wave25-owner/labeled/tags", withCookie("/wave25-owner/labeled/tags", fixture.writerCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/wave25-owner/labeled/releases/new?tag=v2.0.0-rc"');
    expect(html).toContain("New Release");
    // The release-backed tag keeps the Detail arm, never the create link.
    expect(html).not.toContain("/releases/new?tag=v1.0.0");
  });

  it("the reader collaborator sees neither the create link nor edit controls", async () => {
    const fixture = await ensureWave25Fixtures();
    const res = await fetchUi("/wave25-owner/labeled/tags", withCookie("/wave25-owner/labeled/tags", fixture.readCookie));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("/releases/new?tag=");
  });

  it("the q filter narrows the rows and the count; an unknown q renders the no-results arm", async () => {
    await ensureWave25Fixtures();
    const filtered = await fetchUi("/wave25-owner/labeled/tags?q=v1");
    expect(filtered.status).toBe(200);
    const filteredHtml = await filtered.text();
    expect(filteredHtml).toContain("1 Tag</h3>");
    expect(filteredHtml).toContain("v1.0.0");
    expect(filteredHtml).not.toContain("v2.0.0-rc");
    const empty = await fetchUi("/wave25-owner/labeled/tags?q=zzz");
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain("No results found.");
  });

  it("an empty repo 404-shells (the group's MustBeNotEmpty gate) and deeper tails stay engine-owned", async () => {
    await ensureWave25Fixtures();
    const service = new RepoService(env.DB);
    const owner = await seedVerifiedUser({ username: "wave25-hollow" });
    await service.create({
      owner: { id: owner.id, usernameLower: "wave25-hollow" },
      name: "hollow",
      isPrivate: false,
      status: "ready",
    });
    expect((await fetchUi("/wave25-hollow/hollow/tags")).status).toBe(404);
    expect((await fetchUi("/wave25-owner/labeled/tags/list")).status).toBe(404);
    expect((await fetchUi("/wave25-owner/labeled/tags/extra")).status).toBe(404);
  });
});

// --- the shared nav entry points -------------------------------------------------

describe("wave-25 nav entry points", () => {
  it("the releases page's header menu carries the Tags item (the additive hunk)", async () => {
    await ensureWave25Fixtures();
    const res = await fetchUi("/wave25-owner/labeled/releases");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/wave25-owner/labeled/tags"');
  });

  it("the milestones page's issue-navbar carries the Labels item (the additive hunk)", async () => {
    await ensureWave25Fixtures();
    const res = await fetchUi("/wave25-owner/labeled/milestones");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('href="/wave25-owner/labeled/labels"');
  });

  it("the new-release form prefills the tag name from ?tag= (the tags page's create link)", async () => {
    const fixture = await ensureWave25Fixtures();
    const res = await fetchUi(
      "/wave25-owner/labeled/releases/new?tag=v2.0.0-rc",
      withCookie("/wave25-owner/labeled/releases/new", fixture.writerCookie),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('value="v2.0.0-rc"');
  });
});

// --- the labels page -------------------------------------------------------------

describe("labels page /{owner}/{repo}/labels", () => {
  it("the anonymous list renders the rows and count but no write controls", async () => {
    const fixture = await ensureWave25Fixtures();
    const res = await fetchUi("/wave25-owner/labeled/labels");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content repository labels"');
    expect(html).toContain("3 labels</h3>");
    // The rows: badge text, description, the LIVE issues-facet anchor.
    expect(html).toContain("bug");
    expect(html).toContain("Something is broken");
    expect(html).toContain(`href="/wave25-owner/labeled/issues?labels=${fixture.bugLabelId}"`);
    expect(html).toContain("open issues/pull requests");
    // The issue-navbar with both items (Labels active).
    expect(html).toContain('class="active item" href="/wave25-owner/labeled/labels"');
    expect(html).toContain('href="/wave25-owner/labeled/milestones"');
    // No write controls for the anonymous viewer.
    expect(html).not.toContain('action="/wave25-owner/labeled/labels/new"');
    expect(html).not.toContain('action="/wave25-owner/labeled/labels/edit"');
    expect(html).not.toContain('action="/wave25-owner/labeled/labels/delete"');
  });

  it("the read collaborator still sees no write controls", async () => {
    const fixture = await ensureWave25Fixtures();
    const res = await fetchUi("/wave25-owner/labeled/labels", withCookie("/wave25-owner/labeled/labels", fixture.readCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('action="/wave25-owner/labeled/labels/new"');
    expect(html).not.toContain("labels/edit");
  });

  it("the REPO OWNER via the session path sees the New Label form and the per-row controls (REDEPLOY12 open issue 3)", async () => {
    // The production observation's exact shape: the signed-in repo owner
    // mounting GET /{owner}/{repo}/labels through the REAL session →
    // resolveViewer → sessionRepoGrant path (minted gitea_session cookie,
    // uiRouter.fetch — nothing fixture-shaped). The writer-collaborator test
    // below exercises the collaborator ROW arm of canWriteRepository; this
    // pins the OWNER arm (repositoryPermissions' isRepositoryOwner
    // short-circuit: session username folded vs repositories.owner_namespace)
    // — the arm production's probe exercised and the suite never did.
    const fixture = await ensureWave25Fixtures();
    const res = await fetchUi("/wave25-owner/labeled/labels", withCookie("/wave25-owner/labeled/labels", fixture.ownerCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    // The writer-only create arm: the navbar button anchor AND the inline
    // two-field form with its default color.
    expect(html).toContain('class="ui small primary new-label button"');
    expect(html).toContain('id="new-label"');
    expect(html).toContain('action="/wave25-owner/labeled/labels/new"');
    expect(html).toContain('value="#70c24a"');
    // The per-row edit/delete controls ride the same grant.
    expect(html).toContain('action="/wave25-owner/labeled/labels/edit"');
    expect(html).toContain('action="/wave25-owner/labeled/labels/delete"');
  });

  it("a PAT Authorization header is anonymous on the page surface (SPEC-0010 §2.9) — the probe's exact request shape", async () => {
    // The REDEPLOY12 probe authenticated the production page GETs with the
    // minted PAT as an Authorization header (the block's http.extraHeader
    // pattern). The UI viewer seam reads ONLY the gitea_session cookie
    // (upstream-accurate: tokens authorize /api/v1 + git-HTTP, never the web
    // pages), so such a request resolves ANONYMOUS and the writer form
    // correctly stays off a 200 page — the fixture-vs-production seam
    // divergence behind the "form absent" observation. Pin the boundary.
    await ensureWave25Fixtures();
    const patHolder = await seedVerifiedUser({ username: "wave25-pat" });
    const pat = (await mintFor(patHolder.id, "wave25-labels-page-probe-shape", "write:repository")).plaintext;
    // `all`-scoped even: the header authorizes the API, never the pages —
    // the surface split is structural (resolveViewer reads only the cookie),
    // so the strongest token still renders the anonymous page.
    const res = await fetchUi("/wave25-owner/labeled/labels", {
      headers: { authorization: basicTokenHeader(pat) },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content repository labels"');
    expect(html).not.toContain('action="/wave25-owner/labeled/labels/new"');
  });

  it("the writer sees the New Label form and the per-row edit/delete controls", async () => {
    const fixture = await ensureWave25Fixtures();
    const res = await fetchUi("/wave25-owner/labeled/labels", withCookie("/wave25-owner/labeled/labels", fixture.writerCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/wave25-owner/labeled/labels/new"');
    expect(html).toContain('action="/wave25-owner/labeled/labels/edit"');
    expect(html).toContain(`name="id" value="${fixture.bugLabelId}"`);
    expect(html).toContain('action="/wave25-owner/labeled/labels/delete"');
    // The create form's default color (the modal's value).
    expect(html).toContain('value="#70c24a"');
  });

  it("an org-owned repo renders the upstream OrgLabels section; the owner sees the manage link", async () => {
    const fixture = await ensureWave25Fixtures();
    const outsider = await fetchUi("/wave25org/canvas/labels");
    expect(outsider.status).toBe(200);
    const outsiderHtml = await outsider.text();
    expect(outsiderHtml).toContain("Organization-level labels");
    expect(outsiderHtml).toContain("org-wide");
    expect(outsiderHtml).not.toContain('href="/wave25org/labels"');

    const ownerRes = await fetchUi("/wave25org/canvas/labels", withCookie("/wave25org/canvas/labels", fixture.orgOwnerCookie));
    expect(ownerRes.status).toBe(200);
    const ownerHtml = await ownerRes.text();
    expect(ownerHtml).toContain('href="/wave25org/labels"');
    // The org rows render no edit/delete controls even for the org owner
    // (upstream's $canEditLabel is the repo write grant, and canvas has no
    // repo labels — the only rows are org rows).
    expect(ownerHtml).not.toContain("/labels/edit");
    expect(ownerHtml).not.toContain("/labels/delete");
  });

  it("the silent sort query reorders the list (the landed list arm's reading)", async () => {
    await ensureWave25Fixtures();
    const reversed = await fetchUi("/wave25-owner/labeled/labels?sort=reversealphabetically");
    expect(reversed.status).toBe(200);
    const html = await reversed.text();
    expect(html.indexOf("question")).toBeLessThan(html.indexOf("enhancement"));
    const plain = await fetchUi("/wave25-owner/labeled/labels");
    const plainHtml = await plain.text();
    expect(plainHtml.indexOf("enhancement")).toBeLessThan(plainHtml.indexOf("question"));
  });
});

// --- the label writes ------------------------------------------------------------

describe("repo label writes", () => {
  const basePath = "/wave25-owner/labeled/labels";

  it("the create write 303s and renders the new label; the refusals re-render at 200", async () => {
    const fixture = await ensureWave25Fixtures();
    const added = await fetchUi(`${basePath}/new`, formPost(basePath, { title: "wave25-created", color: "#00aabb" }, fixture.writerCookie));
    expect(added.status).toBe(303);
    expect(added.headers.get("location")).toBe(basePath);
    const after = await fetchUi(basePath, withCookie(basePath, fixture.writerCookie));
    expect(await after.text()).toContain("wave25-created");

    const badColor = await fetchUi(`${basePath}/new`, formPost(basePath, { title: "nope", color: "zztop" }, fixture.writerCookie));
    expect(badColor.status).toBe(200);
    // The arm's exact message — the normalized string as Go's %s prints it
    // ("zztop" is 5 chars, so no implicit '#' gets prepended).
    expect(await badColor.text()).toContain("invalid color: zztop");

    const noTitle = await fetchUi(`${basePath}/new`, formPost(basePath, { title: "", color: "#00aabb" }, fixture.writerCookie));
    expect(noTitle.status).toBe(200);
    expect(await noTitle.text()).toContain("Label name cannot be empty.");
  });

  it("the create write 303s anonymous onto login and 404-shells non-writers", async () => {
    const fixture = await ensureWave25Fixtures();
    const anon = await fetchUi(`${basePath}/new`, formPost(basePath, { title: "x", color: "#00aabb" }, ""));
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent(`${basePath}/new`)}`);
    const reader = await fetchUi(`${basePath}/new`, formPost(basePath, { title: "x", color: "#00aabb" }, fixture.readCookie));
    expect(reader.status).toBe(404);
    const count = await listRepoLabels(env.DB, fixture.labeledId, "", 1, 50);
    expect(count.total).toBe(4); // bug, enhancement, question, wave25-created — nothing new
  });

  it("the edit write renames and recolors; a missing or foreign id 404-shells", async () => {
    const fixture = await ensureWave25Fixtures();
    const edited = await fetchUi(
      `${basePath}/edit`,
      formPost(basePath, { id: String(fixture.bugLabelId), title: "bug-renamed", color: "#ff0000" }, fixture.writerCookie),
    );
    expect(edited.status).toBe(303);
    const after = await fetchUi(basePath, withCookie(basePath, fixture.writerCookie));
    expect(await after.text()).toContain("bug-renamed");

    const missing = await fetchUi(
      `${basePath}/edit`,
      formPost(basePath, { id: "999999", title: "ghost", color: "#ff0000" }, fixture.writerCookie),
    );
    expect(missing.status).toBe(404);

    // A label from ANOTHER repo never matches the repo-scoped lookup.
    const foreign = await createRepoLabel(env.DB, fixture.canvasId, {
      name: "canvas-only",
      exclusive: false,
      color: "#5319e7",
      description: "",
      isArchived: false,
      now: new Date(),
    });
    const foreignEdit = await fetchUi(
      `${basePath}/edit`,
      formPost(basePath, { id: String(foreign.id), title: "hijack", color: "#ff0000" }, fixture.writerCookie),
    );
    expect(foreignEdit.status).toBe(404);
  });

  it("the delete write removes the label and is idempotent for absent rows", async () => {
    const fixture = await ensureWave25Fixtures();
    const removed = await fetchUi(`${basePath}/delete`, formPost(basePath, { id: String(fixture.questionLabelId) }, fixture.writerCookie));
    expect(removed.status).toBe(303);
    expect(removed.headers.get("location")).toBe(basePath);
    const after = await fetchUi(basePath, withCookie(basePath, fixture.writerCookie));
    const html = await after.text();
    expect(html).not.toContain("Further information is requested");
    expect(html).toContain("3 labels</h3>"); // bug-renamed, enhancement, wave25-created

    const again = await fetchUi(`${basePath}/delete`, formPost(basePath, { id: String(fixture.questionLabelId) }, fixture.writerCookie));
    expect(again.status).toBe(303);
  });

  it("the POST-only write tails answer GET with 405", async () => {
    await ensureWave25Fixtures();
    expect((await fetchUi(`${basePath}/new`)).status).toBe(405);
    expect((await fetchUi(`${basePath}/edit`)).status).toBe(405);
    expect((await fetchUi(`${basePath}/delete`)).status).toBe(405);
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("wave-25 a11y smoke", () => {
  it("the new renders pass the structural rules", async () => {
    const fixture = await ensureWave25Fixtures();
    for (const [path, init] of [
      ["/wave25-owner/labeled/tags", undefined],
      ["/wave25-owner/labeled/tags?q=v1", undefined],
      ["/wave25-owner/labeled/tags", withCookie("/wave25-owner/labeled/tags", fixture.writerCookie)],
      ["/wave25-owner/labeled/labels", undefined],
      ["/wave25-owner/labeled/labels", withCookie("/wave25-owner/labeled/labels", fixture.writerCookie)],
      ["/wave25org/canvas/labels", withCookie("/wave25org/canvas/labels", fixture.orgOwnerCookie)],
    ] as Array<[string, RequestInit | undefined]>) {
      const res = await fetchUi(path, init);
      expect(res.status, path).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});
