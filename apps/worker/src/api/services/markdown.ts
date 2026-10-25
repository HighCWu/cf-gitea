import MarkdownIt from "markdown-it";
// markdown-it 15 bundles its own types: the default export is the callable
// constructor VALUE; the instance TYPE is a separate named export.
import type { MarkdownIt as MarkdownItInstance, Token } from "markdown-it";

import { ApiError } from "../errors";

/**
 * Shared markdown renderer behind `POST /markdown` and `POST /markdown/raw`
 * (SPEC-0004 §2.4) — deliberately dependency-free of D1/router code so the
 * future server-side UI pipeline (SPEC-0008 §3.4) can reuse it.
 *
 * Upstream semantics mirrored from `routers/common/markup.go RenderMarkup`
 * (called by routers/api/v1/misc/markup.go with mode = wiki||Mode):
 *
 *  - mode "" / "markdown": raw CommonMark, NO special handling — upstream
 *    explicitly ignores `Context` here ("raw markdown doesn't do any link
 *    processing", markup.go TODO), so `[[wiki-links]]` stay literal.
 *  - mode "gfm" | "comment" | "file": repo-context rendering. Relative links
 *    rewrite into `{origin}/{owner}/{repo}/src/{ref}/{path}`, relative images
 *    into `{origin}/{owner}/{repo}/media/{ref}/{path}` — the repo-file policy
 *    (upstream renderhelper.NewRenderContextRepoFile; comment mode's
 *    issue-reference resolution needs the issue tables, TODO(SPEC-0005)).
 *  - mode "wiki" (or Wiki: true — upstream `util.Iif(form.Wiki, "wiki", …)`,
 *    markup.go:63): `[[target]]` / `[[label|target]]` wiki links and relative
 *    links → `{origin}/{owner}/{repo}/wiki/{path}`, images →
 *    `{origin}/{owner}/{repo}/wiki/raw/{path}`.
 *  - anything else → 422 "unsupported render mode: <mode>" (upstream
 *    markup.go default branch; the runtime body is our {message,url} error
 *    family, upstream writes the bare message — SPEC-0004 §2.5 conversion).
 *
 * Rendering posture is SPEC-0008 §3.4's documented divergence from upstream's
 * goldmark+sanitizer: markdown-it (CommonMark), `html: false` (raw HTML in
 * the source is escaped — XSS-safe by construction), `linkify: true`,
 * `typographer: false`. All anchors get `rel="nofollow"`; anchors wrapping an
 * image get `target="_blank"` + `rel="nofollow noopener"` (upstream
 * post-processing behavior, visible in routers/api/v1/misc/markup_test.go).
 * Headings get upstream-style slug anchors (`id="user-content-…"`) so the
 * official `.markup` CSS applies unchanged.
 */

/** Upstream caps the raw-markdown read at `setting.UI.MaxDisplayFileSize`
 * (gitea/modules/setting/ui.go default — markup.go:88 LimitReader). */
export const MAX_DISPLAY_FILE_SIZE = 8_388_608;

/** Repo ref used when the render context carries no `src/{kind}/{ref}` path
 * (upstream falls back to the repo's default branch; value matches
 * `DEFAULT_BRANCH` in services/repository.ts, kept local so this module
 * stays import-free for UI reuse). */
const DEFAULT_RENDER_BRANCH = "main";

/** The `{owner, repo, ref}` parsed out of MarkdownOption.Context. */
export interface RenderContext {
  owner: string;
  repo: string;
  /** URL segment after /src/, e.g. "branch/main" or "branch/main/doc". */
  refPath: string;
}

/**
 * Go `strings.SplitN` — the tail keeps the remainder (JS `split(sep, n)`
 * *drops* it instead, which would truncate tree paths containing slashes).
 */
function splitN(value: string, separator: string, n: number): string[] {
  const parts = value.split(separator);
  if (parts.length <= n) {
    return parts;
  }
  return [...parts.slice(0, n - 1), parts.slice(n - 1).join(separator)];
}

/**
 * Parse MarkdownOption.Context — upstream markup.go:52–61. Two shapes:
 * "/{owner}/{repo}/src/{branch|commit|tag}/{ref}/{tree}" (5 fields, the ref
 * path keeps the remainder) and "{owner}/{repo}" (2 fields). Anything else
 * yields no repo context (no link rewriting).
 */
