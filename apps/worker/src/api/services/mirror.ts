import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repoImports, repoMirrors, repositories } from "../../db/schema";
import { checkMirrorSource, sanitizeUrl } from "../../services/mirror/gitclient";
import { parseHostPolicy } from "../../webhooks/ssrf";

/**
 * Mirror registration/status service (SPEC-0009 §2.2/§2.3 — the migrate /
 * mirror-status / mirror-sync HTTP surface's business half).
 *
 * DELIBERATELY ENGINE-FREE: the /api/v1 route module graph is bundled by
 * scripts/check-openapi.mjs (SPEC-0004 §5.1) and must not reach
 * packages/git-engine — the same boundary routes/imports.ts documents. The
 * sync CONSUMER (src/services/mirror/sync.ts) imports the engine, so this
 * module shares contracts with it by VALUE only where the module is
 * engine-free (sanitizeUrl lives in gitclient.ts, whose sole import is the
 * SSRF policy module) and by documented shape everywhere else:
 *
 *   - queue message   `{kind: "mirror-sync", repoId}` on MIRROR_SYNC_QUEUE
 *     (sync.ts `MirrorSyncMessage`; the consumer re-guards every state, so
 *     producer-side dedup is best-effort by design).
 *   - credential envelope (§4.2 — sync.ts `mirrorAuthHeader`'s contract,
 *     which the encrypt side below MUST adopt verbatim):
 *
 *       ciphertext = base64( nonce[12] || AES-256-GCM(plaintext) )
 *       plaintext  = the full Authorization header value
 *                  = "Basic base64(user:pass)" | "Bearer <token>"
 *       key        = MIRROR_CREDENTIAL_KEY (32 bytes, base64), AES-256-GCM
 *       AAD        = `${mirror.id}:${repoId}`  (row-move binding)
 *
 * Guard discipline mirrors the import channel's create (repos/imports/
 * service.ts): a single D1 batch CASes the repositories row (empty +
 * unarchived + ready + not-already-mirror) and inserts the 1:1 repo_mirrors
 * row atomically — the arbitration points decide, never a read.
 */

/** The env the mirror settings/migrate orchestration reads: the queue binding
 *  the enqueue side needs, picked from the generated Env (a wrangler.jsonc
 *  rename surfaces as a keyof error HERE instead of hiding behind a stale
 *  generated file), plus the MIRROR_* config vars kept OPTIONAL on purpose —
 *  absent = the lax default posture, and the KEK guard fails closed (tests
 *  drive the absent-KEK path with an explicit undefined). The generated Env
 *  satisfies this structurally. */
export interface MirrorSettingsEnv extends Pick<Env, "MIRROR_SYNC_QUEUE"> {
  /** `MIRROR_ALLOWED_HOST_LIST` (upstream MIGRATIONS_ALLOWED_HOSTS). */
  MIRROR_ALLOWED_HOST_LIST?: string;
  /** `lax` (default) | `strict` (§4.1 — same syntax as the webhook lists;
   *  not declared in wrangler.jsonc — undeclared vars never load). */
  MIRROR_EGRESS_MODE?: string;
  /** AES-256-GCM KEK for `repo_mirrors.credentials_ciphertext` (§4.2). */
  MIRROR_CREDENTIAL_KEY?: string;
}

/** 422 family — upstream's migrate validation errors (SPEC-0009 §2.2 table).
 *  `field` tags which input refused (SPEC-0009 §2.3.1): the web settings form
 *  renders the interval refusal as the locale text
 *  ("The mirror interval is not valid.", setting.go:299-303) and the others
 *  with the message itself; the API ignores the tag. */
export class MirrorValidationError extends Error {
  readonly field?: "interval" | "address" | "lfs_endpoint" | "auth";
  constructor(message: string, field?: "interval" | "address" | "lfs_endpoint" | "auth") {
    super(message);
    this.name = "MirrorValidationError";
    this.field = field;
  }
}

/** 409 family — target-repo conflicts (SPEC-0009 §2.2 table rows 4-5). */
export class MirrorConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MirrorConflictError";
  }
}

