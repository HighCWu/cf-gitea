/**
 * The repo settings public-access tab's SMOKE test (PORT-FIRST — ONE happy
 * path, the repo-settings-deploy-keys.smoke.test.tsx harness): the seeded
 * private repo (owner + collaborator + org-team rows, so the test also proves
 * this page is driven by repo_units — the collaborator/team graph is the
 * collaboration page's data and renders nothing here) renders the Code unit's
 * public-access row with the Anonymous Read arm armed, and the page's write
 * flips the stored grant the git-HTTP ACL consumes. The module is MOUNTED
 * since window-2d b54f709 (GET+POST /settings/public_access at ui/index.ts),
 * and the deferred matrix below also drives the REAL routes (the org-blocked
 * 9125040 matrix's minted-session pattern): the settingsGate posture on both
 * methods, the signed-in non-admin's 404 before any write, the admin GET's
 * armed radio reflecting the ACL read, the POST flip both ways → 303 with the
 * value re-read through BOTH the page loader and the landed
 * `codeUnitAnonymousRead` (the git-HTTP ACL seam — page and gate agree),
 * junk form values collapsing to not-set, and the guard-first cross-origin
 * 403.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { codeUnitAnonymousRead } from "../../git-http/acl";
import { repoUnits, repositories, users } from "../../db/schema";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  CODE_UNIT_FORM_KEY,
  loadRepoPublicAccess,
  parsePublicAccessForm,
  publicAccessLocale,
  RepoPublicAccessPage,
  renderRepoPublicAccessPage,
  updateCodeUnitPublicAccess,
} from "./repo-settings-public-access";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const selfViewer: Viewer = { kind: "user", id: 1, username: "alice", isAdmin: false };

const ctx: UiContext = {
  viewer: selfViewer,
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

let repo: RepoRow;

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["team_repo_access", "teams", "repo_collaborators", "repo_units", "org_members", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  repo = await seedPrivateRepo();
});

/** The happy-path seed: the owner, a collaborator, an org with a team granted
 *  to the repo (the mission's seed list — present to prove this page ignores
 *  them), the PRIVATE repo, and the code unit carrying the anonymous-read
 *  grant (SPEC-0003 §3.1 — no production producer seeds repo_units rows, the
 *  module header; the test seeds the state the ACL rows 4/5 read). */
async function seedPrivateRepo(): Promise<RepoRow> {
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (1, 'alice', 'alice', 'Alice Doe', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, created_at) VALUES (2, 'bob', 'bob', 'Bob Collab', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, display_name, type, created_at) VALUES (3, 'acme', 'acme', 'Acme Org', 'org', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-1', 'repo-1', 'alice', 1, 'demo', 'main', 'private', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO repo_units (repo_id, type, anonymous_access_mode) VALUES ('repo-1', 'code', 'read')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO repo_collaborators (repo_id, user_id, mode) VALUES ('repo-1', 2, 'write')",
  ).run();
  await env.DB.prepare(
    "INSERT INTO teams (org_id, lower_name, name, authorize) VALUES (3, 'devs', 'devs', 'read')",
  ).run();
  const team = await env.DB.prepare("SELECT id FROM teams WHERE org_id = 3 AND lower_name = 'devs'").first<{ id: number }>();
  await env.DB.prepare("INSERT INTO team_repo_access (org_id, team_id, repo_id) VALUES (3, ?, 'repo-1')")
    .bind(team!.id)
    .run();
  const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "repo-1")).get();
  if (row === undefined) throw new Error("fixture repository missing");
  return row;
}

// --- the one happy path ---------------------------------------------------------

