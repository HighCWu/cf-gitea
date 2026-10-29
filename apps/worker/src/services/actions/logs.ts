/**
 * The log store (SPEC-0012 §4.3, M1b): upstream's DBFS hot store mapped onto
 * the `action_log_chunks` table — one chunk row per UpdateLog append, the
 * row-formatted bytes exactly upstream's line format, and the `no_more` seal
 * stream-merging the rows into the R2 object `actions/logs/<log_filename>`.
 *
 * Byte format (modules/actions/log.go:24-30, 213-220): each row renders
 * `"<RFC3339 7-digit-fraction UTC> <content>\n"`; embedded newlines become
 * literal `\n`; the CONTENT is truncated at 64 KiB (MaxLineSize — Go counts
 * bytes, so the truncation here is byte-safe, never splitting a UTF-8
 * sequence).
 *
 * The seal (upstream TransferLogs + the handler's remove()): merged object
 * PUT first, then — only after the object is durable — the chunk rows are
 * deleted and log_in_storage flips, all in one D1 batch. Sealed logs are
 * stored UNCOMPRESSED (the LOG_COMPRESSION=none shape; §4.6 divergence 1).
 */

import { and, asc, eq, gt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { actionLogChunks } from "../../db/schema";

export const LOG_MAX_LINE_SIZE = 64 * 1024;
export const LOG_DBFS_PREFIX = "actions_log/";

/** The time format "2006-01-02T15:04:05.0000000Z07:00" — RFC3339 with a
 *  7-digit fraction, UTC. */
const TIME_FORMAT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/;

/**
 * FormatLog (log.go:213-220): escape newlines to the literal two-char
 * sequence, truncate the content at MaxLineSize BYTES (byte-safe), prefix
 * the formatted UTC timestamp. Returns the line WITHOUT the trailing
 * newline (the writer adds it, mirroring WriteLogs' `FormatLog(...) + "\n"`).
 */
export function formatLog(timestamp: Date, content: string): string {
  const escaped = content.replaceAll("\n", "\\n");
  const truncated = truncateUtf8Bytes(escaped, LOG_MAX_LINE_SIZE);
  return `${formatTimestamp(timestamp)} ${truncated}`;
}

/** Go's time.Format("2006-01-02T15:04:05.0000000Z07:00") for UTC instants:
 *  7 fraction digits, the literal Z suffix. */
export function formatTimestamp(date: Date): string {
  const ms = date.getTime();
  const base = new Date(ms);
  const iso = base.toISOString(); // "2026-01-01T00:00:00.000Z" — 3 digits
  const fraction = iso.slice(iso.indexOf(".") + 1, iso.indexOf("Z")); // "000"
  const padded = (fraction + "0000").slice(0, 7);
  return `${iso.slice(0, iso.indexOf("."))}.${padded}Z`;
}

/** Truncate a JS string to at most `maxBytes` UTF-8 bytes without splitting
 *  a code point (Go slices bytes, but Go strings are UTF-8 bytes — a Go
 *  byte-slice of content CAN split a rune; upstream then serves the raw
 *  bytes. We preserve valid UTF-8: the divergence is one truncated code
 *  point at the 64 KiB boundary, strictly safer for downstream decoders). */
function truncateUtf8Bytes(s: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= maxBytes) {
    return s;
  }
  let cut = maxBytes;
  // Back up over continuation bytes (0b10xxxxxx).
  while (cut > 0 && (bytes[cut] ?? 0) >= 0x80 && (bytes[cut] ?? 0) < 0xc0) {
    cut -= 1;
  }
  return new TextDecoder().decode(bytes.slice(0, cut));
}

export interface ParsedLogRow {
  time: Date;
  content: string;
}

/** ParseLog (log.go:226-240): split on the FIRST space, parse the fixed
 *  format, return the rest verbatim (escaped newlines stay escaped). */
export function parseLog(line: string): ParsedLogRow {
  const index = line.indexOf(" ");
  if (index < 0) {
    throw new Error(`invalid log: ${JSON.stringify(line)}`);
  }
  const stamp = line.slice(0, index);
  if (!TIME_FORMAT_RE.test(stamp)) {
    throw new Error(`invalid log: ${JSON.stringify(line)}`);
  }
  const time = new Date(stamp.replace(/(\.\d{3})\d{4}Z$/, "$1Z"));
  if (Number.isNaN(time.getTime())) {
    throw new Error(`invalid log: ${JSON.stringify(line)}`);
  }
  return { time, content: line.slice(index + 1) };
}

