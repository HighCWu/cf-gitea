/**
 * The package model service (SPEC-0016 §2.2/§4/§5) — the D1 half over the six
 * tables (schema.ts, migration 0039): the GetOrInsert shapes upstream's
 * models answer duplicates with (§5.2), the descriptor assembly the API
 * renders (upstream descriptor.go:56-77), the list queries the management ops
 * need (SearchVersions / SearchLatestVersions), the link/unlink pair
 * (package_update.go), the delete cascades, the quota checks
 * (packages.go:366-457 with our §3.4 config surface), and the owner access
 * mode (determineAccessMode, services/context/package.go:112-166, folded per
 * §4.1 onto the landed org model — including HasOrgOrUserVisible's
 * membership floor, org.go:458-461, so a private org's plain member reads).
 *
 * Routes are thin over THIS module (AGENTS.md: business logic lives in
 * services); D1 access goes through Drizzle only. No Durable Object: the
 * mutation arbiter is the D1 UNIQUE constraints (§4.3) — every
 * get-or-insert re-selects on a lost insert race, so concurrent publishes
 * converge on one row exactly like upstream's constraint-guarded inserts.
 */

import { and, asc, desc, eq, inArray, like, lt, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  orgMembers,
  packageBlobs,
  packageCleanupRules,
  packageFiles,
  packageProperties,
  packageVersions,
  packages,
  teamMembers,
  teams,
} from "../../db/schema";

// ---------------------------------------------------------------------------
// Row types + upstream property-type iota
// ---------------------------------------------------------------------------

export type PackageRow = typeof packages.$inferSelect;
export type PackageVersionRow = typeof packageVersions.$inferSelect;
export type PackageFileRow = typeof packageFiles.$inferSelect;
export type PackageBlobRow = typeof packageBlobs.$inferSelect;
export type PackageCleanupRuleRow = typeof packageCleanupRules.$inferSelect;

/** Upstream PropertyType iota (package_property.go:22-27). */
export const PropertyType = {
  Version: 0,
  File: 1,
  Package: 2,
} as const;

/** Upstream AccessMode, as our team/visibility enums spell it. */
export type PackageAccessMode = "none" | "read" | "write" | "admin" | "owner";

const ACCESS_MODE_RANK: Record<PackageAccessMode, number> = {
  none: 0,
  read: 1,
  write: 2,
  admin: 3,
  owner: 4,
};

export function accessModeAtLeast(mode: PackageAccessMode, required: PackageAccessMode): boolean {
  return ACCESS_MODE_RANK[mode] >= ACCESS_MODE_RANK[required];
}

// ---------------------------------------------------------------------------
// GetOrInsert shapes (§5.2) — duplicate arbitration on the D1 UNIQUEs
// ---------------------------------------------------------------------------

export interface GetOrInsertPackageInput {
  ownerId: number;
  type: string;
  /** Display-cased name; the lower-cased twin is the uniqueness key. */
  name: string;
  semverCompatible?: boolean;
  now?: Date;
}

/**
 * `TryInsertPackage` (package.go:203-213): `UNIQUE(owner_id, type,
 * lower_name)` arbitrates — the duplicate answers the EXISTING row (the
 * GetOrInsert shape; upstream's ErrDuplicatePackage never reaches the
 * protocol layer through this helper).
 */
