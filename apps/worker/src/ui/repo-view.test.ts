/**
 * resolveRepositoryForViewer's require-sign-in-view arm (SPEC-0003 §2.4 row 6,
 * census B-34): upstream's web group carries the flag through optSignIn —
 * anonymous viewers are redirected to login (web.go:354 + web.go:217-220);
 * this tier's documented refusal posture is the 404 shell (SPEC-0008 §2.6 —
 * "invisible repos 404, never a 401"), so the flagged instance reads the
 * anonymous viewer as invisible. Signed-in viewers are never consulted
 * (upstream's SignInRequired arm never touches a resolved doer), and the
 * OFF default keeps the matrix row 1 collapse verbatim. The flag rides an
 * env-slice override (the vitest plugin injects the deployed wrangler vars —
 * default "false" — so the armed arm is driven structurally, the
 * demo-gate tests' posture).
 */

import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories, users } from "../db/schema";
import { seedVerifiedUser } from "../auth/testing/seeds";
import { RepoService } from "../repos/service";
import type { Viewer } from "./viewer";
import { resolveRepositoryForViewer } from "./repo-view";

const ANONYMOUS: Viewer = { kind: "anonymous" };

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["repo_settings", "repo_counters", "repo_redirects", "repositories"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
});

describe("resolveRepositoryForViewer require-sign-in-view arm (census B-34)", () => {
  async function seedPublicRepo(slug: string): Promise<{ repoId: string; ownerId: number; ownerName: string }> {
    const owner = await seedVerifiedUser({ username: `rv_${slug.replace(/-/g, "_")}` });
    const created = await new RepoService(env.DB).create({
      owner: { id: owner.id, usernameLower: owner.username.toLowerCase() },
      name: slug,
      isPrivate: false,
    });
    return { repoId: created.id, ownerId: owner.id, ownerName: owner.username };
  }

  it("flag off (the deployed default): anonymous reads a public repo (matrix row 1's collapse)", async () => {
    const seeded = await seedPublicRepo("rv-off");
    const row = await resolveRepositoryForViewer(env, ANONYMOUS, seeded.ownerName, "rv-off");
    expect(row?.id).toBe(seeded.repoId);
  });

  it("flag on: the anonymous viewer reads the flagged instance as invisible (the 404-shell posture)", async () => {
    const seeded = await seedPublicRepo("rv-on");
    const flagged: Env = Object.assign({}, env, { REQUIRE_SIGNIN_VIEW: "true" });
    expect(await resolveRepositoryForViewer(flagged, ANONYMOUS, seeded.ownerName, "rv-on")).toBeNull();
    // The row itself stays public — the flag masks the VIEW, not the data.
    const row = await drizzle(env.DB)
      .select({ visibility: repositories.visibility })
      .from(repositories)
      .where(eq(repositories.id, seeded.repoId))
      .get();
    expect(row?.visibility).toBe("public");
    // The owner row stays public too.
    const owner = await drizzle(env.DB)
      .select({ visibility: users.visibility })
      .from(users)
      .where(eq(users.id, seeded.ownerId))
      .get();
    expect(owner?.visibility).toBe("public");
  });

  it("flag on: a signed-in viewer is never consulted (the owner still reads their repo)", async () => {
    const seeded = await seedPublicRepo("rv-signed");
    const flagged: Env = Object.assign({}, env, { REQUIRE_SIGNIN_VIEW: "true" });
    const viewer: Viewer = { kind: "user", id: seeded.ownerId, username: seeded.ownerName, isAdmin: false };
    const row = await resolveRepositoryForViewer(flagged, viewer, seeded.ownerName, "rv-signed");
    expect(row?.id).toBe(seeded.repoId);
  });

  it("flag on: an anonymous viewer of a PRIVATE repo stays invisible both ways (row 2, unchanged)", async () => {
    const owner = await seedVerifiedUser({ username: "rv_priv_owner" });
    await new RepoService(env.DB).create({
      owner: { id: owner.id, usernameLower: owner.username.toLowerCase() },
      name: "rv-priv",
      isPrivate: true,
    });
    const flagged: Env = Object.assign({}, env, { REQUIRE_SIGNIN_VIEW: "true" });
    expect(await resolveRepositoryForViewer(env, ANONYMOUS, owner.username, "rv-priv")).toBeNull();
    expect(await resolveRepositoryForViewer(flagged, ANONYMOUS, owner.username, "rv-priv")).toBeNull();
  });
});
