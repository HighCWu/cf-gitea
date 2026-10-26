/**
 * The org settings HOOKS tab's DEFERRED route-level matrix (the polish wave,
 * after the wave-53 mount 54264ae — pages/org-settings-hooks.tsx over
 * index.ts's orgHooksSettings* handlers): the MINTED-SESSION route arms
 * driven through `uiRouter.fetch()` on the real production path (parse →
 * resolveUiSession → the shared org-teams prologue → load → render — the
 * admin-monitor f790f70 pattern), one fresh org world per test behind
 * per-test table wipes. The wave-53 suite
 * (src/ui/__tests__/pages-wave53-org-settings-hooks.test.ts) keeps the
 * parser families, the DOM contract and the shared-fixture store; this file
 * holds the ROUTE posture:
 *
 *   - anonymous 303s onto the login round-trip on GET list/detail AND on
 *     same-origin POST create/delete (the §2.8 guard passes, then the
 *     signed-in gate fronts the write — nothing written);
 *   - the non-owner 404 shells (a plain member AND a signed-in outsider)
 *     BEFORE any write — the rows stay untouched;
 *   - the owner's create hit/miss (the 303 + the owner-scoped D1 row's
 *     round-trip through the list re-render; the invalid arm re-renders at
 *     200 with the API's 422 message and the CARRIED form — the wave-53
 *     handler's kept-submission contract);
 *   - the detail edit with the HIDDEN-EVENTS preserve (the page's hidden
 *     `events` inputs ride the POST body; the stored subscription survives
 *     the service's UNCONDITIONAL rewrite) — hit and invalid-carried miss;
 *   - the delete hit/miss (the row is gone; an unknown and a foreign-org id
 *     404-shell, existence stays hidden);
 *   - the §2.8 cross-origin 403 before any write on all three write arms;
 *   - the RENAMED-ORG 307 through the shared resolveOrgForRequest seam
 *     (api/services/orgs.ts) over the `user_redirects` table: the path's
 *     first old-name segment rewrites onto the new name with the query
 *     preserved, for the signed-in owner AND for anonymous viewers (the
 *     org resolution precedes the login 303 in the prologue).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { createOwnerHook, hookEventsArray } from "../../api/services/hooks";
import { orgMembers, userRedirects, users, webhooks } from "../../db/schema";
import { locale } from "../locale";
import { uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { UiManifest } from "../manifest";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000); // 2023-11-14T22:13:20Z
const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

/** Tables the fixtures and the write arms touch (children first — the
 *  blocked-users harness's cleanup-list convention; "sessions" explicit
 *  because the route matrix mints session rows per request). */
const FIXTURE_TABLES = [
  "webhook_deliveries",
  "webhooks",
  "user_redirects",
  "org_members",
  "sessions",
  "users",
];

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of FIXTURE_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

/** The route world's REAL rows (the routes resolve through OrgService and the
 *  landed owner-scoped hook arms — nothing is hand-inserted into `webhooks`):
 *  the hookforge org with alice as owner and bob as a plain member, carol's
 *  hookrivals org for the foreign-scope arms, and three seeded hooks (the
 *  edit carrier with branch_filter + push, the doomed delete row, the rival's
 *  foreign row). Ids are captured at seed time — never hardcoded. */
interface HookWorld {
  orgUserId: number; // the org's users-row id — the owner-scope key
  ownerId: number; // alice
  memberId: number; // bob
  outsiderId: number; // carol (owns only hookrivals)
  rivalOrgId: number;
  editHookId: number;
  doomedHookId: number;
  foreignHookId: number;
}

