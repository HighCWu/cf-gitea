// listPackCatalog RPC checks over a REAL GitStore (node:sqlite backend — see
// helpers/lib.mjs). Run with tsx:
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-catalog-rpc.mjs
//
// Covers: keyset pagination (pack_key order, disjoint pages, exhaustion,
// cursor past the end), the tagged-union error cases (limit bounds, cursor
// validation), all-states visibility (a superseded row is listed — the fork
// replication's active-only pages hide it on purpose, the invariants checker
// needs it), kind surfacing ('fork' rows), and the empty-catalog shape.
import { assert, assertEq, leaseHost, makeStore } from "./helpers/lib.mjs";
import { listPackCatalog } from "../src/control-plane.ts";

let planned = 0;
const failures = [];
async function check(name, fn) {
  planned++;
  try {
    await fn();
    console.log(`ok: ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL: ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Deterministic distinct pack-<40 hex> keys, lexicographic order == n order
 * (n < 256). Realistic shape: the cursor validator accepts exactly this. */
function packKey(n) {
  return `pack-${n.toString(16).padStart(2, "0")}${"ab".repeat(19)}`;
}

/** Seed `count` catalog rows through the real writer (recordPack: the same
 * INSERT finalize's commit transaction runs). */
function seedRows(t, count, kind = "receive") {
  for (let i = 0; i < count; i++) {
    t.store.packs.recordPack(packKey(i), 1024 * (i + 1), 0, kind);
  }
}

const ROW_FIELDS = ["created_at", "kind", "location", "object_count", "pack_bytes", "pack_key", "state"].sort();

await check("empty catalog: ok with no rows and a null cursor", async () => {
  const t = makeStore();
  const r = listPackCatalog(leaseHost(t), {});
  assertEq(r.tag, "ok", "ok");
  assertEq(r.rows, [], "no rows");
  assertEq(r.nextCursor, null, "exhausted");
});

await check("row shape is exactly the seven catalog columns (snake_case)", async () => {
  const t = makeStore();
  seedRows(t, 1);
  const r = listPackCatalog(leaseHost(t), {});
  assertEq(r.tag, "ok", "ok");
  assertEq(Object.keys(r.rows[0]).sort(), ROW_FIELDS, "column set");
  assertEq(r.rows[0].pack_key, packKey(0), "key");
  assertEq(r.rows[0].kind, "receive", "kind");
  assertEq(r.rows[0].state, "active", "state");
  assertEq(r.rows[0].location, "r2", "location");
  assertEq(r.rows[0].object_count, 0, "object_count (no index rows pushed)");
  assertEq(r.rows[0].pack_bytes, 1024, "pack_bytes");
  assert(typeof r.rows[0].created_at === "number" && r.rows[0].created_at > 0, "created_at is unix millis");
});

await check("keyset walk: 5 rows at limit 2 → three disjoint ordered pages", async () => {
  const t = makeStore();
  seedRows(t, 5);
  const host = leaseHost(t);
  const seen = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const r = listPackCatalog(host, { cursor, limit: 2 });
    assertEq(r.tag, "ok", "ok");
    pages++;
    for (const row of r.rows) seen.push(row.pack_key);
    if (r.nextCursor === null) break;
    cursor = r.nextCursor;
    assert(pages < 10, "walk terminates");
  }
  assertEq(pages, 3, "three pages (2+2+1)");
  assertEq(seen, [0, 1, 2, 3, 4].map(packKey), "pack_key order, no repeats, no gaps");
});

await check("absent cursor and cursor=null are the same first page", async () => {
  const t = makeStore();
  seedRows(t, 3);
  const host = leaseHost(t);
  const a = listPackCatalog(host, { limit: 2 });
  const b = listPackCatalog(host, { cursor: null, limit: 2 });
  assertEq(a, b, "identical pages");
});

await check("cursor past the end: empty page, null cursor", async () => {
  const t = makeStore();
  seedRows(t, 2);
  const r = listPackCatalog(leaseHost(t), { cursor: packKey(255), limit: 2 });
  assertEq(r.tag, "ok", "ok");
  assertEq(r.rows, [], "past every key");
  assertEq(r.nextCursor, null, "exhausted");
});

await check("limit bounds: 0, 501, 1.5 → error; 1 and 500 → ok", async () => {
  const t = makeStore();
  seedRows(t, 1);
  const host = leaseHost(t);
  for (const bad of [0, -3, 501, 1.5]) {
    const r = listPackCatalog(host, { limit: bad });
    assertEq(r.tag, "error", `limit ${bad} is an error`);
    assert(r.reason.includes("limit"), "reason names the limit");
  }
  assertEq(listPackCatalog(host, { limit: 1 }).tag, "ok", "limit 1 ok");
  assertEq(listPackCatalog(host, { limit: 500 }).tag, "ok", "limit 500 ok");
});

await check("cursor validation: not-a-pack-key → error; unknown valid key → ok page", async () => {
  const t = makeStore();
  const host = leaseHost(t);
  const bad = listPackCatalog(host, { cursor: "pack-xyz" });
  assertEq(bad.tag, "error", "garbage cursor is an error");
  assert(bad.reason.includes("cursor"), "reason names the cursor");
  const unknown = listPackCatalog(host, { cursor: packKey(200), limit: 2 });
  assertEq(unknown.tag, "ok", "valid-but-unknown cursor is a legal keyset start");
  assertEq(unknown.rows, [], "empty page");
});

await check("all lifecycle states are listed (superseded included)", async () => {
  const t = makeStore();
  seedRows(t, 3);
  t.sql.db
    .prepare("UPDATE pack_catalog SET state = 'superseded', superseded_by = ? WHERE pack_key = ?")
    .all(packKey(1), packKey(1));
  const r = listPackCatalog(leaseHost(t), { limit: 10 });
  assertEq(r.tag, "ok", "ok");
  assertEq(r.rows.length, 3, "non-active row still listed");
  const superseded = r.rows.find((row) => row.pack_key === packKey(1));
  assertEq(superseded.state, "superseded", "state surfaced");
  assertEq(r.rows.map((row) => row.state).sort(), ["active", "active", "superseded"], "mixed states");
});

await check("kind surfaces: fork replication records 'fork' rows", async () => {
  const t = makeStore();
  seedRows(t, 1, "fork");
  const r = listPackCatalog(leaseHost(t), {});
  assertEq(r.rows[0].kind, "fork", "kind column verbatim");
});

await check("default limit is 200 (201 rows → 200 + non-null cursor)", async () => {
  const t = makeStore();
  seedRows(t, 201);
  const r = listPackCatalog(leaseHost(t), {});
  assertEq(r.rows.length, 200, "default page size");
  assertEq(r.nextCursor, packKey(199), "cursor is the last served key");
});

if (failures.length) {
  console.log(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${planned} catalog RPC checks passed`);
