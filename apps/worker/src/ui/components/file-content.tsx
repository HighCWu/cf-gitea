/**
 * The blob content view (templates/repo/view_file.tmpl:1-132 at the pin):
 * the `non-diff-file-content` root carrying the §2.4.1 enhancement registry
 * (`data-global-init="initRepoFileView"` + `data-raw-file-link`), the latest
 * commit box, the file header (info + Raw/History/copy actions), and the
 * `.file-view-container` with the §3.3 render variants — `markup` (§3.4
 * pipeline output), `plain-text`, `code-view` (line table; syntax
 * highlighting is client-side by Gitea's own bundles), `.view-raw`
 * (media/prompt), the too-large prompt (§4.3) and the empty prompt.
 */


import { commitsHistoryLink, rawFileLink } from "../links";
import { formatByteSize, splitLines } from "../page-data";
import { Icon } from "../shell";
import { LatestCommitBox, TimeSince } from "./file-list";
import type { CommitJson } from "@cf-gitea/git-engine";

/** Page-level strings (upstream locale keys, locale_en-US.json at the pin). */
export const fileViewLocale = {
  /** "repo.file_raw" */
  raw: "Raw",
  /** "repo.file_history" */
  history: "History",
  /** "repo.blame" */
  blame: "Blame",
  /** "copy_content" — the copy button's accessible text (the octicon-copy
   *  glyph is outside the generated icon allowlist). */
  copy: "Copy",
  /** "repo.file_too_large" */
  too_large: "The file is too large to be shown.",
  /** "repo.file_view_raw" */
  view_raw: "View Raw",
  /** "repo.file_is_empty" */
  is_empty: "The file is empty.",
  /** "repo.line" / "repo.lines" */
  line: "line",
  lines: "lines",
  /** "repo.commits.commits" — the README section link text stays the file
   *  name; the book octicon is outside the allowlist (file glyph instead). */
} as const;

export type BlobVariant = "markup" | "plain-text" | "code-view" | "view-raw" | "too-large" | "empty";

/** The `.view-raw` media family (§4.2) — image/video/audio by extension. */
export type MediaKind = "image" | "video" | "audio";

function RawLink(props: { href: string }) {
  return (
    <a href={props.href} rel="nofollow">
      {fileViewLocale.view_raw}
    </a>
  );
}

