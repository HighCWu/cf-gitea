#!/bin/bash
# cf-gitea pull-mirror e2e suite (SPEC-0009 §5 black-box layer).
#
# Real git clients against a running dev Worker: the SOURCE side is a real
# smart-HTTP endpoint (apps/worker/test/fixtures/git-http-server.mjs shelling
# `git upload-pack --stateless-rpc [--advertise-refs]` on loopback, TLS with a
# throwaway CA), the TARGET side is the Worker's own git surface — so the whole
# loop (push-create source → migrate mirror=true → queue consumer fetch →
# clone/fscs-verified target) is black-box. Conventions follow
# scripts/lfs-e2e.sh: hard assertions that exit non-zero, per-check ok/FAIL
# lines, wrangler D1 introspection against the dev server's own state, and
# full cleanup on a green run. CI wiring stays in scripts/mirror-e2e.README.md.
#
# Dev-environment requirements (the script fails with exact instructions when
# missing — see the README for why):
#   apps/worker/.dev.vars must carry GIT_TOKEN, MIRROR_ALLOWED_HOST_LIST (an
#   explicit IP entry covering the fixture's loopback IP:PORT) and
#   MIRROR_CREDENTIAL_KEY, and apps/worker/wrangler.jsonc must DECLARE those
#   names — when `secrets` is declared in the Worker config, only declared
#   names are loaded from .dev.vars (wrangler semantics; GIT_TOKEN is already
#   declared there). The dev server is started by THIS script with
#   SSL_CERT_FILE=<fixture CA> so workerd's outbound fetch trusts the fixture.
#
# Scenario list (SPEC-0009 §5.2-5.7 adapted to the landed into-empty migrate
# surface — see the README for the mapping):
#   1. source repo via git push (PAT-authenticated, D1-backed) + fixture pop.
#   2. empty target via the API; POST migrate mirror=true → 202; poll GET
#      mirror until last_sync_at is set (this also proves the dev server
#      delivers MIRROR_SYNC_QUEUE messages to the consumer).
#   3. target content: ref-map equality vs the source, fresh clone, git fsck,
#      rev-list count equality.
#   4. is_empty posture after a completed sync (PINNED known gap — see TODO).
#   5. push to source → mirror-sync → target updated (delta sync).
#   6. upstream force-rewind applied (the `+` refspec semantics).
#   7. prune: enable_prune=true deletes upstream-deleted refs; =false (D1 flip
#      until the PATCH surface lands) preserves them.
#   8. v0 fallback: a second migrate against the fixture's v0-only path.
#   9. read-only enforcement: receive-pack 403 "mirror repository is
#      read-only"; git push fails.
#  10. SSRF egress gate: http scheme, loopback port without an allow entry,
#      .internal host, userinfo credentials → 422; not-a-mirror mirror-sync
#      → 400 upstream text.
#  11. source death: sanitized last_error, sync_state idle, target still
#      serves clones (mirrors are snapshots).
#
# Usage: scripts/mirror-e2e.sh [base-url]     (default http://127.0.0.1:5199)
#
# Requirements: git, curl, node, openssl, pnpm (wrangler D1 --local
# introspection), local migrations applied (pnpm db:migrate:local — migration
# 0010 lands repo_mirrors), and the .dev.vars + wrangler.jsonc additions above.
set -u

