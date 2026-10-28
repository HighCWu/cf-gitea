/**
 * The repository-migration page, `/repo/migrate` — the M-bench migrate row
 * (MOUNTED at 62ef380, window-2e C3a — the route lives in `index.ts`; the
 * retired wiring HANDOFF is the mount record below). Upstream
 * `repo.Migrate` / `repo.MigratePost` (routers/web/repo/migrate.go:38-66,
 * 134-225) over `templates/repo/migrate/git.tmpl` at the pin — the service
 * "Git" VARIANT, because the landed migrate surface accepts `service` unset
 * or "git" only (SPEC-0009 §2.2; anything else is the 422 "unsupported
 * service" family) — posting through the LANDED server-driven migrate arm
 * (`migrateRepository` + `resolveMigrateOwner`, services/migrate.ts, the
 * POST /repos/migrate contract path's own service; SPEC-0009 §2.2).
 *
 * ## DOM contract (templates/repo/migrate/git.tmpl + its partials at the pin)
 *
 * `.page-content.repository new migrate` (git.tmpl:2), one
 * `.ui.container.medium-width` (git.tmpl:3) holding the `.ui.top.attached.header`
 * (Tr "repo.migrate.migrate" "Git" — "Migrate From Git"; the BaseLayout title
 * is upstream's separate `ctx.Data["Title"]` = Tr "new_migrate" = "New
 * Migration", which feeds upstream's `<title>` AND the role=main aria-label)
 * + the `.ui.attached.segment` with the upstream
 * `<form class="ui form left-right-form" action="{.Link}" method="post">`
 * (the `form-fetch-action` class is reduced out — the landed no-JS form
 * convention, the create-form precedent). Field order follows the template
 * composition git.tmpl:10-32:
 *
 *   common-init      the `<input type="hidden" name="service" value="git">`
 *                    (the `data-global-init` JS hook reduced out — no-JS)
 *   git.tmpl         `clone_addr` (required, autofocus) with the
 *                    clone_address_desc help; `auth_username`; `auth_password`
 *                    (type=password)
 *   common-options   the `mirror` checkbox ("This repository will be a
 *                    mirror") — upstream's `DisableNewPullMirrors` gate has no
 *                    landed flag, so the box renders always
 *   divider
 *   common-migrated-repo  the owner field (`uid` — upstream's hidden-input
 *                    Fomantic dropdown reduced to the native `<select>`, the
 *                    repo-create precedent), the required `repo_name` input
 *                    (maxlength 100 — the MigrateRepoForm binding
 *                    `Required;AlphaDashDot;MaxSize(100)`), the `private`
 *                    visibility checkbox, the `description` textarea
 *                    (maxlength 2048), and the primary submit
 *                    ("repo.migrate_repo" — "Migrate Repository")
 *
 * ## The our-surface matrix (rendered vs documented-reduced)
 *
 * The form mirrors the LANDED migrate body (routes/mirror.ts's
 * `migrateRepoMigrateSchema` + services/migrate.ts's `ServerMigrateOptions`)
 * honestly — upstream form fields we do not accept stay unrendered, and
 * landed fields upstream's Git template does not render stay unrendered too:
 *
 *   rendered   clone_addr (required), auth_username, auth_password, mirror
 *              (always true on submit — below), service (hidden "git"), uid
 *              (owner select), repo_name (required), private, description
 *   reduced    auth_token — accepted by the landed body but not in the
 *              upstream Git template's DOM (the token field belongs to the
 *              github/gitlab variants); the structured username/password
 *              fields are the form's credential surface
 *   reduced    lfs / lfs_endpoint — accepted-and-stored by the landed body but
 *              inert until the SPEC-0006 LFS client extension lands (§2.2);
 *              upstream renders the checkbox only under `LFSActive`
 *              (setting.LFS.StartServer) — no active store, no checkbox
 *   reduced    mirror_interval — accepted by the landed body (Go-duration,
 *              §2.2 row 6) but NOT in the upstream migrate form's DOM (it is
 *              a mirror-settings field, added after creation); the service
 *              default (8h) applies
 *   reduced    wiki/issues/milestones/labels/pull_requests/releases —
 *              accepted by the landed body (zeroed for mirror=true per
 *              upstream migrate.go:159-166, 422 when true non-mirror) but not
 *              in the Git template's DOM (plain-git migration carries no
 *              metadata); absent form fields parse as false
 *   reduced    aws_access_key_id / aws_secret_access_key — the
 *              MigrateRepoForm's CodeCommit-variant fields
 *              (services/forms/repo_form.go:75-76); the landed body does not
 *              accept them and the "git" variant template never rendered them
 *   reduced    the `clone_local_path` help tail and every non-"git" service
 *              picker entry — the landed §2.2 shape is https-only
 *              (checkMirrorSourceUrl rejects file:// and userinfo URLs), so
 *              the "or a local server path" help text would be false
 *
 * ## The arm posture (the one honest degradation)
 *
 * Upstream's web migrate runs the whole migration server-side
 * (task.MigrateRepository, the queued-task model). The landed server-driven
 * arm splits on `mirror`: mirror=true is SELF-DRIVING — the repo is born
 * ready+empty with the mirror row due now and the initial population IS the
 * one best-effort enqueued mirror-sync (SPEC-0009 §2.6 queue semantics) —
 * while mirror=false bootstraps the CHUNKED import channel whose pack uploads
 * are the API caller's to drive (the one-time import token in the 201's
 * documented `import` extension). A browser form has no chunk uploader, so a
 * mirror=false submission would strand the born row `migrating` forever. The
 * form therefore renders the mirror checkbox CHECKED and the write RE-RENDERS
 * a mirror=false submission with the degradation note (the never-strand rule;
 * non-mirror imports remain the POST /repos/migrate API surface). Success
 * redirects onto the new repo's home — upstream's
 * `ctx.JSONRedirect(ctxUser.HomeLink() + "/" + PathEscape(opts.RepoName))`
 * — where the enqueued sync populates the mirror.
 *
 * ## Gates
 *
 * - Login (upstream's reqSignIn group, web.go:1094-1102): route-arm owned —
 *   an anonymous viewer 303s onto the login round-trip; the module's loader
 *   requires a user viewer and 404-shells a session principal without a D1
 *   row (the silent-auth-failure convention).
 * - The repo-creation permission family: the owner dropdown carries the doer
 *   plus the orgs the WRITE accepts — the landed `resolveMigrateOwner` is
 *   org-OWNER strict (`isOrgOwner`, the upstream API arm's migrate.go:82-99
 *   rule), deliberately narrower than repo-create's `canCreateOrgRepo` team
 *   arm (upstream's web arm shares checkContextUser with create; ours cannot
 *   offer an org the write would 403). Site admins pass every membership
 *   (the caller-level admin bypass, resolveMigrateOwner's `!doer.isAdmin`
 *   guard). The write re-gates every submission through resolveMigrateOwner,
 *   so a forged/tampered uid re-renders upstream's exact API-arm texts
 *   ("Given user is not an organization." / "Given user is not owner of
 *   organization." / "user does not exist [name: x]") instead of a bare
 *   StatusForbidden page.
 *
 * ## POST flow + error re-render shape
 *
 * The write maps the landed service's typed error family onto the login
 * failure convention (re-render at 200 with the message and the submitted
 * values; the create-form precedent): empty clone_addr / repo_name re-render
 * the cf-gitea required-field texts (the HTML5 `required` catches browsers),
 * the 409 collision renders upstream's WEB text ("form.repo_name_been_taken"
 * — handleMigrateError's IsErrRepoAlreadyExist arm), the 403/422 ApiError
 * family and the MirrorValidationError family render their messages VERBATIM
 * (upstream's web arm answers unknown errors with JSONErrorAuto(err) — the
 * raw error text — so the landed API-arm texts are exactly upstream's web
 * shape), and the MIRROR_CREDENTIAL_KEY misconfiguration renders its message
 * (deterministic and pre-birth by the §4.2 fail-fast preflight, so nothing is
 * stranded). Engine transport failures propagate (retryable-unknown state is
 * never a form error). Webhook: the write fans out the SAME single
 * `repository` "created" event the API arm's finalize step emits
 * (routes/mirror.ts — the ONE birth emission; services/migrate.ts is silent
 * by design), Sender the migrating doer, through the shared repo-events seam.
 *
 * ## Mount record (MOUNTED at 62ef380 — the wiring HANDOFF is retired)
 *
 * The route arm maps onto this module as: the parser family `repo-migrate` —
 * the exact literal `raw.length === 3 && raw[1] === "repo" && raw[2] ===
 * "migrate"` claimed BESIDE the wave-19 `repo-create` literal (same shadowing
 * posture: upstream's /repo group registers ahead of the dynamic pairs,
 * web.go:1100-1101, so a repository named "migrate" under an owner named
 * "repo" is shadowed identically) — holding `{ family: "repo-migrate" }`.
 * The handler pair:
 *
 * 1. GET: `resolveUiSession` → anonymous = `loginRedirect(url.pathname)`;
 *    `loadRepoMigrateData` null = the 404 shell; `?org=` preselects an
 *    ALLOWED owner id (the repoCreatePage convention — anything else falls
 *    back to the doer) and `?mirror=` truthy prechecks the box (upstream
 *    Migrate's FormBool, the gogs#2037 org-home deep link); renders
 *    `renderRepoMigratePage` with the GET defaults: cloneAddr "" ,
 *    repoName "" , description "", isPrivate CHECKED (the create form's
 *    DefaultPushCreatePrivate stand-in), mirror CHECKED (the supported arm).
 * 2. POST: `sameOriginGuard` → the same session/loader order →
 *    `parseRepoMigrateForm(readUrlEncodedForm(c.req.raw))` →
 *    `migrateRepoFromForm(c.env, c.env.DB, viewer, data, form, { request: c,
 *    origin: ctx.origin })` → created = 303 onto
 *    `/{ownerNamespace}/{slug}`; invalid = re-render at 200 with the message
 *    and the submitted values (the login failure convention).
 */

