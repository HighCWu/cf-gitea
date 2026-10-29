/**
 * The ADMIN HOOKS page — `/-/admin/hooks` — the census R18 (a) hooks arm
 * ("the system-level default webhook list"): the route lives in `index.ts`'s
 * admin literal family block. This module owns the admin arm over the LANDED
 * global-webhook service; the repo/org/user settings webhook pages are
 * sibling scope.
 *
 * ## Upstream surface (at the pin)
 *
 * `templates/admin/hooks.tmpl` served by `admin.DefaultOrSystemWebhooks`
 * (routers/web/admin/hooks.go:27-61), route `GET /-/admin/hooks`
 * (web.go:836-846's `/hooks` group `m.Get("")`, gated web.go:779's
 * SignInRequired + AdminRequired — the shared adminPagePrologue posture).
 * The handler renders the SHARED `repo/settings/webhook/base_list` template
 * TWICE — SystemWebhooks first, DefaultWebhooks second — over
 * `webhook.GetSystemWebhooks` / `webhook.GetDefaultWebhooks` (models/webhook/
 * hook.go:62-76 — the `repo_id = 0 AND owner_id = 0` globals split by
 * is_system_webhook; NO pagination, base_list renders every row).
 *
 * The group's writes upstream: `POST /delete`
 * (DeleteDefaultOrSystemWebhook, hooks.go:63-77 — GetWebhookByID then
 * DeleteDefaultSystemWebhook, flash + JSONRedirect), the `/{id}` edit family
 * (repo_setting.WebHooksEdit + replay + addWebhookEditRoutes) and the
 * `/{configType:default-hooks|system-hooks}` add family
 * (addWebhookAddRoutes). Of those only the DELETE is landed here; the edit
 * and add pages are UNLANDED (the webhook form family serves the
 * repo/org/user scopes — the admin-scoped add/edit routes are this arm's
 * documented next slice), so per upstream's dead-link rule the base_list
 * pencil/name links and the header's Add-Webhook dropdown are OMITTED — the
 * row renders the name/URL as plain text beside the status dot, the trash
 * rides the landed delete.
 *
 * ## Data (§3.2 — the landed global-hooks service, never a self-fetch)
 *
 * `listGlobalHooks` (api/services/hooks.ts — upstream's ToConds port: both
 * owner columns NULL, is_system_webhook filtered per the type param, id ASC)
 * called twice with the shared render bound (the HOOKS_LIST_LIMIT pattern —
 * pages/settings.tsx; upstream lists all rows, the bound is the render cap
 * and the header notes no pager upstream either). The delete rides
 * `deleteGlobalHook` (DeleteDefaultSystemWebhook minus the HookTask sweep —
 * the landed convention of leaving the delivery log).
 *
 * ## DOM contract (base_list.tmpl at the pin, ×2)
 *
 * Each segment: the `h4.ui.top.attached.header` with the title (the system
 * arm "admin.systemhooks" = "System Webhooks", the default arm
 * "admin.defaulthooks" = "Default Webhooks") + the Add-Webhook dropdown
 * (OMITTED — above); the `.ui.attached.segment` carrying the description
 * line (the locale's <a> docs link renders as the sentence + a real anchor —
 * the org module's strong-strip convention extended to the anchor) and the
 * `.flex-divided-list` rows: the status dot (last_status → tw-text-green /
 * tw-text-red / tw-text-text-light, the settings pages' three-class mapping
 * over HookStatus), the name (or the "repo.settings.webhook.name_empty"
 * fallback — "Unnamed Webhook", the settings pages' exported constant) with
 * the URL beside, and the trash form (the landed delete; upstream's
 * link-action JS reduced to the plain POST, the confirm-dialog reduction).
 *
 * ## Mount record (MOUNTED this wave — the route is live)
 *
 *   GET  /-/admin/hooks          adminPagePrologue → loadAdminHooksData →
 *                                renderAdminHooksPage at 200
 *   POST /-/admin/hooks/delete   sameOriginGuard + prologue → the form's id
 *                                → deleteGlobalHook → 303 onto /-/admin/hooks
 *                                (upstream JSONRedirect's target; the flash
 *                                texts do not render — the no-flash
 *                                reduction; an unknown id 303s silently like
 *                                every stale-form arm)
 *
 * The family navbar gains the Integrations group (Applications + Webhooks —
 * upstream navbar.tmpl's order) with the Webhooks item active here.
 */

