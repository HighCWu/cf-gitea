/**
 * The PyPI registry protocol service (SPEC-0016 §7 M3) — the service half of
 * `/api/packages/{username}/pypi/...` (upstream
 * routers/api/packages/pypi/pypi.go over CreatePackageOrAddFileToExisting /
 * OpenFileForDownloadByPackageNameAndVersion, packages.go:160/:594):
 *
 * - Upload: twine's multipart form (upstream `ctx.Req.FormFile("content")` +
 *   FormValue reads, pypi.go:105-159). The wire is scanned in a bounded
 *   STREAMING pass over the spooled body — form fields are small and
 *   collected, the `content` file part is never buffered: its byte range in
 *   the spool object is recorded while its digests are computed in the same
 *   pass (the store's single-pass discipline, blobs.ts). The second pass
 *   ranges exactly that span out of the spool into the content key. Upstream's
 *   arms port in order: missing content part → 400, `sha256_digest`
 *   mismatch → 400 "hash mismatch" (EqualFold, pypi.go:122), normalized name
 *   + PEP 440 version mismatch → 400 "invalid name or version"
 *   (pypi.go:132-136), duplicate file → 409, quota → 403, created → 201.
 * - The PEP 503 simple index (`/simple/{id}`, pypi.go:47-75): all versions of
 *   the normalized package, sorted by the raw version string (upstream's
 *   strings.Compare, pypi.go:67-69), rendered through the
 *   templates/api/packages/pypi/simple.tmpl anchor shape (whitespace-faithful
 *   port; values HTML-escaped as Go's html/template does).
 * - Download (`/files/{id}/{version}/{filename}`): the version → file → blob
 *   walk with the lead-file GET download-counter bump (packages.go:655-660).
 *
 * Divergences (documented per AGENTS.md): multipart header/field sizes are
 * capped (upstream buffers the whole form in memory); `FormValue` semantics
 * answer the FIRST value of a repeated field while `project_urls` collects
 * ALL values (upstream reads the Form slice, pypi.go:143); MD5 stays NULL
 * (Workers' WebCrypto has no MD5 — the landed blob-row note).
 */

import {
  type PackageBlobRow,
  type PackageDoer,
  type PackageFileRow,
  type PackageOwnerRow,
  type PackagesQuotaConfig,
  type PackageRow,
  type PackageVersionRow,
  UNLIMITED_QUOTA,
  QuotaTotalCountError,
  checkSizeQuotaExceeded,
  countVersions,
  getFileDescriptors,
  getFileForVersionByName,
  getOrInsertPackage,
  getOrInsertVersion,
  getPackageByName,
  getVersionByNameAndVersion,
  incrementDownloadCounter,
  searchVersions,
  tryInsertFile,
  type InsertFileResult,
} from "./model";
import {
  getOrInsertBlob,
  packageBlobContentKey,
  spoolAndHash,
  type SpooledBlob,
} from "./blobs";
import { isValidAbsoluteHttpUrl, writeVersionMetadata } from "./protocol-common";
import { DuplicatePackageFileError } from "./generic";

// ---------------------------------------------------------------------------
// Upstream's normalizer + matchers (pypi.go:25-39), ported verbatim
// ---------------------------------------------------------------------------

/** The PEP 503/426 name normalizer: "." and "_" fold to "-" (pypi.go:27). */
export function normalizePypiName(name: string): string {
  return name.replaceAll(".", "-").replaceAll("_", "-");
}

/** nameMatcher (pypi.go:28 — PEP 426 name). */
const PYPI_NAME_REGEX = /^(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9.\-_]*[a-zA-Z0-9])$/;

/** versionMatcher (pypi.go:32-39 — PEP 440 appendix B). */
const PYPI_VERSION_REGEX =
  /^v?(?:[0-9]+!)?[0-9]+(?:\.[0-9]+)*(?:[-_.]?(?:a|b|c|rc|alpha|beta|pre|preview)[-_.]?[0-9]*)?(?:-[0-9]+|[-_.]?(?:post|rev|r)[-_.]?[0-9]*)?(?:[-_.]?dev[-_.]?[0-9]*)?(?:\+[a-z0-9]+(?:[-_.][a-z0-9]+)*)?$/;

