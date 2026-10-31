/**
 * The repo-header trio's POST action arms (usability B-4) — upstream web.go:
 * 1765-1772's action group at the pin:
 *
 *     m.Post("/action/{action:star|unstar}", reqSignIn, starsEnabled, repo.ActionStar)
 *     m.Post("/action/{action:watch|participate|ignore}", reqSignIn, repo.ActionWatch)
 *     m.Post("/action/watch/options", reqSignIn, repo.ActionWatchOptions)
 *
 * star/unstar over services/stars.ts's counter-moving batch (star.go:16-32);
 * the three watch modes over services/repo-watchers.ts's
 * watchRepoWithOptions (the WatchOptions setter, models/repo/watch.go:
 * 189-206 — landed with migration 0053's mode columns): "watch" →
 * WatchModeNormal + every event toggle (watch.go:22-25), "participate" →
 * WatchModeNone (watch.go:27-29 — the row's absence, watchRepoByMode's
 * DELETE arm :146-148), "ignore" → WatchModeDont (watch.go:18-20); the
 * custom form (/action/watch/options + the watch_options_modal, the shell's
 * RepoWatchOptionsModal) → WatchModeCustom with the form's three FormBool
 * event toggles (watch.go:50-60), answering ctx.JSONRedirect("") — the
 * fetch-action JS reloads the page on the empty redirect
 * (fetch-action.ts:74-79).
 *
 * The responses are FRAGMENTS, not pages — upstream ctx.HTML(200, tplStar… /
 * tplWatch) renders repo/header/star.tmpl / repo/header/watch.tmpl alone,
 * and the official bundle's fetch-action module swaps them into the page
 * (fetch-action.ts: the star anchor's default `$this` sync, the watch items'
 * `data-fetch-sync="$body #repo-header-watch"`; each swapped node re-runs its
 * `data-global-init`/`data-fetch-url` wiring through the observer). The
 * fragment components ARE the shell's (../shell's RepoHeaderWatch /
 * RepoHeaderStar — one definition, two render sites, the template's own
 * shape), rendered here through renderToString.
 *
 * Handler shape (the HANDOFF recipe's thin adapter calls these): the §2.8
 * sameOriginGuard and the repo/viewer resolution run index.ts-side (the
 * resolveUiRequest prologue); these builders take the resolved pair and
 * answer 200 text/html (the watch arms) / 200 JSON (the options form).
 * Upstream's error ladder (repo.go:287-299) has no landed arm here —
 * star/watch writes carry no blocked/limit surfaces — so a failing write
 * propagates and the route answers its plain 500 (the landed
 * transient-failure convention); the fetch-action JS toasts non-ok responses
 * (fetch-action.ts:168-171).
 *
 * Anonymous POSTs never reach these builders: upstream's reqSignIn middleware
 * redirects (the fetch-action request gets the 200 {"redirect": …} JSON
 * through ctx.Redirect's IsGiteaFetchActionRequest arm, base.go:153-156) —
 * the recipe's thin adapter runs loginRedirect/isFetchActionRequest for it
 * (both landed: pages/repo-home.tsx's helpers).
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { renderToString } from "hono/jsx/dom/server";

import { findForkByOwner } from "../../api/services/forks";
import { getWatch, watchRepoWithOptions, WatchMode, type RepoWatch } from "../../api/services/repo-watchers";
import { isStarring, starRepo, unstarRepo } from "../../api/services/stars";
import { repositories } from "../../db/schema";
import { fetchActionRedirectResponse } from "./repo-home";
import { RepoHeaderStar, RepoHeaderWatch } from "../shell";
import type { RepoRow } from "../ui-context";
import type { Viewer } from "../viewer";

/** The star fragment (upstream tplStarUnstar — repo/header/star.tmpl): the
 *  anchor alone; the POST's fresh state rides the RE-READ row's num_stars
 *  (star.go:22-31's GetRepositoryByName re-read) and the IsStaring re-probe.
 *  `repo` must be the post-write row (the caller re-reads — repoStarActionResponse
 *  below, or the handler's own fresh read). */