export async function getOrInsertPackage(
  d1: D1Database,
  input: GetOrInsertPackageInput,
): Promise<{ row: PackageRow; created: boolean }> {
  const db = drizzle(d1);
  const lowerName = input.name.toLowerCase();
  const existing = await db
    .select()
    .from(packages)
    .where(and(eq(packages.ownerId, input.ownerId), eq(packages.type, input.type), eq(packages.lowerName, lowerName)))
    .get();
  if (existing !== undefined) {
    return { row: existing, created: false };
  }
  const inserted = await db
    .insert(packages)
    .values({
      ownerId: input.ownerId,
      type: input.type,
      name: input.name,
      lowerName,
      semverCompatible: input.semverCompatible ?? false,
      isInternal: false,
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0];
  if (row !== undefined) {
    return { row, created: true };
  }
  const winner = await db
    .select()
    .from(packages)
    .where(and(eq(packages.ownerId, input.ownerId), eq(packages.type, input.type), eq(packages.lowerName, lowerName)))
    .get();
  if (winner === undefined) {
    throw new Error("package insert raced and the identity lookup then missed");
  }
  return { row: winner, created: false };
}

export interface GetOrInsertVersionInput {
  packageId: number;
  creatorId: number;
  version: string;
  now?: Date;
}

export class DuplicatePackageVersionError extends Error {
  constructor(readonly existing: PackageVersionRow) {
    super("package version already exists");
    this.name = "DuplicatePackageVersionError";
  }
}

/**
 * `GetOrInsertVersion` (package_version.go:48-67): `UNIQUE(package_id,
 * lower_version)` arbitrates. The duplicate answers the EXISTING row AND
 * carries the ErrDuplicatePackageVersion sentinel (upstream returns both) —
 * callers that accept re-publishes (generic) ignore it; callers that need
 * the distinction read `created`.
 */
export async function getOrInsertVersion(
  d1: D1Database,
  input: GetOrInsertVersionInput,
): Promise<{ row: PackageVersionRow; created: boolean }> {
  const db = drizzle(d1);
  const lowerVersion = input.version.toLowerCase();
  const existing = await db
    .select()
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, input.packageId), eq(packageVersions.lowerVersion, lowerVersion)))
    .get();
  if (existing !== undefined) {
    return { row: existing, created: false };
  }
  const inserted = await db
    .insert(packageVersions)
    .values({
      packageId: input.packageId,
      creatorId: input.creatorId,
      version: input.version,
      lowerVersion,
      createdUnix: input.now ?? new Date(),
      isInternal: false,
      metadataJson: null,
      downloadCount: 0,
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0];
  if (row !== undefined) {
    return { row, created: true };
  }
  const winner = await db
    .select()
    .from(packageVersions)
    .where(and(eq(packageVersions.packageId, input.packageId), eq(packageVersions.lowerVersion, lowerVersion)))
    .get();
  if (winner === undefined) {
    throw new Error("package version insert raced and the identity lookup then missed");
  }
  return { row: winner, created: false };
}

export interface TryInsertFileInput {
  versionId: number;
  blobId: number;
  name: string;
  isLead?: boolean;
  /** The maven/conan disambiguator; always '' (EmptyFileKey) in v1. */
  compositeKey?: string;
  now?: Date;
}

/** The three outcomes the raw layer pins for a duplicate file (see
 *  tryInsertFile — only the OverwriteExisting callers accept "identical"). */
export type InsertFileResult =
  | { outcome: "created"; row: PackageFileRow }
  | { outcome: "identical"; row: PackageFileRow } // same key + same blob → the OverwriteExisting short-circuit
  | { outcome: "conflict"; row: PackageFileRow }; // same key + DIFFERENT bytes (the OverwriteExisting replace arm)

/**
 * The raw file-insert layer over `TryInsertFile`'s UNIQUE(version_id,
 * lower_name, composite_key). Upstream's TryInsertFile (package_file.go:46-66)
 * itself answers ErrDuplicatePackageFile for ANY existing row regardless of
 * blob; the "identical" outcome here is the raw layer's SAME-BLOB answer,
 * consumed ONLY by the OverwriteExisting callers (helm's re-publish
 * short-circuit, packages.go:326-329 — the delete-and-reinsert arm never
 * reaches TryInsertFile). The TryInsertFile-level callers (generic, pypi,
 * nuget) map EVERY duplicate — identical or not — to the 409
 * (ErrDuplicatePackageFile → routes' StatusConflict, generic.go:126-127 /
 * pypi.go:197-198; the packages parity review's D-1).
 */
