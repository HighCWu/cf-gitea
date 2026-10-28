---
name: Bug report
about: Something is broken — help us reproduce it
title: "[bug] "
labels: bug
---

<!-- Template-relative note: links below point at the repo's default branch. -->

**What happened**

A clear description of the bug, including what you expected to happen instead.

**Environment**

- Where it happens: self-hosted (local `pnpm dev`, or your deployed Worker — say
  which deploy path: one-click button / `pnpm setup:deploy`) or the shared demo
  instance
- Versions: Node, pnpm, git, browser (UI bugs), git client (clone/push bugs)
- Anything unusual about the deployment (custom domain, `ALLOW_SIGNUP`, mirror
  secrets set, free plan, ...)

**Steps to reproduce**

Minimal numbered steps with exact commands and URLs:

- Git-protocol bugs: the exact client command and its **full** output
- API bugs: method, path, request body, and the response (status + JSON)
- UI bugs: the page URL and what you clicked/typed

**Expected vs actual**

**Test evidence (if you run the repo locally)**

- Does the bug reproduce in a scoped `pnpm test` run? Name the test file/scope
  that covers it (or say none exists).
- Don't run `pnpm test:full` for a bug report — the full-suite composite gate is
  CI's job ([ADR-0006](https://github.com/HighCWu/cf-gitea/blob/main/docs/decisions/0006-full-suite-composite-gate.md)).
  A bug that fails a named scoped test is the fastest to land a fix for.
