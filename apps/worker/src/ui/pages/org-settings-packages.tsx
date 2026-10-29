/**
 * The org settings PACKAGES tab — upstream's package cleanup-rules
 * management page (web.go:1069-1085's `/packages` group inside the org
 * `/settings` subtree at the pin fc4936884584a41931906553d96c2601d750e6ef).
 *
 * ## Upstream surface (VERIFIED at the pin)
 *
 *   - `routers/web/web.go:1069-1085` — `m.Group("/packages", ...)`: the list
 *     GET (`org.Packages`), the `rules/add` group (GET `org.PackagesRuleAdd`
 *     + POST `web.Bind[*forms.PackageCleanupRuleForm]` `org.PackagesRuleAddPost`),
 *     the `rules/{id}` combo (GET `org.PackagesRuleEdit` + POST
 *     `org.PackagesRuleEditPost` + GET `/preview` `org.PackagesRulePreview`)
 *     and the `cargo` group (POST `/initialize` + `/rebuild`). The group
 *     sits behind `packagesEnabled` (web.go:430 — `setting.Packages.Enabled`,
 *     compile-time TRUE in the landed posture) inside the org settings
 *     subtree's `context.OrgAssignment{RequireOwner: true}` (web.go:1092) +
 *     `reqSignIn` — the same posture every landed org settings tab rides
 *     (the resolveOrgTeamsRequest prologue; the org-settings-actions header).
 *     NOTE the landed org family's URL divergence (the wave-14 record, the
 *     shared settings-nav header): upstream serves `/org/{name}/settings/
 *     packages` (the redirect target at setting_packages.go:76), the landed
 *     family serves `/{org}/settings/packages` — this module follows the
 *     LANDED family's shape.
 *   - `routers/web/org/setting_packages.go` — the six thin handlers; all set
 *     Title `packages.title` and delegate to `routers/web/shared/packages/
 *     packages.go`: `SetPackagesContext` (:23-31 — GetCleanupRulesByOwner),
 *     `SetRuleAddContext`/`SetRuleEditContext` (:33-54 — the zero rule vs
 *     the scoped row + AvailableTypes), `PerformRuleAddPost`/
 *     `PerformRuleEditPost` (:56-134), `SetRulePreviewContext` (:136-207),
 *     `getCleanupRuleByContext` (:209-232 — FormInt64("id") FIRST, then the
 *     path id; GetCleanupRuleByID; the `pcr.OwnerID == owner.ID` pin — a
 *     foreign/stale id is the NotFound arm).
 *   - `models/packages/package_cleanup_rule.go` — the row struct (:25-40),
 *     `CompiledPattern` (:41-54 — `(?i)\A…\z` compiles), Insert/Get/Update/
 *     Delete/GetCleanupRulesByOwner/HasOwnerCleanupRuleForPackageType
 *     (:56-100).
 *   - `models/packages/package.go:298-303` — `GetPackagesByType` (owner+type
 *     + `package.is_internal = false`).
 *   - `services/forms/package_form.go` — `PackageCleanupRuleForm`: Type
 *     `Required;In(<the 23 TypeList values>)`, KeepCount
 *     `In(0,1,5,10,25,50,100)`, KeepPattern/RemovePattern `RegexPattern`
 *     (NON-ZERO — empty passes; a non-empty value must `regexp.Compile`,
 *     validation/binding.go:80-88), RemoveDays `In(0,7,14,30,60,90,180)`,
 *     Action `Required;In(save,remove)`.
 *   - Templates: `org/settings/packages.tmpl` (pageClass
 *     `organization settings packages`) wrapping
 *     `package/shared/cleanup_rules/list.tmpl` + `package/shared/cargo.tmpl`;
 *     `org/settings/packages_cleanup_rules_edit.tmpl` wrapping
 *     `cleanup_rules/edit.tmpl`; `org/settings/packages_cleanup_rules_preview.tmpl`
 *     wrapping `cleanup_rules/preview.tmpl`. All three under
 *     OrgHeader + `org/settings/navbar.tmpl` (the Packages item :23-27,
 *     lit by PageIsSettingsPackages).
 *
 * ## The write arms' semantics (shared/packages.go:56-134 — ported verbatim)
 *
 *   ADD POST (the action field is IGNORED on this arm — PerformRuleAddPost
 *   goes straight to performRuleEditPost(nil): a crafted action=remove on
 *   the add URL INSERTS, upstream's exact shape): binding errors re-render
 *   the edit template with the submitted values and the per-field `.error`
 *   classes (ctx.HasError, :102-105 — no DB touch); the dup check
 *   `HasOwnerCleanupRuleForPackageType` (:115-123) sets Err_Type + the
 *   already-exists flash error and re-renders; success INSERTS (Type taken
 *   from the FORM on this arm only, :113) and 303s onto
 *   `{redirectURL}/rules/{id}` (:133).
 *   EDIT POST: the rule resolves FIRST (getCleanupRuleByContext — a
 *   missing/foreign id is the NotFound arm BEFORE any action runs, :61-64);
 *   `action=remove` DELETES and 303s onto the list (:68-78) — checked
 *   BEFORE validation, so an invalid-field remove still removes (upstream's
 *   order); otherwise the fields overwrite (:90-96 — note Type is NOT among
 *   them: the row keeps its type, the edit form's select renders disabled),
 *   binding errors re-render, success UPDATES and 303s onto
 *   `{redirectURL}/rules/{id}` (:132-133). The success flash lines
 *   (`cleanuprules.success.update/delete`) do not render — the landed
 *   no-session-flash reduction (the org secrets twin).
 *
 * ## Data (§3.2 — the LANDED SPEC-0016 store, plain drizzle)
 *
 * `package_cleanup_rules` (schema.ts — migration 0039, UNIQUE(owner_id,type))
 * is the landed sixth table; the hourly cleanup consumer
 * (services/packages/cleanup.ts) already reads it. The rules CRUD is THIS
 * page's downstream (the schema comment) — plain drizzle on the landed
 * table, no service layer, no schema change: list/get-scope-guarded/
 * exists-check/insert/update/delete mirroring package_cleanup_rule.go's
 * six functions. The preview rides the LANDED model reads:
 * `searchVersions` (model.ts:445 — created desc, id desc, the
 * configureOrderBy default) + `getPackageDescriptor` (model.ts:384 — files
 * joined to blobs for CalculateBlobSize), with cleanup.ts:153's EXACT
 * anchored case-insensitive compile (`^(?:pattern)$`, "i") and the
 * consumer's candidate ladder (cleanup.ts:193-203 = upstream preview
 * packages.go:157-203 minus the container ShouldBeSkipped arm — no
 * container substrate, the sweep's documented v1 reduction). Upstream's
 * per-package `SearchVersions{PackageID}` pin reduces to the landed search
 * option set: `{ownerId, type, name: pkg.lowerName, exact: true}` — the
 * package unique key (owner_id,type,lower_name) resolves the identical row
 * set; the paginator-less `Find` (package_version.go:323-327, unbounded)
 * reduces to the beyond-any-store limit (the org secrets/variables twins'
 * `*_WEB_LIST_LIMIT` seam).
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - The CARGO section (`package/shared/cargo.tmpl` + web.go:1081-1084's
 *   `/cargo` initialize/rebuild POSTs) is NOT RENDERED and NOT ROUTED: the
 *   cargo registry/index service has no landed substrate (no
 *   services/packages/cargo), so the buttons would be dead controls and
 *   the routes dead ends — the engine 404s the tails until that milestone.
 * - The kebab dropdown (list.tmpl's `ui dropdown tiny basic button`) is a
 *   JS Fomantic component — reduced to its two menu items as plain links in
 *   `.item-trailing` (the no-JS reduction, the admin-badges row-action
 *   posture). The title link AND the Edit link both ride the edit URL, as
 *   upstream renders both.
 * - The per-type `{{svg .Type.SVGName 32}}` leading glyph degrades to the
 *   shared octicon-package icon at 32px (the landed packages page's
 *   TypeLabel degradation — the SVGName map is unlanded).
 * - The type dropdown carries the FULL 23-value TypeList verbatim
 *   (AvailableTypes, shared/packages.go:53) — cargo included: a cargo RULE
 *   is fully functional substrate (it sweeps the owner's cargo packages —
 *   an empty set today, like any type with no packages); only the cargo
 *   REGISTRY arms are absent.
 * - The flash success/error lines are the no-session-flash reduction: the
 *   successes 303 silently; the already-exists error re-renders as the
 *   `.ui.negative.message` banner (the org blocked-users convention) with
 *   the Err_Type field class. The pure binding errors render ONLY the
 *   field classes (upstream renders no banner text for them).
 * - `StringUtils.EllipsisString`'s width-guessing port reduces to the
 *   ASCII rune cut (`ellipsisPattern` below) — the strings are regex
 *   sources, the landed posture's fixed-width assumption.
 * - The disabled checkbox/select pair relies on the plain-HTML form posts
 *   (no Fomantic JS): the unchecked checkbox posts nothing → false; the
 *   edit form's type select renders the `disabled` field class only, and
 *   the edit applier ignores the posted type regardless (upstream's shape).
 *
 * ## The mount posture + HANDOFF recipes (the shared files are NOT edited
 * by this unit — settings-nav.tsx and ui/index.ts)
 *
 * The module is COMMITTED-UNMOUNTED: every function is live and tested, the
 * route table and the shared nav carry the wiring handoffs below (the
 * org-settings-actions/blocked two-stage pattern). The nav below is the
 * The nav: the SHARED OrgSettingsNavbar with active="packages" (the local
 * scaffold was folded back at the mount window — the union gained
 * "packages" and the item renders between Blocked users and Actions)
 * (navbar.tmpl:23-27), the dead-link omission retired by THIS module's
 * landing. At the mount window:
 *
 *   1. settings-nav.tsx — add `"packages"` to `OrgSettingsNavTab`; add
 *      `packages: "Packages"` to `settingsNavLocale` (key "packages.title",
 *      navbar.tmpl:25); un-comment the Packages item between the blocked
 *      item (navbar.tmpl:20-22) and the Actions <details> (navbar.tmpl:28-48):
 *      `<a class={item("packages")} href={`${props.orgLink}/settings/packages`}>
 *      {settingsNavLocale.packages}</a>` and move the "(Packages :23-27
 *      dead)" comment onto this item; update the component's doc comment
 *      (item order line + the org-nav reduction list) and the
 *      `OrgSettingsNavTab` doc comment.
 *   2. ui/index.ts parseUiRoute (inside the `repo === "settings" &&
 *      owner.toLowerCase() !== "user"` block, alongside the runners arms —
 *      chi's static-first dispatch puts the `rules/add` literal AHEAD of the
 *      `{id}` combo, the reset_registration_token precedent):
 *
 *        if (raw.length === 4 && raw[3] === "packages") {
 *          return { family: "org-settings-packages", owner };
 *        }
 *        if (raw.length === 6 && raw[3] === "packages" && raw[4] === "rules" && raw[5] === "add") {
 *          return { family: "org-settings-packages-rule-add", owner };
 *        }
 *        if (raw.length === 6 && raw[3] === "packages" && raw[4] === "rules" && /^-?\d+$/.test(raw[5] as string)) {
 *          return { family: "org-settings-packages-rule-edit", owner, id: Number.parseInt(raw[5] as string, 10) };
 *        }
 *        if (raw.length === 7 && raw[3] === "packages" && raw[4] === "rules" && raw[6] === "preview" && /^-?\d+$/.test(raw[5] as string)) {
 *          return { family: "org-settings-packages-rule-preview", owner, id: Number.parseInt(raw[5] as string, 10) };
 *        }
 *
 *      plus the union entries (beside the other org-settings families):
 *
 *        | "org-settings-packages" // GET /{org}/settings/packages (the cleanup-rules list)
 *        | "org-settings-packages-rule-add" // GET+POST /{org}/settings/packages/rules/add
 *        | "org-settings-packages-rule-edit" // GET+POST /{org}/settings/packages/rules/{id}
 *        | "org-settings-packages-rule-preview" // GET /{org}/settings/packages/rules/{id}/preview
 *
 *   3. ui/index.ts handlers — the shared prologue exactly as the blocked/
 *      runners handlers compose it (import the module's exports beside the
 *      other page modules):
 *
 *        GET  list:    resolveOrgTeamsRequest → drift guard
 *                      (`org-settings-packages`) →
 *                      loadOrgPackagesSettingsPageData(c.env.DB, org) →
 *                      respond(c.html(renderOrgSettingsPackagesPage(...), 200)).
 *        GET  add:     same prologue →
 *                      renderOrgCleanupRuleEditPage with
 *                      orgCleanupRuleEditDataForAdd(org).
 *        POST add:     sameOriginGuard FIRST → the prologue →
 *                      viewer.kind !== "user" → the 404 shell →
 *                      parseOrgCleanupRuleForm(await readUrlEncodedForm(...))
 *                      → errors ? re-render
 *                      (orgCleanupRuleEditDataFromForm(org, false, parsed))
 *                      : applyOrgCleanupRuleCreate → "duplicate-type"
 *                      re-renders with errType + the banner text;
 *                      "created" 303s onto `/${org.username}/settings/
 *                      packages/rules/${ruleId}` (upstream :133).
 *        GET  edit:    prologue + drift guard (the edit family's id) →
 *                      loadOrgCleanupRuleEditPageData(c.env.DB, org, id) →
 *                      null ? the 404 shell : the render.
 *        POST edit:    sameOriginGuard FIRST → the prologue → parse →
 *                      `const ruleId = parsed.id !== 0 ? parsed.id : route.id`
 *                      (getCleanupRuleByContext's form-id-first precedence,
 *                      shared/packages.go:210-213) →
 *                      applyOrgCleanupRuleEdit(c.env.DB, org.id, ruleId,
 *                      parsed, new Date()): "missing" → the 404 shell;
 *                      "removed" → 303 onto `/${org.username}/settings/
 *                      packages`; "updated" → 303 onto the rule URL;
 *                      "invalid" → re-render via
 *                      loadOrgCleanupRuleEditPageData(c.env.DB, org, ruleId)
 *                      composed with the parsed values + errors (the DB row
 *                      is known to exist — the missing arm already ran).
 *        GET  preview: prologue + drift guard →
 *                      loadOrgCleanupRulePreview(c.env.DB, org, id) →
 *                      kind "missing" → the 404 shell; kind "ok" → the
 *                      render. GET ONLY — register
 *                      `uiRouter.post(...preview, () => methodNotAllowed("GET"))`
 *                      with every POST-only tail (chi's 405 twin).
 *
 *      registrations (beside the runners block — no earlier registration
 *      can absorb these: `settings` is the org block's static second
 *      segment and the `packages/rules` literals are deeper still):
 *
 *        uiRouter.get("/:owner/settings/packages", (c) => orgPackagesPage(c));
 *        uiRouter.post("/:owner/settings/packages", () => methodNotAllowed("GET"));
 *        uiRouter.get("/:owner/settings/packages/rules/add", (c) => orgPackagesRuleAddPage(c));
 *        uiRouter.post("/:owner/settings/packages/rules/add", (c) => orgPackagesRuleAddSubmit(c));
 *        uiRouter.get("/:owner/settings/packages/rules/:id", (c) => orgPackagesRuleEditPage(c, Number(c.req.param("id"))));
 *        uiRouter.post("/:owner/settings/packages/rules/:id", (c) => orgPackagesRuleEditSubmit(c, Number(c.req.param("id"))));
 *        uiRouter.get("/:owner/settings/packages/rules/:id/preview", (c) => orgPackagesRulePreviewPage(c, Number(c.req.param("id"))));
 *        uiRouter.post("/:owner/settings/packages/rules/:id/preview", () => methodNotAllowed("GET"));
 *
 *      The cargo tails (`/packages/cargo/initialize|rebuild`) stay
 *      UNREGISTERED (the engine's 404 — the module header's reduction).
 *      The preview loader's compile failure THROWS (upstream
 *      `ctx.ServerError("CompiledPattern")`, shared/packages.go:142-145) —
 *      the app-level onError answers it (src/index.ts:88); unreachable
 *      through this page's own forms (the write arms validate the compile)
 *      but honored for hand-seeded rows.
 *   4. tests — the mount window adds the route-level matrix (the
 *      blocked-users pattern): the anonymous 303, the member/non-member
 *      404 shells, the cross-origin 403 ahead of every write, the four
 *      parse claims + the junk-id/deeper-tail/user-namespace nulls and the
 *      cargo tails' engine 404s. The module-level battery below already
 *      covers every loader/apply/render arm.
 *
 * ## The user-scope twin (RECORDED, NOT BUILT — the brief's instruction)
 *
 * Upstream carries the USER-scope twin at the pin: `routers/web/web.go:
 * 701-719`'s `/user/settings/packages` group (identical rules/add|{id}|
 * preview + cargo shapes over `ctx.Doer`), served by
 * `routers/web/user/setting/packages.go` through the
 * `user/settings/packages*.tmpl` templates and the USER settings navbar's
 * Packages item (user/settings/navbar.tmpl:61-65). The shared settings-nav
 * renders that item DEAD today (its header's user-nav reduction list). A
 * future user-scope module reuses this one nearly whole (the owner input
 * swaps org→user; the URL base swaps onto /user/settings/packages).
 */

