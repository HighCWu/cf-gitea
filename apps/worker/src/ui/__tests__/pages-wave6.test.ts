/**
 * Pages wave 6 route tests (SPEC-0008 U3 extension): the org home page
 * (`/{org}` — pages/org-home.tsx, the first single-segment family) and the
 * repo milestones slice (the list + the admin create form, pages/
 * milestones.tsx).
 *
 * Same harness posture as waves 4/5: the router is driven directly with the
 * synthetic ASSETS manifest, fixtures seed through the landed services with
 * fixed values, and identities ride minted session cookies. The org
 * fixtures come from the shared golden harness (setupGoldenFixtures — the
 * public `acme` org, the `emptyorg`, the `morgan` owner); this file adds
 * its own orgs (private / limited / renamed / many-repo) and a dedicated
 * `alice/wave6` repo for the milestone WRITES, so the committed goldens'
 * fixture repos stay read-only here (a write into `golden-ms` would shift
 * the committed bytes under any other test order).
 *
 * Visibility posture under test (the §2.5 anti-enumeration rule): the org
 * resolves through the landed orgAssignment/RedirectToUser seam — a renamed
 * org 307s, a plain user or an invisible org 404-shells — and the milestones
 * write gates follow the settings order: sameOriginGuard, repo resolution,
 * then the admin predicate.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { milestones, repositories, users } from "../../db/schema";
import { uiRouter } from "../index";
import { OrgService } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { runA11y } from "./a11y";
import { renderRoute, setupGoldenFixtures, T0, uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

/** A form POST with the browser's Origin header (the §2.8 guard's happy
 *  path — same-origin as the router fixture origin). */
function formPost(fields: Record<string, string>): RequestInit {
  const params = new URLSearchParams(fields);
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://test.local",
    },
    body: params.toString(),
  };
}

const withCookie = (init: RequestInit, cookie: string): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string>), cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
});

// --- fixtures -----------------------------------------------------------------

const WAVE6_COMMITS: SeedCommit[] = [
  { message: "c1: seed", time: T0, files: [{ path: "README.md", content: "# wave6\n" }] },
];

const t = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

interface Wave6Fixture {
  morganCookie: string; // the golden orgs' owner
  ownerCookie: string; // alice — the wave6 repo owner
  adminCookie: string; // wave6boss — site admin
  otherCookie: string; // wave6pal — unrelated viewer
}

let wave6Fixture: Wave6Fixture | null = null;

/**
 * Seed the wave-6 block on top of the shared golden fixtures: the extra orgs
 * (private / limited / rename pair / a 16-repo paging org), the plain user,
 * and the `alice/wave6` write repo. Idempotent at every step (org lookups
 * gate creations; the repo block is guarded on its milestone rows).
 */
