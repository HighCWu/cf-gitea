/**
 * The MIGRATING REPO HOME — the repo home's mid-migration arm (the
 * view.go:178-202 census row this module closes; repo-migrate-status.ts's
 * divergence 7 promised exactly this render). Upstream
 * `checkHomeCodeViewable` (routers/web/repo/view.go:178-202): when
 * `ctx.Repo.Repository.IsBeingCreated()` — our `repositories.status =
 * 'migrating'` (schema.ts:56, the imports/service.ts create-batch flip,
 * models/repo/repo.go:284-287's `IsBeingMigrated` fold) — the repo home
 * renders `templates/repo/migrate/migrating.tmpl` INSTEAD of the code tree,
 * before any git access, for every viewer with unit access. The page is
 * the status poller's home: `repo-migrate.ts`'s `initRepoMigrationStatus
 * Checker` reads `#repo_migrating[data-migrating-repo-link]`, polls
 * `{repoLink}/-/migrate/status` on a 2 s loop (the LANDED a0f3f40 status
 * endpoint answers it — `migrateStatusResponse`'s wire ints), reloads on
 * 4, reveals `#repo_migrating_retry[data-migrating-task-retry-url]` +
 * the failed blocks on 3, and the retry POSTs
 * `{repoLink}/settings/migrate/retry` (the LANDED retry endpoint). The
 * cancel modal's form posts `{repoLink}/settings/migrate/cancel` (the
 * LANDED cancel endpoint). This module is the buttons' home those
 * endpoints shipped without (repo-migrate-status.ts divergence 7).
 *
 * ## The data port (GetMigratingTask's arm — view.go:181-199)
 *
 * Upstream resolves the repo's ONE task row, then:
 *
 *   CloneAddr = util.SanitizeURL(cfg.CloneAddr)   Failed = task.Status == 3
 *   task missing → CloneAddr "" , Failed = true   (the TaskDoesNotExist arm)
 *
 * Our substrate has no task table — the record is `resolveMigrationRecord`
 * (repo-migrate-status.ts, the module-header resolution order) and the
 * status is `deriveMigrationStatus`:
 *
 * - CloneAddr: the MIRROR row's `remoteAddress` — already sanitized at
 *   rest (schema.ts:1701 "userinfo stripped, modules/util/url.go:21-27"),
 *   i.e. the stored value IS the SanitizeURL output upstream renders. The
 *   IMPORT row carries no source address anywhere (the chunked channel is
 *   push-based: `ImportService.create(repoId)` takes no clone_addr) → ""
 *   — the template's `migrating_failed_no_addr` failed arm, upstream's own
 *   shape for an address-less migration.
 * - Failed: `derived.status === 3`.
 * - Record null: upstream's TaskDoesNotExist arm verbatim — CloneAddr "",
 *   Failed true. In our substrate that state is unreachable-in-practice
 *   (the 'migrating' flip and the import-row INSERT are ONE D1 batch,
 *   imports/service.ts:392-407; every settle/abort/fail path flips the
 *   repo back to 'ready' in the same batch), rendered faithfully anyway.
 *
 * Reachability note (honest, not a behavior change): a repo actually
 * rendering this page (status 'migrating') carries an ACTIVE import in
 * practice — status 0/1, Failed false, the cancel arm. The Failed=true
 * pre-render arms are upstream's failure postures kept verbatim; the
 * VISIBLE failed state on an open page is poller-driven exactly upstream
 * (a failed import's status endpoint answers 3 — the record outlives the
 * repo flip — and the poller reveals retry + failed blocks).
 *
 * ## Gates
 *
 * - The page renders for every viewer the home route already admits
 *   (upstream `ctx.Repo.Permission.HasUnits()`; ours: resolveUiRequest's
 *   repo read grant — no new route claims; the arm rides the EXISTING home
 *   handler in ../render.tsx's `home` case, ahead of `loadHomeData`'s git
 *   access exactly like the upstream gate's early return).
 * - The admin button row (`{{if .Permission.IsAdmin}}` — upstream's REPO
 *   admin, not site admin): the landed `canAdminRepo` (pages/settings.tsx
 *   — the same predicate the retry/cancel routes' settingsGate enforces),
 *   so a non-admin never sees a button their POST would 404 on.
 *
 * ## Documented reductions (each with its reason)
 *
 * 1. THE DELETE ARM IS NOT REPRODUCED (the dead-control rule, §2.4.1 — the
 *    repo-settings-wiki.tsx precedent: "a modal wrapping a dead form is
 *    still a dead control"). Upstream's `{{if .Failed}}` button swaps
 *    cancel → "Delete This Repository" opening `#delete-repo-modal`, whose
 *    `dangerous_operation_form` posts `action=delete` + `repo_name` to
 *    `{RepoLink}/settings` — upstream SettingsPost DISPATCHES on the
 *    action field (setting.go), but the landed settingsSubmit has no
 *    action dispatch: the confirm form would ride `parseRepoBasicsForm` as
 *    a RENAME to the typed name, and the absent `private` checkbox would
 *    flip a private repo PUBLIC — an actively harmful misfire, not a dead
 *    link. The Failed admin arm renders the retry button only; the delete
 *    surface lands with the repo-delete wave.
 * 2. `base/alert` is reduced: the home route carries no flash substrate
 *    (upstream's flash sources here would be settings-write redirects,
 *    which land on /settings, not home).
 * 3. The cancel form drops the `form-fetch-action` class (the landed
 *    no-JS form convention — repo-migrate.tsx's reduce of the same class):
 *    the bundle would POST with `X-Gitea-Fetch-Action: 1` and expect the
 *    ctx.Redirect JSON arm, but the LANDED cancel route answers a bare
 *    303 (its repoMigrateCancelRoute carries no fetch-action arm), whose
 *    followed HTML response renders an error toast. The native form POST
 *    follows the 303 onto the repo home — which renders the ordinary home
 *    (the cancel batch flipped the repo back to 'ready'), the exact
 *    upstream redirect UX without the JSON round-trip. The native POST
 *    carries same-origin cookies + Origin, so sameOriginGuard and the
 *    settingsGate pass as designed.
 * 4. The modal's default No/Yes action arm: `octicon-x`/`octicon-check`
 *    are not in the icon allowlist — text-only buttons (the wiki modal
 *    precedent, pages/repo-wiki.tsx:808).
 * 5. The cancel dialog renders for EVERY viewer, verbatim upstream
 *    (migrating.tmpl renders both dialogs outside the IsAdmin gate); it
 *    is inert markup without the admin-only opener button, and its POST
 *    is the settingsGate's refusal for non-admins.
 */

