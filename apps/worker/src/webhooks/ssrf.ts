/**
 * Webhook egress guard (SPEC-0005 §3.6 "Egress") — upstream
 * `security.ALLOWED_HOST_LIST` semantics ported to the Workers constraint set
 * (gitea/modules/egress/policy, gitea/modules/setting/security.go).
 *
 * Posture mirrors upstream's default ("lax" mode, empty list):
 *
 * - **Lax** (default): public targets and unresolved hostnames are allowed;
 *   non-public addresses (loopback, private, link-local incl. the cloud
 *   metadata endpoint 169.254.169.254, CGNAT, special-use ranges) need an
 *   explicit IP-form allow entry (CIDR, IP literal, or the `private` /
 *   `loopback` named ranges) — a bare hostname entry is not enough, exactly
 *   like upstream's `WithLocalNeedsIPAllow`. Reserved ranges are always denied.
 * - **Strict** (`WEBHOOK_EGRESS_MODE=strict`): every target must match the
 *   allow list; a portless entry covers only the web ports (80/443).
 *
 * Deliberate platform-constrained deviation from upstream: Go re-checks the
 * *resolved* dial address (anti-rebinding dial hook, `NewDialContext`).
 * workerd performs its own DNS resolution and exposes no dial hook, so the
 * check here is name- and IP-literal-based. Production Workers cannot route
 * to RFC1918/link-local addresses anyway; the guard keeps loopback private
 * (local dev, e2e receivers) and preserves the operator allow-list contract.
 *
 * List syntax (upstream `parseList`): comma-separated entries of `host`,
 * `*.host` / `.host` (subdomains only), IP literal, CIDR, the named ranges
 * `private` and `loopback`, each optionally suffixed `:port`, `:lo-hi`, `:*`
 * or `:[p|p-p|...]` (`[v6]:port` for IPv6 literals).
 */

export type EgressMode = "lax" | "strict";

/** A parsed `host[:portspec]` hostname rule. */
interface HostRule {
  /** httpproxy match model: `example.com` matches the host and its subdomains; `*.example.com`/`.example.com` subdomains only. */
  pattern: string;
  ports: PortRange[];
}

/** A parsed CIDR / IP-literal / named-range address rule. */
interface IpRule {
  /** 16-byte big-endian network address (IPv4 rules keep v4 form: bytes 0–11 zero). */
  prefix: Uint8Array;
  /** Prefix length in bits over the canonical 128-bit form (v4 = 96 + bits). */
  bits: number;
  /** Address family (netip.Prefix.Contains matches only its own family). */
  isV4: boolean;
  ports: PortRange[];
}

interface PortRange {
  start: number;
  end: number;
}

export interface HostPolicy {
  mode: EgressMode;
  allow: { hosts: HostRule[]; ips: IpRule[] };
  /** Entries dropped at parse time (upstream logs them at startup). */
  rejected: string[];
}

const V4_OFFSET = 12; // canonical 128-bit form of an IPv4 address starts at byte 12

// ---------------------------------------------------------------------------
// IP parsing / classification (netip.ParseAddr + classifyAddr ports)
// ---------------------------------------------------------------------------

/** Parse a dotted-quad IPv4 literal; digits only (Go netip rejects octal-ish forms). */
function parseIPv4(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 4; i++) {
    const part = parts[i]!;
    if (part.length === 0 || part.length > 3) return null;
    let value = 0;
    for (const ch of part) {
      if (ch < "0" || ch > "9") return null;
      value = value * 10 + (ch.charCodeAt(0) - 48);
    }
    if (value > 255) return null;
    out[V4_OFFSET + i] = value;
  }
  return out;
}

function hexGroup(text: string): number | null {
  if (text.length === 0 || text.length > 4) return null;
  let value = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    const digit =
      code >= 48 && code <= 57
        ? code - 48
        : code >= 97 && code <= 102
          ? code - 87
          : code >= 65 && code <= 70
            ? code - 55
            : -1;
    if (digit < 0) return null;
    value = value * 16 + digit;
  }
  return value;
}

