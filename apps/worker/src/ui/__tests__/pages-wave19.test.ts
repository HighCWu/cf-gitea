/**
 * Pages wave 19 route tests — the creation pages (`/repo/create` +
 * `/org/create`, pages/repo-create.tsx + pages/org-create.tsx): upstream
 * templates/repo/create.tmpl + org/create.tmpl over web.go:1094-1098 +
 * web.go:970-974 (the parity survey's #2, the authoring front door), posting
 * through the LANDED create arms — createUserRepository (the
 * `POST /user/repos` arm, auto-init included) for the doer,
 * requireCanCreateOrgRepo + RepoService.create (the `POST /orgs/{org}/repos`
 * arm, auto-init DROPPED — the documented degrade) for an org, and
 * OrgService.createOrg (the `POST /orgs` arm) for the org page.
 *
 * Same harness posture as pages-wave2..18: the router is driven directly
 * with the synthetic ASSETS manifest. No engine seed is needed — these pages
 * CREATE repos, so the fixtures are two principals (a personal creator and
 * an org owner) plus one org; every successful create suffixes its name with
 * a fresh random tail so repeat runs never collide (route tests, not
 * goldens — determinism is the goldens' property).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { repoSettings, repositories, users } from "../../db/schema";
import { OrgService } from "../../services/orgs/orgs";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { runA11y } from "./a11y";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const withCookie = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });

const formPost = (path: string, body: Record<string, string>, cookie: string, origin = "https://test.local"): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    ...(origin === "" ? {} : { origin }),
    cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
  },
  body: new URLSearchParams(body).toString(),
});

/** A fresh repo-name tail — POST-success tests only (§5.2 determinism is a
 *  goldens property; route tests re-run against a warm D1). */
const suffix = (): string => crypto.randomUUID().slice(0, 8);

// --- fixtures -----------------------------------------------------------------

interface Wave19Fixture {
  aliceCookie: string;
  aliceId: number;
  morganCookie: string;
  org: { id: number; username: string };
  morganId: number;
}

let wave19Fixture: Wave19Fixture | null = null;

async function ensureWave19Fixtures(): Promise<Wave19Fixture> {
  if (wave19Fixture !== null) return wave19Fixture;
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  const orgs = new OrgService(env.DB);

  for (const username of ["wave19alice", "wave19morgan"]) {
    if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, username)).get()) === undefined) {
      await seedVerifiedUser({ username });
    }
  }
  const alice = (await db.select().from(users).where(eq(users.usernameLower, "wave19alice")).get())!;
  const morgan = (await db.select().from(users).where(eq(users.usernameLower, "wave19morgan")).get())!;

  // The org morgan owns (the org create arm's subject; alice holds NO
  // membership — the 403 grant arm).
  let org = await orgs.getOrgByUsername("wave19org");
  if (org === null) {
    await orgs.createOrg({ name: "wave19org", ownerId: morgan.id, visibility: "public", now: new Date(T0 * 1000) });
    org = (await orgs.getOrgByUsername("wave19org"))!;
  }

  wave19Fixture = {
    aliceCookie: await mintSession(env.DB, alice.id),
    aliceId: alice.id,
    morganCookie: await mintSession(env.DB, morgan.id),
    morganId: morgan.id,
    org: { id: org.id, username: org.username },
  };
  return wave19Fixture;
}

beforeAll(async () => {
  await ensureWave19Fixtures();
});

// --- the parser (the single owner of the route shape) ---------------------------

