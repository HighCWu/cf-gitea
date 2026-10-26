/**
 * The file-tree JSON envelope — the parity survey's PARTIAL row 5's gated
 * half (wave 39 shipped the sibling tree-list feed and documented this as a
 * skip until the fileicon theme machinery landed; cdf683a unlocked it), the
 * feed the official bundle's code-tree Vue store fetches, upstream
 *
 *   GET /{owner}/{repo}/tree-view/{branch|tag|commit}/*?sub_path=…
 *                                   web.go:1302-1306
 *                                   repo.TreeViewNodes (routers/web/repo/
 *                                   treelist.go:147-155)
 *
 * — consumed by web_src/js/components/ViewFileTreeStore.ts:24-38
 * (`loadChildren`): it walks `json.renderedIconPool` into a
 * `.global-svg-icon-pool` container and mounts `json.fileTreeNodes` into the
 * reactive tree, so the envelope's strings must round-trip the icon MARKUP
 * through JSON exactly the way the official bundle's bytes do.
 *
 * ## The TreeViewNode field set (services/repository/files/tree.go:100-111)
 *
 * The Go struct marshals in field order; `omitempty` members vanish when
 * zero — the byte contract this module's assembler reproduces:
 *
 *     entryName       tree.go:101  always; the entry's base name
 *     entryMode       tree.go:102  always; entryModeString(tree.go:84-98):
 *                     "blob"|"exec"|"symlink"|"commit"|"tree"|"unknown"
 *     entryIcon       tree.go:103  always (template.HTML has no omitempty);
 *                     the fileicon layer's rendered markup
 *     entryIconOpen   tree.go:104  omitempty — set only when the entry's RAW
 *                     mode is a directory (tree.go:126-129 renders the
 *                     closed icon, then re-renders with IsOpen=true; a
 *                     symlink-to-directory gets NO open variant)
 *     symLinkedToMode tree.go:106  omitempty — NEVER assigned at the pin
 *                     (the struct's own TODO: "for the EntryMode=symlink");
 *                     newTreeViewNodeFromEntry resolves the symlink only
 *                     into the ICON's EntryInfo (tree.go:124), never into
 *                     this field, so the assembler always omits it. Carried
 *                     in the TS shape so the field set stays explicit.
 *     fullPath        tree.go:108  always; path.Join(parentDir, entry.Name())
 *     submoduleUrl    tree.go:109  omitempty — only for "commit" entries
 *                     with a resolvable .gitmodules URL (tree.go:131-141)
 *     children        tree.go:110  omitempty — nil unless the listing
 *                     descended into this directory along the sub_path chain
 *                     (tree.go:168-179; a descent that FAILS logs and leaves
 *                     the field off, tree.go:174-178)
 *
 * Per-node assembly is newTreeViewNodeFromEntry (tree.go:117-144): the icon
 * EntryInfo rides EntryInfoFromGitTreeEntry (modules/fileicon/entry.go:19-27
 * — the single-hop EntryFollowLink, whose SymlinkToMode is set only when the
 * target resolves to a DIRECTORY) through RenderEntryIconHTML (render.go:
 * 36-47 — the landed port's fixed theme defaults: material for files, basic
 * octicons for directories and symlinks-to-directories), so directories
 * render TWICE per node (closed + open) exactly as the fileicon module
 * header prescribes, and every material icon lands in the pool
 * first-write-wins under its `svg-mfi-<name>` id (material.go:64-80) while
 * the basic octicons stay inline (they never enter the pool).
 *
 * ## The envelope shape + the escaping decision (the wave's brief)
 *
 * The handler responds `ctx.JSON(200, map[string]any{"fileTreeNodes":
 * results, "renderedIconPool": renderedIconPool.IconSVGs})`
 * (treelist.go:154) through `json.MarshalWrite` (services/context/base.go:
 * 115-122) — Go's encoding/json with the DEFAULT EscapeHTML=true. The
 * byte-shape decisions that fall out, implemented here:
 *
 * 1. KEY ORDER: Go marshals maps with SORTED keys, so the envelope reads
 *    `{"fileTreeNodes":[…],"renderedIconPool":{…}}` ('f' < 'r') and the
 *    pool's `svg-mfi-*` ids are emitted in sorted order too (upstream's
 *    RenderToHTML iterates the same map in randomized order — the consumer
 *    joins `Object.entries` and innerHTMLs it, so only the MEMBER SET is
 *    observable there; the sorted bytes are still what the official bundle
 *    puts on the wire).
 * 2. STRING ESCAPING: every JSON string escapes `<` → `\u003c`, `>` →
 *    `\u003e`, `&` → `\u0026` (the escapeHTML set), plus `\u2028`/`\u2029`
 *    for the line separators and `\ufffd` per invalid UTF-8 rune. This is
 *    the fileicon module header's CONSUMER NOTE — the choice "belongs to
 *    the envelope assembly", i.e. HERE: the icon markup `<svg id="svg-mfi-…`
 *    travels as `\u003csvg id=\"svg-mfi-…` — `"` takes the ordinary `\"`
 *    escape, only `<>&` get the `\u00XX` treatment. JS JSON.parse
 *    transparently reverses every form, so the Vue consumer sees the same
 *    strings the official bundle feeds it.
 * 3. EMPTY CONTAINERS: Go's `results` and `IconSVGs` are non-nil
 *    (tree.go:164's `make`, render.go:20's `make`), so an empty listing
 *    emits `"fileTreeNodes":[]` and an icons-free level (directories only)
 *    emits `"renderedIconPool":{}` — never `null`, never an omitted key.
 *
 * JSON.stringify alone cannot produce these bytes (it leaves `<>&` raw), so
 * the assembler serializes by hand with a faithful port of Go's encoder:
 * struct-field order per node, sorted map keys, the escape table above.
 *
 * ## Ref + tree-path resolution (the forced-type middleware)
 *
 * `RepoRefByType(RefTypeBranch|Tag|Commit)` resolves the FIRST ref-universe
 * prefix of the tail IN THAT TYPE ONLY (services/context/repo.go:905-985) —
 * the landed `resolveRefSuffix` machinery fed the typed universe, and the
 * walk's remainder is the treePath (unlike tree-list, which ignores it, the
 * tree-view listing IS rooted at it: GetTreeViewNodes resolves treePath to a
 * tree, tree.go:185-191, `""` = the root tree, tree_blob.go:28-35). The 404
 * family answers the §4.5 shell exactly like the sibling aux feeds: the
 * empty repo (upstream's nil-Commit arm), an unresolvable ref (wrong
 * universe / unknown / short oid — the full-oid divergence), a treePath
 * that resolves to nothing (upstream's ServerError 500 → the 404-class
 * divergence, the commit-contained-refs note), or a failed tree read.
 *
 * `sub_path` (the `?sub_path=` query, FormString at treelist.go:149) names
 * the expansion chain: `strings.Cut` splits off the FIRST component and the
 * listing descends ONLY into the directory bearing that name, recursively
 * with the remainder (tree.go:163-179) — one expanded chain per request,
 * which is how the bundle's tree opens the selected path's ancestors. A
 * leading-slash sub_path cuts to an empty first component and expands
 * nothing (the upstream quirk, kept verbatim).
 *
 * ## The submodule arm (tree.go:131-141)
 *
 * For "commit" entries the loader reads `.gitmodules` at the resolved ref
 * ONCE per request (GetSubModules' commit-level cache, commit_submodule.go:
 * 24-46), parses it with the exact configParseSubModules line scanner
 * (config_submodule.go:21-72 — comments/blank lines skipped, `[submodule …]`
 * sections only, path/url/branch keys), then renders the web link through
 * the CommitSubmoduleFile arms (commit_submodule_file.go:28-72): an empty
 * URL → no field; a `../`-relative URL → path.Join(repoLink, url) +
 * `/tree/<gitlink-oid>` (the sibling-in-the-parent-namespace semantics);
 * anything else → ParseRepositoryURL + MakeRepositoryWebLink (modules/git/
 * url/url.go:93-186). The url.go machinery leans on instance settings
 * (IsCurrentGiteaSiteURL, SSH.Domain, AppSubURL) this Worker has no surface
 * for — the fileicon theme-defaults posture applies: the port implements
 * the GUESS arms only (http(s) → the URL minus a `.git` suffix — Go's
 * net/url.String() normalization is a no-op for well-formed module URLs;
 * scp-short + ssh:// → `https://<host-without-port>/<path minus .git>`);
 * self-site URLs therefore render absolute instead of AppSubURL-relative
 * (presentational divergence, same repo in the browser), and a file-path
 * "URL" yields the empty target exactly like MakeRepositoryWebLink's
 * fallthrough — upstream then emits `"/tree/<oid>"`, kept verbatim; a
 * malformed remote (unparseable, colon-terminated scp form) yields no field
 * like the helper's nil arm.
 *
 * ## Cost posture (honest)
 *
 * One `listTree` RPC per LISTED level (the root + each sub_path chain
 * segment — upstream pays one `ls-tree` per the same set), plus one
 * `readBlob` per symlink entry (+ one `listTree` when its content resolves)
 * and one `.gitmodules` read when the listing carries a submodule. Symlink
 * targets are cleaned with Go's path.Clean before lookup, and a target that
 * escapes the root (`..` past the top) is unresolved without an engine call
 * — upstream's ErrNotExist arm. Engine-boundary quirk, documented not
 * worked around: the engine's path decode re-applies decodeURIComponent and
 * drops `.`/`..` segments (packages/git-engine/src/repo.ts:2490), so entry
 * names carrying percent-escapes can mismatch inside path lookups — the
 * same boundary every landed tree consumer rides.
 *
 * Not a page — the tree-list-aux sibling: loader + Response builder here,
 * the handler in src/ui/index.ts beside its sibling dispatchers.
 *
 * ## The lazy fileicon boundary (the ws1009 lesson, extended)
 *
 * The fileicon module rides this module's import edge DYNAMICALLY
 * (`loadFileicon()`), not statically. Reason, measured 2026-10-26: a static
 * edge makes index.ts's import graph carry the fileicon assets (the two
 * `?raw` JSONs, 461 KB + 999 KB, ~12 MB transformed with sourcemaps and the
 * runner snapshot's url/id aliasing) — and every ui test file's
 * `fetchWarmModules` snapshot then crosses the runner WebSocket's 32 MiB
 * cap, killing one workerd runner per run with the documented
 * "Worker exited unexpectedly during started state" signature
 * (docs/research/workers-vitest-ws1009-issue.md; the fileicon header's
 * "?raw graphs stayed clean" measurement assumed a fileicon graph that
 * index.ts never shared). The dynamic edge keeps the JSONs out of the
 * static snapshot: the first tree-view request fetches them as per-module
 * responses, each far under the ~4 MB single-module cap. Production cost:
 * the worker bundle splits the fileicon chunk and loads it on first
 * envelope request (workerd supports secondary chunks; the endpoint is not
 * hot). Type imports stay static — they are erased at compile time.
 */

