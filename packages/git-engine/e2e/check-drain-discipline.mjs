// The cursor-drain discipline tripwire — a STATIC check over `src/**`, no dev
// server, no runtime. Closes the open item the cursor-drain landing named
// (29b966f "fix(engine): the cursor drain"; the census in its message audited
// every `.exec(` site and found exactly ONE discarded SELECT cursor —
// tableExists()'s probe, fixed there).
//
// WHY: on a sqlite-backed Durable Object, workerd bricks every subsequent
// `DROP TABLE` of an EXISTING table on the connection with
// `database table is locked: SQLITE_LOCKED` for the rest of the runtime
// session when a `SqlStorage` SELECT cursor is discarded un-drained
// (docs/research/workerd-ddl-cross-session-locked.md — the DDL distillation,
// runtime-verified 3x/26 predictions; upstream workerd#959). The defect
// persists upstream, so nothing but this discipline prevents a future
// `.exec(<SELECT>)` from re-bricking DDL cross-session:
//
//   EVERY `sql.exec(<SELECT>)` cursor drains; only DDL/DML may discard.
//
// Classification rules (the census's taxonomy, landed):
//   1. Sites: every `.exec` call under `src/**` (balanced-generic calls like
//      `.exec<Row>(...)` included; a bare `.exec` reference fails closed).
//      A length-preserving tokenizer blanks comments AND string/template
//      bodies before site-finding, so a comment that merely MENTIONS
//      `sql.exec(` (migrations.ts's discipline comment does) can never become
//      a phantom site — the rows-10/11 comment-skipping lesson, applied at
//      character (not line) granularity.
//   2. Receivers: last identifier `sql` (covers `this.sql`,
//      `this.ctx.storage.sql`, and migrations' `sql: SqlStorage` param) is a
//      SqlStorage site; a receiver ending in a regex literal is RegExp (the
//      census's 3: patchid.ts, r2keys.ts, and mod.ts's URLPattern — the
//      latter via the explicit `pattern` allowlist below); ANYTHING ELSE
//      fails closed, so a new unknown receiver is looked at, never silently
//      un-scanned.
//   3. Statement head (the first argument's text classifies the site):
//      SELECT family = SELECT / WITH / VALUES — any statement of a
//      multi-statement literal; DDL/DML = CREATE/ALTER/DROP/INSERT/UPDATE/
//      DELETE/REPLACE/BEGIN/COMMIT/ROLLBACK/SAVEPOINT/RELEASE/VACUUM/ANALYZE/
//      REINDEX/ATTACH/DETACH/PRAGMA. A bare-identifier argument resolves to
//      its `const NAME = <literal>` definition under src (the baseline SQL
//      constants) before classifying; SQL `--`/`/* */` comments are stripped
//      first. Interpolated templates classify conservatively by the STATIC
//      text before the first `${`: a recognizable head keyword decides
//      (`SELECT 1 FROM ${name}` → SELECT; `DROP TABLE IF EXISTS ${t}` → DDL);
//      an interpolated head fragment naming no keyword (e.g. `${stmt}`)
//      CANNOT be classified and FAILS CLOSED with a pointer — never guessed.
//   4. Drain assertion (SELECT sites only — DDL/DML produce no row cursor and
//      may discard, per the distillation's surface contract): the expression
//      must prove a full drain in the same statement, across lines/comments:
//        .toArray()     — the engine idiom (covers the census's "iterated a
//                         materialized .toArray() result": a later loop/break
//                         walks the ARRAY, never the cursor)
//        .one()         — the census's shape for guaranteed single-row
//                         aggregates (COUNT/SUM); it throws on >1 row, so the
//                         idiom's contract is the author's single-row promise
//        full iteration — `[...sql.exec(q)]` or a direct
//                         `for (const r of sql.exec(q))` whose body contains
//                         NO break/return (an early exit ends mid-walk; the
//                         census noted activeCatalogWindow's break is over
//                         the array, never the cursor)
//      NOT drains, each failing with its reason: a bare discard (the exact
//      mutation the fix closed), `.next()` (steps ONE row), `.raw()` (returns
//      its own cursor that must itself be drained; unused in the engine
//      today — adopting it means draining its iterators), and any other
//      unrecognized continuation. Fail-closed is the contract: a shape this
//      script cannot PROVE drained is a failure naming file:line, and the
//      remedy is the blessed `.toArray()` idiom (or a deliberate, documented
//      extension of this rule set).
//
// Scanner-sanity floors (checked below) catch the scanner itself regressing
// to vacuousness — a parse change that silently drops sites. They sit below
// the current true counts (printed as the site census); raise them only with
// eyes on the full site table.
//
// Self-test: every run also proves the tripwire RED on the exact mutation
// class (a bare `sql.exec(`SELECT 1`)` discard), on the fail-closed
// interpolation arm, and on the `.next()` arm, and GREEN on its two controls
// (a DDL discard, a drained SELECT) — via in-memory snippets, no files.
// An external mutation is witnessed the same way:
//   node "$TSX" packages/git-engine/e2e/check-drain-discipline.mjs /tmp/leak.ts
// extra argv files are scanned IN ADDITION to src/** and any failing site in
// them fails the run (exit 1) naming file:line — never commit a mutation file.
//
// CI-able: exits 0 (all green) / 1 (any failure) under the tsx runner every
// other check script uses:
//   node <repo>/node_modules/.pnpm/tsx*/node_modules/tsx/dist/cli.mjs \
//     packages/git-engine/e2e/check-drain-discipline.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, "..", "src");

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
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Tokenizer: one length-preserving pass over a file in two modes.
//   keepStrings=false → codeOnly        (comments AND string/template
//                       CONTENTS blanked to spaces; quotes/backticks kept) —
//                       for site finding, receiver walk-back, drain analysis
//   keepStrings=true  → commentsBlanked (comments blanked, string/template
//                       contents KEPT) — SQL bodies and const definitions
// Only non-newline chars are blanked, so line/col mapping survives.
// ---------------------------------------------------------------------------