/** The per-row byte lengths WriteLogs reports back (runner.go:334-338
 *  advances LogIndexes/LogSize from them). */
export function formatLogRows(rows: Array<{ time: Date | undefined; content: string }>): { bytes: Uint8Array; sizes: number[] } {
  const lines: string[] = [];
  const sizes: number[] = [];
  const encoder = new TextEncoder();
  let total = 0;
  for (const row of rows) {
    const line = `${formatLog(row.time ?? new Date(0), row.content)}\n`;
    const encoded = encoder.encode(line);
    lines.push(line);
    sizes.push(encoded.length);
    total += encoded.length;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const line of lines) {
    const encoded = encoder.encode(line);
    bytes.set(encoded, offset);
    offset += encoded.length;
  }
  return { bytes, sizes };
}

/** The little-endian signed-varint spell of upstream LogIndexes (utils.go:45-68:
 *  binary.PutVarint — zigzag). */
export function encodeLogIndexes(indexes: number[]): Uint8Array {
  const out: number[] = [];
  for (const v of indexes) {
    let x = BigInt(v);
    if (x < 0n) {
      x = -x * 2n - 1n;
    } else {
      x *= 2n;
    }
    for (;;) {
      const byte = x & 0x7fn;
      x >>= 7n;
      if (x === 0n) {
        out.push(Number(byte));
        break;
      }
      out.push(Number(byte) | 0x80);
    }
  }
  return new Uint8Array(out);
}

export function decodeLogIndexes(bytes: Uint8Array): number[] {
  const out: number[] = [];
  let shift = 0n;
  let value = 0n;
  for (const byte of bytes) {
    value |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if ((byte & 0x80) === 0) {
      // Undo the zigzag.
      const negative = (value & 1n) === 1n;
      const magnitude = value >> 1n;
      out.push(Number(negative ? -(magnitude + 1n) : magnitude));
      shift = 0n;
      value = 0n;
    }
  }
  return out;
}

/**
 * WriteLogs (log.go:35-78) over the chunk table: the caller has already
 * trimmed + gap-checked; this formats the rows and returns the per-row
 * sizes. The INSERT itself happens in update.ts's batch together with the
 * task-column advance (upstream's write and its UpdateTask ride one
 * transaction; ours rides one D1 batch — the hole-guard is subsumed by
 * atomicity, see update.ts's UpdateLog).
 */
export function renderLogAppend(rows: Array<{ time: Date | undefined; content: string }>): { bytes: Uint8Array; sizes: number[] } {
  return formatLogRows(rows);
}

/** The R2 key of a sealed log (§4.2). */
export function sealedLogKey(logFilename: string): string {
  return `actions/logs/${logFilename}`;
}

/**
 * TransferLogs (log.go:150-181) — stream-merge the task's chunk rows into
 * ONE R2 object. Chunks are read page by page (D1 has no server-side
 * cursor; pages bound the isolate's memory per batch) and packed into 8 MiB
 * multipart parts (R2's floor for non-final parts is 5 MiB, so small
 * appends must be coalesced — the packing keeps the CPU near zero and the
 * wall time at R2 throughput). A task with zero stored bytes seals as an
 * empty object (the empty-log bootstrap's other half).
 */