import { engineReads, type EngineReads } from "../../api/services/engine";
import type { EntryMode, RenderedIconPool } from "../fileicon/fileicon";
import { resolveRefSuffix, type RefType } from "../index";
import { naturalSortCompare } from "./tree-list-aux";

/** The fileicon module's shape, as this module consumes it (the static
 *  type-only view of the dynamically imported edge). */
export type FileiconModule = typeof import("../fileicon/fileicon");

let fileiconPromise: Promise<FileiconModule> | null = null;

/** The lazily-once fileicon edge (the sync.Once pattern again; a failed
 *  bundle would have failed at build time, so the promise cannot reject in
 *  a correct build). */
function loadFileicon(): Promise<FileiconModule> {
  if (fileiconPromise === null) fileiconPromise = import("../fileicon/fileicon");
  return fileiconPromise;
}

/** The loader's repo subset (the caller's resolved row). */
export type TreeViewRepo = {
  ownerNamespace: string;
  slug: string;
  isEmpty: boolean;
  defaultBranch: string;
};

/** tree.go:100-111's TreeViewNode — the TS mirror; optionals are the
 *  `omitempty` members (the module doc carries the per-field cites). */
export interface TreeViewNodeJson {
  entryName: string;
  entryMode: string;
  entryIcon: string;
  /** tree.go:104 — directories only (the RAW mode's IsDir arm). */
  entryIconOpen?: string;
  /** tree.go:106 — never assigned at the pin (the struct's TODO); the
   *  assembler's omitempty therefore always omits it. */
  symLinkedToMode?: string;
  fullPath: string;
  /** tree.go:109 — resolvable submodule web links only. */
  submoduleUrl?: string;
  /** tree.go:110 — the sub_path chain's expanded levels only. */
  children?: TreeViewNodeJson[];
}

