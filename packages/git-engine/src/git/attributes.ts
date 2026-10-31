/**
 * The .gitattributes language (gitattributes(5)) in the subset the archive
 * surface consumes: pattern compilation + matching, the export-ignore /
 * export-subst attribute resolution, and MACRO ATTRIBUTES (`[attr]name`
 * lines) — the git attr.c analog. The boundary decision (cf-gitea board row
 * P2-8, docs/research/attr-macro-boundary.md): macro expansion belongs in the
 * attribute MATCHER — macros are a gitattributes-language feature, not a
 * consumer concern — and the matcher lives in the engine package, this repo's
 * git-semantics library layer (the position blame.ts, merge/* and
 * commit/serialize.ts already hold). Consumers (apps/worker
 * api/services/archive.ts) thread one macro registry through their walk and
 * resolve the EXPANDED rules unchanged.
 *
 * Everything here was pinned against stock git 2.43.0 (fixture repos +
 * `git archive` / `git check-attr`, the probe matrix in the decision doc):
 *
 * - Resolution across lines/files: rules apply root .gitattributes → deeper
 *   files, each file's lines in order, and the LAST matching assignment for
 *   an attribute wins (gitattributes(5) precedence; the 5365236 posture).
 * - WITHIN one line, git's fill walks the attribute states from LAST to
 *   FIRST and the first assignment to an attribute wins: `f a b` with
 *   `[attr]a export-ignore` + `[attr]b -export-ignore` answers UNSET (the
 *   rightmost macro won), and `f export-ignore -export-ignore` answers
 *   unset. A macro token sets its attribute, then immediately expands its
 *   body (fill_one → macroexpand_one) with the same right-to-left walk and
 *   the same already-filled guard — so a rightward token beats a leftward
 *   macro's body (`f export-ignore m` + `[attr]m -export-ignore` → unset).
 * - Expansion participates at the EXPANDING line's position: `[attr]m
 *   export-ignore` / `f m` / `f -export-ignore` keeps the file (the later
 *   explicit line wins), while `f -export-ignore` / `f m` (macro defined
 *   last) drops it — macros do not preempt later lines.
 * - Macro definitions register from the TOP-LEVEL .gitattributes only
 *   (gitattributes(5) "macro attributes can be defined only in top-level
 *   gitattributes files"); a `[attr]` line in a deeper file is ignored —
 *   git 2.43 prints a localized "not allowed" warning, this matcher skips
 *   silently (the walk has no stderr channel; the same posture as 5365236's
 *   `!pattern` lines). Definitions apply to every later-parsed file of the
 *   walk (the consumer threads one registry), to later lines of the defining
 *   file itself (parse-then-resolve: a use line above the definition still
 *   expands), and a REdefinition overwrites (last definition wins).
 * - The registry seeds git's builtin macro, attr.c's
 *   `[attr]binary -diff -merge -text` — so `binary` is a defined macro that
 *   recurses (contributing nothing to the archive subset) and a user
 *   `[attr]binary` line overrides it exactly like any other name.
 * - A macro expands only when its attribute is SET (`value === true`) on the
 *   path line — `m=x`, `-m` and `!m` never expand ("macro attributes can
 *   only be Set"). An UNDEFINED name on a path line is an ordinary
 *   attribute: no expansion, no archive effect.
 * - Macro cycles (`[attr]a b` + `[attr]b a`) terminate silently — git's
 *   already-set guard stops the recursion with no diagnostic; the seen-set
 *   here reproduces that.
 * - `!attr` inside a macro body is a real assignment (the unspecified value)
 *   and can re-open an attribute like a direct `!attr` line can.
 *
 * Attribute VALUE forms (`attr=x`) never satisfy the archive checks (git's
 * ATTR_TRUE gate): the resolvers treat non-true as no-match, unchanged from
 * the 5365236 posture. Pattern matching (gitignore(5) anchoring, trailing
 * slash dir-only, `**` crossing) is byte-for-byte the matcher 5365236 landed
 * worker-side, moved here with the macro arm; the documented outside-the-
 * subset reductions (`[...]` classes, brace expansion, escaped wildcards)
 * still stand.
 */

/** One parsed .gitattributes line that assigns an archive-relevant attribute,
 * with the macro-expanded assignments folded in at the line's position. */
export interface GitattributesRule {
  re: RegExp;
  /** pattern ended with `/` — matches directories only */
  dirOnly: boolean;
  /** pattern had no slash — matched against the basename at any depth */
  basenameOnly: boolean;
  exportIgnore?: boolean | null;
  exportSubst?: boolean | null;
}