function blank(out, from, to) {
  for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
}

function scanText(text, keepStrings) {
  const out = [...text];
  const n = text.length;
  const stack = [{ kind: "code" }];
  let i = 0;
  while (i < n) {
    const top = stack[stack.length - 1];
    const c = text[i];
    const c2 = i + 1 < n ? text[i + 1] : "";
    if (top.kind === "code" || top.kind === "interp") {
      if (c === "/" && c2 === "/") {
        const start = i;
        while (i < n && text[i] !== "\n") i++;
        blank(out, start, i);
        continue;
      }
      if (c === "/" && c2 === "*") {
        const start = i;
        i += 2;
        while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
        i = Math.min(n, i + 2);
        blank(out, start, i);
        continue;
      }
      if (c === '"' || c === "'") {
        stack.push({ kind: "string", quote: c });
        i++;
        continue;
      }
      if (c === "`") {
        stack.push({ kind: "template" });
        i++;
        continue;
      }
      if (top.kind === "interp") {
        if (c === "{") top.braces++;
        else if (c === "}") {
          top.braces--;
          if (top.braces === 0) stack.pop();
        }
      }
      i++;
      continue;
    }
    if (top.kind === "string") {
      if (c === "\\") {
        if (!keepStrings) blank(out, i, Math.min(n, i + 2));
        i += 2;
        continue;
      }
      if (c === top.quote) {
        stack.pop();
        i++;
        continue;
      }
      if (!keepStrings && c !== "\n") out[i] = " ";
      i++;
      continue;
    }
    // template static part
    if (c === "\\") {
      if (!keepStrings) blank(out, i, Math.min(n, i + 2));
      i += 2;
      continue;
    }
    if (c === "`") {
      stack.pop();
      i++;
      continue;
    }
    if (c === "$" && c2 === "{") {
      stack.push({ kind: "interp", braces: 1 });
      i += 2;
      continue;
    }
    if (!keepStrings) out[i] = " ";
    i++;
  }
  return out.join("");
}

function views(text) {
  return { codeOnly: scanText(text, false), commentsBlanked: scanText(text, true) };
}

