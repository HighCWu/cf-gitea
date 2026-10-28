#!/bin/bash
# cf-gitea git-lfs client end-to-end suite (SPEC-0006 §5 black-box layer, M6).
#
# The REAL git-lfs client against a running dev Worker — conventions follow
# packages/git-engine/e2e/e2e.sh: real client traffic, hard assertions that
# exit non-zero, per-check ok/FAIL lines, engine DELETE cleanup. CI wiring is
# deliberately NOT in this script — scripts/lfs-e2e.README.md carries the
# suggested job.
#
# Everything runs through the relay store (SPEC-0006 §2.3): local dev has no
# R2 S3 credentials, so batch hands out Worker-relayed hrefs and the LFS
# branch dispatches because the repo is D1-backed (a D1-missing repo would
# fall through to the engine — the transitional passthrough). Cases:
#
#   1. D1-backed repo via push-create with a D1-verified PAT (rows 15-20):
#      a plain first push lands the repositories row (default private). The
#      LFS pre-push hook fires BEFORE the pack upload, so on a nonexistent
#      repo the batch 404s through the engine — hence the two-step create,
#      which is also how real users meet push-create.
#   2. LFS push of a >100KB .bin: batch/PUT/verify traffic asserted via
#      GIT_TRACE_CURL; the `lfs_objects` D1 row must flip to `verified`; the
#      R2 object `lfs/<storage_key>/<oid>` must hash back to the oid.
#   3. Fresh clone smudge: byte-identical content (sha256), `git lfs fsck`
#      clean, and the batch download href serves the same bytes.
#   4. Second object + re-push of the first: no re-upload (trace carries no
#      PUT for the known oid) and the batch envelope carries `"actions":{}`
#      for it (git-lfs skips the transfer, http_client.go:184-187).
#   5. Wrong-scope token -> 403; unauthenticated batch on the private repo
#      -> 401 + `WWW-Authenticate: Basic realm="gitea-lfs"` (§2.2 split).
#
# Usage: scripts/lfs-e2e.sh [base-url]        (default http://127.0.0.1:5173)
#
# Requirements: git-lfs (>=3), git, curl, node (token minting + JSON
# parsing), pnpm (wrangler D1/R2 `--local` introspection — the local dev
# server shares apps/worker/.wrangler/state/v3 with the wrangler CLI, so the
# storage assertions below read the state the server just wrote). When no
# server answers at $BASE one is started via `pnpm dev` and killed on exit;
# the D1/R2 assertions assume that default local target (they read its
# state), mirroring how the git e2e targets 127.0.0.1.
#
# Run hygiene (2026-10-28 hardening, ported from scripts/mirror-e2e.sh —
# see scripts/lfs-e2e.README.md § run hygiene):
#   - a concurrent-run interlock (a second invocation fails immediately);
#   - every setup/cleanup DELETE is CHECKED — a failed D1 statement or an
#     unexpected engine DELETE status aborts the run naming the resource;
#   - stale prior-run state (D1 rows and the engine cell under lfse2e/) is
#     wiped and re-verified (git-surface 404 via the registry-existence
#     oracle) before section 1; when the suite starts its OWN dev server it
#     also sweeps its OWN stale cell FILES first (under a live server the
#     sweep is skipped — removing cell files held open by workerd is what
#     produces the unwipeable locked cells in the first place).
set -u

