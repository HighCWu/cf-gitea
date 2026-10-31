/**
 * The typed codec for the OAuth2 login-source config record — the JSON blob
 * in `login_source.cfg` (specs/external-auth-sources.md §4.2).
 *
 * Upstream serializes `services/auth/source/oauth2/source.go:15-35`'s Go
 * struct through xorm's TEXT JSON column: the blob is opaque at the DB and
 * every reader unmarshals it into the struct (FromDB, :37-40). Our contract
 * is the same SEMANTICS with an explicit version field: `v:1` gates the
 * shape so a future field addition is a codec revision, not a silent
 * reinterpretation.
 *
 * ## The v1 field set (SPEC §4.2 — every carry has its pin cite)
 *
 *   - `provider` — the goth registry key (`openidConnect` | `github` |
 *     `gplus`; the legacy `gplus` name is kept for migration parity,
 *     providers_simple.go:72 comment "named gplus due to legacy gplus ->
 *     google migration").
 *   - `clientId` / `clientSecret` — the client credentials. PLAINTEXT in D1
 *     per upstream parity (the ratification posture: upstream stores the
 *     secret inline in the same JSON; the AES-GCM envelope is the recorded
 *     hardening row, SPEC §7.7 / OQ-2).
 *   - `discoveryUrl` — `OpenIDConnectAutoDiscoveryURL`, openidConnect ONLY
 *     (providers_openid.go:53-58 — a bad discovery URL fails the source
     *   eagerly; the admin flow validates BEFORE persisting, SPEC §5.1).
 *   - `externalIdClaim` — the single-claim external-id override,
 *     openidConnect ONLY (providers_openid.go:55-59: "the admin explicitly
 *     chooses one claim (e.g. `oid` for Azure AD)"); a verification concern
 *     carried in v1 per SPEC §5.4 (the §4.2 sketch omits it — §5.4/§6.3
 *     are the operative arms; recorded in the SPEC as-built).
 *   - `customUrlMapping` — `CustomURLMapping` (urlmapping.go:7-13), github
 *     ONLY in v1 (github is the only executable provider whose
 *     CustomURLSettings is non-nil — providers_base.go:53-56 returns nil
 *     for the simple/OIDC bases). The four v1 URLs are the ones github's
 *     registration marks `availableAttribute` (providers_custom.go:55-64);
 *     `Tenant` (urlmapping.go:12) is azureadv2-only and stays OUT (the
 *     whole Azure trio is deferred, SPEC §2.3).
 *   - `iconUrl` — `IconURL` (source.go:22); optional, overrides the
 *     provider's icon on the login button (providers.go:53-55 reads it via
 *     the `!= ""` check, so empty ⇒ absent here).
 *   - `scopes` — `Scopes []string`; optional, provider defaults otherwise
 *     (openidConnect: the `OPENID_CONNECT_SCOPES` setting default is EMPTY
 *     and CreateGothProvider falls back to source.Scopes,
 *     providers_openid.go:45-50; github: none — the auto-reg `user:email`
 *     add is deferred, providers_custom.go:67-69; gplus: `["email"]`,
 *     providers_simple.go:74).
 *
 * ## What is structurally absent (SPEC §1/§4.2 — absence, not zero values)
 *
 * `RequiredClaimName/Value`, `GroupClaimName`, `AdminGroup`, `GroupTeamMap`,
 * `GroupTeamMapRemoval`, `RestrictedGroup`, `SSHPublicKeyClaimName`,
 * `FullNameClaimName` (source.go:26-34) — the sync-engine field set. The
 * codec REJECTS them on parse (unknown-key rule) so a blob carrying them is
 * unusable rather than silently half-working.
 */

/** The config record version this codec reads and writes. */
export const OAUTH2_SOURCE_CONFIG_VERSION = 1;

/** The goth registry keys executable in v1 (SPEC §2.3 — the ratified set). */
export const OAUTH2_PROVIDER_KEYS = ["openidConnect", "github", "gplus"] as const;

/** A goth registry key (the `cfg.provider` value). */
export type OAuth2ProviderKey = (typeof OAUTH2_PROVIDER_KEYS)[number];

/** Upstream `CustomURLMapping` (urlmapping.go:7-13) minus `Tenant`
 *  (azureadv2-only, deferred). Field order is the wire order. */
