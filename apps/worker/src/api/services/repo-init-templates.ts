/**
 * The repo-create auto-init template catalogs — upstream's `options/`
 * asset families, vendored VERBATIM into committed data files and loaded
 * through Vite's `?raw` transform (the fileicon precedent: byte-identical
 * copies of the pinned submodule's assets, since the Worker bundle cannot
 * reach the submodule at runtime — import.meta.glob resolves nothing outside
 * the apps/worker root). Sources at pin fc4936884584:
 *
 *   - `src/api/data/gitignore-templates.json` — the 270 files of
 *     `gitea/options/gitignore/` (repo_module.Gitignores), packed
 *     name→content by a one-off
 *     `python3 -I: json.dump({name: file.read()})` over sorted listdir
 *     (regenerate the same way after a submodule pin bump).
 *   - `src/api/data/license-templates.json` — the 27 files of
 *     `gitea/options/license/` (repo_module.Licenses), same packing.
 *   - the readme family stays the single-entry catalog in
 *     services/user-repos.ts (`options/readme/` carries exactly one file,
 *     "Default"; `repo_module.Readmes`).
 *
 * The JSONs parse LAZILY-ONCE (the ws1009 lesson —
 * docs/research/workers-vitest-ws1009-issue.md: normal-form JSON module
 * imports of this size ride the vitest-plugin's graph-snapshot WebSocket
 * path that dies with 1009 at full-suite scale; `?raw` + JSON.parse graphs
 * stayed clean in every measured run).
 *
 * Failure semantics (why the loaders THROW): upstream validates the readme
 * template in the API handler (400, repo.go:228-231) but the
 * gitignores/license names are read INSIDE initRepository — an unknown name
 * errors there (create.go:113-114 `GetRepoInitFile[%s]`, :131-135
 * `getLicense[%s]`), CreateRepositoryDirectly's deferred cleanup deletes the
 * just-created repo (create.go:236-241 → :448-456), and the handler's
 * unmapped-error arm answers 500 (repo.go:254-259 — only
 * already-exist/reserved/pattern/label-template map to 409/422). The loaders
 * here throw so the create service can run that exact rollback.
 */

import gitignoreRaw from "../data/gitignore-templates.json?raw";
import licenseRaw from "../data/license-templates.json?raw";

/** One rendered initial-tree file: [path, content bytes]. */
export interface InitTreeFile {
  path: string;
  content: Uint8Array;
}

// The lazy-once parses (see the module header's ws1009 note).
const gitignoreCache: { map?: Map<string, string> } = {};
const licenseCache: { map?: Map<string, string> } = {};

/** `repo_module.Gitignores` — the options/gitignore/ directory listing
 *  (name → verbatim content), parsed lazily-once. */
export function gitignoreCatalog(): ReadonlyMap<string, string> {
  gitignoreCache.map ??= new Map(Object.entries(JSON.parse(gitignoreRaw) as Record<string, string>));
  return gitignoreCache.map;
}

/** `repo_module.Licenses` — the options/license/ directory listing
 *  (name → verbatim content), parsed lazily-once. */
export function licenseCatalog(): ReadonlyMap<string, string> {
  licenseCache.map ??= new Map(Object.entries(JSON.parse(licenseRaw) as Record<string, string>));
  return licenseCache.map;
}

const ENCODER = new TextEncoder();

/** The `# ---> <name>` join of a comma-separated gitignores option
 * (create.go:108-124 — `strings.SplitSeq(opts.Gitignores, ",")`, one
 * `# ---> name` header + body + trailing newline per entry, concatenated
 * into ONE `.gitignore`). Unknown names throw the init failure (see the
 * module header — create.go:113-114), which the create service maps to the
 * 500-with-rollback. Empty segments throw like upstream's `Gitignore("")`
 * file miss (a trailing comma is not silently dropped). */
export function renderGitignoreCsv(gitignores: string): Uint8Array {
  const catalog = gitignoreCatalog();
  const buf: string[] = [];
  for (const name of gitignores.split(",")) {
    const data = catalog.get(name);
    if (data === undefined) {
      throw new Error(`GetRepoInitFile[${name}]: gitignore template does not exist`);
    }
    buf.push(`# ---> ${name}\n`, data, "\n");
  }
  return ENCODER.encode(buf.join(""));
}

/** `LicenseValues` (modules/repository/license.go:16-21) — the substitution
 *  pool prepareRepoCommit fills (create.go:126-135: Owner=repo.OwnerName,
 *  Email=authorSig.Email, Repo=repo.Name, Year=now.Format("2006")). */
