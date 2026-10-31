/**
 * The org settings APPLICATIONS tab's tests (the census R20-a module —
 * GET /{org}/settings/applications + POST .../oauth2 + POST .../oauth2/{id}
 * /delete at ui/index.ts): the load/parse/apply matrix over real D1
 * (generated migrations in beforeAll; the writes go through the landed
 * oauth2 service arms — the same `oauth2_application` store the API family
 * reads and writes, routes/oauth2-apps.ts) and the DOM contract of the page
 * render — hono/jsx renderToString, the module driven directly. The
 * deferred-test matrix also drives the real routes (the blocked-users
 * matrix's minted-session uiRouter pattern): the org-teams prologue's
 * anonymous-303 / non-owner-404-shell posture on GET and on both POSTs, the
 * owner's create round-trip with the once-only secret re-render and the
 * delete round-trip, the uid=org.id isolation (a user-owned app never lists
 * and never deletes through the org arm), the exact upstream banner texts
 * on the invalid arms, the guard-first cross-origin 403, the 405s on the
 * POST-only tails, and the route claim pin (the edit shapes stay
 * unclaimed).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import {
  createOAuth2Application,
  verifyClientSecret,
  type OAuth2AppRow,
} from "../../api/services/oauth2-apps";
import { oauth2Applications, orgMembers, users } from "../../db/schema";
import type { OrgRecord } from "../../services/orgs/orgs";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import { OrgSettingsNavbar } from "../components/settings-nav";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { Viewer } from "../viewer";
import {
  applyOrgApplicationCreate,
  deleteOrgApplication,
  loadOrgSettingsApplications,
  OrgApplicationsPage,
  orgSettingsApplicationsLocale,
  parseOrgApplicationCreateForm,
  renderOrgApplicationsPage,
  splitRedirectUris,
} from "./org-settings-applications";
import { oauth2AppEditLocale, oauth2AppEditPageData, renderOrgOauth2AppEditPage } from "./oauth2-app-edit";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

/** The signed-in owner viewing the page (ids assigned at seed time — never
 *  hardcoded). */
let viewer: Viewer = { kind: "anonymous" };
let ctx: UiContext;

interface SeededUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

async function seedUser(username: string, type: "user" | "org" = "user"): Promise<SeededUser> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      type,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, username: user.username, isAdmin: false };
}

/** The seeded org row plus its OrgRecord projection (the org-settings family's
 *  render input). */
let org: { id: number; username: string; record: OrgRecord };

const ORG_CREATED = new Date("2026-01-01T00:00:00Z");

function orgRecord(id: number, username: string): OrgRecord {
  return {
    id,
    username,
    usernameLower: username.toLowerCase(),
    email: null,
    fullName: null,
    description: null,
    website: null,
    location: null,
    avatarEmail: null,
    useCustomAvatar: false,
    visibility: "public",
    numMembers: 0,
    repoAdminChangeTeamAccess: false,
    createdAt: ORG_CREATED,
  };
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["oauth2_application", "org_members", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // The signed-in owner + the org, with the owner-membership row the route
  // stage's requireOrgOwnership precondition promises (services/orgs.ts —
  // org owner role='owner').
  const alice = await seedUser("alice");
  viewer = { kind: "user", id: alice.id, username: alice.username, isAdmin: false };
  ctx = { viewer, origin: ORIGIN, assets: shellAssetsFromManifest(manifest) };
  const row = await seedUser("acme", "org");
  await drizzle(env.DB)
    .insert(orgMembers)
    .values({ orgId: row.id, userId: alice.id, role: "owner", createdAt: ORG_CREATED })
    .run();
  org = { id: row.id, username: row.username, record: orgRecord(row.id, row.username) };
});

/** Seed an application through the landed create arm (the page's own write)
 *  — `uid` is the OWNER id: the org's id for org-owned rows, a user's id for
 *  the isolation fixtures. Returns the stored row (the plaintext secret is
 *  discarded unless the caller wants it). */
async function seedApp(name: string, uid: number, uris: string[] = ["https://app.example/callback"]): Promise<OAuth2AppRow> {
  const { row } = await createOAuth2Application(
    env.DB,
    { uid, name, redirectUris: uris, confidentialClient: true, skipSecondaryAuthorization: false },
    new Date("2026-01-02T00:00:00Z"),
  );
  return row;
}

