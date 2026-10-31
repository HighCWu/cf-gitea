# Render wall-clock audit (wave-129)

Three golden waves independently skipped surfaces over one mechanism: wall-clock
bytes reaching rendered output. This audit sweeps the worker's render-path
modules for `Date.now()` / `new Date()` that flows into rendered bytes
(TimeSince `tense`, formatted feed channel stamps, commit stamps), classifies
every site, and lands the cheap seams.

Classes:

- **(a) test-injectable already** — a `now` parameter the loader takes (or a
  draft/seed field), so fixtures can pin the bytes without code changes.
- **(b) cheaply injectable** — the module calls the clock internally; the fix
  is one seam: an optional `now` defaulting to `Date.now()`, callers unchanged.
- **(c) structurally hard** — the stamp is written into *stored* objects (git
  commits, rows fed by emitters with no field), so fixtures cannot pin it at
  the render site; it needs a write-path change or a fixed-time writer.

## The audit table

| Site | Bytes it renders | Class | Action |
|---|---|---|---|
| `ui/page-data.ts` `timeSinceParts` — internal `Date.now()` feeds only `tense` (`datetime`/`text` are pure) | `tense="past\|future"` attribute on every `<relative-time>` (`components/file-list.tsx`, `pages/issue-content-fragments.ts`, `pages/settings.tsx`) | (b) | **Seam landed**: third optional param `now: number = Date.now()` |
| `ui/pages/releases-feed-xml.ts` `loadReleasesFeedData` — internal `Date.now()` → `generatedUnix` | channel `<pubDate>` (RSS) + `<updated>` (Atom) | (b) | **Seam landed**: trailing optional `now: Date = new Date()` |
| `ui/pages/tags-feed-xml.ts` `loadTagsFeedData` — same shape | same channel stamps | (b) | **Seam landed**: same trailing param |
| `ui/pages/user-feed-xml.ts` `loadUserFeedData` — same shape | same channel stamps | (b) | **Seam landed**: same trailing param |
| `services/issue-events.ts` `emitIssueEvent` — action drafts carry no `createdAt` (`issueActionDraft`), so `recordAction` stamps `new Date()` into feed rows | profile-activity / user-feed TimeSince over `action.created_at` | (b) at the emitter (`recordAction` itself is (a): `draft.createdAt ?? new Date()`) | **Seam landed**: `emitIssueEvent(request, emission, { now })` — one clock forwarded to BOTH the delivery rows (`emitWebhookDeliveries`' existing `options.now`) and the action draft's `createdAt` |
| `ui/pages/admin-monitor.tsx` `loadAdminMonitorCron(now: Date)` — the Next Time column | cron table Next Time bytes | (a) — loader takes `now`; the GOLDEN is blocked one hop up: `ui/index.ts:6640,6659` hardcode `new Date()` | none (index.ts out of wave-129 ownership — see follow-ups) |
| `ui/pages/admin-dashboard.tsx` `loadAdminDashboardData(now: Date)` | dashboard rendered times | (a), same route-layer caveat | none |
| `ui/pages/activity-author-data.ts` (`options.now ?? new Date()`) | activity period window | (a) | none |
| `ui/pages/milestones.tsx`, `milestone-detail.tsx`, `global-inbox.tsx`, `user-settings-applications.tsx`, `user-settings-keys.tsx`, `repo-settings-deploy-keys.tsx` loaders (`now: Date = new Date()`) | over-due / added stamps | (a) — the house convention this audit extends | none |
| `api/services/activity-feeds.ts` `recordAction` (`draft.createdAt ?? new Date()`) | action rows | (a) | none |
| `services/wiki.ts` `wikiPerson` — `Date.now()` into author/committer of wiki commit objects | wiki view's last-edited TimeSince + commit oid | (c) — stamped into STORED git objects (engine/R2); the view reads the stored commit, so no render-site fixture can pin it | documented; follow-up below (sized, NOT implemented) |
| `api/routes/repo-extras-t2.ts` `mergePersonOf` / `api/services/pull-engine.ts` `mergePerson` — `Date.now()` person stamps | merge-commit author/committer → commit-list TimeSince bytes | (c) — same stored-git-object class as wiki (note: `pull-engine`'s `MergeInput` already carries `now: Date`, but `mergePerson` ignores it) | documented; same follow-up family |
| Write-path stamps across `ui/pages/*.tsx` / `api/routes/*` / `api/services/*` (`updatedAt`/`createdAt` inserts, e.g. `repo-create.tsx`, `pull-reviews.tsx`, `branch-protections.ts`) | stored metadata that some pages later render | (a-via-seeds) — goldens seed D1 directly with fixed stamps, so these never block | none |
| `api/routes/admin-degenerate.ts:339` `toApiCron(task, new Date())`; `account-aggregates.ts` / `misc-t3.ts` / `user-read-t2.ts` heatmap minute-cutoffs | API-tier JSON timestamps | route-layer clocks over JSON, not HTML/feeds — out of this audit's render scope; same follow-up family | none |
| `ui/session.ts`, `web/attachments-serving.ts` (`resolveOptionalCredential`) | auth limiter / token-verify clocks — no rendered bytes | n/a | none |

## Golden surfaces this unlocks

- **admin-monitor cron golden** (LANDED `df348c8` — no longer skipped): the
  loader seam already existed; the route call site now reads the harness
  route clock (follow-up 1), so the Next Time column pins under
  `__setRouteClockForTests` through the real route.
- **Feed goldens** (`/{owner}/{repo}/releases.rss|.atom`, `tags.rss|.atom`,
  `/{owner}/atom`) — LANDED: the RSS trio (`abd512f`) and the `.atom` twins
  (the P3-2(a) closure) render through the real routes under the same
  pinned clock, all six envelopes fixture bytes.
- **Profile-activity-style goldens without the post-hoc UPDATE**: the
  emitter seam lets any suite driving `emitIssueEvent` pin the action-row
  stamps at write time (proven by the new now-arm in
  `src/services/issue-events.test.ts`), replacing the
  `UPDATE actions SET created_at = T0` fixture pin in the golden beforeAll.
- **timeSinceParts `tense` pinning**: unit suites can now render a
  `tense="future"` arm (previously impossible — the clock decided); the
  relative-time byte surfaces (`file-list`, content history, settings) are
  fully fixture-pinnable at the unit layer.

## Recommended follow-ups (not in this wave)

1. **Golden-harness route clock (index.ts-owned) — LANDED <pending> (the
   orchestrator fills the landing hash).** The three golden skips converged
   on `ui/index.ts` call sites hardcoding `new Date()`. Landed as the
   module-scope, test-only `ROUTE_CLOCK` + `__setRouteClockForTests` seam
   (`routeNow()`, null = exact wall clock — no request-visible surface
   change): the admin-monitor cron golden un-skipped (`df348c8`), the feed
   XML goldens landed on the same seam (RSS trio `abd512f`; the `.atom`
   twins — `releases.atom`, `tags.atom`, `/{owner}.atom`, the audit's list
   here — the P3-2(a) closure). The admin-monitor-cron golden's CURRENT
   red is a later landing's stale fixture (`a63adfb` landed the per-row
   Run buttons without regenerating it), not this seam.
2. **Wiki fixed-time object writer (sized, NOT implemented).** `applyWikiChanges`
   stamps `wikiPerson`'s clock into stored commits; a fixed-time variant would
   (i) thread `now?: Date` through the wiki service write API
   (`saveWikiPage`/`deleteWikiPage` and their route/session callers), and
   (ii) give the golden seed a raw-object writer path (write the wiki commit
   with a pinned author/committer time around the landed service — the
   goldens.test.ts skip note's "not trivially file-local" caveat). Sizing:
   the service signature change is small, but the seed path needs engine-level
   object writes, so it is a wave of its own. Same family: route
   `MergeInput.now` into `pull-engine.mergePerson` (and the
   `repo-extras-t2.mergePersonOf` twin) so merge commits share the flow's
   clock.
3. **API-tier route clocks** (cron `toApiCron`, heatmap cutoffs): same
   harness-clock follow-up if API JSON goldens ever land.

## Seams landed (this wave)

- `src/ui/page-data.ts` — `timeSinceParts(unixSeconds, tz, now = Date.now())`.
- `src/ui/pages/releases-feed-xml.ts` — `loadReleasesFeedData(..., now = new Date())`.
- `src/ui/pages/tags-feed-xml.ts` — `loadTagsFeedData(..., now = new Date())`.
- `src/ui/pages/user-feed-xml.ts` — `loadUserFeedData(..., now = new Date())`.
- `src/services/issue-events.ts` — `emitIssueEvent(request, emission, options?)`
  forwards `options.now` to `emitWebhookDeliveries` and the action draft.
- `src/services/issue-events.test.ts` — one now-arm (the suite already pins
  time behavior via fixed seed stamps): the injected clock lands in BOTH the
  delivery rows and the action rows.

All seams are additive-optional: every existing caller is byte-identical.
