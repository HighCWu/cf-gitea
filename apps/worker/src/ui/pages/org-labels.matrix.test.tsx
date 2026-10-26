/**
 * The ORG labels family's DEFERRED route-level matrix (pages/org-labels.tsx —
 * the wave-14 family). The coverage split this file completes:
 *
 *   - ui/__tests__/pages-wave14.test.ts owns the base arms: the parser
 *     claims, the anonymous/pal/member/owner/admin-session renders, the
 *     sort passthrough, the renamed-org 307, the create/edit/delete
 *     round-trips with their validation re-renders (the kept title on a
 *     failed create, the edit 422 banner), the missing/foreign-id 404s,
 *     the delete idempotence, and the /new gate trio (anon 303
 *     contains-only, member 404, cross-origin 403 with the cookie);
 *   - pages/labels.matrix.test.tsx (the repo matrix) already answers
 *     several ORG arms route-level: the /labels/initialize 404, the org
 *     write tails' GET 405, the org edit/delete cross-origin 403s WITH the
 *     owner cookie, the cookie-less cross-origin org /new 403, the org
 *     edit's empty-title guard, the org edit's garbage "abc" 404 and the
 *     org delete's garbage "1.5" zero-row 303.
 *
 * THIS FILE adds the arms neither file carries, driven over the mounted
 * uiRouter on the minted-session pattern (labels.matrix is the reference):
 *
 *   - the claim pin the parser test leaves open (the org second-segment
 *     literal): a REAL repository named "labels" under the org — the
 *     anonymous GET /{org}/labels still 303s onto the login round-trip
 *     (a public repo home would have answered 200: the org claim beat the
 *     repo parse), the owner still gets the management page, and a create
 *     POST at the claimed URL lands an ORG label while the shadowed
 *     repo's own label list stays empty;
 *   - the write gates' deferred org arms (wave14 pinned contains-only on
 *     /new and status-only on delete): anonymous POSTs 303 carrying the
 *     EXACT paths on all three tails, a signed-in plain MEMBER (inside
 *     the org, not its owner) 404s edit AND delete with a REAL row id
 *     before any write (D1 read-back), and the site admin passes the
 *     requireOrgOwnership gate on a WRITE (wave14 pinned the admin only
 *     on the GET render) with the normalizer riding the admin's POST;
 *   - the create round-trip's deferred color math (wave14 pinned the
 *     6-digit lowercase arm only): the normalizer's 3→6 expansion
 *     ("F0A" → "#ff00aa") and its trim/lowercase arms ride the POST as
 *     stored-row read-backs, and the ContrastColor #000 arm renders on
 *     the org page's light badge — the row badge AND the row's
 *     edit-disclosure swatch (only the #ee0701→#fff arm was pinned);
 *   - the carried form's raw color: a failed create re-render carries the
 *     kept title (wave14's) AND the raw color input (unpinned), with
 *     nothing written;
 *   - the failed edit's re-render shape (the repo matrix pinned the repo
 *     twin): the STORED row values in the row's disclosure (never the
 *     submission) plus the RESET create form (the module header's
 *     documented degradation), the row untouched in D1;
 *   - the cookie-less cross-origin POST edit/delete 403s (the guard
 *     fronts requireOrgOwnership's anonymous login 303 — pinned only on
 *     /new), with the row surviving both.
 *
 * Rerun posture: the fixtures are D1-only rows (the org labels pages never
 * read the engine), every create target is pre-purged through the landed
 * service arms before its POST, and no test deletes a seeded row — reruns
 * converge.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { repositories, users } from "../../db/schema";
import {
  createOrgLabel,
  findOrgLabelById,
  findOrgLabelByName,
  listOrgLabels,
} from "../../api/services/labels-t2";
import { deleteRepoLabel, listRepoLabels } from "../../api/services/labels";
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

/** The cross-origin write shape (the guard's 403 arm); cookie-less means
 *  the anonymous session half of the gate. */
const crossOriginPost = (fields: Record<string, string>, cookie?: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    origin: "https://evil.example",
    ...(cookie === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
  },
  body: new URLSearchParams(fields).toString(),
});

// --- fixtures (D1-only — the org labels pages never read the engine) -------------

const ORG_NAME = "olblorg";
const SHADOW_REPO_SLUG = "labels"; // the second-segment claim's live victim