import { deleteGlobalHook, listGlobalHooks, type WebhookRow } from "../../api/services/hooks";
import { HookStatus } from "../../db/schema";
import type { UiContext } from "../ui-context";
import { AdminFamilyShell } from "./admin-users";
import { Icon, renderPage } from "../shell";
import { settingsLocale } from "./settings";

/** cf-gitea addition — the trash button's accessible name (upstream's is an
 *  icon-only link-action, §2.4.1), citing repo.settings.webhook_deletion_desc. */
const DELETE_HOOK_ARIA = "Delete this webhook";

// ---------------------------------------------------------------------------
// Page copy (upstream locale keys cited; en-US values at the pin)
// ---------------------------------------------------------------------------

export const adminHooksLocale = {
  hooks: "Webhooks", // "admin.hooks" (hooks.go:31's Title + the nav item)
  systemhooks: "System Webhooks", // "admin.systemhooks"
  systemhooks_desc_lead:
    "Webhooks automatically make HTTP POST requests to a server when certain Gitea events trigger. Webhooks defined here will act on all repositories on the system, so please consider any performance implications this may have. Read more in the ", // "admin.systemhooks.desc" up to the anchor
  defaulthooks: "Default Webhooks", // "admin.defaulthooks"
  defaulthooks_desc_lead:
    "Webhooks automatically make HTTP POST requests to a server when certain Gitea events trigger. Webhooks defined here are defaults and will be copied into all new repositories. Read more in the ", // "admin.defaulthooks.desc" up to the anchor
  desc_link_text: "webhooks guide", // the desc anchor's text (both strings)
  desc_link_href: "https://docs.gitea.com/usage/webhooks", // the desc anchor's %s value (hooks.go:41,56)
  desc_tail: ".", // the sentences' trailing period after the anchor
} as const;

/** The render bound over the NO-pager upstream list (the HOOKS_LIST_LIMIT
 *  pattern; upstream base_list renders every row — the cap is the render
 *  bound, not a pager). */
export const ADMIN_HOOKS_LIST_LIMIT = 50;

/** The page's render inputs: the two base_list payloads in upstream render
 *  order (SystemWebhooks first, hooks.tmpl:2-3). */
export interface AdminHooksData {
  systemHooks: WebhookRow[];
  defaultHooks: WebhookRow[];
}

/**
 * The list load — hooks.go:35-58's two reads over the landed service: the
 * system globals (`type: "system"`) and the default globals
 * (`type: "default"`), each id ASC through the service's own order.
 */
export async function loadAdminHooksData(d1: D1Database): Promise<AdminHooksData> {
  const system = await listGlobalHooks(d1, { page: 1, limit: ADMIN_HOOKS_LIST_LIMIT }, "system");
  const def = await listGlobalHooks(d1, { page: 1, limit: ADMIN_HOOKS_LIST_LIMIT }, "default");
  return { systemHooks: system.items, defaultHooks: def.items };
}

/** DeleteDefaultOrSystemWebhook's write half — the form's id into
 *  deleteGlobalHook; false = the unknown-id arm (silent 303 upstream's
 *  flash-error posture reduced, the module header). */
export async function applyAdminHookDelete(d1: D1Database, id: number): Promise<boolean> {
  return deleteGlobalHook(d1, id);
}

// ---------------------------------------------------------------------------
// The render (admin/hooks.tmpl × repo/settings/webhook/base_list.tmpl)
// ---------------------------------------------------------------------------

