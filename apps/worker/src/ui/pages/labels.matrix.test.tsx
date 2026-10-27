/**
 * The labels family's DEFERRED route-level matrix (pages/repo-labels.tsx +
 * pages/org-labels.tsx — the wave-25 repo family and the wave-14 org family;
 * the base route tests in ui/__tests__/pages-wave25.test.ts and
 * ui/__tests__/pages-wave14.test.ts own the base arms: the parser claims,
 * the anonymous/reader/writer/owner-session renders, the org-section render,
 * the sort passthrough, the create/edit/delete round-trips with their
 * validation re-renders, the missing/foreign-id 404s, the delete
 * idempotence, the repo GET-tails 405 and the PAT-anonymous pin). THIS FILE
 * adds the arms neither file carries, driven over the mounted uiRouter on
 * the notifications 28b71b9 matrix's minted-session pattern (file-editor
 * 40e775b is the freshest reference):
 *
 *   - the archived-repo gate (RepoMustNotBeArchived's port): the repo write
 *     gate 404-shells ALL THREE POSTs for the OWNER — the archived check
 *     precedes the grant, so even a site admin is refused — while the LIST
 *     stays 200 with the controls hidden (the render's
 *     canEdit = canWrite && !isArchived) and its empty arm intact;
 *   - the writer gate's remaining arms on the edit/delete tails (wave25
 *     gated only /new): anonymous 303s carrying the exact POSTed paths, a
 *     signed-in non-collaborator 404s before any write (D1 read-back), the
 *     site admin passes both the render gate and a create POST;
 *   - the cross-origin 403s (repo side unpinned; org side pinned only on
 *     /new): a valid session cookie still 403s and nothing is written, a
 *     cookie-less cross-origin POST 403s BEFORE the anonymous 303 (the §2.8
 *     guard fronts both families' gates), and the org edit/delete arms 403
 *     with the row surviving both;
 *   - the create round-trip's deferred color math: the normalizer's 3→6
 *     expansion ("F0A" → "#ff00aa") and its trim/lowercase arms ride the
 *     POST (stored-row read-backs), the ContrastColor #000 arm renders on a
 *     light badge (only the #fff arm was pinned), and a failed create
 *     re-render carries the kept title on the REPO side (the org twin is
 *     wave14's);
 *   - the edit round-trip's deferred arms (both scopes): the empty-title
 *     guard answers AFTER the scoped lookup with the row untouched, a failed
 *     edit re-renders the STORED row values plus the RESET create form (the
 *     module headers' documented degradation), and a garbage form id ("abc",
 *     "1.5") parses to the never-matching 0 (formLabelId parity) — a 404 on
 *     edit, the zero-row-idempotent 303 on delete;
 *   - the claim pins wave14/25 carry at parse level only, answered
 *     route-level here: the /labels/initialize template-loader tail stays
 *     engine-owned on BOTH scopes (404), and the ORG write tails answer GET
 *     with chi's 405 (the repo-side 405s are wave25's);
 *   - batch-11 deepening (the create/edit forms' remaining validation arms):
 *     the color shapes the waves leave open — the trimmed-to-empty banner
 *     ("invalid color: " prints the empty normalization), the hash-prefixed
 *     3-digit "#F0A" expansion twin, the 4-digit and 7-digit and
 *     double-hash refusals printing the raw normalized string (Go's %s —
 *     the implicit '#' is prepended ONLY at length 3/6, so "f0ab" fails
 *     UNhashed); the "exclusive-name" resolution — upstream NewLabel /
 *     UpdateLabel carry NO name-dedupe (models/issues/label.go:232-249 are
 *     plain inserts/updates, the modal's exclusive flag is the documented
 *     no-JS reduction), so a duplicate create and an edit renamed onto an
 *     existing name both 303 and the rows coexist — pinned as the
 *     upstream-faithful NON-refusal;
 *   - the edit round-trip's SUCCESS arm with the absent-field rule: a
 *     label seeded with description + exclusive + an archived stamp keeps
 *     all three through a name/color-only form POST (the PATCH arm's
 *     untouched-fields rule end-to-end), the edit path runs its own 3→6
 *     expansion, and the Archived marker re-renders on the row;
 *   - the org-scoped arms on the repo page: an ORG label's id at the
 *     repo-scoped edit 404s without touching the org row (the lookup
 *     filters repo_id), the manage-link ladder's middle arm (a signed-in
 *     repo WRITER who is not an org owner sees the org rows and their own
 *     write controls but never the "(manage)" link), the org section
 *     re-orders under the same silent `?sort=` (the shared sortParam), and
 *     an org-owned repo whose org carries no labels renders NO section
 *     (label_list.tmpl's `{{if .OrgLabels}}` guard).
 *
 * The scoped-label color math is NOT pinned anywhere in the landed pages —
 * LabelBadge is RenderLabel's regular-label case (issues-list.tsx; the
 * exclusive/scoped two-tone badge is not rendered) — so that arm has no
 * landed surface to test; the ContrastColor arms are the label color math
 * the pages do pin, and this file adds the unpinned half of it.
 *
 * Rerun posture: the fixtures are D1-only rows (the labels pages never read
 * the engine, so no receive-pack is needed), every create target is
 * pre-purged through the landed service arms before its POST, and no test
 * deletes a seeded row — reruns converge.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import {
  createRepoLabel,
  deleteRepoLabel,
  findRepoLabelById,
  listRepoLabels,
} from "../../api/services/labels";
import { createOrgLabel, findOrgLabelById, listOrgLabels } from "../../api/services/labels-t2";
import { addOrUpdateCollaborator } from "../../api/services/repo-collaborators";
import { repositories, users } from "../../db/schema";
import { RepoService } from "../../repos/service";
import { OrgService } from "../../services/orgs/orgs";
import { uiRouter } from "../index";
import { uiEnv } from "../__tests__/harness";
import { mintSession, SESSION_COOKIE_NAME } from "../session";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

/** A form POST with the browser's same-origin header (the §2.8 guard's
 *  happy path — the router fixture origin). */