/**
 * Macro name → its body's raw attribute tokens (`[attr]name t1 t2 …`).
 * Bodies resolve lazily at each use line (right-to-left, recursive) so a
 * definition order that would break eager flattening — a use line above the
 * `[attr]` line, or a body referencing a macro defined after it — behaves
 * exactly like git's resolve-time expansion. Threading ONE registry through
 * the walk is what makes a root-defined macro reach deeper files' rules.
 */
export type AttrMacros = Map<string, string[]>;

/**
 * git attr.c's builtin_attr[] — the one builtin macro definition. Users
 * override it by redefining the name in the top-level .gitattributes (pinned:
 * `[attr]binary export-ignore` makes text/diff unspecified AND export-ignore
 * set — the user definition REPLACES the builtin).
 */
export function createAttrMacros(): AttrMacros {
  return new Map<string, string[]>([["binary", ["-diff", "-merge", "-text"]]]);
}

/** `name` → true; `-name` → false; `!name` → null; `name=value` → undefined. */
function attrAssignment(token: string): { name: string; value: boolean | null | undefined } | null {
  if (token.startsWith("-")) return { name: token.slice(1), value: false };
  if (token.startsWith("!")) return { name: token.slice(1), value: null };
  const eq = token.indexOf("=");
  if (eq >= 0) return { name: token.slice(0, eq), value: undefined };
  return { name: token, value: true };
}

/**
 * The ATTRIBUTE_MACRO_PREFIX parse of one `[attr]name body…` line: the macro
 * name after the prefix, body tokens verbatim. Null when the line is not a
 * well-formed macro definition.
 */
function macroDefinition(line: string): { name: string; body: string[] } | null {
  const fields = splitAttrFields(line);
  const head = fields[0];
  if (head === undefined || !head.startsWith("[attr]")) return null;
  const name = head.slice("[attr]".length);
  if (name === "") return null;
  return { name, body: fields.slice(1) };
}

/**
 * One line's (and recursively one macro body's) attribute states, resolved
 * git's way: walk the tokens from LAST to FIRST, first assignment to an
 * attribute wins, and a set macro token expands its body inline with the
 * same walk over the same filled map (the seen-set is the already-set
 * guard's stand-in — git's cycle stop, pinned silent).
 */
function expandTokens(tokens: string[], macros: AttrMacros, filled: Map<string, boolean | null | undefined>, seen: Set<string>): void {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const assignment = attrAssignment(tokens[i] as string);
    if (assignment === null) continue;
    if (!filled.has(assignment.name)) filled.set(assignment.name, assignment.value);
    if (assignment.value === true && macros.has(assignment.name) && !seen.has(assignment.name)) {
      seen.add(assignment.name);
      expandTokens(macros.get(assignment.name) as string[], macros, filled, seen);
    }
  }
}

/** The archive-relevant outcome of one line's states (undefined = unassigned). */
function expandLine(fields: string[], macros: AttrMacros): { exportIgnore?: boolean | null; exportSubst?: boolean | null } {
  const filled = new Map<string, boolean | null | undefined>();
  expandTokens(fields, macros, filled, new Set<string>());
  return { exportIgnore: filled.get("export-ignore"), exportSubst: filled.get("export-subst") };
}

/**
 * gitignore(5) matching for one rule: anchored patterns match the whole
 * repo-root-relative path; basename patterns match at any depth; dirOnly
 * rules never match a file entry. Directory matches prune the subtree at the
 * walk site (upstream: "patterns that match a directory do not recursively
 * match paths inside that directory" — the prune is what archives get).
 */
export function ruleMatches(rule: GitattributesRule, path: string, isDir: boolean): boolean {
  if (rule.dirOnly && !isDir) return false;
  if (rule.basenameOnly) {
    const base = path.slice(path.lastIndexOf("/") + 1);
    return rule.re.test(base);
  }
  return rule.re.test(path);
}

/**
 * The LAST matching export-ignore assignment in rule order wins; rule order
 * is root→leaf files with each file's lines in order, which reproduces
 * gitattributes(5)'s precedence (deeper file beats shallower, later line
 * beats earlier). No matching assignment → unspecified → include.
 */
export function exportIgnoreExcluded(rules: GitattributesRule[], path: string, isDir: boolean): boolean {
  let value: boolean | null | undefined;
  for (const rule of rules) {
    if (rule.exportIgnore === undefined) continue;
    if (ruleMatches(rule, path, isDir)) value = rule.exportIgnore;
  }
  return value === true;
}

/**
 * export-subst's mirror of the resolution above: the LAST matching export-subst
 * assignment in rule order wins; `-export-subst` in a deeper file re-includes.
 * Only git's ATTR_TRUE expands — value forms never match, like export-ignore.
 */
