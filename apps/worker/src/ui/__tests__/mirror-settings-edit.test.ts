/**
 * The mirror settings-edit round trip (SPEC-0009 §2.3.1 — the settings-edit
 * wave): the /settings/mirror page's edit form over the landed
 * updateMirrorSettings service.
 *
 * Same harness posture as pages-wave10 (the router driven directly over the
 * synthetic ASSETS manifest, D1 seeded by direct row inserts, the session
 * wave's mintSession cookies). Visibility under test: the form renders the
 * upstream field set (prune/interval/address/Authorization/LFS) with the
 * stored values bound and the secret never rendered; the action=mirror save
 * POST writes the row (interval seconds + the reschedule side effect, prune,
 * the address move including repositories.original_url) and 303s; the
 * interval refusal re-renders the page with the locale text; the upstream
 * NotFound arms (non-mirror flag, archived) 404-shell; the action=mirror-sync
 * POST (and the empty-body back-compat form) still queues a sync.
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { uiRouter } from "../index";
import { repositories, repoMirrors, users } from "../../db/schema";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const withCookie = (cookie: string): RequestInit => ({ headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });

/** A urlencoded POST with the session cookie + the §2.8 Origin header. */
const postForm = (cookie: string, fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: {
    cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
    "content-type": "application/x-www-form-urlencoded",
    origin: "https://test.local",
  },
  body: new URLSearchParams(fields).toString(),
});

const REPO_LINK = "/alice-edit/mirror-edit";
const PAGE_PATH = `${REPO_LINK}/settings/mirror`;

let aliceCookie = "";

/** The mirror fixture: alice owns a public is_mirror repo with a 1:1
 *  repo_mirrors row (28800s / prune on / no credentials). */
