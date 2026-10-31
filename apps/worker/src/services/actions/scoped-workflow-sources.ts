/**
 * The scoped-workflows SOURCE-REGISTRATION store — the D1 port of the five
 * ops upstream's `models/actions/scoped_workflow.go:134-183` arms call over
 * the `action_scoped_workflow_source` table, over drizzle and the landed
 * schema columns (schema.ts `actionScopedWorkflowSources`, migration 0051).
 *
 * The settings surface consumes the ops through the
 * `ScopedWorkflowSourcesStore` SEAM (ui/pages/actions-scoped-workflows.tsx —
 * the page layer's landed interface, whose method docs pin each op's
 * semantics against the pin fc4936884584a41931906553d96c2601d750e6ef). This
 * module carries the same two types STRUCTURALLY rather than importing them
 * from the UI module — the dependency stays ui→services (a services module
 * never imports the UI layer), and tsc at the mount's call sites (the store
 * argument feeding the page layer's loaders/appliers) is the drift guard:
 * any shape divergence fails the compile there.
 *
 * Per-op upstream cites (the page seam's method docs carry the same):
 *
 *   - listSourcesByOwner ← GetScopedWorkflowSourcesByOwner (:135-137) —
 *     db.Find over FindScopedWorkflowSourceOpts{OwnerIDs: [ownerID]}, the
 *     opts' ToOrders "id" (:56-58) → the id-ordered list.
 *   - getSource ← GetScopedWorkflowSource (:140-150) — the
 *     (owner_id, source_repo_id) Get; upstream's NotExist error reduces to
 *     null (the seam's miss shape).
 *   - addSource ← AddScopedWorkflowSource (:153-169) — the exists
 *     pre-check (:154-160), then the insert; upstream's unique-violation
 *     re-check (:162-167) is the UNIQUE(owner_repo) arbitration: the
 *     concurrent-add loser re-queries and treats the present row as the
 *     intended no-op, a genuine insert failure rethrows.
 *   - setSourceConfigs ← SetScopedWorkflowSourceConfigs (:172-177) — the
 *     workflow_configs column replace by the (owner, repo) pair. The
 *     updated_unix bump rides with it: xorm's `updated` tag auto-set fires
 *     on EVERY Update unless NoAutoTime suppresses it (run.go:279 uses the
 *     opt-OUT, proving the default), and this arm does not.
 *   - removeSource ← RemoveScopedWorkflowSource (:180-183) — the delete by
 *     the (owner, repo) pair; zero rows deleted is a silent success (the
 *     handler has no not-found arm, scoped_workflows.go:351-368).
 *
 * The JSON column's contract (the appliers' bytes — the page layer's
 * store-fake tests pin the shape): `JSON.stringify` of the configs map on
 * write; on read, an object map keyed by workflow ENTRY NAME whose values
 * are `{required, patterns[]}` — a null VALUE round-trips verbatim (the
 * merge's documented skip arm, the pure module's `cfg == nil` skip). The
 * decode is the never-throws read arm (the owner-actions-config `_ =`
 * Unmarshal twin — only these five ops write the column, so junk bytes are
 * a corruption class, not a flow): unparseable/non-object bytes decode to
 * `{}`, per-entry values coerce (`required === true`, the string array
 * filtered) with null kept.
 */

import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actionScopedWorkflowSources } from "../../db/schema";
import type { ScopedWorkflowConfig } from "./scoped-workflows";

// ---------------------------------------------------------------------------
// The seam's types (the page layer's, held structurally — see the header)
// ---------------------------------------------------------------------------

/** One source-registration row (upstream `ActionScopedWorkflowSource` minus
 *  the timestamps — the ops' consumers read exactly these three fields; the
 *  WorkflowConfigs JSON already decoded, a nil config value KEPT as null). */
export interface ScopedWorkflowSourceRow {
  /** The scope owner (users.id — orgs included); 0 = instance-level. */
  ownerId: number;
  /** The TEXT repositories.id space (the schema table's id-space note). */
  sourceRepoId: string;
  /** The decoded workflow_configs map (entry name → config or null). */
  workflowConfigs: Record<string, ScopedWorkflowConfig | null>;
}

/** The five store ops the arms call (the page seam's interface — each
 *  method's upstream cite lives on this module's header and the page
 *  layer's identically-named member docs). */
