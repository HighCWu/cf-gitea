/**
 * The licenses family's detector + push arm (services/repo-licenses.ts):
 *
 *   - `detectLicenseText` — the SPARSE-corpus matcher over
 *     license-corpus.ts: every corpus entry detects its own canonical text
 *     exactly, wild wrapping/case/formatting variants cancel, the
 *     specificity rules resolve the documented cross-matches (AGPL vs
 *     GPL-3.0 at 0.91-0.93 text overlap, BSD-2 verbatim inside BSD-3,
 *     GPL-3.0 verbatim inside the combined LGPL-3.0 corpus file), a
 *     dual-licensed file reports both ids, and non-license text answers [].
 *   - `syncRepoLicensesFromCell` — the push settle walk over a FAKE engine
 *     cell (the WebhookPushWalk fetchImpl precedent) on real D1: the
 *     default-branch gate (only a default-branch create/update scans; the
 *     empty-repo skip), the REUSE LICENSES/ arm, the root license-file walk
 *     feeding updateRepoLicenses, and the no-match sweep.
 *   - the end-to-end arm — a REAL push through the SPEC-0003 gate with the
 *     production engine composition (the webhooks-push.test.ts harness,
 *     trimmed): receive → finalize → onPush → repo_license rows → the
 *     `GET /repos/{owner}/{repo}/licenses` contract answering real rows.
 */

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDurableGit, type DurableGitHandler } from "@cf-gitea/git-engine";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../auth/testing/seeds";
import { authorize } from "../git-http/authorize";
import { gitHttpGate } from "../git-http/gate";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createOptionalTokenAuthMiddleware } from "../api/auth";
import { giteaErrorHandler } from "../api/errors";
import { registerRepoLicenseRoutes } from "../api/routes/repo-licenses";
import type { ApiEnv } from "../api/env";
import { users } from "../db/schema";
import { RepoService } from "../repos/service";
import {
  detectLicenseText,
  getRepoLicenses,
  syncRepoLicensesFromCell,
  type LicenseEngineCell,
} from "./repo-licenses";
import { LICENSE_CORPUS_TEXTS } from "./license-corpus";
import { handleUserPushEvent } from "./webhooks-push";

// ---------------------------------------------------------------------------
// detectLicenseText — the sparse corpus matcher
// ---------------------------------------------------------------------------

describe("detectLicenseText (the sparse corpus matcher)", () => {
  it("every corpus entry detects its own canonical text, exactly (no cross-matches)", () => {
    for (const [spdxId, text] of LICENSE_CORPUS_TEXTS) {
      expect(detectLicenseText(text), spdxId).toEqual([spdxId]);
    }
  });

  it("wild wrapping/case/formatting variance cancels out (the normal form)", () => {
    const [, mit] = LICENSE_CORPUS_TEXTS.find(([id]) => id === "MIT")!;
    const [, apache] = LICENSE_CORPUS_TEXTS.find(([id]) => id === "Apache-2.0")!;
    const [, gpl3] = LICENSE_CORPUS_TEXTS.find(([id]) => id === "GPL-3.0")!;
    expect(detectLicenseText(mit.toUpperCase().split("\n").join("\r\n"))).toEqual(["MIT"]);
    expect(detectLicenseText(mit.split("\n").map((line) => `   ${line}   `).join("\n"))).toEqual(["MIT"]);
    expect(detectLicenseText(`Copyright (c) 2026 Example Corp\n\n${mit}`)).toEqual(["MIT"]);
    // The appendix is extra TARGET text — corpus-relative coverage is unaffected.
    expect(detectLicenseText(apache.split("APPENDIX:")[0]!)).toEqual(["Apache-2.0"]);
    expect(detectLicenseText(`${gpl3}\nHow to Apply These Terms to Your New Programs\n...boilerplate...`)).toEqual([
      "GPL-3.0",
    ]);
  });

  it("the specificity rules resolve the documented cross-matches", () => {
    const textOf = (id: string) => LICENSE_CORPUS_TEXTS.find(([corpusId]) => corpusId === id)![1];
    // AGPL-3.0 text carries ~91% of the GPL-3.0 corpus and vice versa — the
    // near-max dominance rule (module header rule (a)) keeps only the self.
    expect(detectLicenseText(textOf("AGPL-3.0"))).toEqual(["AGPL-3.0"]);
    expect(detectLicenseText(textOf("GPL-3.0"))).toEqual(["GPL-3.0"]);
    // BSD-2's text is verbatim inside BSD-3's (and vice versa below 0.98):
    // corpus subsumption (rule (b)) reports the specific license only.
    expect(detectLicenseText(textOf("BSD-3-Clause"))).toEqual(["BSD-3-Clause"]);
    expect(detectLicenseText(textOf("BSD-2-Clause"))).toEqual(["BSD-2-Clause"]);
    // Upstream's combined LGPL-3.0 corpus file embeds the GPL-3.0 text —
    // rule (b) again (documented divergence: upstream reports both).
    expect(detectLicenseText(textOf("LGPL-3.0"))).toEqual(["LGPL-3.0"]);
    // LGPL-2.1 references GPL-2.0 but does not embed it: 0.78 < threshold.
    expect(detectLicenseText(textOf("LGPL-2.1"))).toEqual(["LGPL-2.1"]);
  });

  it("a dual-licensed file (both texts concatenated) reports both ids, sorted", () => {
    const textOf = (id: string) => LICENSE_CORPUS_TEXTS.find(([corpusId]) => corpusId === id)![1];
    expect(detectLicenseText(`${textOf("MIT")}\n\n${textOf("GPL-3.0")}`)).toEqual(["GPL-3.0", "MIT"]);
  });

  it("non-license and empty content answers [] (nothing invented)", () => {
    expect(detectLicenseText("")).toEqual([]);
    expect(detectLicenseText("# MyProject\n\nBuild with make. See the license file for details.\n")).toEqual([]);
    expect(detectLicenseText("MIT text")).toEqual([]); // too short to reach any corpus
  });
});

