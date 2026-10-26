/**
 * The blob-excerpt fragment — stage 3 of the machinery handoff
 * (api/services/blob-excerpt.ts's module header): the hunk-window expansion
 * rows the PR diff view's "expand N lines" buttons fetch, upstream
 *
 *   GET /{owner}/{repo}/blob_excerpt/{sha}        web.go:1735 (the repo twin)
 *   GET /{owner}/{repo}/wiki/blob_excerpt/{sha}   web.go:1618 (the wiki twin)
 *                                 repo.ExcerptBlob (routers/web/repo/compare.go:706-795)
 *                                 → ctx.HTML(tplBlobExcerpt) — templates/repo/diff/blob_excerpt.tmpl
 *
 * — the fragment the official bundle's `data-fetch-sync="$closest(tr)"`
 * expander buttons morph into the diff table (RenderBlobExcerptButtons,
 * services/gitdiff/gitdiff.go:232-265, riding the machinery's
 * getExpandDirection). The answer is a bare sequence of `<tr>` elements —
 * the template's own bytes, no table wrapper, no layout (the
 * lastcommit-fragment's standalone posture).
 *
 * ## The upstream handler, knob by knob
 *
 * - INPUTS: the `{sha}` path param (the after-commit; NO hex constraint on
 *   the route shape — any value, GetCommit's failure is the 500 class → our
 *   404 family) plus the expander's round-tripped form fields
 *   (compare.go:708-716): `last_left`/`last_right`/`left`/`right`/
 *   `left_hunk_size`/`right_hunk_size` (FormInt — strconv.Atoi, a missing or
 *   malformed value is 0), `direction`/`path`/`filelang` (FormString). They
 *   feed the machinery's `buildBlobExcerptSection` verbatim.
 * - THE WIKI TWIN mounts (web.go:1618): `PageIsWiki` swaps the git repo for
 *   the WIKI STORAGE REPO (compare.go:721-728 — `WikiStorageRepo()`, the
 *   sibling `{repo}.wiki.git`) and the buttons' BaseLink becomes
 *   `{RepoLink}/wiki/blob_excerpt` (compare.go:729). Ours is the landed
 *   sibling engine cell `ownerNamespace/slug.wiki` (src/services/wiki.ts's
 *   cell-addressing convention) — the loader swaps the read client's cell and
 *   nothing else. The twin's group gates (web.go:1609-1624):
 *   `repo.MustEnableWiki` → the repo-settings `hasWiki` read (the wave-45
 *   hasProjects precedent), `reqUnitWikiReader` → the §2.5 visibility
 *   prologue. The MAIN repo's emptiness does NOT gate the twin (upstream's
 *   group has no MustBeNotEmpty — a wiki works on an empty repo); the repo
 *   twin answers the empty arm with the 404 family (upstream's nil-GitRepo
 *   ServerError, the aux-fragment convention).
 * - GetBlobByPath (compare.go:742-752): the blob at the after-commit for
 *   `path` — one engine `readBlob(sha, path)` (the engine resolves + peels +
 *   looks up in one RPC; commit.go:79-81's tree walk). A missing path or an
 *   unresolvable sha is the 404 family.
 * - `pull_issue_index` (compare.go:757-792) is NOT honored: the PR code
 *   comments it attaches (FetchCodeComments → attachCommentsToLines →
 *   attachHiddenCommentIDs) ride the not-yet-landed comments store, so
 *   `$canCreateComment` (= SignedUserID && PullIssueIndex, the template's
 *   line 2) is false and the fragment renders the comment-less shape —
 *   exactly upstream's anonymous rendering. `fillHiddenCommentIds` stays
 *   unexercised here (the machinery export waits for the comments wave).
 * - SetDiffViewStyle/GetDiffViewStyle (middlewares.go:35-56): `?style=`
 *   resolves split|unified (anything else unified). The signed-in
 *   Doer.DiffViewStyle fallback (middlewares.go:42-47) is NOT honored — no
 *   landed surface renders or persists split (pull-files.tsx's documented
 *   `?style=` divergence), and the template's IsSplitStyle split ARM is not
 *   ported: the unified arm renders always, the resolved style only echoes
 *   into the emitted buttons' `?style=` (RenderBlobExcerptButtons's
 *   IfZero(diffStyle, "unified")). The persistence write
 *   (UpdateUser DiffViewStyle) stays out with it — a GET handler stays
 *   read-only.
 *
 * ## The fragment DOM (templates/repo/diff/blob_excerpt.tmpl, unified arm)
 *
 * Per section line one `<tr class="{GetHTMLDiffLineType}-code
 * line-expanded" data-line-type="…">` (gitdiff.go:152-163: plain → "same",
 * the expander's section → "tag"):
 * - the expander row: `<td colspan="2" class="lines-num">` carrying
 *   RenderBlobExcerptButtons — the
 *   `<div class="code-expander-buttons" data-expand-direction="…">` wrapper
 *   (direction "" renders an EMPTY wrapper — the template emits the div even
 *   when GetExpandDirection answers ""), then per direction: "down"/"updown"
 *   the fold-down button, "up"/"updown" the fold-up button, "single" the
 *   fold button (:255-262, in that emission order). Each button:
 *   `<button class="code-expander-button" data-fetch-sync="$closest(tr)"
 *   data-fetch-url="{BaseLink}/{AfterCommitID}?style={style}&direction={d}
 *   &anchor={anchor}&{getBlobExcerptQuery}" data-hidden-comment-ids=",…,">`
 *   with the anchor `diff-{FileNameHash}K{RightIdx}` (:236-246) —
 *   FileNameHash is the machinery's `hashFilePathForWebUI` (the async
 *   WebCrypto port). The `data-hidden-comment-ids` attribute renders the
 *   empty-IDs form of the `,%s,` format (`",,"` — Join of none) until
 *   comments land.
 *   The octicons render inline from the pinned submodule's bodies — the
 *   fold trio is outside the generated allowlist (scripts/gen-ui-icons.mjs),
 *   so the FOLD_SVG bodies below carry the exact `<path d>` bytes.
 * - plain rows: the two `lines-num` cells (`data-line-num` + the
 *   `diff-{hash}L/R{n}` rel anchors, empty when the index is 0), the empty
 *   `lines-escape` cell (RenderUnicodeEscapeToggleButton is not ported —
 *   the pull-files degradation), the `lines-type-marker` cell with
 *   GetLineTypeMarker (gitdiff.go:179-187 — the leading " " of the
 *   machinery's marker-prefixed content), and the `lines-code` cell's
 *   `<code class="code-inner">` carrying the content verbatim. No chroma
 *   spans: the machinery's `highlightSource` is consumed only through the
 *   cap flag — chroma is a client/render feature the landed diff surfaces
 *   render as plain text (pull-files.tsx's documented posture), so
 *   `highlightTruncated` is disclosed here in the module doc only.
 * - the add-code-comment buttons and the `{{if $line.Comments}}`
 *   conversation rows never render (the pull_issue_index arm above).
 *
 * The response (compare.go:794 ctx.HTML + the web middleware's zero-option
 * prod Cache-Control) mirrors the lastcommit fragment's Response shape.
 */

