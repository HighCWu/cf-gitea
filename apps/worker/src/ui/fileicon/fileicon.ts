/**
 * The file-icon theme machinery — the tree-view aux fragment's dependency
 * (the wave-39 documented skip: "the ViewFileTreeStore JSON carries the
 * fileicon theme pool"). Port of the pinned submodule's
 * gitea/modules/fileicon/ — entry.go, basic.go, material.go, render.go —
 * feeding the JSON envelope's `entryIcon` / `entryIconOpen` /
 * `renderedIconPool` fields (routers/web/repo/treelist.go:147-160
 * TreeViewNodes responds `{"fileTreeNodes": [...], "renderedIconPool":
 * pool.IconSVGs}`; services/repository/files/tree.go:113-116 newTreeViewNodeFromEntry
 * sets EntryIcon per node and EntryIconOpen for directories).
 *
 * ## Assets (byte-identical, sha256-verified at copy time)
 *
 * - `material-icon-rules.json` / `material-icon-svgs.json` — vendored from
 *   the pinned submodule's `gitea/options/fileicon/` (upstream generates
 *   them from the npm `material-icon-theme@5.39.0` package via
 *   `tools/generate-svg.ts`, `make svg`). 461,498 / 998,898 bytes.
 * - `basic/*.svg` — the seven processed icon files from the pinned
 *   submodule's `public/assets/img/svg/` store that the basic layer renders
 *   (six octicons + `material-folder-symlink`), vendored because the
 *   landed `ui/icons.generated.ts` covers only the shell's octicon subset
 *   and carries path bodies, not markup.
 *
 * Both JSONs load through Vite's `?raw` transform and are JSON.parsed
 * lazily-once (the ws1009 lesson, docs/research/workers-vitest-ws1009-issue.md:
 * normal-form JSON module imports of this size ride the vitest-plugin's
 * graph-snapshot WebSocket path that dies with 1009 at full-suite scale;
 * `?raw` graphs stayed clean in every measured run).
 *
 * ## The enry correction (documented finding, not a divergence)
 *
 * The wave-39 skip note cited "the enry classifier" as part of this
 * machinery — the pinned code has NO enry dependency:
 * `gitea/modules/fileicon/material.go` resolves icons purely through the
 * rules JSON (fileNames/folderNames/fileExtensions plus its `languageIds`
 * map, material.go:119-129 findIconNameWithLangID — a language id is only
 * reached as the JSON's own mapping target, never from content or name
 * classification). enry appears only in the SIBLING tree-list path
 * (`isExcludedEntry` vendor filtering, routers/web/repo/treelist.go:51-64),
 * which tree-list-aux already handles. The port below is therefore EXACT
 * for the pinned lookup — no language-lookup degradation exists to document.
 *
 * ## Theme defaults (the one divergence)
 *
 * Upstream dispatches themes through settings: `setting.UI.FileIconTheme`
 * (default `material`, modules/setting/ui.go:100) for files and
 * `setting.UI.FolderIconTheme` (default `basic`, ui.go:101) for directories
 * and symlinks-to-directories (render.go:36-47 RenderEntryIconHTML). This
 * port fixes those defaults — no app.ini surface exists to plumb yet;
 * renderEntryIconHtml implements exactly the default posture. The
 * lower-level materialEntryIconHtml/basicEntryIconHtml stay exported so a
 * future settings plumbing can dispatch without re-porting.
 *
 * ## Markup fidelity
 *
 * The HTML strings reproduce upstream's bytes: the material side via
 * material.go:64-80 renderFileIconSVG (`<svg id="svg-mfi-<name>"` + common
 * attrs + the single-quoted SVG body from the JSON; pool members render as
 * `<use href="#svg-mfi-<name>">` references), the basic side via the
 * svg.Normalize + svg.RenderHTML pipeline (modules/svg/processor.go:34-56,
 * modules/svg/svg.go renderHTML: strip xmlns/size attrs, re-add
 * `width="16" height="16"`, prepend extra classes into `class="`).
 * CONSUMER NOTE: Go's json.MarshalWrite (services/context/base.go:118) HTML-
 * escapes `<`/`>`/`&` as \u003c/\u003e/\u0026 when the tree-view wave
 * serializes these strings — that choice belongs to the envelope assembly.
 */

/** Upstream git.EntryMode as the tree-view JSON spells it
 *  (services/repository/files/tree.go:84-99 entryModeString). */
export type EntryMode = "blob" | "exec" | "symlink" | "commit" | "tree" | "unknown";