// ---------------------------------------------------------------------------
// syncRepoLicensesFromCell — the push settle walk over a fake cell
// ---------------------------------------------------------------------------

/** A fixture engine cell over a flat path→(content|children) map. */
interface FixtureNode {
  /** Blob content; a directory entry when children are present. */
  content?: string;
  children?: Record<string, FixtureNode>;
  mode?: string;
}

function fakeCell(tree: Record<string, FixtureNode>, tip = "tip-oid"): LicenseEngineCell {
  const encoder = new TextEncoder();
  const childOf = (path: string): FixtureNode | null => {
    const segments = path.split("/").filter((segment) => segment.length > 0);
    let node: FixtureNode = { children: tree };
    for (const segment of segments) {
      const parent = node.children;
      if (parent === undefined) return null;
      const next = parent[segment];
      if (next === undefined) return null;
      node = next;
    }
    return node;
  };
  return {
    readCommit: (id) => Promise.resolve(id === "refs/heads/main" ? { oid: tip } : null),
    listTree: (ref, path) => {
      if (ref !== tip) return Promise.resolve(null);
      const node = childOf(path ?? "");
      if (node === null) return Promise.resolve(null);
      const names = node.children ? Object.keys(node.children) : [];
      return Promise.resolve({
        entries: names.map((name) => {
          const child = node.children![name]!;
          return child.children !== undefined
            ? { name, mode: "040000", type: "tree" as const }
            : { name, mode: child.mode ?? "100644", type: "blob" as const };
        }),
      });
    },
    readBlob: (ref, path) => {
      if (ref !== tip) return Promise.resolve(null);
      const node = childOf(path);
      return Promise.resolve(node !== null && node.content !== undefined ? { data: encoder.encode(node.content) } : null);
    },
  };
}

const DEFAULT_UPDATE = { ref: "refs/heads/main", next: "tip-oid" };

async function seedRepo(slug: string): Promise<string> {
  const existing = await drizzle(env.DB).select({ id: users.id, username: users.username }).from(users).limit(1).all();
  const alice =
    existing[0] !== undefined ? existing[0] : await seedVerifiedUser({ username: "Alice" });
  const row = await new RepoService(env.DB).create({
    owner: { id: alice.id, usernameLower: alice.username.toLowerCase() },
    name: slug,
    isPrivate: false,
  });
  return row.id;
}

