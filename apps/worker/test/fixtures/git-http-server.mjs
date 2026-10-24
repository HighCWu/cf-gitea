#!/usr/bin/env node
/**
 * CI-only git smart-HTTP SOURCE fixture (SPEC-0009 §5.1) — a real upload-pack
 * endpoint driven by real git, for the mirror e2e suite (scripts/mirror-e2e.sh).
 * Plain Node, zero dependencies beyond the `git` binary: every git operation
 * shells `git upload-pack --stateless-rpc [--advertise-refs]` against a bare
 * repository, exactly like git's own http-backend does.
 *
 * Why a fixture: a pull mirror's source must be a REAL smart-HTTP endpoint
 * (real advertisement bytes, real negotiation, real sideband framing) that the
 * Worker's outbound client can fetch. Unit tests use committed golden bytes;
 * `file://` is never a client scheme (SPEC-0009 §1) — so the black-box layer
 * serves the real protocol over loopback HTTP(S) instead.
 *
 * Wire shape (git http-backend parity, verified against `git ls-remote`):
 *   GET  <path>/info/refs?service=git-upload-pack
 *        → `# service=git-upload-pack` pkt + flush + `--advertise-refs` output,
 *          content-type `application/x-git-upload-pack-advertisement`.
 *        NOTE the service preamble precedes the v2 capability advert too —
 *          the shape every real forge serves (and what the mirror client must
 *          therefore parse).
 *   POST <path>/git-upload-pack
 *        → `git upload-pack --stateless-rpc` over the request body,
 *          content-type `application/x-git-upload-pack-result`.
 *   Everything else (receive-pack, upload-archive, dumb-HTTP listing) is
 *   refused: the fixture is a pull SOURCE — mirrors never write to it.
 *
 * Protocol selection mirrors http-backend: the client's `Git-Protocol` header
 * is forwarded as the `GIT_PROTOCOL` env of the child git (v2 when it says
 * `version=2`, v0 otherwise). Paths under `--v0-prefix` (default `/v0`) never
 * get GIT_PROTOCOL, so they serve a v0-only endpoint — the suite's exercise of
 * the client's v0 fallback (SPEC-0009 §2.5).
 *
 * TLS: pass --cert/--key (PEM) to serve https. The suite generates a throwaway
 * CA + leaf and starts the dev Worker with `SSL_CERT_FILE=<ca.pem>` — workerd
 * honors SSL_CERT_FILE/SSL_CERT_DIR for its outbound trust store (rustls
 * native-certs), so the mirror sync can fetch the self-hosted fixture. Without
 * --cert/--key the server is plain http (local protocol interop checks only —
 * the egress gate rejects http sources, so the suite always uses TLS).
 *
 * Auth: --user/--password (both or neither) require `Authorization: Basic
 * base64(user:password)` on every git endpoint (401 + the standard challenge
 * otherwise) — exercising the §4.2 credential envelope end-to-end: the suite
 * registers the mirror with auth_username/auth_password and every sync must
 * decrypt + send them.
 *
 * Usage:
 *   node git-http-server.mjs --repo /path/bare.git [--port 8443] [--host 127.0.0.1]
 *        [--cert cert.pem --key key.pem] [--user u --password p] [--v0-prefix /v0]
 *
 * Prints one ready line on stdout when listening:
 *   MIRROR-E2E-SRC-READY pid=<pid> url=<scheme>://<host>:<port>
 * Everything else logs to stderr (`[git-http-server]` prefix), so the suite
 * can parse stdout for readiness alone.
 *
 * E2E-scale by design: request bodies are buffered in memory (bounded below),
 * one git child per request. Not a production server.
 */

