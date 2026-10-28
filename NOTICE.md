# NOTICE

cf-gitea is **not affiliated with the Gitea project**. It is an independent
reimplementation of Gitea's backend on Cloudflare's developer platform.

## Gitea frontend (MIT)

The official Gitea web frontend is used unmodified-as-vendored: the upstream
codebase is included as the read-only git submodule at `gitea/` (upstream
`go-gitea/gitea`, pinned commit recorded in the SPEC index), and its built UI
assets are served per SPEC-0008's asset-reuse pipeline. Gitea is Copyright
(c) The Gitea Authors and licensed under the MIT License
(`gitea/LICENSE`). No files inside `gitea/` are modified in this repository.

## durable-git engine (vendored, adapted)

`packages/git-engine/` is a vendored, adapted copy of the durable-git engine.
Upstream provenance, and every deviation from it, is recorded per-file in
[`packages/git-engine/NOTICE.md`](packages/git-engine/NOTICE.md).

## License

This repository's own code is MIT — see [LICENSE](LICENSE). The Gitea
frontend submodule retains its upstream MIT license and copyright.
