/**
 * The user settings WEBHOOKS tab, `/user/settings/hooks` — pages wave 57
 * (bench row `wave-user-webhooks-module`, TWO-STAGE UNMOUNTED — the route
 * rides the index.ts window; `index.ts` is orchestrator/sibling-owned).
 *
 * ## PREMISE CORRECTED (the wiki-module's lesson, verified at the pin)
 *
 * The brief named upstream `templates/user/settings/webhooks.tmpl`; NO such
 * file exists at the pin (the user/settings directory carries `hooks.tmpl` +
 * `hook_new.tmpl` and no webhooks.tmpl — `ls gitea/templates/user/settings/`,
 * and a repo-wide find for "*webhook*" surfaces only the `webhook/`,
 * `shared/webhook/` and `repo/settings/webhook/` template directories). The
 * real user-scope webhooks surface IS the hooks pair, and upstream's own
 * naming proves it: `routers/web/user/setting/webhooks.go:18` names
 * `tplSettingsHooks templates.TplName = "user/settings/hooks"`, and the
 * template's own pageClass is the literal `user settings webhooks`
 * (hooks.tmpl:1). This module ports what is actually there:
 *
 *   - the LIST: user/settings/hooks.tmpl — a 5-line wrapper around
 *     repo/settings/webhook/base_list.tmpl (the scope-agnostic list) between
 *     layout_head/layout_footer;
 *   - the PER-HOOK page: user/settings/hook_new.tmpl — the same wrapper
 *     around webhook/new.tmpl with CustomHeaderTitle switching on
 *     PageIsSettingsHooksNew (repo.settings.update_webhook on the edit arm —
 *     the only arm this module renders; the add form rides the list page
 *     INLINE, the org/repo pages' documented add-form reduction).
 *
 * Upstream routes (web.go:736-746's `/user/settings/hooks` group inside the
 * `reqSignIn` /user/settings subtree, `webhooksEnabled` gate — our
 * instance-setting omission follows the repo/org families' documented class):
 *
 *   GET  /user/settings/hooks             → user_setting.Webhooks
 *                                          (webhooks.go:22-37)
 *   POST /user/settings/hooks/delete      → user_setting.DeleteWebhook
 *                                          (webhooks.go:40-53, the `?id=`
 *                                          link-action target)
 *   GET  /user/settings/hooks/{type}/new  → repo_setting.WebhooksNew (+ the
 *                                          per-provider POST /{type}/new
 *                                          writes, addWebhookAddRoutes)
 *   GET  /user/settings/hooks/{id}        → repo_setting.WebHooksEdit (renders
 *                                          the user scope's hook_new.tmpl
 *                                          through orCtx.NewTemplate)
 *   POST /user/settings/hooks/{id}/replay/{uuid} → repo_setting.ReplayWebhook
 *   POST /user/settings/hooks/{type}/{id} → the per-provider edit writes
 *                                          (addWebhookEditRoutes)
 *
 * ## HANDOFF NOTE (for the wiring wave)
 *
 * The module is complete end-to-end over the landed user-hooks family;
 * signed-in only (the reqSignIn group — the user-settings.tsx pattern):
 *
 *   GET  /user/settings/hooks       → resolveUiSession signed-in gate
 *                (anonymous → the login round-trip 303) →
 *                loadUserSettingsHooksPageData → renderUserSettingsHooksPage;
 *                a session doer without a D1 row 404-shells (the
 *                silent-auth-failure convention).
 *   POST /user/settings/hooks       → the sameOriginGuard + the signed-in
 *                gate, `readUrlEncodedForm`, `parseCreateHookForm` (the
 *                settings.tsx shared parse), `createUserHookFromForm`;
 *                `outcome: "created"` 303s back onto /user/settings/hooks
 *                (upstream's flash reduction — no session-flash plumbing,
 *                the user-settings convention); `outcome: "invalid"`
 *                re-renders the page with the ApiError 422 message in the
 *                `error` slot + the `form` values carried over (upstream
 *                RenderWithErrDeprecated's re-render arm).
 *   GET  /user/settings/hooks/{id}  → loadUserHookDetailData (null = an
 *                unknown or foreign-owned hook id → the 404 shell, the
 *                landed DELETE arm's existence-hiding 404) →
 *                renderUserHookDetailPage.
 *   POST /user/settings/hooks/{id}  → `parseHookEditForm` +
 *                `editHookFromForm` (the scope-agnostic shared edit over
 *                editRepoHook — the landed userEditHook arm's exact
 *                sequence: getOwnerHook → editRepoHook,
 *                routes/hooks-scopes.ts user scope); `outcome: "saved"`
 *                303s back onto the hook page; `outcome: "invalid"`
 *                re-renders with the message.
 *   POST /user/settings/hooks/{id}/delete → `deleteUserHook`
 *                (deleteOwnerHook; false → the 404 shell) then 303 back
 *                onto /user/settings/hooks (upstream DeleteWebhook's
 *                JSONRedirect target, webhooks.go:52; the flash texts do
 *                not render — the no-session-flash reduction).
 *
 * The navbar (user/settings/navbar.tmpl) is the SHARED
 * components/settings-nav UserSettingsNavbar (the wave-114 swap) with this
 * tab's Webhooks item active (navbar.tmpl's PageIsSettingsHooks item, locale
 * repo.settings.hooks).
 *
 * ## Data (§3.2 — the landed user-hooks API family, never a self-fetch)
 *
 * The hooks-scopes wave's user CRUD (`GET/POST /user/hooks`,
 * `GET/PATCH/DELETE /user/hooks/{id}` — routes/hooks-scopes.ts) rides the
 * owner-scoped service arms this page calls directly with the doer's id:
 *
 *   list      `listOwnerHooks` (services/hooks.ts — upstream
 *             ListWebhookOptions{OwnerID: ctx.Doer.ID}, webhooks.go:29) +
 *             one batched delivery-count read (the repo page's wave-2
 *             batching pattern);
 *   create    `createOwnerHook` (AddOwnerHook, utils/hook.go — the exact
 *             checkCreateHookOption validation, its 422 messages surfaced
 *             inline);
 *   read      `getOwnerHook` (GetWebhookByOwnerID — an unknown or
 *             foreign-owned id 404-shells);
 *   edit      `editHookFromForm` over `editRepoHook` — the service is
 *             scope-agnostic by construction (upstream's single shared
 *             editHook body serves the repo/owner/system callers alike; the
 *             user PATCH arm calls the very same function,
 *             routes/hooks-scopes.ts user scope);
 *   delete    `deleteOwnerHook` (DeleteWebhookByOwnerID, webhooks.go:44);
 *   history   `listHookDeliveries` (the shared delivery read — the rows
 *             key on the hook id, scope-free).
 *
 * ## DOM contract
 *
 * The list page is user/settings/hooks.tmpl: layout_head's `.page-content
 * .user settings webhooks` → the settings navbar → the `.user-setting-content`
 * wrapper carrying base_list.tmpl's header/segment pair — the status dot
 * (the repo page's three-class mapping over last_status), the name/URL row
 * linking onto the per-hook page (`{{$.BaseLink}}/{{.ID}}`, BaseLink =
 * /user/settings/hooks, webhooks.go:25), and the pencil anchor. Upstream's
 * segment header renders `{{.Title}}`, and the user arm sets it to
 * `ctx.Tr("settings_title")` — "Settings" (webhooks.go:23), not the repo
 * arm's "Webhooks": the org arm's h4 quirk twin, kept verbatim.
 * `.Description` renders settings.hooks.desc above the list (strong
 * stripped — the org module's convention).
 *
 * The per-hook page is hook_new.tmpl's EDIT arm (`user settings new
 * webhook`, CustomHeaderTitle = repo.settings.update_webhook):
 * webhook/new.tmpl → gitea.tmpl's form (payload_url, content_type, name,
 * branch_filter, active — the landed repo-page field set with upstream's
 * field names), the read-only subscription line (settings.tmpl's matrix
 * reduced, the hidden `events` preserve inputs riding the PATCH arm's
 * unconditional rewrite), the red Remove Webhook form, then history.tmpl's
 * Recent Deliveries segment.
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - The add form fixes the hook type to `gitea` (the generic JSON webhook)
 *   and rides POST /settings/hooks INLINE: upstream's provider-picker page
 *   (`GET /{type}/new` + the per-provider `POST /{type}/new` writes,
 *   addWebhookAddRoutes inside the user group) has exactly one landed
 *   provider — the repo/org pages' documented add-form reduction. The
 *   provider dropdown in the h4 (base_list.tmpl's jump dropdown +
 *   link_menu; webhook/new.tmpl's type menu) reduces away the same way.
 * - The delete rides the arm-scoped `POST .../hooks/{id}/delete` form (the
 *   landed repo page's wave-14 convention): upstream deletes through the
 *   shared `POST /user/settings/hooks/delete?id=` link-action target
 *   (webhooks.go:40-53) whose trash buttons + modal confirm this UI does
 *   not render.
 * - NO test-fire button: upstream's TestWebhook is repo-scope-only (the
 *   `/user/settings/hooks` group registers no test route — only the repo
 *   settings group does; the fake-push payload needs a repo pair) —
 *   rendering the repo page's button here would be a dead control (the org
 *   page's identical reduction).
 * - NO replay control: upstream history.tmpl renders a per-delivery replay
 *   form and the user group DOES register `/{id}/replay/{uuid}`
 *   (web.go:742), but no replay arm is landed anywhere in our stack (the
 *   repo page omits it too) — the deliveries segment renders read-only.
 * - The per-delivery request/response detail panels (history.tmpl's tab
 *   switcher) are not reproduced — the repo/org pages' identical reduction;
 *   the row carries the uuid, the event chip and the timestamp.
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
import { TimeSince } from "../components/file-list";
import { UserSettingsNavbar } from "../components/settings-nav";
import type { IconName } from "../icons";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import {
  editHookFromForm,
  hookBranchFilterOf,
  hookDetailLocale,
  hookEditFormOf,
  HOOK_DELIVERIES_LIMIT,
  HOOKS_LIST_LIMIT,
  parseCreateHookForm,
  parseHookEditForm,
  settingsLocale,
  type CreateHookForm,
  type HookDeliveryRow,
  type HookEditForm,
} from "./settings";

// ---------------------------------------------------------------------------
// Page chrome (the component-local locale pattern — locale.ts is shared and
// not this wave's file; every string cites its upstream key)
// ---------------------------------------------------------------------------

export const userSettingsWebhooksLocale = {
  hooks: "Webhooks", // "repo.settings.hooks" (the title + the shared navbar's item — the user tab reuses the repo key, navbar.tmpl)
  settings_title: "Settings", // "settings_title" (the list h4 — webhooks.go:23 sets .Title to it, the org arm's quirk twin)
  hooks_desc: "Add webhooks which will be triggered for all repositories that you own.", // "settings.hooks.desc" (strong stripped)
} as const;

// ---------------------------------------------------------------------------
// The list page (GET /user/settings/hooks — user/settings/hooks.tmpl)
// ---------------------------------------------------------------------------

/** One rendered hook row: the stored row, its event names (hookEventsArray)
 *  and its delivery count (the batched group-by read). */