/** treelist.go:154's response map — the pool stays a Map (insertion order,
 *  the fileicon layer's first-write-wins) until the assembler emits it
 *  sorted. */
export interface TreeViewEnvelope {
  fileTreeNodes: TreeViewNodeJson[];
  renderedIconPool: ReadonlyMap<string, string>;
}

// --- Go path semantics (path.Clean / path.Join / path.Dir) --------------------

/** path.Clean (go/src/path/path.go Clean) — the lexical clean the engine
 *  boundary does NOT provide; symlink targets and relative submodule URLs
 *  need it. Rooted paths carry their leading slash in the buffer from the
 *  start (Go's lazybuf w=1), which is what the `dotdot` floor guards. */
export function goPathClean(path: string): string {
  if (path === "") return ".";
  const rooted = path.startsWith("/");
  const n = path.length;
  let out = rooted ? "/" : "";
  let r = rooted ? 1 : 0;
  let dotdot = rooted ? 1 : 0;
  while (r < n) {
    const c = path[r] as string;
    if (c === "/") {
      r += 1;
    } else if (c === "." && (r + 1 === n || path[r + 1] === "/")) {
      r += 1;
    } else if (c === "." && path[r + 1] === "." && (r + 2 === n || path[r + 2] === "/")) {
      r += 2;
      if (out.length > dotdot) {
        // Go's w ends AT the separator (excluded from the buffer) or at the
        // dotdot floor — drop the trailing slash the walk stopped on.
        out = out.slice(0, out.length - 1);
        while (out.length > dotdot && out[out.length - 1] !== "/") out = out.slice(0, out.length - 1);
        if (out.length > dotdot && out[out.length - 1] === "/") out = out.slice(0, out.length - 1);
      } else if (!rooted) {
        if (out.length > 0) out += "/";
        out += "..";
        dotdot = out.length;
      }
    } else {
      if ((rooted && out.length !== 1) || (!rooted && out.length !== 0)) out += "/";
      while (r < n && path[r] !== "/") {
        out += path[r] as string;
        r += 1;
      }
    }
  }
  if (out === "") return ".";
  return out;
}