import {
  apiUserFromRow,
  findRepositoryById,
  type Viewer as ApiViewer,
} from "../../api/services/repository";
import { findDoerRow } from "../../api/services/user-repos";
import { ApiError } from "../../api/errors";
import {
  MirrorCredentialKeyError,
  MirrorValidationError,
} from "../../api/services/mirror";
import {
  migrateRepository,
  resolveMigrateOwner,
  type MigrateEnv,
  type ServerMigrateOptions,
} from "../../services/migrate";
import {
  emitRepoEvent,
  repositoryEventIdentity,
  repositoryEventPayload,
  type RepoEventRequest,
} from "../../services/repo-events";
import { OrgService } from "../../services/orgs/orgs";
import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import type { users } from "../../db/schema";

/** Page chrome text (component-local, the repoCreateLocale pattern — locale.ts
 *  is shared and not this wave's file). */
export const repoMigrateLocale = {
  /** The <title>/aria-label part — upstream's `ctx.Data["Title"]`
   *  (Tr "new_migrate"; module header). */
  title: "New Migration",
  /** The H3 header — Tr "repo.migrate.migrate" with the "Git" service Title. */
  header: "Migrate From Git", // "repo.migrate.migrate" %s "Git"
  clone_address: "Migrate / Clone From URL", // "repo.migrate.clone_address"
  clone_address_desc:
    "The HTTP(S) or Git 'clone' URL of an existing repository", // "repo.migrate.clone_address_desc"
  username: "Username", // "username"
  password: "Password", // "password"
  migrate_options: "Migration Options", // "repo.migrate_options"
  mirror_helper: "This repository will be a mirror", // "repo.migrate_options_mirror_helper"
  owner: "Owner", // "repo.owner"
  repo_name: "Repository Name", // "repo.repo_name"
  visibility: "Visibility", // "repo.visibility"
  visibility_helper: "Make repository private", // "repo.visibility_helper"
  repo_desc: "Description", // "repo.repo_desc"
  migrate_repo: "Migrate Repository", // "repo.migrate_repo"
  /** The empty-clone-URL re-render — cf-gitea addition (the required-field
   *  precedent; the HTML5 `required` catches the browser case). */
  clone_addr_required: "A clone URL is required.",
  /** The empty-name re-render — cf-gitea addition (the repo-create
   *  name_required precedent). */
  name_required: "A repository name is required.",
  /** The taken-name re-render — upstream's WEB text
   *  ("form.repo_name_been_taken", handleMigrateError's IsErrRepoAlreadyExist
   *  arm) standing in for the service's 409 body text. */
  name_taken: "The repository name is already used.",
  /** The mirror=false re-render — the one honest degradation (module header):
   *  the chunked import channel is a machine-caller surface, so the web form
   *  never submits a non-mirror migration. */
  mirror_required:
    "Web migrations run as pull mirrors; non-mirror imports use the chunked import API.",
} as const;