// ---------------------------------------------------------------------------
// SQL classification (the census's taxonomy)
// ---------------------------------------------------------------------------

const SELECT_HEAD = /^(select|with|values)\b/i;
const DDL_DML_HEAD =
  /^(create|alter|drop|insert|update|delete|replace|begin|commit|rollback|savepoint|release|vacuum|analyze|reindex|attach|detach|pragma)\b/i;

function stripSqlComments(sql) {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** Non-interpolated full text: SELECT-bearing if ANY statement head says so.
 * An empty statement list classifies as UNCLASSIFIED (fail-closed), never
 * silently "DDL/DML". */
function classifySqlText(sql) {
  const clean = stripSqlComments(sql);
  let sawStatement = false;
  for (const stmt of clean.split(";")) {
    const head = stmt.trim();
    if (!head) continue;
    sawStatement = true;
    if (SELECT_HEAD.test(head)) return { cls: "SELECT" };
    if (!DDL_DML_HEAD.test(head)) return { cls: "UNCLASSIFIED", what: `statement head ${JSON.stringify(head.slice(0, 40))}` };
  }
  if (!sawStatement) return { cls: "UNCLASSIFIED", what: "no statement text found" };
  return { cls: "DDL/DML" };
}

/** Interpolated template: the STATIC head before the first `${` decides.
 * A fragment naming no keyword is fail-closed — never guessed. */
function classifyTemplateParts(parts) {
  const headStatic = parts[0].type === "static" ? parts[0].text : "";
  const frag = stripSqlComments(headStatic).trim();
  if (SELECT_HEAD.test(frag)) return { cls: "SELECT" };
  if (DDL_DML_HEAD.test(frag)) return { cls: "DDL/DML" };
  return { cls: "UNCLASSIFIED", what: `interpolated head fragment ${JSON.stringify(frag.slice(0, 40))} names no statement keyword` };
}

// ---------------------------------------------------------------------------
// Source loading + the const-literal map (for bare-identifier arguments)
// ---------------------------------------------------------------------------

function listTsFiles(root) {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(p));
    else if (extname(entry.name) === ".ts") out.push(p);
  }
  return out;
}

/** Parse a template literal starting at `open` (index of the backtick) into
 * static/interp parts. Returns { end, parts }; interpolations honor nested
 * strings and braces. */
function parseTemplateParts(text, open) {
  const parts = [];
  let buf = "";
  let i = open + 1;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "\\") {
      buf += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "`") {
      parts.push({ type: "static", text: buf }); // the trailing static run — never dropped
      return { end: i + 1, parts };
    }
    if (c === "$" && text[i + 1] === "{") {
      parts.push({ type: "static", text: buf });
      buf = "";
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") depth--;
        else if (text[j] === '"' || text[j] === "'" || text[j] === "`") {
          const q = text[j];
          j++;
          while (j < n && text[j] !== q) {
            if (text[j] === "\\") j++;
            j++;
          }
        }
        j++;
      }
      parts.push({ type: "interp", text: text.slice(i + 2, Math.min(j, n) - 1) });
      i = Math.min(j, n);
      continue;
    }
    buf += c;
    i++;
  }
  parts.push({ type: "static", text: buf }); // unterminated literal: keep the tail visible
  return { end: n, parts };
}

function buildConstMap(files) {
  const map = new Map(); // name -> { file, text, openIdx } (first definition wins)
  for (const f of files) {
    const re = /(?:^|[\n;})])\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/g;
    let m;
    while ((m = re.exec(f.text)) !== null) {
      const name = m[1];
      if (map.has(name)) continue;
      let i = m.index + m[0].length;
      while (i < f.text.length && /\s/.test(f.text[i])) i++;
      if (f.text[i] === "`" || f.text[i] === '"' || f.text[i] === "'") {
        map.set(name, { file: f.rel, text: f.text, openIdx: i });
      }
    }
  }
  return map;
}

/** Resolve a bare-identifier argument to a classification, recursively,
 * cycle-safe. */
