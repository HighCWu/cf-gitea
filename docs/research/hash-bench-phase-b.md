# Hash Bench Phase B — workerd CPU/memory measurements for the passwd_hash_algo surface

Measured 2026-11-04 (PWD-3 unit, benchmark report ordered by the user's hash-strategy
ruling: *"先完成 PBKDF2 上游兼容性验证和默认密码体系，再提交其他算法的基准测试报告"* — Phase A
(the PBKDF2 family, landed as 09ea3f1/e5e7c4e) came first; THIS document is the
benchmark report for the remaining upstream algorithms). **Report only — no product
changes**; every number below is reproducible with the committed harness under
`scripts/hash-bench/` (§8).

## TL;DR

| algo (upstream default spec) | workerd median / verify | memory | platform verdict |
| --- | --- | --- | --- |
| `pbkdf2$10000$50` (legacy bare) | **2 ms** | negligible | fits (landed, Phase A) |
| `pbkdf2$50000$50` (v2 default) | **8 ms** | negligible | fits (landed, Phase A) |
| `pbkdf2$100000$50` (cap edge) | **15 ms** | negligible | fits CPU; sits exactly at the PRODUCTION iteration cap |
| `pbkdf2$320000$50` (`pbkdf2_hi`) | 50 ms locally | negligible | **BLOCKED in production** (§5.4: Workers WebCrypto caps PBKDF2 at 100,000 iterations) |
| `bcrypt$10` | **44 ms** | negligible (wasm) | **feasible** — wasm via static `.wasm` import (§5.2) |
| `scrypt$65536$16$2$50` (upstream default) | — | 128 MiB working set | **IMPOSSIBLE on Workers** — three independent blockers (§5.3) |
| scrypt reduced rungs | 36 ms `(16384,8,2)` … 155 ms `(65536,8,2)` | 16–64 MiB | feasible ONLY with an explicit `maxmem` opt-in and N·r < 2^20 (§5.3) |
| `argon2$2$65536$8$50` (upstream default) | **91 ms** | 64 MiB working set | **feasible** — wasm via static `.wasm` import (§5.1) |

Headline platform discoveries (all measured on the pinned runtime; details in §5):

1. **workerd hard-blocks dynamic wasm compilation** — `WebAssembly.compile(bytes)`
   fails with *"Wasm code generation disallowed by embedder"*, no compatibility flag.
   The popular npm approach (hash-wasm's base64-embedded wasm) **does not run on
   Workers**; argon2/bcrypt adoption requires statically imported `.wasm` modules.
   The harness implements that shape and proves it works.
2. **Workers WebCrypto caps PBKDF2 at 100,000 iterations in production** (documented;
   local workerd does NOT enforce it). Upstream's stronger `pbkdf2_hi` arm
   (320,000 iterations) is therefore **unusable in production**, while the landed
   `pbkdf2$50000$50` default sits comfortably under the cap.
3. **workerd's `node:crypto` scrypt defaults to a ~1 MiB `maxmem`** (Node's default is
   32 MiB) — upstream's default parameters fail immediately, and a lifted `maxmem`
   still leaves the 128 MiB working set = the entire Workers isolate memory ceiling.
   Upstream-default scrypt rows are **unverifiable on this platform**, at any knobs.
4. **`limits.cpuMs` is not enforced in local workerd** (same as `wrangler dev`), so the
   harness measures wall-time inside the isolate — which for these pure-CPU sections
   equals CPU time (§2.3) — and records the CPU-accounting probe as a negative result.

## 1. The exact supported algorithm set at the pin

Submodule pin `fc4936884584a41931906553d96c2601d750e6ef` (v1.22.0-rc1-3919-gfc49368845).
Upstream has NO declarative table; the set is the `MustRegister` calls in the hash
package's `init()`s (grep over `gitea/modules/auth/password/hash/` at the pin):

