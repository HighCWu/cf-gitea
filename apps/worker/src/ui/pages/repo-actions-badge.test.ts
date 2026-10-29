/**
 * The workflow badge arm's tests (the F-row tail GET #3 — the module
 * header's upstream pins): GetWorkflowLatestRun's newest-by-id lookup over
 * the store (branch/event filters, the is_scoped_run=false exclusion, the
 * path-spelling tolerance), the badge triple's arms ("no status" grey,
 * "unknown status" for unmapped statuses, the color map), the WIDTH
 * ARITHMETIC pinned against Go's numbers (the 10x scale, the glyph table),
 * and the two templates' render (the flat gradient shape, the flat-square
 * switch, the htmlEscaper entities). Module-loader tests (the pre-mount
 * house pattern).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { actionRuns } from "../../db/schema";
import { insertActionRun } from "../../services/actions/model";
import {
  BADGE_DEFAULT_COLOR,
  BADGE_STATUS_COLORS,
  calculateTextWidth,
  generateBadge,
  renderWorkflowBadgeSvg,
  resolveWorkflowBadge,
} from "./repo-actions-badge";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const CLEANUP_TABLES = ["action_runs", "action_run_jobs", "action_run_attempts", "action_tasks_versions", "repositories", "users"];

beforeEach(async () => {
  for (const table of CLEANUP_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

const db = () => drizzle(env.DB);

const PAYLOAD = new TextEncoder().encode("name: ci\njobs:\n  build:\n    steps:\n      - run: echo hi\n");

const REPO = { id: "repo-demo", defaultBranch: "main" };

async function seedRepo(): Promise<string> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, username, username_lower, display_name, created_at) VALUES (1, 'alice', 'alice', 'Alice', unixepoch())",
  ).run();
  await env.DB.prepare(
    "INSERT INTO repositories (id, storage_key, owner_namespace, owner_id, slug, default_branch, visibility, is_empty, created_at) VALUES ('repo-demo', 'repo-demo', 'alice', 1, 'demo', 'main', 'public', 0, unixepoch())",
  ).run();
  return "repo-demo";
}

async function seedRun(
  repoId: string,
  opts: { workflowId?: string; ref?: string; event?: string; status?: number; scoped?: boolean; index?: number } = {},
): Promise<number> {
  const { run } = await insertActionRun(env.DB, {
    repoId,
    ownerId: 1,
    workflowId: opts.workflowId ?? "ci.yml",
    index: opts.index ?? 1,
    triggerUserId: 1,
    ref: opts.ref ?? "refs/heads/main",
    commitSha: "c".repeat(40),
    event: opts.event ?? "push",
    eventPayload: "{}",
    triggerEvent: "push",
  }, [{ jobId: "build", runsOn: ["ubuntu-latest"], workflowPayload: PAYLOAD }]);
  if (opts.status !== undefined || opts.scoped !== undefined) {
    await db()
      .update(actionRuns)
      .set({ ...(opts.status !== undefined ? { status: opts.status } : {}), ...(opts.scoped !== undefined ? { isScopedRun: opts.scoped } : {}) })
      .where(eq(actionRuns.id, run.id));
  }
  return run.id;
}

// --- the width arithmetic (Go numbers, hand-computed from the glyph table) ----

describe("the badge width port (badge.go's 10x scale)", () => {
  it("sums glyph advances; the missing-printable fallback is 'm'", () => {
    // c=6 i=3 → 9; s=6 u=7 c=6 c=6 e=7 s=6 s=6 → 44
    expect(calculateTextWidth("ci")).toBe(9);
    expect(calculateTextWidth("success")).toBe(44);
    // TrimSpace first; a non-DejaVu printable takes 'm' (11).
    expect(calculateTextWidth("  ci ")).toBe(9);
    expect(calculateTextWidth("é")).toBe(7); // 233 → 7
  });

  it("generates the layout Go's GenerateBadge produces for ('ci', 'success')", () => {
    const badge = generateBadge("ci", "success", "#4c1");
    // lw = 9 + 10 = 19; mw = 44 + 10 = 54; width 73.
    expect(badge.width).toBe(73);
    expect(badge.label).toEqual({ text: "ci", width: 19, x: 95, textLength: 90 });
    expect(badge.message).toEqual({ text: "success", width: 54, x: 19 * 10 + 54 * 5 - 10, textLength: 440 });
    expect(badge.fontSize).toBe(110);
  });
});

// --- the loader (getWorkflowBadge + GetWorkflowLatestRun) ---------------------

describe("resolveWorkflowBadge (badge.go:48-65 + run.go:328-348)", () => {
  let repoId: string;

  beforeEach(async () => {
    repoId = await seedRepo();
  });

  it("answers the grey 'no status' badge when no run exists", async () => {
    const badge = await resolveWorkflowBadge(env.DB, REPO, { workflowName: "ci.yml" });
    expect(badge.label.text).toBe("ci");
    expect(badge.message.text).toBe("no status");
    expect(badge.color).toBe(BADGE_DEFAULT_COLOR);
  });

  it("maps the newest run's status through StatusColorMap", async () => {
    await seedRun(repoId, { status: 2, index: 1 }); // older failure
    await seedRun(repoId, { status: 1, index: 2 }); // newest success
    const badge = await resolveWorkflowBadge(env.DB, REPO, { workflowName: "ci.yml" });
    expect(badge.message.text).toBe("success");
    expect(badge.color).toBe(BADGE_STATUS_COLORS[1]);
  });

  it("answers 'unknown status' for unmapped statuses (cancelling/pending)", async () => {
    await seedRun(repoId, { status: 8, index: 1 }); // cancelling — not in the map
    const badge = await resolveWorkflowBadge(env.DB, REPO, { workflowName: "ci.yml" });
    expect(badge.message.text).toBe("unknown status");
    expect(badge.color).toBe(BADGE_DEFAULT_COLOR);
  });

  it("filters by branch (refs/heads/{branch}), event, and the default branch arm", async () => {
    await seedRun(repoId, { status: 1, ref: "refs/heads/main", index: 1 });
    await seedRun(repoId, { status: 2, ref: "refs/heads/dev", index: 2 });
    const mainBadge = await resolveWorkflowBadge(env.DB, REPO, { workflowName: "ci.yml" });
    expect(mainBadge.message.text).toBe("success");
    const devBadge = await resolveWorkflowBadge(env.DB, REPO, { workflowName: "ci.yml", branch: "dev" });
    expect(devBadge.message.text).toBe("failure");
    await seedRun(repoId, { status: 2, ref: "refs/heads/main", event: "pull_request", index: 3 });
    const eventBadge = await resolveWorkflowBadge(env.DB, REPO, { workflowName: "ci.yml", event: "pull_request" });
    expect(eventBadge.message.text).toBe("failure");
  });

  it("matches path-spelled workflow ids (the store-spelling tolerance)", async () => {
    await seedRun(repoId, { workflowId: ".github/workflows/ci.yml", status: 1, index: 1 });
    const badge = await resolveWorkflowBadge(env.DB, REPO, { workflowName: "ci.yml" });
    expect(badge.message.text).toBe("success");
    // The label strips only the file's extension (the bare param's stem).
    expect(badge.label.text).toBe("ci");
  });

  it("never serves a scoped run into the repo badge (is_scoped_run = false)", async () => {
    await seedRun(repoId, { workflowId: "ci.yml", status: 2, scoped: true, index: 1 });
    const badge = await resolveWorkflowBadge(env.DB, REPO, { workflowName: "ci.yml" });
    expect(badge.message.text).toBe("no status");
  });
});

// --- the render (the two templates, verbatim) ---------------------------------

describe("renderWorkflowBadgeSvg (runner_badge_flat[-square].tmpl)", () => {
  it("renders the flat template with the empty IDPrefix ids and the exact geometry", () => {
    const svg = renderWorkflowBadgeSvg(generateBadge("ci", "success", "#4c1"));
    expect(svg).toContain('width="73" height="20"');
    expect(svg).toContain('aria-label="ci: success"');
    expect(svg).toContain('<linearGradient id="s"');
    expect(svg).toContain('<clipPath id="r">');
    expect(svg).toContain('fill="url(#s)"');
    expect(svg).toContain('<rect width="19" height="20" fill="#555" />');
    expect(svg).toContain('<rect x="19" width="54" height="20" fill="#4c1" />');
    expect(svg).toContain('textLength="90">ci</text>');
    expect(svg).toContain('textLength="440">success</text>');
    expect(svg).toContain('font-size="110"');
  });

  it("switches to the flat-square template only on the exact style literal", () => {
    const badge = generateBadge("ci", "success", "#4c1");
    badge.style = "flat-square";
    const square = renderWorkflowBadgeSvg(badge);
    expect(square).toContain('shape-rendering="crispEdges"');
    expect(square).not.toContain("linearGradient");
    expect(renderWorkflowBadgeSvg({ ...badge, style: "flat" })).toContain("linearGradient");
    expect(renderWorkflowBadgeSvg({ ...badge, style: "flat-wide" })).toContain("linearGradient");
  });

  it("escapes text through the htmlEscaper table", () => {
    const svg = renderWorkflowBadgeSvg(generateBadge('a&b<c>"d', "e'f", "#4c1"));
    expect(svg).toContain("a&amp;b&lt;c&gt;&#34;d");
    expect(svg).toContain("e&#39;f");
    expect(svg).not.toContain('a&b');
  });
});
