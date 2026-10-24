/**
 * `gitHttpGate` — the SPEC-0003 §2.1 adapter pipeline:
 *
 *   parse (.git normalize, service/op) → go-get short-circuit → resolve repo
 *   (D1) → authorize (SPEC-0002 + ACL matrix, acl.ts) → invoke engine →
 *   stream response.
 *
 * Transitional M1.5 split (keeps the e2e suite green while repo lifecycle has
 * not landed):
 * - D1 row MISSING: the request passes through to the engine untouched —
 *   exactly the pre-gate behavior, with the engine `authorize` hook deciding
 *   (GIT_TOKEN dev fallback, PAT verify). TODO(SPEC-0003 M3): remove the
 *   passthrough once every repo has a D1 row (lifecycle owns creation).
 * - D1 row EXISTS: the ACL matrix (§2.4 rows 1-14) decides here; the engine
 *   is invoked only on allow, and its hook waves the request through via the
 *   gate-cleared mark below.
 *
 * The gate only claims the four §2.1 git-protocol routes; every other
 * repository-scoped path (engine JSON API, admin endpoints, UI-404s) passes
 * through verbatim, so the engine keeps owning them.
 */

import type { DurableGitHandler } from "@cf-gitea/git-engine";

import { authorizeGitHttp, resolveRepository } from "./acl";
import { asByteStream, gunzipCapped, withVerifiedStart } from "./gzip";
import {
  DEFAULT_BRANCH,
  SAFE_GIT_PROTOCOL_HEADER,
  infoRefsOp,
  isGzipEncoded,
  parseGitHttpRoute,
  rpcRequestContentType,
  type GitHttpRoute,
} from "./parse";
import {
  bareBadRequest,
  goGetMeta,
  headFile,
  repositoryNotFound,
  routeOp,
} from "./respond";

/**
 * Requests the gate has already authorized. The engine `authorize` hook
 * (src/git-http/authorize.ts) consults this set instead of re-deciding.
 * Keyed by object identity — a client cannot forge membership, and entries
 * are garbage-collected with their request objects. This is per-request
 * state passed explicitly (AGENTS.md), not shared mutable request state.
 */
const gateCleared = new WeakSet<Request>();

export function isGateCleared(req: Request): boolean {
  return gateCleared.has(req);
}

export async function gitHttpGate(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  engine: DurableGitHandler<Env>,
): Promise<Response> {
  const url = new URL(req.url);
  const route = parseGitHttpRoute(url.pathname);
  // Not one of the four git routes (or malformed): the engine's paths.
  if (route === null) return engine.fetch(req, env, ctx);

  // §2.1 item 1: `?go-get=1` short-circuits before auth and regardless of
  // existence/access (go-get ignores .netrc, so the meta needs no auth).
  if (route.kind === "info-refs" && url.searchParams.get("go-get") === "1") {
    return goGetMeta(url, route.owner, route.repo);
  }

  // §4.4: `*.wiki` URLs are excluded until a wiki SPEC exists — plain 404.
  if (route.repo.endsWith(".wiki")) return repositoryNotFound();

  // Route table row 4: the synthetic HEAD file (a read).
  if (route.kind === "head") {
    if (req.method !== "GET") return engine.fetch(req, env, ctx);
    const resolved = await resolveRepository(env.DB, route.owner.toLowerCase(), route.repo.toLowerCase());
    if (resolved === null) return engine.fetch(req, env, ctx); // TODO(SPEC-0003 M3)
    const decision = await authorizeGitHttp({
      req,
      env,
      waitUntil: (p) => ctx.waitUntil(p),
      op: "read",
      repo: resolved.repo,
      owner: resolved.owner,
    });
    if (decision !== true) return decision;
    return serveHead(env, route);
  }

  // info/refs + RPC data plane.
  const resolved = await resolveRepository(env.DB, route.owner.toLowerCase(), route.repo.toLowerCase());
  if (resolved === null) {
    // TODO(SPEC-0003 M3): D1 row missing — transitional passthrough so repos
    // that predate the registry (and the e2e suite) behave exactly as before
    // the gate existed. The engine authorize hook decides.
    return engine.fetch(req, env, ctx);
  }

  // §2.1 item 2: service parse before auth, like upstream's httpBase switch
  // (unknown/missing service → bare 400; the dumb-HTTP listing of §2.2's
  // documented divergence 400s here too).
  let op: "read" | "write";
  if (route.kind === "info-refs") {
    const refsOp = infoRefsOp(url);
    if (refsOp === null) return bareBadRequest();
    op = refsOp;
  } else {
    op = routeOp(route.kind);
    // §2.3: RPC POSTs must carry the exact request Content-Type.
    if (req.method === "POST" && req.headers.get("content-type") !== rpcRequestContentType(route.kind)) {
      return bareBadRequest();
    }
  }

  // §2.1 items 3-4: SPEC-0002 auth + the §2.4 ACL matrix.
  const decision = await authorizeGitHttp({
    req,
    env,
    waitUntil: (p) => ctx.waitUntil(p),
    op,
    repo: resolved.repo,
    owner: resolved.owner,
  });
  if (decision !== true) return decision;

  // §2.1 item 5: invoke the engine and stream its response. The engine hook
  // sees the gate-cleared mark and waves the request through.
  let forwarded: Request;
  try {
    forwarded = await prepareEngineRequest(req, url);
  } catch {
    // Malformed gzip surfaces on the first decompressed chunk — answer the
    // upstream bare 400 before any engine/storage touch (§2.3, §4.6).
    return bareBadRequest();
  }
  gateCleared.add(forwarded);
  return engine.fetch(forwarded, env, ctx);
}