import { renderToString } from "hono/jsx/dom/server";

import {
  blobExcerptQuery,
  buildBlobExcerptSection,
  getExpandDirection,
  type BlobExcerptLine,
  type BlobExcerptOptions,
  type BlobExcerptSection,
} from "../../api/services/blob-excerpt";
import { engineReads } from "../../api/services/engine";

/** The loader's repo subset (the caller's resolved row — the aux convention). */
export type BlobExcerptRepo = {
  ownerNamespace: string;
  slug: string;
  isEmpty: boolean;
  defaultBranch: string;
};

/** The resolved view style (GetDiffViewStyle's Iif, middlewares.go:35-37). */
export type DiffStyle = "split" | "unified";

/** FormInt (base_form.go:50-53): strconv.Atoi of the first value — a
 *  missing or malformed value is 0 (the error is discarded). */
export function formInt(params: URLSearchParams, key: string): number {
  const raw = params.get(key);
  if (raw === null || !/^[+-]?\d+$/.test(raw)) return 0; // strconv.Atoi's error arm
  return Number.parseInt(raw, 10);
}

/** The round-tripped excerpt options (compare.go:708-716's FormInt/
 *  FormString names — `path` feeds buildBlobExcerptSection's filePath half)
 *  plus the resolved view style (middlewares.go:41-44). */
