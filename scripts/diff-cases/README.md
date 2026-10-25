# Differential test battery (`scripts/diff-test.mjs` cases)

The case battery behind `node scripts/diff-test.mjs` — the Round-8 mandate
(docs/design/m3-design-inputs.md): "same repo, same git CLI commands, vs a real
Gitea instance; diffs must be explainable by declared compatibility rules."
Deterministic seeds (fixed content, identities, dates) make oids identical on
every endpoint, so reports compare field by field; every legitimate divergence
must be covered by a rule in `rules.mjs`, anything else is UNEXPLAINED and
fails `--compare`.

## Files

| File | Role |
|---|---|
| `index.mjs` | Case registry (run order): read family, write family, protocol family, push family |
| `seed.mjs` | Deterministic seed repos (`history` 5 commits, `simple` 2 commits, `bulk` 12 commits / 48 objects) + the bulk content builders |
| `cases-read.mjs` | Clone shapes + the shallow family (pre-existing) |
| `cases-write.mjs` | Push semantics (pre-existing) |
| `cases-protocol.mjs` | Deepen-family strict reject, tag/branch negotiation, ls-remote patterns, `fetch --prune`, byte-thresholded incremental fetch, capability-matrix dump |
| `cases-push.mjs` | Push lifecycle family — **ours-only** (skipped, with a recorded note, on theirs) |
| `rules.mjs` | Declared compatibility rules + the shallow-family acceptance predicate |

## Running

Ours-only (dev server in `apps/worker`: `pnpm dev`; token = the `GIT_TOKEN`
value in `apps/worker/.dev.vars` — never commit it):

```bash
node scripts/diff-test.mjs --ours http://127.0.0.1:5173 --token <GIT_TOKEN>
node scripts/diff-test.mjs --compare <a.json> <b.json>   # explain stored divergences
node scripts/diff-test.mjs --list                         # the battery
```

Exit 0 iff every case outcome is in {ok, clean-reject, shallow-ok}.

## Case families and what they pin

### Deepen family (`deepen-strict-reject`, plus the pre-existing shallow cases)

`clone --shallow-since` / `--shallow-exclude` / `fetch --deepen=1`
(deepen-relative) must be either **cleanly rejected** (git exit 128, NO repo
dir left behind, server ERR pkt-line naming the unsupported argument) or
**implemented as a correct shallow result** — a silent full clone or a mutated
`.git/shallow` after a rejected deepen fails the run. `clean-reject` pins the
current P0-stopgap state; `shallow-ok` is the compatible end-state (Round-8:
persistent rejection is transitional, never the goal — the case must not block
implementation, only wrong semantics). The supported path (`--depth=1`,
`--depth=3` deepen, `--unshallow`) stays hard-green inside the same cases.

### Tag/branch negotiation (`clone-tags-notags`, `fetch-single-refspec`, `ls-remote-patterns`, `fetch-prune`)

`--tags` vs `--no-tags`, annotated-tag peeling oids in the advert
(`refs/tags/v1` = tag object, `refs/tags/v1^{}` = `v1^{commit}`, lightweight
tags carry no peeled line), single-branch clone + explicit single-refspec
fetch, ls-remote `--heads`/`--tags`/exact/glob patterns/`--exit-code`
miss (exit 2, empty)/`--symref`, and `fetch --prune` after an upstream
delete (stale remote-tracking ref must survive until pruned).

### Incremental fetch (`incremental-bulk-fetch`, plus pre-existing `fetch-incremental`)

Clone the `bulk` seed (~51 KiB pack), push two server-side commits, then
assert the second fetch moves ONLY the delta: object-store growth under a
byte threshold (48 KiB) and a fraction of the base (40%), <= 10 objects
(negotiated haves), object counts exact, `git fsck --strict` clean. The
received bytes and any REF_DELTA entries in a new pack are recorded in the
report notes (thin-packing is server-optional; a fetch under git's
`transfer.unpackLimit` unpacks loose client-side — both observed and recorded
on the 2026-10-25 run: delta 9,877 bytes over a 51,373-byte base).

### Push family (`push-lifecycle`, `push-tags-move`, `push-atomic`) — ours-only

