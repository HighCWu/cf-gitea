# SPEC-0010: UI web sessions (U4) — PAT login, `gitea_session` cookie, viewer extension

Status: **accepted — ratified 2026-10-25** (the §1.1 entry criteria are met:
the tier-2 UI page waves are in flight, which is exactly the private-browsing
demand trigger; migration 0013 is free — schema ownership released by the
issue-tables wave 4bb3c26). Ratified by the orchestrator for implementation
as one batch ·
Date: 2026-10-24 · Fills SPEC-0008 milestone **U4** (placeholder, its open question 4).

Inputs (cited throughout, not re-derived):

- SPEC-0008 §2.5 — the slice-1 auth decision: option (b) anonymous-only; option (a)
  (PAT-verified session cookie) deferred to this SPEC. The landed seam:
  `apps/worker/src/ui/viewer.ts` (`resolveViewer(): { kind: "anonymous" }`).
- SPEC-0002 §2.8 — web sessions are **documented-only** upstream surface at the pin:
  cookie `gitea_session` (`gitea/modules/setting/session.go:36,61`), remember-me tokens
  as `id:secret` pairs with sha256-at-rest and rotation
  (`gitea/services/auth/auth_token.go:33–121`); CSRF **dropped** upstream
  (`gitea/services/context/context.go:179–180`, only a FIXME remains).
- SPEC-0002 §2.4/§2.6/§2.7 — scope grammar, the 401/403/404 conventions, the per-IP
  failure limiter and the `last_used_at` throttle this SPEC reuses.
- SPEC-0003 §2.4 — the gate's ACL matrix; SPEC-0008 §2.1 — the GET-only page
  inventory; SPEC-0008 §5.2 — the golden-snapshot re-baselining process.

Upstream findings are against the vendored submodule (`gitea/`, read-only, pin
`v29.0.0-dev-208-gfc493688`). Landed-code findings are against
`apps/worker/src/**` as of 2026-10-24.

## 1. Problem and scope

SPEC-0008 slice 1 ships three repo pages for **public repos, anonymous, read-only**.
Everything else a signed-in Gitea web session enables — browsing private repos in the
browser, the navbar's signed-in chrome, and eventually any UI write action — is blocked
on one missing surface: a web session. SPEC-0008 §2.5 deliberately deferred it: "the
product contract is Tier 1: a headless Gitea" and private workflows are fully served by
PAT + git + `/api/v1`. This SPEC designs the deferred option (a) end-to-end so that the
moment its trigger fires, implementation is a review of an existing document, not a
fresh design debate. It contains **no implementation** and changes nothing until §1.1
says otherwise.

### 1.1 Entry-criteria decision (the gate on this SPEC)

**Decision: implement when private-repo browsing or the first UI write action is
requested; until then this SPEC stays `draft` and nothing in it is built.**

Concretely, exactly two events open the implementation window:

1. **Private-repo page browsing demand** — a concrete requirement (user ask, product
   decision) that repository pages must render for a signed-in viewer on repos the
   anonymous slice 404-shells (SPEC-0008 §2.5). The wedge stops being sufficient the
   first time someone needs to *look* at their private repo in a browser.
2. **The first UI write action is scheduled** — any slice that renders a
   state-changing control (star/watch, web editor, settings, admin panel) requires an
   authenticated principal on a POST route; there is no write without a session.

Rationale (recorded so the gate survives personnel changes): a session surface is a
real security commitment — cookie flags, TTL, rotation, logout, CSRF posture — that
buys nothing for read-only public pages (SPEC-0008 §2.5 justification 2). Both
triggers are demand-shaped, not schedule-shaped: neither arrives by writing code, so
the correct resting state of this SPEC is `draft`. When a trigger fires, this SPEC is
reviewed, ratified to `accepted`, and implemented as one batch. U4's milestone entry
and SPEC-0008 open question 4 are satisfied by this document.

### 1.2 In scope (when the gate opens)

1. `GET /login` + `POST /login` — PAT login minting a D1 session row, §2.2.
2. The `gitea_session` cookie surface — name, flags, value format, TTL, §2.3.
3. Session verification with upstream rotation + reuse-detection semantics, §2.4.
4. `POST /logout`, §2.7.
5. The `viewer.ts` extension (`{ kind: "user", id, … }`) and the widening of page repo
   resolution through the gate's **existing** authenticated paths, §2.5–2.6. Page
   components stay byte-identical; only the viewer seam, the navbar, and the
   resolution predicate change.
6. CSRF posture for the future UI write actions this session enables, §2.8.
7. D1 `sessions` table (sha256 secret at rest, rotation columns, throttled
   `last_seen_at`), §3.
8. Login rate limiting via the existing auth failure limiter, §2.2.
9. The `/api/v1` and git-HTTP boundary: sessions never authorize either, §2.9.

### 1.3 Out of scope

- **Password sign-in** — no credential store exists (SPEC-0002 open question). The
  login credential is a PAT. When passwords land, `POST /login` grows the
  username+password form upstream's `/user/login` has; the session mechanics below do
  not change.
- The write actions themselves, star/watch counters, settings/admin pages — each is
  its own SPEC; this one only defines the principal they will run as and the CSRF
  contract they must follow.
- OAuth2 provider, 2FA/WebAuthn, HTTP-signature — SPEC-0002 §2.8 territory.
- CSP (SPEC-0008 open question 6) — separate pass; §4.9 records the interplay.
- Session management UI (list/revoke devices, logout-everywhere) — open question 5.

## 2. Surface: routes, cookie, viewer, boundaries

### 2.1 Route inventory

