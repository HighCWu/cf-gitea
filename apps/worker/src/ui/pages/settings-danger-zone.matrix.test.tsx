/**
 * The repo-settings DANGER ZONE's deferred matrix (the review R2 arms —
 * pages/settings.tsx's options.tmpl:804-870 port), driven through the REAL
 * routes on the settings-basics matrix's minted-session pattern —
 *
 *   - the render: the `Danger Zone` header, the transfer row (start
 *     disclosure with `action=transfer` + the typed full name +
 *     `new_owner_name`), the delete row (`action=delete`, typed full name),
 *     and the pending-transfer banner swap (`transfer_started %s` + the
 *     abort form, the start disclosure gone);
 *   - the transfer POST ladder through the registered POST /settings
 *     handler's action dispatch: the happy path files the pending row (303
 *     onto the settings URL — upstream's redirect target; the row's doer is
 *     the repo OWNER per the documented degradation, exact for the
 *     user-owned fixture), the confirm-name / unknown-owner / collision /
 *     blocked / self-transfer refusals re-render with the exact upstream
 *     texts and write NOTHING;
 *   - the cancel_transfer ladder: the no-pending refusal
 *     (transfer_abort_invalid verbatim) and the happy delete of the pending
 *     row;
 *   - the delete ladder: the confirm-name refusal (nothing deleted) and the
 *     happy D1-cascade delete — 303 onto the settings URL (the DOCUMENTED
 *     divergence: upstream redirects onto the owner dashboard, a target the
 *     registered handler cannot express yet), the rows gone, a follow-up
 *     GET 404-shelling;
 *   - the delete-wiki arm (options.tmpl:873-885 + #delete-wiki-modal): the
 *     wiki row renders only for wiki-enabled repos (has_wiki — the unit
 *     CanRead gate's landed reduction) with the dangerous_operation_form
 *     confirm shape, the confirm-name refusal writes nothing through the
 *     real route, the unthreaded-engine-bindings refusal refuses BEFORE any
 *     write at the seam, and the happy sweep (services/wiki.ts deleteWiki)
 *     drives applyRepoBasics with the env tail — pages gone, has_wiki reset,
 *     the applied outcome that 303s onto the settings URL;
 *   - the unknown-action refusal, the gate-first non-admin 404, and the
 *     guard-first cross-origin 403.
 *
 * The route registration lives in ui/index.ts (outside this module's
 * ownership); the whole write path under test delegates to pages/
 * settings.tsx's parseRepoBasicsForm + applyRepoBasics + the
 * loadRepoBasics pending read.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { repoTransfer, repositories, users } from "../../db/schema";
import { loadRepoSettings } from "../../api/services/repo-settings";
import { createWikiPage, listWikiPages, readWikiPage, type WikiDoer } from "../../services/wiki";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { RepoRow } from "../ui-context";
import type { UiManifest } from "../manifest";
import { applyRepoBasics, parseRepoBasicsForm } from "./settings";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

let aliceId: number;
let bobId: number;
let repo: RepoRow;

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["repo_redirects", "repo_settings", "repo_mirrors", "repo_transfer", "user_blocking", "issues", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  aliceId = await insertUser("alice", "Alice Doe");
  bobId = await insertUser("bob", "Bob Doe");
  repo = await seedRepo("demo");
});

async function insertUser(username: string, displayName: string, isAdmin = false): Promise<number> {
  const result = await env.DB.prepare(
    "INSERT INTO users (username, username_lower, display_name, is_admin, created_at) VALUES (?, ?, ?, ?, unixepoch())",
  )
    .bind(username, username, displayName, isAdmin ? 1 : 0)
    .run();
  return result.meta.last_row_id;
}

async function seedRepo(slug: string): Promise<RepoRow> {
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-1', 'repo-1', 'alice', ?, ?, 'main', 'public', unixepoch())",
  )
    .bind(aliceId, slug)
    .run();
  const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "repo-1")).get();
  if (row === undefined) throw new Error("fixture repository missing");
  return row;
}

/** A second repo under bob (the collision arm's occupant). */
async function seedBobRepo(slug: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, created_at) VALUES ('repo-2', 'repo-2', 'bob', ?, ?, 'main', 'public', unixepoch())",
  )
    .bind(bobId, slug)
    .run();
}

