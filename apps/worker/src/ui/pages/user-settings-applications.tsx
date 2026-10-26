/**
 * The user settings APPLICATIONS tab, `/user/settings/applications` — pages
 * wave 54 (bench row `wave-settings-keys-tags`, TWO-STAGE UNMOUNTED — the
 * route rides the index.ts window; `index.ts` is orchestrator/sibling-owned;
 * the SSH/GPG keys twin is pages/user-settings-keys.tsx).
 *
 * ## HANDOFF NOTE (for the wiring wave)
 *
 * The module is complete end-to-end over the landed SPEC-0002 TokenService;
 * upstream's exact route group is web.go:680-697 (the access-token half —
 * the `/oauth2` subgroup inside it is NOT ours, see the reductions):
 *
 *   GET  /user/settings/applications           → resolveUiSession (the
 *                signed-in gate, the user-settings.tsx pattern) →
 *                loadUserSettingsApplicationsPageData (the doer manages
 *                exactly their own tokens — upstream Applications over
 *                ctx.Doer) → renderUserSettingsApplicationsPage; a session
 *                doer without a D1 row 404-shells (the
 *                silent-auth-failure convention).
 *   POST /user/settings/applications           → the sameOriginGuard + the
 *                signed-in gate, `readUrlEncodedForm`,
 *                `parseUserSettingsApplicationsForm`,
 *                `createTokenFromForm`. `outcome: "created"` re-renders the
 *                FULL page with `data.newToken` set — upstream renders only
 *                the tplAccessTokens PANEL fragment with NewTokenValue
 *                (applications.go:154-158, the form's data-fetch-sync JS
 *                swaps it in); with no fetch-action plumbing the full-page
 *                re-render is the honest no-JS analog (the plaintext renders
 *                exactly once — SPEC-0002 §3 never stores it). An
 *                `outcome: "invalid"` re-renders with the `error` line + the
 *                submitted name (upstream's JSONError arms; the no-JS shape
 *                is the keys page's re-render convention).
 *   POST /user/settings/applications/delete    → the sameOriginGuard + the
 *                signed-in gate, `parseUserSettingsApplicationsDeleteForm`,
 *                `revokeTokenFromForm`, then 303 back onto
 *                `/user/settings/applications` (upstream DeleteApplication →
 *                DeleteAccessToken's JSONRedirect; the plain-form-POST +
 *                303 convention where upstream's JS intercepts). A "missing"
 *                outcome (a stale form id) 303s silently — upstream's
 *                flash-error arm carries the Go error string
 *                ("GetAccessTokenByID: …", applications.go:170-173), which
 *                has no renderable analog.
 *
 * Upstream's settings navbar (user/settings/navbar.tmpl) is the SHARED
 * components/settings-nav UserSettingsNavbar (the wave-114 swap) with this
 * tab's Applications item active.
 *
 * ## Data (§3.2 — the landed tokens family, never a self-fetch)
 *
 * The brief's landed family is routes/account-aggregates.ts's
 * GET/POST/DELETE /users/{username}/tokens (user/app.go ListAccessTokens /
 * CreateAccessToken / DeleteAccessToken) over the SPEC-0002 TokenService.
 * This page calls the SAME TokenService arms the route handlers call
 * (`list` / `mint` / `revoke` — auth/token-service.ts), never the route:
 *
 *   list     `TokenService.list(userId, 1, TOKENS_LIST_LIMIT)` — upstream's
 *            web panel is db.Find with NO pagination
 *            (NewAccessTokensPanel, applications.go:40-58); the 500-row cap
 *            is the render bound (the settings-collaboration cap note).
 *            HasUsed/HasRecentActivity are upstream's AfterLoad pair
 *            (access_token.go:38-39) over created/last_used_at; the 24 h
 *            last-used throttle (SPEC-0002 §4.4) feeds the same fields.
 *   create   upstream CreateAccessToken (applications.go:63-160): every
 *            `scope-*` form value joined with "," → Normalize → the
 *            HasPermissionScope gate (settings.at_least_one_permission) →
 *            the name-duplicate arm (settings.generate_token_name_duplicate)
 *            → NewAccessToken. The landed `mint` carries the same order
 *            (duplicate → scope normalization → empty scope, the
 *            token-service header) plus the 255-char name cap. The mint-time
 *            scope-escalation rule (applications.go:114-129's mirror of the
 *            API guard) needs the doer's token scope in the session
 *            identity, which the UI session does not carry — session-cookie
 *            requests mint as a scope-less parent (the SAME
 *            account-aggregates divergence, its module header's third
 *            bullet: the TokenService implements the rule; wiring it is the
 *            env-type owner's follow-up).
 *   revoke   `TokenService.revoke(userId, id)` — owner-scoped
 *            (user/app.go:198-219's DeleteAccessToken by owner + id).
 *
 * ## DOM contract (templates/user/settings/applications.tmpl +
 *  shared/user/access_tokens.tmpl at the pin)
 *
 * layout_head's pageClass is the literal `user settings applications`;
 * applications.tmpl renders `#access-token-panel` (access_tokens.tmpl): the
 * `h4.ui.top.attached.header` (manage_access_token), the `.ui.attached
 * segment` with the new-token `.ui.positive.message` (after a create —
 * `<code id="new-access-token-value">`), the `.flex-divided-list
 * .items-with-main` token list (per token: `.item-leading` send glyph,
 * `.item-main` `<details>` with the name summary + the access line +
 * the permissions `<ul>`, `.item-trailing` Delete), and the
 * `.ui.bottom.attached.segment` generate form inside `<details>`
 * (open when no tokens — access_tokens.tmpl:67): the name input
 * (required, maxlength 255), the public-only radio pair
 * (`scope-public-only`), the access_token_desc line and the per-category
 * radio table (`scope-{category}`: no-access "" checked / read / write).
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - The OAuth2 halves of applications.tmpl (grants_oauth2 + applications_
 *   oauth2, gated on .EnableOAuth2) are UNRENDERED: the landed OAuth2 store
 *   is API-only (routes/oauth2-apps.ts) with no web UI surface — this brief
 *   pins the PAT panel (access_tokens.tmpl).
 * - The Regenerate button + dialog (access_tokens.tmpl:51-56, 115-125) are
 *   UNRENDERED: upstream RegenerateAccessToken (applications.go:176-185)
 *   has no landed analog — TokenService carries mint/revoke only; a
 *   rendered button would post a dead route.
 * - The copy button beside the new token (access_tokens.tmpl:11,
 *   data-clipboard-target) is the bundle's clipboard JS — the no-JS shape
 *   renders the bare `<code id="new-access-token-value">`.
 * - The delete confirm dialog (access_tokens.tmpl:104-113) is not
 *   reproduced — the plain form POST (the hooks-list reduction, wave 4).
 * - The `IsBot` arms (access_tokens.tmpl:17, 51, 115 — bot tokens,
 *   no-delete, no-regenerate) render never: cf-gitea has no bot users.
 * - The generate form renders as plain radios (upstream's `gt-checkbox`
 *   labels) — the Fomantic styling is the bundle's CSS, the DOM is the
 *   same inputs; the details element is native HTML (no JS needed).
 * - The scope table lists GetAccessTokenCategories' SORTED order
 *   (applications.go:199-205 — slices.Sort), minus "admin" for non-admin
 *   viewers (NewAccessTokensPanel's SliceRemoveAll).
 * - generate_token_name_duplicate renders without upstream's <strong>
 *   wrapper (the plain-text error line; the locale's HTML tags stripped).
 */

