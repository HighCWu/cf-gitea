/**
 * The issue-template CHOOSER, `/{owner}/{repo}/issues/new/choose` —
 * upstream's `NewIssueChooseTemplate` (routers/web/repo/issue_new.go:180-204
 * over the choose.tmpl card list; the route web.go:1357, inside the
 * `reqUnitIssuesReader` group so the gate is an issues-unit READER check —
 * GET-only, no write, no CSRF surface). SPEC-0005 §11 carries the derivation.
 *
 * ## Arms (upstream-exact)
 *
 *   1. DISCOVERY: `parseTemplatesFromDefaultBranch` (the services/issue/
 *      template.go:113-155 port — pages/issue-templates.ts) walks the 8 dir
 *      candidates over the DEFAULT branch through the engine reads; parse
 *      failures accumulate into the errors map and the walk continues.
 *   2. THE NO-TEMPLATES ARM: `!hasTemplatesOrContactLinks` (template.go:
 *      182-190 — any valid template OR any IssueConfig contact link from the
 *      `.gitea|.github/.../ISSUE_TEMPLATE/config.yaml|yml` candidates) → the
 *      **303 See Other** onto `{repoLink}/issues/new?{rawQuery}` — the raw
 *      query string rides VERBATIM (no re-encoding, no filtering) and the
 *      `?` is written even when the query is EMPTY (the Sprintf's literal;
 *      issue_new.go:191-195). This arm was the module's whole historic body
 *      (the pre-pipeline census slice, mounted at fa4fd0d); it stays
 *      byte-identical and its seam function stays pure for the unit tests.
 *   3. THE RENDER ARM: choose.tmpl — one `.ui.attached.segment >
 *      .ui.two.column.grid` card per template (`{name}` + `{about}`, button
 *      href `{repoLink}/issues/new?template={fileName}&{prefill}`), one card
 *      per config contact link (external URL, "Open"), the blank card when
 *      `blank_issues_enabled` (default true, `{repoLink}/issues/new?{prefill}`),
 *      the config-error warning (`The issue config contains errors:` + the
 *      error text), and the invalid-template notice (`{n} invalid template(s)
 *      found` / `Invalid templates have been ignored` + the sorted
 *      `file: error` lines — upstream's session flash rendered as our
 *      in-page warning block, the SPEC §11.3 reduction). `prefill` is
 *      `issuePrefillQuery` (issue_page_meta.go:144-153) filtering the
 *      incoming query to label/labels/milestone/project/assignee.
 *
 * ## Auth + visibility posture (the mounted handler's contract)
 *
 * Upstream's `reqUnitIssuesReader` is a unit READER check, so an anonymous
 * viewer of a VISIBLE repo reaches the handler; neither arm gates. Our
 * handler runs the standard ladder ONLY (resolveUiRequest: unknown/invisible
 * repo → the 404 shell BEFORE anything could leak existence, §2.5) — never a
 * login gate, never a write gate, never the archived refusal (upstream has
 * none on this GET). The 303 chains onto `/{owner}/{repo}/issues/new` — the
 * landed wave-4 family — whose own posture takes over from there (an
 * anonymous viewer's second hop is that page's login 303; upstream instead
 * renders the form for anonymous readers — the landed divergence documented
 * in pages/new-issue.tsx).
 */

import { branchRef, engineReads, refTipMap } from "../../api/services/engine";
import {
  DEFAULT_ISSUE_CONFIG,
  issueConfigFromDefaultBranch,
  issuePrefillQuery,
  parseTemplatesFromDefaultBranch,
  type IssueConfigResult,
  type ParsedIssueConfig,
  type TemplateParseResult,
} from "./issue-templates";
import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";

/** The repo-link projection the seam needs (the repo row's namespace pair —
 *  the same fields every `resolveUiRequest` repo carries). */
export interface IssueNewChooseRepoLink {
  ownerNamespace: string;
  slug: string;
}

