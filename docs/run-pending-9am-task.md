# RUN PENDING — the 09:00 v1.3 convergence task (handover fallback)

**Why this file exists**: the 03:55 window could not create the 09:00 cron —
this session's toolset lost `CronCreate`/`CronDelete` (only `CronList`
remains; retries exhausted). The appendix below is the VERBATIM 09:00 task
prompt the 03:55 window was to schedule. **To run it**: execute it in any
session (this one, if alive, carries full context), or create the cron —
`cron="0 9 30 10 *"`, `recurring=false`, title
"10月30日09:00额度收割+v1.3收敛发版：收割→收敛→门禁→部署→探针→notes→tag+release".

## Fresh context the 03:55 window adds (READ FIRST — supersedes stale items in the appendix's in-flight list)

**This section was rewritten at the END of the 03:55 harvest window (~04:05)
— everything below reflects the final tree state; ignore the older bullets.**

- The 1308 death tide hit 01:44–01:45 (quota reset 03:49:04). Dead by notice:
  ActionsConfig, org-packages, composite-preflight (691 s in, nothing
  produced). The F-row tail unit died WITHOUT a notice — its work was
  complete in the tree and HAS BEEN SALVAGED AND LANDED (1ff87d1, 46/46 +
  mounts, 327/327 neighbor suites).