/** Parse an IPv6 literal (no zone, no brackets) into 16 big-endian bytes. */
function parseIPv6(text: string): Uint8Array | null {
  // Optional embedded IPv4 tail (::ffff:1.2.3.4) becomes the last two groups.
  let body = text;
  let v4Groups: number[] | null = null;
  const lastColon = body.lastIndexOf(":");
  if (lastColon >= 0 && body.indexOf(".", lastColon) >= 0) {
    const tail = parseIPv4(body.slice(lastColon + 1));
    if (tail === null) return null;
    v4Groups = [(tail[V4_OFFSET]! << 8) | tail[V4_OFFSET + 1]!, (tail[V4_OFFSET + 2]! << 8) | tail[V4_OFFSET + 3]!];
    body = body.slice(0, lastColon + 1);
    if (body.endsWith(":")) body = body.slice(0, -1); // "::ffff:" -> "::ffff", "::" -> ":"
    if (body === ":") body = ""; // the "::" degenerated; empty-side handling covers it
  }

  const headGroups: number[] = [];
  const tailGroups: number[] = [];
  const pushGroups = (target: number[], source: string): boolean => {
    if (source === "") return true;
    for (const part of source.split(":")) {
      const value = hexGroup(part);
      if (value === null) return false;
      target.push(value);
    }
    return true;
  };

  const doubleColon = body.indexOf("::");
  let compressed = false;
  if (doubleColon >= 0) {
    if (body.indexOf("::", doubleColon + 1) >= 0) return null; // at most one "::"
    compressed = true;
    if (!pushGroups(headGroups, body.slice(0, doubleColon))) return null;
    if (!pushGroups(tailGroups, body.slice(doubleColon + 2))) return null;
  } else if (!pushGroups(headGroups, body)) {
    return null;
  }

  const v4Count = v4Groups !== null ? 2 : 0;
  const fill = 8 - headGroups.length - v4Count - tailGroups.length;
  if (compressed ? fill < 0 : fill !== 0) return null;

  const bytes = new Uint8Array(16);
  let offset = 0;
  const write = (value: number): void => {
    bytes[offset] = value >> 8;
    bytes[offset + 1] = value & 0xff;
    offset += 2;
  };
  for (const group of headGroups) write(group);
  for (let i = 0; i < fill; i++) write(0);
  for (const group of tailGroups) write(group);
  if (v4Groups !== null) for (const group of v4Groups) write(group);
  return bytes;
}

/** IPv4-mapped test (::ffff:a.b.c.d): bytes 0–9 zero, bytes 10–11 = 0xffff. */
function isIPv4Mapped(addr: Uint8Array): boolean {
  for (let i = 0; i < 10; i++) {
    if (addr[i] !== 0) return false;
  }
  return addr[10] === 0xff && addr[11] === 0xff;
}

/** A canonical 128-bit address plus its family (netip keeps the family off the bytes). */
export interface ParsedIp {
  bytes: Uint8Array;
  isV4: boolean;
}

/**
 * Parse `host` as an IP literal (v4, v6, or v4-mapped v6) into the canonical
 * 128-bit form; IPv4-mapped addresses are unmapped (Go `netip.Addr.Unmap`).
 */
export function parseIpLiteral(host: string): ParsedIp | null {
  // WHATWG URL.hostname keeps the brackets on IPv6 literals.
  const text = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (text.includes(":")) {
    const parsed = parseIPv6(text);
    if (parsed === null) return null;
    if (isIPv4Mapped(parsed)) {
      const v4 = new Uint8Array(16);
      v4.set(parsed.subarray(V4_OFFSET), V4_OFFSET);
      return { bytes: v4, isV4: true };
    }
    return { bytes: parsed, isV4: false };
  }
  if (text.includes(".")) {
    const parsed = parseIPv4(text);
    return parsed === null ? null : { bytes: parsed, isV4: true };
  }
  return null;
}

function cidrContains(addr: Uint8Array, isV4: boolean, rule: IpRule): boolean {
  if (rule.isV4 !== isV4) return false; // netip.Prefix.Contains matches only its own family
  if (rule.bits === 0) return true;
  let remaining = rule.bits;
  let byteIndex = 0;
  while (remaining > 0) {
    const mask = remaining >= 8 ? 0xff : 0xff << (8 - remaining);
    if ((addr[byteIndex]! & mask) !== (rule.prefix[byteIndex]! & mask)) return false;
    remaining -= 8;
    byteIndex++;
  }
  return true;
}

function rangeNetwork(cidr: string): ParsedIp {
  const addr = parseIpLiteral(cidr.slice(0, cidr.lastIndexOf("/")));
  if (addr === null) throw new Error(`internal: bad range ${cidr}`);
  return addr;
}

/** Prefix bits for a CIDR string, normalized to the 128-bit form (v4 gets +96). */
function rangeBits(cidr: string): number {
  const addr = rangeNetwork(cidr);
  const bits = Number(cidr.slice(cidr.lastIndexOf("/") + 1));
  return addr.isV4 ? bits + 96 : bits;
}

