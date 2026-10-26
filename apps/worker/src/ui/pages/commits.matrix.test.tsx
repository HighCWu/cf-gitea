/**
 * The commits page's deferred matrix (the module MOUNTED since the early
 * waves — GET /{owner}/{repo}/commits[/{ref-suffix}] at ui/index.ts:8972,
 * pages/commits.tsx, the §3.3 commit-log family): the route-level arms the
 * early block (pages.test.ts "commits page") left open, driven through the
 * REAL routes on the user-profile matrix's minted-session pattern —
 *
 *   - the §2.5 route gates: the anonymous and signed-in-stranger 404 shells
 *     on a PRIVATE repo (existence hidden, no repo context in the shell,
 *     identical for the ref-suffixed tails — the gate runs before any ref
 *     work), the owner's and the site admin's 200 render, and the unborn
 *     repo's 404 (the loader's no-branches arm, never a crash),
 *   - the ref-resolution arms beyond pages.test's branch/main-ok +
 *     commit/HEAD-404 pair: the tag tail, the full-sha tail, the
 *     slash-bearing branch, the SHORTEST-cumulative-prefix walk (upstream
 *     getRefNameFromPath: with `feat` AND `feat/one` existing,
 *     `/commits/branch/feat/one` resolves ref `feat` + treePath `one`),
 *     the bare `commits/branch` suffix (rest "" → the default branch) and
 *     `branch/HEAD` (the default-branch swap), the remaining bad-ref
 *     404s (tag/nope, the prefix-less tail, a non-hex commit tail),
 *   - the unresolvable-sha family (`commit/{hex}` naming no object, full
 *     or short prefix): upstream answers 404 (RepoRefByType's GetCommit
 *     miss → ctx.NotFound, services/context/repo.go:1037-1040) and the
 *     sibling commit-view page pins the same 404 for identical shas
 *     (pages-wave18 "unresolvable-hex and short-prefix shas"). AT THIS PIN
 *     THE COMMITS PAGE FAILS THAT PIN — the engine's listLog answers an
 *     unresolvable ref with an EMPTY log, never null, so loadCommitsData's
 *     `log === null` notFound guard cannot fire and the page renders 200
 *     with a zero-row table. The two its pinning the 404 are LEFT RED
 *     deliberately: they are the escalation artifact (tests-only wave —
 *     no production edits; see the report to the orchestrator).
 *   - the pager + ?path shape on the SUFFIXED basePaths pages.test's bare
 *     URL block doesn't cover: the head-branch canonical collapse (the
 *     /commits/branch/main URL pages onto the bare /commits), the non-head
 *     branch's own base, the Newer link's page-param drop with the path
 *     kept, the path-then-page param order, the non-numeric ?page clamp,
 *     and the treePath-beats-?path precedence (the file-history tail wins
 *     over the query param),
 *   - and the commits family's claim pin (parse ↔ registration: the bare
 *     refSuffix-null tuple, any-depth decoded tails, the commitsy miss,
 *     and a junk deep tail 404-shelling through the loader, not the
 *     engine).
 *
 * Fixture posture: a disjoint `cm*` family (the wave suites own alice/*),
 * seeded once in beforeAll via ensureSeededRepo (real pushed packs), extra
 * refs (slash branches, tag, same-tip dev branch) pushed through the same
 * receive flow with the deterministic pack, sessions minted PER REQUEST
 * (the value is never asserted).
 */

