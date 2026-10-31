/**
 * The ADMIN AUTHS pages — `/-/admin/auths` (list), `/-/admin/auths/new`,
 * `/-/admin/auths/{id}` (edit), `POST /-/admin/auths/{id}/delete` — the
 * EXTERNAL AUTH W4 arm of specs/external-auth-sources.md §6: upstream's
 * `web.go:874-880` group (`admin.Authentications`, `NewAuthSource[Post]`,
 * `EditAuthSource[Post]`, `DeleteAuthSource` — routers/web/admin/auths.go)
 * reduced to the OAuth2-only v1 surface (SPEC §2.3's lattice: LDAP/SMTP/
 * PAM/SSPI are deferred-or-impossible, so the type picker offers OAuth2
 * only), served over the W1 store (services/auth-sources/store.ts) and the
 * cfg codec (services/auth-sources/cfg.ts).
 *
 * ## Mount recipe (the orchestrator's registration window — SPEC §9 W4)
 *
 * This module ships the load/render/parse/apply seams; the route table
 * hunks ride the shared-file window exactly like the admin-users mount
 * (2f7afe9's record). FOUR families in ui/index.ts's AdminRoute union:
 *
 *   | "admin-auths"          // GET    /-/admin/auths
 *   | "admin-auths-new"     // GET+POST /-/admin/auths/new
 *   | "admin-auths-edit"    // GET+POST /-/admin/auths/{authid}
 *   | "admin-auths-delete"  // POST   /-/admin/auths/{authid}/delete
 *
 * with `authId?: number` (positive integers only — the application-delete
 * posture, web.go's PathParamInt64: `/^\d+$/` digits-only claims, junk
 * segments stay unclaimed → the engine's 404). Parse claims in the admin
 * block, beside the applications arm (web.go:874-880's group order):
 *
 *   if (tail.length === 1 && tail[0] === "auths") return { family: "admin-auths" };
 *   if (tail.length === 2 && tail[0] === "auths" && tail[1] === "new")
 *     return { family: "admin-auths-new" };
 *   if (tail.length === 2 && tail[0] === "auths" && /^\d+$/.test(tail[1]))
 *     return { family: "admin-auths-edit", authId: Number.parseInt(tail[1], 10) };
 *   if (tail.length === 3 && tail[0] === "auths" && /^\d+$/.test(tail[1]) && tail[2] === "delete")
 *     return { family: "admin-auths-delete", authId: Number.parseInt(tail[1], 10) };
 *
 * Handlers (the badge-new ladder: guard-first on the POSTs, then the
 * shared adminPagePrologue):
 *
 *   GET  list:   prologue → loadAdminAuthsData → renderAdminAuthsPage
 *   GET  new:    prologue → renderAdminAuthSourceNewPage(ctx, { form: newAdminAuthSourceFormValues(), error: null, errorField: null })
 *   POST new:    sameOriginGuard → prologue → parseAdminAuthSourceForm →
 *                applyAdminAuthSourceCreate; "created" 303s /-/admin/auths
 *                (upstream Redirect, auths.go), the invalid arm re-renders
 *                the new page at 200 with the message + the Err_ field flag
 *                (RenderWithErr's posture, the badge-new reduction)
 *   GET  edit:   prologue → loadAdminAuthSourceEditData (null ⇒ 404 shell)
 *                → renderAdminAuthSourceEditPage
 *   POST edit:   guard → prologue → parse → applyAdminAuthSourceUpdate;
 *                "saved" 303s /-/admin/auths/{id} (upstream's redirect),
 *                invalid re-renders the edit page at 200 with the posted
 *                values
 *   POST delete: guard → prologue → applyAdminAuthSourceDelete; "deleted"
 *                303s /-/admin/auths (upstream's JSONRedirect target, the
 *                plain-form reduction), "in-use" re-renders the edit page
 *                at 200 with the still_in_used message (upstream flashes +
 *                JSONRedirects to the edit page — the message must survive,
 *                and the notices re-render idiom is the house no-JS answer),
 *                "missing" 404-shells
 *
 *   uiRouter.get("/-/admin/auths", (c) => adminAuthsPage(c));
 *   uiRouter.get("/-/admin/auths/new", (c) => adminAuthsNewPage(c));
 *   uiRouter.post("/-/admin/auths/new", (c) => adminAuthsNewSubmit(c));
 *   uiRouter.get("/-/admin/auths/:authid{\\d+}", (c) => adminAuthsEditPage(c, ...));
 *   uiRouter.post("/-/admin/auths/:authid{\\d+}", (c) => adminAuthsEditSubmit(c, ...));
 *   uiRouter.post("/-/admin/auths/:authid{\\d+}/delete", (c) => adminAuthsDelete(c, ...));
 *   // the three POST-only shapes' GET twins answer methodNotAllowed("POST")
 *   // (the job_queue posture — chi's 405).
 *
 * ## Upstream surface at the pin (the render's cites)
 *
 * list.tmpl: the header `auth_manage_panel (total N)` + the Add button,
 * the seven columns ID/Name/Type/Enabled/Updated/Created/Edit — the SPEC
 * §6.1 row ADDS Provider + Users (the cfg's provider display name and the
 * in-use count per source), so the landed table carries nine and the
 * no-results colspan follows. Edit/new carry the tips block (the OAuth2
 * general tip + the callback URL + the provider tips) REDUCED to the three
 * executable providers (advising a gitlab/gitea/nextcloud OAuth app on an
 * instance where that provider cannot complete a login would be the
 * SPEC-0018 §3.3 posture-line class; the GMail/LDAP tips are per-type arms
 * of types this substrate never offers — omitted with them). The callback
 * URL tip: upstream's JS fills `<b id="oauth2-callback-url">` from the
 * typed name (web_src/features/admin/common.ts:267); the no-JS reduction
 * computes the same string server-side whenever the name is known (the
 * edit page, a failed re-render) and leaves the element empty on the fresh
 * new-form GET (upstream's pre-JS bytes).
 *
 * ## Field reductions (each recorded at its render site)
 *
 *   - clientSecret is WRITE-ONLY: the edit input renders type=password with
 *     an EMPTY value (SPEC §6.1/§7.7 — the secret never renders; upstream's
 *     OAuth2 arm shows it inline, the recorded divergence — upstream's own
 *     LDAP bind-password field is the type=password precedent), and an
 *     empty posted value keeps the stored secret on edit.
 *   - is_sync_enabled / skip_local_two_fa (TwoFactorPolicy) / the claim+
 *     sync field block render NOWHERE (SPEC §6.3 — the deferred fields are
 *     structurally absent; the is_sync_enabled checkbox is an inert lie
 *     until the sync engine lands — the column stays false, the store's
 *     CreateSource forcing ports source.go:225-228).
 *   - the per-provider field visibility upstream JS-manages (the Fomantic
 *     dropdown's onChange) renders statically with help text naming the
 *     owning provider: the codec REJECTS a discoveryUrl posted for a
 *     non-OIDC provider (cfg.ts's discovery-forbidden), so the strictness
 *     is the validator's, surfaced as the re-render message.
 *   - the four custom-URL fields prefill the REGISTRY defaults when no
 *     mapping is stored (upstream's hidden-input defaults, JS-filled on
 *     toggle — providers_custom.go:55-70's values, W1's GITHUB_URLS); the
 *     mapping posts only when `oauth2_use_custom_url` is checked, exactly
 *     upstream's parseOAuth2Config branch.
 *
 * The name field is slug-validated `[A-Za-z0-9._-]+` at ≤30 chars (SPEC
 * §6.3's URL-token rule over upstream's bare Required;MaxSize(30) — the
 * recorded divergence: upstream PathEscapes arbitrary names, ours keeps
 * the href/lookup/IdP-callback triple escape-free) with the upstream
 * alpha_dash_dot / max_size / require message shapes.
 */

