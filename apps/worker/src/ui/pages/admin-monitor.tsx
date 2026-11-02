/**
 * The ADMIN MONITOR family — `/-/admin/monitor/*` — the bench-row module
 * (wave 61; MOUNTED at e31c0cf, window-2c: the routes live in `index.ts` —
 * the retired wiring HANDOFF is the mount record at the bottom of this
 * header; the "no admin web surface" state below is the pre-mount record).
 * Sibling scope note at the two-stage landing: no admin web surface existed
 * then (`src/ui/pages/` had zero `admin-*` modules; the whole `/-/admin`
 * family was the parity survey's single ABSENT row,
 * docs/compat/ui-parity-survey.md:386), so this module carries the
 * monitor family alone and owns none of the dashboard/users/repos pages.
 *
 * ## Upstream surface (at the pin)
 *
 * The classic single `monitor.tmpl` dashboard no longer exists at the pin —
 * the monitor surface is the `/-/admin/monitor` route GROUP
 * (routers/web/web.go:796-813) of five navbar-linked sub-pages
 * (templates/admin/navbar.tmpl:106-124) inside the admin layout
 * (layout_head.tmpl: the `admin monitor` pageClass, `.ui.container.fluid
 * .padded.flex-container` wrapping the admin navbar + `.flex-container-main`;
 * every template opens `.admin-setting-content`):
 *
 *   GET /-/admin/monitor/stats       MonitorStats  (admin.go:256) —
 *         activities.GetStatistic().Counter JSON-marshalled into a sorted
 *         key/count table (stats.tmpl).
 *   GET /-/admin/monitor/cron        CronTasks     (admin.go:249) —
 *         cron.ListTasks() table with per-task run buttons POSTing
 *         `op=<name>&from=monitor` to the DASHBOARD route (cron.tmpl:7);
 *         DashboardPost (admin.go:154-194) runs the task and redirects back.
 *   GET /-/admin/monitor/queue       Queues        (queue.go:21-29) —
 *         queue.GetManager().ManagedQueues() table; the per-queue manage page
 *         (`/queue/{qid}`: set max workers, remove-all-items) hangs off it.
 *   GET /-/admin/monitor/stacktrace  Stacktrace    (stacktrace.go:23-40) —
 *         the trace page: "%d Goroutines, %d Processes" header over the
 *         process-manager stack list (+ the dev-only perftrace tab and the
 *         diagnosis-report download form, trace_tabs.tmpl).
 *   GET /-/admin/monitor/audit_logs  ViewAuditLogs — NOT ported (no landed
 *         audit-log store; the nav item is omitted — the dead-link rule).
 *
 * The whole group sits behind `verifyAuthWithOptionsWeb(&VerifyOptions{
 * SignInRequired: true, AdminRequired: true})` (web.go:779) — anonymous
 * → the login redirect, a signed-in non-admin → the 404 shell. That gate is
 * the ROUTE stage's posture (the module trusts its inputs like every landed
 * load function); upstream's admin settings navbar renders
 * `ctx.Locale.Tr "admin.settings"` as the menu header (navbar.tmpl:3).
 *
 * ## Data (§3.2 — the landed admin seams, never a self-fetch)
 *
 * What the landed backend can actually answer decided the family split below:
 *
 *   stats    COUNT queries over the landed D1 tables (Drizzle, the metadata
 *            source of truth) under upstream's exact counter key names — the
 *            landed-table subset of GetStatistic (models/activities/
 *            statistic.go:57-122). Omitted counters have NO landed table:
 *            Access (the ACL is computed, never stored), Branches/Tags (git
 *            refs live in the engine, R2 — no D1 rows), AuthSource (no
 *            external-auth store), UpdateTask (no update checker);
 *            IssueByLabel/IssueByRepository render upstream only behind the
 *            metrics settings (statistic.go:87,96) — the default-off arm.
 *   cron     the FULL landed arm census — `CRON_ARMS` (services/
 *            cron-state.ts, the usability F3 listing): one row per scheduled
 *            arm of the Worker's `scheduled` handler, mirroring
 *            handleScheduledCron's dispatch exactly (four arms on every
 *            10-minute step entry, nine producer arms on the hourly entry;
 *            the census block comment holds the per-arm upstream twin cites
 *            and the three cf-gitea-extension names). The per-arm tick state —
 *            Previous Time / Executions / Result, upstream's TaskTableRow
 *            Prev/ExecTimes/Status triple — comes from the `cron_state`
 *            table (migration 0044), which the scheduled handler upserts per
 *            entry (services/cron-state.ts; upstream keeps the same state in
 *            process memory — tasks.go TaskTableRow — a luxury no Workers
 *            isolate has). TWO loaders serve it: `loadAdminMonitorCron(now)`
 *            is the SYNC census render (never-fired posture for every arm —
 *            the shape ui/index.ts's route call sites use until their
 *            two-line swap to `loadAdminMonitorCronRunState(db, now)`, which
 *            merges the recorded state; the swap is the disclosed
 *            integration — ui/index.ts is outside this module's ownership).
 *            The run arm is the landed RUN-CAPABLE subset — exactly
 *            admin-degenerate.ts's CRON_RUN_BODIES (six runnable arms:
 *            update_mirrors, update_push_mirrors, demo_sweep,
 *            delete_old_audit_events, cleanup_packages,
 *            cleanup_hook_task_table; "run = enqueue"):
 *            the button renders only there and the five still-bodyless
 *            actions-family census arms render an empty first cell (never a
 *            dead control); a manual run records its tick too (upstream
 *            ExecTimes counts run STARTS — tasks.go:95-97 — and RunWithUser
 *            serves both triggers). The API registry's CRON_RUN_BODIES and
 *            this module's dispatch map hold the same names — extending
 *            run capability extends BOTH registries in one change (both
 *            modules' extension rules; the API-registry twin
 *            gained the cleanup_hook_task_table body in 2b15f6f's
 *            follow-up — both registries run every census arm now).
 *   queue    Cloudflare Queues expose no depth introspection and there is no
 *            in-process queue manager to enumerate — but the LANDED D1 state
 *            of the two queue-backed pipelines answers "number in queue" for
 *            them: the webhook delivery log's `pending|delivering` rows
 *            (SPEC-0005 §3.6, db/schema webhook_deliveries.state) and the
 *            pull-mirror producer's `queued|syncing` rows (SPEC-0009 §2.6,
 *            repo_mirrors.sync_state). The dead-letter queue
 *            (webhook-delivery-dlq, wrangler.jsonc consumers) has no landed
 *            counter at all — its row renders the `-` arm, queue.tmpl:27's
 *            own rendering for a countable-less depth (`{{if lt $sum 0}}-`).
 *   trace    NO source: the Workers runtime exposes no goroutine/process
 *            introspection and no landed port approximates the process
 *            manager. The page renders the honest-absence posture (below).
 *
 * ## DOM contract (templates/admin/*.tmpl at the pin)
 *
 * layout_head's pageClass is the literal `admin monitor` on every page. The
 * four pages render the layout verbatim: BaseLayout → the admin navbar
 * reduced to the monitor `<details class="item" open>` submenu
 * (navbar.tmpl:106-124, audit_logs omitted) → `.flex-container-main` →
 * `.admin-setting-content` with the template's `h4.ui.top.attached.header` +
 * `.ui.attached.table.segment` tables. stats.tmpl: two-column rows
 * (`<td width="200">{key}</td><td>{count}</td>`), header
 * `admin.dashboard.statistic` ("Summary"), keys sorted (admin.go:280-287).
 * cron.tmpl: the table lives INSIDE the run form (`method="post"`,
 * cron.tmpl:7-35) with the per-row `<button name="op" value="{name}"
 * title="Run">` glyph, columns Name/Schedule/Next Time/Previous
 * Time/Executions/Result, the Previous arm `-` until the first fire
 * (`{{if gt .Prev.Year 1}}`), the Result arm `—` while Status is empty and
 * the octicon-check / octicon-x pair (tooltip = the last message) when the
 * task HAS run (cron.tmpl:29), and the hidden `from=monitor`. queue.tmpl: reduced to the columns with landed
 * sources (Name/Type/Number in Queue — Exemplar Type and the worker counts
 * have no cf-gitea source) plus the per-queue Review link column and the
 * cf-gitea delivery-state breakdown segment; the links target the LANDED
 * manage page (the census gap-17 fold below). queue_manage.tmpl: the detail
 * table carries the same reduced columns; the remove-all-items form renders
 * ONLY on the one landed purge body (repo-tasks — the dead-control rule
 * narrows upstream's per-countable render); the DLQ's row is the
 * countable-less `-` arm (queue_manage.tmpl:29's own `{{if lt $sum 0}}`
 * posture); the Pool Settings form is OMITTED — no worker-pool knob, the
 * /set arm stays unclaimed. stacktrace.tmpl reduced to
 * the header + segment shape carrying the honest-absence note: no tabs, no
 * cancel `link-action`s, no diagnosis form (all dead without a source).
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - audit_logs: omitted from the submenu AND the family — no landed audit
 *   store (the survey row's config/notices/auths/emails siblings are equally
 *   out of this module's scope).
 * - The cron run button POSTs the PAGE URL (`/-/admin/monitor/cron`), not
 *   upstream's dashboard target (`AppSubUrl + "/-/admin"`, cron.tmpl:7) — the
 *   dashboard route landed since (the 2f7afe9 mount window) and this page-URL
 *   POST stands as the landed reduction. The POST
 *   answers upstream's DashboardPost posture reduced to the monitor arm: the
 *   flash message ("Started Task: %s" / "Unknown task: %s",
 *   admin.dashboard.task.*) re-renders the page (the no-JS hooks-page
 *   convention; upstream redirects back to monitor/cron with a flash).
 * - The run button renders ONLY on the run-capable rows (the five arms with
 *   landed run bodies — admin-degenerate.ts's CRON_RUN_BODIES posture):
 *   upstream renders one on every row because every registered task is
 *   runnable in its in-process scheduler; rendering ours for arms with no
 *   landed run body would POST into the task.unknown flash — the
 *   dead-control rule. The five actions-family census arms render an empty
 *   first cell.
 * - The Result cell renders upstream's THREE states from the recorded tick
 *   state: `—` while the arm never recorded (Status ""), the octicon-check
 *   after a completed tick ("finished"), the octicon-x with the stored
 *   one-liner as the tooltip after a failed entry ("error", cron.tmpl:29's
 *   data-tooltip-content arm — a plain attribute here, the Fomantic tooltip
 *   hydrates it client-side the same way). The manual run's tick rides the
 *   same store (upstream ExecTimes counts manual runs too, tasks.go:95-97).
 * - The delivery-state breakdown segment is a cf-gitea addition (marked in
 *   the locale block) — upstream's queue table has no per-state view, but the
 *   landed log carries the states and the depth number alone hides them.
 * - The queue manage page's qid is the QUEUE NAME (upstream's numeric qid is
 *   the in-process registry id — no cf-gitea counterpart; the Cloudflare
 *   queue name is the landed identity, wrangler.jsonc's queues.producer).
 * - QueueRemoveAllItems lands for repo-tasks ONLY: its `queued|syncing` rows
 *   ARE the pipeline's in-flight set (a message dead-lettered into
 *   repo-tasks-dlq leaves its row stuck `queued` forever — repos/dlq.ts acks
 *   without touching D1, and the stuck-syncing sweep reclaims `syncing`
 *   only, mirror/sync.ts:846-853 — while the cron producer's due-SELECT
 *   reads `idle` rows alone), so the purge resets them to `idle` and the
 *   next tick re-enqueues the due ones: upstream's "remove all items to
 *   make it work again" (queue.go:71-74), depth back to 0. webhook-delivery
 *   gets NO purge arm: its queue items are the webhook_deliveries rows
 *   THEMSELVES (upstream's arm removes queue items while PRESERVING the
 *   hook_task log — ours cannot separate the two), and the pipeline
 *   self-heals (the DLQ sweep marks stuck rows failed,
 *   webhooks/consumer.ts:30-32). The DLQ answers the unknown-queue 404 too
 *   (known but unmanageable — no landed counter, no substrate); its GET
 *   detail still renders, the countable-less `-` arm with no form.
 * - self_check (web.go:785-786) and system_status (web.go:782) stay
 *   UNCLAIMED — the recorded postures stand: system_status's fragment has
 *   its only consumer in the 5s-morph dl the dashboard module does not
 *   render (pages/admin-dashboard.tsx card 3: "stays UNMOUNTED"); self_check
 *   's three checks (setting.StartupProblems, the DB collation pair,
 *   cache.Test) all have no cf-gitea source — no startup-problem store, D1/
 *   SQLite has no server-collation mismatch class (upstream's fix hints
 *   render only for MySQL/MSSQL, self_check.tmpl:21-25), no cache layer —
 *   so the page would assert "no problem found" without any check having
 *   run; the family navs already omit the item (the dead-link rule).
 *
 * ## Platform arms (the 2026-11-01 MONITOR PLATFORM FREEZE — design frozen
 * by the user; Cloudflare-native adapters over the OFFICIAL APIs)
 *
 * The original reductions above REWRITTEN by the freeze — /set, perftrace/
 * pprof and diagnosis are Cloudflare-NATIVE ADAPTERS now, replacing the
 * recorded local-substrate claims:
 *
 *   /set      Cloudflare Queues DO carry the worker-pool knob: the consumer's
 *             max_concurrency (PUT /accounts/{a}/queues/{q}/consumers/{c},
 *             services/monitor/queue-concurrency.ts — the read → modify →
 *             write → GET-verify closed loop, preserving every untouched
 *             setting; null = the platform's auto arm). The Pool Settings
 *             form renders on the manage page when the SERVER-SIDE
 *             allowlist (the MONITOR_QUEUE_CONSUMERS var) carries the
 *             queue's entry; the UI shows the RUNTIME value (the verified
 *             GET) and the DECLARED value (the allowlist's
 *             declared_max_concurrency, mirroring wrangler.jsonc)
 *             SEPARATELY with a drift warning — the next `wrangler deploy`
 *             re-applies the declared config, so a runtime change is never
 *             silently permanent. Audit rows ride emitAudit (operator,
 *             before, after, API result, timestamp). Conflict-safety on
 *             concurrent edits is a DOCUMENTED FOLLOW-UP (SPEC-0021 §8),
 *             not built — the platform exposes no compare-and-swap; the
 *             verify step catches a lost update on the next read and the
 *             audit trail shows both writes.
 *   pprof     Workers Profiling API (POST …/workers/{worker}/versions/{v}/
 *             profile → a gzipped pprof; services/monitor/profile.ts): the
 *             trace page's Profiling form triggers cpu|heap captures bounded
 *             to the platform's 1..50 s and streams the .pprof.gz back as
 *             the download. Content validation splits per the freeze: the
 *             worker checks size + gzip magic; the deploy-probe battery
 *             (scripts/deploy-probes.mjs monitor-platform) owns the DEEP
 *             parse (gunzip → pprof protobuf → type/sampling sane).
 *   perftrace SEPARATE from profiling (request tracing ≠ CPU/heap
 *             capture): Workers Traces expose NO query API (dashboards,
 *             wrangler tail, OTel/Logpush export only — verified live
 *             2026-11-01), so the trace page's perftrace section states the
 *             enabled posture honestly (observability.traces is committed
 *             true) and links out — never a fabricated query arm.
 *   diagnosis GET /-/admin/monitor/diagnosis renders the COMPOSITE report:
 *             per-item SOURCE + collection time + availability status.
 *             Cloudflare queue truth (the consumer API reads), the D1
 *             mirror-row business state (CLEARLY labeled not-the-queue-
 *             truth), recent errors (Workers Logs have no query API either —
 *             the landed error surface is the cron_state error record),
 *             the deployment version (the Deployments API's serving
 *             deployment), the profiling arm's availability. unavailable ≠
 *             0: every unreadable item reports unavailable + reason, never
 *             a fabricated zero. Upstream's report is a ZIP download; ours
 *             renders the page (the per-item status table IS the report —
 *             the documented divergence).
 *   goroutine The stacktrace arm's honest-absence note STANDS (the runtime
 *             exposes no goroutine introspection) — the goroutine dump
 *             remains the SOLE final reduction.
 *
 * ## The two status dimensions (SPEC-0021 §6 — never conflated)
 *
 *   implementation-status: 集成待验证 ("integrated, awaiting live
 *     verification") for these arms until the monitor-platform probe
 *     battery passes against a live deployment, then 已实现
 *     ("implemented").
 *   environment-status: per deployment, per arm — available (可用) /
 *     unconfigured (未配置) / insufficient-permissions (权限不足 — the
 *     platform answered 401/403, NEVER "platform unsupported") /
 *     platform-unavailable (平台暂不可用). The Monitor UI surfaces this
 *     dimension to the admin verbatim (the manage page's platform panel,
 *     the diagnosis report's status column); the failure taxonomy behind
 *     it lives in services/monitor/platform.ts.
 *
 * ### Platform-arms route HANDOFF (the orchestrator's ui/index.ts fold;
 * this module ships everything the fold wires, claim-ready — the queue-
 * manage HANDOFF pattern above)
 *
 * Imports beside the existing admin-monitor imports:
 *   parseMonitorProfileParams, profileFilename, requestWorkerProfile,
 *   PROFILE_DURATION_MS_MIN/MAX (services/monitor/profile),
 *   applyAdminMonitorQueueSet, parseAdminMonitorQueueSetForm,
 *   monitorPlatformConfigFromEnv (services/monitor/{queue-concurrency,
 *   platform}).
 *
 *   parseUiRoute's admin block, inside the `monitor` tail AFTER the landed
 *   shapes (the static-before-dynamic rule; the 4-segment /set claim goes
 *   beside the 4-segment remove-all-items claim):
 *
 *       if (tail.length === 4 && tail[0] === "monitor" && tail[1] === "queue" && tail[2] === "set") {
 *         return { family: "admin-monitor-queue-set", qid: tail[3] as string };
 *       }
 *       if (tail.length === 2 && tail[0] === "monitor" && tail[1] === "diagnosis") {
 *         return { family: "admin-monitor-diagnosis" };
 *       }
 *       if (tail.length === 2 && tail[0] === "monitor" && tail[1] === "profile") {
 *         return { family: "admin-monitor-profile" };
 *       }
 *
 *   (plus the three family literals in the manifest/type-table union and
 *   the handlesUiRoute arm — the same three-place claim the queue-manage
 *   fold made).
 *
 *   Registrations beside adminMonitorQueueRemoveAllSubmit:
 *
 *     async function adminMonitorQueueSetSubmit(c: Context<{ Bindings: Env }>, qidRaw: string): Promise<Response> {
 *       const guard = sameOriginGuard(c.req.raw);
 *       if (guard !== null) return guard;
 *       const p = await adminPagePrologue(c);
 *       if (!p.ok) return p.response;
 *       const qid = parseAdminMonitorQueueQid(qidRaw);
 *       if (qid === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
 *       const max = parseAdminMonitorQueueSetForm(await readUrlEncodedForm(c.req.raw));
 *       if (max === null) {
 *         // Upstream's maxnumberworkers.error flash, re-rendered fresh.
 *         const data = await loadAdminMonitorQueueDetail(c.env.DB, qid, {
 *           platform: monitorPlatformConfigFromEnv(c.env),
 *         });
 *         if (data === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
 *         return p.respond(c.html(renderAdminMonitorQueueManagePage({ ctx: p.ctx, data, flash: { kind: "negative", text: adminMonitorLocale.poolSettingsError } })));
 *       }
 *       const viewer = p.ctx.viewer;
 *       const result = await applyAdminMonitorQueueSet(c.env, c.env.DB, qid, max, {
 *         actorId: viewer.kind === "user" ? viewer.id : 0,
 *         actorName: viewer.kind === "user" ? viewer.username : "",
 *         now: routeNow(),
 *       });
 *       const data = await loadAdminMonitorQueueDetail(c.env.DB, qid, {
 *         platform: monitorPlatformConfigFromEnv(c.env),
 *       });
 *       if (data === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
 *       return p.respond(c.html(renderAdminMonitorQueueManagePage({ ctx: p.ctx, data, flash: result.flash })));
 *     }
 *
 *     async function adminMonitorDiagnosisPage(c: Context<{ Bindings: Env }>): Promise<Response> {
 *       const p = await adminPagePrologue(c);
 *       if (!p.ok) return p.response;
 *       const data = await loadAdminMonitorDiagnosis(c.env, c.env.DB, { now: routeNow() });
 *       return p.respond(c.html(renderAdminMonitorDiagnosisPage({ ctx: p.ctx, data })));
 *     }
 *
 *     async function adminMonitorProfileDownload(c: Context<{ Bindings: Env }>): Promise<Response> {
 *       const p = await adminPagePrologue(c);
 *       if (!p.ok) return p.response;
 *       const params = parseMonitorProfileParams(new URL(c.req.raw.url).searchParams);
 *       const config = monitorPlatformConfigFromEnv(c.env);
 *       if (params === null || config.accountId === undefined || config.profileToken === undefined) {
 *         // The trace page is the arm's only surface — a bad/unconfigured
 *         // trigger lands back there (upstream's GET-download posture has
 *         // no error page; the 303 keeps the no-JS form usable).
 *         return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/monitor/stacktrace" } }));
 *       }
 *       // The serving version when the deployments read answers; the
 *       // documented "latest" fallback otherwise.
 *       let versionId: string | undefined;
 *       const deployment = await readLatestDeployment({ accountId: config.accountId, apiToken: config.profileToken, workerName: config.workerName });
 *       if (deployment.kind === "ok" && deployment.result !== null && deployment.result.versions[0]?.versionId) {
 *         versionId = deployment.result.versions[0].versionId;
 *       }
 *       const profile = await requestWorkerProfile({
 *         accountId: config.accountId, apiToken: config.profileToken, workerName: config.workerName,
 *         versionId, type: params.type, durationMs: params.durationMs,
 *       });
 *       if (profile.kind !== "ok") {
 *         console.error("[monitor] profile trigger failed", profile.kind);
 *         return p.respond(new Response(null, { status: 303, headers: { location: "/-/admin/monitor/stacktrace" } }));
 *       }
 *       return p.respond(new Response(profile.bytes, {
 *         status: 200,
 *         headers: {
 *           "content-type": "application/octet-stream",
 *           "content-disposition": `attachment; filename="${profileFilename(params.type, routeNow())}"`,
 *         },
 *       }));
 *     }
 *
 *     uiRouter.post("/-/admin/monitor/queue/:qid/set", (c) => adminMonitorQueueSetSubmit(c, c.req.param("qid")));
 *     uiRouter.get("/-/admin/monitor/diagnosis", (c) => adminMonitorDiagnosisPage(c));
 *     uiRouter.get("/-/admin/monitor/profile", (c) => adminMonitorProfileDownload(c));
 *
 *   (readLatestDeployment joins the imports from services/monitor/platform.)
 *   Pins that flip at the fold: index.test.ts's monitor-tail route pin (the
 *   three new shapes start parsing); nothing in this module's tests pins
 *   the new shapes at the route level (module-level only — the queue-manage
 *   fold's precedent).
 *
 * ## Mount record (MOUNTED at e31c0cf — the routes are live)
 *
 * Route table (`index.ts`): four GET claims in the
 * admin/monitor neighborhood, each shaped like the blocked-users pair minus
 * the POST (only cron has one):
 *
 *   GET /-/admin/monitor/stats    the admin gate (session resolveUiSession →
 *                                 non-admin 404 shell, anonymous → the login
 *                                 303 — verifyAuthWithOptionsWeb's posture)
 *                                 → loadAdminMonitorStats(db) →
 *                                 renderAdminMonitorStatsPage
 *   GET /-/admin/monitor/cron     gate → loadAdminMonitorCron(new Date()) →
 *                                 renderAdminMonitorCronPage({flash: null})
 *                                 (the SYNC census loader — the state-bearing
 *                                 swap to `await loadAdminMonitorCronRunState(
 *                                 c.env.DB, routeNow())` at both cron call
 *                                 sites is the disclosed ui/index.ts
 *                                 integration, outside this module's
 *                                 ownership; until it lands the page renders
 *                                 the full listing in the never-fired
 *                                 posture)
 *   POST /-/admin/monitor/cron    sameOriginGuard FIRST → gate →
 *                                 parseAdminMonitorCronForm(readUrlEncodedForm)
 *                                 → applyAdminMonitorCronForm(env, form) →
 *                                 re-render the fresh load at 200 with the
 *                                 flash (upstream redirects; the no-JS
 *                                 re-render is the keys-page convention —
 *                                 swap to a 303 if the flash-queue lands)
 *   GET /-/admin/monitor/queue    gate → loadAdminMonitorQueues(db) →
 *                                 renderAdminMonitorQueuePage
 *   GET /-/admin/monitor/stacktrace  gate → renderAdminMonitorTracePage
 *
 * The admin navbar is the admin family's ONE shared navbar (the mount
 * window's F7 fold — pages/admin-users.tsx AdminFamilyNav with the monitor
 * `active` values; the AdminMonitorNav scaffolding copy was DELETED — the
 * OrgSettingsBlockedNav precedent). Survey row touched on landing:
 * docs/compat/ui-parity-survey.md:386 (the `/-/admin/*` family row —
 * the monitor subset becomes PARTIAL).
 *
 * ## Queue-manage (LANDED — census gap 17's claims are the index.ts mount
 * record, folded at 0cf8fd1)
 *
 * parseUiRoute's admin block, inside `tail[0] === "monitor"` AFTER the four
 * 2-segment arms (the literal `/queue` shadows the `{qid}` parse like
 * upstream's static-before-dynamic rule):
 *
 *     if (tail.length === 3 && tail[0] === "monitor" && tail[1] === "queue") {
 *       return { family: "admin-monitor-queue-manage", qid: tail[2] as string };
 *     }
 *     if (tail.length === 4 && tail[0] === "monitor" && tail[1] === "queue" && tail[2] === "remove-all-items") {
 *       return { family: "admin-monitor-queue-remove-all", qid: tail[3] as string };
 *     }
 *
 * (NO `/set` arm — the documented reduction above; the shape stays null →
 * the engine's 404.) Registrations beside adminMonitorCronSubmit, with the
 * module imports parseAdminMonitorQueueQid / loadAdminMonitorQueueDetail /
 * applyAdminMonitorQueueRemoveAllItems / renderAdminMonitorQueueManagePage:
 *
 *     async function adminMonitorQueueManage(c: Context<{ Bindings: Env }>, qidRaw: string): Promise<Response> {
 *       const p = await adminPagePrologue(c);
 *       if (!p.ok) return p.response;
 *       const qid = parseAdminMonitorQueueQid(qidRaw);
 *       const data = qid === null ? null : await loadAdminMonitorQueueDetail(c.env.DB, qid);
 *       if (data === null) return p.respond(c.html(renderNotFound(p.ctx), 404)); // upstream's nil-mq arm
 *       return p.respond(c.html(renderAdminMonitorQueueManagePage({ ctx: p.ctx, data, flash: null })));
 *     }
 *
 *     async function adminMonitorQueueRemoveAll(c: Context<{ Bindings: Env }>, qidRaw: string): Promise<Response> {
 *       const guard = sameOriginGuard(c.req.raw);
 *       if (guard !== null) return guard;
 *       const p = await adminPagePrologue(c);
 *       if (!p.ok) return p.response;
 *       const qid = parseAdminMonitorQueueQid(qidRaw);
 *       if (qid === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
 *       const result = await applyAdminMonitorQueueRemoveAllItems(c.env.DB, qid);
 *       if (result.outcome === "unknown-queue") return p.respond(c.html(renderNotFound(p.ctx), 404));
 *       const data = await loadAdminMonitorQueueDetail(c.env.DB, qid); // non-null in practice: the purge body proves registry membership
 *       if (data === null) return p.respond(c.html(renderNotFound(p.ctx), 404));
 *       return p.respond(c.html(renderAdminMonitorQueueManagePage({ ctx: p.ctx, data, flash: { kind: "positive", text: result.message } })));
 *     }
 *
 *     uiRouter.get("/-/admin/monitor/queue/:qid", (c) => adminMonitorQueueManage(c, c.req.param("qid")));
 *     uiRouter.post("/-/admin/monitor/queue/:qid/remove-all-items", (c) => adminMonitorQueueRemoveAll(c, c.req.param("qid")));
 *
 * Pins that flip at the fold: index.test.ts's monitor-tail route pin (the
 * `/queue/{qid}` shape starts parsing); NOTHING in this module's tests pins
 * the new shape at the route level, so the fold breaks no test here. The
 * manage page renders the shared AdminFamilyNav with active="queue" —
 * upstream's QueueManage sets PageIsAdminMonitor (outside navbar.tmpl:107's
 * open-OR), leaving every item inactive and the group closed; the shared
 * nav's derived-open arm cannot express that posture without a new prop in
 * admin-users.tsx (outside this unit's ownership) — the divergence is
 * documented, not silent.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Child } from "hono/jsx";

import { enqueueDueAuditRetention } from "../../services/audit";
import { enqueueDueDemoSweeps, enqueueDueWebhookMaintenance } from "../../services/demo-sweep";
import { enqueueDueMirrorSyncs } from "../../services/mirror/sync";
import { enqueueDuePushMirrorSyncs } from "../../services/mirror/push-sync";
import { enqueueDuePackagesCleanup } from "../../services/packages/cleanup";
import { CRON_ARMS, listCronState, recordArmsSuccess, type CronStateRow } from "../../services/cron-state";
import {
  classifyPlatformStatus,
  monitorPlatformConfigFromEnv,
  readLatestDeployment,
  type FetchImpl,
  type MonitorPlatformConfig,
  type MonitorPlatformStatus,
} from "../../services/monitor/platform";
import { readQueueConsumer, type QueueConsumerSettings } from "../../services/monitor/queue-concurrency";
import { parseMonitorProfileParams, profileFilename, requestWorkerProfile, type ProfileOutcome } from "../../services/monitor/profile";
import {
  commitStatuses,
  comments,
  follows,
  issueAttachments,
  issues,
  labels,
  milestones,
  oauth2Applications,
  projectColumns,
  projects,
  publicKeys,
  releaseAssets,
  releases,
  repoMirrors,
  repoWatchers,
  repositories,
  stars,
  teams,
  users,
  webhookDeliveries,
  webhooks,
} from "../../db/schema";
import type { UiContext } from "../ui-context";
import { BaseLayout, Icon, renderPage } from "../shell";
import { AdminEmbeddedSvg, AdminFamilyNav } from "./admin-users";

// ---------------------------------------------------------------------------
// Page chrome + copy text (component-local, the orgSettingsBlockedLocale
// pattern — locale.ts is shared and not this wave's file; upstream locale
// keys cited, cf-gitea additions marked).
// ---------------------------------------------------------------------------

export const adminMonitorLocale = {
  /** The navbar menu header (navbar.tmpl:3) and the trace page's Title
   *  (stacktrace.go:17 — monitorTraceCommon sets `admin.monitor`). */
  settings: "Admin Settings", // "admin.settings"
  monitoring: "Monitoring", // "admin.monitor" — the submenu summary + trace Title
  stats: "Stats", // "admin.monitor.stats" — nav item + page Title
  cron: "Cron Tasks", // "admin.monitor.cron" — nav item + page Title
  queues: "Queues", // "admin.monitor.queues" — nav item + page Title
  trace: "Trace", // "admin.monitor.trace" — nav item
  // The stats table header (stats.tmpl:4) — "admin.dashboard.statistic".
  statistic: "Summary",
  // The cron table headers (cron.tmpl:12-17).
  name: "Name", // "admin.monitor.name"
  schedule: "Schedule", // "admin.monitor.schedule"
  next: "Next Time", // "admin.monitor.next"
  previous: "Previous Time", // "admin.monitor.previous"
  executeTimes: "Executions", // "admin.monitor.execute_times"
  lastResult: "Result", // "admin.monitor.last_execution_result"
  operationRun: "Run", // "admin.dashboard.operation_run" (the run button title)
  // The cron task name render (cron.tmpl:24 — `admin.dashboard.{Name}`).
  // Upstream's locale strings verbatim (options/locale/locale_en-US.json);
  // the three cf-gitea-extension arms (no upstream key exists) are marked.
  taskUpdateMirrors: "Update Mirrors", // "admin.dashboard.update_mirrors"
  taskUpdatePushMirrors: "Update Push Mirrors", // cf-gitea extension (update_mirrors's push twin)
  taskStopZombieTasks: "Stop actions zombie tasks", // "admin.dashboard.stop_zombie_tasks"
  taskStopEndlessTasks: "Stop actions endless tasks", // "admin.dashboard.stop_endless_tasks"
  taskDemoSweep: "Demo Sweep", // cf-gitea extension (SPEC-0014 — the producer's own log tag)
  taskAutoMergeDueScan: "Auto-merge due scan", // cf-gitea extension (the pull-automerge fold's census arm)
  taskDeleteOldAuditEvents: "Delete audit events older than the retention period", // "admin.dashboard.delete_old_audit_events"
  taskCleanupPackages: "Clean up expired packages", // "admin.dashboard.cleanup_packages"
  taskCleanupActions: "Clean up expired actions' resources", // "admin.dashboard.cleanup_actions"
  taskCancelAbandonedJobs: "Cancel actions abandoned jobs", // "admin.dashboard.cancel_abandoned_jobs"
  taskCleanupEphemeralRunners: "Clean up old ephemeral runners", // cf-gitea extension (no upstream key — upstream's own wrap text, cleanup.go:37)
  taskCleanupHookTaskTable: "Clean up hook_task table", // "admin.dashboard.cleanup_hook_task_table"
  // The queue table headers (queue.tmpl:10-15, reduced to the sourced three).
  queueName: "Name", // "admin.monitor.queue.name"
  queueType: "Type", // "admin.monitor.queue.type"
  queueNumberInQueue: "Number in Queue", // "admin.monitor.queue.numberinqueue"
  // The queue manage page (queue_manage.tmpl; the census gap-17 fold + the
  // platform arms' Pool Settings — queue_manage.tmpl:19-38's second section,
  // now claimable: the Cloudflare Queues consumer's max_concurrency IS the
  // worker-pool knob, services/monitor/queue-concurrency.ts).
  queueManageTitle: "Queue: %s", // "admin.monitor.queue" (queue.go:33 — %s = the queue name)
  queueReviewAdd: "Review / Add Workers", // "admin.monitor.queue.review_add" (queue.tmpl:28's link label)
  queueRemoveAll: "Remove all", // "admin.monitor.queue.settings.remove_all_items" (queue_manage.tmpl:34's button)
  queueRemoveAllDone: "All items in the queue have been removed.", // "admin.monitor.queue.settings.remove_all_items_done" (queue.go:87's flash)
  // The Pool Settings section (queue_manage.tmpl:19-38, upstream locale
  // verbatim — admin.monitor.queue.settings.*).
  poolSettingsTitle: "Pool Settings", // "admin.monitor.queue.settings.title"
  poolSettingsDesc: "Pools dynamically grow in response to their worker queue blocking.", // "admin.monitor.queue.settings.desc"
  poolSettingsMaxNumber: "Max number of workers", // "admin.monitor.queue.settings.maxnumberworkers"
  poolSettingsSubmit: "Update Settings", // "admin.monitor.queue.settings.submit"
  settingsChanged: "Settings Updated", // "admin.monitor.queue.settings.changed" (the applied flash)
  poolSettingsError: "Max number of workers must be a number", // "admin.monitor.queue.settings.maxnumberworkers.error" (the failed binding's flash)
  // cf-gitea additions — the platform arms' UI (no upstream keys; the
  // two-status-dimension scheme, SPEC-0021 §6).
  runtimeValue: "Runtime (Cloudflare API, verified)",
  declaredValue: "Declared (wrangler.jsonc)",
  driftWarning:
    "A redeploy re-applies the declared wrangler.jsonc settings — the runtime value above is a drift that the next deploy overwrites, not a permanent change.",
  autoLabel: "auto", // the platform's null=auto arm (max_concurrency null = the platform maximum)
  envAvailable: "Available", // 可用
  envUnconfigured: "Not configured", // 未配置
  envInsufficientPermissions: "Insufficient permissions", // 权限不足 (401/403 — NEVER "platform unsupported")
  envPlatformUnavailable: "Platform temporarily unavailable", // 平台暂不可用
  platformNotWired: "The queue platform arm is not wired on this route yet.",
  // cf-gitea addition — the manage page's posture note (the REWRITTEN
  // reduction: the set arm is an adapter now; the purge adjudications keep).
  queueManageReductions:
    "Worker-pool settings ride the Cloudflare Queues consumer API (max_concurrency) when this queue has a server-side allowlist entry; the form shows the platform-verified runtime value and the wrangler-declared value separately. The webhook queue has no remove-all arm: its queue items are the delivery log rows themselves, and upstream's purge preserves the log. The dead-letter queue has no landed counter (the - cell above) and no purge substrate.",
  // The run POST's flash texts (admin.go:188-190 DashboardPost — "%s" is the
  // task's locale name / the raw op).
  taskStarted: "Started Task: %s", // "admin.dashboard.task.started"
  taskUnknown: "Unknown task: %s", // "admin.dashboard.task.unknown"
  // cf-gitea additions — the trace page's sections (the REWRITTEN
  // trace_tabs posture: the stacktrace honest-absence note STANDS — the
  // goroutine dump is the sole final reduction — while perftrace/pprof and
  // diagnosis are platform adapters now, SPEC-0021 §4-§5).
  traceUnavailable:
    "Goroutine and process introspection is not available: the Workers runtime exposes neither, so the upstream stacktrace list (runtime.NumGoroutine + the process manager) has no cf-gitea source. This is the one remaining hard reduction of the monitor family.",
  deliveryStates: "Webhook delivery states",
  // The perftrace section (request tracing — SEPARATE from profiling):
  // Workers Traces have no query API (verified live 2026-11-01), so the
  // section states the enabled posture and links out.
  perfTraceTitle: "Request traces (perftrace)",
  perfTracePosture:
    "Workers Traces are enabled on this deployment (observability.traces). The platform exposes no on-demand trace query API, so this page cannot list traces; open the Cloudflare dashboard (Workers & Pages -> your Worker -> Observability -> Traces) or stream with `wrangler tail`.",
  perfTraceDocs: "Traces docs",
  // The profiling section (the pprof adapter).
  profileTitle: "Profiling",
  profileConfiguredNote:
    "Triggers a capture through the Workers Profiling API and downloads the gzipped pprof (cpu or heap, 1-50 s). The file is the raw pprof output of the platform.",
  profileUnconfigured:
    "Profiling is not configured on this deployment (no CLOUDFLARE_PROFILE_TOKEN / CLOUDFLARE_ACCOUNT_ID) — the Workers Profiling API is available but not wired.",
  profileTypeLabel: "Profile type",
  profileSecondsLabel: "Seconds",
  profileDownload: "Download profile (.pprof.gz)",
  // The diagnosis section + report (upstream's download_diagnosis_report
  // label; the report renders as a PAGE — the documented divergence).
  diagnosisReport: "Download diagnosis report", // "admin.monitor.download_diagnosis_report"
  diagnosisTitle: "Diagnosis Report",
  diagnosisColHeader: "Item",
  diagnosisSourceHeader: "Source",
  diagnosisCollectedHeader: "Collected (UTC)",
  diagnosisStatusHeader: "Status",
  diagnosisDetailHeader: "Detail",
  diagnosisUnavailable: "unavailable",
  diagnosisAvailable: "available",
  diagnosisQueueTruthSource: "Cloudflare Queues API (consumer read) — the queue truth",
  diagnosisD1MirrorSource: "D1 business mirror — NOT the queue truth",
  diagnosisD1MirrorNote:
    "These counts come from the D1 delivery-log and mirror-state rows. They reflect the business state of the pipelines, not the Cloudflare queue depths.",
  diagnosisCronErrorsSource: "cron_state table (the landed error surface)",
  diagnosisCronErrorsNone: "no recorded cron arm errors",
  diagnosisDeploymentSource: "Workers Deployments API (the serving deployment)",
  diagnosisProfilingSource: "Workers Profiling API (availability)",
  diagnosisProfilingArmed: "armed — trigger a capture from the Trace page",
} as const;

