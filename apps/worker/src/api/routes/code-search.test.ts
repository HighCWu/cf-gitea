/**
 * The 38389f00be code-search API pair's battery (census B-90) — REAL engine
 * content through the landed receive flow (the seed-repo pattern), mounted
 * locally (the tier-2 compat pattern; the router.ts registration is landed).
 *
 * Pinned here: the repo-scoped git-grep real-read (matcher semantics —
 * path-or-content, case-insensitivity, AND across terms, phrases, regexp
 * terms, the path: qualifier, the vendored skip and the .gitignore basename
 * override, ls-tree result order), the parser's exact 422 ladder, the
 * 1000-window guard, the upstream arm order (ref 404 → window 422 → query
 * 422), pagination + the Link/X-Total-Count headers, the ToCodeSearchResultItem
 * wire shapes (url/html_url/repository/text_matches with byte indices, the
 * absent language key), the ref param (tag/branch resolution + the
 * ErrNotExist 404 body), the empty-repo 200-empty posture and its explicit
 * ref 404, invisible-repo 404s, and the global /search/code ladder
 * (anonymous 401 → token 404 — the un-warmed-indexer feature-gate posture).
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { OpenAPIHono } from "@hono/zod-openapi";

import { ensureSeededRepo } from "../../ui/testing/seed-repo";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { repositories, users } from "../../db/schema";
import { createOptionalTokenAuthMiddleware, createTokenAuthMiddleware, STUB_USER, type AuthResolver } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import { registerCodeSearchRoutes } from "./code-search";
import type { User } from "../models/user";

const ORIGIN = "https://codesuite.test";
const TOKEN = "code-search-suite-token";
const OWNER = "codesrch";
const SLUG = "code";
const REPO_PATH = `/repos/${OWNER}/${SLUG}`;
const SEARCH_PATH = `${REPO_PATH}/code/search`;

const T0 = 1_770_000_000;

/** Commit 1 is the v1 tag's tree; commit 2 (the default tip) adds docs/. */
const BASE_FILES = [
  { path: "README.md", content: "# suite readme\nneedle one\n" },
  { path: "src/lib.txt", content: "needle two\n" },
  // vendored paths are skipped by the ExcludeVendored default (true upstream)
  { path: "vendor/lib.js", content: "needle vendored\n" },
  // the .gitignore basename override: vendor-listed pattern, still searchable
  { path: ".gitignore", content: "needle gitignore\n" },
];

const SEED_COMMITS = [
  { message: "seed: base layout", time: T0, files: BASE_FILES },
  {
    message: "seed: docs tree",
    time: T0 + 60,
    files: [...BASE_FILES, { path: "docs/guide.md", content: "needle guide\n" }],
  },
];

// A NAME-only term: the path matches, the content never does — the
// path-or-content arm of the FileMatcher.
const NAME_ONLY_COMMIT = {
  message: "seed: name-only file",
  time: T0 + 120,
  files: [
    ...BASE_FILES,
    { path: "docs/guide.md", content: "needle guide\n" },
    { path: "zeta/notes.txt", content: "plain text\n" },
  ],
};

let TIP2 = "";
let OWNER_ID = 1;

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyAuthD1Migrations();
  const seeded = await ensureSeededRepo({ owner: OWNER, slug: SLUG, commits: SEED_COMMITS, tags: [{ name: "v1", commitIndex: 0 }] });
  TIP2 = seeded.tips[1] as string;
  const row = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, OWNER)).get();
  if (row === undefined) throw new Error("seed owner missing");
  OWNER_ID = row.id;
  // A NAME-only repo (commit 3's tree) — mounted at its own slug so the
  // main repo's pins stay stable.
  await ensureSeededRepo({ owner: OWNER, slug: "names", commits: [NAME_ONLY_COMMIT] });
});

/** The api-layer identity the suite token resolves to (the seeded owner). */
function identity(): User {
  return { ...STUB_USER, id: OWNER_ID, login: OWNER, full_name: OWNER, created: new Date(T0 * 1000).toISOString() };
}