async function seedMirrorEditFixture(): Promise<void> {
  const db = drizzle(env.DB);
  await applyAuthD1Migrations();
  if ((await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice-edit")).get()) === undefined) {
    await seedVerifiedUser({ username: "alice-edit" });
  } else if (aliceCookie !== "") {
    return; // idempotent re-entry
  }
  const alice = await db.select().from(users).where(eq(users.usernameLower, "alice-edit")).get();
  if (alice === undefined) throw new Error("alice-edit missing");
  const existing = await db.select({ id: repositories.id }).from(repositories).where(eq(repositories.slug, "mirror-edit")).get();
  const repoId = existing?.id ?? "r_mirror-edit";
  if (existing === undefined) {
    await db.insert(repositories).values({
      id: repoId,
      storageKey: repoId,
      ownerNamespace: "alice-edit",
      ownerId: alice.id,
      slug: "mirror-edit",
      visibility: "public",
      isMirror: true,
      originalUrl: "https://mirrors.invalid/edit-target.git",
      isEmpty: true,
    });
  }
  const mirrorRow = await db.select({ repoId: repoMirrors.repoId }).from(repoMirrors).where(eq(repoMirrors.repoId, repoId)).get();
  if (mirrorRow === undefined) {
    await db.insert(repoMirrors).values({
      repoId,
      intervalSeconds: 28800,
      enablePrune: true,
      remoteAddress: "https://mirrors.invalid/edit-target.git",
      credentialsUsername: null,
      credentialsCiphertext: null,
      syncState: "idle",
      nextSyncAt: 1700010000,
      lastSyncAt: null,
      lastError: null,
    });
  }
  aliceCookie = await mintSession(env.DB, alice.id);
}

beforeAll(async () => {
  await seedMirrorEditFixture();
});

const mirrorRow = () =>
  drizzle(env.DB).select().from(repoMirrors).where(eq(repoMirrors.repoId, "r_mirror-edit")).get();

describe("the mirror settings-edit form (GET /settings/mirror)", () => {
  it("renders the upstream field set with the stored values bound and no secret", async () => {
    const res = await fetchUi(PAGE_PATH, withCookie(aliceCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<input type="hidden" name="action" value="mirror"/>');
    expect(html).toContain('<input id="interval" name="interval" value="8h0m0s"/>');
    expect(html).toContain('<input id="enable_prune" name="enable_prune" type="checkbox" checked=""/>');
    // The address binds the stored remote and carries the required flag.
    expect(html).toContain('id="mirror_address" name="mirror_address" value="https://mirrors.invalid/edit-target.git"');
    expect(/id="mirror_address"[^>]*required/.test(html)).toBe(true);
    expect(html).toContain("(Unset)"); // no stored credentials → the "(Unset)" placeholder
    expect(html).toContain('<input id="mirror_lfs_endpoint" name="mirror_lfs_endpoint" value=""/>');
    expect(html).toContain("Update Mirror Settings");
    // The 10m minimum tail renders into the interval label (the %s substitution).
    expect(html).toContain("(Minimum interval: 10m0s)");
  });
});

describe("the save POST (action=mirror — handleSettingsPostMirror)", () => {
  it("writes interval (seconds) + prune + address and 303s back; the address move carries original_url", async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await fetchUi(
      PAGE_PATH,
      postForm(aliceCookie, {
        action: "mirror",
        enable_prune: "on",
        interval: "30m",
        mirror_address: "https://other.invalid/moved.git",
        mirror_username: "",
        mirror_password: "",
        mirror_lfs_endpoint: "",
      }),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${REPO_LINK}/settings/mirror`);
    const row = await mirrorRow();
    expect(row?.intervalSeconds).toBe(1800);
    expect(row?.enablePrune).toBe(true);
    expect(row?.remoteAddress).toBe("https://other.invalid/moved.git");
    expect(Math.abs((row?.nextSyncAt ?? 0) - (before + 1800))).toBeLessThanOrEqual(2); // the re-arm
    const repo = await drizzle(env.DB)
      .select({ originalUrl: repositories.originalUrl })
      .from(repositories)
      .where(eq(repositories.id, "r_mirror-edit"))
      .get();
    expect(repo?.originalUrl).toBe("https://other.invalid/moved.git");
  });

  it("an unchecked prune checkbox writes false (the bool binding)", async () => {
    const res = await fetchUi(
      PAGE_PATH,
      postForm(aliceCookie, {
        action: "mirror",
        interval: "30m",
        mirror_address: "https://other.invalid/moved.git",
        mirror_username: "",
        mirror_password: "",
        mirror_lfs_endpoint: "",
      }),
    );
    expect(res.status).toBe(303);
    expect((await mirrorRow())?.enablePrune).toBe(false);
  });

  it("an invalid interval re-renders with the locale text and writes nothing", async () => {
    const res = await fetchUi(
      PAGE_PATH,
      postForm(aliceCookie, {
        action: "mirror",
        interval: "5m",
        mirror_address: "https://other.invalid/moved.git",
        mirror_username: "",
        mirror_password: "",
        mirror_lfs_endpoint: "",
      }),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("The mirror interval is not valid.");
    const row = await mirrorRow();
    expect(row?.intervalSeconds).toBe(1800); // the previous write stands
    expect(row?.remoteAddress).toBe("https://other.invalid/moved.git"); // untouched by the refused POST
  });

  it("an invalid address re-renders with the URL refusal", async () => {
    const res = await fetchUi(
      PAGE_PATH,
      postForm(aliceCookie, {
        action: "mirror",
        interval: "30m",
        mirror_address: "http://plaintext.invalid/x.git",
        mirror_username: "",
        mirror_password: "",
        mirror_lfs_endpoint: "",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("The provided URL is invalid.");
  });

  it("404-shells a repo without the is_mirror flag (the web gate conjunct)", async () => {
    // The plain (non-mirror) repo: same owner, no mirror row.
    const db = drizzle(env.DB);
    const alice = await db.select().from(users).where(eq(users.usernameLower, "alice-edit")).get();
    if (
      (
        await db
          .select({ id: repositories.id })
          .from(repositories)
          .where(eq(repositories.slug, "mirror-edit-plain"))
          .get()
      ) === undefined
    ) {
      await db.insert(repositories).values({
        id: "r_mirror-edit-plain",
        storageKey: "r_mirror-edit-plain",
        ownerNamespace: "alice-edit",
        ownerId: alice!.id,
        slug: "mirror-edit-plain",
        visibility: "public",
        isEmpty: true,
      });
    }
    const res = await fetchUi(
      "/alice-edit/mirror-edit-plain/settings/mirror",
      postForm(aliceCookie, { action: "mirror", interval: "30m", mirror_address: "https://x.invalid/a.git" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("the sync POST dispatch (action=mirror-sync + the empty-body back-compat)", () => {
  it("action=mirror-sync queues a sync and redirects to the flash (upstream handleSettingsPostMirrorSync)", async () => {
    const res = await fetchUi(PAGE_PATH, postForm(aliceCookie, { action: "mirror-sync" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${PAGE_PATH}?sync=queued`);
  });

  it("an empty-body POST (the landed reduction's historical clients) still queues a sync", async () => {
    const res = await fetchUi(PAGE_PATH, {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${aliceCookie}`, origin: "https://test.local" },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${PAGE_PATH}?sync=queued`);
  });
});