import { TokenService } from "../../auth/token-service";
import type { AuthToken } from "../../auth/auth-context";
import { InvalidScopeError, normalizeScope, SCOPE_CATEGORIES, ScopeSet, scopeStringSlice } from "../../auth/scopes";
import { TokenNameExistsError, TokenNameTooLongError } from "../../auth/errors";
import { UserSettingsNavbar } from "../components/settings-nav";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { IconName } from "../icons";
import type { UiContext } from "../ui-context";

// ---------------------------------------------------------------------------
// Page chrome (the component-local locale pattern; every string cites its
// upstream key)
// ---------------------------------------------------------------------------

export const userSettingsApplicationsLocale = {
  applications: "Applications", // "settings.applications" (the title + the shared navbar item)
  manage_access_token: "Manage Access Tokens", // "settings.manage_access_token"
  generate_token_success: "Your new token has been generated. Copy it now as it will not be shown again.", // "settings.generate_token_success"
  tokens_desc: "These tokens grant access to your account using the Gitea API.", // "settings.tokens_desc"
  token_state_desc: "This token has been used in the last 7 days", // "settings.token_state_desc"
  added_on: "Added on", // "settings.added_on %s" — the date renders beside it
  last_used: "Last used on", // "settings.last_used"
  no_activity: "No recent activity", // "settings.no_activity"
  repo_and_org_access: "Repository and Organization Access", // "settings.repo_and_org_access"
  permissions_public_only: "Public only", // "settings.permissions_public_only"
  permissions_access_all: "All (public, private, and limited)", // "settings.permissions_access_all"
  permissions_list: "Permissions:", // "settings.permissions_list"
  delete_token: "Delete", // "settings.delete_token"
  generate_new_token: "Generate New Token", // "settings.generate_new_token"
  token_name: "Token Name", // "settings.token_name"
  access_token_desc_lead: "Selected token permissions limit authorization only to the corresponding", // "settings.access_token_desc" lead
  access_token_desc_api: "API", // "settings.access_token_desc" first link text
  access_token_desc_middle: "routes. Read the", // "settings.access_token_desc" between the links
  access_token_desc_docs: "documentation", // "settings.access_token_desc" second link text
  access_token_desc_tail: "for more information.", // "settings.access_token_desc" tail
  permission_no_access: "No Access", // "settings.permission_no_access"
  permission_read: "Read", // "settings.permission_read"
  permission_write: "Read and Write", // "settings.permission_write"
  generate_token: "Generate Token", // "settings.generate_token"
  at_least_one_permission: "You must select at least one permission to create a token", // "settings.at_least_one_permission"
  delete_token_success: "The token has been deleted. Applications using it no longer have access to your account.", // "settings.delete_token_success" (the flash reduction never renders it — kept for the outcome docs)
} as const;

