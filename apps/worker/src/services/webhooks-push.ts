/**
 * User-push webhook notifications (SPEC-0005 §3.5 fan-out point "push
 * pipeline") — the push/create/delete family emitted from the engine's
 * `onPush` seam.
 *
 * SEAM (packages/git-engine mod.ts:1043-1052): after `finalizeReceive` returns
 * `committed` with at least one applied ref update, the engine calls
 * `options.onPush({ repo, updates, commitTime, pusherId?, pusherLogin? }, env)`
 * inside `ctx.waitUntil`
 * — off the response path, with a catching wrapper so a throwing hook can
 * never fail an already-applied push. `updates` is the exact applied delta
 * (`FinalizeCommitted.updates`, control-plane.ts:208 — "applied updates for
 * the onPush hook — no truncation"): per entry `{ ref, old, new }` with the
 * zero oid marking create/delete, rejected commands already excluded. No
 * pre-receive ref snapshot (racy) and no post-receive listRefs diff are
 * needed — the engine hands over the delta itself.
 *
 * THE SHARED PER-REF PAYLOAD BUILDER: `emitPushFamilyUpdates` is the path-
 * independent core of upstream's post-receive notification split (the mirror
 * wave landed it as services/mirror/sync.ts `notifyMirrorSyncDelta`; upstream
 * user pushes take the same split — services/repository/push.go:185-197 →
 * services/webhook/notifier.go). Per applied ref, exactly:
 *
 *   - `refs/pull/*` deltas are never notified (GitHub's PR refs ride the
 *     mirror refspec upstream, mirror_pull.go:334-337; the engine accepts
 *     such pushes, so the filter is load-bearing here too);
 *   - created ref (old = zero oid): the zero-commit push event FIRST, then
 *     the create event (mirror_pull.go:347, 352 — upstream's order);
 *   - deleted ref (new = zero oid): the delete event (notifier.go:858-870);
 *   - updated BRANCH ref: the push event with the capped old→new commit list —
 *     `listCommitsRange(old, new, FeedMaxCommitNum)` = the engine's
 *     `rev-list --max-count` equivalent, rendered newest-first, with the
 *     `added/removed/modified` file lists enriched per commit and
 *     `head_commit` naming the new tip regardless of the cap — THEN the
 *     `pull_request_sync` event for every open github-flow PR whose head
 *     branch it is (notifier.go:835-845, fired upstream from exactly this
 *     path: pushUpdateBranch → AddTestPullRequestTask, push.go:292 —
 *     "only update branch can trigger pull request task because the pull
 *     request hasn't been created yet when creating a branch", so created and
 *     deleted refs never sync). Each event routes through the PR's BASE
 *     repository (`EventSource{Repository: pr.Issue.Repo}`) — for fork-head
 *     PRs that is a different repo than the one pushed to.
 *
 * The builder lives HERE rather than in src/issues/webhooks.ts because it
 * composes api/services converters (`compareUrl`, `toPayloadCommit`,
 * `usernamesByEmail`) and api/services/hooks.ts already imports
 * issues/webhooks.ts — putting api imports under it would close a module
 * cycle. sync.ts's `notifyMirrorSyncDelta` now delegates here (one-for-one:
 * identity + walk seam are parameters — the mirror path passes the owner
 * identity and shares `engineWalk`).
 *
 * PUSHER IDENTITY (CLOSED — was the documented deviation): upstream sets
 * `pusher`/`sender` to the AUTHENTICATED user (services/repository/push.go
 * `opts.Pusher`). The engine's `PushEvent` now carries that identity —
 * optional `pusherId`/`pusherLogin` — and the gate threads it onto its
 * receive-pack forwards as an in-process `engine.fetch` call argument, never
 * a request header: a receive CAN reach the engine with raw client headers
 * (the D1-missing transitional passthrough, git-http/gate.ts), where a
 * header would be forgeable; a call argument has no client-reachable path
 * (gate.ts `resolvePushPusher` states the analysis). `handleUserPushEvent`
 * resolves the id to the users row and uses it as pusher AND sender; the row
 * resolving to nothing (stale/deleted id) and every identity-less receive —
 * the engine-native transitional population, the mirror path — keep the
 * repository OWNER (upstream's mirror precedent, mirror_pull.go:347
 * `m.Repo.MustOwner(ctx)` → notifier.go:919-920 sets both `Pusher` and
 * `Sender`). `handleUserPushNotifications` keeps its explicit `pusher`
 * users-row override as the fan-out's seam.
 *
 * FAILURE POSTURE — the mirror wave's best-effort rule, unchanged: this runs
 * AFTER the receive committed (inside the engine's waitUntil), nothing here
 * may fail the push, per-ref errors log and continue (one ref's failure never
 * silences the others), and a fan-out error (owner resolution, hook query)
 * logs with the already-written delivery rows standing.
 *
 * The notification family is not the only onPush consumer:
 * `markStaleReviewsOnPush` (SPEC-0013 §3.4) rides the same seam beside
 * `emitPushFamilyUpdates` — the head-push stale/dismiss maintenance for open
 * PRs on the pushed branch — the repo_license settle leg
 * (`syncRepoLicensesFromCell`, services/repo-licenses.ts — upstream
 * push.go:160-174's default-branch license updater, the same never-fail
 * posture) and the repo-size settle leg (`syncRepoSizeFromStorage`,
 * services/repo-size.ts — upstream push.go:74-83's post-apply
 * UpdateRepoSize, every applied delta, the same never-fail posture).
 *
 * THE PR-HEAD SYNC (SPEC-0005 §3.4 "Sync pushes" — upstream UpdatePullsRefs +
 * CreatePushPullComment, wired from hook_post_receive.go:67 + push.go:292):
 * an updated BRANCH ref that is an open github-flow PR's head branch also
 * moves that PR's engine state, per PR, in the same drained hook —
 *   1. fork-head object carry (upstream FetchRemoteTempCommit, pull.go:556),
 *   2. CAS `refs/pull/N/head` old→new on the BASE cell (upstream git.UpdateRef,
 *      pull.go:560) — the MECHANISM NOTE: upstream's own arm runs POST-receive
 *      (hook_post_receive.go) as a separate fetch+UpdateRef transaction, so
 *      the standalone `commitApiChange` CAS (the PR-creation ref write,
 *      pull-engine.ts createPullHeadRef) is upstream's shape, not a deviation;
 *      the engine's `extraRefUpdates` seam (control-plane.ts §4.7) would ride
 *      the receive transaction but nothing can populate it from the Worker —
 *      mod.ts's receive path has no provider hook, and the engine documents
 *      the seam itself as best-effort housekeeping. CAS base = the live ref
 *      tip (the engine ref is authoritative over the head_sha cache); a lost
 *      race logs and skips the PR's remaining arms (the next push re-syncs),
 *   3. the D1 row: `head_sha`, `status=checking` (re-arming the lazy
 *      ensurePullRequestChecked) and the recomputed ahead/behind divergence,
 *      CAS-guarded by has_merged=0 (upstream UpdateColsIfNotMerged),
 *   4. the type-29 `pull_push` comment with the upstream PushActionContent
 *      shape (normal push = the capped oldest-first commit list; force push =
 *      the merge-base walk + the `{is_force_push, [old, new]}` comment + the
 *      old-comment reconcile), via IssuesService.addComment,
 * and then the pre-existing `pull_request_sync` webhook (last, like upstream
 * notify.PullRequestSynchronized). A DELETED head branch takes upstream's
 * AdjustPullsCausedByBranchDeleted arm instead (pull.go:622-655): the open
 * PRs on it close, each with the type-11 delete-branch comment.
 */

