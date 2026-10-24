// Shared helpers for the SPEC-0001b merge check scripts (run with tsx, the
// same mechanism as check-deepen-parse.mjs — see the per-script headers).
//
// - NodeSql: the workerd SqlStorage surface (exec/toArray/one + databaseSize)
//   over node:sqlite, so GitStore and the control-plane RPCs run in plain Node.
//   transactionSync wraps the callback in a real BEGIN/COMMIT/ROLLBACK.
// - leaseHost(): the LeaseHost shape the control-plane functions take.
// - loadGitRepoIntoStore(): a real `git` fixture repo → GitStore (objects via
//   `git cat-file --batch-all-objects --batch`, refs via for-each-ref).
// - gitMergeFile/gitMergeTree: the real-git oracles.

import { DatabaseSync } from "node:sqlite";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitStore } from "../../src/git/store.ts";

export class NodeSql {
  constructor(db) {
    this.db = db;
    this.databaseSize = 0; // gc headroom probe only; irrelevant in tests
  }
  exec(sql, ...params) {
    const isQuery = /^\s*(SELECT|WITH)/i.test(sql);
    if (params.length === 0 && !isQuery) {
      this.db.exec(sql); // DDL and multi-statement blocks
      return { toArray: () => [], one: () => undefined };
    }
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params.map(normalizeParam));
    return { toArray: () => rows, one: () => rows[0] };
  }
}

function normalizeParam(p) {
  if (p instanceof ArrayBuffer) return Buffer.from(p);
  return p;
}

export function makeStore() {
  const db = new DatabaseSync(":memory:");
  const sql = new NodeSql(db);
  const store = new GitStore(sql);
  return { store, sql, transactions: 0 };
}

/** The control-plane LeaseHost over the test store: transactionSync is a real
 * SQLite transaction, so CAS/atomicity semantics are exercised honestly. */
export function leaseHost(t) {
  return {
    store: t.store,
    storage: {
      transactionSync: (fn) => {
        t.transactions++;
        t.sql.db.exec("BEGIN");
        try {
          const r = fn();
          t.sql.db.exec("COMMIT");
          return r;
        } catch (err) {
          t.sql.db.exec("ROLLBACK");
          throw err;
        }
      },
      setAlarm: () => Promise.resolve(),
    },
    deletePackObjects: async () => {},
  };
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

export function assertEq(actual, want, msg) {
  const a = JSON.stringify(actual);
  const w = JSON.stringify(want);
  if (a !== w) throw new Error(`${msg}: got ${a}, want ${w}`);
}

export function scratchDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function git(dir, cmd, env = {}) {
  return execSync(`git -C ${dir} -c user.email=t@t -c user.name=t ${cmd}`, {
    env: { ...process.env, ...env },
    maxBuffer: 1 << 28,
    stdio: ["ignore", "pipe", "inherit"],
  })
    .toString()
    .trim();
}

function gitRaw(dir, cmd) {
  return execSync(`git -C ${dir} ${cmd}`, { maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "inherit"] });
}

export function commitOid(dir, ref) {
  return git(dir, `rev-parse ${ref}`);
}

/** Every object of a real git repo → the store; refs + HEAD too. */
export function loadGitRepoIntoStore(t, dir) {
  const out = gitRaw(dir, "cat-file --batch-all-objects --batch");
  let p = 0;
  while (p < out.length) {
    const lf = out.indexOf(0x0a, p);
    const header = out.slice(p, lf).toString().trim(); // "<oid> <type> <size>"
    const [oid, type, sizeStr] = header.split(" ");
    const size = parseInt(sizeStr, 10);
    const data = out.subarray(lf + 1, lf + 1 + size);
    t.store.put(oid, type, new Uint8Array(data));
    p = lf + 1 + size + 1;
  }
  for (const line of git(dir, `for-each-ref --format="%(refname) %(objectname)"`).split("\n")) {
    if (!line.trim()) continue;
    const sp = line.lastIndexOf(" ");
    t.store.setRef(line.slice(0, sp).trim(), line.slice(sp + 1).trim());
  }
  const head = git(dir, "symbolic-ref HEAD");
  if (head) t.store.setHead(head);
}

/** `git merge-file` oracle: returns the merged bytes and the conflict count. */
export function gitMergeFile(base, ours, theirs) {
  const dir = scratchDir("merge-file-");
  writeFileSync(join(dir, "base"), base);
  writeFileSync(join(dir, "ours"), ours);
  writeFileSync(join(dir, "theirs"), theirs);
  let conflicts = 0;
  let out;
  try {
    out = execSync(`git -C ${dir} merge-file -L ours -L base -L theirs --stdout ours base theirs`, {
      maxBuffer: 1 << 24,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    conflicts = err.status ?? 255;
    out = Buffer.from(err.stdout ?? []);
  }
  return { text: out.toString(), conflicts };
}

/** `git merge-tree --write-tree --name-only <base> <ours> <theirs>` oracle
 * (three-arg form: the first commit is the merge base). */
export function gitMergeTree(dir, base, ours, theirs) {
  let out;
  try {
    out = gitRaw(dir, `merge-tree --write-tree --name-only --merge-base=${base} ${ours} ${theirs}`);
  } catch (err) {
    if (err.status !== 1) throw err;
    out = Buffer.from(err.stdout ?? []);
  }
  // output shape (git-merge-tree docs): <tree-oid>\n<conflicted files>\n\n
  // <informational messages> — the file list is the section BEFORE the blank
  const text = out.toString();
  const nl = text.indexOf("\n");
  const tree = text.slice(0, nl).trim();
  const rest = text.slice(nl + 1);
  const blank = rest.indexOf("\n\n");
  const files = blank >= 0 ? rest.slice(0, blank) : rest;
  const conflicts = files
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return { tree, conflicts };
}