describe("the public-access panel (load + render + the Update Settings write)", () => {
  it("renders the Code unit's row with Anonymous Read armed on the private repo, then the POST flips the stored grant", async () => {
    // The read: the ACL rows 4/5 value and the nav conditional's second arm.
    const data = await loadRepoPublicAccess(env.DB, repo.id);
    expect(data.codeAnonymousRead).toBe(true);
    expect(data.hasAnyPublicAccess).toBe(true);

    const html = renderToString(<RepoPublicAccessPage ctx={{ ...ctx, repo }} data={data} />);
    expect(html).toContain("repository settings"); // the §2.4.1 discriminator (the layout_head literal)
    expect(html).toContain(`>${publicAccessLocale.public_access}</h4>`);
    // The desc line (asserted from the apostrophe-free tail — renderToString
    // escapes "visitor's" to "visitor&#39;s").
    expect(html).toContain("access permissions to override the defaults of this repository.");
    // The form onto the page's own URL (upstream's m.Combo — GET and POST).
    expect(html).toContain('action="/alice/demo/settings/public_access"');
    expect(html).toContain('method="post"');
    // The one rendered row (Code) with upstream's radio name/value literals;
    // Anonymous Read armed, Not set unarmed.
    expect(html).toContain(publicAccessLocale.unit_code);
    expect(html).toContain(`name="${CODE_UNIT_FORM_KEY}" value="not-set"`);
    expect(html).toContain(`name="${CODE_UNIT_FORM_KEY}" value="anonymous-read" checked`);
    expect(html).not.toContain(`name="${CODE_UNIT_FORM_KEY}" value="not-set" checked`);
    // The docs list (the two live arms; asserted from apostrophe-free
    // tails — renderToString escapes the possessives to &#39;).
    expect(html).toContain("no extra public access permission.");
    expect(html).toContain(publicAccessLocale.docs_anonymous_read);
    expect(html).toContain(publicAccessLocale.everyone_columns_note);
    expect(html).toContain("the other units&#39; public-access rows appear when their storage lands.");
    // The submit is never disabled (no ForcePrivate model — the module header).
    expect(html).toContain(`>${publicAccessLocale.update_settings}</button>`);
    expect(html).not.toContain("disabled");
    // The private-visibility nav arm (navbar.tmpl:7-11): the conditional item
    // renders ACTIVE between Repository and Collaboration.
    expect(html).toContain('href="/alice/demo/settings"');
    expect(html).toContain('class="active item" href="/alice/demo/settings/public_access"');
    expect(html).toContain('href="/alice/demo/settings/collaboration"');
    // The survey correction: the collaborator and the team grant render
    // NOTHING here (the collaboration page's data).
    expect(html).not.toContain("bob");
    expect(html).not.toContain("devs");
    // The full-document render path matches the component path.
    expect(renderRepoPublicAccessPage({ ctx: { ...ctx, repo }, data })).toContain("repository settings");

    // The write (upstream PublicAccessPost → UpdateRepoUnitPublicAccess):
    // Not set stores 'none' on the unit row the git-HTTP ACL reads.
    const form = parsePublicAccessForm(new URLSearchParams({ [CODE_UNIT_FORM_KEY]: "not-set" }));
    expect(form).toBe("not-set");
    expect((await updateCodeUnitPublicAccess(env.DB, repo.id, form)).outcome).toBe("applied");
    const unitRow = await drizzle(env.DB)
      .select({ anonymousAccessMode: repoUnits.anonymousAccessMode })
      .from(repoUnits)
      .where(eq(repoUnits.repoId, repo.id))
      .get();
    expect(unitRow!.anonymousAccessMode).toBe("none");
    const cleared = await loadRepoPublicAccess(env.DB, repo.id);
    expect(cleared.codeAnonymousRead).toBe(false);
    const clearedHtml = renderToString(<RepoPublicAccessPage ctx={{ ...ctx, repo }} data={cleared} />);
    expect(clearedHtml).toContain(`name="${CODE_UNIT_FORM_KEY}" value="not-set" checked`);
    expect(clearedHtml).not.toContain(`name="${CODE_UNIT_FORM_KEY}" value="anonymous-read" checked`);

    // …and back: Anonymous Read stores 'read' again (the upsert re-arms).
    const rearm = parsePublicAccessForm(new URLSearchParams({ [CODE_UNIT_FORM_KEY]: "anonymous-read" }));
    expect((await updateCodeUnitPublicAccess(env.DB, repo.id, rearm)).outcome).toBe("applied");
    expect(await loadRepoPublicAccess(env.DB, repo.id)).toEqual({ codeAnonymousRead: true, hasAnyPublicAccess: true });
  });
});

// --- the mounted-route harness (window-2d b54f709; the org-blocked-matrix
// --- minted-session pattern) ---------------------------------------------

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The real production path: parse → resolveUiSession → resolveUiRequest →
 *  the settingsGate → load → render, on the mounted uiRouter with the
 *  synthetic manifest; the execution context is awaited so waitUntil
 *  side-effects settle before assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A minted session cookie header for the user id (the real mintSession
 *  path, minted per request — the beforeEach users wipe cascades the
 *  sessions table, so a cross-test cache would go stale; the value is never
 *  rendered). */
async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** The seeded principal's minted session header, looked up by username
 *  (never a hardcoded id — the seed rows are the only authority). */
async function sessionHeaderFor(usernameLower: string): Promise<string> {
  const row = await drizzle(env.DB)
    .select({ id: users.id })
    .from(users)
    .where(eq(users.usernameLower, usernameLower))
    .get();
  if (row === undefined) throw new Error(`fixture user ${usernameLower} missing`);
  return sessionHeader(row.id);
}

/** The seeded owner's minted session header — the repo-admin doer the
 *  settingsGate's isRepositoryAdmin admits (the owner arm). */
async function ownerSessionHeader(): Promise<string> {
  return sessionHeaderFor("alice");
}