const OUTSIDER_TOKEN = "code-search-outsider";
const OUTSIDER_ID = 4242;

const resolver: AuthResolver = {
  resolveToken: (token: string) =>
    Promise.resolve(token === TOKEN ? identity() : token === OUTSIDER_TOKEN ? { ...STUB_USER, id: OUTSIDER_ID, login: "outsider", full_name: "outsider", created: new Date(T0 * 1000).toISOString() } : null),
};

/** Local mount — router.ts's landed registration is the same seam. */
function app(): OpenAPIHono<ApiEnv> {
  const a = new OpenAPIHono<ApiEnv>();
  a.onError(giteaErrorHandler);
  const requireAuth = createTokenAuthMiddleware(resolver);
  const optionalAuth = createOptionalTokenAuthMiddleware(resolver);
  registerCodeSearchRoutes(a, requireAuth, optionalAuth);
  return a;
}

/** The parsed body of an in-process response, view-shaped for assertions. */
async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = await res.json();
  return parsed as Record<string, unknown>;
}

const get = async (path: string, token?: string): Promise<Response> => {
  const headers: Record<string, string> = token === undefined ? {} : { Authorization: `token ${token}` };
  return app().fetch(new Request(`${ORIGIN}${path}`, { headers }), env);
};

const queryOf = async (q: string, extra = "", token?: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await get(`${SEARCH_PATH}?q=${encodeURIComponent(q)}${extra}`, token);
  return { status: res.status, body: await jsonBody(res) };
};

/** Insert an EMPTY repo row (born ready+empty — the API-create posture). */
async function seedEmptyRepo(slug: string, visibility: "public" | "private"): Promise<void> {
  await drizzle(env.DB).insert(repositories).values({
    id: `csx_${slug}`,
    storageKey: `r_csx_${slug}`,
    ownerNamespace: OWNER,
    ownerId: OWNER_ID,
    slug,
    visibility,
  });
}

