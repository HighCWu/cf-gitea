/**
 * The fork-create form, `/{owner}/{repo}/fork` — pages wave 26 (the UI-parity
 * survey's TOP-5 row, docs/compat/ui-parity-survey.md): upstream
 * `m.Combo("/fork").Get(repo.Fork).Post(web.Bind[*forms.CreateRepoForm](),
 * repo.ForkPost)` (web.go:1490, routers/web/repo/fork.go:126-217) under
 * reqSignIn + RepoAssignment + reqUnitCodeReader, over templates/repo/pulls/
 * fork.tmpl at the pin — DISTINCT from the landed forks LIST (pages/
 * repo-social.tsx, wave 24), whose header carries this page's entry button.
 *
 * ## Gates (the combo's order, reduced to the landed model)
 *
 * reqSignIn: an anonymous viewer 303s onto the login round-trip — repo
 * resolution FIRST (resolveUiRequest), so an invisible repo 404-shells and
 * never leaks through the redirect. reqUnitCodeReader: the §2.5 read grant
 * IS the code-read arm. getForkRepository's IsEmpty arm (fork.go:29-33): an
 * EMPTY repository 404-shells (nothing to fork). The POST re-runs the same
 * gates in upstream's ForkPost order after the §2.8 Origin guard.
 *
 * ## Owner options (fork.go:44-52 + 63-87's reduction)
 *
 * The dropdown lists the doer (`CanForkToUser` — CanUserForkBetweenOwners:
 * the source owner is not the doer; AllowForkIntoSameOwner is off at the
 * pin — AND no existing doer fork) plus the orgs the doer may create
 * repositories in (`GetOrgsCanCreateRepoByUserID` — the landed listUserOrgs
 * + canCreateOrgRepo predicate, the repo-create page's owner bridge) MINUS
 * the source's owner and every org that already holds a fork of this source
 * (upstream's HasForkedRepo filter; the fork-chain walk collapses — our
 * fork edge is one level deep). The default selection is upstream's
 * ContextUser: the doer when forkable, else the first org.
 *
 * ## The write (ForkPost over the landed createFork)
 *
 * The form posts `uid` + `repo_name` to the SAME URL (upstream
 * `action="{{.Link}}"`), and the handler replays the landed POST
 * /repos/{owner}/{repo}/forks route's exact service sequence
 * (api/routes/forks.ts): the target-owner guard chain
 * (requireCanCreateOrgRepo — 404-shaped missing/invisible, 403 grant), the
 * blocked-by-source-owner arm ("user is blocked"), the empty-name default
 * to the source's slug (optional.FromPtr), the GetUserFork one-fork-per-
 * owner probe — an EXISTING fork 303s onto its home (upstream
 * JSONRedirect(ctxUser.HomeLink()+"/"+repo.Name)) — then `createFork`
 * (the queue+registry-backed replication hand-off). The name/description/
 * visibility fields upstream carries are the landed service's copies from
 * the source (createFork copies the source's description and private flag;
 * the single-branch option is outside the frozen contract) — the form
 * renders the inherited visibility as the DISABLED checkbox and omits the
 * description/branch fields rather than promise inputs the write ignores.
 *
 * ## Documented v1 degradations (§6 method)
 *
 * - The Fomantic owner/branch dropdowns reduce to the native `<select>` (the
 *   repo-create page's convention); avatars in the options are the
 *   repo-create reduction (no avatar pipeline in form options).
 * - The branch picker (`fork_single_branch`) and the description textarea
 *   are not rendered — the landed createFork arm accepts neither (module
 *   header); the source's description rides the copy.
 * - No valid owners (no doer fork slot, no org grant): upstream renders the
 *   form with the disabled button + the flash error; the no-JS re-render
 *   shows the exact message inline and the disabled submit (the button's
 *   `disabled` class, the template's arm).
 * - The 202-vs-done semantics: the fork row settles ASYNC (the REPO_TASKS
 *   consumer), so the success 303 lands on a repository that may still be
 *   'creating' — the fork's page 404-shells until the replication push
 *   lands (the landed API's documented strand posture; upstream's own
 *   migration pending page is a subsystem this instance does not render).
 * - Forged/tampered owner ids re-render the form inline (the repo-create
 *   page's convention — the write path re-gates every org through
 *   requireCanCreateOrgRepo either way).
 */