/** The monitor submenu's live items (the shared AdminFamilyNav's monitor
 *  `active` union — the AdminMonitorPage values verbatim). */
export type AdminMonitorPage = "stats" | "cron" | "queue" | "trace";

// ---------------------------------------------------------------------------
// The admin navbar (navbar.tmpl:106-124 — the F7 fold: the family's ONE
// shared navbar, pages/admin-users.tsx AdminFamilyNav; the module-local
// AdminMonitorNav copy was deleted). Upstream keeps the Monitoring details
// `open` only on monitor pages — which the `active` prop always is for this
// module's four pages, so the shared nav's derived-open arm reproduces the
// template here. The audit_logs item is OMITTED (no landed store — the
// dead-link rule).
// ---------------------------------------------------------------------------

/** The layout shell (layout_head.tmpl verbatim around the content block):
 *  the `admin monitor` pageClass, the fluid padded flex container, the
 *  family navbar, then `.flex-container-main` wrapping `.admin-setting-
 *  content` (every monitor template opens it, e.g. queue.tmpl:2). */
function AdminMonitorShell(props: {
  ctx: UiContext;
  title: string;
  active: AdminMonitorPage;
  children: Child;
}) {
  return (
    <BaseLayout ctx={props.ctx} title={props.title} pageClass="admin monitor">
      <div class="ui container fluid padded flex-container">
        <AdminFamilyNav active={props.active} />
        <div class="flex-container-main">
          <div class="admin-setting-content">{props.children}</div>
        </div>
      </div>
    </BaseLayout>
  );
}