interface OrgLabelsFixture {
  ownerCookie: string;
  adminCookie: string;
  memberCookie: string;
  orgId: number;
  shadowRepoId: string;
  lightLabelId: number;
}

let orgLabelsFixture: OrgLabelsFixture | null = null;

/** Purge a create-test target through the landed service arms — a no-op
 *  when the name is absent (the rerun convergence posture). */
async function purgeOrgLabelNamed(orgId: number, name: string): Promise<void> {
  const row = await findOrgLabelByName(env.DB, orgId, name);
  if (row !== null) await deleteRepoLabel(env.DB, row);
}

async function ensureOrgLabelsFixtures(): Promise<OrgLabelsFixture> {
  if (orgLabelsFixture !== null) return orgLabelsFixture;
  const db = drizzle(env.DB);
  await applyAuthD1Migrations();

  // The principals: the org owner, a site admin, a plain org MEMBER
  // (inside the org, not its owner — the gate's hardest non-owner arm)
  // — all D1-only identities.
  for (const principal of [
    { username: "olblmx", isAdmin: false },
    { username: "olblroot", isAdmin: true },
    { username: "olblmember", isAdmin: false },
  ] as const) {
    if (
      (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, principal.username)).get()) ===
      undefined
    ) {
      await seedVerifiedUser({ username: principal.username, isAdmin: principal.isAdmin });
    }
  }
  const owner = (await db.select().from(users).where(eq(users.usernameLower, "olblmx")).get())!;
  const admin = (await db.select().from(users).where(eq(users.usernameLower, "olblroot")).get())!;
  const member = (await db.select().from(users).where(eq(users.usernameLower, "olblmember")).get())!;

  // The org (owned by olblmx) with olblmember as its plain member, plus
  // the seeded light label (the ContrastColor #000 arm + the edit/delete
  // gate target).
  const orgs = new OrgService(env.DB);
  let org = await orgs.getOrgByUsername(ORG_NAME);
  if (org === null) {
    org = await orgs.createOrg({ name: ORG_NAME, ownerId: owner.id, visibility: "public", now: new Date() });
    await orgs.addMember(org.id, member.id, { now: new Date() });
  }
  if ((await findOrgLabelByName(env.DB, org.id, "ol-light")) === null) {
    await createOrgLabel(env.DB, org.id, { name: "ol-light", exclusive: false, color: "#84b6eb", description: "" });
  }
  const light = await findOrgLabelByName(env.DB, org.id, "ol-light");
  if (light === null) throw new Error("org label seed row missing");
  org = (await orgs.getOrgByUsername(ORG_NAME))!;

  // The row-only repository NAMED "labels" under the org — the second-
  // segment claim's shadow victim (a usable repo name: the reservation
  // sets hold only . .. - and the .git/.wiki/.rss/.atom suffixes).
  const service = new RepoService(env.DB);
  const existingShadow = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "olblmx"), eq(repositories.slug, SHADOW_REPO_SLUG)))
    .get();
  let shadowRepoId: string;
  if (existingShadow === undefined) {
    shadowRepoId = (
      await service.create({
        owner: { id: owner.id, usernameLower: "olblmx" },
        name: SHADOW_REPO_SLUG,
        isPrivate: false,
        status: "ready",
      })
    ).id;
  } else {
    shadowRepoId = existingShadow.id;
  }

  orgLabelsFixture = {
    ownerCookie: await mintSession(env.DB, owner.id),
    adminCookie: await mintSession(env.DB, admin.id),
    memberCookie: await mintSession(env.DB, member.id),
    orgId: org.id,
    shadowRepoId,
    lightLabelId: light.id,
  };
  return orgLabelsFixture;
}

beforeAll(async () => {
  await ensureOrgLabelsFixtures();
});

// --- the claim pin (the org second-segment literal) -------------------------------