function resolveConst(name, constMap, seen = new Set()) {
  if (seen.has(name)) return { cls: "UNCLASSIFIED", what: `const ${name} resolution cycle` };
  seen.add(name);
  const def = constMap.get(name);
  if (!def) return { cls: "UNCLASSIFIED", what: `const ${name} not found under the scanned corpus` };
  const q = def.text[def.openIdx];
  if (q === "`") {
    const { parts } = parseTemplateParts(def.text, def.openIdx);
    if (parts.some((p) => p.type === "interp")) return classifyTemplateParts(parts);
    return classifySqlText(parts.map((p) => p.text).join(""));
  }
  let i = def.openIdx + 1;
  let lit = "";
  while (i < def.text.length && def.text[i] !== q) {
    if (def.text[i] === "\\") {
      lit += def.text.slice(i, i + 2);
      i += 2;
      continue;
    }
    lit += def.text[i];
    i++;
  }
  return classifySqlText(lit);
}

// ---------------------------------------------------------------------------
// Site extraction + verdicts
// ---------------------------------------------------------------------------

/** Receivers whose `.exec` is NOT SqlStorage — each named with its reason.
 * Anything NOT in this table and NOT `sql`/regex-literal fails closed. */
const NON_SQL_RECEIVERS = {
  pattern: "URLPattern instance (mod.ts) — the RegExp.exec family, not SqlStorage",
};

function lineOf(text, idx) {
  let line = 1;
  for (let i = 0; i < idx; i++) if (text[i] === "\n") line++;
  return line;
}

/** Skip a balanced group starting at `open`; strings and comments are already
 * blanked in codeOnly, so bare counting is exact for () and {}. */
function skipBalanced(code, open, opener = "(", closer = ")") {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === opener) depth++;
    else if (code[i] === closer) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** The receiver's last identifier token (and the char before it), walking
 * back over whitespace and blanked comments from the "." of ".exec". */
function receiverTail(code, dotIdx) {
  let i = dotIdx - 1;
  while (i >= 0 && /\s/.test(code[i])) i--;
  const identEnd = i + 1;
  while (i >= 0 && /[A-Za-z0-9_$]/.test(code[i])) i--;
  const ident = code.slice(i + 1, identEnd);
  const before = i >= 0 ? code[i] : "";
  return { ident, before };
}

