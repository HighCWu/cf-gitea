/**
 * The SRC/TREE-VIEW page family's DEFERRED route-level matrix (the repo home
 * tree render + the tree-view-aux fragment — pages/home.tsx, pages/
 * file-view.tsx, pages/tree-view-aux.ts over components/file-list.tsx).
 * The early suites own the base arms and THIS FILE does not repeat them:
 *
 *   - pages-wave2.test.ts — the `/tree` → `/src` redirect family (303 raw
 *     suffix, query, post-resolution 404s, the bare `/tree` tail) and the
 *     redirect target's listing shape;
 *   - pages-wave43-tree-view.test.ts — the tree-view-aux ENVELOPE: the wire
 *     bytes, the pure ports, the sub_path chain, the symlink/submodule arms,
 *     the ref-resolution 404 family and the anonymous private gate;
 *   - pages.test.ts — the home/file-view page renders on a real pushed repo
 *     (root listing enrichment, README pipeline, blob variants, tag/commit
 *     refs, the bare-/src and prefix-less 404s);
 *   - render.test.tsx — the component-level degradation arms (stub engines);
 *   - index.test.ts — the pure parse/resolution tables and the anonymous
 *     §2.5 shells;
 *   - pages-wave46-fragment-mounts.test.tsx — the RepoFilesTable data-fetch
 *     flip at the COMPONENT level.
 *
 * THIS FILE adds the arms those suites cannot reach, driven over the mounted
 * uiRouter with the issues-list 88ac2ee / org-members f75316e minted-session
 * pattern:
 *
 *   - the PRIVATE-repo gates with a session roster: the private repo
 *     404-shells for the anonymous viewer and a signed-in NON-collaborator,
 *     while the OWNER session renders the home page, the /src tree view AND
 *     the /tree-view aux envelope. The signed-in write COLLABORATOR arm
 *     began as the pinned visibility deferral (readGrant's session arms
 *     were owner/site-admin/org-team; the repo_collaborators edge was
 *     write-guard-only, repository.ts:199's SPEC-0005 TODO — pinned so a
 *     SPEC-0005 landing must flip it deliberately) and the wave-123
 *     SPEC-0005 landing FLIPPED it: the collaborator now renders all three
 *     surfaces plus the write chrome (the doerRepoAccessMode collaborator
 *     fold);
 *   - the git-HTTP readGrant's collaborator arms over the same fixture
 *     (SPEC-0005): a write collaborator clones the private repo AND pushes
 *     a branch through the real receive-pack (mode write ranks write); a
 *     READ collaborator clones but the push 404-masks (acl.ts's recorded
 *     read-only-collaborator variant, landed with the fold); a
 *     non-collaborator's clone stays 404 (existence hidden);
 *   - the /src ref-resolution arms made route-real (index.test owns the pure
 *     table): the branch/HEAD swap, a slash-bearing branch reached and
 *     rendered (`green/deep` — links, the raw-file `?ref=` form and the
 *     sidebar all carry the slash ref), the SHORTEST-PREFIX shadow
 *     (`feature` + `feature/deep` both exist → `/branch/feature/README.md`
 *     serves the SHORT branch's content and `/branch/feature/deep` 404-shells
 *     as its tree path — repo.go:833-845's first-match walk), the short-sha
 *     commit ref (the full-oid divergence — the engine resolves full oids
 *     only, wave-43's tree-view pin now pinned at the /src twin), and the
 *     unknown-branch shell;
 *   - the file-list rows + latest-commit bar on SUB-DIRECTORY navigation
 *     (pages.test's dir fixture's tip always touched the dir, so the
 *     dir-owns-its-bar arm was unobservable): a fixture whose tip touches
 *     only the root — the root bar shows the tip, the `docs/` bar shows the
 *     directory's OWN last commit (c2 via its deep subtree) NOT the tip, the
 *     per-row subjects split c1/c2 inside one listing, and the depth-2 view
 *     carries the parent link onto `docs` plus the breadcrumb's link/active
 *     split;
 *   - the session-gated write chrome (wave 8's canWrite surface — the golden
 *     renders are anonymous and assert nothing negative): anonymous AND
 *     signed-in-no-grant render no New File/Edit/Delete; a write-grant
 *     COLLABORATOR (not the owner) gets the chrome on the public repo (the
 *     canWriteRepository grant arm); the owner gets the root and
 *     sub-directory New File links (the dir-path form) and the blob
 *     Edit/Delete pair; a commit ref suppresses all of it for the same
 *     owner; an ARCHIVED repo suppresses it too (render.tsx's isArchived
 *     short-circuit);
 *   - the §4.10 typed-mode rows at route level (the 100644-only seed
 *     builder can never produce them): a submodule row renders
 *     `name @ <short-sha>` as plain text with NO anchor, the submodule path
 *     itself 404-shells the file view (no content view v1), exec/symlink
 *     rows render the plain file-row link, and an ampersand entry name
 *     round-trips percent-encoded in the href and HTML-escaped in the
 *     title/text attributes;
 *   - the wave-129 depth-3 + raw/view arms: the depth-3 blob view's
 *     cumulative breadcrumb chain (repo → docs → deep links, the file
 *     active — the depth-2 arm pins only the two-segment split), the
 *     file-level latest-commit seam (handbook.md stays c1 while the tip is
 *     c3 and its directory c2), the file header's Raw/History pair with the
 *     escaped deep path, and the §4.2 binary sniff's two arms over a
 *     dedicated `tvx-owner/tvx-media` fixture (a media-extension binary
 *     embeds the raw route as the img src; a binary without one renders the
 *     View Raw prompt);
 *   - the claim pin for both heads: the `.git`-trimmed repo segment claims
 *     into `src` / `tree-view-aux` (parse + route level), and the bare
 *     `/src` tail 404-shells WITH the repo header (the §4.5 context rule —
 *     wave2 pins it for `/tree`, pages.test only the status for `/src`).
 *
 * Fixtures (unique names — the matrix files share one storage scope):
 * `tvx-owner/tvx-pub` (4-commit main + `feature`, `feature/deep`,
 * `green/deep` branches through the real receive flow), `tvx-owner/
 * tvx-secret` (private, `tvx-collab` write + `tvx-reader` read collaborator
 * rows via the landed addOrUpdateCollaborator), `tvx-owner/tvx-sub`
 * (typed-mode pack built locally, wave-43's recipe trimmed — gitlinks emit
 * no object).
 */

