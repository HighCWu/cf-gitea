/**
 * The repo settings MIRROR panel's DEFERRED route-level matrix (pages/
 * settings.tsx mounted through uiRouter — GET+POST /{owner}/{repo}/settings/
 * mirror, the wave-10 block in ui/__tests__/pages-wave10.test.ts). Checked
 * first — deliberately NOT re-covered here: the wave-10 block owns the
 * parser tuple + the anonymous 303 / non-admin 404 on the GET, the admin's
 * base render (table cells, the ✓ prune arm, the idle sync state, the
 * honest-absence note), the not-a-mirror + archived-warning texts, the bare
 * POST 303 + `?sync=queued` flash presence/absence, the POST refusals
 * (not-mirror/archived 404, anon 303, non-admin 404) and the family's a11y
 * smoke. THIS FILE adds the open arms, driven over the mounted uiRouter on
 * the forks matrix's (3fbbc23) minted-session pattern —
 *
 *   - the §2.5 gate matrix on a PRIVATE mirror repo (wave-10's fixture repos
 *     were all public): anonymous and signed-in-stranger GETs AND POSTs
 *     404-shell invisibly-first (never the login 303 — the repo resolution
 *     fronts the settingsGate), while the owner AND the site admin render
 *     and write (the settingsGate's isAdmin admit wave-10 never exercised),
 *   - the POST enqueue arms over a recording MIRROR_SYNC_QUEUE: the exact
 *     `{kind: "mirror-sync", repoId}` channel literal, one message per POST
 *     (the producer never dedups — the consumer's CAS owns that), ZERO D1
 *     writes from the route itself, the no-queue 500 (the queue-missing
 *     text) and the enqueue-failed 500 — plus the FORCE/PRUNE FLAGS arm:
 *     upstream options.tmpl's edit-form fields (force, enable_prune,
 *     interval, mirror_address, mirror_lfs) ride the body INERTLY — the
 *     handler never reads it (no settings-write arm exists), so a flag
 *     bearing POST enqueues the identical single message and mutates no
 *     mirror setting,
 *   - the `?sync=queued` flash semantics beyond wave-10's presence pin: the
 *     %s substitution cites original_url while the table cell shows
 *     remote_address (the two MirrorStatus fields CAN diverge), the
 *     status-null suppression on a not-a-mirror repo, the strict value
 *     binding, and the param's display-only proof (no queue send, no D1
 *     mutation),
 *   - the §2.8 layer-2 cross-origin arms (wave-10's POSTs all carried a
 *     same-origin Origin): the guard-first 403 (fronts the gate, the repo
 *     resolution AND the enqueue — a foreign POST learns nothing about repo
 *     existence), the Referer fallback trio (foreign/malformed 403,
 *     same-origin proceeds), the header-less non-browser arm, and the GET's
 *     guardless navigation,
 *   - the render shapes wave-10's fixture could not carry: the ✗ prune,
 *     Not-scheduled, Never, queued sync-state and red Last-error lines, the
 *     LFS half of MirrorStatus staying off the page, and the scheduled
 *     relative-time stamps,
 *   - and the claim pins: the literal's case-sensitivity + no tail decoding,
 *     the plural/deeper unclaimed tails, the trailing-slash 301 (§4.13), and
 *     a repo literally named "settings" owning /{owner}/settings/mirror.
 *
 * One escalated divergence sits in this file as a FAILING probe (clearly
 * named RED below): upstream options.tmpl renders an ARCHIVED mirror's
 * section as the warning message ONLY (the table + Synchronize Now form live
 * in the `{{else}}` branch), while pages/settings.tsx renders the warning
 * AND the table AND the submit button — whose POST always 404s (a dead
 * control, the module's own §2.4.1 prohibition, undocumented as a
 * divergence). Escalated to the orchestrator rather than pinned green.
 *
 * Fixture posture: a disjoint `smx-*` family, D1-only rows (the panel and
 * the POST read/enqueue only — no git engine touch, no pack pushed); the
 * route never writes D1, so the fixture is immutable across the file;
 * sessions minted PER REQUEST (the value never asserted).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { repoMirrors, repositories, users } from "../../db/schema";
import { RepoService } from "../../repos/service";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { UiManifest } from "../manifest";

// --- the minted-session route harness (the forks 3fbbc23 pattern) ---------------

const ORIGIN = "https://test.local";

/** Synthetic manifest shaped like the real Vite output (deterministic, no
 *  build dependence — the shared fixture shape). */
