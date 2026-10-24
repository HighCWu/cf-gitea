/**
 * Server-side English strings for the Tier-2 UI shell (SPEC-0008 §2.4 module
 * layout; spike §8 i18n row). Slice 1 is English-only, so this module is the
 * single source for shell/page chrome text and for the client i18n object
 * embedded in `window.config` — a future locale layer replaces this object,
 * not the components.
 *
 * Where an upstream string exists, the comment cites its locale key
 * (gitea/options/locale/locale_en-US.json at the pin); cf-gitea-specific
 * additions say so.
 */

/** A locale string that may carry inline emphasis, mirroring upstream's
 *  `template.HTML` strings without a raw-HTML sink (SPEC-0008 §4.12: JSX
 *  auto-escaping everywhere; `{strong}` segments render as `<strong>`). */
export type EmphasizedText = readonly (string | { readonly strong: string })[];

/** Shell chrome text. */
export const locale = {
  app_name: "cf-gitea",
  home_title: "Home", // "home_title"
  help: "Help", // "help"
  logo: "Logo", // "logo"
  nav_menu: "Navigation Menu", // "home.nav_menu"
  enable_javascript: "This website requires JavaScript.", // "enable_javascript"
  navbar_aria: "Navigation Bar", // "aria.navbar"
  footer_aria: "Footer", // "aria.footer"
  footer_software_aria: "About Software", // "aria.footer.software"
  footer_links_aria: "Links", // "aria.footer.links"
  powered_by_gitea: "Powered by Gitea", // "powered_by" with "Gitea"
  licenses: "Licenses", // "licenses"
  repo_code: "Code", // "repo.code"
  /** cf-gitea addition: upstream at this pin has no Commits tab in the strip
   *  (commits is reached from the repo home), but SPEC-0008 §2.4.1 commits to
   *  a Code + Commits tab strip because /commits is a slice-1 page. */
  repo_commits: "Commits",
  repo_desc_public_access: "Public Access", // "repo.desc.public_access"
  repo_desc_private: "Private", // "repo.desc.private" (unreachable in slice 1:
  //  private repos 404 before any shell render — SPEC-0008 §2.5)

  /** 404 page text; shape mirrors gitea/templates/status/404.tmpl. */
  page_not_found_title: "Page Not Found", // upstream notFoundInternal Data["Title"]
  error404_box_title: "404 Not Found", // hardcoded in status/404.tmpl
  error404: [
    "The page you are trying to reach either ",
    { strong: "does not exist" },
    " or ",
    { strong: "you are not authorized" },
    " to view it.",
  ] satisfies EmphasizedText,
  go_back: "Go Back", // "go_back" (rendered only with a back target — none in slice 1)
} as const;

/** The complete client i18n surface: `window.config.i18n` carries exactly
 *  these 7 general keys (SPEC-0008 §2.4.1; upstream WindowConfig i18n block —
 *  `gitea/services/context/context_template.go` reading "error.occurred",
 *  "remove_label_str", "modal.confirm", "modal.cancel", "more_items",
 *  "copy_success", "copy_error"). */
export const configI18n = {
  error_occurred: "An error occurred",
  remove_label_str: 'Remove item "%s"',
  modal_confirm: "Confirm",
  modal_cancel: "Cancel",
  more_items: "More items",
  copy_success: "Copied!",
  copy_error: "Copy failed",
} as const;