/** The pending-transfer row, filed as upstream's CreatePendingRepository
 *  Transfer would (the recipient bob; the doer alice). */
async function seedPendingTransfer(): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO repo_transfer (repo_id, doer_id, new_owner_id, created_at) VALUES ('repo-1', ?, ?, unixepoch())",
  )
    .bind(aliceId, bobId)
    .run();
}

/** The block edge (block.go's pair): bob blocks alice — the transfer
 *  ladder's blocked arm probe input. */
async function seedBlock(blockerId: number, blockeeId: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO user_blocking (blocker_id, blockee_id, created_at) VALUES (?, ?, unixepoch())",
  )
    .bind(blockerId, blockeeId)
    .run();
}

// --- the mounted-route harness (the settings-basics minted-session pattern) ----

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

async function ownerSessionHeader(): Promise<string> {
  return sessionHeader(aliceId);
}

/** The admin's urlencoded POST to the settings form through the real route
 *  (the danger arms ride the SAME registered handler as the basics —
 *  settings-basics.matrix's basicsPost with the action field). */
async function settingsPost(
  fields: Record<string, string> = {},
  origin = ORIGIN,
  cookie: Promise<string> | null = ownerSessionHeader(),
): Promise<Response> {
  const cookieHeader = await (cookie ?? Promise.resolve(null));
  return fetchUi("/alice/demo/settings", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      ...(cookieHeader === null ? {} : { cookie: cookieHeader }),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** The pending-transfer row as stored (the transfer arms' read-back). */
async function storedPendingTransfer(): Promise<{ doerId: number; newOwnerId: number } | undefined> {
  const row = await drizzle(env.DB)
    .select({ doerId: repoTransfer.doerId, newOwnerId: repoTransfer.newOwnerId })
    .from(repoTransfer)
    .get();
  return row;
}

async function repoRowExists(): Promise<boolean> {
  const row = await drizzle(env.DB).select({ id: repositories.id }).from(repositories).where(eq(repositories.id, repo.id)).get();
  return row !== undefined;
}

// --- the form parse (the danger fields ride the basics parser) -----------------

describe("parseRepoBasicsForm (the danger-zone discriminator fields)", () => {
  it("action parses verbatim; absent = the merged basics save; new_owner_name trims", () => {
    expect(parseRepoBasicsForm(new URLSearchParams({ repo_name: "demo" })).action).toBe("");
    expect(parseRepoBasicsForm(new URLSearchParams({ action: "transfer", new_owner_name: " bob " })).action).toBe("transfer");
    expect(parseRepoBasicsForm(new URLSearchParams({ action: "transfer", new_owner_name: " bob " })).newOwnerName).toBe("bob");
    expect(parseRepoBasicsForm(new URLSearchParams({ action: "delete" })).newOwnerName).toBe("");
  });
});

// --- the render ----------------------------------------------------------------

describe("the danger-zone render (GET /{owner}/{repo}/settings)", () => {
  it("renders the Danger Zone section: the transfer row + the delete row with typed-name confirmations", async () => {
    const res = await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<h4 class="ui top attached error header">Danger Zone</h4>');
    // The transfer row: the plain body + the start disclosure (hidden
    // action=transfer, the typed FULL name, new_owner_name).
    expect(html).toContain("Transfer this repository to a user or to an organization for which you have administrator rights.");
    expect(html).toContain('<input type="hidden" name="action" value="transfer"/>');
    expect(html).toContain('<span class="tw-text-red">alice/demo</span>');
    expect(html).toContain('<input id="new_owner_name" name="new_owner_name" required=""/>');
    // The delete row: hidden action=delete + its own typed-name input.
    expect(html).toContain("Deleting a repository is permanent and cannot be undone.");
    expect(html).toContain('<input type="hidden" name="action" value="delete"/>');
    expect(html).toContain('<input id="delete_repo_name" name="repo_name" required=""/>');
    expect(html).toContain("Delete Repository");
    // No pending row: no abort form.
    expect(html).not.toContain('value="cancel_transfer"');
  });

  it("a pending transfer swaps in the banner body + the abort form and retires the start disclosure", async () => {
    await seedPendingTransfer();
    const res = await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    // The banner body (hono escapes the quotes in the text node — the pin
    // is the rendered bytes).
    expect(html).toContain('This repository has been marked for transfer and awaits confirmation from &quot;Bob Doe&quot;');
    expect(html).toContain('<input type="hidden" name="action" value="cancel_transfer"/>');
    expect(html).toContain("Cancel transfer");
    expect(html).not.toContain('<input type="hidden" name="action" value="transfer"/>');
    expect(html).not.toContain('name="new_owner_name"');
  });
});

// --- the transfer ladder -------------------------------------------------------

describe("the transfer POST ladder (action=transfer)", () => {
  it("files the pending row and 303s onto the settings URL; the doer records the repo owner (the documented degradation)", async () => {
    const res = await settingsPost({ action: "transfer", repo_name: "alice/demo", new_owner_name: "bob" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/demo/settings"); // upstream repo.Link()+"/settings"
    expect(await storedPendingTransfer()).toEqual({ doerId: aliceId, newOwnerId: bobId });
    // The repo stays usable (§2.5.4): the row + the slug stand.
    expect(await repoRowExists()).toBe(true);
    // The GET now shows the banner + the abort form.
    const page = await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } });
    expect(await page.text()).toContain('awaits confirmation from &quot;Bob Doe&quot;');
  });

  it("refuses a wrong confirmation name with the exact text and files nothing", async () => {
    const res = await settingsPost({ action: "transfer", repo_name: "demo", new_owner_name: "bob" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(
      '<div class="ui negative message">The repository name you entered is incorrect.</div>',
    );
    expect(await storedPendingTransfer()).toBeUndefined();
  });

  it("refuses an unknown new owner with the exact text and files nothing", async () => {
    const res = await settingsPost({ action: "transfer", repo_name: "alice/demo", new_owner_name: "ghost" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div class="ui negative message">The new owner name is not valid.</div>');
    expect(await storedPendingTransfer()).toBeUndefined();
  });

  it("refuses a self-transfer with the landed service text (the API arm's 422 divergence)", async () => {
    const res = await settingsPost({ action: "transfer", repo_name: "alice/demo", new_owner_name: "ALICE" }); // the lower_name lookup
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(
      '<div class="ui negative message">repository is already owned by that owner</div>',
    );
    expect(await storedPendingTransfer()).toBeUndefined();
  });

  it("refuses a colliding destination with upstream's new_owner_has_same_repo text and files nothing", async () => {
    await seedBobRepo("demo"); // bob already owns bob/demo
    const res = await settingsPost({ action: "transfer", repo_name: "alice/demo", new_owner_name: "bob" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(
      '<div class="ui negative message">The new owner already has a repository with same name. Please choose another name.</div>',
    );
    expect(await storedPendingTransfer()).toBeUndefined();
  });

  it("refuses when the block graph says so — the doer blocked by the new owner", async () => {
    await seedBlock(bobId, aliceId); // bob blocks alice (the doer side)
    const res = await settingsPost({ action: "transfer", repo_name: "alice/demo", new_owner_name: "bob" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(
      "<div class=\"ui negative message\">Cannot transfer repository because you are blocked by the new owner.</div>",
    );
    expect(await storedPendingTransfer()).toBeUndefined();

    // The mirror edge: the new owner blocked by the current owner — same refusal.
    await env.DB.prepare("DELETE FROM user_blocking").run();
    await seedBlock(aliceId, bobId);
    const res2 = await settingsPost({ action: "transfer", repo_name: "alice/demo", new_owner_name: "bob" });
    expect(res2.status).toBe(200);
    expect(await res2.text()).toContain("Cannot transfer repository because you are blocked by the new owner.");
    expect(await storedPendingTransfer()).toBeUndefined();
  });
});

// --- the cancel ladder ----------------------------------------------------------

describe("the cancel_transfer POST ladder", () => {
  it("refuses a cancel with no pending row (transfer_abort_invalid verbatim)", async () => {
    const res = await settingsPost({ action: "cancel_transfer" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(
      "<div class=\"ui negative message\">You cannot cancel a non existent repository transfer.</div>",
    );
  });

  it("deletes the pending row and 303s onto the settings URL; the start disclosure returns", async () => {
    await seedPendingTransfer();
    const res = await settingsPost({ action: "cancel_transfer" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/demo/settings");
    expect(await storedPendingTransfer()).toBeUndefined();
    const page = await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } });
    expect(await page.text()).toContain('<input type="hidden" name="action" value="transfer"/>'); // the start arm back
  });
});

// --- the delete ladder -----------------------------------------------------------

describe("the delete POST ladder (action=delete)", () => {
  it("refuses a wrong confirmation name with the exact text and deletes nothing", async () => {
    const res = await settingsPost({ action: "delete", repo_name: "wrong-name" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(
      '<div class="ui negative message">The repository name you entered is incorrect.</div>',
    );
    expect(await repoRowExists()).toBe(true);
  });

  it("deletes the repository (the D1 cascade) and 303s onto the settings URL — the documented divergence: that URL now 404-shells", async () => {
    const res = await settingsPost({ action: "delete", repo_name: "alice/demo" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/demo/settings"); // upstream targets the owner dashboard — the registered handler cannot express it yet
    expect(await repoRowExists()).toBe(false);
    // The follow-up GET lands the 404 shell (the divergence's landing).
    const gone = await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } });
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain("status-page-error");
  });
});

// --- the delete-wiki arm (the whole-wiki delete — options.tmpl:873-885) -----------
//
// The render + refusal arms drive the REAL route (the dispatch reaches
// applyRepoDangerAction through the registered POST handler). The happy arm
// drives the exported applyRepoBasics directly WITH the engine bindings on
// the optional `env` tail, because the registered settingsSubmit does not
// thread c.env yet — the module's reported one-line ui/index.ts follow-up
// (the doer thread's twin); until that lands, the unthreaded real-route POST
// refuses BEFORE any write, which the second ladder test pins at the seam.

describe("the delete-wiki render arm (the wiki danger row)", () => {
  it("renders the wiki row with the typed-name confirm for a wiki-enabled repo, between transfer and delete", async () => {
    const res = await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    // The row (has_wiki defaults true — the wiki-unit CanRead gate's landed
    // reduction) + the #delete-wiki-modal's notice line and confirm shape.
    expect(html).toContain("Deleting repository wiki data is permanent and cannot be undone.");
    expect(html).toContain("- This will permanently delete and disable the repository wiki for alice/demo.");
    expect(html).toContain('<input type="hidden" name="action" value="delete-wiki"/>');
    expect(html).toContain('<input id="delete_wiki_repo_name" name="repo_name" required=""/>');
    expect(html).toContain("Delete Wiki Data");
    // Upstream order: the wiki row sits between the transfer and delete rows.
    const wikiAt = html.indexOf('value="delete-wiki"');
    const deleteAt = html.indexOf('value="delete"');
    expect(wikiAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(wikiAt);
  });

  it("renders nothing for a wiki-disabled repo (has_wiki=0)", async () => {
    await env.DB.prepare("INSERT INTO repo_settings (repo_id, has_wiki) VALUES ('repo-1', 0)").run();
    const res = await fetchUi("/alice/demo/settings", { headers: { cookie: await ownerSessionHeader() } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('value="delete-wiki"');
    expect(html).not.toContain("Deleting repository wiki data is permanent");
  });
});

describe("the delete-wiki POST ladder (action=delete-wiki)", () => {
  const WIKI_DOER: WikiDoer = { name: "alice", email: "alice@noreply.test.local" };

  it("refuses a wrong confirmation name through the real route with the exact text and writes nothing", async () => {
    const res = await settingsPost({ action: "delete-wiki", repo_name: "demo" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(
      '<div class="ui negative message">The repository name you entered is incorrect.</div>',
    );
    expect((await loadRepoSettings(env.DB, repo.id)).hasWiki).toBe(true);
  });

  it("refuses BEFORE any write when the engine bindings are not threaded (the unthreaded registration)", async () => {
    const result = await applyRepoBasics(
      env.DB,
      repo,
      parseRepoBasicsForm(new URLSearchParams({ action: "delete-wiki", repo_name: "alice/demo" })),
    );
    expect(result).toEqual({
      outcome: "invalid",
      message: "Wiki deletion is unavailable because the repository storage is unreachable.",
    });
    expect((await loadRepoSettings(env.DB, repo.id)).hasWiki).toBe(true);
  });

  it("deletes the whole wiki through the threaded env: pages gone, flag reset, applied outcome", async () => {
    const ownerRow = await drizzle(env.DB).select().from(users).where(eq(users.id, aliceId)).get();
    if (ownerRow === undefined) throw new Error("alice row missing");
    const pair = { repo, owner: ownerRow };
    const encoder = new TextEncoder();
    await createWikiPage(env, pair, WIKI_DOER, { title: "Home", content: encoder.encode("# Home\n"), message: "" }, ORIGIN);
    await createWikiPage(env, pair, WIKI_DOER, { title: "Extras", content: encoder.encode("# E\n"), message: "" }, ORIGIN);
    expect((await listWikiPages(env, pair, 1, 30, ORIGIN)).pages.length).toBe(2);
    expect((await loadRepoSettings(env.DB, repo.id)).hasWiki).toBe(true);

    const result = await applyRepoBasics(
      env.DB,
      repo,
      parseRepoBasicsForm(new URLSearchParams({ action: "delete-wiki", repo_name: "alice/demo" })),
      { id: aliceId, isAdmin: false },
      env,
    );
    expect(result).toEqual({ outcome: "applied", slug: "demo" }); // the 303's source outcome
    expect((await loadRepoSettings(env.DB, repo.id)).hasWiki).toBe(false);
    const after = await listWikiPages(env, pair, 1, 30, ORIGIN);
    expect(after.pages).toEqual([]);
    expect(after.totalEntries).toBe(0);
    expect(await readWikiPage(env, pair, "Home", ORIGIN)).toBeNull();
    expect(await readWikiPage(env, pair, "Extras", ORIGIN)).toBeNull();
    // The repository row itself is untouched (a wiki delete is not a delete).
    expect(await repoRowExists()).toBe(true);
  });
});

// --- the dispatch tail + the shared route posture ---------------------------------

describe("the dispatch tail + the shared route posture", () => {
  it("an unknown action refuses inline with nothing written (upstream answers ctx.NotFound)", async () => {
    const res = await settingsPost({ action: "bogus", repo_name: "alice/demo" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div class="ui negative message">Unknown settings action.</div>');
    expect(await repoRowExists()).toBe(true);
    expect(await storedPendingTransfer()).toBeUndefined();
  });

  it("a bare action-less POST still runs the basics ladder (the merged form's posture — action dispatch is additive)", async () => {
    const res = await settingsPost({ repo_name: "demo", description: "still the basics path" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/demo/settings");
    expect(await repoRowExists()).toBe(true);
    expect(await storedPendingTransfer()).toBeUndefined();
  });

  it("the gate fronts the danger arms: a signed-in non-admin's delete POST 404-shells before any write", async () => {
    const res = await settingsPost({ action: "delete", repo_name: "alice/demo" }, ORIGIN, sessionHeader(bobId));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
    expect(await repoRowExists()).toBe(true);
  });

  it("the guard fronts the danger arms: a cross-origin delete POST 403s before any write", async () => {
    const res = await settingsPost({ action: "delete", repo_name: "alice/demo" }, "https://evil.example");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
    expect(await repoRowExists()).toBe(true);
  });
});

// --- the route claim pin (the danger arms ride the bare /settings family) ---------

describe("the route claim pin", () => {
  it("the danger arms post to the SAME registered /settings tail — no new route", () => {
    expect(parseUiRoute("/alice/demo/settings")).toEqual({ family: "settings", owner: "alice", repo: "demo" });
    expect(handlesUiRoute("/alice/demo/settings")).toBe(true);
    // Upstream's action switch posts to the page URL; there is no
    // /settings/delete-style literal for this module.
    expect(parseUiRoute("/alice/demo/settings/delete")).toBeNull();
  });
});