/** gitea/modules/fileicon/entry.go:12-17 EntryInfo. */
export type EntryInfo = {
  baseName: string;
  entryMode: EntryMode;
  /** entry.go sets this only when a symlink resolves to a directory
   *  (EntryInfoFromGitTreeEntry → EntryFollowLink); null = unresolved. */
  symlinkToMode: EntryMode | null;
  isOpen: boolean;
};

const isLink = (entry: EntryInfo): boolean => entry.entryMode === "symlink";
const isDir = (entry: EntryInfo): boolean => entry.entryMode === "tree";
const isSubModule = (entry: EntryInfo): boolean => entry.entryMode === "commit";
const symlinkToDir = (entry: EntryInfo): boolean => isLink(entry) && entry.symlinkToMode === "tree";

/** entry.go:19-27 EntryInfoFromGitTreeEntry — the link-follow arm is the
 *  caller's (the engine's symlink resolution), so the constructor takes the
 *  resolved modes directly; entry.go:29-35's folder shorthands ride along. */
export function entryInfo(baseName: string, entryMode: EntryMode, symlinkToMode: EntryMode | null = null, isOpen = false): EntryInfo {
  return { baseName, entryMode, symlinkToMode, isOpen };
}

export function entryInfoFolder(): EntryInfo {
  return entryInfo("", "tree");
}

export function entryInfoFolderOpen(): EntryInfo {
  return entryInfo("", "tree", null, true);
}

// --- the basic (octicon) layer: modules/svg + basic.go -----------------------

/** The seven vendored processed SVGs (module header). Byte-identical copies
 *  of the pinned submodule's public/assets/img/svg store, read through the
 *  `?raw` transform. */
import octiconFile from "./basic/octicon-file.svg?raw";
import octiconFileSymlinkFile from "./basic/octicon-file-symlink-file.svg?raw";
import octiconFileDirectorySymlink from "./basic/octicon-file-directory-symlink.svg?raw";
import octiconFileDirectoryOpenFill from "./basic/octicon-file-directory-open-fill.svg?raw";
import octiconFileDirectoryFill from "./basic/octicon-file-directory-fill.svg?raw";
import octiconFileSubmodule from "./basic/octicon-file-submodule.svg?raw";
import materialFolderSymlink from "./basic/material-folder-symlink.svg?raw";

const BASIC_SVG_SOURCES: Readonly<Record<string, string>> = {
  "octicon-file": octiconFile,
  "octicon-file-symlink-file": octiconFileSymlinkFile,
  "octicon-file-directory-symlink": octiconFileDirectorySymlink,
  "octicon-file-directory-open-fill": octiconFileDirectoryOpenFill,
  "octicon-file-directory-fill": octiconFileDirectoryFill,
  "octicon-file-submodule": octiconFileSubmodule,
  "material-folder-symlink": materialFolderSymlink,
};

// modules/svg/processor.go:22-29 globalVars regexes.
const RE_XML_DOC = /<\?xml[\s\S]*?>/g;
const RE_COMMENT = /<!--[\s\S]*?-->/g;
const RE_ATTR_XMLNS = /\s+xmlns\s*=\s*"[^"]*"/g;
const RE_ATTR_SIZE = /\s+(width|height)\s*=\s*"[^"]+"/g;
const RE_ATTR_CLASS_PREFIX = /\s+class\s*=\s*"/g;

/** modules/svg/processor.go:34-56 Normalize — strip XML decl/comments,
 *  drop xmlns and size attributes, re-add `width="16" height="16"`, keep
 *  (or default) the class attribute. */
function normalizeSvg(data: string): string {
  data = data.replace(RE_XML_DOC, "").replace(RE_COMMENT, "").trim();
  const gt = data.indexOf(">");
  if (gt === -1 || !data.startsWith("<svg")) return data;
  const svgTag = data.slice(0, gt);
  const svgRemaining = data.slice(gt + 1);
  let normalized = svgTag.replace(RE_ATTR_XMLNS, "").replace(RE_ATTR_SIZE, "").replace(RE_ATTR_CLASS_PREFIX, ` class="`).trim();
  normalized += ` width="16" height="16"`;
  if (!normalized.includes(` class="`)) normalized += ` class="svg"`;
  return `${normalized}>${svgRemaining}`;
}

/** modules/svg/svg.go renderHTML over the Init-time store — the size is
 *  always the 16 default here, so the only surgery is prepending an extra
 *  class into `class="` (svg.go:97-100). */