function formPost(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://test.local",
    },
    body: new URLSearchParams(fields).toString(),
  };
}

const withCookie = (init: RequestInit, cookie: string): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string>), cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
});

/** The cross-origin write shape (the guard's 403 arm). */
const crossOriginPost = (fields: Record<string, string>, cookie?: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    origin: "https://evil.example",
    ...(cookie === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
  },
  body: new URLSearchParams(fields).toString(),
});

// --- fixtures (D1-only — the labels pages never read the engine) ----------------

const ORG_NAME = "labelmxorg";
const REPO_SLUG = "lx-repo";
const ARCHIVED_SLUG = "lx-archived";
// The batch-11 org-section arms' org-owned repo (the .OrgLabels section's
// consuming repo) plus a second org with NO labels (the section's empty
// guard arm).
const ORG_REPO_SLUG = "lx-org-repo";
const EMPTY_ORG_NAME = "labelmxempty";
const EMPTY_ORG_REPO_SLUG = "lx-bare-repo";

interface LabelsFixture {
  ownerCookie: string;
  adminCookie: string;
  palCookie: string;
  repoId: string;
  bugLabelId: number;
  lightLabelId: number;
  orgId: number;
  orgBlockedLabelId: number;
  orgLightLabelId: number;
  orgRepoId: string;
  emptyOrgRepoId: string;
}

let labelsFixture: LabelsFixture | null = null;

/** Purge a create-test target through the landed service arms — a no-op
 *  when the name is absent (the rerun convergence posture). */
async function purgeRepoLabelNamed(repoId: string, name: string): Promise<void> {
  const { items } = await listRepoLabels(env.DB, repoId, "", 1, 50);
  for (const row of items) {
    if (row.name === name) await deleteRepoLabel(env.DB, row);
  }
}

