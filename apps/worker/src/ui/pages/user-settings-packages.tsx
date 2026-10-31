/**
 * The USER settings PACKAGES tab — upstream's package cleanup-rules
 * management page at the USER scope (web.go:701-719's `/user/settings/
 * packages` group at the pin fc4936884584a41931906553d96c2601d750e6ef) —
 * the user-scope twin of pages/org-settings-packages.tsx, built by REUSE:
 * the shared shims (`routers/web/shared/packages/packages.go`) serve BOTH
 * scopes upstream — only the owner input differs (`ctx.Doer` here, the org
 * there), so every owner-id-based function is RE-EXPORTED from the org
 * module verbatim and only the record-shaped surfaces are duplicated.
 *
 * ## Upstream surface (VERIFIED at the pin)
 *
 *   - `routers/web/web.go:701-719` — the `/packages` group inside the
 *     reqSignIn `/user/settings` subtree, behind `packagesEnabled`
 *     (compile-time TRUE in the landed posture — the org twin's header):
 *     the list GET (`user.Packages`), the `rules/add` group (GET
 *     `user.PackagesRuleAdd` + POST `web.Bind[*forms.PackageCleanupRuleForm]`
 *     `user.PackagesRuleAddPost`), the `rules/{id}` combo (GET
 *     `user.PackagesRuleEdit` + POST `user.PackagesRuleEditPost` + GET
 *     `/preview` `user.PackagesRulePreview`), the `cargo` group (POST
 *     `/initialize` + `/rebuild`) and the bare
 *     `POST /chef/regenerate_keypair` (:718).
 *   - `routers/web/user/setting/packages.go` — eight thin handlers; all set
 *     Title `packages.title` + PageIsSettingsPackages and delegate to the
 *     SAME shared shims the org handlers ride (`SetPackagesContext`,
 *     `SetRuleAddContext`/`SetRuleEditContext`, `PerformRuleAddPost`/
 *     `PerformRuleEditPost`, `SetRulePreviewContext` — the org module's
 *     header carries their line-cited semantics :23-232; the write arms'
 *     add-ignores-action order, the dup gate, the resolve-before-action
 *     remove, the type-immutable save and the 303 targets are IDENTICAL).
 *     The redirect base is `setting.AppSubURL + "/user/settings/packages"`
 *     — a FIXED literal here (no per-owner segment).
 *   - Templates: `user/settings/packages.tmpl` (pageClass
 *     `user settings packages`) wrapping cleanup_rules/list + cargo + the
 *     CHEF keypair section; `user/settings/packages_cleanup_rules_edit.tmpl`
 *     (SAME pageClass) wrapping cleanup_rules/edit;
 *     `user/settings/packages_cleanup_rules_preview.tmpl` with the DISTINCT
 *     pageClass `user packages admin` (preview.tmpl:1 — the one pageClass
 *     that differs from the org family's uniform one) wrapping
 *     cleanup_rules/preview. All three under `user/settings/layout_head` —
 *     the user frame has NO owner header, just the navbar — and
 *     `user/settings/navbar.tmpl`'s Packages item (:61-65, EnablePackages-
 *     gated — compile-time TRUE; lit by PageIsSettingsPackages).
 *
 * ## The reuse-vs-duplication split
 *
 *   RE-EXPORTED from ./org-settings-packages (owner-id functions and pure
 *   helpers — the owner param is `package_cleanup_rules.owner_id`, the same
 *   column at both scopes): the form parser + the In lists, the create/edit
 *   appliers, the list/scoped-find/dup-gate reads, the pattern compile, the
 *   ellipsis, the %d locale helpers, and the locale object itself (both
 *   scopes render the SAME shared partials, so every string rides). The
 *   owner-named pieces alias onto the user-facing names at the import
 *   (`applyUserCleanupRuleCreate`, `userSettingsPackagesLocale`, … — the
 *   wiki-raw aliasing style), so this module's consumers never see an org
 *   name; the scope-neutral helpers keep their names.
 *   DUPLICATED (the record shapes that genuinely differ): the page-data
 *   records + the edit-data builders carry `UserProfileRow` (the users row —
 *   username for VersionWebLink, visibility for the badge) instead of
 *   OrgRecord; the preview ladder is the org body with the user's owner
 *   cells; the renders use the user frames (BaseLayout + navbar +
 *   `user-setting-content`, pageClasses above) with the base
 *   `/user/settings/packages`. The row markup inside the frames is the
 *   shared partials' verbatim (the same `package/shared/cleanup_rules/*`
 *   templates the org pages render).
 *
 * ## Documented omissions — cargo AND chef (no substrate at either)
 *
 *   - The CARGO section (cargo.tmpl + web.go:715-718's initialize/rebuild
 *     POSTs) is NOT RENDERED and NOT ROUTED: no cargo registry/index
 *     service exists (the org twin's documented dead-control reduction).
 *   - The CHEF section (packages.tmpl:9-24's keypair form +
 *     web.go:718's `POST /chef/regenerate_keypair` →
 *     `RegenerateChefKeyPair` — GenerateKeyPair + SetUserSetting of the
 *     chef public PEM, setting/packages.go:110-124) is NOT RENDERED and
 *     NOT ROUTED: there is no chef substrate either (no
 *     `modules/packages/chef`, no user-setting keystore; "chef" appears in
 *     the landed tree only as the TypeList NAME and a gitignore template).
 *     The keypair button would POST into a dead end — the no-dead-controls
 *     rule. A chef cleanup RULE stays functional and in the dropdown, the
 *     cargo-rule reasoning verbatim.
 *
 * ## The mount posture + HANDOFF recipes (the shared files are NOT edited
 * by this unit — settings-nav.tsx and ui/index.ts)
 *
 * The module is COMMITTED-UNMOUNTED (the user-settings-organizations
 * two-stage pattern): every function is live and tested, the local nav
 * below is MOUNT SCAFFOLDING (deleted at the fold-back), and the route
 * table + shared nav carry the wiring handoffs:
 *
 *   1. settings-nav.tsx — add `"packages"` to `UserSettingsNavTab` (after
 *      "runners", before "secrets" — navbar.tmpl order); the locale key
 *      `settingsNavLocale.packages` ALREADY EXISTS (the org tab's mount
 *      added it — the comment flips to name both mounts, "packages.title",
 *      navbar.tmpl:61-65); insert the Packages item AFTER the Actions
 *      `</details>` (navbar.tmpl:60) and BEFORE the hooks item (:66-70),
 *      with the dead-list pin flipped (the item carries the JSX comment
 *      "navbar.tmpl:61-65 — lit by the user settings packages tab's mount,
 *      pages/user-settings-packages.tsx"):
 *
 *        <a class={item("packages")} href="/user/settings/packages">
 *          {settingsNavLocale.packages}
 *        </a>
 *
 *      and move the "(Packages :61-65 dead)" comment off the hooks item;
 *      update the component doc comments (the item-order line + the
 *      user-nav reduction list lose "Packages"). DELETE this module's
 *      `UserSettingsPackagesNav` scaffold; the three renders swap to
 *      `<UserSettingsNavbar active="packages" />`.
 *   2. ui/index.ts parseUiRoute (inside the `raw[1] === "user" &&
 *      raw[2] === "settings"` block, after the variables-delete arms —
 *      the `rules/add` literal AHEAD of the `{id}` combo, chi's
 *      static-first dispatch, the reset_registration_token precedent;
 *      non-numeric ids stay unclaimed → the junk arm):
 *
 *        if (tail.length === 1 && tail[0] === "packages") {
 *          return { family: "user-settings-packages", id: null };
 *        }
 *        if (tail.length === 3 && tail[0] === "packages" && tail[1] === "rules" && tail[2] === "add") {
 *          return { family: "user-settings-packages-rule-add", id: null };
 *        }
 *        if (tail.length === 3 && tail[0] === "packages" && tail[1] === "rules") {
 *          const id = numericId(tail[2]);
 *          return id === null ? null : { family: "user-settings-packages-rule-edit", id };
 *        }
 *        if (tail.length === 4 && tail[0] === "packages" && tail[1] === "rules" && tail[3] === "preview") {
 *          const id = numericId(tail[2]);
 *          return id === null ? null : { family: "user-settings-packages-rule-preview", id };
 *        }
 *
 *      plus the UserSettingsTabRoute union entries (alphabetical, beside
 *      the other families):
 *
 *        | "user-settings-packages" // GET /user/settings/packages (the cleanup-rules list)
 *        | "user-settings-packages-rule-add" // GET+POST /user/settings/packages/rules/add
 *        | "user-settings-packages-rule-edit" // GET+POST /user/settings/packages/rules/{id}
 *        | "user-settings-packages-rule-preview" // GET /user/settings/packages/rules/{id}/preview
 *
 *   3. ui/index.ts handlers — the userSettingsTabPrologue family exactly as
 *      the runners handlers compose it (import the module's exports beside
 *      the other tab modules; every handler first reads the doer's row —
 *      the viewer carries only id+username, the pages need visibility —
 *      `const user = await drizzle(c.env.DB).select().from(users).where(
 *      eq(users.id, p.viewer.id)).get(); if (user === undefined) return
 *      p.respond(c.html(renderNotFound(p.ctx), 404));` — the
 *      doer-without-row 404 shell):
 *
 *        GET  list:    userSettingsTabPrologue(c, false) → the row read →
 *                      loadUserPackagesSettingsPageData(c.env.DB, user) →
 *                      respond(c.html(renderUserSettingsPackagesPage(...), 200)).
 *        GET  add:     prologue → the row read →
 *                      renderUserCleanupRuleEditPage with
 *                      userCleanupRuleEditDataForAdd(user).
 *        POST add:     userSettingsTabPrologue(c, true) [sameOriginGuard
 *                      FIRST] → the row read →
 *                      parseUserCleanupRuleForm(await readUrlEncodedForm(...))
 *                      → errors ? re-render
 *                      (userCleanupRuleEditDataFromForm(user, false, parsed))
 *                      : applyUserCleanupRuleCreate → "duplicate-type"
 *                      re-renders with errType + the banner text;
 *                      "created" 303s onto
 *                      `/user/settings/packages/rules/${ruleId}`.
 *        GET  edit:    prologue → the row read →
 *                      loadUserCleanupRuleEditPageData(c.env.DB, user, id) →
 *                      null ? the 404 shell : the render.
 *        POST edit:    prologue(c, true) → the row read → parse →
 *                      `const ruleId = parsed.values.id !== 0 ? parsed.values.id : routeId`
 *                      (getCleanupRuleByContext's form-id-first precedence)
 *                      → applyUserCleanupRuleEdit(c.env.DB, user.id, ruleId,
 *                      parsed.values, new Date()): "missing" → the 404
 *                      shell; "removed" → 303 onto
 *                      `/user/settings/packages`; "updated" → 303 onto the
 *                      rule URL; invalid+save → re-render via
 *                      loadUserCleanupRuleEditPageData composed with the
 *                      parsed echo (the org edit handler's exact shape).
 *        GET  preview: prologue → the row read →
 *                      loadUserCleanupRulePreview(c.env.DB, user, id) →
 *                      "missing" → the 404 shell; "ok" → the render. GET
 *                      ONLY — register
 *                      `uiRouter.post(...preview, () => methodNotAllowed("GET"))`
 *                      with every POST-only tail (chi's 405 twin).
 *
 *      registrations (the static literals before the `{id}` combos; no
 *      earlier registration can absorb these — `/user/settings` is the
 *      literal reserved-username family):
 *
 *        uiRouter.get("/user/settings/packages", (c) => userPackagesPage(c));
 *        uiRouter.post("/user/settings/packages", () => methodNotAllowed("GET"));
 *        uiRouter.get("/user/settings/packages/rules/add", (c) => userPackagesRuleAddPage(c));
 *        uiRouter.post("/user/settings/packages/rules/add", (c) => userPackagesRuleAddSubmit(c));
 *        uiRouter.get("/user/settings/packages/rules/:id{(\\d+)}", (c) => userPackagesRuleEditPage(c, Number(c.req.param("id"))));
 *        uiRouter.post("/user/settings/packages/rules/:id{(\\d+)}", (c) => userPackagesRuleEditSubmit(c, Number(c.req.param("id"))));
 *        uiRouter.get("/user/settings/packages/rules/:id{(\\d+)}/preview", (c) => userPackagesRulePreviewPage(c, Number(c.req.param("id"))));
 *        uiRouter.post("/user/settings/packages/rules/:id{(\\d+)}/preview", () => methodNotAllowed("GET"));
 *
 *      The cargo tails (`/user/settings/packages/cargo/initialize|rebuild`)
 *      and the chef tail (`/user/settings/packages/chef/regenerate_keypair`)
 *      stay UNREGISTERED (the engine's 404 — the omissions above). The
 *      preview loader's compile failure THROWS (upstream ServerError) —
 *      the app-level onError answers; unreachable through this page's own
 *      forms but honored for hand-seeded rows.
 *   4. tests — the mount window adds the route-level matrix (the
 *      user-settings family pattern): the anonymous 303, the cross-origin
 *      403 ahead of every write, the four parse claims + the junk-id/
 *      deeper-tail nulls and the cargo/chef tails' engine 404s. The
 *      module-level battery below covers every loader/apply/render arm.
 */