const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

type RouteEnv = Omit<Env, "ASSETS" | "MIRROR_SYNC_QUEUE"> & {
  ASSETS?: UiAssetsFetcher;
  MIRROR_SYNC_QUEUE?: Queue;
};

const baseEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The real production path: parse → resolveUiSession → resolveUiRequest →
 *  the settingsGate → the arm, on the mounted uiRouter with the synthetic
 *  manifest; the execution context is awaited so any waitUntil settles. The
 *  optional override swaps binding values (the queue stubs below). */
async function fetchUi(path: string, init?: RequestInit, over: Partial<RouteEnv> = {}): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`${ORIGIN}${path}`, init), { ...baseEnv, ...over }, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A minted session cookie header for the username (the real mintSession
 *  path, minted per request — the value is never rendered). */
async function sessionCookie(username: string): Promise<string> {
  const row = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, username)).get();
  if (row === undefined) throw new Error(`fixture user missing: ${username}`);
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, row.id)}`;
}

/** Anonymous GET (name omitted) or a minted-session GET. */
async function get(path: string, as?: string): Promise<Response> {
  if (as === undefined) return fetchUi(path);
  return fetchUi(path, { headers: { cookie: await sessionCookie(as) } });
}

interface PostOptions {
  /** Minted-session identity when set (anonymous when omitted). */
  as?: string;
  /** The Origin header when set (absent when omitted — the fallback arms). */
  origin?: string;
  /** The Referer header when set (the Origin-absent fallback's input). */
  referer?: string;
  /** A urlencoded form body when set (the flag-bearing probes). */
  body?: Record<string, string>;
  /** The queue binding override — a recording stub for the observable-enqueue
   *  arms; OMITTED means explicitly ABSENT (the no-queue arm — the vitest env
   *  itself carries a live consumerless queue, so absence must be forced). */
  queue?: Queue;
}

/** A POST shaped by the options — the harness that lets each guard arm carry
 *  exactly the headers it is about (origin/referer/cookie pairing without
 *  the spread losses). The queue key is ALWAYS overridden: a stub when given,
 *  undefined otherwise. */
async function post(path: string, options: PostOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (options.as !== undefined) headers.cookie = await sessionCookie(options.as);
  if (options.origin !== undefined) headers.origin = options.origin;
  if (options.referer !== undefined) headers.referer = options.referer;
  return fetchUi(
    path,
    {
      method: "POST",
      headers,
      ...(options.body === undefined ? {} : { body: new URLSearchParams(options.body).toString() }),
    },
    { MIRROR_SYNC_QUEUE: options.queue },
  );
}

/** MIRROR_SYNC_QUEUE stub — records send bodies (the sync.test.ts shape;
 *  test-file copies are the precedent), with the enqueue-failure arm. */
function recordingQueue(options: { failSends?: boolean } = {}): Queue & { sent: unknown[] } {
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  const sent: unknown[] = [];
  return {
    sent,
    send: (body: unknown) => {
      if (options.failSends === true) return Promise.reject(new Error("queue unavailable"));
      sent.push(body);
      return Promise.resolve({ metadata });
    },
    sendBatch: () => Promise.resolve({ metadata }),
    metrics: () => Promise.resolve({ backlogCount: 0, backlogBytes: 0 }),
  };
}

// --- fixtures -----------------------------------------------------------------

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z — every row pinned to it

interface SmxFixture {
  publicId: string; // the enqueue/flash workhorse (original_url ≠ remote_address)
  shapesId: string; // the render extremes (✗ prune / not scheduled / never / error / lfs)
  vaultId: string; // the PRIVATE gates repo
  deadId: string; // the archived mirror (the escalated RED probe)
}

let smxFixture: SmxFixture | null = null;

async function seedMirror(
  repoId: string,
  opts: {
    remoteAddress: string;
    intervalSeconds?: number;
    enablePrune?: boolean;
    lfsEnabled?: boolean;
    lfsEndpoint?: string | null;
    syncState?: "idle" | "queued" | "syncing";
    nextSyncAt?: number;
    lastSyncAt?: number | null;
    lastError?: string | null;
  },
): Promise<void> {
  const existing = await drizzle(env.DB).select({ repoId: repoMirrors.repoId }).from(repoMirrors).where(eq(repoMirrors.repoId, repoId)).get();
  if (existing !== undefined) return;
  await drizzle(env.DB)
    .insert(repoMirrors)
    .values({
      repoId,
      intervalSeconds: opts.intervalSeconds ?? 28800,
      enablePrune: opts.enablePrune ?? true,
      lfsEnabled: opts.lfsEnabled ?? false,
      lfsEndpoint: opts.lfsEndpoint ?? null,
      remoteAddress: opts.remoteAddress,
      credentialsUsername: null,
      credentialsCiphertext: null,
      syncState: opts.syncState ?? "idle",
      nextSyncAt: opts.nextSyncAt ?? T0 + 28800,
      // NOT ?? — the null override (the Never arm) must survive the default.
      lastSyncAt: opts.lastSyncAt !== undefined ? opts.lastSyncAt : T0,
      lastError: opts.lastError ?? null,
      createdAt: new Date(T0 * 1000),
      updatedAt: new Date(T0 * 1000),
    });
}

/**
 * Seed the disjoint smx family once (the route never writes D1, so no
 * beforeEach wipe exists — every test reads the same immutable rows).
 * smx-owner owns everything; smx-pal is the signed-in stranger; smx-root is
 * the site admin (the settingsGate's isAdmin admit).
 */
async function ensureFixtures(): Promise<SmxFixture> {
  if (smxFixture !== null) return smxFixture;
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);

  const owner = await seedVerifiedUser({ username: "smx-owner" });
  await seedVerifiedUser({ username: "smx-pal" });
  await seedVerifiedUser({ username: "smx-root", isAdmin: true });

  const service = new RepoService(env.DB);
  const mk = async (slug: string, opts: { isPrivate?: boolean } = {}): Promise<string> => {
    const row = await service.create({
      owner: { id: owner.id, usernameLower: "smx-owner" },
      name: slug,
      isPrivate: opts.isPrivate ?? false,
      status: "ready",
    });
    return row.id;
  };

  const publicId = await mk("smx-public");
  // The flash's %s substitution reads original_url (upstream's
  // repo.OriginalURL) while the table cell reads remote_address — seeded
  // DIVERGENT so the differential is observable.
  await db.update(repositories).set({ originalUrl: "https://origin.invalid/smx-public.git" }).where(eq(repositories.id, publicId));
  await seedMirror(publicId, { remoteAddress: "https://mirrors.invalid/smx-public.git", intervalSeconds: 3600, nextSyncAt: T0 + 3600 });

  const shapesId = await mk("smx-shapes");
  await seedMirror(shapesId, {
    remoteAddress: "https://mirrors.invalid/smx-shapes.git",
    enablePrune: false,
    lfsEnabled: true,
    lfsEndpoint: "https://lfs.invalid/pull",
    syncState: "queued",
    nextSyncAt: 0,
    lastSyncAt: null,
    lastError: "denied by remote: repository is read-only",
  });

  const vaultId = await mk("smx-vault", { isPrivate: true });
  await seedMirror(vaultId, { remoteAddress: "https://mirrors.invalid/smx-vault.git" });

  const deadId = await mk("smx-dead");
  await db.update(repositories).set({ isArchived: true }).where(eq(repositories.id, deadId));
  await seedMirror(deadId, { remoteAddress: "https://mirrors.invalid/smx-dead.git" });

  // The shadow repos (no mirror rows): "settings" proves the three-segment
  // /{owner}/settings/mirror 404 is the parse's (the repo EXISTS); "mirror"
  // proves the settings literals compose as its tails.
  await mk("settings");
  await mk("mirror");
  // The flash-suppression repo (no mirror row).
  await mk("smx-plain");

  smxFixture = { publicId, shapesId, vaultId, deadId };
  return smxFixture;
}

beforeAll(async () => {
  await ensureFixtures();
});

/** The seeded mirror row of a repo (the untouched witnesses). */
async function mirrorRow(repoId: string) {
  const row = await drizzle(env.DB).select().from(repoMirrors).where(eq(repoMirrors.repoId, repoId)).get();
  if (row === undefined) throw new Error(`mirror row missing: ${repoId}`);
  return row;
}

// --- the §2.5 gates on a private mirror repo (the arms wave-10's public fixture could not carry) ---

describe("the gates on a private mirror repo (anon/stranger/owner/admin)", () => {
  it("404-shells an anonymous GET invisibly-first (never the login 303; existence hidden)", async () => {
    const res = await get("/smx-owner/smx-vault/settings/mirror");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("status-page-error");
    expect(html).not.toContain("Mirror Settings"); // the panel never renders
    expect(html).not.toContain("page-content repository settings mirror"); // no repo context either
  });

  it("404-shells a signed-in stranger's GET identically (no grant line admits him)", async () => {
    const res = await get("/smx-owner/smx-vault/settings/mirror", "smx-pal");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
  });

  it("admits the owner AND the site admin with the vault's own table (the isAdmin arm wave-10 never exercised)", async () => {
    for (const viewer of ["smx-owner", "smx-root"] as const) {
      const res = await get("/smx-owner/smx-vault/settings/mirror", viewer);
      expect(res.status, viewer).toBe(200);
      const html = await res.text();
      expect(html, viewer).toContain('class="page-content repository settings mirror"');
      expect(html, viewer).toContain("<td>https://mirrors.invalid/smx-vault.git</td>"); // THIS repo's panel
    }
  });

  it("404-shells an anonymous same-origin POST invisibly-first (the repo resolution fronts the settingsGate) with nothing enqueued", async () => {
    const queue = recordingQueue();
    const res = await post("/smx-owner/smx-vault/settings/mirror", { origin: ORIGIN, queue });
    expect(res.status).toBe(404); // NOT the public repo's 303 — the invisible-repo 404 wins
    expect(await res.text()).toContain("status-page-error");
    expect(queue.sent).toEqual([]); // nothing enqueued
  });

  it("404-shells a signed-in stranger's POST before any enqueue", async () => {
    const queue = recordingQueue();
    const res = await post("/smx-owner/smx-vault/settings/mirror", { as: "smx-pal", origin: ORIGIN, queue });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
    expect(queue.sent).toEqual([]);
  });

  it("admits the site admin's POST with the exact channel literal (the write-side isAdmin arm)", async () => {
    const fixture = await ensureFixtures();
    const queue = recordingQueue();
    const res = await post("/smx-owner/smx-vault/settings/mirror", { as: "smx-root", origin: ORIGIN, queue });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/smx-owner/smx-vault/settings/mirror?sync=queued");
    expect(queue.sent).toEqual([{ kind: "mirror-sync", repoId: fixture.vaultId }]);
  });
});

// --- the POST enqueue arms over a recording queue (the public mirror) ---------

describe("the POST enqueue arms (POST /smx-owner/smx-public/settings/mirror)", () => {
  it("enqueues exactly one {kind, repoId} message per POST, writes NO D1 state, and never dedups", async () => {
    const fixture = await ensureFixtures();
    const queue = recordingQueue();
    const first = await post("/smx-owner/smx-public/settings/mirror", { as: "smx-owner", origin: ORIGIN, queue });
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/smx-owner/smx-public/settings/mirror?sync=queued");
    expect(queue.sent).toEqual([{ kind: "mirror-sync", repoId: fixture.publicId }]);

    // The route itself writes NOTHING — the queued sync_state flip belongs to
    // the queue CONSUMER's CAS (the admin-cron producer's row-flip is the
    // other seam), so the row reads exactly as seeded.
    const row = await mirrorRow(fixture.publicId);
    expect(row.syncState).toBe("idle");
    expect(row.nextSyncAt).toBe(T0 + 3600);
    expect(row.lastSyncAt).toBe(T0);

    // The producer never dedups — a second POST enqueues a second identical
    // message (the consumer's CAS owns the collapse).
    const second = await post("/smx-owner/smx-public/settings/mirror", { as: "smx-owner", origin: ORIGIN, queue });
    expect(second.status).toBe(303);
    expect(queue.sent).toEqual([
      { kind: "mirror-sync", repoId: fixture.publicId },
      { kind: "mirror-sync", repoId: fixture.publicId },
    ]);
  });

  it("the FORCE/PRUNE FLAGS ride the body inertly: never read, never written — the identical single message enqueues", async () => {
    const fixture = await ensureFixtures();
    const queue = recordingQueue();
    const res = await post("/smx-owner/smx-public/settings/mirror", {
      as: "smx-owner",
      origin: ORIGIN,
      queue,
      // Upstream options.tmpl's edit-form fields (the settings-write arm that
      // does not exist here) plus an API-ish force flag: if the handler read
      // any of them, the row or the message would differ.
      body: {
        force: "1",
        enable_prune: "false",
        interval: "1s",
        mirror_address: "https://evil.invalid/hijack.git",
        mirror_lfs: "1",
      },
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/smx-owner/smx-public/settings/mirror?sync=queued");
    // The one message the channel carries — no force/prune variant exists.
    expect(queue.sent).toEqual([{ kind: "mirror-sync", repoId: fixture.publicId }]);

    // Every mirror setting survives the flag-bearing POST untouched.
    const row = await mirrorRow(fixture.publicId);
    expect(row.enablePrune).toBe(true);
    expect(row.intervalSeconds).toBe(3600);
    expect(row.remoteAddress).toBe("https://mirrors.invalid/smx-public.git");
    expect(row.lfsEnabled).toBe(false);
    expect(row.credentialsCiphertext).toBeNull();
  });

  it("answers the no-queue deployment with the queue-missing 500 plain-text shape", async () => {
    // post() leaves the binding ABSENT when no stub is given — and the vitest
    // env's own (consumerless) queue must not silently serve the enqueue, so
    // absence here is the forced no-queue arm.
    const res = await post("/smx-owner/smx-public/settings/mirror", { as: "smx-owner", origin: ORIGIN });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("The mirror sync queue is not configured on this deployment.\n");
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers an enqueue failure with the 500 'mirror sync enqueue failed' shape", async () => {
    const res = await post("/smx-owner/smx-public/settings/mirror", {
      as: "smx-owner",
      origin: ORIGIN,
      queue: recordingQueue({ failSends: true }),
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("mirror sync enqueue failed\n");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

// --- the ?sync=queued flash semantics ---------------------------------------------

describe("the queued-flash semantics (?sync=queued — the display-only reduction)", () => {
  it("substitutes original_url into the flash while the table cell shows remote_address (the two sources CAN diverge)", async () => {
    const res = await get("/smx-owner/smx-public/settings/mirror?sync=queued", "smx-owner");
    expect(res.status).toBe(200);
    const html = await res.text();
    // The flash cites the repositories row's sanitized origin (upstream's
    // repo.OriginalURL)…
    expect(html).toContain("Pulling changes from the remote https://origin.invalid/smx-public.git at the moment.");
    // …while the table's address cell reads the mirror row's remote_address.
    expect(html).toContain("<td>https://mirrors.invalid/smx-public.git</td>");
    expect(html).toContain('<div class="ui info message">');
  });

  it("suppresses the flash on a not-a-mirror repo (the status-null conjunction) — the empty state still renders", async () => {
    const res = await get("/smx-owner/smx-plain/settings/mirror?sync=queued", "smx-owner");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("Pulling changes"); // no URL to substitute — the conjunction holds
    expect(html).toContain("This repository is not a pull mirror.");
  });

  it("binds the param value strictly: ?sync=QUEUED and ?sync= render no flash", async () => {
    for (const query of ["?sync=QUEUED", "?sync="]) {
      const res = await get(`/smx-owner/smx-public/settings/mirror${query}`, "smx-owner");
      expect(res.status, query).toBe(200);
      expect(await res.text(), query).not.toContain("Pulling changes");
    }
  });

  it("the GET param never writes: no queue send, no D1 mutation (display-only state)", async () => {
    const fixture = await ensureFixtures();
    const queue = recordingQueue();
    const res = await fetchUi(
      "/smx-owner/smx-public/settings/mirror?sync=queued",
      { headers: { cookie: await sessionCookie("smx-owner") } },
      { MIRROR_SYNC_QUEUE: queue },
    );
    expect(res.status).toBe(200);
    expect(queue.sent).toEqual([]);
    const row = await mirrorRow(fixture.publicId);
    expect(row.syncState).toBe("idle");
    expect(row.lastSyncAt).toBe(T0);
  });
});

// --- the §2.8 layer-2 cross-origin arms ---------------------------------------------

describe("the cross-origin guard's arms (POST /settings/mirror)", () => {
  it("403s the owner's foreign-Origin POST guard-first (fronts the gate AND the enqueue) with zero side effects", async () => {
    const fixture = await ensureFixtures();
    const queue = recordingQueue();
    const res = await post("/smx-owner/smx-public/settings/mirror", {
      as: "smx-owner",
      origin: "https://evil.example",
      queue,
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("cross-origin request rejected\n");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(queue.sent).toEqual([]); // nothing enqueued
    const row = await mirrorRow(fixture.publicId);
    expect(row.syncState).toBe("idle"); // nothing written
  });

  it("403s a foreign-Origin POST even on an UNKNOWN repo (a cross-origin write learns nothing about existence)", async () => {
    const res = await post("/smx-nobody/nothing/settings/mirror", { as: "smx-owner", origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
  });

  it("falls back to Referer when Origin is absent: foreign and malformed 403, same-origin proceeds", async () => {
    const foreign = await post("/smx-owner/smx-public/settings/mirror", {
      as: "smx-owner",
      referer: "https://evil.example/bait",
    });
    expect(foreign.status).toBe(403);
    const malformed = await post("/smx-owner/smx-public/settings/mirror", {
      as: "smx-owner",
      referer: "not-a-url",
    });
    expect(malformed.status).toBe(403);

    const queue = recordingQueue();
    const same = await post("/smx-owner/smx-public/settings/mirror", {
      as: "smx-owner",
      referer: `${ORIGIN}/smx-owner/smx-public/settings/mirror`,
      queue,
    });
    expect(same.status).toBe(303);
    expect(queue.sent).toHaveLength(1);
  });

  it("admits the header-less POST (the non-browser-client arm) and the GET carries no guard at all", async () => {
    const queue = recordingQueue();
    const bare = await post("/smx-owner/smx-public/settings/mirror", { as: "smx-owner", queue });
    expect(bare.status).toBe(303);
    expect(queue.sent).toHaveLength(1);

    // The GET arm never consults the guard — a foreign-Origin GET renders
    // the panel like any navigation.
    const page = await get("/smx-owner/smx-public/settings/mirror", "smx-owner");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('class="page-content repository settings mirror"');
  });
});

// --- the render shapes beyond wave-10's presence pins -----------------------------

describe("the render shapes wave-10's fixture could not carry", () => {
  it("renders the status-line extremes: ✗ prune, Not scheduled, Never, the red Last error, Sync state: queued", async () => {
    const res = await get("/smx-owner/smx-shapes/settings/mirror", "smx-owner");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Sync state: queued");
    expect(html).toContain("Next sync: Not scheduled");
    expect(html).toContain("Last Synchronized: Never");
    expect(html).toContain("Prune (Remove obsolete remote-tracking references): ✗");
    expect(html).toContain("Last error: denied by remote: repository is read-only");
    expect(html).toContain("tw-text-red"); // the error line's red tint
  });

  it("keeps the LFS half of MirrorStatus off the page (the honest reduction — no dead controls)", async () => {
    const res = await get("/smx-owner/smx-shapes/settings/mirror", "smx-owner");
    expect(res.status).toBe(200);
    const html = await res.text();
    // lfs_enabled=true + lfs_endpoint are seeded; the panel renders neither a
    // section nor an input for them (upstream's LFS fields ride the edit
    // form that the no-settings-write-arm reduction dropped).
    expect(html).not.toContain("LFS");
    expect(html).not.toContain("lfs.invalid");
  });

  it("renders the scheduled Next sync / Last Synchronized as relative-time stamps", async () => {
    const res = await get("/smx-owner/smx-public/settings/mirror", "smx-owner");
    expect(res.status).toBe(200);
    const html = await res.text();
    // Both scheduled lines render the stamp element (the shell's Created
    // stamp is a third, nondeterministic one — the lines are pinned by name).
    expect(html).toContain("Next sync: <relative-time");
    expect(html).toContain("Last Synchronized: <relative-time");
  });
});

// --- the claim pins (parse ↔ registration, the family's own literals) --------------

describe("the settings-mirror claim pins", () => {
  it("binds the literal case-sensitively and WITHOUT decoding the tail segment (the raw-compare parity)", () => {
    expect(parseUiRoute("/smx-owner/smx-public/settings/Mirror")).toBeNull();
    // The githook name decodes its tail segment; the mirror literal does not
    // compare decoded text — m%69rror is not mirror.
    expect(parseUiRoute("/smx-owner/smx-public/settings/m%69rror")).toBeNull();
    expect(handlesUiRoute("/smx-owner/smx-public/settings/Mirror")).toBe(false);
  });

  it("leaves the plural and the deeper tails unclaimed — the sub-app's plain 404s, never the panel", async () => {
    expect(parseUiRoute("/smx-owner/smx-public/settings/mirrors")).toBeNull();
    expect(parseUiRoute("/smx-owner/smx-public/settings/mirror/x")).toBeNull();
    for (const path of ["/smx-owner/smx-public/settings/mirrors", "/smx-owner/smx-public/settings/mirror/x"]) {
      const res = await get(path, "smx-owner");
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain("Mirror Settings");
    }
  });

  it("301s the trailing slash onto the canonical literal at the sub-app seam (§4.13)", async () => {
    const res = await get("/smx-owner/smx-public/settings/mirror/", "smx-owner");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/smx-owner/smx-public/settings/mirror`);
  });

  it("the literals are tails, not repos: /{owner}/settings/mirror (a repo named settings) is UNCLAIMED, and a repo named mirror composes with them", async () => {
    // A three-segment /{owner}/settings/mirror reads repo "settings" with
    // head "mirror" — no family claims a bare /mirror tail, so the shape
    // stays unclaimed EVEN THOUGH the settings-named repo exists (the 404 is
    // the parse's, not the repo lookup's).
    expect(parseUiRoute("/smx-owner/settings/mirror")).toBeNull();
    expect(handlesUiRoute("/smx-owner/settings/mirror")).toBe(false);
    const unclaimed = await get("/smx-owner/settings/mirror", "smx-owner");
    expect(unclaimed.status).toBe(404);
    expect(await unclaimed.text()).not.toContain("Mirror Settings");

    // The composition arm: a repo literally named "mirror" claims the
    // settings literals as its own tails — its basics panel lives at
    // /{owner}/smx-mirror/settings and its mirror panel one segment deeper.
    expect(parseUiRoute("/smx-owner/smx-mirror/settings")).toEqual({
      family: "settings",
      owner: "smx-owner",
      repo: "smx-mirror",
    });
    expect(parseUiRoute("/smx-owner/smx-mirror/settings/mirror")).toEqual({
      family: "settings-mirror",
      owner: "smx-owner",
      repo: "smx-mirror",
    });
  });
});

// --- the escalated divergence (RED probe — see the file header) ---------------------

describe("the archived mirror's section (the escalated divergence)", () => {
  it("[RED — escalated, not pinned green] upstream renders an archived mirror's section as the warning ONLY; settings.tsx currently renders the table + Synchronize Now dead control too", async () => {
    const res = await get("/smx-owner/smx-dead/settings/mirror", "smx-owner");
    expect(res.status).toBe(200);
    const html = await res.text();
    // Upstream options.tmpl's `{{if .Repository.IsArchived}}` branch: the
    // warning message and NOTHING else — the table and its submit form live
    // in the {{else}} branch (and the POST here 404s, so the rendered button
    // is a dead control, the module's own §2.4.1 prohibition).
    expect(html).toContain("Mirrors are not available if the repo is archived.");
    expect(html).not.toContain("<td>https://mirrors.invalid/smx-dead.git</td>"); // FAILS today
    expect(html).not.toContain("Synchronize Now"); // FAILS today
  });
});
