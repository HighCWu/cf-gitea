/**
 * Tier-2 misc batch on real D1/bindings (SPEC-0004 appendix A table-free
 * rows): routes/misc-t2.ts — the gitignore/label/license template family,
 * POST /markup, the GET/DELETE /token pair, and the four `settings`-tagged
 * General* reads. One standalone app per the tier2-extras.test.ts convention
 * (the routes ARE registered in router.ts by the orchestrator after this
 * batch lands; the isolated mount keeps the family independently assertable).
 *
 * The template families are pure static data (vendored gitea/options/*), so
 * their tests pin the exact wire shapes upstream serves; the /token pair
 * rides the EXISTING personal_access_tokens table (SPEC-0002) with rows
 * seeded through the raw digest format (auth/token-format.ts lookup rules).
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import { personalAccessTokens, users } from "../../db/schema";
import { sha256Hex } from "../../auth/digest";
import type { AuthUser } from "../../auth/auth-context";
import {
  createTokenAuthMiddleware,
  STUB_USER,
  type AuthResolver,
} from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import { registerMiscT2Routes } from "./misc-t2";

const NOW = new Date("2026-02-03T04:05:06Z");

/** Well-formed minted-shape credential (`cfg_<8hex>_<32base32>`); the prefix
 *  is its first 12 chars (auth/token-format.ts tokenLookupPrefix). */
const PAT_VALUE = `cfg_abcdef01_${"A".repeat(32)}`;
const PAT_FOREIGN_VALUE = `cfg_ffffff01_${"B".repeat(32)}`;
/** A header token the resolver accepts while NO matching D1 row exists for
 *  the doer (the resolveCurrentTokenRow 404 arm). */
const PAT_ROWLESS_VALUE = `cfg_000000ab_${"C".repeat(32)}`;

const TOKEN = "stub-token"; // resolves to the seed user (id 1)
const TOKEN_NEIGHBOR = "neighbor-token"; // resolves to the neighbor (id captured per test)

/** The neighbor's id — the users AUTOINCREMENT sequence persists across the
 *  shared test DB, so it is captured in beforeEach (never hardcoded). */
let neighborId = 0;

function resolver(): AuthResolver {
  return {
    resolveToken: (token) => {
      if (token === TOKEN) return Promise.resolve(STUB_USER);
      if (token === TOKEN_NEIGHBOR || token === PAT_FOREIGN_VALUE) {
        return Promise.resolve({ ...STUB_USER, id: neighborId, login: "neighbor" });
      }
      if (token === PAT_VALUE || token === PAT_ROWLESS_VALUE) {
        // D1-aware like the production resolver: the presented credential
        // authenticates only while its row exists (the post-DELETE 401).
        if (token === PAT_VALUE) {
          return env.DB.prepare("SELECT id FROM personal_access_tokens WHERE prefix = ?1")
            .bind(PAT_VALUE.slice(0, 12))
            .first()
            .then((row) => (row === null ? null : STUB_USER));
        }
        return Promise.resolve(STUB_USER);
      }
      return Promise.resolve(null);
    },
  };
}

function familyApp(register: (app: OpenAPIHono<ApiEnv>) => void) {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  register(app);
  return async (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.fetch(new Request(`https://example.com${path}`, init), env));
}

const authed = (init?: RequestInit, token = TOKEN): RequestInit => {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `token ${token}`);
  return { ...init, headers };
};

const jsonAuthed = (body: unknown, token = TOKEN): RequestInit =>
  authed({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, token);

const miscSend = familyApp((app) => registerMiscT2Routes(app, createTokenAuthMiddleware(resolver())));

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  const { applyRepoExtrasDdl } = await import("../testing/repo-ddl");
  await applyRepoExtrasDdl();
});

beforeEach(async () => {
  for (const table of ["personal_access_tokens", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, created_at) VALUES (1, 'cf-gitea-stub', 'cf-gitea-stub', 0, 'active', 0)",
  ).run();
  neighborId = (
    await drizzle(env.DB)
      .insert(users)
      .values({ username: "neighbor", usernameLower: "neighbor", status: "active", createdAt: NOW })
      .returning({ id: users.id })
      .all()
  )[0]!.id;
});