export function parseBlobExcerptForm(params: URLSearchParams): BlobExcerptOptions & { path: string; style: DiffStyle } {
  return {
    lastLeft: formInt(params, "last_left"),
    lastRight: formInt(params, "last_right"),
    leftIndex: formInt(params, "left"),
    rightIndex: formInt(params, "right"),
    leftHunkSize: formInt(params, "left_hunk_size"),
    rightHunkSize: formInt(params, "right_hunk_size"),
    direction: params.get("direction") ?? "",
    language: params.get("filelang") ?? "",
    path: params.get("path") ?? "",
    style: params.get("style") === "split" ? "split" : "unified",
  };
}

/**
 * Read the blob at the after-commit for `path` and build the excerpt section
 * (ExcerptBlob's compare.go:723-753 arm over the machinery). `wiki` swaps the
 * read client onto the sibling wiki cell (compare.go:721-728's
 * WikiStorageRepo arm — the landed cell convention). `null` = the 404 family:
 * the empty repo (repo twin only — the wiki twin has no MustBeNotEmpty), an
 * unresolvable sha, a missing/unreadable blob path.
 */
export async function loadBlobExcerptSection(
  env: Env,
  repo: BlobExcerptRepo,
  sha: string,
  wiki: boolean,
  opts: BlobExcerptOptions & { path: string },
): Promise<{ section: BlobExcerptSection; filePath: string } | null> {
  if (!wiki && repo.isEmpty) return null; // the nil-GitRepo arm (the aux-fragment convention)
  const reads = wiki
    ? engineReads(env, { ownerNamespace: repo.ownerNamespace, slug: `${repo.slug}.wiki` })
    : engineReads(env, repo);
  if (opts.path === "") return null; // GetBlobByPath("") — no path named
  const blob = await reads.readBlob(sha, opts.path);
  if (blob === null) return null; // GetCommit/GetBlobByPath's failure class
  // The machinery's input contract: the decoded blob text (lenient UTF-8 —
  // the module doc's divergence (1)).
  const text = new TextDecoder().decode(blob.data);
  return { section: buildBlobExcerptSection(opts.path, text, opts), filePath: opts.path };
}

/** The pinned submodule's fold-trio bodies (gitea/public/assets/img/svg/) —
 *  outside the generated allowlist (scripts/gen-ui-icons.mjs), so the
 *  fragment embeds the exact `<path d>` bytes inline (the upstream
 *  `{{svg "octicon-fold…"}}` DOM: viewBox 0 0 16 16, the `svg octicon-*`
 *  class, aria-hidden). */