// ---------------------------------------------------------------------------
// Stats (GET /-/admin/monitor/stats — stats.tmpl over GetStatistic's landed-
// table subset)
// ---------------------------------------------------------------------------

/** The stats table's render inputs: upstream's sorted `StatsKeys` +
 *  `StatsCounter` pair flattened into ordered [key, count] entries
 *  (admin.go:273-288). */
export interface AdminMonitorStatsData {
  stats: Array<[string, number]>;
}

/**
 * The landed-table subset of GetStatistic (models/activities/statistic.go)
 * under upstream's EXACT counter key names, sorted like MonitorStats's
 * `sort.Strings` (admin.go:287). Every count is a landed-table read through
 * Drizzle — the omissions are the counter fields with NO landed table (the
 * module header's list), never zeros standing in for them.
 */
export async function loadAdminMonitorStats(d1: D1Database): Promise<AdminMonitorStatsData> {
  const db = drizzle(d1);
  const [
    usersActive,
    usersNotActive,
    org,
    publicKey,
    repo,
    watch,
    star,
    issueRows,
    comment,
    oauth,
    follow,
    mirror,
    release,
    webhook,
    hookTask,
    milestone,
    label,
    team,
    project,
    projectColumn,
    attachmentRows,
    commitStatus,
  ] = await Promise.all([
    // UsersActive / UsersNotActive — CountUserFilter IsActive over USER rows
    // only (upstream counts user_table users; orgs are the separate Org
    // counter). The landed users.status enum folds upstream's IsActive +
    // ProhibitLogin (the admin-t2 conflation, its header's sixth deviation).
    db.select({ n: sql<number>`count(*)` }).from(users).where(and(eq(users.type, "user"), eq(users.status, "active"))).get(),
    db.select({ n: sql<number>`count(*)` }).from(users).where(and(eq(users.type, "user"), eq(users.status, "prohibited"))).get(),
    db.select({ n: sql<number>`count(*)` }).from(users).where(eq(users.type, "org")).get(),
    db.select({ n: sql<number>`count(*)` }).from(publicKeys).get(),
    db.select({ n: sql<number>`count(*)` }).from(repositories).get(),
    db.select({ n: sql<number>`count(*)` }).from(repoWatchers).get(),
    db.select({ n: sql<number>`count(*)` }).from(stars).get(),
    // IssueOpen/IssueClosed — the is_closed GROUP BY (statistic.go:108-120),
    // one query; Issue = the sum (statistic.go:122).
    db.select({ closed: issues.isClosed, n: sql<number>`count(*)` }).from(issues).groupBy(issues.isClosed).all(),
    db.select({ n: sql<number>`count(*)` }).from(comments).get(),
    // Upstream hardcodes Oauth = 0 (statistic.go:104); the landed
    // oauth2_applications table can answer the real count — the same shape,
    // strictly more informative (the module header's divergence note).
    db.select({ n: sql<number>`count(*)` }).from(oauth2Applications).get(),
    db.select({ n: sql<number>`count(*)` }).from(follows).get(),
    db.select({ n: sql<number>`count(*)` }).from(repoMirrors).get(),
    db.select({ n: sql<number>`count(*)` }).from(releases).get(),
    db.select({ n: sql<number>`count(*)` }).from(webhooks).get(),
    // HookTask — upstream's hook_task delivery log; ours is
    // webhook_deliveries (SPEC-0005 §3.5-3.6's log, 1:1 concept).
    db.select({ n: sql<number>`count(*)` }).from(webhookDeliveries).get(),
    db.select({ n: sql<number>`count(*)` }).from(milestones).get(),
    db.select({ n: sql<number>`count(*)` }).from(labels).get(),
    db.select({ n: sql<number>`count(*)` }).from(teams).get(),
    db.select({ n: sql<number>`count(*)` }).from(projects).get(),
    db.select({ n: sql<number>`count(*)` }).from(projectColumns).get(),
    // Attachment — upstream's ONE attachments table serves issues AND
    // releases; SPEC-0005 split it (issue_attachments + release_assets), so
    // the counter is the sum.
    Promise.all([
      db.select({ n: sql<number>`count(*)` }).from(issueAttachments).get(),
      db.select({ n: sql<number>`count(*)` }).from(releaseAssets).get(),
    ]),
    db.select({ n: sql<number>`count(*)` }).from(commitStatuses).get(),
  ]);
  let issueOpen = 0;
  let issueClosed = 0;
  for (const row of issueRows) {
    if (row.closed) issueClosed += row.n;
    else issueOpen += row.n;
  }
  const stats: Array<[string, number]> = [
    ["Attachment", (attachmentRows[0]?.n ?? 0) + (attachmentRows[1]?.n ?? 0)],
    ["Comment", comment?.n ?? 0],
    ["CommitStatus", commitStatus?.n ?? 0],
    ["Follow", follow?.n ?? 0],
    ["HookTask", hookTask?.n ?? 0],
    ["Issue", issueOpen + issueClosed],
    ["IssueClosed", issueClosed],
    ["IssueOpen", issueOpen],
    ["Label", label?.n ?? 0],
    ["Milestone", milestone?.n ?? 0],
    ["Mirror", mirror?.n ?? 0],
    ["Oauth", oauth?.n ?? 0],
    ["Org", org?.n ?? 0],
    ["Project", project?.n ?? 0],
    ["ProjectColumn", projectColumn?.n ?? 0],
    ["PublicKey", publicKey?.n ?? 0],
    ["Release", release?.n ?? 0],
    ["Repo", repo?.n ?? 0],
    ["Star", star?.n ?? 0],
    ["Team", team?.n ?? 0],
    ["UsersActive", usersActive?.n ?? 0],
    ["UsersNotActive", usersNotActive?.n ?? 0],
    ["Watch", watch?.n ?? 0],
    ["Webhook", webhook?.n ?? 0],
  ];
  return { stats };
}

