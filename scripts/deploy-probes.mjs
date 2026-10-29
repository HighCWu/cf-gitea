#!/usr/bin/env node
/**
 * deploy-probes.mjs — the REDEPLOY probe battery toolkit (zero npm deps, Node >= 22).
 *
 *   node scripts/deploy-probes.mjs <battery> --base-url <url> --token-file <path> [options]
 *   node scripts/deploy-probes.mjs <battery> --dry-run
 *   node scripts/deploy-probes.mjs --help
 *
 * One committed home for the RECURRING REDEPLOY verification probes, so every
 * redeploy wave runs the same probes with less drift instead of hand-rolling
 * them per deploy. Batteries (all take --base-url + a PAT file, except the
 * D1-only cleanup-audit, which takes neither — REDEPLOY15 friction (a)):
 *
 *   p0             The P0 shallow trio + privacy tail against the user's
 *                  fixture repo (`<user>/p0-shallow` by default) — SELF-
 *                  SEEDING (the RD24 papercut closed): the setup POSTs
 *                  /user/repos {name, private:true, auto_init:true} when the
 *                  fixture is absent (409 = a prior window's standing fixture
 *                  is reused and never deleted; the failure tail sweeps a
 *                  fixture ONLY when this run created it AND the run failed —
 *                  a green run keeps its seed, which becomes the user's
 *                  standing fixture).
 *   registry       The tombstone / registry sweep: create -> immediate
 *                  anonymous advert -> rename -> carry -> delete -> the very
 *                  next anonymous ls-remote must be dead at t+0. A red run
 *                  sweeps the trial repos it created (the failureTail).
 *   generate-e2e   Template -> real push -> PATCH template -> generate -> 201
 *                  + empty:false -> refs carried at the identical tip ->
 *                  contents API round-trip. A red run sweeps the template +
 *                  generated repos it created (the failureTail; REDEPLOY16's
 *                  TLS flake stranded the template for a hand-clean).
 *   forkpr-e2e     Base -> fork (202) -> push a fork branch -> PR with the
 *                  cross-repo head `owner:branch` -> 201 + head chain. A red
 *                  run sweeps the fork + base + org it created (the
 *                  failureTail).
 *   mirror         The push-mirror credential-free arms: the registration-time
 *                  SSRF egress gate refusing a loopback target at the door,
 *                  then the .invalid lifecycle — gate-passing unreachable
 *                  target -> 200 -> sync trigger -> the failed sync's settle
 *                  shape -> DELETE 204. A red run sweeps the mirror rows +
 *                  probe repo it created (the failureTail).
 *   ui-login       The login-cookie methodology probe: anonymous labels page
 *                  hides the writer form, POST /login 303 + gitea_session,
 *                  cookie view renders the owner form. A red run sweeps its
 *                  fixture repo (the failureTail).
 *   window2-mounts The window-2 mount sweep over the user-settings tab family
 *                  (window-2a 0c2b151 — 8 modules / 19 routes; more
 *                  sub-windows land before the deploy): anonymous tab GETs
 *                  303 onto the login round-trip, cookie GETs answer 200
 *                  text/html with each page's pageClass discriminator, then
 *                  the mounted write arms — the secret create/delete
 *                  round-trip (303-target asserts + the invalid-name
 *                  re-render negative + the idempotent delete), the keys
 *                  add-form negative (the exact 422 text, no row), and the
 *                  last-owner leave flash (org create → leave →
 *                  ?error=last-owner). Every tab arm reads the mount state
 *                  AT RUN TIME: a 404 from a not-yet-mounted path is a
 *                  documented [warn], anything mounted asserts hard. A red
 *                  run sweeps the secret (by name, via the user API) + the
 *                  org it created (the failureTail).
 *   window3-mounts The window-3 mount sweep over the ~12 committed-unmounted
 *                  UI surfaces (the RD20 wrap battery): the releases/tags
 *                  feed tails (`releases.rss|.atom`, `tags.rss|.atom` — exact
 *                  writeFeed content-types + channel titles + the
 *                  MustBeNotEmpty empty-repo 404 arm), the wiki raw byte arm
 *                  (`/wiki/raw/*` — a pushed page's coded + .md-tail probes,
 *                  the ETag/304 pair, text/plain, the absent-wiki 404), the
 *                  profile stars/watching/followers/following tabs (the
 *                  mounted ?tab=activity arm rides along), the /-/admin
 *                  users/orgs/repos lists (admin-cookie 200s with the
 *                  pageClass + probe rows, the anonymous login-303 arm), the
 *                  user-settings account/notifications tabs (read-only — the
 *                  POST arms are NOT probed), the milestone list→detail
 *                  round-trip, and the issue content-history list tail (the
 *                  {"results":null} pre-edit empty arm). Like
 *                  window2-mounts, every surface reads the mount state AT RUN
 *                  TIME: a 404 (or, for the profile tabs, a 200 that is
 *                  still the inert repositories view) is the documented
 *                  not-yet-mounted degradation ([warn]); anything mounted
 *                  asserts hard. Fixtures: one public auto_init probe repo
 *                  (the feeds' non-empty gate, the wiki page, the issue, the
 *                  milestone) + one empty public repo (the feeds' 404 arm) —
 *                  both DELETEd on green (the issue/milestone/wiki-page rows
 *                  cascade with the repo), so cleanup-audit needs no new
 *                  residue expectations; a red run sweeps both (the
 *                  failureTail).
 *   fixwave-parity The RD23 fix wave's LIVE parity matrix — one probe family
 *                  per landed behavior (each self-cleans; see the battery
 *                  section below for the per-family shapes): the PR head-sync
 *                  (a push moves refs/pull/N/head) chained into the merged-PR
 *                  412 and the strict ghost-ref 404 over one repo, the
 *                  tag-only push-create survival, the org-team revoke's
 *                  masked-404 git cut, the private user's anonymous-404 /
 *                  admin-200 ladder, the sudo pair (admin impersonation +
 *                  non-admin 403), and the session rotation's full cookie
 *                  directive (the D1-write backdate arm — the toolkit's first
 *                  D1 WRITE path, d1Exec). `independent` on purpose: every
 *                  family reports its own verdict (a red family never
 *                  chain-skips the rest of the matrix — pre-RD23 all eight
 *                  families legitimately red; the post-deploy run is the
 *                  verdict). A red run sweeps its repos + org + member user +
 *                  session row (the failureTail).
 *   branch-protection The SPEC-0013 protection flows over one scratch repo
 *                  (the gate-assessment gap 2 closure — the M1-M4 surface is
 *                  deployed; this verifies the FLOWS, not just the table):
 *                  the rule CRUD round-trip (create → field-faithful echo at
 *                  priority 1 → GET + list → missing-404 → edit → delete →
 *                  404-after-delete → list []), the priority swap (ids via
 *                  wrangler d1 — neither render exposes an addressable rule
 *                  id), the push-time per-ref rejection (ONE real push
 *                  carrying a protected ref + an unprotected sibling: git
 *                  exit 1, "! [remote rejected] … (Not allowed to push to
 *                  protected branch main)", main unmoved, sibling landed),
 *                  the merge approval gate (PR into the protected branch →
 *                  405 "Does not have enough approvals" → an ADMIN-minted
 *                  write collaborator's official APPROVED review → merge 200,
 *                  main advanced), and the whitelist/enforce-admins flag set
 *                  round-tripping the serializer (glob name → branch_name "",
 *                  the M4 sanitizer keeps the owner, the enable_push=false
 *                  cascade). CHAINED (shared fixtures). Needs an ADMIN PAT +
 *                  wrangler auth for the priority id lookup (--d1-scope). A
 *                  red run sweeps the rules + repo + member user + its token
 *                  (the failureTail).
 *   demo           The SPEC-0014 demo-POSTURE battery (§7's named battery)
 *                  against the deployed demo instance: the committed deploy
 *                  config's machinery posture (the hourly cron entry beside
 *                  the standing cadence, the repo-tasks dead_letter_queue +
 *                  its DLQ consumer entry — M0 — and DEMO_MODE default OFF in
 *                  BOTH wrangler.jsonc + wrangler.jsonc.example, the §2 hard
 *                  invariant's config arm), the open-signup posture (anonymous
 *                  GET /user/sign_up → 200 with the registration form — the
 *                  ALLOW_SIGNUP=true demo posture; 404 = the gate closed on
 *                  this deployment, a posture red by design), the §4.4 demo
 *                  banner marker on GET / (M2 IN FLIGHT: until the banner
 *                  wave lands a miss is the documented [warn] degradation —
 *                  the arm asserts hard against the landed marker shape once
 *                  it does), and the 72 h TTL mechanics — the DEEP arm runs
 *                  LOCAL-ONLY (--d1-scope local against pnpm dev with
 *                  DEMO_MODE=true in .dev.vars: fabricate the M1 unit's
 *                  recipe row — created_at backdated 73 h, owner_id NULLed to
 *                  the fail-safe swept arm — tick the hourly cron through
 *                  miniflare's /cdn-cgi/local/scheduled trigger surface, poll
 *                  the row gone; on a deployed target it records an ops-note
 *                  [info], the sweep log not being API-reachable).
 *                  INDEPENDENT (the posture shape): every arm reports its own
 *                  verdict. A red run sweeps the fabricated TTL repo (D1
 *                  --local delete + the best-effort API delete — the
 *                  failureTail); the posture arms create nothing.
 *   cleanup-audit  The post-run D1 count shapes (wrangler d1 execute; see the
 *                  audit SQL below for the exact tables).
 *   all            Every battery in the order above (audit last).
 *
 * Conventions (mirroring scripts/deploy-smoke.mjs):
 *   - PAT handling: the token is MINTED PER RUN by the operator (e.g.
 *     scripts/bootstrap-admin.mjs --remote) into a temp file with mode 0600;
 *     --token-file points at it. The file mode is enforced (a looser file is
 *     refused before any request) and the token is never echoed — every
 *     progress line, detail, and the JSON summary are scrubbed against it
 *     (and against the login session cookie).
 *   - Output: `  [pass] <id> (<ms> ms) — <detail>` progress lines (the same
 *     shape the evidence blocks quote) + a final JSON summary on stdout;
 *     exit code is non-zero iff any check FAILS (warn/skip never fail).
 *   - PAT-identity preflight: before any HTTP battery runs, GET /api/v1/user
 *     with the PAT and compare its `login` to --user. Repo creation is
 *     DOER-relative (POST /user/repos lands in the PAT's own namespace) while
 *     every follow-up arm addresses /repos/<--user>/…, so a --user that does
 *     not match the PAT's login used to create repos and then 404 every
 *     follow-up arm. Mismatch = exit 2 BEFORE anything is created (one line
 *     naming the actual login, the requested --user, and both fixes); a match
 *     passes silently. One request per invocation (cached); the D1-only
 *     cleanup-audit has no HTTP surface and never triggers it.
 *   - Red runs self-sweep (the consistency posture — REDEPLOY16's decision:
 *     the cleanup-audit battery exists precisely to prove zero leftovers, so
 *     deliberate red-run strays lost to the old lfs-e2e leave-for-debug
 *     convention): every battery that creates server-side state carries a
 *     finally-style failureTail (generate-e2e's shape — fullName-tracked
 *     creations, one [tail] line, green runs silent); p0's tail covers only
 *     its SELF-SEEDED fixture (the setup's POST /user/repos) and sweeps it
 *     only when THIS run created it AND the run failed — a pre-existing
 *     fixture belongs to its earlier window's user and is never deleted,
 *     and a green run keeps its seed (it becomes the standing fixture the
 *     next run 409s onto).
 *
 * Canonical expectations ported from the latest evidence block
 * (docs/design/p0-evidence.md, REDEPLOY13 2026-10-26, ~lines 1507-1697;
 * tombstone/registry arms from the REDEPLOY12 t+0 proof ~1395-1417 and the
 * REDEPLOY10 registry re-probe ~991-1030):
 *   - shallow-since / shallow-exclude clones exit 128 with the server text
 *     naming 'deepen-since' / 'deepen-not'; depth=1 clones exit 0 with
 *     .git/shallow == the HEAD tip, 1 commit, fsck clean (fixture tip
 *     502abd2d… on the standing production repo; pin with --fixture-oid).
 *   - the fixture self-seeds when absent: POST /user/repos {name,
 *     private:true, auto_init:true} → 201 (409 = the standing fixture is
 *     reused verbatim). A self-seeded fixture carries a fresh auto_init tip,
 *     so --fixture-oid applies only to the standing fixture (the depth-1
 *     check pins the SHAPE unless the oid is passed).
 *   - the standing fixture is PRIVATE: anonymous API GET 404, anonymous
 *     info/refs 401 Basic challenge, anonymous web page 404.
 *   - after a registry tombstone delete, the VERY NEXT anonymous ls-remote on
 *     the renamed name answers 128 `repository not found` — no sleep.
 *   - generate answers 201 with "empty":false in the response body; both
 *     carried refs sit at the identical tip; contents API decodes verbatim.
 *     The generated repo's GIT WIRE is a carried OPEN ISSUE (clone 500 /
 *     push `missing necessary objects`): gen-generated-clone is reported as
 *     a warn until the engine read path lands — pass
 *     --strict-generated-clone to promote it to a hard assert.
 *   - push mirror (REDEPLOY13 ~1600-1610, credential-free arms): registering
 *     the loopback target https://127.0.0.1:9/dummy-unreachable.git answers
 *     401 "Permission denied" AT THE DOOR (the egress screen; lax/strict
 *     MIRROR_ALLOWED_HOST_LIST) and writes nothing; the gate-passing
 *     https://pmir-<hex>.invalid target answers 200 with the fresh-row wire
 *     (last_error "", last_update null, interval 8h0m0s, sync_on_commit
 *     false, remote_name remote_mirror_<10 alnum>) -> push_mirrors-sync 200
 *     enqueues -> the consumer's failed attempt settles last_error naming
 *     the target's info/refs advertisement URL (canonical production text:
 *     "mirror target responded 530 for info/refs advertisement
 *     [<addr>/info/refs?service=git-receive-pack]"; local dev's fetch
 *     failure reads "request failed" with the same bracketed URL) with
 *     sync_state back to 'idle' and next_sync_at=0 (row re-read via wrangler
 *     d1, --d1-scope) -> DELETE 204 and the list back to [].
 *   - login: POST /login form-urlencoded user_name + password=<PAT> answers
 *     303 with a gitea_session cookie; the labels page then shows the
 *     writer's "New Label" form (3 occurrences canonically, +the
 *     small-menu-items nav) where the anonymous render shows none.
 *   - cleanup audit: repositories of the probe user == 1 (p0-shallow,
 *     intentionally live), status='creating' == 0, "action" == 0 (the
 *     389da18 delete sweep — no hand-sweep), stars == 0, push_mirrors == 0,
 *     protected_branches == 0, repo_redirects == 0, user_blocking == 0,
 *     personal_access_tokens == 1 (the standing bootstrap PAT).
 *
 * This file deliberately does NOT touch docs/design/p0-evidence.md (it is
 * REDEPLOY14's in-flight document); the conventions note lives here.
 */
/* global fetch, AbortSignal, URLSearchParams -- Web globals provided by Node >= 22 (no node: module exports them) */
import { execFile } from "node:child_process";
import console from "node:console";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.join(repoRoot, "apps", "worker");
const DEFAULT_USER = "p0probe";
const BATTERY_NAMES = ["p0", "registry", "generate-e2e", "forkpr-e2e", "mirror", "ui-login", "window2-mounts", "window3-mounts", "fixwave-parity", "branch-protection", "demo", "cleanup-audit", "all"];
/** Batteries that make NO HTTP calls (they read D1 via wrangler only):
 *  --base-url and --token-file are OPTIONAL for these (REDEPLOY15 friction
 *  (a): the D1-only audit still demanded a PAT, forcing a scratch-mint +
 *  delete dance). A missing token errors only when a selected battery
 *  actually needs one; a SUPPLIED token file is still validated + scrubbed. */
const D1_ONLY_BATTERIES = new Set(["cleanup-audit"]);

/** Canonical fixture tip on the standing production repo (p0probe/p0-shallow). */
const CANONICAL_FIXTURE_OID = "502abd2d5561536873088528a9f57f02cd1633e1";

// ---------- CLI ----------

const parseArgs = (argv) => {
  const opts = {
    battery: null, baseUrl: null, tokenFile: null, user: DEFAULT_USER,
    json: false, dryRun: false, help: false,
    // 60s default (the 2026-10-27 wrap's live finding): the heavy flows
    // (generate --strict-generated-clone, mirror create, t2 rename) LEGITIMATELY
    // exceed 20s on a fresh deployment — every run-1/run-2 "timeout" left its
    // repo created server-side (the operation succeeded; only the response
    // wait aborted), leaking residue into the cleanup audit. 20s was calibrated
    // when the flows were smaller; AbortSignal only bites when actually slow.
    timeoutMs: 60_000,
    trials: 3, fixtureRepo: "p0-shallow", fixtureOid: null, newLabelCount: 3,
    strictGeneratedClone: false, d1Scope: "remote", expectOwnerRepos: 1, expectTokens: 2,
    mirrorSettleMs: 30_000, forceRed: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help") opts.help = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--base-url") opts.baseUrl = argv[++i];
    else if (a === "--token-file") opts.tokenFile = argv[++i];
    else if (a === "--user") opts.user = argv[++i];
    else if (a === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
    else if (a === "--trials") opts.trials = Number(argv[++i]);
    else if (a === "--fixture-repo") opts.fixtureRepo = argv[++i];
    else if (a === "--fixture-oid") opts.fixtureOid = argv[++i];
    else if (a === "--new-label-count") opts.newLabelCount = Number(argv[++i]);
    else if (a === "--strict-generated-clone") opts.strictGeneratedClone = true;
    else if (a === "--d1-scope") opts.d1Scope = argv[++i];
    else if (a === "--mirror-settle-ms") opts.mirrorSettleMs = Number(argv[++i]);
    else if (a === "--expect-owner-repos") opts.expectOwnerRepos = Number(argv[++i]);
    else if (a === "--expect-tokens") opts.expectTokens = Number(argv[++i]);
    else if (a === "--force-red") opts.forceRed = argv[++i];
    else if (opts.battery === null && !a.startsWith("--")) {
      if (!BATTERY_NAMES.includes(a)) throw new Error(`unknown battery: ${a} (known: ${BATTERY_NAMES.join(", ")})`);
      opts.battery = a;
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.help) return opts;
  if (opts.battery === null && opts.dryRun) opts.battery = "all"; // a bare --dry-run plans every battery
  if (opts.battery === null) throw new Error(`a battery is required (one of: ${BATTERY_NAMES.join(", ")})`);
  // REDEPLOY15 friction (a): the D1-only batteries take neither --base-url nor
  // --token-file; a missing token errors only when the run makes HTTP calls.
  const needsHttp = opts.battery === "all" || !D1_ONLY_BATTERIES.has(opts.battery);
  if (!opts.dryRun && needsHttp) {
    if (!opts.baseUrl) throw new Error("--base-url is required (the selected battery makes HTTP calls; the D1-only cleanup-audit takes none)");
    if (!/^https?:\/\//.test(opts.baseUrl)) throw new Error(`--base-url must be an http(s) URL: ${opts.baseUrl}`);
    if (!opts.tokenFile) throw new Error("--token-file is required (mint a per-run PAT into a 0600 temp file; the D1-only cleanup-audit runs without one)");
  }
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(opts.user)) throw new Error("--user must be 1-64 chars of [a-zA-Z0-9_.-]");
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error("--timeout-ms must be a positive number");
  if (!Number.isInteger(opts.trials) || opts.trials < 1 || opts.trials > 10) throw new Error("--trials must be 1-10");
  if (opts.d1Scope !== "remote" && opts.d1Scope !== "local") throw new Error("--d1-scope must be remote or local");
  if (!Number.isFinite(opts.mirrorSettleMs) || opts.mirrorSettleMs <= 0) throw new Error("--mirror-settle-ms must be a positive number of milliseconds");
  if (opts.forceRed !== null && (typeof opts.forceRed !== "string" || opts.forceRed.length === 0)) throw new Error("--force-red needs the exact check id to force red (e.g. gen-generated-contents)");
  opts.baseUrl = opts.baseUrl ? opts.baseUrl.replace(/\/+$/, "") : null;
  return opts;
};

const usage = () =>
  "usage: node scripts/deploy-probes.mjs <battery> --base-url <url> --token-file <path>\n" +
  "                                     [--user p0probe] [--timeout-ms <n>] [--json]\n" +
  "                                     (D1-only cleanup-audit: --base-url/--token-file optional)\n" +
  "       node scripts/deploy-probes.mjs <battery> --dry-run   (prints every probe + its canonical expectation)\n" +
  "\n" +
  `batteries: ${BATTERY_NAMES.join(", ")}\n` +
  "battery options:\n" +
  "  p0:            --fixture-repo p0-shallow  --fixture-oid <sha> (pin the standing tip; the fixture self-seeds — private + auto_init — when absent)\n" +
  "  registry:      --trials <1-10>            (default 3, one tombstone lifecycle each)\n" +
  "  generate-e2e:  --strict-generated-clone   (promote the carried git-wire warn to a hard assert)\n" +
  "  forkpr-e2e:    (no extra options)\n" +
  "  mirror:        --mirror-settle-ms <ms>    (sync-settle budget, default 30000; the row-settle arm reuses --d1-scope)\n" +
  "  ui-login:      --new-label-count <n>      (canonical 3 writer-form occurrences)\n" +
  "  window2-mounts: (no extra options)\n" +
  "  window3-mounts: (no extra options)\n" +
  "  fixwave-parity: (no extra options — needs an ADMIN PAT + wrangler auth for the d1 arms; --d1-scope rides the rotation backdate)\n" +
  "  branch-protection: (no extra options — needs an ADMIN PAT for the member arm; the priority ids and the slash-glob arm are pure API now)\n" +
  "  demo:          --d1-scope local (against pnpm dev with DEMO_MODE=true in .dev.vars) runs the deep TTL-mechanics arm; a deployed target records an ops-note [info] there (the sweep log is not API-reachable). The banner arm warns until the M2 wave lands.\n" +
  "  cleanup-audit: --d1-scope remote|local  --expect-owner-repos <n> (1)  --expect-tokens <n> (1)\n" +
  "  any battery:   --force-red <check-id>    (self-test: force that check red UNRUN — exercises the failure-tail sweep; an unmatched id warns)";

// ---------- plumbing ----------

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  // CLI errors exit 2 with a one-line message (no stack) — the documented shape.
  console.error(`deploy-probes: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
}
if (opts.help) {
  console.log(usage());
  process.exit(0);
}
const jsonMode = opts.json;
const log = (...args) => (jsonMode ? console.error(...args) : console.log(...args));
const startedAt = new Date();

/** The per-run PAT, assigned by loadToken() before any request is made. */
let TOKEN = "";

const results = [];
const leftBehind = [];
const secrets = []; // the PAT + the login session cookie — scrubbed from every line
const scrub = (text) => {
  let s = text;
  for (const sec of secrets) s = s.split(sec).join("***");
  return s;
};

/** Every fetch is timeout-guarded (AbortSignal); redirects are surfaced, not followed. */
// Probes test the APPLICATION, not the CDN: send no-cache so a stale edge
// entry for the URL (possible from before the RD20 Cache-Control fix —
// response `private` prevents NEW entries but old heuristic ones persist
// until they age out) can't mask the app's true state.
const fetchT = (url, init = {}) =>
  fetch(url, {
    ...init,
    redirect: "manual",
    headers: { "cache-control": "no-cache", ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(opts.timeoutMs),
  });

/** Authenticated JSON call against the /api/v1 surface (`Authorization: token <PAT>`).
 *  `asToken` substitutes another minted credential (the fixwave battery's
 *  member PAT); `basic` sends HTTP Basic `user:pass` instead (upstream's
 *  reqBasicAuth gate on token CRUD — the fixwave mint arm); `headers` merges
 *  extra headers (the `Sudo` impersonation arm). Minted substitution
 *  credentials are scrubbed by their minting step. */
const api = async (apiPath, { method = "GET", body, auth = true, cookie, asToken, basic, headers: extraHeaders } = {}) => {
  const headers = { ...(extraHeaders ?? {}) };
  if (basic) headers.authorization = `Basic ${Buffer.from(`${basic.user}:${basic.pass}`).toString("base64")}`;
  else if (auth) headers.authorization = `token ${asToken ?? TOKEN}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const res = await fetchT(`${opts.baseUrl}/api/v1${apiPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body — the caller asserts on status */ }
  return { status: res.status, text, json, headers: res.headers };
};

/** execFile as a promise; never throws — the caller decides what failure means. */
const run = (cmd, args, { cwd, timeoutMs = 120_000, env } = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
    }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: stdout ?? "", stderr: stderr ?? "", killed: Boolean(err?.killed) });
    });
  });

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", LC_ALL: "C", LANG: "C" };
/** git with the credential out of the URL — auth rides `http.extraHeader` (the
 *  evidence methodology; execFile argv needs no shell quoting for the space).
 *  `as` substitutes another minted credential (the fixwave battery's member
 *  PAT — scrubbed by its minting step). */
const git = (args, cwd, { auth = false, as } = {}) =>
  run("git", [
    "-c", "credential.helper=",
    ...(auth ? ["-c", `http.extraHeader=Authorization: token ${as ?? TOKEN}`] : []),
    ...args,
  ], { cwd, env: GIT_ENV });

const gitUrl = (owner, repo) => `${opts.baseUrl}/${owner}/${repo}.git`;

/** ls-remote → {ok, code, stderr, refs: Map(ref → oid)}. */
const lsRemote = async (url, { auth = false, as } = {}) => {
  const r = await git(["ls-remote", url], undefined, { auth, as });
  const refs = new Map(r.stdout.trim().split("\n").filter(Boolean)
    .map((line) => { const [oid, ref] = line.split("\t"); return [ref, oid]; }));
  return { ...r, refs };
};

/** Poll fn() until truthy or the budget expires; returns the last value. */
const poll = async (budgetMs, fn) => {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return v;
    await sleep(500);
  }
};

const hexId = (n = 8) => randomUUID().replaceAll("-", "").slice(0, n);

/** Self-test knob (--force-red <id>): the matched check records a fail WITHOUT
 *  running — the deterministic "deliberately-bogus step" that exercises a
 *  battery's failure-tail sweep (and the [skip] chain after it) at zero cost.
 *  An id that matches nothing warns on stderr at summary time. */
let forceRedMatched = false;

/**
 * Run one check, record {id, status, detail, ms}, print the evidence-block
 * progress line. The checked fn returns a detail string (pass) or
 * {status: "warn"|"info", detail} for outcomes that never fail the battery;
 * throwing = fail.
 */
async function check(id, fn) {
  if (opts.forceRed === id) {
    forceRedMatched = true;
    const detail = `FORCED RED (--force-red ${id}; nothing ran — the battery's failure tail must sweep the creations)`;
    results.push({ id, status: "fail", detail, ms: 0 });
    log(`  [fail] ${id} (0 ms) — ${detail}`);
    return;
  }
  const t0 = performance.now();
  let status = "pass";
  let detail;
  try {
    const out = await fn();
    if (typeof out === "string") detail = out;
    else {
      status = out.status;
      detail = out.detail;
    }
  } catch (err) {
    status = "fail";
    detail = err instanceof Error ? err.message : String(err);
  }
  detail = scrub(detail);
  const ms = Math.round(performance.now() - t0);
  results.push({ id, status, detail, ms });
  log(`  [${status}] ${id} (${ms} ms)${detail ? ` — ${detail}` : ""}`);
}

const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/** Chained steps: once one fails the rest record [skip] (deploy-smoke's chain). */
async function chain(steps) {
  let failed = false;
  for (const step of steps) {
    if (failed) {
      results.push({ id: step.id, status: "skip", detail: "prior step failed", ms: 0 });
      log(`  [skip] ${step.id} — prior step failed`);
      continue;
    }
    const idx = results.length;
    await check(step.id, step.run);
    if (results[idx].status === "fail") failed = true;
  }
}

/** Best-effort repo DELETE via the API (204). Non-204 = warn + leftBehind, never fatal. */
const deleteRepo = async (owner, repo) => {
  const res = await api(`/repos/${owner}/${repo}`, { method: "DELETE" });
  if (res.status === 204) return `repo ${owner}/${repo} deleted`;
  leftBehind.push(`repo ${owner}/${repo} (DELETE returned ${res.status})`);
  return { status: "warn", detail: `repo ${owner}/${repo} LEFT BEHIND — DELETE returned ${res.status} ${res.text.slice(0, 80)}` };
};

/** Settle budgets (§2.5.2: pushes settle in waitUntil after the response; the
 *  evidence polls create-settle green on poll 1 at 2.5-3.4 s). Single-shot
 *  probes (rename carry, tombstone t+0) deliberately do NOT poll. */
const SETTLE_MS = 15_000;
const FORK_SETTLE_MS = 30_000;
/** The .invalid sync settle (the queue consumer's failed attempt — the
 *  evidence's first poll landed ~3 s). REDEPLOY15 observed a PRODUCTION settle
 *  at 12 s (queue-latency variance; the re-run settled at 1.3 s), red-spinning
 *  the debut 10 s budget — the default is now 30 s (~2.5x the observed worst);
 *  tighten for quick local runs with --mirror-settle-ms. */
const MIRROR_SETTLE_MS = opts.mirrorSettleMs;

// ---------- battery: p0 (shallow trio + privacy tail) ----------

/**
 * The RD24 papercut (docs/design/p0-evidence.md, REDEPLOY24): the battery
 * used to CLONE a pre-existing fixture repo, so a fresh run user 404'd on
 * first contact and the window's orchestrator had to seed
 * `<user>/<fixture-repo>` by hand mid-run. The battery is now self-sufficient:
 * p0Setup (below) runs BEFORE the checks and creates the fixture when absent
 * — the exact call the window used by hand. The fixture state feeds the tail:
 * `fixtureCreated` marks a 201 (a 409 reuse NEVER deletes — earlier windows'
 * users own theirs), `checksStart` fences the tail to this battery's own
 * check slice, `setupThrew` lets the tail sweep a fixture this run created
 * even when the setup itself failed after the 201.
 */
const p0Context = () => ({
  user: opts.user,
  repo: opts.fixtureRepo,
  url: gitUrl(opts.user, opts.fixtureRepo),
  tmp: null,
  fixtureCreated: false, fixtureFullName: null, setupThrew: false, checksStart: 0,
});

/**
 * The self-fixture setup (the RD24 window's hand step, now the battery's own):
 * POST /user/repos {name: opts.fixtureRepo, private: true, auto_init: true}
 * — 201 self-seeds (the create lands the registry entry + the auto-init
 * commit synchronously; the settle poll is insurance so the FIRST check's
 * authenticated clone never races a fresh cell), 409 tolerates the standing
 * fixture from a prior run/window, any other answer fails the setup (main's
 * catch → exit 2; a fixture we cannot prove we created is never deleted).
 * A self-seeded fixture that survives a GREEN run stays: it becomes the
 * user's standing fixture (the next run 409s onto it — the cleanup-audit
 * `repositories == 1` shape). Runs before p0Steps' checks; the checks
 * themselves are untouched.
 */
const p0Setup = async (ctx) => {
  ctx.checksStart = results.length;
  try {
    const res = await api("/user/repos", {
      method: "POST",
      body: { name: ctx.repo, private: true, auto_init: true },
    });
    if (res.status === 201) {
      ctx.fixtureCreated = true;
      ctx.fixtureFullName = String(res.json?.full_name ?? `${ctx.user}/${ctx.repo}`);
      const settled = await poll(SETTLE_MS, async () => {
        const refs = await fetchT(`${ctx.url}/info/refs?service=git-upload-pack`, {
          headers: { authorization: `token ${TOKEN}` },
        });
        await refs.text();
        return refs.status === 200;
      });
      if (!settled) {
        throw new Error(`self-seeded fixture ${ctx.fixtureFullName} never answered an authenticated info/refs 200 within ${SETTLE_MS} ms`);
      }
      log(`  [setup] p0-fixture — self-seeded ${ctx.fixtureFullName} (private, auto_init; info/refs settled)`);
    } else if (res.status === 409) {
      log(`  [setup] p0-fixture — ${ctx.user}/${ctx.repo} already exists (409) — reusing the standing fixture (never deleted by this battery)`);
    } else {
      throw new Error(`fixture self-seed POST /api/v1/user/repos → ${res.status} (expected 201 or 409): ${res.text.slice(0, 120)}`);
    }
  } catch (err) {
    ctx.setupThrew = true; // the tail sweeps a fixture this run created even on a failed setup
    throw err;
  }
};

/**
 * The red-runs-self-sweep posture for the SELF-SEEDED fixture only: a failed
 * p0 run (any red check in this battery's slice, or a setup throw after the
 * 201) sweeps the fixture it created. A PRE-EXISTING fixture (the 409 path)
 * is never touched, whatever this run's verdict. A green run keeps its
 * self-seeded fixture ON PURPOSE: it IS the standing fixture the next run
 * reuses. Best-effort, one [tail] line, never throws (main's finally depends
 * on it); failures feed left_behind.
 */
const p0FailureCleanup = async (ctx) => {
  if (!ctx.fixtureCreated) return; // nothing self-seeded (409 reuse / setup never reached the POST) — nothing to sweep
  const mine = results.slice(ctx.checksStart);
  const runFailed = ctx.setupThrew === true || mine.some((r) => r.status === "fail");
  if (!runFailed) return; // green: the self-seeded fixture stays (it becomes the standing fixture)
  const acts = [];
  const [owner, repo] = String(ctx.fixtureFullName ?? `${ctx.user}/${ctx.repo}`).split("/");
  try {
    const out = await deleteRepo(owner, repo);
    acts.push(typeof out === "string" ? out : out.detail);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    leftBehind.push(`repo ${owner}/${repo} (p0 failure-cleanup tail: DELETE threw: ${why})`);
    acts.push(`repo ${owner}/${repo} LEFT BEHIND — DELETE threw: ${why}`);
  }
  if (acts.length) log(`  [tail] p0-leftover-sweep (best-effort failure cleanup) — ${scrub(acts.join("; "))}`);
};

const probeShallowSince = async (ctx) => {
  const dir = path.join(ctx.tmp, "shallow-since");
  const r = await git(["clone", "--shallow-since=2026-10-20 00:00:00 +0000", ctx.url, dir], undefined, { auth: true });
  expect(r.code === 128, `exit ${r.code} (expected 128): ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  expect(!existsSync(dir), "clone dir exists after the failed clone (expected: no repo dir)");
  expect(r.stderr.includes("deepen-since") && r.stderr.includes("unsupported fetch argument"),
    `stderr does not name 'deepen-since' as an unsupported fetch argument: ${r.stderr.trim().slice(0, 200)}`);
  return `exit 128 — unsupported fetch argument 'deepen-since' (only depth-limited shallow fetches are supported)`;
};

const probeShallowExclude = async (ctx) => {
  const dir = path.join(ctx.tmp, "shallow-exclude");
  const r = await git(["clone", "--shallow-exclude=old-base", ctx.url, dir], undefined, { auth: true });
  expect(r.code === 128, `exit ${r.code} (expected 128): ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  expect(!existsSync(dir), "clone dir exists after the failed clone (expected: no repo dir)");
  expect(r.stderr.includes("deepen-not") && r.stderr.includes("unsupported fetch argument"),
    `stderr does not name 'deepen-not' as an unsupported fetch argument: ${r.stderr.trim().slice(0, 200)}`);
  return `exit 128 — same shape naming 'deepen-not'`;
};

const probeDepth1 = async (ctx) => {
  const dir = path.join(ctx.tmp, "depth-1");
  const r = await git(["clone", "--depth=1", ctx.url, dir], undefined, { auth: true });
  expect(r.ok, `clone --depth=1 failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  const rev = await git(["rev-parse", "HEAD"], dir);
  expect(rev.ok, `rev-parse HEAD failed: ${rev.stderr.trim().slice(0, 200)}`);
  const tip = rev.stdout.trim();
  expect(/^[0-9a-f]{40}$/.test(tip), `HEAD is not an oid: ${tip}`);
  const shallow = (await readFile(path.join(dir, ".git", "shallow"), "utf8")).trim().split("\n");
  expect(shallow.length === 1 && shallow[0] === tip,
    `.git/shallow should be exactly the HEAD tip ${tip.slice(0, 10)}…, got ${JSON.stringify(shallow)}`);
  if (opts.fixtureOid) {
    expect(tip === opts.fixtureOid, `tip ${tip} != the pinned fixture oid ${opts.fixtureOid}`);
  }
  const count = await git(["rev-list", "--count", "HEAD"], dir);
  expect(count.stdout.trim() === "1", `commit count ${count.stdout.trim()} (expected 1)`);
  const isShallow = await git(["rev-parse", "--is-shallow-repository"], dir);
  expect(isShallow.stdout.trim() === "true", `is-shallow-repository = ${isShallow.stdout.trim()} (expected true)`);
  const fsck = await git(["fsck"], dir);
  expect(fsck.ok, `fsck failed: ${(fsck.stderr || fsck.stdout).trim().slice(0, 200)}`);
  const pin = opts.fixtureOid ? "" : ` (canonical pin ${CANONICAL_FIXTURE_OID.slice(0, 10)}… — pass --fixture-oid to enforce)`;
  return `exit 0 — .git/shallow = ${tip.slice(0, 10)}… (identical tip); depth 1; fsck clean${pin}`;
};

const probePrivacyTail = async (ctx) => {
  const res = await api(`/repos/${ctx.user}/${ctx.repo}`, { auth: false });
  expect(res.status === 404, `anonymous API GET status ${res.status} (expected 404)`);
  expect(res.text.includes("not found"), `anonymous API GET body ${res.text.slice(0, 120)} (expected the not-found report)`);
  const refs = await fetchT(`${ctx.url}/info/refs?service=git-upload-pack`);
  await refs.text();
  expect(refs.status === 401, `anonymous info/refs status ${refs.status} (expected 401 — the fixture is private)`);
  const wwwAuth = String(refs.headers.get("www-authenticate") ?? "");
  expect(wwwAuth.includes("Basic"), `anonymous info/refs www-authenticate ${wwwAuth} (expected a Basic challenge)`);
  const page = await fetchT(`${opts.baseUrl}/${ctx.user}/${ctx.repo}`);
  await page.text();
  expect(page.status === 404, `anonymous web page status ${page.status} (expected 404)`);
  return `anonymous API GET 404, info/refs 401 (${wwwAuth}), web page 404 — the fixture stays private`;
};

const p0Steps = (ctx) => [
  { id: "p0-shallow-since", expect: `git clone --shallow-since="2026-10-20 00:00:00 +0000" (authenticated via http.extraHeader) → exit 128, no repo dir; stderr names 'deepen-since' (unsupported fetch argument)`, run: () => probeShallowSince(ctx) },
  { id: "p0-shallow-exclude", expect: `git clone --shallow-exclude=old-base (authenticated) → exit 128, no repo dir; same shape naming 'deepen-not'`, run: () => probeShallowExclude(ctx) },
  { id: "p0-depth-1", expect: `git clone --depth=1 (authenticated) → exit 0; .git/shallow = the HEAD tip${opts.fixtureOid ? ` == ${opts.fixtureOid}` : ` (canonical pin ${CANONICAL_FIXTURE_OID.slice(0, 10)}…)`}; 1 commit; is-shallow true; fsck clean`, run: () => probeDepth1(ctx) },
  { id: "p0-privacy-anon", expect: `the standing fixture stays private: anonymous API GET 404, anonymous info/refs 401 Basic challenge, anonymous web page 404`, run: () => probePrivacyTail(ctx) },
];

// ---------- battery: registry (tombstone sweep, carry + t+0) ----------

/** Each trial's `created`/`fullName`/`gone` state feeds the failure-cleanup
 *  tail (see registryFailureCleanup): the red-runs-self-sweep posture.
 *  fullName is what the CREATE actually returned (the doer's namespace) and
 *  is re-pointed by rename-200, so the tail deletes each surviving repo under
 *  whichever name it currently answers to — a red before the rename sweeps
 *  the create name, a red after it the renamed one. */
const registryContext = () => ({ trials: [], tmp: null });

const registryTrialSteps = (ctx, t) => {
  const name = `reg-${hexId()}`;
  const renamed = `${name}-r2`;
  const trial = { name, created: false, fullName: null, gone: false };
  ctx.trials.push(trial);
  const oldUrl = gitUrl(opts.user, name);
  const newUrl = gitUrl(opts.user, renamed);
  return [
    {
      id: `t${t}-create-201`,
      expect: `POST /api/v1/user/repos {"name":"${name}","private":false,"auto_init":true} → 201`,
      run: async () => {
        const res = await api("/user/repos", { method: "POST", body: { name, private: false, auto_init: true } });
        expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 120)}`);
        trial.created = true; // the failure-cleanup tail deletes it if a later step reds
        trial.fullName = String(res.json?.full_name ?? `${opts.user}/${name}`);
        return `created ${res.json?.full_name ?? `${opts.user}/${name}`} (public, auto_init)`;
      },
    },
    {
      id: `t${t}-advert-settle`,
      expect: `anonymous ls-remote on the new repo (settle-polled, budget ${SETTLE_MS / 1000}s) → exit 0 listing HEAD + refs/heads/main — the create half holds`,
      run: async () => {
        const done = await poll(SETTLE_MS, async () => {
          const r = await lsRemote(oldUrl);
          return r.ok && r.refs.has("refs/heads/main") ? r : null;
        });
        expect(done !== null, `anonymous advert never came up within ${SETTLE_MS} ms`);
        return `exit 0 — ${[...done.refs.keys()].join(", ")}`;
      },
    },
    {
      id: `t${t}-rename-200`,
      expect: `PATCH /api/v1/repos/${opts.user}/${name} {"name":"${renamed}"} → 200 with the new full_name`,
      run: async () => {
        const res = await api(`/repos/${opts.user}/${name}`, { method: "PATCH", body: { name: renamed } });
        expect(res.status === 200, `status ${res.status} (expected 200): ${res.text.slice(0, 120)}`);
        expect(String(res.json?.full_name ?? "").endsWith(renamed), `full_name ${res.json?.full_name} (expected …/${renamed})`);
        trial.fullName = String(res.json?.full_name ?? `${opts.user}/${renamed}`); // re-pointed for the tail
        return `renamed to ${res.json?.full_name}`;
      },
    },
    {
      id: `t${t}-rename-carry`,
      expect: `IMMEDIATE anonymous ls-remote on the NEW name (single-shot, no sleep) → exit 0 listing ALL refs (incl. refs/heads/main) — the carry holds`,
      run: async () => {
        const r = await lsRemote(newUrl);
        expect(r.ok, `ls-remote on the new name failed (exit ${r.code}): ${r.stderr.trim().slice(0, 200)}`);
        expect(r.refs.has("refs/heads/main"), `the new-name advert lost refs/heads/main: ${[...r.refs.keys()].join(", ")}`);
        return `the carry holds — ${[...r.refs.keys()].join(", ")}`;
      },
    },
    {
      id: `t${t}-delete-204`,
      expect: `DELETE /api/v1/repos/${opts.user}/${renamed} → 204`,
      run: async () => {
        const res = await api(`/repos/${opts.user}/${renamed}`, { method: "DELETE" });
        expect(res.status === 204, `status ${res.status} (expected 204)`);
        trial.gone = true; // the tail no-ops on a green sweep
        return "204";
      },
    },
    {
      id: `t${t}-tombstone-t0`,
      expect: `THE VERY NEXT anonymous ls-remote on the renamed name (single-shot, NO sleep) → exit 128, stderr 'repository not found' — T+0 CLEAN (the closed read-after-delete window stays closed)`,
      run: async () => {
        const r = await lsRemote(newUrl);
        expect(r.code === 128, `exit ${r.code} (expected 128 — a 0 here means the tombstone window re-opened)`);
        expect(r.stderr.includes("repository not found"), `stderr ${r.stderr.trim().slice(0, 200)} (expected 'repository not found')`);
        return `exit 128 at t+0 — remote: repository not found`;
      },
    },
    {
      id: `t${t}-old-name-dead`,
      expect: `old (pre-rename) name post-delete: anonymous ls-remote → 128 not-found AND anonymous API GET → 404 {"message":"not found"}`,
      run: async () => {
        const r = await lsRemote(oldUrl);
        expect(r.code === 128 && r.stderr.includes("repository not found"),
          `old-name ls-remote exit ${r.code} (expected 128 not-found): ${r.stderr.trim().slice(0, 120)}`);
        const res = await api(`/repos/${opts.user}/${name}`, { auth: false });
        expect(res.status === 404 && res.text.includes("not found"),
          `old-name API GET ${res.status} (expected 404 not-found)`);
        return `old name dead on both paths (git 128, API 404)`;
      },
    },
  ];
};