describe("wave-19 parser families (parseUiRoute / handlesUiRoute)", () => {
  it("claims the exact literals", () => {
    expect(parseUiRoute("/repo/create")).toEqual({ family: "repo-create" });
    expect(parseUiRoute("/org/create")).toEqual({ family: "org-create" });
    // The trailing-slash forms classify to the same shapes (§4.13).
    expect(parseUiRoute("/repo/create/")).toEqual({ family: "repo-create" });
    expect(parseUiRoute("/org/create/")).toEqual({ family: "org-create" });
    expect(handlesUiRoute("/repo/create")).toBe(true);
    expect(handlesUiRoute("/org/create")).toBe(true);
  });

  it("leaves every other /repo and /org tail with their families (upstream's shadowing order)", () => {
    // Unclaimed tails fall to the owner/repo parse — a repository named
    // "migrate" under an owner named "repo" would resolve (and 404-shell on
    // the row lookup) exactly like upstream's dynamic pairs answering after
    // its static groups. Both owner names are upstream-reserved at create
    // time (orgs.ts RESERVED_USERNAMES carries "repo" and "org"), so the
    // shadowed rows cannot exist.
    // Window-2e C3a (62ef380) mounted /repo/migrate — the stale home
    // shadow pin updated to the family claim (the sweep's finding).
    expect(parseUiRoute("/repo/migrate")).toEqual({ family: "repo-migrate" });
    expect(parseUiRoute("/repo/create/more")).toBeNull();
    expect(parseUiRoute("/org/teams")?.family).toBe("org-teams"); // wave 12's literal, untouched
  });
});

// --- GET /repo/create ------------------------------------------------------------