/** The stats page (stats.tmpl verbatim: the Summary header + the two-column
 *  `width="200"` key rows, keys already sorted by the loader). */
export function AdminMonitorStatsPage(props: { ctx: UiContext; data: AdminMonitorStatsData }) {
  return (
    <AdminMonitorShell ctx={props.ctx} title={adminMonitorLocale.stats} active="stats">
      <h4 class="ui top attached header">{adminMonitorLocale.statistic}</h4>
      <div class="ui attached table segment">
        <table class="ui very basic table unstackable">
          {props.data.stats.map(([key, count]) => (
            <tr>
              <td width="200">{key}</td>
              <td>{count}</td>
            </tr>
          ))}
        </table>
      </div>
    </AdminMonitorShell>
  );
}

export function renderAdminMonitorStatsPage(options: { ctx: UiContext; data: AdminMonitorStatsData }): string {
  return renderPage(<AdminMonitorStatsPage ctx={options.ctx} data={options.data} />);
}

// ---------------------------------------------------------------------------
// Cron (GET /-/admin/monitor/cron — cron.tmpl over the landed cron registry)
// ---------------------------------------------------------------------------

/** One rendered cron row — the landed arm's render inputs (the Cron struct
 *  render, modules/structs/cron.go's five fields, PLUS the recorded tick
 *  state upstream keeps in process memory): `prev` null = the never-fired
 *  arm (cron.tmpl:27 renders `-` while `.Prev.Year < 2`), `execTimes` 0 =
 *  no completed tick recorded, `result.status` "none" = the empty Status
 *  (cron.tmpl:29's `—`). */
export interface AdminMonitorCronEntry {
  /** The arm's registry name (CRON_ARMS — upstream's task name where a
   *  faithful twin exists; the run form's `op` value). */
  name: string;
  /** The wrangler-declared trigger expression — rendered verbatim. */
  spec: string;
  /** The next UTC firing; null only for a spec the parser families cannot
   *  read — the zero-time render, never a wrong time. */
  next: Date | null;
  /** The last COMPLETED tick (cron_state.last_success); null = never. */
  prev: Date | null;
  /** Completed ticks recorded for the arm (manual runs included). */
  execTimes: number;
  /** The Result cell's triple (cron.tmpl:29): "none" → the em dash,
   *  "finished" → the check glyph, "error" → the x glyph with the stored
   *  one-liner as the tooltip. */
  result: { status: "none" | "finished" | "error"; message: string | null; at: Date | null };
  /** Whether the run button renders (the landed run-capable subset — the
   *  module header's reduction; false rows render an empty first cell). */
  runnable: boolean;
}

/**
 * The minute-step subset of cron expressions (a star-slash-N minute field
 * followed by `* * * * *`) → the step in minutes. (admin-degenerate.ts's
 * private parser mirrored — both registries render the census's next-fire
 * triple from the same two landed spec families.)
 */
function minuteStepMinutes(spec: string): number | null {
  if (spec === "* * * * *") {
    return 1;
  }
  const match = /^\*\/(\d+) \* \* \* \*$/.exec(spec);
  if (match === null) {
    return null;
  }
  const step = Number.parseInt(match[1] ?? "", 10);
  return step >= 1 ? step : null;
}

/**
 * The exact-minute-hourly family (`M * * * *`, 0-59) → the minute. The
 * hourly entry's landed spec (`0 * * * *`) needs it — the minute-step
 * parser deliberately rejects it (never a wrong guess).
 */
function hourlyEntryMinute(spec: string): number | null {
  const match = /^(\d{1,2}) \* \* \* \*$/.exec(spec);
  if (match === null) {
    return null;
  }
  const minute = Number.parseInt(match[1] ?? "", 10);
  return minute >= 0 && minute <= 59 ? minute : null;
}

/** The next UTC firing of a minute-step spec after `from` (Cloudflare cron
 *  triggers fire at UTC minute boundaries; on a boundary the NEXT step is
 *  returned — admin-degenerate.ts's nextMinuteStepFire mirrored). */
function nextMinuteStepFire(stepMinutes: number, from: Date): Date {
  const next = new Date(from.getTime());
  next.setUTCSeconds(0, 0);
  const remainder = next.getUTCMinutes() % stepMinutes;
  next.setUTCMinutes(next.getUTCMinutes() + (remainder === 0 ? stepMinutes : stepMinutes - remainder));
  return next;
}

/** The next UTC firing of an exact-minute-hourly spec after `from` (the
 *  same boundary convention: ON the firing minute the NEXT hour returns). */
function nextHourlyFire(minute: number, from: Date): Date {
  const next = new Date(from.getTime());
  next.setUTCMinutes(minute, 0, 0);
  if (next.getTime() <= from.getTime()) {
    next.setUTCHours(next.getUTCHours() + 1);
  }
  return next;
}

/** The supported families' dispatch — null renders the zero time (never a
 *  wrong time, the parser's own posture for an unsupported future spec). */
function nextFireForSpec(spec: string, from: Date): Date | null {
  const step = minuteStepMinutes(spec);
  if (step !== null) {
    return nextMinuteStepFire(step, from);
  }
  const minute = hourlyEntryMinute(spec);
  if (minute !== null) {
    return nextHourlyFire(minute, from);
  }
  return null;
}

/**
 * The runnable arms' producer dispatch — admin-degenerate.ts's CRON_RUN_BODIES
 * mirrored verbatim, each value the scheduled dispatcher's EXACT producer call
 * (demo-sweep.ts handleScheduledCron — "run = enqueue", "crons enqueue,
 * consumers do the work"); the injected `now` rides the options object every
 * producer accepts. The run button renders ONLY for these arms (the set below
 * derives from this map, so the render gate and the apply dispatch can never
 * drift); the five actions-family census arms (stop_zombie_tasks,
 * cleanup_actions, stop_endless_tasks, cancel_abandoned_jobs,
 * cleanup_ephemeral_runners) stay absent — their producer modules live in
 * services/actions/** (an in-flight sibling's ownership), and a
 * listed-but-unrunnable arm's op answers the task.unknown flash exactly like
 * an unknown one — never a dead control. Extending run capability = extending
 * this map (and the API registry's CRON_RUN_BODIES) in one change.
 */
