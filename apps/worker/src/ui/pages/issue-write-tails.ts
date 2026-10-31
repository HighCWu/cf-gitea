/**
 * The issue-family WRITE TAILS — census gaps #7+#8 (the milestone
 * close/open/delete web writes and the label-template initialize web
 * writes), upstream routers/web/web.go at the pin:
 *
 *   - POST /{owner}/{repo}/milestones/{id}/{action}  repo.ChangeMilestoneStatus
 *     (web.go:1429, the {open,close} action grammar, the write group's
 *     `reqRepoIssuesOrPullsWriter` gate)
 *   - POST /{owner}/{repo}/milestones/delete        repo.DeleteMilestone
 *     (web.go:1430, the form-borne `id`, the unlink cascade)
 *   - POST /{owner}/{repo}/labels/initialize        repo.InitializeLabels
 *     (web.go:1421, `web.Bind[*forms.InitializeLabelsForm]`)
 *   - POST /{org}/labels/initialize                 org.InitializeLabels
 *     (web.go:1048, the org twin — upstream nests it at
 *     /org/{org}/settings/labels/initialize under the require-owner group;
 *     the landed org labels page lives at the literal /{org}/labels, the
 *     org-labels module's documented divergence)
 *
 * This is the b91dd1c handoff pattern (pages/link-account-router.ts): the
 * index.ts router is owned by a flying sibling, so the four POST handlers
 * live HERE — self-contained (origin guard → session → repo/org resolution
 * → write gate → service seam → respond), JSX-free, and importing ONLY leaf
 * modules — while the index.ts recipe below is executed at the fold.
 *
 * ## Mount recipe (the exact hunks; positions beside the landed claims)
 *
 * 1. Import the handlers beside the other page-module imports:
 *
 *      import {
 *        milestoneActionSubmit,
 *        milestoneDeleteSubmit,
 *        repoLabelInitializeSubmit,
 *        orgLabelInitializeSubmit,
 *      } from "./pages/issue-write-tails";
 *
 * 2. `parseUiRoute`'s repo sub-path arm (`head === "milestones"`, currently
 *    ending at the `{id}/edit` combo): AFTER the edit arm add
 *
 *      // Census gap #7: the write tails (web.go:1429-1430 — the {id}/{action}
 *      // combo claims ANY action segment; the handler discriminates
 *      // open/close and redirects every other action untouched, exactly
 *      // upstream's JSONRedirect default arm). The static {id}/edit literal
 *      // keeps ranking first (chi static-before-param; the edit check above
 *      // precedes this arm identically).
 *      if (rest.length === 2) {
 *        let id: string;
 *        let action: string;
 *        try {
 *          id = decodeURIComponent(rest[0] as string);
 *          action = decodeURIComponent(rest[1] as string);
 *        } catch {
 *          return null;
 *        }
 *        return { family: "milestone-action", owner, repo, id, action };
 *      }
 *      if (rest.length === 1 && rest[0] === "delete") {
 *        return { family: "milestone-delete", owner, repo };
 *      }
 *
 *    and update that arm's header comment (the "remaining write tails ...
 *    stay engine-owned" sentence flips to the claimed-shape note).
 * 3. `parseUiRoute`'s repo labels arm (`rest[0] === "new" | "edit" |
 *    "delete"` block under `head === "labels"`): add
 *
 *      if (rest[0] === "initialize") return { family: "repo-label-initialize", owner, repo };
 *
 *    (web.go:1421; the deeper initialize tails stay engine-owned).
 * 4. `parseUiRoute`'s org labels arm (`repo === "labels"`, the 4-segment
 *    block): add
 *
 *      if (raw[3] === "initialize") return { family: "org-label-initialize", owner };
 *
 *    (web.go:1048's twin).
 * 5. The route unions: add `family: "milestone-action" | "milestone-delete"`
 *    (new `MilestoneWriteTailRoute` interface beside MilestoneEditRoute —
 *    `id`/`action` optional string members, the decoded segments) and
 *    extend the RepoLabelsRoute union with `"repo-label-initialize"` and
 *    the org union with `"org-label-initialize"`; refresh the three claim
 *    doc comments ("stays unclaimed → the engine's 404" sentences for
 *    /labels/initialize at the RepoLabels/OrgLabels interface docs and for
 *    /{id}/{action}+/delete at the MilestoneEditRoute doc).
 * 6. Register beside the landed write tails (static literals first, the
 *    dynamic :action last — chi's static-before-param rank mirrored; the
 *    current anchors: the repo-labels block ends at the
 *    `/:owner/:repo/labels/delete` GET-405 pair, the milestone block at the
 *    `/:owner/:repo/milestones/:id/edit` POST, the org block at the
 *    `/:owner/labels/delete` GET-405 pair):
 *
 *      uiRouter.get("/:owner/:repo/labels/initialize", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/labels/initialize", (c) => repoLabelInitializeSubmit(c));
 *      uiRouter.get("/:owner/:repo/milestones/delete", () => methodNotAllowed("POST"));
 *      uiRouter.post("/:owner/:repo/milestones/delete", (c) => milestoneDeleteSubmit(c));
 *      uiRouter.get("/:owner/:repo/milestones/:id/:action", (c) => milestoneActionSubmit(c));
 *      uiRouter.post("/:owner/:repo/milestones/:id/:action", (c) => milestoneActionSubmit(c));
 *
 *    (the repo lines after the landed `/:owner/:repo/labels/delete` GET-405
 *    pair — the wave-25 block; the milestone lines after the landed
 *    `/:owner/:repo/milestones/:id/edit` POST — the wave-26 block; the org
 *    line beside the landed org `/:owner/labels/{new,edit,delete}` POST
 *    registrations). Hono ranks the static `/milestones/:id/edit` over the
 *    dynamic `/:id/:action` regardless of order; the registered order keeps
 *    the doc honest.
 *
 * ## Pin lines that flip at THIS fold (test-side; edited at the fold, not
 *    here — this unit's tests stay green pre-fold by driving the handlers
 *    directly)
 *
 *    - apps/worker/src/ui/pages/milestones.matrix.test.tsx:866-868 — the
 *      `parseUiRoute("/octo/hello/milestones/7/delete")` /
 *      `handlesUiRoute("/octo/hello/milestones/7/delete")` /
 *      `parseUiRoute("/octo/hello/milestones/delete")` null pins (the
 *      describe block "the claim pins", first `it`) flip to the claimed
 *      families; the route-level 404 POST pin at :871 ("a live POST to the
 *      delete tail ...") flips to the write ladder's answers.
 *    - apps/worker/src/ui/pages/labels.matrix.test.tsx:409-421 — the
 *      "the /labels/initialize template-loader tail stays engine-owned on
 *      BOTH scopes (404)" pin flips: the repo POST answers the gate ladder
 *      (anonymous → the login 303), the org POST likewise (after the org
 *      resolve), and the GETs answer chi's 405.
 *    - apps/worker/src/ui/__tests__/pages-wave25.test.ts:245 and
 *      apps/worker/src/ui/__tests__/pages-wave14.test.ts:295-296 — the
 *      parse-level `parseUiRoute(...labels/initialize) → null` pins flip to
 *      the claimed families (the deeper initialize tails stay null).
 *    - apps/worker/src/ui/index.test.ts — NO pin flips: its only adjacent
 *      parse pin is line 291 `["/octo/hello/milestones/1", null]` (the
 *      single-segment tail), which stays null (upstream claims no
 *      single-segment milestone route either — /new is the literal, the
 *      writes are all 2-segment; the claimed shapes here are 2-segment
 *      {id}/{action} and the /delete literal). There are no
 *      /labels/initialize or deeper milestone-tail pins in that file.
 *
 * ## Behavior (upstream handlers at the pin, reduced to the landed posture)
 *
 * - The gates are the labels-write gate's exact order everywhere
 *   (upstream: reqSignIn + RepoMustNotBeArchived + reqRepoIssuesOrPullsWriter
 *   for the repo group, the require-owner org group for the org twin):
 *   anonymous → the login 303 (repo/org resolution FIRST — the invisible
 *   row never leaks through the redirect), an archived repo or a
 *   signed-in non-writer (org: non-owner) → the 404 shell.
 * - ChangeMilestoneStatus: the {open,close} switch FIRST-classifies the
 *   action; anything else redirects onto the bare list WITHOUT writing
 *   (upstream's JSONRedirect default arm — no 404). open/close resolve the
 *   milestone repo-scoped (PathParamInt64 parity — a non-numeric or foreign
 *   id 404-shells, milestone-detail.tsx's findRepoMilestoneById), flip the
 *   state through the landed IssuesService.updateMilestone ONLY when the
 *   state actually differs (upstream's `WHERE is_closed = {opposite}`
 *   0-row no-op guard — a repeated close keeps its closed_date stamp), and
 *   redirect onto `/milestones?state={action}` VERBATIM — including
 *   upstream's `?state=close` quirk (the list's parser reads
 *   `state == "closed"`, so a close lands on the OPEN tab; upstream
 *   web.go behavior IS the default decision, quirk carried and documented).
 * - DeleteMilestone: the form-borne `id` (FormInt64 parity — strict decimal
 *   or the never-matching 0, org-labels.tsx's formLabelId), the repo-scoped
 *   lookup, then the landed IssuesService.deleteMilestone (the unlink
 *   cascade: issues' milestone_id nulled, the row removed, the repo's
 *   num_milestones decremented). A missing/foreign/garbage id is the
 *   zero-row SUCCESS — upstream DeleteMilestoneByRepoID returns nil on
 *   ErrMilestoneNotExist and the handler flashes success unconditionally —
 *   answered as the same 303 onto the list (idempotent, the labels-delete
 *   convention). Upstream's error flash and success flash reduce away (the
 *   flash-less 303 posture).
 * - InitializeLabels: the form's `template_name` — empty is the binding's
 *   Required failure (upstream ctx.Redirect, no message) answered as the
 *   plain 303; an unknown name is upstream's ErrTemplateLoad flash arm
 *   answered as the 200 re-render of the labels list with the banner
 *   `Failed to load label template file "{name}": label template "{name}"
 *   not found` (the fail_to_load_file locale string over ErrTemplateLoad's
 *   OriginalError); a known name inserts the template's labels UNCONDITIONALLY
 *   (upstream NewLabel loop — plain inserts, duplicates coexist, the
 *   matrix's documented non-refusal) with name/exclusive/exclusive_order/
 *   description/color exactly as InitializeLabels copies them. The preset
 *   LIST is the pin's exact shipped set: options/label/ ships exactly two
 *   templates (Advanced.yaml + the extensionless Default), already embedded
 *   as parsed data in api/routes/misc-t2.ts (LABEL_TEMPLATES /
 *   LABEL_TEMPLATE_DISPLAY_NAMES — §8.2's single source, the admin-config
 *   import precedent; colors already NormalizeColor'd at embed time). The
 *   insert arm writes exclusiveOrder, which the landed createRepoLabel /
 *   createOrgLabel arms do not carry — hence the direct drizzle inserts
 *   here, the modules/repository/init.go InitializeLabels port (one
 *   db.batch, sequential statements = upstream's per-label insert order).
 *   Success redirects: repo → /{owner}/{repo}/labels (upstream's
 *   JSONRedirect/Redirect target), org → /{org}/labels (the landed page's
 *   live URL; upstream redirects onto /org/{org}/settings/labels — the
 *   org-labels divergence carried over, the same target every landed org
 *   label write 303s onto).
 *
 * ## The resolution prologue (the leaf-only duplication, link-account-router's
 *    documented posture)
 *
 * `resolveUiSession`/`resolveUiRequest`/`resolveOrgTeamsRequest` are
 * index.ts-internal; this module re-assembles their exact halves from the
 * same leaf modules (viewer.ts's resolveViewer, repo-view.ts's
 * resolveRepositoryForViewer, org-teams.tsx's resolveOrgTeamsOrg +
 * canManageOrgTeams, the manifest/demo/packages/notification leaves) so the
 * handlers answer byte-compatibly with the landed families (the re-render
 * arm carries the bell count, the unit toggles and the watch/star ctx) and
 * the test harness stays independent of the dispatcher's churn.
 */

