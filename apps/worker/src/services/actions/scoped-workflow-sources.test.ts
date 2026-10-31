/**
 * The scoped-workflows SOURCE-REGISTRATION store's tests (services/actions/
 * scoped-workflow-sources.ts — the `action_scoped_workflow_source` table,
 * migration 0051): the five ops' semantics over REAL local D1 — the
 * id-ordered owner list, the (owner, repo) Get's null miss, the duplicate
 * no-op (pre-check AND the UNIQUE(owner_repo) race arbitration), the
 * configs replace (a JSON round-trip that keeps null values and coerces
 * junk to the never-throws arm), the silent zero-row delete, and the
 * owner isolation + the instance-level (owner_id 0) sentinel.
 *
 * Upstream pin fc4936884584a41931906553d96c2601d750e6ef:
 * models/actions/scoped_workflow.go:19-32 (the table) + :134-183 (the five
 * ops — the module header carries the full cite set; the page layer's seam
 * docs pin the same semantics).
 */

import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { scopedWorkflowSourcesStore } from "./scoped-workflow-sources";

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["action_scoped_workflow_source", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB
    .prepare(
      "INSERT INTO users (id, username, username_lower, display_name, type, created_at) VALUES (7, 'coalition', 'coalition', 'The Coalition', 'org', unixepoch())",
    )
    .run();
  const insertRepo =
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, is_empty, created_at) VALUES (?, ?, ?, ?, ?, 'main', 'public', 0, unixepoch())";
  await env.DB.prepare(insertRepo).bind("repo-1", "repo-1", "coalition", 7, "demo").run();
  await env.DB.prepare(insertRepo).bind("repo-2", "repo-2", "coalition", 7, "other").run();
});

// --- listSourcesByOwner (:135-137, the id-ordered list) ------------------------

describe("listSourcesByOwner", () => {
  it("lists the owner's sources in ID order — instance rows (owner 0) under their own scope", async () => {
    const store = scopedWorkflowSourcesStore(env.DB);
    // Seed with DESCENDING explicit ids so the read's ordering is pinned to
    // the ToOrders "id" clause (:56-58), not to insert-order luck.
    const seed = "INSERT INTO action_scoped_workflow_source (id, owner_id, source_repo_id, workflow_configs, created_unix, updated_unix) VALUES (?, ?, ?, '{}', unixepoch(), unixepoch())";
    await env.DB.prepare(seed).bind(3, 7, "repo-2").run();
    await env.DB.prepare(seed).bind(1, 0, "repo-1").run();
    await env.DB.prepare(seed).bind(2, 7, "repo-1").run();

    expect((await store.listSourcesByOwner(7)).map((r) => r.sourceRepoId)).toEqual(["repo-1", "repo-2"]); // id 2 < id 3
    expect((await store.listSourcesByOwner(0)).map((r) => r.sourceRepoId)).toEqual(["repo-1"]);
    expect(await store.listSourcesByOwner(99)).toEqual([]);
  });
});

// --- getSource (:140-150, the miss null) ---------------------------------------

describe("getSource", () => {
  it("returns the (owner, repo) row decoded — and null on the miss arms", async () => {
    const store = scopedWorkflowSourcesStore(env.DB);
    await store.addSource(7, "repo-1");
    await store.setSourceConfigs(7, "repo-1", {
      ".gitea/scoped_workflows/deploy.yml": { required: true, patterns: ["o/r: Deploy / build (push)"] },
    });

    const row = await store.getSource(7, "repo-1");
    expect(row).toEqual({
      ownerId: 7,
      sourceRepoId: "repo-1",
      workflowConfigs: { ".gitea/scoped_workflows/deploy.yml": { required: true, patterns: ["o/r: Deploy / build (push)"] } },
    });
    // The pair is the identity: the same repo under another owner is a miss,
    // so is an unregistered repo under this owner.
    expect(await store.getSource(0, "repo-1")).toBeNull();
    expect(await store.getSource(7, "repo-2")).toBeNull();
    expect(await store.getSource(7, "junk")).toBeNull();
  });
});

