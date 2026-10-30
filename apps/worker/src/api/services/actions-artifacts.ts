/**
 * The /api/v1 Actions ARTIFACTS family service (the board's P1-10 row,
 * docs/residuals-v1.3.2.md): the `ActionArtifact` wire render, the artifact
 * id lookup, the repo-scoped finalized list, the signed download-URL
 * machinery and the v4 read-storage serve, over the LANDED artifact store
 * (services/actions/artifacts*.ts — the signed-URL primitives, the expiry
 * clamps, the R2 store). Upstream anchors at pin fc493688:
 *   - handlers routers/api/v1/repo/action.go:1863-2151 (GetArtifacts /
 *     GetArtifact / DeleteArtifact / DownloadArtifact + DownloadArtifactRaw
 *     and the shared getArtifactByPathParam);
 *   - the signed download-URL build buildSignature/buildSigURL/
 *     buildDownloadRawEndpoint (action.go:2010-2025) — HMAC tag "api" over
 *     (endpoint, unix-expires, artifactID), 60-minute expiry, base64
 *     raw-url (secrets.ts's actionsBuildSignature framing);
 *   - the converter ToActionArtifact (services/convert/convert.go:771-791)
 *     over the `ActionArtifact`/`ActionArtifactsResponse` wire
 *     (modules/structs/repo_actions.go:89-104/160-164);
 *   - IsArtifactV4 + the read-storage serve (services/actions/artifacts.go:
 *     18-58, ServeUserContentByFile — modules/httplib/serve.go:56-140).
 *
 * Divergences are documented at their sites; the headline ones:
 *   - ServeDirect (artifacts.go:34-45) is not attempted — this store has no
 *     public bucket URL composer, and upstream serves the SAME read-storage
 *     arm whenever ServeDirect is unconfigured (the C4 web-UI twin's note,
 *     ui/pages/repo-actions-artifacts-download.ts);
 *   - the list is a repo-scoped drizzle query here (the landed
 *     findReadableArtifacts scopes by run, not repo — upstream
 *     FindArtifactsOptions carries both; the SQL mirrors ToConds verbatim,
 *     models/actions/artifact.go:159-201).
 */

import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actionArtifacts, repoUnits } from "../../db/schema";
import {
  ARTIFACT_STATUS_EXPIRED,
  ARTIFACT_STATUS_UPLOAD_CONFIRMED,
  type ArtifactRow,
} from "../../services/actions/artifacts";
import {
  actionsBuildSignature,
  base64RawUrlDecode,
  base64RawUrlEncode,
  signaturesEqual,
} from "../../services/actions/secrets";
import type { RepositoryWithOwner } from "./repository";

type D1 = D1Database;

// ---------------------------------------------------------------------------
// Error messages (action.go's ctx.APIError texts — byte-exact, case and all)
// ---------------------------------------------------------------------------

/** getArtifactByPathParam's miss (action.go:2149 — lowercase 'a'). */
export const ARTIFACT_NOT_FOUND_MESSAGE = "artifact not found";
/** The v3 fallthrough of the by-id handlers (action.go:1953/1989/2078 —
 *  uppercase 'A': "v3 not supported due to not having one unique id"). */
export const ARTIFACT_V3_NOT_FOUND_MESSAGE = "Artifact not found";
/** The expired arm (action.go:2069-2071). */
export const ARTIFACT_EXPIRED_MESSAGE = "Artifact has expired";
/** reqRepoWriter's 403 (api.go:396). */
export const REPO_WRITER_403_MESSAGE = "user should have a permission to write to a repo";
/** reqRepoReader's 403 (api.go:406). */
export const REPO_READER_403_MESSAGE =
  "user should have specific read permission or be a repo admin or a site admin";
/** DownloadArtifactRaw's expired-link 401 (action.go:2099). */
export const SIGNATURE_LINK_EXPIRED_MESSAGE = "Error link expired";

// ---------------------------------------------------------------------------
// The by-id lookup (getArtifactByPathParam, action.go:2138-2151)
// ---------------------------------------------------------------------------

/** Go chi's PathParamInt64 — junk parses to 0 and falls into the miss arm
 *  (services/context/base_path.go:35-38; the file-local port convention). */
export function artifactPathId(raw: string): number {
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : 0;
}

/**
 * getArtifactByPathParam (action.go:2138-2151): fetch by id, then the miss
 * arms — not found, a RepoID mismatch ("only check RepoID here, because the
 * repository owner may change over the time"), or a status outside
 * {UploadConfirmed, Expired} (un-merged/pending-deletion rows are invisible)
 * all answer the SAME 404 "artifact not found". Null = that 404.
 */
