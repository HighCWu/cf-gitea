/**
 * Engine seeding for the §5.1 page render tests: REAL pushed content, not
 * stub responses — the tests push a tiny multi-commit pack through the
 * landed git-http receive flow (SELF.fetch → gitHttpGate → the engine's
 * receive pipeline), exactly like src/repos/push-create.test.ts, then flip
 * the push-created row public (push-create is private-by-default, §2.5.2)
 * so the anonymous pages can serve it.
 *
 * `ensureSeeded*` are rollback-safe under the vitest plugin's storage
 * isolation: every call verifies the D1 row AND the engine's refs before
 * deciding to (re)push, so each test is self-contained whether the plugin
 * rolls test-time writes back or not.
 *
 * The pack builder here is deliberately self-contained (src/repos/testing/
 * git-pack.ts serves the single-file push-create fixtures; its byte-level
 * helpers are private and that module is outside the UI's file ownership):
 * workerd-safe WebCrypto SHA-1 + CompressionStream, real SHA-1s throughout —
 * nested trees, per-commit full trees, chained parents, and lightweight tags.
 */

import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";

import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { settleCreatingRepo } from "../../git-http/gate";
import { repositories, users } from "../../db/schema";
import { RepoService } from "../../repos/service";

// ---------------------------------------------------------------------------
// Object/pack primitives (git object format; SHA-1 over `type size\0` + body)
// ---------------------------------------------------------------------------

const ENCODER = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-1", bytes));
}

async function sha1Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
}

/** zlib-deflate (git object storage format) via the workerd-native stream. */
async function zlibDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concatArrays(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function be32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function rawOid(oidHex: string): Uint8Array {
  const raw = new Uint8Array(20);
  for (let i = 0; i < 20; i++) raw[i] = Number.parseInt(oidHex.slice(i * 2, i * 2 + 2), 16);
  return raw;
}

/** The type/size varint header of one packed object entry. */
function objectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  let rest = size >> 4;
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest >>= 7;
  }
  bytes.push(first);
  return new Uint8Array(bytes);
}

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;

/** Hash one object (`type size\0` + body) — the stored serialization IS the
 *  raw bytes the pack entry re-emits. */
async function storeObject(type: number, body: Uint8Array): Promise<StoredObject> {
  const typeName = type === OBJ_COMMIT ? "commit" : type === OBJ_TREE ? "tree" : "blob";
  const raw = concatArrays([ENCODER.encode(`${typeName} ${body.length}\0`), body]);
  return { type, body, raw, oid: await sha1Hex(raw) };
}

/** A stored git object: its type, body bytes, and the full `type size\0` +
 *  body serialization the pack entry re-emits. */
interface StoredObject {
  type: number;
  body: Uint8Array;
  raw: Uint8Array;
  oid: string;
}

// ---------------------------------------------------------------------------
// Trees + commits
// ---------------------------------------------------------------------------

/** One file at a path: text or bytes. */
export interface SeedFile {
  path: string;
  content: string | Uint8Array;
}

export interface SeedCommit {
  message: string;
  files: SeedFile[];
  /** Committer/author unix seconds (fixed → deterministic rendering). */
  time: number;
}

interface TreeNode {
  blobs: Map<string, { mode: string; oid: string }>;
  dirs: Map<string, TreeNode>;
}

function emptyNode(): TreeNode {
  return { blobs: new Map(), dirs: new Map() };
}

function insertPath(root: TreeNode, path: string, mode: string, oid: string): void {
  const segments = path.split("/");
  let node = root;
  for (const dir of segments.slice(0, -1)) {
    let child = node.dirs.get(dir);
    if (child === undefined) {
      child = emptyNode();
      node.dirs.set(dir, child);
    }
    node = child;
  }
  node.blobs.set(segments[segments.length - 1] as string, { mode, oid });
}

/** Serialize a tree level; git sorts entries with dirs compared as `name/`.
 *  Every level's object lands in `objects` (subtrees are referenced by oid
 *  from their parent, so they must all ship in the pack). */
async function writeTree(node: TreeNode, objects: Map<string, StoredObject>): Promise<StoredObject> {
  const entries: { sortKey: string; bytes: Uint8Array }[] = [];
  for (const [name, blob] of node.blobs) {
    entries.push({
      sortKey: name,
      bytes: concatArrays([ENCODER.encode(`${blob.mode} ${name}\0`), rawOid(blob.oid)]),
    });
  }
  for (const [name, child] of node.dirs) {
    const subtree = await writeTree(child, objects);
    objects.set(subtree.oid, subtree);
    entries.push({
      sortKey: `${name}/`,
      bytes: concatArrays([ENCODER.encode(`40000 ${name}\0`), rawOid(subtree.oid)]),
    });
  }
  entries.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  return storeObject(OBJ_TREE, concatArrays(entries.map((e) => e.bytes)));
}

function personLine(who: "author" | "committer", time: number): string {
  return `${who} Test User <test@example.com> ${time} +0000`;
}

async function writeCommit(treeOid: string, parent: string | null, commit: SeedCommit): Promise<StoredObject> {
  const body =
    `tree ${treeOid}\n` +
    (parent !== null ? `parent ${parent}\n` : "") +
    `${personLine("author", commit.time)}\n` +
    `${personLine("committer", commit.time)}\n\n` +
    `${commit.message}\n`;
  return storeObject(OBJ_COMMIT, ENCODER.encode(body));
}

/** Build ONE self-contained pack for a linear history: every commit carries
 *  its full tree; all objects (deduplicated by oid) land in the pack. */
