/**
 * The repo settings PUBLIC ACCESS tab, `/{owner}/{repo}/settings/public_access`
 * — pages wave 77 (M-tier remainder row, PORT-FIRST; bench row
 * `wave-public-access`, TWO-STAGE UNMOUNTED — the route rides the index.ts
 * window; `index.ts` is orchestrator/sibling-owned).
 *
 * ## Premises verified at the pin (gitea @ fc4936884584-class pin)
 *
 * - Template: `templates/repo/settings/public_access.tmpl` — layout_head's
 *   pageClass is the literal `repository settings` (the deploy-keys literal),
 *   then `.repo-setting-content` → the `h4.ui.top.attached.header`
 *   "Public Access" over one `.ui.attached.segment`: the desc paragraph, the
 *   form carrying the unit × access-mode radio table + the mode docs list +
 *   the "Update Settings" submit (disabled under GlobalForcePrivate).
 * - Handlers: `routers/web/repo/setting/public_access.go` — `PublicAccess`
 *   (the GET, :127-135), `PublicAccessPost` (the write, :137-155, redirecting
 *   onto `<repo link>/settings/public_access`), `repoUnitPublicAccesses`
 *   (:62-125 — the 8 static unit rows, form keys `repo-unit-access-<n>` over
 *   unit.TypeCode=1…TypeActions=10, each filtered to units the repo has
 *   ENABLED — the DeleteFunc at :122-124 — and the checked value's
 *   precedence EveryoneWrite > EveryoneRead > AnonymousRead > not-set),
 *   `parsePublicAccessMode` (:21-45 — a value outside the unit's allowed
 *   list, or a ForcePrivate instance, collapses to AccessModeNone).
 * - Routes: `routers/web/web.go:1191` — `m.Combo("/public_access")` GET+POST
 *   inside the settings subtree wrapped
 *   `reqSignIn, context.RepoAssignment, reqRepoAdmin` (web.go:1285-1287).
 *   Our mirror is the shared settingsGate posture (index.ts `settingsGate` —
 *   anonymous 303s onto the login round-trip, a signed-in non-admin
 *   404-shells; the same `isRepositoryAdmin` class the settings family
 *   enforces).
 * - Navbar: `templates/repo/settings/navbar.tmpl:7-11` — the Public Access
 *   item is CONDITIONAL: `{{if or .Repository.IsPrivate
 *   .Permission.HasAnyUnitPublicAccess}}` (private repo, or any unit already
 *   carries an anonymous/everyone grant — models/perm/access/
 *   repo_permission.go:63-72). Between Repository and Collaboration.
 *
 * ## THE SURVEY CORRECTION
 *
 * The survey's data for this row was partial and guessed "the
 * collaborator/team access graph with visibility rings". WRONG at the pin:
 * this page renders the PER-UNIT public-access table — repo_units × the four
 * access modes (not-set / anonymous-read / everyone-read / everyone-write;
 * the write arm wiki-only). Collaborators and teams are the
 * `/settings/collaboration` page's data (pages/
 * settings-collaboration.tsx, wave 24) and render NOTHING here.
 *
 * ## Data (§3.2 — the landed store, never a self-fetch)
 *
 *   read  `codeUnitAnonymousRead(d1, repoId)` (git-http/acl.ts) — the
 *         SPEC-0003 §3.1 `repo_units.anonymous_access_mode` read the git-HTTP
 *         ACL rows 4/5 consume (upstream `RepoUnit.AnonymousAccessMode`,
 *         git_smart_http_test.go:163-189). An ABSENT row reads false =
 *         not-set, so the Code row ALWAYS renders (upstream renders enabled
 *         units; the code unit cannot be disabled here — schema
 *         db/schema.ts:277, type enum 'code' only).
 *   write module-local `updateCodeUnitPublicAccess` — upstream
 *         `UpdateRepoUnitPublicAccess` (models/repo/repo_unit.go:374-378,
 *         `Cols("anonymous_access_mode", "everyone_access_mode")` Update)
 *         reduced to the anonymous half: an UPSERT on (repo_id, type='code').
 *         The upsert is the port's honest extension: no production producer
 *         inserts repo_units rows today (verified — only the lifecycle undo
 *         deletes them, git-http/gate.ts settleCreatingRepo), and the ACL
 *         read treats absent = none, so seeding the row on first write is
 *         state-identical to upstream's post-update row.
 *
 * ## Honest reductions (§6 method — never dead controls)
 *
 * - THE EVERYONE COLUMNS: `repo_units` carries NO `everyone_access_mode`
 *   column (db/schema.ts:277-289 — anonymous only), so upstream's Everyone
 *   Read and Everyone Write radio columns are UNRENDERED. The table renders
 *   upstream's Unit + Not set + Anonymous Read columns; the docs list
 *   likewise renders the two live arms' lines (public_access.docs.not_set /
 *   .anonymous_read) — the everyone_read/everyone_write doc lines defer with
 *   the columns. For the code unit upstream itself renders the write column
 *   as "-" (not in PublicAccessTypes, public_access.go:87).
 * - THE OTHER SEVEN UNIT ROWS (issues/PRs/releases/wiki/projects/packages/
 *   actions): `repo_units.type` is enum 'code'-only (db/schema.ts:282) — no
 *   rows exist to answer, and upstream renders only ENABLED units
 *   (public_access.go:122-124), so the one-row table IS the upstream-faithful
 *   rendering of our enabled-unit set. A note line below the table says so.
 * - GlobalForcePrivate (public_access.go:130-133 — the disabled submit +
 *   the repository_force_private flash): cf-gitea models no instance
 *   ForcePrivate setting (verified: no consumer anywhere in src/) — renders
 *   never; the submit button is never disabled.
 * - The POST accepts exactly the two live arms: upstream's
 *   parsePublicAccessMode port maps `anonymous-read` → 'read' and everything
 *   else (`not-set`, absent, junk — upstream's !slices.Contains arm,
 *   public_access.go:33-35) → 'none'. The everyone-* values are unreachable
 *   for the code unit exactly as upstream's PublicAccessTypes slice makes
 *   them.
 * - The success flash (`repo.settings.update_settings_success`) does not
 *   render — no session-flash plumbing (the settings family convention); the
 *   303 re-render IS the acknowledgment (the radio state moved).
 *
 * ## DUAL REFERENCES
 *
 * `/home/whc/pnpm_repos/cf-gitea-ref/` consulted: gitflare
 * (apps/web/src/lib/git-auth.ts:55-76) models plain repo visibility with
 * anonymous pull on PUBLIC repos only — no per-unit public-access grant
 * exists in any reference repo (g1t/git-on-cloudflare/gitorange checked).
 * The landed `repo_units.anonymous_access_mode` (SPEC-0003 §3.1, consumed by
 * git-http/acl.ts rows 4/5) is the only source for this page's semantics.
 */

