#!/usr/bin/env node
/**
 * gen-bench-fixtures.mjs — deterministic benchmark fixture generator.
 * SPEC-0001 §9 / milestone M5 prep (fixtures: 5 MiB / 42 MiB / 500 MiB packs).
 *
 * SYNOPSIS
 *   node scripts/gen-bench-fixtures.mjs [--sizes 5m,42m,500m] [--out .bench-fixtures] [--seed 42]
 *
 * For each requested size it synthesizes a git repository shaped like a real one —
 * many small text files (source-like / log-like / doc-like personalities mixing
 * compressible and incompressible content), a commit history that edits those files
 * incrementally so `git repack` builds real delta chains, and periodic 64-256 KiB
 * binary-ish blobs — then repacks until the single packfile lands within ±10% of the
 * target. Output per size:
 *
 *   <out>/<size>/repo.git        bare repo: refs/heads/main, exactly one pack + idx v2
 *   <out>/<size>/manifest.json   {target, actual_pack_bytes, pack_sha1, commits, files,
 *                                 seed, generated_at}
 *
 * Every pack is validated with `git index-pack --verify` (plus an explicit idx-v2
 * magic check, per SPEC-0001 §5 "idx v2") before the manifest is written; a failure
 * aborts with a non-zero exit code.
 *
 * DETERMINISM
 *   Content is a pure function of (--seed, commit index, file index) through a seeded
 *   mulberry32 PRNG; author/committer identities and timestamps are fixed constants;
 *   no Date.now()/Math.random() anywhere in content paths (Date appears only in the
 *   manifest's generated_at field). Git runs single-threaded with fixed window/depth/
 *   compression/index settings and an isolated config (system + global config ignored).
 *   Same seed on the same machine (same git + zlib build) therefore yields a
 *   byte-identical pack and pack sha1. Cross-machine byte equality is NOT guaranteed
 *   (delta selection and zlib encodings can differ between git/zlib builds) — treat
 *   pack_sha1 as per-environment; the target size and object shape stay stable.
 *
 * RUNTIME / DISK EXPECTATIONS (measured 2026-10-24: git 2.43, zlib 1.3, NVMe SSD;
 * scale with single-core speed and disk write throughput)
 *   5m   ~1 s,    peak disk ~2x final pack
 *   42m  ~6 s,    peak disk ~2-3x final pack
 *   500m ~2.5 min, peak disk ~2.5x final pack (~1.2 GiB): between rounds the
 *        fast-import packs and the previous repack coexist before repack -adf
 *        folds them into one pack.
 *   The 500 MiB case never buffers a whole pack in memory: content is streamed into
 *   `git fast-import` over stdin with per-chunk backpressure, and the target size is
 *   approached in measured rounds (stream -> repack -> measure -> top-up) instead of
 *   one giant guess, so the write amplification is bounded by the repack, not by
 *   staging a second full copy.
 *
 * DEFAULT: with no flags only the 5 MiB smoke fixture is generated; the full set is
 * opt-in via --sizes. Requires system git >= 2.22 (fast-import, repack -adf,
 * index-pack --verify); git >= 2.32 additionally gets global-config isolation via
 * GIT_CONFIG_GLOBAL.
 */
import { spawn } from "node:child_process";
import console from "node:console";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Fixed constants (never wall-clock derived) so pack bytes depend only on seed + git.
const BASE_EPOCH = 1767225600; // 2026-01-01T00:00:00Z; commit i gets BASE_EPOCH + i*60
const AUTHOR_NAME = "Bench Fixture";
const AUTHOR_EMAIL = "bench-fixture@example.invalid";
const AVG_BLOB_BYTES = 160 * 1024; // mean of the 64-256 KiB binary blobs
const ASSET_MIN_BYTES = 64 * 1024;
const ASSET_MAX_BYTES = 256 * 1024;
const AVG_LINE_BYTES = 56; // rough byte size of one generated text line
const MAX_COMMITS = 20000; // hard safety cap across all rounds of one fixture
const MAX_ROUNDS = 8; // top-up rounds per attempt
const MAX_ATTEMPTS = 3; // full rebuilds allowed after a >+10% overshoot