async function seedHookWorld(): Promise<HookWorld> {
  const db = drizzle(env.DB);
  const inserted = await db
    .insert(users)
    .values([
      { username: "alice", usernameLower: "alice", status: "active", createdAt: T0 },
      { username: "bob", usernameLower: "bob", status: "active", createdAt: T0 },
      { username: "carol", usernameLower: "carol", status: "active", createdAt: T0 },
      { username: "hookforge", usernameLower: "hookforge", type: "org", status: "active", createdAt: T0 },
      { username: "hookrivals", usernameLower: "hookrivals", type: "org", status: "active", createdAt: T0 },
    ])
    .returning({ id: users.id })
    .all();
  const [alice, bob, carol, hookforge, hookrivals] = inserted;
  if (alice === undefined || bob === undefined || carol === undefined || hookforge === undefined || hookrivals === undefined) {
    throw new Error("org world seed failed");
  }
  await db
    .insert(orgMembers)
    .values([
      { orgId: hookforge.id, userId: alice.id, role: "owner", createdAt: T0 },
      { orgId: hookforge.id, userId: bob.id, role: "member", createdAt: T0 }, // inside, but no ownership
      { orgId: hookrivals.id, userId: carol.id, role: "owner", createdAt: T0 },
    ])
    .run();

  // The hooks through the LANDED owner-scoped create arm (the API family's
  // service; the same path the page's write calls).
  const editHook = await createOwnerHook(env.DB, hookforge.id, {
    type: "gitea",
    name: "forge ci hook",
    config: { url: "https://hooks.example.test/forge-ci", content_type: "json" },
    active: true,
    branch_filter: "main",
    events: ["push"],
  });
  const doomedHook = await createOwnerHook(env.DB, hookforge.id, {
    type: "gitea",
    name: "forge doomed hook",
    config: { url: "https://hooks.example.test/forge-doomed", content_type: "json" },
    active: false,
  });
  const foreignHook = await createOwnerHook(env.DB, hookrivals.id, {
    type: "gitea",
    name: "rival hook",
    config: { url: "https://hooks.example.test/rival", content_type: "json" },
    active: true,
  });

  return {
    orgUserId: hookforge.id,
    ownerId: alice.id,
    memberId: bob.id,
    outsiderId: carol.id,
    rivalOrgId: hookrivals.id,
    editHookId: editHook.id,
    doomedHookId: doomedHook.id,
    foreignHookId: foreignHook.id,
  };
}

// --- the mounted-route harness (the admin-monitor f790f70 pattern) ------------

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };

const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The real production path: parse → resolveUiSession → the org-teams
 *  prologue → load → render, on the mounted uiRouter with the synthetic
 *  manifest; the execution context is awaited so waitUntil side-effects
 *  settle before assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`${ORIGIN}${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A viewer's minted session cookie header (the real mintSession path, minted
 *  per request — the beforeEach users wipe cascades the sessions table, so a
 *  cross-test cache would go stale; the value is never rendered). */
async function sessionCookie(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** A GET through the mount (`userId: null` is the anonymous arm). */
async function getRoute(path: string, userId: number | null): Promise<Response> {
  return fetchUi(path, { headers: userId === null ? {} : { cookie: await sessionCookie(userId) } });
}

/** A urlencoded POST through the mount (same-origin by default — the
 *  sameOriginGuard's happy path; pass another origin for the 403 arms;
 *  `userId: null` is the anonymous arm). */
async function postRoute(
  path: string,
  userId: number | null,
  fields: Record<string, string>,
  origin: string = ORIGIN,
): Promise<Response> {
  return fetchUi(path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      ...(userId === null ? {} : { cookie: await sessionCookie(userId) }),
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** The 404 fidelity every missing arm shares: the shell answers, never the
 *  hooks pages' content. */
async function expectNotFoundShell(res: Response): Promise<void> {
  expect(res.status).toBe(404);
  const html = await res.text();
  expect(html).toContain("status-page-error"); // the 404 shell
  expect(html).toContain(locale.error404_box_title);
  expect(html).not.toContain("page-content organization settings webhooks"); // never the list
  expect(html).not.toContain("page-content organization settings new webhook"); // never the detail
}

/** The org's whole `webhooks` store (ordered by id — the list read's order),
 *  for the nothing-written / row-survives assertions. */
async function allHooks(): Promise<Array<typeof webhooks.$inferSelect>> {
  return drizzle(env.DB).select().from(webhooks).orderBy(webhooks.id).all();
}

// --- the mounted routes (GET+POST list, GET+POST detail, POST delete) ----------

describe("the mounted org settings hooks routes (the minted-session route-level matrix)", () => {
  let world: HookWorld;

  beforeEach(async () => {
    world = await seedHookWorld();
  });

  // -- the gates (the shared org-teams prologue) -----------------------------

  it("303s an anonymous GET of the list and the detail onto the login round-trip", async () => {
    for (const path of [`/hookforge/settings/hooks`, `/hookforge/settings/hooks/${world.editHookId}`]) {
      const res = await getRoute(path, null);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent(path)}`);
    }
  });

  it("303s an anonymous same-origin create POST onto the login round-trip too (guard passes, then the gate; nothing written)", async () => {
    const res = await postRoute("/hookforge/settings/hooks", null, {
      name: "anon hook",
      payload_url: "https://hooks.example.test/anon",
      content_type: "json",
      secret: "anon-secret",
      active: "on",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/hookforge/settings/hooks")}`);
    expect(await allHooks()).toHaveLength(3); // the three seeds only — the write never ran
  });

  it("303s an anonymous same-origin delete POST onto the login round-trip (the row survives)", async () => {
    const res = await postRoute(`/hookforge/settings/hooks/${world.doomedHookId}/delete`, null, {});
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent(`/hookforge/settings/hooks/${world.doomedHookId}/delete`)}`,
    );
    const rows = await allHooks();
    expect(rows.map((row) => row.id)).toContain(world.doomedHookId); // untouched
  });

  it("404-shells a signed-in non-owner (plain member AND outsider) on GET — before any write", async () => {
    for (const userId of [world.memberId, world.outsiderId]) {
      await expectNotFoundShell(await getRoute("/hookforge/settings/hooks", userId));
      await expectNotFoundShell(await getRoute(`/hookforge/settings/hooks/${world.editHookId}`, userId));
    }
  });

  it("404-shells the non-owner's write POSTs BEFORE the write arms run (RequireOwner fronts all three)", async () => {
    for (const userId of [world.memberId, world.outsiderId]) {
      await expectNotFoundShell(
        await postRoute("/hookforge/settings/hooks", userId, {
          name: "pal hook",
          payload_url: "https://hooks.example.test/pal",
          content_type: "json",
        }),
      );
      await expectNotFoundShell(
        await postRoute(`/hookforge/settings/hooks/${world.editHookId}`, userId, {
          name: "hijacked",
          payload_url: "https://hooks.example.test/hijacked",
          content_type: "json",
          events: "push",
        }),
      );
      await expectNotFoundShell(await postRoute(`/hookforge/settings/hooks/${world.doomedHookId}/delete`, userId, {}));
    }
    const rows = await allHooks();
    expect(rows).toHaveLength(3); // the seeds only
    expect(rows.find((row) => row.id === world.editHookId)!.url).toBe("https://hooks.example.test/forge-ci");
    expect(rows.find((row) => row.id === world.doomedHookId)).toBeDefined(); // never deleted
  });

  // -- the owner's create arms (POST /{org}/settings/hooks) -------------------

  it("the owner's create POST saves owner-scoped and 303s back onto the list (the round-trip renders the row)", async () => {
    const res = await postRoute("/hookforge/settings/hooks", world.ownerId, {
      name: "route created hook",
      payload_url: "https://hooks.example.test/route-created",
      content_type: "json",
      secret: "top-secret",
      active: "on",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/hookforge/settings/hooks");
    const rows = await allHooks();
    const created = rows.find((row) => row.url === "https://hooks.example.test/route-created");
    expect(created).toBeDefined();
    expect(created!.ownerId).toBe(world.orgUserId); // the org's owner scope
    expect(created!.repoId).toBeNull(); // owner-scoped, never a repo row
    expect(created!.name).toBe("route created hook");
    expect(created!.isActive).toBe(true); // the checked box
    expect(created!.secret).toBe("top-secret");
    expect(created!.type).toBe("gitea"); // the single landed provider
    // The list re-render carries the fresh row (the follow-up GET).
    const page = await getRoute("/hookforge/settings/hooks", world.ownerId);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("page-content organization settings webhooks"); // the §2.4.1 discriminator
    expect(html).toContain("route created hook");
    expect(html).toContain(`href="/hookforge/settings/hooks/${created!.id}"`);
  });

  it("the owner's invalid create POST re-renders at 200 with the API's 422 message and the CARRIED form (nothing written)", async () => {
    const res = await postRoute("/hookforge/settings/hooks", world.ownerId, {
      name: "carried name",
      payload_url: "not-a-url",
      content_type: "form",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("page-content organization settings webhooks");
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain("Invalid url"); // checkCreateHookOption's 422 text
    // The wave-53 handler's kept submission: name + payload url + content
    // type ride the re-render.
    expect(html).toContain('value="carried name"');
    expect(html).toContain('value="not-a-url"');
    expect(html).toContain('value="form" selected=""'); // the select's carried arm
    expect(await allHooks()).toHaveLength(3); // nothing written
  });

  // -- the owner's detail GET + the edit arms with the hidden-events preserve --

  it("the owner's detail GET renders the stored values with the hidden events preserve inputs in the form", async () => {
    const res = await getRoute(`/hookforge/settings/hooks/${world.editHookId}`, world.ownerId);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("page-content organization settings new webhook"); // the §2.4.1 discriminator
    expect(html).toContain(`action="/hookforge/settings/hooks/${world.editHookId}"`);
    expect(html).toContain('value="https://hooks.example.test/forge-ci"');
    expect(html).toContain('value="forge ci hook"');
    expect(html).toContain('value="main"'); // the stored branch filter
    // THE preserve inputs: one hidden events input per subscribed event —
    // they are what keeps push alive through the POST's unconditional
    // subscription rewrite.
    expect(html).toContain('type="hidden" name="events" value="push"');
  });

  it("the owner's edit POST applies the form and the hidden events KEEP push in the stored blob (303 back onto the page)", async () => {
    const res = await postRoute(`/hookforge/settings/hooks/${world.editHookId}`, world.ownerId, {
      name: "forge ci hook renamed",
      payload_url: "https://hooks.example.test/forge-ci-v2",
      content_type: "form",
      branch_filter: "release/*",
      events: "push", // the hidden inputs' re-submission
      active: "on",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/hookforge/settings/hooks/${world.editHookId}`);
    const row = (await drizzle(env.DB).select().from(webhooks).where(eq(webhooks.id, world.editHookId)).get())!;
    expect(row.url).toBe("https://hooks.example.test/forge-ci-v2");
    expect(row.name).toBe("forge ci hook renamed");
    expect(row.contentType).toBe(2); // form (ToHookContentType: json=1, form=2)
    expect(row.isActive).toBe(true);
    // The subscription rewrite is UNCONDITIONAL in the service — push survives
    // ONLY because the hidden inputs rode the POST body (the preserve).
    expect(hookEventsArray(row.events)).toContain("push");
    expect((JSON.parse(row.events) as { branch_filter?: string }).branch_filter).toBe("release/*");
    // The follow-up page renders the fresh values.
    const page = await getRoute(`/hookforge/settings/hooks/${world.editHookId}`, world.ownerId);
    expect(await page.text()).toContain('value="https://hooks.example.test/forge-ci-v2"');
  });

  it("the owner's invalid edit POST re-renders at 200 with the message, the kept submission AND the hidden events inputs (row untouched)", async () => {
    const res = await postRoute(`/hookforge/settings/hooks/${world.editHookId}`, world.ownerId, {
      name: "kept name",
      payload_url: "also not a url",
      content_type: "json",
      branch_filter: "main",
      events: "push",
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("page-content organization settings new webhook");
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain("Invalid url");
    expect(html).toContain('value="kept name"'); // the carried submission
    expect(html).toContain('value="also not a url"');
    expect(html).toContain('value="main"');
    expect(html).toContain('type="hidden" name="events" value="push"'); // the preserve rides the re-render too
    const row = (await drizzle(env.DB).select().from(webhooks).where(eq(webhooks.id, world.editHookId)).get())!;
    expect(row.url).toBe("https://hooks.example.test/forge-ci"); // untouched
    expect(row.contentType).toBe(1);
    expect(hookEventsArray(row.events)).toContain("push");
  });

  // -- the delete arms ---------------------------------------------------------

  it("the owner's delete POST removes the row and 303s onto the list", async () => {
    const res = await postRoute(`/hookforge/settings/hooks/${world.doomedHookId}/delete`, world.ownerId, {});
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/hookforge/settings/hooks");
    expect((await allHooks()).map((row) => row.id)).not.toContain(world.doomedHookId);
    // The follow-up list no longer renders the deleted row.
    const page = await getRoute("/hookforge/settings/hooks", world.ownerId);
    expect(await page.text()).not.toContain("forge doomed hook");
  });

  it("the delete miss 404-shells an unknown id and a foreign-org id — existence stays hidden, the foreign row survives", async () => {
    for (const id of [999999, world.foreignHookId]) {
      await expectNotFoundShell(await postRoute(`/hookforge/settings/hooks/${id}/delete`, world.ownerId, {}));
    }
    // The same fidelity on the DETAIL GET: the foreign-org id is an ordinary
    // miss (the owner-scoped lookup keys on the org).
    await expectNotFoundShell(await getRoute(`/hookforge/settings/hooks/${world.foreignHookId}`, world.ownerId));
    const rival = (await drizzle(env.DB).select().from(webhooks).where(eq(webhooks.ownerId, world.rivalOrgId)).all()).at(0);
    expect(rival).toBeDefined();
    expect(rival!.url).toBe("https://hooks.example.test/rival"); // untouched
    expect(await allHooks()).toHaveLength(3); // the three seeds — nothing was deleted
  });

  // -- the §2.8 guard -----------------------------------------------------------

  it("rejects a cross-origin write POST with 403 before any write (sameOriginGuard first, all three arms)", async () => {
    for (const [path, fields] of [
      ["/hookforge/settings/hooks", { name: "evil hook", payload_url: "https://hooks.example.test/evil", content_type: "json" }],
      [`/hookforge/settings/hooks/${world.editHookId}`, { name: "evil", payload_url: "https://hooks.example.test/evil", content_type: "json", events: "push" }],
      [`/hookforge/settings/hooks/${world.doomedHookId}/delete`, {}],
    ] as const) {
      const res = await postRoute(path, world.ownerId, fields, "https://evil.example");
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("cross-origin request rejected");
    }
    const rows = await allHooks();
    expect(rows).toHaveLength(3); // the seeds only
    expect(rows.find((row) => row.id === world.editHookId)!.url).toBe("https://hooks.example.test/forge-ci");
    expect(rows.find((row) => row.id === world.doomedHookId)).toBeDefined(); // never deleted
  });

  // -- the renamed-org seam ------------------------------------------------------

  it("307s a renamed org onto the new name through the shared seam — path rewritten, query preserved, anon included", async () => {
    // The rename alias (the landed user_redirects table — owner renames write
    // here; the org target stays public, so the seam's coarse RedirectToUser
    // gate passes for anonymous viewers too).
    await drizzle(env.DB)
      .insert(userRedirects)
      .values({ lowerName: "forgeold", redirectUserId: world.orgUserId })
      .run();
    // Anonymous: the seam precedes the login 303 in the prologue.
    const anon = await getRoute("/forgeold/settings/hooks", null);
    expect(anon.status).toBe(307);
    expect(anon.headers.get("location")).toBe("/hookforge/settings/hooks");
    // The owner with a query string: first-occurrence rewrite + query kept.
    const owner = await getRoute("/forgeold/settings/hooks?tab=hooks", world.ownerId);
    expect(owner.status).toBe(307);
    expect(owner.headers.get("location")).toBe("/hookforge/settings/hooks?tab=hooks");
    // The detail shape rewrites its old-name segment the same way.
    const detail = await getRoute(`/forgeold/settings/hooks/${world.editHookId}`, world.ownerId);
    expect(detail.status).toBe(307);
    expect(detail.headers.get("location")).toBe(`/hookforge/settings/hooks/${world.editHookId}`);
    // The target answers 200 behind the new name.
    const target = await getRoute("/hookforge/settings/hooks", world.ownerId);
    expect(target.status).toBe(200);
    expect(await target.text()).toContain("page-content organization settings webhooks");
  });
});