export async function tryInsertFile(d1: D1Database, input: TryInsertFileInput): Promise<InsertFileResult> {
  const db = drizzle(d1);
  const lowerName = input.name.toLowerCase();
  const compositeKey = input.compositeKey ?? "";
  const existing = await db
    .select()
    .from(packageFiles)
    .where(
      and(
        eq(packageFiles.versionId, input.versionId),
        eq(packageFiles.lowerName, lowerName),
        eq(packageFiles.compositeKey, compositeKey),
      ),
    )
    .get();
  if (existing !== undefined) {
    return existing.blobId === input.blobId
      ? { outcome: "identical", row: existing }
      : { outcome: "conflict", row: existing };
  }
  const inserted = await db
    .insert(packageFiles)
    .values({
      versionId: input.versionId,
      blobId: input.blobId,
      name: input.name,
      lowerName,
      compositeKey,
      isLead: input.isLead ?? false,
      createdUnix: input.now ?? new Date(),
    })
    .onConflictDoNothing()
    .returning();
  const row = inserted[0];
  if (row !== undefined) {
    return { outcome: "created", row };
  }
  // A concurrent insert won the UNIQUE — apply the same bytes rule to its row.
  const winner = await db
    .select()
    .from(packageFiles)
    .where(
      and(
        eq(packageFiles.versionId, input.versionId),
        eq(packageFiles.lowerName, lowerName),
        eq(packageFiles.compositeKey, compositeKey),
      ),
    )
    .get();
  if (winner === undefined) {
    throw new Error("package file insert raced and the identity lookup then missed");
  }
  return winner.blobId === input.blobId ? { outcome: "identical", row: winner } : { outcome: "conflict", row: winner };
}

// ---------------------------------------------------------------------------
// Lookups (the protocol + management read path)
// ---------------------------------------------------------------------------

/** `GetPackageByName` (package.go) — case-insensitive identity lookup. */
export async function getPackageByName(
  d1: D1Database,
  ownerId: number,
  type: string,
  name: string,
): Promise<PackageRow | null> {
  return (
    (await drizzle(d1)
      .select()
      .from(packages)
      .where(and(eq(packages.ownerId, ownerId), eq(packages.type, type), eq(packages.lowerName, name.toLowerCase())))
      .get()) ?? null
  );
}

/** `GetVersionByNameAndVersion` (package_version.go) — the owner-scoped join. */
export async function getVersionByNameAndVersion(
  d1: D1Database,
  ownerId: number,
  type: string,
  name: string,
  version: string,
): Promise<PackageVersionRow | null> {
  return (
    (await drizzle(d1)
      .select({ version: packageVersions })
      .from(packageVersions)
      .innerJoin(packages, eq(packages.id, packageVersions.packageId))
      .where(
        and(
          eq(packages.ownerId, ownerId),
          eq(packages.type, type),
          eq(packages.lowerName, name.toLowerCase()),
          eq(packageVersions.lowerVersion, version.toLowerCase()),
        ),
      )
      .get())?.version ?? null
  );
}

/** `GetFileForVersionByName` (package_file.go:100-121) — EmptyFileKey default. */
export async function getFileForVersionByName(
  d1: D1Database,
  versionId: number,
  name: string,
  compositeKey = "",
): Promise<PackageFileRow | null> {
  if (name === "") return null;
  return (
    (await drizzle(d1)
      .select()
      .from(packageFiles)
      .where(
        and(
          eq(packageFiles.versionId, versionId),
          eq(packageFiles.lowerName, name.toLowerCase()),
          eq(packageFiles.compositeKey, compositeKey),
        ),
      )
      .get()) ?? null
  );
}

/** `GetFilesByVersionID` (package_file.go:63-65) — lower_name, created, id order. */
export async function listFilesByVersion(d1: D1Database, versionId: number): Promise<PackageFileRow[]> {
  return drizzle(d1)
    .select()
    .from(packageFiles)
    .where(eq(packageFiles.versionId, versionId))
    .orderBy(asc(packageFiles.lowerName), asc(packageFiles.createdUnix), asc(packageFiles.id))
    .all();
}

/** `IncrementDownloadCounter` (package_version.go:76-79) — the bare x+1 (§5.8). */
export async function incrementDownloadCounter(d1: D1Database, versionId: number): Promise<void> {
  await drizzle(d1)
    .update(packageVersions)
    .set({ downloadCount: sql`${packageVersions.downloadCount} + 1` })
    .where(eq(packageVersions.id, versionId))
    .run();
}

// ---------------------------------------------------------------------------
// The descriptor assembly (descriptor.go:56-77) — the read shape every
// management op renders
// ---------------------------------------------------------------------------

export interface PackageFileDescriptor {
  file: PackageFileRow;
  blob: PackageBlobRow;
}