// ---------- deterministic PRNG (xmur3 seed hashing + mulberry32) ----------

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fresh PRNG for one named decision; independent streams never interfere. */
const rngFor = (seed, ...parts) => mulberry32(xmur3(`${seed}:${parts.join(":")}`)());

/** n pseudo-random bytes, little-endian uint32 fill (byte-exact across platforms). */
function randomBytesLE(rng, n) {
  const buf = Buffer.allocUnsafe(n);
  let o = 0;
  while (o + 4 <= n) {
    const v = (rng() * 4294967296) >>> 0;
    buf[o] = v & 255;
    buf[o + 1] = (v >>> 8) & 255;
    buf[o + 2] = (v >>> 16) & 255;
    buf[o + 3] = (v >>> 24) & 255;
    o += 4;
  }
  if (o < n) {
    let v = (rng() * 4294967296) >>> 0;
    while (o < n) {
      buf[o] = v & 255;
      v >>>= 8;
      o++;
    }
  }
  return buf;
}

function hexRun(rng, width) {
  let s = "";
  for (let i = 0; i < width; i += 2) s += ((rng() * 256) | 0).toString(16).padStart(2, "0");
  return s;
}

// ---------- synthetic content ----------

/**
 * One text file. Its byte content is the running join of `lines`; every update only
 * appends, so consecutive blob versions delta-chain almost perfectly during repack
 * (the pack stores roughly one copy of the appended bytes per version).
 * Personality mix: "src"/"log" blend compressible + incompressible lines inside the
 * same file; "doc" is highly compressible filler.
 */
function makeFileState(seed, idx, fileCount, dirCount) {
  const rng = rngFor(seed, "file", idx);
  const roll = rng();
  const personality = roll < 0.5 ? "src" : roll < 0.8 ? "log" : "doc";
  const dir = idx % dirCount;
  const ext = ["ts", "txt", "md"][idx % 3];
  return {
    idx,
    personality,
    initLines: 30 + Math.floor(rng() * 50),
    createdAt: 1 + (idx % 25), // tree fills up over the first 25 commits
    path: `src/mod${String(dir).padStart(3, "0")}/file${String(idx).padStart(4, "0")}.${ext}`,
    lines: [],
    rng,
  };
}

function genLine(f, tick) {
  const r = f.rng();
  if (f.personality === "src") {
    if (r < 0.3) return `    // 0x${hexRun(f.rng, 32)}`;
    return `    this.values[${tick % 64}] = compute(${tick % 64}, ${(tick * 7) % 97});`;
  }
  if (f.personality === "log") {
    if (r < 0.2) return `INFO tick=${tick} status=ok rows=${tick % 997} latency_ms=${tick % 300}`;
    return hexRun(f.rng, 56);
  }
  if (r < 0.15) return `    ref 0x${hexRun(f.rng, 16)}`;
  return `Paragraph ${tick % 32} line ${tick}: the benchmark fixture generator emits deterministic filler prose for compression testing.`;
}

function fileInit(f) {
  f.lines = [
    `# synthetic bench file ${f.idx} (personality: ${f.personality})`,
    "# generated by scripts/gen-bench-fixtures.mjs - deterministic, do not edit",
    "",
  ];
  for (let i = 0; i < f.initLines; i++) f.lines.push(genLine(f, i));
}

function fileContent(f) {
  return Buffer.from(f.lines.length ? f.lines.join("\n") + "\n" : "", "utf8");
}

/** Sequential per-commit content generator. Round boundaries never change the output:
 *  commit i is always fed the same edits for the same seed. */
class FixtureGenerator {
  constructor(seed, targetBytes, plan, budgetScale) {
    this.seed = seed;
    this.budgetPerCommit = plan.budgetPerCommit * budgetScale;
    this.files = Array.from({ length: plan.files }, (_, i) =>
      makeFileState(seed, i, plan.files, plan.dirCount),
    );
    const budget = this.budgetPerCommit;
    this.linesPerCommit = Math.min(400, Math.max(8, Math.round((budget * 0.25) / AVG_LINE_BYTES)));
    this.blobChance = Math.min(0.6, Math.max(0.02, (budget * 0.75) / AVG_BLOB_BYTES));
  }

