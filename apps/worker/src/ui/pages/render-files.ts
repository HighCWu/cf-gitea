/**
 * The rendered blob views — the parity survey's row 3: the web mux's render
 * family over the landed markdown pipeline, upstream
 *
 *   GET /{owner}/{repo}/render/{branch|tag|commit}/*   web.go:1715-1718
 *                                   (context.RepoRefByType + repo.RenderFile)
 *   GET /{owner}/{repo}/render/blob/{sha}              web.go:1719
 *                                   (repo.RenderFile, the direct-sha arm)
 *
 * under the repo-code group's gates (web.go:1653-1762's closing args):
 * `optSignIn`, `context.RepoAssignment` (the §2.5 prologue),
 * `reqUnitCodeReader` (the visibility resolution covers the code read) plus
 * the subgroup's `repo.MustBeNotEmpty` — an empty repo 404-shells.
 *
 * ## The upstream handler (routers/web/repo/render.go:18-77)
 *
 * It is a GET page-fragment route (the official bundle's
 * `iframe.external-render-iframe` fetches it as a STANDALONE page —
 * markup.RenderIFrame builds the `data-src` from exactly this URL family,
 * render.go:196-207). The flow: resolve the blob (TreePath arms via
 * GetBlobByPath, the `blob/{sha}` arm via GetBlob), detect the renderer from
 * the file NAME (DetectMarkupRendererByReader → DetectRendererTypeByPrefetch
 * — RelativePath carries the name), refuse a missing renderer with
 * `http.Error(…, "Unable to find renderer", 400)` (render.go:59-61), refuse
 * a renderer that is not EXTERNAL with "Unable to get external renderer"
 * (render.go:64-66), then stream the rendered HTML to the response (Go's
 * auto-sniff answers `text/html; charset=utf-8` — the pin's integration
 * test asserts the header, markup_external_test.go FramePage).
 *
 * ## The port, over the landed pipeline (the documented divergences)
 *
 * Our renderer universe is the one landed markup pipeline
 * (api/services/markdown.ts — the §3.4 markdown-it port that already feeds
 * the README/file-view surfaces). Upstream's DEFAULT renderer set is
 * markdown (.md/.markdown/.mdown/.mkd/.livemd — setting/markup.go:83's
 * FILE_EXTENSIONS default) + orgmode/csv/console/jupyter, and its markdown
 * renderer is NOT external (markdown.go registers no GetExternalRendererOptions)
 * — so upstream at the default config answers .md files 400 "Unable to get
 * external renderer" and only jupyter (.ipynb) plus configured external tools
 * render here. THIS port renders the markdown family through the landed
 * pipeline as the standalone page (mode "file" — the exact context shape
 * page-data.renderRepoMarkdown builds: `/{owner}/{repo}/src/{refType}/{ref}/
 * {dir}`), because the survey row's contract is "rendered blob views over the
 * landed markup pipeline" and a route that 400s every renderable file serves
 * nothing. Every other file answers the "Unable to find renderer" 400 class
 * (upstream's no-renderer arm — our tree has no orgmode/csv/console/jupyter
 * renderers to find). The standalone page carries the external-renderer
 * sandbox CSP the pin's own FramePage test asserts
 * (`sandbox allow-scripts allow-forms allow-modals allow-popups
 * allow-downloads` — MarkupRenderDefaultSandbox, setting/markup.go:243;
 * upstream picks it from the renderer options at render.go:68-73).
 *
 * - The `blob/{sha}` arm is upstream-DEGENERATE: TreePath is empty, so the
 *   RelativePath-based renderer detection misses for EVERY input
 *   (render.go:74-76 renders.go:151-154 — `MarkupType` stays "" → nil
 *   renderer → 400 "Unable to find renderer"). The port mirrors it:
 *   GetBlob's not-exist → the 404 shell, a resolvable object → the 400 class.
 *   Divergence corner: a BLOB oid (non-commit) passes upstream's GetBlob but
 *   fails our readCommit existence probe → 404 here (the engine boundary has
 *   no object-type read; the arm 400s every valid input upstream anyway).
 * - Oversize sources ride upstream's LimitReader arm
 *   (services/markdown.ts's MAX_DISPLAY_FILE_SIZE = setting.UI.
 *   MaxDisplayFileSize, markup.go:88): bytes beyond 8 MiB are truncated, not
 *   refused.
 * - Cache-control: the web middleware's zero-option prod stamp (the
 *   diffpatch/archive precedent) on both the 200 and the 400 class.
 */

import { renderMarkdownToHtml, MAX_DISPLAY_FILE_SIZE } from "../../api/services/markdown";
import { engineReads } from "../../api/services/engine";
import { isBinaryData } from "../page-data";
import { resolveRefSuffix, type RefType } from "../index";

