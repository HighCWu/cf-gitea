/**
 * `gitHttpGate` — the SPEC-0003 §2.1 adapter pipeline:
 *
 *   parse (.git normalize, service/op) → go-get short-circuit → resolve repo
 *   (D1, then repo_redirects) → authorize (SPEC-0002 + ACL matrix, acl.ts) →
 *   push-create intercept (rows 15-20, src/repos/service.ts) → invoke engine
 *   → stream response.
 *
 * Repository resolution split (SPEC-0003 M2/M3):
 * - D1 row EXISTS: the ACL matrix (§2.4 rows 1-14) decides here; the engine
 *   is invoked only on allow, and its hook waves the request through via the
 *   gate-cleared mark below.
 * - D1 row MISSING, redirect row EXISTS: `301` to the canonical path before
 *   any auth challenge (row 13, §2.5.3).
 * - D1 row MISSING, no redirect: writes get the push-create treatment —
 *   anonymous challenges (row 15), a SPEC-0002-verifiable credential runs the
 *   rows 16-20 matrix (probe → dummy advertisement, POST → create via
 *   RepoService with status='creating'), and every other credential passes
 *   through to the engine untouched. Reads and the HEAD file also pass
 *   through. That residual passthrough is DELIBERATE and stays: the engine's
 *   own create-by-push (GIT_TOKEN auth) is the transitional population — the
 *   e2e suite's repositories live there (no D1 rows, `devtoken` auth) — and
 *   TODO(SPEC-0003 ENGINE-WAVE) removes it only when every engine repo is
 *   D1-backed (registry sync alone is not sufficient: engine-known-but-
 *   D1-unknown repos must keep working until their creation path owns rows).
 *
 * The gate only claims the four §2.1 git-protocol routes; every other
 * repository-scoped path (engine JSON API, admin endpoints, UI-404s) passes
 * through verbatim, so the engine keeps owning them.
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DurableGitHandler } from "@cf-gitea/git-engine";

import {
  authorizeGitHttp,
  codeUnitAnonymousRead,
  requestCredential,
  resolveRepository,
  userByUsernameLower,
} from "./acl";
import { asByteStream, gunzipCapped, withVerifiedStart } from "./gzip";
import {
  SAFE_GIT_PROTOCOL_HEADER,
  infoRefsOp,
  isGzipEncoded,
  parseGitHttpRoute,
  rpcRequestContentType,
  type GitHttpRoute,
} from "./parse";
import {
  accountDisabled,
  bareBadRequest,
  basicChallenge,
  dummyAdvertisement,
  goGetMeta,
  headFile,
  redirectPermanent,
  repositoryNotFound,
  routeOp,
  scopeForbidden,
} from "./respond";
import { ScopeSet } from "../auth/scopes";
import { TokenService } from "../auth/token-service";
import { handleLfsGateBranch, parseLfsRoute } from "../lfs/router";
import { repoCounters, repoUnits, repositories } from "../db/schema";
import { RepoNameCollisionError, RepoService, lookupRedirect } from "../repos/service";

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

/** Mark a Worker-constructed request as gate-authorized (trusted internal
 *  calls: the push-create DO warm-up, the delete tombstone in src/repos). */
export function markGateCleared(req: Request): void {
  gateCleared.add(req);
}

