# Findings — real-git-client end-to-end against PRODUCTION (2026-10-30)

READ-ONLY probe. Subject: `https://cf-gitea.hecongw.workers.dev`
(`29.0.0+dev-208-gfc49368845`). Method: a real `git`/`git lfs` client drove the
full repo lifecycle — API-created scratch repo → clone → push → branch → PR →
merge → pull → tag → release+attachment → LFS → branch protection → wiki —
with the web UI verified by anonymous HTML fetches after each mutation. No repo
files were modified except this findings doc; nothing was committed. Full
cleanup executed and verified at the end (see §12).

Client versions: `git 2.43.0`, `git-lfs/3.4.1`, `curl 8.5.0`, `jq 1.7`.
PAT: minted via `node scripts/bootstrap-admin.mjs p0probe --remote`
(user `p0probe` id 4 already existed from the v1.3 probes — only the token row
was minted, and only that row was deleted afterwards). One transient
environment flake (local DNS returned 000/exit-6 for a few minutes mid-run)
is noted where it occurred; it is not an instance defect.

## 0. Verdict

- **9 steps exercised: 4 clean PASS (2, 3, 4, 8), 5 PASS-with-findings
  (1, 6 minor-only; 5, 7, 9 partial).**
- **2 HIGH blockers**, both in the PR merge surface:
  1. the merge endpoint rejects upstream's JSON key casing (`"Do"` → 422), and
  2. an API merge creates a merge commit with an **empty message**.
- The git plumbing itself is in excellent shape: smart-HTTP clone/push/pull,
  tag push, LFS push + fresh-clone smudge roundtrip (byte-identical), protected
  branch rejection, and wiki push all behaved with upstream-shaped responses.

### Blockers up front

| # | Severity | Finding |
|---|----------|---------|
| F1 | **HIGH** | `POST …/pulls/{index}/merge` requires lowercase `"do"`; upstream's contract key is `"Do"` (capitalized). Upstream SDK/tea clients that send `{"Do":"merge","MergeTitleField":…}` get **422 invalid request body**. |
| F2 | **HIGH** | Merging a PR via the API produces a merge commit whose **message is empty** (raw git object has no message; commits page renders an empty summary; `GET …/git/commits/{sha}` returns `"message":null`). Upstream defaults to `Merge pull request '<title>' (#N) from <head> into <base>`. |

---

## 1. Create scratch repo via API — PASS (with minor nits)

