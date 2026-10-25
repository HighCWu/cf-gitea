/**
 * Protected-tag service (inventory batch 8) — the port of
 * gitea/models/git/protected_tag.go over the `protected_tags` table, consumed
 * by the API family (api/routes/tag-protections.ts), the API tag create/delete
 * arms (api/routes/tags.ts) and the pre-receive tag walk (git-http/gate.ts,
 * the evaluateBranchProtection tag arm).
 *
 * MODEL — one `protected_tags` row per rule (protected_tag.go:21-32): a repo
 * id, a name pattern, and TWO JSON-TEXT allowlists (user ids, team ids).
 * Unlike the branch family there is NO priority, NO config blob and NO unique
 * index — the create collision is the pre-check 403
 * "Tag protection already exist" (routers/api/v1/repo/tag.go:423-428).
 *
 * PATTERN MATCHING — EnsureCompiledPattern (protected_tag.go:36-45): a
 * pattern of length >= 2 wrapped in literal slashes is a REGEX
 * (`regexp.Compile(namePattern[1:len-1])`), matched UNANCHORED
 * (`RegexPattern.MatchString`, :51-53 — a substring match, unlike the branch
 * family's always-anchored globs); anything else is a GLOB compiled WITHOUT
 * separators (`glob.Compile(pt.NamePattern)`, :48 — so `*` matches any
 * character INCLUDING `/`, which tag names may carry, modules/glob/glob.go
 * initGlobCompiler: `nonSeparatorChars` is `.` when no separators are given)
 * and fully anchored (`^…$`, glob.go:173-176). COMPILE ERRORS PROPAGATE: the
 * port throws where the branch-protection glob falls back to a quoted literal
 * (protected_branch.go:108-111) — protected_tag.go has no fallback arm, the
 * error bubbles out of EnsureCompiledPattern, and upstream's pre-receive walk
 * fails the whole push with it (hook_pre_receive.go:325-328 "unable to check
 * allowed tags"). Invalid stored patterns therefore fail CLOSED here too.
 * Documented dialect divergence: the regex arm compiles with the JS RegExp
 * engine where Go uses RE2 (e.g. RE2 has no backreferences, `\C`, or
 * lookahead beyond the RE2-subset Go enables — Go RE2 in fact rejects
 * lookaheads entirely); the common syntax compiles identically in both.
 *
 * ALLOWLIST DECISION — IsUserAllowedToControlTag (protected_tag.go:126-149):
 * allowed unless a matching rule DENIES the user AND no matching rule allows
 * them (the loop starts `isAllowed = true`, walks every rule, on a match
 * re-evaluates and BREAKS only on allow — so a later matching rule that
 * allows the user rescues an earlier deny). IsUserAllowedModifyTag
 * (:100-112): the user id in AllowlistUserIDs, else team membership
 * (organization.IsUserInTeams — the branch-protection service's
 * isUserInTeams port is reused verbatim).
 *
 * NO SANITIZATION (the deliberate divergence from the branch family): the
 * upstream tag handlers resolve names through GetDoerUserIDsByNames
 * (user.go:1237-1239 — EXISTENCE only, and allowSystemDoer=false so the
 * system pseudo-users do not resolve here, unlike the branch family's
 * WithSystem variant) and store the ids verbatim — protected_tag.go has no
 * whitelist sanitizer. The render filters for display only (convert.go
 * ToTagProtection:1016-1039); this port renders ids→names with vanished
 * principals omitted (the branch family's documented render nuance).
 */

import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { isUserInTeams } from "./branch-protection";
import { protectedTags } from "../db/schema";

/** D1 row of `protected_tags` (src/db/schema.ts). */
export type ProtectedTagRow = typeof protectedTags.$inferSelect;

// ---------------------------------------------------------------------------
// The allowlist JSON columns (`xorm:"JSON TEXT"` — Go unmarshal zero-fills a
// corrupt cell to the empty slice; the decode is tolerant to match).
// ---------------------------------------------------------------------------