  /** Stream pieces for commit i (1-based step): message + [{path, buf}, ...]. */
  commitParts(i) {
    const step = i + 1;
    const rng = rngFor(this.seed, "commit", i);
    for (const f of this.files) {
      if (f.createdAt === step) fileInit(f);
    }
    const live = this.files.filter((f) => f.createdAt <= step);
    const k = Math.min(live.length, 3 + Math.floor(rng() * 4));
    const chosen = new Set();
    while (chosen.size < k) chosen.add(Math.floor(rng() * live.length));

    const parts = [];
    const perFile = Math.max(4, Math.round(this.linesPerCommit / k));
    for (const idx of chosen) {
      const f = live[idx];
      const start = f.lines.length;
      const n = perFile + Math.floor(rng() * 8) - 4;
      for (let j = 0; j < n; j++) f.lines.push(genLine(f, start + j));
      parts.push({ path: f.path, buf: fileContent(f) });
    }
    const hasAsset = rng() < this.blobChance;
    if (hasAsset) {
      const size = ASSET_MIN_BYTES + Math.floor(rng() * (ASSET_MAX_BYTES - ASSET_MIN_BYTES));
      parts.push({
        path: `assets/asset-${String(step).padStart(6, "0")}.bin`,
        buf: randomBytesLE(rng, size),
      });
    }
    const msg =
      `step ${step}: update ${chosen.size} file(s)${hasAsset ? ", add binary asset" : ""}\n` +
      `\nseed=${this.seed} step=${step}\n`;
    return { parts, msg };
  }
}

// ---------- git plumbing ----------

let gitVersion = null; // { major, minor } parsed once in main()

function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || k === "LC_ALL" || k === "LANG") continue;
    env[k] = v;
  }
  env.GIT_CONFIG_NOSYSTEM = "1"; // since git 1.6.x
  env.LC_ALL = "C";
  env.LANG = "C";
  // Global-config isolation needs git >= 2.32; harmless to skip on older ones.
  if (gitVersion && (gitVersion.major > 2 || (gitVersion.major === 2 && gitVersion.minor >= 32))) {
    env.GIT_CONFIG_GLOBAL = os.devNull;
  }
  return env;
}