/** path.Join over two elements (Join = Clean of the slash-joined parts). */
export function goPathJoin(a: string, b: string): string {
  if (a === "") return goPathClean(b);
  if (b === "") return goPathClean(a);
  return goPathClean(`${a}/${b}`);
}

/** path.Dir — everything before the final slash, then Clean ("." when no
 *  slash). */
export function goPathDir(path: string): string {
  const i = path.lastIndexOf("/");
  return goPathClean(i === -1 ? "." : path.slice(0, i + 1));
}

/** strings.Cut on the first separator (tree.go:163). */
function cutFirst(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  if (i === -1) return [s, ""];
  return [s.slice(0, i), s.slice(i + sep.length)];
}

// --- entry modes (tree_entry_mode.go + tree.go:84-98) --------------------------

/** ParseEntryMode (modules/git/tree_entry_mode.go:57-92) over the engine's
 *  raw mode strings — the exact-match table first, then the mask fallback
 *  for non-standard implementations ("040755" and friends). NoEntry
 *  ("000000") and unparseable shapes land on "unknown", which is
 *  entryModeString's fallthrough for them (tree.go:97). */
export function parseEntryMode(mode: string): EntryMode {
  switch (mode) {
    case "100644":
      return "blob";
    case "100755":
      return "exec";
    case "120000":
      return "symlink";
    case "160000":
      return "commit";
    case "040000":
    case "40000": // leading zero is optional
      return "tree";
    default: {
      const m = Number.parseInt(mode, 8);
      if (Number.isNaN(m)) return "unknown";
      switch (m & 0o770000) {
        case 0o040000:
          return "tree";
        case 0o160000:
          return "commit";
        case 0o120000:
          return "symlink";
        case 0o100000:
          return (m & 0o777) === 0o755 ? "exec" : "blob";
        default:
          return "unknown";
      }
    }
  }
}

/** entryModeString (services/repository/files/tree.go:84-98) — the JSON
 *  spelling; the parsed EntryMode values are already exactly these strings,
 *  so the mapping is the identity over the parsed domain. */