/** Seed one PAT row (raw digest format) for the given owner. */
async function seedToken(value: string, userId: number, name = "seeded-token"): Promise<number> {
  const row = await drizzle(env.DB)
    .insert(personalAccessTokens)
    .values({
      userId,
      name,
      prefix: value.slice(0, 12),
      sha256Digest: await sha256Hex(value),
      scopes: "all",
      createdAt: NOW,
    })
    .returning({ id: personalAccessTokens.id })
    .all();
  return row[0]!.id;
}

// ---------------------------------------------------------------------------
// Template families (static vendored data)
// ---------------------------------------------------------------------------

describe("GET /gitignore/templates[/{name}] (misc-t2)", () => {
  it("lists the pinned vendored set, sorted, and serves exact sources", async () => {
    const list = await miscSend("/gitignore/templates");
    expect(list.status).toBe(200);
    const names: string[] = await list.json();
    expect(names).toHaveLength(270);
    expect(names[0]).toBe("AL");
    expect(names).toContain("C");
    expect(names).toContain("C++");
    expect([...names].sort()).toEqual(names); // LoadRepoConfig sorted order

    const c = await miscSend("/gitignore/templates/C");
    expect(c.status).toBe(200);
    const info: Record<string, string> = await c.json();
    expect(info.name).toBe("C");
    expect(info.source!.startsWith("# Prerequisites\n*.d")).toBe(true);

    const cpp = await miscSend(`/gitignore/templates/${encodeURIComponent("C++")}`);
    expect(cpp.status).toBe(200);
    const cppInfo: Record<string, string> = await cpp.json();
    expect(cppInfo.name).toBe("C++");
  });

  it("404s unknown and case-mismatched names (exact asset lookup)", async () => {
    expect((await miscSend("/gitignore/templates/NoSuchTemplate")).status).toBe(404);
    expect((await miscSend("/gitignore/templates/c")).status).toBe(404);
  });
});