export async function artifactByPathParam(d1: D1, repoId: string, rawId: string): Promise<ArtifactRow | null> {
  const id = artifactPathId(rawId);
  const rows = await drizzle(d1)
    .select()
    .from(actionArtifacts)
    .where(eq(actionArtifacts.id, id))
    .limit(1);
  const art = rows[0];
  if (
    art === undefined ||
    art.repoId !== repoId ||
    (art.status !== ARTIFACT_STATUS_UPLOAD_CONFIRMED && art.status !== ARTIFACT_STATUS_EXPIRED)
  ) {
    return null;
  }
  return art;
}

/** IsArtifactV4 (services/actions/artifacts.go:18-20): the v4 backend stores
 *  one zip per artifact and guarantees ContentEncodingOrType is a content
 *  type (the slash-containing marker upstream's comment spells "*"
 *  "/" "*"); v3 rows carry "gzip" or chunk spellings without a slash. */
export function isArtifactV4(art: ArtifactRow): boolean {
  return art.contentEncodingOrType.includes("/");
}

// ---------------------------------------------------------------------------
// The repo-scoped finalized list (GetArtifacts, action.go:1877-1913, over
// FindArtifactsOptions.ToConds — models/actions/artifact.go:159-201)
// ---------------------------------------------------------------------------

/**
 * The GetArtifacts query: repo scope + the optional `name` filter + the
 * FinalizedArtifactsV4 pair ((status CONFIRMED or EXPIRED) and
 * content_encoding LIKE '%/%') ordered by id, COUNTed before pagination
 * (db.FindAndCount). The store's own finder scopes by run — upstream's
 * ToConds carries RepoID for exactly this caller, so the SQL lands here
 * (one service, two queries) without widening the landed store's surface.
 */
export async function listRepoArtifacts(
  d1: D1,
  repoId: string,
  nameFilter: string,
  page: number,
  limit: number,
): Promise<{ rows: ArtifactRow[]; total: number }> {
  const db = drizzle(d1);
  const conds: SQL[] = [eq(actionArtifacts.repoId, repoId)];
  if (nameFilter !== "") {
    conds.push(eq(actionArtifacts.artifactName, nameFilter));
  }
  conds.push(
    sql`(${actionArtifacts.status} = ${ARTIFACT_STATUS_UPLOAD_CONFIRMED} OR ${actionArtifacts.status} = ${ARTIFACT_STATUS_EXPIRED})`,
  );
  // "*/*" means the field is a content type (artifact.go:190-192).
  conds.push(sql`${actionArtifacts.contentEncodingOrType} LIKE ${"%/%"}`);
  const where = and(...conds);

  const countRows = await db
    .select({ total: sql<number>`count(*)` })
    .from(actionArtifacts)
    .where(where);
  const total = Number(countRows[0]?.total ?? 0);
  const rows = await db
    .select()
    .from(actionArtifacts)
    .where(where)
    .orderBy(asc(actionArtifacts.id))
    .limit(limit)
    .offset((page - 1) * limit);
  return { rows, total };
}

// ---------------------------------------------------------------------------
// The wire render (ToActionArtifact, services/convert/convert.go:771-791)
// ---------------------------------------------------------------------------

/** The Go zero time (services/repository.ts carries the landed constant;
 *  the file-local trio convention keeps this module dependency-thin). */
const GO_ZERO_TIME = "0001-01-01T00:00:00Z";

/** Non-integer TEXT ids render the documented 0 in int64 wire fields
 *  (repository.ts's repositoryIdNumber — the TODO(SPEC-0005) note). */