import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { packages, users } from "../../db/schema";
import {
  getPackageDescriptor,
  searchVersions,
  type PackageCleanupRuleRow,
} from "../../services/packages/model";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { formatByteSize } from "../page-data";
import { userLink } from "../links";
import {
  PACKAGE_TYPES,
  absoluteShort,
  packageTypeName,
  packageVisibilityBadgeKind,
  versionWebLink,
} from "./packages";
import { UserSettingsNavbar } from "../components/settings-nav";
import type { UserProfileRow } from "./user-profile";
import {
  CLEANUP_RULE_KEEP_COUNTS,
  CLEANUP_RULE_REMOVE_DAYS,
  applyOrgCleanupRuleCreate as applyUserCleanupRuleCreate,
  applyOrgCleanupRuleEdit as applyUserCleanupRuleEdit,
  cleanupRuleDays,
  cleanupRuleKeepCountN,
  cleanupRulePreviewOverview,
  compileOrgCleanupRulePattern,
  ellipsisPattern,
  findOrgScopedCleanupRule as findUserScopedCleanupRule,
  hasOrgCleanupRuleForType as hasUserCleanupRuleForType,
  listOrgCleanupRules as listUserCleanupRules,
  orgSettingsPackagesLocale as userSettingsPackagesLocale,
  parseOrgCleanupRuleForm as parseUserCleanupRuleForm,
  type OrgCleanupRuleFormErrors as UserCleanupRuleFormErrors,
  type OrgCleanupRuleFormValues as UserCleanupRuleFormValues,
  type OrgCleanupRuleFormView as UserCleanupRuleFormView,
  type OrgCleanupRuleParsedForm as UserCleanupRuleParsedForm,
  type OrgCleanupRulePreviewRow as UserCleanupRulePreviewRow,
} from "./org-settings-packages";

