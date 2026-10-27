/**
 * Pages wave 26 route tests — the UI-parity survey's TOP-3 and TOP-5
 * dispatchable rows (docs/compat/ui-parity-survey.md, the regenerated
 * edition):
 *
 *   - `GET .../milestone/{id}` + `GET|POST .../milestones/{id}/edit`
 *     (survey family D, web.go:1340 + web.go:1427-1428) — the milestone
 *     detail page (the milestone's issues+pulls list with the open/closed
 *     tabs, the "default to all when only closed issues exist" flip arm,
 *     the ?labels= facet) over the landed listRepoIssues read, the edit
 *     form with its prefilled fields and the labels-write gate (anonymous
 *     303s onto login, archived/non-writer 404-shells), and the wave-25
 *     style additive entry points: the LIST page's title links + per-row
 *     Edit link and the new-issue form's `?milestone=` preselect;
 *   - `GET|POST .../fork` (survey family C, web.go:1490) — the fork-create
 *     form (distinct from the landed forks LIST): the owner select over the
 *     doer + the can-create orgs, the name default = source name, the
 *     landed createFork sequence as the write (the 303 onto the fork's
 *     home, the existing-fork redirect arm, the empty-source 404, the
 *     signed-in gate), and the forks page's Fork entry button.
 *
 * Fixture recipe mirrors pages-wave25 (D1 rows through the landed services
 * + one engine-seeded repo): milestones/issues/labels riding the landed
 * IssuesService + label arms, identities riding minted session cookies,
 * POSTs carrying the same-origin Origin header.
 *
 * w129 additions (wave-polish-matrix-6, 2026-10-27) — the fork form's
 * owner-select arms, appended as the trailing w129 describe on self-contained
 * wave129-* fixtures (the committed wave26 fixtures stay untouched): the
 * strict load predicate's REFUSAL arms — the doer who already forked loses
 * his option into the no-valid-owners render, the HasForkedRepo org filter
 * dropping an org that holds a fork, the canCreateOrgRepo refusal hiding a
 * grant-less member's org — and the write's re-gates the GET never shows:
 * the blocked-by-source-owner arm (ForkRepository's blocked check), the
 * target-owner name collision (IsErrRepoAlreadyExist's re-render), and the
 * ContextUser fallback preselecting the first org for a source owner.
 */

import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { addOrUpdateCollaborator } from "../../api/services/repo-collaborators";
import { BLOCKED_USER_MESSAGE, blockPartyFromUserRow, blockUser } from "../../api/services/blocks";
import { createRepoLabel } from "../../api/services/labels";
import { createRepoMilestone } from "../../api/services/milestones";
import { milestones, repositories, users } from "../../db/schema";
import { IssuesService } from "../../issues/service";
import { OrgService } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { runA11y } from "./a11y";
import { uiEnv } from "./harness";

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

const WAVE26_COMMITS: SeedCommit[] = [
  { message: "seed: first", time: 1_700_000_000, files: [{ path: "README.md", content: "# wave26\n\nMilestones fixture.\n" }] },
];

interface Wave26Fixture {
  ownerCookie: string; // wave26-owner — owns tracked
  writerCookie: string; // wave26-writer — write collaborator on tracked
  readCookie: string; // wave26-read — read collaborator on tracked
  forkerCookie: string; // wave26-forker — outsider; forks tracked
  orgOwnerCookie: string; // wave26-orgowner — owns wave26org
  orgOwner2Cookie: string; // wave26-orgowner2 — owns wave26org2
  trackedId: string;
  openMilestoneId: number;
  closedMilestoneId: number;
  emptyMilestoneId: number;
  bugLabelId: number;
  openIssueIndexes: number[];
  closedIssueIndex: number;
  emptyClosedIssueId: number;
}

let wave26Fixture: Wave26Fixture | null = null;