import { drizzle } from "drizzle-orm/d1";

import { codeUnitAnonymousRead } from "../../git-http/acl";
import { repoUnits } from "../../db/schema";
import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { SettingsNav } from "./settings";

// ---------------------------------------------------------------------------
// Page chrome (the component-local locale pattern — locale.ts is shared and
// not this wave's file; every string cites its upstream key)
// ---------------------------------------------------------------------------

export const publicAccessLocale = {
  public_access: "Public Access", // "repo.settings.public_access" (the title + navbar item)
  public_access_desc:
    "Configure public visitor's access permissions to override the defaults of this repository.", // "repo.settings.public_access_desc"
  unit: "Unit", // "units.unit"
  permission_not_set: "Not set", // "settings.permission_not_set"
  permission_anonymous_read: "Anonymous Read", // "settings.permission_anonymous_read"
  docs_not_set:
    "Not Set: no extra public access permission. The visitor's permission follows the repository's visibility and member permissions.", // "repo.settings.public_access.docs.not_set"
  docs_anonymous_read:
    "Anonymous Read: users who are not logged in can access the unit with read permission.", // "repo.settings.public_access.docs.anonymous_read"
  update_settings: "Update Settings", // "repo.settings.update_settings"
  unit_code: "Code", // "repo.code" — the Code unit's display name
  aria_not_set: "Public access for Code: not set", // cf-gitea addition — the radio group's accessible name (upstream's is the bare table)
  aria_anonymous_read: "Public access for Code: anonymous read", // cf-gitea addition
  units_reduced_note:
    "Only the Code unit is modeled on this deployment; the other units' public-access rows appear when their storage lands.", // cf-gitea addition (the honest reduction — the module header)
  everyone_columns_note:
    "The Everyone Read and Everyone Write columns are not available yet: the store carries no per-unit everyone-access mode.", // cf-gitea addition (the honest reduction — the module header)
} as const;

/** The upstream form keys: `"repo-unit-access-" + int(unit.Type)` — the code
 *  unit is TypeCode = 1 (models/unit/unit.go:26), so its key is the literal
 *  below. Keeping upstream's exact key means upstream's form posts would
 *  bind unmodified. */
export const CODE_UNIT_FORM_KEY = "repo-unit-access-1";

/** The radio values — upstream's paNotSet/paAnonymousRead literals
 *  (public_access.go:47-52). The everyone-* literals defer with the columns
 *  (the module header). */
