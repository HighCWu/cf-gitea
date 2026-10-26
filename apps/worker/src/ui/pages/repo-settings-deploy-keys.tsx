/**
 * The repo settings DEPLOY KEYS tab, `/{owner}/{repo}/settings/keys` — pages
 * wave 71 (M-tier remainder row, PORT-FIRST; bench row
 * `wave-repo-deploy-keys-page`, TWO-STAGE UNMOUNTED — the route rides the
 * index.ts window; `index.ts` is orchestrator/sibling-owned).
 *
 * ## Premises verified at the pin (gitea @ fc4936884584-class pin)
 *
 * - Templates: `templates/repo/settings/deploy_keys.tmpl` (the page shell;
 *   layout_head pageClass is the LITERAL `repository settings` — the brief's
 *   "keys.tmpl" is the user-settings twin at this pin; the repo-settings
 *   files are deploy_keys.tmpl + deploy_key_list.tmpl) and
 *   `templates/repo/settings/deploy_key_list.tmpl` (the rows).
 * - Handlers: `routers/web/repo/setting/deploy_key.go` — `DeployKeys` (the
 *   list, :24-36), `DeployKeysPost` (the SSH add, :38-76), `DeleteDeployKey`
 *   (the delete, :78-88). `DeployKeyGenerateToken`/`DeployKeyRegenerateToken`
 *   (:90-124) are the token arms this page does not render (the reductions).
 * - Routes: `routers/web/web.go:1241-1246` — the `/keys` group inside the
 *   settings subtree: `m.Combo("")` GET DeployKeys + POST DeployKeysPost,
 *   `m.Post("/delete")` DeleteDeployKey (plus the two token POSTs). THE GATE:
 *   the whole settings group is wrapped in
 *   `reqSignIn, context.RepoAssignment, reqRepoAdmin` (web.go:1285-1287) —
 *   all three handlers are repo-admin-only upstream. Our mirror is the shared
 *   settingsGate posture (anonymous 303 onto the login round-trip, a
 *   signed-in non-admin 404-shells — the same `isRepositoryAdmin` class the
 *   landed API family's `requireRepoAdmin` enforces, routes/deploy-keys.ts).
 * - Navbar: `templates/repo/settings/navbar.tmpl:32-34` — the Deploy Keys
 *   item (`PageIsSettingsKeys` active, `{{.RepoLink}}/settings/keys`),
 *   upstream's relative order: inside the code-unit block after Git Hooks,
 *   before LFS (our reduced nav: after Branches, before Mirror).
 *
 * ## Data (§3.2 — the landed ops, never a self-fetch)
 *
 * The landed deploy-key family IS complete on this repo (services/
 * deploy-keys.ts — the upstream `deploykey` model port, ops landed at 4af12a9;
 * the SSH parser home consolidated into services/ssh-gpg-keys.ts at b396a41 —
 * reused, not forked). The page imports the SERVICE functions directly:
 *
 *   list    `listDeployKeys(d1, repoId, {keyId: 0, fingerprint: ""}, 1, 1000)`
 *           — upstream's web DeployKeys runs the UNPAGINATED
 *           `db.Find[ListDeployKeysOptions{RepoID}]` (deploy_key.go:29); the
 *           landed op's page/limit pair degenerates to page 1 under a ceiling
 *           no hosted repo reaches (documented reduction), and the op's
 *           `ToOrders → name` ordering is upstream's web ordering too (the
 *           Find helper applies the same options' ToConds/ToOrders).
 *   add     `addDeployKeySsh(d1, repoId, title, key, readOnly)` —
 *           AddDeployKeySSH verbatim; `readOnly = !is_writable` is
 *           deploy_key.go:57's `util.Iif(form.IsWritable, AccessModeWrite,
 *           AccessModeRead)`.
 *   delete  `getDeployKeyRow` + `deleteDeployKeyRow` — upstream's
 *           `asymkey_service.DeleteDeployKey` port; the miss is IDEMPOTENT
 *           (deploy_key.go:80-87 — "a key that is already gone leaves the
 *           caller with the state it asked for"), so both outcomes 303.
 *
 * Row decoration: `hasUsed`/`hasRecentActivity` are upstream's AfterLoad pair
 * (deploykey.go:45-52 — HasUsed `UpdatedUnix > CreatedUnix`, HasRecentActivity
 * `UpdatedUnix + 7d > now`); the rows carry updated = created at insert and
 * nothing bumps it until the git-HTTP arm lands, so both are false and the
 * "No recent activity" arm renders (the user-settings-keys.tsx convention).
 *
 * ## DOM contract (deploy_keys.tmpl + deploy_key_list.tmpl at the pin)
 *
 * layout_head's pageClass is the literal `repository settings`; the page is
 * `.repo-setting-content` → the `h4.ui.top.attached.header` ("Deploy Keys")
 * over the `.ui.attached.segment` carrying the add form (desc line, title
 * input, content textarea, is_writable checkbox with its info note) + the
 * `.flex-divided-list.items-with-main` — one `.item` per key:
 * `.item-leading` key glyph (green when used recently, tooltip
 * settings.key_state_desc), `.item-main` title / fingerprint (only when
 * non-empty) / the added-on · last-used-or-no-activity · Read[ · Write]
 * line, `.item-trailing` Remove. Empty store renders
 * `repo.settings.no_deploy_keys`.
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - The add-token PANEL + per-token Regenerate buttons are UNRENDERED: the
 *   upstream token arms (`{{.Link}}/generate-token`, `/regenerate-token`)
 *   defer with the mission's arm list (list / SSH add / delete); the landed
 *   API op `addDeployKeyToken` exists, so the polish wave can lift the panel
 *   verbatim. Token rows (keyType 2, creatable via the API family) still
 *   render data-driven in the list with the same row anatomy — the
 *   `octicon-key-asterisk` ssh/token icon split reduces to the one stand-in
 *   glyph below.
 * - DisableSSH (the header's disabled button + the IsErrSSHDisabled error
 *   arm) renders never: cf-gitea models no SSH server toggle (upstream
 *   setting.SSH.Disabled) — the user-settings-keys.tsx reduction.
 * - The add form renders directly (no `tw-hidden` panel, no `show-panel`
 *   toggle, no hide-panel Cancel — the compare.tsx no-JS reduction).
 * - The delete is a plain form POST to `/settings/keys/delete` with the id
 *   field (upstream's link-action `data-url="…/delete?id=N"` + the
 *   `<dialog class="modal-dialog">` confirm are not reproduced — the
 *   hooks-list reduction; the dialog's deploy_key_deletion_desc line and the
 *   success flash `deploy_key_deletion_success` do not render — the
 *   no-session-flash convention).
 * - THE ERROR TEXTS: the failed POST re-renders the service's exact ApiError
 *   texts (the family convention this page pins): the wired 422 bodies of
 *   routes/deploy-keys.ts — "Title: Required"/"Key: Required" (the Go
 *   binder's api.go:841-844 spelling), "Invalid key content: …"
 *   (HandleCheckKeyStringError), "Key content has been used as non-deploy
 *   key", "This key has already been added to this repository" and "A key
 *   with the same name already exists" (HandleAddKeyError's mapping).
 *   Documented divergence: upstream's WEB arm re-wraps these in locale lines
 *   (form.invalid_ssh_key / repo.settings.key_been_used / key_name_used,
 *   deploy_key.go:44-70); cf-gitea's UI surfaces the API texts verbatim so
 *   the web form and the API family answer with one vocabulary.
 */

