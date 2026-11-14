/**
 * CODEOWNERS — the parser, owner resolution and rule matcher behind the
 * `block_on_codeowner_reviews` merge gate (census B-53; SPEC-0013 §6's
 * re-opened deferral). This is the port of the surface upstream spreads over
 * two files:
 *
 *   - the FILE side (gitea/services/issue/pull.go:47-110): the candidate
 *     paths (`codeOwnerFiles` :47 — `CODEOWNERS`, `docs/CODEOWNERS`,
 *     `.gitea/CODEOWNERS`, the same precedence order), read at the BASE
 *     branch tip of the PR's base repo (`getCodeOwnerRules` :53-110); a fork
 *     base repo yields NO rules (:62-64); a blob over
 *     `setting.UI.MaxDisplayFileSize` (default 8388608,
 *     modules/setting/ui.go:98) errors so the gate FAILS CLOSED — a
 *     truncated CODEOWNERS must never silently drop rules (:75-79 comment);
 *     the read walks the candidates and any miss/read error moves to the
 *     next candidate (:82-85 `continue`).
 *   - the SYNTAX side (gitea/models/issues/pull.go:828-981): the tokenizer,
 *     the line parser and the content parser, ported verbatim including the
 *     exact warning texts ("We're trying to do the best we can when parsing
 *     a file. Invalid lines are skipped. Non-existent users and teams too."
 *     — :827-828).
 *
 * THE PATTERN LANGUAGE IS REGEX, NOT GLOB. Upstream compiles the token into
 * `^pattern$` with regexp2 (the .NET engine — `docs/(aws|google|azure)/
 * [^/]*\.(md|txt)` and `!/assets/.*\.(bin|exe|msi)` are upstream's own test
 * patterns, models/issues/pull_test.go). JS RegExp is the same engine family
 * (lookahead/lookbehind/atomic groups all port), so the pattern compiles
 * here unchanged; a compile error drops the line through the same
 * "incorrect codeowner regexp" warning upstream emits.
 *
 * MATCH-TIME SAFETY — the one recorded platform adaptation (the module's
 * reason to exist beside the gate). Upstream bounds every match at 150ms
 * (`codeOwnerMatchTimeout` :866-871) so a crafted pattern cannot stall PR
 * processing via catastrophic backtracking; workerd exposes no interruption
 * for a running RegExp, and the V8 probe of upstream's own timeout test
 * pattern (`(a+)+` against `"a".repeat(30) + "X"`) burned minutes of wall
 * time. The port therefore SCREENS the pattern source statically for the
 * exponential shapes (patternExceedsMatchSafetyBound below) and drops such
 * rules through the SAME compile-error wrapper upstream uses — per-pattern
 * failure is fail-open upstream too (a MatchString timeout "can be
 * considered as not matched", services/issue/pull.go:138), so the drop is
 * the same polarity; the AGGREGATE 2s wall budget over the rules×files loop
 * (codeOwnerMatchBudget, services/issue/pull.go:52-54) ports exactly and
 * stays the fail-closed bound (matchCodeOwnerRules' `complete` flag — the
 * gate refuses merges on a truncated match, :171-175).
 *
 * OWNER RESOLUTION (ParseCodeOwnersLine :876-962): `@user` resolves through
 * GetUserByName (user.go:1116-1129 — `lower_name = ToLower(name)`,
 * TYPE-BLIND, so an org name resolves as a "user" owner exactly like
 * upstream); `@org/team` is the only shape allowed a `/` and must split
 * exactly two segments — the org through GetOrgByName (org.go:401-417,
 * lower_name + type=organization), the team by DISPLAY-CASE `team.Name ==
 * teamName` over the org's teams (a missing team name is silently skipped —
 * only the LoadTeams ERROR arm warns "incorrect codeowner team", :922-934).
 * A rule whose owners all fail to resolve is dropped ("no users/groups
 * matched"). Consumers: checkPullBranchProtections (branch-protection.ts) —
 * the merge-gate wiring — and pull-engine.ts's merge-time git collection
 * (pullGateGitInputs).
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { teams, users } from "../db/schema";

// ---------------------------------------------------------------------------
// The file side (services/issue/pull.go:47-110).
// ---------------------------------------------------------------------------

/** `codeOwnerFiles` (:47-49) — the candidate paths in precedence order. */
export const CODEOWNERS_FILES: readonly string[] = ["CODEOWNERS", "docs/CODEOWNERS", ".gitea/CODEOWNERS"];

