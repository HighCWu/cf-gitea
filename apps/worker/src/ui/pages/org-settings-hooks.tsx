/**
 * The org settings HOOKS tab — pages wave 53 (the org-settings module's named
 * next slice): upstream web.go:1033-1044's `/hooks` group inside the
 * require-owner `/{org}/settings` subtree over `gitea/templates/org/settings/
 * hooks.tmpl` (the list, `organization settings webhooks`) and
 * `org/settings/hook_new.tmpl` (the per-hook edit, `organization settings new
 * webhook` — the shared repo_setting.WebHooksEdit handler renders BOTH the
 * repo and org arms through their scope's new template,
 * routers/web/repo/setting/webhook.go:662-676 + getOwnerRepoCtx's
 * PageIsOrgSettings branch :82-92). THE owner/admin family like every org
 * settings page: the shared org-teams prologue answers exactly the landed
 * org-settings posture — anonymous 303s onto the login round-trip, a
 * signed-in non-owner 404-shells (upstream's RequireOwner OrgAssignment
 * NotFound, web.go:1032), a renamed org 307s.
 *
 * ## Data (§3.2 — the landed org-hooks API family, never a self-fetch)
 *
 * The hooks-scopes wave's org CRUD (`GET/POST /orgs/{org}/hooks`,
 * `GET/PATCH/DELETE /orgs/{org}/hooks/{id}` — routes/hooks-scopes.ts) rides
 * the owner-scoped service arms this page calls directly:
 *
 *   list      `listOwnerHooks` (services/hooks.ts — upstream
 *             ListWebhookOptions{OwnerID}, org/setting.go:159) + one batched
 *             delivery-count read (the repo page's wave-2 batching pattern);
 *   create    `createOwnerHook` (AddOwnerHook, utils/hook.go — the exact
 *             checkCreateHookOption validation, its 422 messages surfaced
 *             inline);
 *   read      `getOwnerHook` (GetWebhookByOwnerID — an unknown or foreign-org
 *             id 404-shells, the landed DELETE arm's 404);
 *   edit      `editHookFromForm` over `editRepoHook` — the service is
 *             scope-agnostic by construction (the module header: upstream's
 *             single shared editHook body serves the repo/owner/system
 *             callers alike; the org PATCH arm calls the very same function,
 *             routes/hooks-scopes.ts:521);
 *   delete    `deleteOwnerHook` (DeleteWebhookByOwnerID, org/setting.go:179);
 *   history   `listHookDeliveries` (the shared delivery read — the rows key
 *             on the hook id, scope-free).
 *
 * ## DOM contract
 *
 * The list page is org/settings/hooks.tmpl: layout_head's `.page-content
 * .organization settings webhooks` → org/header.tmpl (the shared OrgHeader) →
 * the flex-container pair carrying org/settings/navbar.tmpl (the shared
 * OrgSettingsNavbar, hooks active) and base_list.tmpl's header/segment pair — the status dot
 * (webhooks.last_status, the repo page's three-class mapping), the name/URL
 * row linking onto the per-hook page, the delivery-count chip and the pencil
 * anchor. Upstream's segment header renders `{{.Title}}`, and the org arm
 * sets it to `ctx.Tr("org.settings")` — "Settings" (org/setting.go:151), not
 * the repo arm's "Webhooks": the quirk is kept verbatim. `.Description`
 * renders org.settings.hooks_desc above the list (strong stripped).
 *
 * The per-hook page is org/settings/hook_new.tmpl's EDIT arm
 * (`organization settings new webhook`, CustomHeaderTitle =
 * repo.settings.update_webhook): webhook/new.tmpl → gitea.tmpl's form
 * (payload_url, content_type, name, branch_filter, active — the landed
 * repo-page field set with upstream's field names), the read-only
 * subscription line (settings.tmpl's matrix reduced, the hidden `events`
 * preserve inputs riding the PATCH arm's unconditional rewrite), the red
 * Remove Webhook form, then history.tmpl's Recent Deliveries segment.
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - The add form fixes the hook type to `gitea` (the generic JSON webhook)
 *   and rides POST /settings/hooks INLINE: upstream's provider-picker page
 *   (`GET /{type}/new` + the per-provider `POST /{type}/new` writes,
 *   web.go:460-473's addWebhookAddRoutes) has exactly one landed provider —
 *   the repo page's documented add-form reduction.
 * - The delete rides the arm-scoped `POST .../hooks/{id}/delete` form
 *   (the landed repo page's wave-14 convention): upstream org arm deletes
 *   through the shared `POST /settings/hooks/delete?id=` link-action target
 *   (org/setting.go:174-187) whose trash buttons this UI does not render.
 * - NO test-fire button: upstream's TestWebhook is repo-scope-only
 *   (web.go:740 registers `/{id}/test` inside the REPO settings group; the
 *   org group carries no test route, and the fake-push payload needs a repo
 *   pair) — rendering the repo page's button here would be a dead control.
 * - NO replay control: upstream history.tmpl renders a per-delivery replay
 *   form for org owners (web.go:1039's `/{id}/replay/{uuid}`), but no replay
 *   arm is landed anywhere (the repo page omits it too) — the deliveries
 *   segment renders read-only.
 * - The provider dropdown on the edit form (webhook/new.tmpl's type menu)
 *   reduces away exactly like the list page's: `gitea` is the only landed
 *   type.
 * - The per-delivery request/response detail panels (history.tmpl's tab
 *   switcher) are not reproduced — the repo page's identical reduction; the
 *   row carries the uuid, the event chip and the timestamp.
 */

