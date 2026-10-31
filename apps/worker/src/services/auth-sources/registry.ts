/**
 * The OAuth2 login-source provider registry — the data skeleton of
 * upstream's goth-provider table (specs/external-auth-sources.md §2.3).
 *
 * Upstream registers LIVE provider objects at init
 * (`services/auth/source/oauth2/providers.go:63-68` + the three
 * provider-family files) because goth providers are process-lifetime
 * objects reconstructed per source (`CreateGothProvider`). Ours is
 * stateless (SPEC §5.1): each request rebuilds the client from the source
 * row's cfg JSON + THIS table. W2/W3 add the executable client modules
 * (oidc-client / github / google); this file is the recorded lattice they
 * hang off — the single place that answers "which providers exist, which
 * run here, and with what field set".
 *
 * The descriptor mirrors the pin's `Provider` interface
 * (providers.go:40-47): Name / DisplayName / CustomURLSettings /
 * SupportSSHPublicKey, plus the kind tag that names the constructor family.
 * Field-set cites are per-entry.
 */

import type { OAuth2ProviderKey } from "./cfg";

/** One CustomURLSettings attribute (urlmapping.go:25-29): the default
 *  value, whether the admin may override it (`available`), and whether the
 *  provider cannot run without it (`required` — the gitea/nextcloud class,
 *  all deferred). */
export interface CustomUrlAttribute {
  value: string;
  available: boolean;
  required: boolean;
}

/** Upstream `CustomURLSettings` (urlmapping.go:16-22) minus `Tenant`
 *  (azureadv2-only — the Azure trio is deferred, SPEC §2.3). */
export interface CustomUrlSettings {
  authUrl: CustomUrlAttribute;
  tokenUrl: CustomUrlAttribute;
  profileUrl: CustomUrlAttribute;
  emailUrl: CustomUrlAttribute;
}

/** The constructor family the entry descends from at the pin. */
export type ProviderKind = "oidc" | "custom-url" | "simple";

/** One registry entry — the pin's Provider interface shape, data-only. */
export interface ProviderDescriptor {
  /** The goth registry key — `cfg.provider`'s value. */
  key: string;
  /** DisplayName (providers.go:42). */
  displayName: string;
  kind: ProviderKind;
  /** false = recorded-deferred (SPEC §2.3): the admin form never offers
   *  it; making one executable is a client module (W3-class), not a SPEC. */
  executable: boolean;
  /** The scopes the constructor defaults when the source specifies none.
   *  Empty array = none (the source's own scopes win). */
  defaultScopes: string[];
  /** github only in v1; nil for the OIDC and simple families
   *  (providers_base.go:53-56). */
  customUrlSettings: CustomUrlSettings | null;
  /** providers_openid.go:31 — only the OIDC arm carries it at the pin. */
  supportsSshPublicKey: boolean;
  /** The single-claim external-id override (providers_openid.go:55-59) —
   *  carried for OIDC only in v1 (SPEC §5.4). */
  externalIdClaim: boolean;
  /** The pin cite for the constructor (SPEC §2.3's table). */
  cite: string;
}

// goth v1.82.0 (gitea/go.mod:60) github endpoint defaults — the values
// behind providers_custom.go:56-61's availableAttribute(...) calls; verified
// against goth v1.82.0 providers/github/github.go package vars (not in the
// gitea tree — goth is an external module).
const GITHUB_URLS: CustomUrlSettings = {
  authUrl: {
    value: "https://github.com/login/oauth/authorize",
    available: true,
    required: false,
  },
  tokenUrl: {
    value: "https://github.com/login/oauth/access_token",
    available: true,
    required: false,
  },
  profileUrl: {
    value: "https://api.github.com/user",
    available: true,
    required: false,
  },
  emailUrl: {
    value: "https://api.github.com/user/emails",
    available: true,
    required: false,
  },
};

/** The full recorded lattice (SPEC §2.3) — executable entries first, then
 *  the deferred keys in the SPEC table's order. Deferred entries carry only
 *  the identity + kind + cite: constructor data (scopes beyond the SPEC
 *  table's recorded defaults, custom URLs) lands WITH the client module,
 *  never invented ahead of it. */