/** 500 family — the instance is not configured to hold source credentials
 * (KEK missing/malformed). Fail fast at registration: a mirror registered
 * WITHOUT its secret would only fail later, at the sync's decrypt (§4.2). */
export class MirrorCredentialKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MirrorCredentialKeyError";
  }
}

// ---------------------------------------------------------------------------
// Upstream MigrateRepoOptions (modules/structs/repo.go:419-450) — the subset
// this endpoint accepts. repo_owner/uid/repo_name and private/description are
// accepted-and-ignored: the target repo is the URL path here, and editing its
// settings is PATCH /repos/{owner}/{repo}'s job, not migrate's.
// ---------------------------------------------------------------------------

/** Wire shape of the migrate body (upstream `MigrateRepoOption` field names). */
export interface MigrateOptions {
  clone_addr: string;
  service?: string;
  auth_username?: string;
  auth_password?: string;
  auth_token?: string;
  mirror?: boolean;
  lfs?: boolean;
  lfs_endpoint?: string;
  private?: boolean;
  description?: string;
  wiki?: boolean;
  issues?: boolean;
  milestones?: boolean;
  labels?: boolean;
  pull_requests?: boolean;
  releases?: boolean;
  mirror_interval?: string;
}

/** `modules/setting/mirror.go:24` — upstream's 8 h default interval. */
export const MIRROR_DEFAULT_INTERVAL_SECONDS = 28800;
/** `MIRROR_MIN_INTERVAL` (modules/setting/mirror.go:21) — 10 m, §3.1. */
export const MIRROR_MIN_INTERVAL_SECONDS = 600;

/** Go-duration subset parser for `mirror_interval` (upstream binds the field
 *  as a string duration, services/repository/migrate.go:195-212): unsigned,
 *  compound units ms/s/m/h ("8h30m", "0"); "0" means disabled. Returns
 *  seconds, or null when unparseable/negative — the caller 422s (§2.2 row 6). */
export function parseGoDuration(raw: string): number | null {
  if (raw === "0") return 0;
  if (raw === "") return null;
  // Go's ParseDuration grammar, minus sign/float support (intervals are
  // whole seconds here; a float would silently truncate — refuse instead).
  const match = /^(?:\d+(?:ms|s|m|h))+/.exec(raw);
  if (match === null || match[0] !== raw) return null;
  let total = 0;
  for (const [, digits, unit] of raw.matchAll(/(\d+)(ms|s|m|h)/g)) {
    const value = Number.parseInt(digits!, 10);
    switch (unit) {
      case "h":
        total += value * 3600;
        break;
      case "m":
        total += value * 60;
        break;
      case "s":
        total += value;
        break;
      case "ms":
        total += Math.floor(value / 1000);
        break;
    }
  }
  return total;
}

/** Inverse of the parser for the status body ("0" disabled, else Go's
 *  `Duration.String()` whole-second form: "8h0m0s", "30m0s", "45s"). */
export function renderGoDuration(seconds: number): string {
  if (seconds === 0) return "0";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  let out = "";
  if (hours > 0) out += `${hours}h`;
  if (minutes > 0 || hours > 0) out += `${minutes}m`;
  return `${out}${secs}s`;
}

/** `mirror_interval` accept/validation (§2.2 row 6): absent → the 8 h
 *  default; "0" → disabled; else parse + the MIRROR_MIN_INTERVAL floor.
 *  Throws MirrorValidationError (422) on the upstream conditions. */
export function parseMirrorInterval(raw: string | undefined): number {
  if (raw === undefined) return MIRROR_DEFAULT_INTERVAL_SECONDS;
  const seconds = parseGoDuration(raw);
  if (seconds === null) {
    throw new MirrorValidationError(`invalid mirror_interval: ${JSON.stringify(raw)}`);
  }
  if (seconds !== 0 && seconds < MIRROR_MIN_INTERVAL_SECONDS) {
    throw new MirrorValidationError(
      `mirror_interval is below the minimum of ${MIRROR_MIN_INTERVAL_SECONDS}s (0 disables scheduling)`,
    );
  }
  return seconds;
}