export interface LicenseValues {
  owner: string;
  email: string;
  repo: string;
  year: string;
}

/** The universal placeholder table + the per-license specials
 * (license.go:55-92 — verbatim port; the comment there: "If you want to add
 * a new one, make sure you have check it by `grep -r 'NEW_WORD'
 * options/license` and all of them are placeholders"). `matchLine` limits
 * substitution to matching lines (nil → every line). */
interface LicensePlaceholder {
  owner: string[];
  email: string[];
  repo: string[];
  year: string[];
  matchLine: RegExp | null;
}

function getLicensePlaceholder(name: string): LicensePlaceholder {
  const universal: LicensePlaceholder = {
    owner: [
      "<name of author>",
      "<owner>",
      "[NAME]",
      "[name of copyright owner]",
      "[name of copyright holder]",
      "<COPYRIGHT HOLDERS>",
      "<copyright holders>",
      "<AUTHOR>",
      "<author's name or designee>",
      "[one or more legally recognised persons or entities offering the Work under the terms and conditions of this Licence]",
    ],
    email: ["[EMAIL]"],
    repo: ["<program>", "<one line to give the program's name and a brief idea of what it does.>"],
    year: ["<year>", "[YEAR]", "{YEAR}", "[yyyy]", "[Year]", "[year]"],
    matchLine: null,
  };
  // The one per-license special (license.go:78-87) — 0BSD carries a second
  // non-placeholder AUTHOR later in the file, so substitution is line-gated.
  if (name === "0BSD") {
    return {
      owner: ["AUTHOR"],
      email: ["EMAIL"],
      year: ["YEAR"],
      repo: universal.repo,
      matchLine: /Copyright \(C\) YEAR by AUTHOR EMAIL/,
    };
  }
  return universal;
}

/** `fillLicensePlaceholder` (license.go:31-53) — line scanner; every emitted
 *  line gets a trailing "\n" (Go's `WriteString(line + "\n")`, so the output
 *  always ends with one newline and CRLF input is normalized to LF the way
 *  bufio.Scanner's ScanLines drops the \r). Substitution order Owner →
 *  Email → Repo → Year over the matched lines only. */
function fillLicensePlaceholder(name: string, values: LicenseValues, origin: string): string {
  const placeholder = getLicensePlaceholder(name);
  const lines = origin.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop(); // a trailing newline is not an extra (empty) scanner line
  }
  return (
    lines
      .map((raw) => {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (placeholder.matchLine !== null && !placeholder.matchLine.test(line)) {
          return line;
        }
        let out = line;
        for (const v of placeholder.owner) out = out.split(v).join(values.owner);
        for (const v of placeholder.email) out = out.split(v).join(values.email);
        for (const v of placeholder.repo) out = out.split(v).join(values.repo);
        for (const v of placeholder.year) out = out.split(v).join(values.year);
        return out;
      })
      .map((line) => `${line}\n`)
      .join("")
  );
}

/** `repo_module.GetLicense` (license.go:23-29) — the template read plus the
 *  placeholder fill. Unknown names throw the init failure (create.go:131-135,
 *  see the module header). */
export function renderLicenseTemplate(name: string, values: LicenseValues): Uint8Array {
  const data = licenseCatalog().get(name);
  if (data === undefined) {
    throw new Error(`getLicense[${name}]: license template does not exist`);
  }
  return ENCODER.encode(fillLicensePlaceholder(name, values, data));
}

/** The initial-tree files for a set of resolved create options (README.md
 *  rides services/user-repos.ts's own Default render — upstream writes it
 *  separately too, create.go:97-103 vs the .gitignore :108-124 and LICENSE
 *  :126-146 arms). Entry order is git's byte-order requirement
 *  (".gitignore" < "LICENSE" < "README.md"). Empty option strings skip their
 *  arm exactly like upstream's `len(...) > 0` guards. */
export function renderInitTreeFiles(form: { gitignores?: string; license?: string }, values: LicenseValues): InitTreeFile[] {
  const files: InitTreeFile[] = [];
  if (form.gitignores !== undefined && form.gitignores.length > 0) {
    files.push({ path: ".gitignore", content: renderGitignoreCsv(form.gitignores) });
  }
  if (form.license !== undefined && form.license.length > 0) {
    files.push({ path: "LICENSE", content: renderLicenseTemplate(form.license, values) });
  }
  return files;
}