import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { addOrUpdateCollaborator } from "../../api/services/repo-collaborators";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { settleCreatingRepo } from "../../git-http/gate";
import { repositories, users } from "../../db/schema";
import { RepoService } from "../../repos/service";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { buildHistoryPack, buildReceivePackBody, type SeedCommit } from "../testing/seed-repo";

// --- the minted-session route harness (the org-members f75316e pattern) ---------

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

/** The real production path: parse → resolveUiSession → the handler, on the
 *  mounted uiRouter with the synthetic manifest; the execution context is
 *  awaited so waitUntil side-effects settle before assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** A minted session cookie header for the user (the real mintSession path). */
async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** The `#repo-files-table` slice — the listing's own markup, cut before the
 *  page footer so shell chrome cannot share class names with the rows. */
function tableSlice(html: string): string {
  const start = html.indexOf('<div id="repo-files-table"');
  return start === -1 ? "" : html.slice(start);
}

async function userIdOf(username: string): Promise<number> {
  const row = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, username)).get();
  if (row === undefined) throw new Error(`tvx fixture user ${username} missing`);
  return row.id;
}

// --- fixtures -------------------------------------------------------------------

const T0 = 1_700_000_000;

const README_V1 = "# tvx pub\n\nreadme v1\n";
const README_V2 = "# tvx pub\n\nreadme v2\n";
const APP_TS = "export function tvxMain(): void {\n  return 1;\n}\n";
const GUIDE_MD = "# tvx guide\n";
const HANDBOOK_MD = "# tvx handbook\n";
const EXTRA_MD = "# tvx extra\n";

/** Linear history with a tip that touches ONLY the root: the per-row and
 *  per-directory last commits stay distinct from the ref tip (the arm
 *  pages.test's fixture cannot express). Deterministic oids (fixed times). */
const PUB_COMMITS: SeedCommit[] = [
  {
    message: "tvx c0: readme and app",
    time: T0,
    files: [
      { path: "README.md", content: README_V1 },
      { path: "app.ts", content: APP_TS },
    ],
  },
  {
    message: "tvx c1: docs born",
    time: T0 + 60,
    files: [
      { path: "README.md", content: README_V1 },
      { path: "app.ts", content: APP_TS },
      { path: "docs/guide.md", content: GUIDE_MD },
      { path: "docs/deep/handbook.md", content: HANDBOOK_MD },
    ],
  },
  {
    message: "tvx c2: deep extra",
    time: T0 + 120,
    files: [
      { path: "README.md", content: README_V1 },
      { path: "app.ts", content: APP_TS },
      { path: "docs/guide.md", content: GUIDE_MD },
      { path: "docs/deep/handbook.md", content: HANDBOOK_MD },
      { path: "docs/deep/extra.md", content: EXTRA_MD },
    ],
  },
  {
    message: "tvx c3: readme final",
    time: T0 + 180,
    files: [
      { path: "README.md", content: README_V2 },
      { path: "app.ts", content: APP_TS },
      { path: "docs/guide.md", content: GUIDE_MD },
      { path: "docs/deep/handbook.md", content: HANDBOOK_MD },
      { path: "docs/deep/extra.md", content: EXTRA_MD },
    ],
  },
];

const SECRET_COMMITS: SeedCommit[] = [
  {
    message: "tvx secret: readme and docs",
    time: T0,
    files: [
      { path: "README.md", content: "tvx secret readme\n" },
      { path: "docs/guide.md", content: "secret guide\n" },
    ],
  },
];

const RECEIVING_CT = "application/x-git-receive-pack-request";