import { ApiError } from "../../api/errors";
import { addDeployKeySsh, deleteDeployKeyRow, getDeployKeyRow, listDeployKeys } from "../../api/services/deploy-keys";
import type { DeployKeyRow } from "../../api/services/deploy-keys";
import type { IconName } from "../icons";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";
import { formatKeyDate } from "./user-settings-keys";
import { SettingsNav } from "./settings";

// ---------------------------------------------------------------------------
// Page chrome (the component-local locale pattern — locale.ts is shared and
// not this wave's file; every string cites its upstream key)
// ---------------------------------------------------------------------------

export const deployKeysSettingsLocale = {
  deploy_keys: "Deploy Keys", // "repo.settings.deploy_keys" (the title + navbar item)
  add_deploy_key_ssh: "Add SSH key", // "repo.settings.add_deploy_key_ssh"
  deploy_key_ssh_desc:
    "Add an SSH public key as deploy key, then use its private key to access the repository.", // "repo.settings.deploy_key_ssh_desc"
  title: "Title", // "repo.settings.title" (the form label)
  key_content: "Content", // "settings.key_content"
  key_content_ssh_placeholder:
    "Begins with 'ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'sk-ecdsa-sha2-nistp256@openssh.com', or 'sk-ssh-ed25519@openssh.com'", // "settings.key_content_ssh_placeholder"
  is_writable: "Enable Write Access", // "repo.settings.is_writable"
  is_writable_info_lead: "Allow this deploy key to ", // "repo.settings.is_writable_info" (the <strong> split)
  is_writable_info_strong: "push",
  is_writable_info_tail: " to the repository.",
  no_deploy_keys: "There are no deploy keys yet.", // "repo.settings.no_deploy_keys"
  added_on: "Added on", // "settings.added_on %s" — the date renders beside it
  last_used: "Last used on", // "settings.last_used"
  no_activity: "No recent activity", // "settings.no_activity"
  can_read_info: "Read", // "settings.can_read_info"
  can_write_info: "Write", // "settings.can_write_info"
  key_state_desc: "This key has been used in the last 7 days", // "settings.key_state_desc"
  remove: "Remove", // "remove"
} as const;

