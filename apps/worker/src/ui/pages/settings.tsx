/**
 * The repo-settings landing + webhooks sub-page — pages wave 4 (SPEC-0008 U3
 * extension, authed write surfaces):
 *
 *   GET/POST /{owner}/{repo}/settings        the basics form (this module)
 *   GET/POST /{owner}/{repo}/settings/hooks  the webhooks list + add form
 *   GET/POST /{owner}/{repo}/settings/hooks/{id}
 *                                            the per-hook page (wave 14 —
 *                                            below; edit form + recent
 *                                            deliveries + the test-fire POST
 *                                            + delete)
 *   GET/POST /{owner}/{repo}/settings/mirror the mirror panel (wave 10 —
 *                                            below; the brief's dedicated
 *                                            sub-page for options.tmpl's
 *                                            Mirror Settings section)
 *   GET    /{owner}/{repo}/settings/branches the protected-branches panel
 *                                            (wave 15 — pages/
 *                                            branch-protection.tsx, its own
 *                                            module; this module owns only
 *                                            the shared SettingsNav item)
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
 * - The hooks list links every row onto its settings page (wave 14 —
 *   upstream base_list.tmpl's name + pencil anchors; before that page
 *   existed the rows rendered as text) and the per-hook LastStatus dot
 *   renders the maintained `webhooks.last_status` (green/red/neutral —
 *   base_list.tmpl's three classes; the wave-4 "no last-status column"
 *   note predates the consumer's stamp). Delete/test-fire live on the
 *   detail page — upstream's list trash button is a JS link-action whose
 *   confirm modal is not reproduced; dead controls are forbidden (§2.4.1).
 *   The provider dropdown menu (link_menu) is replaced by the single inline
 *   add form below the list.
 * - The add form fixes the hook type to `gitea` (the generic JSON webhook):
 *   the other nine HOOK_TYPES need provider-specific config fields (Slack
 *   channel &c.) the form does not render. Events stay the service default
 *   (push-only); the event radio/checkbox matrix is not rendered. Name,
 *   target URL, POST content type, secret and the active flag are the form's
 *   fields — the same field names the upstream gitea.tmpl posts.
 *
 * ## The mirror panel (wave 10 — options.tmpl's Mirror Settings section)
 *
 * The brief's dedicated `/settings/mirror` sub-page (upstream at this pin
 * renders the section inside options.tmpl with no navbar item — the navbar
 * item and the `repository settings mirror` discriminator are the documented
 * divergence). Data is the landed `getMirrorStatus` (the exact arm GET
 * /api/v1/repos/{owner}/{repo}/mirror serves — never a self-fetch); the
 * Synchronize Now POST is upstream handleSettingsPostMirrorSync
 * (setting.go:379-390) over the API's mirror-sync arm's queue enqueue
 * (routes/mirror.ts:282-300 — inlined there is no service function; the
 * same-origin guard rides the write families' posture). The API exposes NO
 * settings-write arm (no PUT /repos/{owner}/{repo}/mirror landed — the
 * registerMirror row comment "PATCH owns it" is aspirational), so the edit
 * form (prune/interval/address/auth/LFS) renders as the honest absence note
 * and the current interval/prune values as read-only lines; dead controls
 * are forbidden (§2.4.1). `?sync=queued` renders the upstream
 * pull_mirror_sync_in_progress flash text as an info message (the flash
 * reduction — no session-flash plumbing exists; the param is display-only).
 *
 * ## The per-hook page (wave 14 — upstream repo/settings/webhook/{new,
 *  settings,history}.tmpl over WebHooksEdit/TestWebhook/DeleteWebhook)
 *
 *   GET  /{owner}/{repo}/settings/hooks/{id}          the edit form + the
 *                                                     recent-deliveries list
 *   POST /{owner}/{repo}/settings/hooks/{id}          the edit write
 *   POST /{owner}/{repo}/settings/hooks/{id}/test     the test-fire write
 *   POST /{owner}/{repo}/settings/hooks/{id}/delete   the delete write
 *
 * The GET renders upstream's edit page: gitea.tmpl's payload_url +
 * content_type pair and settings.tmpl's name/active fields, plus the branch
 * filter (a landed PATCH-arm field the add form never rendered). The page
 * discriminator is `repository settings new webhook` — upstream renders the
 * EDIT page through new.tmpl (WebHooksEdit → orCtx.NewTemplate), so that is
 * the literal class at this pin. The edit write re-plays the landed hooks
 * PATCH arm (routes/hooks.ts repoEditHook over services/hooks.ts
 * editRepoHook): validation 422s re-render inline, success 303s back onto
 * the page (upstream editWebhook's redirect). Documented divergences:
 *   - The edit POST rides the page URL; upstream type-prefixes it
 *     (`/settings/hooks/gitea/{id}`, GiteaHooksEditPost) — the landed add
 *     form fixes the type to `gitea`, so the page's own URL carries the
 *     write (the wave-4 posture).
 *   - The secret field is not rendered: the landed PATCH arm has NO secret
 *     write (editRepoHook applies url/content_type only from config), so an
 *     input bound to it would be a dead control (§2.4.1).
 *   - The authorization-header field is not rendered: the stored header is
 *     write-only (toApiHook renders ""), so a form bound to it would CLEAR
 *     the stored value on every submit; the PATCH arm keeps it when the
 *     field is absent.
 *   - The event radio/checkbox matrix stays the wave-4 degradation; because
 *     the PATCH arm rewrites subscriptions UNCONDITIONALLY (an absent field
 *     resets to push-only), the form carries the hook's current events as
 *     hidden inputs so an edit preserves them, and "Trigger On:" renders
 *     the subscription as read-only text.
 * The recent-deliveries list is the landed hook-delivery read arm
 * (listHookDeliveries, newest first) with upstream history.tmpl's status
 * marks: succeeded rows green (octicon-check), undelivered rows orange
 * (pending/delivering/skipped — octicon-clock stands in for upstream's
 * octicon-stopwatch, which is not in the landed icon allowlist —
 * scripts/gen-ui-icons.mjs is outside this wave's ownership), delivered
 * failures red (the dot fill stands in for octicon-alert, same allowlist
 * note). The rows are the collapsed history items: uuid, event type, time
 * — the request/response payload tabs and the per-delivery replay are not
 * rendered (no JS plumbing; the payload bodies would need the tab
 * switcher). The test-fire POST re-plays the landed repoTestHook arm over
 * the same services the API route calls (buildTestPushPayload +
 * fireTestDelivery): an empty repository fires nothing (the arm's
 * early-204), success enqueues through the same structural WEBHOOK_DELIVERY
 * producer probe as routes/hooks.ts (absent binding ⇒ the row stays
 * `pending` with the log complete) and 303s back with `?test=queued` — the
 * flash reduction rendering upstream's repo.settings.webhook.delivery.success
 * text as an info message. Delete answers upstream DeleteWebhook's
 * list redirect: the arm-scoped tail carries the id (upstream's shared
 * `/settings/hooks/delete?id=` form target exists for the list's trash
 * buttons, which this UI does not render), a miss 404-shells (the landed
 * DELETE arm's 404, the settings pages' existence-hiding posture).
 */

