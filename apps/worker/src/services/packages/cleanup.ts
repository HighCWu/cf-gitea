/**
 * The packages cleanup arm (SPEC-0016 §4.4) — the producer/consumer pair in
 * the SPEC-0014 §3 idiom (the audit-retention precedent,
 * services/audit.ts): an hourly cron producer SELECTs due work and enqueues
 * ONE `{kind: "package-cleanup"}` message on REPO_TASKS; the serialized
 * consumer executes the two upstream arms of CleanupTask
 * (services/packages/cleanup/cleanup.go:26-32):
 *
 *   1. `ExecuteCleanupRules` — per enabled PackageCleanupRule (keep-count /
 *      keep-pattern / remove-days / remove-pattern, case-insensitive
 *      anchored regexes, package_cleanup_rule.go:41-54), delete matching
 *      versions + references. The index-rebuild riders of upstream
 *      cleanup.go:115-145 do NOT exist in v1 (no non-generic ecosystems —
 *      they arrive per-ecosystem).
 *   2. `CleanupExpiredData` — unreferenced PACKAGE rows (zero versions left),
 *      then `package_blobs` rows with zero file references older than the
 *      window, deleting their `packages/blobs/…` R2 keys — THIS SWEEP IS THE
 *      SOLE CONTENT-KEY DELETER (ratification 4: a content key is deletable
 *      only when zero file rows reference its blob id; owner cascades and
 *      protocol deletes remove ROWS only), plus the orphan `packages/tmp/`
 *      spool objects past the window (§5.1's crash windows).
 *
 * ## Gating (ratification 5)
 *
 * NOT demo-gated — this is upstream's own midnight job
 * (`[cron.cleanup_packages]`, ENABLED=true OLDER_THAN=24h at the pin), not
 * the demo sweep's data-deletion invariant: it deletes only what upstream
 * self-hosters get (unreferenced blobs past the window + rule-matched
 * versions). The producer runs unconditionally BUT performs zero queue
 * sends unless work exists: two indexed LIMIT-1 D1 probes (enabled rule,
 * expired unreferenced blob) + one bounded R2 list page (orphan spool). The
 * window rides the `PACKAGE_CLEANUP_OLDER_THAN` var in HOURS (default 24,
 * upstream's OLDER_THAN); an invalid value falls back to the default — the
 * arm never disarms on a config typo, it only ever deletes past its window.
 *
 * A throw from the consumer retries THAT message (queue redelivery re-runs
 * the idempotent steps — everything here is a re-check of current state).
 */

import { and, eq, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  packageBlobs,
  packageCleanupRules,
  packageFiles as packageFilesProbe,
  packageProperties,
  packages,
  packageVersions,
} from "../../db/schema";
import {
  type PackageRow,
  type PackageVersionRow,
  findUnreferencedPackages,
  deletePackageVersionAndReferences,
} from "./model";
import { packageBlobContentKey } from "./blobs";

/** The REPO_TASKS message kind the producer enqueues. */
export interface PackageCleanupMessage {
  kind: "package-cleanup";
}

export function isPackageCleanupMessage(value: unknown): value is PackageCleanupMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as PackageCleanupMessage).kind === "package-cleanup"
  );
}

/** The env slice the pair touches (the AuditRetentionEnv posture — bindings
 *  optional so tests can drive unset/unbound structurally). */
export type PackagesCleanupEnv = Partial<Pick<Env, "DB" | "REPO_TASKS" | "REPO_PACKS">> & {
  /** The orphan window in HOURS (upstream OLDER_THAN=24h); invalid → default. */
  PACKAGE_CLEANUP_OLDER_THAN?: string;
};

/** Upstream's OLDER_THAN default (app.example.ini:2392). */
export const DEFAULT_CLEANUP_OLDER_THAN_HOURS = 24;

/** The window from the config var: a positive integer hour count; absent/invalid → 24. */
export function cleanupOlderThanHoursFromEnv(env: { PACKAGE_CLEANUP_OLDER_THAN?: string }): number {
  const raw = env.PACKAGE_CLEANUP_OLDER_THAN;
  if (raw === undefined || !/^\d+$/.test(raw)) return DEFAULT_CLEANUP_OLDER_THAN_HOURS;
  const hours = Number.parseInt(raw, 10);
  return hours > 0 ? hours : DEFAULT_CLEANUP_OLDER_THAN_HOURS;
}

/** Per-tick bounds (the audit prune's page posture; a throw → redelivery). */
const TMP_LIST_PAGE = 100;
const TMP_MAX_LIST_CALLS = 40;
const RULE_VERSIONS_CAP = 1000;

/**
 * The hourly producer (§4.4): unconditional (ratified non-demo-gated), but
 * THREE existence probes gate the single enqueue — an enabled rule, an
 * expired unreferenced blob, an orphan spool object past the window. No
 * probes hit → zero sends (and the probes are LIMIT-1 / one list page, so a
 * quiet deployment's tick costs three indexed reads). Returns 0 or 1.
 */