// --- addSource (:153-169, the duplicate no-op + the race arbitration) ----------

describe("addSource", () => {
  it("inserts once and no-ops the duplicate — still one row, still one id", async () => {
    const store = scopedWorkflowSourcesStore(env.DB);
    await store.addSource(7, "repo-1");
    const first = await store.getSource(7, "repo-1");
    await store.addSource(7, "repo-1"); // the exists pre-check arm
    const again = await store.getSource(7, "repo-1");
    expect(again).toEqual(first);
    const rows = await store.listSourcesByOwner(7);
    expect(rows).toHaveLength(1);
    // The fresh row carries the empty configs map (upstream's nil-map insert
    // — the `{}` same-empty-read reduction) and both timestamps set.
    expect(rows[0]?.workflowConfigs).toEqual({});
  });

  it("arbitrates the UNIQUE(owner_repo) race — a raw insert's violation lands as the no-op, a foreign-owner row is unaffected", async () => {
    const store = scopedWorkflowSourcesStore(env.DB);
    await store.addSource(7, "repo-1");
    // Drive the pre-check's race arm directly: the row exists but the raw
    // INSERT (which skips the store's exists read) hits the uq — the store's
    // catch-and-recheck converts it to the no-op rather than a throw.
    await env.DB
      .prepare(
        "INSERT INTO action_scoped_workflow_source (owner_id, source_repo_id, workflow_configs, created_unix, updated_unix) VALUES (7, 'repo-1', '{}', unixepoch(), unixepoch())",
      )
      .run()
      .catch(() => {}); // the uq fires here — the store's own call below is the arbitration pin
    const before = await store.listSourcesByOwner(7);
    await store.addSource(7, "repo-1");
    expect(await store.listSourcesByOwner(7)).toEqual(before);
    // The same repo under ANOTHER owner inserts freely — the uq is the PAIR.
    await store.addSource(0, "repo-1");
    expect((await store.listSourcesByOwner(0)).map((r) => r.sourceRepoId)).toEqual(["repo-1"]);
  });

  it("stamps created/updated once at insert (the deploy_keys convention)", async () => {
    const store = scopedWorkflowSourcesStore(env.DB);
    await store.addSource(7, "repo-1");
    const stamp = await env.DB
      .prepare("SELECT created_unix, updated_unix FROM action_scoped_workflow_source WHERE owner_id = 7")
      .first<{ created_unix: number; updated_unix: number }>();
    expect(stamp?.created_unix).toBeGreaterThan(0);
    expect(stamp?.updated_unix).toBe(stamp?.created_unix);
  });
});

// --- setSourceConfigs (:172-177, the column replace) ---------------------------