function entryModeString(entryMode: EntryMode): EntryMode {
  return entryMode;
}

// --- the submodule arm (config_submodule.go + commit_submodule_file.go) --------

/** One parsed `[submodule]` section (SubModule's path/url fields; branch is
 *  parsed upstream but never used by the envelope). */
interface GitmodulesEntry {
  path: string;
  url: string;
}

/** configParseSubModules (config_submodule.go:21-72) — the exact line
 *  scanner: blank/#/; lines skipped, `[submodule…]` opens a section (any
 *  other `[section]` closes it), key=value with the FIRST '=' splitting. */
export function parseGitmodules(text: string): Map<string, GitmodulesEntry> {
  const subModules = new Map<string, GitmodulesEntry>();
  let subModule: GitmodulesEntry | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      if (subModule !== null) subModules.set(subModule.path, subModule);
      subModule = line.startsWith("[submodule") ? { path: "", url: "" } : null;
      continue;
    }
    if (subModule === null) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "path") subModule.path = value;
    else if (key === "url") subModule.url = value;
    // "branch": parsed upstream, unused by the envelope
  }
  if (subModule !== null) subModules.set(subModule.path, subModule);
  return subModules;
}

/** net.SplitHostPort's host half for the ssh guess arm ("" when there is no
 *  port — the caller's IfZero fallback then uses the host as is, brackets
 *  included, exactly like Go's failed SplitHostPort). */
function hostWithoutPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return "";
    if (!host.slice(end).includes(":")) return host; // "[::1]" — no port to strip
    return host.slice(1, end);
  }
  const colon = host.lastIndexOf(":");
  if (colon === -1) return "";
  if (host.slice(colon + 1).includes(":")) return ""; // a bare IPv6 literal — no port
  return host.slice(0, colon);
}

/** ParseGitURL + MakeRepositoryWebLink's guess arms (modules/git/url/
 *  url.go:40-89 + 163-186) — the settings-dependent "belongs to this
 *  instance" arm has no surface here (the module doc's divergence note).
 *  Returns null where upstream's parse ERRORS (no link at all), "" where
 *  MakeRepositoryWebLink's switch falls through (the empty target upstream
 *  still wraps into a "/tree/<oid>" link), the link otherwise. */
export function parseRepositoryWebLink(remote: string): string | null {
  if (remote.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(remote);
    } catch {
      return null; // stdurl.Parse's error arm
    }
    switch (parsed.protocol) {
      case "http:":
      case "https:":
        return remote.endsWith(".git") ? remote.slice(0, -".git".length) : remote;
      case "ssh:":
      case "git+ssh:": {
        const host = hostWithoutPort(parsed.host) || parsed.host;
        let urlPath = parsed.pathname;
        if (urlPath.startsWith("/")) urlPath = urlPath.slice(1);
        if (urlPath.endsWith(".git")) urlPath = urlPath.slice(0, -".git".length);
        return `https://${host}/${urlPath}`.replace(/\/$/, ""); // TrimSuffix(urlFull, "/")
      }
      default:
        return ""; // the file-path arm → scheme "file" → the fallthrough
    }
  }
  // ParseGitURL's scp-short syntax arm (url.go:57-89): user@host[:port]:path
  // with IPv6 bracket awareness — scheme "ssh" for the guess arm.
  if (remote.includes("@") && remote.includes(":")) {
    let squareBrackets = false;
    let lastIndex = -1;
    let hostStart = -1;
    let hostEnd = -1;
    for (let i = 0; i < remote.length; i++) {
      const c = remote[i];
      if (c === "@") {
        lastIndex = i + 1;
      } else if (c === "[") {
        squareBrackets = true;
      } else if (c === "]") {
        squareBrackets = false;
      } else if (c === ":" && !squareBrackets) {
        hostStart = lastIndex;
        hostEnd = i;
        break;
      }
    }
    if (hostStart === -1 || hostEnd >= remote.length - 1) return null; // url.go:68-70's ErrWrongURLFormat
    const host = (remote.slice(hostStart, hostEnd) ?? "").replaceAll("%25", "%");
    let urlPath = remote.slice(hostEnd + 1);
    if (urlPath.startsWith("/")) urlPath = urlPath.slice(1);
    if (urlPath.endsWith(".git")) urlPath = urlPath.slice(0, -".git".length);
    return `https://${host}/${urlPath}`.replace(/\/$/, ""); // TrimSuffix(urlFull, "/")
  }
  return ""; // ParseGitURL's file-path arm → scheme "file" → the fallthrough
}

