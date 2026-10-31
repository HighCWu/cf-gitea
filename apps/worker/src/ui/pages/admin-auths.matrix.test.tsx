/**
 * The ADMIN AUTHS pages' matrix (specs/external-auth-sources.md §6 + §8's
 * admin-CRUD plan; the admin-notices harness): the module's load/render/
 * parse/apply seams over real D1, generated migrations in beforeAll,
 * hono/jsx renderToString.
 *
 * The ROUTE arms (the gate matrix through the mounted routes) ride the
 * orchestrator's mount window — this module ships the seams, the module
 * header's mount recipe is the window's hunk list (the badges pre-mount
 * precedent); the seams here are exactly what the thin handlers call.
 *
 * Covered here:
 *   - the LOADER: the name-ordered list, the provider projection (registry
 *     display name), the in-use counts, the dead-cfg "(invalid)" marker;
 *   - the EDIT LOAD: the cfg parse, the linked count, the null-miss arm;
 *   - the LIST DOM: the nine-column table (upstream's seven + the SPEC
 *     §6.1 Provider/Users pair), the check/x arms, the edit links, the
 *     nav item (the W4 Authentication Sources entry, active here);
 *   - the FORM PARSE: the upstream wire field names, the checkbox
 *     presence rule, the scopes passthrough;
 *   - the VALIDATOR: the name require/size/slug ladder, the provider
 *     membership, the discovery-URL scheme gate (auths.go:272-278);
 *   - the WRITE SEAMS: create (validate-before-persist — a bad cfg writes
 *     NO row; the name-exists arm; the store's defaults), update (the
 *     write-only secret keeps the stored value on an empty post; the
 *     name clash excludes self), delete (the in-use refusal first, the
 *     missing arm);
 *   - the FORM DOM: the new page (the OAuth2-only type row, the wire
 *     names, the checked-by-default active box, the reduced tips + the
 *     callback-URL element), the edit page (the stored values back, the
 *     SECRET NEVER RENDERS — §8's secret-hygiene arm, the rename warning,
 *     the delete form), the re-render arms carrying the posted values +
 *     error.
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { externalLoginUsers, loginSources } from "../../db/schema";
import {
  createLoginSource,
  ensureExternalLogin,
  type LoginSourceRow,
} from "../../services/auth-sources/store";
import { serializeOAuth2SourceConfig } from "../../services/auth-sources/cfg";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  ADMIN_AUTHS_NAV_LABEL,
  AdminAuthSourceEditPage,
  AdminAuthSourceNewPage,
  AdminAuthsPage,
  adminAuthSourceFormFromRow,
  adminAuthSourceGithubUrlDefaults,
  adminAuthSourceProviderOptions,
  adminAuthsLocale,
  applyAdminAuthSourceCreate,
  applyAdminAuthSourceDelete,
  applyAdminAuthSourceUpdate,
  authSourceTypeName,
  loadAdminAuthSourceEditData,
  loadAdminAuthsData,
  newAdminAuthSourceFormValues,
  parseAdminAuthSourceForm,
  renderAdminAuthSourceEditPage,
  renderAdminAuthSourceNewPage,
  renderAdminAuthsPage,
  validateAdminAuthSourceForm,
} from "./admin-auths";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date("2026-01-01T00:00:00Z");
const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

/** The signed-in site admin — the route stage's gate (web.go:779) is the
 *  wiring's posture; the module trusts its inputs. */
const viewer: Viewer = { kind: "user", id: 1, username: "root", isAdmin: true };
const ctx: UiContext = { viewer, origin: ORIGIN, assets: shellAssetsFromManifest(manifest) };

/** An OIDC cfg through the codec (the stored wire bytes). */
function oidcCfg(overrides: Partial<{ name: string; discoveryUrl: string; secret: string }> = {}): string {
  return serializeOAuth2SourceConfig({
    v: 1,
    provider: "openidConnect",
    clientId: "client-abc",
    clientSecret: overrides.secret ?? "s3cret-stored",
    discoveryUrl: overrides.discoveryUrl ?? "https://idp.example.com/.well-known/openid-configuration",
  });
}

