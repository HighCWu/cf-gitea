/**
 * Declared compatibility rules for the differential test harness.
 *
 * The harness's contract (docs/design/m3-design-inputs.md Round-8): "same
 * repo, same git CLI commands, vs a real Gitea instance; diffs must be
 * explainable by declared compatibility rules". This module is the registry
 * of those declared rules: every field where two endpoint reports may
 * legitimately diverge must be covered by a rule here — anything else is
 * UNEXPLAINED and fails `--compare`.
 *
 * It also holds the shallow-family acceptance predicate: a `--shallow-since`/
 * `--shallow-exclude` request must end in a correct shallow result OR a clean
 * protocol failure — never a silent full clone (the P0 bug class of
 * docs/design/p0-evidence.md).
 */

/** Remote-error markers that make a git failure "clean" (git CLI recognized
 *  a server-side protocol rejection — gate G2 in docs/design/p0-evidence.md).
 *  The localized form is what stock git prints under a zh locale. */
export const REMOTE_ERROR_RE = /remote error|远程错误|upload-pack|receive-pack/i;

/**
 * Evaluate the shallow-family acceptance rule for a case record.
 *
 * `expected`: { commits, objects, shallowCommits } — the deterministic seed's
 * full-clone shape and the expected post-shallow commit count.
 *
 * Returns the outcome string; `silent-full-clone` is the never-acceptable
 * P0-class signature (exit 0, no shallow boundary, wrong semantics):
 *   - "shallow-ok":        exit 0, .git/shallow has boundaries, subset result
 *   - "clean-reject":      git exit != 0 with a remote protocol error
 *   - "silent-full-clone": exit 0 with NO shallow boundary (wrong semantics)
 *   - "fail":              anything else
 */
export function evaluateShallowAcceptance(record, expected) {
  const clone = record.commands.find((c) => (c.args ?? "").includes("clone"));
  const cloneExit = clone ? clone.exit : record.commands.at(-1)?.exit;
  if (record.commands.some((c) => c.timeout)) return "timeout";

  const shallowEmpty = !Array.isArray(record.shallow) || record.shallow.length === 0;
  if (cloneExit === 0) {
    if (shallowEmpty) return "silent-full-clone";
    // Shallow result: sanity-check it is actually a subset, not garbage.
    const subset = record.commit_count !== null && record.commit_count <= expected.shallowCommits
      && record.object_count !== null && record.object_count < expected.objects;
    return subset ? "shallow-ok" : "fail";
  }
  const tail = record.commands.map((c) => c.stderr_tail ?? "").join("\n");
  return REMOTE_ERROR_RE.test(tail) ? "clean-reject" : "fail";
}

/**
 * The registry. A rule covers { cases, fields } and carries:
 *  - rule: the declared compatibility rule text (cross-referenced to docs),
 *  - enforced: when true, EVERY side of a comparison must satisfy
 *    `acceptable(record)` or the comparison records a VIOLATION (even when
 *    the two sides agree with each other),
 *  - acceptable: the predicate both sides must satisfy for a divergence on
 *    the covered fields to be flagged "explained" instead of UNEXPLAINED.
 */
export const COMPARE_RULES = [
  {
    id: "deepen-family-transitional",
    cases: ["shallow-since", "shallow-exclude"],
    fields: ["outcome", "commands.exits", "checks", "refs_local", "refs_remote", "shallow", "object_count", "commit_count"],
    enforced: true,
    rule: "cf-gitea's deepen-since/deepen-not handling is in a documented transitional state " +
      "(P0 stopgap: docs/design/m3-design-inputs.md Rounds 7-9, docs/design/p0-evidence.md): " +
      "a clean protocol rejection is acceptable where a real Gitea shallow-clones. A silent " +
      "full clone (git exit 0, no shallow boundary) is NEVER acceptable on either side.",
    acceptable: (rec) => rec.outcome === "shallow-ok" || rec.outcome === "clean-reject",
  },
  {
    id: "head-default-branch-info",
    cases: "*",
    fields: ["head_ref"],
    enforced: false,
    rule: "The advertised HEAD/default branch depends on server configuration (Gitea's " +
      "default-branch setting vs the engine's first-pushed-branch adoption, SPEC-0003 §2.5.2). " +
      "Informational only — never a protocol divergence.",
    acceptable: () => true,
  },
  {
    id: "server-stderr-text",
    cases: "*",
    fields: ["stderr"],
    enforced: false,
    rule: "Server progress/error TEXT is recorded but never compared (locale and server-specific " +
      "wording differ by design); acceptance is the git CLI exit status plus repository state " +
      "(refs, .git/shallow, object counts) — docs/design/p0-evidence.md's probe pattern.",
    acceptable: () => true,
  },
];

/** Rules covering a given case id (the `cases: "*"` rules always apply). */
export function rulesForCase(caseId) {
  return COMPARE_RULES.filter((r) => r.cases === "*" || r.cases.includes(caseId));
}