export interface PackageDescriptor {
  pkg: PackageRow;
  version: PackageVersionRow;
  files: PackageFileDescriptor[];
}

/** `GetFilesAndBlobsByVersionID` — files joined to their blob rows. */
export async function getFileDescriptors(d1: D1Database, versionId: number): Promise<PackageFileDescriptor[]> {
  const rows = await drizzle(d1)
    .select({ file: packageFiles, blob: packageBlobs })
    .from(packageFiles)
    .innerJoin(packageBlobs, eq(packageBlobs.id, packageFiles.blobId))
    .where(eq(packageFiles.versionId, versionId))
    .orderBy(asc(packageFiles.lowerName), asc(packageFiles.createdUnix), asc(packageFiles.id))
    .all();
  return rows;
}

export async function getPackageDescriptor(
  d1: D1Database,
  pkg: PackageRow,
  version: PackageVersionRow,
): Promise<PackageDescriptor> {
  return { pkg, version, files: await getFileDescriptors(d1, version.id) };
}

// ---------------------------------------------------------------------------
// Search — upstream SearchVersions / SearchLatestVersions reduced to the
// filters the 9 ops + admin list actually pass (owner, repo, type, name,
// is-internal false, page/limit)
// ---------------------------------------------------------------------------

export interface PackageSearchOptions {
  ownerId?: number;
  repoId?: string;
  type?: string;
  /** Name filter; `exact` pins the lower-cased equality (path-param lookups). */
  name?: string;
  exact?: boolean;
  /** Pin both is-internal columns false — every landed op passes true for this. */
  excludeInternal?: boolean;
  page?: number;
  limit?: number;
}

/** The shared WHERE builder over the joined package/package_version pair. */
function searchConditions(opts: PackageSearchOptions): SQL[] {
  const conditions: SQL[] = [];
  if (opts.ownerId !== undefined) conditions.push(eq(packages.ownerId, opts.ownerId));
  if (opts.repoId !== undefined) conditions.push(eq(packages.repoId, opts.repoId));
  if (opts.type !== undefined && opts.type !== "") conditions.push(eq(packages.type, opts.type));
  if (opts.name !== undefined && opts.name !== "") {
    conditions.push(
      opts.exact
        ? eq(packages.lowerName, opts.name.toLowerCase())
        : like(packages.lowerName, `%${opts.name.toLowerCase()}%`),
    );
  }
  if (opts.excludeInternal) {
    conditions.push(eq(packages.isInternal, false));
    conditions.push(eq(packageVersions.isInternal, false));
  }
  return conditions;
}

function searchResultsQuery(d1: D1Database, opts: PackageSearchOptions) {
  return drizzle(d1)
    .select({ version: packageVersions, pkg: packages })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(and(...searchConditions(opts)));
}

/**
 * `SearchVersions` (package_version.go:398-405): the joined pair filtered by
 * the options, `created_unix DESC, id DESC` (the configureOrderBy default,
 * :277-291 — §5.7's insertion-recency order), plus the total count for the
 * pagination headers.
 */
export async function searchVersions(
  d1: D1Database,
  opts: PackageSearchOptions,
): Promise<{ rows: { version: PackageVersionRow; pkg: PackageRow }[]; count: number }> {
  const filtered = searchResultsQuery(d1, opts);
  const page = Math.max(opts.page ?? 1, 1);
  const limit = Math.max(opts.limit ?? 10, 1);
  const rows = await filtered
    .orderBy(desc(packageVersions.createdUnix), desc(packageVersions.id))
    .limit(limit)
    .offset((page - 1) * limit)
    .all();
  const counted = await drizzle(d1)
    .select({ total: sql<number>`count(*)` })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(and(...searchConditions(opts)))
    .all();
  return { rows, count: counted[0]?.total ?? 0 };
}

/**
 * `SearchLatestVersions` (package_version.go:320-330): the MAX(id) GROUP BY
 * package_id subquery over the joined pair — the latest-version-per-package
 * shape the owner list (listPackages), the admin list and the R04/R16 tabs
 * render.
 */
