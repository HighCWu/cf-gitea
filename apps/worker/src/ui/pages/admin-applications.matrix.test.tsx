/**
 * The ADMIN APPLICATIONS page's matrix: the uid=0 instance-wide read over
 * the landed oauth2 service (the census's "a read over the landed
 * oauth2Applications table"), the create/delete write ports over the W5
 * shared binder, the BuiltinApplications lock arm (the migration 0052 seed's
 * five client IDs render the Locked label and refuse the write arms), and
 * the DOM contract (admin/applications/list.tmpl ×
 * user/settings/applications_oauth2_list.tmpl): the app rows with the
 * client-id label, the Edit links (the W5 shared edit page) + Remove forms,
 * the create form's field set, the details-open arms, and the mounted
 * route round-trips (the W5 edit arms + the OAUTH2_ENABLED 403 gate).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { oauth2Applications, users } from "../../db/schema";
import { createOAuth2Application, verifyClientSecret } from "../../api/services/oauth2-apps";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import { uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import {
  AdminApplicationsPage,
  applyAdminApplicationCreate,
  applyAdminApplicationDelete,
  loadAdminApplicationsData,
  parseAdminApplicationCreateForm,
  splitRedirectUris,
} from "./admin-applications";
import { BUILTIN_OAUTH2_CLIENT_IDS, oauth2AppEditLocale } from "./oauth2-app-edit";

const T0 = 1_700_000_000;
const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const viewer: Viewer = { kind: "user", id: 1, username: "root", isAdmin: true };
const ctx: UiContext = { viewer, origin: ORIGIN, assets: shellAssetsFromManifest(manifest) };

/** Two GLOBAL apps (uid=0 — the admin page's own writes), one BUILTIN-
 *  client-id global app (the lock arm), and one USER-owned app that must
 *  never surface. The user-owned row rides the landed API create
 *  (doer-scoped — the service call the /user route makes). */
async function seedAppWorld(): Promise<{ globalIds: number[]; builtinId: number; userAppId: number }> {
  const alice = await drizzle(env.DB)
    .insert(users)
    .values({ username: "alice", usernameLower: "alice", status: "active", createdAt: new Date(T0 * 1000) })
    .returning({ id: users.id })
    .all();
  const aliceId = alice[0]!.id;
  const now = new Date(T0 * 1000);
  const g1 = await createOAuth2Application(
    env.DB,
    { uid: 0, name: "ci-client", redirectUris: ["https://ci.test/cb"], confidentialClient: true, skipSecondaryAuthorization: false },
    now,
  );
  const g2 = await createOAuth2Application(
    env.DB,
    { uid: 0, name: "aaa-older", redirectUris: [], confidentialClient: false, skipSecondaryAuthorization: false },
    now,
  );
  const seededBuiltin = await drizzle(env.DB)
    .insert(oauth2Applications)
    .values({
      uid: 0,
      name: "Git Credential Manager",
      clientId: BUILTIN_OAUTH2_CLIENT_IDS[1]!,
      clientSecret: "",
      confidentialClient: false,
      skipSecondaryAuthorization: false,
      redirectUris: JSON.stringify(["http://127.0.0.1", "https://127.0.0.1"]),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: oauth2Applications.id })
    .all();
  const owned = await createOAuth2Application(
    env.DB,
    { uid: aliceId, name: "alice-app", redirectUris: ["https://alice.test/cb"], confidentialClient: true, skipSecondaryAuthorization: false },
    now,
  );
  return { globalIds: [g1.row.id, g2.row.id], builtinId: seededBuiltin[0]!.id, userAppId: owned.row.id };
}