async function ensureLabelsFixtures(): Promise<LabelsFixture> {
  if (labelsFixture !== null) return labelsFixture;
  const db = drizzle(env.DB);
  await applyAuthD1Migrations();

  // The principals: the owner (repo + org), a site admin, a plain user with
  // no grant anywhere (the signed-in non-writer arm).
  for (const principal of [
    { username: "labelmx", isAdmin: false },
    { username: "labelmxroot", isAdmin: true },
    { username: "labelmxpal", isAdmin: false },
  ]) {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.usernameLower, principal.username))
      .get();
    if (existing === undefined) {
      await db.insert(users).values({
        username: principal.username,
        usernameLower: principal.username,
        isAdmin: principal.isAdmin,
        status: "active",
        visibility: "public",
        createdAt: new Date(),
      });
    }
  }
  const owner = await db.select().from(users).where(eq(users.usernameLower, "labelmx")).get();
  const admin = await db.select().from(users).where(eq(users.usernameLower, "labelmxroot")).get();
  const pal = await db.select().from(users).where(eq(users.usernameLower, "labelmxpal")).get();
  if (owner === undefined || admin === undefined || pal === undefined) {
    throw new Error("labels matrix identity rows missing");
  }

  // The org (owned by labelmx) with its two labels.
  const orgs = new OrgService(env.DB);
  let org = await orgs.getOrgByUsername(ORG_NAME);
  if (org === null) {
    org = await orgs.createOrg({ name: ORG_NAME, ownerId: owner.id, visibility: "public", now: new Date() });
  }
  if ((await listOrgLabels(env.DB, org.id, "", 1, 1)).total === 0) {
    await createOrgLabel(env.DB, org.id, {
      name: "lx-org-blocked",
      exclusive: false,
      color: "#d73a4a",
      description: "Org-blocked by the matrix seed",
    });
    await createOrgLabel(env.DB, org.id, {
      name: "lx-org-light",
      exclusive: false,
      color: "#84b6eb",
      description: "",
    });
  }
  const orgBlocked = (await listOrgLabels(env.DB, org.id, "", 1, 50)).items.find((row) => row.name === "lx-org-blocked");
  const orgLight = (await listOrgLabels(env.DB, org.id, "", 1, 50)).items.find((row) => row.name === "lx-org-light");
  if (orgBlocked === undefined || orgLight === undefined) throw new Error("org label seed rows missing");

  // The live repo (row-only — the labels pages read D1 only) with its two
  // labels: one dark (the #fff badge arm) and one light (the unpinned #000
  // arm this file pins).
  const service = new RepoService(env.DB);
  let repoId: string;
  const existingRepo = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "labelmx"), eq(repositories.slug, REPO_SLUG)))
    .get();
  if (existingRepo === undefined) {
    repoId = (
      await service.create({
        owner: { id: owner.id, usernameLower: "labelmx" },
        name: REPO_SLUG,
        isPrivate: false,
        status: "ready",
      })
    ).id;
  } else {
    repoId = existingRepo.id;
  }
  if ((await listRepoLabels(env.DB, repoId, "", 1, 1)).total === 0) {
    await createRepoLabel(env.DB, repoId, {
      name: "lx-bug",
      exclusive: false,
      color: "#ee0701",
      description: "Something is broken",
      isArchived: false,
      now: new Date(),
    });
    await createRepoLabel(env.DB, repoId, {
      name: "lx-light",
      exclusive: false,
      color: "#84b6eb",
      description: "",
      isArchived: false,
      now: new Date(),
    });
  }
  const bug = (await listRepoLabels(env.DB, repoId, "", 1, 50)).items.find((row) => row.name === "lx-bug");
  const light = (await listRepoLabels(env.DB, repoId, "", 1, 50)).items.find((row) => row.name === "lx-light");
  if (bug === undefined || light === undefined) throw new Error("repo label seed rows missing");

  // The row-only ARCHIVED twin: the write gate 404s at the archived check,
  // BEFORE the grant (and before any engine read — there is none anyway).
  const existingArchived = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "labelmx"), eq(repositories.slug, ARCHIVED_SLUG)))
    .get();
  if (existingArchived === undefined) {
    const row = await service.create({
      owner: { id: owner.id, usernameLower: "labelmx" },
      name: ARCHIVED_SLUG,
      isPrivate: false,
      status: "ready",
    });
    await db.update(repositories).set({ isArchived: true }).where(eq(repositories.id, row.id));
  }

  // The ORG-OWNED repo (the .OrgLabels section's consumer) with pal as a
  // WRITE collaborator — the manage-link ladder's middle arm: a repo writer
  // who is NOT an org owner.
  const existingOrgRepo = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, ORG_NAME), eq(repositories.slug, ORG_REPO_SLUG)))
    .get();
  let orgRepoId: string;
  if (existingOrgRepo === undefined) {
    orgRepoId = (
      await service.create({
        owner: { id: org.id, usernameLower: ORG_NAME },
        name: ORG_REPO_SLUG,
        isPrivate: false,
        status: "ready",
      })
    ).id;
  } else {
    orgRepoId = existingOrgRepo.id;
  }
  await addOrUpdateCollaborator(env.DB, orgRepoId, pal.id, "write", new Date());

  // The label-LESS org with its org-owned repo: the section renders only
  // when the org carries labels (label_list.tmpl's `{{if .OrgLabels}}`).
  let emptyOrg = await orgs.getOrgByUsername(EMPTY_ORG_NAME);
  if (emptyOrg === null) {
    emptyOrg = await orgs.createOrg({ name: EMPTY_ORG_NAME, ownerId: owner.id, visibility: "public", now: new Date() });
  }
  const existingBareRepo = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, EMPTY_ORG_NAME), eq(repositories.slug, EMPTY_ORG_REPO_SLUG)))
    .get();
  let emptyOrgRepoId: string;
  if (existingBareRepo === undefined) {
    emptyOrgRepoId = (
      await service.create({
        owner: { id: emptyOrg.id, usernameLower: EMPTY_ORG_NAME },
        name: EMPTY_ORG_REPO_SLUG,
        isPrivate: false,
        status: "ready",
      })
    ).id;
  } else {
    emptyOrgRepoId = existingBareRepo.id;
  }

  labelsFixture = {
    ownerCookie: await mintSession(env.DB, owner.id),
    adminCookie: await mintSession(env.DB, admin.id),
    palCookie: await mintSession(env.DB, pal.id),
    repoId,
    bugLabelId: bug.id,
    lightLabelId: light.id,
    orgId: org.id,
    orgBlockedLabelId: orgBlocked.id,
    orgLightLabelId: orgLight.id,
    orgRepoId,
    emptyOrgRepoId,
  };
  return labelsFixture;
}

beforeAll(async () => {
  await ensureLabelsFixtures();
});

// --- the claim pins (route-level — wave14/25 pin the parse shapes only) ---------

describe("claim pins (route-level answers the parse pins leave open)", () => {
  it("the /labels/initialize template-loader tail stays engine-owned on BOTH scopes (404, never the management page)", async () => {
    await ensureLabelsFixtures();
    const repoScope = await fetchUi(`/labelmx/${REPO_SLUG}/labels/initialize`);
    expect(repoScope.status).toBe(404);
    expect(await repoScope.text()).not.toContain("page-content repository labels");

    const orgScope = await fetchUi(`/${ORG_NAME}/labels/initialize`);
    expect(orgScope.status).toBe(404);
    expect(await orgScope.text()).not.toContain("page-content organization settings labels");
  });

  it("the ORG write tails answer GET with chi's 405 (the convention wave25 pins repo-side only)", async () => {
    await ensureLabelsFixtures();
    expect((await fetchUi(`/${ORG_NAME}/labels/new`)).status).toBe(405);
    expect((await fetchUi(`/${ORG_NAME}/labels/edit`)).status).toBe(405);
    expect((await fetchUi(`/${ORG_NAME}/labels/delete`)).status).toBe(405);
  });
});