export async function searchLatestVersions(
  d1: D1Database,
  opts: PackageSearchOptions,
): Promise<{ rows: { version: PackageVersionRow; pkg: PackageRow }[]; count: number }> {
  const latestIds = drizzle(d1)
    .select({ id: sql<number>`max(${packageVersions.id})` })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(and(...searchConditions(opts)))
    .groupBy(packageVersions.packageId);
  const page = Math.max(opts.page ?? 1, 1);
  const limit = Math.max(opts.limit ?? 10, 1);
  const rows = await drizzle(d1)
    .select({ version: packageVersions, pkg: packages })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(inArray(packageVersions.id, latestIds))
    .orderBy(desc(packageVersions.createdUnix), desc(packageVersions.id))
    .limit(limit)
    .offset((page - 1) * limit)
    .all();
  const counted = await drizzle(d1)
    .select({ total: sql<number>`count(*)` })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(
      and(
        inArray(
          packageVersions.id,
          drizzle(d1)
            .select({ id: sql<number>`max(${packageVersions.id})` })
            .from(packageVersions)
            .innerJoin(packages, eq(packages.id, packageVersions.packageId))
            .where(and(...searchConditions(opts)))
            .groupBy(packageVersions.packageId),
        ),
      ),
    )
    .all();
  return { rows, count: counted[0]?.total ?? 0 };
}

// ---------------------------------------------------------------------------
// Link / unlink (package_update.go)
// ---------------------------------------------------------------------------

/** `SetRepositoryLink` — the pointer write (§5.6: repo delete unlinks, not deletes). */
export async function linkPackageToRepo(d1: D1Database, packageId: number, repoId: string): Promise<void> {
  await drizzle(d1).update(packages).set({ repoId }).where(eq(packages.id, packageId)).run();
}

/** `UnlinkRepository` — back to owner-global (repo_id NULL). */
export async function unlinkPackageFromRepo(d1: D1Database, packageId: number): Promise<void> {
  await drizzle(d1).update(packages).set({ repoId: null }).where(eq(packages.id, packageId)).run();
}

/** The §5.6 repo-delete unlink arm (`UPDATE packages SET repo_id = NULL WHERE repo_id = ?`) —
 *  exported for the repos delete cascade to fold (a service arm, not a purge change). */
export async function unlinkPackagesOfRepo(d1: D1Database, repoId: string): Promise<void> {
  await drizzle(d1).update(packages).set({ repoId: null }).where(eq(packages.repoId, repoId)).run();
}

// ---------------------------------------------------------------------------
// Delete cascades (packages.go:490-600)
// ---------------------------------------------------------------------------

/** `DeleteAllProperties` — one ref-type/ref-id fan. */
async function deleteProperties(d1: D1Database, refType: number, refId: number): Promise<void> {
  await drizzle(d1)
    .delete(packageProperties)
    .where(and(eq(packageProperties.refType, refType), eq(packageProperties.refId, refId)))
    .run();
}

/** `DeleteFilePropertiesByVersionID` + `DeleteFilesByVersionID` + the version row. */
export async function deletePackageVersionAndReferences(d1: D1Database, versionId: number): Promise<void> {
  const db = drizzle(d1);
  const fileIds = await db
    .select({ id: packageFiles.id })
    .from(packageFiles)
    .where(eq(packageFiles.versionId, versionId))
    .all();
  if (fileIds.length > 0) {
    await db
      .delete(packageProperties)
      .where(
        and(
          eq(packageProperties.refType, PropertyType.File),
          inArray(
            packageProperties.refId,
            fileIds.map((f) => f.id),
          ),
        ),
      )
      .run();
    await db.delete(packageFiles).where(eq(packageFiles.versionId, versionId)).run();
  }
  await deleteProperties(d1, PropertyType.Version, versionId);
  await db.delete(packageVersions).where(eq(packageVersions.id, versionId)).run();
}

/** `DeletePackageFile` — the file row + its properties. */
export async function deletePackageFile(d1: D1Database, fileId: number): Promise<void> {
  await deleteProperties(d1, PropertyType.File, fileId);
  await drizzle(d1).delete(packageFiles).where(eq(packageFiles.id, fileId)).run();
}

/** `HasVersionFileReferences` (package_version.go) — the unlink-file fallback's gate. */
export async function hasVersionFileReferences(d1: D1Database, versionId: number): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ id: packageFiles.id })
    .from(packageFiles)
    .where(eq(packageFiles.versionId, versionId))
    .limit(1)
    .all();
  return rows.length > 0;
}

