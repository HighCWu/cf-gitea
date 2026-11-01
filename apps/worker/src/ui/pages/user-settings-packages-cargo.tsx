/**
 * The settings PACKAGES tab's CARGO index section — upstream's
 * `package/shared/cargo.tmpl` (rendered by BOTH the user frame,
 * templates/user/settings/packages.tmpl's second include, and the org frame,
 * templates/org/settings/packages.tmpl's second include) plus the two write
 * arms' seams record: `POST …/packages/cargo/initialize` and
 * `POST …/packages/cargo/rebuild` (user web.go:714-717, org web.go:1081-1085
 * → shared/packages/packages.go:234-254 InitializeCargoIndex /
 * RebuildCargoIndex over cargo_service.InitializeIndexRepository /
 * RebuildIndex). This module carries the SECTION + the locale; the thin POST
 * handlers live beside the other packages handlers in ui/index.ts calling
 * the LANDED mirror seams directly (services/packages/cargo-index.ts
 * ensureCargoIndexMirror / rebuildCargoIndexMirror — the chef module's
 * section+seams split, the landed family's shape).
 *
 * ## The adjudication history (why this section now renders)
 *
 * The packages settings modules documented the cargo section as NOT RENDERED
 * and NOT ROUTED — a dead-control reduction whose stated reason was "no
 * cargo registry/index service exists". That reason expired at e4d7e49: the
 * mirror service landed (ensureCargoIndexMirror = InitializeIndexRepository's
 * port, rebuildCargoIndexMirror = RebuildIndex's port), so a rendered button
 * no longer POSTs into a dead tail — the dead-control rule's precondition
 * is gone, and upstream's own answer (the section renders unconditionally,
 * web.go:714-717/:1081-1085 inside the packagesEnabled group — compile-time
 * TRUE in the landed posture) IS the default per AGENTS.md's
 * upstream-parity rule. The chef arm rode the identical arc (documented
 * absent pre-substrate, folded back live when chef-auth landed).
 *
 * ## Upstream surface (VERIFIED at the pin)
 *
 *   - cargo.tmpl: an `h4.ui.top.attached.header` carrying
 *     `packages.owner.settings.cargo.title`, an `attached segment` with a
 *     `ui form` of FOUR fields — the initialize description label, the
 *     initialize `<form class="field" action="{{.Link}}/cargo/initialize"
 *     method="post">` whose only control is the primary submit button
 *     (`packages.owner.settings.cargo.initialize`), the rebuild description
 *     label, and the rebuild `<form class="field"
 *     action="{{.Link}}/cargo/rebuild" method="post">` ditto
 *     (`packages.owner.settings.cargo.rebuild`) — then the
 *     `packages.registry.documentation` label with ("Cargo",
 *     "https://docs.gitea.com/usage/packages/cargo/"). NO confirm dialog —
 *     bare POSTs (the chef section's exact shape).
 *   - The handlers: shared InitializeCargoIndex/RebuildCargoIndex flash
 *     success/error then the scope wrapper REDIRECTS back onto the settings
 *     page (user setting/packages.go:85-100 → /user/settings/packages; org
 *     setting_packages.go:109-124 → /org/{name}/settings/packages). Upstream
 *     commits as owner=doer=ctx.Doer/ctx.ContextUser — the mirror commits
 *     author as the OWNER; our seams' doerId stays OMITTED in these arms
 *     (the cargo-index module's owner-authors default), the exact upstream
 *     posture.
 *   - Locale keys (gitea/options/locale/locale_en-US.json at the pin):
 *     `packages.owner.settings.cargo.title` "Cargo Registry Index";
 *     `…cargo.initialize` "Initialize Index";
 *     `…cargo.initialize.description` "A special index Git repository is
 *     needed to use the Cargo registry. Using this option will (re-)create
 *     the repository and configure it automatically.";
 *     `…cargo.rebuild` "Rebuild Index"; `…cargo.rebuild.description`
 *     "Rebuilding can be useful if the index is not synchronized with the
 *     stored Cargo packages."; `packages.registry.documentation` — the same
 *     structural-anchor rendering as the chef section.
 *
 * ## Mount (executed — the ui/index.ts hunks beside the chef arm's)
 *
 *   - parseUiRoute: the user tail `packages/cargo/{initialize,rebuild}`
 *     (web.go:714-717) and the org tail `…/settings/packages/cargo/{initialize,
 *     rebuild}` (web.go:1081-1085) — POST-only upstream, the GET twins
 *     answer the 405 (the chef tail's posture).
 *   - handlers: guard-first prologues → ensure/rebuild over
 *     `cargoIndexBindings(c.env)` → 303 back onto the scope's settings
 *     packages page (upstream's redirect; the flash rides no queue — the
 *     landed no-flash-queue reduction, the cron POST's convention).
 */