export function parseRenderContext(context: string): RenderContext | null {
  const repoLinkPath = context.startsWith("/") ? context.slice(1) : context;
  const withRef = splitN(repoLinkPath, "/", 5);
  if (
    withRef.length === 5 &&
    withRef[2] === "src" &&
    (withRef[3] === "branch" || withRef[3] === "commit" || withRef[3] === "tag")
  ) {
    const owner = withRef[0];
    const repo = withRef[1];
    const refPath = withRef[4];
    if (owner !== undefined && repo !== undefined && refPath !== undefined && owner !== "" && repo !== "") {
      return { owner, repo, refPath: `${withRef[3] ?? "branch"}/${refPath}` };
    }
  }
  const nameOnly = splitN(repoLinkPath, "/", 3);
  if (nameOnly.length === 2) {
    const owner = nameOnly[0];
    const repo = nameOnly[1];
    if (owner !== undefined && repo !== undefined && owner !== "" && repo !== "") {
      return { owner, repo, refPath: `branch/${DEFAULT_RENDER_BRANCH}` };
    }
  }
  return null;
}

/** Absolute targets (scheme, protocol-relative, in-page, root) pass through;
 * everything else is rewritten against the repo context. */
function isRelativeTarget(target: string): boolean {
  if (target === "" || target.startsWith("/") || target.startsWith("#")) {
    return false;
  }
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target);
}

/** Resolve a relative target against the context prefix with the standard
 * URL algorithm — "b.md" joins the prefix, "../" pops into the ref/tree path
 * (clamped at the origin), the `#fragment` survives. */
function resolveRelativeTarget(target: string, base: string): string {
  return new URL(target, base).toString();
}

/** Per-mode URL prefixes for relative link/image rewriting. Trailing slash
 * required — relative targets are resolved with the URL algorithm, which
 * would otherwise replace the last path segment instead of appending. */
interface RewritePolicy {
  linkBase: string;
  imageBase: string;
}

/**
 * Upstream's `[[wiki-link]]` syntax is a goldmark parser extension; the
 * markdown-it port pre-processes the source in wiki mode: `[[label|target]]`
 * → `[label](<target>)`, `[[target]]` → `[target](<target>)`. Image targets
 * render as a linked image with upstream's `title` (file name) / `alt`
 * (full path) split — markup_test.go's `[[images/icon-bug.png]]` golden.
 */
function rewriteWikiLinks(text: string): string {
  const imageTarget = /\.(?:png|gif|jpe?g|webp|svg|avif|ico)$/i;
  const linkedImage = (target: string): string =>
    `[![${target}](<${target}> "${target.split("/").pop() ?? target}")](<${target}>)`;
  return text
    .replace(/\[\[([^\]|\n]+)\|([^\]\n]+)\]\]/g, (_match, label: string, target: string) => {
      const trimmed = target.trim();
      return imageTarget.test(trimmed) ? linkedImage(trimmed) : `[${label}](<${trimmed}>)`;
    })
    .replace(/\[\[([^\]|\n]+)\]\]/g, (_match, target: string) => {
      const trimmed = target.trim();
      return imageTarget.test(trimmed) ? linkedImage(trimmed) : `[${trimmed}](<${trimmed}>)`;
    });
}

function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "")
    .replace(/-+/g, "-");
}

/** Whether the anchor at `idx` wraps an image (inline stream, siblings until
 * link_close) — upstream marks those `target="_blank"`. */
function anchorWrapsImage(tokens: Token[], idx: number): boolean {
  for (let i = idx + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) {
      break;
    }
    if (token.type === "link_close") {
      break;
    }
    if (token.type === "image") {
      return true;
    }
  }
  return false;
}

/** Build a renderer for one request — per-call instances keep the rewrite
 * policy out of module state (AGENTS Workers rule: no mutable request state
 * at module level). */