function runGit(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: opts.cwd,
      env: opts.env ?? gitEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-8000);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function gitOrDie(args, opts = {}, what = null) {
  const r = await runGit(args, opts);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${r.code})${what ? `: ${what}` : ""}\n${r.stderr.trim()}`);
  }
  return r;
}

/** repack settings: the determinism contract. Single-threaded delta search, fixed
 *  window/depth, explicit zlib 6, idx v2, no bitmap/reverse-index sidecars. */
const REPACK_CONFIG = [
  ["pack.threads", "1"],
  ["pack.window", "10"],
  ["pack.depth", "50"],
  ["pack.compression", "6"],
  ["core.compression", "6"],
  ["pack.indexVersion", "2"],
  ["repack.writeBitmaps", "false"],
  ["pack.writeReverseIndex", "false"],
];

async function initBareRepo(repoDir) {
  await fsp.mkdir(repoDir, { recursive: true });
  await gitOrDie(["-C", repoDir, "init", "--bare", "--quiet"], {}, "init fixture repo");
  await gitOrDie(["-C", repoDir, "symbolic-ref", "HEAD", "refs/heads/main"], {}, "point HEAD at main");
}

/** Streams `count` commits (indices [from, from+count)) into `git fast-import`.
 *  Round 1 creates the branch; later rounds continue from the on-disk tip via an
 *  explicit `from <sha>` (fast-import resolves `from refs/heads/main` against its
 *  in-progress value and would otherwise create a second root). Content is written
 *  chunk-by-chunk with write-callback backpressure: memory stays O(one commit). */
async function streamCommits(gitDir, gen, from, count) {
  const args = ["-C", gitDir, "-c", "pack.compression=1", "-c", "core.compression=1", "fast-import", "--date-format=raw", "--quiet"];
  const child = spawn("git", args, { env: gitEnv(), stdio: ["pipe", "ignore", "pipe"] });
  let errTail = "";
  child.stderr.on("data", (d) => (errTail = (errTail + d).slice(-8000)));
  let pipeError = null;
  // EPIPE (fast-import died) arrives as a stream 'error' event; capture it so the
  // process doesn't crash before `exited` can report fast-import's stderr.
  child.stdin.on("error", (err) => (pipeError = err));
  const exited = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && !pipeError) resolve();
      else reject(new Error(`git fast-import failed (exit ${code})\n${errTail.trim() || pipeError}`));
    });
  });
  const stdin = child.stdin;
  const write = (chunk) =>
    new Promise((resolve, reject) =>
      stdin.write(chunk, (err) => (err ? reject(err) : resolve())),
    );

  let tip = null;
  if (from > 0) {
    tip = (await gitOrDie(["-C", gitDir, "rev-parse", "refs/heads/main"], {}, "resolve branch tip")).stdout.trim();
  }

  try {
    for (let i = from; i < from + count; i++) {
      const { parts, msg } = gen.commitParts(i);
      const when = BASE_EPOCH + i * 60;
      const ident = `${AUTHOR_NAME} <${AUTHOR_EMAIL}>`;
      let head = "commit refs/heads/main\n";
      head += `author ${ident} ${when} +0000\n`;
      head += `committer ${ident} ${when} +0000\n`;
      head += `data ${Buffer.byteLength(msg, "utf8")}\n${msg}\n`;
      if (tip !== null) head += `from ${tip}\n`;
      await write(head);
      for (const part of parts) {
        await write(`M 100644 inline ${part.path}\ndata ${part.buf.length}\n`);
        await write(part.buf);
        await write("\n");
      }
      tip = null; // only the first commit of a round needs `from`
    }
    stdin.end();
  } catch (err) {
    // The write failure is usually EPIPE because fast-import rejected the stream;
    // let it exit so its stderr (the real diagnosis) replaces the bare EPIPE.
    stdin.destroy();
    const cause = await exited.catch((e) => e);
    throw cause instanceof Error && errTail.trim() ? cause : err;
  }
  await exited;
}

/** Single deterministic pack for the current object set; returns its path + size. */
async function repackAndMeasure(repoDir) {
  const args = ["-C", repoDir];
  for (const [k, v] of REPACK_CONFIG) args.push("-c", `${k}=${v}`);
  args.push("repack", "-adf", "--quiet"); // -f: recompute deltas from scratch (no reuse)
  await gitOrDie(args, {}, "repack fixture");
  const packDir = path.join(repoDir, "objects", "pack");
  const packs = (await fsp.readdir(packDir)).filter((f) => f.endsWith(".pack"));
  if (packs.length !== 1) {
    throw new Error(`expected exactly one pack after repack, found ${packs.length}: ${packs.join(", ")}`);
  }
  const packPath = path.join(packDir, packs[0]);
  return { path: packPath, bytes: (await fsp.stat(packPath)).size };
}

/** SHA-1 of the pack's content excluding the 20-byte trailer — the value git names
 *  the pack after (the trailer itself is this checksum, verbatim). */
async function packChecksumSha1(packPath, sizeBytes) {
  const hash = createHash("sha1");
  const bodyLen = sizeBytes - 20;
  let seen = 0;
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(packPath);
    s.on("data", (d) => {
      if (seen >= bodyLen) return;
      const take = Math.min(d.length, bodyLen - seen);
      hash.update(take === d.length ? d : d.subarray(0, take));
      seen += take;
    });
    s.on("end", resolve);
    s.on("error", reject);
  });
  return hash.digest("hex");
}

async function assertIdxV2(idxPath) {
  const fh = await fsp.open(idxPath, "r");
  try {
    const { buffer } = await fh.read(Buffer.alloc(8), 0, 8, 0);
    const magicOk = buffer[0] === 0xff && buffer.toString("ascii", 1, 4) === "tOc";
    if (!magicOk || buffer.readUInt32BE(4) !== 2) {
      throw new Error(`${path.basename(idxPath)} is not an idx v2 file (SPEC-0001 §5 requires v2)`);
    }
  } finally {
    await fh.close();
  }
}

// ---------- fixture build loop ----------

function makePlan(targetBytes) {
  const mib = targetBytes / 2 ** 20;
  const commits = Math.min(2000, Math.max(200, Math.round(mib * 4)));
  const files = Math.min(768, Math.max(128, Math.round(mib * 16)));
  return {
    commits,
    files,
    dirCount: Math.max(4, Math.round(files / 16)),
    budgetPerCommit: targetBytes / commits,
  };
}

const fmtMiB = (b) => `${(b / 2 ** 20).toFixed(2)} MiB`;

async function buildFixture({ target, label, seed, outDir }) {
  const sizeDir = path.join(outDir, label);
  const repoDir = path.join(sizeDir, "repo.git");
  await fsp.mkdir(sizeDir, { recursive: true });
  await fsp.rm(repoDir, { recursive: true, force: true });

  const plan = makePlan(target);
  const t0 = performance.now();
  console.error(
    `[${label}] target ${fmtMiB(target)} - plan: ${plan.commits} commits, ${plan.files} files, seed ${seed}`,
  );

  let budgetScale = 1;
  let measured = null;
  let commits;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      await fsp.rm(repoDir, { recursive: true, force: true });
      console.error(`[${label}] attempt ${attempt}: rebuilt with per-commit budget x ${budgetScale.toFixed(3)}`);
    }
    await initBareRepo(repoDir);
    const gen = new FixtureGenerator(seed, target, plan, budgetScale);
    commits = 0;

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const rt0 = performance.now();
      const isFirst = round === 1;
      const remaining = Math.max(0, plan.commits - commits);
      let count = isFirst ? plan.commits : 0;
      if (!isFirst || remaining === 0) {
        // top-up round: extrapolate from the measured bytes-per-commit rate
        const rate = measured.bytes / commits;
        const want = Math.max(1, Math.round((target * 0.99 - measured.bytes) / rate));
        count = Math.min(want, Math.max(200, Math.round(plan.commits / 2)));
      }
      if (commits + count > MAX_COMMITS) count = MAX_COMMITS - commits;
      if (count <= 0) break;
      await streamCommits(repoDir, gen, commits, count);
      commits += count;
      measured = await repackAndMeasure(repoDir);
      const dt = ((performance.now() - rt0) / 1000).toFixed(1);
      const pct = ((measured.bytes / target) * 100).toFixed(1);
      console.error(
        `[${label}] round ${round}.${attempt}: streamed ${count} commits (${dt}s) -> repack -> ${fmtMiB(measured.bytes)} (${pct}% of target)`,
      );
      if (measured.bytes >= target * 0.9) break;
    }

    if (measured.bytes <= target * 1.1) break;
    const landed = measured.bytes;
    budgetScale *= target / landed; // landed heavy: shrink per-commit volume
    measured = null;
    if (attempt === MAX_ATTEMPTS) {
      throw new Error(
        `[${label}] failed to land within ±10% of ${fmtMiB(target)} after ${MAX_ATTEMPTS} attempts (last: ${fmtMiB(landed)})`,
      );
    }
  }

  if (measured.bytes < target * 0.9) {
    throw new Error(
      `[${label}] stalled below target after ${MAX_ROUNDS} rounds (${fmtMiB(measured.bytes)} of ${fmtMiB(target)})`,
    );
  }

  // ---- verification gate: nothing downstream sees an unverified pack ----
  const vt0 = performance.now();
  const packPath = measured.path;
  const idxPath = packPath.replace(/\.pack$/, ".idx");
  const vr = await runGit(["index-pack", "--verify", packPath], { cwd: sizeDir });
  if (vr.code !== 0) {
    throw new Error(`[${label}] git index-pack --verify FAILED (exit ${vr.code}):\n${vr.stderr.trim()}`);
  }
  await assertIdxV2(idxPath);

  const packSha1 = await packChecksumSha1(packPath, measured.bytes);
  const expectedName = `pack-${packSha1}.pack`;
  if (path.basename(packPath) !== expectedName) {
    throw new Error(`[${label}] pack name ${path.basename(packPath)} does not match its sha1 (${expectedName})`);
  }
  const commitCount = Number(
    (await gitOrDie(["-C", repoDir, "rev-list", "--count", "refs/heads/main"], {}, "count commits")).stdout.trim(),
  );
  const lsTree = await gitOrDie(["-C", repoDir, "ls-tree", "-r", "--name-only", "-z", "refs/heads/main"], {}, "list files");
  const fileCount = lsTree.stdout.split("\0").filter(Boolean).length;
  const verifyMs = Math.round(performance.now() - vt0);

  const manifest = {
    target,
    actual_pack_bytes: measured.bytes,
    pack_sha1: packSha1,
    commits: commitCount,
    files: fileCount,
    seed,
    generated_at: new Date().toISOString(), // metadata only — never part of content paths
  };
  await fsp.writeFile(path.join(sizeDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const totalS = ((performance.now() - t0) / 1000).toFixed(1);
  console.error(`[${label}] index-pack --verify ok (${verifyMs} ms), idx v2 confirmed`);
  console.error(`[${label}] done in ${totalS}s -> ${path.relative(process.cwd(), repoDir)}`);

  return { label, manifest, repoDir };
}

// ---------- CLI ----------

const USAGE = `usage: node scripts/gen-bench-fixtures.mjs [--sizes 5m,42m,500m] [--out .bench-fixtures] [--seed 42]