// ---------------------------------------------------------------------------
// The re-exports (the owner-agnostic logic — the HANDOFF's one-stop import
// site). The owner-id functions and the locale alias onto the user-facing
// names (the wiki-raw `readWikiRawBlob as loadWikiRawBlob` style); the
// scope-neutral helpers keep their names. The org-named originals stay
// reachable through the org module itself.
// ---------------------------------------------------------------------------

export {
  CLEANUP_RULE_KEEP_COUNTS,
  CLEANUP_RULE_REMOVE_DAYS,
  applyUserCleanupRuleCreate,
  applyUserCleanupRuleEdit,
  cleanupRuleDays,
  cleanupRuleKeepCountN,
  cleanupRulePreviewOverview,
  compileOrgCleanupRulePattern,
  ellipsisPattern,
  findUserScopedCleanupRule,
  hasUserCleanupRuleForType,
  listUserCleanupRules,
  parseUserCleanupRuleForm,
  userSettingsPackagesLocale,
};
export type {
  UserCleanupRuleFormErrors,
  UserCleanupRuleFormValues,
  UserCleanupRuleParsedForm,
  UserCleanupRulePreviewRow,
};

// ---------------------------------------------------------------------------
// The page data (the user-shaped twins — UserProfileRow instead of OrgRecord)
// ---------------------------------------------------------------------------