function repositoryIdNumber(id: string): number {
  const parsed = Number(id);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/** Go time.Unix(seconds, 0).UTC() — expired_unix keeps upstream's
 *  0 = keep-forever sentinel, and 0 renders the epoch, NOT the zero time
 *  (AsLocalTime of 0). */
function isoFromUnixSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * ToActionArtifact (convert.go:771-791): url = repo.APIURL() +
 * "/actions/artifacts/{id}" (repo.APIURL is AppURL + api/v1/repos/{owner}/
 * {repo}), ArchiveDownloadURL = url + "/zip", Expired = status==Expired, and
 * the embedded `workflow_run` carries ONLY {ID, RepositoryID, HeadSha} —
 * every other ActionWorkflowRun field serializes at its zero value (the
 * struct has no omitempty on the string/time fields; the empty strings, the
 * 0 attempt/number, the null previous_attempt_url, the empty pull_requests
 * array and the four zero times are the upstream render of this embed).
 */
export function toApiArtifact(pair: RepositoryWithOwner, origin: string, art: ArtifactRow) {
  const base = `${origin}/api/v1/repos/${encodeURIComponent(pair.repo.ownerNamespace)}/${encodeURIComponent(pair.repo.slug)}`;
  const url = `${base}/actions/artifacts/${art.id}`;
  return {
    id: art.id,
    name: art.artifactName,
    size_in_bytes: art.fileSize,
    url,
    archive_download_url: `${url}/zip`,
    expired: art.status === ARTIFACT_STATUS_EXPIRED,
    workflow_run: {
      id: art.runId,
      url: "",
      previous_attempt_url: null,
      html_url: "",
      jobs_url: "",
      logs_url: "",
      artifacts_url: "",
      cancel_url: "",
      rerun_url: "",
      display_title: "",
      path: "",
      event: "",
      run_attempt: 0,
      run_number: 0,
      repository_id: repositoryIdNumber(art.repoId),
      head_sha: art.commitSha,
      status: "",
      pull_requests: [],
      created_at: GO_ZERO_TIME,
      updated_at: GO_ZERO_TIME,
      started_at: GO_ZERO_TIME,
      completed_at: GO_ZERO_TIME,
    },
    created_at: art.created.toISOString(),
    updated_at: art.updated.toISOString(),
    expires_at: isoFromUnixSeconds(art.expiredUnix),
  };
}

// ---------------------------------------------------------------------------
// The signed download URL (buildSignature/buildSigURL,
// action.go:2010-2025) + the raw endpoint's verification
// ---------------------------------------------------------------------------

/** buildDownloadRawEndpoint (action.go:2013-2016): the SIGNED PATH —
 *  "api/v1/repos/{owner}/{repo}/actions/artifacts/{id}/zip/raw" with the
 *  path-escaped owner/repo. Go's url.PathEscape leaves the RFC 3986
 *  unreserved set plus sub-delims loose; encodeURIComponent is stricter
 *  ($&+,/;:=?@ escape) — both build and verify use THIS one function, so
 *  the framing is self-consistent (the port's symmetry is what the HMAC
 *  pins, not the exact escape table). */
export function buildDownloadRawEndpoint(ownerName: string, repoName: string, artifactId: number): string {
  return `api/v1/repos/${encodeURIComponent(ownerName)}/${encodeURIComponent(repoName)}/actions/artifacts/${artifactId}/zip/raw`;
}

/** buildSignature (action.go:2010-2012): actions.BuildSignature("api", endp,
 *  expires, artifactID) — the tag+"api" framing of secrets.ts's port. */
function buildSignature(env: Env, endpoint: string, expires: string, artifactId: number): Promise<Uint8Array> {
  return actionsBuildSignature(env, "api", [endpoint, expires, String(artifactId)]);
}

/**
 * buildSigURL (action.go:2018-2024): expires = now + 60 minutes (unix
 * seconds — the /api/v1 spelling, unlike the v4 pipeline's Go-layout time
 * string), sig = base64 raw-url, URL = AppURL + endpoint + "?sig=" +
 * ... + "&expires=" ... . appUrl carries AppURL's trailing slash
 * (services/actions/routes.ts appUrlOf's shape).
 */
export async function buildSigUrl(
  env: Env,
  appUrl: string,
  ownerName: string,
  repoName: string,
  artifactId: number,
): Promise<string> {
  const endpoint = buildDownloadRawEndpoint(ownerName, repoName, artifactId);
  const expires = Math.floor(Date.now() / 1000) + 60 * 60;
  const sig = await buildSignature(env, endpoint, String(expires), artifactId);
  return `${appUrl}${endpoint}?sig=${base64RawUrlEncode(sig)}&expires=${String(expires)}`;
}

/** The DownloadArtifactRaw prelude (action.go:2086-2101): decode the sig
 *  (RawURLEncoding), constant-time compare against the rebuilt signature
 *  (hmac.Equal — signaturesEqual's XOR-fold), then the expiry check. The
 *  ORDER is upstream's: a bad sig is the APIErrorNotFound 404 ("not
 *  found"), a good sig past its expiry is the 401 "Error link expired"; a
 *  junk base64 or junk number decodes/parse-fails into the 404/401 arms
 *  respectively (Go ignores the decode error and ParseInt's zero). */
export async function verifyArtifactDownloadSig(
  env: Env,
  raw: { sig: string; expires: string; endpoint: string; artifactId: number },
): Promise<{ outcome: "ok" } | { outcome: "bad-sig" } | { outcome: "expired" }> {
  let sigBytes: Uint8Array;
  try {
    sigBytes = base64RawUrlDecode(raw.sig);
  } catch {
    return { outcome: "bad-sig" };
  }
  const expected = await buildSignature(env, raw.endpoint, raw.expires, raw.artifactId);
  if (!signaturesEqual(sigBytes, expected)) {
    return { outcome: "bad-sig" };
  }
  const expires = /^-?\d+$/.test(raw.expires) ? Number.parseInt(raw.expires, 10) : 0;
  if (new Date(expires * 1000) < new Date()) {
    return { outcome: "expired" };
  }
  return { outcome: "ok" };
}

// ---------------------------------------------------------------------------
// The v4 read-storage serve (DownloadArtifactV4ReadStorage,
// services/actions/artifacts.go:47-58, over ServeUserContentByFile —
// modules/httplib/serve.go:56-140/232-240)
// ---------------------------------------------------------------------------

/** Go path.Base (the POSIX algorithm — the C4 module's port). */
export function goPathBase(p: string): string {
  if (p === "") return ".";
  let end = p.length;
  while (end > 0 && p[end - 1] === "/") end--;
  if (end === 0) return "/";
  const start = p.lastIndexOf("/", end - 1) + 1;
  return p.slice(start, end);
}

/** getSafeName + encodeContentDisposition (content_disposition.go:16-65):
 *  the ASCII-safe quoted form plus the RFC 2231 filename* twin when any
 *  rune needed masking (the C4 module's port, byte-equal). */
function encodeContentDisposition(kind: "inline" | "attachment", filename: string): string {
  let safe = "";
  let needsEncoding = false;
  for (const char of filename) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 0x20 || code > 0x7e) && code !== 0x09) {
      needsEncoding = true;
      safe += "_";
    } else {
      safe += char;
    }
  }
  const quoted = (value: string): string =>
    /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(value) ? value : `"${value.replaceAll(`"`, `\\"`)}"`;
  const base = `${kind}; filename=${quoted(safe)}`;
  if (!needsEncoding) return base;
  return `${base}; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** serveSetHeadersByUserContent's disposition (serve.go:135-140): the v4
 *  caller always passes ContentType, MimeTypeMap is off, so the computed
 *  disposition is inline unless the type is an SVG image — and a zip never
 *  is. ContentDispositionInline + path.Base(filename). */
function artifactDisposition(artifactPath: string): string {
  return encodeContentDisposition("inline", goPathBase(artifactPath));
}

/** serveHeaderCspDefault / serveHeaderCspPdf (serve.go:44-56). */
const CSP_SANDBOX = "sandbox allow-scripts allow-modals allow-popups allow-downloads";
const CSP_PDF = "default-src 'none'; style-src 'unsafe-inline'";

/** httpcache's prod default shape (httpcache.go:23-41, MaxAge 0). */
const CACHE_CONTROL_NO_CACHE = "max-age=0, private, must-revalidate";

/** The ServeSetHeaders content-related block (serve.go:56-84): content type
 *  (the row's v4 content type — never empty on this arm), nosniff, and the
 *  CSP class by type prefix. */
function serveContentHeaders(contentType: string, disposition: string, lastModified: Date | null): Headers {
  const headers = new Headers();
  headers.set("content-type", contentType);
  headers.set("x-content-type-options", "nosniff");
  if (contentType.startsWith("application/pdf")) headers.set("content-security-policy", CSP_PDF);
  else if (!contentType.startsWith("video/") && !contentType.startsWith("audio/")) {
    headers.set("content-security-policy", CSP_SANDBOX);
  }
  headers.set("content-disposition", disposition);
  headers.set("access-control-expose-headers", "Content-Disposition");
  headers.set("cache-control", CACHE_CONTROL_NO_CACHE);
  if (lastModified !== null) headers.set("last-modified", lastModified.toUTCString());
  return headers;
}

/** The minimal single-range port of ServeUserContentByReader's tail
 *  (serve.go:174-227) — "bytes=start-end" / "bytes=start-" only, upstream
 *  serves the FIRST range shape; the 416/400 arms are http.Error's plain
 *  text (with the trailing newline Go's http.Error appends). The C4 web-UI
 *  module carries the byte-equal port; this is the API arm of the same
 *  upstream helper. */
type RangeServe =
  | { kind: "full" }
  | { kind: "partial"; body: ReadableStream<Uint8Array> }
  | { kind: "error"; status: 416 | 400; message: string };

async function parseRangeServe(
  bucket: R2Bucket,
  storagePath: string,
  size: number,
  rangeHeader: string | null,
  headers: Headers,
): Promise<RangeServe> {
  if (size <= 0 || rangeHeader === null || !rangeHeader.startsWith("bytes=")) {
    headers.set("content-length", String(size));
    return { kind: "full" };
  }
  const rangeParts = rangeHeader.slice("bytes=".length);
  const [startRaw, endRaw] = rangeParts.split("-", 2);
  const parseStrict = (raw: string): number => (/^[+-]?[0-9]+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN);
  const start = parseStrict(startRaw ?? "");
  if (!Number.isFinite(start) || start < 0 || start >= size) {
    return { kind: "error", status: 416, message: "invalid start range" };
  }
  let end: number;
  if (endRaw === undefined) {
    return { kind: "error", status: 400, message: "invalid end range" };
  }
  if (endRaw === "") {
    end = size - 1;
  } else {
    end = parseStrict(endRaw);
    if (!Number.isFinite(end)) return { kind: "error", status: 400, message: "invalid end range" };
    if (end >= size) end = size - 1;
  }
  if (end < start) return { kind: "error", status: 400, message: "invalid end range" };
  const length = end - start + 1;
  headers.set("content-range", `bytes ${start}-${end}/${size}`);
  headers.set("content-length", String(length));
  const ranged = await bucket.get(storagePath, { range: { offset: start, length } });
  if (ranged === null) throw new Error(`storage open "${storagePath}": object missing`);
  return { kind: "partial", body: ranged.body as ReadableStream<Uint8Array> };
}

/**
 * The raw endpoint's v4 arm: the stored single-zip object served verbatim
 * with the ServeUserContentByFile header chain (the inline disposition over
 * the artifactPath's base, the stored content type, Last-Modified from the
 * object's upload time — ServeUserContentByFile's file.Stat) and the
 * minimal range support. Throws on a missing object — the caller renders
 * upstream's storage-error arm (APIErrorInternal → the 500 family).
 */
export async function serveArtifactV4Raw(
  env: Env,
  art: ArtifactRow,
  rangeHeader: string | null,
): Promise<Response> {
  const obj = await env.REPO_PACKS.get(art.storagePath);
  if (obj === null) {
    throw new Error(`storage open "${art.storagePath}": object missing`);
  }
  const headers = serveContentHeaders(art.contentEncodingOrType, artifactDisposition(art.artifactPath), obj.uploaded);
  const served = await parseRangeServe(env.REPO_PACKS, art.storagePath, obj.size, rangeHeader, headers);
  if (served.kind === "error") {
    // http.Error(w, err.Error(), status): the plain-text body over the
    // already-set serve headers.
    return new Response(`${served.message}\n`, { status: served.status, headers });
  }
  const body = served.kind === "full" ? (obj.body as ReadableStream<Uint8Array>) : served.body;
  return new Response(body, { status: served.kind === "full" ? 200 : 206, headers });
}

// ---------------------------------------------------------------------------
// The unit gate (reqRepoReader(TypeActions), api.go:403-410)
// ---------------------------------------------------------------------------

/**
 * reqRepoReader(TypeActions): CanRead(TypeActions) || repo-admin ||
 * site-admin. The landed reduction (the C4/C8 twin's note — "the
 * resolveRepositoryForViewer grant IS the unit read; this store has no
 * unit ACL"): visibility is already enforced by requireVisibleRepo, so the
 * remaining arm is the actions UNIT's existence — the `repo_units`
 * type='actions' row, the same store the runner scan gates on
 * (services/actions/model.ts:657). A visible repo WITHOUT the unit row
 * 403s non-admins with upstream's exact message; the admin OR-clause is
 * services/repo-access.ts's isRepositoryAdmin. The store's row lifetime is
 * the settings-module lockstep write (saveRepoSettings' unit-toggle arms).
 */
export async function actionsUnitRowExists(d1: D1, repoId: string): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ one: sql<number>`1` })
    .from(repoUnits)
    .where(and(eq(repoUnits.repoId, repoId), eq(repoUnits.type, "actions")))
    .limit(1);
  return rows.length > 0;
}

/** The 302 body Go's http.Redirect writes for GET requests (net/http):
 *  the anchor over the HTML-escaped location, Content-Type
 *  "text/html; charset=utf-8". html.EscapeString escapes < > & ' " . */
export function goRedirectBody(location: string): string {
  const escaped = location
    .replaceAll("&", "&amp;")
    .replaceAll("'", "&#39;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(`"`, "&#34;");
  return `<a href="${escaped}">Found</a>.\n`;
}