/** The create/revoke outcomes the POST handlers render (the
 *  org-settings-hooks create-result pattern). */
export type CreateTokenOutcome =
  | { outcome: "created"; plaintext: string }
  | { outcome: "invalid"; message: string };

export type RevokeTokenOutcome = "deleted" | "missing";

/** The web panel lists ALL tokens (NewAccessTokensPanel's db.Find,
 *  applications.go:42-48 — no pagination); this cap is the render bound
 *  (the settings-collaboration cap note). */
export const TOKENS_LIST_LIMIT = 500;

/** GetAccessTokenCategories (applications.go:199-205): the scope categories
 *  in SORTED order — minus "admin" when the owner is not a site admin
 *  (NewAccessTokensPanel's SliceRemoveAll, applications.go:55). */
export function tokenScopeCategories(isAdmin: boolean): string[] {
  const sorted = [...SCOPE_CATEGORIES].sort();
  return isAdmin ? sorted : sorted.filter((category) => category !== "admin");
}

/** One rendered token row: the stored token plus upstream's render
 *  projections (access_tokens.tmpl:19-63). `publicOnly` is upstream
 *  DisplayPublicOnly() (access_token.go:80-84 — the scope bitmap's
 *  public-only bit); `scopes` is Scope.StringSlice minus the public-only
 *  literal (access_tokens.tmpl:39-43's ne-filter). */
export interface TokenListItem {
  token: AuthToken;
  publicOnly: boolean;
  scopes: string[];
  hasUsed: boolean;
  hasRecentActivity: boolean;
}

/** The applications tab's render inputs. `form` re-renders the submitted
 *  name ("" on the plain GET); `newToken` carries the minted plaintext
 *  exactly once (the create POST's full-page re-render). */
export interface UserSettingsApplicationsPageData {
  tokens: TokenListItem[];
  scopeCategories: string[];
  form: { name: string };
  newToken: string | null;
}