/** The list page's data (SetPackagesContext over ctx.Doer). */
export interface UserPackagesSettingsPageData {
  user: UserProfileRow;
  rules: PackageCleanupRuleRow[];
}

export async function loadUserPackagesSettingsPageData(d1: D1Database, user: UserProfileRow): Promise<UserPackagesSettingsPageData> {
  return { user, rules: await listUserCleanupRules(d1, user.id) };
}

/** The form-echo shape the edit template renders (the org module's view,
 *  re-exported under the user name). */

export interface UserCleanupRuleEditPageData {
  user: UserProfileRow;
  isEditRule: boolean;
  rule: UserCleanupRuleFormView;
  /** The duplicate-type arm's Err_Type (shared/packages.go:119). */
  errType: boolean;
  /** The binding-error field classes (the template's Err_* arms). */
  errors: UserCleanupRuleFormErrors;
  /** The flash-error banner line (the already-exists text). */
  error: string | null;
}

const EMPTY_VIEW: UserCleanupRuleFormView = {
  id: 0,
  enabled: false,
  type: "",
  matchFullName: false,
  keepCount: 0,
  keepPattern: "",
  removeDays: 0,
  removePattern: "",
};

/** `SetRuleAddContext` — the zero rule, add mode. */
export function userCleanupRuleEditDataForAdd(user: UserProfileRow): UserCleanupRuleEditPageData {
  return { user, isEditRule: false, rule: { ...EMPTY_VIEW }, errType: false, errors: { id: false, action: false, type: false, keepCount: false, keepPattern: false, removeDays: false, removePattern: false }, error: null };
}

/** The invalid-POST re-render's echo (the submitted values ride back). */
export function userCleanupRuleEditDataFromForm(
  user: UserProfileRow,
  isEditRule: boolean,
  parsed: UserCleanupRuleParsedForm,
  extra: { errType?: boolean; error?: string | null } = {},
): UserCleanupRuleEditPageData {
  return {
    user,
    isEditRule,
    rule: {
      id: parsed.values.id,
      enabled: parsed.values.enabled,
      type: parsed.values.type,
      matchFullName: parsed.values.matchFullName,
      keepCount: parsed.values.keepCount,
      keepPattern: parsed.values.keepPattern,
      removeDays: parsed.values.removeDays,
      removePattern: parsed.values.removePattern,
    },
    errType: extra.errType ?? false,
    errors: parsed.errors,
    error: extra.error ?? null,
  };
}