// ---------------------------------------------------------------------------
// The write arms (upstream DeployKeysPost / DeleteDeployKey over the landed ops)
// ---------------------------------------------------------------------------

/** The keys POST body (deploy_keys.tmpl's rendered field names verbatim; the
 *  checkbox posts its `value="1"` when checked and nothing when not). */
export interface DeployKeyForm {
  title: string;
  content: string;
  isWritable: boolean;
}

export function parseDeployKeyForm(params: URLSearchParams): DeployKeyForm {
  const raw = params.get("is_writable");
  return {
    title: params.get("title") ?? "",
    content: params.get("content") ?? "",
    isWritable: raw === "1" || raw === "on",
  };
}

/** The keys/delete POST body (upstream FormInt64("id") — a junk value is the
 *  same null an absent one is, and both 303 through the idempotent arm). */
export interface DeployKeyDeleteForm {
  id: number | null;
}

export function parseDeployKeyDeleteForm(params: URLSearchParams): DeployKeyDeleteForm {
  const raw = params.get("id") ?? "";
  return { id: /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null };
}

/** The add outcomes the POST handler renders (the org-settings-hooks
 *  create-result pattern): `field` is upstream JSONErrorWithField's arm —
 *  content for key-material errors, title for the name collision
 *  (deploy_key.go:62-66). */
export type AddDeployKeyOutcome =
  | { outcome: "created"; label: string }
  | { outcome: "invalid"; message: string; field: "title" | "content" };

/**
 * The SSH add — DeployKeysPost's body (deploy_key.go:38-76) over the landed
 * `addDeployKeySsh` (AddDeployKeySSH verbatim): the binder arms first (the
 * web form's `required` inputs backed by the Go binder's exact texts,
 * api.go:841-844), then the service — whose ApiError texts ARE the re-render
 * lines (the module header's error-texts note). The name-collision message
 * routes to the title field (upstream JSONErrorWithField(…, "title"),
 * deploy_key.go:66); every other 422 is key material (…, "content").
 */
export async function addDeployKeyFromForm(d1: D1Database, repo: RepoRow, form: DeployKeyForm): Promise<AddDeployKeyOutcome> {
  if (form.title === "") {
    return { outcome: "invalid", message: "Title: Required", field: "title" };
  }
  if (form.content === "") {
    return { outcome: "invalid", message: "Key: Required", field: "content" };
  }
  try {
    // util.Iif(form.IsWritable, AccessModeWrite, AccessModeRead) —
    // deploy_key.go:57; the service's readOnly flag is mode 1 vs 2.
    const added = await addDeployKeySsh(d1, repo.id, form.title, form.content, !form.isWritable);
    return { outcome: "created", label: added.row.name };
  } catch (error) {
    if (error instanceof ApiError && error.status === 422) {
      return {
        outcome: "invalid",
        message: error.message,
        field: error.message === "A key with the same name already exists" ? "title" : "content",
      };
    }
    throw error;
  }
}