export function parseAllowlistIds(json: string): number[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  return Array.isArray(raw) ? raw.filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id)) : [];
}

export function serializeAllowlistIds(ids: readonly number[]): string {
  return JSON.stringify([...ids]);
}

// ---------------------------------------------------------------------------
// The pattern compiler (EnsureCompiledPattern, protected_tag.go:36-45 + the
// modules/glob walk — the NO-separator variant; errors propagate, see the
// module header).
// ---------------------------------------------------------------------------

/**
 * compileChars (glob.go) — one `[...]` class; `!` inverts, `\` escapes,
 * `[]`/`[^]` and an unterminated class throw (Go's regexp.Compile rejects
 * them downstream, so EnsureCompiledPattern errors).
 */
function compileChars(pattern: string[], pos: number, out: string[]): number {
  out.push("[");
  if (pos < pattern.length && pattern[pos] === "!") {
    pos += 1;
    out.push("^");
  }
  while (pos < pattern.length) {
    const c = pattern[pos]!;
    pos += 1;
    if (c === "]") {
      if (out[out.length - 1] === "[" || out[out.length - 1] === "^") {
        throw new Error("empty character class");
      }
      out.push("]");
      return pos;
    }
    if (c === "\\") {
      if (pos >= pattern.length) {
        throw new Error("unterminated character class escape");
      }
      out.push("\\", pattern[pos]!);
      pos += 1;
    } else {
      out.push(c);
    }
  }
  throw new Error("unterminated character class");
}

/**
 * The glob.go `compile` walk with separators = [] — `nonSeparatorChars` is
 * `.` (initGlobCompiler), so `*`/`?` match ANY character (tag names carry
 * `/`), `**` folds to the same `.*`, `{a,b}` alternates, `,` is literal
 * outside alternation, regex metacharacters are escaped, the result is
 * anchored `^…$` (glob.go:173-176). Throws on the invalid shapes Go's
 * regexp.Compile rejects (which is EnsureCompiledPattern's error path).
 */
function compileTagGlob(pattern: string[]): string {
  const out: string[] = ["^"];
  const walk = (pos: number, subPattern: boolean): number => {
    while (pos < pattern.length) {
      const c = pattern[pos]!;
      pos += 1;
      if (subPattern && c === "}") {
        out.push(")");
        return pos;
      }
      switch (c) {
        case "*":
          if (pos < pattern.length && pattern[pos] === "*") {
            pos += 1;
            out.push(".*");
          } else {
            out.push(".", "*");
          }
          break;
        case "?":
          out.push(".");
          break;
        case "+":
          out.push("\\+");
          break;
        case "[":
          pos = compileChars(pattern, pos, out);
          break;
        case "{":
          out.push("(");
          pos = walk(pos, true);
          break;
        case ",":
          out.push(subPattern ? "|" : ",");
          break;
        case "\\":
          if (pos >= pattern.length) {
            throw new Error("no character to escape");
          }
          out.push("\\", pattern[pos]!);
          pos += 1;
          break;
        case ".":
        case "^":
        case "$":
        case "(":
        case ")":
        case "|":
          out.push("\\", c);
          break;
        default:
          out.push(c);
      }
    }
    if (subPattern) {
      throw new Error("unterminated alternation");
    }
    return pos;
  };
  walk(0, false);
  out.push("$");
  return out.join("");
}

/**
 * EnsureCompiledPattern's compiled form: the regex the tag name tests
 * against. The GLOB arm is fully anchored; the REGEX arm is NOT (upstream's
 * MatchString is a substring match, protected_tag.go:51-53). Throws on an
 * invalid pattern of either arm — the caller decides the failure shape (the
 * API family never compiles at save time — upstream validates nothing on
 * create/edit — while the enforcement arms fail closed).
 */