function auditFile(rel, text, codeOnly) {
  const verdicts = [];
  const re = /\.exec\b/g;
  let m;
  while ((m = re.exec(codeOnly)) !== null) {
    const dotIdx = m.index;
    const line = lineOf(text, dotIdx);
    const site = `${rel}:${line}`;
    let p = dotIdx + m[0].length;
    // optional balanced generic(s): .exec<Row>( / .exec<{ a: string }>(
    if (codeOnly[p] === "<") {
      const close = skipBalanced(codeOnly, p, "<", ">");
      if (close < 0) {
        verdicts.push({ site, line, verdict: "FAIL", kind: "classify", reason: "unterminated generic parameter list" });
        continue;
      }
      p = close;
    }
    while (p < codeOnly.length && /\s/.test(codeOnly[p])) p++;
    if (codeOnly[p] !== "(") {
      verdicts.push({ site, line, verdict: "FAIL", kind: "classify", reason: ".exec used as a reference, not a call — unclassifiable" });
      continue;
    }
    const openParen = p;
    const callEnd = skipBalanced(codeOnly, openParen);
    if (callEnd < 0) {
      verdicts.push({ site, line, verdict: "FAIL", kind: "classify", reason: "unterminated call argument list" });
      continue;
    }
    // receiver classification
    const { ident, before } = receiverTail(codeOnly, dotIdx);
    if (ident === "") {
      if (before === "/") {
        verdicts.push({ site, line, verdict: "RegExp", note: "regex-literal receiver" });
        continue;
      }
      verdicts.push({ site, line, verdict: "FAIL", kind: "classify", reason: `receiver is not an identifier (char ${JSON.stringify(before)}) — not classifiable as SqlStorage` });
      continue;
    }
    if (ident !== "sql") {
      if (NON_SQL_RECEIVERS[ident]) {
        verdicts.push({ site, line, verdict: "RegExp", note: NON_SQL_RECEIVERS[ident] });
        continue;
      }
      if (before === "/" && /^[a-z]*$/.test(ident)) {
        verdicts.push({ site, line, verdict: "RegExp", note: "regex literal with flags" });
        continue;
      }
      verdicts.push({
        site,
        line,
        verdict: "FAIL",
        kind: "classify",
        reason: `receiver identifier ${JSON.stringify(ident)} is not "sql" and not a known non-SqlStorage receiver — extend NON_SQL_RECEIVERS deliberately or rename to sql`,
      });
      continue;
    }

    // first-argument extraction (commentsBlanked: SQL bodies intact)
    let q = openParen + 1;
    while (q < text.length && /\s/.test(text[q])) q++;
    let classification;
    const c = text[q];
    if (c === "`") {
      const { parts } = parseTemplateParts(text, q);
      classification = parts.some((x) => x.type === "interp")
        ? classifyTemplateParts(parts)
        : classifySqlText(parts.map((x) => x.text).join(""));
    } else if (c === '"' || c === "'") {
      let j = q + 1;
      let lit = "";
      while (j < text.length && text[j] !== c) {
        if (text[j] === "\\") {
          lit += text.slice(j, j + 2);
          j += 2;
          continue;
        }
        lit += text[j];
        j++;
      }
      classification = classifySqlText(lit);
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = q;
      while (j < text.length && /[A-Za-z0-9_$]/.test(text[j])) j++;
      const name = text.slice(q, j);
      classification = { ...resolveConst(name, GLOBAL_CONST_MAP), identName: name };
    } else {
      classification = { cls: "UNCLASSIFIED", what: `first argument is ${JSON.stringify(text.slice(q, q + 24))}` };
    }
    if (classification.cls === "UNCLASSIFIED") {
      verdicts.push({
        site,
        line,
        verdict: "FAIL",
        kind: "classify",
        reason: `cannot classify the SQL — ${classification.what}; classify the head keyword deliberately (fail-closed, never guessed)`,
      });
      continue;
    }
    if (classification.cls === "DDL/DML") {
      verdicts.push({
        site,
        line,
        verdict: "DDL/DML",
        note: classification.identName ? `via const ${classification.identName}` : undefined,
      });
      continue;
    }

    // SELECT-bearing: the continuation after the call must prove a full drain
    // (analysis over codeOnly — strings blanked).
    let k = callEnd;
    while (k < codeOnly.length && /\s/.test(codeOnly[k])) k++;
    const rest = codeOnly.slice(k, k + 24);
    if (rest.startsWith(".toArray(")) {
      verdicts.push({ site, line, verdict: "SELECT drained", how: ".toArray()" });
      continue;
    }
    if (rest.startsWith(".one(")) {
      verdicts.push({ site, line, verdict: "SELECT drained", how: ".one() (single-row aggregate)" });
      continue;
    }
    if (rest.startsWith(".next(")) {
      verdicts.push({ site, line, verdict: "FAIL", kind: "drain", reason: ".next() steps ONE row — not a drain; use .toArray()" });
      continue;
    }
    if (rest.startsWith(".raw(")) {
      verdicts.push({ site, line, verdict: "FAIL", kind: "drain", reason: ".raw() returns its own cursor that must itself be drained — not a drain" });
      continue;
    }
    if (rest.startsWith(".")) {
      const mth = /^\.([A-Za-z_$][\w$]*)/.exec(rest);
      verdicts.push({ site, line, verdict: "FAIL", kind: "drain", reason: `chained ${mth ? "." + mth[1] + "()" : "member access"} is not a recognized drain — SqlStorageCursor has no such consumer; use .toArray()` });
      continue;
    }
    // full-iteration shapes: spread [...sql.exec(q)] or direct for..of
    const beforeSlice = codeOnly.slice(Math.max(0, dotIdx - 8), dotIdx);
    if (/\.\.\.\s*$/.test(beforeSlice)) {
      verdicts.push({ site, line, verdict: "SELECT drained", how: "spread iteration" });
      continue;
    }
    if (/\bof\s*$/.test(beforeSlice)) {
      const forParen = codeOnly.lastIndexOf("(", dotIdx);
      const forEnd = forParen >= 0 ? skipBalanced(codeOnly, forParen) : -1;
      let proven = false;
      if (forEnd > 0) {
        let b = forEnd;
        while (b < codeOnly.length && /\s/.test(codeOnly[b])) b++;
        if (codeOnly[b] === "{") {
          const bodyEnd = skipBalanced(codeOnly, b, "{", "}");
          if (bodyEnd > 0) proven = !/\b(break|return)\b/.test(codeOnly.slice(b, bodyEnd));
        }
      }
      if (proven) {
        verdicts.push({ site, line, verdict: "SELECT drained", how: "for..of full iteration (no break/return)" });
        continue;
      }
      verdicts.push({ site, line, verdict: "FAIL", kind: "drain", reason: "for..of over the cursor breaks or returns early (or is unprovable) — the cursor ends mid-walk; materialize with .toArray() first" });
      continue;
    }
    verdicts.push({
      site,
      line,
      verdict: "FAIL",
      kind: "drain",
      reason: `SELECT cursor discarded (continuation ${JSON.stringify(codeOnly.slice(k, k + 8))}) — an un-drained cursor bricks DROP TABLE for the session (workerd#959); drain with .toArray()`,
    });
  }
  return verdicts;
}