async function renderPage(): Promise<string> {
  return renderToString(<AdminApplicationsPage ctx={ctx} data={await loadAdminApplicationsData(env.DB)} />);
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["users", "sessions", "oauth2_application"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("loadAdminApplicationsData — the IsGlobal read", () => {
  it("lists ONLY the uid=0 rows, id DESC (ToOrders); user-owned rows never surface", async () => {
    const ids = await seedAppWorld();
    const data = await loadAdminApplicationsData(env.DB);
    // id DESC: the seeded builtin landed last → first.
    expect(data.apps.map((app) => app.id)).toEqual([ids.builtinId, ...[...ids.globalIds].reverse()]);
    expect(data.apps.some((app) => app.id === ids.userAppId)).toBe(false);
    expect(data.apps.every((app) => app.uid === 0)).toBe(true);
  });

  it("answers an empty list on a bare store (with the closed create form armed open)", async () => {
    const data = await loadAdminApplicationsData(env.DB);
    expect(data.apps).toEqual([]);
    const html = renderToString(<AdminApplicationsPage ctx={ctx} data={data} />);
    expect(html).toContain('<details open="">'); // the empty-list arm opens the create details (hono's boolean attr)
    expect(html).toContain("No applications yet");
  });
});

describe("the create/delete writes (AddApp / DeleteApp ports over the W5 shared binder)", () => {
  it("splitRedirectUris is SplitTrimSpace's newline split", () => {
    expect(splitRedirectUris("https://a.test/cb\n\nhttps://b.test/cb\n")).toEqual(["https://a.test/cb", "https://b.test/cb"]);
    expect(splitRedirectUris("")).toEqual([]);
  });

  it("create: the required-name arm, the redirect-URI validation arm (the exact composite), the Required textarea arm, then the uid=0 create with the once-only secret", async () => {
    const badName = await applyAdminApplicationCreate(
      env.DB,
      parseAdminApplicationCreateForm(new URLSearchParams("application_name=&redirect_uris=https%3A%2F%2Fa.test%2Fcb&confidential_client=on")),
    );
    expect(badName.kind).toBe("invalid");
    if (badName.kind === "invalid") {
      expect(badName.message).toBe("Name cannot be empty."); // form.require_error
    }
    const badUri = await applyAdminApplicationCreate(
      env.DB,
      parseAdminApplicationCreateForm(new URLSearchParams("application_name=x&redirect_uris=not-a-uri")),
    );
    expect(badUri.kind).toBe("invalid");
    if (badUri.kind === "invalid") {
      // user_form.go:267-269's exact composite (the generic reduction retired).
      expect(badUri.message).toBe(`RedirectURIs: "${"not-a-uri"}" is not a valid URL.`);
    }
    const emptyUris = await applyAdminApplicationCreate(
      env.DB,
      parseAdminApplicationCreateForm(new URLSearchParams("application_name=x&redirect_uris=")),
    );
    expect(emptyUris.kind).toBe("invalid");
    if (emptyUris.kind === "invalid") expect(emptyUris.message).toBe("RedirectURIs cannot be empty.");

    const ok = await applyAdminApplicationCreate(
      env.DB,
      parseAdminApplicationCreateForm(
        new URLSearchParams("application_name=cli-tool&redirect_uris=https%3A%2F%2Fcli.test%2Fcb%0Ahttps%3A%2F%2Fcli.test%2Fcb2"),
      ),
    );
    expect(ok.kind).toBe("created");
    if (ok.kind === "created") {
      // The plaintext surfaces ONCE on the outcome (the caller renders the
      // shared edit page with it) and never lands in the store.
      expect(ok.secret).toMatch(/^gto_[a-z2-7]{52}$/);
      const stored = await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.name, "cli-tool")).get();
      expect(stored?.uid).toBe(0);
      expect(stored?.clientSecret).not.toBe(ok.secret); // the HASH is stored
      expect(await verifyClientSecret(stored?.clientSecret ?? "", ok.secret)).toBe(true);
      expect(JSON.parse(stored?.redirectUris ?? "[]")).toEqual(["https://cli.test/cb", "https://cli.test/cb2"]);
    }
  });

  it("delete: the (id, uid=0) delete — a user-owned id is the indistinguishable miss, a builtin id is the lock arm", async () => {
    const ids = await seedAppWorld();
    expect(await applyAdminApplicationDelete(env.DB, ids.userAppId)).toEqual({ kind: "not_found" });
    expect(await applyAdminApplicationDelete(env.DB, ids.builtinId)).toEqual({ kind: "locked" });
    expect(await applyAdminApplicationDelete(env.DB, ids.globalIds[0] ?? 0)).toEqual({ kind: "deleted" });
    expect(await applyAdminApplicationDelete(env.DB, ids.globalIds[0] ?? 0)).toEqual({ kind: "not_found" });
  });
});

