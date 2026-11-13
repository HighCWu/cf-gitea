/**
 * The SMTP transport arm (census B-66) — the port of upstream's default
 * sender (`gitea/services/mailer/sender/smtp.go:27-60`, session ladder over
 * Go net/smtp) onto workerd's `cloudflare:sockets` connect() TCP API. The
 * email-outbound SPEC's founding premise ("Workers cannot open outbound
 * TCP") is FALSE on the current platform — the census B-66 re-open cites
 * AGENTS.md's own Workers rules; the probe evidence lives in the B-66
 * landing record (real TCP through workerd's loopback connector to a local
 * listener, full plaintext + STARTTLS + implicit-TLS ladders walked).
 *
 * Config surface — the upstream `[mailer]` SMTP keys (modules/setting/
 * mailer.go:36-43 + :123-151 inference), carried by the MAIL_* vars:
 *
 *   MAIL_PROVIDER=smtp        the protocol-switch value (mailer.go:37-44)
 *   MAIL_SMTP_PROTOCOL        PROTOCOL  — "smtp" | "smtps" | "smtp+starttls";
 *                             empty infers from the port, both unset →
 *                             smtps on 465 (upstream's own fall-through,
 *                             mailer.go:148-151); "smtp+unix" refuses
 *                             (no unix sockets on the platform)
 *   MAIL_SMTP_ADDR            SMTP_ADDR — the host (required to arm)
 *   MAIL_SMTP_PORT            SMTP_PORT — empty infers from the protocol
 *                             (25 / 465 / 587, mailer.go:124-131)
 *   MAIL_SMTP_USER            USER      — empty ⇒ session stays
 *                             unauthenticated (upstream `len(opts.User) > 0`)
 *   MAIL_SMTP_PASSWORD        PASSWD    — a wrangler secret
 *                             (MAIL_SMTP_PASSWORD name only, never a value)
 *   MAIL_SMTP_ENABLE_HELO     ENABLE_HELO — default true (MustBool(true));
 *                             only the literal "false" disables
 *   MAIL_SMTP_HELO_HOSTNAME   HELO_HOSTNAME — upstream defaults to
 *                             os.Hostname(); workerd has no OS hostname, so
 *                             the recorded adaptation defaults to "localhost"
 *   MAIL_SMTP_ENVELOPE_FROM   ENVELOPE_FROM — non-empty override of the
 *                             envelope sender (smtp.go:73-75); the literal
 *                             "none" keeps the header From (upstream's
 *                             OverrideEnvelopeFrom=false arm, mailer.go:201-204)
 *
 * Upstream arms NOT ported, with reasons (never faked):
 *   - sendmail (`smtp.go` sibling sender): process exec does not exist in
 *     workerd — stands platform-impossible (the census row's standing half).
 *   - smtp+unix: no unix-domain sockets in workerd — refused with a
 *     MailPermanentError naming the arm.
 *   - AUTH CRAM-MD5 / NTLM (smtp_auth.go): upstream picks CRAM-MD5 first
 *     when the server offers it; WebCrypto lacks MD5 (this tree DOES carry
 *     the hand-built RFC-1321 md5 — packages/md5.ts — so CRAM-MD5 is a
 *     cheap recorded backlog arm; NTLM needs the whole ntlmssp message
 *     family). Ours fails the send with a MailPermanentError naming the
 *     mechanism instead of silently skipping — an unauthenticated fallback
 *     on a credentials-provided config would leak mail onto the wrong
 *     trust posture (ADR-0008: silent ignores are forbidden).
 *   - FORCE_TRUST_SERVER_CERT: workerd's TLS stack always verifies against
 *     the system CA store; startTls exposes no insecure mode. The var has
 *     no honest analogue and is NOT declared.
 *   - USE_CLIENT_CERT / CLIENT_CERT_FILE / CLIENT_KEY_FILE: startTls takes
 *     no client certificate — platform force.
 *   - mailer.override_header: an ini key->multi-value map, not expressible
 *     in the flat MAIL_* var surface (recorded).
 *
 * Failure taxonomy (transport.ts §3.3): reply 5xx and envelope/config
 * faults → MailPermanentError (acked, row `failed`); reply 4xx, network
 * throws, timeouts → MailTransientError (the queue-retry signal). This is
 * the upstream terminal-drop made retryable, bounded by the outbox's
 * attempt budget — the same deliberate strengthening the resend arm records.
 *
 * The DATA payload (buildRfc822Message) renders the shaped message the way
 * the pinned go-mail v0.8.1 `WriteTo` does (the library message.ts's
 * module header cites): address headers (From/To/Reply-To), the generic
 * headers sorted alphabetically (Date, Message-ID, Subject, then the
 * X-* family), MIME-Version 1.0, multipart/alternative with the text/plain
 * half first (sender/message.go:64-77), both parts quoted-printable UTF-8
 * (NewMsg defaults, go-mail msg.go:211-215), RFC 2047 Q encoded-words for
 * non-ASCII Subject/From display names (message.ts deliberately skips the
 * encode for the RELAY arms; the raw-wire arm must do it — the divergence
 * note records the transport split).
 */