import { AdminEmbeddedSvg, AdminFamilyShell, formatAdminDate, adminFamilyLocale } from "./admin-users";
import { Icon, renderPage } from "../shell";
import {
  OAuth2ConfigError,
  OAUTH2_PROVIDER_KEYS,
  parseOAuth2SourceConfig,
  serializeOAuth2SourceConfig,
  type CustomUrlMapping,
  type OAuth2SourceConfig,
} from "../../services/auth-sources/cfg";
import { getProviderDescriptor, listExecutableProviders } from "../../services/auth-sources/registry";
import {
  countLoginSourceUsers,
  findLoginSources,
  getLoginSource,
  LoginSourceInUseError,
  LoginSourceNameExistsError,
  LoginSourceNotExistError,
  LoginSourceType,
  createLoginSource,
  deleteLoginSource,
  updateLoginSource,
  type LoginSourceRow,
} from "../../services/auth-sources/store";
import type { UiContext } from "../ui-context";

// ---------------------------------------------------------------------------
// Page copy (upstream locale keys cited; en-US values at the pin)
// ---------------------------------------------------------------------------

export const adminAuthsLocale = {
  authentication: "Authentication Sources", // "admin.authentication" (the nav item + the list Title)
  auth_manage_panel: "Authentication Source Management", // "admin.auths.auth_manage_panel" (list.tmpl:4)
  total: "Total: %d", // "admin.total"
  new: "Add Authentication Source", // "admin.auths.new" (list.tmpl:5's button, new.tmpl:7's header + submit)
  edit: "Edit Authentication Source", // "admin.auths.edit" (edit.tmpl:4's header)
  update: "Update Authentication Source", // "admin.auths.update" (edit.tmpl:558's submit)
  col_id: "ID", // list.tmpl:87
  col_name: "Name", // "admin.auths.name" (list.tmpl:88)
  col_type: "Type", // "admin.auths.type" (list.tmpl:89)
  col_enabled: "Enabled", // "admin.auths.enabled" (list.tmpl:90)
  col_provider: "Provider", // SPEC §6.1's addition (the cfg provider's display name)
  col_users: "Users", // SPEC §6.1's addition (the in-use count)
  col_updated: "Updated", // "admin.auths.updated" (list.tmpl:91)
  col_created: "Created", // "admin.users.created" (list.tmpl:92)
  col_edit: "Edit", // "admin.users.edit" (list.tmpl:93)
  auth_type: "Authentication Type", // "admin.auths.auth_type" (new.tmpl:13)
  auth_name: "Authentication Name", // "admin.auths.auth_name" (new.tmpl:24)
  oauth2_provider: "OAuth2 Provider", // "admin.auths.oauth2_provider"
  oauth2_client_id: "Client ID (Key)", // "admin.auths.oauth2_clientID"
  oauth2_client_secret: "Client Secret", // "admin.auths.oauth2_clientSecret"
  oauth2_client_secret_edit_note:
    "Leave empty to keep the stored secret — the secret is never displayed after it is saved.",
  oauth2_icon_url: "Icon URL", // "admin.auths.oauth2_icon_url"
  oauth2_discovery_url: "OpenID Connect Auto Discovery URL", // "admin.auths.openIdConnectAutoDiscoveryURL"
  oauth2_external_id_claim: "External ID Claim Name (Optional)", // "admin.auths.open_id_connect_external_id_claim"
  oauth2_use_custom_url: "Use Custom URLs Instead of Default URLs", // "admin.auths.oauth2_use_custom_url"
  oauth2_auth_url: "Authorize URL", // "admin.auths.oauth2_authURL"
  oauth2_token_url: "Token URL", // "admin.auths.oauth2_tokenURL"
  oauth2_profile_url: "Profile URL", // "admin.auths.oauth2_profileURL"
  oauth2_email_url: "Email URL", // "admin.auths.oauth2_emailURL"
  oauth2_scopes: "Additional Scopes", // "admin.auths.oauth2_scopes"
  activated: "This Authentication Source is Activated", // "admin.auths.activated" (the checkbox label)
  sync_note:
    "OAuth2-only instance note: LDAP and SMTP authentication sources are not available on this deployment — only OAuth2 sources can be created.",
  tips: "Tips", // "admin.auths.tips"
  tips_oauth2_general: "OAuth2 Authentication", // "admin.auths.tips.oauth2.general"
  tips_oauth2_general_tip:
    "When registering a new OAuth2 authentication, the callback/redirect URL should be:", // "admin.auths.tips.oauth2.general.tip"
  tip_github: "Register a new OAuth application on https://github.com/settings/applications/new", // "admin.auths.tip.github"
  tip_google: "Obtain OAuth2 client credentials from the Google API console at https://console.developers.google.com/", // "admin.auths.tip.google_plus"
  tip_openid_connect:
    'Use the OpenID Connect Discovery URL "https://{server}/.well-known/openid-configuration" to specify the endpoints', // "admin.auths.tip.openid_connect"
  delete: "Delete Authentication Source", // "admin.auths.delete" (edit.tmpl:559's red button)
  delete_auth_desc:
    "Deleting an authentication source prevents users from using it to sign in. Continue?", // "admin.auths.delete_auth_desc" (the confirm-dialog reduction's inline text)
  // -- the error/flash message shapes (verbatim upstream en-US) ---------------
  login_source_exist: 'The authentication source "%s" already exists.', // "admin.auths.login_source_exist"
  invalid_discovery_url:
    "Invalid Auto Discovery URL (this must be a valid URL starting with http:// or https://)", // "admin.auths.invalid_openIdConnectAutoDiscoveryURL"
  still_in_used:
    "The authentication source is still in use. Convert or delete any users using this authentication source first.", // "admin.auths.still_in_used"
  new_success: "The authentication %s has been added.", // "admin.auths.new_success" (unused — the success arms redirect; kept for the message-shape record)
  update_success: "The authentication source has been updated.", // "admin.auths.update_success" (unused — same reduction)
  deletion_success: "The authentication source has been deleted.", // "admin.auths.deletion_success" (unused — same reduction)
  // -- the form.require_error / form.max_size_error / form.alpha_dash_dot_error
  //    shapes with the field label substituted ------------------------------
  name_required: "Authentication Name cannot be empty.", // form.require_error %s
  name_max_size: "Authentication Name must contain at most 30 characters.", // form.max_size_error
  name_alpha_dash_dot:
    "Authentication Name should contain only alphanumeric, dash ('-'), underscore ('_') and dot ('.') characters.", // form.alpha_dash_dot_error
  provider_required: "OAuth2 Provider cannot be empty.", // form.require_error %s
  client_id_required: "Client ID (Key) cannot be empty.", // form.require_error %s
  client_secret_required: "Client Secret cannot be empty.", // form.require_error %s
  // The cfg codec's remaining structural rejections (OAuth2ConfigError
  // codes without a dedicated upstream key — the codec's message is the
  // honest text; mapped in oauth2ConfigErrorMessage below).
  no_results: "No results found.", // "no_results_found" (list.tmpl's empty arm)
} as const;