import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { repositories, users } from "../../db/schema";
import { buildHistoryPack, buildReceivePackBody, ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { UiManifest } from "../manifest";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";
const T0 = 1_700_000_000; // 2023-11-14T22:13:20Z — fixed, deterministic rendering

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

/** The real production path: parse → resolveUiSession → resolveUiRequest →
 *  loadCommitsData → render, on the mounted uiRouter with the synthetic
 *  manifest; the execution context is awaited so waitUntil side-effects
 *  settle before assertions. */
async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`${ORIGIN}${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** Anonymous GET (cookie omitted) or a minted-session GET. */
async function get(path: string, as?: string): Promise<Response> {
  if (as === undefined) return fetchUi(path);
  const user = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, as)).get();
  if (user === undefined) throw new Error(`fixture user missing: ${as}`);
  return fetchUi(path, { headers: { cookie: `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, user.id)}` } });
}

/** Body-row count: every commits-table `<tr>` minus the thead's header row. */
function bodyRows(html: string): number {
  return (html.match(/<tr>/g) ?? []).length - 1;
}

/** The three-commit history the ref arms resolve against: every commit
 *  touches README.md (so a README treePath filter keeps all three),
 *  app.ts only the second, docs/guide.md only the third. */
const LOG_COMMITS: SeedCommit[] = [
  { message: "log root readme", time: T0, files: [{ path: "README.md", content: "# log\n" }] },
  {
    message: "log second app",
    time: T0 + 60,
    files: [
      { path: "README.md", content: "# log v2\n" },
      { path: "app.ts", content: "export const one = 1;\n" },
    ],
  },
  {
    message: "log third guide",
    time: T0 + 120,
    files: [
      { path: "README.md", content: "# log v3\n" },
      { path: "docs/guide.md", content: "# guide\n" },
    ],
  },
];

const BULK_COMMITS: SeedCommit[] = Array.from({ length: 51 }, (_unused, i) => ({
  message: `bulk number ${i + 1}`,
  time: T0 + i * 60,
  files: [{ path: "counter.txt", content: `line ${i + 1}\n` }],
}));

let logTips: string[] = [];

/**
 * Seed the disjoint `cm*` family (idempotent on the `cmgal` sentinel).
 * Relations: cmgal owns log/bulk/hidden (log + bulk public, hidden flipped
 * private), cmpal is a signed-in stranger, cmroot a site admin. log carries
 * the extra refs the ref arms walk — branches `feat` (tips[0]) and
 * `feat/one` (tips[1]), the shortest-prefix-walk pair, plus `devbox/next`
 * (tips[1], no `devbox` sibling: the resolved slash branch) and tag `v1`
 * (tips[1]); bulk carries `dev` at main's tip (the non-head pager).
 */
async function ensureFixtures(): Promise<void> {
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);

  const existingOwner = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "cmgal")).get();
  if (existingOwner !== undefined) {
    logTips = (await buildHistoryPack(LOG_COMMITS)).tips;
    return;
  }

  for (const [name, isAdmin] of [
    ["cmpal", false],
    ["cmroot", true],
  ] as const) {
    await seedVerifiedUser({ username: name, isAdmin });
  }
  await seedVerifiedUser({ username: "cmgal" });

  const log = await ensureSeededRepo({ owner: "cmgal", slug: "log", commits: LOG_COMMITS });
  logTips = log.tips;
  const bulk = await ensureSeededRepo({ owner: "cmgal", slug: "bulk", commits: BULK_COMMITS });
  await ensureSeededRepo({ owner: "cmgal", slug: "hidden", commits: LOG_COMMITS });
  await db
    .update(repositories)
    .set({ visibility: "private" })
    .where(and(eq(repositories.ownerNamespace, "cmgal"), eq(repositories.slug, "hidden")));

  // The extra refs, through the same receive flow (the deterministic pack
  // re-ships its objects — content-addressed storage is idempotent). Only
  // the missing refs go out so re-entry is a no-op.
  const owner = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "cmgal")).get();
  if (owner === undefined) throw new Error("fixture owner missing");
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(owner.id, "cmatrix-extra-refs")
    .run();
  const token = (await mintFor(owner.id, "cmatrix-extra-refs", "write:repository")).plaintext;
  const receiveHeaders = {
    authorization: basicTokenHeader(token),
    "content-type": "application/x-git-receive-pack-request",
  };
  const extraRefs = [
    {
      engineRepo: "cmgal/log",
      commits: LOG_COMMITS,
      updates: [
        { ref: "refs/heads/feat", oid: logTips[0] as string },
        { ref: "refs/heads/feat/one", oid: logTips[1] as string },
        { ref: "refs/heads/devbox/next", oid: logTips[1] as string },
        { ref: "refs/tags/v1", oid: logTips[1] as string },
      ],
    },
    {
      engineRepo: "cmgal/bulk",
      commits: BULK_COMMITS,
      updates: [{ ref: "refs/heads/dev", oid: bulk.tips[50] as string }],
    },
  ];
  for (const { engineRepo, commits, updates } of extraRefs) {
    const refs = await env.REPO.getByName(engineRepo).listRefs();
    const names = new Set(refs.refs.map((r) => r.name));
    const missing = updates.filter((u) => !names.has(u.ref));
    if (missing.length === 0) continue;
    const { pack } = await buildHistoryPack(commits);
    const response = await SELF.fetch(`https://test.local/${engineRepo}.git/git-receive-pack`, {
      method: "POST",
      headers: receiveHeaders,
      body: buildReceivePackBody(missing, pack),
    });
    const body = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
    if (response.status !== 200 || body.includes("ng ")) {
      throw new Error(`extra-ref push failed: ${engineRepo} ${response.status} ${body.slice(0, 400)}`);
    }
  }
}

