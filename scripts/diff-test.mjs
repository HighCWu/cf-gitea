#!/usr/bin/env node
/**
 * diff-test.mjs — differential test harness: the SAME repo, the SAME real git
 * CLI commands, against "ours" (cf-gitea) and optionally "theirs" (any Gitea /
 * git smart-HTTP server); diffs between stored reports must be explainable by
 * the declared compatibility rules (docs/design/m3-design-inputs.md Round-8,
 * "cheap differential testing").
 *
 *   node scripts/diff-test.mjs --ours http://127.0.0.1:5173 --token <PAT> [options]
 *
 * Options:
 *   --ours <base-url>        ours endpoint: local dev (pnpm dev) or production
 *                            worker (required)
 *   --token <PAT>            git Basic password for ours (dev: the GIT_TOKEN
 *                            secret value from apps/worker/.dev.vars)
 *   --theirs <base-url>      OPTIONAL second endpoint: a real Gitea instance
 *                            (or any git smart-HTTP server) to run the same
 *                            battery against; when absent the run is an
 *                            ours-only baseline snapshot for future --compare
 *   --theirs-token <PAT>     token for theirs (default: --token)
 *   --user <name>            owner namespace for created repos, both ends
 *                            (default "diff-bot"; on ours any name works via
 *                            create-by-push, on theirs it should be the
 *                            token's user unless the token is admin)
 *   --ours-user / --theirs-user <name>   per-endpoint owner override
 *   --label <label>          report label for ours (default "ours")
 *   --only <id,id,...>       run a subset of cases (see --list)
 *   --skip <id,id,...>       exclude cases
 *   --list                   print the case battery and exit
 *   --timeout-ms <n>         per git-command timeout (default 180000)
 *   --keep                   keep per-case temp dirs (debugging)
 *   --json                   stdout carries ONLY the final JSON report(s);
 *                            progress goes to stderr
 *   --compare <a.json> <b.json>   no git runs: diff two stored reports field
 *                            by field, annotating each divergence with the
 *                            declared rule that explains it (see
 *                            scripts/diff-cases/rules.mjs)
 *   --help
 *
 * Run mode: the battery (scripts/diff-cases/) seeds deterministic repos
 * (fixed content, identities and dates — identical oids on every endpoint),
 * runs real git CLI cases, and records per case: git exit status, stderr
 * tail, refs listing (local + ls-remote), .git/shallow content, and the
 * rev-list --objects --all count. Created repos are deleted from the endpoint
 * afterwards (engine DELETE on ours — the scripts/deploy-smoke.mjs pattern;
 * Gitea API DELETE on theirs, engine DELETE as fallback) — best effort, with
 * outcomes recorded. Repos carry unique per-run slugs
 * (difftest-<hex>-<case>), so a crashed run never collides with a rerun;
 * a crashed run's leftovers must be deleted by hand (each report lists its
 * repos under `created_repos`).
 *
 * Output: scripts/diff-report-<label>-<timestamp>.json per endpoint (the
 * gitignore pattern scripts/diff-report-*.json covers these) + a human
 * summary table. With --theirs, the two reports are additionally compared
 * inline (written as scripts/diff-report-compare-<timestamp>.json).
 *
 * Exit code (run mode): 0 iff every case outcome is in {ok, clean-reject,
 * shallow-ok}; "silent-full-clone" / "fail" / "timeout" / "setup-fail" exit 1.
 * Exit code (compare mode): 0 iff no UNEXPLAINED divergence and no violation.
 */
/* global fetch, AbortSignal, setTimeout -- Web/platform globals provided by Node >= 22
 * (Buffer and URL are imported from node: modules like deploy-smoke does) */
import { execFile } from "node:child_process";
import console from "node:console";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import { CASES } from "./diff-cases/index.mjs";
import { SEEDS, SEED_IDENTITY, SHALLOW_SINCE_CUTOFF } from "./diff-cases/seed.mjs";
import { COMPARE_RULES, evaluateShallowAcceptance, rulesForCase } from "./diff-cases/rules.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_DIR = path.join(repoRoot, "scripts");
const DEFAULT_USER = "diff-bot";
const OUTCOMES_OK = new Set(["ok", "clean-reject", "shallow-ok"]);

// ---------- CLI ----------

const usage = () =>
  "usage: node scripts/diff-test.mjs --ours <base-url> --token <PAT>\n" +
  "                [--theirs <base-url>] [--theirs-token <PAT>] [--user <name>]\n" +
  "                [--ours-user <n>] [--theirs-user <n>] [--label <label>]\n" +
  "                [--only <ids>] [--skip <ids>] [--list] [--timeout-ms <n>]\n" +
  "                [--keep] [--json] [--compare <a.json> <b.json>]";