describe("GET /label/templates[/{name}] (misc-t2)", () => {
  it("lists the two display names and serves the parsed Advanced template", async () => {
    const list = await miscSend("/label/templates");
    expect(list.status).toBe(200);
    const displayNames: string[] = await list.json();
    expect(displayNames).toEqual(["Advanced", "Default"]);

    const advanced = await miscSend("/label/templates/Advanced");
    expect(advanced.status).toBe(200);
    const labels: Array<Record<string, unknown>> = await advanced.json();
    expect(labels).toHaveLength(18);
    expect(labels[0]).toEqual({
      name: "Kind/Bug",
      color: "ee0701", // ToLabelTemplate strips the '#'
      description: "Something is not working",
      exclusive: false,
    });
    const exclusive = labels.find((label) => label.name === "Reviewed/Duplicate");
    expect(exclusive?.exclusive).toBe(true);
    for (const label of labels) {
      expect(String(label.color)).not.toMatch(/^#/);
    }
  });

  it("serves the legacy Default template and 404s unknown display names", async () => {
    const def = await miscSend("/label/templates/Default");
    expect(def.status).toBe(200);
    const labels: Array<Record<string, unknown>> = await def.json();
    expect(labels).toHaveLength(7);
    expect(labels[0]).toEqual({
      name: "bug",
      color: "ee0701",
      description: "Something is not working",
      exclusive: false,
    });

    expect((await miscSend("/label/templates/NoSuchTemplate")).status).toBe(404);
    expect((await miscSend("/label/templates/advanced")).status).toBe(404);
  });
});

describe("GET /licenses[/{{name}}] (misc-t2)", () => {
  it("lists the vendored set with self-referencing URLs", async () => {
    const list = await miscSend("/licenses");
    expect(list.status).toBe(200);
    const licenses: Array<Record<string, string>> = await list.json();
    expect(licenses).toHaveLength(27);
    const mit = licenses.find((entry) => entry.key === "MIT");
    expect(mit).toEqual({ key: "MIT", name: "MIT", url: "https://example.com/api/v1/licenses/MIT" });
  });

  it("serves the full license body with the fixed implementation note; 404s unknown", async () => {
    const info = await miscSend("/licenses/MIT");
    expect(info.status).toBe(200);
    const body: Record<string, string> = await info.json();
    expect(body.key).toBe("MIT");
    expect(body.name).toBe("MIT");
    expect(body.url).toBe("https://example.com/api/v1/licenses/MIT");
    expect(body.body!.startsWith("MIT License\n\nCopyright (c)")).toBe(true);
    expect(body.implementation).toBe(
      "Create a text file (typically named LICENSE or LICENSE.txt) in the root of your source code and copy the text of the license into the file",
    );

    expect((await miscSend("/licenses/NoSuchLicense")).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /markup
// ---------------------------------------------------------------------------

describe("POST /markup (misc-t2)", () => {
  it("renders markdown modes through the shared RenderMarkup port", async () => {
    const rendered = await miscSend("/markup", jsonAuthed({ Text: "# Hi", Mode: "markdown" }));
    expect(rendered.status).toBe(200);
    expect(rendered.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await rendered.text()).toContain("<h1");

    // comment mode + Context rewrites relative links into the repo URL space.
    const comment = await miscSend(
      "/markup",
      jsonAuthed({ Text: "[doc](./a.md)", Mode: "comment", Context: "owner/repo/src/branch/main" }),
    );
    expect(comment.status).toBe(200);
    expect(await comment.text()).toContain('href="https://example.com/owner/repo/src/branch/main/a.md"');

    // empty payload renders the empty document (mode "" behaves as markdown).
    expect((await miscSend("/markup", jsonAuthed({}))).status).toBe(200);
  });

  it("Wiki:true forces wiki mode (the deprecated field); unknown modes 422", async () => {
    const wiki = await miscSend("/markup", jsonAuthed({ Text: "[[Page]]", Wiki: true, Context: "owner/repo" }));
    expect(wiki.status).toBe(200);
    expect(await wiki.text()).toContain('href="https://example.com/owner/repo/wiki/Page"');

    const bad = await miscSend("/markup", jsonAuthed({ Text: "x", Mode: "asciidoc" }));
    expect(bad.status).toBe(422);
    const body: Record<string, unknown> = await bad.json();
    expect(body.message).toBe("unsupported render mode: asciidoc");
  });

  it("requires a token (runtime-only 401, undeclared in the vendored contract)", async () => {
    const response = await miscSend("/markup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Text: "x" }),
    });
    expect(response.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET/DELETE /token (the presented credential's row)
// ---------------------------------------------------------------------------

describe("GET/DELETE /token (misc-t2)", () => {
  it("returns the presented credential's metadata (never-used token renders the Go zero time)", async () => {
    const tokenId = await seedToken(PAT_VALUE, 1);
    const response = await miscSend("/token", authed(undefined, PAT_VALUE));
    expect(response.status).toBe(200);
    const body: Record<string, unknown> = await response.json();
    expect(body.id).toBe(tokenId);
    expect(body.name).toBe("seeded-token");
    expect(body.scopes).toEqual(["all"]);
    expect(body.created_at).toBe(NOW.toISOString());
    expect(body.last_used_at).toBe("0001-01-01T00:00:00Z");
    expect(body.user).toEqual({ id: 1, login: "cf-gitea-stub" });
  });

  it("renders a real last-used timestamp and a foreign-owner row is the 404 arm", async () => {
    await seedToken(PAT_FOREIGN_VALUE, neighborId); // the neighbor's credential
    const used = new Date("2026-03-04T05:06:07Z");
    await drizzle(env.DB)
      .update(personalAccessTokens)
      .set({ lastUsedAt: used })
      .where(eq(personalAccessTokens.prefix, PAT_FOREIGN_VALUE.slice(0, 12)));
    const neighborView = await miscSend("/token", authed(undefined, PAT_FOREIGN_VALUE));
    expect(neighborView.status).toBe(200);
    const neighborBody: Record<string, unknown> = await neighborView.json();
    expect(neighborBody.last_used_at).toBe(used.toISOString());
    expect(neighborBody.user).toEqual({ id: neighborId, login: "neighbor" });

    // The doer is the stub but no row carries the presented prefix →
    // getToken's ErrNotExist 404.
    const mismatched = await miscSend("/token", authed(undefined, PAT_ROWLESS_VALUE));
    expect(mismatched.status).toBe(404);
    const mismatchedBody: Record<string, unknown> = await mismatched.json();
    expect(mismatchedBody.message).toBe("invalid access token");
  });

  it("identity arriving without a token-scheme header is the 404 arm (production resolveAuth precedence)", async () => {
    // Simulate the mounted resolveAuth path: c.var.auth set, the header NOT
    // `token`-scheme — requireAuth accepts the ctxAuth identity, then
    // getToken's header parse fails (token.go:80–84).
    const app = new OpenAPIHono<ApiEnv>();
    app.onError(giteaErrorHandler);
    const authUser: AuthUser = {
      id: 1,
      username: "cf-gitea-stub",
      usernameLower: "cf-gitea-stub",
      email: null,
      displayName: null,
      location: null,
      website: null,
      description: null,
      isAdmin: false,
      status: "active",
      createdAt: NOW,
    };
    app.use("*", async (c, next) => {
      // Full AuthInfo shape (auth-parity H1 widened ApiEnv.auth): this rig
      // simulates a resolved identity WITHOUT a token credential, so scope
      // stays null — behaviorally identical to the `{ user }` slice this
      // set before the widening (the gate passes scopeless requests).
      c.set("auth", { user: authUser, token: null, scope: null, isBasicAuth: false });
      await next();
    });
    registerMiscT2Routes(app, createTokenAuthMiddleware(resolver()));
    const response = await app.fetch(
      new Request("https://example.com/token", { headers: { Authorization: "Basic dXNlcjpwYXNz" } }),
      env,
    );
    expect(response.status).toBe(404);
  });

  it("DELETE removes the presented credential (204) and the dead token then fails auth", async () => {
    await seedToken(PAT_VALUE, 1);
    expect((await miscSend("/token", authed({ method: "DELETE" }, PAT_VALUE))).status).toBe(204);
    const rows = await drizzle(env.DB).select().from(personalAccessTokens).all();
    expect(rows).toHaveLength(0);
    // The middleware re-validates every request: the deleted credential is
    // now an anonymous caller (reqToken 401 — upstream wires the same order).
    expect((await miscSend("/token", authed({ method: "DELETE" }, PAT_VALUE))).status).toBe(401);
    expect((await miscSend("/token", authed(undefined, PAT_VALUE))).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Settings (static published config, anonymous)
// ---------------------------------------------------------------------------

describe("GET /settings/* (misc-t2)", () => {
  it("publishes the api pagination/blob constants our routes enforce", async () => {
    const response = await miscSend("/settings/api");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      default_git_trees_per_page: 1000,
      default_max_blob_size: 10485760,
      default_max_response_size: 104857600,
      default_paging_num: 30,
      max_response_items: 50,
    });
  });

  it("publishes ui (reactions set = the enforced set), repository (time tracking honestly off), attachment", async () => {
    const ui = await miscSend("/settings/ui");
    expect(ui.status).toBe(200);
    const uiBody: Record<string, unknown> = await ui.json();
    expect(uiBody.default_theme).toBe("gitea-auto");
    expect(uiBody.custom_emojis).toEqual([]);
    expect(uiBody.allowed_reactions).toEqual(["+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes"]);

    const repo = await miscSend("/settings/repository");
    expect(repo.status).toBe(200);
    expect(await repo.json()).toEqual({
      http_git_disabled: false,
      lfs_disabled: false,
      migrations_disabled: false,
      mirrors_disabled: false,
      stars_disabled: false,
      time_tracking_disabled: true, // no tracked-times model exists
    });

    const attachment = await miscSend("/settings/attachment");
    expect(attachment.status).toBe(200);
    const attachmentBody: Record<string, unknown> = await attachment.json();
    expect(attachmentBody.enabled).toBe(true);
    expect(attachmentBody.max_files).toBe(5);
    expect(attachmentBody.max_size).toBe(512); // our real release-asset 413 threshold (MiB)
    expect(String(attachmentBody.allowed_types).split(",")).toContain(".pdf");
  });
});