async function insertSource(name: string, cfg = oidcCfg(), opts: { isActive?: boolean; at?: Date } = {}): Promise<LoginSourceRow> {
  const row = await createLoginSource(env.DB, {
    type: 6,
    name,
    isActive: opts.isActive ?? true,
    cfg,
  });
  // The store stamps wall-clock created/updated — pin them for the list's
  // date cells (the goldens' T0 discipline).
  await drizzle(env.DB)
    .update(loginSources)
    .set({ createdAt: opts.at ?? T0, updatedAt: opts.at ?? T0 })
    .where(eq(loginSources.id, row.id));
  return (await drizzle(env.DB).select().from(loginSources).where(eq(loginSources.id, row.id)).get())!;
}

function form(values: Partial<Record<string, string>> = {}): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, value);
  }
  return params;
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  // login_source + external_login_user: this suite's fixtures (the
  // migration-0056 tables); users: the link rows' FK target.
  for (const table of ["external_login_user", "login_source", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the loader ---------------------------------------------------------------

describe("loadAdminAuthsData (auths.go:44-56's FindAndCount over the store)", () => {
  it("answers the name-ordered list with the provider display names and the in-use counts", async () => {
    await insertSource("zeeta");
    await insertSource("alpha");
    const data = await loadAdminAuthsData(env.DB);
    expect(data.total).toBe(2);
    expect(data.items.map((item) => item.row.name)).toEqual(["alpha", "zeeta"]); // name order
    expect(data.items[0]!.provider).toBe("OpenID Connect"); // the registry display name
    expect(data.items.map((item) => item.linkedUsers)).toEqual([0, 0]);
    expect(data.items[0]!.row.createdAt.getTime()).toBe(T0.getTime());
    expect(data.items[0]!.row.updatedAt.getTime()).toBe(T0.getTime());
  });

  it("a github source projects the GitHub display name; a dead cfg renders the (invalid) marker", async () => {
    await insertSource(
      "gh",
      serializeOAuth2SourceConfig({
        v: 1,
        provider: "github",
        clientId: "gh-client",
        clientSecret: "gh-secret",
        customUrlMapping: { authUrl: "https://github.com/login/oauth/authorize" },
      }),
    );
    await insertSource("dead", '{"v":1,"provider":"openidConnect"}'); // valid JSON, not a valid record
    const data = await loadAdminAuthsData(env.DB);
    const byName = new Map(data.items.map((item) => [item.row.name, item]));
    expect(byName.get("gh")!.provider).toBe("GitHub");
    expect(byName.get("dead")!.provider).toBe("(invalid)");
  });

  it("the linked-user counts ride the external_login_user rows", async () => {
    const source = await insertSource("linked");
    await env.DB.prepare(
      "INSERT INTO users (id, username, username_lower, display_name, is_admin, created_at) VALUES (7, 'extuser', 'extuser', 'Ext User', 0, unixepoch())",
    ).run();
    await ensureExternalLogin(env.DB, {
      externalId: "ext-1",
      loginSourceId: source.id,
      userId: 7,
      provider: "openidConnect",
    });
    const data = await loadAdminAuthsData(env.DB);
    expect(data.items[0]!.linkedUsers).toBe(1);
  });

  it("an empty table answers total 0 with the no-results row", async () => {
    const data = await loadAdminAuthsData(env.DB);
    expect(data.total).toBe(0);
    expect(data.items).toHaveLength(0);
    const html = renderToString(<AdminAuthsPage ctx={ctx} data={data} />);
    expect(html).toContain('colspan="9"');
    expect(html).toContain(adminAuthsLocale.no_results);
  });
});

// --- the edit load ------------------------------------------------------------

describe("loadAdminAuthSourceEditData (auths.go's GetSourceByID + the cfg parse)", () => {
  it("answers the parsed cfg + the linked count; the unknown id is the null miss", async () => {
    const source = await insertSource("edit-me");
    const loaded = await loadAdminAuthSourceEditData(env.DB, source.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.cfg?.provider).toBe("openidConnect");
    expect(loaded!.cfg?.clientId).toBe("client-abc");
    expect(loaded!.linkedUsers).toBe(0);
    expect(loaded!.form).toBeNull(); // the GET render fills from the stored row
    expect(await loadAdminAuthSourceEditData(env.DB, 999)).toBeNull();
  });

  it("a dead cfg degrades to cfg null (the render's field-empty arm)", async () => {
    const source = await insertSource("dead-edit", "not-json");
    const loaded = await loadAdminAuthSourceEditData(env.DB, source.id);
    expect(loaded!.cfg).toBeNull();
    // The form-from-row projection still carries the row-level fields.
    const formValues = adminAuthSourceFormFromRow(loaded!.source, loaded!.cfg);
    expect(formValues.name).toBe("dead-edit");
    expect(formValues.provider).toBe("");
    expect(formValues.clientSecret).toBe(""); // never echoes
  });
});

// --- the list DOM --------------------------------------------------------------

describe("the admin auths list DOM (templates/admin/auth/list.tmpl at the pin)", () => {
  it("renders the pageClass, the header + total + Add button, and the nine-column row shape", async () => {
    await insertSource("alpha");
    const data = await loadAdminAuthsData(env.DB);
    const html = renderToString(<AdminAuthsPage ctx={ctx} data={data} />);
    expect(html).toContain('class="page-content admin authentication"');
    expect(html).toContain(adminAuthsLocale.auth_manage_panel);
    expect(html).toContain(`(${adminAuthsLocale.total.replace("%d", "1")})`);
    expect(html).toContain('href="/-/admin/auths/new"');
    for (const header of [
      adminAuthsLocale.col_id,
      adminAuthsLocale.col_name,
      adminAuthsLocale.col_type,
      adminAuthsLocale.col_enabled,
      adminAuthsLocale.col_provider,
      adminAuthsLocale.col_users,
      adminAuthsLocale.col_updated,
      adminAuthsLocale.col_created,
      adminAuthsLocale.col_edit,
    ]) {
      expect(html).toContain(`<th scope="col">${header}</th>`);
    }
    expect(html).toContain('href="/-/admin/auths/'); // the name + pencil links
    expect(html).toContain(authSourceTypeName(6)); // "OAuth2"
    expect(html).toContain("OpenID Connect");
    expect(html).toContain("Jan 1, 2026"); // the pinned T0 dates
    // The W4 nav item: present exactly once, ACTIVE on this page.
    expect(html.match(/href="\/-\/admin\/auths"/g)?.length).toBe(1);
    expect(html).toContain('class="active item" href="/-/admin/auths"');
  });

  it("the enabled column carries the check/x arms and the full-document render path matches", async () => {
    await insertSource("on", oidcCfg(), { isActive: true });
    await insertSource("off", oidcCfg(), { isActive: false });
    const data = await loadAdminAuthsData(env.DB);
    const html = renderToString(<AdminAuthsPage ctx={ctx} data={data} />);
    expect(html).toContain('class="svg octicon-check"');
    expect(html).toContain('class="svg octicon-x"'); // the embedded submodule bytes
    expect(renderAdminAuthsPage(ctx, data)).toContain("off"); // the renderPage path
  });
});

// --- the wire parse -----------------------------------------------------------

describe("parseAdminAuthSourceForm (the AuthenticationForm OAuth2 arm's wire names)", () => {
  it("reads the upstream field names verbatim and the checkbox presence rule", () => {
    const parsed = parseAdminAuthSourceForm(
      form({
        name: "corp-oidc",
        oauth2_provider: "openidConnect",
        oauth2_key: "client-abc",
        oauth2_secret: "s3cret",
        open_id_connect_auto_discovery_url: "https://idp/.well-known/openid-configuration",
        open_id_connect_external_id_claim: "oid",
        is_active: "on",
        oauth2_use_custom_url: "on",
        oauth2_auth_url: "https://github.com/login/oauth/authorize",
        oauth2_scopes: "email, profile",
        oauth2_icon_url: "https://icon.example.com/x.png",
      }),
    );
    expect(parsed.name).toBe("corp-oidc");
    expect(parsed.provider).toBe("openidConnect");
    expect(parsed.clientId).toBe("client-abc");
    expect(parsed.clientSecret).toBe("s3cret");
    expect(parsed.isActive).toBe(true);
    expect(parsed.useCustomUrl).toBe(true);
    expect(parsed.externalIdClaim).toBe("oid");
    expect(parsed.scopes).toBe("email, profile"); // raw — the codec split runs in buildCfg
    // The absent checkboxes read false (upstream's web binding).
    const unchecked = parseAdminAuthSourceForm(form({ name: "x", oauth2_provider: "github", oauth2_key: "k", oauth2_secret: "s" }));
    expect(unchecked.isActive).toBe(false);
    expect(unchecked.useCustomUrl).toBe(false);
  });
});

// --- the validator --------------------------------------------------------------

describe("validateAdminAuthSourceForm (the form ladder, auths.go's order)", () => {
  /** A fully-credentialled base — the name arms need the rest valid so the
   *  field attribution is exact. */
  const base = {
    ...newAdminAuthSourceFormValues(),
    provider: "github",
    clientId: "k",
    clientSecret: "s",
  };

  it("the name require/size/slug triple", () => {
    expect(validateAdminAuthSourceForm({ ...base, name: "" }, { requireSecret: true })?.field).toBe("name");
    expect(validateAdminAuthSourceForm({ ...base, name: "x".repeat(31) }, { requireSecret: true })?.field).toBe("name");
    expect(validateAdminAuthSourceForm({ ...base, name: "has space" }, { requireSecret: true })?.field).toBe("name"); // the slug rule
    expect(validateAdminAuthSourceForm({ ...base, name: "Corp_OIDC.v2" }, { requireSecret: true })).toBeNull(); // slug charset passes
  });

  it("the provider membership and the credential requires", () => {
    expect(validateAdminAuthSourceForm({ ...base, name: "n", provider: "" }, { requireSecret: true })?.field).toBe("provider");
    expect(validateAdminAuthSourceForm({ ...base, name: "n", provider: "gitlab" }, { requireSecret: true })?.field).toBe(
      "provider",
    ); // deferred, not executable
    expect(validateAdminAuthSourceForm({ ...base, name: "n", clientId: "" }, { requireSecret: true })?.field).toBe("clientId");
    // The create arm demands the secret; the edit arm allows the write-only
    // empty (the keep arm).
    expect(validateAdminAuthSourceForm({ ...base, name: "n", clientSecret: "" }, { requireSecret: true })?.field).toBe(
      "clientSecret",
    );
    expect(validateAdminAuthSourceForm({ ...base, name: "n", clientSecret: "" }, { requireSecret: false })).toBeNull();
  });

  it("the discovery-URL scheme gate (auths.go:272-278's form-layer arm)", () => {
    expect(
      validateAdminAuthSourceForm(
        {
          ...base,
          name: "n",
          provider: "openidConnect",
          clientId: "k",
          clientSecret: "s",
          discoveryUrl: "ftp://idp/.well-known/openid-configuration",
        },
        { requireSecret: true },
      )?.field,
    ).toBe("discoveryUrl");
    expect(
      validateAdminAuthSourceForm(
        {
          ...base,
          name: "n",
          provider: "openidConnect",
          clientId: "k",
          clientSecret: "s",
          discoveryUrl: "https://idp/.well-known/openid-configuration",
        },
        { requireSecret: true },
      ),
    ).toBeNull();
  });
});

// --- the write seams ------------------------------------------------------------

describe("applyAdminAuthSourceCreate (NewAuthSourcePost reduced, validate-before-persist)", () => {
  it("creates the row with the codec-serialized cfg and the store's defaults", async () => {
    const outcome = await applyAdminAuthSourceCreate(
      env.DB,
      newAdminAuthSourceFormValues(),
    );
    // The fresh defaults carry no credentials — the validator refuses (the
    // empty-name arm first): the fresh form alone never persists.
    expect(outcome.outcome).toBe("invalid");
    const values = {
      ...newAdminAuthSourceFormValues(),
      name: "corp-oidc",
      provider: "openidConnect",
      clientId: "client-abc",
      clientSecret: "s3cret",
      discoveryUrl: "https://idp/.well-known/openid-configuration",
    };
    const created = await applyAdminAuthSourceCreate(env.DB, values);
    expect(created.outcome).toBe("created");
    const row = await drizzle(env.DB).select().from(loginSources).get();
    expect(row?.name).toBe("corp-oidc");
    expect(row?.type).toBe(6);
    expect(row?.isActive).toBe(true); // the fresh form's default
    expect(row?.isSyncEnabled).toBe(false); // the store's forcing (the inert column)
    const cfg = JSON.parse(row!.cfg) as Record<string, unknown>;
    expect(cfg).toEqual({
      v: 1,
      provider: "openidConnect",
      clientId: "client-abc",
      clientSecret: "s3cret",
      discoveryUrl: "https://idp/.well-known/openid-configuration",
    });
  });

  it("an invalid cfg writes NO row (validate-before-persist, SPEC §5.1)", async () => {
    // The REACHABLE codec rejection through this form: an OIDC source with
    // no discovery URL (buildCfg's structural absence ⇒ the codec's
    // discovery-required). The foreign-provider fields (a claim posted for
    // github, a mapping posted for gplus) are PRE-DROPPED by buildCfg —
    // upstream tolerates storing them inert (parseOAuth2Config copies every
    // posted field onto the struct); our structural-absence rule makes them
    // absent, and the observable outcome (create succeeds) matches.
    const outcome = await applyAdminAuthSourceCreate(env.DB, {
      ...newAdminAuthSourceFormValues(),
      name: "bad",
      provider: "openidConnect",
      clientId: "k",
      clientSecret: "s",
      discoveryUrl: "",
    });
    expect(outcome.outcome).toBe("invalid");
    if (outcome.outcome === "invalid") expect(outcome.field).toBe("discoveryUrl");
    expect((await loadAdminAuthsData(env.DB)).total).toBe(0);
  });

  it("the name-exists arm maps the store's LoginSourceNameExistsError", async () => {
    await insertSource("taken");
    const outcome = await applyAdminAuthSourceCreate(env.DB, {
      ...newAdminAuthSourceFormValues(),
      name: "taken",
      provider: "github",
      clientId: "k",
      clientSecret: "s",
    });
    expect(outcome.outcome).toBe("invalid");
    if (outcome.outcome === "invalid") {
      expect(outcome.message).toBe(adminAuthsLocale.login_source_exist.replace("%s", "taken"));
      expect(outcome.field).toBe("name");
    }
  });

  it("the github custom-URL mapping posts only under the checkbox and drops empty entries", async () => {
    const outcome = await applyAdminAuthSourceCreate(env.DB, {
      ...newAdminAuthSourceFormValues(),
      name: "gh",
      provider: "github",
      clientId: "k",
      clientSecret: "s",
      useCustomUrl: true,
      authUrl: "https://ghe.example.com/login/oauth/authorize",
      tokenUrl: "",
      profileUrl: "",
      emailUrl: "",
    });
    expect(outcome.outcome).toBe("created");
    const row = await drizzle(env.DB).select().from(loginSources).get();
    const ghCfg = JSON.parse(row!.cfg) as { customUrlMapping?: Record<string, string> };
    expect(ghCfg.customUrlMapping).toEqual({ authUrl: "https://ghe.example.com/login/oauth/authorize" });
  });
});

describe("applyAdminAuthSourceUpdate (EditAuthSourcePost reduced)", () => {
  it("saves the new values; an empty posted secret keeps the stored one", async () => {
    const source = await insertSource("rename-me");
    const outcome = await applyAdminAuthSourceUpdate(env.DB, source.id, {
      ...newAdminAuthSourceFormValues(),
      name: "renamed",
      provider: "openidConnect",
      clientId: "client-new",
      clientSecret: "", // write-only empty — keep
      discoveryUrl: "https://idp2/.well-known/openid-configuration",
      isActive: false,
    });
    expect(outcome.outcome).toBe("saved");
    const row = await drizzle(env.DB).select().from(loginSources).where(eq(loginSources.id, source.id)).get();
    expect(row?.name).toBe("renamed");
    expect(row?.isActive).toBe(false);
    const cfg = JSON.parse(row!.cfg) as { clientId: string; clientSecret: string; discoveryUrl: string };
    expect(cfg.clientId).toBe("client-new");
    expect(cfg.clientSecret).toBe("s3cret-stored"); // the stored secret survives
    expect(cfg.discoveryUrl).toBe("https://idp2/.well-known/openid-configuration");
  });

  it("a posted secret replaces the stored one; the name clash excludes self", async () => {
    const source = await insertSource("self");
    const replaced = await applyAdminAuthSourceUpdate(env.DB, source.id, {
      ...newAdminAuthSourceFormValues(),
      name: "self",
      provider: "openidConnect",
      clientId: "k",
      clientSecret: "brand-new",
      discoveryUrl: "https://idp/.well-known/openid-configuration",
    });
    expect(replaced.outcome).toBe("saved");
    const row = await drizzle(env.DB).select().from(loginSources).where(eq(loginSources.id, source.id)).get();
    const replacedCfg = JSON.parse(row!.cfg) as { clientSecret: string };
    expect(replacedCfg.clientSecret).toBe("brand-new");

    await insertSource("other");
    const clash = await applyAdminAuthSourceUpdate(env.DB, source.id, {
      ...newAdminAuthSourceFormValues(),
      name: "other",
      provider: "github",
      clientId: "k",
      clientSecret: "s",
    });
    expect(clash.outcome).toBe("invalid");
    if (clash.outcome === "invalid") expect(clash.field).toBe("name");
  });

  it("the unknown-id arm answers invalid (the route 404-shells on it)", async () => {
    const outcome = await applyAdminAuthSourceUpdate(env.DB, 424242, {
      ...newAdminAuthSourceFormValues(),
      name: "ghost",
      provider: "github",
      clientId: "k",
      clientSecret: "s",
    });
    expect(outcome.outcome).toBe("invalid");
  });
});

describe("applyAdminAuthSourceDelete (DeleteAuthSource, the in-use refusal first)", () => {
  it("deletes an unused source and answers missing for the unknown id", async () => {
    const source = await insertSource("doomed");
    expect(await applyAdminAuthSourceDelete(env.DB, source.id)).toBe("deleted");
    expect(await loadAdminAuthSourceEditData(env.DB, source.id)).toBeNull();
    expect(await applyAdminAuthSourceDelete(env.DB, 987654)).toBe("missing");
  });

  it("refuses the in-use refusal with the still_in_used posture (ErrSourceInUse — auths.go:450)", async () => {
    const source = await insertSource("in-use");
    await env.DB.prepare(
      "INSERT INTO users (id, username, username_lower, display_name, is_admin, created_at) VALUES (8, 'linker', 'linker', 'Linker', 0, unixepoch())",
    ).run();
    await ensureExternalLogin(env.DB, {
      externalId: "ext-8",
      loginSourceId: source.id,
      userId: 8,
      provider: "openidConnect",
    });
    expect(await applyAdminAuthSourceDelete(env.DB, source.id)).toBe("in-use");
    // The row + the link survive (upstream's observable refusal).
    expect(await loadAdminAuthSourceEditData(env.DB, source.id)).not.toBeNull();
    expect(await drizzle(env.DB).select().from(externalLoginUsers).all()).toHaveLength(1);
  });
});

// --- the form DOM ----------------------------------------------------------------

describe("the new-page DOM (new.tmpl reduced to the OAuth2 arm)", () => {
  it("renders the OAuth2-only type row, the wire field names, and the default-active checkbox", () => {
    const html = renderToString(
      <AdminAuthSourceNewPage ctx={ctx} data={{ form: newAdminAuthSourceFormValues(), error: null, errorField: null }} />,
    );
    expect(html).toContain('class="page-content admin new authentication"');
    expect(html).toContain('name="type" value="6"'); // the hidden wire field (the ONE legal type)
    expect(html).toContain(authSourceTypeName(6)); // the static type text
    for (const wireName of [
      'name="name"',
      'name="oauth2_provider"',
      'name="oauth2_key"',
      'name="oauth2_secret"',
      'name="open_id_connect_auto_discovery_url"',
      'name="open_id_connect_external_id_claim"',
      'name="oauth2_use_custom_url"',
      'name="oauth2_auth_url"',
      'name="oauth2_token_url"',
      'name="oauth2_profile_url"',
      'name="oauth2_email_url"',
      'name="oauth2_scopes"',
      'name="oauth2_icon_url"',
      'name="is_active"',
    ]) {
      expect(html).toContain(wireName);
    }
    expect(html).toContain('id="is_active" name="is_active" type="checkbox" checked=""'); // the auths.go:85 default
    expect(html).toContain('action="/-/admin/auths/new"');
    // The executable provider set ONLY (SPEC §2.3): github/gplus/openidConnect.
    for (const option of adminAuthSourceProviderOptions()) {
      expect(html).toContain(`value="${option.key}"`);
    }
    expect(html).not.toContain('value="gitlab"'); // the deferred set renders nowhere
    // The github custom-URL defaults prefill (the JS-fill reduction).
    const defaults = adminAuthSourceGithubUrlDefaults();
    expect(html).toContain(`value="${defaults.authUrl}"`);
    expect(html).toContain(`value="${defaults.tokenUrl}"`);
    // The tips: the callback-URL element (empty on the fresh form) + the
    // three executable providers only.
    expect(html).toContain('id="oauth2-callback-url"></b>');
    expect(html).toContain(adminAuthsLocale.tip_github);
    expect(html).toContain(adminAuthsLocale.tip_google);
    expect(html).not.toContain("Bitbucket"); // the deferred providers' tips are absent
    expect(html).not.toContain('name="is_sync_enabled"'); // SPEC §6.3 — renders NOWHERE
    expect(html).not.toContain('name="two_factor_policy"');
  });

  it("the error re-render carries the message, the flagged field class, and the typed values", () => {
    const values = { ...newAdminAuthSourceFormValues(), name: "typed-name" };
    const html = renderToString(
      <AdminAuthSourceNewPage
        ctx={ctx}
        data={{ form: values, error: adminAuthsLocale.login_source_exist.replace("%s", "typed-name"), errorField: "name" }}
      />,
    );
    expect(html).toContain('<div class="ui negative message">');
    expect(html).toContain("already exists");
    expect(html).toContain('class="required inline field error"'); // the Err_Name arm
    expect(html).toContain('value="typed-name"');
  });

  it("a known name renders the server-computed callback URL (the JS-fill reduction)", () => {
    const html = renderToString(
      <AdminAuthSourceNewPage
        ctx={ctx}
        data={{ form: { ...newAdminAuthSourceFormValues(), name: "corp-oidc" }, error: null, errorField: null }}
      />,
    );
    expect(html).toContain("https://test.local/user/oauth2/corp-oidc/callback");
  });
});

describe("the edit-page DOM (edit.tmpl reduced, the §8 secret-hygiene arm)", () => {
  it("renders the stored values back, the static type row, the rename warning, and the delete form", async () => {
    const source = await insertSource("edit-visual");
    const loaded = (await loadAdminAuthSourceEditData(env.DB, source.id))!;
    const html = renderToString(<AdminAuthSourceEditPage ctx={ctx} data={loaded} />);
    expect(html).toContain('class="page-content admin edit authentication"');
    expect(html).toContain(`action="/-/admin/auths/${source.id}"`);
    expect(html).toContain('value="edit-visual"');
    expect(html).toContain('value="client-abc"');
    expect(html).toContain("OpenID Connect");
    expect(html).toContain("https://idp.example.com/.well-known/openid-configuration");
    expect(html).toContain(`action="/-/admin/auths/${source.id}/delete"`);
    expect(html).toContain(adminAuthsLocale.delete); // the red button's text
    expect(html).toContain(adminAuthsLocale.delete_auth_desc); // the inline confirm text
    // SPEC §5.2/§7.1's rename warning.
    expect(html).toContain("Renaming this source invalidates the redirect URL");
    expect(html).toContain("https://test.local/user/oauth2/edit-visual/callback"); // the tips callback
    // THE SECRET-HYGIENE ARM: the stored secret NEVER renders.
    expect(html).not.toContain("s3cret-stored");
    expect(html).toContain('type="password" value=""'); // the write-only input
  });

  it("the POST-failure re-render carries the posted form over the stored one", async () => {
    const source = await insertSource("edit-posted");
    const loaded = (await loadAdminAuthSourceEditData(env.DB, source.id))!;
    const posted = { ...adminAuthSourceFormFromRow(loaded.source, loaded.cfg), name: "posted-name" };
    const html = renderToString(
      <AdminAuthSourceEditPage ctx={ctx} data={{ ...loaded, form: posted, error: "bad cfg", errorField: "cfg" }} />,
    );
    expect(html).toContain('value="posted-name"');
    expect(html).toContain("bad cfg");
  });

  it("scopes join for the edit fill (edit.tmpl:450's StringUtils.Join arm)", () => {
    const row = {
      type: 6,
      name: "x",
      isActive: true,
    } as LoginSourceRow;
    const formValues = adminAuthSourceFormFromRow(row, {
      v: 1,
      provider: "openidConnect",
      clientId: "k",
      clientSecret: "s",
      discoveryUrl: "https://idp/.well-known/openid-configuration",
      scopes: ["email", "profile"],
    });
    expect(formValues.scopes).toBe("email,profile");
    expect(formValues.isActive).toBe(true);
  });

  it("the full-document renders answer the component path", async () => {
    const source = await insertSource("doc-path");
    const listHtml = renderAdminAuthsPage(ctx, await loadAdminAuthsData(env.DB));
    expect(listHtml).toContain("doc-path");
    const newHtml = renderAdminAuthSourceNewPage(ctx, {
      form: newAdminAuthSourceFormValues(),
      error: null,
      errorField: null,
    });
    expect(newHtml).toContain('class="page-content admin new authentication"');
    const loaded = (await loadAdminAuthSourceEditData(env.DB, source.id))!;
    expect(renderAdminAuthSourceEditPage(ctx, loaded)).toContain("doc-path");
  });

  it("the nav label constant pairs with the shared family locale", () => {
    expect(ADMIN_AUTHS_NAV_LABEL).toBe(adminAuthsLocale.authentication);
  });
});