export async function enqueueDuePackagesCleanup(
  env: PackagesCleanupEnv,
  options: { now?: Date; olderThanHours?: number } = {},
): Promise<number> {
  const db = env.DB;
  const queue = env.REPO_TASKS;
  const bucket = env.REPO_PACKS;
  if (db === undefined || queue === undefined || bucket === undefined) {
    // Unbound bindings are a config bug — fail loud (the audit producer's
    // posture); the generated Env types the bindings required, this is the
    // fail-closed runtime defense.
    throw new Error("DB/REPO_TASKS/REPO_PACKS not bound (wrangler.jsonc); the packages cleanup producer cannot probe");
  }
  const hours = options.olderThanHours ?? cleanupOlderThanHoursFromEnv(env);
  const now = options.now ?? new Date();
  const cut = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const d1 = drizzle(db);

  // Probe 1: any enabled cleanup rule (package_cleanup_rules_owner_type_uq's
  // rows are few; a plain LIMIT-1 scan is the honest probe).
  const ruleDue = await d1.select({ id: packageCleanupRules.id }).from(packageCleanupRules).where(eq(packageCleanupRules.enabled, true)).limit(1);
  // Probe 2: any unreferenced blob past the window (the files-side index
  // serves the reference join; the blob created index the age filter).
  const blobDue = await d1
    .select({ id: packageBlobs.id })
    .from(packageBlobs)
    .leftJoin(packageFilesProbe, eq(packageFilesProbe.blobId, packageBlobs.id))
    .where(and(lt(packageBlobs.createdUnix, cut), sql`${packageFilesProbe.id} IS NULL`))
    .limit(1);
  // Probe 3: any orphan spool object past the window (one bounded list page).
  const spoolDue = await anyExpiredSpoolObject(bucket, cut);
  if (ruleDue.length === 0 && blobDue.length === 0 && !spoolDue) {
    console.log(`[package-cleanup] 0 due (window ${hours}h, cut ${cut.toISOString()})`);
    return 0;
  }
  await queue.sendBatch([{ body: { kind: "package-cleanup" } satisfies PackageCleanupMessage }]);
  console.log(`[package-cleanup] enqueued 1 sweep (rules=${ruleDue.length > 0} blobs=${blobDue.length > 0} spool=${spoolDue}, cut ${cut.toISOString()})`);
  return 1;
}

/** One bounded list page over the spool prefix; true when any object is past the cut. */
async function anyExpiredSpoolObject(bucket: R2Bucket, cut: Date): Promise<boolean> {
  const listed = await bucket.list({ prefix: "packages/tmp/", limit: TMP_LIST_PAGE });
  return listed.objects.some((object) => object.uploaded < cut);
}

// ---------------------------------------------------------------------------
// The consumer — CleanupTask (ExecuteCleanupRules + CleanupExpiredData)
// ---------------------------------------------------------------------------

/** An anchored case-insensitive compile of upstream `(?i)\A…\z` (rule.go:41-54). */
function compileRulePattern(pattern: string): RegExp | null {
  if (pattern === "") return null;
  try {
    return new RegExp(`^(?:${pattern})$`, "i");
  } catch {
    return null; // upstream surfaces a CompilePattern failure per rule and moves on
  }
}

/** One enabled rule's sweep over its owner+type packages (cleanup.go:61-112). */
async function executeCleanupOneRule(env: PackagesCleanupEnv, rule: typeof packageCleanupRules.$inferSelect, now: Date): Promise<void> {
  if (env.DB === undefined) throw new Error("DB not bound");
  const d1 = drizzle(env.DB);
  const keepMatcher = compileRulePattern(rule.keepPattern);
  const removeMatcher = compileRulePattern(rule.removePattern);
  if (rule.keepPattern !== "" && keepMatcher === null) {
    console.error(`[package-cleanup] rule ${rule.id}: keep pattern does not compile, skipping rule`);
    return;
  }
  if (rule.removePattern !== "" && removeMatcher === null) {
    console.error(`[package-cleanup] rule ${rule.id}: remove pattern does not compile, skipping rule`);
    return;
  }
  const olderThan = new Date(now.getTime() - rule.removeDays * 24 * 60 * 60 * 1000);
  const targets = await d1
    .select()
    .from(packages)
    .where(and(eq(packages.ownerId, rule.ownerId), eq(packages.type, rule.type)))
    .all();
  for (const pkg of targets) {
    // SearchVersions with SortCreatedDesc (cleanup.go:70-75) — created desc,
    // id desc for the stable order; capped per package per tick (a backlog
    // continues next tick; every delete is state the next run re-derives).
    const versions = await d1
      .select()
      .from(packageVersions)
      .where(and(eq(packageVersions.packageId, pkg.id), eq(packageVersions.isInternal, false)))
      .orderBy(sql`${packageVersions.createdUnix} DESC, ${packageVersions.id} DESC`)
      .limit(RULE_VERSIONS_CAP);
    const candidates: PackageVersionRow[] = [];
    for (const [index, version] of versions.entries()) {
      // keep-count: the FIRST keepCount rows of the created-desc order (the
      // newest N) always stay — upstream's positional `pvs[KeepCount:]` trim
      // (cleanup.go:78-84), not a candidate count.
      if (rule.keepCount > 0 && index < rule.keepCount) continue;
      const toMatch = rule.matchFullName ? `${pkg.lowerName}/${version.lowerVersion}` : version.lowerVersion;
      if (keepMatcher !== null && keepMatcher.test(toMatch)) continue;
      if (version.createdUnix > olderThan) continue;
      if (removeMatcher !== null && !removeMatcher.test(toMatch)) continue;
      candidates.push(version);
    }
    for (const version of candidates) {
      await deletePackageVersionAndReferences(env.DB, version.id);
    }
  }
}