// --- the loader ----------------------------------------------------------------

describe("loadOrgSettingsApplications (the OwnerID read arm, uid=org.id)", () => {
  it("an empty store loads zero rows", async () => {
    const data = await loadOrgSettingsApplications(env.DB, org.record);
    expect(data.apps).toEqual([]);
  });

  it("carries the org's apps in id DESC order (the service's ToOrders order)", async () => {
    const first = await seedApp("first app", org.id);
    const second = await seedApp("second app", org.id);
    const data = await loadOrgSettingsApplications(env.DB, org.record);
    expect(data.apps.map((app) => [app.id, app.name])).toEqual([
      [second.id, "second app"],
      [first.id, "first app"],
    ]);
  });

  it("uid=org.id isolation: a user-owned app and another org's app never appear", async () => {
    const aliceId = viewer.kind === "user" ? viewer.id : 0;
    await seedApp("alice private app", aliceId);
    const other = await seedUser("otherorg", "org");
    await seedApp("other org app", other.id);
    const data = await loadOrgSettingsApplications(env.DB, org.record);
    expect(data.apps).toEqual([]);
  });

  it("the plain GET's render inputs: fresh form (no secret state — the W5 create answer is the shared edit page)", async () => {
    const data = await loadOrgSettingsApplications(env.DB, org.record);
    expect(data.form).toEqual({ name: "", redirectUrisRaw: "", confidentialClient: true, skipSecondaryAuthorization: false });
  });
});

// --- the form parse ------------------------------------------------------------

describe("parseOrgApplicationCreateForm (EditOAuth2ApplicationForm: application_name/redirect_uris/confidential_client/skip_secondary_authorization)", () => {
  it("parses the create post with the checked boxes", () => {
    expect(
      parseOrgApplicationCreateForm(
        new URLSearchParams({
          application_name: "my app",
          redirect_uris: "https://a.example/cb\nhttps://b.example/cb",
          confidential_client: "on",
          skip_secondary_authorization: "on",
        }),
      ),
    ).toEqual({
      name: "my app",
      redirectUrisRaw: "https://a.example/cb\nhttps://b.example/cb",
      confidentialClient: true,
      skipSecondaryAuthorization: true,
    });
  });

  it("an absent checkbox parses false; missing fields parse empty", () => {
    expect(parseOrgApplicationCreateForm(new URLSearchParams({ application_name: "x" }))).toEqual({
      name: "x",
      redirectUrisRaw: "",
      confidentialClient: false,
      skipSecondaryAuthorization: false,
    });
    expect(parseOrgApplicationCreateForm(new URLSearchParams()).name).toBe("");
  });
});

// --- the write -----------------------------------------------------------------

describe("splitRedirectUris (util.SplitTrimSpace's newline split)", () => {
  it("splits per line, trims, and drops the blanks", () => {
    expect(splitRedirectUris("https://a.example/cb\n\n  https://b.example/cb  \n")).toEqual([
      "https://a.example/cb",
      "https://b.example/cb",
    ]);
    expect(splitRedirectUris("")).toEqual([]);
  });
});

