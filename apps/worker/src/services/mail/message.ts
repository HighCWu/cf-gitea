/**
 * Mail message shaping (specs/email-outbound.md §2.1, §4.2) — the port of the
 * upstream pin's send-time transforms over a stored outbox row:
 *
 *   - subject sanitize + prefix  — gitea/services/mailer/mail.go:32,49-56
 *     (collapse whitespace runs, trim, 256-rune clamp) with the
 *     `SUBJECT_PREFIX` prepend from sender/message.go:56-60;
 *   - the auto `Message-ID`      — sender/message.go:96-105
 *     (`<autogen-<unixMilli>-<fnv64(to+subject+body) hex>@<AppDomain>>`,
 *     Go `hash/fnv` FNV-1 64-bit, byte-ported);
 *   - `X-Auto-Response-Suppress: All` — sender/message.go:62 (always);
 *   - the text/plain half        — sender/message.go:64 (upstream derives it
 *     from the HTML with Necoro/html2text; ours is the deterministic
 *     reduction documented as the SPEC §5.6 divergence);
 *   - the `To` display form      — models/user/user.go:450-465 (`EmailTo`:
 *     "Name <addr>" with the emailToReplacer strip of \n \r < > , : ;,
 *     user.go:587-596).
 *
 * Deliberate divergences (both recorded in the SPEC): MIME Q-encoding of the
 * subject and of the To display name is NOT applied — upstream encodes for
 * the raw SMTP wire, while a relay transport carries UTF-8 JSON end to end;
 * and the Date header is emitted by the transport mapping, not here.
 */

/** The stored outbox row's mail half (schema.ts `emailOutbox`). */
export interface StoredMail {
  fromAddress: string;
  fromDisplayName: string;
  toAddr: string;
  replyTo: string | null;
  subject: string;
  bodyHtml: string;
  headers: string | null;
}

/** Upstream `mailMaxSubjectRunes` (services/mailer/mail.go:32). */
export const MAIL_MAX_SUBJECT_RUNES = 256;

const subjectRemoveSpaces = /[\s]+/g;

/**
 * Upstream `sanitizeSubject` (services/mailer/mail.go:49-56): whitespace
 * runs collapse to one space, the ends trim, the rune count clamps to 256.
 * The MIME Q-encode half of upstream's return value is deliberately dropped
 * (module header).
 */
export function sanitizeSubject(subject: string): string {
  const collapsed = subject.replace(subjectRemoveSpaces, " ").trim();
  return [...collapsed].slice(0, MAIL_MAX_SUBJECT_RUNES).join("");
}

/** Upstream `ToMessage`'s subject assembly (sender/message.go:56-60). */
export function buildSubject(subject: string, subjectPrefix?: string): string {
  const sanitized = sanitizeSubject(subject);
  return subjectPrefix && subjectPrefix !== "" ? `${subjectPrefix} ${sanitized}` : sanitized;
}

/**
 * Go `hash/fnv` `New64()` — the FNV-1 64-bit variant (multiply FIRST, then
 * XOR the byte; hash/fnv's sum64.Write, as opposed to FNV-1a). BigInt keeps
 * the 64-bit multiply exact; mail volumes make the cost irrelevant.
 */
export function fnv64(input: string): bigint {
  const prime = 1099511628211n;
  const offsetBasis = 14695981039346656037n;
  let hash = offsetBasis;
  const bytes = new TextEncoder().encode(input);
  for (const byte of bytes) {
    hash *= prime;
    hash ^= BigInt(byte);
    hash &= 0xffffffffffffffffn;
  }
  return hash;
}

/**
 * Upstream `generateAutoMessageID` (sender/message.go:96-105) — set when the
 * transport mapping wants a Message-ID and only when the caller did not
 * supply one in `headers` (upstream checks `GetGenHeader("Message-ID")`
 * first, message.go:77-79).
 */
export function generateAutoMessageId(input: {
  to: string;
  subject: string;
  body: string;
  dateMs: number;
  appDomain: string;
}): string {
  const h = fnv64(`${input.to}${input.subject}${input.body}`);
  return `<autogen-${input.dateMs}-${h.toString(16).padStart(16, "0")}@${input.appDomain}>`;
}

/**
 * The serving domain — upstream `setting.AppDomain` (the ROOT_URL host).
 * Ours is the `APP_URL` var's host; the unset/unparseable fallback is
 * "localhost" (the var is declared in wrangler.jsonc.example, so real
 * deployments carry a host).
 */
