/**
 * Tier-2 repo-extras batch on real D1/bindings + real engine content
 * (SPEC-0004 appendix A table-free `repository`-tag remainder):
 * routes/repo-extras-t2.ts — the transfer accept/reject pair, /topics/search,
 * the collaborator permission / assignee-check / reviewers reads, the issue
 * config read+validate pair, git notes, the review-comment reply + resolve
 * trio, the pull "update branch" op, contents-ext, the file-contents batch
 * and the single release-attachment item family. One standalone app per the
 * tier2-extras.test.ts convention (the routes ARE registered in router.ts by
 * the orchestrator after this batch lands; the isolated mount keeps the
 * family independently assertable).
 *
 * Engine-backed reads/writes ride REAL pushed packs through the git-http
 * receive flow (ui/testing seed-repo pattern, engine-read.test.ts); the git
 * notes ref is seeded with hand-serialized objects straight through the
 * cell's putApiObjects/commitApiChange RPCs (the branches.ts create chain).
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { OpenAPIHono } from "@hono/zod-openapi";

import {
  comments,
  issues,
  pullRequests,
  releaseAssets,
  releases,
  repoCollaborators,
  repoRedirects,
  repoSettings,
  repoTopics,
  repoTransfer,
  repositories,
  users,
} from "../../db/schema";
import { CommentType } from "../../issues/comment-types";
import {
  createOptionalTokenAuthMiddleware,
  createTokenAuthMiddleware,
  type AuthResolver,
} from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import { registerRepoExtrasT2Routes } from "./repo-extras-t2";
import { IssuesService } from "../../issues/service";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { ensureSeededRepo, type SeedCommit } from "../../ui/testing/seed-repo";
import { releaseAssetKey } from "../services/release-assets";
import { createWikiPage, readWikiPage } from "../../services/wiki";
import { engineCell, ZERO_OID } from "../services/engine";
import type { User } from "../models/user";

// wave-129 full-run contention budget: this file's beforeAll seeding (the
// receive-flow engine repo + the notes cell chain) measured a 4.86s hook share
// of the 30s default IN a green 8-worker full run (the suite's 260-isolate
// spawn storm spikes closures up to ~12x their solo time). File-local 90s
// budgets; vitest.config.ts keeps 30s for every other file. Membership: the
// measured >=4s in-run closure/hook set (full-suite junit run, 2026-10-27).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const OWNER = "extras";
const SLUG = "engine";
const REPO_PATH = `/repos/${OWNER}/${SLUG}`;
const T0 = 1_760_000_000;

const TOKEN = "extras-owner-token"; // → the seeded owner
const TOKEN_NEIGHBOR = "extras-neighbor-token"; // → non-writer neighbor
const TOKEN_OUTSIDER = "extras-outsider-token"; // → uninvolved third party
const NOW = new Date("2026-02-03T04:05:06Z");

const ENGINE_COMMITS: SeedCommit[] = [
  {
    message: "seed: initial layout",
    time: T0,
    files: [
      { path: "README.md", content: "# engine suite\n" },
      { path: "src/lib.txt", content: "lib v1\n" },
      { path: "docs/guide/deep.txt", content: "deep doc\n" },
    ],
  },
  {
    message: "seed: second revision",
    time: T0 + 60,
    files: [
      { path: "README.md", content: "# engine suite\n" },
      { path: "src/lib.txt", content: "lib v1\nlib v2\n" },
      { path: "docs/guide/deep.txt", content: "deep doc\n" },
    ],
  },
];

const VALID_CFG: SeedCommit = {
  message: "seed: issue config",
  time: T0,
  files: [
    {
      path: ".gitea/ISSUE_TEMPLATE/config.yaml",
      content:
        "blank_issues_enabled: false\ncontact_links:\n  - name: Forum\n    url: https://example.com/forum\n    about: Ask the community\n",
    },
  ],
};

const INVALID_CFG: SeedCommit = {
  message: "seed: broken issue config",
  time: T0,
  files: [
    {
      path: ".gitea/ISSUE_TEMPLATE/config.yaml",
      content: "contact_links:\n  - name: Forum\n    url: ./relative-only\n",
    },
  ],
};

let ownerId = 0;
let neighborId = 0;
let outsiderId = 0;
let readerId = 0;
let engineRepoId = "";
let storageKey = "";
let TIP1 = "";
let TIP2 = "";

/** Minimal User literals for the auth seam (the tier2-extras shape). */
function identity(id: number, login: string): User {
  return {
    id,
    login,
    login_name: "",
    full_name: login,
    email: `${login}@example.com`,
    avatar_url: "",
    html_url: `https://example.com/${login}`,
    language: "en-US",
    location: "",
    website: "",
    description: "",
    active: true,
    is_admin: false,
    prohibit_login: false,
    restricted: false,
    source_id: 0,
    followers_count: 0,
    following_count: 0,
    starred_repos_count: 0,
    created: "2026-01-01T00:00:00Z",
    last_login: "0001-01-01T00:00:00Z",
    type: "User",
    visibility: "public",
  };
}

function resolver(): AuthResolver {
  return {
    resolveToken: (token) => {
      if (token === TOKEN) return Promise.resolve(identity(ownerId, OWNER));
      if (token === TOKEN_NEIGHBOR) return Promise.resolve(identity(neighborId, "neighbor"));
      if (token === TOKEN_OUTSIDER) return Promise.resolve(identity(outsiderId, "outsider"));
      return Promise.resolve(null);
    },
  };
}

function familyApp(register: (app: OpenAPIHono<ApiEnv>) => void) {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  register(app);
  return async (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.fetch(new Request(`https://example.com${path}`, init), env));
}

const authed = (init?: RequestInit, token = TOKEN): RequestInit => {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `token ${token}`);
  return { ...init, headers };
};