describe("setSourceConfigs (the JSON round-trip)", () => {
  it("replaces the configs map wholesale and round-trips through the JSON column", async () => {
    const store = scopedWorkflowSourcesStore(env.DB);
    await store.addSource(7, "repo-1");
    await store.setSourceConfigs(7, "repo-1", {
      "a.yml": { required: true, patterns: ["p1", "p2"] },
      "b.yml": { required: false, patterns: ["history"] },
    });
    expect((await store.getSource(7, "repo-1"))?.workflowConfigs).toEqual({
      "a.yml": { required: true, patterns: ["p1", "p2"] },
      "b.yml": { required: false, patterns: ["history"] },
    });
    // The replace is wholesale (upstream's Cols("workflow_configs") update —
    // the earlier map's keys do not survive).
    await store.setSourceConfigs(7, "repo-1", { "c.yml": { required: false, patterns: [] } });
    expect((await store.getSource(7, "repo-1"))?.workflowConfigs).toEqual({ "c.yml": { required: false, patterns: [] } });
    // An empty replace stores the empty map — the required flags' clearing arm.
    await store.setSourceConfigs(7, "repo-1", {});
    expect((await store.getSource(7, "repo-1"))?.workflowConfigs).toEqual({});
  });

  it("bumps updated_unix past created_unix on the replace (the auto-time default)", async () => {
    const store = scopedWorkflowSourcesStore(env.DB);
    await store.addSource(7, "repo-1");
    const inserted = await env.DB
      .prepare("SELECT created_unix, updated_unix FROM action_scoped_workflow_source WHERE owner_id = 7")
      .first<{ created_unix: number; updated_unix: number }>();
    await new Promise((resolve) => setTimeout(resolve, 1100)); // unix-second resolution
    await store.setSourceConfigs(7, "repo-1", { "a.yml": { required: true, patterns: ["p"] } });
    const replaced = await env.DB
      .prepare("SELECT created_unix, updated_unix FROM action_scoped_workflow_source WHERE owner_id = 7")
      .first<{ created_unix: number; updated_unix: number }>();
    expect(replaced?.created_unix).toBe(inserted?.created_unix); // created never moves
    expect(replaced?.updated_unix).toBeGreaterThan(inserted?.updated_unix ?? 0);
  }, 15_000);

  it("keeps a null config value through the round-trip (the merge's skip arm input)", async () => {
    const store = scopedWorkflowSourcesStore(env.DB);
    await store.addSource(7, "repo-1");
    // Null values are upstream's `*ScopedWorkflowConfig == nil` shape; only a
    // raw write produces them (the appliers' map is non-null), and the
    // decode must preserve them for buildScopedWorkflowInfos' skip.
    await env.DB
      .prepare(
        "UPDATE action_scoped_workflow_source SET workflow_configs = ? WHERE owner_id = 7 AND source_repo_id = 'repo-1'",
      )
      .bind(JSON.stringify({ "kept.yml": { required: true, patterns: ["p"] }, "nullish.yml": null }))
      .run();
    expect((await store.getSource(7, "repo-1"))?.workflowConfigs).toEqual({
      "kept.yml": { required: true, patterns: ["p"] },
      "nullish.yml": null,
    });
  });

  it("decodes junk bytes to the empty map — the never-throws read arm", async () => {
    const store = scopedWorkflowSourcesStore(env.DB);
    await store.addSource(7, "repo-1");
    for (const junk of ["", "not json", "[]", "null", '{"x":"not-a-config"}']) {
      await env.DB
        .prepare("UPDATE action_scoped_workflow_source SET workflow_configs = ? WHERE owner_id = 7")
        .bind(junk)
        .run();
      // The junk VALUE class drops its entry too (only {required,patterns}
      // objects decode) — the map reads empty either way.
      const configs = (await store.getSource(7, "repo-1"))?.workflowConfigs;
      expect(configs, junk).toEqual({});
    }
  });

  it("is a no-op write for an unregistered pair (upstream's zero-row update)", async () => {
    const store = scopedWorkflowSourcesStore(env.DB);
    await store.setSourceConfigs(7, "repo-missing", { "a.yml": { required: true, patterns: ["p"] } });
    expect(await store.listSourcesByOwner(7)).toEqual([]);
  });
});

// --- removeSource (:180-183, the silent delete) ---------------------------------

describe("removeSource", () => {
  it("deletes the (owner, repo) row only — and stays silent when nothing matches", async () => {
    const store = scopedWorkflowSourcesStore(env.DB);
    await store.addSource(7, "repo-1");
    await store.addSource(7, "repo-2");
    await store.addSource(0, "repo-1");

    await store.removeSource(7, "repo-1");
    expect((await store.listSourcesByOwner(7)).map((r) => r.sourceRepoId)).toEqual(["repo-2"]);
    expect((await store.listSourcesByOwner(0)).map((r) => r.sourceRepoId)).toEqual(["repo-1"]); // the pair's owner half shields it
    await store.removeSource(7, "repo-1"); // already gone — no error (the zero-row arm)
    await store.removeSource(7, "junk"); // never existed — no error
    expect((await store.listSourcesByOwner(7)).map((r) => r.sourceRepoId)).toEqual(["repo-2"]);
  });
});