/** The `.file-view` variant body (view_file.tmpl:94-132 branches). */
function VariantBody(props: {
  variant: BlobVariant;
  /** markup: the §3.4 pipeline HTML (the pipeline's raw-HTML sink, §4.12). */
  markupHtml?: string;
  /** plain-text/code-view: the decoded UTF-8 text. */
  text?: string;
  mediaKind?: MediaKind;
  rawLink: string;
}) {
  switch (props.variant) {
    case "markup":
      return <div class="file-view markup markdown" dangerouslySetInnerHTML={{ __html: props.markupHtml ?? "" }} />;
    case "plain-text":
      return (
        <div class="file-view plain-text">
          <pre>{props.text}</pre>
        </div>
      );
    case "code-view":
      // Plain <pre>-shaped line rows; highlighting/line-highlight behaviors
      // come from the official bundle's chroma/init code (no server lexer).
      return (
        <div class="file-view code-view">
          <table>
            <tbody>
              {splitLines(props.text ?? "").map((line, idx) => {
                const lineNo = idx + 1;
                return (
                  <tr>
                    <td class="lines-num">
                      <span id={`L${lineNo}`} data-line-number={lineNo}></span>
                    </td>
                    <td rel={`L${lineNo}`} class="lines-code chroma">
                      <code class="code-inner">{line}</code>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      );
    case "view-raw":
      return (
        <div class="file-view">
          <div class="view-raw">
            {props.mediaKind === "image" ? (
              <img alt={props.rawLink} src={props.rawLink} />
            ) : props.mediaKind === "video" ? (
              <video controls src={props.rawLink}>
                <strong>Video is not supported in your browser.</strong>
              </video>
            ) : props.mediaKind === "audio" ? (
              <audio controls src={props.rawLink}>
                <strong>Audio is not supported in your browser.</strong>
              </audio>
            ) : (
              <div class="file-view-render-container">
                <div class="file-view-raw-prompt tw-p-4">
                  <RawLink href={props.rawLink} />
                </div>
              </div>
            )}
          </div>
        </div>
      );
    case "too-large":
      return (
        <div class="file-view">
          <div class="file-not-rendered-prompt">
            {fileViewLocale.too_large} <RawLink href={props.rawLink} />
          </div>
        </div>
      );
    case "empty":
      return (
        <div class="file-view">
          <div class="file-not-rendered-prompt">{fileViewLocale.is_empty}</div>
        </div>
      );
  }
}

/**
 * view_file.tmpl — one blob. `readmeInList` switches the home page's README
 * rendering (`id="readme"`, the file-name header link, no commit box — the
 * file list's last-commit line already carries it).
 */
export function FileContentView(props: {
  repoLink: string;
  /** Repo-relative path of the blob. */
  treePath: string;
  ref: string;
  variant: BlobVariant;
  markupHtml?: string;
  text?: string;
  mediaKind?: MediaKind;
  size?: number | null;
  /** Decoded line count (text variants only). */
  numLines?: number | null;
  isSymlink?: boolean;
  /** The typed-ref arm for the raw link's web shape (view_file.go:169's
   *  RefTypeNameSubURL) — the file view passes the resolved prefix; the
   *  README arm omits it and falls to the deprecated `/raw/{ref}/{path}`
   *  catch-all (upstream's RawFileLink is "" there). */
  refType?: "branch" | "tag" | "commit";
  latestCommit: CommitJson | null;
  readmeInList?: boolean;
  /** Wave 8 (the web file editor): the write actions of view_file.tmpl:72-84
   *  (CanContentChange block) — pencil → the edit form, trash → the delete
   *  confirmation. Undefined = not rendered (non-branch refs, archived repos,
   *  viewers without write access — the anonymous goldens stay byte-stable). */
  editHref?: string;
  deleteHref?: string;
  /** The census R08 Blame button (view_file.tmpl:54 — the Raw, [Permalink],
   *  Blame, History order): the caller passes it only for text-representable
   *  files the engine can actually blame (size ≤ MAX_BLAME_BYTES, line
   *  count ≤ MAX_BLAME_LINES — no dead links; the engine 404-shells the
   *  rest). Undefined = not rendered. */
  blameHref?: string;
}) {
  const rawLink = rawFileLink(props.repoLink, props.treePath, props.ref, props.refType);
  return (
    <div
      {...(props.readmeInList ? { id: "readme" } : {})}
      class="non-diff-file-content"
      data-global-init="initRepoFileView"
      data-raw-file-link={rawLink}
    >
      {props.readmeInList ? null : (
        <div id="repo-file-commit-box" class="ui segment list-header tw-mb-4 flex-left-right">
          <LatestCommitBox repoLink={props.repoLink} commit={props.latestCommit} />
          {props.latestCommit !== null ? (
            <div class="tw-text-text-light age flex-text-block">
              <TimeSince unixSeconds={props.latestCommit.committer.time} tz={props.latestCommit.committer.tz} />
            </div>
          ) : null}
        </div>
      )}

      <h4 class="file-header ui top attached header flex-left-right">
        <div class="file-header-left tw-flex tw-items-center tw-py-2 tw-pr-4">
          {props.readmeInList ? (
            <>
              <Icon name="octicon-file" size={16} class="tw-mr-2" />
              <strong>
                <a class="muted" href="#readme">
                  {props.treePath}
                </a>
              </strong>
            </>
          ) : (
            <>
              <Icon name="octicon-file" size={16} class="tw-mr-2" />
              <strong>{props.treePath.split("/").pop()}</strong>
              <div class="file-info tw-font-mono">
                {props.isSymlink ? <div class="file-info-entry">{/* "repo.symbolic_link" */}Symbolic link</div> : null}
                {props.numLines != null ? (
                  <div class="file-info-entry">
                    {props.numLines} {props.numLines === 1 ? fileViewLocale.line : fileViewLocale.lines}
                  </div>
                ) : null}
                {props.size != null ? (
                  <div class="file-info-entry">
                    <span class="file-info-size">{formatByteSize(props.size)}</span>
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
        <div class="file-header-right file-actions flex-text-block tw-flex-wrap">
          <div class="ui buttons tw-mr-1">
            <a class="ui mini basic button" href={rawLink}>
              {fileViewLocale.raw}
            </a>
            {/* view_file.tmpl:54's Blame button (the Raw, [Permalink], Blame,
                History order) — the census R08 anchor; the caller gates it on
                the engine's blame budget (no dead links). */}
            {!props.readmeInList && props.blameHref !== undefined ? (
              <a class="ui mini basic button" href={props.blameHref}>
                {fileViewLocale.blame}
              </a>
            ) : null}
            <a class="ui mini basic button" href={commitsHistoryLink(props.repoLink, props.treePath)}>
              {fileViewLocale.history}
            </a>
          </div>
          {/* Upstream's copy control (view_file.tmpl:63) carries only the
              data-global-click registry — the handler reads the root's
              data-raw-file-link; the octicon-copy glyph is outside the
              generated icon allowlist, so the accessible text stands in. */}
          <a class="btn-octicon" data-global-click="onCopyContentButtonClick" data-tooltip-content={fileViewLocale.copy}>
            {fileViewLocale.copy}
          </a>
          {/* view_file.tmpl:72-84 at the editor's literal route names (the
              pencil/trash btn-octicons; the octicons are allowlisted for wave
              8). README renders (readmeInList) keep the actions hidden — the
              home README has no write context. */}
          {!props.readmeInList && props.editHref !== undefined ? (
            <a class="btn-octicon" href={props.editHref} aria-label="Edit" title="Edit">
              <Icon name="octicon-pencil" />
            </a>
          ) : null}
          {!props.readmeInList && props.deleteHref !== undefined ? (
            <a class="btn-octicon" href={props.deleteHref} aria-label="Delete" title="Delete">
              <Icon name="octicon-trash" />
            </a>
          ) : null}
        </div>
      </h4>

      <div class="ui bottom attached segment file-view-container">
        <VariantBody
          variant={props.variant}
          markupHtml={props.markupHtml}
          text={props.text}
          mediaKind={props.mediaKind}
          rawLink={rawLink}
        />
      </div>
    </div>
  );
}
