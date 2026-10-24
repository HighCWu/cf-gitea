# Pull-mirror e2e suite (SPEC-0009 §5 black-box layer)

Real git clients against a running dev Worker — the black-box layer of
SPEC-0009 §5's testing plan (milestone M4's e2e item). The **source** side is a
real smart-HTTP endpoint (`apps/worker/test/fixtures/git-http-server.mjs`,
CI-only, shelling `git upload-pack --stateless-rpc [--advertise-refs]` on
loopback — the engine e2e's real-git discipline, SPEC-0001 §6); the **target**
side is the Worker's own git + API surface. Conventions follow
`scripts/lfs-e2e.sh`: real client traffic, hard assertions that exit non-zero,
per-check `ok:`/`FAIL:` lines, wrangler D1 `--local` introspection (the wrangler
CLI shares the dev server's `apps/worker/.wrangler/state/v3` state), full
cleanup on a green run.

## How to run

```bash
pnpm test:mirror                              # or: bash scripts/mirror-e2e.sh
bash scripts/mirror-e2e.sh http://127.0.0.1:5199   # explicit base URL
```

- Default target is `http://127.0.0.1:5199` — the suite starts its OWN dev
  server there (`pnpm dev`) and kills it on exit. It deliberately does NOT
  reuse an already-running dev server: it must start the Worker with
  `SSL_CERT_FILE` pointing at the fixture's throwaway CA (below), and only a
  server it owns can get that environment. A server already answering at
  `$BASE` is a hard error with instructions.
- The source fixture listens on `https://127.0.0.1:8443` (override with
  `SRC_PORT`; whatever it is, `MIRROR_ALLOWED_HOST_LIST` must cover it).
- Requirements: `git`, `curl`, `node`, `openssl` (the per-run TLS identity is
  generated, never committed), `pnpm`, and local migrations applied
  (`pnpm db:migrate:local` — migration 0010 lands `repo_mirrors`).
- The suite bootstraps its own fixtures under the fixed username `mirrore2e`
  (admin user + all-scopes PAT via `scripts/bootstrap-admin.mjs` on LOCAL D1)
  and deletes them again on a green run (`DELETE FROM users` cascades the
  PATs). A red run leaves everything in place for debugging; the next run
  pre-cleans it. Global git config changes are sandboxed into the script's
  scratch `$HOME`.

## Dev environment contract (why the extra config)

The egress gate (SPEC-0009 §4.1) admits the loopback fixture only through an
explicit **IP-form allow entry**, and source credentials are stored under a KEK
(§4.2). Both reach the Worker as env from `apps/worker/.dev.vars`:

```
GIT_TOKEN=devtoken                                  # (already in the example)
MIRROR_ALLOWED_HOST_LIST=127.0.0.1:8443             # explicit IP entry: host:port
MIRROR_CREDENTIAL_KEY=<base64 of 32 random bytes>   # openssl rand -base64 32
```

**These keys are inert unless the names are declared in
`apps/worker/wrangler.jsonc`.** Wrangler semantics (verified empirically on
wrangler 4.152 + @cloudflare/vite-plugin 1.65, both dev and preview): when the
Worker config declares a `secrets` block, ONLY declared names are loaded from
`.dev.vars` — undeclared keys never reach the Worker env (`GIT_TOKEN` is
already declared under `secrets.required`, which is why it works today). So
`wrangler.jsonc` must gain:

```jsonc
"secrets": {
  "required": ["GIT_TOKEN", "MIRROR_ALLOWED_HOST_LIST", "MIRROR_CREDENTIAL_KEY"]
}
```

(The values themselves stay dev-local in `.dev.vars`; declaring the names does
not put anything secret in the committed config. `MIRROR_EGRESS_MODE` is
optional — absent means the lax default.)

The suite preflights all three: `.dev.vars` keys present, names declared in
`wrangler.jsonc`, the allow entry covering the fixture address, and migration
0010 applied — each with a copy-paste fix in the failure message.

**TLS trust**: the egress gate is https-only (§1's documented divergence from
upstream), so the fixture serves TLS with a throwaway CA + leaf generated per
run. workerd verifies outbound TLS and honors `SSL_CERT_FILE` /
`SSL_CERT_DIR` (rustls native-certs) as its trust anchor — the suite starts the
dev server with `SSL_CERT_FILE=<scratch>/tls/ca.pem`, which is why it must own
the server process. The fixture's leaf carries `SAN IP:127.0.0.1`, CA:FALSE,
serverAuth; the CA is never written anywhere but the scratch dir.

## Scenario map (SPEC-0009 §5.2-5.7 → the landed surface)

SPEC-0009 §5.2/§5.3 describe upstream's `POST /repos/migrate` (creates the
target); the landed surface is the **into-empty** shape (`POST
/repos/{owner}/{repo}/migrate`, routes/mirror.ts — upstream's create-target
form has no repo-scoped path key outside the frozen SPEC-0004 inventory). The
suite therefore creates the target via `POST /api/v1/user/repos` first; the
initial population rides the enqueued mirror-sync (a delta sync against an
empty repo fetches every advertised tip), so §5.2's migrate and §5.3's first
sync are one flow here. `enable_prune=false` is exercised via a direct D1 flip
until the PATCH mirror-settings surface lands (api/services/mirror.ts defers
it to PATCH).

1. Source repo via `git push` (PAT-authenticated → push-create, D1-backed,
   `status=ready`, `is_empty=false`); the fixture's bare repo is populated
   harness-side with the same refs (a local-path push — never a client scheme).
2. Empty target via the API → `POST migrate` with `mirror=true`, credentials
   in the structured fields, `mirror_interval: "0"` → `202` + sanitized
   `remote_address`, no secrets echoed; poll `GET mirror` until
   `last_sync_at` is set (also proves the dev server delivers
   `MIRROR_SYNC_QUEUE` messages to the consumer — the cron producer never
   fires in dev, and `interval=0` keeps scheduling off).
3. Ref-map equality (`ls-remote` on both sides), fresh clone, `git fsck
   --full`, `rev-list --all --count` equality vs the source.
4. is_empty posture: the first successful sync settles the population (the
   landed `settlePopulatedRepo`, services/mirror/sync.ts — the §2.6 step 4
   shape: `is_empty=false` + default branch, best-effort with self-heal). The
   suite pins the CONSISTENCY contract — the repo JSON's `empty` flag must
   agree with the D1 source of truth — so a regression of that settle surfaces
   here in black-box terms. (Historical note: the suite first ran against a
   tree where the settle was still a documented open item and pinned the
   honest empty=true posture; the settle wave landed mid-flight.)
5. Push to source (dev server + fixture) → `POST mirror-sync` (empty 200,
   upstream `AddPullMirrorToQueue` shape) → delta lands; re-clone + fsck.
6. Force-rewind the source branch (`reset --hard` + `push --force`) → the
   sync applies the rewritten tip; the abandoned commit is unreachable in a
   fresh clone (the `+` refspec semantics, §4.3.2).
7. Prune: upstream-deleted ref disappears with `enable_prune=true`; with the
   column flipped to 0 a deleted ref survives (§4.3.3).
8. v0 fallback: a second migrate against the fixture's `/v0` path (no
   `GIT_PROTOCOL` forwarded → the source speaks v0) — v0 advertisement parse,
   v0 want/have fetch, side-band-64k demux.
