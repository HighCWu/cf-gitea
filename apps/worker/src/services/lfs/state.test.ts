/**
 * `lfs_objects` state machine on real D1 (SPEC-0006 §3.2–3.4): idempotent
 * `ensureUploading`, verify flip, adopt (success / size / checksum), stale
 * sweep query shapes, GC candidates + reachability predicate. The table is
 * created from the DDL-in-waiting (`LFS_OBJECTS_DDL_STATEMENTS`) until the
 * drizzle migration lands.
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_STALE_UPLOADING_AFTER_SECONDS,
  isLfsObjectUnreachable,
  LfsStateService,
  validateAdoptStat,
} from "./state";
import { applyLfsObjectsDdl, resetLfsTables } from "./testing";
import { generatePointer, pointerBlobSha1 } from "./pointer";

const REPO = 11;
const OID = "ab".repeat(32);
const OID2 = "cd".repeat(32);
const NOW = new Date("2026-10-24T12:00:00Z");

const service = (): LfsStateService => new LfsStateService(env.DB);

/** Raw-row helper for asserting what is actually stored. */
const rawRow = async (oid: string): Promise<{ state: string; size: number; updated_at: number } | null> =>
  env.DB.prepare("SELECT state, size, updated_at FROM lfs_objects WHERE repo_id = ? AND oid = ?")
    .bind(REPO, oid)
    .first();

beforeAll(applyLfsObjectsDdl);
beforeEach(resetLfsTables);

describe("ensureUploading (idempotent batch row)", () => {
  it("inserts an uploading row and refreshes it on re-batch", async () => {
    await service().ensureUploading(REPO, OID, 100, NOW);
    expect(await rawRow(OID)).toMatchObject({ state: "uploading", size: 100 });

    const later = new Date(NOW.getTime() + DEFAULT_STALE_UPLOADING_AFTER_SECONDS * 1000);
    await service().ensureUploading(REPO, OID, 100, later);
    const row = await rawRow(OID);
    expect(row?.state).toBe("uploading");
    expect(row?.updated_at).toBe(Math.floor(later.getTime() / 1000));
    expect(await service().get(REPO, OID)).toMatchObject({ repoId: REPO, oid: OID, size: 100, state: "uploading" });
  });

  it("is per-repo: same oid in another repo is an independent row", async () => {
    await service().ensureUploading(REPO, OID, 100, NOW);
    await service().ensureUploading(REPO + 1, OID, 200, NOW);
    expect((await service().get(REPO, OID))?.size).toBe(100);
    expect((await service().get(REPO + 1, OID))?.size).toBe(200);
  });

  it("missing rows read as null", async () => {
    expect(await service().get(REPO, OID)).toBeNull();
  });
});

describe("markVerified (verify handler flip)", () => {
  it("flips uploading → verified and reports no-op for absent rows", async () => {
    await service().ensureUploading(REPO, OID, 100, NOW);
    expect(await service().markVerified(REPO, OID, NOW)).toBe(true);
    expect(await rawRow(OID)).toMatchObject({ state: "verified" });
    expect(await service().markVerified(REPO, OID2, NOW)).toBe(false);
  });
});

describe("adopt (§3.3)", () => {
  const head = (stat: { size: number; sha256Hex: string | null } | null) => (): Promise<
    { size: number; sha256Hex: string | null } | null
  > => Promise.resolve(stat);

  it("inserts as verified when HEAD matches size and checksum", async () => {
    const ok = await service().adopt(REPO, OID, 100, head({ size: 100, sha256Hex: OID }), { now: NOW });
    expect(ok).toBe(true);
    expect(await rawRow(OID)).toMatchObject({ state: "verified", size: 100 });
  });

  it("accepts a checksum-less HEAD only when checksums are not required", async () => {
    const stat = { size: 100, sha256Hex: null };
    expect(await service().adopt(REPO, OID, 100, head(stat), { now: NOW })).toBe(true);
    expect(await service().adopt(REPO, OID2, 100, head(stat), { now: NOW, requireChecksum: true })).toBe(false);
  });

  it("rejects size mismatch and checksum mismatch without writing", async () => {
    expect(await service().adopt(REPO, OID, 100, head({ size: 101, sha256Hex: OID }), { now: NOW })).toBe(false);
    expect(await service().adopt(REPO, OID, 100, head({ size: 100, sha256Hex: OID2 }), { now: NOW })).toBe(false);
    expect(await service().adopt(REPO, OID, 100, head(null), { now: NOW })).toBe(false);
    expect(await service().get(REPO, OID)).toBeNull();
  });

  it("validateAdoptStat is case-insensitive on stored hex and size-strict", () => {
    expect(validateAdoptStat({ size: 5, sha256Hex: OID.toUpperCase() }, OID, 5)).toBe(true);
    expect(validateAdoptStat({ size: 6, sha256Hex: OID }, OID, 5)).toBe(false);
    expect(validateAdoptStat({ size: 5, sha256Hex: OID2 }, OID, 5)).toBe(false);
    expect(validateAdoptStat(null, OID, 5)).toBe(false);
  });
});