/** CommitSubmoduleFile.SubmoduleWebLinkTree (commit_submodule_file.go:52-57
 *  + 36-54) — the CommitWebLink for one .gitmodules URL, null when the
 *  upstream helper returns nil (empty URL, parse error arm). */
export function submoduleCommitWebLink(repoLink: string, refUrl: string, refId: string): string | null {
  if (refUrl === "") return null;
  if (refUrl.startsWith("../")) {
    const targetLink = goPathJoin(repoLink, refUrl);
    return `${targetLink}/tree/${refId}`;
  }
  const targetLink = parseRepositoryWebLink(refUrl);
  if (targetLink === null) return null;
  return `${targetLink}/tree/${refId}`;
}

// --- the walk (tree.go:157-191) -------------------------------------------------

const DECODER = new TextDecoder("utf-8");

/** tree.go:113-115's sortLevel — directories and submodules first. */
function sortLevelOf(node: TreeViewNodeJson): number {
  return node.entryMode === "tree" || node.entryMode === "commit" ? 0 : 1;
}

/** EntryFollowLink's single hop, answered to the icon layer's precision
 *  (entry.go:19-27): null unless the target resolves to a DIRECTORY. The
 *  20×4096 content cap and the absolute-link arm both land in the unset
 *  case like upstream's error return (tree_entry.go:88-99). */
async function symlinkToDir(reads: EngineReads, ref: string, fullPath: string): Promise<EntryMode | null> {
  const blob = await reads.readBlob(ref, fullPath);
  if (blob === null) return null;
  if (blob.data.byteLength > 20 * 4096) return null; // maxSymlinkSize (tree_entry.go:89-91)
  const link = DECODER.decode(blob.data);
  if (link.startsWith("/")) return null; // absolute symlinks stay unresolved (tree_entry.go:96-98)
  const target = goPathJoin(goPathDir(fullPath), link);
  if (target === ".." || target.startsWith("../")) return null; // out of root: upstream's ErrNotExist
  const tree = await reads.listTree(ref, target);
  return tree !== null ? "tree" : null;
}

/** GetSubModules' lazy commit-level cache (commit_submodule.go:24-46) — the
 *  `.gitmodules` read happens once per request, only when a submodule asks;
 *  a missing or unreadable file is the empty table (the nil-modules arm —
 *  GetSubModule then finds nothing). */
function gitmodulesLoader(reads: EngineReads, ref: string): () => Promise<Map<string, GitmodulesEntry>> {
  let cache: Promise<Map<string, GitmodulesEntry>> | null = null;
  return () => {
    if (cache === null) {
      cache = (async () => {
        const blob = await reads.readBlob(ref, ".gitmodules");
        return blob === null ? new Map<string, GitmodulesEntry>() : parseGitmodules(DECODER.decode(blob.data));
      })();
    }
    return cache;
  };
}

/** One listed level (tree.go:157-183). `null` = the 404 family (the path
 *  resolves to nothing or the read failed). */