describe("the admin applications DOM (applications/list.tmpl at the pin)", () => {
  it("renders the pageClass, the Applications header, the rows with the client-id label, the Edit links + Remove forms — and the Locked label for the builtins", async () => {
    const ids = await seedAppWorld();
    const html = await renderPage();
    expect(html).toContain('class="page-content admin config"'); // the template's own dict (list.tmpl:1)
    expect(html).toContain(">Applications</h4>");
    expect(html).toContain("ci-client");
    expect(html).toContain("aaa-older");
    expect(html).toContain('class="ui label"'); // the client-id label
    expect(html).toContain("octicon-apps"); // the embedded leading glyph
    // The Edit links ride the W5 shared edit page — one per NON-builtin row.
    expect(html.split('href="/-/admin/applications/oauth2/').length - 1).toBe(2);
    expect(html).toContain(`href="/-/admin/applications/oauth2/${ids.globalIds[0]}"`);
    expect(html).toContain("> Edit</a>");
    // The Remove forms ride the shared delete for the non-builtin global ids.
    expect(html.split('action="/-/admin/applications/oauth2/').length - 1).toBe(2);
    expect(html).toContain(`action="/-/admin/applications/oauth2/${ids.globalIds[0]}/delete"`);
    expect(html).not.toContain(`oauth2/${ids.userAppId}`);
    // The BuiltinApplications lock arm: the seeded builtin row renders the
    // Locked label (the tooltip carries oauth2_application_locked) and NO
    // controls.
    expect(html).toContain(`data-tooltip-content="${oauth2AppEditLocale.application_locked}"`);
    expect(html).toContain(`>${oauth2AppEditLocale.locked}</span>`);
    expect(html).not.toContain(`oauth2/${ids.builtinId}"`);
    expect(html).not.toContain("Regenerate Secret"); // the LIST page carries no regenerate form
    // The create form's field set.
    expect(html).toContain('name="application_name"');
    expect(html).toContain('name="redirect_uris"');
    expect(html).toContain('name="confidential_client" checked'); // the default-on arm
    expect(html).toContain('name="skip_secondary_authorization"');
  });

  it("the details stays CLOSED with apps present and OPEN on the empty arm", async () => {
    await seedAppWorld();
    const withApps = await renderPage();
    // The create details stays shut (a bare <details>; the nav's groups
    // carry classes and Integrations is OPEN on this active page anyway).
    expect(withApps).toContain("<details>");
    expect(withApps).not.toContain('<details open="">');
    // The empty arm: drain the global rows and re-render.
    await env.DB.prepare("DELETE FROM oauth2_application").run();
    const empty = renderToString(<AdminApplicationsPage ctx={ctx} data={await loadAdminApplicationsData(env.DB)} />);
    expect(empty).toContain('<details open="">'); // the empty arm opens it
  });

  it("every th carries scope=col check is inert (the page is a divided list, no table)", async () => {
    await seedAppWorld();
    const html = await renderPage();
    expect(html).not.toMatch(/<th(?![^>]*scope=)[^>]*>/);
    expect(html).toContain('class="active item" href="/-/admin/applications"'); // the nav fold
    expect(html).toContain('href="/-/admin/hooks"');
  });
});

// --- the mounted routes (the W5 edit arms + the group gate) -----------------

type RouteEnv = Parameters<typeof uiRouter.fetch>[1];
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