import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { ApiError } from "../../api/errors";
import {
  buildTestPushPayload,
  createRepoHook,
  editRepoHook,
  getRepoHook,
  hookEventsArray,
  listHookDeliveries,
  listRepoHooks,
  fireTestDelivery,
  type WebhookRow,
} from "../../api/services/hooks";
import { apiUserFromRow, toApiRepository, type RepositoryWithOwner, type UserRow } from "../../api/services/repository";
import { collaboratorModeOf } from "../../api/services/repo-collaborators";
import { getMirrorStatus, type MirrorStatus } from "../../api/services/mirror";
import { loadRepoSettings, saveRepoSettings } from "../../api/services/repo-settings";
import { RepoNameCollisionError, RepoNameInvalidError, RepoService } from "../../repos/service";
import { timeSinceParts } from "../page-data";
import { TimeSince } from "../components/file-list";
import { HookStatus, webhookDeliveries } from "../../db/schema";
import type { IconName } from "../icons";
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
  branches: "Branches", // "repo.settings.branches" (wave 15 — the protected-branches panel's navbar item)
  webhook_name: "Webhook name", // "repo.settings.webhook.name"
  payload_url: "Target URL", // "repo.settings.payload_url"
  content_type: "POST Content Type", // "repo.settings.content_type"
  secret: "Secret", // "repo.settings.secret"
  active: "Active", // "repo.settings.active"
  no_webhooks: "No webhooks yet.", // cf-gitea addition (upstream renders an empty segment)
  webhook_name_empty: "Unnamed Webhook", // "repo.settings.webhook.name_empty" (wave 14: the rows link, so the fallback text renders)
  edit_hook_aria: "Edit this webhook", // cf-gitea addition — the pencil link's accessible name (upstream's is icon-only)
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
 *  — the header comment's dead-link rule; wave 10 adds the Mirror item —
 *  the brief's `/settings/mirror` sub-page; upstream renders mirror settings
 *  as a SECTION of options.tmpl, no navbar item, so the item text is the
 *  options section's own "Mirror Settings" header and the placement (last)
 *  keeps the upstream relative order intact). Wave 15 adds the Branches
 *  item between Webhooks and Mirror — upstream's own order
 *  (navbar.tmpl:16-23 puts branches after hooks; mirror stays adjacent to
 *  its options-section origin at the tail). Exported for pages/
 *  branch-protection.tsx, which renders it with `branches` active. */
