# P0 review package — deepen-family silent-drop fix

For the external reviewer, per rounds 7-9 of docs/design/m3-design-inputs.md.
Contents and where each piece of requested evidence lives:

| Requested deliverable | Location | Status |
|---|---|---|
| The P0 fix diff | `p0-diff-protocol.patch` (protocol.ts, 6c7ce18..102762a, +148/−100) | final for the parse-layer fix |
| Real git CLI exit states + .git/shallow results | `p0-evidence.md` § "final probes" (7-row table: --shallow-since/--shallow-exclude exit 128 clean rejects, --depth=1 boundary d7f2068…, --unshallow removes the file, deepen-relative probe) | local-verified; G1 16/16 parse checks |
| G3 cache-unreachability | p0-evidence.md G3 section + check-deepen-parse.mjs (poisoning combo asserted before currentPackKey) | verified |
| G4 combination safety | G4 section (discriminated DeepenRequest union, sticky unsupported, both orders) | verified |
| Production deployment + post-deploy probe | PENDING — deploys when the in-flight waves land (working tree intentionally not deployed mid-flight); probe command: `git clone --shallow-since=2026-10-20 <prod-url>/<user>/<repo>.git` expecting exit 128 + the documented error, never a silent full clone | queued |

Judgment requested (reviewer's framing): single-point fix or structural
elimination? Our claim: structural — the forbidden-pattern chain is cut at
parse (exhaustive phase-aware dispatch), at type (discriminated union),
and at control flow (cache predicate unreachable for badArgument) — see
m3-design-inputs.md rounds 8-9 for the invariants now in force.