/** `IsCodeOwnerFile` (:51-53) — the push/web-side membership probe. */
export function isCodeOwnerFile(f: string): boolean {
  return CODEOWNERS_FILES.includes(f);
}

/** `setting.UI.MaxDisplayFileSize`'s default (modules/setting/ui.go:98) —
 *  the over-size blob fails the gate closed (:75-79). */
export const MAX_CODEOWNERS_BYTES = 8388608;

/**
 * The discovery read (:69-100): the candidates in order against one ref
 * (the base branch tip — the caller resolves it, so a missing tip answers
 * `null` at the caller). The first blob FOUND wins; a miss or read error
 * (`null` — the engine's safe wrapper folds both, matching upstream's
 * any-error `continue` at :82-85) moves to the next candidate; an over-size
 * blob answers `null` — FAIL CLOSED, a truncated CODEOWNERS must never
 * silently drop rules (:76-79). Empty content ("no code owner file = no one
 * to approve", :97-100) and a zero-rule parse (:103-106) answer `[]`.
 * Parse warnings log per upstream's log.Warn (:101-102).
 */
export async function discoverCodeOwnerRules(
  d1: D1Database,
  readBlob: (path: string) => Promise<{ data: Uint8Array } | null>,
): Promise<CodeOwnerRule[] | null> {
  for (const file of CODEOWNERS_FILES) {
    let blob: { data: Uint8Array } | null;
    try {
      blob = await readBlob(file);
    } catch {
      blob = null; // :82-85 — any read error tries the next candidate
    }
    if (blob === null) continue;
    if (blob.data.byteLength > MAX_CODEOWNERS_BYTES) {
      return null; // :75-79 — fail closed rather than evaluate an incomplete file
    }
    const content = new TextDecoder().decode(blob.data);
    // :97-100 — an empty file is "no code owner file" (a MISS, not an error)
    if (content.length === 0) break;
    const { rules, warnings } = await parseCodeOwners(d1, content);
    for (const w of warnings) {
      console.error(`[codeowners] CODEOWNERS parsing: ${w}`);
    }
    return rules; // :103-106 — a zero-rule parse is still a found file → []
  }
  return []; // no candidate exists — no rules, never an error
}

// ---------------------------------------------------------------------------
// The syntax side (models/issues/pull.go:828-981).
// ---------------------------------------------------------------------------

/** `CodeOwnerRule` (:869-874) — the compiled matcher plus its resolved
 *  owners (user rows via GetUserByName; team rows via the org's LoadTeams
 *  display-name match). */
export interface CodeOwnerRule {
  regexp: RegExp;
  /** `Negative` (:873) — `!`-prefixed patterns invert the match. */
  negative: boolean;
  /** The pattern token after escape resolution (diagnostics only). */
  pattern: string;
  /** `Users` — resolved owner rows ({id, login} — the gate needs ids;
   *  login carries the warning-free identity for debugging). */
  users: { id: number; login: string }[];
  /** `Teams` — resolved org-team rows ({id, name}). */
  teams: { id: number; name: string }[];
}

/**
 * `TokenizeCodeOwnersLine` (:947-982): trim, tabs become spaces, `\`
 * escapes the NEXT character verbatim (so `\\.` tokenizes to `\.`, `\ ` to
 * a space, `\#` to `#` without starting a comment — pull_test.go's
 * testParseCodeOwnersLine table), `#` starts a comment (bare — an escaped
 * one never reaches here), spaces split tokens.
 */