// --- the repo write gate's remaining arms ----------------------------------------

describe("the repo write gate's remaining arms (wave25 gated only /new)", () => {
  it("an archived repo keeps the list at 200 with the controls hidden but 404-shells ALL THREE writes for the owner", async () => {
    const fixture = await ensureLabelsFixtures();
    const list = await fetchUi(`/labelmx/${ARCHIVED_SLUG}/labels`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(list.status).toBe(200);
    const html = await list.text();
    expect(html).toContain('class="page-content repository labels"');
    expect(html).toContain("No labels yet."); // the empty arm renders on the archived twin too
    expect(html).not.toContain(`action="/labelmx/${ARCHIVED_SLUG}/labels/new"`);
    expect(html).not.toContain(`/labels/edit`);
    expect(html).not.toContain(`/labels/delete`);

    // RepoMustNotBeArchived's port precedes the grant: the owner (who
    // would pass canWriteRepo on a live repo) 404s on every write.
    const created = await fetchUi(
      `/labelmx/${ARCHIVED_SLUG}/labels/new`,
      withCookie(formPost({ title: "archived write", color: "#00aabb" }), fixture.ownerCookie),
    );
    expect(created.status).toBe(404);
    const edited = await fetchUi(
      `/labelmx/${ARCHIVED_SLUG}/labels/edit`,
      withCookie(formPost({ id: "1", title: "archived write", color: "#00aabb" }), fixture.ownerCookie),
    );
    expect(edited.status).toBe(404);
    const deleted = await fetchUi(
      `/labelmx/${ARCHIVED_SLUG}/labels/delete`,
      withCookie(formPost({ id: "1" }), fixture.ownerCookie),
    );
    expect(deleted.status).toBe(404);
  });

  it("the site admin passes the writer gate: the render shows the controls and a create POST lands (pre-purged target)", async () => {
    const fixture = await ensureLabelsFixtures();
    const list = await fetchUi(`/labelmx/${REPO_SLUG}/labels`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.adminCookie}` },
    });
    expect(list.status).toBe(200);
    expect(await list.text()).toContain(`action="/labelmx/${REPO_SLUG}/labels/new"`);

    await purgeRepoLabelNamed(fixture.repoId, "lx-admin-create");
    const created = await fetchUi(
      `/labelmx/${REPO_SLUG}/labels/new`,
      withCookie(formPost({ title: "lx-admin-create", color: "#AA7700" }), fixture.adminCookie),
    );
    expect(created.status).toBe(303);
    const row = (await listRepoLabels(env.DB, fixture.repoId, "", 1, 50)).items.find(
      (candidate) => candidate.name === "lx-admin-create",
    );
    expect(row?.color).toBe("#aa7700"); // the normalizer ran on the admin's POST too
  });

  it("anonymous POST edit/delete 303 onto the login round-trip carrying the exact paths (the /new twin)", async () => {
    await ensureLabelsFixtures();
    const edit = await fetchUi(`/labelmx/${REPO_SLUG}/labels/edit`, formPost({ id: "1", title: "x", color: "#00aabb" }));
    expect(edit.status).toBe(303);
    expect(edit.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent(`/labelmx/${REPO_SLUG}/labels/edit`)}`,
    );
    const del = await fetchUi(`/labelmx/${REPO_SLUG}/labels/delete`, formPost({ id: "1" }));
    expect(del.status).toBe(303);
    expect(del.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent(`/labelmx/${REPO_SLUG}/labels/delete`)}`,
    );
  });

  it("a signed-in non-collaborator 404s edit/delete BEFORE any write (D1 read-back)", async () => {
    const fixture = await ensureLabelsFixtures();
    const edit = await fetchUi(
      `/labelmx/${REPO_SLUG}/labels/edit`,
      withCookie(
        formPost({ id: String(fixture.bugLabelId), title: "pal hijack", color: "#121212" }),
        fixture.palCookie,
      ),
    );
    expect(edit.status).toBe(404);
    const del = await fetchUi(
      `/labelmx/${REPO_SLUG}/labels/delete`,
      withCookie(formPost({ id: String(fixture.bugLabelId) }), fixture.palCookie),
    );
    expect(del.status).toBe(404);
    const row = await findRepoLabelById(env.DB, fixture.repoId, fixture.bugLabelId);
    expect(row?.name).toBe("lx-bug"); // nothing touched
    expect(row?.color).toBe("#ee0701");
  });
});

// --- the cross-origin 403s (the guard fronts both families) ----------------------

describe("cross-origin 403s on the write arms (repo side unpinned; org side pinned only on /new)", () => {
  it("a cross-origin POST new 403s even WITH a valid owner cookie and writes nothing", async () => {
    const fixture = await ensureLabelsFixtures();
    const before = await listRepoLabels(env.DB, fixture.repoId, "", 1, 50);
    const res = await fetchUi(
      `/labelmx/${REPO_SLUG}/labels/new`,
      crossOriginPost({ title: "evil label", color: "#121212" }, fixture.ownerCookie),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("cross-origin request rejected");
    const after = await listRepoLabels(env.DB, fixture.repoId, "", 1, 50);
    expect(after.total).toBe(before.total); // no evil row
  });

  it("a cross-origin POST delete 403s with the cookie and the label survives; the cookie-less cross-origin POST 403s before the anonymous 303", async () => {
    const fixture = await ensureLabelsFixtures();
    const del = await fetchUi(
      `/labelmx/${REPO_SLUG}/labels/delete`,
      crossOriginPost({ id: String(fixture.bugLabelId) }, fixture.ownerCookie),
    );
    expect(del.status).toBe(403);
    expect(await del.text()).toContain("cross-origin request rejected");
    expect(await findRepoLabelById(env.DB, fixture.repoId, fixture.bugLabelId)).not.toBeNull();

    // The guard runs FIRST: a cookie-less cross-origin POST is a 403, not the
    // anonymous login 303 the same-origin arm answers.
    const anon = await fetchUi(
      `/labelmx/${REPO_SLUG}/labels/new`,
      crossOriginPost({ title: "evil label", color: "#121212" }),
    );
    expect(anon.status).toBe(403);
  });

  it("the ORG edit/delete arms 403 cross-origin with the owner cookie and both rows survive", async () => {
    const fixture = await ensureLabelsFixtures();
    const edit = await fetchUi(
      `/${ORG_NAME}/labels/edit`,
      crossOriginPost(
        { id: String(fixture.orgBlockedLabelId), title: "evil rename", color: "#121212" },
        fixture.ownerCookie,
      ),
    );
    expect(edit.status).toBe(403);
    const del = await fetchUi(
      `/${ORG_NAME}/labels/delete`,
      crossOriginPost({ id: String(fixture.orgBlockedLabelId) }, fixture.ownerCookie),
    );
    expect(del.status).toBe(403);
    const row = await findOrgLabelById(env.DB, fixture.orgId, fixture.orgBlockedLabelId);
    expect(row?.name).toBe("lx-org-blocked"); // neither arm touched the org row
    expect(row?.color).toBe("#d73a4a");
  });

  it("a cookie-less cross-origin ORG POST 403s before the login 303 (the guard fronts requireOrgOwnership)", async () => {
    await ensureLabelsFixtures();
    const res = await fetchUi(
      `/${ORG_NAME}/labels/new`,
      crossOriginPost({ title: "evil org label", color: "#121212" }),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
  });
});

// --- the create round-trip's deferred color math ----------------------------------

describe("the create round-trip's deferred color math + carried form (repo)", () => {
  it("the normalizer's expansion and trim arms ride the POST: bare uppercase 3-digit and padded input store canonical #rrggbb", async () => {
    const fixture = await ensureLabelsFixtures();
    await purgeRepoLabelNamed(fixture.repoId, "lx-3digit");
    await purgeRepoLabelNamed(fixture.repoId, "lx-padded");

    const expanded = await fetchUi(
      `/labelmx/${REPO_SLUG}/labels/new`,
      withCookie(formPost({ title: "lx-3digit", color: "F0A" }), fixture.ownerCookie),
    );
    expect(expanded.status).toBe(303);
    const expandedRow = (await listRepoLabels(env.DB, fixture.repoId, "", 1, 50)).items.find(
      (candidate) => candidate.name === "lx-3digit",
    );
    expect(expandedRow?.color).toBe("#ff00aa"); // #f0a duplicated per channel

    const padded = await fetchUi(
      `/labelmx/${REPO_SLUG}/labels/new`,
      withCookie(formPost({ title: "lx-padded", color: " #00AABB " }), fixture.ownerCookie),
    );
    expect(padded.status).toBe(303);
    const paddedRow = (await listRepoLabels(env.DB, fixture.repoId, "", 1, 50)).items.find(
      (candidate) => candidate.name === "lx-padded",
    );
    expect(paddedRow?.color).toBe("#00aabb"); // trimmed + lowercased
  });

  it("a light badge renders the ContrastColor #000 arm (only the #fff arm was pinned)", async () => {
    const fixture = await ensureLabelsFixtures();
    const res = await fetchUi(`/labelmx/${REPO_SLUG}/labels`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("color: #000 !important; background-color: #84b6eb !important;");
    // The swatch inside the writer's edit disclosure answers the same math.
    const writer = await fetchUi(`/labelmx/${REPO_SLUG}/labels`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    const writerHtml = await writer.text();
    expect(writerHtml.match(/color: #000 !important; background-color: #84b6eb !important;/g)?.length).toBeGreaterThan(1);
  });

  it("a failed create re-render carries the kept title on the repo side (the org twin is wave14's)", async () => {
    const fixture = await ensureLabelsFixtures();
    const before = await listRepoLabels(env.DB, fixture.repoId, "", 1, 50);
    const res = await fetchUi(
      `/labelmx/${REPO_SLUG}/labels/new`,
      withCookie(formPost({ title: "kept submission", color: "notacolor" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("invalid color: notacolor");
    expect(html).toContain('name="title" value="kept submission"');
    // The failed POST never landed.
    expect((await listRepoLabels(env.DB, fixture.repoId, "", 1, 50)).total).toBe(before.total);
  });
});

// --- the edit round-trip's deferred arms (both scopes) ----------------------------

describe("the edit round-trip's deferred arms (both scopes)", () => {
  it("the repo edit's empty-title guard answers AFTER the scoped lookup and leaves the row stored", async () => {
    const fixture = await ensureLabelsFixtures();
    const res = await fetchUi(
      `/labelmx/${REPO_SLUG}/labels/edit`,
      withCookie(
        formPost({ id: String(fixture.lightLabelId), title: "", color: "#00aabb" }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Label name cannot be empty.");
    const row = await findRepoLabelById(env.DB, fixture.repoId, fixture.lightLabelId);
    expect(row?.name).toBe("lx-light"); // untouched
    expect(row?.color).toBe("#84b6eb");
  });

  it("a failed repo edit re-renders the STORED row values plus the RESET create form (the documented degradation)", async () => {
    const fixture = await ensureLabelsFixtures();
    const res = await fetchUi(
      `/labelmx/${REPO_SLUG}/labels/edit`,
      withCookie(
        formPost({ id: String(fixture.bugLabelId), title: "submitted title", color: "notacolor" }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("invalid color: notacolor");
    // The rows are list-rendered: the failed edit's row shows the STORED
    // values, never the submission.
    expect(html).toContain('name="title" value="lx-bug"');
    expect(html).not.toContain('value="submitted title"');
    // The create form resets to its plain-GET defaults (the handler passes
    // them explicitly, not the failed submission).
    expect(html).toContain('id="new-label_color" name="color" value="#70c24a"');
  });

  it("a garbage form id parses to the never-matching 0 (formLabelId parity): 404 on edit, the zero-row 303 on delete", async () => {
    const fixture = await ensureLabelsFixtures();
    for (const garbage of ["abc", "1.5"]) {
      const edit = await fetchUi(
        `/labelmx/${REPO_SLUG}/labels/edit`,
        withCookie(formPost({ id: garbage, title: "x", color: "#00aabb" }), fixture.ownerCookie),
      );
      expect(edit.status, `edit id=${garbage}`).toBe(404);
    }
    const before = await listRepoLabels(env.DB, fixture.repoId, "", 1, 50);
    const del = await fetchUi(
      `/labelmx/${REPO_SLUG}/labels/delete`,
      withCookie(formPost({ id: "abc" }), fixture.ownerCookie),
    );
    expect(del.status).toBe(303);
    expect(del.headers.get("location")).toBe(`/labelmx/${REPO_SLUG}/labels`);
    expect((await listRepoLabels(env.DB, fixture.repoId, "", 1, 50)).total).toBe(before.total); // nothing gone
  });

  it("the org edit's empty-title guard keeps the org row stored (uncovered on the org scope)", async () => {
    const fixture = await ensureLabelsFixtures();
    const res = await fetchUi(
      `/${ORG_NAME}/labels/edit`,
      withCookie(
        formPost({ id: String(fixture.orgLightLabelId), title: "", color: "#00aabb" }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Label name cannot be empty.");
    const row = await findOrgLabelById(env.DB, fixture.orgId, fixture.orgLightLabelId);
    expect(row?.name).toBe("lx-org-light");
    expect(row?.color).toBe("#84b6eb");
  });

  it("the org edit's garbage id 404-shells (formLabelId parity on the org scope)", async () => {
    const fixture = await ensureLabelsFixtures();
    const res = await fetchUi(
      `/${ORG_NAME}/labels/edit`,
      withCookie(formPost({ id: "abc", title: "x", color: "#00aabb" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(404);
  });
});

// --- the delete arm's org-side zero-row shape --------------------------------------

describe("the delete arm's deferred org-side shape", () => {
  it("the org delete's zero-row success for a garbage id 303s onto the list (idempotent like the numeric miss)", async () => {
    const fixture = await ensureLabelsFixtures();
    const res = await fetchUi(
      `/${ORG_NAME}/labels/delete`,
      withCookie(formPost({ id: "1.5" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${ORG_NAME}/labels`);
    expect((await listOrgLabels(env.DB, fixture.orgId, "", 1, 1)).total).toBe(2); // both rows intact
  });
});