const FOLD_SVG: Record<string, string> = {
  "octicon-fold-down":
    "m8.177 14.323 2.896-2.896a.25.25 0 0 0-.177-.427H8.75V7.764a.75.75 0 1 0-1.5 0V11H5.104a.25.25 0 0 0-.177.427l2.896 2.896a.25.25 0 0 0 .354 0M2.25 5a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5zM6 4.25a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5a.75.75 0 0 1 .75.75M8.25 5a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5zM12 4.25a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5a.75.75 0 0 1 .75.75m2.25.75a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5z",
  "octicon-fold-up":
    "M7.823 1.677 4.927 4.573A.25.25 0 0 0 5.104 5H7.25v3.236a.75.75 0 1 0 1.5 0V5h2.146a.25.25 0 0 0 .177-.427L8.177 1.677a.25.25 0 0 0-.354 0M13.75 11a.75.75 0 0 0 0 1.5h.5a.75.75 0 0 0 0-1.5zm-3.75.75a.75.75 0 0 1 .75-.75h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1-.75-.75M7.75 11a.75.75 0 0 0 0 1.5h.5a.75.75 0 0 0 0-1.5zM4 11.75a.75.75 0 0 1 .75-.75h.5a.75.75 0 0 1 0 1.5h-.5a.75.75 0 0 1-.75-.75M1.75 11a.75.75 0 0 0 0 1.5h.5a.75.75 0 0 0 0-1.5z",
  "octicon-fold":
    "M10.896 2H8.75V.75a.75.75 0 0 0-1.5 0V2H5.104a.25.25 0 0 0-.177.427l2.896 2.896a.25.25 0 0 0 .354 0l2.896-2.896A.25.25 0 0 0 10.896 2M8.75 15.25a.75.75 0 0 1-1.5 0V14H5.104a.25.25 0 0 1-.177-.427l2.896-2.896a.25.25 0 0 1 .354 0l2.896 2.896a.25.25 0 0 1-.177.427H8.75zm-6.5-6.5a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5zM6 8a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5A.75.75 0 0 1 6 8m2.25.75a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5zM12 8a.75.75 0 0 1-.75.75h-.5a.75.75 0 0 1 0-1.5h.5A.75.75 0 0 1 12 8m2.25.75a.75.75 0 0 0 0-1.5h-.5a.75.75 0 0 0 0 1.5z",
};

/** The `{{svg "octicon-fold…"}}` inline shape (shell.tsx's Icon DOM). */
function FoldIcon(props: { name: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" class={`svg ${props.name}`} aria-hidden="true">
      <path d={FOLD_SVG[props.name]} />
    </svg>
  );
}

/** One expander button (makeButton, gitdiff.go:240-250): the link rounds the
 *  style/direction/anchor query plus the machinery's blobExcerptQuery, the
 *  hidden-comment ids render upstream's empty "," form until comments land. */
function ExpanderButton(props: { url: string; icon: string; hiddenCommentIds: number[] }) {
  return (
    <button
      class="code-expander-button"
      data-fetch-sync="$closest(tr)"
      data-fetch-url={props.url}
      data-hidden-comment-ids={`,${props.hiddenCommentIds.map(String).join(",")},`}
    >
      <FoldIcon name={props.icon} />
    </button>
  );
}

/** RenderBlobExcerptButtons (gitdiff.go:232-265) for the section row.
 *  `language` is the section's filelang round-trip (the excerpt builder
 *  stamps opts.Language onto the sectionInfo's language, gitdiff_excerpt.go
 *  :104 — getBlobExcerptQuery's value). */
function RenderBlobExcerptButtons(props: {
  line: BlobExcerptLine;
  fileNameHash: string;
  baseLink: string;
  afterCommitID: string;
  style: DiffStyle;
  language: string;
}) {
  const info = props.line.sectionInfo;
  if (info === undefined) return null; // the template's SectionInfo-nil arm (unreachable from the builder)
  const direction = getExpandDirection(info);
  const anchor = `diff-${props.fileNameHash}K${info.rightIdx}`;
  const query = blobExcerptQuery(info, props.language);
  const buttonUrl = (dir: string): string =>
    `${props.baseLink}/${props.afterCommitID}` +
    `?style=${encodeURIComponent(props.style)}&direction=${dir}&anchor=${encodeURIComponent(anchor)}` +
    `&${query}`;
  // The hiddenCommentIds span rides non-empty IDs only (never in v1 — the
  // module doc's pull_issue_index arm).
  return (
    <div class="code-expander-buttons" data-expand-direction={direction}>
      {direction === "updown" || direction === "down" ? (
        <ExpanderButton url={buttonUrl("down")} icon="octicon-fold-down" hiddenCommentIds={info.hiddenCommentIds ?? []} />
      ) : null}
      {direction === "up" || direction === "updown" ? (
        <ExpanderButton url={buttonUrl("up")} icon="octicon-fold-up" hiddenCommentIds={info.hiddenCommentIds ?? []} />
      ) : null}
      {direction === "single" ? (
        <ExpanderButton url={buttonUrl("single")} icon="octicon-fold" hiddenCommentIds={info.hiddenCommentIds ?? []} />
      ) : null}
    </div>
  );
}