/**
 * The delete — DeleteDeployKey (deploy_key.go:78-88) over the landed
 * `getDeployKeyRow` + `deleteDeployKeyRow`: an unknown id is IDEMPOTENT (the
 * service miss is upstream's swallowed ErrDeployKeyNotExist — deploy_key.go:
 * 80-81), so BOTH outcomes leave the caller with the state it asked for and
 * the handler 303s either way.
 */
export async function deleteDeployKeyFromForm(d1: D1Database, repo: RepoRow, form: DeployKeyDeleteForm): Promise<"deleted" | "missing"> {
  if (form.id === null) {
    return "missing";
  }
  const row = await getDeployKeyRow(d1, repo.id, form.id);
  if (row === null) {
    return "missing";
  }
  await deleteDeployKeyRow(d1, row);
  return "deleted";
}

// ---------------------------------------------------------------------------
// The list loader (upstream DeployKeys, deploy_key.go:24-36, over the landed
// listDeployKeys — the module header's unpaginated-Find reduction)
// ---------------------------------------------------------------------------

/** One rendered deploy key row: the stored row plus upstream's AfterLoad pair
 *  (deploykey.go:45-52 — HasUsed `updated > created`, HasRecentActivity
 *  `updated + 7d > now`). */
export interface DeployKeyListItem {
  row: DeployKeyRow;
  hasUsed: boolean;
  hasRecentActivity: boolean;
}

/** The page's render inputs. `form` re-renders the add form's submitted
 *  values (the blanks on the plain GET). */
export interface RepoDeployKeysPageData {
  keys: DeployKeyListItem[];
  form: DeployKeyForm;
}

/** The web list's single-page ceiling — upstream's web Find is unpaginated
 *  (deploy_key.go:29); the landed op's limit degenerates to this ceiling
 *  (the module header's reduction note). */
const LIST_CEILING = 1000;

/** The page load — `now` is the HasRecentActivity clock (fixed-clock tests,
 *  the milestones loader pattern). */
export async function loadRepoDeployKeys(d1: D1Database, repo: RepoRow, now: Date = new Date()): Promise<RepoDeployKeysPageData> {
  const activityFloor = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const { rows } = await listDeployKeys(d1, repo.id, { keyId: 0, fingerprint: "" }, 1, LIST_CEILING);
  return {
    keys: rows.map((row) => ({
      row,
      hasUsed: row.updatedAt.getTime() > row.createdAt.getTime(),
      hasRecentActivity: row.updatedAt.getTime() > row.createdAt.getTime() && row.updatedAt.getTime() >= activityFloor,
    })),
    form: { title: "", content: "", isWritable: false },
  };
}

// ---------------------------------------------------------------------------
// The render (deploy_keys.tmpl + deploy_key_list.tmpl at the pin)
// ---------------------------------------------------------------------------

/** The item-leading key glyph. Upstream renders `{{svg "octicon-key" 32}}`
 *  (token rows `octicon-key-asterisk` — the split reduces to one glyph, the
 *  module header); neither is in the generated icon allowlist —
 *  octicon-shield-lock is the documented stand-in (the feeds-glyph
 *  convention; a later allowlist extension swaps it per this one-line site). */
const KEY_ICON: IconName = "octicon-shield-lock";

/** The failed POST's re-render input: the message line + the field error
 *  class (the user-settings-keys KeysPageError shape). */
export type DeployKeyPageError = { message: string; field?: "title" | "content" };

/** The full-document render (the render.tsx pattern). `error` carries the
 *  failed POST's outcome (null on the plain GET) and `data.form` re-renders
 *  the submitted values (upstream RenderWithErrDeprecated's arm). */
export function renderRepoDeployKeysPage(options: { ctx: UiContext; data: RepoDeployKeysPageData; error: DeployKeyPageError | null }): string {
  return renderPage(<RepoDeployKeysPage ctx={options.ctx} data={options.data} error={options.error} />);
}

/**
 * The deploy keys page (§2.4.1 discriminator: `repository settings` —
 * deploy_keys.tmpl's layout_head pageClass literal). The settings navbar with
 * the Deploy Keys item active, then `.repo-setting-content`'s header/segment
 * pair: the add form (rendered open — the no-JS reduction) and the divided
 * key list.
 */