describe("quota projection", () => {
  it("sums every row of the repo (uploading included, conservative)", async () => {
    await service().ensureUploading(REPO, OID, 100, NOW);
    await service().insertVerified(REPO, OID2, 250, NOW);
    expect(await service().sumSize(REPO)).toBe(350);
    expect(await service().sumSize(REPO + 1)).toBe(0);
  });
});

describe("stale-uploading sweep queries (§3.4)", () => {
  const HOUR = 60 * 60 * 1000;

  it("fans out per repo, lists only stale rows, promotes valid objects, deletes missing", async () => {
    const past = new Date(NOW.getTime() - 25 * HOUR);
    const fresh = new Date(NOW.getTime() - 1 * HOUR);

    await service().ensureUploading(REPO, OID, 100, past); // stale, object present
    await service().ensureUploading(REPO, OID2, 200, past); // stale, object missing
    await service().ensureUploading(REPO + 1, OID, 300, fresh); // not stale

    const cutoff = new Date(NOW.getTime() - DEFAULT_STALE_UPLOADING_AFTER_SECONDS * 1000);
    expect(await service().repoIdsWithStaleUploading(cutoff)).toEqual([REPO]);
    expect(await service().repoIdsWithStaleUploading(new Date(NOW.getTime() + 1000))).toEqual([REPO, REPO + 1]);

    const listed = await service().listStaleUploading(REPO, cutoff);
    expect(listed.map((row) => row.oid).sort()).toEqual([OID, OID2].sort());

    let heads = 0;
    const headPresent = (oid: string): Promise<{ size: number; sha256Hex: string } | null> => {
      heads++;
      return oid === OID ? Promise.resolve({ size: 100, sha256Hex: OID }) : Promise.resolve(null);
    };
    const outcome = await service().sweepStaleUploading(REPO, cutoff, headPresent, { now: NOW });
    expect(outcome).toEqual({ promoted: [OID], deleted: [OID2] });
    expect(heads).toBe(2);
    expect(await rawRow(OID)).toMatchObject({ state: "verified" });
    expect(await service().get(REPO, OID2)).toBeNull();
    // The fresh row in the other repo is untouched by this repo's sweep.
    expect(await service().get(REPO + 1, OID)).toMatchObject({ state: "uploading" });
  });

  it("sweep validation rejects checksum mismatches (row is deleted, object GC'd later)", async () => {
    await service().ensureUploading(REPO, OID, 100, new Date(NOW.getTime() - 48 * HOUR));
    const cutoff = new Date(NOW.getTime() - DEFAULT_STALE_UPLOADING_AFTER_SECONDS * 1000);
    const outcome = await service().sweepStaleUploading(
      REPO,
      cutoff,
      () => Promise.resolve({ size: 100, sha256Hex: OID2 }),
      { now: NOW },
    );
    expect(outcome.deleted).toEqual([OID]);
  });});

describe("GC candidates + reachability predicate (§3.4)", () => {
  it("lists only verified rows older than both created and updated grace, paged by keyset", async () => {
    const old = new Date("2026-10-01T00:00:00Z");
    const recent = new Date("2026-10-23T00:00:00Z");

    await service().insertVerified(REPO, "aa".repeat(32), 1, old); // candidate
    await service().insertVerified(REPO, "cc".repeat(32), 2, old); // candidate
    await service().insertVerified(REPO, "bb".repeat(32), 3, recent); // within grace
    await service().ensureUploading(REPO, "dd".repeat(32), 4, old); // wrong state

    const grace = { olderThan: new Date("2026-10-10T00:00:00Z"), updatedLessRecentlyThan: new Date("2026-10-10T00:00:00Z") };
    const page1 = await service().listGcCandidates(REPO, grace, { limit: 1 });
    expect(page1.map((row) => row.oid)).toEqual(["aa".repeat(32)]);
    const page2 = await service().listGcCandidates(REPO, grace, { limit: 10, afterOid: page1[0]?.oid });
    expect(page2.map((row) => row.oid)).toEqual(["cc".repeat(32)]);
  });

  it("isLfsObjectUnreachable asks hasBlob with the pointer blob sha1", async () => {
    const pointer = { oid: OID, size: 123 };
    const expectedSha1 = await pointerBlobSha1(pointer);
    expect(expectedSha1).toMatch(/^[0-9a-f]{40}$/);

    const seen: string[] = [];
    const gone = await isLfsObjectUnreachable(pointer, (sha1) => {
      seen.push(sha1);
      return Promise.resolve(false);
    });
    expect(gone).toBe(true);
    expect(seen).toEqual([expectedSha1]);

    expect(await isLfsObjectUnreachable(pointer, () => Promise.resolve(true))).toBe(false);
  });

  it("the pointer blob sha1 is of the canonical pointer text (generate → hash)", async () => {
    const pointer = { oid: OID, size: 123 };
    const canonical = generatePointer(pointer.oid, pointer.size);
    const header = new TextEncoder().encode(`blob ${canonical.byteLength}\0`);
    const combined = new Uint8Array(header.byteLength + canonical.byteLength);
    combined.set(header);
    combined.set(canonical, header.byteLength);
    const expected = [...new Uint8Array(await crypto.subtle.digest("SHA-1", combined))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    expect(await pointerBlobSha1(pointer)).toBe(expected);
  });
});
