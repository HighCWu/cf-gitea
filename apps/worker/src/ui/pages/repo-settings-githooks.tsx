/**
 * The repo settings GIT HOOKS tab — the bench-row UNMOUNTED module (pages
 * wave 65, bench row `wave-repo-githooks-module`, TWO-STAGE: this file ships
 * the module only; `index.ts` is a sibling owner — the HANDOFF NOTE at the
 * bottom of this header carries the route recipe).
 *
 * ## Premises verified at the pin (gitea @ fc4936884584-class pin)
 *
 * - Routes: `routers/web/web.go:1223-1227` — the `/hooks/git` group inside
 *   the `/{username}/{reponame}/settings` subtree: `m.Get("")` (the list),
 *   `m.Combo("/{name}")` GET (the edit form) + POST (the edit write), closed
 *   by `context.GitHookService()` (the group's service-closure middleware —
 *   initialization, NOT a permission gate).
 * - Handlers: `routers/web/repo/setting/git_hooks.go` — `GitHooks` (list),
 *   `GitHooksEdit` (GET form), `GitHooksEditPost` (POST write; redirects onto
 *   `{RepoLink}/settings/hooks/git`, git_hooks.go:66).
 * - Templates: `templates/repo/settings/githooks.tmpl` (pageClass
 *   `repository settings githooks`) + `githook_edit.tmpl` (pageClass
 *   `repository settings edit githook`), both through
 *   `repo/settings/layout_head` (the shared settings navbar +
 *   `.repo-setting-content` wrapper).
 * - THE GATE: the whole settings group is wrapped in
 *   `reqSignIn, context.RepoAssignment, reqRepoAdmin` (web.go:1285-1287) —
 *   so ALL THREE handlers are repo-admin-only upstream, not just the edit
 *   pair. Our mirror is the shared settingsGate posture (anonymous 303 onto
 *   the login round-trip, a signed-in non-admin 404-shells — the same
 *   `isRepositoryAdmin` class the landed API family's `requireRepoAdmin`
 *   enforces, routes/git-hooks.ts). Documented divergence: upstream ALSO
 *   chains the per-user `reqGitHook` flag (`CanEditGitHook` — the navbar
 *   item's `SignedUser.CanEditGitHook` gate, navbar.tmpl:34) after reqAdmin
 *   for the WRITE APIs; the landed family drops that flag (routes/
 *   git-hooks.ts header divergence note 4 — no column, no settings model),
 *   so this page renders for every repo admin and the nav scaffold shows
 *   the Git Hooks item unconditionally (the page is only served past the
 *   admin gate anyway).
 *
 * ## Data (§3.2 — the landed ops, never a self-fetch)
 *
 * The landed git-hooks API family is `src/api/routes/git-hooks.ts` (4 ops:
 * list/get/patch/delete over `githooks/<repositories.id>/<hook_name>` in the
 * REPO_PACKS bucket — no table, no migration). There is NO service layer for
 * it (the R2 read/store/clear helpers live private inside the route module,
 * which is not this wave's file), so this page carries the page-local
 * degenerate port over the SAME documented R2 layout, importing the route
 * module's exported vocabulary + samples (`GIT_HOOK_NAMES`, `GIT_HOOK_SAMPLES`,
 * `asGitHookName` — the routes-module import precedent is
 * pages/settings-collaboration.tsx's TeamsService). The route module's
 * divergence notes apply verbatim: inactive hooks surface the embedded git
 * sample as `content` (omitted for the sample-less post-receive), and the
 * stored copy is `\r`-stripped while the form answer is verbatim. Landing
 * follow-up: extract the pair of helpers into `api/services/` so the route
 * and this page share one port.
 *
 * ## DOM contract
 *
 * The list is githooks.tmpl verbatim: layout_head's `.page-content
 * .repository settings githooks` → the settings navbar (Git Hooks item
 * active, `PageIsSettingsGitHooks` — set by ALL THREE upstream handlers) →
 * `.repo-setting-content` → the header/segment pair with
 * `repo.settings.githooks_desc`, the `{{if .Hooks}}` divider, and
 * flex-divided-list rows: the status dot (`tw-text-green` when
 * `.IsActive`, `tw-text-text-light` otherwise — octicon-dot-fill 22), the
 * name span, the pencil anchor onto `{RepoLink}/settings/hooks/git/{name}`
 * (PathEscape). The fixed three-name set never leaves the list empty, and
 * upstream renders no empty-state text — none is added.
 *
 * The edit page is githook_edit.tmpl verbatim: the form action is the hook's
 * OWN url (upstream `.Link`), the h4 header renders the hook name, the
 * `repo.settings.githook_edit_desc` segment ("If the hook is inactive,
 * sample content will be presented. Leaving content to an empty value will
 * disable this hook."), the `content` textarea prefilled
 * `{{if .IsActive}}{{.Content}}{{else}}{{.Sample}}{{end}}`, and the
 * `repo.settings.update_githook` ("Update Hook") submit.
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - THE CODE EDITOR: githook_edit.tmpl renders a `tw-hidden` textarea +
 *   `data-code-editor-config` + the editor-loading placeholder + the
 *   header's `repo/editor/options` partial, driven by the
 *   `initRepoSettingsGitHook` global init. This UI ships no code-editor
 *   asset, so the textarea renders plain and visible (same field name,
 *   same prefill, same `editor.code_editor.placeholder` placeholder) and
 *   the header's trailing editor-options slot reduces away.
 * - NO test-fire/delete controls: git hooks have none upstream either (the
 *   POST write IS the update+disable arm — empty content disables,
 *   hook.go:74-82); nothing to reduce.
 */

