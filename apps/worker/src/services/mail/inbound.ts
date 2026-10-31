/**
 * Inbound email: reply-by-mail to a comment (specs/email-inbound.md).
 *
 * The port of the upstream pin's incoming-mail surface onto the platform's
 * single inbound-mail shape — Cloudflare Email Routing delivering to the
 * Worker's `email()` handler (no binding, no wrangler config; the handler
 * export is the whole story, verified against wrangler 4.153.0's
 * config-schema.json where `send_email` is the ONLY email key — outbound,
 * already rejected by email-outbound §3.1(b)). Upstream's IMAP IDLE poll
 * (services/mailer/incoming/incoming.go:25-143) has no port: the platform
 * invocation IS the loop iteration.
 *
 *   - the token         — services/mailer/token/token.go: base32-no-padding,
 *     ToUpper-normalized decode (RFC 5321 §2.4, :79-81), SHA-256 HMAC
 *     truncated to 10 bytes (:124-131, the RFC2104 80-bit floor), 1-year
 *     lifetime (:29), constant-time compare (:106). THE KEY DIVERGES
 *     (SPEC §3.2): upstream keys per-user `user.Rands` (:66) — our users
 *     table carries no per-user secret column — so the MAC is
 *     HMAC-SHA256(MAIL_INBOUND_SECRET, domain ‖ the covered 22-byte
 *     prefix)[0:10] over EVERYTHING (version ‖ userId ‖ expiry ‖ refType ‖
 *     refId), the tighter all-covered shape. Upstream's handlerType byte
 *     (token.go:32-38) becomes the MAC's family domain — `reply` (this
 *     pipeline) and `unsubscribe` (the notify compose's List-Unsubscribe
 *     mailto arm, SPEC §9; its inbound handler is §1.3's follow-up slice) —
 *     so a token of one family never verifies as the other.
 *   - the token search  — incoming.go:searchTokenInHeaders (:283-320):
 *     To → Delivered-To address candidates against the reply-address
 *     template split around `%{token}` (extractToken :272-281,
 *     searchTokenInAddresses :322-334), then References msg-ids against
 *     `reply-<token>@AppDomain` (:299-317). The addr-candidate regex is
 *     the net/mail AddressList reduction (addr-spec shapes only — RFC 2047
 *     never applies inside To/Delivered-To/References, SPEC §3.3).
 *   - the auto-reply skip — incoming.go:isAutomaticReply (:259-270)
 *     VERBATIM (case-sensitive "no"/"yes" compares included), checked
 *     BEFORE the token search (the :210-219 order — the loop guard runs
 *     first).
 *   - the content       — incoming.go:getContentFromMailReader (:348-361)
 *     minus attachments (SPEC §1.3): the first non-attachment text/plain
 *     part, decoded, through extractReplyText (the reply.go:80-108 port —
 *     signature/attribution/separator/forwarded-header cuts + the
 *     trailing-quoted-block drop, English arms; the locale families are
 *     the SPEC §1.3 follow-up). The MIME walk is the bounded hand-rolled
 *     extractor (SPEC §3.3 — postal-mime evaluated, swap path recorded);
 *     html-only mail yields "" and the empty guard drops it
 *     (incoming_handler.go:112-114).
 *   - the handler       — incoming_handler.go:ReplyHandler.Handle
 *     (:39-151): resolve issue-or-comment reference, the two FRESH
 *     permission gates (:70-84 — read, locked-requires-write, admin
 *     override; silent skips), then the plain CreateIssueComment arm
 *     (the CommentTypeCode branch is the SPEC §1.3 reduction). The emit
 *     rides the LANDED IssuesService with its mail env, so the comment
 *     fans the notify hub exactly like a web-posted one.
 *
 * Security posture (SPEC §4): the token is the SOLE authority — From is
 * never consulted (upstream's processMessages never reads it either);
 * Cloudflare's PREPENDED Authentication-Results (identifier
 * `mx.cloudflare.net`, sender-supplied ones untrusted) is logged as
 * `auth_results`, never a gate; dedupe on Message-ID kills at-least-once
 * double-posts; the loop guards compose auto-reply-skip +
 * X-Auto-Response-Suppress (outbox, always) + Message-ID dedupe + token
 * expiry; the 10 MiB cap (upstream MaximumMessageSize default,
 * incoming_email.go:32) setRejects BEFORE any stream read and the stream
 * read re-bounds anyway.
 *
 * The email() mount itself (src/index.ts) is THIN: the vitest plugin has
 * no way to deliver to an email handler (verified 2026-10-31 — SPEC
 * §3.1), so every behavior lives here behind the structural
 * `InboundEmailMessage` interface and the suite drives it with fakes.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  comments,
  emailInbound,
  issues,
  users,
  type TeamAccessMode,
} from "../../db/schema";
import { IssuesService } from "../../issues/service";
import {
  doerRepoAccessMode,
  findRepositoryById,
} from "../../api/services/repository";
import { appDomainFromAppUrl } from "./message";

/** Upstream `IncomingEmailTokenPlaceholder` (modules/setting/
 *  incoming_email.go:15). */