/** A repo row with no engine content (never pushed): the loader's
 *  unborn/no-branches arm. */
async function seedVoidRepo(): Promise<void> {
  const db = drizzle(env.DB);
  const existing = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "cmgal"), eq(repositories.slug, "void")))
    .get();
  if (existing !== undefined) return;
  const owner = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "cmgal")).get();
  if (owner === undefined) throw new Error("fixture owner missing");
  await db.insert(repositories).values({
    id: crypto.randomUUID(),
    storageKey: `r_${crypto.randomUUID()}`,
    ownerNamespace: "cmgal",
    ownerId: owner.id,
    slug: "void",
    visibility: "public",
  });
}

beforeAll(async () => {
  await ensureFixtures();
  await seedVoidRepo();
});

// --- the §2.5 route gates ------------------------------------------------------

describe("the commits route gates (anon/private/owner/admin)", () => {
  it("an anonymous viewer 404-shells a private repo's log; the shell carries no repo context", async () => {
    for (const path of ["/cmgal/hidden/commits", "/cmgal/hidden/commits/branch/main", "/cmgal/hidden/commits?page=2"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404); // the gate runs before any ref/page work
      const html = await res.text();
      expect(html, path).toContain("status-page-error");
      expect(html, path).not.toContain("repo-header"); // existence hidden, no context leak
      expect(html, path).not.toContain("commits-table");
    }
  });

  it("a signed-in stranger gets the identical 404 (no grant line admits him)", async () => {
    const res = await get("/cmgal/hidden/commits", "cmpal");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("status-page-error");
    expect(html).not.toContain("commits-table");
  });

  it("the owner and a site admin render the private log (the readGrant's isOwner/isSiteAdmin arms)", async () => {
    for (const viewer of ["cmgal", "cmroot"]) {
      const res = await get("/cmgal/hidden/commits", viewer);
      expect(res.status, viewer).toBe(200);
      const html = await res.text();
      expect(html, viewer).toContain('id="commits-table"');
      expect(bodyRows(html), viewer).toBe(3);
    }
  });

  it("the public repo's log stays anonymous-readable (the gate's row-1 collapse control)", async () => {
    const res = await get("/cmgal/log/commits");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="commits-table"');
  });

  it("an unborn repo (no engine content) 404-shells — the loader's no-branches arm", async () => {
    const res = await get("/cmgal/void/commits");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("status-page-error");
    expect(html).not.toContain("commits-table");
  });
});

// --- the ref-resolution arms -----------------------------------------------------

