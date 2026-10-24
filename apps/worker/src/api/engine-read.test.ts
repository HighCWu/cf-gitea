/**
 * Tier-1 engine-read/write routes on REAL engine content (SPEC-0004 §2.4
 * category-(c) block: branches ×6, tags ×4 + git/tags, git/refs ×2,
 * git/trees, git/blobs, contents ×5, raw, media, editorconfig,
 * issue_templates). The seeding reuses the ui/testing seed-repo pattern —
 * REAL pushed packs through the landed git-http receive flow (SELF.fetch →
 * gitHttpGate → the engine's receive pipeline), not stub responses.
 *
 * The routes mount LOCALLY (the tier-2 compat pattern): router.ts registration
 * is the orchestrator's deferred one-liner, so this file is its own mount —
 * which is exactly the seam the one-liner wires later.
 *
 * Pinned here: ref-CAS semantics (PUT 422 stale old_commit_id, the engine's
 * ref_conflict → 409 mapping, force-gate 422), tag create (200 quirk,
 * annotated via the Worker-side serializeTag + putApiObjects + commitApiChange
 * chain) / delete (204, release-coupled 409, empty-repo 405), the contents
 * union shapes (object vs array), the write family through the commit builder
 * (create 201 / update 200-vs-201 / delete 200 / batch / new_branch), raw's
 * legacy {ref}/{filepath} parsing, editorconfig section resolution, and the
 * issue-template front-matter read.
 */

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { OpenAPIHono } from "@hono/zod-openapi";

import { ensureSeededRepo, type SeedCommit } from "../ui/testing/seed-repo";
import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { repositories, users } from "../db/schema";
import { createOptionalTokenAuthMiddleware, createTokenAuthMiddleware, STUB_USER, type AuthResolver } from "./auth";
import { giteaErrorHandler } from "./errors";
import type { ApiEnv } from "./env";
import { registerBranchRoutes } from "./routes/branches";
import { registerContentsRoutes } from "./routes/contents";
import { registerGitRoutes } from "./routes/git";
import { registerTagRoutes } from "./routes/tags";
import { IssuesService } from "../issues/service";
import { commitApiChangeError, engineCell, engineReads, refTipMap, ZERO_OID } from "./services/engine";
import { RepoService } from "../repos/service";
import type { User } from "./models/user";

const ORIGIN = "https://apisuite.test";
const TOKEN = "engine-suite-token";
const OWNER = "apisuite";
const SLUG = "engine";
const REPO_PATH = `/repos/${OWNER}/${SLUG}`;

const T0 = 1_760_000_000;

const SEED_COMMITS: SeedCommit[] = [
  {
    message: "seed: initial layout",
    time: T0,
    files: [
      { path: "README.md", content: "# engine suite\n" },
      { path: "src/lib.txt", content: "lib v1\n" },
      { path: ".editorconfig", content: "root = true\n\n[*.md]\nindent_size = 2\n\n[*.py]\nindent_size = 4\n" },
      {
        path: ".gitea/ISSUE_TEMPLATE/bug.yml",
        content: "---\nname: Bug report\nabout: File a bug\nlabels: [bug]\nassignees: [apisuite]\n---\nDescribe the bug\n",
      },
    ],
  },
  {
    message: "seed: nested docs",
    time: T0 + 60,
    files: [
      { path: "README.md", content: "# engine suite\n" },
      { path: "src/lib.txt", content: "lib v1\n" },
      { path: ".editorconfig", content: "root = true\n\n[*.md]\nindent_size = 2\n\n[*.py]\nindent_size = 4\n" },
      {
        path: ".gitea/ISSUE_TEMPLATE/bug.yml",
        content: "---\nname: Bug report\nabout: File a bug\nlabels: [bug]\nassignees: [apisuite]\n---\nDescribe the bug\n",
      },
      { path: "docs/guide/deep.txt", content: "deep doc\n" },
    ],
  },
];

let OWNER_ID = 1;
let TIP1 = "";
let TIP2 = "";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyAuthD1Migrations();
  const seeded = await ensureSeededRepo({ owner: OWNER, slug: SLUG, commits: SEED_COMMITS, tags: [{ name: "v1.0.0", commitIndex: 1 }] });
  TIP1 = seeded.tips[0] as string;
  TIP2 = seeded.tips[1] as string;
  const row = await drizzle(env.DB).select({ id: users.id }).from(users).where(eq(users.usernameLower, OWNER)).get();
  if (row === undefined) throw new Error("seed owner missing");
  OWNER_ID = row.id;
});