export function tokenizeCodeOwnersLine(line: string): string[] {
  if (line.length === 0) return [];
  line = line.trim();
  line = line.replaceAll("\t", " ");
  const tokens: string[] = [];
  let escape = false;
  let token = "";
  for (const char of line) {
    if (escape) {
      token += char;
      escape = false;
    } else if (char === "\\") {
      escape = true;
    } else if (char === "#") {
      break;
    } else if (char === " ") {
      if (token.length > 0) {
        tokens.push(token);
        token = "";
      }
    } else {
      token += char;
    }
  }
  if (token.length > 0) tokens.push(token);
  return tokens;
}

/**
 * The match-time safety screen (the module-header adaptation): true when the
 * pattern source carries an exponential-backtracking shape JS has no
 * per-match timeout to survive — an unbounded quantifier (`*`, `+`,
 * `{n,}`) applied to a group whose body contains an unbounded quantifier
 * anywhere (the `(a+)+` family), or a backreference under any unbounded
 * quantifier (`(a)\1*`). Character classes `[...]` are skipped (quantifier
 * characters inside are literals), escapes are honored, groups nest with a
 * stack and mark every enclosing group (an enclosing group's body contains
 * everything its nested groups contain). Over-flagging drops a rare
 * legitimate pattern through the compile-error wrapper — the same fail-open
 * direction upstream's per-match timeout takes for THAT pattern only.
 */
function patternExceedsMatchSafetyBound(pattern: string): boolean {
  const stack: { unboundedInside: boolean }[] = [];
  let inClass = false;
  let hasBackref = false;
  let unboundedAnywhere = false;
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    i += 1;
    if (char === "\\") {
      if (i < pattern.length) {
        const escaped = pattern[i]!;
        i += 1;
        // Numeric backrefs (\1..\9) and \k<name>
        if ((escaped >= "1" && escaped <= "9") || escaped === "k") hasBackref = true;
      }
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") {
      inClass = true;
      continue;
    }
    if (char === "(") {
      stack.push({ unboundedInside: false });
      continue;
    }
    if (char === ")") {
      const group = stack.pop();
      if (group !== undefined && quantifierAt(pattern, i).unbounded && group.unboundedInside) {
        return true;
      }
      continue;
    }
    if (char === "*" || char === "+") {
      unboundedAnywhere = true;
      for (const frame of stack) frame.unboundedInside = true;
      continue;
    }
    if (char === "{") {
      // JS quantifier grammar (non-unicode mode): `{n}`, `{n,}`, `{n,m}` —
      // anything else is a LITERAL brace, never skipped as one (a literal
      // `}` may sit inside a class or group ahead of us).
      let j = i;
      while (j < pattern.length && (/\d/.test(pattern[j]!) || pattern[j] === ",")) j += 1;
      if (j > i && pattern[j] === "}") {
        if (/^\d+,$/.test(pattern.slice(i, j))) {
          unboundedAnywhere = true;
          for (const frame of stack) frame.unboundedInside = true;
        }
        i = j + 1;
      }
      continue;
    }
  }
  return hasBackref && unboundedAnywhere;
}

/** The quantifier starting at `pos` (right after a `)`), with its bound. */
function quantifierAt(pattern: string, pos: number): { unbounded: boolean } {
  const char = pattern[pos];
  if (char === "*" || char === "+") return { unbounded: true };
  if (char === "{") {
    let j = pos + 1;
    while (j < pattern.length && (/\d/.test(pattern[j]!) || pattern[j] === ",")) j += 1;
    if (j > pos + 1 && pattern[j] === "}" && /^\d+,$/.test(pattern.slice(pos + 1, j))) {
      return { unbounded: true };
    }
  }
  return { unbounded: false };
}