import type {
  ApiObject,
  CatalogPage,
  CommitJson,
  DiffResult,
  PushEvent,
  PutApiObjectsResult,
  TreeEntryJson,
} from "@cf-gitea/git-engine";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import { toApiPullRequest } from "../api/services/pulls";
import { toPayloadCommit, usernamesByEmail } from "../api/services/git-models";
import { compareUrl } from "../api/services/hooks";
import { branchRef, pullHeadRef } from "../api/services/engine";
import {
  apiUserFromRow,
  findRepositoryById,
  findRepositoryByPath,
  toApiRepository,
  type RepositoryWithOwner,
  type UserRow,
  type Viewer,
} from "../api/services/repository";
import { comments, issues, PRFlow, PRStatus, pullRequests, pullReviews, ReviewType, users } from "../db/schema";
import { CommentType } from "../issues/comment-types";
import { IssuesService } from "../issues/service";
import { carryLooseRefs, type CarrySource, type CarryTarget } from "../repos/carry";
import {
  enrichCommitsWithFileLists,
  emitWebhookDeliveries,
  type HookEventType,
} from "../issues/webhooks";
import { engineName, type RepoRow } from "../repos/service";
import { syncRepoLicensesFromCell } from "./repo-licenses";
import { syncRepoSizeFromStorage } from "./repo-size";
import { findRule, parseRuleConfig } from "./branch-protection";

/** DismissApprovalReviews' fixed comment text (services/pull/review.go:362). */
export const DISMISS_STALE_MESSAGE =
  "New commits pushed, approval review dismissed automatically according to repository settings";

/**
 * The bindings/vars the push fan-out touches: the generated Env members it
 * actually reads, picked (a wrangler.jsonc rename surfaces as a keyof error
 * HERE instead of hiding behind a stale generated file), plus the one config
 * var this module deliberately reads as runtime-optional. The generated Env
 * satisfies this structurally; WEBHOOK_DELIVERY stays out of the type — the
 * producer probe below looks it up structurally so a binding gap degrades to
 * `pending` delivery rows instead of a type-level requirement.
 */
export interface WebhookPushEnv extends Pick<Env, "DB" | "REPO" | "REPO_PACKS"> {
  /** Upstream `setting.AppURL` — the instance origin the §2.7 payload URLs
   *  are built against. Optional IN THIS SLICE (the generated Env types the
   *  declared var as required): HTTP paths take the origin from the request,
   *  and the engine's onPush seam carries none, so test/embedding envs may
   *  omit it. Unset it falls back to upstream's own default ROOT_URL,
   *  `http://localhost:3000` (modules/setting/server.go:119-120) — payloads
   *  stay upstream-shaped and absolute, exactly like a default-installed
   *  gitea without ROOT_URL. */
  APP_URL?: string;
}

/** Go's zero oid — the create/delete marker of a receive command. */
export const PUSH_ZERO_OID = "0".repeat(40);

/** `setting.UI.FeedMaxCommitNum` (default 5, modules/setting/ui.go:92) — the
 *  push payload's commit cap (§2.5). */
export const FEED_MAX_COMMIT_NUM = 5;

/** `maxPushCommitsInCommentCount` (services/pull/comment.go:21) — the type-29
 *  comment's commit cap; upstream keeps the NEWEST of a bigger delta
 *  (`rev-list --reverse -n limit`). */
export const MAX_PUSH_COMMITS_IN_COMMENT = 1000;

/** Upstream `PushActionContent` (models/issues/comment.go:375-381) — the
 *  type-29 comment's `content` JSON. */
interface PushActionContent {
  is_force_push: boolean;
  /** is_force_push=true: the [old head, new head] pair; else the pushed
   *  commits, oldest first. */
  commit_ids: string[];
}

/** Upstream's default ROOT_URL (modules/setting/server.go:119-120); AppURL
 *  additionally always carries the trailing "/" (server.go:50-51) —
 *  `appOrigin` returns it trimmed and the one site that renders the bare
 *  AppURL (the zero-commit push event's compare_url) appends the suffix
 *  explicitly. */
const DEFAULT_APP_URL = "http://localhost:3000";

/** `setting.AppURL` equivalent for the onPush seam (no request to take an
 *  origin from): the optional APP_URL var, trailing slashes trimmed like
 *  upstream's AppURL normalization (server.go:127-137). Exported for the
 *  other off-response emitters (the push-create settle) that build §2.7
 *  payload URLs without a request origin. */
export function appOrigin(env: WebhookPushEnv): string {
  return (env.APP_URL ?? DEFAULT_APP_URL).replace(/\/+$/, "");
}

/** Upstream `RefName.RefType` (modules/git/ref.go:221-231) reduced to the
 *  webhook's `branch|tag` vocabulary: anything that is neither prefix renders
 *  upstream's empty-string default. */
function refTypeOf(fullRef: string): string {
  if (fullRef.startsWith("refs/heads/")) return "branch";
  if (fullRef.startsWith("refs/tags/")) return "tag";
  return "";
}

/** Upstream `RefName.ShortName` (modules/git/ref.go:170-178): the branch/tag
 *  tail; any other ref keeps its full name. The `create`/`delete` payloads
 *  carry the short name (notifier.go:824, 861). */
function shortRefName(fullRef: string): string {
  if (fullRef.startsWith("refs/heads/")) return fullRef.slice("refs/heads/".length);
  if (fullRef.startsWith("refs/tags/")) return fullRef.slice("refs/tags/".length);
  return fullRef;
}

/** One applied ref update — the engine's `RefUpdate` shape ({ref, old, new};
 *  renamed to `next` here to match the receive-pipeline vocabulary). */
export interface PushRefUpdate {
  ref: string;
  /** zero oid = the ref was created by this push */
  old: string;
  /** zero oid = the ref was deleted by this push */
  next: string;
}

/**
 * The engine-read slice the payload construction needs. Satisfied by the repo
 * cell (`listCommitsRange` — the capped oldest-first range walk; `readDiff` —
 * one id = diff against the first parent; `readCommit` — the tip read) and
 * overridable in tests (the MirrorSyncOptions.fetchImpl precedent).
 */
export interface WebhookPushWalk {
  listCommitsRange(base: string, head: string, limit: number): Promise<{ commits: CommitJson[]; more: boolean } | null>;
  readDiff(id: string): Promise<DiffResult | null>;
  readCommit(id: string): Promise<CommitJson | null>;
}

/** The real walk: the repo cell of the notification's repository. Shared by
 *  the user-push wiring and the mirror path (sync.ts passes it as the walk
 *  seam — same cell either way: pair.repo IS the notified repository). */
export function engineWalk(env: WebhookPushEnv, pair: RepositoryWithOwner): WebhookPushWalk {
  const cell = env.REPO.getByName(engineName(pair.repo.ownerNamespace, pair.repo.slug));
  return {
    listCommitsRange: (base, head, limit) => cell.listCommitsRange(base, head, limit),
    readDiff: (id) => cell.readDiff(id),
    readCommit: (id) => cell.readCommit(id),
  };
}

/** The compat-frozen payload identity block: the serialized API objects every
 *  push-family payload embeds (SPEC-0005 §2.7 — same serializers as the REST
 *  responses). */
export interface WebhookPushIdentity {
  repository: unknown;
  pusher: unknown;
  sender: unknown;
}