// populated before auditing (buildConstMap needs the whole corpus)
let GLOBAL_CONST_MAP = new Map();

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const allFiles = [];
for (const abs of listTsFiles(SRC_ROOT)) {
  allFiles.push({ abs, rel: relative(SRC_ROOT, abs), text: readFileSync(abs, "utf8"), from: "src" });
}
for (const arg of process.argv.slice(2)) {
  const abs = arg.startsWith("/") ? arg : join(process.cwd(), arg);
  allFiles.push({ abs, rel: basename(abs), text: readFileSync(abs, "utf8"), from: "argv" });
}
GLOBAL_CONST_MAP = buildConstMap(allFiles);

const allVerdicts = [];
for (const f of allFiles) {
  const { codeOnly } = views(f.text);
  for (const v of auditFile(f.rel, f.text, codeOnly)) allVerdicts.push({ ...v, from: f.from });
}

const srcVerdicts = allVerdicts.filter((v) => v.from === "src");
const counts = {
  total: srcVerdicts.length,
  sql: srcVerdicts.filter((v) => v.verdict !== "RegExp").length,
  select: srcVerdicts.filter((v) => v.verdict.startsWith("SELECT")).length,
  ddlDml: srcVerdicts.filter((v) => v.verdict === "DDL/DML").length,
  regexp: srcVerdicts.filter((v) => v.verdict === "RegExp").length,
};

console.log(`scanning src/**${process.argv.length > 2 ? " + argv extras" : ""} — the site table:`);
for (const f of allFiles) {
  const vs = allVerdicts.filter((v) => v.from === f.from && v.site.startsWith(f.rel + ":"));
  if (!vs.length) continue;
  console.log(`  ${f.rel}`);
  for (const v of vs) {
    const tag =
      v.verdict === "FAIL"
        ? "  ** FAIL **"
        : v.verdict === "RegExp"
          ? `  (excluded: ${v.note})`
          : v.verdict === "DDL/DML"
            ? `  (DDL/DML — may discard${v.note ? ", " + v.note : ""})`
            : `  (SELECT — drained via ${v.how})`;
    console.log(`    ${v.site}${tag}`);
  }
}

// floors sit below the current true counts and catch scanner collapse
const FLOORS = { total: 60, sql: 55, select: 20, regexp: 3 };

await check(`site census holds the scanner-sanity floors ${JSON.stringify(FLOORS)}`, () => {
  for (const [k, floor] of Object.entries(FLOORS)) {
    assert(counts[k] >= floor, `census.${k} = ${counts[k]} < floor ${floor} — sites went missing or the scanner broke; re-derive floors only with eyes on the site table above`);
  }
});

