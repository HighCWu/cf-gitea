# SPEC 0230 acceptance harness — receive-pack sideband keepalive (L825 lane)

Independent black-box acceptance surface for
**SPEC 0230** (`receive-pack side-band 保活`, mirror line wall ③½ engine-side
countermeasure). The SPEC text and its five acceptance criteria live in the
product repo (`docs/specs/0230-receive-sideband-keepalive/SPEC.md`); the
IMPLEMENTATION (staged streaming response + CPU yield points in receivePack)
belongs to the **L823 engine lane** in this repository. This harness never
reads engine internals — it drives real receive-pack calls and consumes the
response the way a client does.

## Files

| File | Role |
|---|---|
| `testing/sideband-consumer.ts` | The protocol-level consumer: incremental sideband-64k stream reader with wall-clock arrival timestamps, strict pkt-line framing (gitprotocol-common(5)), band-1/2/3 classification (gitprotocol-pack(5)), byte-exact `0005\x01` empty-keepalive identification, silence-gap analysis, the `assertKeepaliveDiscipline` judge, and scripted producers (including the fake-alive shape). No engine code. |
| `testing/receive-sideband-pre-l823-fixture.ts` | The committed PRE-L823 zero-regression fixture: byte-exact receive-pack response bodies observed at engine commit `cccb8da` (2026-11-25), three-run determinism verified. |
| `receive-sideband-keepalive-acceptance.test.ts` | The acceptance battery: Ledger A (self-proof) + Ledger B (engine, black box). |

## How to run (bounded)

One file, one lock, one bounded vitest invocation — never the full suite:

```sh
flock -w 900 /tmp/l825-spec0230-vitest.lock -c \
  "NODE_OPTIONS='--max-old-space-size=4096' \
   pnpm --filter cf-gitea-worker exec vitest run \
   src/git-http/receive-sideband-keepalive-acceptance.test.ts"
```

Quiet-HEAD wall time ≈ 14 s (the two timing-ish Ledger A producers run on a
scaled-down 400 ms clock; the engine arms are millisecond-scale pre-merge).
Post-L823, arm B4 adds one injected ~25 s index-window delay (test timeout
90 s, bounded by construction).

## The two ledgers (read the run output accordingly)

### Ledger A — protocol consumer self-proof (always runs, must always be green)

Tests A1–A8 feed scripted byte streams to the consumer and prove the judge
itself: band framing + byte-exact heartbeat identification (A1), the
silence/terminal-report discipline on a well-formed producer (A2), the
**fake-alive conviction** — beats scheduled but one synchronous CPU block
starving the timer for the whole window produces a single end burst, and the
silence judge must convict it BY TIMING (A3) — illegal/truncated framing
(A4/A5), a non-terminal report (A6), official idle-gating semantics where a
milestone resets the silence clock and is never miscounted as a heartbeat
(A7), and the quiet window where beats alone carry the silence — criterion
③'s protocol side (A8).

If Ledger A is red, the HARNESS is wrong. These tests are
L823-independent and green at every engine state.

### Ledger B — engine acceptance, black box (auto-arms with L823)

Driven through `createDurableGit` over the real workerd bindings:

- **B1 (green at every engine state)** — criterion ① negotiation: the receive
  advertisement still offers `side-band-64k`; a client that did NOT request
  sideband answers the plain pkt-line report, byte-identical to the
  committed pre-L823 fixture.
- **B2 (green at every engine state)** — supplementary zero-regression: a
  fast sideband push (3 objects, no milestone can fire; the idle-gated 20 s
  keepalive cannot fire inside a millisecond-scale push) answers bytes
  IDENTICAL to the pre-L823 fixture, frames legal, report terminal, zero
  heartbeats. After L823 lands, any divergence is a zero-regression failure
  of the streaming change — not fixture staleness.
- **B3 (green at every engine state)** — criterion ⑤ post-hoc: after an ok
  report the pushed tip is served on the read surface (finalize's single
  transaction decided before success was reported).
- **B4 (auto-arms post-L823)** — criteria ②④'s timing judge: a real
  validatePush hook injects a ~25 s delay post-scan / pre-finalize (inside
  the streamed window, using the engine's own extension point — zero engine
  coupling), and the consumer must receive byte-exact `0005\x01` beats with
  adjacent-frame silence ≤ interval×2 (claimed 20 s ⇒ cap 40 s), no progress
  text at all in the window (criterion ③ engine-side: a 3-object pack emits
  no milestones — the beats stand alone), and a terminal report.
- **B5 (auto-arms post-L823)** — failure semantics: a catastrophic
  (throw-hook) post-lease failure must answer an in-band band-3 error frame
  + stream termination (never a silent break), no success report, and the
  lease must turn over (a follow-up push lands).

**The arm-open probe (how B4/B5 auto-arm):** before the streaming change a
throw-hook push answers today's buffered `500` shape; after it, the same
push answers `200` + band-3 (the status is already committed when the arm
opens — a structural discriminator with no timing dependence). Pre-merge,
B4/B5 record explicit `PENDING L823 (SPEC 0230)` skips with that probe
evidence, and B5 pins the buffered 500 failure shape verbatim before
skipping. Post-merge the probe answers 200 and both arms assert the full
contract — **because the probe is structural, a post-merge fake-alive
implementation (arm open, zero in-window bytes) is RED, not skipped.**

## Constants to keep honest

`KEEPALIVE_INTERVAL_MS` (20 000) is the interval SPEC 0230 CLAIMS; the
silence cap is `interval × 2`. If the implementation window chooses a
different interval inside the SPEC's 15–30 s range, update the constant to
the implementation's declared value (and `INDEX_WINDOW_DELAY_MS`, currently
interval + 5 s, must stay above it) — the judge loosens only for the claimed
interval, never for an observed violation.

## Honest scope limits

- "Client" here reads the engine `Response` body under workerd — server-side
  per-frame arrival, not the edge's 60–70 s idle cap. The edge leg is SPEC
  0230's own 诚实边界 deployment acceptance (the w264 thin re-push after the
  engine-window deploy); no local harness can certify it.
- The CPU-yield criterion's end-to-end arm — a REAL synchronous scan long
  enough to block a 20 s beat — needs an index heavy enough (~20 k+ objects)
  that building it inside a bounded suite is impractical. Ledger A3 proves
  the judge convicts that shape on the wire; the heavy-fixture run belongs
  to the implementation lane's own bench or a follow-up.
- B4's post-merge assertions execute for the first time when L823's commit
  lands (the skip path is what runs before that). A red there post-merge is
  the harness working as intended.

## Fixture re-pinning policy

`testing/receive-sideband-pre-l823-fixture.ts` is a pinned OBSERVATION of
engine commit `cccb8da`, not an expectation to update casually. Re-pin only
after an intentional, reviewed protocol change; record the re-pin in the
SPEC 0230 implementation evidence. A post-L823 mismatch on B1/B2 is a
regression signal first.