const jsonAuthed = (body: unknown, method: string, token = TOKEN): RequestInit =>
  authed({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, token);

const send = familyApp((app) =>
  registerRepoExtrasT2Routes(app, createTokenAuthMiddleware(resolver()), createOptionalTokenAuthMiddleware(resolver())),
);

beforeAll(async () => {
  await applyAuthD1Migrations();
  const engine = await ensureSeededRepo({ owner: OWNER, slug: SLUG, commits: ENGINE_COMMITS });
  await ensureSeededRepo({ owner: OWNER, slug: "cfg", commits: [VALID_CFG] });
  await ensureSeededRepo({ owner: OWNER, slug: "badcfg", commits: [INVALID_CFG] });
  TIP1 = engine.tips[0] as string;
  TIP2 = engine.tips[1] as string;

  const ownerRow = await drizzle(env.DB)
    .select({ id: users.id })
    .from(users)
    .where(eq(users.usernameLower, OWNER))
    .get();
  if (ownerRow === undefined) throw new Error("seed owner missing");
  ownerId = ownerRow.id;
  neighborId = (
    await drizzle(env.DB)
      .insert(users)
      .values({ username: "neighbor", usernameLower: "neighbor", status: "active", createdAt: NOW })
      .returning({ id: users.id })
      .all()
  )[0]!.id;
  outsiderId = (
    await drizzle(env.DB)
      .insert(users)
      .values({ username: "outsider", usernameLower: "outsider", status: "active", createdAt: NOW })
      .returning({ id: users.id })
      .all()
  )[0]!.id;
  readerId = (
    await drizzle(env.DB)
      .insert(users)
      .values({ username: "reader", usernameLower: "reader", status: "active", createdAt: NOW })
      .returning({ id: users.id })
      .all()
  )[0]!.id;

  const repoRow = await drizzle(env.DB)
    .select({ id: repositories.id, storageKey: repositories.storageKey })
    .from(repositories)
    .where(eq(repositories.slug, SLUG))
    .get();
  if (repoRow === undefined) throw new Error("seed repo row missing");
  engineRepoId = repoRow.id;
  storageKey = repoRow.storageKey;
});

/** Fresh child rows per test. users + repositories persist (seeded in
 *  beforeAll); the t2-% scratch repos of the transfer/settings tests are
 *  re-claimed here so re-runs never hit the slug unique constraint. */
beforeEach(async () => {
  for (const table of [
    "repo_redirects",
    "comments",
    "issues",
    "pull_requests",
    "releases",
    "release_assets",
    "repo_topics",
    "repo_collaborators",
    "repo_transfer",
    "repo_settings",
    "repo_counters",
    "issue_pins",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM repositories WHERE slug LIKE 't2-%'").run();
});

/** A plain D1-only repo row (no engine content; the t2-% namespace the
 *  beforeEach re-claims). */
async function seedRepoRow(suffix: string): Promise<string> {
  const id = `t2-${suffix}`;
  await drizzle(env.DB).insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace: OWNER,
    ownerId,
    slug: id,
    visibility: "public",
    refsVersion: 0,
    createdAt: NOW,
  });
  return id;
}

async function seedTopic(repoId: string, topic: string): Promise<void> {
  await drizzle(env.DB).insert(repoTopics).values({ repoId, topic });
}

async function seedCollaborator(userId: number, mode: "read" | "write" | "admin"): Promise<void> {
  await drizzle(env.DB).insert(repoCollaborators).values({ repoId: engineRepoId, userId, mode, createdAt: NOW });
}

/** One pending transfer row. */
async function seedPendingTransfer(repoId: string, newOwnerId: number): Promise<void> {
  await drizzle(env.DB).insert(repoTransfer).values({ repoId, doerId: ownerId, newOwnerId, createdAt: NOW });
}

/** The cell carries the tombstone flag: beginReceive is refused outright
 *  (lifecycle.test.ts's expectTombstoned shape, against the route-level move). */
async function expectTombstonedCell(engineName: string): Promise<void> {
  const begin = await env.REPO.getByName(engineName).beginReceive({
    commands: [{ ref: "refs/heads/main", old: ZERO_OID, next: ZERO_OID }],
    capabilities: [],
    packBytesHint: null,
  });
  expect(begin.tag).toBe("rejected");
  if (begin.tag === "rejected") {
    expect(begin.results).toEqual([{ ref: "refs/heads/main", ok: false, message: "repository deleted" }]);
  }
}

/** One release row; returns its global id. */
async function seedRelease(overrides: { isDraft?: boolean; isTag?: boolean; tagName?: string } = {}): Promise<number> {
  const tagName = overrides.tagName ?? "v1.0.0";
  const row = await drizzle(env.DB)
    .insert(releases)
    .values({
      repoId: engineRepoId,
      publisherId: ownerId,
      tagName,
      lowerTagName: tagName.toLowerCase(),
      title: tagName,
      isDraft: overrides.isDraft ?? false,
      isTag: overrides.isTag ?? false,
      publishedUnix: overrides.isDraft || overrides.isTag ? 0 : Math.floor(NOW.getTime() / 1000),
      createdAt: NOW,
    })
    .returning({ id: releases.id })
    .all();
  return row[0]!.id;
}

/** One attachment row + its R2 object; returns the D1 id. */
async function seedAsset(releaseId: number, name = "dl.bin"): Promise<number> {
  const uuid = crypto.randomUUID();
  const key = releaseAssetKey(storageKey, releaseId, uuid, name);
  await env.REPO_PACKS.put(key, new Uint8Array([1, 2, 3, 4]));
  const row = await drizzle(env.DB)
    .insert(releaseAssets)
    .values({
      uuid,
      repoId: engineRepoId,
      releaseId,
      uploaderId: ownerId,
      name,
      size: 4,
      downloadCount: 0,
      r2Key: key,
      createdAt: NOW,
    })
    .returning({ id: releaseAssets.id })
    .all();
  return row[0]!.id;
}

// ---------------------------------------------------------------------------
// GET /topics/search
// ---------------------------------------------------------------------------

describe("GET /topics/search (repo-extras-t2)", () => {
  it("aggregates per-topic repo counts with LIKE filtering and pagination", async () => {
    await seedTopic(engineRepoId, "golang");
    await seedTopic("t2-second-repo", "golang");
    await seedTopic(engineRepoId, "testing");

    const hit = await send("/topics/search?q=go");
    expect(hit.status).toBe(200);
    expect(hit.headers.get("X-Total-Count")).toBe("1");
    const body: { topics: Array<{ id: number; topic_name: string; repo_count: number }> } = await hit.json();
    expect(body.topics.map((topic) => [topic.topic_name, topic.repo_count])).toEqual([["golang", 2]]);
    for (const topic of body.topics) {
      expect(Number.isInteger(topic.id)).toBe(true); // deterministic name-hash surrogate
    }

    const unfiltered = await send("/topics/search?limit=1&page=2");
    expect(unfiltered.status).toBe(200);
    expect(unfiltered.headers.get("X-Total-Count")).toBe("2"); // golang + testing
    const page2: { topics: Array<{ topic_name: string }> } = await unfiltered.json();
    expect(page2.topics.map((topic) => topic.topic_name)).toEqual(["testing"]); // name order, second page

    // The keyword arm must not cap (the 943e1e9 org-members class — D1's
    // 50-byte LIKE pattern limit): a 200-char needle answers the clean
    // empty page, not a D1_ERROR 500.
    const longQ = await send(`/topics/search?q=${"z".repeat(200)}`);
    expect(longQ.status).toBe(200);
    expect(longQ.headers.get("X-Total-Count")).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo}/collaborators/{collaborator}/permission
// ---------------------------------------------------------------------------

describe("GET /repos/.../collaborators/{collaborator}/permission (repo-extras-t2)", () => {
  it("renders the effective mode for the owner, a site-admin-free collaborator and the public fallback", async () => {
    await seedCollaborator(neighborId, "write");
    expect((await send(`${REPO_PATH}/collaborators/neighbor/permission`)).status).toBe(401); // reqToken

    const byOwner = await send(`${REPO_PATH}/collaborators/neighbor/permission`, authed());
    expect(byOwner.status).toBe(200);
    const granted: { permission: string; role_name: string; user: { login: string } } = await byOwner.json();
    expect(granted.permission).toBe("write");
    expect(granted.role_name).toBe("write"); // convert.ToUserAndPermission mirrors the mode string
    expect(granted.user.login).toBe("neighbor");

    const self = await send(`${REPO_PATH}/collaborators/neighbor/permission`, authed(undefined, TOKEN_NEIGHBOR));
    expect(self.status).toBe(200); // collaborators query their own permission

    const ownerSelf = await send(`${REPO_PATH}/collaborators/${OWNER}/permission`, authed());
    const ownerBody: { permission: string } = await ownerSelf.json();
    expect(ownerBody.permission).toBe("owner");

    const publicRead = await send(`${REPO_PATH}/collaborators/outsider/permission`, authed());
    const publicBody: { permission: string } = await publicRead.json();
    expect(publicBody.permission).toBe("read"); // public visibility fallback

    const ghost = await send(`${REPO_PATH}/collaborators/ghost/permission`, authed());
    expect(ghost.status).toBe(404);
    const ghostBody: { message: string } = await ghost.json();
    // collaborators.go:282-288 — APIError(404, ErrUserNotExist.Error()) with
    // the user.go:50-52 `[uid: %d, name: %s]` render, UID unset = 0.
    expect(ghostBody.message).toBe("user does not exist [uid: 0, name: ghost]");
  });

  it("403s uninvolved users who are not querying themselves (repo-admin gate)", async () => {
    await seedCollaborator(neighborId, "write");
    const response = await send(`${REPO_PATH}/collaborators/neighbor/permission`, authed(undefined, TOKEN_OUTSIDER));
    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo}/assignees/{assignee}
// ---------------------------------------------------------------------------

describe("GET /repos/.../assignees/{assignee} (repo-extras-t2)", () => {
  it("204s write-and-above collaborators plus the owner; read-only and unknown are 404", async () => {
    await seedCollaborator(neighborId, "write");
    await seedCollaborator(readerId, "read");

    expect((await send(`${REPO_PATH}/assignees/neighbor`, authed())).status).toBe(204);
    expect((await send(`${REPO_PATH}/assignees/${OWNER}`, authed())).status).toBe(204); // owner is always assignable
    expect((await send(`${REPO_PATH}/assignees/reader`, authed())).status).toBe(404); // read mode is not assignable
    const ghost = await send(`${REPO_PATH}/assignees/ghost`, authed());
    expect(ghost.status).toBe(404);
    const ghostBody: { message: string } = await ghost.json();
    // checkAssignableUser (issue_assignee.go:164-169) — APIErrorAuto of
    // ErrUserNotExist, the same `[uid: 0, name: X]` render.
    expect(ghostBody.message).toBe("user does not exist [uid: 0, name: ghost]");
    expect((await send(`${REPO_PATH}/assignees/neighbor`)).status).toBe(401); // reqToken
  });
});

// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo}/reviewers
// ---------------------------------------------------------------------------

describe("GET /repos/.../reviewers (repo-extras-t2)", () => {
  it("lists active collaborators plus the owner in name order; writer-gated", async () => {
    await seedCollaborator(neighborId, "write");
    await seedCollaborator(readerId, "read");

    const list = await send(`${REPO_PATH}/reviewers`, authed());
    expect(list.status).toBe(200);
    const logins: Array<{ login: string }> = await list.json();
    expect(logins.map((user) => user.login)).toEqual([OWNER, "neighbor", "reader"]); // sorted by username

    expect((await send(`${REPO_PATH}/reviewers`, authed(undefined, TOKEN_OUTSIDER))).status).toBe(403); // runtime-only
    expect((await send(`${REPO_PATH}/reviewers`)).status).toBe(401);
    expect((await send("/repos/extras/ghost/reviewers", authed())).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo}/issue_config[/validate]
// ---------------------------------------------------------------------------

describe("GET /repos/.../issue_config + /validate (repo-extras-t2)", () => {
  it("serves the parsed config and a clean validation for the default-branch file", async () => {
    const config = await send("/repos/extras/cfg/issue_config");
    expect(config.status).toBe(200);
    expect(await config.json()).toEqual({
      blank_issues_enabled: false,
      contact_links: [{ name: "Forum", url: "https://example.com/forum", about: "Ask the community" }],
    });
    const validation = await send("/repos/extras/cfg/issue_config/validate");
    expect(validation.status).toBe(200);
    expect(await validation.json()).toEqual({ valid: true, message: "" });
  });

  it("answers the DEFAULT config for an invalid file; validate reports the upstream-exact message", async () => {
    const config = await send("/repos/extras/badcfg/issue_config");
    expect(config.status).toBe(200); // the GET ignores the error arm (repo.go:1219)
    expect(await config.json()).toEqual({ blank_issues_enabled: true, contact_links: [] });
    const validation = await send("/repos/extras/badcfg/issue_config/validate");
    expect(await validation.json()).toEqual({ valid: false, message: "contact_link at position 1 is missing about key" });
  });

  it("serves the default config for a repo without a config file and for empty repos", async () => {
    const validation = await send(`${REPO_PATH}/issue_config/validate`);
    expect(await validation.json()).toEqual({ valid: true, message: "" });

    const empty = await seedRepoRow("empty");
    const emptyConfig = await send(`/repos/${OWNER}/${empty}/issue_config`);
    expect(await emptyConfig.json()).toEqual({ blank_issues_enabled: true, contact_links: [] });
    const emptyValidation = await send(`/repos/${OWNER}/${empty}/issue_config/validate`);
    expect(await emptyValidation.json()).toEqual({ valid: true, message: "" });
    expect((await send("/repos/extras/ghost/issue_config")).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo}/git/notes/{sha}
// ---------------------------------------------------------------------------

/** Idempotent notes seeding: the DO storage persists across the file's tests
 *  (and possibly across re-runs), so the ref create only fires when the
 *  notes ref is missing. The objects are hand-serialized (git notes storage:
 *  the note blob at the 2/38 fanout path of the annotated commit). */
async function seedNoteIfAbsent(slug: string, commitSha: string, noteText: string): Promise<void> {
  const cell = engineCell(env, { ownerNamespace: OWNER, slug });
  const refs = await cell.listRefs();
  if (refs.refs.some((ref) => ref.name === "refs/notes/commits")) {
    return;
  }
  const ENCODER = new TextEncoder();
  const concat = (arrays: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
    let offset = 0;
    for (const bytes of arrays) {
      out.set(bytes, offset);
      offset += bytes.length;
    }
    return out;
  };
  const sha1Hex = async (bytes: Uint8Array): Promise<string> =>
    [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const rawOid = (oid: string): Uint8Array => {
    const raw = new Uint8Array(20);
    for (let index = 0; index < 20; index += 1) raw[index] = Number.parseInt(oid.slice(index * 2, index * 2 + 2), 16);
    return raw;
  };

  const blobData = ENCODER.encode(noteText);
  const blobOid = await sha1Hex(concat([ENCODER.encode(`blob ${blobData.length}\0`), blobData]));
  const leaf = concat([ENCODER.encode(`100644 ${commitSha.slice(2)}\0`), rawOid(blobOid)]);
  const leafOid = await sha1Hex(concat([ENCODER.encode(`tree ${leaf.length}\0`), leaf]));
  const root = concat([ENCODER.encode(`40000 ${commitSha.slice(0, 2)}\0`), rawOid(leafOid)]);
  const rootOid = await sha1Hex(concat([ENCODER.encode(`tree ${root.length}\0`), root]));
  const who = "note bot <note@example.com>";
  const stamp = `${T0} +0000`;
  const body = ENCODER.encode(
    `tree ${rootOid}\nauthor ${who} ${stamp}\ncommitter ${who} ${stamp}\n\nnotes: added\n`,
  );
  const commitOid = await sha1Hex(concat([ENCODER.encode(`commit ${body.length}\0`), body]));

  const stored = await cell.putApiObjects([
    { oid: blobOid, type: "blob", data: blobData },
    { oid: leafOid, type: "tree", data: leaf },
    { oid: rootOid, type: "tree", data: root },
    { oid: commitOid, type: "commit", data: body },
  ]);
  if (stored.tag !== "ok") throw new Error(`note objects rejected: ${JSON.stringify(stored)}`);
  const landed = await cell.commitApiChange({ ref: "refs/notes/commits", expectedOldOid: ZERO_OID, newOid: commitOid });
  if (landed.tag !== "committed") throw new Error(`notes ref rejected: ${JSON.stringify(landed)}`);
}

describe("GET /repos/.../git/notes/{sha} (repo-extras-t2)", () => {
  beforeAll(async () => {
    await seedNoteIfAbsent(SLUG, TIP1, "release note: v1\n");
  });

  it("serves the note text plus the last commit that touched it", async () => {
    const note = await send(`${REPO_PATH}/git/notes/${TIP1}`);
    expect(note.status).toBe(200);
    const body: { message: string; commit: { sha: string; commit: { message: string } } } = await note.json();
    expect(body.message).toBe("release note: v1\n");
    expect(body.commit.sha).not.toBe(TIP1); // the note-adding commit, not the annotated one
    expect(body.commit.commit.message).toContain("notes: added");

    expect((await send(`${REPO_PATH}/git/notes/${TIP2}`)).status).toBe(404); // no note for that commit
  });

  it("422s invalid ref patterns and 404s repos without a notes ref", async () => {
    expect((await send(`${REPO_PATH}/git/notes/bad..pattern`)).status).toBe(422);
    expect((await send(`${REPO_PATH}/git/notes/main.lock`)).status).toBe(422);
    expect((await send(`/repos/extras/cfg/git/notes/${TIP1}`)).status).toBe(404); // real sha, but no notes ref
    expect((await send("/repos/extras/ghost/git/notes/abcd")).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /repos/{owner}/{repo}/pulls/comments/{id}/resolve|unresolve
// POST /repos/{owner}/{repo}/pulls/{index}/comments/{id}/replies
// ---------------------------------------------------------------------------

/** A PR + its issue handle, plus a code comment attached to a review. */
async function seedPullWithCodeComment(options: { posterId: number; reviewId?: number }) {
  const service = new IssuesService(env.DB);
  const pull = await service.createPullRequest({
    repoId: engineRepoId,
    headRepoId: engineRepoId,
    baseBranch: "main",
    headBranch: "topic",
    title: "seed pull",
    posterId: options.posterId,
  });
  const now = new Date();
  const comment = (
    await drizzle(env.DB)
      .insert(comments)
      .values({
        type: CommentType.Code,
        posterId: ownerId,
        issueId: pull.issue.id,
        line: 2,
        treePath: "src/lib.txt",
        content: "parent remark",
        patch: "diff --git a/src/lib.txt b/src/lib.txt\n--- a/src/lib.txt\n@@ -1 +1 @@\n-lib v1\n+lib v2\n",
        commitSha: TIP2,
        oldRef: TIP2,
        reviewId: options.reviewId ?? 555,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: comments.id })
      .all()
  )[0]!.id;
  return { pull, comment };
}

describe("POST .../pulls/{index}/comments/{id}/replies (repo-extras-t2)", () => {
  it("creates a code comment sharing the parent's location fields and bumps num_comments", async () => {
    const { pull, comment } = await seedPullWithCodeComment({ posterId: ownerId });
    const reply = await send(
      `${REPO_PATH}/pulls/${pull.pullRequest.index}/comments/${comment}/replies`,
      jsonAuthed({ body: "looking" }, "POST"),
    );
    expect(reply.status).toBe(201);
    const body: {
      body: string;
      path: string;
      commit_id: string;
      original_commit_id: string;
      diff_hunk: string;
      position: number | null;
      original_position: number | null;
      pull_request_review_id: number;
      pull_request_url: string;
      user: { login: string } | null;
    } = await reply.json();
    expect(body.body).toBe("looking");
    expect(body.path).toBe("src/lib.txt");
    expect(body.commit_id).toBe(TIP2);
    expect(body.original_commit_id).toBe(TIP2);
    expect(body.diff_hunk).toBe("@@ -1 +1 @@\n-lib v1\n+lib v2\n"); // patch2diff: the last hunk only
    expect(body.position).toBe(2);
    expect(body.original_position).toBeNull();
    expect(body.pull_request_review_id).toBe(555);
    expect(body.pull_request_url).toBe(`https://example.com/${OWNER}/${SLUG}/pulls/${pull.pullRequest.index}`);
    expect(body.user?.login).toBe(OWNER);

    const issueRow = await drizzle(env.DB)
      .select({ n: issues.numComments })
      .from(issues)
      .where(eq(issues.id, pull.issue.id))
      .get();
    expect(issueRow?.n).toBe(1);
  });

  it("404s on a foreign index, 400s on review-less/non-code parents and 422s malformed bodies", async () => {
    const { comment } = await seedPullWithCodeComment({ posterId: ownerId });
    expect(
      (await send(`${REPO_PATH}/pulls/99/comments/${comment}/replies`, jsonAuthed({ body: "x" }, "POST"))).status,
    ).toBe(404);

    const { pull: reviewlessPull, comment: orphanReview } = await seedPullWithCodeComment({
      posterId: ownerId,
      reviewId: 0,
    });
    const noReview = await send(
      `${REPO_PATH}/pulls/${reviewlessPull.pullRequest.index}/comments/${orphanReview}/replies`,
      jsonAuthed({ body: "x" }, "POST"),
    );
    expect(noReview.status).toBe(400);
    const noReviewBody: { message: string } = await noReview.json();
    expect(noReviewBody.message).toBe("comment is not a review comment");

    const service = new IssuesService(env.DB);
    const plain = await service.createIssue({ repoId: engineRepoId, title: "plain", posterId: ownerId });
    const plainComment = (
      await drizzle(env.DB)
        .insert(comments)
        .values({ type: CommentType.Comment, posterId: ownerId, issueId: plain.id, content: "hi", createdAt: NOW, updatedAt: NOW })
        .returning({ id: comments.id })
        .all()
    )[0]!.id;
    const notCode = await send(`${REPO_PATH}/pulls/comments/${plainComment}/resolve`, authed({ method: "POST" }));
    expect(notCode.status).toBe(400); // shared target resolver: not a review comment

    expect(
      (await send(`${REPO_PATH}/pulls/1/comments/${comment}/replies`, jsonAuthed({ nope: true }, "POST"))).status,
    ).toBe(422);
  });
});

describe("POST .../pulls/comments/{id}/resolve|unresolve (repo-extras-t2)", () => {
  it("resolves idempotently and unresolves back to the cleared state", async () => {
    const { comment } = await seedPullWithCodeComment({ posterId: ownerId });
    expect((await send(`${REPO_PATH}/pulls/comments/${comment}/resolve`, authed({ method: "POST" }))).status).toBe(204);
    let row = await drizzle(env.DB)
      .select({ resolved: comments.resolveDoerId })
      .from(comments)
      .where(eq(comments.id, comment))
      .get();
    expect(row?.resolved).toBe(ownerId);
    expect(
      (await send(`${REPO_PATH}/pulls/comments/${comment}/resolve`, authed({ method: "POST" }))).status,
    ).toBe(204); // idempotent
    row = await drizzle(env.DB)
      .select({ resolved: comments.resolveDoerId })
      .from(comments)
      .where(eq(comments.id, comment))
      .get();
    expect(row?.resolved).toBe(ownerId);

    expect((await send(`${REPO_PATH}/pulls/comments/${comment}/unresolve`, authed({ method: "POST" }))).status).toBe(204);
    row = await drizzle(env.DB)
      .select({ resolved: comments.resolveDoerId })
      .from(comments)
      .where(eq(comments.id, comment))
      .get();
    expect(row?.resolved).toBeNull();
  });

  it("gates by issue-poster or repo write; 404 unknown comments", async () => {
    const { comment } = await seedPullWithCodeComment({ posterId: ownerId });
    expect(
      (await send(`${REPO_PATH}/pulls/comments/${comment}/resolve`, authed({ method: "POST" }, TOKEN_OUTSIDER))).status,
    ).toBe(403);

    // The issue poster may resolve without write access (CanMarkConversation).
    const { comment: neighborComment } = await seedPullWithCodeComment({ posterId: neighborId });
    const posterResolve = await send(
      `${REPO_PATH}/pulls/comments/${neighborComment}/resolve`,
      authed({ method: "POST" }, TOKEN_NEIGHBOR),
    );
    expect(posterResolve.status).toBe(204);

    expect((await send(`${REPO_PATH}/pulls/comments/999999/resolve`, authed({ method: "POST" }))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST /repos/{owner}/{repo}/pulls/{index}/update
// ---------------------------------------------------------------------------

describe("POST .../pulls/{index}/update (repo-extras-t2)", () => {
  it("merges base into head once, then answers 200 on every nothing-to-do arm", async () => {
    // topic = TIP1 (one behind main = TIP2). Idempotent: a stale topic ref
    // from a previous run is CAS-deleted and recreated at TIP1.
    const cell = engineCell(env, { ownerNamespace: OWNER, slug: SLUG });
    const existingRefs = await cell.listRefs();
    const existingTopic = existingRefs.refs.find((ref) => ref.name === "refs/heads/topic");
    if (existingTopic !== undefined && existingTopic.target !== TIP1) {
      const deleted = await cell.deleteApiRef({ ref: "refs/heads/topic", expectedOid: existingTopic.target });
      if (deleted.tag !== "deleted") throw new Error(`topic ref delete rejected: ${JSON.stringify(deleted)}`);
    }
    if (existingTopic === undefined || existingTopic.target !== TIP1) {
      const created = await cell.commitApiChange({ ref: "refs/heads/topic", expectedOldOid: ZERO_OID, newOid: TIP1 });
      if (created.tag !== "committed") throw new Error(`topic ref rejected: ${JSON.stringify(created)}`);
    }
    const { pull } = await seedPullWithCodeComment({ posterId: ownerId, reviewId: 0 });
    const index = pull.pullRequest.index;

    const tipOf = async (branch: string): Promise<string | undefined> =>
      (await cell.listRefs()).refs.find((ref) => ref.name === `refs/heads/${branch}`)?.target;

    const merged = await send(`${REPO_PATH}/pulls/${index}/update`, authed({ method: "POST" }));
    expect(merged.status).toBe(200);
    const newTip = await tipOf("topic");
    expect(newTip).not.toBe(TIP1);
    const mergeCommit = await cell.readCommit(newTip);
    expect(mergeCommit?.parents).toEqual([TIP1, TIP2]); // a true merge of base into head
    expect(mergeCommit?.message).toContain("Merge branch 'main' into topic");

    // main is now an ancestor of topic: nothing to merge (200), and the
    // rebase-style update hits the engine's up_to_date arm (head already
    // sits on the base — upstream 500s that arm, update.go:50-53; the
    // declared family answers 200 with no ref move).
    expect((await send(`${REPO_PATH}/pulls/${index}/update`, authed({ method: "POST" }))).status).toBe(200);
    const rebased = await send(`${REPO_PATH}/pulls/${index}/update?style=rebase`, authed({ method: "POST" }));
    expect(rebased.status).toBe(200);
    expect(await tipOf("topic")).toBe(newTip);

    expect(
      (await send(`${REPO_PATH}/pulls/${index}/update`, authed({ method: "POST" }, TOKEN_NEIGHBOR))).status,
    ).toBe(403);
    expect((await send(`${REPO_PATH}/pulls/999/update`, authed({ method: "POST" }))).status).toBe(404);
  });

  it("422s already-merged pulls", async () => {
    const { pull } = await seedPullWithCodeComment({ posterId: ownerId, reviewId: 0 });
    await drizzle(env.DB).update(pullRequests).set({ hasMerged: true }).where(eq(pullRequests.issueId, pull.issue.id));
    const response = await send(`${REPO_PATH}/pulls/${pull.pullRequest.index}/update`, authed({ method: "POST" }));
    expect(response.status).toBe(422);
    const body: { message: string } = await response.json();
    expect(body.message).toBe("pull request is already merged");
  });
});

// ---------------------------------------------------------------------------
// GET /repos/{owner}/{repo}/contents-ext/{filepath} + file-contents
// ---------------------------------------------------------------------------

describe("GET .../contents-ext/{filepath} (repo-extras-t2)", () => {
  it("renders files, directories and the root union", async () => {
    const file = await send(`${REPO_PATH}/contents-ext/README.md`);
    expect(file.status).toBe(200);
    const fileBody: { file_contents?: { name: string; type: string; content: string | null } } = await file.json();
    expect(fileBody.file_contents?.name).toBe("README.md");
    expect(fileBody.file_contents?.type).toBe("file");
    expect(atob(fileBody.file_contents?.content ?? "")).toBe("# engine suite\n");

    const dir = await send(`${REPO_PATH}/contents-ext/src`);
    expect(dir.status).toBe(200);
    const dirBody: { dir_contents?: Array<{ path: string; type: string }> } = await dir.json();
    expect(dirBody.dir_contents?.map((entry) => entry.path)).toEqual(["src/lib.txt"]);

    const root = await send(`${REPO_PATH}/contents-ext/.`);
    expect(root.status).toBe(200);
    const rootBody: { dir_contents?: Array<{ name: string }> } = await root.json();
    expect(rootBody.dir_contents?.map((entry) => entry.name)).toEqual(["README.md", "docs", "src"]);

    expect((await send(`${REPO_PATH}/contents-ext/nope.txt`)).status).toBe(404);
    expect((await send("/repos/extras/ghost/contents-ext/README.md")).status).toBe(404);
  });

  it("serves multi-segment paths through the plain-hono catchall and honors ?ref", async () => {
    const deep = await send(`${REPO_PATH}/contents-ext/docs/guide/deep.txt`);
    expect(deep.status).toBe(200);
    const deepBody: { file_contents?: { path: string; content: string | null } } = await deep.json();
    expect(deepBody.file_contents?.path).toBe("docs/guide/deep.txt");
    expect(atob(deepBody.file_contents?.content ?? "")).toBe("deep doc\n");

    // The first revision's lib.txt (the ?ref oid pins the tree).
    const old = await send(`${REPO_PATH}/contents-ext/src/lib.txt?ref=${TIP1}`);
    expect(old.status).toBe(200);
    const oldBody: { file_contents?: { content: string | null } } = await old.json();
    expect(atob(oldBody.file_contents?.content ?? "")).toBe("lib v1\n");

    // An unknown non-hex ref is the upstream 404 (resolveRefCommit →
    // APIErrorAuto on git.ErrNotExist, file.go:695-700) — the default branch
    // only applies to the ABSENT ref param, never as a fallback.
    expect((await send(`${REPO_PATH}/contents-ext/README.md?ref=zzz-ghost`)).status).toBe(404);
  });
});

describe("GET+POST .../file-contents (repo-extras-t2)", () => {
  it("batch-reads files, rendering unretrievable entries as null", async () => {
    const posted = await send(`${REPO_PATH}/file-contents`, jsonAuthed({ files: ["README.md", "missing.txt"] }, "POST"));
    expect(posted.status).toBe(200);
    const batch: Array<{ name: string } | null> = await posted.json();
    expect(batch).toHaveLength(2);
    expect(batch[0]?.name).toBe("README.md");
    expect(batch[1]).toBeNull();

    const getUrl = `${REPO_PATH}/file-contents?body=${encodeURIComponent(JSON.stringify({ files: ["src/lib.txt"] }))}`;
    const got = await send(getUrl);
    expect(got.status).toBe(200);
    const gotBody: Array<{ path: string } | null> = await got.json();
    expect(gotBody[0]?.path).toBe("src/lib.txt");

    expect((await send(`${REPO_PATH}/file-contents`)).status).toBe(400); // runtime-only: missing body param
    expect((await send(`${REPO_PATH}/file-contents?body=not-json`)).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET+PATCH+DELETE /repos/{owner}/{repo}/releases/{id}/assets/{attachment_id}
// ---------------------------------------------------------------------------

describe("release attachment items (repo-extras-t2)", () => {
  it("gets one attachment with the contract Attachment shape", async () => {
    const releaseId = await seedRelease();
    const assetId = await seedAsset(releaseId);
    const response = await send(`${REPO_PATH}/releases/${releaseId}/assets/${assetId}`);
    expect(response.status).toBe(200);
    const body: {
      id: number;
      name: string;
      size: number;
      uuid: string;
      download_count: number;
      browser_download_url: string;
      created_at: string | undefined;
    } = await response.json();
    expect(body.id).toBe(assetId);
    expect(body.name).toBe("dl.bin");
    expect(body.size).toBe(4);
    expect(body.download_count).toBe(0);
    expect(body.browser_download_url).toContain("/attachments/");
    expect(body.created_at).toBe(NOW.toISOString());
  });

  it("404s cross-release ids, tag records and drafts invisible to non-writers", async () => {
    const releaseId = await seedRelease();
    const otherRelease = await seedRelease({ tagName: "v2.0.0" });
    const otherAsset = await seedAsset(otherRelease);
    expect((await send(`${REPO_PATH}/releases/${releaseId}/assets/${otherAsset}`)).status).toBe(404);

    const tagRelease = await seedRelease({ tagName: "just-tag", isTag: true });
    expect((await send(`${REPO_PATH}/releases/${tagRelease}/assets/1`)).status).toBe(404);

    const draftRelease = await seedRelease({ tagName: "v3.0.0-draft", isDraft: true });
    const draftAsset = await seedAsset(draftRelease);
    expect((await send(`${REPO_PATH}/releases/${draftRelease}/assets/${draftAsset}`)).status).toBe(404); // anonymous
    expect(
      (await send(`${REPO_PATH}/releases/${draftRelease}/assets/${draftAsset}`, authed(undefined, TOKEN_NEIGHBOR)))
        .status,
    ).toBe(404);
    expect((await send(`${REPO_PATH}/releases/${draftRelease}/assets/${draftAsset}`, authed())).status).toBe(200); // writer

    expect((await send(`${REPO_PATH}/releases/${releaseId}/assets/999999`)).status).toBe(404);
    expect((await send(`${REPO_PATH}/releases/999999/assets/1`)).status).toBe(404);
  });

  it("renames through PATCH with the upstream 201, gated to repo writers", async () => {
    const releaseId = await seedRelease();
    const assetId = await seedAsset(releaseId);
    expect(
      (
        await send(
          `${REPO_PATH}/releases/${releaseId}/assets/${assetId}`,
          jsonAuthed({ name: "renamed.bin" }, "PATCH", TOKEN_NEIGHBOR),
        )
      ).status,
    ).toBe(403); // runtime-only writer gate

    const renamed = await send(
      `${REPO_PATH}/releases/${releaseId}/assets/${assetId}`,
      jsonAuthed({ name: "renamed.bin" }, "PATCH"),
    );
    expect(renamed.status).toBe(201);
    const renamedBody: { name: string } = await renamed.json();
    expect(renamedBody.name).toBe("renamed.bin");
    const row = await drizzle(env.DB)
      .select({ name: releaseAssets.name })
      .from(releaseAssets)
      .where(eq(releaseAssets.id, assetId))
      .get();
    expect(row?.name).toBe("renamed.bin");

    const untouched = await send(
      `${REPO_PATH}/releases/${releaseId}/assets/${assetId}`,
      jsonAuthed({ name: "" }, "PATCH"),
    );
    expect(untouched.status).toBe(201); // upstream: only a non-empty name applies
    const untouchedBody: { name: string } = await untouched.json();
    expect(untouchedBody.name).toBe("renamed.bin");
  });

  it("deletes the R2 object and the D1 row; a repeat is 404", async () => {
    const releaseId = await seedRelease();
    const assetId = await seedAsset(releaseId);
    const row = await drizzle(env.DB)
      .select({ key: releaseAssets.r2Key })
      .from(releaseAssets)
      .where(eq(releaseAssets.id, assetId))
      .get();
    expect(await env.REPO_PACKS.head(row!.key)).not.toBeNull();

    expect((await send(`${REPO_PATH}/releases/${releaseId}/assets/${assetId}`, authed({ method: "DELETE" }))).status).toBe(204);
    expect(await env.REPO_PACKS.head(row!.key)).toBeNull();
    const rows = await drizzle(env.DB).select({ id: releaseAssets.id }).from(releaseAssets).all();
    expect(rows).toHaveLength(0);
    expect(
      (await send(`${REPO_PATH}/releases/${releaseId}/assets/${assetId}`, authed({ method: "DELETE" }))).status,
    ).toBe(404);
  });

  it("412s when the releases unit is disabled (runtime-only)", async () => {
    const repoId = await seedRepoRow("norel");
    await drizzle(env.DB).insert(repoSettings).values({ repoId, hasReleases: false });
    const response = await send(`/repos/${OWNER}/${repoId}/releases/1/assets/1`);
    expect(response.status).toBe(412);
  });
});

// ---------------------------------------------------------------------------
// POST /repos/{owner}/{repo}/transfer/accept + /reject
// ---------------------------------------------------------------------------

describe("POST .../transfer/accept + /reject (repo-extras-t2)", () => {
  it("accepts as the pending recipient: 202 + the moved repository + the §2.5.4 redirect set", async () => {
    const repoId = await seedRepoRow("accept");
    await seedPendingTransfer(repoId, neighborId);
    expect(
      (await send(`/repos/${OWNER}/t2-accept/transfer/accept`, authed({ method: "POST" }, TOKEN_OUTSIDER))).status,
    ).toBe(403);

    const accepted = await send(`/repos/${OWNER}/t2-accept/transfer/accept`, authed({ method: "POST" }, TOKEN_NEIGHBOR));
    expect(accepted.status).toBe(202);
    const body: { owner: { login: string }; name: string } = await accepted.json();
    expect(body.owner.login).toBe("neighbor");
    expect(body.name).toBe("t2-accept");

    const pending = await drizzle(env.DB).select().from(repoTransfer).all();
    expect(pending).toHaveLength(0); // the pending row dies with the move

    const redirect = await drizzle(env.DB)
      .select()
      .from(repoRedirects)
      .where(eq(repoRedirects.ownerNamespace, OWNER))
      .all();
    expect(redirect.map((row) => row.lowerName)).toEqual(["t2-accept"]); // the old URL keeps working
  });

  // REDEPLOY13's transfer-accept wiring gap, closed: the route now rides the
  // full engine-dep set (registry + tombstone + carry), so acceptTransfer's
  // moveEngineCell actually runs — the cells answer at the NEW owner, the old
  // pair is tombstoned, the wiki sibling + registry entry move with the row
  // (upstream's accept-step rename, transferOwnership transfer.go:308-327).
  it("accept carries the engine cells to the new owner: refs answer at the new namespace, the old pair tombstoned, wiki sibling + registry move", async () => {
    // Real engine content (the beforeAll ensureSeededRepo pattern) — a
    // D1-only row would carry nothing and assert nothing.
    const slug = "t2-carry";
    const seeded = await ensureSeededRepo({
      owner: OWNER,
      slug,
      commits: [
        { message: "seed: carry me over", time: T0, files: [{ path: "README.md", content: "# carry suite\n" }] },
      ],
    });
    const tip = seeded.tips[0] as string;
    const row = await drizzle(env.DB)
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, slug)))
      .get();
    if (row === undefined) throw new Error("carry repo row missing");
    const ownerRow = await drizzle(env.DB).select().from(users).where(eq(users.id, ownerId)).get();
    if (ownerRow === undefined) throw new Error("carry owner row missing");

    // Provision the wiki sibling so the move has pages to carry (upstream
    // renames an EXISTING wiki at the accept; a never-provisioned one
    // round-trips empty either way — the unwired wikiExists posture).
    await createWikiPage(
      env,
      { repo: row, owner: ownerRow },
      { name: OWNER, email: `${OWNER}@example.com` },
      { title: "Home", content: new TextEncoder().encode("# Home\n"), message: "" },
      "https://example.com",
      { now: 1_700_000_000 },
    );
    // Producer sanity: both cells live under the old owner.
    expect((await env.REPO.getByName(`${OWNER}/${slug}`).listRefs()).refs.map((r) => r.name)).toEqual([
      "refs/heads/main",
    ]);
    expect((await env.REPO.getByName(`${OWNER}/${slug}.wiki`).listRefs()).refs.map((r) => r.name)).toEqual([
      "refs/heads/main",
    ]);

    await seedPendingTransfer(row.id, neighborId);
    const accepted = await send(`/repos/${OWNER}/${slug}/transfer/accept`, authed({ method: "POST" }, TOKEN_NEIGHBOR));
    expect(accepted.status).toBe(202);

    // The MAIN cell answers at the NEW owner with the pushed ref...
    const after = await env.REPO.getByName(`neighbor/${slug}`).listRefs();
    expect(after.refs.map((r) => [r.name, r.target])).toEqual([["refs/heads/main", tip]]);
    // ...the OLD cell is tombstoned (refuses new receive leases)...
    await expectTombstonedCell(`${OWNER}/${slug}`);
    // ...the wiki sibling carried (the page reads through the landed read
    // path at the derived new name; the old sibling refuses leases too)...
    const moved = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, row.id)).get();
    if (moved === undefined) throw new Error("moved row missing");
    const neighborRow = await drizzle(env.DB).select().from(users).where(eq(users.id, neighborId)).get();
    if (neighborRow === undefined) throw new Error("neighbor row missing");
    const page = await readWikiPage(env, { repo: moved, owner: neighborRow }, "Home", "https://example.com");
    expect(page).not.toBeNull();
    expect(atob(page!.content_base64)).toContain("# Home");
    expect((await env.REPO.getByName(`neighbor/${slug}.wiki`).listRefs()).refs.map((r) => r.name)).toEqual([
      "refs/heads/main",
    ]);
    await expectTombstonedCell(`${OWNER}/${slug}.wiki`);
    // ...and the registry entry re-pointed (upsert new BEFORE remove old).
    expect(await env.REGISTRY.getByName("registry").get(`neighbor/${slug}`)).not.toBeNull();
    expect(await env.REGISTRY.getByName("registry").get(`${OWNER}/${slug}`)).toBeNull();
  });

  it("404s accept without a pending row", async () => {
    await seedRepoRow("noaccept");
    const response = await send(`/repos/${OWNER}/t2-noaccept/transfer/accept`, authed({ method: "POST" }, TOKEN_NEIGHBOR));
    expect(response.status).toBe(404);
    const body: { message: string } = await response.json();
    expect(body.message).toBe("no pending transfer for repository: t2-noaccept");
  });

  it("rejects recipient-only: 200 + the untouched repository, pending row deleted", async () => {
    const repoId = await seedRepoRow("reject");
    await seedPendingTransfer(repoId, neighborId);
    expect(
      (await send(`/repos/${OWNER}/t2-reject/transfer/reject`, authed({ method: "POST" }, TOKEN_OUTSIDER))).status,
    ).toBe(403);

    const rejected = await send(`/repos/${OWNER}/t2-reject/transfer/reject`, authed({ method: "POST" }, TOKEN_NEIGHBOR));
    expect(rejected.status).toBe(200);
    const body: { owner: { login: string }; name: string } = await rejected.json();
    expect(body.owner.login).toBe(OWNER); // untouched
    expect(body.name).toBe("t2-reject");
    const pending = await drizzle(env.DB).select().from(repoTransfer).all();
    expect(pending).toHaveLength(0);

    // The repo owner is NOT upstream-eligible for reject (asymmetric with accept).
    await seedPendingTransfer(repoId, neighborId);
    expect((await send(`/repos/${OWNER}/t2-reject/transfer/reject`, authed({ method: "POST" }))).status).toBe(403);
    expect(
      (await send(`/repos/${OWNER}/t2-reject/transfer/reject`, authed({ method: "POST" }, TOKEN_NEIGHBOR))).status,
    ).toBe(200);
  });

  it("404s reject without a pending row", async () => {
    await seedRepoRow("noreject");
    const response = await send(`/repos/${OWNER}/t2-noreject/transfer/reject`, authed({ method: "POST" }, TOKEN_NEIGHBOR));
    expect(response.status).toBe(404);
  });
});