import { Hono, type Context } from "hono";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import { LABEL_TEMPLATES, LABEL_TEMPLATE_DISPLAY_NAMES } from "../../api/routes/misc-t2";
import { loadRepoSettings } from "../../api/services/repo-settings";
import { getWatch } from "../../api/services/repo-watchers";
import { isStarring } from "../../api/services/stars";
import { labels } from "../../db/schema";
import { IssuesService } from "../../issues/service";
import type { OrgRecord } from "../../services/orgs/orgs";
import { demoModeEnabled } from "../../services/demo-sweep";
import { packagesQuotaFromEnv } from "../../services/packages/model";
import { readUrlEncodedForm } from "../forms";
import { AssetBuildError, loadManifest } from "../manifest";
import { renderNotFound } from "../render";
import { sameOriginGuard } from "../session";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";
import { resolveRepositoryForViewer } from "../repo-view";
import { resolveViewer, type Viewer } from "../viewer";
import { resolveOrgTeamsOrg, canManageOrgTeams } from "./org-teams";
import { findRepoMilestoneById, parseMilestoneId } from "./milestone-detail";
import { loadRepoLabelsData, renderRepoLabelsPage } from "./repo-labels";
import {
  formLabelId,
  loadOrgLabelsData,
  NEW_LABEL_DEFAULT_COLOR,
  renderOrgLabelsPage,
} from "./org-labels";
import { canWriteRepo } from "./file-editor";
import { countUnreadNotifications } from "./notifications";

