/**
 * Pages wave 43 route tests — the file-tree JSON envelope, the parity
 * survey's PARTIAL row-5 gated half: `/{owner}/{repo}/tree-view/
 * {branch|tag|commit}/*?sub_path=…` (pages/tree-view-aux.ts, upstream
 * web.go:1302-1306 repo.TreeViewNodes over services/repository/files/
 * tree.go's TreeViewNode walk) — the feed the official bundle's
 * ViewFileTreeStore fetches and mounts.
 *
 * Upstream contracts under test (the module doc carries the cites):
 * the `{fileTreeNodes, renderedIconPool}` envelope with the TREE-VIEW NODE
 * field set in Go marshal order (entryName/entryMode/entryIcon always;
 * entryIconOpen for raw-mode directories; symLinkedToMode never — the
 * struct's TODO; fullPath; submoduleUrl for resolvable .gitmodules links;
 * children only along the sub_path chain), the Go `json.MarshalWrite` wire
 * bytes (HTML escaping `\u003c/\u003e/\u0026`, SORTED map keys — envelope
 * and pool alike, `[]`/`{}` for empty containers), the typed ref-tail
 * resolution (branch walk + HEAD swap / tag walk / full-oid commit), the
 * treePath-rooted listing, the single-chain `?sub_path=` expansion (with
 * the leading-slash quirk), sortTreeViewNodes (dirs+commits first, then the
 * natural sort), the symlink arms (single hop, dir targets only, the escape
 * arm unresolved), the exec/commit entry modes over the raw git modes, and
 * the 404 family (empty repo, wrong universe, short/unknown oid, missing
 * treePath, private/unknown repo).
 *
 * The ICON BYTES inside the envelope are asserted through the landed
 * fileicon layer's own public API (cdf683a — its wave test pins the markup
 * byte-exactly; this test pins the envelope AROUND it: field order,
 * omissions, escapes, pool membership/sorting, resolution semantics). That
 * edge is DYNAMIC (probeIcon/fileiconMod below) for the same ws1009 reason
 * as the production module's lazy boundary — a static import would merge
 * the icon-JSON graph into this file's runner snapshot on top of index.ts's.
 *
 * Same harness posture as pages-wave39/41: the router driven directly with
 * the synthetic ASSETS manifest; engine content seeds through the REAL
 * receive flow (SELF.fetch → git-receive-pack) with fixed timestamps. The
 * seed pack is built locally because testing/seed-repo.ts's SeedCommit
 * hardcodes blob mode 100644 — this fixture needs 100755 (exec), 120000
 * (symlinks) and 160000 (gitlinks) entries; the push itself rides the
 * landed flow verbatim. Fixture repos `alice/wave43tv` (single commit c0)
 * and `alice/wave43empty` (never pushed — the nil-Commit arm).
 */

