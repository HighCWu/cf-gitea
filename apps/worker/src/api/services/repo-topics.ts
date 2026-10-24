/**
 * Repo topics (SPEC-0004 §2.4 rows repoListTopics / repoUpdateTopics) —
 * upstream `models/repo/topic.go` reduced to per-repo name storage.
 *
 * SCHEMA GAP (the raw-D1 + DDL-comment pattern of SPEC-0006's LFS
 * bootstrap): `src/db/schema.ts` is owned by a parallel change this batch and
 * migrations must not be hand-edited, so the topics store lives OUTSIDE the
 * Drizzle schema for now and is accessed with prepared statements from this
 * mapper (never in routes; the AGENTS "Drizzle only" boundary returns when
 * the table lands in the schema). DDL for the migration owner's sweep is
 * `REPO_TOPICS_DDL_STATEMENTS`; the sweep also adds the table to the
 * `repositories` delete cascade (src/repos/service.ts deleteRepository).
 *
 * Storage decision recorded for that sweep: a `(repo_id, topic)` join table —
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

/**
 * Pre-migration bootstrap DDL (superseded by the schema entry the migration
 * owner lands; kept exactly like `LFS_OBJECTS_DDL_STATEMENTS` so tests and
 * scratch databases can bootstrap by hand until then).
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
  const { results } = await d1
    .prepare("SELECT topic FROM repo_topics WHERE repo_id = ?1 ORDER BY topic ASC")
    .bind(repoId)
    .all<{ topic: string }>();
  return results.map((row) => row.topic);
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
  const statements: D1PreparedStatement[] = [];
  for (const topic of removed) {
    statements.push(d1.prepare("DELETE FROM repo_topics WHERE repo_id = ?1 AND topic = ?2").bind(repoId, topic));
  }
  for (const topic of added) {
    statements.push(d1.prepare("INSERT INTO repo_topics (repo_id, topic) VALUES (?1, ?2)").bind(repoId, topic));
  }
  await d1.batch(statements);
}

/** Repo-scoped topic delete (the api repoDelete path's housekeeping; the
 *  engine-wave purge covers pre-migration scratch rows too). */
export async function deleteRepoTopics(d1: D1Database, repoId: string): Promise<void> {
  await d1.prepare("DELETE FROM repo_topics WHERE repo_id = ?1").bind(repoId).run();
}

/** Statement type accepted by D1's batch (raw-D1 mapper shim). */
type D1PreparedStatement = Parameters<D1Database["batch"]>[number][number];