async function ensureWave26Fixtures(): Promise<Wave26Fixture> {
  if (wave26Fixture !== null) return wave26Fixture;
  await applyAuthD1Migrations();

  const owner = await seedVerifiedUser({ username: "wave26-owner" });
  const writer = await seedVerifiedUser({ username: "wave26-writer" });
  const read = await seedVerifiedUser({ username: "wave26-read" });
  const forker = await seedVerifiedUser({ username: "wave26-forker" });
  const orgOwner = await seedVerifiedUser({ username: "wave26-orgowner" });
  const orgOwner2 = await seedVerifiedUser({ username: "wave26-orgowner2" });

  const now = new Date(1_700_000_000 * 1000);
  const service = new RepoService(env.DB);

  // The engine-content repo (the fork form's non-empty source; the milestone
  // pages read D1 only).
  await ensureSeededRepo({
    owner: "wave26-owner",
    slug: "tracked",
    commits: WAVE26_COMMITS,
  });

  const trackedRow = await drizzle(env.DB)
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "wave26-owner"), eq(repositories.slug, "tracked")))
    .get();
  if (trackedRow === undefined) throw new Error("wave26 tracked row missing");
  const repoId = trackedRow.id;

  // The collaborators: write + read on tracked.
  await addOrUpdateCollaborator(env.DB, repoId, writer.id, "write", now);
  await addOrUpdateCollaborator(env.DB, repoId, read.id, "read", now);

  // The orgs: two, each owned by its creator (the owner team carries the
  // repo-create grant — the fork form's org options; the ids are read from
  // the users table in the org-arm test below).
  await new OrgService(env.DB).createOrg({
    name: "wave26org",
    ownerId: orgOwner.id,
    visibility: "public",
    fullName: "Wave 26 Org",
    now,
  });
  await new OrgService(env.DB).createOrg({
    name: "wave26org2",
    ownerId: orgOwner2.id,
    visibility: "public",
    fullName: "Wave 26 Org Two",
    now,
  });

  // The milestones: an open one (past deadline — the overdue arm), a closed
  // one, and an issues-empty one... with one CLOSED issue (the flip arm).
  const issues = new IssuesService(env.DB);
  const openMilestone = await createRepoMilestone(issues, repoId, {
    title: "v1.0",
    description: "The first milestone.",
    deadlineAt: new Date("2020-06-15T23:59:59Z"),
    state: "open",
    now,
  });
  const closedMilestone = await createRepoMilestone(issues, repoId, {
    title: "v2.0",
    description: "",
    deadlineAt: null,
    state: "closed",
    now,
  });

  const bug = await createRepoLabel(env.DB, repoId, {
    name: "bug",
    exclusive: false,
    color: "#ee0701",
    description: "Something is broken",
    isArchived: false,
    now,
  });

  const open1 = await issues.createIssue({
    repoId,
    title: "open one",
    posterId: owner.id,
    milestoneId: openMilestone.id,
    now,
  });
  const open2 = await issues.createIssue({
    repoId,
    title: "open two",
    posterId: owner.id,
    milestoneId: openMilestone.id,
    labelIds: [bug.id],
    now,
  });
  const closedIssue = await issues.createIssue({
    repoId,
    title: "done already",
    posterId: owner.id,
    milestoneId: openMilestone.id,
    now,
  });
  await issues.closeIssue(closedIssue.id, { actorId: owner.id, now });

  // The flip arm's fixture: a milestone holding ONLY a closed issue.
  const emptyMilestone = await createRepoMilestone(issues, repoId, {
    title: "archive-ms",
    description: "",
    deadlineAt: null,
    state: "open",
    now,
  });
  const emptyClosed = await issues.createIssue({
    repoId,
    title: "only closed here",
    posterId: owner.id,
    milestoneId: emptyMilestone.id,
    now,
  });
  await issues.closeIssue(emptyClosed.id, { actorId: owner.id, now });

  // A D1-only EMPTY repo (the fork form's IsEmpty 404 arm).
  const hollowOwner = await seedVerifiedUser({ username: "wave26-hollow" });
  await service.create({
    owner: { id: hollowOwner.id, usernameLower: "wave26-hollow" },
    name: "hollow",
    isPrivate: false,
    status: "ready",
  });

  wave26Fixture = {
    ownerCookie: await mintSession(env.DB, owner.id),
    writerCookie: await mintSession(env.DB, writer.id),
    readCookie: await mintSession(env.DB, read.id),
    forkerCookie: await mintSession(env.DB, forker.id),
    orgOwnerCookie: await mintSession(env.DB, orgOwner.id),
    orgOwner2Cookie: await mintSession(env.DB, orgOwner2.id),
    trackedId: repoId,
    openMilestoneId: openMilestone.id,
    closedMilestoneId: closedMilestone.id,
    emptyMilestoneId: emptyMilestone.id,
    bugLabelId: bug.id,
    openIssueIndexes: [open1.index, open2.index],
    closedIssueIndex: closedIssue.index,
    emptyClosedIssueId: emptyClosed.id,
  };
  return wave26Fixture;
}

beforeAll(async () => {
  await ensureWave26Fixtures();
});

// --- the parser claims (the route registry's shape contract) --------------------

