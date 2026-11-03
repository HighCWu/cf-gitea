/**
 * The parity-review item-3 render fix: `Repository.topics`/`licenses` come
 * from the stored sets through `toApiRepositoryFull` (upstream renders them
 * on every payload — `Topics: util.SliceNilAsEmpty(repo.Topics)` /
 * `Licenses: util.SliceNilAsEmpty(repoLicenses.StringList())`,
 * services/convert/repository.go:265/267; the license read is
 * GetRepoLicenses `.Asc("license")` mapped 1:1, models/repo/license.go:30-35/
 * 46-54; the topics ordering is the syncTopicsInRepository `name ASC`,
 * models/repo/topic.go:340-353).
 *
 * Pinned here: the PUT-then-render round trip (the review's "round-trip
 * lies" arm), the license ASC order with duplicates PRESERVED (StringList is
 * a 1:1 map, no dedupe), the empty-store honesty (never a fake list), and
 * the sync converter's `[]` default (the documented query-flat list shape —
 * relations absent means the list paths keep the parity-review item-9
 * divergence).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { repositories } from "../../db/schema";
import { findRepositoryByPath, toApiRepository, toApiRepositoryFull, type Viewer } from "./repository";
import { replaceRepoTopics } from "./repo-topics";

const VIEWER: Viewer = { origin: "https://example.com", requester: null };

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["repo_topics", "repo_license", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, type, created_at) VALUES (1, 'alice', 'alice', 0, 'active', 'user', 0)",
  ).run();
  await drizzle(env.DB).insert(repositories).values({
    id: "8101",
    storageKey: "r_8101",
    ownerNamespace: "alice",
    ownerId: 1,
    slug: "render",
    visibility: "public",
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
});

async function pair() {
  const found = await findRepositoryByPath(env.DB, "alice", "render");
  if (found === null) {
    throw new Error("fixture repo missing");
  }
  return found;
}

async function insertLicense(license: string, licensePath = "LICENSE"): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO repo_license (repo_id, commit_id, license, license_path, created_unix, updated_unix) VALUES ('8101', 'c1', ?, ?, 0, 0)",
  )
    .bind(license, licensePath)
    .run();
}

describe("toApiRepositoryFull renders the stored topics/licenses (parity item 3)", () => {
  it("renders seeded topics sorted by name ASC (syncTopicsInRepository order)", async () => {
    await replaceRepoTopics(env.DB, "8101", ["web", "ci", "api"]);
    const payload = await toApiRepositoryFull(env.DB, VIEWER, await pair());
    expect(payload.topics).toEqual(["api", "ci", "web"]);
  });

  it("renders detected licenses ascending, duplicates preserved (StringList 1:1)", async () => {
    await insertLicense("MIT");
    await insertLicense("Apache-2.0", "LICENSES/Apache-2.0.txt");
    await insertLicense("MIT", "docs/LICENSE");
    const payload = await toApiRepositoryFull(env.DB, VIEWER, await pair());
    expect(payload.licenses).toEqual(["Apache-2.0", "MIT", "MIT"]);
  });

  it("renders [] for both fields on an empty store (the honest empty, never a fake list)", async () => {
    const payload = await toApiRepositoryFull(env.DB, VIEWER, await pair());
    expect(payload.topics).toEqual([]);
    expect(payload.licenses).toEqual([]);
  });

  it("round-trips the PUT semantics: replace reflects in the payload", async () => {
    await replaceRepoTopics(env.DB, "8101", ["web", "ci"]);
    const before = await toApiRepositoryFull(env.DB, VIEWER, await pair());
    expect(before.topics).toEqual(["ci", "web"]);

    await replaceRepoTopics(env.DB, "8101", ["web", "dsp"]);
    const after = await toApiRepositoryFull(env.DB, VIEWER, await pair());
    expect(after.topics).toEqual(["dsp", "web"]);
  });

  it("renders the row's topics from the FN-4 column without relations; licenses stay [] (parity items 3/9)", async () => {
    // The FN-4 port (migration 0068) moved topics onto the repositories row:
    // upstream renders repo.Topics on EVERY payload with no async arm
    // (convert/repository.go:265), so the sync converter renders the column
    // and the former list divergence for topics CLOSES (parity item 3).
    // Licenses keep the full resolver's read — item 9 stands for them.
    await replaceRepoTopics(env.DB, "8101", ["web"]);
    await insertLicense("MIT");
    const payload = toApiRepository(VIEWER, await pair());
    expect(payload.topics).toEqual(["web"]);
    expect(payload.licenses).toEqual([]);
  });
});
