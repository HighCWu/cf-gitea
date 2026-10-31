/**
 * The user settings APPLICATIONS tab, `/user/settings/applications` — pages
 * wave 54 (bench row `wave-settings-keys-tags`, MOUNTED at 0c2b151 — the
 * route lives in `index.ts`; the SSH/GPG keys twin is pages/user-settings-keys.tsx).
 *
 * ## Mount record (MOUNTED at 0c2b151 — the wiring HANDOFF is retired)
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
 * ## W5 (2026-10-31) — the OAuth2 halves (specs/oauth2-provider.md §2.8, §6
 * W5; the deferral note below RETIRES with this record)
 *
 * applications.tmpl:5-8 renders, gated on `.EnableOAuth2` (the landed
 * `oauth2FeatureEnabled` — OAUTH2_ENABLED's strict polarity), two sections
 * after the PAT panel, and this module now carries both:
 *
 *   - **grants_oauth2** (templates/user/settings/grants_oauth2.tmpl): the
 *     user's authorized OAuth2 grants — the W1 grants store's
 *     `listGrantsByUserID` (the INNER-JOINed application per grant) — each
 *     row the application name + the Added-on date + the Revoke button.
 *     Upstream's revoke POSTs `/user/settings/applications/oauth2/
 *     {ApplicationID}/revoke/{GrantID}` (grants_oauth2.tmpl:22; web.go:688
 *     RevokeOAuth2Grant); the handler 404-shells a missing/foreign grant
 *     (oauth2_common.go:196-207 — grants belong to individual users; the
 *     org/admin twins refuse) and 303s home on success. NO empty-list arm:
 *     the description line always renders (upstream-exact; the org/admin
 *     pages' "No applications yet" line is THEIR store's convention, the
 *     grants template has none).
 *   - **applications_oauth2** (applications_oauth2.tmpl + _list.tmpl): the
 *     user's OAuth2 applications — the landed CRUD service's
 *     `listOAuth2Applications(d1, doer.id, …)` (uid-scoped, id DESC) — each
 *     row the glyph + name + Client ID label + the Edit link (the shared
 *     edit page, pages/oauth2-app-edit.tsx — the OAuth2CommonHandlers
 *     module) + the Remove form (`POST .../oauth2/{id}/delete`). The bottom
 *     segment is the create form (`POST /user/settings/applications/oauth2`);
 *     the details' open arm is upstream-exact (`{{if .application_name}}` —
 *     the kept submitted name only, applications_oauth2_list.tmpl:51). The
 *     create ANSWER is upstream's AddApp shape: the shared edit page
 *     rendered with the plaintext client secret (oauth2_common.go:79-87);
 *     the bind-error arm re-renders THIS page with the negative line + the
 *     kept submission (upstream flashes + redirects to the list — the
 *     no-flash posture).
 *
 * The builtin lock arm (applications_oauth2_list.tmpl:18-21) renders never
 * on THIS page: the builtin rows are uid=0 and the list is uid-scoped to the
 * doer (upstream doesn't pass BuiltinApplications here either — only the
 * admin Applications handler does, applications.go:182-204 has no such key).
 * The list rows' secret stays blank (app.go's hide-on-list arm — the landed
 * toApiOAuth2Application's "" arg); the plaintext exists only on the edit
 * page after create/regenerate (the secret-shown-once posture, the shared
 * module's header).
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - The OAuth2 halves of applications.tmpl (grants_oauth2 + applications_
 *   oauth2, gated on .EnableOAuth2) are UNRENDERED: the landed OAuth2 store
 *   is API-only (routes/oauth2-apps.ts) with no web UI surface — this brief
 *   pins the PAT panel (access_tokens.tmpl). [RETIRED W5 — the halves render
 *   above; the original note is kept for the wave trail.]
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
import { listOAuth2Applications, toApiOAuth2Application, type OAuth2AppRow } from "../../api/services/oauth2-apps";
import { listGrantsByUserID, type OAuth2GrantRow, type OAuth2ApplicationRow } from "../../services/oauth2/grants";
import type { OAuth2AppEditForm } from "./oauth2-app-edit";
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

  // --- the W5 OAuth2 halves (grants_oauth2.tmpl + applications_oauth2*.tmpl
  //     at the pin; en-US values) ---
  /** "settings.authorized_oauth2_applications" — the grants section's h4. */
  authorized_oauth2_applications: "Authorized OAuth2 Applications",
  /** "settings.authorized_oauth2_applications_description" — the grants
   *  section's lead line. */
  authorized_oauth2_applications_description:
    "You have granted access to your personal Gitea account to these third-party applications. Please revoke access for applications you no longer need.",
  /** "settings.revoke_key" — the grants row's button (grants_oauth2.tmpl:23). */
  revoke_key: "Revoke",
  /** "settings.revoke_oauth2_grant_description" — the revoke confirm-dialog
   *  reduction's aria label (grants_oauth2.tmpl:36). */
  revoke_oauth2_grant_description:
    "Revoking access for this third-party application will prevent this application from accessing your data. Are you sure?",
  /** "settings.manage_oauth2_applications" — the applications section's h4
   *  (applications_oauth2.tmpl:2). */
  manage_oauth2_applications: "Manage OAuth2 Applications",
  /** "settings.oauth2_application_create_description" — the list's first
   *  item (applications_oauth2_list.tmpl:4). */
  oauth2_application_create_description:
    "OAuth2 applications give your third-party application access to user accounts on this instance.",
  /** "settings.oauth2_client_id" — the row body's label (_list.tmpl:14). */
  oauth2_client_id: "Client ID",
  /** "settings.oauth2_application_edit" — the Edit link (_list.tmpl:25). */
  oauth2_application_edit: "Edit",
  /** "remove" — the Remove button (_list.tmpl:30). */
  remove: "Remove",
  /** "settings.oauth2_application_remove_description" — the confirm-dialog
   *  reduction's aria label (the org/admin twins' convention). */
  oauth2_application_remove_description:
    "Removing an OAuth2 application will prevent it from accessing authorized user accounts on this instance. Continue?",
  /** "settings.create_oauth2_application" — the create details' summary
   *  (_list.tmpl:52). */
  create_oauth2_application: "Create a new OAuth2 Application",
  /** "settings.oauth2_application_name" (_list.tmpl:55). */
  oauth2_application_name: "Application Name",
  /** "settings.oauth2_redirect_uris" (_list.tmpl:59). */
  oauth2_redirect_uris: "Redirect URIs. Please use a new line for every URI.",
  /** "settings.oauth2_confidential_client" (_list.tmpl:64). */
  oauth2_confidential_client:
    "Confidential Client. Select for apps that keep the secret confidential, such as web apps. Do not select for native apps, including desktop and mobile apps.",
  /** "settings.oauth2_skip_secondary_authorization" (_list.tmpl:70) — the
   *  <strong> tail stripped. */
  oauth2_skip_secondary_authorization: "Skip authorization for public clients after granting access once. May pose a security risk.",
  /** "settings.create_oauth2_application_button" (_list.tmpl:75). */
  create_oauth2_application_button: "Create Application",
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
 *  exactly once (the create POST's full-page re-render). The W5 tail is the
 *  OAuth2 half: `oauth2Enabled` gates the two sections
 *  (applications.tmpl:5), `apps`/`grants` are the uid-scoped reads, and
 *  `oauth2Form`/`oauth2Error` re-render a failed oauth2 create (the kept
 *  submission + the negative line — "" / null on the plain GET). */
export interface UserSettingsApplicationsPageData {
  tokens: TokenListItem[];
  scopeCategories: string[];
  form: { name: string };
  newToken: string | null;
  oauth2Enabled: boolean;
  apps: OAuth2AppRow[];
  grants: { grant: OAuth2GrantRow; application: OAuth2ApplicationRow }[];
  oauth2Form: OAuth2AppEditForm;
  oauth2Error: string | null;
}

/**
 * The page load — `now` is the HasRecentActivity clock (fixed-clock tests,
 *  the milestones loader pattern). `oauth2Enabled` (default true) is the
 *  landed gate read the mounted handler passes
 *  (`oauth2FeatureEnabled(c.env)`) — false skips the OAuth2 reads entirely
 *  (upstream's loadApplicationsData reads Applications/Grants only when
 *  setting.OAuth2.Enabled, applications.go:189-203).
 */
export async function loadUserSettingsApplicationsPageData(
  d1: D1Database,
  userId: number,
  isAdmin: boolean,
  now: Date = new Date(),
  oauth2Enabled = true,
): Promise<UserSettingsApplicationsPageData> {
  const service = new TokenService(d1);
  const page = await service.list(userId, 1, TOKENS_LIST_LIMIT);
  // The web panel is the unpaginated upstream list at the render bound (the
  // org/admin twins' loop convention — one bounded service page here, the
  // 500-row cap).
  const apps = oauth2Enabled ? (await listOAuth2Applications(d1, userId, 1, TOKENS_LIST_LIMIT)).rows : [];
  const grants = oauth2Enabled ? await listGrantsByUserID(d1, userId) : [];
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
    oauth2Enabled,
    apps,
    grants,
    oauth2Form: { name: "", redirectUrisRaw: "", confidentialClient: true, skipSecondaryAuthorization: false },
    oauth2Error: null,
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

/** The oauth2 application row's leading glyph — upstream renders
 *  `{{svg "octicon-apps" 32}}` (applications_oauth2_list.tmpl:9); octicon-apps
 *  is outside the generated icon allowlist — octicon-package is the
 *  documented stand-in (the org twin's exact convention, its module header). */
const OAUTH2_APP_ICON: IconName = "octicon-package";

/** The grants row's leading glyph — upstream renders `{{svg "octicon-key"
 *  32}}` (grants_oauth2.tmpl:12); octicon-key is outside the allowlist —
 *  octicon-shield-lock is the documented stand-in (the authorization
 *  semantic's nearest glyph, the feeds-glyph convention). */
const GRANT_ICON: IconName = "octicon-shield-lock";

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
          {data.oauth2Enabled ? (
            <>
              {/* applications.tmpl:6 — the grants_oauth2 section. NO
                  empty-list arm: the description line always renders
                  (upstream-exact — the template has no range-else). */}
              <h4 class="ui top attached header">{userSettingsApplicationsLocale.authorized_oauth2_applications}</h4>
              <div class="ui attached segment">
                <div class="flex-divided-list items-with-main">
                  <div class="item">{userSettingsApplicationsLocale.authorized_oauth2_applications_description}</div>
                  {data.grants.map(({ grant, application }) => (
                    <div class="item" key={grant.id}>
                      <div class="item-leading">
                        {/* {{svg "octicon-key" 32}} — outside the allowlist;
                            octicon-shield-lock is the documented stand-in. */}
                        <Icon name={GRANT_ICON} size={32} />
                      </div>
                      <div class="item-main">
                        <div class="item-title">{application.name}</div>
                        <div class="item-body">
                          <i>
                            {userSettingsApplicationsLocale.added_on} {formatTokenDate(grant.createdAt)}
                          </i>
                        </div>
                      </div>
                      <div class="item-trailing">
                        {/* grants_oauth2.tmpl:21-24 — the revoke button; the
                            confirm dialog reduces to the plain form POST (the
                            hooks-list reduction; the description text is the
                            aria label). The {application.id} URL segment is
                            upstream's data-url shape — the handler keys on
                            the grant id alone (oauth2_common.go:196-207). */}
                        <form
                          method="post"
                          action={`/user/settings/applications/oauth2/${application.id}/revoke/${grant.id}`}
                          class="tw-inline"
                        >
                          <button
                            type="submit"
                            class="ui red tiny button link-action"
                            aria-label={userSettingsApplicationsLocale.revoke_oauth2_grant_description}
                          >
                            {userSettingsApplicationsLocale.revoke_key}
                          </button>
                        </form>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              {/* applications.tmpl:7 — the applications_oauth2 section
                  (applications_oauth2.tmpl + _list.tmpl). */}
              <h4 class="ui top attached header">{userSettingsApplicationsLocale.manage_oauth2_applications}</h4>
              <div class="ui attached segment">
                <div class="flex-divided-list items-with-main">
                  <div class="item">{userSettingsApplicationsLocale.oauth2_application_create_description}</div>
                  {data.apps.map((app) => {
                    // toApiOAuth2Application is the render's client-id
                    // projection; the secret arg is the list's "" blank
                    // (app.go's hide-on-list arm). The builtin lock arm
                    // renders never here — the rows are uid-scoped to the
                    // doer and the builtins are uid=0 (the module header).
                    const view = toApiOAuth2Application(app, "");
                    return (
                      <div class="item tw-items-center" key={app.id}>
                        <div class="item-leading">
                          {/* {{svg "octicon-apps" 32}} — outside the
                              allowlist; octicon-package is the documented
                              stand-in (the org twin's convention). */}
                          <Icon name={OAUTH2_APP_ICON} size={32} />
                        </div>
                        <div class="item-main">
                          <div class="item-title">{view.name}</div>
                          <div class="item-body">
                            {userSettingsApplicationsLocale.oauth2_client_id}
                            <span class="ui label"> {view.client_id}</span>
                          </div>
                        </div>
                        <div class="item-trailing">
                          <a href={`/user/settings/applications/oauth2/${app.id}`} class="ui primary tiny button">
                            <Icon name="octicon-pencil" />
                            {` ${userSettingsApplicationsLocale.oauth2_application_edit}`}
                          </a>
                          <form
                            method="post"
                            action={`/user/settings/applications/oauth2/${app.id}/delete`}
                            class="tw-inline"
                          >
                            <button
                              type="submit"
                              class="ui red tiny button link-action"
                              aria-label={userSettingsApplicationsLocale.oauth2_application_remove_description}
                            >
                              <Icon name="octicon-trash" />
                              {` ${userSettingsApplicationsLocale.remove}`}
                            </button>
                          </form>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              {/* _list.tmpl:50-79 — the create segment. The details' open arm
                  is the kept submitted name (the upstream `{{if
                  .application_name}}` intent — the flash-redirect never
                  carries it upstream, the no-flash re-render does here). */}
              <div class="ui bottom attached segment">
                <details open={data.oauth2Error !== null || data.oauth2Form.name !== "" ? true : undefined}>
                  <summary>
                    <h4 class="ui header tw-inline-block tw-my-2">{userSettingsApplicationsLocale.create_oauth2_application}</h4>
                  </summary>
                  <form class="ui form ignore-dirty" action="/user/settings/applications/oauth2" method="post">
                    {data.oauth2Error !== null ? <div class="ui negative message">{data.oauth2Error}</div> : null}
                    <div class="field">
                      <label for="application-name">{userSettingsApplicationsLocale.oauth2_application_name}</label>
                      <input
                        id="application-name"
                        name="application_name"
                        value={data.oauth2Form.name}
                        required
                        maxlength={255}
                      />
                    </div>
                    <div class="field">
                      <label for="redirect-uris">{userSettingsApplicationsLocale.oauth2_redirect_uris}</label>
                      <textarea name="redirect_uris" id="redirect-uris">
                        {data.oauth2Form.redirectUrisRaw}
                      </textarea>
                    </div>
                    <div class="field">
                      <div class="ui checkbox">
                        <label>{userSettingsApplicationsLocale.oauth2_confidential_client}</label>
                        <input
                          type="checkbox"
                          name="confidential_client"
                          checked={data.oauth2Form.confidentialClient ? true : undefined}
                        />
                      </div>
                    </div>
                    <div class="field">
                      <div class="ui checkbox">
                        <label>{userSettingsApplicationsLocale.oauth2_skip_secondary_authorization}</label>
                        <input
                          type="checkbox"
                          name="skip_secondary_authorization"
                          checked={data.oauth2Form.skipSecondaryAuthorization ? true : undefined}
                        />
                      </div>
                    </div>
                    <button type="submit" class="ui primary button">
                      {userSettingsApplicationsLocale.create_oauth2_application_button}
                    </button>
                  </form>
                </details>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </BaseLayout>
  );
}
