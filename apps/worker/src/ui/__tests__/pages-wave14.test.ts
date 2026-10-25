/**
 * Pages wave 14 route tests (SPEC-0008 U3 extension): the org labels
 * management family (`/{org}/labels` + the `/labels/{new,edit,delete}`
 * writes — pages/org-labels.tsx over the landed org-label service family)
 * and the repo per-hook family (`/settings/hooks/{id}` GET + the
 * edit/test/delete POSTs — pages/settings.tsx's wave-14 section), whose
 * module headers cite the landed arms line by line.
 *
 * Same harness posture as pages-wave2..13: the router is driven directly
 * with the synthetic ASSETS manifest and D1-only fixtures (neither page
 * reads engine content — the test-fire's delivery row is the whole
 * request-visible effect — so no receive-pack is involved) seeded through
 * the landed services with fixed values, identities riding minted session
 * cookies.
 *
 * Gate postures under test: the org labels family answers the landed
 * `requireOrgOwnership` collapsed to the org-teams pages' shape (anonymous
 * 303, non-owner 404, renamed org 307); the per-hook family answers the
 * settings pages' admin gate (anonymous 303, signed-in non-admin 404). The
 * test-fire re-plays the landed repoTestHook arm — an empty repository
 * fires nothing, and the WEBHOOK_DELIVERY producer is absent from the
 * generated Env, so the delivery row stays `pending` with the log complete
 * (SPEC-0005 §3.6).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { repositories, users, webhookDeliveries, webhooks } from "../../db/schema";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { createOrgLabel, findOrgLabelById, listOrgLabels } from "../../api/services/labels-t2";
import { createRepoHook } from "../../api/services/hooks";
import { OrgService } from "../../services/orgs/orgs";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { runA11y } from "./a11y";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const formPost = (path: string, body: Record<string, string | string[]>, cookie?: string, origin = "https://test.local"): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    ...(origin === "" ? {} : { origin }),
    ...(cookie === undefined ? {} : { cookie: `${SESSION_COOKIE_NAME}=${cookie}` }),
  },
  body: new URLSearchParams(
    Object.entries(body).flatMap(([key, value]) => (Array.isArray(value) ? value.map((entry) => [key, entry] as const) : [[key, value] as const])),
  ).toString(),
});

const withCookie = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });

const t = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

// --- fixtures -----------------------------------------------------------------

interface Wave14Fixture {
  ownerCookie: string; // alice — owns wave14
  adminCookie: string; // wave14boss — site admin
  palCookie: string; // wave14bob — unrelated signed-in viewer
  morganCookie: string; // labelorg's owner
  memberCookie: string; // a plain labelorg member (non-owner)
  orgId: number;
  foreignOrgId: number;
  blockedLabelId: number;
  foreignLabelId: number; // otherlabelorg's label (the foreign-id arms)
  hookId: number; // the edit/test hook on alice/wave14
  deleteHookId: number; // the delete hook on alice/wave14
  emptyRepoHookId: number; // a hook on the row-only empty repo (the no-fire arm)
}

let wave14Fixture: Wave14Fixture | null = null;

async function ensureWave14Fixtures(): Promise<Wave14Fixture> {
  if (wave14Fixture !== null) return wave14Fixture;
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);

  // Alice (the repo owner) — the other suites get her from ensureSeededRepo;
  // this block never pushes engine content, so seed the row directly.
  if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get()) === undefined) {
    await seedVerifiedUser({ username: "alice" });
  }

  // The row-only repos: `wave14` carries isEmpty=false (the test-fire's
  // not-empty arm — a real seed would settle it through the push), the
  // `wave14-empty` sibling keeps the schema's empty default (the no-fire
  // arm). Both owned by alice.
  for (const slug of ["wave14", "wave14-empty"]) {
    if (
      (await db
        .select({ id: repositories.id })
        .from(repositories)
        .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, slug)))
        .get()) === undefined
    ) {
      const id = `r_${slug}`;
      await db.insert(repositories).values({
        id,
        storageKey: id,
        ownerNamespace: "alice",
        ownerId: (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get())!.id,
        slug,
        visibility: "public",
        isEmpty: slug !== "wave14",
      });
    }
  }
  const wave14 = (await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave14")))
    .get())!;
  const wave14Empty = (await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave14-empty")))
    .get())!;

  // Identities (unique rows — the wave-12 block's shape).
  for (const extra of [
    { username: "wave14boss", isAdmin: true },
    { username: "wave14bob", isAdmin: false },
    { username: "wave14morgan", isAdmin: false },
    { username: "wave14member", isAdmin: false },
  ] as const) {
    if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, extra.username)).get()) === undefined) {
      await seedVerifiedUser({ username: extra.username, isAdmin: extra.isAdmin });
    }
  }
  const morgan = (await db.select().from(users).where(eq(users.usernameLower, "wave14morgan")).get())!;
  const member = (await db.select().from(users).where(eq(users.usernameLower, "wave14member")).get())!;

  // The org with one member label (the default-alphabetical second row) +
  // the rename pair + the foreign-org label.
  const orgs = new OrgService(env.DB);
  let org = await orgs.getOrgByUsername("labelorg");
  if (org === null) {
    org = await orgs.createOrg({ name: "labelorg", ownerId: morgan.id, visibility: "public", now: t(0) });
    await orgs.addMember(org.id, member.id, { now: t(1) });
  }
  org = (await orgs.getOrgByUsername("labelorg"))!;
  let blockedLabelId: number;
  if ((await listOrgLabels(env.DB, org.id, "", 1, 50)).total === 0) {
    await createOrgLabel(env.DB, org.id, { name: "alpha", exclusive: false, color: "#84b6eb", description: "" });
    const created = await createOrgLabel(env.DB, org.id, {
      name: "beta",
      exclusive: false,
      color: "#ee0701",
      description: "Something is broken",
    });
    blockedLabelId = created.id;
  } else {
    const rows = await listOrgLabels(env.DB, org.id, "", 1, 50);
    blockedLabelId = rows.items[rows.items.length - 1]!.id;
  }
  if ((await orgs.getOrgByUsername("otherlabelorg")) === null) {
    await orgs.createOrg({ name: "otherlabelorg", ownerId: morgan.id, visibility: "public", now: t(0) });
  }
  const other = (await orgs.getOrgByUsername("otherlabelorg"))!;
  const foreignLabel = await createOrgLabel(env.DB, other.id, { name: "foreign", exclusive: false, color: "#00aabb", description: "" });
  if ((await orgs.getOrgByUsername("labelnew")) === null) {
    const old = await orgs.createOrg({ name: "labelold", ownerId: morgan.id, visibility: "public", now: t(0) });
    await orgs.renameOrg(old.id, "labelnew", { now: t(1) });
  }

  // The hooks: the edit/test hook, the delete hook (both on the seeded
  // repo), and the empty repo's no-fire hook. Idempotent by the URL.
  const hookOf = async (url: string) => (await db.select().from(webhooks).where(eq(webhooks.url, url)).get()) ?? null;
  let hook = await hookOf("https://hooks.example.com/wave14-edit");
  if (hook === null) {
    await createRepoHook(env.DB, wave14.id, {
      type: "gitea",
      name: "build hook",
      config: { url: "https://hooks.example.com/wave14-edit", content_type: "json" },
      active: true,
      branch_filter: "main",
      events: ["push"],
    });
    hook = await hookOf("https://hooks.example.com/wave14-edit");
  }
  let deleteHook = await hookOf("https://hooks.example.com/wave14-delete");
  if (deleteHook === null) {
    await createRepoHook(env.DB, wave14.id, {
      type: "gitea",
      name: "delete hook",
      config: { url: "https://hooks.example.com/wave14-delete", content_type: "json" },
      active: false,
    });
    deleteHook = await hookOf("https://hooks.example.com/wave14-delete");
  }
  let emptyHook = await hookOf("https://hooks.example.com/wave14-empty");
  if (emptyHook === null) {
    await createRepoHook(env.DB, wave14Empty.id, {
      type: "gitea",
      name: "empty hook",
      config: { url: "https://hooks.example.com/wave14-empty", content_type: "json" },
      active: true,
    });
    emptyHook = await hookOf("https://hooks.example.com/wave14-empty");
  }

  // The delivery log: one row per status branch (succeeded, pending,
  // delivered failure) with FIXED uuids and T0-pinned times (the fixture
  // determinism rule — fireTestDelivery's crypto uuid and wall-clock stamp
  // would leak into every render).
  const hookId = hook!.id;
  const existingDeliveries = await db.select({ id: webhookDeliveries.id }).from(webhookDeliveries).where(eq(webhookDeliveries.hookId, hookId)).all();
  if (existingDeliveries.length === 0) {
    await db.insert(webhookDeliveries).values([
      {
        hookId,
        repoId: wave14.id,
        uuid: "wave14-delivery-succeed",
        eventType: "push",
        eventGroup: "push",
        payloadContent: "{}",
        state: "delivered",
        attempts: 1,
        isSucceed: true,
        requestContent: JSON.stringify({ url: "https://hooks.example.com/wave14-edit", http_method: "POST" }),
        responseContent: JSON.stringify({ status: 200 }),
        createdAt: t(60),
        deliveredAt: t(61),
      },
      {
        hookId,
        repoId: wave14.id,
        uuid: "wave14-delivery-pending",
        eventType: "push",
        eventGroup: "push",
        payloadContent: "{}",
        state: "pending",
        createdAt: t(70),
      },
      {
        hookId,
        repoId: wave14.id,
        uuid: "wave14-delivery-failed",
        eventType: "push",
        eventGroup: "push",
        payloadContent: "{}",
        state: "delivered",
        attempts: 3,
        isSucceed: false,
        responseContent: JSON.stringify({ status: 500 }),
        createdAt: t(80),
        deliveredAt: t(81),
      },
    ]);
  }

  wave14Fixture = {
    ownerCookie: await mintSession(env.DB, (await db.select().from(users).where(eq(users.usernameLower, "alice")).get())!.id),
    adminCookie: await mintSession(env.DB, (await db.select().from(users).where(eq(users.usernameLower, "wave14boss")).get())!.id),
    palCookie: await mintSession(env.DB, (await db.select().from(users).where(eq(users.usernameLower, "wave14bob")).get())!.id),
    morganCookie: await mintSession(env.DB, morgan.id),
    memberCookie: await mintSession(env.DB, member.id),
    orgId: org.id,
    foreignOrgId: other.id,
    blockedLabelId,
    foreignLabelId: foreignLabel.id,
    hookId,
    deleteHookId: deleteHook!.id,
    emptyRepoHookId: emptyHook!.id,
  };
  return wave14Fixture;
}

beforeAll(async () => {
  await ensureWave14Fixtures();
});

// --- the parsers (the single owner of the route shapes) -------------------------

describe("wave-14 parser families (parseUiRoute / handlesUiRoute)", () => {
  it("claims the org labels shapes", () => {
    expect(parseUiRoute("/acme/labels")).toEqual({ family: "org-labels", owner: "acme" });
    expect(parseUiRoute("/acme/labels/new")).toEqual({ family: "org-label-new", owner: "acme" });
    expect(parseUiRoute("/acme/labels/edit")).toEqual({ family: "org-label-edit", owner: "acme" });
    expect(parseUiRoute("/acme/labels/delete")).toEqual({ family: "org-label-delete", owner: "acme" });
    expect(handlesUiRoute("/acme/labels")).toBe(true);
    // The trailing-slash form classifies to the same shape (the dispatcher's
    // middleware 301s it to the canonical URL).
    expect(parseUiRoute("/acme/labels/")).toEqual({ family: "org-labels", owner: "acme" });
  });

  it("leaves the initialize loader and deeper tails with the engine", () => {
    expect(parseUiRoute("/acme/labels/initialize")).toBeNull();
    expect(parseUiRoute("/acme/labels/new/more")).toBeNull();
    expect(parseUiRoute("/acme/labels/abc")).toBeNull();
  });

  it("claims the per-hook shapes with PathParamInt64 id parity", () => {
    expect(parseUiRoute("/octo/hello/settings/hooks/42")).toEqual({
      family: "settings-hook-detail",
      owner: "octo",
      repo: "hello",
      id: 42,
    });
    // "007" parses as 7 (the issue-detail convention).
    expect(parseUiRoute("/octo/hello/settings/hooks/007")).toEqual({
      family: "settings-hook-detail",
      owner: "octo",
      repo: "hello",
      id: 7,
    });
    expect(parseUiRoute("/octo/hello/settings/hooks/42/test")).toEqual({
      family: "settings-hook-test",
      owner: "octo",
      repo: "hello",
      id: 42,
    });
    expect(parseUiRoute("/octo/hello/settings/hooks/42/delete")).toEqual({
      family: "settings-hook-delete",
      owner: "octo",
      repo: "hello",
      id: 42,
    });
    expect(handlesUiRoute("/octo/hello/settings/hooks/42")).toBe(true);
  });

  it("leaves junk hook tails and the rest of the settings space with the engine", () => {
    expect(parseUiRoute("/octo/hello/settings/hooks/abc")).toBeNull();
    expect(parseUiRoute("/octo/hello/settings/hooks/42/edit")).toBeNull();
    expect(parseUiRoute("/octo/hello/settings/hooks/42/test/extra")).toBeNull();
    // Wave 15 claimed /settings/branches (pages/branch-protection.tsx); the
    // rest of the deeper settings space stays engine-owned (the wave-4 pin,
    // narrowed by the wave-15 claim).
    expect(parseUiRoute("/octo/hello/settings/keys")).toBeNull();
    expect(parseUiRoute("/octo/hello/settings/tags")).toBeNull();
  });
});

// --- the org labels family -------------------------------------------------------

describe("GET /{org}/labels (the requireOrgOwnership posture)", () => {
  it("303s an anonymous viewer onto the login round-trip", async () => {
    const res = await fetchUi("/labelorg/labels");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?redirect_to=%2Flabelorg%2Flabels");
  });

  it("404-shells a signed-in non-member and a plain member (non-owner)", async () => {
    const fixture = await ensureWave14Fixtures();
    const pal = await fetchUi("/labelorg/labels", withCookie(fixture.palCookie));
    expect(pal.status).toBe(404);
    const member = await fetchUi("/labelorg/labels", withCookie(fixture.memberCookie));
    expect(member.status).toBe(404);
  });

  it("answers the owner and a site admin with the management page", async () => {
    const fixture = await ensureWave14Fixtures();
    for (const cookie of [fixture.morganCookie, fixture.adminCookie]) {
      const res = await fetchUi("/labelorg/labels", withCookie(cookie));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("page-content organization settings labels");
      // The header count, the create form (the two brief fields + the
      // modal's default color) and the delete/edit controls.
      expect(html).toContain("<h4 class=\"ui top attached header\">2 labels</h4>");
      expect(html).toContain('action="/labelorg/labels/new" method="post"');
      expect(html).toContain('id="new-label_title" name="title" value=""');
      expect(html).toContain('id="new-label_color" name="color" value="#70c24a"');
      expect(html).toContain('action="/labelorg/labels/delete" method="post"');
      expect(html).toContain("<summary");
      // The default-alphabetical order (alpha before beta) — reverse sorts
      // are the next test.
      expect(html.indexOf(">alpha</span>")).toBeLessThan(html.indexOf(">beta</span>"));
      // The ContrastColor port: the #ee0701 badge renders white-on-red (the
      // wave-2 helper's exact inline-style shape), the description line and
      // the zero-issue count render under it.
      expect(html).toContain("color: #fff !important; background-color: #ee0701 !important;");
      expect(html).toContain("Something is broken");
      expect(html).toContain("0 open issues/pull requests");
      // The prompt row's strong pair (org.settings.labels_desc).
      expect(html).toContain("<strong>all repositories</strong>");
    }
  });

  it("honors the silent ?sort= reversal exactly like the landed list arm", async () => {
    const fixture = await ensureWave14Fixtures();
    const res = await fetchUi("/labelorg/labels?sort=reversealphabetically", withCookie(fixture.morganCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.indexOf(">beta</span>")).toBeLessThan(html.indexOf(">alpha</span>"));
  });

  it("307s a renamed org onto the new name", async () => {
    const fixture = await ensureWave14Fixtures();
    const res = await fetchUi("/labelold/labels?q=x", withCookie(fixture.morganCookie));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/labelnew/labels?q=x");
  });
});

describe("POST /{org}/labels/new (the create arm)", () => {
  it("creates through the landed arm, normalizing the color, and 303s back", async () => {
    const fixture = await ensureWave14Fixtures();
    const res = await fetchUi(
      "/labelorg/labels/new",
      formPost("/labelorg/labels/new", { title: "infra", color: "00AABB" }, fixture.morganCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/labelorg/labels");
    const html = await (await fetchUi("/labelorg/labels", withCookie(fixture.morganCookie))).text();
    expect(html).toContain(">infra</span>");
    // The stored color is the normalizer's lowercase #rrggbb form.
    const rows = await listOrgLabels(env.DB, fixture.orgId, "", 1, 50);
    expect(rows.items.find((row) => row.name === "infra")?.color).toBe("#00aabb");
    expect(html).toContain("3 labels");
  });

  it("re-renders the color 422 and the empty-title guard with the kept submission", async () => {
    const fixture = await ensureWave14Fixtures();
    const badColor = await fetchUi(
      "/labelorg/labels/new",
      formPost("/labelorg/labels/new", { title: "kept title", color: "notacolor" }, fixture.morganCookie),
    );
    expect(badColor.status).toBe(200);
    const badHtml = await badColor.text();
    expect(badHtml).toContain("invalid color: notacolor");
    expect(badHtml).toContain('name="title" value="kept title"');

    const empty = await fetchUi(
      "/labelorg/labels/new",
      formPost("/labelorg/labels/new", { title: "", color: "#00aabb" }, fixture.morganCookie),
    );
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain("Label name cannot be empty.");
  });

  it("refuses the unprivileged and cross-origin posts", async () => {
    const fixture = await ensureWave14Fixtures();
    const anon = await fetchUi("/labelorg/labels/new", formPost("/labelorg/labels/new", { title: "Nope", color: "#00aabb" }));
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toContain("/login?redirect_to=");
    const member = await fetchUi(
      "/labelorg/labels/new",
      formPost("/labelorg/labels/new", { title: "Nope", color: "#00aabb" }, fixture.memberCookie),
    );
    expect(member.status).toBe(404);
    const crossOrigin = await fetchUi(
      "/labelorg/labels/new",
      formPost("/labelorg/labels/new", { title: "Nope", color: "#00aabb" }, fixture.morganCookie, "https://evil.example"),
    );
    expect(crossOrigin.status).toBe(403);
  });
});

describe("POST /{org}/labels/edit + /delete (the per-row arms)", () => {
  it("edits name and color through the arm, keeping the unposted fields", async () => {
    const fixture = await ensureWave14Fixtures();
    const res = await fetchUi(
      "/labelorg/labels/edit",
      formPost("/labelorg/labels/edit", { id: String(fixture.blockedLabelId), title: "beta-renamed", color: "#123abc" }, fixture.morganCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/labelorg/labels");
    const row = (await findOrgLabelById(env.DB, fixture.orgId, fixture.blockedLabelId))!;
    expect(row.name).toBe("beta-renamed");
    expect(row.color).toBe("#123abc");
    // The description is not a form field — the PATCH arm's absent-field
    // rule keeps it.
    expect(row.description).toBe("Something is broken");
  });

  it("404-shells a missing id and a foreign org's label", async () => {
    const fixture = await ensureWave14Fixtures();
    const missing = await fetchUi(
      "/labelorg/labels/edit",
      formPost("/labelorg/labels/edit", { id: "999999", title: "x", color: "#00aabb" }, fixture.morganCookie),
    );
    expect(missing.status).toBe(404);
    const foreign = await fetchUi(
      "/labelorg/labels/edit",
      formPost("/labelorg/labels/edit", { id: String(fixture.foreignLabelId), title: "x", color: "#00aabb" }, fixture.morganCookie),
    );
    expect(foreign.status).toBe(404);
    // The foreign row never changed.
    const foreignRow = (await findOrgLabelById(env.DB, fixture.foreignOrgId, fixture.foreignLabelId))!;
    expect(foreignRow.name).toBe("foreign");
    expect(foreignRow.color).toBe("#00aabb");
  });

  it("re-renders the color 422 with the error banner", async () => {
    const fixture = await ensureWave14Fixtures();
    const res = await fetchUi(
      "/labelorg/labels/edit",
      formPost("/labelorg/labels/edit", { id: String(fixture.blockedLabelId), title: "beta-renamed", color: "zzz" }, fixture.morganCookie),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("invalid color: #zzz");
  });

  it("deletes through the cascade arm, idempotently, never touching foreign rows", async () => {
    const fixture = await ensureWave14Fixtures();
    const res = await fetchUi(
      "/labelorg/labels/delete",
      formPost("/labelorg/labels/delete", { id: String(fixture.blockedLabelId) }, fixture.morganCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/labelorg/labels");
    expect(await findOrgLabelById(env.DB, fixture.orgId, fixture.blockedLabelId)).toBeNull();

    // The zero-row success (the landed DELETE arm's 204 semantics).
    const again = await fetchUi(
      "/labelorg/labels/delete",
      formPost("/labelorg/labels/delete", { id: String(fixture.blockedLabelId) }, fixture.morganCookie),
    );
    expect(again.status).toBe(303);

    // The foreign org's label survives (the delete is org-scoped).
    const foreignPost = await fetchUi(
      "/labelorg/labels/delete",
      formPost("/labelorg/labels/delete", { id: String(fixture.foreignLabelId) }, fixture.morganCookie),
    );
    expect(foreignPost.status).toBe(303);
    expect(await findOrgLabelById(env.DB, fixture.orgId, fixture.foreignLabelId)).toBeNull();
    expect(await findOrgLabelById(env.DB, fixture.foreignOrgId, fixture.foreignLabelId)).not.toBeNull();
  });

  it("gates both writes like the list", async () => {
    const fixture = await ensureWave14Fixtures();
    const anonDelete = await fetchUi("/labelorg/labels/delete", formPost("/labelorg/labels/delete", { id: "1" }));
    expect(anonDelete.status).toBe(303);
    const memberEdit = await fetchUi(
      "/labelorg/labels/edit",
      formPost("/labelorg/labels/edit", { id: "1", title: "x", color: "#00aabb" }, fixture.memberCookie),
    );
    expect(memberEdit.status).toBe(404);
  });
});

// --- the per-hook family ---------------------------------------------------------

describe("GET /{owner}/{repo}/settings/hooks/{id} (the per-hook page)", () => {
  it("gates like the settings pages: anonymous 303, non-admin 404", async () => {
    const fixture = await ensureWave14Fixtures();
    const anon = await fetchUi(`/alice/wave14/settings/hooks/${fixture.hookId}`);
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toContain("/login?redirect_to=");
    const pal = await fetchUi(`/alice/wave14/settings/hooks/${fixture.hookId}`, withCookie(fixture.palCookie));
    expect(pal.status).toBe(404);
  });

  it("404-shells an unknown id", async () => {
    const fixture = await ensureWave14Fixtures();
    const res = await fetchUi("/alice/wave14/settings/hooks/999999", withCookie(fixture.ownerCookie));
    expect(res.status).toBe(404);
  });

  it("renders the edit form bound to the stored hook and the delivery log", async () => {
    const fixture = await ensureWave14Fixtures();
    for (const cookie of [fixture.ownerCookie, fixture.adminCookie]) {
      const res = await fetchUi(`/alice/wave14/settings/hooks/${fixture.hookId}`, withCookie(cookie));
      expect(res.status).toBe(200);
      const html = await res.text();
      // Upstream's literal discriminator (the edit page renders through
      // new.tmpl at this pin).
      expect(html).toContain("page-content repository settings new webhook");
      // The form binding: payload_url, content_type, name, branch filter,
      // the active checkbox, and the hidden events preserves.
      expect(html).toContain(`action="/alice/wave14/settings/hooks/${fixture.hookId}" method="post"`);
      expect(html).toContain('id="payload_url" name="payload_url" type="url" required="" value="https://hooks.example.com/wave14-edit"');
      expect(html).toContain('<option value="json" selected="">');
      expect(html).toContain('id="hook_name" name="name" type="text" maxlength="255" value="build hook"');
      expect(html).toContain('id="branch_filter" name="branch_filter" type="text" value="main"');
      expect(html).toContain('id="hook_active" name="active" type="checkbox" checked=""');
      expect(html).toContain('type="hidden" name="events" value="push"');
      expect(html).toContain("Trigger On: push");
      expect(html).toContain("Update Webhook");
      // The delete + test controls and the deliveries header.
      expect(html).toContain(`action="/alice/wave14/settings/hooks/${fixture.hookId}/delete"`);
      expect(html).toContain(`action="/alice/wave14/settings/hooks/${fixture.hookId}/test"`);
      expect(html).toContain("Recent Deliveries");
      expect(html).toContain("Test Push Event");
      // The delivery rows: the fixed uuids and the three status branches —
      // succeeded green check, pending orange clock, delivered failure red
      // dot (the allowlist stand-ins the module header documents).
      expect(html).toContain("wave14-delivery-succeed");
      expect(html).toContain("tw-text-green");
      expect(html).toContain("wave14-delivery-pending");
      expect(html).toContain("tw-text-orange");
      expect(html).toContain("wave14-delivery-failed");
      expect(html).toContain("tw-text-red");
      // The event-type chip.
      expect(html).toContain('<span class="ui tiny label">push</span>');
      // Newest first (the read arm's id DESC).
      expect(html.indexOf("wave14-delivery-failed")).toBeLessThan(html.indexOf("wave14-delivery-succeed"));
    }
  });
});

describe("POST /{owner}/{repo}/settings/hooks/{id} (the edit write)", () => {
  it("applies the PATCH arm's fields and 303s back onto the page", async () => {
    const fixture = await ensureWave14Fixtures();
    const res = await fetchUi(
      `/alice/wave14/settings/hooks/${fixture.hookId}`,
      formPost(
        `/alice/wave14/settings/hooks/${fixture.hookId}`,
        {
          name: "renamed hook",
          payload_url: "https://hooks.example.com/wave14-edit-v2",
          content_type: "form",
          branch_filter: "{main,feature/*}",
          events: "push",
          active: "on",
        },
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/alice/wave14/settings/hooks/${fixture.hookId}`);
    const row = (await drizzle(env.DB).select().from(webhooks).where(eq(webhooks.id, fixture.hookId)).get())!;
    expect(row.name).toBe("renamed hook");
    expect(row.url).toBe("https://hooks.example.com/wave14-edit-v2");
    expect(row.contentType).toBe(2);
    expect(row.isActive).toBe(true);
    // The events rewrite (unconditional in the arm) preserved the push
    // subscription and stored the posted branch filter.
    const stored = JSON.parse(row.events) as { branch_filter?: string; events?: Record<string, boolean> };
    expect(stored.branch_filter).toBe("{main,feature/*}");
    expect(stored.events?.push).toBe(true);

    // The re-render shows the stored values.
    const html = await (await fetchUi(`/alice/wave14/settings/hooks/${fixture.hookId}`, withCookie(fixture.ownerCookie))).text();
    expect(html).toContain('value="https://hooks.example.com/wave14-edit-v2"');
    expect(html).toContain('<option value="form" selected="">');
    expect(html).toContain('value="{main,feature/*}"');
  });

  it("re-renders the 422 with the message and the kept submission", async () => {
    const fixture = await ensureWave14Fixtures();
    const res = await fetchUi(
      `/alice/wave14/settings/hooks/${fixture.hookId}`,
      formPost(
        `/alice/wave14/settings/hooks/${fixture.hookId}`,
        {
          name: "bad",
          payload_url: "ftp://not-a-webhook",
          content_type: "json",
          branch_filter: "",
          events: "push",
        },
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Invalid url");
    expect(html).toContain('value="ftp://not-a-webhook"');
  });

  it("404-shells a missing hook and refuses cross-origin posts", async () => {
    const fixture = await ensureWave14Fixtures();
    const missing = await fetchUi(
      "/alice/wave14/settings/hooks/999999",
      formPost("/alice/wave14/settings/hooks/999999", { name: "x", payload_url: "https://ok.example", content_type: "json" }, fixture.ownerCookie),
    );
    expect(missing.status).toBe(404);
    const crossOrigin = await fetchUi(
      `/alice/wave14/settings/hooks/${fixture.hookId}`,
      formPost(
        `/alice/wave14/settings/hooks/${fixture.hookId}`,
        { name: "x", payload_url: "https://ok.example", content_type: "json" },
        fixture.ownerCookie,
        "https://evil.example",
      ),
    );
    expect(crossOrigin.status).toBe(403);
  });
});

describe("POST /{owner}/{repo}/settings/hooks/{id}/test (the test-fire write)", () => {
  it("fires the representative push delivery and 303s back with the flash reduction", async () => {
    const fixture = await ensureWave14Fixtures();
    const before = await drizzle(env.DB).select({ id: webhookDeliveries.id }).from(webhookDeliveries).where(eq(webhookDeliveries.hookId, fixture.hookId)).all();
    const res = await fetchUi(`/alice/wave14/settings/hooks/${fixture.hookId}/test`, formPost(`/alice/wave14/settings/hooks/${fixture.hookId}/test`, {}, fixture.ownerCookie));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/alice/wave14/settings/hooks/${fixture.hookId}?test=queued`);
    // The request-visible effect: one new pending push delivery row (the
    // WEBHOOK_DELIVERY producer is absent from Env — the row stays pending).
    const after = await drizzle(env.DB).select().from(webhookDeliveries).where(eq(webhookDeliveries.hookId, fixture.hookId)).all();
    expect(after.length).toBe(before.length + 1);
    const fired = after.find((row) => !before.some((prev) => prev.id === row.id))!;
    expect(fired.state).toBe("pending");
    expect(fired.eventType).toBe("push");
    // The flash reduction renders the upstream delivery.success text and the
    // new pending row shows in the log.
    const html = await (
      await fetchUi(`/alice/wave14/settings/hooks/${fixture.hookId}?test=queued`, withCookie(fixture.ownerCookie))
    ).text();
    expect(html).toContain("An event has been added to the delivery queue");
    expect(html).toContain(fired.uuid);
  });

  it("fires nothing for an empty repository (the landed arm's early no-op)", async () => {
    const fixture = await ensureWave14Fixtures();
    const before = await drizzle(env.DB).select({ id: webhookDeliveries.id }).from(webhookDeliveries).all();
    const res = await fetchUi(
      `/alice/wave14-empty/settings/hooks/${fixture.emptyRepoHookId}/test`,
      formPost(`/alice/wave14-empty/settings/hooks/${fixture.emptyRepoHookId}/test`, {}, fixture.ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/alice/wave14-empty/settings/hooks/${fixture.emptyRepoHookId}`);
    const after = await drizzle(env.DB).select({ id: webhookDeliveries.id }).from(webhookDeliveries).all();
    expect(after.length).toBe(before.length);
  });

  it("gates like the page", async () => {
    const fixture = await ensureWave14Fixtures();
    const anon = await fetchUi(`/alice/wave14/settings/hooks/${fixture.hookId}/test`, formPost(`/alice/wave14/settings/hooks/${fixture.hookId}/test`, {}));
    expect(anon.status).toBe(303);
    const pal = await fetchUi(
      `/alice/wave14/settings/hooks/${fixture.hookId}/test`,
      formPost(`/alice/wave14/settings/hooks/${fixture.hookId}/test`, {}, fixture.palCookie),
    );
    expect(pal.status).toBe(404);
    const missing = await fetchUi(
      "/alice/wave14/settings/hooks/999999/test",
      formPost("/alice/wave14/settings/hooks/999999/test", {}, fixture.ownerCookie),
    );
    expect(missing.status).toBe(404);
    const wrongMethod = await fetchUi(`/alice/wave14/settings/hooks/${fixture.hookId}/test`);
    expect(wrongMethod.status).toBe(405);
  });
});

describe("POST /{owner}/{repo}/settings/hooks/{id}/delete (the delete write)", () => {
  it("deletes the hook and 303s onto the list", async () => {
    const fixture = await ensureWave14Fixtures();
    const res = await fetchUi(
      `/alice/wave14/settings/hooks/${fixture.deleteHookId}/delete`,
      formPost(`/alice/wave14/settings/hooks/${fixture.deleteHookId}/delete`, {}, fixture.ownerCookie),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/wave14/settings/hooks");
    expect(await drizzle(env.DB).select().from(webhooks).where(eq(webhooks.id, fixture.deleteHookId)).get()).toBeUndefined();
    // The delivery log rows are not cascaded by the delete arm (the purge
    // service owns them) — the list's count simply drops.
  });

  it("404-shells a missing hook and answers GET with the 405", async () => {
    const fixture = await ensureWave14Fixtures();
    const missing = await fetchUi(
      "/alice/wave14/settings/hooks/999999/delete",
      formPost("/alice/wave14/settings/hooks/999999/delete", {}, fixture.ownerCookie),
    );
    expect(missing.status).toBe(404);
    const wrongMethod = await fetchUi(`/alice/wave14/settings/hooks/${fixture.deleteHookId}/delete`);
    expect(wrongMethod.status).toBe(405);
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("wave-14 a11y smoke", () => {
  it("every new page passes the structural rules for its gate-admitted viewer", async () => {
    const fixture = await ensureWave14Fixtures();
    for (const [path, init] of [
      ["/labelorg/labels", withCookie(fixture.morganCookie)],
      ["/labelorg/labels?sort=mostissues", withCookie(fixture.adminCookie)],
      [`/alice/wave14/settings/hooks/${fixture.hookId}`, withCookie(fixture.ownerCookie)],
      [`/alice/wave14/settings/hooks/${fixture.hookId}?test=queued`, withCookie(fixture.adminCookie)],
    ] as Array<[string, RequestInit]>) {
      const res = await fetchUi(path, init);
      expect(res.status, path).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});
