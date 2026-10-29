/**
 * The repo settings LFS pages' matrix (pages/repo-settings-lfs.tsx over
 * ui/index.ts's four handlers — the census R11 arm): the read-only settings
 * LFS family driven BOTH at the module level (the loaders over real D1 +
 * the real R2 binding) and through `uiRouter.fetch()` on the real production
 * path (parse → resolveUiRequest → settingsGate → loader → render — the
 * repo-settings-tags matrix's minted-session pattern), over ONE engine-seeded
 * fixture world (testing/seed-repo.ts — REAL pointer blobs pushed through
 * the landed receive flow, the check-lfs-pointers.mjs fixture recipes):
 *
 *   - the parser claims: the four GET shapes (web.go:1249-1261's read arms)
 *     + the bare literal, the POST tails (delete/{oid}, pointers/associate,
 *     locks/*) staying UNCLAIMED (read-only pages this wave — the engine
 *     answers them, upstream's unregistered-route shape);
 *   - the scan/join/read (LFSPointerFiles' port): the engine-seeded
 *     candidates parse + dedup by git blob oid, the InRepo/Exists join over
 *     `lfs_objects` + the R2 store, the associatable arms (unassociated →
 *     true, admin-row arm, the cross-repo mid term's honest-absent
 *     reduction), the non-pointer/malformed/over-size skips, the found
 *     header counters;
 *   - the list (LFSFiles' port): the paged D1 read, the Total header, the
 *     Older/Newer pager, the empty state;
 *   - the detail (LFSFileGet's port): the text line-table, the binary
 *     View-Raw arm, the invalid-oid/meta-miss 404s;
 *   - the find (LFSFileFind's port): the canonical-pointer identity finds
 *     the in-tree path + the introducing commit, the sha param arm, the
 *     oid/size guard 404s, the no-commits empty state;
 *   - the settingsGate posture on every route (anonymous 303, signed-in
 *     non-admin 404 shell).
 *
 * The fixture world is the `alice` owner's `lfsserve` repo (public) with the
 * four pointer files of the matrix (associated+stored, missing, ghost-stored
 * unassociated, foreign-repo-associated) plus the non-pointer /
 * malformed / over-size skip fixtures. The LFS rows ride the landed state
 * service's table; the bytes ride the real R2 binding (the raw-files
 * matrix's RelayLfsStore posture).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { lfsObjects, repositories, repoSettings, users } from "../../db/schema";
import { generatePointer, pointerBlobSha1 } from "../../services/lfs/pointer";
import { RelayLfsStore, lfsKey } from "../../services/lfs/store";
import { listLfsMetaObjects, loadLfsPointerRows, LFS_LIST_PAGE_SIZE } from "../../services/lfs/read";
import { lfsRepoId } from "../../lfs/router";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import {
  loadLfsDetailPageData,
  loadLfsFilesPageData,
  loadLfsFindPageData,
  loadLfsPointersPageData,
} from "./repo-settings-lfs";
import type { UiManifest } from "../manifest";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

// The four LFS oids (deterministic 64-hex, the check-lfs-pointers fixture
// recipe) and their pointer texts (CANONICAL — generatePointer's bytes are
// what the find arm's canonical identity hashes).
const OID_ASSOCIATED = "aa".repeat(32); // in lfs_objects + stored → InRepo + Exists
const OID_MISSING = "bb".repeat(32); // neither → the NumNoExist arm
const OID_GHOST = "cc".repeat(32); // stored bytes, NO row anywhere → Associatable
const OID_FOREIGN = "dd".repeat(32); // stored bytes + a row in ANOTHER repo → the mid term's honest-absent
const OID_BINARY = "ee".repeat(32); // row + binary stored bytes → the detail's View-Raw arm

const POINTER_ASSOCIATED = new TextDecoder().decode(generatePointer(OID_ASSOCIATED, 123456));
const POINTER_MISSING = new TextDecoder().decode(generatePointer(OID_MISSING, 789));
const POINTER_GHOST = new TextDecoder().decode(generatePointer(OID_GHOST, 42));
const POINTER_FOREIGN = new TextDecoder().decode(generatePointer(OID_FOREIGN, 7));
const POINTER_BINARY = new TextDecoder().decode(generatePointer(OID_BINARY, 8));

const ASSOCIATED_BYTES = new TextEncoder().encode("hello lfs bytes\nsecond line\n");
const BINARY_BYTES = Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]); // NUL in the probe — binary

// The skip fixtures: a pointer-SHAPED malformed oid (the worker parse
// rejects — upstream's discarded-error IsValid arm) and an over-1024-byte
// pointer-shaped blob (the ENGINE size gate skips — never a candidate).
const MALFORMED_POINTER = `version https://git-lfs.github.com/spec/v1\noid sha256:${"zz".repeat(32)}\nsize 5\n`;
const OVERSIZE_POINTER = `${POINTER_GHOST}${"x".repeat(1100)}`;

const COMMITS: SeedCommit[] = [
  { message: "seed: readme", time: 1_700_000_000, files: [{ path: "README.md", content: "# lfsserve v1\n" }] },
  {
    message: "seed: lfs assets",
    time: 1_700_000_500,
    files: [
      { path: "README.md", content: "# lfsserve v1\n" }, // cumulative trees — the builder's shape
      { path: "assets/present.bin", content: new TextEncoder().encode(POINTER_ASSOCIATED) },
      // The SAME pointer text at a second path — the engine answers two
      // candidates; the join dedups to one row (upstream's object-keyed scan).
      { path: "assets/dup.bin", content: new TextEncoder().encode(POINTER_ASSOCIATED) },
      { path: "assets/model.bin", content: new TextEncoder().encode(POINTER_MISSING) },
      { path: "assets/ghost.ptr", content: new TextEncoder().encode(POINTER_GHOST) },
      { path: "assets/shared.ptr", content: new TextEncoder().encode(POINTER_FOREIGN) },
      { path: "assets/blobby.ptr", content: new TextEncoder().encode(POINTER_BINARY) },
      { path: "assets/broken.ptr", content: new TextEncoder().encode(MALFORMED_POINTER) },
      { path: "assets/huge.ptr", content: new TextEncoder().encode(OVERSIZE_POINTER) },
      { path: "assets/notes.txt", content: new TextEncoder().encode("plain notes — a non-pointer candidate\n") },
    ],
  },
];

interface FixtureWorld {
  repoId: string;
  storageKey: string;
  ownerId: number;
  otherRepoId: string;
  emptyRepoId: string;
  bobId: number;
}

let world: FixtureWorld | null = null;

async function ensureFixtures(): Promise<FixtureWorld> {
  if (world !== null) return world;
  await applyAuthD1Migrations();
  await ensureSeededRepo({ owner: "alice", slug: "lfsserve", commits: COMMITS });
  const db = drizzle(env.DB);
  const repoRow = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "lfsserve")))
    .get();
  if (repoRow === undefined) throw new Error("lfsserve repo row missing");
  const owner = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get();
  if (owner === undefined) throw new Error("alice row missing");
  const bobRow = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "bob")).get();
  const bobId = bobRow !== undefined ? bobRow.id : (await seedVerifiedUser({ username: "bob" })).id;

  // The non-admin's second world repo (the foreign-row arm + the null-ladder
  // arms) — D1-only, its engine cell is never touched. A THIRD repo with no
  // LFS rows carries the empty-state arms.
  const otherRepoId = crypto.randomUUID();
  await db.insert(repositories).values({
    id: otherRepoId,
    storageKey: `r_${otherRepoId}`,
    ownerNamespace: "alice",
    ownerId: owner.id,
    slug: "lfsother",
    visibility: "private",
    defaultBranch: "main",
    isEmpty: true,
    status: "ready",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  const emptyRepoId = crypto.randomUUID();
  await db.insert(repositories).values({
    id: emptyRepoId,
    storageKey: `r_${emptyRepoId}`,
    ownerNamespace: "alice",
    ownerId: owner.id,
    slug: "lfsempty",
    visibility: "private",
    defaultBranch: "main",
    isEmpty: true,
    status: "ready",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  const now = new Date("2026-02-03T04:05:06Z");
  await db.insert(lfsObjects).values([
    { repoId: lfsRepoId(repoRow.id), oid: OID_ASSOCIATED, size: 123456, state: "verified", createdAt: now, updatedAt: now },
    { repoId: lfsRepoId(repoRow.id), oid: OID_BINARY, size: 8, state: "verified", createdAt: now, updatedAt: now },
    { repoId: lfsRepoId(otherRepoId), oid: OID_FOREIGN, size: 7, state: "verified", createdAt: now, updatedAt: now },
  ]);

  // The stored bytes under THIS repo's keyspace (Exists = the repo's store).
  const store = new RelayLfsStore(env.REPO_PACKS);
  await store.put(lfsKey(repoRow.storageKey, OID_ASSOCIATED), ASSOCIATED_BYTES);
  await store.put(lfsKey(repoRow.storageKey, OID_GHOST), new TextEncoder().encode("ghost bytes"));
  await store.put(lfsKey(repoRow.storageKey, OID_FOREIGN), new TextEncoder().encode("foreign bytes"));
  await store.put(lfsKey(repoRow.storageKey, OID_BINARY), BINARY_BYTES);

  world = { repoId: repoRow.id, storageKey: repoRow.storageKey, ownerId: owner.id, otherRepoId, emptyRepoId, bobId };
  return world;
}

// --- the mounted-route harness (the repo-settings-tags matrix pattern) -------

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`${ORIGIN}${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

const REPO_PATH = "/alice/lfsserve";

async function adminGet(path: string): Promise<Response> {
  const w = await ensureFixtures();
  return fetchUi(path, { headers: { cookie: await sessionHeader(w.ownerId) } });
}

async function nonAdminGet(path: string): Promise<Response> {
  const w = await ensureFixtures();
  return fetchUi(path, { headers: { cookie: await sessionHeader(w.bobId) } });
}

beforeAll(async () => {
  await ensureFixtures();
});

// --- 1. the parser claims ------------------------------------------------------

describe("the parser claims (web.go:1249-1261's read arms)", () => {
  it("claims the four GET shapes", () => {
    expect(parseUiRoute("/alice/lfsserve/settings/lfs")).toEqual({ family: "settings-lfs", owner: "alice", repo: "lfsserve" });
    expect(parseUiRoute("/alice/lfsserve/settings/lfs/show/deadbeef")).toEqual({
      family: "settings-lfs-show",
      owner: "alice",
      repo: "lfsserve",
      name: "deadbeef",
    });
    expect(parseUiRoute("/alice/lfsserve/settings/lfs/pointers")).toEqual({
      family: "settings-lfs-pointers",
      owner: "alice",
      repo: "lfsserve",
    });
    expect(parseUiRoute("/alice/lfsserve/settings/lfs/find")).toEqual({
      family: "settings-lfs-find",
      owner: "alice",
      repo: "lfsserve",
    });
    expect(handlesUiRoute("/alice/lfsserve/settings/lfs")).toBe(true);
  });

  it("leaves the write tails and junk shapes unclaimed (read-only pages — the engine answers)", () => {
    expect(parseUiRoute("/alice/lfsserve/settings/lfs/delete/deadbeef")).toBeNull();
    expect(parseUiRoute("/alice/lfsserve/settings/lfs/pointers/associate")).toBeNull();
    expect(parseUiRoute("/alice/lfsserve/settings/lfs/locks")).toBeNull();
    expect(parseUiRoute("/alice/lfsserve/settings/lfs/show")).toBeNull(); // the bare show literal — no oid
    expect(parseUiRoute("/alice/lfsserve/settings/lfs/extra/deep")).toBeNull();
    // The trailing slash: the parse claims it (the canonical-form 301 shape —
    // the index.test table's "/octo/hello/" row); the DISPATCHER's
    // endsWith rule, not the parser, keeps the engine on slashed URLs.
    expect(handlesUiRoute("/alice/lfsserve/settings/lfs/")).toBe(true);
  });
});

// --- 2. the scan/join/read (LFSPointerFiles' port, module level) ---------------

describe("loadLfsPointerRows (the engine scan + the worker join)", () => {
  it("parses, dedups by git blob oid, and joins InRepo/Exists/Associatable with the upstream counters", async () => {
    const w = await ensureFixtures();
    const scan = (ref: string | undefined, opts?: { path?: string; oid?: string }) =>
      env.REPO.getByName("alice/lfsserve").scanLfsPointers(ref, opts);
    const scanned = await loadLfsPointerRows(env.DB, new RelayLfsStore(env.REPO_PACKS), scan, {
      repoId: lfsRepoId(w.repoId),
      storageKey: w.storageKey,
      viewerIsAdmin: false,
    });
    if (scanned.answer === null) throw new Error("the engine scan answered null on a seeded repo");
    const { pointers, counters, truncated } = scanned.answer;
    expect(truncated).toBe(false);
    // dedup: present.bin + dup.bin share the pointer text → ONE row; broken/
    // huge/notes skip (malformed / over-size gate / non-pointer). Unique
    // pointers: present(aa) model(bb) ghost(cc) shared(dd) blobby(ee) = 5.
    expect(pointers).toHaveLength(5);
    const byOid = new Map(pointers.map((p) => [p.oid, p]));
    const associated = byOid.get(OID_ASSOCIATED);
    expect(associated).toMatchObject({ inRepo: true, exists: true, associatable: false, accessible: true });
    expect(associated?.path).toBe("assets/dup.bin"); // tree order — the FIRST path (dup < present) stands
    expect(byOid.get(OID_MISSING)).toMatchObject({ inRepo: false, exists: false, associatable: false, accessible: false });
    expect(byOid.get(OID_GHOST)).toMatchObject({ inRepo: false, exists: true, associatable: true, accessible: true });
    // The mid term's honest-absent: a row in ANOTHER repo is not provable
    // accessible at this pin — associatable false (the read.ts header).
    expect(byOid.get(OID_FOREIGN)).toMatchObject({ inRepo: false, exists: true, associatable: false, accessible: false });
    expect(byOid.get(OID_BINARY)).toMatchObject({ inRepo: true, exists: true, accessible: true });
    expect(counters).toEqual({ numPointers: 5, numAssociated: 2, numAssociatable: 1, numNoExist: 1, numNotAssociated: 3 });
    // The blobSha column is the GIT blob oid of the canonical pointer text.
    expect(associated?.blobSha).toBe(await pointerBlobSha1({ oid: OID_ASSOCIATED, size: 123456 }));
  });

  it("an admin viewer reads the foreign row as associatable (the admin arm of the join)", async () => {
    const w = await ensureFixtures();
    const scan = (ref: string | undefined, opts?: { path?: string; oid?: string }) =>
      env.REPO.getByName("alice/lfsserve").scanLfsPointers(ref, opts);
    const scanned = await loadLfsPointerRows(env.DB, new RelayLfsStore(env.REPO_PACKS), scan, {
      repoId: lfsRepoId(w.repoId),
      storageKey: w.storageKey,
      viewerIsAdmin: true,
    });
    if (scanned.answer === null) throw new Error("the engine scan answered null on a seeded repo");
    const foreign = scanned.answer.pointers.find((p) => p.oid === OID_FOREIGN);
    expect(foreign).toMatchObject({ associatable: true, accessible: true });
    expect(scanned.answer.counters.numAssociatable).toBe(2);
  });

  it("the engine's null ladder renders the found-0 empty state (LFSPointerFiles on an unborn HEAD)", async () => {
    const w = await ensureFixtures();
    const otherRow = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, w.otherRepoId)).get())!;
    const data = await loadLfsPointersPageData(env, otherRow, false);
    expect(data.pointers).toEqual([]);
    expect(data.counters.numPointers).toBe(0);
  });
});

// --- 3. the list (LFSFiles' port, module level) --------------------------------

describe("listLfsMetaObjects (the paged D1 read)", () => {
  it("answers the total and the oid-ordered page; the page clamp skips past the end", async () => {
    const w = await ensureFixtures();
    const first = await listLfsMetaObjects(env.DB, lfsRepoId(w.repoId), 1);
    expect(first.total).toBe(2); // the associated row + the binary row
    expect(first.rows.map((r) => r.oid)).toEqual([OID_ASSOCIATED, OID_BINARY].sort((a, b) => (a < b ? -1 : 1)));
    const past = await listLfsMetaObjects(env.DB, lfsRepoId(w.repoId), 9);
    expect(past.rows).toEqual([]);
    expect(past.total).toBe(2);
    expect(LFS_LIST_PAGE_SIZE).toBe(20); // ExplorePagingNum's default — the pager's stride
  });

  it("the detail loader arms: text content, the binary View-Raw arm, and the 404s", async () => {
    const w = await ensureFixtures();
    const repoRow = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, w.repoId)).get())!;
    const text = await loadLfsDetailPageData(env, repoRow, OID_ASSOCIATED);
    expect(text).not.toBeNull();
    expect(text?.meta.size).toBe(123456);
    expect(text?.content).toEqual({ kind: "text", lines: ["hello lfs bytes", "second line"] });
    expect(text?.rawLink).toBe(`/alice/lfsserve.git/info/lfs/objects/${OID_ASSOCIATED}`);

    const binary = await loadLfsDetailPageData(env, repoRow, OID_BINARY);
    expect(binary?.content.kind).toBe("binary");

    await expect(loadLfsDetailPageData(env, repoRow, "nothex")).resolves.toBeNull(); // the IsValid arm
    await expect(loadLfsDetailPageData(env, repoRow, OID_MISSING)).resolves.toBeNull(); // the meta-miss arm
  });
});

// --- 4. the find (LFSFileFind's port, module level) ----------------------------

describe("loadLfsFindPageData (the canonical-pointer identity over the tip scan)", () => {
  it("finds the in-tree paths and the introducing commit; the sha param arm answers the same rows", async () => {
    const w = await ensureFixtures();
    const repoRow = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, w.repoId)).get())!;
    const data = await loadLfsFindPageData(env, repoRow, OID_ASSOCIATED, 123456);
    expect(data).not.toBeNull();
    // BOTH paths carry the pointer (present.bin + dup.bin) — upstream's
    // results map is (commit, path)-keyed, so two rows here too. The order
    // for the shared-When tie is our stable sort's insertion order — the
    // tree walk (dup < present, the scan pin above) — upstream itself is
    // nondeterministic there (Go map iteration feeding an unstable sort).
    expect(data?.results).toHaveLength(2);
    expect(data?.results.map((r) => r.path)).toEqual(["assets/dup.bin", "assets/present.bin"]);
    const row = data?.results[0];
    expect(row?.summary).toBe("seed: lfs assets");
    expect(row?.branchName).toBe("main");
    expect(row?.when).toBe(1_700_000_500);
    expect(row?.tz).toBe("+0000");
    expect(row?.parentHashes).toHaveLength(1); // the readme commit

    // The sha arm: the pointers table emits &sha=<blobSha> — the same rows
    // (the identity matches the canonical text's git oid either way).
    const blobSha = await pointerBlobSha1({ oid: OID_ASSOCIATED, size: 123456 });
    const bySha = await loadLfsFindPageData(env, repoRow, OID_ASSOCIATED, 123456, blobSha);
    expect(bySha?.results.map((r) => r.path)).toEqual(data?.results.map((r) => r.path));
  });

  it("the guards: empty oid, zero size, junk oid, and an unknown-but-valid oid (the empty state)", async () => {
    const w = await ensureFixtures();
    const repoRow = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, w.repoId)).get())!;
    await expect(loadLfsFindPageData(env, repoRow, "", 123)).resolves.toBeNull();
    await expect(loadLfsFindPageData(env, repoRow, OID_ASSOCIATED, 0)).resolves.toBeNull();
    await expect(loadLfsFindPageData(env, repoRow, "nothex", 123)).resolves.toBeNull();
    const unknown = await loadLfsFindPageData(env, repoRow, "ab".repeat(32), 5);
    expect(unknown?.results).toEqual([]); // lfs_file_find.tmpl's empty row
  });
});

// --- 5. the mounted routes — the settingsGate posture + the DOM contracts ------

describe("the mounted routes (the census R11 arm through uiRouter)", () => {
  it("303s an anonymous GET onto the login round-trip on every family (the settingsGate)", async () => {
    for (const tail of ["lfs", "lfs/show/deadbeef", "lfs/pointers", "lfs/find"]) {
      const res = await fetchUi(`${REPO_PATH}/settings/${tail}`);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`/login?redirect_to=${encodeURIComponent(`${REPO_PATH}/settings/${tail}`)}`);
    }
  });

  it("404-shells a signed-in non-admin's GET (the reqRepoAdmin posture)", async () => {
    const res = await nonAdminGet(`${REPO_PATH}/settings/lfs`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("status-page-error");
    expect(html).not.toContain("repository settings lfs");
  });

  it("renders the list page with the settings nav LFS item lit, the Total header and the find links", async () => {
    const res = await adminGet(`${REPO_PATH}/settings/lfs`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("repository settings lfs"); // the §2.4.1 pageClass discriminator
    expect(html).toContain("LFS files stored in this repository");
    expect(html).toContain("Total: 2");
    expect(html).toContain(`href="${REPO_PATH}/settings/lfs/show/${OID_ASSOCIATED}"`);
    expect(html).toContain(`href="${REPO_PATH}/settings/lfs/find?oid=${OID_ASSOCIATED}&amp;size=123456"`);
    // The nav item: the lit anchor + the pointer-files button; the dead
    // Locks anchor and the delete dialog stay unrendered (the write arms).
    expect(html).toContain(`href="${REPO_PATH}/settings/lfs">LFS</a>`);
    expect(html).toContain("Find pointer files");
    expect(html).not.toContain("/settings/lfs/locks");
    expect(html).not.toContain("delete-lfs-object");
  });

  it("lights the nav's Actions block only while repo_settings.has_actions is set (navbar.tmpl:47's unit conditional — the hasActions threading)", async () => {
    const w = await ensureFixtures();
    const db = drizzle(env.DB);
    // The reduced default: no repo_settings row (the store default reads
    // false) renders no Actions block.
    const reduced = await adminGet(`${REPO_PATH}/settings/lfs`);
    expect(reduced.status).toBe(200);
    expect(await reduced.text()).not.toContain("/settings/actions/secrets");
    // The armed flip: the unit-flag row lights the <details> + sub-items.
    await db.insert(repoSettings).values({ repoId: w.repoId, hasActions: true }).onConflictDoNothing();
    try {
      const armed = await adminGet(`${REPO_PATH}/settings/lfs`);
      expect(armed.status).toBe(200);
      const html = await armed.text();
      expect(html).toContain(`href="${REPO_PATH}/settings/actions/secrets"`);
      expect(html).toContain(`href="${REPO_PATH}/settings/actions/variables"`);
    } finally {
      await db.delete(repoSettings).where(eq(repoSettings.repoId, w.repoId));
    }
  });

  it("renders the pointers page with the found header and the three check columns", async () => {
    const res = await adminGet(`${REPO_PATH}/settings/lfs/pointers`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Found 5 blob pointer(s) — 2 associated, 3 unassociated (1 missing from store)");
    expect(html).toContain(`href="${REPO_PATH}/raw/blob/`);
    expect(html).toContain(`href="${REPO_PATH}/settings/lfs/find?oid=${OID_GHOST}&amp;size=42&amp;sha=`);
    expect(html).toContain("In Repo");
    expect(html).toContain("Exists in store");
    expect(html).toContain("Accessible to User");
    expect(html).not.toContain("/pointers/associate"); // the write arm unrendered
  });

  it("renders the detail page's line table for text and the 404 arms", async () => {
    const ok = await adminGet(`${REPO_PATH}/settings/lfs/show/${OID_ASSOCIATED}`);
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain(`<span class="truncate sha">${OID_ASSOCIATED}</span>`);
    expect(html).toContain("lines-num");
    expect(html).toContain("hello lfs bytes");
    expect((await adminGet(`${REPO_PATH}/settings/lfs/show/${OID_MISSING}`)).status).toBe(404);
    expect((await adminGet(`${REPO_PATH}/settings/lfs/show/nothex`)).status).toBe(404);
  });

  it("renders the find page's result rows and its guards", async () => {
    const ok = await adminGet(`${REPO_PATH}/settings/lfs/find?oid=${OID_ASSOCIATED}&size=123456`);
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain("assets/present.bin");
    expect(html).toContain("seed: lfs assets");
    expect(html).toContain(`${REPO_PATH}/commit/`);
    expect(html).toContain("main");

    const empty = await adminGet(`${REPO_PATH}/settings/lfs/find?oid=${"ab".repeat(32)}&size=5`);
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain("No Commits found for this LFS file");

    expect((await adminGet(`${REPO_PATH}/settings/lfs/find?size=5`)).status).toBe(404);
    expect((await adminGet(`${REPO_PATH}/settings/lfs/find?oid=${OID_ASSOCIATED}`)).status).toBe(404);
  });

  it("renders the empty list state on a repo without LFS rows", async () => {
    const w = await ensureFixtures();
    const emptyRow = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, w.emptyRepoId)).get())!;
    const data = await loadLfsFilesPageData(env, emptyRow, 1);
    expect(data.total).toBe(0);
    expect(data.rows).toEqual([]);
  });
});