import { env, SELF } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { settleCreatingRepo } from "../../git-http/gate";
import { repositories, users } from "../../db/schema";
import { RepoService } from "../../repos/service";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import type { EntryMode } from "../fileicon/fileicon";
import {
  goJsonString,
  goPathClean,
  goPathDir,
  goPathJoin,
  marshalTreeViewEnvelope,
  parseEntryMode,
  parseGitmodules,
  parseRepositoryWebLink,
  submoduleCommitWebLink,
  treeViewResponse,
} from "../pages/tree-view-aux";
import { buildReceivePackBody } from "../testing/seed-repo";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`), uiEnv);
}

// --- the typed-mode pack builder (the local fixture primitive) ------------------

const ENCODER = new TextEncoder();

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
  for (let i = 0; i < 20; i++) raw[i] = Number.parseInt(oidHex.slice(i * 2, i * 2 + 2), 16);
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
const TREE_TAG = "t".charCodeAt(0);
const COMMIT_TAG = "c".charCodeAt(0);

interface TypedSeedFile {
  path: string;
  content: string | Uint8Array;
  /** The raw git mode: 100644 (default), 100755, 120000 — or 160000, whose
   *  content is the gitlink TARGET oid (no object is emitted for it). */
  mode?: "100644" | "100755" | "120000" | "160000";
}

interface FixtureTreeNode {
  entries: Map<string, { mode: string; oid: string }>;
  dirs: Map<string, FixtureTreeNode>;
}

function emptyNode(): FixtureTreeNode {
  return { entries: new Map(), dirs: new Map() };
}

function insertPath(root: FixtureTreeNode, path: string, mode: string, oid: string): void {
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

async function writeFixtureTree(node: FixtureTreeNode, objects: Map<string, Uint8Array>): Promise<string> {
  const entries: { sortKey: string; bytes: Uint8Array }[] = [];
  for (const [name, blob] of node.entries) {
    entries.push({ sortKey: name, bytes: concatArrays([ENCODER.encode(`${blob.mode} ${name}\0`), rawOid(blob.oid)]) });
  }
  for (const [name, child] of node.dirs) {
    const subtreeOid = await writeFixtureTree(child, objects);
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

/** One commit with its full tree — real SHA-1s, fixed times (deterministic
 *  oids). Gitlink entries store their target oid without emitting it. */
async function buildTypedPack(files: TypedSeedFile[]): Promise<{ tip: string; pack: Uint8Array }> {
  const objects = new Map<string, Uint8Array>();
  const root = emptyNode();
  for (const file of files) {
    const mode = file.mode ?? "100644";
    if (mode === "160000") continue; // gitlinks enter the tree below, after the blob pass
    const content = typeof file.content === "string" ? ENCODER.encode(file.content) : file.content;
    const raw = concatArrays([ENCODER.encode(`blob ${content.length}\0`), content]);
    const oid = await sha1Hex(raw);
    objects.set(oid, raw);
    insertPath(root, file.path, mode, oid);
  }
  for (const file of files) {
    if (file.mode !== "160000") continue;
    insertPath(root, file.path, file.mode, file.content as string);
  }
  const treeOid = await writeFixtureTree(root, objects);
  const who = `Test User <test@example.com> ${T0} +0000`;
  const commitBody = ENCODER.encode(`tree ${treeOid}\nauthor ${who}\ncommitter ${who}\n\nwave43: typed-mode fixture\n`);
  const commitRaw = concatArrays([ENCODER.encode(`commit ${commitBody.length}\0`), commitBody]);
  const tip = await sha1Hex(commitRaw);
  objects.set(tip, commitRaw);

  const chunks: Uint8Array[] = [ENCODER.encode("PACK"), be32(2), be32(objects.size)];
  for (const obj of objects.values()) {
    const nul = obj.indexOf(0);
    const body = obj.slice(nul + 1);
    const tag = obj[0];
    const type = tag === COMMIT_TAG ? OBJ_COMMIT : tag === TREE_TAG ? OBJ_TREE : OBJ_BLOB;
    chunks.push(objectHeader(type, body.length));
    chunks.push(await zlibDeflate(body));
  }
  chunks.push(new Uint8Array(await crypto.subtle.digest("SHA-1", concatArrays(chunks))));
  return { tip, pack: concatArrays(chunks) };
}

// --- fixtures -------------------------------------------------------------------

const GITMODULES = [
  '[submodule "vendor-lib"]',
  "\tpath = vendor/lib",
  "\turl = ../vendor-lib.git",
  "\t# a comment the scanner skips",
  '[submodule "remote"]',
  "\tpath = vendor/remote",
  "\turl = https://github.com/example/remote-sub.git",
  '[submodule "scp"]',
  "\tpath = vendor/scp",
  "\turl = git@github.com:example/scp-sub.git",
  "",
].join("\n");

const LIB_OID = "5".repeat(40);
const REMOTE_OID = "6".repeat(40);
const SCP_OID = "7".repeat(40);

const WAVE43_FILES: TypedSeedFile[] = [
  { path: "README.md", content: "wave43 readme\n" },
  { path: "a&b.md", content: "escaped name fixture\n" },
  { path: "app.ts", content: 'console.log("wave43");\n' },
  { path: "run.sh", content: "echo wave43\n", mode: "100755" },
  { path: ".gitmodules", content: GITMODULES },
  { path: "docs/notes.md", content: "# wave43 notes\n" },
  { path: "docs/deep/guide.md", content: "# deep guide\n" },
  { path: "libs/inner/keep.txt", content: "kept\n" },
  { path: "link-dir", content: "docs", mode: "120000" },
  { path: "link-file", content: "README.md", mode: "120000" },
  { path: "link-escape", content: "../outside", mode: "120000" },
  { path: "vendor/lib", content: LIB_OID, mode: "160000" },
  { path: "vendor/remote", content: REMOTE_OID, mode: "160000" },
  { path: "vendor/scp", content: SCP_OID, mode: "160000" },
];

/** The recursive shape of the parsed envelope (test-side mirror of
 *  TreeViewNodeJson). */
interface ParsedNode {
  entryName: string;
  entryMode: string;
  entryIcon: string;
  entryIconOpen?: string;
  fullPath: string;
  submoduleUrl?: string;
  children?: ParsedNode[];
}

interface ParsedEnvelope {
  fileTreeNodes: ParsedNode[];
  renderedIconPool: Record<string, string>;
}

async function pushRefs(repoName: string, updates: { ref: string; oid: string }[], pack: Uint8Array, token: string): Promise<void> {
  const response = await SELF.fetch(`https://test.local/${repoName}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
    body: buildReceivePackBody(updates, pack),
  });
  const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
  if (response.status !== 200 || responseBody.includes("ng ")) {
    throw new Error(`wave43 seed push failed: ${response.status} ${responseBody.slice(0, 400)}`);
  }
}