/**
 * Compile one CODEOWNERS pattern the way upstream's
 * `regexp2.Compile("^"+pattern+"$", regexp2.None)` accepts it
 * (models/issues/pull.go:891-892). regexp2 is the .NET family, whose accepted
 * language no single JS grammar covers, so the compile tries two:
 *
 *   1. UNICODE mode (`u`) first — the only JS grammar where `\p{...}` /
 *      `\P{...}` are property classes (regexp2 accepts them natively) and
 *      where matching runs over code points (Go strings; an astral path
 *      character is ONE character to upstream). Without the flag `\p{Lu}`
 *      compiles as the literal text `p{Lu}`: a rule that parses, resolves its
 *      owners, and can never match a real path — a silently inert rule
 *      (census B-53 remainder (4)).
 *   2. Annex B (no flag) as the FALLBACK — unicode mode rejects shapes .NET
 *      accepts: an identity escape of a non-syntax character outside a class
 *      (`foo\-bar`), a brace that is not a quantifier (`a{b`). Those keep
 *      exactly the pre-existing compile, so no pattern that matched before
 *      this arm landed stops matching.
 *
 * A pattern both grammars reject throws the ANNEX B error — the warning text
 * the caller renders stays byte-identical to the single-compile era (the
 * unicode-mode message carries a `/u` suffix).
 *
 * The match-time safety screen runs BEFORE this (a static scan of the
 * pattern text) and is grammar-independent: the exponential shapes it drops
 * are equally exponential under either flag, and a property class adds no
 * backtracking power — `(\p{L}+)+` trips the nested-unbounded check exactly
 * like `(a+)+`.
 */
function compileCodeOwnerPattern(pattern: string): RegExp {
  const expr = `^${pattern}$`;
  try {
    return new RegExp(expr, "u");
  } catch {
    return new RegExp(expr);
  }
}

/**
 * `ParseCodeOwnersLine` (:876-962): the first token is the pattern —
 * `Negative` from a leading `!` (:880), the `!` then a leading `/` stripped
 * (:888-895 — git paths are relative, the anchors make the `/` redundant),
 * compiled as `^pattern$`. Owners: `@user` (GetUserByName — the
 * lower_name TYPE-BLIND probe) and `@org/team` (exactly two segments;
 * GetOrgByName then the display-case name match over the org's teams — a
 * missing team name is silently skipped, only a team LOAD error warns).
 * Unresolved owners warn; a rule with zero resolved owners drops.
 */
export async function parseCodeOwnersLine(
  d1: D1Database,
  tokens: string[],
): Promise<{ rule: CodeOwnerRule | null; warnings: string[] }> {
  const warnings: string[] = [];
  const negative = tokens[0]!.startsWith("!");

  let pattern = tokens[0]!;
  if (pattern.startsWith("!")) pattern = pattern.slice(1);
  if (pattern.startsWith("/")) pattern = pattern.slice(1);

  if (patternExceedsMatchSafetyBound(pattern)) {
    warnings.push(
      `incorrect codeowner regexp: pattern exceeds the match-time safety bound (nested unbounded quantifier or quantified backreference — workerd has no MatchTimeout to bound it)`,
    );
    return { rule: null, warnings };
  }

  let regexp: RegExp;
  try {
    regexp = compileCodeOwnerPattern(pattern);
  } catch (error) {
    warnings.push(`incorrect codeowner regexp: ${error instanceof Error ? error.message : String(error)}`);
    return { rule: null, warnings };
  }

  const rule: CodeOwnerRule = { regexp, negative, pattern, users: [], teams: [] };

  for (const token of tokens.slice(1)) {
    const name = token.startsWith("@") ? token.slice(1) : token;
    if (name.includes("/")) {
      const segments = name.split("/");
      if (segments.length !== 2) {
        warnings.push("incorrect codeowner group: " + name);
        continue;
      }
      const [orgName, teamName] = segments as [string, string];
      // GetOrgByName (:913-921) — lower_name, type=organization.
      const orgRows = await drizzle(d1)
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.usernameLower, orgName.toLowerCase()), eq(users.type, "org")))
        .all();
      const org = orgRows[0];
      if (org === undefined) {
        warnings.push("incorrect codeowner organization: " + name);
        continue;
      }
      // LoadTeams + the display-case filter (:923-934) — the miss is SILENT
      // (only the load error warns, :927-930).
      const orgTeams = await drizzle(d1)
        .select({ id: teams.id, name: teams.name })
        .from(teams)
        .where(eq(teams.orgId, org.id))
        .all();
      for (const team of orgTeams) {
        if (team.name === teamName) rule.teams.push(team);
      }
    } else {
      // GetUserByName (:935-944) — lower_name, ANY user type (an org name
      // resolves as a "user" owner exactly like upstream).
      const userRows = await drizzle(d1)
        .select({ id: users.id, login: users.username })
        .from(users)
        .where(eq(users.usernameLower, name.toLowerCase()))
        .all();
      const user = userRows[0];
      if (user === undefined) {
        warnings.push("incorrect codeowner user: " + name);
        continue;
      }
      rule.users.push(user);
    }
  }

  if (rule.users.length === 0 && rule.teams.length === 0) {
    warnings.push("no users/groups matched");
    return { rule: null, warnings };
  }

  return { rule, warnings };
}