BASE=${1:-http://127.0.0.1:5199}
OWNER=mirrore2e
SRC_HOST=127.0.0.1
SRC_PORT=${SRC_PORT:-8443}          # must match MIRROR_ALLOWED_HOST_LIST in .dev.vars
SRC_USER=srcpush
SRC_PASS=srcpass-e2e-9
SRC_URL="https://$SRC_HOST:$SRC_PORT"
SRC_AUTH_URL="https://$SRC_USER:$SRC_PASS@$SRC_HOST:$SRC_PORT"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORKER_DIR="$ROOT/apps/worker"
FIXTURE="$WORKER_DIR/test/fixtures/git-http-server.mjs"

command -v git >/dev/null 2>&1 || { echo "FATAL: git not found"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "FATAL: curl not found"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "FATAL: node not found"; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "FATAL: openssl not found (the fixture's throwaway TLS identity is generated with it)"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "FATAL: pnpm not found"; exit 1; }
[ -f "$FIXTURE" ] || { echo "FATAL: $FIXTURE missing"; exit 1; }
[ -d "$WORKER_DIR" ] || { echo "FATAL: $WORKER_DIR missing (run from a repo checkout)"; exit 1; }

DIR=$(mktemp -d /tmp/cgit-mirror-e2e.XXXXXX)
FIXTURE_PID=""
SERVER_PID=""
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok: $1"; }
fail() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
check() { if [ "$1" = "$2" ]; then ok "$3"; else fail "$3 (got '$1' want '$2')"; fi }
fatal() { echo "FATAL: $1"; exit 1; }

cleanup() {
  # Runs from the EXIT trap (registered before the fixture starts, so even a
  # preflight fatal never leaks either process).
  if [ -n "$FIXTURE_PID" ]; then kill "$FIXTURE_PID" 2>/dev/null || true; fi
  if [ -n "$SERVER_PID" ]; then kill -- -"$SERVER_PID" 2>/dev/null || kill "$SERVER_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT

# --- D1 introspection (wrangler shares the dev server's local state) ---------
d1() { (cd "$WORKER_DIR" && pnpm exec wrangler d1 execute cf-gitea --local --json --command "$1" 2>/dev/null); }
d1_field() { d1 "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const docs=JSON.parse(s.slice(s.indexOf("[")));const row=docs.at(-1).results[0];console.log(row?Object.values(row)[0]:"")}catch{console.log("")}})'; }

# --- JSON field extraction (dot path into an API response body) --------------
jf() { printf '%s' "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const v=process.argv[1].split(".").reduce((o,k)=>o===undefined||o===null?o:o[k],JSON.parse(s));console.log(v===undefined||v===null?"":String(v))}catch{console.log("")}})' "$2"; }

# =============================================================================
echo "== 0. preflight: dev env contract, TLS identity, fixture, dev server =="
# .dev.vars keys (values are dev-local secrets; never printed).
DEVVARS="$WORKER_DIR/.dev.vars"
[ -f "$DEVVARS" ] || fatal "$DEVVARS missing — copy .dev.vars.example and add the mirror keys (see scripts/mirror-e2e.README.md)"
for key in GIT_TOKEN MIRROR_ALLOWED_HOST_LIST MIRROR_CREDENTIAL_KEY; do
  grep -qE "^${key}=" "$DEVVARS" || fatal "$DEVVARS is missing ${key} — add it per scripts/mirror-e2e.README.md (§ dev environment)"
done
ok ".dev.vars carries GIT_TOKEN, MIRROR_ALLOWED_HOST_LIST, MIRROR_CREDENTIAL_KEY"
# wrangler.jsonc must DECLARE the mirror names: when `secrets` is declared in
# the Worker config, wrangler loads ONLY declared names from .dev.vars (probed
# empirically — undeclared keys never reach the Worker env).
for key in MIRROR_ALLOWED_HOST_LIST MIRROR_CREDENTIAL_KEY; do
  grep -q "\"${key}\"" "$WORKER_DIR/wrangler.jsonc" || \
    fatal "wrangler.jsonc does not declare ${key} — with secrets.required present, .dev.vars keys must be declared (add ${key} to secrets.required; see scripts/mirror-e2e.README.md)"
done
ok "wrangler.jsonc declares the mirror env names"
MIRROR_HOST_ENTRY=$(grep -E "^MIRROR_ALLOWED_HOST_LIST=" "$DEVVARS" | head -1 | cut -d= -f2-)
case ",$MIRROR_HOST_ENTRY," in
  *",$SRC_HOST:$SRC_PORT,"*|*",$SRC_HOST:*,"*) ok "MIRROR_ALLOWED_HOST_LIST covers $SRC_HOST:$SRC_PORT";;
  *) fatal "MIRROR_ALLOWED_HOST_LIST=$MIRROR_HOST_ENTRY does not cover the fixture address $SRC_HOST:$SRC_PORT — add an explicit IP entry ($SRC_HOST:$SRC_PORT) to $DEVVARS";;
esac

[ "$(d1_field "SELECT COUNT(*) FROM sqlite_master WHERE name = 'repo_mirrors'")" = "1" ] \
  || fatal "local D1 lacks repo_mirrors — run pnpm db:migrate:local first (migration 0010)"

# Throwaway CA + leaf for the fixture's https listener (per-run keys, never
# committed). workerd verifies TLS on outbound fetch and honors SSL_CERT_FILE
# as the trust anchor — the dev server below is started with it set.
mkdir -p "$DIR/tls"
openssl req -x509 -newkey rsa:2048 -keyout "$DIR/tls/ca-key.pem" -out "$DIR/tls/ca.pem" -days 2 -nodes \
  -subj "/CN=mirror-e2e-test-ca" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" >/dev/null 2>&1
openssl req -newkey rsa:2048 -keyout "$DIR/tls/key.pem" -out "$DIR/tls/leaf.csr" -nodes -subj "/CN=$SRC_HOST" >/dev/null 2>&1
printf "basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:%s,DNS:localhost\n" "$SRC_HOST" > "$DIR/tls/leaf.ext"
openssl x509 -req -in "$DIR/tls/leaf.csr" -CA "$DIR/tls/ca.pem" -CAkey "$DIR/tls/ca-key.pem" -CAcreateserial \
  -out "$DIR/tls/cert.pem" -days 2 -extfile "$DIR/tls/leaf.ext" >/dev/null 2>&1
openssl verify -CAfile "$DIR/tls/ca.pem" "$DIR/tls/cert.pem" >/dev/null 2>&1
check $? 0 "fixture TLS identity generated (CA + loopback leaf, SAN IP:$SRC_HOST)"

# --- sandboxed git environment (global config lands in the scratch HOME,
# never in the developer's real one — lfs-e2e convention) ----------------------
export HOME="$DIR/home" XDG_CONFIG_HOME="$DIR/home/.config"
mkdir -p "$HOME"
export GIT_TERMINAL_PROMPT=0
# http.sslCAInfo teaches real git the fixture's throwaway CA (libcurl honors
# SSL_CERT_FILE, but only the workerd process gets that env — git needs the
# config); it is ignored for the plain-http dev-server traffic.
GITC="git -c credential.helper= -c advice.detachedHead=false -c http.sslCAInfo=$DIR/tls/ca.pem"

# --- source fixture (the real smart-HTTP endpoint) ---------------------------
git init -q --bare -b main "$DIR/src-fixture.git"
FIXTURE_PID=""
if [ -n "$(ss -tln 2>/dev/null | grep ":$SRC_PORT " || true)" ]; then
  fatal "port $SRC_PORT is already in use — free it or set SRC_PORT (and update MIRROR_ALLOWED_HOST_LIST to match)"
fi
setsid node "$FIXTURE" --repo "$DIR/src-fixture.git" --host "$SRC_HOST" --port "$SRC_PORT" \
  --cert "$DIR/tls/cert.pem" --key "$DIR/tls/key.pem" \
  --user "$SRC_USER" --password "$SRC_PASS" --v0-prefix /v0 >"$DIR/fixture.log" 2>&1 &
FIXTURE_PID=$!
fixture_up=0
for _ in $(seq 1 20); do
  grep -q "MIRROR-E2E-SRC-READY" "$DIR/fixture.log" 2>/dev/null && { fixture_up=1; break; }
  sleep 0.5
done
[ "$fixture_up" = 1 ] || { tail -5 "$DIR/fixture.log"; fatal "source fixture did not become ready"; }
ok "source fixture serving $SRC_URL (upload-pack over TLS, Basic auth, v0 prefix /v0)"
code=$(curl -s -o /dev/null -w '%{http_code}' --cacert "$DIR/tls/ca.pem" "$SRC_URL/repo.git/info/refs?service=git-upload-pack")
check "$code" "401" "fixture challenges anonymous reads (Basic)"
code=$(curl -s -o /dev/null -w '%{http_code}' --cacert "$DIR/tls/ca.pem" -u "$SRC_USER:$SRC_PASS" "$SRC_URL/repo.git/info/refs?service=git-upload-pack")
check "$code" "200" "fixture serves the advertisement to authenticated reads"
$GITC ls-remote "$SRC_AUTH_URL/repo.git" >/dev/null 2>&1
check $? 0 "real git ls-remote interops with the fixture (v2 smart HTTP + Basic auth)"

# --- dev server (owned by the suite: it needs SSL_CERT_FILE for the fixture CA)
if curl -sf -o /dev/null "$BASE/healthz"; then
  fatal "a dev server already answers at $BASE — the mirror suite must own the server process (it starts it with SSL_CERT_FILE pointing at the fixture CA so workerd trusts the loopback source); stop it or pass another base URL"
fi
PORT=${BASE##*:}
echo "== no server at $BASE — starting pnpm dev (port $PORT, SSL_CERT_FILE set) =="
setsid bash -c "cd '$ROOT' && exec env SSL_CERT_FILE='$DIR/tls/ca.pem' pnpm dev --port $PORT --strictPort" >"$DIR/dev-server.log" 2>&1 &
SERVER_PID=$!
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
ok "dev server healthy at $BASE (workerd trusts the fixture CA via SSL_CERT_FILE)"

# --- setup: fresh user + PAT, clean slate (D1 + engine) ------------------------
echo "== setup: bootstrap $OWNER + PAT (local D1), clean slate for repeat runs =="
d1 "DELETE FROM repo_mirrors WHERE repo_id IN (SELECT id FROM repositories WHERE owner_namespace = '$OWNER')" >/dev/null
d1 "DELETE FROM repo_units WHERE repo_id IN (SELECT id FROM repositories WHERE owner_namespace = '$OWNER')" >/dev/null
d1 "DELETE FROM repo_counters WHERE repo_id IN (SELECT id FROM repositories WHERE owner_namespace = '$OWNER')" >/dev/null
d1 "DELETE FROM repositories WHERE owner_namespace = '$OWNER'" >/dev/null
d1 "DELETE FROM users WHERE username_lower = '$OWNER'" >/dev/null   # cascades personal_access_tokens

BOOT=$(node "$ROOT/scripts/bootstrap-admin.mjs" "$OWNER" 2>/dev/null)
TOKEN=$(echo "$BOOT" | grep -oE 'cfg_[0-9a-f]{8}_[A-Z2-9]{32}' | head -1)
[ -n "$TOKEN" ] || { echo "$BOOT"; fatal "bootstrap-admin.mjs produced no token"; }
ok "bootstrapped $OWNER with an all-scopes PAT"
# Best-effort engine-side sweep of a previous red run's cells (D1 rows are gone
# at this point, so these ride the transitional passthrough; PAT-authorized).
for repo in srcseed target v0target probe; do
  curl -s -o /dev/null -X DELETE -u "x:$TOKEN" "$BASE/$OWNER/$repo" 2>/dev/null
done

AUTH_BASE=$(echo "$BASE" | sed "s|://|://$OWNER:$TOKEN@|")

# --- API helper (Authorization: token; API_CODE/API_BODY globals) -------------
api() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-s -o "$DIR/api-body" -w '%{http_code}' -X "$method" -H "Authorization: token $TOKEN" "$BASE/api/v1$path")
  if [ -n "$data" ]; then args+=(-H "content-type: application/json" -d "$data"); fi
  API_CODE=$(curl "${args[@]}")
  API_BODY=$(cat "$DIR/api-body")
}

# --- mirror status + settle polling -------------------------------------------
mirror_status() { # repo -> MS_BODY
  MS_BODY=$(curl -s -H "Authorization: token $TOKEN" "$BASE/api/v1/repos/$OWNER/$1/mirror")
}
ms() { jf "$MS_BODY" "$1"; }

SETTLED_LAST=""
SETTLED_ERR=""
await_settle() { # repo prev want(ok|error) — 0 when settled as wanted, 1 timeout, 2 fast-fail
  local repo="$1" prev="$2" want="$3" i last err
  for i in $(seq 1 120); do
    mirror_status "$repo"
    last=$(ms last_sync_at)
    err=$(ms last_error)
    if [ "$want" = ok ]; then
      if [ -n "$err" ]; then SETTLED_ERR="$err"; return 2; fi
      if [ -n "$last" ] && [ "$last" != "$prev" ]; then SETTLED_LAST="$last"; return 0; fi
    else
      if [ -n "$err" ]; then SETTLED_ERR="$err"; return 0; fi
    fi
    sleep 1
  done
  return 1
}

# Normalized ref map of a smart-HTTP endpoint (HEAD symref and peeled ^{} lines
# dropped — engines differ in peeling; content equality is asserted via fsck).
refmap() {
  $GITC ls-remote "$1" 2>/dev/null \
    | awk '$2 !~ /\^\{\}$/ && $2 != "HEAD" { print $1" "$2 }' | LC_ALL=C sort
}

# =============================================================================
echo "== 1. source repo: git push with the PAT lands it D1-backed; fixture populated =="
(cd "$DIR" && $GITC init -q -b main seed && cd seed \
  && git config user.email dev@example.com && git config user.name "Dev One" \
  && printf 'mirror e2e seed\n' > README.md && git add -A && git commit -qm "c1" \
  && git checkout -qb feature && printf 'feature work\n' > feature.txt && git add -A && git commit -qm "f1" \
  && git checkout -q main && git tag -a v1 -m "annotated tag v1")
TIP1=$(git -C "$DIR/seed" rev-parse main)
FEATURE1=$(git -C "$DIR/seed" rev-parse feature)
SEED_COUNT=$(git -C "$DIR/seed" rev-list --all --count)

(cd "$DIR/seed" && $GITC push -q "$AUTH_BASE/$OWNER/srcseed.git" main feature) >"$DIR/push-src.out" 2>&1
check $? 0 "source push (push-create, PAT-authenticated)"
SRC_ID=$(d1_field "SELECT id FROM repositories WHERE owner_namespace = '$OWNER' AND slug = 'srcseed'")
[ -n "$SRC_ID" ] && ok "repositories row landed (id $SRC_ID)" || fail "repositories row missing for srcseed"
check "$(d1_field "SELECT status FROM repositories WHERE id = '$SRC_ID'")" "ready" "source repo settles ready"
check "$(d1_field "SELECT is_empty FROM repositories WHERE id = '$SRC_ID'")" "0" "source repo is_empty=false after the push"
check "$(d1_field "SELECT is_mirror FROM repositories WHERE id = '$SRC_ID'")" "0" "source repo is not a mirror"

(cd "$DIR/seed" && $GITC push -q "$DIR/src-fixture.git" "refs/*:refs/*") >/dev/null 2>&1
check $? 0 "fixture bare repo populated with the same refs (harness-side push)"
refmap "$SRC_AUTH_URL/repo.git" > "$DIR/fixture-refs.txt"
grep -q "refs/heads/main" "$DIR/fixture-refs.txt"; check $? 0 "fixture advertises the pushed refs over smart HTTP"

# =============================================================================
echo "== 2. empty target via the API; POST migrate mirror=true → initial sync =="
api POST /user/repos '{"name":"target","auto_init":false,"private":true}'
check "$API_CODE" "201" "API creates the empty target repo"
check "$(jf "$API_BODY" empty)" "true" "target starts empty (auto_init=false)"
TARGET_ID=$(d1_field "SELECT id FROM repositories WHERE owner_namespace = '$OWNER' AND slug = 'target'")
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$BASE/api/v1/repos/$OWNER/target/mirror")
check "$code" "404" "GET mirror before migrate: no mirror row"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v1/repos/$OWNER/target/mirror-sync" -H "Authorization: token $TOKEN")
check "$code" "400" "mirror-sync before migrate: not a mirror"

api POST "/repos/$OWNER/target/migrate" \
  "{\"clone_addr\":\"$SRC_URL/repo.git\",\"mirror\":true,\"mirror_interval\":\"0\",\"auth_username\":\"$SRC_USER\",\"auth_password\":\"$SRC_PASS\"}"
check "$API_CODE" "202" "migrate mirror=true accepted (into-empty shape)"
check "$(jf "$API_BODY" remote_address)" "$SRC_URL/repo.git" "stored remote_address is the sanitized source URL"
check "$(jf "$API_BODY" mirror_interval)" "0" "registered interval (0 = scheduling disabled)"
check "$(jf "$API_BODY" enable_prune)" "true" "enable_prune defaults true"
case "$API_BODY" in *"$SRC_PASS"*) fail "migrate response leaks the source password";; *) ok "migrate response carries no credentials";; esac
mirror_status target
case "$(ms next_sync_at)" in
  ""|"0") fail "mirror row not registered due-now (next_sync_at='$(ms next_sync_at)')";;
  *) ok "mirror row registered due-now (a lost enqueue self-heals at cron)";;