/** The owner-option cap (one page read; the repo-create picker-limit
 *  precedent — upstream's dropdown pages through the JS path). */
export const REPO_MIGRATE_ORG_LIMIT = 100;

// ---------------------------------------------------------------------------
// Data loading (the creation-family convention — direct service calls)
// ---------------------------------------------------------------------------

/** One owner-dropdown entry: the doer (kind "user") or an org the migrate
 *  write accepts (kind "org"). */
export interface RepoMigrateOwner {
  id: number;
  username: string;
  kind: "user" | "org";
}

/** The form's render inputs: the doer row (the write's doer projection
 *  source) plus the owner options. */
export interface RepoMigrateData {
  doer: typeof users.$inferSelect;
  owners: RepoMigrateOwner[];
}

/**
 * Load the form data: the doer row (a session principal without a D1 row is
 * the silent-auth-failure convention → the caller 404-shells) and the owner
 * options — the doer plus the doer's org memberships that pass the WRITE's
 * own predicate (`isOrgOwner`, the module-header gate note; site admins pass
 * every membership — resolveMigrateOwner's caller-level bypass).
 */
export async function loadRepoMigrateData(d1: D1Database, viewer: Viewer): Promise<RepoMigrateData | null> {
  if (viewer.kind !== "user") throw new Error("loadRepoMigrateData requires a signed-in viewer");
  const doer = await findDoerRow(d1, { id: viewer.id });
  if (doer === null) return null;
  const orgs = new OrgService(d1);
  const memberships = await orgs.listUserOrgs(doer.id, {
    maxVisibility: "private",
    page: 1,
    pageSize: REPO_MIGRATE_ORG_LIMIT,
  });
  const owners: RepoMigrateOwner[] = [{ id: doer.id, username: doer.username, kind: "user" }];
  for (const org of memberships.items) {
    if (doer.isAdmin || (await orgs.isOrgOwner(org.id, doer.id))) {
      owners.push({ id: org.id, username: org.username, kind: "org" });
    }
  }
  return { doer, owners };
}