import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { ApiError } from "../../api/errors";
import {
  createOwnerHook,
  deleteOwnerHook,
  getOwnerHook,
  hookEventsArray,
  listHookDeliveries,
  listOwnerHooks,
  type WebhookRow,
} from "../../api/services/hooks";
import { HookStatus, webhookDeliveries } from "../../db/schema";
import type { OrgRecord } from "../../services/orgs/orgs";
import { TimeSince } from "../components/file-list";
import type { IconName } from "../icons";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { OrgHeader } from "./org-home";
import { OrgSettingsNavbar } from "../components/settings-nav";
import { orgSettingsLocale } from "./org-settings";
import {
  hookBranchFilterOf,
  hookDetailLocale,
  hookEditFormOf,
  HOOK_DELIVERIES_LIMIT,
  HOOKS_LIST_LIMIT,
  settingsLocale,
  type CreateHookForm,
  type HookDeliveryRow,
  type HookEditForm,
} from "./settings";

// ---------------------------------------------------------------------------
// The list page (GET /{org}/settings/hooks — org/settings/hooks.tmpl)
// ---------------------------------------------------------------------------

/** One rendered hook row: the stored row, its event names (hookEventsArray)
 *  and its delivery count (the batched group-by read). */
export interface OrgHookListItem {
  row: WebhookRow;
  events: string[];
  deliveries: number;
}

/** The hooks tab's render inputs: the org plus the list. */
export interface OrgHooksSettingsData {
  org: OrgRecord;
  hooks: OrgHookListItem[];
  /** The re-rendered add-form submission ("" on the plain GET). */
  form: { name: string; payloadUrl: string; contentType: string };
}

/** Load the list (the landed orgListHooks read arm — owner-scoped, id ASC). */
export async function loadOrgHooksSettings(d1: D1Database, org: OrgRecord): Promise<OrgHooksSettingsData> {
  const { items } = await listOwnerHooks(d1, org.id, { page: 1, limit: HOOKS_LIST_LIMIT });
  // One batched delivery-count read for the page (the repo page's wave-2
  // batching pattern; listHookDeliveries is per-hook and paginated — the
  // count alone is what base_list renders space for).
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
    org,
    hooks: items.map((row) => ({ row, events: hookEventsArray(row.events), deliveries: counts.get(row.id) ?? 0 })),
    form: { name: "", payloadUrl: "", contentType: "json" },
  };
}

export type CreateOrgHookResult = { outcome: "created" } | { outcome: "invalid"; message: string };

/**
 * The add-hook write through the landed `createOwnerHook` — the org arm of
 * routes/hooks-scopes.ts's orgCreateHook (AddOwnerHook): the
 * checkCreateHookOption validation runs upstream-exact inside the service;
 * its ApiError messages re-render inline (the API's 422 body text).
 */