export interface ScopedWorkflowSourcesStore {
  listSourcesByOwner(ownerId: number): Promise<ScopedWorkflowSourceRow[]>;
  getSource(ownerId: number, sourceRepoId: string): Promise<ScopedWorkflowSourceRow | null>;
  addSource(ownerId: number, sourceRepoId: string): Promise<void>;
  setSourceConfigs(ownerId: number, sourceRepoId: string, configs: Record<string, ScopedWorkflowConfig>): Promise<void>;
  removeSource(ownerId: number, sourceRepoId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// The JSON codec
// ---------------------------------------------------------------------------

/**
 * The workflow_configs read arm: the appliers' `JSON.stringify` bytes come
 * back as the decoded map. Null values (upstream's nil `*ScopedWorkflowConfig`)
 * round-trip; everything else coerces — never throws (the header's note).
 */
function decodeWorkflowConfigs(raw: string): Record<string, ScopedWorkflowConfig | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, ScopedWorkflowConfig | null> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (typeof value !== "object" || Array.isArray(value)) continue;
    const v = value as { required?: unknown; patterns?: unknown };
    out[key] = {
      required: v.required === true,
      patterns: Array.isArray(v.patterns) ? v.patterns.filter((p): p is string => typeof p === "string") : [],
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// The drizzle store
// ---------------------------------------------------------------------------

/** The projection the ops read (the decoded row — never the raw JSON). */
function decodeRow(row: { ownerId: number; sourceRepoId: string; workflowConfigs: string }): ScopedWorkflowSourceRow {
  return { ownerId: row.ownerId, sourceRepoId: row.sourceRepoId, workflowConfigs: decodeWorkflowConfigs(row.workflowConfigs) };
}

/** Build the `ScopedWorkflowSourcesStore` over a D1 binding (the mount's
 *  store port — the page layer's loaders/appliers take this). */
export function scopedWorkflowSourcesStore(d1: D1Database): ScopedWorkflowSourcesStore {
  const db = drizzle(d1);
  const byOwnerAndRepo = (ownerId: number, sourceRepoId: string) =>
    and(eq(actionScopedWorkflowSources.ownerId, ownerId), eq(actionScopedWorkflowSources.sourceRepoId, sourceRepoId));
  return {
    async listSourcesByOwner(ownerId: number): Promise<ScopedWorkflowSourceRow[]> {
      // :135-137 + ToOrders "id" — the owner's rows in id order.
      const rows = await db
        .select({
          ownerId: actionScopedWorkflowSources.ownerId,
          sourceRepoId: actionScopedWorkflowSources.sourceRepoId,
          workflowConfigs: actionScopedWorkflowSources.workflowConfigs,
        })
        .from(actionScopedWorkflowSources)
        .where(eq(actionScopedWorkflowSources.ownerId, ownerId))
        .orderBy(asc(actionScopedWorkflowSources.id));
      return rows.map(decodeRow);
    },

    async getSource(ownerId: number, sourceRepoId: string): Promise<ScopedWorkflowSourceRow | null> {
      // :140-150 — the (owner, repo) Get; undefined → the NotExist null.
      const row = await db
        .select({
          ownerId: actionScopedWorkflowSources.ownerId,
          sourceRepoId: actionScopedWorkflowSources.sourceRepoId,
          workflowConfigs: actionScopedWorkflowSources.workflowConfigs,
        })
        .from(actionScopedWorkflowSources)
        .where(byOwnerAndRepo(ownerId, sourceRepoId))
        .get();
      return row === undefined ? null : decodeRow(row);
    },

    async addSource(ownerId: number, sourceRepoId: string): Promise<void> {
      const now = new Date();
      // :154-160 — the exists pre-check (the duplicate no-op's calm arm).
      const exists = await db
        .select({ id: actionScopedWorkflowSources.id })
        .from(actionScopedWorkflowSources)
        .where(byOwnerAndRepo(ownerId, sourceRepoId))
        .get();
      if (exists !== undefined) return;
      // The insert carries the empty configs map (upstream's nil-map insert —
      // the schema column's note: `{}` is the same empty read).
      let insertError: unknown;
      try {
        await db.insert(actionScopedWorkflowSources).values({
          ownerId,
          sourceRepoId,
          workflowConfigs: "{}",
          createdAt: now,
          updatedAt: now,
        });
        return;
      } catch (err) {
        insertError = err;
      }
      // :162-167 — the race re-check: the UNIQUE(owner_repo) loser treats
      // the present row as the intended no-op; a miss was a REAL failure.
      const raced = await db
        .select({ id: actionScopedWorkflowSources.id })
        .from(actionScopedWorkflowSources)
        .where(byOwnerAndRepo(ownerId, sourceRepoId))
        .get();
      if (raced !== undefined) return;
      throw insertError;
    },

    async setSourceConfigs(ownerId: number, sourceRepoId: string, configs: Record<string, ScopedWorkflowConfig>): Promise<void> {
      // :172-177 — the configs column replace; the auto-time `updated` bump
      // rides (the header's NoAutoTime note).
      await db
        .update(actionScopedWorkflowSources)
        .set({ workflowConfigs: JSON.stringify(configs), updatedAt: new Date() })
        .where(byOwnerAndRepo(ownerId, sourceRepoId));
    },

    async removeSource(ownerId: number, sourceRepoId: string): Promise<void> {
      // :180-183 — the delete; zero rows is a silent success.
      await db.delete(actionScopedWorkflowSources).where(byOwnerAndRepo(ownerId, sourceRepoId));
    },
  };
}