/**
 * Registration-time egress screen (§4.1) — the canonical mirror gate
 * (gitclient.ts's `checkMirrorSource`, the same one the sync re-runs on
 * every fetch; upstream re-validates per sync, mirror_pull.go:113-121 —
 * checking here too preserves upstream's create-time 422s). URL-shape
 * failures (scheme/userinfo/control chars) carry upstream's
 * "The provided URL is invalid." text; policy denials carry
 * "You can not import from disallowed hosts." (§2.2 row 2).
 *
 * @returns the sanitized URL (userinfo can never be present — rejected —
 * but sanitizeUrl runs anyway, defense in depth per gitclient's contract).
 */
export function checkMirrorSourceUrl(
  raw: string,
  env: MirrorSettingsEnv,
): { url: URL; sanitized: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MirrorValidationError("The provided URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || /[\r\n\t]/.test(url.href)) {
    // §2.2: https-only sources (divergence, §1) and credentials only ever
    // arrive in the structured auth fields, so they can never leak into
    // logs, notices, or original_url.
    throw new MirrorValidationError("The provided URL is invalid.");
  }
  const mode = env.MIRROR_EGRESS_MODE === "strict" ? "strict" : "lax";
  const policy = parseHostPolicy(env.MIRROR_ALLOWED_HOST_LIST, mode);
  if (!checkMirrorSource(url, policy).allowed) {
    // Upstream's create-time text (routers/api/v1/repo/migrate.go:101-108).
    throw new MirrorValidationError("You can not import from disallowed hosts.");
  }
  return { url, sanitized: sanitizeUrl(url) };
}

/**
 * Derive the stored Authorization header value from the structured auth
 * fields (§2.2): an `auth_token` wins as `Bearer` (the modern source path);
 * otherwise username/password compose `Basic base64(user:pass)` exactly like
 * RFC 7617. Both present → Bearer (documented divergence: upstream tries
 * Basic and falls back to the token per request — the envelope stores ONE
 * header value, and the bearer form is the one modern forges accept).
 * Returns null for an anonymous mirror.
 */
export function deriveMirrorAuthHeader(options: MigrateOptions): string | null {
  if (options.auth_token !== undefined && options.auth_token !== "") {
    return `Bearer ${options.auth_token}`;
  }
  const user = options.auth_username ?? "";
  const pass = options.auth_password ?? "";
  if (user === "" && pass === "") return null;
  return `Basic ${base64Encode(new TextEncoder().encode(`${user}:${pass}`))}`;
}

// ---------------------------------------------------------------------------
// Registration + status
// ---------------------------------------------------------------------------

/** Wire shape of GET/POST mirror responses — a non-contract surface (like
 *  the imports family): sync_state and schedule are ours to shape. Epoch
 *  fields are unix seconds (0 = unscheduled); the SECRET never appears (the
 *  §4.2 envelope has no read arm). The §3.1 non-secret username and the
 *  has-credentials marker DO render — upstream's form binds the same pair
 *  ($address.Username + the "(Unchanged)"/"(Unset)" password placeholder,
 *  options.tmpl:165-171); the API status response carries them harmlessly. */
