import { SELF, env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "./auth/testing/apply-d1-migrations";
import { basicHeader, basicTokenHeader, mintFor, resetAuthTables, seedVerifiedUser } from "./auth/testing/seeds";
import { fnv1a32 } from "./auth/failure-limiter";
import { authFailures, repositories } from "./db/schema";
import { asByteStream, gunzipCapped, withVerifiedStart } from "./git-http/gzip";

// The git authorize hook verifies PATs against D1 (SPEC-0002), so the
// top-level worker tests need the schema applied like the auth module's own.
beforeAll(async () => {
  await applyAuthD1Migrations();
});

// The gitHttpGate suites below seed real repositories/users rows; the D1
// state persists across tests within this file, so every test starts from a
// clean registry. The engine Registry DO keeps its rows (it is not D1) —
// stale registered names only ever make the engine serve an empty advert.
beforeEach(async () => {
  await resetAuthTables();
  await env.DB.prepare("DELETE FROM repositories").run();
});

describe("GET /healthz", () => {
  it("responds with 200 and { ok: true }", async () => {
    const response = await SELF.fetch("https://example.com/healthz");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("git engine mount (SPEC-0001 M1)", () => {
  const basic = (user: string, pass: string) =>
    `Basic ${btoa(`${user}:${pass}`)}`;

  it("keeps non-repo paths off the engine (Hono 404)", async () => {
    const response = await SELF.fetch("https://example.com/not-a-repo-route");
    expect(response.status).toBe(404);
  });

  it("challenges anonymous push adverts on a fresh repo with 401 Basic", async () => {
    const response = await SELF.fetch(
      "https://example.com/demo/fresh-anon.git/info/refs?service=git-receive-pack"
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic");
  });

  it("rejects wrong credentials with 401", async () => {
    const response = await SELF.fetch(
      "https://example.com/demo/fresh-wrong.git/info/refs?service=git-receive-pack",
      { headers: { authorization: basic("x", "wrong") } }
    );

    expect(response.status).toBe(401);
  });

  it("404s public reads of unknown repositories", async () => {
    const response = await SELF.fetch(
      "https://example.com/demo/nope.git/info/refs?service=git-upload-pack"
    );

    expect(response.status).toBe(404);
  });

  // The authenticated advert proves the whole chain: Hono delegation ->
  // engine authorize (GIT_TOKEN from .dev.vars) -> RepoCell DO advertisement.
  // Needs the dev vars present (copy .dev.vars.example); skipped otherwise.
  it.skipIf(!env.GIT_TOKEN)(
    "advertises receive-pack capabilities (pkt-line) for a fresh repo",
    async () => {
      const response = await SELF.fetch(
        "https://example.com/demo/fresh.git/info/refs?service=git-receive-pack",
        { headers: { authorization: basic("x", env.GIT_TOKEN) } }
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/x-git-receive-pack-advertisement"
      );
      const body = new TextDecoder().decode(await response.arrayBuffer());
      expect(body).toContain("# service=git-receive-pack");
      expect(body).toContain("capabilities^{}");
    }
  );
});

// --- SPEC-0003 M1: gitHttpGate ------------------------------------------------

/** Register a repository in the engine's Registry DO so gate-allowed reads
 *  reach a servable advertisement (the D1 row alone does not register the
 *  engine-side repo — lifecycle wiring is SPEC-0003 M2). */
async function seedEngineRegistry(name: string): Promise<void> {
  await env.REGISTRY.getByName("registry").upsert(name, Date.now());
}

interface SeededRepo {
  ownerNamespace: string;
  slug: string;
  visibility: "public" | "private";
}

async function seedRepo(repo: SeededRepo): Promise<void> {
  const id = crypto.randomUUID();
  await drizzle(env.DB)
    .insert(repositories)
    .values({
      id,
      storageKey: `k_${id}`,
      ownerNamespace: repo.ownerNamespace,
      slug: repo.slug,
      visibility: repo.visibility,
    })
    .run();
}

/** Fixture tokens shared by the matrix cases. */
interface AclTokens {
  aliceWrite: string;
  aliceRead: string;
  alicePublicOnly: string;
  bobWrite: string;
  bobRead: string;
  bobOtherScope: string;
  carolWrite: string;
}

/** Fixture users/tokens/repositories shared by the matrix cases. */
async function seedAclFixtures(): Promise<AclTokens> {
  const alice = await seedVerifiedUser({ username: "Alice" });
  const bob = await seedVerifiedUser({ username: "Bob" });
  const carol = await seedVerifiedUser({ username: "Carol", status: "prohibited" });

  await seedRepo({ ownerNamespace: "alice", slug: "public", visibility: "public" });
  await seedRepo({ ownerNamespace: "alice", slug: "private", visibility: "private" });
  // Orphaned row: repositories row without a users row → exists but invisible.
  await seedRepo({ ownerNamespace: "ghost", slug: "orphan", visibility: "public" });

  const mint = async (user: { id: number }, name: string, scopes: string) =>
    (await mintFor(user.id, name, scopes)).plaintext;

  return {
    aliceWrite: await mint(alice, "alice-write", "write:repository"),
    aliceRead: await mint(alice, "alice-read", "read:repository"),
    alicePublicOnly: await mint(alice, "alice-public-only", "write:repository,public-only"),
    bobWrite: await mint(bob, "bob-write", "write:repository"),
    bobRead: await mint(bob, "bob-read", "read:repository"),
    bobOtherScope: await mint(bob, "bob-other-scope", "write:user"),
    carolWrite: await mint(carol, "carol-write", "write:repository"),
  };
}

describe("gitHttpGate ACL matrix (SPEC-0003 §2.4 rows 1-14)", () => {
  const refs = (service: "git-upload-pack" | "git-receive-pack") =>
    `https://example.com/alice/public.git/info/refs?service=${service}`;
  const privateRefs = refs("git-upload-pack").replace("public", "private");

  interface MatrixCase {
    /** Matrix row / edge label. */
    label: string;
    url: string;
    method?: "GET" | "POST";
    authorization?: (t: AclTokens) => string;
    headers?: Record<string, string>;
    expectStatus: number;
    expectBody?: string;
    /** 401 rows carry the challenge; 403/404 rows must not. */
    expectChallenge: boolean;
  }

  const RECEIVE_CT = "application/x-git-receive-pack-request";

  const cases: MatrixCase[] = [
    // Row 1: anonymous fetch of a public repo under a public owner.
    {
      label: "row 1: anonymous fetch of public repo/owner is allowed",
      url: refs("git-upload-pack"),
      expectStatus: 200,
      expectChallenge: false,
    },
    // Row 2: anonymous fetch of a private repo → 401 + Basic challenge.
    {
      label: "row 2: anonymous fetch of private repo challenges with 401",
      url: privateRefs,
      expectStatus: 401,
      expectChallenge: true,
    },
    // Row 2 variant: owner users row missing → invisible → challenge (never a leak).
    {
      label: "row 2: anonymous fetch with orphaned owner row challenges",
      url: "https://example.com/ghost/orphan.git/info/refs?service=git-upload-pack",
      expectStatus: 401,
      expectChallenge: true,
    },
    // Row 3: anonymous push challenges even on a public repo.
    {
      label: "row 3: anonymous push advert on public repo challenges",
      url: refs("git-receive-pack"),
      expectStatus: 401,
      expectChallenge: true,
    },
    // Row 7: authenticated, token lacks the repository scope → plain 403.
    {
      label: "row 7: token without repository scope fetches → plain 403",
      url: refs("git-upload-pack"),
      authorization: (t) => basicTokenHeader(t.bobOtherScope),
      expectStatus: 403,
      expectBody: "Forbidden\n",
      expectChallenge: false,
    },
    {
      label: "row 7: read-scope token pushing → plain 403",
      url: "https://example.com/alice/public.git/git-receive-pack",
      method: "POST",
      authorization: (t) => basicTokenHeader(t.aliceRead),
      headers: { "content-type": RECEIVE_CT },
      expectStatus: 403,
      expectBody: "Forbidden\n",
      expectChallenge: false,
    },
    // Row 8: valid scope, repo visible, no write grant → 404.
    {
      label: "row 8: non-owner push to public repo → 404 Repository not found",
      url: "https://example.com/alice/public.git/git-receive-pack",
      method: "POST",
      authorization: (t) => basicTokenHeader(t.bobWrite),
      headers: { "content-type": RECEIVE_CT },
      expectStatus: 404,
      expectBody: "Repository not found",
      expectChallenge: false,
    },
    // Row 9: valid scope, no read grant (private repo, not collaborator) → 404.
    {
      label: "row 9: non-owner fetch of private repo → 404 Repository not found",
      url: privateRefs,
      authorization: (t) => basicTokenHeader(t.bobRead),
      expectStatus: 404,
      expectBody: "Repository not found",
      expectChallenge: false,
    },
    {
      label: "row 9: non-owner push to private repo → 404 Repository not found",
      url: "https://example.com/alice/private.git/git-receive-pack",
      method: "POST",
      authorization: (t) => basicTokenHeader(t.bobWrite),
      headers: { "content-type": RECEIVE_CT },
      expectStatus: 404,
      expectBody: "Repository not found",
      expectChallenge: false,
    },
    // Row 11: disabled doer account → 403 "Your account is disabled."
    {
      label: "row 11: prohibited account fetch → 403 account disabled",
      url: refs("git-upload-pack"),
      authorization: (t) => basicTokenHeader(t.carolWrite),
      expectStatus: 403,
      expectBody: "Your account is disabled.",
      expectChallenge: false,
    },
    {
      label: "row 11: prohibited account push → 403 account disabled",
      url: "https://example.com/alice/public.git/git-receive-pack",
      method: "POST",
      authorization: (t) => basicTokenHeader(t.carolWrite),
      headers: { "content-type": RECEIVE_CT },
      expectStatus: 403,
      expectBody: "Your account is disabled.",
      expectChallenge: false,
    },
    // Edge 4.14: bad token → 401 challenge (identity not established).
    {
      label: "edge 4.14: unknown token → 401 challenge",
      url: refs("git-upload-pack"),
      authorization: () => basicHeader("alice", "cfg_00000000_DEADBEEF234567890123456789ABCDEFGHJKLMNP"),
      expectStatus: 401,
      expectChallenge: true,
    },
    // Edge 4.1: malformed Authorization parses as no credentials → anonymous.
    {
      label: "edge 4.1: malformed Authorization acts anonymous",
      url: privateRefs,
      authorization: () => "Basic !!!not-base64!!!",
      expectStatus: 401,
      expectChallenge: true,
    },
  ];

  it.each(cases.map((c) => [c.label, c] as const))("%s", async (_label, matrixCase) => {
    const tokens = await seedAclFixtures();
    if (matrixCase.expectStatus === 200) await seedEngineRegistry("alice/public");

    const response = await SELF.fetch(matrixCase.url, {
      method: matrixCase.method ?? "GET",
      headers: {
        ...(matrixCase.authorization ? { authorization: matrixCase.authorization(tokens) } : {}),
        ...(matrixCase.headers ?? {}),
      },
      ...(matrixCase.method === "POST" ? { body: "0000" } : {}),
    });

    expect(response.status).toBe(matrixCase.expectStatus);
    if (matrixCase.expectChallenge) {
      expect(response.headers.get("www-authenticate")).toBe('Basic realm="Gitea"');
    } else {
      expect(response.headers.get("www-authenticate")).toBeNull();
    }
    if (matrixCase.expectBody !== undefined) {
      expect(await response.text()).toContain(matrixCase.expectBody);
    }
  });

  it("row 1 end-to-end shape: 200 advertisement with the upstream content type", async () => {
    await seedAclFixtures();
    await seedEngineRegistry("alice/public");

    const response = await SELF.fetch(refs("git-upload-pack"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    const body = new TextDecoder().decode(await response.arrayBuffer());
    expect(body).toContain("# service=git-upload-pack");
  });

  // Row 4/5 (anonymous unit-read on a private repo) need the `repo_units`
  // table — SPEC-0003 M2 schema. Row 6 (require-sign-in-view) needs the
  // instance setting; row 10 (archived push) needs `repositories.is_archived`;
  // row 12 (2FA Basic password) has no 2FA enrollment surface yet (SPEC-0002
  // §4.6.10); row 13 (301 rename redirect) needs `repo_redirects`. All land
  // with the M2/M3 lifecycle milestones and extend this table.

  it("owner push with write scope is allowed through to the engine", async () => {
    const tokens = await seedAclFixtures();

    const response = await SELF.fetch("https://example.com/alice/private.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(tokens.aliceWrite), "content-type": RECEIVE_CT },
      body: "0000",
    });

    // The gate allows; the engine answers the (command-less) receive itself.
    expect(response.status).toBe(200);
  });

  it("resolves repositories case-insensitively (§4.5) without a redirect", async () => {
    const tokens = await seedAclFixtures();
    await seedEngineRegistry("ALICE/Public");

    const response = await SELF.fetch(
      "https://example.com/ALICE/Public/info/refs?service=git-upload-pack",
      { headers: { authorization: basicTokenHeader(tokens.aliceWrite) } }
    );

    expect(response.status).toBe(200);
  });

  it("write:repository implies read (owner fetches own public repo)", async () => {
    const tokens = await seedAclFixtures();
    await seedEngineRegistry("alice/public");

    const response = await SELF.fetch(refs("git-upload-pack"), {
      headers: { authorization: basicTokenHeader(tokens.aliceWrite) },
    });

    expect(response.status).toBe(200);
  });

  it("public-only token is 404-masked on the owner's own private repo (SPEC-0002 §4.1)", async () => {
    const tokens = await seedAclFixtures();

    const response = await SELF.fetch(privateRefs, {
      headers: { authorization: basicTokenHeader(tokens.alicePublicOnly) },
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Repository not found");
  });

  it("drops an invalid Git-Protocol header instead of failing (§2.3)", async () => {
    const tokens = await seedAclFixtures();
    await seedEngineRegistry("alice/public");

    const response = await SELF.fetch(refs("git-upload-pack"), {
      headers: {
        authorization: basicTokenHeader(tokens.aliceWrite),
        "git-protocol": "not a valid protocol header!!",
      },
    });

    expect(response.status).toBe(200);
  });

  it("answers 400 for info/refs without a service (dumb-HTTP divergence, §2.2)", async () => {
    await seedAclFixtures();

    const response = await SELF.fetch("https://example.com/alice/public.git/info/refs");

    expect(response.status).toBe(400);
  });

  it("answers 400 for an unknown info/refs service (§2.1 item 2)", async () => {
    await seedAclFixtures();

    const response = await SELF.fetch(
      "https://example.com/alice/public.git/info/refs?service=git-upload-archive"
    );

    expect(response.status).toBe(400);
  });

  it("answers 400 for an RPC POST with the wrong Content-Type (§2.3)", async () => {
    await seedAclFixtures();

    const response = await SELF.fetch("https://example.com/alice/public.git/git-receive-pack", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "0000",
    });

    expect(response.status).toBe(400);
  });

  it("rate-limits repeated bad credentials to a plain 403 without a challenge (SPEC-0002 §2.7)", async () => {
    await seedAclFixtures();
    const ip = "unknown"; // SELF.fetch carries no CF-Connecting-IP
    const limit = 20 + (fnv1a32(ip) % (Math.ceil(20 * 0.2) + 1));
    await drizzle(env.DB)
      .insert(authFailures)
      .values({ ip, windowStart: new Date(), count: limit })
      .run();

    const response = await SELF.fetch(privateRefs, {
      headers: { authorization: basicHeader("alice", "cfg_00000000_DEADBEEF234567890123456789012345678") },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(response.headers.get("retry-after")).toBeDefined();
  });
});

describe("gitHttpGate ?go-get=1 short-circuit (row 14)", () => {
  it("serves the go-import meta for a nonexistent repo without auth", async () => {
    const response = await SELF.fetch("https://example.com/nobody/nothing.git/info/refs?go-get=1");

    expect(response.status).toBe(200);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(await response.text()).toBe(
      '<meta name="go-import" content="example.com/nobody/nothing git https://example.com/nobody/nothing.git">'
    );
  });

  it("serves the meta for a private repo anonymously (auth is ignored)", async () => {
    await seedAclFixtures();

    const response = await SELF.fetch("https://example.com/alice/private.git/info/refs?go-get=1");

    expect(response.status).toBe(200);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(await response.text()).toContain("example.com/alice/private git https://example.com/alice/private.git");
  });

  it("wins over an unknown service (upstream order: go-get runs first)", async () => {
    const response = await SELF.fetch(
      "https://example.com/nobody/nothing.git/info/refs?service=bogus&go-get=1"
    );

    expect(response.status).toBe(200);
  });
});

describe("gitHttpGate synthetic HEAD endpoint (route table row 4)", () => {
  it("serves the unborn HEAD of a public repo with the no-cache triple", async () => {
    await seedAclFixtures();

    const response = await SELF.fetch("https://example.com/alice/public.git/HEAD");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(response.headers.get("expires")).toBe("Fri, 01 Jan 1980 00:00:00 GMT");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("cache-control")).toBe("no-cache, max-age=0, must-revalidate");
    // Empty repo: the DO has no resolvable HEAD → the instance default.
    expect(await response.text()).toBe("ref: refs/heads/main\n");
  });

  it("401-challenges anonymous HEAD on a private repo", async () => {
    await seedAclFixtures();

    const response = await SELF.fetch("https://example.com/alice/private.git/HEAD");

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="Gitea"');
  });

  it("404-masks a non-owner's HEAD on a private repo", async () => {
    const tokens = await seedAclFixtures();

    const response = await SELF.fetch("https://example.com/alice/private.git/HEAD", {
      headers: { authorization: basicTokenHeader(tokens.bobRead) },
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Repository not found");
  });

  it("passes HEAD through for repos missing from D1 (engine keeps 404ing)", async () => {
    const response = await SELF.fetch("https://example.com/demo/absent.git/HEAD");

    expect(response.status).toBe(404);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });
});

describe("gitHttpGate gzip request bodies (§2.3/§4.6)", () => {
  const encoder = new TextEncoder();

  const bodyOf = (data: Uint8Array): ReadableStream<Uint8Array> =>
    asByteStream(new Response(data).body!);

  async function gzipBytes(data: Uint8Array): Promise<Uint8Array> {
    const stream = bodyOf(data).pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  it("round-trips a gzipped body through the capped decompressor", async () => {
    const payload = encoder.encode("hello gzipped git world".repeat(10));
    const decoded = await new Response(gunzipCapped(bodyOf(await gzipBytes(payload)))).arrayBuffer();

    expect(new Uint8Array(decoded)).toEqual(payload);
  });

  it("rejects malformed gzip at the first chunk", async () => {
    const stream = gunzipCapped(bodyOf(encoder.encode("definitely not gzip")));
    await expect(withVerifiedStart(stream)).rejects.toThrow();
  });

  it("aborts bodies that decompress past the cap", async () => {
    const bigGz = await gzipBytes(new Uint8Array(4096));
    // The cap error surfaces either at the verified-start read or later in
    // the stream, depending on chunk boundaries — consume() covers both.
    const consume = async () => {
      const verified = await withVerifiedStart(gunzipCapped(bodyOf(bigGz), 16));
      await new Response(verified).arrayBuffer();
    };
    await expect(consume()).rejects.toThrow(/cap/);
  });

  it("answers 400 before the engine for a malformed gzip RPC body", async () => {
    await seedAclFixtures();

    const response = await SELF.fetch("https://example.com/alice/public.git/git-upload-pack", {
      method: "POST",
      headers: {
        "content-type": "application/x-git-upload-pack-request",
        "content-encoding": "gzip",
      },
      body: "0000-not-actually-gzip",
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  it("forwards a valid gzip RPC body to the engine (not a 400)", async () => {
    const tokens = await seedAclFixtures();
    const gz = await gzipBytes(encoder.encode("0000"));

    const response = await SELF.fetch("https://example.com/alice/public.git/git-receive-pack", {
      method: "POST",
      headers: {
        authorization: basicTokenHeader(tokens.aliceWrite),
        "content-type": "application/x-git-receive-pack-request",
        "content-encoding": "gzip",
      },
      body: gz,
    });

    expect(response.status).toBe(200);
  });
});

describe("gitHttpGate transitional passthrough (D1 row missing, TODO SPEC-0003 M3)", () => {
  it.skipIf(!env.GIT_TOKEN)(
    "lets the engine authorize a push advert for an unregistered repo (GIT_TOKEN)",
    async () => {
      const response = await SELF.fetch(
        "https://example.com/demo/unregistered.git/info/refs?service=git-receive-pack",
        { headers: { authorization: `Basic ${btoa(`x:${env.GIT_TOKEN}`)}` } }
      );

      // The gate must NOT 401/403 on the missing D1 row: the engine hook decides.
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/x-git-receive-pack-advertisement");
    }
  );

  it("keeps the engine's 404 for anonymous reads of unregistered repos (not a 401)", async () => {
    const response = await SELF.fetch(
      "https://example.com/demo/absent.git/info/refs?service=git-upload-pack"
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  it("passes non-git-route repo paths through untouched (engine JSON API)", async () => {
    const response = await SELF.fetch("https://example.com/demo/absent/api/refs");

    // Engine headless JSON API 404 shape, unchanged by the gate.
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