// ---------------------------------------------------------------------------
// The matcher semantics (the real-read git-grep port)
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/code/search (repoSearchCode) — matcher", () => {
  it("matches every non-vendored file containing the term, in ls-tree order, with the full envelope", async () => {
    const res = await get(`${SEARCH_PATH}?q=needle`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("4");
    const body = await jsonBody(res);
    expect(body.total_count).toBe(4);
    expect(body.incomplete_results).toBe(false);
    const items = body.items as Array<Record<string, unknown>>;
    // vendor/lib.js is excluded (ExcludeVendored true — the upstream default);
    // .gitignore survives it (the basename override). ls-tree order:
    // .gitignore, README.md, docs/, src/.
    expect(items.map((item) => item.path)).toEqual([".gitignore", "README.md", "docs/guide.md", "src/lib.txt"]);
    for (const item of items) {
      expect("language" in item).toBe(false); // omitempty — git grep never sets it
    }
  });

  it("matches a file by PATH alone when the content misses (path-or-content)", async () => {
    // the "names" repo carries zeta/notes.txt ("plain text") — the term lives
    // in the PATH only
    const res = await get(`/repos/${OWNER}/names/code/search?q=zeta`);
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.total_count).toBe(1);
    expect((body.items as Array<Record<string, unknown>>).map((item) => item.path)).toEqual(["zeta/notes.txt"]);
  });

  it("requires EVERY term (content-or-path AND) across the file", async () => {
    const { status, body } = await queryOf("needle guide");
    expect(status).toBe(200);
    // only docs/guide.md carries both substrings
    expect((body.items as Array<Record<string, unknown>>).map((item) => item.path)).toEqual(["docs/guide.md"]);
  });

  it("matches quoted phrases literally (case-insensitively)", async () => {
    const { status, body } = await queryOf('"NEEDLE GUIDE"');
    expect(status).toBe(200);
    expect((body.items as Array<Record<string, unknown>>).map((item) => item.path)).toEqual(["docs/guide.md"]);
  });

  it("matches /regexp/ terms per line, case-insensitively", async () => {
    const { status, body } = await queryOf("/n.edle/");
    expect(status).toBe(200);
    expect(body.total_count).toBe(4);
    const { status: upper, body: upperBody } = await queryOf("/NEEDLE/");
    expect(upper).toBe(200);
    expect(upperBody.total_count).toBe(4);
  });

  it("searches case-insensitively for literal terms", async () => {
    const { status, body } = await queryOf("NEEDLE");
    expect(status).toBe(200);
    expect(body.total_count).toBe(4);
  });

  it("restricts the scan to the path: qualifier's subtree (a q qualifier, not a URL param)", async () => {
    const { status, body } = await queryOf("needle path:docs");
    expect(status).toBe(200);
    expect((body.items as Array<Record<string, unknown>>).map((item) => item.path)).toEqual(["docs/guide.md"]);
    // a path with no matches answers the empty envelope, not an error
    const miss = await queryOf("needle path:src/deep");
    expect(miss.status).toBe(200);
    expect(miss.body.total_count).toBe(0);
    expect(miss.body.items).toEqual([]);
    // a stray path query parameter is dropped (Go drops unknown params; the
    // zod schema strips it identically)
    const stray = await queryOf("needle", "&path=docs");
    expect(stray.status).toBe(200);
    expect(stray.body.total_count).toBe(4);
  });

  it("renders text_matches fragments with byte indices and the FileContent envelope", async () => {
    const res = await get(`${SEARCH_PATH}?q=gitignore`);
    const items = (await jsonBody(res)).items as Array<Record<string, unknown>>;
    const first = items[0] as Record<string, unknown>;
    expect(first.name).toBe(".gitignore");
    expect(first.url).toBe(`${ORIGIN}/api/v1/repos/${OWNER}/${SLUG}/contents/.gitignore?ref=${encodeURIComponent(TIP2)}`);
    expect(first.html_url).toBe(`${ORIGIN}/${OWNER}/${SLUG}/src/commit/${TIP2}/.gitignore`);
    expect(first.repository).toBeTruthy();
    const matches = first.text_matches as Array<Record<string, unknown>>;
    expect(matches).toHaveLength(1);
    const match0 = matches[0] as Record<string, unknown>;
    expect(match0.object_url).toBe(first.url);
    expect(match0.object_type).toBe("FileContent");
    expect(match0.property).toBe("content");
    expect(match0.fragment).toBe("needle gitignore\n");
    const terms = match0.matches as Array<{ text: string; indices: number[] }>;
    expect(terms).toEqual([{ text: "gitignore", indices: [7, 16] }]);
  });

  it("merges nearby matches into one fragment and emits both ranges (the block-merge pin)", async () => {
    const two = await ensureSeededRepo({
      owner: OWNER,
      slug: "frag",
      commits: [{ message: "two needles", time: T0, files: [{ path: "twin.txt", content: "alpha beta\nalpha gamma\n" }] }],
    });
    const res = await get(`/repos/${OWNER}/frag/code/search?q=alpha`);
    expect(res.status).toBe(200);
    const items = (await jsonBody(res)).items as Array<Record<string, unknown>>;
    expect(items.map((item) => item.path)).toEqual(["twin.txt"]);
    const matches = (items[0] as Record<string, unknown>).text_matches as Array<Record<string, unknown>>;
    // both lines live in ONE fragment (the merge arm reaches across the
    // newline window) and both ranges ride its matches with byte indices
    expect(matches).toHaveLength(1);
    const match0 = matches[0] as Record<string, unknown>;
    expect(match0.fragment).toBe("alpha beta\nalpha gamma\n");
    expect(match0.matches).toEqual([
      { text: "alpha", indices: [0, 5] },
      { text: "alpha", indices: [11, 16] },
    ]);
    void two;
  });
});

