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
 *   through to the engine untouched. Reads pass through ONLY behind the
 *   registry-existence oracle (engineKnownRead: one fresh Registry DO RPC —
 *   the engine's own name resolution minus its per-isolate 20 s memo —
 *   answering the engine's verbatim 404 on a miss), so a DELETED repository's
 *   registry entry — removed synchronously by RepoService.deleteRepository —
 *   makes every later read 404 at t+0 instead of the engine memo resurrecting
 *   the tombstoned cell's refs for seconds (the REDEPLOY10/11 production
 *   probe's read-after-delete window). The HEAD file also passes through
 *   untouched (the headless engine 404s it pre-auth, no registry consult).
 *   The residual engine passthrough is DELIBERATE and stays for
 *   registry-known names: the engine's own create-by-push (GIT_TOKEN auth) is
 *   the transitional population — the e2e suite's repositories live there
 *   (no D1 rows, `devtoken` auth) — and TODO(SPEC-0003 ENGINE-WAVE) removes
 *   it only when every engine repo is D1-backed (registry sync alone is not
 *   sufficient: engine-known-but-D1-unknown repos must keep working until
 *   their creation path owns rows).
 *
 * The gate's claim (SPEC-0003 §2.1, as widened by the defense-in-depth wave):
 * the four git-protocol routes ALWAYS, plus the repository-scoped ENGINE
 * JSON/admin paths (`/{owner}/{repo}/api/*`, PUT `config`/`description`,
 * POST `gc`, DELETE of the repo root — parse.ts `parseEngineRoute`) for
 * D1-RESOLVED repositories. Rationale: the engine's own authorize hook
 * decides those paths from the registry's `priv` mirror, which is set
 * best-effort at create/visibility-flip time (RepoService.seedRepoExtras →
 * `registry.setConfig`); a failed or drifted sync would otherwise serve a
 * PRIVATE repo's JSON refs anonymously — or expose the engine's admin
 * mutations — while the four git routes correctly 401. D1 is the authority:
 * for a D1-resolved repo those engine paths run the same §2.4 matrix (JSON
 * reads through the read rows incl. the §3.1 code-unit anonymous-read grant;
 * admin shapes through the WRITE rows — the Worker API, not these HTTP
 * shapes, is the sanctioned admin channel: src/repos drives Registry/RepoDO
 * RPCs directly, and the import/mirror consumers call engine.fetch on
 * gate-cleared git-protocol requests that never traverse this gate).
 * For repositories WITHOUT a D1 row those paths still pass through verbatim
 * (the transitional population below), and every other repository-scoped
 * shape (pages, unknown tails) passes through for everyone: the engine
 * headless-404s it BEFORE its authorize hook, so nothing can leak there. The
 * LFS family (SPEC-0006 §2.1) is intercepted before all of this and is
 * unaffected.
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { ClassifiedPushCommand, DurableGitHandler, EngineCallOptions, PushValidator, PushVerdict, PusherIdentity } from "@cf-gitea/git-engine";

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
  parseEngineRoute,
  parseGitHttpRoute,
  rpcRequestContentType,
  type EngineRoute,
  type GitHttpRoute,
} from "./parse";
import {
  accountDisabled,
  bareBadRequest,
  basicChallenge,
  dummyAdvertisement,
  engineJsonRepoNotFound,
  engineRepoNotFound,
  goGetMeta,
  headFile,
  redirectPermanent,
  repositoryNotFound,
  routeOp,
  scopeForbidden,
} from "./respond";
import { findRepositoryById, type RepositoryRow } from "../api/services/repository";
import { ScopeSet } from "../auth/scopes";
import { TokenService } from "../auth/token-service";
import {
  canUserDelete,
  canUserForcePush,
  canUserPush,
  compileRuleName,
  listRepoRules,
  parseRuleConfig,
  principalAccessOfRow,
  ruleMatches,
  type ProtectedBranchConfig,
  type ProtectedBranchRow,
} from "../services/branch-protection";
import { isTagControlAllowed, listProtectedTags } from "../services/tag-protection";
import { OrgService } from "../services/orgs/orgs";
import { handleLfsGateBranch, parseLfsRoute } from "../lfs/router";
import { repoCounters, repoUnits, repositories, users } from "../db/schema";
import { deleteRepositoryViaEngineShape } from "../repos/purge";
import { RepoNameCollisionError, RepoService, lookupRedirect } from "../repos/service";
import { emitRepoEventInline, repositoryEventIdentity, repositoryEventPayload } from "../services/repo-events";
import { appOrigin } from "../services/webhooks-push";

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
    // §2.1 gate-scope widening: repository-scoped ENGINE JSON/admin paths for
    // D1-resolved repos run the ACL matrix here (defense-in-depth — see the
    // module header); D1-missing repos keep the verbatim passthrough.
    const engineRoute = parseEngineRoute(url.pathname, req.method);
    if (engineRoute !== null) return handleEnginePathBranch(req, url, env, ctx, engine, engineRoute);
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

  // Route table row 4: the synthetic HEAD file (a read) — the SAME rows 4/5
  // grant computation every other read runs below (the S7 alignment): the
  // code unit's anonymous-read grant on a private repo admits the anonymous
  // HEAD probe too. The old hardcoded `false` answered 401 for exactly the
  // repo shape the grant exists for, while /info/refs and the RPC reads on
  // the same repo allowed the same client.
  if (route.kind === "head") {
    if (req.method !== "GET") return engine.fetch(req, env, ctx);
    const unitAnonymousRead =
      resolved.repo.visibility === "private" ? await codeUnitAnonymousRead(env.DB, resolved.repo.id) : false;
    const decision = await authorizeGitHttp({
      req,
      env,
      waitUntil: (p) => ctx.waitUntil(p),
      op: "read",
      repo: resolved.repo,
      owner: resolved.owner,
      ownerVisibility: resolved.ownerVisibility,
      unitAnonymousRead,
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

  // SPEC-0009 §2.4 row 21 (upstream githttp.go:202-205): mirrors are
  // read-only — any authenticated, authorized PUSH onto an is_mirror repo
  // answers 403 with upstream's exact text (reads unaffected).
  if (op === "write" && resolved.repo.isMirror) {
    return new Response("mirror repository is read-only\n", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // Upstream parity (SPEC-0003 §2.4 — the blocked-pusher relation is NOT a
  // receive-pack gate): the blocked decline lives ONLY in upstream's agit
  // proc-receive hook (routers/private/hook_proc_receive.go:29-39), reached
  // solely by push-to-propose `refs/for/*` pushes — `hook_pre_receive` has
  // no blocked check at all, so a blocked user holding a write grant pushes
  // directly with parity. cf-gitea has no agit flow, so this seam used to
  // decline EVERY receive-pack from a user blocked by the repo owner —
  // narrower than upstream, not a defense (the stale-grant state it guarded
  // is reachable upstream too, and upstream still lets the direct push
  // through). Removed to parity: direct receives are untouched by the block
  // relation. When agit lands (the SPEC-0005 push-to-propose surface), the
  // decline comes back at THAT seam — the proc-receive validator this gate
  // forwards — surfacing upstream's exact hook UserMsg ("Cannot create pull
  // request because you are blocked by the repository owner."), not as a
  // wholesale receive-pack guard.
  const isPush = route.kind === "receive-pack";
  const pusher = isPush ? await resolvePushPusher(env, req) : undefined;

  // §2.1 item 5: invoke the engine and stream its response. The engine hook
  // sees the gate-cleared mark and waves the request through. Receive-pack
  // forwards carry the D1-minted immutable storage key (SPEC-0001a §3 Step
  // 3): the engine's beginReceive resolves R2 addressing from it instead of
  // the URL name, so renames/transfers never fork the storage namespace —
  // and the authenticated pusher (in-process, see resolvePushPusher), which
  // the engine surfaces on PushEvent so the push webhooks name the real
  // pusher instead of the owner fallback.
  const response = await forwardToEngine(
    req,
    url,
    env,
    ctx,
    engine,
    isPush ? resolved.repo.storageKey : undefined,
    pusher,
    isPush ? protectedBranchValidator(env, resolved.repo) : undefined,
  );

  // First-push settle on ANY empty D1-backed repo (the wave-settle-is-empty
  // fix; upstream pushNewBranch, services/repository/push.go:255-270 — on
  // `repo.IsEmpty` a new branch ref sets DefaultBranch + IsEmpty=false for
  // EVERY repo, not just push-created ones). API-created rows are born
  // 'ready' + is_empty, and until now a first push through THIS path never
  // cleared is_empty: generate took the settle-empty arm (content dropped),
  // repo-search/`empty` renders lied, and the license/size settle legs'
  // unborn-tip guards read stale state. Scheduled AFTER the awaited forward
  // (the engine commits refs before its response returns — the same
  // settle-safety argument as the push-create handshake below); the settle
  // re-verifies via listRefs and CAS-guards on is_empty, so a failed or
  // rejected receive is a no-op and a probe/advert never schedules it (this
  // arm runs only on the receive-pack RPC).
  if (isPush && resolved.repo.isEmpty) {
    ctx.waitUntil(settleCreatingRepo(env, resolved.repo.id, `${route.owner}/${route.repo}`));
  }
  return response;
}

/**
 * The D1-missing read passthrough with an existence oracle in front of it
 * (the registry-series residual, REDEPLOY10/11 production probes,
 * docs/design/p0-evidence.md: after API DELETE of a renamed repo, the NEW
 * name's registry entry kept serving refs ~5.4-6.4 s — every trial dirty at
 * t+0 — while non-renamed deleted repos 404'd immediately).
 *
 * Root cause, precisely: NOT the Registry DO (packages/git-engine
 * src/registry.ts is a synchronous SQLite store — `remove` in the delete path
 * is awaited before the 204, and nothing there caches) and NOT a D1 replica
 * (no read replicas are configured). The stale layer is the engine's
 * PER-ISOLATE memo of registry lookups — `infoMemo` in packages/git-engine
 * src/mod.ts (`repoInfo`, 20 s positive TTL): every read the engine serves
 * seeds it, the delete path's awaited `registry.remove` cannot reach into
 * other isolates' maps (the engine only deletes its OWN isolate's entry on a
 * receive/admin response, mod.ts `infoMemo.delete`), and a read landing on a
 * seeded isolate within the TTL sails past the `!info` 404 into the
 * TOMBSTONED cell, which keeps answering reads until the queue purge's
 * destroy (SPEC-0003 §2.5.5 step 4) heals it. The renamed probe hit this
 * deterministically because its lifecycle ALWAYS reads the new name's advert
 * seconds before the delete (the carry verification).
 *
 * Fix layer: the GATE. D1 is the existence authority (AGENTS.md), and the
 * gate has already resolved the D1 row (miss) when it gets here — so before
 * delegating a read to the engine, consult the Registry DO directly (one
 * fresh RPC, the same combined name the engine's own `repoInfo` would look
 * up — raw request casing, `.git` trimmed). Registry-miss ⇒ answer the
 * engine's byte-identical 404 here; the engine — memo included — is never
 * reached for a deleted repo, so the awaited registry remove in
 * RepoService.deleteRepository (service.ts step 2b) takes effect t+0.
 * Registry-hit ⇒ the verbatim passthrough continues for exactly the
 * population it exists for (engine-known-but-D1-unknown repos: the e2e
 * suite; every push upserts the registry, so a pushed transitional repo is
 * always known). Performance shape: zero added work on the D1-resolved hot
 * path (this branch only runs on a row miss, where the passthrough would
 * have made the SAME registry lookup — via the memo or fresh — anyway); the
 * DO RPC replaces, not adds to, the engine's own. HEAD is exempt: the
 * headless engine 404s it pre-auth without consulting the registry, so
 * nothing can leak there.
 */
async function engineKnownRead(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  engine: DurableGitHandler<Env>,
  route: GitHttpRoute,
): Promise<Response> {
  const name = `${route.owner}/${route.repo}`;
  const known = await env.REGISTRY.getByName("registry").get(name);
  if (known === null) return engineRepoNotFound(name);
  return engine.fetch(req, env, ctx);
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
  // behavior for legacy repos is unchanged; §4.13's HEAD probe 404s there —
  // headless, the engine 404s the HEAD shape pre-auth, before any registry
  // consult, so it cannot leak and needs no oracle). The protocol reads ride
  // the registry-existence oracle below.
  if (route.kind === "head") return engine.fetch(req, env, ctx);
  // The receive-pack advert probe (GET info/refs?service=git-receive-pack) is
  // the push-create probe; every other read (upload-pack, unknown/missing
  // service) resolves through the oracle — a registry-known name passes
  // through to the engine exactly as before, a registry-miss name gets the
  // engine's own verbatim 404.
  let probe = false;
  if (route.kind === "info-refs") {
    const refsOp = infoRefsOp(url);
    if (refsOp === null || refsOp === "read") return engineKnownRead(req, env, ctx, engine, route);
    probe = true;
  } else if (route.kind === "upload-pack") {
    return engineKnownRead(req, env, ctx, engine, route);
  }
  // Only receive-pack (advert probe or RPC) reaches the push-create surface.
  if (route.kind !== "receive-pack" && !probe) return engineKnownRead(req, env, ctx, engine, route);

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
  // the dummy advertisement. cf-gitea defaults user push-create ON and org
  // push-create ON for holders of the org repo-create grant (§2.4 documented
  // divergence — a headless forge's primary create path), so the upstream
  // "Push to create is not enabled …" 403s (rows 18/20) have no live branch:
  // the probe serves the dummy empty advertisement (§2.2) and POST decides.
  if (probe) return dummyAdvertisement();

  // POST-time create, the PushCreateRepo decision (services/repository/
  // repository.go:83-108). Own namespace by default (row 17). Another
  // namespace is either the site-admin bypass (upstream skips the ownership
  // check for IsAdmin — row 19's admin arm, into an existing ACTIVE user's
  // namespace) or the row-19 org-grant branch (upstream's
  // `owner.IsOrganization()` arm, repository.go:88-93): a non-admin pusher
  // holding the org repo-create grant — org_members role='owner' or a
  // can_create_org_repo / authorize='owner' team, via
  // OrgService.canCreateOrgRepo, the same predicate POST /orgs/{org}/repos
  // guards with — creates into that ORG's namespace. Everything else 404s
  // (rows 16/20: upstream maps every PushCreateRepo error to the bare 404,
  // githttp.go:235-240).
  let owner = { id: verified.user.id, usernameLower: verified.user.usernameLower };
  if (ownerLower !== owner.usernameLower) {
    if (verified.user.isAdmin) {
      const ownerUser = await userByUsernameLower(env.DB, ownerLower);
      if (ownerUser === null || ownerUser.status !== "active") return repositoryNotFound();
      owner = { id: ownerUser.id, usernameLower: ownerUser.usernameLower };
    } else {
      // §4.11: getOrgByUsername reads a plain user (or a miss) as null —
      // the "cannot push-create repository for another user" 404 of row 16.
      const orgs = new OrgService(env.DB);
      const org = await orgs.getOrgByUsername(ownerLower);
      if (org === null || !(await orgs.canCreateOrgRepo(org.id, verified.user.id))) {
        return repositoryNotFound();
      }
      owner = { id: org.id, usernameLower: org.usernameLower };
    }
  }

  const service = new RepoService(env.DB, { registry: env.REGISTRY.getByName("registry"), queue: env.REPO_TASKS });
  let created: Awaited<ReturnType<RepoService["create"]>>;
  try {
    // §2.5.2: create BEFORE reading the pack, status='creating' guards the
    // crash window (a half-usable repo must never look empty-but-ready);
    // push-created repos default private (upstream DefaultPushCreatePrivate).
    created = await service.create({ owner, name: route.repo, isPrivate: true, status: "creating" });
  } catch (error) {
    if (error instanceof RepoNameCollisionError) {
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
      const response = await forwardToEngine(req, url, env, ctx, engine, raced.repo.storageKey, verifiedPusher(verified), protectedBranchValidator(env, raced.repo));
      ctx.waitUntil(settleCreatingRepo(env, raced.repo.id, `${route.owner}/${route.repo}`));
      return response;
    }
    // Upstream masks EVERY PushCreateRepo error as a bare 404 (githttp.go:
    // 235-240 — "TODO: need to refactor PushCreateRepo and its returned
    // errors"): the git surface carries no error taxonomy. The live member
    // of that family beyond the collision above is the routeable-but-unusable
    // name (`a..b` passes the gate's alphabet pre-filter, fails
    // isUsableRepoName → RepoNameInvalidError): logged for observability and
    // answered with the masked 404 — never an uncaught 500.
    console.error(
      `[push-create] ${ownerLower}/${route.repo}: create failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return repositoryNotFound();
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
  // outcome is settled — settle the create (branches: the full
  // is_empty/default_branch flip; tags-only: status only, the row stays
  // empty-unborn like upstream) or undo it when NO ref at all landed.
  // Scheduled AFTER the
  // forward (the settle body starts at call time; scheduling it earlier would
  // race the finalize with an empty-DO listRefs). The forward carries the
  // fresh row's storage key: the very first receive already addresses R2 by
  // r_<id>, so no name-addressed prefix ever gets written for this repo.
  const response = await forwardToEngine(req, url, env, ctx, engine, created.storageKey, verifiedPusher(verified), protectedBranchValidator(env, created));
  ctx.waitUntil(settleCreatingRepo(env, created.id, `${route.owner}/${route.repo}`));
  return response;
}

/**
 * Repository-scoped ENGINE JSON/admin paths for a repo the classifier claims
 * (§2.1 gate-scope widening — parseEngineRoute). Repo resolution and the
 * redirect rule are the git routes' pipeline; only the decision differs:
 *
 * - D1 row EXISTS: the §2.4 matrix decides — `api/*` with the read rows
 *   (including rows 4/5: the code unit's anonymous-read grant on a private
 *   repo), admin shapes with the WRITE rows (row 7 scope, row 10 archived,
 *   row 8: owner/site-admin only). This is the D1-authority backstop for the
 *   engine hook's registry-`priv` dependency (module header). D1 resolution
 *   failures propagate (worker 500) — fail-closed, like every git route.
 * - D1 row MISSING: a redirect row 301s to the canonical path before any
 *   auth challenge (row 13, §2.5.3 — engine paths ride the same redirect
 *   fabric as git/LFS URLs); with no redirect the request passes through to
 *   the engine VERBATIM — the transitional population is unchanged. THE ONE
 *   EXCEPTION is the engine-shape admin DELETE, which follows the redirect
 *   internally (see the branch below) so redirect-blind cleanup clients
 *   resolve renamed repos.
 *
 * The allow tail is the shared gate-cleared forward (no `storageKey`: only
 * receive-pack forwards carry the D1 storage key, §2.1 item 5), so the
 * engine's own hook waves an already-authorized request instead of
 * re-deciding from the registry mirror.
 */
async function handleEnginePathBranch(
  req: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  engine: DurableGitHandler<Env>,
  route: EngineRoute,
): Promise<Response> {
  const ownerLower = route.owner.toLowerCase();
  const repoLower = route.repo.toLowerCase();
  const resolved = await resolveRepository(env.DB, ownerLower, repoLower);

  if (resolved === null) {
    const redirect = await lookupRedirect(env.DB, ownerLower, repoLower);
    if (redirect !== null) {
      // Engine-shape admin DELETE of a renamed repo's OLD name: follow the
      // redirect INTERNALLY (resolve the canonical row, run the matrix WRITE
      // rows against it, delete THERE) instead of 301ing. Registry-fix wave,
      // probe symptom 3: the smoke harness's cleanup (`DELETE /{owner}/{repo}`,
      // no /api/v1, redirect-blind clients) stranded renamed repos — the git
      // and LFS families keep the plain 301 (row 13's before-auth semantics,
      // which real git clients follow); the one-shot admin shape resolves.
      if (route.kind === "admin" && req.method === "DELETE") {
        const canonical = await resolveRepository(env.DB, redirect.ownerNamespace, redirect.slug);
        if (canonical === null) return repositoryNotFound();
        const decision = await authorizeGitHttp({
          req,
          env,
          waitUntil: (p) => ctx.waitUntil(p),
          op: "write",
          repo: canonical.repo,
          owner: canonical.owner,
          ownerVisibility: canonical.ownerVisibility,
          unitAnonymousRead: false,
        });
        if (decision !== true) return decision;
        return deleteRepositoryViaEngineShape(env, canonical.repo);
      }
      return redirectPermanent(req.url, redirect.ownerNamespace, redirect.slug);
    }
    // D1-missing api reads get the same registry-existence oracle as the git
    // reads (engineKnownRead's docstring): the engine's per-isolate memo would
    // otherwise serve a deleted repo's JSON refs for up to its 20 s TTL. The
    // miss answers the engine's JSON 404 verbatim; admin shapes keep the
    // verbatim passthrough — the transitional population's engine wipe is
    // idempotent and registry-independent (a second cleanup DELETE must stay
    // a 200, not a 404).
    if (route.kind === "api") {
      const name = `${route.owner}/${route.repo}`;
      if ((await env.REGISTRY.getByName("registry").get(name)) === null) {
        return engineJsonRepoNotFound(name);
      }
    }
    return engine.fetch(req, env, ctx);
  }

  const op: "read" | "write" = route.kind === "admin" ? "write" : "read";
  // Rows 4/5: only a private repo can carry the code unit's anonymous-read
  // grant (same computation as the git-route reads).
  const unitAnonymousRead =
    op === "read" && resolved.repo.visibility === "private"
      ? await codeUnitAnonymousRead(env.DB, resolved.repo.id)
      : false;

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

  // Admin DELETE of a D1-resolved repo runs the sanctioned §2.5.5 pipeline
  // (D1 cascade → tombstone → REPO_TASKS; the consumer's destroy stays the
  // only cell wipe) — never a bare engine destroy, which orphans the D1 row
  // (the security wave's live-demonstrated finding). The engine's wire
  // contract (200, "deleted\n") is preserved so engine-shape clients
  // (deploy-smoke's cleanup) are unchanged.
  if (route.kind === "admin" && req.method === "DELETE") {
    return deleteRepositoryViaEngineShape(env, resolved.repo);
  }

  return forwardToEngine(req, url, env, ctx, engine);
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

/** The verified token user, as the engine's `PusherIdentity` (the push-create
 *  forwards already hold the verification in hand — no re-resolve). */
function verifiedPusher(verified: { user: { id: number; usernameLower: string } }): PusherIdentity {
  return { id: verified.user.id, login: verified.user.usernameLower };
}

/**
 * The authenticated pusher for a receive-pack forward: the D1 user the
 * credential verifies to, re-resolved here because `authorizeGitHttp` decides
 * allow/deny from its own verification and returns no identity (acl.ts).
 *
 * TRUST SHAPE (closes webhooks-push.ts's identity gap): the pusher travels as
 * an in-process `engine.fetch` ARGUMENT, never as a request header. The
 * header shape fails verification — a receive-pack request CAN reach the
 * engine with raw client headers: the D1-missing, unverifiable-credential
 * passthrough below (`verified === null` → verbatim `engine.fetch`) forwards
 * the client's own header set, and nothing engine-side could distinguish a
 * client-supplied `x-push-user` from a gate-set one (the gate-cleared mark is
 * Worker-internal; the engine's authorize hook allows the request either
 * way). A function argument has no wire representation, so no client-reachable
 * path can supply it — the engine may surface it on PushEvent verbatim.
 * `null` (a token revoked between the matrix's verify and this one; anonymous
 * cannot reach an allowed write, kept as defense) forwards no identity and the
 * webhook fan-out falls back to the repository owner.
 */
async function resolvePushPusher(env: Env, req: Request): Promise<PusherIdentity | null> {
  const credential = requestCredential(req);
  if (credential === null) return null;
  const verified = await new TokenService(env.DB).verify(credential).catch(() => null);
  return verified === null ? null : verifiedPusher(verified);
}

/** Gate-cleared engine invocation (the shared §2.1 item 5 tail). `storageKey`
 *  (D1 repositories.storage_key) rides the x-storage-key header on
 *  receive-pack forwards; every other route passes it unset and keeps the
 *  byte-identical passthrough (the D1-missing e2e population depends on it).
 *  `pusher` rides the engine's in-process call-options argument on receive
 *  forwards only (resolvePushPusher) — the engine puts it on PushEvent.
 *  `validatePush` (SPEC-0013 M2) rides the same in-process channel on
 *  receive forwards only (protectedBranchValidator) — the engine enforces
 *  its per-ref verdicts before finalize. */
async function forwardToEngine(
  req: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  engine: DurableGitHandler<Env>,
  storageKey?: string,
  pusher?: PusherIdentity | null,
  validatePush?: PushValidator,
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
  const callOptions: EngineCallOptions | undefined =
    pusher || validatePush
      ? {
          ...(pusher ? { pusher } : {}),
          ...(validatePush ? { validatePush } : {}),
        }
      : undefined;
  return engine.fetch(forwarded, env, ctx, callOptions);
}

/**
 * The SPEC-0013 M2 per-ref push policy, supplied to the engine as the
 * receive forward's `validatePush` call option — the same in-process,
 * not-wire-trustable channel as the pusher identity. The engine classifies
 * each command (create/delete/fast-forward/force-push, ancestry engine-side)
 * after the pack is indexed and calls this before finalize; a `reject`
 * verdict renders as the command's report-status ng line and never applies.
 *
 * Enforcement boundary (stated honestly, same posture as the identity seam):
 * only receives the gate forwards WITH a D1-resolved repo row carry the
 * callback. The mirror/import engine composition
 * (services/mirror/sync.ts, repos/imports/pipeline.ts) and the D1-missing
 * transitional passthrough construct their receives without it — no rules
 * load, nothing enforces.
 */
function protectedBranchValidator(env: Env, repo: RepositoryRow): PushValidator {
  return async (commands, hookCtx) => {
    try {
      return await evaluateBranchProtection(env, repo, hookCtx.pusher ?? null, commands);
    } catch (error) {
      console.error(
        `[branch-protection] ${repo.ownerNamespace}/${repo.slug}: push evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Fail closed: the error propagates to the engine's receive catch,
      // which releases the lease with a sweep and answers 500 — never an
      // unevaluated allow.
      throw new Error("branch protection check temporarily unavailable", { cause: error });
    }
  };
}

/**
 * The per-push evaluation (SPEC-0013 §3.5): rules load ONCE per push, the
 * predicates are M1's service ports consumed read-only. Verdicts are
 * index-aligned with the engine's classified commands (a crafted request
 * can send two commands for one ref — join by position, never by name).
 *
 * Upstream arms, per command (hook_pre_receive.go preReceiveBranch,
 * :123-313), ported at the v1 no-object-inspection scope (SPEC-0013 §6):
 * default-branch deletion refused absolutely (:140-143, before the rule
 * lookup), first-match rule (:149-158), the deletion predicate (:166-171),
 * the force-push refusal (:176-191), then the direct-push predicate with
 * the force variant of the refusal text (:229-267). Messages are upstream's
 * exact texts; the engine renders them as report-status ng lines. Tag refs
 * walk the protected-tag arm instead (preReceiveTag :308-339 — the batch-8
 * wiring, see the tag branch below). The UI/API-merge escape hatch
 * (:236-312) does not exist for us — merges never
 * traverse receive-pack — so failure is uniformly "reject the command".
 * Upstream's PR-target deletion arm (:144-147, same deletion text) is not
 * ported: it needs the open-PR base-branch universe and is not one of the
 * SPEC-0013 M2 arms.
 */
async function evaluateBranchProtection(
  env: Env,
  repo: RepositoryRow,
  pusher: PusherIdentity | null,
  commands: ClassifiedPushCommand[],
): Promise<PushVerdict[]> {
  const db = drizzle(env.DB);
  // The pusher's principal access: the in-process identity resolved at the
  // forward (resolvePushPusher) is re-read here for `is_admin` (a site
  // admin holds write+admin — principalAccessOf's early return). A pusher
  // whose user row vanished between the token verify and this read, and an
  // unresolvable/absent identity, evaluate as anonymous: every predicate
  // answers false — not whitelisted (upstream: no user, no allowlist hit).
  const pusherRow = pusher
    ? ((await db
        .select({ id: users.id, username: users.username, isAdmin: users.isAdmin })
        .from(users)
        .where(eq(users.id, pusher.id))
        .limit(1)
        .all())[0] ?? null)
    : null;
  const access = await principalAccessOfRow(
    env.DB,
    repo,
    pusherRow ? { id: pusherRow.id, username: pusherRow.username, isAdmin: pusherRow.isAdmin } : null,
  );

  // Rules load ONCE per push; names compile once (the §2.1 first-match
  // order comes back from listRepoRules), configs parse per matched rule.
  const rules = await listRepoRules(env.DB, repo.id);
  const compiled = rules.map((row) => ({ row, name: compileRuleName(row.ruleName) }));
  // Protected-tag rules load once per push too (upstream preReceiveTag caches
  // ctx.protectedTags the same way, hook_pre_receive.go:315-324).
  const protectedTagRules = await listProtectedTags(env.DB, repo.id);
  const configs = new Map<number, ProtectedBranchConfig>();
  const configOf = (row: ProtectedBranchRow): ProtectedBranchConfig => {
    let config = configs.get(row.id);
    if (config === undefined) {
      config = parseRuleConfig(row.rules);
      configs.set(row.id, config);
    }
    return config;
  };

  return Promise.all(
    commands.map(async (cmd): Promise<PushVerdict> => {
      // Tag refs walk the protected-tag check (upstream preReceiveTag,
      // hook_pre_receive.go:308-339): EVERY tag create/update/delete must
      // pass IsUserAllowedToControlTag — no pattern matches the name, or the
      // pusher is allowlisted (user ids or teams, protected_tag.go:100-149).
      // "Tag %s is protected" is upstream's exact refusal (:337). A compile
      // error inside the check throws — the validator wrapper fails the
      // whole push closed, upstream's "unable to check allowed tags" 500.
      if (cmd.ref.startsWith("refs/tags/")) {
        const tag = cmd.ref.slice("refs/tags/".length);
        if (!(await isTagControlAllowed(env.DB, protectedTagRules, tag, access.userId))) {
          return { reject: `Tag ${tag} is protected` };
        }
        return {};
      }
      if (!cmd.ref.startsWith("refs/heads/")) return {};
      const branch = cmd.ref.slice("refs/heads/".length);
      if (cmd.kind === "delete" && branch === repo.defaultBranch) {
        return { reject: `Branch ${branch} is the default branch and cannot be deleted` };
      }
      const rule = compiled.find(({ name }) => ruleMatches(name, branch));
      if (rule === undefined) return {}; // no matching rule → not per-ref-governed (protected_branch_list.go:92-98)
      const config = configOf(rule.row);
      switch (cmd.kind) {
        case "delete":
          if (!(await canUserDelete(env.DB, config, access))) {
            return { reject: `Branch ${branch} is protected from deletion` };
          }
          return {};
        case "force-push":
          // A force push to a rule without can_force_push refuses outright
          // (:176-191); with the flag the predicate decides and failure
          // carries the force variant of the direct-push refusal (:267).
          if (!config.canForcePush) {
            return { reject: `Branch ${branch} is protected from force push` };
          }
          if (!(await canUserForcePush(env.DB, config, access))) {
            return { reject: `Not allowed to force-push to protected branch ${branch}` };
          }
          return {};
        default:
          // create / fast-forward — the canPush arm (:229-267)
          if (!(await canUserPush(env.DB, config, access))) {
            return { reject: `Not allowed to push to protected branch ${branch}` };
          }
          return {};
      }
    }),
  );
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
 * First-push settle — the §2.5.2 push-create finalize handshake, generalized
 * to EVERY empty repo (the wave-settle-is-empty fix; upstream
 * pushNewBranch, services/repository/push.go:255-270, flips IsEmpty +
 * DefaultBranch on the first new-branch push of ANY repo via the
 * push-update queue — `updateRepositoryForPush`'s handler — not just
 * push-created ones). Runs after a receive response is observable (the
 * engine commits refs before returning it):
 *
 * - ANY ref landed (heads ∪ tags ∪ anything else the engine reports) → the
 *   create is real and the row survives. With branches: `status='ready'`,
 *   `is_empty=false`, `default_branch=<first pushed branch>` — one
 *   conditional UPDATE (`is_empty`, status-agnostic), so a concurrent
 *   settle can never double-apply. For API-created rows this is the first
 *   is_empty transition; for push-created rows it completes the create.
 *   The DO's meta.head is aligned to the adopted branch via the engine's
 *   setHead RPC when it diverged (the engine's first-push adoption prefers
 *   main/master; see below); the synthetic HEAD endpoint falls back to D1
 *   only for unborn repos.
 * - Refs landed but NO branch among them (the tag-only first push):
 *   upstream's tag arm (services/repository/push.go:100-139) records
 *   tags/notifications and nothing else — pushNewBranch (:255-270) is
 *   branch-only, so a tag-only push-create repo SURVIVES, keeping
 *   `IsEmpty=true` and its unborn HEAD on the default branch. Match it:
 *   creating rows flip `status='ready'` ONLY (the create must not linger
 *   half-done), `is_empty`/`default_branch` keep their create values so the
 *   empty-unborn posture stays coherent (serveHead falls back to the
 *   unchanged default_branch; no setHead — the engine left meta.head
 *   unborn, commitPush finds no branch to prefer), and a later branch push
 *   re-settles through the `is_empty` CAS above. Established empty rows
 *   have nothing to do.
 * - NO ref at all (receive failed, client vanished, worker crashed
 *   mid-receive) → UNDO, creating rows only: the row is deleted again,
 *   conditional on `status='creating' AND is_empty` — a half-usable repo
 *   never lingers. An established (ready/'migrating') empty repo that took
 *   a ref-less receive stays put — deleting its seeded dependents would
 *   corrupt a live repo.
 *
 * The `repository` action=created webhook stays creating-only: API-created
 * repos emitted it at their create route; this settle must never re-emit.
 *
 * `refs_version` is deliberately not synced: the engine's finalize result
 * carries no version (engine gap), and the column is observability-only.
 */
export async function settleCreatingRepo(env: Env, repoId: string, engineRepo: string): Promise<void> {
  try {
    const db = drizzle(env.DB);
    const row = await db.select().from(repositories).where(eq(repositories.id, repoId)).get();
    if (row === undefined || !row.isEmpty) return;

    let refNames: string[] | null = null;
    let doHead: string | null = null;
    try {
      const listed = await env.REPO.getByName(engineRepo).listRefs();
      refNames = listed.refs.map((r) => r.name);
      doHead = listed.head;
    } catch {
      refNames = null; // unreadable/unwarming DO: treat as no refs
    }

    if (refNames === null || refNames.length === 0) {
      // Undo the create (§2.5.2: "deleted again, D1 conditional on
      // status='creating' AND is_empty") — fires ONLY when the receive
      // committed no ref of ANY namespace (a tag landing is enough to keep
      // the row, per upstream above). Creating rows ONLY: the FK-bearing
      // dependents the create seeded (counters, units) go first, in the
      // same batch; the unconditional deletes make the explicit status
      // guard here load-bearing for established repos.
      if (row.status !== "creating") return;
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

    const branches = refNames.filter((name) => name.startsWith("refs/heads/"));
    if (branches.length === 0) {
      // Tag-only first push — the create is still real (see docblock).
      // The CAS on status='creating' doubles as the webhook gate: rows
      // changed implies the row WAS creating, so the event emits exactly
      // once, concurrent/duplicate settles included.
      if (row.status !== "creating") return;
      const settled = await db
        .update(repositories)
        .set({ status: "ready", updatedAt: new Date() })
        .where(and(eq(repositories.id, repoId), eq(repositories.status, "creating")))
        .run();
      if ((settled.meta.changes ?? 0) > 0) await emitCreatedEvent(env, repoId);
      return;
    }

    // First non-empty branch push adopts the default branch (§2.5.2,
    // upstream pushNewBranch). listRefs orders by name, so a single-branch
    // push — the dominant first-push shape — is exact; a multi-branch first
    // push adopts the alphabetically first branch (upstream adopts the pushed
    // branch; indistinguishable here without an engine hook). The CAS is
    // `is_empty` only: every empty row — 'creating', 'ready', 'migrating' —
    // settles the same way, `status` re-asserting 'ready' for the push-create
    // rows and a no-op value for the rest.
    const firstBranch = branches[0]!.slice("refs/heads/".length);
    const settled = await db
      .update(repositories)
      .set({ status: "ready", isEmpty: false, defaultBranch: firstBranch, updatedAt: new Date() })
      .where(and(eq(repositories.id, repoId), eq(repositories.isEmpty, true)))
      .run();

    // `repository` action=created — the create is real the moment the CAS
    // flip lands (upstream CreateRepository, notifier.go:114-116, fires at
    // once because its push-create row is never 'creating'; our §2.5.2
    // crash-window settle is the honest equivalent). Gated on the row having
    // BEEN 'creating' — API-created repos already emitted at their create
    // route, so this settle must not re-emit — and on rows-changed so a
    // concurrent/duplicate settle emits exactly once; the undo arm above
    // stays silent — the repo was never servable, so there is no deletion to
    // notify.
    if ((settled.meta.changes ?? 0) > 0 && row.status === "creating") {
      await emitCreatedEvent(env, repoId);
    }

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
          console.error(`[push-settle] ${repoId}: setHead ${firstBranch} rejected: ${set.tag}`);
        }
      } catch (error) {
        console.error(
          `[push-settle] ${repoId}: setHead ${firstBranch} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    console.error(
      `[push-settle] ${repoId} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The `repository` action=created webhook for a settling push-create row —
 * factored so the branch arm and the tag-only arm emit identically. The
 * settle carries no pusher identity (the push family's documented deviation,
 * webhooks-push.ts header), so the sender is the owner-fallback pusher:
 * upstream push-create only creates in the pusher's own namespace (site-admin
 * overrides aside).
 */
async function emitCreatedEvent(env: Env, repoId: string): Promise<void> {
  const pair = await findRepositoryById(env.DB, repoId);
  if (pair === null) return;
  const identity = repositoryEventIdentity({ origin: appOrigin(env), requester: null }, pair);
  const sender = identity.organization;
  await emitRepoEventInline(env, {
    repoId: pair.repo.id,
    ownerId: pair.owner.id,
    eventType: "repository",
    payload: repositoryEventPayload("created", identity.repository, identity.organization, sender),
  });
}
