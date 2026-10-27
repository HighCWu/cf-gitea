/**
 * The §5.5 accessibility smoke — structural assertions over the serialized
 * page HTML, no browser (SPEC-0008 §5.5: "No browser automation in CI this
 * slice").
 *
 * Dependency decision (documented, U5): parse5 is NOT in the dependency tree
 * (the assets build's Vite does not carry it — verified against node_modules
 * 2026-10-24), so adopting it means a new devDependency plus a root
 * pnpm-lock.yaml change outside this task's file ownership. The walker below
 * is a ~120-line tokenizer tuned to the HTML this UI actually emits: hono/jsx
 * `renderToString` and the markdown-it pipeline always double-quote attribute
 * values, escape embedded quotes as &quot;, and emit well-formed tags, so a
 * real-world HTML5 error-recovery parser buys nothing here. The walker is
 * still defensive: comments, the doctype, raw-text elements (script/style/
 * textarea/title — the config JSON and error collector live in scripts) and
 * self-closing/void tags are all handled; `a11y.test.ts` pins the tricky
 * cases so a broken parser cannot silently pass pages.
 *
 * Rules enforced (runA11y violations, all document-order):
 *   R1  h1 count        — at most one <h1> per page; the home golden's
 *                         exactly-one is asserted in a11y.test.ts. Deviation
 *                         from §5.5's "exactly one h1 (repo name)" recorded:
 *                         the landed DOM has no repo-name h1 (upstream
 *                         header.tmpl has none either at this pin) — home's
 *                         single h1 comes from the README content, and the
 *                         commits/file-view/404 pages carry no content
 *                         headings at all.
 *   R2  heading skips   — consecutive heading levels may not jump upward by
 *                         more than one (h1→h3 is a skip; h3→h1 is fine).
 *   R3  landmarks       — nav#navbar[aria-label], [role="main"] with an
 *                         aria-label, and a <footer> present.
 *   R4  image alt       — every <img> carries an alt attribute.
 *   R5  link names      — every <a> has an accessible name: aria-label, or
 *                         non-empty text content excluding aria-hidden
 *                         subtrees (the octicon SVGs are aria-hidden).
 *   R6  table headers   — every real <table> has a <thead> whose <th> cells
 *                         each carry an explicit scope attribute (scope=col
 *                         added additively to the one real data table,
 *                         components/commit-list.tsx). Exemptions:
 *                         (a) the presentational line tables — the
 *                         code-view blob table (file-view.tsx mirrors
 *                         upstream view_file.tmpl) and the diff line table
 *                         (upstream section_unified.tmpl's `<table
 *                         class="chroma">`) — no header semantics to scope;
 *                         (b) the DEFINITION-SHAPE table (the wave-theadless-
 *                         policy refinement): a thead-less table whose every
 *                         row is exactly one label cell + one value cell
 *                         (two <td>, no <th> anywhere, at least one row).
 *                         POLICY CALL (documented per the mission): the
 *                         defect this rule targets is a header-less DATA
 *                         table — a records×columns grid whose column
 *                         dimension has no names to scope. Upstream renders
 *                         key/value tables thead-less BY DESIGN at the pin —
 *                         stats.tmpl's `<td width="200">{{$statsKey}}</td>
 *                         <td>{{…}}</td>` rows and dashboard.tmpl's
 *                         maintenance-operations rows (`<td>{label}</td>
 *                         <td class="tw-text-right">{run button}</td>`) —
 *                         because each row is self-describing (the label IS
 *                         the row header; there is no column dimension), so
 *                         forcing a thead would diverge from upstream for no
 *                         a11y gain. The shape test is structural and total:
 *                         any <th> anywhere, any row with ≠2 cells, or zero
 *                         rows falls back to the data-table path (thead
 *                         required) — the same shape also classifies the
 *                         un-golden'd admin-dashboard task table and wiki
 *                         pages list as upstream-faithful. #repo-files-table
 *                         is deliberately NOT an HTML table (§2.4.1 upstream
 *                         div shape) — its row/cell structure is asserted
 *                         structurally in a11y.test.ts instead.
 */

// --- minimal element tree -------------------------------------------------------

export interface A11yElement {
  tag: string;
  attrs: Record<string, string>;
  parent: A11yElement | null;
  children: A11yElement[];
  /** Direct text content, entities already unescaped. */
  textParts: string[];
}

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);

/** Elements whose content is raw text, never markup (walked past verbatim). */
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title"]);

function unescapeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&");
}

interface ParsedTag {
  tag: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  /** Offset just past the closing `>`. */
  end: number;
}

/** Parse one start tag at `start` (which must point at `<`). Attribute values
 *  are always double-quoted in our emitters; a bare `>` inside a quoted value
 *  is consumed as part of the value. Returns null on malformed input — the
 *  test suite fails loudly rather than the walker guessing. */
