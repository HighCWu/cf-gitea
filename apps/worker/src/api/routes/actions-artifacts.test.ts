/**
 * The /api/v1 Actions ARTIFACTS quartet (routes/actions-artifacts.ts — the
 * board's P1-10 row) on real D1 + R2: every op pinned against the pin's
 * handler (gitea/routers/api/v1/repo/action.go:1863-2151 at fc493688), per
 * arm:
 *
 *   - getArtifacts: the ActionArtifactsResponse shape (the full
 *     ActionArtifact render incl. the zero-valued embedded workflow_run),
 *     the silent page/limit clamp (no X-Total-Count/Link — upstream only
 *     ctx.JSONes the body), the `name` filter, the finalized-v4 filter
 *     (confirmed-or-expired + the "/" content-type marker), the
 *     anti-enumeration 404, and the reqRepoReader(TypeActions) 403 with the
 *     repo-admin OR-clause bypass;
 *   - getArtifact: the v4 200, the miss-family 404 "artifact not found"
 *     (unknown/junk/cross-repo/pending-deletion ids) and the v3 fallthrough
 *     404 "Artifact not found" (UPPERCASE);
 *   - deleteArtifact: the CONFIRMED→pending-deletion flip + 204, the
 *     EXPIRED-row quirk (204 with NO flip — setConfirmedArtifactsStatus'
 *     status filter), the same 404 family, and the gate ladder (anonymous
 *     → the writer 403 — upstream carries NO reqToken on this route; the
 *     unit-less reader 403 fires BEFORE it, group-gate order);
 *   - downloadArtifact: the toolkit's asserted 302 (Location over
 *     buildSigURL's HMAC tag-"api" signature — recomputed and compared in
 *     the test, the ~60-minute expires window, the Go http.Redirect GET
 *     anchor body), the X-Gitea-Fetch-Action JSON-200 flip, the expired
 *     404 "Artifact has expired" BEFORE the v3 uppercase 404;
 *   - zip/raw (the plain route outside the spec): the byte-exact stream
 *     with the ServeUserContentByFile header chain (inline disposition over
 *     path.Base, nosniff, the sandbox CSP, the prod cache-control,
 *     Last-Modified, content-length), the minimal single-range 206 arm +
 *     the 416/400 error texts, the sig-verify order (bad sig 404 "not
 *     found" before the expired-link 401 "Error link expired"), the
 *     repo-miss 404 behind a VALID signature, the cross-repo artifact 404,
 *     and the 302 → raw round trip.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { actionArtifacts, repoCollaborators, repositories, repoUnits, users } from "../../db/schema";
import type { ArtifactRow } from "../../services/actions/artifacts";
import {
  ARTIFACT_STATUS_UPLOAD_CONFIRMED,
  ARTIFACT_STATUS_EXPIRED,
  ARTIFACT_STATUS_PENDING_DELETION,
} from "../../services/actions/artifacts";
import { actionsBuildSignature, base64RawUrlEncode } from "../../services/actions/secrets";
import { createOptionalTokenAuthMiddleware, createTokenAuthMiddleware, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import type { User } from "../models/user";
import { registerActionsArtifactRoutes } from "./actions-artifacts";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["action_artifacts", "repo_units", "repo_settings", "repo_collaborators", "repositories", "user_redirects", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  const prefixes = ["actions/tmp/", "actions/artifacts/", "actions/logs/"];
  for (const prefix of prefixes) {
    const listed = await env.REPO_PACKS.list({ prefix });
    if (listed.objects.length > 0) {
      await env.REPO_PACKS.delete(listed.objects.map((o) => o.key));
    }
  }
  seededUsers.clear();
});

const db = () => drizzle(env.DB);
const ERROR_URL = "https://example.com/api/swagger";

// ---------------------------------------------------------------------------
// Auth rig — the `u<id>` token scheme (secrets-variables.test.ts's pattern).
// ---------------------------------------------------------------------------

interface SeededUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

const seededUsers = new Map<number, SeededUser>();

async function seedUser(username: string, isAdmin = false): Promise<SeededUser> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin,
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  seededUsers.set(user.id, { id: user.id, username: user.username, isAdmin });
  return { id: user.id, username: user.username, isAdmin };
}

function apiUser(user: SeededUser): User {
  return {
    id: user.id,
    login: user.username,
    email: `${user.username.toLowerCase()}@example.com`,
    full_name: "",
    avatar_url: "",
    html_url: "",
    language: "en-US",
    location: "",
    website: "",
    description: "",
    active: true,
    is_admin: user.isAdmin,
    prohibit_login: false,
    restricted: false,
    login_name: "",
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

const resolver: AuthResolver = {
  resolveToken(token) {
    const match = /^u(\d+)$/.exec(token);
    const user = match === null ? undefined : seededUsers.get(Number(match[1]));
    if (match === null || user === undefined) return Promise.resolve(null);
    return Promise.resolve(apiUser(user));
  },
};

const authHeaders = (userId: number): Record<string, string> => ({
  Authorization: `token u${userId}`,
  "Content-Type": "application/json",
});

/** The absolute Location header → the harness router's path+query. */
function localOf(absolute: string): string {
  const url = new URL(absolute);
  return `${url.pathname}${url.search}`;
}

