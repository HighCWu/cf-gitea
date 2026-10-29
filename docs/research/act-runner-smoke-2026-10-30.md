# Real-binary act_runner smoke against the local cf-gitea Worker

2026-10-30 (smoke window 01:15–01:45 +08:00) · SPEC-0012 follow-up · the
standing E2E is the fake-runner harness (`services/actions/fake-runner.ts`);
this is the manual/real-binary gate the guide reserves for releases
(`docs/guide/actions-runners.md` §4 item 7, SPEC-0012 §6.5).

## Verdict up front

**Wire-compatible: YES** for the stock `act_runner` **v0.2.13** (the classic
0.2.x line the control plane targets) against the local Worker on the
procedures exercised: **Ping, Register, Declare, FetchTask (claim),
UpdateTask (terminal SUCCESS and FAILURE), UpdateLog (hot rows, ack/trim, and
the `no_more` seal into R2)** — plus the interceptor's
`x-runner-uuid`/`x-runner-token` auth and the debounced heartbeats. A real
job ran END-TO-END GREEN: claim → container execution → `UpdateTask{SUCCESS}`
→ the job/run/attempt rows rolled up to success → the log sealed at
`actions/logs/root/smoke/04/4.log` in local R2.

Execution failures observed along the way were **image/seeding problems on
the runner side, never wire rejections** — every RPC the binary sent was
answered the way upstream's server would.