import { deriveMigrationStatus, resolveMigrationRecord } from "./repo-migrate-status";
import { canAdminRepo } from "./settings";
import { BaseLayout } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";
import type { Viewer } from "../viewer";

/** The page's chrome text (the component-local locale pattern — locale.ts
 *  is shared and not this wave's file). Values are the pin's
 *  locale_en-US entries the template renders through ctx.Locale.Tr. */
export const migratingHomeLocale = {
  /** "repo.migrate.migrating" — the format keeps the template's <b> markup;
   *  the address substitutes through JSX (the Tr escape equivalent). */
  migrating_prefix: "Migrating from ",
  /** "repo.migrate.migrating_failed" — the same <b> composition. */
  migrating_failed_prefix: "Migrating from ",
  migrating_failed_suffix: " failed.",
  /** "repo.migrate.migrating_failed_no_addr" (also repo-migrate-status.ts's
   *  MIGRATE_FAILED_GENERIC — the address-less failed arm). */
  migrating_failed_no_addr: "Migration failed.",
  /** "repo.migrate.cancel_migrating_title" */
  cancel_migrating_title: "Cancel Migration",
  /** "repo.migrate.cancel_migrating_confirm" */
  cancel_migrating_confirm: "Do you want to cancel this migration?",
  /** "cancel" — the opener button. */
  cancel: "Cancel",
  /** "retry" — the poller-revealed button. */
  retry: "Retry",
  /** "modal.no" / "modal.yes" — the modal_actions_confirm default arm. */
  modal_no: "No",
  modal_yes: "Yes",
} as const;

/** The AssetUrlPrefix'd image paths (upstream `{{AssetUrlPrefix}}/img/…` —
 *  ours is the root-mounted `/assets` literal, the shell's favicon/logo
 *  precedent; loading.png + failed.png ship in the official bundle's
 *  webroot, gitea/public/assets/img/). */
const ASSET_IMG_PREFIX = "/assets/img";

/** Everything the migrating page renders, loaded by loadRepoMigratingData. */
export interface RepoMigratingData {
  /** Upstream `ctx.Data["CloneAddr"]` — the sanitized source address, ""
   *  for the import channel and the TaskDoesNotExist arm (module header). */
  cloneAddr: string;
  /** Upstream `ctx.Data["Failed"]` — the derived status is 3. */
  failed: boolean;
  /** Upstream `.Permission.IsAdmin` — the repo-admin grant (canAdminRepo);
   *  gates the cancel/retry button row. */
  canAdmin: boolean;
}

/**
 * Load the migrating page's data (the GetMigratingTask port — module
 * header): the record resolution + status derivation, the CloneAddr arm,
 * and the admin grant. Never throws on missing rows — a record-less repo
 * is upstream's TaskDoesNotExist arm, not an error.
 */
export async function loadRepoMigratingData(env: Env, repo: RepoRow, viewer: Viewer): Promise<RepoMigratingData> {
  const record = await resolveMigrationRecord(env.DB, repo.id);
  if (record === null) {
    // view.go:184-188 — the task-missing arm: CloneAddr "", Failed true.
    return { cloneAddr: "", failed: true, canAdmin: await canAdminRepo(env, repo, viewer) };
  }
  const derived = deriveMigrationStatus(record);
  return {
    // The mirror row's stored remoteAddress IS the SanitizeURL output
    // (module header); the import channel has no address ("" — the
    // template's no_addr failed arm).
    cloneAddr: record.kind === "mirror" ? record.row.remoteAddress : "",
    failed: derived.status === 3,
    canAdmin: await canAdminRepo(env, repo, viewer),
  };
}