- **The 03:55 window landed six commits itself** (92d2e87 → 1ff87d1): the
  goldens re-baseline f1bfff9 (the 39/80 committed-HEAD b0e1d88 fallout +
  the authorized a11y repair — goldens 80/80, a11y 88/88), the act_runner
  smoke record + guide follow-ups 90fa2d4, the salvaged ActionsConfig store
  97cb70e (migration 0043 IS COMMITTED — repo_units.config, the general
  page's two sections render; 24/24 + 36/36), and the F-row tails 1ff87d1
  (logs download / workflow 303 / badge.svg / dispatch-inputs fragment —
  the survey's F row is COMPLETE; expect tick-20 to read it LANDED).
- **Migration sequence for `pnpm db:migrate:remote`: 0041 + 0042 + 0043** —
  all three committed. The org-packages half-product (4 test failures at
  its death) was reverted by exact pathspec; re-dispatchable after 03:49
  (its triage correction stands: package_cleanup_rules IS the landed sixth
  table; the full CRUD page is buildable without schema changes).
- **The composite gate has still never been proven green at any post-b0e1d88
  HEAD** — the goldens fix should close the known 39-red class, but RUN THE
  GATE (`CF_TEST_STRIP_SOURCEMAPS=1 node scripts/full-suite-gate.mjs
  --solo`) and treat any residual red as the window's first fix item.
- New UNFIXED bug (found by the act_runner smoke): the one-shot
  `POST /install` first-admin window is DEAD on any migrated instance —
  migration 0003 seeds system user `assets` and `initWindowOpen` requires
  an empty users table (tests wipe users, so CI cannot see it). Fix wave
  needed; harmless for the live instance (it has users). Candidate fix:
  gate on "no non-system users" instead of an empty table.
  - **RESOLVED at `16a63b6`** (verified 2026-10-30, later window): the candidate fix shipped, refined into the identity-of-origin predicate — a system row is exactly `prohibited` + non-admin + email-less, the window now opens on "no non-system users", and the same predicate guards the atomic insert's NOT EXISTS so GET/POST can never disagree on a migrated instance; the UNFIXED text above is stale, kept verbatim for the handover record.
- act_runner v0.2.13 is PROVEN wire-compatible (Register/Declare/FetchTask/
  UpdateTask/UpdateLog/Heartbeats + a real containerized green job, logs
  sealed to R2 and read back — docs/research/act-runner-smoke-2026-10-30.md).
- Deploy posture decision pending: consider arming the real (gitignored)
  wrangler.jsonc with the ACTIONS_* retention trio at upstream's 90/365/400
  (the example documents the fail-closed default; arming matches upstream's
  always-on posture — safe on an instance with no old actions data).
- Survey tick-20 has NOT run; the notes' two TODO(final-window) placeholders
  (final HEAD/commit-count + final tick numbers) should use tick-19's
  114/2/0 with the "F row now complete — expect 116/1/0-class flip at
  tick-20" caveat if tick-20 cannot run before release.
- The 03:55 window could not refill the 6-pool after the tide (quota dead
  until 03:49); if this task runs after 03:49, re-dispatch candidates in
  priority order: (1) the org-packages page re-run (verdict in hand), (2)
  survey tick-20, (3) goldens for the four new page families, (4) the
  /install window fix — but ALL dispatching stops at 10:00.

## The deploy BUILD rehearsal verdict (07:15 unit — READ before deploying)

**GO** at 16a63b6: `pnpm build` exit 0 in 2.2 s; dist 45 MB / 793 files;
`dist/client/assets` 784/784 byte-parity; manifest carries all 4
REQUIRED_MANIFEST_KEYS (no UI-503 class). `wrangler deploy --dry-run` exit 0
— the binding graph matches the runbook: real D1 id (NOT the placeholder),
`DEMO_MODE "true"` + `ALLOW_SIGNUP "true"` posture preserved, custom-domain
route + workers_dev, cpu_ms 300000, both DLQ consumers, observability +
traces, cron pair. Expected-benign warnings: `rules` ignored under Vite;
missing-secrets trio (server-side, wrangler secret).

**The verified worktree copy-list (replay exactly)**: (1) `git worktree add
<dir> HEAD --detach`; (2) wire node_modules per scripts/verify-commit.mjs's
wireNodeModules (do NOT pnpm install); (3) **SYMLINK `gitea/` → the main
tree's checkout — REQUIRED: a fresh worktree's submodule dir is empty and
`pnpm build` dies at prebuild (gen:icons) without it** (this step was
missing from the earlier brief); (4) copy from main: `apps/worker/
public/assets/` (the 784-file official bundle), `apps/worker/wrangler.jsonc`
(copy, never edit), `apps/worker/src/ui/icons.generated.ts` (optional if
prebuild runs; required if bypassed); (5) `pnpm build` → dry-run from
apps/worker → re-eyeball the var table. At 2 s/build, simply rebuild at the
window's final HEAD. If the main tree is clean at final HEAD, a direct
main-tree `pnpm build` + deploy is equally valid (the runbook's first
preference).

## 附录：9 点任务 prompt 全文（逐字，来自 3:55 任务的嵌入附录）

cf-gitea 额度收割 + v1.3 收敛发版（2026-10-30 09:00 一次性）。目标：收割现场→恢复 6 并发收敛→发布 v1.3（不硬卡时点，收拾得差不多、基本可用即发；残余如实记 v1.4）。执行：1) 收割（同亲验三件套剧本+死亡名单精确 pathspec 教训）：盘点 git log/git status/裸 pnpm typecheck 归因；死亡单元有幸存产物→(a) 套件亲眼看（引擎 TSX=$(ls -d node_modules/.pnpm/tsx@*/node_modules/tsx/dist/cli.mjs | head -1) 跑 packages/git-engine/e2e/check-*.mjs；apps/worker 下 npx vitest run）(b) tsc --noEmit 零错（重定向看退出码）(c) node scripts/verify-commit.mjs→pathspec 提交推送；半成品按精确 pathspec 回退。03:55 窗口在飞名单以树与 todo 现场为准（五族整合器/M1b/nuget/unit 行一致性/勾选退役）。2) 收敛：收编完成后小修补可派轻量单元但 10:00 前停止一切派发；(a) 全树组合门禁 CF_TEST_STRIP_SOURCEMAPS=1 node scripts/full-suite-gate.mjs --solo 必须绿；(b) CI 绿确认（gh run list --repo HighCWu/cf-gitea --limit 3；契约例外册 scripts/check-openapi.mjs RUNTIME_ONLY_RESPONSES）；(c) 部署前先 pnpm db:migrate:remote（迁移 0041 的十二张 actions 表）；主树干净直接 pnpm build+deploy；混在飞文件走 /tmp/revert-verify worktree（checkout 新 HEAD→从主树拷 dist/client/assets→重拷 wrangler.jsonc→构建部署）；(d) 12 电池探针全绿（node scripts/deploy-probes.mjs all --base-url https://cf-gitea.hecongw.workers.dev --token-file <PAT>；PAT 用 node scripts/bootstrap-admin.mjs p0probe --remote 铸，用后删行删文件；红项按真bug→修/环境噪声→复跑取证/检查过期→带证据改处置）；(e) README 两处 TODO(final-window) 占位符填补（最终 HEAD + 最终 tick 数字，若 survey tick-19 未跑则以 tick-18 为准并把 implied 数字注明）+docs/RELEASE-NOTES-v1.3.md 终稿（补齐当日全部提交，诚实记录残余）；(f) git tag v1.3 && git push origin v1.3 && gh release create v1.3 --title "v1.3" --notes-file docs/RELEASE-NOTES-v1.3.md。3) 残余记 v1.4：actions-M1b 若未落/C3/C4/C5 余项、nuget/container 协议、ActionsConfig store 迁移、可用性 v1.4 清单。4) 收口后更新 todo 与 specs/README.md 索引行；观察 #16548/#16349/sweep-fire Oct 31 11:00 UTC（D1 孤儿 action 行应恒 0）。11:00 仍未发版则如实报告缺口与剩余量，不硬发；不标记长程目标完成。上游对齐规则（AGENTS.md）：原版行为即默认决策，不询问。