export function compileTagPattern(namePattern: string): RegExp {
  if (namePattern.length >= 2 && namePattern.startsWith("/") && namePattern.endsWith("/")) {
    // regexp.Compile(namePattern[1 : len-1]) — unanchored MatchString.
    return new RegExp(namePattern.slice(1, -1));
  }
  return new RegExp(compileTagGlob([...namePattern]));
}

// ---------------------------------------------------------------------------
// The allowlist decision (protected_tag.go:100-112 + :126-149).
// ---------------------------------------------------------------------------

/** IsUserAllowedModifyTag (:100-112) — user id hit, else team membership. */
export async function isUserAllowedModifyTag(d1: D1Database, tag: ProtectedTagRow, userId: number): Promise<boolean> {
  if (parseAllowlistIds(tag.allowlistUserIds).includes(userId)) {
    return true;
  }
  const teamIds = parseAllowlistIds(tag.allowlistTeamIds);
  if (teamIds.length === 0) {
    return false;
  }
  return isUserInTeams(d1, userId, teamIds);
}

/**
 * IsUserAllowedToControlTag (:126-149) — TRUE when no pattern matches the
 * tag name, or some matching rule allows the user (the loop's break-on-allow:
 * a later allowing rule rescues an earlier denying one). Compile errors
 * PROPAGATE (upstream returns the err; the pre-receive walk fails the push —
 * fail closed, see the module header). `tags` is one repo's rule list —
 * load once per request/push with listProtectedTags.
 */
export async function isTagControlAllowed(d1: D1Database, tags: readonly ProtectedTagRow[], tagName: string, userId: number): Promise<boolean> {
  let allowed = true;
  for (const tag of tags) {
    let regexp: RegExp;
    try {
      regexp = compileTagPattern(tag.namePattern);
    } catch (error) {
      // EnsureCompiledPattern's error path — annotated with the pattern for
      // the fail-closed 500 the enforcement arms turn this into.
      throw new Error(
        `invalid protected tag pattern ${JSON.stringify(tag.namePattern)}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!regexp.test(tagName)) {
      continue;
    }
    allowed = await isUserAllowedModifyTag(d1, tag, userId);
    if (allowed) {
      break;
    }
  }
  return allowed;
}

// ---------------------------------------------------------------------------
// Row loading (protected_tag.go:114-124) — the writes stay at the route layer
// (the branch-protections family's split).
// ---------------------------------------------------------------------------

/** GetProtectedTags (:117-121) — every rule of the repo, id order (upstream's
 *  Find is unordered; id order is the insertion order the renders echo). */
export async function listProtectedTags(d1: D1Database, repoId: string): Promise<ProtectedTagRow[]> {
  return drizzle(d1)
    .select()
    .from(protectedTags)
    .where(eq(protectedTags.repoId, repoId))
    .orderBy(asc(protectedTags.id))
    .all();
}

/** GetProtectedTagByID (:106-115) — by primary key alone; the caller owns the
 *  repoId guard (upstream's handlers compare pt.RepoID after the read). */
export async function findProtectedTagById(d1: D1Database, id: number): Promise<ProtectedTagRow | null> {
  const rows = await drizzle(d1).select().from(protectedTags).where(eq(protectedTags.id, id)).limit(1).all();
  return rows[0] ?? null;
}

/** GetProtectedTagByNamePattern (:107-110 area, builder.Eq{name_pattern,
 * repo_id}) — the create-collision pre-check's EXACT-pattern lookup. */
export async function findProtectedTagByNamePattern(d1: D1Database, repoId: string, namePattern: string): Promise<ProtectedTagRow | null> {
  const rows = await drizzle(d1)
    .select()
    .from(protectedTags)
    .where(and(eq(protectedTags.repoId, repoId), eq(protectedTags.namePattern, namePattern)))
    .limit(1)
    .all();
  return rows[0] ?? null;
}