import { RepoNameCollisionError, RepoNameInvalidError } from "../../repos/service";
import { findDoerRow } from "../../api/services/user-repos";
import { requireCanCreateOrgRepo } from "../../api/services/org-repos";
import { createFork, findForkByOwner, type ForkServiceDeps } from "../../api/services/forks";
import { isUserBlockedBy, BLOCKED_USER_MESSAGE } from "../../api/services/blocks";
import { findRepositoryByPath, type RepositoryWithOwner } from "../../api/services/repository";
import { OrgService } from "../../services/orgs/orgs";
import { ApiError } from "../../api/errors";
import { BaseLayout, renderPage } from "../shell";
import type { RepoRow, UiContext } from "../ui-context";
import type { Viewer } from "../viewer";

/** Page chrome text (component-local, the repoCreateLocale pattern — the
 *  strings are upstream's locale keys verbatim). */
export const repoForkLocale = {
  title: "New Repository Fork", // "new_fork"
  owner: "Owner", // "repo.owner"
  fork_from: "Fork From", // "repo.fork_from"
  repo_name: "Repository Name", // "repo.repo_name"
  visibility: "Visibility", // "repo.visibility"
  visibility_helper: "Make repository private", // "repo.visibility_helper"
  fork_visibility_helper: "The visibility of a forked repository cannot be changed.", // "repo.fork_visibility_helper"
  fork_repo: "Fork Repository", // "repo.fork_repo"
  fork: "Fork", // "repo.fork" (the forks-list entry button)
  fork_no_valid_owners:
    "This repository cannot be forked because there are no valid owners.", // "repo.fork_no_valid_owners"
  /** ForkPost's IsErrRepoAlreadyExist arm — "repo.settings.
   *  new_owner_has_same_repo" verbatim (the name-collision re-render). */
  new_owner_has_same_repo:
    "The new owner already has a repository with same name. Please choose another name.",
  /** The forged/tampered-owner re-render — the repo-create page's carried
   *  stand-in for checkContextUser's bare StatusForbidden. */
  owner_not_allowed: "You are not allowed to create repositories for this owner.",
} as const;

/** The owner-option cap (one page read — the repo-create page's limit). */
export const REPO_FORK_ORG_LIMIT = 100;

/** One owner-dropdown entry (the RepoCreateOwner shape — kind distinguishes
 *  the doer from an org). */
export interface RepoForkOwner {
  id: number;
  username: string;
  kind: "user" | "org";
}

/** The fork form's render inputs. */
export interface RepoForkData {
  /** The source pair (the Fork From link + the write's source). */
  source: RepositoryWithOwner;
  /** The resolved doer row (the user option). */
  owner: RepoForkOwner | null;
  orgs: RepoForkOwner[];
  /** The preselected owner id (upstream ContextUser: the doer when
   *  CanForkToUser, else the first org; null = no valid owner). */
  selectedId: number | null;
}

/**
 * Load the form (§3.2): the source pair, the doer option behind
 * CanUserForkBetweenOwners + the not-yet-forked probe, and the org options
 * behind canCreateOrgRepo minus the source owner and the orgs that already
 * hold a fork. Returns null when the doer row is missing (the silent-auth-
 * failure convention — the caller 404-shells).
 */
