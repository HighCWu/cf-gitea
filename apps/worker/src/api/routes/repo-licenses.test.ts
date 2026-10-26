/**
 * `GET /repos/{owner}/{repo}/licenses` (repoGetLicenses) + the detection
 * glue unit tests (services/repo-licenses.ts), route-level on real D1 (the
 * tag-protections.test.ts standalone-mount convention).
 *
 * Matrix: the LicensesList render (license strings, ascending —
 * GetRepoLicenses' `.Asc("license")`), the unpopulated-honesty arm (no push
 * pipeline yet → []), the anti-enumeration 404s (unknown repo, private repo
 * anonymous), and the glue ports: isLicenseFile (license.go:139-149), the
 * REUSE LICENSES/ arm claiming the whole resolution (license.go:112-131),
 * the no-corpus honesty (root license files yield nothing without an
 * injected detector), and the UpdateRepoLicenses diff (insert/update/
 * delete-by-commit) + CleanRepoLicenses.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createOptionalTokenAuthMiddleware } from "../auth";

import { RepoService } from "../../repos/service";
import type { ApiEnv } from "../env";
import { giteaErrorHandler } from "../errors";
import { registerRepoLicenseRoutes } from "./repo-licenses";
import {
  cleanRepoLicenses,
  getRepoLicenses,
  isLicenseFile,
  pathBaseStem,
  resolveDetectedLicenses,
  updateRepoLicenses,
} from "../../services/repo-licenses";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of ["repo_license", "repo_counters", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, is_admin, status, type, created_at) VALUES (1, 'alice', 'alice', 0, 'active', 'user', 0)",
  ).run();
});

/** Standalone mount (paths strip the /api/v1 prefix). */
function router() {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerRepoLicenseRoutes(app, createOptionalTokenAuthMiddleware({ resolveToken: () => Promise.resolve(null) }));
  return async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path.replace(/^\/api\/v1/, "")}`, init), env);
}

async function createRepo(slug: string, isPrivate = false): Promise<string> {
  const row = await new RepoService(env.DB).create({ owner: { id: 1, usernameLower: "alice" }, name: slug, isPrivate });
  return row.id;
}

async function insertLicense(repoId: string, license: string, licensePath = "LICENSE"): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO repo_license (repo_id, commit_id, license, license_path, created_unix, updated_unix) VALUES (?, 'c1', ?, ?, 0, 0)",
  )
    .bind(repoId, license, licensePath)
    .run();
}

describe("GET /repos/{owner}/{repo}/licenses (repoGetLicenses)", () => {
  it("answers [] while unpopulated (the push pipeline does not call the glue yet)", async () => {
    await createRepo("plain");
    const res = await router()("/api/v1/repos/alice/plain/licenses");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("lists the license names ascending (StringList over GetRepoLicenses)", async () => {
    const repoId = await createRepo("licensed");
    await insertLicense(repoId, "MIT");
    await insertLicense(repoId, "Apache-2.0", "LICENSES/Apache-2.0.txt");
    const res = await router()("/api/v1/repos/alice/licensed/licenses");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(["Apache-2.0", "MIT"]);
  });

  it("404s an unknown repo and an anonymous read of a private one (anti-enumeration)", async () => {
    const missing = await router()("/api/v1/repos/alice/ghost/licenses");
    expect(missing.status).toBe(404);
    await createRepo("secret", true);
    const priv = await router()("/api/v1/repos/alice/secret/licenses");
    expect(priv.status).toBe(404);
  });
});

describe("detection glue ports (services/repo-licenses.ts)", () => {
  it("pathBaseStem strips only the extension (util.PathBaseStem)", () => {
    expect(pathBaseStem("MIT.txt")).toBe("MIT");
    expect(pathBaseStem("LICENSES/Apache-2.0.txt")).toBe("Apache-2.0");
    expect(pathBaseStem("LICENSE")).toBe("LICENSE");
    expect(pathBaseStem("a/b/c.copying.lesser")).toBe("c.copying");
  });

  it("isLicenseFile matches the upstream name predicate (license.go:139-149)", () => {
    for (const yes of ["LICENSE", "license", "LICENSE.md", "LICENCE", "copying", "COPYING.txt", "licence.lesser"]) {
      expect(isLicenseFile(yes), yes).toBe(true);
    }
    for (const no of ["LICENSE.php", "license.sh", "unlicense", "COPYING.tar.gz", "notice.md", "LICENSES"]) {
      expect(isLicenseFile(no), no).toBe(false);
    }
  });

  it("the REUSE arm claims the whole resolution: stems are the SPDX ids, root files ignored", async () => {
    const detected = await resolveDetectedLicenses([
      { path: "LICENSE", isRegular: true, read: () => "should never be read" },
      { path: "LICENSES/MIT.txt", isRegular: true },
      { path: "LICENSES/GPL-3.0-only.txt", isRegular: true },
      { path: "LICENSES/dir", isRegular: false }, // non-regular entries skip
    ]);
    expect(detected).toEqual([
      { spdxId: "MIT", licensePath: "LICENSES/MIT.txt" },
      { spdxId: "GPL-3.0-only", licensePath: "LICENSES/GPL-3.0-only.txt" },
    ]);
  });

  it("without a corpus detector, root license files yield nothing (no invented SPDX ids)", async () => {
    const detected = await resolveDetectedLicenses([
      { path: "LICENSE", isRegular: true, read: () => "MIT text" },
      { path: "COPYING", isRegular: true, read: () => "GPL text" },
      { path: "src/main.go", isRegular: true },
    ]);
    expect(detected).toEqual([]);
  });

  it("an injected detector maps license-file content to SPDX ids (the future corpus hook)", async () => {
    const detected = await resolveDetectedLicenses(
      [
        // Root-level entries carry BARE names (upstream lists the root
        // SubTree — entry.Name() has no directory prefix).
        { path: "LICENSE", isRegular: true, read: () => "permission is hereby granted" },
        { path: "COPYING.md", isRegular: true, read: () => "general public license" },
        { path: "README.md", isRegular: true, read: () => "not a license" },
      ],
      (content) => (content.includes("hereby granted") ? ["MIT"] : content.includes("general public") ? ["GPL-3.0-only"] : []),
    );
    expect(detected).toEqual([
      { spdxId: "MIT", licensePath: "LICENSE" },
      { spdxId: "GPL-3.0-only", licensePath: "COPYING.md" },
    ]);
  });

  it("updateRepoLicenses diffs: inserts new SPDX ids, updates paths, drops rows left behind", async () => {
    const repoId = await createRepo("diffed");
    await insertLicense(repoId, "MIT");
    await updateRepoLicenses(env.DB, repoId, "c2", [
      { spdxId: "MIT", licensePath: "LICENSES/MIT.txt" }, // existing → path/commit update
      { spdxId: "0BSD", licensePath: "LICENSE" }, // new → insert
      // "MIT" row keeps; the missing "Apache-2.0" is deleted below only via a
      // second scan from commit c2 (the license.go delete-by-commit sweep).
    ]);
    let rows = await getRepoLicenses(env.DB, repoId);
    expect(rows.map((r) => [r.license, r.licensePath, r.commitId])).toEqual([
      ["0BSD", "LICENSE", "c2"],
      ["MIT", "LICENSES/MIT.txt", "c2"],
    ]);

    // The c2 → c3 sweep: rows still carrying commit_id c2 are stale.
    await updateRepoLicenses(env.DB, repoId, "c3", [{ spdxId: "MIT", licensePath: "LICENSE" }]);
    rows = await getRepoLicenses(env.DB, repoId);
    expect(rows.map((r) => [r.license, r.licensePath, r.commitId])).toEqual([["MIT", "LICENSE", "c3"]]);
  });

  it("cleanRepoLicenses drops every row (the zero-detection arm)", async () => {
    const repoId = await createRepo("cleaned");
    await insertLicense(repoId, "MIT");
    await cleanRepoLicenses(env.DB, repoId);
    expect(await getRepoLicenses(env.DB, repoId)).toEqual([]);
    expect((await env.DB.prepare("SELECT count(*) AS n FROM repositories").first<{ n: number }>())!.n).toBe(1);
  });
});