BASE=${1:-http://127.0.0.1:5173}
OWNER=lfse2e
REPO=lfsdemo
SIZE1=150000
SIZE2=200000
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORKER_DIR="$ROOT/apps/worker"
BUCKET=cf-gitea-packs   # wrangler.jsonc r2_buckets[0].bucket_name

command -v git-lfs >/dev/null 2>&1 || { echo "FATAL: git-lfs not found in PATH (SPEC-0006 §5 requires the real client; CI installs it)"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "FATAL: curl not found"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "FATAL: node not found"; exit 1; }
[ -d "$WORKER_DIR" ] || { echo "FATAL: $WORKER_DIR missing (run from a repo checkout)"; exit 1; }

DIR=$(mktemp -d /tmp/cgit-lfs-e2e.XXXXXX)
SERVER_PID=""
STARTED_SERVER=0
LOCK_DIR=""
LOCK_HELD=""
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok: $1"; }
fail() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
check() { if [ "$1" = "$2" ]; then ok "$3"; else fail "$3 (got '$1' want '$2')"; fi }
fatal() { echo "FATAL: $1"; exit 1; }

cleanup() {
  # Runs from the EXIT trap (registered before the dev server starts and
  # before the run lock is taken, so even a preflight fatal never leaks the
  # server — or the lock; a SIGKILLed run leaves the lock to be reclaimed by
  # holder-pid liveness).
  if [ "$STARTED_SERVER" = 1 ] && [ -n "$SERVER_PID" ]; then
    kill -- -"$SERVER_PID" 2>/dev/null || kill "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "$LOCK_HELD" ]; then rm -rf "$LOCK_DIR" 2>/dev/null || true; fi
}
trap cleanup EXIT

# --- concurrent-run interlock --------------------------------------------------
# Two concurrent invocations share this checkout's local D1/R2 state, the
# lfse2e namespace, and the dev-server port; interleaved runs poison each
# other and read as product failures. Ported from scripts/mirror-e2e.sh
# (2026-10-28): mkdir is the atomic test-and-set; the pid file lets a crashed
# run's lock be reclaimed automatically instead of wedging the suite.
LOCK_DIR="$WORKER_DIR/.wrangler/state/lfs-e2e-run.lock"
mkdir -p "$(dirname "$LOCK_DIR")"
if mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_HELD=1
  echo $$ > "$LOCK_DIR/pid"
else
  LOCK_PID=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
  if [ -n "$LOCK_PID" ] && ! kill -0 "$LOCK_PID" 2>/dev/null; then
    echo "== reclaiming stale run lock (holder pid $LOCK_PID is gone) =="
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null || fatal "cannot reclaim the run lock $LOCK_DIR"
    LOCK_HELD=1
    echo $$ > "$LOCK_DIR/pid"
  else
    fatal "another lfs-e2e run is in flight (lock $LOCK_DIR held by pid ${LOCK_PID:-unknown}) — wait for it to finish; if no run is active: rm -rf $LOCK_DIR"
  fi
fi

# --- local D1/R2 introspection (wrangler CLI shares the dev server's state) --
d1() { (cd "$WORKER_DIR" && pnpm exec wrangler d1 execute cf-gitea --local --json --command "$1" 2>/dev/null); }
_json_field() { node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const docs=JSON.parse(s.slice(s.indexOf("[")));const row=docs.at(-1).results[0];console.log(row?Object.values(row)[0]:"")}catch{console.log("")}})'; }
# First column of the first result row ("" when the query returned nothing).
d1_field() { d1 "$1" | _json_field; }
# First column of EVERY result row, one per line ("" when there are none).
_json_rows() { node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const docs=JSON.parse(s.slice(s.indexOf("[")));console.log((docs.at(-1).results||[]).map(r=>Object.values(r)[0]).join("\n"))}catch{console.log("")}})'; }
# Checked D1 statement (ported from scripts/mirror-e2e.sh): wrangler reports
# failures with a non-zero exit and an {"error": …} body on stdout. The plain
# d1() discards all of that — exactly how a failed pre-clean passed silently
# and poisoned the run. Every setup/cleanup DELETE goes through here; on
# success D1_OUT carries the JSON (for _json_field/_json_rows extraction).
D1_OUT=""
d1_checked() { # <sql> <label> — aborts the run unless wrangler reports success
  local rc
  D1_OUT=$(d1 "$1"); rc=$?
  if [ "$rc" -ne 0 ]; then
    fatal "D1 statement FAILED (${2}), wrangler exit ${rc} — statement: ${1}
       wrangler said: $(printf '%s' "$D1_OUT" | tr '\n' ' ' | head -c 300)
       if this repeats across runs the local dev scratch may be locked — see scripts/lfs-e2e.README.md (§ run hygiene)"
  fi
  printf '%s' "$D1_OUT" | grep -q '"success"[[:space:]]*:[[:space:]]*true' \
    || fatal "D1 statement did not report success (${2}) — statement: ${1}"
}
# The router's lfsRepoId bridge: parseInt(uuid.replaceAll("-","").slice(0,13),16).
lfs_repo_id() { node -e 'console.log(parseInt(process.argv[1].replaceAll("-","").slice(0,13),16))' "$1"; }

