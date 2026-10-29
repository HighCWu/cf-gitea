/**
 * The Helm protocol battery (SPEC-0016 §7 M3, §6) on real D1 + the real
 * REPO_PACKS binding — upstream routers/api/packages/helm/helm.go at the pin:
 *
 *  - the chart upload round-trip (a real gzip+tar chart with Chart.yaml) →
 *    201, the index.yaml document (apiVersion v1, the entries pins, urls,
 *    created, serverInfo.contextPath — parsed back with the yaml package),
 *    and the chart bytes served with BYTE PARITY;
 *  - the .prov arm: clearsign plaintext parses as Chart.yaml, lands under
 *    the .prov name with IsLead false (its GET never bumps the download
 *    counter — the chart's does);
 *  - the upstream arms: missing Chart.yaml → 400 "Chart.yaml file is
 *    missing", missing apiVersion → 400 "chart is invalid", empty name →
 *    400 "package name is invalid", non-semver version → 400 "package
 *    version is invalid", corrupt gzip → 500, prov against a missing
 *    version → 404, chart re-publish OVERWRITES (OverwriteExisting: true);
 *  - auth (401 challenge arms, anonymous downloads of a public owner),
 *    quota 403, 411, PACKAGES_ENABLED=false.
 */

import { Hono } from "hono";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { parse as yamlParse } from "yaml";

import { packageVersions, users } from "../../db/schema";
import { createEcosystemProtocolRouter } from "./packages-protocols";
import { mintFor } from "../../auth/testing/seeds";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  for (const table of [
    "package_properties",
    "package_files",
    "package_blobs",
    "package_versions",
    "package_cleanup_rules",
    "packages",
    "personal_access_tokens",
    "auth_failures",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  for (const prefix of ["packages/tmp/", "packages/blobs/"]) {
    const listed = await env.REPO_PACKS.list({ prefix });
    await env.REPO_PACKS.delete(listed.objects.map((object) => object.key));
  }
});

const db = () => drizzle(env.DB);

interface SeededUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

async function seedUser(
  username: string,
  opts: { isAdmin?: boolean; visibility?: "public" | "limited" | "private" } = {},
): Promise<SeededUser> {
  const rows = await db()
    .insert(users)
    .values({
      username,
      usernameLower: username.toLowerCase(),
      isAdmin: opts.isAdmin ?? false,
      status: "active",
      type: "user",
      visibility: opts.visibility ?? "public",
      createdAt: new Date("2026-10-29T12:00:00Z"),
    })
    .returning()
    .all();
  const user = rows[0];
  if (user === undefined) throw new Error("user seed failed");
  return { id: user.id, username: user.username, isAdmin: user.isAdmin };
}

async function token(user: SeededUser, scopes: string): Promise<string> {
  return (await mintFor(user.id, `pat-${scopes}`, scopes)).plaintext;
}

const authHeaders = (plaintext: string): Record<string, string> => ({
  Authorization: `token ${plaintext}`,
});

/** The REAL mount shape: index.ts mounts the sub-app at /api/packages. */
function protocol(overrides: Record<string, string> = {}) {
  const parent = new Hono<{ Bindings: Env }>();
  parent.route("/api/packages", createEcosystemProtocolRouter());
  const boundEnv = { ...env, ...overrides };
  return async (path: string, init?: RequestInit): Promise<Response> =>
    parent.fetch(new Request(`https://example.com${path}`, init), boundEnv);
}

// ---------------------------------------------------------------------------
// Chart-archive builders — a real tar (512-byte headers) gzipped through the
// platform's CompressionStream, and a clearsign-shaped provenance file.
// ---------------------------------------------------------------------------

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const encoder = new TextEncoder();

