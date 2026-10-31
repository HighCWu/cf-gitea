# SPEC: Federation (ActivityPub) — the pin census, the parity verdict, and the staged build

Status: **draft** (v1.4 queue; written 2026-10-31, not yet ratified).
**Tier A (W-A1) LANDED as-built 2026-10-31 — see §6.1.1; Tier B stays parked on OQ-1.**
Pin: `fc493688` (gitea v1.22.0-rc1-3919).

---

## 1. Problem and scope

The v1.4 queue carries a design pass for **federation**. The mission framed it as
"the pin carries an experimental gated surface" — the census below is the honest
answer to that framing, and the census IS the headline:

**The pin's federation surface is tiny, and upstream itself retracted the
implementation that once existed.** At `fc493688`:

- The gate (`federationEnabled`, `routers/web/web.go:409-414`) serves **404**
  unless `setting.Federation.Enabled` — whose default is **false**
  (`modules/setting/federation.go:23`).
- Even when force-enabled, the entire API side is **four 501 stubs' worth of
  registered routes with no handlers**: `routers/api/v1/activitypub/person.go`
  contains exactly one function, `NotImplemented`, answering
  `http.Error(ctx.Resp, "Not implemented", http.StatusNotImplemented)`
  (`person.go:12-14`).
- Only two real endpoints survive behind the gate: `GET /.well-known/nodeinfo`
  (a link list) and `GET /.well-known/webfinger` (a full, working webfinger).
- The decisive history is commit `1592576fa5` (upstream PR **#36789**, "Mark
  unused&immature activitypub as 'not implemented'", carried in the pin's
  history). Its message, verbatim:

  > After many years, "activitypub" is still "in progress" and no real
  > progress for end users. So it is not mature.
  >
  > Temporarily mark the endpoints as "501 not implemented",
  > and wait until the whole design is stable and usable.

  That commit deleted **1083 lines**: the Person actor endpoint, the HTTP-signature
  verification middleware, the delivery client, the per-user RSA keypair store,
  the full nodeinfo 2.1 data endpoint, the ActivityPub swagger family, the
  `modules/structs/activitypub.go` response structs, and all three integration
  tests (`tests/integration/api_activitypub_person_test.go`,
  `api_nodeinfo_test.go`, `webfinger_test.go`).

**Consequences for this SPEC**, under the Upstream-Parity Decision Rule
(AGENTS.md):

1. Upstream's answer at the pin is *discovery-only, disabled by default, 501 for
   every data endpoint*. Parity therefore commits us to **exactly that** — and
   nothing more. The parity-committed tier (Tier A, §6) is small and cheap.
2. Building actors / inbox / outbox / delivery would **exceed** upstream — the
   Rule's second branch fires (upstream has no stable answer to adapt), so that
   tier is a genuine decision point. This SPEC stages it as design-complete,
   gated on an explicit ratification (OQ-1), with the design pulled from
   upstream's own deleted implementation (`1592576fa5^`) so that IF the surface
   is ever opened, it opens upstream-faithful rather than Mastodon-invented.
3. **No code lands from this SPEC until ratification.** It is a design pass and
   a parity record.

In scope: the full census with cites (§2); the Workers adjudication (§3); the
divergence decisions (§4); the data model (§5); the wave decomposition with
file-ownership sketches (§6); the testing plan (§7); open questions (§8).

Out of scope (this SPEC, permanently unless upstream changes): Forgejo-style
`federation_block` moderation — **never present in upstream history** (checked:
`git log --all -S federation_block` in the submodule returns nothing), so there
is no surface to port and none is invented here. Fediverse *features* (follows,
boosts, timelines): no upstream answer exists at any point in the pin's history
— OQ-5 records the honest posture.

---

## 2. The pin's surface map (census)

### 2.1 The setting

`modules/setting/federation.go:14-30` — the `Federation` struct, with defaults:

| Field | Default | Read at the pin? |
|---|---|---|
| `Enabled` | **`false`** | yes — the web gate (`web.go:410`) and the API route registration (`api.go:1007`) |
| `ShareUserStatistics` | `true` | **NO — dead config.** Its only consumer (the pre-stub nodeinfo usage counts) was deleted by #36789 |
| `MaxSize` | `4` (MiB; loader converts to bytes, `federation.go:45`) | **NO — dead config** (consumer was the deleted `reqsignature.go` fetch cap / delivery client) |
| `Algorithms` | `["rsa-sha256", "rsa-sha512", "ed25519"]` | dead at the pin (the loader builds `HttpsigAlgs`, `federation.go:47-50`, and **nothing reads `HttpsigAlgs`** — verified repo-wide grep) |
| `DigestAlgorithm` | `"SHA-256"` | validated at load (`federation.go:39`, via `httpsig.IsSupportedDigestAlgorithm`) but otherwise dead |
| `GetHeaders` | `["(request-target)", "Date"]` | dead config (consumer was the deleted client) |
| `PostHeaders` | `["(request-target)", "Date", "Digest"]` | dead config |