esac

if await_settle target "" ok; then
  ok "initial sync settled: last_sync_at=$(ms last_sync_at), last_error empty (queue delivery works)"
else
  rc=$?
  if [ "$rc" = 2 ]; then fail "initial sync FAILED: last_error=$(ms last_error)"
  else mirror_status target; fail "initial sync did not settle within 120s (is the dev server delivering MIRROR_SYNC_QUEUE?) — status: $(printf '%s' "$MS_BODY" | head -c 300)"; fi
fi

# =============================================================================
echo "== 3. target content: ref-map equality, fresh clone, fsck, rev-list =="
refmap "$SRC_AUTH_URL/repo.git" > "$DIR/refs-src.txt"
refmap "$AUTH_BASE/$OWNER/target.git" > "$DIR/refs-target.txt"
if diff "$DIR/refs-src.txt" "$DIR/refs-target.txt" >/dev/null; then
  ok "target ref map == source ref map (ls-remote both sides)"
else
  fail "ref map mismatch:"; diff "$DIR/refs-src.txt" "$DIR/refs-target.txt" | sed 's/^/    | /'
fi
(cd "$DIR" && $GITC clone -q "$AUTH_BASE/$OWNER/target.git" clone1 2>/dev/null); check $? 0 "clone of the mirror target"
(cd "$DIR/clone1" && git fsck --full >/dev/null 2>&1); check $? 0 "git fsck --full clean on the cloned target"
check "$(git -C "$DIR/clone1" rev-list --all --count)" "$SEED_COUNT" "rev-list --all --count equals the source ($SEED_COUNT)"
check "$(git -C "$DIR/clone1" rev-parse refs/remotes/origin/main)" "$TIP1" "origin/main tip == source main tip"

