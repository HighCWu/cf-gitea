/**
 * SPEC 0230 acceptance harness — the PRE-L823 zero-regression fixture
 * (L825 lane).
 *
 * These are the byte-exact receive-pack response bodies observed at engine
 * commit cccb8da (2026-11-25, the last buffered-response HEAD before the
 * SPEC 0230 streaming/keepalive change), captured under the workerd vitest
 * composition and verified byte-identical across three consecutive runs.
 *
 * Provenance: the fixture push is the deterministic `buildPack()` commit
 * (blob "hello push-create\n" → tree → commit, author/committer time pinned
 * at 1700000000), pushed to a fresh repository as
 * `${ZERO_OID} <oid> refs/heads/main` with the caps listed per arm. The
 * response bytes decode as:
 *
 *   noSidebandHex — caps `report-status` (no side-band-64k): the buffered
 *     plain pkt-line report, exactly renderStatus(sideband=false):
 *     pkt("unpack ok\n") + pkt("ok refs/heads/main\n") + FLUSH.
 *   sidebandHex — caps `report-status-v2 side-band-64k`: the sideband frame
 *     pkt(01 || pkt("unpack ok\n") + pkt("ok refs/heads/main\n") + FLUSH)
 *     followed by the stream FLUSH — one band-1 data frame (the 41-byte
 *     report fits far under the 32KB SIDEBAND_CHUNK) and the flush.
 *
 * What the acceptance test does with it (receive-sideband-keepalive-
 * acceptance.test.ts, arms B1/B2): a fast push (the fixture push is 3
 * objects — no 100k-object or 64MB milestone can fire) must answer these
 * bytes EXACTLY, before and after the L823 streaming change. The SPEC 0230
 * idle-gated keepalive (20s claimed interval) cannot fire inside a
 * millisecond-scale push, so the streaming response's byte content stays
 * identical; only the DELIVERY (incremental stream vs one-shot buffer)
 * changes. Any byte divergence after L823 lands is a zero-regression
 * failure of SPEC 0230's supplementary check, not a fixture staleness —
 * re-pin ONLY after an intentional, reviewed protocol change, and record
 * the re-pin in the SPEC.
 */
export interface PreL823Fixture {
  /** the deterministic fixture commit's oid */
  readonly oid: string;
  /** engine commit the bytes were observed at */
  readonly engineHead: "cccb8da";
  readonly capturedAt: "2026-11-25";
  /** response body hex, caps `report-status` */
  readonly noSidebandHex: string;
  /** response body hex, caps `report-status-v2 side-band-64k` */
  readonly sidebandHex: string;
}

export const PRE_L823_FIXTURE: PreL823Fixture = {
  oid: "358bb0ba7a25eee22e13c67fba8303d2bf50ecd3",
  engineHead: "cccb8da",
  capturedAt: "2026-11-25",
  noSidebandHex:
    "30303065756e7061636b206f6b0a303031376f6b20726566732f68656164732f6d61696e0a30303030",
  sidebandHex:
    "303032650130303065756e7061636b206f6b0a303031376f6b20726566732f68656164732f6d61696e0a3030303030303030",
};