| hasher | registered at | default spec (`PASSWORD_HASH_ALGO` dealias, `setting.go:22-34`) |
| --- | --- | --- |
| `argon2` | `argon2.go:16` | `argon2$2$65536$8$50` (`setting.go:23`) |
| `bcrypt` | `bcrypt.go:11` | `bcrypt$10` (`setting.go:24`) |
| `scrypt` | `scrypt.go:16` | `scrypt$65536$16$2$50` (`setting.go:25`) |
| `pbkdf2` | `pbkdf2.go:17` | `pbkdf2` → `pbkdf2_v2` → `pbkdf2$50000$50` (`setting.go:26,30`) |
| (alias arms of the same factory) | — | `pbkdf2_v1` → `pbkdf2$10000$50` (`setting.go:27`); `pbkdf2_hi` → `pbkdf2$320000$50` (`setting.go:33`) |
| (not registered) | — | `dummy.go`'s `DummyHasher` is a test-only fixture in the package — it has NO `init()`/`MustRegister` and is not a `passwd_hash_algo` value |

Upstream's "recommended" list (`setting.go:36-42`): `pbkdf2`, `argon2`, `bcrypt`,
`scrypt`, `pbkdf2_hi`. Upstream parameter defaults are hardwired per file with
"MUST NOT BE CHANGED" comments: `pbkdf2.go:44-47` (iter 10000/keyLen 50 = the original
bare-`pbkdf2` configuration, kept for backwards compat), `bcrypt.go:40-42` (cost 10),
`scrypt.go:42-47` (N=1<<16, r=16, p=2, keyLen 50 — the source comment itself notes
"this default config will use 128MiB"), `argon2.go:47-52` (time=2, memory=1<<16 KiB =
64 MiB, threads=8, keyLen=50; the comment notes "using 64MiB in total").