async function ensureWave6Fixtures(): Promise<Wave6Fixture> {
  if (wave6Fixture !== null) return wave6Fixture;
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  const orgs = new OrgService(env.DB);

  const morgan = await db.select().from(users).where(eq(users.usernameLower, "morgan")).get();
  if (morgan === undefined) throw new Error("morgan row missing (golden fixtures must seed first)");

  // Private org: invisible to anonymous, visible to its owner; the owner's
  // listing includes the private repo (the §4.7 owner predicate).
  if ((await orgs.getOrgByUsername("privorg")) === null) {
    const org = await orgs.createOrg({ name: "privorg", ownerId: morgan.id, visibility: "private", now: t(0) });
    const service = new RepoService(env.DB);
    await service.create({ owner: { id: org.id, usernameLower: "privorg" }, name: "hidden-work", isPrivate: true, status: "ready" });
    await service.create({ owner: { id: org.id, usernameLower: "privorg" }, name: "open-work", isPrivate: false, status: "ready" });
  }

  // Limited org: 404 for anonymous, 200 for any signed-in viewer.
  if ((await orgs.getOrgByUsername("laxorg")) === null) {
    await orgs.createOrg({ name: "laxorg", ownerId: morgan.id, visibility: "limited", now: t(0) });
  }

  // The rename pair: the redirect seam answers /oldname with a 307 onto
  // /newname (query preserved), the RenameUser write rule.
  if ((await orgs.getOrgByUsername("newname")) === null) {
    const old = await orgs.createOrg({ name: "oldname", ownerId: morgan.id, visibility: "public", now: t(0) });
    await orgs.renameOrg(old.id, "newname", { now: t(1) });
  }

  // The paging org: 16 public repos — one page of 15 + a single-row second
  // page (upstream RepoPagingNum = 15).
  if ((await orgs.getOrgByUsername("bulky")) === null) {
    const org = await orgs.createOrg({ name: "bulky", ownerId: morgan.id, visibility: "public", now: t(0) });
    const service = new RepoService(env.DB);
    for (let i = 0; i < 16; i++) {
      await service.create({
        owner: { id: org.id, usernameLower: "bulky" },
        name: `repo-${String(i).padStart(2, "0")}`,
        isPrivate: false,
        status: "ready",
      });
    }
  }

  await seedVerifiedUser({ username: "plainhuman" }); // a plain USER — never an org page
  for (const extra of [
    { username: "wave6boss", isAdmin: true },
    { username: "wave6pal", isAdmin: false },
  ]) {
    if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, extra.username)).get()) === undefined) {
      await db.insert(users).values({
        username: extra.username,
        usernameLower: extra.username,
        isAdmin: extra.isAdmin,
        status: "active",
        visibility: "public",
        createdAt: new Date(),
      });
    }
  }

  await ensureSeededRepo({ owner: "alice", slug: "wave6", commits: WAVE6_COMMITS });

  wave6Fixture = {
    morganCookie: await mintSession(env.DB, morgan.id),
    ownerCookie: await mintSession(env.DB, (await db.select().from(users).where(eq(users.usernameLower, "alice")).get())!.id),
    adminCookie: await mintSession(env.DB, (await db.select().from(users).where(eq(users.usernameLower, "wave6boss")).get())!.id),
    otherCookie: await mintSession(env.DB, (await db.select().from(users).where(eq(users.usernameLower, "wave6pal")).get())!.id),
  };
  return wave6Fixture;
}

// The shared golden fixtures register their own beforeAll (module scope —
// hook registration must happen before the run phase), and run FIRST: the
// org fixtures (acme/morgan/emptyorg) are this file's base.
setupGoldenFixtures();

beforeAll(async () => {
  await ensureWave6Fixtures();
});

// --- the org home page ----------------------------------------------------------