describe("the mounted /-/admin/applications routes (the W5 edit arms + the oauth2Enabled gate)", () => {
  /** The real production path (parse → resolveUiSession → the admin
   *  prologue) with an env override for the gate arms. */
  async function fetchUi(path: string, init?: RequestInit, overrides: Record<string, string> = {}): Promise<Response> {
    const context = createExecutionContext();
    const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), { ...routeEnv, ...overrides }, context);
    await waitOnExecutionContext(context);
    return response;
  }

  async function adminSession(): Promise<string> {
    const root = await drizzle(env.DB)
      .insert(users)
      .values({ username: "root", usernameLower: "root", isAdmin: true, status: "active", createdAt: new Date(T0 * 1000) })
      .returning({ id: users.id })
      .all();
    return mintSession(env.DB, root[0]!.id);
  }

  function getRoute(path: string, cookie: string, overrides: Record<string, string> = {}): Promise<Response> {
    return fetchUi(path, { headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } }, overrides);
  }

  function postForm(path: string, cookie: string, body: string, overrides: Record<string, string> = {}): Promise<Response> {
    return fetchUi(
      path,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: ORIGIN,
          cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
        },
        body,
      },
      overrides,
    );
  }

  it("a non-builtin id renders the shared edit page with the masked secret; the create renders it with the plaintext once", async () => {
    const cookie = await adminSession();
    const created = await postForm(
      "/-/admin/applications/oauth2",
      cookie,
      new URLSearchParams({ application_name: "ci", redirect_uris: "https://ci.test/cb", confidential_client: "on" }).toString(),
    );
    expect(created.status).toBe(200);
    const createdHtml = await created.text();
    const plaintext = /gto_[a-z2-7]{52}/.exec(createdHtml)?.[0] ?? "";
    expect(plaintext).not.toBe("");
    expect(createdHtml).toContain('id="client-secret" type="text" readonly'); // the shown-once arm
    expect(createdHtml).toContain(`value="${plaintext}"`);
    // The plaintext never lands in the store (the hash does).
    const stored = await drizzle(env.DB).select().from(oauth2Applications).all();
    expect(JSON.stringify(stored)).not.toContain(plaintext);
    const id = stored.find((row) => row.name === "ci")!.id;
    expect(createdHtml).toContain(`action="/-/admin/applications/oauth2/${id}/regenerate_secret"`); // the edit chrome
    expect(createdHtml).toContain(`action="/-/admin/applications/oauth2/${id}" method="post"`); // the save form

    // The reload (the plain show): the masked placeholder replaces it.
    const show = await getRoute(`/-/admin/applications/oauth2/${id}`, cookie);
    expect(show.status).toBe(200);
    const showHtml = await show.text();
    expect(showHtml).toContain('id="client-secret" type="password" readonly');
    expect(showHtml).toContain(oauth2AppEditLocale.masked_secret_placeholder);
    expect(showHtml).not.toContain(plaintext);
    expect(showHtml).toContain(`action="/-/admin/applications/oauth2/${id}/regenerate_secret"`);
  });

  it("save updates name/uris WITHOUT rotating the secret and 303s home; a builtin id 404-shells", async () => {
    const cookie = await adminSession();
    const created = await applyAdminApplicationCreate(
      env.DB,
      parseAdminApplicationCreateForm(new URLSearchParams("application_name=ci&redirect_uris=https%3A%2F%2Fci.test%2Fcb")),
    );
    if (created.kind !== "created") throw new Error("seed create failed");
    const firstSecret = created.secret;

    const saved = await postForm(
      `/-/admin/applications/oauth2/${created.row.id}`,
      cookie,
      new URLSearchParams({ application_name: "renamed", redirect_uris: "https://new.test/cb" }).toString(),
    );
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe("/-/admin/applications");
    const row = await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, created.row.id)).get();
    expect(row?.name).toBe("renamed");
    expect(JSON.parse(row?.redirectUris ?? "[]")).toEqual(["https://new.test/cb"]);
    // THE WEB SAVE NEVER ROTATES — the original plaintext still verifies.
    expect(await verifyClientSecret(row?.clientSecret ?? "", firstSecret)).toBe(true);

    // The builtin lock: the seeded builtin id 404-shells on save (and delete
    // — the list never renders its controls).
    const builtin = await drizzle(env.DB)
      .insert(oauth2Applications)
      .values({
        uid: 0,
        name: "tea",
        clientId: BUILTIN_OAUTH2_CLIENT_IDS[2]!,
        clientSecret: "",
        confidentialClient: false,
        skipSecondaryAuthorization: false,
        redirectUris: JSON.stringify(["http://127.0.0.1"]),
        createdAt: new Date(T0 * 1000),
        updatedAt: new Date(T0 * 1000),
      })
      .returning({ id: oauth2Applications.id })
      .all();
    const lockedSave = await postForm(
      `/-/admin/applications/oauth2/${builtin[0]!.id}`,
      cookie,
      new URLSearchParams({ application_name: "evil", redirect_uris: "https://evil.test/cb" }).toString(),
    );
    expect(lockedSave.status).toBe(404);
    const untouched = await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, builtin[0]!.id)).get();
    expect(untouched?.name).toBe("tea");
  });

  it("regenerate_secret returns a FRESH plaintext once; the old secret stops verifying", async () => {
    const cookie = await adminSession();
    const created = await applyAdminApplicationCreate(
      env.DB,
      parseAdminApplicationCreateForm(new URLSearchParams("application_name=ci&redirect_uris=https%3A%2F%2Fci.test%2Fcb")),
    );
    if (created.kind !== "created") throw new Error("seed create failed");
    const regenerated = await postForm(`/-/admin/applications/oauth2/${created.row.id}/regenerate_secret`, cookie, "");
    expect(regenerated.status).toBe(200);
    const html = await regenerated.text();
    const fresh = /gto_[a-z2-7]{52}/.exec(html)?.[0] ?? "";
    expect(fresh).not.toBe("");
    expect(fresh).not.toBe(created.secret);
    const row = await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, created.row.id)).get();
    expect(await verifyClientSecret(row?.clientSecret ?? "", fresh)).toBe(true);
    expect(await verifyClientSecret(row?.clientSecret ?? "", created.secret)).toBe(false);
  });

  it("an unknown id 404-shells on every arm; the gate answers 403 Forbidden when OAUTH2_ENABLED=false", async () => {
    const cookie = await adminSession();
    for (const path of [`/-/admin/applications/oauth2/999`, "/-/admin/applications/oauth2/999/delete"]) {
      const res =
        path.endsWith("/delete")
          ? await postForm(path, cookie, "")
          : await getRoute(path, cookie);
      expect(res.status).toBe(404);
    }
    const gatedList = await getRoute("/-/admin/applications", cookie, { OAUTH2_ENABLED: "false" });
    expect(gatedList.status).toBe(403);
    expect(await gatedList.text()).toBe("Forbidden\n");
    const gatedShow = await getRoute("/-/admin/applications/oauth2/1", cookie, { OAUTH2_ENABLED: "false" });
    expect(gatedShow.status).toBe(403);
  });

  it("the POST-only tails answer GET with 405", async () => {
    const cookie = await adminSession();
    const res = await getRoute("/-/admin/applications/oauth2/1/regenerate_secret", cookie);
    expect(res.status).toBe(405);
  });
});
