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
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok: $1"; }
fail() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
check() { if [ "$1" = "$2" ]; then ok "$3"; else fail "$3 (got '$1' want '$2')"; fi }

# --- local D1/R2 introspection (wrangler CLI shares the dev server's state) --
d1() { (cd "$WORKER_DIR" && pnpm exec wrangler d1 execute cf-gitea --local --json --command "$1" 2>/dev/null); }
# First column of the first result row ("" when the query returned nothing).
d1_field() { d1 "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const docs=JSON.parse(s.slice(s.indexOf("[")));const row=docs.at(-1).results[0];console.log(row?Object.values(row)[0]:"")}catch{console.log("")}})'; }
# The router's lfsRepoId bridge: parseInt(uuid.replaceAll("-","").slice(0,13),16).
lfs_repo_id() { node -e 'console.log(parseInt(process.argv[1].replaceAll("-","").slice(0,13),16))' "$1"; }

# --- dev server lifecycle -----------------------------------------------------
SERVER_PID=""
started_server=0
if ! curl -sf -o /dev/null "$BASE/healthz"; then
  # Start one ourselves, pinned to $BASE's port (--strictPort: a drifted port
  # would hang the healthz poll below; vite otherwise auto-increments when the
  # default 5173 is taken). Killed by the EXIT trap.
  PORT=${BASE##*:}
  echo "== no server at $BASE — starting pnpm dev (port $PORT, strict) =="
  setsid bash -c "cd '$ROOT' && exec pnpm dev --port $PORT --strictPort" >"$DIR/dev-server.log" 2>&1 &
  SERVER_PID=$!
  started_server=1
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
cleanup() {
  if [ "$started_server" = 1 ] && [ -n "$SERVER_PID" ]; then
    kill -- -"$SERVER_PID" 2>/dev/null || kill "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# --- sandboxed git environment (global git-lfs filter lands in the scratch
# HOME, never in the developer's real one) -------------------------------------
export HOME="$DIR/home" XDG_CONFIG_HOME="$DIR/home/.config"
mkdir -p "$HOME"
export GIT_TERMINAL_PROMPT=0
GITC="git -c credential.helper= -c advice.detachedHead=false"
git lfs install >/dev/null 2>&1 || { echo "FATAL: git lfs install failed"; exit 1; }

# --- setup: fresh user + two PATs (all-scope + wrong-scope) -------------------
echo "== setup: bootstrap $OWNER + PATs (local D1), clean slate for repeat runs =="
old_ids=$(d1 "SELECT id FROM repositories WHERE owner_namespace = '$OWNER'")
echo "$old_ids" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const docs=JSON.parse(s.slice(s.indexOf("[")));console.log((docs.at(-1).results||[]).map(r=>r.id).join("\n"))}catch{console.log("")}})' | while read -r rid; do
  [ -n "$rid" ] || continue
  numid=$(lfs_repo_id "$rid")
  d1 "DELETE FROM lfs_objects WHERE repo_id = $numid" >/dev/null
done
d1 "DELETE FROM repo_units WHERE repo_id IN (SELECT id FROM repositories WHERE owner_namespace = '$OWNER')" >/dev/null
d1 "DELETE FROM repo_counters WHERE repo_id IN (SELECT id FROM repositories WHERE owner_namespace = '$OWNER')" >/dev/null
d1 "DELETE FROM repositories WHERE owner_namespace = '$OWNER'" >/dev/null
d1 "DELETE FROM users WHERE username_lower = '$OWNER'" >/dev/null   # cascades personal_access_tokens

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
d1 "INSERT INTO personal_access_tokens (user_id, name, prefix, sha256_digest, scopes, last_used_at, expires_at, created_at) SELECT id, 'lfs-e2e-wrongscope', '${SCOPETOKEN:0:12}', '$SCOPEDIGEST', 'write:issue', NULL, NULL, $(date +%s) FROM users WHERE username_lower = '$OWNER'" >/dev/null
scope_count=$(d1_field "SELECT COUNT(*) FROM personal_access_tokens p JOIN users u ON u.id = p.user_id WHERE u.username_lower = '$OWNER' AND p.scopes = 'write:issue'")
check "$scope_count" "1" "wrong-scope PAT (write:issue) present"

AUTH_BASE=$(echo "$BASE" | sed "s|://|://$OWNER:$TOKEN@|")

# Clean slate for the repo NAME in the engine too: a prior run's engine DO
# storage (registry entry + refs) survives a D1-only sweep and would
# non-fast-forward the fresh push-create. Best-effort, token just minted.
curl -s -o /dev/null -X DELETE -u "x:$TOKEN" "$BASE/$OWNER/$REPO" 2>/dev/null

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
echo "== cleanup: engine DELETE + D1 row sweep =="
if [ "$FAIL" -eq 0 ]; then
  check "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -u "x:$TOKEN" "$BASE/$OWNER/$REPO")" "200" "engine DELETE repo"
  d1 "DELETE FROM lfs_objects WHERE repo_id = $REPO_NUM" >/dev/null
  d1 "DELETE FROM repo_units WHERE repo_id = '$REPO_ID'" >/dev/null
  d1 "DELETE FROM repo_counters WHERE repo_id = '$REPO_ID'" >/dev/null
  d1 "DELETE FROM repositories WHERE id = '$REPO_ID'" >/dev/null
  d1 "DELETE FROM users WHERE username_lower = '$OWNER'" >/dev/null
  left=$(d1_field "SELECT COUNT(*) FROM repositories WHERE owner_namespace = '$OWNER'")
  check "$left" "0" "D1 rows swept"
else
  echo "  (failures above — leaving $OWNER/$REPO and the scratch dir $DIR for debugging)"
fi

echo
echo "=== RESULT: $PASS passed, $FAIL failed (workdir $DIR) ==="
exit $((FAIL > 0))
