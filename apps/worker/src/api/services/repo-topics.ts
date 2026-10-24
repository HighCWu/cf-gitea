/**
 * Repo topics (SPEC-0004 §2.4 rows repoListTopics / repoUpdateTopics) —
 * upstream `models/repo/topic.go` reduced to per-repo name storage.
 *
 * The table lives in the Drizzle schema (`repoTopics`, src/db/schema.ts) and
 * landed as migration 0007; D1 access goes through Drizzle per the
 * architecture boundary (no hand-written SQL in services). Superseded:
 * `REPO_TOPICS_DDL_STATEMENTS` below is kept only as the historical record of
 * the pre-migration bootstrap (the batch-7 schema gap) — the generated
 * migration is authoritative now.
 *
 * Storage decision recorded at the sweep: a `(repo_id, topic)` join table —
 * upstream itself pairs a `topic` + `repo_topic` table pair with a
 * denormalized `repository.topics` JSON column; the join half is the one the
 * API semantics (GET = name list, PUT = whole-list replace, 422
 * invalidTopics) actually need, and the denormalized column is a render cache
 * upstream maintains with syncTopicsInRepository, which our single-table
 * mapper makes redundant.
 *
 * Validation is the `SanitizeAndValidateTopics` port (models/repo/topic.go):
 * trim + lowercase + dedupe + drop empties, then `^[a-z0-9][-.a-z0-9]*$` and
 * ≤ 35 chars; more than 25 valid names is its own 422 (routers/api/v1/repo/
 * topic.go UpdateTopics).
 */

import { and, asc, eq } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import { repoTopics } from "../../db/schema";

/**
 * SUPERSEDED by migration 0007 (`repoTopics` in src/db/schema.ts) — kept only
 * so pre-migration scratch databases can still be bootstrapped by hand. Do
 * not extend; change the schema + regenerate instead (AGENTS.md).
 */
export const REPO_TOPICS_DDL_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS repo_topics (
  repo_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  PRIMARY KEY (repo_id, topic)
)`,
];

/** Upstream `topicPattern` + ValidateTopic (models/repo/topic.go:24,57–60). */
const TOPIC_PATTERN = /^[a-z0-9][-.a-z0-9]*$/;
const MAX_TOPIC_LENGTH = 35;
/** Upstream's per-repo topic cap (routers/api/v1/repo/topic.go UpdateTopics). */
export const MAX_TOPICS_PER_REPO = 25;

/** One `SanitizeAndValidateTopics` result. */
export interface SanitizedTopics {
  /** Names that survive validation, deduped, lowercased, in input order. */
  valid: string[];
  /** Names that fail validation, deduped, lowercased, in input order. */
  invalid: string[];
}

/** `SanitizeAndValidateTopics` (models/repo/topic.go:62–87). */
export function sanitizeAndValidateTopics(topicNames: readonly string[]): SanitizedTopics {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of topicNames) {
    const topic = raw.trim().toLowerCase();
    if (topic === "" || valid.includes(topic) || invalid.includes(topic)) {
      continue;
    }
    if (topic.length <= MAX_TOPIC_LENGTH && TOPIC_PATTERN.test(topic)) {
      valid.push(topic);
    } else {
      invalid.push(topic);
    }
  }
  return { valid, invalid };
}

/** ListTopics — the repo's topic names, `topic.name ASC` (FindTopicOptions
 *  ToOrders: "when render topics for a repo, it's better to sort them by
 *  name, to get consistent result"). */
export async function listRepoTopics(d1: D1Database, repoId: string): Promise<string[]> {
  const rows = await drizzle(d1)
    .select({ topic: repoTopics.topic })
    .from(repoTopics)
    .where(eq(repoTopics.repoId, repoId))
    .orderBy(asc(repoTopics.topic))
    .all();
  return rows.map((row) => row.topic);
}

/**
 * UpdateTopics/SaveTopics — the whole-list replace in ONE D1 batch (a single
 * SQLite transaction). Everything arriving here is already sanitized
 * (lowercased), so upstream's EqualFold membership tests reduce to equality:
 * kept topics are the intersection, and only the added/removed delta is
 * written (SaveTopics topics.go:269–322 diffing; the (repo_id, topic) PK
 * would abort a naive delete-all+re-insert on kept rows anyway).
 */
export async function replaceRepoTopics(
  d1: D1Database,
  repoId: string,
  validTopics: readonly string[],
): Promise<void> {
  const current = await listRepoTopics(d1, repoId);
  const added = validTopics.filter((topic) => !current.includes(topic));
  const removed = current.filter((topic) => !validTopics.includes(topic));
  if (added.length === 0 && removed.length === 0) {
    return;
  }
  const db = drizzle(d1);
  const statements: DrizzleD1DatabaseBatchItem[] = [];
  for (const topic of removed) {
    statements.push(
      db.delete(repoTopics).where(and(eq(repoTopics.repoId, repoId), eq(repoTopics.topic, topic))),
    );
  }
  for (const topic of added) {
    statements.push(db.insert(repoTopics).values({ repoId, topic }));
  }
  // Non-empty here: the both-empty case returned above — the tuple shape
  // drizzle's d1 batch requires.
  await db.batch(statements as [DrizzleD1DatabaseBatchItem, ...DrizzleD1DatabaseBatchItem[]]);
}

/** Repo-scoped topic delete (the api repoDelete path's housekeeping; the
 *  deleteRepository cascade covers the same rows through the schema table). */
export async function deleteRepoTopics(d1: D1Database, repoId: string): Promise<void> {
  await drizzle(d1).delete(repoTopics).where(eq(repoTopics.repoId, repoId));
}

/** One batch item of the drizzle/d1 batch (statement type shim). */
type DrizzleD1DatabaseBatchItem = Parameters<DrizzleD1Database["batch"]>[number][number];