import { MailPermanentError, MailTransientError, type MailTransport } from "./transport";
import type { OutgoingMail } from "./message";

/** The workerd socket surface the session drives (the cloudflare:sockets
 *  Socket shape, kept as a seam so the tests can host real stub listeners
 *  and so a future transport swap cannot leak socket types outward). */
export interface SmtpSocket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  /** Resolves once the TCP connect (plaintext) or the TLS handshake
   *  (implicit TLS) completes; for the "starttls" posture it stays
   *  pending until startTls — the caller must not await it there. */
  readonly opened: Promise<{ remoteAddress?: string; localAddress?: string }>;
  /** The STARTTLS upgrade — upstream `client.StartTLS(tlsconfig)`
   *  (smtp.go:57-61); `expectedServerHostname` is tls.Config.ServerName. */
  startTls(options?: { expectedServerHostname?: string }): Promise<SmtpSocket>;
  close(): Promise<void>;
}

export type SmtpDial = (
  address: string,
  secureTransport: "off" | "on" | "starttls",
) => Promise<SmtpSocket>;

/** The real dial — cloudflare:sockets connect() (the platform-truth arm).
 *  `opened` resolves with the SocketInfo after the TCP connect (plaintext)
 *  or the TLS handshake (implicit TLS); for "starttls" it stays pending
 *  until the upgrade, so the caller must not await it there. The workerd
 *  Socket adapts to the SmtpSocket seam (startTls returns synchronously
 *  there; the seam await is uniform for the stub dials). */
function adaptWorkerSocket(socket: Socket): SmtpSocket {
  const adapted = (inner: Socket): SmtpSocket => ({
    // workerd's Socket declares `ReadableStream` (the any-parameterized
    // generic); these narrowing casts pin the seam's element type.
    readable: inner.readable as ReadableStream<Uint8Array>,
    writable: inner.writable as WritableStream<Uint8Array>,
    opened: inner.opened,
    startTls: (options) =>
      Promise.resolve(adapted(inner.startTls({ expectedServerHostname: options?.expectedServerHostname }))),
    close: () => inner.close(),
  });
  return adapted(socket);
}

const defaultDial: SmtpDial = async (address, secureTransport) => {
  const { connect } = await import("cloudflare:sockets");
  return adaptWorkerSocket(connect(address, { secureTransport, allowHalfOpen: false }));
};

/** Per-command I/O bound. Upstream's net/smtp runs without deadlines, but
 *  a queue consumer must never hang forever; the attempt budget bounds the
 *  retry side, this bounds the side that would hold the CPU. */
const SMTP_IO_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new MailTransientError(`smtp: ${label} timed out after ${SMTP_IO_TIMEOUT_MS}ms`)),
        SMTP_IO_TIMEOUT_MS,
      ),
    ),
  ]);
}

/** One reply: the numeric code, the folded text, and the raw lines. */
export interface SmtpReply {
  code: number;
  /** The multiline reply's text joined with "\n" (the EHLO keyword block). */
  text: string;
  lines: string[];
}

class SmtpNetworkError extends Error {}

/** The session reader/writer over one SmtpSocket — the net/smtp textproto
 *  analogue: line framing, SMTP reply assembly (multiline "250-..." runs
 *  end on the code-space line), the STARTTLS stream swap. */