export type CodeUnitPublicAccess = "not-set" | "anonymous-read";

// ---------------------------------------------------------------------------
// The read + write arms (upstream PublicAccess / PublicAccessPost)
// ---------------------------------------------------------------------------

/** The page's render inputs: the code unit's mode and the navbar
 *  conditional's second arm (`HasAnyUnitPublicAccess`,
 *  repo_permission.go:63-72 — reduces to the same read: the code unit is the
 *  only unit carrying a mode column). */
export interface RepoPublicAccessData {
  /** The code unit's `anonymous_access_mode === "read"` (the ACL rows 4/5
   *  value — git-http/acl.ts's `codeUnitAnonymousRead`; absent row = false). */
  codeAnonymousRead: boolean;
  /** upstream navbar.tmpl:7's `.Permission.HasAnyUnitPublicAccess` — same
   *  value as `codeAnonymousRead` on this store (the module header). */
  hasAnyPublicAccess: boolean;
}

/** The page load — the same read the git-HTTP ACL consumes, so the page and
 *  the gate cannot drift (the SPEC-0010 §2.6 one-copy rule). */
export async function loadRepoPublicAccess(d1: D1Database, repoId: string): Promise<RepoPublicAccessData> {
  const codeAnonymousRead = await codeUnitAnonymousRead(d1, repoId);
  return { codeAnonymousRead, hasAnyPublicAccess: codeAnonymousRead };
}

/** Parse the urlencoded POST's radio (upstream FormString(CODE_UNIT_FORM_KEY)
 *  → parsePublicAccessMode): `anonymous-read` selects itself, every other
 *  value — including absent and junk — is the not-set arm (upstream's
 *  !slices.Contains refusal collapses to AccessModeNone,
 *  public_access.go:33-35). */
export function parsePublicAccessForm(params: URLSearchParams): CodeUnitPublicAccess {
  return params.get(CODE_UNIT_FORM_KEY) === "anonymous-read" ? "anonymous-read" : "not-set";
}

export type PublicAccessResult = { outcome: "applied" };

/**
 * The write — upstream `UpdateRepoUnitPublicAccess` (repo_unit.go:374-378)
 * reduced to the anonymous half: an UPSERT of the code unit's
 * `anonymous_access_mode` ('read' for anonymous-read, 'none' for not-set).
 * The row may be absent (no production producer seeds repo_units — the
 * module header); the ACL read treats absent = 'none', so the upsert's first
 * write lands in the same state upstream's post-update row holds. The git
 * clone gate consumes the new value on the NEXT anonymous request
 * (codeUnitAnonymousRead — no cache to clear).
 */
export async function updateCodeUnitPublicAccess(
  d1: D1Database,
  repoId: string,
  mode: CodeUnitPublicAccess,
): Promise<PublicAccessResult> {
  await drizzle(d1)
    .insert(repoUnits)
    .values({ repoId, type: "code", anonymousAccessMode: mode === "anonymous-read" ? "read" : "none" })
    .onConflictDoUpdate({
      target: [repoUnits.repoId, repoUnits.type],
      set: { anonymousAccessMode: mode === "anonymous-read" ? "read" : "none" },
    });
  return { outcome: "applied" };
}

// ---------------------------------------------------------------------------
// The render (public_access.tmpl at the pin)
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern). */
export function renderRepoPublicAccessPage(options: { ctx: UiContext; data: RepoPublicAccessData }): string {
  return renderPage(<RepoPublicAccessPage ctx={options.ctx} data={options.data} />);
}

/**
 * The public access page (§2.4.1 discriminator: `repository settings` —
 * public_access.tmpl's layout_head pageClass literal). The settings navbar
 * with the Public Access item active (its upstream conditional —
 * navbar.tmpl:7-11 — evaluated from the repo's visibility and the loaded
 * grant), then `.repo-setting-content`'s header/segment pair: the desc
 * line, the radio table, the docs list and the submit.
 */
