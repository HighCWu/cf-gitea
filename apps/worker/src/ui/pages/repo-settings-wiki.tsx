/**
 * The repo settings WIKI panel — the bench-row module (pages wave 54;
 * MOUNTED at 46e7e68, window-2d — the route lives in `index.ts`; the
 * retired wiring HANDOFF is the mount record below).
 *
 * ## Brief-premise correction (verify-at-the-pin)
 *
 * `templates/repo/settings/wiki.tmpl` does NOT exist at the pin
 * (`fc4936884584`). The wiki settings surface lives inside
 * `templates/repo/settings/options.tmpl` in three pieces, all served by
 * `repo_setting.Settings`/`SettingsPost` (routers/web/repo/setting/
 * setting.go) behind `/{owner}/{repo}/settings`:
 *
 *   1. the Advanced-section wiki block   options.tmpl:319-355 — the
 *      `enable_wiki` checkbox, the `enable_external_wiki` radio pair
 *      (internal vs external), the `default_wiki_branch` input and the
 *      `external_wiki_url` input, posted as `action=advanced` through
 *      `handleSettingsPostAdvanced` (setting.go:560-613);
 *   2. the Danger-Zone "Delete Wiki Data" item
 *                                        options.tmpl:873-880 — gated on
 *                                        `.Permission.CanRead RepoUnitTypeWiki`;
 *   3. the `#delete-wiki-modal`          options.tmpl:1046-1062 —
 *      `dangerous_operation_form` posting `action=delete-wiki` with the
 *      typed repo-name confirmation → `wiki_service.DeleteWiki`
 *      (setting.go:983-995).
 *
 * This module renders that surface as the brief's dedicated settings
 * sub-page — exactly the wave-10 mirror-panel precedent: upstream renders
 * the section inside options.tmpl with no navbar item, so the navbar item
 * and the `repository settings wiki` pageClass discriminator are the
 * documented divergence.
 *
 * ## Write arms (§3.2 — the landed services, never a self-fetch)
 *
 * - Enable/disable: `saveRepoSettings(d1, repoId, { hasWiki })` — the exact
 *   write the PATCH arm applies (`has_wiki` → `settingsPatch.hasWiki`,
 *   routes/repo.ts:578; the same `repo_settings.has_wiki` column the wave-45
 *   `hasWiki` gate reads at src/index.ts:5441, upstream `MustEnableWiki`,
 *   web.go:1614). No validation to fail — the toggle is a boolean; the
 *   outcome is always "applied".
 * - NOT rendered — no dead controls (§2.4.1):
 *   - the `enable_external_wiki` radio pair + `external_wiki_url` input:
 *     the landed PATCH arm accepts-and-ignores the `external_wiki` object
 *     (src/api/models/repository.ts:260-262 — "accepted per shape and
 *     ignored"), there is no external-wiki store; the built-in wiki is the
 *     only landed flavor. Rendered as a read-only line + the honest absence
 *     note (the mirror panel's `editing_unavailable` pattern).
 *   - the `default_wiki_branch` input: upstream posts it to
 *     `wiki_service.ChangeDefaultWikiBranch` (setting.go:600-611); the
 *     landed wiki's branch IS the repository's default branch with no
 *     setter seam (`wikiBranch`, src/services/wiki.ts:348 — specs/wiki.md
 *     §3). Rendered as a read-only line carrying the effective branch.
 *   - the Delete Wiki Data button + `#delete-wiki-modal` (`action=delete-wiki`
 *     → `wiki_service.DeleteWiki`): no landed whole-wiki delete — the wiki
 *     service arms are per-page (`deleteWikiPage`, src/services/wiki.ts:735).
 *     The danger item renders its upstream title/body with the absence note
 *     in the item-trailing slot; the modal and its typed-confirmation form
 *     are not reproduced (a modal wrapping a dead form is still a dead
 *     control). The whole danger segment is gated on the wiki being enabled
 *     — upstream renders the item only when the wiki unit is readable and
 *     the modal only when the unit is enabled; a disabled wiki has nothing
 *     to delete.
 *
 * ## Mount record (MOUNTED at 46e7e68, window-2d — the wiring HANDOFF,
 *    retired; kept as the landed-shape record)
 *
 * Mounted over the landed settings family's exact posture (the mirror
 * panel's handlers were the template):
 *
 *   GET  /{owner}/{repo}/settings/wiki   resolveUiRequest → settingsGate →
 *                                        loadRepoWikiSettings →
 *                                        renderRepoWikiSettingsPage
 *                                        (`?saved=1` → the flash reduction,
 *                                        the `syncQueued` seam's twin)
 *   POST /{owner}/{repo}/settings/wiki   sameOriginGuard FIRST (the §2.8
 *                                        layer-2 check, the mirror POST's
 *                                        order) → settingsGate →
 *                                        parseRepoWikiForm(readUrlEncodedForm)
 *                                        → applyRepoWikiSettings → 303 onto
 *                                        `/{owner}/{repo}/settings/wiki?saved=1`
 *
 * Route-table entries ride the shared settingsGate (anonymous 303s onto the
 * login round-trip, a signed-in non-admin 404-shells — upstream's
 * admin-only settings posture). The nav fold is DONE (wave-settingsnav-fold):
 * the local `WikiSettingsNav` is deleted and `SettingsNav`
 * (pages/settings.tsx) carries `"wiki"` in its `active` union with the item
 * after Mirror (upstream renders no wiki navbar item — the divergence follows
 * the mirror item's placement rule). Survey rows touched
 * on landing: docs/compat/ui-parity-survey.md family E (the options row's
 * reduction note lists "the mirror/archive-tint sections" as not rendered —
 * add the wiki block's residue) and the F-family wiki row's page note.
 */