# --- pre-server cell-file sweep (harness-owned dev scratch, BEFORE the server)
# A completed async cell purge can leave the cell's sqlite file behind as an
# empty husk, and a later engine DELETE of that name answers HTTP 500
# `database table is locked: SQLITE_LOCKED` on it — deterministically, across
# dev-server restarts (the mirror suite's 2026-10-28 finding). The file level
# is the only reliable wipe, so — before THIS suite starts its own dev server,
# while nothing holds the files open — it removes ONLY the cell files whose
# embedded DO name is under its own lfse2e/ namespace — never another suite's
# cells. When a server is ALREADY ANSWERING at $BASE the suite reuses it
# (documented behavior) and the sweep is SKIPPED: removing cell files held
# open by a live workerd is what produces the locked cells in the first place
# (scripts/mirror-e2e.README.md § stale-state recovery). Missing sqlite3 also
# degrades gracefully: the checked DELETEs below still abort loudly on an
# unwipeable cell, with the recovery pointer.
CELL_DIR="$WORKER_DIR/.wrangler/state/v3/do/cf-gitea-RepoCell"
server_answers=0
if curl -sf -o /dev/null "$BASE/healthz"; then server_answers=1; fi
if [ "$server_answers" = 1 ]; then
  echo "  .. (a server already answers at $BASE — reusing it; skipping the pre-server cell-file sweep: cell files must never be removed under a live server)"