/** The seeded write-mode collaborator's minted session header — the signed-in
 *  non-admin: isRepositoryAdmin ranks only 'admin' collaborators, so the
 *  settings family refuses bob on both layers tested below. */
async function collaboratorSessionHeader(): Promise<string> {
  return sessionHeaderFor("bob");
}

/** Flip the seeded repo's visibility. readGrant (acl.ts — the SPEC-0010 §2.6
 *  one-copy visibility predicate) resolves a repo for anonymous/non-admin
 *  viewers ONLY when it is public, so the PUBLIC twin is what exposes the
 *  settingsGate's own 303/404 layers; on the private seed those viewers are
 *  answered by the resolver's invisible-repo 404 before the gate is reached
 *  (invisible ≡ missing — never a 401/403 for pages). */
async function setRepositoryVisibility(visibility: "public" | "private"): Promise<void> {
  await env.DB.prepare("UPDATE repositories SET visibility = ? WHERE id = ?").bind(visibility, repo.id).run();
}

/** The admin's GET of the tab through the real route. */
async function publicAccessGet(): Promise<Response> {
  return fetchUi("/alice/demo/settings/public_access", { headers: { cookie: await ownerSessionHeader() } });
}

/** The admin's urlencoded POST to the tab through the real route: the given
 *  Origin header (the §2.8 guard's input) and the owner's minted session
 *  cookie. */