export async function buildHistoryPack(
  commits: SeedCommit[],
): Promise<{ tips: string[]; pack: Uint8Array }> {
  const objects = new Map<string, StoredObject>();
  const store = (obj: StoredObject): void => {
    objects.set(obj.oid, obj);
  };
  const tips: string[] = [];
  let parent: string | null = null;
  for (const commit of commits) {
    const root = emptyNode();
    for (const file of commit.files) {
      const content = typeof file.content === "string" ? ENCODER.encode(file.content) : file.content;
      const blob = await storeObject(OBJ_BLOB, content);
      store(blob);
      insertPath(root, file.path, "100644", blob.oid);
    }
    const tree = await writeTree(root, objects);
    store(tree);
    const commitObj = await writeCommit(tree.oid, parent, commit);
    store(commitObj);
    parent = commitObj.oid;
    tips.push(commitObj.oid);
  }

  const chunks: Uint8Array[] = [ENCODER.encode("PACK"), be32(2), be32(objects.size)];
  for (const obj of objects.values()) {
    // Pack entry = varint header + zlib(data) where data is the BODY ONLY —
    // the `type size\0` header lives in loose storage, never in packs (the
    // pack varint carries type + inflated size itself).
    chunks.push(objectHeader(obj.type, obj.body.length));
    chunks.push(await zlibDeflate(obj.body));
  }
  chunks.push(await sha1Bytes(concatArrays(chunks)));
  return { tips, pack: concatArrays(chunks) };
}

// ---------------------------------------------------------------------------
// Push through the LANDED git-http flow (SELF → gitHttpGate → engine), then
// flip the push-created row public (§2.5.2: push-create is private-by-default;
// the anonymous pages only serve public repos, §2.5)
// ---------------------------------------------------------------------------

const ZERO_OID = "0".repeat(40);
const RECEIVE_CT = "application/x-git-receive-pack-request";

function pktLine(payload: string): string {
  return `${(payload.length + 4).toString(16).padStart(4, "0")}${payload}`;
}

/** A full `git-receive-pack` body: command section + flush + pack. */
export function buildReceivePackBody(
  updates: { ref: string; oid: string }[],
  pack: Uint8Array,
): Uint8Array {
  let section = "";
  for (const update of updates) {
    section += pktLine(`${ZERO_OID} ${update.oid} ${update.ref}\0report-status side-band-64k`);
  }
  section += "0000";
  return concatArrays([ENCODER.encode(section), pack]);
}

export interface SeededRepo {
  owner: string;
  slug: string;
  defaultBranch: string;
  /** Commit oids oldest → newest. */
  tips: string[];
}

/** Idempotent seed: verify the D1 row AND the engine's refs, then (re)push
 *  through the real receive flow as needed. Safe to call from every test. */
export async function ensureSeededRepo(options: {
  owner: string;
  slug: string;
  commits: SeedCommit[];
  /** Lightweight tags pushed alongside the branch (name → tips index). */
  tags?: { name: string; commitIndex: number }[];
}): Promise<SeededRepo> {
  const db = drizzle(env.DB);
  const engineRepo = `${options.owner}/${options.slug}`;

  // 1. The owner row (push-create resolves the namespace owner from D1).
  const existingOwner = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.usernameLower, options.owner.toLowerCase()))
    .get();
  const user = existingOwner ?? (await (async () => {
    const seeded = await seedVerifiedUser({ username: options.owner });
    return { id: seeded.id };
  })());
  // Idempotent mint: token names are unique per user (TokenService rejects
  // duplicates), so re-seeding deletes the previous seed token first — the
  // plaintext is never stored and cannot be reused across calls.
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(user.id, `ui-page-seed-${options.slug}`)
    .run();
  const token = (await mintFor(user.id, `ui-page-seed-${options.slug}`, "write:repository")).plaintext;

  // 2. The engine content: push when the cell has no HEAD (fresh isolate,
  //    rolled-back storage, or first call).
  const refs = await env.REPO.getByName(engineRepo).listRefs();
  if (refs.head === null) {
    const { tips, pack } = await buildHistoryPack(options.commits);
    const updates = [{ ref: "refs/heads/main", oid: tips[tips.length - 1] as string }];
    for (const tag of options.tags ?? []) {
      updates.push({ ref: `refs/tags/${tag.name}`, oid: tips[tag.commitIndex] as string });
    }
    const response = await SELF.fetch(`https://test.local/${engineRepo}.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildReceivePackBody(updates, pack),
    });
    const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
    if (response.status !== 200 || responseBody.includes("ng ")) {
      throw new Error(`seed push failed: ${response.status} ${responseBody.slice(0, 400)}`);
    }
  }

  // 3. The D1 row: push-create made it (status creating → settle). If the row
  //    itself is missing (D1-only rollback), re-create it ready/public.
  let row = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, options.owner.toLowerCase()), eq(repositories.slug, options.slug.toLowerCase())))
    .get();
  if (row === undefined) {
    const service = new RepoService(env.DB);
    row = await service.create({
      owner: { id: user.id, usernameLower: options.owner.toLowerCase() },
      name: options.slug,
      isPrivate: false,
      status: "ready",
    });
  } else {
    await settleCreatingRepo(env, row.id, engineRepo);
    row = (await db.select().from(repositories).where(eq(repositories.id, row.id)).get()) ?? row;
  }
  if (row.visibility !== "public") {
    await db.update(repositories).set({ visibility: "public" }).where(eq(repositories.id, row.id));
  }

  // Deterministic content hashes (fixed timestamps + contents): the tip oids
  // are the same on every call, so tests can assert against them whether or
  // not this call actually pushed.
  const { tips } = await buildHistoryPack(options.commits);
  return {
    owner: options.owner,
    slug: options.slug,
    defaultBranch: row.defaultBranch,
    tips,
  };
}