/**
 * The no-templates arm (issue_new.go:191-195): a **303 See Other** onto
 * `/{owner}/{repo}/issues/new?{rawQuery}` — the raw query string rides
 * VERBATIM (no re-encode, no filter), and the `?` separator is emitted even
 * when the query is empty, upstream's Sprintf byte shape (browsers and the
 * Fetch normalizer treat the empty query as absent; the landed
 * `/issues/new` handler reads `url.searchParams` and is indifferent).
 *
 * Viewer-blind by contract: the function takes no viewer and consults no
 * flag — the redirect is deterministic on (repo, url). There is no archived
 * gate (upstream has none on this GET — the refusal lives on the POST, which
 * this page never issues) and no login gate (the `reqUnitIssuesReader`
 * posture — the module header).
 */
export function issueNewChooseRedirect(repo: IssueNewChooseRepoLink, url: URL): Response {
  const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : "";
  return new Response(null, {
    status: 303, // http.StatusSeeOther — upstream's explicit code
    headers: { location: `/${repo.ownerNamespace}/${repo.slug}/issues/new?${rawQuery}` },
  });
}

// ---------------------------------------------------------------------------
// Page chrome text (the locale convention — en-US literals at the pin,
// locale_en-US.json repo.issues.choose.*)
// ---------------------------------------------------------------------------

export const issueNewChooseLocale = {
  title: "New Issue", // "repo.issues.new"
  get_started: "Get Started", // "repo.issues.choose.get_started"
  open_external_link: "Open", // "repo.issues.choose.open_external_link"
  blank: "Default", // "repo.issues.choose.blank"
  blank_about: "Create an issue from default template.", // "repo.issues.choose.blank_about"
  ignore_invalid_templates: "Invalid templates have been ignored", // "repo.issues.choose.ignore_invalid_templates"
  invalid_templates: "%v invalid template(s) found", // "repo.issues.choose.invalid_templates"
  invalid_config: "The issue config contains errors:", // "repo.issues.choose.invalid_config"
} as const;

// ---------------------------------------------------------------------------
// Data loading (the discovery + config walks over the engine reads)
// ---------------------------------------------------------------------------

/** Everything the choose page renders (issue_new.go:184-201's ctx.Data set). */
export interface IssueNewChooseData {
  templates: TemplateParseResult["templates"];
  /** fullName -> parse error (the flash lines' source, sorted at render). */
  templateErrors: Map<string, string>;
  config: ParsedIssueConfig;
  /** GetTemplateConfigFromDefaultBranch's error arm (`IssueConfigError`). */
  configError: string | null;
  /** The five-key filtered incoming query (the cards' tail). */
  prefillQuery: string;
}

/**
 * The choose page's data: the default-branch tip resolved from the refs
 * list, then `ParseTemplatesFromDefaultBranch` + `GetTemplateConfigFromDefaultBranch`
 * + `issuePrefillQuery`. The caller decides the redirect (issue_new.go:191)
 * off `hasAnyTemplateOrContactLink(data)` and renders otherwise. An EMPTY
 * repo is the upstream IsEmpty early-return pair (template.go:119-121 for
 * the templates, :160-162 for the config — the DEFAULT config with NO
 * error); a missing default branch tip is the walk's null arm (the empty
 * result, default config WITH the branch error).
 */
export async function loadIssueNewChooseData(
  env: Env,
  repo: IssueNewChooseRepoLink & { defaultBranch: string; isEmpty: boolean },
  url: URL,
): Promise<IssueNewChooseData> {
  const prefillQuery = issuePrefillQuery(url);
  if (repo.isEmpty) {
    return { templates: [], templateErrors: new Map(), config: { ...DEFAULT_ISSUE_CONFIG, contactLinks: [] }, configError: null, prefillQuery };
  }
  const reads = engineReads(env, repo);
  const tips = refTipMap(await reads.listRefs());
  const tip = tips.get(branchRef(repo.defaultBranch))?.target ?? null;
  const parsed: TemplateParseResult = await parseTemplatesFromDefaultBranch(reads, tip);
  const config: IssueConfigResult = await issueConfigFromDefaultBranch(reads, tip, repo.defaultBranch);
  return {
    templates: parsed.templates,
    templateErrors: parsed.errors,
    config: config.config,
    configError: config.error,
    prefillQuery,
  };
}

