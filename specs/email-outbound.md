# SPEC: Outbound Email (the mailer service, transport decision, first trigger)

Status: **DESIGN + THREE VERTICAL SLICES** (gap-fill queue #8, 2026-10-31;
slice two — the mail notify hub + the issue-comment surface — and slice
three — the NewIssue + IssueChangeStatus arms — same day).
Upstream references are at the submodule pin `fc4936884584a41931906553d96c2601d750e6ef`.

Companion to `specs/user-notification-settings.md` (which stores the
notification preference switches and records "cf-gitea has no mailer ...
nothing sends mail today" — this SPEC is the delivery half that switches
that sentence off for the first surface).

---

## 1. Problem and scope

### 1.1 Problem

Upstream Gitea sends email on real product surfaces: issue/PR comment
notifications, password resets, account activation, registration
confirmations, release notices, repo-transfer requests. cf-gitea stores the
same preference switches (SPEC user-notification-settings) but never sends
anything: there is no mailer service at all.

The Workers platform makes upstream's transport impossible in kind, not in
degree: upstream's SMTP sender dials raw TCP (`net.Dial(network, address)`,
`gitea/services/mailer/sender/smtp.go:40`, plus `net/smtp` and TLS dialing
below it) and the sendmail sender execs a local binary. Workers cannot open
arbitrary outbound TCP sockets and cannot exec processes. This triggers the
AGENTS.md Upstream-Parity Decision Rule clause (b): the platform makes
upstream's shape impossible and multiple equally faithful adaptations exist
— hence this decision record before implementation.

### 1.2 In scope (this change)

- The **decision record** (this section + §3): transport choice with the
  alternatives evaluated and rejected with reasons.
- The **mailer service module** `apps/worker/src/services/mail/`:
  message shaping (the upstream `Message` struct port), the mail templates'
  render half for the first surface, the transport behind ONE interface
  (the storage-service-layer pattern — callers never see the provider), the
  D1 outbox queue + REPO_TASKS consumer arm.
- **One real trigger surface, end to end**: `POST /admin/users` with
  `send_notify: true` sends the upstream register-notify mail (the smallest
  real surface: single recipient, no watcher enumeration, upstream parity
  is a two-line gate in the admin handler).
- **Config surface**: `MAIL_*` vars in `wrangler.jsonc.example` (strict
  polarity, disabled by default) + the `MAIL_PROVIDER_API_KEY` secret name.

### 1.3 Out of scope (enumerated follow-ups, in upstream-surface order)

- The **mail notifier arm** — slice two landed its FIRST surface (§8): the
  notify hub (`services/mail/notify.ts`, the `CreateIssueComment` receiver's
  plain type-0 comment arm) over the full recipient resolution
  (`mailIssueCommentToParticipants`, mail_issue.go:28-120) and the
  `mail/repo/issue/default.tmpl` comment render. Slice THREE (same file,
  §9) lands the next two arms in upstream notify.go order — `NewIssue`
  (:53) and `IssueChangeStatus` (:59). Slice FOUR (same file, §10) lands
  the pull-create arm — `NewPullRequest` (:88-93), with the pulls-create
  route fold. Slice FIVE (same file, §11-§12) lands the next pair in
  upstream notify.go order — `IssueChangeTitle` (:80-90) and
  `IssueChangeAssignee` (:119-127, the assigned.tmpl family). STILL
  FOLLOW-UP, in upstream notify.go order:
  - `PullRequestReview` (:98-111) — STAGED: the write lives inline in
    `api/routes/pull-reviews.ts` (route-handler D1 writes; no review
    service layer exists to host the emit, and route-handler emits are
    against the method) — extracting the review-submission service is the
    exactly-what-is-missing;
  - `PullRequestCodeComment` (:113-117) — STAGED: its sole recipient
    source is mentions (`MailMentionsComment`) and the mention parser is
    not ported (§8.2);
  - `PullRequestReviewRequest` (:129-136) — STAGED with the review family
    (the same route-handler write site); its mail half is the landed
    `notifyIssueAssigneeChanged` shape with a review-request `ct`;
  - `MergePullRequest` (:138-146) — LANDED (§14): the winning-merge mail
    over the shared funnel, emitted from `api/services/pull-engine.ts`'s
    `mergePullRequest` D1 landing (upstream's `markAsMergedPostProcess`
    shape);
  - `AutoMergePullRequest` (:148-156) — STAGED, adjudicated UNREACHABLE:
    its upstream emit position is `markAsMergedPostProcess`'s
    `wasAutoMerged=true` branch (merge.go:404), and `wasAutoMerged` is
    only derivable from a `GetScheduledMergeByPullID` row (merge.go:
    825-831) — this backend NEVER schedules one (no scheduled-merge store
    exists; POST …/merge refuses `merge_when_checks_succeed` with the
    declared 409, api/routes/pulls.ts:1544-1547). The arm's ONLY
    differences from the landed merge arm are the ActionAutoMergePullRequest
    constant (the SAME "merge" template name, mail_issue_common.go:
    235-236), the same `/merge/` Message-ID extra (:296-297) and
    `ForceDoerNotification` (mail_issue.go:191 — the merger receives
    their own merge mail, bypassing the :94-97 doer exclusion). When a
    scheduled-merge store lands, the emit flips on `wasAutoMerged` and
    `resolveIssueMailRecipients` gains the force-doer flag;
  - the `/assignees` trio's `AddAssignees`/`RemoveAssignees` notify arms
    (upstream assignee.go:242/:281) — LANDED (§14.5): the trio's
    issue-tables-t2 handlers fan the landed `notifyIssueAssigneeChanged`
    receiver beside their webhook emitter, per actually-changed assignee,
    with the toggle's type-9 comment read back by its own key set;
  - mentions — LANDED (SPEC §13): `services/mentions/` (the parser + the
    visibility resolution) with the `mentions` parameter threaded through
    the hub arms and the comment/issue/PR-create emit sites; the
    `onmention` preference reaches its upstream source. The
    `issue_user.is_mentioned` carrier LANDED too (§13.2 — migration 0057,
    the emit-position persistence + the two read arms); what remains is
    the issue-view mark-read write (`UpdateIssueUserByRead`) and the
    issue-indexer/repo-search mention reads, both STAGED with the
    surfaces they ride (§13.4);
  - `MailMentionsComment` (code-comment mentions, mail_comment.go:42-62) —
    the parser half is now landed; the arm itself still rides the review
    service extraction (the STAGED family above).
- `SendActivateAccountMail` (upstream `mail_user.go:52`) + the
  `REGISTER_EMAIL_CONFIRM` flow: needs an activation-code store and the
  `/user/activate` web arm.
- `SendResetPasswordMail` (upstream `mail_user.go:62`) + the
  `/user/recover_account` web arm: needs the password store this repo
  deliberately lacks (SPEC-0002 §4.6.7, PAT-only auth) — blocked until that
  posture changes.
- `SendActivateEmailMail` (upstream `mail_user.go:73`): needs the
  `email_address` table (we store one primary email on `users`).
- Release mail (`mail_release.go`), repo-transfer mail (`mail_repo.go`),
  team-invite mail (`mail_team_invite.go`), Actions run-status mail
  (`mail_workflow_run.go`).
- Admin "send test mail" surface (upstream `mail.go:41-47` SendTestMail).
- Bounce/COMPLAINT ingestion (§5.4 keeps the posture; the webhook endpoint
  is a follow-up).
- A stranded-`pending` re-drive sweep (§4.5 records the known gap; the
  webhook-delivery sweep precedent is the model).
