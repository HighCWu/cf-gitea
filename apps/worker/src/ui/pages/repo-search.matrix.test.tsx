/**
 * The in-repo code search page's matrix (pages/repo-search.tsx mounted
 * through uiRouter — the census R10 page, web.go:1768 → repo.Search,
 * routers/web/repo/search.go:22-68, over the SPEC-0015 M1 grep RPC). The
 * page module's doc carries the upstream citations; THIS file arms the
 * mission's matrix:
 *
 *   - the THREE MODES' rendering over one fixture repo: exact's
 *     case-sensitivity (FIXME vs fixme), words' case-insensitive all-words
 *     AND ("release notes" matching both casings), regexp (v\d+\.\d+), with
 *     the displayed-vs-executed default quirk pinned (no search_mode in the
 *     URL displays the first option, executes words — gitgrep.go:28 +
 *     combo.tmpl's first-item display);
 *   - the path filter (?path= passthrough to the RPC's path arm — no form
 *     field, upstream-verbatim);
 *   - the empty/refused arms: the bare form (q empty → 200, NO engine call,
 *     search.go:25-28), the unresolvable default branch 404 (upstream
 *     ServerErrors the unborn branch — the documented reduction), the
 *     regexp-compile refusal 404, the private-repo 404 shell (the
 *     reqUnitCodeReader gate reduces to the visibility read), and the
 *     empty-repo keyword search 404 (the same unborn arm);
 *   - the truncation notice (52 matching files → 50 cards + "showing the
 *     first 50 of 52" — the SPEC-ledgered honesty divergence over
 *     grep.go:77's silent cap) and the gitgrep.go:50-53 page slice over the
 *     capped blocks with base/paginate's shape;
 *   - the gate posture (public 200 anonymous / private 404 / empty repo's
 *     bare-form 200 vs keyword 404) and the highlight markup pins
 *     (results.tmpl/searchfile.tmpl's classes, the #L{n} permalink anchors,
 *     the escaped line bytes).
 *
 * Harness posture: the repo-activity.matrix minted-session pattern (per-test
 * D1 wipe + idempotent re-seed, REAL pushed content through the receive
 * flow). One fixture repo keeps the matrix off any other suite's rows:
 * `srch-owner/srch` (one commit: the mode-discriminating files, a binary
 * skip, an HTML-escape file, 22 pageword files, 52 capword files).
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { repositories } from "../../db/schema";
import { RepoService } from "../../repos/service";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { runA11y } from "../__tests__/a11y";
import type { RepoRow } from "../ui-context";

// The engine-seeding hook pushes one real pack through the receive flow
// (the matrix suites' measured set — the smoke test's file-local budgets).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// --- the minted-session route harness (the repo-activity.matrix pattern) ---------

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

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

// --- fixtures -------------------------------------------------------------------

const TIP_TIME = 1_700_000_000; // fixed seconds — deterministic oids

/** One commit whose files discriminate every arm:
 *  - exact vs words: "FIXME" (upper) in app.ts vs "fixme" (lower) in notes.md;
 *  - the words AND: "Release Notes" (notes.md) / "release notes" (guide.md);
 *  - regexp: "v1.0" in notes.md;
 *  - the path filter: the docs/ prefix;
 *  - the binary skip (logo.png) and the HTML-escape line (escape.md);
 *  - pagination: 22 pageword files (pageCount 2);
 *  - truncation: 52 capword files (50-card cap + the honesty notice). */