export interface WebhookPushOptions {
  /** Test clock for the delivery rows (and every sync-arm timestamp). */
  now?: Date;
  /** Log sink override (tests); default console.error. */
  log?: (message: string) => void;
  /** The authenticated pusher's users-row id when the caller holds one —
   *  the sync arms' comment attribution (upstream CreatePushPullComment's
   *  Doer = the pusher, push.go:292). Undefined/null (the mirror path, an
   *  identity-less receive, tests) attributes the rows to no poster. */
  pusherId?: number | null;
}

/** The compat-frozen PushPayload field set (SPEC-0005 §2.7,
 *  modules/structs/hook.go:154-176). */
interface PushPayload {
  ref: string;
  before: string;
  after: string;
  compare_url: string;
  commits: unknown[];
  total_commits: number;
  head_commit: unknown;
  repository: unknown;
  pusher: unknown;
  sender: unknown;
}

/**
 * The `WEBHOOK_DELIVERY` Queue producer probe — the api/routes + mirror-sync
 * pattern: a structural lookup so a binding gap degrades to `pending`
 * delivery rows instead of a thrown error (the rows are the source of truth,
 * SPEC-0005 §3.6; the generated Env types the binding as required, this only
 * defends the runtime).
 */
function webhookDeliveryQueue(env: WebhookPushEnv): { sendBatch(messages: { body: { deliveryId: number } }[]): Promise<unknown> } | null {
  const candidate: unknown = (env as { WEBHOOK_DELIVERY?: unknown }).WEBHOOK_DELIVERY;
  if (candidate === undefined || candidate === null) return null;
  const queue = candidate as { sendBatch?: (messages: { body: { deliveryId: number } }[]) => Promise<unknown> };
  return typeof queue.sendBatch === "function" ? { sendBatch: queue.sendBatch.bind(queue) } : null;
}

/**
 * The shared per-ref fan-out: the push/create/delete family for one applied
 * updates delta (the module header documents the split). Never throws — the
 * caller runs it off the mutation's response path. `identity.pusher` and
 * `identity.sender` are the SAME serialized user (notifier.go:919-920);
 * `pair.owner.id` resolves owner-level hooks (SPEC-0005 §3.5 step 1's
 * repo ∪ owner ∪ system union, via `emitWebhookDeliveries`).
 */