/** Idempotent seed (the wave-39 recipe): owner row, one typed-mode pack
 *  push (main + tag v43 at c0), settle + public; plus the never-pushed
 *  `alice/wave43empty` row. */
async function ensureWave43Repos(): Promise<{ tip: string }> {
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  const alice =
    (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get()) ??
    (await seedVerifiedUser({ username: "alice" }));
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(alice.id, "ui-page-seed-wave43")
    .run();
  const token = (await mintFor(alice.id, "ui-page-seed-wave43", "write:repository")).plaintext;

  const repoName = "alice/wave43tv";
  const refs = await env.REPO.getByName(repoName).listRefs();
  let tip: string;
  if (refs.head === null) {
    const seeded = await buildTypedPack(WAVE43_FILES);
    tip = seeded.tip;
    await pushRefs(
      repoName,
      [
        { ref: "refs/heads/main", oid: tip },
        { ref: "refs/tags/v43", oid: tip },
      ],
      seeded.pack,
      token,
    );
  } else {
    tip = (await buildTypedPack(WAVE43_FILES)).tip;
  }

  let row = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave43tv")))
    .get();
  if (row === undefined) {
    row = await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "wave43tv",
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

  // The never-pushed repo (the nil-Commit arm).
  const emptyName = "alice/wave43empty";
  let emptyRow = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave43empty")))
    .get();
  if (emptyRow === undefined) {
    emptyRow = await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "wave43empty",
      isPrivate: false,
      status: "ready",
    });
  } else {
    await settleCreatingRepo(env, emptyRow.id, emptyName);
  }
  if (emptyRow.visibility !== "public") {
    await db.update(repositories).set({ visibility: "public" }).where(eq(repositories.id, emptyRow.id));
  }

  return { tip };
}

let wave43Tip: string | null = null;

async function tip(): Promise<string> {
  if (wave43Tip === null) wave43Tip = (await ensureWave43Repos()).tip;
  return wave43Tip;
}

beforeAll(async () => {
  await tip();
});

// --- the route shape (the parser is the single owner) ----------------------------

describe("wave-43 parser family (parseUiRoute / handlesUiRoute)", () => {
  it("claims the typed tree-view tails and nothing else in the space", () => {
    expect(parseUiRoute("/octo/hello/tree-view/branch/feature/one/src")).toEqual({
      family: "tree-view-aux",
      owner: "octo",
      repo: "hello",
      refType: "branch",
      refSuffix: "feature/one/src",
    });
    expect(parseUiRoute("/octo/hello/tree-view/tag/v1.0/rc")).toEqual({
      family: "tree-view-aux",
      owner: "octo",
      repo: "hello",
      refType: "tag",
      refSuffix: "v1.0/rc",
    });
    expect(parseUiRoute(`/octo/hello/tree-view/commit/${"a".repeat(40)}/docs`)).toEqual({
      family: "tree-view-aux",
      owner: "octo",
      repo: "hello",
      refType: "commit",
      refSuffix: `${"a".repeat(40)}/docs`,
    });
    // Below the typed tail: chi's sub-routes need `/type/*`.
    expect(parseUiRoute("/octo/hello/tree-view")).toBeNull();
    expect(parseUiRoute("/octo/hello/tree-view/branch")).toBeNull();
    // The type literal is the route shape (web.go:1302-1306).
    expect(parseUiRoute("/octo/hello/tree-view/bogus/x")).toBeNull();
    expect(parseUiRoute("/octo/hello/tree-view/branch/%zz")).toBeNull(); // undecodable → engine
    expect(handlesUiRoute("/octo/hello/tree-view/branch/main")).toBe(true);
    expect(handlesUiRoute("/octo/hello/tree-view/bogus/main")).toBe(false);
    // The sibling family literals stay distinct.
    expect(parseUiRoute("/octo/hello/tree/branch/main")).toEqual({
      family: "tree",
      owner: "octo",
      repo: "hello",
      rawSuffix: "branch/main",
    });
    expect(parseUiRoute("/octo/hello/tree-list/branch/main")).toEqual({
      family: "tree-list-aux",
      owner: "octo",
      repo: "hello",
      refType: "branch",
      refSuffix: "main",
    });
  });
});