async function pushRefs(
  repoName: string,
  updates: { ref: string; oid: string }[],
  pack: Uint8Array,
  token: string,
): Promise<void> {
  const response = await SELF.fetch(`https://test.local/${repoName}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": RECEIVING_CT },
    body: buildReceivePackBody(updates, pack),
  });
  const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
  if (response.status !== 200 || responseBody.includes("ng ")) {
    throw new Error(`tvx seed push failed: ${response.status} ${responseBody.slice(0, 400)}`);
  }
}

/** The ensure-once fixture pattern (the wave-matrix recipe): each seeder runs
 *  exactly once per file; the tvx-* names are unique across the suite, so a
 *  re-run would collide, not converge. */
function once(seed: () => Promise<void>): () => Promise<void> {
  let done: Promise<void> | null = null;
  return () => {
    if (done === null) done = seed();
    return done;
  };
}

let pubTips: string[] = [];
let pubRowId: string | null = null;

/** `tvx-owner/tvx-pub`: main at c3 + the branch roster (`feature` and
 *  `feature/deep` BOTH exist — the shortest-prefix shadow pair; `green/deep`
 *  stands alone — the reachable slash branch), flipped public. Main pushes
 *  FIRST and ALONE: the gate settles `default_branch` to the alphabetically
 *  first branch of a multi-branch FIRST push (gate.ts:993-996's documented
 *  posture), so the extra branches must ride a second receive-pack. */
const seedPubRepo = once(async (): Promise<void> => {
  const db = drizzle(env.DB);
  const owner = await userIdOf("tvx-owner");
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(owner, "tvx-matrix-pub")
    .run();
  const token = (await mintFor(owner, "tvx-matrix-pub", "write:repository")).plaintext;
  const repoName = "tvx-owner/tvx-pub";
  const refs = await env.REPO.getByName(repoName).listRefs();
  if (!refs.refs.some((r) => r.name === "refs/heads/green/deep")) {
    const { tips, pack } = await buildHistoryPack(PUB_COMMITS);
    await pushRefs(repoName, [{ ref: "refs/heads/main", oid: tips[3] as string }], pack, token);
    await pushRefs(
      repoName,
      [
        { ref: "refs/heads/feature", oid: tips[0] as string },
        { ref: "refs/heads/feature/deep", oid: tips[1] as string },
        { ref: "refs/heads/green/deep", oid: tips[1] as string },
      ],
      pack,
      token,
    );
  }
  let row = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "tvx-owner"), eq(repositories.slug, "tvx-pub")))
    .get();
  if (row === undefined) {
    row = await new RepoService(env.DB).create({
      owner: { id: owner, usernameLower: "tvx-owner" },
      name: "tvx-pub",
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
  // Converge the default branch too: a poisoned earlier run (multi-branch
  // first push) must not leak `feature` into the HEAD-swap arms below.
  if (row.defaultBranch !== "main") {
    await db.update(repositories).set({ defaultBranch: "main" }).where(eq(repositories.id, row.id));
  }
  // The grant-not-ownership write arm: tvx-collab holds a write row on the
  // PUBLIC repo (visibility passes for free; canWriteRepository's
  // collaborator arm produces the write chrome below).
  const collab = await userIdOf("tvx-collab");
  await addOrUpdateCollaborator(env.DB, row.id, collab, "write", new Date(T0 * 1000));
  pubRowId = row.id;
  pubTips = (await buildHistoryPack(PUB_COMMITS)).tips; // deterministic oids
});

/** `tvx-owner/tvx-secret`: one commit, PRIVATE, with `tvx-collab` holding a
 *  write grant, `tvx-reader` a read grant (SPEC-0005's read-only-collaborator
 *  arms) and `tvx-out` holding nothing. */
const seedSecretRepo = once(async (): Promise<void> => {
  const db = drizzle(env.DB);
  const owner = await userIdOf("tvx-owner");
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(owner, "tvx-matrix-secret")
    .run();
  const token = (await mintFor(owner, "tvx-matrix-secret", "write:repository")).plaintext;
  const repoName = "tvx-owner/tvx-secret";
  const refs = await env.REPO.getByName(repoName).listRefs();
  if (refs.head === null) {
    const { tips, pack } = await buildHistoryPack(SECRET_COMMITS);
    await pushRefs(repoName, [{ ref: "refs/heads/main", oid: tips[0] as string }], pack, token);
  }
  let row = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "tvx-owner"), eq(repositories.slug, "tvx-secret")))
    .get();
  if (row === undefined) {
    row = await new RepoService(env.DB).create({
      owner: { id: owner, usernameLower: "tvx-owner" },
      name: "tvx-secret",
      isPrivate: true,
      status: "ready",
    });
  } else {
    await settleCreatingRepo(env, row.id, repoName);
    row = (await db.select().from(repositories).where(eq(repositories.id, row.id)).get()) ?? row;
  }
  if (row.visibility !== "private") {
    await db.update(repositories).set({ visibility: "private" }).where(eq(repositories.id, row.id));
  }
  const collab = await userIdOf("tvx-collab");
  await addOrUpdateCollaborator(env.DB, row.id, collab, "write", new Date(T0 * 1000));
  const reader = await userIdOf("tvx-reader");
  await addOrUpdateCollaborator(env.DB, row.id, reader, "read", new Date(T0 * 1000));
});
// --- the typed-mode pack builder (wave-43's recipe, trimmed to this file's
// --- needs: gitlinks emit no object, the rest is blobs + nested trees) ---------

const ENCODER = new TextEncoder();
const LIB_OID = "5".repeat(40); // the gitlink TARGET — no object is emitted

interface TypedFile {
  path: string;
  content: string;
  mode: "100644" | "100755" | "120000" | "160000";
}

const SUB_FILES: TypedFile[] = [
  { path: "README.md", content: "tvx sub readme\n", mode: "100644" },
  { path: "a&b.md", content: "escaped name\n", mode: "100644" },
  { path: "run.sh", content: "echo tvx\n", mode: "100755" },
  { path: "link-file", content: "README.md", mode: "120000" },
  { path: "vendor/lib", content: LIB_OID, mode: "160000" },
];

function hexOid(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  return hexOid(new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)));
}

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
  for (let i = 0; i < 40; i += 2) raw[i / 2] = Number.parseInt(oidHex.slice(i, i + 2), 16);
  return raw;
}

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

interface SubTreeNode {
  entries: Map<string, { mode: string; oid: string }>;
  dirs: Map<string, SubTreeNode>;
}

function emptyNode(): SubTreeNode {
  return { entries: new Map(), dirs: new Map() };
}

function insertPath(root: SubTreeNode, path: string, mode: string, oid: string): void {
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
  node.entries.set(segments[segments.length - 1] as string, { mode, oid });
}

async function writeSubTree(node: SubTreeNode, objects: Map<string, Uint8Array>): Promise<string> {
  const entries: { sortKey: string; bytes: Uint8Array }[] = [];
  for (const [name, blob] of node.entries) {
    entries.push({ sortKey: name, bytes: concatArrays([ENCODER.encode(`${blob.mode} ${name}\0`), rawOid(blob.oid)]) });
  }
  for (const [name, child] of node.dirs) {
    const subtreeOid = await writeSubTree(child, objects);
    entries.push({
      sortKey: `${name}/`,
      bytes: concatArrays([ENCODER.encode(`40000 ${name}\0`), rawOid(subtreeOid)]),
    });
  }
  entries.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  const body = concatArrays(entries.map((e) => e.bytes));
  const raw = concatArrays([ENCODER.encode(`tree ${body.length}\0`), body]);
  const oid = await sha1Hex(raw);
  objects.set(oid, raw);
  return oid;
}

async function buildTypedPack(files: TypedFile[]): Promise<{ tip: string; pack: Uint8Array }> {
  const objects = new Map<string, Uint8Array>();
  const root = emptyNode();
  for (const file of files) {
    if (file.mode === "160000") continue; // gitlinks enter the tree below
    const content = ENCODER.encode(file.content);
    const raw = concatArrays([ENCODER.encode(`blob ${content.length}\0`), content]);
    const oid = await sha1Hex(raw);
    objects.set(oid, raw);
    insertPath(root, file.path, file.mode, oid);
  }
  for (const file of files) {
    if (file.mode !== "160000") continue;
    insertPath(root, file.path, file.mode, file.content);
  }
  const treeOid = await writeSubTree(root, objects);
  const who = `Test User <test@example.com> ${T0 + 240} +0000`;
  const commitBody = ENCODER.encode(`tree ${treeOid}\nauthor ${who}\ncommitter ${who}\n\ntvx sub: typed modes\n`);
  const commitRaw = concatArrays([ENCODER.encode(`commit ${commitBody.length}\0`), commitBody]);
  const tip = await sha1Hex(commitRaw);
  objects.set(tip, commitRaw);

  const chunks: Uint8Array[] = [ENCODER.encode("PACK"), be32(2), be32(objects.size)];
  for (const obj of objects.values()) {
    const nul = obj.indexOf(0);
    const body = obj.slice(nul + 1);
    const type = obj[0] === "c".charCodeAt(0) ? OBJ_COMMIT : obj[0] === "t".charCodeAt(0) ? OBJ_TREE : OBJ_BLOB;
    chunks.push(objectHeader(type, body.length));
    chunks.push(await zlibDeflate(body));
  }
  chunks.push(new Uint8Array(await crypto.subtle.digest("SHA-1", concatArrays(chunks))));
  return { tip, pack: concatArrays(chunks) };
}

/** The wave-129 view-raw pair fixture: two §4.2 binary blobs (a null byte
 *  inside the first 8 KiB is the whole sniff — the bytes are otherwise
 *  arbitrary). `logo.png` carries a media extension → the `<img>` embed;
 *  `payload.bin` has none → the View Raw prompt. */
const MEDIA_FILES: TypedFile[] = [
  { path: "logo.png", content: "\u0000PNG\r\n\u001a\ntvx-fake-image-bytes", mode: "100644" },
  { path: "payload.bin", content: "\u0000\u0001\u0002tvx-fake-binary", mode: "100644" },
];

/** `tvx-owner/tvx-media`: the view-raw fixture, public (unique name — the
 *  matrix files share one storage scope). */
const seedMediaRepo = once(async (): Promise<void> => {
  const db = drizzle(env.DB);
  const owner = await userIdOf("tvx-owner");
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(owner, "tvx-matrix-media")
    .run();
  const token = (await mintFor(owner, "tvx-matrix-media", "write:repository")).plaintext;
  const repoName = "tvx-owner/tvx-media";
  const refs = await env.REPO.getByName(repoName).listRefs();
  if (refs.head === null) {
    const { tip, pack } = await buildTypedPack(MEDIA_FILES);
    await pushRefs(repoName, [{ ref: "refs/heads/main", oid: tip }], pack, token);
  }
  let row = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "tvx-owner"), eq(repositories.slug, "tvx-media")))
    .get();
  if (row === undefined) {
    row = await new RepoService(env.DB).create({
      owner: { id: owner, usernameLower: "tvx-owner" },
      name: "tvx-media",
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
});

/** `tvx-owner/tvx-sub`: the typed-mode fixture, public. */
const seedSubRepo = once(async (): Promise<void> => {
  const db = drizzle(env.DB);
  const owner = await userIdOf("tvx-owner");
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(owner, "tvx-matrix-sub")
    .run();
  const token = (await mintFor(owner, "tvx-matrix-sub", "write:repository")).plaintext;
  const repoName = "tvx-owner/tvx-sub";
  const refs = await env.REPO.getByName(repoName).listRefs();
  if (refs.head === null) {
    const { tip, pack } = await buildTypedPack(SUB_FILES);
    await pushRefs(repoName, [{ ref: "refs/heads/main", oid: tip }], pack, token);
  }
  let row = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "tvx-owner"), eq(repositories.slug, "tvx-sub")))
    .get();
  if (row === undefined) {
    row = await new RepoService(env.DB).create({
      owner: { id: owner, usernameLower: "tvx-owner" },
      name: "tvx-sub",
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
});

beforeAll(async () => {
  await applyAuthD1Migrations();
  await seedVerifiedUser({ username: "tvx-owner" });
  await seedVerifiedUser({ username: "tvx-collab" });
  await seedVerifiedUser({ username: "tvx-out" });
  await seedVerifiedUser({ username: "tvx-reader" });
  await seedPubRepo();
  await seedSecretRepo();
  await seedSubRepo();
  await seedMediaRepo();
});

// --- the private-repo gates (anon / outsider / collaborator) ----------------------

describe("the private-repo gates with a session roster (the arms the anon-only suites lack)", () => {
  it("404-shells the anonymous viewer on the home page, the /src tree view AND the /tree-view aux", async () => {
    await seedSecretRepo();
    for (const path of [
      "/tvx-owner/tvx-secret",
      "/tvx-owner/tvx-secret/src/branch/main",
      "/tvx-owner/tvx-secret/tree-view/branch/main",
    ]) {
      const res = await fetchUi(path);
      expect(res.status, path).toBe(404);
      const html = await res.text();
      expect(html, path).toContain('<div class="status-page-error">');
      expect(html, path).not.toContain("repo-header"); // no repo context — existence hidden
    }
  });

  it("404-shells a signed-in NON-collaborator too (sessions buy no visibility)", async () => {
    await seedSecretRepo();
    const out = await userIdOf("tvx-out");
    for (const path of [
      "/tvx-owner/tvx-secret",
      "/tvx-owner/tvx-secret/src/branch/main",
      "/tvx-owner/tvx-secret/tree-view/branch/main",
    ]) {
      const res = await fetchUi(path, { headers: { cookie: await sessionHeader(out) } });
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain("repo-files-table");
    }
  });

  it("a signed-in WRITE COLLABORATOR renders the private repo — the SPEC-0005 landing flips the pinned deferral arm", async () => {
    await seedSecretRepo();
    // This arm was PINNED as the landed deferral: readGrant's session arms
    // were owner / site-admin / org-team and the repo_collaborators edge was
    // write-guard-only (repository.ts:199's SPEC-0005 TODO — "a future
    // SPEC-0005 landing must flip this arm deliberately"). The landing
    // folded the collaborator row into doerRepoAccessMode, so the write
    // collaborator's resolved grant (mode write ⇒ read + write) admits the
    // pages — flipped deliberately, owner arm's shape asserted here.
    const collab = await userIdOf("tvx-collab");
    const cookie = { headers: { cookie: await sessionHeader(collab) } };

    const home = await fetchUi("/tvx-owner/tvx-secret", cookie);
    expect(home.status).toBe(200);
    expect(tableSlice(await home.text())).toContain("tvx secret: readme and docs");

    const src = await fetchUi("/tvx-owner/tvx-secret/src/branch/main", cookie);
    expect(src.status).toBe(200);
    const srcHtml = await src.text();
    expect(srcHtml).toContain('class="page-content repository file list"');
    expect(tableSlice(srcHtml)).toContain('title="docs">docs</a>');
    // Mode write also arms the write chrome on the private repo (the
    // canWriteRepository grant arm — the same rule upstream ranks).
    expect(srcHtml).toContain('<a class="ui mini primary button" href="/tvx-owner/tvx-secret/new/main">');

    const aux = await fetchUi("/tvx-owner/tvx-secret/tree-view/branch/main", cookie);
    expect(aux.status).toBe(200);
    expect(aux.headers.get("content-type")).toBe("application/json;charset=utf-8");
    const parsed = await aux.json<{ fileTreeNodes: { entryName: string }[] }>();
    expect(parsed.fileTreeNodes.map((n) => n.entryName)).toEqual(["docs", "README.md"]);
  });

  it("the OWNER session renders all three surfaces", async () => {
    await seedSecretRepo();
    const owner = await userIdOf("tvx-owner");
    const cookie = { headers: { cookie: await sessionHeader(owner) } };

    const home = await fetchUi("/tvx-owner/tvx-secret", cookie);
    expect(home.status).toBe(200);
    expect(tableSlice(await home.text())).toContain("tvx secret: readme and docs");

    const src = await fetchUi("/tvx-owner/tvx-secret/src/branch/main", cookie);
    expect(src.status).toBe(200);
    const srcHtml = await src.text();
    expect(srcHtml).toContain('class="page-content repository file list"');
    expect(tableSlice(srcHtml)).toContain('title="docs">docs</a>');
    expect(tableSlice(srcHtml)).toContain('title="README.md">README.md</a>');

    const aux = await fetchUi("/tvx-owner/tvx-secret/tree-view/branch/main", cookie);
    expect(aux.status).toBe(200);
    expect(aux.headers.get("content-type")).toBe("application/json;charset=utf-8");
    const parsed = await aux.json<{ fileTreeNodes: { entryName: string }[] }>();
    expect(parsed.fileTreeNodes.map((n) => n.entryName)).toEqual(["docs", "README.md"]);
  });
});

// --- the git-HTTP readGrant's collaborator arms (SPEC-0005) ------------------------

describe("the git-HTTP readGrant's collaborator arms (acl.ts's recorded deferral, landed)", () => {
  /** A fresh token for the fixture user (delete-then-mint, the seeders'
   *  idempotent pattern — re-runs must not collide on the token name). */
  async function tokenFor(username: string, name: string, scope: "read:repository" | "write:repository"): Promise<string> {
    const id = await userIdOf(username);
    await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?").bind(id, name).run();
    return (await mintFor(id, name, scope)).plaintext;
  }

  it("a WRITE collaborator clones the private repo (the readGrant collaborator arm: any row grants read)", async () => {
    await seedSecretRepo();
    const token = await tokenFor("tvx-collab", "tvx-matrix-collab-clone", "read:repository");
    const res = await SELF.fetch("https://test.local/tvx-owner/tvx-secret.git/info/refs?service=git-upload-pack", {
      headers: { authorization: basicTokenHeader(token) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
  });

  it("a NON-collaborator still can't clone it (existence hidden — 404 Repository not found)", async () => {
    await seedSecretRepo();
    const token = await tokenFor("tvx-out", "tvx-matrix-out-clone", "read:repository");
    const res = await SELF.fetch("https://test.local/tvx-owner/tvx-secret.git/info/refs?service=git-upload-pack", {
      headers: { authorization: basicTokenHeader(token) },
    });
    expect(res.status).toBe(404);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("Repository not found");
  });

  it("mode write grants write: the write collaborator pushes a branch through the real receive-pack", async () => {
    await seedSecretRepo();
    const token = await tokenFor("tvx-collab", "tvx-matrix-collab-push", "write:repository");
    const { tips, pack } = await buildHistoryPack([
      {
        message: "tvx collab: pushed branch",
        time: T0 + 300,
        files: [{ path: "COLLAB.md", content: "pushed by the collaborator\n" }],
      },
    ]);
    const res = await SELF.fetch("https://test.local/tvx-owner/tvx-secret.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVING_CT },
      body: buildReceivePackBody([{ ref: "refs/heads/tvx-collab", oid: tips[0] as string }], pack),
    });
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(await res.arrayBuffer())).not.toContain("ng ");
  });

  it("mode read stays read-only: the READ collaborator clones but the push 404-masks (acl.ts's read-only-collaborator variant)", async () => {
    await seedSecretRepo();
    // A WRITE-scoped token for a READ-mode row: the scope half passes, the
    // repo grant half must not rank push (acl.ts's recorded "read-only
    // collaborator variant" — landed with the SPEC-0005 fold, pinned here).
    const token = await tokenFor("tvx-reader", "tvx-matrix-reader-push", "write:repository");
    const advert = await SELF.fetch("https://test.local/tvx-owner/tvx-secret.git/info/refs?service=git-upload-pack", {
      headers: { authorization: basicTokenHeader(token) },
    });
    expect(advert.status).toBe(200); // read per mode
    const { tips, pack } = await buildHistoryPack([
      {
        message: "tvx reader: refused branch",
        time: T0 + 360,
        files: [{ path: "READER.md", content: "must not land\n" }],
      },
    ]);
    const res = await SELF.fetch("https://test.local/tvx-owner/tvx-secret.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVING_CT },
      body: buildReceivePackBody([{ ref: "refs/heads/tvx-reader", oid: tips[0] as string }], pack),
    });
    expect(res.status).toBe(404); // write capability hidden (row 8's variant)
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("Repository not found");
  });
});

// --- the /src ref-resolution arms (route-real; index.test owns the pure table) ----

describe("the /src ref-resolution arms made route-real", () => {
  it("the root listing: the tip bar, per-row subjects split from the tip, entry links", async () => {
    await seedPubRepo();
    const res = await fetchUi("/tvx-owner/tvx-pub/src/branch/main");
    expect(res.status).toBe(200);
    const table = tableSlice(await res.text());
    // The latest-commit bar: the REF TIP (c3), with its commit link.
    expect(table).toContain('title="tvx c3: readme final"');
    expect(table).toContain(`<a href="/tvx-owner/tvx-pub/commit/${pubTips[3] as string}">tvx c3: readme final</a>`);
    // Per-row enrichment: README.md → c3, app.ts → c0, docs → c2 (via its
    // deep subtree — the engine's dir pathspec covers the subtree).
    expect(table).toContain(">tvx c0: readme and app</a>");
    expect(table).toContain(">tvx c2: deep extra</a>");
    expect(table).toContain('<a class="entry-name" href="/tvx-owner/tvx-pub/src/branch/main/docs" title="docs">docs</a>');
  });

  it("branch/HEAD swaps to the default branch (the root listing of main)", async () => {
    await seedPubRepo();
    const res = await fetchUi("/tvx-owner/tvx-pub/src/branch/HEAD");
    expect(res.status).toBe(200);
    expect(tableSlice(await res.text())).toContain('title="tvx c3: readme final"');
  });

  it("a slash-bearing branch is reachable: links, raw-link ref form and sidebar carry the slash ref", async () => {
    await seedPubRepo();
    const res = await fetchUi("/tvx-owner/tvx-pub/src/branch/green/deep/README.md");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content repository file list view file"');
    // c1's README — NOT the tip's v2 text.
    expect(html).toContain("readme v1");
    expect(html).not.toContain("readme v2");
    // The raw-file link echoes the branch ref URL-encoded (?ref=green%2Fdeep).
    expect(html).toContain('data-raw-file-link="/api/v1/repos/tvx-owner/tvx-pub/raw/README.md?ref=green%2Fdeep"');
    // The breadcrumb repo link and the active sidebar entry keep the slash.
    expect(html).toContain('href="/tvx-owner/tvx-pub/src/branch/green/deep"');
    expect(html).toContain('<a class="active" href="/tvx-owner/tvx-pub/src/branch/green/deep/README.md">README.md</a>');
  });

  it("the SHORTEST-PREFIX shadow: /branch/feature serves the SHORT branch; /branch/feature/deep 404s as its tree path", async () => {
    await seedPubRepo();
    // `feature` and `feature/deep` both exist — the walk stops at `feature`
    // (repo.go:833-845 first match), so this is c0's README.
    const short = await fetchUi("/tvx-owner/tvx-pub/src/branch/feature/README.md");
    expect(short.status).toBe(200);
    expect(await short.text()).toContain("readme v1");
    // …and the would-be deep branch's ROOT is read as feature's `deep` tree
    // path, which c0 does not carry → the §4.5 shell.
    const deep = await fetchUi("/tvx-owner/tvx-pub/src/branch/feature/deep");
    expect(deep.status).toBe(404);
    expect(await deep.text()).toContain('<div class="status-page-error">');
  });

  it("an unknown branch 404-shells at route level (§3.3 unresolvable ref)", async () => {
    await seedPubRepo();
    const res = await fetchUi("/tvx-owner/tvx-pub/src/branch/nosuchbranch");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('<div class="status-page-error">');
  });

  it("a SHORT sha 404-shells /src too (the full-oid divergence, tree-view's wave-43 pin at the /src twin)", async () => {
    await seedPubRepo();
    // Upstream's getRefName accepts 7..64 hex and rev-parse expands it; the
    // landed engine resolves full oids only (resolveServable's isOid gate) —
    // the documented divergence wave-43 pins for /tree-view, now pinned for
    // the /src twin so the two families cannot drift apart silently.
    const sha7 = (pubTips[0] as string).slice(0, 7);
    const res = await fetchUi(`/tvx-owner/tvx-pub/src/commit/${sha7}/README.md`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('<div class="status-page-error">');
  });
});

// --- the sub-directory navigation: rows + the directory's own latest-commit bar ---

describe("the sub-directory navigation (the dir bar is the dir's own commit, not the tip)", () => {
  it("the docs listing: bar shows c2 (the dir's own last commit via its deep subtree), parent link onto the root", async () => {
    await seedPubRepo();
    const res = await fetchUi("/tvx-owner/tvx-pub/src/branch/main/docs");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content repository file list"');
    const table = tableSlice(html);
    // The KEY arm: the bar is c2 — NOT the ref tip c3 (the tip touched only
    // the root, so pages.test's fixture shape could never separate these).
    expect(table).toContain('title="tvx c2: deep extra"');
    expect(table).toContain(`<a href="/tvx-owner/tvx-pub/commit/${pubTips[2] as string}">tvx c2: deep extra</a>`);
    expect(table).not.toContain("tvx c3: readme final");
    // The §5.1 parent-link row onto the ref root.
    expect(table).toContain('<a class="repo-file-line parent-link silenced" href="/tvx-owner/tvx-pub/src/branch/main">');
    // The rows: the dir first (engine tree order), guide.md enriched to c1.
    expect(table).toContain('<a class="entry-name" href="/tvx-owner/tvx-pub/src/branch/main/docs/deep" title="deep">deep</a>');
    expect(table).toContain(
      '<a class="entry-name" href="/tvx-owner/tvx-pub/src/branch/main/docs/guide.md" title="guide.md">guide.md</a>',
    );
    expect(table).toContain(">tvx c1: docs born</a>");
    expect(table.indexOf('title="deep"')).toBeLessThan(table.indexOf('title="guide.md"'));
  });

  it("the depth-2 listing: parent link onto docs, breadcrumb link/active split, c1/c2 row split", async () => {
    await seedPubRepo();
    const res = await fetchUi("/tvx-owner/tvx-pub/src/branch/main/docs/deep");
    expect(res.status).toBe(200);
    const html = await res.text();
    const table = tableSlice(html);
    // The parent-link row climbs ONE level (docs), not to the root.
    expect(table).toContain(
      '<a class="repo-file-line parent-link silenced" href="/tvx-owner/tvx-pub/src/branch/main/docs">',
    );
    // The breadcrumb: docs stays a cumulative LINK, deep is the ACTIVE text.
    expect(html).toContain('<span class="section"><a href="/tvx-owner/tvx-pub/src/branch/main/docs" title="docs">docs</a></span>');
    expect(html).toContain('<span class="active section" title="deep">deep</span>');
    // The bar is the dir's own commit (c2); the rows split c1/c2.
    expect(table).toContain('title="tvx c2: deep extra"');
    expect(table).toContain(">tvx c1: docs born</a>"); // handbook.md
    expect(table).toContain(
      '<a class="entry-name" href="/tvx-owner/tvx-pub/src/branch/main/docs/deep/extra.md" title="extra.md">extra.md</a>',
    );
    expect(table).toContain(
      '<a class="entry-name" href="/tvx-owner/tvx-pub/src/branch/main/docs/deep/handbook.md" title="handbook.md">handbook.md</a>',
    );
  });
});

// --- the depth-3 path edges (the breadcrumb chain + the raw/view pair) ------------

describe("the depth-3 blob view (the cumulative breadcrumb chain + the raw/view pair)", () => {
  it("the deep file view: repo→docs→deep link chain, handbook.md active, the Raw/History pair carries the escaped deep path", async () => {
    await seedPubRepo();
    const res = await fetchUi("/tvx-owner/tvx-pub/src/branch/main/docs/deep/handbook.md");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content repository file list view file"');
    // The breadcrumb's cumulative chain (view_content.tmpl's `.breadcrumb`):
    // the repo section links the ref root, docs and deep stay cumulative
    // LINKS at depth 3, and handbook.md is the ACTIVE plain text. The
    // depth-2 arm pins the two-segment split; this pins the chain's middle.
    expect(html).toContain('<a class="section" href="/tvx-owner/tvx-pub/src/branch/main" title="tvx-pub">tvx-pub</a>');
    expect(html).toContain('<span class="section"><a href="/tvx-owner/tvx-pub/src/branch/main/docs" title="docs">docs</a></span>');
    expect(html).toContain('<span class="section"><a href="/tvx-owner/tvx-pub/src/branch/main/docs/deep" title="deep">deep</a></span>');
    expect(html).toContain('<span class="active section" title="handbook.md">handbook.md</span>');
    expect(html).toContain('<span class="breadcrumb-divider">/</span>');
    // The raw/view pair (file header actions): Raw targets the tier-1 API
    // raw route with the ref query, History the commits page's path filter —
    // both carrying the slash-bearing deep path (encoded per component).
    expect(html).toContain(
      '<a class="ui mini basic button" href="/api/v1/repos/tvx-owner/tvx-pub/raw/docs/deep/handbook.md?ref=main">Raw</a>',
    );
    expect(html).toContain(
      '<a class="ui mini basic button" href="/tvx-owner/tvx-pub/commits?path=docs%2Fdeep%2Fhandbook.md">History</a>',
    );
    // The enhancement registry root (the copy button's data source) carries
    // the same raw link, and the sidebar keeps the active sibling split.
    expect(html).toContain('data-raw-file-link="/api/v1/repos/tvx-owner/tvx-pub/raw/docs/deep/handbook.md?ref=main"');
    expect(html).toContain('<a class="active" href="/tvx-owner/tvx-pub/src/branch/main/docs/deep/handbook.md">handbook.md</a>');
    expect(html).toContain('<a href="/tvx-owner/tvx-pub/src/branch/main/docs/deep/extra.md">extra.md</a>');
    // The file-level latest-commit seam: handbook.md was born at c1 and
    // untouched since — the box shows c1, NOT the tip (c3) and NOT the
    // directory's c2.
    expect(html).toContain('title="tvx c1: docs born"');
    expect(html).toContain(`<a href="/tvx-owner/tvx-pub/commit/${pubTips[1] as string}">tvx c1: docs born</a>`);
    expect(html).not.toContain("tvx c3: readme final");
  });
});

describe("the §4.2 view-raw pair (the binary sniff's two arms)", () => {
  it("a media-extension binary embeds the raw route as the img src", async () => {
    await seedMediaRepo();
    const res = await fetchUi("/tvx-owner/tvx-media/src/branch/main/logo.png");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content repository file list view file"');
    // The null byte in the first 8 KiB → isBinaryData → `.view-raw`; the
    // .png extension → the image embed whose alt/src are BOTH the raw URL.
    expect(html).toContain('<div class="view-raw">');
    expect(html).toContain(
      '<img alt="/api/v1/repos/tvx-owner/tvx-media/raw/logo.png?ref=main" src="/api/v1/repos/tvx-owner/tvx-media/raw/logo.png?ref=main"/>',
    );
    // The registry root still carries the raw link (the copy button's data
    // source) even on the media arm.
    expect(html).toContain('data-raw-file-link="/api/v1/repos/tvx-owner/tvx-media/raw/logo.png?ref=main"');
  });

  it("a binary WITHOUT a media extension renders the View Raw prompt instead", async () => {
    await seedMediaRepo();
    const res = await fetchUi("/tvx-owner/tvx-media/src/branch/main/payload.bin");
    expect(res.status).toBe(200);
    const html = await res.text();
    // Same binary sniff, no media kind → the render-refusal prompt with the
    // View Raw anchor (view_file.tmpl's else branch — rel="nofollow" rides).
    expect(html).toContain('<div class="file-view-raw-prompt tw-p-4">');
    expect(html).toContain(
      '<a href="/api/v1/repos/tvx-owner/tvx-media/raw/payload.bin?ref=main" rel="nofollow">View Raw</a>',
    );
    expect(html).not.toContain('<img alt='); // no media embed on the prompt arm
  });
});

// --- the write chrome (wave 8's canWrite surface, session-gated) -------------------

describe("the write chrome (canWrite through the minted session)", () => {
  it("anonymous viewers get NO New File / Edit / Delete on tree or blob views", async () => {
    await seedPubRepo();
    const tree = await (await fetchUi("/tvx-owner/tvx-pub/src/branch/main")).text();
    expect(tree).not.toContain("New File");
    expect(tree).not.toContain("/new/");
    const blob = await (await fetchUi("/tvx-owner/tvx-pub/src/branch/main/README.md")).text();
    expect(blob).not.toContain('aria-label="Edit"');
    expect(blob).not.toContain('aria-label="Delete"');
    expect(blob).not.toContain("/edit/");
    expect(blob).not.toContain("/delete/");
  });

  it("a signed-in NON-collaborator on a PUBLIC repo gets no write chrome either", async () => {
    await seedPubRepo();
    const out = await userIdOf("tvx-out");
    const cookie = { headers: { cookie: await sessionHeader(out) } };
    const tree = await (await fetchUi("/tvx-owner/tvx-pub/src/branch/main", cookie)).text();
    expect(tree).not.toContain("New File");
    const blob = await (await fetchUi("/tvx-owner/tvx-pub/src/branch/main/README.md", cookie)).text();
    expect(blob).not.toContain('aria-label="Edit"');
  });

  it("a signed-in WRITE COLLABORATOR (no ownership) gets the chrome on the PUBLIC repo — the grant arm", async () => {
    await seedPubRepo();
    const collab = await userIdOf("tvx-collab");
    const res = await fetchUi("/tvx-owner/tvx-pub/src/branch/main", {
      headers: { cookie: await sessionHeader(collab) },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<a class="ui mini primary button" href="/tvx-owner/tvx-pub/new/main">');
    expect(html).toContain("New File");
  });

  it("the OWNER gets the New File link at the root AND in the sub-directory (the dir-path form), plus blob Edit/Delete", async () => {
    await seedPubRepo();
    const owner = await userIdOf("tvx-owner");
    const cookie = { headers: { cookie: await sessionHeader(owner) } };

    const root = await fetchUi("/tvx-owner/tvx-pub/src/branch/main", cookie);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('<a class="ui mini primary button" href="/tvx-owner/tvx-pub/new/main">');

    const docs = await fetchUi("/tvx-owner/tvx-pub/src/branch/main/docs", cookie);
    expect(docs.status).toBe(200);
    expect(await docs.text()).toContain('<a class="ui mini primary button" href="/tvx-owner/tvx-pub/new/main/docs">');

    const blob = await fetchUi("/tvx-owner/tvx-pub/src/branch/main/README.md", cookie);
    expect(blob.status).toBe(200);
    const blobHtml = await blob.text();
    expect(blobHtml).toContain(
      '<a class="btn-octicon" href="/tvx-owner/tvx-pub/edit/main/README.md" aria-label="Edit" title="Edit">',
    );
    expect(blobHtml).toContain(
      '<a class="btn-octicon" href="/tvx-owner/tvx-pub/delete/main/README.md" aria-label="Delete" title="Delete">',
    );
  });

  it("a commit ref suppresses the write chrome for the same owner (no editor target)", async () => {
    await seedPubRepo();
    const owner = await userIdOf("tvx-owner");
    const cookie = { headers: { cookie: await sessionHeader(owner) } };
    const blob = await (await fetchUi(`/tvx-owner/tvx-pub/src/commit/${pubTips[3] as string}/README.md`, cookie)).text();
    expect(blob).toContain("readme v2");
    expect(blob).not.toContain("New File");
    expect(blob).not.toContain('aria-label="Edit"');
    expect(blob).not.toContain('aria-label="Delete"');
  });

  it("an ARCHIVED repo suppresses the write chrome for the owner (the isArchived short-circuit)", async () => {
    await seedPubRepo();
    const owner = await userIdOf("tvx-owner");
    const cookie = { headers: { cookie: await sessionHeader(owner) } };
    const db = drizzle(env.DB);
    await db.update(repositories).set({ isArchived: true }).where(eq(repositories.id, pubRowId as string));
    try {
      const res = await fetchUi("/tvx-owner/tvx-pub/src/branch/main", cookie);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain("New File");
      expect(html).not.toContain("/new/");
    } finally {
      await db.update(repositories).set({ isArchived: false }).where(eq(repositories.id, pubRowId as string));
    }
  });
});

// --- the §4.10 typed-mode rows (submodule / symlink / exec / escaped names) --------

describe("the typed-mode file-list rows (the 100644-only seed builder cannot reach these)", () => {
  it("the root listing: vendor tree row, exec and symlink rows as plain file links, the ampersand href escaped", async () => {
    await seedSubRepo();
    const res = await fetchUi("/tvx-owner/tvx-sub/src/branch/main");
    expect(res.status).toBe(200);
    const table = tableSlice(await res.text());
    // The directory row keeps the fill glyph and the tree link.
    expect(table).toContain("octicon-file-directory-fill");
    expect(table).toContain('<a class="entry-name" href="/tvx-owner/tvx-sub/src/branch/main/vendor" title="vendor">vendor</a>');
    // §4.10's documented glyph degradation: exec and symlink entries render
    // the shared file row/link shape (no dedicated octicons v1).
    expect(table).toContain('<a class="entry-name" href="/tvx-owner/tvx-sub/src/branch/main/run.sh" title="run.sh">run.sh</a>');
    expect(table).toContain(
      '<a class="entry-name" href="/tvx-owner/tvx-sub/src/branch/main/link-file" title="link-file">link-file</a>',
    );
    // The ampersand name round-trips percent-encoded in the href (one URL
    // segment) and HTML-escaped in the title/text attributes.
    expect(table).toContain(
      '<a class="entry-name" href="/tvx-owner/tvx-sub/src/branch/main/a%26b.md" title="a&amp;b.md">a&amp;b.md</a>',
    );
  });

  it("the submodule row renders `name @ <short-sha>` as PLAIN TEXT — never an anchor", async () => {
    await seedSubRepo();
    const res = await fetchUi("/tvx-owner/tvx-sub/src/branch/main/vendor");
    expect(res.status).toBe(200);
    const table = tableSlice(await res.text());
    expect(table).toContain(`<span class="entry-name" title="lib">lib @ ${LIB_OID.slice(0, 10)}</span>`);
    expect(table).not.toContain('href="/tvx-owner/tvx-sub/src/branch/main/vendor/lib"');
  });

  it("the submodule PATH 404-shells the file view (§4.10: no content view v1)", async () => {
    await seedSubRepo();
    const res = await fetchUi("/tvx-owner/tvx-sub/src/branch/main/vendor/lib");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<div class="status-page-error">');
    expect(html).toContain("repo-header"); // repo context kept (§4.5)
  });
});

// --- the claim pin (.git trim + the bare /src tail) -------------------------------

describe("the claim pin (the .git-trimmed repo segment and the bare /src tail)", () => {
  it("the .git trim claims into src and tree-view-aux (parse level)", () => {
    expect(parseUiRoute("/tvx-owner/tvx-pub.git/src/branch/main")).toEqual({
      family: "src",
      owner: "tvx-owner",
      repo: "tvx-pub",
      refSuffix: "branch/main",
    });
    expect(parseUiRoute("/tvx-owner/tvx-secret.git/tree-view/branch/main")).toEqual({
      family: "tree-view-aux",
      owner: "tvx-owner",
      repo: "tvx-secret",
      refType: "branch",
      refSuffix: "main",
    });
    expect(handlesUiRoute("/tvx-owner/tvx-pub.git/src/branch/main")).toBe(true);
    expect(handlesUiRoute("/tvx-owner/tvx-pub/src")).toBe(true);
  });

  it("the .git URL serves the same page and the trimmed private claim rides the gate", async () => {
    await seedPubRepo();
    await seedSecretRepo();
    const trimmed = await fetchUi("/tvx-owner/tvx-pub.git/src/branch/main");
    expect(trimmed.status).toBe(200);
    expect(tableSlice(await trimmed.text())).toContain('title="tvx c3: readme final"');

    // The .git-trimmed tree-view claim on the PRIVATE repo resolves the same
    // row, so the owner session answers it (the gate reads the trimmed
    // identity, not the raw segment).
    const owner = await userIdOf("tvx-owner");
    const aux = await fetchUi("/tvx-owner/tvx-secret.git/tree-view/branch/main", {
      headers: { cookie: await sessionHeader(owner) },
    });
    expect(aux.status).toBe(200);
    expect(aux.headers.get("content-type")).toBe("application/json;charset=utf-8");
  });

  it("the bare /src tail 404-shells WITH the repo header (the §4.5 context rule)", async () => {
    await seedPubRepo();
    const res = await fetchUi("/tvx-owner/tvx-pub/src");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("repo-header");
    expect(html).toContain('<div class="status-page-error">');
    expect(html).not.toContain("repo-files-table");
  });
});