export async function sealLogsToStorage(env: Env, taskId: number, logFilename: string): Promise<void> {
  const db = drizzle(env.DB);
  const key = sealedLogKey(logFilename);
  const PAGE = 200;
  const PART_BYTES = 8 * 1024 * 1024;
  const buffer = new Uint8Array(PART_BYTES);
  let buffered = 0;
  let partNumber = 1;
  const parts: Array<{ partNumber: number; etag: string }> = [];
  // Holder object: property narrowing resets across the awaits, unlike a
  // captured `let` (whose closure assignment TypeScript mis-narrows).
  const state: { mpu?: R2MultipartUpload } = {};
  let anyRow = false;
  let aboveSeq = -1;

  const flushPart = async (final: boolean): Promise<void> => {
    if (buffered === 0) {
      return;
    }
    const chunk = buffer.slice(0, buffered);
    // Non-final parts must clear the 5 MiB floor; coalesce until they do.
    if (!final && chunk.length < 5 * 1024 * 1024) {
      return;
    }
    if (state.mpu === undefined) {
      state.mpu = await env.REPO_PACKS.createMultipartUpload(key);
    }
    const uploaded = await state.mpu.uploadPart(partNumber, chunk);
    parts.push({ partNumber, etag: uploaded.etag });
    partNumber += 1;
    buffered = 0;
  };

  const absorb = async (bytes: Uint8Array): Promise<void> => {
    let offset = 0;
    while (offset < bytes.length) {
      const space = PART_BYTES - buffered;
      const take = Math.min(space, bytes.length - offset);
      buffer.set(bytes.subarray(offset, offset + take), buffered);
      buffered += take;
      offset += take;
      if (buffered === PART_BYTES) {
        await flushPart(false);
      }
    }
  };

  for (;;) {
    const page = await db
      .select({ seq: actionLogChunks.seq, bytes: actionLogChunks.bytes })
      .from(actionLogChunks)
      .where(and(eq(actionLogChunks.taskId, taskId), gt(actionLogChunks.seq, aboveSeq)))
      .orderBy(asc(actionLogChunks.seq))
      .limit(PAGE);
    if (page.length === 0) {
      break;
    }
    for (const row of page) {
      anyRow = true;
      aboveSeq = Math.max(aboveSeq, row.seq);
      await absorb(asBytes(row.bytes));
    }
    if (page.length < PAGE) {
      break;
    }
  }

  if (!anyRow || (parts.length === 0 && buffered === 0)) {
    // Zero-byte log: a plain PUT (an MPU needs at least one part; the empty
    // object is the empty-log bootstrap's counterpart upstream).
    await env.REPO_PACKS.put(key, new Uint8Array(0));
    return;
  }

  await flushPart(true);
  if (state.mpu !== undefined) {
    await state.mpu.complete(parts);
  } else {
    // Only a final sub-floor remainder exists (impossibly small log).
    await env.REPO_PACKS.put(key, buffer.slice(0, buffered));
  }
}

/** RemoveLogs (log.go:184-198) — the hot-row family when not sealed, the
 *  R2 object when sealed. */
export async function removeLogs(env: Env, inStorage: boolean, logFilename: string, taskId: number): Promise<void> {
  if (!inStorage) {
    await drizzle(env.DB).delete(actionLogChunks).where(eq(actionLogChunks.taskId, taskId));
    return;
  }
  await env.REPO_PACKS.delete(sealedLogKey(logFilename));
}

/**
 * ReadLogs (log.go:85-120) — parse the stored bytes back into rows. Hot
 * logs read the chunk rows in seq order; sealed logs read the R2 object.
 * `offset` is the ROW index (upstream seeks the FILE at the row's byte
 * offset — we materialize the line list and slice; the byte-offset bookkeeping
 * stays in log_indexes for wire parity).
 */
export async function readLogs(env: Env, inStorage: boolean, logFilename: string, taskId: number, offset: number, limit: number): Promise<ParsedLogRow[]> {
  let text: string;
  if (inStorage) {
    const obj = await env.REPO_PACKS.get(sealedLogKey(logFilename));
    if (obj === null) {
      throw new Error(`storage open "actions/logs/${logFilename}": object missing`);
    }
    text = await obj.text();
  } else {
    const rows = await drizzle(env.DB)
      .select({ bytes: actionLogChunks.bytes })
      .from(actionLogChunks)
      .where(eq(actionLogChunks.taskId, taskId))
      .orderBy(asc(actionLogChunks.seq));
    const total = rows.reduce((sum, r) => sum + asBytes(r.bytes).length, 0);
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const r of rows) {
      const b = asBytes(r.bytes);
      bytes.set(b, at);
      at += b.length;
    }
    text = new TextDecoder().decode(bytes);
  }

  const lines = text.split("\n");
  // A trailing newline yields one empty tail element — not a row.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const out: ParsedLogRow[] = [];
  for (let i = Math.max(0, offset); i < lines.length; i++) {
    if (limit >= 0 && out.length >= limit) {
      break;
    }
    const line = lines[i];
    if (line === undefined) {
      break;
    }
    out.push(parseLog(line));
  }
  return out;
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  throw new Error("actions: blob column did not return bytes");
}

/** The next append seq for a task's chunk family (the UNIQUE(task_id, seq)
 *  arbitration's key supplier — evaluated inside the insert's batch). */
export function nextChunkSeq(taskId: number) {
  return sql`(SELECT COALESCE(MAX(${actionLogChunks.seq}), -1) + 1 FROM ${actionLogChunks} WHERE ${actionLogChunks.taskId} = ${taskId})`;
}