// ---------------------------------------------------------------------------
// The parser's 422 ladder (ParseSearchQuery's exact messages)
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/code/search — the query 422 ladder", () => {
  const ladder: Array<[string, string]> = [
    ["", "Query must contain a search term"],
    ["a AND b", "Boolean operators are not supported"],
    ["a OR b", "Boolean operators are not supported"],
    ["NOT a", "Boolean operators are not supported"],
    ["-path:x", "Negated qualifiers are not supported"],
    ["content:x", "Unsupported qualifier"],
    ["filename:x", "Unsupported qualifier"],
    ["path:", "Empty qualifier value"],
    ['"abc', "Unterminated quote"],
    ["/(/", "Invalid regexp"],
    ["path:a path:b", "Repeated path qualifier"],
    ["path:/abs", "Invalid path qualifier"],
    ["path:a/../b", "Invalid path qualifier"],
    ["path:a*", "Invalid path qualifier"],
  ];
  // A qualifier ALONE carries zero terms — the parse-time no-term 422 wins
  // (codesearch.Search runs ParseSearchQuery before the engine rejections),
  // so the engine-rejection pins ride queries WITH a term.
  const engineLadder: Array<[string, string]> = [
    ["needle repo:OWNER/NAME", "Repository and owner qualifiers are only supported in global code search"],
    ["needle user:someone", "Repository and owner qualifiers are only supported in global code search"],
    ["needle org:someone", "Repository and owner qualifiers are only supported in global code search"],
    ["needle language:go", "Language qualifiers are not supported by git grep"],
  ];
  for (const [q, message] of [...ladder, ...engineLadder]) {
    it(`422s ${JSON.stringify(q)} with "${message}"`, async () => {
      const { status, body } = await queryOf(q);
      expect(status).toBe(422);
      expect(body.message).toBe(message);
      expect(typeof body.url).toBe("string");
    });
  }

  it("422s the NUL/LF term rule", async () => {
    const res = await get(`${SEARCH_PATH}?q=a%00b`);
    expect(res.status).toBe(422);
    expect((await jsonBody(res)).message).toBe("Terms must not contain LF or NUL");
  });

  it("422s a term over 256 bytes", async () => {
    const { status, body } = await queryOf("a".repeat(257));
    expect(status).toBe(422);
    expect(body.message).toBe("Term exceeds 256 bytes");
  });

  it("accepts a term of exactly 256 bytes (the boundary)", async () => {
    const { status } = await queryOf("a".repeat(256));
    expect(status).toBe(200);
  });

  it("422s the 17th term (max 16)", async () => {
    const seventeen = Array.from({ length: 17 }, (_, i) => `t${i}`).join(" ");
    const { status, body } = await queryOf(seventeen);
    expect(status).toBe(422);
    expect(body.message).toBe("Query exceeds 16 terms");
  });

  it("answers the absent q with the no-term 422, never a validation 400", async () => {
    const res = await get(SEARCH_PATH);
    expect(res.status).toBe(422);
    expect((await jsonBody(res)).message).toBe("Query must contain a search term");
  });
});

// ---------------------------------------------------------------------------
// The window guard + the upstream arm order
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/code/search — the 1000 window and arm order", () => {
  it("422s page beyond the window with the exact message", async () => {
    const { status, body } = await queryOf("needle", "&page=34&limit=30");
    expect(status).toBe(422);
    expect(body.message).toBe("page * limit must not exceed 1000");
  });

  it("accepts the window boundary (page == 1000/limit)", async () => {
    const { status } = await queryOf("needle", "&page=33&limit=30");
    expect(status).toBe(200);
  });

  it("the window guard runs BEFORE the query parse", async () => {
    // no q (would 422 no-term) but the window wins upstream
    const res = await get(`${SEARCH_PATH}?page=34&limit=30`);
    expect(res.status).toBe(422);
    expect((await jsonBody(res)).message).toBe("page * limit must not exceed 1000");
  });

  it("the ref 404 runs BEFORE the window guard", async () => {
    const { status, body } = await queryOf("needle", "&page=34&limit=30&ref=zzz");
    expect(status).toBe(404);
    expect(body.message).toBe("object does not exist [id: zzz, rel_path: ]");
  });
});