/** The api-layer identity the suite token resolves to (the seeded owner). */
function identity(): User {
  return { ...STUB_USER, id: OWNER_ID, login: OWNER, full_name: OWNER, created: new Date(T0 * 1000).toISOString() };
}

const resolver: AuthResolver = { resolveToken: (token: string) => Promise.resolve(token === TOKEN ? identity() : null) };

/** Local mount — the deferred router.ts one-liner's exact seam. */
function app(): OpenAPIHono<ApiEnv> {
  const a = new OpenAPIHono<ApiEnv>();
  a.onError(giteaErrorHandler);
  const requireAuth = createTokenAuthMiddleware(resolver);
  const optionalAuth = createOptionalTokenAuthMiddleware(resolver);
  registerBranchRoutes(a, requireAuth, optionalAuth);
  registerTagRoutes(a, requireAuth, optionalAuth);
  registerGitRoutes(a, requireAuth, optionalAuth);
  registerContentsRoutes(a, requireAuth, optionalAuth);
  return a;
}


/** The parsed body of an in-process response, view-shaped for assertions. */
async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await res.text());
  return parsed as Record<string, unknown>;
}

const authed = (init?: RequestInit): RequestInit => ({
  ...init,
  headers: { ...(init?.headers ?? {}), Authorization: `token ${TOKEN}` },
});