/**
 * `RemovePackage`'s cascade (packages.go:676+): every version's files and
 * properties, the package-scoped properties, then the package row. The R2
 * content keys are NOT touched here — the unreferenced-blob sweep is the
 * SOLE content-key deleter (the PACKAGE-DEFER-STORAGE-DELETE hint upstream
 * carries + ratification 4).
 */
export async function deletePackageAndReferences(d1: D1Database, packageId: number): Promise<void> {
  const db = drizzle(d1);
  const versionIds = await db
    .select({ id: packageVersions.id })
    .from(packageVersions)
    .where(eq(packageVersions.packageId, packageId))
    .all();
  for (const version of versionIds) {
    await deletePackageVersionAndReferences(d1, version.id);
  }
  await deleteProperties(d1, PropertyType.Package, packageId);
  await db.delete(packages).where(eq(packages.id, packageId)).run();
}

/** `FindUnreferencedPackages` (cleanup.go:182) — package rows with zero versions. */
export async function findUnreferencedPackages(d1: D1Database): Promise<PackageRow[]> {
  return drizzle(d1)
    .select({ pkg: packages })
    .from(packages)
    .leftJoin(packageVersions, eq(packageVersions.packageId, packages.id))
    .where(sql`${packageVersions.id} IS NULL`)
    .all()
    .then((rows) => rows.map((row) => row.pkg));
}

/** `FindExpiredUnreferencedBlobs` (cleanup.go:196) — zero file references, older than cut. */
export async function findExpiredUnreferencedBlobs(d1: D1Database, cut: Date): Promise<PackageBlobRow[]> {
  return drizzle(d1)
    .select({ blob: packageBlobs })
    .from(packageBlobs)
    .leftJoin(packageFiles, eq(packageFiles.blobId, packageBlobs.id))
    .where(and(lt(packageBlobs.createdUnix, cut), sql`${packageFiles.id} IS NULL`))
    .all()
    .then((rows) => rows.map((row) => row.blob));
}

/** `DeleteBlobByID` — the row half of the sweep's delete (R2 key half is the caller's). */
export async function deleteBlobById(d1: D1Database, blobId: number): Promise<void> {
  await drizzle(d1).delete(packageBlobs).where(eq(packageBlobs.id, blobId)).run();
}

// ---------------------------------------------------------------------------
// Quota (packages.go:366-457 with the §3.4 config surface — strict-polarity
// vars read from the env slice, `-1` = unlimited, admins bypass)
// ---------------------------------------------------------------------------

/** Upstream's -1 no-limit sentinel (setting/packages.go:96-99). */
export const UNLIMITED_QUOTA = -1;

/** SPEC-0016 §3.4 — the generic per-file default (512 MiB). */
export const DEFAULT_LIMIT_SIZE_GENERIC = 512 * 1024 * 1024;

/** The env slice the quota checks read (strict polarity; absent = defaults).
 *  The optional binding picks keep `Env` assignable (the weak-type check —
 *  the AuditRetentionEnv posture). */
export interface PackagesQuotaEnv extends Partial<Pick<Env, "DB" | "REPO_PACKS">> {
  PACKAGES_LIMIT_TOTAL_OWNER_COUNT?: string;
  PACKAGES_LIMIT_TOTAL_OWNER_SIZE?: string;
  PACKAGES_LIMIT_SIZE_GENERIC?: string;
  PACKAGES_ENABLED?: string;
}

export interface PackagesQuotaConfig {
  limitTotalOwnerCount: number;
  limitTotalOwnerSize: number;
  limitSizeGeneric: number;
  packagesEnabled: boolean;
}

/** A quota var: `-1` or a non-negative integer; anything else = the default. */
function parseQuotaVar(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  if (raw === "-1") return UNLIMITED_QUOTA;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  return fallback;
}