// --- batch 11: the create/edit forms' remaining color shapes + the name rules -------

describe("the create/edit forms' remaining color shapes + the name rules (batch 11)", () => {
  it("the empty color answers the trimmed-to-empty banner (the normalizer prints the empty string)", async () => {
    const fixture = await ensureLabelsFixtures();
    const before = await listRepoLabels(env.DB, fixture.repoId, "", 1, 50);
    const res = await fetchUi(
      `/labelmx/${REPO_SLUG}/labels/new`,
      withCookie(formPost({ title: "shape-empty", color: "" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(200);
    // "" never reaches the 3/6 prepend branch — the message prints the bare
    // normalization ("invalid color: " — the trailing space is the message's).
    expect(await res.text()).toContain("invalid color: </div>");
    expect((await listRepoLabels(env.DB, fixture.repoId, "", 1, 50)).total).toBe(before.total); // nothing written
  });

  it("the hash-prefixed 3-digit expands exactly like the bare twin (the form's pattern admits both shapes)", async () => {
    const fixture = await ensureLabelsFixtures();
    await purgeRepoLabelNamed(fixture.repoId, "lx-hash3");
    const res = await fetchUi(
      `/labelmx/${REPO_SLUG}/labels/new`,
      withCookie(formPost({ title: "lx-hash3", color: "#F0A" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(303);
    const row = (await listRepoLabels(env.DB, fixture.repoId, "", 1, 50)).items.find(
      (candidate) => candidate.name === "lx-hash3",
    );
    expect(row?.color).toBe("#ff00aa"); // #f0a duplicated per channel — same as the bare "F0A" arm
  });

  it("the off-length shapes print the RAW normalized string: a 4-digit stays unhashed, the 7-digit and double-hash keep their input", async () => {
    const fixture = await ensureLabelsFixtures();
    const before = await listRepoLabels(env.DB, fixture.repoId, "", 1, 50);
    // 4 chars: NOT length 3/6 → no implicit '#' prepended → the message
    // prints "f0ab" bare (the hash add happens ONLY on the prepend branch).
    const four = await fetchUi(
      `/labelmx/${REPO_SLUG}/labels/new`,
      withCookie(formPost({ title: "shape-4", color: "f0ab" }), fixture.ownerCookie),
    );
    expect(four.status).toBe(200);
    expect(await four.text()).toContain("invalid color: f0ab");

    // 8 chars with the hash: length 7+ → no prepend either — the input rides
    // the message verbatim (the form's HTML5 pattern is the client-side arm;
    // the server answers every shape the POST can carry).
    const seven = await fetchUi(
      `/labelmx/${REPO_SLUG}/labels/new`,
      withCookie(formPost({ title: "shape-7", color: "#aabbccd" }), fixture.ownerCookie),
    );
    expect(seven.status).toBe(200);
    expect(await seven.text()).toContain("invalid color: #aabbccd");

    const doubleHash = await fetchUi(
      `/labelmx/${REPO_SLUG}/labels/new`,
      withCookie(formPost({ title: "shape-dh", color: "##00aabb" }), fixture.ownerCookie),
    );
    expect(doubleHash.status).toBe(200);
    expect(await doubleHash.text()).toContain("invalid color: ##00aabb");
    // All three refusals wrote nothing.
    expect((await listRepoLabels(env.DB, fixture.repoId, "", 1, 50)).total).toBe(before.total);
  });

  it("the name rules have NO exclusive arm: a duplicate create and an edit renamed onto an existing name both succeed (upstream NewLabel/UpdateLabel are plain writes)", async () => {
    const fixture = await ensureLabelsFixtures();
    const namedLxBug = async (): Promise<number> =>
      (await listRepoLabels(env.DB, fixture.repoId, "", 1, 50)).items.filter(
        (candidate) => candidate.name === "lx-bug",
      ).length;
    const before = await namedLxBug();

    // The create: "lx-bug" already exists — upstream NewLabel
    // (models/issues/label.go:232-241) is a plain insert with no name
    // lookup, so the duplicate 303s and the rows coexist.
    const dup = await fetchUi(
      `/labelmx/${REPO_SLUG}/labels/new`,
      withCookie(formPost({ title: "lx-bug", color: "#00aabb" }), fixture.ownerCookie),
    );
    expect(dup.status).toBe(303);
    expect(await namedLxBug()).toBe(before + 1);
    // The no-JS form never sends the modal's exclusive/is_archived fields —
    // the duplicate row carries the two-field form's defaults verbatim.
    const rows = (await listRepoLabels(env.DB, fixture.repoId, "", 1, 50)).items.filter(
      (candidate) => candidate.name === "lx-bug",
    );
    const created = rows[rows.length - 1]!; // name ASC, id ASC — the new row sorts last
    expect(created.exclusive).toBe(false);
    expect(created.archivedAt).toBeNull();
    expect(created.color).toBe("#00aabb");

    // The edit renamed onto the sibling's name: UpdateLabel
    // (models/issues/label.go:262-270) writes the posted columns only —
    // no uniqueness arm exists to refuse it.
    const renamed = await fetchUi(
      `/labelmx/${REPO_SLUG}/labels/edit`,
      withCookie(
        formPost({ id: String(fixture.lightLabelId), title: "lx-bug", color: "#00aabb" }),
        fixture.ownerCookie,
      ),
    );
    expect(renamed.status).toBe(303);
    expect(await namedLxBug()).toBe(before + 2); // the light row joined the name
  });
});

// --- batch 11: the edit round-trip's success arm (the absent-field rule) -------------

describe("the edit round-trip's success arm keeps the unposted fields (batch 11)", () => {
  it("a name/color-only POST preserves description, exclusive and the archived stamp; the edit path runs its own 3→6 expansion and the Archived marker re-renders", async () => {
    const fixture = await ensureLabelsFixtures();
    // Seed the rich row directly through the landed service (the no-JS
    // form cannot produce exclusive/archived rows on its own).
    await createRepoLabel(env.DB, fixture.repoId, {
      name: "lx-rich",
      exclusive: true,
      color: "#bb00cc",
      description: "rich description",
      isArchived: true,
      now: new Date(),
    });
    const seeded = (await listRepoLabels(env.DB, fixture.repoId, "", 1, 50)).items.find(
      (candidate) => candidate.name === "lx-rich",
    );
    if (seeded === undefined) throw new Error("lx-rich seed row missing");

    const res = await fetchUi(
      `/labelmx/${REPO_SLUG}/labels/edit`,
      withCookie(
        formPost({ id: String(seeded.id), title: "lx-rich-renamed", color: "#f0a" }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/labelmx/${REPO_SLUG}/labels`);

    const row = await findRepoLabelById(env.DB, fixture.repoId, seeded.id);
    expect(row?.name).toBe("lx-rich-renamed");
    expect(row?.color).toBe("#ff00aa"); // the edit path normalizes too (normalizeLabelColor in editRepoLabelFromForm)
    expect(row?.description).toBe("rich description"); // the absent-field rule
    expect(row?.exclusive).toBe(true);
    expect(row?.archivedAt).not.toBeNull();

    // The re-rendered list carries the Archived marker on the edited row
    // (label_archived.tmpl's `archivedAt !== null` arm survives the edit).
    const list = await fetchUi(`/labelmx/${REPO_SLUG}/labels`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    const listHtml = await list.text();
    expect(listHtml).toContain(">Archived</span>"); // the marker's exact element, not the tooltip's prose
    expect(listHtml).toContain("rich description");
  });
});

// --- batch 11: the org-scoped arms on the repo page -----------------------------------

describe("the org-scoped arms on the repo page (batch 11)", () => {
  it("an ORG label's id at the repo-scoped edit 404s and the org row survives (the lookup filters repo_id)", async () => {
    const fixture = await ensureLabelsFixtures();
    const res = await fetchUi(
      `/labelmx/${REPO_SLUG}/labels/edit`,
      withCookie(
        formPost({ id: String(fixture.orgBlockedLabelId), title: "cross hijack", color: "#121212" }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(404);
    const row = await findOrgLabelById(env.DB, fixture.orgId, fixture.orgBlockedLabelId);
    expect(row?.name).toBe("lx-org-blocked"); // the org-scoped row untouched
    expect(row?.color).toBe("#d73a4a");
  });

  it("the manage-link ladder's middle arm: a signed-in repo WRITER who is not an org owner sees the org rows and their own write controls, never the (manage) link", async () => {
    const fixture = await ensureLabelsFixtures();
    const res = await fetchUi(`/${ORG_NAME}/${ORG_REPO_SLUG}/labels`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.palCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content repository labels"');
    // The org section renders with its rows (the org carries labels)…
    expect(html).toContain("Organization-level labels");
    expect(html).toContain("lx-org-blocked");
    expect(html).toContain("lx-org-light");
    // …but pal is no org owner: the (manage) link never renders.
    expect(html).not.toContain(`href="/${ORG_NAME}/labels"`);
    // As a repo WRITER pal gets the repo-side controls (the create form)…
    expect(html).toContain(`action="/${ORG_NAME}/${ORG_REPO_SLUG}/labels/new"`);
    // …while the ORG rows never carry them (OrgLabelRowLine's bare cell) —
    // the only /labels/edit actions on the page belong to repo rows, and
    // this repo has none, so none render.
    expect(html).not.toContain(`action="/${ORG_NAME}/${ORG_REPO_SLUG}/labels/edit"`);
    expect(html).not.toContain(`action="/${ORG_NAME}/${ORG_REPO_SLUG}/labels/delete"`);
  });

  it("the org section re-orders under the same silent ?sort= (the shared sortParam reads both lists)", async () => {
    await ensureLabelsFixtures();
    const reversed = await fetchUi(`/${ORG_NAME}/${ORG_REPO_SLUG}/labels?sort=reversealphabetically`);
    expect(reversed.status).toBe(200);
    const html = await reversed.text();
    // "lx-org-light" > "lx-org-blocked" alphabetically, so the reversed
    // order shows the light row first; the default order shows blocked first.
    expect(html.indexOf("lx-org-light")).toBeLessThan(html.indexOf("lx-org-blocked"));

    const plain = await fetchUi(`/${ORG_NAME}/${ORG_REPO_SLUG}/labels`);
    const plainHtml = await plain.text();
    expect(plainHtml.indexOf("lx-org-blocked")).toBeLessThan(plainHtml.indexOf("lx-org-light"));
  });

  it("an org-owned repo whose org carries no labels renders NO org section (label_list.tmpl's {{if .OrgLabels}} guard)", async () => {
    const fixture = await ensureLabelsFixtures();
    const res = await fetchUi(`/labelmxempty/${EMPTY_ORG_REPO_SLUG}/labels`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content repository labels"');
    expect(html).not.toContain("Organization-level labels");
    expect(html).toContain("No labels yet."); // the bare empty arm — no intro row either
  });
});