await check("every `.exec(` site under src/** classifies (none fail-closed)", () => {
  const bad = srcVerdicts.filter((v) => v.verdict === "FAIL" && v.kind === "classify");
  assert(bad.length === 0, `${bad.length} unclassifiable site(s): ${bad.map((v) => `${v.site} — ${v.reason}`).join("; ")}`);
});

await check("EVERY SqlStorage SELECT cursor drains (only DDL/DML may discard)", () => {
  const bad = srcVerdicts.filter((v) => v.verdict === "FAIL" && v.kind === "drain");
  assert(bad.length === 0, `${bad.length} un-drained SELECT cursor(s): ${bad.map((v) => `${v.site} — ${v.reason}`).join("; ")}`);
});

await check("selftest: the mutation arms FAIL and the controls stay green", () => {
  // arms are in-memory snippets — nothing is ever written to disk; the
  // on-disk mutation route is the argv-extras path (see the README section)
  const arms = [
    {
      name: "bare SELECT discard (the exact mutation the fix closed)",
      expect: "fail",
      expectLine: 4,
      code: ["export class Probe {", "  sql;", "  leak(): void {", "    this.sql.exec(`SELECT 1`);", "  }", "}"].join("\n"),
    },
    {
      name: "interpolated head fragment names no keyword (fail-closed)",
      expect: "fail",
      expectLine: 5,
      code: ["export class Probe {", "  sql;", "  q: string;", "  leak(): void {", "    this.sql.exec(`${this.q}`);", "  }", "}"].join("\n"),
    },
    {
      name: ".next() single-step (not a drain)",
      expect: "fail",
      expectLine: 4,
      code: ["export class Probe {", "  sql;", "  leak(): void {", "    this.sql.exec(`SELECT 1`).next();", "  }", "}"].join("\n"),
    },
    {
      name: "control: DDL discard stays legal",
      expect: "pass",
      code: ["export class Probe {", "  sql;", "  ok(): void {", "    this.sql.exec(`DROP TABLE IF EXISTS t`);", "  }", "}"].join("\n"),
    },
    {
      name: "control: drained SELECT stays legal",
      expect: "pass",
      code: ["export class Probe {", "  sql;", "  ok(): void {", "    this.sql.exec(`SELECT 1`).toArray();", "  }", "}"].join("\n"),
    },
  ];
  for (const arm of arms) {
    const { codeOnly } = views(arm.code);
    const vs = auditFile("mutation.ts", arm.code, codeOnly);
    const bad = vs.filter((v) => v.verdict === "FAIL");
    if (arm.expect === "fail") {
      assert(bad.length === 1, `arm ${JSON.stringify(arm.name)}: expected exactly one FAIL, got ${JSON.stringify(vs.map((v) => `${v.site}:${v.verdict}`))}`);
      assert(bad[0].site === `mutation.ts:${arm.expectLine}`, `arm ${JSON.stringify(arm.name)}: the FAIL must name the site, got ${bad[0].site} (want mutation.ts:${arm.expectLine})`);
    } else {
      assert(bad.length === 0, `arm ${JSON.stringify(arm.name)}: expected green, got FAIL: ${bad.map((v) => `${v.site} — ${v.reason}`).join("; ")}`);
    }
  }
});

if (process.argv.length > 2) {
  await check("argv extras clean (an external mutation file ⇒ this FAILS naming its site)", () => {
    const bad = allVerdicts.filter((v) => v.from === "argv" && v.verdict === "FAIL");
    assert(bad.length === 0, `${bad.length} failing site(s) in argv files: ${bad.map((v) => `${v.site} — ${v.reason}`).join("; ")}`);
  });
}

console.log(`\ncensus: ${counts.total} exec sites — ${counts.sql} SqlStorage (${counts.select} SELECT drained / ${counts.ddlDml} DDL-DML discard-ok), ${counts.regexp} RegExp excluded`);
if (failures.length) {
  console.log(`\n${failures.length} check(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${planned} drain-discipline checks passed — every SELECT cursor drains, only DDL/DML discards`);