const SRCH_COMMITS: SeedCommit[] = [
  {
    message: "srch: fixture born",
    time: TIP_TIME,
    files: [
      { path: "notes.md", content: "Release Notes for v1.0\nfixme: nothing here\n" },
      { path: "src/app.ts", content: "export function mainHandler() {}\n// FIXME: wire the router\n" },
      { path: "src/util.ts", content: "export function utilHandler() {}\n" },
      { path: "docs/guide.md", content: "The alpha beta guide\nrelease notes live elsewhere\n" },
      // the binary-skip arm (the engine's isBinary sniff)
      { path: "logo.png", content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x0d]) },
      // the HTML-escape pin (raw < > & bytes in the matched line)
      { path: "escape.md", content: 'write "quotes" & <b> tags\nquotes are here\n' },
      // the pagination arm: 22 result blocks over the 20-per-page slice
      ...Array.from({ length: 22 }, (_v, i) => ({
        path: `page/f-${String(i).padStart(2, "0")}.txt`,
        content: "pageword\n",
      })),
      // the truncation arm: 52 result blocks over the engine's 50 cap
      ...Array.from({ length: 52 }, (_v, i) => ({
        path: `many/m-${String(i).padStart(2, "0")}.txt`,
        content: "capword\n",
      })),
    ],
  },
];

async function seedSrchRepo(): Promise<{ tip: string }> {
  await seedVerifiedUser({ username: "srch-owner" });
  const seeded = await ensureSeededRepo({ owner: "srch-owner", slug: "srch", commits: SRCH_COMMITS });
  return { tip: seeded.tips[seeded.tips.length - 1] as string };
}

/** The never-pushed empty twin (the RepoService arm): `isEmpty` false with no
 *  refs — the unborn-default-branch arm's cheapest shape. */