Branch create / fast-forward / non-FF rejection / forced overwrite / delete;
lightweight + annotated tag push with peel-oid equality and the tag-move
rejection (force required); and the `--atomic` consistency probe: the
receive-pack advert (captured via `GIT_TRACE_PACKET=1`) must agree with
behavior — advertised ⇒ an atomic two-branch push works; unadvertised ⇒ the
git CLI declines client-side and nothing lands (no partial push). These cases
run against ours only this wave (the optional theirs run is read-only); on a
non-ours endpoint they record `ours_only_skip` and run nothing, and
`rules.mjs`'s enforced `push-family-ours-only` rule keeps any REAL failure a
violation.

### Capability matrix (`advert-capability-matrix`)

Captures the `GIT_TRACE_PACKET=1` handshakes for protocol v2 and v0 plus the
receive-pack advert into the report notes (per endpoint) — the Round-8
**test-generated** input for the `AdvertisedFeature ⇒ ParsedAndHandled`
matrix. Parsed on the 2026-10-25 ours run:

- v2: `version 2`, `ls-refs`, `fetch=shallow`; HEAD `symref-target` answered.
- v0 upload-pack: `multi_ack_detailed no-done shallow side-band-64k
  symref=HEAD:refs/heads/main` + agent token.
- v0 receive-pack: `report-status delete-refs ofs-delta side-band-64k` (no
  `atomic` — `push-atomic` proves the consistent client-side refusal).

Enforced assertions: ours NEVER advertises `filter` (unadvertised-and-rejected
beats plausible-but-wrong — filter is not implemented, and advertising it
would invite silent wrong-semantics fetches), and advertised `shallow` implies
the deepen family is handled-or-rejected (proven in-place with a depth-1
probe: shallow boundary or protocol-shaped reject, never a silent full clone).
The deepen cases (`deepen-strict-reject`, `shallow-depth1`) are the
family-level proof of that implication.

Matrix quirk recorded (engine owner's to revisit, not a battery failure): the
agent token is advertised BARE (`dgit/0.3`), not as `agent=dgit/0.3`, in both
the v2 capability advert and the v0 capability list; stock git tolerates the
unknown token.

## Declared rules (rules.mjs)

- `deepen-family-strict-reject` (enforced) — the transitional reject is
  acceptable where a real Gitea shallow-clones; silent-full-clone /
  wrong-semantics is a violation on every side.
- `push-family-ours-only` (enforced) — a theirs-side record may carry
  `ours_only_skip`; a side that runs the family must be ok.
- `capability-matrix-endpoint-specific` (informational) — the matrix is
  endpoint-descriptive; capability-set differences document, not regress.
- Pre-existing: `deepen-family-transitional` (permissive shallow-since /
  shallow-exclude acceptance), `head-default-branch-info`,
  `server-stderr-text`.

## Theirs (optional real-Gitea run)

**Attempt recorded 2026-10-25: network-blocked.** Both `curl
https://gitea.com/api/v1/version` (exit 35, TLS connection non-properly
terminated) and `git ls-remote https://gitea.com/gitea/tea.git`
(gnutls_handshake failure) were terminated mid-handshake — no egress to
gitea.com from the dev environment. The run was NOT possible; no report
produced. A Gitea.com personal access token is also required (seeding pushes;
anonymous push-create does not exist there).

When egress + a token exist, the read-only theirs invocation skips every
case that writes to the remote beyond its own scratch repo seeding:

```bash
node scripts/diff-test.mjs --ours http://127.0.0.1:5173 --token <OURS_TOKEN> \
  --theirs https://gitea.com --theirs-token <GITEA_TOKEN> \
  --user <gitea-username> --label theirs \
  --skip push-force,push-multi,tags-push-clone,delete-ref,fetch-incremental,fetch-prune,incremental-bulk-fetch,push-lifecycle,push-tags-move,push-atomic
```

(The harness still seeds its own per-run scratch repos — `difftest-<hex>-*`
under the token's user — and deletes them afterwards; "read-only" means no
writes to anything pre-existing. The push family additionally self-skips on
theirs via `ours_only_skip`.)