export const REPLY_ADDRESS_PLACEHOLDER = "%{token}";

/** Upstream `IncomingEmail.MaximumMessageSize` default — 10485760
 *  (incoming_email.go:32). Email Routing's own hard cap is 25 MiB, so
 *  this always bites first; a var can be added when a deployment asks
 *  (SPEC §8). */
export const MAIL_INBOUND_MAX_MESSAGE_SIZE = 10_485_760;

/** Upstream `tokenLifetimeInYears = 1` (token.go:29). */
const TOKEN_LIFETIME_SECONDS = 365 * 24 * 60 * 60;

const TOKEN_VERSION = 0x01;
/** Layout (SPEC §3.2): version u8 ‖ userId u64BE ‖ expiry u32BE ‖
 *  refType u8 ‖ refId u64BE ‖ mac[10] = 32 bytes → 52 unpadded base32
 *  chars, well under the 64-char local-part ceiling. */
const TOKEN_BYTES = 32;
const TOKEN_MAC_OFFSET = 22;
const TOKEN_MAC_BYTES = 10;
/**
 * Domain separation per token FAMILY (SPEC §3.2: "the domain-separation
 * prefix keeps this secret usable for later token families — Unsubscribe —
 * without cross-family forgery"). The layout is shared; only the MAC domain
 * differs, so a token of one family can never verify as another:
 *   - `reply`       — the Reply-To/List-Post/References carrier on
 *                     notification mail (upstream ReplyHandlerType, token
 *                     token.go:36); verified by decodeReplyToken's default
 *                     and by the pipeline below.
 *   - `unsubscribe` — the List-Unsubscribe mailto arm on the same mail
 *                     (upstream UnsubscribeHandlerType, token.go:37 /
 *                     mail_issue_common.go:195-201). The inbound
 *                     UnsubscribeHandler is SPEC §1.3's own follow-up
 *                     slice — until it lands, a mail to the unsubscribe
 *                     address fails the reply-family MAC and drops
 *                     dropped-invalid-token (fail-closed: it can NEVER
 *                     create a comment).
 */
const TOKEN_DOMAINS = {
  reply: new TextEncoder().encode("cf-gitea/mail-reply/v1"),
  unsubscribe: new TextEncoder().encode("cf-gitea/mail-unsubscribe/v1"),
} as const;

export type ReplyTokenFamily = keyof typeof TOKEN_DOMAINS;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export type ReplyRefType = "issue" | "comment";

const REF_TYPE_BYTE: Record<ReplyRefType, number> = { issue: 0, comment: 1 };
const BYTE_REF_TYPE: Record<number, ReplyRefType> = { 0: "issue", 1: "comment" };

// ---------------------------------------------------------------------------
// Config validation — upstream checkReplyToAddress (incoming_email.go:47-63)
// ---------------------------------------------------------------------------

export interface ReplyAddressTemplate {
  /** The address around the placeholder: template.split("%{token}") halves
   *  (upstream's strings.Cut, incoming.go:324). */
  prefix: string;
  suffix: string;
}

/**
 * The `%{token}` template rules, upstream verbatim: exactly one
 * placeholder, in the user part (before the @), no display name; a bare
 * `@`-less or placeholder-less string is invalid. Upstream Fatal's at boot
 * (:42-45); we have no boot step — the caller logs + drops-misconfigured
 * (the email-outbound §5.2 posture). NULL = invalid.
 */
export function parseReplyAddressTemplate(raw: string): ReplyAddressTemplate | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.includes("<") || trimmed.includes(">") || trimmed.includes('"')) return null;
  const placeholderCount = trimmed.split(REPLY_ADDRESS_PLACEHOLDER).length - 1;
  if (placeholderCount !== 1) return null;
  const userPart = trimmed.slice(0, trimmed.indexOf("@"));
  if (!userPart.includes(REPLY_ADDRESS_PLACEHOLDER)) return null;
  const at = trimmed.indexOf(REPLY_ADDRESS_PLACEHOLDER);
  return { prefix: trimmed.slice(0, at), suffix: trimmed.slice(at + REPLY_ADDRESS_PLACEHOLDER.length) };
}

/** The Reply-To value a notification mail carries for one recipient
 *  (mail_issue_common.go:186-187's `strings.Replace(..., 1)`) — exported
 *  for the SPEC §9 HANDOFF fold. */
export function replyAddressFor(template: string, token: string): string {
  return template.replace(REPLY_ADDRESS_PLACEHOLDER, token);
}

// ---------------------------------------------------------------------------
// The token (SPEC §3.2)
// ---------------------------------------------------------------------------

