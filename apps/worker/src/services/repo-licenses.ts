/**
 * Repo licenses storage + detection glue (long-tail batch; the `repo_license`
 * table of migration 0027). Upstream: the table is the PUSH-time product of
 * services/repository/license.go — resolveLicenses walks the default branch's
 * tree, matches license files against the licenseclassifier corpus, and
 * UpdateRepoLicenses diffs the rows (models/repo/license.go:81-122);
 * `GET /repos/{owner}/{repo}/licenses` reads the rows (GetRepoLicenses,
 * :66-73, `ORDER BY license ASC`).
 *
 * SCOPE OF THIS PORT (the mission's "detection GLUE" state):
 *   - the table, the GetRepoLicenses read, the UpdateRepoLicenses diff and
 *     CleanRepoLicenses are ported (below);
 *   - the detection GLUE is ported structurally: the REUSE arm
 *     (LICENSES/ directory — license.go:112-131, SPDX ID = the file stem, NO
 *     classifier needed) and the license-FILE-name predicate isLicenseFile
 *     (license.go:139-149) are exact ports, exercised over fixture trees;
 *   - the corpus MATCHER is NOT ported: upstream embeds
 *     github.com/google/licenseclassifier v2 plus the full license corpus
 *     (InitLicenseClassifier, license.go:41-58) — out of slice. Root-level
 *     license files are detected as FILES but yield no SPDX id unless the
 *     caller injects a text detector (resolveDetectedLicenses' second
 *     parameter), so nothing is invented.
 *   - the push pipeline does NOT call any of this yet (no hook in the
 *     git-http receive path) — rows stay unpopulated and the endpoint
 *     honestly answers []. Wiring the push/queue arm is the mapped
 *     follow-up; the endpoint needs no change when it lands.
 */

import { and, asc, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repoLicenses } from "../db/schema";

export type RepoLicenseRow = typeof repoLicenses.$inferSelect;

/** Upstream DetectedLicense (models/repo/license.go:39-45). */
export interface DetectedLicense {
  /** SPDXID of the license. */
  spdxId: string;
  /** Repo-relative path to the license. */
  licensePath: string;
}

/** REUSE license spec directory (license.go:29-31, LicenseReuseDir). */
export const LICENSE_REUSE_DIR = "LICENSES";

/**
 * One entry of the fixture/candidate tree the resolver walks. `read` is
 * only called for root-level license-file candidates (never for REUSE-dir
 * files — the REUSE SPDX id comes from the file NAME).
 */
export interface LicenseTreeEntry {
  /** Repo-relative slash path, e.g. "LICENSE", "LICENSES/MIT.txt". */
  path: string;
  /** Regular-file predicate (upstream entry.IsRegular). */
  isRegular: boolean;
  read?: () => Promise<string> | string;
}

/** util.PathBaseStem (modules/util/path.go:32-34): base name minus ext. */
export function pathBaseStem(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * isLicenseFile (license.go:139-149): stem license|licence|copying, at most
 * one allowed extension (.md/.lesser/.txt or none). Case-insensitive.
 */
export function isLicenseFile(name: string): boolean {
  const lower = name.toLowerCase();
  const stem = pathBaseStem(lower);
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot) : "";
  return (
    (stem === "license" || stem === "licence" || stem === "copying") &&
    (ext === "" || ext === ".md" || ext === ".lesser" || ext === ".txt")
  );
}

/**
 * resolveLicenses (license.go:151-193) over a flat tree listing. REUSE first:
 * any LICENSES/ entry claims the whole resolution (upstream's early return
 * from the SubTree hit, :160-165) — every regular file under it becomes
 * DetectedLicense{SPDXID: file stem, LicensePath: full path} and root files
 * are ignored. Otherwise the root-level regular files that pass
 * isLicenseFile go to the detector; without one (or with no match) they are
 * skipped — no corpus, no invented SPDX ids.
 */
export async function resolveDetectedLicenses(
  entries: LicenseTreeEntry[],
  detectText?: (content: string) => string[],
): Promise<DetectedLicense[]> {
  const reuse = entries.filter((entry) => entry.path.startsWith(`${LICENSE_REUSE_DIR}/`));
  if (reuse.length > 0) {
    return reuse
      .filter((entry) => entry.isRegular)
      .map((entry) => ({ spdxId: pathBaseStem(entry.path), licensePath: entry.path }));
  }

  const detected: DetectedLicense[] = [];
  for (const entry of entries) {
    if (entry.path.includes("/")) continue; // root level only (upstream: root SubTree)
    if (!entry.isRegular || !isLicenseFile(entry.path)) continue;
    if (detectText === undefined || entry.read === undefined) continue;
    const content = await entry.read();
    for (const spdxId of detectText(content)) {
      detected.push({ spdxId, licensePath: entry.path });
    }
  }
  return detected;
}

/**
 * GetRepoLicenses (license.go:66-73): one repo's rows, `license` ascending —
 * the endpoint's exact read.
 */
export async function getRepoLicenses(d1: D1Database, repoId: string): Promise<RepoLicenseRow[]> {
  return drizzle(d1)
    .select()
    .from(repoLicenses)
    .where(eq(repoLicenses.repoId, repoId))
    .orderBy(asc(repoLicenses.license))
    .all();
}

/** CleanRepoLicenses (license.go:171-174): drop every row of the repo. */
export async function cleanRepoLicenses(d1: D1Database, repoId: string): Promise<void> {
  await drizzle(d1).delete(repoLicenses).where(eq(repoLicenses.repoId, repoId));
}

/**
 * UpdateRepoLicenses (license.go:81-122): the population diff the push arm
 * will call. Per incoming license — matching SPDX id updates commit_id +
 * license_path in place; a new SPDX id inserts; existing rows whose
 * commit_id fell behind the scan are deleted (the "moved past this commit"
 * sweep, :109-118).
 */
export async function updateRepoLicenses(
  d1: D1Database,
  repoId: string,
  commitId: string,
  licenses: DetectedLicense[],
): Promise<void> {
  const db = drizzle(d1);
  const oldRows = await db.select().from(repoLicenses).where(eq(repoLicenses.repoId, repoId)).all();
  const now = new Date();
  for (const license of licenses) {
    const existing = oldRows.find((row) => row.license === license.spdxId);
    if (existing !== undefined) {
      // Mutate the in-memory row like upstream (license.go:95-97: o.CommitID
      // / o.LicensePath are assigned BEFORE the UPDATE) — the delete sweep
      // below reads the same objects and must see the fresh commit_id.
      existing.commitId = commitId;
      existing.licensePath = license.licensePath;
      await db
        .update(repoLicenses)
        .set({ commitId, licensePath: license.licensePath, updatedAt: now })
        .where(eq(repoLicenses.id, existing.id));
      continue;
    }
    await db.insert(repoLicenses).values({
      repoId,
      commitId,
      license: license.spdxId,
      licensePath: license.licensePath,
      createdAt: now,
      updatedAt: now,
    });
  }
  for (const row of oldRows) {
    if (row.commitId !== commitId) {
      await db.delete(repoLicenses).where(and(eq(repoLicenses.id, row.id), ne(repoLicenses.repoId, "")));
    }
  }
}
