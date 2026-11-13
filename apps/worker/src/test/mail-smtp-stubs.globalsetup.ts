/**
 * The SMTP stub-listener suite for the B-66 transport pins (vitest
 * globalSetup — the NODE side of the pool, where real TCP listeners can
 * live; workerd's cloudflare:sockets connect() reaches the host loopback
 * through miniflare's loopback connector, and the ports reach the tests
 * via vitest provide/inject). Deterministic by construction: ephemeral
 * ports, in-process scripted sessions, no external network, no DNS.
 *
 * Each named stub is one strict conformance server: it answers the
 * upstream ladder and ASSERTS the exact wire bytes the transport must
 * produce (the MAIL FROM / RCPT TO lines, the AUTH PLAIN token, the
 * BODY=8BITMIME/SMTPUTF8 extension params, the dot-unstuffed DATA
 * payload). A byte mismatch is a 5xx reply — the transport surfaces it as
 * a typed error the pin's expect sees, so wire-level assertions ride
 * session success/failure.
 *
 * TLS note (the B-66 platform posture): workerd's outbound TLS verifier
 * REJECTS any self-signed certificate ("invalid peer certificate:
 * UnknownIssuer" for a CA:FALSE leaf, "CaUsedAsEndEntity" for a CA:TRUE
 * one — both observed), and neither workerd nor miniflare exposes a custom
 * trust store for connect(). Real-CA TLS is verified by the landing's
 * public probes (smtp.gmail.com:465 implicit TLS + cloudflare.com:443 —
 * the production posture works); the TLS *ladder logic* is pinned in
 * smtp-transport.test.ts over the in-memory scripted dial seam instead.
 * No TLS stub listener can exist here without faking trust.
 */

import * as net from "node:net";

/** vitest 5 types provide/inject through this augmentation — the stub port
 *  map the tests inject. */
declare module "vitest" {
  interface ProvidedContext {
    mailSmtpStubs: Record<string, number>;
  }
}

/** One scripted session's behavior (see the SPECS table below). */
interface SmtpStubSpec {
  /** A non-default greeting ("421 …" / "554 …" for the taxonomy pins). */
  greeting?: string;
  /** The EHLO keyword lines (default: SIZE + AUTH PLAIN LOGIN). */
  ehloKeywords?: string[];
  /** A fixed EHLO failure reply (the HELO-fallback pin). */
  ehloFixedReply?: string;
  /** The HELO reply after the EHLO failure. */
  heloReply?: string;
  /** The exact AUTH PLAIN token (b64 of "\0smtp-user\0smtp-pass"); a
   *  mismatch answers 535. Undefined → any AUTH attempt answers 502. */
  expectedAuthPlainToken?: string;
  /** Run the AUTH LOGIN prompt ladder (334 Username:/Password:). */
  authLoginLadder?: boolean;
  /** Override the first LOGIN challenge (the unknown-prompt pin). */
  authLoginChallenge?: string;
  /** The exact MAIL FROM line required (default the transport's). */
  expectMailFrom?: string;
  /** Required trailing params on MAIL FROM (BODY=8BITMIME SMTPUTF8). */
  expectMailFromParams?: string;
  /** The exact RCPT TO line required. */
  expectRcptTo?: string;
  /** A fixed MAIL FROM reply (the 451 transient pin). */
  mailReply?: string;
  /** A fixed RCPT TO reply (the 550 permanent pin). */
  rcptReply?: string;
  /** A fixed reply to the DATA dot terminator (the 451 transient pin). */
  dataTerminatorReply?: string;
  /** Byte assertion over the dot-UNSTUFFED DATA payload; a non-null
   *  return is a 554 rejection carrying the text. */
  bodyCheck?: (unstuffed: string) => string | null;
}

const B64_AUTH = Buffer.from("\u0000smtp-user\u0000smtp-pass").toString("base64");