import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import {
  packageCleanupRules,
  packages,
  users,
} from "../../db/schema";
import {
  getPackageDescriptor,
  searchVersions,
  type PackageCleanupRuleRow,
  type PackageRow,
  type PackageVersionRow,
} from "../../services/packages/model";
import type { OrgRecord } from "../../services/orgs/orgs";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import { OrgSettingsNavbar } from "../components/settings-nav";
import { formatByteSize } from "../page-data";
import { userLink } from "../links";
import {
  PACKAGE_TYPES,
  absoluteShort,
  packageTypeName,
  packageVisibilityBadgeKind,
  versionWebLink,
} from "./packages";
import { OrgHeader } from "./org-home";

// ---------------------------------------------------------------------------
// Locale (the component-local pattern — every string cites its upstream key;
// values are the pin's locale_en-US.json English texts)
// ---------------------------------------------------------------------------

export const orgSettingsPackagesLocale = {
  title: "Packages", // "packages.title" (every handler's Title, setting_packages.go:24; the navbar item's text, navbar.tmpl:25)
  cleanup_rules_title: "Manage Cleanup Rules", // "packages.owner.settings.cleanuprules.title" (list.tmpl:2)
  add_rule: "Add Cleanup Rule", // "packages.owner.settings.cleanuprules.add" (list.tmpl:4, edit.tmpl:3's add arm)
  edit_rule: "Edit Cleanup Rule", // "packages.owner.settings.cleanuprules.edit" (edit.tmpl:3's edit arm)
  none: "No cleanup rules available. Please consult the documentation.", // "packages.owner.settings.cleanuprules.none" (list.tmpl's empty arm)
  preview: "Cleanup Rule Preview", // "packages.owner.settings.cleanuprules.preview" (the preview page's Title header + the menu/link items)
  preview_none: "Cleanup rule does not match any packages.", // "packages.owner.settings.cleanuprules.preview.none"
  enabled: "Enabled", // "enabled" (list.tmpl's Enabled/Disabled body + edit.tmpl's checkbox label)
  disabled: "Disabled", // "disabled"
  edit: "Edit", // "edit" (the kebab menu's item — rendered as the plain trailing link)
  type: "Type", // "packages.filter.type" (edit.tmpl:10's label)
  pattern_full_match: "Apply pattern to full package name", // "packages.owner.settings.cleanuprules.pattern_full_match"
  keep_title: "Versions that match these rules are kept, even if they match a removal rule below.", // "...cleanuprules.keep.title"
  keep_count: "Keep the most recent", // "...cleanuprules.keep.count"
  keep_count_1: "1 version per package", // "...cleanuprules.keep.count.1"
  keep_pattern: "Keep versions matching", // "...cleanuprules.keep.pattern"
  keep_pattern_container_prefix: "The", // "...keep.pattern.container" — "The <code>latest</code> version is always kept for Container packages." (the <code> markup splits the string)
  keep_pattern_container_suffix: " version is always kept for Container packages.",
  remove_title: "Versions that match these rules are removed, unless a rule above says to keep them.", // "...cleanuprules.remove.title"
  remove_days: "Remove versions older than", // "...cleanuprules.remove.days"
  remove_pattern: "Remove versions matching", // "...cleanuprules.remove.pattern"
  already_exists: "A cleanup rule for this package type already exists.", // "...cleanuprules.type.already_exists"
  admin_type: "Type", // "admin.packages.type" (preview.tmpl's headers)
  admin_name: "Name", // "admin.packages.name"
  admin_version: "Version", // "admin.packages.version"
  admin_creator: "Creator", // "admin.packages.creator"
  admin_size: "Size", // "admin.packages.size"
  admin_published: "Published", // "admin.packages.published"
  badge_internal: "Internal", // "repo.desc.internal" (visibility_badge.tmpl)
  badge_private: "Private", // "repo.desc.private"
  ghost: "Ghost", // user_model.GhostUserName — the missing-creator arm (descriptor.go:134-140's NewGhostUser; HomeLink "/Ghost")
} as const;

