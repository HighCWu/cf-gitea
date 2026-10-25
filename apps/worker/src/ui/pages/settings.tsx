/**
 * The repo-settings landing + webhooks sub-page — pages wave 4 (SPEC-0008 U3
 * extension, authed write surfaces):
 *
 *   GET/POST /{owner}/{repo}/settings        the basics form (this module)
 *   GET/POST /{owner}/{repo}/settings/hooks  the webhooks list + add form
 *
 * ## DOM contract (templates/repo/settings/{layout_head,navbar,options}.tmpl
 *  + webhook/{base,base_list,settings,new}.tmpl + webhook/gitea.tmpl at the
 *  pin)
 *
 * `.page-content.repository settings {options|webhooks}`, then the upstream
 * settings layout: `.ui.container.flex-container` with the
 * `.flex-container-nav > .ui.fluid.vertical.menu` settings navbar (REDUCED to
 * the two live items — every other upstream item would be a dead link) and
 * the `.flex-container-main` content. The basics page is options.tmpl's
 * Basic Settings header/segment pair reduced to the name/description/
 * visibility fields; the hooks page is base_list.tmpl's header/segment pair
 * plus the add form (settings.tmpl + gitea.tmpl's field shapes).
 *
 * ## Auth + CSRF posture (SPEC-0010 §2.5/§2.8, the new-issue page's shape)
 *
 * Both pages render for the repo ADMIN viewer only — the landed
 * `isRepositoryAdmin` predicate (src/api/services/repo-access.ts) ported to
 * the session viewer: owner (case-folded namespace match) / site admin /
 * collaborator with the `admin` mode (`collaboratorModeOf`). The router
 * resolves the repo first (invisible → 404 shell), an anonymous viewer 303s
 * onto `/login?redirect_to=…`, and a signed-in non-admin 404-shells (upstream
 * settings pages are admin-only and equally undiscoverable). Both POSTs run
 * the §2.8 layer-2 Origin/Referer check (`sameOriginGuard`) — no CSRF token
 * (layer 1 is the SameSite=Lax cookie).
 *
 * ## Write paths (§3.2 — the landed services, never a self-fetch)
 *
 * - Basics: the PATCH /repos/{owner}/{repo} route's steps reduced to the
 *   form's fields — `RepoService.rename` (case-insensitive no-op guard, the
 *   route's `updateBasicProperties` port), `RepoService.setVisibility`, and
 *   `saveRepoSettings` for the description (the repoSettings side table).
 *   Name errors (invalid/reserved/collision) re-render with the service's
 *   message — the API's 422 family.
 * - Hooks: `createRepoHook` (src/api/services/hooks.ts) — the exact
 *   checkCreateHookOption validation (422 messages) surfaced inline, and
 *   `listRepoHooks` + one batched delivery-count read for the list.
 *
 * ## Documented v1 degradations (upstream options.tmpl is deep; §6 method)
 *
 * - The basics form merges visibility into it (upstream keeps the
 *   public/private flip behind a danger-zone dialog with typed
 *   confirmation); the confirmation step is not reproduced — the checkbox is
 *   a plain POST behind the Origin guard.
 * - Not rendered: avatar/template/website fields (no avatar pipeline; the
 *   template flag has no consumer; website is stored by saveRepoSettings but
 *   no page renders it yet), the mirror/archive-tint sections, and every
 *   other navbar item (collaboration/branches/keys/LFS/Actions — no pages).
 * - The hooks list is read-only: upstream links each row to its settings
 *   page and carries the edit/delete/test-fire actions — none of those pages
 *   or POST routes exist in the UI inventory, so rows render as text with a
 *   delivery count (upstream's per-hook LastStatus dot renders neutral: no
 *   last-status column exists). The provider dropdown menu (link_menu) is
 *   replaced by the single inline add form below the list.
 * - The add form fixes the hook type to `gitea` (the generic JSON webhook):
 *   the other nine HOOK_TYPES need provider-specific config fields (Slack
 *   channel &c.) the form does not render. Events stay the service default
 *   (push-only); the event radio/checkbox matrix is not rendered. Name,
 *   target URL, POST content type, secret and the active flag are the form's
 *   fields — the same field names the upstream gitea.tmpl posts.
 */