const SPECS: Record<string, SmtpStubSpec> = {
  // The full happy path over plaintext: 220 → EHLO(AUTH PLAIN LOGIN) →
  // AUTH PLAIN (exact token) → exact MAIL/RCPT → DATA (payload bytes).
  plain: {
    expectedAuthPlainToken: B64_AUTH,
    expectMailFrom: "MAIL FROM:<noreply@example.com>",
    expectRcptTo: "RCPT TO:<alice@example.org>",
    bodyCheck: (body) => {
      const problems: string[] = [];
      if (!body.includes("Content-Type: multipart/alternative; boundary=")) {
        problems.push("no multipart/alternative Content-Type");
      }
      if (!body.includes("Content-Transfer-Encoding: quoted-printable")) {
        problems.push("no QP transfer encoding");
      }
      if (!body.includes("<p>Hi <b>Alice</b>.</p>")) problems.push("html half missing");
      if (!body.includes("Hi Alice.") || !body.includes("\r\n.dotline")) {
        problems.push("text half (or the dot-prefixed line) missing");
      }
      return problems.length === 0 ? null : problems.join("; ");
    },
  },
  // The AUTH LOGIN prompt ladder (smtp_auth.go LoginAuth). Upstream's
  // mechanism ladder picks PLAIN before LOGIN, so a LOGIN pin needs a
  // server advertising ONLY LOGIN.
  login: {
    ehloKeywords: ["SIZE 10485760", "AUTH LOGIN"],
    authLoginLadder: true,
    expectMailFrom: "MAIL FROM:<noreply@example.com>",
    expectRcptTo: "RCPT TO:<alice@example.org>",
  },
  // EHLO → 500, HELO → 250: the net/smtp hello() fallback; the extension
  // map stays EMPTY afterwards (no AUTH is attempted by the transport).
  "helo-fallback": {
    ehloFixedReply: "500 unrecognized",
    heloReply: "250 stub plain",
    expectMailFrom: "MAIL FROM:<noreply@example.com>",
    expectRcptTo: "RCPT TO:<alice@example.org>",
  },
  // smtp+starttls against a server with NO STARTTLS keyword: upstream's
  // warn-and-fall-back-to-plaintext arm — the envelope completes over the
  // same plaintext connection (the real-TLS arms have no local stub; see
  // the TLS note in the header).
  "starttls-missing": {
    ehloKeywords: ["SIZE 10485760"],
    expectMailFrom: "MAIL FROM:<noreply@example.com>",
    expectRcptTo: "RCPT TO:<alice@example.org>",
  },
  // NO AUTH keyword at all: the transport must refuse client-side before
  // any envelope command (upstream's verbatim errors.New); if an AUTH
  // attempt ever arrives the stub rejects it too.
  "no-auth-offered": {
    ehloKeywords: ["SIZE 10485760"],
  },
  // 8BITMIME + SMTPUTF8 advertised → MAIL FROM must carry both params.
  eightbit: {
    ehloKeywords: ["8BITMIME", "SMTPUTF8"],
    expectMailFrom: "MAIL FROM:<noreply@example.com>",
    expectMailFromParams: " BODY=8BITMIME SMTPUTF8",
    expectRcptTo: "RCPT TO:<alice@example.org>",
  },
  // ENVELOPE_FROM override: the envelope sender must be the override
  // address, not the header From.
  "envelope-from": {
    ehloKeywords: [],
    expectMailFrom: "MAIL FROM:<envelope@example.com>",
    expectRcptTo: "RCPT TO:<alice@example.org>",
  },
  // AUTH LOGIN whose first challenge is neither prompt — the verbatim
  // "unknown fromServer" refusal (smtp_auth.go). LOGIN-only EHLO so the
  // ladder reaches the challenge (PLAIN would win upstream's pick).
  "login-unknown-prompt": {
    ehloKeywords: ["AUTH LOGIN"],
    authLoginLadder: true,
    authLoginChallenge: "GuessWho:",
  },
  // AUTH CRAM-MD5 only: the client must refuse client-side (the recorded
  // platform divergence — WebCrypto has no MD5; never silently skip auth).
  "cram-only": {
    ehloKeywords: ["AUTH CRAM-MD5"],
  },
  // AUTH PLAIN answered 535 — the auth-failure class (permanent).
  "auth-fail": {
    ehloKeywords: ["AUTH PLAIN LOGIN"],
    expectedAuthPlainToken: "__mismatch__",
  },
  // Reply-code taxonomy arms.
  "mail-transient": { ehloKeywords: [], mailReply: "451 4.7.1 try again later" },
  "rcpt-permanent": { ehloKeywords: [], rcptReply: "550 5.1.1 no such user" },
  "data-transient": { ehloKeywords: [], dataTerminatorReply: "451 4.3.0 queue full" },
  "greeting-transient": { greeting: "421 4.3.2 too many connections" },
  "greeting-permanent": { greeting: "554 5.7.1 no service here" },
};

interface Session {
  spec: SmtpStubSpec;
  socket: net.Socket;
  buffer: string;
  /** 0 = idle; 1 = awaiting the b64 username; 2 = awaiting the b64 password. */
  loginStage: 0 | 1 | 2;
  /** Collecting DATA lines (between 354 and the dot terminator). */
  collecting: boolean;
  collected: string[];
}

function ehloReply(spec: SmtpStubSpec): string {
  if (spec.ehloFixedReply !== undefined) return spec.ehloFixedReply;
  const keywords = spec.ehloKeywords ?? ["SIZE 10485760", "AUTH PLAIN LOGIN"];
  // RFC 5321 §4.2: every non-final line of a multiline reply carries the
  // dash form — a "250 " line would END the reply.
  const lines = keywords.map((k, i) => (i === keywords.length - 1 ? `250 ${k}` : `250-${k}`));
  return lines.length > 0 ? ["250-stub", ...lines].join("\r\n") : "250 stub";
}

