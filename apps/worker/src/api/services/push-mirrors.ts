import { and, asc, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { pushMirrors } from "../../db/schema";
import { ApiError } from "../errors";
import { checkMirrorSource, sanitizeUrl } from "../../services/mirror/gitclient";
import { parseHostPolicy } from "../../webhooks/ssrf";

/**
 * Push-mirror CRUD + sync-trigger service (the inventory batch 7 family:
 * repoListPushMirrors, repoGetPushMirrorByRemoteName, repoAddPushMirror,
 * repoDeletePushMirror, repoPushMirrorSync — upstream
 * routers/api/v1/repo/mirror.go:79-404 over models/repo/pushmirror.go).
 *
 * THE QUEUE SEMANTICS: the sync trigger does NOT push inline — upstream's
 * PushMirrorSync runs runPushSync synchronously per mirror inside the request
 * (services/mirror/mirror_push.go:77-124, called from the API loop) — it
 * enqueues one `{kind: "push-mirror-sync", repoId, pushMirrorId}` message on
 * MIRROR_SYNC_QUEUE (queue `repo-tasks`) per mirror, the exact lane the
 * landed pull mirror-sync uses. The OUTBOUND push worker is now LANDED
 * (specs/push-mirror-outbound.md): services/mirror/push-sync.ts
 * (`handlePushMirrorSync`) consumes the kind and performs the real
 * receive-pack push plus the last_update/last_error settle of
 * UpdatePushMirrorSyncStatus; its consumer/producer arms (src/repos/purge.ts
 * dispatch + src/index.ts cron/onPush) are the orchestrator wiring recorded
 * in that module's header. Everything observable through THIS family is real:
 * the rows, the wire shapes, the enqueue, and the 422 arm when an enqueue
 * fails (upstream's failed-mirror collection, mirror.go:126-133).
 *
 * CREDENTIALS (upstream stores login/password INSIDE the git remote URL via
 * AddPushMirrorRemote — cf-gitea has no git-config layer): the structured
 * remote_username/remote_password compose an RFC 7617 Basic Authorization
 * header value, sealed into the SAME §4.2 envelope the pull channel uses —
 * `base64(nonce[12] || AES-256-GCM(plaintext))`, key = MIRROR_CREDENTIAL_KEY
 * (32 bytes, base64), AAD `${row.id}:${repoId}` — byte-for-byte what
 * sync.ts's mirrorAuthHeader decrypts. The stored remote_address is
 * SANITIZED (userinfo stripped, util.SanitizeURL parity) and is the only
 * address ever rendered; the Authorization value is never echoed, never
 * logged. Deleting the row deletes the sealed credentials with it (upstream
 * RemovePushMirrorRemote parity — the row IS the record).
 *
 * DELIBERATELY ENGINE-FREE: the /api/v1 route module graph is bundled by
 * scripts/check-openapi.mjs (SPEC-0004 §5.1) and must not reach
 * packages/git-engine — the gitclient/ssrf imports here are the landed
 * engine-free pair api/services/mirror.ts already rides.
 */

/** The env the push-mirror service reads: the queue binding the trigger
 *  needs, plus the MIRROR_* config vars kept OPTIONAL on purpose (the same
 *  posture as MirrorSettingsEnv in api/services/mirror.ts — absent = the lax
 *  default, the KEK guard fails closed). The generated Env satisfies this
 *  structurally. */
export interface PushMirrorEnv extends Pick<Env, "MIRROR_SYNC_QUEUE"> {
  /** `MIRROR_ALLOWED_HOST_LIST` (upstream MIGRATIONS_ALLOWED_HOSTS — the
   *  egress policy shared with the pull channel). */
  MIRROR_ALLOWED_HOST_LIST?: string;
  /** `lax` (default) | `strict`; undeclared vars never load. */
  MIRROR_EGRESS_MODE?: string;
  /** AES-256-GCM KEK for `push_mirrors.credentials_ciphertext` (§4.2). */
  MIRROR_CREDENTIAL_KEY?: string;
}

/** `MIRROR_MIN_INTERVAL` (modules/setting/mirror.go:23) — 10 m, the same
 *  floor both mirror directions enforce. */
export const PUSH_MIRROR_MIN_INTERVAL_SECONDS = 600;

/** The row shape this service reads/writes (`typeof pushMirrors.$inferSelect`
 *  re-declared structurally so callers can pass partial rows in tests). */
export type PushMirrorRow = typeof pushMirrors.$inferSelect;

// ---------------------------------------------------------------------------
// Interval grammar (Go time.ParseDuration subset — upstream binds
// CreatePushMirrorOption.Interval as a string and ParseDuration's it,
// mirror.go:340-350)
// ---------------------------------------------------------------------------

/**
 * Go ParseDuration subset for the push-mirror `interval`: optional sign,
 * compound decimal components over ns/us/µs/ms/s/m/h, and the bare "0".
 * Returns seconds (sub-second components truncate away — any nonzero result
 * below the 10 m floor then fails upstream's min check, same outcome as
 * upstream's Duration arithmetic), or null when unparseable (upstream:
 * `invalid interval: …`). Wider than the pull channel's parser
 * (api/services/mirror.ts parseGoDuration is unsigned-integers-only) because
 * upstream routes parse failures and below-minimum values to DIFFERENT error
 * texts here, and the sign/float forms parse upstream.
 */
export function parsePushMirrorInterval(raw: string): number | null {
  if (raw === "0") return 0;
  if (raw === "") return null;
  if (!/^[+-]?(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/.test(raw)) return null;
  const negative = raw.startsWith("-");
  let total = 0;
  for (const [, value, unit] of raw.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) {
    const n = Number.parseFloat(value!);
    switch (unit!) {
      case "h":
        total += n * 3600;
        break;
      case "m":
        total += n * 60;
        break;
      case "s":
        total += n;
        break;
      case "ms":
        total += n / 1000;
        break;
      default:
        // ns / us / µs — below one second; truncate (a nonzero value lands
        // far below the min floor either way, as upstream's would).
        break;
    }
  }
  total = Math.floor(total);
  return negative ? -total : total;
}

/** Go `time.Duration.String()` whole-second form for the wire's `interval`
 *  field: "8h0m0s", "30m0s", "45s", "0s" (the pull channel's renderer emits
 *  "0" for disabled — upstream's zero Duration.String() is "0s" and THIS
 *  family's shape is the frozen contract, so it renders upstream-exact). */
export function goDurationString(seconds: number): string {
  if (seconds === 0) return "0s";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  let out = "";
  if (hours > 0) out += `${hours}h`;
  if (minutes > 0 || hours > 0) out += `${minutes}m`;
  return `${out}${secs}s`;
}

/**
 * The `interval` accept/validation (upstream CreatePushMirror,
 * mirror.go:341-350): ParseDuration failures are 400
 * `invalid interval: …`, and any nonzero value below the 10 m floor is 400
 * `interval is shorter than minimum 10m0s`. Absent/empty parses upstream as
 * the Go zero value and FAILS ParseDuration — the field is effectively
 * required (mirror.go:341; upstream's swagger marks nothing, the runtime
 * decides).
 */
export function requirePushMirrorInterval(raw: string | undefined): number {
  const seconds = parsePushMirrorInterval(raw ?? "");
  if (seconds === null) {
    // Upstream text: fmt.Sprintf("invalid interval: %v", err) with Go's
    // time.ParseDuration error — `time: invalid duration "…"`.
    throw new ApiError(400, `invalid interval: time: invalid duration ${JSON.stringify(raw ?? "")}`);
  }
  if (seconds !== 0 && seconds < PUSH_MIRROR_MIN_INTERVAL_SECONDS) {
    throw new ApiError(400, `interval is shorter than minimum ${goDurationString(PUSH_MIRROR_MIN_INTERVAL_SECONDS)}`);
  }
  return seconds;
}

// ---------------------------------------------------------------------------
// Target-URL gate (upstream ParseRemoteAddr + IsMigrateURLAllowed +
// HandleRemoteAddressError, mirror.go:352-361 + 391-405)
// ---------------------------------------------------------------------------

/**
 * Registration-time egress screen for the PUSH TARGET — the same gate the
 * pull channel runs at accept time (checkMirrorSourceUrl in
 * api/services/mirror.ts), with THIS family's upstream error texts
 * (HandleRemoteAddressError, mirror.go:391-405):
 *   - unparseable URL            → 400 "Invalid Url "   (upstream's exact
 *     text INCLUDING the trailing space — IsURLError bucket);
 *   - embedded userinfo          → 400 "Invalid Url " (credentials only
 *     ever arrive via remote_username/remote_password, so they can never
 *     leak into storage or logs — see the divergence note below);
 *   - a non-https scheme         → 400 "Invalid mirror protocol"
 *     (IsProtocolInvalid bucket);
 *   - an egress-policy denial    → 401 "Permission denied" (the
 *     IsPermissionDenied bucket).
 *
 * DIVERGENCE (documented, SPEC-0009 §1 parity): upstream ParseRemoteAddr
 * accepts http:// and git:// remotes; cf-gitea's mirror channels are
 * https-only (egress-controlled Workers cannot honor arbitrary schemes), so
 * every non-https scheme lands in the protocol bucket. Upstream ACCEPTS
 * embedded userinfo and strips it for storage (SanitizeURL); we reject it so
 * the structured credential fields stay the only channel (the pull gate's
 * identical rule).
 *
 * @returns the sanitized URL (userinfo can never be present — rejected —
 * but sanitizeUrl runs anyway, defense in depth per gitclient's contract).
 */
export function checkPushMirrorTarget(raw: string, env: PushMirrorEnv): { url: URL; sanitized: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(400, "Invalid Url ");
  }
  // Protocol FIRST (upstream's ParseRemoteAddr only embeds/reads userinfo on
  // the http/https/git forms — an ssh:// URL with embedded userinfo is still
  // the protocol bucket), then userinfo, then control characters.
  if (url.protocol !== "https:") {
    throw new ApiError(400, "Invalid mirror protocol");
  }
  if (url.username !== "" || url.password !== "") throw new ApiError(400, "Invalid Url ");
  if (/[\r\n\t]/.test(url.href)) {
    throw new ApiError(400, "Invalid mirror protocol");
  }
  const mode = env.MIRROR_EGRESS_MODE === "strict" ? "strict" : "lax";
  const policy = parseHostPolicy(env.MIRROR_ALLOWED_HOST_LIST, mode);
  if (!checkMirrorSource(url, policy).allowed) {
    throw new ApiError(401, "Permission denied");
  }
  return { url, sanitized: sanitizeUrl(url) };
}

/**
 * The stored Authorization header value from the structured fields: upstream
 * embeds `user:pass` into the remote URL whenever EITHER is non-empty
 * (ParseRemoteAddr, modules/git/remote.go:84-87); ours composes
 * `Basic base64(user:pass)` (RFC 7617) for the §4.2 envelope. No token field
 * exists on CreatePushMirrorOption (modules/structs/mirror.go:8-20). Returns
 * null for an anonymous mirror.
 */
export function derivePushMirrorAuthHeader(username: string | undefined, password: string | undefined): string | null {
  const user = username ?? "";
  const pass = password ?? "";
  if (user === "" && pass === "") return null;
  let raw = "";
  for (const byte of new TextEncoder().encode(`${user}:${pass}`)) raw += String.fromCharCode(byte);
  return `Basic ${btoa(raw)}`;
}

/** util.CryptoRandomString(10) (modules/util/util.go:75-84) over the same 62
 *  alphanumeric alphabet, rejection-sampled so the modulo is unbiased —
 *  crypto randomness per the platform rules, never Math.random. */
function cryptoRandomString(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const byte of bytes) {
      if (byte < 248) {
        // 248 = 62 * 4 — the largest multiple of 62 that fits a byte;
        // rejecting 248..255 keeps every letter equally likely.
        out += alphabet[byte % 62];
        if (out.length === length) break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wire shape (the contract's PushMirror definition, verbatim property set)
// ---------------------------------------------------------------------------

/** The frozen-contract `PushMirror` shape (x-go-names in comments). */
export interface PushMirrorWire {
  /** RepoName — the source repository's name. */
  repo_name: string;
  /** RemoteName. */
  remote_name: string;
  /** RemoteAddress — sanitized (userinfo never present). */
  remote_address: string;
  /** CreatedUnix (date-time). */
  created: string;
  /** LastUpdateUnix (date-time | null until the first sync). */
  last_update: string | null;
  /** LastError. */
  last_error: string;
  /** Interval — Go Duration.String() form. */
  interval: string;
  /** SyncOnCommit. */
  sync_on_commit: boolean;
}

/** convert.ToPushMirror (services/convert/mirror.go:14-26) — the repo's name
 *  rides in from the caller (already resolved by the route's gate). */
export function toApiPushMirror(row: PushMirrorRow, repoName: string): PushMirrorWire {
  return {
    repo_name: repoName,
    remote_name: row.remoteName,
    remote_address: row.remoteAddress,
    created: new Date(row.createdAt.getTime()).toISOString(),
    last_update: row.lastUpdateUnix === null ? null : new Date(row.lastUpdateUnix.getTime()).toISOString(),
    last_error: row.lastError,
    interval: goDurationString(row.intervalSeconds),
    sync_on_commit: row.syncOnCommit,
  };
}

// ---------------------------------------------------------------------------
// CRUD + the sync trigger
// ---------------------------------------------------------------------------

/** The create body (the contract's CreatePushMirrorOption, field names
 *  verbatim; validation is upstream's runtime shape — zod stays loose so the
 *  upstream error texts below decide). */
export interface CreatePushMirrorOptions {
  remote_address?: string;
  remote_username?: string;
  remote_password?: string;
  interval?: string;
  sync_on_commit?: boolean;
}

/**
 * AddPushMirror (mirror.go:333-389): interval validation, target gate, then
 * the insert with a server-generated `remote_mirror_<10 alphanumerics>`
 * name; credentials seal LAST (the AAD needs the row id — the pull channel's
 * two-step pattern). The KEK is validated BEFORE any write when credentials
 * are present (a mirror registered without its secret would only fail later,
 * at push time). Unlike the pull attach there is NO repo CAS: push mirrors
 * are N-rows per repo and never touch `repositories.is_mirror` (upstream
 * keeps that flag for pull mirrors only).
 *
 * Upstream's post-insert AddPushMirrorRemote (the git-config registration
 * whose failure rolls the row back) has no analog here — there is no
 * git-config layer; the sealed envelope is the whole registration.
 */
export async function addPushMirror(
  db: D1Database,
  env: PushMirrorEnv,
  repo: { id: string; slug: string },
  options: CreatePushMirrorOptions,
): Promise<PushMirrorWire> {
  const intervalSeconds = requirePushMirrorInterval(options.interval);
  const target = checkPushMirrorTarget(options.remote_address ?? "", env);
  const authHeader = derivePushMirrorAuthHeader(options.remote_username, options.remote_password);
  const kek = readyKek(env, authHeader !== null);
  const syncOnCommit = options.sync_on_commit ?? false;
  const credentialsUsername = options.remote_username ?? null;

  const values: typeof pushMirrors.$inferInsert = {
    repoId: repo.id,
    remoteName: `remote_mirror_${cryptoRandomString(10)}`,
    remoteAddress: target.sanitized,
    syncOnCommit,
    intervalSeconds,
    createdAt: new Date(),
    lastUpdateUnix: null,
    lastError: "",
    credentialsUsername,
    credentialsCiphertext: null, // sealed below, once the row id exists (the AAD half)
  };
  const inserted = await drizzle(db).insert(pushMirrors).values(values).returning({ id: pushMirrors.id });
  const id = inserted[0]?.id;
  if (id === undefined) {
    throw new ApiError(500, "push mirror row vanished after registration");
  }

  if (authHeader !== null && kek !== null) {
    await drizzle(db)
      .update(pushMirrors)
      .set({ credentialsCiphertext: await encryptCredentials(kek, id, repo.id, authHeader) })
      .where(eq(pushMirrors.id, id));
  }
  return toApiPushMirror(
    {
      id,
      repoId: repo.id,
      remoteName: values.remoteName,
      remoteAddress: values.remoteAddress,
      syncOnCommit,
      intervalSeconds,
      createdAt: values.createdAt,
      lastUpdateUnix: null,
      lastError: "",
      credentialsUsername,
      credentialsCiphertext: null, // sealed above when credentials exist
      syncState: "idle", // the fresh row: never scheduled, first sync pending
      nextSyncAt: 0,
    },
    repo.slug,
  );
}

/** ListPushMirrors (mirror.go:148-190): the repo's rows ordered by id
 *  (PushMirrorOptions.ToOrders → "id", pushmirror.go:36-38), paginated with
 *  the total count for the Link/total-count headers. `page`/`limit` are the
 *  caller's ALREADY-CLAMPED options (api/pagination.ts parseListOptions) —
 *  the 30-default lives there (upstream's setting.API.DefaultPagingNum via
 *  convert.GetListOptions), so there is intentionally no service-level
 *  fallback: callers must choose. */
export async function listPushMirrors(
  db: D1Database,
  repoId: string,
  page: number,
  limit: number,
): Promise<{ rows: PushMirrorRow[]; total: number }> {
  const dbd = drizzle(db);
  const where = eq(pushMirrors.repoId, repoId);
  const total = (await dbd.select({ n: count() }).from(pushMirrors).where(where).all())[0]?.n ?? 0;
  let query = dbd.select().from(pushMirrors).where(where).orderBy(asc(pushMirrors.id)).$dynamic();
  query = query.limit(limit);
  if (page > 1) query = query.offset((page - 1) * limit);
  return { rows: await query.all(), total };
}

/** GetPushMirrorByName (mirror.go:192-231): the EXACT (repo_id, remote_name)
 *  row — db.Get on PushMirrorOptions{RepoID, RemoteName}.ToConds; null is
 *  the handler's 404 (ctx.APIErrorNotFound). */
export async function getPushMirrorByName(db: D1Database, repoId: string, remoteName: string): Promise<PushMirrorRow | null> {
  const row = await drizzle(db)
    .select()
    .from(pushMirrors)
    .where(and(eq(pushMirrors.repoId, repoId), eq(pushMirrors.remoteName, remoteName)))
    .get();
  return row ?? null;
}

/**
 * DeletePushMirrorByRemoteName (mirror.go:264-293): delete the
 * (repo_id, remote_name) row — its sealed credentials go with it. IDEMPOTENT
 * like upstream: models.DeletePushMirrors errors only on a missing repo_id
 * (util.NewInvalidArgumentErrorf), never on a zero-rows delete, so an
 * unknown name is STILL upstream's 204 (the contract's declared 404 is the
 * repo-resolution arm, not the name arm).
 */
export async function deletePushMirrorByName(db: D1Database, repoId: string, remoteName: string): Promise<void> {
  await drizzle(db)
    .delete(pushMirrors)
    .where(and(eq(pushMirrors.repoId, repoId), eq(pushMirrors.remoteName, remoteName)));
}

/**
 * PushMirrorSync (mirror.go:107-145): enqueue every mirror of the repo —
 * one `{kind: "push-mirror-sync", repoId, pushMirrorId}` message per row on
 * MIRROR_SYNC_QUEUE (consumed by services/mirror/push-sync.ts). A repo with
 * NO push mirrors enqueues nothing and
 * is upstream's 200 (the empty GetPushMirrorsByRepoID loop). Returns the
 * remote names whose enqueue FAILED — the caller renders upstream's
 * 422 "error occurred when syncing push mirrors: a, b" (mirror.go:126-133).
 */
export async function enqueuePushMirrorSyncs(
  db: D1Database,
  queue: Queue,
  repoId: string,
): Promise<string[]> {
  const rows = await drizzle(db)
    .select({ id: pushMirrors.id, remoteName: pushMirrors.remoteName })
    .from(pushMirrors)
    .where(eq(pushMirrors.repoId, repoId))
    .orderBy(asc(pushMirrors.id))
    .all();
  const failed: string[] = [];
  for (const row of rows) {
    try {
      await queue.send({ kind: "push-mirror-sync", repoId, pushMirrorId: row.id });
    } catch {
      failed.push(row.remoteName);
    }
  }
  return failed;
}

// ---------------------------------------------------------------------------
// credential envelope — the encrypt half of sync.ts's mirrorAuthHeader
// (api/services/mirror.ts's twin; AAD `${id}:${repoId}` per its doc comment)
// ---------------------------------------------------------------------------

/** Validate (and return) the base64 KEK — only consulted when credentials
 *  are being stored; anonymous mirrors never touch it. */
function readyKek(env: PushMirrorEnv, credentialsPresent: boolean): string | null {
  if (!credentialsPresent) return null;
  const kek = env.MIRROR_CREDENTIAL_KEY;
  if (kek === undefined || kek === "") {
    throw new ApiError(500, "MIRROR_CREDENTIAL_KEY is not configured; source credentials cannot be stored");
  }
  if (atob(kek).length !== 32) {
    throw new ApiError(500, "MIRROR_CREDENTIAL_KEY must be 32 bytes, base64-encoded");
  }
  return kek;
}

/** The §4.2 envelope: `base64( nonce[12] || AES-256-GCM(plaintext) )`, AAD
 *  `${mirrorId}:${repoId}` — byte-for-byte what sync.ts's mirrorAuthHeader
 *  decrypts (wrong AAD = row-swap rejected). */
async function encryptCredentials(kek: string, mirrorId: number, repoId: string, authHeader: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", base64Decode(kek), "AES-GCM", false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: new TextEncoder().encode(`${mirrorId}:${repoId}`),
        tagLength: 128,
      },
      key,
      new TextEncoder().encode(authHeader),
    ),
  );
  const framed = new Uint8Array(nonce.length + sealed.length);
  framed.set(nonce);
  framed.set(sealed, nonce.length);
  return base64Encode(framed);
}

function base64Decode(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function base64Encode(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
}