type RouteContext = Context<{ Bindings: Env }>;

/** Page chrome text (component-local; the strings cite upstream's locale
 *  keys — the module doc carries the exact sources). */
export const issueWriteTailsLocale = {
  /** "repo.issues.label_templates.fail_to_load_file" — the %s/%v pair. */
  fail_to_load_file: (templateName: string, originalError: string): string =>
    `Failed to load label template file "${templateName}": ${originalError}`,
  /** ErrTemplateLoad.Error()'s OriginalError for the display-name miss
   *  (modules/label/parser.go:32-34's fmt.Errorf at init.go:151-153). */
  template_not_found: (templateName: string): string => `label template "${templateName}" not found`,
} as const;

/**
 * The template-loader dropdown's choice NAMES — the pin's exact shipped set
 * (options/label/: Advanced.yaml + Default), read from misc-t2's embedded
 * single source (the page components render the names; the descriptions are
 * the labels-joined strings upstream's JS dropdown shows — the native-select
 * reduction shows names only, the pages' module headers document it).
 */
export function labelTemplateChoices(): string[] {
  return [...LABEL_TEMPLATE_DISPLAY_NAMES];
}

// ---------------------------------------------------------------------------
// The initialize seams (modules/repository/init.go InitializeLabels' port)
// ---------------------------------------------------------------------------

