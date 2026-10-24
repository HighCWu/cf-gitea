/**
 * Scope grammar tests — ported from upstream
 * `gitea/models/auth/access_token_scope_test.go` at the vendored pin
 * (SPEC-0002 §5), plus the child-scope and public-only rules the SPEC
 * cites (access_token_scope.go:310–334).
 */

import { describe, expect, it } from "vitest";

import {
  enforcePublicOnlyFrom,
  InvalidScopeError,
  normalizeScope,
  requiredScopeNames,
  scopeStringSlice,
  SCOPE_CATEGORIES,
  SCOPE_NONE,
  ScopeSet,
} from "./scopes";

const sortedCategories = [...SCOPE_CATEGORIES].sort();

describe("GetAccessTokenCategories equivalent", () => {
  it("lists the sorted upstream categories", () => {
    expect(sortedCategories).toEqual([
      "activitypub",
      "admin",
      "issue",
      "misc",
      "notification",
      "organization",
      "package",
      "repository",
      "user",
    ]);
  });
});

describe("normalizeScope (upstream Normalize table)", () => {
  const cases: Array<[string, string]> = [
    ["", ""],
    ["no-token-scope", "no-token-scope"],
    ["no-token-scope,no-token-scope", "no-token-scope"],
    ["no-token-scope,read:user", "read:user"],
    ["no-token-scope,public-only", "public-only"],
    ["no-token-scope,all", "all"],
    ["write:misc,write:notification,read:package,write:notification,public-only", "public-only,write:misc,write:notification,read:package"],
    ["all", "all"],
    [
      "write:activitypub,write:admin,write:misc,write:notification,write:organization,write:package,write:issue,write:repository,write:user",
      "all",
    ],
    [
      "write:activitypub,write:admin,write:misc,write:notification,write:organization,write:package,write:issue,write:repository,write:user,public-only",
      "public-only,all",
    ],
  ];

  for (const category of SCOPE_CATEGORIES) {
    cases.push(
      [`read:${category}`, `read:${category}`],
      [`write:${category}`, `write:${category}`],
      [`write:${category},read:${category}`, `write:${category}`],
      [`read:${category},write:${category}`, `write:${category}`],
      [`read:${category},write:${category},write:${category}`, `write:${category}`],
    );
  }

  for (const [input, expected] of cases) {
    it(`normalizeScope(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, () => {
      expect(normalizeScope(input)).toBe(expected);
    });
  }

  it("rejects unknown scope strings with the upstream message", () => {
    expect(() => normalizeScope("read:user,banana")).toThrow(InvalidScopeError);
    expect(() => normalizeScope("banana")).toThrow("invalid access token scope: banana");
  });

  it("tolerates trailing commas and empty segments", () => {
    expect(normalizeScope("read:user,")).toBe("read:user");
    expect(normalizeScope(",read:user,,write:user,")).toBe("write:user");
  });
});

describe("ScopeSet.has (upstream HasScope table)", () => {
  const cases: Array<[string, string, boolean]> = [
    ["read:admin", "write:package", false],
    ["all", "write:package", true],
    ["write:package", "all", false],
    ["public-only", "read:issue", false],
    ["no-token-scope", "all", false],
    ["no-token-scope", "no-token-scope", true],
  ];

  for (const category of SCOPE_CATEGORIES) {
    cases.push(
      [SCOPE_NONE, `read:${category}`, false],
      [SCOPE_NONE, `write:${category}`, false],
      [`read:${category}`, `read:${category}`, true],
      [`write:${category}`, `write:${category}`, true],
      [`write:${category}`, `read:${category}`, true],
      [`read:${category}`, `write:${category}`, false],
    );
  }

  for (const [scope, required, expected] of cases) {
    it(`hasScope(${JSON.stringify(scope)}, ${JSON.stringify(required)}) === ${expected}`, () => {
      expect(ScopeSet.parse(scope).has(required)).toBe(expected);
    });
  }

  it("has() requires all listed scopes", () => {
    expect(ScopeSet.parse("read:user,read:repository").has("read:user", "read:repository")).toBe(true);
    expect(ScopeSet.parse("read:user").has("read:user", "read:repository")).toBe(false);
  });

  it("throws on an invalid required scope (fail closed)", () => {
    expect(() => ScopeSet.parse("all").has("banana")).toThrow(InvalidScopeError);
  });
});

describe("ScopeSet.hasAny", () => {
  it("matches when any scope is held", () => {
    expect(ScopeSet.parse("read:user").hasAny("read:repository", "read:user")).toBe(true);
    expect(ScopeSet.parse("read:user").hasAny("read:repository", "write:user")).toBe(false);
  });
});

describe("ScopeSet flags", () => {
  it("public-only, empty and permission-bearing flags follow upstream", () => {
    expect(ScopeSet.parse("").publicOnly).toBe(false);
    expect(ScopeSet.parse("public-only").publicOnly).toBe(true);
    expect(ScopeSet.parse("read:user,public-only").publicOnly).toBe(true);
    expect(ScopeSet.parse("no-token-scope").empty).toBe(true);
    expect(ScopeSet.parse("").empty).toBe(true);
    expect(ScopeSet.parse("no-token-scope").hasPermissionScope()).toBe(false);
    expect(ScopeSet.parse("public-only").hasPermissionScope()).toBe(false);
    expect(ScopeSet.parse("read:user").hasPermissionScope()).toBe(true);
    expect(ScopeSet.parse("").hasPermissionScope()).toBe(false);
  });

  it("toString reproduces the normalized form", () => {
    expect(ScopeSet.parse("read:user,write:user").toString()).toBe("write:user");
    expect(ScopeSet.parse("all").toString()).toBe("all");
    expect(ScopeSet.parse("no-token-scope").toString()).toBe("");
  });
});

describe("ScopeSet.canCreateChildScope (upstream child-scope rules)", () => {
  it("never allows minting beyond the parent's grants", () => {
    expect(ScopeSet.parse("read:user").canCreateChildScope("read:user")).toBe(true);
    expect(ScopeSet.parse("read:user").canCreateChildScope("write:user")).toBe(false);
    expect(ScopeSet.parse("write:user").canCreateChildScope("read:user,write:user")).toBe(true);
    expect(ScopeSet.parse("all").canCreateChildScope("all")).toBe(true);
    expect(ScopeSet.parse("no-token-scope").canCreateChildScope("read:user")).toBe(false);
  });

  it("ignores public-only (a restriction, not a grant)", () => {
    expect(ScopeSet.parse("no-token-scope").canCreateChildScope("public-only")).toBe(true);
    expect(ScopeSet.parse("no-token-scope").canCreateChildScope("read:user,public-only")).toBe(false);
    expect(ScopeSet.parse("read:user,public-only").canCreateChildScope("read:user")).toBe(true);
  });
});

describe("enforcePublicOnlyFrom (upstream table)", () => {
  const cases: Array<[string, string, string]> = [
    ["write:user", "write:user,public-only", "public-only,write:user"],
    ["public-only,read:user", "public-only", "public-only,read:user"],
    ["write:user", "write:user", "write:user"],
    ["all", "all", "all"],
  ];
  for (const [child, parent, expected] of cases) {
    it(`${JSON.stringify(parent)} parent → ${JSON.stringify(child)} stays ${JSON.stringify(expected)}`, () => {
      expect(enforcePublicOnlyFrom(child, parent)).toBe(expected);
    });
  }
});

describe("helpers", () => {
  it("scopeStringSlice splits or returns empty", () => {
    expect(scopeStringSlice("")).toEqual([]);
    expect(scopeStringSlice("a,b")).toEqual(["a", "b"]);
  });

  it("requiredScopeNames maps level × categories", () => {
    expect(requiredScopeNames("read", ["repository"])).toEqual(["read:repository"]);
    expect(requiredScopeNames("write", ["user", "organization"])).toEqual(["write:user", "write:organization"]);
  });
});