/**
 * Synthetic HEAD file (§2.1 row 4): `ref: refs/heads/<head>` from the
 * engine's public `RepoCell.listRefs()` RPC — head is the resolved HEAD ref;
 * an empty/unborn repo falls back to the instance default branch.
 *
 * The DO is addressed by the engine's namespaced repo name (request casing),
 * which is where the engine stores this URL's data today. TODO(SPEC-0003 M2):
 * DO addressing switches to `storage_key` when lifecycle lands; the D1
 * `default_branch` column then replaces the DEFAULT_BRANCH fallback.
 */
async function serveHead(env: Env, route: GitHttpRoute): Promise<Response> {
  let head: string | null = null;
  try {
    head = (await env.REPO.getByName(`${route.owner}/${route.repo}`).listRefs()).head;
  } catch {
    // Unreadable storage must not break the unborn-HEAD contract (§4.13);
    // fall through to the default branch.
  }
  return headFile(head ?? `refs/heads/${DEFAULT_BRANCH}`);
}

/**
 * Build the request handed to the engine. Identity fast path: when nothing
 * needs sanitizing the original request object flows through untouched, so
 * push/fetch bodies stream into the storage DO without re-wrapping.
 * Otherwise: an invalid `Git-Protocol` header is dropped (§2.3) and gzip
 * bodies are decompressed with the §4.6 cap (the engine then sees a plain
 * body, so its own Content-Length/encoding assumptions stay valid).
 */
async function prepareEngineRequest(req: Request, url: URL): Promise<Request> {
  const gitProtocol = req.headers.get("git-protocol");
  const badProtocol = gitProtocol !== null && !SAFE_GIT_PROTOCOL_HEADER.test(gitProtocol);
  const gzip = isGzipEncoded(req);

  if (!badProtocol && !gzip) return req;

  const headers = new Headers(req.headers);
  if (badProtocol) headers.delete("git-protocol");
  const methodHasBody = req.method !== "GET" && req.method !== "HEAD";
  const streams = methodHasBody && req.body !== null;
  let body: BodyInit | null = null;
  if (streams) {
    if (gzip) {
      headers.delete("content-encoding");
      headers.delete("content-length");
      // Verify the stream starts before handing it to the engine, so a
      // malformed gzip body maps to the caller's 400 instead of a broken
      // engine read; the cap aborts later in the stream as a failed body.
      body = await withVerifiedStart(gunzipCapped(asByteStream(req.body)));
    } else {
      body = req.body;
    }
  }
  return new Request(url, {
    method: req.method,
    headers,
    body,
    // stream passthrough (AGENTS.md: never buffer an unbounded body)
    ...(streams ? { duplex: "half" as const } : {}),
  });
}
