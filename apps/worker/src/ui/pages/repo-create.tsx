/**
 * The new-repository page, `/repo/create` — pages wave 19 (SPEC-0008 U3
 * extension, the authoring front door: the parity survey's #2). Upstream
 * `repo.Create` / `repo.CreatePost` (routers/web/repo/repo.go:142-296) over
 * templates/repo/create.tmpl at the pin, posting through the TWO LANDED
 * create arms the parity survey names:
 *
 *   - owner = the session doer  → `createUserRepository`
 *     (api/services/user-repos.ts — the `POST /user/repos` arm: name,
 *     description, private, default branch AND `auto_init`, the Worker-built
 *     README "Initial commit" through the engine's putApiObjects +
 *     commitApiChange);
 *   - owner = an organization  → the `POST /orgs/{org}/repos` arm
 *     (requireCanCreateOrgRepo + RepoService.create — api/routes/org-repos.ts
 *     :192-240). That arm carries NO auto-init (the createOrgRepo deferral
 *     note: template scaffolding is deferred to the commit-builder wave), so
 *     the form degrades honestly: the auto-init checkbox renders for the
 *     personal-repository owner only, and an organization owner's submission
 *     creates the repository EMPTY — documented below and in the re-render.
 *
 * ## DOM contract (templates/repo/create.tmpl at the pin)
 *
 * `.page-content.repository.new-repo` (BaseLayout's page-content div), one
 * `.ui.container.medium-width` holding the `.ui.top.attached.header`
 * ("new_repo") + the `.ui.attached.segment` with the upstream
 * `<form class="ui form left-right-form" action="{.Link}" method="post">`:
 * the owner field (`uid` — upstream's hidden-input Fomantic dropdown reduced
 * to the native `<select>` the no-JS form posts; the doer + the orgs the
 * viewer may create repositories in, upstream checkContextUser's
 * GetOrgsCanCreateRepoByUserID ∩ CanCreateRepoIn list), the required
 * `repo_name` input (maxlength 100 — the CreateRepoForm binding), the
 * `private` visibility checkbox, the `description` textarea (maxlength 2048),
 * the `auto_init` checkbox, and the primary submit ("repo.create_repo").
 *
 * ## Documented v1 degradations (data/services that have not landed, §6)
 *
 * - The gitignores / license / issue-labels dropdowns, the template-repo
 *   picker (create.tmpl's whole `#template_units` block) and the
 *   object-format selector are not rendered: no template store exists on the
 *   instance (the user-repos arm accepts those options and ignores them — its
 *   documented divergence) and sha1 is the only engine object format.
 * - The `default_branch` input is not rendered (the brief's field set; the
 *   arm's default "main" applies — the engine's synthetic-HEAD fallback).
 * - The owner dropdown reduces upstream's JS dropdown to a native select;
 *   `?org={id}` (upstream Create's checkContextUser arm, the dashboard
 *   widget's deep link) preselects an allowed org, anything else falls back
 *   to the doer.
 * - Organization repositories are created EMPTY even when the form carried
 *   auto_init (the org arm has no initial-commit builder); the description
 *   still stores through the shared repo-settings service (upstream
 *   CreateRepository carries Description for both owner kinds — the API org
 *   arm's omission is a route limitation the web form does not inherit).
 * - The visibility checkbox defaults CHECKED: the brief pins
 *   DefaultPushCreatePrivate (upstream's default at
 *   modules/setting/repository.go:137 — the same default the git gate's
 *   push-create applies, git-http/gate.ts:332-333), standing in for the web
 *   form's `DefaultPrivate=last` setting (no last_repo_visibility column).
 * - Webhook: both arms fan out the SAME `repository` "created" event the API
 *   routes emit (notifier.go:114-116 — Organization the owner, Sender the
 *   creating doer) through the shared repo-events seam, the new-issue
 *   precedent that closed the same divergence. The Sender/identity
 *   projections render from the doer's D1 row (apiUserFromRow) — the API
 *   routes' token-identity projection stand-in.
 * - Forged/tampered owner ids re-render the form inline (upstream's
 *   checkContextUser answers a bare StatusForbidden page; the no-JS form
 *   convention re-renders — the write path re-gates every org through
 *   requireCanCreateOrgRepo either way, so nothing is gained).
 */