/** auth.Names (models/auth/source.go:47-56) — the TypeName the list and
 *  the edit type row render. Only OAuth2 can persist in v1; the map keeps
 *  the pin's strings so a future type renders its own name. */
const AUTH_TYPE_NAMES: Record<number, string> = {
  [LoginSourceType.LDAP]: "LDAP (via BindDN)",
  [LoginSourceType.DLDAP]: "LDAP (simple auth)",
  [LoginSourceType.SMTP]: "SMTP",
  [LoginSourceType.PAM]: "PAM",
  [LoginSourceType.OAuth2]: "OAuth2",
  [LoginSourceType.SSPI]: "SPNEGO with SSPI",
};

/** Upstream `Source.TypeName` (the Go map lookup — an unknown type renders
 *  the zero string). */
export function authSourceTypeName(type: number): string {
  return AUTH_TYPE_NAMES[type] ?? "";
}

// ---------------------------------------------------------------------------
// The form values + wire parse (the AuthenticationForm reduction)
// ---------------------------------------------------------------------------

/** The posted form's shape — upstream AuthenticationForm's OAuth2 arm
 *  (services/forms/auth_form.go:12-75) reduced to the v1 field set (the
 *  module header's reductions). `clientSecret` is write-only (empty posted
 *  on edit = keep the stored secret). */
export interface AdminAuthSourceFormValues {
  /** The hidden `type` wire field (new.tmpl:15's `name="type"`; always 6). */
  type: number;
  name: string;
  /** The goth registry key. */
  provider: string;
  clientId: string;
  clientSecret: string;
  isActive: boolean;
  discoveryUrl: string;
  externalIdClaim: string;
  useCustomUrl: boolean;
  authUrl: string;
  tokenUrl: string;
  profileUrl: string;
  emailUrl: string;
  /** The raw comma-separated field (upstream Oauth2Scopes). */
  scopes: string;
  iconUrl: string;
}

/** The fresh new-form values: upstream NewAuthSource's defaults
 *  (auths.go:74-97) — is_active CHECKED, the provider default the first
 *  key-sorted executable entry (the listExecutableProviders order,
 *  providers.go:148-150). */
export function newAdminAuthSourceFormValues(): AdminAuthSourceFormValues {
  const firstProvider = listExecutableProviders()[0];
  return {
    type: LoginSourceType.OAuth2,
    name: "",
    provider: firstProvider?.key ?? "openidConnect",
    clientId: "",
    clientSecret: "",
    isActive: true,
    discoveryUrl: "",
    externalIdClaim: "",
    useCustomUrl: false,
    authUrl: "",
    tokenUrl: "",
    profileUrl: "",
    emailUrl: "",
    scopes: "",
    iconUrl: "",
  };
}

/** The checkbox presence rule (upstream's web binding: a checked checkbox
 *  posts "on", an unchecked one is absent). */
function checkbox(form: URLSearchParams, name: string): boolean {
  return form.get(name) !== null;
}

/** The POST body parse — the upstream field names verbatim (new.tmpl /
 *  oauth.tmpl's `name=` attributes), so the wire is the pin's shape. */
export function parseAdminAuthSourceForm(form: URLSearchParams): AdminAuthSourceFormValues {
  const pick = (name: string): string => form.get(name) ?? "";
  return {
    type: LoginSourceType.OAuth2, // the hidden field's only legal value in v1 (Range(2,7) upstream; the parse pins 6)
    name: pick("name"),
    provider: pick("oauth2_provider"),
    clientId: pick("oauth2_key"),
    clientSecret: pick("oauth2_secret"),
    isActive: checkbox(form, "is_active"),
    discoveryUrl: pick("open_id_connect_auto_discovery_url"),
    externalIdClaim: pick("open_id_connect_external_id_claim"),
    useCustomUrl: checkbox(form, "oauth2_use_custom_url"),
    authUrl: pick("oauth2_auth_url"),
    tokenUrl: pick("oauth2_token_url"),
    profileUrl: pick("oauth2_profile_url"),
    emailUrl: pick("oauth2_email_url"),
    scopes: pick("oauth2_scopes"),
    iconUrl: pick("oauth2_icon_url"),
  };
}

/** The fields the re-render can flag (upstream's Err_Name / Err_DiscoveryURL
 *  data arms). */
export type AdminAuthSourceField = "name" | "provider" | "clientId" | "clientSecret" | "discoveryUrl" | "cfg";

/** The slug rule (SPEC §6.3 — the URL token's charset; upstream's own
 *  separatorAntiPattern complement `[\w-\.]`). */
const NAME_SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;

/** Upstream AuthenticationForm.Name `binding:"Required;MaxSize(30)"`. */
const NAME_MAX_SIZE = 30;

/** The comma-separated scopes split (upstream parseOAuth2Config's
 *  strings.SplitSeq + TrimSpace + the empty drop, auths.go:206-213). */