async function licenseRows(repoId: string): Promise<Array<{ license: string; licensePath: string; commitId: string | null }>> {
  const rows = await getRepoLicenses(env.DB, repoId);
  return rows.map((row) => ({ license: row.license, licensePath: row.licensePath, commitId: row.commitId }));
}

describe("syncRepoLicensesFromCell (the push settle walk)", () => {
  beforeAll(async () => {
    await applyAuthD1Migrations();
  });

  beforeEach(async () => {
    for (const table of ["repo_license", "repo_counters", "repo_units", "repo_redirects", "repositories", "personal_access_tokens", "users"]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    await seedVerifiedUser({ username: "Alice" });
  });

  it("a default-branch push with an MIT LICENSE writes the row at the tip oid", async () => {
    const repoId = await seedRepo("pushed");
    await syncRepoLicensesFromCell(
      env.DB,
      fakeCell({ "LICENSE": { content: LICENSE_CORPUS_TEXTS.find(([id]) => id === "MIT")![1] }, "README.md": { content: "hi" } }),
      { id: repoId, defaultBranch: "main" },
      [DEFAULT_UPDATE],
    );
    expect(await licenseRows(repoId)).toEqual([{ license: "MIT", licensePath: "LICENSE", commitId: "tip-oid" }]);
  });

  it("the REUSE LICENSES/ arm claims the resolution with file-stem SPDX ids", async () => {
    const repoId = await seedRepo("reuse");
    await syncRepoLicensesFromCell(
      env.DB,
      fakeCell({
        "LICENSE": { content: "ignored when LICENSES/ exists" },
        "LICENSES": { children: { "MIT.txt": { content: "..." }, "GPL-3.0-only.txt": { content: "..." } } },
      }),
      { id: repoId, defaultBranch: "main" },
      [DEFAULT_UPDATE],
    );
    expect(await licenseRows(repoId)).toEqual([
      { license: "GPL-3.0-only", licensePath: "LICENSES/GPL-3.0-only.txt", commitId: "tip-oid" },
      { license: "MIT", licensePath: "LICENSES/MIT.txt", commitId: "tip-oid" },
    ]);
  });

  it("a second scan with no license file sweeps the stale rows (the clean arm)", async () => {
    const repoId = await seedRepo("swept");
    const withLicense = fakeCell({ "LICENSE": { content: LICENSE_CORPUS_TEXTS.find(([id]) => id === "ISC")![1] } });
    await syncRepoLicensesFromCell(env.DB, withLicense, { id: repoId, defaultBranch: "main" }, [DEFAULT_UPDATE]);
    expect(await licenseRows(repoId)).toHaveLength(1);
    // The next tip carries no license file — updateRepoLicenses' stale-commit
    // sweep removes the row (license.go:206-208's CleanRepoLicenses arm).
    await syncRepoLicensesFromCell(
      env.DB,
      fakeCell({ "README.md": { content: "no license anymore" } }, "tip-oid-2"),
      { id: repoId, defaultBranch: "main" },
      [{ ref: "refs/heads/main", next: "tip-oid-2" }],
    );
    expect(await licenseRows(repoId)).toEqual([]);
  });

  it("gates: an unborn default branch, other-branch pushes, and default-branch DELETES never scan", async () => {
    const repoId = await seedRepo("unborn");
    // An unborn branch (the engine answers readCommit null) — the exact
    // subject upstream's IsEmpty guard protects (license.go:79-81).
    const unbornCell: LicenseEngineCell = {
      readCommit: () => Promise.resolve(null),
      listTree: () => Promise.reject(new Error("must not be reached")),
      readBlob: () => Promise.reject(new Error("must not be reached")),
    };
    await syncRepoLicensesFromCell(env.DB, unbornCell, { id: repoId, defaultBranch: "main" }, [DEFAULT_UPDATE]);
    expect(await licenseRows(repoId)).toEqual([]);

    const cell = fakeCell({ "LICENSE": { content: "MIT" } });
    await syncRepoLicensesFromCell(env.DB, cell, { id: repoId, defaultBranch: "main" }, [
      { ref: "refs/heads/feature", next: "tip-oid" },
    ]);
    expect(await licenseRows(repoId)).toEqual([]);

    // push.go:160-174 — the updater enqueues only inside !IsDelRef().
    await syncRepoLicensesFromCell(env.DB, cell, { id: repoId, defaultBranch: "main" }, [
      { ref: "refs/heads/main", next: "0".repeat(40) },
    ]);
    expect(await licenseRows(repoId)).toEqual([]);
  });

  it("a stale is_empty row still scans (the documented divergence: the unborn-tip guard is authoritative)", async () => {
    // cf-gitea's repositories.is_empty is stale for the API-created
    // population (only the push-create settle flips it — git-http/gate.ts;
    // the general flip is an engine-wave gap). Upstream's consumer sees the
    // flag already cleared because its queue is async; our synchronous leg
    // treats an applied default-branch update as the non-emptiness proof.
    const repoId = await seedRepo("staleflag");
    await env.DB.prepare("UPDATE repositories SET is_empty = 1 WHERE id = ?").bind(repoId).run();
    await syncRepoLicensesFromCell(
      env.DB,
      fakeCell({ "LICENSE": { content: LICENSE_CORPUS_TEXTS.find(([id]) => id === "MIT")![1] } }),
      { id: repoId, defaultBranch: "main" },
      [DEFAULT_UPDATE],
    );
    expect(await licenseRows(repoId)).toEqual([{ license: "MIT", licensePath: "LICENSE", commitId: "tip-oid" }]);
  });

  it("non-regular and non-license-file entries are ignored (the walk mirrors upstream)", async () => {
    const repoId = await seedRepo("pickym");
    await syncRepoLicensesFromCell(
      env.DB,
      fakeCell({
        "LICENSE": { content: LICENSE_CORPUS_TEXTS.find(([id]) => id === "MIT")![1] },
        "LICENSE.sh": { content: "not a license file name" },
        "docs": { children: { "LICENSE": { content: "subdirectory files are not walked" } } },
      }),
      { id: repoId, defaultBranch: "main" },
      [DEFAULT_UPDATE],
    );
    expect(await licenseRows(repoId)).toEqual([{ license: "MIT", licensePath: "LICENSE", commitId: "tip-oid" }]);
  });
});

// ---------------------------------------------------------------------------
// The end-to-end arm: a REAL push through the gate lands license rows
// (webhooks-push.test.ts's harness, trimmed — pack primitives are test-file
// copies, the originals keep their byte helpers private)
// ---------------------------------------------------------------------------

const TE = new TextEncoder();

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha1Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-1", bytes));
}