/** isValidNameAndVersion (pypi.go:227-229) — the normalization happens BEFORE. */
export function isValidPypiNameAndVersion(packageName: string, packageVersion: string): boolean {
  return PYPI_NAME_REGEX.test(packageName) && PYPI_VERSION_REGEX.test(packageVersion);
}

/**
 * normalizeLabel (pypi.go:212-225): a Project-URL label normalizes by
 * deleting all ASCII punctuation and whitespace, then lowercasing
 * (packaging.python.org well-known-project-urls).
 */
export function normalizeProjectUrlLabel(label: string): string {
  let out = "";
  for (const char of label) {
    const code = char.codePointAt(0) ?? 0;
    const isAsciiPunct =
      (code >= 0x21 && code <= 0x2f) ||
      (code >= 0x3a && code <= 0x40) ||
      (code >= 0x5b && code <= 0x60) ||
      (code >= 0x7b && code <= 0x7e);
    const isWhitespace = /\s/.test(char);
    if (isAsciiPunct || isWhitespace) continue;
    out += char.toLowerCase();
  }
  return out;
}

// ---------------------------------------------------------------------------
// The upload protocol errors (each maps to its upstream status at the route)
// ---------------------------------------------------------------------------

/** Malformed multipart body or a scan cap exceeded (→ 400; upstream's
 *  FormFile/FormValue parse failures are 400s too, pypi.go:106-110). */
export class PypiFormError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PypiFormError";
  }
}

/** No (non-empty) `content` file part (→ 400, pypi.go:106-110). */
export class PypiMissingContentError extends Error {
  constructor() {
    super("the content file field is missing");
    this.name = "PypiMissingContentError";
  }
}

/** `sha256_digest` contradicts the streamed bytes (→ 400 "hash mismatch",
 *  pypi.go:122). */
export class PypiHashMismatchError extends Error {
  constructor() {
    super("hash mismatch");
    this.name = "PypiHashMismatchError";
  }
}

/** The normalized name/version fails the PEP matchers (→ 400 "invalid name
 *  or version", pypi.go:134-136). */
export class PypiInvalidNameOrVersionError extends Error {
  constructor() {
    super("invalid name or version");
    this.name = "PypiInvalidNameOrVersionError";
  }
}

// ---------------------------------------------------------------------------
// Twine multipart scan — the bounded streaming form parser
// ---------------------------------------------------------------------------

/** The recorded `content` file part: its byte range inside the spool object
 *  plus the digests computed while the scan streamed the part. */
export interface ScannedContentFile {
  filename: string;
  /** Absolute byte offsets INSIDE the spooled multipart body. */
  start: number;
  end: number;
  sha1: string;
  sha256: string;
  sha512: string;
}

export interface ScannedTwineForm {
  /** Every field's values in wire order (project_urls repeats). */
  fields: Map<string, string[]>;
  contentFile: ScannedContentFile | null;
}

/** FormValue semantics: the FIRST value of the field. */
export function firstField(fields: Map<string, string[]>, name: string): string | undefined {
  return fields.get(name)?.[0];
}

/** `ctx.Req.Form[name]` semantics: every value of the field. */
export function allFields(fields: Map<string, string[]>, name: string): string[] {
  return fields.get(name) ?? [];
}

// Scan caps — upstream reads the whole form into memory; ours bounds each
// header block, each field and the whole preamble (a reduction, documented).
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_FIELD_BYTES = 1024 * 1024;
const MAX_TOTAL_FIELD_BYTES = 8 * 1024 * 1024;
const MAX_PREAMBLE_BYTES = 64 * 1024;

/** Incremental SHA-1/256/512 over the forwarded file-part chunks (the
 *  blobs.ts RunningDigests discipline — MD5 stays NULL, no WebCrypto MD5). */
class TripleDigest {
  private readonly streams = [
    new crypto.DigestStream("SHA-1"),
    new crypto.DigestStream("SHA-256"),
    new crypto.DigestStream("SHA-512"),
  ];
  private readonly writers = this.streams.map((stream) => stream.getWriter());

