/**
 * The 404 shell page (SPEC-0008 §4.5): unknown owner/repo, private/invisible
 * repo, bad ref, missing path, unclaimed repo-scoped path, and the
 * commit-detail dead links all land here — always the full shell, status 404
 * (the router owns the status code). Shape mirrors
 * gitea/templates/status/404.tmpl at the pin.
 */

import { BaseLayout } from "../shell";
import { locale, type EmphasizedText } from "../locale";
import type { UiContext } from "../ui-context";

/** Render emphasized locale segments without a raw-HTML sink (locale.ts). */
function Emphasized(props: { segments: EmphasizedText }) {
  return (
    <>
      {props.segments.map((segment, i) =>
        typeof segment === "string" ? segment : <strong key={i}>{segment.strong}</strong>,
      )}
    </>
  );
}

export function NotFoundPage(props: { ctx: UiContext }) {
  const { ctx } = props;
  return (
    <BaseLayout
      ctx={ctx}
      title={locale.page_not_found_title}
      // Upstream 404: class="page-content {{if .IsRepo}}repository{{end}}",
      // repo header rendered only when the repo itself resolved.
      pageClass={ctx.repo ? "repository" : undefined}
    >
      <div class="ui container">
        <div class="status-page-error">
          <div class="status-page-error-title">{locale.error404_box_title}</div>
          <div class="tw-text-center">
            <div class="tw-my-4">
              <Emphasized segments={locale.error404} />
            </div>
            {/* Upstream's Go Back link needs NotFoundGoBackURL; slice-1 404s
                have no meaningful back target, so it is not rendered. */}
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