export const PROVIDER_LATTICE: ProviderDescriptor[] = [
  // -- executable v1 set -----------------------------------------------------
  {
    key: "openidConnect",
    displayName: "OpenID Connect",
    kind: "oidc",
    executable: true,
    // The OPENID_CONNECT_SCOPES setting default is EMPTY
    // (modules/setting/oauth2.go:66 parseScopes of an unset key) and
    // CreateGothProvider falls back to the source's own scopes
    // (providers_openid.go:45-50).
    defaultScopes: [],
    customUrlSettings: null,
    supportsSshPublicKey: true,
    externalIdClaim: true,
    cite: "providers_openid.go:24-72",
  },
  {
    key: "github",
    displayName: "GitHub",
    kind: "custom-url",
    executable: true,
    // No default scopes; the auto-reg `user:email` add is deferred
    // (providers_custom.go:67-69).
    defaultScopes: [],
    customUrlSettings: GITHUB_URLS,
    supportsSshPublicKey: false,
    externalIdClaim: false,
    cite: "providers_custom.go:55-70",
  },
  {
    key: "gplus",
    displayName: "Google",
    kind: "simple",
    executable: true,
    // ["email"]; the `profile` add rides auto-reg/avatar settings
    // (providers_simple.go:74-79) — both deferred, so the v1 default is
    // exactly ["email"]. Legacy `gplus` key kept for migration parity
    // (:72 comment).
    defaultScopes: ["email"],
    customUrlSettings: null,
    supportsSshPublicKey: false,
    externalIdClaim: false,
    cite: "providers_simple.go:72-79",
  },
  // -- recorded-deferred (SPEC §2.3; constructor data lands with the client
  //    module) ---------------------------------------------------------------
  { key: "gitlab", displayName: "GitLab", kind: "custom-url", executable: false, defaultScopes: [], customUrlSettings: null, supportsSshPublicKey: false, externalIdClaim: false, cite: "providers_custom.go:71-82" },
  { key: "gitea", displayName: "Gitea", kind: "custom-url", executable: false, defaultScopes: [], customUrlSettings: null, supportsSshPublicKey: false, externalIdClaim: false, cite: "providers_custom.go:83-94" },
  { key: "nextcloud", displayName: "Nextcloud", kind: "custom-url", executable: false, defaultScopes: [], customUrlSettings: null, supportsSshPublicKey: false, externalIdClaim: false, cite: "providers_custom.go:95-106" },
  { key: "mastodon", displayName: "Mastodon", kind: "custom-url", executable: false, defaultScopes: [], customUrlSettings: null, supportsSshPublicKey: false, externalIdClaim: false, cite: "providers_custom.go:107-117" },
  { key: "azureadv2", displayName: "Azure AD v2", kind: "custom-url", executable: false, defaultScopes: [], customUrlSettings: null, supportsSshPublicKey: false, externalIdClaim: false, cite: "providers_custom.go:118-137" },
  { key: "aws-cognito", displayName: "AWS Cognito", kind: "custom-url", executable: false, defaultScopes: [], customUrlSettings: null, supportsSshPublicKey: false, externalIdClaim: false, cite: "providers_custom.go:124-146" },
  { key: "bitbucket", displayName: "Bitbucket", kind: "simple", executable: false, defaultScopes: ["account"], customUrlSettings: null, supportsSshPublicKey: false, externalIdClaim: false, cite: "providers_simple.go:54-61" },
  { key: "dropbox", displayName: "Dropbox", kind: "simple", executable: false, defaultScopes: [], customUrlSettings: null, supportsSshPublicKey: false, externalIdClaim: false, cite: "providers_simple.go:63-68" },
  { key: "facebook", displayName: "Facebook", kind: "simple", executable: false, defaultScopes: [], customUrlSettings: null, supportsSshPublicKey: false, externalIdClaim: false, cite: "providers_simple.go:66-70" },
  { key: "twitter", displayName: "Twitter", kind: "simple", executable: false, defaultScopes: [], customUrlSettings: null, supportsSshPublicKey: false, externalIdClaim: false, cite: "providers_simple.go:80-84" },
  { key: "discord", displayName: "Discord", kind: "simple", executable: false, defaultScopes: ["identify", "email"], customUrlSettings: null, supportsSshPublicKey: false, externalIdClaim: false, cite: "providers_simple.go:85-90" },
  { key: "yandex", displayName: "Yandex", kind: "simple", executable: false, defaultScopes: [], customUrlSettings: null, supportsSshPublicKey: false, externalIdClaim: false, cite: "providers_simple.go:91-100" },
  { key: "azuread", displayName: "Azure AD", kind: "simple", executable: false, defaultScopes: [], customUrlSettings: null, supportsSshPublicKey: false, externalIdClaim: false, cite: "providers_simple.go:101-108" },
  { key: "microsoftonline", displayName: "Microsoft Online", kind: "simple", executable: false, defaultScopes: [], customUrlSettings: null, supportsSshPublicKey: false, externalIdClaim: false, cite: "providers_simple.go:109-116" },
];

/** Look a provider up by its goth key. */
export function getProviderDescriptor(key: string): ProviderDescriptor | undefined {
  return PROVIDER_LATTICE.find((p) => p.key === key);
}

/** The executable set, sorted by key (GetSupportedOAuth2Providers' sort,
 *  providers.go:148-150) — the admin form's provider dropdown (SPEC §6.3:
 *  ONLY the executable set renders). */
export function listExecutableProviders(): ProviderDescriptor[] {
  return PROVIDER_LATTICE.filter((p) => p.executable).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The keys the cfg codec's union covers (the executable v1 set). */
export const EXECUTABLE_PROVIDER_KEYS: readonly OAuth2ProviderKey[] = listExecutableProviders().map((p) => p.key as OAuth2ProviderKey);
