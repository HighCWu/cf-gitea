/**
 * The issue-template CHOOSER, `/{owner}/{repo}/issues/new/choose` — the
 * census slice that answers the template-picker page upstream serves when a
 * repo carries issue templates. Our side has NO issue-template data, so this
 * module is the NO-TEMPLATES arm, ported honestly and exclusively: the page
 * exists as a route and ALWAYS answers the no-template posture (a 303 onto
 * the landed `/issues/new` with the query preserved).
 *
 * ## Upstream shape (verified at the pin)
 *
 * `GET /{username}/{reponame}/issues/new/choose` (web.go:1357, inside the
 * `reqUnitIssuesReader` group — web.go:932/1360 — so the gate is an
 * issues-unit READER check, NOT a sign-in gate; GET-only, no write, no CSRF
 * surface). The handler `NewIssueChooseTemplate`
 * (routers/web/repo/issue_new.go:180-204):
 *
 *   1. `ParseTemplatesFromDefaultBranch` (services/issue/template.go:113-157)
 *      walks `templateDirCandidates` — `ISSUE_TEMPLATE`, `issue_template`,
 *      `.gitea/ISSUE_TEMPLATE`, `.gitea/issue_template`,
 *      `.github/ISSUE_TEMPLATE`, `.github/issue_template`,
 *      `.gitlab/ISSUE_TEMPLATE`, `.gitlab/issue_template`
 *      (template.go:24-33) — subtrees of the DEFAULT BRANCH and unmarshals
 *      each candidate file;
 *   2. `if !HasTemplatesOrContactLinks(...)` (template.go:182-192 — any
 *      valid template OR any `IssueConfig.ContactLinks` from the
 *      `.gitea|.github/.../ISSUE_TEMPLATE/config.yaml|yml` candidates,
 *      template.go:35-41) → `ctx.Redirect(fmt.Sprintf("%s/issues/new?%s",
 *      ctx.Repo.Repository.Link(), ctx.Req.URL.RawQuery),
 *      http.StatusSeeOther)` (issue_new.go:191-195): a **303 See Other**
 *      onto `{repoLink}/issues/new?{RawQuery}` — the raw query string rides
 *      VERBATIM (no re-encoding, no filtering) and the `?` is written even
 *      when the query is EMPTY (the Sprintf's literal);
 *   3. otherwise render `repo/issue/choose` (templates/repo/issue/choose.tmpl):
 *      one `.ui.attached.segment > .ui.two.column.grid` card per template
 *      (button href `{RepoLink}/issues/new?template={FileName}&{PrefillQuery}`)
 *      and per contact link (external URL), plus the BlankIssuesEnabled
 *      blank card (`{RepoLink}/issues/new?{PrefillQuery}`). `PrefillQuery`
 *      (issue_page_meta.go:144-153) filters the incoming query down to
 *      `label`/`labels`/`milestone`/`project`/`assignee`. `Repo.Link()` is
 *      `AppSubURL + "/" + PathEscape(OwnerName) + "/" + PathEscape(Name)`
 *      (models/repo/repo.go:559-561) — AppSubURL empty at this pin, exactly
 *      our `/{ownerNamespace}/{slug}` repoLink convention.
 *
 * ## Our data gate (why ONLY the no-templates arm exists here)
 *
 * The template pipeline has not landed: there is no issue-template table in
 * src/db/schema.ts, no tree-walk service over the default branch, and no
 * `ISSUE_TEMPLATE/config` parse (the new-issue module carries the same
 * documented degradation — "Issue templates … are not offered — no
 * template-file pipeline exists", pages/new-issue.tsx). With no discovery
 * and no config, `HasTemplatesOrContactLinks` is FALSE at every repo, so
 * arm 3 never runs and arm 2 is the WHOLE page. The dead-card rule forbids
 * inventing the cards: the choose.tmpl DOM is NOT ported — a template or
 * contact-link card for data that cannot exist would be fabricated UI, and
 * a blank-issues card (whose gate reads `IssueConfig.BlankIssuesEnabled`,
 * default-true upstream) would contradict the honest no-config posture.
 * When the template pipeline lands, THIS module grows the render arm (the
 * choose.tmpl card list + the PrefillQuery filter), and upstream's
 * reciprocal arm — NewIssue redirecting HERE when blank issues are disabled
 * (issue_new.go:146-150) — becomes a live concern for the new-issue family.
 * Until then the repo-projects module's note (repo-projects.tsx:92) that
 * the `?project={id}` chooser anchor is unlanded stays accurate.
 *
 * ## Auth + visibility posture (the HANDOFF handler's contract)
 *
 * Upstream's `reqUnitIssuesReader` is a unit READER check, so an anonymous
 * viewer of a VISIBLE repo reaches the handler and gets the 303 — the
 * redirect does not gate. Our handler therefore runs the standard ladder
 * ONLY (resolveUiRequest: unknown/invisible repo → the 404 shell BEFORE the
 * redirect could leak existence, §2.5) and never a login gate, never a
 * write gate, never the archived refusal (upstream has none on this GET).
 * The 303 chains onto `/{owner}/{repo}/issues/new` — the LANDED wave-4
 * family — whose own posture takes over from there (an anonymous viewer's
 * second hop is that page's login 303; upstream instead renders the form
 * for anonymous readers — the landed divergence documented in
 * pages/new-issue.tsx, not this module's to change).
 *
 * ## HANDOFF NOTE (for the wiring window — ui/index.ts is not this
 *    module's file; the recipe is exact)
 *
 * The route tail is UNCLAIMED today: `parseUiRoute` has no arm under
 * `head === "issues"` for `rest = ["new", "choose"]`, and src/index.ts
 * consults `handlesUiRoute` BEFORE Hono, so the live dispatcher hands the
 * URL to the engine's 404. Mounting needs three index.ts edits plus the
 * pin flip:
 *
 *   1. `UiFamily` union (beside `"issue-new"`, ui/index.ts:1488): add
 *      `"issue-new-choose"`.
 *   2. `parseUiRoute`, inside the `if (head === "issues" || head ===
 *      "pulls")` block (ui/index.ts:3136), beside the wave-4 literal:
 *      `if (head === "issues" && rest.length === 2 && rest[0] === "new" &&
 *      rest[1] === "choose") return { family: "issue-new-choose", owner,
 *      repo };` — the length guard keeps the bare `/issues/new` literal
 *      and the integer detail tails unaffected.
 *   3. The handler beside `issueNewPage` (ui/index.ts:4091) — the ladder
 *      then the seam, nothing else:
 *      ```ts
 *      async function issueNewChoosePage(c: Context<{ Bindings: Env }>): Promise<Response> {
 *        const resolved = await resolveUiRequest(c);
 *        if (!resolved.ok) return resolved.response;
 *        const { repo, url, respond } = resolved;
 *        return respond(issueNewChooseRedirect(repo, url));
 *      }
 *      ```
 *   4. Registration beside the issue-new lines (ui/index.ts:10197):
 *      `uiRouter.get("/:owner/:repo/issues/new/choose", (c) =>
 *      issueNewChoosePage(c));`
 *   5. Flip this module's test pins (issue-new-choose.test.ts, the "claim
 *      state" describe): `parseUiRoute` → the family object above,
 *      `handlesUiRoute` → true; then mount the route-level matrix (the
 *      visibility ladder over the REAL dispatcher: anonymous public repo →
 *      303 with the query round-trip; anonymous or stranger at a private
 *      repo → the 404 shell; the sibling literals stay un-overclaimed).
 *      Also revisit repo-projects.tsx:92's unlanded-chooser note.
 *
 * The seam is the entire module: one pure function, no D1, no render, no
 * hono import — the redirect decision upstream makes after an empty
 * template discovery, computable without touching storage.
 */

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
 * flag — upstream's handler runs its template discovery fresh per request
 * and our discovery is structurally empty, so the redirect is deterministic
 * on (repo, url). There is no archived gate (upstream has none on this GET
 * — the refusal lives on the POST, which this page never issues) and no
 * login gate (the `reqUnitIssuesReader` posture — the module header).
 */
export function issueNewChooseRedirect(repo: IssueNewChooseRepoLink, url: URL): Response {
  const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : "";
  return new Response(null, {
    status: 303, // http.StatusSeeOther — upstream's explicit code
    headers: { location: `/${repo.ownerNamespace}/${repo.slug}/issues/new?${rawQuery}` },
  });
}