function parseScopesField(raw: string): string[] {
  const scopes: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed !== "") scopes.push(trimmed);
  }
  return scopes;
}

/** Assemble + VALIDATE the cfg record (the codec's serialize runs the same
 *  validator — cfg.ts's validate-before-persist; SPEC §5.1/§6.2). Throws
 *  OAuth2ConfigError; the caller maps codes to the re-render message. */
function buildCfg(values: AdminAuthSourceFormValues, existingSecret: string | null): string {
  // The write-only secret: an empty posted value on EDIT keeps the stored
  // one (the module header's reduction); on CREATE an empty secret is the
  // codec's clientSecret-required rejection.
  const clientSecret = values.clientSecret !== "" ? values.clientSecret : (existingSecret ?? "");
  let customUrlMapping: CustomUrlMapping | undefined;
  if (values.provider === "github" && values.useCustomUrl) {
    // Empty entries drop in the codec (urlmapping.go:60-74's OverrideWith
    // arm); a mapping that normalizes to nothing stays absent.
    customUrlMapping = {
      ...(values.authUrl !== "" ? { authUrl: values.authUrl } : {}),
      ...(values.tokenUrl !== "" ? { tokenUrl: values.tokenUrl } : {}),
      ...(values.profileUrl !== "" ? { profileUrl: values.profileUrl } : {}),
      ...(values.emailUrl !== "" ? { emailUrl: values.emailUrl } : {}),
    };
  }
  const scopes = parseScopesField(values.scopes);
  return serializeOAuth2SourceConfig({
    v: 1,
    // Safe: both write arms run validateAdminAuthSourceForm (the registry
    // membership check) before this call; serialize re-validates anyway.
    provider: values.provider as (typeof OAUTH2_PROVIDER_KEYS)[number],
    clientId: values.clientId,
    clientSecret,
    ...(values.provider === "openidConnect" && values.discoveryUrl !== "" ? { discoveryUrl: values.discoveryUrl } : {}),
    ...(values.provider === "openidConnect" && values.externalIdClaim !== ""
      ? { externalIdClaim: values.externalIdClaim }
      : {}),
    ...(customUrlMapping !== undefined ? { customUrlMapping } : {}),
    ...(values.iconUrl !== "" ? { iconUrl: values.iconUrl } : {}),
    ...(scopes.length > 0 ? { scopes } : {}),
  });
}

/** Map a codec rejection onto the re-render message + flagged field (the
 *  Err_* data arms). The dedicated upstream messages where they exist; the
 *  codec's own text for the structural rules upstream's JS-form would have
 *  prevented. */
function oauth2ConfigErrorMessage(error: OAuth2ConfigError): { message: string; field: AdminAuthSourceField } {
  switch (error.code) {
    case "discovery-required":
      return {
        message: `${adminAuthsLocale.oauth2_discovery_url} is required for the OpenID Connect provider.`,
        field: "discoveryUrl",
      };
    case "discovery-forbidden":
      return { message: adminAuthsLocale.invalid_discovery_url, field: "discoveryUrl" };
    case "claim-forbidden":
    case "claim-invalid":
      return { message: `${adminAuthsLocale.oauth2_external_id_claim}: ${error.message}`, field: "cfg" };
    case "urls-forbidden":
    case "urls-invalid":
      return { message: `${adminAuthsLocale.oauth2_use_custom_url}: ${error.message}`, field: "cfg" };
    case "provider-invalid":
      return { message: adminAuthsLocale.provider_required, field: "provider" };
    case "clientSecret-required":
      return { message: adminAuthsLocale.client_secret_required, field: "clientSecret" };
    default:
      return { message: error.message, field: "cfg" };
  }
}

// ---------------------------------------------------------------------------
// The write seams (the upstream handler ladders, store + codec beneath)
// ---------------------------------------------------------------------------

export type AdminAuthSourceWriteOutcome =
  | { outcome: "created"; name: string }
  | { outcome: "saved"; id: number }
  | { outcome: "invalid"; message: string; field: AdminAuthSourceField | null; form: AdminAuthSourceFormValues };

/** The form-layer validation + cfg assembly + the store create — upstream
 *  NewAuthSourcePost (auths.go:238-341) reduced to the OAuth2 arm, the
 *  register/rollback dance collapsed to this validate-before-persist (SPEC
 *  §5.1). The field checks run in upstream's order: name (require/size/
 *  slug), provider, client id/secret, the discovery-URL SCHEME check
 *  (auths.go:272-278's form-layer arm — the LIVE discovery probe rides the
 *  W2 client seam's landing; the create arm's ErrOpenIDConnectInitialize
 *  branch is the recorded handoff), then the codec. */
export async function applyAdminAuthSourceCreate(d1: D1Database, values: AdminAuthSourceFormValues): Promise<AdminAuthSourceWriteOutcome> {
  const invalid = validateAdminAuthSourceForm(values, { requireSecret: true });
  if (invalid !== null) return { outcome: "invalid", ...invalid, form: values };
  let cfg: string;
  try {
    cfg = buildCfg(values, null);
  } catch (error) {
    if (error instanceof OAuth2ConfigError) {
      const mapped = oauth2ConfigErrorMessage(error);
      return { outcome: "invalid", message: mapped.message, field: mapped.field, form: values };
    }
    throw error;
  }
  try {
    const row = await createLoginSource(d1, {
      type: LoginSourceType.OAuth2,
      name: values.name,
      isActive: values.isActive,
      cfg,
    });
    return { outcome: "created", name: row.name };
  } catch (error) {
    if (error instanceof LoginSourceNameExistsError) {
      return {
        outcome: "invalid",
        message: adminAuthsLocale.login_source_exist.replace("%s", error.sourceName),
        field: "name",
        form: values,
      };
    }
    throw error;
  }
}

/** EditAuthSourcePost (auths.go:349-456) reduced the same way. The
 *  write-only secret: an empty posted clientSecret keeps the stored cfg's
 *  secret (buildCfg's existingSecret arm). */
