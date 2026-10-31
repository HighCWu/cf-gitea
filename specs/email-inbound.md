# SPEC: Inbound Email (reply-by-mail to a comment)

Status: **DESIGN + SLICE ONE** (v1.4 queue #3, 2026-10-31). Slice one lands
the `email()` handler mount, the reply-token mint/verify library, the
header/token search, the bounded MIME text extractor, the quoted-reply trim,
the D1 inbound dedupe/log table and the comment emit through the landed
`IssuesService.addComment` — everything EXCEPT the outbound token embedding
(§9 HANDOFF), so the handler is real and armed but no mail carries a token
until the notify hub folds the Reply-To arms in.
Upstream references are at the submodule pin `fc4936884584a41931906553d96c2601d750e6ef`.

Companion to `specs/email-outbound.md` (the mailer service, the outbox
queue, the notify hub the reply-mail arm rides). The outbound SPEC's §8.2
reduction 4 records the incoming-email header arms as "not landed" — this
SPEC is the design for them.

---

## 1. Problem and scope

### 1.1 Problem

Upstream Gitea can create issue/PR comments from replies to notification
mail: each notification carries a per-recipient reply token, and a background
process (IMAP IDLE poll) picks replies up, verifies the token, strips the
quoted history and posts the comment as the token's user
(`gitea/services/mailer/incoming/`). cf-gitea sends the notification mails
(email-outbound §8-10) but has no inbound half: replying to a notification
reaches a mailbox nobody reads.

The Workers platform makes upstream's transport impossible in kind, not in
degree: upstream dials raw TCP to poll an IMAP mailbox with IDLE
(`incoming/incoming.go:57-105`, `go-imap` client dial + login + select).
Workers cannot open arbitrary outbound TCP sockets, and there is no mailbox
to poll. The platform's native inbound-mail surface is **Cloudflare Email
Routing delivering to the Worker's `email()` handler** — the exact analogue
of upstream's "the MTA hands Gitea the mail" position, minus the poll loop.
Per the AGENTS.md Upstream-Parity Decision Rule this is not a decision
point: the platform admits exactly one inbound-mail shape, and upstream's
own architecture (MTA → parser → token verify → handler) ports onto it
one-to-one.

### 1.2 In scope (this change)

- **The decision record** (§2-§5): the pin's incoming model (cited), the
  token adaptation, the MIME posture, the security posture, the config
  surface.
- **Slice one** (§7): `services/mail/inbound.ts` (token mint/verify,
  header token search, automatic-reply detection, bounded MIME text
  extraction, quoted-reply trimming, the `handleIncomingEmail` orchestrator),
  the `email()` mount in `src/index.ts`, the `email_inbound` D1 table
  (migration 0054), the comment emit through the LANDED
  `IssuesService.addComment` (the mail env seam — the emitted comment fans
  the notify hub exactly like a web-posted one), and the test suite.
- **Config surface**: `MAIL_INBOUND_*` vars in `wrangler.jsonc.example`
  + the `MAIL_INBOUND_SECRET` secret name, `.dev.vars.example`, the runbook
  posture (§8).

### 1.3 Out of scope (enumerated follow-ups)

- **The outbound token embedding** (§9 HANDOFF, notify.ts owner): when
  `MAIL_INBOUND_ENABLED=true`, the notify compose arms add upstream's
  `Reply-To: <reply address with token>` + `List-Post` mailto + the
  `<reply-<token>@domain>` References entry + the mailto arm of
  `List-Unsubscribe` (mail_issue_common.go:181-202). Slice one ships the
  mint function (`createReplyToken`) the fold will call; no outbox mail
  carries a token yet.
- The `UnsubscribeHandler` arm (upstream `incoming_handler.go:153-188`):
  unwatch-by-mail. The token version byte and ref vocabulary leave room;
  it lands as its own slice with its own tests (notify.ts's
  List-Unsubscribe mailto is its outbound half — same HANDOFF).
- Mail attachments → issue attachments (upstream
  `incoming_handler.go:86-110` behind `setting.Attachment.Enabled`):
  our attachment service is not wired to mail; documented reduction (§4.6).
- Code-comment replies (upstream's `CommentTypeCode` branch,
  `incoming_handler.go:125-140` → `CreateCodeComment`): code comments are
  not landed; a comment-token reply always lands a plain issue comment
  (§4.4).
- The multi-locale quoted-trim families (CJK verbs/devices, the
  Latin-locale wrote-verbs beyond English, locale mobile footers —
  `reply.go:19-39`): slice one ports the structural core + the English
  arms (§4.5); the locale tables are additive one-line regex extensions
  upstream itself grows the same way.
- Inbound-log retention (the table grows; the audit-retention sweep is the
  model for a follow-up cron arm).
- `Auto-Submitted`-shaped OUTGOING mail on the notification side: upstream
  sets `X-Auto-Response-Suppress: All` (already landed, outbox §4.2) —
  enough for the loop analysis in §6; nothing more to build.

---

## 2. Upstream source of truth (verified at the pin)

### 2.1 The token (services/mailer/token/token.go)

- Structure (`token.go:19-26`): `| Token Version | User ID | HMAC | Payload
  |`, payload `| Timestamp (expiry) | Handler/Action Type | Action Data |`;
  version byte `tokenVersion1 = 1` (:28).
- Encoding: base32, **no padding** (:40); decode normalizes to the base32
  alphabet with `strings.ToUpper` FIRST — "MTAs are permitted to alter the
  case of the local-part (RFC 5321 §2.4)" (:79-81).
- HMAC: SHA-256 over the payload, **keyed by the per-user secret
  `user.Rands`** (:66-67), TRUNCATED to 10 bytes — "RFC2104 recommends not
  using less than 80 bits" (:124-131); compared with
  `crypto_hmac.Equal` (constant time, :106).
- Expiry: `time.Now().AddDate(1, 0, 0)` — **1 year** (`tokenLifetimeInYears`,
  :29, :57), checked at decode (:117-119).
- Decode validation order (:78-122): base32 decode → version byte →
  unpack (userID ‖ hmac ‖ payload) → **load the user**
  (`GetValidDoerUserByID`, models/user/user.go:1099-1112: exists,
  individual-or-bot, `IsActive`, `!ProhibitLogin`) → constant-time HMAC
  compare → unpack (expiry ‖ handlerType ‖ data) → expiry check.
- Failure shape: `ErrToken` (:42-52) — the IMAP loop LOGS it and moves on
  (`incoming.go:221-228`): an invalid token never bounces the mail and
  never stops the world.
- Handler types (:34-38): Unknown 0, **Reply 1**, Unsubscribe 2.

### 2.2 Where the token travels (mail_issue_common.go:181-202)

Per RECIPIENT (the token binds user + reference): if `IncomingEmail.Enabled`
(`CanReply`), `CreateToken(ReplyHandlerType, recipient, replyPayload)` with
`replyPayload = CreateReferencePayload(issue-or-comment)`
(`incoming/payload/payload.go`: version byte + refType (issue 0 /
comment 1) + refID). The token is then embedded:

- `Reply-To` = the configured `REPLY_TO_ADDRESS` template with
  `%{token}` substituted once (:186-187) — the placeholder MUST sit in the
  user part (before the @), validated at boot; a display name must not be
  set (`modules/setting/incoming_email.go:47-63` — the loader Fatal's).
- `List-Post: <mailto:replyAddress>` (:188-189).
- `References` gains `<reply-<token>@AppDomain>` (:190-191) — a SECOND
  carrier so plain group-reply ("reply-all") delivers the token even when
  the client replies to From/References instead of Reply-To.
- `List-Unsubscribe` gains the mailto arm with the UNsubscribe token
  (:194-201).

### 2.3 The inbound search + guards (incoming/incoming.go)

- Transport: IMAP IDLE poll (§1.1 — the impossible half; replaced, not
  ported).
- Automatic-reply skip FIRST (`isAutomaticReply`, :259-270), before the
  token search: `Auto-Submitted` present and ≠ "no", `X-Autoreply: yes`,
  or `X-Autorespond` non-empty.
- Token search (`searchTokenInHeaders`, :283-320): the `To` address list,
  then `Delivered-To`, then every msg-id in `References` matching
  `reply-<token>@AppDomain` (case-insensitive prefix/suffix extraction,
  `extractToken` :272-281).
- Size guard: the IMAP search criteria carry
  `Smaller = IncomingEmail.MaximumMessageSize` (:149) — oversized mail is
  never fetched. Default **10 MiB = 10485760** (incoming_email.go:32).
- No token → log + skip (:216-219); invalid token → log + skip (:221-228).

### 2.4 The reply handler (incoming/incoming_handler.go)

- Resolve the reference: issue → the issue; comment → its issue (:44-64).
- Permissions (:70-84): `GetDoerRepoPermission`; **locked issues require
  write** (`IsLocked && !CanWriteIssuesOrPulls && !IsAdmin` → silent skip);
  **read required** (`!CanReadIssuesOrPulls` → silent skip). Silent = log
  Debug, return nil — never an error, never a bounce.
- Content: `getContentFromMailReader` (:348-361) — plain text through
  `extractReply` (the trim, §2.5) + the attachments.
- Empty guard (:112-114): empty content AND no attachments → skip.
- Emit: `CreateIssueComment` (issue refs and every non-code comment type;
  the `CommentTypeCode` branch → `CreateCodeComment`, :116-149 — ours
  reduces to the plain arm, §4.4). Upstream fires the comment through the
  service layer, so the created comment fans the SAME notification mail
  participants get from a web-posted comment — the round-trip is
  upstream-intended.

### 2.5 The quoted-reply trim (incoming/reply.go)

`extractReply(text)` (:80-108) cuts the user-written part out of the plain
body:

1. cut at the FIRST line matching a **signature** delimiter (`--`, `__`,
   `—`, "sent from/via/with …", "get outlook for …", CJK device-anchored
   arms :50-54), an **attribution** line (a `wrote:`/`writes:` verb family,
   a `Name <addr> wrote` shape, an `On <date> <time>` lead, an ISO date lead
   :61-67), a **separator** rule line (`-----…-`, `-------- Original
   Message --------`, `-----Mensaje original-----` :71), or a
   **forwarded-header block** start (a From-field line followed by another
   header-field line, :25-39 + :113-123 — the second-line guard keeps a
   lone "Subject:" sentence in prose from becoming a boundary);
2. drop the trailing block of quoted (`>`-prefixed) / blank lines — unless
   the WHOLE body is quoted (:94-107), with the `ᐧ` mobile-marker arm;
3. trim.

It is upstream's own dependency-free reimplementation of
`github.com/dimiro1/reply` (MIT) (:77-79) — bottom posting and forwarded
bodies are explicitly not handled upstream either (:79).

---

## 3. DECISION RECORD — the platform adaptation

### 3.1 Transport: Email Routing → the `email()` handler (forced)

Verified against OUR wrangler (4.153.0, the pinned resolution — both
4.152.0/4.153.0 copies in the store agree):

- The ONLY email key in `node_modules/.pnpm/wrangler@4.153.0_*/node_modules/
  wrangler/config-schema.json` is the OUTBOUND `send_email` binding
  (`/definitions/RawConfig/properties/send_email`,
  `/definitions/RawEnvironment/properties/send_email`,
  `/definitions/PreviewsConfig/properties/send_email`) — the binding the
  outbound SPEC §3.1(b) already REJECTED for arbitrary recipients. **Inbound
  needs NO binding and NO wrangler config at all**: the Worker exports an
  `email` handler and the zone's Email Routing rules deliver to it.
  (`worker-configuration.d.ts:506` `email?: EmailExportedHandler<Env,
  Props>`; `:13409` the handler type `(message: ForwardableEmailMessage,
  env, ctx) => void | Promise<void>`; `:13306-13345` `ForwardableEmailMessage`:
  envelope `from`/`to`, parsed `headers: Headers`, `raw: ReadableStream`,
  `rawSize`, `setReject(reason)` (permanent SMTP reject), `forward`,
  `reply`.)
- Platform facts (developers.cloudflare.com/email-routing, verified
  2026-10-31): inbound messages cap at **25 MiB** (larger rejected before
  the Worker runs); Cloudflare validates **DMARC (covering SPF/DKIM)**
  before invoking the Worker and PREPENDS an `Authentication-Results`
  header with the `mx.cloudflare.net` identifier — sender-supplied
  Authentication-Results headers exist too and MUST NOT be trusted without
  checking the identifier; `setReject` = permanent SMTP error to the
  connecting MTA; an unhandled handler throw is a processing failure (the
  docs' own error pattern: catch, log, and only setReject as a last
  resort).
- Consequence for the poll loop: there is nothing to poll. Upstream's
  `Init`/IDLE/reconnect machinery (:25-143) has NO port — the platform
  invocation IS the loop iteration. The 10-second restart timer, IMAP
  flags/search/delete state and `DeleteHandledMessage` have no analogue
  (the "delete handled mail" bookkeeping becomes the D1 log row,
  §5).
- Consequence for local dev/CI: the vitest plugin
  (`@cloudflare/vitest-plugin` dist, verified 2026-10-31) has NO mechanism
  to deliver an email to the `email()` handler — miniflare simulates
  bindings, not Email Routing. THEREFORE the handler logic lives entirely
  in `services/mail/inbound.ts` behind a structural message interface
  (the `ForwardableEmailMessage` surface), and `src/index.ts` mounts it as
  a THIN `email()` arm; the test suite drives the service with a fake
  message. The mount is exercised by the type system (it satisfies
  `ExportedHandler<Env>`'s `email?: EmailExportedHandler`) and by the
  service tests; there is no runtime email test in vitest, documented here
  as the platform limit.

### 3.2 Token: the same capability shape, a different key source

Upstream's HMAC key is the PER-USER `user.Rands` column. Our `users` table
carries no per-user random secret column (schema verified 2026-10-31 — no
`rands`/secret column exists), and minting per-user keys is not what the
platform guidance wants for a server-held capability: the mission-directed
shape is **HMAC over (reference, recipient, expiry) under a server secret**
(`MAIL_INBOUND_SECRET`, a wrangler secret). Divergences from upstream,
all recorded:

- KEY: `MAIL_INBOUND_SECRET` (server-held) instead of per-user `Rands`.
  Upstream's `Rands` is itself an opaque random per row — the security
  property that matters (an unguessable MAC key not derivable from public
  data) holds identically; the trade is that a secret rotation invalidates
  every outstanding token at once (upstream: per-user password/reroll
  invalidates one user's). Documented; rotation guidance in the runbook.
- COVERAGE: the MAC covers EVERYTHING (version ‖ userId ‖ expiry ‖ refType
  ‖ refId) instead of upstream's payload-only slice — the tighter shape;
  upstream's userID sits outside its MAC and is trusted by lookup.
- LENGTH: same 10-byte truncation (the RFC2104 80-bit floor, token.go:130).
- LIFETIME: same 1 year (token.go:29).
- ENCODING: same base32-no-padding with ToUpper normalization (RFC 5321
  §2.4, token.go:79-81).
- Layout (32 bytes → 52 unpadded base32 chars — well under the 64-char
  local-part ceiling):

```
byte 0      version 0x01
bytes 1-8   userId   (u64 BE)
bytes 9-12  expiry   (u32 BE, unix seconds)
byte 13     refType  (0 = issue, 1 = comment)   ← payload.go's vocabulary
bytes 14-21 refId    (u64 BE)
bytes 22-31 HMAC-SHA256(key, "cf-gitea/mail-reply/v1" ‖ bytes[0..21])[0:10]
```

  (the domain-separation prefix keeps this secret usable for later token
  families — Unsubscribe — without cross-family forgery).
- Decode validation order mirrors upstream §2.1 exactly: decode → version →
  fields → **load the user** (our `GetValidDoerUserByID` parity: row
  exists, `type = 'user'` — no bots in our schema, and orgs are not
  mailable participants on the outbound side either — `status =
  'active'`) → constant-time MAC compare → expiry check. Failure classes
  (`invalid` / `expired`) log and drop, never bounce (§2.1's ErrToken
  posture).

### 3.3 MIME parsing: hand-rolled bounded extractor (not a dependency)

Upstream parses the full MIME envelope with `enmime` (a dependency) and
reads headers through `net/mail`. The Workers runtime hands us the parsed
top-level headers for free (`message.headers`), so the ONLY parsing job is
the BODY: find the first readable `text/plain` part and decode it.
Decision: a **bounded hand-rolled extractor** in `inbound.ts` rather than
adding a MIME dependency (postal-mime is the evaluated alternative —
upstream-faithful in kind, but a new dependency + a shared
`package.json`/lockfile touch outside this unit's file ownership, for a
surface that needs exactly one leaf part). The extractor is ONE function
with a byte bound; swapping to postal-mime later is a one-file change
behind the same signature, recorded here as the sanctioned swap path.

Bounded by construction (AGENTS.md: stream large bodies):

- the pre-read size gate uses `message.rawSize` (runtime-provided) against
  the upstream default cap **10 MiB** (`MaximumMessageSize = 10485760`,
  incoming_email.go:32; Email Routing's own hard cap is 25 MiB, so our
  stricter cap always bites first) — BEFORE any stream read;
- the stream read itself re-bounds at the same cap (a lying `rawSize`
  cannot buffer the Worker);
- MIME walk: depth-first over `multipart/*` boundaries (depth ≤ 3, ≤ 50
  parts — a pathological nesting bomb terminates), skip
  `Content-Disposition: attachment` / filename-bearing parts (enmime's
  `env.Text` = the first non-attachment text/plain), skip every non-plain
  leaf; **no text/html fallback** — upstream's `env.Text` is the plain
  part only, and an html-only mail yields empty content → the empty guard
  (§2.4) drops it;
- transfer-encodings: base64, quoted-printable (soft breaks included),
  7bit/8bit/binary pass-through; charsets via `TextDecoder` with an
  utf-8 → windows-1252 fallback ladder (an unknown label degrades instead
  of failing the mail — the log carries the charset used);
- RFC 2047 encoded-words are NOT decoded: the headers the token search
  reads (To, Delivered-To, References) are addr-spec/msg-id shaped —
  RFC 2047 never applies inside them — and the Subject is log metadata
  only (stored clipped, raw).

### 3.4 Dedupe + log: one D1 table (needed — at-least-once delivery)

Upstream's dedupe is the IMAP mailbox's seen/deleted flag state — it can
trust the mailbox to hand each message once. Email Routing is
AT-LEAST-ONCE: MTA retries and platform redelivery can hand the Worker the
same mail twice, and a duplicate would post the same comment twice. The
design therefore needs persistent dedupe, and the same row is the inbound
log (upstream's `handledSet` + log lines, made durable). ONE table:
`email_inbound` (§5) — the row is inserted BEFORE processing with a UNIQUE
`dedupe_key` (the outbox's `dedupe_key` arbiter pattern, email-outbound
§4.1), the UNIQUE violation IS the duplicate verdict, and the outcome
columns record what the message did. No Message-ID? RFC 5322 makes it a
SHOULD, so the key falls back to a SHA-256 over the stable envelope tuple
(from ‖ to ‖ subject ‖ date ‖ rawSize) — duplicates still collapse.

---

## 4. Security posture

1. **NEVER authorize on From.** The token is the sole authority (possession
   = capability), exactly upstream's model — `processMessages` consults
   NO sender identity (`incoming.go:210-244`: auto-reply check, token
   search, decode; the From header never participates; the decoded userId
   IS the doer). A forged From plus a valid token is upstream-intended
   (the token holder IS the user — that is what makes reply-from-a-second
   address work); a forged From WITHOUT a token is noise and drops at the
   no-token gate. The test suite pins both arms.
2. **Email Routing's Authentication-Results = signal, not authority.** The
   CF-prepended header (identifier `mx.cloudflare.net` — sender-supplied
   ones are untrusted per the platform docs) is parsed into the log row's
   `auth_results` column for forensics. A DMARC failure NEVER blocks a
   valid token (the token is unguessable — HMAC-SHA256 truncated to
   80 bits over a 21-byte covered range under a server secret — so
   guessing one is infeasible and DMARC adds no authorization property);
   a DMARC failure ALSO never blocks token-less mail from dropping
   silently (it would have dropped anyway). It exists so an operator can
   correlate abuse in the log.
3. **Dedupe on Message-ID** (§3.4) — at-least-once redelivery cannot
   double-post.
4. **Loop prevention** (the composed guards, each cited):
   a. `isAutomaticReply` skip BEFORE the token search (upstream order,
      incoming.go:210-219) — vacation responders/auto-ack machines that
      quote our References die here, token and all;
   b. our OUTGOING notification mail carries `X-Auto-Response-Suppress:
      All` (outbox §4.2, always) — RFC-compliant autoresponders never
      reply to us in the first place (the loop cut at generation);
   c. the Message-ID dedupe kills any SAME-message echo loop;
   d. token expiry (1 year) bounds every token's blast radius;
   e. the residual human-loop (a user auto-forwarding our notification
      mail back into the reply address, generating fresh messages) is
      upstream's own residual exposure (upstream processes it identically
      — a valid token posts a comment); it is deliberate forwarding by a
      principal who possesses the mail, not a server-loop, and is
      documented, not "fixed".
5. **Size caps**: 10 MiB pre-read gate → `setReject` (the MX position:
   upstream's IMAP client could only skip fetching; as the MX we answer
   the connecting MTA with a permanent reject, and the sending MTA informs
   the human) + the bounded read (§3.3). Attachment-less text keeps the
   worst-case body well under the D1 row's subject/log clip bounds.
6. **Permissions re-checked at decode time** (the token is a 1-year
   capability; the world can change under it): the doer must still be
   valid (§3.2), the issue/repo must still exist, and the upstream gates
   run fresh on EVERY mail — read permission (`doerRepoAccessMode`
   non-none, owner/site-admin shortcut), locked-issue write requirement
   (mode ≥ write unless site admin) — incoming_handler.go:70-84's exact
   two-gate shape. A revoked collaborator's old token drops at the
   permission gate with outcome `dropped-permission`.
7. **The secret never appears in code, config, or specs** (AGENTS.md);
   the example config declares the NAME only (`secrets.required`
   discipline, email-outbound §6).

---

## 5. Data model: the `email_inbound` table (D1, migration 0054)

```
email_inbound:
  id             integer PK AUTOINCREMENT
  dedupe_key     text NOT NULL   -- Message-ID, else sha256 over the stable
                                 -- envelope tuple; UNIQUE (the arbiter)
  message_id     text NOT NULL DEFAULT ''  -- raw header (clipped 998)
  from_address   text NOT NULL   -- envelope From (message.from)
  to_addr        text NOT NULL   -- envelope To   (message.to)
  subject        text NOT NULL DEFAULT ''  -- raw header, clipped 998
  auth_results   text            -- CF Authentication-Results (clipped 1024)
                                 -- when the mx.cloudflare.net identifier
                                 -- matches; NULL otherwise
  token_status   text NOT NULL DEFAULT 'none'
                 -- 'none' | 'invalid' | 'expired' | 'valid'
  outcome        text NOT NULL DEFAULT 'pending'
                 -- 'pending' | 'dropped-misconfigured'
                 -- | 'rejected-oversize' | 'dropped-duplicate'
                 -- | 'dropped-auto-reply' | 'dropped-no-token'
                 -- | 'dropped-invalid-token' | 'dropped-expired-token'
                 -- | 'dropped-permission' | 'dropped-empty'
                 -- | 'dropped-missing-ref' | 'comment-created' | 'error'
  user_id        integer         -- the token's doer, when decoded
  ref_type       text            -- 'issue' | 'comment', when decoded
  ref_id         integer         -- the reference id, when decoded
  comment_id     integer         -- the created comment, on success
  error          text            -- clip(errorText, 1024), on 'error'
  received_at    integer NOT NULL (timestamp)
  processed_at   integer         (timestamp)
CREATE UNIQUE INDEX email_inbound_dedupe_key_uq ON email_inbound (dedupe_key)
```

Write order: INSERT first (before any decision) so the arbiter is race-safe
under redelivery; every later step UPDATEs the outcome on the same row.
The disabled posture (§8) writes NOTHING (the register-notify gate-off
tripwire posture, email-outbound §7.5). Upstream analogue: `handledSet` +
log lines + the IMAP delete flag, made durable and queryable; retention is
the §1.3 follow-up.

---

## 6. The handler pipeline (`handleIncomingEmail`)

Order matters; every step is upstream-cited. Return value: a typed outcome
(the mount ignores it; the tests pin it).

1. **Gate** — `MAIL_INBOUND_ENABLED !== "true"` → log, outcome `disabled`,
   ZERO D1 writes (fail-closed, upstream `Init`'s early return,
   incoming.go:26-28, without the mailbox pile-up).
2. **Config validation** — `MAIL_INBOUND_SECRET` missing/empty, or
   `MAIL_INBOUND_REPLY_ADDRESS` invalid (unparseable as an address, a
   display name present, or `%{token}` not exactly once in the user part —
   incoming_email.go:47-63's rules): the row records
   `dropped-misconfigured` and the mail is consumed silently (no bounce —
   a config error must not tell the sender anything). Upstream Fatal's at
   boot (incoming_email.go:42-45); we have no boot step — the loud log +
   visible row is the honest adaptation (the §5.2 posture of the outbound
   SPEC).
3. **Size gate** — `rawSize > 10485760` → row `rejected-oversize` +
   `setReject("...maximum accepted size...")`.
4. **Dedupe insert** — build `dedupe_key` (§3.4), INSERT; UNIQUE violation
   → log + outcome `dropped-duplicate` (reported via the lookup miss: the
   FIRST row owns the outcome). Insert columns include the envelope pair,
   subject, message-id, `auth_results` (parsed only when the header's
   identifier is `mx.cloudflare.net`).
5. **Automatic-reply skip** — upstream `isAutomaticReply` verbatim
   (:259-270): `Auto-Submitted` present ≠ "no", `X-Autoreply: yes`,
   `X-Autorespond` non-empty → row `dropped-auto-reply`.
6. **Token search** — upstream `searchTokenInHeaders` shape:
   To → Delivered-To (addr-spec candidates against the
   `MAIL_INBOUND_REPLY_ADDRESS` template split around `%{token}`, the
   case-insensitive prefix/suffix extraction of `extractToken` :272-281 +
   :322-334), then References msg-ids against `reply-<token>@` + the
   `APP_URL` host (:299-317 — the hardcoded "reply-" user and the AppDomain
   suffix are upstream constants). No token → `dropped-no-token`.
7. **Decode + verify** (§3.2): lowercase input normalized up, version byte,
   field unpack, user-load parity, constant-time MAC compare, expiry →
   `dropped-invalid-token` / `dropped-expired-token` with the matching
   `token_status`.
8. **Reference resolve** — refType issue → the issue row; comment → the
   comment row → its issue (incoming_handler.go:44-64). Missing →
   `dropped-missing-ref` (the upstream error path logged, made a typed
   outcome — a token pointing at a deleted comment is a NORMAL state after
   cleanup, not an operator alarm).
9. **Permission gates** (§4.6): read, then locked-write (site admin
   override) → `dropped-permission` (upstream's silent Debug skip).
10. **Body extract + trim** — the bounded extractor (§3.3) →
    `extractReplyText` (§4.5's port of `extractReply`) → empty →
    `dropped-empty` (incoming_handler.go:112-114, attachments absent in
    this slice).
11. **Emit** — `new IssuesService(env.DB, env)` (the mail env seam:
    `InboundEmailEnv` carries DB/REPO_TASKS/APP_URL/MAIL_ENABLED/MAIL_FROM
    plus the inbound vars, so the emitted comment fans the notify hub when
    outbound is armed — upstream's CreateIssueComment-notifies parity,
    §2.4) → `addComment({ issueId, posterId: userId, content })` (plain
    type-0; the Code-comment branch is the §1.3 reduction) → row
    `comment-created` + `comment_id` + `processed_at`.
    A write failure updates the row to `error` + clip(errorText, 1024) and
    RETHROWS — the mount does not catch (the platform processing-failure
    signal; Email Routing redelivers/bounces, the row says why).

---

## 7. Slice one as-built (files)

- `apps/worker/src/services/mail/inbound.ts` — the whole library +
  orchestrator; exports the mint (`createReplyToken`) for the §9 HANDOFF
  owner; the structural `InboundEmailMessage` interface (the
  `ForwardableEmailMessage` surface: from/to/headers/raw/rawSize/setReject).
- `apps/worker/src/services/mail/inbound.test.ts` — workerd + real D1
  (the notify.test.ts harness shape), the queue stubbed with the recording
  spy; the email() MOUNT itself is not runtime-exercisable in vitest
  (§3.1) and is covered by tsc against `ExportedHandler<Env>`.
- `apps/worker/src/db/schema.ts` + migration 0054 (`email_inbound`).
- `apps/worker/src/index.ts` — the `email` arm of the export object
  (thin: `await handleIncomingEmail(env, message)`), nothing else.
- `apps/worker/wrangler.jsonc.example`, `apps/worker/.dev.vars.example`,
  `docs/ops/runbook.md` — config + posture (§8).
- NO binding added → NO `wrangler types` regen needed (the gate's
  conditional; `worker-configuration.d.ts` already carries the email
  handler types at :506/:13409). The new vars ride the structural
  `InboundEmailEnv` type; the generated `Env` picks them up when an
  operator copies the example (local dev without them = the disabled
  no-op, by design).

## 8. API/config surface

No new bindings. Vars (`wrangler.jsonc.example`, strict polarity —
the MAIL_* family convention, email-outbound §6):

| var | default | upstream |
|---|---|---|
| `MAIL_INBOUND_ENABLED` | `"false"` (only `"true"` arms) | `[email.incoming] ENABLED` (incoming_email.go:26-28,38-40) |
| `MAIL_INBOUND_REPLY_ADDRESS` | `""` (invalid while empty) | `REPLY_TO_ADDRESS` with `%{token}` (incoming_email.go:15,47-63) — MUST carry `%{token}` exactly once in the user part |
| `MAIL_INBOUND_SECRET` (secret) | unset (misconfigured no-op) | per-user `user.Rands` (token.go:66) — the §3.2 divergence |

Const, not config: the 10 MiB cap (upstream's `MaximumMessageSize`
DEFAULT, incoming_email.go:32 — Email Routing's 25 MiB hard cap makes a
larger value unreachable anyway; a var can be added when a deployment
asks). Not carried: the IMAP connection family (`HOST/PORT/USE_TLS/
SKIP_TLS_VERIFY/USERNAME/PASSWORD/MAILBOX/DELETE_HANDLED_MESSAGE`) —
transport-replaced (§3.1).

Arming = dashboard/zone work + config: an Email Routing rule (the reply
address's domain) delivering to this Worker + `MAIL_INBOUND_ENABLED=true`
+ a valid reply address + `wrangler secret put MAIL_INBOUND_SECRET`
(+ outbound armed for the notification mails to exist). Until the §9
HANDOFF fold, armed inbound receives and drops everything at the
no-token gate — arming inbound alone is SAFE (fail-closed end to end).

Secret rotation: `wrangler secret put MAIL_INBOUND_SECRET` invalidates
every outstanding token at the next decode (constant-time MAC mismatch) —
the runbook records this as the intended kill switch.

## 9. HANDOFF — the outbound token embedding (notify.ts owner)

`issueMailHeaders` (notify.ts, the "no-incoming-email arm" note) and the
compose sites gain, when `MAIL_INBOUND_ENABLED=true` (upstream `CanReply`,
mail_issue_common.go:181-202) — per RECIPIENT:

```ts
const token = createReplyToken(env.MAIL_INBOUND_SECRET!, {
  userId: recipient.id,
  refType: comment === undefined ? "issue" : "comment",
  refId: comment?.id ?? issue.id,
  now,
});
const replyAddress = replyAddressFor(env.MAIL_INBOUND_REPLY_ADDRESS!, token);
// row.replyTo = replyAddress; headers["List-Post"] = `<mailto:${replyAddress}>`;
// headers["References"] += `<reply-${token}@${appDomain}>`;
// List-Unsubscribe's mailto arm is the UNsubscribe token's follow-up.
```

`createReplyToken` + the validation helper are exported from
`services/mail/inbound.ts` for exactly this fold; the mint needs the
outbox row's `reply_to` column (landed, email-outbound §4.1) — no schema
work. Slice-one's tests pin the mint/verify round-trip at the library
level so the fold inherits verified primitives.

## 10. Testing plan (all service-level, workerd + real D1)

Harness: the notify.test.ts shape — `applyD1Migrations`, the recording
queue spy, explicit env slices; fake messages built from raw MIME strings
via a `streamOf()` helper (the `InboundEmailMessage` structural surface).

1. **Token arms** (`createReplyToken`/`decodeReplyToken`): the mint/verify
   round-trip (issue + comment refs); bit-flipped MAC → invalid; tampered
   userId/refId/expiry → invalid; expired (clock past the 1-year bound) →
   expired; unknown/deleted user, org-type user, prohibited user →
   invalid (the GetValidDoerUserByID parity); lowercase token decodes
   (RFC 5321 §2.4); the layout constants (52-char unpadded base32,
   version byte 0x01) pinned.
2. **Header search**: To-carried token (template prefix/suffix,
   display-name noise), Delivered-To arm, References
   `<reply-<token>@domain>` arm, case-insensitive extraction, no match →
   "" (plain address, wrong domain suffix, malformed msg-id).
3. **Automatic-reply arms**: `Auto-Submitted: auto-generated` (and any
   value ≠ "no"), `X-Autoreply: yes`, `X-Autorespond` present → dropped;
   `Auto-Submitted: no` → NOT auto (upstream :261's negative arm).
4. **MIME + trim**: multipart/alternative picks text/plain over html;
   base64 and quoted-printable decode (soft breaks); charset ladder
   (utf-8 / iso-8859-1 / unknown-label fallback); attachment parts
   skipped; html-only → empty; nesting/size bombs terminate bounded;
   `-- signature` cut, `On ... wrote:` attribution cut,
   `-------- Original Message --------` separator cut, forwarded-header
   block cut, trailing quoted-block drop, the whole-body-quoted survivor.
5. **The handler end to end**: valid reply → comment row (posterId =
   token user, content = trimmed body) + `email_inbound`
   `comment-created` + the NOTIFY FAN (outbox rows — the mail env seam
   round-trip, §6.11); redelivery of the same Message-ID →
   `dropped-duplicate`, no second comment; spoofed From + no/invalid
   token → `dropped-no-token`/`dropped-invalid-token`, no comment;
   auto-reply with a VALID token → `dropped-auto-reply` (order pin);
   disabled → ZERO rows (gate tripwire); missing secret / bad template →
   `dropped-misconfigured`; oversize → `rejected-oversize` + setReject
   spy; expired token → `dropped-expired-token`; permission arms —
   non-collaborator on a private repo and a locked issue without write →
   `dropped-permission`, a collaborator on the same locked issue →
   `comment-created`; empty extracted content → `dropped-empty`;
   token → deleted comment → `dropped-missing-ref`; no Message-ID →
   fallback-key dedupe still collapses.
6. **The mount**: tsc proves `email` satisfies `ExportedHandler<Env>`
   (§3.1's platform limit note).

Gate: the inbound suite green own-eyes (`pnpm test` on the file); the mail
family unregressed (own-eyes Tests lines); `tsc --noEmit` zero in the
touched files; eslint clean; `pnpm db:generate` produced migration 0054
containing ONLY the new table (sibling waves owned 0052/0053 in flight —
verified disjoint before generating).