import { asGitHookName, GIT_HOOK_NAMES, GIT_HOOK_SAMPLES, type GitHookName } from "../../api/routes/git-hooks";
import type { RepoRow, UiContext } from "../ui-context";
import { BaseLayout, Icon, renderPage } from "../shell";
import { mirrorLocale, settingsLocale } from "./settings";

/** Page chrome + notes text (component-local, the settingsLocale pattern —
 *  locale.ts is shared and not this wave's file; upstream locale keys cited). */
export const gitHooksSettingsLocale = {
  githooks: "Git Hooks", // "repo.settings.githooks"
  githooks_desc:
    "Git Hooks are powered by Git itself. You can edit hook files below to set up custom operations.", // "repo.settings.githooks_desc"
  githook_edit_desc:
    "If the hook is inactive, sample content will be presented. Leaving content to an empty value will disable this hook.", // "repo.settings.githook_edit_desc"
  update_githook: "Update Hook", // "repo.settings.update_githook"
  editor_placeholder: "Enter file content here", // "editor.code_editor.placeholder" (the textarea placeholder upstream's editor carries)
} as const;

// ---------------------------------------------------------------------------
// The R2 reads/writes (routes/git-hooks.ts's private helpers, page-local port)
// ---------------------------------------------------------------------------

/** The stored (persisted-edit) hook content, or null when inactive — the
 *  `hooks/<name>` file read of hook.go GetHook degenerated to the object
 *  `githooks/<repoId>/<name>` (the route module's layout). The name always
 *  comes from the fixed vocabulary and the repo id from D1, so the key
 *  cannot escape the `githooks/` prefix (the route module's format gate is
 *  belt-and-braces for form input; nothing here is form-keyed). */
async function readStoredHook(r2: R2Bucket, repoId: string, name: GitHookName): Promise<string | null> {
  const object = await r2.get(`githooks/${repoId}/${name}`);
  return object === null ? null : await object.text();
}

/** hook.Update()'s arms (hook.go:74-93) over the same object key:
 *  TrimSpace-empty content removes the object (the disable arm — the R2
 *  delete of an absent key is a no-op), anything else stores the
 *  `\r`-stripped copy (the write arm; the form text itself is answered
 *  verbatim upstream — the route module's divergence note 3, not re-read
 *  here). */
