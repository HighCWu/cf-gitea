/**
 * search-aux smoke — the survey's tick-10 bench row 5, PORT-FIRST gates:
 * ONE happy-path smoke per feed (real seeded data → 200 + shape), no test
 * matrix (the polish wave owns the error arms — the module doc's Arms
 * section carries their cites).
 *
 *   1. GET /repo/search loader over a REAL pushed repo (ensureSeededRepo)
 *      with a seeded commit-status row on the pushed tip → the
 *      {ok, data:[{repository, latest_commit_status,
 *      locale_latest_commit_status}]} envelope with the zero-padded
 *      api.Repository and the raw-model PascalCase status shell.
 *   2. GET /explore/topics/search loader over seeded repo_topics rows →
 *      the {"topics":[TopicResponse…]} envelope, repo_count DESC order.
 *
 * Harness posture: the module functions driven DIRECTLY (the
 * repo-lastcommit-fragment test's convention — the route arm is
 * index-owned; the module doc's HANDOFF section carries the mount
 * recipe), against the real workerd bindings (D1 + the REPO cell).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { commitStatuses, repoTopics, repositories, users } from "../../db/schema";
import { RepoService } from "../../repos/service";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import {
  loadRepoSearchAux,
  loadTopicSearchAux,
  parseRepoSearchAuxQuery,
  parseTopicSearchAuxQuery,
  repoSearchAuxResponse,
  topicSearchAuxResponse,
  type WebSearchAuxItem,
} from "./search-aux";

// --- fixtures -----------------------------------------------------------------

const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z — the harness epoch

const AUX_COMMITS: SeedCommit[] = [
  {
    message: "search-aux smoke: root commit",
    time: T0,
    files: [{ path: "README.md", content: "# search-aux smoke\n" }],
  },
];

/** Idempotent seed: alice (fresh per-file D1), the pushed public
 *  `alice/search-aux-smoke` (main at the root commit), a D1-only second
 *  repo, the commit-status row on main's tip (state success — the
 *  status-carrying arm) and three topic rows across both repos
 *  (golang ×2, gopher ×1 — the repo_count DESC order). */
async function ensureSmokeFixture(): Promise<{ repo1Id: string; repo2Id: string; tip: string; aliceId: number }> {
  await applyAuthD1Migrations();
  const seeded = await ensureSeededRepo({ owner: "alice", slug: "search-aux-smoke", commits: AUX_COMMITS });
  const tip = seeded.tips[seeded.tips.length - 1];
  if (tip === undefined) throw new Error("seed produced no tips");

  const db = drizzle(env.DB);
  const repo1 = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "search-aux-smoke")))
    .get();
  if (repo1 === undefined) throw new Error("seeded repo row missing");
  const alice = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get();
  if (alice === undefined) throw new Error("seed owner row missing");

  // The D1-only sibling repo (the topic-count second arm; no engine push
  // — the search feed reads D1 rows only for the list itself).
  let repo2Id: string;
  const repo2 = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "search-aux-smoke-b")))
    .get();
  if (repo2 === undefined) {
    const created = await new RepoService(env.DB).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "search-aux-smoke-b",
      isPrivate: false,
      status: "ready",
    });
    repo2Id = created.id;
  } else {
    repo2Id = repo2.id;
  }

  const existingStatus = await db
    .select({ id: commitStatuses.id })
    .from(commitStatuses)
    .where(and(eq(commitStatuses.repoId, repo1.id), eq(commitStatuses.sha, tip)))
    .get();
  if (existingStatus === undefined) {
    await db.insert(commitStatuses).values({
      repoId: repo1.id,
      sha: tip,
      targetUrl: "https://ci.example/run/1",
      context: "ci/smoke",
      state: "success",
      creatorId: alice.id,
      createdAt: new Date(T0 * 1000),
      updatedAt: new Date(T0 * 1000),
    });
  }

  const existingTopics = await db
    .select({ topic: repoTopics.topic })
    .from(repoTopics)
    .where(eq(repoTopics.repoId, repo1.id))
    .all();
  if (existingTopics.length === 0) {
    await db.insert(repoTopics).values([
      { repoId: repo1.id, topic: "golang" },
      { repoId: repo1.id, topic: "gopher" },
      { repoId: repo2Id, topic: "golang" },
    ]);
  }

  return { repo1Id: repo1.id, repo2Id, tip, aliceId: alice.id };
}

let fixture: Awaited<ReturnType<typeof ensureSmokeFixture>>;