export async function gitHttpGate(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  engine: DurableGitHandler<Env>,
): Promise<Response> {
  const url = new URL(req.url);
  const route = parseGitHttpRoute(url.pathname);
  // Not one of the four git routes (or malformed): first the SPEC-0006 §2.1
  // LFS family (`/:owner/:repo(.git)?/info/lfs/*`) — intercepted BEFORE
  // engine delegation, with repos resolved through the same D1 pipeline
  // below; a D1-missing repo falls through to the engine exactly as before
  // this branch existed (the transitional passthrough, byte-identical so the
  // e2e suite keeps working). Everything else is the engine's paths.
  if (route === null) {
    const lfsRoute = parseLfsRoute(url.pathname, req.method);
    if (lfsRoute !== null) return handleLfsGateBranch(req, env, ctx, engine, lfsRoute);
    return engine.fetch(req, env, ctx);
  }

  // §2.1 item 1: `?go-get=1` short-circuits before auth and regardless of
  // existence/access (go-get ignores .netrc, so the meta needs no auth).
  if (route.kind === "info-refs" && url.searchParams.get("go-get") === "1") {
    return goGetMeta(url, route.owner, route.repo);
  }

  // §4.4: `*.wiki` URLs are excluded until a wiki SPEC exists — plain 404.
  if (route.repo.endsWith(".wiki")) return repositoryNotFound();

  const ownerLower = route.owner.toLowerCase();
  const repoLower = route.repo.toLowerCase();
  const resolved = await resolveRepository(env.DB, ownerLower, repoLower);

  if (resolved === null) {
    // Row 13: a renamed/transferred repo's old URL 301s to the canonical
    // path BEFORE any auth challenge (§2.5.3; git clients must see the
    // redirect before a Basic prompt).
    const redirect = await lookupRedirect(env.DB, ownerLower, repoLower);
    if (redirect !== null) return redirectPermanent(req.url, redirect.ownerNamespace, redirect.slug);
    return handleUnknownRepository(req, env, ctx, engine, url, route, ownerLower, repoLower);
  }

  // Route table row 4: the synthetic HEAD file (a read).
  if (route.kind === "head") {
    if (req.method !== "GET") return engine.fetch(req, env, ctx);
    const decision = await authorizeGitHttp({
      req,
      env,
      waitUntil: (p) => ctx.waitUntil(p),
      op: "read",
      repo: resolved.repo,
      owner: resolved.owner,
      ownerVisibility: resolved.ownerVisibility,
      unitAnonymousRead: false,
    });
    if (decision !== true) return decision;
    return serveHead(env, route, resolved.repo.defaultBranch);
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

  // Rows 4/5: only a private repo can carry the code unit's anonymous-read
  // grant (a public repo is anonymous-readable anyway — row 1).
  const unitAnonymousRead =
    op === "read" && resolved.repo.visibility === "private"
      ? await codeUnitAnonymousRead(env.DB, resolved.repo.id)
      : false;

  // §2.1 items 3-4: SPEC-0002 auth + the §2.4 ACL matrix.
  const decision = await authorizeGitHttp({
    req,
    env,
    waitUntil: (p) => ctx.waitUntil(p),
    op,
    repo: resolved.repo,
    owner: resolved.owner,
    ownerVisibility: resolved.ownerVisibility,
    unitAnonymousRead,
  });
  if (decision !== true) return decision;

  // §2.1 item 5: invoke the engine and stream its response. The engine hook
  // sees the gate-cleared mark and waves the request through. Receive-pack
  // forwards carry the D1-minted immutable storage key (SPEC-0001a §3 Step
  // 3): the engine's beginReceive resolves R2 addressing from it instead of
  // the URL name, so renames/transfers never fork the storage namespace.
  return forwardToEngine(
    req,
    url,
    env,
    ctx,
    engine,
    route.kind === "receive-pack" ? resolved.repo.storageKey : undefined,
  );
}

/**
 * Everything below runs only when the repositories row is missing (and no
 * redirect claims the name): the push-create surface (§2.4 rows 15-20) plus
 * the deliberate transitional passthrough.
 */
async function handleUnknownRepository(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  engine: DurableGitHandler<Env>,
  url: URL,
  route: GitHttpRoute,
  ownerLower: string,
  repoLower: string,
): Promise<Response> {
  // Reads and the HEAD file pass through untouched (the engine's public-read
  // behavior for legacy repos is unchanged; §4.13's HEAD probe 404s there).
  if (route.kind === "head") return engine.fetch(req, env, ctx);
  // The receive-pack advert probe (GET info/refs?service=git-receive-pack) is
  // the push-create probe; every other read (upload-pack, unknown/missing
  // service) passes through — the engine answers its own 400 (§2.1 item 2).
  let probe = false;
  if (route.kind === "info-refs") {
    const refsOp = infoRefsOp(url);
    if (refsOp === null || refsOp === "read") return engine.fetch(req, env, ctx);
    probe = true;
  } else if (route.kind === "upload-pack") {
    return engine.fetch(req, env, ctx);
  }
  // Only receive-pack (advert probe or RPC) reaches the push-create surface.
  if (route.kind !== "receive-pack" && !probe) return engine.fetch(req, env, ctx);

  // Row 15: anonymous pushes never reach push-create logic — 401 + challenge.
  const credential = requestCredential(req);
  if (credential === null) return basicChallenge();

  // Verify SPEC-0002-style, WITHOUT limiter side effects: unverifiable
  // credentials (the engine's GIT_TOKEN population, incl. the e2e suite)
  // fall through to the engine hook, which owns their auth — identical to
  // the pre-gate behavior for this population.
  const verified = await new TokenService(env.DB).verify(credential).catch(() => null);
  if (verified === null) return engine.fetch(req, env, ctx);

  // Row 7 upstream of push-create: a verified token still needs write scope.
  const scope = ScopeSet.parseLenient(verified.token.scopes);
  if (!scope.has("write:repository")) return scopeForbidden();
  // Row 11: disabled/prohibited doers never push-create.
  if (verified.user.status === "prohibited") return accountDisabled();

  // Upstream ordering quirk (§2.4 note): the enable-flag checks run BEFORE
  // the dummy advertisement. cf-gitea defaults user push-create ON (§2.4
  // documented divergence — a headless forge's primary create path) and org
  // push-create awaits SPEC-0007, so the upstream "Push to create is not
  // enabled …" 403s (rows 18/20) have no live branch: the probe serves the
  // dummy empty advertisement (§2.2) and POST decides.
  if (probe) return dummyAdvertisement();

  // POST-time create. Own namespace by default; another namespace is site
  // admin only (upstream PushCreateRepo, services/repository/repository.go:
  // 87-96) and only when that owner exists and is active — everything else
  // 404s (rows 16/20; the org-grant allow branch of row 19 lands with
  // SPEC-0007 orgs).
  let owner = { id: verified.user.id, usernameLower: verified.user.usernameLower };
  if (ownerLower !== owner.usernameLower) {
    if (!verified.user.isAdmin) return repositoryNotFound();
    const ownerUser = await userByUsernameLower(env.DB, ownerLower);
    if (ownerUser === null || ownerUser.status !== "active") return repositoryNotFound();
    owner = { id: ownerUser.id, usernameLower: ownerUser.usernameLower };
  }

  const service = new RepoService(env.DB, { registry: env.REGISTRY.getByName("registry"), queue: env.REPO_TASKS });
  let created: Awaited<ReturnType<RepoService["create"]>>;
  try {
    // §2.5.2: create BEFORE reading the pack, status='creating' guards the
    // crash window (a half-usable repo must never look empty-but-ready);
    // push-created repos default private (upstream DefaultPushCreatePrivate).
    created = await service.create({ owner, name: route.repo, isPrivate: true, status: "creating" });
  } catch (error) {
    if (!(error instanceof RepoNameCollisionError)) throw error;
    // §4.1 concurrent create-by-push: the UNIQUE(owner, slug) insert decided;
    // the loser re-reads and proceeds with a normal receive against the
    // now-existing repo (its commands are zero-id creates; the DO lease
    // serializes the two finalizes).
    const raced = await resolveRepository(env.DB, ownerLower, repoLower);
    if (raced === null) return repositoryNotFound();
    const decision = await authorizeGitHttp({
      req,
      env,
      waitUntil: (p) => ctx.waitUntil(p),
      op: "write",
      repo: raced.repo,
      owner: raced.owner,
      ownerVisibility: raced.ownerVisibility,
      unitAnonymousRead: false,
    });
    if (decision !== true) return decision;
    // §2.5.2 finalize handshake (scheduled AFTER the response below — the
    // async settle body starts at call time, so scheduling it before the
    // forward would race the receive's finalize with an empty-DO listRefs).
    const response = await forwardToEngine(req, url, env, ctx, engine, raced.repo.storageKey);
    ctx.waitUntil(settleCreatingRepo(env, raced.repo.id, `${route.owner}/${route.repo}`));
    return response;
  }

  // The dummy advertisement bypassed the engine, so this POST is the repo
  // DO's first contact: warm it once so beginReceive persists meta.repo (the
  // engine's registry/destroy name) before the receive lease opens. R2
  // addressing itself comes from the forwarded x-storage-key (r_<id>) on the
  // receive below — the warm-up only needs to bind the cell's name.
  try {
    const warm = new Request(`${url.origin}/${route.owner}/${route.repo}/info/refs?service=git-receive-pack`);
    markGateCleared(warm);
    await engine.fetch(warm, env, ctx);
  } catch {
    // The receive below rebinds on its own path; a failed warm-up is not fatal.
  }

  // §2.5.2 finalize handshake: the engine's receivePack completes finalize
  // BEFORE its response returns, so once the response is observable the
  // outcome is settled — flip status/is_empty/default_branch on a committed
  // first push, or undo the create when no ref landed. Scheduled AFTER the
  // forward (the settle body starts at call time; scheduling it earlier would
  // race the finalize with an empty-DO listRefs). The forward carries the
  // fresh row's storage key: the very first receive already addresses R2 by
  // r_<id>, so no name-addressed prefix ever gets written for this repo.
  const response = await forwardToEngine(req, url, env, ctx, engine, created.storageKey);
  ctx.waitUntil(settleCreatingRepo(env, created.id, `${route.owner}/${route.repo}`));
  return response;
}

/**
 * Build the request handed to the engine. Identity fast path: when nothing
 * needs sanitizing the original request object flows through untouched, so
 * push/fetch bodies stream into the storage DO without re-wrapping.
 * Otherwise: an invalid `Git-Protocol` header is dropped (§2.3), gzip
 * bodies are decompressed with the §4.6 cap (the engine then sees a plain
 * body, so its own Content-Length/encoding assumptions stay valid), and a
 * D1 `storageKey` overrides the `x-storage-key` header (SPEC-0001a §3 Step
 * 3) — always re-wrapping in that case, so a client-supplied header can
 * never redirect a D1-backed repo's storage namespace.
 */
async function prepareEngineRequest(req: Request, url: URL, storageKey?: string): Promise<Request> {
  const gitProtocol = req.headers.get("git-protocol");
  const badProtocol = gitProtocol !== null && !SAFE_GIT_PROTOCOL_HEADER.test(gitProtocol);
  const gzip = isGzipEncoded(req);

  if (!badProtocol && !gzip && storageKey === undefined) return req;

  const headers = new Headers(req.headers);
  if (badProtocol) headers.delete("git-protocol");
  if (storageKey !== undefined) headers.set("x-storage-key", storageKey);
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

/** Gate-cleared engine invocation (the shared §2.1 item 5 tail). `storageKey`
 *  (D1 repositories.storage_key) rides the x-storage-key header on
 *  receive-pack forwards; every other route passes it unset and keeps the
 *  byte-identical passthrough (the D1-missing e2e population depends on it). */
async function forwardToEngine(
  req: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  engine: DurableGitHandler<Env>,
  storageKey?: string,
): Promise<Response> {
  let forwarded: Request;
  try {
    forwarded = await prepareEngineRequest(req, url, storageKey);
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
 * an empty/unborn repo falls back to the repo's D1 `default_branch` (the
 * push-create adoption writes it, §2.5.2).
 *
 * The DO is addressed by the engine's combined repo name (request casing),
 * which is where the engine stores this URL's data. TODO(SPEC-0003
 * ENGINE-WAVE): DO addressing switches to `storage_key` when the engine
 * accepts the override (see src/repos/service.ts).
 */
async function serveHead(env: Env, route: GitHttpRoute, defaultBranch: string): Promise<Response> {
  let head: string | null = null;
  try {
    head = (await env.REPO.getByName(`${route.owner}/${route.repo}`).listRefs()).head;
  } catch {
    // Unreadable storage must not break the unborn-HEAD contract (§4.13);
    // fall through to the default branch.
  }
  return headFile(head ?? `refs/heads/${defaultBranch}`);
}

/**
 * §2.5.2 push-create finalize handshake. Runs after the receive response is
 * observable (the engine commits refs before returning it):
 *
 * - refs/heads/* present → the create becomes real: `status='ready'`,
 *   `is_empty=false`, `default_branch=<first pushed branch>` — one
 *   conditional UPDATE (`status='creating' AND is_empty`), so a concurrent
 *   settle/undo can never double-apply. The DO's meta.head is aligned to the
 *   adopted branch via the engine's setHead RPC when it diverged (the
 *   engine's first-push adoption prefers main/master; see below); the
 *   synthetic HEAD endpoint falls back to D1 only for unborn repos.
 * - no branch ref (receive failed, client vanished, worker crashed
 *   mid-receive) → the row is deleted again, conditional on
 *   `status='creating' AND is_empty` — a half-usable repo never lingers.
 *
 * `refs_version` is deliberately not synced: the engine's finalize result
 * carries no version (engine gap), and the column is observability-only.
 */
export async function settleCreatingRepo(env: Env, repoId: string, engineRepo: string): Promise<void> {
  try {
    const db = drizzle(env.DB);
    const row = await db.select().from(repositories).where(eq(repositories.id, repoId)).get();
    if (row === undefined || row.status !== "creating" || !row.isEmpty) return;

    let refNames: string[] | null = null;
    let doHead: string | null = null;
    try {
      const listed = await env.REPO.getByName(engineRepo).listRefs();
      refNames = listed.refs.map((r) => r.name);
      doHead = listed.head;
    } catch {
      refNames = null; // unreadable/unwarming DO: treat as no refs
    }
    const branches = refNames?.filter((name) => name.startsWith("refs/heads/")) ?? [];

    if (refNames === null || branches.length === 0) {
      // Undo the create (§2.5.2: "deleted again, D1 conditional on
      // status='creating' AND is_empty"). The FK-bearing dependents the
      // create seeded (counters, units) go first, in the same batch.
      await db.batch([
        db.delete(repoCounters).where(eq(repoCounters.repoId, repoId)),
        db.delete(repoUnits).where(eq(repoUnits.repoId, repoId)),
        db
          .delete(repositories)
          .where(
            and(
              eq(repositories.id, repoId),
              eq(repositories.status, "creating"),
              eq(repositories.isEmpty, true),
            ),
          ),
      ]);
      return;
    }

    // First non-empty branch push adopts the default branch (§2.5.2,
    // upstream pushNewBranch). listRefs orders by name, so a single-branch
    // push — the dominant push-create shape — is exact; a multi-branch first
    // push adopts the alphabetically first branch (upstream adopts the pushed
    // branch; indistinguishable here without an engine hook).
    const firstBranch = branches[0]?.slice("refs/heads/".length) ?? row.defaultBranch;
    await db
      .update(repositories)
      .set({ status: "ready", isEmpty: false, defaultBranch: firstBranch, updatedAt: new Date() })
      .where(
        and(
          eq(repositories.id, repoId),
          eq(repositories.status, "creating"),
          eq(repositories.isEmpty, true),
        ),
      );

    // §2.5.2 (ENGINE-WAVE): the DO's meta.head must agree with the adopted
    // branch. The engine's own first-push adoption prefers main/master over
    // the alphabetically-first rule this settle applies, so a multi-branch
    // first push can diverge — setHead re-points it (idempotent CAS, bumps
    // refs_version). Skipped when they already agree, so the common
    // single-branch push pays no extra RPC.
    if (doHead !== null && doHead !== `refs/heads/${firstBranch}`) {
      try {
        const set = await env.REPO.getByName(engineRepo).setHead(firstBranch);
        if (set.tag !== "ok") {
          console.error(`[push-create] settle ${repoId}: setHead ${firstBranch} rejected: ${set.tag}`);
        }
      } catch (error) {
        console.error(
          `[push-create] settle ${repoId}: setHead ${firstBranch} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    console.error(
      `[push-create] settle ${repoId} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
