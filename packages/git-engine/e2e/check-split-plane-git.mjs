/**
 * Real stock `git` black-box verification of the SPEC-0024 split-plane engine
 * against a fresh local `wrangler dev` worker (`workerd` + DO + R2 + D1):
 *   1. Multi-wave direct pushes (initial + thin-delta + annotated tag + 512 KiB binary).
 *   2. Pre-compaction cold clone hitting push-time `.pref`+`.idx` (`worker-cold-stream`) + `git fsck --full --strict`.
 *   3. Forced Queue compaction (`POST /compact`) certifying `cleanReachable` + `.bundle` emission.
 *   4. Post-compaction `worker-passthrough` clone (`transfer.bundleURI=false`) + `git fsck --full --strict`.
 *   5. Post-compaction Protocol v2 `bundle-uri` clone (`transfer.bundleURI=true`) + `git fsck --full --strict`.
 *   6. Fast-forward wave-4 push + incremental `git fetch` + merge + `git fsck --full --strict`.
 *   7. Force-push replacing tip + orphan anti-leakage + invalidated `bundle-uri` + `git fsck --full --strict`.
 *
 * Run: `node packages/git-engine/e2e/check-split-plane-git.mjs`
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WORKER_DIR = path.join(ROOT, "apps", "worker");
const TOKEN = "m45-e2e-git-token-0123456789";
const BUNDLE_SECRET = "m45-e2e-bundle-signing-secret-0123456789";

function git(args, { cwd, env = {}, allowFail = false } = {}) {
  const res = spawnSync("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!allowFail && res.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (status=${res.status}):\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    );
  }
  return res;
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitForHealth(baseUrl, child, logs) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`wrangler dev exited early with code ${child.exitCode}:\n${logs.join("")}`);
    }
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.status === 200) return;
    } catch {
      // still starting
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`wrangler dev did not become healthy within 60s:\n${logs.join("")}`);
}

async function probeUploadPlaneHeader(repoUrl, wantOids) {
  const enc = new TextEncoder();
  const pkt = (s) => {
    const body = enc.encode(s);
    const hdr = enc.encode((body.length + 4).toString(16).padStart(4, "0"));
    return Buffer.concat([hdr, body]);
  };
  const body = Buffer.concat([
    pkt("command=fetch\n"),
    pkt("agent=git/2.43.0\n"),
    Buffer.from("0001"),
    pkt("thin-pack\n"),
    pkt("ofs-delta\n"),
    ...wantOids.map((oid) => pkt(`want ${oid}\n`)),
    pkt("done\n"),
    Buffer.from("0000"),
  ]);
  const res = await fetch(`${repoUrl}/git-upload-pack`, {
    method: "POST",
    headers: {
      "content-type": "application/x-git-upload-pack-request",
      "git-protocol": "version=2",
    },
    body,
  });
  await res.arrayBuffer();
  return { status: res.status, plane: res.headers.get("x-upload-plane"), contentType: res.headers.get("content-type") };
}

async function main() {
  const gitVer = git(["--version"]).stdout.trim();
  console.log(`== Stock git check (${gitVer}) ==`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cf-gitea-m45-e2e-"));
  const stateDir = path.join(tmp, "wrangler-state");
  const envFile = path.join(tmp, "e2e.dev.vars");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    envFile,
    [
      `GIT_TOKEN=${TOKEN}`,
      `BUNDLE_SIGNING_SECRET=${BUNDLE_SECRET}`,
      "BUNDLE_URI_ENABLED=true",
      "BUNDLE_MIN_BYTES=1",
      "WORKER_COLD_CLONE_MIN_BYTES=0",
      "RECEIVE_DIRECT_PACK_WRITE=true",
      "UPLOAD_PACK_WORKER_STREAM=true",
      "COMPACTION_QUEUE_ENABLED=true",
      "MAIL_PROVIDER_API_KEY=dummy",
      "MAIL_SMTP_PASSWORD=dummy",
      "MAIL_INBOUND_SECRET=dummy",
      "MIRROR_ALLOWED_HOST_LIST=github.com",
      "MIRROR_CREDENTIAL_KEY=0123456789abcdef0123456789abcdef",
    ].join("\n") + "\n",
  );

  let child = null;
  const logs = [];
  try {
    console.log("== Applying local D1 migrations to disposable state ==");
    execFileSync(
      "pnpm",
      ["exec", "wrangler", "d1", "migrations", "apply", "cf-gitea", "--config", "wrangler.jsonc", "--local", "--persist-to", stateDir],
      {
        cwd: WORKER_DIR,
        env: { ...process.env, CI: "1" },
        stdio: "pipe",
        maxBuffer: 32 * 1024 * 1024,
      },
    );

    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const repoName = `m45-${crypto.randomUUID().slice(0, 8)}`;
    const repoHttp = `${baseUrl}/demo/${repoName}.git`;
    const authRepoHttp = `http://x:${TOKEN}@127.0.0.1:${port}/demo/${repoName}.git`;
    const compactUrl = `${baseUrl}/demo/${repoName}/compact`;
    const basicAuth = `Basic ${Buffer.from(`x:${TOKEN}`).toString("base64")}`;

    child = spawn(
      "pnpm",
      [
        "exec",
        "wrangler",
        "dev",
        "--config",
        "wrangler.jsonc",
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--inspector-port",
        "0",
        "--persist-to",
        stateDir,
        "--show-interactive-dev-session",
        "false",
        "--env-file",
        envFile,
        "--var",
        `GIT_TOKEN:${TOKEN}`,
        "--var",
        `BUNDLE_SIGNING_SECRET:${BUNDLE_SECRET}`,
        "--var",
        "BUNDLE_URI_ENABLED:true",
        "--var",
        "BUNDLE_MIN_BYTES:1",
        "--var",
        "WORKER_COLD_CLONE_MIN_BYTES:0",
        "--var",
        "RECEIVE_DIRECT_PACK_WRITE:true",
        "--var",
        "UPLOAD_PACK_WORKER_STREAM:true",
        "--var",
        "COMPACTION_QUEUE_ENABLED:true",
      ],
      {
        cwd: WORKER_DIR,
        env: { ...process.env, CI: "1" },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const pushLog = (d) => {
      logs.push(d.toString());
      if (logs.length > 200) logs.shift();
    };
    child.stdout.on("data", pushLog);
    child.stderr.on("data", pushLog);

    await waitForHealth(baseUrl, child, logs);
    console.log(`== Local worker healthy on ${baseUrl} ==`);

    // 1. Multi-wave direct pushes (initial + thin-delta + annotated tag + 512 KiB binary).
    const srcDir = path.join(tmp, "src");
    fs.mkdirSync(srcDir);
    git(["init", "-q", "-b", "main"], { cwd: srcDir });
    git(["config", "user.email", "e2e@example.com"], { cwd: srcDir });
    git(["config", "user.name", "M45 E2E"], { cwd: srcDir });

    const binaryBuf = crypto.randomBytes(512 * 1024);
    fs.writeFileSync(path.join(srcDir, "README.md"), "# split-plane e2e\nline 1\nline 2\nline 3\n");
    fs.writeFileSync(path.join(srcDir, "asset.bin"), binaryBuf);
    git(["add", "-A"], { cwd: srcDir });
    git(["commit", "-qm", "wave 1: init + binary"], { cwd: srcDir });
    git(["push", "-q", authRepoHttp, "main"], { cwd: srcDir });

    fs.appendFileSync(path.join(srcDir, "README.md"), "line 4 from wave 2\n");
    fs.writeFileSync(path.join(srcDir, "notes.txt"), "wave 2 notes\n");
    git(["add", "-A"], { cwd: srcDir });
    git(["commit", "-qm", "wave 2: thin delta"], { cwd: srcDir });
    git(["push", "-q", authRepoHttp, "main"], { cwd: srcDir });

    fs.appendFileSync(path.join(srcDir, "notes.txt"), "wave 3 tag commit\n");
    git(["add", "-A"], { cwd: srcDir });
    git(["commit", "-qm", "wave 3: tagged commit"], { cwd: srcDir });
    git(["tag", "-a", "v1.0", "-m", "release v1.0"], { cwd: srcDir });
    git(["push", "-q", authRepoHttp, "main", "refs/tags/v1.0"], { cwd: srcDir });

    const tip3 = git(["rev-parse", "HEAD"], { cwd: srcDir }).stdout.trim();
    const tree3 = git(["rev-parse", "HEAD^{tree}"], { cwd: srcDir }).stdout.trim();
    const tag3 = git(["rev-parse", "refs/tags/v1.0"], { cwd: srcDir }).stdout.trim();
    console.log("  ok: 1. multi-wave direct pushes + thin delta + annotated tag");

    // 2. Pre-compaction cold clone -> hits worker-cold-stream using push-time .pref+.idx.
    const coldProbe = await probeUploadPlaneHeader(repoHttp, [tip3, tag3]);
    assert.equal(coldProbe.status, 200, `coldProbe status=${coldProbe.status} logs:\n${logs.join("")}`);
    assert.equal(
      coldProbe.plane,
      "worker-cold-stream",
      `coldProbe=${JSON.stringify(coldProbe)} workerLogs:\n${logs.join("")}`,
    );

    const coldDir = path.join(tmp, "clone-cold");
    git(["clone", "-q", repoHttp, coldDir], { cwd: tmp });
    git(["fsck", "--full", "--strict"], { cwd: coldDir });
    assert.equal(git(["rev-list", "--count", "HEAD"], { cwd: coldDir }).stdout.trim(), "3");
    assert.equal(git(["rev-parse", "HEAD^{tree}"], { cwd: coldDir }).stdout.trim(), tree3);
    assert.equal(git(["rev-parse", "refs/tags/v1.0"], { cwd: coldDir }).stdout.trim(), tag3);
    assert.equal(Buffer.compare(fs.readFileSync(path.join(coldDir, "asset.bin")), binaryBuf), 0);
    console.log(`  ok: 2. pre-compaction cold clone (plane=${coldProbe.plane}) + fsck strict exit 0`);

    // 3. Forced Queue compaction -> cleanReachable certified + .bundle materialized.
    const compactRes = await fetch(compactUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: basicAuth },
      body: JSON.stringify({ force: true }),
    });
    assert.equal(compactRes.status, 200, `compact status ${compactRes.status}`);
    const compactJson = await compactRes.json();
    assert.equal(compactJson.tag, "compacted", `unexpected compact result: ${JSON.stringify(compactJson)}`);
    assert.equal(compactJson.cleanReachable, true);
    assert.ok(compactJson.outputPrefBytes > 0);
    assert.ok(compactJson.bundle && compactJson.bundle.bytes > 0);
    console.log(`  ok: 3. forced compaction certified cleanReachable & bundle (${compactJson.bundle.bytes} B)`);

    // 4. Post-compaction clone with transfer.bundleURI=false -> worker-passthrough + fsck strict.
    const passProbe = await probeUploadPlaneHeader(repoHttp, [tip3, tag3]);
    assert.equal(passProbe.status, 200);
    assert.equal(passProbe.plane, "worker-passthrough");

    const passDir = path.join(tmp, "clone-pass");
    git(["-c", "transfer.bundleURI=false", "clone", "-q", repoHttp, passDir], { cwd: tmp });
    git(["fsck", "--full", "--strict"], { cwd: passDir });
    assert.equal(git(["rev-list", "--count", "HEAD"], { cwd: passDir }).stdout.trim(), "3");
    assert.equal(git(["rev-parse", "HEAD^{tree}"], { cwd: passDir }).stdout.trim(), tree3);
    console.log(`  ok: 4. post-compaction clone (transfer.bundleURI=false, plane=${passProbe.plane}) + fsck strict exit 0`);

    // 5. Post-compaction clone with protocol.version=2 + transfer.bundleURI=true -> bundle-uri fetch + fsck strict.
    const bundleDir = path.join(tmp, "clone-bundle");
    const traceBundle = git(
      ["-c", "protocol.version=2", "-c", "transfer.bundleURI=true", "clone", repoHttp, bundleDir],
      { cwd: tmp, env: { GIT_TRACE_PACKET: "1" } },
    );
    const traceOut = `${traceBundle.stdout}\n${traceBundle.stderr}`;
    assert.match(traceOut, /command=bundle-uri/);
    assert.match(traceOut, /\/bundle\//);
    git(["fsck", "--full", "--strict"], { cwd: bundleDir });
    assert.equal(git(["rev-list", "--count", "HEAD"], { cwd: bundleDir }).stdout.trim(), "3");
    assert.equal(git(["rev-parse", "HEAD^{tree}"], { cwd: bundleDir }).stdout.trim(), tree3);
    assert.equal(Buffer.compare(fs.readFileSync(path.join(bundleDir, "asset.bin")), binaryBuf), 0);
    console.log("  ok: 5. protocol v2 bundle-uri clone (transfer.bundleURI=true) + fsck strict exit 0");

    // 6. Fast-forward wave 4 push + incremental fetch on existing clones.
    fs.appendFileSync(path.join(srcDir, "README.md"), "wave 4 incremental update\n");
    git(["add", "-A"], { cwd: srcDir });
    git(["commit", "-qm", "wave 4: ff update"], { cwd: srcDir });
    git(["push", "-q", authRepoHttp, "main"], { cwd: srcDir });
    const orphanOid = git(["rev-parse", "HEAD"], { cwd: srcDir }).stdout.trim();

    git(["fetch", "-q", "origin"], { cwd: bundleDir });
    git(["merge", "-q", "--ff-only", "origin/main"], { cwd: bundleDir });
    git(["fsck", "--full", "--strict"], { cwd: bundleDir });
    assert.equal(git(["rev-list", "--count", "HEAD"], { cwd: bundleDir }).stdout.trim(), "4");
    console.log("  ok: 6. incremental fetch + fast-forward + fsck strict exit 0");

    // 7. Force-push replacement -> orphan excluded + stale bundle-uri cleared + fsck strict.
    fs.writeFileSync(path.join(srcDir, "README.md"), "# split-plane e2e\nrewritten after force-push\n");
    git(["add", "-A"], { cwd: srcDir });
    git(["commit", "--amend", "-qm", "wave 4: force-pushed clean tip"], { cwd: srcDir });
    git(["push", "-q", "--force", authRepoHttp, "main"], { cwd: srcDir });
    const cleanTip4 = git(["rev-parse", "HEAD"], { cwd: srcDir }).stdout.trim();

    const postForceDir = path.join(tmp, "clone-post-force");
    const tracePostForce = git(
      ["-c", "protocol.version=2", "-c", "transfer.bundleURI=true", "clone", repoHttp, postForceDir],
      { cwd: tmp, env: { GIT_TRACE_PACKET: "1" } },
    );
    assert.doesNotMatch(`${tracePostForce.stdout}\n${tracePostForce.stderr}`, /\/bundle\//);
    git(["fsck", "--full", "--strict"], { cwd: postForceDir });
    assert.equal(git(["rev-parse", "HEAD"], { cwd: postForceDir }).stdout.trim(), cleanTip4);
    const orphanProbe = git(["cat-file", "-e", orphanOid], { cwd: postForceDir, allowFail: true });
    assert.notEqual(orphanProbe.status, 0, "force-push orphan commit must not exist in fresh clone");
    console.log("  ok: 7. force-push orphan exclusion + stale bundle invalidation + fsck strict exit 0");

    // 8. Shallow clone (--depth=1 -> --depth=3 -> --unshallow, plus fail-closed --deepen) + fsck strict.
    const shallowDir = path.join(tmp, "clone-shallow");
    git(["clone", "-q", "--depth", "1", repoHttp, shallowDir], { cwd: tmp });
    assert.equal(git(["rev-list", "--count", "HEAD"], { cwd: shallowDir }).stdout.trim(), "1");
    assert.equal(fs.existsSync(path.join(shallowDir, ".git", "shallow")), true);
    const deepenUnsupported = git(["fetch", "-q", "--deepen", "2"], { cwd: shallowDir, allowFail: true });
    assert.notEqual(deepenUnsupported.status, 0);
    assert.match(deepenUnsupported.stderr, /deepen-relative/);
    git(["fetch", "-q", "--depth", "3"], { cwd: shallowDir });
    assert.equal(git(["rev-list", "--count", "HEAD"], { cwd: shallowDir }).stdout.trim(), "3");
    git(["fetch", "-q", "--unshallow"], { cwd: shallowDir });
    assert.equal(git(["rev-list", "--count", "HEAD"], { cwd: shallowDir }).stdout.trim(), "4");
    git(["fsck", "--full", "--strict"], { cwd: shallowDir });
    console.log("  ok: 8. shallow (--depth=1 -> --depth=3 -> --unshallow + fail-closed --deepen) + fsck strict exit 0");

    // 9. Partial clone (--filter=blob:none --no-checkout -> promisor lazy checkout) + fsck strict.
    const partialDir = path.join(tmp, "clone-partial");
    git(
      ["-c", "protocol.version=2", "clone", "-q", "--filter=blob:none", "--no-checkout", repoHttp, partialDir],
      { cwd: tmp },
    );
    assert.equal(git(["config", "--get", "remote.origin.promisor"], { cwd: partialDir }).stdout.trim(), "true");
    assert.equal(
      git(["config", "--get", "remote.origin.partialclonefilter"], { cwd: partialDir }).stdout.trim(),
      "blob:none",
    );
    git(["checkout", "-q", "HEAD"], { cwd: partialDir });
    git(["fsck", "--full", "--strict"], { cwd: partialDir });
    assert.equal(Buffer.compare(fs.readFileSync(path.join(partialDir, "asset.bin")), binaryBuf), 0);
    console.log("  ok: 9. partial clone (--filter=blob:none + lazy checkout) + fsck strict exit 0");

    console.log("ALL 9 REAL STOCK GIT SPLIT-PLANE E2E CASES PASSED.");
  } finally {
    if (child && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // already exited
      }
      await new Promise((r) => setTimeout(r, 500));
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // already exited
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

await main();
