/**
 * Access-token scope grammar — SPEC-0002 §2.4.
 *
 * Faithful port of upstream `gitea/models/auth/access_token_scope.go` at the
 * vendored pin (v29.0.0-dev-208-gfc493688): the exact scope strings, the
 * write⇒read implication baked into the bitmap, the normalization order, and
 * the `all` literal collapse all match upstream byte-for-byte.
 *
 * Upstream stores the scope as a ≤64-bit bitmap. The frozen grammar uses
 * 19 bits (1 public-only + 9 categories × read/write); we use plain numbers
 * (32-bit bitwise ops), which leaves headroom up to 15 categories. If a
 * future SPEC grows the category set beyond that, switch to BigInt here —
 * no caller-visible change.
 */

export const SCOPE_CATEGORIES = [
  "activitypub",
  "admin",
  "misc",
  "notification",
  "organization",
  "package",
  "issue",
  "repository",
  "user",
] as const;

export type ScopeCategory = (typeof SCOPE_CATEGORIES)[number];

/** Enforcement level; derived from the HTTP method by `requireScope`. */
export type ScopeLevel = "read" | "write";

export const SCOPE_ALL = "all";
export const SCOPE_NONE = "no-token-scope";
export const SCOPE_PUBLIC_ONLY = "public-only";

// --- Bitmap -----------------------------------------------------------------
// Bit layout mirrors upstream: bit 0 public-only; per category i one bit for
// read and one for write. Write bits always include their read bit.

const PUBLIC_ONLY_BITS = 1;

const readBits = (categoryIndex: number): number => 1 << (1 + 2 * categoryIndex);
const writeBits = (categoryIndex: number): number => (1 << (2 + 2 * categoryIndex)) | readBits(categoryIndex);

const categoryBits = (category: ScopeCategory): { read: number; write: number } => {
  const index = SCOPE_CATEGORIES.indexOf(category);
  return { read: readBits(index), write: writeBits(index) };
};

/** All grantable permission scopes (upstream `accessTokenScopeAllBits`). */
const ALL_BITS = SCOPE_CATEGORIES.reduce((acc, category) => acc | categoryBits(category).write, 0);

const NONE_BITS = 0;
const PUBLIC_ONLY = PUBLIC_ONLY_BITS;

/** Scope string → bits, including child scopes (write includes read). */
const scopeBitsTable: ReadonlyMap<string, number> = (() => {
  const table = new Map<string, number>();
  table.set(SCOPE_ALL, ALL_BITS);
  table.set(SCOPE_NONE, NONE_BITS);
  table.set(SCOPE_PUBLIC_ONLY, PUBLIC_ONLY);
  for (const category of SCOPE_CATEGORIES) {
    const bits = categoryBits(category);
    table.set(`read:${category}`, bits.read);
    table.set(`write:${category}`, bits.write);
  }
  return table;
})();

/**
 * Iteration order for normalization output — upstream `allAccessTokenScopes`:
 * parent scope must precede child scopes, public-only first.
 */
const allScopesInNormalizeOrder: readonly string[] = [
  SCOPE_PUBLIC_ONLY,
  ...SCOPE_CATEGORIES.flatMap((category) => [`write:${category}`, `read:${category}`] as const),
];

const ALL_SCOPE_LITERAL =
  SCOPE_CATEGORIES.map((category) => `write:${category}`).join(",");

/** Error thrown for unknown scope strings; message matches upstream verbatim. */
export class InvalidScopeError extends Error {
  constructor(scope: string) {
    super(`invalid access token scope: ${scope}`);
    this.name = "InvalidScopeError";
  }
}

/** Split a comma-joined scope string, skipping empty segments (upstream
 *  parser tolerates trailing commas / empty segments). */
export function scopeStringSlice(scope: string): string[] {
  if (scope === "") return [];
  return scope.split(",");
}

/** Parsed scope bitmap with the upstream check operations. */
export class ScopeSet {
  private constructor(readonly bitmap: number) {}

  /** Parse a scope string into a set; throws `InvalidScopeError` on unknown
   *  scope names. Stored token scopes are pre-normalized, so this never
   *  fails on values read back from D1. */
  static parse(scope: string): ScopeSet {
    return new ScopeSet(parseScopeBitmap(scope));
  }

  /** Like `parse` but maps any parse failure to a zero-permission set
   *  (fail-closed) — used for values whose validity cannot be enforced. */
  static parseLenient(scope: string): ScopeSet {
    try {
      return new ScopeSet(parseScopeBitmap(scope));
    } catch {
      return new ScopeSet(NONE_BITS);
    }
  }