| Route | Purpose | Auth contract |
|---|---|---|
| `GET /login` | Login form page (shell + form), anonymous chrome | Renders anonymous; a valid session redirects to `/` |
| `POST /login` | Verify PAT → mint session row → `Set-Cookie` | Rate-limited per IP (§2.2); never 401/403 JSON — form re-render |
| `POST /logout` | Delete session row, clear cookie | Idempotent; §2.7 |

Both routes are **top-level**, so the dispatcher (`apps/worker/src/index.ts`) needs **no
change**: `/login` and `/logout` are not repo-scoped (`segments.length >= 2` is false),
they fall through to `app.fetch`, and the mounted `uiRouter` claims them with plain
`uiRouter.get/post` registrations (`apps/worker/src/ui/index.ts`). `handlesUiRoute`
stays repo-scoped-only; the engine, the gate, and `/api/v1` never see these paths.
Upstream divergence: upstream's web login is `/user/login` (and `/user/logout`) —
cf-gitea claims the shorter `/login`/`/logout`; the upstream-shaped aliases are an
open question for the day the upstream-shape form matters (open question 4).

### 2.2 Login flow (`POST /login`)

Request: `application/x-www-form-urlencoded`, fields:

- `password` — **the PAT**. Token-as-password mirrors the Basic convention SPEC-0002
  §2.2 already accepts (`Basic user:<token>`), so one mental model covers both
  surfaces; `token` is accepted as a field alias.
- `user_name` — optional. When present it must match the token owner
  case-insensitively; a mismatch is a login failure (defensive; upstream's form posts
  both fields).
- `remember` — checkbox; toggles cookie persistence (§2.3).

Flow, in order (each step cites its landed counterpart):

1. **Rate limit first.** `D1FailureLimiter.check(ip, now)` — the same `auth_failures`
   window the gate and `/api/v1` share (deliberate: one per-IP budget across every
   auth surface, SPEC-0002 §2.7). Blocked → `429` + `Retry-After` + the gate's plain
   -text shape (`src/git-http/respond.ts` `rateLimited`), not a form re-render: an
   active block makes the form pointless, and a machine-readable status beats a 200
   page. IP extraction follows the gate's convention (`cf-connecting-ip`, else first
   `x-forwarded-for` hop, else `unknown` — `src/git-http/acl.ts:155-158`).
2. **Verify the PAT** — `TokenService.verify(password)` unchanged (prefix lookup +
   sha256 + timing-safe compare + expiry, `src/auth/token-service.ts:165-188`).
   Unknown/malformed/expired → `limiter.recordFailure` and re-render the form with an
   inline error, status **200** (upstream web logins re-render with a flash message
   rather than an HTTP error status; the failure is still counted against the limiter,
   which is where its real consequence lives).
3. **Capability gate on the minting PAT.** A session carries the *user's* web
   identity (upstream web sessions are scope-less; the scope machinery belongs to the
   API's token auth, SPEC-0002 §2.4). Because our credential is a scoped token, minting
   requires that the PAT would itself pass the gate's authenticated read path:
   `ScopeSet.has("read:repository")` **and** not `publicOnly`. Without this, a
   `no-token-scope` or public-only PAT would mint a session that reads *more* than its
   token could (the gate masks limited-owner repos from public-only tokens,
   `src/git-http/acl.ts:247-249`; SPEC-0002 §4.1). Failure → form re-render with an
   error. (Open question 1 covers scope-carrying sessions for future writes.)
4. **Prohibited account → no session.** A `status === "prohibited"` user gets the
   form re-render, no row, no cookie — mirroring upstream refusing login for
   prohibit-login users (`gitea/routers/web/repo/githttp.go:194-197` semantics;
   SPEC-0002 row 11). An already-live session for a user later prohibited
   de-escalates anonymously at verification time (§2.4 step 4).
5. **Mint.** Insert the `sessions` row (§3) and `Set-Cookie` (§2.3) in one response,
   then `limiter.reset(ip)` and the expiried-row GC sweep in `ctx.waitUntil`
   (upstream deletes expired auth tokens on the sign-in paths,
   `gitea/routers/web/auth/auth.go:86,382`).
6. **Redirect.** `?redirect_to=` is honored **only** when it is path-absolute and
   same-origin (`/^\/[^/]/`, no `//`, no scheme) — anything else redirects to `/`.
   Upstream carries the same value in a `redirect_to` cookie
   (`modules/web/middleware/cookie.go:24-35`); we take it from the form/query and
   validate instead of trusting it (open-redirect edge, §4.6).

`GET /login` renders the form in the anonymous shell. The form posts `password` +
`remember` + optional `user_name`; no other client script is required (the page must
work with JS disabled — it is plain HTML).

### 2.3 The `gitea_session` cookie

| Property | Value | Upstream cite |
|---|---|---|
| Name | `gitea_session` | `modules/setting/session.go:36,61` (default `COOKIE_NAME`) |
| Value | `<id>:<secret>` — 10-char random id, 64-hex secret (§3) | `routers/web/auth/auth.go:127` (`nt.ID+":"+token`), `services/auth/auth_token.go:100,113-121` |
| `HttpOnly` | always | `modules/web/middleware/cookie.go:57-78` (`SetSiteCookie` hardcodes it) |
| `Secure` | always (our origins are https; upstream derives `COOKIE_SECURE` from an https `AppURL`) | `setting/session.go` (`COOKIE_SECURE`) |
| `SameSite` | `Lax` | `setting/session.go:39` default |
| `Path` | `/` | `setting/session.go` (`CookiePath` default) |
| `Max-Age` | `remember` → 31 days (`LOGIN_REMEMBER_DAYS` default 31, `setting/security.go:146`); no `remember` → **session cookie** (no `Max-Age`; dies with the browser). The login's decision is **persisted on the row** (`sessions.remember`, migration 0035) and **every rotation re-sets the cookie with it** (§2.4 step 5) — a remembered login keeps `Max-Age=2678400` across rotations, an unremembered one's rotated cookie stays session-scope | `auth.go:127` (`SetSiteCookie(…, LogInRememberDays*Day)` inside `autoSignIn` — upstream re-issues the remember cookie with the remember TTL after every token regeneration) |
| Row TTL | **idle TTL, re-armed by every authenticated request** (the 2026-10-30 amendment below): non-remember → 24 h idle (`setting/session.go` store `Maxlifetime` default 86400), remember → 31 days idle (`LOGIN_REMEMBER_DAYS`; upstream arms `auth_token.go:97` at mint, re-arms `auth_token.go:80` per use) — an actively used session keeps living, an idle one dies after its idle TTL regardless of the cookie's persistence; **no absolute cap** (upstream's auth-token expiry merely slides, `auth_token.go:47-92` — none exists to mirror) | `setting/session.go` store `Maxlifetime` 86400; `services/auth/auth_token.go:80,97` |