// ---------------------------------------------------------------------------
// Pagination + the ref param
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/code/search — pagination and ref resolution", () => {
  it("slices hits by page/limit with the pagination headers", async () => {
    const res = await get(`${SEARCH_PATH}?q=needle&limit=2`);
    expect(res.headers.get("X-Total-Count")).toBe("4");
    expect(res.headers.get("Link")).toContain('rel="next"');
    const page2 = await get(`${SEARCH_PATH}?q=needle&limit=2&page=2`);
    expect(page2.headers.get("X-Total-Count")).toBe("4");
    const link = page2.headers.get("Link") ?? "";
    expect(link).toContain('rel="first"');
    expect(link).toContain('rel="prev"');
    expect(link).not.toContain('rel="next"');
    const body = await jsonBody(page2);
    expect((body.items as Array<Record<string, unknown>>).map((item) => item.path)).toEqual(["docs/guide.md", "src/lib.txt"]);
  });

  it("answers a page past the end with an empty items array", async () => {
    const { status, body } = await queryOf("needle", "&limit=2&page=3");
    expect(status).toBe(200);
    expect(body.total_count).toBe(4);
    expect(body.items).toEqual([]);
  });

  it("searches a TAG ref (the v1 tree — no docs/)", async () => {
    const { status, body } = await queryOf("needle", "&ref=v1");
    expect(status).toBe(200);
    expect((body.items as Array<Record<string, unknown>>).map((item) => item.path)).toEqual([".gitignore", "README.md", "src/lib.txt"]);
  });

  it("404s an unresolvable ref with the ErrNotExist body", async () => {
    const { status, body } = await queryOf("needle", "&ref=zzz");
    expect(status).toBe(404);
    expect(body.message).toBe("object does not exist [id: zzz, rel_path: ]");
  });
});

// ---------------------------------------------------------------------------
// Visibility, empty repos
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/code/search — repo posture", () => {
  beforeAll(async () => {
    await seedEmptyRepo("hollow", "public");
    await seedEmptyRepo("vault", "private");
  });

  it("404s an invisible repository", async () => {
    const res = await get(`/repos/${OWNER}/ghost/code/search?q=needle`);
    expect(res.status).toBe(404);
    expect((await jsonBody(res)).message).toBe("not found");
  });

  it("404s a private repo for an outsider and serves the owner", async () => {
    const outsider = await get(`/repos/${OWNER}/vault/code/search?q=needle`, OUTSIDER_TOKEN);
    expect(outsider.status).toBe(404);
    const owner = await get(`/repos/${OWNER}/vault/code/search?q=needle`, TOKEN);
    expect(owner.status).toBe(200);
  });

  it("answers an EMPTY repo with the 200 empty envelope (no ref resolution)", async () => {
    const res = await get(`/repos/${OWNER}/hollow/code/search?q=needle`);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ total_count: 0, incomplete_results: false, items: [] });
  });

  it("still resolves an explicit ref on an empty repo — the default-branch miss 404s", async () => {
    const res = await get(`/repos/${OWNER}/hollow/code/search?q=needle&ref=main`);
    expect(res.status).toBe(404);
    expect((await jsonBody(res)).message).toBe("object does not exist [id: main, rel_path: ]");
  });
});

// ---------------------------------------------------------------------------
// The global arm — the un-warmed indexer posture
// ---------------------------------------------------------------------------

describe("GET /search/code (codeSearch) — the feature gate ladder", () => {
  it("401s an anonymous caller (reqToken fires before the feature gate)", async () => {
    const res = await get("/search/code?q=needle");
    expect(res.status).toBe(401);
    expect((await jsonBody(res)).message).toBe("token is required");
  });

  it("404s an authenticated caller (no code indexer on this instance — the upstream disabled posture)", async () => {
    const res = await get("/search/code?q=needle", TOKEN);
    expect(res.status).toBe(404);
    expect((await jsonBody(res)).message).toBe("not found");
  });
});