import { loadRepoSettings, saveRepoSettings } from "../../api/services/repo-settings";
import type { RepoRow, UiContext } from "../ui-context";
import { BaseLayout, renderPage } from "../shell";
import { SettingsNav } from "./settings";

/** Page chrome + notes text (component-local, the settingsLocale pattern —
 *  locale.ts is shared and not this wave's file; upstream locale keys cited,
 *  cf-gitea additions marked). */
export const wikiSettingsLocale = {
  wiki: "Wiki", // "repo.wiki" (the segment header; upstream's block label)
  wiki_desc: "Enable Repository Wiki", // "repo.settings.wiki_desc"
  use_internal_wiki: "Use Built-In Wiki", // "repo.settings.use_internal_wiki" (the fixed flavor's read-only line)
  default_wiki_branch_name: "Default Wiki Branch Name", // "repo.settings.default_wiki_branch_name"
  update_settings: "Update Settings", // "repo.settings.update_settings"
  update_settings_success: "The repository settings have been updated.", // "repo.settings.update_settings_success" (the ?saved=1 flash reduction's text)
  danger_zone: "Danger Zone", // "repo.settings.danger_zone"
  wiki_delete: "Delete Wiki Data", // "repo.settings.wiki_delete"
  wiki_delete_desc: "Deleting repository wiki data is permanent and cannot be undone.", // "repo.settings.wiki_delete_desc"
  // cf-gitea additions (the honest-absence notes; upstream renders live
  // controls here):
  flavor_note:
    "The built-in wiki is the only wiki flavor on this deployment. Upstream has an external-wiki option (the enable_external_wiki radio and external_wiki_url field); it is not rendered here: the repository-edit API accepts the external_wiki object but has no store for it.",
  branch_note:
    "The wiki follows the repository default branch; the upstream per-wiki branch setter has no landed write arm.",
  delete_unavailable:
    "The delete write is not supported yet: the wiki service exposes only per-page deletes (no whole-wiki delete arm landed).",
} as const;

/** The panel's render inputs: the stored unit flag (loadRepoSettings) plus
 *  the effective wiki branch (the repository's default — services/wiki.ts's
 *  wikiBranch) and the Actions unit flag (the settings nav's conditional
 *  Actions block — navbar.tmpl:47's unit conditional, the settings.tsx
 *  `hasActions` prop). */
export interface RepoWikiSettingsData {
  hasWiki: boolean;
  hasActions: boolean;
  defaultWikiBranch: string;
}

/** Load the panel (§3.2 — the landed loadRepoSettings read, the same store
 *  the PATCH arm writes and the wiki gate reads; the same read arms the
 *  nav's conditional Actions block). */
export async function loadRepoWikiSettings(d1: D1Database, repo: RepoRow): Promise<RepoWikiSettingsData> {
  const settings = await loadRepoSettings(d1, repo.id);
  return { hasWiki: settings.hasWiki, hasActions: settings.hasActions, defaultWikiBranch: repo.defaultBranch };
}

/** The parsed toggle form — upstream options.tmpl's `enable_wiki` checkbox
 *  field name verbatim (present = checked, the HTML checkbox semantics
 *  `handleSettingsPostAdvanced` binds through the RepoSettingForm's bool). */
export interface RepoWikiForm {
  enableWiki: boolean;
}

export function parseRepoWikiForm(params: URLSearchParams): RepoWikiForm {
  return { enableWiki: (params.get("enable_wiki") ?? "") !== "" };
}