async function publicAccessPost(fields: Record<string, string>, origin = ORIGIN): Promise<Response> {
  return fetchUi("/alice/demo/settings/public_access", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      cookie: await ownerSessionHeader(),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** The stored grant row's mode — null when the row is absent (the fresh-repo
 *  state the ACL read treats as 'none'). */
async function storedMode(): Promise<"none" | "read" | null> {
  const row = await drizzle(env.DB)
    .select({ anonymousAccessMode: repoUnits.anonymousAccessMode })
    .from(repoUnits)
    .where(eq(repoUnits.repoId, repo.id))
    .get();
  return row?.anonymousAccessMode ?? null;
}

/** BOTH readers of the git-HTTP ACL seam — the page loader and the landed
 *  `codeUnitAnonymousRead` (the SPEC-0010 §2.6 one-copy rule: page and gate
 *  cannot drift; asserted as a pair so a future fork of either read fails
 *  here). */
async function bothReaders(): Promise<{ page: boolean; acl: boolean }> {
  return {
    page: (await loadRepoPublicAccess(env.DB, repo.id)).codeAnonymousRead,
    acl: await codeUnitAnonymousRead(env.DB, repo.id),
  };
}

// --- the mounted GET route (window-2d b54f709)

describe("the mounted GET route (GET /{owner}/{repo}/settings/public_access)", () => {
  it("404-shells an anonymous GET on the PRIVATE seed before the gate can speak (SPEC-0010 §2.6 — invisible ≡ missing; the tab's existence never leaks)", async () => {
    const res = await fetchUi("/alice/demo/settings/public_access");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("status-page-error"); // the 404 shell
    expect(html).not.toContain(`name="${CODE_UNIT_FORM_KEY}"`); // never the tab's radios
  });

  it("303s an anonymous GET onto the login round-trip once the repo resolves (the settingsGate's own arm — the PUBLIC twin)", async () => {
    await setRepositoryVisibility("public");
    const res = await fetchUi("/alice/demo/settings/public_access");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent("/alice/demo/settings/public_access")}`,
    );
  });

  it("404-shells the signed-in non-admin's GET on the PRIVATE seed before any write (the resolver's invisible-repo 404 — no collaborator arm in page visibility, acl.ts's recorded 'when collaboration lands' deferral)", async () => {
    const res = await fetchUi("/alice/demo/settings/public_access", {
      headers: { cookie: await collaboratorSessionHeader() },
    });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("status-page-error");
    expect(html).not.toContain(`name="${CODE_UNIT_FORM_KEY}"`);
    expect(await storedMode()).toBe("read"); // nothing was written
  });

  it("404-shells the signed-in non-admin's GET at the GATE on the PUBLIC twin (the repo resolves, the reqRepoAdmin tab doesn't — the shell keeps its repo header, whose public badge is the shell's own 'Public Access' label, not this tab)", async () => {
    await setRepositoryVisibility("public");
    const res = await fetchUi("/alice/demo/settings/public_access", {
      headers: { cookie: await collaboratorSessionHeader() },
    });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("status-page-error");
    expect(html).not.toContain(`name="${CODE_UNIT_FORM_KEY}"`);
  });

  it("renders the admin's GET at 200 with the armed radio reflecting the ACL read — page and git-HTTP gate agree on the seam", async () => {
    expect(await bothReaders()).toEqual({ page: true, acl: true }); // the seed's armed grant
    const res = await publicAccessGet();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("repository settings"); // the §2.4.1 pageClass
    expect(html).toContain('class="active item" href="/alice/demo/settings/public_access"');
    expect(html).toContain(`name="${CODE_UNIT_FORM_KEY}" value="anonymous-read" checked`);
    expect(html).not.toContain(`name="${CODE_UNIT_FORM_KEY}" value="not-set" checked`);
  });

  it("renders NOT SET once the grant row is absent — the ACL's absent = none arm through the real route", async () => {
    await env.DB.prepare("DELETE FROM repo_units WHERE repo_id = ?").bind(repo.id).run();
    expect(await bothReaders()).toEqual({ page: false, acl: false });
    const res = await publicAccessGet();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`name="${CODE_UNIT_FORM_KEY}" value="not-set" checked`);
    expect(html).not.toContain(`name="${CODE_UNIT_FORM_KEY}" value="anonymous-read" checked`);
  });
});

// --- the mounted write route (window-2d b54f709)

describe("the mounted write route (POST /{owner}/{repo}/settings/public_access)", () => {
  it("303s an anonymous same-origin POST onto the login round-trip (guard passes, then the gate; nothing written)", async () => {
    await setRepositoryVisibility("public");
    const res = await fetchUi("/alice/demo/settings/public_access", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: ORIGIN,
      },
      body: new URLSearchParams({ [CODE_UNIT_FORM_KEY]: "not-set" }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent("/alice/demo/settings/public_access")}`,
    );
    expect(await storedMode()).toBe("read"); // the armed grant survives
  });

  it("flips OFF through the route: the not-set POST 303s home and BOTH seam readers drop (page loader + codeUnitAnonymousRead)", async () => {
    const res = await publicAccessPost({ [CODE_UNIT_FORM_KEY]: "not-set" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/demo/settings/public_access");
    expect(await bothReaders()).toEqual({ page: false, acl: false });
    expect(await storedMode()).toBe("none");
    const page = await publicAccessGet();
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`name="${CODE_UNIT_FORM_KEY}" value="not-set" checked`);
    expect(html).not.toContain(`name="${CODE_UNIT_FORM_KEY}" value="anonymous-read" checked`);
  });

  it("flips back ON through the route: the anonymous-read POST re-arms BOTH readers (the upsert's re-arm)", async () => {
    expect((await publicAccessPost({ [CODE_UNIT_FORM_KEY]: "not-set" })).status).toBe(303);
    const res = await publicAccessPost({ [CODE_UNIT_FORM_KEY]: "anonymous-read" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/demo/settings/public_access");
    expect(await bothReaders()).toEqual({ page: true, acl: true });
    expect(await storedMode()).toBe("read");
    const page = await publicAccessGet();
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`name="${CODE_UNIT_FORM_KEY}" value="anonymous-read" checked`);
  });

  it("collapses junk form values to not-set (upstream's parsePublicAccessMode refusal — everyone-write and the absent field alike)", async () => {
    const junk = await publicAccessPost({ [CODE_UNIT_FORM_KEY]: "everyone-write" });
    expect(junk.status).toBe(303);
    expect(await bothReaders()).toEqual({ page: false, acl: false });
    expect(await storedMode()).toBe("none");
    const absent = await publicAccessPost({}); // no radio field at all
    expect(absent.status).toBe(303);
    expect(await bothReaders()).toEqual({ page: false, acl: false });
    const page = await publicAccessGet();
    expect(await page.text()).toContain(`name="${CODE_UNIT_FORM_KEY}" value="not-set" checked`);
  });

  it("rejects a cross-origin POST with 403 before any write (sameOriginGuard first)", async () => {
    const res = await publicAccessPost({ [CODE_UNIT_FORM_KEY]: "not-set" }, "https://evil.example");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
    expect(await storedMode()).toBe("read"); // the armed grant survives
    expect(await bothReaders()).toEqual({ page: true, acl: true });
  });
});

// --- the route claim pin (parse ↔ registration — the org-blocked-matrix pin) ----

describe("the route claim pin (the settings family claims exactly the public_access tab)", () => {
  it("parses the Combo shape; misspelled or deeper tails stay unclaimed", () => {
    expect(parseUiRoute("/alice/demo/settings/public_access")).toEqual({
      family: "settings-public-access",
      owner: "alice",
      repo: "demo",
    });
    expect(handlesUiRoute("/alice/demo/settings/public_access")).toBe(true);
    expect(parseUiRoute("/alice/demo/settings/public_access/extra")).toBeNull();
    expect(handlesUiRoute("/alice/demo/settings/public_access/extra")).toBe(false);
    expect(parseUiRoute("/alice/demo/settings/publicaccess")).toBeNull(); // the misspelling
    expect(handlesUiRoute("/alice/demo/settings/publicaccess")).toBe(false);
  });
});