function renderSvgHtml(icon: string, extraClass: string): string {
  const stored = BASIC_SVG_HTML[icon];
  if (stored === undefined) return ""; // upstream logs and renders empty; our store is closed over the seven names
  if (extraClass === "") return stored;
  return stored.replace(`class="`, `class="${extraClass} `);
}

/** The Init-time normalized store (svg.go:41-51). Built lazily-once — the
 *  module-level memo of pure asset data, upstream's sync.Once pattern
 *  (no request state lives here). */
const BASIC_SVG_HTML: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const [name, source] of Object.entries(BASIC_SVG_SOURCES)) out[name] = normalizeSvg(source);
  return out;
})();

/** basic.go:13-27 BasicEntryIconName. */
export function basicEntryIconName(entry: EntryInfo): string {
  if (isLink(entry)) {
    if (entry.symlinkToMode === "tree") return "octicon-file-directory-symlink";
    return "octicon-file-symlink-file";
  }
  if (isDir(entry)) return entry.isOpen ? "octicon-file-directory-open-fill" : "octicon-file-directory-fill";
  if (isSubModule(entry)) return "octicon-file-submodule";
  return "octicon-file";
}

/** basic.go:29-31 BasicEntryIconHTML. */
export function basicEntryIconHtml(entry: EntryInfo): string {
  return renderSvgHtml(basicEntryIconName(entry), "");
}

// --- the material layer: material.go -----------------------------------------

/** material.go:19-24 materialIconRulesData — the four maps the pinned code
 *  unmarshals from the vendored rules JSON (the file carries further
 *  VSCode-manifest keys upstream ignores). */
type MaterialIconRules = {
  fileNames: Record<string, string>;
  folderNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  languageIds: Record<string, string>;
};

/** material.go:26-30 MaterialIconProvider — the parsed asset pair. */
type MaterialIconData = { rules: MaterialIconRules; svgs: Record<string, string> };

import materialIconRulesJson from "./material-icon-rules.json?raw";
import materialIconSvgsJson from "./material-icon-svgs.json?raw";

let materialDataCache: MaterialIconData | null = null;

/** material.go:34-37 DefaultMaterialIconProvider's loadData — lazily-once
 *  (upstream's sync.Once); the bundled assets cannot fail to read, so the
 *  rules-nil fallback arm (material.go:83-85) has no counterpart here. */
function loadMaterial(): MaterialIconData {
  if (materialDataCache === null) {
    materialDataCache = {
      rules: JSON.parse(materialIconRulesJson) as MaterialIconRules,
      svgs: JSON.parse(materialIconSvgsJson) as Record<string, string>,
    };
  }
  return materialDataCache;
}

/** The parsed asset pair, for consumers that need raw lookups (tests, a
 *  future theme picker). */
export function materialIcons(): MaterialIconData {
  return loadMaterial();
}

/** render.go:13-21 RenderedIconPool — the svgId → svg HTML map the tree-view
 *  envelope ships as `renderedIconPool` (treelist.go:160). */
export type RenderedIconPool = { iconSvgs: Map<string, string> };

export function newRenderedIconPool(): RenderedIconPool {
  return { iconSvgs: new Map() };
}

/** material.go:64-80 renderFileIconSVG — the pool records the FULL svg (id
 *  attribute included) once per name (first write wins, material.go:76-78);
 *  the returned markup references it through `<use href="#svg-mfi-…">`.
 *  The invalid-svg guard is upstream's outright panic (material.go:67-69). */
function renderFileIconSvg(pool: RenderedIconPool | null, name: string, svg: string, extraClass: string): string {
  if (!svg.startsWith("<svg")) throw new Error("Invalid SVG icon");
  const svgId = `svg-mfi-${name}`;
  const svgCommonAttrs = `class="svg git-entry-icon ${extraClass}" width="16" height="16" aria-hidden="true"`;
  const svgHtml = `<svg id="${svgId}" ${svgCommonAttrs}${svg.slice(4)}`;
  if (pool === null) return svgHtml;
  if (!pool.iconSvgs.get(svgId)) pool.iconSvgs.set(svgId, svgHtml);
  return `<svg ${svgCommonAttrs}><use href="#${svgId}"></use></svg>`;
}

/** material.go:119-129 findIconNameWithLangID — the candidate itself when an
 *  SVG exists under it, else the rules' languageIds mapping of it. */