export interface CustomUrlMapping {
  authUrl?: string;
  tokenUrl?: string;
  profileUrl?: string;
  emailUrl?: string;
}

/** The v1 OAuth2 source config record — `login_source.cfg` for type 6. */
export interface OAuth2SourceConfig {
  v: typeof OAUTH2_SOURCE_CONFIG_VERSION;
  provider: OAuth2ProviderKey;
  clientId: string;
  /** Plaintext per upstream parity; never rendered on edit, never in list
   *  payloads (SPEC §7.7). */
  clientSecret: string;
  /** openidConnect only — required there. */
  discoveryUrl?: string;
  /** openidConnect only. */
  externalIdClaim?: string;
  /** github only. */
  customUrlMapping?: CustomUrlMapping;
  iconUrl?: string;
  scopes?: string[];
}

/** A parse/serialize rejection. `code` names the violated rule for tests
 *  and the admin form's field-level errors (W4). */
export class OAuth2ConfigError extends Error {
  constructor(
    /** Stable machine-readable reason (e.g. "unknown-field",
     *  "discovery-required", "provider-invalid", "version"). */
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OAuth2ConfigError";
  }
}

const CUSTOM_URL_FIELDS = ["authUrl", "tokenUrl", "profileUrl", "emailUrl"] as const;

/** The fixed wire-key order serialize emits (deterministic bytes for
 *  tests and audit diffs). */