export async function loadRepoForkData(
  env: Env,
  d1: D1Database,
  repo: RepoRow,
  viewer: Extract<Viewer, { kind: "user" }>,
): Promise<RepoForkData | null> {
  const doerRow = await findDoerRow(d1, { id: viewer.id });
  if (doerRow === null) return null;
  const source = await findRepositoryByPath(d1, repo.ownerNamespace, repo.slug);
  if (source === null) return null;

  const owners: RepoForkOwner[] = [];
  // CanForkToUser (fork.go:38): CanUserForkBetweenOwners(source.owner, doer)
  // — modules/repository/fork.go:18-23, `id1 != id2` (AllowForkIntoSameOwner
  // is off at the pin, no admin arm) — AND no doer fork of this source yet.
  const doerFork = await findForkByOwner(d1, source.repo.id, doerRow.id);
  if (doerFork === null && source.repo.ownerId !== doerRow.id) {
    owners.push({ id: doerRow.id, username: doerRow.username, kind: "user" });
  }

  const orgs = new OrgService(d1);
  const memberships = await orgs.listUserOrgs(doerRow.id, {
    maxVisibility: "private",
    page: 1,
    pageSize: REPO_FORK_ORG_LIMIT,
  });
  for (const org of memberships.items) {
    if (org.id === source.repo.ownerId) continue; // upstream's forkRepo.OwnerID != org.ID filter
    if (!(viewer.isAdmin || (await orgs.canCreateOrgRepo(org.id, doerRow.id)))) continue;
    if ((await findForkByOwner(d1, source.repo.id, org.id)) !== null) continue; // HasForkedRepo
    owners.push({ id: org.id, username: org.username, kind: "org" });
  }

  // Upstream ContextUser: the doer option (pushed first) when present, else
  // the first org.
  const first = owners[0];
  return {
    source,
    owner: first !== undefined && first.kind === "user" ? first : null,
    orgs: owners.filter((entry) => entry.kind === "org"),
    selectedId: first?.id ?? null,
  };
}

/** The parsed submission (`uid` + `repo_name` — the CreateRepoForm field
 *  names the template posts; the description/branch fields upstream binds
 *  are the landed write's copies, not rendered). */
export interface RepoForkForm {
  uid: number | null;
  name: string;
}

/** Parse the urlencoded POST (the parseRepoCreateForm conventions: the uid
 *  is numeric-or-null, the name trimmed). */
export function parseRepoForkForm(params: URLSearchParams): RepoForkForm {
  const uidRaw = (params.get("uid") ?? "").trim();
  return {
    uid: /^\d+$/.test(uidRaw) ? Number.parseInt(uidRaw, 10) : null,
    name: (params.get("repo_name") ?? "").trim(),
  };
}

export type RepoForkResult =
  | { outcome: "created"; ownerNamespace: string; slug: string }
  | { outcome: "existing"; location: string }
  | { outcome: "invalid"; message: string };

/**
 * The write — the landed POST /repos/{owner}/{repo}/forks route's sequence
 * over the web form (module header): target-owner resolution (doer or the
 * requireCanCreateOrgRepo chain), the blocked arm, the name default, the
 * one-fork-per-owner probe (an existing fork redirects onto its home), then
 * the landed `createFork`. Service 4xx failures surface as the invalid
 * outcome and re-render inline (the repo-create convention); engine
 * transport failures propagate (the services/engine.ts posture).
 */