function findIconNameWithLangId(data: MaterialIconData, s: string): string {
  if (data.svgs[s] !== undefined) return s;
  const mapped = data.rules.languageIds[s];
  if (mapped !== undefined && data.svgs[mapped] !== undefined) return mapped;
  return "";
}

/** material.go:131-162 FindIconName — the exact lookup order: submodule →
 *  "folder-git"; directories by folderNames (lowercased full name) with the
 *  folder/folder-open fallback; files by fileNames (lowercased full name)
 *  then the LONGEST-suffix-first extension walk (the loop scans dots from
 *  the string end, so `archive.tar.gz` tries `gz` before `tar.gz`), each
 *  candidate resolved through the languageIds arm; finally "file". */
export function findIconName(entry: EntryInfo): string {
  const data = loadMaterial();
  if (isSubModule(entry)) return "folder-git";

  const fileNameLower = entry.baseName.toLowerCase();
  if (isDir(entry)) {
    const folder = data.rules.folderNames[fileNameLower];
    if (folder !== undefined) return folder;
    return entry.isOpen ? "folder-open" : "folder";
  }

  const fileNameIcon = data.rules.fileNames[fileNameLower];
  if (fileNameIcon !== undefined) {
    const resolved = findIconNameWithLangId(data, fileNameIcon);
    if (resolved !== "") return resolved;
  }

  for (let i = fileNameLower.length - 1; i >= 0; i--) {
    if (fileNameLower[i] === ".") {
      const ext = fileNameLower.slice(i + 1);
      const extIcon = data.rules.fileExtensions[ext];
      if (extIcon !== undefined) {
        const resolved = findIconNameWithLangId(data, extIcon);
        if (resolved !== "") return resolved;
      }
    }
  }

  return "file";
}

/** material.go:82-117 EntryIconHTML — the material-theme markup for one
 *  entry: the symlink arms first (the to-directory case keeps the legacy
 *  octicon class beside the material-folder-symlink icon, material.go:87-93),
 *  the resolved icon's SVG through the pool, and the legacy
 *  "octicon-*" extra class so theme-plugin selectors keep working
 *  (material.go:108-115). The missing file/folder fallback SVG is
 *  upstream's PanicInDevOrTesting (material.go:104) — our bundled assets
 *  carry all three, so the arm is a hard error. */
export function materialEntryIconHtml(pool: RenderedIconPool | null, entry: EntryInfo): string {
  const data = loadMaterial();

  if (isLink(entry)) {
    if (entry.symlinkToMode === "tree") {
      return renderSvgHtml("material-folder-symlink", "octicon-file-directory-symlink");
    }
    return renderSvgHtml("octicon-file-symlink-file", "");
  }

  let name = findIconName(entry);
  let iconSvg = data.svgs[name];
  if (iconSvg === undefined) {
    name = isDir(entry) ? (entry.isOpen ? "folder-open" : "folder") : "file";
    iconSvg = data.svgs[name];
    if (iconSvg === undefined) throw new Error(`missing file icon for ${name}`);
  }

  return renderFileIconSvg(pool, name, iconSvg, basicExtraClass(entry));
}

/** material.go:108-115's extraClass selection — the legacy octicon class
 *  for directories (the basic icon name for the entry's open state) and
 *  submodules; plain files carry "octicon-file". */
function basicExtraClass(entry: EntryInfo): string {
  if (isDir(entry)) return basicEntryIconName(entry);
  if (isSubModule(entry)) return "octicon-file-submodule";
  return "octicon-file";
}

/** render.go:36-47 RenderEntryIconHTML with the theme defaults FIXED
 *  (FileIconTheme `material`, FolderIconTheme `basic` — module header):
 *  directories and symlinks-to-directories render the basic octicons,
 *  everything else the material theme. */
export function renderEntryIconHtml(pool: RenderedIconPool, entry: EntryInfo): string {
  if (isDir(entry) || symlinkToDir(entry)) return basicEntryIconHtml(entry);
  return materialEntryIconHtml(pool, entry);
}

/** render.go:23-34 RenderToHTML — the hidden pool container the page shell
 *  mounts so the `<use>` references resolve. Empty pool → "" (upstream
 *  iterates a Go map, so its member order is randomized; ours is insertion
 *  order — same member set). */
export function renderIconPoolHtml(pool: RenderedIconPool): string {
  if (pool.iconSvgs.size === 0) return "";
  let out = `<div class="svg-icon-container">`;
  for (const svg of pool.iconSvgs.values()) out += svg;
  return `${out}</div>`;
}