async function writeStoredHook(r2: R2Bucket, repoId: string, name: GitHookName, content: string): Promise<void> {
  if (content.trim() === "") {
    await r2.delete(`githooks/${repoId}/${name}`);
    return;
  }
  await r2.put(`githooks/${repoId}/${name}`, content.replaceAll("\r", ""), {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// The list page (GET /settings/hooks/git — githooks.tmpl)
// ---------------------------------------------------------------------------

/** One rendered hook row: the vocabulary name plus the stored-edit presence
 *  (hook.go's IsActive — an object in the bucket means the hook is active). */
export interface GitHookListItem {
  name: GitHookName;
  isActive: boolean;
}

/** The list page's render inputs. */
export interface RepoGitHooksData {
  hooks: GitHookListItem[];
}

/** Load the list (the landed repoListGitHooks read arm's page twin: the
 *  fixed three-name set in hookNames order, one R2 read per name). */
export async function loadRepoGitHooks(r2: R2Bucket, repo: RepoRow): Promise<RepoGitHooksData> {
  const hooks = await Promise.all(
    GIT_HOOK_NAMES.map(async (name) => ({ name, isActive: (await readStoredHook(r2, repo.id, name)) !== null })),
  );
  return { hooks };
}

/** The full-document render for the list page (the render.tsx pattern). */
export function renderRepoGitHooksListPage(options: { ctx: UiContext; data: RepoGitHooksData }): string {
  return renderPage(<RepoGitHooksPage ctx={options.ctx} data={options.data} />);
}

/**
 * The git hooks list page (§2.4.1 discriminator: `repository settings
 * githooks` — githooks.tmpl): the settings navbar with the Git Hooks item
 * active, then `.repo-setting-content`'s header/segment pair and the
 * divided list of the three server hooks.
 */
export function RepoGitHooksPage(props: { ctx: UiContext; data: RepoGitHooksData }) {
  const { ctx } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("RepoGitHooksPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout ctx={ctx} title={gitHooksSettingsLocale.githooks} pageClass="repository settings githooks">
      <div class="ui container flex-container">
        <GitHooksSettingsNav repoLink={repoLink} />
        <div class="flex-container-main">
          <div class="repo-setting-content">
            <h4 class="ui top attached header">{gitHooksSettingsLocale.githooks}</h4>
            <div class="ui attached segment">
              <div>{gitHooksSettingsLocale.githooks_desc}</div>
              {/* githooks.tmpl's {{if .Hooks}} divider — the fixed three-name
                  set always renders, but the conditional rides the template
                  verbatim. */}
              {props.data.hooks.length > 0 ? <div class="divider"></div> : null}
              <div class="flex-divided-list">
                {props.data.hooks.map((hook) => (
                  <div class="item flex-text-block">
                    {/* The IsActive dot: green active, the neutral light
                        gray otherwise (githooks.tmpl:12's two-class mapping). */}
                    <span class={hook.isActive ? "tw-text-green" : "tw-text-text-light"}>
                      <Icon name="octicon-dot-fill" size={22} />
                    </span>
                    <span class="gt-ellipsis tw-flex-1">{hook.name}</span>
                    {/* The pencil anchor (githooks.tmpl:14) — PathEscape is a
                        no-op over the fixed vocabulary but rides the template. */}
                    <a class="muted tw-pr-2" href={`${repoLink}/settings/hooks/git/${encodeURIComponent(hook.name)}`}>
                      <Icon name="octicon-pencil" />
                    </a>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

// ---------------------------------------------------------------------------
// The edit page (GET+POST /settings/hooks/git/{name} — githook_edit.tmpl)
// ---------------------------------------------------------------------------

/** The edit page's render inputs: the validated hook name, its IsActive and
 *  the textarea prefill — active content, else the sample (the template's
 *  `{{if .IsActive}}{{.Content}}{{else}}{{.Sample}}{{end}}`). */
export interface GitHookEditData {
  name: GitHookName;
  isActive: boolean;
  content: string;
}

/** Load the edit form (the landed repoGetGitHook read arm's page twin).
 *  `null` = the 404 shell: a non-vocabulary name — upstream
 *  `git.GetHook`'s ErrNotValidHook → ctx.NotFound (git_hooks.go:37-39),
 *  the route module's exact 404 class. */
export async function loadRepoGitHookEdit(r2: R2Bucket, repo: RepoRow, name: string): Promise<GitHookEditData | null> {
  const hookName = asGitHookName(name);
  if (hookName === null) return null;
  const stored = await readStoredHook(r2, repo.id, hookName);
  return {
    name: hookName,
    isActive: stored !== null,
    content: stored ?? GIT_HOOK_SAMPLES[hookName],
  };
}

/** The parsed edit form — githook_edit.tmpl's single `content` field name
 *  verbatim (absent binds to Go's zero "" — the disable arm). */
export interface RepoGitHookForm {
  content: string;
}

export function parseRepoGitHookForm(params: URLSearchParams): RepoGitHookForm {
  return { content: params.get("content") ?? "" };
}

export type RepoGitHookResult = { outcome: "applied" };

/**
 * The edit write — GitHooksEditPost's body over the route module's PATCH-arm
 * semantics: hook.GetHook (a non-vocabulary name is the caller's 404 shell),
 * then hook.Update()'s arms (`writeStoredHook` above). No validation to
 * fail — the outcome is always "applied"; the POST 303s onto
 * `{repoLink}/settings/hooks/git` (upstream's redirect, git_hooks.go:66 —
 * the HANDOFF NOTE's recipe).
 */
export async function applyRepoGitHook(
  r2: R2Bucket,
  repo: RepoRow,
  name: string,
  form: RepoGitHookForm,
): Promise<RepoGitHookResult> {
  const hookName = asGitHookName(name);
  if (hookName === null) throw new Error(`not a valid Git hook: ${name}`);
  await writeStoredHook(r2, repo.id, hookName, form.content);
  return { outcome: "applied" };
}

/** The full-document render for the edit page (the render.tsx pattern). */
export function renderRepoGitHookEditPage(options: { ctx: UiContext; data: GitHookEditData }): string {
  return renderPage(<RepoGitHookEditPage ctx={options.ctx} data={options.data} />);
}

/**
 * The git hook edit page (§2.4.1 discriminator: `repository settings edit
 * githook` — githook_edit.tmpl): the form action is the hook's own URL,
 * the header renders the hook name, the desc segment, the `content`
 * textarea prefilled active-content-else-sample and the Update Hook submit.
 * The code-editor pairing (hidden textarea + data-code-editor-config +
 * editor-loading + the header's editor-options partial) is the module
 * header's documented reduction.
 */
export function RepoGitHookEditPage(props: { ctx: UiContext; data: GitHookEditData }) {
  const { ctx } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("RepoGitHookEditPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const hookLink = `${repoLink}/settings/hooks/git/${props.data.name}`;
  return (
    <BaseLayout ctx={ctx} title={gitHooksSettingsLocale.githooks} pageClass="repository settings edit githook">
      <div class="ui container flex-container">
        <GitHooksSettingsNav repoLink={repoLink} />
        <div class="flex-container-main">
          <div class="repo-setting-content">
            <form class="ui form" action={hookLink} method="post">
              {/* The header's trailing slot carries upstream's
                  repo/editor/options partial — reduced (the module header). */}
              <h4 class="ui top attached header flex-left-right">{props.data.name}</h4>
              <div class="ui attached segment">{gitHooksSettingsLocale.githook_edit_desc}</div>
              <div class="ui attached fitted segment">
                {/* The plain-textarea reduction of the code-editor pairing:
                    same id/name/prefill/placeholder, rendered visible. */}
                <textarea id="content" name="content" placeholder={gitHooksSettingsLocale.editor_placeholder}>
                  {props.data.content}
                </textarea>
              </div>
              <div class="ui attached segment">
                <button type="submit" class="ui primary button">
                  {gitHooksSettingsLocale.update_githook}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

// ---------------------------------------------------------------------------
// The nav (mount scaffolding — the WikiSettingsNav pattern)
// ---------------------------------------------------------------------------

/**
 * The settings navbar with the Git Hooks item — MOUNT SCAFFOLDING ONLY (the
 * handoff note): the literal `SettingsNav` DOM (pages/settings.tsx) with the
 * Git Hooks item appended after Branches and active (upstream
 * navbar.tmpl:34-38 renders it after Tags, inside the code-unit block
 * before Keys — the upstream relative order keeps it behind Branches here;
 * our nav has no Tags/Keys items). The other items' texts import the
 * owner's locale objects; when the index.ts window folds this into
 * `SettingsNav` (the `active` union + the item), delete this component.
 * Upstream gates the item on `SignedUser.CanEditGitHook` — the landed gate
 * is repo-admin-only (routes/git-hooks.ts divergence note 4), so the item
 * renders unconditionally past the settingsGate.
 */
export function GitHooksSettingsNav(props: { repoLink: string }) {
  return (
    <div class="flex-container-nav">
      <div class="ui fluid vertical menu">
        <div class="header item">{settingsLocale.settings}</div>
        <a class="item" href={`${props.repoLink}/settings`}>
          {settingsLocale.options}
        </a>
        <a class="item" href={`${props.repoLink}/settings/collaboration`}>
          {settingsLocale.collaboration}
        </a>
        <a class="item" href={`${props.repoLink}/settings/hooks`}>
          {settingsLocale.hooks}
        </a>
        <a class="item" href={`${props.repoLink}/settings/branches`}>
          {settingsLocale.branches}
        </a>
        {/* upstream navbar.tmpl:34-38 — the Git Hooks item (PageIsSettingsGitHooks
            active), after Branches here (no Tags/Keys items in our reduced nav). */}
        <a class="active item" href={`${props.repoLink}/settings/hooks/git`}>
          {gitHooksSettingsLocale.githooks}
        </a>
        <a class="item" href={`${props.repoLink}/settings/mirror`}>
          {mirrorLocale.mirror_settings}
        </a>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HANDOFF NOTE (for the `index.ts` window owner — this module has NO route)
// ---------------------------------------------------------------------------
//
// Upstream group (web.go:1223-1227, inside the reqRepoAdmin-wrapped settings
// subtree at web.go:1183/1285-1287). Mount three routes over the shared
// settingsGate (index.ts:3238 — anonymous 303s onto the login round-trip, a
// signed-in non-admin 404-shells; the same posture as every settings
// sub-page):
//
//   GET  /{owner}/{repo}/settings/hooks/git          resolveUiRequest →
//          settingsGate → loadRepoGitHooks(c.env.REPO_PACKS, repo) →
//          renderRepoGitHooksListPage
//   GET  /{owner}/{repo}/settings/hooks/git/{name}   resolveUiRequest →
//          settingsGate → loadRepoGitHookEdit(c.env.REPO_PACKS, repo, name)
//          — `null` renders the 404 shell (upstream ErrNotValidHook →
//          ctx.NotFound) → renderRepoGitHookEditPage
//   POST /{owner}/{repo}/settings/hooks/git/{name}   sameOriginGuard FIRST
//          (the §2.8 layer-2 check — mirrorSyncSubmit's order,
//          index.ts:3336-3358) → settingsGate →
//          parseRepoGitHookForm(await readUrlEncodedForm(c.req.raw)) →
//          applyRepoGitHook(c.env.REPO_PACKS, repo, name, form) → 303 onto
//          `/{owner}/{repo}/settings/hooks/git` (upstream's redirect,
//          git_hooks.go:66); a non-vocabulary name throws — answer the 404
//          shell instead (mirror the GET arm).
//
// Router claims (parseUiRoute, index.ts:~2431): the numeric `/settings/
// hooks/{id}` guard does NOT match `git`, so the two families are disjoint
// already — add `rest.length === 2 && rest[0] === "hooks" && rest[1] ===
// "git"` → family `settings-githooks`, and `rest.length === 3 && rest[0] ===
// "hooks" && rest[1] === "git"` → family `settings-githook` carrying
// `name = rest[2]` (decodeURIComponent the name for asGitHookName's
// case-sensitive vocabulary check; anything non-vocabulary 404-shells in the
// handlers, so no name validation belongs in the parser). Register the
// uiRouter.get/post entries BEFORE the wave-14 `:id` block only for
// readability — hono serves the static `hooks/git` ahead of the param
// `hooks/:id` regardless (static-wins matching).
//
// Nav fold: extend pages/settings.tsx `SettingsNav`'s `active` union with
// `"githooks"`, insert the Git Hooks item between Branches and Mirror (the
// module's GitHooksSettingsNav is the literal DOM), then delete
// GitHooksSettingsNav. Survey rows to touch on landing:
// docs/compat/ui-parity-survey.md — the repo-settings family's hooks row
// (mark the `settings/hooks/git` list + edit pages rendered) and the
// navbar-reduction note (the Git Hooks item exists upstream at
// navbar.tmpl:34-38, gated on CanEditGitHook).