// ---------------------------------------------------------------------------
// Form parsing + the write (the landed server-driven migrate arm directly)
// ---------------------------------------------------------------------------

/** The parsed `application/x-www-form-urlencoded` submission. `uid` is the
 *  owner field: absent/empty (and any non-numeric garbage) means the doer —
 *  upstream FormInt64's zero falls through checkContextUser to the doer. The
 *  reduced fields (module-header matrix) are not parsed: a forged extra field
 *  is simply not part of the option shape the write builds. */
export interface RepoMigrateForm {
  uid: number | null;
  cloneAddr: string;
  authUsername: string;
  authPassword: string;
  repoName: string;
  description: string;
  isPrivate: boolean;
  mirror: boolean;
}

/** Parse the POST body (the parseRepoCreateForm conventions: trim the
 *  name/URL, the checkboxes are field-present rules, the password keeps its
 *  bytes verbatim). */
export function parseRepoMigrateForm(params: URLSearchParams): RepoMigrateForm {
  const uidRaw = (params.get("uid") ?? "").trim();
  return {
    uid: /^\d+$/.test(uidRaw) ? Number.parseInt(uidRaw, 10) : null,
    cloneAddr: (params.get("clone_addr") ?? "").trim(),
    authUsername: params.get("auth_username") ?? "",
    authPassword: params.get("auth_password") ?? "",
    repoName: (params.get("repo_name") ?? "").trim(),
    description: params.get("description") ?? "",
    isPrivate: (params.get("private") ?? "") !== "",
    mirror: (params.get("mirror") ?? "") !== "",
  };
}

export type RepoMigrateResult =
  | { outcome: "created"; ownerNamespace: string; slug: string }
  | { outcome: "invalid"; message: string };

/** The webhook-fan-out inputs handed over by the POST handler (the repo-create
 *  emission shape). Omitted → no emission (the historical shape; every real
 *  caller passes it). */
