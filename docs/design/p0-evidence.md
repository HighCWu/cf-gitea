# P0 evidence file — deepen-family silent-drop bug

Bug (confirmed by code read, protocol.ts parseUploadRequest pre-fix): only
`deepen <n>` parsed; `deepen-since`/`deepen-not`/`deepen-relative` fell
through the else-if chain and were silently dropped while `shallow` was
advertised → `--shallow-since` received a silent full clone (valid pack,
valid checksum, wrong semantics; cache predicate satisfied).

## Empirical status (2026-10-24 ~20:40, local dev server on the WORKING
TREE — i.e., the engine wave's preserved partials, NOT the committed tree)

The in-flight engine partials ALREADY implement the P0 reject path. Probes
against `demo/p0-before` (3 commits dated 10-19/10-20/10-21):

| Probe | Result |
|---|---|
| `git clone --shallow-since="2026-10-20…"` | **clean protocol error** — `fatal: 远程错误: upload-pack: unsupported fetch argument 'deepen-since' (only depth-limited shallow fetches are supported)`; no repo dir; git exit fatal ✓ G2 |
| `git clone --shallow-exclude=refs/heads/nonexist` | **clean protocol error** (`'deepen-not'`), same shape ✓ |
| `git clone --depth=1` | **correct shallow clone** — `.git/shallow` contains the boundary commit `d7f2068…`; no regression on the supported path ✓ |

## Still pending for G1-G5 (resume wave's landing gates)

- G1 completeness: `deepen-relative` probe not yet run; parser coverage of
  every phase asserted by tests (the partial `e2e/check-deepen-parse.mjs`
  exists — read and complete it).
- G3 cache unreachability assertion (rejected params never reach
  currentPackKey) — unit test pending.
- G4 combination safety (deepen + deepen-since etc. — discriminated union
  or explicit conflict rejection) — code read pending.
- Suite/e2e: full vitest + e2e 32/35 allowlist on the completed tree.
- Production deploy + post-deploy `--shallow-since` probe against
  https://cf-gitea.hecongw.workers.dev.

Reviewer package (per the external review's request): P0 diff + these
probe outputs + post-deploy CLI exit states + `.git/shallow` results.
