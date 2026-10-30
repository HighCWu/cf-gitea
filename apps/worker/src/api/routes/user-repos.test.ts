/**
 * The POST /user/repos create-response pins (git-e2e finding F6, minor):
 * upstream's 201 body is the RELOADED repository rendered at owner
 * permissions (repo.go:270-274 "reload repo from db to get a real state
 * after creation" → convert.ToRepo(..., AccessModeOwner)) — so it carries
 * the sent description off the row. cf-gitea keeps description in the
 * repo_settings side table, and the create tail skipped that read: the 201
 * rendered the empty default and dropped the field (the follow-up GET was
 * correct, making it a create-response serialization nit only). The fix
 * threads loadRepoSettings into toCreatedOrgRepository at both create
 * routes (user + org share the assembly).
 *
 * The `id` half of F6 is a DOCUMENTED STRUCTURAL seam, not a serialization
 * bug: repositories.id is a UUID text pk (repos/service.ts create), and
 * `repositoryIdNumber` renders non-numeric ids as the documented 0
 * (services/repository.ts — "TODO(SPEC-0005): settle the id format with the
 * registry owner"). Upstream returns a numeric int64 id; matching it means
 * re-keying the registry, which is the repos module's decision, so the
 * response keeps the documented 0 here and the pin asserts the honest
 * current contract.
 */

import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { resetAuthTables } from "../../auth/testing/seeds";
import { repositories, users } from "../../db/schema";
import { STUB_USER, createStubAuthResolver } from "../auth";
import { createApiRouter } from "../router";
import { toCreatedOrgRepository } from "../services/org-repos";
import { DEFAULT_REPO_SETTINGS } from "../services/repo-settings";
import type { RepositoryWithOwner, Viewer } from "../services/repository";

// ---------------------------------------------------------------------------
// Harness (demo-quota.test.ts's shape: locally-mounted router + stub auth)
// ---------------------------------------------------------------------------

async function seedStubRow(): Promise<void> {
  await drizzle(env.DB)
    .insert(users)
    .values({
      id: 1,
      username: STUB_USER.login ?? "cf-gitea-stub",
      usernameLower: (STUB_USER.login ?? "cf-gitea-stub").toLowerCase(),
      isAdmin: false,
      status: "active",
      createdAt: new Date(0),
    });
}

async function apiCreate(body: Record<string, unknown>): Promise<Response> {
  const app = createApiRouter({ auth: createStubAuthResolver(["stub-token"]) });
  const ctx = createExecutionContext();
  const res = await app.fetch(
    new Request("https://example.com/user/repos", {
      method: "POST",
      headers: { authorization: "token stub-token", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(async () => {
  await applyAuthD1Migrations();
  await resetAuthTables();
  for (const table of ["repo_settings", "repo_counters", "repo_redirects", "repositories"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// ---------------------------------------------------------------------------
// F6 pins — the POST /user/repos 201 body
// ---------------------------------------------------------------------------

describe("POST /user/repos create response (F6)", () => {
  it("echoes the sent description (the reload-after-create read, repo.go:270-274)", async () => {
    await seedStubRow();
    const res = await apiCreate({
      name: "f6-description-echo",
      description: "probe description round trip",
      private: true,
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ description: string; name: string }>();
    expect(body.name).toBe("f6-description-echo");
    expect(body.description).toBe("probe description round trip");
  });

  it("an omitted description renders the upstream empty default", async () => {
    await seedStubRow();
    const res = await apiCreate({ name: "f6-no-description", private: false });
    expect(res.status).toBe(201);
    const body = await res.json<{ description: string }>();
    expect(body.description).toBe("");
  });

  it("the create body matches the follow-up GET (the same settings store)", async () => {
    await seedStubRow();
    const owner = STUB_USER.login ?? "cf-gitea-stub";
    const created = await apiCreate({
      name: "f6-roundtrip",
      description: "survives the GET",
      private: false,
    });
    expect(created.status).toBe(201);
    const app = createApiRouter({ auth: createStubAuthResolver(["stub-token"]) });
    const ctx = createExecutionContext();
    const got = await app.fetch(
      new Request(`https://example.com/repos/${owner}/f6-roundtrip`, {
        headers: { authorization: "token stub-token" },
      }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(got.status).toBe(200);
    const body = await got.json<{ description: string }>();
    expect(body.description).toBe("survives the GET");
  });

  it("F6 id half — the documented structural 0: UUID text pk renders 0 pending SPEC-0005", async () => {
    await seedStubRow();
    const res = await apiCreate({ name: "f6-id-zero", private: false });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: number }>();
    // repositoryIdNumber's documented rendering for the UUID pk — the
    // numeric-id format is the registry owner's open SPEC-0005 decision.
    expect(body.id).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// toCreatedOrgRepository — the shared 201 assembly both create routes call
// ---------------------------------------------------------------------------

describe("toCreatedOrgRepository (the shared 201 assembly)", () => {
  /** Real rows through D1 (insert + select) so the fixtures stay typed
   *  against the schema instead of hand-maintained structural literals. */
  async function seedPair(): Promise<{ pair: RepositoryWithOwner; viewer: Viewer }> {
    await drizzle(env.DB).insert(users).values({
      id: 7,
      username: "owner",
      usernameLower: "owner",
      email: "owner@example.com",
      isAdmin: false,
      status: "active",
      createdAt: new Date(0),
    });
    await drizzle(env.DB).insert(repositories).values({
      id: "42",
      storageKey: "r_42",
      ownerNamespace: "owner",
      ownerId: 7,
      slug: "created",
      visibility: "public",
      createdAt: new Date(0),
    });
    const owner = await drizzle(env.DB).select().from(users).where(eq(users.id, 7)).get();
    const repo = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, "42")).get();
    if (owner === undefined || repo === undefined) {
      throw new Error("fixture rows vanished");
    }
    return { pair: { repo, owner }, viewer: { origin: "https://example.com", requester: null } };
  }

  it("carries the settings description and keeps the owner permission triple", async () => {
    const { pair, viewer } = await seedPair();
    const body = toCreatedOrgRepository(viewer, pair, {
      ...DEFAULT_REPO_SETTINGS,
      description: "settings-borne description",
    });
    expect(body.description).toBe("settings-borne description");
    expect(body.permissions).toEqual({ admin: true, push: true, pull: true });
  });

  it("a NUMERIC text pk passes through repositoryIdNumber untouched", async () => {
    const { pair, viewer } = await seedPair();
    const body = toCreatedOrgRepository(viewer, pair);
    expect(body.id).toBe(42);
    // No settings → the pre-fix callers' empty default (the org route now
    // always passes the read; the omission branch is the GET-less shape).
    expect(body.description).toBe("");
  });
});