# =============================================================================
echo "== 4. is_empty posture after a completed sync =="
# SPEC-0009 §2.6 step 4 assigns the empty → populated settle to the sync that
# first gives the repo refs: the landed settlePopulatedRepo (services/mirror/
# sync.ts) flips is_empty + default_branch on the repositories row after a
# successful initial sync (best-effort; the next sync re-checks). This suite
# pins the CONSISTENCY contract — the repo JSON's `empty` flag must agree with
# the D1 source of truth whatever the posture — so a future regression of that
# settle surfaces exactly here, in black-box terms.
EMPTY_D1=$(d1_field "SELECT is_empty FROM repositories WHERE id = '$TARGET_ID'")
api GET "/repos/$OWNER/target"
if [ "$EMPTY_D1" = "0" ]; then
  check "$(jf "$API_BODY" empty)" "false" "repo JSON reports empty=false post-sync (population settle landed)"
elif [ "$EMPTY_D1" = "1" ]; then
  check "$(jf "$API_BODY" empty)" "true" "PINNED: repo JSON still reports empty=true post-sync (population settle absent — SPEC-0009 §2.6 step 4 open item)"
else
  fail "unreadable is_empty for the target (D1 field '$EMPTY_D1')"
fi

# =============================================================================
echo "== 5. push to source → force-sync → target updated (delta sync) =="
(cd "$DIR/seed" && printf 'second commit\n' >> README.md && git add -A && git commit -qm "c2")
TIP2=$(git -C "$DIR/seed" rev-parse main)
(cd "$DIR/seed" && $GITC push -q "$AUTH_BASE/$OWNER/srcseed.git" main) && (cd "$DIR/seed" && $GITC push -q "$DIR/src-fixture.git" refs/heads/main:refs/heads/main)
check $? 0 "second commit pushed to source (dev server + fixture)"

