/**
 * The JSX render entry of the UI router (SPEC-0008 §2.4 module layout keeps
 * `index.ts` the router/parser module, so the hono/jsx invocations live
 * here). U2.5: every claimed route renders the §4.5 404 shell. U3 replaces
 * the body of `renderUiPage` with the real page switch on the parsed route
 * (home / commits / file view) — the router and parsers stay untouched.
 */

import { renderPage } from "./shell";
import { NotFoundPage } from "./pages/not-found";
import type { UiContext } from "./ui-context";

/** The 404-in-shell response body: full BaseLayout, repo header included
 *  exactly when `ctx.repo` resolved (upstream `{{if .IsRepo}}`). */
export function renderNotFound(ctx: UiContext): string {
  return renderPage(<NotFoundPage ctx={ctx} />);
}
