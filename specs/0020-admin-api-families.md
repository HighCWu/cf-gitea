# SPEC-0020: The admin API families — the gap-fill queue #6 reconciliation (cron / system hooks / unadopted / packages)

Status: **accepted** (as-built recorded 2026-10-31) ·
Date: 2026-10-31 ·
Reconciles the gap-fill queue's #6 batch — the four admin API families queued
as "still missing from our surface" — against the frozen 554/554 operation
contract (`apps/worker/src/compat/contract/v1-swagger.generated.json`, the
verbatim copy of the vendored swagger at the pinned submodule commit) and the
pin's own route table (`gitea/routers/api/v1/api.go` `/admin` group,
fc4936884584).

Home note: SPEC-0018 was the mission's suggested home, but its scope
explicitly excludes `/api/v1` surfaces ("Out of scope: Any `/api/v1` surface
for the three arms — upstream has NONE at this pin", SPEC-0018 §1) — that
SPEC owns the web-UI arms (notices / config / auths). This file is therefore
the new small SPEC for the admin API families, disclosed per the mission.

---

## 1. Problem and scope

The queue's #6 mission listed four admin API families as missing:

1. cron tasks — `GET /api/v1/admin/cron` + `POST /api/v1/admin/cron/{task}`;
2. system webhooks — the `/api/v1/admin/hooks` CRUD + "the test-delivery arm";
3. unadopted repos — `GET /api/v1/admin/unadopted` (+ pagination/search) +
   `POST/DELETE /api/v1/admin/unadopted/{owner}/{repo}`;
4. admin packages — `GET /api/v1/admin/packages/{owner}` +
   `DELETE /api/v1/admin/packages/{owner}/{type}/{name}/{version}`.

The reconciliation verdict (§2): **every operation of all four families that
exists at the pin already exists in our surface** — declared, registered and
contract-checked before this SPEC. The gaps were WITHIN one family (the cron
render's live-state semantics, closed by this change, §4) and two mission
arms that DO NOT exist at the pin (pin-silent, §3 — reported, never built).

In scope: the per-family reconciliation verdicts (§2), the pin-silent arms
(§3), the cron family's as-built upgrade (§4), the unadopted disposition
(§5), tests (§6).

Out of scope (each named so it is not silently re-decided): the admin hooks
CRUD and admin packages list bodies (already landed in
`routes/hooks-scopes.ts` / `routes/packages.ts` — this SPEC touches neither);
`services/actions/**` producers (in-flight sibling ownership — the reason two
census arms are list-only, §4.3); `src/ui/pages/admin-monitor.tsx` (its
`RUNNABLE_CRON_ARMS` set lags this change's runnable map — §4.4 open item);
`src/api/router.ts` (orchestrator-owned; no wiring change was needed — the
module is already registered at router.ts:220).

## 2. The reconciliation verdict — per family, with cites

The pin's `/admin` group (routers/api/v1/api.go, the `m.Group("/admin", …)`
block) registers exactly 33 operations; the frozen contract carries the same
33; our router declares all 33 and `pnpm check:api` passes every one (the two
declared runtime-only codes — the cron-run 403, the unadopted-delete 404 —
are pre-existing `RUNTIME_ONLY_RESPONSES` entries). Per family:

### 2.1 Cron tasks — EXISTED (full; upgraded by this change, §4)

- Pin: `GET /admin/cron` → `admin.ListCronTasks`
  (routers/api/v1/admin/cron.go:14-52, renders the in-code registry with the
  live `Next/Prev/ExecTimes` triple, cron.go:119-127); `POST /admin/cron/{task}`
  → `admin.PostCronTask` (cron.go:54-74, unknown task 404, `task.Run()` then
  204). Our ops: `routes/admin-degenerate.ts` (registered router.ts:220).
- The gap this change closes: the landed render hard-coded the Go zero pair
  forever and listed a single-task registry, while the tree had since grown
  the real analogs — the scheduled dispatcher's arm census
  (`services/cron-state.ts` `CRON_ARMS`, 7 arms, migration-0044 `cron_state`
  store) and the admin monitor's cron page that already renders the census +
  recorded state. After a manual run upstream's subsequent list shows
  `prev` = run time and `exec_times` ≥ 1 (`RunWithUser` counts ExecTimes at
  start and stamps LastRun before the body — services/cron/tasks.go:95-115);
  our hard-zero render diverged from exactly that. §4 is the as-built.

### 2.2 System webhooks — EXISTED (full)

- Pin: `m.Group("/hooks")` — Combo "" Get `admin.ListHooks` / Post
  `admin.CreateHook`; Combo "/{id}" Get `admin.GetHook` / Patch
  `admin.EditHook` / Delete `admin.DeleteHook` (5 ops;
  routers/api/v1/admin/hooks.go over models/webhook's `repo_id=0 AND
  owner_id=0` global rows). Our ops: `routes/hooks-scopes.ts` (admin family
  of 5, over the landed `webhooks` table's NULL-adapted repoId/ownerId
  columns; SPEC-0005's dispatch path serves deliveries).
- **The "test-delivery arm" is PIN-SILENT**: the pin's admin group has NO
  test-delivery operation. The only hook test op at the pin is the
  repo-scoped `POST /repos/{owner}/{repo}/hooks/{id}/tests`
  (`repoTestHook`, routers/api/v1/repo/hook.go:247-249) — which our surface
  already has (`routes/hooks.ts`, with its own documented empty-repo-204
  divergence). An admin-scoped test arm was not invented (AGENTS.md:
  pin-silent = open question).

### 2.3 Unadopted repos — EXISTED (full, degenerate-but-honest)

- Pin: `m.Group("/unadopted")` — Get "" `admin.ListUnadoptedRepositories`,
  Post/Delete "/{username}/{reponame}" (3 ops; routers/api/v1/admin/adopt.go).
  Our ops: `routes/admin-degenerate.ts`.
- The landed disposition is the PIN'S OWN ANSWER, re-verified at this pin
  (adopt.go, both handlers): every miss branch converges on
  `APIErrorNotFound()` — unknown owner (`IsErrUserNotExist`), already-adopted
  (`has`), and not-on-disk (`!exist`). cf-gitea has no filesystem: the
  on-disk directory the two 204 arms require cannot exist, so the list is
  structurally empty (the honest-empty StringSlice, total 0) and adopt/delete
  unconditionally answer the pin's own 404 body. No change in this batch.

### 2.4 Admin packages — EXISTED (the pin's one op); the mission's two arms are PIN-SILENT

- Pin: `m.Get("/packages", admin.ListPackages)` — ONE op
  (routers/api/v1/admin/packages.go:19-64, `searchPackages` over
  `packages_model.SearchVersions` with type/q filters + pagination). Our op:
  `routes/packages.ts` `adminListPackages` (site-admin gated, full
  searchVersions + descriptor render + pagination headers).
- **`GET /admin/packages/{owner}` and
  `DELETE /admin/packages/{owner}/{type}/{name}/{version}` are PIN-SILENT**:
  neither path exists in the pin's route table nor in the frozen contract.
  Not invented; recorded here as the open question (§7) should a future
  re-pin add them.

## 3. The pin-silent arms (never built, never invented)

| Mission arm | Pin state | Disposition |
| --- | --- | --- |
| Admin hooks test-delivery | No such op at the pin (repo-scoped `/tests` only, hook.go:247-249) | Open question; our repo-scoped op already landed |
| `GET /admin/packages/{owner}` | No such path at the pin | Open question |
| `DELETE /admin/packages/{owner}/{type}/{name}/{version}` | No such path at the pin | Open question |

## 4. As-built — the cron family upgrade (this change)

### 4.1 Storage decision

NO new store. The design note's preference chain resolves at its first step:
the existing `cron_state` D1 table (schema.ts, migration 0044 — the
usability-F3 store `services/cron-state.ts` owns) IS the run-time store; the
scheduled handler's recorder already upserts it per entry, and the monitor's
cron page already reads it. `user_settings_kv` was rejected structurally (its
`user_id` FK NOT NULL scopes every row to a user/org principal — cron state
has no owner), and a new table would have duplicated a store that exists for
exactly these columns. Migration count stays at 0048.

### 4.2 The list render (`GET /admin/cron`)

- Registry source: `CRON_ARMS` (services/cron-state.ts) — the single census
  the scheduled recorder and the monitor key on, so an API row, its tick row
  and the monitor row cannot drift. Total = the census length (7), paginated
  upstream-style (`X-Total-Count` over the full set before the slice —
  cron.go:39-49).
- Field mapping (cron.go:119-127 + structs.Cron): `name` = arm, `schedule` =
  the wrangler expression verbatim (the census convention), `next` computed
  exactly for the census's two spec shapes (minute-step `*/10 * * * *` and
  hourly-at-minute `0 * * * *`; unsupported future shapes render the zero
  time, never a wrong time), `prev` = `cron_state.last_success` ISO or the
  Go zero time for a rowless arm, `exec_times` = `cron_state.runs` or 0.
- Disclosed granularity: upstream's `Prev` is a run START; the store's
  recorder is entry-atomic and records completion (the store's own module
  note) — the merge keeps the store's recorded truth rather than inventing a
  start-time column.

### 4.3 The run arm (`POST /admin/cron/{task}`)

- Gate: the runnable map (`CRON_RUN_BODIES`) — the census arms whose
  scheduled producer body is landed here: `update_mirrors`,
  `update_push_mirrors`, `demo_sweep`, `delete_old_audit_events`,
  `cleanup_packages` (all five imports into stable, ownership-clean modules:
  mirror/sync, mirror/push-sync, demo-sweep, audit, packages/cleanup — the
  packages import is the mission's explicit "import only" grant). A census
  arm NOT in the map (today `stop_zombie_tasks`, `cleanup_actions` — their
  producer modules live under `services/actions/**`, an in-flight sibling's
  forbidden ownership) answers the SAME `404 {"message":"not found"}` as an
  unknown task. That is the monitor's already-adjudicated arm verbatim
  ("a listed-but-unrunnable arm must answer task.unknown exactly like an
  unknown op — never run the wrong body", admin-monitor.tsx
  `RUNNABLE_CRON_ARMS`), and it keeps the API honest: upstream's registry is
  its runnable set; ours splits the scheduler census (7) from the API
  runnable set (5) because upstream is one process where we are two
  invocation kinds (fetch vs scheduled).
- Body: run the producer inline (each is a bounded probe + enqueue,
  "run = enqueue" — "crons enqueue, consumers do the work"), then record the
  manual tick via `recordArmsSuccess` AFTER the body, log-and-continue —
  the monitor's `applyAdminMonitorCronForm` shape, which cites upstream for
  counting manual runs in ExecTimes (tasks.go:95-97). A failed run records
  nothing (`recordArmsSuccess` is a COMPLETED tick) and still 500s through
  the shared error handler (the landed posture — upstream's recovered-panic
  arm always 204s; that difference is the standing "the enqueue is the run"
  adaptation's failure semantics, unchanged by this batch).
- Declared responses unchanged: `{204, 403, 404}` (the 403 stays the
  documented runtime-only exception).

### 4.4 Consequences and open items

- The monitor's `RUNNABLE_CRON_ARMS` set and its form's accepted ops lag
  this change (1 runnable arm there vs 5 here) and its comment ("exactly
  admin-degenerate.ts's CRON_TASKS run bodies") goes stale — its own
  extension rule says run capability extends BOTH sides "in one change";
  `src/ui/**` is outside this unit's ownership, so the UI half rides the
  orchestrator's landing window (§7).
- The census (7 arms) lags the dispatcher (the fifth/sixth sanctioned
  extensions added `stop_endless_tasks` and the abandoned/ephemeral block
  without joining `CRON_ARMS`, against the census's own join rule) —
  pre-existing drift in a file this unit does not own; recorded in §7.

## 5. The unadopted disposition (recorded, unchanged)

The landed trio IS the pin's answer for our storage model (§2.3): empty
list + unconditional 404 on adopt/delete. The mission's design note (c)
asked for exactly this call to be made from the pin and recorded — done
here; no behavioral change shipped in this batch.

## 6. Testing plan (as run)

`apps/worker/src/api/routes/admin-degenerate.test.ts` — 19 tests (was 15),
each verified green in the run log (19 passed / 19):

- admin gating (2): anonymous 401 body; non-admin 403 body on every op.
- adminCronList (3): the full 7-arm census render under upstream's Cron
  shape (names in census order, schedules verbatim, zero pair when nothing
  recorded, `next` computed per spec shape); the `cron_state` merge
  (prev/exec_times from seeded rows, rowless arms stay zero); pagination
  (page beyond the set → empty with total kept; limit=1 slice).
- adminCronRun (6): unknown task 404; listed-but-unrunnable arm 404 with
  nothing recorded; known task 204 with queue untouched and the tick
  recorded (runs=1); the due-mirrors enqueue CAS; exec_times increments
  across runs; the other four runnable arms each a quiet no-op that records
  its tick.
- unadopted trio (8, unchanged): the empty StringSlice with total 0 across
  pages/globs/registered-repos; the adopt/delete unconditional 404 bodies
  including the runtime-only declared 404.

Gates: `pnpm check:api` PASS (all 33 admin ops ⊆ contract; tier-1 78/78
paths, 129/129 ops); bare `tsc --noEmit` zero errors in this unit's files
(the tree's one remaining error is an untracked in-flight sibling file,
`services/packages/cargo.ts`, mid-edit — not this unit's); scoped eslint
exit 0 on both touched files.

## 7. Open questions / items for the orchestrator

1. The two pin-silent arms (§3) — revisit only at a re-pin that adds them.
2. The monitor's runnable-set lag (§4.4) — a `src/ui/**` edit for the UI
   owner: extend `RUNNABLE_CRON_ARMS` + `applyAdminMonitorCronForm` to the
   five runnable arms and refresh the comment that names this module.
3. The census-vs-dispatcher drift (§4.4) — a `services/cron-state.ts` edit
   for that module's owner: join `stop_endless_tasks` and the
   abandoned/ephemeral arms into `CRON_ARMS` (the census's own rule), which
   will grow this API's list and re-open the run-map question for their
   actions-family producers.
4. `router.ts` wiring: NONE needed — `registerAdminDegenerateRoutes` is
   already registered (router.ts:220) and this change altered no op surface.