mirror_status target; PREV=$(ms last_sync_at)
SYNC_CODE=$(curl -s -o "$DIR/sync-body" -w '%{http_code}' -X POST -H "Authorization: token $TOKEN" "$BASE/api/v1/repos/$OWNER/target/mirror-sync")
check "$SYNC_CODE" "200" "mirror-sync enqueue accepted"
check "$(wc -c < "$DIR/sync-body" | tr -d ' ')" "0" "mirror-sync answers an empty 200 (upstream AddPullMirrorToQueue shape)"
if await_settle target "$PREV" ok; then
  ok "delta sync settled (last_sync_at $PREV → $(ms last_sync_at))"
else
  rc=$?
  [ "$rc" = 2 ] && fail "delta sync FAILED: $(ms last_error)" || fail "delta sync did not settle within 120s"
fi
(cd "$DIR" && rm -rf clone2 && $GITC clone -q "$AUTH_BASE/$OWNER/target.git" clone2 2>/dev/null); check $? 0 "re-clone after sync"
check "$(git -C "$DIR/clone2" rev-parse refs/remotes/origin/main)" "$TIP2" "target main advanced to the new source tip"
SEED_COUNT_NOW=$(git -C "$DIR/seed" rev-list --all --count)
check "$(git -C "$DIR/clone2" rev-list --all --count)" "$SEED_COUNT_NOW" "rev-list --all --count equals the live source ($SEED_COUNT_NOW)"
(cd "$DIR/clone2" && git fsck --full >/dev/null 2>&1); check $? 0 "fsck clean after the delta sync"