/** "...cleanuprules.keep.count.n" — "%d versions per package". */
export function cleanupRuleKeepCountN(count: number): string {
  return `${count} versions per package`;
}

/** "tool.days" — "%d days". */
export function cleanupRuleDays(days: number): string {
  return `${days} days`;
}

/** "...cleanuprules.preview.overview" — "%d packages are scheduled to be removed." */
export function cleanupRulePreviewOverview(count: number): string {
  return `${count} packages are scheduled to be removed.`;
}

// ---------------------------------------------------------------------------
// The pattern compile + the display ellipsis
// ---------------------------------------------------------------------------

/**
 * The anchored case-insensitive compile of upstream `(?i)\A…\z`
 * (package_cleanup_rule.go:41-54) — cleanup.ts:153's EXACT port shared by
 * the preview arm (the consumer keeps its private copy; the compile is
 * this module's local twin so the page and the sweep cannot drift).
 * Empty → null (no matcher); an un-compilable pattern → null (upstream
 * surfaces CompilePattern per rule and moves on — and the FORM arm rejects
 * it before insert, so only hand-seeded rows can carry one; the preview
 * loader turns null-with-nonempty into the ServerError throw).
 */
export function compileOrgCleanupRulePattern(pattern: string): RegExp | null {
  if (pattern === "") return null;
  try {
    return new RegExp(`^(?:${pattern})$`, "i");
  } catch {
    return null;
  }
}