const parseArgs = (argv) => {
  const o = {
    ours: null, token: null, theirs: null, theirsToken: null,
    user: DEFAULT_USER, oursUser: null, theirsUser: null, label: null,
    only: null, skip: null, list: false, timeoutMs: 180_000, keep: false,
    json: false, compare: null, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help") o.help = true;
    else if (a === "--list") o.list = true;
    else if (a === "--keep") o.keep = true;
    else if (a === "--json") o.json = true;
    else if (a === "--ours") o.ours = argv[++i];
    else if (a === "--token") o.token = argv[++i];
    else if (a === "--theirs") o.theirs = argv[++i];
    else if (a === "--theirs-token") o.theirsToken = argv[++i];
    else if (a === "--user") o.user = argv[++i];
    else if (a === "--ours-user") o.oursUser = argv[++i];
    else if (a === "--theirs-user") o.theirsUser = argv[++i];
    else if (a === "--label") o.label = argv[++i];
    else if (a === "--only") o.only = argv[++i];
    else if (a === "--skip") o.skip = argv[++i];
    else if (a === "--timeout-ms") o.timeoutMs = Number(argv[++i]);
    else if (a === "--compare") o.compare = [argv[++i], argv[++i]];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (o.help || o.list) return o;
  if (o.compare) {
    if (o.compare.some((p) => !p)) throw new Error("--compare needs two report files");
    return o;
  }
  if (!o.ours) throw new Error("--ours is required");
  if (!o.token) throw new Error("--token is required (git Basic password for ours)");
  if (!/^https?:\/\//.test(o.ours)) throw new Error(`--ours must be an http(s) URL: ${o.ours}`);
  if (o.theirs && !/^https?:\/\//.test(o.theirs)) throw new Error(`--theirs must be an http(s) URL: ${o.theirs}`);
  if (!Number.isFinite(o.timeoutMs) || o.timeoutMs <= 0) throw new Error("--timeout-ms must be a positive number");
  o.ours = o.ours.replace(/\/+$/, "");
  if (o.theirs) o.theirs = o.theirs.replace(/\/+$/, "");
  return o;
};

const opts = parseArgs(process.argv.slice(2));
const log = (...a) => (opts.json ? console.error(...a) : console.log(...a));
if (opts.help) {
  console.log(usage());
  process.exit(0);
}
if (opts.list) {
  console.log("Case battery (scripts/diff-cases/):");
  for (const c of CASES) console.log(`  ${c.id.padEnd(20)} ${c.title}`);
  process.exit(0);
}

const hexId = (n = 6) => randomUUID().replaceAll("-", "").slice(0, n);
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
const tail = (s, n = 400) => String(s ?? "").trim().slice(-n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const splitList = (s) => new Set(String(s ?? "").split(",").map((x) => x.trim()).filter(Boolean));
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** execFile as a promise; never throws — callers decide what failure means. */
const run = (cmd, args, { cwd, timeoutMs = 90_000, env } = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (typeof err.code === "number" ? err.code : null) : 0,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        killed: Boolean(err?.killed),
      });
    });
  });

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" };
const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

// ---------- endpoints ----------

/** Build the per-endpoint context: URLs, auth, preflight. */
async function prepareEndpoint(kind, { baseUrl, token, user }) {
  const u = new URL(baseUrl);
  const authPrefix = `${u.protocol}//x:${encodeURIComponent(token)}@${u.host}`;
  const ep = {
    kind,
    label: kind,
    base: baseUrl,
    token,
    user,
    authPrefix,
    authUrl: (owner, slug) => `${authPrefix}/${owner}/${slug}.git`,
    anonUrl: (owner, slug) => `${baseUrl}/${owner}/${slug}.git`,
    env: {},
    createdRepos: [],
    cleanup: [],
  };
  if (kind === "ours") {
    const res = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(15_000) }).catch((e) => ({ error: e }));
    if (res.error) throw new Error(`ours endpoint unreachable (${baseUrl}): ${res.error.message}`);
    const body = await res.text();
    let ok;
    try { ok = res.status === 200 && JSON.parse(body).ok === true; } catch { ok = false; }
    if (!ok) throw new Error(`ours /healthz did not answer {"ok":true} (status ${res.status}): ${body.slice(0, 120)}`);
    ep.env.healthz = "ok";
  } else {
    // Informational only: a real Gitea answers /api/v1/version; a generic
    // smart-HTTP server may not — never fatal (an unreachable theirs aborts
    // in the caller via a bare reachability probe).
    const probe = await fetch(`${baseUrl}`, { signal: AbortSignal.timeout(15_000) }).catch((e) => ({ error: e }));
    if (probe.error) throw new Error(`theirs endpoint unreachable (${baseUrl}): ${probe.error.message}`);
    const res = await fetch(`${baseUrl}/api/v1/version`, {
      headers: { Authorization: basic(user, token) },
      signal: AbortSignal.timeout(15_000),
    }).catch((e) => ({ error: e }));
    ep.env.gitea_api_version = res.error
      ? `no Gitea API: ${res.error.message}`
      : `status ${res.status}: ${(await res.text()).slice(0, 160)}`;
  }
  return ep;
}

