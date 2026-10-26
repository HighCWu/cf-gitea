/**
 * Pages wave 20 route tests — the releases family
 * (`/{owner}/{repo}/releases` + `/new` + `/latest` + `/tag/{tag}`,
 * pages/releases.tsx): upstream templates/repo/release/list.tmpl + new.tmpl +
 * label.tmpl + release_tag_header.tmpl over the LANDED data side
 * (api/services/releases.ts list/find arms, api/services/release-assets.ts
 * asset rows, the SPEC-0005 IssuesService.createRelease write + the `release`
 * webhook through the shared emit seam) — the parity survey's #4: the
 * navbar's Releases tab resolves.
 *
 * Same harness posture as pages-wave2..18: the router is driven directly
 * with the synthetic ASSETS manifest; engine content seeds through the REAL
 * receive flow (testing/seed-repo.ts's pack primitives) with fixed
 * timestamps, and the D1 release rows ride the LANDED create arm with fixed
 * `now`s so the rendered stamps and orders are deterministic. Two fixture
 * repos keep the matrix off any other suite's rows: `alice/wave20rel`
 * (main + the pushed refs/tags/w20-v1; a published slash-tag release, the
 * published tagged v1 with an asset row, and a draft) and
 * `alice/wave20reldraft` (main only; one draft — the empty-list and the
 * no-stable-latest 404 arms).
 */

import { env, SELF } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { settleCreatingRepo } from "../../git-http/gate";
import { releaseAssets, releases, repositories, users, webhookDeliveries, webhooks } from "../../db/schema";
import { RepoService } from "../../repos/service";
import { IssuesService } from "../../issues/service";
import { saveRepoSettings } from "../../api/services/repo-settings";
import { createRepoHook } from "../../api/services/hooks";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { runA11y } from "./a11y";
import { buildHistoryPack, buildReceivePackBody, type SeedCommit } from "../testing/seed-repo";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const withCookie = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });

const post = (path: string, body: string, cookie: string, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", cookie: `${SESSION_COOKIE_NAME}=${cookie}`, ...headers },
  body,
});

// --- fixtures -----------------------------------------------------------------

/** One commit — content is irrelevant (the releases family reads D1 + the
 *  ref universe only); fixed time → deterministic oids and stamps. */
const WAVE20_COMMITS: SeedCommit[] = [
  { message: "wave20: seed commit", time: T0, files: [{ path: "README.md", content: "wave20 readme\n" }] },
];

const WAVE20_TAG = "w20-v1";