type CronRunBody = (env: Env, options: { now?: Date }) => Promise<number>;

const CRON_RUN_BODIES: Readonly<Record<string, CronRunBody>> = {
  update_mirrors: (env, options) => enqueueDueMirrorSyncs(env, { now: options.now }),
  update_push_mirrors: (env, options) => enqueueDuePushMirrorSyncs(env, { now: options.now }),
  demo_sweep: (env, options) => enqueueDueDemoSweeps(env, { now: options.now }),
  delete_old_audit_events: (env, options) => enqueueDueAuditRetention(env, { now: options.now }),
  cleanup_packages: (env, options) => enqueueDuePackagesCleanup(env, { now: options.now }),
  // The webhook-maintenance producer (SPEC-0005 §4.9 as-built, the 870c9b3
  // landing) — this module's twin landed FIRST (the orchestrator's one-shot
  // boundary grant for the census row's ripple); the API registry's twin
  // entry is a pending one-liner with admin-degenerate.ts's owner, so the
  // API POST /admin/cron/cleanup_hook_task_table answers the
  // listed-but-unrunnable 404 until it lands (pinned by the route's test).
  cleanup_hook_task_table: (env, options) => enqueueDueWebhookMaintenance(env, { now: options.now }),
};

/** The run-capable subset — the dispatch map's keys (never drifts apart). */
const RUNNABLE_CRON_ARMS: ReadonlySet<string> = new Set(Object.keys(CRON_RUN_BODIES));

/** The registry mirror's source — CRON_ARMS (services/cron-state.ts) is the
 *  single census (the scheduled handler's recorder keys the same names, so
 *  a monitor row and its tick row can never drift apart). */
const MONITOR_CRON_TASKS = CRON_ARMS;

/**
 * The landed cron task registry render — the FULL arm census (the module
 * header's F3 listing) in the never-fired posture: prev null, execTimes 0,
 * result "none". The tick state rides `loadAdminMonitorCronRunState`; this
 * sync loader is the shape ui/index.ts's route call sites use until their
 * two-line swap (the mount record).
 */
export function loadAdminMonitorCron(now: Date): { entries: AdminMonitorCronEntry[] } {
  return {
    entries: MONITOR_CRON_TASKS.map((task) => ({
      name: task.arm,
      spec: task.spec,
      next: nextFireForSpec(task.spec, now),
      prev: null,
      execTimes: 0,
      result: { status: "none", message: null, at: null },
      runnable: RUNNABLE_CRON_ARMS.has(task.arm),
    })),
  };
}

/**
 * The state-bearing loader (the route's swap target): the same census with
 * the `cron_state` rows merged over it — prev/Executions from the recorded
 * successes, the Result triple from the recorded error (a completed tick
 * after a failed one REPLACES the error posture: status follows the LAST
 * recorded tick, exactly upstream's single Status field). An arm without a
 * row keeps the never-fired posture (a fresh deployment, the golden
 * harness). One point scan of a ≤10-row table.
 */
export async function loadAdminMonitorCronRunState(
  db: D1Database,
  now: Date,
): Promise<{ entries: AdminMonitorCronEntry[] }> {
  const base = loadAdminMonitorCron(now);
  const state: Map<string, CronStateRow> = await listCronState(db);
  return {
    entries: base.entries.map((entry) => {
      const row = state.get(entry.name);
      if (row === undefined) {
        return entry;
      }
      // The last recorded tick decides the posture: a failure stamps the
      // error pair WITHOUT moving last_success (the store's granularity
      // note), so lastErrorUnix > lastSuccess ⇔ the error IS the last tick.
      const failedLast = row.lastErrorUnix !== null && (row.lastSuccess === null || row.lastErrorUnix > row.lastSuccess);
      return {
        ...entry,
        prev: row.lastSuccess,
        execTimes: row.runs,
        result: failedLast
          ? { status: "error", message: row.lastError, at: row.lastErrorUnix }
          : row.lastSuccess !== null
            ? { status: "finished", message: null, at: null }
            : { status: "none", message: null, at: null },
      };
    }),
  };
}

/** The task's rendered name (cron.tmpl:24 — the `admin.dashboard.{Name}`
 *  locale key; unknown names fall back to the raw op, DashboardPost's
 *  task.unknown arm carries the raw value too). */
function taskDisplayName(name: string): string {
  switch (name) {
    case "update_mirrors":
      return adminMonitorLocale.taskUpdateMirrors;
    case "update_push_mirrors":
      return adminMonitorLocale.taskUpdatePushMirrors;
    case "stop_zombie_tasks":
      return adminMonitorLocale.taskStopZombieTasks;
    case "stop_endless_tasks":
      return adminMonitorLocale.taskStopEndlessTasks;
    case "demo_sweep":
      return adminMonitorLocale.taskDemoSweep;
    case "auto_merge_due_scan":
      return adminMonitorLocale.taskAutoMergeDueScan;
    case "delete_old_audit_events":
      return adminMonitorLocale.taskDeleteOldAuditEvents;
    case "cleanup_packages":
      return adminMonitorLocale.taskCleanupPackages;
    case "cleanup_actions":
      return adminMonitorLocale.taskCleanupActions;
    case "cancel_abandoned_jobs":
      return adminMonitorLocale.taskCancelAbandonedJobs;
    case "cleanup_ephemeral_runners":
      return adminMonitorLocale.taskCleanupEphemeralRunners;
    case "cleanup_hook_task_table":
      return adminMonitorLocale.taskCleanupHookTaskTable;
    default:
      return name;
  }
}

/** Upstream `DateUtils.FullTime` — "Jan 01, 2006 20:33:44" (util_date.go:33),
 *  UTC hand-rolled (the formatTokenDate precedent). */