export function RepoDeployKeysPage(props: { ctx: UiContext; data: RepoDeployKeysPageData; error: DeployKeyPageError | null }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("RepoDeployKeysPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const error_ = props.error;
  return (
    <BaseLayout ctx={ctx} title={deployKeysSettingsLocale.deploy_keys} pageClass="repository settings">
      <div class="ui container flex-container">
        <SettingsNav repoLink={repoLink} active="keys" repo={repo} />
        <div class="flex-container-main">
          <div class="repo-setting-content">
            <h4 class="ui top attached header">
              {deployKeysSettingsLocale.deploy_keys}
              {/* The header's Add SSH key toggle button is the bundle's
                  show-panel control — the no-JS reduction renders the form
                  directly (the module header). */}
            </h4>
            <div class="ui attached segment">
              {/* The add panel, rendered open (upstream tw-hidden until the
                  toggle; the compare.tsx reduction). The form action is the
                  page's own URL — upstream `{{.Link}}`. */}
              <div class="tw-mb-4" id="add-deploy-key-ssh-panel">
                <form class="ui form" action={`${repoLink}/settings/keys`} method="post">
                  {error_ !== null ? <div class="ui negative message">{error_.message}</div> : null}
                  <div class="field">{deployKeysSettingsLocale.deploy_key_ssh_desc}</div>
                  <div class={error_?.field === "title" ? "field error" : "field"}>
                    <label for="deploy-key-title">{deployKeysSettingsLocale.title}</label>
                    <input id="deploy-key-title" name="title" value={data.form.title} required autofocus />
                  </div>
                  <div class={error_?.field === "content" ? "field error" : "field"}>
                    <label for="deploy-key-content">{deployKeysSettingsLocale.key_content}</label>
                    <textarea id="deploy-key-content" name="content" placeholder={deployKeysSettingsLocale.key_content_ssh_placeholder} required>
                      {data.form.content}
                    </textarea>
                  </div>
                  <div class="field">
                    {/* The checkbox carries its upstream value="1" — the
                        parser's two posted shapes ("1"/"on") cover the
                        value-less form fallback. */}
                    <label>
                      <input type="checkbox" name="is_writable" value="1" checked={data.form.isWritable ? true : undefined} />{" "}
                      {deployKeysSettingsLocale.is_writable}
                    </label>
                    <small>
                      {deployKeysSettingsLocale.is_writable_info_lead}
                      <strong>{deployKeysSettingsLocale.is_writable_info_strong}</strong>
                      {deployKeysSettingsLocale.is_writable_info_tail}
                    </small>
                  </div>
                  <button type="submit" class="ui primary button">
                    {deployKeysSettingsLocale.add_deploy_key_ssh}
                  </button>
                </form>
                <div class="divider"></div>
              </div>

              {/* deploy_key_list.tmpl — the {{if .RepoDeployKeys}} split. */}
              {data.keys.length > 0 ? (
                <div class="flex-divided-list items-with-main">
                  {data.keys.map((key) => {
                    // `$usedRecently := and $key.HasUsed $key.HasRecentActivity`
                    const usedRecently = key.hasUsed && key.hasRecentActivity;
                    return (
                      <div class="item" key={key.row.id}>
                        <div class="item-leading">
                          <span
                            class={usedRecently ? "tw-text-green" : undefined}
                            data-tooltip-content={usedRecently ? deployKeysSettingsLocale.key_state_desc : undefined}
                          >
                            <Icon name={KEY_ICON} size={32} />
                          </span>
                        </div>
                        <div class="item-main">
                          <div class="item-title">{key.row.name}</div>
                          {key.row.fingerprint !== "" ? <div class="item-body">{key.row.fingerprint}</div> : null}
                          <div class="item-body">
                            {deployKeysSettingsLocale.added_on} {formatKeyDate(key.row.createdAt)}
                            {" · "}
                            {key.hasUsed ? (
                              <>
                                {deployKeysSettingsLocale.last_used}{" "}
                                <span class={key.hasRecentActivity ? "tw-text-green" : undefined}>{formatKeyDate(key.row.updatedAt)}</span>
                              </>
                            ) : (
                              deployKeysSettingsLocale.no_activity
                            )}
                            {" · "}
                            {deployKeysSettingsLocale.can_read_info}
                            {/* `{{if not $key.IsReadOnly}} · Write{{end}}` */}
                            {key.row.mode !== 1 ? (
                              <>
                                {" · "}
                                {deployKeysSettingsLocale.can_write_info}
                              </>
                            ) : null}
                          </div>
                        </div>
                        <div class="item-trailing">
                          {/* The link-action + modal confirm reduced to the
                              plain form POST (the module header); upstream's
                              target is `{{.Link}}/delete?id=N` — the id rides
                              the form field here (the settings.tsx wave-14
                              note). The per-token Regenerate button defers
                              with the token arms. */}
                          <form method="post" action={`${repoLink}/settings/keys/delete`}>
                            <input type="hidden" name="id" value={String(key.row.id)} />
                            <button type="submit" class="ui red tiny button">
                              {deployKeysSettingsLocale.remove}
                            </button>
                          </form>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                deployKeysSettingsLocale.no_deploy_keys
              )}
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

// ---------------------------------------------------------------------------
// HANDOFF NOTE (for the `index.ts` window owner — this module has NO route)
// ---------------------------------------------------------------------------
//
// Upstream group (web.go:1241-1246, inside the reqRepoAdmin-wrapped settings
// subtree at web.go:1285-1287; the token POSTs /generate-token and
// /regenerate-token defer with the token arms). Mount three routes over the
// shared settingsGate (index.ts:3238 — anonymous 303s onto the login
// round-trip, a signed-in non-admin 404-shells; the same posture as every
// settings sub-page):
//
//   GET  /{owner}/{repo}/settings/keys         resolveUiRequest →
//          settingsGate → loadRepoDeployKeys(c.env.DB, repo) →
//          renderRepoDeployKeysPage({ctx, data, error: null})
//   POST /{owner}/{repo}/settings/keys         sameOriginGuard FIRST (the
//          §2.8 layer-2 check — settingsSubmit's order, index.ts:3262) →
//          resolveUiRequest → settingsGate → parseDeployKeyForm(await
//          readUrlEncodedForm(c.req.raw)) → addDeployKeyFromForm(c.env.DB,
//          repo, form) → "created" 303s onto
//          `/{owner}/{repo}/settings/keys` (upstream's JSONRedirect
//          ctx.Repo.RepoLink + "/settings/keys", deploy_key.go:75; the
//          success flash add_key_success does not render — the
//          no-session-flash convention) → "invalid" re-renders the page with
//          `error = {message, field}` and `data.form` carrying the submitted
//          values (upstream RenderWithErrDeprecated's arm).
//   POST /{owner}/{repo}/settings/keys/delete  sameOriginGuard FIRST →
//          resolveUiRequest → settingsGate → parseDeployKeyDeleteForm(await
//          readUrlEncodedForm(c.req.raw)) → deleteDeployKeyFromForm → 303
//          onto `/{owner}/{repo}/settings/keys` for BOTH outcomes (upstream's
//          idempotent delete — a gone key leaves the caller with the state it
//          asked for, deploy_key.go:80-87).
//
// Router claims (parseUiRoute, the `head === "settings"` block at
// index.ts:2424): add
//   `rest.length === 1 && rest[0] === "keys"` → family `settings-keys` (the
//   GET page + the POST add arm share the Combo("") shape), and
//   `rest.length === 2 && rest[0] === "keys" && rest[1] === "delete"` →
//   family `settings-keys-delete`.
// No collisions: the numeric `/settings/hooks/:id` guard requires
// `rest[0] === "hooks"`, and the branches/collaboration literals are
// disjoint; static literals beat any param family regardless (the
// hooks/git precedent). The key id rides the form field (upstream
// FormInt64), so no id appears in any pattern.
//
// Nav fold: DONE (wave-settingsnav-fold) — pages/settings.tsx `SettingsNav`'s
// `active` union carries "keys" and the Deploy Keys item sits in the upstream
// code-unit block (Branches → Tags → Git Hooks → Keys, navbar.tmpl:32-34),
// between Branches and Mirror; DeployKeysSettingsNav is deleted and the page
// renders `SettingsNav` with `active="keys"`. Survey rows to touch on landing:
// docs/compat/ui-parity-survey.md — the repo-settings family's deploy-keys
// row (mark `/settings/keys` rendered) and the navbar-reduction note (the
// item exists upstream at navbar.tmpl:32-34, admin-gated like the group).