// ---------------------------------------------------------------------------
// The locale (gitea/options/locale/locale_en-US.json at the pin)
// ---------------------------------------------------------------------------

export const packagesCargoLocale = {
  /** "packages.owner.settings.cargo.title" */
  title: "Cargo Registry Index",
  /** "packages.owner.settings.cargo.initialize" */
  initialize: "Initialize Index",
  /** "packages.owner.settings.cargo.initialize.description" */
  initialize_description:
    "A special index Git repository is needed to use the Cargo registry. Using this option will (re-)create the repository and configure it automatically.",
  /** "packages.owner.settings.cargo.rebuild" */
  rebuild: "Rebuild Index",
  /** "packages.owner.settings.cargo.rebuild.description" */
  rebuild_description: "Rebuilding can be useful if the index is not synchronized with the stored Cargo packages.",
  /** "packages.registry.documentation" — the two %s args rendered
   *  structurally (the chef section's exact approach). */
  documentation_registry: "Cargo",
  documentation_url: "https://docs.gitea.com/usage/packages/cargo/",
  documentation_link_text: "the documentation",
} as const;

// ---------------------------------------------------------------------------
// The section — package/shared/cargo.tmpl (the fold-back renders this inside
// the settings content div, after the cleanup-rules segment and before the
// chef section at the user scope)
// ---------------------------------------------------------------------------

/**
 * The cargo index section. `base` is the page URI `{{.Link}}` — the user
 * frame's `/user/settings/packages` or the org frame's
 * `/{org}/settings/packages` — so the form actions are `{Link}/cargo/initialize`
 * and `{Link}/cargo/rebuild` byte-exactly.
 */
export function CargoIndexSection(props: { base: string }) {
  return (
    <>
      <h4 class="ui top attached header">{packagesCargoLocale.title}</h4>
      <div class="ui attached segment">
        <div class="ui form">
          <div class="field">
            <label>{packagesCargoLocale.initialize_description}</label>
          </div>
          {/* cargo.tmpl:8-10 — the bare POST (no confirm dialog). */}
          <form class="field" action={`${props.base}/cargo/initialize`} method="post">
            <button type="submit" class="ui primary button">{packagesCargoLocale.initialize}</button>
          </form>
          <div class="field">
            <label>{packagesCargoLocale.rebuild_description}</label>
          </div>
          <form class="field" action={`${props.base}/cargo/rebuild`} method="post">
            <button type="submit" class="ui primary button">{packagesCargoLocale.rebuild}</button>
          </form>
          <div class="field">
            {/* cargo.tmpl:15-17 — packages.registry.documentation with
                ("Cargo", the cargo docs URL); the anchor is structural. */}
            <label>
              {`For more information on the ${packagesCargoLocale.documentation_registry} registry, see `}
              <a target="_blank" rel="noopener noreferrer" href={packagesCargoLocale.documentation_url}>
                {packagesCargoLocale.documentation_link_text}
              </a>
              .
            </label>
          </div>
        </div>
      </div>
    </>
  );
}