async function listTreeNodes(
  reads: EngineReads,
  fileicon: FileiconModule,
  ref: string,
  repoLink: string,
  pool: RenderedIconPool,
  treePath: string,
  subPath: string,
  loadGitmodules: () => Promise<Map<string, GitmodulesEntry>>,
): Promise<TreeViewNodeJson[] | null> {
  const tree = await reads.listTree(ref, treePath);
  if (tree === null) return null; // GetTreeEntryByPath/ListEntries err → the 404 class

  const { entryInfo, renderEntryIconHtml } = fileicon;
  const [subPathDirName, subPathRemaining] = cutFirst(subPath, "/");
  const nodes: TreeViewNodeJson[] = [];
  for (const entry of tree.entries) {
    const entryMode = entryModeString(parseEntryMode(entry.mode));
    const fullPath = goPathJoin(treePath, entry.name);

    // newTreeViewNodeFromEntry's icon arm (tree.go:124-129): the resolved
    // EntryInfo renders the closed icon; a raw-mode directory re-renders
    // with IsOpen=true (symlinks-to-directories get no open variant).
    let symlinkToMode: EntryMode | null = null;
    if (entryMode === "symlink") symlinkToMode = await symlinkToDir(reads, ref, fullPath);
    const entryIcon = renderEntryIconHtml(pool, entryInfo(entry.name, entryMode, symlinkToMode, false));

    const node: TreeViewNodeJson = { entryName: entry.name, entryMode, entryIcon, fullPath };
    if (entryMode === "tree") {
      node.entryIconOpen = renderEntryIconHtml(pool, entryInfo(entry.name, entryMode, symlinkToMode, true));
    }

    // The submodule URL arm (tree.go:131-141) — refID is the tree entry's
    // gitlink oid (NewCommitSubmoduleFile's refID, SubmoduleWebLinkTree's
    // default commit id).
    if (entryMode === "commit") {
      const mod = (await loadGitmodules()).get(fullPath);
      const url = mod === undefined ? null : submoduleCommitWebLink(repoLink, mod.url, entry.oid);
      if (url !== null) node.submoduleUrl = url;
    }

    // The sub_path descent (tree.go:168-179) — the leading-slash trim is
    // upstream's raw concat, NOT a path.Join; a failed descent logs and
    // leaves `children` off.
    if (entry.type === "tree" && subPathDirName === entry.name) {
      const subTreePath = `${treePath}/${node.entryName}`;
      const cleaned = subTreePath.startsWith("/") ? subTreePath.slice(1) : subTreePath;
      const children = await listTreeNodes(
        reads,
        fileicon,
        ref,
        repoLink,
        pool,
        cleaned,
        subPathRemaining,
        loadGitmodules,
      );
      if (children !== null) node.children = children;
    }
    nodes.push(node);
  }

  // sortTreeViewNodes (tree.go:146-155): directories + submodules first,
  // then the natural sort of the sibling tree-list feed (the shared port).
  nodes.sort((a, b) => {
    const levelA = sortLevelOf(a);
    const levelB = sortLevelOf(b);
    if (levelA !== levelB) return levelA - levelB;
    return naturalSortCompare(a.entryName, b.entryName);
  });
  return nodes;
}

/**
 * Load the envelope for one typed ref + tree path + sub_path chain. `null` =
 * the 404 family (the module doc's ledger): the empty repo, an unresolvable
 * ref, a treePath that resolves to nothing, or a failed read anywhere in
 * the walk.
 */
export async function loadTreeViewNodes(
  env: Env,
  repo: TreeViewRepo,
  refType: RefType,
  refSuffix: string,
  subPath: string,
): Promise<TreeViewEnvelope | null> {
  if (repo.isEmpty) return null; // the nil-Commit arm (the tree-list sibling's posture)
  const reads = engineReads(env, repo);
  const refs = await reads.listRefs();
  if (refs === null) return null;
  const names = refs.refs.map((ref) => ref.name);
  const resolved = resolveRefSuffix(
    refType,
    refSuffix,
    {
      branches: names.filter((name) => name.startsWith("refs/heads/")).map((name) => name.slice("refs/heads/".length)),
      tags: names.filter((name) => name.startsWith("refs/tags/")).map((name) => name.slice("refs/tags/".length)),
      defaultBranch: repo.defaultBranch,
    },
  );
  if (resolved === null) return null; // "branch or tag not exist" (repo.go:976-979)

  // GetTreeViewNodes (tree.go:185-191): treePath "" IS the root tree
  // (tree_blob.go:28-35), so the root arm needs no extra entry read — the
  // walk's own listTree(ref, "") answers it; a non-empty treePath that
  // resolves to nothing fails inside the walk (the 404 class).
  const fileicon = await loadFileicon(); // the lazy edge (the module header)
  const pool = fileicon.newRenderedIconPool();
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`; // RepoLink (the contained-refs convention)
  const loadGitmodules = gitmodulesLoader(reads, resolved.ref);
  const nodes = await listTreeNodes(
    reads,
    fileicon,
    resolved.ref,
    repoLink,
    pool,
    resolved.treePath,
    subPath,
    loadGitmodules,
  );
  if (nodes === null) return null;
  return { fileTreeNodes: nodes, renderedIconPool: pool.iconSvgs };
}

// --- the wire bytes (base.go:115-122 + treelist.go:154) -------------------------

const HEX = "0123456789abcdef";

/** Go encoding/json's string encoder with EscapeHTML=true (the default
 *  MarshalWrite posture, base.go:118): `"`/`\` and the short control
 *  escapes, other bytes < 0x20 as `\u00xx`, `<>&` as `\u003c/\u003e/
 *  \u0026`, U+2028/U+2029 escaped, invalid UTF-8 (lone surrogates here) as
 *  `\ufffd`. */
export function goJsonString(s: string): string {
  let out = '"';
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      switch (c) {
        case 0x22:
          out += '\\"';
          break;
        case 0x5c:
          out += "\\\\";
          break;
        case 0x0a:
          out += "\\n";
          break;
        case 0x0d:
          out += "\\r";
          break;
        case 0x09:
          out += "\\t";
          break;
        case 0x3c:
          out += "\\u003c";
          break;
        case 0x3e:
          out += "\\u003e";
          break;
        case 0x26:
          out += "\\u0026";
          break;
        default:
          if (c < 0x20) {
            out += `\\u00${HEX[c >> 4] as string}${HEX[c & 0xf] as string}`;
          } else {
            out += s[i] as string;
          }
      }
      i += 1;
      continue;
    }
    if (c === 0x2028) {
      out += "\\u2028";
      i += 1;
      continue;
    }
    if (c === 0x2029) {
      out += "\\u2029";
      i += 1;
      continue;
    }
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s.slice(i, i + 2); // a well-formed pair — emitted raw
        i += 2;
      } else {
        out += "\\ufffd"; // RuneError, size 1
        i += 1;
      }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      out += "\\ufffd";
      i += 1;
      continue;
    }
    out += s[i] as string;
    i += 1;
  }
  return `${out}"`;
}

