# Security Policy

cf-gitea re-implements Gitea's backend on Cloudflare Workers (Hono + TypeScript +
Drizzle + D1/R2/Durable Objects). This document describes what is in scope for a
security report, how to report privately, and what to expect back.

## Supported Versions

Security fixes land on the `main` branch and reach deployed instances through
tagged releases. Only the most recent release is supported — we do not backport
fixes to older releases. Self-hosted deployments upgrade by redeploying (the
Deploy button, or `pnpm build && pnpm deploy`).

| Version | Supported |
| --- | --- |
| `main` branch | Yes — fixes land here first |
| Latest tagged release (see [Releases](https://github.com/HighCWu/cf-gitea/releases)) | Yes — deployed instances should track it |
| Older releases | No — no backports |

## Reporting a Vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's vulnerability reporting:

> <https://github.com/HighCWu/cf-gitea/security/advisories/new>

(or **Security** → **Report a vulnerability** in the repository's Security tab).
This is a private, maintainer-only channel — your report is not visible to the
public until we publish an advisory.

If you have used automated tooling or an LLM to find the issue, say so, and
please verify it reproduces before submitting.

### What to include

- The affected component and endpoint (exact path, e.g. `/api/v1/...`,
  `/{owner}/{repo}.git/info/refs`, a UI route) and the commit SHA or release you
  tested against.
- Reproduction steps: the exact HTTP request(s) — method, headers, body — and
  the observed vs. expected response. Minimal proofs of concept beat prose.
- Your assessment of the impact (what an attacker gains, and preconditions).
- The deployment context: a default self-hosted deployment, a deployment with
  specific configuration (for example `ALLOW_SIGNUP` or `DEMO_MODE`), or the
  public demo instance. Configuration-sensitive findings need this to be judged.
- Your GitHub handle for credit, and whether you want to be credited by name.

**Never paste live credentials or real user data in a report.** If the finding
involves credential handling, redact the values — a token's shape is enough.

### Response expectations

cf-gitea is a volunteer-maintained project. There is **no SLA**: we cannot
promise a response time. We acknowledge reports on a best-effort basis, triage
them, and keep the reporter updated in the private advisory thread. Fix and
disclosure are coordinated with you — please do not publish details of the
vulnerability before a fix ships or an agreed disclosure date. Reports are
credited by default; tell us if you prefer anonymity.

## Scope

### In scope

- **The Worker backend** (`apps/worker`): `/api/v1` routes, the git smart-HTTP
  surface (`info/refs`, `git-upload-pack`, `git-receive-pack`), the UI pages,
  queue/cron consumers.
- **Authentication and sessions**: personal access tokens, scope enforcement,
  the `gitea_session` cookie and its rotation/reuse-detection (SPEC-0002,
  SPEC-0010).
- **The storage layer**: D1 metadata, R2 blobs, Durable Objects — anything that
  exposes another tenant's private repositories, metadata, or blobs.
- **The vendored git engine** (`packages/git-engine`): a fork of
  [durable-git](https://github.com/littledivy/durable-git) that this project
  maintains and adapts; every deviation from upstream is recorded in
  `packages/git-engine/NOTICE.md`. Report engine defects here even if they
  originate upstream — we will coordinate upstream disclosure.
- **Outbound surfaces**: the mirror/import SSRF egress gate and webhook
  delivery (SPEC-0009 §4.1, SPEC-0005).
- **Secrets handling**: any path that leaks instance secrets (values held via
  `wrangler secret` — never committed in source, config, or specs per
  `AGENTS.md`) into responses, logs, or exports.

### Out of scope

- **The vendored Gitea frontend** (`gitea/` — the official upstream Gitea
  codebase, pinned as a read-only submodule and served as stock assets).
  Vulnerabilities in Gitea's own code belong to the upstream Gitea project:
  follow its security policy (`SECURITY.md` in
  [go-gitea/gitea](https://github.com/go-gitea/gitea)); we do not patch the
  vendored UI.
- **The demo instance's data lifecycle.** The public reference demo at
  `cf-gitea-demo.aiapp.run` periodically wipes content on a 72-hour sweep
  (SPEC-0014; see the README's demo note). Losing data there is the documented
  posture, **not** a vulnerability — and please do not put real data on the
  demo, and do not run automated exploitation against it or anyone else's
  instance. The easiest — and only sanctioned — target is your own deployment:
  the Deploy button stands up your own instance on your own Cloudflare account.
- **The self-host guarantee as a "finding".** A default self-hosted deployment
  intentionally performs no scheduled cleanup, deletes no user data, and
  rate-limits only via the auth-failure limiter — beyond that, platform-plan
  limits apply (README; SPEC-0014 §2's hard invariant). The absence of
  application-level quotas or cleanup is a design guarantee, not a flaw.
- **Known, documented design decisions** (below).
- Volumetric denial of service that Cloudflare's platform mitigations already
  address, social engineering, and anything requiring physical or console
  access to Cloudflare's infrastructure.

### Known, documented design decisions (please don't report these)

- PATs are stored as sha256 digests, not PBKDF2 — the tokens are 160-bit
  crypto-random, and the reasoning is recorded in SPEC-0002 §3 ("Hashing
  decision").
- The session cookie is an unsigned `id:secret` pair whose security rests on
  256 bits of entropy, sha256-at-rest, rotation, and reuse detection
  (SPEC-0010 §2.3–2.4, §3).
- The CSRF posture is SameSite=Lax + a server-side Origin check on non-GET UI
  routes (upstream dropped its CSRF token at our pin) — SPEC-0010 §2.8.
- The mirror/import egress gate documents a residual DNS-rebinding TOCTOU
  window it cannot fully close in user space — SPEC-0009 §4.1.
- Credential verification fails closed when D1 is unavailable; the auth
  failure limiter deliberately fails open — SPEC-0002 §4.5 and its amendment.
- There is no password store, no 2FA, and no OAuth2 provider yet — auth is
  PAT-only by design (SPEC-0002 §4.6).
- Pull-mirror source credentials are encrypted at rest with AES-256-GCM under
  a key held in `wrangler secret`, never echoed by the API — SPEC-0009 §4.2.
  Reports that only re-describe this posture are duplicates.

A report that a *documented* decision is exploitable in a way the SPEC did not
anticipate is absolutely in scope — cite the SPEC section you are challenging.