describe("org home (/{org})", () => {
  it("renders the public org profile for anonymous: header, reduced menu, the visible repo rows only", async () => {
    const { status, html } = await renderRoute("/acme");
    expect(status).toBe(200);
    expect(html).toContain('class="page-content organization profile"');
    expect(html).toContain("<title>Acme Corporation - cf-gitea</title>");
    // The header block: avatar placeholder + display name; a public org has
    // no visibility badge.
    expect(html).toContain('class="ui avatar"');
    expect(html).toContain('<span class="tw-text-2xl">Acme Corporation</span>');
    expect(html).toContain("Everything the coyote orders.");
    expect(html).toContain("<span>Desert Mesa</span>");
    expect(html).toContain('href="https://acme.example"');
    // The reduced menu: the single live tab with the VISIBLE count (2 for
    // anonymous — bird-seed is private and never crosses the listing).
    expect(html).toContain("Repositories");
    // Rows: the two public repos, the archived badge, no Private badge for
    // the anonymous list.
    expect(html).toContain('href="/acme/anvil"');
    expect(html).toContain("Drop-tested delivery hardware.");
    expect(html).toContain('href="/acme/rocket-skates"');
    expect(html).toContain("Archived");
    expect(html).not.toContain("/acme/bird-seed");
    expect(html).not.toContain(">Private<");
  });

  it("renders the empty placeholder for a repo-less org", async () => {
    const { status, html } = await renderRoute("/emptyorg");
    expect(status).toBe(200);
    expect(html).toContain("No repositories yet.");
    expect(html).toContain("Create a repository to share code with the organization.");
    expect(html).not.toContain("flex-divided-list");
  });

  it("404-shells a private org for anonymous, renders it for its owner with the private rows", async () => {
    const fixture = await ensureWave6Fixtures();
    const anon = await fetchUi("/privorg");
    expect(anon.status).toBe(404);
    expect(await anon.text()).toContain("Page Not Found"); // the bare shell — existence hidden

    const owned = await fetchUi("/privorg", { headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.morganCookie}` } });
    expect(owned.status).toBe(200);
    const html = await owned.text();
    expect(html).toContain(">Private</span>"); // the org header's visibility badge
    expect(html).toContain('href="/privorg/hidden-work"'); // the owner sees private rows
    expect(html).toContain(">Private<"); // the repo row's Private badge
    expect(html).toContain('href="/privorg/open-work"');
  });

  it("404-shells a limited org for anonymous, renders the Limited badge for a signed-in viewer", async () => {
    const fixture = await ensureWave6Fixtures();
    expect((await fetchUi("/laxorg")).status).toBe(404);
    const authed = await fetchUi("/laxorg", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.otherCookie}` },
    });
    expect(authed.status).toBe(200);
    expect(await authed.text()).toContain(">Limited</span>");
  });

  it("serves a plain user name from the USER half (wave 7) and 404-shells an unknown name", async () => {
    // Since wave 7 the single-segment family dispatches on the row type:
    // `plainhuman` is a USER row → the user profile page (never an
    // org-shaped page); an unknown name stays the 404 shell.
    const user = await fetchUi("/plainhuman");
    expect(user.status).toBe(200);
    const userHtml = await user.text();
    expect(userHtml).not.toContain("Page Not Found");
    expect(userHtml).not.toContain("organization profile");
    expect(userHtml).toContain('class="page-content user profile"');

    for (const path of ["/nobody-org"]) {
      const res = await fetchUi(path);
      expect(res.status, path).toBe(404);
      const html = await res.text();
      expect(html, path).toContain("Page Not Found");
      expect(html, path).not.toContain("organization profile");
      expect(html, path).not.toContain("user profile");
    }
  });

  it("307s a renamed org onto the new name (RedirectToUser) and renders the target", async () => {
    const redirect = await fetchUi("/oldname?x=1");
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe("/newname?x=1");
    expect((await fetchUi("/newname")).status).toBe(200);
  });

  it("paginates at the upstream RepoPagingNum (15): page 1 Older, page 2 the remainder + Newer", async () => {
    const first = await fetchUi("/bulky");
    expect(first.status).toBe(200);
    const firstHtml = await first.text();
    expect(firstHtml).toContain("repo-00");
    expect(firstHtml).not.toContain("repo-15");
    expect(firstHtml).toContain("Older");

    const second = await fetchUi("/bulky?page=2");
    expect(second.status).toBe(200);
    const secondHtml = await second.text();
    expect(secondHtml).not.toContain("repo-00");
    expect(secondHtml).toContain("repo-15");
    expect(secondHtml).toContain("Newer");
    expect(secondHtml).not.toContain("Older");
  });

  it("does not let the single-segment registration shadow the top-level literals", async () => {
    // The sub-app must MISS /login (the parent app's sessionRouter — mounted
    // after this sub-app — answers it); the registration's label regex
    // carries the same exclusions the parser enforces.
    const res = await fetchUi("/login");
    expect(res.status).toBe(404);
  });

  it("renders identical bytes twice (no request-state bleed across org pages)", async () => {
    const first = await renderRoute("/acme");
    const second = await renderRoute("/acme");
    expect(second.html).toBe(first.html);
  });
});

// --- the milestones list --------------------------------------------------------