export async function createOrgHookFromForm(d1: D1Database, org: OrgRecord, form: CreateHookForm): Promise<CreateOrgHookResult> {
  try {
    await createOwnerHook(d1, org.id, {
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

/** The full-document render for the list page (the render.tsx pattern). */
export function renderOrgHooksSettingsPage(options: {
  ctx: UiContext;
  data: OrgHooksSettingsData;
  error: string | null;
}): string {
  return renderPage(<OrgHooksSettingsPage ctx={options.ctx} data={options.data} error={options.error} />);
}

/**
 * The org webhooks list page (§2.4.1 discriminator: `organization settings
 * webhooks` — org/settings/hooks.tmpl): OrgHeader, the settings navbar with
 * the hooks item active, then base_list.tmpl's header/segment pair and the
 * inline add form.
 */
export function OrgHooksSettingsPage(props: { ctx: UiContext; data: OrgHooksSettingsData; error: string | null }) {
  const { ctx, data } = props;
  const org = data.org;
  const orgLink = `/${org.username}`;
  const hooksLink = `${orgLink}/settings/hooks`;
  return (
    <BaseLayout ctx={ctx} title={orgSettingsLocale.settings} pageClass="organization settings webhooks">
      <OrgHeader org={org} signedIn={ctx.viewer.kind === "user"} />
      <div class="ui container flex-container">
        <OrgSettingsNavbar orgLink={orgLink} active="hooks" />
        <div class="flex-container-main">
          {/* base_list.tmpl's header/segment pair. The h4 renders upstream's
              literal .Title — org/setting.go:151 sets it to org.settings, not
              the repo arm's repo.settings.hooks (the header's quirk note). */}
          <h4 class="ui top attached header">{orgSettingsLocale.settings}</h4>
          <div class="ui attached segment">
            <div>
              Add webhooks which will be triggered for all repositories under this organization.
            </div>
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
                  const hookLink = `${hooksLink}/${hook.row.id}`;
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
                          upstream's is icon-only, §2.4.1). No trash button:
                          the repo page's delete-form reduction (the module
                          header). */}
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
            <form class="ui form" action={hooksLink} method="post">
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
// The per-hook page (GET+POST /{org}/settings/hooks/{id} +
// POST .../{id}/delete — org/settings/hook_new.tmpl's edit arm over the
// shared repo_setting.WebHooksEdit / GiteaHooksEditPost / DeleteWebhook
// org-scope shapes)
// ---------------------------------------------------------------------------

/** The org per-hook page's render inputs: the org-scoped hook row, its
 *  subscription names, branch filter, the edit-form binding and the newest
 *  deliveries. */
export interface OrgHookDetailData {
  org: OrgRecord;
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

/** Load the per-hook page (the landed orgGetHook read + the shared delivery
 *  read). `null` = the 404 shell: an unknown or foreign-org hook id. */
export async function loadOrgHookDetailData(d1: D1Database, org: OrgRecord, hookId: number): Promise<OrgHookDetailData | null> {
  const hook = await getOwnerHook(d1, org.id, hookId);
  if (hook === null) return null;
  const { items, total } = await listHookDeliveries(d1, hook.id, { page: 1, limit: HOOK_DELIVERIES_LIMIT });
  const events = hookEventsArray(hook.events);
  return {
    org,
    hook,
    events,
    branchFilter: hookBranchFilterOf(hook),
    deliveries: items,
    deliveryTotal: total,
    form: hookEditFormOf(hook, events),
  };
}

/**
 * The delete write (upstream DeleteWebhook's org arm — org/setting.go:175-187
 * — over the landed `deleteOwnerHook`): true when a row was deleted, false on
 * a miss (the caller 404-shells — the landed DELETE arm's 404, existence
 * stays hidden). Upstream's flash texts ride unconditional redirects here
 * (no session-flash plumbing — the user-settings reduction), so the boolean
 * is all the caller needs.
 */
export async function deleteOrgHook(d1: D1Database, org: OrgRecord, hookId: number): Promise<boolean> {
  return deleteOwnerHook(d1, org.id, hookId);
}

// --- components -----------------------------------------------------------------

/** history.tmpl's status mark for one delivery: succeeded green (check),
 *  undelivered orange (pending/delivering/skipped — the clock stands in for
 *  the un-allowlisted octicon-stopwatch), delivered failure red (the dot
 *  fill stands in for octicon-alert). Local twin of the repo page's private
 *  helper (settings.tsx keeps its copy module-private). */
function deliveryStatus(row: HookDeliveryRow): { cls: string; icon: IconName } {
  if (row.isSucceed) return { cls: "tw-text-green", icon: "octicon-check" };
  if (row.state !== "delivered") return { cls: "tw-text-orange", icon: "octicon-clock" };
  return { cls: "tw-text-red", icon: "octicon-dot-fill" };
}

/** The delivery row's time: delivered when stamped, created otherwise (a
 *  pending row's queue age — the repo page's cf-gitea addition, twinned). */
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

/** The full-document render for the per-hook page (the render.tsx pattern). */
export function renderOrgHookDetailPage(options: {
  ctx: UiContext;
  data: OrgHookDetailData;
  error: string | null;
}): string {
  return renderPage(<OrgHookDetailPage ctx={options.ctx} data={options.data} error={options.error} />);
}

/**
 * The org per-hook page (§2.4.1 discriminator: `organization settings new
 * webhook` — org/settings/hook_new.tmpl's EDIT arm: upstream renders the
 * shared WebHooksEdit through the org new template with CustomHeaderTitle =
 * repo.settings.update_webhook). The edit form + the read-only subscription
 * line + the Remove Webhook form + history.tmpl's deliveries segment
 * (read-only — the module header's test/replay reductions).
 */
export function OrgHookDetailPage(props: { ctx: UiContext; data: OrgHookDetailData; error: string | null }) {
  const { ctx, data } = props;
  const org = data.org;
  const orgLink = `/${org.username}`;
  const hookLink = `${orgLink}/settings/hooks/${data.hook.id}`;
  const form = data.form;
  return (
    <BaseLayout ctx={ctx} title={hookDetailLocale.update_webhook} pageClass="organization settings new webhook">
      <OrgHeader org={org} signedIn={ctx.viewer.kind === "user"} />
      <div class="ui container flex-container">
        <OrgSettingsNavbar orgLink={orgLink} active="hooks" />
        <div class="flex-container-main">
          {/* gitea.tmpl's form + settings.tmpl's fields (the module header's
              not-rendered notes for secret/auth-header/events). */}
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
          {/* history.tmpl's header shape: the list title alone — the org arm
              has no test route upstream and no replay arm is landed (the
              module header). */}
          <h4 class="ui top attached header">{hookDetailLocale.recent_deliveries}</h4>
          <div class="ui attached segment">
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