function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** null on any non-alphabet character (base32.DecodeString's error). */
function base32Decode(text: string): Uint8Array | null {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** Constant-time compare (upstream crypto_hmac.Equal, token.go:106). */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function hmac10(secret: string, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  return sig.slice(0, TOKEN_MAC_BYTES);
}

export interface CreateReplyTokenInput {
  userId: number;
  refType: ReplyRefType;
  refId: number;
  /** The token family (see TOKEN_DOMAINS) — default `"reply"`. The notify
   *  compose's List-Unsubscribe arm mints `"unsubscribe"`. */
  family?: ReplyTokenFamily;
  now?: Date;
}

/** The MAC's covered bytes: the family domain prepended to the body
 *  (everything is covered — the SPEC §3.2 tighter shape). */
function coveredBytes(domain: Uint8Array, body: Uint8Array): Uint8Array {
  const covered = new Uint8Array(domain.length + body.length);
  covered.set(domain);
  covered.set(body, domain.length);
  return covered;
}

/**
 * Mint one recipient's reply token (upstream CreateToken, token.go:55-75 —
 * the handlerType byte becomes the MAC domain, SPEC §3.2). Exported for the
 * SPEC §9 HANDOFF fold (the notify compose); the pipeline itself never
 * mints.
 */
export async function createReplyToken(secret: string, input: CreateReplyTokenInput): Promise<string> {
  const expiry = Math.floor((input.now ?? new Date()).getTime() / 1000) + TOKEN_LIFETIME_SECONDS;
  const body = new Uint8Array(TOKEN_MAC_OFFSET);
  const view = new DataView(body.buffer);
  view.setUint8(0, TOKEN_VERSION);
  view.setBigUint64(1, BigInt(input.userId), false);
  view.setUint32(9, expiry, false);
  view.setUint8(13, REF_TYPE_BYTE[input.refType]);
  view.setBigUint64(14, BigInt(input.refId), false);
  const mac = await hmac10(secret, coveredBytes(TOKEN_DOMAINS[input.family ?? "reply"], body));
  const token = new Uint8Array(TOKEN_BYTES);
  token.set(body);
  token.set(mac, TOKEN_MAC_OFFSET);
  return base32Encode(token);
}

export type DecodedReplyToken =
  | { ok: true; userId: number; refType: ReplyRefType; refId: number; expiresAt: Date }
  | { ok: false; reason: "malformed" | "invalid" | "expired" };

/**
 * Verify one token (upstream DecodeToken, token.go:78-122, minus the user
 * load — the orchestrator owns that D1 read; the split is documented in
 * the module header). Malformed (decode/version/length) and invalid (MAC)
 * both render as dropped-invalid-token downstream; expired is its own
 * verdict (upstream's "token expired" ErrToken, :117-119). `family` names
 * the MAC domain to verify under (default `"reply"`) — the cross-family
 * arm renders as `invalid`, the domain separation's whole point (a
 * reply-verify of an unsubscribe token can never pass, and vice versa).
 */
export async function decodeReplyToken(
  secret: string,
  token: string,
  family: ReplyTokenFamily = "reply",
): Promise<DecodedReplyToken> {
  // MTAs may lowercase the local-part (RFC 5321 §2.4) — upstream's
  // strings.ToUpper normalization first (token.go:79-81).
  const data = base32Decode(token.toUpperCase());
  if (data === null || data.length !== TOKEN_BYTES || data[0] !== TOKEN_VERSION) {
    return { ok: false, reason: "malformed" };
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const body = data.slice(0, TOKEN_MAC_OFFSET);
  const expected = await hmac10(secret, coveredBytes(TOKEN_DOMAINS[family], body));
  const mac = data.slice(TOKEN_MAC_OFFSET);
  if (!constantTimeEqual(expected, mac)) return { ok: false, reason: "invalid" };
  const userId = Number(view.getBigUint64(1, false));
  const expiry = view.getUint32(9, false);
  const refType = BYTE_REF_TYPE[view.getUint8(13)];
  const refId = Number(view.getBigUint64(14, false));
  if (refType === undefined) return { ok: false, reason: "malformed" };
  const expiresAt = new Date(expiry * 1000);
  if (expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };
  return { ok: true, userId, refType, refId, expiresAt };
}

// ---------------------------------------------------------------------------
// Header search + the automatic-reply guard (upstream incoming.go)
// ---------------------------------------------------------------------------

/**
 * Upstream extractToken (incoming.go:272-281) — case-insensitive
 * prefix/suffix extraction ("MTAs are permitted to alter the case of the
 * local-part"; EqualFold parity).
 */
function extractToken(s: string, prefix: string, suffix: string): string {
  if (s.length <= prefix.length + suffix.length) return "";
  const head = s.slice(0, prefix.length);
  const tail = s.slice(s.length - suffix.length);
  if (head.toLowerCase() === prefix.toLowerCase() && tail.toLowerCase() === suffix.toLowerCase()) {
    return s.slice(prefix.length, s.length - suffix.length);
  }
  return "";
}

/** The addr-spec candidates of an address-list header — the net/mail
 *  AddressList reduction (SPEC §3.3; display names, grouping punctuation
 *  and folding whitespace excluded by construction). */
function addressCandidates(value: string): string[] {
  return value.match(/[^\s<>,;:"()]+@[^\s<>,;:"()]+/g) ?? [];
}

/**
 * Upstream searchTokenInHeaders (incoming.go:283-320): To → Delivered-To
 * address candidates against the reply-address template halves, then every
 * References msg-id against `reply-<token>@<appDomain>`. "" = no token.
 */
export function extractTokenFromHeaders(
  headers: { get(name: string): string | null },
  template: ReplyAddressTemplate,
  appDomain: string,
): string {
  for (const name of ["to", "delivered-to"]) {
    const value = headers.get(name);
    if (value === null) continue;
    for (const address of addressCandidates(value)) {
      const token = extractToken(address, template.prefix, template.suffix);
      if (token !== "") return token;
    }
  }
  const references = headers.get("references") ?? "";
  let rest = references;
  for (;;) {
    const begin = rest.indexOf("<");
    if (begin === -1) break;
    const end = rest.indexOf(">", begin + 1);
    if (end === -1) break;
    const msgId = rest.slice(begin + 1, end);
    const token = extractToken(msgId, "reply-", `@${appDomain}`);
    if (token !== "") return token;
    rest = rest.slice(end + 1);
  }
  return "";
}

/**
 * Upstream isAutomaticReply (incoming.go:259-270) VERBATIM — including the
 * case-sensitive "no"/"yes" compares (the tighter case-insensitive form
 * would PROCESS an `Auto-Submitted: NO` mail upstream drops; parity wins).
 */
export function isAutomaticReply(headers: { get(name: string): string | null }): boolean {
  const autoSubmitted = headers.get("auto-submitted") ?? "";
  if (autoSubmitted !== "" && autoSubmitted !== "no") return true;
  if ((headers.get("x-autoreply") ?? "") === "yes") return true;
  return (headers.get("x-autorespond") ?? "") !== "";
}

// ---------------------------------------------------------------------------
// The bounded MIME text extractor (SPEC §3.3)
// ---------------------------------------------------------------------------

/** A lying rawSize cannot buffer the Worker — the stream read re-bounds at
 *  the same cap the pre-read gate used. */
export class MailInboundOversizeError extends Error {
  constructor() {
    super("inbound mail exceeds the maximum accepted size");
    this.name = "MailInboundOversizeError";
  }
}

async function readBounded(raw: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = raw.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new MailInboundOversizeError();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Byte-preserving (latin1) text view — safe to split on boundaries; the
 *  byte array is re-derived before charset decoding. */
function bytesToLatin1(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

function latin1ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** Content-Type value → { mime, params } with quoted-string params. */
function parseContentType(value: string | null): { mime: string; params: Map<string, string> } {
  const params = new Map<string, string>();
  if (value === null) return { mime: "text/plain", params };
  const parts = value.split(";");
  const mime = parts[0]!.trim().toLowerCase() || "text/plain";
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let v = part.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    if (key !== "") params.set(key, v);
  }
  return { mime, params };
}

/** Charset decode with the utf-8 → windows-1252 fallback ladder (SPEC
 *  §3.3 — an unknown label degrades instead of failing the mail). */
function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  const labels = [charset?.toLowerCase(), "utf-8", "windows-1252"].filter(
    (l): l is string => typeof l === "string" && l !== "",
  );
  for (const label of labels) {
    try {
      return new TextDecoder(label, { fatal: false, ignoreBOM: false }).decode(bytes);
    } catch {
      // unsupported label — next rung
    }
  }
  return new TextDecoder("windows-1252", { fatal: false, ignoreBOM: false }).decode(bytes);
}

function decodeQuotedPrintable(text: string): Uint8Array {
  // Soft breaks first (= CRLF/LF), then =XX hex — RFC 2045 §6.7.
  const noSoft = text.replace(/=\r?\n/g, "");
  let out = "";
  for (let i = 0; i < noSoft.length; i++) {
    const ch = noSoft[i]!;
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(noSoft.slice(i + 1, i + 3))) {
      out += String.fromCharCode(parseInt(noSoft.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out += ch;
    }
  }
  return latin1ToBytes(out);
}

function decodeBase64(text: string): Uint8Array | null {
  try {
    const bin = atob(text.replace(/[^A-Za-z0-9+/=]/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** One MIME part's header block → lowercase-name map (folded lines joined). */
function parsePartHeaders(partText: string): { headers: Map<string, string>; body: string } {
  const sep = partText.indexOf("\n\n");
  const headText = sep === -1 ? partText : partText.slice(0, sep);
  const body = sep === -1 ? "" : partText.slice(sep + 2);
  const headers = new Map<string, string>();
  let current = "";
  for (const line of headText.split("\n")) {
    if (/^[ \t]/.test(line)) {
      current += " " + line.trim();
      continue;
    }
    if (current !== "") {
      const eq = current.indexOf(":");
      if (eq !== -1) headers.set(current.slice(0, eq).trim().toLowerCase(), current.slice(eq + 1).trim());
    }
    current = line;
  }
  if (current !== "") {
    const eq = current.indexOf(":");
    if (eq !== -1) headers.set(current.slice(0, eq).trim().toLowerCase(), current.slice(eq + 1).trim());
  }
  return { headers, body };
}

function decodeLeaf(bodyText: string, headers: Map<string, string>, topHeaders?: { get(name: string): string | null }): string {
  const contentType = parseContentType(headers.get("content-type") ?? topHeaders?.get("content-type") ?? null);
  const encoding = (
    headers.get("content-transfer-encoding") ??
    topHeaders?.get("content-transfer-encoding") ??
    "7bit"
  ).trim().toLowerCase();
  const charset = contentType.params.get("charset");
  let bytes: Uint8Array;
  switch (encoding) {
    case "base64": {
      const decoded = decodeBase64(bodyText);
      if (decoded === null) return "";
      bytes = decoded;
      break;
    }
    case "quoted-printable":
      bytes = decodeQuotedPrintable(bodyText);
      break;
    default:
      // 7bit / 8bit / binary / unknown — pass through the byte view.
      bytes = latin1ToBytes(bodyText);
  }
  return decodeCharset(bytes, charset);
}

/**
 * Depth-first walk for the first non-attachment text/plain leaf
 * (upstream enmime's `env.Text` shape — incoming.go:205,235,358). Depth ≤
 * 3 and ≤ 50 parts terminate nesting bombs (SPEC §3.3); an html-only mail
 * yields "" (NO html fallback — the empty guard drops it,
 * incoming_handler.go:112-114).
 */
function walkForPlainText(
  bodyText: string,
  contentType: { mime: string; params: Map<string, string> },
  headers: Map<string, string> | null,
  depth: number,
  topHeaders?: { get(name: string): string | null },
): string {
  if (depth > 3) return "";
  if (contentType.mime.startsWith("multipart/")) {
    const boundary = contentType.params.get("boundary");
    if (boundary === undefined || boundary === "") return "";
    const delimiter = `--${boundary}`;
    const lines = bodyText.split("\n");
    let count = 0;
    let current: string[] | null = null;
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      if (line === delimiter || line === `${delimiter}--`) {
        if (current !== null && count < 50) {
          count += 1;
          const found = walkPart(current.join("\n"), depth, topHeaders);
          if (found !== "") return found;
        }
        current = line === delimiter ? [] : null;
        if (line === `${delimiter}--`) break;
        continue;
      }
      if (current !== null) current.push(rawLine);
    }
    if (current !== null && current.length > 0 && count < 50) {
      const found = walkPart(current.join("\n"), depth, topHeaders);
      if (found !== "") return found;
    }
    return "";
  }
  if (contentType.mime !== "text/plain") return "";
  const disposition = (headers?.get("content-disposition") ?? "").toLowerCase();
  if (disposition.startsWith("attachment") || contentType.params.has("name")) return "";
  return decodeLeaf(bodyText, headers ?? new Map<string, string>(), topHeaders);
}

function walkPart(partText: string, depth: number, topHeaders?: { get(name: string): string | null }): string {
  const { headers, body } = parsePartHeaders(partText);
  const contentType = parseContentType(headers.get("content-type") ?? null);
  return walkForPlainText(body, contentType, headers, depth + 1, topHeaders);
}

/**
 * The bounded extractor: `message.raw` (a stream, never awaited whole
 * beyond the cap) → the first text/plain leaf's decoded text. Top-level
 * headers come from `message.headers` (the runtime already parsed them);
 * part headers come off the wire.
 */
export async function extractMailText(
  raw: ReadableStream<Uint8Array>,
  headers: { get(name: string): string | null },
  maxBytes: number,
): Promise<string> {
  const bytes = await readBounded(raw, maxBytes);
  // The top-level header/body split — headers themselves come in parsed.
  // CRLF normalizes first (a "\r\n\r\n" separator holds no "\n\n").
  const topText = bytesToLatin1(bytes).replace(/\r\n/g, "\n");
  const sep = topText.indexOf("\n\n");
  const body = sep === -1 ? "" : topText.slice(sep + 2);
  const contentType = parseContentType(headers.get("content-type") ?? null);
  return walkForPlainText(body, contentType, null, 0, headers).trim();
}

// ---------------------------------------------------------------------------
// The quoted-reply trim — the reply.go:80-108 port, English arms
// (SPEC §3.3/§1.3: the locale families are the follow-up)
// ---------------------------------------------------------------------------

const SIGNATURE_RE = /^(?:--|__|—|sent (?:from|via|with) .+|get outlook for .+)$/i;

const YEAR_TOKEN = String.raw`\b\d{4}\b`;
const TIME_TOKEN = String.raw`\b\d{1,2}[:.]\d{2}\b`;

const ATTRIBUTION_RE = new RegExp(
  `^(?:>*\\s*(?:` +
    `.*[\\s"'>'](wrote|writes)\\s*[:：]` +
    `|.*<\\S+@\\S+>\\s+(?:wrote|writes)\\b.*` +
    String.raw`|(?:on|at)\b[\s,]*(?:\d|(?:mon|tue|wed|thu|fri|sat|sun)\b).*${YEAR_TOKEN}.*${TIME_TOKEN}.*` +
    String.raw`|\d{4}-\d{2}-\d{2}\b.*${TIME_TOKEN}.*` +
    `))$`,
  "i",
);

const SEPARATOR_RE = /^\s*\*?\s*(?:[-_]{5,}|-{2,}.+-{2,}|original message|forwarded message)\s*\*?\s*$/i;

const HEADER_FROM_FIELDS = ["from"];
const HEADER_FIELDS = ["to", "cc", "bcc", "sent", "date", "subject", "reply-to", "from"];

/** Upstream headerLine (reply.go:128-137): "field: " (the ASCII colon
 *  needs the space so prose like "To:do this" is ignored) or the CJK
 *  fullwidth colon without one. */
function headerLine(line: string, fields: string[]): boolean {
  const lower = line.toLowerCase();
  for (const field of fields) {
    if (lower.startsWith(field)) {
      const rest = lower.slice(field.length);
      if (rest.startsWith(": ") || rest.startsWith("：")) return true;
    }
  }
  return false;
}

/** Upstream headerBlock (reply.go:113-123): a From-field line whose next
 *  non-blank line is another field — the second-line guard keeps a lone
 *  "Subject:" sentence in prose from becoming a boundary. */
function headerBlock(first: string, rest: string[]): boolean {
  if (!headerLine(first, HEADER_FROM_FIELDS)) return false;
  for (const next of rest) {
    const t = next.trim();
    if (t !== "") return headerLine(t, HEADER_FIELDS);
  }
  return false;
}

/**
 * Upstream extractReply (reply.go:80-108): cut at the FIRST signature /
 * attribution / separator / forwarded-header-block line, drop the
 * trailing quoted/blank block (kept whole when the ENTIRE body is quoted,
 * :94-107), trim.
 */
export function extractReplyText(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (
      SIGNATURE_RE.test(trimmed) ||
      ATTRIBUTION_RE.test(trimmed) ||
      SEPARATOR_RE.test(trimmed) ||
      headerBlock(trimmed, lines.slice(i + 1))
    ) {
      lines.length = i;
      break;
    }
  }
  let end = lines.length;
  while (end > 0) {
    const t = lines[end - 1]!.trim();
    if (t !== "" && t !== "ᐧ" && !t.startsWith(">")) break;
    end--;
  }
  if (end > 0) lines.length = end;
  return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// The pipeline (SPEC §6)
// ---------------------------------------------------------------------------

/** The env slice the handler reads (structurally satisfied by the worker's
 *  generated `Env` once the operator copies the example config — the
 *  disabled no-op runs when the vars are absent, SPEC §7). */
export interface InboundEmailEnv {
  DB: D1Database;
  REPO_TASKS?: Queue;
  APP_URL?: string;
  MAIL_ENABLED?: string;
  MAIL_FROM?: string;
  MAIL_INBOUND_ENABLED?: string;
  MAIL_INBOUND_REPLY_ADDRESS?: string;
  MAIL_INBOUND_SECRET?: string;
}

/** The `ForwardableEmailMessage` surface the service needs (worker-
 *  configuration.d.ts:13306-13345) — the fake shape the tests drive. */
export interface InboundEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

export type InboundEmailOutcome =
  | { outcome: "disabled" }
  | { outcome: "misconfigured"; message: string }
  | { outcome: "rejected-oversize" }
  | { outcome: "dropped-duplicate" }
  | { outcome: "dropped-auto-reply" }
  | { outcome: "dropped-no-token" }
  | { outcome: "dropped-invalid-token" }
  | { outcome: "dropped-expired-token" }
  | { outcome: "dropped-permission" }
  | { outcome: "dropped-empty" }
  | { outcome: "dropped-missing-ref" }
  | { outcome: "comment-created"; commentId: number };

const OUTCOME_CLIP = 998;
const ERROR_CLIP = 1024;

/** The row's verdict vocabulary (the schema column's enum) — narrower than
 *  the outcome union (the disabled arm writes no row; `misconfigured` the
 *  outcome is `dropped-misconfigured` on the row). */
type InboundRowOutcome = (typeof emailInbound.$inferSelect)["outcome"];

function clip(text: string, at: number): string {
  return text.length > at ? text.slice(0, at) : text;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const MODE_RANK: Record<TeamAccessMode, number> = { none: 0, read: 1, write: 2, admin: 3, owner: 4 };

/**
 * The orchestrator (SPEC §6). Steps run in upstream's order where the
 * platform permits; the dedupe INSERT (step 4) moves ahead of everything
 * else because Email Routing is at-least-once — a redelivered duplicate
 * must die before ANY processing. Throws only on a persistence failure
 * (the mount does not catch — the platform processing-failure signal).
 */
export async function handleIncomingEmail(
  env: InboundEmailEnv,
  message: InboundEmailMessage,
  options: { now?: Date } = {},
): Promise<InboundEmailOutcome> {
  const now = options.now ?? new Date();
  const db = drizzle(env.DB);

  // 1. Gate (upstream Init's early return, incoming.go:26-28) — ZERO D1
  // writes (the gate-off tripwire posture).
  if (env.MAIL_INBOUND_ENABLED !== "true") {
    console.log(`[mail-inbound] disabled; dropping mail from ${message.from}`);
    return { outcome: "disabled" };
  }

  // 2-3. Envelope facts + the dedupe key (Message-ID, else the stable
  // envelope tuple hash — SPEC §3.4).
  const messageId = clip((message.headers.get("message-id") ?? "").trim(), OUTCOME_CLIP);
  const subject = clip((message.headers.get("subject") ?? "").trim(), OUTCOME_CLIP);
  const cfAuth = message.headers.get("authentication-results");
  const authResults = cfAuth !== null && cfAuth.includes("mx.cloudflare.net") ? clip(cfAuth.trim(), 1024) : null;
  const dedupeKey =
    messageId !== ""
      ? messageId
      : await sha256Hex(`${message.from}|${message.to}|${subject}|${message.headers.get("date") ?? ""}|${message.rawSize}`);

  const insertRow = async (outcomeOverride?: InboundRowOutcome): Promise<boolean> => {
    const inserted = await db
      .insert(emailInbound)
      .values({
        dedupeKey,
        messageId,
        fromAddress: clip(message.from, OUTCOME_CLIP),
        toAddr: clip(message.to, OUTCOME_CLIP),
        subject,
        authResults,
        outcome: outcomeOverride ?? "pending",
        receivedAt: now,
      })
      .onConflictDoNothing({ target: emailInbound.dedupeKey })
      .returning({ id: emailInbound.id });
    return inserted.length > 0;
  };
  const setOutcome = async (values: {
    outcome: InboundRowOutcome;
    tokenStatus?: "none" | "invalid" | "expired" | "valid";
    userId?: number;
    refType?: "issue" | "comment";
    refId?: number;
    commentId?: number;
    error?: string;
  }): Promise<void> => {
    await db
      .update(emailInbound)
      .set({ ...values, processedAt: now })
      .where(eq(emailInbound.dedupeKey, dedupeKey));
  };

  // 2. Config validation — no boot step, so the loud log + visible row is
  // the upstream-Fatal adaptation (incoming_email.go:42-45; SPEC §6.2).
  const secret = env.MAIL_INBOUND_SECRET ?? "";
  const template = parseReplyAddressTemplate(env.MAIL_INBOUND_REPLY_ADDRESS ?? "");
  if (secret === "" || template === null) {
    const what = secret === "" ? "MAIL_INBOUND_SECRET is missing" : "MAIL_INBOUND_REPLY_ADDRESS is invalid";
    console.warn(`[mail-inbound] ${what}; dropping mail from ${message.from}`);
    await insertRow("dropped-misconfigured");
    return { outcome: "misconfigured", message: `[mail-inbound] ${what}` };
  }

  // 3. Size gate — BEFORE any stream read (SPEC §4.5): as the MX we answer
  // the connecting MTA with a permanent reject (upstream's IMAP client
  // could only skip fetching; the MX position upgrades skip → bounce).
  if (message.rawSize > MAIL_INBOUND_MAX_MESSAGE_SIZE) {
    await insertRow("rejected-oversize");
    message.setReject("message exceeds the maximum accepted size (10 MiB)");
    return { outcome: "rejected-oversize" };
  }

  // 4. Dedupe insert — the UNIQUE arbiter IS the at-least-once verdict
  // (SPEC §3.4); the FIRST row owns the outcome.
  const isFresh = await insertRow();
  if (!isFresh) {
    console.log(`[mail-inbound] duplicate delivery for key ${dedupeKey.slice(0, 64)}; dropping`);
    return { outcome: "dropped-duplicate" };
  }

  // 5. Automatic-reply skip BEFORE the token search (upstream order,
  // incoming.go:210-219) — the machine half of loop prevention.
  if (isAutomaticReply(message.headers)) {
    await setOutcome({ outcome: "dropped-auto-reply" });
    return { outcome: "dropped-auto-reply" };
  }

  // 6. Token search (To → Delivered-To → References).
  const appDomain = appDomainFromAppUrl(env.APP_URL);
  const token = extractTokenFromHeaders(message.headers, template, appDomain);
  if (token === "") {
    await setOutcome({ outcome: "dropped-no-token" });
    return { outcome: "dropped-no-token" };
  }

  // 7. Decode + verify (constant-time; §3.2).
  const decoded = await decodeReplyToken(secret, token);
  if (!decoded.ok) {
    if (decoded.reason === "expired") {
      await setOutcome({ outcome: "dropped-expired-token", tokenStatus: "expired" });
      return { outcome: "dropped-expired-token" };
    }
    await setOutcome({ outcome: "dropped-invalid-token", tokenStatus: "invalid" });
    return { outcome: "dropped-invalid-token" };
  }

  // The GetValidDoerUserByID parity (models/user/user.go:1099-1112): the
  // row must exist, be an individual, active, not prohibited — our shape:
  // type 'user' (no bots in the schema; orgs are not mailable
  // participants on the outbound side either) + status 'active'.
  const doer = await db.select().from(users).where(eq(users.id, decoded.userId)).get();
  if (doer === undefined || doer.type !== "user" || doer.status !== "active") {
    await setOutcome({ outcome: "dropped-invalid-token", tokenStatus: "invalid" });
    return { outcome: "dropped-invalid-token" };
  }

  // 8. Reference resolve (incoming_handler.go:44-64): comment → its issue.
  let issueRow: typeof issues.$inferSelect | undefined;
  if (decoded.refType === "comment") {
    const comment = await db.select().from(comments).where(eq(comments.id, decoded.refId)).get();
    if (comment === undefined) {
      await setOutcome({ outcome: "dropped-missing-ref", tokenStatus: "valid" });
      return { outcome: "dropped-missing-ref" };
    }
    issueRow = await db.select().from(issues).where(eq(issues.id, comment.issueId)).get();
  } else {
    issueRow = await db.select().from(issues).where(eq(issues.id, decoded.refId)).get();
  }
  if (issueRow === undefined) {
    await setOutcome({
      outcome: "dropped-missing-ref",
      tokenStatus: "valid",
      userId: decoded.userId,
      refType: decoded.refType,
      refId: decoded.refId,
    });
    return { outcome: "dropped-missing-ref" };
  }
  // Stamp the decode facts (the row's outcome stays 'pending' — steps
  // 9-11 own it from here).
  await db
    .update(emailInbound)
    .set({ tokenStatus: "valid", userId: decoded.userId, refType: decoded.refType, refId: decoded.refId })
    .where(eq(emailInbound.dedupeKey, dedupeKey));

  // 9. The two FRESH permission gates (incoming_handler.go:70-84): read,
  // then locked-requires-write, site admin overriding both (the upstream
  // !doer.IsAdmin arm). Silent skips — never errors, never bounces.
  const pair = await findRepositoryById(env.DB, issueRow.repoId);
  if (pair === null) {
    await setOutcome({ outcome: "dropped-missing-ref" });
    return { outcome: "dropped-missing-ref" };
  }
  const isOwner = pair.repo.ownerId === decoded.userId;
  const isAdmin = doer.isAdmin === true;
  const mode: TeamAccessMode = isOwner || isAdmin ? "owner" : await doerRepoAccessMode(env.DB, pair.repo, decoded.userId);
  // The CheckRepoUnitUser read shape (repo_permission.go:660-672, the
  // notify hub's exact port at notify.ts:462): site admin always, a PUBLIC
  // repo reads to everyone, a private repo needs a grant.
  const publicRepo = pair.repo.visibility === "public";
  const canRead = isAdmin || publicRepo || mode !== "none";
  const canWrite = isAdmin || MODE_RANK[mode] >= MODE_RANK.write;
  const lockGate = issueRow.isLocked === true && !canWrite;
  if (!canRead || lockGate) {
    console.log(
      `[mail-inbound] permission gate for user ${decoded.userId} on repo ${issueRow.repoId} (read=${canRead}, locked=${issueRow.isLocked === true}); dropping`,
    );
    await setOutcome({ outcome: "dropped-permission" });
    return { outcome: "dropped-permission" };
  }

  // 10. Body extract + the quoted-reply trim; empty → drop
  // (incoming_handler.go:112-114). The pre-gate makes the bounded-read
  // oversize throw unreachable for honest rawSize values; the catch keeps
  // a lying value from wedging the handler.
  let content: string;
  try {
    const text = await extractMailText(message.raw, message.headers, MAIL_INBOUND_MAX_MESSAGE_SIZE);
    content = extractReplyText(text);
  } catch (error) {
    if (error instanceof MailInboundOversizeError) {
      message.setReject("message exceeds the maximum accepted size (10 MiB)");
      await setOutcome({ outcome: "rejected-oversize" });
      return { outcome: "rejected-oversize" };
    }
    throw error;
  }
  if (content === "") {
    await setOutcome({ outcome: "dropped-empty" });
    return { outcome: "dropped-empty" };
  }

  // 11. Emit through the LANDED IssuesService with its mail env — the
  // comment fans the notify hub exactly like a web-posted one
  // (incoming_handler.go:116-148's CreateIssueComment arm). A write
  // failure records `error` + RETHROWS (the mount does not catch — the
  // platform processing-failure signal, SPEC §6.11).
  const service = new IssuesService(env.DB, env);
  let commentId: number;
  try {
    const comment = await service.addComment({
      issueId: issueRow.id,
      posterId: decoded.userId,
      content,
      now,
    });
    commentId = comment.id;
  } catch (error) {
    const text = clip(error instanceof Error ? error.message : String(error), ERROR_CLIP);
    await setOutcome({ outcome: "error", error: text });
    throw error;
  }
  await setOutcome({ outcome: "comment-created", commentId });
  return { outcome: "comment-created", commentId };
}
