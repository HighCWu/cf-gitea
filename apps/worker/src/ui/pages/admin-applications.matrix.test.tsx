/**
 * The ADMIN APPLICATIONS page's matrix: the uid=0 instance-wide read over
 * the landed oauth2 service (the census's "a read over the landed
 * oauth2Applications table"), the create/delete write ports (the once-only
 * secret), and the DOM contract (admin/applications/list.tmpl ×
 * user/settings/applications_oauth2_list.tmpl): the app rows with the
 * client-id label, the landed Remove forms (NO Edit links — the dead-link
 * rule), the create form's field set, and the details-open arms.
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { oauth2Applications, users } from "../../db/schema";
import { createOAuth2Application } from "../../api/services/oauth2-apps";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  AdminApplicationsPage,
  applyAdminApplicationCreate,
  applyAdminApplicationDelete,
  loadAdminApplicationsData,
  parseAdminApplicationCreateForm,
  splitRedirectUris,
} from "./admin-applications";

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

/** Two GLOBAL apps (uid=0 — the admin page's own writes) + one USER-owned
 *  app that must never surface. The user-owned row rides the landed API
 *  create (doer-scoped — the service call the /user route makes). */
async function seedAppWorld(): Promise<{ globalIds: number[]; userAppId: number }> {
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
  const owned = await createOAuth2Application(
    env.DB,
    { uid: aliceId, name: "alice-app", redirectUris: ["https://alice.test/cb"], confidentialClient: true, skipSecondaryAuthorization: false },
    now,
  );
  return { globalIds: [g1.row.id, g2.row.id], userAppId: owned.row.id };
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
    // g2 was created second → id DESC puts it first.
    expect(data.apps.map((app) => app.id)).toEqual([...ids.globalIds].reverse());
    expect(data.apps.some((app) => app.id === ids.userAppId)).toBe(false);
    expect(data.apps.every((app) => app.uid === 0)).toBe(true);
  });

  it("answers an empty list on a bare store (with the closed create form armed open)", async () => {
    const data = await loadAdminApplicationsData(env.DB);
    expect(data.apps).toEqual([]);
    expect(data.newClientSecret).toBe("");
    const html = renderToString(<AdminApplicationsPage ctx={ctx} data={data} />);
    expect(html).toContain('<details open="">'); // the empty-list arm opens the create details (hono's boolean attr)
    expect(html).toContain("No applications yet");
  });
});

describe("the create/delete writes (AddApp / DeleteApp ports)", () => {
  it("splitRedirectUris is SplitTrimSpace's newline split", () => {
    expect(splitRedirectUris("https://a.test/cb\n\nhttps://b.test/cb\n")).toEqual(["https://a.test/cb", "https://b.test/cb"]);
    expect(splitRedirectUris("")).toEqual([]);
  });

  it("create: the required-name arm, the redirect-URI validation arm, then the uid=0 create with the once-only secret", async () => {
    const badName = await applyAdminApplicationCreate(
      env.DB,
      parseAdminApplicationCreateForm(new URLSearchParams("application_name=&redirect_uris=https%3A%2F%2Fa.test%2Fcb&confidential_client=on")),
    );
    expect(badName.kind).toBe("invalid");
    if (badName.kind === "invalid") {
      expect(badName.data.error).toContain("Name cannot be empty");
      expect(badName.data.form.name).toBe("");
    }
    const badUri = await applyAdminApplicationCreate(
      env.DB,
      parseAdminApplicationCreateForm(new URLSearchParams("application_name=x&redirect_uris=not-a-uri")),
    );
    expect(badUri.kind).toBe("invalid");
    if (badUri.kind === "invalid") expect(badUri.data.error).toContain("Invalid redirect URI");

    const ok = await applyAdminApplicationCreate(
      env.DB,
      parseAdminApplicationCreateForm(
        new URLSearchParams("application_name=cli-tool&redirect_uris=https%3A%2F%2Fcli.test%2Fcb%0Ahttps%3A%2F%2Fcli.test%2Fcb2"),
      ),
    );
    expect(ok.kind).toBe("created");
    if (ok.kind === "created") {
      // The plaintext renders exactly once and never lands in the store.
      expect(ok.data.newClientSecret).toMatch(/^gto_/);
      expect(ok.data.newClientId).not.toBe("");
      const stored = await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.name, "cli-tool")).get();
      expect(stored?.uid).toBe(0);
      expect(stored?.clientSecret).not.toBe(ok.data.newClientSecret); // the HASH is stored
      expect(JSON.parse(stored?.redirectUris ?? "[]")).toEqual(["https://cli.test/cb", "https://cli.test/cb2"]);
      // The re-rendered list carries the new row first (id DESC — the
      // spread keeps it at the head until the ids catch up).
      expect(ok.data.apps[0]?.name).toBe("cli-tool");
    }
  });

  it("delete: the (id, uid=0) delete — a user-owned id is the indistinguishable miss", async () => {
    const ids = await seedAppWorld();
    expect(await applyAdminApplicationDelete(env.DB, ids.userAppId)).toBe(false);
    expect(await applyAdminApplicationDelete(env.DB, ids.globalIds[0] ?? 0)).toBe(true);
    expect(await applyAdminApplicationDelete(env.DB, ids.globalIds[0] ?? 0)).toBe(false);
  });
});

describe("the admin applications DOM (applications/list.tmpl at the pin)", () => {
  it("renders the pageClass, the Applications header, the rows with the client-id label, and the landed Remove forms", async () => {
    const ids = await seedAppWorld();
    const html = await renderPage();
    expect(html).toContain('class="page-content admin config"'); // the template's own dict (list.tmpl:1)
    expect(html).toContain(">Applications</h4>");
    expect(html).toContain("ci-client");
    expect(html).toContain("aaa-older");
    expect(html).toContain('class="ui label"'); // the client-id label
    expect(html).toContain("octicon-apps"); // the embedded leading glyph
    // The Remove forms ride the landed delete for the GLOBAL ids only.
    expect(html.split('action="/-/admin/applications/oauth2/').length - 1).toBe(2);
    expect(html).toContain(`action="/-/admin/applications/oauth2/${ids.globalIds[0]}/delete"`);
    expect(html).toContain(`action="/-/admin/applications/oauth2/${ids.globalIds[1]}/delete"`);
    expect(html).not.toContain(`oauth2/${ids.userAppId}`);
    // The dead-link rule: the Edit button targets the unlanded edit page.
    expect(html).not.toContain('href="/-/admin/applications/oauth2/');
    expect(html).not.toContain("Regenerate Secret");
    // The create form's field set.
    expect(html).toContain('name="application_name"');
    expect(html).toContain('name="redirect_uris"');
    expect(html).toContain('name="confidential_client" checked'); // the default-on arm
    expect(html).toContain('name="skip_secondary_authorization"');
    expect(html).not.toContain("Locked"); // the BuiltinApplications arm is unreachable
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