describe("milestones list (/{owner}/{repo}/milestones)", () => {
  it("renders the upstream page frame: discriminator, reduced navbar, tabs with the unfiltered counts", async () => {
    const { status, html } = await renderRoute("/alice/golden-ms/milestones");
    expect(status).toBe(200);
    expect(html).toContain('class="page-content repository milestones"');
    expect(html).toContain("<title>Milestones - alice/golden-ms</title>");
    expect(html).toContain("issue-list-navbar");
    expect(html).toContain(">Milestones</a>");
    // Wave 25 landed the labels page (pages/repo-labels.tsx), so the
    // issue-navbar renders upstream navbar.tmpl's BOTH items now — the
    // wave-6 single-item reduction ("the Labels page does not exist") is
    // retired; Milestones stays the active item here.
    expect(html).toContain('href="/alice/golden-ms/labels"');
    expect(html).toContain('>Milestones</a>');
    // Tab counts are the unfiltered totals: 2 open / 1 closed.
    expect(html).toContain("2 Open</a>");
    expect(html).toContain("1 Closed</a>");
  });

  it("renders the open rows: title, 50% progress, counts, due date, the overdue red line", async () => {
    const { html } = await renderRoute("/alice/golden-ms/milestones");
    // v1.0: one open + one closed issue, the stored completeness column.
    expect(html).toContain("v1.0");
    expect(html).toContain(">50%</span>");
    expect(html).toMatch(/<progress class="list-item-title-progress"[^>]*value="50"/);
    expect(html).toContain("1 Open</div>");
    expect(html).toContain("1 Closed</div>");
    // past-due: fixed past deadline → the red due-date line (deterministic:
    // the fixture deadline is decades in the past).
    expect(html).toContain("tw-text-red");
    expect(html).toContain("past-due");
    expect(html).not.toContain("v0.9"); // the closed milestone stays on its tab
    // No New button data on the anonymous render (the admin gate hides it).
    expect(html).not.toContain("/alice/golden-ms/milestones/new");
  });

  it("renders the no-deadline line, and the closed tab with the closed stamp", async () => {
    const open = await renderRoute("/alice/golden-ms/milestones");
    expect(open.html).toContain("No due date");

    const closed = await renderRoute("/alice/golden-ms/milestones?state=closed");
    expect(closed.status).toBe(200);
    expect(closed.html).toContain("2 Open</a>"); // the tab counts stay unfiltered
    expect(closed.html).toContain("v0.9");
    expect(closed.html).toContain("Closed</div>");
    expect(closed.html).toContain("<relative-time"); // the closed-date stamp
    expect(closed.html).toContain(">100%</span>");
    expect(closed.html).not.toContain("v1.0");
  });

  it("deeper milestones tails stay unclaimed (the write routes are not in this slice)", async () => {
    const res = await fetchUi("/alice/golden-ms/milestones/1/edit");
    expect(res.status).toBe(404);
  });

  it("shows the New Milestone button to the admin viewer only (the form 404-shells non-admins)", async () => {
    const fixture = await ensureWave6Fixtures();
    const anon = await renderRoute("/alice/wave6/milestones");
    expect(anon.html).not.toContain("/alice/wave6/milestones/new");
    const owner = await fetchUi("/alice/wave6/milestones", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(owner.status).toBe(200);
    expect(await owner.text()).toContain('href="/alice/wave6/milestones/new"');
  });
});

// --- the new-milestone form + write ---------------------------------------------

describe("new milestone (GET/POST /milestones/new)", () => {
  it("gates like the settings pages: anonymous → login 303, unrelated viewer → 404 shell", async () => {
    const fixture = await ensureWave6Fixtures();
    const anon = await fetchUi("/alice/wave6/milestones/new");
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent("/alice/wave6/milestones/new")}`,
    );

    const other = await fetchUi("/alice/wave6/milestones/new", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.otherCookie}` },
    });
    expect(other.status).toBe(404);
    expect(await other.text()).toContain("Page Not Found");
  });

  it("renders the upstream form for the owner and the site admin", async () => {
    const fixture = await ensureWave6Fixtures();
    for (const cookie of [fixture.ownerCookie, fixture.adminCookie]) {
      const res = await fetchUi("/alice/wave6/milestones/new", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('class="page-content repository new milestone"');
      expect(html).toContain('action="/alice/wave6/milestones/new"');
      expect(html).toContain('name="title"');
      expect(html).toContain('name="deadline"');
      expect(html).toContain('name="content"');
      expect(html).toContain("Create Milestone");
    }
  });

  it("403s a cross-origin POST before any repo work (§2.8 layer 2)", async () => {
    const res = await fetchUi("/alice/wave6/milestones/new", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: "title=x",
    });
    expect(res.status).toBe(403);
  });

  it("303s an anonymous POST onto the login round-trip (no write)", async () => {
    const before = await milestoneCount();
    const res = await fetchUi("/alice/wave6/milestones/new", formPost({ title: "nope" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/alice/wave6/milestones/new")}`);
    expect(await milestoneCount()).toBe(before);
  });

  it("creates through the landed milestone-create service and 303s back onto the list", async () => {
    const fixture = await ensureWave6Fixtures();
    const before = await milestoneCount();
    const res = await fetchUi(
      "/alice/wave6/milestones/new",
      withCookie(formPost({ title: "  wave6 m1  ", deadline: "2030-01-31", content: "The body." }), fixture.ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/wave6/milestones");
    expect(await milestoneCount()).toBe(before + 1);
    // The write path: name trimmed, end-of-day UTC deadline (the landed
    // parser's normalization), content stored.
    const row = await drizzle(env.DB).select().from(milestones).where(eq(milestones.name, "wave6 m1")).get();
    expect(row?.content).toBe("The body.");
    expect(row?.deadlineAt?.toISOString()).toBe("2030-01-31T23:59:59.000Z");
    // The list now renders the row for everyone (0 issues → 0% bar).
    const list = await renderRoute("/alice/wave6/milestones");
    expect(list.html).toContain("wave6 m1");
    expect(list.html).toContain("0%</span>");
    expect(list.html).toContain("Jan 31, 2030");
  });

  it("re-renders at 200 with the message and the kept values on an empty title", async () => {
    const fixture = await ensureWave6Fixtures();
    const before = await milestoneCount();
    const res = await fetchUi(
      "/alice/wave6/milestones/new",
      withCookie(formPost({ title: "", deadline: "2030-02-01", content: "kept" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("A title is required.");
    expect(html).toContain('value="2030-02-01"');
    expect(html).toContain("kept");
    expect(await milestoneCount()).toBe(before);
  });

  it("re-renders with the upstream invalid-deadline message", async () => {
    const fixture = await ensureWave6Fixtures();
    const res = await fetchUi(
      "/alice/wave6/milestones/new",
      withCookie(formPost({ title: "ok", deadline: "2030-13-77" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(200);
    // JSX escapes the apostrophes (&#39;) — the exact upstream string, escaped.
    expect(await res.text()).toContain("Due date format must be &#39;yyyy-mm-dd&#39;.");
  });

  it("refuses the write on an archived repo with the upstream message and hides the New button", async () => {
    const fixture = await ensureWave6Fixtures();
    const db = drizzle(env.DB);
    const repo = await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave6")))
      .get();
    if (repo === undefined) throw new Error("wave6 repo row missing");
    await db.update(repositories).set({ isArchived: true }).where(eq(repositories.id, repo.id));
    try {
      const before = await milestoneCount();
      const post = await fetchUi(
        "/alice/wave6/milestones/new",
        withCookie(formPost({ title: "archived write" }), fixture.ownerCookie),
      );
      expect(post.status).toBe(200);
      expect(await post.text()).toContain("repo is archived");
      expect(await milestoneCount()).toBe(before);

      const list = await renderRoute("/alice/wave6/milestones");
      expect(list.html).not.toContain("/alice/wave6/milestones/new"); // the button hides
    } finally {
      await db.update(repositories).set({ isArchived: false }).where(eq(repositories.id, repo.id));
    }
  });
});

// --- a11y -----------------------------------------------------------------------

describe("wave-6 a11y smoke", () => {
  it("the org home and milestones pages pass the structural rules (anonymous and signed-in)", async () => {
    const fixture = await ensureWave6Fixtures();
    for (const path of ["/acme", "/alice/golden-ms/milestones", "/alice/golden-ms/milestones?state=closed"]) {
      const res = await fetchUi(path);
      expect(res.status, path).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
    const authed = await fetchUi("/alice/wave6/milestones/new", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(authed.status).toBe(200);
    expect(runA11y(await authed.text())).toEqual([]);
  });
});

// --- helpers --------------------------------------------------------------------

async function milestoneCount(): Promise<number> {
  const repo = await drizzle(env.DB)
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave6")))
    .get();
  if (repo === undefined) return 0;
  const rows = await drizzle(env.DB).select({ id: milestones.id }).from(milestones).where(eq(milestones.repoId, repo.id)).all();
  return rows.length;
}