export interface UserHookListItem {
  row: WebhookRow;
  events: string[];
  deliveries: number;
}

/** The hooks tab's render inputs. */
export interface UserHooksSettingsData {
  hooks: UserHookListItem[];
  /** The re-rendered add-form submission ("" on the plain GET). */
  form: { name: string; payloadUrl: string; contentType: string };
}

/** The canonical tab link (BaseLink/BaseLinkNew, webhooks.go:25-26). */
export const USER_SETTINGS_HOOKS_LINK = "/user/settings/hooks";

/** Load the list (the landed userListHooks read arm — owner-scoped, id ASC). */
export async function loadUserSettingsHooksPageData(d1: D1Database, userId: number): Promise<UserHooksSettingsData> {
  const { items } = await listOwnerHooks(d1, userId, { page: 1, limit: HOOKS_LIST_LIMIT });
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
    hooks: items.map((row) => ({ row, events: hookEventsArray(row.events), deliveries: counts.get(row.id) ?? 0 })),
    form: { name: "", payloadUrl: "", contentType: "json" },
  };
}

/** The add-hook write through the landed `createOwnerHook` — the user arm of
 *  routes/hooks-scopes.ts's userCreateHook (AddOwnerHook with the doer as
 *  owner): the checkCreateHookOption validation runs upstream-exact inside
 *  the service; its ApiError messages re-render inline (the API's 422 body
 *  text). */