export function renderRepoHeaderStarFragment(repo: RepoRow, viewer: Viewer, starring: boolean): string {
  return renderToString(
    <RepoHeaderStar repoLink={`/${repo.ownerNamespace}/${repo.slug}`} count={repo.numStars} viewer={viewer} starring={starring} />,
  );
}

/** The watch fragment (upstream tplWatch — repo/header/watch.tmpl): the whole
 *  `div#repo-header-watch` (the sync selector's target). watch.go:33-46
 *  re-reads GetWatch + the repository row for exactly these two inputs; the
 *  full Watch state (mode + include flags) drives the four-mode menu's
 *  SelectedMode checks and the Custom item's data-modal-* fills. */
export function renderRepoHeaderWatchFragment(repo: RepoRow, viewer: Viewer, repoWatch: RepoWatch): string {
  return renderToString(
    <RepoHeaderWatch repoLink={`/${repo.ownerNamespace}/${repo.slug}`} count={repo.numWatches} viewer={viewer} repoWatch={repoWatch} />,
  );
}

/** The per-viewer trio state for one repo page render (the HANDOFF recipe's
 *  loader extension — resolveUiRequest arms ctx.viewerRepoWatch /
 *  ctx.viewerStarsRepo / ctx.viewerForkOfRepo from this for USER viewers;
 *  anonymous viewers skip the reads entirely, the ctx fields stay absent and
 *  the shell renders the login-link variants). One probe per edge:
 *  getWatch (repo_watchers — the full row, the mode menu's input),
 *  isStarring (stars), findForkByOwner (fork.tmpl's direct-link arm — the
 *  doer's own fork only, the one-fork reduction documented on shell.tsx's
 *  RepoHeaderFork). The fork probe projects to the shell's two-field shape
 *  (the row id is write-path data, never rendered). */
export async function loadRepoHeaderActionState(
  d1: D1Database,
  repoId: string,
  userId: number,
): Promise<{ repoWatch: RepoWatch; starring: boolean; fork: { ownerNamespace: string; slug: string } | null }> {
  const [repoWatch, starring, fork] = await Promise.all([
    getWatch(d1, repoId, userId),
    isStarring(d1, userId, repoId),
    findForkByOwner(d1, repoId, userId),
  ]);
  return {
    repoWatch,
    starring,
    fork: fork === null ? null : { ownerNamespace: fork.ownerNamespace, slug: fork.slug },
  };
}

/** Re-read the repository row (upstream GetRepositoryByName — the fragment's
 *  counters must carry the write's own counter movement). */
async function rereadRepoRow(d1: D1Database, repoId: string): Promise<RepoRow> {
  const row = await drizzle(d1).select().from(repositories).where(eq(repositories.id, repoId)).get();
  if (row === undefined) throw new Error(`repo-header-actions: repo row vanished during action (${repoId})`);
  return row;
}

/**
 * POST /{owner}/{repo}/action/{star|unstar} (repo.ActionStar): the
 * counter-moving edge write, then the fragment over the re-read row + the
 * re-probed state. Idempotent by construction (the services' guarded batches
 * make a repeat POST move nothing — upstream StarRepo's already-(un)starring
 * silent arms, star.go:38-40/52-54).
 */
export async function repoStarActionResponse(
  d1: D1Database,
  repo: RepoRow,
  viewer: Extract<Viewer, { kind: "user" }>,
  action: "star" | "unstar",
): Promise<Response> {
  if (action === "star") {
    await starRepo(d1, viewer.id, repo.id, new Date());
  } else {
    await unstarRepo(d1, viewer.id, repo.id);
  }
  const [freshRow, starring] = await Promise.all([rereadRepoRow(d1, repo.id), isStarring(d1, viewer.id, repo.id)]);
  const html = renderRepoHeaderStarFragment(freshRow, viewer, starring);
  return new Response(html, { status: 200, headers: { "content-type": "text/html;charset=utf-8" } });
}