import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
// Imported explicitly (the repo's plain-node convention — bootstrap-admin.mjs):
// the root eslint config has no node globals.
import console from "node:console";
import process from "node:process";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import { setTimeout } from "node:timers";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function argOf(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const REPO = argOf("--repo");
const HOST = argOf("--host") ?? "127.0.0.1";
const PORT = Number(argOf("--port") ?? 8443);
const CERT = argOf("--cert");
const KEY = argOf("--key");
const AUTH_USER = argOf("--user");
const AUTH_PASSWORD = argOf("--password");
const V0_PREFIX = argOf("--v0-prefix") ?? "/v0";

const MAX_BODY_BYTES = 256 * 1024 * 1024; // e2e-scale bound (see module doc)

if (!REPO) {
  console.error("[git-http-server] --repo <path-to-bare.git> is required");
  process.exit(2);
}
if ((CERT === undefined) !== (KEY === undefined)) {
  console.error("[git-http-server] --cert and --key must be given together");
  process.exit(2);
}
if ((AUTH_USER === undefined) !== (AUTH_PASSWORD === undefined)) {
  console.error("[git-http-server] --user and --password must be given together");
  process.exit(2);
}

const log = (...parts) => console.error("[git-http-server]", ...parts);

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

/** Run one `git upload-pack` round against the fixture repo. `protocol` is the
 *  raw Git-Protocol header value (or null for the v0-only prefix / absent). */
function runUploadPack(extraArgs, body, protocol) {
  const env = { ...process.env };
  if (protocol !== null) env.GIT_PROTOCOL = protocol;
  const res = spawnSync("git", ["upload-pack", ...extraArgs, REPO], {
    input: body,
    env,
    maxBuffer: MAX_BODY_BYTES,
  });
  if (res.error !== undefined) throw res.error;
  if (res.status !== 0) {
    throw new Error(`git upload-pack exited ${res.status}: ${res.stderr.toString("utf8").slice(0, 500)}`);
  }
  return res.stdout;
}

/** The `# service=` preamble git http-backend writes before the advertisement
 *  (BOTH protocol versions — this is the real wire shape). */
const SERVICE_PREAMBLE = Buffer.from("001e# service=git-upload-pack\n0000", "ascii");

const CT_ADVERTISEMENT = "application/x-git-upload-pack-advertisement";
const CT_RESULT = "application/x-git-upload-pack-result";

// ---------------------------------------------------------------------------
// request handling
// ---------------------------------------------------------------------------

/** Timing-safe Basic auth check; null when the request carries none. */
function basicAuthUser(req) {
  const header = req.headers.authorization ?? "";
  const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header);
  if (m === null) return null;
  const expected = Buffer.from(`${AUTH_USER}:${AUTH_PASSWORD}`, "utf8");
  let got;
  try {
    got = Buffer.from(m[1], "base64");
  } catch {
    return "";
  }
  return got.length === expected.length && timingSafeEqual(got, expected) ? AUTH_USER : "";
}

/** Read the full request body (bounded; the fixture buffers by design). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("request body exceeds the fixture cap"), { code: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** The protocol header to forward, honoring the v0-only prefix. */
function protocolFor(pathname, req) {
  if (V0_PREFIX !== "" && (pathname === V0_PREFIX || pathname.startsWith(`${V0_PREFIX}/`))) return null;
  const header = req.headers["git-protocol"];
  return typeof header === "string" && header.trim() !== "" ? header.trim() : null;
}

const handler = async (req, res) => {
  const url = new URL(req.url, "http://localhost"); // host is irrelevant; paths decide
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (AUTH_USER !== undefined && basicAuthUser(req) === null) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="git-http-server"' });
      res.end("authentication required\n");
      return;
    }

    if (req.headers["content-encoding"] !== undefined && req.headers["content-encoding"] !== "identity") {
      // The Worker client never compresses; refuse anything else honestly.
      res.writeHead(415, { "content-type": "text/plain; charset=utf-8" });
      res.end("the fixture does not decompress request bodies\n");
      return;
    }

    if (req.method === "GET" && pathname.endsWith("/info/refs")) {
      if (url.searchParams.get("service") !== "git-upload-pack") {
        // Receive-pack/dumb-HTTP listing: this fixture is a pull SOURCE only.
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("only git-upload-pack is served (pull source)\n");
        return;
      }
      const protocol = protocolFor(pathname, req);
      const advert = runUploadPack(["--stateless-rpc", "--advertise-refs"], Buffer.alloc(0), protocol);
      res.writeHead(200, { "content-type": CT_ADVERTISEMENT, "cache-control": "no-cache" });
      res.end(Buffer.concat([SERVICE_PREAMBLE, advert]));
      return;
    }

    if (req.method === "POST" && pathname.endsWith("/git-upload-pack")) {
      if (req.headers.expect !== undefined && req.headers.expect.toLowerCase().includes("100-continue")) {
        res.writeContinue();
      }
      const body = await readBody(req);
      const protocol = protocolFor(pathname, req);
      const out = runUploadPack(["--stateless-rpc"], body, protocol);
      res.writeHead(200, { "content-type": CT_RESULT, "cache-control": "no-cache" });
      res.end(out);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not a git endpoint\n");
  } catch (error) {
    const status = typeof error === "object" && error !== null && error.code === 413 ? 413 : 500;
    log(`${req.method} ${pathname} failed:`, error instanceof Error ? error.message : String(error));
    if (!res.headersSent) res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    res.end("fixture error\n");
  }
};

const server =
  CERT !== undefined && KEY !== undefined
    ? https.createServer({ cert: readFileSync(CERT), key: readFileSync(KEY) }, handler)
    : http.createServer(handler);

server.on("clientError", (error, socket) => {
  log("client error:", error.message);
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

server.listen(PORT, HOST, () => {
  const { address, port } = server.address();
  const scheme = CERT !== undefined && KEY !== undefined ? "https" : "http";
  // The one stdout line — the suite waits for exactly this.
  console.log(`MIRROR-E2E-SRC-READY pid=${process.pid} url=${scheme}://${address}:${port}`);
  log(`serving ${REPO} on ${scheme}://${address}:${port} (v0 prefix: ${V0_PREFIX}, auth: ${AUTH_USER !== undefined ? "on" : "off"})`);
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    log(`received ${signal}, closing`);
    server.close(() => process.exit(0));
    // A hung keep-alive socket must not outlive the suite's cleanup.
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