export interface RepoMigrateEmission {
  request: RepoEventRequest;
  origin: string;
}

/**
 * The write, through the LANDED server-driven arm (`resolveMigrateOwner` +
 * `migrateRepository` — the module header): the mirror checkbox is the form's
 * only offered arm, so a mirror=false submission re-renders the degradation
 * note instead of stranding a born `migrating` row no browser can ever
 * populate. Validation and service 4xx failures surface as the invalid
 * outcome and re-render inline (the login failure convention; the per-error
 * mapping is the module header's table); engine transport failures propagate
 * (the services/engine.ts posture — retryable-unknown state is never a form
 * error). Success carries the born repo's home segments — the population is
 * the enqueued mirror-sync, never in-request (§2.6 queue semantics).
 */
export async function migrateRepoFromForm(
  env: MigrateEnv,
  d1: D1Database,
  viewer: Extract<Viewer, { kind: "user" }>,
  data: RepoMigrateData,
  form: RepoMigrateForm,
  emission?: RepoMigrateEmission,
): Promise<RepoMigrateResult> {
  if (form.cloneAddr === "") return { outcome: "invalid", message: repoMigrateLocale.clone_addr_required };
  if (form.repoName === "") return { outcome: "invalid", message: repoMigrateLocale.name_required };
  if (!form.mirror) return { outcome: "invalid", message: repoMigrateLocale.mirror_required };

  // The option shape carries exactly the fields the landed body accepts and
  // the Git template renders (module-header matrix): `service` is the hidden
  // input's "git", the auth fields ride only when non-empty (the service's
  // credential envelope treats absence and empty identically), `uid` absent
  // = the doer (FormInt64's zero arm).
  const options: ServerMigrateOptions = {
    clone_addr: form.cloneAddr,
    service: "git",
    mirror: true,
    private: form.isPrivate,
    repo_name: form.repoName,
    ...(form.authUsername !== "" ? { auth_username: form.authUsername } : {}),
    ...(form.authPassword !== "" ? { auth_password: form.authPassword } : {}),
    ...(form.description !== "" ? { description: form.description } : {}),
    ...(form.uid !== null ? { uid: form.uid } : {}),
  };

  const invalid = (message: string): RepoMigrateResult => ({ outcome: "invalid", message });
  let outcome;
  try {
    const owner = await resolveMigrateOwner(d1, { id: viewer.id, isAdmin: viewer.isAdmin }, options);
    outcome = await migrateRepository(d1, env, owner, options, new Date());
  } catch (error) {
    if (error instanceof MirrorValidationError) return invalid(error.message);
    if (error instanceof MirrorCredentialKeyError) return invalid(error.message);
    if (error instanceof ApiError) {
      if (error.status >= 500) throw error;
      // The 409 collision renders upstream's WEB message (handleMigrateError's
      // IsErrRepoAlreadyExist arm); every other <500 text renders verbatim —
      // the 403/422 family IS upstream's API-arm wording (module header).
      if (error.status === 409) return invalid(repoMigrateLocale.name_taken);
      return invalid(error.message);
    }
    throw error;
  }

  // Webhook: repository created — the SAME single birth emission the API
  // arm's finalize step owns (module header). Emitted after the create
  // committed; the fan-out's failures are caught and logged inside the seam
  // and never fail the write.
  const apiViewer: ApiViewer = { origin: emission?.origin ?? "", requester: null };
  const sender = apiUserFromRow(data.doer, apiViewer);
  const projectingViewer: ApiViewer = { origin: apiViewer.origin, requester: sender };
  const pair = await findRepositoryById(d1, outcome.repo.id);
  if (pair !== null && emission !== undefined) {
    const identity = repositoryEventIdentity(projectingViewer, pair);
    await emitRepoEvent(emission.request, {
      repoId: pair.repo.id,
      ownerId: pair.repo.ownerId,
      eventType: "repository",
      payload: repositoryEventPayload("created", identity.repository, identity.organization, sender),
    });
  }
  return { outcome: "created", ownerNamespace: outcome.repo.ownerNamespace, slug: outcome.repo.slug };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the component). */