/**
 * The queue consumer's work (CleanupTask, cleanup.go:26-32) — exported so the
 * REPO_TASKS dispatcher (repos/purge.ts) folds it as one typed arm and the
 * tests drive it without fabricating a MessageBatch. Idempotent: every step
 * re-checks current state, so a redelivery re-runs cleanly.
 */
export async function handlePackagesCleanup(
  env: PackagesCleanupEnv,
  options: { now?: Date; olderThanHours?: number } = {},
): Promise<void> {
  const db = env.DB;
  const bucket = env.REPO_PACKS;
  if (db === undefined) {
    throw new Error("DB not bound (wrangler.jsonc); the packages cleanup consumer cannot run");
  }
  if (bucket === undefined) {
    throw new Error("REPO_PACKS not bound (wrangler.jsonc); the packages cleanup consumer cannot run");
  }
  const hours = options.olderThanHours ?? cleanupOlderThanHoursFromEnv(env);
  const now = options.now ?? new Date();
  const cut = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const d1 = drizzle(db);

  // Arm 1 — ExecuteCleanupRules.
  const rules = await d1.select().from(packageCleanupRules).where(eq(packageCleanupRules.enabled, true)).all();
  for (const rule of rules) {
    await executeCleanupOneRule(env, rule, now);
  }

  // Arm 2 — CleanupExpiredData (cleanup.go:167-214), upstream's order:
  // unreferenced package rows first, then the expired unreferenced blobs.

  // (a) package rows with zero versions left (the rules' or a manual
  // version-delete's residue) lose their package-scoped properties + row.
  const unreferenced: PackageRow[] = await findUnreferencedPackages(db);
  for (const pkg of unreferenced) {
    await d1
      .delete(packageProperties)
      .where(and(eq(packageProperties.refType, 2), eq(packageProperties.refId, pkg.id)))
      .run();
    await d1.delete(packages).where(eq(packages.id, pkg.id)).run();
  }

  // (b) expired unreferenced blobs: the ROW delete first, then the R2 key —
  // the SOLE content-key deleter (ratification 4). Upstream carries the same
  // shape (rows deleted inside the transaction, content-store deletes after
  // it — cleanup.go:191-212): a crash between a row delete and its key
  // delete leaves an orphaned object D1 cannot see, the accepted failure
  // window both implementations share.
  const expiredBlobs = await d1
    .select({ blob: packageBlobs })
    .from(packageBlobs)
    .leftJoin(packageFilesProbe, eq(packageFilesProbe.blobId, packageBlobs.id))
    .where(and(lt(packageBlobs.createdUnix, cut), sql`${packageFilesProbe.id} IS NULL`))
    .all()
    .then((rows) => rows.map((row) => row.blob));
  for (const blob of expiredBlobs) {
    await d1.delete(packageBlobs).where(eq(packageBlobs.id, blob.id)).run();
  }
  for (const blob of expiredBlobs) {
    await bucket.delete(packageBlobContentKey(blob.hashSha256));
  }

  // (c) the orphan spool sweep (§5.1's crash windows): paged list + delete
  // over packages/tmp/ past the window, bounded like the purge prefix walk
  // (a budget overrun throws → the queue redelivers and resumes).
  let calls = 0;
  let cursor: string | undefined;
  let spoolDeleted = 0;
  for (;;) {
    const listed = await bucket.list({ prefix: "packages/tmp/", cursor, limit: TMP_LIST_PAGE });
    const expiredKeys = listed.objects.filter((object) => object.uploaded < cut).map((object) => object.key);
    if (expiredKeys.length > 0) {
      if (++calls > TMP_MAX_LIST_CALLS) throw new Error("package cleanup spool budget exceeded");
      await bucket.delete(expiredKeys);
      spoolDeleted += expiredKeys.length;
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }

  console.log(
    `[package-cleanup] swept rules=${rules.length} packages=${unreferenced.length} blobs=${expiredBlobs.length} spool=${spoolDeleted} (window ${hours}h, cut ${cut.toISOString()})`,
  );
}