// Upstream restrictedRanges — dialable only when explicitly allowed (policy/policy.go:433–455).
const RESTRICTED_RANGES: string[] = [
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // TEST-NET-1
  "192.31.196.0/24", // AS112
  "192.52.193.0/24", // AMT
  "192.175.48.0/24", // AS112
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // TEST-NET-2
  "203.0.113.0/24", // TEST-NET-3
  "100::/64", // discard-only
  "100:0:0:1::/64", // dummy
  "2001::/23", // IETF protocol assignments
  "2001:db8::/32", // documentation
  "2620:4f:8000::/48", // AS112
  "3fff::/20", // documentation
  "5f00::/16", // SRv6 SIDs
  "fec0::/10", // site-local
];

// Upstream reservedRanges — never dialable, always denied (policy/policy.go:412–430).
const RESERVED_RANGES: string[] = [
  "0.0.0.0/8", // "this network"
  "168.63.129.16/32", // Azure WireServer
  "192.88.99.0/24", // 6to4 relay anycast
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved, incl. limited broadcast
  "::/96", // IPv4-compatible, embeds IPv4
  "::ffff:0:0:0/96", // IPv4-translated, embeds IPv4
  "64:ff9b::/96", // wkp NAT64
  "64:ff9b:1::/48", // local-use NAT64
  "2001::/32", // Teredo, embeds IPv4
  "2002::/16", // 6to4, embeds IPv4
  "ff00::/8", // multicast
];

function staticRule(cidr: string): IpRule {
  const network = rangeNetwork(cidr);
  return {
    prefix: network.bytes,
    bits: rangeBits(cidr),
    isV4: network.isV4,
    ports: [{ start: 0, end: 65535 }],
  };
}

const RESTRICTED: IpRule[] = RESTRICTED_RANGES.map(staticRule);
const RESERVED: IpRule[] = RESERVED_RANGES.map(staticRule);

export type AddressClass = "public" | "restricted" | "reserved";

/** Port of upstream `classifyAddr` (policy/policy.go:458–466). */
export function classifyAddress(parsed: ParsedIp): AddressClass {
  const { bytes: addr, isV4 } = parsed;
  const isLoopback = isV4
    ? addr[V4_OFFSET] === 127
    : addr[15] === 1 && addr.slice(0, 15).every((b) => b === 0);
  if (!isLoopback && RESERVED.some((rule) => cidrContains(addr, isV4, rule))) return "reserved";
  if (
    isLoopback ||
    RESTRICTED.some((rule) => cidrContains(addr, isV4, rule)) ||
    // private: 10/8, 172.16/12, 192.168/16, fc00::/7 — plus CGNAT 100.64/10
    (isV4 &&
      (addr[V4_OFFSET] === 10 ||
        (addr[V4_OFFSET] === 172 && (addr[V4_OFFSET + 1]! & 0xf0) === 16) ||
        (addr[V4_OFFSET] === 192 && addr[V4_OFFSET + 1] === 168) ||
        (addr[V4_OFFSET] === 100 && (addr[V4_OFFSET + 1]! & 0xc0) === 64))) ||
    (!isV4 && (addr[0]! & 0xfe) === 0xfc) ||
    // link-local unicast: 169.254/16, fe80::/10 (cloud metadata lives here)
    (isV4 && addr[V4_OFFSET] === 169 && addr[V4_OFFSET + 1] === 254) ||
    (!isV4 && addr[0] === 0xfe && (addr[1]! & 0xc0) === 0x80)
  ) {
    return "restricted";
  }
  return "public";
}

// ---------------------------------------------------------------------------
// Allow-list parsing (upstream matchlist.go)
// ---------------------------------------------------------------------------

function parsePortItem(item: string): PortRange | string {
  const dash = item.indexOf("-");
  const loText = dash < 0 ? item : item.slice(0, dash);
  const hiText = dash < 0 ? undefined : item.slice(dash + 1);
  const parse = (text: string): number | string => {
    const trimmed = text.trim();
    if (!/^[1-9][0-9]*$/.test(trimmed) || Number(trimmed) > 65535) {
      return `invalid port ${JSON.stringify(text)}`;
    }
    return Number(trimmed);
  };
  const start = parse(loText);
  if (typeof start === "string") return start;
  let end = start;
  if (hiText !== undefined) {
    const parsedEnd = parse(hiText);
    if (typeof parsedEnd === "string") return parsedEnd;
    end = parsedEnd;
  }
  if (start > end) return `reversed port range ${JSON.stringify(item)}`;
  return { start, end };
}