function tarMember(name: string, content: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  header.set(encoder.encode(name).subarray(0, 100), 0);
  header.set(encoder.encode("0000644\0"), 100); // mode
  header.set(encoder.encode("0000000\0"), 108); // uid
  header.set(encoder.encode("0000000\0"), 116); // gid
  header.set(encoder.encode(`${content.byteLength.toString(8).padStart(11, "0")}\0`), 124); // size
  header.set(encoder.encode("00000000000\0"), 136); // mtime
  header.set(encoder.encode("        "), 148); // checksum placeholder (spaces)
  header[156] = 0x30; // TypeReg
  header.set(encoder.encode("ustar\x00" + "00"), 257);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.set(encoder.encode(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  const padding = new Uint8Array((512 - (content.byteLength % 512)) % 512);
  return concatBytes([header, content, padding]);
}

function buildTar(members: Uint8Array[]): Uint8Array {
  // The archive terminator: two zero blocks.
  return concatBytes([...members, new Uint8Array(1024)]);
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const CHART_YAML = (overrides: Record<string, string> = {}): string => {
  const fields = {
    apiVersion: "v2",
    name: "demo",
    version: "0.1.0",
    description: "A demo chart",
    home: "https://example.com/demo",
    ...overrides,
  };
  return Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
};

async function makeChartTgz(chartName: string, yaml: string): Promise<Uint8Array> {
  return gzipBytes(buildTar([tarMember(`${chartName}/Chart.yaml`, encoder.encode(yaml))]));
}

/** Chart payload with binary richness — proves byte parity through gzip+R2. */
const CHART_PAYLOAD_FILLER = Uint8Array.from({ length: 1024 }, (_, i) => (i * 7) % 251);

/** A chart tgz whose trailing filler keeps the bytes non-trivial. */
async function makeChartTgzWithFiller(chartName: string, yaml: string, filler: Uint8Array): Promise<Uint8Array> {
  return gzipBytes(
    buildTar([
      tarMember(`${chartName}/Chart.yaml`, encoder.encode(yaml)),
      tarMember(`${chartName}/values.yaml`, filler),
    ]),
  );
}

function makeProv(yaml: string): Uint8Array {
  return encoder.encode(
    `-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\n${yaml}\n-----BEGIN PGP SIGNATURE-----\naGVsbG8gd29ybGQ=\n-----END PGP SIGNATURE-----\n`,
  );
}

const RAW_POST = (body: Uint8Array, headers: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-length": String(body.byteLength), ...headers },
  body,
});

/** Push a chart with the standard Chart.yaml — the suites' fixture. */
async function pushChart(
  owner: string,
  name: string,
  version: string,
  content: Uint8Array,
  headers: Record<string, string> = {},
): Promise<Response> {
  // name/version ride INSIDE the chart's Chart.yaml (the registry never takes
  // them from the URL) — the args only document the fixture.
  void name;
  void version;
  return protocol()(`/api/packages/${owner}/helm/api/charts`, RAW_POST(content, headers));
}

// ---------------------------------------------------------------------------
// The round-trip: chart+prov → index.yaml pins → bytes
// ---------------------------------------------------------------------------

describe("helm chart+prov upload → index.yaml → download", () => {
  it("round-trips a chart: 201 → index.yaml pins → byte-parity download + counter", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const tgz = await makeChartTgzWithFiller("demo", CHART_YAML(), CHART_PAYLOAD_FILLER);
    const put = await pushChart("alice", "demo", "0.1.0", tgz, authHeaders(writer));
    expect(put.status).toBe(201);
    await put.text();

    // The index document: parse it back and pin every upstream field.
    const index = await protocol()("/api/packages/alice/helm/index.yaml");
    expect(index.status).toBe(200);
    const doc = yamlParse(await index.text()) as {
      apiVersion: string;
      generated: string;
      serverInfo: { contextPath: string };
      entries: Record<string, Record<string, unknown>[]>;
    };
    expect(doc.apiVersion).toBe("v1");
    expect(doc.generated).toContain(new Date().getFullYear().toString());
    expect(doc.serverInfo.contextPath).toBe("/api/packages/alice/helm");
    const entries = doc.entries["demo"] ?? [];
    expect(entries).toHaveLength(1);
    const entry = entries[0] as Record<string, unknown>;
    expect(entry.apiVersion).toBe("v2");
    expect(entry.name).toBe("demo");
    expect(entry.version).toBe("0.1.0");
    expect(entry.description).toBe("A demo chart");
    expect(entry.home).toBe("https://example.com/demo");
    expect(entry.urls).toEqual(["https://example.com/api/packages/alice/helm/demo-0.1.0.tgz"]);
    expect(typeof entry.created).toBe("string");

    // The chart bytes download under the canonical filename — EXACT parity.
    const get = await protocol()("/api/packages/alice/helm/demo-0.1.0.tgz");
    expect(get.status).toBe(200);
    expect(get.headers.get("content-disposition")).toContain("demo-0.1.0.tgz");
    const served = new Uint8Array(await get.arrayBuffer());
    expect(served.byteLength).toBe(tgz.byteLength);
    expect([...served]).toEqual([...tgz]);

    // The lead-file GET bumped the download counter.
    const rows = await db().select().from(packageVersions).all();
    expect(rows[0]?.downloadCount).toBe(1);
    expect(JSON.parse(rows[0]?.metadataJson as string)).toMatchObject({ api_version: "v2", name: "demo" });
  });

  it("groups versions under the chart name; sorts entry names; a second chart appears", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    for (const [name, version] of [
      ["zeta", "1.0.0"],
      ["alpha", "2.0.0"],
      ["alpha", "1.0.0"],
    ] as const) {
      const put = await pushChart(
        "alice",
        name,
        version,
        await makeChartTgz(name, CHART_YAML({ name, version })),
        authHeaders(writer),
      );
      expect(put.status).toBe(201);
      await put.text();
    }
    const doc = yamlParse(await (await protocol()("/api/packages/alice/helm/index.yaml")).text()) as {
      entries: Record<string, unknown[]>;
    };
    // Map keys render sorted (go-yaml's own behavior).
    expect(Object.keys(doc.entries)).toEqual(["alpha", "zeta"]);
    expect(doc.entries["alpha"]).toHaveLength(2);
    const versions = (doc.entries["alpha"] as Record<string, unknown>[]).map((entry) => entry.version);
    expect(versions).toContain("1.0.0");
    expect(versions).toContain("2.0.0");
  });

  it("accepts a .prov against an existing version: 201, bytes served, NO counter bump", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const tgz = await makeChartTgz("signed", CHART_YAML({ name: "signed", version: "1.2.3" }));
    const chart = await pushChart("alice", "signed", "1.2.3", tgz, authHeaders(writer));
    expect(chart.status).toBe(201);
    await chart.text();

    const prov = makeProv(CHART_YAML({ name: "signed", version: "1.2.3" }));
    const put = await protocol()(
      `/api/packages/alice/helm/api/prov`,
      RAW_POST(prov, authHeaders(writer)),
    );
    expect(put.status).toBe(201);
    await put.text();

    // The chart's GET bumps the counter (lead file)...
    const chartGet = await protocol()("/api/packages/alice/helm/signed-1.2.3.tgz");
    expect(chartGet.status).toBe(200);
    await chartGet.arrayBuffer();
    // ...the prov's GET serves the bytes but never counts (IsLead: false).
    const get = await protocol()("/api/packages/alice/helm/signed-1.2.3.tgz.prov");
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(prov);

    const rows = await db().select().from(packageVersions).all();
    expect(rows[0]?.downloadCount).toBe(1);
  });

  it("re-publishing a chart version with DIFFERENT bytes OVERWRITES (OverwriteExisting)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const first = await makeChartTgzWithFiller("ow", CHART_YAML({ name: "ow", version: "1.0.0" }), encoder.encode("first-payload"));
    const initial = await pushChart("alice", "ow", "1.0.0", first, authHeaders(writer));
    expect(initial.status).toBe(201);
    await initial.text();

    const second = await makeChartTgzWithFiller("ow", CHART_YAML({ name: "ow", version: "1.0.0" }), encoder.encode("second-payload"));
    const republish = await pushChart("alice", "ow", "1.0.0", second, authHeaders(writer));
    expect(republish.status).toBe(201); // NOT a 409 — helm.go:194 OverwriteExisting
    await republish.text();

    const get = await protocol()("/api/packages/alice/helm/ow-1.0.0.tgz");
    const served = new Uint8Array(await get.arrayBuffer());
    expect([...served]).toEqual([...second]);

    // The version still answers exactly one file row (old one replaced).
    const files = await db().select().from(packageVersions).all();
    expect(files).toHaveLength(1);
  });

  it("prov against a MISSING version answers 404 (ErrPackageNotExist arm)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const put = await protocol()(
      `/api/packages/alice/helm/api/prov`,
      RAW_POST(makeProv(CHART_YAML({ name: "ghost", version: "9.9.9" })), authHeaders(writer)),
    );
    expect(put.status).toBe(404);
    expect(await put.json()).toEqual({ error: "package does not exist" });
  });
});