/** setting/markup.go:83's markdown FILE_EXTENSIONS default — the route's
 *  renderability set (page-data's README set is its own older landed list,
 *  deliberately not shared: the two surfaces document their sets apart). */
const RENDER_MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd", ".livemd"]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

/** The loader's repo subset (the caller's resolved row). */
export type RenderFileRepo = {
  ownerNamespace: string;
  slug: string;
  isEmpty: boolean;
  defaultBranch: string;
};

/** One parse shape: the typed-ref arms' resolved suffix or the blob sha. */
export type RenderFileTarget =
  | { kind: "ref"; refType: RefType; refSuffix: string }
  | { kind: "blob"; sha: string };

/** The load outcomes (module header): the rendered fragment, the upstream
 *  no-renderer 400 class, or `null` — the 404 family (empty repo, wrong-
 *  universe/unknown ref, missing blob-path, the blob arm's unknown sha). */
export type RenderFileLoad =
  | { kind: "rendered"; html: string }
  | { kind: "no-renderer" }
  | { kind: "not-found" };

/**
 * Resolve + render one `/render/*` target over the landed pipeline (module
 * header for the shape citations and the divergence ledger).
 */
export async function loadRenderFile(env: Env, repo: RenderFileRepo, target: RenderFileTarget, origin: string): Promise<RenderFileLoad> {
  if (repo.isEmpty) return { kind: "not-found" }; // MustBeNotEmpty (web.go:1720's group gate)
  const reads = engineReads(env, repo);

  if (target.kind === "blob") {
    // The degenerate arm (module header): existence, then the 400 class.
    const commit = await reads.readCommit(target.sha);
    if (commit === null) return { kind: "not-found" };
    return { kind: "no-renderer" };
  }

  const refs = await reads.listRefs();
  if (refs === null) return { kind: "not-found" };
  const names = refs.refs.map((ref) => ref.name);
  const resolved = resolveRefSuffix(
    target.refType,
    target.refSuffix,
    {
      branches: names.filter((name) => name.startsWith("refs/heads/")).map((name) => name.slice("refs/heads/".length)),
      tags: names.filter((name) => name.startsWith("refs/tags/")).map((name) => name.slice("refs/tags/".length)),
      defaultBranch: repo.defaultBranch,
    },
  );
  if (resolved === null) return { kind: "not-found" }; // "branch or tag not exist" (repo.go:976-979)
  // An empty TreePath has no blob to name — GetBlobByPath("") is upstream's
  // NotFound arm.
  if (resolved.treePath === "") return { kind: "not-found" };

  const blob = await reads.readBlob(resolved.ref, resolved.treePath);
  if (blob === null) return { kind: "not-found" };
  // The route's renderability decision is the file NAME (module header): a
  // markdown-family extension renders, everything else is the no-renderer
  // 400 class — checked BEFORE the pipeline cost, exactly upstream's
  // detection order.
  if (!RENDER_MARKDOWN_EXTENSIONS.has(extensionOf(resolved.treePath))) return { kind: "no-renderer" };
  if (isBinaryData(blob.data)) return { kind: "no-renderer" }; // sniffed binaries find no text renderer

  // The LimitReader arm (markup.go:88): truncate at MaxDisplayFileSize.
  const text = new TextDecoder().decode(
    blob.data.length > MAX_DISPLAY_FILE_SIZE ? blob.data.subarray(0, MAX_DISPLAY_FILE_SIZE) : blob.data,
  );
  const dir = resolved.treePath.includes("/") ? resolved.treePath.split("/").slice(0, -1).join("/") : "";
  const html = renderMarkdownToHtml({
    text,
    mode: "file",
    context: `/${repo.ownerNamespace}/${repo.slug}/src/${resolved.refType}/${resolved.ref}${dir === "" ? "" : `/${dir}`}`,
    wiki: false,
    origin,
  });
  return { kind: "rendered", html };
}

/** MarkupRenderDefaultSandbox (setting/markup.go:243) — the standalone
 *  render page's CSP (the pin's FramePage test asserts the exact value). */
const STANDALONE_RENDER_CSP = "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads";

/** The web middleware's zero-option prod Cache-Control (the download
 *  families' stamp — every HTML answer carries it). */
const WEB_CACHE_CONTROL = "max-age=0, private, must-revalidate";

/** The 200 — the rendered fragment streamed as the standalone page (Go's
 *  auto-sniff answers text/html; charset=utf-8, the FramePage assertion). */
export function renderFileResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": STANDALONE_RENDER_CSP,
      "cache-control": WEB_CACHE_CONTROL,
    },
  });
}

/** The no-renderer 400 class — http.Error's plain-text form
 *  (base.go:105-113: the message + trailing newline, nosniff), the render
 *  family's exact render.go:59-61 refusal. */
export function renderNotAvailableResponse(): Response {
  return new Response("Unable to find renderer\n", {
    status: 400,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": WEB_CACHE_CONTROL,
    },
  });
}
