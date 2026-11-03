# ADR-0008: Upstream behavior is the acceptance standard (not a direction to weigh)

Date: 2026-11-04
Status: ACCEPTED (user-ruled, 2026-11-04)

## Context

ADR-0002 and AGENTS.md made upstream behavior the default decision for
behavior-level surfaces; ADR-0007 extended the same to table structures.
Despite both, the orchestrator framed the password-authentication gap (the
absence of any password store; PAT-as-password as the only human login) as a
"product posture" requiring a user ruling, rather than recognizing it as a
basic compatibility requirement upstream unambiguously implements. The user
ruled (2026-11-04):

> 原版 Gitea 是行为规范，不是可选参考。用户名＋密码登录不是可选功能，
> 而是基础兼容性要求。……未实现可以暂时存在，但不能伪装成已经实现。

## Decision

1. **Upstream's implemented standard behavior is IN SCOPE by default.**
   "Currently usable enough", "low usage", "extra work" are not
   justifications for optionality.
2. **Behavior gaps are fixed by default; the orchestrator does not request
   product-direction rulings.** Rulings are requested only for: real platform
   limits, irreconcilable architecture conflicts, major security risks, or
   genuine trade-offs between multiple upstream-faithful adaptations.
3. **Platform differences may change internals, not external behavior** —
   D1/R2/DO/WebCrypto replace internals; API/Web-UI/Git-protocol/auth/
   permission/error semantics and user workflows stay compatible.
4. **Silent ignores are forbidden.** Any operation a UI or API accepts must
   either really execute or explicitly error. Accept-and-ignore (the
   admin-user-edit password field was the example) is a contract defect,
   worse than absence: until the real arm lands, the input is disabled with
   an explicit not-supported notice.
5. **A deferred record is not a permanent exemption.** SPEC/GAPS markers
   (deferred, unsupported, out-of-scope, intentional-recorded) covering
   upstream-standard behavior remain OPEN compatibility gaps. Historical
   records are re-graded under this ADR: platform-forced divergences (with
   their PLATFORM cite) stand; mere deferrals re-open as backlog.
6. **Compatibility judgments derive from the pinned upstream's actual
   behavior** — read the code/tests at the pin, per entry point (auth
   entrypoints especially: web login, API Basic, git-HTTPS each have their
   own rules around 2FA/PAT/password), never from feature names.
7. **The completion standard is behavioral equivalence, not code presence** —
   verified against upstream's same-input/same-precondition outcomes.

## First applications

- The password system (store, web login, reset, admin-set, install init,
  per-entry-point Basic rules) enters implementation now — the product
  direction is decided; only hash-compat strategy and migration trade-offs
  (bcrypt/argon2 absent from WebCrypto; pure-JS cost under CPU limits) may
  come back for ruling WITH evidence.
- A full upstream behavioral census (module-by-module: install, auth, users,
  orgs, repos, git HTTP, issues, PRs, Actions, Packages, webhooks, admin)
  is commissioned as the durability mechanism — the table census (117) gets
  its behavioral twin, so "major gaps closed" claims are measured against
  upstream coverage, not internal boards.

## Consequences

- The ledger's "intentional-recorded" vocabulary splits: platform-adapted
  (cite the platform) stands; intentional-recorded-deferred re-opens.
- The backlog grows by design; the census is the bound on its size.
