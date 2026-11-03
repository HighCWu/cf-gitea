/**
 * The non-UI escaper census' GUARD PINS — the gate-disjoint sites recorded
 * byte-equal instead of ported. Each block names its upstream site, the value
 * whose charset rides it, and the gate that proves the divergent byte set
 * (`!'()*` — kept by encodeURIComponent, escaped by Go; `$ & + : ; = @` —
 * escaped by encodeURIComponent, kept by Go's segment class) is unreachable.
 *
 * Pure unit: no D1, no engine — the pins are charset algebra over the gates.
 */

import { describe, expect, it } from "vitest";

import { compareUrl } from "./hooks";
import { pathEscape } from "./releases";

// The two validation gates every owner/slug segment comes out of
// (services/orgs/orgs.ts:128 VALID_USERNAME `^[\da-zA-Z][-.\w]*$`; the repos
// service VALID_REPO_NAME `^[-.\w]+$` at src/repos/service.ts:122).
const USERNAME = /^[\da-zA-Z][-.\w]*$/;
const REPO_NAME = /^[-.\w]+$/;

/** The bytes both encoders disagree on (the union of their keep-sets' diff). */
const DIVERGENT = "!'()*$&+:=@";

describe("the owner/slug family (the census' widest family — byte-equal by gate)", () => {
  it("no gate ever admits a divergent byte, and encodeURIComponent ≡ url.PathEscape on the admitted charset", () => {
    for (const sample of ["alice", "a.b-c_d", "0.9", "x-y.z_1", "A_1"]) {
      expect(USERNAME.test(sample) && REPO_NAME.test(sample)).toBe(true);
      expect(encodeURIComponent(sample)).toBe(pathEscape(sample));
    }
    for (const char of "._-") {
      // single-char repo slugs legally ride the gate-only chars
      expect(REPO_NAME.test(char)).toBe(true);
      expect(encodeURIComponent(char)).toBe(pathEscape(char));
    }
    for (const char of DIVERGENT) {
      expect(USERNAME.test(char)).toBe(false);
      expect(REPO_NAME.test(char)).toBe(false);
      expect(encodeURIComponent(char)).not.toBe(pathEscape(char));
    }
  });

  it("covers the family's upstream sites — APIURL PathEscapes, Link() raw-interpolates; both ≡ ours under the gate", () => {
    // models/repo/repo.go:362-366 APIURL(): url.PathEscape(owner) +
    // url.PathEscape(name); :337-341 Link(): raw interpolation — the API
    // (/api/v1/repos/...) and HTML (/<owner>/<slug>/...) families across
    // src/api/services + src/api/routes + src/services/mail + src/services/lfs
    // + src/git-http all emit the same bytes under the gate either way.
    const owner = "a.b-c_d";
    const slug = "x-y.z_1";
    expect(`${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`).toBe(`${owner}/${slug}`);
    expect(`api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}`).toBe(
      `api/v1/repos/${pathEscape(owner)}/${pathEscape(slug)}`,
    );
  });
});

describe("the sha family (commit-status/commit URLs — commit_status.go:211-214)", () => {
  it("a 40-hex oid carries no divergent byte — upstream's url.PathEscape(status.SHA) ≡ ours", () => {
    const sha = "1234123412341234123412341234123412341234";
    expect(encodeURIComponent(sha)).toBe(sha);
    expect(encodeURIComponent(sha)).toBe(pathEscape(sha));
    // upstream CommitStatus.APIURL() = Repo.APIURL() + "/statuses/" +
    // url.PathEscape(SHA) — the hex charset is what the test corpus rides
    // (models/git/commit_status_test.go:43 pins the same bytes).
  });
});

describe("the attachment uuid family (attachment.go:66-76 DownloadURL)", () => {
  it("a crypto-random uuid (hex + dashes) is byte-equal under both encoders", () => {
    const uuid = "8dbc70cc-9cf6-4b9f-9212-b1a8ab82d0d0";
    expect(encodeURIComponent(uuid)).toBe(uuid);
    expect(`attachments/${encodeURIComponent(uuid)}`).toBe(`attachments/${pathEscape(uuid)}`);
    // upstream: AppSubURL + "/attachments/" + url.PathEscape(a.UUID).
  });
});

describe("the chef version tails (chef.go:73/187/251 ride the RAW version)", () => {
  it("the CHEF_VERSION_PATTERN gate ([0-9.]) is disjoint from the divergent set — ours ≡ raw upstream", () => {
    const CHEF_VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)?$/;
    for (const version of ["1.0.1", "2.10.3", "0.0.9"]) {
      expect(CHEF_VERSION_PATTERN.test(version)).toBe(true);
      expect(encodeURIComponent(version)).toBe(version);
    }
    for (const char of DIVERGENT) {
      expect(CHEF_VERSION_PATTERN.test(`1${char}0`)).toBe(false);
    }
  });
});

describe("the swift scope/name segments (swift.go:40-42 upload gates)", () => {
  it("the scope/name charsets are disjoint from the divergent set — encodeURIComponent ≡ PathEscape ≡ upstream", () => {
    const SCOPE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/;
    const NAME = /^[a-zA-Z0-9][a-zA-Z0-9-_]{0,99}$/;
    for (const sample of ["test-scope", "pkg_name2", "A1"]) {
      expect(SCOPE.test(sample) || NAME.test(sample)).toBe(true);
      expect(encodeURIComponent(sample)).toBe(pathEscape(sample));
    }
    for (const char of DIVERGENT) {
      expect(SCOPE.test(char)).toBe(false);
      expect(NAME.test(char)).toBe(false);
    }
  });
});

describe("the pub/composer name gates (pub metadata.go:27, composer metadata.go:119)", () => {
  it("both name gates are disjoint from the divergent set — byte-equal segments", () => {
    const PUB_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
    // composer metadata.go:119: \A[a-z0-9]([_.-]?[a-z0-9]+)*/[a-z0-9](([_\.]?|-{0,2})[a-z0-9]+)*\z
    const COMPOSER_NAME = /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9](([_.]?|-{0,2})[a-z0-9]+)*$/;
    expect(PUB_NAME.test("test_package")).toBe(true);
    expect(COMPOSER_NAME.test("a/b_c.pkg")).toBe(true);
    expect(encodeURIComponent("test_package")).toBe(pathEscape("test_package"));
    expect(encodeURIComponent("b_c.pkg")).toBe(pathEscape("b_c.pkg"));
    for (const char of DIVERGENT) {
      expect(PUB_NAME.test(char)).toBe(false);
      expect(COMPOSER_NAME.test(`a${char}b`)).toBe(false);
    }
  });
});

describe("the webhook compare_url family (repo.go:564-566 ComposeCompareURL)", () => {
  it("oid values ride PathEscapeSegments upstream byte-equal to our raw join (hex charset)", () => {
    const zero = "0".repeat(40);
    const tip = "abcdef1234abcdef1234abcdef1234abcdef1234";
    // upstream: PathEscape(owner)/PathEscape(name) + PathEscapeSegments(oid)s;
    // ours (hooks.ts compareUrl) raw-joins — same bytes on the gated +
    // hex charsets both sides ride.
    expect(compareUrl(
      { repo: { ownerNamespace: "alice", slug: "hooks-repo" } } as Parameters<typeof compareUrl>[0],
      zero,
      tip,
    )).toBe(`alice/hooks-repo/compare/${zero}...${tip}`);
    expect(encodeURIComponent(tip)).toBe(tip);
    expect(pathEscape(tip)).toBe(tip);
  });
});