export function SettingsNav(props: { repoLink: string; active: "options" | "hooks" | "branches" | "mirror" }) {
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
        <a class={props.active === "branches" ? "active item" : "item"} href={`${props.repoLink}/settings/branches`}>
          {settingsLocale.branches}
        </a>
        <a class={props.active === "mirror" ? "active item" : "item"} href={`${props.repoLink}/settings/mirror`}>
          {mirrorLocale.mirror_settings}
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
                {data.hooks.map((hook) => {
                  // base_list.tmpl's three dot classes over the maintained
                  // last_status (webhooks/consumer.ts stamps it per delivery
                  // outcome): Succeed green, Fail red, else the neutral gray.
                  const statusClass =
                    hook.row.lastStatus === HookStatus.Succeed
                      ? "tw-text-green"
                      : hook.row.lastStatus === HookStatus.Fail
                        ? "tw-text-red"
                        : "tw-text-text-light";
                  const hookLink = `${repoLink}/settings/hooks/${hook.row.id}`;
                  return (
                    <div class="item flex-text-block">
                      <span class={statusClass}>
                        <Icon name="octicon-dot-fill" size={22} />
                      </span>
                      <div class="gt-ellipsis tw-flex-1">
                        <a title={hook.row.url} href={hookLink}>
                          {hook.row.name !== "" ? hook.row.name : settingsLocale.webhook_name_empty}
                        </a>
                        <span class="tw-ml-2 tw-text-grey-light">{hook.row.url}</span>
                      </div>
                      <span class="ui tiny label">
                        {hook.deliveries === 1
                          ? `1 ${settingsLocale.deliveries_1}`
                          : `${hook.deliveries} ${settingsLocale.deliveries}`}
                      </span>
                      {/* base_list.tmpl's pencil anchor (aria-label additive —
                          upstream's is icon-only, §2.4.1). */}
                      <a class="muted" href={hookLink} aria-label={settingsLocale.edit_hook_aria}>
                        <Icon name="octicon-pencil" />
                      </a>
                    </div>
                  );
                })}
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

// ---------------------------------------------------------------------------
// The mirror sub-page (GET/POST /settings/mirror — pages wave 10)
// ---------------------------------------------------------------------------

/** Page chrome text (options.tmpl's Mirror Settings section at the pin;
 *  cf-gitea additions marked). */
export const mirrorLocale = {
  mirror_settings: "Mirror Settings", // "repo.settings.mirror_settings"
  mirrored_repository: "Mirrored repository", // "repo.settings.mirror_settings.mirrored_repository"
  direction: "Direction", // "repo.settings.mirror_settings.direction"
  direction_pull: "Pull", // "repo.settings.mirror_settings.direction.pull"
  last_update: "Last update", // "repo.settings.mirror_settings.last_update"
  sync_mirror: "Synchronize Now", // "repo.settings.sync_mirror"
  sync_in_progress: "Pulling changes from the remote %s at the moment.", // "repo.settings.pull_mirror_sync_in_progress"
  mirror_interval: "Interval", // "repo.mirror_interval" (the label, %s-minimum tail dropped — no editable field)
  mirror_prune: "Prune", // "repo.mirror_prune"
  mirror_prune_desc: "Remove obsolete remote-tracking references", // "repo.mirror_prune_desc"
  last_synced: "Last Synchronized", // "repo.mirror_last_synced"
  not_a_mirror: "This repository is not a pull mirror.", // cf-gitea addition
  not_a_mirror_attach: "Attach one through the API: POST /api/v1/repos/{owner}/{repo}/migrate with mirror=true on an empty repository.", // cf-gitea addition
  archived_mirrors_unavailable: "Mirrors are not available if the repo is archived.", // "repo.settings.archive.mirrors_unavailable"
  editing_unavailable:
    "Editing the interval, prune or source address is not supported yet: the mirror API exposes no settings-write arm (no PUT /repos/{owner}/{repo}/mirror landed).", // cf-gitea addition (the honest absence)
  sync_state: "Sync state", // cf-gitea addition
  next_sync: "Next sync", // cf-gitea addition
  not_scheduled: "Not scheduled", // cf-gitea addition
  never_synced: "Never", // cf-gitea addition
  last_error: "Last error", // cf-gitea addition
  queue_missing: "The mirror sync queue is not configured on this deployment.", // cf-gitea addition
} as const;

/** The mirror page's render inputs: the sync_state row (or null = not a
 *  mirror) and whether the POST queued a sync (the `?sync=queued` flash
 *  reduction — no session-flash plumbing exists). */
export interface MirrorSettingsData {
  status: MirrorStatus | null;
  syncQueued: boolean;
}

/** Load the mirror panel (§3.2 — the landed getMirrorStatus read; the same
 *  arm GET /api/v1/repos/{owner}/{repo}/mirror serves). */
export async function loadMirrorSettings(d1: D1Database, repoId: string, syncQueued = false): Promise<MirrorSettingsData> {
  return { status: await getMirrorStatus(d1, repoId), syncQueued };
}

export type MirrorSyncResult =
  | { outcome: "queued" }
  | { outcome: "not-mirror" | "archived" } // upstream NotFound arms (setting.go:381)
  | { outcome: "no-queue" | "enqueue-failed" }; // the 500 family

/** Structural shape of the MIRROR_SYNC_QUEUE producer side (the generated
 *  Env's Queue binding narrowed to the send half; the one message the sync
 *  channel carries is sync.ts's `{kind: "mirror-sync", repoId}` literal). */
export interface MirrorSyncQueue {
  send(message: unknown): Promise<unknown>;
}

/**
 * The Synchronize Now write (upstream handleSettingsPostMirrorSync —
 * AddPullMirrorToQueue — over the landed channel): the exact guard order of
 * the API's POST /repos/{owner}/{repo}/mirror-sync arm (routes/mirror.ts:282-300
 * — push permission already held, the settings gate is strictly stronger),
 * then the queue message `{kind: "mirror-sync", repoId}` on MIRROR_SYNC_QUEUE
 * inlined from that arm (the consumer CAS re-guards every state). There is NO
 * landed service function for the enqueue — the API route inlines it the
 * same way.
 */
export async function syncMirrorNow(
  d1: D1Database,
  queue: MirrorSyncQueue | undefined,
  repo: RepoRow,
): Promise<MirrorSyncResult> {
  if (repo.isArchived) return { outcome: "archived" };
  if (!(await getMirrorStatus(d1, repo.id))) return { outcome: "not-mirror" };
  if (!queue) return { outcome: "no-queue" };
  try {
    await queue.send({ kind: "mirror-sync", repoId: repo.id });
  } catch {
    return { outcome: "enqueue-failed" };
  }
  return { outcome: "queued" };
}

/** The mirror panel (§2.4.1 discriminator: `repository settings mirror` —
 *  upstream renders the section on options.tmpl; the brief's dedicated
 *  sub-page keeps the settings layout pair). The sync_state row renders the
 *  upstream table (remote address | Pull | last update | Synchronize Now)
 *  plus the status lines the API's MirrorStatus carries; the edit form
 *  (prune/interval/address — options.tmpl's second row) renders as the
 *  honest absence note: no settings-write arm exists. */
export function renderMirrorSettingsPage(options: {
  ctx: UiContext;
  data: MirrorSettingsData;
  error: string | null;
}): string {
  return renderPage(<MirrorSettingsPage ctx={options.ctx} data={options.data} error={options.error} />);
}

/** Absolute stamp for the table's Last update cell (DateUtils.FullTime's
 *  shape at the TimeSince text format — the fixed-zone absolute the other
 *  pages render). */
function fullTime(iso: string): string {
  return timeSinceParts(Math.floor(Date.parse(iso) / 1000), "+0000").text;
}

function MirrorSettingsPage(props: { ctx: UiContext; data: MirrorSettingsData; error: string | null }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("MirrorSettingsPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const status = data.status;
  return (
    <BaseLayout ctx={ctx} title={mirrorLocale.mirror_settings} pageClass="repository settings mirror">
      <div class="ui container flex-container">
        <SettingsNav repoLink={repoLink} active="mirror" />
        <div class="flex-container-main">
          <h4 class="ui top attached header">{mirrorLocale.mirror_settings}</h4>
          <div class="ui attached segment">
            {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
            {data.syncQueued && status !== null ? (
              <div class="ui info message">
                {mirrorLocale.sync_in_progress.replace("%s", status.original_url)}
              </div>
            ) : null}
            {repo.isArchived ? <div class="ui warning message tw-text-center">{mirrorLocale.archived_mirrors_unavailable}</div> : null}
            {status === null ? (
              <div>
                <p>{mirrorLocale.not_a_mirror}</p>
                <p class="tw-text-placeholder-text">{mirrorLocale.not_a_mirror_attach}</p>
              </div>
            ) : (
              <>
                {/* options.tmpl's pull-mirror table row (the working-mirror
                    tbody): address | direction | last update | sync form. */}
                <table class="ui table">
                  <thead>
                    <tr>
                      <th class="tw-w-2/5" scope="col">{mirrorLocale.mirrored_repository}</th>
                      <th scope="col">{mirrorLocale.direction}</th>
                      <th scope="col">{mirrorLocale.last_update}</th>
                      <th scope="col"></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{status.remote_address}</td>
                      <td>{mirrorLocale.direction_pull}</td>
                      <td>{fullTime(status.updated_at)}</td>
                      <td class="tw-text-right">
                        <form method="post" class="tw-inline-block" action={`${repoLink}/settings/mirror`}>
                          <button type="submit" class="ui primary tiny button inline">
                            {mirrorLocale.sync_mirror}
                          </button>
                        </form>
                      </td>
                    </tr>
                  </tbody>
                </table>
                {/* The sync status lines (the API MirrorStatus's operational
                    half — sanitized: no credentials ever reach this row). */}
                <div class="ui meta info message">
                  <div class="tw-flex-1">
                    {mirrorLocale.sync_state}: {status.sync_state}
                  </div>
                  <div class="tw-flex-1">
                    {mirrorLocale.next_sync}:{" "}
                    {status.next_sync_at === 0 ? (
                      mirrorLocale.not_scheduled
                    ) : (
                      <TimeSince unixSeconds={status.next_sync_at} tz="+0000" />
                    )}
                  </div>
                  <div class="tw-flex-1">
                    {mirrorLocale.last_synced}:{" "}
                    {status.last_sync_at === null ? (
                      mirrorLocale.never_synced
                    ) : (
                      <TimeSince unixSeconds={status.last_sync_at} tz="+0000" />
                    )}
                  </div>
                  <div class="tw-flex-1">
                    {mirrorLocale.mirror_interval}: {status.mirror_interval}
                  </div>
                  <div class="tw-flex-1">
                    {mirrorLocale.mirror_prune} ({mirrorLocale.mirror_prune_desc}): {status.enable_prune ? "✓" : "✗"}
                  </div>
                  {status.last_error !== null ? (
                    <div class="tw-flex-1 tw-text-red">
                      {mirrorLocale.last_error}: {status.last_error}
                    </div>
                  ) : null}
                </div>
                {/* The honest absence: options.tmpl's edit form (prune
                    checkbox, interval, address, auth) has no landed write arm
                    — rendered read-only, never dead controls (§2.4.1). */}
                <p class="tw-text-placeholder-text">{mirrorLocale.editing_unavailable}</p>
              </>
            )}
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

// ---------------------------------------------------------------------------
// The per-hook page (GET/POST /settings/hooks/{id} + the test/delete POSTs —
// pages wave 14; upstream WebHooksEdit / GiteaHooksEditPost / TestWebhook /
// DeleteWebhook)
// ---------------------------------------------------------------------------

/** Page chrome text (the settingsLocale pattern; upstream locale keys cited). */
export const hookDetailLocale = {
  update_webhook: "Update Webhook", // "repo.settings.update_webhook"
  branch_filter: "Branch filter", // "repo.settings.branch_filter"
  event_desc: "Trigger On:", // "repo.settings.event_desc"
  recent_deliveries: "Recent Deliveries", // "repo.settings.recent_deliveries"
  test_delivery: "Test Push Event", // "repo.settings.webhook.test_delivery"
  test_delivery_desc: "Test this webhook with a fake push event.", // "repo.settings.webhook.test_delivery_desc"
  test_queued:
    "An event has been added to the delivery queue. It may take few seconds before it shows up in the delivery history.", // "repo.settings.webhook.delivery.success" (the ?test=queued flash reduction's text)
  delete_webhook: "Remove Webhook", // "repo.settings.delete_webhook"
  no_deliveries: "No deliveries yet.", // cf-gitea addition (upstream renders an empty segment)
} as const;

/** One-page cap for the recent-deliveries list (listHookDeliveries is
 *  paginated, newest first; the cap mirrors HOOKS_LIST_LIMIT — upstream
 *  pages the history at 10 with a pager this page does not render). */
export const HOOK_DELIVERIES_LIMIT = 20;

/** One rendered delivery row: the consumer's row as stored. */
export type HookDeliveryRow = typeof webhookDeliveries.$inferSelect;

/** The stored branch filter — inside the HookEvent JSON (services/hooks.ts's
 *  private branchFilterOf, re-parsed here; malformed blob ⇒ ""). */
export function hookBranchFilterOf(row: WebhookRow): string {
  try {
    return (JSON.parse(row.events) as { branch_filter?: string }).branch_filter ?? "";
  } catch {
    return "";
  }
}

/** The per-hook page's render inputs: the hook row, its subscription names,
 *  branch filter, the edit-form binding and the newest deliveries. */
export interface HookDetailData {
  hook: WebhookRow;
  events: string[];
  branchFilter: string;
  deliveries: HookDeliveryRow[];
  /** The pagination-independent delivery total (the read arm's count). */
  deliveryTotal: number;
  /** The edit form's binding (the stored values; overwritten with the kept
   *  submission on a validation re-render). */
  form: HookEditForm;
}

/** Load the per-hook page (the landed repoGetHook + repoListHookDeliveries
 *  arms). `null` = the 404 shell: an unknown or foreign-repo hook id. */
export async function loadHookDetailData(d1: D1Database, repoId: string, hookId: number): Promise<HookDetailData | null> {
  const hook = await getRepoHook(d1, repoId, hookId);
  if (hook === null) return null;
  const { items, total } = await listHookDeliveries(d1, hook.id, { page: 1, limit: HOOK_DELIVERIES_LIMIT });
  const events = hookEventsArray(hook.events);
  return {
    hook,
    events,
    branchFilter: hookBranchFilterOf(hook),
    deliveries: items,
    deliveryTotal: total,
    form: hookEditFormOf(hook, events),
  };
}

/** The edit form's fields — the landed PATCH arm's form-mapped subset
 *  (name, config.url, config.content_type, branch_filter, events, active;
 *  the secret and authorization header are the module header's not-rendered
 *  notes). Field names are upstream gitea.tmpl's. */
export interface HookEditForm {
  name: string;
  payloadUrl: string;
  contentType: string;
  branchFilter: string;
  events: string[];
  active: boolean;
}

/** The stored row as the form binding (hookContentTypeName for the stored
 *  id; the subscription names drive the hidden preserve inputs). */
export function hookEditFormOf(hook: WebhookRow, events: string[]): HookEditForm {
  return {
    name: hook.name,
    payloadUrl: hook.url,
    contentType: hook.contentType === 2 ? "form" : "json",
    branchFilter: hookBranchFilterOf(hook),
    events,
    active: hook.isActive,
  };
}

/** Parse the urlencoded edit POST. The `events` hidden preserve inputs ride
 *  the same field name upstream's JS form submits (the PATCH arm rewrites
 *  subscriptions unconditionally — the module header). */
export function parseHookEditForm(params: URLSearchParams): HookEditForm {
  const contentType = params.get("content_type") ?? "json";
  return {
    name: (params.get("name") ?? "").trim(),
    payloadUrl: (params.get("payload_url") ?? "").trim(),
    contentType: contentType === "form" ? "form" : "json",
    branchFilter: params.get("branch_filter") ?? "",
    events: params.getAll("events"),
    active: (params.get("active") ?? "") !== "",
  };
}

export type HookEditResult = { outcome: "saved" } | { outcome: "invalid"; message: string };

/**
 * The edit write — exactly the PATCH arm's service call (`editRepoHook`):
 * url/content_type validate with the API's 422 messages (re-rendered
 * inline), the events rewrite + branch filter apply unconditionally (the
 * form always sends them), name/active apply from the form.
 */
export async function editHookFromForm(d1: D1Database, hook: WebhookRow, form: HookEditForm): Promise<HookEditResult> {
  try {
    await editRepoHook(d1, hook, {
      name: form.name,
      active: form.active,
      branch_filter: form.branchFilter,
      events: form.events,
      config: { url: form.payloadUrl, content_type: form.contentType },
    });
    return { outcome: "saved" };
  } catch (error) {
    if (error instanceof ApiError) return { outcome: "invalid", message: error.message };
    throw error;
  }
}

// --- the test-fire (the landed repoTestHook arm's steps) -----------------------

/** Structural shape of the WEBHOOK_DELIVERY Queue producer, as probed by the
 *  API's test arm (routes/hooks.ts webhookDeliveryQueue — the binding is
 *  absent from the generated Env today; the probe is structural so the
 *  enqueue starts the moment the binding lands). */
export interface HookDeliveryQueue {
  sendBatch(messages: { body: { deliveryId: number } }[]): Promise<unknown>;
}

export function hookDeliveryQueueOf(env: unknown): HookDeliveryQueue | null {
  const candidate: unknown = (env as { WEBHOOK_DELIVERY?: unknown }).WEBHOOK_DELIVERY;
  if (candidate === undefined || candidate === null) return null;
  const queue = candidate as { sendBatch?: (messages: { body: { deliveryId: number } }[]) => Promise<unknown> };
  return typeof queue.sendBatch === "function" ? { sendBatch: queue.sendBatch.bind(queue) } : null;
}

export type HookTestResult = { outcome: "fired"; deliveryId: number };

/**
 * The test-fire write (routes/hooks.ts's repoTestHook handler body over the
 * same landed services — the empty-repo no-fire arm is the caller's): the
 * representative push payload at `refs/heads/<default branch>` (the arm's
 * default — the UI form carries no ref field), the delivery row insert
 * INLINE (the request-visible effect), and the optional Queue enqueue hung
 * off the caller's `waitUntil` (sub-second, never fails the response; a
 * missing producer leaves the row `pending` — SPEC-0005 §3.6).
 */
export async function fireHookTestDelivery(args: {
  d1: D1Database;
  hook: WebhookRow;
  pair: RepositoryWithOwner;
  /** The signed-in doer's user row (the payload's pusher/sender). */
  user: UserRow;
  origin: string;
  queue: HookDeliveryQueue | null;
  waitUntil?: (promise: Promise<unknown>) => void;
}): Promise<HookTestResult> {
  const ref = `refs/heads/${args.pair.repo.defaultBranch}`;
  // The payload's pusher/sender/repository are the route's converted API
  // objects (routes/hooks.ts passes c.get("authUser") — the same
  // apiUserFromRow conversion the file-editor's webhook emissions build).
  const apiUser = apiUserFromRow(args.user, { origin: args.origin, requester: null });
  const payload = buildTestPushPayload(args.pair, ref, {
    repository: toApiRepository({ origin: args.origin, requester: apiUser }, args.pair),
    pusher: apiUser,
    sender: apiUser,
  });
  const deliveryId = await fireTestDelivery(args.d1, args.hook, "push", payload, { repoId: args.pair.repo.id });
  if (args.queue !== null && args.waitUntil !== undefined) {
    args.waitUntil(
      args.queue.sendBatch([{ body: { deliveryId } }]).then(undefined, (error: unknown) => {
        console.error(`[hooks] delivery enqueue failed for ${deliveryId}: ${error instanceof Error ? error.message : String(error)}`);
      }),
    );
  }
  return { outcome: "fired", deliveryId };
}

// --- components -----------------------------------------------------------------

/** history.tmpl's status mark for one delivery: succeeded green (check),
 *  undelivered orange (pending/delivering/skipped — the clock stands in for
 *  the un-allowlisted octicon-stopwatch), delivered failure red (the dot
 *  fill stands in for octicon-alert — the module header's allowlist note). */
function deliveryStatus(row: HookDeliveryRow): { cls: string; icon: IconName } {
  if (row.isSucceed) return { cls: "tw-text-green", icon: "octicon-check" };
  if (row.state !== "delivered") return { cls: "tw-text-orange", icon: "octicon-clock" };
  return { cls: "tw-text-red", icon: "octicon-dot-fill" };
}

/** The delivery row's time: delivered when stamped, created otherwise (a
 *  pending row's queue age — upstream's blank Delivered cell reduced to the
 *  created stamp; cf-gitea addition). */
function DeliveryTime(props: { row: HookDeliveryRow }) {
  const at = props.row.deliveredAt ?? props.row.createdAt;
  if (at === null) return null;
  return <TimeSince unixSeconds={Math.floor(at.getTime() / 1000)} tz="+0000" />;
}

function DeliveryItem(props: { row: HookDeliveryRow }) {
  const { row } = props;
  const status = deliveryStatus(row);
  return (
    <div class="item">
      <div class="flex-left-right">
        <div class="flex-text-inline">
          <span class={status.cls}>
            <Icon name={status.icon} />
          </span>
          <span class="tw-font-mono">{row.uuid}</span>
        </div>
        <div class="flex-text-block">
          <span class="ui tiny label">{row.eventType}</span>
          <span class="tw-text-text-light">
            <DeliveryTime row={row} />
          </span>
        </div>
      </div>
    </div>
  );
}

/** The full-document render (the render.tsx pattern). */
export function renderHookDetailPage(options: {
  ctx: UiContext;
  data: HookDetailData;
  error: string | null;
  /** The `?test=queued` flash reduction (the module header). */
  testQueued: boolean;
}): string {
  return renderPage(
    <HookDetailPage ctx={options.ctx} data={options.data} error={options.error} testQueued={options.testQueued} />,
  );
}

/**
 * The per-hook page (§2.4.1 discriminator: `repository settings new webhook`
 * — upstream renders the EDIT page through new.tmpl, so that is the literal
 * class; the module header). The edit form + the recent-deliveries segment
 * with the Test Push Event button (history.tmpl's header shape).
 */
export function HookDetailPage(props: { ctx: UiContext; data: HookDetailData; error: string | null; testQueued: boolean }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("HookDetailPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const hookLink = `${repoLink}/settings/hooks/${data.hook.id}`;
  const form = data.form;
  return (
    <BaseLayout ctx={ctx} title={hookDetailLocale.update_webhook} pageClass="repository settings new webhook">
      <div class="ui container flex-container">
        <SettingsNav repoLink={repoLink} active="hooks" />
        <div class="flex-container-main">
          {/* gitea.tmpl's form + settings.tmpl's fields (the module
              header's not-rendered notes for secret/auth-header/events). */}
          <h4 class="ui top attached header">{hookDetailLocale.update_webhook}</h4>
          <div class="ui attached segment">
            <form class="ui form" action={hookLink} method="post">
              {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
              {form.events.map((event) => (
                <input type="hidden" name="events" value={event} />
              ))}
              <div class="required field">
                <label for="payload_url">{settingsLocale.payload_url}</label>
                <input id="payload_url" name="payload_url" type="url" required value={form.payloadUrl} />
              </div>
              <div class="field">
                <label for="content_type">{settingsLocale.content_type}</label>
                <select id="content_type" name="content_type" class="ui selection dropdown">
                  <option value="json" selected={form.contentType === "json"}>
                    JSON
                  </option>
                  <option value="form" selected={form.contentType === "form"}>
                    application/x-www-form-urlencoded
                  </option>
                </select>
              </div>
              <div class="field">
                <label for="hook_name">{settingsLocale.webhook_name}</label>
                <input id="hook_name" name="name" type="text" maxlength={255} value={form.name} />
              </div>
              <div class="field">
                <label for="branch_filter">{hookDetailLocale.branch_filter}</label>
                <input id="branch_filter" name="branch_filter" type="text" value={form.branchFilter} />
              </div>
              <div class="inline field">
                <div class="ui checkbox">
                  <input id="hook_active" name="active" type="checkbox" checked={form.active} />
                  <label for="hook_active">{settingsLocale.active}</label>
                </div>
              </div>
              <div class="field">
                <button type="submit" class="ui primary button">
                  {hookDetailLocale.update_webhook}
                </button>
              </div>
            </form>
            {/* The read-only subscription line (settings.tmpl's matrix
                reduced — the hidden inputs above preserve it through the
                PATCH arm's unconditional rewrite). */}
            <p class="tw-text-placeholder-text">
              {hookDetailLocale.event_desc} {form.events.length > 0 ? form.events.join(", ") : "push"}
            </p>
            <form method="post" action={`${hookLink}/delete`}>
              <button type="submit" class="ui red button">
                {hookDetailLocale.delete_webhook}
              </button>
            </form>
          </div>
          {/* history.tmpl's header shape: the list title + the test-fire
              button (upstream's JS data-link POST reduced to a form). */}
          <h4 class="ui top attached header flex-left-right">
            <span>{hookDetailLocale.recent_deliveries}</span>
            <form method="post" action={`${hookLink}/test`}>
              <button
                type="submit"
                class="ui tiny button"
                title={hookDetailLocale.test_delivery_desc}
                aria-label={hookDetailLocale.test_delivery_desc}
              >
                {hookDetailLocale.test_delivery}
              </button>
            </form>
          </h4>
          <div class="ui attached segment">
            {props.testQueued ? <div class="ui info message">{hookDetailLocale.test_queued}</div> : null}
            {data.deliveries.length === 0 ? (
              <div>{hookDetailLocale.no_deliveries}</div>
            ) : (
              <div class="flex-divided-list">
                {data.deliveries.map((row) => (
                  <DeliveryItem row={row} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