/** The page load — `now` is the HasRecentActivity clock (fixed-clock tests,
 *  the milestones loader pattern). */
export async function loadUserSettingsApplicationsPageData(
  d1: D1Database,
  userId: number,
  isAdmin: boolean,
  now: Date = new Date(),
): Promise<UserSettingsApplicationsPageData> {
  const service = new TokenService(d1);
  const page = await service.list(userId, 1, TOKENS_LIST_LIMIT);
  return {
    tokens: page.tokens.map((token) => {
      const set = ScopeSet.parseLenient(token.scopes);
      return {
        token,
        publicOnly: set.publicOnly,
        scopes: scopeStringSlice(token.scopes).filter((scope) => scope !== "public-only"),
        hasUsed: token.lastUsedAt !== null && token.lastUsedAt.getTime() > token.createdAt.getTime(),
        hasRecentActivity: token.lastUsedAt !== null && token.lastUsedAt.getTime() + 7 * 24 * 60 * 60 * 1000 > now.getTime(),
      };
    }),
    scopeCategories: tokenScopeCategories(isAdmin),
    form: { name: "" },
    newToken: null,
  };
}

// ---------------------------------------------------------------------------
// The write arms (upstream CreateAccessToken / DeleteAccessToken)
// ---------------------------------------------------------------------------

/** The create POST body: the name plus the raw gathered scope names (the
 *  handler's `scope-*` join, applications.go:64-75). */
export interface UserSettingsApplicationsForm {
  name: string;
  /** Every `scope-*` form value comma-joined, pre-normalization. */
  scopesRaw: string;
}

/** Parse the urlencoded create POST: every form key carrying the `scope-`
 *  prefix contributes its values (applications.go:66-73 — the prefix match
 *  includes `scope-public-only` and every `scope-{category}` trio). */
export function parseUserSettingsApplicationsForm(params: URLSearchParams): UserSettingsApplicationsForm {
  const scopeNames: string[] = [];
  for (const key of new Set(params.keys())) {
    if (key.startsWith("scope-")) {
      scopeNames.push(...params.getAll(key));
    }
  }
  return { name: params.get("name") ?? "", scopesRaw: scopeNames.join(",") };
}

/** The delete POST body (upstream ctx.FormInt64("id")). */
export function parseUserSettingsApplicationsDeleteForm(params: URLSearchParams): { id: number | null } {
  const raw = params.get("id") ?? "";
  return { id: /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null };
}

/**
 * The create — upstream CreateAccessToken (applications.go:63-160) over the
 * landed mint: the Required-name binder arm (the web binder's
 * `Name: Required`, api.go:841-844's spelling), scope normalization (an
 * unknown scope answers the InvalidScopeError message — upstream's arm is a
 * ServerError, unreachable from the rendered radios), the
 * HasPermissionScope gate, the duplicate-name arm, then the mint (the
 * 255-char cap answers the binder's `Name: MaxSize(255)` spelling). The
 * scope-escalation note is in the module header.
 */
export async function createTokenFromForm(
  d1: D1Database,
  userId: number,
  form: UserSettingsApplicationsForm,
  now: Date = new Date(),
): Promise<CreateTokenOutcome> {
  if (form.name === "") {
    return { outcome: "invalid", message: "Name: Required" };
  }
  let normalized: string;
  try {
    normalized = normalizeScope(form.scopesRaw);
  } catch (error) {
    if (error instanceof InvalidScopeError) {
      return { outcome: "invalid", message: error.message };
    }
    throw error;
  }
  if (!ScopeSet.parse(normalized).hasPermissionScope()) {
    return { outcome: "invalid", message: userSettingsApplicationsLocale.at_least_one_permission };
  }
  try {
    const minted = await new TokenService(d1).mint({ userId, name: form.name, scopes: normalized, now });
    return { outcome: "created", plaintext: minted.plaintext };
  } catch (error) {
    return mintErrorToOutcome(error, form.name);
  }
}

/** Map a mint failure to the upstream web arm's message (the duplicate-name
 *  JSONError's locale text, the <strong> wrapper stripped; the length cap
 *  answers the binder's MaxSize spelling). */