export async function createForkFromForm(
  env: Env,
  d1: D1Database,
  viewer: Extract<Viewer, { kind: "user" }>,
  data: RepoForkData,
  form: RepoForkForm,
): Promise<RepoForkResult> {
  // The target owner (upstream checkContextUser): the doer unless the uid
  // names one of the rendered org options.
  let target: { id: number; usernameLower: string };
  if (form.uid === null || form.uid === viewer.id || (data.owner !== null && form.uid === data.owner.id)) {
    target = { id: viewer.id, usernameLower: viewer.username.toLowerCase() };
  } else {
    const org = await new OrgService(d1).getOrgById(form.uid);
    if (org === null) return { outcome: "invalid", message: repoForkLocale.owner_not_allowed };
    try {
      await requireCanCreateOrgRepo(d1, org.usernameLower, { id: viewer.id, isAdmin: viewer.isAdmin });
    } catch (error) {
      if (error instanceof ApiError) {
        return {
          outcome: "invalid",
          message: error.status === 403 ? error.message : repoForkLocale.owner_not_allowed,
        };
      }
      throw error;
    }
    target = { id: org.id, usernameLower: org.usernameLower };
  }

  // ForkRepository's blocked arm (the API route's positioning — before the
  // already-forked probe): a doer blocked by the SOURCE owner cannot fork.
  if (await isUserBlockedBy(d1, { id: viewer.id, isAdmin: viewer.isAdmin }, data.source.repo.ownerId ?? -1)) {
    return { outcome: "invalid", message: BLOCKED_USER_MESSAGE };
  }

  // `optional.FromPtr(form.Name).ValueOrDefault(repo.Name)` — the source's
  // name is the default fork name.
  const name = form.name !== "" ? form.name : data.source.repo.slug;

  // GetUserFork: at most one fork of this source per owner — an existing
  // fork sends the doer to its home (upstream's JSONRedirect arm).
  const existing = await findForkByOwner(d1, data.source.repo.id, target.id);
  if (existing !== null) {
    return { outcome: "existing", location: `/${existing.ownerNamespace}/${existing.slug}` };
  }

  const deps: ForkServiceDeps = {
    queue: env.REPO_TASKS,
    registry: env.REGISTRY.getByName("registry"),
  };
  try {
    const { fork } = await createFork(d1, deps, { source: data.source, targetOwner: target, name });
    return { outcome: "created", ownerNamespace: fork.ownerNamespace, slug: fork.slug };
  } catch (error) {
    if (error instanceof RepoNameCollisionError) {
      return { outcome: "invalid", message: repoForkLocale.new_owner_has_same_repo };
    }
    if (error instanceof RepoNameInvalidError) {
      return { outcome: "invalid", message: error.message };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Components (pulls/fork.tmpl, reductions in the header)
// ---------------------------------------------------------------------------

/** The full-document render (the render.tsx pattern — `index.ts` stays a
 *  pure-TS router module). */
export function renderRepoForkPage(options: {
  ctx: UiContext;
  data: RepoForkData;
  form: RepoForkForm;
  error: string | null;
}): string {
  return renderPage(<RepoForkPage ctx={options.ctx} data={options.data} form={options.form} error={options.error} />);
}

/** The fork form (§2.4.1 discriminator: the template's literal
 *  `repository new fork`). */
export function RepoForkPage(props: { ctx: UiContext; data: RepoForkData; form: RepoForkForm; error: string | null }) {
  const { ctx, data } = props;
  const repo = ctx.repo;
  if (repo === undefined) throw new Error("RepoForkPage requires ctx.repo");
  const repoLink = `/${repo.ownerNamespace}/${repo.slug}`;
  const action = `${repoLink}/fork`;
  const owners: RepoForkOwner[] = [
    ...(data.owner !== null ? [data.owner] : []),
    ...data.orgs,
  ];
  const selected =
    props.form.uid !== null && owners.some((owner) => owner.id === props.form.uid)
      ? props.form.uid
      : (data.selectedId ?? null);
  const noValidOwners = owners.length === 0;
  return (
    <BaseLayout ctx={ctx} title={repoForkLocale.title} pageClass="repository new fork">
      <div class="ui container medium-width">
        <h3 class="ui top attached header">{repoForkLocale.title}</h3>
        <div class="ui attached segment">
          {props.error !== null ? <div class="ui negative message">{props.error}</div> : null}
          {noValidOwners ? <div class="ui negative message">{repoForkLocale.fork_no_valid_owners}</div> : null}
          <form class="ui form left-right-form" action={action} method="post">
            <div class="inline required field">
              <label for="uid">{repoForkLocale.owner}</label>
              <select id="uid" name="uid" class="ui selection dropdown" autocomplete="off">
                {owners.map((owner) => (
                  <option value={String(owner.id)} selected={owner.id === selected}>
                    {owner.username}
                  </option>
                ))}
              </select>
            </div>
            <div class="inline field">
              <label>{repoForkLocale.fork_from}</label>
              <a href={repoLink} class="tw-inline-block">
                {data.source.repo.ownerNamespace}/{data.source.repo.slug}
              </a>
            </div>
            <div class="inline required field">
              <label for="repo_name">{repoForkLocale.repo_name}</label>
              <input id="repo_name" name="repo_name" value={props.form.name} required maxlength={100} autocomplete="off" />
            </div>
            <div class="inline field">
              <label>{repoForkLocale.visibility}</label>
              <div class="ui disabled checkbox">
                <input type="checkbox" disabled checked={data.source.repo.visibility === "private"} />
                <label>{repoForkLocale.visibility_helper}</label>
              </div>
              <span class="help">{repoForkLocale.fork_visibility_helper}</span>
            </div>
            <div class="inline field">
              <label></label>
              <button type="submit" class={"ui primary button" + (noValidOwners ? " disabled" : "")}>
                {repoForkLocale.fork_repo}
              </button>
            </div>
          </form>
        </div>
      </div>
    </BaseLayout>
  );
}