export function packagesQuotaFromEnv(env: PackagesQuotaEnv): PackagesQuotaConfig {
  return {
    limitTotalOwnerCount: parseQuotaVar(env.PACKAGES_LIMIT_TOTAL_OWNER_COUNT, UNLIMITED_QUOTA),
    limitTotalOwnerSize: parseQuotaVar(env.PACKAGES_LIMIT_TOTAL_OWNER_SIZE, UNLIMITED_QUOTA),
    limitSizeGeneric: parseQuotaVar(env.PACKAGES_LIMIT_SIZE_GENERIC, DEFAULT_LIMIT_SIZE_GENERIC),
    // Strict polarity (the DEMO_MODE discipline): only the exact string
    // "false" disables; unset/"true"/anything else stays enabled.
    packagesEnabled: env.PACKAGES_ENABLED !== "false",
  };
}

/** `ErrQuotaTotalCount` — owner version count past the cap (403 at the protocol layer). */
export class QuotaTotalCountError extends Error {
  constructor() {
    super("maximum allowed package count exceeded");
    this.name = "QuotaTotalCountError";
  }
}

/** `ErrQuotaTypeSize` — the single upload past the per-type cap (403). */
export class QuotaTypeSizeError extends Error {
  constructor() {
    super("maximum allowed package type size exceeded");
    this.name = "QuotaTypeSizeError";
  }
}

/** `ErrQuotaTotalSize` — owner total past the cap (403). */
export class QuotaTotalSizeError extends Error {
  constructor() {
    super("maximum allowed package storage quota exceeded");
    this.name = "QuotaTotalSizeError";
  }
}

/** `CalculateFileSize` (packages.go:449-456): the owner's files' blob sizes summed. */
export async function calculateFileSize(d1: D1Database, ownerId: number): Promise<number> {
  const rows = await drizzle(d1)
    .select({ total: sql<number>`coalesce(sum(${packageBlobs.size}), 0)` })
    .from(packageFiles)
    .innerJoin(packageBlobs, eq(packageBlobs.id, packageFiles.blobId))
    .innerJoin(packageVersions, eq(packageVersions.id, packageFiles.versionId))
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(eq(packages.ownerId, ownerId))
    .all();
  return rows[0]?.total ?? 0;
}

/** `CountVersions` (packages.go:372-379): the owner's non-internal version rows. */
export async function countVersions(d1: D1Database, ownerId: number): Promise<number> {
  const rows = await drizzle(d1)
    .select({ total: sql<number>`count(*)` })
    .from(packageVersions)
    .innerJoin(packages, eq(packages.id, packageVersions.packageId))
    .where(and(eq(packages.ownerId, ownerId), eq(packages.isInternal, false), eq(packageVersions.isInternal, false)))
    .all();
  return rows[0]?.total ?? 0;
}

/**
 * `CheckSizeQuotaExceeded` (packages.go:390-457) — the per-type cap (v1
 * carries only the generic entry, §3.4) then the owner total re-computation.
 * Throws QuotaTypeSizeError / QuotaTotalSizeError (→ 403).
 */
export async function checkSizeQuotaExceeded(
  d1: D1Database,
  doerIsAdmin: boolean,
  ownerId: number,
  type: string,
  uploadSize: number,
  config: PackagesQuotaConfig,
): Promise<void> {
  if (doerIsAdmin) return;
  // The per-type lattice arrives with each ecosystem milestone (§3.4); v1
  // carries the generic entry only.
  if (type === "generic" && config.limitSizeGeneric > UNLIMITED_QUOTA && config.limitSizeGeneric < uploadSize) {
    throw new QuotaTypeSizeError();
  }
  if (config.limitTotalOwnerSize > UNLIMITED_QUOTA) {
    if ((await calculateFileSize(d1, ownerId)) + uploadSize > config.limitTotalOwnerSize) {
      throw new QuotaTotalSizeError();
    }
  }
}

// ---------------------------------------------------------------------------
// The owner access mode (determineAccessMode, services/context/
// package.go:112-166, folded per §4.1 onto the landed org model)
// ---------------------------------------------------------------------------

/** The doer shape the access ladder needs (the auth module's AuthUser slice). */
export interface PackageDoer {
  id: number;
  isAdmin: boolean;
}

/** `users.visibility` ladder input: public/limited/private. */
export type PackageOwnerVisibility = "public" | "limited" | "private";

export interface PackageOwnerRow {
  id: number;
  type: string;
  visibility: PackageOwnerVisibility;
}