# =============================================================================
echo "== 6. upstream force-rewind applies (the + refspec semantics) =="
(cd "$DIR/seed" && printf 'to be rewound away\n' > rewind.txt && git add -A && git commit -qm "c3")
TIP3=$(git -C "$DIR/seed" rev-parse main)
(cd "$DIR/seed" && $GITC push -q "$AUTH_BASE/$OWNER/srcseed.git" main) && (cd "$DIR/seed" && $GITC push -q "$DIR/src-fixture.git" refs/heads/main:refs/heads/main)
mirror_status target; PREV=$(ms last_sync_at)
curl -s -o /dev/null -X POST -H "Authorization: token $TOKEN" "$BASE/api/v1/repos/$OWNER/target/mirror-sync"
await_settle target "$PREV" ok || fail "sync before the rewind did not settle (last_error: $(ms last_error))"
check "$(git -c credential.helper= ls-remote "$AUTH_BASE/$OWNER/target.git" refs/heads/main | cut -f1)" "$TIP3" "rewind setup: target at the pre-rewind tip"

(cd "$DIR/seed" && git reset -q --hard "$TIP2" && printf 'rewritten history\n' > README.md && git add -A && git commit -qm "c4-rewritten")
TIP4=$(git -C "$DIR/seed" rev-parse main)
(cd "$DIR/seed" && $GITC push -qf "$AUTH_BASE/$OWNER/srcseed.git" main) && (cd "$DIR/seed" && $GITC push -qf "$DIR/src-fixture.git" refs/heads/main:refs/heads/main)
check $? 0 "source force-pushed the rewind (dev server accepts non-fast-forward; CAS-free force)"
mirror_status target; PREV=$(ms last_sync_at)
curl -s -o /dev/null -X POST -H "Authorization: token $TOKEN" "$BASE/api/v1/repos/$OWNER/target/mirror-sync"
if await_settle target "$PREV" ok; then
  ok "post-rewind sync settled"
else
  rc=$?; [ "$rc" = 2 ] && fail "post-rewind sync FAILED: $(ms last_error)" || fail "post-rewind sync did not settle"
fi
check "$(git -c credential.helper= ls-remote "$AUTH_BASE/$OWNER/target.git" refs/heads/main | cut -f1)" "$TIP4" "target main follows the REWRITTEN tip (force update applied)"
(cd "$DIR" && rm -rf clone3 && $GITC clone -q "$AUTH_BASE/$OWNER/target.git" clone3 2>/dev/null)
git -C "$DIR/clone3" log --format=%H | grep -q "$TIP3"
check $? "1" "abandoned pre-rewind commit unreachable in the target's history"

# =============================================================================
echo "== 7. prune: deletes apply when enable_prune, survive when disabled =="
(cd "$DIR/seed" && $GITC push -q "$AUTH_BASE/$OWNER/srcseed.git" :refs/heads/feature) && (cd "$DIR/seed" && $GITC push -q "$DIR/src-fixture.git" :refs/heads/feature)
check $? 0 "feature branch deleted upstream (both sides)"
mirror_status target; PREV=$(ms last_sync_at)
curl -s -o /dev/null -X POST -H "Authorization: token $TOKEN" "$BASE/api/v1/repos/$OWNER/target/mirror-sync"
await_settle target "$PREV" ok || fail "prune sync did not settle (last_error: $(ms last_error))"
refmap "$AUTH_BASE/$OWNER/target.git" > "$DIR/refs-target2.txt"
grep -q "refs/heads/feature" "$DIR/refs-target2.txt" && fail "prune-on: refs/heads/feature still advertised" || ok "prune-on: deleted ref pruned from the target"

