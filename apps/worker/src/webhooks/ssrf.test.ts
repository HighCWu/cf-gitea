/**
 * Unit tests for the webhook egress guard (§3.6 Egress) — pure URL/IP logic
 * ported from gitea/modules/egress/policy (matchlist_test.go/policy_test.go
 * vectors).
 */

import { describe, expect, it } from "vitest";

import { checkWebhookTarget, classifyAddress, parseHostPolicy, parseIpLiteral } from "./ssrf";

const lax = parseHostPolicy(undefined, "lax");

const ip = (host: string) => {
  const parsed = parseIpLiteral(host);
  if (parsed === null) throw new Error(`not an IP literal: ${host}`);
  return parsed;
};

function decision(url: string, policy = lax): boolean {
  return checkWebhookTarget(new URL(url), policy).allowed;
}

describe("address classification (upstream classifyAddr)", () => {
  it("classifies the IPv4 classes", () => {
    expect(classifyAddress(ip("8.8.8.8"))).toBe("public");
    expect(classifyAddress(ip("127.0.0.1"))).toBe("restricted"); // loopback
    expect(classifyAddress(ip("10.1.2.3"))).toBe("restricted"); // private
    expect(classifyAddress(ip("172.16.0.1"))).toBe("restricted");
    expect(classifyAddress(ip("192.168.1.1"))).toBe("restricted");
    expect(classifyAddress(ip("100.64.0.1"))).toBe("restricted"); // CGNAT
    expect(classifyAddress(ip("169.254.169.254"))).toBe("restricted"); // metadata
    expect(classifyAddress(ip("0.0.0.1"))).toBe("reserved");
    expect(classifyAddress(ip("224.0.0.1"))).toBe("reserved"); // multicast
    expect(classifyAddress(ip("240.0.0.1"))).toBe("reserved");
  });

  it("classifies IPv6 and unmaps IPv4-mapped literals", () => {
    expect(classifyAddress(ip("::1"))).toBe("restricted"); // loopback
    expect(classifyAddress(ip("fe80::1"))).toBe("restricted"); // link-local
    expect(classifyAddress(ip("fd00::1"))).toBe("restricted"); // ULA
    expect(classifyAddress(ip("2606:4700::1111"))).toBe("public");
    // ::ffff:127.0.0.1 unmapped → loopback (upstream "block ipv4-mapped")
    expect(ip("::ffff:127.0.0.1")).toEqual(ip("127.0.0.1"));
    expect(classifyAddress(ip("::ffff:127.0.0.1"))).toBe("restricted");
    expect(ip("2001:db8::1").bytes).toHaveLength(16);
    expect(ip("1:2:3:4:5:6:7:8").bytes).toHaveLength(16);
    expect(parseIpLiteral("1::2::3")).toBeNull(); // two compressions
    expect(parseIpLiteral("12345::")).toBeNull(); // bad group
    expect(parseIpLiteral("fe80::1%eth0")).toBeNull(); // zone not dialable
    expect(parseIpLiteral("0177.0.0.1")).toBeNull(); // Go netip rejects non-decimal
  });
});