/** `SetRuleEditContext` — the scoped row; null is the NotFound arm. */
export async function loadUserCleanupRuleEditPageData(d1: D1Database, user: UserProfileRow, ruleId: number): Promise<UserCleanupRuleEditPageData | null> {
  const rule = await findUserScopedCleanupRule(d1, user.id, ruleId);
  if (rule === null) return null;
  return {
    user,
    isEditRule: true,
    rule: {
      id: rule.id,
      enabled: rule.enabled,
      type: rule.type,
      matchFullName: rule.matchFullName,
      keepCount: rule.keepCount,
      keepPattern: rule.keepPattern,
      removeDays: rule.removeDays,
      removePattern: rule.removePattern,
    },
    errType: false,
    errors: { id: false, action: false, type: false, keepCount: false, keepPattern: false, removeDays: false, removePattern: false },
    error: null,
  };
}

// ---------------------------------------------------------------------------
// The preview (SetRulePreviewContext over ctx.Doer — the cleanup consumer's
// candidate ladder; the org module's body with the user's owner cells)
// ---------------------------------------------------------------------------

export type UserCleanupRulePreviewData =
  | { kind: "missing" }
  | { kind: "ok"; user: UserProfileRow; rule: PackageCleanupRuleRow; rows: UserCleanupRulePreviewRow[] };

/**
 * The GET-only preview arm: the scope-guarded rule (a foreign/stale id is
 * "missing"), the non-compilable stored pattern THROWS (upstream
 * `ctx.ServerError("CompiledPattern")`), then exactly the ladder the org
 * module runs — per GetPackagesByType package, the created-desc versions
 * with the positional keep-count trim, the keep-pattern skip, the
 * remove-days cut and the remove-pattern gate, each survivor assembled
 * through getPackageDescriptor; the version links carry the USER's
 * username (VersionWebLink's owner segment).
 */
export async function loadUserCleanupRulePreview(d1: D1Database, user: UserProfileRow, ruleId: number, now: Date = new Date()): Promise<UserCleanupRulePreviewData> {
  const rule = await findUserScopedCleanupRule(d1, user.id, ruleId);
  if (rule === null) return { kind: "missing" };

  const keepMatcher = compileOrgCleanupRulePattern(rule.keepPattern);
  const removeMatcher = compileOrgCleanupRulePattern(rule.removePattern);
  if ((rule.keepPattern !== "" && keepMatcher === null) || (rule.removePattern !== "" && removeMatcher === null)) {
    throw new Error(`cleanup rule ${rule.id}: stored pattern does not compile (upstream ServerError "CompiledPattern")`);
  }

  // GetPackagesByType (package.go:298-303) — the owner+type packages with
  // the is_internal pin.
  const pkgs = await drizzle(d1)
    .select()
    .from(packages)
    .where(and(eq(packages.ownerId, rule.ownerId), eq(packages.type, rule.type), eq(packages.isInternal, false)))
    .all();

  const olderThan = new Date(now.getTime() - rule.removeDays * 24 * 60 * 60 * 1000);
  const rows: UserCleanupRulePreviewRow[] = [];
  for (const pkg of pkgs) {
    // Upstream SearchVersions{PackageID, IsInternal: false, SortCreatedDesc}
    // through the landed searchVersions: packageId IS upstream's filter
    // (ToConds' `package.id = :id` arm, package_version.go:222-224, over
    // the INNER JOIN :309-315), and omitting page/limit IS the
    // paginator-less Find (searchVersionsBySession's Paginator-nil arm,
    // :297-306 — upstream passes no Paginator here either).
    const { rows: versions } = await searchVersions(d1, {
      packageId: pkg.id,
      excludeInternal: true,
    });
    // The positional keep-count trim (upstream pvs[KeepCount:]).
    const pool = rule.keepCount > 0 ? versions.slice(rule.keepCount) : versions;
    for (const { version } of pool) {
      const toMatch = rule.matchFullName ? `${pkg.lowerName}/${version.lowerVersion}` : version.lowerVersion;
      if (keepMatcher !== null && keepMatcher.test(toMatch)) continue;
      if (version.createdUnix > olderThan) continue;
      if (removeMatcher !== null && !removeMatcher.test(toMatch)) continue;
      const descriptor = await getPackageDescriptor(d1, pkg, version);
      const size = descriptor.files.reduce((sum, file) => sum + file.blob.size, 0);
      rows.push({
        pkg,
        version,
        versionLink: versionWebLink(user.username, pkg.type, pkg.lowerName, version.lowerVersion),
        creatorName: null,
        sizeText: formatByteSize(size),
      });
    }
  }

  // The Creator cells: the batched users read; a missing row (creator_id 0
  // / deleted) renders Ghost.
  const creatorIds = [...new Set(rows.map((row) => row.version.creatorId).filter((id) => id > 0))];
  const creators = new Map<number, string>();
  if (creatorIds.length > 0) {
    const creatorRows = await drizzle(d1)
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, creatorIds))
      .all();
    for (const creator of creatorRows) creators.set(creator.id, creator.username);
  }
  for (const row of rows) row.creatorName = creators.get(row.version.creatorId) ?? null;

  return { kind: "ok", user, rule, rows };
}