function router() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  const optional = createOptionalTokenAuthMiddleware(resolver);
  registerActionsArtifactRoutes(app, createTokenAuthMiddleware(resolver), optional);
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path.replace(/^\/api\/v1/, "")}`, init), env);
}

const get = (path: string, userId?: number): Promise<Response> =>
  router()(path, { headers: userId === undefined ? {} : authHeaders(userId) });

const del = (path: string, userId?: number): Promise<Response> =>
  router()(path, {
    method: "DELETE",
    headers: userId === undefined ? {} : authHeaders(userId),
  });

// ---------------------------------------------------------------------------
// Seeds.
// ---------------------------------------------------------------------------

interface SeededRepo {
  repoId: string;
  ownerId: number;
}

async function seedRepo(
  owner: SeededUser,
  slug: string,
  options: { visibility?: "public" | "private"; withActionsUnit?: boolean; repoId?: string } = {},
): Promise<SeededRepo> {
  const repoId = options.repoId ?? `9${Math.floor(Math.random() * 900000 + 100000)}`;
  await db().insert(repositories).values({
    id: repoId,
    storageKey: `r_${repoId}`,
    ownerNamespace: owner.username,
    ownerId: owner.id,
    slug,
    visibility: options.visibility ?? "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  if (options.withActionsUnit !== false) {
    await db().insert(repoUnits).values({ repoId, type: "actions" });
  }
  return { repoId, ownerId: owner.id };
}

interface SeedArtifactOptions {
  repoId: string;
  runId?: number;
  name?: string;
  status?: number;
  contentType?: string;
  fileSize?: number;
  expiredUnix?: number;
  commitSha?: string;
  storagePath?: string;
  objectBody?: Uint8Array;
}

async function seedArtifact(options: SeedArtifactOptions): Promise<ArtifactRow> {
  const storagePath = options.storagePath ?? `actions/artifacts/${options.runId ?? 501}/700`;
  if (options.objectBody !== undefined) {
    await env.REPO_PACKS.put(storagePath, options.objectBody);
  }
  const rows = await db()
    .insert(actionArtifacts)
    .values({
      runId: options.runId ?? 501,
      runAttemptId: 1,
      repoId: options.repoId,
      commitSha: options.commitSha ?? "a".repeat(40),
      storagePath,
      fileSize: options.fileSize ?? 1234,
      contentEncodingOrType: options.contentType ?? "application/zip",
      artifactPath: `${options.name ?? "build-output"}.zip`,
      artifactName: options.name ?? "build-output",
      status: options.status ?? ARTIFACT_STATUS_UPLOAD_CONFIRMED,
      created: new Date("2026-03-04T05:06:07Z"),
      updated: new Date("2026-03-04T05:06:08Z"),
      expiredUnix: options.expiredUnix ?? 0,
    })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("artifact seed failed");
  return row;
}

/** The expected `workflow_run` embed of ToActionArtifact — ONLY
 *  {id, repository_id, head_sha} set, everything else at its zero value. */
function expectedWorkflowRun(runId: number, repositoryId: number, headSha: string) {
  return {
    id: runId,
    url: "",
    previous_attempt_url: null,
    html_url: "",
    jobs_url: "",
    logs_url: "",
    artifacts_url: "",
    cancel_url: "",
    rerun_url: "",
    display_title: "",
    path: "",
    event: "",
    run_attempt: 0,
    run_number: 0,
    repository_id: repositoryId,
    head_sha: headSha,
    status: "",
    pull_requests: [],
    created_at: "0001-01-01T00:00:00Z",
    updated_at: "0001-01-01T00:00:00Z",
    started_at: "0001-01-01T00:00:00Z",
    completed_at: "0001-01-01T00:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// getArtifacts (GET /repos/{owner}/{repo}/actions/artifacts)
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/actions/artifacts (getArtifacts)", () => {
  it("200s the ActionArtifactsResponse with the full ActionArtifact render (anonymous on a public repo — the group carries no reqToken)", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    const art = await seedArtifact({ repoId, runId: 501, name: "build-output", fileSize: 1234, commitSha: "b".repeat(40) });

    const res = await get(`/api/v1/repos/artifact-owner/repo/actions/artifacts`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json<Record<string, unknown>>();
    expect(body).toEqual({
      artifacts: [
        {
          id: art.id,
          name: "build-output",
          size_in_bytes: 1234,
          url: `https://example.com/api/v1/repos/artifact-owner/repo/actions/artifacts/${art.id}`,
          archive_download_url: `https://example.com/api/v1/repos/artifact-owner/repo/actions/artifacts/${art.id}/zip`,
          expired: false,
          workflow_run: expectedWorkflowRun(501, Number(repoId), "b".repeat(40)),
          created_at: "2026-03-04T05:06:07.000Z",
          updated_at: "2026-03-04T05:06:08.000Z",
          expires_at: "1970-01-01T00:00:00.000Z",
        },
      ],
      total_count: 1,
    });
  });

  it("filters by the exact `name` query and counts the filtered total", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    await seedArtifact({ repoId, name: "wanted" });
    await seedArtifact({ repoId, name: "other" });

    const res = await get(`/api/v1/repos/artifact-owner/repo/actions/artifacts?name=wanted`);
    expect(res.status).toBe(200);
    const body = await res.json<{ artifacts: { name: string }[]; total_count: number }>();
    expect(body.artifacts.map((a) => a.name)).toEqual(["wanted"]);
    expect(body.total_count).toBe(1);
  });

  it("paginates with the silent page/limit clamp and sends NO pagination headers (upstream only ctx.JSONes the body)", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    const first = await seedArtifact({ repoId, name: "one" });
    await seedArtifact({ repoId, name: "two" });

    const res = await get(`/api/v1/repos/artifact-owner/repo/actions/artifacts?limit=1&page=2`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-total-count")).toBeNull();
    expect(res.headers.get("link")).toBeNull();
    const body = await res.json<{ artifacts: { name: string }[]; total_count: number }>();
    expect(body.total_count).toBe(2);
    expect(body.artifacts.map((a) => a.name)).toEqual(["two"]);
    expect(first.id).toBeGreaterThan(0); // ordering is by id asc; page 2 dropped the first row
  });

  it("lists ONLY finalized v4 rows: confirmed-or-expired with the slash content-type marker — pending-deletion and v3 rows are invisible", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    await seedArtifact({ repoId, name: "v4-confirmed", contentType: "application/zip", status: ARTIFACT_STATUS_UPLOAD_CONFIRMED });
    await seedArtifact({ repoId, name: "v4-expired", contentType: "application/zip", status: ARTIFACT_STATUS_EXPIRED, expiredUnix: 1 });
    await seedArtifact({ repoId, name: "v3-gzip", contentType: "gzip", status: ARTIFACT_STATUS_UPLOAD_CONFIRMED });
    await seedArtifact({ repoId, name: "pending-delete", contentType: "application/zip", status: ARTIFACT_STATUS_PENDING_DELETION });

    const res = await get(`/api/v1/repos/artifact-owner/repo/actions/artifacts`);
    expect(res.status).toBe(200);
    const body = await res.json<{ artifacts: { name: string; expired: boolean }[]; total_count: number }>();
    expect(body.total_count).toBe(2);
    expect(body.artifacts.map((a) => a.name).sort()).toEqual(["v4-confirmed", "v4-expired"]);
    expect(body.artifacts.find((a) => a.name === "v4-expired")?.expired).toBe(true);
  });

  it("404s an unknown or invisible (private, foreign) repo — the anti-enumeration shape", async () => {
    const owner = await seedUser("artifact-owner");
    await seedRepo(owner, "repo");
    await seedRepo(owner, "hidden", { visibility: "private" });

    const missing = await get(`/api/v1/repos/artifact-owner/nope/actions/artifacts`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ message: "not found", url: ERROR_URL });

    const outsider = await seedUser("outsider");
    const invisible = await get(`/api/v1/repos/artifact-owner/hidden/actions/artifacts`, outsider.id);
    expect(invisible.status).toBe(404);
    expect(await invisible.json()).toEqual({ message: "not found", url: ERROR_URL });
  });

  it("403s the actions-unit reader arm on a visible unit-less repo, with the repo-admin OR-clause bypass (api.go:403-410)", async () => {
    const owner = await seedUser("artifact-owner");
    await seedRepo(owner, "nounit", { withActionsUnit: false });

    const anonymous = await get(`/api/v1/repos/artifact-owner/nounit/actions/artifacts`);
    expect(anonymous.status).toBe(403);
    expect(await anonymous.json()).toEqual({
      message: "user should have specific read permission or be a repo admin or a site admin",
      url: ERROR_URL,
    });

    // The owner IS the repo admin — the OR-clause passes even without the unit row.
    const admin = await get(`/api/v1/repos/artifact-owner/nounit/actions/artifacts`, owner.id);
    expect(admin.status).toBe(200);
    expect((await admin.json<{ artifacts: unknown[] }>()).artifacts).toEqual([]);

    // A site admin passes too.
    const siteAdmin = await seedUser("boss", true);
    const adminBypass = await get(`/api/v1/repos/artifact-owner/nounit/actions/artifacts`, siteAdmin.id);
    expect(adminBypass.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// getArtifact (GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id})
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id} (getArtifact)", () => {
  it("200s the single v4 artifact (the same ToActionArtifact render)", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    const art = await seedArtifact({ repoId, name: "single", fileSize: 7, runId: 502, commitSha: "c".repeat(40) });

    const res = await get(`/api/v1/repos/artifact-owner/repo/actions/artifacts/${art.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: art.id,
      name: "single",
      size_in_bytes: 7,
      url: `https://example.com/api/v1/repos/artifact-owner/repo/actions/artifacts/${art.id}`,
      archive_download_url: `https://example.com/api/v1/repos/artifact-owner/repo/actions/artifacts/${art.id}/zip`,
      expired: false,
      workflow_run: expectedWorkflowRun(502, Number(repoId), "c".repeat(40)),
      created_at: "2026-03-04T05:06:07.000Z",
      updated_at: "2026-03-04T05:06:08.000Z",
      expires_at: "1970-01-01T00:00:00.000Z",
    });
  });

  it("404s the miss family with getArtifactByPathParam's lowercase text: unknown id, junk id (parses to 0), a cross-repo id, a pending-deletion row", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    const other = await seedUser("other-owner");
    const otherRepo = await seedRepo(other, "repo");
    const foreign = await seedArtifact({ repoId: otherRepo.repoId, name: "foreign" });
    const doomed = await seedArtifact({ repoId, name: "doomed", status: ARTIFACT_STATUS_PENDING_DELETION });

    for (const [label, url] of [
      ["unknown id", `/api/v1/repos/artifact-owner/repo/actions/artifacts/999999`],
      ["junk id", `/api/v1/repos/artifact-owner/repo/actions/artifacts/not-a-number`],
      ["cross-repo id", `/api/v1/repos/artifact-owner/repo/actions/artifacts/${foreign.id}`],
      ["pending-deletion row", `/api/v1/repos/artifact-owner/repo/actions/artifacts/${doomed.id}`],
    ] as const) {
      const res = await get(url);
      expect(res.status, label).toBe(404);
      expect(await res.json(), label).toEqual({ message: "artifact not found", url: ERROR_URL });
    }
    expect(doomed.status).toBe(ARTIFACT_STATUS_PENDING_DELETION);
    expect(repoId).toBeTruthy();
  });

  it("404s the v3 fallthrough with the UPPERCASE text (v3 not supported — no unique id)", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    const v3 = await seedArtifact({ repoId, name: "legacy", contentType: "gzip" });

    const res = await get(`/api/v1/repos/artifact-owner/repo/actions/artifacts/${v3.id}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "Artifact not found", url: ERROR_URL });
  });

  it("renders the expired row (expired: true) — the by-id read still serves Expired rows", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    const art = await seedArtifact({ repoId, name: "old", status: ARTIFACT_STATUS_EXPIRED, expiredUnix: 1700000000 });

    const res = await get(`/api/v1/repos/artifact-owner/repo/actions/artifacts/${art.id}`);
    expect(res.status).toBe(200);
    const body = await res.json<{ expired: boolean; expires_at: string }>();
    expect(body.expired).toBe(true);
    expect(body.expires_at).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it("renders a NON-numeric (uuid-class) repository id as the documented 0 in the int64 field (the repositoryIdNumber convention, TODO(SPEC-0005))", async () => {
    const owner = await seedUser("artifact-owner");
    await seedRepo(owner, "uuidrepo", { repoId: "7f3c2a1e-0000-4000-8000-000000000001" });
    await seedArtifact({ repoId: "7f3c2a1e-0000-4000-8000-000000000001", name: "uuidparent" });

    const res = await get(`/api/v1/repos/artifact-owner/uuidrepo/actions/artifacts`);
    expect(res.status).toBe(200);
    const body = await res.json<{ artifacts: { workflow_run: { repository_id: number } }[]; total_count: number }>();
    expect(body.total_count).toBe(1);
    expect(body.artifacts[0]?.workflow_run.repository_id).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deleteArtifact (DELETE /repos/{owner}/{repo}/actions/artifacts/{artifact_id})
// ---------------------------------------------------------------------------

describe("DELETE /repos/{owner}/{repo}/actions/artifacts/{artifact_id} (deleteArtifact)", () => {
  it("204s the confirmed v4 row and flips it to pending-deletion (the mark, never a hard delete)", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    const art = await seedArtifact({ repoId, name: "doomed" });

    const res = await del(`/api/v1/repos/artifact-owner/repo/actions/artifacts/${art.id}`, owner.id);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");

    const rows = await db().select().from(actionArtifacts).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe(ARTIFACT_STATUS_PENDING_DELETION);
  });

  it("204s an EXPIRED v4 row WITHOUT flipping it (SetArtifactNeedDeleteByID only updates CONFIRMED rows — the upstream quirk)", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    const art = await seedArtifact({ repoId, name: "expired", status: ARTIFACT_STATUS_EXPIRED, expiredUnix: 1700000000 });

    const res = await del(`/api/v1/repos/artifact-owner/repo/actions/artifacts/${art.id}`, owner.id);
    expect(res.status).toBe(204);
    const rows = await db().select().from(actionArtifacts).all();
    expect(rows[0]?.status).toBe(ARTIFACT_STATUS_EXPIRED);
  });

  it("403s an anonymous caller with the reqRepoWriter text — NO reqToken on this route, so the 401 is unreachable", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    const art = await seedArtifact({ repoId, name: "guarded" });

    const res = await del(`/api/v1/repos/artifact-owner/repo/actions/artifacts/${art.id}`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      message: "user should have a permission to write to a repo",
      url: ERROR_URL,
    });
    const rows = await db().select().from(actionArtifacts).all();
    expect(rows[0]?.status).toBe(ARTIFACT_STATUS_UPLOAD_CONFIRMED);
  });

  it("403s a read-only collaborator, 403s a stranger on the PUBLIC repo (repoAssignment passes anyone; only the writer gate refuses), and 404s a stranger on a PRIVATE repo", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    const art = await seedArtifact({ repoId, name: "collab" });
    const reader = await seedUser("reader");
    await db().insert(repoCollaborators).values({
      repoId,
      userId: reader.id,
      mode: "read",
      createdAt: new Date(),
    });

    const forbidden = await del(`/api/v1/repos/artifact-owner/repo/actions/artifacts/${art.id}`, reader.id);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ message: "user should have a permission to write to a repo", url: ERROR_URL });

    const stranger = await seedUser("stranger");
    const publicRepo = await del(`/api/v1/repos/artifact-owner/repo/actions/artifacts/${art.id}`, stranger.id);
    expect(publicRepo.status).toBe(403);
    expect(await publicRepo.json()).toEqual({ message: "user should have a permission to write to a repo", url: ERROR_URL });

    const hiddenRepo = await seedRepo(owner, "hidden", { visibility: "private" });
    const hidden = await seedArtifact({ repoId: hiddenRepo.repoId, name: "h" });
    const invisible = await del(`/api/v1/repos/artifact-owner/hidden/actions/artifacts/${hidden.id}`, stranger.id);
    expect(invisible.status).toBe(404);
    expect(await invisible.json()).toEqual({ message: "not found", url: ERROR_URL });
  });

  it("keeps the group-gate ORDER on a unit-less repo: the reader 403 fires before the writer gate", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "nounit", { withActionsUnit: false });
    const art = await seedArtifact({ repoId, name: "ordered" });

    const anonymous = await del(`/api/v1/repos/artifact-owner/nounit/actions/artifacts/${art.id}`);
    expect(anonymous.status).toBe(403);
    expect(await anonymous.json()).toEqual({
      message: "user should have specific read permission or be a repo admin or a site admin",
      url: ERROR_URL,
    });

    // The owner (repo admin) passes the reader arm and the writer arm.
    const ok = await del(`/api/v1/repos/artifact-owner/nounit/actions/artifacts/${art.id}`, owner.id);
    expect(ok.status).toBe(204);
  });

  it("404s the same miss family (lowercase miss, uppercase v3)", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    const v3 = await seedArtifact({ repoId, name: "legacy", contentType: "gzip" });

    const miss = await del(`/api/v1/repos/artifact-owner/repo/actions/artifacts/424242`, owner.id);
    expect(miss.status).toBe(404);
    expect(await miss.json()).toEqual({ message: "artifact not found", url: ERROR_URL });

    const v3Miss = await del(`/api/v1/repos/artifact-owner/repo/actions/artifacts/${v3.id}`, owner.id);
    expect(v3Miss.status).toBe(404);
    expect(await v3Miss.json()).toEqual({ message: "Artifact not found", url: ERROR_URL });
    const rows = await db().select().from(actionArtifacts).all();
    expect(rows[0]?.status).toBe(ARTIFACT_STATUS_UPLOAD_CONFIRMED);
  });
});

// ---------------------------------------------------------------------------
// downloadArtifact (GET …/artifacts/{artifact_id}/zip) + the signed URL
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip (downloadArtifact)", () => {
  it("302s the v4 artifact to the signed raw URL — the sig verifies against the tag-'api' HMAC and the expires window is ~60 minutes", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    const art = await seedArtifact({ repoId, name: "downloadable" });

    const res = await get(`/api/v1/repos/artifact-owner/repo/actions/artifacts/${art.id}/zip`);
    expect(res.status).toBe(302);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");

    const location = res.headers.get("location") ?? "";
    const url = new URL(location);
    expect(url.origin).toBe("https://example.com");
    expect(url.pathname).toBe(`/api/v1/repos/artifact-owner/repo/actions/artifacts/${art.id}/zip/raw`);
    const sig = url.searchParams.get("sig") ?? "";
    const expires = url.searchParams.get("expires") ?? "";
    expect(/^\d+$/.test(expires)).toBe(true);
    const expiresNum = Number.parseInt(expires, 10);
    expect(expiresNum).toBeGreaterThan(Math.floor(Date.now() / 1000) + 55 * 60);
    expect(expiresNum).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 60 * 60);

    const endpoint = `api/v1/repos/artifact-owner/repo/actions/artifacts/${art.id}/zip/raw`;
    const expected = base64RawUrlEncode(
      await actionsBuildSignature(env, "api", [endpoint, expires, String(art.id)]),
    );
    expect(sig).toBe(expected);

    // Go's http.Redirect GET body over the escaped location.
    expect(await res.text()).toBe(
      `<a href="${location.replaceAll("&", "&amp;")}">Found</a>.\n`,
    );
  });

  it("answers the fetch-action flip: X-Gitea-Fetch-Action turns the 302 into the JSON 200 {redirect}", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    const art = await seedArtifact({ repoId, name: "fetchable" });

    const res = await router()(`/api/v1/repos/artifact-owner/repo/actions/artifacts/${art.id}/zip`, {
      headers: { "X-Gitea-Fetch-Action": "1" },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ redirect: string }>();
    expect(body.redirect).toContain(`/actions/artifacts/${art.id}/zip/raw?sig=`);
  });

  it("404s the expired arm BEFORE the v3 split ('Artifact has expired') and the v3 fallthrough (uppercase)", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    const expired = await seedArtifact({ repoId, name: "expired", status: ARTIFACT_STATUS_EXPIRED, expiredUnix: 1700000000 });
    const v3 = await seedArtifact({ repoId, name: "legacy", contentType: "gzip" });

    const expiredRes = await get(`/api/v1/repos/artifact-owner/repo/actions/artifacts/${expired.id}/zip`);
    expect(expiredRes.status).toBe(404);
    expect(await expiredRes.json()).toEqual({ message: "Artifact has expired", url: ERROR_URL });

    const v3Res = await get(`/api/v1/repos/artifact-owner/repo/actions/artifacts/${v3.id}/zip`);
    expect(v3Res.status).toBe(404);
    expect(await v3Res.json()).toEqual({ message: "Artifact not found", url: ERROR_URL });

    const miss = await get(`/api/v1/repos/artifact-owner/repo/actions/artifacts/424242/zip`);
    expect(miss.status).toBe(404);
    expect(await miss.json()).toEqual({ message: "artifact not found", url: ERROR_URL });
  });

  it("round-trips: the redirect's Location downloads the stored bytes through the raw endpoint", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    const bytes = new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4]);
    const art = await seedArtifact({ repoId, name: "roundtrip", objectBody: bytes, fileSize: bytes.length });

    const redirect = await get(`/api/v1/repos/artifact-owner/repo/actions/artifacts/${art.id}/zip`);
    expect(redirect.status).toBe(302);
    const location = redirect.headers.get("location") ?? "";

    const raw = await router()(localOf(location), {});
    expect(raw.status).toBe(200);
    const served = new Uint8Array(await raw.arrayBuffer());
    expect(Array.from(served)).toEqual(Array.from(bytes));
  });
});

// ---------------------------------------------------------------------------
// zip/raw (DownloadArtifactRaw — the plain route outside the spec)
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip/raw (DownloadArtifactRaw)", () => {
  /** The signed RAW path for the harness router (the endpoint already
   *  carries the api/v1 prefix — buildDownloadRawEndpoint's shape). */
  async function signedUrlFor(repoPath: string, artifactId: number, expires?: number): Promise<string> {
    const endpoint = `api/v1/repos/${repoPath}/actions/artifacts/${artifactId}/zip/raw`;
    const exp = expires ?? Math.floor(Date.now() / 1000) + 600;
    const sig = base64RawUrlEncode(await actionsBuildSignature(env, "api", [endpoint, String(exp), String(artifactId)]));
    return `/${endpoint}?sig=${sig}&expires=${exp}`;
  }

  it("200s the stored bytes with the ServeUserContentByFile chain (inline disposition over path.Base, nosniff, sandbox CSP, prod cache-control, Last-Modified, content-length)", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);
    const art = await seedArtifact({
      repoId,
      name: "served",
      objectBody: bytes,
      fileSize: bytes.length,
      contentType: "application/zip",
    });

    const res = await router()(await signedUrlFor("artifact-owner/repo", art.id), {});
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-modals allow-popups allow-downloads");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename=${art.artifactPath}`);
    expect(res.headers.get("access-control-expose-headers")).toBe("Content-Disposition");
    expect(res.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    expect(res.headers.get("content-length")).toBe(String(bytes.length));
    expect(res.headers.get("last-modified")).toBeTruthy();
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(bytes));
  });

  it("206s the minimal single-range arm and 416s/400s the invalid shapes with http.Error's plain text", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const art = await seedArtifact({ repoId, name: "ranged", objectBody: bytes, fileSize: bytes.length });
    const base = await signedUrlFor("artifact-owner/repo", art.id);

    const partial = await router()(`${base}`, { headers: { Range: "bytes=1-3" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 1-3/${bytes.length}`);
    expect(partial.headers.get("content-length")).toBe("3");
    expect(Array.from(new Uint8Array(await partial.arrayBuffer()))).toEqual([2, 3, 4]);

    const tail = await router()(`${base}`, { headers: { Range: "bytes=4-" } });
    expect(tail.status).toBe(206);
    expect(Array.from(new Uint8Array(await tail.arrayBuffer()))).toEqual([5, 6]);

    const badStart = await router()(`${base}`, { headers: { Range: "bytes=99-120" } });
    expect(badStart.status).toBe(416);
    expect(await badStart.text()).toBe("invalid start range\n");

    const badEnd = await router()(`${base}`, { headers: { Range: "bytes=2-1" } });
    expect(badEnd.status).toBe(400);
    expect(await badEnd.text()).toBe("invalid end range\n");
  });

  it("404s 'not found' on a bad sig BEFORE the expiry check, and 401s 'Error link expired' on a good sig past its window", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    const art = await seedArtifact({ repoId, name: "authed" });

    const badSig = await router()(`/api/v1/repos/artifact-owner/repo/actions/artifacts/${art.id}/zip/raw?sig=AAAA&expires=9999999999`, {});
    expect(badSig.status).toBe(404);
    expect(await badSig.json()).toEqual({ message: "not found", url: ERROR_URL });

    const junkSig = await router()(`/api/v1/repos/artifact-owner/repo/actions/artifacts/${art.id}/zip/raw?sig=%%%junk&expires=9999999999`, {});
    expect(junkSig.status).toBe(404);
    expect(await junkSig.json()).toEqual({ message: "not found", url: ERROR_URL });

    const noSig = await router()(`/api/v1/repos/artifact-owner/repo/actions/artifacts/${art.id}/zip/raw`, {});
    expect(noSig.status).toBe(404);

    // A VALID signature whose expires is in the past → the 401, not the 404.
    const stale = await signedUrlFor("artifact-owner/repo", art.id, Math.floor(Date.now() / 1000) - 10);
    const expiredLink = await router()(stale, {});
    expect(expiredLink.status).toBe(401);
    expect(await expiredLink.json()).toEqual({ message: "Error link expired", url: ERROR_URL });

    // A missing/garbage expires with a VALID sig parses to 0 → expired → 401.
    const endpoint = `api/v1/repos/artifact-owner/repo/actions/artifacts/${art.id}/zip/raw`;
    const sig = base64RawUrlEncode(await actionsBuildSignature(env, "api", [endpoint, "garbage", String(art.id)]));
    const garbageExpires = await router()(`/${endpoint}?sig=${sig}&expires=garbage`, {});
    expect(garbageExpires.status).toBe(401);
  });

  it("404s a repo-miss and a cross-repo artifact BEHIND a valid signature", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    const art = await seedArtifact({ repoId, name: "scoped" });
    const other = await seedUser("other-owner");
    const otherRepo = await seedRepo(other, "repo");
    const foreign = await seedArtifact({ repoId: otherRepo.repoId, name: "foreign" });

    const missingRepo = await router()(await signedUrlFor("artifact-owner/ghost", art.id), {});
    expect(missingRepo.status).toBe(404);
    expect(await missingRepo.json()).toEqual({ message: "not found", url: ERROR_URL });

    const crossRepo = await router()(await signedUrlFor("artifact-owner/repo", foreign.id), {});
    expect(crossRepo.status).toBe(404);
    expect(await crossRepo.json()).toEqual({ message: "artifact not found", url: ERROR_URL });
  });

  it("404s the expired artifact and the v3 fallthrough with /raw's own LOWERCASE text", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    const expired = await seedArtifact({ repoId, name: "expired", status: ARTIFACT_STATUS_EXPIRED, expiredUnix: 1700000000 });
    const v3 = await seedArtifact({ repoId, name: "legacy", contentType: "gzip" });

    const expiredRes = await router()(await signedUrlFor("artifact-owner/repo", expired.id), {});
    expect(expiredRes.status).toBe(404);
    expect(await expiredRes.json()).toEqual({ message: "Artifact has expired", url: ERROR_URL });

    const v3Res = await router()(await signedUrlFor("artifact-owner/repo", v3.id), {});
    expect(v3Res.status).toBe(404);
    expect(await v3Res.json()).toEqual({ message: "artifact not found", url: ERROR_URL });
  });

  it("does NOT enter the generated OpenAPI document (the plain-route posture — verified via the check:api gate, asserted here by the miss status staying the sig-404, not a spec 400)", async () => {
    const owner = await seedUser("artifact-owner");
    const { repoId } = await seedRepo(owner, "repo");
    const art = await seedArtifact({ repoId, name: "plain" });

    // An UNAUTHENTICATED hit (no sig at all) still reaches the raw arm and
    // answers its own 404 shape — not an openapi-validator 400/404.
    const res = await router()(`/api/v1/repos/artifact-owner/repo/actions/artifacts/${art.id}/zip/raw`, {});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "not found", url: ERROR_URL });
  });
});
