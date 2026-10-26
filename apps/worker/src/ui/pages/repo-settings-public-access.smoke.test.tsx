/**
 * The repo settings public-access tab's SMOKE test (PORT-FIRST — ONE happy
 * path, the repo-settings-deploy-keys.smoke.test.tsx harness): the seeded
 * private repo (owner + collaborator + org-team rows, so the test also proves
 * this page is driven by repo_units — the collaborator/team graph is the
 * collaboration page's data and renders nothing here) renders the Code unit's
 * public-access row with the Anonymous Read arm armed, and the page's write
 * flips the stored grant the git-HTTP ACL consumes. The module is driven
 * directly over real D1 (no route yet — the HANDOFF NOTE in the module
 * header).
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { repoUnits, repositories } from "../../db/schema";
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