async function sha1Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
}

async function zlibDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function be32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function rawOid(oidHex: string): Uint8Array {
  const raw = new Uint8Array(20);
  for (let i = 0; i < 20; i++) raw[i] = Number.parseInt(oidHex.slice(i * 2, i * 2 + 2), 16);
  return raw;
}

function objectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  let rest = size >> 4;
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest >>= 7;
  }
  bytes.push(first);
  return new Uint8Array(bytes);
}

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;

interface ChainFile {
  path: string;
  content: string;
}

interface ChainCommit {
  message: string;
  files: ChainFile[];
  time: number;
}

async function buildChainPack(parent: string | null, commits: ChainCommit[]): Promise<{ tips: string[]; pack: Uint8Array }> {
  const objects = new Map<string, { type: number; body: Uint8Array }>();
  const store = async (type: number, body: Uint8Array): Promise<string> => {
    const typeName = type === OBJ_COMMIT ? "commit" : type === OBJ_TREE ? "tree" : "blob";
    const raw = concatBytes(TE.encode(`${typeName} ${body.length}\0`), body);
    const oid = await sha1Hex(raw);
    if (!objects.has(oid)) objects.set(oid, { type, body });
    return oid;
  };
  const tips: string[] = [];
  let parentOid = parent;
  for (const commit of commits) {
    const entries: { sortKey: string; bytes: Uint8Array }[] = [];
    for (const file of commit.files) {
      const blobOid = await store(OBJ_BLOB, TE.encode(file.content));
      entries.push({ sortKey: file.path, bytes: concatBytes(TE.encode(`100644 ${file.path}\0`), rawOid(blobOid)) });
    }
    entries.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    const treeOid = await store(OBJ_TREE, concatBytes(...entries.map((e) => e.bytes)));
    const person = (who: "author" | "committer") => `${who} Test User <test@example.com> ${commit.time} +0000`;
    const commitBody =
      `tree ${treeOid}\n` +
      (parentOid !== null ? `parent ${parentOid}\n` : "") +
      `${person("author")}\n${person("committer")}\n\n${commit.message}\n`;
    const commitOid = await store(OBJ_COMMIT, TE.encode(commitBody));
    parentOid = commitOid;
    tips.push(commitOid);
  }
  const chunks: Uint8Array[] = [TE.encode("PACK"), be32(2), be32(objects.size)];
  for (const obj of objects.values()) {
    chunks.push(objectHeader(obj.type, obj.body.length));
    chunks.push(await zlibDeflate(obj.body));
  }
  chunks.push(await sha1Bytes(concatBytes(...chunks)));
  return { tips, pack: concatBytes(...chunks) };
}