export type RepoWikiResult = { outcome: "applied" };

/**
 * The toggle write — the PATCH arm's exact settings write for `has_wiki`
 * (routes/repo.ts:578 inlined over the same service): `saveRepoSettings`
 * upserts the merged row, an unchanged flag is a same-value upsert (the
 * basics form's "visibility only on a change" guard is unnecessary — the
 * settings upsert is idempotent and carries no rename/collision arms).
 */
export async function applyRepoWikiSettings(d1: D1Database, repo: RepoRow, form: RepoWikiForm): Promise<RepoWikiResult> {
  await saveRepoSettings(d1, repo.id, { hasWiki: form.enableWiki }, new Date());
  return { outcome: "applied" };
}

/** The full-document render (the render.tsx pattern). */
export function renderRepoWikiSettingsPage(options: {
  ctx: UiContext;
  data: RepoWikiSettingsData;
  error: string | null;
  /** The `?saved=1` flash reduction (the mirror page's `syncQueued` twin —
   *  no session-flash plumbing exists; the param is display-only). */
  saved: boolean;
}): string {
  return renderPage(
    <RepoWikiSettingsPage ctx={options.ctx} data={options.data} error={options.error} saved={options.saved} />,
  );
}

/**
 * The wiki panel (§2.4.1 discriminator: `repository settings wiki` — the
 * mirror-panel divergence; upstream renders these sections inside
 * options.tmpl, whose page is `repository settings options`).
 */
export function RepoWikiSettingsPage(props: {
  ctx: UiContext;
  data: RepoWikiSettingsData;
  error: string | null;
  saved: boolean;
}) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("RepoWikiSettingsPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout ctx={ctx} title={wikiSettingsLocale.wiki} pageClass="repository settings wiki">
      <div class="ui container flex-container">
        {/* The panel loads the unit flags — it evaluates navbar.tmpl:47's
            conditional and lights the nav's Actions block (the options
            page's hasActions threading). */}
        <SettingsNav repoLink={repoLink} active="wiki" repo={repo} hasActions={data.hasActions} />
        <div class="flex-container-main">
          {/* options.tmpl's Advanced-section wiki block (options.tmpl:319-355)
              reduced to the landed write arm: the enable checkbox form. */}
          <h4 class="ui top attached header">{wikiSettingsLocale.wiki}</h4>
          <div class="ui attached segment">
            <form class="ui form" action={`${repoLink}/settings/wiki`} method="post">
              {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
              {props.saved ? <div class="ui info message">{wikiSettingsLocale.update_settings_success}</div> : null}
              <div class="inline field">
                <div class="ui checkbox">
                  <input id="enable_wiki" name="enable_wiki" type="checkbox" checked={data.hasWiki} />
                  <label for="enable_wiki">{wikiSettingsLocale.wiki_desc}</label>
                </div>
              </div>
              {/* options.tmpl's #wiki_box (the radio pair + the two boxes)
                  reduced to read-only lines — the inputs would be dead
                  controls, the module header's not-rendered notes. */}
              <div class="field">
                <label>{wikiSettingsLocale.use_internal_wiki}</label>
                <p class="help">{wikiSettingsLocale.flavor_note}</p>
              </div>
              <div class="field">
                <label>{wikiSettingsLocale.default_wiki_branch_name}</label>
                <p>{data.defaultWikiBranch}</p>
                <p class="help">{wikiSettingsLocale.branch_note}</p>
              </div>
              <div class="field">
                <button type="submit" class="ui primary button">
                  {wikiSettingsLocale.update_settings}
                </button>
              </div>
            </form>
          </div>
          {/* options.tmpl's Danger-Zone wiki item (options.tmpl:873-880) +
              #delete-wiki-modal (options.tmpl:1046-1062) — the item's
              upstream gate (CanRead wiki / the modal's UnitEnabled) reduced
              to the stored flag; the item-trailing button + modal are the
              module header's honest absence. */}
          {data.hasWiki ? (
            <>
              <h4 class="ui top attached error header">{wikiSettingsLocale.danger_zone}</h4>
              <div class="ui attached error danger segment">
                <div class="flex-divided-list items-with-main">
                  <div class="item">
                    <div class="item-main">
                      <div class="item-title">{wikiSettingsLocale.wiki_delete}</div>
                      <div class="item-body">{wikiSettingsLocale.wiki_delete_desc}</div>
                    </div>
                    <div class="item-trailing">
                      <p class="help">{wikiSettingsLocale.delete_unavailable}</p>
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </BaseLayout>
  );
}