/** `HasTemplatesOrContactLinks` (template.go:182-190) off the loaded data —
 *  the redirect predicate without a second walk. */
export function hasAnyTemplateOrContactLink(data: IssueNewChooseData): boolean {
  return data.templates.length > 0 || data.config.contactLinks.length > 0;
}

/**
 * `renderErrorOfTemplates` (issue_new.go:155-177): the files sorted (the
 * stable output), one `{file}: {error}` line each — upstream wraps them in
 * the alert_details <details> block as a session flash; our stateless SSR
 * renders the same strings as the in-page warning block (SPEC §11.3).
 */
export function formatTemplateErrors(errors: Map<string, string>): { summary: string; details: string[] } {
  const files = [...errors.keys()].sort();
  return {
    summary: issueNewChooseLocale.invalid_templates.replace("%v", String(files.length)),
    details: files.map((file) => `${file}: ${errors.get(file)}`),
  };
}

// ---------------------------------------------------------------------------
// Render (choose.tmpl)
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the component). */
export function renderIssueNewChoosePage(options: { ctx: UiContext; data: IssueNewChooseData }): string {
  return renderPage(<IssueNewChoosePage ctx={options.ctx} data={options.data} />);
}

/** The choose page (choose.tmpl — `.page-content.repository.new issue`). */
export function IssueNewChoosePage(props: { ctx: UiContext; data: IssueNewChooseData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("IssueNewChoosePage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const templateErrors = data.templateErrors.size > 0 ? formatTemplateErrors(data.templateErrors) : null;
  const templateQuery = (fileName: string) =>
    data.prefillQuery === "" ? `template=${fileName}` : `template=${fileName}&${data.prefillQuery}`;
  const blankQuery = data.prefillQuery === "" ? "" : `?${data.prefillQuery}`;
  return (
    <BaseLayout ctx={ctx} title={issueNewChooseLocale.title} pageClass="repository new issue" activeTab="issues">
      <div class="ui container">
        {templateErrors !== null ? (
          <div class="ui warning message flash-message flash-warning">
            <div class="text left">
              <div>{issueNewChooseLocale.ignore_invalid_templates}</div>
              <details>
                <summary>{templateErrors.summary}</summary>
                <pre>{templateErrors.details.join("\n")}</pre>
              </details>
            </div>
          </div>
        ) : null}
        <div class="divider" />
        {data.templates.map((template) => (
          <div class="ui attached segment">
            <div class="ui two column grid">
              <div class="column">
                <strong>{template.name}</strong>
                <br />
                {template.about}
              </div>
              <div class="column tw-text-right">
                <a href={`${repoLink}/issues/new?${templateQuery(template.fileName)}`} class="ui primary button">
                  {issueNewChooseLocale.get_started}
                </a>
              </div>
            </div>
          </div>
        ))}
        {data.config.contactLinks.map((link) => (
          <div class="ui attached segment">
            <div class="ui two column grid">
              <div class="column">
                <strong>{link.name}</strong>
                <br />
                {link.about}
              </div>
              <div class="column tw-text-right">
                <a href={link.url} class="ui primary button">
                  {issueNewChooseLocale.open_external_link}
                </a>
              </div>
            </div>
          </div>
        ))}
        {data.config.blankIssuesEnabled ? (
          <div class="ui attached segment">
            <div class="ui two column grid">
              <div class="column">
                <strong>{issueNewChooseLocale.blank}</strong>
                <br />
                {issueNewChooseLocale.blank_about}
              </div>
              <div class="column tw-text-right">
                <a href={`${repoLink}/issues/new${blankQuery}`} class="ui primary button">
                  {issueNewChooseLocale.get_started}
                </a>
              </div>
            </div>
          </div>
        ) : null}
        {data.configError !== null ? (
          <div class="ui warning message">
            <div class="text left">
              <div>{issueNewChooseLocale.invalid_config}</div>
              <div>{data.configError}</div>
            </div>
          </div>
        ) : null}
      </div>
    </BaseLayout>
  );
}