// ---------------------------------------------------------------------------
// The upstream chart/prov validation arms
// ---------------------------------------------------------------------------

describe("helm validation arms", () => {
  it("an archive without Chart.yaml answers 400 'Chart.yaml file is missing'", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const tgz = await gzipBytes(buildTar([tarMember("nope/values.yaml", encoder.encode("x: 1"))]));
    const put = await pushChart("alice", "nope", "1.0.0", tgz, authHeaders(writer));
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({ error: "Chart.yaml file is missing" });
  });

  it("a root-level Chart.yaml is SKIPPED (upstream requires exactly one slash)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const tgz = await gzipBytes(buildTar([tarMember("Chart.yaml", encoder.encode(CHART_YAML()))]));
    const put = await pushChart("alice", "root", "1.0.0", tgz, authHeaders(writer));
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({ error: "Chart.yaml file is missing" });
  });

  it("missing apiVersion → 'chart is invalid'; empty name → 'package name is invalid'", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const noApi = await makeChartTgz("a", CHART_YAML({ apiVersion: "" }));
    const apiPut = await pushChart("alice", "a", "1.0.0", noApi, authHeaders(writer));
    expect(apiPut.status).toBe(400);
    expect(await apiPut.json()).toEqual({ error: "chart is invalid" });

    const noName = await makeChartTgz("b", CHART_YAML({ name: "" }));
    const namePut = await pushChart("alice", "b", "1.0.0", noName, authHeaders(writer));
    expect(namePut.status).toBe(400);
    expect(await namePut.json()).toEqual({ error: "package name is invalid" });
  });

  it("a non-semver version → 'package version is invalid'", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const tgz = await makeChartTgz("c", CHART_YAML({ version: "not-semver!" }));
    const put = await pushChart("alice", "c", "x", tgz, authHeaders(writer));
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({ error: "package version is invalid" });
  });

  it("corrupt gzip → 500 (upstream maps non-InvalidArgument errors to 500)", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const junk = encoder.encode("this is not gzip at all");
    const put = await pushChart("alice", "junk", "1.0.0", junk, authHeaders(writer));
    expect(put.status).toBe(500);
    await put.json();
  });

  it("a non-clearsign prov body → 400 'provenance file is invalid'", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const put = await protocol()(
      `/api/packages/alice/helm/api/prov`,
      RAW_POST(encoder.encode("plainly not signed"), authHeaders(writer)),
    );
    expect(put.status).toBe(400);
    expect(await put.json()).toEqual({ error: "provenance file is invalid" });
  });

  it("downloading an unknown filename → 404; index.yaml wins over the :filename param", async () => {
    await seedUser("alice");
    const missing = await protocol()("/api/packages/alice/helm/ghost-1.0.0.tgz");
    expect(missing.status).toBe(404);
    await missing.json();
    // The literal index.yaml route stays reachable even before any chart.
    const index = await protocol()("/api/packages/alice/helm/index.yaml");
    expect(index.status).toBe(200);
    const doc = yamlParse(await index.text()) as { apiVersion: string; entries: Record<string, unknown> };
    expect(doc.apiVersion).toBe("v1");
    expect(Object.keys(doc.entries)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Auth, quota, enable-gate arms
// ---------------------------------------------------------------------------

describe("helm auth/quota arms", () => {
  it("anonymous upload → 401 challenge; wrong-scope token → 401 challenge", async () => {
    const owner = await seedUser("alice");
    const wrongCategory = await token(owner, "read:repository");
    const tgz = await makeChartTgz("denied", CHART_YAML({ name: "denied" }));

    const anon = await pushChart("alice", "denied", "1.0.0", tgz);
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await anon.text();

    const scoped = await pushChart("alice", "denied", "1.0.0", tgz, authHeaders(wrongCategory));
    expect(scoped.status).toBe(401);
    expect(scoped.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await scoped.text();
  });

  it("a PUBLIC owner's charts download anonymously; a PRIVATE owner's are the challenge", async () => {
    const owner = await seedUser("alice");
    const privateOwner = await seedUser("stealth", { visibility: "private" });
    const writer = await token(owner, "write:package");
    const stealthWriter = await token(privateOwner, "write:package");
    await pushChart("alice", "pub", "1.0.0", await makeChartTgz("pub", CHART_YAML({ name: "pub", version: "1.0.0" })), authHeaders(writer));
    await pushChart(
      "stealth",
      "sec",
      "1.0.0",
      await makeChartTgz("sec", CHART_YAML({ name: "sec", version: "1.0.0" })),
      authHeaders(stealthWriter),
    );

    const publicGet = await protocol()("/api/packages/alice/helm/pub-1.0.0.tgz");
    expect(publicGet.status).toBe(200);
    await publicGet.arrayBuffer();

    const privateGet = await protocol()("/api/packages/stealth/helm/sec-1.0.0.tgz");
    expect(privateGet.status).toBe(401);
    expect(privateGet.headers.get("www-authenticate")).toBe('Basic realm="Gitea Package API"');
    await privateGet.text();
  });

  it("the 403 quota arm (owner-total var override) and the admin bypass", async () => {
    const owner = await seedUser("alice");
    const admin = await seedUser("root", { isAdmin: true });
    const writer = await token(owner, "write:package");
    const adminWriter = await token(admin, "write:package");
    const tgz = await makeChartTgz("big", CHART_YAML({ name: "big" }));

    const limited = protocol({ PACKAGES_LIMIT_TOTAL_OWNER_SIZE: "4" });
    const denied = await limited("/api/packages/alice/helm/api/charts", RAW_POST(tgz, authHeaders(writer)));
    expect(denied.status).toBe(403);
    await denied.json();

    const allowed = await pushChart("alice", "big", "1.0.0", tgz, authHeaders(writer));
    expect(allowed.status).toBe(201);
    await allowed.text();
    const adminPut = await pushChart("root", "big", "1.0.0", tgz, authHeaders(adminWriter));
    void adminPut;
    const adminIndex = await protocol()("/api/packages/root/helm/index.yaml", {});
    expect(adminIndex.status).toBe(200);
    const doc = yamlParse(await adminIndex.text()) as { entries: Record<string, unknown[]> };
    expect(Object.keys(doc.entries)).toEqual(["big"]);
  });

  it("the count-quota boundary (+1 parity): the Nth publish reaches the cap, the (N+1)th 403s", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    // LIMIT = 2. Upstream inserts the version THEN checks count > limit inside
    // the rolling-back transaction (packages.go:188-191 with the throw at
    // 380-381), so the publish that REACHES the limit passes and only one
    // past 403s — a pre-insert `count > limit` check would allow one version
    // MORE than upstream at exactly this boundary. The chart's name/version
    // ride INSIDE Chart.yaml, so each publish carries its own archive.
    const capped = protocol({ PACKAGES_LIMIT_TOTAL_OWNER_COUNT: "2" });
    const cappedPut = async (version: string): Promise<Response> => {
      const tgz = await makeChartTgz("bnd", CHART_YAML({ name: "bnd", version }));
      return capped("/api/packages/alice/helm/api/charts", RAW_POST(tgz, authHeaders(writer)));
    };

    // N-1 → N: the publish that REACHES the limit succeeds (1 + 1 ≤ 2).
    const reach = await cappedPut("1.0.0");
    expect(reach.status).toBe(201);
    await reach.text();
    // The Nth publish succeeds with the owner exactly AT the limit (2 + 1 →
    // count 2; 2 > 2 is false upstream).
    const atLimit = await cappedPut("2.0.0");
    expect(atLimit.status).toBe(201);
    await atLimit.text();

    // The (N+1)th publish past the cap → 403 ErrQuotaTotalCount, and the
    // rollback posture leaves the two landed versions untouched.
    const over = await cappedPut("3.0.0");
    expect(over.status).toBe(403);
    expect((await over.json<{ error: string }>()).error).toBe("package quota count limit exceeded");
    expect((await db().select().from(packageVersions).all())).toHaveLength(2);
  });

  it("411s without Content-Length; PACKAGES_ENABLED=false 404s the family", async () => {
    const owner = await seedUser("alice");
    const writer = await token(owner, "write:package");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("chunked"));
        controller.close();
      },
    });
    const noLength = await protocol()("/api/packages/alice/helm/api/charts", {
      method: "POST",
      headers: authHeaders(writer),
      body: stream,
      // @ts-expect-error duplex is the streams spec's required pairing
      duplex: "half",
    });
    expect(noLength.status).toBe(411);
    await noLength.json();

    const disabled = protocol({ PACKAGES_ENABLED: "false" });
    const index = await disabled("/api/packages/alice/helm/index.yaml");
    expect(index.status).toBe(404);
    await index.text();
    const upload = await disabled("/api/packages/alice/helm/api/charts", { method: "POST", body: "x" });
    expect(upload.status).toBe(404);
    await upload.text();
  });
});