async function pushRefs(repoName: string, updates: { ref: string; oid: string }[], pack: Uint8Array, token: string): Promise<void> {
  const response = await SELF.fetch(`https://test.local/${repoName}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
    body: buildReceivePackBody(updates, pack),
  });
  const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
  if (response.status !== 200 || responseBody.includes("ng ")) {
    throw new Error(`wave20 seed push failed: ${response.status} ${responseBody.slice(0, 400)}`);
  }
}

interface Wave20Repo {
  repoId: string;
}

/** Idempotent seed (the ensureSeededRepo recipe): owner + stranger rows, one
 *  pack push per repo (main, plus the tag on the first), settle + public +
 *  the createdAt pin, then the D1 release rows through the LANDED create arm
 *  with fixed `now`s. */
let wave20Seed: Promise<Wave20Repo> | null = null;

/** Memoized seed (the wave-18 tips() pattern) — tests re-request the repo id
 *  without re-running the seeding block. */
function ensureWave20Repos(): Promise<Wave20Repo> {
  if (wave20Seed === null) wave20Seed = seedWave20Repos();
  return wave20Seed;
}

async function seedWave20Repos(): Promise<Wave20Repo> {
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  const alice =
    (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get()) ??
    (await seedVerifiedUser({ username: "alice" }));
  if (
    (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "w20bob")).get()) === undefined
  ) {
    await seedVerifiedUser({ username: "w20bob" }); // the signed-in stranger (no grants)
  }
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(alice.id, "ui-page-seed-wave20rel")
    .run();
  const token = (await mintFor(alice.id, "ui-page-seed-wave20rel", "write:repository")).plaintext;
  const { tips, pack } = await buildHistoryPack(WAVE20_COMMITS);

  const service = new RepoService(env.DB);
  for (const slug of ["wave20rel", "wave20reldraft"]) {
    const repoName = `alice/${slug}`;
    const refs = await env.REPO.getByName(repoName).listRefs();
    if (refs.head === null) {
      const updates = [{ ref: "refs/heads/main", oid: tips[0] as string }];
      if (slug === "wave20rel") updates.push({ ref: `refs/tags/${WAVE20_TAG}`, oid: tips[0] as string });
      await pushRefs(repoName, updates, pack, token);
    }
    let row = await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, slug)))
      .get();
    if (row === undefined) {
      row = await service.create({
        owner: { id: alice.id, usernameLower: "alice" },
        name: slug,
        isPrivate: false,
        status: "ready",
      });
    } else {
      await settleCreatingRepo(env, row.id, repoName);
      row = (await db.select().from(repositories).where(eq(repositories.id, row.id)).get()) ?? row;
    }
    if (row.visibility !== "public") {
      await db.update(repositories).set({ visibility: "public" }).where(eq(repositories.id, row.id));
    }
    if (row.defaultBranch !== "main") {
      await db.update(repositories).set({ defaultBranch: "main" }).where(eq(repositories.id, row.id));
    }
    await db.update(repositories).set({ createdAt: new Date(T0 * 1000) }).where(eq(repositories.id, row.id));
  }

  // The D1 release rows (the LANDED create arm, fixed `now`s — §5.2).
  const repo = (await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave20rel")))
    .get())!;
  const draftRepo = (await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave20reldraft")))
    .get())!;
  const t = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);
  const svc = new IssuesService(env.DB);
  if ((await db.select({ id: releases.id }).from(releases).where(eq(releases.repoId, repo.id)).limit(1).all()).length === 0) {
    // The slash-tag stable (OLDER than v1 — v1 keeps the Latest mark).
    await svc.createRelease({
      repoId: repo.id,
      publisherId: alice.id,
      tagName: "w20-v1.1/rc",
      target: "main",
      title: "Wave20 v1.1 RC",
      note: "",
      isDraft: false,
      isPrerelease: false,
      now: t(60),
    });
    // The tagged stable (Latest; the in-git tag drives the meta-row links).
    const v1 = await svc.createRelease({
      repoId: repo.id,
      publisherId: alice.id,
      tagName: WAVE20_TAG,
      target: "main",
      title: "Wave20 v1",
      note: "Ships the **seed** fixtures.",
      isDraft: false,
      isPrerelease: false,
      now: t(90),
    });
    await db.insert(releaseAssets).values({
      uuid: "w20-asset-0001-fixed",
      repoId: repo.id,
      releaseId: v1.id,
      uploaderId: alice.id,
      name: "w20-v1.zip",
      size: 1536,
      downloadCount: 3,
      r2Key: `repos/wave20/release-assets/${v1.id}/w20-asset-0001-fixed-w20-v1.zip`,
      checksumSha256: null,
      createdAt: t(95),
    });
    // The draft+prerelease (newest — the writer list's first row).
    await svc.createRelease({
      repoId: repo.id,
      publisherId: alice.id,
      tagName: "w20-draft",
      target: "main",
      title: "Wave20 draft",
      note: "Unpublished notes.",
      isDraft: true,
      isPrerelease: true,
      now: t(120),
    });
  }
  if ((await db.select({ id: releases.id }).from(releases).where(eq(releases.repoId, draftRepo.id)).limit(1).all()).length === 0) {
    await svc.createRelease({
      repoId: draftRepo.id,
      publisherId: alice.id,
      tagName: "w20-d1",
      target: "main",
      title: "Only a draft",
      note: "",
      isDraft: true,
      isPrerelease: false,
      now: t(80),
    });
  }
  // A repo-level webhook subscribed to the `release` family (the delivery
  // rows the publish POST's awaited insert lands — the draft POST's silence
  // arm needs the subscriber present too).
  if ((await db.select({ id: webhooks.id }).from(webhooks).where(eq(webhooks.repoId, repo.id)).limit(1).all()).length === 0) {
    await createRepoHook(env.DB, repo.id, {
      type: "gitea",
      name: "Wave20 release relay",
      config: { url: "https://hooks.example.com/wave20", content_type: "json", secret: "w20-secret" },
      active: true,
      branch_filter: "*",
      events: ["release"],
    });
  }
  return { repoId: repo.id };
}

let aliceCookie: string | null = null;
let bobCookie: string | null = null;

async function aliceSession(): Promise<string> {
  if (aliceCookie === null) {
    const alice = (await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get())!;
    aliceCookie = await mintSession(env.DB, alice.id);
  }
  return aliceCookie;
}

async function bobSession(): Promise<string> {
  if (bobCookie === null) {
    const bob = (await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, "w20bob")).get())!;
    bobCookie = await mintSession(env.DB, bob.id);
  }
  return bobCookie;
}

beforeAll(async () => {
  await ensureWave20Repos();
});

// --- the parser (the single owner of the route shape) ---------------------------

describe("wave-20 parser family (parseUiRoute / handlesUiRoute)", () => {
  it("claims the upstream release shapes", () => {
    expect(parseUiRoute("/octo/hello/releases")).toEqual({ family: "releases", owner: "octo", repo: "hello" });
    // The trailing-slash form classifies to the same shape.
    expect(parseUiRoute("/octo/hello/releases/")).toEqual({ family: "releases", owner: "octo", repo: "hello" });
    expect(parseUiRoute("/octo/hello/releases/new")).toEqual({ family: "release-new", owner: "octo", repo: "hello" });
    expect(parseUiRoute("/octo/hello/releases/latest")).toEqual({ family: "release-latest", owner: "octo", repo: "hello" });
    expect(parseUiRoute("/octo/hello/releases/tag/v1")).toEqual({
      family: "release-detail",
      owner: "octo",
      repo: "hello",
      tag: "v1",
    });
    expect(handlesUiRoute("/octo/hello/releases")).toBe(true);
    expect(handlesUiRoute("/octo/hello/releases/tag/a/b")).toBe(true);
  });

  it("decodes the tag tail per segment, slashes preserved", () => {
    expect(parseUiRoute("/octo/hello/releases/tag/v%201.0/rc")).toEqual({
      family: "release-detail",
      owner: "octo",
      repo: "hello",
      tag: "v 1.0/rc",
    });
    expect(parseUiRoute("/octo/hello/releases/tag/w20-v1.1/rc")).toEqual({
      family: "release-detail",
      owner: "octo",
      repo: "hello",
      tag: "w20-v1.1/rc",
    });
  });

  it("leaves the feed/write tails and the bare /tag with the engine", () => {
    expect(parseUiRoute("/octo/hello/releases/tag")).toBeNull();
    expect(parseUiRoute("/octo/hello/releases/.rss")).toBeNull();
    // The wave-33 write-group tails (the survey's top-5 #4) now claim their
    // families — the edit wildcard (the URL-keyed tag) and the delete
    // literal lifted out of the unclaimed set.
    expect(parseUiRoute("/octo/hello/releases/edit/v1")).toEqual({
      family: "release-edit",
      owner: "octo",
      repo: "hello",
      tag: "v1",
    });
    expect(parseUiRoute("/octo/hello/releases/delete")).toEqual({
      family: "release-delete",
      owner: "octo",
      repo: "hello",
    });
    expect(parseUiRoute("/octo/hello/releases/generate-notes")).toBeNull();
    // Wave-41 disclosure: `/releases/attachments/{uuid}` left the unclaimed
    // set (web.go:1513's download-tail family, pages/release-downloads.ts —
    // the wave-41 test owns the shape); the write tails stay unclaimed.
    expect(parseUiRoute("/octo/hello/releases/attachments/abc")).toEqual({
      family: "release-attachment",
      owner: "octo",
      repo: "hello",
      uuid: "abc",
    });
    expect(parseUiRoute("/octo/hello/releases/attachments")).toBeNull();
  });
});

// --- the list -------------------------------------------------------------------

describe("GET /{owner}/{repo}/releases (the list)", () => {
  it("renders the anonymous list: the tab, the header menu, the stable entries", async () => {
    const res = await fetchUi("/alice/wave20rel/releases");
    expect(res.status).toBe(200);
    const html = await res.text();
    // The page discriminator + the ACTIVE Releases tab (the shell wiring).
    expect(html).toContain('class="page-content repository releases"');
    expect(html).toContain('class="active item" href="/alice/wave20rel/releases" data-shortcut-keys="g r"');
    expect(html).toContain("svg octicon-tag");
    expect(html).toContain(" Releases</a>");
    // The header menu: two visible (non-draft) releases, plural.
    expect(html).toContain(">2 Releases</a>");
    // The New Release button is writer-only.
    expect(html).not.toContain("/alice/wave20rel/releases/new");
    // The v1 entry: title link, the in-git tag/commit meta links, the Latest
    // label, the author + released-this line.
    expect(html).toContain('href="/alice/wave20rel/releases/tag/w20-v1"');
    expect(html).toContain(">Wave20 v1</a>");
    expect(html).toContain('href="/alice/wave20rel/src/tag/w20-v1"');
    expect(html).toContain('<a class="muted tw-font-mono" href="/alice/wave20rel/src/commit/');
    expect(html).toContain('<span class="ui green label">Latest</span>');
    expect(html).toContain('<span class="author"><a href="/alice">alice</a></span>');
    expect(html).toContain("<span class=\"released\">released this</span>");
    // The notes through the markdown pipeline.
    expect(html).toContain("<strong>seed</strong>");
    // The slash-tag entry: Stable (not Latest), decoded link shape.
    expect(html).toContain('href="/alice/wave20rel/releases/tag/w20-v1.1/rc"');
    expect(html).toContain('<span class="ui green label">Stable</span>');
    // The draft is invisible.
    expect(html).not.toContain("w20-draft");
    expect(html).not.toContain('<span class="ui yellow label">Draft</span>');
  });

  it("renders the attachment row with the landed asset URL", async () => {
    const res = await fetchUi("/alice/wave20rel/releases");
    const html = await res.text();
    expect(html).toContain('download="" href="https://test.local/attachments/w20-asset-0001-fixed"');
    expect(html).toContain("<span class=\"gt-ellipsis\">w20-v1.zip</span>");
    expect(html).toContain("<span class=\"tw-pl-5\">1.5 kiB</span>");
    expect(html).toContain("svg octicon-package");
    expect(html).toContain("Downloads: 3");
    // The downloads block opens for the page's first entry.
    expect(html).toContain('<details class="download" open="">');
  });

  it("shows drafts to the writer with the Draft label and the New Release button", async () => {
    const res = await fetchUi("/alice/wave20rel/releases", withCookie(await aliceSession()));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(">3 Releases</a>");
    expect(html).toContain('href="/alice/wave20rel/releases/new"');
    expect(html).toContain(">New Release</a>");
    // The draft row: newest first (created DESC), the yellow Draft label
    // wins over Pre-Release (label.tmpl's if/else-if order), no
    // released-this line for drafts.
    expect(html.indexOf("Wave20 draft")).toBeGreaterThan(-1);
    expect(html).toContain('<span class="ui yellow label">Draft</span>');
    expect(html).not.toContain('<span class="ui orange label">Pre-Release</span>');
    expect(html.indexOf("Wave20 draft")).toBeLessThan(html.indexOf(">Wave20 v1</a>"));
    // The draft's own segment (between its title and the next entry) carries
    // no released-this line.
    const draftSegment = html.slice(html.indexOf("Wave20 draft"), html.indexOf(">Wave20 v1</a>"));
    expect(draftSegment).not.toContain("released this");
  });

  it("renders the empty anonymous list for the draft-only repo", async () => {
    const res = await fetchUi("/alice/wave20reldraft/releases");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(">0 Releases</a>");
    expect(html).toContain('<ul id="release-list"></ul>');
    expect(html).not.toContain("w20-d1");
  });

  it("404-shells the empty repo and the releases-disabled repo", async () => {
    // The empty-repo arm (upstream repo.MustBeNotEmpty): a D1-only repo row.
    const db = drizzle(env.DB);
    const alice = (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get())!;
    if (
      (await db
        .select({ id: repositories.id })
        .from(repositories)
        .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave20empty")))
        .get()) === undefined
    ) {
      await new RepoService(env.DB).create({
        owner: { id: alice.id, usernameLower: "alice" },
        name: "wave20empty",
        isPrivate: false,
        status: "ready",
      });
    }
    const emptyRes = await fetchUi("/alice/wave20empty/releases");
    expect(emptyRes.status).toBe(404);

    // The unit gate (the API family's has_releases 412 → the page shell).
    await saveRepoSettings(env.DB, (await ensureWave20Repos()).repoId, { hasReleases: false }, new Date(T0 * 1000));
    const disabled = await fetchUi("/alice/wave20rel/releases");
    expect(disabled.status).toBe(404);
    await saveRepoSettings(env.DB, (await ensureWave20Repos()).repoId, { hasReleases: true }, new Date(T0 * 1000));
  });
});

// --- the detail -----------------------------------------------------------------

describe("GET /{owner}/{repo}/releases/tag/{tag}", () => {
  it("renders the release detail through the same entry DOM", async () => {
    const res = await fetchUi("/alice/wave20rel/releases/tag/w20-v1");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content repository releases"');
    expect(html).toContain("<title>Wave20 v1 - alice/wave20rel</title>");
    expect(html).toContain('href="/alice/wave20rel/releases/tag/w20-v1"');
    expect(html).toContain('href="/alice/wave20rel/src/tag/w20-v1"');
    expect(html).toContain("<strong>seed</strong>");
    expect(html).toContain('download="" href="https://test.local/attachments/w20-asset-0001-fixed"');
    // The single-entry page: exactly one release-entry.
    expect(html.split('class="release-entry"').length - 1).toBe(1);
  });

  it("renders the slash tag through its URL shape", async () => {
    const res = await fetchUi("/alice/wave20rel/releases/tag/w20-v1.1/rc");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>Wave20 v1.1 RC - alice/wave20rel</title>");
    // No notes → the empty render-content div (upstream's raw RenderedNote).
    expect(html).toContain('<div class="render-content markup"></div>');
  });

  it("404s drafts for strangers and renders them for the writer", async () => {
    const anon = await fetchUi("/alice/wave20rel/releases/tag/w20-draft");
    expect(anon.status).toBe(404);
    const writer = await fetchUi("/alice/wave20rel/releases/tag/w20-draft", withCookie(await aliceSession()));
    expect(writer.status).toBe(200);
    expect(await writer.text()).toContain("Wave20 draft");
  });

  it("404s missing and tag-only records", async () => {
    const missing = await fetchUi("/alice/wave20rel/releases/tag/nope");
    expect(missing.status).toBe(404);
    // The tag-only record (is_tag) — the git-tag row the release family
    // never renders (the API family's assertNotTagRecord posture).
    const db = drizzle(env.DB);
    const alice = (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get())!;
    await new IssuesService(env.DB).createRelease({
      repoId: (await ensureWave20Repos()).repoId,
      publisherId: alice.id,
      tagName: "w20-tagonly",
      target: "main",
      isTag: true,
      now: new Date((T0 + 130) * 1000),
    });
    const tagOnly = await fetchUi("/alice/wave20rel/releases/tag/w20-tagonly");
    expect(tagOnly.status).toBe(404);
  });
});

// --- the latest redirect ----------------------------------------------------------

describe("GET /{owner}/{repo}/releases/latest", () => {
  it("303s onto the newest stable release's detail page", async () => {
    const res = await fetchUi("/alice/wave20rel/releases/latest");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/wave20rel/releases/tag/w20-v1");
  });

  it("404-shells when no stable release exists", async () => {
    const res = await fetchUi("/alice/wave20reldraft/releases/latest");
    expect(res.status).toBe(404);
  });
});

// --- the create form + write -------------------------------------------------------

describe("GET+POST /{owner}/{repo}/releases/new", () => {
  it("303s anonymous viewers onto the login round-trip (GET and POST)", async () => {
    const get = await fetchUi("/alice/wave20rel/releases/new");
    expect(get.status).toBe(303);
    expect(get.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent("/alice/wave20rel/releases/new")}`,
    );
    const postRes = await fetchUi(
      "/alice/wave20rel/releases/new",
      post("/alice/wave20rel/releases/new", "tag_name=x", "not-a-session"),
    );
    expect(postRes.status).toBe(303);
    expect(postRes.headers.get("location")).toContain("/login?redirect_to=");
  });

  it("404-shells signed-in non-writers and the archived repo", async () => {
    const stranger = await fetchUi("/alice/wave20rel/releases/new", withCookie(await bobSession()));
    expect(stranger.status).toBe(404);
    const db = drizzle(env.DB);
    await db
      .update(repositories)
      .set({ isArchived: true })
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave20rel")));
    const archived = await fetchUi("/alice/wave20rel/releases/new", withCookie(await aliceSession()));
    expect(archived.status).toBe(404);
    // The list's New Release button hides too (CanCreateRelease).
    const list = await fetchUi("/alice/wave20rel/releases", withCookie(await aliceSession()));
    expect((await list.text())).not.toContain('href="/alice/wave20rel/releases/new"');
    await db
      .update(repositories)
      .set({ isArchived: false })
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave20rel")));
  });

  it("renders the writer form over the branch universe", async () => {
    const res = await fetchUi("/alice/wave20rel/releases/new", withCookie(await aliceSession()));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content repository new release"');
    expect(html).toContain('action="/alice/wave20rel/releases/new" method="post"');
    expect(html).toContain('<input id="release-tag-name" type="text"');
    // The target select over the pushed branch universe, default selected.
    expect(html).toContain('<select id="release-tag-target" name="tag_target" class="ui selection dropdown">');
    expect(html).toContain('<option value="main" selected=""');
    expect(html).toContain("<strong>Mark as Pre-Release</strong>");
    expect(html).toContain("<strong>Save Draft</strong>");
    expect(html).toContain(">Publish Release</button>");
  });

  it("creates a published release and 303s onto its detail page", async () => {
    const before = (
      await drizzle(env.DB).select({ id: webhookDeliveries.id }).from(webhookDeliveries).all()
    ).length;
    const res = await fetchUi(
      "/alice/wave20rel/releases/new",
      post(
        "/alice/wave20rel/releases/new",
        new URLSearchParams({ tag_name: "w20-v2", tag_target: "main", title: "Wave20 v2", content: "Second **release**." }).toString(),
        await aliceSession(),
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/wave20rel/releases/tag/w20-v2");

    const db = drizzle(env.DB);
    const row = (
      await db
        .select()
        .from(releases)
        .where(and(eq(releases.repoId, (await ensureWave20Repos()).repoId), eq(releases.tagName, "w20-v2")))
        .get()
    )!;
    expect(row.isDraft).toBe(false);
    expect(row.isPrerelease).toBe(false);
    expect(row.title).toBe("Wave20 v2");
    expect(row.target).toBe("main");
    expect(row.publishedUnix).toBeGreaterThan(0);
    // The `release` webhook (NewRelease → "published") — the delivery row is
    // the awaited, request-visible step; the Queue producer is absent from
    // the test env, so the row stays pending (the emit seam's posture).
    const deliveries = await db.select().from(webhookDeliveries).all();
    expect(deliveries.length).toBe(before + 1);
    const delivery = deliveries[deliveries.length - 1]!;
    expect(delivery.eventType).toBe("release");
    expect(delivery.payloadContent).toContain('"published"');
    expect(delivery.payloadContent).toContain("w20-v2");
  });

  it("creates a draft silently (no webhook) when the draft checkbox rides", async () => {
    const before = (
      await drizzle(env.DB).select({ id: webhookDeliveries.id }).from(webhookDeliveries).all()
    ).length;
    const res = await fetchUi(
      "/alice/wave20rel/releases/new",
      post(
        "/alice/wave20rel/releases/new",
        new URLSearchParams({ tag_name: "w20-v3", tag_target: "main", title: "Wave20 v3", draft: "on", prerelease: "on" }).toString(),
        await aliceSession(),
      ),
    );
    expect(res.status).toBe(303);
    const db = drizzle(env.DB);
    const row = (
      await db
        .select()
        .from(releases)
        .where(and(eq(releases.repoId, (await ensureWave20Repos()).repoId), eq(releases.tagName, "w20-v3")))
        .get()
    )!;
    expect(row.isDraft).toBe(true);
    expect(row.isPrerelease).toBe(true);
    expect(row.publishedUnix).toBe(0);
    expect((await db.select({ id: webhookDeliveries.id }).from(webhookDeliveries).all()).length).toBe(before);
  });

  it("re-renders the form with the upstream messages and the kept submission", async () => {
    const form = (tag: string, title: string, extra: Record<string, string> = {}): string =>
      new URLSearchParams({ tag_name: tag, tag_target: "main", title, ...extra }).toString();

    // Duplicate tag (the landed create arm's 409 semantics).
    const duplicate = await fetchUi(
      "/alice/wave20rel/releases/new",
      post("/alice/wave20rel/releases/new", form(WAVE20_TAG, "Dup"), await aliceSession()),
    );
    expect(duplicate.status).toBe(200);
    const duplicateHtml = await duplicate.text();
    expect(duplicateHtml).toContain("A release with this tag name already exists.");
    expect(duplicateHtml).toContain('value="Dup"');

    // Empty title.
    const noTitle = await fetchUi(
      "/alice/wave20rel/releases/new",
      post("/alice/wave20rel/releases/new", form("w20-x", ""), await aliceSession()),
    );
    expect(noTitle.status).toBe(200);
    expect(await noTitle.text()).toContain("Title cannot be empty.");

    // Missing tag name.
    const noTag = await fetchUi(
      "/alice/wave20rel/releases/new",
      post("/alice/wave20rel/releases/new", form("", "T"), await aliceSession()),
    );
    expect(noTag.status).toBe(200);
    expect(await noTag.text()).toContain("Tag name is required.");

    // Unknown target branch.
    const badTarget = await fetchUi(
      "/alice/wave20rel/releases/new",
      post(
        "/alice/wave20rel/releases/new",
        new URLSearchParams({ tag_name: "w20-x", tag_target: "nope", title: "T" }).toString(),
        await aliceSession(),
      ),
    );
    expect(badTarget.status).toBe(200);
    expect(await badTarget.text()).toContain("Target branch does not exist.");
  });

  it("404-shells a stranger's POST before any write", async () => {
    const before = (await drizzle(env.DB).select({ id: releases.id }).from(releases).all()).length;
    const res = await fetchUi(
      "/alice/wave20rel/releases/new",
      post("/alice/wave20rel/releases/new", "tag_name=w20-evil&title=Evil", await bobSession()),
    );
    expect(res.status).toBe(404);
    expect((await drizzle(env.DB).select({ id: releases.id }).from(releases).all()).length).toBe(before);
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("wave-20 a11y smoke", () => {
  it("every new page passes the structural rules for its viewer", async () => {
    for (const [path, init] of [
      ["/alice/wave20rel/releases", undefined],
      ["/alice/wave20rel/releases", withCookie(await aliceSession())],
      ["/alice/wave20rel/releases/tag/w20-v1", undefined],
      ["/alice/wave20rel/releases/tag/w20-draft", withCookie(await aliceSession())],
      ["/alice/wave20rel/releases/new", withCookie(await aliceSession())],
      ["/alice/wave20reldraft/releases", undefined],
    ] as Array<[string, RequestInit | undefined]>) {
      const res = await fetchUi(path, init);
      expect(res.status, path).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});