export async function applyAdminAuthSourceUpdate(d1: D1Database, id: number, values: AdminAuthSourceFormValues): Promise<AdminAuthSourceWriteOutcome> {
  const current = await getLoginSource(d1, id);
  if (current === null) {
    return { outcome: "invalid", message: `login source does not exist [id: ${id}]`, field: null, form: values };
  }
  const invalid = validateAdminAuthSourceForm(values, { requireSecret: false });
  if (invalid !== null) return { outcome: "invalid", ...invalid, form: values };
  let existingSecret: string | null = null;
  if (current.type === LoginSourceType.OAuth2) {
    try {
      existingSecret = parseOAuth2SourceConfig(current.cfg).clientSecret;
    } catch {
      existingSecret = null; // a dead stored cfg — the posted value (if any) replaces it whole
    }
  }
  let cfg: string;
  try {
    cfg = buildCfg(values, existingSecret);
  } catch (error) {
    if (error instanceof OAuth2ConfigError) {
      const mapped = oauth2ConfigErrorMessage(error);
      return { outcome: "invalid", message: mapped.message, field: mapped.field, form: values };
    }
    throw error;
  }
  try {
    const row = await updateLoginSource(d1, id, { name: values.name, isActive: values.isActive, cfg });
    return { outcome: "saved", id: row.id };
  } catch (error) {
    if (error instanceof LoginSourceNameExistsError) {
      return {
        outcome: "invalid",
        message: adminAuthsLocale.login_source_exist.replace("%s", error.sourceName),
        field: "name",
        form: values,
      };
    }
    throw error;
  }
}

/** The field ladder — the name require/size/slug triple, then the provider
 *  and credential requires, then the discovery-URL scheme check (upstream's
 *  NewAuthSourcePost order). `requireSecret`: the create arm demands a
 *  posted secret; the edit arm allows the write-only empty (keep the
 *  stored one — the module header). Null = valid. */
export function validateAdminAuthSourceForm(
  values: AdminAuthSourceFormValues,
  opts: { requireSecret: boolean },
): { message: string; field: AdminAuthSourceField } | null {
  if (values.name === "") return { message: adminAuthsLocale.name_required, field: "name" };
  if (values.name.length > NAME_MAX_SIZE) return { message: adminAuthsLocale.name_max_size, field: "name" };
  if (!NAME_SLUG_PATTERN.test(values.name)) return { message: adminAuthsLocale.name_alpha_dash_dot, field: "name" };
  if (values.provider === "") return { message: adminAuthsLocale.provider_required, field: "provider" };
  if (!(OAUTH2_PROVIDER_KEYS as readonly string[]).includes(values.provider)) {
    // The registry's executable set is the codec's union — an unknown
    // provider posts no valid cfg (upstream's dropdown constrains the same
    // way; a forged value creates a dead source there).
    return { message: adminAuthsLocale.provider_required, field: "provider" };
  }
  if (values.clientId === "") return { message: adminAuthsLocale.client_id_required, field: "clientId" };
  if (opts.requireSecret && values.clientSecret === "") {
    return { message: adminAuthsLocale.client_secret_required, field: "clientSecret" };
  }
  if (
    values.provider === "openidConnect" &&
    values.discoveryUrl !== "" &&
    !/^https?:\/\//.test(values.discoveryUrl)
  ) {
    // auths.go:272-278's form-layer arm — url.Parse + the http/https
    // scheme gate; the invalid_openIdConnectAutoDiscoveryURL message.
    return { message: adminAuthsLocale.invalid_discovery_url, field: "discoveryUrl" };
  }
  return null;
}

export type AdminAuthSourceDeleteOutcome = "deleted" | "in-use" | "missing";

/** DeleteAuthSource (auths.go:459-480): the store's in-use-first refusal
 *  (ErrSourceInUse — auths.go:450) and the unknown-id arm (upstream
 *  ServerErrors a missing GetSourceByID; our honest 404-shell posture).
 *  "in-use" re-renders the edit page with the still_in_used message (the
 *  module header's mount recipe), "deleted" 303s the list. */