describe("wave-26 parser claims", () => {
  it("claims exactly the milestone detail, edit, and fork shapes", () => {
    expect(parseUiRoute("/wave26-owner/tracked/milestone/5")).toEqual({
      family: "milestone-detail",
      owner: "wave26-owner",
      repo: "tracked",
      id: "5",
    });
    expect(parseUiRoute("/wave26-owner/tracked/milestones/5/edit")).toEqual({
      family: "milestone-edit",
      owner: "wave26-owner",
      repo: "tracked",
      id: "5",
    });
    expect(parseUiRoute("/wave26-owner/tracked/fork")).toEqual({
      family: "repo-fork",
      owner: "wave26-owner",
      repo: "tracked",
    });
    // The sibling shapes stay unclaimed (the engine's 404): upstream's own
    // unregistered tails — the plural /milestones/{id}, the {id}/{action}
    // write, the /milestones/delete write, the singular /milestone bare and
    // /milestone/{id}/edit forms, any /fork/* tail.
    expect(parseUiRoute("/wave26-owner/tracked/milestones/5")).toBeNull();
    expect(parseUiRoute("/wave26-owner/tracked/milestones/5/close")).toBeNull();
    expect(parseUiRoute("/wave26-owner/tracked/milestones/delete")).toBeNull();
    expect(parseUiRoute("/wave26-owner/tracked/milestone")).toBeNull();
    expect(parseUiRoute("/wave26-owner/tracked/milestone/5/edit")).toBeNull();
    expect(parseUiRoute("/wave26-owner/tracked/milestone/5/extra")).toBeNull();
    expect(parseUiRoute("/wave26-owner/tracked/fork/extra")).toBeNull();
    // handlesUiRoute (the dispatcher's gate) answers the same.
    expect(handlesUiRoute("/wave26-owner/tracked/milestone/5")).toBe(true);
    expect(handlesUiRoute("/wave26-owner/tracked/milestones/5/edit")).toBe(true);
    expect(handlesUiRoute("/wave26-owner/tracked/fork")).toBe(true);
    expect(handlesUiRoute("/wave26-owner/tracked/milestones/5")).toBe(false);
    // The landed forks LIST literal keeps its family.
    expect(parseUiRoute("/wave26-owner/tracked/forks")).toEqual({ family: "forks", owner: "wave26-owner", repo: "tracked" });
  });
});

// --- the milestone detail page ----------------------------------------------------