/** Portless entries: every port in lax, only web ports in strict (matchlist.go:318–324). */
function defaultPorts(mode: EgressMode): PortRange[] {
  return mode === "strict"
    ? [
        { start: 80, end: 80 },
        { start: 443, end: 443 },
      ]
    : [{ start: 0, end: 65535 }];
}

function parsePortSpec(spec: string, mode: EgressMode): { ports: PortRange[]; error?: string } {
  if (spec === "") return { ports: defaultPorts(mode) };
  if (spec === "*") return { ports: [{ start: 0, end: 65535 }] };
  if (spec.startsWith("[") && spec.endsWith("]")) {
    const inner = spec.slice(1, -1);
    if (inner === "") return { ports: [], error: `empty port set ${JSON.stringify(spec)}` };
    const ports: PortRange[] = [];
    for (const item of inner.split("|")) {
      const range = parsePortItem(item);
      if (typeof range === "string") return { ports: [], error: range };
      ports.push(range);
    }
    return { ports };
  }
  const range = parsePortItem(spec);
  return typeof range === "string" ? { ports: [], error: range } : { ports: [range] };
}

function splitEntry(entry: string): { target: string; portSpec: string } | string {
  if (entry.startsWith("[")) {
    const end = entry.indexOf("]");
    if (end < 0) return "missing closing bracket";
    const target = entry.slice(1, end);
    if (target === "") return "empty host";
    const rest = entry.slice(end + 1);
    if (rest === "") return { target, portSpec: "" };
    if (!rest.startsWith(":")) return `unexpected ${JSON.stringify(rest)} after bracketed target`;
    if (rest.length === 1) return "empty port";
    return { target, portSpec: rest.slice(1) };
  }
  if (entry.includes("::")) return { target: entry, portSpec: "" }; // bare IPv6
  const colon = entry.indexOf(":");
  if (colon >= 0 && entry.indexOf(":", colon + 1) < 0) {
    const target = entry.slice(0, colon);
    const portSpec = entry.slice(colon + 1);
    if (target === "") return `empty host: '${entry}'`;
    if (portSpec === "") return `empty port: '${entry}'`;
    return { target, portSpec };
  }
  return { target: entry, portSpec: "" };
}

/** Named range aliases (matchlist.go:61–75): private ranges + CGNAT, loopback. */
const NAMED_RANGES: Record<string, string[]> = {
  private: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7", "100.64.0.0/10"],
  loopback: ["127.0.0.0/8", "::1/128"],
};

function namedRangeRules(target: string, ports: PortRange[]): IpRule[] | null {
  const cidrs = NAMED_RANGES[target];
  if (cidrs === undefined) return null;
  return cidrs.map((cidr) => {
    const network = rangeNetwork(cidr);
    return { prefix: network.bytes, bits: rangeBits(cidr), isV4: network.isV4, ports };
  });
}