/** One TreeViewNode's bytes — the Go struct's marshal order with the
 *  omitempty arms (the module doc's field table). */
function marshalNode(node: TreeViewNodeJson): string {
  let out = "{";
  out += `"entryName":${goJsonString(node.entryName)}`;
  out += `,"entryMode":${goJsonString(node.entryMode)}`;
  out += `,"entryIcon":${goJsonString(node.entryIcon)}`;
  if (node.entryIconOpen !== undefined) out += `,"entryIconOpen":${goJsonString(node.entryIconOpen)}`;
  if (node.symLinkedToMode !== undefined) out += `,"symLinkedToMode":${goJsonString(node.symLinkedToMode)}`;
  out += `,"fullPath":${goJsonString(node.fullPath)}`;
  if (node.submoduleUrl !== undefined) out += `,"submoduleUrl":${goJsonString(node.submoduleUrl)}`;
  if (node.children !== undefined) out += `,"children":${marshalNodes(node.children)}`;
  return `${out}}`;
}

function marshalNodes(nodes: TreeViewNodeJson[]): string {
  return `[${nodes.map(marshalNode).join(",")}]`;
}

/**
 * treelist.go:154's bytes — `{"fileTreeNodes":[…],"renderedIconPool":{…}}`
 * with the pool's `svg-mfi-*` ids SORTED (Go marshals maps sorted; the
 * member set and insertion order stay the fileicon layer's). Empty
 * containers emit `[]` / `{}` — never null, never omitted (the module doc's
 * decision 3).
 */
export function marshalTreeViewEnvelope(envelope: TreeViewEnvelope): string {
  const pool = [...envelope.renderedIconPool.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const poolJson = pool.map(([id, svg]) => `${goJsonString(id)}:${goJsonString(svg)}`).join(",");
  return `{"fileTreeNodes":${marshalNodes(envelope.fileTreeNodes)},"renderedIconPool":{${poolJson}}}`;
}

/**
 * The aux JSON Response — ctx.JSON's `application/json;charset=utf-8`
 * (services/context/base.go:115-122) plus the web middleware's zero-option
 * prod Cache-Control (the tree-list sibling; the Vue store fetches fresh
 * per expansion).
 */
export function treeViewResponse(envelope: TreeViewEnvelope): Response {
  return new Response(marshalTreeViewEnvelope(envelope), {
    status: 200,
    headers: {
      "content-type": "application/json;charset=utf-8",
      "cache-control": "max-age=0, private, must-revalidate",
    },
  });
}