export type InitializeLabelsResult = { outcome: "applied"; created: number } | { outcome: "unknown-template" };

/** The batch element type (api/services/issues.ts:1336's alias shape). */
type BatchStatement = Parameters<DrizzleD1Database["batch"]>[number][number];

/** One template label's insert shape (the LabelTemplateEntry already carries
 *  the normalized #rrggbb color). */
export interface LabelTemplateInsert {
  name: string;
  exclusive: boolean;
  exclusiveOrder: number;
  description: string;
  color: string;
}

/** The parsed template's labels, verbatim (the embed's optional fields
 *  collapse to the NewLabel defaults — exclusive false, order 0). */
export function templateLabelsFor(templateName: string): LabelTemplateInsert[] | null {
  const template = LABEL_TEMPLATES[templateName];
  if (template === undefined) return null;
  return template.labels.map((entry) => ({
    name: entry.name,
    exclusive: entry.exclusive ?? false,
    exclusiveOrder: entry.exclusiveOrder ?? 0,
    description: entry.description,
    color: entry.color,
  }));
}

/** The repo-scope insert (upstream InitializeLabels with isOrg=false —
 *  RepoID set, OrgID left at its 0 default; one sequential batch = the
 *  per-label NewLabel loop's order). */
export async function initializeRepoLabelsFromTemplate(
  d1: D1Database,
  repoId: string,
  templateName: string,
): Promise<InitializeLabelsResult> {
  const inserts = templateLabelsFor(templateName);
  if (inserts === null) return { outcome: "unknown-template" };
  if (inserts.length > 0) {
    const statements: BatchStatement[] = inserts.map((entry) =>
      drizzle(d1).insert(labels).values({
        repoId,
        name: entry.name,
        exclusive: entry.exclusive,
        exclusiveOrder: entry.exclusiveOrder,
        description: entry.description,
        color: entry.color,
      }),
    );
    await drizzle(d1).batch(statements as [BatchStatement, ...BatchStatement[]]);
  }
  return { outcome: "applied", created: inserts.length };
}

