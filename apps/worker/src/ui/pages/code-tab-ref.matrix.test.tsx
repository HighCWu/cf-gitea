/**
 * The Code tab's ref-preserving href (the P2-7 remaining-S piece —
 * repo/header.tmpl:100-101 through shell.tsx's `codeTabHref` + ui/index.ts's
 * resolveUiRequest threading): the MINTED-SESSION-free route arms over a
 * seeded engine repo (the raw-files matrix's pattern — parse →
 * resolveUiRequest → the loader, through the mounted uiRouter with the
 * synthetic manifest). The fixture world carries THREE refs so every
 * threaded shape has a page:
 *
 *   - `main` (the default branch, the seed's push);
 *   - `feature` (a second branch pushed straight through the landed
 *     receive-pack flow — the branch arm's non-default ref);
 *   - `v1` (a lightweight tag via the seeder's tags option — the tag arm,
 *     where upstream's BranchName stays EMPTY on the tag arm of RepoRefByType,
 *     services/context/repo.go:1021-1034, and `ne "" default` preserves the
 *     /src/tag URL).
 *
 * The pinned matrix:
 *   - /src/branch/feature     → Code tab hrefs {repo}/src/branch/feature
 *   - /src/tag/v1             → Code tab hrefs {repo}/src/tag/v1
 *   - /commits/branch/feature → preserved (the commits family threads too)
 *   - /blame/branch/feature/… → preserved (the blame family threads too)
 *   - /src/branch/main        → the PLAIN {repo} href (BranchName == default
 *     — upstream's `ne` gate fails and the tab links the repo root)
 *   - the repo home (/)       → plain (upstream home runs
 *     RepoRefByType(branch) at the default branch — same plain landing)
 *   - /issues, /releases      → plain (no RepoRef middleware upstream —
 *     BranchName "", RefTypeNameSubURL ""; upstream's own template would
 *     emit {RepoLink}/src/ there, whose handler redirects onto {RepoLink}
 *     — web.go:1760-1761 — so the plain href IS the landing, minus the
 *     round-trip)
 */

import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor } from "../../auth/testing/seeds";
import { repositories, users } from "../../db/schema";
import { buildHistoryPack, buildReceivePackBody, ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { uiRouter, type UiAssetsFetcher } from "../index";
import type { UiManifest } from "../manifest";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

async function fetchUi(path: string): Promise<string> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`${ORIGIN}${path}`), routeEnv, context);
  await waitOnExecutionContext(context);
  return response.text();
}

/** The Code tab anchor's href out of a rendered page (the shell emits the
 *  shortcut key on exactly that anchor — the extractor is total). */
function codeTabHref(html: string): string {
  const match = /href="([^"]*)" data-shortcut-keys="g c"/.exec(html);
  if (match === null) throw new Error("no Code tab anchor in the render");
  return match[1] as string;
}

const COMMITS: SeedCommit[] = [
  {
    message: "seed: readme",
    time: 1_700_000_000,
    files: [{ path: "README.md", content: "# refsheet v1\n" }],
  },
];

let seededSlug: string | null = null;

async function ensureFixtures(): Promise<string> {
  if (seededSlug !== null) return seededSlug;
  await applyAuthD1Migrations();
  const seeded = await ensureSeededRepo({
    owner: "alice",
    slug: "refsheet",
    commits: COMMITS,
    tags: [{ name: "v1", commitIndex: 0 }],
  });

  // The feature branch: push the SAME tip onto refs/heads/feature through
  // the landed receive flow (the seeder's token mint convention — a fresh
  // token name, the plaintext never stored).
  const db = drizzle(env.DB);
  const alice = (await db.select().from(users).where(eq(users.usernameLower, "alice")).get()) ?? null;
  if (alice === null) throw new Error("alice row missing");
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(alice.id, "ui-page-seed-refsheet-feature")
    .run();
  const token = (await mintFor(alice.id, "ui-page-seed-refsheet-feature", "write:repository")).plaintext;
  const { tips, pack } = await buildHistoryPack(COMMITS);
  const response = await SELF.fetch(`https://test.local/alice/refsheet.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
    body: buildReceivePackBody([{ ref: "refs/heads/feature", oid: tips[tips.length - 1] as string }], pack),
  });
  const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
  if (response.status !== 200 || responseBody.includes("ng ")) {
    throw new Error(`feature push failed: ${response.status} ${responseBody.slice(0, 400)}`);
  }

  // The row must be ready + public (the seeder settles it; assert anyway —
  // the §2.5 gate hides anything else and every arm here is anonymous).
  const row =
    (await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "refsheet")))
      .get()) ?? null;
  if (row === null || row.status !== "ready" || row.visibility !== "public") {
    throw new Error("refsheet row not ready/public after seeding");
  }
  void seeded;
  seededSlug = "refsheet";
  return seededSlug;
}

beforeAll(async () => {
  await ensureFixtures();
});

// --- the matrix ----------------------------------------------------------------

describe("the Code tab's ref-preserving href (header.tmpl:100-101 through the resolveUiRequest threading)", () => {
  it("a non-default BRANCH view preserves its ref: /src/branch/feature links /src/branch/feature", async () => {
    const html = await fetchUi("/alice/refsheet/src/branch/feature");
    expect(codeTabHref(html)).toBe("/alice/refsheet/src/branch/feature");
  });

  it("a TAG view preserves its ref with an empty BranchName: /src/tag/v1 links /src/tag/v1", async () => {
    // Upstream sets BranchName only on the branch arm (repo.go:1016); the
    // tag arm leaves it "", `ne "" default` holds, and RefTypeNameSubURL is
    // tag/v1 — the tab keeps the tag URL.
    const html = await fetchUi("/alice/refsheet/src/tag/v1");
    expect(codeTabHref(html)).toBe("/alice/refsheet/src/tag/v1");
  });

  it("the commits family preserves the ref: /commits/branch/feature links /src/branch/feature", async () => {
    const html = await fetchUi("/alice/refsheet/commits/branch/feature");
    expect(codeTabHref(html)).toBe("/alice/refsheet/src/branch/feature");
  });

  it("the blame family preserves the ref: /blame/branch/feature/README.md links /src/branch/feature", async () => {
    const html = await fetchUi("/alice/refsheet/blame/branch/feature/README.md");
    expect(codeTabHref(html)).toBe("/alice/refsheet/src/branch/feature");
  });

  it("the DEFAULT branch folds to the plain repo link: /src/branch/main links the repo root", async () => {
    // BranchName == DefaultBranch → upstream's `ne` gate fails → no /src
    // suffix (the pre-threading href, unchanged).
    const html = await fetchUi("/alice/refsheet/src/branch/main");
    expect(codeTabHref(html)).toBe("/alice/refsheet");
  });

  it("pages without a ref context keep the plain repo link (home, issues, releases)", async () => {
    const home = await fetchUi("/alice/refsheet");
    expect(codeTabHref(home)).toBe("/alice/refsheet");
    const issues = await fetchUi("/alice/refsheet/issues");
    expect(codeTabHref(issues)).toBe("/alice/refsheet");
    const releases = await fetchUi("/alice/refsheet/releases");
    expect(codeTabHref(releases)).toBe("/alice/refsheet");
  });
});
