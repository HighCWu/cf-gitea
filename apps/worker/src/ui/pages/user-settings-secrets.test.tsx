/**
 * The user settings ACTIONS SECRETS tab's tests (the module is MOUNTED —
 * GET/POST `/user/settings/actions/secrets` + POST `/delete` ride the
 * ui/index.ts window; the repo-settings-wiki.test.tsx harness): the
 * parse/apply/delete matrix over real D1 through the LANDED
 * secrets-variables service (generated migrations in beforeAll; migration
 * 0021's `secrets` store) and the DOM contract of the page render — hono/jsx
 * renderToString. Both delete outcomes 303 back at the mounted handler and a
 * saved POST 303s while an invalid one re-renders (ui/index.ts), so the
 * module-level `saved`/`invalid`/`deleted`/`missing` outcomes below are the
 * handler's full observable surface. The deferred-test matrix (the
 * port-first/old-mode waves): name-pattern violations, the 65536-byte /
 * 4096-rune maxlength boundaries, the WEB-path EOL normalization (the API
 * path does NOT normalize — asserted), the id→row→name-keyed delete hop with
 * stale/foreign ids, duplicate-name upsert semantics, the 10000-cap list
 * posture, and the empty-form re-render arms.
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
  SECRET_WEB_LIST_LIMIT,
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

  it("pins SECRET_WEB_LIST_LIMIT at the documented 10000 cap (the unpaginated-web-list seam)", () => {
    // Upstream's web list is db.Find — unpaginated (shared/secrets/secrets.go:25-28);
    // the landed service paginates, so the loader passes a beyond-any-store page size.
    expect(SECRET_WEB_LIST_LIMIT).toBe(10000);
  });

  it("the beyond-any-store page size answers every row on page 1 and nothing beyond it", async () => {
    // Chunked: D1 caps bound variables per statement (a 40-row single insert
    // overflows SQLITE_MAX_VARIABLE_NUMBER).
    const rows40 = Array.from({ length: 40 }, (_, i) => ({
      ownerId: 1,
      repoId: "",
      name: `LOAD_${String(i).padStart(2, "0")}`,
      data: "v",
      description: "",
      createdAt: T0,
    }));
    for (let i = 0; i < rows40.length; i += 10) {
      await drizzle(env.DB).insert(secrets).values(rows40.slice(i, i + 10));
    }
    const data = await loadUserSettingsSecretsPageData(env.DB, 1);
    expect(data.secrets).toHaveLength(40);
    expect(data.secrets.map((row) => row.name)).toEqual(
      Array.from({ length: 40 }, (_, i) => `LOAD_${String(i).padStart(2, "0")}`),
    );
    // The cap's offset arithmetic: page 2 at the same limit is past the store.
    const second = await listSecretRows(env.DB, ownerScope(1), 2, SECRET_WEB_LIST_LIMIT);
    expect(second.rows).toEqual([]);
    expect(second.total).toBe(40);
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

  it("rejects the full name-pattern matrix — case-insensitive prefixes, leading digits, junk characters, empty", async () => {
    // The pattern trio (services/secrets-variables.ts:94-95 — upstream's
    // `(?i)^(GITEA_|GITHUB_)` is case-INSENSITIVE, validation.go:23):
    const patternViolations = ["", "   ", "1ABC", "007B", "HAS-HYPHEN", "HAS SPACE", "HAS.DOT"];
    const prefixViolations = ["GITEA_", "gitea_token", "GITHUB_X", "Github_Token", "github_"];
    for (const name of [...patternViolations, ...prefixViolations]) {
      const outcome = await applyUserSettingsSecretForm(env.DB, 1, { name, data: "v", description: "" });
      expect(outcome.outcome).toBe("invalid");
      if (outcome.outcome !== "invalid") continue; // narrows for the message assert below
      expect(outcome.message).toBe(
        prefixViolations.includes(name)
          ? userSettingsSecretsLocale.invalid_name_prefix
          : userSettingsSecretsLocale.invalid_name_pattern,
      );
    }
    expect((await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows).toHaveLength(0); // nothing partially written
  });

  it("accepts underscore-leading and digit-bearing names, storing the UPPERCASE normalization", async () => {
    expect(await applyUserSettingsSecretForm(env.DB, 1, { name: "_under_score", data: "v1", description: "" })).toEqual({
      outcome: "saved",
    });
    expect(await applyUserSettingsSecretForm(env.DB, 1, { name: "A1_B2", data: "v2", description: "" })).toEqual({
      outcome: "saved",
    });
    const rows = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows;
    // strings.ToUpper at insert; digits sort before underscore (ToOrders "name").
    expect(rows.map((row) => row.name)).toEqual(["A1_B2", "_UNDER_SCORE"]);
  });

  it("caps data at 65536 BYTES — the exact boundary saves and the cap counts bytes, not runes", async () => {
    // The DOM maxlength IS the service cap (SECRET_DATA_MAXLENGTH = SecretDataMaxLength).
    expect(await applyUserSettingsSecretForm(env.DB, 1, { name: "BOUNDARY", data: "x".repeat(SECRET_DATA_MAXLENGTH), description: "" })).toEqual({
      outcome: "saved",
    });
    let rows = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows;
    expect(new TextEncoder().encode(rows[0]!.data).length).toBe(65536);

    // 32768 two-byte runes = exactly 65536 bytes: inside the byte cap.
    expect(await applyUserSettingsSecretForm(env.DB, 1, { name: "MULTIBYTE_OK", data: "é".repeat(32768), description: "" })).toEqual({
      outcome: "saved",
    });
    // 32769 two-byte runes = 65538 bytes: over the cap though only ~33k runes.
    expect(await applyUserSettingsSecretForm(env.DB, 1, { name: "MULTIBYTE_OVER", data: "é".repeat(32769), description: "" })).toEqual({
      outcome: "invalid",
      message: userSettingsSecretsLocale.data_too_long,
    });
    rows = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows;
    expect(rows.map((row) => row.name)).toEqual(["BOUNDARY", "MULTIBYTE_OK"]); // the over-cap write left nothing
  });

  it("truncates the description at 4096 RUNES silently — the boundary is kept, over is trimmed, never invalid", async () => {
    expect(
      await applyUserSettingsSecretForm(env.DB, 1, { name: "DESC_BOUNDARY", data: "v", description: "d".repeat(SECRET_DESCRIPTION_MAXLENGTH) }),
    ).toEqual({ outcome: "saved" });
    // No invalid arm — the maxlength is client-side only; the service truncates (TruncateRunes).
    expect(
      await applyUserSettingsSecretForm(env.DB, 1, { name: "DESC_OVER", data: "v", description: "d".repeat(SECRET_DESCRIPTION_MAXLENGTH + 1) }),
    ).toEqual({ outcome: "saved" });
    // Rune counting, not bytes: 4096 two-byte runes (8192 bytes) survive verbatim.
    expect(
      await applyUserSettingsSecretForm(env.DB, 1, { name: "DESC_MULTIBYTE", data: "v", description: "é".repeat(SECRET_DESCRIPTION_MAXLENGTH) }),
    ).toEqual({ outcome: "saved" });

    const byName = new Map((await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows.map((row) => [row.name, row]));
    expect(byName.get("DESC_BOUNDARY")!.description).toHaveLength(SECRET_DESCRIPTION_MAXLENGTH);
    expect(byName.get("DESC_OVER")!.description).toHaveLength(SECRET_DESCRIPTION_MAXLENGTH); // trimmed to the cap
    expect(byName.get("DESC_MULTIBYTE")!.description).toHaveLength(SECRET_DESCRIPTION_MAXLENGTH); // UTF-16 units
    expect([...byName.get("DESC_MULTIBYTE")!.description]).toHaveLength(SECRET_DESCRIPTION_MAXLENGTH); // RUNES
    expect(new TextEncoder().encode(byName.get("DESC_MULTIBYTE")!.description).length).toBe(8192); // bytes were not the unit
  });

  it("the API path (the bare service call) does NOT normalize EOLs — the CRLF fold is the WEB path's alone", async () => {
    // services/secrets-variables.ts stores data verbatim (the header's
    // length-units note: "secret data is not" normalized) — the API PUT arm.
    await createOrUpdateSecret(env.DB, ownerScope(1), "API_RAW", "line1\r\nline2", "");
    const rows = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows;
    expect(rows[0]!.data).toBe("line1\r\nline2");
  });

  it("the WEB path folds CRLF→LF in data only — a bare CR and the description pass through", async () => {
    await applyUserSettingsSecretForm(env.DB, 1, {
      name: "WEB_EOL",
      data: "win\r\nold-mac\rend\r\n",
      description: "desc\r\nkeeps\r\nCRLF",
    });
    let rows = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows;
    expect(rows[0]!.data).toBe("win\nold-mac\rend\n"); // util.NormalizeStringEOL folds only \r\n pairs (util.go:312)
    expect(rows[0]!.description).toBe("desc\r\nkeeps\r\nCRLF"); // PerformSecretsPost normalizes form.Data only (secrets.go:42)
    // The update arm folds too.
    await applyUserSettingsSecretForm(env.DB, 1, { name: "WEB_EOL", data: "again\r\n", description: "" });
    rows = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows;
    expect(rows[0]!.data).toBe("again\n");
  });

  it("the empty-form POST answers the pattern violation and writes nothing (the untouched-form no-JS submit)", async () => {
    expect(await applyUserSettingsSecretForm(env.DB, 1, { name: "", data: "", description: "" })).toEqual({
      outcome: "invalid",
      message: userSettingsSecretsLocale.invalid_name_pattern,
    });
    expect((await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows).toHaveLength(0);
  });

  it("empty data saves — the dialog's required attribute is client-side only (the no-JS reduction)", async () => {
    expect(await applyUserSettingsSecretForm(env.DB, 1, { name: "NO_VALUE", data: "", description: "" })).toEqual({
      outcome: "saved",
    });
    const rows = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows;
    expect(rows[0]!.data).toBe("");
  });

  it("upsert matches case-insensitively on UPPER(name) — one row, data+description replaced, createdAt untouched", async () => {
    expect(await applyUserSettingsSecretForm(env.DB, 1, { name: "Prod_Key", data: "v1", description: "first" })).toEqual({
      outcome: "saved",
    });
    let rows = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("PROD_KEY"); // strings.ToUpper at insert
    await env.DB.prepare("UPDATE secrets SET created_unix = 1000000 WHERE owner_id = 1").run(); // backdate to prove the update arm skips it

    expect(await applyUserSettingsSecretForm(env.DB, 1, { name: "prod_key", data: "v2", description: "second" })).toEqual({
      outcome: "saved",
    });
    rows = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows;
    expect(rows).toHaveLength(1); // the SAME row — the find-by-UPPER-name hit, no duplicate
    expect(rows[0]!.name).toBe("PROD_KEY");
    expect(rows[0]!.data).toBe("v2");
    expect(rows[0]!.description).toBe("second");
    expect(rows[0]!.createdAt.getTime()).toBe(1_000_000_000); // UpdateSecret touches data+description only (secret.go:132-152)
  });

  it("the same name coexists across scopes — another doer's save upserts its own row, not mine", async () => {
    await applyUserSettingsSecretForm(env.DB, 1, { name: "SHARED_NAME", data: "mine", description: "user 1" });
    await applyUserSettingsSecretForm(env.DB, 2, { name: "SHARED_NAME", data: "theirs", description: "user 2" });
    let rows = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toBe("mine");
    rows = (await listSecretRows(env.DB, ownerScope(2), 1, 10)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toBe("theirs");
    // The UNIQUE(owner_repo_name) triple is (owner, repo, name) — user 2's re-save stays in its scope.
    await applyUserSettingsSecretForm(env.DB, 2, { name: "SHARED_NAME", data: "theirs-v2", description: "" });
    rows = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows;
    expect(rows[0]!.data).toBe("mine"); // untouched by the foreign upsert
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

  it("a stale id stays missing even after the same name is recreated (the hop is id→row, not id→name)", async () => {
    const first = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows[0]!;
    expect(await deleteUserSettingsSecret(env.DB, 1, { id: first.id })).toBe("deleted");
    await seedSecret("DOOMED", "recreated"); // same name, a NEW id
    const rows = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(first.id);
    expect(await deleteUserSettingsSecret(env.DB, 1, { id: first.id })).toBe("missing"); // the old id resolves to nothing
    expect(await deleteUserSettingsSecret(env.DB, 1, { id: rows[0]!.id })).toBe("deleted"); // the new id deletes
  });

  it("the id→row→name hop is scope-guarded — deleting a same-named row in another doer's scope spares mine", async () => {
    await seedSecret("TWINS", "mine", "", 1);
    await seedSecret("TWINS", "theirs", "", 2);
    const mine = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows.find((row) => row.name === "TWINS")!;
    const theirs = (await listSecretRows(env.DB, ownerScope(2), 1, 10)).rows[0]!; // the describe's DOOMED seed belongs to user 1 only
    expect(mine.id).not.toBe(theirs.id);
    expect(await deleteUserSettingsSecret(env.DB, 2, { id: theirs.id })).toBe("deleted");
    const after = (await listSecretRows(env.DB, ownerScope(1), 1, 10)).rows.filter((row) => row.name === "TWINS");
    expect(after).toHaveLength(1);
    expect(after[0]!.data).toBe("mine"); // the name-keyed hop resolved within the deleting doer's scope only
  });

  it("a repo-scoped row's id is foreign to the user scope — the hop answers missing and deletes nothing", async () => {
    await env.DB.prepare(
      "INSERT INTO secrets (owner_id, repo_id, name, data, description, created_unix) VALUES (0, 'repo-1', 'REPO_ROW', 'x', '', 0)",
    ).run();
    const repoRow = await drizzle(env.DB).select().from(secrets).where(eq(secrets.name, "REPO_ROW")).get();
    expect(await deleteUserSettingsSecret(env.DB, 1, { id: repoRow!.id })).toBe("missing");
    expect(await drizzle(env.DB).select().from(secrets).where(eq(secrets.name, "REPO_ROW")).get()).toBeDefined(); // untouched
  });

  it("parses the id edge arms — zero-padded passes, signed/decimal/trailing-junk do not — and id 0 is missing", async () => {
    expect(parseUserSettingsSecretDeleteForm(new URLSearchParams({ id: "007" }))).toEqual({ id: 7 });
    expect(parseUserSettingsSecretDeleteForm(new URLSearchParams({ id: "0" }))).toEqual({ id: 0 });
    expect(parseUserSettingsSecretDeleteForm(new URLSearchParams({ id: "-1" }))).toEqual({ id: null });
    expect(parseUserSettingsSecretDeleteForm(new URLSearchParams({ id: "1.5" }))).toEqual({ id: null });
    expect(parseUserSettingsSecretDeleteForm(new URLSearchParams({ id: " 1" }))).toEqual({ id: null });
    expect(parseUserSettingsSecretDeleteForm(new URLSearchParams({ id: "12abc" }))).toEqual({ id: null });
    // id 0 matches no row (autoincrement starts at 1) — "missing"; both delete
    // outcomes 303 back at the mounted handler (ui/index.ts, the module header).
    expect(await deleteUserSettingsSecret(env.DB, 1, { id: 0 })).toBe("missing");
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

  it("pins the maxlength exports to upstream's caps (SecretDataMaxLength 65536 / SecretDescriptionMaxLength 4096)", () => {
    // models/secret/secret.go:50-51 — the dialog's {{.DataMaxLength}} /
    // {{.DescriptionMaxLength}} (add_list.tmpl:91, 101).
    expect(SECRET_DATA_MAXLENGTH).toBe(65536);
    expect(SECRET_DESCRIPTION_MAXLENGTH).toBe(4096);
  });

  it("the failed EMPTY-form POST re-renders the error line over the empty form arm", async () => {
    const html = await pageHtml(userSettingsSecretsLocale.invalid_name_pattern, { name: "", data: "", description: "" });
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain(userSettingsSecretsLocale.invalid_name_pattern);
    expect(html).toContain('value=""'); // the add input re-renders the empty submitted name
    expect(html).toContain(userSettingsSecretsLocale.none); // nothing was written, so the empty list line rides too
  });
});