function parseStartTag(html: string, start: number): ParsedTag | null {
  const nameMatch = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(start, start + 32));
  if (nameMatch === null) return null;
  const tag = nameMatch[1]?.toLowerCase() ?? "";
  const attrs: Record<string, string> = {};
  let i = start + 1 + (nameMatch[1]?.length ?? 0);
  while (i < html.length) {
    const ch = html[i];
    if (ch === undefined) return null;
    if (ch === ">") return { tag, attrs, selfClosing: false, end: i + 1 };
    if (ch === "/") {
      if (html[i + 1] === ">") return { tag, attrs, selfClosing: true, end: i + 2 };
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    // Attribute name: up to whitespace, `=`, `/` or `>`.
    let nameEnd = i;
    while (nameEnd < html.length) {
      const c = html[nameEnd];
      if (c === undefined || /\s/.test(c) || c === "=" || c === "/" || c === ">") break;
      nameEnd += 1;
    }
    const name = html.slice(i, nameEnd).toLowerCase();
    i = nameEnd;
    if (html[i] === "=") {
      i += 1;
      if (html[i] === '"') {
        const close = html.indexOf('"', i + 1);
        if (close < 0) return null;
        attrs[name] = unescapeEntities(html.slice(i + 1, close));
        i = close + 1;
      } else {
        // Unquoted value (never emitted by our renderers, tolerated anyway).
        let valueEnd = i;
        while (valueEnd < html.length) {
          const c = html[valueEnd];
          if (c === undefined || /\s/.test(c) || c === ">") break;
          valueEnd += 1;
        }
        attrs[name] = unescapeEntities(html.slice(i, valueEnd));
        i = valueEnd;
      }
    } else {
      attrs[name] = "";
    }
  }
  return null; // ran off the end inside a tag
}

/** Build the element tree of one serialized document. Throws on structurally
 *  impossible input (a stray `<` that is not a comment/tag) — our renderers
 *  never produce that, and the smoke must not silently mis-parse. */
export function parseHtmlTree(html: string): A11yElement {
  const root: A11yElement = { tag: "#document", attrs: {}, parent: null, children: [], textParts: [] };
  let current = root;
  const stack: A11yElement[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i) current.textParts.push(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      i = close < 0 ? html.length : close + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const close = html.indexOf(">", lt);
      i = close < 0 ? html.length : close + 1;
      continue;
    }
    if (html.startsWith("</", lt)) {
      const close = html.indexOf(">", lt);
      if (close < 0) throw new Error(`a11y walker: unterminated close tag at ${lt}`);
      const tag = html.slice(lt + 2, close).trim().toLowerCase();
      // Tolerant pop: close the nearest matching open element.
      const openIdx = stack.map((el) => el.tag).lastIndexOf(tag);
      if (openIdx < 0) throw new Error(`a11y walker: close tag </${tag}> without opener at ${lt}`);
      stack.length = openIdx;
      current = stack[stack.length - 1] ?? root;
      i = close + 1;
      continue;
    }
    const parsed = parseStartTag(html, lt);
    if (parsed === null) throw new Error(`a11y walker: unparseable start tag at ${lt}: ${html.slice(lt, lt + 60)}`);
    const el: A11yElement = { tag: parsed.tag, attrs: parsed.attrs, parent: current, children: [], textParts: [] };
    current.children.push(el);
    i = parsed.end;
    if (parsed.selfClosing || VOID_TAGS.has(parsed.tag)) continue;
    if (RAW_TEXT_TAGS.has(parsed.tag)) {
      // Skip verbatim to the matching close tag — script/style bodies are
      // never markup (the config JSON / error collector live here).
      const close = html.indexOf(`</${parsed.tag}`, i);
      if (close < 0) throw new Error(`a11y walker: <${parsed.tag}> never closed`);
      const closeEnd = html.indexOf(">", close);
      i = closeEnd < 0 ? html.length : closeEnd + 1;
      continue;
    }
    stack.push(el);
    current = el;
  }
  return root;
}

// --- tree queries ----------------------------------------------------------------

/** All descendants (including `el` itself) in document order. */
export function descendants(el: A11yElement): A11yElement[] {
  const out: A11yElement[] = [];
  const walk = (node: A11yElement): void => {
    out.push(node);
    for (const child of node.children) walk(child);
  };
  // `el` itself is the caller's root — include it only when it is not the
  // synthetic #document node.
  if (el.tag !== "#document") out.push(el);
  for (const child of el.children) walk(child);
  return out;
}

function hasAriaHiddenAncestor(el: A11yElement): boolean {
  let node: A11yElement | null = el;
  while (node !== null) {
    if (node.attrs["aria-hidden"] === "true") return true;
    node = node.parent;
  }
  return false;
}

function ownText(el: A11yElement): string {
  const parts: string[] = [];
  const walk = (node: A11yElement): void => {
    parts.push(...node.textParts);
    for (const child of node.children) {
      if (child.attrs["aria-hidden"] === "true") continue; // hidden subtrees are silent
      walk(child);
    }
  };
  walk(el);
  return unescapeEntities(parts.join("")).replace(/\s+/g, " ").trim();
}

/** The accessible name the smoke recognizes: aria-label, else rendered text
 *  with aria-hidden subtrees removed. (aria-labelledby has no emitters in
 *  this slice — asserted absent nowhere, just not consulted.) */