class SmtpSession {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private buf = "";

  constructor(private socket: SmtpSocket) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  /** Assemble one full reply: consecutive lines whose final line is the
   *  same code followed by a space (RFC 5321 §4.2). */
  async readReply(): Promise<SmtpReply> {
    const lines: string[] = [];
    for (;;) {
      let nl: number;
      while ((nl = this.buf.indexOf("\r\n")) === -1) {
        const { done, value } = await withTimeout(this.reader.read(), "socket read");
        if (done) {
          throw new SmtpNetworkError(
            `smtp: connection closed mid-reply (had: ${JSON.stringify(lines)})`,
          );
        }
        this.buf += this.decoder.decode(value, { stream: true });
      }
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 2);
      lines.push(line);
      if (line.length < 4 || line[3] !== "-") break;
    }
    const code = Number.parseInt(lines[0]!.slice(0, 3), 10);
    if (!Number.isInteger(code)) {
      throw new SmtpNetworkError(`smtp: unparseable reply ${JSON.stringify(lines)}`);
    }
    return { code, text: lines.join("\n"), lines };
  }

  async send(line: string): Promise<void> {
    await withTimeout(this.writer.write(this.encoder.encode(`${line}\r\n`)), "socket write");
  }

  /** Raw write for the DATA block (already dot-stuffed, already framed). */
  async writeRaw(chunk: string): Promise<void> {
    await withTimeout(this.writer.write(this.encoder.encode(chunk)), "socket write");
  }

  /** The STARTTLS upgrade (smtp.go:57-61's client.StartTLS analogue):
   *  release the stream locks (workerd forbids re-getReader under an
   *  active one), swap the socket, re-acquire. */
  async startTls(expectedServerHostname: string): Promise<void> {
    this.reader.releaseLock();
    this.writer.releaseLock();
    this.socket = await withTimeout(
      this.socket.startTls({ expectedServerHostname }),
      "TLS upgrade",
    );
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();
    this.buf = "";
  }

  async close(): Promise<void> {
    try {
      await withTimeout(this.writer.close(), "writer close");
      await withTimeout(this.socket.close(), "socket close");
    } catch {
      this.reader.releaseLock();
      this.writer.releaseLock();
    }
  }

  /** send + readReply in one step (the net/smtp cmd() convenience). */
  async readReplyAfterSend(line: string): Promise<SmtpReply> {
    await this.send(line);
    return this.readReply();
  }

  /** EHLO keyword map — the net/smtp `ehlo()` parse (first reply line is
   *  the server banner; every further line is CODE SP KEY [VALUE], the
   *  keyword search starting past the reply-code separator). */
  extensions(reply: SmtpReply): Map<string, string> {
    const ext = new Map<string, string>();
    for (const line of reply.lines.slice(1)) {
      const space = line.indexOf(" ", 4);
      const key = space === -1 ? line.slice(4) : line.slice(4, space);
      const value = space === -1 ? "" : line.slice(space + 1);
      ext.set(key, value);
    }
    return ext;
  }
}

/** Reply-code classing (transport.ts §3.3): 5xx permanent, 4xx transient,
 *  anything else out of place → permanent (protocol broke). */
function replyError(context: string, reply: SmtpReply): Error {
  const message = `${context}: ${reply.code} ${reply.text}`;
  return Math.trunc(reply.code / 100) === 4
    ? new MailTransientError(message)
    : new MailPermanentError(message);
}

function isTransient(error: unknown): boolean {
  return error instanceof MailTransientError || error instanceof SmtpNetworkError;
}

function networkError(context: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof MailTransientError || error instanceof MailPermanentError) {
    return error;
  }
  return new SmtpNetworkError(`smtp: ${context}: ${detail}`);
}

// ---------------------------------------------------------------------------
// The RFC 822 DATA payload — the go-mail v0.8.1 WriteTo analogue.
// ---------------------------------------------------------------------------

const NON_ASCII = /[^\x20-\x7e]/;

/** RFC 2047 "Q" text for one encoded-word chunk: space → "_", "?" "=" and
 *  non-printables/ASCII-unsafe → =XX, everything else verbatim. */