describe("GET /repo/create (the new-repository form)", () => {
  it("303s the anonymous viewer onto the login round-trip", async () => {
    const res = await fetchUi("/repo/create");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/repo/create")}`);
  });

  it("renders the upstream form for a signed-in viewer (private checked, auto-init present)", async () => {
    const fixture = await ensureWave19Fixtures();
    const res = await fetchUi("/repo/create", withCookie(fixture.aliceCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    // create.tmpl's discriminator + the attached header/segment shape.
    expect(html).toContain("page-content repository new-repo");
    expect(html).toContain('<h3 class="ui top attached header">New Repository</h3>');
    expect(html).toContain('<form class="ui form left-right-form" action="/repo/create" method="post">');
    // The owner select: the no-JS reduction posts upstream's `uid` field;
    // alice holds no org grant, so the dropdown is exactly her.
    expect(html).toContain('<select id="uid" name="uid"');
    expect(html).toContain(`<option value="${fixture.aliceId}" selected="">wave19alice</option>`);
    expect(html).toContain('name="repo_name"');
    expect(html).toContain('maxlength="100"');
    // The visibility checkbox defaults CHECKED (the DefaultPushCreatePrivate
    // directive — pages/repo-create.tsx header).
    expect(html).toContain('id="private" name="private" type="checkbox" checked=""');
    expect(html).toContain('id="description" name="description"');
    // The auto-init checkbox (the user arm supports it — the survey verdict).
    expect(html).toContain('id="auto-init" name="auto_init" type="checkbox"');
    expect(html).toContain("Initialize Repository");
  });

  it("preselects an ALLOWED org through ?org= and falls back for a non-granted viewer", async () => {
    const fixture = await ensureWave19Fixtures();
    const granted = await fetchUi(`/repo/create?org=${fixture.org.id}`, withCookie(fixture.morganCookie));
    expect(granted.status).toBe(200);
    expect(await granted.text()).toContain(`<option value="${fixture.org.id}" selected="">wave19org</option>`);

    // Alice cannot create in the org — the preselect falls back to her.
    const refused = await fetchUi(`/repo/create?org=${fixture.org.id}`, withCookie(fixture.aliceCookie));
    const refusedHtml = await refused.text();
    expect(refusedHtml).toContain(`<option value="${fixture.aliceId}" selected="">wave19alice</option>`);
    expect(refusedHtml).not.toContain(`<option value="${fixture.org.id}" selected="">`);

    // A junk ?org value falls back too (upstream FormInt64's zero arm).
    const junk = await fetchUi("/repo/create?org=nope", withCookie(fixture.morganCookie));
    expect(junk.status).toBe(200);
    expect(await junk.text()).toContain(`<option value="${fixture.morganId}" selected="">wave19morgan</option>`);
  });

  it("lists a granted org in the owner select", async () => {
    const fixture = await ensureWave19Fixtures();
    const res = await fetchUi("/repo/create", withCookie(fixture.morganCookie));
    const html = await res.text();
    expect(html).toContain(`<option value="${fixture.morganId}"`);
    expect(html).toContain(`<option value="${fixture.org.id}">wave19org</option>`);
  });
});

// --- POST /repo/create ----------------------------------------------------------

describe("POST /repo/create — the user arm (createUserRepository)", () => {
  it("creates with auto-init: 303 onto the repo home, the README commit landed", async () => {
    const fixture = await ensureWave19Fixtures();
    const name = `wave19auto-${suffix()}`;
    const res = await fetchUi(
      "/repo/create",
      formPost("/repo/create", { uid: "", repo_name: name, private: "on", auto_init: "on", description: "auto init" }, fixture.aliceCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/wave19alice/${name}`);

    const row = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.slug, name)).get())!;
    expect(row.ownerNamespace).toBe("wave19alice");
    expect(row.visibility).toBe("private");
    expect(row.isEmpty).toBe(false); // the auto-init commit flipped it
    const refs = await env.REPO.getByName(`wave19alice/${name}`).listRefs();
    expect((refs?.refs ?? []).map((ref) => ref.name)).toContain("refs/heads/main");
    const description = await drizzle(env.DB)
      .select({ description: repoSettings.description })
      .from(repoSettings)
      .where(eq(repoSettings.repoId, row.id))
      .get();
    expect(description?.description).toBe("auto init");
  });

  it("creates empty without auto-init: is_empty stays, public by default", async () => {
    const fixture = await ensureWave19Fixtures();
    const name = `wave19empty-${suffix()}`;
    const res = await fetchUi(
      "/repo/create",
      formPost("/repo/create", { uid: "", repo_name: name }, fixture.aliceCookie),
    );
    expect(res.status).toBe(303);
    const row = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.slug, name)).get())!;
    expect(row.isEmpty).toBe(true);
    expect(row.visibility).toBe("public"); // the checkbox absent
    expect(row.defaultBranch).toBe("main"); // the arm's IfZero default
  });

  it("re-renders the required-name, taken-name and invalid-name failures inline with the kept draft", async () => {
    const fixture = await ensureWave19Fixtures();
    // The empty name (the cf-gitea server-side message — upstream's HTML5
    // `required` catches the browser case).
    const empty = await fetchUi("/repo/create", formPost("/repo/create", { uid: "", repo_name: "" }, fixture.aliceCookie));
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain("A repository name is required.");

    // The taken name (upstream's web message "form.repo_name_been_taken");
    // the suffix keeps repeat runs collision-free until the seeded duplicate.
    const takenName = `wave19taken-${suffix()}`;
    const taken = await fetchUi(
      "/repo/create",
      formPost("/repo/create", { uid: "", repo_name: takenName, private: "on" }, fixture.aliceCookie),
    );
    expect(taken.status).toBe(303); // the first create seeds the collision
    const dup = await fetchUi(
      "/repo/create",
      formPost("/repo/create", { uid: "", repo_name: takenName, private: "on" }, fixture.aliceCookie),
    );
    expect(dup.status).toBe(200);
    const dupHtml = await dup.text();
    expect(dupHtml).toContain("The repository name is already used.");
    expect(dupHtml).toContain(`value="${takenName}"`); // the kept submission
    expect(dupHtml).toContain('id="private" name="private" type="checkbox" checked=""');

    // The invalid name (the ported service message — the API arm's 422 text).
    const invalid = await fetchUi(
      "/repo/create",
      formPost("/repo/create", { uid: "", repo_name: "has space" }, fixture.aliceCookie),
    );
    expect(invalid.status).toBe(200);
    expect(await invalid.text()).toContain("repository name is not allowed: has space");
  });

  it("answers anonymous and cross-origin POSTs with the 303 redirect and the 403 guard", async () => {
    const fixture = await ensureWave19Fixtures();
    const anon = await fetchUi("/repo/create", formPost("/repo/create", { repo_name: "x" }, "bogus"));
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toContain("/login?redirect_to=");

    const crossOrigin = await fetchUi(
      "/repo/create",
      formPost("/repo/create", { repo_name: "x" }, fixture.aliceCookie, "https://evil.example"),
    );
    expect(crossOrigin.status).toBe(403);
  });
});

describe("POST /repo/create — the org arm (requireCanCreateOrgRepo + RepoService.create)", () => {
  it("creates in the org: 303 onto the org repo, auto-init DROPPED (the honest degrade)", async () => {
    const fixture = await ensureWave19Fixtures();
    const name = `wave19orgrepo-${suffix()}`;
    const res = await fetchUi(
      "/repo/create",
      formPost(
        "/repo/create",
        { uid: String(fixture.org.id), repo_name: name, private: "on", auto_init: "on", description: "org repo" },
        fixture.morganCookie,
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/wave19org/${name}`);

    const row = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.slug, name)).get())!;
    expect(row.ownerNamespace).toBe("wave19org");
    expect(row.isEmpty).toBe(true); // the org arm has no initial-commit builder
    const refs = await env.REPO.getByName(`wave19org/${name}`).listRefs();
    expect((refs?.refs ?? []).filter((ref) => ref.name.startsWith("refs/heads/"))).toHaveLength(0);
    const description = await drizzle(env.DB)
      .select({ description: repoSettings.description })
      .from(repoSettings)
      .where(eq(repoSettings.repoId, row.id))
      .get();
    expect(description?.description).toBe("org repo"); // stored for both owner kinds
  });

  it("refuses a non-granted org member with the landed 403 message and a forged uid with the owner error", async () => {
    const fixture = await ensureWave19Fixtures();
    // Alice holds NO wave19org membership — the org arm's grant refusal
    // re-renders with the requireCanCreateOrgRepo message.
    const denied = await fetchUi(
      "/repo/create",
      formPost("/repo/create", { uid: String(fixture.org.id), repo_name: `wave19denied-${suffix()}` }, fixture.aliceCookie),
    );
    expect(denied.status).toBe(200);
    expect(await denied.text()).toContain("User is not allowed to create repositories in this organization.");

    // A uid pointing at ANOTHER USER (not in the owner list) — upstream's
    // checkContextUser 403, re-rendered inline (the module header).
    const forged = await fetchUi(
      "/repo/create",
      formPost("/repo/create", { uid: String(fixture.morganId), repo_name: `wave19forged-${suffix()}` }, fixture.aliceCookie),
    );
    expect(forged.status).toBe(200);
    expect(await forged.text()).toContain("You are not allowed to create repositories for this owner.");
  });
});

