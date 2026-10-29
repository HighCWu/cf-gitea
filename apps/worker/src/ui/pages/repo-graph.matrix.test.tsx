/**
 * The commit-graph page's matrix (pages/repo-graph.tsx mounted through the
 * uiRouter — SPEC-0017 M2, the census R09 render half over the M1 graphData
 * RPC). The page module's doc carries the upstream citations; THIS file arms
 * the SPEC §6 worker plan:
 *
 *   - the PARSE CLAIMS: the exact bare `/graph` literal claimed to the graph
 *     family (no ref suffix, no deeper tails — the engine's 404 answers
 *     those), trailing-slash canonicalization;
 *   - the PURE pins: parseGraphQuery's arms (the mode normalization,
 *     FormBool, the `...flow-hide-pr-refs` sentinel flip, div-only),
 *     branchRefs' commit.go:120-127 normalization, graphGeometry's
 *     5px/12px formula against hand-built rows (the merge-bend geometries),
 *     paginatorPages' Go-port window shapes;
 *   - the MOUNT arms over the engine-seeded MERGE fixture (a workerd pack
 *     builder with multi-parent commits — the check-graph.mjs MAIN fixture
 *     shape: linear run, side branch, two-parent merge, a three-parent
 *     octopus, an annotated + a lightweight tag, a remote ref, a
 *     pull-only commit reachable only through refs/pull/2/head, every
 *     committer timestamp distinct per §5's date-tie ledger): the five
 *     JS-selector ids, the SVG geometry off the REAL engine rows, the
 *     dropdown's full-ref data-values, ?branch= narrowing + the deleted-
 *     branch fallback, the hide-pr-refs posture, ?div-only=true serving
 *     only the body fragment, the hybrid pager's both arms, and the
 *     empty-repo/unborn 404s;
 *   - the ANCHOR: the commits page renders the upstream Commit Graph button
 *     (commits.tmpl:19-21) beside the branch dropdown;
 *   - the SEAM: EngineClient.graphData's throwing RPC resolves null through
 *     loadGraphData (the safe() posture).
 *
 * The engine's lane-map ORACLE (pop order, columns, page-slicing identity,
 * the budget caps) is check-graph.mjs's brief (14/14 vs real git) — this
 * file pins only what the PAGE adds on top.
 */

import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../../auth/testing/seeds";
import { settleCreatingRepo } from "../../git-http/gate";
import { repositories, users } from "../../db/schema";
import { RepoService } from "../../repos/service";
import type { EngineClient } from "../engine";
import { engineClient } from "../engine";
import type { UiManifest } from "../manifest";
import { handlesUiRoute, parseUiRoute, uiRouter, type UiAssetsFetcher } from "../index";
import { buildReceivePackBody, ensureSeededRepo } from "../testing/seed-repo";
import type { GraphDataResult, GraphRow } from "@cf-gitea/git-engine";
import {
  branchRefs,
  graphGeometry,
  loadGraphData,
  parseGraphQuery,
  paginatorPages,
  renderGraphFragment,
} from "./repo-graph";

// The engine-seeding hooks push real packs through the receive flow (the
// wave-129 measured set — the smoke test's file-local budgets).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// --- the minted-session route harness (the releases.matrix pattern) -------------

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: UiAssetsFetcher };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