/**
 * `StringUtils.EllipsisString(pattern, 100)` (list.tmpl's pattern bodies)
 * — util.EllipsisDisplayString's width-guessing port reduced to the ASCII
 * rune cut (the module header's reduction): at most `limit` runes with the
 * trailing "…", the unchanged string when it already fits.
 */
export function ellipsisPattern(pattern: string, limit: number): string {
  if (pattern.length <= limit) return pattern;
  return `${pattern.slice(0, limit - 1)}…`;
}

// ---------------------------------------------------------------------------
// The rules CRUD (package_cleanup_rule.go:56-100 — plain drizzle on the
// landed table; the owner-scope guard is the getCleanupRuleByContext pin)
// ---------------------------------------------------------------------------

/** `GetCleanupRulesByOwner` (:80-85) — the owner's rules, no ORDER BY
 *  (upstream Find's PK-order default). */
export async function listOrgCleanupRules(d1: D1Database, orgId: number): Promise<PackageCleanupRuleRow[]> {
  return drizzle(d1).select().from(packageCleanupRules).where(eq(packageCleanupRules.ownerId, orgId)).all();
}

/**
 * `getCleanupRuleByContext`'s resolution (shared/packages.go:209-232) at
 * this scope: GetCleanupRuleByID (:63-74) then the `pcr.OwnerID ==
 * owner.ID` pin — a missing, stale or foreign id answers null (the
 * ctx.NotFound arm). Non-positive ids never match (upstream's lookup
 * misses the same way).
 */
export async function findOrgScopedCleanupRule(d1: D1Database, orgId: number, ruleId: number): Promise<PackageCleanupRuleRow | null> {
  const rows = await drizzle(d1)
    .select()
    .from(packageCleanupRules)
    .where(and(eq(packageCleanupRules.id, ruleId), eq(packageCleanupRules.ownerId, orgId)))
    .limit(1);
  return rows[0] ?? null;
}

/** `HasOwnerCleanupRuleForPackageType` (:92-99) — the add arm's duplicate
 *  gate (the UNIQUE(owner_id,type) index is the DB-side backstop). */
export async function hasOrgCleanupRuleForType(d1: D1Database, orgId: number, type: string): Promise<boolean> {
  const rows = await drizzle(d1)
    .select({ id: packageCleanupRules.id })
    .from(packageCleanupRules)
    .where(and(eq(packageCleanupRules.ownerId, orgId), eq(packageCleanupRules.type, type)))
    .limit(1);
  return rows.length > 0;
}

/** The list page's data (SetPackagesContext, shared/packages.go:23-31). */
export interface OrgPackagesSettingsPageData {
  org: OrgRecord;
  rules: PackageCleanupRuleRow[];
}

export async function loadOrgPackagesSettingsPageData(d1: D1Database, org: OrgRecord): Promise<OrgPackagesSettingsPageData> {
  return { org, rules: await listOrgCleanupRules(d1, org.id) };
}

// ---------------------------------------------------------------------------
// The form (PackageCleanupRuleForm — services/forms/package_form.go — and
// the binding rules' exact outcomes)
// ---------------------------------------------------------------------------

/** The allowed sets (the binding `In(...)` lists, package_form.go). */
export const CLEANUP_RULE_KEEP_COUNTS: readonly number[] = [0, 1, 5, 10, 25, 50, 100];
export const CLEANUP_RULE_REMOVE_DAYS: readonly number[] = [0, 7, 14, 30, 60, 90, 180];

export interface OrgCleanupRuleFormValues {
  /** The hidden `id` input — the edit POST's id resolution reads it FIRST
   *  (getCleanupRuleByContext's FormInt64("id") arm, shared/packages.go:
   *  210-213); 0 on the add form. */
  id: number;
  enabled: boolean;
  type: string;
  keepCount: number;
  keepPattern: string;
  removeDays: number;
  removePattern: string;
  matchFullName: boolean;
  action: "save" | "remove";
}

/** The per-field binding-error flags — the template's Err_* arms (`id`
 *  has NO template arm: a malformed hidden id fails the binding upstream
 *  and only forces the re-render, so no class ever reads it). */