  /** True when the set contains ALL of the given scopes (upstream
   *  `HasScope`). `no-token-scope` has zero bits and is trivially held. */
  has(...scopes: string[]): boolean {
    for (const scope of scopes) {
      const bits = scopeBitsTable.get(scope);
      if (bits === undefined) throw new InvalidScopeError(scope);
      if ((this.bitmap & bits) !== bits) return false;
    }
    return true;
  }

  /** True when the set contains ANY of the given scopes (upstream
   *  `HasAnyScope`). */
  hasAny(...scopes: string[]): boolean {
    for (const scope of scopes) {
      const bits = scopeBitsTable.get(scope);
      if (bits === undefined) throw new InvalidScopeError(scope);
      if ((this.bitmap & bits) === bits) return true;
    }
    return false;
  }

  /** Token may only see public orgs/repos (upstream `PublicOnly`). */
  get publicOnly(): boolean {
    return (this.bitmap & PUBLIC_ONLY) === PUBLIC_ONLY;
  }

  /** Zero permissions (`no-token-scope` or equivalent empty bitmap). */
  get empty(): boolean {
    return this.bitmap === NONE_BITS;
  }

  /** Upstream `HasPermissionScope`: false for "", `no-token-scope` and
   *  `public-only`. */
  hasPermissionScope(): boolean {
    return this.bitmap !== NONE_BITS && this.bitmap !== PUBLIC_ONLY;
  }

  /**
   * Whether a request authenticated by this scope may mint a token carrying
   * the child scope (upstream `CanCreateChildScope`): rejects any grantable
   * scope the parent does not hold. `public-only` is a restriction, not a
   * permission, so it is ignored (a child may always be public-only).
   */
  canCreateChildScope(childScope: string): boolean {
    const requested = scopeStringSlice(childScope).filter((s) => s !== SCOPE_PUBLIC_ONLY);
    return this.has(...requested);
  }

  /** Normalized, comma-joined scope string (upstream `toScope`). */
  toString(): string {
    return bitmapToScope(this.bitmap);
  }
}

// Upstream `AccessTokenScope.parse`: comma-split, skip empties, expand `all`.
function parseScopeBitmap(scope: string): number {
  let bitmap = 0;
  for (const singleScope of scopeStringSlice(scope)) {
    if (singleScope === "") continue;
    if (singleScope === SCOPE_ALL) {
      bitmap |= ALL_BITS;
      continue;
    }
    const bits = scopeBitsTable.get(singleScope);
    if (bits === undefined) throw new InvalidScopeError(singleScope);
    bitmap |= bits;
  }
  return bitmap;
}

// Upstream `accessTokenScopeBitmap.toScope`: rebuild the scope string by
// walking `allAccessTokenScopes` in order, then collapse the nine write
// scopes into the literal `all`.
function bitmapToScope(bitmap: number): string {
  const scopes: string[] = [];
  let reconstruct = 0;
  for (const singleScope of allScopesInNormalizeOrder) {
    const bits = scopeBitsTable.get(singleScope) as number;
    if ((bitmap & bits) !== bits) continue;
    const current = reconstruct | bits;
    if (current === reconstruct) continue;
    reconstruct = current;
    scopes.push(singleScope);
  }
  // Upstream replaces the exact nine-write substring, so "public-only" plus
  // all writes normalizes to "public-only,all". The nine writes are always
  // contiguous when all present: reads never split a pair (write implies its
  // read, so the read is skipped right after the write is taken).
  return scopes.join(",").replace(ALL_SCOPE_LITERAL, SCOPE_ALL);
}

/**
 * Normalize a scope string: dedupe, expand `all`, bake write⇒read
 * (upstream `Normalize`). `all` normalizes to the literal `all`, not the
 * expanded list. Throws `InvalidScopeError` on unknown scope strings —
 * never silently normalized away.
 */
export function normalizeScope(scope: string): string {
  const bitmap = parseScopeBitmap(scope);
  if (bitmap === NONE_BITS && scopeStringSlice(scope).includes(SCOPE_NONE)) {
    return SCOPE_NONE;
  }
  return bitmapToScope(bitmap);
}

/** Scope strings required for a level over the given route categories
 *  (upstream `GetRequiredScopes`), e.g. read+`["repository"]` →
 *  `["read:repository"]`. */
export function requiredScopeNames(level: ScopeLevel, categories: readonly ScopeCategory[]): string[] {
  return categories.map((category) => `${level}:${category}`);
}

/**
 * Add the public-only restriction to a (normalized) child scope when the
 * authorizing parent scope is public-only, so a public-only token cannot
 * mint a child that drops the restriction (upstream `EnforcePublicOnlyFrom`,
 * access_token_scope.go:325–334).
 */
export function enforcePublicOnlyFrom(childScope: string, parentScope: string): string {
  if (!ScopeSet.parse(parentScope).publicOnly) {
    return childScope;
  }
  return normalizeScope(`${childScope},${SCOPE_PUBLIC_ONLY}`);
}