export async function applyAdminAuthSourceDelete(d1: D1Database, id: number): Promise<AdminAuthSourceDeleteOutcome> {
  try {
    await deleteLoginSource(d1, id);
    return "deleted";
  } catch (error) {
    if (error instanceof LoginSourceInUseError) return "in-use";
    if (error instanceof LoginSourceNotExistError) return "missing";
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The list page (templates/admin/auth/list.tmpl at the pin)
// ---------------------------------------------------------------------------

/** One list row's projection: the store row + the SPEC §6.1 additions (the
 *  provider display name from the parsed cfg, the in-use count). A dead
 *  (unparsable) cfg renders the provider cell as the honest "(invalid)"
 *  marker — never a partial login chain. */
export interface AdminAuthSourceListItem {
  row: LoginSourceRow;
  provider: string;
  linkedUsers: number;
}

export interface AdminAuthsData {
  items: AdminAuthSourceListItem[];
  total: number;
}

/** The list load — admin.Authentications' FindAndCount over
 *  FindSourcesOptions{} (auths.go:44-56, name order per the store's
 *  FindSources), the per-row provider + linked-users reads. Upstream
 *  renders the FULL set (no pager — the template ranges everything). */
export async function loadAdminAuthsData(d1: D1Database): Promise<AdminAuthsData> {
  const rows = await findLoginSources(d1);
  const items: AdminAuthSourceListItem[] = [];
  for (const row of rows) {
    let provider = "(invalid)";
    if (row.type === LoginSourceType.OAuth2) {
      try {
        const cfg = parseOAuth2SourceConfig(row.cfg);
        provider = getProviderDescriptor(cfg.provider)?.displayName ?? cfg.provider;
      } catch {
        provider = "(invalid)";
      }
    }
    items.push({ row, provider, linkedUsers: await countLoginSourceUsers(d1, row.id) });
  }
  return { items, total: rows.length };
}

/** The full-document render (the render.tsx pattern). */
export function renderAdminAuthsPage(ctx: UiContext, data: AdminAuthsData): string {
  return renderPage(<AdminAuthsPage ctx={ctx} data={data} />);
}

/** The auths list page (§2.4.1 discriminator: `admin authentication` —
 *  layout_head's dict, list.tmpl:1; upstream's Title is ctx.Tr
 *  "admin.authentication"). The nav item: navbar.tmpl:19's FIRST Identity &
 *  Access entry. */
export function AdminAuthsPage(props: { ctx: UiContext; data: AdminAuthsData }) {
  const colCount = 9; // upstream's seven + the SPEC §6.1 Provider/Users pair
  return (
    <AdminFamilyShell ctx={props.ctx} title={adminAuthsLocale.authentication} pageClass="admin authentication" active="auths">
      {/* list.tmpl:3-8: the panel header + total + the Add button (the
          new page is LANDED — a live link, upstream's own href). */}
      <h4 class="ui top attached header">
        {adminAuthsLocale.auth_manage_panel} ({adminAuthsLocale.total.replace("%d", String(props.data.total))})
        <div class="ui right">
          <a class="ui primary tiny button" href="/-/admin/auths/new">
            {adminAuthsLocale.new}
          </a>
        </div>
      </h4>
      <div class="ui attached table segment">
        <table class="ui very basic table unstackable">
          <thead>
            <tr>
              <th scope="col">{adminAuthsLocale.col_id}</th>
              <th scope="col">{adminAuthsLocale.col_name}</th>
              <th scope="col">{adminAuthsLocale.col_type}</th>
              <th scope="col">{adminAuthsLocale.col_enabled}</th>
              <th scope="col">{adminAuthsLocale.col_provider}</th>
              <th scope="col">{adminAuthsLocale.col_users}</th>
              <th scope="col">{adminAuthsLocale.col_updated}</th>
              <th scope="col">{adminAuthsLocale.col_created}</th>
              <th scope="col">{adminAuthsLocale.col_edit}</th>
            </tr>
          </thead>
          <tbody>
            {props.data.items.length === 0 ? (
              <tr>
                <td class="tw-text-center" colspan={colCount}>
                  {adminAuthsLocale.no_results}
                </td>
              </tr>
            ) : (
              props.data.items.map(({ row, provider, linkedUsers }) => (
                <tr key={row.id}>
                  <td>{row.id}</td>
                  <td>
                    {/* list.tmpl:99 — the name links the edit page. */}
                    <a href={`/-/admin/auths/${row.id}`}>{row.name}</a>
                  </td>
                  <td>{authSourceTypeName(row.type)}</td>
                  <td>{row.isActive ? <Icon name="octicon-check" /> : <AdminEmbeddedSvg name="octicon-x" />}</td>
                  <td>{provider}</td>
                  <td>{linkedUsers}</td>
                  <td>{formatAdminDate(row.updatedAt)}</td>
                  <td>{formatAdminDate(row.createdAt)}</td>
                  <td>
                    {/* list.tmpl:103's pencil cell → the edit page. */}
                    <a href={`/-/admin/auths/${row.id}`} aria-label={`${adminAuthsLocale.col_edit} #${row.id}`}>
                      <Icon name="octicon-pencil" />
                    </a>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </AdminFamilyShell>
  );
}

// ---------------------------------------------------------------------------
// The provider-field chrome shared by the new + edit forms
// ---------------------------------------------------------------------------

/** The provider dropdown's entries — the EXECUTABLE set only (SPEC §2.3:
 *  "the admin form lists ONLY the executable set"; §6.3), key order per
 *  providers.go:148-150. */
export function adminAuthSourceProviderOptions(): Array<{ key: string; displayName: string }> {
  return listExecutableProviders().map((p) => ({ key: p.key, displayName: p.displayName }));
}

/** The four custom-URL defaults (the registry's GITHUB_URLS values —
 *  providers_custom.go:55-70 via goth v1.82.0). The form prefills them
 *  when no mapping is stored (the module header's JS-fill reduction). */
export function adminAuthSourceGithubUrlDefaults(): CustomUrlMapping {
  const settings = getProviderDescriptor("github")?.customUrlSettings;
  if (!settings) return {};
  const mapping: CustomUrlMapping = {};
  if (settings.authUrl.value !== "") mapping.authUrl = settings.authUrl.value;
  if (settings.tokenUrl.value !== "") mapping.tokenUrl = settings.tokenUrl.value;
  if (settings.profileUrl.value !== "") mapping.profileUrl = settings.profileUrl.value;
  if (settings.emailUrl.value !== "") mapping.emailUrl = settings.emailUrl.value;
  return mapping;
}

/** The provider picker — upstream's Fomantic selection dropdown
 *  (oauth.tmpl:2-14) as the native select (the file-editor branch-picker
 *  reduction, file-editor.tsx:515's `ui selection dropdown`): the option
 *  value is the goth key (oauth.tmpl:10's `data-value="{{.Name}}"`), the
 *  option text the DisplayName (:10's body). */
function ProviderPicker(props: { values: AdminAuthSourceFormValues }) {
  return (
    <select id="oauth2_provider" name="oauth2_provider" class="ui selection dropdown">
      {adminAuthSourceProviderOptions().map((p) => (
        <option value={p.key} selected={props.values.provider === p.key}>
          {p.displayName}
        </option>
      ))}
    </select>
  );
}

/** The OAuth2 field block (oauth.tmpl reduced to the v1 field set — the
 *  module header's reductions; each field's upstream name attribute kept
 *  verbatim). The provider-scoped groups render statically with their help
 *  text (the JS-managed visibility has no no-JS analog; the codec's
 *  rejection is the honest failure arm). */
function OAuth2SourceFields(props: {
  values: AdminAuthSourceFormValues;
  errorField: AdminAuthSourceField | null;
  /** The create arm (true): the secret input is HTML-required; the edit arm
   *  (false): the write-only empty is the keep arm. */
  requireSecret: boolean;
}) {
  const { values } = props;
  const githubDefaults = adminAuthSourceGithubUrlDefaults();
  const urlValue = (posted: string, fallback: string | undefined): string =>
    posted !== "" ? posted : (fallback ?? "");
  return (
    <>
      <div class="required inline field">
        <label>{adminAuthsLocale.oauth2_provider}</label>
        <ProviderPicker values={values} />
      </div>
      <div class="required field">
        <label for="oauth2_key">{adminAuthsLocale.oauth2_client_id}</label>
        <input id="oauth2_key" name="oauth2_key" value={values.clientId} required />
      </div>
      <div class={props.requireSecret ? "required field" : "field"}>
        <label for="oauth2_secret">{adminAuthsLocale.oauth2_client_secret}</label>
        {/* Write-only (SPEC §6.1/§7.7 — the module header): type=password,
            the value NEVER echoes; required only on the create arm where an
            empty secret cannot fall back to a stored one. */}
        <input
          id="oauth2_secret"
          name="oauth2_secret"
          type="password"
          value=""
          autocomplete="new-password"
          required={props.requireSecret ? true : undefined}
        />
        <p class="help">{adminAuthsLocale.oauth2_client_secret_edit_note}</p>
      </div>
      <div class="optional field">
        <label for="oauth2_icon_url">{adminAuthsLocale.oauth2_icon_url}</label>
        <input id="oauth2_icon_url" name="oauth2_icon_url" value={values.iconUrl} />
      </div>
      <div class={props.errorField === "discoveryUrl" ? "required field error" : "required field"}>
        <label for="open_id_connect_auto_discovery_url">{adminAuthsLocale.oauth2_discovery_url}</label>
        <input
          id="open_id_connect_auto_discovery_url"
          name="open_id_connect_auto_discovery_url"
          value={values.discoveryUrl}
        />
        <p class="help">OpenID Connect only. {adminAuthsLocale.tip_openid_connect}</p>
      </div>
      <div class="field">
        <label for="open_id_connect_external_id_claim">{adminAuthsLocale.oauth2_external_id_claim}</label>
        <input
          id="open_id_connect_external_id_claim"
          name="open_id_connect_external_id_claim"
          value={values.externalIdClaim}
          placeholder="sub"
        />
        <p class="help">OpenID Connect only. Defaults to "sub".</p>
      </div>
      {/* github-only block (the codec rejects the mapping elsewhere): the
          checkbox gates the POSTed mapping exactly upstream's
          parseOAuth2Config branch; the fields prefill the registry defaults
          when nothing is stored. */}
      <div class="inline field">
        <label for="oauth2_use_custom_url">
          <strong>{adminAuthsLocale.oauth2_use_custom_url}</strong>
        </label>
        <input id="oauth2_use_custom_url" name="oauth2_use_custom_url" type="checkbox" checked={values.useCustomUrl || undefined} />
        <p class="help">GitHub only.</p>
      </div>
      <div class="field">
        <label for="oauth2_auth_url">{adminAuthsLocale.oauth2_auth_url}</label>
        <input id="oauth2_auth_url" name="oauth2_auth_url" value={urlValue(values.authUrl, githubDefaults.authUrl)} />
      </div>
      <div class="field">
        <label for="oauth2_token_url">{adminAuthsLocale.oauth2_token_url}</label>
        <input id="oauth2_token_url" name="oauth2_token_url" value={urlValue(values.tokenUrl, githubDefaults.tokenUrl)} />
      </div>
      <div class="field">
        <label for="oauth2_profile_url">{adminAuthsLocale.oauth2_profile_url}</label>
        <input id="oauth2_profile_url" name="oauth2_profile_url" value={urlValue(values.profileUrl, githubDefaults.profileUrl)} />
      </div>
      <div class="field">
        <label for="oauth2_email_url">{adminAuthsLocale.oauth2_email_url}</label>
        <input id="oauth2_email_url" name="oauth2_email_url" value={urlValue(values.emailUrl, githubDefaults.emailUrl)} />
      </div>
      <div class="field">
        <label for="oauth2_scopes">{adminAuthsLocale.oauth2_scopes}</label>
        <input id="oauth2_scopes" name="oauth2_scopes" value={values.scopes} />
      </div>
    </>
  );
}

/** The tips segment (new.tmpl:77-171 reduced): the OAuth2 general tip +
 *  the callback URL (server-computed when the name is known — the JS-fill
 *  reduction) and the THREE EXECUTABLE providers' tips (the module
 *  header's posture-line note). */
function AuthSourceTips(props: { name: string; origin: string }) {
  const callbackUrl = props.name === "" ? "" : `${props.origin}/user/oauth2/${encodeURIComponent(props.name)}/callback`;
  return (
    <>
      <h4 class="ui top attached header">{adminAuthsLocale.tips}</h4>
      <div class="ui attached segment">
        <h5>{adminAuthsLocale.tips_oauth2_general}</h5>
        <p>
          {adminAuthsLocale.tips_oauth2_general_tip} <b id="oauth2-callback-url">{callbackUrl}</b>
        </p>
        <div class="tw-mt-4">
          <h5>{adminAuthsLocale.oauth2_provider}</h5>
          <ul>
            <li>GitHub</li>
            <li>
              <div>{adminAuthsLocale.tip_github}</div>
            </li>
            <li>Google</li>
            <li>
              <div>{adminAuthsLocale.tip_google}</div>
            </li>
            <li>OpenID Connect</li>
            <li>
              <div>{adminAuthsLocale.tip_openid_connect}</div>
            </li>
          </ul>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// The new page (templates/admin/auth/new.tmpl reduced to the OAuth2 arm)
// ---------------------------------------------------------------------------

export interface AdminAuthSourceNewData {
  form: AdminAuthSourceFormValues;
  error: string | null;
  errorField: AdminAuthSourceField | null;
}

/** The full-document render — the new page. */
export function renderAdminAuthSourceNewPage(ctx: UiContext, data: AdminAuthSourceNewData): string {
  return renderPage(<AdminAuthSourceNewPage ctx={ctx} data={data} />);
}

/** The new auth source page (§2.4.1 discriminator: `admin new
 *  authentication` — new.tmpl:1's dict). */
export function AdminAuthSourceNewPage(props: { ctx: UiContext; data: AdminAuthSourceNewData }) {
  const { form } = props.data;
  return (
    <AdminFamilyShell
      ctx={props.ctx}
      title={adminAuthsLocale.new}
      pageClass="admin new authentication"
      active="auths"
    >
      <h4 class="ui top attached header">{adminAuthsLocale.new}</h4>
      <div class="ui attached segment">
        {props.data.error !== null ? (
          <div class="ui negative message">
            <p>{props.data.error}</p>
          </div>
        ) : null}
        {/* new.tmpl:9's form action="{{.Link}}" — the combo's own path. */}
        <form class="ui form" action="/-/admin/auths/new" method="post">
          {/* The type picker (new.tmpl:11-27) reduced to the ONE legal type
              (SPEC §6.1): the hidden wire field + the static text — a
              dropdown offering LDAP/SMTP/PAM/SSPI entries that can never
              run here would be the SPEC-0018 §3.3 posture-line class. */}
          <input type="hidden" name="type" value={String(LoginSourceType.OAuth2)} />
          <div class="inline required field">
            <label>{adminAuthsLocale.auth_type}</label>
            <span>{authSourceTypeName(LoginSourceType.OAuth2)}</span>
            <p class="help">{adminAuthsLocale.sync_note}</p>
          </div>
          {/* new.tmpl:24-27's name field, the Err_Name flag arm. */}
          <div class={props.data.errorField === "name" ? "required inline field error" : "required inline field"}>
            <label for="auth_name">{adminAuthsLocale.auth_name}</label>
            <input id="auth_name" name="name" value={form.name} autofocus required />
          </div>
          <OAuth2SourceFields values={form} errorField={props.data.errorField} requireSecret={true} />
          {/* new.tmpl:143-149's is_active checkbox — DEFAULT CHECKED on the
              fresh form (auths.go:85's `is_active = true`). */}
          <div class="inline field">
            <label for="is_active">
              <strong>{adminAuthsLocale.activated}</strong>
            </label>
            <input id="is_active" name="is_active" type="checkbox" checked={form.isActive || undefined} />
          </div>
          <div class="field">
            <button type="submit" class="ui primary button">
              {adminAuthsLocale.new}
            </button>
          </div>
        </form>
      </div>
      {/* new.tmpl:77-171's tips block (the reduced render). */}
      <AuthSourceTips name={form.name} origin={props.ctx.origin} />
    </AdminFamilyShell>
  );
}

// ---------------------------------------------------------------------------
// The edit page (templates/admin/auth/edit.tmpl reduced to the OAuth2 arm)
// ---------------------------------------------------------------------------

export interface AdminAuthSourceEditData {
  source: LoginSourceRow;
  /** The parsed cfg; null = a dead stored blob (the render degrades to the
   *  field-empty arm — never a partial secret echo). */
  cfg: OAuth2SourceConfig | null;
  linkedUsers: number;
  /** The POST-failure re-render carries the posted values (upstream's
   *  RenderWithErr …, form); null on the GET render (the stored values
   *   fill the fields). */
  form: AdminAuthSourceFormValues | null;
  error: string | null;
  errorField: AdminAuthSourceField | null;
}

/** The edit GET load — GetSourceByID + the cfg parse + the in-use count.
 *  Null = the unknown-id arm (the route 404-shells). */
export async function loadAdminAuthSourceEditData(d1: D1Database, id: number): Promise<AdminAuthSourceEditData | null> {
  const source = await getLoginSource(d1, id);
  if (source === null) return null;
  let cfg: OAuth2SourceConfig | null = null;
  if (source.type === LoginSourceType.OAuth2) {
    try {
      cfg = parseOAuth2SourceConfig(source.cfg);
    } catch {
      cfg = null;
    }
  }
  return { source, cfg, linkedUsers: await countLoginSourceUsers(d1, id), form: null, error: null, errorField: null };
}

/** The edit-page form values from the STORED row (the GET render's fill):
 *  the scopes join mirrors edit.tmpl:450's StringUtils.Join, the secret
 *  stays EMPTY (write-only). */
export function adminAuthSourceFormFromRow(source: LoginSourceRow, cfg: OAuth2SourceConfig | null): AdminAuthSourceFormValues {
  return {
    type: source.type,
    name: source.name,
    provider: cfg?.provider ?? "",
    clientId: cfg?.clientId ?? "",
    clientSecret: "", // never echoes (the module header)
    isActive: source.isActive,
    discoveryUrl: cfg?.discoveryUrl ?? "",
    externalIdClaim: cfg?.externalIdClaim ?? "",
    useCustomUrl: cfg?.customUrlMapping !== undefined,
    authUrl: cfg?.customUrlMapping?.authUrl ?? "",
    tokenUrl: cfg?.customUrlMapping?.tokenUrl ?? "",
    profileUrl: cfg?.customUrlMapping?.profileUrl ?? "",
    emailUrl: cfg?.customUrlMapping?.emailUrl ?? "",
    scopes: cfg?.scopes?.join(",") ?? "",
    iconUrl: cfg?.iconUrl ?? "",
  };
}

/** The full-document render — the edit page. `form` set (the POST failure
 *  arm) renders the posted values over the stored ones. */
export function renderAdminAuthSourceEditPage(ctx: UiContext, data: AdminAuthSourceEditData): string {
  return renderPage(<AdminAuthSourceEditPage ctx={ctx} data={data} />);
}

/** The edit auth source page (§2.4.1 discriminator: `admin edit
 *  authentication` — edit.tmpl:1's dict). */
export function AdminAuthSourceEditPage(props: { ctx: UiContext; data: AdminAuthSourceEditData }) {
  const { source } = props.data;
  const form = props.data.form ?? adminAuthSourceFormFromRow(source, props.data.cfg);
  const editHref = `/-/admin/auths/${source.id}`;
  return (
    <AdminFamilyShell ctx={props.ctx} title={adminAuthsLocale.edit} pageClass="admin edit authentication" active="auths">
      <h4 class="ui top attached header">{adminAuthsLocale.edit}</h4>
      <div class="ui attached segment">
        {props.data.error !== null ? (
          <div class="ui negative message">
            <p>{props.data.error}</p>
          </div>
        ) : null}
        <form class="ui form" action={editHref} method="post">
          {/* edit.tmpl:10's hidden id + :13-18's static type row. */}
          <input type="hidden" name="type" value={String(source.type)} />
          <div class="inline field">
            <label>{adminAuthsLocale.auth_type}</label>
            <span>{authSourceTypeName(source.type)}</span>
          </div>
          <div class={props.data.errorField === "name" ? "required inline field error" : "required inline field"}>
            <label for="auth_name">{adminAuthsLocale.auth_name}</label>
            <input id="auth_name" name="name" value={form.name} required />
            {/* SPEC §5.2/§7.1's rename warning — the IdP-registration
                footgun (the callback URL encodes the name; renaming
                invalidates it; upstream lives with the same coupling). */}
            <p class="help">
              Renaming this source invalidates the redirect URL registered at the provider — update the
              provider's application to {props.ctx.origin}/user/oauth2/{"{name}"}/callback if the name changes.
            </p>
          </div>
          <OAuth2SourceFields values={form} errorField={props.data.errorField} requireSecret={false} />
          <div class="inline field">
            <label for="is_active">
              <strong>{adminAuthsLocale.activated}</strong>
            </label>
            <input id="is_active" name="is_active" type="checkbox" checked={form.isActive || undefined} />
          </div>
          <div class="field">
            <button type="submit" class="ui primary button">
              {adminAuthsLocale.update}
            </button>
          </div>
        </form>
        {/* edit.tmpl:559-562's red delete button — the plain-form POST +
            inline-confirm-text reduction (the badge-edit posture). A
            separate form: the update form cannot nest it. */}
        <form class="ui form" action={`${editHref}/delete`} method="post">
          <div class="field">
            <button type="submit" class="ui red button">
              {adminAuthsLocale.delete}
            </button>
            <span class="tw-text-grey">{adminAuthsLocale.delete_auth_desc}</span>
          </div>
        </form>
      </div>
      {/* edit.tmpl:566-577's tips block (the OAuth2-only reduction). */}
      <AuthSourceTips name={form.name} origin={props.ctx.origin} />
    </AdminFamilyShell>
  );
}

/** The admin family's nav label for THIS family (the AdminFamilyNav item's
 *  text lives in admin-users.tsx's adminFamilyLocale — exported there as
 *  the shared copy; this re-export keeps the pairing discoverable). */
export const ADMIN_AUTHS_NAV_LABEL = adminFamilyLocale.authentications;