# enable_prune has no PATCH surface yet (api/services/mirror.ts defers it to
# PATCH) — flip the column directly; this is harness-side arrangement, the
# behavior under test (§4.3.3) is the consumer's.
d1 "UPDATE repo_mirrors SET enable_prune = 0 WHERE repo_id = '$TARGET_ID'" >/dev/null
check "$(d1_field "SELECT enable_prune FROM repo_mirrors WHERE repo_id = '$TARGET_ID'")" "0" "enable_prune disabled for the next sync (D1; no PATCH surface yet)"
(cd "$DIR/seed" && git branch -qD feature && git checkout -qb feature && printf 'feature again\n' > feature2.txt && git add -A && git commit -qm "f2" && git checkout -q main)
FEATURE2=$(git -C "$DIR/seed" rev-parse feature)
(cd "$DIR/seed" && $GITC push -q "$AUTH_BASE/$OWNER/srcseed.git" feature) && (cd "$DIR/seed" && $GITC push -q "$DIR/src-fixture.git" refs/heads/feature:refs/heads/feature)
mirror_status target; PREV=$(ms last_sync_at)
curl -s -o /dev/null -X POST -H "Authorization: token $TOKEN" "$BASE/api/v1/repos/$OWNER/target/mirror-sync"
await_settle target "$PREV" ok || fail "recreate-feature sync did not settle (last_error: $(ms last_error))"
git -c credential.helper= ls-remote "$AUTH_BASE/$OWNER/target.git" refs/heads/feature | grep -q "$FEATURE2"; check $? 0 "prune-off: recreated ref lands"
(cd "$DIR/seed" && $GITC push -q "$AUTH_BASE/$OWNER/srcseed.git" :refs/heads/feature) && (cd "$DIR/seed" && $GITC push -q "$DIR/src-fixture.git" :refs/heads/feature)
mirror_status target; PREV=$(ms last_sync_at)
curl -s -o /dev/null -X POST -H "Authorization: token $TOKEN" "$BASE/api/v1/repos/$OWNER/target/mirror-sync"
await_settle target "$PREV" ok || fail "prune-off delete sync did not settle (last_error: $(ms last_error))"
git -c credential.helper= ls-remote "$AUTH_BASE/$OWNER/target.git" refs/heads/feature | grep -q "$FEATURE2"; check $? 0 "prune-off: upstream-deleted ref SURVIVES on the target"
d1 "UPDATE repo_mirrors SET enable_prune = 1 WHERE repo_id = '$TARGET_ID'" >/dev/null

# =============================================================================
echo "== 8. v0 fallback: the same source over a v0-only fixture path =="
api POST /user/repos '{"name":"v0target","auto_init":false,"private":true}'
check "$API_CODE" "201" "API creates the v0 target repo"
api POST "/repos/$OWNER/v0target/migrate" \
  "{\"clone_addr\":\"$SRC_URL/v0/repo.git\",\"mirror\":true,\"mirror_interval\":\"0\",\"auth_username\":\"$SRC_USER\",\"auth_password\":\"$SRC_PASS\"}"
check "$API_CODE" "202" "migrate against the v0-only source accepted"
if await_settle v0target "" ok; then
  ok "v0 initial sync settled"
else
  rc=$?; [ "$rc" = 2 ] && fail "v0 sync FAILED: $(ms last_error)" || fail "v0 sync did not settle within 120s"
fi
refmap "$SRC_AUTH_URL/v0/repo.git" > "$DIR/refs-src-v0.txt"
refmap "$AUTH_BASE/$OWNER/v0target.git" > "$DIR/refs-target-v0.txt"
if diff "$DIR/refs-src-v0.txt" "$DIR/refs-target-v0.txt" >/dev/null; then
  ok "v0 target ref map == v0 source ref map (v0 advertisement parse + v0 fetch + sideband)"
else
  fail "v0 ref map mismatch:"; diff "$DIR/refs-src-v0.txt" "$DIR/refs-target-v0.txt" | sed 's/^/    | /'
fi

# =============================================================================
echo "== 9. mirrors are read-only (§2.4 row 21) =="
RO_BODY=$(curl -s -u "x:$TOKEN" "$BASE/$OWNER/target.git/info/refs?service=git-receive-pack")
RO_CODE=$(curl -s -o /dev/null -w '%{http_code}' -u "x:$TOKEN" "$BASE/$OWNER/target.git/info/refs?service=git-receive-pack")
check "$RO_CODE" "403" "authenticated receive-pack advert on the mirror"
printf '%s' "$RO_BODY" | grep -q "mirror repository is read-only"; check $? 0 "403 body carries the upstream text"
ANON_CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/$OWNER/target.git/info/refs?service=git-upload-pack")
check "$ANON_CODE" "401" "anonymous reads on the private mirror still challenge first (ACL order)"
(cd "$DIR/clone3" && git config user.email dev@example.com && git config user.name "Dev Two" \
  && printf 'push attempt\n' > push.txt && git add -A && git commit -qm "push-attempt" \
  && $GITC push "$AUTH_BASE/$OWNER/target.git" main) >"$DIR/push-target.out" 2>&1
PUSH_RC=$?
[ "$PUSH_RC" -ne 0 ]; check $? 0 "git push to the mirror fails (exit $PUSH_RC)"
grep -q "403" "$DIR/push-target.out" && ok "git reports the 403 from the receive-pack advert" || fail "expected a 403 in the push output"

# =============================================================================
echo "== 10. SSRF egress gate: the source URL never reaches a disallowed host =="
api POST /user/repos '{"name":"probe","auto_init":false,"private":true}'
check "$API_CODE" "201" "API creates the probe repo"
api POST "/repos/$OWNER/probe/migrate" '{"clone_addr":"'$SRC_URL'/repo.git","mirror":false}'
check "$API_CODE" "422" "migrate into an existing repo requires mirror=true"
printf '%s' "$API_BODY" | grep -q "requires mirror=true"; check $? 0 "422 carries the documented message"

