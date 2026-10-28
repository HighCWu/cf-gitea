# Wave-130 Parity Review — Scoreboard

The wave-130 review wave: five parallel reviewers swept the landed surface for
upstream-parity defects while REDEPLOY22 shipped (GO `5f3c26f` → deploy version
`73158aa8`, 2026-10-28 ~01:5x — the deploy coincided with the kickoff; the review
baseline's evidence block is `7bec99e` in `docs/design/p0-evidence.md`). The reviewers'
SUSPECT findings drove the fix wave that followed: **15 commits** (`28df818` →
`bd6d257`, 2026-10-28 07:28–08:46) landing **30 findings**, with **7 deliberate keeps**
verified against upstream source and documented instead of "fixed".

Provenance note: this scoreboard is condensed from the **landed record** — the five
reviews' findings are cited by the fix-wave commits themselves (each commit names the
review and finding numbers it lands). Where this doc enumerates a finding, the commit
message and the pinned tests are the authority; the reviewers' original verdict text
lived in the session, not the tree.

## Scoreboard

| Review | Scope | Landed | Deliberate keeps | Fix-wave commits |
|---|---|---|---|---|
| Auth review | SPEC-0002 middleware + SPEC-0010 session | 4 | 5 | `28df818`, `32eaa73` |
| API review | `/api/v1` error shapes, visibility, serializers | 13 | 2 | `d5b111d`, `b36a615`, `3f48b74`, `3e8640c`, `3d5c9d0`, `43ddf62` |
| Engine review | engine read/write paths (c1–c6) | 6 | 0 | `140fc0b`, `5539eb9`, `809d0be` |
| Services review | issues/orgs service layer (S1–S3) | 3 | 0 | `d5b111d`, `84da8f8` |
| Git-HTTP review | SPEC-0003 gate + push-settle | 4 | 0 | `0626ced`, `f305dd4` |
| **Total** | | **30** | **7** | 15 commits, `28df818` → `bd6d257` (the tail `bd6d257` is the wave's test-only gate ripples) |

`d5b111d` carries two reviews' cargo at once (disclosed in both commits): the services
review's S1 cascade sweep and the api review's S1 route hunk (`b36a615` lands that
guard's test arms).

## 1. The 30 landed findings

### Auth review (4)

| # | Finding | Commit |
|---|---|---|
| L1 | Session-rotation cookie directive: `/login`'s rotation arm sent a **bare** `id:secret` Set-Cookie (no name/attrs) — the browser never adopted it, and past the 60 s grace reuse-detection deleted the row: merely visiting `/login` signed-in after 24 h logged the user out (the review's HIGH). All three rotation sites now wrap through `sessionSetCookie` with the row's remember bit; route-level round-trips prove the *adopted* cookie authenticates the next request | `28df818` |
| L2 | Remember persistence: `sessions.remember` (migration 0035 `spooky_galactus`, additive) — mint threads the login form's decision, the rotation CAS never touches the column, and a remembered user keeps `Max-Age=2678400` across rotations (upstream `auth.go:127`'s posture; SPEC-0010 §2.3/§2.4 amended) | `28df818` |
| L3 | `sudo()` mounted tree-wide immediately after `resolveAuth` (upstream's own tree-wrap, `api.go:1872` — credential resolution → impersonation → every gate); the route trio pins impersonate / 403-verbatim / 404-verbatim through the real mounted chain | `32eaa73` |
| L4 | Public-only enforcement wired: `rejectPublicOnly` (POST-only arms realized), `doerTokenAllowsOwner`, the userAssignment masked-404 arm — the placement table mounts each upstream group cite-for-cite, never blanket-applied | `32eaa73` |

### API review (13)

| # | Finding | Commit |
|---|---|---|
| L5 | **S1** — merged-PR state-change guard: ANY `state` field on a merged PR answers 412 *before* the value is examined (`issue.go:810-817`; scope verified wider than briefed). Route hunk in `d5b111d`, the four arms in `b36a615` | `d5b111d` + `b36a615` |
| L6 | **S3** — user-not-exist error format: 404 `user does not exist [uid: 0, name: X]` (APIErrorAuto's ErrNotExist unwrap, `user/error.go:46-58`); the search owner keeps its declared 400 but gains the format | `3e8640c` |
| L7 | **S4** — user-directory visibility ladder: `isUserVisibleToViewer`, the exact `IsUserVisibleToViewer` reduction (admin/self; public; limited → ANY signed-in; private → follower or org co-member via the self-join); `userGet` fake-404s invisibles byte-identical to a miss; `searchUsers` filters individuals + `BuildCanSeeUserCondition` | `3f48b74` |
| L8 | **S5** — the org-type leak: serializers render real `type`/`visibility` (orgs → `Organization`) | `3f48b74` |
| L9 | **S7** — contents 404s join the ErrNotExist family: both misses share `object does not exist [id: …, rel_path: …]` with the segment-granularity walk (the review's hypothesized mapping corrected on verification) | `3e8640c` |
| L10 | **S8** — pin_order loads the real order (LoadPinOrder's twin; -1 → 0): the pin trio's reads finally match | `3e8640c` |
| L11 | **S9** — unknown 40-hex oids → 404 through the existence-probed resolver (`commits.go:211-216`) instead of `200 []` | `43ddf62` |
| L12 | **S11** — serializer unification: `toApiUser` delegates to the canonical `apiUserFromRow` (one body, zero drift); flags go authed-gated | `3f48b74` + `43ddf62` |
| L13 | POST-pulls edges: milestone probe BEFORE the deadline parse (both-bad → 404 not 400), the bare-404 race-typed catch arm, tag/sha base-head → 422 with the oid arm made existence-based | `43ddf62` |
| L14 | `assigned_by`/`mentioned_by` resolved in upstream's order (`issue.go:398-406` — unknown → 404 `[uid: 0, name: X]`; resolved-but-untracked still matches the empty set via `matchesEmpty`) | `3d5c9d0` |
| L15 | `project_issues` joins the delete cascade (`issue.go:246`; the accepted-deltas count corrected) | `43ddf62` |
| L16 | The HEAD-file route computes the rows-4/5 grant like its siblings (the hardcoded `false` gone) | `43ddf62` |
| L17 | The uniformity sweep: `repo-extras-t2`'s local error fn deleted for the canonical `userNotExistError` (`collaborators.go:282-288` verified); migrate's message shape aligned + the uid arm's verbatim `[uid: X, name: ]` render; the blob-at-intermediate arm finally has its fixture | `3d5c9d0` |

### Engine review (6)

| # | Finding | Commit |
|---|---|---|
| L18 | **c1** — PR head-sync: pushes move `refs/pull/N/head` (standalone post-commit CAS from the onPush fan-out; upstream's `UpdatePullsRefs` shape) with D1 CAS on head_sha/status/divergence, the type-29 comment, and the sync webhook; the head-branch DELETE arm closes each open PR + type-11. Before it, merges operated on stale code — a second push then merge produced the WRONG tree (gold) | `140fc0b` |
| L19 | **c2** — `resolveNamedRef` goes STRICT: the 8-consumer verdict table showed ALL strict, ZERO legitimate defaults, so the `fallbackDefault` param was deleted outright (no future caller can reintroduce the existence oracle); unknown non-hex refs answer their verified upstream shapes | `5539eb9` |
| L20 | **c3** — PR-commits + compare ranges walk bounded windows and page from the NEWEST side (git-log order; `X-HasMore` combines the reversed math with the truncation flag) | `809d0be` |
| L21 | **c4** — null merge base → early EMPTY exactly upstream (`compare.go:91-93`; the baseCommit fallback gone) | `809d0be` |
| L22 | **c5** — the commit download's `.patch` drops the signature tail (`--no-signature`, `diff.go:99`) while compare/PR patches keep it (both upstream arms verified signature-default) | `809d0be` |
| L23 | **c6** — force-push stale marking reads both sides gate-free through the merge-family RPCs (same-base+same-tree = untouched, either moved = stale; conservative direction documented) | `809d0be` |

### Services review (3)

| # | Finding | Commit |
|---|---|---|
| L24 | **S1** — the issue delete cascade's full sweep: upstream's DeleteBeans set, all seven tier-2 tables (`issue_content_history`, `issue_dependency` both directions, `issue_assignees`, `notification_states`, `stopwatches`, `tracked_times`, `issue_attachments`) + their R2 objects (storage-first, retryable) | `d5b111d` |
| L25 | **S2** — `removeMember` revokes the team grants (upstream `user.go:88-96`'s delete-member-in-their-teams loop) with guarded `num_members` decrements chained behind the last-owner guard; the round-trip proves a two-team writer loses write AND the gate's 200 becomes the row-9 404 mask immediately | `84da8f8` |
| L26 | **S3** — `deleteOrg` sweeps `team_repo_access`/`team_members`/`teams` child-first; the stale no-rows docstring replaced | `84da8f8` |

### Git-HTTP review (4)

| # | Finding | Commit |
|---|---|---|
| L27 | Tag-only push-create survives (the DATA-LOSS fix): upstream verified line-by-line — `pushNewBranch` is branch-only and the post-receive path has NO deletion arm — so the undo predicate is now "zero refs of ANY namespace" and the new tag-only arm CAS-flips a creating row to ready; the round-trip pushes `refs/tags/v1` to a nonexistent repo → 200, the row survives, the tag reads back through the advert AND the REST tags API | `0626ced` |
| L28 | **S1** — the wholesale receive-pack 403 for blocked pushers removed (upstream declines only via agit `refs/for/*`); a blocked user with a write grant pushes directly upstream; the decline's future home documented at the agit seam | `f305dd4` |
| L29 | **S3** — the unknown-repo POST arm consults `getOrgByUsername` + `canCreateOrgRepo`: a granted member push-creates under the org (row lands `ownerNamespace=org`, settle flips ready); non-granted keeps the masked 404 | `f305dd4` |
| L30 | **S4** — every non-collision create error converts to upstream's bare 404 (`githttp.go:235-240`); `a..b` no longer 500s | `f305dd4` |

Test-only follow-through (not counted as findings): `bd6d257` (the uniformity sweep's
migrate-message change rippled into two UI migrate suites' re-render pins; the
date-rolled admin-users golden re-baselined) and `3d5c9d0`'s blob-arm fixture.

## 2. The 7 deliberate keeps

Verified against upstream source during the fix wave and kept, with the rationale
recorded (K1/K3/K4/K5 live in the SPECs; see the pointers):

| # | Keep | Rationale (one line) | Recorded |
|---|---|---|---|
| K1 | POST-issues validates `labels`/`milestone` refs where upstream silently drops/ignores them (the api review's S2) | Fail-loud beats silent-drop for an API born without upstream's history — a mistyped ref earns an immediate 404 instead of a 201 whose payload quietly lacks it; tests pin it | SPEC-0004 §2.4 |
| K2 | migrate keeps 422 with upstream's own `err.Error()` body | The review brief hypothesized otherwise; `migrate.go:72-75` explicitly answers at 422 — the code outranks the brief | `3d5c9d0` |
| K3 | `last_used_at` null-vs-zero-time | Token wire is byte-identical via the `GO_ZERO_TIME` convention (upstream's zero `time.Time` marshaling); the NULL-vs-0 storage split and the keys' created-at rendering are documented, not worth churn | SPEC-0002 §4.6 #13 |
| K4 | Token name > 255 rejected at the service layer (the invented-but-sane client-error arm) | Upstream binds `Required` only and lets a too-long name die in the store (500 on strict backends, silently accepted on SQLite); a 4xx before any D1 write is strictly saner | SPEC-0002 §4.6 #14 |
| K5 | Webhook delivery `skipped`/`failed` terminal states render `is_delivered=false` | Our state machine's extra marks map down onto upstream's `ToHookDelivery` non-attempt posture exactly — wire parity for every state upstream knows | SPEC-0002 §4.6 #15 |
| K6 | `contextAuthenticatedUser`'s whole-`/user` middleware wrap deliberately unwired | Upstream-parity placement exists but no current route family needs it; blanket-application was rejected — the placement table mounts cite-for-cite only | `32eaa73` |
| K7 | `reqOrgOwnership`'s inner gate deliberately unwired | Same policy: mounted only where an upstream group actually carries it; documented for the next wave that adds one | `32eaa73` |

## 3. Credits — the reviews' gold

The five reviews earned their keep five times over; each of these was a real
production-grade defect, not a style nit:

1. **PR-sync** (`140fc0b`, engine c1): pushes never moved `refs/pull/N/head` — every
   merge after a second push operated on stale code and produced the wrong tree. The
   fix carries upstream's full posture (CAS head move, re-armed checking, divergence
   recompute, type-29 comment, sync webhook).
2. **Tag-only deletion** (`0626ced`, git-http): pushing ONLY a tag to a nonexistent
   repo deleted the just-created repo row — silent data loss on the repo-creation
   path. The settle's three-arm contract now keeps the row (upstream-verified:
   upstream itself keeps it).
3. **Org revocation** (`84da8f8`, services S2): removing an org member left their team
   grants live — a revoked member kept write access through the real gate on both
   repos. Now revoked immediately, with the deleteOrg sweep behind it.
4. **Session cookie** (`28df818`, auth HIGH): visiting `/login` while signed in after
   24 h silently logged the user out (the bare rotation Set-Cookie was never adopted;
   reuse detection then deleted the row). Fixed at all three rotation sites, with the
   remember bit persisted (migration 0035).
5. **GPG time-bomb** (`50880b2`): the GPG verify test chain died whenever RSA sign +
   fetch crossed the signature token's single-minute boundary — a real time-bomb (2-of-4
   full runs plus once solo) caught by the review wave's verdict runs, guarded with ≥55 s
   of slack; zero product change.

## 4. Gate record

Every fix-wave commit reports its own scope suites green plus `tsc`/`lint` zero and
`check-openapi` PASS (quoted verbatim from the commit messages — this scoreboard
quotes, it does not re-run; each landing's Tests line was verified per the AGENTS.md
pre-commit checklist at commit time). The wave's gate ripples (`bd6d257`)
folded the two UI migrate pins + the date-rolled admin golden the sweep shook loose.
The standing full-suite verdict remains `pnpm test:full` (ADR-0006), not
any per-scope citation here.