/**
 * `GetCodeOwnersFromContent` (:833-864): empty content → no rules; per
 * line — zero tokens skip, `<2` tokens warn "incorrect format", the parsed
 * rule's warnings prefix with the line number (1-based), a dropped line
 * skips. Best-effort throughout: invalid lines and non-existent users and
 * teams never fail the parse.
 */
export async function parseCodeOwners(d1: D1Database, content: string): Promise<{ rules: CodeOwnerRule[]; warnings: string[] }> {
  if (content.length === 0) return { rules: [], warnings: [] };
  const rules: CodeOwnerRule[] = [];
  const warnings: string[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const tokens = tokenizeCodeOwnersLine(lines[i]!);
    if (tokens.length === 0) {
      continue;
    } else if (tokens.length < 2) {
      warnings.push(`Line: ${i + 1}: incorrect format`);
      continue;
    }
    const { rule, warnings: lineWarnings } = await parseCodeOwnersLine(d1, tokens);
    for (const w of lineWarnings) {
      warnings.push(`Line: ${i + 1}: ${w}`);
    }
    if (rule === null) continue;
    rules.push(rule);
  }
  return { rules, warnings };
}

/**
 * The rules×files matcher (`getMatchingCodeOwnerRules`' loop,
 * services/issue/pull.go:125-145): per rule, the FIRST changed file whose
 * match flips the negative predicate (`matched != rule.Negative`, :137)
 * selects the rule; a match error counts as not-matched (:138). The
 * aggregate 2s wall budget (`codeOwnerMatchBudget` :52-54) truncates the
 * loop with `complete: false` — the CALLER fails closed on a truncated
 * match (:171-175), so a budget-starved gate can never under-enforce.
 */
export function matchCodeOwnerRules(
  rules: readonly CodeOwnerRule[],
  changedFiles: readonly string[],
  budgetMs = 2000,
): { matching: CodeOwnerRule[]; complete: boolean } {
  const deadline = Date.now() + budgetMs;
  const matching: CodeOwnerRule[] = [];
  let complete = true;
  ruleLoop: for (const rule of rules) {
    for (const file of changedFiles) {
      if (Date.now() > deadline) {
        console.error(`[codeowners] CODEOWNERS matching exceeded its time budget; some rules were not evaluated`);
        complete = false;
        break ruleLoop;
      }
      let matched: boolean;
      try {
        matched = rule.regexp.test(file);
      } catch {
        matched = false; // :138 — any error can be considered as not matched
      }
      if (matched !== rule.negative) {
        matching.push(rule);
        break;
      }
    }
  }
  return { matching, complete };
}