import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { ApiError } from "../../api/errors";
import { createRepoHook, hookEventsArray, listRepoHooks, type WebhookRow } from "../../api/services/hooks";
import { collaboratorModeOf } from "../../api/services/repo-collaborators";
import { loadRepoSettings, saveRepoSettings } from "../../api/services/repo-settings";
import { RepoNameCollisionError, RepoNameInvalidError, RepoService } from "../../repos/service";
import { webhookDeliveries } from "../../db/schema";
import type { RepoRow, UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import { BaseLayout, Icon, renderPage } from "../shell";

/** Page chrome text (component-local, the issuesLocale pattern — locale.ts
 *  is shared and not this wave's file). */
export const settingsLocale = {
  settings: "Settings", // "repo.settings"
  options: "Repository", // "repo.settings.options" (the navbar's first item text)
  hooks: "Webhooks", // "repo.settings.hooks"
  basic_settings: "Basic Settings", // "repo.settings.basic_settings"
  repo_name: "Repository Name", // "repo.repo_name"
  repo_desc: "Description", // "repo.repo_desc"
  visibility: "Visibility", // "repo.visibility"
  private_toggle: "Make Private", // "repo.settings.visibility.private.button" (checkbox form)
  update_settings: "Update Settings", // "repo.settings.update_settings"
  add_webhook: "Add Webhook", // "repo.settings.add_webhook"
  webhook_name: "Webhook name", // "repo.settings.webhook.name"
  payload_url: "Target URL", // "repo.settings.payload_url"
  content_type: "POST Content Type", // "repo.settings.content_type"
  secret: "Secret", // "repo.settings.secret"
  active: "Active", // "repo.settings.active"
  no_webhooks: "No webhooks yet.", // cf-gitea addition (upstream renders an empty segment)
  deliveries_1: "delivery", // cf-gitea addition: the per-hook delivery count chip
  deliveries: "deliveries", // cf-gitea addition
} as const;

// ---------------------------------------------------------------------------
// The admin predicate (the landed isRepositoryAdmin matrix, session-viewer
// port — repo-access.ts's module header)
// ---------------------------------------------------------------------------

/**
 * The repo-admin grant for the settings pages: site admin, the repo's owner
 * (case-folded namespace vs the viewer username — the same fold the D1
 * lookup uses), or a collaborator with the `admin` mode. Anonymous viewers
 * are never admins.
 */
export async function canAdminRepo(d1: D1Database, repo: RepoRow, viewer: Viewer): Promise<boolean> {
  if (viewer.kind === "user") {
    if (viewer.isAdmin || repo.ownerNamespace.toLowerCase() === viewer.username.toLowerCase()) return true;
    return (await collaboratorModeOf(d1, repo.id, viewer.id)) === "admin";
  }
  return false;
}

// ---------------------------------------------------------------------------
// The basics page (GET /settings + POST /settings)
// ---------------------------------------------------------------------------

/** The basics form's render inputs: the stored description (loadRepoSettings)
 *  plus the re-rendered submission. */
export interface RepoBasicsData {
  description: string;
  /** The submission under re-render ("" on the plain GET). */
  form: { name: string; description: string; isPrivate: boolean };
}

export async function loadRepoBasics(d1: D1Database, repo: RepoRow): Promise<RepoBasicsData> {
  const settings = await loadRepoSettings(d1, repo.id);
  return {
    description: settings.description,
    form: { name: repo.slug, description: settings.description, isPrivate: repo.visibility === "private" },
  };
}

export interface RepoBasicsForm {
  name: string;
  description: string;
  isPrivate: boolean;
}

/** Parse the urlencoded basics POST (`repo_name`, `description`, `private`). */
export function parseRepoBasicsForm(params: URLSearchParams): RepoBasicsForm {
  return {
    name: (params.get("repo_name") ?? "").trim(),
    description: params.get("description") ?? "",
    isPrivate: (params.get("private") ?? "") !== "",
  };
}

export type RepoBasicsResult = { outcome: "applied"; slug: string } | { outcome: "invalid"; message: string };

/**
 * The basics write — the PATCH route's steps for the form's fields. Rename
 * only on a case-insensitive change (the route's guard), visibility only on
 * a change, description through the settings upsert (always — the empty
 * description is a legitimate stored value). Name errors are the API's 422
 * messages, re-rendered inline.
 */
export async function applyRepoBasics(d1: D1Database, repo: RepoRow, form: RepoBasicsForm): Promise<RepoBasicsResult> {
  if (form.name === "") {
    return { outcome: "invalid", message: "Repository name cannot be empty." }; // cf-gitea addition (HTML5 required backs this)
  }
  const service = new RepoService(d1);
  const now = new Date();
  let slug = repo.slug;
  if (form.name.toLowerCase() !== repo.slug) {
    try {
      await service.rename(repo.id, form.name);
      slug = form.name.toLowerCase();
    } catch (error) {
      if (error instanceof RepoNameInvalidError || error instanceof RepoNameCollisionError) {
        return { outcome: "invalid", message: error.message };
      }
      throw error;
    }
  }
  const isPrivate = repo.visibility === "private";
  if (form.isPrivate !== isPrivate) {
    await service.setVisibility(repo.id, form.isPrivate);
  }
  await saveRepoSettings(d1, repo.id, { description: form.description }, now);
  return { outcome: "applied", slug };
}

/** The full-document render (the render.tsx pattern). */
export function renderRepoSettingsPage(options: {
  ctx: UiContext;
  data: RepoBasicsData;
  error: string | null;
}): string {
  return renderPage(<RepoSettingsPage ctx={options.ctx} data={options.data} error={options.error} />);
}

/** The settings navbar (repo/settings/navbar.tmpl reduced to the live items
 *  — the header comment's dead-link rule). */
function SettingsNav(props: { repoLink: string; active: "options" | "hooks" }) {
  return (
    <div class="flex-container-nav">
      <div class="ui fluid vertical menu">
        <div class="header item">{settingsLocale.settings}</div>
        <a class={props.active === "options" ? "active item" : "item"} href={`${props.repoLink}/settings`}>
          {settingsLocale.options}
        </a>
        <a class={props.active === "hooks" ? "active item" : "item"} href={`${props.repoLink}/settings/hooks`}>
          {settingsLocale.hooks}
        </a>
      </div>
    </div>
  );
}

/** The basics page (§2.4.1 discriminator: `repository settings options`). */
export function RepoSettingsPage(props: { ctx: UiContext; data: RepoBasicsData; error: string | null }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("RepoSettingsPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout ctx={ctx} title={settingsLocale.settings} pageClass="repository settings options">
      <div class="ui container flex-container">
        <SettingsNav repoLink={repoLink} active="options" />
        <div class="flex-container-main">
          <h4 class="ui top attached header">{settingsLocale.basic_settings}</h4>
          <div class="ui attached segment">
            <form class="ui form" action={`${repoLink}/settings`} method="post">
              {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
              <div class="required field">
                <label for="repo_name">{settingsLocale.repo_name}</label>
                <input id="repo_name" name="repo_name" value={data.form.name} data-repo-name={data.form.name} required maxlength={100} />
              </div>
              <div class="field">
                <label for="description">{settingsLocale.repo_desc}</label>
                <textarea id="description" name="description" rows={2} maxlength={2048}>
                  {data.form.description}
                </textarea>
              </div>
              <div class="inline field">
                <div class="ui checkbox">
                  <input id="private" name="private" type="checkbox" checked={data.form.isPrivate} />
                  <label for="private">{settingsLocale.private_toggle}</label>
                </div>
              </div>
              <div class="field">
                <button type="submit" class="ui primary button">
                  {settingsLocale.update_settings}
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
// The webhooks sub-page (GET/POST /settings/hooks)
// ---------------------------------------------------------------------------

/** One rendered hook row: the stored row, its event names (hookEventsArray)
 *  and its delivery count (the batched group-by read). */
export interface HookListItem {
  row: WebhookRow;
  events: string[];
  deliveries: number;
}

/** The hooks page render inputs. */
export interface HooksSettingsData {
  hooks: HookListItem[];
  /** The re-rendered add-form submission ("" on the plain GET). */
  form: { name: string; payloadUrl: string; contentType: string };
}

/** List page cap (listRepoHooks is paginated; one page serves the slice). */
export const HOOKS_LIST_LIMIT = 50;

export async function loadHooksSettings(d1: D1Database, repoId: string): Promise<HooksSettingsData> {
  const { items } = await listRepoHooks(d1, repoId, { page: 1, limit: HOOKS_LIST_LIMIT });
  // One batched delivery-count read for the page (the wave-2 batching
  // pattern; listHookDeliveries is per-hook and paginated — the count alone
  // is what the upstream list renders space for).
  const counts = new Map<number, number>();
  if (items.length > 0) {
    const rows = await drizzle(d1)
      .select({ hookId: webhookDeliveries.hookId, value: sql<number>`count(*)` })
      .from(webhookDeliveries)
      .where(inArray(webhookDeliveries.hookId, items.map((hook) => hook.id)))
      .groupBy(webhookDeliveries.hookId)
      .all();
    for (const row of rows) counts.set(row.hookId, Number(row.value));
  }
  return {
    hooks: items.map((row) => ({ row, events: hookEventsArray(row.events), deliveries: counts.get(row.id) ?? 0 })),
    form: { name: "", payloadUrl: "", contentType: "json" },
  };
}

export interface CreateHookForm {
  name: string;
  payloadUrl: string;
  contentType: string;
  secret: string;
  active: boolean;
}

/** Parse the urlencoded add-hook POST (the upstream gitea.tmpl field names:
 *  `name`, `payload_url`, `content_type`, `secret`, `active`). */
export function parseCreateHookForm(params: URLSearchParams): CreateHookForm {
  const contentType = params.get("content_type") ?? "json";
  return {
    name: (params.get("name") ?? "").trim(),
    payloadUrl: (params.get("payload_url") ?? "").trim(),
    contentType: contentType === "form" ? "form" : "json",
    secret: params.get("secret") ?? "",
    active: (params.get("active") ?? "") !== "",
  };
}

export type CreateHookResult = { outcome: "created" } | { outcome: "invalid"; message: string };

/**
 * The add-hook write through `createRepoHook` — the checkCreateHookOption
 * validation runs upstream-exact inside the service; its ApiError messages
 * re-render inline (the API's 422 body text).
 */
export async function createHookFromForm(d1: D1Database, repoId: string, form: CreateHookForm): Promise<CreateHookResult> {
  try {
    await createRepoHook(d1, repoId, {
      type: "gitea",
      name: form.name,
      config: { url: form.payloadUrl, content_type: form.contentType, secret: form.secret },
      active: form.active,
    });
    return { outcome: "created" };
  } catch (error) {
    if (error instanceof ApiError) return { outcome: "invalid", message: error.message };
    throw error;
  }
}

/** The hooks page (§2.4.1 discriminator: `repository settings webhooks`). */
export function renderHooksSettingsPage(options: {
  ctx: UiContext;
  data: HooksSettingsData;
  error: string | null;
}): string {
  return renderPage(<HooksSettingsPage ctx={options.ctx} data={options.data} error={options.error} />);
}

export function HooksSettingsPage(props: { ctx: UiContext; data: HooksSettingsData; error: string | null }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("HooksSettingsPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout ctx={ctx} title={settingsLocale.hooks} pageClass="repository settings webhooks">
      <div class="ui container flex-container">
        <SettingsNav repoLink={repoLink} active="hooks" />
        <div class="flex-container-main">
          {/* base_list.tmpl's header/segment pair, the provider dropdown
              menu replaced by the inline add form (header comment). */}
          <h4 class="ui top attached header">{settingsLocale.hooks}</h4>
          <div class="ui attached segment">
            {data.hooks.length === 0 ? (
              <div>{settingsLocale.no_webhooks}</div>
            ) : (
              <div class="flex-divided-list">
                {data.hooks.map((hook) => (
                  <div class="item flex-text-block">
                    {/* No last-status column: the neutral dot branch of
                        base_list.tmpl (tw-text-text-light) for every row. */}
                    <span class="tw-text-text-light">
                      <Icon name="octicon-dot-fill" size={22} />
                    </span>
                    <div class="gt-ellipsis tw-flex-1">
                      <span title={hook.row.url}>{hook.row.name !== "" ? hook.row.name : hook.row.url}</span>
                      <span class="tw-ml-2 tw-text-grey-light">{hook.row.url}</span>
                    </div>
                    <span class="ui tiny label">
                      {hook.deliveries === 1
                        ? `1 ${settingsLocale.deliveries_1}`
                        : `${hook.deliveries} ${settingsLocale.deliveries}`}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <h4 class="ui top attached header">{settingsLocale.add_webhook}</h4>
          <div class="ui attached segment">
            <form class="ui form" action={`${repoLink}/settings/hooks`} method="post">
              {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
              <div class="field">
                <label for="hook_name">{settingsLocale.webhook_name}</label>
                <input id="hook_name" name="name" type="text" maxlength={255} value={data.form.name} />
              </div>
              <div class="field">
                <label for="payload_url">{settingsLocale.payload_url}</label>
                <input id="payload_url" name="payload_url" type="url" required value={data.form.payloadUrl} />
              </div>
              <div class="field">
                <label for="content_type">{settingsLocale.content_type}</label>
                <select id="content_type" name="content_type" class="ui selection dropdown">
                  <option value="json" selected={data.form.contentType === "json"}>
                    JSON
                  </option>
                  <option value="form" selected={data.form.contentType === "form"}>
                    application/x-www-form-urlencoded
                  </option>
                </select>
              </div>
              <div class="field">
                <label for="secret">{settingsLocale.secret}</label>
                <input id="secret" name="secret" type="password" autocomplete="off" />
              </div>
              <div class="inline field">
                <div class="ui checkbox">
                  <input id="hook_active" name="active" type="checkbox" />
                  <label for="hook_active">{settingsLocale.active}</label>
                </div>
              </div>
              <div class="field">
                <button type="submit" class="ui primary button">
                  {settingsLocale.add_webhook}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