- `POST /api/v1/user/repos` `{"name":"git-e2e-scratch-1030","private":true,"auto_init":false,"default_branch":"main"}` → **201**, body echoes owner/name/default_branch `"main"`, `"empty":true`, `has_wiki:true`, `has_pull_requests:true`.
- **F6 (minor):** the create response serializes `"id":0` and **drops the sent `description`** (the subsequent `GET /repos/...` returns the description correctly, so it is a create-response serialization nit only). The `id:0` is structural: D1's `repositories.id` is a UUID text pk (`2667ac03-…` verified via read-only SELECT), while upstream returns a numeric repo id. Any client that round-trips the id (e.g. `GET /repositories/{id}`-style flows) gets 0.
- **F11 (low/medium):** private-repo **HTML** pages do not honor PAT auth — `GET /p0probe/git-e2e-scratch-1030` with `Authorization: token …` → **404** (upstream's web routes accept token auth). The API honored the token everywhere. Consequence for probe tooling: UI verification of a private repo needs a session cookie; the repo was flipped public (`PATCH … {"private":false}` → 200) for the HTML checks.

## 2. Empty-repo clone posture — PASS

- `git clone https://<token>@cf-gitea.hecongw.workers.dev/p0probe/git-e2e-scratch-1030.git` → clean clone, `warning: 您似乎克隆了一个空仓库。` ("you appear to have cloned an empty repository"), checkout landed on unborn **`main`** (the server-advertised default branch — not the client default), `git status` clean, remote URL accepted the bare-token form (`https://<token>@host/...`, no username needed).

## 3. Commit tree + push main; web tree + README — PASS

- Committed `.gitignore`, `README.md`, `src/index.ts`, `src/version.ts` (root commit `8debe95`); `git push origin main` → `* [new branch] main -> main`, exit 0.
- Web home (`/p0probe/git-e2e-scratch-1030`, anonymous): **200**, renders the top-level tree (`README.md`, `src`, `.gitignore`), the commit summary "Initial commit: README, src, gitignore", and the README body. `src/` subpage lists `index.ts` + `version.ts`.
- Raw endpoints serve correct bytes: `/raw/branch/main/README.md` and `/raw/branch/main/src/index.ts` → **200** with exact file content. API `GET …/contents?ref=main` lists the three top-level paths.

## 4. Branch feature/x; branch page + compare — PASS

- `git checkout -b feature/x`, commit `2182099` (`src/farewell.ts`), push → `* [new branch] feature/x -> feature/x`, exit 0.
- Branch page `/src/branch/feature/x` → **200**, per-file latest-commit attribution correct: the `src` row shows "feat: add farewell module", top-level files still show the root commit; direct file page `/src/branch/feature/x/src/farewell.ts` → 200.
- Branches list `/branches` → 200, lists `feature/x`.
- Compare `/compare/main...feature/x` → **200**, shows the changed file and the commit ("1 changed file", `farewell`, "feat: add farewell module").

## 5. PR via API → web page → merge → pull → commits page — PARTIAL (2 HIGH findings)

- `POST …/pulls` `{"title":"Add farewell module","head":"feature/x","base":"main"}` → **201**, PR **#1** open. Web PR page → 200 with upstream-shaped conversation view ("p0probe wants to merge `feature/x` into `main`", Open badge, Conversation/Commits/Files tabs, files tab shows the diff).
- Merge box first rendered "Pull request mergeability is being computed.", settled to "This branch has no conflicts" within seconds (matches upstream's async mergeable check; `GET …/pulls/1` polled `mergeable:true` from the first poll). Not a finding.
- **F1 (HIGH):** `POST …/pulls/1/merge` with upstream's documented body `{"Do":"merge"}` → **422 `{"message":"invalid request body"}`**. The cf-gitea schema (`apps/worker/src/api/models/pull.ts:158-169`) declares lowercase `do` / `merge_title_field` / `merge_message_field`, while upstream's swagger (`gitea/templates/swagger/v1-swagger.generated.json`) and `MergePullRequestOption` contract use `"Do"`, `"MergeTitleField"`, `"MergeMessageField"` (capitalized). Retrying with `{"do":"merge"}` → **200**, `merged:true`. Impact: go-sdk/tea-based clients fail to merge any PR.
- **F2 (HIGH):** the resulting merge commit (`d7d6974`, 2 parents, fsck-clean) has an **empty message** — `git cat-file commit origin/main` shows headers then nothing; `git log --oneline` renders `d7d6974` with no subject; the commits page shows an empty summary anchor for it; API `GET …/git/commits/d7d6974…` returns `"message":null`. Upstream writes a default "Merge pull request …" message. Every API merge (and likely web merges too) pollutes history with message-less merge commits.
- `git pull origin main` → fast-forward `8debe95..d7d6974`, working tree gains `src/farewell.ts`, exit 0.
- Commits page `/commits/branch/main` → 200, lists the merge commit + both branch commits.
- **F7 (minor):** after merge, `GET …/pulls/1` returns `"merged":true` but `"merged_commit_sha":null` (upstream populates it with the merge commit SHA).

## 6. Tag v0.1.0; tags/releases surface; Release + attachment roundtrip — PASS (with minor nits)

- Annotated tag `v0.1.0` → `git push origin v0.1.0` → `* [new tag] v0.1.0 -> v0.1.0`, exit 0. `/tags` page → 200 and lists v0.1.0.
- **F8 (minor):** API `GET …/tags` returns `"message":""` — the pushed **annotated tag's message ("v0.1.0 first probe tag") is lost** (upstream surfaces it).
- `POST …/releases` `{"tag_name":"v0.1.0",…}` → **201** (id 5). Release page `/releases/tag/v0.1.0` → 200, renders name, body, and the attachment.
- Attachment: `POST …/releases/5/assets?name=e2e-attachment.txt` (multipart) → created; download via the returned anonymous `browser_download_url` (`/attachments/<uuid>`) → **byte-identical** to the uploaded 67-byte file (sha256 `584c5399…`). Asset list API shows `{name, size}` correctly.
- **F9 (minor):** `/releases` lacks upstream's **Tags** sub-tab (tags are only at `/tags`); the releases page body offers just a link to `/tags`.

## 7. LFS — PARTIAL (plumbing PASS; UI/raw gaps)

- `git lfs install` + `git lfs track "*.bin"` (`​*.bin filter=lfs diff=lfs merge=lfs -text` in `.gitattributes`), pushed 1,024-byte `big.bin` (>100B) — client reported `Uploading LFS objects: 100% (1/1)`, git push `d7d6974..c60f92d`, exit 0.
- The git blob stored server-side is the pointer (`git cat-file -p HEAD:big.bin` → `version https://git-lfs.github.com/spec/v1`, `oid sha256:ff55d80a…`, `size 1024`).
- **F3 (medium):** the web file view (`/src/branch/main/big.bin` → 200) shows **no LFS badge** — upstream's `gitea/templates/repo/file_info.tmpl:14` renders `<span class="ui label">LFS</span>` next to the size when `.IsLFSFile`; cf-gitea's page has the `file-info-size` element but no LFS label. A user cannot tell the file is LFS-backed from the UI.
- **F4 (medium):** `/raw/branch/main/big.bin` serves the **pointer text** (content-type `text/plain`), while upstream's raw route is `SingleDownloadOrLFS` (`gitea/routers/web/repo/download.go`, wired at `web.go:1701`) and serves the resolved content. The `/media/branch/main/big.bin` endpoint serves the real bytes — **byte-identical** to the original.
- LFS batch API: `POST …/​.git/info/lfs/objects/batch` (basic auth, `application/vnd.git-lfs+json`) → **200** with a valid basic `download` action (href + Authorization header). Fresh `git clone` with smudge enabled materialized `big.bin` with the **matching sha256** (`ff55d80a…`) — the full pointer→content path through the LFS API works.

## 8. Protected branch — PASS

- `POST …/branch_protections` `{"branch_name":"main","rule_name":"main","enable_push":false,…}` → created (id 65, full upstream-shaped rule body echoed). `/branches` page shows the protection shield icon (`octicon-shield`).
- Direct push to protected `main` → `! [remote rejected] main -> main (Not allowed to push to protected branch main)`, git exit 1 — **upstream-identical rejection text**.
- Unprotect: `DELETE …/branch_protections/main` → **204**, list empties, direct push succeeds again.
- Note (checked against upstream, not a finding): upstream's delete route resolves the `{name}` path segment **by name** (`GetProtectedBranchRuleByName`, `routers/api/v1/repo/branch.go:1209`), so `DELETE …/branch_protections/65` by numeric id 404s on cf-gitea exactly as it would on upstream.

## 9. Wiki — PARTIAL (git side PASS; navigation broken)

- `git clone …​/git-e2e-scratch-1030.wiki.git` → clean empty-clone; pushed `Git-E2E.md` on `main` → `* [new branch] main -> main`, exit 0.
- Wiki page view `/wiki/Git-E2E` → **200**, renders the pushed content ("Git E2E Wiki", "cf-gitea git-e2e probe").
- **F5 (medium):** wiki navigation is broken on this instance:
  - the repo navbar (Issues / Pulls / Packages / Releases) has **no Wiki tab at all** despite `has_wiki:true`, so the wiki is reachable only by direct URL;
  - `/wiki` → 303 → `/wiki/?action=_pages` → **404** (verified twice, with `/wiki/Git-E2E` 200 in between); `/wiki/_pages` → 303 into the same 404;
  - no seeded `Home` page: `/wiki/Home` → 303 to the same 404 (upstream seeds `Home.md` when the wiki is initialized);
  - **F10 (minor, related):** the wiki repo's HEAD/default branch is `main`; upstream wiki repos use `master`. A `git push origin master` on a fresh wiki clone fails (`srcspec master does not match`) until the client notices the advertised HEAD.
- Environment note: a several-minute local DNS flake (curl 000/exit-6, later self-healed) occurred around this step; the 404s above reproduced on warm DNS and are server behavior, not network.

---

## 10. Findings index

| # | Sev | Area | Summary |
|---|-----|------|---------|
| F1 | HIGH | API PR merge | Rejects upstream key casing `"Do"`/`"MergeTitleField"`/`"MergeMessageField"` (422); only lowercase accepted (`apps/worker/src/api/models/pull.ts:158`) |
| F2 | HIGH | PR merge / git | Merge commit created with empty message (object, commits page, and `/git/commits` all show it) |
| F3 | med | Web file view | Missing upstream LFS badge (`file_info.tmpl` `<span class="ui label">LFS</span>`) |
| F4 | med | Raw endpoint | `/raw/branch/...` serves the LFS pointer; upstream resolves via `SingleDownloadOrLFS` (`/media/` is correct) |
| F5 | med | Wiki UI | No Wiki tab; `/wiki` and `_pages` views 404; no seeded Home page |
| F6 | minor | API repos | Create response `"id":0` (UUID text pk in D1) + description dropped from create response |
| F7 | minor | API PRs | `merged_commit_sha:null` after merge |
| F8 | minor | API tags | Annotated tag message lost (`"message":""`) |
| F9 | minor | Web releases | Missing upstream Tags sub-tab on `/releases` |
| F10 | minor | Wiki git | Wiki default branch `main` vs upstream `master` |
| F11 | low | Web auth | HTML pages reject PAT header auth (404) where upstream web routes accept tokens; API unaffected |

Counts: 2 HIGH, 3 medium, 6 minor/low. Steps: 4 clean PASS, 5 with findings (no step failed outright at the git level).

## 11. What worked flawlessly (worth keeping)

- Smart-HTTP throughout: `info/refs`, upload-pack, receive-pack with real `git 2.43` and `git-lfs 3.4.1`, token-as-username URLs.
- Unborn-HEAD advertisement on empty clones (client lands on `main`).
- LFS push → fresh-clone smudge byte-identical; batch API compliant (`basic` transfer with auth header).
- Protected-branch rejection text and semantics; unprotect restores push.
- Release attachment upload/download byte-identical; anonymous attachment URLs work.
- Branch/compare/commits/PR web pages render upstream-shaped HTML with correct per-file commit attribution.

## 12. Cleanup — done and verified

- Repo deleted via API (`DELETE /repos/p0probe/git-e2e-scratch-1030` → 204). Cascade verified: repo page, wiki page, and attachment URL all **404** afterwards.
- PAT row deleted from remote D1 (`DELETE FROM personal_access_tokens WHERE prefix='cfg_46863f11'` → `changes:1`, re-select count 0); the minted token now returns **401**. The pre-existing `p0probe` user (id 4) was left untouched.
- Token files shredded (`shred -u`), `/tmp/git-e2e-work` clones (remotes carried the embedded token) removed, all `/tmp/e2e-*` probe artifacts deleted; a grep sweep confirmed no remaining token-bearing files.