function qEncodeText(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (const byte of bytes) {
    const ch = String.fromCharCode(byte);
    if (
      byte === 0x20 ||
      byte === 0x3f /* ? */ ||
      byte === 0x3d /* = */ ||
      byte < 0x20 ||
      byte > 0x7e
    ) {
      out += `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/** An RFC 2047 encoded-word run for non-ASCII text: 64-char Q chunks
 *  (each `=?UTF-8?q?…?=` ≤ 75 chars) folded with CRLF+space per RFC 5322.
 *  ASCII text passes through verbatim — mime.WordEncoder's own behavior. */
function encodeHeaderText(text: string): string {
  if (!NON_ASCII.test(text)) return text;
  const words: string[] = [];
  let pending = "";
  for (const ch of text) {
    const candidate = qEncodeText(pending + ch);
    if (pending !== "" && candidate.length > 64) {
      words.push(`=?UTF-8?q?${qEncodeText(pending)}?=`);
      pending = ch;
    } else {
      pending += ch;
    }
  }
  if (pending !== "") words.push(`=?UTF-8?q?${qEncodeText(pending)}?=`);
  return words.join("\r\n ");
}

/** RFC 2045 quoted-printable: = and non-printables → =XX, trailing
 *  whitespace on a line protected, soft breaks at 76 output chars, lone
 *  newlines normalized to CRLF. */
function quotedPrintable(text: string): string {
  const normalized = text.replace(/\r?\n/g, "\r\n");
  const outLines: string[] = [];
  for (const line of normalized.split("\r\n")) {
    let out = "";
    let lineBytes = 0;
    const flushSoftBreak = () => {
      out += "=\r\n";
      lineBytes = 0;
    };
    const encodeByte = (byte: number): string =>
      byte === 0x3d || byte < 0x20 || byte > 0x7e
        ? `=${byte.toString(16).toUpperCase().padStart(2, "0")}`
        : String.fromCharCode(byte);
    const units = [...line];
    for (const [index, unit] of units.entries()) {
      const bytes = new TextEncoder().encode(unit);
      const rendered = [...bytes].map(encodeByte).join("");
      const isTrailing = index === units.length - 1 && /[ \t]/.test(unit);
      if (lineBytes + rendered.length > 75) flushSoftBreak();
      if (isTrailing) {
        out += [...bytes].map((b) => `=${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
        lineBytes += rendered.length;
      } else {
        out += rendered;
        lineBytes += rendered.length;
      }
    }
    outLines.push(out);
  }
  return outLines.join("\r\n");
}

/** `formatAddress`' exact inverse (message.ts guarantees the shape: the
 *  name has no < > , : ; \n \r, so the last " <" ... ">" split is total). */
function splitDisplayForm(form: string): { name: string; address: string } {
  const open = form.lastIndexOf(" <");
  if (open !== -1 && form.endsWith(">")) {
    return { name: form.slice(0, open), address: form.slice(open + 2, -1) };
  }
  return { name: "", address: form };
}

/** One address header line: `Name: <addr>` — the display name carries an
 *  encoded word when non-ASCII (Go mail.Address.String()'s posture). */
function addrHeaderLine(key: string, form: string): string {
  const { name, address } = splitDisplayForm(form);
  if (name === "") return `${key}: <${address}>`;
  return `${key}: ${encodeHeaderText(name)} <${address}>`;
}

/**
 * The DATA payload — the shaped message in go-mail's writeMsg order:
 * address headers first, then the generic headers alphabetically
 * (msgwriter.go writeGenHeader's sort), then MIME-Version + the
 * multipart/alternative boundary, the text/plain part first
 * (sender/message.go:64-77), both quoted-printable UTF-8. Ends with a
 * bare CRLF (the DATA writer adds the terminator).
 */