The setting loader imports `github.com/42wim/httpsig v1.3.0` (`go.mod:13`).
Config section: `[federation]` in `app.ini` semantics.

### 2.2 Web routes (behind the gate)

`routers/web/web.go:531-536`, inside the `/.well-known` group (whole group
wrapped by `optionsCorsHandler()`, `web.go:542` — CORS follows
`[cors]` config, `web.go:61-62`; both routes sit behind the `federationEnabled`
middleware, i.e. **404 when disabled**):

1. **`GET /.well-known/nodeinfo`** → `NodeInfoLinks`
   (`routers/web/nodeinfo.go:23-31`) — REAL and complete. Returns:
   `{"links":[{"href":"{AppURL}api/v1/nodeinfo","rel":"http://nodeinfo.diaspora.software/ns/schema/2.1"}]}`
   — a pointer to the (stubbed) data endpoint. Nothing else.

2. **`GET /.well-known/webfinger`** → `WebfingerQuery`
   (`routers/web/webfinger.go:38-122`) — REAL and complete:
   - `resource=acct:...`: parses `acct:user@host`, rejects any host ≠
     `AppURL.Host` with 400 (`webfinger.go:57-60` — **same-instance only**;
     no remote-actor proxying exists), resolves via `GetUserByName`.
   - `resource=mailto:...`: resolves via `GetUserByEmail`, suppressed when the
     user keeps email private (`webfinger.go:63-67`).
   - Any other scheme: 400 (`webfinger.go:68-70`).
   - Visibility gate: `IsUserVisibleToViewer` → 404 when hidden
     (`webfinger.go:82-85`).
   - JRD response (`webfinger.go:87-121`): aliases = HTMLURL +
     `{AppURL}api/v1/activitypub/user-id/{id}` (+ `mailto:` unless private);
     links = profile-page (text/html), avatar, **self with
     `type=application/activity+json` → the actor IRI**, openid-connect issuer;
     `Access-Control-Allow-Origin: *` stamped explicitly (`webfinger.go:116`);
     subject = `acct:{urlencoded-name}@{host}`.

So the pin's webfinger **already advertises an actor URL that 501s**. The
discovery tier points at a door that is not built. That is upstream's honest
posture, and ours must match it if Tier A-only is ratified.

### 2.3 API routes (registered only when enabled)

`routers/api/v1/api.go:1007-1010`:

```go
if setting.Federation.Enabled {
    m.Get("/nodeinfo", activitypub.NotImplemented)
    m.Any("/activitypub/*", tokenRequiresScopes(auth_model.AccessTokenScopeCategoryActivityPub), activitypub.NotImplemented)
}
```

- **`GET /api/v1/nodeinfo`** → 501 "Not implemented" (plain text).
- **`ANY /api/v1/activitypub/*`** → 501; carries the
  `tokenRequiresScopes(ActivityPub)` gate — upstream DOES wire the
  `read:activitypub`/`write:activitypub` token scopes to this group
  (scopes defined at `models/auth/access_token_scope.go:18, 60-61`; the
  category is the first iota, `access_token_scope.go:18`). The scopes are
  otherwise valid-but-unconsumable strings (SPEC-0002 §2.4 records the
  grammar port).

### 2.4 What the pin does NOT carry (the negative census, each verified)

- **No `models/federation/`, no `services/activitypub/`, no
  `modules/activitypub/`** — directories absent.
- **No inbox/outbox handlers anywhere** — repo-wide grep for
  `inbox|outbox|Inbox|Outbox` in models/modules/services/routers returns only
  mail-related matches outside the deleted history.
- **No federation DB tables** — no `federation_block`, no actor table, no
  remote-actor cache; the v1.20 migration `v259.go` carries only the token-scope
  conversion (its ActivityPub references are scope strings, not tables).