import {
  RepoNameCollisionError,
  RepoNameInvalidError,
  RepoService,
  type RepoRow,
} from "../../repos/service";
import { createUserRepository, findDoerRow } from "../../api/services/user-repos";
import { requireCanCreateOrgRepo } from "../../api/services/org-repos";
import { OrgService } from "../../services/orgs/orgs";
import { ApiError } from "../../api/errors";
import type { CreateRepoOption } from "../../api/models/repository";
import { saveRepoSettings } from "../../api/services/repo-settings";
import {
  apiUserFromRow,
  findRepositoryById,
  type Viewer as ApiViewer,
} from "../../api/services/repository";
import {
  emitRepoEvent,
  repositoryEventIdentity,
  repositoryEventPayload,
  type RepoEventRequest,
} from "../../services/repo-events";
import { BaseLayout, renderPage } from "../shell";
import type { UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import type { users } from "../../db/schema";

/** Page chrome text (component-local, the newIssueLocale pattern — locale.ts
 *  is shared and not this wave's file). */
export const repoCreateLocale = {
  title: "New Repository", // "new_repo"
  owner: "Owner", // "repo.owner"
  owner_helper:
    "Some organizations may not show up in the dropdown due to a maximum repository count limit.", // "repo.owner_helper"
  repo_name: "Repository Name", // "repo.repo_name"
  repo_name_helper: "Good repository names use short, memorable and unique keywords.", // "repo.repo_name_helper" (the .profile tail documents a profile-repo feature this slice does not carry)
  visibility: "Visibility", // "repo.visibility"
  visibility_helper: "Make repository private", // "repo.visibility_helper"
  visibility_description: "Only the owner or the organization members if they have rights, will be able to see it.", // "repo.visibility_description"
  repo_desc: "Description", // "repo.repo_desc"
  repo_desc_helper: "Enter short description (optional)", // "repo.repo_desc_helper"
  auto_init: "Initialize Repository (Adds .gitignore, License and README)", // "repo.auto_init"
  create_repo: "Create Repository", // "repo.create_repo"
  /** The empty-name re-render — cf-gitea addition (the new-issue
   *  title_required precedent; upstream's HTML5 `required` catches the
   *  browser case). */
  name_required: "A repository name is required.",
  /** The taken-name re-render — upstream's web message
   *  ("form.repo_name_been_taken"), the web-form wording standing in for the
   *  API arm's 409 body text. */
  name_taken: "The repository name is already used.",
  /** The forged/tampered-owner re-render — cf-gitea addition standing in for
   *  checkContextUser's bare StatusForbidden page (module header). */
  owner_not_allowed: "You are not allowed to create repositories for this owner.",
  /** The org-owner note: the auto-init request is DROPPED (the org arm has
   *  no initial-commit builder — module header). Rendered instead of the
   *  checkbox whenever the effective owner is an organization. */
  org_auto_init_note:
    "Organization repositories are created empty; auto-initialization applies to personal repositories only.",
} as const;

/** The owner-option cap (one page read; the new-issue picker-limit
 *  precedent — upstream's dropdown pages through the JS path). */
export const REPO_CREATE_ORG_LIMIT = 100;

// ---------------------------------------------------------------------------
// Data loading (§3.2 direct service calls)
// ---------------------------------------------------------------------------

/** One owner-dropdown entry: the doer (kind "user") or an org the viewer may
 *  create repositories in (kind "org"). */
export interface RepoCreateOwner {
  id: number;
  username: string;
  kind: "user" | "org";
}

/** The form's render inputs: the doer row (the user arm's owner) plus the
 *  owner options. */
export interface RepoCreateData {
  doer: typeof users.$inferSelect;
  owners: RepoCreateOwner[];
}

/**
 * Load the form data (§3.2): the doer row (a session principal without a D1
 * row is the silent-auth-failure convention → the caller 404-shells) and the
 * owner options — the doer plus the doer's org memberships that pass the
 * landed `canCreateOrgRepo` predicate (the Owners-team bridge or a
 * repo-creating team — upstream GetOrgsCanCreateRepoByUserID ∩
 * CanCreateRepoIn, checkContextUser:64-73). Site admins pass every
 * membership (the org arm's caller-level admin bypass —
 * requireCanCreateOrgRepo's isAdmin arm, fork.go:97-108 posture).
 */
export async function loadRepoCreateData(d1: D1Database, viewer: Viewer): Promise<RepoCreateData | null> {
  if (viewer.kind !== "user") throw new Error("loadRepoCreateData requires a signed-in viewer");
  const doer = await findDoerRow(d1, { id: viewer.id });
  if (doer === null) return null;
  const orgs = new OrgService(d1);
  const memberships = await orgs.listUserOrgs(doer.id, {
    maxVisibility: "private",
    page: 1,
    pageSize: REPO_CREATE_ORG_LIMIT,
  });
  const owners: RepoCreateOwner[] = [{ id: doer.id, username: doer.username, kind: "user" }];
  for (const org of memberships.items) {
    if (doer.isAdmin || (await orgs.canCreateOrgRepo(org.id, doer.id))) {
      owners.push({ id: org.id, username: org.username, kind: "org" });
    }
  }
  return { doer, owners };
}

// ---------------------------------------------------------------------------
// Form parsing + the write (§3.2 — the landed create arms directly)
// ---------------------------------------------------------------------------

/** The parsed `application/x-www-form-urlencoded` submission. `uid` is
 *  upstream's owner field: absent/empty (and any non-numeric garbage) means
 *  the doer — upstream FormInt64's zero falls through checkContextUser to
 *  the doer. */
export interface RepoCreateForm {
  uid: number | null;
  name: string;
  description: string;
  isPrivate: boolean;
  autoInit: boolean;
}

/** Parse the POST body (the parseNewIssueForm conventions: trim the name,
 *  the checkboxes are field-present rules). */
export function parseRepoCreateForm(params: URLSearchParams): RepoCreateForm {
  const uidRaw = (params.get("uid") ?? "").trim();
  return {
    uid: /^\d+$/.test(uidRaw) ? Number.parseInt(uidRaw, 10) : null,
    name: (params.get("repo_name") ?? "").trim(),
    description: params.get("description") ?? "",
    isPrivate: (params.get("private") ?? "") !== "",
    autoInit: (params.get("auto_init") ?? "") !== "",
  };
}

export type RepoCreateResult =
  | { outcome: "created"; ownerNamespace: string; slug: string }
  | { outcome: "invalid"; message: string };

/** The webhook-fan-out inputs handed over by the POST handler (the hono
 *  request source + the instance origin — the new-issue emission shape).
 *  Omitted → no emission (the historical shape; every real caller passes
 *  it). */
export interface RepoCreateEmission {
  request: RepoEventRequest;
  origin: string;
}

/**
 * The write, dispatched on the owner select (module header): the user arm
 * through `createUserRepository` (auto-init included), the org arm through
 * `requireCanCreateOrgRepo` + `RepoService.create` (auto-init dropped — the
 * honest degrade). Validation and service 4xx failures surface as the
 * invalid outcome and re-render inline (the login failure convention);
 * engine transport failures propagate (the services/engine.ts posture —
 * retryable-unknown state is never a form error).
 */
export async function createRepoFromForm(
  env: Env,
  d1: D1Database,
  viewer: Extract<Viewer, { kind: "user" }>,
  data: RepoCreateData,
  form: RepoCreateForm,
  emission?: RepoCreateEmission,
): Promise<RepoCreateResult> {
  if (form.name === "") return { outcome: "invalid", message: repoCreateLocale.name_required };

  const invalid = (message: string): RepoCreateResult => ({ outcome: "invalid", message });
  const now = new Date();
  const apiViewer: ApiViewer = { origin: emission?.origin ?? "", requester: null };
  const sender = apiUserFromRow(data.doer, apiViewer);
  const projectingViewer: ApiViewer = { origin: apiViewer.origin, requester: sender };

  let row: RepoRow;
  try {
    if (form.uid === null || form.uid === data.doer.id) {
      // The user arm (upstream CreatePost's doer branch) — the option
      // carries exactly the fields the arm stores; `readme` fixes the
      // arm's single-entry template catalog (resolveAutoInitReadme's
      // empty-readme coercion, kept explicit here).
      const option: CreateRepoOption = {
        name: form.name,
        private: form.isPrivate,
        ...(form.description !== "" ? { description: form.description } : {}),
        ...(form.autoInit ? { auto_init: true, readme: "Default" } : {}),
      };
      const created = await createUserRepository(d1, env, data.doer, option, now);
      row = created;
    } else {
      const uid = form.uid;
      const org = await new OrgService(d1).getOrgById(uid);
      if (org === null) return invalid(repoCreateLocale.owner_not_allowed);
      try {
        // The org arm's authoritative guard chain in upstream order
        // (404-shaped missing/invisible → 403 grant — the API route's
        // sequence); the messages re-render inline.
        await requireCanCreateOrgRepo(d1, org.usernameLower, { id: viewer.id, isAdmin: viewer.isAdmin });
      } catch (error) {
        if (error instanceof ApiError) {
          return invalid(error.status === 403 ? error.message : repoCreateLocale.owner_not_allowed);
        }
        throw error;
      }
      const created = await new RepoService(d1).create({
        owner: { id: org.id, usernameLower: org.usernameLower },
        name: form.name,
        isPrivate: form.isPrivate,
      });
      // Upstream CreateRepository carries the description for BOTH owner
      // kinds; the shared repo-settings store does too (module header). The
      // auto-init request is dropped — the org arm has no initial-commit
      // builder, so the repository stays empty.
      if (form.description !== "") {
        await saveRepoSettings(d1, created.id, { description: form.description }, now);
      }
      row = created;
    }
  } catch (error) {
    if (error instanceof RepoNameCollisionError) return invalid(repoCreateLocale.name_taken);
    if (error instanceof RepoNameInvalidError) return invalid(error.message);
    if (error instanceof ApiError && error.status < 500) return invalid(error.message);
    throw error;
  }

  // Webhook: repository created — the SAME `repository` fan-out the API
  // create routes emit (module header). Emitted after the create committed;
  // the fan-out's failures are caught and logged inside the seam and never
  // fail the write.
  const pair = await findRepositoryById(d1, row.id);
  if (pair !== null && emission !== undefined) {
    const identity = repositoryEventIdentity(projectingViewer, pair);
    await emitRepoEvent(emission.request, {
      repoId: pair.repo.id,
      ownerId: pair.repo.ownerId,
      eventType: "repository",
      payload: repositoryEventPayload("created", identity.repository, identity.organization, sender),
    });
  }
  return { outcome: "created", ownerNamespace: row.ownerNamespace, slug: row.slug };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module, so the JSX invocation lives beside the component). */
export function renderRepoCreatePage(options: {
  ctx: UiContext;
  data: RepoCreateData;
  form: RepoCreateForm;
  error: string | null;
}): string {
  return renderPage(<RepoCreatePage ctx={options.ctx} data={options.data} form={options.form} error={options.error} />);
}

/** The new-repository page (§2.4.1 discriminator: `repository new-repo`). */
export function RepoCreatePage(props: { ctx: UiContext; data: RepoCreateData; form: RepoCreateForm; error: string | null }) {
  const { ctx, data, form } = props;
  // The effective owner the re-render's auto-init arm follows: the
  // submitted uid (GET's `?org=` preselect rides the same field); unknown
  // or non-personal owners render the note.
  const selected =
    form.uid === null
      ? data.doer.id
      : data.owners.some((owner) => owner.id === form.uid)
        ? form.uid
        : data.doer.id;
  const ownerIsUser = data.owners.some((owner) => owner.id === selected && owner.kind === "user");
  const autoInitId = "auto-init";
  return (
    <BaseLayout ctx={ctx} title={repoCreateLocale.title} pageClass="repository new-repo">
      <div class="ui container medium-width">
        <h3 class="ui top attached header">{repoCreateLocale.title}</h3>
        <div class="ui attached segment">
          <form class="ui form left-right-form" action="/repo/create" method="post">
            {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
            <div class="inline required field">
              <label for="uid">{repoCreateLocale.owner}</label>
              <select id="uid" name="uid" class="ui selection dropdown" autocomplete="off">
                {data.owners.map((owner) => (
                  <option value={String(owner.id)} selected={owner.id === selected}>
                    {owner.username}
                  </option>
                ))}
              </select>
              <span class="help">{repoCreateLocale.owner_helper}</span>
            </div>
            <div class="inline required field">
              <label for="repo_name">{repoCreateLocale.repo_name}</label>
              <input
                id="repo_name"
                name="repo_name"
                value={form.name}
                required
                maxlength={100}
                autocomplete="off"
                autofocus
              />
              <span class="help">{repoCreateLocale.repo_name_helper}</span>
            </div>
            <div class="inline field">
              <label>{repoCreateLocale.visibility}</label>
              <div class="ui checkbox">
                <input id="private" name="private" type="checkbox" checked={form.isPrivate} />
                <label for="private">{repoCreateLocale.visibility_helper}</label>
              </div>
              <span class="help">{repoCreateLocale.visibility_description}</span>
            </div>
            <div class="inline field">
              <label for="description">{repoCreateLocale.repo_desc}</label>
              <textarea id="description" name="description" rows={2} maxlength={2048} placeholder={repoCreateLocale.repo_desc_helper}>
                {form.description}
              </textarea>
            </div>
            {ownerIsUser ? (
              <div class="inline field">
                <label></label>
                <div class="ui checkbox">
                  <input id={autoInitId} name="auto_init" type="checkbox" checked={form.autoInit} />
                  <label for={autoInitId}>{repoCreateLocale.auto_init}</label>
                </div>
              </div>
            ) : (
              <div class="inline field">
                <label></label>
                <span class="help">{repoCreateLocale.org_auto_init_note}</span>
              </div>
            )}
            <div class="inline field">
              <label></label>
              <button type="submit" class="ui primary button">
                {repoCreateLocale.create_repo}
              </button>
            </div>
          </form>
        </div>
      </div>
    </BaseLayout>
  );
}
