# Re-verification — real-git-client end-to-end against PRODUCTION (2026-10-30, post-fix)

READ-ONLY probe. Subject: `https://cf-gitea.hecongw.workers.dev`
(`29.0.0+dev-208-gfc49368845` — the version string is IDENTICAL to the first
probe's; it does not move with fix commits, so every verdict below is
behavioral, not version-matched). This is the re-run of
`docs/usability/findings-git-e2e.md` against the deployment carrying the fix
waves (`2854fb4` — F1+F2; `1677dbb` — F6+F9 plus the F7 deploy-lag closure;
`f561d92` — the wiki/LFS web wave). Method: the same real `git`/`git lfs`
client drove the full repo lifecycle — API-created scratch repo → clone → push
→ branch → PR → merge → pull → tag → release+attachment → LFS → branch
protection → wiki — with the web UI verified by anonymous HTML fetches after
each mutation. No repo files were modified except this findings doc; nothing
was committed. Full cleanup executed and verified at the end (see §13).

Client versions (identical to the first probe): `git 2.43.0`, `git-lfs/3.4.1`,
`curl 8.5.0`, `jq 1.7`. PAT: minted via
`node scripts/bootstrap-admin.mjs p0probe --remote` (user `p0probe` id 4
pre-existing — only the token row was minted, and only that row was deleted
afterwards; prefix `cfg_60429c55`, now 401). Environment note: the instance now
renders the demo banner ("This is a demo instance: data on this instance is
periodically cleaned.") — the ADR-0005 demo posture; the first probe's doc did
not mention it. Not a finding.

## 0. Verdict

- **9 steps exercised: 9 PASS (4 repeat-clean, 5 previously-finding steps now
  fully resolved).**
- **All 4 targeted fix-verdicts PASS:**
  - **F1 FIXED** — `{"Do":"merge"}` (PascalCase, the go-sdk shape) → **200**;
    lowercase `{"do":"merge"}` still 200 (both casings accepted, matching
    upstream's dual-casing `UnmarshalJSON`).
  - **F2 FIXED** — the API merge commit carries the default message
    `Merge pull request '<title>' (#N) from <head> into <base>`, verified on
    all four surfaces (raw git object, `git log`, commits page, API
    `.commit.message`).
  - **F6 FIXED (echo half)** — the repo-create 201 response now echoes the sent
    `description`; `id` stays `0` (the documented structural UUID-pk seam).
  - **F9 (releases-detail Tags tab) FIXED** — `/releases/tag/v0.1.0` renders
    the upstream-shaped two-item sub-menu (`1 Release` active + `1 Tag` plain).
- **Zero HIGH blockers remain.** Bonus confirmations: F7 verified live
  (populated, under upstream's exact key — see §5), F3 LFS badge landed,
  F5 wiki fully resolved (all four arms — two fixed, two upstream-faithful).
- The git plumbing stayed flawless throughout: smart-HTTP clone/push/pull, tag
  push, LFS push + fresh-clone smudge (byte-identical), protected-branch
  rejection, wiki push — all upstream-shaped.

### Fix-verdict table

| Original | Verdict | Evidence |
|----------|---------|----------|
| F1 (HIGH) merge rejects `"Do"` | **FIXED** | `POST …/pulls/1/merge` `{"Do":"merge"}` → **200** (was 422); PR `merged:true`. Regression: PR #2 with `{"do":"merge"}` → **200**. |
| F2 (HIGH) empty merge message | **FIXED** | Merge commit `0eeafcc` raw object ends `Merge pull request 'Add farewell module' (#1) from feature/x into main`; same message via `git log`, commits page (subject `&#39;`-escaped in HTML — present), `GET …/git/commits/{sha}` `.commit.message`, and the commits list. PR #2's `49cf623` composes identically. |
| F6 (minor) create response drops description | **FIXED (echo)** | 201 body carries `"description":"reverify probe 2026-10-30"` exactly as sent; `"id":0` unchanged — the documented UUID-text-pk structural seam (unchanged by design). |
| F9 (minor) releases DETAIL lacks Tags tab | **FIXED** | Detail page renders `<div class="ui compact small menu small-menu-items"><a class="active item" … >1 Release</a><a class="item" …>1 Tag</a></div>` — Releases active / Tags plain, upstream's every-render menu. |

No new HIGH or MEDIUM findings. One documentation-grade correction to the
ORIGINAL probe's findings (F7's field name), and two F5 arms re-classified as
upstream-faithful rather than defects — all detailed below.

---

## 1. Create scratch repo via API — PASS

- `POST /api/v1/user/repos` `{"name":"git-e2e-scratch-1030","private":true,
  "auto_init":false,"default_branch":"main","description":"reverify probe
  2026-10-30"}` → **201**, body echoes owner/name/`default_branch:"main"`,
  `"empty":true`, `has_wiki:true`, `has_pull_requests:true`.
- **F6 fix verified:** the response carries `"description":"reverify probe
  2026-10-30"` — the sent description is no longer dropped (the shared create
  assembly now threads the settings row through). `GET /repos/...` agrees.
- `"id":0` persists — the documented structural seam (D1 UUID text pk vs
  upstream's numeric id), unchanged by design and still flagged for the
  repos-module owner.
- Repo flipped public via `PATCH … {"private":false}` → 200 for the anonymous
  HTML checks (F11 unchanged territory — not re-probed; API honored the token
  everywhere it was used).

## 2. Empty-repo clone posture — PASS

- `git clone https://<token>@cf-gitea.hecongw.workers.dev/
  p0probe/git-e2e-scratch-1030.git` → clean clone, `warning: 您似乎克隆了一个空仓库。`,
  checkout on unborn **`main`** (server-advertised), status clean, exit 0.
  Identical to the first probe.

## 3. Commit tree + push main; web tree + README — PASS

- Root commit `ea23345` (`.gitignore`, `README.md`, `src/index.ts`,
  `src/version.ts`); `git push origin main` → `* [new branch] main -> main`,
  exit 0.
- Web home → **200**, renders the tree, the commit summary, and the README
  body; `src/` subpage 200; `/raw/branch/main/README.md` → 200 with exact
  bytes; API `GET …/contents?ref=main` lists the three top-level paths.

## 4. Branch feature/x; branch page + compare — PASS

- `887254b` (`src/farewell.ts`) pushed as `feature/x`, exit 0. Branch page
  200 with per-file attribution ("feat: add farewell module" on `src` only),
  file page 200, `/branches` lists the branch, `/compare/main...feature/x`
  → 200 ("1 changed file", farewell, the commit message).

## 5. PR → merge (`Do` casing + message) → pull → commits — PASS (all fix-verdicts green)

- `POST …/pulls` `{"title":"Add farewell module","head":"feature/x",
  "base":"main"}` → **201**, PR **#1** open; web PR page 200; `mergeable:true`
  from the first poll.
- **F1 fix verified:** `POST …/pulls/1/merge` with **`{"Do":"merge"}`** →
  **200** (the first probe got 422 here). `GET …/pulls/1` → `merged:true`.
  Lowercase regression on a fresh PR #2 (`feature/y`, `ba025f1`):
  `{"do":"merge"}` → **200**, `merged:true` — both casings accepted, mirroring
  upstream's dual-casing contract/runtime split.
- **F2 fix verified:** merge commit `0eeafcc` (2 parents) raw object:
  ```
  Merge pull request 'Add farewell module' (#1) from feature/x into main
  ```
  - `git cat-file commit` — message present.
  - `git log --oneline` renders the subject.
  - Commits page `/commits/branch/main` renders it (the subject's apostrophes
    are `&#39;`-escaped in the HTML — a naive grep misses it; the first probe's
    page-render check must be read with the same caveat).
  - API: `GET …/git/commits/0eeafcc…` → `.commit.message` = the same string
    (`\n`-terminated, upstream shape); the commits list agrees. (Note: the
    message lives at `.commit.message`; jq-ing a nonexistent top-level
    `.message` fabricates `null` — the first probe's API observation is fully
    explained by the now-fixed empty object plus this extraction detail.)
- `git pull origin main` → fast-forward, working tree gains `src/farewell.ts`,
  exit 0. Commits page lists the merge + both branch commits.
- **F7 verified live (with a field-name correction to the original doc):** the
  merged PR carries **`merge_commit_sha":"0eeafcc…"** on both
  `GET …/pulls/1` and the `GET …/pulls` list. Upstream's swagger serializes
  exactly `merge_commit_sha` (one occurrence; no `merged_commit_sha` exists) —
  the original probe's F7 line queried a misnamed key, which jq fabricates as
  `null`. The field is populated; F7 stays closed, now on live evidence.
- Merge #2 (`49cf623`) message composes identically
  (`…'Second module (lowercase merge probe)' (#2) from feature/y into main`).

## 6. Tag v0.1.0; tags/releases surface; Release + attachment roundtrip — PASS

- Annotated tag `v0.1.0` ("v0.1.0 first reverify tag") → push →
  `* [new tag] v0.1.0`, exit 0; `/tags` → 200, lists v0.1.0.
- **F8 unchanged (expected):** `GET …/tags` still returns `"message":""` — the
  documented engine seam (the read-tag RPC the git-engine boundary does not
  carry); flagged for the v1.4 backlog, not a regression.
- `POST …/releases` → **201** (id 6). **F9 fix verified:** the release DETAIL
  page (`/releases/tag/v0.1.0`, 200) renders the upstream-shaped two-item
  menu — `1 Release` (active) + `1 Tag` (plain link to `/tags`) — matching
  upstream's every-`tplReleasesList`-render rule incl. `SingleRelease`.
- Attachment: `POST …/releases/6/assets?name=e2e-attachment.txt` (multipart)
  → 201; anonymous download via the returned `browser_download_url`
  (`/attachments/85e12c72-…`) → **byte-identical** to the uploaded 39-byte
  file (sha256 `ebf2d6ce…`); asset list API `{name,size}` correct; the release
  page renders the attachment.

## 7. LFS — PASS (plumbing + the landed badge)

- `git lfs track "*.bin"`, 1,024-byte `big.bin` (random bytes) committed and
  pushed; the git blob stored server-side is the pointer
  (`version https://git-lfs.github.com/spec/v1`, `oid sha256:eafb7131…`,
  `size 1024`).
- **F3 fix verified (bonus):** the web file view (`/src/branch/main/big.bin`,
  200) now renders `<span class="file-info-size">129 B</span><span
  class="ui label">LFS</span>` — the `file_info.tmpl` LFS badge, present even
  for a pointer with no meta row (the probe's parse-only port of
  `view.go:72-123`).
- `/media/branch/main/big.bin` → 200, `application/octet-stream`, 1,024 bytes,
  **sha256 identical** to the original (`eafb7131…`).
- `/raw/branch/main/big.bin` → 200 `text/plain` serving the **pointer** — this
  is now CONFIRMED upstream-faithful at the pin: upstream wires
  `SingleDownload` (not `SingleDownloadOrLFS`) on the `/raw` group
  (`web.go:1705-1712`); the original F4's cite was the `/media` line. The
  divergence stands corrected and documented (f561d92), with the pointer-parity
  regression pin in place.
- LFS batch API: `POST …/.git/info/lfs/objects/batch` (basic auth,
  `application/vnd.git-lfs+json`) → 200 with a valid `download` action (href +
  `Authorization` header); fetching the href with that header returns the exact
  original bytes (sha256 match). Note: the response omits the echoed
  `"transfer"` field upstream includes — cosmetic, the git-lfs client
  roundtrips fine; not raised to a finding.
- Fresh `git clone` with smudge materialized `big.bin` **byte-identical**
  (sha256 `eafb7131…`) — the full pointer→content path works end to end.

## 8. Protected branch — PASS

- `POST …/branch_protections` `{"branch_name":"main","rule_name":"main",
  "enable_push":false,…}` → **201** (id 71), full upstream-shaped rule echoed.
  `/branches` shows the `octicon-shield` badge.
- Direct push to protected `main` → `! [remote rejected] main -> main
  (Not allowed to push to protected branch main)`, git exit 1 —
  upstream-identical rejection text.
- Unprotect `DELETE …/branch_protections/main` → **204**, list empties, direct
  push succeeds again (`a832569..c9bb049`).

## 9. Wiki — PASS (all four original F5 arms resolved)

- `git clone …/git-e2e-scratch-1030.wiki.git` → clean empty-clone; advertised
  HEAD `refs/heads/main`; pushed `Git-E2E.md` on `main` →
  `* [new branch] main -> main`, exit 0.
- Wiki page `/wiki/Git-E2E` → **200**, renders the pushed content.
- **F5 arm 1 FIXED — Wiki tab:** the repo navbar now carries the Wiki tab
  (`href="…/wiki"` `data-shortcut-keys="g w"`, `octicon-book`), so the wiki is
  reachable by navigation, not just direct URL.
- **F5 arm 2 FIXED — `_pages` lives:** `/wiki` → 303 →
  `/wiki/?action=_pages` → **200** (the first probe got 404 here);
  `/wiki/_pages` → 303 into the same 200 view; the pages list shows Git-E2E.
- **F5 arm 3 re-classified upstream-faithful:** `/wiki/Home` → 303 → `_pages`.
  Upstream's `wiki.go` redirects ANY missing page to
  `/wiki/?action=_pages` (`if noEntry { ctx.Redirect(… + "/wiki/?action=_pages") }`),
  and upstream's `InitWiki` seeds NO `Home.md` — it only creates the empty wiki
  repo; `Home` is the default NAME of the web NewWiki form (whose prefill
  f561d92 fixed to `wiki.go:652-663` parity). A git-push-initialized wiki with
  no Home behaves identically on upstream. Not a defect.
- **F5 arm 4 / F10 documented (premise corrected):** the wiki's HEAD/default
  branch is `main`; upstream at this pin also defaults wiki to `main`
  (`DefaultWikiBranch`) — the original doc's `master` claim was corrected and
  documented in f561d92. A fresh clone advertising `main` is upstream-faithful.

### Client-side mishap (disclosed; zero instance involvement)

After PR #2's merge, `git pull origin main` was run while `feature/y` was
still checked out — it fast-forwarded `feature/y`, and the subsequent LFS
commits landed there, so the first `git push origin main` was rejected
non-fast-forward (correctly). Fixed locally by ff-merging `feature/y` into
`main` and pushing (`49cf623..a832569`). The server behaved correctly at every
step of the detour.

---

## 10. Findings index (this re-verification)

No new HIGH/MEDIUM findings. Residual/disposition table vs the original F1-F11:

| # | Original sev | Disposition after re-verify |
|---|--------------|------------------------------|
| F1 | HIGH | **FIXED** — `Do`/`MergeTitleField`/`MergeMessageField` accepted (200); lowercase still accepted; PR #2 cross-check green |
| F2 | HIGH | **FIXED** — default `Merge pull request '<title>' (#N) from <head> into <base>` on both merges; all four surfaces verified |
| F3 | med | **FIXED (bonus)** — LFS badge renders in the file view (`<span class="ui label">LFS</span>`) |
| F4 | med | **CLOSED upstream-faithful** — `/raw` serves the pointer by design at the pin (`SingleDownload`); `/media` resolves; documented with regression pin |
| F5 | med | **RESOLVED** — Wiki tab landed; `_pages` 200; missing-Home redirect and no-seed are upstream-identical; NewWiki Home prefill landed (not re-probed via UI form) |
| F6 | minor | **FIXED (echo)** — description echoed in the 201; `id:0` remains the documented structural seam |
| F7 | minor | **CLOSED, live-verified** — `merge_commit_sha` populated; original line used a misnamed field (`merged_commit_sha` does not exist in upstream's swagger) |
| F8 | minor | **OPEN by design** — annotated tag message still `""`; documented engine seam, flagged for the v1.4 engine backlog (unchanged, expected) |
| F9 | minor | **FIXED** — releases DETAIL page renders the Releases/Tags sub-menu |
| F10 | minor | **CLOSED documented** — wiki default branch `main` is upstream-correct at this pin (original premise corrected) |
| F11 | low | not re-probed (out of the 9-step scope); API token auth was honored everywhere used |

Counts: 0 HIGH, 0 MEDIUM open; F8 remains the one open minor (documented,
intentional). Steps: 9/9 PASS at the git and API level.

## 11. What worked flawlessly (carried over, still true)

- Smart-HTTP throughout: `info/refs`, upload-pack, receive-pack with real
  `git 2.43` + `git-lfs 3.4.1`, token-as-username URLs.
- Unborn-HEAD advertisement on empty clones (client lands on `main`), wiki
  clone included.
- LFS push → batch API → fresh-clone smudge byte-identical; `/media` resolves.
- Protected-branch rejection text and semantics; unprotect restores push.
- Release attachment upload/download byte-identical; anonymous attachment URLs.
- Branch/compare/commits/PR web pages render upstream-shaped HTML with correct
  per-file commit attribution.

## 12. Deployment-posture notes

- Version string `29.0.0+dev-208-gfc49368845` is identical to the pre-fix
  probe — `GET /api/v1/version` cannot distinguish the fixed build; future
  probes should not treat it as evidence either way.
- The demo banner is live (ADR-0005 demo posture): "This is a demo instance:
  data on this instance is periodically cleaned."

## 13. Cleanup — done and verified

- Repo deleted via API (`DELETE /repos/p0probe/git-e2e-scratch-1030` → 204).
  Cascade verified: repo page, wiki page, and attachment URL all **404**
  afterwards.
- PAT row deleted from remote D1 (`DELETE FROM personal_access_tokens WHERE
  prefix='cfg_60429c55'` → applied; re-select count 0); the minted token now
  returns **401**. The pre-existing `p0probe` user (id 4) was left untouched.
- Token files shredded (`shred -u`), `/tmp/git-e2e-rev-work` clones (remotes
  carried the embedded token) removed, all `/tmp/e2e-rev-*` probe artifacts
  deleted; a grep sweep confirmed no remaining token-bearing files.