const jsonInit = (method: string, body: unknown): RequestInit => authed({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const get = async (path: string): Promise<Response> => app().fetch(new Request(`${ORIGIN}${path}`), env);
const send = async (path: string, init: RequestInit): Promise<Response> => app().fetch(new Request(`${ORIGIN}${path}`, init), env);

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

describe("GET /repos/{owner}/{repo}/branches (repoListBranches)", () => {
  it("lists the pushed branches with the contract Branch shape and pagination headers", async () => {
    const res = await get(`${REPO_PATH}/branches`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("1");
    const branches: Array<Record<string, unknown>> = await res.json();
    expect(branches).toHaveLength(1);
    const main = branches[0] as Record<string, unknown>;
    expect(main.name).toBe("main");
    expect(main.protected).toBe(false);
    expect((main.commit as Record<string, unknown>).id).toBe(TIP2);
    for (const key of Object.keys(main)) {
      expect(["commit", "effective_branch_protection_name", "enable_status_check", "name", "protected", "required_approvals", "status_check_contexts", "user_can_merge", "user_can_push"]).toContain(key);
    }
  });

  it("404s an invisible repository (runtime-only status)", async () => {
    const res = await get(`/repos/${OWNER}/ghost-branch-repo/branches`);
    expect(res.status).toBe(404);
  });
});

describe("GET /repos/{owner}/{repo}/branches/{branch} (repoGetBranch)", () => {
  it("renders the branch tip commit", async () => {
    const res = await get(`${REPO_PATH}/branches/main`);
    expect(res.status).toBe(200);
    const branch: Record<string, unknown> = await res.json();
    expect((branch.commit as Record<string, unknown>).id).toBe(TIP2);
  });

  it("404s a missing branch", async () => {
    expect((await get(`${REPO_PATH}/branches/missing`)).status).toBe(404);
  });
});

describe("POST /repos/{owner}/{repo}/branches (repoCreateBranch)", () => {
  it("creates a branch from the default branch (201) and the ref lands in the engine", async () => {
    const res = await send(`${REPO_PATH}/branches`, jsonInit("POST", { new_branch_name: "topic" }));
    expect(res.status).toBe(201);
    const branch: Record<string, unknown> = await res.json();
    expect(branch.name).toBe("topic");
    const tips = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs());
    expect(tips.get("refs/heads/topic")?.target).toBe(TIP2);
  });

  it("creates from old_ref_name at an earlier commit; duplicates and tag-name collisions 409", async () => {
    const res = await send(`${REPO_PATH}/branches`, jsonInit("POST", { new_branch_name: "at-v1", old_ref_name: TIP1 }));
    expect(res.status).toBe(201);
    expect((await jsonBody(res)).name).toBe("at-v1");

    const dup = await send(`${REPO_PATH}/branches`, jsonInit("POST", { new_branch_name: "topic" }));
    expect(dup.status).toBe(409);
    const tagCollision = await send(`${REPO_PATH}/branches`, jsonInit("POST", { new_branch_name: "v1.0.0" }));
    expect(tagCollision.status).toBe(409);
    const missingOld = await send(`${REPO_PATH}/branches`, jsonInit("POST", { new_branch_name: "x", old_branch_name: "ghost" }));
    expect(missingOld.status).toBe(404);
  });
});

describe("PUT /repos/{owner}/{repo}/branches/{branch} (repoUpdateBranch) — the ref-CAS row", () => {
  it("moves the branch to a new commit with a matching old_commit_id (204) and the engine follows", async () => {
    // TIP1 → TIP2 rewind is a non-FF move: the explicit force flag is part of
    // the body (upstream UpdateBranch's ForcePush confirm).
    const res = await send(`${REPO_PATH}/branches/topic`, jsonInit("PUT", { new_commit_id: TIP1, old_commit_id: TIP2, force: true }));
    expect(res.status).toBe(204);
    const tips = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs());
    expect(tips.get("refs/heads/topic")?.target).toBe(TIP1);
  });

  it("422s a stale old_commit_id, an unresolvable target, and a non-FF move without force", async () => {
    // topic sits at TIP1 after the forced rewind above.
    expect((await send(`${REPO_PATH}/branches/topic`, jsonInit("PUT", { new_commit_id: TIP2, old_commit_id: TIP1 + "0" }))).status).toBe(422);
    expect((await send(`${REPO_PATH}/branches/topic`, jsonInit("PUT", { new_commit_id: "f".repeat(40) }))).status).toBe(422);
    // TIP1 → TIP2 is a fast-forward: no force needed (204)
    expect((await send(`${REPO_PATH}/branches/topic`, jsonInit("PUT", { new_commit_id: TIP2 }))).status).toBe(204);
    // rewinding again without force is a non-FF move → 422
    expect((await send(`${REPO_PATH}/branches/topic`, jsonInit("PUT", { new_commit_id: TIP1 }))).status).toBe(422);
  });

  it("maps the engine's ref_conflict to the declared 409 (CAS lost)", async () => {
    // Service-level deterministic CAS loss: a create-on-empty CAS against a
    // ref that already exists — the exact outcome a lost PUT race produces.
    // commitApiChangeError maps it to the route family's declared 409.
    const result = await engineCell(env, { ownerNamespace: OWNER, slug: SLUG }).commitApiChange({
      ref: "refs/heads/topic",
      expectedOldOid: ZERO_OID,
      newOid: TIP1,
    });
    expect(result.tag).toBe("ref_conflict");
    if (result.tag === "ref_conflict") {
      expect(result.currentOid).toBe(TIP2); // topic sits at TIP2 after the FF move
      expect(commitApiChangeError(result).status).toBe(409);
    }
  });
});

describe("DELETE + PATCH /repos/{owner}/{repo}/branches/{branch}", () => {
  it("403s deleting the default branch", async () => {
    const res = await send(`${REPO_PATH}/branches/main`, authed({ method: "DELETE" }));
    expect(res.status).toBe(403);
  });

  it("renames a branch (204): the new ref exists, the old is gone", async () => {
    const res = await send(`${REPO_PATH}/branches/at-v1`, jsonInit("PATCH", { name: "renamed" }));
    expect(res.status).toBe(204);
    const tips = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs());
    expect(tips.get("refs/heads/renamed")?.target).toBe(TIP1);
    expect(tips.get("refs/heads/at-v1")).toBeUndefined();

    const targetExists = await send(`${REPO_PATH}/branches/renamed`, jsonInit("PATCH", { name: "main" }));
    expect(targetExists.status).toBe(422);
    const missing = await send(`${REPO_PATH}/branches/at-v1`, jsonInit("PATCH", { name: "other" }));
    expect(missing.status).toBe(404);
  });

  it("renames the default branch: setHead moves engine HEAD and D1 default_branch follows", async () => {
    const res = await send(`${REPO_PATH}/branches/main`, jsonInit("PATCH", { name: "trunk" }));
    expect(res.status).toBe(204);
    const refs = await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs();
    expect(refs?.head).toBe("refs/heads/trunk");
    const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.slug, SLUG)).get();
    expect(row?.defaultBranch).toBe("trunk");
    // rename back so later suites see the conventional default
    expect((await send(`${REPO_PATH}/branches/trunk`, jsonInit("PATCH", { name: "main" }))).status).toBe(204);
  });

  it("deletes a branch (204); missing → 404", async () => {
    expect((await send(`${REPO_PATH}/branches/renamed`, authed({ method: "DELETE" }))).status).toBe(204);
    expect((await send(`${REPO_PATH}/branches/renamed`, authed({ method: "DELETE" }))).status).toBe(404);
    const tips = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs());
    expect(tips.get("refs/heads/renamed")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

describe("tags (repoListTags / repoCreateTag / repoGetTag / repoDeleteTag / GetAnnotatedTag)", () => {
  it("lists the pushed lightweight tag with pagination headers", async () => {
    const res = await get(`${REPO_PATH}/tags`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).toBe("1");
    const tags: Array<Record<string, unknown>> = await res.json();
    expect(tags[0]?.name).toBe("v1.0.0");
    expect((tags[0]?.commit as Record<string, unknown>).sha).toBe(TIP2);
  });

  it("creates an ANNOTATED tag (200 quirk) whose object git/tags/{sha} serves", async () => {
    const res = await send(`${REPO_PATH}/tags`, jsonInit("POST", { tag_name: "v2.0.0-rc1", message: "release candidate\n", target: TIP1 }));
    expect(res.status).toBe(200);
    const tag: Record<string, unknown> = await res.json();
    expect(tag.name).toBe("v2.0.0-rc1");
    expect((tag.commit as Record<string, unknown>).sha).toBe(TIP1);

    // the annotated object is readable at its own sha
    const annotated = await get(`${REPO_PATH}/git/tags/${String(tag.id)}`);
    expect(annotated.status).toBe(200);
    const object: Record<string, unknown> = await annotated.json();
    expect(object.tag).toBe("v2.0.0-rc1");
    expect((object.object as Record<string, unknown>).sha).toBe(TIP1);

    // the lightweight seed tag is NOT an annotated object → 404
    const tips = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs());
    expect((await get(`${REPO_PATH}/git/tags/${tips.get("refs/tags/v1.0.0")?.target}`)).status).toBe(404);
    expect((await get(`${REPO_PATH}/git/tags/nothex`)).status).toBe(400);
  });

  it("renders a single tag (200) and 404s misses", async () => {
    const res = await get(`${REPO_PATH}/tags/v1.0.0`);
    expect(res.status).toBe(200);
    expect((await jsonBody(res)).name).toBe("v1.0.0");
    expect((await get(`${REPO_PATH}/tags/ghost`)).status).toBe(404);
  });

  it("deletes a tag (204), 409s a release-coupled tag, 405s empty repos, 409s duplicates", async () => {
    // a release row attached to v1.0.0 blocks the delete
    const repoRow = await drizzle(env.DB).select().from(repositories).where(eq(repositories.slug, SLUG)).get();
    const service = new IssuesService(env.DB);
    await service.createRelease({ repoId: repoRow?.id ?? "0", publisherId: OWNER_ID, tagName: "v1.0.0", title: "one" });
    expect((await send(`${REPO_PATH}/tags/v1.0.0`, authed({ method: "DELETE" }))).status).toBe(409);

    expect((await send(`${REPO_PATH}/tags/v2.0.0-rc1`, authed({ method: "DELETE" }))).status).toBe(204);
    expect((await get(`${REPO_PATH}/tags/v2.0.0-rc1`)).status).toBe(404);
    expect((await send(`${REPO_PATH}/tags`, jsonInit("POST", { tag_name: "v2.0.0-rc1" }))).status).toBe(200);

    const dup = await send(`${REPO_PATH}/tags`, jsonInit("POST", { tag_name: "v1.0.0" }));
    expect(dup.status).toBe(409);
  });

  it("answers 405 on an empty repository for create/delete", async () => {
    const service = new RepoService(env.DB);
    await service.create({ owner: { id: OWNER_ID, usernameLower: OWNER }, name: "empty-repo", isPrivate: false, status: "ready" });
    expect((await send(`/repos/${OWNER}/empty-repo/tags`, jsonInit("POST", { tag_name: "x" }))).status).toBe(405);
    expect((await send(`/repos/${OWNER}/empty-repo/tags/x`, authed({ method: "DELETE" }))).status).toBe(405);
    expect((await send(`/repos/${OWNER}/empty-repo/branches`, jsonInit("POST", { new_branch_name: "x" }))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// git/refs, git/trees, git/blobs
// ---------------------------------------------------------------------------

describe("git/refs (repoListAllGitRefs / repoListGitRefs)", () => {
  it("lists every ref as Reference[]; 404s an empty repo", async () => {
    const res = await get(`${REPO_PATH}/git/refs`);
    expect(res.status).toBe(200);
    const refs: Array<Record<string, unknown>> = await res.json();
    const names = refs.map((ref) => ref.ref).sort();
    expect(names).toContain("refs/heads/main");
    expect(names).toContain("refs/tags/v1.0.0");
    expect((await get(`/${OWNER}/empty-repo/git/refs`)).status).toBe(404);
  });

  it("prefix-matches {ref}; a single exact match answers the bare object", async () => {
    const heads = await get(`${REPO_PATH}/git/refs/heads`);
    expect(heads.status).toBe(200);
    expect(Array.isArray(await heads.json())).toBe(true);

    const exact = await get(`${REPO_PATH}/git/refs/heads/main`);
    expect(exact.status).toBe(200);
    const single: Record<string, unknown> = await exact.json();
    expect(single.ref).toBe("refs/heads/main");
    expect((single.object as Record<string, unknown>).sha).toBe(TIP2);

    expect((await get(`${REPO_PATH}/git/refs/heads/ghost`)).status).toBe(404);
  });
});

describe("git/trees/{sha} (GetTree)", () => {
  it("renders the root tree of a ref with page/per_page pagination", async () => {
    const res = await get(`${REPO_PATH}/git/trees/main?per_page=2&page=2`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Total-Count")).not.toBeNull();
    const tree: Record<string, unknown> = await res.json();
    expect(tree.truncated).toBe(false);
    const entries = tree.tree as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(["mode", "path", "sha", "size", "type", "url"]);
    }
  });

  it("recursive=true flattens with full paths and truncation flag", async () => {
    const res = await get(`${REPO_PATH}/git/trees/main?recursive=true&per_page=50`);
    expect(res.status).toBe(200);
    const tree: Record<string, unknown> = await res.json();
    const paths = (tree.tree as Array<Record<string, unknown>>).map((entry) => entry.path);
    expect(paths).toContain("docs/guide/deep.txt");
    expect(paths).toContain("src/lib.txt");
  });

  it("400s an unresolvable sha", async () => {
    expect((await get(`${REPO_PATH}/git/trees/${"b".repeat(40)}`)).status).toBe(400);
  });
});

describe("git/blobs/{sha} (GetBlob)", () => {
  it("serves the blob base64-encoded", async () => {
    const contents = await get(`${REPO_PATH}/contents/README.md`);
    const sha = (await jsonBody(contents)).sha as string;
    const res = await get(`${REPO_PATH}/git/blobs/${sha}`);
    expect(res.status).toBe(200);
    const blob: Record<string, unknown> = await res.json();
    expect(blob.encoding).toBe("base64");
    expect(atob(blob.content as string)).toBe("# engine suite\n");
    expect((await get(`${REPO_PATH}/git/blobs/${"c".repeat(40)}`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

describe("contents reads (repoGetContentsList / repoGetContents) — the union shapes", () => {
  it("lists the root as an array; enriches last_commit_*", async () => {
    const res = await get(`${REPO_PATH}/contents`);
    expect(res.status).toBe(200);
    const entries: Array<Record<string, unknown>> = await res.json();
    const names = entries.map((entry) => entry.name).sort();
    expect(names).toEqual([".editorconfig", ".gitea", "README.md", "docs", "src"]);
    const readme = entries.find((entry) => entry.name === "README.md") as Record<string, unknown>;
    expect(readme.type).toBe("file");
    expect(readme.content).toBeNull(); // listings render metadata only
    // README is byte-identical across both seed commits — the last commit
    // TOUCHING it is the first one (git log -- path semantics)
    expect(readme.last_commit_sha).toBe(TIP1);
    const dir = entries.find((entry) => entry.name === "docs") as Record<string, unknown>;
    expect(dir.type).toBe("dir");
  });

  it("answers an OBJECT for a file (base64 content) and an ARRAY for a dir", async () => {
    const file = await get(`${REPO_PATH}/contents/README.md`);
    expect(file.status).toBe(200);
    const fileBody: Record<string, unknown> = await file.json();
    expect(fileBody.type).toBe("file");
    expect(atob(fileBody.content as string)).toBe("# engine suite\n");
    expect(fileBody.encoding).toBe("base64");

    const dir = await get(`${REPO_PATH}/contents/docs`);
    expect(dir.status).toBe(200);
    const dirBody = await dir.json();
    expect(Array.isArray(dirBody)).toBe(true);
    const dirEntries = dirBody as Array<Record<string, unknown>>;
    expect(dirEntries[0]?.path).toBe("docs/guide");
    expect(dirEntries[0]?.type).toBe("dir");

    const nested = await get(`${REPO_PATH}/contents/docs/guide/deep.txt`);
    expect(nested.status).toBe(200);
    const nestedBody: Record<string, unknown> = await nested.json();
    expect(atob(nestedBody.content as string)).toBe("deep doc\n");
    expect(nestedBody.last_commit_sha).toBe(TIP2); // added by the second seed commit

    expect((await get(`${REPO_PATH}/contents/ghost.txt`)).status).toBe(404);
  });

  it("resolves the ?ref= param (branch and tag)", async () => {
    const atTip1 = await get(`${REPO_PATH}/contents/README.md?ref=${TIP1}`);
    expect(atTip1.status).toBe(200);
    const tagged = await get(`${REPO_PATH}/contents/README.md?ref=v1.0.0`);
    expect(tagged.status).toBe(200);
    // the tag pins commit 2, but README's last TOUCHING commit is still the first
    expect((await jsonBody(tagged)).last_commit_sha).toBe(TIP1);
  });
});

describe("contents writes (repoCreateFile / repoUpdateFile / repoDeleteFile / repoChangeFiles)", () => {
  let fileSha = "";

  it("creates a file (201) — the commit lands through putApiObjects + commitApiChange", async () => {
    const res = await send(`${REPO_PATH}/contents/hello.txt`, jsonInit("POST", { content: btoa("hello engine\n"), message: "add hello" }));
    expect(res.status).toBe(201);
    const body: Record<string, unknown> = await res.json();
    const content = body.content as Record<string, unknown>;
    fileSha = content.sha as string;
    expect(atob(content.content as string)).toBe("hello engine\n");
    expect((body.commit as Record<string, unknown>).message).toBe("add hello\n"); // serializeCommit adds the trailing newline (git convention)

    // the ref moved and the file is readable through the read path
    const tips = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs());
    expect(tips.get("refs/heads/main")?.target).not.toBe(TIP2);
    expect((await get(`${REPO_PATH}/contents/hello.txt`)).status).toBe(200);
    // parented on the previous tip
    const tip = await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).readCommit(tips.get("refs/heads/main")?.target);
    expect(tip?.parents[0]).toBe(TIP2);

    const dup = await send(`${REPO_PATH}/contents/hello.txt`, jsonInit("POST", { content: btoa("dup") }));
    expect(dup.status).toBe(422);
  });

  it("updates with a matching sha (200); 422s a stale sha; creates when sha absent (201)", async () => {
    const staleSha = fileSha;
    const updated = await send(`${REPO_PATH}/contents/hello.txt`, jsonInit("PUT", { content: btoa("hello v2\n"), sha: fileSha, message: "update hello" }));
    expect(updated.status).toBe(200);
    const body: Record<string, unknown> = await updated.json();
    fileSha = ((body.content as Record<string, unknown>).sha) as string;
    expect(atob((body.content as Record<string, unknown>).content as string)).toBe("hello v2\n");

    const stale = await send(`${REPO_PATH}/contents/hello.txt`, jsonInit("PUT", { content: btoa("x"), sha: staleSha }));
    expect(stale.status).toBe(422);
    const createNoSha = await send(`${REPO_PATH}/contents/brand-new.txt`, jsonInit("PUT", { content: btoa("brand\n") }));
    expect(createNoSha.status).toBe(201);
  });

  it("renames via from_path and deletes with sha (200, FileDeleteResponse)", async () => {
    const renamed = await send(`${REPO_PATH}/contents/hello2.txt`, jsonInit("PUT", { content: btoa("hello v2\n"), sha: fileSha, from_path: "hello.txt", message: "rename hello" }));
    expect(renamed.status).toBe(200);
    expect((await get(`${REPO_PATH}/contents/hello.txt`)).status).toBe(404);

    const hello2 = await jsonBody(await get(`${REPO_PATH}/contents/hello2.txt`));
    const sha = hello2.sha as string;
    const deleted = await send(`${REPO_PATH}/contents/hello2.txt`, jsonInit("DELETE", { sha, message: "remove hello" }));
    expect(deleted.status).toBe(200);
    const body: Record<string, unknown> = await deleted.json();
    expect(body.content).toBeNull();
    expect((body.commit as Record<string, unknown>).message).toBe("remove hello\n");
    expect((await get(`${REPO_PATH}/contents/hello2.txt`)).status).toBe(404);
  });

  it("commits a batch (201, FilesResponse) and honors new_branch", async () => {
    const batch = await send(`${REPO_PATH}/contents`, jsonInit("POST", {
      files: [
        { operation: "create", path: "batch/a.txt", content: btoa("a\n") },
        { operation: "create", path: "batch/b.txt", content: btoa("b\n") },
      ],
      message: "batch add",
    }));
    expect(batch.status).toBe(201);
    const body: Record<string, unknown> = await batch.json();
    expect((body.files as Array<Record<string, unknown>>)[0]?.path).toBe("batch/a.txt");
    expect((await get(`${REPO_PATH}/contents/batch/a.txt`)).status).toBe(200);

    const onBranch = await send(`${REPO_PATH}/contents/feature.txt`, jsonInit("POST", { content: btoa("feature\n"), new_branch: "feature", message: "feature file" }));
    expect(onBranch.status).toBe(201);
    // the new branch carries the file; main does not
    expect((await get(`${REPO_PATH}/contents/feature.txt?ref=feature`)).status).toBe(200);
    expect((await get(`${REPO_PATH}/contents/feature.txt`)).status).toBe(404);
    const tips = refTipMap(await engineReads(env, { ownerNamespace: OWNER, slug: SLUG }).listRefs());
    expect(tips.get("refs/heads/feature")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// raw / media / editorconfig / issue_templates
// ---------------------------------------------------------------------------

describe("raw + media (repoGetRawFile / repoGetRawFileOrLFS)", () => {
  it("serves raw bytes via the ref query param", async () => {
    const res = await get(`${REPO_PATH}/raw/README.md?ref=main`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(await res.text()).toBe("# engine suite\n");
  });

  it("parses the legacy {ref}/{filepath} embedded form (longest ref prefix wins)", async () => {
    const tagged = await get(`${REPO_PATH}/raw/v1.0.0/README.md`);
    expect(tagged.status).toBe(200);
    expect(await tagged.text()).toBe("# engine suite\n");

    // unencoded multi-segment filepath on the default branch (plain catchall)
    const nested = await get(`${REPO_PATH}/raw/docs/guide/deep.txt`);
    expect(nested.status).toBe(200);
    expect(await nested.text()).toBe("deep doc\n");

    expect((await get(`${REPO_PATH}/raw/ghost.txt`)).status).toBe(404);
  });

  it("media twins raw pre-LFS", async () => {
    const res = await get(`${REPO_PATH}/media/src/lib.txt`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("lib v1\n");
  });
});

describe("editorconfig + issue_templates", () => {
  it("resolves the matching .editorconfig section", async () => {
    const md = await get(`${REPO_PATH}/editorconfig/README.md`);
    expect(md.status).toBe(200);
    expect(await md.json()).toEqual({ indent_size: "2" });
    const py = await get(`${REPO_PATH}/editorconfig/code.py`);
    expect(py.status).toBe(200);
    expect(await py.json()).toEqual({ indent_size: "4" });
    expect((await get(`${REPO_PATH}/editorconfig/code.rs`)).status).toBe(404);
  });

  it("lists issue templates with parsed front matter", async () => {
    const res = await get(`${REPO_PATH}/issue_templates`);
    expect(res.status).toBe(200);
    const templates: Array<Record<string, unknown>> = await res.json();
    expect(templates).toHaveLength(1);
    expect(templates[0]?.file_name).toBe("bug.yml");
    expect(templates[0]?.name).toBe("Bug report");
    expect(templates[0]?.labels).toEqual(["bug"]);
    expect(templates[0]?.assignees).toEqual(["apisuite"]);
  });
});