export function exportSubstActive(rules: GitattributesRule[], path: string, isDir: boolean): boolean {
  let value: boolean | null | undefined;
  for (const rule of rules) {
    if (rule.exportSubst === undefined) continue;
    if (ruleMatches(rule, path, isDir)) value = rule.exportSubst;
  }
  return value === true;
}

/** One unanchored segment: `*`/`?` never cross `/` (gitignore wildmatch). */
function compileSegment(segment: string): string {
  let out = "";
  for (const ch of segment) {
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

function compilePattern(pattern: string, dirOnly: boolean, basenameOnly: boolean): GitattributesRule {
  let source: string;
  if (basenameOnly) {
    source = `^${compileSegment(pattern)}$`;
  } else {
    // `**` as a whole segment crosses directories; `**/` also matches zero of
    // them (gitignore wildmatch). Leading `**/x` → x at any depth; `x/**`
    // matches everything below x but not x itself.
    source = "^";
    const segments = pattern.split("/");
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i] as string;
      const last = i === segments.length - 1;
      if (segment === "**") {
        source += last ? ".*" : "(?:.*/)?";
        continue;
      }
      source += compileSegment(segment);
      if (!last) source += "/";
    }
    source += "$";
  }
  return { re: new RegExp(source, "u"), dirOnly, basenameOnly };
}

/**
 * Field split with gitattributes' backslash escapes (`foo\ bar` is one field
 * whose space is literal); the backslash itself is dropped from the field.
 */
function splitAttrFields(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let escaped = false;
  for (const ch of line) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (current !== "") {
        fields.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += "\\";
  if (current !== "") fields.push(current);
  return fields;
}

/**
 * Parse one .gitattributes blob's text as found at tree directory `dir`
 * ("" for the root). gitattributes(5) line grammar with the archive subset:
 * comments (`#`), blank lines and `!pattern` negative-pattern lines are
 * skipped (git 2.43 ignores the latter with a warning). MACRO lines register
 * into `macros` when this file is the TOP-LEVEL one (`dir === ""` — deeper
 * definitions are ignored like git's warned-and-skipped lines) before any
 * pattern line compiles, so every use line below sees the file's complete
 * definitions; the walk threads the SAME registry through all files, which
 * is how a root macro reaches a deeper file's rules. Pattern lines compile
 * one rule each, their states (direct assignments AND macro expansions)
 * resolved at the line's position by expandLine; patterns anchor to `dir`
 * when they contain a slash, otherwise match basenames at any depth.
 *
 * `macros` defaults to a fresh builtin-seeded registry, so a standalone
 * parse of one root file behaves like a whole-repo walk of that file.
 */
export function parseGitattributes(text: string, dir: string, macros: AttrMacros = createAttrMacros()): GitattributesRule[] {
  const dirPrefix = dir === "" ? "" : `${dir}/`;
  const lines = text.split("\n").map((rawLine) => rawLine.replace(/\r$/, ""));
  // Pass 1 — MACRO ATTRIBUTES (top-level files only; the definitions are in
  // place before pass 2 compiles anything, git's parse-then-resolve order).
  if (dir === "") {
    for (const line of lines) {
      if (!line.startsWith("[attr]")) continue;
      const definition = macroDefinition(line);
      if (definition === null) continue;
      macros.set(definition.name, definition.body);
    }
  }
  const rules: GitattributesRule[] = [];
  // Pass 2 — pattern lines (macro lines never compile a rule, in any file).
  for (const line of lines) {
    if (line === "" || line.startsWith("#") || line.startsWith("!") || line.startsWith("[attr]")) continue;
    const fields = splitAttrFields(line);
    const pattern = fields[0];
    if (pattern === undefined) continue;
    let dirOnly = false;
    let body = pattern;
    if (body.endsWith("/")) {
      dirOnly = true;
      body = body.slice(0, -1);
    }
    const basenameOnly = !body.includes("/");
    if (body.startsWith("/")) body = body.slice(1);
    if (body === "") continue;
    let compiled: GitattributesRule;
    try {
      compiled = compilePattern(basenameOnly ? body : dirPrefix + body, dirOnly, basenameOnly);
    } catch {
      continue; // an uncompilable pattern matches nothing, like git's skip
    }
    const rule: GitattributesRule = { re: compiled.re, dirOnly: compiled.dirOnly, basenameOnly: compiled.basenameOnly };
    const expanded = expandLine(fields.slice(1), macros);
    if (expanded.exportIgnore !== undefined) rule.exportIgnore = expanded.exportIgnore;
    if (expanded.exportSubst !== undefined) rule.exportSubst = expanded.exportSubst;
    if (rule.exportIgnore !== undefined || rule.exportSubst !== undefined) rules.push(rule);
  }
  return rules;
}