describe("the claim pin: a REAL repository named labels stays shadowed by the org literal", () => {
  it("the anonymous GET still 303s onto the login round-trip (a public repo home would have answered 200)", async () => {
    await ensureOrgLabelsFixtures();
    const res = await fetchUi(`/${ORG_NAME}/labels`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent(`/${ORG_NAME}/labels`)}`,
    );
  });

  it("the owner still gets the management page, and a create POST at the claimed URL lands an ORG label — the shadowed repo's label list stays empty", async () => {
    const fixture = await ensureOrgLabelsFixtures();
    const page = await fetchUi(`/${ORG_NAME}/labels`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("page-content organization settings labels");
    expect(html).toContain(`action="/${ORG_NAME}/labels/new" method="post"`);

    await purgeOrgLabelNamed(fixture.orgId, "ol-claim");
    const created = await fetchUi(
      `/${ORG_NAME}/labels/new`,
      withCookie(formPost({ title: "ol-claim", color: "#00aabb" }), fixture.ownerCookie),
    );
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe(`/${ORG_NAME}/labels`);
    // The org family handled it: the row is an ORG label…
    expect(await findOrgLabelByName(env.DB, fixture.orgId, "ol-claim")).not.toBeNull();
    // …and the shadowed repo's own label list never saw the write.
    expect((await listRepoLabels(env.DB, fixture.shadowRepoId, "", 1, 50)).total).toBe(0);
  });
});

// --- the write gates' deferred org arms -------------------------------------------

describe("the write gates' deferred org arms (wave14 pinned contains-only on /new, status-only on delete)", () => {
  it("anonymous POSTs 303 onto the login round-trip carrying the EXACT paths on all three tails", async () => {
    await ensureOrgLabelsFixtures();
    for (const tail of ["new", "edit", "delete"]) {
      const fields: Record<string, string> =
        tail === "delete" ? { id: "1" } : { id: "1", title: "x", color: "#00aabb" };
      const res = await fetchUi(`/${ORG_NAME}/labels/${tail}`, formPost(fields));
      expect(res.status, `anon ${tail}`).toBe(303);
      expect(res.headers.get("location"), `anon ${tail}`).toBe(
        `/login?redirect_to=${encodeURIComponent(`/${ORG_NAME}/labels/${tail}`)}`,
      );
    }
  });

  it("a signed-in plain MEMBER 404s edit AND delete with a REAL row id before any write (D1 read-back)", async () => {
    const fixture = await ensureOrgLabelsFixtures();
    const edit = await fetchUi(
      `/${ORG_NAME}/labels/edit`,
      withCookie(
        formPost({ id: String(fixture.lightLabelId), title: "member rename", color: "#121212" }),
        fixture.memberCookie,
      ),
    );
    expect(edit.status).toBe(404);
    const del = await fetchUi(
      `/${ORG_NAME}/labels/delete`,
      withCookie(formPost({ id: String(fixture.lightLabelId) }), fixture.memberCookie),
    );
    expect(del.status).toBe(404);
    const row = await findOrgLabelById(env.DB, fixture.orgId, fixture.lightLabelId);
    expect(row?.name).toBe("ol-light"); // nothing touched
    expect(row?.color).toBe("#84b6eb");
  });

  it("the site admin passes requireOrgOwnership on a WRITE: the render shows the controls and a create POST lands (pre-purged target)", async () => {
    const fixture = await ensureOrgLabelsFixtures();
    const page = await fetchUi(`/${ORG_NAME}/labels`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.adminCookie}` },
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`action="/${ORG_NAME}/labels/new" method="post"`);

    await purgeOrgLabelNamed(fixture.orgId, "ol-admin-create");
    const created = await fetchUi(
      `/${ORG_NAME}/labels/new`,
      withCookie(formPost({ title: "ol-admin-create", color: "AA7700" }), fixture.adminCookie),
    );
    expect(created.status).toBe(303);
    const row = await findOrgLabelByName(env.DB, fixture.orgId, "ol-admin-create");
    expect(row?.color).toBe("#aa7700"); // the normalizer ran on the admin's POST too
  });
});

// --- the create round-trip's deferred color math -----------------------------------