/** The red-runs-self-sweep posture (the generate-e2e shape): a red registry
 *  run sweeps its own trial repos instead of leaving them for a hand-clean.
 *  This finally-style tail runs after EVERY registry battery run (green ones
 *  no-op silently: each trial's delete-204 already emptied it, so the gone
 *  flags skip them) and best-effort deletes exactly what the run created and
 *  has not already deleted — under the fullName the server last returned, so
 *  a red before the rename sweeps the create name and a red after it the
 *  renamed one. One [tail] line logs every action; failures feed left_behind
 *  and are never fatal; it never throws (main's finally depends on it). */
const registryFailureCleanup = async (ctx) => {
  const acts = [];
  const noteLeftBehind = (what, why) => {
    leftBehind.push(`${what} (failure-cleanup tail: ${why})`);
    acts.push(`${what} LEFT BEHIND — ${why}`);
  };
  try {
    for (const trial of ctx.trials) {
      if (trial.created !== true || trial.gone === true) continue;
      const [owner, repo] = String(trial.fullName ?? `${opts.user}/${trial.name}`).split("/");
      try {
        const out = await deleteRepo(owner, repo);
        acts.push(typeof out === "string" ? out : out.detail);
      } catch (err) {
        noteLeftBehind(`repo ${owner}/${repo}`, `DELETE threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    acts.push(`the sweep itself failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (acts.length) log(`  [tail] reg-leftover-sweep (best-effort failure cleanup) — ${scrub(acts.join("; "))}`);
};

// ---------- battery: generate-e2e ----------

const GENERATED_CLONE_CARRIED =
  "carried OPEN ISSUE (REDEPLOY13): the generated repo's git wire is not yet usable " +
  "(clone/fetch 500s in the DO's uploadPack walk; push refused 'missing necessary objects') — " +
  "expected to fail until the engine read path lands; pass --strict-generated-clone to assert it";

const LICENSE_TEXT = "MIT License\n\ncf-gitea deploy-probes generate-e2e battery\n";

/** `tmplCreated`/`genCreated` (+ the repoFullName convention and the `*Gone`
 *  flags gen-cleanup sets) drive the failure-cleanup tail (see
 *  generateFailureCleanup): REDEPLOY16 friction — a mid-battery red (the TLS
 *  flake) used to chain-skip gen-cleanup and strand the template (and,
 *  once generate answered, the generated) repo behind [skip] lines for a
 *  hand-clean. FullName is what the CREATE actually returned (the doer's
 *  namespace), so the tail deletes the right owner/slug even when --user
 *  drifts from the PAT's user. */
const generateContext = () => ({
  user: opts.user, tmpl: `tmpl-${hexId()}`, gen: `gen-${hexId()}`, tip: null, tmp: null,
  tmplCreated: false, tmplFullName: null, tmplGone: false,
  genCreated: false, genFullName: null, genGone: false,
});

const pushTemplateContent = async (ctx) => {
  const tmp = ctx.tmp; // main() owns the battery scratch dir (created + removed there)
  const tmplUrl = gitUrl(ctx.user, ctx.tmpl);
  // Clone-based (the auto_init main already carries a commit — the evidence
  // flow pushes the LICENSE commit ON it, which an unrelated init history
  // cannot fast-forward to).
  const work = path.join(tmp, "tmpl");
  let r = await git(["clone", tmplUrl, "tmpl"], tmp, { auth: true });
  expect(r.ok, `clone template failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  await writeFile(path.join(work, "LICENSE"), LICENSE_TEXT);
  r = await git(["add", "-A"], work);
  expect(r.ok, `git add failed: ${r.stderr.trim()}`);
  r = await git(["-c", "user.name=cf-gitea-probes", "-c", "user.email=probes@cf-gitea.invalid",
    "commit", "-m", "deploy-probes: generate battery content"], work);
  expect(r.ok, `git commit failed: ${r.stderr.trim()}`);
  r = await git(["push", "origin", "HEAD:refs/heads/main"], work, { auth: true });
  expect(r.ok, `push main failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  r = await git(["push", "origin", "HEAD:refs/heads/dev"], work, { auth: true });
  expect(r.ok, `push dev failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  const lr = await lsRemote(tmplUrl, { auth: true });
  expect(lr.ok && lr.refs.has("refs/heads/main") && lr.refs.has("refs/heads/dev"),
    `template ls-remote missing refs: ${[...lr.refs.keys()].join(", ")}`);
  ctx.tip = lr.refs.get("refs/heads/main");
  expect(ctx.tip === lr.refs.get("refs/heads/dev"), "main and dev differ before generate (expected the same tip)");
  return `pushed LICENSE on main + second ref refs/heads/dev, both at ${ctx.tip.slice(0, 10)}…`;
};

const generateSteps = (ctx) => [
  {
    id: "gen-create-template-201",
    expect: `POST /api/v1/user/repos {"name":"${ctx.tmpl}","auto_init":true} → 201`,
    run: async () => {
      const res = await api("/user/repos", { method: "POST", body: { name: ctx.tmpl, auto_init: true } });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 120)}`);
      ctx.tmplCreated = true; // the failure-cleanup tail deletes it if a later step reds
      ctx.tmplFullName = String(res.json?.full_name ?? `${ctx.user}/${ctx.tmpl}`);
      return `created ${res.json?.full_name}`;
    },
  },
  {
    id: "gen-template-push",
    expect: `REAL PUSH content: LICENSE commit on main via git push + second ref refs/heads/dev; ls-remote lists both at one tip`,
    run: () => pushTemplateContent(ctx),
  },
  {
    id: "gen-patch-template-200",
    expect: `PATCH {"template":true} → 200 with "template":true IN THE RESPONSE BODY`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.tmpl}`, { method: "PATCH", body: { template: true } });
      expect(res.status === 200, `status ${res.status} (expected 200): ${res.text.slice(0, 120)}`);
      expect(res.json?.template === true, `template flag not in the body: ${res.text.slice(0, 120)}`);
      return `200 with "template":true`;
    },
  },
  {
    id: "gen-template-persisted",
    expect: `follow-up GET → 200 with template:true PERSISTED`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.tmpl}`);
      expect(res.status === 200 && res.json?.template === true,
        `status ${res.status}, template ${res.json?.template} (expected persisted true)`);
      return "template:true persisted";
    },
  },
  {
    id: "gen-generate-201-empty-false",
    expect: `POST /repos/${ctx.user}/${ctx.tmpl}/generate {"name":"${ctx.gen}","git_content":true} → 201 with "empty":false IN THE RESPONSE BODY`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.tmpl}/generate`, { method: "POST", body: { name: ctx.gen, git_content: true } });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 200)}`);
      expect(res.json?.empty === false, `empty ${res.json?.empty} (expected false in the body)`);
      ctx.genCreated = true; // the failure-cleanup tail deletes it if a later step reds
      ctx.genFullName = String(res.json?.full_name ?? `${ctx.user}/${ctx.gen}`);
      return `201 with "empty":false (${res.json?.full_name})`;
    },
  },
  {
    id: "gen-generated-empty-get",
    expect: `follow-up GET on the generated repo → "empty":false`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.gen}`);
      expect(res.status === 200 && res.json?.empty === false,
        `status ${res.status}, empty ${res.json?.empty} (expected false)`);
      return `"empty":false`;
    },
  },
  {
    id: "gen-generated-refs",
    expect: `generated repo ls-remote lists refs/heads/main + refs/heads/dev at the IDENTICAL tip {{tip}} (settle-polled, budget 10s)`,
    run: async () => {
      const lr = await poll(10_000, async () => {
        const r = await lsRemote(gitUrl(ctx.user, ctx.gen), { auth: true });
        return r.ok && r.refs.has("refs/heads/main") && r.refs.has("refs/heads/dev") ? r : null;
      });
      expect(lr !== null, "the generated repo never listed main+dev via ls-remote");
      expect(lr.refs.get("refs/heads/main") === ctx.tip && lr.refs.get("refs/heads/dev") === ctx.tip,
        `generated tips ${lr.refs.get("refs/heads/main")?.slice(0, 10)}…/${lr.refs.get("refs/heads/dev")?.slice(0, 10)}… != the carried tip ${ctx.tip.slice(0, 10)}…`);
      return `both carried refs at the identical tip ${ctx.tip.slice(0, 10)}…`;
    },
  },
  {
    id: "gen-generated-contents",
    expect: `contents API on the generated repo → 200: LICENSE base64 decodes VERBATIM; last_commit_sha = the carried tip`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.gen}/contents/LICENSE`);
      expect(res.status === 200, `status ${res.status} (expected 200): ${res.text.slice(0, 120)}`);
      const decoded = Buffer.from(String(res.json?.content ?? "").replace(/\n/g, ""), "base64").toString("utf8");
      expect(decoded === LICENSE_TEXT, `LICENSE decoded != the pushed bytes (${decoded.slice(0, 60)})`);
      expect(res.json?.last_commit_sha === ctx.tip,
        `last_commit_sha ${res.json?.last_commit_sha} != the carried tip ${ctx.tip}`);
      return `LICENSE round-trips verbatim; last_commit_sha = the carried tip`;
    },
  },
  {
    id: "gen-generated-clone",
    expect: opts.strictGeneratedClone
      ? `git clone --depth=1 of the GENERATED repo → exit 0 (hard assert; --strict-generated-clone)`
      : `git clone --depth=1 of the GENERATED repo → WARN while the carried git-wire issue is open (hard assert via --strict-generated-clone)`,
    run: async () => {
      const dir = path.join(ctx.tmp, "gen-clone");
      const r = await git(["clone", "--depth=1", gitUrl(ctx.user, ctx.gen), dir], undefined, { auth: true });
      if (r.ok) {
        return opts.strictGeneratedClone
          ? "clone succeeded (exit 0)"
          : { status: "info", detail: "clone SUCCEEDED — the carried git-wire issue looks fixed; re-run with --strict-generated-clone to pin it" };
      }
      if (opts.strictGeneratedClone) {
        throw new Error(`clone failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
      }
      return { status: "warn", detail: `${GENERATED_CLONE_CARRIED}; this run: exit ${r.code} ${(r.stderr || "").trim().slice(0, 120)}` };
    },
  },
  {
    id: "gen-cleanup",
    expect: `both probe repos DELETEd → 204 (a failed cleanup is documented, not fatal)`,
    run: async () => {
      const a = await deleteRepo(ctx.user, ctx.gen);
      const b = await deleteRepo(ctx.user, ctx.tmpl);
      await rm(ctx.tmp, { recursive: true, force: true });
      if (typeof a === "string") ctx.genGone = true; // the tail no-ops on a green sweep
      if (typeof b === "string") ctx.tmplGone = true;
      if (typeof a === "string" && typeof b === "string") return `${ctx.gen} + ${ctx.tmpl} deleted`;
      return { status: "warn", detail: `${a.detail ?? a}; ${b.detail ?? b}` };
    },
  },
];

/** REDEPLOY16 friction (the TLS-flake red stranded tmpl-85c28975 in
 *  production): a mid-battery red used to chain-skip gen-cleanup and leave the
 *  template (and generated) repo behind [skip] lines for a hand-clean. This
 *  finally-style tail runs after EVERY generate battery run (green ones no-op
 *  silently: gen-cleanup already deleted both, so the *Gone flags skip them)
 *  and best-effort deletes exactly what the run created and has not already
 *  deleted — generated first (it hangs off the template), then the template,
 *  the same order gen-cleanup sweeps. One [tail] line logs every action;
 *  failures feed left_behind and are never fatal; it never throws (main's
 *  finally depends on it). */
const generateFailureCleanup = async (ctx) => {
  const acts = [];
  const noteLeftBehind = (what, why) => {
    leftBehind.push(`${what} (failure-cleanup tail: ${why})`);
    acts.push(`${what} LEFT BEHIND — ${why}`);
  };
  try {
    const targets = [
      { what: "generated repo", created: ctx.genCreated, gone: ctx.genGone, full: ctx.genFullName, name: ctx.gen },
      { what: "template repo", created: ctx.tmplCreated, gone: ctx.tmplGone, full: ctx.tmplFullName, name: ctx.tmpl },
    ];
    for (const t of targets) {
      if (t.created !== true || t.gone === true) continue;
      const [owner, repo] = String(t.full ?? `${ctx.user}/${t.name}`).split("/");
      try {
        const out = await deleteRepo(owner, repo);
        acts.push(typeof out === "string" ? out : out.detail);
      } catch (err) {
        noteLeftBehind(`${t.what} ${owner}/${repo}`, `DELETE threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    acts.push(`the sweep itself failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (acts.length) log(`  [tail] gen-leftover-sweep (best-effort failure cleanup) — ${scrub(acts.join("; "))}`);
};

// ---------- battery: forkpr-e2e ----------

/** `baseCreated`/`forkCreated`/`orgCreated` (+ the *FullName convention and
 *  the *Gone flags forkpr-cleanup sets) drive the failure-cleanup tail (see
 *  forkprFailureCleanup): the red-runs-self-sweep posture. FullName is what
 *  the CREATE actually returned (the doer's namespace), so the tail deletes
 *  the right owner/slug even when --user drifts from the PAT's user. */
const forkprContext = () => ({
  user: opts.user, base: `prbase-${hexId()}`, org: `prorg-${hexId()}`, branch: `prbr-${hexId()}`,
  tip: null, number: null, tmp: null,
  baseCreated: false, baseFullName: null, baseGone: false,
  orgCreated: false, orgGone: false,
  forkCreated: false, forkFullName: null, forkGone: false,
});

const forkprSteps = (ctx) => [
  {
    id: "forkpr-create-base-201",
    expect: `POST /api/v1/user/repos {"name":"${ctx.base}","auto_init":true} → 201`,
    run: async () => {
      const res = await api("/user/repos", { method: "POST", body: { name: ctx.base, auto_init: true } });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 120)}`);
      ctx.baseCreated = true; // the failure-cleanup tail deletes it if a later step reds
      ctx.baseFullName = String(res.json?.full_name ?? `${ctx.user}/${ctx.base}`);
      return `created ${res.json?.full_name}`;
    },
  },
  {
    id: "forkpr-create-org-201",
    expect: `POST /api/v1/orgs {"username":"${ctx.org}"} → 201 (the doer-owned fork namespace — one PAT, no admin)`,
    run: async () => {
      const res = await api("/orgs", { method: "POST", body: { username: ctx.org } });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 120)}`);
      ctx.orgCreated = true; // the failure-cleanup tail deletes it if a later step reds
      return `org ${ctx.org} created`;
    },
  },
  {
    id: "forkpr-fork-202",
    expect: `POST /repos/${ctx.user}/${ctx.base}/forks {"organization":"${ctx.org}"} → 202 (upstream's CreateFork accepted code) with the fork at ${ctx.org}/${ctx.base} — the DEFAULT slug kept, so the bare owner:branch head form resolves the fork`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.base}/forks`, { method: "POST", body: { organization: ctx.org } });
      expect(res.status === 202, `status ${res.status} (expected 202): ${res.text.slice(0, 200)}`);
      expect(res.json?.full_name === `${ctx.org}/${ctx.base}`,
        `full_name ${res.json?.full_name} (expected ${ctx.org}/${ctx.base} — the default-slug fork shape)`);
      ctx.forkCreated = true; // the failure-cleanup tail deletes it if a later step reds
      ctx.forkFullName = String(res.json?.full_name ?? `${ctx.org}/${ctx.base}`);
      return `202 — fork ${res.json?.full_name} accepted (async copy)`;
    },
  },
  {
    id: "forkpr-fork-settle",
    expect: `the fork's refs appear via authenticated ls-remote (settle-polled, budget ${FORK_SETTLE_MS / 1000}s — the async copy)`,
    run: async () => {
      const done = await poll(FORK_SETTLE_MS, async () => {
        const r = await lsRemote(gitUrl(ctx.org, ctx.base), { auth: true });
        return r.ok && r.refs.has("refs/heads/main") ? r : null;
      });
      expect(done !== null, `the fork never listed refs/heads/main within ${FORK_SETTLE_MS} ms`);
      return `fork advertises ${[...done.refs.keys()].filter((r) => r !== "HEAD").join(", ")}`;
    },
  },
  {
    id: "forkpr-fork-push",
    expect: `push a branch ${ctx.branch} to the FORK (clone the base, one commit, git push to the fork URL)`,
    run: async () => {
      const tmp = ctx.tmp; // main() owns the battery scratch dir (created + removed there)
      const work = path.join(tmp, "work");
      let r = await git(["clone", gitUrl(ctx.user, ctx.base), "work"], tmp, { auth: true });
      expect(r.ok, `clone base failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
      r = await git(["checkout", "-b", ctx.branch], work);
      expect(r.ok, `checkout -b failed: ${r.stderr.trim()}`);
      await writeFile(path.join(work, "fork-pr.txt"), `deploy-probes forkpr-e2e ${ctx.branch}\n`);
      r = await git(["add", "-A"], work);
      expect(r.ok, `git add failed: ${r.stderr.trim()}`);
      r = await git(["-c", "user.name=cf-gitea-probes", "-c", "user.email=probes@cf-gitea.invalid",
        "commit", "-m", "deploy-probes: fork PR head"], work);
      expect(r.ok, `git commit failed: ${r.stderr.trim()}`);
      r = await git(["push", gitUrl(ctx.org, ctx.base), `HEAD:refs/heads/${ctx.branch}`], work, { auth: true });
      expect(r.ok, `push to fork failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      const lr = await lsRemote(gitUrl(ctx.org, ctx.base), { auth: true });
      expect(lr.ok && lr.refs.has(`refs/heads/${ctx.branch}`), `fork ls-remote missing ${ctx.branch}`);
      ctx.tip = lr.refs.get(`refs/heads/${ctx.branch}`);
      return `fork branch ${ctx.branch} at ${ctx.tip.slice(0, 10)}…`;
    },
  },
  {
    id: "forkpr-create-201",
    expect: `POST /repos/${ctx.user}/${ctx.base}/pulls {"head":"${ctx.org}:${ctx.branch}","base":"main"} → 201 (the cross-repo owner:branch fork-edge grammar — upstream's default form, the head branch read runs in the FORK cell)`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.base}/pulls`, {
        method: "POST",
        body: { title: `deploy-probes fork-PR chain ${ctx.branch}`, head: `${ctx.org}:${ctx.branch}`, base: "main" },
      });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 200)}`);
      expect(Number.isInteger(res.json?.number) && res.json.number > 0, `no PR number in the body: ${res.text.slice(0, 120)}`);
      ctx.number = res.json.number;
      return `PR #${ctx.number} created from head ${ctx.org}:${ctx.branch}`;
    },
  },
  {
    id: "forkpr-head-chain",
    expect: `GET the PR (settle-polled until mergeable leaves null, budget 15s) → head.label = "${ctx.branch}", head.sha = the fork tip, head.repo.full_name = ${ctx.org}/${ctx.base}, base = main`,
    run: async () => {
      const pr = await poll(15_000, async () => {
        const res = await api(`/repos/${ctx.user}/${ctx.base}/pulls/${ctx.number}`);
        return res.status === 200 && res.json?.mergeable !== null && res.json?.mergeable !== undefined ? res.json : null;
      });
      expect(pr !== null, `the PR never resolved with a non-null mergeable within 15 s`);
      expect(pr.head?.label === ctx.branch, `head.label ${pr.head?.label} (expected ${ctx.branch})`);
      expect(pr.head?.sha === ctx.tip, `head.sha ${pr.head?.sha} != the fork tip ${ctx.tip}`);
      expect(pr.head?.repo?.full_name === `${ctx.org}/${ctx.base}`,
        `head.repo.full_name ${pr.head?.repo?.full_name} (expected ${ctx.org}/${ctx.base})`);
      expect(pr.base?.label === "main", `base.label ${pr.base?.label} (expected main)`);
      expect(typeof pr.mergeable === "boolean", `mergeable ${pr.mergeable} (expected a boolean — never a stuck null)`);
      return `head chain ok: ${pr.head?.repo?.full_name}#${pr.head?.label}@${pr.head?.sha?.slice(0, 10)}… → base main (mergeable ${pr.mergeable}, head.ref ${pr.head?.ref})`;
    },
  },
  {
    id: "forkpr-cleanup",
    expect: `fork + base DELETEd (204 each) and the org DELETEd (204) — a failed cleanup is documented, not fatal`,
    run: async () => {
      const a = await deleteRepo(ctx.org, ctx.base);
      if (typeof a === "string") ctx.forkGone = true; // the tail no-ops on a green sweep
      const b = await deleteRepo(ctx.user, ctx.base);
      if (typeof b === "string") ctx.baseGone = true;
      const org = await api(`/orgs/${ctx.org}`, { method: "DELETE" });
      let orgOut;
      if (org.status === 204) {
        ctx.orgGone = true;
        orgOut = `org ${ctx.org} deleted`;
      } else {
        leftBehind.push(`org ${ctx.org} (DELETE returned ${org.status})`);
        orgOut = { status: "warn", detail: `org ${ctx.org} LEFT BEHIND — DELETE returned ${org.status}` };
      }
      await rm(ctx.tmp, { recursive: true, force: true });
      const parts = [a, b, orgOut];
      if (parts.every((p) => typeof p === "string")) return parts.join("; ");
      return { status: "warn", detail: parts.map((p) => (typeof p === "string" ? p : p.detail)).join("; ") };
    },
  },
];