async function fetchUi(path: string): Promise<Response> {
  const context = createExecutionContext();
  const response = await uiRouter.fetch(new Request(`https://test.local${path}`), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

// --- the multi-parent pack builder (the seed-repo idiom extended to DAGs;
//     seed-repo's builder is deliberately linear — this test-local twin adds
//     parent lists + annotated tags, byte-format identical) -----------------------

const ENCODER = new TextEncoder();

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

function concatArrays(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
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
const OBJ_TAG = 4;

interface StoredObject {
  oid: string;
  body: Uint8Array;
  type: number;
}

async function storeObject(type: number, body: Uint8Array): Promise<StoredObject> {
  const typeName = type === OBJ_COMMIT ? "commit" : type === OBJ_TREE ? "tree" : type === OBJ_TAG ? "tag" : "blob";
  const raw = concatArrays([ENCODER.encode(`${typeName} ${body.length}\0`), body]);
  return { type, body, oid: await sha1Hex(raw) };
}

interface GraphNode {
  key: string;
  parents: string[];
  message: string;
  time: number;
  /** Author display name — the row's v1 identity slot. */
  author?: { name: string; email: string };
  content?: string;
}

interface GraphTag {
  key: string;
  /** The tagged node's key (peeled target — the tag object wraps its oid). */
  node: string;
  time: number;
}

/** Build ONE self-contained pack over a DAG: every node carries its own
 *  single-file tree; all objects (deduplicated by oid) land in the pack.
 *  Returns each node/tag's oid keyed by key. */
async function buildGraphPack(
  nodes: GraphNode[],
  tags: GraphTag[] = [],
): Promise<{ oids: Map<string, string>; pack: Uint8Array }> {
  const objects = new Map<string, StoredObject>();
  const oids = new Map<string, string>();
  for (const node of nodes) {
    const blob = await storeObject(OBJ_BLOB, ENCODER.encode(node.content ?? `${node.key}\n`));
    objects.set(blob.oid, blob);
    const tree = await storeObject(OBJ_TREE, concatArrays([ENCODER.encode("100644 f.txt\0"), rawOid(blob.oid)]));
    objects.set(tree.oid, tree);
    const who = node.author ?? { name: "Test User", email: "test@example.com" };
    const body =
      `tree ${tree.oid}\n` +
      node.parents.map((p) => `parent ${oids.get(p) as string}\n`).join("") +
      `author ${who.name} <${who.email}> ${node.time} +0000\n` +
      `committer ${who.name} <${who.email}> ${node.time} +0000\n\n` +
      `${node.message}\n`;
    const commit = await storeObject(OBJ_COMMIT, ENCODER.encode(body));
    objects.set(commit.oid, commit);
    oids.set(node.key, commit.oid);
  }
  for (const tag of tags) {
    const body =
      `object ${oids.get(tag.node) as string}\ntype commit\ntag ${tag.key}\n` +
      `tagger Test User <test@example.com> ${tag.time} +0000\n\n${tag.key} annotated\n`;
    const obj = await storeObject(OBJ_TAG, ENCODER.encode(body));
    objects.set(obj.oid, obj);
    oids.set(tag.key, obj.oid);
  }
  const chunks: Uint8Array[] = [ENCODER.encode("PACK"), be32(2), be32(objects.size)];
  for (const obj of objects.values()) {
    chunks.push(objectHeader(obj.type, obj.body.length));
    chunks.push(await zlibDeflate(obj.body));
  }
  chunks.push(await sha1Bytes(concatArrays(chunks)));
  return { oids, pack: concatArrays(chunks) };
}

async function pushRefs(
  repoName: string,
  updates: { ref: string; oid: string }[],
  pack: Uint8Array,
  token: string,
): Promise<void> {
  const response = await SELF.fetch(`https://test.local/${repoName}.git/git-receive-pack`, {
    method: "POST",
    headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
    body: buildReceivePackBody(updates, pack),
  });
  const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
  if (response.status !== 200 || responseBody.includes("ng ")) {
    throw new Error(`graphmx seed push failed: ${response.status} ${responseBody.slice(0, 400)}`);
  }
}

// --- fixtures -------------------------------------------------------------------

/** Fixed epoch — every rendered timestamp is deterministic off it. */
const T0 = Math.floor(Date.UTC(2026, 9, 20, 10, 0, 0) / 1000);
const ALICE = { name: "Alice Author", email: "alice@example.com" };
const BOB = { name: "Bob Author", email: "bob@example.com" };

/** The MERGE fixture (the check-graph.mjs MAIN shape, workerd-built):
 *  L1←L2 on main, S1 the side branch off L2, L3 continuing main, M the
 *  two-parent merge ([L3, S1]), the three octopus arms off M, OCT the
 *  3-parent octopus merge, P1 a commit reachable ONLY through
 *  refs/pull/2/head, the annotated v1→M, the lightweight lw→OCT, and the
 *  remote origin/main→L2. DISTINCT committer timestamps (§5). */
const MERGE_NODES: GraphNode[] = [
  { key: "L1", parents: [], message: "L1 root", time: T0, author: ALICE },
  { key: "L2", parents: ["L1"], message: "L2 main", time: T0 + 60, author: ALICE },
  { key: "S1", parents: ["L2"], message: "S1 side", time: T0 + 120, author: BOB },
  { key: "L3", parents: ["L2"], message: "L3 main", time: T0 + 180, author: ALICE },
  { key: "M", parents: ["L3", "S1"], message: "M merge side", time: T0 + 240, author: ALICE },
  { key: "O1", parents: ["M"], message: "O1 octo arm", time: T0 + 300, author: BOB },
  { key: "O2", parents: ["M"], message: "O2 octo arm", time: T0 + 360, author: BOB },
  { key: "O3", parents: ["M"], message: "O3 octo arm", time: T0 + 420, author: BOB },
  { key: "OCT", parents: ["O1", "O2", "O3"], message: "OCT octopus", time: T0 + 480, author: ALICE },
  { key: "P1", parents: ["L3"], message: "P1 pull-only", time: T0 + 540, author: BOB },
];

const OWNER = "graphmx-owner";
const SLUG = "graphmx";
const REPO = `${OWNER}/${SLUG}`;

/** The default walk (heads+tags): OCT,O3,O2,O1,M,L3,S1,L2,L1 — 9 commits;
 *  P1 is reachable only through the pull ref (the `--tags --branches`
 *  default tip set, graph.go:36-38). */
const DEFAULT_SUBJECTS = [
  "L1 root",
  "L2 main",
  "S1 side",
  "L3 main",
  "M merge side",
  "O1 octo arm",
  "O2 octo arm",
  "O3 octo arm",
  "OCT octopus",
];

/** Narrow the engine's answer (cast-free: throws on the null arm and fails
 *  the test) — the compare-feeds feedBody idiom. */
function graphOf(data: GraphDataResult | null): GraphDataResult {
  if (data === null) throw new Error("expected graphData to answer, got null");
  return data;
}

/** Idempotent seed (the compare-feeds recipe): owner row, the DAG push
 *  (push-create), settle + public. Returns the node oids (deterministic —
 *  the fixture bytes are fixed). */
async function ensureMergeFixture(): Promise<Map<string, string>> {
  await applyAuthD1Migrations();
  const db = drizzle(env.DB);
  const owner =
    (await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, OWNER)).get()) ??
    (await (async () => {
      const seeded = await seedVerifiedUser({ username: OWNER });
      return { id: seeded.id };
    })());
  await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
    .bind(owner.id, `ui-page-seed-${SLUG}`)
    .run();
  const token = (await mintFor(owner.id, `ui-page-seed-${SLUG}`, "write:repository")).plaintext;

  const { oids, pack } = await buildGraphPack(MERGE_NODES, [{ key: "v1", node: "M", time: T0 + 600 }]);
  const refs = await env.REPO.getByName(REPO).listRefs();
  if (refs.head === null) {
    await pushRefs(
      REPO,
      [
        { ref: "refs/heads/main", oid: oids.get("OCT") as string },
        { ref: "refs/heads/side", oid: oids.get("S1") as string },
        { ref: "refs/heads/octo-a", oid: oids.get("O1") as string },
        { ref: "refs/heads/octo-b", oid: oids.get("O2") as string },
        { ref: "refs/heads/octo-c", oid: oids.get("O3") as string },
        { ref: "refs/pull/2/head", oid: oids.get("P1") as string },
        { ref: "refs/remotes/origin/main", oid: oids.get("L2") as string },
        { ref: "refs/tags/lw", oid: oids.get("OCT") as string },
        { ref: "refs/tags/v1", oid: oids.get("v1") as string },
      ],
      pack,
      token,
    );
  }
  let row = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, OWNER), eq(repositories.slug, SLUG)))
    .get();
  if (row === undefined) {
    row = await new RepoService(env.DB).create({
      owner: { id: owner.id, usernameLower: OWNER },
      name: SLUG,
      isPrivate: false,
      status: "ready",
    });
  } else {
    await settleCreatingRepo(env, row.id, REPO);
  }
  if (row.visibility !== "public") {
    await db.update(repositories).set({ visibility: "public" }).where(eq(repositories.id, row.id));
  }
  if (row.isEmpty) {
    await db.update(repositories).set({ isEmpty: false }).where(eq(repositories.id, row.id));
  }
  return oids;
}