export function formatMonitorFullTime(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${months[date.getUTCMonth()]} ${pad(date.getUTCDate())}, ${date.getUTCFullYear()} ${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/** The parsed cron POST (cron.tmpl's per-row run button + the hidden
 *  `from=monitor`, cron.tmpl:23,34): `op` null = a failed binding — the arm
 *  this DOM never emits. */
export interface AdminMonitorCronForm {
  op: string | null;
  from: string;
}

export function parseAdminMonitorCronForm(params: URLSearchParams): AdminMonitorCronForm {
  const op = params.get("op") ?? "";
  return { op: op === "" ? null : op, from: params.get("from") ?? "" };
}

export type AdminMonitorCronResult =
  | { outcome: "applied"; message: string }
  | { outcome: "invalid"; message: string };

/**
 * The cron run (upstream DashboardPost's task arm, admin.go:186-191,
 * reduced to the landed run bodies): the known task executes the EXACT body
 * the landed `POST /admin/cron/{task}` serves (the CRON_RUN_BODIES dispatch —
 * admin-degenerate.ts's registry mirrored, the API handler's lookup shape —
 * "run = enqueue", the admin-degenerate posture) and answers the
 * task.started flash; an unknown — or listed-but-unrunnable — task answers
 * task.unknown WITHOUT running anything (upstream's flash-error arm). A
 * failed binding (`op` absent) is the unknown arm's funnel (the
 * binding-failure convention).
 *
 * The manual run RECORDS ITS TICK (cron_state, the run arm's row):
 * upstream's ExecTimes counts run STARTS on the shared RunWithUser path —
 * the dashboard trigger included (tasks.go:95-97) — and the recorded
 * success clears any standing error, so the monitor's row reflects a
 * human-triggered run exactly like a scheduled one. The recording is
 * log-and-continue: a failed tick write never fails the run's flash (the
 * enqueue already happened; the scheduled handler's own tick will refresh
 * the row on the next entry).
 */
export async function applyAdminMonitorCronForm(
  env: Env,
  form: AdminMonitorCronForm,
  options: { now?: Date } = {},
): Promise<AdminMonitorCronResult> {
  // The run-capable gate (CRON_RUN_BODIES — the landed run bodies, the API
  // twin's handler lookup), NOT census membership: a listed-but-unrunnable
  // arm must answer task.unknown exactly like an unknown op (upstream's
  // flash-error arm), never run the wrong body.
  const op = form.op;
  if (op === null) {
    return { outcome: "invalid", message: adminMonitorLocale.taskUnknown.replace("%s", "") };
  }
  const run = CRON_RUN_BODIES[op];
  if (run === undefined) {
    return { outcome: "invalid", message: adminMonitorLocale.taskUnknown.replace("%s", op) };
  }
  await run(env, { now: options.now });
  const arm = CRON_ARMS.find((entry) => entry.arm === op);
  if (arm !== undefined) {
    await recordArmsSuccess(env.DB, [arm], options).catch((recordError: unknown) => {
      console.error("[cron-state] manual run tick not recorded", recordError);
    });
  }
  return { outcome: "applied", message: adminMonitorLocale.taskStarted.replace("%s", taskDisplayName(op)) };
}

/** The cron page (cron.tmpl verbatim: the table lives INSIDE the run form;
 *  the POST target is the PAGE URL — the module header's divergence note).
 *  `flash` is the no-JS POST answer banner (the hooks-page convention). */
export function AdminMonitorCronPage(props: {
  ctx: UiContext;
  data: { entries: AdminMonitorCronEntry[] };
  flash: { kind: "positive" | "negative"; text: string } | null;
}) {
  const pageLink = "/-/admin/monitor/cron";
  return (
    <AdminMonitorShell ctx={props.ctx} title={adminMonitorLocale.cron} active="cron">
      <h4 class="ui top attached header">{adminMonitorLocale.cron}</h4>
      <div class="ui attached table segment">
        <form method="post" action={pageLink}>
          {props.flash !== null ? <div class={`ui ${props.flash.kind} message`}>{props.flash.text}</div> : null}
          <table class="ui very basic table unstackable tw-mb-0">
            <thead>
              <tr>
                <th scope="col"></th>
                <th scope="col">{adminMonitorLocale.name}</th>
                <th scope="col">{adminMonitorLocale.schedule}</th>
                <th scope="col">{adminMonitorLocale.next}</th>
                <th scope="col">{adminMonitorLocale.previous}</th>
                <th scope="col">{adminMonitorLocale.executeTimes}</th>
                <th scope="col">{adminMonitorLocale.lastResult}</th>
              </tr>
            </thead>
            <tbody>
              {props.data.entries.map((entry) => (
                <tr>
                  <td>
                    {/* The run button (cron.tmpl:23) — ONLY on the
                        run-capable row (the module header's reduction: a
                        button for a bodyless arm would POST into
                        task.unknown — the dead-control rule); the other
                        rows render the empty first cell. octicon-triangle-
                        right is outside the generated icon allowlist —
                        octicon-clock is the documented stand-in (the
                        feeds-glyph convention). */}
                    {entry.runnable ? (
                      <button type="submit" class="ui primary button" name="op" value={entry.name} title={adminMonitorLocale.operationRun}>
                        <Icon name="octicon-clock" />
                      </button>
                    ) : null}
                  </td>
                  <td>{taskDisplayName(entry.name)}</td>
                  <td>{entry.spec}</td>
                  <td>{entry.next === null ? "-" : formatMonitorFullTime(entry.next)}</td>
                  {/* cron.tmpl:27 — `-` while Prev.Year < 2 (never fired). */}
                  <td>{entry.prev === null ? "-" : formatMonitorFullTime(entry.prev)}</td>
                  <td>{entry.execTimes}</td>
                  {/* cron.tmpl:29 — the em dash while Status is empty;
                      otherwise the check (finished) / x (error, tooltip =
                      the stored one-liner) glyph pair. octicon-check is
                      allowlisted; octicon-x rides the AdminEmbeddedSvg
                      arm (the admin-emails check/x cell precedent). */}
                  {entry.result.status === "none" ? (
                    <td>—</td>
                  ) : entry.result.status === "finished" ? (
                    <td>
                      <Icon name="octicon-check" />
                    </td>
                  ) : (
                    <td data-tooltip-content={entry.result.message ?? ""}>
                      <AdminEmbeddedSvg name="octicon-x" />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <input type="hidden" name="from" value="monitor" />
        </form>
      </div>
    </AdminMonitorShell>
  );
}

export function renderAdminMonitorCronPage(options: {
  ctx: UiContext;
  data: { entries: AdminMonitorCronEntry[] };
  flash: { kind: "positive" | "negative"; text: string } | null;
}): string {
  return renderPage(
    <AdminMonitorCronPage ctx={options.ctx} data={options.data} flash={options.flash} />,
  );
}

// ---------------------------------------------------------------------------
// Queues (GET /-/admin/monitor/queue — queue.tmpl reduced to the landed
// depth sources; the manage page/set-workers/remove-arms are not rendered)
// ---------------------------------------------------------------------------

/** One rendered queue row. `inQueue` null = no landed counter for the
 *  queue's depth — the `-` arm (queue.tmpl:27's own countable-less render). */
export interface AdminMonitorQueueRow {
  /** The Cloudflare Queue name (wrangler.jsonc queues.producer). */
  name: string;
  /** The queue driver type — upstream renders the Go driver ("level",
   *  "channel"); ours is cloudflare's managed queue for every row. */
  type: string;
  inQueue: number | null;
}

/** The queues page's render inputs: the queue rows plus the webhook delivery
 *  log's per-state breakdown (the cf-gitea segment — the module header). */
export interface AdminMonitorQueuesData {
  queues: AdminMonitorQueueRow[];
  deliveryStates: Array<[string, number]>;
}

/**
 * The landed depth sources over the landed queues (wrangler.jsonc
 * queues.producer + consumers):
 *
 *   webhook-delivery       in-flight = webhook_deliveries rows in
 *                          `pending|delivering` — a row exists per queued
 *                          message (§3.5 step 3) and leaves the in-flight set
 *                          exactly when the consumer records the outcome.
 *   repo-tasks             the mirror producer's arm: repo_mirrors rows in
 *                          `queued|syncing` (§2.6 — idle→queued at enqueue,
 *                          queued→syncing at claim, →idle on settle). The
 *                          queue also carries purge tombstones, whose state
 *                          lives in DO storage, not D1 — the counter covers
 *                          the mirror arm only (the module header's note).
 *   webhook-delivery-dlq   no landed counter (a poisoned message only lands
 *                          here after the outcome write failed — the D1 log
 *                          cannot see it) → the `-` arm.
 */
/** The landed depth scan shared by the list + detail loaders (ONE copy of
 *  the derivations — the no-duplicate rule): two grouped counts over the
 *  webhook delivery log and the pull-mirror producer's state machine. */
async function queueDepthByState(db: ReturnType<typeof drizzle>): Promise<{
  deliveryByState: Map<string, number>;
  mirrorByState: Map<string, number>;
}> {
  const [deliveryRows, mirrorRows] = await Promise.all([
    db.select({ state: webhookDeliveries.state, n: sql<number>`count(*)` }).from(webhookDeliveries).groupBy(webhookDeliveries.state).all(),
    db.select({ state: repoMirrors.syncState, n: sql<number>`count(*)` }).from(repoMirrors).groupBy(repoMirrors.syncState).all(),
  ]);
  return {
    deliveryByState: new Map(deliveryRows.map((row) => [row.state, row.n])),
    mirrorByState: new Map(mirrorRows.map((row) => [row.state, row.n])),
  };
}

/** The landed queue registry rows from the depth scan (the list's three rows
 *  AND the manage page's known names — one registry copy; the qid identity
 *  is the queue name, the module header's divergence note). */
function landedQueueRows(depth: {
  deliveryByState: Map<string, number>;
  mirrorByState: Map<string, number>;
}): AdminMonitorQueueRow[] {
  return [
    {
      name: "webhook-delivery",
      type: "cloudflare-queue",
      inQueue: (depth.deliveryByState.get("pending") ?? 0) + (depth.deliveryByState.get("delivering") ?? 0),
    },
    {
      name: "repo-tasks",
      type: "cloudflare-queue",
      inQueue: (depth.mirrorByState.get("queued") ?? 0) + (depth.mirrorByState.get("syncing") ?? 0),
    },
    { name: "webhook-delivery-dlq", type: "cloudflare-queue", inQueue: null },
  ];
}

export async function loadAdminMonitorQueues(d1: D1Database): Promise<AdminMonitorQueuesData> {
  const db = drizzle(d1);
  const depth = await queueDepthByState(db);
  // The schema enum's five states, rendered in lifecycle order, zeros
  // included (the log's full posture — the breakdown is the point).
  const deliveryStates: Array<[string, number]> = [
    ["pending", depth.deliveryByState.get("pending") ?? 0],
    ["delivering", depth.deliveryByState.get("delivering") ?? 0],
    ["delivered", depth.deliveryByState.get("delivered") ?? 0],
    ["skipped", depth.deliveryByState.get("skipped") ?? 0],
    ["failed", depth.deliveryByState.get("failed") ?? 0],
  ];
  return { queues: landedQueueRows(depth), deliveryStates };
}

/** The queues page (queue.tmpl reduced to the sourced columns plus the
 *  Review link column — queue.tmpl:28, every row links its manage page; all
 *  three detail pages render) plus the cf-gitea delivery-state segment. */
export function AdminMonitorQueuePage(props: { ctx: UiContext; data: AdminMonitorQueuesData }) {
  return (
    <AdminMonitorShell ctx={props.ctx} title={adminMonitorLocale.queues} active="queue">
      <h4 class="ui top attached header">{adminMonitorLocale.queues}</h4>
      <div class="ui attached table segment">
        <table class="ui very basic table unstackable">
          <thead>
            <tr>
              <th scope="col">{adminMonitorLocale.queueName}</th>
              <th scope="col">{adminMonitorLocale.queueType}</th>
              <th scope="col">{adminMonitorLocale.queueNumberInQueue}</th>
              {/* queue.tmpl:16's unnamed link column. */}
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {props.data.queues.map((queue) => (
              <tr>
                <td>{queue.name}</td>
                <td>{queue.type}</td>
                <td>{queue.inQueue === null ? "-" : queue.inQueue}</td>
                <td>
                  {/* queue.tmpl:28 — the Review link to the manage page
                      (`$.Link` = /-/admin/monitor/queue, the qid appended). */}
                  <a href={`/-/admin/monitor/queue/${queue.name}`} class="button">
                    {adminMonitorLocale.queueReviewAdd}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* The cf-gitea addition — the landed log's per-state breakdown (the
          module header): the depth number alone hides the posture. */}
      <h4 class="ui top attached header">{adminMonitorLocale.deliveryStates}</h4>
      <div class="ui attached table segment">
        <table class="ui very basic table unstackable">
          {props.data.deliveryStates.map(([state, count]) => (
            <tr>
              <td width="200">{state}</td>
              <td>{count}</td>
            </tr>
          ))}
        </table>
      </div>
    </AdminMonitorShell>
  );
}

export function renderAdminMonitorQueuePage(options: { ctx: UiContext; data: AdminMonitorQueuesData }): string {
  return renderPage(<AdminMonitorQueuePage ctx={options.ctx} data={options.data} />);
}

// ---------------------------------------------------------------------------
// Queue manage (GET /-/admin/monitor/queue/{qid} + POST {qid}/remove-all-items
// — queue_manage.tmpl reduced; the /set arm has no landed substrate — the
// module header's adjudications. LANDED at 0cf8fd1: the parse/registration
// claims live in index.ts (the header's section is the mount record).)
// ---------------------------------------------------------------------------

/** The manage page's render inputs: the registry row (the qid resolved) plus
 *  whether the remove-all-items form renders. */
export interface AdminMonitorQueueDetailData {
  queue: AdminMonitorQueueRow;
  /** A landed purge body exists for this queue (the dead-control rule
   *  narrows upstream's per-countable form render to the purgeable rows). */
  purgeable: boolean;
  /** The platform arm's state (the /set adapter, SPEC-0021 §3) — the
   *  environment-status dimension + the verified runtime config + the
   *  declared value. Present on every load; the UNCONFIGURED posture is
   *  itself the honest state. */
  platform: AdminMonitorQueuePlatformState;
}

/** One queue's platform-arm state (the /set arm's environment-status
 *  display). `runtime` is the platform-verified consumer config (available
 *  only); `declaredMaxConcurrency` mirrors the allowlist var's
 *  declared_max_concurrency (wrangler.jsonc's queues.consumers entry). */
export interface AdminMonitorQueuePlatformState {
  status: MonitorPlatformStatus;
  /** The reason when not available (rendered verbatim). */
  detail: string | null;
  /** Whether THIS queue has a server-side allowlist entry (the /set form
   *  renders only then — an unlisted queue is unaddressable by design). */
  targetPresent: boolean;
  declaredMaxConcurrency: number | null;
  runtime: QueueConsumerSettings | null;
  /** The collection time of the runtime read (the display's "verified at"). */
  collectedAt: Date | null;
}

/**
 * The landed purge bodies — QueueRemoveAllItems's registry arm (queue.go:71),
 * one entry per queue whose in-flight set the D1 substrate can actually
 * clear; the render gate AND the apply dispatch derive from this map so they
 * can never drift (the CRON_RUN_BODIES posture). Exactly one landed body:
 *
 *   repo-tasks  reset `queued|syncing` → `idle` (the CAS shapes of
 *               services/mirror/sync.ts): a message dead-lettered into
 *               repo-tasks-dlq leaves its row stuck `queued` forever
 *               (repos/dlq.ts acks without touching D1) and only an idle
 *               row re-enters the cron producer's due-SELECT, so this reset
 *               IS the pipeline's "make it work again" arm — the next tick
 *               re-enqueues the due rows. `nextSyncAt` is untouched (the
 *               failure arm's posture: a due row retries on the next cron).
 *               The depth contract decides the WHERE: upstream counts base-
 *               queue items only and its purge shows 0 while on-the-fly
 *               items exist; our rendered depth counts queued+syncing, so
 *               the purge clears both.
 *
 * webhook-delivery and webhook-delivery-dlq stay absent — the module
 * header's adjudication (the delivery queue's items are the log rows;
 * upstream's purge preserves the log; the DLQ has no landed substrate).
 */
type QueuePurgeBody = (d1: D1Database) => Promise<void>;

const QUEUE_PURGE_BODIES: Readonly<Record<string, QueuePurgeBody>> = {
  "repo-tasks": (d1) =>
    drizzle(d1)
      .update(repoMirrors)
      .set({ syncState: "idle", updatedAt: new Date() })
      .where(inArray(repoMirrors.syncState, ["queued", "syncing"]))
      .run()
      .then(() => undefined),
};

/**
 * The manage page's qid path segment (the route passes the raw segment —
 * the orchestrator's fold). Decode failure → null, the engine's 404 funnel
 * (the org-members parse's posture).
 */
export function parseAdminMonitorQueueQid(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * QueueManage over the landed registry (queue.go:26): the qid resolves
 * against the SAME three rows the list renders (one registry copy —
 * landedQueueRows); an unknown name answers null → the route's 404
 * (upstream's nil GetManagedQueue arm, queue.go:29-32). The DLQ resolves
 * too — its detail renders the countable-less `-` arm with no form
 * (queue_manage.tmpl:29's own `{{if lt $sum 0}}` posture). Two point scans
 * of the same two grouped counts.
 *
 * The `options.platform` slice (the /set arm, SPEC-0021 §3): when present,
 * the loader ALSO reads the queue's consumer through the Cloudflare API —
 * the runtime value the Pool Settings panel displays next to the declared
 * one. A platform READ FAILURE never fails the page: the D1 registry row
 * still renders and the panel carries the environment-status dimension
 * instead (available / unconfigured / insufficient-permissions /
 * platform-unavailable — the freeze's honest-degraded arms). Absent options
 * (pre-fold routes) render the not-wired posture.
 */
export async function loadAdminMonitorQueueDetail(
  d1: D1Database,
  qid: string,
  options: {
    platform?: MonitorPlatformConfig;
    fetchImpl?: FetchImpl;
    now?: Date;
  } = {},
): Promise<AdminMonitorQueueDetailData | null> {
  const db = drizzle(d1);
  const depth = await queueDepthByState(db);
  const queue = landedQueueRows(depth).find((row) => row.name === qid);
  if (queue === undefined) {
    return null;
  }
  const platform = await loadQueuePlatformState(qid, options);
  return { queue, purgeable: QUEUE_PURGE_BODIES[qid] !== undefined, platform };
}

/** One queue's /set-arm state read (the manage page's platform panel AND
 *  the diagnosis report's queue-truth items share the shape derivation —
 *  the panel adds the runtime config, the report the collection stamp).
 *  Every failure kind degrades to its environment-status dimension; the
 *  page NEVER fails on a platform read. */
export async function loadQueuePlatformState(
  qid: string,
  options: { platform?: MonitorPlatformConfig; fetchImpl?: FetchImpl; now?: Date } = {},
): Promise<AdminMonitorQueuePlatformState> {
  const config = options.platform;
  if (config === undefined) {
    return { status: "unconfigured", detail: adminMonitorLocale.platformNotWired, targetPresent: false, declaredMaxConcurrency: null, runtime: null, collectedAt: null };
  }
  if (config.queueAllowlistError !== null) {
    return { status: "unconfigured", detail: config.queueAllowlistError, targetPresent: false, declaredMaxConcurrency: null, runtime: null, collectedAt: null };
  }
  const target = config.queueTargets.get(qid);
  if (target === undefined) {
    return {
      status: "unconfigured",
      detail: "this queue has no entry in the server-side consumer allowlist (MONITOR_QUEUE_CONSUMERS) — it is not addressable through the platform API by design",
      targetPresent: false,
      declaredMaxConcurrency: null,
      runtime: null,
      collectedAt: null,
    };
  }
  if (config.accountId === undefined || config.accountId === "" || config.queuesToken === undefined || config.queuesToken === "") {
    return {
      status: "unconfigured",
      detail: "the queue platform arm needs CLOUDFLARE_ACCOUNT_ID and the CLOUDFLARE_QUEUES_TOKEN secret",
      targetPresent: true,
      declaredMaxConcurrency: target.declaredMaxConcurrency,
      runtime: null,
      collectedAt: null,
    };
  }
  const read = await readQueueConsumer({
    accountId: config.accountId,
    apiToken: config.queuesToken,
    target,
    fetchImpl: options.fetchImpl,
  });
  const classified = classifyPlatformStatus(read);
  return {
    status: classified.status,
    detail: classified.detail,
    targetPresent: true,
    declaredMaxConcurrency: target.declaredMaxConcurrency,
    runtime: read.kind === "ok" ? read.settings : null,
    collectedAt: read.kind === "ok" ? (options.now ?? new Date()) : null,
  };
}

export type AdminMonitorQueueRemoveAllResult =
  | { outcome: "applied"; message: string }
  | { outcome: "unknown-queue" };

/**
 * QueueRemoveAllItems (queue.go:71-89) over the landed purge bodies: the
 * known-and-purgeable queue executes its body and answers the
 * remove_all_items_done flash; a queue with no landed purge body — the
 * webhook delivery queue, the DLQ, or any unknown name — answers
 * unknown-queue, which the route renders as upstream's nil-mq 404
 * (queue.go:77-80). The negative flash arm of the cron page has no
 * counterpart here: there is no producible invalid FORM (the button renders
 * only on purgeable rows), so every non-applied answer is a 404, never a
 * banner.
 */
export async function applyAdminMonitorQueueRemoveAllItems(
  d1: D1Database,
  qid: string,
): Promise<AdminMonitorQueueRemoveAllResult> {
  const purge = QUEUE_PURGE_BODIES[qid];
  if (purge === undefined) {
    return { outcome: "unknown-queue" };
  }
  await purge(d1);
  return { outcome: "applied", message: adminMonitorLocale.queueRemoveAllDone };
}

/** The environment-status label (the frozen four-value dimension, SPEC-0021
 *  §6 — the UI surfaces it verbatim). */
export function monitorEnvStatusLabel(status: MonitorPlatformStatus): string {
  switch (status) {
    case "available":
      return adminMonitorLocale.envAvailable;
    case "unconfigured":
      return adminMonitorLocale.envUnconfigured;
    case "insufficient-permissions":
      return adminMonitorLocale.envInsufficientPermissions;
    case "platform-unavailable":
      return adminMonitorLocale.envPlatformUnavailable;
  }
}

/** The max_concurrency render (null = the platform's auto arm). */
function maxConcurrencyText(value: number | null): string {
  return value === null ? adminMonitorLocale.autoLabel : String(value);
}

/** The Pool Settings panel's platform-state segment (the environment-status
 *  posture line — the honest-degraded arm for every non-available state). */
function QueuePlatformStatusLine(props: { platform: AdminMonitorQueuePlatformState }) {
  return (
    <p>
      <strong>{monitorEnvStatusLabel(props.platform.status)}</strong>
      {props.platform.detail !== null ? <> — {props.platform.detail}</> : null}
    </p>
  );
}

/** The Pool Settings section (queue_manage.tmpl:19-38 — the /set arm, now
 *  the Cloudflare-native adapter). The form renders ONLY when the platform
 *  read is available for an allowlisted queue (the dead-control rule: a
 *  form over an unreadable/unaddressable consumer would POST into the
 *  environment-status error — never a dead control); every other state
 *  renders the status line instead. The runtime row (the platform-verified
 *  GET) and the declared row (wrangler.jsonc's mirror) render SEPARATELY
 *  with the drift warning — the freeze's binding display contract. */
function QueuePoolSettings(props: { queueName: string; platform: AdminMonitorQueuePlatformState }) {
  const platform = props.platform;
  return (
    <>
      <h4 class="ui top attached header">{adminMonitorLocale.poolSettingsTitle}</h4>
      <div class="ui attached segment">
        <p>{adminMonitorLocale.poolSettingsDesc}</p>
        {platform.status === "available" && platform.targetPresent && platform.runtime !== null ? (
          <>
            <table class="ui very basic table">
              <tbody>
                <tr>
                  <td width="280">{adminMonitorLocale.runtimeValue}</td>
                  <td>
                    <strong>{maxConcurrencyText(platform.runtime.maxConcurrency)}</strong>
                    {platform.collectedAt !== null ? (
                      <span class="tw-ml-2">({formatMonitorFullTime(platform.collectedAt)} UTC)</span>
                    ) : null}
                  </td>
                </tr>
                <tr>
                  <td>{adminMonitorLocale.declaredValue}</td>
                  <td>{platform.declaredMaxConcurrency === null ? "-" : maxConcurrencyText(platform.declaredMaxConcurrency)}</td>
                </tr>
              </tbody>
            </table>
            <p>{adminMonitorLocale.driftWarning}</p>
            <form method="post" action={`/-/admin/monitor/queue/${props.queueName}/set`}>
              <div class="ui form">
                <div class="inline field">
                  <label for="max-number">{adminMonitorLocale.poolSettingsMaxNumber}</label>
                  <input name="max-number" type="text" placeholder={`Currently ${maxConcurrencyText(platform.runtime.maxConcurrency)}`} />
                </div>
                <button type="submit" class="ui submit button">
                  {adminMonitorLocale.poolSettingsSubmit}
                </button>
              </div>
            </form>
          </>
        ) : (
          <QueuePlatformStatusLine platform={platform} />
        )}
      </div>
    </>
  );
}

/** The manage page (queue_manage.tmpl reduced + the platform arms): the
 *  `Queue: %s` header (queue.go:33) over the sourced-columns detail table;
 *  the depth cell carries the remove-all-items form ONLY on a purgeable
 *  queue (upstream renders it for every countable queue, queue_manage.tmpl:
 *  33-35 — the dead-control rule narrows it), and the countable-less DLQ
 *  renders the `-` arm with no form (queue_manage.tmpl:29-31's own
 *  conditional). The Pool Settings section rides the platform state (the
 *  /set adapter — the form only on an available allowlisted read). The
 *  posture note carries the purge adjudications; `flash` is the no-JS POST
 *  answer banner (positive on an applied set/remove; negative on the failed
 *  binding or a degraded platform arm). */
export function AdminMonitorQueueManagePage(props: {
  ctx: UiContext;
  data: AdminMonitorQueueDetailData;
  flash: { kind: "positive" | "negative"; text: string } | null;
}) {
  const queue = props.data.queue;
  const title = adminMonitorLocale.queueManageTitle.replace("%s", queue.name);
  const manageLink = `/-/admin/monitor/queue/${queue.name}`;
  return (
    <AdminMonitorShell ctx={props.ctx} title={title} active="queue">
      <h4 class="ui top attached header">{title}</h4>
      {props.flash !== null ? <div class={`ui ${props.flash.kind} message`}>{props.flash.text}</div> : null}
      <div class="ui attached table segment">
        <table class="ui very basic table">
          <thead>
            <tr>
              <th>{adminMonitorLocale.queueName}</th>
              <th>{adminMonitorLocale.queueType}</th>
              <th>{adminMonitorLocale.queueNumberInQueue}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{queue.name}</td>
              <td>{queue.type}</td>
              <td>
                {queue.inQueue === null ? (
                  // queue_manage.tmpl:29-31 — the countable-less render.
                  "-"
                ) : (
                  <>
                    {queue.inQueue}
                    {props.data.purgeable ? (
                      <form action={`${manageLink}/remove-all-items`} method="post" class="tw-inline-block tw-ml-4">
                        <button type="submit" class="ui tiny basic red button">
                          {adminMonitorLocale.queueRemoveAll}
                        </button>
                      </form>
                    ) : null}
                  </>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {/* The Pool Settings section (queue_manage.tmpl:19-38's own header +
          segment shape — the /set adapter's surface). */}
      <QueuePoolSettings queueName={queue.name} platform={props.data.platform} />
      {/* The cf-gitea posture line (the purge adjudications — the set arm
          lives in the section above now). */}
      <div class="ui attached segment">
        <p>{adminMonitorLocale.queueManageReductions}</p>
      </div>
    </AdminMonitorShell>
  );
}

export function renderAdminMonitorQueueManagePage(options: {
  ctx: UiContext;
  data: AdminMonitorQueueDetailData;
  flash: { kind: "positive" | "negative"; text: string } | null;
}): string {
  return renderPage(<AdminMonitorQueueManagePage ctx={options.ctx} data={options.data} flash={options.flash} />);
}

// ---------------------------------------------------------------------------
// Trace (GET /-/admin/monitor/stacktrace — stacktrace.tmpl + trace_tabs.tmpl
// through the platform adapters: the stacktrace honest-absence note STANDS;
// perftrace = the enabled-posture section; profiling = the pprof adapter's
// form; diagnosis = the composite report's link)
// ---------------------------------------------------------------------------

/** The trace page's render inputs: the platform config decides which
 *  sections render controls vs posture lines (the dead-control rule — a
 *  form over an unconfigured token would POST into the redirect). Absent
 *  (pre-fold routes) renders every platform section in the unconfigured
 *  posture. */
export interface AdminMonitorTracePlatform {
  /** The profiling arm's trigger renders only when true (the profile token
   *  + account id present). */
  profileConfigured: boolean;
}

/**
 * The trace page. Upstream trace_tabs.tmpl carries three tabs (perftrace —
 * dev-only, the process/stacktrace pair) + the diagnosis form; ours carries
 * four SECTIONS (no tabs — one is the honest absence):
 *
 *   stacktrace  the honest-absence note STANDS (no goroutine/process
 *               introspection — the monitor's sole final reduction).
 *   perftrace   request tracing: the enabled posture (observability.traces
 *               is committed true) + the dashboard/tail pointers — the
 *               platform exposes NO on-demand query API (verified live
 *               2026-11-01), so the section states it honestly and links
 *               out instead of a fabricated query arm.
 *   profiling   the pprof adapter's form (cpu|heap, seconds bounded by the
 *               platform's 1..50) GETing /-/admin/monitor/profile with
 *               target="_blank" (upstream's GET-download posture) — only
 *               when the profile token is configured; the unconfigured
 *               line otherwise.
 *   diagnosis   upstream's "Download diagnosis report" control (GET,
 *               target="_blank") over the composite report page — ours
 *               renders the report as a page (the documented divergence).
 */
export function AdminMonitorTracePage(props: { ctx: UiContext; platform?: AdminMonitorTracePlatform }) {
  const profileConfigured = props.platform?.profileConfigured === true;
  return (
    <AdminMonitorShell ctx={props.ctx} title={adminMonitorLocale.monitoring} active="trace">
      <h4 class="ui top attached header">{adminMonitorLocale.trace}</h4>
      <div class="ui attached segment">
        <p>{adminMonitorLocale.traceUnavailable}</p>
      </div>
      {/* The perftrace section (request tracing — the enabled posture). */}
      <h4 class="ui top attached header">{adminMonitorLocale.perfTraceTitle}</h4>
      <div class="ui attached segment">
        <p>{adminMonitorLocale.perfTracePosture}</p>
        <p>
          <a href="https://developers.cloudflare.com/workers/observability/traces/" target="_blank" rel="noopener noreferrer">
            {adminMonitorLocale.perfTraceDocs}
          </a>
        </p>
      </div>
      {/* The profiling section (the pprof adapter). */}
      <h4 class="ui top attached header">{adminMonitorLocale.profileTitle}</h4>
      <div class="ui attached segment">
        {profileConfigured ? (
          <>
            <p>{adminMonitorLocale.profileConfiguredNote}</p>
            <form method="get" action="/-/admin/monitor/profile" target="_blank">
              <div class="ui form">
                <div class="inline field">
                  <label for="profile-type">{adminMonitorLocale.profileTypeLabel}</label>
                  <select name="type" id="profile-type">
                    <option value="cpu">cpu</option>
                    <option value="heap">heap</option>
                  </select>
                </div>
                <div class="inline field">
                  <label for="profile-seconds">{adminMonitorLocale.profileSecondsLabel}</label>
                  <input name="seconds" id="profile-seconds" size={3} maxlength={3} value="10" />
                </div>
                <button type="submit" class="ui primary small button">
                  {adminMonitorLocale.profileDownload}
                </button>
              </div>
            </form>
          </>
        ) : (
          <p>{adminMonitorLocale.profileUnconfigured}</p>
        )}
      </div>
      {/* The diagnosis section (the composite report's entrance). */}
      <h4 class="ui top attached header">{adminMonitorLocale.diagnosisTitle}</h4>
      <div class="ui attached segment">
        <form method="get" action="/-/admin/monitor/diagnosis" target="_blank">
          <button type="submit" class="ui primary small button">
            {adminMonitorLocale.diagnosisReport}
          </button>
        </form>
      </div>
    </AdminMonitorShell>
  );
}

export function renderAdminMonitorTracePage(options: { ctx: UiContext; platform?: AdminMonitorTracePlatform }): string {
  return renderPage(<AdminMonitorTracePage ctx={options.ctx} platform={options.platform} />);
}

// ---------------------------------------------------------------------------
// Diagnosis (GET /-/admin/monitor/diagnosis — the COMPOSITE report; upstream
// MonitorDiagnosis streams a ZIP, ours renders the per-item status page —
// the documented divergence: the status table IS the report)
// ---------------------------------------------------------------------------

/** One report item — SOURCE + collection time + availability status (the
 *  freeze's binding triple). `unavailable ≠ 0`: an unreadable item carries
 *  status "unavailable" + the reason, NEVER a fabricated zero detail. */
export interface AdminMonitorDiagnosisItem {
  key: string;
  label: string;
  /** Where the value came from (the source column, verbatim). */
  source: string;
  collectedAt: Date;
  status: "available" | "unavailable";
  /** The environment-status dimension for platform items (null for the
   *  local D1 items — they have no platform posture). */
  statusDimension: MonitorPlatformStatus | null;
  /** The value summary (available only). */
  detail: string | null;
  /** The reason (unavailable only). */
  unavailableReason: string | null;
}

export interface AdminMonitorDiagnosisData {
  collectedAt: Date;
  items: AdminMonitorDiagnosisItem[];
}

/** The diagnosis loader's options — the platform reads ride the same seams
 *  as the manage page (fetchImpl for tests; now for the collection stamps). */
export interface AdminMonitorDiagnosisOptions {
  now?: Date;
  fetchImpl?: FetchImpl;
}

/**
 * The composite report loader (SPEC-0021 §5). Per-item SOURCE + collection
 * time + availability:
 *
 *   queue-consumer:<name>  the Cloudflare Queues API read per allowlisted
 *                          entry — the QUEUE TRUTH (max_concurrency et al).
 *                          Unconfigured platform → ONE unavailable item
 *                          (never a per-queue row of zeros).
 *   d1-mirror:<name>       the landed D1 depth derivation per landed queue —
 *                          CLEARLY labeled the business mirror, NOT the
 *                          queue truth (the module header's adjudication);
 *                          always available (the D1 read is local).
 *   recent-errors          the cron_state error record (Workers Logs have
 *                          no query API — the landed error surface is the
 *                          honest substitute); a read store with zero
 *                          errors is a REAL zero, not a fabricated one.
 *   deployment-version     the Deployments API's serving deployment (the
 *                          profile token's Workers Scripts Read covers it).
 *   profiling              the Profiling arm's availability only — the
 *                          report never triggers a capture (that's the
 *                          trace page's bounded form).
 */
export async function loadAdminMonitorDiagnosis(
  env: Env,
  d1: D1Database,
  options: AdminMonitorDiagnosisOptions = {},
): Promise<AdminMonitorDiagnosisData> {
  const now = options.now ?? new Date();
  const config = monitorPlatformConfigFromEnv(env);
  const items: AdminMonitorDiagnosisItem[] = [];

  // --- the queue truth (the platform reads) -------------------------------
  const queueTargets = [...config.queueTargets.values()];
  const platformReady = config.queueAllowlistError === null && config.accountId !== undefined && config.accountId !== "" && config.queuesToken !== undefined && config.queuesToken !== "";
  if (queueTargets.length === 0 || !platformReady) {
    items.push({
      key: "queue-consumers",
      label: "Queue consumers (Cloudflare queue truth)",
      source: adminMonitorLocale.diagnosisQueueTruthSource,
      collectedAt: now,
      status: "unavailable",
      statusDimension: "unconfigured",
      detail: null,
      unavailableReason:
        config.queueAllowlistError ??
        (queueTargets.length === 0
          ? "no queue consumer entries in the server-side allowlist (MONITOR_QUEUE_CONSUMERS)"
          : "the queue platform arm needs CLOUDFLARE_ACCOUNT_ID and the CLOUDFLARE_QUEUES_TOKEN secret"),
    });
  } else {
    for (const target of queueTargets) {
      const read = await readQueueConsumer({
        accountId: config.accountId!,
        apiToken: config.queuesToken,
        target,
        fetchImpl: options.fetchImpl,
      });
      const classified = classifyPlatformStatus(read);
      items.push({
        key: `queue-consumer:${target.key}`,
        label: `Queue consumer ${target.key} (Cloudflare queue truth)`,
        source: adminMonitorLocale.diagnosisQueueTruthSource,
        collectedAt: now,
        status: read.kind === "ok" ? "available" : "unavailable",
        statusDimension: classified.status,
        detail:
          read.kind === "ok"
            ? `max_concurrency ${maxConcurrencyText(read.settings.maxConcurrency)}, batch_size ${read.settings.batchSize ?? "-"}, max_retries ${read.settings.maxRetries ?? "-"}, DLQ ${read.settings.deadLetterQueue || "-"}`
            : null,
        unavailableReason: read.kind === "ok" ? null : (classified.detail ?? read.kind),
      });
    }
  }

  // --- the D1 business mirror (NOT the queue truth — labeled) -------------
  const depth = await queueDepthByState(drizzle(d1));
  const depthItems: Array<{ name: string; inQueue: number | null }> = [
    {
      name: "webhook-delivery",
      inQueue: (depth.deliveryByState.get("pending") ?? 0) + (depth.deliveryByState.get("delivering") ?? 0),
    },
    {
      name: "repo-tasks",
      inQueue: (depth.mirrorByState.get("queued") ?? 0) + (depth.mirrorByState.get("syncing") ?? 0),
    },
    { name: "webhook-delivery-dlq", inQueue: null },
  ];
  for (const row of depthItems) {
    items.push({
      key: `d1-mirror:${row.name}`,
      label: `${row.name} in-flight (D1 business mirror)`,
      source: adminMonitorLocale.diagnosisD1MirrorSource,
      collectedAt: now,
      status: "available",
      statusDimension: null,
      detail: row.inQueue === null ? "no landed counter (the DLQ's rows are unreachable from D1)" : `${row.inQueue} in-flight rows (business state)`,
      unavailableReason: null,
    });
  }

  // --- recent errors (the landed error surface) ---------------------------
  const state = await listCronState(d1);
  const errorEntries = [...state.values()].filter((row) => row.lastError !== null && row.lastError !== "");
  items.push({
    key: "recent-errors",
    label: "Recent errors (cron arms)",
    source: adminMonitorLocale.diagnosisCronErrorsSource,
    collectedAt: now,
    status: "available",
    statusDimension: null,
    detail:
      errorEntries.length === 0
        ? adminMonitorLocale.diagnosisCronErrorsNone
        : errorEntries.map((row) => `${row.arm}: ${row.lastError}`).join("; ").slice(0, 400),
    unavailableReason: null,
  });

  // --- the deployment version (the serving deployment) --------------------
  const deployment = await readLatestDeployment({
    accountId: config.accountId,
    apiToken: config.profileToken,
    workerName: config.workerName,
    fetchImpl: options.fetchImpl,
  });
  const deploymentClassified = classifyPlatformStatus(deployment);
  items.push({
    key: "deployment-version",
    label: "Deployment version (serving)",
    source: adminMonitorLocale.diagnosisDeploymentSource,
    collectedAt: now,
    status: deployment.kind === "ok" && deployment.result !== null ? "available" : "unavailable",
    statusDimension: deploymentClassified.status,
    detail:
      deployment.kind === "ok" && deployment.result !== null
        ? `deployment ${deployment.result.id.slice(0, 8)}…, version ${deployment.result.versions[0]?.versionId.slice(0, 8) ?? "?"}… at ${deployment.result.versions[0]?.percentage ?? "?"}%, created ${deployment.result.createdOn ?? "?"}${deployment.result.source !== null ? `, source ${deployment.result.source}` : ""}`
        : null,
    unavailableReason:
      deployment.kind === "ok" && deployment.result === null ? "the Deployments API answered with no deployments" : deployment.kind === "ok" ? null : (deploymentClassified.detail ?? deployment.kind),
  });

  // --- the profiling arm's availability (never a capture here) ------------
  const profilingConfigured = config.accountId !== undefined && config.accountId !== "" && config.profileToken !== undefined && config.profileToken !== "";
  items.push({
    key: "profiling",
    label: "Profiling (pprof)",
    source: adminMonitorLocale.diagnosisProfilingSource,
    collectedAt: now,
    status: profilingConfigured ? "available" : "unavailable",
    statusDimension: profilingConfigured ? "available" : "unconfigured",
    detail: profilingConfigured ? adminMonitorLocale.diagnosisProfilingArmed : null,
    unavailableReason: profilingConfigured ? null : "no CLOUDFLARE_PROFILE_TOKEN / CLOUDFLARE_ACCOUNT_ID — the Workers Profiling API is not wired",
  });

  return { collectedAt: now, items };
}

/** The diagnosis page (the per-item status table IS the report — upstream's
 *  ZIP divergence is documented in the module header). */
export function AdminMonitorDiagnosisPage(props: { ctx: UiContext; data: AdminMonitorDiagnosisData }) {
  return (
    <AdminMonitorShell ctx={props.ctx} title={adminMonitorLocale.diagnosisTitle} active="trace">
      <h4 class="ui top attached header">{adminMonitorLocale.diagnosisTitle}</h4>
      <div class="ui attached table segment">
        <table class="ui very basic table unstackable">
          <thead>
            <tr>
              <th>{adminMonitorLocale.diagnosisColHeader}</th>
              <th>{adminMonitorLocale.diagnosisSourceHeader}</th>
              <th>{adminMonitorLocale.diagnosisCollectedHeader}</th>
              <th>{adminMonitorLocale.diagnosisStatusHeader}</th>
              <th>{adminMonitorLocale.diagnosisDetailHeader}</th>
            </tr>
          </thead>
          <tbody>
            {props.data.items.map((item) => (
              <tr>
                <td>{item.label}</td>
                <td>{item.source}</td>
                <td>{formatMonitorFullTime(item.collectedAt)}</td>
                <td>
                  {item.status === "available" ? (
                    <>
                      {adminMonitorLocale.diagnosisAvailable}
                      {item.statusDimension !== null && item.statusDimension !== "available" ? (
                        <span class="tw-ml-2">({monitorEnvStatusLabel(item.statusDimension)})</span>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <strong>{adminMonitorLocale.diagnosisUnavailable}</strong>
                      {item.statusDimension !== null ? (
                        <span class="tw-ml-2">({monitorEnvStatusLabel(item.statusDimension)})</span>
                      ) : null}
                    </>
                  )}
                </td>
                <td>{item.status === "available" ? item.detail : item.unavailableReason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div class="ui attached segment">
        <p>{adminMonitorLocale.diagnosisD1MirrorNote}</p>
      </div>
    </AdminMonitorShell>
  );
}

export function renderAdminMonitorDiagnosisPage(options: { ctx: UiContext; data: AdminMonitorDiagnosisData }): string {
  return renderPage(<AdminMonitorDiagnosisPage ctx={options.ctx} data={options.data} />);
}

// ---------------------------------------------------------------------------
// The profile download (GET /-/admin/monitor/profile — the pprof adapter's
// route body, module-side so the fold's handler stays thin)
// ---------------------------------------------------------------------------

/** The route-shaped answer for the profile trigger: the redirect arm lands
 *  back on the trace page (a bad binding, an unconfigured token, or any
 *  degraded platform outcome — the console carries the reason, the admin
 *  sees the posture there); the download arm carries the VERIFIED gzipped
 *  pprof bytes + the attachment filename. */
export type AdminMonitorProfileDownload =
  | { kind: "redirect" }
  | { kind: "download"; bytes: Uint8Array; filename: string };

/**
 * The profile trigger (upstream's GET-download posture — MonitorDiagnosis is
 * a GET): parse the params (type cpu|heap, seconds → duration_ms within the
 * platform's 1..50 s), resolve the serving version from the deployments
 * read when it answers (the documented "latest" fallback otherwise), POST
 * the profile, and verify the bytes (size cap + gzip magic — profile.ts's
 * validation split). The binary is NEVER logged — outcomes are kinds and
 * byte counts only.
 */
export async function applyAdminMonitorProfileDownload(
  env: Env,
  params: URLSearchParams,
  options: { now?: Date; fetchImpl?: FetchImpl } = {},
): Promise<AdminMonitorProfileDownload> {
  const now = options.now ?? new Date();
  const parsed = parseMonitorProfileParams(params);
  const config = monitorPlatformConfigFromEnv(env);
  if (parsed === null || config.accountId === undefined || config.accountId === "" || config.profileToken === undefined || config.profileToken === "") {
    return { kind: "redirect" };
  }
  // The serving version when the deployments read answers; "latest" (the
  // documented fallback — most recently CREATED, not necessarily deployed)
  // otherwise.
  let versionId: string | undefined;
  const deployment = await readLatestDeployment({
    accountId: config.accountId,
    apiToken: config.profileToken,
    workerName: config.workerName,
    fetchImpl: options.fetchImpl,
  });
  if (deployment.kind === "ok" && deployment.result !== null && deployment.result.versions[0]?.versionId) {
    versionId = deployment.result.versions[0].versionId;
  }
  const profile = await requestWorkerProfile({
    accountId: config.accountId,
    apiToken: config.profileToken,
    workerName: config.workerName,
    versionId,
    type: parsed.type,
    durationMs: parsed.durationMs,
    fetchImpl: options.fetchImpl,
  });
  if (profile.kind !== "ok") {
    // The reason goes to the console (observability) — the flash-less GET
    // download has no error page upstream either; the redirect lands on the
    // trace page whose sections state the posture. The classification rides
    // SPEC-0021 §5's binding taxonomy (platform.ts's frozen failure table —
    // the same nouns the deploy-probe battery reads), not the free-form
    // "degraded" the earlier draft logged: unconfigured is the skip/warn
    // arm, auth is a FAIL (never "platform unsupported"), a rate-limit is
    // the bounded-retry-then-report tail, platform-unavailable is the
    // environment-condition class, and an invalid body is the
    // read-back-mismatch fail.
    const taxonomy: Record<Exclude<ProfileOutcome["kind"], "ok">, string> = {
      unconfigured: "skip/warn",
      auth: "fail (auth — never platform unsupported)",
      "rate-limited": "report (bounded retries exhausted)",
      "platform-unavailable": "environment-condition",
      "invalid-response": "fail (read-back mismatch)",
    };
    console.error(`[monitor] profile trigger: ${taxonomy[profile.kind]} [kind: ${profile.kind}]`);
    return { kind: "redirect" };
  }
  return { kind: "download", bytes: profile.bytes, filename: profileFilename(parsed.type, now) };
}