The `remember` distinction is exactly upstream's: *cookie* persistence. Upstream splits
the roles across two cookies (`gitea_session` names a server-side store entry,
`gitea_remember` carries the `id:secret` auth token). cf-gitea **collapses both into
one `gitea_session` cookie carrying the `id:secret` pair**: Workers isolates have no
server-side memory, D1 is the session store (playing upstream's `auth_token` table
role verbatim — sha256 at rest, `previous_token_hash` + `rotated_unix` rotation
columns, expiry), and a second cookie would buy nothing. This is a documented
divergence from upstream's cookie *layout* with byte-compatible *name*; the
`gitea_remember` name is never emitted.

**Amendment (2026-10-28, the wave-130 parity review's fix — `28df818` + migration 0035
`spooky_galactus`, additive).** Earlier text implied rotation always re-sets a
session-scope cookie; that implication is gone from code and from this SPEC. The landed
posture is upstream's own at `auth.go:127`: the login's `remember` decision persists on
the row (`sessions.remember`, integer default false NOT NULL — mint threads the form
checkbox into it via `createSession`, and the rotation CAS below never touches the
column, so the decision survives rotations for the row's life), and every rotation
`Set-Cookie` is wrapped through `sessionSetCookie(value, row.remember)`. A remembered
user's rotated cookie keeps `Max-Age=2678400`; an unremembered user's rotated cookie
stays session-scope. The wrap runs at all three rotation sites (`src/ui/viewer.ts` page
context, the `/login` GET arm in `src/ui/session.ts`, `src/web/attachments-serving.ts`)
— a bare `id:secret` Set-Cookie (no name/attrs) is silently ignored by the browser and,
past the 60 s grace, turns the next request into a step-3 mismatch that deletes the
row: merely visiting `/login` signed-in after 24 h logged the user out (the review's
HIGH finding, fixed `28df818`; route-level round-trips pin that the *adopted* cookie
authenticates the next request).

**Amendment (2026-10-30, the wave parity review's HIGH #2 fix — sliding validity +
decoupled clocks).** The parity review (`docs/usability/parity-review-auth.md` §1)
found the remember/rotation arithmetic unreachable: `SESSION_TTL_MS` and
`ROTATION_INTERVAL_MS` were both exactly 24 h and both anchored at the same mint
instant, so the expiry check (`expires_at <= now`, §2.4 step 2) consumed the only
instant the rotation trigger (`now − rotated_at ≥ 24 h`, §2.4 step 5) could fire —
rotation never ran in natural operation, reuse detection was consequently dead code,
and every web login hard-died 24 h after mint, `remember` notwithstanding, while the
browser held a 31-day cookie. As built:

- **Validity is idle-based sliding; there is no absolute cap.** Every authenticated
  request re-arms `expires_at = now + idleTtl(remember)`: **24 h idle** for a
  non-remembered session (upstream server-store `Maxlifetime` default 86400,
  `setting/session.go:38`) and **31 days idle** for a remembered one (upstream arms
  the remember token's `ExpiresUnix` to `now + LOGIN_REMEMBER_DAYS` at mint,
  `auth_token.go:97`, and re-arms it on every regeneration, `auth_token.go:80` —
  and its `autoSignIn` checks + regenerates on EVERY cookie-authenticated request,
  `routers/web/auth/auth.go:97,119-127`, so a remembered upstream user stays signed
  in through 31 idle days). Mint arms by the same rule (`mintSession`).
  **No absolute cap**: upstream's auth-token expiry merely slides
  (`auth_token.go:47-92` — the only check is `ExpiresUnix < now`; no max-lifetime
  column exists), so none is imposed here.
- **The re-arm is synchronous** and shares one UPDATE with the throttled
  `last_seen_at` touch when both are due (§3's 1 h throttle unchanged — only the
  transport moved): a lost background re-arm would silently shorten the session's
  life and resurface as a mystery logout days later. After a rotation (which
  re-armed already) the touch goes alone in the background as before. Anonymous
  outcomes (including the stale in-grace branch) never re-arm.
- **Rotation keeps its own 24 h-from-`rotated_at` clock, decoupled from validity**
  (§2.4 step 5 unchanged as a trigger): the cookie refreshes at most daily while the
  session lives — a deliberate adaptation, since upstream's per-use regeneration
  would put a Set-Cookie + row write on every request, which buys nothing over the
  daily cadence this SPEC already ratified. Rotation now re-arms by the row's idle
  TTL (`remember` → 31 d, upstream `auth_token.go:80` parity), fixing the review's
  second-order drift (the old +24 h re-arm logged out a user active every 36 h).
- **Reuse detection is reachable again** (rotation actually fires) — semantics
  unchanged: the 60 s stale-grace non-authenticating branch and the beyond-grace
  compromise delete (§2.4 step 3). Pins: an actively-used non-remember session at
  t+23 h stays valid AND rotates past t+24 h; a remembered session survives 30 days
  of daily use and dies after 31 idle days; an idle 25 h non-remember session is
  dead; a remembered session idle past 24 h is alive (`session.test.ts`, the §2.3
  sliding-validity describe).

Read §2.4's step-5 "`expires_at` = now + 24 h" as now + `idleTtl(remember)` per this
amendment; §2.3's table row above is the authoritative statement.

### 2.4 Verification, rotation, reuse detection (the upstream auth-token mechanics, ported)

Every page request with a `gitea_session` cookie runs the port of upstream
`CheckAuthToken` (`services/auth/auth_token.go:33-69`), one D1 read (`sessions ⋈ users`
on `id`):

1. **Format + lookup.** Split on `:` into `id`/`secret`; lookup by `id` (primary key —
   one row read). Malformed value or missing row → anonymous (cookie cleared in the
   response), zero further work.
2. **Expiry.** `expires_at < now` → anonymous; row deleted and cookie cleared in
   `waitUntil` (lazy GC, §3).
3. **Digest compare.** `sha256Hex(secret)` vs `sha256Digest` via
   `timingSafeDigestEqual` (`src/auth/digest.ts` — 32-byte raw digest compare).
   **Mismatch is the reuse-detection branch**, upstream-verbatim:
   - The presented digest equals `previous_sha256_digest` **and** `rotated_at` is less
     than 60 s old → recently rotated, cookie in flight — it **must not authenticate**
     (upstream's own comment) but the row survives: anonymous for this request, row
     kept, no `Set-Cookie`.
   - Any other mismatch → the cookie was stolen-and-rotated or forged: **delete the
     row** (locking out the attacker's rotated copy and the victim alike — upstream's
     compromise response, `auth_token.go:59-65`), clear the cookie, anonymous.
4. **Doer status.** The joined user must be `status === "active"` and `type === "user"`;
   otherwise the session does not authenticate (anonymous, cookie cleared) — upstream's
   `Session.Verify` rejects non-individual doers (`services/auth/session.go:53-57`) and
   prohibited accounts never hold authority (§2.2 step 4).
5. **Rotation.** On a valid presentation, when `rotated_at` is ≥ 24 h old: mint a fresh
   secret, then **conditionally update**
   `UPDATE sessions SET sha256_digest = <new>, previous_sha256_digest = <old>,
   rotated_at = now, expires_at = now + 24 h WHERE id = ? AND sha256_digest = <old>` —
   upstream's `UpdateAuthTokenByID(…, oldHash)` guard (`models/auth/auth_token.go`,
   `services/auth/auth_token.go:71-92`). `changes == 0` (a concurrent request rotated
   first) → skip, send nothing; the old cookie stays valid for that response and the
   60 s grace covers any true in-flight window. On success the response carries
   `Set-Cookie` with the new `id:secret`, wrapped in the full `gitea_session` directive
   (§2.3) **with the row's persisted `remember` decision** — a remembered login keeps
   `Max-Age=2678400` across rotations, an unremembered one stays session-scope
   (migration 0035; upstream's posture at `auth.go:127`, §2.3 amendment). Rotation runs
   in `waitUntil` where the
   handler's response is already committed to rendering as authenticated; the one
   user-visible cost (a concurrent request inside the grace window renders anonymous
   once) is accepted upstream-verbatim — open question 3.

Success yields the viewer (§2.5) and a throttled `last_seen_at` touch in `waitUntil`
(§3). A request without the cookie is anonymous with **zero** D1 session reads —
today's slice-1 cost profile is unchanged for the anonymous wedge.

### 2.5 The `viewer.ts` extension

```ts
export type Viewer =
  | { readonly kind: "anonymous" }
  | { readonly kind: "user"; readonly id: number; readonly username: string;
      readonly isAdmin: boolean };
```

`resolveViewer()` becomes `resolveViewer(env: Env, req: Request): Promise<Viewer>` —
reads the cookie, runs §2.4, returns the viewer. This is exactly the extension the
landed seam's doc comment pre-declared (`apps/worker/src/ui/viewer.ts`: pages branch
on `kind`, the navbar renders user chrome, nothing else changes). `uiPage` awaits it
inside its existing context assembly (`src/ui/index.ts:308-333`); `UiContext.viewer`
gains no other consumers.

Navbar (the only component change): anonymous viewers gain the **Sign in** link
(`/login`) — today it is deliberately absent (SPEC-0008 §2.5); user viewers gain the
upstream signed-in chrome **reduced to username + a sign-out POST button**
(`templates/base/head_navbar.tmpl` at the pin, minus everything that needs services we
have not built: no `+` create menu, no notification bell, no avatar image — the
avatar pipeline does not exist). Golden DOM snapshots re-baseline per SPEC-0008 §5.2;
the a11y smoke's navbar assertions (discernible link text) apply to the new items.

### 2.6 Repo resolution widens through the gate's existing authenticated paths

`resolvePublicRepository` (`src/ui/repo-view.ts`) becomes
`resolveRepositoryForViewer(env, viewer, owner, repo)`. The pages' data flow, the 404
-shell convention, and every component stay untouched — only the visibility predicate
changes, and it changes **onto paths the gate already implements** in its matrix
`decide()` (`src/git-http/acl.ts:196-261`):

| Viewer | Predicate (all reads; pages are GET-only, SPEC-0008 §2.1) | Gate rows exercised |
|---|---|---|
| anonymous | today's row-1 collapse verbatim: repo `public` × owner active × owner `visibility === "public"`; else `null` → 404 shell | row 1 (plus rows 4/5 remain git-HTTP-only — no page equivalent) |
| `{kind:"user"}` | `publiclyVisible \|\| isOwner \|\| isSiteAdmin \|\| (repoPublic && ownerActive && ownerVisibility === "limited")`; else `null` → 404 shell | rows 2, 7, 8, 9 (minus the row-7 *scope* half — sessions carry no scope bitmap; §2.2 step 3 moved that check to mint time), row 11 via §2.4 step 4 |

Notes:

- **Existence stays hidden**: an authenticated viewer without a grant gets the same
  404 shell as anonymous — never a 401/403 for pages (SPEC-0003 §2.4 conventions,
  SPEC-0008 §2.5.3).
- `isOwner`/`isSiteAdmin`/`limited` are the gate's own grant lines
  (`acl.ts:239-246`), so page visibility and git-HTTP visibility cannot drift. The
  predicate is extracted into a shared helper in that refactor so there is exactly one
  copy (the M1 grant model {owner, site admin} note in `acl.ts` applies unchanged;
  collaborators extend both surfaces together).
- Public-only masking is a *token* property (SPEC-0002 §4.1) and cannot arise: such
  tokens never mint sessions (§2.2 step 3).

### 2.7 Logout (`POST /logout`)

POST-only — a GET logout is a link-preview/pre-fetch footgun and we do not offer one
(no `?redir`-style escape hatch either). Flow: run §2.4 verification; on a **valid**
session delete the row (by `id` **and** matching digest — an id-only delete would let
anyone who learns a victim's `id` force logouts), on anything else leave rows alone
(reuse detection, §2.4 step 3, owns mismatch deletion). Either way the response clears
the cookie (`Max-Age=0`, same flags) and redirects to `/` — idempotent: logging out
without a session is a clean redirect, not an error.

### 2.8 CSRF posture for the API-less UI writes

Upstream at this pin has **dropped the CSRF token** — only a FIXME remains
(`services/context/context.go:179-180`; SPEC-0002 §2.8 records it). We inherit no
mechanism, so our stance is ours to define, and it is: **SameSite=Lax + server-side
Origin check on every non-GET UI route, plus a custom-header requirement for
fetch-based writes.** Three layers, cheapest first:

1. **`SameSite=Lax`** (§2.3) — modern browsers do not attach the cookie to cross-site
   POST navigations, which neutralizes the classic forged-form attack the way
   upstream's implicit post-drop posture does.
2. **Origin check (the documented tightening).** Every non-GET route the UI ever adds
   must verify the `Origin` header (falling back to `Referer`) against the request
   origin and reject mismatches with `403` plain text. We can impose this uniformly
   because our write surface is API-less and hand-written — unlike upstream, whose
   bundle posts forms we did not author, every future UI write route here is a route
   whose form we also render, so the check ships with the route, not as a retrofit.
3. **Custom header for fetch writes** (e.g. `X-Csrf-Token: 1`, any non-simple header):
   cross-site form posts and navigations cannot set custom headers, so fetch-based
   writes get a second, framework-free tripwire.

Blast-radius argument: because sessions do **not** authorize `/api/v1` or git HTTP
(§2.9), a forged cross-site request can only ever reach UI routes that already carry
layer 2. There is no path where a CSRF'd browser exercises token-scope authority.

### 2.9 The `/api/v1` and git-HTTP boundary: sessions never authorize either

Upstream pins this in two places: the **API auth group has no session method** —
`buildAuthGroup` is OAuth2 → HTTPSign → Basic (`routers/api/v1/api.go:849-857`) while
`Session{}` is added only to the **web** group (`routers/web/web.go:152`) — and the web
router itself marks git-HTTP-style traffic *sessionless* (`web.go:140-151`). SPEC-0002
§2.8 records the same finding. cf-gitea mirrors it exactly:

- `resolveAuth` (`src/auth/middleware.ts`) and the git gate
  (`src/git-http/acl.ts`) read **only** `Authorization` headers. They never consult
  cookies; both stay byte-identical.
- A request to `/api/v1` carrying only `gitea_session` is **anonymous** → the SPEC-0002
  §2.6 matrix answers (`401 {"message":"token is required", …}` on token-required
  routes). A git-HTTP request with only the cookie → the `401` Basic challenge
  (row 2). The official UI does not call the API (ADR-0001 finding, SPEC-0002 §2.8), so
  no legitimate client sends both.

Consequences worth stating: SPEC-0004's tier-1 contract is untouched; PAT scope
enforcement exists only on token surfaces; and the CSRF blast radius is confined to
§2.8's routes.

## 3. Data model

One D1 table (Drizzle, `src/db/schema.ts`; migration via `pnpm db:generate`). Column
conventions per SPEC-0002 §3 (unix-second timestamps, booleans as integer-mode). The
row shape mirrors upstream's `auth_token` table (`models/auth/auth_token.go`: `ID`
string pk, `TokenHash`, `UserID`, `ExpiresUnix`, `PreviousTokenHash`, `RotatedUnix`)
plus our throttled `last_seen_at`.

```ts
export const sessions = sqliteTable('sessions', {
  /** Public row id: 10 chars of crypto-random (upstream
   *  util.CryptoRandomString(10), services/auth/auth_token.go:100).
   *  Not secret; the secret half of the cookie is. */
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** hex(sha256(secret)); the 256-bit secret itself is never stored. */
  sha256Digest: text('sha256_digest', { length: 64 }).notNull(),
  /** Previous secret's digest — identifies in-flight stale cookies without
   *  authenticating them (upstream PreviousTokenHash). */
  previousSha256Digest: text('previous_sha256_digest', { length: 64 }),
  /** Bounds the 60 s stale-cookie grace window; rotation trigger. */
  rotatedAt: integer('rotated_at', { mode: 'timestamp' }).notNull(),
  /** Hard expiry; extended on rotation (§2.3). */
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  /** Throttled write: at most once per hour per session (§ below). */
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }).notNull(),
  /** The login form's remember decision (§2.3's amendment — migration 0035);
   *  rotation re-sets the cookie with Max-Age=2678400 iff true. */
  remember: integer('remember', { mode: 'boolean' }).notNull().default(false),
}, (t) => [
  index('sessions_user_idx').on(t.userId),
  index('sessions_expires_idx').on(t.expiresAt),
]);
```

Decisions, each anchored to a landed precedent:

- **Secret: 32 crypto-random bytes, hex (64 chars)** — byte-for-byte upstream's
  `generateTokenAndHash` (`services/auth/auth_token.go:113-121`), via
  `crypto.getRandomValues`. The cookie value is `id:secret`; like upstream it is
  unsigned — its security rests on 256 bits of entropy plus the sha256-at-rest compare.
- **sha256 at rest, plain** — exact upstream parity here (no divergence to document):
  same justification as SPEC-0002 §3's hashing decision (256-bit crypto-random secret;
  PBKDF2 defends only low-entropy secrets and costs CPU per request). Digest compare is
  timing-safe (`src/auth/digest.ts`).