9. Read-only: authenticated receive-pack advert → `403 "mirror repository is
   read-only"` (§2.4 row 21); `git push` fails; anonymous reads on the private
   mirror still 401 first (ACL order); non-mirror `mirror-sync` → 400.
10. SSRF gate (§4.1): `http://` and userinfo URLs → `422 "The provided URL is
    invalid."`; a loopback port WITHOUT an allow entry and `*.internal` →
    `422 "You can not import from disallowed hosts."`; no mirror row survives.
11. Source death: fixture killed → next sync records a sanitized `last_error`
    (no credentials, sanitized URL), `sync_state=idle`, and the target still
    serves full clones (mirrors are snapshots, §4.3.4).

## Suggested CI job (not wired yet)

```yaml
  mirror-e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { submodules: recursive }
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm db:migrate:local
      # .dev.vars (values are CI-local): GIT_TOKEN satisfies
      # wrangler.jsonc's secrets.required; the mirror keys + the wrangler.jsonc
      # declarations (see "Dev environment contract") are REQUIRED — the suite
      # preflights them and fails with the exact missing piece.
      - run: |
          cat > apps/worker/.dev.vars <<'EOF'
          GIT_TOKEN=ci-dev-token
          MIRROR_ALLOWED_HOST_LIST=127.0.0.1:8443
          MIRROR_CREDENTIAL_KEY=OR9xOOi4L+VpTHWpz3d9tCwNWGex2CVu5tSO3Q0vbKE=
          EOF
      - run: bash scripts/mirror-e2e.sh
```