/**
 * The migrating repo home (migrating.tmpl at the pin — the DOM contract is
 * byte-faithful minus the documented reductions: `.page-content.repository`
 * → repo header → the `.home` grid with the poller's `#repo_migrating`
 * (data-migrating-repo-link), the hidden failed-image twin, the progress +
 * failed blocks, the admin button row, and `#cancel-repo-modal`).
 */
export function RepoMigratingPage(props: { ctx: UiContext; data: RepoMigratingData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("RepoMigratingPage requires ctx.repo");
  // Upstream `.Link` — the request path (context.go:120) = the repo home
  // URL on this render; the poller and both forms compose onto it.
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout ctx={ctx} pageClass="repository">
      <div class="ui container">
        <div class="ui grid">
          <div class="sixteen wide column content">
            <div class="home">
              <div class="ui stackable middle very relaxed page grid">
                {/* The poller's handle — initRepoMigrationStatusChecker's
                    querySelector target; the data attr feeds the GET
                    `{repoLink}/-/migrate/status` loop. */}
                <div
                  id="repo_migrating"
                  class="sixteen wide tw-text-center centered column"
                  data-migrating-repo-link={repoLink}
                >
                  <div>
                    <img alt="" src={`${ASSET_IMG_PREFIX}/loading.png`} />
                  </div>
                </div>
                {/* The failed-state twin (the poller's showElem arm). */}
                <div id="repo_migrating_failed_image" class="sixteen wide tw-text-center centered column tw-hidden">
                  <div>
                    <img alt="" src={`${ASSET_IMG_PREFIX}/failed.png`} />
                  </div>
                </div>
              </div>
              <div class="ui stackable middle very relaxed page grid">
                <div class="sixteen wide tw-text-center centered column">
                  <div id="repo_migrating_progress">
                    {/* Tr "repo.migrate.migrating" CloneAddr — the <b> is the
                        locale format's markup; the address rides through JSX
                        escaping (Tr's HTML-escape equivalent). */}
                    <p>
                      {migratingHomeLocale.migrating_prefix}
                      <b>{data.cloneAddr}</b>…
                    </p>
                    {/* The poller's data.message target (status 0-2). */}
                    <p id="repo_migrating_progress_message" />
                  </div>
                  <div id="repo_migrating_failed" class="tw-hidden">
                    {data.cloneAddr !== "" ? (
                      <p>
                        {migratingHomeLocale.migrating_failed_prefix}
                        <b>{data.cloneAddr}</b>
                        {migratingHomeLocale.migrating_failed_suffix}
                      </p>
                    ) : (
                      <p>{migratingHomeLocale.migrating_failed_no_addr}</p>
                    )}
                    {/* The poller's failed-message target (status 3). */}
                    <p id="repo_migrating_failed_error" />
                  </div>
                  {data.canAdmin ? (
                    <>
                      <div class="divider" />
                      <div class="item">
                        {/* Upstream's {{if .Failed}} delete button is the
                            module header's reduction 1 (no landed action
                            dispatch); the else-arm's cancel button is the
                            LIVE opener for the LANDED cancel endpoint. */}
                        {data.failed ? null : (
                          <button type="button" class="ui basic show-modal button" data-modal="#cancel-repo-modal">
                            {migratingHomeLocale.cancel}
                          </button>
                        )}
                        {/* The retry button — hidden until the poller sees
                            status 3, then doMigrationRetry POSTs the
                            data-migrating-task-retry-url (the LANDED retry
                            endpoint) and reloads. */}
                        <button
                          type="button"
                          id="repo_migrating_retry"
                          data-migrating-task-retry-url={`${repoLink}/settings/migrate/retry`}
                          class="ui basic button tw-hidden"
                        >
                          {migratingHomeLocale.retry}
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* #cancel-repo-modal (migrating.tmpl:72-82) — rendered for every
          viewer verbatim upstream (reduction 5; inert without the admin
          opener). The form drops `form-fetch-action` (reduction 3) and
          posts the LANDED cancel endpoint; the default No/Yes action arm
          is text-only (reduction 4). */}
      <dialog class="modal-dialog" id="cancel-repo-modal">
        <div class="header">{migratingHomeLocale.cancel_migrating_title}</div>
        <form action={`${repoLink}/settings/migrate/cancel`} method="post">
          <div class="content">{migratingHomeLocale.cancel_migrating_confirm}</div>
          <div class="actions">
            <button type="button" class="ui cancel button">
              {migratingHomeLocale.modal_no}
            </button>
            <button type="submit" class="ui primary ok button">
              {migratingHomeLocale.modal_yes}
            </button>
          </div>
        </form>
      </dialog>
    </BaseLayout>
  );
}