- The UI write paths (src/ui/**) and the push-webhook close paths
  (services/webhooks-push.ts) construct bare `IssuesService(...)` — their
  notify arms stay OFF until their owners pass the notify env (the same
  one-line hop as §9.4; outside this unit's file ownership).

---

## 2. Upstream source of truth (verified at the pin)

### 2.1 The message struct

- `gitea/services/mailer/sender/message.go:23-34` — `Message`:
  `Info` (log purpose), `FromAddress`, `FromDisplayName`, `To` ("Use only
  one recipient to prevent leaking of addresses"), `ReplyTo`, `Subject`,
  `Date`, `Body` (HTML), `Headers map[string][]string`, `Embeds`.
- `message.go:44-89` (`ToMessage`): From/To address headers; `Reply-To`
  only when set; the configured `SubjectPrefix` prepended
  (`message.go:56-60`); a `Date` header; `X-Auto-Response-Suppress: All`
  (auto-reply suppression, `message.go:62`); text/plain derived from the
  HTML (`html2text`, `message.go:64`) plus text/html alternative;
  auto-generated `Message-ID` when absent.
- `message.go:96-105` (`generateAutoMessageID`):
  `<autogen-<unixMilli>-<fnv64(to+subject+body) hex>@<AppDomain>>`.
- `message.go:108-125` (`NewMessageFrom`/`NewMessage`): default From =
  `setting.MailService.FromName/FromEmail`.
- Subject sanitize: `gitea/services/mailer/mail.go:32,49-56` — collapse
  whitespace runs to one space, trim, clamp to 256 runes
  (`mailMaxSubjectRunes`), MIME Q-encode.
- Metadata headers the notify family attaches:
  `mail.go:180-208` (`List-ID`, `List-Archive`, `X-Mailer: Gitea`,
  `X-Gitea-Repository*`, `X-Gitea-Sender/Recipient*` + the `X-GitHub-*`
  twins), `mail.go:210-216` (`X-Gitea-Reason`).

### 2.2 The sender abstraction (the seam we port)

- `gitea/services/mailer/sender/sender.go:11-13` — `Sender` interface:
  `Send(from string, to []string, msg io.WriterTo) error`;
  `sender.go:17-31` — one From, no-From = error.
- Transport selection by protocol: `gitea/services/mailer/mailer.go:37-44`
  — `sendmail` → SendmailSender, `dummy` → DummySender, default →
  SMTPSender. The DummySender (`sender/dummy.go:15-23`) renders the message
  and logs it, returning success — the no-op arm.
- The SMTP transport is the impossible one: `sender/smtp.go:27-60` dials
  `tcp`/`unix` (`net.Dial`, :40) and TLS-wraps.

### 2.3 The queue (upstream queues mail too)

- `gitea/services/mailer/mailer.go:19` — `mailQueue
  *queue.WorkerPoolQueue[*sender_service.Message]`; `mailer.go:48-63` —
  the queue handler sends each message and LOGS failures, returning nil
  (failed sends are terminal: logged, not retried); `mailer.go:66-80` —
  `SendAsync` pushes to the queue.

### 2.4 Config surface

- `gitea/modules/setting/mailer.go:20-57` — the `Mailer` struct: `NAME`,
  `FROM`, `ENVELOPE_FROM`, `SEND_AS_PLAIN_TEXT`, `SUBJECT_PREFIX`
  (:22-29); SMTP fields `PROTOCOL/SMTP_ADDR/SMTP_PORT/USER/PASSWD`
  (:36-46); `PROTOCOL` ∈ {smtp, smtps, smtp+starttls, smtp+unix,
  sendmail, dummy} (:102).
- The master gate: `mailer.go:72` — `ENABLED` must be true or
  `MailService` stays nil (every sender then no-ops: `mail.go:42-45`,
  `mail_user.go:53-56`).
- FROM parsing: `mailer.go:180-189` — `mail.ParseAddress` splits
  display name and address.
- Notify-mail arm gate: `mailer.go:33-35` (registration of the mail
  notifier needs `[service] ENABLE_NOTIFY_MAIL`, `mailer.go:227-235`) —
  note the register-notify mail does NOT ride this gate: upstream fires it
  from the admin handlers with only `MailService != nil` +
  `form.SendNotify` (below).

### 2.5 The trigger this slice ports

- `gitea/routers/api/v1/admin/user.go:153-156` — after
  `AdminCreateUser` succeeds:
  `if form.SendNotify { mailer.SendRegisterNotifyMail(u) }`
  (`CreateUserOption.SendNotify`,
  `gitea/modules/structs/admin_user.go:27`); the web admin twin is
  `gitea/routers/web/admin/users.go:262`.
- `gitea/services/mailer/mail_user.go:102-127` — `SendRegisterNotifyMail`:
  gate `setting.MailService == nil || !u.IsMailable()`
  (`IsMailable` = `u.ID > 0 && u.IsActive && u.IsIndividual()`,
  `models/user/user.go:538-540`); renders
  `mail/user/auth/register_notify` with `DisplayName`/`Username` + locale;
  subject `locale.TrString("mail.register_notify", AppName)`;
  `NewMessage(u.EmailTo(), subject, content)`; `SendAsync`.
- `EmailTo` (`models/user/user.go:450-465`): `"<Display> <email>"` with
  the display name sanitized/Q-encoded, falling back to the bare address.
- Template: `gitea/templates/mail/user/auth/register_notify.tmpl` over
  `templates/mail/base/head.tmpl`/`footer.tmpl` (title, three locale
  paragraphs, `user/login` + `user/forgot_password` links, AppUrl footer).
- Locale strings (`gitea/options/locale/locale_en-US.json`):
  `mail.register_notify.title` = `%[1]s, welcome to %[2]s`;
  `.text_1` = "This is your registration confirmation email for %s!";
  `.text_2` = "You can now log in via username: %s.";
  `.text_3` = "If this account has been created for you, please <a
  href=\"%s\">set your password</a> first."; plus `mail.hi_user_x` =
  "Hi <b>%s</b>," and `mail.link_not_working_do_paste`.
- Address validation: `modules/validation/helpers.go:118-138`
  (`IsEmailAddressValid` over `net/mail.ParseAddress`); our web-facing port
  already exists — `services/user-accounts.ts:139-149` `invalidEmailMessage`
  (shared by admin-t2), so the trigger needs no new validation.

### 2.6 The notify seam upstream rides (mapped, not wired here)

- `gitea/services/notify/notifier.go:16-…` — the `Notifier` interface
  (40+ event arms); `services/notify/null.go` NullNotifier base;
  registration via `notify_service.RegisterNotifier` (the mail notifier at
  `services/mailer/mailer.go:33-35`). Our tree has no central notifier
  service yet; issue writes fan out through `services/issue-events.ts`
  (webhook + activity-feed seam) — the mail arm will ride that seam when
  the notification follow-up lands (§1.3).

---

## 3. DECISION RECORD — the transport

### 3.1 Candidates

**(a) HTTP relay API (Resend/Postmark/SendGrid-style).** The Worker
`fetch`es a JSON POST to the provider; the API key is a wrangler secret.
Upside: fully upstream-shaped — it is just another `Sender` implementation
behind the exact interface upstream already abstracts
(§2.2); no platform constraint applies (HTTPS fetch, run inside a queue
consumer with its 15-min wall); providers handle DKIM/SPF/reputation/
bounce webhooks. Downside: third-party dependency + a secret to provision.

**(b) Cloudflare `send_email` binding (Email Routing).** The binding EXISTS
in our wrangler's schema — verified in
`node_modules/.pnpm/wrangler@4.153.0_*/node_modules/wrangler/config-schema.json`
(`send_email` array with `name`, `destination_address`,
`allowed_destination_addresses`, `allowed_sender_addresses`). REJECTED as
the primary transport: every recipient address must be pre-declared in
wrangler config (`allowed_destination_addresses`/`destination_address`)
and verified under Email Routing on the zone. A Gitea mailer's whole job
is sending to ARBITRARY user-registered addresses — a config-declared
allow-list cannot express upstream's shape (any of
`routers/api/v1/admin/user.go:155`'s fresh user emails). Documented
possible future niche: a self-hosted closed instance that wants
admin-only mail to one verified address; not a general mailer.

**(c) Queue-deferred sends.** Not actually an alternative to (a)/(b) — it
is the delivery TIMING, and upstream itself queues mail
(`mailer.go:19,48-63`, §2.3). A synchronous send in the request would
diverge from upstream (which never blocks the request on SMTP) and couple
the 201 to a third-party's latency. CHOSEN as the delivery mechanism for
whatever transport: an awaited D1 insert + one queue message at the
trigger, the HTTP send in the consumer. `ctx.waitUntil` is explicitly NOT
used (AGENTS.md: it extends only 30 s past the response — sub-second
tasks only; a relay call is not that).

### 3.2 Decision

**Transport = (a) HTTP relay, delivery = (c) the existing REPO_TASKS
queue, provider behind ONE `MailTransport` interface.**

- Upstream parity: the `Sender` interface port — the provider is to us
  what `SMTPSender`/`SendmailSender`/`DummySender` are to upstream
  (`mailer.go:37-44`); callers (the outbox consumer) never see it.
- Concrete providers in this slice: `resend` (the real arm — POST
  `https://api.resend.com/emails`, `Authorization: Bearer
  MAIL_PROVIDER_API_KEY`) and `dummy` (upstream's
  `mailer.go:40-41`/`dummy.go` parity: renders, logs, succeeds — the
  default and the test arm). Adding `postmark`/`sendgrid` later is one
  file (transport.ts) and no caller change.
- The queue is the EXISTING `repo-tasks` physical queue with a new typed
  arm `{kind: "mail-outbox", mailId}` in `handleRepoTasks`
  (`src/repos/purge.ts`) — the mirror-sync/demo-sweep/audit-retention arm
  pattern exactly. No new queue binding, no `index.ts` edit (shared file;
  the existing serialized consumer with `max_batch_size=1,
  max_concurrency=1, max_retries=5` fits a one-HTTP-call arm).
- The message carries `{mailId}` only; the payload lives in the D1
  outbox row — the SPEC-0005 §3.6 webhook-delivery design ("retries
  always read fresh state; the delivery log is complete regardless of
  queue state").

### 3.3 Retry posture — the one deliberate divergence

Upstream's mail queue is terminal-on-failure: log the error, move on
(`mailer.go:52-58` returns nil). We keep terminal for PERMANENT failures
(provider 4xx: invalid address, unverified domain, schema rejection) —
record `status='failed'` + `last_error`, ack. TRANSIENT failures (fetch
throw, HTTP 429/5xx) throw out of the consumer arm so the queue's native
retry applies (bounded by `max_retries: 5`, then `repo-tasks-dlq`).
Rationale: a throw is the ONLY retry mechanism the platform gives a queue
consumer; upstream's own log-and-drop would burn a mail on one provider
blip. The terminal posture stays upstream's (bounded, logged, visible in
the row); only the "one provider hiccup kills the mail" edge changes.
Documented here as the SPEC's divergence ledger entry.

---

## 4. Data model

### 4.1 The `email_outbox` table (D1, migration 0049)

```
email_outbox:
  id                 integer PK AUTOINCREMENT
  info               text NOT NULL            -- upstream Message.Info (log purpose)
  from_address       text NOT NULL            -- upstream FromAddress
  from_display_name  text NOT NULL DEFAULT '' -- upstream FromDisplayName
  to_addr            text NOT NULL            -- ONE recipient (upstream's leak prevention, §2.1)
  reply_to           text                     -- upstream ReplyTo; NULL = header omitted
  subject            text NOT NULL            -- stored UNSANITIZED; sanitized at send (§4.2)
  body_html          text NOT NULL            -- upstream Body
  headers            text                     -- JSON Record<string,string> (§4.4 note)
  status             text NOT NULL DEFAULT 'pending'
                     -- 'pending' | 'sending' | 'sent' | 'failed'
  attempts           integer NOT NULL DEFAULT 0
  last_error         text
  dedupe_key         text                     -- UNIQUE (nullable); trigger-level idempotency
  created_at         integer NOT NULL         -- unix seconds
  sent_at            integer                  -- unix seconds; set on 'sent'
CREATE UNIQUE INDEX email_outbox_dedupe_key_uq ON email_outbox (dedupe_key)
```

Nullable-unique `dedupe_key`: SQLite permits many NULLs, so un-deduped
mail coexists with deduped triggers. The register-notify trigger dedupes
on `register-notify:<userId>` — the user id is never reused, so a
re-driven trigger (client retry after a timeout) cannot double-send; a
second row insert with the same key dies on the arbiter and the helper
treats the existing row as the winner (idempotent no-op).

### 4.2 Shaping happens at CONSUME time

The row stores the shaped-but-unsanitized message; the consumer applies
the upstream send-time transforms (subject sanitize + prefix, Date,
Message-ID, `X-Auto-Response-Suppress`, plain-text derivation) — the
`ToMessage()` split (`message.go:44-89`). Benefits: config
(`MAIL_SUBJECT_PREFIX`) is read at send time; retries re-shape; the row
stays the human-readable record.

### 4.3 The consumers' claim (idempotent redelivery)

`pending → sending` CAS on `status` (the webhook-delivery
`pending → delivering` arm, `src/webhooks/consumer.ts:379-385`): 0 rows
⇒ someone else handled this id ⇒ ack no-op. A consumer crash mid-send
leaves `sending`; the row is stuck-terminal for this slice (documented
in §5.3) — the same stuck-state posture the webhook consumer's DLQ sweep
exists to clean, queued as the §1.3 re-drive follow-up.

### 4.4 Headers storage

Upstream `Message.Headers` is `map[string][]string`; every header the
notify family actually sets (§2.1) is single-valued per message. The row
stores `Record<string, string>` (the relay APIs are single-value too);
a future multi-value need adds a JSON-array convention to this column,
documented here first.

### 4.5 Producer posture (the issue-events precedent)

The trigger inserts the row (awaited, cheap) and enqueues best-effort:
the queue `send` failure is caught and logged, the row stays `pending`
— the durable source of truth; a later enqueue is a safe replay (the
CAS absorbs it). Known gap (recorded): nothing re-enqueues a stranded
`pending` row whose send failed before the message left — the §1.3
sweep follow-up (webhook-delivery's sweep is the model).

---

## 5. Edge cases, limits, failure modes

### 5.1 Disabled posture (the default, fail-closed)

`MAIL_ENABLED != "true"` ⇒ the trigger is a no-op (upstream
`MailService == nil` parity, `mail_user.go:53-56`): no row, no message,
the 201 unchanged. Unset/garbage = OFF (the DEMO_MODE/ACTIONS_*
strict-polarity convention; a self-hosted deployment NEVER sends mail by
accident — same guarantee class as the demo sweep's §2 invariant).
Enabling requires: `MAIL_ENABLED=true`, `MAIL_FROM`, and (for the real
arm) `MAIL_PROVIDER=resend` + `wrangler secret put
MAIL_PROVIDER_API_KEY`.

### 5.2 Malformed config at trigger time

`MAIL_ENABLED=true` with an unparseable `MAIL_FROM` (no address part) ⇒
the trigger logs and skips (the row is never created). This is a config
error, not a runtime error — it must not fail the admin 201 (upstream
 Fatal's at boot instead, `mailer.go:183-184`; we have no boot step, so
the skip is the honest adaptation, logged at warn).

### 5.3 Consumer failure modes

- Provider 4xx ⇒ `failed` + `last_error` (body excerpt capped 1 KiB), ack.
- 429/5xx/network ⇒ throw ⇒ queue retry (max 5) ⇒ DLQ; `attempts` +
  `last_error` recorded per attempt.
- Row missing at consume (purged) ⇒ ack no-op (webhook
  `hook-missing` parity).
- Crash between claim and outcome ⇒ stuck `sending` (§4.3, follow-up).

### 5.4 Rate limits and bounce posture

- Rate limits: the provider's 429 rides the transient-retry path (§3.3);
  the serialized consumer (one in-flight message) keeps us far below any
  provider's documented ingress rate at this product's scale.
- Bounces: SMTP-level bounces are invisible to the relay model (the
  provider owns the SMTP leg). Resend exposes delivery/bounce webhooks —
  the ingestion endpoint is a §1.3 follow-up; until then a bounced
  address just fails silently at the provider, exactly like upstream's
  SMTP send-and-forget (`mailer.go` records nothing per-recipient either).
- Suppression: upstream `X-Auto-Response-Suppress: All` is always set
  (§4.2) so auto-responders don't loop.

### 5.5 Address validation

Format validation is the EXISTING admin ladder's (`invalidEmailMessage`,
admin-t2/user-accounts §2.5) — the trigger only ever mails a
already-validated address. The consumer does NOT re-validate (upstream
doesn't either; the provider 4xx is the report).

### 5.6 Plain-text alternative and header encodings

Upstream derives text/plain from the HTML (`html2text`,
`message.go:64-74`). Porting a full html2text is out of scope; the
transport emits a deterministic reduction (tags stripped, entities
decoded, whitespace collapsed) documented as a divergence — the HTML
alternative stays byte-faithful, which is what upstream's templates
actually author. `SEND_AS_PLAIN_TEXT` is not carried (no config consumer
for it in this slice). For the same wire-format reason, the MIME
Q-encoding halves of `sanitizeSubject` (mail.go:55) and `EmailTo`
(user.go:450-465) are NOT applied — a relay transport carries UTF-8 JSON
end to end, where Q-encoding would surface as literal `=?utf-8?…?=` text
at the recipient; the header-injection `emailToReplacer` strip
(user.go:587-596) IS applied.

### 5.7 As-built resolutions (recorded at implementation, same change)

- `resend` without its secret fails the send with a **permanent** error
  naming the missing config (`resolveTransport`) — the per-row analogue of
  upstream's boot-time Fatal on a malformed mailer section
  (mailer.go:183-184); the row shows `failed` + the config message.
- The consumer's claim is `status IN ('pending','sending') AND attempts <
  5` — the `'sending'` arm is crash recovery (a consumer that died
  mid-send leaves the row claimable), bounded by the same 5-attempt
  budget as the repo-tasks `max_retries`; a claim that finds only an
  exhausted `'sending'` row settles it `failed`
  ("attempt budget exhausted") inline, so no row ever shows a perpetual
  in-flight state.
- `APP_URL` unset/unparseable degrades the Message-ID domain to
  `localhost` (the var is declared in the example config, so real
  deployments carry a host); the register-notify render normalizes
  `APP_URL` to trailing-slash form (upstream `AppUrl` always carries the
  trailing slash — the templates concatenate `AppUrl + "user/login"`).

---

## 8. SLICE TWO AS-BUILT — the notify hub + the issue-comment surface

### 8.1 The pin's notify map (what slice two ports)

- The receiver: `services/mailer/notify.go` — `mailNotifier` implements the
  40+ arm `Notifier` interface (`services/notify/notifier.go:21-92`). The
  FIRST arm in file order is `CreateIssueComment` (notify.go:31-51): a
  type-0 comment maps to `ActionCommentIssue` (:40-43 — regardless of
  IsPull) and fires `MailParticipantsComment` (`mail_comment.go:19-40`,
  doer = `Comment.Poster`). Downstream both funnel into the shared
  `mailIssueCommentToParticipants` (mail_issue.go:28-120) and
  `composeIssueCommentMessages` (mail_issue_common.go:47-215) — the exact
  middle our hub ports, so the remaining arms are additive wrappers.
- Template resolution: `actionToTemplate` (mail_issue_common.go:219-278)
  maps ActionCommentIssue → name "comment" → template
  `mail/repo/issue/comment`, which does NOT exist upstream either — the
  stock fallback chain lands on `mail/repo/issue/default.tmpl`. The subject
  half of default.tmpl is EMPTY (no `---` split, modules/templates/
  mail.go:119-163) so the subject is `util.IfZero(subject, fallback)` —
  the fallback `fallbackIssueMailSubject` (`[owner/repo] Title (#Index)`,
  mail_issue_common.go:34-36) prefixed `Re: ` because `actName != "new"`
  (:88-91). Upstream's own test pins it: `Re: [user2/repo1] issue1 (#1)`
  (services/mailer/mail_test.go:312,353).
- Message identity: `generateMessageIDForIssue` (mail_issue_common.go:
  280-305) — `<owner/repo/issues|pulls/#index[/comment/<id>]@AppDomain>`;
  In-Reply-To/References = the thread root (comment nil, action 0).
  Verified against mail_test.go:130-133.
- Headers: `generateAdditionalHeadersForIssue` (mail_issue_common.go:
  307-321) over `generateMetadataHeaders` (mail.go:180-198: List-ID
  `owner/repo <repo.owner.domain>`, List-Archive, X-Mailer, X-Gitea-
  Repository*, X-GitLab-Project*), `generateSenderRecipientHeaders`
  (mail.go:200-208, per-recipient — the reason one row per recipient is
  load-bearing) and `generateReasonHeaders` (mail.go:210-216; reason =
  "issue"|"pull" by IsPull, mail_issue_common.go:207 passes actType).
- Recipient sources (mail_issue.go:43-76, upstream order): poster,
  assignees (`GetAssigneeIDsByIssue`), participants
  (`GetParticipantsIDsByIssueID`, models/issues/issue.go:620-627 — DISTINCT
  poster over comment types 0/21/22), issue watchers
  (`GetIssueWatchersIDs(issueID, true)`), repo watchers
  (`GetRepoWatchersIDs` — prepended ahead of the accumulated slice,
  mail_issue.go:76). Exclusions: ignorers (:87-92), the doer unless
  `EmailNotificationsAndYourOwn` (:94-97), mentions batch first (:99-102),
  explicit issue unwatchers (:104-109), then `GetMailableUsersByIDs`
  (models/user/user.go — individual, !prohibit_login, is_active,
  preference ∈ enabled/andyourown) and the per-recipient batch filter
  (`IsMailable`, the preference gate with the mention/custom allowance,
  the visited dedupe, `CheckRepoUnitUser` — models/perm/access/
  repo_permission.go:660-672 — admin ⇢ true, public reads to everyone,
  private needs a grant).
- The WIP gate: repo watchers are dropped when `issue.IsPull &&
  PullRequest.IsWorkInProgress` (mail_issue.go:70 — IsWorkInProgress IS the
  title-prefix check, models/issues/pull.go; a comment arm's action is
  never ActionCreatePullRequest so upstream's third clause holds).

### 8.2 The recipient-model inventory verdict (what exists vs the reduction)

Our schema carries the FULL core recipient model — no table was invented:

- `issues.posterId`, `issue_assignees`, `issue_subscriptions`
  (is_watching both arms — the explicit-unwatch exclusion works),
  `repo_watchers`, `comments.posterId` (the participants source), the
  typed `user_settings.email_notifications_preference` (upstream's exact
  enum; an ABSENT row IS upstream's 'enabled' default, admin.go:32 — the
  LEFT JOIN + default mirrors upstream's users-column read, the SPEC
  user-notification-settings collapse) and `users` (status/type/email/
  is_admin/full_name).
- The grant predicate for the private-repo arm of CheckRepoUnitUser is the
  landed single predicate `doerRepoAccessMode` (the repo_permission.go:
  448-508 fold per its header); the unit-ENABLED half reads the landed
  `repo_settings`/`repo_units` flags via `loadRepoSettings`.

The documented REDUCTIONS (schema-absent upstream pieces, none invented):

1. **Repo-watch modes**: CLOSED (was the slice-two reduction "every watcher
   receives issue AND pull mail, no ignorers, no custom watchers"). The
   `repo_watchers` table now carries the full `Watch` mode model
   (models/repo/watch.go:17-50, migration 0053): `mode` (None=0 /
   Normal=1 / Dont=2 / Auto=3 / Custom=4 — `SMALLINT NOT NULL DEFAULT 1`
   verbatim; None is never persisted, an absent row IS None via the
   GetWatch dummy) plus the three `include_{pull_requests,issues,releases}`
   flags (`NOT NULL DEFAULT true` verbatim — Custom is LIVE at the pin
   with this per-type granularity, not a 1.23-era placeholder). The mail
   arms read them exactly upstream: the watcher source gates on
   `mode <> Dont AND include_<pull_requests|issues>` by IsPull
   (GetRepoWatchersIDs, watch.go:253-258/266-292), the custom-watch set
   (`mode = Custom OR any include false`, GetRepoCustomWatchersIDs
   :260-264) drives the onmention allowance of the batch filter
   (mail_issue.go:141-146; GetMailableUsersByIDs' isMention prefilter arm,
   user.go:1157-1179, folded with it), and ignorers (`mode = Dont`) join
   `visited` ahead of every source including mentions (GetRepoIgnorersIDs,
   mail_issue.go:87-92) — always, WIP gate included. The transition model
   (watchRepoByMode, watch.go:114-156: same-mode no-op, Auto-only-from-
   None, the include reset when starting to watch, insert/update/delete by
   mode, the flipping-only `num_watches` delta) lives in
   services/repo-watchers.ts with the WatchRepoAuto API arms; the Custom
   and ignore SETTERS are web-form surfaces (POST /action/watch|participate
   |ignore and /action/watch/options, routers/web/repo/watch.go) whose
   routes ride the UI window — the store primitive
   (`watchRepoWithOptions`) is landed. WatchInfo's `ignored` field stays
   the upstream-literal hardcoded false (routers/api/v1/user/watch.go
   renders it from the constant, not the mode).
2. **Mentions**: CLOSED (was "no mention parser — the mentions batch
   (mail_issue.go:99-102) is unported, so `fromMention` is always false").
   The parser + visibility resolution landed in `services/mentions/` and
   every batch arm carries a `mentions` parameter — §13 has the as-built.
   Still schema-absent (HANDOFF, not a mail reduction): the
   `issue_user.is_mentioned` persistence carrier (issue_update.go:567 —
   upstream's mention writes go to `issue_user`, NEVER `issue_watch`, so no
   subscription row is written here either).
3. **`emoji.ReplaceAliases`** on the subject (mail_issue_common.go:133):
   no alias table ported — the fallback subject carries the title verbatim.
4. **Incoming-email header arms**: Reply-To/List-Post and the mailto
   tokens in References/List-Unsubscribe ride `IncomingEmail` (mail_issue_
   common.go:181-202, `CanReply`) — not landed; the lists carry the URL
   arm only.
5. The comment body renders through the shared markdown service's
   "comment" mode with absolute links (upstream renderhelper
   NewRenderContextRepoComment + WithUseAbsoluteLink(true)) — the
   SPEC-0008 §3.4 markdown-it posture.

### 8.3 The hub's shape and the emit site

- `services/mail/notify.ts` carries the notify-event vocabulary
  (`MailNotifyEvent` — upstream's Notifier method names) and ONE enqueue
  entry, `notifyIssueComment(env, {issue, comment, doer})`: gate (§5.1)
  → MAIL_FROM parse (§5.2) → repo pair → recipient resolution (§8.1/8.2)
  → compose → one `enqueueMailOutbox` per recipient. Dedupe keys are
  `issue-comment:<commentId>:<recipientUserId>` — the same trigger-level
  idempotency discipline as slice one's `register-notify:<userId>` (a
  re-driven emit re-inserts nothing; the arbiter settles the winner).
  One row per recipient IS upstream's leak prevention
  (mail_issue_common.go:143,164-212 — independent Messages); upstream's
  100-batch `SendAsync` grouping is a queue-feed optimization ours doesn't
  need (each row carries its own queue message).
- The emit site is the REAL write path: `IssuesService.addComment`
  (src/issues/service.ts) — upstream fires notify from the model layer
  too (services/issues/comments.go → services/notify), never the router.
  The service takes an OPTIONAL second constructor argument (the notify
  env); every existing construction site (`new IssuesService(c.env.DB)`,
  20+ sites) is untouched and the arm stays OFF there — the same
  fail-closed posture as `MAIL_ENABLED != "true"`. Failures are caught and
  logged (upstream logs at the receiver, notify.go:48-50); the write stays
  committed. The plain type-0 guard scopes the arm: close/reopen system
  comments ride `transitionClosed` (the IssueChangeStatus surface),
  code/review/push comments their own arms (§1.3).

### 8.4 HANDOFF — the API route wiring (one line, routes-owner)

`api/routes/issues.ts`'s `issueCreateComment` handler still constructs
`IssuesService(c.env.DB)` — the HTTP path's notify arm is OFF until the
route passes the notify source. The proposed wiring (routes-owner to fold
into a landing window; no other line changes):

```ts
const service = new IssuesService(c.env.DB, c.env); // was: new IssuesService(c.env.DB)
```

(`c.env` satisfies `MailNotifyEnv` structurally — DB + the four MAIL_*/
APP_URL vars it reads; the arm no-ops unless `MAIL_ENABLED === "true"`.)
The service-level vertical (write → outbox rows → consumer → sent) is
proven green in src/services/mail/notify.test.ts; the route pass-through
adds no logic, only the env hop. The UI session path (src/ui/**, not
ours) carries the same one-line option when its comment posting lands.

### 8.5 As-built details (recorded at implementation, same change)

- The recipient ORDER is upstream's list order (repo watchers prepended
  first, then poster, assignees, participants, issue watchers), deduped by
  first occurrence — upstream's container.Set at mail_issue.go:85.
- The mail URL join: `Issue.HTMLURL` = `Repo.HTMLURL()` + "/issues|pulls/"
  + index (issue.go:386-394) — our origin arrives in AppUrl's
  trailing-slash form and the join absorbs it (`origin + owner/...`,
  no double slash); the comment anchor is `#issuecomment-<id>`
  (CommentHashTag, models/issues/comment.go:554-556).
- `msg.Info` = `"Subject: <sanitized>, issue comments"` — the batch info
  string is "issue comments" (mail_issue.go:159) inside upstream's
  `"Subject: %s, %s"` (mail_issue_common.go:173).
- The From display name: `fromDisplayName(doer)`'s default template
  (mail.go:157-175) — `FullName (username)` when a full name is set, else
  the username; distinct from the recipient-side `EmailTo` shape.
- The head title slot carries the SANITIZED subject (upstream sets
  `mailMeta["Subject"]` post-sanitize, mail_issue_common.go:135) while the
  row stores the raw one (§4.2) — sanitize is idempotent at consume.

---

## 9. SLICE THREE AS-BUILT — the NewIssue + IssueChangeStatus arms

### 9.1 The pin's two-arm chain map (verified at fc493688)

Both arms funnel into the SAME middle slice two ports — no new resolution
or compose core:

- `NewIssue` (services/mailer/notify.go:53-58):
  `MailParticipants(ctx, issue, issue.Poster, ActionCreateIssue, mentions)`
  — the doer is the POSTER; mentions ride the §8.2 reduction (no parser,
  passed nil-shaped).
- `IssueChangeStatus` (notify.go:59-76): the IsPull branch picks
  `ActionClosePullRequest`/`ActionReopenPullRequest` vs
  `ActionCloseIssue`/`ActionReopenIssue`, then
  `MailParticipants(ctx, issue, doer, actionType, nil)` — doer = the
  actor. This is the closed/reopened family, NOT a
  `MailIssueClearComment` chain: no such function exists at the pin (the
  pin's mailer has only `MailParticipants` and `MailParticipantsComment`).
- `MailParticipants` (mail_issue.go:173-202) builds a `mailComment` with
  `Comment: nil` and `Content = issue.Content` — EMPTIED to `""` for the
  close/reopen/merge ops (:180-185) — then
  `mailIssueCommentToParticipants` (the shared recipient resolution) and
  `composeIssueCommentMessages` with the batch info string
  "issue comments" (mail_issue.go:161).
- Template resolution: `actionToTemplate` (mail_issue_common.go:227-246)
  names the arms "new"/"close"/"reopen"; no
  `mail/repo/issue/new|close|reopen` template exists at the pin (only
  assigned + default in `templates/mail/repo/issue/`, and no
  `mail/repo/pull/` at all), so EVERY arm renders default.tmpl — the same
  file the comment arm pinned, through its `.ActionName` branches.
- default.tmpl has NO subject section (the §8.1 `---` absence), so the
  subjects are the fallback with the :88-91 prefix rule:
  `[owner/repo] Title (#Index)` for "new" (NO "Re: " — the new mail is
  the thread root), `Re: [owner/repo] Title (#Index)` for close/reopen.
  Upstream's own mail_test.go pins the close subject
  (`Re: [user2/repo1] issue1 (#1)`, :312) and — for "new" under a MOCKED
  subject template (:220-240) — the Message-ID/In-Reply-To/References
  TRIPLE-COINCIDENCE on the plain thread id.
- Message-ID extras (mail_issue_common.go:285-294): ActionCreateIssue has
  NO extra (the plain `<owner/repo/issues|pulls/#idx@domain>`,
  mail_test.go:407-418 "Open Issue"/"Open Pull"); close carries
  `/close/<unixMilli>` and reopen `/reopen/<unixMilli>`
  (mail_test.go:446/:462 pin exactly the prefixes). In-Reply-To/References
  stay the PLAIN thread id for every arm (the reference is generated with
  `ActionType(0)`, :165).
- The body locale lines (`options/locale/locale_en-US.json`,
  interpolated by default.tmpl with `.Doer.DisplayNameWithFullName`):
  `mail.issue.action.new` = `<b>%[1]s</b> created #%[2]d.`,
  `.close` = `<b>%[1]s</b> closed #%[2]d.`, `.reopen` =
  `<b>%[1]s</b> reopened #%[2]d.` — shown for close/reopen ALWAYS (their
  first action chain; the body is guaranteed empty), and for "new" only
  when the RENDERED body is empty (the nested
  `{{if eq .ActionName "new"}}`; the `eq .Body ""` check keys on the
  rendered value).
- The body display name is `User.DisplayNameWithFullName`
  (models/user/user.go:495-501) = `username (FullName)` — USERNAME first,
  the Sprintf argument order — DISTINCT from mail.go's `fromDisplayName`
  (the From header, `FullName (username)` first; both pinned).

### 9.2 The arms as-built (services/mail/notify.ts + templates.ts)

- `notifyIssueCreated(env, {issue, doer})` and
  `notifyIssueStatusChanged(env, {issue, doer, isClosed})` are thin
  wrappers over the shared `notifyIssueArm` compose (the comment-nil slice
  of `composeIssueCommentMessages`) — the same gate → MAIL_FROM parse →
  repo pair → `resolveIssueMailRecipients` → outbox shape as
  `notifyIssueComment`, with the shared prelude factored into
  `mailArmPrelude` (byte-identical log messages for the comment arm).
- Per-arm differences, all §9.1-pinned: the prefix rule; the content rule
  (issue content for new — rendered through the SAME
  repo-comment-context markdown service; "" for close/reopen); the
  Message-ID extras; the link without a comment anchor; the locale action
  line (`renderIssueActionMail`'s three byte-traced `<p>` shapes: the
  body branch — identical bytes to the comment arm — the close/reopen
  first-chain shape, and the nested new-if shape); info stays
  "issue comments" for both arms.
- Dedupe keys (§8.3's trigger-level idempotency discipline):
  `issue-new:<issueId>:<recipientId>` (issueId is unique — the commentId
  discipline) and `issue-status:<issueId>:<close|reopen>:<unixMilli>:
  <recipientId>` — the ms rides the key exactly as it rides the
  Message-ID, because repeated close/reopen cycles over one issue must
  EACH mail (upstream's own uniqueness mechanism is that timestamp).
- Headers (`issueMailHeaders`) are arm-independent: the reason header is
  issue|pull by IsPull for every arm (actType = typeName at
  mail_issue_common.go:207).

### 9.3 The emit sites (src/issues/service.ts)

Upstream fires these receivers from the model layer (the issue-create and
state-transition services), never the router — the emits sit at:

- `createIssue` → `notifyMailNewIssue` (doer = `issue.posterId`; skipped
  for poster-less creates). `createPullRequest` emits nothing HERE —
  pull creation is the separate `NewPullRequest` receiver (notify.go:
  88-93), landed at §10.3 as its own emit; upstream's `NewIssue` arm is
  the issue arm.
- `transitionClosed` (the CAS winner only — a loser's batch fully no-ops
  and upstream never notifies a lost transition) →
  `notifyMailIssueStatus` (doer = `options.actorId`; skipped for
  actor-less transitions). The same `closeIssue`/`reopenIssue` service
  entries serve the issues routes, the pulls routes AND the create-route's
  `closed: true` arm, so one emit covers every HTTP path.
- The same fail-closed posture as §8.3: arms fire only when the optional
  constructor env is present and `MAIL_ENABLED === "true"`; failures are
  caught and logged; the write stays committed.

### 9.4 The route folds (applied, one line each)

`c.env` satisfies `MailNotifyEnv` structurally (DB + the vars the arms
read; arms no-op unless `MAIL_ENABLED === "true"`). Folded at landing:

- `api/routes/issues.ts` `createIssueRoute` handler — arms NewIssue AND
  its `closed: true` close transition (both ride this handler's service).
- `api/routes/issues.ts` `editIssueRoute` handler — arms the issue
  close/reopen transitions.
- `api/routes/pulls.ts` `editPullRoute` handler — arms the pull
  close/reopen transitions (IssueChangeStatus covers IsPull).

`api/routes/pulls.ts`'s `createPullRoute` handler was handed off bare
(`IssuesService(c.env.DB)`) — slice four folded it to
`new IssuesService(c.env.DB, c.env)` when the NewPullRequest arm landed
(§10.3). The UI write paths and the push-webhook close paths stay bare
(§1.3's last bullet).

---

## 10. SLICE FOUR AS-BUILT — the NewPullRequest arm

### 10.1 The pin's chain map (verified at fc493688)

`NewPullRequest` (services/mailer/notify.go:88-93) is the pull-create
twin of `NewIssue` — one line into the SAME middle slice three ports:

- `MailParticipants(ctx, pr.Issue, pr.Issue.Poster,
  ActionCreatePullRequest, mentions)` — the doer is the PR issue's
  POSTER (not an actor; notify.go:89); mentions ride the §8.2 reduction
  (no parser, passed nil-shaped).
- `MailParticipants` (mail_issue.go:173-202) keeps the content —
  ActionCreatePullRequest is NOT in the :180-185 empty list — and builds
  the `mailComment` with `Comment: nil`, then
  `mailIssueCommentToParticipants` → `composeIssueCommentMessages`, all
  shared.
- The ONE behavioral difference lives in the recipient resolution:
  mail_issue.go:67-76's repo-watcher gate is
  `IsPull && PullRequest.IsWorkInProgress && ActionType !=
  ActionCreatePullRequest` — the CREATE arm keeps the repo watchers even
  on a WIP pull (the create mail IS the notification that tells them a
  PR exists; every other pull arm drops them). `IsWorkInProgress`
  recomputes from the title prefix (models/issues/pull.go:652-658) — the
  landed `hasWorkInProgressPrefix` proxy is upstream-true.
- Template resolution: actionToTemplate (mail_issue_common.go:228-230)
  maps ActionCreatePullRequest to the SAME "new" name as
  ActionCreateIssue — no "Re: " prefix (:88-91), and the fallback chain
  `mail/repo/pull/new` → `mail/repo/issue/new` → `mail/repo/pull/default`
  → `mail/repo/issue/default` lands on issue/default.tmpl (only
  assigned + default exist under `templates/mail/repo/issue/`; there is
  no `mail/repo/pull/` at all) — byte-identical to the issue-new arm for
  the same inputs (default.tmpl has no `.IsPull` branch).
- Message-ID: the :285-294 switch has NO case for
  ActionCreatePullRequest — the plain
  `<owner/repo/pulls/#idx@domain>`, pinned by mail_test.go:417-422's
  "Open Pull" fixture; In-Reply-To/References stay the plain thread id
  (the reference is generated with ActionType(0), :165).
- Subject/info: the fallback `[owner/repo] Title (#Index)` with no
  prefix, and the batch info stays "issue comments" (mail_issue.go:161).

### 10.2 The arm as-built (services/mail/notify.ts)

- `notifyPullRequestCreated(env, {issue, doer})` — a thin wrapper over
  the shared `notifyIssueArm` compose: `actionName: "new"`,
  `content = issue.content ?? ""`, doer = the poster, PLUS the new
  `pullCreate` flag threaded into `resolveIssueMailRecipients`, whose
  WIP gate gains the upstream negation
  (`isPull && hasWorkInProgressPrefix && !pullCreate`).
- No templates.ts change: the pull-create render IS the issue-new render
  (§10.1's fallback chain; no `.IsPull` branch in default.tmpl).
- Dedupe key family: `pull-new:<issueId>:<recipientId>` — a DIFFERENT
  trigger than the issue one (upstream's separate receiver; issueId is
  unique, the commentId discipline).
- `MailNotifyEvent` gains `"NewPullRequest"`.

### 10.3 The emit site + the fold (src/issues/service.ts, api/routes/pulls.ts)

- `createPullRequest` → `notifyMailNewPullRequest` after the winning
  batch (upstream fires from the model layer): doer = `issue.posterId`
  (notify.go:89), skipped for poster-less creates; the same fail-closed,
  best-effort posture as the sibling arms (never throws; the write stays
  committed).
- `api/routes/pulls.ts`'s `createPullRoute` handler folded
  `new IssuesService(c.env.DB)` → `new IssuesService(c.env.DB, c.env)`
  (the §9.4 handoff line, applied). The route test env stays in the
  fail-closed posture (`MAIL_ENABLED=false`, ADR-0005 D3), so no route
  test arms.

### 10.4 Test coverage (notify.test.ts, +5 over the 97 baseline)

- The receiver's thread-root pins: no "Re: ", the PLAIN
  `<owner/repo/pulls/#idx@domain>` Message-ID with the
  In-Reply-To/References coincidence (the "Open Pull" fixture), reason
  header "pull", no comment anchor, `/pulls/` link, the content kept as
  body, `pull-new` dedupe keys.
- The WIP exception twice: at the resolution level
  (`resolveIssueMailRecipients` with `pullCreate: true` returns watcher
  20 first) and end-to-end (a WIP pull's CREATE mail keeps the watcher
  the same pull's comment/status arms drop).
- The service-level emit: armed `createPullRequest` lands `pull-new`
  rows (subject/Message-ID/reason/dedupe pinned, poster-doer excluded);
  the poster-less pull create skips while the write lands; disabled/
  malformed-config outcomes and the consume-to-sent consumer path ride
  the sibling arms' assertions. (The pre-slice-four "createPullRequest
  emits NOTHING" test is superseded by this family.)

---

## 11. SLICE FIVE AS-BUILT — the IssueChangeTitle arm (the WIP-ready rename mail)

### 11.1 The pin's chain map (verified at fc493688)

`IssueChangeTitle` (services/mailer/notify.go:80-90) fires from
`issue_service.ChangeTitle` AFTER the update (services/issue/issue.go:127)
with the UPDATED issue and oldTitle. The receiver gates FIRST —
`issue.IsPull && issues_model.HasWorkInProgressPrefix(oldTitle) &&
!issue.PullRequest.IsWorkInProgress(ctx)` — then the SAME middle slices
two-four port:

- `MailParticipants(ctx, issue, doer, ActionPullRequestReadyForReview,
  nil)` — a plain-issue rename mails NOTHING (the `IsPull` conjunct);
  `IsWorkInProgress` recomputes from the CURRENT title prefix
  (models/issues/pull.go:652-658 — the landed `hasWorkInProgressPrefix`
  proxy), so the gate is exactly "old WIP, new not-WIP".
- Content: ActionPullRequestReadyForReview is NOT in MailParticipants'
  empty list (mail_issue.go:179-185) — the kept description renders
  BELOW the ready line (default.tmpl's first action chain + the body
  else-branch are independent); an empty description renders the line
  alone (byte-identical to the close/reopen shape).
- Template: actionToTemplate (:248) names it "ready_for_review"; no
  `ready_for_review` template file exists (only assigned + default under
  `templates/mail/repo/issue/`), but default.tmpl's first action chain
  HAS the branch — the render falls through to issue/default.tmpl like
  every other named arm (`mail/repo/pull/` does not exist at the pin).
- Subject: "Re: " + fallback (the :88-91 rule — any non-"new" name).
- Message-ID: the :285-294 switch HAS a dedicated case (:303-304) —
  `<owner/repo/pulls/#idx/ready/<unixMilli>@domain>`; In-Reply-To/
  References stay the plain thread id (generated with ActionType(0)).
- Recipients: the full participants resolution — the repo watchers ride
  (the resolution's own WIP gate recomputes on the NEW non-WIP title, so
  it is false on its own terms; `pullCreate` is NOT set).
- Dedupe: `pull-ready:<issueId>:ready_for_review:<unixMilli>:
  <recipientId>` — the ms rides the key exactly as it rides the
  Message-ID (the issue-status discipline; repeated WIP cycles each
  mail).

### 11.2 The arm as-built (services/mail/notify.ts + templates.ts)

- `notifyIssueTitleChanged(env, {issue, doer, oldTitle})` — the receiver:
  the three gate-offs (non-pull, non-WIP old title, still-WIP new title)
  return `no-recipients` BEFORE the prelude (upstream's receiver returns
  before MailParticipants), then the shared `notifyIssueArm` compose
  with `actionName: "ready_for_review"`, `content = issue.content ?? ""`,
  dedupe prefix `pull-ready`.
- `notifyIssueArm` gains the ready branch: the always-rendered action
  line via the new `issueActionReadyForReviewLine`
  (`mail.issue.action.ready_for_review` = `<b>%[1]s</b> marked this pull
  request ready for review.` — no index argument, locale_en-US.json),
  the `/ready` Message-ID extra, and `renderIssueActionMail`'s FOURTH
  `<p>` shape — an action line AND a non-empty body (the `{{- if}}`
  trims the whitespace between the chain's `{{end}}` and the body
  branch). Upstream the close/reopen arms can never reach that shape
  (MailParticipants empties them), so the landed close/reopen bytes are
  unchanged.

### 11.3 The emit site + the folds

- `IssuesService.changeTitle(issue, title, actorId, now)` — wraps the
  shared `changeIssueTitle` write (untouched) and notifies with the
  UPDATED row + oldTitle after a winning write (upstream's :127
  position); best-effort, never throws. Folded at landing:
  - `api/routes/issues.ts` `editIssueRoute` title block —
    `changeIssueTitle(c.env.DB, ...)` → `service.changeTitle(...)`
    (the handler constructs `IssuesService(c.env.DB, c.env)` already);
  - `api/routes/pulls.ts` `editPullRoute` title block — the same fold.

---

## 12. SLICE FIVE AS-BUILT — the IssueChangeAssignee arm (the assigned mail)

### 12.1 The pin's chain map (verified at fc493688)

`IssueChangeAssignee` (services/mailer/notify.go:119-127) fires from
`UpdateAssignees`' post-tx loops (services/issue/assignee.go:155-166 —
removals first, then adds, `comment != nil` for adds only) — per
ACTUALLY-changed assignee, carrying that toggle's type-9 comment. Its
mail is NOT the participants funnel:

- Receiver gates (notify.go:121): `!removed && doer.ID != assignee.ID &&
  assignee.EmailNotificationsPreference != Disabled` — note the ONLY
  rule is not-disabled: `onmention` users DO get assigned mail (the
  participants prefilter's enabled/andyourown rule does not apply).
- `SendIssueAssignedMail` (mail_issue.go:200-232): the MailService gate,
  the repo load, a `langMap` whose only filter is `IsMailable`
  (:208-210), then `composeIssueCommentMessages` over
  `{ActionType: 0, Content: "Assigned #<index>.", Comment: <the type-9
  row>}` with info "issue assigned". NO CheckRepoUnitUser re-check — the
  assignee was `CanBeAssigned`-validated at add time.
- Compose consequences of `Comment != nil` (mail_issue_common.go:56-61,
  :167-170): the link AND the Message-ID carry the type-9 comment
  (`#issuecomment-<id>` anchor; `<owner/repo/issues|pulls/#idx/comment/
  <id>@domain>`); the thread In-Reply-To/References stay plain
  (ActionType(0)).
- Template: actionToTemplate's default case keys `CommentTypeAssignees`
  → name "assigned" → `mail/repo/issue/assigned` — the ONE named issue
  template that exists at the pin. It renders ONLY the
  `mail.issue_assigned.pull|issue` locale line (`%[1]s assigned you to
  pull request|issue %[2]s in repository %[3]s.`): the compose's Content
  string is rendered but never printed. TrHTML escapes plain-string args
  (i18n/localestore.go:156-171) while the HTMLFormat-built anchors pass
  through raw with the template's own SINGLE-quoted hrefs.
- Subject: "Re: " + fallback (assigned.tmpl has no subject section —
  the `---` split rule, modules/templates/mail.go:107/:158).

### 12.2 The arm as-built (services/mail/notify.ts + templates.ts + api/services/issues.ts)

- `notifyIssueAssigneeChanged(env, {issue, comment, doer, assignee,
  removed})` — the receiver gates verbatim (side-store preference read,
  absent row = 'enabled'), then the prelude, `isMailable`, and the
  single-recipient compose via the new `renderIssueAssignedMail`
  (templates.ts — the assigned.tmpl byte trace: the head gap's three
  bare newlines, the 3-tab locale `<p>`, the dropped
  `{{if .CanReply}}`'s own `\t\n`, the footer). Dedupe
  `issue-assigned:<commentId>:<recipientId>` (the comment arm's
  commentId discipline — a re-assign after unassign creates a NEW
  comment and mails again).
- The write core's seam widened: `replaceIssueAssignees`
  (api/services/issues.ts) passes each toggle's type-9 comment row
  through `onAssignee(user, removed, comment)` (upstream's `comment`
  argument, assignee.go:155/:161); `writeAssigneeComment` returns the
  inserted row. The /assignees trio's `addIssueAssignees`/
  `removeIssueAssignees` callers were untouched at this slice — their
  notify arms LANDED with slice seven (§14.5), reading the toggle's
  type-9 comment back by its own key set (the cores stay untouched).

### 12.3 The emit site + the folds

- `IssuesService.changeAssignees(found, issue, names, doer, onAssignee)`
  — wraps `replaceIssueAssignees` and fans BOTH IssueChangeAssignee
  receivers in per changed assignee (upstream's notify dispatch hands
  the event to the webhook AND the mail notifier): the caller's webhook
  emitter runs first, the mail arm after, removals before adds (the
  core's post-tx order); best-effort, never throws. Folded at landing:
  - `api/routes/issues.ts` `editIssueRoute` assignee block —
    `replaceIssueAssignees(c.env.DB, ...)` → `service.changeAssignees(...)`;
  - `api/routes/pulls.ts` `replacePullAssignees` helper — the same fold
    onto `new IssuesService(c.env.DB, c.env)`.

---

## 13. SLICE SIX AS-BUILT — the mentions arm (the @mentions parser + the onmention lift)

### 13.1 The pin's parser map (verified at fc493688)

The old `models/repo/mention.go` no longer exists at the pin — the
extraction consolidated into the references package, and the routers/
web/shared/mention package is only the autocomplete collector (it never
runs the regexp):

- `mentionPattern` — gitea/modules/references/references.go:33: matches
  `@user` or `@org/team`; the lead class `(\s|^|\(|\[)` is the email
  exclusion (a word char before `@` kills the match) and the trailing class
  `(\s|$|[:,;.?!](\s|$)|'|\)|\])` rejects glued punctuation (`@gitea!this`).
- `FindAllMentionsBytes` (:219-240) — the iterative pos-advance scan
  (FindAllSubmatchIndex cannot be used: the lead/trailing `\s` guards make
  consecutive mentions share the space); `spaceTrimmedPattern` (:45) is the
  notrail backoff, dead for mentions by construction (the capture classes
  `[-.\w]` admit no `\s`).
- `FindAllMentionsMarkdown` (:207-215) — strip first, scan second, names
  without the `@`; the strip is `mdstripper.StripMarkdownBytes`
  (modules/markup/mdstripper/mdstripper.go:146-171), a goldmark parse walked
  by a renderer emitting ONLY non-raw `ast.Text` nodes: fenced/indented code
  blocks carry no Text children, code-span text is raw, link children are
  skipped (WalkSkipChildren — link text and linkified URLs, email
  autolinks included, never reach the scan), raw HTML is not Text, image alt
  text IS walked, line breaks become `\n`, and adjacent Text siblings
  coalesce while a new inline container's first text child gets a `\n`
  (mdstripper.go:41-67).
- Fixtures at the pin: `TestRegExp_mentionPattern`
  (references_test.go:429-484 — 23 true + 14 false rows) and
  `TestFindAllMentions` (:358-367 — the exact spans). NO
  FindAllMentionsMarkdown unit fixtures exist at the pin — the strip's
  exclusion arms are cite-marked derived in parser.test.ts.

### 13.2 As-built: services/mentions/ + the threading

- `services/mentions/parser.ts` — the regexp verbatim (one mechanical
  translation: Go's ASCII `\s` spelled `[\t\n\f\r ]`; JS `\s` also eats
  Unicode spaces) + the scan + `stripMarkdownForScan` over markdown-it (the
  landed dependency): markdown-it's flat inline token list has open/close
  tokens exactly at goldmark's container edges, so "previous emitted chunk
  was text" reproduces the coalesce rule, and skipping everything between
  `link_open`/`link_close` is WalkSkipChildren. The strip instance parses
  `html: true, linkify: true` (goldmark's strip posture, html.WithUnsafe);
  its output only feeds the scanner, never a renderer — no XSS surface.
- `services/mentions/resolve.ts` — `ResolveIssueMentionsByVisibility`
  (models/issues/issue_update.go:575-696): the case-fold + dedupe `resolved`
  map, the doer pre-seed, the `@org/team` branch (org-owned repos only,
  prefix = the repo owner), team expansion through the teams joined to THIS
  repo (the `team_repo` join → our `team_repo_access`) gated on
  `UnitEnabled(TypeIssues|TypePullRequests)` (team.go:194-214, max(team
  mode, unit override) — our `teams.unitsMap` collapse, keys
  `repo.issues`/`repo.pulls` per structs/org_team.go:34) and expanded to
  active members (`users.status='active'` = upstream's is_active +
  !prohibit_login), then individual users (active, org rows skipped, the
  INDIVIDUAL read gate — repo_permission.go:426-491, deliberately without
  team grants so a team member named directly must come through the team
  arm). Folded reductions, recorded in the module header: the
  `HasOrgOrUserVisible` private-owner arm (no landed single predicate; the
  mail arm's CheckRepoUnitUser fold re-gates every survivor downstream) and
  upstream's `IsUserBlockedBy` filter (issue_update.go:559-565 — no block
  table).
- The carrier LANDED (the §13.2 HANDOFF of the first mentions wave,
  closed 2026-10-31): `issue_user` (migration 0057) ports upstream's
  table EXACTLY — `ID pk autoincr, UID INDEX unique(uid_to_issue), IssueID
  INDEX unique(uid_to_issue), IsRead, IsMentioned` (models/issues/
  issue_user.go:15-21); `UID` maps to `user_id` per the tree convention.
  The write is `services/mentions/carrier.ts` — `updateIssueMentions`
  (`UpdateIssueMentions` issue_update.go:515-527 + `UpdateIssueUsersByMentions`
  issue_user.go:64-86: the single-column `is_mentioned` upsert over the
  `(user_id, issue_id)` arbiter, is_read untouched — the pin has NO
  un-mention anywhere, so an edit dropping a `@name` leaves the flag
  sticky) and `getIssueMentionIds` (`GetIssueMentionIDs`
  issue_user.go:89-96). Threading: `issues/service.ts`'s
  `resolveMailMentions` is now the FULL `FindAndUpdateIssueMentions`
  (resolve then persist), and the three emit positions run it BEFORE the
  mail-env gate — upstream has no mail-env notion, and the carrier feeds
  reads that work without a mailer (the gate's original "no write to gate
  it" justification dissolved with this landing). The NewIssueUsers seed
  (issue_user.go:28-55 — repo-assignee + poster rows at issue create,
  is_read tracking) stays STAGED (§13.4): the mission scope was the
  mention carrier, and the seed's assignee enumeration rides surfaces
  that are not landed whole.
- The two reads our tree carries are wired:
  - the derived mailbox's mention arm (routes/notifications.ts
    `recipientExpr`): `exists (issue_user … uid, is_mentioned=1)` —
    upstream mails the resolved mentions as their OWN batch, first of the
    recipient sources (mail_issue.go:99-105), and the mailbox answers the
    same question at read time;
  - the subscription fallback's final arm (api/services/issue-extras.ts
    `checkIssueSubscription`): upstream's CheckIssueWatch participants
    fallback (issue_watch.go:88 → IsUserParticipantsOfIssue,
    issue.go:631-636 → GetParticipantIDsByIssue, issue.go:647-668 — poster
    unconditionally + DISTINCT posters of comment types 0/21/22 over
    active non-prohibited users). NOTE the pin consults NO mention arm
    here — `is_mentioned` never subscribes anyone through CheckIssueWatch
    at fc493688; the carrier's rows were not wired into this read and
    must not be (upstream behavior IS the default decision).
- The issue_user READS at the pin our tree does NOT carry — STAGED with
  their surfaces (§13.4): `UpdateIssueUserByRead` (issue_user.go:58-61 via
  SetIssueReadBy, notification.go:338 — the issue-view mark-read), the
  issue indexer's `GetIssueMentionIDs` (modules/indexer/issues/util.go:53
  — no indexer), the search filter joins (issue_search.go:396-398 powering
  `/repos/issues/search`'s `mentioned`/`mentioned_by` and
  repo_list.go:259-267's UserMentionedRepoCond — the routes exist and
  still stub the filters as the empty set; wiring them is the search
  surface owner's precise hunk now that the store exists).
- `services/mentions/service.ts` — the `findIssueMentions` entry
  (parse → resolve), the FindAndUpdateIssueMentions shape minus the two
  schema-absent arms.
- The hub threading (`services/mail/notify.ts`): `resolveIssueMailRecipients`
  takes `mentions?: UserRow[]` — the mention ids head the union (the
  mention batch mails first, mail_issue.go:99-102), the batch filter's
  onmention allowance is `onmention && (in the mention set || custom
  watch)` (:135-137, the custom half landed with the watch-mode slice), and
  the visited semantics are batch-1's for mention ids: ignorers and the
  doer exclude, explicit issue-unwatchers do NOT (the unwatcher block joins
  visited after the mention batch, :104-109). `notifyIssueComment`,
  `notifyIssueCreated` and `notifyPullRequestCreated` carry the parameter;
  the status/title arms take none (upstream passes nil — services/issue/
  status.go:43/:56, issue.go:127).
- The emit sites (`issues/service.ts`): `resolveMailMentions` runs parse +
  resolve + the carrier persist inside the notify helpers (upstream runs
  FindAndUpdateIssueMentions in the same services before the notify —
  comments.go:81, issue.go:68, pull.go:184), best-effort. The first wave
  gated this on the mail env ("no write to gate it"); the carrier landing
  removed the gate — the resolve+persist now runs UNCONDITIONALLY at the
  three emit positions (upstream has no mail-env notion, and the carrier
  feeds reads that work with no mailer), only the notify half stays
  mail-gated. Comment EDIT does not re-mention (upstream UpdateComment
  re-runs neither).

### 13.3 Tests (parser.test.ts 53, resolve.test.ts 19, carrier.test.ts 16, notify.test.ts +6, issue-extras-subscription.test.ts +7)

- Parser: the pin's 37 pattern rows + the span fixture 1:1; the strip arms
  are cite-marked derived (fence/indented/code-span/link/linkify/email/
  image-alt/raw-HTML/emphasis-split/unclosed-fence).
- Resolver: derived arms (upstream has no unit test for the function at the
  pin) — every filter line cited in the test's expect comment.
- The mail arms: mention-first ordering, the onmention lift + its negative,
  the mentioned-unwatcher exception, the mentioned-doer exclusion, and two
  end-to-end arms through `addComment` (the onmention row lands first; a
  code-span mention does not resolve).
- The carrier (carrier.test.ts 16): the upsert round trip (is_mentioned=1,
  is_read=0), the empty fast-path, single-row dedupe (same-call repeat +
  cross-call re-mention), the is_read-preserving re-mention
  (issue_user.go:77), the GetIssueMentionIDs filter (a non-mention carrier
  row excluded), the three ungated emit positions over `new IssuesService`
  with NO mail env (issue/comment/PR create + the no-mention zero + the
  sticky flag), and the mailbox mention arm end-to-end through
  `registerNotificationsRoutes` (the mentioned user's thread appears; the
  bystander's stays empty; deleting the carrier rows empties it).
- The subscription fallback (issue-extras-subscription.test.ts +7): the
  poster seat with zero comments, the poster skipping the active filter
  (the append sits outside the query), the 0/21/22 comment-type set, the
  system-comment exclusion, the prohibited-commenter exclusion, and the
  fallback answering true over a Dont repo watch.

### 13.4 Staged after the carrier (the §13.2 residue)

- `NewIssueUsers` seed (issue_user.go:28-55 + GetRepoAssignees,
  models/repo/user_repo.go:117-150): the is_read-tracking rows (repo
  assignees via access mode>=write + the org-team arm + poster/owner
  seats) at issue create. Rides the read-tracking surface — worthless
  until the mark-read write below lands.
- `UpdateIssueUserByRead` (issue_user.go:58-61 via SetIssueReadBy,
  models/activities/notification.go:338; callers routers/web/repo/
  issue_view.go:389, routers/web/repo/pull.go:153, routers/api/v1/repo/
  pull.go:911): the issue-view mark-read write. Collides by design with
  the derived mailbox's notification_states arithmetic — needs its own
  decision note when the web issue-view port reaches it.
- The mention reads over search: the issue indexer's GetIssueMentionIDs
  (modules/indexer/issues/util.go:53 — no indexer in this tree),
  `IssueSearch`'s MentionID join (issue_search.go:396-398 — the
  `mentioned`/`mentioned_by` filters of `/repos/issues/search` and the
  repo-scoped list, currently stubbed to the empty set in
  api/routes/issues.ts), and UserMentionedRepoCond (repo_list.go:259-267).
  The store exists now; the wiring belongs to the search surface's owner.

---

## 14. SLICE SEVEN AS-BUILT — the MergePullRequest arm (the winning-merge mail) + the /assignees trio folds

### 14.1 The pin's chain map (verified at fc493688)

- Upstream emit position: `markAsMergedPostProcess`
  (services/pull/merge.go:385-412) — runs AFTER the merge tx, with the PR
  RELOADED (`GetPullRequestByID` :388) and the issue closed. The winner
  gate is the tx's CAS: `cnt != 1 → ErrIssueAlreadyChanged` (:848-852) —
  a LOSER never notifies. The branch (:404-406):
  `wasAutoMerged ? AutoMergePullRequest : MergePullRequest`, and
  `wasAutoMerged` (:825-831) is ONLY true when a scheduled auto-merge row
  existed and its `MergedCommitID` matched — the adjudication that stages
  our `AutoMergePullRequest` (§1.3).
- The receiver (`MergePullRequest`, mailer/notify.go:138-146):
  `LoadIssue` then `MailParticipants(ctx, pr.Issue, doer,
  ActionMergePullRequest, nil)` — mentions nil, doer = the merger.
- MailParticipants (mail_issue.go:173-202): ActionMergePullRequest IS in
  the :180-185 empty-content list (:184) — the content is EMPTIED; `Comment`
  stays nil; `forceDoerNotification` is false for the plain merge arm.
- Template resolution: actionToTemplate (mail_issue_common.go:235-236)
  names it "merge" — ActionAutoMergePullRequest shares the name — and the
  fallback chain (`mail/repo/pull/merge` → `mail/repo/issue/merge` →
  `mail/repo/pull/default` → `mail/repo/issue/default`) lands on
  issue/default.tmpl: only `assigned` + `default` exist under
  `templates/mail/repo/issue/`, and no `mail/repo/pull/` at all.
- The render: default.tmpl's merge branch interpolates
  `mail.issue.action.merge` (locale_en-US.json:476) =
  `<b>%[1]s</b> merged #%[2]d into %[3]s.` — %[1]s
  `.Doer.DisplayNameWithFullName`, %[2]s `.Issue.Index`, %[3]s
  `.Issue.PullRequest.BaseBranch`. The content is emptied, so the merge
  line IS the body (the close/reopen byte shape; the "new"-only second
  line never fires for a non-"new" name).
- Message-ID: generateMessageIDForIssue's switch has the dedicated case
  (mail_issue_common.go:296-297) — `/merge/<unixMilli>`, shared by
  ActionMergePullRequest AND ActionAutoMergePullRequest; In-Reply-To/
  References stay the plain thread id (ActionType(0), :165).
- Subject: "Re: " + fallback (the :88-91 rule — any non-"new" name); the
  batch info stays "issue comments".
- Recipients: the full participants resolution, `pullCreate` NOT set — the
  WIP gate (:67-76) drops the repo watchers for a WIP-titled pull (our
  merge route refuses WIP anyway, pulls.ts:1548-1550 — the same
  unreachable-but-faithful posture as the flag itself).

### 14.2 The arm as-built (services/mail/notify.ts + templates.ts)

- `notifyMergePullRequest(env, {issue, doer, baseBranch})` — a thin
  wrapper over the shared `notifyIssueArm` compose: `actionName: "merge"`,
  `content: ""` (MailParticipants :184), doer = the merger, dedupe prefix
  `pull-merge`, and the new `baseBranch` input feeding the merge line's
  %[3]s (the arm's ONE piece of PR-row state the issue row doesn't
  carry). `MailNotifyEvent` gains `"MergePullRequest"`.
- `notifyIssueArm` gains the merge branch: the always-rendered action line
  via the new `issueActionMergeLine(doerDisplay, index, baseBranch)`
  (templates.ts — the locale string verbatim; the branch name is a
  plain-string locale arg so it escapes like the display name, the
  TrHTML precedent), the `/merge` Message-ID extra
  (`issueActionMessageId`'s action union widens with `"merge"`), and the
  log name "merge mail". The dedupe key
  `pull-merge:<issueId>:merge:<unixMilli>:<recipientId>` rides the long
  (ms-bearing) family — the issue-status discipline.
- No render change: `renderIssueActionMail`'s "action line + empty body"
  shape IS the merge render (the doc comment's shape table gains "merge"
  in the emptied-content list).

### 14.3 The emit site (api/services/pull-engine.ts)

- `mergePullRequest`'s D1 landing mirrors upstream's two halves exactly:
  the issue close runs through a BARE `IssuesService(c.env.DB)` (no mail
  env) — upstream's merge close is the MODEL-level `SetIssueAsClosed`
  (merge.go:838), from which NO mail fires; the merge's ONLY mail is
  `MergePullRequest`, never `IssueChangeStatus`'s close — and the PR-row
  update gains `.returning()` so the landing WINNER is observable.
- After a winning landing (the returned rows non-empty — the
  `has_merged=0` CAS, merge.go:848-852's `cnt != 1` analogue),
  `notifyMailMergePullRequest` (the module's best-effort wrapper, the
  landed service-level arms' posture: load the merger row, fire
  `notifyMergePullRequest`, log — never throw, the merge stays committed)
  hands over the POST-close issue row (upstream fires with the reloaded
  closed issue), `pr.baseBranch`, and the flow clock `opts.now`.
- The merge route caller (pulls.ts:1601) passes the request Context —
  the emit reads `c.env`; the shipped `MAIL_ENABLED=false` posture keeps
  the arm OFF everywhere (pinned by the tripwire test).

### 14.4 Tests (+6 over the 174 baseline — notify.test.ts 71, templates.test.ts 26)

- The receiver byte pins: the Re: subject, the `/merge/<ms>` Message-ID
  over the plain thread reference, the merge line with the base branch,
  the emptied content (the issue description never renders), "issue
  comments" info, the `pull-merge` dedupe keys, the reason header "pull".
- The merge line's escaping (a `rel<"1">&x` branch renders escaped — the
  TrHTML plain-string-arg rule) and the templates.test.ts verbatim pin
  (+ its escaped twin).
- The WIP-titled pull's merge drops the repo watchers (`pullCreate` NOT
  set) while the poster still receives.
- The real-flow emit (engine-backed, `manually-merged` over a seeded
  cell): an armed merge lands exactly the winner's rows — and NO
  `issue-status:*` row for the closed issue (the bare-close
  anti-double-fire pin); the shipped mail-off posture merges with ZERO
  outbox rows. Each emit test seeds its OWN repo/cell name (the DO
  namespace survives across tests in a file — a shared name collides on
  `refs/heads/main`).

### 14.5 The /assignees trio's folds as-built (api/routes/issue-tables-t2.ts)

- The HANDOFF taken: the POST (issueAddAssignees) and DELETE
  (issueRemoveAssignees) handlers now fan the landed
  `notifyIssueAssigneeChanged` receiver beside their webhook emitter —
  per ACTUALLY-changed assignee (the write cores' return lists), in the
  same post-write notify position upstream's AddAssignees
  (assignee.go:242) / RemoveAssignees (:281) hold. Upstream dispatches
  the removal event too and the MAIL receiver self-gates it off
  (notify.go:121's `!removed`) — mirrored: the DELETE handler calls and
  the receiver answers `no-recipients`.
- The write cores (`addIssueAssignees`/`removeIssueAssignees`,
  api/services/issues.ts) return only the changed users — the trio
  shape's deliberate deviation from `ToggleIssueAssignee`'s
  `(removed, comment)` pair — so the mail arm's `comment` argument is
  read back by the type-9 row's own key set: `(issue, type 9, assignee,
  removed flag, poster = doer)`, latest id — the just-inserted row under
  any same-key replay. A null read-back skips the arm (the anchor and
  the `/comment/<id>` Message-ID need the row; composing without it would
  not be upstream's compose, mail_issue.go:214-222 builds the message
  FROM the comment). The cores themselves are UNTOUCHED (the PATCH arm's
  `changeAssignees` seam stays the service-level path).
- Best-effort, never throws (the write stays committed); per-assignee
  try/catch with the landed log shape. The armed mount is exercised
  through the route tests (the env-merge shape of
  register-notify.test.ts): POST lands one `issue-assigned` row per
  added assignee (the type-9 anchor/Message-ID, "issue assigned" info,
  the comment dedupe), a no-op re-add lands nothing new, the unarmed
  shipped posture is the fold's fail-closed control, and the DELETE's
  zero rows pin the receiver's removal self-gate.

### 14.6 The review-family extraction sketch (the STAGED family's precise shape)

The staged receivers (`PullRequestReview` notify.go:98-111,
`PullRequestCodeComment` :113-117, `PullRequestReviewRequest` :129-136)
all fire — upstream — from `services/pull/review.go` AFTER the review
writes commit. Our tree has no such service layer: the review writes live
inline in `api/routes/pull-reviews.ts` (1977 lines), whose D1 writes
(~48 drizzle call sites) are route-handler writes — against the method.
The extraction that un-blocks the family:

- Extract `submitReview` (pull-reviews.ts:852-1032 — the review-submission
  core: the review row upsert, the pending-review folding, the official-
  reviewer gate inputs, the review-comment rows) into an
  `api/services/pull-reviews.ts` service whose handlers take the notify
  env alongside the write inputs, exactly the `IssuesService(d1, mailEnv)`
  precedent (§8.3).
- With it, the two request-writer cores `addReviewRequest` (:1033-) /
  `removeReviewRequest` (:1098-) move the same way — the
  `PullRequestReviewRequest` arm's emit site (its mail half is
  `notifyIssueAssigneeChanged`'s shape with the review-request `ct`,
  notify.go:131-136 — `SendIssueAssignedMail` over `{ActionType: 0,
  Content: "Requested to review <htmlurl>.", Comment: <the request
  comment>}` to the reviewer).
- `PullRequestReview` (:98-111) composes over the review's type-22/23/24/25
  comment thread (the APPROVED/REJECT/default→"approve"|"reject"|"review"
  template names via actionToTemplate's commentType switch) — the compose
  is the comment arm's shape with the REVIEW comment, so the extraction
  feeds the existing hub core unchanged.
- `PullRequestCodeComment` (:113-117) additionally needs the mention
  resolution over the code-comment body (`MailMentionsComment`,
  mail_comment.go:42-62) — the parser half is landed (§13); the arm rides
  the same extraction.

---

## 6. API/config surface

No new bindings (the arm reads `DB` + `REPO_TASKS`, both landed). Vars
(`wrangler.jsonc.example`, strict polarity):

| var | default | upstream |
|---|---|---|
| `MAIL_ENABLED` | `"false"` (only `"true"` arms) | `[mailer] ENABLED` (mailer.go:72) |
| `MAIL_PROVIDER` | `"dummy"` | `PROTOCOL` ∈ {dummy, resend} (mailer.go:37-44,102) |
| `MAIL_FROM` | unset | `FROM` (mailer.go:24,180-189) — RFC 5322 `Name <addr>` |
| `MAIL_SUBJECT_PREFIX` | unset (no prefix) | `SUBJECT_PREFIX` (message.go:56-60) |
| `MAIL_API_BASE` | provider default | (none — test/diagnostic override of the relay base URL) |

Secret: `MAIL_PROVIDER_API_KEY` — name declared in the example's
`secrets.required` (names only, per the existing comment's discipline);
value via `wrangler secret put MAIL_PROVIDER_API_KEY`; consumed only by
the `resend` arm. Local dev: `.dev.vars`.

The relay request/response mapping (resend arm): POST `{from, to: [to],
subject, html, text, reply_to?, headers?}` — 2xx = sent; everything else
mapped per §3.3.

---

## 7. Testing plan

All in workerd over the real D1 (`vitest.config.ts` bindings), the
repo-tasks queue STUBBED with the recording spy (`demo-sweep.test.ts`
shape) so no real provider is ever contacted:

1. **Message shaping** (`message.test.ts`): subject collapse/trim/256-rune
   clamp; subject prefix; Message-ID format
   `<autogen-<ms>-<16hex>@<domain>>` over to+subject+body (deterministic
   fnv64 port, cross-checked values); `X-Auto-Response-Suppress` always;
   Date rendering; plain-text reduction of a representative HTML excerpt.
2. **Template render** (`templates.test.ts`): register-notify renders the
   four upstream locale strings EXACTLY (locale_en-US.json quotes), with
   HTML-escaped `DisplayName`/`Username`, the `user/login` and
   `user/forgot_password` links, and the AppUrl footer.
3. **Transport contract** (`transport.test.ts`): the factory's
   provider selection (dummy default; unknown = dummy + the §5.1 posture);
   DummyTransport records and resolves; ResendTransport over a fake fetch —
   exact method/URL/headers/body mapping, reply_to/headers omission,
   2xx resolves, 4xx = permanent error class, 429/5xx/throw = transient
   error class.
4. **Outbox consumer** (`outbox.test.ts`): CAS claim (double-consume =
   one send); success → `sent` + `sent_at`; permanent → `failed` +
   `last_error`, no throw; transient → THROWS (the retry signal), then a
   redelivery succeeds; missing row → no-op; the queue stub receives
   `{kind: "mail-outbox", mailId}`.
5. **Trigger end-to-end** (`register-notify.test.ts`): POST
   `/admin/users` (`send_notify: true`, `MAIL_ENABLED=true`,
   `MAIL_PROVIDER=dummy`, `MAIL_FROM` set) through the real router → 201 +
   exactly one `email_outbox` row (To = the created email, subject =
   `<username>, welcome to <AppName>` rendered from the SAME template the
   consumer would send, dedupe key set) + the queue stub holding one
   message; `send_notify` omitted → 201, zero rows; `MAIL_ENABLED`
   off → 201, zero rows, zero D1 writes to the table (the gate-off
   tripwire posture); a second trigger with the same user → no second row
   (dedupe arbiter).
6. **purge.ts dispatch**: the new arm drives the consumer for a
   `{kind: "mail-outbox"}` body and leaves every existing arm's
   behavior untouched (the other kinds' fixtures asserted un-regressed).

Slice two adds (all in `src/services/mail/notify.test.ts`, same workerd +
real-D1 posture, the queue stubbed):

7. **Template byte-shape**: `renderIssueCommentMail` pins the Go-template
   whitespace trace verbatim (the two dropped-`{{if}}` lines, the `<p>`
   block's else-branch indentation, the bare link line), the head-title
   escaping, and `issueMailFallbackSubject` against mail_test.go's own
   `[user2/repo1] issue1 (#1)` shape.
8. **Recipient resolution** (`resolveIssueMailRecipients`, the
   mailIssueCommentToParticipants port): the full source union with
   upstream's order; the doer exclusion (+ the andyourown exception with a
   source); the explicit-unwatch exclusion; the preference prefilter
   through `user_settings` (absent row = enabled); the mailable filter
   (org/prohibited/no-email); the WIP repo-watcher gate (issue + PR
   twins); the private-repo grant gate (collaborator row in, everyone
   else out); the unit-enabled gate; the empty-recipient skip.
9. **The end-to-end surface**: `IssuesService.addComment` (armed env) →
   one outbox row per resolved recipient with the right dedupe key +
   subject/info/headers/Message-ID/In-Reply-To byte pins → one queue
   message each → the landed consumer arm settles `sent`; MAIL_ENABLED
   off → zero rows; malformed MAIL_FROM → the write still succeeds; no
   env → the arm is off (every existing construction site's posture);
   system-comment types never ride this arm.

Slice three adds (same files, same posture):

10. **The arm template byte-shapes** (`templates.test.ts`):
    `displayNameWithFullName`'s username-first order (vs the From header's
    FullName-first — the mail.go/user.go Sprintf distinction), the three
    locale action lines verbatim with display-name escaping, and
    `renderIssueActionMail`'s three `<p>` shapes — the close/reopen
    first-chain trace, the nested new-if trace, and the body branch's
    byte-equality with `renderIssueCommentMail`.
11. **The arms end to end** (`notify.test.ts`): `notifyIssueCreated`'s
    thread-root pins (no Re:, the Message-ID triple-coincidence, no
    comment anchor, the issue content as body — or the created-line when
    empty) and `notifyIssueStatusChanged`'s status pins (Re: subject,
    `/close|reopen/<ms>` Message-ID over the plain reference, the
    emptied content, the closed/reopened line, the pull twin with the
    WIP gate); plus the service-level emits — armed `createIssue` /
    `closeIssue` / `reopenIssue` land rows, the CAS loser and the
    poster-less / actor-less creates skip, and the bare-construction
    posture stays silent. (Slice four's pull-create arm adds §10.4's
    pins; the pre-slice-four "`createPullRequest` emits nothing"
    assertion is superseded there.)

Slice five adds (same files, same posture):

12. **The new template shapes** (`templates.test.ts`):
    `issueActionReadyForReviewLine` verbatim; the ready arm's
    line+body `<p>` shape (and its empty-body byte-equality with the
    close shape); `renderIssueAssignedMail`'s byte trace — the head gap,
    the single-quoted locale line with the type-9 anchor, the IsPull
    word choice, the escaping set, the dropped-CanReply line, the
    footer.
13. **The two receivers** (`notify.test.ts`): the ready mail's pins —
    `/ready/<ms>` Message-ID over the plain reference, Re: subject,
    watchers riding a non-WIP new title, the kept description below the
    ready line, the `pull-ready` dedupe, the three gate-offs
    (non-pull / non-WIP old / still-WIP new), consume-to-sent, disabled/
    malformed; the assigned mail's pins — one row to the assignee, the
    `/comment/<id>` Message-ID with the plain thread reference,
    `issue assigned` info, the assigned.tmpl line with anchor, the
    receiver gates (removed / self-assign / disabled / non-mailable)
    with `onmention` PASSING, consume-to-sent, disabled/malformed; the
    service-level emits — armed `changeTitle` (WIP → ready lands,
    plain rename silent) and armed `changeAssignees` (each add lands,
    the webhook emitter rides the same receiver, removals and no-ops
    mail nothing).

Slice seven adds (same files, same posture; §14):

14. **The merge arm** (`templates.test.ts` + `notify.test.ts`):
    `issueActionMergeLine` verbatim + the escaped branch twin; the
    receiver's byte pins — the `/merge/<ms>` Message-ID over the plain
    reference, the merge line with the base branch, the emptied content,
    the `pull-merge` dedupe, the WIP watcher drop; the REAL-flow emit —
    an armed `mergePullRequest` lands exactly the winner's rows with NO
    `issue-status` twin (the bare close never mails), the shipped mail-off
    posture merges with ZERO rows; and the trio folds (`issue-tables-t2.test.ts`)
    — POST lands one `issue-assigned` row per added assignee with the
    type-9 anchor/Message-ID/dedupe, the no-op re-add and the unarmed
    posture land nothing, the DELETE's zero rows pin the receiver's
    removal self-gate.

Gate: the new suites green own-eyes (`pnpm test <files>`); bare
`tsc --noEmit` zero errors; scoped eslint clean; `pnpm db:generate`
produced migration 0049.