// The engine under test — the entrypoint's exact composition (index.ts) with
// the onPush seam wired to the production adapter, so the receive → finalize
// → onPush → license-sync path IS the production path.
const wiredEngine = createDurableGit<Env>({
  authorize,
  ui: false,
  namespaces: true,
  onPush: (event, env2) => handleUserPushEvent(env2, event),
});

class NoopSpan {
  get isTraced(): boolean {
    return false;
  }
  spanContext(): { traceId: string; spanId: string; traceFlags: number } {
    return { traceId: "0".repeat(32), spanId: "0".repeat(16), traceFlags: 0 };
  }
  setAttribute(): this {
    return this;
  }
  setAttributes(): this {
    return this;
  }
  recordException(): void {}
  updateName(): this {
    return this;
  }
  setStatus(): this {
    return this;
  }
  end(): void {}
}

const EXPORTS_HOLE = undefined as never;
const pendingWaits: Promise<unknown>[] = [];
const ctx: ExecutionContext = {
  waitUntil: (promise) => {
    pendingWaits.push(Promise.resolve(promise));
  },
  passThroughOnException: () => {},
  abort: () => {},
  exports: EXPORTS_HOLE,
  props: undefined,
  tracing: {
    enterSpan: <T, A extends unknown[]>(_: string, callback: (span: NoopSpan, ...args: A) => T, ...args: A): T =>
      callback(new NoopSpan(), ...args),
    startActiveSpan: <T, A extends unknown[]>(_: string, callback: (span: NoopSpan, ...args: A) => T, ...args: A): T =>
      callback(new NoopSpan(), ...args),
    startSpan: () => new NoopSpan(),
    getActiveSpan: () => undefined,
    Span: NoopSpan,
  },
};

async function drainWaits(): Promise<void> {
  for (let round = 0; round < 10 && pendingWaits.length > 0; round++) {
    const batch = pendingWaits.splice(0, pendingWaits.length);
    await Promise.allSettled(batch);
  }
}

const ORIGIN = "https://example.com";
const RECEIVE_CT = "application/x-git-receive-pack-request";
const PUSH_ZERO_OID = "0".repeat(40);

interface PushCommand {
  old: string;
  oid: string;
  ref: string;
}

function commandSection(commands: PushCommand[]): Uint8Array {
  let section = "";
  commands.forEach((cmd, i) => {
    const line = i === 0 ? `${cmd.old} ${cmd.oid} ${cmd.ref}\0report-status side-band-64k` : `${cmd.old} ${cmd.oid} ${cmd.ref}`;
    section += `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
  });
  return TE.encode(`${section}0000`);
}

async function pushThroughGate(
  ownerNamespace: string,
  slug: string,
  engine: DurableGitHandler<Env>,
  commands: PushCommand[],
  pack: Uint8Array | null,
  token: string,
): Promise<Response> {
  const base = `${ORIGIN}/${ownerNamespace}/${slug}.git`;
  const advert = await gitHttpGate(
    new Request(`${base}/info/refs?service=git-receive-pack`, { headers: { authorization: basicTokenHeader(token) } }),
    env,
    ctx,
    engine,
  );
  expect(advert.status).toBe(200);
  const section = commandSection(commands);
  const body = pack === null ? section : concatBytes(section, pack);
  const response = await gitHttpGate(
    new Request(`${base}/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body,
    }),
    env,
    ctx,
    engine,
  );
  await drainWaits();
  return response;
}

/** The standalone `GET /repos/{owner}/{repo}/licenses` mount (the routes
 *  suite's convention) — the acceptance surface reads the rows the push
 *  landed. */
