/**
 * Language statistics service (SPEC-0004 §2.4 row repoGetLanguages): bytes
 * per language over the tree, computed ON DEMAND — upstream computes
 * asynchronously (go-enry over a clone) and caches rows in language_stats;
 * this reduction walks the ref's tree through the engine's listTree RPCs and
 * sums the tree-reported blob SIZES by extension (no blob bytes are read, so
 * the cost is one RPC per directory, bounded by the same walk budgets the
 * archive walk carries).
 *
 * Documented reduction (SPEC-0004 divergence note): detection is
 * EXTENSION-BASED only — go-enry's filename/content heuristics
 * (Makefile, shebangs, vendor overrides) are not reproduced; unknown
 * extensions are skipped (they count nowhere, like enry's unclassified
 * languages). The map is ordered by bytes descending (the language_stats
 * query's ORDER BY size DESC).
 */

import type { EngineReads } from "./engine";
import { ApiError } from "../errors";

/** Extension → linguist/enry language name (the common subset). */
const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  c: "C",
  cc: "C++",
  cfg: "INI",
  clj: "Clojure",
  cpp: "C++",
  cs: "C#",
  css: "CSS",
  cxx: "C++",
  go: "Go",
  h: "C",
  hpp: "C++",
  htm: "HTML",
  html: "HTML",
  java: "Java",
  js: "JavaScript",
  json: "JSON",
  jsx: "JavaScript",
  kt: "Kotlin",
  lua: "Lua",
  md: "Markdown",
  mjs: "JavaScript",
  php: "PHP",
  pl: "Perl",
  py: "Python",
  r: "R",
  rb: "Ruby",
  rs: "Rust",
  scala: "Scala",
  sh: "Shell",
  sql: "SQL",
  swift: "Swift",
  toml: "TOML",
  ts: "TypeScript",
  tsx: "TypeScript",
  txt: "Text",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
};

/** Walk caps — shared posture with the archive walk (module doc there). */
const MAX_LANGUAGE_FILES = 20_000;
const MAX_LANGUAGE_DIRS = 2_000;

/**
 * Bytes per language over the whole tree of `refTarget`. An empty tree (or a
 * tree of only submodules/unknown extensions) yields an empty map — upstream
 * answers the empty {} for such repositories.
 */
export async function languageStats(reads: EngineReads, refTarget: string): Promise<Record<string, number>> {
  const sizes = new Map<string, number>();
  let files = 0;
  let dirs = 0;
  const walk = async (prefix: string): Promise<void> => {
    const tree = await reads.listTree(refTarget, prefix);
    if (tree === null) return;
    for (const entry of tree.entries) {
      if (entry.type === "tree") {
        dirs += 1;
        if (dirs > MAX_LANGUAGE_DIRS) {
          throw new ApiError(422, "repository tree exceeds the language-statistics walk budget");
        }
        await walk(prefix === "" ? entry.name : `${prefix}/${entry.name}`);
      } else if (entry.type === "blob") {
        files += 1;
        if (files > MAX_LANGUAGE_FILES) {
          throw new ApiError(422, "repository tree exceeds the language-statistics walk budget");
        }
        const dot = entry.name.lastIndexOf(".");
        if (dot <= 0) continue; // no extension (or a dotfile) — extension-only detection
        const language = EXTENSION_LANGUAGES[entry.name.slice(dot + 1).toLowerCase()];
        if (language === undefined) continue;
        sizes.set(language, (sizes.get(language) ?? 0) + (entry.size ?? 0));
      }
      // type "commit" (submodule): skipped, like upstream
    }
  };
  await walk("");
  return Object.fromEntries([...sizes.entries()].sort((a, b) => b[1] - a[1]));
}