// ---------------------------------------------------------------------------
// The renders — user/settings/packages.tmpl (+ the edit/preview templates).
// The list/edit pages ride pageClass `user settings packages`; the preview
// page rides the template's DISTINCT `user packages admin` (preview.tmpl:1).
// ---------------------------------------------------------------------------


/** The full-document render (the render.tsx pattern — index.ts stays a
 *  pure-TS router module). */
export function renderUserSettingsPackagesPage(ctx: UiContext, data: UserPackagesSettingsPageData): string {
  return renderPage(<UserSettingsPackagesPage ctx={ctx} data={data} />);
}

/** The list page (user/settings/packages.tmpl → cleanup_rules/list.tmpl).
 *  The cargo AND chef sections are NOT rendered — no substrate for either
 *  (the module header's documented dead-control omissions). */
export function UserSettingsPackagesPage(props: { ctx: UiContext; data: UserPackagesSettingsPageData }) {
  const { ctx, data } = props;
  const base = "/user/settings/packages";
  return (
    <BaseLayout ctx={ctx} title={userSettingsPackagesLocale.title} pageClass="user settings packages">
      <div class="ui container flex-container">
        <UserSettingsNavbar active="packages" />
        <div class="flex-container-main">
          <div class="user-setting-content">
            {/* cleanup_rules/list.tmpl:1-5 — the header + the Add button
                ({{.Link}} is the page URI → /user/settings/packages). */}
            <h4 class="ui top attached header">
              {userSettingsPackagesLocale.cleanup_rules_title}
              <div class="ui right">
                <a class="ui primary tiny button" href={`${base}/rules/add`}>
                  {userSettingsPackagesLocale.add_rule}
                </a>
              </div>
            </h4>
            <div class="ui attached segment">
              <div class="flex-divided-list items-with-main">
                {data.rules.length === 0 ? (
                  <div class="item">{userSettingsPackagesLocale.none}</div>
                ) : (
                  data.rules.map((rule) => (
                    <div class="item" key={rule.id}>
                      <div class="item-leading">
                        {/* {{svg .Type.SVGName 32}} — the octicon-package
                            degradation (the org twin's header). */}
                        <Icon name="octicon-package" size={32} />
                      </div>
                      <div class="item-main">
                        <div class="item-title">
                          <a class="item" href={`${base}/rules/${rule.id}`}>
                            {packageTypeName(rule.type)}
                          </a>
                        </div>
                        <div class="item-body">
                          <i>{rule.enabled ? userSettingsPackagesLocale.enabled : userSettingsPackagesLocale.disabled}</i>
                        </div>
                        {rule.keepCount > 0 ? (
                          <div class="item-body">
                            <i>{userSettingsPackagesLocale.keep_count}:</i>{" "}
                            {rule.keepCount === 1
                              ? userSettingsPackagesLocale.keep_count_1
                              : cleanupRuleKeepCountN(rule.keepCount)}
                          </div>
                        ) : null}
                        {rule.keepPattern !== "" ? (
                          <div class="item-body">
                            <i>{userSettingsPackagesLocale.keep_pattern}:</i> {ellipsisPattern(rule.keepPattern, 100)}
                          </div>
                        ) : null}
                        {rule.removeDays > 0 ? (
                          <div class="item-body">
                            <i>{userSettingsPackagesLocale.remove_days}:</i> {cleanupRuleDays(rule.removeDays)}
                          </div>
                        ) : null}
                        {rule.removePattern !== "" ? (
                          <div class="item-body">
                            <i>{userSettingsPackagesLocale.remove_pattern}:</i> {ellipsisPattern(rule.removePattern, 100)}
                          </div>
                        ) : null}
                      </div>
                      <div class="item-trailing">
                        {/* The kebab dropdown reduced to its two menu items
                            (list.tmpl's Edit + Preview) as plain links — the
                            no-JS reduction (the org twin's header). */}
                        <a href={`${base}/rules/${rule.id}`}>{userSettingsPackagesLocale.edit}</a>
                        <a href={`${base}/rules/${rule.id}/preview`}>{userSettingsPackagesLocale.preview}</a>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
            {/* package/shared/cargo.tmpl: NOT RENDERED — no cargo substrate.
                The chef keypair section (packages.tmpl:9-24): NOT RENDERED —
                no chef substrate either (the module header's omissions). */}
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The full-document render. */
export function renderUserCleanupRuleEditPage(ctx: UiContext, data: UserCleanupRuleEditPageData): string {
  return renderPage(<UserCleanupRuleEditPage ctx={ctx} data={data} />);
}

/** The add/edit page (user/settings/packages_cleanup_rules_edit.tmpl →
 *  cleanup_rules/edit.tmpl; the SAME `user settings packages` pageClass).
 *  The form action is the page's OWN URL ({{.Link}}): `.../rules/add` or
 *  `.../rules/{id}` over the fixed user base. */
export function UserCleanupRuleEditPage(props: { ctx: UiContext; data: UserCleanupRuleEditPageData }) {
  const { ctx, data } = props;
  const base = "/user/settings/packages";
  const formAction = data.isEditRule ? `${base}/rules/${data.rule.id}` : `${base}/rules/add`;
  return (
    <BaseLayout ctx={ctx} title={userSettingsPackagesLocale.title} pageClass="user settings packages">
      <div class="ui container flex-container">
        <UserSettingsNavbar active="packages" />
        <div class="flex-container-main">
          <div class="user-setting-content">
            <h4 class="ui top attached header">
              {data.isEditRule ? userSettingsPackagesLocale.edit_rule : userSettingsPackagesLocale.add_rule}
            </h4>
            <div class="ui attached segment">
              {/* The already-exists banner (the flash-error reduction — the
                  org twin's convention). */}
              {data.error !== null ? <div class="ui negative message">{data.error}</div> : null}
              <form class="ui form" action={formAction} method="post">
                <input type="hidden" name="id" value={String(data.rule.id)} />
                <div class="field">
                  <div class="ui checkbox">
                    <label>{userSettingsPackagesLocale.enabled}</label>
                    <input type="checkbox" name="enabled" checked={data.rule.enabled ? true : undefined} />
                  </div>
                </div>
                {/* edit.tmpl:9-19 — the type field: `disabled` in edit mode
                    (the row keeps its type; the posted value is ignored),
                    the Err_Type error class on the duplicate arm. */}
                <div class={`${data.isEditRule ? "disabled " : ""}field ${data.errType ? "error" : ""}`}>
                  <label>{userSettingsPackagesLocale.type}</label>
                  <select class="ui selection dropdown" name="type">
                    {PACKAGE_TYPES.map((entry) => (
                      <option value={entry.type} selected={data.rule.type === entry.type ? true : undefined}>
                        {entry.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div class="field">
                  <div class="ui checkbox">
                    <label>{userSettingsPackagesLocale.pattern_full_match}</label>
                    <input type="checkbox" name="match_full_name" checked={data.rule.matchFullName ? true : undefined} />
                  </div>
                </div>
                <div class="divider" />
                <p>{userSettingsPackagesLocale.keep_title}</p>
                <div class={`field ${data.errors.keepCount ? "error" : ""}`}>
                  <label>{userSettingsPackagesLocale.keep_count}:</label>
                  <select class="ui selection dropdown" name="keep_count">
                    {[0, 1, 5, 10, 25, 50, 100].map((count) => (
                      <option value={String(count)} selected={data.rule.keepCount === count ? true : undefined}>
                        {count === 0 ? "" : count === 1 ? userSettingsPackagesLocale.keep_count_1 : cleanupRuleKeepCountN(count)}
                      </option>
                    ))}
                  </select>
                </div>
                <div class={`field ${data.errors.keepPattern ? "error" : ""}`}>
                  <label>{userSettingsPackagesLocale.keep_pattern}:</label>
                  <input name="keep_pattern" type="text" value={data.rule.keepPattern} />
                  <p>
                    {userSettingsPackagesLocale.keep_pattern_container_prefix} <code>latest</code>
                    {userSettingsPackagesLocale.keep_pattern_container_suffix}
                  </p>
                </div>
                <div class="divider" />
                <p>{userSettingsPackagesLocale.remove_title}</p>
                <div class={`field ${data.errors.removeDays ? "error" : ""}`}>
                  <label>{userSettingsPackagesLocale.remove_days}:</label>
                  <select class="ui selection dropdown" name="remove_days">
                    {[0, 7, 14, 30, 60, 90, 180].map((days) => (
                      <option value={String(days)} selected={data.rule.removeDays === days ? true : undefined}>
                        {days === 0 ? "" : cleanupRuleDays(days)}
                      </option>
                    ))}
                  </select>
                </div>
                <div class={`field ${data.errors.removePattern ? "error" : ""}`}>
                  <label>{userSettingsPackagesLocale.remove_pattern}:</label>
                  <input name="remove_pattern" type="text" value={data.rule.removePattern} />
                </div>
                <div class="field">
                  {data.isEditRule ? (
                    <>
                      {/* edit.tmpl:61-63 — the Save/Remove submit pair (the
                          action field discriminates) + the Preview link. */}
                      <button type="submit" class="ui primary button" name="action" value="save">
                        Save
                      </button>
                      <button type="submit" class="ui red button" name="action" value="remove">
                        Remove
                      </button>
                      <a class="ui button" href={`${base}/rules/${data.rule.id}/preview`}>
                        {userSettingsPackagesLocale.preview}
                      </a>
                    </>
                  ) : (
                    <button type="submit" class="ui primary button" name="action" value="save">
                      Add
                    </button>
                  )}
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The visibility badge cell (package/shared/visibility_badge.tmpl — over
 *  the USER's visibility; null renders nothing). */
function CleanupRuleVisibilityBadge(props: { kind: "internal" | "private" | null }) {
  if (props.kind === "internal") return <span class="ui basic label">{userSettingsPackagesLocale.badge_internal}</span>;
  if (props.kind === "private") return <span class="ui basic label">{userSettingsPackagesLocale.badge_private}</span>;
  return null;
}

/** The full-document render. */
export function renderUserCleanupRulePreviewPage(ctx: UiContext, data: Extract<UserCleanupRulePreviewData, { kind: "ok" }>): string {
  return renderPage(<UserCleanupRulePreviewPage ctx={ctx} data={data} />);
}

/** The preview page (user/settings/packages_cleanup_rules_preview.tmpl →
 *  cleanup_rules/preview.tmpl) — GET only. The template's DISTINCT
 *  pageClass `user packages admin` (preview.tmpl:1 — the one pageClass the
 *  user family does NOT share with the list/edit pair). */
export function UserCleanupRulePreviewPage(props: { ctx: UiContext; data: Extract<UserCleanupRulePreviewData, { kind: "ok" }> }) {
  const { ctx, data } = props;
  return (
    <BaseLayout ctx={ctx} title={userSettingsPackagesLocale.title} pageClass="user packages admin">
      <div class="ui container flex-container">
        <UserSettingsNavbar active="packages" />
        <div class="flex-container-main">
          <div class="user-setting-content">
            <h4 class="ui top attached header">{userSettingsPackagesLocale.preview}</h4>
            <div class="ui attached segment">
              <p>{cleanupRulePreviewOverview(data.rows.length)}</p>
            </div>
            <div class="ui attached table segment">
              <table class="ui very basic table unstackable">
                <thead>
                  <tr>
                    <th>{userSettingsPackagesLocale.admin_type}</th>
                    <th>{userSettingsPackagesLocale.admin_name}</th>
                    <th>{userSettingsPackagesLocale.admin_version}</th>
                    <th>{userSettingsPackagesLocale.admin_creator}</th>
                    <th>{userSettingsPackagesLocale.admin_size}</th>
                    <th>{userSettingsPackagesLocale.admin_published}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.length === 0 ? (
                    <tr>
                      <td colspan={6}>{userSettingsPackagesLocale.preview_none}</td>
                    </tr>
                  ) : (
                    data.rows.map((row, index) => (
                      <tr key={`${row.version.id}-${index}`}>
                        <td>{packageTypeName(row.pkg.type)}</td>
                        <td>
                          {row.pkg.name}
                          <span class="label-list">
                            <CleanupRuleVisibilityBadge kind={packageVisibilityBadgeKind(row.pkg, data.user.visibility)} />
                          </span>
                        </td>
                        <td>
                          <a href={row.versionLink}>{row.version.version}</a>
                        </td>
                        <td>
                          {/* The Ghost arm (descriptor.go:134-140) — a
                              missing creator renders the Ghost user's
                              HomeLink. */}
                          <a href={row.creatorName !== null ? userLink(row.creatorName) : `/${userSettingsPackagesLocale.ghost}`}>
                            {row.creatorName ?? userSettingsPackagesLocale.ghost}
                          </a>
                        </td>
                        <td>{row.sizeText}</td>
                        <td>{absoluteShort(row.version.createdUnix)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