export type OrgCleanupRuleFormErrors = {
  id: boolean;
  action: boolean;
  type: boolean;
  keepCount: boolean;
  keepPattern: boolean;
  removeDays: boolean;
  removePattern: boolean;
};

export interface OrgCleanupRuleParsedForm {
  values: OrgCleanupRuleFormValues;
  errors: OrgCleanupRuleFormErrors;
  /** Any binding error at all (ctx.HasError). */
  invalid: boolean;
}

const CHECKED_VALUES = new Set(["on", "1", "true"]);

function parseCheckbox(params: URLSearchParams, name: string): boolean {
  const raw = params.get(name);
  return raw !== null && CHECKED_VALUES.has(raw.toLowerCase());
}

/**
 * The binding port: Required/In lists, the NON-ZERO RegexPattern rule
 * (validation/binding.go:80-88 — empty passes, non-empty must compile as a
 * bare RegExp), the checkbox bools (the landed deploy-keys posture with
 * the case-insensitive true-set), the ints via the strict integer regex
 * (absent → the zero value — upstream's decode leaves the zero; present
 * but not an integer → the binding error). Action is Required; the ADD
 * arm ignores it (the module header) but the binding still fails a
 * missing/foreign action exactly like upstream.
 */
export function parseOrgCleanupRuleForm(params: URLSearchParams): OrgCleanupRuleParsedForm {
  const errors: OrgCleanupRuleFormErrors = { id: false, action: false, type: false, keepCount: false, keepPattern: false, removeDays: false, removePattern: false };

  const rawId = params.get("id") ?? "";
  let id = 0;
  if (rawId !== "") {
    if (/^\d+$/.test(rawId)) id = Number.parseInt(rawId, 10);
    else errors.id = true; // a non-integer hidden id is the decode error; no template arm renders it
  }

  const actionRaw = params.get("action") ?? "";
  const action = actionRaw === "save" || actionRaw === "remove" ? actionRaw : null;
  if (action === null) errors.action = true;

  const type = params.get("type") ?? "";
  if (type === "" || !PACKAGE_TYPES.some((entry) => entry.type === type)) errors.type = true;

  const parseInInt = (name: string, allowed: readonly number[]): number | null => {
    const raw = params.get(name);
    if (raw === null) return 0; // absent → the zero value (valid in both In lists)
    if (!/^\d+$/.test(raw)) return null;
    const parsed = Number.parseInt(raw, 10);
    return allowed.includes(parsed) ? parsed : null;
  };
  const keepCount = parseInInt("keep_count", CLEANUP_RULE_KEEP_COUNTS);
  if (keepCount === null) errors.keepCount = true;
  const removeDays = parseInInt("remove_days", CLEANUP_RULE_REMOVE_DAYS);
  if (removeDays === null) errors.removeDays = true;

  const keepPattern = params.get("keep_pattern") ?? "";
  if (keepPattern !== "") {
    try {
      new RegExp(keepPattern);
    } catch {
      errors.keepPattern = true;
    }
  }
  const removePattern = params.get("remove_pattern") ?? "";
  if (removePattern !== "") {
    try {
      new RegExp(removePattern);
    } catch {
      errors.removePattern = true;
    }
  }

  return {
    values: {
      id,
      enabled: parseCheckbox(params, "enabled"),
      type,
      keepCount: keepCount ?? 0,
      keepPattern,
      removeDays: removeDays ?? 0,
      removePattern,
      matchFullName: parseCheckbox(params, "match_full_name"),
      action: action ?? "save",
    },
    errors,
    invalid: errors.id || errors.action || errors.type || errors.keepCount || errors.keepPattern || errors.removeDays || errors.removePattern,
  };
}

// ---------------------------------------------------------------------------
// The write arms (PerformRuleAddPost / PerformRuleEditPost — the module
// header carries the exact upstream orders; the caller gates on
// `parsed.invalid` before the save arms, the ctx.HasError shape)
// ---------------------------------------------------------------------------

export type OrgCleanupRuleCreateOutcome = { outcome: "created"; ruleId: number } | { outcome: "duplicate-type" };

/**
 * The ADD arm (performRuleEditPost with a nil rule, shared/packages.go:
 * 81-134): the type comes from the FORM (:113), the duplicate gate runs
 * (:115-123), then InsertCleanupRule (:126-129) and the caller redirects
 * onto `{base}/rules/{id}` (:133). `createdUnix`/`updatedUnix` are xorm's
 * `created`/`updated` stamps — both now.
 */
export async function applyOrgCleanupRuleCreate(d1: D1Database, orgId: number, values: OrgCleanupRuleFormValues, now: Date): Promise<OrgCleanupRuleCreateOutcome> {
  if (await hasOrgCleanupRuleForType(d1, orgId, values.type)) {
    return { outcome: "duplicate-type" };
  }
  const inserted = await drizzle(d1)
    .insert(packageCleanupRules)
    .values({
      enabled: values.enabled,
      ownerId: orgId,
      type: values.type,
      keepCount: values.keepCount,
      keepPattern: values.keepPattern,
      removeDays: values.removeDays,
      removePattern: values.removePattern,
      matchFullName: values.matchFullName,
      createdUnix: now,
      updatedUnix: now,
    })
    .returning({ id: packageCleanupRules.id })
    .all();
  const row = inserted[0];
  if (row === undefined) throw new Error("cleanup rule insert failed");
  return { outcome: "created", ruleId: row.id };
}

export type OrgCleanupRuleEditOutcome =
  | { outcome: "updated"; ruleId: number }
  | { outcome: "removed" }
  | { outcome: "missing" };

/**
 * The EDIT arm (PerformRuleEditPost, shared/packages.go:60-134): the
 * scoped resolution FIRST (a null rule is the NotFound arm — before the
 * action branch, :61-64), then `action === "remove"` deletes (:68-78 —
 * BEFORE the validation gate upstream, so the caller passes the parsed
 * form even when `invalid`), otherwise the field overwrite (:90-96 — Type
 * NOT among them: the row keeps its type) and UpdateCleanupRule
 * (:107-111) with the `updated` stamp refreshed.
 */
export async function applyOrgCleanupRuleEdit(d1: D1Database, orgId: number, ruleId: number, values: OrgCleanupRuleFormValues, now: Date): Promise<OrgCleanupRuleEditOutcome> {
  const rule = await findOrgScopedCleanupRule(d1, orgId, ruleId);
  if (rule === null) return { outcome: "missing" };
  if (values.action === "remove") {
    await drizzle(d1).delete(packageCleanupRules).where(eq(packageCleanupRules.id, rule.id));
    return { outcome: "removed" };
  }
  await drizzle(d1)
    .update(packageCleanupRules)
    .set({
      enabled: values.enabled,
      keepCount: values.keepCount,
      keepPattern: values.keepPattern,
      removeDays: values.removeDays,
      removePattern: values.removePattern,
      matchFullName: values.matchFullName,
      updatedUnix: now,
    })
    .where(eq(packageCleanupRules.id, rule.id));
  return { outcome: "updated", ruleId: rule.id };
}