/** The org-scope insert (isOrg=true — OrgID set, repo_id NULL; the landed
 *  org-create arm's shape). */
export async function initializeOrgLabelsFromTemplate(
  d1: D1Database,
  orgId: number,
  templateName: string,
): Promise<InitializeLabelsResult> {
  const inserts = templateLabelsFor(templateName);
  if (inserts === null) return { outcome: "unknown-template" };
  if (inserts.length > 0) {
    const statements: BatchStatement[] = inserts.map((entry) =>
      drizzle(d1).insert(labels).values({
        repoId: null,
        orgId,
        name: entry.name,
        exclusive: entry.exclusive,
        exclusiveOrder: entry.exclusiveOrder,
        description: entry.description,
        color: entry.color,
      }),
    );
    await drizzle(d1).batch(statements as [BatchStatement, ...BatchStatement[]]);
  }
  return { outcome: "applied", created: inserts.length };
}

// ---------------------------------------------------------------------------
// The milestone seams (ChangeMilestoneStatus / DeleteMilestoneByRepoID)
// ---------------------------------------------------------------------------

export type MilestoneStatusResult = { outcome: "applied" } | { outcome: "missing" };

/**
 * ChangeMilestoneStatusByRepoIDAndID's port over the landed service: the
 * repo-scoped lookup (missing → the NotFound shell), then the state flip
 * ONLY when it differs — upstream's `WHERE repo_id = ? AND is_closed = ?`
 * update moves zero rows on a repeated close/open, keeping the stored
 * closed_date stamp and skipping the counter rewrite, while the handler
 * still answers success.
 */
export async function changeMilestoneStatus(
  d1: D1Database,
  repoId: string,
  id: number,
  toClose: boolean,
  now: Date = new Date(),
): Promise<MilestoneStatusResult> {
  const row = await findRepoMilestoneById(d1, repoId, id);
  if (row === null) return { outcome: "missing" };
  if (row.isClosed !== toClose) {
    await new IssuesService(d1).updateMilestone(row.id, { state: toClose ? "closed" : "open", now });
  }
  return { outcome: "applied" };
}

/**
 * DeleteMilestoneByRepoID's port: the repo-scoped lookup guards the cascade
 * (a foreign milestone id is invisible — upstream's miss), then the landed
 * IssuesService.deleteMilestone (issues unlinked, row removed, the repo's
 * num_milestones dropped, one batch). A missing id is the zero-row SUCCESS
 * (upstream returns nil on ErrMilestoneNotExist); the caller answers every
 * arm with the same redirect.
 */
export async function deleteMilestoneFromForm(
  d1: D1Database,
  repoId: string,
  id: number,
): Promise<{ outcome: "applied" }> {
  const row = await findRepoMilestoneById(d1, repoId, id);
  if (row !== null) {
    await new IssuesService(d1).deleteMilestone(row.id);
  }
  return { outcome: "applied" };
}

// ---------------------------------------------------------------------------
// The resolution prologue (resolveUiSession's leaf-only twin — the module
// header's duplication note; byte-compatible answers, dispatcher-free)
// ---------------------------------------------------------------------------

/** ui/index.ts's UiAssetsFetcher declared locally (the link-account-router
 *  posture — the test harness injects the synthetic manifest through it;
 *  the assetsBinding twin below keeps the module graph leaf-only). */
export interface TailAssetsFetcher {
  fetch(input: RequestInfo): Promise<Response>;
}

function assetsBinding(env: Pick<Env, "ASSETS">): TailAssetsFetcher | undefined {
  if ("ASSETS" in env) {
    const binding: unknown = env.ASSETS;
    if (typeof binding === "object" && binding !== null && "fetch" in binding) {
      return binding as TailAssetsFetcher;
    }
  }
  return undefined;
}

function assetsNotBuilt(error: AssetBuildError): Response {
  return new Response(`${error.message}\n`, {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

/** index.ts's loginRedirect verbatim (the SPEC-0010 §2.5 round-trip). */
function loginRedirect(requestUri: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `/login?redirect_to=${encodeURIComponent(requestUri)}` },
  });
}

interface ResolvedSession {
  ok: true;
  url: URL;
  ctx: UiContext;
  viewer: Viewer;
  respond: (res: Response) => Response;
}

/** The session half of resolveUiSession: viewer + manifest + bell count +
 *  the set-cookie-attaching respond (the §2.5 prologue composed from the
 *  same leaves; the notification read degrades to null exactly as there). */
