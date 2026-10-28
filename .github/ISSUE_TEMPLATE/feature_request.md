---
name: Feature request
about: Propose a feature or an upstream-parity surface
title: "[feat] "
labels: enhancement
---

**The demand**

cf-gitea builds surface on demonstrated demand, not for upstream parity's own sake.
See how [SPEC-0012 §1.1](https://github.com/HighCWu/cf-gitea/blob/main/specs/0012-actions-feasibility.md)
gates the entire Actions surface on real demand, a committed operator, and a wire
capture — nothing gets built until those fire. Describe the concrete requirement:

- What real project/workflow hosted on a cf-gitea instance is blocked today?
- What exactly can you not do without this?

**Who is affected**

- Does this block you on a deployed instance (your own, or the demo)?
- Are you (or your team) committed to using it once it exists?
- "Upstream Gitea has it" alone is not sufficient demand — say what breaks for you.

**Proposed behavior**

What should the API / UI / git surface do? Link the matching upstream Gitea
behavior (docs, or code in [go-gitea/gitea](https://github.com/go-gitea/gitea) —
`routers/api/v1/` for routes, `modules/structs/` for request/response shapes) so
the contract doesn't have to be guessed. Compatibility with upstream is the goal
unless an intentional divergence is argued for.

**Willingness to help**

Implementation starts with a SPEC (see
[CONTRIBUTING.md](https://github.com/HighCWu/cf-gitea/blob/main/CONTRIBUTING.md)
and the [SPEC index](https://github.com/HighCWu/cf-gitea/blob/main/specs/README.md)).
Say if you're willing to draft the SPEC or contribute the implementation — SPEC
proposals with a committed user behind them move fastest.