// ---------------------------------------------------------------------------
// The edit page's data (SetRuleAddContext / SetRuleEditContext — the zero
// rule vs the scoped row; the invalid-POST re-render composes the same
// shape from the parsed form)
// ---------------------------------------------------------------------------

/** The form-echo shape the edit template renders (CleanupRule's fields the
 *  template reads). */
export interface OrgCleanupRuleFormView {
  id: number;
  enabled: boolean;
  type: string;
  matchFullName: boolean;
  keepCount: number;
  keepPattern: string;
  removeDays: number;
  removePattern: string;
}

export interface OrgCleanupRuleEditPageData {
  org: OrgRecord;
  isEditRule: boolean;
  rule: OrgCleanupRuleFormView;
  /** The duplicate-type arm's Err_Type (shared/packages.go:119). */
  errType: boolean;
  /** The binding-error field classes (the template's Err_* arms). */
  errors: OrgCleanupRuleFormErrors;
  /** The flash-error banner line (the already-exists text; the no-JS
   *  reduction — upstream carries it as a flash toast). */
  error: string | null;
}

function formViewOfRow(rule: PackageCleanupRuleRow): OrgCleanupRuleFormView {
  return {
    id: rule.id,
    enabled: rule.enabled,
    type: rule.type,
    matchFullName: rule.matchFullName,
    keepCount: rule.keepCount,
    keepPattern: rule.keepPattern,
    removeDays: rule.removeDays,
    removePattern: rule.removePattern,
  };
}

const EMPTY_ERRORS: OrgCleanupRuleFormErrors = { id: false, action: false, type: false, keepCount: false, keepPattern: false, removeDays: false, removePattern: false };

/** `SetRuleAddContext` (shared/packages.go:33-35 → setRuleEditContext(nil)) —
 *  the zero rule, add mode. */
export function orgCleanupRuleEditDataForAdd(org: OrgRecord): OrgCleanupRuleEditPageData {
  return {
    org,
    isEditRule: false,
    rule: { id: 0, enabled: false, type: "", matchFullName: false, keepCount: 0, keepPattern: "", removeDays: 0, removePattern: "" },
    errType: false,
    errors: { ...EMPTY_ERRORS },
    error: null,
  };
}

/** The invalid-POST re-render's echo (performRuleEditPost's ctx.Data arm,
 *  :98-105 — the submitted values ride back into the fields). */
export function orgCleanupRuleEditDataFromForm(
  org: OrgRecord,
  isEditRule: boolean,
  parsed: OrgCleanupRuleParsedForm,
  extra: { errType?: boolean; error?: string | null } = {},
): OrgCleanupRuleEditPageData {
  return {
    org,
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

/** `SetRuleEditContext` (shared/packages.go:37-44) — the scoped row; null
 *  is the NotFound arm. */
export async function loadOrgCleanupRuleEditPageData(d1: D1Database, org: OrgRecord, ruleId: number): Promise<OrgCleanupRuleEditPageData | null> {
  const rule = await findOrgScopedCleanupRule(d1, org.id, ruleId);
  if (rule === null) return null;
  return { org, isEditRule: true, rule: formViewOfRow(rule), errType: false, errors: { ...EMPTY_ERRORS }, error: null };
}

// ---------------------------------------------------------------------------
// The preview (SetRulePreviewContext, shared/packages.go:136-207 — the
// cleanup consumer's candidate ladder over searchVersions + descriptors)
// ---------------------------------------------------------------------------

/** The beyond-any-store limit standing in for upstream's paginator-less
 *  `Find` (package_version.go:323-327) — the org secrets/variables twins'
 *  documented seam. */
export const RULE_PREVIEW_VERSIONS_LIMIT = 10_000;

/** One preview table row (preview.tmpl's tbody cells). */
export interface OrgCleanupRulePreviewRow {
  pkg: PackageRow;
  version: PackageVersionRow;
  /** VersionWebLink (descriptor.go:90-92) — the anchor rides the LOWER
   *  name/version segments. */
  versionLink: string;
  /** The creator's username; null renders the Ghost cell (descriptor.go:
   *  134-140's NewGhostUser arm — creator_id 0 / a deleted user). */
  creatorName: string | null;
  /** CalculateBlobSize (:105-110) — the summed file-blob bytes, formatted. */
  sizeText: string;
}

export type OrgCleanupRulePreviewData =
  | { kind: "missing" }
  | { kind: "ok"; org: OrgRecord; rule: PackageCleanupRuleRow; rows: OrgCleanupRulePreviewRow[] };

/**
 * The GET-only preview arm. The rule resolves scope-guarded
 * (getCleanupRuleByContext → "missing"); a non-compilable stored pattern
 * THROWS (upstream `ctx.ServerError("CompiledPattern")`, :142-145 — the
 * app-level onError answers). Then exactly the cleanup consumer's ladder
 * (cleanup.ts:193-203; upstream preview :157-203 minus the container
 * ShouldBeSkipped arm — no container substrate, the sweep's v1 reduction):
 * per GetPackagesByType package (owner+type+is_internal=false,
 * package.go:298-303), the created-desc versions with the positional
 * keep-count trim, the keep-pattern skip, the remove-days cut and the
 * remove-pattern gate — each survivor assembled through
 * getPackageDescriptor for the table's size cell.
 */
export async function loadOrgCleanupRulePreview(d1: D1Database, org: OrgRecord, ruleId: number, now: Date = new Date()): Promise<OrgCleanupRulePreviewData> {
  const rule = await findOrgScopedCleanupRule(d1, org.id, ruleId);
  if (rule === null) return { kind: "missing" };

  const keepMatcher = compileOrgCleanupRulePattern(rule.keepPattern);
  const removeMatcher = compileOrgCleanupRulePattern(rule.removePattern);
  if ((rule.keepPattern !== "" && keepMatcher === null) || (rule.removePattern !== "" && removeMatcher === null)) {
    throw new Error(`cleanup rule ${rule.id}: stored pattern does not compile (upstream ServerError "CompiledPattern")`);
  }

  // GetPackagesByType (package.go:298-303) — the owner+type packages with
  // the is_internal pin (the sweep loop's shape + upstream's pin).
  const pkgs = await drizzle(d1)
    .select()
    .from(packages)
    .where(and(eq(packages.ownerId, rule.ownerId), eq(packages.type, rule.type), eq(packages.isInternal, false)))
    .all();

  const olderThan = new Date(now.getTime() - rule.removeDays * 24 * 60 * 60 * 1000);
  const rows: OrgCleanupRulePreviewRow[] = [];
  for (const pkg of pkgs) {
    // Upstream SearchVersions{PackageID, IsInternal: false, SortCreatedDesc}
    // (:158-162) through the landed searchVersions: the unique-key pin
    // (ownerId+type+exact lowerName) resolves the identical row set, the
    // created-desc/id-desc order is searchVersions' default, and the
    // paginator-less Find rides the beyond-any-store limit (the module
    // header's seam).
    const { rows: versions } = await searchVersions(d1, {
      ownerId: rule.ownerId,
      type: rule.type,
      name: pkg.lowerName,
      exact: true,
      excludeInternal: true,
      page: 1,
      limit: RULE_PREVIEW_VERSIONS_LIMIT,
    });
    // The positional keep-count trim (upstream pvs[KeepCount:], :167-173).
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
        versionLink: versionWebLink(org.username, pkg.type, pkg.lowerName, version.lowerVersion),
        creatorName: null,
        sizeText: formatByteSize(size),
      });
    }
  }

  // The Creator cells (descriptor.go's GetUserByID arm): the batched users
  // read; a missing row (creator_id 0 / deleted) renders Ghost.
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

  return { kind: "ok", org, rule, rows };
}