- **`last_seen_at` throttled to 1 h** — written via `ctx.waitUntil`, at most once per
  hour per session. SPEC-0002 §2.7 throttles PAT `last_used_at` to 24 h for write
  amplification; sessions get the tighter 1 h because web-session liveness is
  day-relevant admin/audit data (open question 5) at bounded cost: ≤ 24 row writes per
  session per day, still negligible next to the per-request reads.
- **No cron.** GC is lazy: expiry is checked before authority (§2.4 step 2, the row is
  then deleted), and each `POST /login` sweeps expired rows in `waitUntil` (upstream
  runs `DeleteExpiredAuthTokens` on its sign-in paths, `auth.go:86,382`). No queue or
  cron trigger is added.
- **`auth_failures` is reused, not duplicated** — the login limiter shares the
  existing per-IP table and window (§2.2 step 1). No new limiter state.

## 4. Edge cases, limits, failure modes

1. **No cookie / malformed cookie** → anonymous, zero session reads (§2.4). Pages
   behave exactly as slice 1 — the anonymous wedge's cost profile and golden snapshots
   (minus the navbar delta) are unchanged.
2. **Expired session** → anonymous + lazy row delete + cookie clear. Never an error
   page for reads; a private page 404-shells like any other invisible repo.
3. **Reuse detection** (§2.4 step 3) deletes the row on a beyond-grace digest
   mismatch: attacker and victim are both locked out and must re-login. This is
   upstream's deliberate compromise response (`auth_token.go:59-65`), kept verbatim.