Stored-format semantics (drives Phase C's verify design, not just cost):

- `argon2`/`scrypt`/`pbkdf2`: stored `passwd` = `hex(digest)`; parameters live in the
  `passwd_hash_algo` column. Verify = recompute + constant-time compare
  (`hash.go:63-79` default path; argon2/scrypt do NOT implement the specialized
  verifier). Salt: hex-decoded (or raw 10-char pre-2022 binary — `hash.go:42-60`).
- `bcrypt` is the ONE exception: `passwd` holds the full modular-crypt string
  (`bcrypt.go:25-27` — `bcrypt.GenerateFromPassword` output, cost+salt embedded) and
  verify goes through `bcrypt.CompareHashAndPassword` (`bcrypt.go:29-31`), i.e. the
  specialized `PasswordVerifier` branch (`hash.go:66`). The `salt` column is ignored.
  Passwords > 72 bytes are rejected upstream (x/crypto `GenerateFromPassword` errors);
  the vendored wasm build rejects identically (PROVENANCE.txt item 3).

## 2. Method — what was measured and what was not

### 2.1 Runtime

All platform numbers run INSIDE **workerd** (`@cloudflare/workerd-linux-64` 1.20261023.1,
the binary the repo's own `wrangler dev`/vitest pool uses), driven programmatically by the
repo's pinned **miniflare 5.20261023.0-beta** (the coordinated EXACT pin inside
wrangler/vite-plugin/vitest-plugin — `docs/research/miniflare-beta-pin.md`), with the
product's `compatibility_date 2026-10-23`. Two isolate profiles:

- **flags-free** (`pbkdf2`/`bcrypt`/`argon2` arms) — mirrors the product's actual
  posture (`apps/worker/wrangler.jsonc` has NO `compatibility_flags` entry);
- **`["nodejs_compat"]`** (scrypt arm only) — `node:crypto` requires the flag; the
  product does not ship it today, which is itself a Phase C prerequisite if scrypt
  verify with reduced parameters were ever wanted.

### 2.2 Box

Single dev box, Linux x64, Node v25.9.0 host (host-side code only spawns miniflare and
prints), measurements taken inside the workerd isolate. Numbers are host-relative —
ratios and feasibility verdicts travel; absolute milliseconds are this box's. The
results JSON for the run quoted here: `.bench-results/hash-bench-phase-b-2026-11-04T04-39-40-892Z.json`
(gitignored transient dir, same convention as `scripts/bench-run.mjs`).

### 2.3 Wall vs CPU (stated precisely)

Each sample is `performance.now()` **inside the isolate** around a pure-CPU section
(one verify/hash; no I/O, no timers). workerd isolates are single-threaded and the
timed sections never await I/O, so wall-in-isolate ≈ CPU time consumed by the
request — including the C++/native core time for WebCrypto calls and wasm execution.
We attempted to cross-check this against workerd's OWN CPU accounting
(`limits.cpuMs` binary search, the runtime's "exceeded CPU time limit" failure as the
positive signal): **local workerd does not enforce cpu_ms** (an iter=320000 PBKDF2 op
completes under `cpuMs: 1`; same behavior class as `wrangler dev`, where cpu limits
are ignored) — the probe is kept in `bench-pbkdf2.mjs` and records this negative
result rather than pretending. Production CPU accounting remains un-verified
(no deployed probe; out of scope for a report-only unit) — but the verdict margins
(8–175 ms vs the product's `limits.cpu_ms: 300000`) are two to four orders of
magnitude wide, so wall≈CPU uncertainty cannot flip any verdict below.

### 2.4 Correctness before cost

`node scripts/hash-bench/verify-parity.mjs` — **all 7 checks pass** (full-digest
equality, not prefixes): workerd pbkdf2 (iter 10000 AND 50000) == Node WebCrypto ==
Node OpenSSL `pbkdf2Sync`; workerd argon2id == Node hash-wasm (same wasm; independent
@noble/hashes parity in `vendor/hash-wasm/PROVENANCE.txt`); workerd bcrypt == Node
hash-wasm (independent python3-bcrypt parity in PROVENANCE.txt); workerd scrypt ==
Node `scryptSync`. The bench numbers therefore compare like-for-like digests —
the implementations compute what upstream computes, so their cost IS upstream's cost.

### 2.5 Sample counts

25 samples (3 warmups) for fast arms; ≥ 6 for seconds-scale arms (bcrypt cost 12);
OOM/failure probes run once. Median + p95 reported (nearest-rank percentile, same
convention as `scripts/bench-run.mjs`).

## 3. PBKDF2 (the landed baseline)

Call shape = the landed Phase A path exactly (`apps/worker/src/auth/password.ts:185-199`
`pbkdf2Sha256Hex`: `crypto.subtle.importKey("raw", …)` + `deriveBits(…, keyLen*8)`
per verify, SHA-256, flags-free isolate).

| arm (spec) | params | median ms | p95 ms | n |
| --- | --- | --- | --- | --- |
| legacy bare (`pbkdf2$10000$50`, pbkdf2.go:44-47) | iter=10000 | 2 | 2 | 25 |
| v2 default (`pbkdf2$50000$50`, setting.go:30) | iter=50000 | 8 | 8 | 25 |
| cap edge (`pbkdf2$100000$50`) | iter=100000 | 15 | 16 | 10 |
| `pbkdf2_hi` (`pbkdf2$320000$50`, setting.go:33) | iter=320000 | 50 | 51 | 10 |

Linear in iterations (~0.16 µs/iter); Node-side `pbkdf2Sync` context numbers track
within ~15% (2.0/9.9/63.4 ms) — the WebCrypto native implementation is OpenSSL-class.
Legacy verify (2 ms) is 4x cheaper than the v2 default (8 ms) — the login-rehash
ladder (legacy arm → v2 on next login, upstream `authenticate.go:60`, already
implemented by Phase A's `needsRehash`) costs nothing per login.

**Verdict: both landed arms fit with 4–5 orders of magnitude of cpu_ms headroom.**
The `pbkdf2_hi` row is where the platform bites — see §5.4.

## 4. bcrypt, scrypt, argon2 at upstream defaults

### 4.1 bcrypt (wasm, vendored — see §5.2 for why wasm and how it loads)

Upstream default cost 10 (`setting.go:24`, `bcrypt.go:40-42`). Measured full
`bcrypt()` (hash) and `bcryptVerify()` on the bench (password, 16-byte salt) pair:

| cost | verify median ms | verify p95 | hash median ms | n |
| --- | --- | --- | --- | --- |
| 8 | 11 | 12 | 11 | 25 |
| 10 (upstream default) | **44** | 45 | 44 | 25 |
| 12 | 175 | 176 | 175 | 6 |

Clean 2^2-per-cost-step ladder (4x per +2 cost: 11 → 44 → 175). Memory footprint is
negligible (bcrypt's working set is ~4 KiB of Blowfish state). Hash ≈ verify cost, as
expected (same EksBlowfish schedule).

**Verdict: cost 10 verify = 44 ms — feasible with ~4 orders of magnitude cpu_ms
headroom; cost 12 (175 ms) also fits if a self-hosted operator ever tunes up.**
Caveats for a Phase C: the stored value is the full modular-crypt string (§1), verify
must use the hash-embedded cost/salt (`hash.go:66` specialized-verifier branch), and
the >72-byte-password rejection must be preserved (it matches upstream — PROVENANCE.txt).

### 4.2 scrypt (workerd's `node:crypto` under `nodejs_compat`)

Upstream default N=65536, r=16, p=2 (`setting.go:25`, `scrypt.go:42-47`) — working
set 128·N·r = **exactly 128 MiB**, the entire Workers isolate memory ceiling. Measured
(four passes; "default maxmem" = as-shipped workerd behavior):

| pass | params (working set) | maxmem | median ms | result |
| --- | --- | --- | --- | --- |
| 1 | upstream default (128 MiB) | workerd default | — | FAIL: `Scrypt failed: cost exceeds maximum (1048576).` |
| 2 | `(131072,8,2)` (128 MiB) | workerd default | — | FAIL: same cost-check message |
| 2 | `(65536,8,2)` (64 MiB) | workerd default | — | FAIL: `Scrypt failed` |
| 2 | `(32768,16,2)` (64 MiB) | workerd default | — | FAIL: `Scrypt failed` |
| 2 | `(32768,8,2)` (32 MiB) | workerd default | — | FAIL: `Scrypt failed` |
| 2 | `(16384,16,2)` (32 MiB) | workerd default | — | FAIL: `Scrypt failed` |
| 2 | `(16384,8,2)` (16 MiB) | workerd default | **36** (p95 39, n=25) | runs |
| 3 | `(65536,8,2)` (64 MiB) | explicit 192 MiB | **155** (p95 168, n=25) | runs |
| 3 | `(32768,16,2)` (64 MiB) | explicit 192 MiB | 149 (n=25) | runs |
| 3 | `(32768,8,2)` (32 MiB) | explicit 192 MiB | 76 (n=25) | runs |
| 3 | `(16384,16,2)` (32 MiB) | explicit 192 MiB | 73 (n=25) | runs |
| 3 | `(16384,8,2)` (16 MiB) | explicit 192 MiB | 36 (n=25) | runs |
| 4 | `(65536,16,2)` (128 MiB) | explicit 320 MiB | — | FAIL: cost check STILL fires |
| 4 | `(131072,8,2)` (128 MiB) | explicit 320 MiB | — | FAIL: cost check STILL fires |

Three stacked blockers, empirically separated:

1. **workerd's scrypt default `maxmem` ≈ 1 MiB** (the `1048576` in the error; Node's
   default is 32 MiB — workerd#6639 documents the divergence). Anything above the
   tiniest parameters fails until `maxmem` is passed explicitly.
2. **A ~16 MiB working-set boundary** beyond the cost check: with default maxmem,
   shapes ≤ 16 MiB run and everything above dies with a bare `Scrypt failed`.
3. **The isolate ceiling + a hard cost gate**: shapes with 128·N·r = 128 MiB fail the
   cost check **even with `maxmem: 320 MiB`** (measured) — and they would not fit the
   128 MiB isolate anyway. Upstream's default parameters are doubly impossible.

Node-side context (same box, native OpenSSL, `maxmem: 192 MiB`): (65536,16,2) 323 ms,
(65536,8,2) 168 ms, (32768,8,2) 82 ms, (16384,8,2) 35 ms — workerd's implementation
tracks Node's closely (36 vs 35 ms at the small rung), so the deltas above are
platform caps, not implementation slowness.

**Verdict: upstream-default scrypt rows are UNVERIFIABLE on Workers — no knob
combination reaches them** (§5.3). Reduced-parameter rows would verify (36 ms at
16 MiB; 155 ms at 64 MiB with maxmem lifted — both fit), but upstream never writes
such specs by default; only custom-configured instances would carry them.

### 4.3 argon2id (wasm, vendored — same static-import shape as bcrypt)

Upstream default: Argon2id, time=2, memory=65536 KiB (64 MiB), parallelism=8,
keyLen=50 (`setting.go:23`, `argon2.go:47-52`; `argon2.IDKey` semantics, v=0x13).
The vendored wasm build is single-threaded — upstream's threads=8 becomes 8 lanes
processed serially (same total work, no parallel speedup; noted as a Phase C
consideration only if a multi-threaded build were desired, which Workers standard
workers do not support anyway).

| params | working set | median ms | p95 ms | n |
| --- | --- | --- | --- | --- |
| upstream default `t=2 m=65536KiB p=8` | 64 MiB | **91** | 97 | 25 |
| `t=2 m=32768KiB p=8` | 32 MiB | 43 | 44 | 13 |
| `t=4 m=32768KiB p=8` | 32 MiB | 79 | 83 | 13 |

**Verdict: the upstream default fits — 91 ms verify (≈0.03% of cpu_ms) and a 64 MiB
working set under the 128 MiB ceiling with ~2x headroom, measured across n=25
without a single allocation failure.** Digest = `hex(tag)` with parameters in the
`passwd_hash_algo` column → verify uses the DEFAULT recompute + constant-time
compare path (`hash.go:63-79`) — structurally simpler to bolt onto Phase A than
bcrypt (no specialized verifier, no salt-column exception).

## 5. Platform findings (what this bench discovered beyond cost)

### 5.1 dynamic wasm compilation is hard-blocked → hash-wasm as shipped does NOT run

First bcrypt/argon2 attempt failed with `CompileError: WebAssembly.compile(): Wasm
code generation disallowed by embedder`. This is a hard embedder restriction in
workerd (and documented for production Workers — cloudflare/workers-sdk#1366; the
"@cf-wasm" ecosystem exists precisely to ship workerd-targeted builds; there is NO
compatibility flag to lift it). The sanctioned wasm shape on Workers is a
**statically imported `.wasm` module** (bundled as CompiledWasm, compiled at
deploy/startup; the import yields a precompiled `WebAssembly.Module` which
`WebAssembly.instantiate(module)` accepts).

The harness implements the workaround end-to-end (`scripts/hash-bench/`):
`lib/extract-wasm.mjs` decodes hash-wasm's base64-embedded binaries into real
`.wasm` files (byte-identical to the upstream dist — SHA256s in
`vendor/hash-wasm/PROVENANCE.txt`); `lib/run-worker.mjs` declares them as
CompiledWasm modules; `lib/worker-bench.mjs` redirects hash-wasm's
`WebAssembly.compile(bytes)` to the precompiled modules via a byte-length-keyed
shim (argon2=6660 B, blake2b=7442 B — argon2id needs blake2b for its H0 — and
bcrypt=16944 B). This is the working reference for any Phase C adoption: the SAME
shape works in `wrangler dev`/deploy via a `rules: [{ type: "CompiledWasm", globs:
["**/*.wasm"] }]` entry in wrangler.jsonc.

### 5.2 viable argon2/bcrypt approach with ZERO product dependencies (the mission question)

Answer: yes — the vendored static-wasm shape above. No `package.json` change, no
npm install; three extracted `.wasm` files (argon2 6.7 KB, bcrypt 17 KB, blake2b
7.4 KB) + a loader that accepts precompiled modules. Provenance + cross-validation
(@noble/hashes for argon2id; python3-bcrypt for bcrypt; the >72-byte-password
rejection parity) recorded in `vendor/hash-wasm/PROVENANCE.txt`; digest parity
inside workerd re-proven by `verify-parity.mjs` at run time.

### 5.3 scrypt on workerd is capped far below upstream defaults

See §4.2's three-layer analysis. Practical consequence recorded for the SPEC:
`scrypt$65536$16$2$50` rows must join the controlled-unsupported set
(`PasswordHashUnsupportedError` → upstream's generic auth failure on the wire +
server log cause — the Phase A §6.3-3 machinery already does this), with the
specific cause logged so operators can distinguish "scrypt rows exist" from
"malformed rows".

### 5.4 PBKDF2 iteration cap: local/prod divergence (test asymmetry hazard)

Local workerd (miniflare) **accepts** PBKDF2 iterations far above the production
cap: 100001, 200000, 320000 all accepted (17/31/49 ms — `iterationCapProbe` in the
results JSON). Production Cloudflare Workers cap PBKDF2 at **100,000 iterations**
("iteration counts above 100000 are not supported" — workerd#1346, Cloudflare staff
confirmation; below OWASP's 600k guidance for PBKDF2-SHA256). Consequences:

- The landed default `pbkdf2$50000$50` is safe (50% of the cap, 8 ms).
- Upstream's `pbkdf2_hi` (`pbkdf2$320000$50`) **passes every local test but would
  throw in production**. A Phase C that adds verify arms must NOT accept
  `pbkdf2_hi` rows on this platform — and the SPEC should record the divergence:
  the honest production behavior for a stored `pbkdf2$320000$50` row is the
  controlled-unsupported arm (or an explicit pre-parse reject at 100,000), never a
  verify that passes in dev and dies in prod.
- Cap status needs re-verification at deploy time if Cloudflare ever lifts it
  (their staff note "may change in the future"); the harness's `pbkdf2-cap` probe
  is the ready-made check for a production probe run.

### 5.5 limits.cpuMs not enforced locally

`limits.cpuMs` (miniflare) is ignored by local workerd — binary search over limits
found no boundary (probe data in the results JSON). Same behavioral class as
`wrangler dev` (cpu limits are a production control). Kept as an honest negative
result; the verdicts do not depend on it (§2.3 margins).

## 6. Platform-fit verdicts (cpu_ms 300000 per wrangler.jsonc; 128 MiB isolate ceiling)

| stored arm | CPU/verify (workerd) | memory | fits cpu_ms? | fits 128 MiB? | production-blockers |
| --- | --- | --- | --- | --- | --- |
| `pbkdf2$10000$50` | 2 ms | negligible | yes (150000x headroom) | yes | none — landed |
| `pbkdf2$50000$50` | 8 ms | negligible | yes | yes | none — landed |
| `pbkdf2$100000$50` | 15 ms | negligible | yes | yes | sits AT the production 100k cap — usable but zero margin against the cap |
| `pbkdf2$320000$50` | 50 ms local | negligible | yes locally | yes | **PRODUCTION: iteration cap rejects >100000** |
| `bcrypt$10` | 44 ms | ~KB | yes | yes | none (wasm static import required) |
| `scrypt$65536$16$2$50` | — | 128 MiB | — | **no — working set = whole ceiling** | cost check + maxmem + ceiling |
| scrypt reduced (≤64 MiB) | 36–155 ms | 16–64 MiB | yes | yes (≤64 MiB rungs measured) | requires explicit maxmem + N·r < 2^20 |
| `argon2$2$65536$8$50` | 91 ms | 64 MiB | yes | yes (~2x headroom) | none (wasm static import required) |

## 7. Recommendations (per the ruling's frame — verify arms vs new-hash ladder)

Split the problem exactly as the ruling framed it: **new-hash defaults** (what we
write) and **legacy-verify arms** (what we must accept and rehash-on-login). These
are separable decisions; nothing below requires changing the landed Phase A
default.

R1. **New-hash default: keep `pbkdf2$50000$50`.** Upstream's own default
    (`setting.go:26,30`) — the upstream-parity decision rule applies, and it sits at
    8 ms / 50% of the production iteration cap: no platform pressure to move. The
    landing is already done (09ea3f1/e5e7c4e); Phase C's "knob" work (configurable
    `PASSWORD_HASH_ALGO`) should dealias-and-store the spec exactly as upstream does
    (`security.go:175`).

R2. **Migration ladder within pbkdf2: the on-login rehash already implements it.**
    Legacy `pbkdf2$10000$50` (and bare/"" rows) → `pbkdf2$50000$50` on next login
    (upstream `authenticate.go:60`; Phase A `needsRehash`). Cost: 2 ms per legacy
    verify + 8 ms per rehash — negligible. `pbkdf2_hi` must NOT join the ladder on
    this platform (§5.4 production cap).

R3. **Legacy-verify `argon2` (`argon2$2$65536$8$50`): FEASIBLE — recommended as the
    first Phase B/C verify arm to add.** 91 ms/verify at upstream defaults, 64 MiB
    fits with ~2x headroom, upstream's #2 recommended algorithm, and the
    structurally simplest addition (recompute + constant-time compare — the same
    shape as the landed pbkdf2 verify; no salt-column exception, no embedded
    params). Requirements: vendored static `.wasm` import (§5.1/§5.2 — this
    harness is the reference), wrangler.jsonc `CompiledWasm` rules entry, and the
    SPEC recording the single-threaded-lane note. On-login rehash would then move
    argon2 rows to the configured default exactly as upstream does
    (`authenticate.go:64` updates passwd/salt/passwd_hash_algo).

R4. **Legacy-verify `bcrypt` (`bcrypt$10`): FEASIBLE — second arm.** 44 ms/verify,
    negligible memory. Extra complexity vs argon2 only in the stored format:
    full modular-crypt string in `passwd` (salt column ignored), hash-embedded
    params, the specialized verifier branch, >72-byte rejection. All four
    behaviors are pinned by upstream cites in §1 and matched by the vendored
    build (PROVENANCE.txt).

R5. **Legacy-verify `scrypt` (`scrypt$65536$16$2$50`): NOT FEASIBLE — route to the
    controlled-unsupported arm.** The upstream default is impossible on Workers at
    any knob setting (§5.3). Existing upstream deployments with scrypt users
    cannot self-host here and have those users log in; the honest behavior is the
    §6.3-3 controlled error (generic auth failure + logged cause), plus an operator
    log signal to size the population. Reduced-parameter scrypt specs (≤64 MiB,
    N·r < 2^20, explicit maxmem) WOULD verify (36–155 ms) if a SPEC ever wanted to
    accept them, but upstream never emits such specs by default — do not preemptively
    support them.

R6. **If a stronger default is ever wanted (out of upstream-parity scope, would
    need its own SPEC + user ruling): argon2id is the platform-feasible candidate**
    (91 ms, 64 MiB, upstream-recommended), NOT `pbkdf2_hi` (production-capped) and
    NOT scrypt (memory). Upstream's alias table already carries `argon2` as a
    `PASSWORD_HASH_ALGO` value, so the config surface stays upstream-faithful.

## 8. Reproduction

Every number above comes from this harness (zero npm deps; miniflare imported
in place from the repo's .pnpm store; results JSON to the gitignored
`.bench-results/`):

```bash
# correctness first — full-digest parity, workerd vs Node/reference (7 checks):
node scripts/hash-bench/verify-parity.mjs

# everything (all four algorithms, all passes, JSON to .bench-results/):
node scripts/hash-bench/bench-all.mjs --samples 25

# per-algorithm (markdown tables on stdout):
node scripts/hash-bench/bench-pbkdf2.mjs    # [--samples N] [--no-cpu-probe] [--no-node]
node scripts/hash-bench/bench-bcrypt.mjs    # [--samples N] [--no-node]
node scripts/hash-bench/bench-scrypt.mjs    # [--samples N] [--no-node]
node scripts/hash-bench/bench-argon2.mjs    # [--samples N] [--no-node]

# re-extract the wasm binaries from the vendored bundle (deterministic):
node scripts/hash-bench/lib/extract-wasm.mjs
```

Harness layout: `scripts/hash-bench/{bench-{all,pbkdf2,bcrypt,scrypt,argon2}.mjs,
verify-parity.mjs, lib/{worker-bench,run-worker,miniflare-resolve,extract-wasm,
vendor-import,stats}.mjs, vendor/hash-wasm/{index.esm.js.vendored,argon2.wasm,
bcrypt.wasm,blake2b.wasm,LICENSE,PROVENANCE.txt}}`. The vendored bundle +
extracted wasm files are the only third-party bytes, fully provenance-tracked.

## 9. Limitations / open issues

- **Single-host measurements.** Absolute ms are this dev box; feasibility verdicts
  (orders-of-magnitude margins, memory ceilings) are platform properties and
  travel. A production probe run (the deploy-probes pattern) could re-check the
  PBKDF2 iteration cap and relative ratios in production, but was out of scope for
  this report-only unit.
- **Production cpu_ms accounting not sampled** (no enforcement locally, §2.3/§5.5);
  margins make this immaterial for every verdict.
- **hash-wasm's threads=8 runs single-threaded** in the wasm build (§4.3) — same
  total work as upstream's 8 goroutine lanes; a production argon2 adoption does not
  need threads to be upstream-parity (golang's lanes do not change the tag).
- **eslint config**: the vendored bundle is stored as `index.esm.js.vendored`
  (non-lintable extension) so the third-party dist never enters `pnpm lint` —
  no shared-file (eslint.config.js) edit was needed for this unit.
- **scrypt maxmem semantics** were characterized empirically (§4.2/§5.3); the exact
  workerd internal check (cost = N·r vs N·r·p, strict vs non-strict at 2^20) is not
  source-audited — the measured boundaries are what the SPEC needs.
