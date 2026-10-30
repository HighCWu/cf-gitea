/**
 * The repo-header trio's POST action arms (usability B-4) — upstream web.go:
 * 1765-1772's action group at the pin:
 *
 *     m.Post("/action/{action:star|unstar}", reqSignIn, starsEnabled, repo.ActionStar)
 *     m.Post("/action/{action:watch|participate|ignore}", reqSignIn, repo.ActionWatch)
 *
 * reduced to the arms the landed substrate represents (routers/web/repo/
 * star.go:16-32 + watch.go:16-47): star/unstar over services/stars.ts's
 * counter-moving batch, watch/participate over services/repo-watchers.ts's
 * binary edge — upstream's "participate" IS the row's absence (models/repo/
 * watch.go:61-64: GetWatch's no-row dummy carries Mode None; ActionWatch's
 * participate case writes WatchModeNone, watch.go:27-29, which watchRepoByMode
 * lands as a row DELETE, :146-148). The ignore arm (WatchModeDont) and the
 * custom watch-options POST (/action/watch/options + the watch_options_modal)
 * are NOT built: the `watch.mode` column the landed schema does not carry is
 * their only substrate.
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
 * answer 200 text/html. Upstream's error ladder (repo.go:287-299) has no
 * landed arm here — star/watch writes carry no blocked/limit surfaces — so a
 * failing write propagates and the route answers its plain 500 (the landed
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
import { isWatchingRepo, unwatchRepo, watchRepo } from "../../api/services/repo-watchers";
import { isStarring, starRepo, unstarRepo } from "../../api/services/stars";
import { repositories } from "../../db/schema";
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
 *  re-reads GetWatch + the repository row for exactly these two inputs. */
export function renderRepoHeaderWatchFragment(repo: RepoRow, viewer: Viewer, watching: boolean): string {
  return renderToString(
    <RepoHeaderWatch repoLink={`/${repo.ownerNamespace}/${repo.slug}`} count={repo.numWatches} viewer={viewer} watching={watching} />,
  );
}

/** The per-viewer trio state for one repo page render (the HANDOFF recipe's
 *  loader extension — resolveUiRequest arms ctx.viewerWatchsRepo /
 *  ctx.viewerStarsRepo / ctx.viewerForkOfRepo from this for USER viewers;
 *  anonymous viewers skip the reads entirely, the ctx fields stay absent and
 *  the shell renders the login-link variants). One probe per edge:
 *  isWatchingRepo (repo_watchers), isStarring (stars), findForkByOwner
 *  (fork.tmpl's direct-link arm — the doer's own fork only, the one-fork
 *  reduction documented on shell.tsx's RepoHeaderFork). The fork probe
 *  projects to the shell's two-field shape (the row id is write-path data,
 *  never rendered). */
export async function loadRepoHeaderActionState(
  d1: D1Database,
  repoId: string,
  userId: number,
): Promise<{ watching: boolean; starring: boolean; fork: { ownerNamespace: string; slug: string } | null }> {
  const [watching, starring, fork] = await Promise.all([
    isWatchingRepo(d1, repoId, userId),
    isStarring(d1, userId, repoId),
    findForkByOwner(d1, repoId, userId),
  ]);
  return {
    watching,
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
 * POST /{owner}/{repo}/action/{watch|participate} (repo.ActionWatch's two
 * representable arms): watch → the edge insert (WatchModeNormal + all three
 * event toggles, watch.go:22-25), participate → the edge delete (WatchModeNone,
 * watch.go:27-29). The upstream ignore arm is unreachable by construction —
 * the recipe's parser claims exactly these two action segments.
 */
export async function repoWatchActionResponse(
  d1: D1Database,
  repo: RepoRow,
  viewer: Extract<Viewer, { kind: "user" }>,
  action: "watch" | "participate",
): Promise<Response> {
  if (action === "watch") {
    await watchRepo(d1, repo.id, viewer.id, new Date());
  } else {
    await unwatchRepo(d1, repo.id, viewer.id);
  }
  const [freshRow, watching] = await Promise.all([rereadRepoRow(d1, repo.id), isWatchingRepo(d1, repo.id, viewer.id)]);
  const html = renderRepoHeaderWatchFragment(freshRow, viewer, watching);
  return new Response(html, { status: 200, headers: { "content-type": "text/html;charset=utf-8" } });
}