async function seedSrchUnborn(): Promise<RepoRow> {
  const owner = await seedVerifiedUser({ username: "srch-unborn-owner" });
  const created = await new RepoService(env.DB).create({
    owner: { id: owner.id, usernameLower: "srch-unborn-owner" },
    name: "unborn",
    isPrivate: false,
    status: "ready",
  });
  const db = drizzle(env.DB);
  await db.update(repositories).set({ visibility: "public", isEmpty: false }).where(eq(repositories.id, created.id));
  const row = await db.select().from(repositories).where(eq(repositories.id, created.id)).get();
  if (row === undefined) throw new Error("srch-unborn repo row missing");
  return row;
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  // FK order (the repo-activity.matrix wipe).
  for (const table of [
    "release_assets",
    "releases",
    "webhook_deliveries",
    "webhooks",
    "repo_collaborators",
    "repo_settings",
    "issue_labels",
    "issue_pins",
    "comments",
    "pull_requests",
    "issues",
    "labels",
    "milestones",
    "repo_counters",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the claim pins -------------------------------------------------------------

describe("repo-search claim pins (parseUiRoute / handlesUiRoute)", () => {
  it("claims the bare literal only (the query arms ride the URL)", () => {
    expect(parseUiRoute("/octo/hello/search")).toEqual({ family: "repo-search", owner: "octo", repo: "hello" });
    expect(parseUiRoute("/octo/hello/search/")).toEqual({ family: "repo-search", owner: "octo", repo: "hello" });
    expect(handlesUiRoute("/octo/hello/search")).toBe(true);
  });

  it("leaves the deeper tails with the engine (upstream's unregistered-route 404)", () => {
    expect(parseUiRoute("/octo/hello/search/deep")).toBeNull();
    expect(parseUiRoute("/octo/hello/search/deeper/tail")).toBeNull();
    expect(handlesUiRoute("/octo/hello/search/deep")).toBe(false);
  });
});

// --- the three modes ------------------------------------------------------------

describe("the three search modes' rendering (gitgrep.go:28-35's switch)", () => {
  it("exact mode is case-SENSITIVE: FIXME matches app.ts only", async () => {
    const { tip } = await seedSrchRepo();
    const res = await fetchUi("/srch-owner/srch/search?q=FIXME&search_mode=exact");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("src/app.ts");
    expect(html).toContain("// FIXME: wire the router");
    // the lowercase twin file never surfaces
    expect(html).not.toContain("notes.md");
    // the card + line markup pins (results.tmpl/searchfile.tmpl shapes)
    expect(html).toContain('class="diff-file-box file-content non-diff-file-content repo-search-result"');
    expect(html).toContain('<span class="file tw-flex-1">src/app.ts</span>');
    expect(html).toContain(
      `href="/srch-owner/srch/src/commit/${tip}/src/app.ts">View File</a>`,
    );
    expect(html).toContain(`href="/srch-owner/srch/src/commit/${tip}/src/app.ts#L2"`);
    expect(html).toContain('<td class="lines-code chroma"><code class="code-inner">// FIXME: wire the router</code></td>');
    // searchfile.tmpl's cells carry no rel= anchor attribute (that shape is
    // the blame page's)
    expect(html).not.toContain('rel="L2"');
    // one card, one page — no pager
    expect(html.split("repo-search-result").length - 1).toBe(1);
    expect(html).not.toContain("ui borderless pagination menu");
  });

  it("words mode is the case-insensitive AND: 'release notes' matches both casings", async () => {
    await seedSrchRepo();
    const res = await fetchUi("/srch-owner/srch/search?q=release+notes&search_mode=words");
    expect(res.status).toBe(200);
    const html = await res.text();
    // notes.md's "Release Notes" (cased) AND guide.md's "release notes"
    expect(html).toContain("notes.md");
    expect(html).toContain("docs/guide.md");
    expect(html).toContain("Release Notes for v1.0");
    expect(html).toContain("release notes live elsewhere");
    // app.ts/util.ts carry neither word
    expect(html).not.toContain("src/app.ts");
  });

  it("the SAME query under exact mode keeps the case-sensitivity split", async () => {
    await seedSrchRepo();
    const res = await fetchUi("/srch-owner/srch/search?q=release+notes&search_mode=exact");
    expect(res.status).toBe(200);
    const html = await res.text();
    // exact 'release notes' (all-lower) matches guide.md ONLY — notes.md's
    // cased "Release Notes" is out
    expect(html).toContain("docs/guide.md");
    expect(html).not.toContain(">notes.md</span>");
  });

  it("words mode requires EVERY word (the --and semantics)", async () => {
    await seedSrchRepo();
    const res = await fetchUi("/srch-owner/srch/search?q=alpha+beta&search_mode=words");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("docs/guide.md");
    expect(html).toContain("The alpha beta guide");
    expect(html).not.toContain("notes.md");
  });

  it("regexp mode runs the pattern (v\\d+\\.\\d+ finds notes.md)", async () => {
    await seedSrchRepo();
    const res = await fetchUi("/srch-owner/srch/search?q=v%5Cd%2B%5C.%5Cd%2B&search_mode=regexp");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("notes.md");
    expect(html).toContain("Release Notes for v1.0");
    expect(html).not.toContain("docs/guide.md");
  });

  it("an absent/unknown search_mode EXECUTES words (gitgrep.go:28's fall-through)", async () => {
    await seedSrchRepo();
    // No search_mode: words executes — 'release notes' matches BOTH casings,
    // which case-sensitive exact could never do.
    const bare = await fetchUi("/srch-owner/srch/search?q=release+notes");
    expect(bare.status).toBe(200);
    const bareHtml = await bare.text();
    expect(bareHtml).toContain("notes.md");
    expect(bareHtml).toContain("docs/guide.md");
    // A garbage mode: same fall-through.
    const bogus = await fetchUi("/srch-owner/srch/search?q=release+notes&search_mode=fuzzy");
    expect(bogus.status).toBe(200);
    expect((await bogus.text())).toContain("docs/guide.md");
  });

  it("the displayed default mirrors combo.tmpl's quirk: no known mode → exact displays", async () => {
    await seedSrchRepo();
    const html = await (await fetchUi("/srch-owner/srch/search?q=FIXME")).text();
    // The select echoes no option — the first option (exact) displays,
    // exactly upstream's `{{$selected := index .SearchModes 0}}`.
    expect(html).not.toContain("selected=");
    expect(html.indexOf('<option value="exact"')).toBeGreaterThan(-1);
    expect(html.indexOf('<option value="exact"')).toBeLessThan(html.indexOf('<option value="words"'));
    expect(html.indexOf('<option value="words"')).toBeLessThan(html.indexOf('<option value="regexp"'));
    // A known mode echoes selected (the file-editor boolean-attr shape; the
    // option carries its tooltip title like every MODE_META arm).
    const words = await (await fetchUi("/srch-owner/srch/search?q=FIXME&search_mode=words")).text();
    expect(words).toContain('<option value="words" selected="" title=');
    expect(words).not.toContain('<option value="exact" selected="">');
  });
});

// --- the path filter + the skip/escape arms ---------------------------------------

describe("the path filter and the scan-skip arms", () => {
  it("?path= narrows the scan to the prefix (the SPEC §3.1 pathspec passthrough)", async () => {
    await seedSrchRepo();
    const res = await fetchUi("/srch-owner/srch/search?q=release+notes&search_mode=words&path=docs%2F");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("docs/guide.md");
    expect(html).not.toContain(">notes.md</span>");
    // the path echoes into the pager hrefs when one renders (none here —
    // single block) but never renders as a form field
    expect(html).not.toContain('name="path"');
  });

  it("binary blobs never surface and special bytes render ESCAPED", async () => {
    await seedSrchRepo();
    // the png's bytes contain no matchable text — and quotes/'<' pin escaping
    const res = await fetchUi("/srch-owner/srch/search?q=quotes&search_mode=exact");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("escape.md");
    // the raw line's <, >, & render entity-escaped inside code-inner
    expect(html).toContain('<code class="code-inner">write &quot;quotes&quot; &amp; &lt;b&gt; tags</code>');
    expect(html).not.toContain('<code class="code-inner">write "quotes"');
    expect(html).not.toContain(">logo.png");
  });
});

// --- the empty/refused arms + the gate posture ------------------------------------

describe("the empty/refused arms (search.go's arms + the visibility gate)", () => {
  it("the bare form renders 200 WITHOUT an engine call (search.go:25-28)", async () => {
    const { tip } = await seedSrchRepo();
    const res = await fetchUi("/srch-owner/srch/search");
    expect(res.status).toBe(200);
    const html = await res.text();
    // the form + the empty placeholder, no results area
    expect(html).toContain('class="page-content repository file list"');
    expect(html).toContain('placeholder="Search code…"');
    expect(html).toContain('name="q"');
    expect(html).not.toContain(`src/commit/${tip}`);
    expect(html).toContain("Start a code search.");
    expect(html).toContain("Enter a keyword to search across the code.");
    // the always-on gitgrep notice renders on the bare arm too (the quotes
    // render entity-escaped in text content)
    expect(html).toContain("provided by &quot;git grep&quot;");
    expect(html).not.toContain("No matching results found.");
    // and the tip oid proves nothing was searched — the SAME page renders
    // for an unborn repo (the bare arm never resolves the ref; the twin is
    // seeded HERE because the suite's beforeEach wipes D1 between tests)
    await seedSrchUnborn();
    const empty = await fetchUi("/srch-unborn-owner/unborn/search");
    expect(empty.status).toBe(200);
    expect((await empty.text())).toContain("Start a code search.");
  });

  it("a keyword search on an unresolvable default branch 404-shells", async () => {
    await seedSrchUnborn();
    const res = await fetchUi("/srch-unborn-owner/unborn/search?q=anything");
    expect(res.status).toBe(404);
    expect((await res.text())).toContain("page-content"); // the 404 shell
  });

  it("a regexp compile failure 404-shells (the engine's refusal ladder)", async () => {
    await seedSrchRepo();
    const res = await fetchUi("/srch-owner/srch/search?q=%28&search_mode=regexp");
    expect(res.status).toBe(404);
  });

  it("an empty repo (never pushed) renders the bare form but 404s a keyword", async () => {
    const owner = await seedVerifiedUser({ username: "srch-empty-owner" });
    await new RepoService(env.DB).create({
      owner: { id: owner.id, usernameLower: "srch-empty-owner" },
      name: "vacant",
      isPrivate: false,
      status: "ready",
    });
    expect((await fetchUi("/srch-empty-owner/vacant/search")).status).toBe(200);
    expect((await fetchUi("/srch-empty-owner/vacant/search?q=x")).status).toBe(404);
  });

  it("a private repo 404-shells anonymous — existence stays hidden", async () => {
    const owner = await seedVerifiedUser({ username: "srch-priv-owner" });
    await new RepoService(env.DB).create({
      owner: { id: owner.id, usernameLower: "srch-priv-owner" },
      name: "vault",
      isPrivate: true,
      status: "ready",
    });
    const res = await fetchUi("/srch-priv-owner/vault/search?q=x");
    expect(res.status).toBe(404);
    expect((await res.text())).toContain("page-content");
  });

  it("no matching results renders upstream's no_results line, not the placeholder", async () => {
    await seedSrchRepo();
    const res = await fetchUi("/srch-owner/srch/search?q=zzz-no-such-word");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("No matching results found.");
    expect(html).not.toContain("Start a code search.");
    expect(html).not.toContain("repo-search-result");
  });
});

// --- truncation + pagination -------------------------------------------------------

describe("the truncation notice and the gitgrep.go:50-53 page slice", () => {
  it("52 matching files answer 50 cards + the honesty notice (the SPEC-ledgered divergence)", async () => {
    await seedSrchRepo();
    const res = await fetchUi("/srch-owner/srch/search?q=capword");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.split("repo-search-result").length - 1).toBe(20); // page 1's slice
    expect(html).toContain("The search stopped at its result budget — showing the first 50 of 52 matching files.");
    // the notice rides the info-message shape, above the cards
    expect(html).toContain('class="ui info message"');
    // 50 blocks / 20 per page → 3 pages
    expect(html).toContain("ui borderless pagination menu");
    expect(html).toContain('href="/srch-owner/srch/search?q=capword&amp;search_mode=words&amp;page=2"');
    expect(html).toContain('href="/srch-owner/srch/search?q=capword&amp;search_mode=words&amp;page=3"');
  });

  it("the ordinary 22-block answer paginates WITHOUT the notice", async () => {
    await seedSrchRepo();
    const res = await fetchUi("/srch-owner/srch/search?q=pageword");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.split("repo-search-result").length - 1).toBe(20);
    expect(html).not.toContain("The search stopped at its result budget");
    expect(html).toContain('href="/srch-owner/srch/search?q=pageword&amp;search_mode=words&amp;page=2"');
    // page 2 carries the remaining 2 cards and the Previous arm
    const second = await fetchUi("/srch-owner/srch/search?q=pageword&page=2");
    expect(second.status).toBe(200);
    const secondHtml = await second.text();
    expect(secondHtml.split("repo-search-result").length - 1).toBe(2);
    expect(secondHtml).toContain("page/f-20.txt");
    expect(secondHtml).toContain("page/f-21.txt");
    expect(secondHtml).toContain('href="/srch-owner/srch/search?q=pageword&amp;search_mode=words"');
    expect(secondHtml).not.toContain("search_mode=words&amp;page=1");
  });

  it("page clamps like search.go:30-33 (page=0 and garbage fall to 1)", async () => {
    await seedSrchRepo();
    for (const page of ["0", "-3", "bogus"]) {
      const res = await fetchUi(`/srch-owner/srch/search?q=pageword&page=${page}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html.split("repo-search-result").length - 1).toBe(20);
      expect(html).toContain("page/f-00.txt");
    }
    // a past-end page slices empty → the no-results line over zero cards
    const past = await fetchUi("/srch-owner/srch/search?q=pageword&page=99");
    expect(past.status).toBe(200);
    expect((await past.text())).toContain("No matching results found.");
  });
});

// --- the a11y smoke -------------------------------------------------------------

describe("repo-search a11y smoke", () => {
  it("the bare form and a results page pass the structural rules", async () => {
    await seedSrchRepo();
    for (const path of ["/srch-owner/srch/search", "/srch-owner/srch/search?q=FIXME&search_mode=exact"]) {
      const res = await fetchUi(path);
      expect(res.status).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, JSON.stringify(violations)).toEqual([]);
    }
  });
});