// --- the pure ports --------------------------------------------------------------

describe("goPathClean/goPathJoin/goPathDir (go/src/path ports)", () => {
  it.each([
    ["a/b/../c", "a/c"],
    ["../x", "../x"],
    ["/a/..", "/"],
    ["a//b", "a/b"],
    ["", "."],
    [".", "."],
    ["./y", "y"],
    ["/", "/"],
    ["a/..", "."],
    ["docs/./deep/../guide.md", "docs/guide.md"],
  ])("cleans %s → %s", (input, expected) => {
    expect(goPathClean(input)).toBe(expected);
  });
  it("joins and dirs like path.Join/path.Dir", () => {
    expect(goPathJoin("docs", "../x")).toBe("x");
    expect(goPathJoin(".", "../x")).toBe("../x"); // escapes the root — the walk's guard arm
    expect(goPathJoin("", "a/b")).toBe("a/b");
    expect(goPathJoin("libs", "inner")).toBe("libs/inner");
    expect(goPathDir("docs/link")).toBe("docs");
    expect(goPathDir("link")).toBe(".");
  });
});

describe("parseEntryMode (tree_entry_mode.go:57-92 port)", () => {
  it.each([
    ["100644", "blob"],
    ["100755", "exec"],
    ["120000", "symlink"],
    ["160000", "commit"],
    ["40000", "tree"],
    ["040000", "tree"],
    ["000000", "unknown"],
    ["040755", "tree"], // the mask fallback (non-standard implementations)
    ["100777", "blob"], // mask fallback: 0o777 ≠ 0o755 → the blob arm
    ["junk", "unknown"],
  ])("parses %s → %s", (mode, expected) => {
    expect(parseEntryMode(mode)).toBe(expected);
  });
});

describe("goJsonString (encoding/json's string encoder, EscapeHTML default)", () => {
  it("escapes the wire-observed set byte-exactly", () => {
    expect(goJsonString('say "hi"\\back')).toBe('"say \\"hi\\"\\\\back"');
    expect(goJsonString("line\nbreak\r\ttab")).toBe('"line\\nbreak\\r\\ttab"');
    expect(goJsonString("\u0001\u001f")).toBe('"\\u0001\\u001f"');
    expect(goJsonString('<svg id="s">&amp;')).toBe('"\\u003csvg id=\\"s\\"\\u003e\\u0026amp;"');
    expect(goJsonString("sep\u2028sep\u2029")).toBe('"sep\\u2028sep\\u2029"');
    expect(goJsonString("café ☕")).toBe('"café ☕"'); // valid non-ASCII rides raw
  });
  it("replaces lone surrogates with \\ufffd and keeps well-formed pairs", () => {
    expect(goJsonString("\ud800")).toBe('"\\ufffd"');
    expect(goJsonString("tail\udc00")).toBe('"tail\\ufffd"');
    expect(goJsonString("pair \ud83d\ude00 end")).toBe('"pair \ud83d\ude00 end"');
  });
});