describe("applyOrgApplicationCreate (AddApp's write half over the landed service, uid=org.id)", () => {
  it("creates through the org arm — the row lands with uid=org.id and the plaintext verifies against the stored hash", async () => {
    const result = await applyOrgApplicationCreate(env.DB, org.record, {
      name: "ci badge",
      redirectUrisRaw: "https://ci.example/cb",
      confidentialClient: true,
      skipSecondaryAuthorization: false,
    });
    if (result.outcome !== "created") throw new Error(`expected created, got ${JSON.stringify(result)}`);
    expect(result.row.uid).toBe(org.id);
    expect(result.row.name).toBe("ci badge");
    expect(result.secret).not.toBe(result.row.clientSecret); // the store keeps the HASH
    expect(await verifyClientSecret(result.row.clientSecret, result.secret)).toBe(true);
    const data = await loadOrgSettingsApplications(env.DB, org.record);
    expect(data.apps.map((app) => app.id)).toEqual([result.row.id]);
  });

  it("a blank name — the Required bind arm (the shared binder's form.require_error)", async () => {
    const result = await applyOrgApplicationCreate(env.DB, org.record, {
      name: "",
      redirectUrisRaw: "https://ci.example/cb",
      confidentialClient: true,
      skipSecondaryAuthorization: false,
    });
    expect(result).toEqual({ outcome: "invalid", message: "Name cannot be empty." });
  });

  it("a rejected redirect URI — the DetectInvalid validate arm (the exact user_form.go:267-269 composite)", async () => {
    const result = await applyOrgApplicationCreate(env.DB, org.record, {
      name: "bad uris",
      redirectUrisRaw: "not-a-uri",
      confidentialClient: true,
      skipSecondaryAuthorization: false,
    });
    expect(result).toEqual({ outcome: "invalid", message: `RedirectURIs: "${"not-a-uri"}" is not a valid URL.` });
    expect((await loadOrgSettingsApplications(env.DB, org.record)).apps).toEqual([]); // nothing written
  });

  it("an empty textarea — the redirect_uris Required bind arm (nothing written)", async () => {
    const result = await applyOrgApplicationCreate(env.DB, org.record, {
      name: "no uris",
      redirectUrisRaw: "",
      confidentialClient: true,
      skipSecondaryAuthorization: false,
    });
    expect(result).toEqual({ outcome: "invalid", message: "RedirectURIs cannot be empty." });
    expect((await loadOrgSettingsApplications(env.DB, org.record)).apps).toEqual([]);
  });
});

describe("deleteOrgApplication (the shared (id, uid=org.id) delete + the builtin lock)", () => {
  it("deletes the org's own app", async () => {
    const app = await seedApp("doomed", org.id);
    expect(await deleteOrgApplication(env.DB, org.record, app.id)).toEqual({ kind: "deleted" });
    expect((await loadOrgSettingsApplications(env.DB, org.record)).apps).toEqual([]);
  });

  it("a user-owned app is the miss arm (the (id, uid) pair never satisfies)", async () => {
    const aliceId = viewer.kind === "user" ? viewer.id : 0;
    const app = await seedApp("alice private app", aliceId);
    expect(await deleteOrgApplication(env.DB, org.record, app.id)).toEqual({ kind: "not_found" });
    const still = await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, app.id)).all();
    expect(still).toHaveLength(1); // existence stays hidden, the row survives
  });
});

// --- the DOM --------------------------------------------------------------------