/** One unified-arm row (blob_excerpt.tmpl's `{{else}}` arm, comment-less). */
function ExcerptRow(props: {
  line: BlobExcerptLine;
  fileNameHash: string;
  baseLink: string;
  afterCommitID: string;
  style: DiffStyle;
  language: string;
}) {
  const { line } = props;
  if (line.type === "section") {
    // GetHTMLDiffLineType "tag" (gitdiff.go:158-159); RightIdx is 0 → the
    // lines-code-old cell; the content is the residual @@ hunk string.
    return (
      <tr class="tag-code line-expanded" data-line-type="tag">
        <td colspan={2} class="lines-num">
          <RenderBlobExcerptButtons
            line={line}
            fileNameHash={props.fileNameHash}
            baseLink={props.baseLink}
            afterCommitID={props.afterCommitID}
            style={props.style}
            language={props.language}
          />
        </td>
        <td class="lines-escape" />
        <td class="lines-type-marker">
          <span class="tw-font-mono" data-type-marker="" />
        </td>
        <td class="lines-code lines-code-old">
          <code class="code-inner">{line.content}</code>
        </td>
      </tr>
    );
  }
  // Plain (context) rows — GetHTMLDiffLineType "same" (the default arm);
  // GetLineTypeMarker is the content's leading byte when it sits in " +-".
  const leftIdx = line.leftIdx === 0 ? "" : String(line.leftIdx);
  const rightIdx = line.rightIdx === 0 ? "" : String(line.rightIdx);
  const marker = line.content !== "" && " +-".includes(line.content[0] as string) ? line.content[0] : "";
  return (
    <tr class="same-code line-expanded" data-line-type="same">
      <td class="lines-num lines-num-old" data-line-num={leftIdx}>
        <span rel={leftIdx === "" ? "" : `diff-${props.fileNameHash}L${leftIdx}`} />
      </td>
      <td class="lines-num lines-num-new" data-line-num={rightIdx}>
        <span rel={rightIdx === "" ? "" : `diff-${props.fileNameHash}R${rightIdx}`} />
      </td>
      <td class="lines-escape" />
      <td class="lines-type-marker">
        <span class="tw-font-mono" data-type-marker={marker} />
      </td>
      <td class="lines-code">
        <code class="code-inner">{line.content}</code>
      </td>
    </tr>
  );
}

/**
 * The tplBlobExcerpt fragment's bytes — the unified-arm `<tr>` sequence, no
 * wrapper (the bundle's `data-fetch-sync="$closest(tr)"` morphs one row).
 */
export function blobExcerptFragmentHtml(data: {
  section: BlobExcerptSection;
  fileNameHash: string;
  baseLink: string;
  afterCommitID: string;
  style: DiffStyle;
}): string {
  return renderToString(
    <>
      {data.section.lines.map((line) => (
        <ExcerptRow
          line={line}
          fileNameHash={data.fileNameHash}
          baseLink={data.baseLink}
          afterCommitID={data.afterCommitID}
          style={data.style}
          language={data.section.language}
        />
      ))}
    </>,
  );
}

/**
 * The fragment Response — ctx.HTML's `text/html; charset=utf-8`
 * (context_response.go:99) plus the web middleware's zero-option prod
 * Cache-Control (the lastcommit-fragment twin).
 */
export function blobExcerptFragmentResponse(html: string): Response {
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "max-age=0, private, must-revalidate",
    },
  });
}

/** The FileNameHash half of the fragment data (compare.go:792) — the
 *  machinery's async WebCrypto port, re-exported for the handler. */
export { hashFilePathForWebUI } from "../../api/services/blob-excerpt";