beforeAll(async () => {
  fixture = await ensureSmokeFixture();
});

// --- feed 1: GET /repo/search ---------------------------------------------------

describe("GET /repo/search (repo.SearchRepo) — smoke", () => {
  it("serves the ok/data envelope with the zero-padded repository and the tip status shell", async () => {
    const params = parseRepoSearchAuxQuery(new URL("https://test.local/repo/search?q=search-aux"), true);
    const { total, data } = await loadRepoSearchAux(
      env,
      { origin: "https://test.local", requester: null },
      params,
    );
    const res = repoSearchAuxResponse(total, { ok: true, data });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    expect(res.headers.get("x-total-count")).toBe("2");
    expect(res.headers.get("access-control-expose-headers")).toBe("X-Total-Count");

    const body = JSON.parse(await res.text()) as { ok: boolean; data: WebSearchAuxItem[] };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(2);

    // Default sort (alpha → slug ASC): the pushed repo first, carrying the
    // status; the D1-only sibling second, status-less (null + "" — no
    // omitempty on the WebSearchRepository members).
    const first = body.data[0];
    expect(first?.repository.full_name).toBe("alice/search-aux-smoke");
    expect(first?.repository.link).toBe("/alice/search-aux-smoke");
    expect(first?.repository.html_url).toBe("https://test.local/alice/search-aux-smoke");
    expect(first?.repository.private).toBe(false);
    expect(first?.repository.internal).toBe(false);
    expect(first?.repository.stars_count).toBe(0);
    // Zero-padding spots (the handler never sets these — Go emits the
    // zero values): the Go-zero timestamps, the empty default branch,
    // null topics/licenses.
    expect(first?.repository.default_branch).toBe("");
    expect(first?.repository.created_at).toBe("0001-01-01T00:00:00Z");
    expect(first?.repository.topics).toBeNull();
    expect(first?.repository.licenses).toBeNull();

    expect(first?.latest_commit_status).not.toBeNull();
    expect(first?.latest_commit_status?.State).toBe("success");
    expect(first?.latest_commit_status?.TargetURL).toBe("https://ci.example/run/1");
    expect(first?.latest_commit_status?.SHA).toBe(fixture.tip);
    expect(first?.locale_latest_commit_status).toBe("Success");

    const second = body.data[1];
    expect(second?.repository.full_name).toBe("alice/search-aux-smoke-b");
    expect(second?.latest_commit_status).toBeNull();
    expect(second?.locale_latest_commit_status).toBe("");
  });
});

// --- feed 2: GET /explore/topics/search ------------------------------------------

describe("GET /explore/topics/search (explore.TopicSearch) — smoke", () => {
  it("serves the topics envelope in repo_count DESC order with X-Total-Count", async () => {
    const params = parseTopicSearchAuxQuery(new URL("https://test.local/explore/topics/search?q=go&page=1&limit=10"));
    const { total, topics } = await loadTopicSearchAux(env, params);
    const res = topicSearchAuxResponse(total, { topics });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    expect(res.headers.get("x-total-count")).toBe("2");

    const body = JSON.parse(await res.text()) as {
      topics: Array<{ id: number; topic_name: string; repo_count: number; created: string; updated: string }>;
    };
    // repo_count DESC (models/repo/topic.go:189), name tiebreak: golang
    // (2 rows across the two fixture repos) before gopher (1).
    expect(body.topics.map((topic) => [topic.topic_name, topic.repo_count])).toEqual([
      ["golang", 2],
      ["gopher", 1],
    ]);
    // TopicResponse's full key set: the FNV-1a id twin is a number, and
    // the unlanded timestamps render the documented GO_ZERO_TIME.
    expect(typeof body.topics[0]?.id).toBe("number");
    expect(body.topics[0]?.created).toBe("0001-01-01T00:00:00Z");
    expect(body.topics[0]?.updated).toBe("0001-01-01T00:00:00Z");
  });

  it("a 200-char keyword answers the clean empty envelope (no D1 LIKE-cap 500)", async () => {
    // The keyword arm must not cap (the 943e1e9 org-members class — D1's
    // 50-byte LIKE pattern limit): the long needle passes the boundary as
    // the clean no-match envelope.
    const params = parseTopicSearchAuxQuery(
      new URL(`https://test.local/explore/topics/search?q=${"z".repeat(200)}&page=1&limit=10`),
    );
    const { total, topics } = await loadTopicSearchAux(env, params);
    expect(total).toBe(0);
    expect(topics).toEqual([]);
  });
});
