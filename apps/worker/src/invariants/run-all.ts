/**
 * Fleet-wide invariant sweeps — enumerates repositories from D1 and runs (or
 * enqueues) the per-repo checker (./check).
 *
 * Two invocation shapes, both bounded per invocation (AGENTS.md Workers
 * rules: cron triggers enqueue, consumers do the work):
 *
 *  - `enqueueRepoInvariantChecks(env)`: pages the `repositories` table and
 *    sends one REPO_TASKS message per repo (`{kind: "invariant-check", …}`).
 *    The REPO_TASKS producer binding already exists in wrangler.jsonc, so no
 *    config change is needed to ENQUEUE; consuming needs one guard clause in
 *    the shared consumer (src/repos/purge.ts — orchestrator-owned this wave):
 *
 *      if (isInvariantCheckMessage(message.body)) {
 *        await handleInvariantCheckMessage(env, message.body);
 *        message.ack();
 *        continue;
 *      }
 *
 *  - `runAllInvariantChecks(env)`: enumerate + check inline, for a future
 *    cron's `scheduled()` (or an admin endpoint). Bounded by `maxRepos` —
 *    a cron that enqueues instead should call `enqueueRepoInvariantChecks`.
 *
 *    // wrangler.jsonc (orchestrator-owned), cron wiring sketch (every 6h):
 *    // "triggers": { "crons": ["0 0,6,12,18 * * *"] }
 *    // export default { ...existing, async scheduled(_event, env, _ctx) {
 *    //   await enqueueRepoInvariantChecks(env, {});
 *    // } }
 *
 * Message family: `invariant-check` is disjoint from the existing REPO_TASKS
 * families (repo purge messages carry `engineNames: string[]`, import
 * messages carry `kind: "import-*"` + numeric importId), so the shared
 * consumer can dispatch on the guard without ambiguity.
 *
 * Repos in `creating`/`migrating` status are skipped by default: their engine
 * cells are not settled yet (push-create crash windows, import channel), and
 * flagging them would be noise — they get checked on the next sweep once
 * ready. Content violations are reported and acked (they are facts, not
 * failures); only transport-class faults throw so the queue retries.
 */

import { and, asc, gt, notInArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { checkRepoInvariants, type CheckInvariantsOptions, type InvariantReport } from "./check";
import { engineName } from "../repos/service";
import { repositories } from "../db/schema";

/** REPO_TASKS message: check one repo's invariants. */
export interface InvariantCheckMessage {
  kind: "invariant-check";
  /** combined engine name (RepoCell address) */
  engineName: string;
  /** immutable D1 storage key (R2 prefix owner) */
  storageKey: string;
}

export function isInvariantCheckMessage(value: unknown): value is InvariantCheckMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.kind === "invariant-check" && typeof v.engineName === "string" && typeof v.storageKey === "string"
  );
}

export interface RepoScanRow {
  engineName: string;
  storageKey: string;
}

/** repositories.status enum — derived from the schema, never hardcoded. */
type RepoStatus = (typeof repositories.status.enumValues)[number];

export interface EnumerateReposOptions {
  /** Hard cap on repos returned per sweep (default 500 — one invocation's
   * subrequest budget for the enqueue loop). */
  limit?: number;
  /** D1 page size for the keyset scan (default 200). */
  pageSize?: number;
  /** repositories.status values to skip (default creating/migrating). */
  skipStatuses?: RepoStatus[];
}

/** Page the repositories table by storage_key (stable, immutable, indexed)
 * and map each row to its engine addressing. Keyset pagination: a scan that
 * overlaps a concurrent create neither repeats nor skips existing rows. */
export async function enumerateRepos(env: Env, options: EnumerateReposOptions = {}): Promise<RepoScanRow[]> {
  const limit = options.limit ?? 500;
  const pageSize = options.pageSize ?? 200;
  const skipStatuses = options.skipStatuses ?? (["creating", "migrating"] as RepoStatus[]);
  const db = drizzle(env.DB);
  const rows: RepoScanRow[] = [];
  let cursor = "";
  while (rows.length < limit) {
    const batch = await db
      .select({
        ownerNamespace: repositories.ownerNamespace,
        slug: repositories.slug,
        storageKey: repositories.storageKey,
      })
      .from(repositories)
      .where(
        skipStatuses.length > 0
          ? and(gt(repositories.storageKey, cursor), notInArray(repositories.status, skipStatuses))
          : gt(repositories.storageKey, cursor),
      )
      .orderBy(asc(repositories.storageKey))
      .limit(Math.min(pageSize, limit - rows.length))
      .all();
    if (batch.length === 0) break;
    for (const row of batch) {
      rows.push({ engineName: engineName(row.ownerNamespace, row.slug), storageKey: row.storageKey });
    }
    cursor = batch[batch.length - 1]!.storageKey;
    if (batch.length < pageSize) break;
  }
  return rows;
}

/** Minimal producer surface (mirrors RepoEngineDeps.queue) so tests and
 * non-queue callers can drive the fan-out without a real Queue binding. */
export interface QueueSender {
  send(body: unknown): Promise<unknown>;
}

/** Fan one sweep's repos out as REPO_TASKS messages. Returns the enqueued
 * count. Sequential sends stay inside the invocation's subrequest budget
 * (`limit` bounds them); a partial enqueue throws and the next sweep's
 * keyset scan naturally resumes where this one stopped. */
export async function enqueueInvariantChecks(sender: QueueSender, rows: RepoScanRow[]): Promise<number> {
  for (const row of rows) {
    await sender.send({ kind: "invariant-check", engineName: row.engineName, storageKey: row.storageKey });
  }
  return rows.length;
}

/** Env-bound variant: enumerate D1 and enqueue through REPO_TASKS. */
export async function enqueueRepoInvariantChecks(env: Env, options: EnumerateReposOptions = {}): Promise<number> {
  return enqueueInvariantChecks(env.REPO_TASKS, await enumerateRepos(env, options));
}

/** One REPO_TASKS message's work: run the checker, log the outcome
 * (observability trace — the admin-notice equivalent), return the report.
 * Content violations return normally (the message acks); transport-class
 * faults propagate (the consumer's `message.retry()` redelivers). */
export async function handleInvariantCheckMessage(
  env: Env,
  message: InvariantCheckMessage,
  options: CheckInvariantsOptions = {},
): Promise<InvariantReport> {
  const report = await checkRepoInvariants(env, message, options);
  if (!report.ok) {
    const summary = report.violations.map((v) => `${v.kind}${v.ref ? ` ${v.ref}` : ""}${v.oid ? ` @${v.oid}` : ""}`).join("; ");
    console.error(
      `[invariants] ${message.engineName}: ${report.violations.length} violation(s)${report.partial ? " (partial walk)" : ""}: ${summary}`,
    );
  }
  return report;
}

/** Inline whole-fleet sweep (future cron `scheduled()` / admin trigger).
 * Bounded by `maxRepos` (default 50) so one invocation stays inside its CPU
 * and subrequest budget; larger fleets should enqueue instead. */
export async function runAllInvariantChecks(
  env: Env,
  options: EnumerateReposOptions & CheckInvariantsOptions & { maxRepos?: number } = {},
): Promise<InvariantReport[]> {
  const { maxRepos = 50, ...rest } = options;
  const enumerate: EnumerateReposOptions = {
    limit: maxRepos,
    pageSize: rest.pageSize,
    skipStatuses: rest.skipStatuses,
  };
  const rows = await enumerateRepos(env, enumerate);
  const reports: InvariantReport[] = [];
  for (const row of rows) {
    reports.push(await checkRepoInvariants(env, row, rest));
  }
  return reports;
}