function mintErrorToOutcome(error: unknown, name: string): CreateTokenOutcome {
  if (error instanceof TokenNameExistsError) {
    return {
      outcome: "invalid",
      message: `${name} has been used as an application name already. Please use a new one.`,
    };
  }
  if (error instanceof TokenNameTooLongError) {
    return { outcome: "invalid", message: "Name: MaxSize(255)" };
  }
  throw error;
}

/** The revoke — upstream DeleteAccessToken (applications.go:167-174) over
 *  the landed owner-scoped `TokenService.revoke`. A miss answers "missing"
 *  (the stale-form arm — the module header's silent-303 note). */
export async function revokeTokenFromForm(d1: D1Database, userId: number, id: number): Promise<RevokeTokenOutcome> {
  return (await new TokenService(d1).revoke(userId, id)) ? "deleted" : "missing";
}

// ---------------------------------------------------------------------------
// The render (templates/user/settings/applications.tmpl +
// shared/user/access_tokens.tmpl at the pin)
// ---------------------------------------------------------------------------

/** Upstream `DateUtils.AbsoluteShort` ("Jan 2, 2006") — UTC, hand-rolled
 *  (the milestones.tsx formatDueDate precedent). */
export function formatTokenDate(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** The item-leading token glyph. Upstream renders
 *  `{{svg "fontawesome-send" 32}}`; fontawesome-send is outside the
 *  generated icon allowlist — octicon-mail is the documented stand-in (the
 *  feeds-glyph convention; a later allowlist extension swaps it per this
 *  one-line site). */
const TOKEN_ICON: IconName = "octicon-mail";

/** The full-document render (the render.tsx pattern). `error` carries the
 *  failed create's message (null otherwise). */
export function renderUserSettingsApplicationsPage(
  ctx: UiContext,
  data: UserSettingsApplicationsPageData,
  error: string | null = null,
): string {
  return renderPage(<UserSettingsApplicationsPage ctx={ctx} data={data} error={error} />);
}

/** The applications page (§2.4.1 discriminator: `user settings applications`
 *  — layout_head's pageClass). */
export function UserSettingsApplicationsPage(props: { ctx: UiContext; data: UserSettingsApplicationsPageData; error: string | null }) {
  const { ctx, data } = props;
  return (
    <BaseLayout ctx={ctx} title={userSettingsApplicationsLocale.applications} pageClass="user settings applications">
      <div class="ui container flex-container">
        <UserSettingsNavbar active="applications" />
        <div class="user-setting-content">
          <div id="access-token-panel">
            <h4 class="ui top attached header">{userSettingsApplicationsLocale.manage_access_token}</h4>
            <div class="ui attached segment">
              {data.newToken !== null ? (
                <div class="ui positive message">
                  <div class="flex-text-block tw-justify-center">
                    <span>{userSettingsApplicationsLocale.generate_token_success}</span>
                    {/* The copy button (data-clipboard-target) is the
                        bundle's clipboard JS — the no-JS shape renders the
                        bare code element (the module header). */}
                    <code id="new-access-token-value">{data.newToken}</code>
                  </div>
                </div>
              ) : null}
              <div class="flex-divided-list items-with-main">
                <div class="item">{userSettingsApplicationsLocale.tokens_desc}</div>
                {data.tokens.map((item) => (
                  <div class="item" key={item.token.id}>
                    <div class="item-leading">
                      <span
                        class={item.hasRecentActivity ? "tw-text-green" : undefined}
                        data-tooltip-content={item.hasRecentActivity ? userSettingsApplicationsLocale.token_state_desc : undefined}
                      >
                        <Icon name={TOKEN_ICON} size={32} />
                      </span>
                    </div>
                    <div class="item-main">
                      <details>
                        <summary>
                          <span class="item-title">{item.token.name}</span>
                        </summary>
                        <p class="tw-my-1">
                          {userSettingsApplicationsLocale.repo_and_org_access}
                          {": "}
                          {item.publicOnly
                            ? userSettingsApplicationsLocale.permissions_public_only
                            : userSettingsApplicationsLocale.permissions_access_all}
                        </p>
                        <p class="tw-my-1">{userSettingsApplicationsLocale.permissions_list}</p>
                        <ul class="tw-my-1">
                          {item.scopes.map((scope) => (
                            <li key={scope}>{scope}</li>
                          ))}
                        </ul>
                      </details>
                      <div class="item-body">
                        <i>
                          {userSettingsApplicationsLocale.added_on} {formatTokenDate(item.token.createdAt)} — <Icon name="octicon-info" />
                          {item.hasUsed && item.token.lastUsedAt !== null ? (
                            <>
                              {` ${userSettingsApplicationsLocale.last_used} `}
                              <span class={item.hasRecentActivity ? "tw-text-green" : undefined}>
                                {formatTokenDate(item.token.lastUsedAt)}
                              </span>
                            </>
                          ) : (
                            ` ${userSettingsApplicationsLocale.no_activity}`
                          )}
                        </i>
                      </div>
                    </div>
                    <div class="item-trailing">
                      {/* No Regenerate button: the op has no landed analog
                          (the module header). */}
                      <form method="post" action="/user/settings/applications/delete">
                        <input type="hidden" name="id" value={String(item.token.id)} />
                        <button type="submit" class="ui red tiny button">
                          <Icon name="octicon-trash" />
                          {` ${userSettingsApplicationsLocale.delete_token}`}
                        </button>
                      </form>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div class="ui bottom attached segment">
              {/* access_tokens.tmpl:67 — open when no tokens exist. */}
              <details open={data.tokens.length === 0}>
                <summary>
                  <h4 class="ui header tw-inline-block tw-my-2">{userSettingsApplicationsLocale.generate_new_token}</h4>
                </summary>
                <form class="ui form" action="/user/settings/applications" method="post">
                  {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
                  <div class="field">
                    <label for="name">{userSettingsApplicationsLocale.token_name}</label>
                    <input id="name" name="name" required maxlength={255} value={data.form.name} />
                  </div>
                  <div class="field">
                    <div class="tw-my-2">{userSettingsApplicationsLocale.repo_and_org_access}</div>
                    <label class="gt-checkbox">
                      <input type="radio" name="scope-public-only" value="public-only" />{" "}
                      {userSettingsApplicationsLocale.permissions_public_only}
                    </label>
                    <label class="gt-checkbox">
                      <input type="radio" name="scope-public-only" value="" checked />{" "}
                      {userSettingsApplicationsLocale.permissions_access_all}
                    </label>
                  </div>
                  <div>
                    <div class="tw-my-2">
                      {userSettingsApplicationsLocale.access_token_desc_lead}{" "}
                      <a href="/api/swagger" target="_blank">
                        {userSettingsApplicationsLocale.access_token_desc_api}
                      </a>{" "}
                      {userSettingsApplicationsLocale.access_token_desc_middle}{" "}
                      <a href="https://docs.gitea.com/development/oauth2-provider#scopes" target="_blank">
                        {userSettingsApplicationsLocale.access_token_desc_docs}
                      </a>{" "}
                      {userSettingsApplicationsLocale.access_token_desc_tail}
                    </div>
                    <table class="ui table unstackable tw-my-2">
                      {data.scopeCategories.map((category) => (
                        <tr key={category}>
                          <td>{category}</td>
                          <td>
                            <label class="gt-checkbox">
                              <input type="radio" name={`scope-${category}`} value="" checked />{" "}
                              {userSettingsApplicationsLocale.permission_no_access}
                            </label>
                          </td>
                          <td>
                            <label class="gt-checkbox">
                              <input type="radio" name={`scope-${category}`} value={`read:${category}`} />{" "}
                              {userSettingsApplicationsLocale.permission_read}
                            </label>
                          </td>
                          <td>
                            <label class="gt-checkbox">
                              <input type="radio" name={`scope-${category}`} value={`write:${category}`} />{" "}
                              {userSettingsApplicationsLocale.permission_write}
                            </label>
                          </td>
                        </tr>
                      ))}
                    </table>
                  </div>
                  <button type="submit" class="ui primary button">
                    {userSettingsApplicationsLocale.generate_token}
                  </button>
                </form>
              </details>
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