describe("the applications tab DOM (org/settings/applications.tmpl × applications_oauth2_list.tmpl at the pin)", () => {
  it("renders the upstream pageClass quirk and the full-document render path", async () => {
    const data = await loadOrgSettingsApplications(env.DB, org.record);
    const html = renderToString(<OrgApplicationsPage ctx={ctx} data={data} error={null} />);
    // org/settings/applications.tmpl:1 passes the OPTIONS page's pageClass —
    // the verbatim upstream quirk (the hooks page's Settings-h4 precedent).
    expect(html).toContain("organization settings options");
    expect(html).toContain('action="/acme/settings/applications/oauth2"');
    expect(renderOrgApplicationsPage({ ctx, data, error: null })).toContain(
      'action="/acme/settings/applications/oauth2"',
    );
  });

  it("renders the h4, the description line, and the create form's verbatim fields", async () => {
    const data = await loadOrgSettingsApplications(env.DB, org.record);
    const html = renderToString(<OrgApplicationsPage ctx={ctx} data={data} error={null} />);
    expect(html).toContain(`>${orgSettingsApplicationsLocale.applications}</h4>`);
    expect(html).toContain(orgSettingsApplicationsLocale.create_description);
    expect(html).toContain('name="application_name"');
    expect(html).toContain('id="application-name"');
    expect(html).toContain('name="redirect_uris"');
    expect(html).toContain('id="redirect-uris"');
    expect(html).toContain('name="confidential_client"');
    expect(html).toContain('name="skip_secondary_authorization"');
    expect(html).toContain(`>${orgSettingsApplicationsLocale.create_oauth2_application_button}</button>`);
    expect(html).toContain(orgSettingsApplicationsLocale.confidential_client);
    expect(html).toContain(orgSettingsApplicationsLocale.skip_secondary_authorization);
    expect(html).toContain(orgSettingsApplicationsLocale.redirect_uris);
  });

  it("renders the rows: the glyph stand-in, the name, the Client ID label, the W5 Edit link + the remove form", async () => {
    const app = await seedApp("row app", org.id);
    const data = await loadOrgSettingsApplications(env.DB, org.record);
    const html = renderToString(<OrgApplicationsPage ctx={ctx} data={data} error={null} />);
    expect(html).toContain(">row app</div>"); // the item-title
    expect(html).toContain(orgSettingsApplicationsLocale.client_id);
    expect(html).toContain(`<span class="ui label"> ${app.clientId}</span>`); // the ui label projection
    expect(html).toContain(`action="/acme/settings/applications/oauth2/${app.id}/delete"`);
    expect(html).toContain(`name="id" value="${String(app.id)}"`);
    expect(html).toContain(orgSettingsApplicationsLocale.remove);
    // The W5 Edit anchor (applications_oauth2_list.tmpl:23-26) rides the
    // shared edit page (the module header's W5 record); the confirm dialog
    // stays unreproduced.
    expect(html).toContain(`href="/acme/settings/applications/oauth2/${app.id}"`);
    expect(html).toContain("octicon-pencil");
    expect(html).not.toContain("remove-gitea-oauth2-application");
  });

  it("renders the empty arm when the org owns no applications", async () => {
    const data = await loadOrgSettingsApplications(env.DB, org.record);
    const html = renderToString(<OrgApplicationsPage ctx={ctx} data={data} error={null} />);
    expect(html).toContain(orgSettingsApplicationsLocale.no_apps);
  });

  it("the create details closes when apps exist, opens on the empty and after-error arms", async () => {
    const empty = await loadOrgSettingsApplications(env.DB, org.record);
    expect(renderToString(<OrgApplicationsPage ctx={ctx} data={empty} error={null} />)).toContain("<details open");
    const app = await seedApp("one", org.id);
    const loaded = await loadOrgSettingsApplications(env.DB, org.record);
    expect(renderToString(<OrgApplicationsPage ctx={ctx} data={loaded} error={null} />)).toContain("<details>");
    expect(
      renderToString(<OrgApplicationsPage ctx={ctx} data={loaded} error="Name cannot be empty." />),
    ).toContain("<details open");
    void app;
  });

  it("the W5 shared edit page renders in the ORG chrome: the masked arm on a plain show, the plaintext arm on a regenerate", async () => {
    const app = await seedApp("edit me", org.id);
    const showData = oauth2AppEditPageData(app, `/acme/settings/applications/oauth2/${app.id}`);
    const showHtml = renderOrgOauth2AppEditPage(ctx, org.record, showData, true);
    expect(showHtml).toContain("organization settings options"); // the org chrome quirk
    expect(showHtml).toContain(`action="/acme/settings/applications/oauth2/${app.id}/regenerate_secret"`);
    expect(showHtml).toContain('id="client-secret" type="password" readonly'); // the masked arm
    expect(showHtml).toContain(oauth2AppEditLocale.masked_secret_placeholder);
    const regenData = oauth2AppEditPageData(app, `/acme/settings/applications/oauth2/${app.id}`);
    regenData.clientSecret = "gto_plaintext-once-value";
    const regenHtml = renderOrgOauth2AppEditPage(ctx, org.record, regenData, true);
    expect(regenHtml).toContain('id="client-secret" type="text" readonly'); // the shown-once arm
    expect(regenHtml).toContain("gto_plaintext-once-value");
    expect(regenHtml).not.toContain(oauth2AppEditLocale.masked_secret_placeholder);
  });

  it("the invalid-POST re-render carries the negative message banner", async () => {
    const data = await loadOrgSettingsApplications(env.DB, org.record);
    const html = renderToString(<OrgApplicationsPage ctx={ctx} data={data} error={`RedirectURIs: "${"not-a-uri"}" is not a valid URL.`} />);
    expect(html).toContain('class="ui negative message"');
    // The banner text is HTML-escaped in the DOM (hono/jsx) — the quotes
    // render as &quot;.
    expect(html).toContain("RedirectURIs: &quot;not-a-uri&quot; is not a valid URL.");
  });

  it("the shared navbar renders the Applications item active between Labels and Blocked users", () => {
    const html = renderToString(<OrgSettingsNavbar orgLink="/acme" active="applications" />);
    expect(html).toContain('class="active item" href="/acme/settings/applications"');
    expect(html).toContain('href="/acme/settings/hooks"'); // Hooks
    expect(html).toContain('href="/acme/labels"'); // Labels
    expect(html).toContain('href="/acme/settings/blocked_users"'); // Blocked users
    expect(html).toContain(orgSettingsApplicationsLocale.applications);
    // The other tabs never steal the active mark.
    const blocked = renderToString(<OrgSettingsNavbar orgLink="/acme" active="blocked" />);
    expect(blocked).toContain('class="active item" href="/acme/settings/blocked_users"');
    expect(blocked).not.toContain('class="active item" href="/acme/settings/applications"');
  });
});

