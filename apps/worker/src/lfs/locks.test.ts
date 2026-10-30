/**
 * LFS locks API on the real bindings (SPEC-0006 §2.7) — the four
 * `info/lfs/locks*` routes against upstream `services/lfs/locks.go` at the
 * pin: full worker path (gate branch → parseLfsRoute → handleLocks →
 * LfsLockService). Arm-by-arm parity with the upstream integration test
 * (tests/integration/api_repo_lfs_locks_test.go): case-insensitive +
 * PathJoinRel-normalized 409 echoes, second-rounded `locked_at`, the
 * requireSigned 401s with route-specific messages, the read-scope verify
 * quirk, cursor paging with the 0/1 alias quirk, and the upstream-exact
 * unlock 500s (no 404/403 arm at this pin — locks.go:311-318).
 */

import { SELF, env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { basicTokenHeader, mintFor, resetAuthTables, seedVerifiedUser } from "../auth/testing/seeds";
import { repositories } from "../db/schema";
import { LFS_MEDIA_TYPE } from "../services/lfs/batch";
import {
  goParseInt64,
  goParseInt64ErrorText,
  pathJoinRel,
  rfc3339Seconds,
} from "../services/lfs/locks";
import { applyLfsObjectsDdl, resetLfsTables } from "../services/lfs/testing";
import { parseLfsRoute } from "./router";

const LOCKS_JSON = "application/json;charset=utf-8";

beforeAll(async () => {
  // Applies the generated Drizzle migrations (0045 creates `lfs_locks`).
  await applyLfsObjectsDdl();
});

beforeEach(async () => {
  await resetAuthTables();
  await env.DB.prepare("DELETE FROM repositories").run();
  await resetLfsTables();
});

// --- fixtures -----------------------------------------------------------------

interface SeededRepo {
  id: string;
  storageKey: string;
  owner: string;
  slug: string;
}

async function seedRepo(
  ownerNamespace: string,
  slug: string,
  visibility: "public" | "private",
  options: { isArchived?: boolean } = {},
): Promise<SeededRepo> {
  const id = crypto.randomUUID();
  await drizzle(env.DB)
    .insert(repositories)
    .values({
      id,
      storageKey: `r_${id}`,
      ownerNamespace,
      slug,
      visibility,
      ...(options.isArchived === true ? { isArchived: true } : {}),
    })
    .run();
  return { id, storageKey: `r_${id}`, owner: ownerNamespace, slug };
}

interface Fixtures {
  alice: { id: number; username: string };
  bob: { id: number; username: string };
  admin: { id: number; username: string };
  write: string;
  read: string;
  wrongScope: string;
  publicOnly: string;
  adminWrite: string;
  publicRepo: SeededRepo;
  privateRepo: SeededRepo;
  archivedRepo: SeededRepo;
}

async function seedFixtures(): Promise<Fixtures> {
  const alice = await seedVerifiedUser({ username: "Alice" });
  const bob = await seedVerifiedUser({ username: "Bob" });
  const admin = await seedVerifiedUser({ username: "root", isAdmin: true });
  const mint = async (user: { id: number }, name: string, scopes: string) =>
    (await mintFor(user.id, name, scopes)).plaintext;
  return {
    alice,
    bob,
    admin,
    write: await mint(alice, "locks-write", "write:repository"),
    read: await mint(alice, "locks-read", "read:repository"),
    wrongScope: await mint(alice, "locks-wrong", "write:user"),
    publicOnly: await mint(alice, "locks-public-only", "write:repository,public-only"),
    adminWrite: await mint(admin, "locks-admin", "write:repository"),
    publicRepo: await seedRepo("alice", "public", "public"),
    privateRepo: await seedRepo("alice", "private", "private"),
    archivedRepo: await seedRepo("alice", "frozen", "public", { isArchived: true }),
  };
}

function repoUrl(repo: SeededRepo): string {
  return `http://example.com/${repo.owner}/${repo.slug}.git/info/lfs`;
}

function locksUrl(repo: SeededRepo, tail = ""): string {
  return `${repoUrl(repo)}/locks${tail}`;
}

interface LockOptions {
  method: "GET" | "POST";
  token?: string;
  body?: unknown;
  accept?: string | null;
  extraHeaders?: Record<string, string>;
}

function lockFetch(url: string, options: LockOptions): Promise<Response> {
  // accept: undefined → the git-lfs default, string → verbatim, null → no header.
  const accept = options.accept === undefined ? "application/vnd.git-lfs+json" : options.accept;
  const headers: Record<string, string> = {
    ...(accept !== null ? { accept } : {}),
    ...(options.token !== undefined ? { authorization: basicTokenHeader(options.token) } : {}),
    ...(options.body !== undefined ? { "content-type": "application/vnd.git-lfs+json" } : {}),
    ...options.extraHeaders,
  };
  return SELF.fetch(url, {
    method: options.method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function createLock(
  repo: SeededRepo,
  token: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await lockFetch(locksUrl(repo), { method: "POST", token, body: { path } });
  return { status: response.status, body: await response.json<Record<string, unknown>>() };
}

interface WireLock {
  id: string;
  path: string;
  locked_at: string;
  owner: { name: string };
}

/** `{"locks":[...]}` (+ `next_cursor` on full pages). */
interface LockListWire {
  locks: WireLock[];
  next_cursor?: string;
}

/** Verify's `ours`/`theirs` split. */
interface LockVerifyWire {
  ours: WireLock[];
  theirs: WireLock[];
  next_cursor?: string;
}

// --- pure ports -----------------------------------------------------------------

describe("Go stdlib ports (pathJoinRel / goParseInt64 / rfc3339)", () => {
  it("normalizes paths exactly like util.PathJoinRel", () => {
    // The upstream integration test's fixtures (api_repo_lfs_locks_test.go:73).
    expect(pathJoinRel("Foo/Test/../subFOlder/../Relative/../BaR.zip")).toBe("Foo/BaR.zip");
    expect(pathJoinRel("foo/bar.zip")).toBe("foo/bar.zip");
    expect(pathJoinRel("/leading/slash/")).toBe("leading/slash");
    expect(pathJoinRel("a//b")).toBe("a/b");
    expect(pathJoinRel("..")).toBe(".");
    expect(pathJoinRel("a/../..")).toBe(".");
    expect(pathJoinRel(".")).toBe(".");
    expect(pathJoinRel("")).toBe("");
  });

  it("mimics strconv.ParseInt(s, 10, 64) outcomes and error texts", () => {
    expect(goParseInt64("42")).toEqual({ value: 42n, errorClass: null });
    expect(goParseInt64("-7")).toEqual({ value: -7n, errorClass: null });
    expect(goParseInt64("+3")).toEqual({ value: 3n, errorClass: null });
    expect(goParseInt64("007")).toEqual({ value: 7n, errorClass: null });
    expect(goParseInt64("abc")).toEqual({ value: 0n, errorClass: "syntax" });
    expect(goParseInt64("")).toEqual({ value: 0n, errorClass: "syntax" });
    expect(goParseInt64("1.5")).toEqual({ value: 0n, errorClass: "syntax" });
    expect(goParseInt64(" 1")).toEqual({ value: 0n, errorClass: "syntax" });
    expect(goParseInt64("99999999999999999999")).toEqual({
      value: 9223372036854775807n,
      errorClass: "range",
    });
    expect(goParseInt64ErrorText("abc", "syntax")).toBe(
      'strconv.ParseInt: parsing "abc": invalid syntax',
    );
    expect(goParseInt64ErrorText("99999999999999999999", "range")).toBe(
      'strconv.ParseInt: parsing "99999999999999999999": value out of range',
    );
  });

  it("formats second-rounded RFC3339 like Go time JSON", () => {
    expect(rfc3339Seconds(new Date("2026-10-30T12:34:56Z"))).toBe("2026-10-30T12:34:56Z");
  });

  it("parses the locks sub-route shapes", () => {
    expect(parseLfsRoute("/o/r/info/lfs/locks", "GET")).toMatchObject({
      kind: "locks",
      lock: { verb: "list", lid: null },
    });
    expect(parseLfsRoute("/o/r/info/lfs/locks/", "POST")).toMatchObject({
      kind: "locks",
      lock: { verb: "create" },
    });
    expect(parseLfsRoute("/o/r/info/lfs/locks/verify", "POST")).toMatchObject({
      kind: "locks",
      lock: { verb: "verify" },
    });
    expect(parseLfsRoute("/o/r/info/lfs/locks/42/unlock", "POST")).toMatchObject({
      kind: "locks",
      lock: { verb: "unlock", lid: "42" },
    });
    // Method mismatches and junk fall to the catch-all (no locks sub-route).
    expect(parseLfsRoute("/o/r/info/lfs/locks", "DELETE")?.kind).toBe("not-found");
    expect(parseLfsRoute("/o/r/info/lfs/locks/verify", "GET")?.kind).toBe("not-found");
    expect(parseLfsRoute("/o/r/info/lfs/locks/42/unlock", "GET")?.kind).toBe("not-found");
    expect(parseLfsRoute("/o/r/info/lfs/locks/42", "POST")?.kind).toBe("not-found");
    expect(parseLfsRoute("/o/r/info/lfs/locks/42/unlock/extra", "POST")?.kind).toBe("not-found");
  });
});

// --- create + list round-trip ----------------------------------------------------

describe("create + list (PostLockHandler / GetListLockHandler)", () => {
  it("round-trips a created lock: 201 envelope, stringified id, owner name, second-rounded locked_at", async () => {
    const fixtures = await seedFixtures();
    const { status, body } = await createLock(fixtures.privateRepo, fixtures.write, "foo/bar.zip");
    expect(status).toBe(201);
    const lock = body.lock as WireLock;
    expect(lock.id).toMatch(/^\d+$/);
    expect(lock.path).toBe("foo/bar.zip");
    expect(lock.owner).toEqual({ name: "Alice" }); // display-cased username
    expect(lock.locked_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    const list = await lockFetch(locksUrl(fixtures.privateRepo), {
      method: "GET",
      token: fixtures.write,
    });
    expect(list.status).toBe(200);
    expect(list.headers.get("content-type")).toBe(LOCKS_JSON);
    const text = await list.text();
    expect(text.endsWith("\n")).toBe(false); // ctx.JSON emits no trailing newline
    const parsed = JSON.parse(text) as { locks: WireLock[]; next_cursor?: string };
    expect(parsed.locks).toHaveLength(1);
    expect(parsed.locks[0]).toEqual(lock);
    expect(parsed.next_cursor).toBeUndefined(); // only on a full page
  });

  it("409s duplicate paths with the EXISTING lock echoed — case-insensitive and PathJoinRel-normalized", async () => {
    const fixtures = await seedFixtures();
    const first = await createLock(fixtures.privateRepo, fixtures.write, "foo/bar.zip");
    expect(first.status).toBe(201);
    const original = (first.body.lock as WireLock).id;

    // Exact duplicate.
    const same = await createLock(fixtures.privateRepo, fixtures.write, "foo/bar.zip");
    expect(same.status).toBe(409);
    expect(same.body.message).toBe("already created lock");
    expect((same.body.lock as WireLock).id).toBe(original);

    // Case-insensitive (upstream test line 72: "Foo/BaR.zip" conflicts).
    const cased = await createLock(fixtures.privateRepo, fixtures.write, "Foo/BaR.zip");
    expect(cased.status).toBe(409);
    expect((cased.body.lock as WireLock).id).toBe(original);

    // Dot-segment normalized (upstream test line 73).
    const dotted = await createLock(
      fixtures.privateRepo,
      fixtures.write,
      "Foo/Test/../subFOlder/../Relative/../BaR.zip",
    );
    expect(dotted.status).toBe(409);
    expect((dotted.body.lock as WireLock).id).toBe(original);
  });

  it("lists ordered by id and answers the ?id / ?path arms incl. the strconv 400", async () => {
    const fixtures = await seedFixtures();
    const paths = ["a.bin", "b.bin", "c.bin"];
    const ids: string[] = [];
    for (const path of paths) {
      const made = await createLock(fixtures.privateRepo, fixtures.write, path);
      ids.push((made.body.lock as WireLock).id);
    }

    // ?id= hit → single-item list; miss → empty list (handleLockListOut).
    const byId = await lockFetch(locksUrl(fixtures.privateRepo, `?id=${ids[1]}`), {
      method: "GET",
      token: fixtures.write,
    });
    expect(byId.status).toBe(200);
    expect((await byId.json<LockListWire>()).locks.map((l) => l.id)).toEqual([ids[1]]);

    const byMiss = await lockFetch(locksUrl(fixtures.privateRepo, "?id=999"), {
      method: "GET",
      token: fixtures.write,
    });
    expect(byMiss.status).toBe(200);
    expect(await byMiss.json()).toEqual({ locks: [] });

    // ?id= garbage → Go strconv error text, space-colon-space form.
    const bad = await lockFetch(locksUrl(fixtures.privateRepo, "?id=abc"), {
      method: "GET",
      token: fixtures.write,
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({
      message: 'bad request : strconv.ParseInt: parsing "abc": invalid syntax',
    });
    const huge = await lockFetch(locksUrl(fixtures.privateRepo, "?id=99999999999999999999"), {
      method: "GET",
      token: fixtures.write,
    });
    expect(huge.status).toBe(400);
    expect(await huge.json()).toEqual({
      message: 'bad request : strconv.ParseInt: parsing "99999999999999999999": value out of range',
    });

    // ?path= arm: case-insensitive single match; miss → empty.
    const byPath = await lockFetch(locksUrl(fixtures.privateRepo, "?path=B.bin"), {
      method: "GET",
      token: fixtures.write,
    });
    expect((await byPath.json<LockListWire>()).locks.map((l) => l.id)).toEqual([ids[1]]);
    const byPathMiss = await lockFetch(locksUrl(fixtures.privateRepo, "?path=zzz"), {
      method: "GET",
      token: fixtures.write,
    });
    expect(await byPathMiss.json()).toEqual({ locks: [] });
  });
});

// --- verify + unlock -------------------------------------------------------------

describe("verify (VerifyLockHandler)", () => {
  it("splits ours/theirs by owner and keeps the read-scope quirk (write grant required, read scope accepted)", async () => {
    const fixtures = await seedFixtures();
    await createLock(fixtures.privateRepo, fixtures.write, "mine.bin");
    await createLock(fixtures.privateRepo, fixtures.adminWrite, "theirs.bin");

    // Owner's read-scope token: scope Read passes (upstream locks.go:216),
    // the requireWrite authenticate passes via the owner grant (locks.go:221).
    const verify = await lockFetch(locksUrl(fixtures.privateRepo, "/verify"), {
      method: "POST",
      token: fixtures.read,
      body: {},
    });
    expect(verify.status).toBe(200);
    const body = await verify.json<LockVerifyWire>();
    expect(body.ours.map((l) => l.path)).toEqual(["mine.bin"]);
    expect(body.theirs.map((l) => l.path)).toEqual(["theirs.bin"]);
    expect(body.next_cursor).toBeUndefined();

    // The write-scope create arm rejects the read token at the scope check.
    const createRead = await lockFetch(locksUrl(fixtures.privateRepo), {
      method: "POST",
      token: fixtures.read,
      body: { path: "nope.bin" },
    });
    expect(createRead.status).toBe(403);
  });
});

describe("unlock (UnLockHandler)", () => {
  it("lets the lock owner unlock and echoes the deleted lock", async () => {
    const fixtures = await seedFixtures();
    const made = await createLock(fixtures.privateRepo, fixtures.write, "gone.bin");
    const lock = made.body.lock as WireLock;

    const done = await lockFetch(locksUrl(fixtures.privateRepo, `/${lock.id}/unlock`), {
      method: "POST",
      token: fixtures.write,
      body: {},
    });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ lock });
    expect(done.headers.get("content-type")).toBe(LOCKS_JSON);

    const list = await lockFetch(locksUrl(fixtures.privateRepo), {
      method: "GET",
      token: fixtures.write,
    });
    expect(await list.json()).toEqual({ locks: [] });
  });

  it("answers upstream's exact 500 for a missing lock and for not-owner-without-force; force unlocks", async () => {
    const fixtures = await seedFixtures();

    // Missing lock id: DeleteLFSLockByID's not-exist error hits the ONE arm
    // (locks.go:311-318) — 500, not a 404 (there is no 404 arm at the pin).
    const missing = await lockFetch(locksUrl(fixtures.privateRepo, "/999/unlock"), {
      method: "POST",
      token: fixtures.write,
      body: {},
    });
    expect(missing.status).toBe(500);
    expect(await missing.json()).toEqual({ message: "unable to delete lock : Internal Server Error" });

    // Admin creates a lock; the repo owner is NOT the lock owner.
    const made = await createLock(fixtures.privateRepo, fixtures.adminWrite, "admin.bin");
    const lock = made.body.lock as WireLock;

    // Not-owner without force → the ownership error hits the same 500 arm
    // (lfs_lock.go:161-163 returns a plain error; UnLockHandler maps it).
    const stranger = await lockFetch(locksUrl(fixtures.privateRepo, `/${lock.id}/unlock`), {
      method: "POST",
      token: fixtures.write,
      body: {},
    });
    expect(stranger.status).toBe(500);
    expect(await stranger.json()).toEqual({ message: "unable to delete lock : Internal Server Error" });

    // force=true unlocks for any writer (lfs_lock.go:161's !force guard).
    const forced = await lockFetch(locksUrl(fixtures.privateRepo, `/${lock.id}/unlock`), {
      method: "POST",
      token: fixtures.write,
      body: { force: true },
    });
    expect(forced.status).toBe(200);
    expect(await forced.json()).toEqual({ lock });

    // A non-numeric lid parses as 0 (PathParamInt64 discards the error) →
    // not-exist → the same 500.
    const junk = await lockFetch(locksUrl(fixtures.privateRepo, "/abc/unlock"), {
      method: "POST",
      token: fixtures.write,
      body: {},
    });
    expect(junk.status).toBe(500);
  });

  it("400s an undecodable body or a non-bool force on the writeStatus arm (LFS media type)", async () => {
    const fixtures = await seedFixtures();
    const raw = await SELF.fetch(locksUrl(fixtures.privateRepo, "/1/unlock"), {
      method: "POST",
      headers: {
        accept: "application/vnd.git-lfs+json",
        authorization: basicTokenHeader(fixtures.write),
        "content-type": "application/vnd.git-lfs+json",
      },
      body: "{not json",
    });
    expect(raw.status).toBe(400);
    expect(raw.headers.get("content-type")).toBe(LFS_MEDIA_TYPE);
    expect(await raw.json()).toEqual({ message: "Bad Request" });

    const badForce = await lockFetch(locksUrl(fixtures.privateRepo, "/1/unlock"), {
      method: "POST",
      token: fixtures.write,
      body: { force: "yes" },
    });
    expect(badForce.status).toBe(400);
  });
});

// --- paging ----------------------------------------------------------------------

describe("cursor/limit paging (locks.go:77-83 + GetLFSLockByRepoID)", () => {
  it("pages by PAGE-number cursor, caps limit at 50, omits next_cursor unless the page is full", async () => {
    const fixtures = await seedFixtures();
    const ids: string[] = [];
    for (const path of ["p1", "p2", "p3", "p4", "p5"]) {
      const made = await createLock(fixtures.privateRepo, fixtures.write, path);
      ids.push((made.body.lock as WireLock).id);
    }

    const page1 = await lockFetch(locksUrl(fixtures.privateRepo, "?limit=2"), {
      method: "GET",
      token: fixtures.write,
    });
    const page1Body = await page1.json<LockListWire>();
    expect(page1Body.locks.map((l) => l.id)).toEqual(ids.slice(0, 2));
    expect(page1Body.next_cursor).toBe("1");

    // Upstream quirk: cursor 1 recomputes start = (1-1)*limit = 0 — the SAME
    // first page (locks.go:126 issues next=cursor+1 from cursor 0).
    const alias = await lockFetch(locksUrl(fixtures.privateRepo, "?limit=2&cursor=1"), {
      method: "GET",
      token: fixtures.write,
    });
    expect((await alias.json<typeof page1Body>()).locks.map((l) => l.id)).toEqual(ids.slice(0, 2));

    const page2 = await lockFetch(locksUrl(fixtures.privateRepo, "?limit=2&cursor=2"), {
      method: "GET",
      token: fixtures.write,
    });
    const page2Body = await page2.json<typeof page1Body>();
    expect(page2Body.locks.map((l) => l.id)).toEqual(ids.slice(2, 4));
    expect(page2Body.next_cursor).toBe("3");

    // Partial trailing page: no next_cursor.
    const page3 = await lockFetch(locksUrl(fixtures.privateRepo, "?limit=2&cursor=3"), {
      method: "GET",
      token: fixtures.write,
    });
    const page3Body = await page3.json<typeof page1Body>();
    expect(page3Body.locks.map((l) => l.id)).toEqual([ids[4] as string]);
    expect(page3Body.next_cursor).toBeUndefined();

    // limit=0 (and negatives/non-numeric) means UNLIMITED, cursor irrelevant.
    const all = await lockFetch(locksUrl(fixtures.privateRepo, "?limit=0&cursor=99"), {
      method: "GET",
      token: fixtures.write,
    });
    expect((await all.json<typeof page1Body>()).locks).toHaveLength(5);

    // limit above the 50 cap is clamped (5 rows ≠ 50 → no next_cursor).
    const capped = await lockFetch(locksUrl(fixtures.privateRepo, "?limit=999"), {
      method: "GET",
      token: fixtures.write,
    });
    const cappedBody = await capped.json<typeof page1Body>();
    expect(cappedBody.locks).toHaveLength(5);
    expect(cappedBody.next_cursor).toBeUndefined();

    // Verify shares the paging rule.
    const verify = await lockFetch(locksUrl(fixtures.privateRepo, "/verify?limit=2&cursor=2"), {
      method: "POST",
      token: fixtures.write,
      body: {},
    });
    const verifyBody = await verify.json<LockVerifyWire>();
    expect(verifyBody.ours.map((l) => l.id)).toEqual(ids.slice(2, 4));
    expect(verifyBody.next_cursor).toBe("3");
  });
});

// --- auth posture ----------------------------------------------------------------

describe("locks auth posture (requireSigned + per-verb messages)", () => {
  it("401s anonymous requests on every verb with the route-specific message and gitea-lfs realm — even on public repos", async () => {
    const fixtures = await seedFixtures();

    const arms: { url: string; method: "GET" | "POST"; message: string }[] = [
      { url: locksUrl(fixtures.publicRepo), method: "GET", message: "You must have pull access to list locks" },
      { url: locksUrl(fixtures.publicRepo), method: "POST", message: "You must have push access to create locks" },
      {
        url: locksUrl(fixtures.publicRepo, "/verify"),
        method: "POST",
        message: "You must have push access to verify locks",
      },
      {
        url: locksUrl(fixtures.publicRepo, "/1/unlock"),
        method: "POST",
        message: "You must have push access to delete locks",
      },
    ];
    for (const arm of arms) {
      const response = await lockFetch(arm.url, { method: arm.method, body: arm.method === "POST" ? {} : undefined });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe('Basic realm="gitea-lfs"');
      expect(response.headers.get("content-type")).toBe(LOCKS_JSON);
      const text = await response.text();
      expect(text.endsWith("\n")).toBe(false);
      expect(JSON.parse(text)).toEqual({ message: arm.message });
    }
  });

  it("401s a signed-in non-granted user (challenge, not the git-HTTP 404 mask); 403s wrong scopes", async () => {
    const fixtures = await seedFixtures();

    // Bob has no grant on Alice's repo → authenticate fails → route message.
    const bobList = await lockFetch(locksUrl(fixtures.privateRepo), {
      method: "GET",
      token: (await mintFor(fixtures.bob.id, "bob-read", "read:repository")).plaintext,
    });
    expect(bobList.status).toBe(401);
    expect(await bobList.json()).toEqual({ message: "You must have pull access to list locks" });

    // Known token without the repository scope category → plain Forbidden.
    const wrongScope = await lockFetch(locksUrl(fixtures.privateRepo), {
      method: "GET",
      token: fixtures.wrongScope,
    });
    expect(wrongScope.status).toBe(403);
    expect(wrongScope.headers.get("content-type")).toContain("text/plain");
    expect(await wrongScope.text()).toBe("Forbidden\n");

    // public-only scope masked on a private repo → challenge.
    const masked = await lockFetch(locksUrl(fixtures.privateRepo), {
      method: "GET",
      token: fixtures.publicOnly,
    });
    expect(masked.status).toBe(401);
    expect(await masked.json()).toEqual({ message: "You must have pull access to list locks" });

    // Invalid credential → challenge (and no scope disclosure).
    const invalid = await lockFetch(locksUrl(fixtures.privateRepo), {
      method: "GET",
      token: "gitea_totally_invalid_token_value",
    });
    expect(invalid.status).toBe(401);
  });

  it("403s archived repos on the write verbs (create/unlock), reads unaffected", async () => {
    const fixtures = await seedFixtures();
    const create = await lockFetch(locksUrl(fixtures.archivedRepo), {
      method: "POST",
      token: fixtures.write,
      body: { path: "x.bin" },
    });
    expect(create.status).toBe(403);
    expect(await create.text()).toBe(
      "This repo is archived. You can view files and clone it, but cannot push or open issues/pull-requests.",
    );

    // Make a lock via the admin token? Archived blocks admin too (family
    // posture) — instead verify list still works.
    const list = await lockFetch(locksUrl(fixtures.archivedRepo), {
      method: "GET",
      token: fixtures.write,
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ locks: [] });
  });

  it("carries the media-type gate: matched routes 415 before auth; mismatches 404 plain", async () => {
    const fixtures = await seedFixtures();
    const noAccept = await lockFetch(locksUrl(fixtures.privateRepo), {
      method: "POST",
      token: fixtures.write,
      body: { path: "x.bin" },
      accept: "application/json",
    });
    expect(noAccept.status).toBe(415);

    const mismatch = await lockFetch(locksUrl(fixtures.privateRepo, "/verify"), {
      method: "GET",
      token: fixtures.write,
      accept: "application/json",
    });
    expect(mismatch.status).toBe(404); // catch-all: no media-type check
    expect(await mismatch.text()).toBe("404 page not found\n");
  });
});

// --- decode arms -------------------------------------------------------------------

describe("create decode arms (PostLockHandler body handling)", () => {
  it("400s malformed JSON and non-string paths on the writeStatus arm; an absent path creates an empty-path lock like upstream", async () => {
    const fixtures = await seedFixtures();

    const raw = await SELF.fetch(locksUrl(fixtures.privateRepo), {
      method: "POST",
      headers: {
        accept: "application/vnd.git-lfs+json",
        authorization: basicTokenHeader(fixtures.write),
        "content-type": "application/vnd.git-lfs+json",
      },
      body: "{broken",
    });
    expect(raw.status).toBe(400);
    expect(raw.headers.get("content-type")).toBe(LFS_MEDIA_TYPE);
    expect(await raw.json()).toEqual({ message: "Bad Request" });

    const wrongType = await lockFetch(locksUrl(fixtures.privateRepo), {
      method: "POST",
      token: fixtures.write,
      body: { path: 123 },
    });
    expect(wrongType.status).toBe(400);
    expect(await wrongType.json()).toEqual({ message: "Bad Request" });

    // No path field → decodes as "" → creatable (upstream validates nothing);
    // a second empty-path create conflicts with the first.
    const first = await lockFetch(locksUrl(fixtures.privateRepo), {
      method: "POST",
      token: fixtures.write,
      body: {},
    });
    expect(first.status).toBe(201);
    expect((await first.json<{ lock: WireLock }>()).lock.path).toBe("");
    const second = await lockFetch(locksUrl(fixtures.privateRepo), {
      method: "POST",
      token: fixtures.write,
      body: {},
    });
    expect(second.status).toBe(409);
  });
});