4. **Concurrent rotation blip**: two in-flight requests around a rotation — the
   grace-window request renders anonymous once (upstream: stale cookies "must not
   authenticate"), the client adopts the new cookie from the response that carried it.
   Accepted upstream-verbatim; open question 3 records the alternative.
5. **Prohibited or deleted user**: prohibited → session de-escalates to anonymous and
   the cookie is cleared (§2.4 step 4); deleted → FK cascade removed the rows, the
   cookie resolves to "no row" (case 1).
6. **`redirect_to` is never trusted**: path-absolute same-origin values only (§2.2
   step 6); everything else redirects to `/`. No `Host`-header or scheme-relative
   redirect is ever emitted.
7. **Login abuse**: the shared per-IP limiter caps credential stuffing at the SPEC-0002
   §2.7 budget (≥ 20 failures / 5 min, jittered); the `429` carries `Retry-After`.
   No per-account lockout exists (open question 7 records the option); session rows are
   uncapped per user (rate limiting bounds row creation).
8. **D1 unavailable during session verification** → the page handler fails with `500`
   plain text, never silently anonymous: a transient error must not masquerade as a
   logout (the gate's never-fail-open rule, `acl.ts:163-171`; SPEC-0002 §4.5).
9. **Cookie flags are not negotiable at runtime**: no config surface in this SPEC
   toggles `HttpOnly`/`Secure`/`SameSite` (upstream makes them configurable; a headless
   single-origin deployment has no legitimate variation). A future custom-domain story
   revisits this in its own SPEC.
10. **CSP interplay** (SPEC-0008 open question 6): session cookies raise the stakes of
    the two inline head artifacts; CSP adoption should land before or with the first
    *write* action, not necessarily with this SPEC (reads-only sessions with a Lax
    cookie and Origin-checked future writes are the documented posture meanwhile).
11. **Timing**: the id lookup misses are unindexed scans of nothing (primary-key
    lookup); all secret comparisons go through `timingSafeDigestEqual`; failure paths
    still touch the limiter so missing-secret and wrong-secret are indistinguishable
    from the outside.

## 5. Testing plan

Runs in `@cloudflare/vitest-plugin` (workerd, real local D1 — ADR-0001 D4), extending
the SPEC-0008 harness (`src/ui/__tests__/harness.ts`) and the SPEC-0002 seeding
pattern. Time-dependent paths take an injectable `now` (the `TokenService` convention).

- **Login (`POST /login`)**: happy path mints a row and sets `Set-Cookie` with flags
  asserted verbatim (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, `Max-Age=2678400`
  with `remember`; absent `Max-Age` without); `?redirect_to=/owner/repo` honored,
  `https://evil` and `//evil` rejected to `/`; failure paths (unknown PAT, wrong
  `user_name`, expired PAT, public-only PAT, `no-token-scope` PAT, prohibited user)
  re-render at 200 and count one limiter failure; 21st failure → `429` + `Retry-After`;
  success resets the counter.
- **Viewer + repo resolution**: the §2.6 predicate as a table — anonymous public
  (200), anonymous private (404 shell), owner session on private (200), site admin on
  private (200), unrelated user on private (404), any authenticated user on a
  limited-owner public repo (200), anonymous on the same (404). All bodies are the
  standard pages — assert status + one shell marker, reusing the SPEC-0008 page tests.
- **Rotation / reuse (§2.4)**, with time travel: fresh cookie verifies; forced rotation
  (advance `rotated_at` ≥ 24 h) rewrites digest + grace columns and returns a new
  `Set-Cookie`; the previous secret inside 60 s is rejected *without* deleting the row;
  beyond grace it deletes the row; a wrong secret deletes the row; a concurrent
  -rotation race (`changes == 0`) leaves the old cookie valid for that response.
- **Logout**: valid cookie → row gone + cookie cleared + redirect; cookieless and
  forged-cookie logout → cookie cleared, rows untouched, still a redirect.
- **Boundary (§2.9)**: a session-cookie-only request to `/api/v1/user` gets the exact
  SPEC-0002 401 JSON; `info/refs` on a private repo with only the cookie gets the
  `401` Basic challenge — the gate and `resolveAuth` matrices stay green unchanged.
- **Shell regression**: golden DOM snapshots re-baselined for the navbar delta only
  (SPEC-0008 §5.2 process); the a11y smoke covers the new navbar items.

## Open questions (resolve when the §1.1 gate opens, before implementation)

1. **Scope-carrying sessions**: should the row store the minting PAT's scope set so
   future UI writes can enforce `write:repository` per-session, or is the mint-time
   gate (§2.2 step 3) plus identity authority enough? Decide with the first write
   -action SPEC.
2. **TTL values**: 24 h slide + 31 d remember mirror upstream defaults; confirm at
   implementation (they are config upstream — `SESSION_LIFE_TIME`,
   `LOGIN_REMEMBER_DAYS` — and become two constants here).
3. **Rotation blip**: accept the upstream-verbatim grace-window anonymous render
   (§2.4 step 5), or authenticate within grace as a documented tightening? Default:
   mirror upstream.
4. **Route shape**: keep `/login` + `/logout`, or also claim upstream's
   `/user/login` + `/user/logout` aliases (matters when the official bundle's own auth
   pages are ever reused, and when passwords land — see §1.3).
5. **Session management UI**: list-active-sessions / logout-everywhere (upstream
   deletes by user id on credential changes, `DeleteAuthTokensByUserID`); needs an
   admin surface decision.
6. **Per-account login lockout** in addition to the per-IP limiter (upstream has
   neither; SPEC-0002 §2.7 chose per-IP only). Default: no.
7. **Upstream session-store features** with no D1 analog yet (flash messages, locale
   persistence in the store) — adopt per-feature when the corresponding page work
   needs them; do not grow the store speculatively.

## Milestones (execute only after §1.1 opens the gate)

- **S1 — schema + session service.** `sessions` migration, session service module
  (mint / verify / rotate / logout / GC, §2.4 + §3), unit tests. Exit: service suite
  green against real D1.
- **S2 — routes + viewer + navbar.** `GET/POST /login`, `POST /logout`, `resolveViewer`
  extension, navbar chrome, limiter wiring, §5 login/logout/viewer tests, goldens
  re-baselined. Exit: login → browse a public repo signed-in → logout, all asserted.
- **S3 — resolution widening.** `resolveRepositoryForViewer` over the shared gate
  predicate, private/limited matrix tests, boundary tests (§2.9). Exit: the §2.6 table
  passes end-to-end; `/api/v1` + git suites demonstrably untouched.

## 6. First-run amendment — the admin-init window + the ALLOW_SIGNUP gate (as-built 2026-10-28)

Amendment (ratified design, landed by the first-run-bootstrap unit): a fresh
deployment (Deploy button, zero shell) becomes usable in one browser step. Two
surfaces, both web routes under the session model above; implementation:
`src/services/user-accounts.ts` (service), `src/ui/first-run.ts` (router),
`src/ui/pages/first-run.tsx` (sign-up page render), `src/ui/pages/login.tsx`
(the login-page extension).

### 6.1 The zero-user admin-init window (one-shot by construction)

> **As-built amendment (2026-10-30)**: the gate counts HUMANS, not rows —
> the migration-seeded SYSTEM service principals (`assets` via 0003,
> `gitea:deploy-key` via 0020) don't close the window. The predicate is the
> codified system-row shape's negation (`status='prohibited'` + `is_admin=0`
> + no email) shared by `initWindowOpen` and the atomic insert's NOT EXISTS
> guard (services/user-accounts.ts, `NON_SYSTEM_USER_ROW`); a
> prohibit-logged human keeps its email and never reopens the window. The
> "zero-user/empty" phrasing below is the ratified-era text — read it as
> "no human user yet". Found by the act_runner smoke (a freshly-migrated
> instance's window was dead under the empty-table gate); pinned by the
> seeded-system regression tests in user-accounts.test.ts.

- **Surface**: when `users` is EMPTY, the login page additionally renders the
  "Administrator Account Settings" panel (`loginFirstRunLocale`, login.tsx);
  the standalone `GET /install` renders the identical page. This is upstream's
  install-page admin-creation posture
  (`gitea/routers/install/install.go:452–478` `initAdminUser` — `IsAdmin: true`,
  active — over `services/forms/user_form.go:54–57`'s AdminName/AdminEmail/
  AdminPasswd InstallForm fields and `templates/install.tmpl:227–247`), mounted
  on OUR login page instead of a separate install wizard.
- **Routes**: `GET /install` (panel, or 303 `/` once any user row exists —
  upstream's post-install posture, `routers/install/routes.go:30–32`) and
  `POST /install` (the atomic creation). Upstream's install family lives on
  `/` (`routes.go:30–31`); cf-gitea claims `/install` because `/` is a landed
  app surface (documented divergence). Both carry the §2.8 layer-2 origin
  check; failures re-render inline at 200 (the §2.2 posture).
- **Atomicity (the race argument)**: the decision is a SINGLE SQLite statement —
  `INSERT INTO users (...) SELECT ... WHERE NOT EXISTS (SELECT 1 FROM users)` —
  so "empty table" is checked by the statement, never by a prior read (no
  TOCTOU). D1 serializes writers to the one SQLite database, so two
  simultaneous first-submissions run strictly one-after-another: the winner's
  insert affects 1 row; the loser's `NOT EXISTS` sees the winner's row and
  affects 0 (`meta.changes == 0`, the session.ts CAS convention) → the loser
  re-renders with the clear "This instance is already initialized" verdict,
  form gone. Exactly one admin exists by construction.
- **Row shape**: the `POST /admin/users` ladder verbatim (adminCreateUser,
  `src/api/routes/admin-t2.ts:842–865` — usable-username via the shared
  `usableUsernameError`, the email-format check, the `UNIQUE(username_lower)`
  arbiter) — `is_admin=1`, `status='active'`, `type='user'`. NO password store
  (SPEC-0002 §4.6.7; admin-t2 deviation 1): the install form's password field
  is accepted-and-ignored for InstallForm parity — the page copy says so.
- **One browser step**: on success the router mints a web session for the new
  admin (§2.2 step-5 shape) and 303s to `/` — upstream's auto-login
  (`install.go:479–490`). The admin then mints PATs in settings for git/API
  (`bootstrap-admin.mjs` remains the shell path for pre-existing deployments).
- **Window semantics**: "any user row" includes org rows (`users` holds both
  types, SPEC-0007) — the same semantics as upstream's `HasUsers` over the
  unified user table. The window is one-shot by construction; orgs are
  created by admins only, so it cannot be re-opened.

### 6.2 The ALLOW_SIGNUP gate (regular registration)

- **Surface**: `GET/POST /user/sign_up` — upstream's exact path shape
  (`routers/web/web.go:597–598`), the page shaped after
  `templates/user/auth/signup.tmpl` + `signup_inner.tmpl` (page-content
  `user signin`, required user_name/email/password/retype,
  `auth.create_new_account` submit, the already-have-account footer), POST
  semantics per `auth.SignUpPost` (`routers/web/auth/auth.go:548–632`):
  validation ladder, collision arms, then create + auto sign-in
  (`handleSignIn`, auth.go:632 — our §2.2 step-5 session mint).
- **Gate**: the `ALLOW_SIGNUP` wrangler var (deploy-page-visible), default
  FALSE — the inverted polarity of upstream's `DISABLE_REGISTRATION` default
  TRUE (`modules/setting/service.go:148`), same self-host posture. Read
  absent-safe (`FirstRunEnv.ALLOW_SIGNUP?: string`, the
  `MIRROR_EGRESS_MODE` optional-var pattern): `true`/`1` (any case) enables.
  While closed, pages AND routes answer **404** (hidden — the unregistered
  upstream route shape), not 403.
- **Validation reuse**: the shared account ladder
  (`services/user-accounts.ts`): `usableUsernameError` (the reserved/pattern
  list), the email-format port (admin-t2's `invalidEmailMessage`,
  `email_address.go:120–138`), the retype match (auth.go:577), the
  name/email collision pre-checks with upstream's web copy
  (`form.username_been_taken` / `form.email_been_used`), the live
  `user_redirect` consumption (user.go:798, the adminCreateUser arm), and
  the UNIQUE arbiter for the two-signups race. Created accounts are plain
  members (`is_admin=false`), active, public.
- **Divergences**: no captcha / email-domain blocklist / password
  complexity/pwned checks (no password store, no mailer — the accepted-and-
  ignored set again); the per-IP failure limiter stays a login-only budget
  (signup is account creation, not credential verification — abuse posture
  rides the gate default-off); signed-in browsers 303 to `/` on all four
  first-run routes (upstream renders sign_up to signed-in users).

### 6.3 Mounting + login-page integration (two-phase landing)

The router lands complete-but-unmounted (orchestrator-owned `src/index.ts`):
`app.route("/", firstRunRouter);` next to the sessionRouter mount (order
immaterial — no claimed path overlaps, `/install` and `/user/sign_up` are
top-level like `/login`, §2.1). The login page's panel + register link ride
`renderLoginPage`'s OPTIONAL `adminInit` / `signUpLink` options (default
absent — the §5 golden stays byte-stable); wiring them on `GET /login` is the
one-line call-site delta in the orchestrator-owned `session.ts` (the exact
recipe is the HANDOFF NOTE in `login.tsx`). Until then `GET /install` renders
the identical page.

### 6.4 Testing plan (§5 extension)

`src/ui/first-run.test.ts` (real D1, handlers direct + sessionRouter
mounted): the gate's absent-safety; the init happy path (row shape, session
mint, viewer isAdmin); the window closing (GET 303, POST verdict); THE RACE
(two concurrent submits → exactly one admin); validation re-renders;
signup 404/off + on; signup validation reuse (name/email/retype, taken
name/email, redirect consumption); the init-created admin logging in with a
PAT (`POST /login`) and holding `is_admin` in `resolveViewer`; the
login-page extension (default golden-identical, panel, verdict page, link).