expect_422() { # body-substring, label, clone_addr
  api POST "/repos/$OWNER/probe/migrate" "{\"clone_addr\":\"$3\",\"mirror\":true,\"mirror_interval\":\"0\"}"
  check "$API_CODE" "422" "$2"
  printf '%s' "$API_BODY" | grep -qF "$1"; check $? 0 "$2 — message text"
}
expect_422 "The provided URL is invalid." "http:// scheme rejected (https-only sources)" "http://$SRC_HOST:$SRC_PORT/repo.git"
expect_422 "You can not import from disallowed hosts." "loopback port without an IP allow entry rejected" "https://$SRC_HOST:$((SRC_PORT + 1))/repo.git"
expect_422 "You can not import from disallowed hosts." ".internal host name rejected" "https://foo.internal/repo.git"
expect_422 "The provided URL is invalid." "credentials in the URL userinfo rejected" "https://u:p@$SRC_HOST:$SRC_PORT/repo.git"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: token $TOKEN" "$BASE/api/v1/repos/$OWNER/probe/mirror")
check "$code" "404" "no mirror row survived the rejected migrates"
check "$(d1_field "SELECT is_mirror FROM repositories WHERE owner_namespace = '$OWNER' AND slug = 'probe'")" "0" "probe repo still not a mirror"
SYNC_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: token $TOKEN" "$BASE/api/v1/repos/$OWNER/probe/mirror-sync")
check "$SYNC_CODE" "400" "mirror-sync on a non-mirror: upstream 400 text path"

# =============================================================================
echo "== 11. source death: sanitized last_error; the snapshot still serves =="
kill "$FIXTURE_PID" 2>/dev/null; FIXTURE_PID=""
for _ in $(seq 1 20); do curl -s -o /dev/null --max-time 1 --cacert "$DIR/tls/ca.pem" "$SRC_URL/repo.git/info/refs?service=git-upload-pack" || break; sleep 0.5; done
curl -s -o /dev/null --max-time 2 --cacert "$DIR/tls/ca.pem" "$SRC_URL/repo.git/info/refs?service=git-upload-pack" 2>/dev/null
check $? "7" "fixture port is closed (curl exit 7 = connection refused)"

mirror_status target; PREV=$(ms last_sync_at)
curl -s -o /dev/null -X POST -H "Authorization: token $TOKEN" "$BASE/api/v1/repos/$OWNER/target/mirror-sync"
if await_settle target "$PREV" error; then
  ok "failed sync recorded last_error and returned to idle"
else
  fail "sync against the dead source did not record last_error within 120s"
fi
mirror_status target
check "$(ms sync_state)" "idle" "sync_state back to idle after the failure"
case "$(ms last_error)" in
  *"$SRC_PASS"*) fail "last_error leaks the source password";;
  *) ok "last_error carries no credentials";;
esac
case "$(ms last_error)" in
  *"$SRC_URL/repo.git"*) ok "last_error carries the sanitized source URL";;
  *) fail "last_error missing the sanitized URL (got: $(ms last_error | head -c 200))";;
esac
(cd "$DIR" && rm -rf clone-after-death && $GITC clone -q "$AUTH_BASE/$OWNER/target.git" clone-after-death 2>/dev/null)
check $? 0 "mirror is a snapshot: target still serves full clones with the source dead"

# =============================================================================
echo "== cleanup: engine DELETE + D1 row sweep =="
if [ "$FAIL" -eq 0 ]; then
  for repo in srcseed target v0target; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -u "x:$TOKEN" "$BASE/$OWNER/$repo")
    check "$code" "200" "engine DELETE $repo (cells + R2 purge enqueued)"
  done
  code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -u "x:$TOKEN" "$BASE/$OWNER/probe")
  case "$code" in 200|404) ok "engine DELETE probe (200 or 404 — the empty probe repo may have no cell)";; *) fail "engine DELETE probe got $code";; esac
  d1 "DELETE FROM repo_mirrors WHERE repo_id IN (SELECT id FROM repositories WHERE owner_namespace = '$OWNER')" >/dev/null
  d1 "DELETE FROM repo_units WHERE repo_id IN (SELECT id FROM repositories WHERE owner_namespace = '$OWNER')" >/dev/null
  d1 "DELETE FROM repo_counters WHERE repo_id IN (SELECT id FROM repositories WHERE owner_namespace = '$OWNER')" >/dev/null
  d1 "DELETE FROM repositories WHERE owner_namespace = '$OWNER'" >/dev/null
  d1 "DELETE FROM users WHERE username_lower = '$OWNER'" >/dev/null
  check "$(d1_field "SELECT COUNT(*) FROM repositories WHERE owner_namespace = '$OWNER'")" "0" "repositories rows swept"
  check "$(d1_field "SELECT COUNT(*) FROM repo_mirrors m JOIN repositories r ON r.id = m.repo_id WHERE r.owner_namespace = '$OWNER'")" "0" "mirror rows swept"
else
  echo "  (failures above — leaving $OWNER/* and the scratch dir $DIR for debugging)"
fi

echo
echo "=== RESULT: $PASS passed, $FAIL failed (workdir $DIR) ==="
exit $((FAIL > 0))