/** The visibility ladder: public → anyone; limited → authenticated; private → self/admin only. */
function ownerVisible(visibility: PackageOwnerVisibility, authenticated: boolean): boolean {
  if (visibility === "public") return true;
  if (visibility === "limited") return authenticated;
  return false;
}

export function maxAccessMode(a: PackageAccessMode, b: PackageAccessMode): PackageAccessMode {
  return ACCESS_MODE_RANK[a] >= ACCESS_MODE_RANK[b] ? a : b;
}

/**
 * The §4.1 org access-mode fold (ratification 8): an org member's grants are
 * `org_members.role` ('owner' = the Owners-team bridge → owner rank) UNIONed
 * with every team row's `authorize` (≥ read → package read, ≥ write →
 * package write — no per-unit column, the landed teams collapse), floored at
 * read for ANY membership row — upstream HasOrgOrUserVisible's membership arm
 * (org.go:458-461: visibility-satisfies OR member) applied at
 * package.go:155-157, so a PLAIN member (no team row) of a private org still
 * reads, exactly as upstream's post-union fallback grants. A non-member stays
 * none and falls through to the visibility read arm.
 */
async function orgMemberAccessMode(d1: D1Database, orgId: number, doerId: number): Promise<PackageAccessMode> {
  const db = drizzle(d1);
  const memberRole = await db
    .select({ role: orgMembers.role })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, doerId)))
    .get();
  // The membership floor: any org_members row reads at least (upstream
  // HasOrgOrUserVisible org.go:458-461 via package.go:155-157); the team
  // authorize union below only raises it.
  let mode: PackageAccessMode = memberRole === undefined ? "none" : memberRole.role === "owner" ? "owner" : "read";
  // The team authorize union — every team row counts (upstream's
  // UnitAccessMode(TypePackages) loop with the per-unit overrides collapsed).
  const teamRows = await db
    .select({ authorize: teams.authorize })
    .from(teams)
    .innerJoin(teamMembers, eq(teamMembers.teamId, teams.id))
    .where(and(eq(teams.orgId, orgId), eq(teamMembers.userId, doerId)))
    .all();
  for (const team of teamRows) {
    mode = maxAccessMode(mode, team.authorize);
  }
  return mode;
}

/**
 * `determineAccessMode` (package.go:112-166) on our substrate:
 *   1. the public-only token arm (a public-only token resolving a
 *      non-public owner is blind — upstream DoerTokenAllowsOwner; the caller
 *      passes the verdict via `ownerVisibleToDoer`, false → none);
 *   2. site admin → owner mode (DoerIsSiteAdminFullAccess);
 *   3. owner self → owner mode;
 *   4. org owner: the §4.1 fold (membership role + team authorize union,
 *      floored at read for any membership row — HasOrgOrUserVisible's
 *      membership arm, org.go:458-461 via package.go:155-157), then the
 *      visibility read arm — MEMBERSHIP IS CONSULTED FIRST, so a private
 *      org's own members (team-granted OR plain) keep their read;
 *   5. user owner: public → anyone, limited → any authenticated doer,
 *      private → self/admin only.
 *
 * The default `ownerVisibleToDoer` is therefore only anonymous-blind on
 * non-public owners (the anonymous arm of the ladder); every authenticated
 * doer reaches the ladder, whose member checks and visibility arm produce
 * the mode.
 */
export async function determinePackageAccessMode(
  d1: D1Database,
  owner: PackageOwnerRow,
  doer: PackageDoer | null,
  opts: { ownerVisibleToDoer?: boolean } = {},
): Promise<PackageAccessMode> {
  const visibleToDoer =
    opts.ownerVisibleToDoer ?? (doer === null ? owner.visibility === "public" : true);
  if (!visibleToDoer) return "none";
  if (doer !== null && doer.isAdmin) return "owner";
  if (doer !== null && doer.id === owner.id) return "owner";

  if (owner.type === "org") {
    const mode = doer !== null ? await orgMemberAccessMode(d1, owner.id, doer.id) : "none";
    if (mode === "none" && ownerVisible(owner.visibility, doer !== null)) {
      return "read";
    }
    return mode;
  }

  if (doer !== null && ownerVisible(owner.visibility, true)) return "read";
  return doer === null && owner.visibility === "public" ? "read" : "none";
}