- **No moderation surface** — see §1; Forgejo-only concept.
- **No fediverse user features** — no follow/unfollow, no boosts, no remote
  profiles; nothing in `models/user/` references ActivityPub (the keypair
  constants `UserActivityPubPrivPem`/`PubPem` were deleted from
  `models/user/setting_options.go` by #36789; grep confirms gone).
- **No OpenAPI surface** — `templates/swagger/v1-swagger.generated.json` has
  zero `/activitypub/*` or `/nodeinfo` paths; the only `activitypub` token in
  the spec is a scope string in the AccessToken example array. The frozen
  contract is unaffected by everything in this SPEC (see §6.3).
- **No HTTP-signature verification for federation** — the surviving
  `services/auth/httpsign.go` is a *user-authentication* method (SSH public-key
  HTTP signatures for `/api/v1` requests, wired at `api.go:852`, same
  `42wim/httpsig` library). It is adjacent technology, NOT federation, and this
  SPEC does not modify it.
- **No tests** — all three federation integration tests were deleted by #36789.
  Upstream ships this surface with zero coverage.

### 2.5 Upstream's last stated architecture (pre-stub, `1592576fa5^`)

Recoverable from the pin's own git history — the reference for Tier B so the
surface, if ever built, is upstream-faithful rather than invented:

- **Person actor** (`routers/api/v1/activitypub/person.go` at `1592576fa5^`):
  - Actor IRI: `{AppURL}/api/v1/activitypub/user-id/{user-id}` — **numeric-ID
    IRIs; the username is NOT in the path**. Name = `FullName`,
    `PreferredUsername` = username, `URL` = `HTMLURL`, `Icon` = avatar PNG.
  - Declares `inbox` = `{actorIRI}/inbox` and `outbox` = `{actorIRI}/outbox` —
    **the outbox IRI was declared but never had a handler**; `PersonInbox`
    accepted POSTs and answered **204 with no processing** (a black hole).
  - `publicKey`: `{actorIRI}#main-key`, owner = actor IRI, PEM from the per-user
    keypair. Content-Type:
    `application/ld+json; profile="https://www.w3.org/ns/activitystreams"`
    (the `ActivityStreamsContentType` const, `modules/activitypub/client.go:23-24`
    at `1592576fa5^`). Marshalled with `go-ap/activitypub` + `go-ap/jsonld`
    (both dependencies removed by #36789).
- **Signature middleware** (`reqsignature.go` at `1592576fa5^`): draft-cavage
  HTTP signatures via `httpsig.NewVerifier`; the `keyId` is an **IRI** — the
  middleware **fetches the remote actor document over HTTPS** (`fetch()`,
  capped at `Federation.MaxSize`), extracts `publicKey.publicKeyPem`, decodes
  SPKI (`x509.ParsePKIXPublicKey`), and verifies with
  `Algorithms[0]` (`rsa-sha256`). No cache: every signed request costs a remote
  fetch. Failure = 403 "request signature verification failed".
- **Keypairs** (`modules/activitypub/user_settings.go` at `1592576fa5^`):
  per-user **RSA-3072**, lazily generated on first use, stored as PEM strings
  in the `user_setting` table under the two (now deleted) setting keys.
- **Delivery client** (`modules/activitypub/client.go` at `1592576fa5^`):
  synchronous in-request POST to an inbox URL — headers Content-Type + Date
  (RFC 1123/GMT) + Digest; `httpsig.NewSigner` over `PostHeaders`
  (`(request-target)`, `Date`, `Digest`), `Signature` scheme, 60 s expiry;
  signs with the sending user's RSA key, `keyId` = `{actorIRI}#main-key`.
  Required-header validation (`containsRequiredHTTPHeaders`) enforces the
  `GetHeaders`/`PostHeaders` posture from settings.
- **Nodeinfo 2.1 data** (`routers/api/v1/misc/nodeinfo.go` at `1592576fa5^`):
  `version:"2.1"`, `software{name:"gitea", version, repository, homepage}`,
  `protocols:["activitypub"]`, `services{inbound:[], outbound:["rss2.0"]}`,
  `openRegistrations = ShowRegistrationButton`, `usage{users{total,
  activeMonth, activeHalfyear}, localPosts = issue count, localComments =
  comment count}` — the usage counts computed only when
  `ShareUserStatistics`, cached 180 s. NOTE: the response **structs survive at
  the pin** (`modules/structs/nodeinfo.go:7-62` — only the handler and swagger
  were deleted), so the document shape is still pin-authoritative.

---

## 3. Workers-platform adjudication

Per-arm, with the platform facts and the landed house precedents:

### 3.1 Inbound requests + HTTP-signature verification — native Worker territory

- An inbox/actor endpoint is an ordinary fetch handler. No sockets, no
  daemons, no filesystem state — the entire draft-cavage machinery is
  header/bytes work.
- **RSA-SHA256 signature verification is WebCrypto-native**:
  `crypto.subtle.verify("RSASSA-PKCS1-v1_5", ...)` over the canonical signing
  string reconstructed from the `Signature` header parameters
  (`keyId`, `algorithm`, `headers`, `signature`, `expires`). Ed25519 verify is
  likewise `crypto.subtle.verify("Ed25519", ...)` in workerd. The
  `Digest` header is `crypto.subtle.digest("SHA-256", body)` — the digest check
  doubles as the body-size gate (stream-read capped at
  `FEDERATION_MAX_SIZE`, default 4 MiB — the landed bounded-spool posture,
  SPEC-0016 §parity-review D-2).
- **Hand-rolled, no dependency.** `42wim/httpsig` is Go. The draft
  (draft-cavage-http-signatures-10) is small and fixture-testable; the
  distro-common precedent (SPEC-0016 M7) already hand-built OpenPGP v4 signing
  + PEM armor + DER handling over WebCrypto with zero dependencies — an HTTP
  signature codec is strictly smaller than that work.
- **Key material from remote actors**: the pre-stub middleware fetched the
  actor doc per request. `fetch()` to arbitrary public HTTPS hosts is native
  and unflagged; each response is small JSON. The recorded divergence (§4.5)
  adds a TTL cache so verification costs zero remote fetches on the warm path.

### 3.2 Outbound delivery fan-out — Queues, the house pattern

- Upstream's deleted client delivered synchronously inside the triggering
  request (`client.go` `Post`). On Workers that shape is wrong twice: request
  CPU budget, and one dead remote inbox stalls the triggering action. The house
  pattern is producer→Queue→consumer (SPEC-0005's webhook-delivery consumer +
  DLQ; SPEC-0009's push-mirror lane; SPEC-0014's producer idiom). One delivery
  message per target inbox; the consumer signs (§3.3) and POSTs with Queues'
  redelivery as the retry envelope, dead-lettering after the configured
  retries — the webhook-delivery-dlq posture verbatim.
- Fan-out breadth is irrelevant at v1 scale: the only outbound activities
  upstream's deleted code could produce were profile-related, and Tier B's
  inbox is receive-only. Queues also decouples keypair reads from the request.

### 3.3 Signing — the keypair posture

- **Per-user RSA keypairs in `user_settings_kv`** — the landed precedent is
  exactly this problem: SPEC-0016 M7's debian/alpine signing keys
  (`services/packages/debian.ts:40` — "Per-owner RSA keypair in
  user_settings_kv (upstream's `user_setting` home…)"), lazy-generated,
  upstream-shaped setting keys. ActivityPub keypairs land in the same store
  under `activitypub.priv_pem` / `activitypub.pub_pem` (§4.2), generated via
  `crypto.subtle.generateKey("RSASSA-PKCS1-v1_5", …, 3072)` + SPKI/PKCS#1 PEM
  export — the distro-common PEM/DER substrate again.
- Signing in the consumer: load the PEM, import, build the canonical string
  over `(request-target)`, `Date`, `Digest`, sign, emit the `Signature`
  header — byte-compatible with the deleted client's output (§2.5), so
  Mastodon-style verifiers accept our deliveries.

### 3.4 Platform limits — none binding

- **CPU vs wall**: verification is one import + one digest + one verify
  (sub-millisecond CPU); remote fetches and delivery POSTs are I/O wait (free,
  AGENTS.md Workers rules). Queue consumers get 15 min wall per invocation —
  irrelevant at this scale but not a hazard.
- **Body size**: `MaxSize` (4 MiB default) enforced on the streamed read
  (§3.1) — the FixedLengthStream/bounded-spool discipline, never
  `await request.text()` on unbounded input.
- **Subrequests**: the only per-request fan-out is warm-cache misses (one
  fetch per unknown keyId) and outbound deliveries (zero per request — they
  ride the queue). No limit pressure.
- **No module-level mutable request state**; key material passes explicitly
  from the store to the signer. No `nodejs_compat` requirement — everything
  above is Web-standard.

---

## 4. Divergence decisions (each grounded; Tier B arms marked)

1. **User-actor mapping — upstream's shape, verbatim** (Tier B). Actor IRI =
   `{AppURL}/api/v1/activitypub/user-id/{id}` — numeric-ID IRIs, username not
   in the path (`person.go` at `1592576fa5^`); webfinger's `self` link already
   carries this exact shape at the pin (`webfinger.go:89, 108`). No
   Mastodon-style `@user@instance` path mapping is invented. Our `users` table
   needs zero changes — the actor document is a projection of existing columns
   (name/full_name/avatar_url/html_url).

2. **Keypair home — `user_settings_kv`, not upstream's deleted setting keys**
   (Tier B). Upstream's `UserActivityPubPrivPem`/`PubPem` constants were
   deleted by #36789; our store home for per-owner keypairs already exists and
   already serves this exact purpose (debian.ts precedent, §3.3). Semantics
   identical (lazy-generate PEM pair per user); the setting-key names are ours
   (`activitypub.priv_pem` / `activitypub.pub_pem`), following the debian
   keys' naming pattern. Recorded as a storage-home divergence, not a semantic
   one.

3. **Instance actor — pin-silent, NOT invented.** No commit in the pin's
   history ever carried an instance-actor concept (checked:
   `git log --all -S "instance actor"` — empty). Mastodon's shared instance
   actor is the fediverse operational norm, but adopting it would be building
   beyond upstream with no upstream answer to anchor — that is OQ-3, not a
   decision made in this SPEC.

4. **Moderation posture — none, faithfully.** The pin carries no federation
   moderation surface (§1, §2.4). Our v1 posture is therefore "the gate is the
   moderation" (disable = 404/absent). Any block-list design would be
   Forgejo-derived, i.e. invented here — parked with OQ-1's Tier B question,
   explicitly not designed in this SPEC.

5. **Remote-key cache — added** (Tier B, recorded divergence). Upstream
   fetched the signer's actor document on every signed request
   (`reqsignature.go` `fetch()`). We cache the fetched public key with a TTL
   (refresh on miss/expiry; hard-fail closed on fetch error). Rationale:
   Workers subrequest economics make fetch-per-verification needlessly hot,
   and the semantics are identical (same trust root — the fetched document).
   Home: a small D1 table (`remote_actor_keys`: iri PK, public_key_pem,
   fetched_at) OR KV-with-TTL — OQ-4, since upstream is silent and both are
   one-file changes.

6. **Delivery retry semantics — Queues/DLQ, not synchronous** (Tier B).
   Upstream fired in-request with no retry; §3.2. Recorded; behavior
   divergence (delivery becomes at-least-once with backoff) is strictly
   stronger than upstream's fire-once.

7. **The scope gate row closes** (Tier B mechanical note). Upstream wires
   `tokenRequiresScopes(ActivityPub)` to the `/activitypub/*` group
   (`api.go:1009`); when the family mounts on our side, the landed tree-wide
   `apiScopeGate` (`apps/worker/src/api/scope-gate.ts:191`, mounted
   `api/router.ts:118`) gains the activitypub category row, closing SPEC-0002
   §2.4's recorded "parsed but never granted by a route" gap. No change to the
   scope grammar (SPEC-0002 ported it verbatim, scopes included).

8. **`ShareUserStatistics` semantics — adopted-if-built, humans-counted**
   (Tier B). The setting is dead at the pin (§2.1) but its pre-stub consumer
   defines the semantics (usage counts in nodeinfo, 180 s cache). If the
   nodeinfo-data arm builds, we port those semantics with one refinement: the
   total-users count follows the SPEC-0010 bootstrap precedent of counting
   HUMANS, not rows (the seeded SYSTEM service principals exclusion,
   `16a63b6`), since nodeinfo usage is a public surface.

---

## 5. Data model

### Tier A (parity-committed): **zero schema**

Nothing is stored. Webfinger and nodeinfo-links are projections of existing
`users` rows; the stubs store nothing. The only config addition is the
`FEDERATION_ENABLED` var (default `"false"`, fail-closed — same class as
`ALLOW_SIGNUP`/`PACKAGES_ENABLED` in `wrangler.jsonc.example`, which is the
orchestrator's file; this SPEC only specifies the var).

### Tier B (gated on OQ-1): no new relational tables for the core surface

- Keypairs: `user_settings_kv` rows (§4.2) — existing store.
- Remote-actor keys: `remote_actor_keys` D1 table (iri TEXT PK,
  public_key_pem TEXT, fetched_at INTEGER) **or** KV-with-TTL — OQ-4 decides;
  upstream is silent, both are cheap.
- Queues: one `federation-delivery` lane (producer bindings + consumer arm in
  `apps/worker/src/index.ts`'s `queue()` dispatcher beside the
  webhook-delivery lanes) + its DLQ arm.
- No R2, no Durable Objects — the surface has no blob payload and no
  write-serialization requirement at this scope (the keypair lazy-generate
  race is handled the debian.ts way; if that way is a CAS, it ports as-is).

---

## 6. Wave decomposition

### 6.1 Tier A — parity (dispatches on ratification of OQ-2's default-off gate)

**W-A1 (size S, one wave): the discovery tier + the stubs, gated.**

- `apps/worker/src/api/routes/federation.ts` (new): the gated family —
  `GET /.well-known/nodeinfo` (NodeInfoLinks shape), `GET /.well-known/webfinger`
  (acct same-host + mailto + visibility + JRD with CORS `*`), and — when
  `FEDERATION_ENABLED` — the registered-but-501 `GET /api/v1/nodeinfo` +
  `ANY /api/v1/activitypub/*` arms answering upstream's exact
  `"Not implemented"` text/status. Gate: absent/`"false"` var ⇒ the web pair
  404s (upstream's `federationEnabled` arm, `web.go:410-412`) and the API
  arms stay unmounted (upstream's registration arm, `api.go:1007`).
- `apps/worker/src/services/federation/webfinger.ts` (new): the resolution
  logic (thin-routes rule) over the existing users store; visibility via the
  landed viewer predicates.
- Mounts: the web pair rides the landed web router family registration
  (`ui/index.ts` prologue family, the SPEC-0008/wiki.mount pattern); the API
  arms ride `api/router.ts` behind the same var. Config var
  `FEDERATION_ENABLED` documented in `wrangler.jsonc.example` by the
  orchestrator's registration window (this SPEC owns the spec text, not the
  config file).
- Ownership sketch: one agent — `api/routes/federation.ts`,
  `services/federation/webfinger.ts`, the two mount edits, the test file.
  No schema, no contract change, no engine touch.
- Test battery: §7 Tier A (vitest, workerd bindings).

#### 6.1.1 As-built (W-A1, landed 2026-10-31)

What landed (all gates green: suite 24/24, neighbors 64/64, `pnpm check:api`
PASS, `tsc --noEmit` zero in the new files, scoped eslint clean):

- `apps/worker/src/api/routes/federation.ts` — the whole gated family:
  `wellKnownRouter` (the `/.well-known` pair, a plain-Hono web sub-app, the
  avatar-serving seam shape) + `registerFederationApiRoutes` (the two API
  stub arms, plain registrations OUTSIDE the generated OpenAPI document —
  the imports.ts carve; the pin's swagger has no such paths, §6.3 holds).
- `apps/worker/src/services/federation/webfinger.ts` — the resolution
  ladder: the Go `url.Parse` scheme/opaque mimic (`parseResource`), the
  `GetUserByName`/`GetUserByEmail` ports (user.go:1120-1135 /
  1372-1402 — including the noreply sub-arm), the mailto private-email
  suppression, the visibility gate over the landed
  `isUserVisibleToViewer` (api/services/user.ts), and the JRD projection
  in Go struct order (webfinger.go:87-121).
- `apps/worker/wrangler.jsonc.example` + `.dev.vars.example` — the
  `FEDERATION_ENABLED` var, default `"false"`, strict-polarity documented
  (the DEMO_MODE/MAIL class: ONLY the exact string `"true"` arms).
- `apps/worker/src/api/routes/federation.test.ts` — the §7 Tier A battery
  on real D1, both routers driven standalone (24 tests).

The gate wiring: `federationEnabled(env)` reads `env.FEDERATION_ENABLED ===
"true"` per request (Workers vars are runtime env, not boot config — the
first-run ALLOW_SIGNUP adaptation). The web pair's handler gate answers
Go `ctx.HTTPError(404)`'s exact bytes (`Not Found\n`,
`text/plain; charset=utf-8`, nosniff — base.go:105-111 behind
web.go:409-414); the API arms' gate answers the router's native not-found
(`404 Not Found` — Hono's default handler bytes), the "unregistered at
api.go:1007" posture. The 501 stubs answer Go `http.Error`'s
`Not implemented\n` (person.go:12-14) on EVERY method/depth under the
wildcard, anonymous included (upstream's GetDoerTokenScope early return,
api.go:281-283).

Build-time decisions, each a recorded adaptation (none silent):

1. **The activitypub token-scope gate rides the ROUTE, not the central
   table** — `tokenRequiresScopes(ActivityPub)` is upstream's own INLINE
   placement (api.go:1009); our inline middleware mirrors the central
   gate's evaluation byte-for-byte (scope-gate.ts:191-221 shape, the
   routes/packages.ts `groupScopeGate` precedent), so the central table's
   recorded gap note (scope-gate.ts:50-51) stays true — the row is absent
   because the family gates itself; mounting a second copy would
   double-evaluate. A `read:activitypub`/`write:activitypub` token passes
   at its level; any other token 403s with api.go:300's exact body.
2. **AppURL = the appOrigin chain** — the optional `APP_URL` var, else the
   request origin, normalized to upstream's guaranteed trailing slash
   (server.go:50-51); the webhooks-push.ts `appOrigin` posture (upstream
   reads `setting.AppURL` config).
3. **Avatar link = the house canonical projection**
   `{appUrl}avatars/{usernameLower}` (api/services/repository.ts:495 — the
   URL every user serialization already carries, served by the
   avatar-serving seam). Upstream's `u.AvatarLink` is
   gravatar/federated-config dependent (models/user/avatar.go:83-86);
   cf-gitea has no gravatar config to port.
4. **Noreply domain = the request hostname** — upstream's
   `NO_REPLY_ADDRESS` defaults to `"noreply." + Service.Domain`
   (service.go:212); cf-gitea has no Service.Domain, but its OWN noreply
   emission convention is `<login>@noreply.<hostname>`
   (api/routes/contents.ts:260) — the lookup arm accepts exactly the
   addresses this instance emits. The name form resolves individual rows
   only (GetIndividualUserByName), the `<id>+<name>` form by id, ParseInt
   errors fall to the name arm (parseLocalPartToNameID).
5. **Orgs resolve in webfinger** — `GetUserByName` is type-blind at the
   pin (user.go:1120-1135), so `acct:{org}@host` resolves an org row and
   the JRD carries the degenerate `mailto:` alias (the unconditional
   append when `!KeepEmailPrivate`, webfinger.go:91-93, against an empty
   org email). Ported type-blind, byte-faithful.
6. **Webfinger carries the session-viewer arm** — `ctx.Doer` upstream is
   the web session; ours resolves `gitea_session` through `verifySession`
   with the attachments-serving seam's exact consumption (§2.4 background
   settle, the clear/rotation Set-Cookie directive on the response).
   Anonymous stays the default viewer (zero D1 reads without a cookie).
7. **OPTIONS on /.well-known/* falls to the router 404** — upstream's
   `optionsCorsHandler` is a no-op without `[cors]` config
   (web.go:542), which cf-gitea does not surface; identical observable.

**HANDOFF — the two mounts (orchestrator-owned files, unchanged by this
wave):**

`apps/worker/src/index.ts` (two one-line edits, the avatar-serving carve
pattern):

```ts
// 1. beside the isAvatarServing/isAttachmentServing consts in fetch():
const isWellKnown = segments[0] === ".well-known";
//    ...and add `&& !isWellKnown` to the isRepoScoped conjunction, so the
//    two-segment /.well-known/* paths stop falling to gitHttpGate's
//    headless-engine 404.
// 2. beside the attachmentsServingRouter mount (before firstRunRouter/uiRouter):
import { wellKnownRouter } from "./api/routes/federation";
app.route("/", wellKnownRouter);
```

`apps/worker/src/api/router.ts` (import + one registration call beside the
other families — placement free; the paths are family-specific and shadow
nothing):

```ts
import { registerFederationApiRoutes } from "./routes/federation";
registerFederationApiRoutes(app);
```

Until the mounts land, the family is inert in production (the dispatcher's
repo-scoped branch still claims /.well-known/* — today's headless-engine
404 is the same fail-closed shape the gate would answer, modulo bytes);
the suite drives both routers standalone and stays green either way.

### 6.2 Tier B — beyond parity (ONLY if OQ-1 ratifies; five waves, size L)

- **W-B1: nodeinfo-data arm** (S): the NodeInfo 2.1 document over the
  pin-authoritative structs (`modules/structs/nodeinfo.go:7-62`), usage counts
  behind `FEDERATION_SHARE_USER_STATISTICS` with the 180 s cache and the
  humans-counted total (§4.8). Un-stubs `GET /api/v1/nodeinfo`.
- **W-B2: person actor + keypairs** (M): `GET
  /api/v1/activitypub/user-id/{id}` serving the Person document (§2.5 shape,
  `application/ld+json; profile=…activitystreams`), keypairs in
  `user_settings_kv` (WebCrypto RSA-3072, distro-common PEM), `{actorIRI}#main-key`.
  Un-stubs the GET arm under the actor prefix.
- **W-B3: signature verification + remote-key cache** (M): the draft-cavage
  verifier (hand-rolled, §3.1) as middleware on the POST arms; the
  remote-actor key store per OQ-4; 403 posture per upstream's middleware;
  `MaxSize` digest gate. Fixtures-first (§7).
- **W-B4: inbox receive — upstream-faithful black hole** (S): `POST …/inbox`
  verifies (W-B3), consumes the streamed body under the size cap, answers
  **204** — deliberately no processing, exactly upstream's `PersonInbox`.
  Everything past the black hole (Follow/accept, undo, delivery of local
  activities) is a FEDERATED FEATURES spec with no upstream anchor — out of
  this SPEC's scope (OQ-5).
- **W-B5: delivery producer/consumer + battery** (M): the
  `federation-delivery` Queue lane, the signing consumer (§3.3), DLQ arm,
  the e2e battery (§7 Tier B). NOTE: with W-B4 a black hole and no outbound
  activity producers ratified, W-B5's producer has nothing upstream-faithful
  to emit — its scope is the transport substrate only, and it should probably
  not dispatch until OQ-5 gives it cargo. Recorded honestly: **W-B5 is
  contingent on OQ-5**, not just OQ-1.

### 6.3 Contract / gates impact

- **Frozen contract: zero deltas in both tiers.** `/api/v1/nodeinfo` and
  `/api/v1/activitypub/*` are absent from the pin's swagger
  (`templates/swagger/v1-swagger.generated.json` — verified: no such paths;
  the only `activitypub` token is a scope example) — there is nothing to
  declare, `pnpm check:api` untouched. The `.well-known` pair are web-side
  non-contract surfaces.
- `tsc --noEmit`, eslint, and the full-suite composite gate run per the
  standing rules; Tier A adds one vitest file, Tier B one per wave.

---

## 7. Testing plan

### Tier A

- workerd vitest with real bindings (`@cloudflare/vitest-plugin` house setup):
  - webfinger goldens: `acct:user@host` same-host → JRD snapshot (subject
    urlencoded, the four links, aliases); foreign host → 400; unknown user →
    404; private-email mailto → suppressed alias; hidden user → 404;
    `Access-Control-Allow-Origin: *` present.
  - nodeinfo-links: the exact `{"links":[{href,rel}]}` shape (AppURL
    trailing-slash included).
  - Gate arms: var absent/false ⇒ web pair 404, API arms absent (404 from the
    router); var true ⇒ API arms answer 501 with upstream's exact body text
    `Not implemented` and the scope gate's activitypub row active (a
    `read:activitypub` token passes the gate row, a scopeless token 403s —
    matching `tokenRequiresScopes` semantics at `api.go:1009`).
- D1 fixtures: 3–4 users (public/private/hidden/email-private) — no new
  fixture machinery.

### Tier B (fixtures-first where crypto is involved)

- **Signature fixtures, generated in-suite**: WebCrypto-generate an RSA-3072
  test pair; helpers produce signed requests over the canonical string
  (`(request-target)`, `Date`, `Digest`) — vectors: good signature;
  tampered body (digest mismatch); stale `Date` (past the 60 s expiry the
  deleted client used); wrong key (keyId → a different actor's doc);
  unknown keyId (fetch-miss → fail-closed); unsupported algorithm → reject.
- **Fetch-stub remote actors**: the W-B3 verifier's remote fetch is stubbed at
  the env boundary (the SPEC-0009 pattern — outbound git-HTTP stubbed in the
  mirror tests) to serve fixture actor documents, including a hostile
  over-`MaxSize` body and a malformed-PEM document; the cache (OQ-4) asserts
  the second verify performs zero fetches.
- **Delivery battery** (W-B5): enqueue a delivery → consumer signs → a stubbed
  inbox asserts Content-Type, fresh Date, Digest = SHA-256 of the body, and
  the `Signature` header's parameter set (`keyId={actorIRI}#main-key`,
  headers covering `(request-target)/date/digest`); redelivery semantics by
  a first-attempt-fails stub; DLQ arm exercised once.
- **Actor document golden**: the W-B2 Person JSON snapshot against a fixture
  user (the #main-key PEM asserted structurally, not byte-pinned).

---

## 8. Open questions (for ratification)

1. **OQ-1 — Tier scope.** Parity-committed Tier A only, or open Tier B?
   Upstream retracted its own implementation (#36789: "wait until the whole
   design is stable and usable") — building beyond it has no parity anchor and
   needs a product owner for the fediverse semantics. **Recommendation: Tier A
   now; Tier B stays parked until an OQ-5 answer exists.**
2. **OQ-2 — the gate default in the shipped config.** Upstream defaults
   `Enabled=false`; the SPEC specifies `FEDERATION_ENABLED` fail-closed
   default `"false"` in `wrangler.jsonc.example` (the orchestrator's file).
   Ratify the var name + default.
3. **OQ-3 — instance actor.** Pin-silent everywhere (§4.3). If Tier B opens:
   per-user keys only (upstream-faithful) or a shared instance actor
   (fediverse-norm, Mastodon-derived)? Default if unanswered: per-user keys
   only.
4. **OQ-4 — remote-key cache home** (Tier B): D1 `remote_actor_keys` table or
   KV-with-TTL. Upstream-silent; both are single-file changes. Default if
   unanswered: KV-with-TTL (no migration).
5. **OQ-5 — inbox cargo.** Upstream's inbox was a 204 black hole; every
   Fediverse feature (follows, mention delivery, remote comments on issues…)
   has no upstream answer. If any such feature is wanted, it needs its own
   SPEC with an explicit feature list; until then W-B4 stays a faithful black
   hole and W-B5 does not dispatch (nothing upstream-faithful to deliver).
   This is the question that actually decides whether federation is worth
   building here.
6. **OQ-6 — webfinger scope parity footnote.** Upstream webfinger resolves
   `mailto:` against the users table (an instance-enumeration vector bounded
   only by the visibility gate). Port faithfully (Tier A) or drop the mailto
   arm (a divergence)? Default if unanswered: port faithfully.

---

## 9. Parity record (what this SPEC commits, if only Tier A ratifies)

- `GET /.well-known/nodeinfo`, `GET /.well-known/webfinger`,
  `GET /api/v1/nodeinfo` (501), `ANY /api/v1/activitypub/*` (501, activitypub
  token scope required), all behind a default-false
  `FEDERATION_ENABLED` gate with upstream's exact disabled arm (web 404, API
  unmounted). Byte-level: the JRD/link/501 shapes of §2.2/§2.3.
- Recorded, deliberately NOT built: actors, inbox, outbox, delivery,
  moderation, fediverse features — each with its §-cite above, so the
  non-build is a decision, not an omission.