describe("milestone detail /{owner}/{repo}/milestone/{id}", () => {
  it("the anonymous render carries the header block, tabs, and both open issues", async () => {
    const fixture = await ensureWave26Fixtures();
    const res = await fetchUi(`/wave26-owner/tracked/milestone/${fixture.openMilestoneId}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // The template's pageClass + the h1 name + the description markdown.
    expect(html).toContain('class="page-content repository milestone-issue-list"');
    expect(html).toContain("<h1 class=\"tw-flex-1 tw-m-0\">v1.0</h1>");
    expect(html).toContain("The first milestone.");
    // The progress bar + the completeness locale's strong split + the
    // overdue due-date line (red — the deadline is in the past).
    expect(html).toContain('class="milestone-progress-big"');
    expect(html).toContain("Completed");
    expect(html).toContain("tw-text-red");
    expect(html).toContain("Jun 15, 2020");
    // The tabs (neither active — upstream never sets State on this page)
    // with the milestone's unfiltered counts.
    expect(html).toContain('href="/wave26-owner/tracked/milestone/' + fixture.openMilestoneId + '?state=open"');
    expect(html).toContain('href="/wave26-owner/tracked/milestone/' + fixture.openMilestoneId + '?state=closed"');
    // The two open issue rows (the closed one stays on its tab) + the
    // New Issue button carrying the ?milestone= preselect; the anonymous
    // viewer holds no Edit button.
    expect(html).toContain("/wave26-owner/tracked/issues/" + fixture.openIssueIndexes[0]);
    expect(html).toContain("/wave26-owner/tracked/issues/" + fixture.openIssueIndexes[1]);
    expect(html).not.toContain(">done already</a>");
    expect(html).toContain(`/issues/new?milestone=${fixture.openMilestoneId}`);
    expect(html).not.toContain(`/milestones/${fixture.openMilestoneId}/edit`);
  });

  it("the state=closed tab shows the closed issue; the label badge links the labels facet", async () => {
    const fixture = await ensureWave26Fixtures();
    const closed = await fetchUi(`/wave26-owner/tracked/milestone/${fixture.openMilestoneId}?state=closed`);
    expect(closed.status).toBe(200);
    const closedHtml = await closed.text();
    expect(closedHtml).toContain(">done already</a>");
    expect(closedHtml).not.toContain(">open one</a>");

    const labeled = await fetchUi(`/wave26-owner/tracked/milestone/${fixture.openMilestoneId}?labels=${fixture.bugLabelId}`);
    expect(labeled.status).toBe(200);
    const labeledHtml = await labeled.text();
    expect(labeledHtml).toContain(">open two</a>");
    expect(labeledHtml).not.toContain(">open one</a>");
    // The badge's facet href (state implicit on the open default).
    expect(labeledHtml).toContain(`href="?labels=${fixture.bugLabelId}"`);
  });

  it("a milestone holding only closed issues flips to the all view (the default arm)", async () => {
    const fixture = await ensureWave26Fixtures();
    const res = await fetchUi(`/wave26-owner/tracked/milestone/${fixture.emptyMilestoneId}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(">only closed here</a>");
    expect(html).toContain("<strong>100%</strong> Completed");
  });

  it("the writer sees the Edit button; the reader does not", async () => {
    const fixture = await ensureWave26Fixtures();
    const writer = await fetchUi(
      `/wave26-owner/tracked/milestone/${fixture.openMilestoneId}`,
      withCookie("/wave26-owner/tracked/milestone/1", fixture.writerCookie),
    );
    expect(writer.status).toBe(200);
    expect(await writer.text()).toContain(`href="/wave26-owner/tracked/milestones/${fixture.openMilestoneId}/edit"`);

    const reader = await fetchUi(
      `/wave26-owner/tracked/milestone/${fixture.openMilestoneId}`,
      withCookie("/wave26-owner/tracked/milestone/1", fixture.readCookie),
    );
    expect(reader.status).toBe(200);
    expect(await reader.text()).not.toContain("/edit");
  });

  it("an unknown, garbage, or foreign id 404-shells", async () => {
    const fixture = await ensureWave26Fixtures();
    expect((await fetchUi("/wave26-owner/tracked/milestone/424242")).status).toBe(404);
    expect((await fetchUi("/wave26-owner/tracked/milestone/not-a-number")).status).toBe(404);
    // The id resolves repo-scoped only — the same id under another repo is
    // invisible (upstream GetMilestoneByRepoID's NotFound).
    expect((await fetchUi(`/wave26-hollow/hollow/milestone/${fixture.openMilestoneId}`)).status).toBe(404);
  });
});

// --- the milestone edit form + write ----------------------------------------------

describe("milestone edit /{owner}/{repo}/milestones/{id}/edit", () => {
  const editPath = (id: number): string => `/wave26-owner/tracked/milestones/${id}/edit`;

  it("the GET prefills the stored values for the writer; the reader 404s and anonymous 303s", async () => {
    const fixture = await ensureWave26Fixtures();
    const writer = await fetchUi(editPath(fixture.openMilestoneId), withCookie(editPath(1), fixture.writerCookie));
    expect(writer.status).toBe(200);
    const html = await writer.text();
    expect(html).toContain('class="page-content repository new milestone"');
    expect(html).toContain("Edit Milestone");
    expect(html).toContain('value="v1.0"');
    expect(html).toContain('value="2020-06-15"');
    expect(html).toContain("Update Milestone");
    expect(html).toContain('href="/wave26-owner/tracked/milestones"'); // the cancel link

    const reader = await fetchUi(editPath(fixture.openMilestoneId), withCookie(editPath(1), fixture.readCookie));
    expect(reader.status).toBe(404);

    const anon = await fetchUi(editPath(fixture.openMilestoneId));
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent(editPath(fixture.openMilestoneId))}`);
  });

  it("the POST renames and re-deadlines, 303ing back onto the list", async () => {
    const fixture = await ensureWave26Fixtures();
    const res = await fetchUi(
      editPath(fixture.openMilestoneId),
      formPost(editPath(fixture.openMilestoneId), { title: "v1.0-renamed", deadline: "2027-01-01", content: "updated" }, fixture.writerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/wave26-owner/tracked/milestones");

    const row = await drizzle(env.DB).select().from(milestones).where(eq(milestones.id, fixture.openMilestoneId)).get();
    expect(row?.name).toBe("v1.0-renamed");
    expect(row?.content).toBe("updated");
    expect(row?.deadlineAt?.toISOString()).toBe("2027-01-01T23:59:59.000Z");

    // The list renders the new name through the wave-26 title link.
    const list = await fetchUi("/wave26-owner/tracked/milestones");
    expect(await list.text()).toContain('href="/wave26-owner/tracked/milestone/' + fixture.openMilestoneId + '">v1.0-renamed</a>');
  });

  it("the invalid submissions re-render at 200 with the exact messages", async () => {
    const fixture = await ensureWave26Fixtures();
    const noTitle = await fetchUi(
      editPath(fixture.openMilestoneId),
      formPost(editPath(fixture.openMilestoneId), { title: "", deadline: "" }, fixture.writerCookie),
    );
    expect(noTitle.status).toBe(200);
    expect(await noTitle.text()).toContain("A title is required.");

    const badDeadline = await fetchUi(
      editPath(fixture.openMilestoneId),
      formPost(editPath(fixture.openMilestoneId), { title: "ok", deadline: "junk" }, fixture.writerCookie),
    );
    expect(badDeadline.status).toBe(200);
    // The apostrophes render HTML-escaped (the JSX runtime's escaping).
    expect(await badDeadline.text()).toContain("Due date format must be &#39;yyyy-mm-dd&#39;.");
  });

  it("a missing id 404-shells the write", async () => {
    const fixture = await ensureWave26Fixtures();
    const res = await fetchUi(
      editPath(999999),
      formPost(editPath(999999), { title: "ghost", deadline: "" }, fixture.writerCookie),
    );
    expect(res.status).toBe(404);
  });
});

// --- the shared nav entry points -------------------------------------------------

describe("wave-26 nav entry points", () => {
  it("the milestones LIST rows link their detail pages (the additive hunk)", async () => {
    const fixture = await ensureWave26Fixtures();
    const res = await fetchUi("/wave26-owner/tracked/milestones");
    expect(res.status).toBe(200);
    const html = await res.text();
    // The OPEN tab carries the two open milestones (the closed one lives on
    // the closed tab — the landed state filter, unchanged).
    expect(html).toContain(`href="/wave26-owner/tracked/milestone/${fixture.openMilestoneId}"`);
    expect(html).toContain(`href="/wave26-owner/tracked/milestone/${fixture.emptyMilestoneId}"`);
    expect(html).not.toContain(`milestone/${fixture.closedMilestoneId}`);
    // The closed tab renders the closed milestone's link.
    const closed = await fetchUi("/wave26-owner/tracked/milestones?state=closed");
    expect(await closed.text()).toContain(`href="/wave26-owner/tracked/milestone/${fixture.closedMilestoneId}"`);
    // The anonymous viewer holds no per-row Edit link.
    expect(html).not.toContain("/edit");
  });

  it("the writer sees the per-row Edit link on the list", async () => {
    const fixture = await ensureWave26Fixtures();
    const res = await fetchUi("/wave26-owner/tracked/milestones", withCookie("/wave26-owner/tracked/milestones", fixture.writerCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`href="/wave26-owner/tracked/milestones/${fixture.openMilestoneId}/edit"`);
    expect(html).toContain("octicon-pencil");
  });

  it("the new-issue form prefills the milestone from ?milestone= (the detail page's button)", async () => {
    const fixture = await ensureWave26Fixtures();
    const res = await fetchUi(
      `/wave26-owner/tracked/issues/new?milestone=${fixture.openMilestoneId}`,
      withCookie("/wave26-owner/tracked/issues/new", fixture.writerCookie),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`value="${fixture.openMilestoneId}" selected`);
  });

  it("the forks page carries the Fork entry button (the additive hunk)", async () => {
    const fixture = await ensureWave26Fixtures();
    // The signed-in viewer's button targets the fork form.
    const writer = await fetchUi("/wave26-owner/tracked/forks", withCookie("/wave26-owner/tracked/forks", fixture.writerCookie));
    expect(writer.status).toBe(200);
    expect(await writer.text()).toContain('href="/wave26-owner/tracked/fork"');
    // The anonymous arm lands on /login (upstream header/fork.tmpl's guest
    // arm at our SPEC-0010 literal).
    const anon = await fetchUi("/wave26-owner/tracked/forks");
    expect(await anon.text()).toContain('href="/login">Fork</a>');
  });
});

// --- the fork form ----------------------------------------------------------------

describe("fork form /{owner}/{repo}/fork", () => {
  it("anonymous 303s onto the login round-trip; an empty source 404-shells the signed-in arms", async () => {
    await ensureWave26Fixtures();
    const anon = await fetchUi("/wave26-owner/tracked/fork");
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/wave26-owner/tracked/fork")}`);
    // Upstream's group order (reqSignIn ahead of RepoAssignment) lets the
    // VISIBLE-but-empty repo redirect anonymous viewers first; the
    // signed-in arms hit getForkRepository's IsEmpty 404.
    expect((await fetchUi("/wave26-hollow/hollow/fork")).status).toBe(303);
    const hollow = await fetchUi(
      "/wave26-hollow/hollow/fork",
      withCookie("/wave26-hollow/hollow/fork", (await ensureWave26Fixtures()).forkerCookie),
    );
    expect(hollow.status).toBe(404);
    const hollowPost = await fetchUi(
      "/wave26-hollow/hollow/fork",
      formPost("/wave26-hollow/hollow/fork", { uid: "", repo_name: "x" }, (await ensureWave26Fixtures()).forkerCookie),
    );
    expect(hollowPost.status).toBe(404);
  });

  it("the GET renders the owner select, the fork-from link, and the inherited visibility", async () => {
    const fixture = await ensureWave26Fixtures();
    const res = await fetchUi("/wave26-owner/tracked/fork", withCookie("/wave26-owner/tracked/fork", fixture.forkerCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content repository new fork"');
    expect(html).toContain("New Repository Fork");
    // The doer is the only option (no orgs, not the source owner).
    expect(html).toContain('name="uid"');
    expect(html).toContain("wave26-forker");
    // Fork From links the source; the name defaults to it.
    expect(html).toContain('href="/wave26-owner/tracked"');
    expect(html).toContain('value="tracked"');
    // The visibility checkbox renders checked-DISABLED (inherited); the
    // description/branch fields are the write's copies, not rendered.
    expect(html).toContain("disabled");
    expect(html).not.toContain('name="description"');
    expect(html).not.toContain('name="fork_single_branch"');
  });

  it("the source owner without orgs sees the no-valid-owners arm", async () => {
    const fixture = await ensureWave26Fixtures();
    const res = await fetchUi("/wave26-owner/tracked/fork", withCookie("/wave26-owner/tracked/fork", fixture.ownerCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("This repository cannot be forked because there are no valid owners.");
    expect(html).toContain("ui primary button disabled");
  });

  it("the POST creates the fork through the landed sequence and 303s onto its home", async () => {
    const fixture = await ensureWave26Fixtures();
    const res = await fetchUi(
      "/wave26-owner/tracked/fork",
      formPost("/wave26-owner/tracked/fork", { uid: "", repo_name: "tracked-copy" }, fixture.forkerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/wave26-forker/tracked-copy");

    const row = await drizzle(env.DB)
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "wave26-forker"), eq(repositories.slug, "tracked-copy")))
      .get();
    expect(row?.forkParent).toBe(fixture.trackedId);
    expect(row?.status).toBe("creating");

    // The forks list now renders the fork row (the landed list read).
    const list = await fetchUi("/wave26-owner/tracked/forks");
    expect(await list.text()).toContain("tracked-copy");
  });

  it("a second POST for the same owner redirects onto the existing fork (GetUserFork)", async () => {
    const fixture = await ensureWave26Fixtures();
    const res = await fetchUi(
      "/wave26-owner/tracked/fork",
      formPost("/wave26-owner/tracked/fork", { uid: "", repo_name: "another-name" }, fixture.forkerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/wave26-forker/tracked-copy");
  });

  it("the org arm forks under the granted org; the empty name defaults to the source's", async () => {
    const fixture = await ensureWave26Fixtures();
    const db = drizzle(env.DB);
    // The orgs ARE user rows (SPEC-0007) — the id comes from the users table.
    const org = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "wave26org")).get();
    const org2 = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "wave26org2")).get();
    if (org?.id === undefined || org2?.id === undefined) {
      throw new Error("wave26 org rows missing");
    }

    const named = await fetchUi(
      "/wave26-owner/tracked/fork",
      formPost("/wave26-owner/tracked/fork", { uid: String(org.id), repo_name: "tracked-org" }, fixture.orgOwnerCookie),
    );
    expect(named.status).toBe(303);
    expect(named.headers.get("location")).toBe("/wave26org/tracked-org");

    // The default name: the empty repo_name falls to the source's slug.
    const defaulted = await fetchUi(
      "/wave26-owner/tracked/fork",
      formPost("/wave26-owner/tracked/fork", { uid: String(org2.id), repo_name: "" }, fixture.orgOwner2Cookie),
    );
    expect(defaulted.status).toBe(303);
    expect(defaulted.headers.get("location")).toBe("/wave26org2/tracked");

    const forkRow = await db
      .select({ id: repositories.id, forkParent: repositories.forkParent })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "wave26org2"), eq(repositories.slug, "tracked")))
      .get();
    expect(forkRow?.forkParent).toBe(fixture.trackedId);
  });

  it("a tampered org uid re-renders with the guard's message", async () => {
    const fixture = await ensureWave26Fixtures();
    const res = await fetchUi(
      "/wave26-owner/tracked/fork",
      formPost("/wave26-owner/tracked/fork", { uid: "999999", repo_name: "nope" }, fixture.forkerCookie),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("You are not allowed to create repositories for this owner.");
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("wave-26 a11y smoke", () => {
  it("the new renders pass the structural rules", async () => {
    const fixture = await ensureWave26Fixtures();
    for (const [path, init] of [
      [`/wave26-owner/tracked/milestone/${fixture.openMilestoneId}`, undefined],
      [`/wave26-owner/tracked/milestone/${fixture.emptyMilestoneId}`, undefined],
      [`/wave26-owner/tracked/milestones/${fixture.openMilestoneId}/edit`, withCookie("/x", fixture.writerCookie)],
      ["/wave26-owner/tracked/fork", withCookie("/x", fixture.forkerCookie)],
      ["/wave26-owner/tracked/fork", withCookie("/x", fixture.ownerCookie)],
    ] as Array<[string, RequestInit | undefined]>) {
      const res = await fetchUi(path, init);
      expect(res.status, path).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});

// --- w129 additions (wave-polish-matrix-6, 2026-10-27) ---------------------------
// The fork form's owner-select arms: the strict load predicate's refusals and
// the write's re-gates. Provenance in the file header. Every arm below seeds
// its own wave129-* users/orgs (the committed wave26 fixture is read, never
// reshaped), so the block is order-independent.

/** The users-table id of a fixture identity (orgs ARE user rows). */
async function w129UserId(username: string): Promise<number> {
  const row = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, username)).get();
  if (row === undefined) throw new Error(`w129 identity missing: ${username}`);
  return row.id;
}

describe("w129 the fork form's owner-select refusals (the strict predicate + the write's re-gates)", () => {
  it("a doer who already forked loses his option into the no-valid-owners render (the CanForkToUser drop)", async () => {
    // Provenance: wave-polish-matrix-6. wave26 pins the no-valid-owners arm
    // only for the SOURCE OWNER (no orgs); the doer-fork drop of the same
    // arm — findForkByOwner(d1, source, doer) in loadRepoForkData — was
    // unpinned. Post: uid:"" + cookie (303) → GET shows the refusal.
    const reforker = await seedVerifiedUser({ username: "wave129-refork" });
    const created = await fetchUi(
      "/wave26-owner/tracked/fork",
      formPost("/wave26-owner/tracked/fork", { uid: "", repo_name: "w129-refork-copy" }, await mintSession(env.DB, reforker.id)),
    );
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/wave129-refork/w129-refork-copy");

    const form = await fetchUi(
      "/wave26-owner/tracked/fork",
      withCookie("/wave26-owner/tracked/fork", await mintSession(env.DB, reforker.id)),
    );
    expect(form.status).toBe(200);
    const html = await form.text();
    expect(html).toContain("This repository cannot be forked because there are no valid owners.");
    expect(html).toContain("ui primary button disabled");
    expect(html).not.toContain(">wave129-refork</option>"); // the doer option is gone
  });

  it("an org holding a fork of the source drops out of the org options (HasForkedRepo), the doer option stays", async () => {
    // Provenance: wave-polish-matrix-6 — the fork-load predicate's third
    // filter (upstream fork.go's HasForkedRepo arm, the module header's
    // "MINUS … every org that already holds a fork"): wave26 pins the org
    // fork WRITE but never the option's subsequent disappearance.
    const orgForker = await seedVerifiedUser({ username: "wave129-orgfw" });
    await new OrgService(env.DB).createOrg({
      name: "wave129orgfw",
      ownerId: orgForker.id,
      visibility: "public",
      fullName: "W129 HasForked Org",
      now: new Date(1_700_000_000 * 1000),
    });
    const orgId = await w129UserId("wave129orgfw");

    const before = await fetchUi(
      "/wave26-owner/tracked/fork",
      withCookie("/wave26-owner/tracked/fork", await mintSession(env.DB, orgForker.id)),
    );
    expect(before.status).toBe(200);
    expect(await before.text()).toContain(">wave129orgfw</option>"); // grantable org listed

    const created = await fetchUi(
      "/wave26-owner/tracked/fork",
      formPost("/wave26-owner/tracked/fork", { uid: String(orgId), repo_name: "w129-orgfw-copy" }, await mintSession(env.DB, orgForker.id)),
    );
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/wave129orgfw/w129-orgfw-copy");

    const after = await fetchUi(
      "/wave26-owner/tracked/fork",
      withCookie("/wave26-owner/tracked/fork", await mintSession(env.DB, orgForker.id)),
    );
    expect(after.status).toBe(200);
    const html = await after.text();
    expect(html).not.toContain(">wave129orgfw</option>"); // the fork-holding org is dropped
    expect(html).toContain(">wave129-orgfw</option>"); // the doer option survives (the fork is the ORG's)
  });

  it("a member without the create-repo grant never sees the org option, and the forged org uid POST re-gates with the 403 message", async () => {
    // Provenance: wave-polish-matrix-6 — the canCreateOrgRepo refusal at the
    // LOAD level (the option silently dropped) crossed with the WRITE's
    // requireCanCreateOrgRepo re-gate (the ApiError 403 message rendered —
    // wave26 pinned only the 404-shaped unknown-org message).
    const orgOwner = await seedVerifiedUser({ username: "wave129-orgownern" });
    const member = await seedVerifiedUser({ username: "wave129-membern" });
    const org = await new OrgService(env.DB).createOrg({
      name: "wave129orgn",
      ownerId: orgOwner.id,
      visibility: "public",
      fullName: "W129 No-Grant Org",
      now: new Date(1_700_000_000 * 1000),
    });
    await new OrgService(env.DB).addMember(org.id, member.id); // plain membership, no team grant

    const form = await fetchUi(
      "/wave26-owner/tracked/fork",
      withCookie("/wave26-owner/tracked/fork", await mintSession(env.DB, member.id)),
    );
    expect(form.status).toBe(200);
    const html = await form.text();
    expect(html).not.toContain(">wave129orgn</option>"); // the grant-less org is hidden
    expect(html).toContain(">wave129-membern</option>"); // the doer option remains

    const refused = await fetchUi(
      "/wave26-owner/tracked/fork",
      formPost(
        "/wave26-owner/tracked/fork",
        { uid: String(org.id), repo_name: "w129-nope" },
        await mintSession(env.DB, member.id),
      ),
    );
    expect(refused.status).toBe(200); // re-render, not a redirect
    expect(await refused.text()).toContain("User is not allowed to create repositories in this organization.");
  });

  it("a doer blocked by the source owner still renders the GET but the POST re-renders with the blocked message", async () => {
    // Provenance: wave-polish-matrix-6 — ForkRepository's blocked arm
    // (isUserBlockedBy in createForkFromForm, upstream fork.go's blocked
    // check) was unpinned at the web-form level; the GET's asymmetry (the
    // load predicate has no block check) is pinned with it.
    const blocked = await seedVerifiedUser({ username: "wave129-blocked" });
    const ownerRow = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "wave26-owner")).get();
    const blockedRow = await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "wave129-blocked")).get();
    if (ownerRow === undefined || blockedRow === undefined) throw new Error("w129 block rows missing");
    await blockUser(
      env.DB,
      { id: ownerRow.id, isAdmin: false },
      blockPartyFromUserRow(ownerRow),
      blockPartyFromUserRow(blockedRow),
      "w129 fork-block",
    );

    // The GET renders (the block gates the WRITE, not the form).
    const form = await fetchUi(
      "/wave26-owner/tracked/fork",
      withCookie("/wave26-owner/tracked/fork", await mintSession(env.DB, blocked.id)),
    );
    expect(form.status).toBe(200);
    expect(await form.text()).toContain(">wave129-blocked</option>");

    const refused = await fetchUi(
      "/wave26-owner/tracked/fork",
      formPost(
        "/wave26-owner/tracked/fork",
        { uid: "", repo_name: "w129-blocked-copy" },
        await mintSession(env.DB, blocked.id),
      ),
    );
    expect(refused.status).toBe(200);
    expect(await refused.text()).toContain(BLOCKED_USER_MESSAGE);

    // D1 read-back: no fork row landed.
    const fork = await drizzle(env.DB)
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "wave129-blocked"), eq(repositories.forkParent, wave26Fixture!.trackedId)))
      .get();
    expect(fork).toBeUndefined();
  });

  it("a name collision under the target owner re-renders with the same-name message (IsErrRepoAlreadyExist's web arm)", async () => {
    // Provenance: wave-polish-matrix-6 — the RepoNameCollisionError →
    // repoForkLocale.new_owner_has_same_repo re-render was unpinned (the API
    // route pins its own 422 twin; the form's message arm did not exist in
    // the wave26 matrix).
    const orgOwner = await seedVerifiedUser({ username: "wave129-orgownerc" });
    const org = await new OrgService(env.DB).createOrg({
      name: "wave129orgc",
      ownerId: orgOwner.id,
      visibility: "public",
      fullName: "W129 Collision Org",
      now: new Date(1_700_000_000 * 1000),
    });
    // A NON-fork repo under the org: the collision source (a fork of tracked
    // would trip the GetUserFork redirect first).
    await new RepoService(env.DB).create({
      owner: { id: org.id, usernameLower: "wave129orgc" },
      name: "occupied",
      isPrivate: false,
      status: "ready",
    });

    const res = await fetchUi(
      "/wave26-owner/tracked/fork",
      formPost(
        "/wave26-owner/tracked/fork",
        { uid: String(org.id), repo_name: "occupied" },
        await mintSession(env.DB, orgOwner.id),
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("The new owner already has a repository with same name. Please choose another name.");

    // D1 read-back: no fork row landed under the org.
    const fork = await drizzle(env.DB)
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "wave129orgc"), eq(repositories.forkParent, wave26Fixture!.trackedId)))
      .get();
    expect(fork).toBeUndefined();
  });

  it("a source owner WITH an org grant preselects the first org (the ContextUser fallback arm)", async () => {
    // Provenance: wave-polish-matrix-6 — upstream ContextUser's else branch
    // (fork.go: the doer when forkable, ELSE the first org) was unpinned:
    // wave26's owner arm has no orgs (the no-valid-owners render) and every
    // other arm has the doer option, so the org-preselected select never
    // rendered in the committed matrix.
    await ensureSeededRepo({
      owner: "wave129-srcown",
      slug: "w129-sourced",
      commits: WAVE26_COMMITS,
    });
    const srcOwner = await drizzle(env.DB)
      .select({ id: users.id })
      .from(users)
      .where(eq(users.usernameLower, "wave129-srcown"))
      .get(); // ensureSeededRepo seeded the owner row — look it up, never re-seed
    if (srcOwner === undefined) throw new Error("w129 source-owner row missing");
    const org = await new OrgService(env.DB).createOrg({
      name: "wave129srcorg",
      ownerId: srcOwner.id,
      visibility: "public",
      fullName: "W129 Source Owner Org",
      now: new Date(1_700_000_000 * 1000),
    });

    const form = await fetchUi(
      "/wave129-srcown/w129-sourced/fork",
      withCookie("/wave129-srcown/w129-sourced/fork", await mintSession(env.DB, srcOwner.id)),
    );
    expect(form.status).toBe(200);
    const html = await form.text();
    // No doer option (the source owner is dropped by the between-owners
    // check) and the org option carries the SELECTED attribute (hono/jsx
    // emits the boolean attribute in its `=""` form).
    expect(html).not.toContain(">wave129-srcown</option>");
    expect(html).toContain(`<option value="${org.id}" selected="">wave129srcorg</option>`);
    expect(html).not.toContain(`value="${org.id}" >wave129srcorg</option>`); // never the unselected form
  });

  it("a junk uid parses to null and rides the doer target through the existing-fork redirect", async () => {
    // Provenance: wave-polish-matrix-6 — parseRepoForkForm's numeric-or-null
    // uid arm exercised at the route: the wave26 forker's fork exists (the
    // committed matrix created it), so the doer-mapped junk uid answers the
    // GetUserFork 303 instead of a write.
    const forkerId = await w129UserId("wave26-forker"); // the committed fixture's identity — never re-seeded
    const res = await fetchUi(
      "/wave26-owner/tracked/fork",
      formPost(
        "/wave26-owner/tracked/fork",
        { uid: "not-a-number", repo_name: "w129-junk-uid" },
        await mintSession(env.DB, forkerId),
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/wave26-forker/tracked-copy");
  });
});