export async function createUserHookFromForm(d1: D1Database, userId: number, form: CreateHookForm): Promise<{ outcome: "created" } | { outcome: "invalid"; message: string }> {
  try {
    await createOwnerHook(d1, userId, {
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

// Re-exported so the wiring wave needs only this module (the org module's
// re-export posture for its parse pair).
export { parseCreateHookForm, parseHookEditForm };

/** The full-document render for the list page (the render.tsx pattern). */
export function renderUserSettingsHooksPage(options: {
  ctx: UiContext;
  data: UserHooksSettingsData;
  error: string | null;
}): string {
  return renderPage(<UserHooksSettingsPage ctx={options.ctx} data={options.data} error={options.error} />);
}

/**
 * The user webhooks list page (§2.4.1 discriminator: `user settings
 * webhooks` — user/settings/hooks.tmpl's pageClass): the settings navbar
 * with the hooks item active, then base_list.tmpl's header/segment pair and
 * the inline add form.
 */
export function UserHooksSettingsPage(props: { ctx: UiContext; data: UserHooksSettingsData; error: string | null }) {
  const { ctx, data } = props;
  return (
    <BaseLayout ctx={ctx} title={userSettingsWebhooksLocale.hooks} pageClass="user settings webhooks">
      <div class="ui container flex-container">
        <UserSettingsNavbar active="hooks" />
        <div class="user-setting-content">
          {/* base_list.tmpl's header/segment pair. The h4 renders upstream's
              literal .Title — webhooks.go:23 sets it to settings_title
              ("Settings"), not the repo arm's repo.settings.hooks (the org
              arm's h4 quirk twin, webhooks.go:23). */}
          <h4 class="ui top attached header">{userSettingsWebhooksLocale.settings_title}</h4>
          <div class="ui attached segment">
            <div>{userSettingsWebhooksLocale.hooks_desc}</div>
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
                  const hookLink = `${USER_SETTINGS_HOOKS_LINK}/${hook.row.id}`;
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
                      {/* base_list.tmpl's pencil anchor (aria-label additive
                          — upstream's is icon-only). No trash button: the
                          delete lives on the per-hook page (the module
                          header's delete reduction). */}
                      <a class="muted" href={hookLink} aria-label={settingsLocale.edit_hook_aria}>
                        <Icon name="octicon-pencil" />
                      </a>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {/* The inline add form (the provider-picker reduction — the module
              header): the repo/org pages' field set, action = the wiring
              wave's POST mount. */}
          <h4 class="ui top attached header">{settingsLocale.add_webhook}</h4>
          <div class="ui attached segment">
            <form class="ui form" action={USER_SETTINGS_HOOKS_LINK} method="post">
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
// The per-hook page (GET+POST /user/settings/hooks/{id} +
// POST .../{id}/delete — hook_new.tmpl's edit arm over the shared
// repo_setting.WebHooksEdit user-scope shapes)
// ---------------------------------------------------------------------------

/** The per-hook page's render inputs: the owner-scoped hook row, its event
 *  names, branch filter, the edit-form binding and the newest deliveries. */
export interface UserHookDetailData {
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

/** Load the per-hook page (the landed userGetHook read + the shared delivery
 *  read). `null` = the 404 shell: an unknown or foreign-owned hook id. */
export async function loadUserHookDetailData(d1: D1Database, userId: number, hookId: number): Promise<UserHookDetailData | null> {
  const hook = await getOwnerHook(d1, userId, hookId);
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

/**
 * The edit write — the landed userEditHook arm's exact service sequence
 * (getOwnerHook → editRepoHook over the caller-fetched row) via the shared
 * `editHookFromForm` (settings.tsx): url/content_type validate with the
 * API's 422 messages (re-rendered inline), the events rewrite + branch
 * filter apply unconditionally (the form always sends them), name/active
 * apply from the form.
 */
export async function editUserHookFromForm(d1: D1Database, hook: WebhookRow, form: HookEditForm): Promise<{ outcome: "saved" } | { outcome: "invalid"; message: string }> {
  return editHookFromForm(d1, hook, form);
}

/**
 * The delete write (upstream DeleteWebhook's arm — webhooks.go:40-53 — over
 * the landed `deleteOwnerHook`): true when a row was deleted, false on a
 * miss (the caller 404-shells — the landed DELETE arm's 404, existence
 * stays hidden). Upstream's flash texts ride its JSONRedirect here (no
 * session-flash plumbing — the user-settings reduction), so the boolean is
 * all the caller needs.
 */
export async function deleteUserHook(d1: D1Database, userId: number, hookId: number): Promise<boolean> {
  return deleteOwnerHook(d1, userId, hookId);
}

// --- components -----------------------------------------------------------------

/** history.tmpl's status mark for one delivery: succeeded green (check),
 *  undelivered orange (pending/delivering/skipped — the clock stands in for
 *  the un-allowlisted octicon-stopwatch), delivered failure red (the dot
 *  fill stands in for octicon-alert). Local twin of the repo/org pages'
 *  private helpers (settings.tsx keeps its copy module-private). */
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
export function renderUserHookDetailPage(options: {
  ctx: UiContext;
  data: UserHookDetailData;
  error: string | null;
}): string {
  return renderPage(<UserHookDetailPage ctx={options.ctx} data={options.data} error={options.error} />);
}

/**
 * The user per-hook page (§2.4.1 discriminator: `user settings new webhook`
 * — hook_new.tmpl's EDIT arm: upstream renders the shared WebHooksEdit
 * through the user new template with CustomHeaderTitle =
 * repo.settings.update_webhook). The edit form + the read-only subscription
 * line + the Remove Webhook form + history.tmpl's deliveries segment
 * (read-only — the module header's test/replay reductions).
 */
export function UserHookDetailPage(props: { ctx: UiContext; data: UserHookDetailData; error: string | null }) {
  const { ctx, data } = props;
  const hookLink = `${USER_SETTINGS_HOOKS_LINK}/${data.hook.id}`;
  const form = data.form;
  return (
    <BaseLayout ctx={ctx} title={hookDetailLocale.update_webhook} pageClass="user settings new webhook">
      <div class="ui container flex-container">
        <UserSettingsNavbar active="hooks" />
        <div class="user-setting-content">
          {/* gitea.tmpl's form + settings.tmpl's fields (the repo page's
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
          {/* history.tmpl's header shape: the list title alone — the user
              group has no test route upstream and no replay arm is landed
              (the module header). */}
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