async function resolveTailSession(c: RouteContext): Promise<ResolvedSession | { ok: false; response: Response }> {
  const url = new URL(c.req.url);
  let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined;
  }
  let ctx: UiContext;
  let setCookie: string | null = null;
  let viewer: Viewer;
  try {
    const [manifest, resolution] = await Promise.all([
      loadManifest(assetsBinding(c.env), url.origin),
      resolveViewer(c.env, c.req.raw, { waitUntil }),
    ]);
    setCookie = resolution.setCookie;
    viewer = resolution.viewer;
    let notificationCount: number | null = null;
    if (viewer.kind === "user") {
      try {
        notificationCount = await countUnreadNotifications(c.env.DB, viewer.id);
      } catch {
        notificationCount = null;
      }
    }
    ctx = {
      viewer: resolution.viewer,
      origin: url.origin,
      notificationCount,
      demoMode: demoModeEnabled(c.env),
      packagesEnabled: packagesQuotaFromEnv(c.env).packagesEnabled,
      assets: shellAssetsFromManifest(manifest),
    };
  } catch (error) {
    if (error instanceof AssetBuildError) return { ok: false, response: assetsNotBuilt(error) };
    throw error;
  }
  const respond = (res: Response): Response => {
    if (setCookie === null) return res;
    const headers = new Headers(res.headers);
    headers.append("set-cookie", setCookie);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
  return { ok: true, url, ctx, viewer, respond };
}

interface ResolvedRepoWrite {
  ok: true;
  url: URL;
  ctx: UiContext;
  viewer: Viewer;
  respond: (res: Response) => Response;
  repo: RepoRow;
}

/** The repo write prologue: session → §2.5 repo read → the ctx flags the
 *  landed pages' renders carry (unit toggles, watch/star). The WRITE GATE
 *  IS NOT HERE — the handlers apply it after the resolution (upstream's
 *  order: RepoAssignment resolves, then the writer middleware 404s). */
async function resolveRepoTail(c: RouteContext): Promise<ResolvedRepoWrite | { ok: false; response: Response }> {
  const session = await resolveTailSession(c);
  if (!session.ok) return session;
  const { url, ctx, viewer, respond } = session;
  const owner = c.req.param("owner");
  const repoName = c.req.param("repo");
  if (owner === undefined || repoName === undefined) return { ok: false, response: respond(await c.notFound()) };
  const repo = await resolveRepositoryForViewer(c.env, viewer, owner, repoName);
  if (repo === null) return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  ctx.repo = repo;
  const settings = await loadRepoSettings(c.env.DB, repo.id);
  ctx.repoHasProjects = settings.hasProjects;
  ctx.repoHasPackages = settings.hasPackages;
  ctx.repoHasActions = settings.hasActions;
  ctx.repoHasWiki = settings.hasWiki;
  if (viewer.kind === "user") {
    const [repoWatch, starring] = await Promise.all([
      getWatch(c.env.DB, repo.id, viewer.id),
      isStarring(c.env.DB, viewer.id, repo.id),
    ]);
    ctx.viewerRepoWatch = repoWatch;
    ctx.viewerStarsRepo = starring;
  }
  return { ok: true, url, ctx, viewer, respond, repo };
}

/** The repo labels-write gate verbatim (index.ts's repoLabelsWriteGate —
 *  anonymous → the login 303, archived or non-writer → the 404 shell). */
async function repoWriteGate(
  c: RouteContext,
  resolved: Extract<ResolvedRepoWrite, { ok: true }>,
): Promise<Response | null> {
  const { url, ctx, viewer, respond, repo } = resolved;
  if (viewer.kind === "anonymous") return respond(loginRedirect(url.pathname + url.search));
  if (repo.isArchived || !(await canWriteRepo(c.env, repo, viewer))) {
    return respond(c.html(renderNotFound(ctx), 404));
  }
  return null;
}

interface ResolvedOrgWrite {
  ok: true;
  url: URL;
  ctx: UiContext;
  viewer: Viewer;
  respond: (res: Response) => Response;
  org: OrgRecord;
}

/** The org write prologue (resolveOrgTeamsRequest's halves: the org resolve
 *  with the rename 307, then requireOrgOwnership as the login 303 + the
 *  owner gate). */
