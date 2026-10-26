/**
 * The user settings ACTIONS SECRETS tab's tests (the bench-row UNMOUNTED
 * module — the repo-settings-wiki.test.tsx harness): the parse/apply/delete
 * matrix over real D1 through the LANDED secrets-variables service (generated
 * migrations in beforeAll; migration 0021's `secrets` store) and the DOM
 * contract of the page render — hono/jsx renderToString, the module driven
 * directly (no route yet, the HANDOFF NOTE in the module header).
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { createOrUpdateSecret, listSecretRows, ownerScope } from "../../api/services/secrets-variables";
import { secrets } from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  applyUserSettingsSecretForm,
  deleteUserSettingsSecret,
  formatSecretDate,
  loadUserSettingsSecretsPageData,
  parseUserSettingsSecretDeleteForm,
  parseUserSettingsSecretForm,
  renderUserSettingsSecretsPage,
  SECRET_DATA_MAXLENGTH,
  SECRET_DESCRIPTION_MAXLENGTH,
  SECRET_NAME_PATTERN,
  SecretRowItem,
  UserSettingsSecretsPage,
  userSettingsSecretsLocale,
} from "./user-settings-secrets";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000); // 2023-11-14T22:13:20Z
const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const viewer: Viewer = { kind: "user", id: 1, username: "alice", isAdmin: false };

const ctx: UiContext = {
  viewer,
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["secrets", "action_variables", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (1, 'alice', 'alice', 'Alice Doe', unixepoch())",
  ).run();
});

async function seedSecret(name: string, data: string, description = "", ownerId = 1): Promise<void> {
  await createOrUpdateSecret(env.DB, ownerScope(ownerId), name, data, description);
}

async function pageHtml(error: string | null = null, form = { name: "", data: "", description: "" }): Promise<string> {
  const data = await loadUserSettingsSecretsPageData(env.DB, 1);
  return renderToString(<UserSettingsSecretsPage ctx={ctx} data={{ ...data, form }} error={error} />);
}

// --- the loader ---------------------------------------------------------------

describe("loadUserSettingsSecretsPageData (the 0021 store, owner scope)", () => {
  it("answers the empty list on a fresh store", async () => {
    const data = await loadUserSettingsSecretsPageData(env.DB, 1);
    expect(data.secrets).toEqual([]);
    expect(data.form).toEqual({ name: "", data: "", description: "" });
  });

  it("lists the doer's owner-scope rows name-ordered, hiding repo-scoped and foreign rows", async () => {
    await seedSecret("BETA", "b-value");
    await seedSecret("ALPHA", "a-value", "first");
    // A repo-scope row (owner_id 0 + a repo id — the BelongingScopeRepo
    // encoding) and another doer's owner-scope row stay hidden.
    await env.DB.prepare(
      "INSERT INTO secrets (owner_id, repo_id, name, data, description, created_unix) VALUES (0, 'repo-1', 'REPO_ROW', 'x', '', 0)",
    ).run();
    await seedSecret("FOREIGN", "f-value", "", 2);

    const data = await loadUserSettingsSecretsPageData(env.DB, 1);
    expect(data.secrets.map((row) => row.name)).toEqual(["ALPHA", "BETA"]); // ToOrders "name"
  });
});

// --- the form parse ------------------------------------------------------------

describe("parseUserSettingsSecretForm (the dialog's three fields)", () => {
  it("parses name/data/description", () => {
    expect(parseUserSettingsSecretForm(new URLSearchParams({ name: "A", data: "v", description: "d" }))).toEqual({
      name: "A",
      data: "v",
      description: "d",
    });
  });

  it("absent fields parse empty (the urlencoded convention)", () => {
    expect(parseUserSettingsSecretForm(new URLSearchParams())).toEqual({ name: "", data: "", description: "" });
  });
});

// --- the write -----------------------------------------------------------------

describe("applyUserSettingsSecretForm (SecretsPost → PerformSecretsPost over createOrUpdateSecret)", () => {
  it("creates, then updates by the same name (the dialog's edit re-posts the name)", async () => {
    expect(await applyUserSettingsSecretForm(env.DB, 1, { name: "MY_SECRET", data: "v1", description: "first" })).toEqual({
      outcome: "saved",
    });
    let rows = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("MY_SECRET");

    expect(await applyUserSettingsSecretForm(env.DB, 1, { name: "MY_SECRET", data: "v2", description: "second" })).toEqual({
      outcome: "saved",
    });
    rows = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toBe("v2");
    expect(rows[0]!.description).toBe("second");
  });

  it("EOL-normalizes the submitted value before the service call (the web write path)", async () => {
    await applyUserSettingsSecretForm(env.DB, 1, { name: "MULTILINE", data: "line1\r\nline2\r\nline3", description: "" });
    const rows = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows;
    expect(rows[0]!.data).toBe("line1\nline2\nline3");
  });

  it("surfaces the service's exact validation texts as invalid outcomes", async () => {
    expect(await applyUserSettingsSecretForm(env.DB, 1, { name: "9bad", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: userSettingsSecretsLocale.invalid_name_pattern,
    });
    expect(await applyUserSettingsSecretForm(env.DB, 1, { name: "GITEA_TOKEN", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: userSettingsSecretsLocale.invalid_name_prefix,
    });
    expect(await applyUserSettingsSecretForm(env.DB, 1, { name: "github_x", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: userSettingsSecretsLocale.invalid_name_prefix,
    });
    expect(await applyUserSettingsSecretForm(env.DB, 1, { name: "ci", data: "v", description: "" })).toEqual({
      outcome: "invalid",
      message: userSettingsSecretsLocale.reserved_ci,
    });
    expect(await applyUserSettingsSecretForm(env.DB, 1, { name: "TOO_BIG", data: "x".repeat(65537), description: "" })).toEqual({
      outcome: "invalid",
      message: userSettingsSecretsLocale.data_too_long,
    });
    expect((await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows).toHaveLength(0); // nothing partially written
  });
});

// --- the delete ------------------------------------------------------------------

describe("deleteUserSettingsSecret (SecretsDelete → PerformSecretsDelete)", () => {
  beforeEach(async () => {
    await seedSecret("DOOMED", "v");
  });

  it("parses the id field (absent/junk → null, the FormInt64 convention)", () => {
    expect(parseUserSettingsSecretDeleteForm(new URLSearchParams({ id: "12" }))).toEqual({ id: 12 });
    expect(parseUserSettingsSecretDeleteForm(new URLSearchParams())).toEqual({ id: null });
    expect(parseUserSettingsSecretDeleteForm(new URLSearchParams({ id: "junk" }))).toEqual({ id: null });
  });

  it("deletes the scoped row by id", async () => {
    const row = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    expect(await deleteUserSettingsSecret(env.DB, 1, { id: row.id })).toBe("deleted");
    expect((await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows).toHaveLength(0);
  });

  it("answers missing for a null id, a stale id, and a foreign id — every arm deletes nothing", async () => {
    const row = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    expect(await deleteUserSettingsSecret(env.DB, 1, { id: null })).toBe("missing");
    expect(await deleteUserSettingsSecret(env.DB, 1, { id: row.id + 1000 })).toBe("missing");
    expect(await deleteUserSettingsSecret(env.DB, 2, { id: row.id })).toBe("missing"); // another doer's scope
    expect((await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows).toHaveLength(1);
  });

  it("is idempotent — a repeated delete answers missing", async () => {
    const row = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    expect(await deleteUserSettingsSecret(env.DB, 1, { id: row.id })).toBe("deleted");
    expect(await deleteUserSettingsSecret(env.DB, 1, { id: row.id })).toBe("missing");
  });
});

// --- the DOM --------------------------------------------------------------------

describe("the secrets page DOM (actions.tmpl + shared/secrets/add_list.tmpl at the pin)", () => {
  it("renders the page discriminator, the navbar with the Actions disclosure open and Secrets active", async () => {
    const html = await pageHtml();
    expect(html).toContain("user settings actions"); // layout_head's pageClass
    expect(html).toContain("<details");
    expect(html).toContain('class="active item" href="/user/settings/actions/secrets"');
    expect(html).toContain("open"); // navbar.tmpl:40's open arm
    expect(html).toContain('href="/user/settings/security"'); // the sibling tab
  });

  it("renders the empty arm (secrets.none) and the add form with the upstream contract", async () => {
    const html = await pageHtml();
    expect(html).toContain(userSettingsSecretsLocale.secrets_management);
    expect(html).toContain(userSettingsSecretsLocale.none);
    expect(html).toContain('action="/user/settings/actions/secrets"');
    expect(html).toContain('name="name"');
    expect(html).toContain(`pattern="${SECRET_NAME_PATTERN}"`); // add_list.tmpl:81
    expect(html).toContain("MY_SECRET_NAME"); // the pattern tooltip's placeholder arm
    expect(html).toContain(`maxlength="${SECRET_DATA_MAXLENGTH}"`); // {{.DataMaxLength}}
    expect(html).toContain(`maxlength="${SECRET_DESCRIPTION_MAXLENGTH}"`); // {{.DescriptionMaxLength}}
    expect(html).toContain(userSettingsSecretsLocale.value_placeholder);
    expect(html).toContain(userSettingsSecretsLocale.description_placeholder);
    expect(html).toContain(userSettingsSecretsLocale.secrets_description); // the dialog's lead line
    expect(html).toContain(`>${userSettingsSecretsLocale.add_secret}</button>`);
  });

  it("renders the list rows: glyph, name, description-or-dash, ******, added-on, no plaintext", async () => {
    await seedSecret("ALPHA", "alpha-plaintext-value", "the first one");
    await seedSecret("BETA", "beta-plaintext-value", "");
    const data = await loadUserSettingsSecretsPageData(env.DB, 1);
    const html = renderToString(
      <UserSettingsSecretsPage ctx={ctx} data={data} error={null} />,
    );
    expect(html).toContain("flex-divided-list items-with-main");
    expect(html).toContain(">ALPHA</div>");
    expect(html).toContain(">BETA</div>");
    expect(html).toContain("the first one");
    expect(html).toContain("<div class=\"item-body\">-</div>"); // the empty-description dash arm
    expect(html).toContain("******");
    expect(html).toContain("Added on"); // settings.added_on
    expect(html).not.toContain("alpha-plaintext-value"); // the value never enters the DOM
    expect(html).not.toContain("beta-plaintext-value");
    expect(html).not.toContain(userSettingsSecretsLocale.none);
  });

  it("renders the edit disclosures: read-only name, EMPTY value, and the remove id forms", async () => {
    await seedSecret("EDITABLE", "secret-value", "");
    const row = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    const html = await pageHtml();
    expect(html).toContain("<details>"); // the modal reduction
    expect(html).toContain(userSettingsSecretsLocale.edit_secret);
    // hono/jsx emits the JSX spelling `readOnly="true"` — HTML parsers
    // lowercase the attribute name, so the served input is readonly.
    expect(html).toContain('value="EDITABLE"');
    expect(html).toContain('readOnly="true"'); // add_list.tmpl:46's read-only arm
    expect(html).not.toContain("secret-value"); // add_list.tmpl:47's empty data arm
    expect(html).toContain('action="/user/settings/actions/secrets/delete"');
    expect(html).toContain(`name="id" value="${String(row.id)}"`);
    expect(html).toContain(userSettingsSecretsLocale.remove);
    expect(html).not.toContain("show-modal"); // the JS modal pair is not reproduced
    expect(html).not.toContain("link-action");
  });

  it("the error slot renders the negative message and the submitted form re-renders", async () => {
    const html = await pageHtml("name cannot start with 'GITEA_' or 'GITHUB_'", {
      name: "GITEA_TOKEN",
      data: "kept",
      description: "also kept",
    });
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain("name cannot start with &#39;GITEA_&#39; or &#39;GITHUB_&#39;");
    expect(html).toContain('value="GITEA_TOKEN"');
    expect(html).toContain("kept");
  });

  it("formatSecretDate renders upstream's AbsoluteShort in UTC", () => {
    expect(formatSecretDate(T0)).toBe("Nov 14, 2023");
  });

  it("the row component keys the description dash and the masked body (the add_list row shape)", async () => {
    await seedSecret("ROW_SHAPE", "v", "");
    const row = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    const html = renderToString(<SecretRowItem row={row} />);
    expect(html).toContain('class="item-main"');
    expect(html).toContain("******");
    expect(html).not.toContain(">v<");
  });

  it("the full-document render path matches the component path", async () => {
    const data = await loadUserSettingsSecretsPageData(env.DB, 1);
    const html = renderUserSettingsSecretsPage(ctx, data);
    expect(html).toContain("user settings actions");
    expect(html).toContain(userSettingsSecretsLocale.none);
  });

  it("leaves no stale rows behind after the delete flow (the store round-trip)", async () => {
    await seedSecret("GONE", "v");
    const row = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    await deleteUserSettingsSecret(env.DB, 1, { id: row.id });
    expect(await drizzle(env.DB).select().from(secrets).where(eq(secrets.id, row.id)).get()).toBeUndefined();
  });
});