describe("parseGitmodules (config_submodule.go:21-72 port)", () => {
  it("parses the fixture's three sections keyed by path", () => {
    const parsed = parseGitmodules(GITMODULES);
    expect([...parsed.keys()].sort()).toEqual(["vendor/lib", "vendor/remote", "vendor/scp"]);
    expect(parsed.get("vendor/lib")?.url).toBe("../vendor-lib.git");
    expect(parsed.get("vendor/remote")?.url).toBe("https://github.com/example/remote-sub.git");
    expect(parsed.get("vendor/scp")?.url).toBe("git@github.com:example/scp-sub.git");
  });
  it("skips comments, non-submodule sections and keyless lines", () => {
    const parsed = parseGitmodules(
      [
        "; leading comment",
        "[core]",
        "\trepositoryformatversion = 0",
        '[submodule "a"]',
        "\tpath = dir/a",
        "\turl = ../a.git?token=xyz", // the FIRST '=' splits — '=' rides the value
        "\tno-equals-line",
        '[branch "main"]',
        '[submodule "b"]',
        "\tpath = dir/b",
        "",
      ].join("\n"),
    );
    expect([...parsed.keys()].sort()).toEqual(["dir/a", "dir/b"]);
    expect(parsed.get("dir/a")?.url).toBe("../a.git?token=xyz");
    expect(parsed.get("dir/b")?.url).toBe(""); // section opened, url never given
  });
});

describe("submodule web links (commit_submodule_file.go + url.go guess arms)", () => {
  it("resolves the relative arm through the repoLink namespace", () => {
    expect(submoduleCommitWebLink("/alice/wave43tv", "../vendor-lib.git", LIB_OID)).toBe(`/alice/vendor-lib.git/tree/${LIB_OID}`);
    expect(submoduleCommitWebLink("/alice/wave43tv", "", LIB_OID)).toBeNull();
  });
  it("guesses the absolute arms and answers null on malformed remotes", () => {
    expect(parseRepositoryWebLink("https://github.com/example/remote-sub.git")).toBe("https://github.com/example/remote-sub");
    expect(parseRepositoryWebLink("http://git.example:8080/x/y.git")).toBe("http://git.example:8080/x/y");
    expect(parseRepositoryWebLink("ssh://git@host.example/owner/repo.git")).toBe("https://host.example/owner/repo");
    expect(parseRepositoryWebLink("git+ssh://git@host.example/owner/repo.git")).toBe("https://host.example/owner/repo");
    expect(parseRepositoryWebLink("git@github.com:example/scp-sub.git")).toBe("https://github.com/example/scp-sub");
    // The scp form keeps everything after the FIRST unbracketed colon as the
    // path (url.go's scan) — a port-looking second segment rides it.
    expect(parseRepositoryWebLink("git@example.host:22:owner/r.git")).toBe("https://example.host/22:owner/r");
    expect(parseRepositoryWebLink("git@host:")).toBeNull(); // colon-terminated → ErrWrongURLFormat
    expect(parseRepositoryWebLink("local/dir/repo")).toBe(""); // the file-path fallthrough
    expect(submoduleCommitWebLink("/o/r", "https://github.com/e/x.git", REMOTE_OID)).toBe(`https://github.com/e/x/tree/${REMOTE_OID}`);
  });
});