/** httpproxy match model (matchDomain): `example.com` matches host + subdomains; `*.x`/`.x` subdomains only. */
function matchHostPattern(pattern: string, host: string): boolean {
  if (pattern.startsWith("*.") || pattern.startsWith(".")) {
    const suffix = pattern.startsWith("*.") ? pattern.slice(1) : pattern;
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return pattern === host || host.endsWith(`.${pattern}`);
}

function validDomainPattern(pattern: string): boolean {
  let p = pattern;
  if (p.startsWith("*.") || p.startsWith(".")) p = p.slice(1);
  if (p === "" || /[^\x21-\x7e]/.test(p)) return false;
  return !/[*?[\]/:\\ ]/.test(p);
}

function parseList(
  hostList: string,
  mode: EgressMode,
): { hosts: HostRule[]; ips: IpRule[]; rejected: string[] } {
  const hosts: HostRule[] = [];
  const ips: IpRule[] = [];
  const rejected: string[] = [];
  for (const rawEntry of hostList.split(",")) {
    const entry = rawEntry.trim();
    if (entry === "") continue;
    const split = splitEntry(entry);
    if (typeof split === "string") {
      rejected.push(`failed to split entry ${entry}: ${split}`);
      continue;
    }
    const portSpec = parsePortSpec(split.portSpec, mode);
    if (portSpec.error !== undefined) {
      rejected.push(`invalid port syntax on entry ${entry}: ${portSpec.error}`);
      continue;
    }
    let target = split.target.toLowerCase().trim();
    while (target.endsWith(".")) target = target.slice(0, -1);

    const named = namedRangeRules(target, portSpec.ports);
    if (named !== null) {
      ips.push(...named);
      continue;
    }
    if (target.includes("/")) {
      const slash = target.lastIndexOf("/");
      const network = parseIpLiteral(target.slice(0, slash));
      const bitsText = target.slice(slash + 1);
      const bits = /^\d+$/.test(bitsText) ? Number(bitsText) : -1;
      const maxBits = network !== null && network.isV4 ? 32 : 128;
      if (network === null || bits < 1 || bits > maxBits) {
        rejected.push(`invalid CIDR ${JSON.stringify(target)}`);
        continue;
      }
      if (bits === 0) {
        rejected.push(`catch-all CIDR ${JSON.stringify(target)} covers every address and is not allowed`);
        continue;
      }
      ips.push({
        prefix: network.bytes,
        bits: network.isV4 ? bits + 96 : bits,
        isV4: network.isV4,
        ports: portSpec.ports,
      });
      continue;
    }
    const literal = parseIpLiteral(target);
    if (literal !== null) {
      ips.push({ prefix: literal.bytes, bits: 128, isV4: literal.isV4, ports: portSpec.ports });
      continue;
    }
    if (target === "*") {
      rejected.push('catch-all host pattern "*" matches every host and is not allowed');
      continue;
    }
    if (target === "external") {
      rejected.push('the "external" builtin was replaced by EGRESS_MODE = lax');
      continue;
    }
    if (!validDomainPattern(target)) {
      rejected.push(
        `target ${JSON.stringify(target)} is not an IP, CIDR, named range, or valid hostname pattern`,
      );
      continue;
    }
    hosts.push({ pattern: target, ports: portSpec.ports });
  }
  return { hosts, ips, rejected };
}

/** Compile a `WEBHOOK_ALLOWED_HOST_LIST` value into a checkable policy. */
export function parseHostPolicy(hostList: string | undefined, mode: EgressMode = "lax"): HostPolicy {
  const allow = parseList(hostList ?? "", mode);
  return { mode, allow: { hosts: allow.hosts, ips: allow.ips }, rejected: allow.rejected };
}

function portAllowed(ports: PortRange[], port: number): boolean {
  return ports.some((range) => port >= range.start && port <= range.end);
}

function matchIpRules(rules: IpRule[], addr: Uint8Array, isV4: boolean, port: number): boolean {
  return rules.some((rule) => cidrContains(addr, isV4, rule) && portAllowed(rule.ports, port));
}

function matchHostRules(rules: HostRule[], host: string, port: number): boolean {
  return rules.some((rule) => matchHostPattern(rule.pattern, host) && portAllowed(rule.ports, port));
}

export interface EgressDecision {
  allowed: boolean;
  /** Upstream-style denial message naming the setting; empty when allowed. */
  reason: string;
}

/**
 * Screen a webhook target URL (upstream `Policy.CheckHost`). The URL must be
 * http(s); IP-literal targets are classified directly; hostnames are screened
 * by name (lax: allowed; strict: must match an entry). See the module header
 * for the resolution caveat.
 */
export function checkWebhookTarget(url: URL, policy: HostPolicy): EgressDecision {
  const usage = "webhook delivery";
  const key = "WEBHOOK_ALLOWED_HOST_LIST";
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      allowed: false,
      reason: `${usage}: only http(s) webhook targets are supported, deny '${url.href}'`,
    };
  }
  const host = url.hostname.toLowerCase();
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  const deny = (extra: string): EgressDecision => ({
    allowed: false,
    reason: `${usage} ${extra}, deny '${url.href}' (check ${key})`,
  });

  const literal = parseIpLiteral(host);
  if (literal !== null) {
    const addressClass = classifyAddress(literal);
    if (addressClass === "reserved") {
      return { allowed: false, reason: `${usage} can not call reserved addresses, deny '${url.href}'` };
    }
    if (matchIpRules(policy.allow.ips, literal.bytes, literal.isV4, port)) {
      return { allowed: true, reason: "" };
    }
    if (policy.mode === "lax" && addressClass === "public") return { allowed: true, reason: "" };
    return deny("needs an explicit IP allow entry (non-public address)");
  }

  // Hostname target: name-based screening (module header caveat applies).
  if (matchHostRules(policy.allow.hosts, host, port)) return { allowed: true, reason: "" };
  if (policy.mode === "lax") return { allowed: true, reason: "" };
  return deny("can only call allowed HTTP servers");
}