// --- the mounted-route harness (the blocked-users matrix pattern) -----------------

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The real production path: parse → resolveUiSession → the org-teams
 *  prologue → load → render, on the mounted uiRouter with the synthetic
 *  manifest; the execution context is awaited so waitUntil side-effects
 *  settle before assertions. `envOverrides` re-spells wrangler vars (the W5
 *  gate arms). */
async function fetchUi(path: string, init?: RequestInit, envOverrides: Record<string, string> = {}): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), { ...routeEnv, ...envOverrides }, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A minted session cookie header for the seeded user id (the real
 *  mintSession path, minted per request — the beforeEach users wipe
 *  cascades the sessions table; the value is never rendered). */
async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** The fixture owner's minted session header (ids are seed-assigned —
 *  never hardcoded). */
async function ownerSessionHeader(): Promise<string> {
  if (viewer.kind !== "user") throw new Error("fixture viewer missing");
  return sessionHeader(viewer.id);
}

/** The owner's GET of the tab through the real route. */
async function applicationsGet(): Promise<Response> {
  return fetchUi(`/${org.username}/settings/applications`, {
    headers: { cookie: await ownerSessionHeader() },
  });
}

/** A urlencoded create POST to the tab's oauth2 tail through the real
 *  route: the browser's same-origin Origin header (the §2.8 guard's happy
 *  path) and the given session (default the owner's). */
async function createPost(
  fields: Record<string, string>,
  session: string | null = "owner",
  origin: string = ORIGIN,
  envOverrides: Record<string, string> = {},
): Promise<Response> {
  const cookie = session === "owner" ? await ownerSessionHeader() : session;
  return fetchUi(
    `/${org.username}/settings/applications/oauth2`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(origin !== "" ? { origin } : {}),
        ...(cookie !== null ? { cookie } : {}),
      },
      body: new URLSearchParams(fields).toString(),
    },
    envOverrides,
  );
}

/** A delete POST through the real route (same-origin by default). */
async function deletePost(id: number, session: string | null = "owner", origin: string = ORIGIN): Promise<Response> {
  const cookie = session === "owner" ? await ownerSessionHeader() : session;
  return fetchUi(`/${org.username}/settings/applications/oauth2/${id}/delete`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(origin !== "" ? { origin } : {}),
      ...(cookie !== null ? { cookie } : {}),
    },
    body: new URLSearchParams({ id: String(id) }).toString(),
  });
}

// --- the mounted routes (GET + POST /{org}/settings/applications[...]) -------------