/** The red-runs-self-sweep posture (the generate-e2e shape): a red forkpr run
 *  sweeps its own base/org/fork instead of leaving them for a hand-clean.
 *  This finally-style tail runs after EVERY forkpr battery run (green ones
 *  no-op silently: forkpr-cleanup already deleted all three, so the *Gone
 *  flags skip them) and best-effort deletes exactly what the run created and
 *  has not already deleted — fork first (it hangs off the base and lives in
 *  the org), then the base, then the org (an org delete over surviving repos
 *  would strand all three). One [tail] line logs every action; failures feed
 *  left_behind and are never fatal; it never throws (main's finally depends
 *  on it). */
const forkprFailureCleanup = async (ctx) => {
  const acts = [];
  const noteLeftBehind = (what, why) => {
    leftBehind.push(`${what} (failure-cleanup tail: ${why})`);
    acts.push(`${what} LEFT BEHIND — ${why}`);
  };
  const tryDeleteRepo = async (what, full, fallback) => {
    const [owner, repo] = String(full ?? fallback).split("/");
    try {
      const out = await deleteRepo(owner, repo);
      acts.push(typeof out === "string" ? out : out.detail);
    } catch (err) {
      noteLeftBehind(`${what} ${owner}/${repo}`, `DELETE threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  try {
    if (ctx.forkCreated === true && ctx.forkGone !== true) {
      await tryDeleteRepo("fork", ctx.forkFullName, `${ctx.org}/${ctx.base}`);
    }
    if (ctx.baseCreated === true && ctx.baseGone !== true) {
      await tryDeleteRepo("base repo", ctx.baseFullName, `${ctx.user}/${ctx.base}`);
    }
    if (ctx.orgCreated === true && ctx.orgGone !== true) {
      try {
        const res = await api(`/orgs/${ctx.org}`, { method: "DELETE" });
        if (res.status === 204) acts.push(`org ${ctx.org} deleted (204)`);
        else noteLeftBehind(`org ${ctx.org}`, `DELETE returned ${res.status}`);
      } catch (err) {
        noteLeftBehind(`org ${ctx.org}`, `DELETE threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    acts.push(`the sweep itself failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (acts.length) log(`  [tail] forkpr-leftover-sweep (best-effort failure cleanup) — ${scrub(acts.join("; "))}`);
};

// ---------- battery: mirror (push-mirror credential-free arms) ----------

/** REDEPLOY13's exact loopback probe target (docs/design/p0-evidence.md
 *  ~1600-1610): HTTPS is required to reach the egress gate at all (a plain
 *  http:// URL lands in the 400 "Invalid mirror protocol" bucket first), and
 *  port 9 stays refused under BOTH postures — the production lax default and
 *  local dev's explicit `127.0.0.1:8443` allow entry. */
const MIRROR_LOOPBACK_TARGET = "https://127.0.0.1:9/dummy-unreachable.git";

/** The gate-passing unreachable dummy host, random per run (the hygiene
 *  convention; the RFC 2606 `.invalid` TLD never resolves — no credentials,
 *  no real egress). */
const mirrorInvalidTarget = () => `https://pmir-${hexId()}.invalid/dummy-unreachable.git`;

/** `repoCreated`/`repoGone`/`repoFullName` drive the failure-cleanup tail (see
 *  mirrorFailureCleanup): REDEPLOY15 friction (c) — a mid-battery red used to
 *  strand the mirror row + repo behind [skip] lines for a hand-clean.
 *  repoFullName is what the CREATE actually returned (the doer's namespace),
 *  so the tail deletes the right owner/slug even when --user drifts from the
 *  PAT's user. */
const mirrorContext = () => ({ user: opts.user, repo: `pmir-${hexId()}`, remoteName: null, remoteAddress: null, repoCreated: false, repoGone: false, repoFullName: null, tmp: null });

const mirrorSteps = (ctx) => [
  {
    id: "mir-create-repo-201",
    expect: `POST /api/v1/user/repos {"name":"${ctx.repo}","auto_init":true} → 201 (the mirror source — one auto_init commit to push)`,
    run: async () => {
      const res = await api("/user/repos", { method: "POST", body: { name: ctx.repo, private: true, auto_init: true } });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 120)}`);
      ctx.repoCreated = true; // the failure-cleanup tail deletes it if a later step reds
      ctx.repoFullName = String(res.json?.full_name ?? `${ctx.user}/${ctx.repo}`);
      return `created ${res.json?.full_name} (private, auto_init)`;
    },
  },
  {
    id: "mir-ssrf-loopback-refused",
    expect: `ARM 1 — SSRF egress gate AT REGISTRATION: POST …/push_mirrors {"remote_address":"${MIRROR_LOOPBACK_TARGET}","interval":"8h"} → 401 "Permission denied" (the REDEPLOY13 refusal verbatim — the egress screen refusing the loopback target at the door; lax/strict MIRROR_ALLOWED_HOST_LIST) and the list stays empty (nothing written)`,
    run: async () => {
      // Settle-polled (SETTLE_MS): the create finalizes in waitUntil after
      // the 201 (the §2.5.2 window), so the FIRST registration attempt can
      // still 404 on requireVisibleRepo — poll the 404 arm out, then hold
      // the 401 line (a 200 here would mean the SSRF gate is OPEN).
      const res = await poll(SETTLE_MS, async () => {
        const r = await api(`/repos/${ctx.user}/${ctx.repo}/push_mirrors`, {
          method: "POST",
          body: { remote_address: MIRROR_LOOPBACK_TARGET, interval: "8h" },
        });
        return r.status === 404 ? null : r;
      });
      expect(res !== null, `the probe repo never became visible within ${SETTLE_MS} ms (every registration attempt 404'd)`);
      expect(res.status === 401, `status ${res.status} (expected 401 — a 200 here means the SSRF gate is OPEN): ${res.text.slice(0, 160)}`);
      expect(res.json?.message === "Permission denied", `message ${JSON.stringify(res.json?.message)} (expected "Permission denied")`);
      const list = await api(`/repos/${ctx.user}/${ctx.repo}/push_mirrors`);
      expect(Array.isArray(list.json) && list.json.length === 0,
        `list after the refusal: ${list.text.slice(0, 120)} (expected [] — the refusal wrote nothing)`);
      return `401 "Permission denied" — the loopback target refused at the door; list still empty`;
    },
  },
  {
    id: "mir-create-200",
    expect: `ARM 2 — the gate-passing unreachable target: POST …/push_mirrors {"remote_address":"<pmir-*.invalid>/dummy-unreachable.git","interval":"8h"} → 200 with the fresh-row wire: last_error "", last_update null, interval "8h0m0s", sync_on_commit false, remote_name remote_mirror_<10 alnum>`,
    run: async () => {
      ctx.remoteAddress = mirrorInvalidTarget();
      const res = await api(`/repos/${ctx.user}/${ctx.repo}/push_mirrors`, {
        method: "POST",
        body: { remote_address: ctx.remoteAddress, interval: "8h" },
      });
      expect(res.status === 200, `status ${res.status} (expected 200): ${res.text.slice(0, 200)}`);
      ctx.remoteName = String(res.json?.remote_name ?? "");
      expect(/^remote_mirror_[A-Za-z0-9]{10}$/.test(ctx.remoteName), `remote_name ${ctx.remoteName} (expected remote_mirror_<10 alnum>)`);
      expect(res.json?.last_error === "", `last_error ${JSON.stringify(res.json?.last_error)} (expected "" on the fresh row)`);
      expect(res.json?.last_update === null, `last_update ${res.json?.last_update} (expected null until the first sync)`);
      expect(res.json?.interval === "8h0m0s", `interval ${res.json?.interval} (expected "8h0m0s")`);
      expect(res.json?.sync_on_commit === false, `sync_on_commit ${res.json?.sync_on_commit} (expected false)`);
      expect(res.json?.remote_address === ctx.remoteAddress, `remote_address ${res.json?.remote_address} != the registered target`);
      return `200 — ${ctx.remoteName} → ${ctx.remoteAddress} (fresh-row wire)`;
    },
  },
  {
    id: "mir-sync-trigger-200",
    expect: `POST …/push_mirrors-sync → 200 (the enqueue; the outbound push runs on the MIRROR_SYNC_QUEUE consumer)`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.repo}/push_mirrors-sync`, { method: "POST" });
      expect(res.status === 200, `status ${res.status} (expected 200): ${res.text.slice(0, 160)}`);
      return "200 — sync enqueued";
    },
  },
  {
    id: "mir-sync-settle",
    expect: `poll GET …/push_mirrors/${"{name}"} (budget ${MIRROR_SETTLE_MS / 1000}s) until the failed sync settles: last_error NON-EMPTY and naming the target advertisement URL — canonical production text "mirror target responded 530 for info/refs advertisement [<addr>/info/refs?service=git-receive-pack]" (REDEPLOY13 verbatim; local dev's fetch failure reads "request failed" with the same bracketed URL)`,
    run: async () => {
      const row = await poll(MIRROR_SETTLE_MS, async () => {
        const res = await api(`/repos/${ctx.user}/${ctx.repo}/push_mirrors/${ctx.remoteName}`);
        if (res.status !== 200) throw new Error(`GET push_mirrors/${ctx.remoteName} status ${res.status} (expected 200)`);
        return res.json?.last_error ? res.json : null;
      });
      expect(row !== null, `last_error never went non-empty within ${MIRROR_SETTLE_MS} ms (the consumer never attempted the .invalid sync)`);
      const errText = String(row.last_error);
      expect(errText.includes("mirror target") && errText.includes("info/refs advertisement"),
        `last_error does not name the info/refs advertisement attempt: ${errText.slice(0, 200)}`);
      expect(errText.includes(`[${ctx.remoteAddress}/info/refs?service=git-receive-pack]`),
        `last_error does not name the target advertisement URL: ${errText.slice(0, 200)}`);
      const verbatim = errText.includes("mirror target responded 530 for info/refs advertisement");
      // The failure settle (settlePushMirrorFailure) writes last_error and
      // sync_state='idle' in the SAME update — observing last_error via the
      // API already proves the row is out of 'syncing'; the next check reads
      // the row directly.
      return `last_error names the target${verbatim ? " — the REDEPLOY13 verbatim 530 shape" : " (local fetch-failure shape; production records 'responded 530')"}: ${errText.slice(0, 140)}`;
    },
  },
  {
    id: "mir-row-settled",
    expect: `the mirror ROW settled clean (wrangler d1 execute, --${opts.d1Scope}): sync_state='idle' (back from syncing, no stuck state), next_sync_at=0 (the failure left the fresh row unscheduled)`,
    run: async () => {
      const row = await d1Row(`SELECT sync_state, next_sync_at FROM push_mirrors WHERE remote_name = '${ctx.remoteName}'`);
      expect(row.sync_state === "idle", `sync_state ${JSON.stringify(row.sync_state)} (expected 'idle' — no stuck state)`);
      expect(Number(row.next_sync_at) === 0, `next_sync_at ${row.next_sync_at} (expected 0 — the failure left it unscheduled)`);
      return `sync_state='idle', next_sync_at=0 (--${opts.d1Scope})`;
    },
  },
  {
    id: "mir-delete-204",
    expect: `DELETE …/push_mirrors/${"{name}"} → 204 and the very next GET …/push_mirrors → [] (the row and its sealed credentials are gone; the audit battery's push_mirrors==0 expectation stays true)`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.repo}/push_mirrors/${ctx.remoteName}`, { method: "DELETE" });
      expect(res.status === 204, `status ${res.status} (expected 204)`);
      const list = await api(`/repos/${ctx.user}/${ctx.repo}/push_mirrors`);
      expect(Array.isArray(list.json) && list.json.length === 0,
        `list after the delete: ${list.text.slice(0, 120)} (expected [])`);
      return "204 — the row (and its sealed credentials) is gone; list back to []";
    },
  },
  {
    id: "mir-cleanup",
    expect: `probe repo DELETEd → 204 (a failed cleanup is documented, not fatal; the failure-cleanup tail re-sweeps anything left)`,
    run: async () => {
      const out = await deleteRepo(ctx.user, ctx.repo);
      if (typeof out === "string") ctx.repoGone = true; // the tail no-ops on a green sweep
      await rm(ctx.tmp, { recursive: true, force: true });
      if (typeof out === "string") return out;
      return { status: "warn", detail: out.detail };
    },
  },
];

/** REDEPLOY15 friction (c): a mid-battery red (e.g. mir-sync-settle timing
 *  out) used to chain-skip the delete/cleanup arms and strand the mirror row
 *  AND repo behind [skip] lines — the row then breaks the audit battery's
 *  push_mirrors==0 until a hand-clean. This finally-style tail runs after
 *  EVERY mirror battery run (green ones no-op silently: the battery's own
 *  delete arms emptied the list and removed the repo) and best-effort deletes
 *  exactly what the run created and has not already deleted. Every action is
 *  logged on one [tail] line; failures feed left_behind and are never fatal;
 *  it never throws (main's finally depends on it). */
const mirrorFailureCleanup = async (ctx) => {
  const acts = [];
  const noteLeftBehind = (what, why) => {
    leftBehind.push(`${what} (failure-cleanup tail: ${why})`);
    acts.push(`${what} LEFT BEHIND — ${why}`);
  };
  try {
    if (ctx.repoCreated === true) {
      const [owner, repo] = String(ctx.repoFullName ?? `${ctx.user}/${ctx.repo}`).split("/");
      // Mirror rows first: the list sweep covers the named row AND the
      // edge where the row exists but the creating check reded before
      // ctx.remoteName was captured.
      try {
        const list = await api(`/repos/${owner}/${repo}/push_mirrors`);
        const rows = Array.isArray(list.json) ? list.json : [];
        for (const row of rows) {
          const name = String(row?.remote_name ?? "");
          if (!name) continue;
          try {
            const res = await api(`/repos/${owner}/${repo}/push_mirrors/${name}`, { method: "DELETE" });
            if (res.status === 204) acts.push(`mirror row ${name} deleted (204)`);
            else noteLeftBehind(`mirror row ${name}`, `DELETE returned ${res.status}`);
          } catch (err) {
            noteLeftBehind(`mirror row ${name}`, `DELETE threw: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        noteLeftBehind(`mirror rows of ${owner}/${repo}`, `list failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (ctx.repoGone !== true) {
        try {
          const out = await deleteRepo(owner, repo);
          acts.push(typeof out === "string" ? out : out.detail);
        } catch (err) {
          noteLeftBehind(`repo ${owner}/${repo}`, `DELETE threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (err) {
    acts.push(`the sweep itself failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (acts.length) log(`  [tail] mir-leftover-sweep (best-effort failure cleanup) — ${scrub(acts.join("; "))}`);
};

// ---------- battery: ui-login ----------

/** `repoCreated`/`repoGone`/`repoFullName` drive the failure-cleanup tail
 *  (see uiFailureCleanup): the red-runs-self-sweep posture — the battery
 *  creates a fixture repo (any repo has a labels page), so a red run sweeps
 *  it. repoFullName is what the CREATE actually returned (the doer's
 *  namespace), so the tail deletes the right owner/slug even when --user
 *  drifts from the PAT's user. */
const uiContext = () => ({
  user: opts.user, repo: `ui-${hexId()}`, cookie: null, tmp: null,
  repoCreated: false, repoFullName: null, repoGone: false,
});

const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

const uiSteps = (ctx) => [
  {
    id: "ui-create-repo-201",
    expect: `POST /api/v1/user/repos {"name":"${ctx.repo}","auto_init":true} → 201 (any repo has a labels page)`,
    run: async () => {
      const res = await api("/user/repos", { method: "POST", body: { name: ctx.repo, auto_init: true } });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 120)}`);
      ctx.repoCreated = true; // the failure-cleanup tail deletes it if a later step reds
      ctx.repoFullName = String(res.json?.full_name ?? `${ctx.user}/${ctx.repo}`);
      return `created ${res.json?.full_name}`;
    },
  },
  {
    id: "ui-labels-anonymous-0",
    expect: `anonymous GET /${ctx.user}/${ctx.repo}/labels → 200 with 0 "New Label" occurrences (the anonymous render — what a PAT header measures)`,
    run: async () => {
      const res = await fetchT(`${opts.baseUrl}/${ctx.user}/${ctx.repo}/labels`);
      const body = await res.text();
      expect(res.status === 200, `status ${res.status} (expected 200)`);
      const n = countOccurrences(body, "New Label");
      expect(n === 0, `${n} "New Label" occurrences on the ANONYMOUS page (expected 0)`);
      return `200 with 0 "New Label" occurrences`;
    },
  },
  {
    id: "ui-login-303",
    expect: `POST /login (form-urlencoded user_name + password=<PAT>) → 303 + gitea_session cookie (the value is scrubbed from all output)`,
    run: async () => {
      const form = new URLSearchParams({ user_name: ctx.user, password: TOKEN });
      const res = await fetchT(`${opts.baseUrl}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      await res.text();
      expect(res.status === 303, `status ${res.status} (expected 303 See Other)`);
      const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("gitea_session="));
      expect(setCookie !== undefined, `no gitea_session cookie in Set-Cookie (got ${res.headers.getSetCookie().length} cookies)`);
      ctx.cookie = setCookie.split(";")[0];
      secrets.push(ctx.cookie.split("=")[1] ?? "");
      return `303 + gitea_session cookie`;
    },
  },
  {
    id: "ui-labels-cookie-owner",
    expect: `labels page WITH the cookie → 200 with ${opts.newLabelCount} "New Label" occurrences (canonical 3) + small-menu-items — the writer-gate owner arm renders`,
    run: async () => {
      const res = await fetchT(`${opts.baseUrl}/${ctx.user}/${ctx.repo}/labels`, { headers: { cookie: ctx.cookie } });
      const body = await res.text();
      expect(res.status === 200, `status ${res.status} (expected 200)`);
      const n = countOccurrences(body, "New Label");
      expect(n === opts.newLabelCount, `${n} "New Label" occurrences (expected ${opts.newLabelCount})`);
      expect(body.includes("small-menu-items"), "the small-menu-items nav shell is missing");
      return `200 with ${n} "New Label" occurrences + small-menu-items — the owner arm renders`;
    },
  },
  {
    id: "ui-cleanup",
    expect: `probe repo DELETEd → 204 (a failed cleanup is documented, not fatal)`,
    run: async () => {
      const out = await deleteRepo(ctx.user, ctx.repo);
      if (typeof out === "string") ctx.repoGone = true; // the tail no-ops on a green sweep
      if (typeof out === "string") return out;
      return { status: "warn", detail: out.detail };
    },
  },
];

/** The red-runs-self-sweep posture (the mirror shape): a red ui-login run
 *  sweeps its own fixture repo instead of leaving it for a hand-clean. This
 *  finally-style tail runs after EVERY ui-login battery run (green ones no-op
 *  silently: ui-cleanup already deleted the repo, so the gone flag skips it)
 *  and best-effort deletes exactly what the run created and has not already
 *  deleted. One [tail] line logs every action; failures feed left_behind and
 *  are never fatal; it never throws (main's finally depends on it). */
const uiFailureCleanup = async (ctx) => {
  const acts = [];
  const noteLeftBehind = (what, why) => {
    leftBehind.push(`${what} (failure-cleanup tail: ${why})`);
    acts.push(`${what} LEFT BEHIND — ${why}`);
  };
  try {
    if (ctx.repoCreated === true && ctx.repoGone !== true) {
      const [owner, repo] = String(ctx.repoFullName ?? `${ctx.user}/${ctx.repo}`).split("/");
      try {
        const out = await deleteRepo(owner, repo);
        acts.push(typeof out === "string" ? out : out.detail);
      } catch (err) {
        noteLeftBehind(`repo ${owner}/${repo}`, `DELETE threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    acts.push(`the sweep itself failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (acts.length) log(`  [tail] ui-leftover-sweep (best-effort failure cleanup) — ${scrub(acts.join("; "))}`);
};

// ---------- battery: window2-mounts (the window-2 user-settings tab family) ----------

/**
 * The window-2a mount (0c2b151 — the user-settings tab family, 8 modules /
 * 19 routes) plus whatever sub-windows land before the deploy: every tab arm
 * reads the mount state AT RUN TIME. A 404 from a tab path is the documented
 * not-yet-mounted degradation ([warn] — the mount window is still landing);
 * anything mounted asserts hard. The pageClass strings are the modules'
 * BaseLayout discriminators (layout_head's §2.4.1 convention — asserted as
 * the full class attribute, the shape the module tests pin). The login-cookie
 * methodology (ui-login's lesson: a PAT header never reads a UI page) rides
 * POST /login → gitea_session; the write arms send a same-origin `Origin`
 * header so they exercise §2.8's sameOriginGuard PASS arm, not its
 * absent-header tolerance.
 */
const WINDOW2_TABS = [
  { slug: "appearance", path: "/user/settings/appearance", pageClass: "user settings" },
  { slug: "security", path: "/user/settings/security", pageClass: "user settings security" },
  { slug: "actions-secrets", path: "/user/settings/actions/secrets", pageClass: "user settings actions" },
  { slug: "actions-variables", path: "/user/settings/actions/variables", pageClass: "user settings actions" },
  { slug: "hooks", path: "/user/settings/hooks", pageClass: "user settings webhooks" },
  { slug: "keys", path: "/user/settings/keys", pageClass: "user settings sshkeys" },
  { slug: "applications", path: "/user/settings/applications", pageClass: "user settings applications" },
  { slug: "organization", path: "/user/settings/organization", pageClass: "user settings organization" },
];

/** The login round-trip target an anonymous tab GET answers (the mounted
 *  shape — upstream's /user/login form lives at /login here, uiRouter's
 *  session note). */
const window2LoginTarget = (tabPath) => `/login?redirect_to=${encodeURIComponent(tabPath)}`;

/** `secretCreated`/`secretGone` (+ the row id the round-trip captures) and
 *  `orgCreated`/`orgGone` drive the failure-cleanup tail (see
 *  window2FailureCleanup): the red-runs-self-sweep posture. The secret tail
 *  sweeps BY NAME via the user API (DELETE /user/actions/secrets/<name>), so
 *  it covers the edge where a red landed before the web round-trip captured
 *  the numeric row id.
 *
 *  The secret name is minted UPPERCASE on purpose: the landed service stores
 *  normalizedName — strings.ToUpper at insert AND lookup
 *  (services/secrets-variables.ts normalizedName; upstream InsertEncryptedSecret
 *  secrets.go:31) — and the settings page renders the STORED spelling, so a
 *  lowercase-hex name (`hexId()` is lowercase) renders back as uppercase and
 *  the row-visible step's case-sensitive grep could never match it. That was
 *  RD20 bug #20's real mechanism: three "write never landed" verdicts whose
 *  rows were on the page all along (and whose failure-tail by-name API
 *  deletes returned 204 — the lookup uppercases too, so it always matched). */
const window2Context = () => ({
  user: opts.user, cookie: null,
  secretName: `W2SEC_${hexId()}`.toUpperCase(), secretDescription: `deploy-probes window2 ${hexId()}`,
  secretCreated: false, secretGone: false, secretRowId: null,
  keyTitle: `w2key-${hexId()}`,
  org: `w2org-${hexId()}`, orgCreated: false, orgGone: false,
});

/** The window-2 web write: form-urlencoded POST with the session cookie and a
 *  same-origin Origin header (§2.8). Redirects surface (fetchT), so every
 *  303's Location lands in the caller's hands. */
const window2PostForm = async (ctx, pathname, fields) => {
  const form = new URLSearchParams(fields);
  const res = await fetchT(`${opts.baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: opts.baseUrl,
      cookie: ctx.cookie,
    },
    body: form.toString(),
  });
  const body = await res.text();
  return { status: res.status, location: res.headers.get("location"), body };
};

const window2Steps = (ctx) => [
  {
    id: "w2-login-303",
    expect: `POST /login (form-urlencoded user_name + password=<PAT>) → 303 + gitea_session cookie — the ui-login methodology (a PAT header never reads a UI page; the session value is scrubbed from all output)`,
    run: async () => {
      const form = new URLSearchParams({ user_name: ctx.user, password: TOKEN });
      const res = await fetchT(`${opts.baseUrl}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      await res.text();
      expect(res.status === 303, `status ${res.status} (expected 303 See Other)`);
      const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("gitea_session="));
      expect(setCookie !== undefined, `no gitea_session cookie in Set-Cookie (got ${res.headers.getSetCookie().length} cookies)`);
      ctx.cookie = setCookie.split(";")[0];
      secrets.push(ctx.cookie.split("=")[1] ?? "");
      return "303 + gitea_session cookie";
    },
  },
  {
    id: "w2-anon-tabs-303",
    expect: `anonymous GET of each window-2 tab path → 303 onto the login round-trip, location EXACTLY /login?redirect_to=<encoded path> (mount-at-run-time: a 404 warns — not yet mounted; anything else fails)`,
    run: async () => {
      const unmounted = [];
      let ok = 0;
      for (const tab of WINDOW2_TABS) {
        const res = await fetchT(`${opts.baseUrl}${tab.path}`);
        await res.text();
        if (res.status === 404) {
          unmounted.push(tab.path);
          continue;
        }
        expect(res.status === 303, `${tab.path} status ${res.status} (expected 303 or, unmounted, 404)`);
        expect(res.headers.get("location") === window2LoginTarget(tab.path),
          `${tab.path} location ${JSON.stringify(res.headers.get("location"))} (expected ${window2LoginTarget(tab.path)})`);
        ok += 1;
      }
      if (unmounted.length > 0) {
        return { status: "warn", detail: `${ok}/${WINDOW2_TABS.length} tabs 303'd onto the login round-trip; NOT MOUNTED at run time: ${unmounted.join(", ")}` };
      }
      return `all ${WINDOW2_TABS.length} tab paths 303 → /login?redirect_to=<encoded path>`;
    },
  },
  ...WINDOW2_TABS.map((tab) => ({
    id: `w2-${tab.slug}-page-200`,
    expect: `cookie GET ${tab.path} → 200 text/html carrying the pageClass discriminator class="page-content ${tab.pageClass}" (mount-at-run-time: a 404 warns — not yet mounted)`,
    run: async () => {
      const res = await fetchT(`${opts.baseUrl}${tab.path}`, { headers: { cookie: ctx.cookie } });
      const body = await res.text();
      if (res.status === 404) {
        return { status: "warn", detail: `${tab.path} 404 — NOT MOUNTED at run time (the not-yet-mounted degradation)` };
      }
      expect(res.status === 200, `${tab.path} status ${res.status} (expected 200)`);
      expect(String(res.headers.get("content-type")).includes("text/html"),
        `${tab.path} content-type ${JSON.stringify(res.headers.get("content-type"))} (expected text/html)`);
      expect(body.includes(`class="page-content ${tab.pageClass}"`),
        `${tab.path} missing class="page-content ${tab.pageClass}" (the pageClass discriminator)`);
      return `200 text/html — class="page-content ${tab.pageClass}"`;
    },
  })),
  {
    id: "w2-secret-invalid-name-rerender",
    expect: `POST /user/settings/actions/secrets {"name":"bad-name!"} → 200 RE-RENDER (never a 303) with the exact ValidateName text in the negative banner: "name must start with a letter or underscore and contain only letters, numbers, and underscores" — no row written`,
    run: async () => {
      const r = await window2PostForm(ctx, "/user/settings/actions/secrets", { name: "bad-name!", data: "x", description: "" });
      expect(r.status === 200, `status ${r.status} (expected 200 — the invalid re-render)`);
      expect(r.body.includes("name must start with a letter or underscore and contain only letters, numbers, and underscores"),
        `the re-render does not carry the exact ValidateName text: ${r.body.slice(0, 120)}`);
      return "200 re-render with the exact ValidateName banner text";
    },
  },
  {
    id: "w2-secret-create-303",
    expect: `POST /user/settings/actions/secrets {"name":"${ctx.secretName}","data":"line1\\r\\nline2","description":"${ctx.secretDescription}"} → 303 with location EXACTLY /user/settings/actions/secrets. The data carries CRLF through the web path's EOL-normalization arm (NormalizeStringEOL, shared/secrets/secrets.go:42) — NOT observable: secret values are write-only (the row renders ******, the edit form re-renders empty, the user API is PUT/DELETE-only), so the observable assertions are the 303 target + the row's name/description`,
    run: async () => {
      const r = await window2PostForm(ctx, "/user/settings/actions/secrets", {
        name: ctx.secretName, data: "line1\r\nline2", description: ctx.secretDescription,
      });
      // Mark on the observable write (before the location assert) so a red
      // HERE still sweeps the row the server just wrote.
      if (r.status === 303) ctx.secretCreated = true;
      expect(r.status === 303, `status ${r.status} (expected 303): ${r.body.slice(0, 120)}`);
      expect(r.location === "/user/settings/actions/secrets",
        `location ${JSON.stringify(r.location)} (expected /user/settings/actions/secrets)`);
      return "303 → /user/settings/actions/secrets (CRLF data through the normalization arm)";
    },
  },
  {
    id: "w2-secret-row-visible",
    expect: `cookie GET /user/settings/actions/secrets → 200 with the row (the name + its description) and the delete form's hidden id captured (name="id" value="N" after the row name)`,
    run: async () => {
      // The grep normalizes case on BOTH sides: the service stores the name
      // UPPERCASED (normalizedName — the window2Context note) and the page
      // renders the stored spelling. RD20's 20s "D1 settle" retries below
      // were chasing the WRONG mechanism — a case-sensitive lowercase grep
      // (bug #20's misdiagnosis: the rows were on the page the whole time;
      // read replication is disabled on this database, so a stale read was
      // never possible). The retry budget stays as cheap robustness only.
      // Cache-buster query: a fresh cache key per poll — request no-cache
      // is Enterprise-only on Cloudflare's edge, so a stale heuristic
      // entry for the bare URL can still be served on this plan.
      let res = null;
      let body = "";
      let nameAt = -1;
      const nameNeedle = ctx.secretName.toUpperCase();
      for (let attempt = 0; attempt < 20 && nameAt === -1; attempt++) {
        if (attempt > 0) await sleep(1000);
        res = await fetchT(`${opts.baseUrl}/user/settings/actions/secrets?_cb=${Date.now()}_${attempt}`, { headers: { cookie: ctx.cookie } });
        body = await res.text();
        nameAt = body.toUpperCase().indexOf(nameNeedle);
      }
      expect(res.status === 200, `status ${res.status} (expected 200)`);
      expect(nameAt !== -1,
        `the created secret ${ctx.secretName} is not on the page (after a 20s settle budget) — if the [tail] sweep then logs "deleted (204)", the row EXISTS and this is a read/name-shape mismatch, not a write drop`);
      expect(body.includes(ctx.secretDescription), `the description ${ctx.secretDescription} is not on the page`);
      const m = /name="id" value="(\d+)"/.exec(body.slice(nameAt));
      expect(m !== null, "no delete-form hidden id found after the row name");
      ctx.secretRowId = m[1];
      return `row present (name + description); delete-form id ${ctx.secretRowId}`;
    },
  },
  {
    id: "w2-secret-delete-303",
    expect: `POST /user/settings/actions/secrets/delete {"id":${ctx.secretRowId ?? "<captured>"}} → 303 with location EXACTLY /user/settings/actions/secrets`,
    run: async () => {
      const r = await window2PostForm(ctx, "/user/settings/actions/secrets/delete", { id: ctx.secretRowId });
      // Same mark-on-the-write convention as the create arm.
      if (r.status === 303) ctx.secretGone = true;
      expect(r.status === 303, `status ${r.status} (expected 303): ${r.body.slice(0, 120)}`);
      expect(r.location === "/user/settings/actions/secrets",
        `location ${JSON.stringify(r.location)} (expected /user/settings/actions/secrets)`);
      return "303 → /user/settings/actions/secrets";
    },
  },
  {
    id: "w2-secret-gone",
    expect: `cookie GET /user/settings/actions/secrets → the secret ${ctx.secretName} is GONE`,
    run: async () => {
      const res = await fetchT(`${opts.baseUrl}/user/settings/actions/secrets`, { headers: { cookie: ctx.cookie } });
      const body = await res.text();
      expect(res.status === 200, `status ${res.status} (expected 200)`);
      expect(!body.includes(ctx.secretName), `the secret ${ctx.secretName} still renders after the delete`);
      return `gone — ${ctx.secretName} absent`;
    },
  },
  {
    id: "w2-secret-delete-idempotent-303",
    expect: `re-POST /user/settings/actions/secrets/delete with the SAME id (the missing arm — a stale/foreign/absent id) → STILL 303 onto /user/settings/actions/secrets (upstream's every-arm-303s fidelity)`,
    run: async () => {
      const r = await window2PostForm(ctx, "/user/settings/actions/secrets/delete", { id: ctx.secretRowId });
      expect(r.status === 303, `status ${r.status} (expected 303 on the missing arm): ${r.body.slice(0, 120)}`);
      expect(r.location === "/user/settings/actions/secrets",
        `location ${JSON.stringify(r.location)} (expected /user/settings/actions/secrets)`);
      return "303 on the missing arm — the delete is idempotent";
    },
  },
  {
    id: "w2-key-invalid-content-rerender",
    expect: `POST /user/settings/keys {"type":"ssh","title":"${ctx.keyTitle}","content":"not-a-key"} → 200 RE-RENDER (never a 303) with the exact 422 text "Cannot verify your SSH key: invalid key format: illegal base64 data" (form.invalid_ssh_key %s + the parse detail) and the keys pageClass — no row written`,
    run: async () => {
      const r = await window2PostForm(ctx, "/user/settings/keys", { type: "ssh", title: ctx.keyTitle, content: "not-a-key", signature: "" });
      expect(r.status === 200, `status ${r.status} (expected 200 — the AddKeyOutcome re-render)`);
      expect(r.body.includes("Cannot verify your SSH key: invalid key format: illegal base64 data"),
        `the re-render does not carry the exact invalid-content 422 text`);
      expect(r.body.includes(`class="page-content user settings sshkeys"`),
        "the re-render lost the keys pageClass discriminator");
      return "200 re-render with the exact 422 text";
    },
  },
  {
    id: "w2-key-no-row",
    expect: `fresh cookie GET /user/settings/keys → the title ${ctx.keyTitle} is ABSENT (the invalid add created no row)`,
    run: async () => {
      const res = await fetchT(`${opts.baseUrl}/user/settings/keys`, { headers: { cookie: ctx.cookie } });
      const body = await res.text();
      expect(res.status === 200, `status ${res.status} (expected 200)`);
      expect(!body.includes(ctx.keyTitle), `the title ${ctx.keyTitle} renders on a fresh keys page — a row WAS created`);
      return `no row — ${ctx.keyTitle} absent`;
    },
  },
  {
    id: "w2-org-create-201",
    expect: `POST /api/v1/orgs {"username":"${ctx.org}"} → 201 (the forkpr-e2e pattern — the doer-owned org; the PAT user is its SOLE owner, the last-owner arm's precondition)`,
    run: async () => {
      const res = await api("/orgs", { method: "POST", body: { username: ctx.org } });
      // Mark on the observable write (before the asserts) so a red HERE still
      // sweeps the org the server just wrote.
      if (res.status === 201) ctx.orgCreated = true;
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 120)}`);
      return `org ${ctx.org} created (the PAT user is the sole owner)`;
    },
  },
  {
    id: "w2-org-leave-last-owner-303",
    expect: `POST /user/settings/organization/leave {"uid":"0","org":"${ctx.org}"} → 303 with location EXACTLY /user/settings/organization?error=last-owner (the §4.3 last-owner guard; the form's uid is accepted-and-ignored)`,
    run: async () => {
      const r = await window2PostForm(ctx, "/user/settings/organization/leave", { uid: "0", org: ctx.org });
      expect(r.status === 303, `status ${r.status} (expected 303): ${r.body.slice(0, 120)}`);
      expect(r.location === "/user/settings/organization?error=last-owner",
        `location ${JSON.stringify(r.location)} (expected /user/settings/organization?error=last-owner — a "/" here would mean the leave WENT THROUGH and took the sole owner out)`);
      return "303 → /user/settings/organization?error=last-owner (the leave refused)";
    },
  },
  {
    id: "w2-org-last-owner-flash",
    expect: `cookie GET /user/settings/organization?error=last-owner → 200 with the flash banner (ui negative message) rendering the form.last_org_owner text — asserted on the un-escaped tail ("must be at least one owner for an organization.") because renderToString HTML-escapes the locale's apostrophes`,
    run: async () => {
      const res = await fetchT(`${opts.baseUrl}/user/settings/organization?error=last-owner`, { headers: { cookie: ctx.cookie } });
      const body = await res.text();
      expect(res.status === 200, `status ${res.status} (expected 200)`);
      expect(body.includes(`class="ui negative message"`), "the ui negative message banner is missing");
      expect(body.includes("must be at least one owner for an organization."),
        `the flash does not carry the form.last_org_owner text`);
      return `200 — the last-owner flash banner renders`;
    },
  },
  {
    id: "w2-org-cleanup-204",
    expect: `DELETE /api/v1/orgs/${ctx.org} → 204 (a failed cleanup is documented, not fatal; the failure-cleanup tail re-sweeps)`,
    run: async () => {
      const res = await api(`/orgs/${ctx.org}`, { method: "DELETE" });
      if (res.status === 204) ctx.orgGone = true; // the tail no-ops on a green sweep
      if (res.status === 204) return `org ${ctx.org} deleted`;
      return { status: "warn", detail: `org ${ctx.org} LEFT BEHIND — DELETE returned ${res.status}` };
    },
  },
];

/** The red-runs-self-sweep posture (the generate-e2e shape): a red window2
 *  run sweeps its own secret + org instead of leaving them for a hand-clean.
 *  This finally-style tail runs after EVERY window2-mounts battery run (green
 *  ones no-op silently: the round-trip already deleted the secret and
 *  w2-org-cleanup-204 the org, so the gone flags skip them) and best-effort
 *  deletes exactly what the run created and has not already deleted — the
 *  secret BY NAME via the user API (DELETE /user/actions/secrets/<name>), so
 *  it covers the edge where the red landed before the web round-trip captured
 *  the numeric row id, then the org (an org delete over nothing is harmless;
 *  a surviving org would keep the audit's shapes honest anyway — orgs are not
 *  audited — but the sweep leaves nothing regardless). One [tail] line logs
 *  every action; failures feed left_behind and are never fatal; it never
 *  throws (main's finally depends on it). */
const window2FailureCleanup = async (ctx) => {
  const acts = [];
  const noteLeftBehind = (what, why) => {
    leftBehind.push(`${what} (failure-cleanup tail: ${why})`);
    acts.push(`${what} LEFT BEHIND — ${why}`);
  };
  try {
    if (ctx.secretCreated === true && ctx.secretGone !== true) {
      try {
        const res = await api(`/user/actions/secrets/${ctx.secretName}`, { method: "DELETE" });
        if (res.status === 204) acts.push(`secret ${ctx.secretName} deleted (204)`);
        else if (res.status === 404) acts.push(`secret ${ctx.secretName} already absent (404)`);
        else noteLeftBehind(`secret ${ctx.secretName}`, `DELETE returned ${res.status}`);
      } catch (err) {
        noteLeftBehind(`secret ${ctx.secretName}`, `DELETE threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (ctx.orgCreated === true && ctx.orgGone !== true) {
      try {
        const res = await api(`/orgs/${ctx.org}`, { method: "DELETE" });
        if (res.status === 204) acts.push(`org ${ctx.org} deleted (204)`);
        else noteLeftBehind(`org ${ctx.org}`, `DELETE returned ${res.status}`);
      } catch (err) {
        noteLeftBehind(`org ${ctx.org}`, `DELETE threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    acts.push(`the sweep itself failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (acts.length) log(`  [tail] w2-leftover-sweep (best-effort failure cleanup) — ${scrub(acts.join("; "))}`);
};

// ---------- battery: window3-mounts (the window-3 UI mount family) ----------

/**
 * The window-3 mount sweep (the RD20 wrap battery — ~12 committed-unmounted
 * UI surfaces in one index.ts window): the releases/tags feed tails
 * (`releases.rss|.atom` + `tags.rss|.atom`), the wiki raw byte arm
 * (`/wiki/raw/*`), the profile stars/watching/followers/following tabs (the
 * already-mounted ?tab=activity arm rides along), the /-/admin
 * users/orgs/repos lists, the user-settings account/notifications tabs, the
 * milestone list→detail round-trip, and the issue content-history list tail.
 *
 * Like window2-mounts, every surface reads the mount state AT RUN TIME: a
 * 404 from a not-yet-mounted path is the documented degradation ([warn] —
 * the mount window is still landing / the deploy lags HEAD), for the profile
 * tabs a 200 that is still the inert repositories view warns the same way
 * (their pre-dispatch answer is a 200, not a 404), and for the wiki raw arm
 * the LANDED page family's own answers warn (a 200 text/html start page
 * pre-create, a 303 onto ?action=_pages post-create — the RD20 live smoke's
 * discovery); anything mounted asserts hard. The login-cookie methodology
 * (ui-login's lesson: a PAT header never reads a UI page) rides POST /login
 * → gitea_session; the wiki write arm sends a same-origin `Origin` header so
 * it exercises §2.8's sameOriginGuard PASS arm.
 *
 * Fixtures: ONE public auto_init probe repo (the feeds' non-empty gate, the
 * wiki page, the issue, the milestone) + ONE empty public repo (the feeds'
 * MustBeNotEmpty 404 arm). A green run deletes both repos — the
 * issue/milestone/wiki-page rows cascade with the repo delete (services
 * deleteRepository's batch) and the wiki cell follows the repo's engine
 * cleanup — so the battery leaves NO D1 residue and cleanup-audit needs no
 * new expectations. A red run sweeps both repos (the failureTail).
 */

/** The wiki page content pushed through the LANDED web writer
 *  (POST …/wiki?action=_new) for the raw arm to serve. */
const W3_WIKI_HOME_TEXT = "# window3 wiki raw probe\n";

/** The profile follow tabs' container (user_cards.tmpl:2's verbatim div). */
const W3_USER_CARDS = `class="user-cards" id="user-cards-container" data-fetch-trigger="fetch-reload"`;

const window3Context = () => ({
  user: opts.user, cookie: null,
  repo: `w3-${hexId()}`, emptyRepo: `w3e-${hexId()}`,
  issueNumber: null, milestoneId: null, milestoneTitle: `w3m-${hexId()}`,
  wikiEtag: null,
  repoCreated: false, repoFullName: null, repoGone: false,
  emptyCreated: false, emptyFullName: null, emptyGone: false,
});

/** The mount-at-run-time GET: a 404 from a not-yet-mounted path returns null
 *  (the caller renders the documented [warn]); anything else hands the
 *  response + body to the caller's hard asserts. */
const window3GetOrWarn = async (url, { cookie, headers } = {}) => {
  const res = await fetchT(url, { headers: { ...(cookie ? { cookie } : {}), ...(headers ?? {}) } });
  const body = await res.text();
  if (res.status === 404) return null;
  return { res, body };
};

/** The wiki-raw probe (mount-at-run-time): the LANDED wiki PAGE family still
 *  claims the raw tails until the window mounts, and its answers here are a
 *  200 text/html (the no-wiki start page, pre-create) or a 303 onto
 *  …/wiki/?action=_pages (the page-miss redirect, post-create) — those two
 *  shapes are the documented not-yet-mounted degradation ([warn]; RD20 live
 *  smoke 2026-10-27 caught the 200 arm: the naive "expect 404" failed
 *  against the standing page family). Anything else — the 404 shells, the
 *  mounted arm's 200/304 — hands through to the caller's hard asserts. */
const window3WikiRawProbe = async (ctx, tail, extraHeaders) => {
  const res = await fetchT(`${opts.baseUrl}/${ctx.user}/${ctx.repo}/wiki/raw/${tail}`,
    { headers: { ...(ctx.cookie ? { cookie: ctx.cookie } : {}), ...(extraHeaders ?? {}) } });
  const body = await res.text();
  const contentType = String(res.headers.get("content-type") ?? "");
  if (res.status === 303 && String(res.headers.get("location") ?? "").includes("action=_pages")) {
    return { degraded: true, detail: `303 → ${JSON.stringify(res.headers.get("location"))} (the page family's page-miss redirect)` };
  }
  if (res.status === 200 && contentType.includes("text/html")) {
    return { degraded: true, detail: "200 text/html (the page family's no-wiki start page)" };
  }
  return { degraded: false, res, body };
};

/** One profile-tab probe (mount-at-run-time): a 404 warns (not mounted); a
 *  200 missing the tab's mounted markers is the inert pre-dispatch
 *  repositories view → warn; the full marker set → pass. Any other status
 *  throws (mounted-but-wrong fails hard). */
const window3ProfileTab = async (ctx, tab, markers) => {
  const res = await fetchT(`${opts.baseUrl}/${ctx.user}?tab=${tab}`, { headers: { cookie: ctx.cookie } });
  const body = await res.text();
  const label = `/${ctx.user}?tab=${tab}`;
  if (res.status === 404) {
    return { ok: false, text: `${label} 404 — NOT MOUNTED at run time (the not-yet-mounted degradation)` };
  }
  expect(res.status === 200, `${label} status ${res.status} (expected 200)`);
  const missing = markers.filter((m) => !body.includes(m));
  if (missing.length > 0) {
    return { ok: false, text: `${label} rendered WITHOUT ${missing.length}/${markers.length} mounted markers — the tab did not dispatch (the inert repositories view rendered)` };
  }
  return { ok: true, text: `${label} 200 — all ${markers.length} mounted markers` };
};

const window3Steps = (ctx) => [
  {
    id: "w3-login-303",
    expect: `POST /login (form-urlencoded user_name + password=<PAT>) → 303 + gitea_session cookie — the ui-login methodology (a PAT header never reads a UI page; the session value is scrubbed from all output)`,
    run: async () => {
      const form = new URLSearchParams({ user_name: ctx.user, password: TOKEN });
      const res = await fetchT(`${opts.baseUrl}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      await res.text();
      expect(res.status === 303, `status ${res.status} (expected 303 See Other)`);
      const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("gitea_session="));
      expect(setCookie !== undefined, `no gitea_session cookie in Set-Cookie (got ${res.headers.getSetCookie().length} cookies)`);
      ctx.cookie = setCookie.split(";")[0];
      secrets.push(ctx.cookie.split("=")[1] ?? "");
      return "303 + gitea_session cookie";
    },
  },
  {
    id: "w3-create-repo-201",
    expect: `POST /api/v1/user/repos {"name":"${ctx.repo}","private":false,"auto_init":true} → 201 (public — the feeds are anonymous-capable; auto_init — the feed groups' MustBeNotEmpty gate needs a non-empty repo)`,
    run: async () => {
      const res = await api("/user/repos", { method: "POST", body: { name: ctx.repo, private: false, auto_init: true } });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 120)}`);
      ctx.repoCreated = true; // the failure-cleanup tail deletes it if a later step reds
      ctx.repoFullName = String(res.json?.full_name ?? `${ctx.user}/${ctx.repo}`);
      return `created ${res.json?.full_name} (public, auto_init)`;
    },
  },
  {
    id: "w3-create-empty-repo-201",
    expect: `POST /api/v1/user/repos {"name":"${ctx.emptyRepo}","private":false,"auto_init":false} → 201 (the EMPTY repo — the feed groups' MustBeNotEmpty 404 arm)`,
    run: async () => {
      const res = await api("/user/repos", { method: "POST", body: { name: ctx.emptyRepo, private: false, auto_init: false } });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 120)}`);
      ctx.emptyCreated = true; // the failure-cleanup tail deletes it if a later step reds
      ctx.emptyFullName = String(res.json?.full_name ?? `${ctx.user}/${ctx.emptyRepo}`);
      return `created ${res.json?.full_name} (public, empty)`;
    },
  },
  {
    id: "w3-feeds-anon-200",
    expect: `anonymous GET of the four feed tails on ${ctx.repo} → 200 with the EXACT writeFeed content-types (application/rss+xml;charset=utf-8 / application/atom+xml;charset=utf-8) + root elements + channel titles "Releases for ${ctx.user}/${ctx.repo}" / "Tags for …" (mount-at-run-time: a 404 warns — not yet mounted)`,
    run: async () => {
      const titles = {
        releases: `<title>Releases for ${ctx.user}/${ctx.repo}</title>`,
        tags: `<title>Tags for ${ctx.user}/${ctx.repo}</title>`,
      };
      const tails = [
        { path: `/${ctx.user}/${ctx.repo}/releases.rss`, ct: "application/rss+xml;charset=utf-8", root: `<rss version="2.0"`, title: titles.releases },
        { path: `/${ctx.user}/${ctx.repo}/releases.atom`, ct: "application/atom+xml;charset=utf-8", root: `<feed xmlns="http://www.w3.org/2005/Atom">`, title: titles.releases },
        { path: `/${ctx.user}/${ctx.repo}/tags.rss`, ct: "application/rss+xml;charset=utf-8", root: `<rss version="2.0"`, title: titles.tags },
        { path: `/${ctx.user}/${ctx.repo}/tags.atom`, ct: "application/atom+xml;charset=utf-8", root: `<feed xmlns="http://www.w3.org/2005/Atom">`, title: titles.tags },
      ];
      const unmounted = [];
      let ok = 0;
      for (const t of tails) {
        const probe = await window3GetOrWarn(`${opts.baseUrl}${t.path}`);
        if (probe === null) {
          unmounted.push(t.path);
          continue;
        }
        expect(probe.res.status === 200, `${t.path} status ${probe.res.status} (expected 200)`);
        expect(String(probe.res.headers.get("content-type")) === t.ct,
          `${t.path} content-type ${JSON.stringify(probe.res.headers.get("content-type"))} (expected ${t.ct})`);
        expect(probe.body.includes(t.root), `${t.path} missing the ${t.root.split(" ")[0]} root element`);
        expect(probe.body.includes(t.title), `${t.path} missing the channel title ${t.title}`);
        ok += 1;
      }
      if (unmounted.length > 0) {
        return { status: "warn", detail: `${ok}/${tails.length} feed tails 200; NOT MOUNTED at run time: ${unmounted.join(", ")}` };
      }
      return `all 4 feed tails 200 — exact content-types + channel titles (Releases for / Tags for)`;
    },
  },
  {
    id: "w3-feeds-empty-repo-404",
    expect: `anonymous GET releases.rss + tags.rss on the EMPTY repo ${ctx.emptyRepo} → 404 each (the group gate repo.MustBeNotEmpty — an empty repo never reaches the feed handler; pre-mount the engine's route-miss 404 is indistinguishable, post-mount this pins the gate)`,
    run: async () => {
      for (const tail of ["releases.rss", "tags.rss"]) {
        const res = await fetchT(`${opts.baseUrl}/${ctx.user}/${ctx.emptyRepo}/${tail}`);
        await res.text();
        expect(res.status === 404, `empty-repo ${tail} status ${res.status} (expected 404 — MustBeNotEmpty)`);
      }
      return "404 on both tails — the empty repo never reaches the feed handlers";
    },
  },
  {
    id: "w3-wiki-absent-raw-404",
    expect: `GET ${ctx.repo}/wiki/raw/Home BEFORE any wiki write → 404 (the absent-wiki arm — the wiki cell has no branch yet, wiki.go:600-604's not-exist class; mount-at-run-time: the page family's 200-start-page/303 degradation warns — post-mount this probe must answer 404)`,
    run: async () => {
      const probe = await window3WikiRawProbe(ctx, "Home");
      if (probe.degraded) {
        return { status: "warn", detail: `wiki/raw/Home ${probe.detail} — the raw arm is NOT MOUNTED at run time; post-mount this probe must answer 404 (the absent-wiki gate)` };
      }
      expect(probe.res.status === 404, `absent-wiki raw probe status ${probe.res.status} (expected 404)`);
      return "404 — the absent-wiki arm";
    },
  },
  {
    id: "w3-wiki-page-create-303",
    expect: `POST ${ctx.repo}/wiki?action=_new {"title":"Home","content":"# window3 wiki raw probe\\n","message":""} with the session cookie + same-origin Origin → 303 onto /${ctx.user}/${ctx.repo}/wiki/Home (the LANDED wiki writer seeds the page the raw arm serves)`,
    run: async () => {
      const r = await window2PostForm(ctx, `/${ctx.user}/${ctx.repo}/wiki?action=_new`, {
        title: "Home", content: W3_WIKI_HOME_TEXT, message: "",
      });
      expect(r.status === 303, `status ${r.status} (expected 303): ${r.body.slice(0, 120)}`);
      expect(r.location === `/${ctx.user}/${ctx.repo}/wiki/Home`,
        `location ${JSON.stringify(r.location)} (expected /${ctx.user}/${ctx.repo}/wiki/Home)`);
      return `303 → ${r.location}`;
    },
  },
  {
    id: "w3-wiki-raw-coded-200",
    expect: `GET ${ctx.repo}/wiki/raw/Home (the CODED probe — WebPathToGitPath "Home.md") → 200 text/plain; charset=utf-8 with the pushed bytes VERBATIM + a strong quoted-oid ETag (mount-at-run-time: the page family's degradation warns — not yet mounted)`,
    run: async () => {
      const probe = await window3WikiRawProbe(ctx, "Home");
      if (probe.degraded) {
        return { status: "warn", detail: `wiki/raw/Home ${probe.detail} — NOT MOUNTED at run time (the not-yet-mounted degradation)` };
      }
      expect(probe.res.status === 200, `status ${probe.res.status} (expected 200)`);
      expect(String(probe.res.headers.get("content-type")) === "text/plain; charset=utf-8",
        `content-type ${JSON.stringify(probe.res.headers.get("content-type"))} (expected text/plain; charset=utf-8 — any text is forced plain)`);
      expect(probe.body === W3_WIKI_HOME_TEXT, `body ${JSON.stringify(probe.body.slice(0, 60))} != the pushed wiki bytes`);
      const etag = String(probe.res.headers.get("etag") ?? "");
      expect(/^"[0-9a-f]{40}"$/.test(etag), `etag ${JSON.stringify(etag)} (expected a strong quoted-oid ETag)`);
      ctx.wikiEtag = etag;
      return `200 text/plain — the pushed bytes round-trip; ETag ${etag.slice(0, 9)}…`;
    },
  },
  {
    id: "w3-wiki-raw-md-alias-200",
    expect: `GET ${ctx.repo}/wiki/raw/Home.md (the .md-TAIL probe — WebPathToGitPath's pass-through arm, the SAME blob as the coded probe) → 200 with the IDENTICAL ETag + bytes (mount-at-run-time: the page family's degradation warns)`,
    run: async () => {
      const probe = await window3WikiRawProbe(ctx, "Home.md");
      if (probe.degraded) {
        return { status: "warn", detail: `wiki/raw/Home.md ${probe.detail} — NOT MOUNTED at run time (the not-yet-mounted degradation)` };
      }
      expect(probe.res.status === 200, `status ${probe.res.status} (expected 200)`);
      expect(probe.body === W3_WIKI_HOME_TEXT, `body ${JSON.stringify(probe.body.slice(0, 60))} != the pushed wiki bytes`);
      expect(String(probe.res.headers.get("etag") ?? "") === ctx.wikiEtag,
        `etag ${JSON.stringify(probe.res.headers.get("etag"))} != the coded probe's ${ctx.wikiEtag} (the .md tail must resolve the same blob)`);
      return `200 — the .md tail resolves the same blob (ETag match)`;
    },
  },
  {
    id: "w3-wiki-raw-304",
    expect: `GET ${ctx.repo}/wiki/raw/Home with If-None-Match: <the captured ETag> → 304 carrying the ETag + the middleware's zero-option Cache-Control (the deployed truth since b1bf73a wraps every UI response; mount-at-run-time: the page family's degradation warns)`,
    run: async () => {
      if (ctx.wikiEtag === null) {
        return { status: "warn", detail: "no ETag captured (the coded probe did not reach a mounted surface) — the 304 arm is unverifiable" };
      }
      const probe = await window3WikiRawProbe(ctx, "Home", { "if-none-match": ctx.wikiEtag });
      if (probe.degraded) {
        return { status: "warn", detail: `wiki/raw/Home ${probe.detail} — NOT MOUNTED at run time (the not-yet-mounted degradation)` };
      }
      expect(probe.res.status === 304, `status ${probe.res.status} (expected 304)`);
      expect(probe.res.headers.get("etag") === ctx.wikiEtag,
        `the 304's etag ${JSON.stringify(probe.res.headers.get("etag"))} != ${ctx.wikiEtag}`);
      // DEPLOYED TRUTH (the 2026-10-27 wrap found it): uiRouter's blanket
      // zero-option Cache-Control middleware (b1bf73a, bug #19) wraps the 304
      // too — httpcache's return-before-stamp quirk lives only inside the raw
      // response the module builds; the route's 304 carries the middleware's
      // conservative stamp. More cache-safe, not less: pin it.
      expect(probe.res.headers.get("cache-control") === "max-age=0, private, must-revalidate",
        `the 304's cache-control ${JSON.stringify(probe.res.headers.get("cache-control"))} (expected the middleware's zero-option stamp — the blanket b1bf73a wrap)`);
      return "304 with the ETag only — the If-None-Match pair holds";
    },
  },
  {
    id: "w3-issue-create-201",
    expect: `POST /api/v1/repos/${ctx.user}/${ctx.repo}/issues {"title":"w3i-…"} → 201 with the issue number (the content-history tail's row)`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.repo}/issues`, { method: "POST", body: { title: `w3i-${hexId()}` } });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 120)}`);
      expect(Number.isInteger(res.json?.number) && res.json.number > 0, `no issue number in the body: ${res.text.slice(0, 120)}`);
      ctx.issueNumber = res.json.number;
      return `issue #${ctx.issueNumber} created`;
    },
  },
  {
    id: "w3-content-history-list-empty",
    expect: `cookie GET ${ctx.repo}/issues/${"{index}"}/content-history/list?comment_id=0 → 200 JSON {"results":null} (the pre-edit empty arm — upstream's nil-slice marshal; mount-at-run-time: a 404 warns — not yet mounted)`,
    run: async () => {
      const probe = await window3GetOrWarn(
        `${opts.baseUrl}/${ctx.user}/${ctx.repo}/issues/${ctx.issueNumber}/content-history/list?comment_id=0`,
        { cookie: ctx.cookie },
      );
      if (probe === null) {
        return { status: "warn", detail: `content-history/list 404 — NOT MOUNTED at run time (the not-yet-mounted degradation)` };
      }
      expect(probe.res.status === 200, `status ${probe.res.status} (expected 200)`);
      let json = null;
      try { json = JSON.parse(probe.body); } catch { /* the assert below reports the raw body */ }
      expect(json !== null && typeof json === "object" && "results" in json && json.results === null,
        `body ${probe.body.slice(0, 120)} (expected {"results":null} — the pre-edit empty arm)`);
      return `200 {"results":null} — the empty-history arm`;
    },
  },
  {
    id: "w3-milestone-create-201",
    expect: `POST /api/v1/repos/${ctx.user}/${ctx.repo}/milestones {"title":"${ctx.milestoneTitle}"} → 201 with an integer id (the list→detail round-trip's seed)`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.repo}/milestones`, { method: "POST", body: { title: ctx.milestoneTitle } });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 120)}`);
      expect(Number.isInteger(res.json?.id), `no integer milestone id in the body: ${res.text.slice(0, 120)}`);
      ctx.milestoneId = res.json.id;
      return `milestone id ${ctx.milestoneId} created`;
    },
  },
  {
    id: "w3-milestones-list-200",
    expect: `cookie GET ${ctx.repo}/milestones → 200 with class="page-content repository milestones" + the created milestone title (the LIST half of the round-trip; the list page is long-landed — hard assert)`,
    run: async () => {
      const res = await fetchT(`${opts.baseUrl}/${ctx.user}/${ctx.repo}/milestones`, { headers: { cookie: ctx.cookie } });
      const body = await res.text();
      expect(res.status === 200, `status ${res.status} (expected 200)`);
      expect(body.includes(`class="page-content repository milestones"`), "the milestones pageClass discriminator is missing");
      expect(body.includes(ctx.milestoneTitle), `the created milestone ${ctx.milestoneTitle} is not on the list page`);
      return `200 — the list carries milestone ${ctx.milestoneId}`;
    },
  },
  {
    id: "w3-milestone-detail-200",
    expect: `cookie GET ${ctx.repo}/milestone/${"{id}"} → 200 with class="page-content repository milestone-issue-list" + the milestone title (the DETAIL half; mount-at-run-time: a 404 warns — HEAD mounts this page, so a live 404 is deploy lag, a mounted-but-wrong render fails)`,
    run: async () => {
      const probe = await window3GetOrWarn(`${opts.baseUrl}/${ctx.user}/${ctx.repo}/milestone/${ctx.milestoneId}`, { cookie: ctx.cookie });
      if (probe === null) {
        return { status: "warn", detail: `milestone/${ctx.milestoneId} 404 — NOT MOUNTED at run time (the not-yet-mounted degradation)` };
      }
      expect(probe.res.status === 200, `status ${probe.res.status} (expected 200)`);
      expect(probe.body.includes(`class="page-content repository milestone-issue-list"`),
        "the milestone-issue-list pageClass discriminator is missing");
      expect(probe.body.includes(ctx.milestoneTitle), `the milestone title ${ctx.milestoneTitle} is not on the detail page`);
      return `200 — milestone-issue-list renders milestone ${ctx.milestoneId}`;
    },
  },
  {
    id: "w3-profile-activity-200",
    expect: `cookie GET /${ctx.user}?tab=activity → 200 with id="activity-feed" (the feeds container) + the active strip anchor + the repositories anchor (b1bf73a's mounted arm; a marker-less 200 warns — the inert repositories view rendered)`,
    run: async () => {
      const r = await window3ProfileTab(ctx, "activity", [
        `id="activity-feed"`,
        `class="active item" href="/${ctx.user}?tab=activity"`,
        `href="/${ctx.user}?tab=repositories"`,
      ]);
      return r.ok ? r.text : { status: "warn", detail: r.text };
    },
  },
  {
    id: "w3-profile-stars-empty-200",
    expect: `cookie GET /${ctx.user}?tab=stars → 200 with <div class="stars"> + "No matching results found." (the range-else empty state — stars is empty) + the active stars anchor (mount-at-run-time; a marker-less 200 warns — the inert repositories view)`,
    run: async () => {
      const r = await window3ProfileTab(ctx, "stars", [
        `<div class="stars">`,
        "No matching results found.",
        `class="active item" href="/${ctx.user}?tab=stars"`,
      ]);
      return r.ok ? r.text : { status: "warn", detail: r.text };
    },
  },
  {
    id: "w3-profile-watching-empty-200",
    expect: `cookie GET /${ctx.user}?tab=watching → 200 with "No matching results found." (the range-else empty state) + the active watching anchor (mount-at-run-time; a marker-less 200 warns — the inert repositories view)`,
    run: async () => {
      const r = await window3ProfileTab(ctx, "watching", [
        "No matching results found.",
        `class="active item" href="/${ctx.user}?tab=watching"`,
      ]);
      return r.ok ? r.text : { status: "warn", detail: r.text };
    },
  },
  {
    id: "w3-profile-follow-tabs-200",
    expect: `cookie GET /${ctx.user}?tab=followers + ?tab=following → 200 each with the user-cards container (class="user-cards" id="user-cards-container" data-fetch-trigger="fetch-reload"; mount-at-run-time: a 404 or a marker-less 200 warns)`,
    run: async () => {
      const out = [];
      for (const tab of ["followers", "following"]) {
        const r = await window3ProfileTab(ctx, tab, [W3_USER_CARDS]);
        out.push({ tab, ...r });
      }
      if (out.every((p) => p.ok)) return `200 — both follow tabs render the user-cards container`;
      return { status: "warn", detail: out.map((p) => `${p.tab}: ${p.text}`).join("; ") };
    },
  },
  {
    id: "w3-admin-anon-303",
    expect: `anonymous GET of /-/admin/users|orgs|repos → 303 onto the login round-trip, location EXACTLY /login?redirect_to=<encoded path> (the SignInRequired+AdminRequired gate; mount-at-run-time: a 404 warns — not yet mounted)`,
    run: async () => {
      const unmounted = [];
      let ok = 0;
      for (const slug of ["users", "orgs", "repos"]) {
        const path = `/-/admin/${slug}`;
        const res = await fetchT(`${opts.baseUrl}${path}`);
        await res.text();
        if (res.status === 404) {
          unmounted.push(path);
          continue;
        }
        expect(res.status === 303, `${path} status ${res.status} (expected 303 or, unmounted, 404)`);
        expect(res.headers.get("location") === `/login?redirect_to=${encodeURIComponent(path)}`,
          `${path} location ${JSON.stringify(res.headers.get("location"))} (expected /login?redirect_to=${encodeURIComponent(path)})`);
        ok += 1;
      }
      if (unmounted.length > 0) {
        return { status: "warn", detail: `${ok}/3 admin pages 303'd onto the login round-trip; NOT MOUNTED at run time: ${unmounted.join(", ")}` };
      }
      return "all 3 admin pages 303 → /login?redirect_to=<encoded path> (anonymous)";
    },
  },
  ...[
    { slug: "users", pageClass: "admin user", row: () => `href="/${ctx.user}"`, rowNote: "the probe user's HomeLink row" },
    { slug: "orgs", pageClass: "admin user", row: null, rowNote: "" },
    { slug: "repos", pageClass: "admin", row: () => ctx.repo, rowNote: "the probe repo's row" },
  ].map((page) => ({
    id: `w3-admin-${page.slug}-200`,
    expect: `cookie GET /-/admin/${page.slug} → 200 text/html carrying class="page-content ${page.pageClass}"${page.row ? ` + ${page.rowNote}` : " (the zero-org empty state is fine)"} (mount-at-run-time: a 404 warns — not yet mounted)`,
    run: async () => {
      const probe = await window3GetOrWarn(`${opts.baseUrl}/-/admin/${page.slug}`, { cookie: ctx.cookie });
      if (probe === null) {
        return { status: "warn", detail: `/-/admin/${page.slug} 404 — NOT MOUNTED at run time (the not-yet-mounted degradation)` };
      }
      expect(probe.res.status === 200, `status ${probe.res.status} (expected 200)`);
      expect(String(probe.res.headers.get("content-type")).includes("text/html"),
        `content-type ${JSON.stringify(probe.res.headers.get("content-type"))} (expected text/html)`);
      expect(probe.body.includes(`class="page-content ${page.pageClass}"`),
        `/-/admin/${page.slug} missing class="page-content ${page.pageClass}" (the pageClass discriminator)`);
      if (page.row !== null) {
        expect(probe.body.includes(page.row()), `/-/admin/${page.slug} missing ${page.rowNote}`);
      }
      return `200 text/html — class="page-content ${page.pageClass}"${page.row ? ` + ${page.rowNote}` : ""}`;
    },
  })),
  {
    id: "w3-settings-account-200",
    expect: `cookie GET /user/settings/account → 200 text/html carrying class="page-content user settings account" + the no-password-model info ("Non-local users cannot update their password through the Gitea web interface.") + "Manage Email Addresses" (POST arms NOT probed — the read-only battery; mount-at-run-time: a 404 warns)`,
    run: async () => {
      const probe = await window3GetOrWarn(`${opts.baseUrl}/user/settings/account`, { cookie: ctx.cookie });
      if (probe === null) {
        return { status: "warn", detail: `/user/settings/account 404 — NOT MOUNTED at run time (the not-yet-mounted degradation)` };
      }
      expect(probe.res.status === 200, `status ${probe.res.status} (expected 200)`);
      expect(probe.body.includes(`class="page-content user settings account"`),
        "the account pageClass discriminator is missing");
      expect(probe.body.includes("Non-local users cannot update their password through the Gitea web interface."),
        "the settings.password_change_disabled info is missing");
      expect(probe.body.includes("Manage Email Addresses"), "the manage_emails section is missing");
      return `200 — the account tab renders (no-password arm + the email section)`;
    },
  },
  {
    id: "w3-settings-notifications-200",
    expect: `cookie GET /user/settings/notifications → 200 text/html carrying class="page-content user settings" + "Set Email Preference" (the email preference form's submit; POST arms NOT probed — the read-only battery; mount-at-run-time: a 404 warns)`,
    run: async () => {
      const probe = await window3GetOrWarn(`${opts.baseUrl}/user/settings/notifications`, { cookie: ctx.cookie });
      if (probe === null) {
        return { status: "warn", detail: `/user/settings/notifications 404 — NOT MOUNTED at run time (the not-yet-mounted degradation)` };
      }
      expect(probe.res.status === 200, `status ${probe.res.status} (expected 200)`);
      expect(probe.body.includes(`class="page-content user settings"`),
        "the user settings pageClass discriminator is missing");
      expect(probe.body.includes("Set Email Preference"), "the email preference form is missing");
      return `200 — the notifications tab renders (the email preference form)`;
    },
  },
  {
    id: "w3-cleanup-204",
    expect: `both probe repos DELETEd → 204 (the issue/milestone/wiki-page rows cascade with the repo delete; a failed cleanup is documented, not fatal; the failure-cleanup tail re-sweeps)`,
    run: async () => {
      const a = await deleteRepo(ctx.user, ctx.emptyRepo);
      if (typeof a === "string") ctx.emptyGone = true; // the tail no-ops on a green sweep
      const b = await deleteRepo(ctx.user, ctx.repo);
      if (typeof b === "string") ctx.repoGone = true;
      await rm(ctx.tmp, { recursive: true, force: true });
      const parts = [a, b];
      if (parts.every((p) => typeof p === "string")) return `${ctx.repo} + ${ctx.emptyRepo} deleted`;
      return { status: "warn", detail: parts.map((p) => (typeof p === "string" ? p : p.detail)).join("; ") };
    },
  },
];

/** The red-runs-self-sweep posture (the generate-e2e shape): a red window3
 *  run sweeps its own two probe repos instead of leaving them for a
 *  hand-clean. This finally-style tail runs after EVERY window3-mounts
 *  battery run (green ones no-op silently: w3-cleanup-204 already deleted
 *  both, so the gone flags skip them) and best-effort deletes exactly what
 *  the run created and has not already deleted. One [tail] line logs every
 *  action; failures feed left_behind and are never fatal; it never throws
 *  (main's finally depends on it). */
const window3FailureCleanup = async (ctx) => {
  const acts = [];
  const noteLeftBehind = (what, why) => {
    leftBehind.push(`${what} (failure-cleanup tail: ${why})`);
    acts.push(`${what} LEFT BEHIND — ${why}`);
  };
  try {
    const targets = [
      { what: "content repo", created: ctx.repoCreated, gone: ctx.repoGone, full: ctx.repoFullName, name: ctx.repo },
      { what: "empty repo", created: ctx.emptyCreated, gone: ctx.emptyGone, full: ctx.emptyFullName, name: ctx.emptyRepo },
    ];
    for (const t of targets) {
      if (t.created !== true || t.gone === true) continue;
      const [owner, repo] = String(t.full ?? `${opts.user}/${t.name}`).split("/");
      try {
        const out = await deleteRepo(owner, repo);
        acts.push(typeof out === "string" ? out : out.detail);
      } catch (err) {
        noteLeftBehind(`${t.what} ${owner}/${repo}`, `DELETE threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    acts.push(`the sweep itself failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (acts.length) log(`  [tail] w3-leftover-sweep (best-effort failure cleanup) — ${scrub(acts.join("; "))}`);
};

// ---------- battery: fixwave-parity (the RD23 fix wave's live shapes) ----------

/**
 * The fix wave's LIVE parity matrix (the RD23 deploy's verification battery —
 * one probe family per landed behavior; each family asserts its own shape and
 * self-cleans):
 *
 *   1. PR head-sync (140fc0b): a second push to an open PR's head branch (via
 *      the REAL gate — the generate-e2e push helpers) moves refs/pull/N/head —
 *      the PR row's head.sha follows the new tip, the commits list carries it,
 *      and mergeable re-resolves (the re-armed lazy check settles a boolean,
 *      never a stuck null). Chained into the SAME repo: the PR merges (POST
 *      …/merge {"do":"merge"} → 200, GET …/merge → 204), a PATCH state through
 *      the ISSUES route on the merged PR answers the verbatim 412 (d5b111d:
 *      "cannot change state of this pull request, it was already merged"), and
 *      GET /commits?sha=zzz-ghost answers 404 (5539eb9's strict resolver +
 *      43ddf62's unknown-ref residual — never the default branch's walk).
 *   2. Tag-only push-create (0626ced — the DATA-LOSS fix): a tag-only FIRST
 *      push to a fresh name survives the create's settle — the row reads back
 *      via the API (200) and the pushed tag lists.
 *   3. Org revoke (f305dd4's row-19 grants): org + private repo + team
 *      (includes_all_repositories) + member, all via the API; the member's
 *      own minted PAT reads the advert (ls-remote ok); DELETE the team member;
 *      the member's advert is 404-masked (git exit 128 `repository not found`)
 *      and the member's API GET masks too, while the owner still reads.
 *   4. User visibility (3f48b74): a PRIVATE user created via POST /admin/users
 *      answers anonymous GET /users/{name} with the fake 404 and the admin
 *      viewer with 200 + visibility:"private" (the anti-enumeration ladder).
 *   5. sudo (32eaa73): GET /user with the admin PAT + `Sudo: <target>` shows
 *      the TARGET's login; the target's own non-admin PAT + Sudo answers the
 *      exact upstream 403 ("Only administrators allowed to sudo.").
 *   6. Session rotation (28df818): a POST /login web session (the ui-login
 *      methodology), `rotated_at` backdated 25 h in D1 (wrangler d1 execute —
 *      d1Exec, the toolkit's first D1 WRITE path; d1Row was read-only), then
 *      GET /login re-sets the FULL gitea_session directive (name + Path=/ +
 *      HttpOnly + Secure + SameSite=Lax — NOT the raw id:secret value that was
 *      the forced-logout bug), the adopted secret round-trips (303 → /), and
 *      the stale pre-rotation secret authenticates nothing (the 200 form).
 *
 * `independent: true` on purpose (the cleanup-audit precedent): each family
 * reports its own verdict — a red family must not chain-skip the rest of the
 * matrix. PRE-RD23 every family legitimately reds (the standing deployment
 * predates the wave: ignored Sudo header, raw-value rotation cookie, no 412
 * guard, non-strict ghost walk, no refs/pull sync, the tag-only data-loss,
 * unwired org git grants, no visibility ladder); the POST-DEPLOY run is the
 * verdict. A red run sweeps everything it created (the failureTail: repos,
 * org, member user — its PAT rows cascade — and the session row via D1);
 * green runs clean through fw-cleanup.
 *
 * Requires an ADMIN PAT (--user must be the site admin; POST /admin/users and
 * the sudo pair need it) and wrangler auth for the d1 arms (--d1-scope picks
 * the database, remote by default — keep it in step with --base-url).
 */

const fixwaveContext = () => ({
  user: opts.user,
  // Family 1: PR head-sync → merge → 412 → ghost (one shared repo).
  prRepo: `fwpr-${hexId()}`, prBranch: `fwbr-${hexId()}`,
  prNumber: null, tip1: null, tip2: null,
  // Family 2: tag-only push-create.
  tagRepo: `fwt-${hexId()}`, tagName: `fwv1-${hexId()}`,
  // Families 4/5/3: the private user (the sudo impersonation target AND the
  // org family's member — one create, two families).
  member: `fwu-${hexId()}`, memberToken: null, memberTokenId: null,
  // Family 3: the org.
  org: `fworg-${hexId()}`, orgRepo: `fwor-${hexId()}`, teamId: null,
  // Family 6: the web session (the row id is public; the secret half is
  // scrubbed at capture).
  sessionId: null, cookie: null,
  // Failure-tail bookkeeping (the sibling batteries' convention: mark on the
  // observable write, sweep what the flags say survived).
  prRepoCreated: false, prRepoFullName: null, prRepoGone: false,
  tagRepoCreated: false, tagRepoFullName: null, tagRepoGone: false,
  orgRepoCreated: false, orgRepoFullName: null, orgRepoGone: false,
  orgCreated: false, orgGone: false,
  memberCreated: false, memberGone: false,
  sessionRowDeleted: false,
  tmp: null,
});

const fixwaveSteps = (ctx) => [
  {
    id: "fw-pr-repo-201",
    expect: `POST /api/v1/user/repos {"name":"${ctx.prRepo}","auto_init":true} → 201 (the PR head-sync family's repo)`,
    run: async () => {
      const res = await api("/user/repos", { method: "POST", body: { name: ctx.prRepo, auto_init: true } });
      if (res.status === 201) ctx.prRepoCreated = true; // mark on the observable write
      ctx.prRepoFullName = String(res.json?.full_name ?? `${ctx.user}/${ctx.prRepo}`);
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 120)}`);
      return `created ${res.json?.full_name}`;
    },
  },
  {
    id: "fw-pr-head-branch-push",
    expect: `REAL PUSH (the gate, generate-e2e's helpers): clone, branch ${ctx.prBranch}, one commit, push → ls-remote lists it at tip1`,
    run: async () => {
      const tmp = ctx.tmp; // main() owns the battery scratch dir
      const work = path.join(tmp, "pr");
      let r = await git(["clone", gitUrl(ctx.user, ctx.prRepo), "pr"], tmp, { auth: true });
      expect(r.ok, `clone failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
      r = await git(["checkout", "-b", ctx.prBranch], work);
      expect(r.ok, `checkout -b failed: ${r.stderr.trim()}`);
      await writeFile(path.join(work, "fwpr.txt"), `deploy-probes fixwave head-sync ${ctx.prBranch}\n`);
      r = await git(["add", "-A"], work);
      expect(r.ok, `git add failed: ${r.stderr.trim()}`);
      r = await git(["-c", "user.name=cf-gitea-probes", "-c", "user.email=probes@cf-gitea.invalid",
        "commit", "-m", "deploy-probes: fixwave PR head commit 1"], work);
      expect(r.ok, `git commit failed: ${r.stderr.trim()}`);
      r = await git(["push", "origin", `HEAD:refs/heads/${ctx.prBranch}`], work, { auth: true });
      expect(r.ok, `push branch failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      const lr = await lsRemote(gitUrl(ctx.user, ctx.prRepo), { auth: true });
      expect(lr.ok && lr.refs.has(`refs/heads/${ctx.prBranch}`), `ls-remote missing ${ctx.prBranch}`);
      ctx.tip1 = lr.refs.get(`refs/heads/${ctx.prBranch}`);
      return `head branch ${ctx.prBranch} at ${ctx.tip1.slice(0, 10)}…`;
    },
  },
  {
    id: "fw-pr-open-201",
    expect: `POST /repos/${ctx.user}/${ctx.prRepo}/pulls {"head":"${ctx.prBranch}","base":"main"} → 201 (same-repo head grammar) + settle-polled GET until mergeable leaves null (budget 15s)`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.prRepo}/pulls`, {
        method: "POST",
        body: { title: `deploy-probes fixwave head-sync ${ctx.prBranch}`, head: ctx.prBranch, base: "main" },
      });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 200)}`);
      expect(Number.isInteger(res.json?.number) && res.json.number > 0, `no PR number in the body: ${res.text.slice(0, 120)}`);
      ctx.prNumber = res.json.number;
      const pr = await poll(15_000, async () => {
        const get = await api(`/repos/${ctx.user}/${ctx.prRepo}/pulls/${ctx.prNumber}`);
        return get.status === 200 && get.json?.mergeable !== null && get.json?.mergeable !== undefined ? get.json : null;
      });
      expect(pr !== null, `PR #${ctx.prNumber} never resolved with a non-null mergeable within 15 s`);
      expect(pr.head?.sha === ctx.tip1, `pre-push head.sha ${pr.head?.sha} != tip1 ${ctx.tip1}`);
      return `PR #${ctx.prNumber} open, mergeable ${pr.mergeable} at tip1`;
    },
  },
  {
    id: "fw-pr-second-push",
    expect: `second REAL PUSH to the open PR's head branch (one more commit through the gate) → ls-remote at tip2`,
    run: async () => {
      const work = path.join(ctx.tmp, "pr");
      await writeFile(path.join(work, "fwpr2.txt"), `deploy-probes fixwave head-sync second commit\n`);
      let r = await git(["add", "-A"], work);
      expect(r.ok, `git add failed: ${r.stderr.trim()}`);
      r = await git(["-c", "user.name=cf-gitea-probes", "-c", "user.email=probes@cf-gitea.invalid",
        "commit", "-m", "deploy-probes: fixwave PR head commit 2"], work);
      expect(r.ok, `git commit failed: ${r.stderr.trim()}`);
      r = await git(["push", "origin", `HEAD:refs/heads/${ctx.prBranch}`], work, { auth: true });
      expect(r.ok, `second push failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      const lr = await lsRemote(gitUrl(ctx.user, ctx.prRepo), { auth: true });
      expect(lr.ok && lr.refs.get(`refs/heads/${ctx.prBranch}`) !== ctx.tip1,
        `branch tip did not advance past tip1: ${lr.refs.get(`refs/heads/${ctx.prBranch}`)}`);
      ctx.tip2 = lr.refs.get(`refs/heads/${ctx.prBranch}`);
      return `head branch advanced to ${ctx.tip2.slice(0, 10)}…`;
    },
  },
  {
    id: "fw-pr-head-sync",
    expect: `THE HEAD-SYNC (140fc0b): settle-polled GET the PR (budget ${SETTLE_MS / 1000}s) → head.sha MOVED to tip2 (refs/pull/${"{N}"}/head followed the push); GET …/pulls/${"{N}"}/commits lists tip2; mergeable re-resolves a boolean (the re-armed check, never a stuck null)`,
    run: async () => {
      expect(Number.isInteger(ctx.prNumber) && ctx.tip2 !== null, "no open PR from the prior arms (fixture missing)");
      const pr = await poll(SETTLE_MS, async () => {
        const res = await api(`/repos/${ctx.user}/${ctx.prRepo}/pulls/${ctx.prNumber}`);
        return res.status === 200 && res.json?.head?.sha === ctx.tip2 ? res.json : null;
      });
      expect(pr !== null,
        `head.sha never reached ${ctx.tip2.slice(0, 10)}… within ${SETTLE_MS} ms — refs/pull/${ctx.prNumber}/head did NOT follow the push (the 140fc0b head-sync)`);
      const commits = await api(`/repos/${ctx.user}/${ctx.prRepo}/pulls/${ctx.prNumber}/commits`);
      expect(commits.status === 200, `commits list status ${commits.status} (expected 200)`);
      expect(Array.isArray(commits.json) && commits.json.some((c) => c.sha === ctx.tip2),
        `the commits list does not carry the new tip ${ctx.tip2.slice(0, 10)}… (got ${(commits.json ?? []).map((c) => c.sha?.slice(0, 10)).join(", ")})`);
      expect(typeof pr.mergeable === "boolean", `mergeable ${pr.mergeable} after the sync (expected a re-resolved boolean)`);
      return `head.sha moved to ${ctx.tip2.slice(0, 10)}… (refs/pull/${ctx.prNumber}/head synced); commits list carries it; mergeable ${pr.mergeable}`;
    },
  },
  {
    id: "fw-pr-merge-200",
    expect: `POST …/pulls/${"{N}"}/merge {"do":"merge"} → 200, then GET …/pulls/${"{N}"}/merge → 204 (has-merged)`,
    run: async () => {
      expect(Number.isInteger(ctx.prNumber), "no open PR from the prior arms (fixture missing)");
      const res = await api(`/repos/${ctx.user}/${ctx.prRepo}/pulls/${ctx.prNumber}/merge`, {
        method: "POST", body: { do: "merge" },
      });
      expect(res.status === 200, `merge status ${res.status} (expected 200): ${res.text.slice(0, 160)}`);
      const check = await api(`/repos/${ctx.user}/${ctx.prRepo}/pulls/${ctx.prNumber}/merge`);
      expect(check.status === 204, `has-merged GET status ${check.status} (expected 204)`);
      return `PR #${ctx.prNumber} merged (200 + has-merged 204)`;
    },
  },
  {
    id: "fw-pr-merged-state-412",
    expect: `PATCH …/issues/${"{N}"} {"state":"closed"} on the MERGED PR → 412 with the verbatim message "cannot change state of this pull request, it was already merged" (the d5b111d guard — HasMerged before the value)`,
    run: async () => {
      expect(Number.isInteger(ctx.prNumber), "no merged PR from the prior arms (fixture missing)");
      const res = await api(`/repos/${ctx.user}/${ctx.prRepo}/issues/${ctx.prNumber}`, {
        method: "PATCH", body: { state: "closed" },
      });
      expect(res.status === 412, `status ${res.status} (expected 412 on the merged PR's state arm): ${res.text.slice(0, 160)}`);
      expect(res.json?.message === "cannot change state of this pull request, it was already merged",
        `message ${JSON.stringify(res.json?.message)} (expected the verbatim merged-PR 412 text)`);
      return `412 verbatim: ${res.json?.message}`;
    },
  },
  {
    id: "fw-commits-ghost-404",
    expect: `GET …/commits?sha=zzz-ghost → 404 (the strict resolver — an unresolvable sha NEVER falls back to the default branch's walk; 5539eb9 + 43ddf62)`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.prRepo}/commits?sha=zzz-ghost`);
      expect(res.status === 404, `status ${res.status} (expected 404 for the unresolvable sha): ${res.text.slice(0, 160)}`);
      return `404 — zzz-ghost resolves to nothing and answers so`;
    },
  },
  {
    id: "fw-tagonly-push-0",
    expect: `TAG-ONLY FIRST PUSH to a FRESH name (0626ced): scratch repo, one commit, git push ${ctx.user}/${ctx.tagRepo}.git HEAD:refs/tags/${ctx.tagName} → exit 0 (push-create through the receive-pack probe)`,
    run: async () => {
      const dir = path.join(ctx.tmp, "tagonly");
      let r = await git(["init", "-b", "main", dir]);
      expect(r.ok, `git init failed: ${r.stderr.trim()}`);
      await writeFile(path.join(dir, "tagonly.txt"), `deploy-probes fixwave tag-only ${ctx.tagName}\n`);
      r = await git(["add", "-A"], dir);
      expect(r.ok, `git add failed: ${r.stderr.trim()}`);
      r = await git(["-c", "user.name=cf-gitea-probes", "-c", "user.email=probes@cf-gitea.invalid",
        "commit", "-m", "deploy-probes: fixwave tag-only push-create"], dir);
      expect(r.ok, `git commit failed: ${r.stderr.trim()}`);
      r = await git(["push", gitUrl(ctx.user, ctx.tagRepo), `HEAD:refs/tags/${ctx.tagName}`], dir, { auth: true });
      if (r.ok) {
        ctx.tagRepoCreated = true; // mark on the observable write (the push-create landed server-side)
      } else if (r.killed) {
        // A TIMED-OUT push may have landed server-side (the operation
        // succeeded, only the response wait aborted — the AGENTS.md timeout
        // lesson): probe before deciding whether the failure tail must sweep.
        const probe = await api(`/repos/${ctx.user}/${ctx.tagRepo}`);
        if (probe.status === 200) ctx.tagRepoCreated = true;
      }
      ctx.tagRepoFullName = `${ctx.user}/${ctx.tagRepo}`;
      expect(r.ok, `tag-only push-create failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
      return `exit 0 — tag-only push-create accepted (refs/tags/${ctx.tagName})`;
    },
  },
  {
    id: "fw-tagonly-row-survives",
    expect: `THE SURVIVAL (the settle's three-arm contract): settle-polled GET …/repos/${ctx.user}/${ctx.tagRepo} (budget ${SETTLE_MS / 1000}s) → 200 (the row did NOT vanish mid-settle) and GET …/tags lists ${ctx.tagName}`,
    run: async () => {
      const repo = await poll(SETTLE_MS, async () => {
        const res = await api(`/repos/${ctx.user}/${ctx.tagRepo}`);
        return res.status === 200 ? res : null;
      });
      expect(repo !== null,
        `GET the repo never answered 200 within ${SETTLE_MS} ms — the tag-only create's row did NOT survive the settle (the 0626ced data-loss fix)`);
      const tags = await poll(SETTLE_MS, async () => {
        const res = await api(`/repos/${ctx.user}/${ctx.tagRepo}/tags`);
        return res.status === 200 && Array.isArray(res.json) && res.json.some((t) => t.name === ctx.tagName) ? res.json : null;
      });
      expect(tags !== null, `the pushed tag ${ctx.tagName} never listed via GET /tags (got ${(tags ?? [])[0]?.name ?? "nothing"})`);
      return `row survived (200 ${repo.json?.full_name}) + tag ${ctx.tagName} lists`;
    },
  },
  {
    id: "fw-user-create-201",
    expect: `POST /api/v1/admin/users {"username":"${ctx.member}","visibility":"private"} → 201 with visibility:"private" (the admin API; PAT-only store — no password)`,
    run: async () => {
      const res = await api("/admin/users", {
        method: "POST",
        body: {
          username: ctx.member,
          email: `${ctx.member}@probes.cf-gitea.invalid`,
          visibility: "private",
          must_change_password: false,
        },
      });
      if (res.status === 201) ctx.memberCreated = true; // mark on the observable write
      expect(res.status === 201, `status ${res.status} (expected 201 — an admin PAT is required): ${res.text.slice(0, 160)}`);
      expect(res.json?.login === ctx.member, `login ${res.json?.login} (expected ${ctx.member})`);
      expect(res.json?.visibility === "private", `visibility ${res.json?.visibility} (expected private)`);
      return `user ${ctx.member} created (private)`;
    },
  },
  {
    id: "fw-user-visibility",
    expect: `THE LADDER (3f48b74): anonymous GET /users/${"{name}"} → the fake 404 ({"message":"not found"} — existence never disclosed) while the admin viewer → 200 + visibility:"private"`,
    run: async () => {
      expect(ctx.memberCreated, "no private user from the prior arm (fixture missing)");
      const anon = await api(`/users/${ctx.member}`, { auth: false });
      expect(anon.status === 404, `anonymous status ${anon.status} (expected 404 — the private row must not leak)`);
      expect(anon.text.includes("not found"), `anonymous body ${anon.text.slice(0, 120)} (expected the not-found report)`);
      const admin = await api(`/users/${ctx.member}`);
      expect(admin.status === 200, `admin status ${admin.status} (expected 200 — the site admin reads every row)`);
      expect(admin.json?.visibility === "private", `admin-viewed visibility ${admin.json?.visibility} (expected private)`);
      return `anonymous 404 (masked), admin 200 (private) — the ladder holds`;
    },
  },
  {
    id: "fw-user-token-mint",
    expect: `POST /users/${"{name}"}/tokens {"scopes":["all"]} → 201 with the ONE-TIME plaintext under sha1 — over HTTP BASIC (upstream's reqBasicAuth gate on token CRUD: the credential must arrive as user:<PAT>; the token-header form answers 401 "auth required" — the live finding) — requireSelfOrAdmin lets the admin mint for the member; the plaintext is scrubbed from all output`,
    run: async () => {
      expect(ctx.memberCreated, "no private user from the prior arm (fixture missing)");
      const res = await api(`/users/${ctx.member}/tokens`, {
        method: "POST",
        basic: { user: ctx.user, pass: TOKEN },
        body: { name: `fw-probe-${hexId()}`, scopes: ["all"] },
      });
      expect(res.status === 201, `status ${res.status} (expected 201 — the mint rides HTTP BASIC, upstream's token-CRUD gate): ${res.text.slice(0, 160)}`);
      const plaintext = String(res.json?.sha1 ?? "");
      secrets.push(plaintext); // scrub BEFORE any assert detail could carry it
      expect(plaintext.length > 0, `no one-time plaintext in the mint body: ${scrub(res.text.slice(0, 120))}`);
      ctx.memberToken = plaintext;
      ctx.memberTokenId = res.json?.id;
      return `token id ${res.json?.id} minted for ${ctx.member} (plaintext captured + scrubbed)`;
    },
  },
  {
    id: "fw-sudo-impersonates",
    expect: `THE ADMIN ARM (32eaa73): GET /user with the admin PAT + Sudo: ${"{target}"} → 200 whose login is the TARGET (the doer swapped, the admin token's scope kept)`,
    run: async () => {
      expect(ctx.memberCreated, "no impersonation target from the prior arms (fixture missing)");
      const res = await api("/user", { headers: { sudo: ctx.member } });
      expect(res.status === 200, `status ${res.status} (expected 200): ${res.text.slice(0, 160)}`);
      expect(res.json?.login === ctx.member,
        `login ${res.json?.login} (expected the Sudo target ${ctx.member} — an unmounted sudo() ignores the header and answers the admin's own login)`);
      return `sudo answered as ${res.json?.login} (impersonation live)`;
    },
  },
  {
    id: "fw-sudo-non-admin-403",
    expect: `THE REFUSAL ARM: GET /user with the MEMBER's own PAT + Sudo → 403 "Only administrators allowed to sudo." (the exact upstream text)`,
    run: async () => {
      expect(ctx.memberToken !== null, "no member token from the prior arm (fixture missing)");
      const res = await api("/user", { asToken: ctx.memberToken, headers: { sudo: ctx.user } });
      expect(res.status === 403, `status ${res.status} (expected 403 — a non-admin never sudoes; an unmounted sudo() would answer 200)`);
      expect(res.json?.message === "Only administrators allowed to sudo.",
        `message ${JSON.stringify(res.json?.message)} (expected the exact upstream refusal)`);
      return `403 "Only administrators allowed to sudo."`;
    },
  },
  {
    id: "fw-org-setup-201s",
    expect: `the org fixtures via the API: POST /orgs → 201; POST /orgs/${"{org}"}/repos (PRIVATE) → 201; POST /orgs/${"{org}"}/teams {"permission":"read","includes_all_repositories":true,"units":["repo.code"]} → 201 with an id; PUT /teams/${"{id}"}/members/${"{user}"} → 204`,
    run: async () => {
      expect(ctx.memberCreated, "no team member from the prior arms (fixture missing)");
      const org = await api("/orgs", { method: "POST", body: { username: ctx.org } });
      if (org.status === 201) ctx.orgCreated = true;
      expect(org.status === 201, `org status ${org.status} (expected 201): ${org.text.slice(0, 120)}`);
      const repo = await api(`/orgs/${ctx.org}/repos`, {
        method: "POST", body: { name: ctx.orgRepo, private: true, auto_init: true },
      });
      if (repo.status === 201) {
        ctx.orgRepoCreated = true;
        ctx.orgRepoFullName = String(repo.json?.full_name ?? `${ctx.org}/${ctx.orgRepo}`);
      }
      expect(repo.status === 201, `org repo status ${repo.status} (expected 201): ${repo.text.slice(0, 120)}`);
      const team = await api(`/orgs/${ctx.org}/teams`, {
        method: "POST",
        body: { name: `fwteam-${hexId()}`, permission: "read", includes_all_repositories: true, units: ["repo.code"] },
      });
      expect(team.status === 201, `team status ${team.status} (expected 201): ${team.text.slice(0, 120)}`);
      expect(Number.isInteger(team.json?.id), `no team id in the body: ${team.text.slice(0, 120)}`);
      ctx.teamId = team.json.id;
      const add = await api(`/teams/${ctx.teamId}/members/${ctx.member}`, { method: "PUT" });
      expect(add.status === 204, `add member status ${add.status} (expected 204)`);
      return `org + private repo + team ${ctx.teamId} (includes-all) + member, all 201/204`;
    },
  },
  {
    id: "fw-org-member-preaccess",
    expect: `the MEMBER's own PAT reads the org repo's advert (settle-polled ls-remote, budget ${SETTLE_MS / 1000}s — the f305dd4 row-19 grant wiring makes team membership git-real)`,
    run: async () => {
      expect(ctx.memberToken !== null && Number.isInteger(ctx.teamId), "no member token / team from the prior arms (fixture missing)");
      const done = await poll(SETTLE_MS, async () => {
        const r = await lsRemote(gitUrl(ctx.org, ctx.orgRepo), { auth: true, as: ctx.memberToken });
        return r.ok && r.refs.has("refs/heads/main") ? r : null;
      });
      expect(done !== null,
        `the member's ls-remote never came up within ${SETTLE_MS} ms — team membership did not grant the git read (the f305dd4 row-19 org-grant wiring)`);
      return `member advert ok — ${[...done.refs.keys()].filter((x) => x !== "HEAD").join(", ")}`;
    },
  },
  {
    id: "fw-org-revoke-masked",
    expect: `THE REVOKE: DELETE /teams/${"{id}"}/members/${"{user}"} → 204; the member's VERY NEXT ls-remote → exit 128 'repository not found' (the 404 mask) AND their API GET → 404, while the owner still reads 200`,
    run: async () => {
      expect(ctx.memberToken !== null && Number.isInteger(ctx.teamId), "no member token / team from the prior arms (fixture missing)");
      const del = await api(`/teams/${ctx.teamId}/members/${ctx.member}`, { method: "DELETE" });
      expect(del.status === 204, `remove member status ${del.status} (expected 204)`);
      const advert = await lsRemote(gitUrl(ctx.org, ctx.orgRepo), { auth: true, as: ctx.memberToken });
      expect(advert.code === 128, `member ls-remote exit ${advert.code} (expected 128 — a 0 here means the revoke did not cut the git read)`);
      // The mask text's CASE is not pinned: the tombstone battery's masked
      // body is lowercase 'repository not found', the standing deployment's
      // member-mask reads 'Repository not found' (capital R) — the match is
      // case-insensitive and the post-deploy run is the verdict on any
      // unification.
      expect(/repository not found/i.test(advert.stderr),
        `member ls-remote stderr ${advert.stderr.trim().slice(0, 160)} (expected the masked not-found text)`);
      const masked = await api(`/repos/${ctx.org}/${ctx.orgRepo}`, { asToken: ctx.memberToken });
      expect(masked.status === 404, `member API GET status ${masked.status} (expected the masked 404)`);
      const owner = await api(`/repos/${ctx.org}/${ctx.orgRepo}`);
      expect(owner.status === 200, `owner control GET status ${owner.status} (expected 200 — only the member lost access)`);
      return `revoked: member advert 128 not-found + API 404 (masked); owner still 200`;
    },
  },
  {
    id: "fw-session-mint-303",
    expect: `POST /login (form-urlencoded user_name + password=<PAT>) → 303 + gitea_session cookie (the ui-login methodology; the value is scrubbed from all output) — the rotation family's live row`,
    run: async () => {
      const form = new URLSearchParams({ user_name: ctx.user, password: TOKEN });
      const res = await fetchT(`${opts.baseUrl}/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      await res.text();
      expect(res.status === 303, `status ${res.status} (expected 303 See Other)`);
      const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("gitea_session="));
      expect(setCookie !== undefined, `no gitea_session cookie in Set-Cookie (got ${res.headers.getSetCookie().length} cookies)`);
      ctx.cookie = setCookie.split(";")[0];
      const value = ctx.cookie.split("=")[1] ?? "";
      ctx.sessionId = value.split(":")[0];
      secrets.push(value);
      expect(ctx.sessionId.length === 10, `session row id ${ctx.sessionId} is not the 10-char public id shape`);
      return `303 + gitea_session cookie (row ${ctx.sessionId} minted)`;
    },
  },
  {
    id: "fw-session-rotation-directive",
    expect: `THE DIRECTIVE (28df818): backdate rotated_at -25 h in D1 (wrangler d1 execute, --${opts.d1Scope} — d1Exec, the toolkit's first D1 WRITE) → GET /login with the cookie → 303 whose Set-Cookie is the FULL gitea_session directive (name + Path=/ + HttpOnly + Secure + SameSite=Lax) with a FRESH secret — never the raw id:secret value that logged the user out`,
    run: async () => {
      expect(ctx.sessionId !== null, "no session row from the prior arm (fixture missing)");
      await d1Exec(`UPDATE sessions SET rotated_at = rotated_at - 90000 WHERE id = '${ctx.sessionId}'`);
      const row = await d1Row(`SELECT rotated_at FROM sessions WHERE id = '${ctx.sessionId}'`);
      expect(Date.now() / 1000 - Number(row.rotated_at) >= 86_400,
        `the backdate did not stick (rotated_at ${row.rotated_at} is less than a day old) — rotation would not be due`);
      const res = await fetchT(`${opts.baseUrl}/login`, { headers: { cookie: ctx.cookie } });
      await res.text();
      expect(res.status === 303, `status ${res.status} (expected 303 — the backdated session still authenticates)`);
      expect(res.headers.get("location") === "/", `location ${JSON.stringify(res.headers.get("location"))} (expected "/")`);
      const rotated = res.headers.getSetCookie().find((c) => c.startsWith("gitea_session="));
      expect(rotated !== undefined,
        `no gitea_session Set-Cookie on the rotation response (${res.headers.getSetCookie().length} cookie(s), first: ${scrub(res.headers.getSetCookie()[0] ?? "<none>").slice(0, 48)}) — the RAW-value shape (the forced-logout bug; 28df818 missing)`);
      for (const attr of ["Path=/", "HttpOnly", "Secure", "SameSite=Lax"]) {
        expect(rotated.includes(attr), `the rotated Set-Cookie is missing ${attr}: ${scrub(rotated).slice(0, 60)}`);
      }
      const newValue = rotated.split(";")[0].slice("gitea_session=".length);
      secrets.push(newValue);
      const oldSecret = (ctx.cookie.split("=")[1] ?? "").split(":")[1];
      expect(newValue.split(":")[1] !== oldSecret, "the rotated cookie re-used the OLD secret (no fresh secret minted)");
      expect(newValue.split(":")[0] === ctx.sessionId, `the rotated cookie's row id ${newValue.split(":")[0]} != ${ctx.sessionId} (rotation keeps the row)`);
      ctx.newCookieValue = newValue;
      return `303 → / with the full directive (name + attrs, fresh secret, same row)`;
    },
  },
  {
    id: "fw-session-adopted-cookie",
    expect: `the ADOPTED secret round-trips and the stale one is dead: GET /login with the ROTATED cookie → 303 "/" (the forced-logout regression stays closed); GET /login with the PRE-rotation cookie → 200 (in grace it authenticates nothing)`,
    run: async () => {
      expect(ctx.newCookieValue !== null, "no rotated cookie from the prior arm (fixture missing)");
      const adopted = await fetchT(`${opts.baseUrl}/login`, { headers: { cookie: `gitea_session=${ctx.newCookieValue}` } });
      await adopted.text();
      expect(adopted.status === 303, `rotated-cookie status ${adopted.status} (expected 303 — the browser adopting the directive stays signed in)`);
      expect(adopted.headers.get("location") === "/", `rotated-cookie location ${JSON.stringify(adopted.headers.get("location"))} (expected "/")`);
      const stale = await fetchT(`${opts.baseUrl}/login`, { headers: { cookie: ctx.cookie } });
      await stale.text();
      expect(stale.status === 200, `stale-cookie status ${stale.status} (expected 200 — the pre-rotation secret authenticates nothing)`);
      return `rotated cookie 303 → / (signed in); stale cookie 200 (the form — anonymous)`;
    },
  },
  {
    id: "fw-cleanup",
    expect: `everything DELETEd: org repo + PR repo + tag repo (204 each), the org (204), the member's token (204) + the member user (204), the session row (D1) — a failed cleanup is documented, not fatal (the failure-tail re-sweeps)`,
    run: async () => {
      const parts = [];
      const a = await deleteRepo(ctx.org, ctx.orgRepo);
      if (typeof a === "string") ctx.orgRepoGone = true;
      parts.push(typeof a === "string" ? a : a.detail);
      const b = await deleteRepo(ctx.user, ctx.prRepo);
      if (typeof b === "string") ctx.prRepoGone = true;
      parts.push(typeof b === "string" ? b : b.detail);
      const c = await deleteRepo(ctx.user, ctx.tagRepo);
      if (typeof c === "string") ctx.tagRepoGone = true;
      parts.push(typeof c === "string" ? c : c.detail);
      if (ctx.orgCreated) {
        const org = await api(`/orgs/${ctx.org}`, { method: "DELETE" });
        if (org.status === 204) { ctx.orgGone = true; parts.push(`org ${ctx.org} deleted`); }
        else parts.push(`org ${ctx.org} LEFT BEHIND — DELETE returned ${org.status}`);
      }
      if (ctx.memberCreated) {
        if (ctx.memberTokenId !== null && ctx.memberTokenId !== undefined) {
          // Token CRUD is HTTP-BASIC-gated (the mint arm's live finding): the
          // revoke rides the same Basic credential, never the token header.
          const tok = await api(`/users/${ctx.member}/tokens/${ctx.memberTokenId}`, {
            method: "DELETE", basic: { user: ctx.user, pass: TOKEN },
          });
          parts.push(tok.status === 204 ? `member token ${ctx.memberTokenId} revoked` : `member token revoke returned ${tok.status}`);
        }
        const user = await api(`/admin/users/${ctx.member}`, { method: "DELETE" });
        if (user.status === 204) { ctx.memberGone = true; parts.push(`user ${ctx.member} deleted`); }
        else parts.push(`user ${ctx.member} LEFT BEHIND — DELETE returned ${user.status}`);
      }
      if (ctx.sessionId !== null) {
        try {
          await d1Exec(`DELETE FROM sessions WHERE id = '${ctx.sessionId}'`);
          ctx.sessionRowDeleted = true;
          parts.push(`session row ${ctx.sessionId} deleted (D1)`);
        } catch (err) {
          parts.push(`session row ${ctx.sessionId} LEFT BEHIND — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await rm(ctx.tmp, { recursive: true, force: true });
      const bad = parts.filter((p) => p.includes("LEFT BEHIND") || p.includes("returned"));
      if (bad.length === 0) return `${parts.length} cleanups — all 204/D1-deleted`;
      return { status: "warn", detail: bad.join("; ") };
    },
  },
];

/** The red-runs-self-sweep posture (the generate-e2e shape) for a battery that
 *  runs INDEPENDENT steps: a crash outside check() (main's catch) still sweeps
 *  everything the flags say survived — repos first (the org repo before its
 *  org: an org delete over a surviving repo would strand it), then the org
 *  (its delete carries the team + membership), the member user (its PAT rows
 *  are FK cascades), and the session row via D1. One [tail] line logs every
 *  action; failures feed left_behind and are never fatal; it never throws
 *  (main's finally depends on it). */
const fixwaveFailureCleanup = async (ctx) => {
  const acts = [];
  const noteLeftBehind = (what, why) => {
    leftBehind.push(`${what} (failure-cleanup tail: ${why})`);
    acts.push(`${what} LEFT BEHIND — ${why}`);
  };
  const tryDeleteRepo = async (what, full, fallback) => {
    const [owner, repo] = String(full ?? fallback).split("/");
    try {
      const out = await deleteRepo(owner, repo);
      acts.push(typeof out === "string" ? out : out.detail);
    } catch (err) {
      noteLeftBehind(`${what} ${owner}/${repo}`, `DELETE threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  try {
    if (ctx.orgRepoCreated === true && ctx.orgRepoGone !== true) {
      await tryDeleteRepo("org repo", ctx.orgRepoFullName, `${ctx.org}/${ctx.orgRepo}`);
    }
    if (ctx.prRepoCreated === true && ctx.prRepoGone !== true) {
      await tryDeleteRepo("PR repo", ctx.prRepoFullName, `${ctx.user}/${ctx.prRepo}`);
    }
    if (ctx.tagRepoCreated === true && ctx.tagRepoGone !== true) {
      await tryDeleteRepo("tag-only repo", ctx.tagRepoFullName, `${ctx.user}/${ctx.tagRepo}`);
    }
    if (ctx.orgCreated === true && ctx.orgGone !== true) {
      try {
        const res = await api(`/orgs/${ctx.org}`, { method: "DELETE" });
        if (res.status === 204) acts.push(`org ${ctx.org} deleted (204)`);
        else noteLeftBehind(`org ${ctx.org}`, `DELETE returned ${res.status}`);
      } catch (err) {
        noteLeftBehind(`org ${ctx.org}`, `DELETE threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (ctx.memberCreated === true && ctx.memberGone !== true) {
      try {
        const res = await api(`/admin/users/${ctx.member}`, { method: "DELETE" });
        if (res.status === 204) acts.push(`user ${ctx.member} deleted (204; its PAT rows are FK cascades)`);
        else noteLeftBehind(`user ${ctx.member}`, `DELETE returned ${res.status}`);
      } catch (err) {
        noteLeftBehind(`user ${ctx.member}`, `DELETE threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (ctx.sessionId !== null && ctx.sessionRowDeleted !== true) {
      try {
        await d1Exec(`DELETE FROM sessions WHERE id = '${ctx.sessionId}'`);
        acts.push(`session row ${ctx.sessionId} deleted (D1)`);
      } catch (err) {
        noteLeftBehind(`session row ${ctx.sessionId}`, `D1 delete threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    acts.push(`the sweep itself failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (acts.length) log(`  [tail] fw-leftover-sweep (best-effort failure cleanup) — ${scrub(acts.join("; "))}`);
};

// ---------- battery: branch-protection (the SPEC-0013 protection flows) ----------

/**
 * The SPEC-0013 protection flows (the gate-assessment gap 2 closure — the
 * full M1-M4 surface is deployed; this battery verifies the FLOWS, not just
 * the table's existence, per redeploy). One scratch repo carries four arms:
 *
 *   1. Rule CRUD (branch.go:652-1195 via /branch_protections): a throwaway
 *      rule's create → 201 field-faithful echo (priority MAX+1 = 1 on the
 *      empty repo, the zero config), GET + LIST faithful, GET of a missing
 *      rule → the plain shared 404 (the EXACT-name lookup — no glob
 *      fall-through), PATCH {required_approvals, block_on_outdated_branch} →
 *      200 with both echoed, DELETE → 204 then GET → 404 (404-after-delete)
 *      and the list back to [].
 *   2. Priority (repoUpdateBranchProtectionPriories): a second rule, then the
 *      ids POST {ids:[…]} → 204 and the list order follows the renumber. The
 *      ids come straight off the API render (`id` — the cf-gitea addition
 *      that closed the probe's recorded gap: upstream's BranchProtection
 *      struct has no id field, yet its priority op consumes exactly those
 *      row ids, so ours renders the real integer key; the old wrangler-d1
 *      lookup is gone and the priority op is API-addressable end to end).
 *   6. The slash-glob wildcard (the second recorded gap): a GLOB rule
 *      `release/v*` — a name the single-segment {name} route cannot match —
 *      is created → 201, then GET/PATCH/DELETE address it through the
 *      wildcard path (the literal slash in the URL, upstream's chi
 *      `m.Group("/*")` + ctx.PathParam("*") runtime shape, api.go:1328-1332 +
 *      branch.go:556) — 200 renders, the PATCH echo, 204 delete, 404 after.
 *      The declared-constraint arm rides along: the same rule also answers
 *      through the percent-encoded %2F form (the {name} route).
 *   3. Push-time per-ref rejection (the M2 gate): ONE real `git push` carrying
 *      TWO refs — a fast-forward to the protected main plus a create of an
 *      unprotected sibling. The protected ref answers upstream's per-ref
 *      report rejection (`! [remote rejected] … (Not allowed to push to
 *      protected branch main)`, git exit 1 — a door-403 would exit 128) while
 *      the sibling LANDS; ls-remote shows main unmoved at the pre-push tip.
 *   4. The merge approval gate (checkPullBranchProtections, merge.go:694-742):
 *      a PR into the protected branch (required_approvals 1) merges → 405
 *      with the verbatim ErrNotReadyToMerge text "Does not have enough
 *      approvals"; then an ADMIN-minted second user (the fixwave member
 *      methodology) added as a write collaborator submits an APPROVED review
 *      — official:true without the approvals whitelist is upstream's
 *      write-access arm (protected_branch.go:264-289) — and the SAME merge
 *      answers 200 (has-merged 204; main advanced past the pre-push tip).
 *   5. The whitelist/enforce-admins flag round-trip (M4): a GLOB rule (v*) —
 *      whose deprecated branch_name renders EMPTY per isRuleNameSpecial —
 *      carrying the enforceable flag set (push/force-push/deletion
 *      whitelists, merge whitelist, bypass allowlist, approvals whitelist +
 *      required_approvals 2, block_on_outdated_branch,
 *      block_admin_merge_override, status-check contexts, protected-file
 *      patterns) round-trips the serializer field-faithfully (the M4
 *      sanitizer keeps the owner — write/any-access — in every list), then a
 *      PATCH {enable_push:false} shows the landed pointer semantics: the
 *      push master flips its flags off and the canDelete re-conjunction
 *      clears the deletion pair, while the stored id lists survive their
 *      disabled flags (upstream keeps WhitelistUserIDs; the render maps
 *      ids→names regardless) and the ABSENT arms keep their stored values
 *      (branch.go:894-936).
 *
 * CHAINED (the shared-fixture shape — a red in the setup skips the arms that
 * need it, like registry/generate; NOT independent like fixwave-parity: the
 * arms share one repo and the merge gate's verdict reads arms built earlier).
 * Needs an ADMIN PAT (the member-user arm) only — the priority arm reads its
 * ids off the API render and the slash-glob arm rides the wildcard routes,
 * so wrangler/D1 auth is no longer part of this battery. A red run sweeps
 * the rules (best-effort explicit deletes, so a failed repo delete still
 * lands the audit back at protected_branches == 0), then the repo (its
 * delete cascades the rest), then the member's token + the member user (the
 * fixwave tail's shape).
 */

const branchProtectionContext = () => ({
  user: opts.user,
  repo: `bp-${hexId()}`,
  featureBranch: `bpfe-${hexId()}`,
  scratchRule: `bps-${hexId(6)}`,
  devRule: `bpd-${hexId(6)}`,
  globRule: "v*",
  slashGlobRule: "release/v*", // the wildcard-addressing arm (a slash the {name} route cannot match)
  missingRule: `bp-missing-${hexId(6)}`,
  prNumber: null,
  c1: null, // the pre-push main tip (the rejection's must-not-move pin)
  c2: null, // the push-arm commit (the sibling's tip, the merged PR's head)
  member: `bpmb-${hexId()}`, memberToken: null, memberTokenId: null,
  // The rules this battery created, in order — { name, id, created, gone }.
  // `id` is the ADDRESSABLE key straight off the create echo's render (the
  // priority op's input; the old D1 lookup is gone). The green cleanup + the
  // red tail both iterate the list (explicit deletes so the audit's
  // protected_branches == 0 holds even when the repo delete fails).
  rules: [],
  repoCreated: false, repoFullName: null, repoGone: false,
  memberCreated: false, memberGone: false,
  tmp: null,
});

/** POST one rule on the battery's repo; marks it created for the failure-tail
 *  sweep and records the echo's addressable id (the render's real integer
 *  key — the priority op's input). Returns the raw response. */
const createRule = async (ctx, body) => {
  const res = await api(`/repos/${ctx.user}/${ctx.repo}/branch_protections`, { method: "POST", body });
  const track = ctx.rules.find((r) => r.name === body.rule_name);
  if (res.status === 201 && track) {
    track.created = true;
    track.id = res.json?.id ?? null;
  }
  return res;
};

/** The create/read echo assertions shared by the CRUD and flags arms. */
const expectRuleFields = (got, checks, where) => {
  const drifted = checks.filter(([k, v]) => JSON.stringify(got?.[k]) !== JSON.stringify(v));
  expect(drifted.length === 0, `${where}: fields drifted — ${drifted.map(([k, v]) => `${k}=${JSON.stringify(got?.[k])} (expected ${JSON.stringify(v)})`).join("; ")}`);
};

/** DELETE one rule by name (204 expected); marks it gone for the sweep. */
const deleteRule = async (ctx, name) => {
  const res = await api(`/repos/${ctx.user}/${ctx.repo}/branch_protections/${encodeURIComponent(name)}`, { method: "DELETE" });
  const track = ctx.rules.find((r) => r.name === name);
  if (res.status === 204 && track) track.gone = true;
  return res.status;
};

const branchProtectionSteps = (ctx) => [
  {
    id: "bp-repo-create-201",
    expect: `POST /api/v1/user/repos {"name":"${ctx.repo}","auto_init":true} → 201 (the branch-protection battery's scratch repo)`,
    run: async () => {
      const res = await api("/user/repos", { method: "POST", body: { name: ctx.repo, auto_init: true } });
      if (res.status === 201) ctx.repoCreated = true; // mark on the observable write
      ctx.repoFullName = String(res.json?.full_name ?? `${ctx.user}/${ctx.repo}`);
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 120)}`);
      return `created ${res.json?.full_name}`;
    },
  },
  {
    id: "bp-rule-create-201",
    expect: `POST …/branch_protections {"rule_name":"${ctx.scratchRule}"} → 201 field-faithful: rule_name + branch_name echo the plain name, priority 1 (MAX+1 on the empty repo — protected_branch.go:502-513), the zero config (enable_push false, required_approvals 0)`,
    run: async () => {
      ctx.rules.push({ name: ctx.scratchRule, id: null, created: false, gone: false });
      const res = await createRule(ctx, { rule_name: ctx.scratchRule });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 160)}`);
      expectRuleFields(res.json, [
        ["rule_name", ctx.scratchRule], ["branch_name", ctx.scratchRule], ["priority", 1],
        ["enable_push", false], ["required_approvals", 0], ["enable_push_whitelist", false],
      ], "the create echo");
      return `rule ${ctx.scratchRule} created (priority 1, the zero config echoed)`;
    },
  },
  {
    id: "bp-rule-read-faithful",
    expect: `GET …/branch_protections/${ctx.scratchRule} → 200 echoing the create render; GET …/branch_protections → 200 listing exactly it (the priority-sorted list, one row)`,
    run: async () => {
      const one = await api(`/repos/${ctx.user}/${ctx.repo}/branch_protections/${ctx.scratchRule}`);
      expect(one.status === 200, `GET status ${one.status} (expected 200): ${one.text.slice(0, 160)}`);
      expectRuleFields(one.json, [
        ["rule_name", ctx.scratchRule], ["branch_name", ctx.scratchRule], ["priority", 1], ["enable_push", false],
      ], "the GET render");
      const list = await api(`/repos/${ctx.user}/${ctx.repo}/branch_protections`);
      expect(list.status === 200 && Array.isArray(list.json), `list status ${list.status} (expected 200 + an array): ${list.text.slice(0, 120)}`);
      expect(list.json.length === 1 && list.json[0]?.rule_name === ctx.scratchRule,
        `the list should carry exactly the one rule (got ${JSON.stringify(list.json?.map((r) => r.rule_name))})`);
      return `GET echoes the row; the list carries exactly it`;
    },
  },
  {
    id: "bp-rule-missing-404",
    expect: `GET …/branch_protections/${ctx.missingRule} → 404 "not found" (the EXACT-name rule lookup — an unknown name is the plain shared 404, never a glob fall-through or a 400)`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.repo}/branch_protections/${ctx.missingRule}`);
      expect(res.status === 404, `status ${res.status} (expected 404): ${res.text.slice(0, 160)}`);
      expect(res.json?.message === "not found", `message ${JSON.stringify(res.json?.message)} (expected the plain not-found report)`);
      return `404 — the unknown rule name answers the plain shared not-found`;
    },
  },
  {
    id: "bp-rule-edit-200",
    expect: `PATCH …/branch_protections/${ctx.scratchRule} {"required_approvals":1,"block_on_outdated_branch":true} → 200 with BOTH echoed (the pointer semantics: only the fields the body carries change)`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.repo}/branch_protections/${ctx.scratchRule}`, {
        method: "PATCH", body: { required_approvals: 1, block_on_outdated_branch: true },
      });
      expect(res.status === 200, `status ${res.status} (expected 200): ${res.text.slice(0, 160)}`);
      expectRuleFields(res.json, [
        ["rule_name", ctx.scratchRule], ["required_approvals", 1], ["block_on_outdated_branch", true],
        ["enable_push", false], // the absent arm kept its stored false
      ], "the edit echo");
      return `PATCH echoed both new values (enable_push untouched by its absence)`;
    },
  },
  {
    id: "bp-rule-delete-404-after",
    expect: `DELETE …/branch_protections/${ctx.scratchRule} → 204; the SAME GET → 404 (404-after-delete); GET …/branch_protections → [] (the list back to empty)`,
    run: async () => {
      const status = await deleteRule(ctx, ctx.scratchRule);
      expect(status === 204, `DELETE status ${status} (expected 204)`);
      const gone = await api(`/repos/${ctx.user}/${ctx.repo}/branch_protections/${ctx.scratchRule}`);
      expect(gone.status === 404, `post-delete GET status ${gone.status} (expected 404)`);
      const list = await api(`/repos/${ctx.user}/${ctx.repo}/branch_protections`);
      expect(list.status === 200 && Array.isArray(list.json) && list.json.length === 0,
        `the list should be empty after the delete (got ${JSON.stringify(list.json)})`);
      return `deleted (204) → GET 404 → list [] — the CRUD round-trip closed`;
    },
  },
  {
    id: "bp-rule-main-create-201",
    expect: `POST …/branch_protections {"rule_name":"main","required_approvals":1} → 201 (the WORKING rule for the push/merge arms: main protected, one approval required, enable_push still false — everyone rejected at the push gate)`,
    run: async () => {
      ctx.rules.push({ name: "main", id: null, created: false, gone: false });
      const res = await createRule(ctx, { rule_name: "main", required_approvals: 1 });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 160)}`);
      expectRuleFields(res.json, [
        ["rule_name", "main"], ["branch_name", "main"], ["priority", 1], ["required_approvals", 1], ["enable_push", false],
      ], "the working-rule echo");
      return `rule main created (priority 1, required_approvals 1, push closed)`;
    },
  },
  {
    id: "bp-rule-priority-204",
    expect: `THE PRIORITY OP (API-addressable): POST a second rule (priority 2) → 201 whose echo carries the addressable integer id (the cf-gitea render addition — upstream's BranchProtection struct has no id field, yet the priority op consumes exactly these row ids); the LIST renders the SAME ids; POST …/branch_protections/priority {"ids":[<dev>,<main>]} with those render ids → 204; the list order follows the renumber [dev(1), main(2)]`,
    run: async () => {
      ctx.rules.push({ name: ctx.devRule, id: null, created: false, gone: false });
      const dev = await createRule(ctx, { rule_name: ctx.devRule });
      expect(dev.status === 201, `second-rule status ${dev.status} (expected 201): ${dev.text.slice(0, 160)}`);
      expect(dev.json?.priority === 2, `second-rule priority ${dev.json?.priority} (expected 2 — MAX+1)`);
      // the ids come off the create echoes' render — the recorded gap's
      // closure; the wrangler-d1 lookup the old arm needed is gone
      const idOf = (name) => ctx.rules.find((r) => r.name === name)?.id;
      const ids = [idOf(ctx.devRule), idOf("main")];
      expect(ids.every((v) => Number.isInteger(v) && v > 0),
        `the create echoes carry no addressable rule ids: ${JSON.stringify(ctx.rules.map((r) => [r.name, r.id]))}`);
      // the LIST renders the same addressable ids the echoes did
      const before = await api(`/repos/${ctx.user}/${ctx.repo}/branch_protections`);
      expect(before.status === 200 && ids.every((v) => (before.json ?? []).some((r) => r.id === v)),
        `the list render's ids drifted from the create echoes: ${JSON.stringify((before.json ?? []).map((r) => [r.rule_name, r.id]))}`);
      const prio = await api(`/repos/${ctx.user}/${ctx.repo}/branch_protections/priority`, { method: "POST", body: { ids } });
      expect(prio.status === 204, `priority status ${prio.status} (expected 204): ${prio.text.slice(0, 160)}`);
      const list = await api(`/repos/${ctx.user}/${ctx.repo}/branch_protections`);
      const order = (list.json ?? []).map((r) => `${r.rule_name}(${r.priority})`);
      expect(list.json?.length === 2 && list.json[0]?.rule_name === ctx.devRule && list.json[0]?.priority === 1 &&
          list.json[1]?.rule_name === "main" && list.json[1]?.priority === 2,
        `the list did not follow the swap: [${order.join(", ")}] (expected [${ctx.devRule}(1), main(2)])`);
      return `priority swap 204 — the list renumbered to [${order.join(", ")}] (ids straight off the API render)`;
    },
  },
  {
    id: "bp-push-protected-rejected",
    expect: `THE PUSH GATE: one REAL push carrying TWO refs — a fast-forward to the protected main + a create of the unprotected ${ctx.featureBranch} — answers the per-ref report rejection for main (git exit 1, "! [remote rejected] … (Not allowed to push to protected branch main)") while the sibling LANDS; ls-remote pins main at the pre-push tip`,
    run: async () => {
      const work = path.join(ctx.tmp, "work");
      let r = await git(["clone", gitUrl(ctx.user, ctx.repo), "work"], ctx.tmp, { auth: true });
      expect(r.ok, `clone failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
      r = await git(["rev-parse", "HEAD"], work);
      expect(r.ok, `rev-parse HEAD failed: ${r.stderr.trim()}`);
      ctx.c1 = r.stdout.trim();
      await writeFile(path.join(work, "bp.txt"), `deploy-probes branch-protection ${ctx.featureBranch}\n`);
      r = await git(["add", "-A"], work);
      expect(r.ok, `git add failed: ${r.stderr.trim()}`);
      r = await git(["-c", "user.name=cf-gitea-probes", "-c", "user.email=probes@cf-gitea.invalid",
        "commit", "-m", "deploy-probes: branch-protection push-arm commit"], work);
      expect(r.ok, `git commit failed: ${r.stderr.trim()}`);
      r = await git(["rev-parse", "HEAD"], work);
      expect(r.ok, `rev-parse HEAD failed: ${r.stderr.trim()}`);
      ctx.c2 = r.stdout.trim();
      // ONE command, TWO refspecs (the landed unit test's per-ref shape —
      // branch-protection-push.test.ts's "sibling lands" arm over the wire).
      r = await git(["push", "origin", "main:refs/heads/main", `main:refs/heads/${ctx.featureBranch}`], work, { auth: true });
      expect(!r.ok, `the protected push was ACCEPTED (exit 0) — the rule on main (enable_push false) did not bite`);
      expect(r.code === 1, `push exit ${r.code} (expected 1 — a report rejection; 128 would mean the gate refused at the DOOR instead of per-ref): ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
      expect(r.stderr.includes("remote rejected") && r.stderr.includes("Not allowed to push to protected branch main"),
        `stderr does not carry the upstream per-ref text: ${r.stderr.trim().slice(0, 240)}`);
      const done = await poll(SETTLE_MS, async () => {
        const lr = await lsRemote(gitUrl(ctx.user, ctx.repo), { auth: true });
        return lr.ok && lr.refs.has(`refs/heads/${ctx.featureBranch}`) ? lr : null;
      });
      expect(done !== null, `the unprotected sibling never landed within ${SETTLE_MS} ms (the rejection took the whole push?)`);
      expect(done.refs.get("refs/heads/main") === ctx.c1,
        `main MOVED to ${done.refs.get("refs/heads/main")} despite the rejection (per-ref isolation lost)`);
      expect(done.refs.get(`refs/heads/${ctx.featureBranch}`) === ctx.c2,
        `the sibling tip ${done.refs.get(`refs/heads/${ctx.featureBranch}`)} != the pushed commit ${ctx.c2}`);
      return `main rejected ("Not allowed to push to protected branch main", exit 1, still at ${ctx.c1.slice(0, 10)}…); sibling landed at ${ctx.c2.slice(0, 10)}…`;
    },
  },
  {
    id: "bp-pr-open-201",
    expect: `POST /repos/${ctx.user}/${ctx.repo}/pulls {"head":"${ctx.featureBranch}","base":"main"} → 201 (the PR into the protected branch — protection never gates PR creation) + settle-polled GET until mergeable leaves null (budget 15s), head.sha = the push-arm commit`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.repo}/pulls`, {
        method: "POST",
        body: { title: `deploy-probes branch-protection ${ctx.featureBranch}`, head: ctx.featureBranch, base: "main" },
      });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 200)}`);
      expect(Number.isInteger(res.json?.number) && res.json.number > 0, `no PR number in the body: ${res.text.slice(0, 120)}`);
      ctx.prNumber = res.json.number;
      const pr = await poll(15_000, async () => {
        const get = await api(`/repos/${ctx.user}/${ctx.repo}/pulls/${ctx.prNumber}`);
        return get.status === 200 && get.json?.mergeable !== null && get.json?.mergeable !== undefined ? get.json : null;
      });
      expect(pr !== null, `PR #${ctx.prNumber} never resolved with a non-null mergeable within 15 s`);
      expect(pr.head?.sha === ctx.c2, `head.sha ${pr.head?.sha} != the push-arm commit ${ctx.c2}`);
      return `PR #${ctx.prNumber} open into the protected main, mergeable ${pr.mergeable}`;
    },
  },
  {
    id: "bp-merge-blocked-405",
    expect: `THE MERGE GATE (blocked arm): POST …/pulls/${"{N}"}/merge {"do":"merge"} with 0 approvals on a required_approvals-1 rule → 405 with the verbatim ErrNotReadyToMerge text "Does not have enough approvals" (checkPullBranchProtections, merge.go:694-742)`,
    run: async () => {
      expect(Number.isInteger(ctx.prNumber), "no open PR from the prior arms (fixture missing)");
      const res = await api(`/repos/${ctx.user}/${ctx.repo}/pulls/${ctx.prNumber}/merge`, { method: "POST", body: { do: "merge" } });
      expect(res.status === 405, `status ${res.status} (expected 405 — the protection verdict family): ${res.text.slice(0, 160)}`);
      expect(res.json?.message === "Does not have enough approvals",
        `message ${JSON.stringify(res.json?.message)} (expected the verbatim upstream text)`);
      return `405 verbatim: ${res.json?.message}`;
    },
  },
  {
    id: "bp-member-setup-204s",
    expect: `the approval fixtures via the API (the fixwave member methodology): POST /admin/users → 201; POST /users/${"{name}"}/tokens {"scopes":["all"]} → 201 over HTTP BASIC (upstream's reqBasicAuth gate; the one-time plaintext scrubbed); PUT /repos/${"{owner}/{repo}"}/collaborators/${"{name}"} {"permission":"write"} → 204 (write access = official reviewer without the approvals whitelist)`,
    run: async () => {
      const user = await api("/admin/users", {
        method: "POST",
        body: { username: ctx.member, email: `${ctx.member}@probes.cf-gitea.invalid`, visibility: "private", must_change_password: false },
      });
      if (user.status === 201) ctx.memberCreated = true; // mark on the observable write
      expect(user.status === 201, `user status ${user.status} (expected 201 — an ADMIN PAT is required): ${user.text.slice(0, 160)}`);
      const tok = await api(`/users/${ctx.member}/tokens`, {
        method: "POST", basic: { user: ctx.user, pass: TOKEN }, body: { name: `bp-${hexId()}`, scopes: ["all"] },
      });
      expect(tok.status === 201, `token status ${tok.status} (expected 201 — the mint rides HTTP BASIC, upstream's token-CRUD gate): ${tok.text.slice(0, 160)}`);
      const plaintext = String(tok.json?.sha1 ?? "");
      secrets.push(plaintext); // scrub BEFORE any assert detail could carry it
      expect(plaintext.length > 0, `no one-time plaintext in the mint body: ${scrub(tok.text.slice(0, 120))}`);
      ctx.memberToken = plaintext;
      ctx.memberTokenId = tok.json?.id;
      const collab = await api(`/repos/${ctx.user}/${ctx.repo}/collaborators/${ctx.member}`, {
        method: "PUT", body: { permission: "write" },
      });
      expect(collab.status === 204, `collaborator status ${collab.status} (expected 204): ${collab.text.slice(0, 120)}`);
      return `member ${ctx.member} + write collaborator + minted token id ${ctx.memberTokenId}`;
    },
  },
  {
    id: "bp-approval-official-200",
    expect: `the collaborator approves: POST …/pulls/${"{N}"}/reviews {"event":"APPROVED"} AS THE MEMBER → 200 with state APPROVED and official:true (protected_branch.go:264-289's write-access arm — an unofficial approval would not count toward required_approvals)`,
    run: async () => {
      expect(ctx.memberToken !== null && Number.isInteger(ctx.prNumber), "no member token / PR from the prior arms (fixture missing)");
      const res = await api(`/repos/${ctx.user}/${ctx.repo}/pulls/${ctx.prNumber}/reviews`, {
        method: "POST", asToken: ctx.memberToken, body: { event: "APPROVED", body: "deploy-probes branch-protection approval" },
      });
      expect(res.status === 200, `status ${res.status} (expected 200): ${res.text.slice(0, 160)}`);
      expect(res.json?.state === "APPROVED", `state ${res.json?.state} (expected APPROVED): ${res.text.slice(0, 160)}`);
      expect(res.json?.official === true, `official ${res.json?.official} (expected true — write access is official without the approvals whitelist)`);
      return `official approval landed (state APPROVED, official true)`;
    },
  },
  {
    id: "bp-merge-satisfied-200",
    expect: `THE MERGE GATE (satisfied arm): the SAME merge → 200 (required_approvals now met; has-merged GET → 204), and main advanced past the pre-push tip ${ctx.c1 ?? "<the pre-push tip>"} (the merge commit landed on the protected branch)`,
    run: async () => {
      expect(Number.isInteger(ctx.prNumber), "no open PR from the prior arms (fixture missing)");
      const res = await api(`/repos/${ctx.user}/${ctx.repo}/pulls/${ctx.prNumber}/merge`, { method: "POST", body: { do: "merge" } });
      expect(res.status === 200, `merge status ${res.status} (expected 200 once the approval is in): ${res.text.slice(0, 160)}`);
      const check = await api(`/repos/${ctx.user}/${ctx.repo}/pulls/${ctx.prNumber}/merge`);
      expect(check.status === 204, `has-merged GET status ${check.status} (expected 204)`);
      const lr = await lsRemote(gitUrl(ctx.user, ctx.repo), { auth: true });
      expect(lr.ok && lr.refs.get("refs/heads/main") !== ctx.c1,
        `main is still at the pre-push tip ${ctx.c1} — the merge commit never landed on the protected branch`);
      return `PR #${ctx.prNumber} merged (200 + has-merged 204); main advanced to ${lr.refs.get("refs/heads/main")?.slice(0, 10)}…`;
    },
  },
  {
    id: "bp-flags-roundtrip",
    expect: `THE WHITELIST/ENFORCE-ADMINS ROUND-TRIP (M4): POST a GLOB rule "${ctx.globRule}" carrying the enforceable flag set (push/force-push/deletion whitelists + merge whitelist + bypass allowlist + approvals whitelist, all [<owner>]; required_approvals 2; block_on_outdated_branch, block_admin_merge_override; status-check contexts; protected-file patterns) → 201 echoing EVERY field (branch_name "" — the glob name is special; the M4 sanitizer keeps the owner, who holds write/any-access, in every list) and the GET echoes it again`,
    run: async () => {
      ctx.rules.push({ name: ctx.globRule, id: null, created: false, gone: false });
      const ownerList = [ctx.user];
      const res = await createRule(ctx, {
        rule_name: ctx.globRule,
        enable_push: true, enable_push_whitelist: true, push_whitelist_usernames: ownerList,
        enable_force_push: true, enable_force_push_allowlist: true, force_push_allowlist_usernames: ownerList,
        enable_deletion: true, enable_deletion_allowlist: true, deletion_allowlist_usernames: ownerList,
        enable_merge_whitelist: true, merge_whitelist_usernames: ownerList,
        enable_bypass_allowlist: true, bypass_allowlist_usernames: ownerList,
        required_approvals: 2, enable_approvals_whitelist: true, approvals_whitelist_username: ownerList,
        block_on_outdated_branch: true, dismiss_stale_approvals: true, block_admin_merge_override: true,
        enable_status_check: true, status_check_contexts: ["ci/bp-probe"],
        protected_file_patterns: "docs/**",
      });
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 200)}`);
      expectRuleFields(res.json, [
        ["rule_name", ctx.globRule], ["branch_name", ""], // isRuleNameSpecial — the deprecated field renders EMPTY for a glob
        ["enable_push", true], ["enable_push_whitelist", true], ["push_whitelist_usernames", ownerList],
        ["enable_force_push", true], ["enable_force_push_allowlist", true], ["force_push_allowlist_usernames", ownerList],
        ["enable_deletion", true], ["enable_deletion_allowlist", true], ["deletion_allowlist_usernames", ownerList],
        ["enable_merge_whitelist", true], ["merge_whitelist_usernames", ownerList],
        ["enable_bypass_allowlist", true], ["bypass_allowlist_usernames", ownerList],
        ["required_approvals", 2], ["enable_approvals_whitelist", true], ["approvals_whitelist_username", ownerList],
        ["block_on_outdated_branch", true], ["dismiss_stale_approvals", true], ["block_admin_merge_override", true],
        ["enable_status_check", true], ["status_check_contexts", ["ci/bp-probe"]],
        ["protected_file_patterns", "docs/**"],
      ], "the create echo");
      const read = await api(`/repos/${ctx.user}/${ctx.repo}/branch_protections/${encodeURIComponent(ctx.globRule)}`);
      expect(read.status === 200, `GET status ${read.status} (expected 200): ${read.text.slice(0, 160)}`);
      expectRuleFields(read.json, [
        ["rule_name", ctx.globRule], ["branch_name", ""], ["merge_whitelist_usernames", ownerList],
        ["approvals_whitelist_username", ownerList], ["block_admin_merge_override", true],
      ], "the GET render");
      return `the flag set round-trips field-faithfully (glob → branch_name ""; the owner survived every whitelist filter)`;
    },
  },
  {
    id: "bp-flags-cascade-edit",
    expect: `THE CASCADE (branch.go:894-936): PATCH "${ctx.globRule}" {"enable_push":false} → 200 where the push master flips its flags off and the re-conjunction clears the deletion pair (enable_push + enable_push_whitelist false, enable_deletion + enable_deletion_allowlist false, deletion_allowlist_usernames [] — the disabled arm's array scrub) while the stored id lists SURVIVE their disabled flags (upstream keeps WhitelistUserIDs on a flag-off edit and the render maps ids→names regardless: push/force-push/merge/bypass/approvals lists stay [<owner>]) and the other absent arms keep theirs (required_approvals 2, status-check, block_admin_merge_override)`,
    run: async () => {
      const res = await api(`/repos/${ctx.user}/${ctx.repo}/branch_protections/${encodeURIComponent(ctx.globRule)}`, {
        method: "PATCH", body: { enable_push: false },
      });
      expect(res.status === 200, `status ${res.status} (expected 200): ${res.text.slice(0, 160)}`);
      expectRuleFields(res.json, [
        ["enable_push", false], ["enable_push_whitelist", false],
        ["enable_deletion", false], ["enable_deletion_allowlist", false], ["deletion_allowlist_usernames", []],
        // The flag-off edit KEEPS the stored id lists (upstream branch.go: only
        // the enable flags flip; the render maps ids→names regardless), and
        // every absent arm keeps its stored value (the pointer semantics).
        ["push_whitelist_usernames", [ctx.user]],
        ["enable_force_push", true], ["enable_force_push_allowlist", true],
        ["force_push_allowlist_usernames", [ctx.user]],
        ["enable_merge_whitelist", true], ["merge_whitelist_usernames", [ctx.user]],
        ["enable_bypass_allowlist", true], ["bypass_allowlist_usernames", [ctx.user]],
        ["required_approvals", 2], ["enable_approvals_whitelist", true], ["approvals_whitelist_username", [ctx.user]],
        ["enable_status_check", true], ["status_check_contexts", ["ci/bp-probe"]],
        ["block_admin_merge_override", true],
      ], "the cascade echo");
      return `the flags flipped off + the deletion pair scrubbed; the id lists and absent arms kept (upstream branch.go:894-936)`;
    },
  },
  {
    id: "bp-slash-glob-wildcard",
    expect: `THE SLASH-GLOB WILDCARD (the second recorded gap): POST a GLOB rule "${ctx.slashGlobRule}" — a name the single-segment {name} declaration cannot match — → 201 echoing the addressable id; GET …/branch_protections/${ctx.slashGlobRule} with the LITERAL slash → 200 (the wildcard route, upstream's chi m.Group("/*") + ctx.PathParam("*"), api.go:1328-1332 + branch.go:556) rendering branch_name "" + the same id; PATCH it through the same path → 200 echoing the patch; DELETE → 204 then GET → 404; the percent-encoded %2F form answers 200 through the DECLARED {name} route too`,
    run: async () => {
      ctx.rules.push({ name: ctx.slashGlobRule, id: null, created: false, gone: false });
      const created = await createRule(ctx, { rule_name: ctx.slashGlobRule, enable_status_check: true, status_check_contexts: ["ci/bp-slash-glob"] });
      expect(created.status === 201, `create status ${created.status} (expected 201): ${created.text.slice(0, 200)}`);
      expect(Number.isInteger(created.json?.id) && created.json.id > 0, `no addressable id on the create echo: ${created.text.slice(0, 120)}`);
      // LITERAL slash in the path — the wildcard sibling's arm
      const base = `/repos/${ctx.user}/${ctx.repo}/branch_protections/${ctx.slashGlobRule}`;
      const read = await api(base);
      expect(read.status === 200, `wildcard GET status ${read.status} (expected 200): ${read.text.slice(0, 160)}`);
      expectRuleFields(read.json, [
        ["rule_name", ctx.slashGlobRule], ["branch_name", ""], // isRuleNameSpecial — the glob name renders the deprecated field EMPTY
        ["id", created.json.id], ["enable_status_check", true], ["status_check_contexts", ["ci/bp-slash-glob"]],
      ], "the wildcard GET render");
      const patched = await api(base, { method: "PATCH", body: { required_approvals: 1 } });
      expect(patched.status === 200, `wildcard PATCH status ${patched.status} (expected 200): ${patched.text.slice(0, 160)}`);
      expectRuleFields(patched.json, [["rule_name", ctx.slashGlobRule], ["required_approvals", 1], ["enable_status_check", true]], "the wildcard PATCH echo");
      // the same rule through the DECLARED route: %2F stays one segment
      const encoded = await api(`${base.slice(0, base.lastIndexOf("/"))}%2Fv*`);
      expect(encoded.status === 200, `encoded GET status ${encoded.status} (expected 200 via the {name} route): ${encoded.text.slice(0, 160)}`);
      expectRuleFields(encoded.json, [["rule_name", ctx.slashGlobRule], ["required_approvals", 1]], "the encoded GET render");
      // self-contained delete through the wildcard (tracked gone for the sweep)
      const deleted = await api(base, { method: "DELETE" });
      expect(deleted.status === 204, `wildcard DELETE status ${deleted.status} (expected 204)`);
      const track = ctx.rules.find((r) => r.name === ctx.slashGlobRule);
      if (track) track.gone = true;
      const after = await api(base);
      expect(after.status === 404, `wildcard GET after delete ${after.status} (expected 404)`);
      return `slash-glob rule addressed end to end through the wildcard path (201 → 200 → 200 → 204 → 404; the %2F form rides the declared route)`;
    },
  },
  {
    id: "bp-cleanup",
    expect: `everything DELETEd: every created rule (204 each; the list back to []), the repo (204 — its delete cascades any surviving rule rows), the member's token (204, HTTP BASIC) + the member user (204) — a failed cleanup is documented, not fatal (the failure-tail re-sweeps)`,
    run: async () => {
      const parts = [];
      for (const rule of ctx.rules) {
        if (!rule.created || rule.gone) continue;
        const status = await deleteRule(ctx, rule.name);
        parts.push(status === 204 ? `rule ${rule.name} deleted` : `rule ${rule.name} LEFT BEHIND — DELETE returned ${status}`);
      }
      const list = await api(`/repos/${ctx.user}/${ctx.repo}/branch_protections`);
      expect(list.status === 200 && Array.isArray(list.json) && list.json.length === 0,
        `the rule list should be empty after the deletes (got ${JSON.stringify(list.json?.map((r) => r.rule_name))})`);
      parts.push("the rule list is empty");
      const repo = await deleteRepo(ctx.user, ctx.repo);
      if (typeof repo === "string") ctx.repoGone = true;
      parts.push(typeof repo === "string" ? repo : repo.detail);
      if (ctx.memberCreated) {
        if (ctx.memberTokenId !== null && ctx.memberTokenId !== undefined) {
          // Token CRUD is HTTP-BASIC-gated (the mint arm's live finding): the
          // revoke rides the same Basic credential, never the token header.
          const tok = await api(`/users/${ctx.member}/tokens/${ctx.memberTokenId}`, {
            method: "DELETE", basic: { user: ctx.user, pass: TOKEN },
          });
          parts.push(tok.status === 204 ? `member token ${ctx.memberTokenId} revoked` : `member token revoke returned ${tok.status}`);
        }
        const user = await api(`/admin/users/${ctx.member}`, { method: "DELETE" });
        if (user.status === 204) { ctx.memberGone = true; parts.push(`user ${ctx.member} deleted`); }
        else parts.push(`user ${ctx.member} LEFT BEHIND — DELETE returned ${user.status}`);
      }
      const bad = parts.filter((p) => p.includes("LEFT BEHIND") || p.includes("returned"));
      if (bad.length === 0) return `${parts.length} cleanups — all 204`;
      return { status: "warn", detail: bad.join("; ") };
    },
  },
];

/** The red-runs-self-sweep posture (the fixwave shape) for the chained
 *  branch-protection battery: rules FIRST (best-effort explicit deletes, so a
 *  failed repo delete still lands the audit back at protected_branches == 0),
 *  then the repo (its delete cascades the rest — repos/service.ts:652), then
 *  the member's token + the member user (the PAT rows are FK cascades). One
 *  [tail] line logs every action; failures feed left_behind and are never
 *  fatal; it never throws (main's finally depends on it). */
const branchProtectionFailureCleanup = async (ctx) => {
  const acts = [];
  const noteLeftBehind = (what, why) => {
    leftBehind.push(`${what} (failure-cleanup tail: ${why})`);
    acts.push(`${what} LEFT BEHIND — ${why}`);
  };
  try {
    for (const rule of ctx.rules) {
      if (rule.created !== true || rule.gone === true) continue;
      try {
        const status = await deleteRule(ctx, rule.name);
        if (status === 204) acts.push(`rule ${rule.name} deleted (204)`);
        else noteLeftBehind(`rule ${rule.name}`, `DELETE returned ${status}`);
      } catch (err) {
        noteLeftBehind(`rule ${rule.name}`, `DELETE threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (ctx.repoCreated === true && ctx.repoGone !== true) {
      try {
        const out = await deleteRepo(ctx.user, ctx.repo);
        acts.push(typeof out === "string" ? out : out.detail);
      } catch (err) {
        noteLeftBehind(`repo ${ctx.repoFullName ?? `${ctx.user}/${ctx.repo}`}`, `DELETE threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (ctx.memberCreated === true && ctx.memberGone !== true) {
      if (ctx.memberTokenId !== null && ctx.memberTokenId !== undefined) {
        try {
          const tok = await api(`/users/${ctx.member}/tokens/${ctx.memberTokenId}`, {
            method: "DELETE", basic: { user: ctx.user, pass: TOKEN },
          });
          if (tok.status === 204) acts.push(`member token ${ctx.memberTokenId} revoked (204)`);
          else acts.push(`member token revoke returned ${tok.status}`);
        } catch (err) {
          noteLeftBehind(`member token ${ctx.memberTokenId}`, `DELETE threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      try {
        const res = await api(`/admin/users/${ctx.member}`, { method: "DELETE" });
        if (res.status === 204) acts.push(`user ${ctx.member} deleted (204)`);
        else noteLeftBehind(`user ${ctx.member}`, `DELETE returned ${res.status}`);
      } catch (err) {
        noteLeftBehind(`user ${ctx.member}`, `DELETE threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    acts.push(`the sweep itself failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (acts.length) log(`  [tail] bp-leftover-sweep (best-effort failure cleanup) — ${scrub(acts.join("; "))}`);
};

// ---------- battery: demo (the SPEC-0014 demo-posture battery) ----------

/**
 * The SPEC-0014 §7 battery: the deployed demo instance's POSTURE, in four
 * independent arms (the fixwave/cleanup-audit shape — a red arm never
 * chain-skips the rest):
 *
 *   1. demo-config-posture — the committed deploy config's machinery (the
 *      source every deploy is cut from): hourly cron entry beside the
 *      standing cadence (§3.1), the repo-tasks consumer's dead_letter_queue
 *      + the DLQ consumer entry (M0, §3.0), and DEMO_MODE default "false" in
 *      BOTH wrangler.jsonc and wrangler.jsonc.example — the §2 hard
 *      invariant's config arm (a default deployment never arms). The
 *      deployed instance's armed state rides the banner arm + the README ops
 *      notes (queue-consumer registration and log lines have no HTTP probe).
 *   2. demo-banner-present — anonymous GET / carries the §4.4 demo banner:
 *      the `id="demo-banner"` notice with the approved parameter text, the
 *      dismiss control, and the sessionStorage dismissal script. M2 IS IN
 *      FLIGHT (the banner unit lands after M1): until it deploys, a miss is
 *      the documented [warn] degradation (the window2-mounts shape — the
 *      page legitimately renders no node pre-M2); anything mounted asserts
 *      hard. The markers assert the M2 landing's shape as specified at this
 *      battery's writing (shell.tsx's DemoBanner + the coordination note);
 *      a shape drift at the M2 landing review moves the asserts with it.
 *   3. signup-open — anonymous GET /user/sign_up → 200 with the registration
 *      form: the ALLOW_SIGNUP=true demo posture (OQ-1's resolved convergence
 *      — one registration surface for self-host and demo; the demo enables
 *      the var). The route is LANDED (ui/first-run.ts, the first-run wave),
 *      so a 404 (the gate's closed shape) is a posture RED, not a mount-timing
 *      warn — running this battery against a default (self-host) deployment
 *      reds this arm BY DESIGN.
 *   4. demo-ttl-mechanics — the deep arm, LOCAL-ONLY: with DEMO_MODE=true in
 *      .dev.vars and --d1-scope local against pnpm dev, fabricate the M1
 *      unit's recipe row (auto_init repo via the API, then `created_at`
 *      backdated 73 h past retention and owner_id NULLed — the fail-safe
 *      swept arm, §3.1 step 2, which also makes the verdict independent of
 *      the PAT owner's is_admin), tick the hourly cron through miniflare's
 *      scheduled-trigger surface (/cdn-cgi/local/scheduled?cron=…, forwarded
 *      by the vite dev server — dev-only, a deployed worker has no such
 *      route), then poll the row gone: the producer enqueues
 *      {kind:"demo-sweep"} and the consumer's delete cascade deletes it —
 *      row-deletion IS the sweep's claim (§3.1, no CAS). On a DEPLOYED
 *      target the arm records an ops-note [info] and never writes D1: the
 *      hourly tick is observable only via the [demo-sweep] log line (Cloudflare
 *      dashboard, Workers → Logs — one line per tick including 0-eligible),
 *      and fabricating rows on production D1 is out of a probe's posture.
 *
 * All four arms are read-only or self-cleaning; the TTL repo is the only
 * server-side state any arm creates (the failureTail sweeps it — D1 first,
 * the backdate NULLed the owner so the API delete may not resolve, then the
 * best-effort API DELETE).
 */

/** The hourly cron entry the sweep dispatches on — the string mirror of
 *  services/demo-sweep.ts's DEMO_SWEEP_CRON (kept a literal here; the config
 *  arm asserts the same string in both committed configs). */
const DEMO_HOURLY_CRON = "0 * * * *";

/** The TTL arm's settle budget: local queue delivery + the consumer's delete
 *  cascade are sub-second once warm, but each poll iteration is one
 *  `wrangler d1 execute` (~2-4 s), so the budget covers ~10 iterations plus
 *  cold-start slack. (The mirror battery's 30 s precedent, scaled up.) */
const TTL_SETTLE_MS = 45_000;

/** Tolerant JSONC parse for the committed wrangler configs: a string-aware
 *  state machine strips `//` line comments (URLs like `https://…` and the
 *  standing 10-minute cron entry survive unharmed) and trailing commas,
 *  then JSON.parse. */
const parseJsonc = (text) => {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue; // drop the trailing comma
    }
    out += ch;
  }
  return JSON.parse(out);
};

/** The demo-machinery posture of ONE committed wrangler config (§2/§3.0/
 *  §3.1): returns the drift list (empty = the posture holds). */
const demoConfigDrift = (config, label) => {
  const drift = [];
  const crons = config?.triggers?.crons;
  if (!Array.isArray(crons)) drift.push(`${label}: triggers.crons missing`);
  else {
    if (!crons.includes(DEMO_HOURLY_CRON)) drift.push(`${label}: crons missing the hourly "${DEMO_HOURLY_CRON}" entry (§3.1)`);
    if (!crons.includes("*/10 * * * *")) drift.push(`${label}: crons missing the standing "*/10 * * * *" entry`);
  }
  const consumers = config?.queues?.consumers;
  if (!Array.isArray(consumers)) drift.push(`${label}: queues.consumers missing`);
  else {
    const repoTasks = consumers.find((c) => c?.queue === "repo-tasks");
    if (repoTasks?.dead_letter_queue !== "repo-tasks-dlq") {
      drift.push(`${label}: the repo-tasks consumer carries no dead_letter_queue "repo-tasks-dlq" (§3.0/M0)`);
    }
    if (!consumers.some((c) => c?.queue === "repo-tasks-dlq")) {
      drift.push(`${label}: no repo-tasks-dlq consumer entry (§3.0/M0)`);
    }
  }
  // DEMO_MODE posture (revised 2026-10-29): the §2 hard invariant binds the
  // EXAMPLE template (a default self-host deployment never arms) — the
  // example MUST carry "false". The LIVE wrangler.jsonc may carry either:
  // "false" (self-host posture) or "true" ONLY as the deliberate reference-
  // instance posture, which is exactly characterized by the demo custom
  // domain route — armed without the route would put the bare workers.dev
  // surface into demo quotas with no demo face, which is never intended.
  // Pre-revision this check hard-required "false" in both files and false-
  // fired on every post-demo-launch deploy (observed run of 2026-10-29).
  const demoRoute = Array.isArray(config?.routes) && config.routes.some((r) => typeof r?.pattern === "string" && r.pattern.includes("cf-gitea-demo"));
  if (config?.vars?.DEMO_MODE === "true") {
    if (label === "wrangler.jsonc.example" || !demoRoute) {
      drift.push(`${label}: vars.DEMO_MODE "true" ${label === "wrangler.jsonc.example" ? "in the example template (the §2 hard invariant — a default deployment never arms)" : "without the cf-gitea-demo route (armed demo posture on a bare surface is never the intent)"}`);
    }
  } else if (config?.vars?.DEMO_MODE !== "false") {
    drift.push(`${label}: vars.DEMO_MODE is ${JSON.stringify(config?.vars?.DEMO_MODE)} (expected "false", or "true" with the demo route)`);
  }
  return drift;
};

const demoContext = () => ({
  ttl: null, // { repo, fullName, created, rowGone } — the TTL arm's fabricated repo
});

const demoSteps = (ctx) => [
  {
    id: "demo-config-posture",
    expect: `the committed deploy configs (wrangler.jsonc + wrangler.jsonc.example — the source every deploy is cut from) carry the demo machinery: the hourly "${DEMO_HOURLY_CRON}" cron entry beside the standing "*/10 * * * *" (§3.1), the repo-tasks consumer's dead_letter_queue "repo-tasks-dlq" + the repo-tasks-dlq consumer entry (M0, §3.0), and vars.DEMO_MODE defaulting to "false" in BOTH (the §2 hard invariant — a default deployment never arms)`,
    run: async () => {
      const live = parseJsonc(await readFile(path.join(workerDir, "wrangler.jsonc"), "utf8"));
      const example = parseJsonc(await readFile(path.join(workerDir, "wrangler.jsonc.example"), "utf8"));
      const drift = [...demoConfigDrift(live, "wrangler.jsonc"), ...demoConfigDrift(example, "wrangler.jsonc.example")];
      expect(drift.length === 0, drift.join("; "));
      return `both configs carry the hourly "${DEMO_HOURLY_CRON}" cron + the repo-tasks-dlq wiring (M0) with DEMO_MODE defaulting "false" — the §2 invariant holds at the config layer (the deployed instance's armed state rides the banner arm + the ops notes)`;
    },
  },
  {
    id: "demo-banner-present",
    expect: `GET / (anonymous) → 200 carrying the SPEC-0014 §4.4 demo banner: the id="demo-banner" notice with the "data on this instance is periodically cleaned" text, the id="demo-banner-dismiss" control, and the cf-gitea-demo-banner-dismissed sessionStorage dismissal script (the M2 marker shape as specified at this battery's writing). M2 IN FLIGHT: until the banner wave deploys, a miss is the documented [warn] — pre-M2 the page legitimately renders no node`,
    run: async () => {
      const res = await fetchT(`${opts.baseUrl}/`);
      const body = await res.text();
      expect(res.status === 200, `status ${res.status} (expected 200): ${body.slice(0, 120)}`);
      if (!body.includes(`id="demo-banner"`)) {
        return {
          status: "warn",
          detail: `no demo-banner node on the anonymous page — SPEC-0014 M2 (the §4.4 banner) is not yet mounted on this deployment; the arm asserts hard once it lands (absence ALSO matches a DEMO_MODE-off posture, which is wrong for the demo target)`,
        };
      }
      expect(body.includes("data on this instance is periodically cleaned"), `the banner node is present but the §4.4 text is missing`);
      expect(body.includes(`id="demo-banner-dismiss"`), `the banner node is present but the dismiss control is missing (§4.4: dismissible per session)`);
      expect(body.includes("cf-gitea-demo-banner-dismissed"), `the banner node is present but the sessionStorage dismissal script is missing (§4.4: the dismissal never round-trips the server)`);
      return `the §4.4 banner renders on GET / (id="demo-banner", dismissible per session) — the DEMO_MODE-on posture`;
    },
  },
  {
    id: "signup-open",
    expect: `GET /user/sign_up (anonymous) → 200 carrying the registration form (action="/user/sign_up" + the user_name field) — the ALLOW_SIGNUP=true demo posture (OQ-1's resolved convergence). The landed gate 404s while closed: a 404 is a posture RED (the demo target must have the var on; a default self-host deployment reds this arm by design)`,
    run: async () => {
      const res = await fetchT(`${opts.baseUrl}/user/sign_up`);
      const body = await res.text();
      expect(res.status === 200,
        `status ${res.status} (expected 200): ${body.slice(0, 120)}${res.status === 404 ? " — the ALLOW_SIGNUP gate is CLOSED here (the demo posture requires it open; on LOCAL dev note: undeclared names in .dev.vars are silently ignored — only vars declared in wrangler.jsonc load, so the open posture cannot be armed locally without a config edit)" : ""}`);
      expect(body.includes(`action="/user/sign_up"`), `no registration form (action="/user/sign_up") in the body: ${body.slice(0, 200)}`);
      expect(body.includes(`name="user_name"`), `no user_name field in the registration form`);
      return `200 — the registration form renders anonymously (ALLOW_SIGNUP open — the demo posture)`;
    },
  },
  {
    id: "demo-ttl-mechanics",
    expect: `THE 72 h TTL MECHANICS (deep arm, --d1-scope local against pnpm dev with DEMO_MODE=true in .dev.vars; a deployed target records an ops-note info): fabricate the M1 recipe row — POST /user/repos {"name":"demo-ttl-<hex>","auto_init":true} → 201, then wrangler d1 (--local) backdates created_at 73 h and NULLs owner_id (the fail-safe swept arm, §3.1 step 2) — then tick the hourly cron via miniflare's /cdn-cgi/local/scheduled?cron=<hourly> trigger (forwarded by the vite dev server; dev-only) → the gated producer enqueues {kind:"demo-sweep"} → the consumer's delete cascade lands — poll (budget 45 s) until the fabricated row is GONE (row-deletion IS the sweep's claim, §3.1)`,
    run: async () => {
      if (opts.d1Scope !== "local") {
        return {
          status: "info",
          detail: `documented skip on a deployed target — the hourly tick is observable only via the [demo-sweep] log line (Cloudflare dashboard, Workers → Logs: one line per tick, including 0-eligible; logs are not API-reachable and fabricating rows on production D1 is out of a probe's posture). The end-to-end mechanics run against pnpm dev: --d1-scope local --base-url http://127.0.0.1:5173 with DEMO_MODE=true in .dev.vars`,
        };
      }
      const repo = `demo-ttl-${hexId()}`;
      const ttl = { repo, fullName: null, created: false, rowGone: false };
      ctx.ttl = ttl;
      const res = await api("/user/repos", { method: "POST", body: { name: repo, private: false, auto_init: true } });
      if (res.status === 201) ttl.created = true; // mark on the observable write
      ttl.fullName = String(res.json?.full_name ?? `${opts.user}/${repo}`);
      expect(res.status === 201, `status ${res.status} (expected 201): ${res.text.slice(0, 120)}`);
      // THE M1 FABRICATION (demo-sweep.test.ts's seedRepo recipe): created_at
      // past retention, owner NULL — swept regardless of who owns the PAT.
      const backdated = Math.floor(Date.now() / 1000) - 73 * 60 * 60;
      await d1Exec(`UPDATE repositories SET created_at = ${backdated}, owner_id = NULL WHERE owner_namespace = '${opts.user}' AND slug = '${repo}'`);
      const seeded = await d1Row(`SELECT COUNT(*) AS n FROM repositories WHERE owner_namespace = '${opts.user}' AND slug = '${repo}' AND created_at = ${backdated} AND owner_id IS NULL`);
      expect(seeded.n === 1, `the backdate did not land (rows matching the aged/NULL-owner shape: ${seeded.n})`);
      // THE TICK: miniflare's scheduled-trigger surface dispatches the hourly
      // entry through handleScheduledCron — the dispatcher's strict cron
      // route lands ONLY the demo producer, which (gate armed) SELECTs and
      // enqueues. The consumer arm then drives the cascade on its own budget.
      const tick = await fetchT(`${opts.baseUrl}/cdn-cgi/local/scheduled?cron=${encodeURIComponent(DEMO_HOURLY_CRON)}`);
      const tickBody = (await tick.text()).trim();
      expect(tick.status === 200,
        `the scheduled trigger answered ${tick.status} (${tickBody.slice(0, 100)}) — the surface exists only on the local vite dev/miniflare server; run this arm with --d1-scope local against pnpm dev`);
      expect(tickBody === "ok", `the scheduled trigger outcome ${JSON.stringify(tickBody.slice(0, 100))} (expected "ok")`);
      // END STATE: row-deletion IS the claim (§3.1) — poll the row gone.
      const gone = await poll(TTL_SETTLE_MS, async () => {
        const row = await d1Row(`SELECT COUNT(*) AS n FROM repositories WHERE owner_namespace = '${opts.user}' AND slug = '${repo}'`);
        return row.n === 0 ? row : null;
      });
      expect(gone !== null,
        `the fabricated row survived ${TTL_SETTLE_MS} ms past the hourly tick — the sweep never deleted it (DEMO_MODE armed in .dev.vars? the queue delivering? the consumer arm mounted?)`);
      ttl.rowGone = true;
      return `the aged NULL-owner row is gone after one hourly tick (producer → {kind:"demo-sweep"} → the cascade deleted it); trigger outcome ok`;
    },
  },
];

/** The red-runs-self-sweep posture for the demo battery: the TTL arm's
 *  fabricated repo is the ONLY server-side state any arm creates (the three
 *  posture arms are read-only). Green runs arrive with the row already
 *  deleted by the sweep itself (rowGone); a red before the tick — or a sweep
 *  that never fired — sweeps it here: D1 first (the backdate NULLed the
 *  owner, so the API delete may not resolve), then the best-effort API
 *  DELETE. One [tail] line; never fatal; a green run no-ops silently. */
const demoFailureCleanup = async (ctx) => {
  const acts = [];
  const ttl = ctx.ttl;
  if (ttl && ttl.created === true && ttl.rowGone !== true) {
    if (opts.d1Scope === "local") {
      try {
        await d1Exec(`DELETE FROM repositories WHERE owner_namespace = '${opts.user}' AND slug = '${ttl.repo}'`);
        acts.push(`fabricated TTL repo ${ttl.repo} deleted (D1 --local)`);
      } catch (err) {
        acts.push(`fabricated TTL repo ${ttl.repo} D1 sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      const out = await deleteRepo(opts.user, ttl.repo);
      acts.push(typeof out === "string" ? out : out.detail);
    } catch (err) {
      acts.push(`repo ${ttl.fullName ?? ttl.repo} API delete threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (acts.length) log(`  [tail] demo-leftover-sweep (best-effort failure cleanup) — ${scrub(acts.join("; "))}`);
};

// ---------- battery: cleanup-audit (the D1 count shapes) ----------

const AUDIT_TABLES = [
  { key: "creating_rows", sql: `(SELECT COUNT(*) FROM "repositories" WHERE "status" = 'creating')`, want: () => 0, label: `repositories WHERE status='creating' (whole table)` },
  { key: "action_rows", sql: `(SELECT COUNT(*) FROM "action")`, want: () => 0, label: `"action" (whole table — the 389da18 delete sweep means NO hand-sweep)` },
  { key: "stars", sql: `(SELECT COUNT(*) FROM "stars")`, want: () => 0, label: `stars` },
  { key: "push_mirrors", sql: `(SELECT COUNT(*) FROM "push_mirrors")`, want: () => 0, label: `push_mirrors` },
  { key: "protected_branches", sql: `(SELECT COUNT(*) FROM "protected_branches")`, want: () => 0, label: `protected_branches` },
  { key: "repo_redirects", sql: `(SELECT COUNT(*) FROM "repo_redirects")`, want: () => 0, label: `repo_redirects` },
  { key: "user_blocking", sql: `(SELECT COUNT(*) FROM "user_blocking")`, want: () => 0, label: `user_blocking` },
];

/** One wrangler d1 execute (--json, --${opts.d1Scope}) → the parsed output
 *  array. The write-capable half of the D1 plumbing (the fixwave session-
 *  rotation arm backdates `sessions.rotated_at` through it — the toolkit's
 *  FIRST D1 WRITE path; until d1Exec the probes were read-only via d1Row).
 *  Writes carry no result rows; the caller picks what it needs. */
const d1Exec = async (sql) => {
  const r = await run("pnpm", ["exec", "wrangler", "d1", "execute", "cf-gitea", `--${opts.d1Scope}`, "--json", "--command", sql],
    { cwd: workerDir, timeoutMs: 120_000 });
  expect(r.ok, `wrangler d1 execute failed (code ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    throw new Error(`wrangler --json output is not JSON: ${r.stdout.slice(0, 200)}`);
  }
  return parsed;
};

/** One wrangler d1 execute (--json, --${opts.d1Scope}) → the first row of
 *  the last statement's results (the cleanup-audit + mirror row-settle reads). */
const d1Row = async (sql) => {
  const parsed = await d1Exec(sql);
  const row = parsed.at(-1)?.results?.[0];
  expect(row !== undefined, `no result row from the d1 query (raw: ${JSON.stringify(parsed).slice(0, 200)})`);
  return row;
};

const auditCounts = async () => {
  const sql = `SELECT (SELECT COUNT(*) FROM "repositories" WHERE "owner_namespace" = '${opts.user}') AS owner_repos, ` +
    AUDIT_TABLES.map((t) => `${t.sql} AS ${t.key}`).join(", ") +
    `, (SELECT COUNT(*) FROM "personal_access_tokens") AS personal_access_tokens`;
  return d1Row(sql);
};

const auditSteps = (ctx) => [
  {
    id: "audit-query",
    expect: `one wrangler d1 execute (--${opts.d1Scope}) runs the whole count shape`,
    run: async () => {
      ctx.counts = await auditCounts();
      return `owner_repos=${ctx.counts.owner_repos} creating=${ctx.counts.creating_rows} action=${ctx.counts.action_rows} ` +
        `stars=${ctx.counts.stars} push_mirrors=${ctx.counts.push_mirrors} protected_branches=${ctx.counts.protected_branches} ` +
        `repo_redirects=${ctx.counts.repo_redirects} user_blocking=${ctx.counts.user_blocking} tokens=${ctx.counts.personal_access_tokens}`;
    },
  },
  {
    id: "audit-owner-repos",
    expect: `repositories WHERE owner_namespace='${opts.user}' = ${opts.expectOwnerRepos} (the standing p0-shallow fixture, intentionally live)`,
    run: () => {
      const n = ctx.counts.owner_repos;
      expect(n === opts.expectOwnerRepos, `${n} repos for ${opts.user} (expected ${opts.expectOwnerRepos})`);
      return `${n} (the standing fixture)`;
    },
  },
  ...AUDIT_TABLES.map((t) => ({
    id: `audit-${t.key.replaceAll("_", "-")}`,
    expect: `${t.label} = 0`,
    run: () => {
      const n = ctx.counts[t.key];
      expect(n === 0, `${t.label} = ${n} (expected 0)`);
      return `${t.label} = 0`;
    },
  })),
  {
    id: "audit-personal-access-tokens",
    expect: `personal_access_tokens = the standing bootstrap set, one per standing user (admin + p0probe = 2 since the probe user gained its own bootstrap 2026-10-28; per-run PATs DELETEd by the operator — the historical whole-table=1 encoding predates the second standing user and false-fired from 2026-10-29)`,
    run: () => {
      const n = ctx.counts.personal_access_tokens;
      expect(n === opts.expectTokens, `${n} tokens (expected ${opts.expectTokens})`);
      return `${n} (the standing bootstrap set: one per standing user)`;
    },
  },
];

// ---------- battery registry ----------

const BATTERIES = {
  "p0": { title: "P0 shallow trio + privacy tail", context: p0Context, setup: p0Setup, steps: p0Steps, failureTail: p0FailureCleanup },
  "registry": { title: "registry tombstone sweep (carry + t+0 delete)", context: registryContext, steps: (ctx) => Array.from({ length: opts.trials }, (_, i) => registryTrialSteps(ctx, i + 1)).flat(), failureTail: registryFailureCleanup },
  "generate-e2e": { title: "template → generate → carried refs + contents", context: generateContext, steps: generateSteps, failureTail: generateFailureCleanup },
  "forkpr-e2e": { title: "fork → owner:branch PR chain", context: forkprContext, steps: forkprSteps, failureTail: forkprFailureCleanup },
  "mirror": { title: "push-mirror credential-free arms (SSRF gate + .invalid lifecycle)", context: mirrorContext, steps: mirrorSteps, failureTail: mirrorFailureCleanup },
  "ui-login": { title: "login-cookie labels owner view", context: uiContext, steps: uiSteps, failureTail: uiFailureCleanup },
  // Mount-at-run-time: tab 404s degrade to warns (the window-2 sub-wave is
  // still landing); mounted surfaces assert hard. The write arms (window-2a,
  // LIVE) are chain-hard.
  "window2-mounts": { title: "window-2 mounts (user-settings tab family: anon 303s, pageClass 200s, secret round-trip, keys negative, last-owner flash)", context: window2Context, steps: window2Steps, failureTail: window2FailureCleanup },
  // Mount-at-run-time: the window-3 surfaces (feed tails, wiki raw, profile
  // tabs, admin lists, settings account/notifications) 404-degrade to warns
  // until the mount window deploys; anything mounted asserts hard. The wiki
  // page write + issue/milestone seeds ride LANDED routes (chain-hard).
  "window3-mounts": { title: "window-3 mounts (feed tails, wiki raw, profile tabs, admin lists, settings account/notifications, milestone detail, content-history list)", context: window3Context, steps: window3Steps, failureTail: window3FailureCleanup },
  // Independent steps (the cleanup-audit precedent): each fix-wave family
  // reports its own verdict — a red family never chain-skips the rest of the
  // matrix (pre-RD23 every family legitimately reds; the post-deploy run is
  // the verdict). Needs an ADMIN PAT (POST /admin/users + the sudo pair) and
  // wrangler auth for the d1 arms (the rotation backdate + the session-row
  // sweep; --d1-scope picks the database).
  "fixwave-parity": { title: "fix-wave parity (PR head-sync → merged-PR 412 → ghost-404, tag-only push-create, org revoke mask, private-user ladder, sudo pair, session-rotation directive)", context: fixwaveContext, steps: fixwaveSteps, failureTail: fixwaveFailureCleanup, independent: true },
  // Chained (the shared-fixture shape — a red in the setup skips the arms
  // that need it, like registry/generate; NOT independent like fixwave).
  // Needs an ADMIN PAT (the member-user arm) and wrangler auth for the
  // priority arm's rule-id lookup (--d1-scope picks the database).
  "branch-protection": { title: "branch-protection flows (SPEC-0013: rule CRUD + priority, push-time per-ref rejection, merge approval gate 405→200, whitelist flag round-trip)", context: branchProtectionContext, steps: branchProtectionSteps, failureTail: branchProtectionFailureCleanup },
  // Independent (the fixwave/cleanup-audit posture shape): every demo arm
  // reports its own verdict. The banner arm reads its surface AT RUN TIME —
  // a miss while the M2 wave is still in flight is the documented [warn]
  // degradation; anything mounted asserts hard. The deep TTL arm is
  // local-only (--d1-scope local against pnpm dev; a deployed target
  // records the ops-note [info] and never writes D1).
  "demo": { title: "demo posture (SPEC-0014: config machinery + DEMO_MODE-off default, open signup, the §4.4 banner [warns pre-M2], the 72 h TTL mechanics — the deep arm local-only)", context: demoContext, steps: demoSteps, failureTail: demoFailureCleanup, independent: true },
  // Independent counts — one red count never hides the rest of the shape.
  "cleanup-audit": { title: "post-run D1 count shapes", context: () => ({}), steps: auditSteps, independent: true },
};

const batteryList = opts.battery === "all" ? ["p0", "registry", "generate-e2e", "forkpr-e2e", "mirror", "ui-login", "window2-mounts", "window3-mounts", "fixwave-parity", "branch-protection", "demo", "cleanup-audit"] : [opts.battery];

// ---------- dry-run ----------

const dryRun = () => {
  log(`cf-gitea deploy probes — DRY RUN (no requests will be made; no token needed)`);
  log(`base URL: ${opts.baseUrl ?? "<supplied at run time>"}  user: ${opts.user}`);
  for (const name of batteryList) {
    const battery = BATTERIES[name];
    const ctx = battery.context();
    log(``);
    log(`battery ${name} — ${battery.title}`);
    for (const step of battery.steps(ctx)) {
      log(`  would run: ${step.id}`);
      log(`    expect: ${scrub(step.expect.replaceAll("{{tip}}", ctx.tip ?? "<the pushed tip>"))}`);
    }
  }
  log(``);
  log(`${batteryList.length} battery/batteries planned — run with --base-url <url> --token-file <0600 path> to execute (the D1-only cleanup-audit needs neither).`);
};

// ---------- main ----------

if (opts.dryRun) {
  dryRun();
  process.exit(0);
}

/** Load the per-run PAT: 0600 file, mint-per-run shape, never echoed. Only
 *  invoked when a selected battery makes HTTP calls — or when the operator
 *  supplied a token file anyway (it is validated + scrubbed regardless). */
const loadToken = async () => {
  const st = await stat(opts.tokenFile);
  expect(st.isFile(), `--token-file is not a regular file: ${opts.tokenFile}`);
  const mode = st.mode & 0o777;
  expect(mode === 0o600,
    `--token-file must be 0600 (mint-per-run convention, e.g. scripts/bootstrap-admin.mjs --remote > /tmp/pat && chmod 600 /tmp/pat); got mode ${mode.toString(8).padStart(3, "0")}`);
  const token = (await readFile(opts.tokenFile, "utf8")).trim();
  expect(token.length > 0, "--token-file is empty");
  expect(/^cfg_[0-9a-f]{8}_[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{32}$/.test(token),
    "--token-file does not carry a cf-gitea PAT (cfg_<8hex>_<32base32>); refusing (value not logged)");
  secrets.push(token);
  return token;
};

/** PAT-identity preflight (the misaddressing class): repo creation is
 *  doer-relative (POST /user/repos lands in the PAT's own namespace) while
 *  every follow-up arm addresses /repos/<--user>/… — a --user that does not
 *  match the PAT's login makes every follow-up arm 404 AFTER repos were
 *  already created. One GET /api/v1/user BEFORE any battery step turns that
 *  into a fast, pointed exit 2 (zero repo creation). One request per
 *  invocation — the answer is cached; a match passes silently. */
let patLogin = null; // the preflight's cached answer (null = not asked yet)
const preflightIdentity = async () => {
  if (patLogin !== null) return patLogin;
  let res;
  try {
    res = await api("/user", { auth: true });
  } catch (err) {
    throw new Error(`identity preflight: GET /api/v1/user failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (res.status === 401) {
    throw new Error("identity preflight: the PAT was refused (GET /api/v1/user → 401) — mint a fresh PAT (scripts/bootstrap-admin.mjs) into a 0600 file");
  }
  expect(res.status === 200 && typeof res.json?.login === "string" && res.json.login.length > 0,
    `identity preflight: GET /api/v1/user → ${res.status} without a login (body: ${res.text.slice(0, 120)})`);
  patLogin = res.json.login;
  if (patLogin !== opts.user) {
    throw new Error(
      `--user ${opts.user} does not match the PAT's login ${patLogin} — repo creation is doer-relative (POST /user/repos), ` +
      `so every follow-up /repos/${opts.user}/… arm would 404; fix: mint the PAT as ${opts.user} or pass --user ${patLogin}`,
    );
  }
  return patLogin;
};

const main = async () => {
  // REDEPLOY15 friction (a): the D1-only cleanup-audit runs WITHOUT a PAT —
  // loadToken fires only when the run actually makes HTTP calls.
  const httpBatteries = batteryList.some((name) => !D1_ONLY_BATTERIES.has(name));
  if (httpBatteries || opts.tokenFile) {
    TOKEN = await loadToken();
  }
  // The PAT-identity preflight runs BEFORE any battery step — a mismatched
  // --user must fail fast, not after repos were created. The D1-only audit
  // (cleanup-audit alone, even with a supplied token) makes no HTTP calls and
  // has no /api/v1 surface to ask, so it never triggers the preflight.
  if (httpBatteries) await preflightIdentity();
  log(`cf-gitea deploy probes — ${batteryList.join(" + ")} — ${opts.baseUrl ?? "(no --base-url: D1-only battery)"} (user ${opts.user})`);
  for (const name of batteryList) {
    const battery = BATTERIES[name];
    const ctx = battery.context();
    if (!ctx.tmp) ctx.tmp = await mkdtemp(path.join(os.tmpdir(), "cf-gitea-probes-"));
    log(``);
    log(`battery ${name} — ${battery.title}`);
    try {
      // The per-battery setup (p0's self-fixture): runs BEFORE the checks, so
      // a fresh run user's first contact is a 201 seed, not the RD24 404.
      if (battery.setup) await battery.setup(ctx);
      if (battery.independent) {
        for (const step of battery.steps(ctx)) await check(step.id, step.run);
      } else {
        await chain(battery.steps(ctx));
      }
    } finally {
      // The red-runs-self-sweep posture: every state-creating battery's tail
      // sweeps its own creations (best-effort, logged, never throws; green
      // runs no-op silently).
      if (battery.failureTail) await battery.failureTail(ctx);
      await rm(ctx.tmp, { recursive: true, force: true });
    }
  }
};

main()
  .then(() => {
    TOKEN = ""; // drop the plaintext before the summary prints
    if (opts.forceRed && !forceRedMatched) {
      console.error(`deploy-probes: warning: --force-red ${opts.forceRed} matched no check id — nothing was forced`);
    }
    const counts = { pass: 0, fail: 0, warn: 0, skip: 0, info: 0 };
    for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
    const summary = {
      tool: "deploy-probes",
      batteries: batteryList,
      base_url: opts.baseUrl,
      user: opts.user,
      started_at: startedAt.toISOString(),
      duration_ms: Date.now() - startedAt.getTime(),
      ok: counts.fail === 0,
      summary: counts,
      checks: results.map(({ id, status, detail, ms }) => ({ id, status, detail, ms })),
      ...(leftBehind.length ? { left_behind: leftBehind } : {}),
    };
    console.log(JSON.stringify(summary, null, 2));
    process.exitCode = counts.fail === 0 ? 0 : 1;
  })
  .catch((err) => {
    console.error(`deploy-probes: ${scrub(err instanceof Error ? err.message : String(err))}`);
    process.exitCode = 2;
  });