const WIRE_KEY_ORDER = [
  "v",
  "provider",
  "clientId",
  "clientSecret",
  "discoveryUrl",
  "externalIdClaim",
  "customUrlMapping",
  "iconUrl",
  "scopes",
] as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Validate + normalize an already-decoded JSON object into the record. */
function fromRecord(input: Record<string, unknown>): OAuth2SourceConfig {
  // Version gate FIRST — an unknown version must fail loudly, never fall
  // through to a partial read.
  if (input.v !== OAUTH2_SOURCE_CONFIG_VERSION) {
    throw new OAuth2ConfigError(
      "version",
      `unsupported cfg version: ${JSON.stringify(input.v)} (want ${OAUTH2_SOURCE_CONFIG_VERSION})`,
    );
  }

  // Unknown-key rule: deferred/absent fields are STRUCTURALLY absent
  // (SPEC §4.2) — a blob carrying them was written by a different (newer or
  // foreign) writer and must not silently half-load.
  const known = new Set<string>(WIRE_KEY_ORDER);
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      throw new OAuth2ConfigError("unknown-field", `unknown cfg field: ${key}`);
    }
  }

  const provider = input.provider;
  if (typeof provider !== "string" || !(OAUTH2_PROVIDER_KEYS as readonly string[]).includes(provider)) {
    throw new OAuth2ConfigError("provider-invalid", `unknown provider: ${JSON.stringify(provider)}`);
  }

  for (const key of ["clientId", "clientSecret"] as const) {
    const value = input[key];
    if (typeof value !== "string" || value.length === 0) {
      throw new OAuth2ConfigError(`${key}-required`, `${key} is required and must be a non-empty string`);
    }
  }

  const config: OAuth2SourceConfig = {
    v: OAUTH2_SOURCE_CONFIG_VERSION,
    provider: provider as OAuth2ProviderKey,
    clientId: input.clientId as string,
    clientSecret: input.clientSecret as string,
  };

  // discoveryUrl: required for openidConnect (the discovery client cannot
  // be built without it — providers_openid.go:53-58), structurally absent
  // for every other provider.
  if (provider === "openidConnect") {
    const discoveryUrl = input.discoveryUrl;
    if (typeof discoveryUrl !== "string" || discoveryUrl.length === 0) {
      throw new OAuth2ConfigError("discovery-required", "discoveryUrl is required for the openidConnect provider");
    }
    config.discoveryUrl = discoveryUrl;
  } else if (input.discoveryUrl !== undefined) {
    throw new OAuth2ConfigError("discovery-forbidden", `discoveryUrl only applies to openidConnect, not ${provider}`);
  }

  // externalIdClaim: OIDC-only, optional.
  if (input.externalIdClaim !== undefined) {
    if (provider !== "openidConnect") {
      throw new OAuth2ConfigError("claim-forbidden", `externalIdClaim only applies to openidConnect, not ${provider}`);
    }
    const claim = input.externalIdClaim;
    if (typeof claim !== "string" || claim.length === 0) {
      throw new OAuth2ConfigError("claim-invalid", "externalIdClaim must be a non-empty string when present");
    }
    config.externalIdClaim = claim;
  }

  // customUrlMapping: github-only; per-entry empty strings drop (upstream's
  // OverrideWith ignores len==0 overrides, urlmapping.go:60-74); a mapping
  // that normalizes to nothing is absent, not {}.
  if (input.customUrlMapping !== undefined) {
    if (provider !== "github") {
      throw new OAuth2ConfigError("urls-forbidden", `customUrlMapping only applies to github, not ${provider}`);
    }
    const raw = input.customUrlMapping;
    if (!isPlainObject(raw)) {
      throw new OAuth2ConfigError("urls-invalid", "customUrlMapping must be an object");
    }
    for (const key of Object.keys(raw)) {
      if (!(CUSTOM_URL_FIELDS as readonly string[]).includes(key)) {
        throw new OAuth2ConfigError("unknown-field", `unknown customUrlMapping field: ${key}`);
      }
    }
    const mapping: CustomUrlMapping = {};
    for (const field of CUSTOM_URL_FIELDS) {
      const value = raw[field];
      if (value === undefined) continue;
      if (typeof value !== "string") {
        throw new OAuth2ConfigError("urls-invalid", `customUrlMapping.${field} must be a string`);
      }
      if (value.length > 0) mapping[field] = value;
    }
    if (Object.keys(mapping).length > 0) config.customUrlMapping = mapping;
  }

  // iconUrl: empty means unset (providers.go:53-55's `!= ""` check).
  if (input.iconUrl !== undefined) {
    const iconUrl = input.iconUrl;
    if (typeof iconUrl !== "string") {
      throw new OAuth2ConfigError("icon-invalid", "iconUrl must be a string");
    }
    if (iconUrl.length > 0) config.iconUrl = iconUrl;
  }

  // scopes: an array of non-empty strings; an empty array normalizes to
  // absent (the provider default is what an empty scope list means anyway).
  if (input.scopes !== undefined) {
    const scopes = input.scopes;
    if (!Array.isArray(scopes)) {
      throw new OAuth2ConfigError("scopes-invalid", "scopes must be an array of strings");
    }
    for (const scope of scopes) {
      if (typeof scope !== "string" || scope.length === 0) {
        throw new OAuth2ConfigError("scopes-invalid", "scopes must be an array of non-empty strings");
      }
    }
    if (scopes.length > 0) config.scopes = scopes as string[];
  }

  return config;
}

/**
 * Parse `login_source.cfg` (type 6) into the validated record. Throws
 * `OAuth2ConfigError` on any structural violation — the caller (store/route
 * layer) treats an unparsable row as a dead source, never as a partial
 * login chain.
 */
export function parseOAuth2SourceConfig(cfgJson: string): OAuth2SourceConfig {
  let decoded: unknown;
  try {
    decoded = JSON.parse(cfgJson);
  } catch {
    throw new OAuth2ConfigError("json", "cfg is not valid JSON");
  }
  if (!isPlainObject(decoded)) {
    throw new OAuth2ConfigError("shape", "cfg must be a JSON object");
  }
  return fromRecord(decoded);
}

/**
 * Serialize the record to the stored JSON. Accepts a plain record-shaped
 * input (the admin form's assembled object) and runs the SAME validation as
 * parse — an invalid record is never written (validate-before-persist,
 * SPEC §5.1/§6.2). Emits a fixed key order.
 */
export function serializeOAuth2SourceConfig(input: OAuth2SourceConfig): string {
  // Round-trip through the validator: fromRecord normalizes (drops empty
  // optionals) and rejects any structural violation before a byte is
  // written.
  const normalized = fromRecord(input as unknown as Record<string, unknown>);
  const ordered: Record<string, unknown> = {};
  for (const key of WIRE_KEY_ORDER) {
    if (key in normalized) ordered[key] = normalized[key];
  }
  return JSON.stringify(ordered);
}