fi
if [ "$server_answers" = 0 ] && [ -d "$CELL_DIR" ]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    for f in "$CELL_DIR"/*.sqlite; do
      [ -e "$f" ] || continue
      cellname=$(sqlite3 "file:$f?mode=ro" "SELECT name FROM __miniflare_do_name LIMIT 1" 2>/dev/null)
      case "$cellname" in
        "$OWNER"/*)
          rm -f "$f" "$f-wal" "$f-shm" \
            || fatal "cannot remove the stale cell file for $cellname ($f) — is a dev server still holding it open? stop it and re-run"
          echo "  .. removed stale cell file $cellname ($(basename "$f"))"
          ;;
      esac
    done
  else
    echo "  .. (sqlite3 not found — skipping the pre-server cell-file sweep; an unwipeable stale cell will abort pre-clean with recovery instructions)"
  fi
fi

# --- dev server lifecycle -----------------------------------------------------
if [ "$server_answers" = 0 ]; then
  # Start one ourselves, pinned to $BASE's port (--strictPort: a drifted port
  # would hang the healthz poll below; vite otherwise auto-increments when the
  # default 5173 is taken). Killed by the EXIT trap.
  PORT=${BASE##*:}
  echo "== no server at $BASE — starting pnpm dev (port $PORT, strict) =="
  setsid bash -c "cd '$ROOT' && exec pnpm dev --port $PORT --strictPort" >"$DIR/dev-server.log" 2>&1 &
  SERVER_PID=$!
  STARTED_SERVER=1
  up=0
  for _ in $(seq 1 120); do
    curl -sf -o /dev/null "$BASE/healthz" && { up=1; break; }
    sleep 1
  done
  if [ "$up" != 1 ]; then
    echo "FATAL: dev server did not become healthy; last log lines:"
    tail -20 "$DIR/dev-server.log"
    kill -- -"$SERVER_PID" 2>/dev/null || kill "$SERVER_PID" 2>/dev/null
    exit 1
  fi
fi

# --- sandboxed git environment (global git-lfs filter lands in the scratch
# HOME, never in the developer's real one) -------------------------------------
export HOME="$DIR/home" XDG_CONFIG_HOME="$DIR/home/.config"
mkdir -p "$HOME"
export GIT_TERMINAL_PROMPT=0
GITC="git -c credential.helper= -c advice.detachedHead=false"
git lfs install >/dev/null 2>&1 || { echo "FATAL: git lfs install failed"; exit 1; }

# --- setup: fresh user + two PATs (all-scope + wrong-scope) -------------------
echo "== setup: bootstrap $OWNER + PATs (local D1), VERIFIED clean slate for repeat runs =="
# Stale-state guard (ported from scripts/mirror-e2e.sh): prior-run leftovers
# silently poisoned later sections. The suite counts what it owns, wipes it
# with CHECKED statements, and re-verifies the wipe before section 1 — an
# unverifiable wipe aborts HERE with the resource named, instead of cascading
# into product-check failures mid-run.
d1_checked "SELECT COUNT(*) AS n FROM repositories WHERE owner_namespace = '$OWNER'" "stale-state detection (repositories)"
STALE_REPOS=$(printf '%s' "$D1_OUT" | _json_field)
d1_checked "SELECT COUNT(*) AS n FROM users WHERE username_lower = '$OWNER'" "stale-state detection (users)"
STALE_USERS=$(printf '%s' "$D1_OUT" | _json_field)
[ -n "$STALE_REPOS" ] && [ -n "$STALE_USERS" ] || fatal "cannot read the local D1 to assess prior-run state (wrangler produced no count)"
if [ "$STALE_REPOS" != "0" ] || [ "$STALE_USERS" != "0" ]; then
  echo "  .. stale state from a prior run: repositories=$STALE_REPOS, users=$STALE_USERS — wiping"
fi
d1_checked "SELECT id FROM repositories WHERE owner_namespace = '$OWNER'" "stale-state detection (repo ids)"
STALE_IDS=$(printf '%s' "$D1_OUT" | _json_rows)
for rid in $STALE_IDS; do
  d1_checked "DELETE FROM lfs_objects WHERE repo_id = $(lfs_repo_id "$rid")" "pre-clean lfs_objects sweep (repo $rid)"
done
d1_checked "DELETE FROM repo_units WHERE repo_id IN (SELECT id FROM repositories WHERE owner_namespace = '$OWNER')" "pre-clean repo_units sweep"
d1_checked "DELETE FROM repo_counters WHERE repo_id IN (SELECT id FROM repositories WHERE owner_namespace = '$OWNER')" "pre-clean repo_counters sweep"
d1_checked "DELETE FROM repositories WHERE owner_namespace = '$OWNER'" "pre-clean repositories sweep"
d1_checked "DELETE FROM users WHERE username_lower = '$OWNER'" "pre-clean users sweep"   # cascades personal_access_tokens
check "$(d1_field "SELECT COUNT(*) FROM repositories WHERE owner_namespace = '$OWNER'")" "0" "pre-clean: D1 rows swept"

BOOT=$(node "$ROOT/scripts/bootstrap-admin.mjs" "$OWNER" 2>/dev/null)
TOKEN=$(echo "$BOOT" | grep -oE 'cfg_[0-9a-f]{8}_[A-Z2-9]{32}' | head -1)
if [ -z "$TOKEN" ]; then echo "FATAL: bootstrap-admin.mjs produced no token"; echo "$BOOT"; exit 1; fi
ok "bootstrapped $OWNER with an all-scopes PAT"

# Wrong-scope PAT: same minting algorithm as bootstrap-admin.mjs / token-format.ts.
read -r SCOPETOKEN SCOPEDIGEST <<EOF
$(node -e '
const { createHash, randomBytes } = require("node:crypto");
const B32 = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const b = randomBytes(24);
let hex = ""; for (let i = 0; i < 4; i++) hex += (b[i] >> 4).toString(16) + (b[i] & 15).toString(16);
let bits = 0, val = 0, b32 = "";
for (const byte of b.subarray(4)) { val = (val << 8) | byte; bits += 8; while (bits >= 5) { b32 += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
const t = "cfg_" + hex + "_" + b32;
console.log(t, createHash("sha256").update(t, "utf8").digest("hex"));
')
EOF
d1_checked "INSERT INTO personal_access_tokens (user_id, name, prefix, sha256_digest, scopes, last_used_at, expires_at, created_at) SELECT id, 'lfs-e2e-wrongscope', '${SCOPETOKEN:0:12}', '$SCOPEDIGEST', 'write:issue', NULL, NULL, $(date +%s) FROM users WHERE username_lower = '$OWNER'" "wrong-scope PAT insert"
scope_count=$(d1_field "SELECT COUNT(*) FROM personal_access_tokens p JOIN users u ON u.id = p.user_id WHERE u.username_lower = '$OWNER' AND p.scopes = 'write:issue'")
check "$scope_count" "1" "wrong-scope PAT (write:issue) present"

AUTH_BASE=$(echo "$BASE" | sed "s|://|://$OWNER:$TOKEN@|")

# Clean slate for the repo NAME in the engine too: a prior run's engine DO
# storage (registry entry + refs) survives a D1-only sweep and would
# non-fast-forward the fresh push-create. CHECKED (ported from
# scripts/mirror-e2e.sh): 200 = a stale cell existed and was purged (logged),
# 404 = nothing was there — anything else (a locked-cell 500, a worker
# restarting mid-request, a bad token) aborts with the resource and code
# named. Best-effort name, token just minted.
code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -u "x:$TOKEN" "$BASE/$OWNER/$REPO" 2>/dev/null)
case "$code" in
  200) echo "  .. wiped stale cell $OWNER/$REPO (engine DELETE 200)";;
  404) ;;
  *) fatal "pre-clean engine DELETE $OWNER/$REPO returned HTTP ${code:-none} (want 200 or 404) — a prior-run cell that cannot be wiped poisons the whole run; recover per scripts/lfs-e2e.README.md (§ run hygiene)";;
esac
# Trust only VERIFIED absence: a 200 can precede an async cell purge that is
# still in flight (or was dropped), so the name is polled on the git surface
# until it reads 404 (the D1 rows are gone at this point, so this answers
# through the registry-existence oracle: a registry-known orphan serves refs
# → 200, clean state → 404).
code=""
for _ in $(seq 1 10); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -u "x:$TOKEN" "$BASE/$OWNER/$REPO.git/info/refs?service=git-upload-pack" 2>/dev/null)
  [ "$code" = "404" ] && break
  sleep 1
done
[ "$code" = "404" ] || fatal "stale cell $OWNER/$REPO still serves refs after its DELETE (last HTTP ${code:-none}) — the purge was dropped or lost the race; recover per scripts/lfs-e2e.README.md (§ run hygiene)"
ok "engine cell verified absent ($OWNER/$REPO)"

# =============================================================================
echo "== 1. push-create: a plain first push lands the D1 repositories row =="
(cd "$DIR" && $GITC init -q -b main src && cd src \
  && git config user.email dev@example.com && git config user.name "Dev One" \
  && git lfs install --local >/dev/null \
  && git lfs track "*.bin" >/dev/null \
  && printf 'lfs e2e repo\n' > README.md \
  && git add -A && git commit -qm "create")
(cd "$DIR/src" && $GITC push -q "$AUTH_BASE/$OWNER/$REPO.git" main) >"$DIR/push0.out" 2>&1; PUSH0=$?
if [ $PUSH0 -ne 0 ]; then sed 's/^/    | /' "$DIR/push0.out"; fi
check $PUSH0 0 "push-create push"
REPO_ID=$(d1_field "SELECT id FROM repositories WHERE owner_namespace = '$OWNER' AND slug = '$REPO'")
[ -n "$REPO_ID" ]; check $? 0 "repositories row landed (id $REPO_ID)"
check "$(d1_field "SELECT visibility FROM repositories WHERE id = '$REPO_ID'")" "private" "push-created repo defaults private"
check "$(d1_field "SELECT status FROM repositories WHERE id = '$REPO_ID'")" "ready" "push-create settle: status ready"
STORAGE_KEY=$(d1_field "SELECT storage_key FROM repositories WHERE id = '$REPO_ID'")
case "$STORAGE_KEY" in r_*) ok "storage key $STORAGE_KEY";; *) fail "storage key '$STORAGE_KEY' not r_<id>";; esac
REPO_NUM=$(lfs_repo_id "$REPO_ID")

# =============================================================================
echo "== 2. LFS push: >100KB .bin uploaded via relay (batch/PUT/verify) =="
(cd "$DIR/src" && head -c $SIZE1 /dev/urandom > asset1.bin && git add -A && git commit -qm "asset 1")
OID1=$(sha256sum "$DIR/src/asset1.bin" | cut -d' ' -f1)
(cd "$DIR/src" && GIT_TRACE=1 GIT_TRACE_CURL=1 GIT_TRACE_CURL_NO_DATA=1 $GITC push "$AUTH_BASE/$OWNER/$REPO.git" main) >"$DIR/push1.out" 2>"$DIR/trace1"; PUSH1=$?
if [ $PUSH1 -ne 0 ]; then sed 's/^/    | /' "$DIR/push1.out"; fi
check $PUSH1 0 "lfs push lands"
grep -q "HTTP: POST .*info/lfs/objects/batch" "$DIR/trace1"; check $? 0 "trace: batch POST"
grep -q "HTTP: PUT .*info/lfs/objects/$OID1/$SIZE1" "$DIR/trace1"; check $? 0 "trace: relay PUT objects/<oid>/<size>"
grep -q "HTTP: POST .*info/lfs/verify" "$DIR/trace1"; check $? 0 "trace: verify POST"
check "$(d1_field "SELECT state FROM lfs_objects WHERE repo_id = $REPO_NUM AND oid = '$OID1'")" "verified" "D1 lfs_objects row verified"
check "$(d1_field "SELECT size FROM lfs_objects WHERE repo_id = $REPO_NUM AND oid = '$OID1'")" "$SIZE1" "D1 row size"
R2GET="$DIR/r2-object.bin"
if (cd "$WORKER_DIR" && pnpm exec wrangler r2 object get "$BUCKET/lfs/$STORAGE_KEY/$OID1" --local --file "$R2GET" >/dev/null 2>&1); then
  check "$(sha256sum "$R2GET" | cut -d' ' -f1)" "$OID1" "R2 object lfs/$STORAGE_KEY/<oid> hashes to oid"
else
  fail "R2 object lfs/$STORAGE_KEY/$OID1 retrievable via wrangler r2 object get --local"
fi

# =============================================================================
echo "== 3. fresh clone: smudge byte-identical, fsck clean, download href =="
(cd "$DIR" && $GITC clone -q "$AUTH_BASE/$OWNER/$REPO.git" clone1 2>/dev/null); check $? 0 "clone"
check "$(sha256sum "$DIR/clone1/asset1.bin" | cut -d' ' -f1)" "$OID1" "smudged content sha256 == oid"
(cd "$DIR/clone1" && git lfs fsck >/dev/null 2>&1); check $? 0 "git lfs fsck clean"
BATCH_DL=$(curl -s -u "x:$TOKEN" -X POST "$BASE/$OWNER/$REPO.git/info/lfs/objects/batch" \
  -H "Accept: application/vnd.git-lfs+json" -H "Content-Type: application/vnd.git-lfs+json" \
  -d "{\"operation\":\"download\",\"objects\":[{\"oid\":\"$OID1\",\"size\":$SIZE1}]}")
echo "$BATCH_DL" | grep -q '"download":{'; check $? 0 "batch download op carries a download href"
DL_HREF=$(echo "$BATCH_DL" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);console.log(j.objects[0].actions.download.href)}catch{console.log("")}})')
curl -s -o "$DIR/dl.bin" -u "x:$TOKEN" "$DL_HREF"; check $? 0 "download href GET"
check "$(sha256sum "$DIR/dl.bin" | cut -d' ' -f1)" "$OID1" "download href bytes sha256 == oid"

# =============================================================================
echo "== 4. second object + re-push: known object is adopted, not re-uploaded =="
(cd "$DIR/src" && head -c $SIZE2 /dev/urandom > asset2.bin && git add -A && git commit -qm "asset 2")
OID2=$(sha256sum "$DIR/src/asset2.bin" | cut -d' ' -f1)
(cd "$DIR/src" && GIT_TRACE=1 GIT_TRACE_CURL=1 GIT_TRACE_CURL_NO_DATA=1 $GITC push "$AUTH_BASE/$OWNER/$REPO.git" main) >"$DIR/push2.out" 2>"$DIR/trace2"; PUSH2=$?
if [ $PUSH2 -ne 0 ]; then sed 's/^/    | /' "$DIR/push2.out"; fi
check $PUSH2 0 "second lfs push lands"
check "$(grep -c "HTTP: PUT .*info/lfs/objects/$OID2/$SIZE2" "$DIR/trace2")" "1" "trace: new object uploaded exactly once"
check "$(grep -c "HTTP: PUT .*info/lfs/objects/$OID1/" "$DIR/trace2")" "0" "trace: known object NOT re-uploaded"
check "$(d1_field "SELECT state FROM lfs_objects WHERE repo_id = $REPO_NUM AND oid = '$OID2'")" "verified" "second D1 row verified"
# The wire-level "already present" rule (§3.3): a fresh batch(upload) for the
# known oid answers empty actions — git-lfs then skips the transfer.
BATCH_AGAIN=$(curl -s -u "x:$TOKEN" -X POST "$BASE/$OWNER/$REPO.git/info/lfs/objects/batch" \
  -H "Accept: application/vnd.git-lfs+json" -H "Content-Type: application/vnd.git-lfs+json" \
  -d "{\"operation\":\"upload\",\"objects\":[{\"oid\":\"$OID1\",\"size\":$SIZE1}]}")
echo "$BATCH_AGAIN" | grep -qF "{\"oid\":\"$OID1\",\"size\":$SIZE1,\"actions\":{}}"; check $? 0 "batch re-push carries no actions for known object"
check "$(d1_field "SELECT COUNT(*) FROM lfs_objects WHERE repo_id = $REPO_NUM")" "2" "exactly two lfs_objects rows"

# =============================================================================
echo "== 5. auth: wrong-scope token 403, unauthenticated 401 challenge =="
SC=$(curl -s -o "$DIR/scope-body.txt" -w "%{http_code}" -u "x:$SCOPETOKEN" -X POST "$BASE/$OWNER/$REPO.git/info/lfs/objects/batch" \
  -H "Accept: application/vnd.git-lfs+json" -H "Content-Type: application/vnd.git-lfs+json" \
  -d "{\"operation\":\"upload\",\"objects\":[{\"oid\":\"$OID1\",\"size\":$SIZE1}]}")
check "$SC" "403" "wrong-scope token on batch upload"
check "$(cat "$DIR/scope-body.txt")" "Forbidden" "403 body visible to client"
ANON_CODE=$(curl -s -o "$DIR/anon-body.txt" -D "$DIR/anon-headers.txt" -w "%{http_code}" -X POST "$BASE/$OWNER/$REPO.git/info/lfs/objects/batch" \
  -H "Accept: application/vnd.git-lfs+json" -H "Content-Type: application/vnd.git-lfs+json" \
  -d "{\"operation\":\"upload\",\"objects\":[{\"oid\":\"$OID1\",\"size\":$SIZE1}]}")
check "$ANON_CODE" "401" "unauthenticated batch on private repo"
grep -qi 'www-authenticate: Basic realm="gitea-lfs"' "$DIR/anon-headers.txt"; check $? 0 "401 carries the gitea-lfs Basic challenge"
grep -q '"message":"Unauthorized"' "$DIR/anon-body.txt"; check $? 0 "401 body is the LFS JSON envelope"

# =============================================================================
echo "== cleanup: engine DELETE + verified purge + D1 row sweep =="
if [ "$FAIL" -eq 0 ]; then
  check "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -u "x:$TOKEN" "$BASE/$OWNER/$REPO" 2>/dev/null)" "200" "engine DELETE repo (cell + R2 purge enqueued)"
  # Verified purge (the setup guard, mirrored here): the 200 above only
  # covers the delete response — a dropped async purge would leave a cell
  # serving stale refs to the NEXT run, so absence is proven on the git
  # surface before declaring the cleanup done. Runs while the PAT is still
  # valid (before the users sweep below cascades it).
  code=""
  for _ in $(seq 1 10); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -u "x:$TOKEN" "$BASE/$OWNER/$REPO.git/info/refs?service=git-upload-pack" 2>/dev/null)
    [ "$code" = "404" ] && break
    sleep 1
  done
  check "$code" "404" "cell purge verified: $OWNER/$REPO serves 404"
  d1_checked "DELETE FROM lfs_objects WHERE repo_id = $REPO_NUM" "cleanup lfs_objects sweep"
  d1_checked "DELETE FROM repo_units WHERE repo_id = '$REPO_ID'" "cleanup repo_units sweep"
  d1_checked "DELETE FROM repo_counters WHERE repo_id = '$REPO_ID'" "cleanup repo_counters sweep"
  d1_checked "DELETE FROM repositories WHERE id = '$REPO_ID'" "cleanup repositories sweep"
  d1_checked "DELETE FROM users WHERE username_lower = '$OWNER'" "cleanup users sweep"   # cascades personal_access_tokens
  left=$(d1_field "SELECT COUNT(*) FROM repositories WHERE owner_namespace = '$OWNER'")
  check "$left" "0" "D1 rows swept"
else
  echo "  (failures above — leaving $OWNER/$REPO and the scratch dir $DIR for debugging)"
fi

echo
echo "=== RESULT: $PASS passed, $FAIL failed (workdir $DIR) ==="
exit $((FAIL > 0))