function licensesRoute(): (path: string) => Promise<Response> {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  registerRepoLicenseRoutes(app, createOptionalTokenAuthMiddleware({ resolveToken: () => Promise.resolve(null) }));
  return async (path: string) => app.fetch(new Request(`https://example.com${path.replace(/^\/api\/v1/, "")}`), env);
}

describe("the push arm end-to-end (receive → onPush → repo_license rows)", () => {
  beforeAll(async () => {
    await applyAuthD1Migrations();
  });

  beforeEach(async () => {
    for (const table of ["repo_license", "repo_counters", "repo_units", "repo_redirects", "repositories", "webhook_deliveries", "webhooks", "personal_access_tokens", "users"]) {
      await env.DB.prepare(`DELETE FROM ${table}`).run();
    }
    await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
  });

  it("a first push carrying an MIT LICENSE lands the row and the endpoint answers it", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const row = await new RepoService(env.DB, { registry: env.REGISTRY.getByName("registry") }).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "licensed",
      isPrivate: false,
    });
    const token = (await mintFor(alice.id, "licensed-write", "write:repository")).plaintext;
    const mit = LICENSE_CORPUS_TEXTS.find(([id]) => id === "MIT")![1];
    const { tips, pack } = await buildChainPack(null, [
      { message: "seed", files: [{ path: "LICENSE", content: mit }, { path: "README.md", content: "hi\n" }], time: 1700000000 },
    ]);
    const tip = tips[0]!;

    const response = await pushThroughGate(
      row.ownerNamespace,
      row.slug,
      wiredEngine,
      [{ old: PUSH_ZERO_OID, oid: tip, ref: "refs/heads/main" }],
      pack,
      token,
    );
    expect(response.status).toBe(200);

    const rows = await getRepoLicenses(env.DB, row.id);
    expect(rows.map((r) => [r.license, r.licensePath, r.commitId])).toEqual([["MIT", "LICENSE", tip]]);
    const endpoint = await licensesRoute()(`/api/v1/repos/alice/licensed/licenses`);
    expect(endpoint.status).toBe(200);
    expect(await endpoint.json()).toEqual(["MIT"]);
  });

  it("a push touching only another branch leaves the table alone", async () => {
    const alice = await seedVerifiedUser({ username: "Alice" });
    const row = await new RepoService(env.DB, { registry: env.REGISTRY.getByName("registry") }).create({
      owner: { id: alice.id, usernameLower: "alice" },
      name: "branchy",
      isPrivate: false,
    });
    const token = (await mintFor(alice.id, "branchy-write", "write:repository")).plaintext;
    const mit = LICENSE_CORPUS_TEXTS.find(([id]) => id === "MIT")![1];
    const { tips, pack } = await buildChainPack(null, [
      { message: "seed", files: [{ path: "LICENSE", content: mit }], time: 1700000000 },
      { message: "feature work", files: [{ path: "LICENSE", content: mit }, { path: "feat.txt", content: "x\n" }], time: 1700000001 },
    ]);
    await pushThroughGate(
      row.ownerNamespace,
      row.slug,
      wiredEngine,
      [{ old: PUSH_ZERO_OID, oid: tips[0]!, ref: "refs/heads/main" }],
      pack,
      token,
    );
    expect((await getRepoLicenses(env.DB, row.id)).map((r) => r.license)).toEqual(["MIT"]);

    // The second pack carries only the new commit's objects; the parent
    // resolves from the receiving cell (the connectivity check's contract).
    const feature = await buildChainPack(tips[0]!, [
      { message: "more feature", files: [{ path: "LICENSE", content: mit }, { path: "feat.txt", content: "y\n" }], time: 1700000002 },
    ]);
    await pushThroughGate(
      row.ownerNamespace,
      row.slug,
      wiredEngine,
      [{ old: PUSH_ZERO_OID, oid: feature.tips[0]!, ref: "refs/heads/feature" }],
      feature.pack,
      token,
    );
    // Still exactly the main-branch row at the main tip — no feature-branch scan.
    expect((await getRepoLicenses(env.DB, row.id)).map((r) => [r.license, r.commitId])).toEqual([["MIT", tips[0]!]]);
  });
});