/**
 * Gitea API repo-creation fallback for `theirs` endpoints with push-create
 * disabled. Tries the admin route first, then the token's own namespace
 * (whose owner may differ from the requested one — the caller adopts the
 * returned full_name). Returns { ok, createdVia, owner?, repo?, note }.
 */
async function giteaApiCreateRepo(ep, owner, slug) {
  const body = JSON.stringify({ name: slug, private: false, auto_init: false });
  const post = (url) => fetch(url, {
    method: "POST",
    headers: { Authorization: basic(ep.user, ep.token), "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(20_000),
  }).catch((e) => ({ error: e }));
  const describe = async (res) => (res.error ? `fetch failed: ${res.error.message}`
    : `status ${res.status} ${(await res.text()).slice(0, 120)}`);

  let res = await post(`${ep.base}/api/v1/admin/users/${encodeURIComponent(owner)}/repos`);
  if (!res.error && (res.status === 201 || res.status === 409)) return { ok: true, createdVia: "gitea-api-admin" };
  const adminNote = await describe(res);

  res = await post(`${ep.base}/api/v1/user/repos`);
  if (!res.error && res.status === 201) {
    let fullName = null;
    try { fullName = (await res.json()).full_name; } catch { /* keep requested owner */ }
    if (typeof fullName === "string" && fullName.includes("/")) {
      const [realOwner, ...rest] = fullName.split("/");
      return {
        ok: true, createdVia: "gitea-api-user", owner: realOwner, repo: rest.join("/"),
        note: `requested owner ${owner} != token owner; created as ${fullName}`,
      };
    }
    return { ok: true, createdVia: "gitea-api-user" };
  }
  return { ok: false, note: `admin create: ${adminNote}; user create: ${await describe(res)}` };
}

/**
 * Best-effort repo deletion. Ours: the engine's DELETE endpoint (200 +
 * "deleted", the scripts/deploy-smoke.mjs pattern). Theirs: the Gitea API
 * (204), falling back to the engine DELETE (a theirs that happens to be
 * another cf-gitea deployment).
 */
async function deleteRepo(ep, owner, slug) {
  if (ep.kind === "theirs") {
    const res = await fetch(`${ep.base}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`, {
      method: "DELETE",
      headers: { Authorization: basic(ep.user, ep.token) },
      signal: AbortSignal.timeout(20_000),
    }).catch((e) => ({ error: e }));
    if (!res.error && (res.status === 204 || res.status === 200)) {
      return { deleted: true, via: "gitea-api", status: res.status };
    }
    const apiNote = res.error ? `fetch failed: ${res.error.message}` : `status ${res.status}`;
    const eng = await engineDelete(ep, owner, slug);
    return eng.deleted ? { ...eng, note: `gitea-api delete fell back to engine: ${apiNote}` } : { ...eng, note: `gitea-api delete: ${apiNote}; ${eng.note ?? ""}` };
  }
  return engineDelete(ep, owner, slug);
}

async function engineDelete(ep, owner, slug) {
  let lastNote = "unreachable";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${ep.base}/${owner}/${slug}`, {
      method: "DELETE",
      headers: { Authorization: basic("x", ep.token) },
      signal: AbortSignal.timeout(20_000),
    }).catch((e) => ({ error: e }));
    if (!res.error && res.status === 200 && (await res.text()).trim() === "deleted") {
      return { deleted: true, via: "engine-delete", status: 200 };
    }
    lastNote = res.error ? `fetch failed: ${res.error.message}` : `status ${res.status} ${(await res.text()).slice(0, 80)}`;
    if (!res.error) break; // a definite server answer: do not retry
    await sleep(1500);
  }
  return { deleted: false, via: "engine-delete", status: null, note: lastNote };
}

// ---------- per-case toolbelt ----------

/**
 * The toolbelt handed to seed builders and case run functions. Every git
 * invocation is recorded (normalized args, exit, stderr tail, ms, timeout
 * flag); every probe captures the repository state the P0 evidence pattern
 * cares about: .git/shallow lines, rev-list --objects --all count, commit
 * count. All strings are normalized (token, endpoints, temp paths, slugs)
 * so recorded artifacts carry no secrets and compare cleanly across runs.
 */
function makeTools({ ep, caseDir, tmpRoot, slug, timeoutMs, record }) {
  let owner = ep.user;
  let slugRef = slug;

  const urls = () => ({ anon: ep.anonUrl(owner, slugRef), auth: ep.authUrl(owner, slugRef) });
  let u = urls();

  const normalize = (s) =>
    [ep.authPrefix, ep.base, tmpRoot, owner, slugRef, ep.token]
      .reduce((acc, needle) => needle ? acc.split(needle).join(
        needle === ep.authPrefix || needle === ep.base ? "<base>"
          : needle === tmpRoot ? "<tmp>"
            : needle === owner ? "<owner>" : needle === slugRef ? "<repo>" : "***"
      ) : acc, String(s ?? ""));

  const git = async (args, { cwd = caseDir, env } = {}) => {
    const t0 = performance.now();
    const r = await run("git", ["-c", "credential.helper=", ...args],
      { cwd, timeoutMs, env: { ...GIT_ENV, ...env } });
    record.commands.push({
      args: normalize(args.join(" ")),
      exit: r.code,
      stderr_tail: tail(normalize(r.stderr), 400),
      ms: Math.round(performance.now() - t0),
      timeout: r.killed,
    });
    return { ...r, stderr: normalize(r.stderr) };
  };

  /** Repository-state probe; also becomes the case's canonical final state. */
  const probe = async (cwd, label) => {
    const gitDir = path.join(cwd, ".git");
    const p = { label, shallow: null, object_count: null, commit_count: null };
    if (existsSync(gitDir)) {
      try {
        const shallowPath = path.join(gitDir, "shallow");
        p.shallow = existsSync(shallowPath)
          ? (await readFile(shallowPath, "utf8")).split("\n").map((l) => l.trim()).filter(Boolean)
          : null;
        const objs = await git(["rev-list", "--objects", "--all"], { cwd });
        p.object_count = objs.ok ? objs.stdout.split("\n").filter(Boolean).length : null;
        const cnt = await git(["rev-list", "--count", "--all"], { cwd });
        p.commit_count = cnt.ok ? Number(cnt.stdout.trim()) : null;
      } catch { /* probe fields stay null */ }
    }
    record.probes.push(p);
    record.shallow = p.shallow;
    record.object_count = p.object_count;
    record.commit_count = p.commit_count;
    return p;
  };

  const t = {
    caseDir,
    seedDir: path.join(caseDir, "seed"),
    join: path.join,
    url: u.anon,
    authUrl: u.auth,
    endpointKind: ep.kind,
    constants: { shallowSinceCutoff: SHALLOW_SINCE_CUTOFF, seedIdentity: SEED_IDENTITY },
    record,
    git,
    probe,
    normalize,
    tail,

    setRepo(nextOwner, nextSlug) {
      owner = nextOwner;
      slugRef = nextSlug;
      u = urls();
      t.url = u.anon;
      t.authUrl = u.auth;
      record.repo = `${owner}/${slugRef}`;
    },

    writeFile(dir, rel, content) {
      try {
        mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        writeFileSync(path.join(dir, rel), content);
        return true;
      } catch {
        return false;
      }
    },

    check(name, pass, detail, { soft = false } = {}) {
      record.checks.push({ name, pass: Boolean(pass), soft, detail });
      return Boolean(pass);
    },

    /** Hard check on a git result that is expected to succeed. */
    expectOk(r, name, detail) {
      t.check(name, r.ok, r.ok ? detail : `${detail} — FAILED: ${tail(r.stderr, 200)}`);
      return r.ok;
    },

    note(key, value) {
      record.notes[key] = value;
    },

    parseFetchProgress(stderr) {
      const enumerated = stderr.match(/Enumerating objects:\s*(\d+)/)?.[1] ?? null;
      const serverTotal = stderr.match(/remote: Total (\d+)/)?.[1] ?? null;
      const receiving = [...stderr.matchAll(/Receiving objects:\s*\d+% \((\d+)\/(\d+)\)/g)].at(-1);
      return {
        enumerated: enumerated === null ? null : Number(enumerated),
        serverTotal: serverTotal === null ? null : Number(serverTotal),
        received: receiving ? Number(receiving[2]) : null,
      };
    },

    async remoteRefs() {
      const r = await git(["ls-remote", t.url], { cwd: t.caseDir });
      const refs = {};
      let head = null;
      for (const line of r.stdout.split("\n")) {
        const [oid, name] = line.trim().split(/\s+/, 2);
        if (!oid || !name) continue;
        if (name === "HEAD") head = oid;
        else refs[name] = oid;
      }
      record.refs_remote = refs;
      record.head_ref = head;
      return { refs, head, ok: r.ok };
    },

    async localRefs(cwd) {
      const r = await git(["for-each-ref", "--format=%(objectname) %(refname)"], { cwd });
      const refs = {};
      for (const line of r.stdout.split("\n")) {
        const [oid, name] = line.trim().split(/\s+/, 2);
        if (oid && name) refs[name] = oid;
      }
      return refs;
    },

    get owner() { return owner; },
    get slug() { return slugRef; },
  };
  return t;
}

// ---------- case runner ----------

/**
 * Seed the case repo: build the deterministic worktree locally, push it
 * (create-by-push on ours). On a theirs endpoint whose push-create is
 * disabled, fall back to the Gitea API create and retry once.
 */
async function seedCase(t, ep, record, seedDef) {
  const expectedRefs = [];
  try {
    const built = await seedDef.build(t);
    expectedRefs.push(...built.refs);
    // Cases read the deterministic seed shape through the toolbelt.
    t.seed = {
      expectedRefs,
      expectedCommits: seedDef.expectedCommits,
      expectedObjects: seedDef.expectedObjects,
    };
  } catch (err) {
    record.seed = { ok: false, exit: null, stderr_tail: String(err), created_via: "worktree-build",
      expected_refs: [], expected_commits: seedDef.expectedCommits, expected_objects: seedDef.expectedObjects };
    return false;
  }
  let push = await t.git(["push", "-q", t.authUrl, ...expectedRefs], { cwd: t.seedDir });
  let createdVia = "push-create";
  let apiNote = null;
  if (!push.ok && ep.kind === "theirs") {
    const api = await giteaApiCreateRepo(ep, t.owner ?? ep.user, record.repo.split("/")[1]);
    if (api.ok) {
      createdVia = api.createdVia;
      apiNote = api.note ?? null;
      if (api.owner && (api.owner !== ep.user || api.repo)) {
        t.setRepo(api.owner, api.repo ?? record.repo.split("/")[1]);
      }
      push = await t.git(["push", "-q", t.authUrl, ...expectedRefs], { cwd: t.seedDir });
    } else {
      apiNote = api.note;
    }
  }
  record.seed = {
    ok: push.ok,
    exit: push.code,
    stderr_tail: tail(push.stderr, 300),
    created_via: createdVia,
    ...(apiNote ? { api_note: apiNote } : {}),
    expected_refs: expectedRefs,
    expected_commits: seedDef.expectedCommits,
    expected_objects: seedDef.expectedObjects,
  };
  return push.ok;
}

/** Run one case against one endpoint; returns the assembled record. */
async function runCase(caseDef, ep, tmpRoot, timeoutMs) {
  const slug = `difftest-${hexId()}-${caseDef.id}`;
  const record = {
    id: caseDef.id,
    title: caseDef.title,
    describe: caseDef.describe,
    repo: `${ep.user}/${slug}`,
    seed: null,
    commands: [],
    probes: [],
    checks: [],
    notes: {},
    refs_local: null,
    refs_remote: null,
    head_ref: null,
    shallow: null,
    object_count: null,
    commit_count: null,
    outcome: null,
    ms: 0,
  };
  const t0 = performance.now();
  const caseDir = await mkdtemp(path.join(tmpRoot, `${caseDef.id}-`));
  const t = makeTools({ ep, caseDir, tmpRoot, slug, timeoutMs, record });
  log(`  [case] ${caseDef.id} — ${caseDef.title} (${record.repo})`);

  const seedDef = SEEDS[caseDef.seed];
  const seeded = await seedCase(t, ep, record, seedDef);
  ep.createdRepos.push({ owner: t.owner ?? ep.user, slug: record.repo.split("/")[1] });

  if (seeded) {
    try {
      await caseDef.run(t);
    } catch (err) {
      t.check("case-crashed", false, `case runner threw: ${err instanceof Error ? err.stack : String(err)}`);
    }
  } else {
    record.outcome = "setup-fail";
  }

  // Final collection: local refs from the case's client view, remote refs
  // from the server, canonical probe fields (already set by the last probe).
  const collectCwd = t.collectCwd;
  if (collectCwd && existsSync(path.join(collectCwd, ".git"))) {
    record.refs_local = await t.localRefs(collectCwd);
  }
  if (seeded) await t.remoteRefs();

  // Outcome.
  if (record.outcome === null) {
    if (record.commands.some((c) => c.timeout)) {
      record.outcome = "timeout";
    } else if (caseDef.shallowAcceptance) {
      record.outcome = evaluateShallowAcceptance(record, caseDef.shallowAcceptance);
    } else {
      const hard = record.checks.filter((c) => !c.soft);
      record.outcome = hard.length > 0 && hard.every((c) => c.pass) ? "ok" : "fail";
    }
  }
  record.ms = Math.round(performance.now() - t0);
  log(`    -> ${record.outcome} (${record.ms} ms)` +
    (record.outcome === "silent-full-clone" ? "  *** P0-CLASS VIOLATION: silent full clone ***" : ""));

  if (!opts.keep) await rm(caseDir, { recursive: true, force: true });
  return record;
}

// ---------- reporting ----------

function printRunTable(ep, records) {
  const row = (c, s1, s2) => log(`  ${c.padEnd(22)}${s1.padEnd(20)}${s2}`);
  log(`\n== ${ep.label} @ ${ep.base} (owner ${ep.user}) ==`);
  row("case", "outcome", "exit  shallow  objs  commits  ms");
  for (const r of records) {
    const cloneCmd = r.commands.find((x) => x.args.includes("clone"));
    const exit = cloneCmd ? cloneCmd.exit : (r.commands.at(-1)?.exit ?? "-");
    const shallow = Array.isArray(r.shallow) ? r.shallow.length : "-";
    const note = r.outcome === "clean-reject" ? "   [documented transitional reject — acceptable]"
      : r.outcome === "silent-full-clone" ? "   *** UNACCEPTABLE: P0-class silent full clone ***" : "";
    row(r.id, r.outcome, `${String(exit).padEnd(6)}${String(shallow).padEnd(9)}${String(r.object_count ?? "-").padEnd(6)}${String(r.commit_count ?? "-").padEnd(9)}${r.ms}${note}`);
  }
}

async function runBattery(ep, casesToRun, runSlug, timeoutMs, tmpRoot) {
  const records = [];
  log(`\n== battery against ${ep.label}: ${ep.base} (owner ${ep.user}) ==`);
  for (const caseDef of casesToRun) {
    records.push(await runCase(caseDef, ep, tmpRoot, timeoutMs));
  }

  // Cleanup: delete every created repo (best effort), collect outcomes.
  log(`\n== cleanup on ${ep.label}: ${ep.createdRepos.length} repos ==`);
  for (const { owner, slug } of ep.createdRepos) {
    const res = await deleteRepo(ep, owner, slug);
    ep.cleanup.push({
      repo: `${owner}/${slug}`,
      via: res.via,
      deleted: res.deleted,
      ...(res.status !== null ? { http_status: res.status } : {}),
      ...(res.note ? { note: res.note } : {}),
    });
    log(`  ${res.deleted ? "deleted" : "LEFT BEHIND"} ${owner}/${slug} (${res.via})`);
  }

  const outcomes = {};
  for (const r of records) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  const failed = records.filter((r) => !OUTCOMES_OK.has(r.outcome)).map((r) => `${r.id}=${r.outcome}`);
  const report = {
    tool: "diff-test",
    schema: 1,
    label: ep.label,
    endpoint_kind: ep.kind,
    base_url: ep.base,
    user: ep.user,
    endpoint_env: ep.env,
    git_version: (await run("git", ["--version"])).stdout.trim(),
    run_slug: runSlug,
    started_at: ep.startedAt,
    duration_ms: Date.now() - ep.startedAtTime,
    cases: records,
    created_repos: ep.createdRepos.map((r) => `${r.owner}/${r.slug}`),
    cleanup: ep.cleanup,
    summary: {
      cases: records.length,
      outcomes,
      not_ok: failed,
      cleanup_deleted: ep.cleanup.filter((c) => c.deleted).length,
      cleanup_left_behind: ep.cleanup.filter((c) => !c.deleted).length,
    },
  };
  return report;
}

// ---------- compare mode ----------

const COMPARABLE_FIELDS = (rec) => ({
  "commands.exits": Array.isArray(rec.commands) ? rec.commands.map((c) => c.exit) : null,
  "outcome": rec.outcome ?? null,
  "checks": Object.fromEntries((rec.checks ?? []).map((c) => [c.name, c.pass])),
  "refs_local": rec.refs_local ?? {},
  "refs_remote": rec.refs_remote ?? {},
  "shallow": rec.shallow ?? null,
  "object_count": rec.object_count ?? null,
  "commit_count": rec.commit_count ?? null,
  "head_ref": rec.head_ref ?? null,
});

const shortVal = (v) => {
  const s = JSON.stringify(v) ?? "null";
  return s.length > 48 ? `${s.slice(0, 45)}...` : s;
};

/**
 * Compare two stored reports field by field. Every divergence must be
 * explained by a declared rule (scripts/diff-cases/rules.mjs); enforced
 * rules additionally flag a VIOLATION when a side's own outcome is
 * unacceptable even if the two sides agree.
 */
function compareReports(a, b) {
  const rows = [];
  const violations = [];
  let unexplained = 0;
  const casesA = new Map((a.cases ?? []).map((c) => [c.id, c]));
  const casesB = new Map((b.cases ?? []).map((c) => [c.id, c]));
  const ids = [...new Set([...casesA.keys(), ...casesB.keys()])];

  const sideOk = (rec) => {
    for (const rule of rulesForCase(rec.id)) {
      if (rule.enforced && rule.cases !== "*" && rule.cases.includes(rec.id) && !rule.acceptable(rec)) {
        return rule.id;
      }
    }
    return null;
  };

  for (const id of ids) {
    const ra = casesA.get(id);
    const rb = casesB.get(id);
    if (!ra || !rb) {
      rows.push({ case: id, present: ra ? `only in ${a.label}` : `only in ${b.label}`, fields: [] });
      continue;
    }
    const badA = sideOk(ra);
    const badB = sideOk(rb);
    if (badA) violations.push({ case: id, side: a.label, rule: badA });
    if (badB) violations.push({ case: id, side: b.label, rule: badB });

    const fa = COMPARABLE_FIELDS(ra);
    const fb = COMPARABLE_FIELDS(rb);
    const fields = [];
    for (const field of Object.keys(fa)) {
      if (field === "head_ref") {
        // Never a divergence: covered by the informational
        // head-default-branch-info rule (server configuration, not protocol).
        fields.push({
          field,
          verdict: deepEq(fa[field], fb[field]) ? "match" : "info-diff (head-default-branch-info)",
          a: fa[field],
          b: fb[field],
        });
        continue;
      }
      if (deepEq(fa[field], fb[field])) {
        fields.push({ field, verdict: "match", a: fa[field], b: fb[field] });
        continue;
      }
      const covering = rulesForCase(id).filter((rule) =>
        rule.fields.includes(field) || (field === "commands.exits" && rule.fields.includes("commands.exits")));
      const bothAcceptable = covering.some((rule) =>
        !rule.enforced || (rule.acceptable(ra) && rule.acceptable(rb)));
      if (covering.length > 0 && bothAcceptable) {
        fields.push({
          field, verdict: `explained (${covering.map((r) => r.id).join(", ")})`, a: fa[field], b: fb[field],
        });
      } else {
        fields.push({ field, verdict: "UNEXPLAINED", a: fa[field], b: fb[field] });
        unexplained += 1;
      }
    }
    rows.push({ case: id, present: "both", fields });
  }

  return {
    tool: "diff-test-compare",
    schema: 1,
    a: { label: a.label, base_url: a.base_url, file: a.__file ?? null },
    b: { label: b.label, base_url: b.base_url, file: b.__file ?? null },
    compared_at: new Date().toISOString(),
    rules: COMPARE_RULES.map(({ id: rid, rule, enforced, cases, fields }) => ({ id: rid, rule, enforced, cases, fields })),
    rows,
    violations,
    summary: {
      cases_compared: rows.filter((r) => r.present === "both").length,
      cases_one_sided: rows.filter((r) => r.present !== "both").length,
      unexplained,
      violations: violations.length,
      ok: unexplained === 0 && violations.length === 0,
    },
  };
}

function printCompare(cmp) {
  log(`\n== compare: ${cmp.a.label} (${cmp.a.base_url}) vs ${cmp.b.label} (${cmp.b.base_url}) ==`);
  for (const row of cmp.rows) {
    log(`  ${row.case}  [${row.present}]`);
    for (const f of row.fields) {
      if (f.verdict === "match") {
        log(`    ${f.field.padEnd(16)} match        ${shortVal(f.a)}`);
      } else {
        log(`    ${f.field.padEnd(16)} ${f.verdict}`);
        log(`      ${cmp.a.label}: ${shortVal(f.a)}`);
        log(`      ${cmp.b.label}: ${shortVal(f.b)}`);
      }
    }
  }
  for (const v of cmp.violations) log(`  VIOLATION ${v.case}: ${v.side} — ${v.rule}`);
  const s = cmp.summary;
  log(`  verdict: ${s.cases_compared} cases compared, ${s.unexplained} UNEXPLAINED, ` +
    `${s.violations} violations, ${s.cases_one_sided} one-sided -> ${s.ok ? "OK" : "NOT OK"}`);
}

// ---------- main ----------

const loadReport = async (file) => {
  const parsed = JSON.parse(await readFile(file, "utf8"));
  parsed.__file = path.resolve(file);
  return parsed;
};

const writeReportFile = async (name, data) => {
  const file = path.join(REPORT_DIR, name);
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
};

if (opts.compare) {
  const [fa, fb] = opts.compare;
  const a = await loadReport(fa);
  const b = await loadReport(fb);
  for (const r of [a, b]) {
    if (r.tool !== "diff-test") throw new Error(`${fa}/${fb}: not a diff-test report (tool=${r.tool})`);
  }
  const cmp = compareReports(a, b);
  printCompare(cmp);
  const file = await writeReportFile(`diff-report-compare-${stamp()}.json`, cmp);
  console.log(`\ncompare report: ${file}`);
  process.exitCode = cmp.summary.ok ? 0 : 1;
} else {
  const casesToRun = CASES.filter((c) =>
    (!opts.only || splitList(opts.only).has(c.id)) && (!opts.skip || !splitList(opts.skip).has(c.id)));
  if (casesToRun.length === 0) throw new Error("no cases selected (--only/--skip filter matched nothing)");
  const runSlug = `difftest-${hexId()}`;
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), `cf-gitea-difftest-${hexId()}-`));
  const startedAt = new Date();

  const targets = [];
  const oursEp = await prepareEndpoint("ours", {
    baseUrl: opts.ours, token: opts.token, user: opts.oursUser ?? opts.user,
  });
  oursEp.label = opts.label ?? "ours";
  oursEp.startedAt = startedAt.toISOString();
  oursEp.startedAtTime = startedAt.getTime();
  targets.push(oursEp);
  if (opts.theirs) {
    const theirsEp = await prepareEndpoint("theirs", {
      baseUrl: opts.theirs, token: opts.theirsToken ?? opts.token, user: opts.theirsUser ?? opts.user,
    });
    theirsEp.label = "theirs";
    theirsEp.startedAt = new Date().toISOString();
    theirsEp.startedAtTime = Date.now();
    targets.push(theirsEp);
  }

  log(`cf-gitea differential test — run ${runSlug}`);
  log(`git: ${(await run("git", ["--version"])).stdout.trim()}`);
  log(`cases: ${casesToRun.map((c) => c.id).join(", ")}`);
  log(`temp root: ${tmpRoot}${opts.keep ? " (kept)" : ""}`);

  const files = [];
  const reports = [];
  const failedTargets = [];
  try {
    for (const ep of targets) {
      const report = await runBattery(ep, casesToRun, runSlug, opts.timeoutMs, tmpRoot);
      reports.push(report);
      const file = await writeReportFile(`diff-report-${ep.label}-${stamp()}.json`, report);
      files.push(file);
      printRunTable(ep, report.cases);
      const s = report.summary;
      console.log(`  outcomes: ${Object.entries(s.outcomes).map(([k, v]) => `${k}=${v}`).join(", ")}`);
      console.log(`  cleanup: ${s.cleanup_deleted} deleted, ${s.cleanup_left_behind} left behind`);
      console.log(`  report: ${file}`);
      if (s.not_ok.length > 0) failedTargets.push(`${ep.label}: ${s.not_ok.join(", ")}`);
    }
    if (reports.length === 2) {
      const cmp = compareReports(reports[0], reports[1]);
      printCompare(cmp);
      const cmpFile = await writeReportFile(`diff-report-compare-${stamp()}.json`, cmp);
      files.push(cmpFile);
      console.log(`compare report: ${cmpFile}`);
    }
  } finally {
    if (!opts.keep) await rm(tmpRoot, { recursive: true, force: true });
  }

  if (failedTargets.length > 0) {
    log(`\nNOT OK — ${failedTargets.join(" | ")}`);
    process.exitCode = 1;
  } else {
    log(`\nOK — all ${casesToRun.length * targets.length} case runs acceptable`);
  }
  if (opts.json) {
    for (const r of reports) console.log(JSON.stringify(r, null, 2));
  }
}