(ubuntu-latest ships git, curl, node, openssl; the fixture and dev server are
started and killed by the suite itself, so the job needs no wait-on step.
`openssl rand -base64 32` fresh per CI run is fine too — the value only needs
to be 32 base64 bytes for the AES-256-GCM KEK.)

## Known red

**None on the current tree** — the suite runs fully green against it. The two
product gaps the suite found on its first run were both fixed since (the suite
is what surfaced them, so they are kept here for the record):

1. **v2 advertisement with the `# service=` preamble failed to parse** —
   `apps/worker/src/services/mirror/gitclient.ts` `parseInfoRefsAdvert` only
   recognized the v2 capability advert as the FIRST pkt-line. Real smart-HTTP
   servers (git http-backend and everything modeled on it — i.e. the fixture,
   and every forge a mirror would fetch from) write
   `# service=git-upload-pack` + flush BEFORE the `version 2` advert; the
   parser then fell into the v0 ref-line loop and threw
   `malformed oid in v0 advertisement: 2`, so every mirror sync against a real
   v2 source failed. Real git clients accept both shapes (the preamble is
   required output server-side; clients skip it), and the client's own unit
   fixtures fed v2 WITHOUT the preamble — which is why the unit layer stayed
   green. **Fixed in 2278fc6** (service-header flush consumed, then the v2
   capability-advert path re-detected; packfile section framing corrected
   alongside). Scenarios 2-8 cover the regression.
2. **The `.dev.vars` mirror keys were not declared in `wrangler.jsonc`** (see
   "Dev environment contract") — with `secrets` declared, wrangler loads ONLY
   declared names from `.dev.vars`, so migrate would 422 "You can not import
   from disallowed hosts." even with a correct `MIRROR_ALLOWED_HOST_LIST`.
   **Fixed in 2788d3c** (both names added to `secrets.required`); the suite
   preflights the declaration and fails with the exact instruction if it ever
   regresses.

## Scope limits

- The 500 MiB single-window budget assertion (§5.8) needs the T3
  instrumentation and is not part of this suite (the suite's payloads are
  e2e-scale; the fixture buffers request bodies by design).
- Webhook push events per synced ref delta (§5.3's webhook assertion, §2.7)
  are not asserted: the sync consumer does not drive the notify pipeline yet
  (sync.ts's documented landing wave) — there is nothing to observe.
- `MIRROR_CREDENTIAL_KEY`-absent, wrong-AAD and KEK-rotation paths are unit
  territory (api/mirror.test.ts covers the envelope roundtrip through the
  consumer's own decrypt); the e2e pins the HAPPY credential path end-to-end
  (the fixture requires Basic auth on every request, so every sync decrypts
  and sends the stored credentials).
- The cron producer (`enqueueDueMirrorSyncs`) is not exercised: dev fires no
  crons, and every sync here is driven explicitly (`mirror-sync` POST or the
  migrate enqueue). The producer's due-select/CAS discipline has its own
  worker-integration coverage.