Generates deterministic benchmark fixture repositories (SPEC-0001 §9).
Sizes: <n>k | <n>m | <n>g (e.g. 5m = 5 MiB). Default: 5m only (fast smoke);
pass --sizes 5m,42m,500m for the full set. See the header comment for
runtime expectations (500m is a multi-minute job) and determinism notes.`;

function parseSize(token) {
  const m = /^(\d+)([kmg])$/i.exec(token.trim());
  if (!m) throw new Error(`bad size "${token}" - expected forms like 5m, 42m, 500m, 1g`);
  const mult = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()];
  return { label: token.trim().toLowerCase(), bytes: Number(m[1]) * mult };
}

function parseArgs(argv) {
  const opts = { sizes: ["5m"], out: ".bench-fixtures", seed: 42 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    if (a === "--sizes") opts.sizes = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--out") opts.out = next();
    else if (a === "--seed") opts.seed = Number(next());
    else if (a === "-h" || a === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(opts.seed) || opts.seed < 0) throw new Error(`--seed must be a non-negative integer`);
  opts.targets = opts.sizes.map(parseSize);
  if (opts.targets.length === 0) throw new Error("--sizes resolved to nothing");
  // relative --out resolves against the repo root, not the caller's cwd
  opts.outDir = path.isAbsolute(opts.out) ? opts.out : path.join(repoRoot, opts.out);
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const v = await runGit(["--version"]);
  if (v.code !== 0) throw new Error("git not found on PATH - this generator shells out to system git");
  const mv = /git version (\d+)\.(\d+)/.exec(v.stdout);
  gitVersion = mv ? { major: Number(mv[1]), minor: Number(mv[2]) } : null;
  if (gitVersion && (gitVersion.major < 2 || (gitVersion.major === 2 && gitVersion.minor < 22))) {
    throw new Error(`git >= 2.22 required, found ${v.stdout.trim()}`);
  }
  console.error(`git ${mv ? `${mv[1]}.${mv[2]}` : "?.?"} - fixtures -> ${path.relative(process.cwd(), opts.outDir)}`);

  await fsp.mkdir(opts.outDir, { recursive: true });
  const results = [];
  for (const t of opts.targets) {
    results.push(await buildFixture({ target: t.bytes, label: t.label, seed: opts.seed, outDir: opts.outDir }));
  }

  console.log(`generated ${results.length} fixture(s):`);
  for (const { label, manifest, repoDir } of results) {
    console.log(
      `  ${label.padEnd(5)} pack ${fmtMiB(manifest.actual_pack_bytes).padStart(10)}  commits ${String(manifest.commits).padStart(5)}  files ${String(manifest.files).padStart(4)}  sha1 ${manifest.pack_sha1.slice(0, 12)}...  -> ${path.relative(process.cwd(), repoDir)}`,
    );
  }
}

main().catch((err) => {
  console.error(`[fatal] ${err.message}`);
  process.exit(1);
});