async function resolveOrgTail(c: RouteContext): Promise<ResolvedOrgWrite | { ok: false; response: Response }> {
  const session = await resolveTailSession(c);
  if (!session.ok) return session;
  const { url, ctx, viewer, respond } = session;
  const owner = c.req.param("owner");
  if (owner === undefined) return { ok: false, response: respond(await c.notFound()) };
  const doer = viewer.kind === "user" ? { id: viewer.id, isAdmin: viewer.isAdmin } : { id: null, isAdmin: false };
  const query = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const org = await resolveOrgTeamsOrg(c.env.DB, owner, doer, url.pathname, query);
  if (org.kind === "redirect") {
    return { ok: false, response: respond(new Response(null, { status: 307, headers: { location: org.location } })) };
  }
  if (org.kind === "missing") return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  if (viewer.kind === "anonymous") return { ok: false, response: respond(loginRedirect(url.pathname + url.search)) };
  if (!(await canManageOrgTeams(c.env.DB, org.org, viewer))) {
    return { ok: false, response: respond(c.html(renderNotFound(ctx), 404)) };
  }
  return { ok: true, url, ctx, viewer, respond, org: org.org };
}

// ---------------------------------------------------------------------------
// The four POST handlers
// ---------------------------------------------------------------------------

/**
 * POST /{owner}/{repo}/milestones/{id}/{action} (upstream
 * repo.ChangeMilestoneStatus, routers/web/repo/milestone.go:202-220): the
 * §2.8 Origin guard, the write gate, then the {open,close} switch — any
 * other action redirects onto the bare list untouched (upstream's
 * JSONRedirect default arm); open/close resolve repo-scoped (a
 * missing/foreign/garbage id 404-shells — upstream's ErrMilestoneNotExist
 * NotFound) and 303 onto `/milestones?state={action}` verbatim (upstream's
 * target, `?state=close` quirk included — the module header).
 */
export async function milestoneActionSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveRepoTail(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { respond, repo } = resolved;
  const action = c.req.param("action") ?? "";
  const listLink = `/${repo.ownerNamespace}/${repo.slug}/milestones`;
  let toClose: boolean;
  switch (action) {
    case "open":
      toClose = false;
      break;
    case "close":
      toClose = true;
      break;
    default:
      return respond(new Response(null, { status: 303, headers: { location: listLink } }));
  }
  const id = parseMilestoneId(c.req.param("id") ?? "");
  if (id === null) return respond(c.html(renderNotFound(resolved.ctx), 404));
  const result = await changeMilestoneStatus(c.env.DB, repo.id, id, toClose, new Date());
  if (result.outcome === "missing") return respond(c.html(renderNotFound(resolved.ctx), 404));
  return respond(new Response(null, { status: 303, headers: { location: `${listLink}?state=${encodeURIComponent(action)}` } }));
}

/**
 * POST /{owner}/{repo}/milestones/delete (upstream repo.DeleteMilestone,
 * routers/web/repo/milestone.go:222-230): the §2.8 Origin guard, the write
 * gate, then the form-borne `id` (FormInt64 parity) through the repo-scoped
 * cascade — SUCCESS either way, the same 303 onto the list (the module
 * header's idempotence note).
 */
export async function milestoneDeleteSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveRepoTail(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { respond, repo } = resolved;
  const params = await readUrlEncodedForm(c.req.raw);
  await deleteMilestoneFromForm(c.env.DB, repo.id, formLabelId(params.get("id")));
  return respond(
    new Response(null, { status: 303, headers: { location: `/${repo.ownerNamespace}/${repo.slug}/milestones` } }),
  );
}

/**
 * POST /{owner}/{repo}/labels/initialize (upstream repo.InitializeLabels,
 * routers/web/repo/issue_label.go:40-58): the §2.8 Origin guard, the write
 * gate, then the InitializeLabelsForm's `template_name` — empty is the
 * binding's Required failure (the plain 303), unknown the ErrTemplateLoad
 * arm (the 200 re-render with the fail_to_load_file banner), known the
 * unconditional preset insert and the 303 onto the list.
 */