// --- GET+POST /org/create --------------------------------------------------------

describe("GET /org/create (the new-organization form)", () => {
  it("303s the anonymous viewer onto the login round-trip", async () => {
    const res = await fetchUi("/org/create");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/org/create")}`);
  });

  it("renders the upstream form for a signed-in viewer (visibility public, permission checked)", async () => {
    const fixture = await ensureWave19Fixtures();
    const res = await fetchUi("/org/create", withCookie(fixture.aliceCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    // org/create.tmpl's discriminator + the attached header/segment shape.
    expect(html).toContain("page-content organization new org");
    expect(html).toContain('<h3 class="ui top attached header">New Organization</h3>');
    expect(html).toContain('<form class="ui form left-right-form" action="/org/create" method="post">');
    expect(html).toContain('id="org_name" name="org_name"');
    expect(html).toContain('maxlength="40"');
    // The visibility radios post the landed enum strings; public is the
    // default (upstream GET's DefaultOrgVisibilityMode).
    expect(html).toContain('id="org-visibility-public" name="visibility" type="radio" value="public" checked=""');
    expect(html).toContain('id="org-visibility-limited" name="visibility" type="radio" value="limited"');
    expect(html).toContain('id="org-visibility-private" name="visibility" type="radio" value="private"');
    // The permission box defaults CHECKED (upstream GET's true).
    expect(html).toContain('id="repo_admin_change_team_access" name="repo_admin_change_team_access" type="checkbox" checked=""');
  });
});

describe("POST /org/create — the landed POST /orgs arm (OrgService.createOrg)", () => {
  it("creates the org with the creator as owner and 303s onto the org home", async () => {
    const fixture = await ensureWave19Fixtures();
    const name = `wave19neworg-${suffix()}`;
    const res = await fetchUi(
      "/org/create",
      formPost(
        "/org/create",
        {
          org_name: name,
          full_name: "Wave 19 Works",
          email: "crew@wave19.example",
          visibility: "limited",
          repo_admin_change_team_access: "on",
        },
        fixture.aliceCookie,
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${name}`);

    const orgs = new OrgService(env.DB);
    const org = (await orgs.getOrgByUsername(name))!;
    expect(org.fullName).toBe("Wave 19 Works");
    expect(org.email).toBe("crew@wave19.example");
    expect(org.visibility).toBe("limited");
    expect(org.repoAdminChangeTeamAccess).toBe(true);
    // The creator's role='owner' membership rode the same batch (SPEC-0007).
    expect(await orgs.isOrgOwner(org.id, fixture.aliceId)).toBe(true);
  });

  it("re-renders the typed failures with the module-header texts and the kept draft", async () => {
    const fixture = await ensureWave19Fixtures();
    // Taken (upstream's web message "form.org_name_been_taken").
    const taken = await fetchUi("/org/create", formPost("/org/create", { org_name: "wave19org" }, fixture.aliceCookie));
    expect(taken.status).toBe(200);
    const takenHtml = await taken.text();
    expect(takenHtml).toContain("The organization name is already taken.");
    expect(takenHtml).toContain('value="wave19org"');

    // Reserved (upstream's web message with the value interpolated; the
    // serialized form carries the JSX-escaped quotes).
    const reserved = await fetchUi("/org/create", formPost("/org/create", { org_name: "org" }, fixture.aliceCookie));
    expect(reserved.status).toBe(200);
    expect(await reserved.text()).toContain('The organization name &quot;org&quot; is reserved.');

    // Too long (no upstream web arm — the landed service message verbatim).
    const long = await fetchUi("/org/create", formPost("/org/create", { org_name: "a".repeat(41) }, fixture.aliceCookie));
    expect(long.status).toBe(200);
    expect(await long.text()).toContain("username is too long");

    // Invalid characters (the service's 422 text — unhandled upstream).
    const chars = await fetchUi("/org/create", formPost("/org/create", { org_name: "bad name!" }, fixture.aliceCookie));
    expect(chars.status).toBe(200);
    expect(await chars.text()).toContain("must be valid alpha or numeric or dash(-_) or dot characters");

    // Empty (the cf-gitea server-side message).
    const empty = await fetchUi("/org/create", formPost("/org/create", { org_name: "" }, fixture.aliceCookie));
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain("An organization name is required.");
  });

  it("answers anonymous and cross-origin POSTs with the 303 redirect and the 403 guard", async () => {
    const fixture = await ensureWave19Fixtures();
    const anon = await fetchUi("/org/create", formPost("/org/create", { org_name: "x" }, "bogus"));
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toContain("/login?redirect_to=");

    const crossOrigin = await fetchUi(
      "/org/create",
      formPost("/org/create", { org_name: "x" }, fixture.aliceCookie, "https://evil.example"),
    );
    expect(crossOrigin.status).toBe(403);
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("wave-19 a11y smoke", () => {
  it("both forms pass the structural rules for their signed-in viewer", async () => {
    const fixture = await ensureWave19Fixtures();
    for (const [path, init] of [
      ["/repo/create", withCookie(fixture.morganCookie)], // the org-bearing owner select
      ["/org/create", withCookie(fixture.aliceCookie)],
    ] as Array<[string, RequestInit]>) {
      const res = await fetchUi(path, init);
      expect(res.status, path).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, path).toEqual([]);
    }
  });
});