export function RepoPublicAccessPage(props: { ctx: UiContext; data: RepoPublicAccessData }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("RepoPublicAccessPage requires ctx.repo (BaseLayout renders it only when resolved)");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  return (
    <BaseLayout ctx={ctx} title={publicAccessLocale.public_access} pageClass="repository settings">
      <div class="ui container flex-container">
        <SettingsNav
          repoLink={repoLink}
          active="public_access"
          repo={repo}
          hasAnyPublicAccess={data.hasAnyPublicAccess}
        />
        <div class="flex-container-main">
          <div class="repo-setting-content">
            <h4 class="ui top attached header">{publicAccessLocale.public_access}</h4>
            <div class="ui attached segment">
              <p>{publicAccessLocale.public_access_desc}</p>
              <form class="ui form" method="post" action={`${repoLink}/settings/public_access`}>
                <table class="ui table unstackable tw-my-2">
                  <thead>
                    <tr>
                      <th scope="col">{publicAccessLocale.unit}</th>
                      <th class="tw-text-center" scope="col">
                        {publicAccessLocale.permission_not_set}
                      </th>
                      <th class="tw-text-center" scope="col">
                        {publicAccessLocale.permission_anonymous_read}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{publicAccessLocale.unit_code}</td>
                      <td class="tw-text-center">
                        <label>
                          <input
                            type="radio"
                            name={CODE_UNIT_FORM_KEY}
                            value="not-set"
                            checked={data.codeAnonymousRead ? undefined : true}
                            aria-label={publicAccessLocale.aria_not_set}
                          />
                        </label>
                      </td>
                      <td class="tw-text-center">
                        <label>
                          <input
                            type="radio"
                            name={CODE_UNIT_FORM_KEY}
                            value="anonymous-read"
                            checked={data.codeAnonymousRead ? true : undefined}
                            aria-label={publicAccessLocale.aria_anonymous_read}
                          />
                        </label>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <ul class="tw-my-3 tw-pl-5 tw-flex tw-flex-col tw-gap-3">
                  <li>{publicAccessLocale.docs_not_set}</li>
                  <li>{publicAccessLocale.docs_anonymous_read}</li>
                </ul>
                {/* The everyone columns' reduction note (the module header —
                    upstream renders those radio columns; the store carries no
                    everyone-access mode to bind them to). */}
                <p class="tw-text-placeholder-text">{publicAccessLocale.everyone_columns_note}</p>
                <p class="tw-text-placeholder-text">{publicAccessLocale.units_reduced_note}</p>
                {/* GlobalForcePrivate renders never (the module header): the
                    submit is never disabled. */}
                <button type="submit" class="ui primary button">
                  {publicAccessLocale.update_settings}
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

// ---------------------------------------------------------------------------
// HANDOFF NOTE (for the `index.ts` window owner — this module has NO route)
// ---------------------------------------------------------------------------
//
// Upstream group (web.go:1191, inside the reqRepoAdmin-wrapped settings
// subtree at web.go:1285-1287). Mount two routes over the shared settingsGate
// (index.ts `settingsGate` — anonymous 303s onto the login round-trip, a
// signed-in non-admin 404-shells; the same posture as every settings
// sub-page, settingsPage/settingsSubmit's exact shape):
//
//   GET  /{owner}/{repo}/settings/public_access   resolveUiRequest →
//         settingsGate → loadRepoPublicAccess(c.env.DB, repo.id) →
//         renderRepoPublicAccessPage({ctx, data})
//   POST /{owner}/{repo}/settings/public_access   sameOriginGuard FIRST (the
//         §2.8 layer-2 check — settingsSubmit's order) → resolveUiRequest →
//         settingsGate → parsePublicAccessForm(await readUrlEncodedForm(
//         c.req.raw)) → updateCodeUnitPublicAccess(c.env.DB, repo.id, mode)
//         → 303 onto `/{owner}/{repo}/settings/public_access` (upstream's
//         ctx.Redirect, public_access.go:154; the success flash
//         update_settings_success does not render — the no-session-flash
//         convention; the re-render's moved radio IS the acknowledgment).
//
// Router claims (parseUiRoute, the `head === "settings"` block): add
//   `rest.length === 1 && rest[0] === "public_access"` → family
//   `settings-public-access` (the GET page + the POST share the Combo("")
//   shape). No collisions: the static literal is disjoint from
//   collaboration/hooks/branches/keys/mirror and beats any param family (the
//   hooks/git precedent).
//
// Nav fold: DONE (wave-settingsnav-fold) — pages/settings.tsx `SettingsNav`'s
// `active` union carries "public_access" and the item sits between Repository
// and Collaboration under upstream's own conditional (navbar.tmpl:7-11 —
// `repo.visibility === "private" || hasAnyPublicAccess`, the `repo` row +
// `hasAnyPublicAccess` grant passed by this page; callers not passing the
// repo row render the reduced nav without the item); PublicAccessSettingsNav
// is deleted and the page renders `SettingsNav` with `active="public_access"`.
// Survey rows to touch on landing:
// docs/compat/ui-parity-survey.md — the repo-settings family's
// public-access row (mark `/settings/public_access` rendered; NOTE the
// survey's "collaborator/team access graph" guess was wrong — the page is
// the per-unit public-access table) and the navbar-reduction note.