  async write(chunk: Uint8Array): Promise<void> {
    await Promise.all(this.writers.map((writer) => writer.write(chunk)));
  }

  async hexes(): Promise<{ sha1: string; sha256: string; sha512: string }> {
    await Promise.all(this.writers.map((writer) => writer.close()));
    const digests = await Promise.all(this.streams.map((stream) => stream.digest));
    return {
      sha1: bytesToHex(new Uint8Array(digests[0] as ArrayBuffer)),
      sha256: bytesToHex(new Uint8Array(digests[1] as ArrayBuffer)),
      sha512: bytesToHex(new Uint8Array(digests[2] as ArrayBuffer)),
    };
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function indexOfSequence(hay: Uint8Array, hayLen: number, needle: Uint8Array, from: number): number {
  if (needle.length === 0) return from;
  outer: for (let i = from; i <= hayLen - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function indexOfCrlfCrlf(hay: Uint8Array, hayLen: number, from: number): number {
  for (let i = from; i + 3 < hayLen; i++) {
    if (hay[i] === 0x0d && hay[i + 1] === 0x0a && hay[i + 2] === 0x0d && hay[i + 3] === 0x0a) return i;
  }
  return -1;
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Content-Disposition params: `form-data; name="x"; filename="y.whl"`. */
function parseContentDisposition(value: string): { name: string; filename: string | null } {
  let name = "";
  let filename: string | null = null;
  const paramRegex = /([a-zA-Z0-9_-]+)="((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = paramRegex.exec(value)) !== null) {
    const key = match[1];
    const val = (match[2] ?? "").replaceAll(/\\"/g, '"').replaceAll(/\\\\/g, "\\");
    if (key === "name") name = val;
    if (key === "filename") filename = val;
  }
  return { name, filename };
}

export interface ScanTwineFormInput {
  contentType: string;
  body: ReadableStream<Uint8Array>;
}

/**
 * The bounded streaming multipart scan. One pass; the only bytes retained are
 * the small form fields and the content part's digests — its payload streams
 * through the digest writers and is dropped (the spool object holds the
 * bytes; the recorded range is what the second pass re-reads).
 */
export async function scanTwineForm(input: ScanTwineFormInput): Promise<ScannedTwineForm> {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(input.contentType);
  const boundaryRaw = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (boundaryRaw === undefined || boundaryRaw.trim() === "") {
    throw new PypiFormError("the multipart boundary parameter is missing");
  }
  const boundary = boundaryRaw.trim();
  const DELIM = new TextEncoder().encode(`--${boundary}`); // bare delimiter
  const DELIM_CRLF = new TextEncoder().encode(`\r\n--${boundary}`); // part terminator
  const TAIL_RESERVE = DELIM_CRLF.length - 1; // delimiter bytes may span chunks

  const fields = new Map<string, string[]>();
  let totalFieldBytes = 0;
  let contentFile: ScannedContentFile | null = null;

  const reader = input.body.getReader();
  let buf = new Uint8Array(64 * 1024);
  let len = 0; // valid bytes in buf
  let base = 0; // absolute body offset of buf[0]
  let eof = false;

  // Active part state.
  let fieldName = "";
  let filePart = false; // a part WITH a filename attribute
  let digesting = false; // and it is the (first) content part
  let digests: TripleDigest | null = null;
  let fileStart = 0;
  let fileFilename = "";
  let fieldChunks: Uint8Array[] = [];
  let fieldBytes = 0;
  let contentCursor = 0; // absolute offset the part sink has consumed up to

  const resetPart = (): void => {
    fieldName = "";
    filePart = false;
    digesting = false;
    digests = null;
    fieldChunks = [];
    fieldBytes = 0;
  };

  /** Drop [base, abs) from the buffer (bytes already ruled out). */
  const discardTo = (abs: number): void => {
    const drop = abs - base;
    if (drop <= 0) return;
    buf.copyWithin(0, drop, len);
    len -= drop;
    base = abs;
  };

  /** Ensure buf holds at least `need` bytes (unless eof); compaction keeps
   *  everything from `keepAbs` on. */
  const fill = async (keepAbs: number, need: number): Promise<void> => {
    if (eof || len >= need) return;
    const keepFrom = Math.min(Math.max(keepAbs, base), base + len);
    discardTo(keepFrom);
    if (need > buf.byteLength) {
      const grown = new Uint8Array(1 << Math.ceil(Math.log2(need)));
      grown.set(buf.subarray(0, len));
      buf = grown;
    }
    while (len < need && !eof) {
      const read = await reader.read();
      if (read.done) {
        eof = true;
        break;
      }
      const chunk = read.value;
      if (len + chunk.byteLength > buf.byteLength) {
        const grown = new Uint8Array(1 << Math.ceil(Math.log2(len + chunk.byteLength)));
        grown.set(buf.subarray(0, len));
        buf = grown;
      }
      buf.set(chunk, len);
      len += chunk.byteLength;
    }
  };

  /** Feed [contentCursor, to) to the active part's sink. */
  const feed = async (to: number): Promise<void> => {
    while (contentCursor < to) {
      const bufFrom = contentCursor - base;
      const bufTo = Math.min(to - base, len);
      if (bufFrom >= bufTo) break;
      const chunk = buf.subarray(bufFrom, bufTo);
      if (digesting && digests !== null) {
        // A COPY: the view aliases the reusable scan buffer, which a later
        // compaction overwrites — the digest must own its bytes.
        await digests.write(chunk.slice());
      } else if (!filePart) {
        if (fieldBytes + chunk.byteLength > MAX_FIELD_BYTES || totalFieldBytes + chunk.byteLength > MAX_TOTAL_FIELD_BYTES) {
          throw new PypiFormError("form field exceeds the scan cap");
        }
        fieldChunks.push(chunk.slice());
        fieldBytes += chunk.byteLength;
        totalFieldBytes += chunk.byteLength;
      }
      contentCursor += chunk.byteLength;
    }
  };

  /** Close the active part's sink at `contentEnd` (its content's end). */
  const finishPart = async (contentEnd: number): Promise<void> => {
    await feed(contentEnd);
    if (digesting && digests !== null) {
      const hexes = await digests.hexes();
      // The overlapped-terminator form ("...\r\n\r\n--boundary") can answer a
      // zero-length part with contentEnd two bytes before fileStart — clamp.
      contentFile = {
        filename: fileFilename,
        start: fileStart,
        end: Math.max(fileStart, contentEnd),
        ...hexes,
      };
    } else if (!filePart && fieldName !== "") {
      const decoded = new TextDecoder().decode(concatChunks(fieldChunks, fieldBytes));
      const existing = fields.get(fieldName);
      if (existing === undefined) fields.set(fieldName, [decoded]);
      else existing.push(decoded);
    }
    resetPart();
  };

  try {
    // ---- PREAMBLE: first delimiter at offset 0 or right after CRLF ----
    for (;;) {
      await fill(base, Math.max(len + 1, DELIM.length + 3));
      let found = indexOfSequence(buf, len, DELIM, 0);
      let accepted = false;
      while (found !== -1 && !accepted) {
        const suffix = found + DELIM.length;
        if (buf[suffix] === 0x2d && buf[suffix + 1] === 0x2d) {
          return { fields, contentFile }; // bare "--boundary--" (empty form)
        }
        const atStart = found === 0 && base === 0;
        const afterCrlf = base + found >= 2 && buf[found - 2] === 0x0d && buf[found - 1] === 0x0a;
        if ((atStart || afterCrlf) && buf[suffix] === 0x0d && buf[suffix + 1] === 0x0a) {
          resetPart();
          discardTo(base + suffix + 2);
          accepted = true;
        } else {
          found = indexOfSequence(buf, len, DELIM, found + 1);
        }
      }
      if (accepted) break;
      if (eof) throw new PypiFormError("multipart boundary not found");
      if (base + len > MAX_PREAMBLE_BYTES + DELIM.length + 2) {
        throw new PypiFormError("multipart preamble exceeds the scan cap");
      }
    }

    // ---- PARTS: header block → content span → ... → close delimiter ----
    for (;;) {
      // HEADERS
      resetPart();
      const headersStart = base;
      let headerEnd = -1; // buffer-relative index of the CRLFCRLF
      for (;;) {
        await fill(headersStart, headersStart - base + MAX_HEADER_BYTES + 4);
        headerEnd = indexOfCrlfCrlf(buf, len, headersStart - base);
        if (headerEnd !== -1) break;
        if (eof) throw new PypiFormError("unterminated part headers");
        if (base + len - headersStart > MAX_HEADER_BYTES) {
          throw new PypiFormError("part headers exceed the scan cap");
        }
      }
      const headerText = new TextDecoder("latin1").decode(buf.subarray(headersStart - base, headerEnd));
      const disposition = parseContentDisposition(headerText);
      fieldName = disposition.name;
      filePart = disposition.filename !== null;
      fileFilename = disposition.filename ?? "";
      if (filePart && fieldName === "content" && contentFile === null) {
        digesting = true;
        digests = new TripleDigest();
        fileStart = base + headerEnd + 4;
      }
      contentCursor = base + headerEnd + 4;

      // CONTENT — stream to the sink until CRLF--boundary. The search leads:
      // the sink only consumes spans PROVEN delimiter-free (any delimiter
      // starting inside them would have matched), so the first match is
      // never fed past.
      for (;;) {
        await fill(contentCursor, len + 1);
        const match = indexOfSequence(buf, len, DELIM_CRLF, contentCursor - base);
        if (match !== -1) {
          const contentEnd = base + match;
          const after = match + DELIM_CRLF.length;
          if (buf[after] === 0x2d && buf[after + 1] === 0x2d) {
            await finishPart(contentEnd);
            return { fields, contentFile }; // "--boundary--": the form is complete
          }
          if (buf[after] === 0x0d && buf[after + 1] === 0x0a) {
            await finishPart(contentEnd);
            discardTo(base + after + 2);
            break; // next part begins
          }
          // Boundary line junk after the delimiter: mime/multipart keeps
          // scanning for a well-formed boundary line — these bytes are
          // content.
          await feed(base + after);
          continue;
        }
        if (eof) throw new PypiFormError("unterminated part content");
        // No match: everything except the tail reserve (where a delimiter
        // could span chunks) is proven content — feed it and pull more.
        const provenEnd = base + len - TAIL_RESERVE;
        if (provenEnd > contentCursor) await feed(provenEnd);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The lock is already released (a read settled the stream for us).
    }
  }
}

// ---------------------------------------------------------------------------
// Upload — UploadPackageFile's walk (pypi.go:105-208)
// ---------------------------------------------------------------------------

/**
 * PASS 2b for the scanned part — ONE bounded ranged second pass: the file
 * bytes stream straight out of the spool object (R2 range GET of the recorded
 * span, a known length) into the content key through a FixedLengthStream, and
 * the spool dies in the finally (the landed copySpoolToContentKey discipline,
 * ranged because the twine envelope around the file is not stored).
 */
async function copySpoolRangeToContentKey(
  bucket: R2Bucket,
  spoolKey: string,
  offset: number,
  length: number,
  sha256: string,
): Promise<void> {
  const contentKey = packageBlobContentKey(sha256);
  try {
    const ranged = await bucket.get(spoolKey, { range: { offset, length } });
    if (ranged === null) {
      throw new Error(`package spool object vanished: ${spoolKey}`);
    }
    const sink = new FixedLengthStream(length);
    const put = bucket.put(contentKey, sink.readable);
    await Promise.all([put, ranged.body.pipeTo(sink.writable)]);
  } finally {
    await bucket.delete(spoolKey);
  }
}

export interface UploadPypiPackageInput {
  d1: D1Database;
  bucket: R2Bucket;
  owner: PackageOwnerRow;
  doer: PackageDoer;
  /** The raw multipart request Content-Type (carries the boundary). */
  contentType: string;
  /** The request body stream (spooled whole; never buffered). */
  content: ReadableStream<Uint8Array>;
  /** The REQUIRED declared Content-Length of the multipart body. */
  declaredLength: number;
  quota: PackagesQuotaConfig;
  now?: Date;
  /** Test seams (mirroring the generic upload's). */
  maxBytes?: number;
  spoolKey?: string;
}

export interface UploadPypiPackageResult {
  descriptorFile: PackageFileRow;
  blob: PackageBlobRow;
  createdFile: boolean;
}

/**
 * The twine POST's service walk. The quota checks precede the inserts (one
 * transaction upstream — a 403 leaves no rows). SIZE runs after the scan
 * with the FILE's real byte count (upstream checks inside
 * addFileToPackageVersion with the file size, packages.go:303-306 — the
 * multipart envelope is not charged). COUNT: upstream checks AFTER the
 * version insert, inside the rolling-back transaction (the versionCreated
 * gate, packages.go:188-191) and throws when totalCount > limit
 * (packages.go:380-381) — the pre-insert equivalent is count + 1 > limit,
 * so an exactly-at-limit owner publishes the version that REACHES the cap
 * but not one past.
 */
export async function uploadPypiPackage(input: UploadPypiPackageInput): Promise<UploadPypiPackageResult> {
  const now = input.now ?? new Date();
  if (!input.doer.isAdmin && input.quota.limitTotalOwnerCount > UNLIMITED_QUOTA) {
    const total = (await countVersions(input.d1, input.owner.id)) + 1;
    if (total > input.quota.limitTotalOwnerCount) {
      throw new QuotaTotalCountError();
    }
  }

  // PASS 1 — spool the whole multipart body (the store owns the 413 cap and
  // the length check; the cap covers the envelope, a conservative superset
  // of the file cap).
  const spooled: SpooledBlob = await spoolAndHash({
    bucket: input.bucket,
    content: input.content,
    declaredLength: input.declaredLength,
    maxBytes: input.maxBytes,
    spoolKey: input.spoolKey,
  });

  try {
    // PASS 2a — scan the spooled body: form fields + the content part's
    // range and digests (intra-datacenter read, no egress).
    const spoolObject = await input.bucket.get(spooled.spoolKey);
    if (spoolObject === null) {
      throw new Error("package spool object vanished");
    }
    const scanned = await scanTwineForm({
      contentType: input.contentType,
      body: spoolObject.body as ReadableStream<Uint8Array>,
    });

    // The upstream arms in order: content part → hash → name/version.
    const file = scanned.contentFile;
    if (file === null || file.filename === "") {
      throw new PypiMissingContentError();
    }
    const declaredDigest = firstField(scanned.fields, "sha256_digest");
    if (declaredDigest !== undefined && declaredDigest.toLowerCase() !== file.sha256) {
      throw new PypiHashMismatchError();
    }
    const packageName = normalizePypiName(firstField(scanned.fields, "name") ?? "");
    const packageVersion = firstField(scanned.fields, "version") ?? "";
    if (!isValidPypiNameAndVersion(packageName, packageVersion)) {
      throw new PypiInvalidNameOrVersionError();
    }

    // Size quota with the FILE's real size (see the doc comment).
    await checkSizeQuotaExceeded(
      input.d1,
      input.doer.isAdmin,
      input.owner.id,
      "pypi",
      file.end - file.start,
      input.quota,
    );

    const { row: pkg } = await getOrInsertPackage(input.d1, {
      ownerId: input.owner.id,
      type: "pypi",
      name: packageName,
      semverCompatible: false,
      now,
    });
    const { row: version, created: versionCreated } = await getOrInsertVersion(input.d1, {
      packageId: pkg.id,
      creatorId: input.doer.id,
      version: packageVersion,
      now,
    });
    // Metadata lands ONLY on a freshly created version (upstream marshals it
    // into the INSERT inside createPackageAndVersion; a duplicate version
    // keeps its original metadata).
    if (versionCreated) {
      await writeVersionMetadata(input.d1, version.id, JSON.stringify(buildPypiMetadata(scanned.fields)));
    }

    const { row: blob, created: blobCreated } = await getOrInsertBlob(input.d1, {
      size: file.end - file.start,
      sha256: file.sha256,
      sha1: file.sha1,
      sha512: file.sha512,
      now,
    });

    // PASS 2b — a dedup hit whose object still exists skips the copy; a miss
    // ranges the file bytes straight out of the spool into the content key
    // (the spool dies with the copy — the landed two-pass discipline).
    const objectPresent = (await input.bucket.head(packageBlobContentKey(file.sha256))) !== null;
    if (blobCreated || !objectPresent) {
      await copySpoolRangeToContentKey(
        input.bucket,
        spooled.spoolKey,
        file.start,
        file.end - file.start,
        file.sha256,
      );
    } else {
      await input.bucket.delete(spooled.spoolKey);
    }

    // IsLead: true (pypi.go:192) — every twine upload is the lead file.
    const fileResult: InsertFileResult = await tryInsertFile(input.d1, {
      versionId: version.id,
      blobId: blob.id,
      name: file.filename,
      isLead: true,
      now,
    });
    if (fileResult.outcome === "conflict") {
      throw new DuplicatePackageFileError(fileResult.row);
    }
    return { descriptorFile: fileResult.row, blob, createdFile: fileResult.outcome === "created" };
  } catch (error) {
    await input.bucket.delete(spooled.spoolKey).catch(() => undefined);
    throw error;
  }
}

/** The pypi Metadata JSON (modules/packages/pypi/metadata.go's json tags). */
function buildPypiMetadata(fields: Map<string, string[]>): Record<string, string> {
  let homepage = "";
  // project_urls entries are "Label, URL" — the well-known "homepage" label
  // wins (pypi.go:143-154); the deprecated home_page field is the fallback.
  for (const entry of allFields(fields, "project_urls")) {
    const comma = entry.indexOf(",");
    if (comma === -1) continue;
    if (normalizeProjectUrlLabel(entry.slice(0, comma)) !== "homepage") continue;
    homepage = entry.slice(comma + 1).trim();
    break;
  }
  if (homepage === "") homepage = firstField(fields, "home_page") ?? "";
  if (!isValidAbsoluteHttpUrl(homepage)) homepage = "";
  const metadata: Record<string, string> = {};
  const set = (key: string, value: string | undefined): void => {
    if (value !== undefined && value !== "") metadata[key] = value;
  };
  set("author", firstField(fields, "author"));
  set("description", firstField(fields, "description"));
  set("long_description", firstField(fields, "long_description"));
  set("summary", firstField(fields, "summary"));
  set("project_url", homepage);
  set("license", firstField(fields, "license"));
  set("requires_python", firstField(fields, "requires_python"));
  return metadata;
}

// ---------------------------------------------------------------------------
// Download — DownloadPackageFile (pypi.go:78-102) + the simple index
// ---------------------------------------------------------------------------

export interface PypiDownload {
  descriptor: { file: PackageFileRow; blob: PackageBlobRow };
  version: PackageVersionRow;
  /** Fresh stream over the content object (the caller pipes it out). */
  stream: ReadableStream;
  size: number;
}

/**
 * The `/files/{id}/{version}/{filename}` walk: the `{id}` segment normalizes
 * (pypi.go:79), then the version → file → blob walk with the lead-file GET
 * counter bump. Null = 404 at the route.
 */
export async function openPypiFileForDownload(
  d1: D1Database,
  bucket: R2Bucket,
  owner: PackageOwnerRow,
  id: string,
  packageVersion: string,
  filename: string,
  method: "GET" | "HEAD",
): Promise<PypiDownload | null> {
  const packageName = normalizePypiName(id);
  const version = await getVersionByNameAndVersion(d1, owner.id, "pypi", packageName, packageVersion);
  if (version === null) return null;
  const file = await getFileForVersionByName(d1, version.id, filename);
  if (file === null) return null;
  const descriptors = await getFileDescriptors(d1, version.id);
  const match = descriptors.find((entry) => entry.file.id === file.id);
  if (match === undefined) return null;
  const object = await bucket.get(packageBlobContentKey(match.blob.hashSha256));
  if (object === null) return null;
  if (file.isLead && method === "GET") {
    await incrementDownloadCounter(d1, version.id);
  }
  return { descriptor: match, version, stream: object.body, size: object.size };
}

/** The simple-index entry shape the renderer consumes. */
export interface PypiSimpleEntry {
  version: string;
  requiresPython: string;
  files: { name: string; sha256: string }[];
}

/**
 * PackageMetadata's data assembly (pypi.go:47-75): all versions of the
 * normalized package (upstream SearchVersions has NO paginator — every row
 * comes back), sorted ascending by the raw version string (strings.Compare,
 * pypi.go:67-69). Null = 404.
 */
export async function loadPypiSimpleIndex(
  d1: D1Database,
  owner: PackageOwnerRow,
  id: string,
): Promise<{ displayName: string; lowerName: string; entries: PypiSimpleEntry[] } | null> {
  const packageName = normalizePypiName(id);
  const pkg: PackageRow | null = await getPackageByName(d1, owner.id, "pypi", packageName);
  if (pkg === null) return null;
  // Upstream serves EVERY version (GetVersionsByPackageName → SearchVersions
  // with no Paginator, package_version.go:139-151); the explicit large limit
  // stands in for "no pagination".
  const { rows } = await searchVersions(d1, {
    ownerId: owner.id,
    type: "pypi",
    name: packageName,
    exact: true,
    excludeInternal: true,
    page: 1,
    limit: 100000,
  });
  if (rows.length === 0) return null;
  // strings.Compare ascending on the raw version string (pypi.go:67-69);
  // JS sort is stable where Go's slice sort is not — equal keys keep
  // insertion (newest-first) order deterministically.
  const sorted = [...rows].sort((a, b) =>
    a.version.version < b.version.version ? -1 : a.version.version > b.version.version ? 1 : 0,
  );
  const entries: PypiSimpleEntry[] = [];
  for (const row of sorted) {
    const descriptors = await getFileDescriptors(d1, row.version.id);
    let requiresPython = "";
    if (row.version.metadataJson !== null) {
      try {
        const parsed: unknown = JSON.parse(row.version.metadataJson);
        if (parsed !== null && typeof parsed === "object" && "requires_python" in parsed) {
          const value = (parsed as Record<string, unknown>)["requires_python"];
          if (typeof value === "string") requiresPython = value;
        }
      } catch {
        // A malformed metadata row renders without the attribute.
      }
    }
    entries.push({
      version: row.version.version,
      requiresPython,
      files: descriptors.map((descriptor) => ({ name: descriptor.file.name, sha256: descriptor.blob.hashSha256 })),
    });
  }
  return { displayName: pkg.name, lowerName: pkg.lowerName, entries };
}

/** HTML-escape (Go html/template's `&<>'"` set). */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The templates/api/packages/pypi/simple.tmpl port — the anchor block's
 * whitespace is the template's literal text (\n + tabs); values are escaped
 * the way html/template escapes them.
 */
export function renderPypiSimpleIndex(input: {
  displayName: string;
  lowerName: string;
  registryUrl: string;
  entries: PypiSimpleEntry[];
}): string {
  const anchors: string[] = [];
  for (const entry of input.entries) {
    for (const file of entry.files) {
      const requires =
        entry.requiresPython !== "" ? ` data-requires-python="${escapeHtml(entry.requiresPython)}"` : "";
      anchors.push(
        `\n\t\t\t\t<a href="${escapeHtml(
          `${input.registryUrl}/files/${input.lowerName}/${entry.version}/${file.name}`,
        )}#sha256=${escapeHtml(file.sha256)}"${requires}>${escapeHtml(file.name)}</a><br>`,
      );
    }
  }
  return `<!DOCTYPE html>
<html>
\t<head>
\t\t<title>Links for ${escapeHtml(input.displayName)}</title>
\t</head>
\t<body>
\t\t<h1>Links for ${escapeHtml(input.displayName)}</h1>
\t\t${anchors.join("")}
\t
\t</body>
</html>`;
}