/** The command table — every non-DATA, non-LOGIN-payload line lands here. */
function reply(session: Session, line: string): string {
  const { spec } = session;
  if (line.startsWith("EHLO")) return ehloReply(spec);
  if (line.startsWith("HELO")) return spec.heloReply ?? "250 stub";
  if (line === "STARTTLS") return "502 not supported";
  if (line.startsWith("AUTH PLAIN")) {
    if (spec.expectedAuthPlainToken === undefined) return "502 auth not offered";
    const token = line.slice("AUTH PLAIN ".length).trim();
    return token === spec.expectedAuthPlainToken ? "235 ok" : "535 5.7.8 bad credentials";
  }
  if (line.startsWith("AUTH LOGIN")) {
    if (spec.authLoginLadder !== true) return "502 auth not offered";
    return `334 ${Buffer.from(spec.authLoginChallenge ?? "Username:").toString("base64")}`;
  }
  if (line.startsWith("MAIL FROM:")) {
    if (spec.mailReply !== undefined) return spec.mailReply;
    const wanted = `${spec.expectMailFrom ?? "MAIL FROM:<noreply@example.com>"}${spec.expectMailFromParams ?? ""}`;
    return line === wanted ? "250 ok" : `501 wanted ${wanted} got ${Buffer.from(line).toString("base64")}`;
  }
  if (line.startsWith("RCPT TO:")) {
    if (spec.rcptReply !== undefined) return spec.rcptReply;
    const wanted = spec.expectRcptTo ?? "RCPT TO:<alice@example.org>";
    return line === wanted ? "250 ok" : `501 wanted ${wanted} got ${Buffer.from(line).toString("base64")}`;
  }
  if (line === "DATA") {
    session.collecting = true;
    session.collected = [];
    return "354 end with <CRLF>.<CRLF>";
  }
  if (line === "QUIT") return "221 bye";
  return "250 ok";
}

function write(session: Session, text: string): void {
  session.socket.write(`${text}\r\n`);
}

function finishData(session: Session): void {
  session.collecting = false;
  const unstuffed = session.collected
    .map((l) => (l.startsWith("..") ? l.slice(1) : l))
    .join("\r\n");
  const verdict = session.spec.bodyCheck?.(unstuffed) ?? null;
  write(
    session,
    verdict === null
      ? (session.spec.dataTerminatorReply ?? "250 queued")
      : `554 body rejected: ${verdict}`,
  );
}

function onData(session: Session, chunk: Buffer): void {
  session.buffer += chunk.toString("utf8");
  for (;;) {
    const nl = session.buffer.indexOf("\r\n");
    if (nl === -1) return;
    const line = session.buffer.slice(0, nl);
    session.buffer = session.buffer.slice(nl + 2);

    if (session.collecting) {
      if (line === ".") finishData(session);
      else session.collected.push(line);
      continue;
    }

    // The AUTH LOGIN payload stages: the client sends b64(user) then
    // b64(password) after the 334s (LoginAuth's Next ladder).
    if (session.loginStage === 1) {
      session.loginStage = 2;
      write(session, `334 ${Buffer.from("Password:").toString("base64")}`);
      continue;
    }
    if (session.loginStage === 2) {
      session.loginStage = 0;
      write(session, "235 ok");
      continue;
    }

    const answer = reply(session, line);
    write(session, answer);
    if (line === "QUIT") return;
    // The AUTH LOGIN ladder continues: the next payload line is the b64
    // username (the unknown-challenge pin dies client-side before this).
    if (answer.startsWith("334") && session.spec.authLoginLadder === true) {
      session.loginStage = 1;
    }
  }
}

function serve(spec: SmtpStubSpec): net.Server {
  return net.createServer((raw) => {
    const session: Session = {
      spec,
      socket: raw,
      buffer: "",
      loginStage: 0,
      collecting: false,
      collected: [],
    };
    raw.on("data", (c: Buffer) => onData(session, c));
    write(session, spec.greeting ?? "220 stub ESMTP");
  });
}

export default async function ({ provide }: { provide: (k: string, v: unknown) => void }): Promise<void> {
  const ports: Record<string, number> = {};
  for (const [name, spec] of Object.entries(SPECS)) {
    const server = serve(spec);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`stub ${name} listen timeout`)), 5000);
      server.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
      server.listen(0, "127.0.0.1", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const address = server.address();
    ports[name] = address !== null && typeof address === "object" ? address.port : 0;
    server.unref();
  }
  provide("mailSmtpStubs", ports);
  // The listeners are all unref'd: they serve the whole vitest invocation
  // and never hold the event loop open (the process exit tears them down).
}