export async function emitPushFamilyUpdates(
  env: WebhookPushEnv,
  pair: RepositoryWithOwner,
  identity: WebhookPushIdentity,
  updates: readonly PushRefUpdate[],
  walk: WebhookPushWalk,
  options: WebhookPushOptions = {},
): Promise<void> {
  const log = options.log ?? ((message: string) => console.error(message));
  // GitHub PR refs ride the receive, never the hooks (mirror_pull.go:334-337).
  const notifiable = updates.filter((update) => !update.ref.startsWith("refs/pull/"));
  if (notifiable.length === 0) return;

  try {
    const origin = appOrigin(env);
    const queue = webhookDeliveryQueue(env);
    const enqueue =
      queue === null
        ? undefined
        : async (deliveryIds: number[]): Promise<void> => {
            // The message is `{ deliveryId }` WRAPPED in the platform's
            // MessageSendRequest `{ body }` — the consumer reads
            // `message.body.deliveryId` (consumer.ts §3.6).
            await queue.sendBatch(deliveryIds.map((deliveryId) => ({ body: { deliveryId } })));
          };
    const emit = (eventType: HookEventType, payload: unknown, refName: string): Promise<unknown> =>
      emitWebhookDeliveries(
        env.DB,
        { repoId: pair.repo.id, ownerId: pair.owner.id, eventType, payload, refName },
        { enqueue, ...(options.now !== undefined ? { now: options.now } : {}) },
      );

    for (const update of notifiable) {
      try {
        if (update.old === PUSH_ZERO_OID && update.next !== PUSH_ZERO_OID) {
          // Created ref — the zero-commit push event, then the create event
          // (mirror_pull.go:347, 352 — upstream's emission order). The bare
          // AppURL with its trailing "/" is the zero-commit compare_url
          // (notifier.go:913 with CompareURL "" — ComposeCompareURL only runs
          // in the update branch).
          const push: PushPayload = {
            ref: update.ref,
            before: PUSH_ZERO_OID,
            after: update.next,
            compare_url: `${origin}/`,
            commits: [],
            total_commits: 0,
            head_commit: null,
            repository: identity.repository,
            pusher: identity.pusher,
            sender: identity.sender,
          };
          await emit("push", push, update.ref);
          await emit(
            "create",
            {
              sha: update.next,
              ref: shortRefName(update.ref),
              ref_type: refTypeOf(update.ref),
              repository: identity.repository,
              sender: identity.sender,
            },
            update.ref,
          );
          continue;
        }

        if (update.next === PUSH_ZERO_OID) {
          // Deleted ref — mirror_pull.go:358, notifier.go:858-870.
          await emit(
            "delete",
            {
              ref: shortRefName(update.ref),
              ref_type: refTypeOf(update.ref),
              pusher_type: "user",
              repository: identity.repository,
              sender: identity.sender,
            },
            update.ref,
          );
          // The delete webhook first, then the PR cascade (upstream
          // pushDeleteBranch order, push.go:296-311: notify DeleteRef, THEN
          // AdjustPullsCausedByBranchDeleted).
          if (update.ref.startsWith("refs/heads/")) {
            await closePullRequestsOfDeletedBranch(env, pair, update, options, log);
          }
          continue;
        }

        // Updated ref — the capped old→new walk (mirror_pull.go:363). The
        // repo cell's listCommitsRange IS the engine's `base..head` rev-list
        // equivalent: topological, parents-before-children, capped at the
        // limit, tag objects peeled (SPEC-0001b §4.1). It is OLDEST-first, so
        // the payload list reverses it into upstream's rev-list order
        // (newest-first).
        const range = await walk.listCommitsRange(update.old, update.next, FEED_MAX_COMMIT_NUM);
        if (range === null) {
          // Upstream logs and skips the ref (:364-367) — the other refs and
          // the push itself are unaffected.
          log(
            `[push-webhook] ${pair.repo.ownerNamespace}/${pair.repo.slug}: commit walk failed for ${update.ref} ` +
              `(${update.old.slice(0, 7)}..${update.next.slice(0, 7)}) — ref not notified`,
          );
          continue;
        }
        const usernames = await usernamesByEmail(env.DB, range.commits);
        // The payload model is the generated swagger shape (every field
        // optional); the enrichment contract needs the always-present `id`.
        // The renderer already set id = commit.oid (git-models.ts
        // toPayloadCommit) — the literal re-asserts it, which TypeScript
        // types as `PayloadCommit & { id: string }` with no cast.
        const rendered = [...range.commits].reverse().map((commit) => ({
          ...toPayloadCommit(commit, pair, usernames, origin),
          id: commit.oid,
        }));
        // Upstream's payload mapper fills added/removed/modified per commit
        // (ToAPIPayloadCommit's diff-tree); the shared enricher costs one
        // readDiff RPC per payload commit and degrades to the list-less
        // shape on any failure (its documented deviation).
        const enriched = await enrichCommitsWithFileLists(rendered, (id) => walk.readDiff(id));
        const commits = enriched.enriched ? enriched.commits : rendered;
        // head_commit — upstream renders the new tip from its own
        // GetCommit(newCommitID) read (:373-378), matched into the list by id
        // (ToAPIPayloadCommits). DEVIATION (the mirror wave's, kept for
        // parity): the range RPC caps the OLDEST-first order (page
        // semantics), while rev-list --max-count keeps the NEWEST five — so
        // when the delta exceeds the cap (range.more) the window lacks the
        // tip, and a peeled tag update never contains the tag oid. The tip
        // then gets its own readCommit read, producing the same shape
        // upstream's user-push payload has when its commits list is capped
        // after the fact (services/repository/push.go:185-192 — head_commit
        // names the tip regardless of the commits cap).
        let headCommit = commits.find((commit) => commit.id === update.next) ?? null;
        if (headCommit === null) {
          const tip = await walk.readCommit(update.next);
          // The tip rides the same enricher (upstream's mapper fills
          // head_commit's lists identically — modules/repository/commits.go:
          // 117-123); outside-the-window tip = one extra readDiff.
          if (tip === null) {
            headCommit = null;
          } else {
            const tipEnriched = await enrichCommitsWithFileLists(
              [{ ...toPayloadCommit(tip, pair, usernames, origin), id: tip.oid }],
              (id) => walk.readDiff(id),
            );
            headCommit = tipEnriched.commits[0]!;
          }
        }
        const push: PushPayload = {
          ref: update.ref,
          before: update.old,
          after: update.next,
          // ComposeCompareURL + the AppURL prefix (mirror_pull.go:375,
          // notifier.go:913 — ComposeCompareURL is origin-less, AppURL ends
          // with "/").
          compare_url: `${origin}/${compareUrl(pair, update.old, update.next)}`,
          commits,
          total_commits: commits.length,
          head_commit: headCommit,
          repository: identity.repository,
          pusher: identity.pusher,
          sender: identity.sender,
        };
        await emit("push", push, update.ref);
        // Branch updates pull the sync event along (push.go:292 — created
        // refs never sync, "the pull request hasn't been created yet when
        // creating a branch"; deletes close, they don't sync).
        if (update.ref.startsWith("refs/heads/")) {
          await emitPullRequestSyncs(env, pair, identity, origin, emit, log, update, options);
        }
      } catch (error) {
        // Per-ref resilience — upstream logs and continues (:343-345,
        // :364-367); one ref's failure never silences the others.
        log(
          `[push-webhook] ${pair.repo.ownerNamespace}/${pair.repo.slug}: notification failed for ${update.ref}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    // The fan-out itself (hook query, enqueue probe) failed — the applied
    // push stands (§3.5 step 3's post-commit posture).
    log(
      `[push-webhook] ${pair.repo.ownerNamespace}/${pair.repo.slug}: webhook fan-out failed (the applied push stands): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The `pull_request_sync` arm of an updated branch ref (upstream
 * PullRequestSynchronized, notifier.go:835-845) WITH the §3.4 head sync that
 * precedes it (AddTestPullRequestTask's per-PR loop, pull.go:388-407): for
 * every OPEN github-flow PR whose head is the pushed branch of THIS
 * repository (`GetUnmergedPullRequestsByHeadInfo` semantics — head_repo_id =
 * the pushed repo, head_branch = the pushed branch, unmerged; agit-flow PRs
 * are skipped upstream, pull.go:407-410) — run the sync arms (fork carry, ref
 * CAS, D1 row, type-29 comment), then one event with action="synchronized"
 * and the push's before/after oids. Each event routes through the PR's BASE
 * repository (`EventSource{Repository: pr.Issue.Repo}`, notifier.go:843) —
 * fork-head PRs notify the base repo's hooks, and the payload's
 * `repository`/`pull_request` render against that base — with the same
 * per-PR resilience the ref loop has (one PR's failure is logged, never
 * silencing the others). A failed sync arm skips THAT PR's remaining arms
 * (upstream's `continue`, pull.go:394-399) but the sync event still fires —
 * upstream's IsSync block re-iterates the full PR list regardless (:468).
 */
async function emitPullRequestSyncs(
  env: WebhookPushEnv,
  pushedPair: RepositoryWithOwner,
  identity: WebhookPushIdentity,
  origin: string,
  emit: (eventType: HookEventType, payload: unknown, refName: string) => Promise<unknown>,
  log: (message: string) => void,
  update: PushRefUpdate,
  options: WebhookPushOptions = {},
): Promise<void> {
  const branch = update.ref.slice("refs/heads/".length);
  const heads = await openPullRequestsByHeadInfo(env.DB, pushedPair.repo.id, branch, log, pushedPair);
  if (heads.length === 0) return;
  const viewer: Viewer = { origin, requester: null };
  for (const head of heads) {
    try {
      // Same-repo heads reuse the pair in hand; fork heads resolve their base.
      const basePair =
        head.pullRequest.baseRepoId === pushedPair.repo.id
          ? pushedPair
          : await findRepositoryById(env.DB, head.pullRequest.baseRepoId);
      if (basePair === null) {
        log(
          `[push-webhook] ${pushedPair.repo.ownerNamespace}/${pushedPair.repo.slug}: PR #${head.issue.index} base repo ` +
            `${head.pullRequest.baseRepoId} missing — sync event skipped`,
        );
        continue;
      }
      // The §3.4 sync arms (upstream PushToBaseRepo → CreatePushPullComment →
      // markPullRequestStatusAsChecking, pull.go:388-407) — a failure leaves
      // `synced` null and only skips the arms (the event still fires, like
      // upstream's independent IsSync loop).
      const synced = await syncPullRequestHead(env, pushedPair, basePair, head, update, options, log);
      await emit(
        "pull_request_sync",
        {
          action: "synchronized",
          before: update.old,
          after: update.next,
          number: head.issue.index,
          // Upstream's sync payload renders ToPayloadPullRequest (notifier.go:850)
          // — the isPayload arm: the head repo shows regardless of the (here
          // anonymous) doer, pulls.ts toApiPullRequest "payload" mode. The
          // synced row (head_sha/status already moved) renders when the arms
          // landed; upstream's payload reads the same moved state.
          pull_request: await toApiPullRequest(env.DB, viewer, basePair, head.issue, synced ?? head.pullRequest, "payload"),
          repository: toApiRepository(viewer, basePair),
          sender: identity.sender,
          commit_id: "",
        },
        update.ref,
      );
    } catch (error) {
      log(
        `[push-webhook] ${pushedPair.repo.ownerNamespace}/${pushedPair.repo.slug}: sync event failed for PR #${head.issue.index}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * `GetUnmergedPullRequestsByHeadInfo` (models/issues/pull_list.go:63-72) —
 * the open, unmerged, github-flow PRs whose head is `(headRepoId, branch)`.
 * The shared lookup of the sync arms (this file's three consumers: the sync
 * event, the review legs, the delete cascade).
 */
async function openPullRequestsByHeadInfo(
  db: D1Database,
  headRepoId: string,
  branch: string,
  log: (message: string) => void,
  pair: RepositoryWithOwner,
): Promise<Array<{ issue: typeof issues.$inferSelect; pullRequest: typeof pullRequests.$inferSelect }>> {
  try {
    return await drizzle(db)
      .select({ issue: issues, pullRequest: pullRequests })
      .from(pullRequests)
      .innerJoin(issues, eq(issues.id, pullRequests.issueId))
      .where(
        and(
          eq(pullRequests.headRepoId, headRepoId),
          eq(pullRequests.headBranch, branch),
          eq(pullRequests.hasMerged, false),
          eq(pullRequests.flow, PRFlow.Github),
          eq(issues.isClosed, false),
        ),
      )
      .all();
  } catch (error) {
    log(
      `[push-webhook] ${pair.repo.ownerNamespace}/${pair.repo.slug}: PR head lookup failed for refs/heads/${branch}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/**
 * Per-PR §3.4 sync arms, in upstream's AddTestPullRequestTask order
 * (services/pull/pull.go:388-407 — PushToBaseRepo → CreatePushPullComment →
 * StartPullRequestCheckImmediately; the divergence rides syncCommitDivergence,
 * update.go:213-222). Returns the moved PR row for the webhook payload, or
 * null when the arms failed/skipped (the row CAS-lost a merge, or the engine
 * refused). Never throws — the caller's per-PR catch is the last resort.
 */
async function syncPullRequestHead(
  env: WebhookPushEnv,
  pushedPair: RepositoryWithOwner,
  basePair: RepositoryWithOwner,
  head: { issue: typeof issues.$inferSelect; pullRequest: typeof pullRequests.$inferSelect },
  update: PushRefUpdate,
  options: WebhookPushOptions,
  log: (message: string) => void,
): Promise<typeof pullRequests.$inferSelect | null> {
  const { issue, pullRequest: pr } = head;
  try {
    const baseCell = env.REPO.getByName(engineName(basePair.repo.ownerNamespace, basePair.repo.slug));

    // 1. Fork-head object carry — upstream's FetchRemoteTempCommit
    // (pull.go:556-558) fetches the head commit into the base repo before the
    // ref move; ours carries the new tip's divergent closure fork→base through
    // carryLooseRefs (the PR-creation carry's exact posture, pull-engine.ts
    // carryForkHeadIntoBase — same primitives, sync-time trigger). Same-repo
    // heads need nothing: the pushed objects are already in the base cell.
    if (pr.baseRepoId !== pr.headRepoId) {
      const forkCell = env.REPO.getByName(engineName(pushedPair.repo.ownerNamespace, pushedPair.repo.slug));
      const baseSource = syncCarrySource(baseCell);
      await carryLooseRefs(
        syncCarrySource(forkCell),
        syncCarryTarget(baseCell),
        [{ name: branchRef(pr.headBranch), target: update.next }],
        null,
        await packedCatalogOids(baseSource),
        `${pushedPair.repo.ownerNamespace}/${pushedPair.repo.slug} -> ${basePair.repo.ownerNamespace}/${basePair.repo.slug} (pr-sync head carry)`,
      );
    }

    // 2. CAS refs/pull/N/head old→new (upstream git.UpdateRef, pull.go:560).
    // The CAS base is the LIVE ref tip — the engine ref is authoritative over
    // the head_sha cache (schema note) and a missing ref (pre-lint creation
    // rows) creates from the zero oid exactly like createPullHeadRef. An
    // already-moved ref (idempotent re-sync — upstream's "Only update refs
    // that actually changed?" FIXME) skips the write.
    const headRef = pullHeadRef(pr.index);
    const current = await baseCell.readCommit(headRef);
    const currentTip = current === null ? PUSH_ZERO_OID : current.oid;
    if (currentTip !== update.next) {
      const moved = await baseCell.commitApiChange({ ref: headRef, expectedOldOid: currentTip, newOid: update.next });
      if (moved.tag !== "committed") {
        // ref_conflict (a concurrent write won — the next push re-syncs),
        // invalid (unstored object — the carry above failed), importing
        // (fork import in flight): upstream logs and moves on.
        log(
          `[push-webhook] ${pushedPair.repo.ownerNamespace}/${pushedPair.repo.slug}: PR #${issue.index} head ref ` +
            `${headRef} move refused (${moved.tag}) — sync arms skipped`,
        );
        return null;
      }
    }

    // 3. The D1 row — head_sha cache, status=checking (re-arming the lazy
    // ensurePullRequestChecked, §3.4's check-queue equivalent) and the
    // recomputed ahead/behind (upstream syncCommitDivergence), CAS-guarded by
    // has_merged=0 (upstream UpdateColsIfNotMerged — never overwrite a merged
    // row). merge_base stays to the lazy check (upstream updates it from
    // checkIfPRContentChanged; our GET-observed check CASes the same column).
    const divergence = await baseCell.countDivergence(branchRef(pr.baseBranch), headRef);
    const updated = await drizzle(env.DB)
      .update(pullRequests)
      .set({
        headSha: update.next,
        status: PRStatus.Checking,
        ...(divergence !== null && divergence.tag === "ok" ? { commitsAhead: divergence.ahead, commitsBehind: divergence.behind } : {}),
      })
      .where(and(eq(pullRequests.id, pr.id), eq(pullRequests.hasMerged, false)))
      .returning();

    // 4. The type-29 push comment (CreatePushPullComment, pull.go before the
    // check — "so the comment is already in database when the status is
    // mergeable").
    await createPushPullComment(env, basePair, issue, pr, update, options, log);
    return updated[0] ?? null;
  } catch (error) {
    log(
      `[push-webhook] ${pushedPair.repo.ownerNamespace}/${pushedPair.repo.slug}: PR #${issue.index} head sync failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * `CreatePushPullComment` (services/pull/comment.go:68-136): the type-29
 * `pull_push` comment of one head push. Normal push = one comment carrying
 * the capped oldest-first pushed-commit list, ONLY when the list is non-empty
 * (shouldCreate); force push = the merge-base walk comment (always created,
 * errors logged-only) PLUS the `{is_force_push, [old, new]}` marker comment,
 * with the old-comment reconcile folded in first (upstream's clean-up runs in
 * the same transaction). Both walks read the BASE cell — upstream opens
 * pr.BaseRepo after PushToBaseRepo fetched the tip (comment.go:78-80).
 */
async function createPushPullComment(
  env: WebhookPushEnv,
  basePair: RepositoryWithOwner,
  issue: typeof issues.$inferSelect,
  pr: typeof pullRequests.$inferSelect,
  update: PushRefUpdate,
  options: WebhookPushOptions,
  log: (message: string) => void,
): Promise<void> {
  const baseCell = env.REPO.getByName(engineName(basePair.repo.ownerNamespace, basePair.repo.slug));
  // Force detection — upstream push.go:286-291 IsForcePush (commit.go:126-141:
  // old is NOT an ancestor of new; a read failure logs and defaults false).
  let isForcePush = false;
  if (update.old !== PUSH_ZERO_OID) {
    const ancestry = await baseCell.mergeBase(update.old, update.next);
    if (ancestry !== null && ancestry.tag === "ok") {
      isForcePush = ancestry.base !== update.old;
    }
  }

  let commitIds: string[];
  if (isForcePush) {
    // The force-push comment should always be created, so all walk errors are
    // ignored and logged only (comment.go:24-39): the whole PR commit list
    // merge_base..new, capped.
    const mb = await baseCell.mergeBase(branchRef(pr.baseBranch), update.next);
    commitIds =
      mb !== null && mb.tag === "ok" && mb.base !== null
        ? await newestLimitedCommitIds(baseCell, mb.base, update.next, log, basePair)
        : [];
  } else {
    // Normal push: only a non-empty PR needs the comment (comment.go:43-45).
    commitIds = await newestLimitedCommitIds(baseCell, update.old, update.next, log, basePair);
  }

  if (isForcePush) {
    commitIds = await reconcileForcePushComments(env.DB, issue.id, commitIds);
  }
  if (!isForcePush && commitIds.length === 0) {
    return; // upstream shouldCreate=false — nothing new was pushed
  }

  const service = new IssuesService(env.DB);
  const now = options.now ?? new Date();
  const posterId = options.pusherId ?? null;
  if (commitIds.length > 0) {
    await service.addComment({
      issueId: issue.id,
      type: CommentType.PullRequestPush,
      posterId,
      content: JSON.stringify({ is_force_push: false, commit_ids: commitIds } satisfies PushActionContent),
      now,
    });
  }
  if (isForcePush) {
    // The force-push marker comment — CommitIDs is the [old head, new head]
    // pair (models/issues/comment.go:376-381).
    await service.addComment({
      issueId: issue.id,
      type: CommentType.PullRequestPush,
      posterId,
      content: JSON.stringify({ is_force_push: true, commit_ids: [update.old, update.next] } satisfies PushActionContent),
      now,
    });
  }
}

/**
 * The newest-capped `start..end` commit-id list, oldest-first — upstream
 * `rev-list --reverse -n limit start..end` (comment.go:47-55 keeps the NEWEST
 * `limit` of the range). The engine's listCommitsRange caps a page keeping the
 * OLDEST (its page semantics), so the newest window is collected by paging;
 * bounded at two pages of the cap (2×1000 walked) — a bigger single push
 * degrades to the newest ~1000 of the first two pages, logged (the one
 * documented deviation from upstream's exact window).
 */
async function newestLimitedCommitIds(
  cell: { listCommitsRange(base: string, head: string, limit: number, page?: number): Promise<{ commits: Array<{ oid: string }>; more: boolean } | null> },
  start: string,
  end: string,
  log: (message: string) => void,
  pair: RepositoryWithOwner,
): Promise<string[]> {
  const collected: string[] = [];
  for (let page = 0; page < 2; page += 1) {
    const result = await cell.listCommitsRange(start, end, MAX_PUSH_COMMITS_IN_COMMENT, page);
    if (result === null) {
      // Unresolvable side — upstream's rev-list error path (comment.go:55-58)
      // fails the comment; the sync's never-fail posture logs instead.
      log(`[push-webhook] ${pair.repo.ownerNamespace}/${pair.repo.slug}: push-comment walk ${start.slice(0, 7)}..${end.slice(0, 7)} failed`);
      return collected.length > 0 ? collected.slice(-MAX_PUSH_COMMITS_IN_COMMENT) : [];
    }
    for (const commit of result.commits) collected.push(commit.oid);
    if (!result.more) break;
    if (page === 1) {
      log(`[push-webhook] ${pair.repo.ownerNamespace}/${pair.repo.slug}: push-comment walk truncated at ${collected.length} commits`);
    }
  }
  return collected.slice(-MAX_PUSH_COMMITS_IN_COMMENT);
}

/**
 * Upstream's force-push comment reconcile
 * (comment.go:41-66 reconcileOldCommitCommentsForNewForcePush): every old
 * NON-force type-29 comment of the issue keeps only commit ids still present
 * in the new force list (emptied comments are deleted, others re-serialized),
 * and ids covered by a surviving old comment are removed from the new list
 * (the new comment carries only NEW ids). Old force-push comments are kept
 * verbatim. Counter-neutral, like upstream's raw update/delete. Parse
 * failures skip the comment (upstream `continue`).
 */
async function reconcileForcePushComments(db: D1Database, issueId: number, newCommitIds: string[]): Promise<string[]> {
  const oldComments = await drizzle(db)
    .select()
    .from(comments)
    .where(and(eq(comments.issueId, issueId), eq(comments.type, CommentType.PullRequestPush)))
    .all();
  const pending = new Set(newCommitIds);
  const deleteIds: number[] = [];
  const updates: Array<{ id: number; content: string }> = [];
  for (const old of oldComments) {
    let data: PushActionContent;
    try {
      data = JSON.parse(old.content ?? "") as PushActionContent;
    } catch {
      continue;
    }
    if (data.is_force_push === true) continue;
    const kept = data.commit_ids.filter((id) => pending.has(id));
    if (kept.length === 0) {
      deleteIds.push(old.id);
      continue;
    }
    for (const id of kept) pending.delete(id);
    if (kept.length !== data.commit_ids.length) {
      updates.push({ id: old.id, content: JSON.stringify({ is_force_push: false, commit_ids: kept }) });
    }
  }
  const statements: Parameters<DrizzleD1Database["batch"]>[number][number][] = [];
  if (deleteIds.length > 0) {
    statements.push(drizzle(db).delete(comments).where(inArray(comments.id, deleteIds)));
  }
  for (const update of updates) {
    statements.push(drizzle(db).update(comments).set({ content: update.content }).where(eq(comments.id, update.id)));
  }
  for (const statement of statements) {
    await drizzle(db).batch([statement]);
  }
  return [...pending];
}

/**
 * Upstream `AdjustPullsCausedByBranchDeleted` (services/pull/pull.go:622-655,
 * fired from pushDeleteBranch, push.go:296-311) — a deleted BRANCH closes
 * every open unmerged github-flow PR whose head it is, each with the type-11
 * delete-branch comment (AddDeletePRBranchComment, issue_update.go:250-264 —
 * `old_ref` carries the branch name). Already-closed PRs are tolerated
 * (upstream skips IsErrIssueIsClosed). DEVIATION: the close webhook
 * (upstream IssueChangeStatus) is deferred — the payload builder lives in the
 * pulls route module; the close itself lands through IssuesService so every
 * read renders closed. The engine's refs/pull/N/head survives, like upstream
 * (only merged-PR cleanup deletes it).
 */
async function closePullRequestsOfDeletedBranch(
  env: WebhookPushEnv,
  pushedPair: RepositoryWithOwner,
  update: PushRefUpdate,
  options: WebhookPushOptions,
  log: (message: string) => void,
): Promise<void> {
  const branch = update.ref.slice("refs/heads/".length);
  const heads = await openPullRequestsByHeadInfo(env.DB, pushedPair.repo.id, branch, log, pushedPair);
  const now = options.now ?? new Date();
  for (const head of heads) {
    try {
      const service = new IssuesService(env.DB);
      try {
        await service.closeIssue(head.issue.id, { actorId: options.pusherId ?? null, now });
      } catch {
        // already closed — upstream tolerates IsErrIssueIsClosed (pull.go:646)
      }
      // The type-11 comment + the num_comments bump in one batch (the
      // issue-tables discipline of the dismiss leg above; upstream's
      // CreateComment folds the same two writes).
      await drizzle(env.DB).batch([
        drizzle(env.DB).insert(comments).values({
          type: CommentType.DeleteBranch,
          posterId: options.pusherId ?? null,
          issueId: head.issue.id,
          oldRef: branch,
          createdAt: now,
        }),
        drizzle(env.DB)
          .update(issues)
          .set({ numComments: sql`num_comments + 1`, updatedAt: now })
          .where(eq(issues.id, head.issue.id)),
      ]);
    } catch (error) {
      log(
        `[push-webhook] ${pushedPair.repo.ownerNamespace}/${pushedPair.repo.slug}: branch-delete cascade failed for PR #${head.issue.index}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// The sync carry adapters — pull-engine.ts's carrySource/carryTarget take a
// full ApiEnv Context, which the onPush seam does not have; these are the
// same structural wrappers over the raw cell stub (the fork-task.ts
// intersection-stripping style).
// ---------------------------------------------------------------------------

/** Structural CarrySource over one cell (see pull-engine.ts carrySource —
 *  the async wrappers strip the RPC stub's `Promise & Pick` intersections so
 *  the structural assignment infers). */
function syncCarrySource(cell: {
  listRefs(): Promise<{ head: string | null; refs: { name: string; target: string; peeled?: string }[] }>;
  listCatalogPage(afterPackKey: string, limit: number): Promise<CatalogPage>;
  readCommit(id?: string): Promise<CommitJson | null>;
  listTree(ref?: string, path?: string): Promise<{ oid: string; entries: TreeEntryJson[] } | null>;
  readBlob(ref: string | undefined, path: string): Promise<{ oid: string; mode: string; data: Uint8Array } | null>;
}): CarrySource {
  return {
    listRefs: async () => {
      const refs = await cell.listRefs();
      return {
        head: refs.head,
        refs: refs.refs.map((ref) => ({ name: ref.name, target: ref.target, ...(ref.peeled === undefined ? {} : { peeled: ref.peeled }) })),
      };
    },
    listCatalogPage: (after, limit) => cell.listCatalogPage(after, limit),
    readCommit: (id) => cell.readCommit(id),
    listTree: (ref, path) => cell.listTree(ref, path),
    readBlob: (ref, path) => cell.readBlob(ref, path),
  };
}

/** putApiObjects adapter over a cell (see pull-engine.ts carryTarget). */
function syncCarryTarget(cell: { putApiObjects(objects: ApiObject[]): Promise<PutApiObjectsResult> }): Pick<CarryTarget, "putApiObjects"> {
  return { putApiObjects: (objects) => cell.putApiObjects(objects) };
}

/** The cell's ACTIVE pack catalog oids — the carry walk's skip set
 *  (pull-engine.ts packedCatalogOids). */
async function packedCatalogOids(source: CarrySource): Promise<Set<string>> {
  const packed = new Set<string>();
  let cursor = "";
  for (;;) {
    const page = await source.listCatalogPage(cursor, 8192);
    for (const pack of page.packs) {
      for (const row of pack.rows) packed.add(row.oid);
    }
    cursor = page.nextAfter;
    if (!page.more) break;
  }
  return packed;
}

export interface UserPushNotificationOptions {
  /** Test seam — override the engine walk (the fetchImpl precedent). */
  walk?: WebhookPushWalk;
  /** Test clock for the delivery rows. */
  now?: Date;
}

/**
 * The clean entry for the engine's onPush wiring: the push-family
 * notifications for one applied updates delta on one repository. Resolves the
 * repo+owner pair (an org-owned repository has no users row yet — degrade to
 * a log, like the mirror path), serializes the payload identity, and fans out
 * through `emitPushFamilyUpdates`. Never throws; awaits the fan-out so a
 * `waitUntil` caller gets real back-pressure.
 *
 * `pusher` is the AUTHENTICATED user's row when the caller holds one (the
 * payload's `pusher` AND `sender` — upstream `opts.Pusher`); undefined/null
 * falls back to the repository owner row — upstream's mirror behavior, and
 * the shape of every identity-less receive (the engine-native transitional
 * population and the mirror path).
 */
export async function handleUserPushNotifications(
  env: WebhookPushEnv,
  repo: RepoRow,
  updates: readonly PushRefUpdate[],
  pusher?: UserRow | null,
  options: UserPushNotificationOptions = {},
): Promise<void> {
  try {
    const pair = await findRepositoryById(env.DB, repo.id);
    if (pair === null) {
      // An org-owned repository has no users row yet (orgs are still
      // landing); upstream's MustOwner would panic — we degrade to a log.
      console.error(`[push-webhook] ${repo.ownerNamespace}/${repo.slug}: owner row missing — webhook notifications skipped`);
      return;
    }
    const origin = appOrigin(env);
    const viewer: Viewer = { origin, requester: null };
    const sender = apiUserFromRow(pusher ?? pair.owner, viewer);
    const identity: WebhookPushIdentity = {
      repository: toApiRepository(viewer, pair),
      pusher: sender,
      sender,
    };
    const walk = options.walk ?? engineWalk(env, pair);
    await emitPushFamilyUpdates(env, pair, identity, updates, walk, {
      ...(options.now !== undefined ? { now: options.now } : {}),
      // The sync arms' comment attribution rides the authenticated pusher
      // (upstream CreatePushPullComment's Doer); null attributes to no poster.
      pusherId: pusher?.id ?? null,
    });
  } catch (error) {
    console.error(
      `[push-webhook] ${repo.ownerNamespace}/${repo.slug}: notification pipeline failed (the applied push stands): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The engine `PushEvent` — the adapter consumes it verbatim so the
 *  entrypoint wiring stays a one-liner. */
export type PushEventLike = PushEvent;

export interface PushReviewLegsOptions {
  /** Test clock for the comment rows. */
  now?: Date;
  /** Log sink override (tests); default console.error. */
  log?: (message: string) => void;
}

/**
 * The §3.4(f) head-push legs (SPEC-0013): for every open github-flow PR whose
 * HEAD branch is an UPDATED branch of the pushed repo (the exact sync filter
 * of emitPullRequestSyncs — created/deleted refs never ride, push.go:292),
 * run upstream's push-time review maintenance (services/pull/pull.go:425–461):
 *
 *   1. content changed? — checkIfPRContentChanged (:503–538) compares the
 *      PR's patch range old→new; the bounded port diffs both tips against
 *      their merge bases in the pushed repo's cell and compares the results
 *      (same-repo heads, the only population today; a fork-head read failure
 *      degrades to "unchanged" with upstream's log-and-continue posture,
 *      :529–535).
 *   2. changed → MarkReviewsAsStale (:440, models/issues/review.go:623–628 —
 *      EVERY review row of the issue), then — when the BASE branch's rule
 *      sets dismiss_stale_approvals — DismissApprovalReviews (:444–453,
 *      services/pull/review.go:338–380): the undismissed approvals flip
 *      `dismissed` and each lands a `CommentTypeDismissReview` comment with
 *      the fixed text + the num_comments bump (the landed issue-tables
 *      discipline).
 *   3. MarkReviewsAsNotStale against the new tip (:455, review.go:630–635) —
 *      unconditionally, reviews made against the new tip are un-staled even
 *      when the diff check failed.
 *
 * Budget: bounded D1 writes per open PR on the pushed branch (the OQ-3
 * instrument is the rewritten-row count), inline under the onPush hook's 30 s
 * waitUntil cap at hobby scale. Never throws — per-PR resilience, one PR's
 * failure is logged and never silences the others, mirroring the fan-out.
 */
export async function markStaleReviewsOnPush(
  env: WebhookPushEnv,
  pushedPair: RepositoryWithOwner,
  updates: readonly PushRefUpdate[],
  pusher?: UserRow | null,
  options: PushReviewLegsOptions = {},
): Promise<void> {
  const log = options.log ?? ((message: string) => console.error(message));
  for (const update of updates) {
    if (!update.ref.startsWith("refs/heads/")) continue;
    if (update.old === PUSH_ZERO_OID || update.next === PUSH_ZERO_OID) continue;
    const branch = update.ref.slice("refs/heads/".length);
    const heads = await openPullRequestsByHeadInfo(env.DB, pushedPair.repo.id, branch, log, pushedPair);
    if (heads.length === 0) continue;
    for (const head of heads) {
      try {
        await applyPushReviewLegs(env, pushedPair, head, update, pusher, log, options);
      } catch (error) {
        log(
          `[push-webhook] ${pushedPair.repo.ownerNamespace}/${pushedPair.repo.slug}: stale/dismiss legs failed for PR #${head.issue.index}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

/** The per-PR leg body (the 3-step maintenance above). */
async function applyPushReviewLegs(
  env: WebhookPushEnv,
  pushedPair: RepositoryWithOwner,
  head: { issue: typeof issues.$inferSelect; pullRequest: typeof pullRequests.$inferSelect },
  update: PushRefUpdate,
  pusher: UserRow | null | undefined,
  log: (message: string) => void,
  options: PushReviewLegsOptions,
): Promise<void> {
  const { issue, pullRequest } = head;
  const db = drizzle(env.DB);

  // Step 1 — the content-change detection. Both tips and their merge bases
  // read in the PUSHED repo's cell (the head commits live there; the
  // same-repo-head population is exact, fork heads degrade below). Direct
  // cell reads — engineReads types the full generated Env, this module's
  // WebhookPushEnv is the structural Pick; a thrown RPC failure is the
  // per-PR catch's business (logged, legs skipped for that PR).
  let changed = false;
  const cell = env.REPO.getByName(engineName(pushedPair.repo.ownerNamespace, pushedPair.repo.slug));
  const baseTip = await cell.readCommit(branchRef(pullRequest.baseBranch));
  if (baseTip === null) {
    log(
      `[push-webhook] ${pushedPair.repo.ownerNamespace}/${pushedPair.repo.slug}: PR #${issue.index} base branch ` +
        `${pullRequest.baseBranch} unreadable — stale marking skipped`,
    );
  } else {
    const oldMergeBase = await cell.mergeBase(baseTip.oid, update.old);
    const newMergeBase = await cell.mergeBase(baseTip.oid, update.next);
    if (oldMergeBase.tag !== "ok" || oldMergeBase.base === null || newMergeBase.tag !== "ok" || newMergeBase.base === null) {
      log(
        `[push-webhook] ${pushedPair.repo.ownerNamespace}/${pushedPair.repo.slug}: PR #${issue.index} merge-base read failed — ` +
          `stale marking skipped (upstream's log-and-continue, pull.go:529-535)`,
      );
    } else {
      const oldDiff = await cell.readDiff(update.old, oldMergeBase.base);
      const newDiff = await cell.readDiff(update.next, newMergeBase.base);
      if (oldDiff === null || newDiff === null) {
        log(
          `[push-webhook] ${pushedPair.repo.ownerNamespace}/${pushedPair.repo.slug}: PR #${issue.index} diff read failed — ` +
            `stale marking skipped (upstream's log-and-continue, pull.go:529-535)`,
        );
      } else {
        // The content comparison covers the FILE list only — the DiffResult
        // envelope carries the tip oids, which differ on every push by
        // definition (upstream compares `git diff --name-only` output,
        // pull.go:516).
        changed = JSON.stringify(oldDiff.files) !== JSON.stringify(newDiff.files);
      }
    }
  }

  const now = options.now ?? new Date();
  if (changed) {
    // Step 2a — MarkReviewsAsStale: EVERY review row of the issue
    // (models/issues/review.go:625 — no type filter upstream either).
    await db.update(pullReviews).set({ stale: true, updatedAt: now }).where(eq(pullReviews.issueId, issue.id)).run();

    // Step 2b — DismissApprovalReviews under the BASE rule's
    // dismiss_stale_approvals (services/pull/pull.go:444–453).
    const baseRule = await findRule(env.DB, pullRequest.baseRepoId, pullRequest.baseBranch);
    if (baseRule !== null && parseRuleConfig(baseRule.rules).dismissStaleApprovals) {
      const approvals = await db
        .select({ id: pullReviews.id })
        .from(pullReviews)
        .where(and(eq(pullReviews.issueId, issue.id), eq(pullReviews.type, ReviewType.Approve), eq(pullReviews.dismissed, false)))
        .all();
      for (const approval of approvals) {
        await db.batch([
          db.update(pullReviews).set({ dismissed: true, updatedAt: now }).where(eq(pullReviews.id, approval.id)),
          db.insert(comments).values({
            type: CommentType.DismissReview,
            posterId: pusher?.id ?? null,
            issueId: issue.id,
            content: DISMISS_STALE_MESSAGE,
            reviewId: approval.id,
            createdAt: now,
            updatedAt: now,
          }),
          db.update(issues).set({ numComments: sql`num_comments + 1`, updatedAt: now }).where(eq(issues.id, issue.id)),
        ]);
      }
    }
  }

  // Step 3 — MarkReviewsAsNotStale against the new tip (runs even when the
  // diff check failed, upstream :455).
  await db
    .update(pullReviews)
    .set({ stale: false, updatedAt: now })
    .where(and(eq(pullReviews.issueId, issue.id), eq(pullReviews.commitId, update.next)))
    .run();
}

/**
 * The engine onPush adapter — the shape the entrypoint's wiring passes as the
 * hook (`onPush: (event, env) => handleUserPushEvent(env, event)`). Resolves
 * the D1 repositories row from the event's combined name (case-folded — the
 * engine preserves request casing, D1 is lower-case) and hands the delta to
 * `handleUserPushNotifications`. The gate-threaded identity
 * (`event.pusherId`, an in-process engine call argument — see the header)
 * resolves to the users row and names the payload's pusher/sender; a row that
 * no longer resolves and every identity-less receive (repositories without a
 * D1 row — the transitional engine-only population, incl. the e2e suite — and
 * the receive warm-up probes) have no hooks or fall back to the owner —
 * silent no-op or owner attribution, never a log storm.
 */
export async function handleUserPushEvent(env: WebhookPushEnv, event: PushEventLike): Promise<void> {
  if (event.updates.length === 0) return;
  const slash = event.repo.indexOf("/");
  if (slash === -1) return;
  const owner = event.repo.slice(0, slash).toLowerCase();
  const slug = event.repo.slice(slash + 1).replace(/\.git$/, "").toLowerCase();
  const pair = await findRepositoryByPath(env.DB, owner, slug);
  if (pair === null) return;
  // The engine names the applied tip `new`; the receive-pipeline vocabulary
  // (and every payload builder below) says `next`.
  const updates = event.updates.map((update) => ({ ref: update.ref, old: update.old, next: update.new }));
  // The authenticated pusher when the id still resolves to a row; anything
  // else (stale id, identity-less receive) leaves null and the fan-out falls
  // back to the repository owner (the mirror precedent).
  let pusher: UserRow | null = null;
  if (event.pusherId !== undefined) {
    pusher = (await drizzle(env.DB).select().from(users).where(eq(users.id, event.pusherId)).get()) ?? null;
  }
  await handleUserPushNotifications(env, pair.repo, updates, pusher);
  // SPEC-0013 §3.4 — the head-push stale/dismiss legs beside the notification
  // fan-out (same never-fail-the-push posture: the applied push stands).
  try {
    await markStaleReviewsOnPush(env, pair, updates, pusher);
  } catch (error) {
    console.error(
      `[push-webhook] ${pair.repo.ownerNamespace}/${pair.repo.slug}: stale/dismiss legs failed (the applied push stands): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // The repo_license table rides the same settle seam (upstream
  // services/repository/push.go:160-174: a default-branch create/update
  // enqueues the license updater; deletes and every other ref don't; the
  // per-entry continue-on-error and the unborn-tip guard live in the called
  // port). Same never-fail-the-push posture: caught and logged, the applied
  // push stands — runs inside the engine's onPush waitUntil like the legs
  // above.
  try {
    await syncRepoLicensesFromCell(
      env.DB,
      env.REPO.getByName(engineName(pair.repo.ownerNamespace, pair.repo.slug)),
      pair.repo,
      updates,
    );
  } catch (error) {
    console.error(
      `[push-webhook] ${pair.repo.ownerNamespace}/${pair.repo.slug}: license sync failed (the applied push stands): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // The repository size rides the same settle seam (upstream
  // services/repository/push.go:74-83: UpdateRepoSize runs ONCE per applied
  // receive, before the per-ref loop — no ref filter, unlike the license
  // leg's default-branch gate). The R2 walk is metadata-only (list, no
  // bodies); same never-fail-the-push posture: caught and logged, the
  // applied push stands — runs inside the engine's onPush waitUntil like the
  // legs above.
  try {
    await syncRepoSizeFromStorage(env.REPO_PACKS, env.DB, pair.repo);
  } catch (error) {
    console.error(
      `[push-webhook] ${pair.repo.ownerNamespace}/${pair.repo.slug}: size sync failed (the applied push stands): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