export function buildRfc822Message(mail: OutgoingMail, boundary: string): string {
  // The generic headers minus the ones the serializer renders explicitly.
  const explicit = new Set(["From", "To", "Reply-To", "Subject", "Date", "Message-ID"]);
  const custom = Object.entries(mail.headers)
    .filter(([key]) => !explicit.has(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const headerLines: string[] = [addrHeaderLine("From", mail.from), `To: <${mail.to}>`];
  if (mail.replyTo !== null) headerLines.push(`Reply-To: <${mail.replyTo}>`);
  headerLines.push(`Date: ${mail.headers["Date"] ?? ""}`);
  if (mail.headers["Message-ID"] !== undefined) {
    headerLines.push(`Message-ID: ${mail.headers["Message-ID"]}`);
  }
  headerLines.push(`Subject: ${encodeHeaderText(mail.subject)}`);
  for (const [key, value] of custom) headerLines.push(`${key}: ${encodeHeaderText(value)}`);
  headerLines.push("MIME-Version: 1.0");
  headerLines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

  const part = (contentType: string, body: string): string =>
    [
      `--${boundary}`,
      `Content-Type: ${contentType}; charset=UTF-8`,
      "Content-Transfer-Encoding: quoted-printable",
      "",
      quotedPrintable(body),
      "",
    ].join("\r\n");

  return `${headerLines.join("\r\n")}\r\n\r\n${part("text/plain", mail.text)}${part("text/html", mail.html)}--${boundary}--\r\n`;
}

/** The net/smtp dotWriter analogue: normalize bare newlines to CRLF, double
 *  every leading dot, append the ".\r\n" terminator. */
export function dotEncode(message: string): string {
  const normalized = `${message.replace(/\r?\n/g, "\r\n")}`;
  const stuffed = normalized.replace(/(^|\r\n)\./g, "$1..");
  return stuffed.endsWith("\r\n") ? `${stuffed}.\r\n` : `${stuffed}\r\n.\r\n`;
}

// ---------------------------------------------------------------------------
// Config resolution — the mailer.go:123-151 inference + :201-212 envelope.
// ---------------------------------------------------------------------------

export interface SmtpTransportOptions {
  protocol: "smtp" | "smtps" | "smtp+starttls";
  addr: string;
  port: string;
  user: string;
  password: string;
  enableHelo: boolean;
  heloHostname: string;
  /** Non-empty → MAIL FROM override (upstream OverrideEnvelopeFrom). */
  envelopeFrom: string;
}

/** The var slice the resolver reads (transport.ts `MailTransportEnv`'s
 *  SMTP extension; outbox.ts carries the same flat fields). */
export interface MailSmtpEnv {
  MAIL_SMTP_PROTOCOL?: string;
  MAIL_SMTP_ADDR?: string;
  MAIL_SMTP_PORT?: string;
  MAIL_SMTP_USER?: string;
  MAIL_SMTP_PASSWORD?: string;
  MAIL_SMTP_ENABLE_HELO?: string;
  MAIL_SMTP_HELO_HOSTNAME?: string;
  MAIL_SMTP_ENVELOPE_FROM?: string;
}

const PORT_BY_PROTOCOL: Record<SmtpTransportOptions["protocol"], string> = {
  smtp: "25",
  smtps: "465",
  "smtp+starttls": "587",
};

/**
 * The MAIL_* var parse with upstream's exact inference (mailer.go:123-151):
 * port infers from protocol, protocol infers from port, BOTH unset falls
 * through to smtps on 465 (upstream's own default, its :148 error log
 * reduced to the thrown message). Config faults throw MailPermanentError —
 * upstream Fatal's at boot (mailer.go:183-184); with no boot step, the
 * outbox row's `failed` + `last_error` is the per-row analogue.
 */
export function resolveSmtpOptions(env: MailSmtpEnv): SmtpTransportOptions {
  const protocolRaw = env.MAIL_SMTP_PROTOCOL?.trim() ?? "";
  const portRaw = env.MAIL_SMTP_PORT?.trim() ?? "";

  if (protocolRaw === "smtp+unix") {
    throw new MailPermanentError(
      "smtp: PROTOCOL smtp+unix is not supported on this platform (no unix-domain sockets in workerd)",
    );
  }

  let protocol: SmtpTransportOptions["protocol"];
  let port = portRaw;
  if (protocolRaw !== "") {
    if (protocolRaw !== "smtp" && protocolRaw !== "smtps" && protocolRaw !== "smtp+starttls") {
      throw new MailPermanentError(
        `smtp: PROTOCOL ${JSON.stringify(protocolRaw)} is not one of smtp | smtps | smtp+starttls (sendmail and smtp+unix are platform-impossible)`,
      );
    }
    protocol = protocolRaw;
    if (port === "") port = PORT_BY_PROTOCOL[protocol];
  } else {
    // The inference: 25→smtp, 465→smtps, 587→smtp+starttls; anything else
    // (including empty) → upstream's fall-through to smtps (:148-151).
    protocol = port === "25" ? "smtp" : port === "587" ? "smtp+starttls" : "smtps";
    if (port === "") port = PORT_BY_PROTOCOL[protocol];
  }

  const addr = env.MAIL_SMTP_ADDR?.trim() ?? "";
  if (addr === "") {
    throw new MailPermanentError("smtp: MAIL_SMTP_ADDR is not set (upstream mailer.SMTP_ADDR)");
  }

  const envelopeRaw = env.MAIL_SMTP_ENVELOPE_FROM?.trim() ?? "";
  let envelopeFrom = "";
  if (envelopeRaw !== "" && envelopeRaw !== "none") {
    const parsed = splitDisplayForm(envelopeRaw);
    const address = parsed.address.trim();
    if (!address.includes("@") || /\s/.test(address)) {
      throw new MailPermanentError(`smtp: invalid ENVELOPE_FROM (${envelopeRaw})`);
    }
    envelopeFrom = address;
  }

  return {
    protocol,
    addr,
    port,
    user: env.MAIL_SMTP_USER?.trim() ?? "",
    password: env.MAIL_SMTP_PASSWORD ?? "",
    enableHelo: env.MAIL_SMTP_ENABLE_HELO !== "false",
    heloHostname: env.MAIL_SMTP_HELO_HOSTNAME?.trim() || "localhost",
    envelopeFrom,
  };
}

// ---------------------------------------------------------------------------
// The transport.
// ---------------------------------------------------------------------------

export class SmtpTransport implements MailTransport {
  readonly provider = "smtp";

  constructor(
    private readonly options: SmtpTransportOptions,
    private readonly dial: SmtpDial = defaultDial,
  ) {}

  async send(mail: OutgoingMail): Promise<void> {
    const { protocol, addr, port, user, password, enableHelo, heloHostname, envelopeFrom } =
      this.options;

    let socket: SmtpSocket;
    try {
      const dialTransport = ({
        smtp: "off",
        smtps: "on",
        "smtp+starttls": "starttls",
      } as const)[protocol];
      socket = await this.dial(`${addr}:${port}`, dialTransport);
    } catch (error) {
      throw networkError(`failed to establish network connection to SMTP server`, error);
    }

    // `opened` resolves with the SocketInfo once the TCP connect (plaintext)
    // or the TLS handshake (smtps) completes; for "starttls" it stays
    // pending until the upgrade — awaiting there would deadlock.
    if (protocol !== "smtp+starttls") {
      try {
        await withTimeout(socket.opened, "socket open");
      } catch (error) {
        throw networkError("failed to establish network connection to SMTP server", error);
      }
    }

    const session = new SmtpSession(socket);
    try {
      // 1. Greeting — net/smtp NewClient's ReadResponse(220).
      const greeting = await session.readReply().catch((e) => {
        throw networkError("could not read SMTP greeting", e);
      });
      if (Math.trunc(greeting.code / 100) !== 2) throw replyError("smtp: greeting", greeting);

      // 2. EHLO (HELO fallback) — Go Client.hello(): EHLO <name>, on any
      // error re-hello with HELO (ext map EMPTY after a HELO fallback —
      // every extension arm below keys off this map, exactly like net/smtp).
      const helloName = enableHelo ? heloHostname : "";
      let extensions: Map<string, string> | null = null;
      const ehlo = await session.readReplyAfterSend(`EHLO ${helloName}`).catch((e) => {
        throw networkError("failed to issue EHLO command", e);
      });
      if (ehlo.code === 250) {
        extensions = session.extensions(ehlo);
      } else {
        const helo = await session.readReplyAfterSend(`HELO ${helloName}`).catch((e) => {
          throw networkError("failed to issue HELO command", e);
        });
        if (helo.code !== 250) throw replyError("smtp: HELO", helo);
        extensions = null;
      }

      // 3. STARTTLS (smtp.go:53-62): only for the smtp+starttls protocol,
      // only when the post-EHLO map advertises it; the upgrade re-EHLOs
      // (Go StartTLS's trailing c.ehlo()) so AUTH/8BITMIME re-resolve over
      // TLS — the post-TLS map is authoritative from here on.
      if (protocol === "smtp+starttls") {
        if (extensions?.has("STARTTLS")) {
          await session.send("STARTTLS");
          const ready = await session.readReply().catch((e) => {
            throw networkError("failed to start TLS connection", e);
          });
          if (ready.code !== 220) throw replyError("smtp: STARTTLS", ready);
          await session.startTls(addr).catch((e) => {
            throw networkError("failed to start TLS connection", e);
          });
          const postTlsEhlo = await session.readReplyAfterSend(`EHLO ${helloName}`).catch((e) => {
            throw networkError("failed to start TLS connection", e);
          });
          if (postTlsEhlo.code !== 250) throw replyError("smtp: STARTTLS EHLO", postTlsEhlo);
          extensions = session.extensions(postTlsEhlo);
        } else {
          console.warn(
            "[mail:smtp] StartTLS requested, but SMTP server does not support it; falling back to regular SMTP",
          );
        }
      }

      // 4. AUTH (smtp.go:64-86): only when USER is set; a server without
      // the AUTH extension fails verbatim (upstream errors.New). The
      // mechanism pick walks upstream's contains-ladder — CRAM-MD5/NTLM
      // refuse with the recorded platform divergence instead of faking.
      if (user !== "") {
        const authOptions = extensions?.get("AUTH");
        if (authOptions === undefined) {
          throw new MailPermanentError("SMTP server does not support AUTH, but credentials provided");
        }
        const mechanism = authOptions.includes("CRAM-MD5")
          ? "CRAM-MD5"
          : authOptions.includes("PLAIN")
            ? "PLAIN"
            : authOptions.includes("LOGIN")
              ? "LOGIN"
              : authOptions.includes("NTLM")
                ? "NTLM"
                : null;
        if (mechanism === "CRAM-MD5" || mechanism === "NTLM") {
          throw new MailPermanentError(
            `smtp: auth mechanism ${mechanism} is not supported on this platform (upstream net/smtp would ${mechanism}; not ported — see the B-66 backlog note)`,
          );
        }
        if (mechanism !== null) {
          await this.auth(session, mechanism, user, password);
        }
        // mechanism null → upstream auth stays nil and the session proceeds
        // unauthenticated (smtp.go's silent fall-through — ported verbatim).
      }

      // 5. Envelope (smtp.go:72-98): the header From, overridden by
      // ENVELOPE_FROM when armed; MAIL FROM carries BODY=8BITMIME /
      // SMTPUTF8 exactly when the extension map advertises them (Go
      // Client.Mail's param posture at the pin's Go).
      const fromAddr = envelopeFrom !== "" ? envelopeFrom : sanitizeEmailAddress(mail.from);
      const params = [
        extensions?.has("8BITMIME") ? " BODY=8BITMIME" : "",
        extensions?.has("SMTPUTF8") ? " SMTPUTF8" : "",
      ].join("");
      const mailReply = await session
        .readReplyAfterSend(`MAIL FROM:<${fromAddr}>${params}`)
        .catch((e) => {
          throw networkError("failed to issue MAIL command", e);
        });
      if (mailReply.code !== 250) throw replyError("smtp: MAIL FROM", mailReply);

      const rcptReply = await session.readReplyAfterSend(`RCPT TO:<${mail.to}>`).catch((e) => {
        throw networkError("failed to issue RCPT command", e);
      });
      if (rcptReply.code !== 250) throw replyError("smtp: RCPT TO", rcptReply);

      // 6. DATA (smtp.go:100-108): 354 → dot-stuffed payload → 250.
      const dataReply = await session.readReplyAfterSend("DATA").catch((e) => {
        throw networkError("failed to issue DATA command", e);
      });
      if (dataReply.code !== 354) throw replyError("smtp: DATA", dataReply);
      const payload = dotEncode(buildRfc822Message(mail, smtpBoundary()));
      await session.writeRaw(payload).catch((e) => {
        throw networkError("SMTP write failed", e);
      });
      const accepted = await session.readReply().catch((e) => {
        throw networkError("SMTP write failed", e);
      });
      if (accepted.code !== 250) throw replyError("smtp: DATA", accepted);

      // 7. QUIT (smtp.go:110-113): upstream logs a Quit failure but the
      // send already succeeded — close best-effort, never fail the send.
      try {
        await session.send("QUIT");
        await session.readReply();
      } catch {
        // logged by the close path; the message is accepted
      }
      await session.close();
    } catch (error) {
      await session.close();
      if (error instanceof MailPermanentError || error instanceof MailTransientError) throw error;
      // Network-class faults (SmtpNetworkError + anything unexpected from
      // the dial) are transient — the queue retry applies.
      throw isTransient(error)
        ? new MailTransientError(error instanceof Error ? error.message : String(error))
        : error;
    }
  }

  /** AUTH PLAIN / AUTH LOGIN — smtp_auth.go's Start/Next ladders (net/smtp
   *  client.Auth's 334-challenge loop). AUTH PLAIN sends the initial
   *  response inline; AUTH LOGIN walks the two b64 prompt challenges and
   *  fails verbatim on an unknown prompt ("unknown fromServer: %s"). */
  private async auth(
    session: SmtpSession,
    mechanism: "PLAIN" | "LOGIN",
    user: string,
    password: string,
  ): Promise<void> {
    const finish = (reply: SmtpReply): void => {
      if (reply.code !== 235) throw replyError("failed to authenticate SMTP", reply);
    };

    if (mechanism === "PLAIN") {
      await session.send(`AUTH PLAIN ${btoa(`\u0000${user}\u0000${password}`)}`);
      finish(
        await session.readReply().catch((e) => {
          throw networkError("failed to authenticate SMTP", e);
        }),
      );
      return;
    }

    await session.send("AUTH LOGIN");
    let reply = await session.readReply().catch((e) => {
      throw networkError("failed to authenticate SMTP", e);
    });
    for (const prompt of ["Username:", "Password:"]) {
      if (reply.code !== 334) throw replyError("failed to authenticate SMTP", reply);
      const challenge = atob(reply.lines[0]!.slice(4)).trim();
      if (challenge !== prompt) {
        throw new MailPermanentError(`failed to authenticate SMTP: unknown fromServer: ${challenge}`);
      }
      await session.send(btoa(prompt === "Username:" ? user : password));
      reply = await session.readReply().catch((e) => {
        throw networkError("failed to authenticate SMTP", e);
      });
    }
    finish(reply);
  }
}

/** Upstream sanitizeEmailAddress (smtp.go end): strip the display name /
 *  any surrounding angle brackets, keep only the bare address, and fail
 *  the send the way upstream does on an unparseable address ("invalid
 *  envelope from address" — mail.ParseAddress's error arm). Upstream's
 *  callers always pass the BARE address (sender.go froms[0].Address); ours
 *  additionally tolerates the header display form (formatAddress's output). */
export function sanitizeEmailAddress(raw: string): string {
  const trimmed = raw.trim();
  const display = splitDisplayForm(trimmed);
  const candidate = (
    display.name !== "" ? display.address : trimmed.replace(/^</, "").replace(/>$/, "")
  )
    .trim();
  if (!candidate.includes("@") || /\s/.test(candidate)) {
    throw new MailPermanentError(`invalid envelope from address: ${JSON.stringify(raw)}`);
  }
  return candidate;
}

/** The MIME boundary — go-mail generates a random one per message
 *  (randomBoundary()); ours is crypto-random per send. */
function smtpBoundary(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/**
 * The `MAIL_PROVIDER=smtp` arm of the transport.ts protocol switch — the
 * config resolve (throws MailPermanentError on config faults, the boot
 * Fatal analogue) + the real connect() dial. `dial` is the test seam (the
 * stub-listener pins run the real wire protocol over it without network).
 */
export function resolveSmtpTransport(
  env: MailSmtpEnv,
  options?: { dial?: SmtpDial },
): SmtpTransport {
  return new SmtpTransport(resolveSmtpOptions(env), options?.dial);
}