export interface MirrorStatus {
  remote_address: string;
  original_url: string;
  /** Go-duration string ("8h0m0s"); "0" = scheduling disabled (§2.3). */
  mirror_interval: string;
  interval_seconds: number;
  enable_prune: boolean;
  lfs_enabled: boolean;
  lfs_endpoint: string | null;
  /** The §3.1 non-secret username (upstream's remote-URL userinfo render). */
  credentials_username: string | null;
  /** Whether a credential envelope is stored — the password placeholder's
   *  "(Unchanged)" vs "(Unset)" arm; never the secret itself. */
  has_credentials: boolean;
  sync_state: "idle" | "queued" | "syncing";
  next_sync_at: number;
  last_sync_at: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** The target repo the route already resolved (api/services/repository.ts's
 *  pair, narrowed to the columns the CAS needs). */
export interface MirrorTargetRepo {
  id: string;
  ownerNamespace: string;
  slug: string;
}

/**
 * Attach a pull mirror to an EXISTING EMPTY repo (§2.2's into-empty shape):
 * CAS the repositories row (`is_mirror=true` + sanitized `original_url`),
 * insert the 1:1 `repo_mirrors` row due immediately (a lost sync enqueue
 * self-heals at the next cron tick; the success settle re-schedules to
 * `now + interval`, and `interval=0` settles back to unscheduled), then
 * seal the credentials into the §4.2 envelope.
 *
 * Guard order = the import channel's (§2.6): existing mirror row and active
 * import 409 first (the cheap arbiters), then the batch CAS decides the
 * empty/unarchived/ready race in one D1 transaction. The KEK is validated
 * BEFORE any write when credentials are present — a mirror registered
 * without its secret would only fail later at sync time.
 */
export async function registerMirror(
  db: D1Database,
  env: MirrorSettingsEnv,
  repo: MirrorTargetRepo,
  options: MigrateOptions,
): Promise<MirrorStatus> {
  // -- request-shaped validation (422 family, §2.2) -------------------------
  // Order mirrors upstream migrate.go: URL parse + egress gate (:101-108)
  // BEFORE the option checks (:159-166+).
  const source = checkMirrorSourceUrl(options.clone_addr, env);
  if (options.mirror !== true) {
    // This endpoint registers pull mirrors into an existing empty repo; the
    // one-time import (upstream migrate with mirror=false) is the import
    // channel's POST /imports + start (SPEC-0003 §2.6). 422, not silently
    // importing: dropping the flag would mint a snapshot the user cannot
    // distinguish from a mirror.
    throw new MirrorValidationError("migrate into an existing repository requires mirror=true");
  }
  if (options.service !== undefined && options.service !== "git") {
    // §2.2 accepted(v1): service unset or "git"; other forges are the
    // deferred metadata-migration scope (§1 out-of-scope list).
    throw new MirrorValidationError(`unsupported service: ${JSON.stringify(options.service)}`);
  }
  for (const flag of [
    options.wiki,
    options.issues,
    options.milestones,
    options.labels,
    options.pull_requests,
    options.releases,
  ]) {
    if (flag === true) {
      // §2.2: fail rather than silently dropping data (upstream's 422 text).
      throw new MirrorValidationError("metadata migration is not supported for this service");
    }
  }
  const intervalSeconds = parseMirrorInterval(options.mirror_interval);
  let lfsEndpoint: string | null = null;
  if (options.lfs_endpoint !== undefined && options.lfs_endpoint !== "") {
    // §4.1: the LFS endpoint URL gets the identical gate at accept time.
    lfsEndpoint = checkMirrorSourceUrl(options.lfs_endpoint, env).sanitized;
  }
  const authHeader = deriveMirrorAuthHeader(options);
  const kek = authHeader !== null ? readyKek(env) : null;

  // -- target-repo arbitration (409 family, §2.2 rows 4-5) ------------------
  const existing = await drizzle(db)
    .select({ repoId: repoMirrors.repoId })
    .from(repoMirrors)
    .where(eq(repoMirrors.repoId, repo.id))
    .get();
  if (existing !== undefined) {
    throw new MirrorConflictError("repository is already a pull mirror");
  }
  const activeImport = await drizzle(db)
    .select({ id: repoImports.id })
    .from(repoImports)
    .where(and(eq(repoImports.repoId, repo.id), inArray(repoImports.state, ["staged", "indexing", "finalizing"])))
    .get();
  if (activeImport !== undefined) {
    throw new MirrorConflictError("repository already has an active import");
  }

  // -- the atomic write: repo CAS + mirror insert (one D1 batch) ------------
  const dbd = drizzle(db);
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const results = await dbd.batch([
    dbd
      .update(repositories)
      .set({ isMirror: true, originalUrl: source.sanitized, updatedAt: now })
      .where(
        and(
          eq(repositories.id, repo.id),
          eq(repositories.isEmpty, true),
          eq(repositories.isArchived, false),
          eq(repositories.status, "ready"),
          eq(repositories.isMirror, false),
        ),
      ),
    dbd
      .insert(repoMirrors)
      .values({
        repoId: repo.id,
        intervalSeconds,
        enablePrune: true, // upstream Mirror.EnablePrune default (no migrate flag; PATCH owns it)
        lfsEnabled: options.lfs === true,
        lfsEndpoint,
        remoteAddress: source.sanitized,
        credentialsUsername: options.auth_username ?? null,
        credentialsCiphertext: null, // sealed below, once the row id exists (the AAD half)
        syncState: "idle",
        nextSyncAt: nowSec, // due immediately — see doc comment
        lastSyncAt: null,
        lastError: null,
      })
      .returning({ id: repoMirrors.id }),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0) {
    // The batch rolled back the insert: the repo row lost the CAS (a racing
    // import landed first, or it is not empty/ready after all).
    throw new MirrorConflictError(
      "repository is not migratable: it must be empty, unarchived and ready (and not already a mirror)",
    );
  }
  const mirrorId = results[1]?.[0]?.id ?? 0;

  // -- seal the credentials (§4.2) ------------------------------------------
  if (authHeader !== null && kek !== null) {
    // Row-move AAD binding needs the assigned id, hence this second write.
    // A failure here leaves the mirror registered ANONYMOUS (null
    // ciphertext) — the sync then 401s against the source and records a
    // sanitized last_error, instead of persisting a secret in the clear.
    const ciphertext = await encryptMirrorCredentials(kek, mirrorId, repo.id, authHeader);
    await drizzle(db)
      .update(repoMirrors)
      .set({ credentialsCiphertext: ciphertext, updatedAt: new Date() })
      .where(eq(repoMirrors.id, mirrorId));
  }

  const status = await getMirrorStatus(db, repo.id);
  if (status === null) {
    // The batch above committed both rows; this is the forks.ts
    // "row vanished after creation" shape — never silently 200.
    throw new MirrorConflictError("mirror row vanished after registration");
  }
  return status;
}

/**
 * The mirror status row for a repo (§2.3's "the sync_state row"), or null
 * when the repo has no mirror. Reads BOTH the 1:1 row and the repo's
 * sanitized origin so the response is self-contained.
 */
export async function getMirrorStatus(db: D1Database, repoId: string): Promise<MirrorStatus | null> {
  const row = await drizzle(db).select().from(repoMirrors).where(eq(repoMirrors.repoId, repoId)).get();
  if (row === undefined) return null;
  const repo = await drizzle(db)
    .select({ originalUrl: repositories.originalUrl })
    .from(repositories)
    .where(eq(repositories.id, repoId))
    .get();
  return {
    remote_address: row.remoteAddress,
    original_url: repo?.originalUrl ?? row.remoteAddress,
    mirror_interval: renderGoDuration(row.intervalSeconds),
    interval_seconds: row.intervalSeconds,
    enable_prune: row.enablePrune,
    lfs_enabled: row.lfsEnabled,
    lfs_endpoint: row.lfsEndpoint,
    credentials_username: row.credentialsUsername,
    has_credentials: row.credentialsCiphertext !== null,
    sync_state: row.syncState,
    next_sync_at: row.nextSyncAt,
    last_sync_at: row.lastSyncAt,
    last_error: row.lastError,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Settings WRITE arm (SPEC-0009 §2.3.1) — upstream `updateMirror`
// (routers/api/v1/repo/repo.go:1023-1135) for the API PATCH's five fields and
// `handleSettingsPostMirror` (routers/web/repo/setting/setting.go:279-372)
// for the web form's address/LFS extras, over the landed repo_mirrors row.
// ---------------------------------------------------------------------------

/** Wire shape of a settings write. Undefined = untouched (the API PATCH's
 *  Go-pointer semantics, structs/repo.go:246-255). `address`, `lfs` and
 *  `lfs_endpoint` are WEB-ONLY inputs — `EditRepoOption` has no address or
 *  LFS field (the cite decides: the API cannot move the source address, only
 *  the credential triple, repo.go:1104-1108 over structs/repo.go:246-255). */
export interface MirrorSettingsInput {
  /** Go-duration string; `"0"` disables scheduling (§2.3.1 validation). */
  interval?: string;
  enablePrune?: boolean;
  username?: string;
  password?: string;
  token?: string;
  /** New source address (web `mirror_address`); gated + sanitized. */
  address?: string;
  /** LFS mirror toggle (web `mirror_lfs` — the checkbox binding means the
   *  form ALWAYS sends it; unchecked arrives as `false` and disables). */
  lfs?: boolean;
  /** LFS endpoint (web `mirror_lfs_endpoint`); `""` clears to null. */
  lfsEndpoint?: string;
}

/** PATCH-side interval validation (§2.3.1 — the API arm's exact texts,
 *  repo.go:1044-1057): unparseable → `time: invalid duration "x"` (our
 *  grammar's signed-form refusals carry this text too — upstream parses
 *  negatives and hits the below-minimum arm instead; same 422 status, the
 *  documented register-arm grammar divergence); below the minimum →
 *  `invalid mirror interval: 5m0s is below minimum interval: 10m0s`. */
export function parsePatchMirrorInterval(raw: string): number {
  const seconds = parseGoDuration(raw);
  if (seconds === null) {
    throw new MirrorValidationError(`time: invalid duration ${JSON.stringify(raw)}`, "interval");
  }
  if (seconds !== 0 && seconds < MIRROR_MIN_INTERVAL_SECONDS) {
    throw new MirrorValidationError(
      `invalid mirror interval: ${renderGoDuration(seconds)} is below minimum interval: ${renderGoDuration(
        MIRROR_MIN_INTERVAL_SECONDS,
      )}`,
      "interval",
    );
  }
  return seconds;
}

/**
 * The settings write (§2.3.1). Loads the 1:1 row; **null when the repo has no
 * mirror** — the API arm's silent skip (repo.go:1029-1033: "Skip this update
 * if the repo is not a mirror, do not return error"), the web caller 404s on
 * it (setting.go:283-286).
 *
 * Field order ports upstream's: interval (parse + `ScheduleNextUpdate`
 * RE-SCHEDULE, mirror.go:71-77 — `now + interval`, `0` = unscheduled; the
 * ONLY reschedule in the surface — prune/credentials/address/LFS writes
 * neither reschedule nor wake the sync, upstream enqueues nothing) → prune →
 * credentials (decrypt-recompose-reseal per repo.go:1067-1103; the stored
 * §4.2 envelope stands in for upstream's credentials-in-remote-URL) →
 * address (the web-only move: gated + sanitized, written to the row AND
 * `repositories.original_url` — upstream `UpdateAddress`'s OriginalURL write,
 * mirror_pull.go:55-60; there is no git remote to rewrite, the sync reads
 * the row) → LFS columns. Every credential change re-runs the egress gate on
 * the stored address (upstream re-gates the composed address,
 * repo.go:1108-1112).
 *
 * `sync_state` is never touched here: the cron/consumer CAS owns it; a
 * settings write racing an in-flight sync can be overwritten by that sync's
 * settle (upstream holds the same race — its settle re-schedules from the
 * in-memory mirror copy).
 */
export async function updateMirrorSettings(
  db: D1Database,
  env: MirrorSettingsEnv,
  repoId: string,
  input: MirrorSettingsInput,
): Promise<MirrorStatus | null> {
  const row = await drizzle(db).select().from(repoMirrors).where(eq(repoMirrors.repoId, repoId)).get();
  if (row === undefined) return null;

  const set: Partial<typeof repoMirrors.$inferInsert> = { updatedAt: new Date() };
  const nowSec = Math.floor(Date.now() / 1000);

  // -- interval (repo.go:1041-1059): validate, then ScheduleNextUpdate ------
  if (input.interval !== undefined) {
    const seconds = parsePatchMirrorInterval(input.interval);
    set.intervalSeconds = seconds;
    // models/repo/mirror.go:71-77 — the interval arm is the only re-arm.
    set.nextSyncAt = seconds > 0 ? nowSec + seconds : 0;
  }

  // -- prune (repo.go:1061-1065) --------------------------------------------
  if (input.enablePrune !== undefined) {
    set.enablePrune = input.enablePrune;
  }

  // -- credentials (repo.go:1067-1103): compose from stored + patch ----------
  if (input.username !== undefined || input.password !== undefined || input.token !== undefined) {
    // Upstream re-gates the composed address (repo.go:1108-1112); the base
    // cannot change here, so the gate re-runs on the stored address — a host
    // the policy has since denied refuses the credential write (422 family).
    checkMirrorSourceUrl(row.remoteAddress, env);

    // The stored secret decomposed into upstream's remote-URL equivalents:
    // "Basic base64(u:p)" → (u, p); "Bearer t" → (username, t) — upstream
    // embeds the token AS the password. Decrypting needs the KEK; the 500
    // family fires closed (§4.2) exactly when the sync's decrypt would.
    let storedUsername: string | null = row.credentialsUsername ?? null;
    let storedPassword = "";
    if (row.credentialsCiphertext !== null) {
      const header = await decryptMirrorCredentials(env, row.id, repoId, row.credentialsCiphertext);
      if (header.startsWith("Bearer ")) {
        storedPassword = header.slice("Bearer ".length);
      } else if (header.startsWith("Basic ")) {
        const decoded = atob(header.slice("Basic ".length));
        const colon = decoded.indexOf(":");
        storedPassword = colon === -1 ? "" : decoded.slice(colon + 1);
        // The envelope's user half wins when the metadata column is bare.
        if ((storedUsername ?? "") === "" && colon > 0) storedUsername = decoded.slice(0, colon);
      }
    }

    // The recomposition (repo.go:1072-1090), verbatim semantics:
    const username = input.username !== undefined ? input.username : (storedUsername ?? "");
    let password = "";
    let token = "";
    if (input.password !== undefined) password = input.password;
    if (input.token !== undefined) token = input.token;
    // The stored password carries over ONLY when neither secret was given
    // AND the username is unchanged-or-empty — a username-only change to a
    // DIFFERENT username drops it (the `mirror_password_help` locale:
    // "Change the username to erase a stored password.").
    if (input.password === undefined && input.token === undefined && storedUsername !== null) {
      if (username === "" || username === storedUsername) password = storedPassword;
    }
    if (token !== "") password = token;

    // The header derivation = the register arm's (deriveMirrorAuthHeader):
    // a non-empty token wins as Bearer; otherwise Basic over the pair; both
    // empty = anonymous (upstream's len(user)+len(pass) == 0 anonymous
    // remote, modules/git/remote.go:84-87).
    const authHeader = token !== "" ? `Bearer ${token}` : deriveBasicHeader(username, password);
    set.credentialsUsername = authHeader === null ? null : username;
    if (authHeader === null) {
      set.credentialsCiphertext = null;
    } else {
      const kek = readyKek(env);
      set.credentialsCiphertext = await encryptMirrorCredentials(kek, row.id, repoId, authHeader);
    }
  }

  // -- address (web-only; setting.go:332-345 + UpdateAddress) ----------------
  let repoOriginalUrl: string | undefined;
  if (input.address !== undefined) {
    const source = checkMirrorSourceUrl(input.address, env);
    set.remoteAddress = source.sanitized;
    // UpdateAddress's second half (mirror_pull.go:55-60): the repo's
    // sanitized origin moves with the mirror's address.
    repoOriginalUrl = source.sanitized;
  }

  // -- LFS columns (setting.go:346-367) --------------------------------------
  if (input.lfs !== undefined) {
    set.lfsEnabled = input.lfs;
  }
  if (input.lfsEndpoint !== undefined) {
    if (input.lfsEndpoint === "") {
      set.lfsEndpoint = null;
    } else {
      // The register arm's identical gate (§4.1); upstream validates the
      // endpoint URL and runs IsMigrateURLAllowed (setting.go:348-361).
      set.lfsEndpoint = checkMirrorSourceUrl(input.lfsEndpoint, env).sanitized;
    }
  }

  const dbd = drizzle(db);
  if (repoOriginalUrl !== undefined) {
    await dbd.batch([
      dbd.update(repoMirrors).set(set).where(eq(repoMirrors.repoId, repoId)),
      dbd
        .update(repositories)
        .set({ originalUrl: repoOriginalUrl, updatedAt: new Date() })
        .where(eq(repositories.id, repoId)),
    ]);
  } else {
    await dbd.update(repoMirrors).set(set).where(eq(repoMirrors.repoId, repoId));
  }

  const status = await getMirrorStatus(db, repoId);
  if (status === null) {
    // The row existed at load; a delete racing the write is the only path.
    throw new MirrorConflictError("mirror row vanished during the settings write");
  }
  return status;
}

/** `Basic base64(user:pass)` over the composed pair; both empty → null (the
 *  anonymous form — deriveMirrorAuthHeader's register-arm shape). */
function deriveBasicHeader(username: string, password: string): string | null {
  if (username === "" && password === "") return null;
  return `Basic ${base64Encode(new TextEncoder().encode(`${username}:${password}`))}`;
}

/** The decrypt half of the §4.2 envelope — byte-for-byte sync.ts
 *  `mirrorAuthHeader`'s format (nonce[12] || AES-256-GCM, AAD
 *  `${mirrorId}:${repoId}`), re-implemented LOCALLY because this module is
 *  deliberately engine-free (the route-graph boundary, the module header):
 *  sync.ts imports the engine, this file must not reach it. The
 *  mirror.test.ts round-trip cross-verifies the two halves. */
async function decryptMirrorCredentials(
  env: MirrorSettingsEnv,
  mirrorId: number,
  repoId: string,
  ciphertext: string,
): Promise<string> {
  const kek = env.MIRROR_CREDENTIAL_KEY;
  if (kek === undefined || kek === "") {
    throw new MirrorCredentialKeyError(
      "MIRROR_CREDENTIAL_KEY is not configured; stored mirror credentials cannot be recomposed",
    );
  }
  const raw = base64Decode(ciphertext);
  if (raw.length < 12 + 16) {
    throw new MirrorCredentialKeyError("mirror credential ciphertext is truncated");
  }
  const key = await crypto.subtle.importKey("raw", base64Decode(kek), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: raw.slice(0, 12),
      additionalData: new TextEncoder().encode(`${mirrorId}:${repoId}`),
      tagLength: 128,
    },
    key,
    raw.slice(12),
  );
  return new TextDecoder().decode(plain);
}

// ---------------------------------------------------------------------------
// credential envelope — the encrypt half of sync.ts's mirrorAuthHeader
// ---------------------------------------------------------------------------

/** Validate (and return) the base64 KEK — 32 bytes for AES-256. Only consulted
 *  when credentials are being stored; anonymous mirrors never touch it. */
function readyKek(env: MirrorSettingsEnv): string {
  const kek = env.MIRROR_CREDENTIAL_KEY;
  if (kek === undefined || kek === "") {
    throw new MirrorCredentialKeyError(
      "MIRROR_CREDENTIAL_KEY is not configured; source credentials cannot be stored",
    );
  }
  if (base64Decode(kek).length !== 32) {
    throw new MirrorCredentialKeyError("MIRROR_CREDENTIAL_KEY must be 32 bytes, base64-encoded");
  }
  return kek;
}

/** The §4.2 envelope: `base64( nonce[12] || AES-256-GCM(plaintext) )`, AAD
 *  `${mirrorId}:${repoId}` — byte-for-byte what sync.ts's mirrorAuthHeader
 *  decrypts (its doc comment is the contract; wrong AAD = row-swap rejected). */
async function encryptMirrorCredentials(
  kek: string,
  mirrorId: number,
  repoId: string,
  authHeader: string,
): Promise<string> {
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

// ---------------------------------------------------------------------------
// base64 helpers (Web-standard atob/btoa; byte-safe both ways)
// ---------------------------------------------------------------------------

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