/** One base_list segment (base_list.tmpl at the pin): the header (title +
 *  the omitted Add dropdown), the description line, the rows. */
function HookListSection(props: { title: string; descLead: string; hooks: WebhookRow[] }) {
  // base_list.tmpl's three dot classes over last_status (the settings
  // pages' mapping): Succeed green, Fail red, else the neutral gray.
  const statusClass = (row: WebhookRow): string =>
    row.lastStatus === HookStatus.Succeed
      ? "tw-text-green"
      : row.lastStatus === HookStatus.Fail
        ? "tw-text-red"
        : "tw-text-text-light";
  return (
    <>
      <h4 class="ui top attached header">
        {props.title}
        {/* base_list.tmpl:3-10's Add-Webhook dropdown — the
            `/{configType}/{type}/new` add routes are unlanded (the module
            header) → omitted, the dead-link rule. */}
      </h4>
      <div class="ui attached segment">
        <div>
          {props.descLead}
          <a href={adminHooksLocale.desc_link_href} target="_blank" rel="noopener noreferrer">
            {adminHooksLocale.desc_link_text}
          </a>
          {adminHooksLocale.desc_tail}
        </div>
        {props.hooks.length === 0 ? (
          // base_list's empty arm renders nothing upstream ({{if .Webhooks}}
          // gates only the divider); the settings pages' explicit no-webhooks
          // line is the clearer empty state — the org module's convention.
          <div>{settingsLocale.no_webhooks}</div>
        ) : (
          <div class="divider"></div>
        )}
        <div class="flex-divided-list">
          {props.hooks.map((hook) => (
            <div class="item flex-text-block" key={hook.id}>
              <span class={statusClass(hook)}>
                <Icon name="octicon-dot-fill" size={22} />
              </span>
              <div class="gt-ellipsis tw-flex-1">
                {/* base_list's name anchor targets the unlanded
                    `/{BaseLink}/{id}` edit page → plain text, the URL beside
                    (the module header's dead-link note). */}
                <span title={hook.url}>{hook.name !== "" ? hook.name : settingsLocale.webhook_name_empty}</span>
                <span class="tw-ml-2 tw-text-grey-light">{hook.url}</span>
              </div>
              {/* base_list's trash link-action as the plain-form POST (the
                  landed delete; the confirm-dialog reduction). */}
              <form method="post" action="/-/admin/hooks/delete" class="tw-inline">
                <input type="hidden" name="id" value={String(hook.id)} />
                <button type="submit" class="tw-text-red tw-pr-2 link-action negative" aria-label={DELETE_HOOK_ARIA}>
                  <Icon name="octicon-trash" />
                </button>
              </form>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

/** The full-document render (the render.tsx pattern). */
export function renderAdminHooksPage(ctx: UiContext, data: AdminHooksData): string {
  return renderPage(<AdminHooksPage ctx={ctx} data={data} />);
}

/** The admin hooks page (§2.4.1 discriminator: `admin hooks` — layout_head's
 *  pageClass, hooks.tmpl:1; upstream Title is ctx.Tr "admin.hooks"). */
export function AdminHooksPage(props: { ctx: UiContext; data: AdminHooksData }) {
  return (
    <AdminFamilyShell ctx={props.ctx} title={adminHooksLocale.hooks} pageClass="admin hooks" active="hooks">
      {/* hooks.tmpl:2-3 — SystemWebhooks FIRST, then DefaultWebhooks. */}
      <HookListSection
        title={adminHooksLocale.systemhooks}
        descLead={adminHooksLocale.systemhooks_desc_lead}
        hooks={props.data.systemHooks}
      />
      <HookListSection
        title={adminHooksLocale.defaulthooks}
        descLead={adminHooksLocale.defaulthooks_desc_lead}
        hooks={props.data.defaultHooks}
      />
    </AdminFamilyShell>
  );
}