// ---------------------------------------------------------------------------
// The renders — org/settings/packages.tmpl (+ the edit/preview templates),
// all three `organization settings packages` (layout_head's pageClass dict)
// ---------------------------------------------------------------------------


/** The full-document render (the render.tsx pattern — index.ts stays a
 *  pure-TS router module). */
export function renderOrgSettingsPackagesPage(ctx: UiContext, data: OrgPackagesSettingsPageData): string {
  return renderPage(<OrgPackagesSettingsPage ctx={ctx} data={data} />);
}

/** The list page (packages.tmpl → cleanup_rules/list.tmpl). The cargo
 *  section is NOT rendered — no substrate, the module header's reduction. */
export function OrgPackagesSettingsPage(props: { ctx: UiContext; data: OrgPackagesSettingsPageData }) {
  const { ctx, data } = props;
  const base = `/${data.org.username}/settings/packages`;
  return (
    <BaseLayout ctx={ctx} title={orgSettingsPackagesLocale.title} pageClass="organization settings packages">
      <OrgHeader org={data.org} signedIn={ctx.viewer.kind === "user"} />
      <div class="ui container flex-container">
        <OrgSettingsNavbar orgLink={`/${data.org.username}`} active="packages" />
        <div class="flex-container-main">
          <div class="org-setting-content">
            {/* list.tmpl:1-5 — the header + the Add button. */}
            <h4 class="ui top attached header">
              {orgSettingsPackagesLocale.cleanup_rules_title}
              <div class="ui right">
                <a class="ui primary tiny button" href={`${base}/rules/add`}>
                  {orgSettingsPackagesLocale.add_rule}
                </a>
              </div>
            </h4>
            <div class="ui attached segment">
              <div class="flex-divided-list items-with-main">
                {data.rules.length === 0 ? (
                  <div class="item">{orgSettingsPackagesLocale.none}</div>
                ) : (
                  data.rules.map((rule) => (
                    <div class="item" key={rule.id}>
                      <div class="item-leading">
                        {/* {{svg .Type.SVGName 32}} — the octicon-package
                            degradation (the module header). */}
                        <Icon name="octicon-package" size={32} />
                      </div>
                      <div class="item-main">
                        <div class="item-title">
                          <a class="item" href={`${base}/rules/${rule.id}`}>
                            {packageTypeName(rule.type)}
                          </a>
                        </div>
                        <div class="item-body">
                          <i>{rule.enabled ? orgSettingsPackagesLocale.enabled : orgSettingsPackagesLocale.disabled}</i>
                        </div>
                        {rule.keepCount > 0 ? (
                          <div class="item-body">
                            <i>{orgSettingsPackagesLocale.keep_count}:</i>{" "}
                            {rule.keepCount === 1
                              ? orgSettingsPackagesLocale.keep_count_1
                              : cleanupRuleKeepCountN(rule.keepCount)}
                          </div>
                        ) : null}
                        {rule.keepPattern !== "" ? (
                          <div class="item-body">
                            <i>{orgSettingsPackagesLocale.keep_pattern}:</i> {ellipsisPattern(rule.keepPattern, 100)}
                          </div>
                        ) : null}
                        {rule.removeDays > 0 ? (
                          <div class="item-body">
                            <i>{orgSettingsPackagesLocale.remove_days}:</i> {cleanupRuleDays(rule.removeDays)}
                          </div>
                        ) : null}
                        {rule.removePattern !== "" ? (
                          <div class="item-body">
                            <i>{orgSettingsPackagesLocale.remove_pattern}:</i> {ellipsisPattern(rule.removePattern, 100)}
                          </div>
                        ) : null}
                      </div>
                      <div class="item-trailing">
                        {/* The kebab dropdown reduced to its two menu items
                            (list.tmpl's Edit + Preview) as plain links — the
                            no-JS reduction (the module header). */}
                        <a href={`${base}/rules/${rule.id}`}>{orgSettingsPackagesLocale.edit}</a>
                        <a href={`${base}/rules/${rule.id}/preview`}>{orgSettingsPackagesLocale.preview}</a>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
            {/* package/shared/cargo.tmpl: NOT RENDERED — no cargo substrate
                (the module header's documented dead-control reduction). */}
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}

/** The full-document render. */
export function renderOrgCleanupRuleEditPage(ctx: UiContext, data: OrgCleanupRuleEditPageData): string {
  return renderPage(<OrgCleanupRuleEditPage ctx={ctx} data={data} />);
}

/** The keep-count select's option list (edit.tmpl:24-33 — 0 renders an
 *  EMPTY label). */
const KEEP_COUNT_OPTIONS: readonly number[] = [0, 1, 5, 10, 25, 50, 100];
/** The remove-days select's option list (edit.tmpl:50-58 — 0 renders an
 *  EMPTY label). */
const REMOVE_DAYS_OPTIONS: readonly number[] = [0, 7, 14, 30, 60, 90, 180];

/** The add/edit page (packages_cleanup_rules_edit.tmpl →
 *  cleanup_rules/edit.tmpl). The form action is the page's OWN URL
 *  ({{.Link}} — ctx.Link is the request URI): `.../rules/add` or
 *  `.../rules/{id}`. */
export function OrgCleanupRuleEditPage(props: { ctx: UiContext; data: OrgCleanupRuleEditPageData }) {
  const { ctx, data } = props;
  const base = `/${data.org.username}/settings/packages`;
  const formAction = data.isEditRule ? `${base}/rules/${data.rule.id}` : `${base}/rules/add`;
  return (
    <BaseLayout ctx={ctx} title={orgSettingsPackagesLocale.title} pageClass="organization settings packages">
      <OrgHeader org={data.org} signedIn={ctx.viewer.kind === "user"} />
      <div class="ui container flex-container">
        <OrgSettingsNavbar orgLink={`/${data.org.username}`} active="packages" />
        <div class="flex-container-main">
          <div class="org-setting-content">
            <h4 class="ui top attached header">
              {data.isEditRule ? orgSettingsPackagesLocale.edit_rule : orgSettingsPackagesLocale.add_rule}
            </h4>
            <div class="ui attached segment">
              {/* The already-exists banner (the flash-error reduction — the
                  module header). */}
              {data.error !== null ? <div class="ui negative message">{data.error}</div> : null}
              <form class="ui form" action={formAction} method="post">
                <input type="hidden" name="id" value={String(data.rule.id)} />
                <div class="field">
                  <div class="ui checkbox">
                    <label>{orgSettingsPackagesLocale.enabled}</label>
                    <input type="checkbox" name="enabled" checked={data.rule.enabled ? true : undefined} />
                  </div>
                </div>
                {/* edit.tmpl:9-19 — the type field: `disabled` in edit mode
                    (the row keeps its type; the posted value is ignored),
                    the Err_Type error class on the duplicate arm. */}
                <div class={`${data.isEditRule ? "disabled " : ""}field ${data.errType ? "error" : ""}`}>
                  <label>{orgSettingsPackagesLocale.type}</label>
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
                    <label>{orgSettingsPackagesLocale.pattern_full_match}</label>
                    <input type="checkbox" name="match_full_name" checked={data.rule.matchFullName ? true : undefined} />
                  </div>
                </div>
                <div class="divider" />
                <p>{orgSettingsPackagesLocale.keep_title}</p>
                <div class={`field ${data.errors.keepCount ? "error" : ""}`}>
                  <label>{orgSettingsPackagesLocale.keep_count}:</label>
                  <select class="ui selection dropdown" name="keep_count">
                    {KEEP_COUNT_OPTIONS.map((count) => (
                      <option value={String(count)} selected={data.rule.keepCount === count ? true : undefined}>
                        {count === 0 ? "" : count === 1 ? orgSettingsPackagesLocale.keep_count_1 : cleanupRuleKeepCountN(count)}
                      </option>
                    ))}
                  </select>
                </div>
                <div class={`field ${data.errors.keepPattern ? "error" : ""}`}>
                  <label>{orgSettingsPackagesLocale.keep_pattern}:</label>
                  <input name="keep_pattern" type="text" value={data.rule.keepPattern} />
                  <p>
                    {orgSettingsPackagesLocale.keep_pattern_container_prefix} <code>latest</code>
                    {orgSettingsPackagesLocale.keep_pattern_container_suffix}
                  </p>
                </div>
                <div class="divider" />
                <p>{orgSettingsPackagesLocale.remove_title}</p>
                <div class={`field ${data.errors.removeDays ? "error" : ""}`}>
                  <label>{orgSettingsPackagesLocale.remove_days}:</label>
                  <select class="ui selection dropdown" name="remove_days">
                    {REMOVE_DAYS_OPTIONS.map((days) => (
                      <option value={String(days)} selected={data.rule.removeDays === days ? true : undefined}>
                        {days === 0 ? "" : cleanupRuleDays(days)}
                      </option>
                    ))}
                  </select>
                </div>
                <div class={`field ${data.errors.removePattern ? "error" : ""}`}>
                  <label>{orgSettingsPackagesLocale.remove_pattern}:</label>
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
                        {orgSettingsPackagesLocale.preview}
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

/** The visibility badge cell (package/shared/visibility_badge.tmpl — the
 *  internal/private/limited chain over the OWNER visibility; null renders
 *  nothing). */
function CleanupRuleVisibilityBadge(props: { kind: "internal" | "private" | null }) {
  if (props.kind === "internal") return <span class="ui basic label">{orgSettingsPackagesLocale.badge_internal}</span>;
  if (props.kind === "private") return <span class="ui basic label">{orgSettingsPackagesLocale.badge_private}</span>;
  return null;
}

/** The full-document render. */
export function renderOrgCleanupRulePreviewPage(ctx: UiContext, data: Extract<OrgCleanupRulePreviewData, { kind: "ok" }>): string {
  return renderPage(<OrgCleanupRulePreviewPage ctx={ctx} data={data} />);
}

/** The preview page (packages_cleanup_rules_preview.tmpl →
 *  cleanup_rules/preview.tmpl) — GET only (the module header). */
export function OrgCleanupRulePreviewPage(props: { ctx: UiContext; data: Extract<OrgCleanupRulePreviewData, { kind: "ok" }> }) {
  const { ctx, data } = props;
  return (
    <BaseLayout ctx={ctx} title={orgSettingsPackagesLocale.title} pageClass="organization settings packages">
      <OrgHeader org={data.org} signedIn={ctx.viewer.kind === "user"} />
      <div class="ui container flex-container">
        <OrgSettingsNavbar orgLink={`/${data.org.username}`} active="packages" />
        <div class="flex-container-main">
          <div class="org-setting-content">
            <h4 class="ui top attached header">{orgSettingsPackagesLocale.preview}</h4>
            <div class="ui attached segment">
              <p>{cleanupRulePreviewOverview(data.rows.length)}</p>
            </div>
            <div class="ui attached table segment">
              <table class="ui very basic table unstackable">
                <thead>
                  <tr>
                    <th>{orgSettingsPackagesLocale.admin_type}</th>
                    <th>{orgSettingsPackagesLocale.admin_name}</th>
                    <th>{orgSettingsPackagesLocale.admin_version}</th>
                    <th>{orgSettingsPackagesLocale.admin_creator}</th>
                    <th>{orgSettingsPackagesLocale.admin_size}</th>
                    <th>{orgSettingsPackagesLocale.admin_published}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.length === 0 ? (
                    <tr>
                      <td colspan={6}>{orgSettingsPackagesLocale.preview_none}</td>
                    </tr>
                  ) : (
                    data.rows.map((row, index) => (
                      <tr key={`${row.version.id}-${index}`}>
                        <td>{packageTypeName(row.pkg.type)}</td>
                        <td>
                          {row.pkg.name}
                          <span class="label-list">
                            <CleanupRuleVisibilityBadge kind={packageVisibilityBadgeKind(row.pkg, data.org.visibility)} />
                          </span>
                        </td>
                        <td>
                          <a href={row.versionLink}>{row.version.version}</a>
                        </td>
                        <td>
                          {/* The Ghost arm (descriptor.go:134-140) — a
                              missing creator renders the Ghost user's
                              HomeLink. */}
                          <a href={row.creatorName !== null ? userLink(row.creatorName) : `/${orgSettingsPackagesLocale.ghost}`}>
                            {row.creatorName ?? orgSettingsPackagesLocale.ghost}
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