describe("marshalTreeViewEnvelope (the wire bytes)", () => {
  it("emits the Go envelope: sorted keys, empty containers, field order", () => {
    expect(marshalTreeViewEnvelope({ fileTreeNodes: [], renderedIconPool: new Map() })).toBe(
      '{"fileTreeNodes":[],"renderedIconPool":{}}',
    );
    const node = { entryName: "x", entryMode: "blob", entryIcon: "<svg>a</svg>", fullPath: "x" };
    expect(
      marshalTreeViewEnvelope({
        fileTreeNodes: [node],
        renderedIconPool: new Map([
          ["svg-mfi-z", "z<>"],
          ["svg-mfi-a", "a&"],
        ]),
      }),
    ).toBe(
      `{"fileTreeNodes":[{"entryName":"x","entryMode":"blob","entryIcon":${goJsonString("<svg>a</svg>")},"fullPath":"x"}],` +
        `"renderedIconPool":{${goJsonString("svg-mfi-a")}:${goJsonString("a&")},${goJsonString("svg-mfi-z")}:${goJsonString("z<>")}}}`,
    );
  });
  it("carries the omitempty arms in the Go struct's positions", () => {
    const node = {
      entryName: "d",
      entryMode: "tree",
      entryIcon: "closed",
      entryIconOpen: "open",
      symLinkedToMode: "never-set-at-the-pin",
      fullPath: "d",
      submoduleUrl: "u",
      children: [{ entryName: "f", entryMode: "blob", entryIcon: "i", fullPath: "d/f" }],
    };
    const bytes = marshalTreeViewEnvelope({ fileTreeNodes: [node], renderedIconPool: new Map() });
    expect(bytes.indexOf('"entryIconOpen"')).toBeGreaterThan(bytes.indexOf('"entryIcon"'));
    expect(bytes.indexOf('"symLinkedToMode"')).toBeGreaterThan(bytes.indexOf('"entryIconOpen"'));
    expect(bytes.indexOf('"fullPath"')).toBeGreaterThan(bytes.indexOf('"symLinkedToMode"'));
    expect(bytes.indexOf('"submoduleUrl"')).toBeGreaterThan(bytes.indexOf('"fullPath"'));
    expect(bytes.indexOf('"children"')).toBeGreaterThan(bytes.indexOf('"submoduleUrl"'));
  });
  it("serves with the aux-JSON header pair", () => {
    const res = treeViewResponse({ fileTreeNodes: [], renderedIconPool: new Map() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
  });
});

// --- the route-level envelope -----------------------------------------------------

/**
 * The icon probe: expected markup through the landed fileicon API (the
 * envelope pins the bytes AROUND these — see the file header). The fileicon
 * edge is DYNAMIC here — the same ws1009 reason as the production module's
 * lazy boundary: a static import would merge the icon-JSON graph into this
 * file's runner snapshot on top of index.ts's (the module header carries
 * the measurement).
 */
type FileiconModule = typeof import("../fileicon/fileicon");
let fileicon: FileiconModule | null = null;

async function fileiconMod(): Promise<FileiconModule> {
  if (fileicon === null) fileicon = await import("../fileicon/fileicon");
  return fileicon;
}

async function probeIcon(
  baseName: string,
  entryMode: EntryMode,
  symlinkToMode: EntryMode | null = null,
  isOpen = false,
): Promise<string> {
  const mod = await fileiconMod();
  return mod.renderEntryIconHtml(mod.newRenderedIconPool(), mod.entryInfo(baseName, entryMode, symlinkToMode, isOpen));
}

describe("GET /{owner}/{repo}/tree-view/{branch|tag|commit}/* (TreeViewNodes)", () => {
  it("serves the root listing: order, modes, escapes, pool membership and sort", async () => {
    const res = await fetchUi("/alice/wave43tv/tree-view/branch/main");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    const raw = await res.text();

    // Go map marshal order + the HTML escapes (the wire's distinctive bytes).
    expect(raw.startsWith('{"fileTreeNodes":')).toBe(true);
    expect(raw.includes('"renderedIconPool":{')).toBe(true);
    expect(raw.includes("\\u003csvg ")).toBe(true); // every icon markup crosses escaped
    expect(raw.includes("a\\u0026b.md")).toBe(true); // entryName escaping
    expect(raw.includes("symLinkedToMode")).toBe(false); // never set at the pin (tree.go:106)
    expect(raw.includes('"children"')).toBe(false); // no sub_path → no expansion
    expect((raw.match(/"entryIconOpen":/g) ?? []).length).toBe(3); // docs, libs, vendor

    const parsed = JSON.parse(raw) as ParsedEnvelope;
    // sortTreeViewNodes: directories + submodules first, then the natural sort.
    expect(parsed.fileTreeNodes.map((n) => n.entryName)).toEqual([
      "docs",
      "libs",
      "vendor",
      ".gitmodules",
      "README.md",
      "a&b.md",
      "app.ts",
      "link-dir",
      "link-escape",
      "link-file",
      "run.sh",
    ]);
    const byName = new Map(parsed.fileTreeNodes.map((n) => [n.entryName, n]));
    expect(byName.get("run.sh")?.entryMode).toBe("exec");
    expect(byName.get("link-dir")?.entryMode).toBe("symlink");
    expect(byName.get("vendor")?.entryMode).toBe("tree");
    // fullPaths are the path.Join'd repo-root paths.
    expect(byName.get("a&b.md")?.fullPath).toBe("a&b.md");
    expect(byName.get("link-escape")?.fullPath).toBe("link-escape");
    // Icon markup = the fileicon layer's render for the same EntryInfo
    // (dir nodes render twice: closed + open — the fileicon header's rule).
    expect(byName.get("docs")?.entryIcon).toBe(await probeIcon("docs", "tree"));
    expect(byName.get("docs")?.entryIconOpen).toBe(await probeIcon("docs", "tree", null, true));
    expect(byName.get("README.md")?.entryIconOpen).toBeUndefined(); // files get no open variant
    expect(byName.get("link-dir")?.entryIcon).toBe(await probeIcon("link-dir", "symlink", "tree"));

    // The pool: exactly the material icons of the five plain files, keyed
    // svg-mfi-<name>, emitted SORTED (Go marshals maps sorted).
    const mod = await fileiconMod();
    const probePool = mod.newRenderedIconPool();
    for (const name of ["README.md", "a&b.md", "app.ts", "run.sh", ".gitmodules"]) {
      mod.renderEntryIconHtml(probePool, mod.entryInfo(name, "blob", null, false));
    }
    expect(Object.keys(parsed.renderedIconPool).sort()).toEqual([...probePool.iconSvgs.keys()].sort());
    for (const [id, svg] of probePool.iconSvgs) {
      expect(parsed.renderedIconPool[id]).toBe(svg);
      // Pool members are the FULL svg records (first-write-wins, material.go:
      // 76-78); the <use href> references ride the NODE icons, not the pool.
      expect(parsed.renderedIconPool[id]).toContain(`id="${id}"`);
    }
    const poolPart = raw.slice(raw.indexOf('"renderedIconPool":'));
    const emittedIds = [...poolPart.matchAll(/"(svg-mfi-[a-z0-9-]+)":/g)].map((m) => m[1] as string);
    expect(emittedIds).toEqual([...emittedIds].sort());
  });

  it("answers a directory-only level with an empty pool and the exact envelope bytes", async () => {
    const res = await fetchUi("/alice/wave43tv/tree-view/branch/main/libs");
    expect(res.status).toBe(200);
    const closed = await probeIcon("inner", "tree");
    const open = await probeIcon("inner", "tree", null, true);
    const expected =
      `{"fileTreeNodes":[{"entryName":"inner","entryMode":"tree","entryIcon":${goJsonString(closed)},` +
      `"entryIconOpen":${goJsonString(open)},"fullPath":"libs/inner"}],"renderedIconPool":{}}`;
    expect(await res.text()).toBe(expected);
  });

  it("expands exactly the sub_path chain (and keeps the leading-slash quirk)", async () => {
    const one = await fetchUi("/alice/wave43tv/tree-view/branch/main?sub_path=docs");
    expect(one.status).toBe(200);
    const oneParsed = await one.json<ParsedEnvelope>();
    const docs = oneParsed.fileTreeNodes.find((n) => n.entryName === "docs");
    expect(docs?.children?.map((c) => c.entryName)).toEqual(["deep", "notes.md"]); // dir first, one level only
    expect(docs?.children?.[0]?.children).toBeUndefined(); // the chain stops at the consumed component

    const two = await fetchUi("/alice/wave43tv/tree-view/branch/main?sub_path=docs/deep");
    const twoParsed = await two.json<ParsedEnvelope>();
    const docs2 = twoParsed.fileTreeNodes.find((n) => n.entryName === "docs");
    expect(docs2?.children?.[0]?.entryName).toBe("deep");
    expect(docs2?.children?.[0]?.children?.map((c) => c.entryName)).toEqual(["guide.md"]);
    expect(docs2?.children?.[1]?.children).toBeUndefined(); // notes.md is off the chain

    // The leading-slash quirk (tree.go:163's Cut → an empty first component).
    const slashed = await fetchUi("/alice/wave43tv/tree-view/branch/main?sub_path=%2Fdocs");
    expect((await slashed.text()).includes('"children"')).toBe(false);
  });

  it("resolves the symlink arms: dir targets, file targets, escapes", async () => {
    const res = await fetchUi("/alice/wave43tv/tree-view/branch/main");
    const parsed = JSON.parse(await res.text()) as ParsedEnvelope;
    const byName = new Map(parsed.fileTreeNodes.map((n) => [n.entryName, n]));
    // link-dir → the material-folder-symlink octicon arm (unpooled, no open variant).
    expect(byName.get("link-dir")?.entryIcon).toBe(await probeIcon("link-dir", "symlink", "tree"));
    expect(byName.get("link-dir")?.entryIcon).toContain("octicon-file-directory-symlink");
    expect(byName.get("link-dir")?.entryIconOpen).toBeUndefined();
    // link-file → the plain symlink-file octicon (single hop; a blob target is not a dir).
    expect(byName.get("link-file")?.entryIcon).toBe(await probeIcon("link-file", "symlink"));
    expect(byName.get("link-file")?.entryIcon).toContain("octicon-file-symlink-file");
    // link-escape → the ../ target escapes the root → unresolved (upstream's ErrNotExist arm).
    expect(byName.get("link-escape")?.entryIcon).toBe(await probeIcon("link-escape", "symlink"));
  });

  it("resolves the submodule arms from .gitmodules", async () => {
    const res = await fetchUi("/alice/wave43tv/tree-view/branch/main/vendor");
    expect(res.status).toBe(200);
    const parsed = JSON.parse(await res.text()) as ParsedEnvelope;
    expect(parsed.fileTreeNodes.map((n) => n.entryName)).toEqual(["lib", "remote", "scp"]); // commits sort at level 0
    const byName = new Map(parsed.fileTreeNodes.map((n) => [n.entryName, n]));
    expect(byName.get("lib")?.entryMode).toBe("commit");
    expect(byName.get("lib")?.submoduleUrl).toBe(`/alice/vendor-lib.git/tree/${LIB_OID}`); // path.Join(repoLink, "../…")
    expect(byName.get("remote")?.submoduleUrl).toBe(`https://github.com/example/remote-sub/tree/${REMOTE_OID}`);
    expect(byName.get("scp")?.submoduleUrl).toBe(`https://github.com/example/scp-sub/tree/${SCP_OID}`);
    // The submodule icon: the material folder-git, pooled under its svg id.
    expect(byName.get("lib")?.entryIcon).toBe(await probeIcon("lib", "commit"));
    expect(byName.get("lib")?.entryIcon).toContain("svg-mfi-folder-git");
    expect(Object.keys(parsed.renderedIconPool)).toEqual(["svg-mfi-folder-git"]);
  });

  it("roots the listing at the treePath half and swaps HEAD on the branch route", async () => {
    const docs = await fetchUi("/alice/wave43tv/tree-view/branch/main/docs");
    expect(docs.status).toBe(200);
    const docsParsed = JSON.parse(await docs.text()) as ParsedEnvelope;
    expect(docsParsed.fileTreeNodes.map((n) => n.entryName)).toEqual(["deep", "notes.md"]);
    expect(docsParsed.fileTreeNodes[0]?.fullPath).toBe("docs/deep"); // full paths keep the treePath prefix
    expect(docsParsed.fileTreeNodes[0]?.children).toBeUndefined();

    const head = await fetchUi("/alice/wave43tv/tree-view/branch/HEAD");
    expect(head.status).toBe(200); // HEAD → the default branch (repo.go:875-881)
    const tag = await fetchUi("/alice/wave43tv/tree-view/tag/v43");
    expect(tag.status).toBe(200);
    const commit = await fetchUi(`/alice/wave43tv/tree-view/commit/${await tip()}`);
    expect(commit.status).toBe(200);
    const commitParsed = JSON.parse(await commit.text()) as ParsedEnvelope;
    expect(commitParsed.fileTreeNodes.length).toBe(11); // the same root universe
  });

  it("404s the whole family of unresolvable arms", async () => {
    const c0 = await tip();
    for (const path of [
      "/alice/wave43empty/tree-view/branch/main", // the nil-Commit arm
      "/alice/wave43tv/tree-view/branch/v43", // tag under the branch route (wrong universe)
      "/alice/wave43tv/tree-view/tag/main", // branch under the tag route
      `/alice/wave43tv/tree-view/commit/${c0.slice(0, 7)}`, // short oid — the full-oid divergence
      `/alice/wave43tv/tree-view/commit/${"f".repeat(40)}`, // unknown oid
      "/alice/wave43tv/tree-view/branch/main/nonexistent", // missing treePath (upstream's ServerError → the 404 class)
      "/nobody/nothing/tree-view/branch/main", // unknown repo
    ]) {
      const res = await fetchUi(path);
      expect(res.status, path).toBe(404);
      const html = await res.text();
      expect(html, path).toContain('<div class="status-page-error">');
    }
    // The visibility gate: a private repo 404-shells like the siblings.
    const db = drizzle(env.DB);
    const row = (
      await db
        .select()
        .from(repositories)
        .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave43tv")))
        .get()
    )!;
    await db.update(repositories).set({ visibility: "private" }).where(eq(repositories.id, row.id));
    expect((await fetchUi("/alice/wave43tv/tree-view/branch/main")).status).toBe(404);
    await db.update(repositories).set({ visibility: "public" }).where(eq(repositories.id, row.id));
  });
});