describe("the ref-suffix resolution arms", () => {
  it("a tag tail renders the tagged history with the selector's active item on the tag", async () => {
    const res = await get("/cmgal/log/commits/tag/v1");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="commits-table"');
    expect(bodyRows(html)).toBe(2); // v1 = tips[1]: the second + the root
    expect(html.indexOf("log second app")).toBeLessThan(html.indexOf("log root readme")); // newest first
    expect(html).toContain('<a class="active item" href="/cmgal/log/commits/tag/v1">v1</a>');
    expect(html).toContain('<a class="item" href="/cmgal/log/commits/branch/main">main</a>'); // the switch items stay in-family
  });

  it("a full-sha tail renders that point's history with the sha as the selector's label", async () => {
    const sha = logTips[1] as string;
    const res = await get(`/cmgal/log/commits/commit/${sha}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(bodyRows(html)).toBe(2);
    // The dropdown's label is the sha; the menu holds only branch/tag items,
    // so NO item is active for a commit-typed ref (BranchSelector's isActive
    // can never match) — the sha appears only in the label span.
    expect(html).toContain(`<span class="text">${sha}</span>`);
    expect(html).toContain('<a class="item" href="/cmgal/log/commits/branch/main">main</a>');
    expect(html).not.toContain(`<a class="active item" href="/cmgal/log/commits/commit/${sha}">`);
  });

  it("a slash-bearing branch resolves as one ref (no shorter prefix exists)", async () => {
    const res = await get("/cmgal/log/commits/branch/devbox/next");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(bodyRows(html)).toBe(2); // devbox/next = tips[1]
    expect(html).toContain('<a class="active item" href="/cmgal/log/commits/branch/devbox/next">devbox/next</a>');
  });

  it("the shortest cumulative prefix wins the walk (upstream getRefNameFromPath): feat beats feat/one", async () => {
    const res = await get("/cmgal/log/commits/branch/feat/one");
    expect(res.status).toBe(200);
    const html = await res.text();
    // `feat` exists, so the URL resolves ref `feat` + treePath `one` — the
    // treePath acts as the path filter and names no file: zero rows, not a
    // 404 (upstream's RefCommits renders the empty filtered log).
    expect(bodyRows(html)).toBe(0);
    expect(html).toContain('<span class="text">feat</span>');
    // The resolved ref is `feat`, but every selector item carries the
    // treePath — the active item's href re-emits the original URL shape.
    expect(html).toContain('<a class="active item" href="/cmgal/log/commits/branch/feat/one">feat</a>');
    expect(html).toContain('<a class="item" href="/cmgal/log/commits/branch/main/one">main</a>');
  });

  it("the treePath tail filters the file history (the /src History link's target shape)", async () => {
    const res = await get("/cmgal/log/commits/branch/devbox/next/app.ts");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(bodyRows(html)).toBe(1); // only the second commit touches app.ts
    expect(html).toContain("log second app");
    expect(html).not.toContain("log root readme");
  });

  it("the bare commits/branch suffix (empty rest) resolves the default branch", async () => {
    const res = await get("/cmgal/log/commits/branch");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(bodyRows(html)).toBe(3);
    expect(html).toContain('<a class="active item" href="/cmgal/log/commits/branch/main">main</a>');
  });

  it("branch/HEAD swaps in the default branch (upstream repo.go:875-881)", async () => {
    const res = await get("/cmgal/log/commits/branch/HEAD");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(bodyRows(html)).toBe(3);
    expect(html).toContain('<span class="text">main</span>'); // HEAD resolved to main
    expect(html).not.toContain('<span class="text">HEAD</span>');
  });

  it("404-shells the remaining bad refs: an unknown tag, the prefix-less tail, a non-hex commit tail", async () => {
    for (const path of ["/cmgal/log/commits/tag/nope", "/cmgal/log/commits/main", "/cmgal/log/commits/commit/nothexatall"]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toContain("status-page-error");
    }
  });

  it("RED (bug): a full hex sha naming no object must 404-shell like the commit view — today it renders 200 empty", async () => {
    // Upstream: RepoRefByType's commit branch GetCommit miss → ctx.NotFound
    // (services/context/repo.go:1037-1040). The sibling commit view pins the
    // identical 404 for "0".repeat(40) (pages-wave18 "unresolvable-hex …
    // shas"). Here the engine's listLog answers the unresolvable ref with an
    // EMPTY log — never null — so loadCommitsData's `log === null` notFound
    // guard cannot fire and the page renders a zero-row table at 200.
    for (const sha of ["0".repeat(40), "f".repeat(40)]) {
      const res = await get(`/cmgal/log/commits/commit/${sha}`);
      expect(res.status, sha).toBe(404);
      expect(await res.text(), sha).toContain("status-page-error");
    }
  });

  it("RED (bug): a short-prefix sha must not render an empty log either (wave-18's convention)", async () => {
    // Upstream RESOLVES short shas (GetCommit + the canonical-link header);
    // this repo's engine has no short expansion anywhere, and the commit view
    // pins the 404 for the short prefix (pages-wave18). Either way, a
    // zero-row 200 is neither answer — the commits page must behave like its
    // sibling: 404.
    const res = await get(`/cmgal/log/commits/commit/${(logTips[1] as string).slice(0, 7)}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
  });
});

// --- the pager + ?path shape on the suffixed basePaths ----------------------------

describe("the pager and ?path shape (the suffixed arms beyond pages.test's bare URLs)", () => {
  it("the head branch's suffixed URL pages onto the BARE canonical path (the active==head collapse)", async () => {
    const res = await get("/cmgal/bulk/commits/branch/main");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(bodyRows(html)).toBe(50);
    expect(html).toContain('<a class="item navigation" href="/cmgal/bulk/commits?page=2">'); // not /commits/branch/main?page=2
    expect(html).not.toContain("/commits/branch/main?");
  });

  it("a non-head branch keeps its own suffixed base on both links", async () => {
    const first = await get("/cmgal/bulk/commits/branch/dev");
    expect(first.status).toBe(200);
    const firstHtml = await first.text();
    expect(bodyRows(firstHtml)).toBe(50); // dev sits at main's tip: the same 51-commit log
    expect(firstHtml).toContain('<a class="item navigation" href="/cmgal/bulk/commits/branch/dev?page=2">');

    const second = await get("/cmgal/bulk/commits/branch/dev?page=2");
    expect(second.status).toBe(200);
    const secondHtml = await second.text();
    expect(bodyRows(secondHtml)).toBe(1);
    expect(secondHtml).not.toContain("Older"); // more === false hides Older (§4.11)
    expect(secondHtml).toContain('<a class="item navigation" href="/cmgal/bulk/commits/branch/dev">'); // Newer drops the page param
  });

  it("the ?path filter rides both links on the suffixed base, path before page", async () => {
    const first = await get("/cmgal/bulk/commits/branch/dev?path=counter.txt");
    expect(first.status).toBe(200);
    const firstHtml = await first.text();
    expect(firstHtml).toContain(
      '<a class="item navigation" href="/cmgal/bulk/commits/branch/dev?path=counter.txt&amp;page=2">',
    );

    const second = await get("/cmgal/bulk/commits/branch/dev?path=counter.txt&page=2");
    expect(second.status).toBe(200);
    const secondHtml = await second.text();
    expect(secondHtml).toContain('<a class="item navigation" href="/cmgal/bulk/commits/branch/dev?path=counter.txt">');
    expect(secondHtml).not.toContain("path=counter.txt&amp;path=counter.txt"); // no param accumulation
  });

  it("a non-numeric ?page clamps to 1 (parsePageNumber's digit gate)", async () => {
    const res = await get("/cmgal/bulk/commits?page=frog");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(bodyRows(html)).toBe(50);
    expect(html).toContain("?page=2"); // clamped page 1 still offers Older
  });

  it("the treePath tail beats the ?path query (the file-history filter wins)", async () => {
    const res = await get("/cmgal/log/commits/branch/main/README.md?path=app.ts");
    expect(res.status).toBe(200);
    const html = await res.text();
    // README history = all three commits; the ?path=app.ts filter alone
    // would have kept only the second.
    expect(bodyRows(html)).toBe(3);
  });

  it("a bare-URL ?path subdirectory filter keeps only that subtree's commits", async () => {
    const res = await get("/cmgal/log/commits?path=docs/guide.md");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(bodyRows(html)).toBe(1);
    expect(html).toContain("log third guide");
  });
});

// --- the claim pin (the commits family's parse ↔ registration) --------------------

describe("the commits family's claim pin", () => {
  it("claims the bare URL with a null refSuffix and any-depth tails decoded per segment", () => {
    expect(parseUiRoute("/cmgal/log/commits")).toEqual({ family: "commits", owner: "cmgal", repo: "log", refSuffix: null });
    expect(parseUiRoute("/cmgal/log/commits/branch/main/app.ts")).toEqual({
      family: "commits",
      owner: "cmgal",
      repo: "log",
      refSuffix: "branch/main/app.ts",
    });
    expect(parseUiRoute("/cmgal/log/commits/branch/fe%61ture/one")).toEqual({
      family: "commits",
      owner: "cmgal",
      repo: "log",
      refSuffix: "branch/feature/one", // decoded per segment, separators kept
    });
    expect(handlesUiRoute("/cmgal/log/commits")).toBe(true);
    expect(handlesUiRoute("/cmgal/log/commits/branch/main")).toBe(true);
  });

  it("never claims the near-miss literal, and a junk deep tail 404-shells through the loader (not the engine)", async () => {
    expect(parseUiRoute("/cmgal/log/commitsy")).toBeNull();
    expect(handlesUiRoute("/cmgal/log/commitsy/branch/main")).toBe(false);

    // Claimed (any depth), but the suffix carries no ref-type prefix → the
    // loader's notFound shell answers, byte-identical to the bad-ref arms.
    const res = await get("/cmgal/log/commits/x/y/z");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("status-page-error");
  });
});