Not exercised (honest scope): artifacts v1/v4, job summaries, OIDC exchange,
`--ephemeral`, cancel, the gRPC/gRPC-Web variants (unimplemented by design,
WIRE-FREEZE.md), and the successor `gitea/runner` 5.x line (still unverified
— the guide's 0.2.x pin stands).

## 1. Setup (everything local, nothing deployed)

- **Binary**: `act_runner` v0.2.13, `linux-amd64`, from
  `https://dl.gitea.com/gitea-runner/0.2.13/` (the `/act_runner/` path now
  redirects to `/gitea-runner/` — the renamed repo; the classic 0.2.13
  release is still hosted there).
  sha256 `3acac8b506ac8cadc88a55155b5d6378f0fab0b8f62d1e0c0450f4ccd69733e2`
  — matches both the release `.sha256` and `checksums.txt`.
  `./act_runner-0.2.13-linux-amd64 --version` → `act_runner version v0.2.13`.
- **Instance**: fresh local state (`.wrangler/state` wiped), 43 D1
  migrations applied (`pnpm db:migrate:local`; note 0043
  `repo_units.config` landed from a sibling wave mid-smoke and had to be
  re-applied before repo creation stopped 500ing), then
  `pnpm dev --host 127.0.0.1` → **the dev URL is `http://127.0.0.1:5173/`**
  (vite's own port; the `:8787` hint in AGENTS.md does not apply to the
  vite-plugin dev server).
- **Admin bootstrap — side finding, not actions-related**: the one-shot
  `POST /install` window is CLOSED on a freshly-migrated instance because
  migration `0003_glossy_turbo.sql` seeds the system user `assets` (id 1)
  and `initWindowOpen` (`services/user-accounts.ts:228`) returns true only
  when the users table is EMPTY. The first-run tests never see this because
  their `beforeEach` deletes all users. For the smoke I bootstrapped the
  admin + a PAT row directly via `wrangler d1 execute --local` (dev-only
  scratch; the PAT value is throwaway) and logged in through the REAL
  `POST /login` (PAT-as-password). **Flagging for the orchestrator: on any
  real deployment the documented first-admin path is dead on arrival.**
- **Repo**: created through the real web form (`POST /repo/create`,
  session + Origin guard) → `root/smoke`, created with the Actions unit
  armed (the 2026-10-29 creation-defaults flip verified live:
  `repo_units` row type `actions`, `repo_settings.has_actions = 1`).
- **Global registration token**: minted by the REAL page —
  `GET /-/admin/actions/runners` renders the token panel whose value is
  `getOrCreateActiveRunnerToken(d1, 0, "")`; D1 confirmed the row at
  scope `(owner_id=0, repo_id='')`, `is_active=1`.
  Token: `a37cfe468e0d9c37f686739906b9d1f2f2523b22` (local-only, scratch).

## 2. Register + Declare (real binary, real routes)

```
$ ./act_runner-0.2.13-linux-amd64 register --no-interactive \
    --instance http://127.0.0.1:5173 --token a37cfe46… \
    --name smoke-runner --labels "smoke:docker://busybox:latest"
level=info  msg="Registering runner, arch=amd64, os=linux, version=v0.2.13."
level=debug msg="Successfully pinged the Gitea instance server"
level=info  msg="Runner registered successfully."
```

- The binary's own connectivity probe **Ping** succeeded against
  `POST /api/actions/ping.v1.PingService/Ping`.
- **Register** (the one unauthenticated procedure) created runner id 1:
  `uuid 8eac6c88-756f-4e46-837a-19b9c8fdfab8`, `version v0.2.13`,
  `agent_labels ["smoke"]` — the runner stripped the
  `:docker://busybox:latest` schema and registered only the NAME, exactly
  as the guide §2.4 claims. The `.runner` file keeps the full label
  locally; the salted polling token came back once in the Register
  response (`3fdef657…`, scratch).
- **Declare** at daemon startup:
  `runner: smoke-runner, with version: v0.2.13, with labels: [smoke], declare successfully`
  — the interceptor accepted `x-runner-uuid`/`x-runner-token` and the
  runner row's labels/version were re-advertised.

Registration nuance: the guide §2.4's env-var spelling
(`GITEA_INSTANCE_URL=… GITEA_RUNNER_REGISTRATION_TOKEN=… register
--no-interactive`) did NOT work on 0.2.13 (`instance address is empty`) —
the `--instance`/`--token` flags are the reliable non-interactive form.

## 3. Dispatch: FetchTask claimed seeded jobs (3/3 runs)

Run rows were seeded through the service seam's exact shape
(`insertActionRun`, model.ts:493 — run + attempt-1 + waiting job, then the
three-scope `action_tasks_versions` bump) via `wrangler d1 execute --local`,
as the guide §2.6 sanctions for a dev instance. Each daemon start
immediately claimed:

```
level=info msg="task 4 repo is root/smoke http://127.0.0.1:5173/ http://127.0.0.1:5173"
```

- Label exact-match verified live: with the runner advertising `smoke`, the
  job (`runs_on ["smoke"]`) was claimed every time; a daemon that had
  re-declared the DEFAULT labels (`ubuntu-latest …`) never claimed it — the
  job stayed WAITING, per the guide.
- Claim side effects all landed: `action_tasks` row (status 6 running,
  fresh salted task token), `action_run_jobs.task_id` CAS flip, derived
  `log_filename` (`root/smoke/04/4.log`), and the heartbeats
  (`last_online`/`last_active` persisted on the runner row).

## 4. Execution + ingestion: one green run, one instructive failure

**Green run (task 4)** — payload with `runs-on: smoke`, label mapped to
`debian:bookworm-slim` (pre-pulled):

```
[ci/build] ⭐ Run Main echo hi-from-real-act-runner
[ci/build]   | hi-from-real-act-runner
[ci/build]   ✅  Success - Main echo hi-from-real-act-runner
[ci/build] 🏁  Job succeeded
```

Server-side aftermath, all written by UpdateTask/UpdateLog handlers:
`action_tasks` id 4 status **1 (succeeded)**; job, run, and attempt rows all
rolled up to status 1; the runner's hot log chunks were TRIMMED and the log
SEALED into R2 by the `no_more` finalize:

```
$ wrangler r2 object get cf-gitea-packs/actions/logs/root/smoke/04/4.log --local
2026-10-29T17:39:04.0250000Z smoke-runner(version:v0.2.13) received task 4 of job build, be triggered by event: push
2026-10-29T17:39:04.0250000Z workflow prepared
2026-10-29T17:39:04.0250000Z evaluating expression 'success()'
2026-10-29T17:39:04.0250000Z expression 'success()' evaluated to 'true'
2026-10-29T17:39:04.0260000Z 🚀  Start image=debian:bookworm-slim
…
```

**Failure run (task 3)** — same payload, label mapped to `busybox:latest`:
the container started, but the step died with exit 127 because busybox has
no `bash` (act runs `run:` steps via `bash --noprofile --norc -e -o
pipefail`). The runner reported **`UpdateTask{FAILURE}`** (task/job/run
status 2 in D1) and its log sealed to `actions/logs/root/smoke/03/3.log`.
A wire-clean failure: exactly the "execution fails, control plane holds"
posture the guide promises.

## 5. Findings worth acting on

1. **The claim payload's `runs-on:` drives the runner's image pick; the job
   ROW's `runs_on` drives only server-side matching.** The first run's
   seeded payload omitted `runs-on:` — the server dispatched it fine (row
   match), but the runner parsed no label from the YAML and fell back to
   its hard-coded default image
   (`docker.gitea.com/runner-images:ubuntu-latest`,
   `internal/pkg/labels/labels.go PickPlatform` at v0.2.13). It pulled a
   multi-GB ubuntu image for a job "matched" to a busybox label. M3's
   parser (which will store single-job bytes with `runs-on` rewritten)
   removes the trap; until then, any seeded/hand-made payload MUST carry
   `runs-on:` matching the job row. Worth a line in the M3 spec.
2. **A config file clobbers registered labels.** With a config file whose
   `runner.labels` is populated (the `generate-config` default ships the
   three ubuntu labels uncommented), daemon startup re-declares THOSE
   labels server-side and rewrites `.runner`
   (`daemon.go:51-53, 121-126` at v0.2.13) — my runner flipped from
   `["smoke"]` to `["ubuntu-latest","ubuntu-22.04","ubuntu-20.04"]` on
   first `--config` start. Operator guidance for the guide's §2.5: if you
   use a config file, set `runner.labels` to the same names you registered
   with.
3. **`dl.gitea.com/act_runner/` redirects to `/gitea-runner/`** (the
   renamed repo). The classic 0.2.13 binaries remain hosted; the guide
   §2.3's URL still works via redirect, but the displayed tree is the 5.x
   line — keep §2.3's "pin 0.2.x" warning prominent.
4. **The `/install` one-shot window is closed by the migration-seeded
   `assets` system user** (§1 above) — pre-existing, NOT an actions issue;
   needs its own fix wave.
5. The repo Actions pages 404 for an EMPTY repo — upstream-parity
   `MustBeNotEmpty` behavior, verified correct (my smoke repo had no
   commits); not a bug.

## 6. Raw artifacts (outside the repo)

`/tmp/act-smoke/`: the verified binary + checksums, `register.log`,
`daemon.log` (run 1: claim + fallback-image pull), `daemon2.log` (claim +
failure), `daemon4.log` (busybox 127), `daemon5.log` (green run, debug
level), `config.yaml` (working runner config), `.runner` (post-registration
credentials), the D1/R2 evidence queries quoted above. Local dev state
(D1/R2 rows) left in `apps/worker/.wrangler/state` as scratch evidence; the
runner and dev server were killed after capture — no background processes
remain.

Commands run for the record: binary download + sha256 verify; state wipe +
`pnpm db:migrate:local`; `pnpm dev --host 127.0.0.1`; admin/PAT bootstrap +
`POST /login`; `POST /repo/create`; `GET /-/admin/actions/runners` (token
scrape); `register --no-interactive`; three `daemon` runs; job seeding and
state resets via `wrangler d1 execute cf-gitea --local`; evidence queries
via `wrangler d1 execute` / `wrangler r2 object get --local`; `docker pull`
busybox/debian; process kill + port check at the end.