describe("the create round-trip's deferred color math + carried form (org)", () => {
  it("the normalizer's 3→6 expansion and trim/lowercase arms ride the POST: stored-row read-backs", async () => {
    const fixture = await ensureOrgLabelsFixtures();
    await purgeOrgLabelNamed(fixture.orgId, "ol-3digit");
    await purgeOrgLabelNamed(fixture.orgId, "ol-padded");

    const expanded = await fetchUi(
      `/${ORG_NAME}/labels/new`,
      withCookie(formPost({ title: "ol-3digit", color: "F0A" }), fixture.ownerCookie),
    );
    expect(expanded.status).toBe(303);
    expect((await findOrgLabelByName(env.DB, fixture.orgId, "ol-3digit"))?.color).toBe("#ff00aa");

    const padded = await fetchUi(
      `/${ORG_NAME}/labels/new`,
      withCookie(formPost({ title: "ol-padded", color: " #00AABB " }), fixture.ownerCookie),
    );
    expect(padded.status).toBe(303);
    expect((await findOrgLabelByName(env.DB, fixture.orgId, "ol-padded"))?.color).toBe("#00aabb");
  });

  it("a light badge renders the ContrastColor #000 arm on the org page — the row badge AND the row's edit-disclosure swatch (only #fff was pinned)", async () => {
    const fixture = await ensureOrgLabelsFixtures();
    const res = await fetchUi(`/${ORG_NAME}/labels`, {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("color: #000 !important; background-color: #84b6eb !important;");
    // One light row → the list badge + the row's own edit-disclosure
    // preview swatch answer the same math.
    expect(html.match(/color: #000 !important; background-color: #84b6eb !important;/g)?.length).toBeGreaterThan(1);
  });

  it("a failed create re-render carries the kept title AND the raw color (wave14 pinned the title only), nothing written", async () => {
    const fixture = await ensureOrgLabelsFixtures();
    const before = await listOrgLabels(env.DB, fixture.orgId, "", 1, 50);
    const res = await fetchUi(
      `/${ORG_NAME}/labels/new`,
      withCookie(formPost({ title: "kept submission", color: "notacolor" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("invalid color: notacolor");
    expect(html).toContain('name="title" value="kept submission"');
    expect(html).toContain('id="new-label_color" name="color" value="notacolor"');
    // The un-renderable color draws no swatch.
    expect(html).not.toContain("background-color: notacolor");
    // The failed POST never landed.
    expect((await listOrgLabels(env.DB, fixture.orgId, "", 1, 50)).total).toBe(before.total);
  });
});

// --- the failed edit's re-render shape ---------------------------------------------

describe("the failed edit's re-render shape (org — the repo matrix pinned the repo twin)", () => {
  it("re-renders the STORED row values plus the RESET create form, the row untouched in D1", async () => {
    const fixture = await ensureOrgLabelsFixtures();
    const res = await fetchUi(
      `/${ORG_NAME}/labels/edit`,
      withCookie(
        formPost({ id: String(fixture.lightLabelId), title: "submitted title", color: "notacolor" }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("invalid color: notacolor");
    // The rows are list-rendered: the target row's disclosure shows the
    // STORED values, never the submission.
    expect(html).toContain(`id="label-edit-${fixture.lightLabelId}_title" name="title" value="ol-light"`);
    expect(html).not.toContain('value="submitted title"');
    // The create form resets to its plain-GET defaults (the handler passes
    // them explicitly, not the failed submission).
    expect(html).toContain('id="new-label_title" name="title" value=""');
    expect(html).toContain('id="new-label_color" name="color" value="#70c24a"');
    const row = await findOrgLabelById(env.DB, fixture.orgId, fixture.lightLabelId);
    expect(row?.name).toBe("ol-light");
    expect(row?.color).toBe("#84b6eb");
  });
});

// --- the cross-origin 403s' remaining org arms --------------------------------------

describe("cookie-less cross-origin POST edit/delete 403 before the anonymous 303 (pinned only on /new)", () => {
  it("the guard fronts requireOrgOwnership's login round-trip on both tails and the row survives", async () => {
    const fixture = await ensureOrgLabelsFixtures();
    const edit = await fetchUi(
      `/${ORG_NAME}/labels/edit`,
      crossOriginPost({ id: String(fixture.lightLabelId), title: "evil rename", color: "#121212" }),
    );
    expect(edit.status).toBe(403);
    expect(edit.headers.get("content-type")).toContain("text/plain");
    expect(await edit.text()).toContain("cross-origin request rejected");

    const del = await fetchUi(
      `/${ORG_NAME}/labels/delete`,
      crossOriginPost({ id: String(fixture.lightLabelId) }),
    );
    expect(del.status).toBe(403);
    expect(await del.text()).toContain("cross-origin request rejected");

    const row = await findOrgLabelById(env.DB, fixture.orgId, fixture.lightLabelId);
    expect(row?.name).toBe("ol-light"); // neither evil arm touched the row
    expect(row?.color).toBe("#84b6eb");
  });
});