describe("the mounted routes (the R20-a arm through the org-teams prologue)", () => {
  it("303s an anonymous GET onto the login round-trip (the org-teams prologue)", async () => {
    const res = await fetchUi(`/${org.username}/settings/applications`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent(`/${org.username}/settings/applications`)}`,
    );
  });

  it("303s an anonymous same-origin create POST onto the login round-trip too; nothing written", async () => {
    const res = await createPost(
      { application_name: "ghost app", redirect_uris: "https://ci.example/cb", confidential_client: "on" },
      null,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent(`/${org.username}/settings/applications/oauth2`)}`,
    );
    expect((await loadOrgSettingsApplications(env.DB, org.record)).apps).toEqual([]);
  });

  it("404-shells a signed-in member non-owner's GET (the RequireOwner posture)", async () => {
    const bob = await seedUser("bob");
    await drizzle(env.DB)
      .insert(orgMembers)
      .values({ orgId: org.id, userId: bob.id, role: "member", createdAt: ORG_CREATED })
      .run();
    const res = await fetchUi(`/${org.username}/settings/applications`, {
      headers: { cookie: await sessionHeader(bob.id) },
    });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("status-page-error"); // the 404 shell
    expect(html).not.toContain("org-setting-content"); // never the tab's content
  });

  it("404-shells a member non-owner's create POST before any write", async () => {
    const bob = await seedUser("bob");
    await drizzle(env.DB)
      .insert(orgMembers)
      .values({ orgId: org.id, userId: bob.id, role: "member", createdAt: ORG_CREATED })
      .run();
    const res = await createPost(
      { application_name: "sneaky app", redirect_uris: "https://ci.example/cb", confidential_client: "on" },
      await sessionHeader(bob.id),
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
    expect((await loadOrgSettingsApplications(env.DB, org.record)).apps).toEqual([]);
  });

  it("404-shells a member non-owner's delete POST; the row survives", async () => {
    const app = await seedApp("kept", org.id);
    const bob = await seedUser("bob");
    await drizzle(env.DB)
      .insert(orgMembers)
      .values({ orgId: org.id, userId: bob.id, role: "member", createdAt: ORG_CREATED })
      .run();
    const res = await deletePost(app.id, await sessionHeader(bob.id));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
    expect((await loadOrgSettingsApplications(env.DB, org.record)).apps.map((row) => row.id)).toEqual([app.id]);
  });

  it("renders the owner's GET at 200 with the pageClass quirk and the active navbar item", async () => {
    const res = await applicationsGet();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("organization settings options"); // the §2.4.1 pageClass (the upstream quirk)
    expect(html).toContain(`class="active item" href="/${org.username}/settings/applications"`);
    expect(html).toContain(orgSettingsApplicationsLocale.no_apps); // the empty arm
  });

  it("a create POST renders the shared EDIT page with the once-only secret, the row lands, and the follow-up GET masks it", async () => {
    const res = await createPost({
      application_name: "ci badge",
      redirect_uris: "https://ci.example/cb",
      confidential_client: "on",
    });
    // Upstream AddApp answers by rendering the edit page with the plaintext
    // secret (oauth2_common.go:79-87) — the W5 shared edit page serves
    // exactly that in the org chrome; NOT a redirect, NOT the list.
    expect(res.status).toBe(200);
    const html = await res.text();
    const plaintext = /gto_[a-z2-7]{52}/.exec(html)?.[0] ?? "";
    expect(plaintext).not.toBe("");
    expect(html).toContain('id="client-secret" type="text" readonly'); // the shown-once arm
    expect(html).toContain(`value="${plaintext}"`);
    expect(html).toContain("organization settings options"); // the org chrome
    expect(html).toMatch(/action="\/acme\/settings\/applications\/oauth2\/\d+"/); // the FormActionPath
    const data = await loadOrgSettingsApplications(env.DB, org.record);
    expect(data.apps).toHaveLength(1);
    expect(data.apps[0]?.uid).toBe(org.id);
    expect(JSON.stringify(data.apps)).not.toContain(plaintext); // the store keeps the hash only

    // The follow-up GET lists the app; the plaintext never re-renders.
    const clientId = data.apps[0]?.clientId ?? "";
    const page = await applicationsGet();
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain(`<span class="ui label"> ${clientId}</span>`);
    expect(pageHtml).not.toContain(plaintext);
    // The plain show re-renders the MASKED placeholder instead.
    const show = await fetchUi(`/${org.username}/settings/applications/oauth2/${data.apps[0]?.id}`, {
      headers: { cookie: await ownerSessionHeader() },
    });
    expect(show.status).toBe(200);
    const showHtml = await show.text();
    expect(showHtml).toContain('id="client-secret" type="password" readonly');
    expect(showHtml).not.toContain(plaintext);
  });

  it("an invalid create POST re-renders the list at 200 with the banner and the kept submission, nothing written", async () => {
    const res = await createPost({
      application_name: "bad uris app",
      redirect_uris: "not-a-uri",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain("RedirectURIs: &quot;not-a-uri&quot; is not a valid URL."); // the escaped banner
    expect(html).toContain('value="bad uris app"'); // the kept name
    expect(html).toContain("not-a-uri"); // the kept textarea
    expect((await loadOrgSettingsApplications(env.DB, org.record)).apps).toEqual([]);
  });

  it("the W5 edit arms: save updates WITHOUT rotating the secret and 303s home; a bind error re-renders the edit page with the kept values", async () => {
    const created = await applyOrgApplicationCreate(env.DB, org.record, {
      name: "ci badge",
      redirectUrisRaw: "https://ci.example/cb",
      confidentialClient: true,
      skipSecondaryAuthorization: false,
    });
    if (created.outcome !== "created") throw new Error("seed create failed");
    const firstSecret = created.secret;

    const saved = await fetchUi(`/${org.username}/settings/applications/oauth2/${created.row.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
        cookie: await ownerSessionHeader(),
      },
      body: new URLSearchParams({ application_name: "renamed", redirect_uris: "https://new.example/cb" }).toString(),
    });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(`/${org.username}/settings/applications`);
    const row = await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, created.row.id)).get();
    expect(row?.name).toBe("renamed");
    expect(JSON.parse(row?.redirectUris ?? "[]")).toEqual(["https://new.example/cb"]);
    // THE WEB SAVE NEVER ROTATES — the original plaintext still verifies.
    expect(await verifyClientSecret(row?.clientSecret ?? "", firstSecret)).toBe(true);

    // A bind error re-renders the edit page (200) with the negative line +
    // the kept submission.
    const invalid = await fetchUi(`/${org.username}/settings/applications/oauth2/${created.row.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
        cookie: await ownerSessionHeader(),
      },
      body: new URLSearchParams({ application_name: "", redirect_uris: "https://ci.example/cb" }).toString(),
    });
    expect(invalid.status).toBe(200);
    const invalidHtml = await invalid.text();
    expect(invalidHtml).toContain('class="ui negative message">Name cannot be empty.');
    expect(invalidHtml).toContain('id="client-secret" type="password" readonly'); // no secret leak on the error arm
    const untouched = await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, created.row.id)).get();
    expect(untouched?.name).toBe("renamed"); // nothing written
  });

  it("the W5 regenerate arm re-renders the edit page with a FRESH plaintext once; the old secret stops verifying", async () => {
    const created = await applyOrgApplicationCreate(env.DB, org.record, {
      name: "ci badge",
      redirectUrisRaw: "https://ci.example/cb",
      confidentialClient: true,
      skipSecondaryAuthorization: false,
    });
    if (created.outcome !== "created") throw new Error("seed create failed");
    const regen = await fetchUi(`/${org.username}/settings/applications/oauth2/${created.row.id}/regenerate_secret`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
        cookie: await ownerSessionHeader(),
      },
      body: "",
    });
    expect(regen.status).toBe(200);
    const html = await regen.text();
    const fresh = /gto_[a-z2-7]{52}/.exec(html)?.[0] ?? "";
    expect(fresh).not.toBe("");
    expect(fresh).not.toBe(created.secret);
    expect(html).toContain('id="client-secret" type="text" readonly');
    const row = await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, created.row.id)).get();
    expect(await verifyClientSecret(row?.clientSecret ?? "", fresh)).toBe(true);
    expect(await verifyClientSecret(row?.clientSecret ?? "", created.secret)).toBe(false);
  });

  it("the W5 gate: OAUTH2_ENABLED=false answers the group's 403 on the list and every write arm", async () => {
    const gatedList = await fetchUi(`/${org.username}/settings/applications`, {
      headers: { cookie: await ownerSessionHeader() },
    }, { OAUTH2_ENABLED: "false" });
    expect(gatedList.status).toBe(403);
    expect(await gatedList.text()).toBe("Forbidden\n"); // web.go:373-378's body
    const gatedCreate = await createPost(
      { application_name: "x", redirect_uris: "https://ci.example/cb" },
      "owner",
      ORIGIN,
      { OAUTH2_ENABLED: "false" },
    );
    expect(gatedCreate.status).toBe(403);
    expect(await gatedCreate.text()).toBe("Forbidden\n");
  });

  it("a delete POST 303s back onto the tab and the row is gone", async () => {
    const app = await seedApp("doomed", org.id);
    const res = await deletePost(app.id);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${org.username}/settings/applications`);
    expect((await loadOrgSettingsApplications(env.DB, org.record)).apps).toEqual([]);
  });

  it("a delete POST on a user-owned app id 404-shells and the row survives (the uid isolation through the route)", async () => {
    const aliceId = viewer.kind === "user" ? viewer.id : 0;
    const foreign = await seedApp("alice private app", aliceId);
    const res = await deletePost(foreign.id);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
    const still = await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, foreign.id)).all();
    expect(still).toHaveLength(1);
  });

  it("rejects a cross-origin create POST with 403 before any write (sameOriginGuard first)", async () => {
    const res = await createPost(
      { application_name: "evil app", redirect_uris: "https://evil.example/cb", confidential_client: "on" },
      "owner",
      "https://evil.example",
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
    expect((await loadOrgSettingsApplications(env.DB, org.record)).apps).toEqual([]);
  });

  it("rejects a cross-origin delete POST with 403; the row survives", async () => {
    const app = await seedApp("kept", org.id);
    const res = await deletePost(app.id, "owner", "https://evil.example");
    expect(res.status).toBe(403);
    expect((await loadOrgSettingsApplications(env.DB, org.record)).apps.map((row) => row.id)).toEqual([app.id]);
  });

  it("the POST-only tails answer GET with 405 (the hooks-family convention)", async () => {
    const create = await fetchUi(`/${org.username}/settings/applications/oauth2`, {
      headers: { cookie: await ownerSessionHeader() },
    });
    expect(create.status).toBe(405);
    const del = await fetchUi(`/${org.username}/settings/applications/oauth2/1/delete`, {
      headers: { cookie: await ownerSessionHeader() },
    });
    expect(del.status).toBe(405);
  });
});

// --- the route claim pin (parse ↔ registration — the blocked-matrix pin) -----------

describe("the route claim pin (the settings family claims exactly the applications family)", () => {
  it("parses the five shapes; misspellings and junk ids stay unclaimed", () => {
    expect(parseUiRoute(`/${org.username}/settings/applications`)).toEqual({
      family: "org-settings-applications",
      owner: org.username,
    });
    expect(parseUiRoute(`/${org.username}/settings/applications/oauth2`)).toEqual({
      family: "org-settings-applications-create",
      owner: org.username,
    });
    expect(parseUiRoute(`/${org.username}/settings/applications/oauth2/7/delete`)).toEqual({
      family: "org-settings-applications-delete",
      owner: org.username,
      id: 7,
    });
    // The W5 edit arms: the {id} combo (GET show + POST save) + the
    // regenerate tail.
    expect(parseUiRoute(`/${org.username}/settings/applications/oauth2/7`)).toEqual({
      family: "org-settings-applications-app",
      owner: org.username,
      id: 7,
    });
    expect(parseUiRoute(`/${org.username}/settings/applications/oauth2/7/regenerate_secret`)).toEqual({
      family: "org-settings-applications-regenerate",
      owner: org.username,
      id: 7,
    });
    expect(handlesUiRoute(`/${org.username}/settings/applications`)).toBe(true);
    expect(handlesUiRoute(`/${org.username}/settings/applications/oauth2/7`)).toBe(true);
    // The singular misspelling and deeper tails.
    expect(parseUiRoute(`/${org.username}/settings/application`)).toBeNull();
    expect(parseUiRoute(`/${org.username}/settings/applications/extra`)).toBeNull();
    expect(handlesUiRoute(`/${org.username}/settings/applications/extra`)).toBe(false);
    // A junk id never claims (the hooks-family integer parity).
    expect(parseUiRoute(`/${org.username}/settings/applications/oauth2/xx/delete`)).toBeNull();
    expect(parseUiRoute(`/${org.username}/settings/applications/oauth2/xx`)).toBeNull();
    expect(parseUiRoute(`/${org.username}/settings/applications/oauth2/7/unknown`)).toBeNull();
  });
});