describe("default lax posture (empty list — upstream default)", () => {
  it("allows public targets", () => {
    expect(decision("https://example.com/hook")).toBe(true);
    expect(decision("http://example.com:8443/hook")).toBe(true); // lax: any port
    expect(decision("https://8.8.8.8/hook")).toBe(true);
  });

  it("default-denies loopback, private, link-local and metadata IPs", () => {
    expect(decision("http://127.0.0.1:3000/hook")).toBe(false);
    expect(decision("http://[::1]/hook")).toBe(false);
    expect(decision("http://10.0.0.5/hook")).toBe(false);
    expect(decision("http://192.168.1.10/hook")).toBe(false);
    expect(decision("http://172.20.1.4/hook")).toBe(false);
    expect(decision("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(decision("http://100.100.100.100/hook")).toBe(false); // CGNAT
  });

  it("always denies reserved ranges, even when listed", () => {
    expect(decision("http://224.0.0.5/hook")).toBe(false);
    expect(decision("http://240.0.0.1/hook", parseHostPolicy("240.0.0.0/4", "lax"))).toBe(false);
  });

  it("rejects non-http(s) schemes", () => {
    expect(decision("ftp://example.com/hook")).toBe(false);
    expect(decision("file:///etc/passwd")).toBe(false);
  });
});

describe("explicit allow entries", () => {
  it("widens loopback for local receivers (named range)", () => {
    const policy = parseHostPolicy("loopback", "lax");
    expect(decision("http://127.0.0.1:8787/hook", policy)).toBe(true);
    expect(decision("http://[::1]:8787/hook", policy)).toBe(true);
    expect(decision("http://10.0.0.5/hook", policy)).toBe(false); // loopback ≠ private
  });

  it("widens private ranges (named range covers CGNAT + ULA)", () => {
    const policy = parseHostPolicy("private", "lax");
    expect(decision("http://10.1.2.3/hook", policy)).toBe(true);
    expect(decision("http://100.64.1.1/hook", policy)).toBe(true); // CGNAT is in `private`
    expect(decision("http://[fd00::5]/hook", policy)).toBe(true);
    expect(decision("http://127.0.0.1/hook", policy)).toBe(false);
  });

  it("matches CIDR and IP-literal entries with ports", () => {
    const policy = parseHostPolicy("192.168.0.0/16, [::1]:9000, 10.0.0.9:8080-8090", "lax");
    expect(decision("http://192.168.3.4/hook", policy)).toBe(true);
    // 192.167.0.1 is public and unmatched → still allowed in lax (strict block covers the negative)
    expect(decision("http://[::1]:9000/hook", policy)).toBe(true);
    expect(decision("http://[::1]:9001/hook", policy)).toBe(false);
    expect(decision("http://10.0.0.9:8090/hook", policy)).toBe(true);
    expect(decision("http://10.0.0.9:9000/hook", policy)).toBe(false);
  });

  it("allows any hostname by default (unresolved targets are allowed in lax)", () => {
    expect(decision("https://anything.example.com/x")).toBe(true);
    expect(decision("https://hooks.example.com/x", parseHostPolicy("other.com", "lax"))).toBe(true);
  });

  it("matches hostname patterns dot-anchored (strict)", () => {
    const policy = parseHostPolicy("hooks.example.com, .sub.example.org", "strict");
    expect(decision("https://hooks.example.com/x", policy)).toBe(true);
    expect(decision("https://api.hooks.example.com/x", policy)).toBe(true);
    expect(decision("https://nothooks.example.com/x", policy)).toBe(false); // dot-anchored
    expect(decision("https://a.sub.example.org/x", policy)).toBe(true);
    expect(decision("https://sub.example.org/x", policy)).toBe(false); // subdomains only
    // a hostname entry is never enough for a restricted literal target
    expect(decision("http://127.0.0.1/x", parseHostPolicy("hooks.example.com", "lax"))).toBe(false);
  });
});

describe("strict mode (EGRESS_MODE=strict)", () => {
  it("requires every target to match the allow list", () => {
    const policy = parseHostPolicy("example.com", "strict");
    expect(decision("https://example.com/hook", policy)).toBe(true);
    expect(decision("https://other.com/hook", policy)).toBe(false);
    expect(decision("http://8.8.8.8/hook", policy)).toBe(false); // public still needs a match
  });

  it("denies unlisted public IPs and CIDR misses", () => {
    const policy = parseHostPolicy("192.168.0.0/16", "strict");
    expect(decision("http://8.8.8.8/hook", policy)).toBe(false);
    expect(decision("http://192.167.0.1/hook", policy)).toBe(false); // outside the /16
    expect(decision("http://192.168.255.255/hook", policy)).toBe(true);
  });

  it("restricts portless entries to the web ports", () => {
    const policy = parseHostPolicy("example.com", "strict");
    expect(decision("https://example.com:443/x", policy)).toBe(true);
    expect(decision("http://example.com:80/x", policy)).toBe(true);
    expect(decision("http://example.com:8443/x", policy)).toBe(false);
    const anyPort = parseHostPolicy("example.com:*", "strict");
    expect(decision("http://example.com:8443/x", anyPort)).toBe(true);
  });

  it("collects rejected entries without failing the whole list", () => {
    const policy = parseHostPolicy("example.com, *, bad::!!", "strict");
    expect(policy.rejected.length).toBe(2);
    expect(decision("https://example.com/x", policy)).toBe(true);
  });
});
