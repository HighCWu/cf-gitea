# cf-gitea v1.5.5 — Release Notes (the review-sweep convergence wave)

**Range**: RANGE=`4a5c91e..99658fe` — **COMMIT_COUNT=13** commits, landed
across 2026-11-03's afternoon — the six-unit review sweep and its eleven-unit
fix wave. Deployed as **`DEPLOY_ID=da7e423b`** (version
`da7e423b-3a57-40cb-a421-3a474357d315`). Probe battery **253 planned all
green — 244 first-pass + the one re-baselined truth; 6 warns** (the
documented token-unconfigured classes). The full-suite composite gate
accepted green-with-adjudication on its first round: 476 files, 474 pass,
ZERO assertion failures, two hook-timeout flakes solo-exonerated 99/99, and
the `87621de` teardown known class. **No migrations.**

The wave's shape: **an adversarial re-derivation sweep over the six most
churned surfaces, then every finding landed.** Six review units (R1-R6)
returned **55 findings** (1 P1, 9 MEDIUM, the rest LOW/INFO) — every one
relay-verbatim with both-side cites; eleven fix units (FA-FK + FC + FI)
landed **53 of them**, with two recorded (the schedule dedupe needs a
migration grant; one viewer-gate residue was folded by its sibling). Three
more review-flagged bugs were caught by the fixers themselves mid-flight.

## 1. The user-visible headlines

- **Workflow disable actually disables** (the P1): the id space was split —
  the producers keyed full repo paths while every consumer keyed bare
  names, so a UI-disabled workflow kept running on every push and tick, the
  required-refusal never fired, and the runs page accumulated unlisted
  entries. One space now (FA `3e8de7c`), with the settings-page flag proven
  end-to-end.
- **git-credential-oauth works** (FJ `804e21c`): the OAuth2 JWT stored as a
  Basic password (the git-credential-oauth/GCM standard shape) never
  authenticated on the API — the dispatch was Bearer-only. Upstream's
  `VerifyAuthToken` order restored.
- **userinfo accepts PATs** with `read:user` (the SPEC's three misread
  records corrected with it).
- **The auto-merge race closed** (FD `28cccf9`): a push between the
  scheduled check and the consumer's merge previously landed an UNCHECKED
  head; the consumer now re-reads the head ref and skips off-sha
  (upstream's `ErrSHADoesNotMatch` posture). The >50-schedule starvation is
  gone (keyset-paged producer).
- **"Draft:" PRs merge** — our WIP prefix set carried two prefixes upstream
  never had; `repository.go:199`'s two restored.
- **LFS hardening** (FG `e9cd555`): the API `/media` gains upstream's
  >1024-byte short-circuit (a crafted pointer-prefixed blob no longer
  resolves); the wiki/cargo hidden cells' priv invariant holds on the WRITE
  path; BOM'd pointers are not pointers; presigned URLs carry the filename.
- **Audit fidelity** (FJ): the calling credential on every actions/oauth2
  audit row (three wrong-stamp shapes fixed, including a NAME in the
  credential column), the real token name on removal, the impersonator on
  the PAT pair.
- **Go-exact URLs and IPs**: two char-class ports **derived empirically
  against the local Go 1.25.1 stdlib** (byte-probe truth tables) —
  PathEscape/PathEscapeSegments across the release URLs and the repo-wide
  page escaper (FH `c2056f3` + FK), and ParseIP's loopback verdicts.
- **Counts privacy** (FK+FI): org-project counts now respect the viewer's
  visible-repo set (upstream's permission-filtered counter), activated at
  all ten render call sites.

## 2. The sweep's verified-clean surface

Each review unit's report carried its adversarially-verified clean list —
the ⑭ lifecycle thread statement-for-statement, the workflow notifier's
order/snapshot/re-entrancy, the scoped-workflow store trio, the resolve
chain's complete consumer map, the mail family's byte-matched templates,
the cron census's dual registries, the secrets-hygiene zero-regression
sweep. These arms are now pin-protected in both directions.

## 3. Gate and probe evidence

Gate R1: 474/476, zero asserts, two solo-exonerated timeouts, one known
teardown class — accepted per the standing precedent. Build: the drizzle
single-chunk pin verified. Deploy: `da7e423b`, no migrations (schema
unchanged since `0061`). Probes: 244/253 first-pass green; the six warns
are the documented unconfigured-token classes; ONE probe failure was the
sweep's own vindication — `oauth2-userinfo` still expected the 401 the R3
review proved was a misread; the probe re-baselined to FJ's as-built (the
PAT 200s with the same OIDC shape, `oauth2.go:146-165`), re-run green.
PAT posture held: mint → battery → row deleted (changes: 1, table 0,
files shredded).

## 4. The recorded remainders

The schedule-dedup CAS (R1-F7) needs a migration grant — recorded in the
ledger pending that decision. The four local escaper copies in the feed-XML
modules ride the next docs wave. The INFO-class records (LFS masking
hardening, the Range int32 quirk, the verify store-vs-request shape) are
folded into SPEC-0006's as-built sections with their cites.