export function renderRepoMigratePage(options: {
  ctx: UiContext;
  data: RepoMigrateData;
  form: RepoMigrateForm;
  error: string | null;
}): string {
  return renderPage(
    <RepoMigratePage ctx={options.ctx} data={options.data} form={options.form} error={options.error} />,
  );
}

/** The migration page (§2.4.1 discriminator: `repository new migrate` —
 *  git.tmpl:2). */
export function RepoMigratePage(props: {
  ctx: UiContext;
  data: RepoMigrateData;
  form: RepoMigrateForm;
  error: string | null;
}) {
  const { ctx, data, form } = props;
  // The effective owner the re-render's select follows: the submitted uid
  // (GET's `?org=` preselect rides the same field); unknown owners fall back
  // to the doer (upstream checkContextUser's ErrUserNotExist arm).
  const selected =
    form.uid === null
      ? data.doer.id
      : data.owners.some((owner) => owner.id === form.uid)
        ? form.uid
        : data.doer.id;
  return (
    <BaseLayout ctx={ctx} title={repoMigrateLocale.title} pageClass="repository new migrate">
      <div class="ui container medium-width">
        <h3 class="ui top attached header">{repoMigrateLocale.header}</h3>
        <div class="ui attached segment">
          <form class="ui form left-right-form" action="/repo/migrate" method="post">
            {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
            {/* common-init.tmpl — the service variant pin (the data-global-init
                JS hook reduced out, the no-JS convention). */}
            <input type="hidden" name="service" value="git" />
            <div class="inline required field">
              <label for="clone_addr">{repoMigrateLocale.clone_address}</label>
              <input
                id="clone_addr"
                name="clone_addr"
                value={form.cloneAddr}
                required
                autocomplete="off"
                autofocus
              />
              <span class="help">{repoMigrateLocale.clone_address_desc}</span>
            </div>
            <div class="inline field">
              <label for="auth_username">{repoMigrateLocale.username}</label>
              <input id="auth_username" name="auth_username" value={form.authUsername} autocomplete="off" />
            </div>
            <div class="inline field">
              <label for="auth_password">{repoMigrateLocale.password}</label>
              {/* The template renders the password field EMPTY (no value
                  binding) — the re-render keeps it that way (module header). */}
              <input id="auth_password" name="auth_password" type="password" autocomplete="new-password" />
            </div>
            {/* common-options.tmpl — the mirror checkbox; the
                DisableNewPullMirrors gate has no landed flag (module header),
                and the LFS arm stays unrendered with it. */}
            <div class="inline field">
              <label>{repoMigrateLocale.migrate_options}</label>
              <div class="ui checkbox">
                <input id="mirror" name="mirror" type="checkbox" checked={form.mirror} />
                <label for="mirror">{repoMigrateLocale.mirror_helper}</label>
              </div>
            </div>
            <div class="divider" />
            {/* common-migrated-repo.tmpl — the owner dropdown reduced to the
                native select (the repo-create precedent). */}
            <div class="inline required field">
              <label for="uid">{repoMigrateLocale.owner}</label>
              <select id="uid" name="uid" class="ui selection dropdown" autocomplete="off">
                {data.owners.map((owner) => (
                  <option value={String(owner.id)} selected={owner.id === selected}>
                    {owner.username}
                  </option>
                ))}
              </select>
            </div>
            <div class="inline required field">
              <label for="repo_name">{repoMigrateLocale.repo_name}</label>
              <input
                id="repo_name"
                name="repo_name"
                value={form.repoName}
                required
                maxlength={100}
                autocomplete="off"
              />
            </div>
            <div class="inline field">
              <label>{repoMigrateLocale.visibility}</label>
              <div class="ui checkbox">
                <input id="private" name="private" type="checkbox" checked={form.isPrivate} />
                <label for="private">{repoMigrateLocale.visibility_helper}</label>
              </div>
            </div>
            <div class="inline field">
              <label for="description">{repoMigrateLocale.repo_desc}</label>
              <textarea id="description" name="description" rows={2} maxlength={2048}>
                {form.description}
              </textarea>
            </div>
            <div class="inline field">
              <label></label>
              <button type="submit" class="ui primary button">
                {repoMigrateLocale.migrate_repo}
              </button>
            </div>
          </form>
        </div>
      </div>
    </BaseLayout>
  );
}