export function accessibleName(el: A11yElement): string {
  const label = el.attrs["aria-label"];
  if (label !== undefined && label.trim() !== "") return label.trim();
  return ownText(el);
}

function hasClass(el: A11yElement, cls: string): boolean {
  return (el.attrs.class ?? "").split(/\s+/).includes(cls);
}

function hasPresentationalTableAncestor(el: A11yElement): boolean {
  let node: A11yElement | null = el;
  while (node !== null) {
    // code-view: the blob file view's line table; code-diff: the diff view's
    // unified line table (same presentational shape, upstream section_unified.tmpl).
    if (hasClass(node, "code-view") || hasClass(node, "code-diff")) return true;
    node = node.parent;
  }
  return false;
}

/** The R6 definition-shape test (the wave-theadless-policy exemption): every
 *  row is exactly one label td + one value td, with no <th> anywhere and at
 *  least one row — the vacuous empty-table match would silently exempt a
 *  data table that lost BOTH its headers and its rows. Cites in the header
 *  comment (stats.tmpl, dashboard.tmpl). */
function isDefinitionShapeTable(table: A11yElement): boolean {
  const rows = descendants(table).filter((el) => el.tag === "tr");
  if (rows.length === 0) return false;
  if (descendants(table).some((el) => el.tag === "th")) return false;
  return rows.every((row) => row.children.length === 2 && row.children.every((cell) => cell.tag === "td"));
}

export function getElementById(root: A11yElement, id: string): A11yElement | null {
  return descendants(root).find((el) => el.attrs.id === id) ?? null;
}

// --- the §5.5 rules --------------------------------------------------------------

export interface A11yViolation {
  rule: string;
  detail: string;
}

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** Run every §5.5 rule over one rendered page; empty array = clean. */
export function runA11y(html: string): A11yViolation[] {
  const root = parseHtmlTree(html);
  const all = descendants(root);
  const violations: A11yViolation[] = [];
  const add = (rule: string, detail: string): void => {
    violations.push({ rule, detail });
  };

  // R1 — at most one h1 per page (see the header note for the deviation from
  // §5.5's "exactly one").
  const h1s = all.filter((el) => el.tag === "h1");
  if (h1s.length > 1) add("R1-single-h1", `${h1s.length} <h1> elements`);

  // R2 — no upward level skips between consecutive headings.
  const headings = all.filter((el) => HEADING_TAGS.has(el.tag));
  let previous: A11yElement | null = null;
  for (const heading of headings) {
    if (previous !== null) {
      const prev = Number(previous.tag.slice(1));
      const level = Number(heading.tag.slice(1));
      if (level > prev + 1) add("R2-no-skip", `<${previous.tag}> followed by <${heading.tag}>`);
    }
    previous = heading;
  }

  // R3 — landmarks.
  const navbar = all.find((el) => el.tag === "nav" && el.attrs.id === "navbar");
  if (navbar === undefined) add("R3-landmarks", "nav#navbar missing");
  else if ((navbar.attrs["aria-label"] ?? "").trim() === "") add("R3-landmarks", "nav#navbar lacks aria-label");
  const main = all.find((el) => el.attrs.role === "main");
  if (main === undefined) add("R3-landmarks", '[role="main"] missing');
  else if ((main.attrs["aria-label"] ?? "").trim() === "") add("R3-landmarks", '[role="main"] lacks aria-label');
  if (!all.some((el) => el.tag === "footer")) add("R3-landmarks", "<footer> missing");

  // R4 — every img carries alt (value may be empty: decorative).
  for (const img of all.filter((el) => el.tag === "img")) {
    if (img.attrs.alt === undefined) add("R4-img-alt", `<img src="${img.attrs.src ?? ""}"> without alt`);
  }

  // R5 — every anchor has an accessible name.
  for (const anchor of all.filter((el) => el.tag === "a")) {
    if (hasAriaHiddenAncestor(anchor)) continue;
    if (accessibleName(anchor) === "") {
      add("R5-link-name", `<a href="${anchor.attrs.href ?? ""}"> without text or aria-label`);
    }
  }

  // R6 — real data tables: thead present, every th carries an explicit
  // scope. The code-view / code-diff line tables are presentational
  // (upstream shapes); the definition-shape table (label/value rows, the
  // upstream-faithful key/value idiom — the header comment's policy call)
  // has no column dimension to scope, so it is exempt from the thead
  // requirement while every other thead-less table still fires.
  for (const table of all.filter((el) => el.tag === "table")) {
    if (hasPresentationalTableAncestor(table)) continue;
    const thead = table.children.find((child) => child.tag === "thead");
    if (thead === undefined) {
      if (!isDefinitionShapeTable(table)) {
        add("R6-table-headers", `table#${table.attrs.id ?? "(no id)"} has no thead`);
      }
      continue;
    }
    for (const th of descendants(thead).filter((el) => el.tag === "th")) {
      if (th.attrs.scope !== "col" && th.attrs.scope !== "row" && th.attrs.scope !== "colgroup" && th.attrs.scope !== "rowgroup") {
        add("R6-table-headers", `table#${table.attrs.id ?? "(no id)"}: <th> without scope`);
      }
    }
  }

  return violations;
}