export function appDomainFromAppUrl(appUrl: string | undefined): string {
  if (appUrl === undefined || appUrl === "") return "localhost";
  try {
    const host = new URL(appUrl).hostname;
    return host === "" ? "localhost" : host;
  } catch {
    return "localhost";
  }
}

/**
 * Upstream `emailToReplacer` (models/user/user.go:587-596): header-injection
 * characters (\n \r < > , : ;) stripped from the display name before the
 * `EmailTo` render. `formatAddress` is the EmailTo shape (":450-465"):
 * empty name or name == address → the bare address, else `Name <addr>`.
 */
const EMAIL_TO_REPLACER = /[\n\r<>,:;]/g;

export function formatAddress(displayName: string, address: string): string {
  if (displayName === "" || displayName === address) return address;
  return `${displayName.replace(EMAIL_TO_REPLACER, "")} <${address}>`;
}

/**
 * The SPEC §5.6 divergence: a deterministic HTML→text reduction standing in
 * for upstream's `html2text.FromString` (sender/message.go:64). Style and
 * script blocks drop whole, block-level closers become newlines, remaining
 * tags strip, the entities our templates emit decode, whitespace runs
 * collapse. The HTML alternative stays byte-faithful — that is what
 * upstream's templates author.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The fully shaped message a transport receives (upstream `gomail.Msg`'s
 *  relevant surface, post-`ToMessage`). */
export interface OutgoingMail {
  /** RFC 5322 From (display form; `formatAddress`). */
  from: string;
  /** The single envelope/To recipient (upstream's leak prevention). */
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo: string | null;
  /** Extra headers incl. Message-ID / X-Auto-Response-Suppress / the
   *  X-Gitea-* metadata family. */
  headers: Record<string, string>;
}

/**
 * `ToMessage`'s port (sender/message.go:44-89) over a stored row: prefix the
 * subject, fold the row headers in (stored JSON `Record<string, string>` —
 * the SPEC §4.4 single-value reduction), always set
 * `X-Auto-Response-Suppress: All`, and auto-generate the Message-ID when the
 * headers don't carry one.
 */
export function shapeOutgoingMail(
  row: StoredMail,
  options: {
    subjectPrefix?: string;
    appUrl?: string;
    now?: Date;
  } = {},
): OutgoingMail {
  const headers: Record<string, string> = {};
  if (row.headers !== null && row.headers !== "") {
    try {
      const parsed: unknown = JSON.parse(row.headers);
      if (typeof parsed === "object" && parsed !== null) {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === "string") headers[key] = value;
        }
      }
    } catch {
      // A malformed stored header map degrades to "no extra headers" — the
      // send proceeds (the row's purpose headers are metadata, not delivery
      // requirements).
    }
  }

  const now = options.now ?? new Date();
  const subject = buildSubject(row.subject, options.subjectPrefix);
  if (headers["Message-ID"] === undefined || headers["Message-ID"] === "") {
    headers["Message-ID"] = generateAutoMessageId({
      to: row.toAddr,
      subject,
      body: row.bodyHtml,
      dateMs: now.getTime(),
      appDomain: appDomainFromAppUrl(options.appUrl),
    });
  }
  headers["X-Auto-Response-Suppress"] = "All";

  return {
    from: formatAddress(row.fromDisplayName, row.fromAddress),
    to: row.toAddr,
    subject,
    html: row.bodyHtml,
    text: htmlToText(row.bodyHtml),
    replyTo: row.replyTo === "" ? null : row.replyTo,
    headers,
  };
}

/**
 * `MAIL_FROM` parsing (upstream mailer.go:180-189 splits `mail.ParseAddress`
 * into FromName/FromEmail): accepts `addr@x` or `Name <addr@x>`; null when
 * no address part survives — the SPEC §5.2 skip-with-a-warning posture.
 */
export function parseMailFrom(raw: string): { displayName: string; address: string } | null {
  const trimmed = raw.trim();
  const angled = /^<([^<>]+)>(.*)$/.exec(trimmed);
  if (angled !== null) {
    const address = angled[1]!.trim();
    if (!address.includes("@")) return null;
    return { displayName: angled[2]!.trim(), address };
  }
  const named = /^(.*)<([^<>]+)>$/.exec(trimmed);
  if (named !== null) {
    const address = named[2]!.trim();
    if (!address.includes("@")) return null;
    return { displayName: named[1]!.trim().replace(/^"|"$/g, ""), address };
  }
  if (!trimmed.includes("@") || /\s/.test(trimmed)) return null;
  return { displayName: "", address: trimmed };
}
