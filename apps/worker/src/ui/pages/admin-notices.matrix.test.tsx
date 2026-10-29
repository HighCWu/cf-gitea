/**
 * The ADMIN NOTICES page's matrix (SPEC-0018 §3.1/§6 — the admin-dashboard
 * harness: the module's load/render/write seams over real D1, generated
 * migrations in beforeAll, hono/jsx renderToString, and the MOUNTED route
 * arms driven through `uiRouter.fetch()` with minted sessions).
 *
 * Covered here:
 *   - the LOADER: the paged DESC read (25/page, the id-DESC tiebreak), the
 *     total, the `more` flag, the page floor;
 *   - the RENDER: notice.tmpl's row shape (the checkbox, ID, the localized
 *     type label, the description, the AbsoluteShort created date, the inert
 *     Op. marker — never a dead link), the two §5.8 always-present forms,
 *     the no-results arm, the nav fold (the top-level System Notices item,
 *     active on this page);
 *   - the MOUNTED ROUTE ARMS: the adminPagePrologue gate matrix (anonymous →
 *     the login 303, signed-in non-admin → the 404 shell, site admin → 200),
 *     the §5.4 delete arm through the sameOriginGuard (the junk-ids no-op
 *     success, the re-render-with-flash at 200, the cross-origin 403 before
 *     the gate), the empty arm, and the POST-only shapes' 405 GET twins.
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { ADMIN_NOTICES_PAGE_SIZE, recordNotice, countNotices } from "../../services/notices";
import { uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  AdminNoticesPage,
  adminNoticesLocale,
  loadAdminNoticesData,
  noticeTypeLabel,
  renderAdminNoticesPage,
} from "./admin-notices";

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

async function insertNotice(description: string, type: 1 | 2 = 1, at: Date = T0): Promise<void> {
  await recordNotice(env.DB, { type, description, now: at });
}

async function load(search: string | URLSearchParams) {
  return loadAdminNoticesData(env.DB, typeof search === "string" ? new URLSearchParams(search) : search);
}

function render(data: Awaited<ReturnType<typeof load>>, flash: { kind: "positive" | "negative"; text: string } | null = null): string {
  return renderToString(<AdminNoticesPage ctx={ctx} data={data} flash={flash} />);
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  // system_notices: the loader/DOM fixtures. users+sessions: the minted-
  // session route arms (the session.test.ts cleanup list's auth half).
  for (const table of ["system_notices", "users", "sessions"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the loader ---------------------------------------------------------------

describe("loadAdminNoticesData (notice.go:24-43 over services/notices)", () => {
  it("answers the paged DESC read with the total, the page, and the more flag", async () => {
    for (let i = 0; i < ADMIN_NOTICES_PAGE_SIZE + 2; i++) {
      await insertNotice(`n${i}`, 1, new Date(T0.getTime() + i * 1000));
    }
    const page1 = await load("");
    expect(page1.total).toBe(ADMIN_NOTICES_PAGE_SIZE + 2);
    expect(page1.page).toBe(1);
    expect(page1.items).toHaveLength(ADMIN_NOTICES_PAGE_SIZE);
    expect(page1.items[0]!.description).toBe("n26"); // newest first (n0..n26)
    expect(page1.more).toBe(true);
    const page2 = await load("page=2");
    expect(page2.items).toHaveLength(2);
    expect(page2.items[0]!.description).toBe("n1"); // the DESC window continues
    expect(page2.more).toBe(false);
  });

  it("the junk page param floors onto 1 (the shared parsePageNumber)", async () => {
    await insertNotice("only");
    expect((await load("page=junk")).page).toBe(1);
    expect((await load("page=0")).page).toBe(1);
    expect((await load("page=-3")).page).toBe(1);
    expect((await load("")).items).toHaveLength(1);
  });

  it("an empty table answers total 0 with no items (the §5.8 posture)", async () => {
    const data = await load("");
    expect(data.total).toBe(0);
    expect(data.items).toHaveLength(0);
    expect(data.more).toBe(false);
  });
});

// --- the DOM --------------------------------------------------------------------

describe("the admin notices DOM (templates/admin/notice.tmpl at the pin)", () => {
  it("renders the pageClass, the header with the total, and the six-column row shape", async () => {
    await insertNotice("repo-purge for r_42 dead-lettered after 5 attempts: boom", 1, T0);
    await insertNotice("audit-retention dead-lettered after 5 attempts: boom", 2, T0);
    const data = await load("");
    const html = render(data);
    expect(html).toContain('class="page-content admin notice"'); // notice.tmpl:1's own dict
    expect(html).toContain(`>${adminNoticesLocale.systemNoticeList} (${adminNoticesLocale.total.replace("%d", "2")})</h4>`);
    expect(html).toContain('name="ids[]"'); // the per-row checkboxes
    expect(html).toContain(`<td>${data.items[0]!.id}</td>`); // the ID cell
    expect(html).toContain(`>${noticeTypeLabel(1)}</td>`); // "Repository" — plain text, exactly upstream
    expect(html).toContain(`>${noticeTypeLabel(2)}</td>`); // "Task"
    expect(html).toContain("repo-purge for r_42 dead-lettered after 5 attempts: boom");
    expect(html).toContain('<span class="notice-description">');
    expect(html).toContain(adminNoticesLocale.colCreated); // the Created header
    expect(html).toContain('<th scope="col">'); // the scoped thead
  });

  it("the two write forms render unconditionally — populated AND empty (§5.8)", async () => {
    const emptyHtml = render(await load(""));
    expect(emptyHtml).toContain('action="/-/admin/notices/delete"');
    expect(emptyHtml).toContain('action="/-/admin/notices/empty"');
    expect(emptyHtml).toContain(`>${adminNoticesLocale.deleteSelected}`); // the submit text
    expect(emptyHtml).toContain(adminNoticesLocale.deleteAll);
    expect(emptyHtml).toContain('class="no-results-row"');
    expect(emptyHtml).toContain('colspan="6"');
    expect(emptyHtml).toContain(adminNoticesLocale.noResults);

    await insertNotice("still-forms-here", 1, T0);
    const html = render(await load(""));
    expect(html).not.toContain('class="no-results-row"');
    expect(html).toContain('action="/-/admin/notices/delete"');
    expect(html).toContain('action="/-/admin/notices/empty"');
  });

  it("the Op. cell is the inert marker — the octicon-note glyph, never a dead link", async () => {
    await insertNotice("x", 1, T0);
    const html = render(await load(""));
    expect(html).toContain('class="svg octicon-note"'); // the pinned bytes render
    expect(html).not.toContain('href="#"'); // no JS-modal dead link (notice.tmpl:26's arm)
    expect(html).toContain(adminNoticesLocale.viewDetailTitle); // the title'd span
  });

  it("the flash arm renders the POST answer banner (the no-JS re-render idiom)", async () => {
    await insertNotice("x", 1, T0);
    const html = render(await load(""), { kind: "positive", text: adminNoticesLocale.deleteSuccess });
    expect(html).toContain(`<div class="ui positive message">${adminNoticesLocale.deleteSuccess}</div>`);
    expect(render(await load("")).includes("ui positive message")).toBe(false);
  });

  it("the pager renders Older onto page 2 and no Newer on page 1", async () => {
    for (let i = 0; i < ADMIN_NOTICES_PAGE_SIZE + 1; i++) {
      await insertNotice(`p${i}`, 1, new Date(T0.getTime() + i * 1000));
    }
    const html = render(await load(""));
    expect(html).toContain(">Older<");
    expect(html).toContain('href="/-/admin/notices?page=2"');
    expect(html).not.toContain(">Newer<");
  });

  it("the full-document render path matches the component path", async () => {
    await insertNotice("twin", 1, T0);
    const html = renderAdminNoticesPage(ctx, await load(""));
    expect(html).toContain('class="page-content admin notice"');
    expect(html).toContain("twin");
  });
});

// --- the mounted route arms (the SPEC-0018 mount, driven through uiRouter.fetch) --

type NoticesUiTestEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };

const noticesAssets: UiAssetsFetcher = {
  fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })),
};

const noticesUiEnv: NoticesUiTestEnv = { ...env, ASSETS: noticesAssets };

describe("the mounted /-/admin/notices route arms (SPEC-0018 §3.1)", () => {
  /** The route gate's two non-anonymous principals: the site admin (user 1)
   *  and a signed-in plain member (user 2 — AdminRequired's 404 arm). */
  beforeEach(async () => {
    await env.DB
      .prepare(
        "INSERT INTO users (id, username, username_lower, display_name, is_admin, created_at) VALUES " +
          "(1, 'admin', 'admin', 'Site Admin', 1, unixepoch()), " +
          "(2, 'member', 'member', 'Plain Member', 0, unixepoch())",
      )
      .run();
    await insertNotice("repo-purge for r_42 dead-lettered after 5 attempts: boom", 1, T0);
    await insertNotice("audit-retention dead-lettered after 5 attempts: boom", 2, T0);
  });

  async function getNotices(cookie: string | null): Promise<Response> {
    return uiRouter.fetch(
      new Request(`${ORIGIN}/-/admin/notices`, {
        headers: cookie === null ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      }),
      noticesUiEnv,
    );
  }

  async function postNotices(
    path: string,
    fields: URLSearchParams,
    cookie: string,
    overrides: { origin?: string } = {},
  ): Promise<Response> {
    return uiRouter.fetch(
      new Request(`${ORIGIN}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: overrides.origin ?? ORIGIN, // sameOriginGuard's matching-origin arm
          cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
        },
        body: fields.toString(),
      }),
      noticesUiEnv,
    );
  }

  it("GET 200 for the site admin — the checkbox table, both forms, the notices nav item active", async () => {
    const res = await getNotices(await mintSession(env.DB, 1));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content admin notice"');
    expect(html).toContain('name="ids[]"');
    expect(html).toContain('action="/-/admin/notices/delete"');
    expect(html).toContain('action="/-/admin/notices/empty"');
    // The nav fold: the top-level System Notices item, ACTIVE here.
    expect(html).toContain('class="active item" href="/-/admin/notices"');
  });

  it("GET 303s the anonymous viewer onto the login round-trip (web.go:779's SignInRequired)", async () => {
    const res = await getNotices(null);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent("/-/admin/notices")}`);
  });

  it("GET 404-shells the signed-in non-admin (AdminRequired's hidden-surface posture)", async () => {
    const res = await getNotices(await mintSession(env.DB, 2));
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).not.toContain('class="page-content admin notice"');
    expect(html).not.toContain('action="/-/admin/notices/delete"');
  });

  it("POST delete with ids[] re-renders 200 with the success flash and the rows are gone", async () => {
    const rows = await env.DB.prepare("SELECT id FROM system_notices ORDER BY id").all<{ id: number }>();
    expect(rows.results).toHaveLength(2);
    const fields = new URLSearchParams();
    for (const row of rows.results) fields.append("ids[]", String(row.id));
    const res = await postNotices("/-/admin/notices/delete", fields, await mintSession(env.DB, 1));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<div class="ui positive message">${adminNoticesLocale.deleteSuccess}</div>`);
    expect(await countNotices(env.DB)).toBe(0); // both rows deleted
    expect(html).toContain('class="no-results-row"'); // the fresh empty re-render
  });

  it("POST delete with junk ids[] answers the §5.4 no-op success — flash 200, nothing deleted", async () => {
    const fields = new URLSearchParams([["ids[]", "abc"], ["ids[]", "-5"], ["ids[]", "999_"], ["ids[]", "0"]]);
    const res = await postNotices("/-/admin/notices/delete", fields, await mintSession(env.DB, 1));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<div class="ui positive message">${adminNoticesLocale.deleteSuccess}</div>`);
    expect(await countNotices(env.DB)).toBe(2); // untouched
    expect(html).toContain("repo-purge for r_42"); // the fresh re-render still lists them
  });

  it("POST from a cross-origin origin answers the plain 403 before the gate and deletes nothing", async () => {
    const res = await postNotices("/-/admin/notices/empty", new URLSearchParams(), await mintSession(env.DB, 1), {
      origin: "https://evil.test",
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
    expect(await countNotices(env.DB)).toBe(2); // untouched
  });

  it("POST empty (same-origin, admin) wipes the table and re-renders it empty with the flash", async () => {
    const res = await postNotices("/-/admin/notices/empty", new URLSearchParams(), await mintSession(env.DB, 1));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<div class="ui positive message">${adminNoticesLocale.deleteSuccess}</div>`);
    expect(await countNotices(env.DB)).toBe(0);
    expect(html).toContain('class="no-results-row"');
  });

  it("POST non-admin is refused by the prologue AFTER the guard (the gate order)", async () => {
    const res = await postNotices("/-/admin/notices/empty", new URLSearchParams(), await mintSession(env.DB, 2));
    expect(res.status).toBe(404);
    expect(await countNotices(env.DB)).toBe(2); // untouched
  });

  it("the POST-only shapes' GET twins answer the 405 (the method-blind parse convention)", async () => {
    const resDelete = await uiRouter.fetch(new Request(`${ORIGIN}/-/admin/notices/delete`), noticesUiEnv);
    expect(resDelete.status).toBe(405);
    const resEmpty = await uiRouter.fetch(new Request(`${ORIGIN}/-/admin/notices/empty`), noticesUiEnv);
    expect(resEmpty.status).toBe(405);
  });
});