export async function repoLabelInitializeSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveRepoTail(c);
  if (!resolved.ok) return resolved.response;
  const gate = await repoWriteGate(c, resolved);
  if (gate !== null) return gate;
  const { ctx, respond, repo, viewer } = resolved;
  const params = await readUrlEncodedForm(c.req.raw);
  const templateName = params.get("template_name") ?? "";
  if (templateName === "") {
    return respond(
      new Response(null, { status: 303, headers: { location: `/${repo.ownerNamespace}/${repo.slug}/labels` } }),
    );
  }
  const result = await initializeRepoLabelsFromTemplate(c.env.DB, repo.id, templateName);
  if (result.outcome === "applied") {
    return respond(
      new Response(null, { status: 303, headers: { location: `/${repo.ownerNamespace}/${repo.slug}/labels` } }),
    );
  }
  const data = await loadRepoLabelsData(c.env, c.env.DB, repo, viewer, new URLSearchParams());
  return respond(
    c.html(
      renderRepoLabelsPage({
        ctx,
        data,
        form: { title: "", color: NEW_LABEL_DEFAULT_COLOR },
        error: issueWriteTailsLocale.fail_to_load_file(templateName, issueWriteTailsLocale.template_not_found(templateName)),
      }),
      200,
    ),
  );
}

/**
 * POST /{org}/labels/initialize (upstream org.InitializeLabels,
 * routers/web/org/org_labels.go:97-116 over the landed org-labels page's
 * URL): the require-owner ladder, then the same template seam — the 303
 * target is the landed page's /{org}/labels (the org divergence, the module
 * header).
 */
export async function orgLabelInitializeSubmit(c: RouteContext): Promise<Response> {
  const guard = sameOriginGuard(c.req.raw);
  if (guard !== null) return guard;
  const resolved = await resolveOrgTail(c);
  if (!resolved.ok) return resolved.response;
  const { ctx, respond, org } = resolved;
  const params = await readUrlEncodedForm(c.req.raw);
  const templateName = params.get("template_name") ?? "";
  if (templateName === "") {
    return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/labels` } }));
  }
  const result = await initializeOrgLabelsFromTemplate(c.env.DB, org.id, templateName);
  if (result.outcome === "applied") {
    return respond(new Response(null, { status: 303, headers: { location: `/${org.username}/labels` } }));
  }
  const data = await loadOrgLabelsData(c.env.DB, org, new URLSearchParams());
  return respond(
    c.html(
      renderOrgLabelsPage({
        ctx,
        data,
        form: { title: "", color: NEW_LABEL_DEFAULT_COLOR },
        error: issueWriteTailsLocale.fail_to_load_file(templateName, issueWriteTailsLocale.template_not_found(templateName)),
      }),
      200,
    ),
  );
}

// ---------------------------------------------------------------------------
// The fold-time router (the recipe step 6 assembled — the direct-test
// harness's subject AND a mount-ready sub-app if the orchestrator prefers
// `uiRouter.route("/", tailsRouter)` to the eight explicit registrations;
// the explicit-registration form is the recipe's primary — the landed
// families all register their lines inline).
// ---------------------------------------------------------------------------

/** chi's 405 (index.ts's methodNotAllowed twin — that one is internal;
 *  this module's carries the same empty body + allow header). */
function methodNotAllowedTail(allow: string): Response {
  return new Response(null, { status: 405, headers: { allow } });
}

/** All four tails on one sub-app, registered exactly as the recipe's step 6
 *  (static literals before the dynamic :action pattern; the org pair's
 *  3-segment shape never collides with the repo trio's 4-segment one). */
export function createIssueWriteTailsRouter(): Hono<{ Bindings: Env }> {
  const router = new Hono<{ Bindings: Env }>();
  router.get("/:owner/labels/initialize", () => methodNotAllowedTail("POST"));
  router.post("/:owner/labels/initialize", (c) => orgLabelInitializeSubmit(c));
  router.get("/:owner/:repo/labels/initialize", () => methodNotAllowedTail("POST"));
  router.post("/:owner/:repo/labels/initialize", (c) => repoLabelInitializeSubmit(c));
  router.get("/:owner/:repo/milestones/delete", () => methodNotAllowedTail("POST"));
  router.post("/:owner/:repo/milestones/delete", (c) => milestoneDeleteSubmit(c));
  router.get("/:owner/:repo/milestones/:id/:action", () => methodNotAllowedTail("POST"));
  router.post("/:owner/:repo/milestones/:id/:action", (c) => milestoneActionSubmit(c));
  return router;
}