function createRenderer(policy: RewritePolicy | null): MarkdownItInstance {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false });

  md.core.ruler.push("cf_gitea_heading_anchor", (state) => {
    for (let i = 0; i < state.tokens.length; i++) {
      const token = state.tokens[i];
      if (token === undefined || token.type !== "heading_open") {
        continue;
      }
      const inline = state.tokens[i + 1];
      const text = (inline?.children ?? [])
        .filter((child) => child.type === "text" || child.type === "code_inline")
        .map((child) => child.content)
        .join("");
      token.attrSet("id", `user-content-${slugifyHeading(text)}`);
    }
  });

  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token: Token | undefined = tokens[idx];
    if (token !== undefined) {
      const href = String(token.attrGet("href") ?? "");
      if (policy !== null && isRelativeTarget(href)) {
        token.attrSet("href", resolveRelativeTarget(href, policy.linkBase));
      }
      if (anchorWrapsImage(tokens, idx)) {
        token.attrSet("target", "_blank");
        token.attrSet("rel", "nofollow noopener");
      } else {
        token.attrSet("rel", "nofollow");
      }
    }
    return self.renderToken(tokens, idx, options);
  };

  // The default image rule renders alt/title from the token's children —
  // rewrite src first, then delegate (renderToken would drop them).
  const defaultImageRule = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token: Token | undefined = tokens[idx];
    if (token !== undefined) {
      const src = String(token.attrGet("src") ?? "");
      if (policy !== null && isRelativeTarget(src)) {
        token.attrSet("src", resolveRelativeTarget(src, policy.imageBase));
      }
    }
    return defaultImageRule === undefined
      ? self.renderToken(tokens, idx, options)
      : defaultImageRule(tokens, idx, options, env, self);
  };

  return md;
}

export interface RenderMarkdownInput {
  /** MarkdownOption.Text. */
  text: string;
  /** MarkdownOption.Mode ("" behaves like "markdown"). */
  mode: string;
  /** MarkdownOption.Context (repo URL path or "{owner}/{repo}"). */
  context: string;
  /** MarkdownOption.Wiki — deprecated upstream, forces wiki mode. */
  wiki: boolean;
  /** Instance origin the rewritten URLs are absolute against (AppURL). */
  origin: string;
}

/** Modes accepted besides the plain-markdown ones (MarkdownOption.Mode). */
const REPO_RENDER_MODES = new Set(["gfm", "comment", "file", "wiki"]);

/**
 * Render one MarkdownOption payload to the HTML fragment the endpoint
 * returns. Throws the upstream 422 for unknown modes.
 */
export function renderMarkdownToHtml(input: RenderMarkdownInput): string {
  const mode = input.wiki ? "wiki" : input.mode === "" ? "markdown" : input.mode;

  if (mode === "markdown") {
    // Raw markdown: upstream skips ALL context handling (markup.go:45–53).
    return createRenderer(null).render(input.text);
  }
  if (!REPO_RENDER_MODES.has(mode)) {
    // upstream markup.go default branch — exact message.
    throw new ApiError(422, `unsupported render mode: ${mode}`);
  }

  const context = parseRenderContext(input.context);
  if (context === null) {
    // No usable repo context → render without rewriting (upstream can only
    // build links from the Context path, markup.go:33–49).
    if (mode === "wiki") {
      return createRenderer(null).render(rewriteWikiLinks(input.text));
    }
    return createRenderer(null).render(input.text);
  }

  const base = `${input.origin}/${context.owner}/${context.repo}`;
  const policy: RewritePolicy =
    mode === "wiki"
      ? { linkBase: `${base}/wiki/`, imageBase: `${base}/wiki/raw/` }
      : { linkBase: `${base}/src/${context.refPath}/`, imageBase: `${base}/media/${context.refPath}/` };

  const text = mode === "wiki" ? rewriteWikiLinks(input.text) : input.text;
  return createRenderer(policy).render(text);
}

/**
 * Byte-exact port of upstream's `io.LimitReader(body, MaxDisplayFileSize)`
 * (markup.go:88): reads at most `limit` bytes and DISCARDS the rest without
 * buffering it — the request stream is cancelled once the cap is reached.
 */
export async function readLimitedText(request: Request, limit: number): Promise<string> {
  // workerd types Request.body loosely (`ReadableStream<any>`); every body
  // here is a byte stream. Plain `as` (same posture as src/git-http/gzip.ts).
  const body = request.body as ReadableStream<Uint8Array> | null;
  const reader = body?.getReader();
  if (reader === undefined) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || value === undefined) {
      break;
    }
    chunks.push(value);
    total += value.byteLength;
    if (total >= limit) {
      void reader.cancel().catch(() => {});
      break;
    }
  }
  const merged = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.byteLength, merged.byteLength - offset);
    if (take <= 0) {
      break;
    }
    merged.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return new TextDecoder().decode(merged);
}