/** The 105-commit linear twin (the hybrid pager's numbered arm: total 105 →
 *  two pages of 100/5; oldest→newest c0..c104). */
async function ensureLinearFixture(): Promise<void> {
  const commits = Array.from({ length: 105 }, (_, i) => ({
    message: `c${i}`,
    time: T0 + i * 60,
    files: [{ path: "w.txt", content: `c${i}\n` }],
  }));
  await seedVerifiedUser({ username: "graphml-owner" });
  await ensureSeededRepo({ owner: "graphml-owner", slug: "linear", commits });
  const db = drizzle(env.DB);
  const row = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "graphml-owner"), eq(repositories.slug, "linear")))
    .get();
  if (row === undefined) throw new Error("graphml repo row missing");
  if (row.visibility !== "public" || row.isEmpty) {
    await db.update(repositories).set({ visibility: "public", isEmpty: false }).where(eq(repositories.id, row.id));
  }
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  // FK order (the issues-list.matrix wipe): the join/write rows first, then
  // the repo-scoped tables, then repositories before users.
  for (const table of [
    "release_assets",
    "releases",
    "webhook_deliveries",
    "webhooks",
    "repo_collaborators",
    "repo_settings",
    "issue_labels",
    "issue_pins",
    "comments",
    "pull_requests",
    "issues",
    "labels",
    "milestones",
    "repo_counters",
    "repositories",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

// --- the parse claims ------------------------------------------------------------

describe("graph claim pins (parseUiRoute / handlesUiRoute)", () => {
  it("claims the exact bare literal — no ref suffix, no deeper tails", () => {
    expect(parseUiRoute("/octo/hello/graph")).toEqual({ family: "graph", owner: "octo", repo: "hello" });
    // trailing-slash canonicalization (the parser's pre-trim)
    expect(parseUiRoute("/octo/hello/graph/")).toEqual({ family: "graph", owner: "octo", repo: "hello" });
    // deeper tails stay unclaimed — upstream registers exactly `/graph`
    expect(parseUiRoute("/octo/hello/graph/extra")).toBeNull();
    expect(parseUiRoute("/octo/hello/graph/branch/main")).toBeNull();
    expect(handlesUiRoute("/octo/hello/graph")).toBe(true);
    expect(handlesUiRoute("/octo/hello/graph/extra")).toBe(false);
  });
});

// --- the pure pins ---------------------------------------------------------------

describe("parseGraphQuery / branchRefs (commit.go:107-127)", () => {
  it("normalizes mode — anything but monochrome (trimmed, lowercased) is color", () => {
    expect(parseGraphQuery(new URLSearchParams("mode=monochrome")).mode).toBe("monochrome");
    expect(parseGraphQuery(new URLSearchParams("mode=MONOCHROME")).mode).toBe("monochrome");
    expect(parseGraphQuery(new URLSearchParams("mode= monochrome ")).mode).toBe("monochrome");
    expect(parseGraphQuery(new URLSearchParams("mode=color")).mode).toBe("color");
    expect(parseGraphQuery(new URLSearchParams("mode=bogus")).mode).toBe("color");
    expect(parseGraphQuery(new URLSearchParams()).mode).toBe("color");
  });

  it("parses FormBool arms and page", () => {
    expect(parseGraphQuery(new URLSearchParams("hide-pr-refs=true")).hidePRRefs).toBe(true);
    expect(parseGraphQuery(new URLSearchParams("hide-pr-refs=1")).hidePRRefs).toBe(true);
    expect(parseGraphQuery(new URLSearchParams("hide-pr-refs=on")).hidePRRefs).toBe(true);
    expect(parseGraphQuery(new URLSearchParams("hide-pr-refs=false")).hidePRRefs).toBe(false);
    expect(parseGraphQuery(new URLSearchParams("div-only=true")).divOnly).toBe(true);
    expect(parseGraphQuery(new URLSearchParams("page=3")).page).toBe(3);
    expect(parseGraphQuery(new URLSearchParams("page=x")).page).toBe(1);
    expect(parseGraphQuery(new URLSearchParams("page=0")).page).toBe(1);
  });

  it("the ...flow-hide-pr-refs sentinel flips the flag and never reaches branches (§5)", () => {
    const query = parseGraphQuery(new URLSearchParams("branch=...flow-hide-pr-refs&branch=main"));
    expect(query.hidePRRefs).toBe(true);
    expect(query.branches).toEqual(["main"]);
    const sentinelOnly = parseGraphQuery(new URLSearchParams("branch=...flow-hide-pr-refs"));
    expect(sentinelOnly.hidePRRefs).toBe(true);
    expect(sentinelOnly.branches).toEqual([]);
  });

  it("branchRefs prefixes bare names, keeps refs/-prefixed ones (commit.go:120-127)", () => {
    expect(branchRefs(["main", "feature/x", "refs/pull/2/head", "refs/tags/v1"])).toEqual([
      "refs/heads/main",
      "refs/heads/feature/x",
      "refs/pull/2/head",
      "refs/tags/v1",
    ]);
  });
});

// --- the SVG geometry (the 5px/12px formula, hand-built rows) --------------------

function row(commit: string | null, column: number, color: number, edges: GraphRow["edges"]): GraphRow {
  return {
    commit:
      commit === null
        ? null
        : {
            oid: commit,
            subject: commit,
            author: { name: "A", email: "a@e", time: T0, tz: "+0000" },
            committer: { name: "A", email: "a@e", time: T0, tz: "+0000" },
            parents: [],
            refs: [],
          },
    column,
    color,
    edges,
  };
}

describe("graphGeometry (svgcontainer.tmpl's formula)", () => {
  it("a linear single-lane graph pins viewBox/width/vertical segments", () => {
    const geometry = graphGeometry([
      row("a", 0, 1, [{ from: 0, to: 0, color: 1 }]),
      row("b", 0, 1, [{ from: 0, to: 0, color: 1 }]),
      row("c", 0, 1, []),
    ]);
    // width 1 column → 1*5+5; height 3 rows → 36
    expect(geometry.viewBox).toBe("0 0 10 36");
    expect(geometry.widthPx).toBe("20px"); // 1*10+10 — the 2x scale
    expect(geometry.groups).toHaveLength(1);
    expect(geometry.groups[0]?.color16).toBe(1);
    expect(geometry.groups[0]?.segments).toEqual(["M 5 0 v 12", "M 5 12 v 12"]);
    expect(geometry.groups[0]?.circles.map((c) => [c.cx, c.cy])).toEqual([
      [5, 6],
      [5, 18],
      [5, 30],
    ]);
  });

  it("a merge bends pin the two diagonals — / and \\ at exactly one column", () => {
    const geometry = graphGeometry([
      // M's row: the main lane vertical + the side lane bending IN from col 1
      row("m", 0, 1, [
        { from: 0, to: 0, color: 1 },
        { from: 1, to: 0, color: 2 },
      ]),
      // S's row: the side lane at col 1
      row("s", 1, 2, [{ from: 1, to: 1, color: 2 }]),
      // B branches OUT to col 1 (color 3)
      row("b", 0, 1, [{ from: 0, to: 1, color: 3 }]),
      row("a", 0, 3, []),
    ]);
    // columns 0..1 → width 2 → viewBox w = 2*5+5; 4 rows → h 48
    expect(geometry.viewBox).toBe("0 0 15 48");
    expect(geometry.widthPx).toBe("30px"); // 2*10+10
    const byColor = new Map(geometry.groups.map((g) => [g.color, g]));
    // the `\`-side bend (to = from+1): M col*5 row*12 l 10 12
    expect(byColor.get(3)?.segments).toEqual(["M 0 24 l 10 12"]);
    // the `/`-side bend (to = from-1): M col*5+10 row*12 l -10 12
    expect(byColor.get(2)?.segments).toEqual(["M 15 0 l -10 12", "M 10 12 v 12"]);
    expect(byColor.get(1)?.segments).toEqual(["M 5 0 v 12"]);
    // circles: (col*5+5, row*12+6)
    expect(byColor.get(1)?.circles.map((c) => [c.cx, c.cy])).toEqual([
      [5, 6],
      [5, 30],
    ]);
    expect(byColor.get(2)?.circles).toEqual([{ oid: "s", cx: 10, cy: 18 }]);
    // colors are grouped, never mixed inside one path
    expect(geometry.groups.map((g) => g.color)).toEqual([1, 2, 3]);
  });

  it("a relation row widens through its edges and carries no circle", () => {
    const geometry = graphGeometry([row(null, -1, 0, [{ from: 4, to: 5, color: 7 }]), row("a", 0, 1, [])]);
    expect(geometry.viewBox).toBe("0 0 35 24"); // maxColumn 5 → width 6 → 6*5+5
    expect(geometry.widthPx).toBe("70px"); // 6*10+10
    expect(geometry.groups).toHaveLength(2); // color 7 (the edge) + color 1 (the dot)
    const byColor = new Map(geometry.groups.map((g) => [g.color, g]));
    expect(byColor.get(7)?.segments).toEqual(["M 20 0 l 10 12"]); // the `\` glyph at col 4 — M col*5+0 (svgcontainer.tmpl's arm; 25 would be the vertical's +5 offset)
    expect(byColor.get(7)?.circles).toEqual([]); // relation rows carry no dot
  });

  it("the empty page renders the 1x1 viewBox (Width()/Height() on zero rows)", () => {
    // Width()=Height()=1 on an empty Graph — the same formula, degenerate
    expect(graphGeometry([]).viewBox).toBe("0 0 10 12");
    expect(graphGeometry([]).widthPx).toBe("20px");
  });
});

// --- the hybrid pager's window (paginator.go Pages(), navPageNum 5) --------------

describe("paginatorPages (paginator.go's Pages port, navPageNum 5)", () => {
  it("a small total renders every page", () => {
    expect(paginatorPages(5, 3)).toEqual([1, 2, 3, 4, 5]);
    expect(paginatorPages(2, 2)).toEqual([1, 2]);
    expect(paginatorPages(1, 1)).toEqual([1]);
  });

  it("the window keeps the current page with … markers at the overflowing edges", () => {
    expect(paginatorPages(20, 1)).toEqual([1, 2, 3, 4, 5, -1]);
    expect(paginatorPages(20, 10)).toEqual([-1, 8, 9, 10, 11, 12, -1]);
    expect(paginatorPages(20, 18)).toEqual([-1, 16, 17, 18, 19, 20]);
    expect(paginatorPages(20, 20)).toEqual([-1, 16, 17, 18, 19, 20]);
  });
});

// --- the mount arms ---------------------------------------------------------------

describe("the graph page mounts (the merge fixture)", () => {
  it("the full page carries ALL five JS-selector ids and the default walk's rows", async () => {
    const oids = await ensureMergeFixture();
    const res = await fetchUi(`/${REPO}/graph`);
    expect(res.status).toBe(200);
    const html = await res.text();

    // the five selectors initRepoGraphGit requires (a partial DOM throws — §4.2)
    expect(html).toContain('id="git-graph-container"');
    expect(html).toContain('id="flow-color-monochrome"');
    expect(html).toContain('id="flow-color-colored"');
    expect(html).toContain('id="flow-select-refs-dropdown"');
    expect(html).toContain('id="git-graph-body"');
    // the mode class off (color is the no-class default)
    expect(html).not.toContain('class="ui segment monochrome"');

    // the default tip set's rows: every head+tag commit, P1 absent
    for (const subject of DEFAULT_SUBJECTS) {
      expect(html).toContain(`>${subject}</a>`);
    }
    expect(html).not.toContain("P1 pull-only");
    // subject → /commit/{oid} links (§4.2)
    expect(html).toContain(`href="/${REPO}/commit/${oids.get("OCT") as string}"`);
    // the author slot (the avatar-stack cut) + the FullTime stamp
    expect(html).toContain("Alice Author");
    expect(html).toContain(formatFullTime(T0 + 480));
    // the annotated tag's chip lands on M's row (the PEELED target)
    expect(html).toContain(`href="/${REPO}/src/tag/v1"`);
    // the heads chips
    expect(html).toContain(`href="/${REPO}/src/branch/side"`);
    // the remote chip links the commit (remotes arm)
    expect(html).toContain(`href="/${REPO}/src/commit/${oids.get("L2") as string}"`);

    // the page's rows/circles parity with the RPC's answer (no re-pinned lane
    // map — that is check-graph.mjs's oracle)
    const cell = env.REPO.getByName(REPO);
    const data = graphOf(await cell.graphData({ page: 1 }));
    const commitRows = data.rows.filter((r) => r.commit !== null).length;
    expect(html.match(/<circle /g)?.length ?? 0).toBe(commitRows);
    expect(html.match(/<li /g)?.length ?? 0).toBe(data.rows.length);
    // the merge fixture guarantees at least one diagonal (M's second parent
    // bends in) and verticals
    expect(html).toMatch(/l -10 12|l 10 12/);
    expect(html).toContain("v 12");
    // the SVG geometry formula rides the real rows
    let minColumn = 0;
    let maxColumn = 0;
    for (const r of data.rows) {
      const cols = r.commit === null ? [] : [r.column];
      for (const e of r.edges) cols.push(e.from, e.to);
      minColumn = Math.min(minColumn, ...cols);
      maxColumn = Math.max(maxColumn, ...cols);
    }
    expect(html).toContain(
      `viewbox="${minColumn * 5} 0 ${(maxColumn - minColumn + 1) * 5 + 5} ${data.rows.length * 12}"`,
    );
  });

  it("the dropdown items carry the sentinel + every full-ref data-value", async () => {
    await ensureMergeFixture();
    const res = await fetchUi(`/${REPO}/graph`);
    const html = await res.text();
    const dropdown = html.slice(html.indexOf('id="flow-select-refs-dropdown"'));
    expect(dropdown).toContain('data-value="...flow-hide-pr-refs"');
    expect(dropdown).toContain("Hide Pull Requests"); // the sentinel's label
    expect(dropdown).toContain("Select branches"); // the default text
    expect(html).toContain('data-value="refs/heads/main"');
    expect(html).toContain('data-value="refs/heads/side"');
    expect(html).toContain('data-value="refs/tags/v1"');
    expect(html).toContain('data-value="refs/tags/lw"');
    expect(html).toContain('data-value="refs/remotes/origin/main"');
    expect(html).toContain('data-value="refs/pull/2/head"');
    // the pull item's label carries the # short form
    expect(dropdown).toContain(">#2<");
  });

  it("?mode=monochrome arms the container class + the active button", async () => {
    await ensureMergeFixture();
    const res = await fetchUi(`/${REPO}/graph?mode=monochrome`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="git-graph-container" class="ui segment monochrome"');
    expect(html).toContain('id="flow-color-monochrome" class="ui icon button active"');
    expect(html).toContain('id="flow-color-colored" class="ui icon button"');
  });

  it("?branch=side narrows the walk; ?branch=deleted falls back unfiltered (never 500)", async () => {
    await ensureMergeFixture();
    const narrowed = await fetchUi(`/${REPO}/graph?branch=side`);
    expect(narrowed.status).toBe(200);
    const narrowedHtml = await narrowed.text();
    expect(narrowedHtml).toContain(">S1 side</a>");
    expect(narrowedHtml).not.toContain("M merge side");
    expect(narrowedHtml).not.toContain("OCT octopus");

    const fallback = await fetchUi(`/${REPO}/graph?branch=deleted-branch`);
    expect(fallback.status).toBe(200); // the bad-ref retry — NEVER a 500 (§5)
    const fallbackHtml = await fallback.text();
    for (const subject of DEFAULT_SUBJECTS) {
      expect(fallbackHtml).toContain(`>${subject}</a>`);
    }
  });

  it("an explicitly selected pull ref walks P1 and shows its chip (the :21 gate's selected arm)", async () => {
    await ensureMergeFixture();
    const res = await fetchUi(`/${REPO}/graph?branch=refs/pull/2/head`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(">P1 pull-only</a>");
    // the pull chip: hidden only when hide-pr-refs AND not selected — here selected
    expect(html).toContain(`href="/${REPO}/pulls/2"`);
  });

  it("?hide-pr-refs=true keeps the default walk (the flag is a no-op on heads+tags — the ledger)", async () => {
    await ensureMergeFixture();
    const res = await fetchUi(`/${REPO}/graph?hide-pr-refs=true`);
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const subject of DEFAULT_SUBJECTS) {
      expect(html).toContain(`>${subject}</a>`);
    }
    expect(html).not.toContain("P1 pull-only"); // pull refs never walked by default anyway
    // the sentinel arm: the ...-prefixed branch value flips the flag and is
    // dropped from the RPC input — the default rows render
    const sentinel = await fetchUi(`/${REPO}/graph?branch=...flow-hide-pr-refs`);
    expect(sentinel.status).toBe(200);
    expect(await sentinel.text()).toContain(">OCT octopus</a>");
  });

  it("?div-only=true answers the body fragment ONLY — no shell, no div-only in pager links", async () => {
    await ensureLinearFixture();
    const res = await fetchUi("/graphml-owner/linear/graph?div-only=true&page=1");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="rel-container"');
    expect(html).toContain('id="rev-list"');
    // the numbered pager renders inside the fragment (total 105 → 2 pages)
    expect(html).toContain('class="ui borderless pagination menu"');
    // tplGraphDiv: the three body children ONLY — no shell, no container chrome
    expect(html).not.toContain("<html");
    expect(html).not.toContain("page-content");
    expect(html).not.toContain('id="git-graph-container"');
    expect(html).not.toContain('id="flow-select-refs-dropdown"');
    // the pager links carry NO div-only (commit.go:169's RemoveParam)
    expect(html).not.toContain("div-only");
    expect(html).toContain("?page=2");
  });

  it("the hybrid pager: total delivered → numbered; the deep page clamps", async () => {
    await ensureLinearFixture();
    const page1 = await (await fetchUi("/graphml-owner/linear/graph")).text();
    expect(page1.match(/<circle /g)?.length ?? 0).toBe(100);
    expect(page1).toContain(">c104</a>"); // the newest — the walk's 1st
    expect(page1).toContain(">c5</a>"); // page 1's last row (newest-first)
    expect(page1).not.toContain(">c4</a>"); // page 2's newest
    // the numbered window [1, 2] with 1 active
    expect(page1).toContain('class="active item"');
    expect(page1).toContain(">2</a>");

    const page2 = await (await fetchUi("/graphml-owner/linear/graph?page=2")).text();
    expect(page2.match(/<circle /g)?.length ?? 0).toBe(5);
    expect(page2).toContain(">c4</a>"); // the walk's 101st — page-slicing continuity
    expect(page2).toContain(">c0</a>"); // the root
    expect(page2).not.toContain(">c5</a>");

    // over-the-end: the paginator clamps current to totalPages (paginator.go:45-49)
    const page9 = await (await fetchUi("/graphml-owner/linear/graph?page=9")).text();
    expect(page9).toContain('class="active item"');
    expect(page9.match(/<circle /g)?.length ?? 0).toBe(0);
  });

  it("an empty repo 404-shells (MustBeNotEmpty) and an unborn row 404-shells (the loader's null)", async () => {
    await applyAuthD1Migrations();
    const owner = await seedVerifiedUser({ username: "graphmt-owner" });
    const db = drizzle(env.DB);
    await new RepoService(env.DB).create({
      owner: { id: owner.id, usernameLower: "graphmt-owner" },
      name: "empty",
      isPrivate: false,
      status: "ready",
    });
    const empty = await fetchUi("/graphmt-owner/empty/graph");
    expect(empty.status).toBe(404); // the isEmpty gate (web.go:1737)

    // the unborn twin: isEmpty flipped false with NO push — the loader's
    // graphData null arm (§3.1's empty-repo ladder)
    const created = await new RepoService(env.DB).create({
      owner: { id: owner.id, usernameLower: "graphmt-owner" },
      name: "unborn",
      isPrivate: false,
      status: "ready",
    });
    await db.update(repositories).set({ isEmpty: false }).where(eq(repositories.id, created.id));
    const unborn = await fetchUi("/graphmt-owner/unborn/graph");
    expect(unborn.status).toBe(404);
  });
});

// --- the anchor -------------------------------------------------------------------

describe("the commits page's Commit Graph anchor (commits.tmpl:19-21)", () => {
  it("the commits page renders the /graph button beside the branch dropdown", async () => {
    await ensureMergeFixture();
    const res = await fetchUi(`/${REPO}/commits`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`href="/${REPO}/graph"`);
    expect(html).toContain("ui basic small compact button");
    expect(html).toContain("octicon-git-branch");
    expect(html).toContain("Commit Graph"); // repo.commit_graph
  });
});

// --- the seam ----------------------------------------------------------------------

describe("the EngineClient.graphData seam", () => {
  it("the real factory resolves the graph through (and null stays null end-to-end)", async () => {
    await ensureMergeFixture();
    // the factory-built client (engineClient's safe() wraps every RPC — the
    // throw posture is its invariant, engine.ts's header contract; a
    // contract-violating throwing client is outside the interface's domain)
    const engine = engineClient(env, REPO);
    const data = await engine.graphData({ page: 1 });
    expect(graphOf(data).rows.length).toBeGreaterThan(0);
    // a null-answering graphData rides the loader to the 404 family's null —
    // the empty-repo ladder (§3.1); the unborn mount pins the page consequence
    const reflessEngine = stubEngine({ listRefs: () => Promise.resolve(null) });
    expect(await loadGraphData(reflessEngine, parseGraphQuery(new URLSearchParams()))).toBeNull();
    const unbornEngine = stubEngine({
      listRefs: () => Promise.resolve({ head: null, refs: [] }),
      graphData: () => Promise.resolve(null),
    });
    expect(await loadGraphData(unbornEngine, parseGraphQuery(new URLSearchParams()))).toBeNull();
  });

  it("the fragment renderer answers the body inner content (renderGraphFragment)", async () => {
    await ensureMergeFixture();
    const cell = env.REPO.getByName(REPO);
    const refs = await cell.listRefs();
    const fragment = renderGraphFragment(`/${REPO}`, {
      query: parseGraphQuery(new URLSearchParams()),
      graph: graphOf(await cell.graphData({ page: 1 })),
      allRefs: refs.refs,
    });
    expect(fragment).toContain('id="rel-container"');
    expect(fragment).toContain('id="rev-list"');
    expect(fragment).not.toContain("<html");
  });
});

// --- helpers -----------------------------------------------------------------------

function formatFullTime(unixSeconds: number): string {
  // formatMonitorFullTime's exact shape (DateUtils.FullTime, UTC hand-rolled)
  const date = new Date(unixSeconds * 1000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${months[date.getUTCMonth()]} ${pad(date.getUTCDate())}, ${date.getUTCFullYear()} ${pad(
    date.getUTCHours(),
  )}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/** A complete EngineClient stub (typed — no casts): every read null, the
 *  listed overrides winning. */
function stubEngine(overrides: Partial<EngineClient>): EngineClient {
  return {
    listRefs: () => Promise.resolve(null),
    readCommit: () => Promise.resolve(null),
    listLog: () => Promise.resolve(null),
    listTree: () => Promise.resolve(null),
    readBlob: () => Promise.resolve(null),
    listTreeCommits: () => Promise.resolve(null),
    blame: () => Promise.resolve(null),
    grep: () => Promise.resolve(null),
    activityStats: () => Promise.resolve(null),
    contributorStats: () => Promise.resolve(null),
    graphData: () => Promise.resolve(null),
    scanLfsPointers: () => Promise.resolve(null), // the LFS pages sibling unit member
    ...overrides,
  };
}