/**
 * POST /{owner}/{repo}/action/{watch|participate|ignore} (repo.ActionWatch,
 * routers/web/repo/watch.go:16-47): every arm rides the landed
 * watchRepoWithOptions with upstream's exact WatchOptions — watch →
 * WatchModeNormal + all three event toggles (:22-25), participate →
 * WatchModeNone (:27-29, the row's absence), ignore → WatchModeDont (:18-20)
 * — then the fragment over the re-read pair (GetWatch + the repository row,
 * :33-46). Idempotent by construction (watchRepoByMode's same-mode no-op).
 */
export async function repoWatchActionResponse(
  d1: D1Database,
  repo: RepoRow,
  viewer: Extract<Viewer, { kind: "user" }>,
  action: "watch" | "participate" | "ignore",
): Promise<Response> {
  const now = new Date();
  if (action === "watch") {
    await watchRepoWithOptions(
      d1,
      repo.id,
      viewer.id,
      { mode: WatchMode.Normal, watchPullRequests: true, watchIssues: true, watchReleases: true },
      now,
    );
  } else if (action === "participate") {
    await watchRepoWithOptions(
      d1,
      repo.id,
      viewer.id,
      { mode: WatchMode.None, watchPullRequests: false, watchIssues: false, watchReleases: false },
      now,
    );
  } else {
    await watchRepoWithOptions(
      d1,
      repo.id,
      viewer.id,
      { mode: WatchMode.Dont, watchPullRequests: false, watchIssues: false, watchReleases: false },
      now,
    );
  }
  const [freshRow, repoWatch] = await Promise.all([rereadRepoRow(d1, repo.id), getWatch(d1, repo.id, viewer.id)]);
  const html = renderRepoHeaderWatchFragment(freshRow, viewer, repoWatch);
  return new Response(html, { status: 200, headers: { "content-type": "text/html;charset=utf-8" } });
}

/** `Base.FormBool` (services/context/base_form.go:62-66): ParseBool's true
 *  set ("1", "t", "T", "TRUE", "true", "True") plus the case-insensitive
 *  "on" — the HTML checkbox's default submit value. */
export function formBool(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  return (
    value === "1" || value === "t" || value === "T" || value === "TRUE" || value === "true" || value === "True" ||
    value.toLowerCase() === "on"
  );
}

/**
 * POST /{owner}/{repo}/action/watch/options (repo.ActionWatchOptions,
 * routers/web/repo/watch.go:49-60): the custom watch menu — the modal's
 * form-fetch-action POSTs the picked events (fetch-action.ts:197-213's
 * `new FormData(formEl)`), Mode lands Custom with the three FormBool event
 * toggles (clearing every event is allowed — it leaves the participating
 * state, watch.go:50-54's comment), and the answer is ctx.JSONRedirect("") —
 * `{"redirect": ""}` — which the fetch-action JS turns into a page reload
 * (fetch-action.ts:74-79's empty-redirect arm). `form` is the parsed body
 * (the route adapter's URLSearchParams convention, ui/forms.ts's reader
 * shape).
 */
export async function repoWatchOptionsActionResponse(
  d1: D1Database,
  repo: RepoRow,
  viewer: Extract<Viewer, { kind: "user" }>,
  form: URLSearchParams,
): Promise<Response> {
  await watchRepoWithOptions(
    d1,
    repo.id,
    viewer.id,
    {
      mode: WatchMode.Custom,
      watchPullRequests: formBool(form.get("pull_requests")),
      watchIssues: formBool(form.get("issues")),
      watchReleases: formBool(form.get("releases")),
    },
    new Date(),
  );
  return fetchActionRedirectResponse("");
}
