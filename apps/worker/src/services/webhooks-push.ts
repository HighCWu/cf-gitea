/**
 * User-push webhook notifications (SPEC-0005 §3.5 fan-out point "push
 * pipeline") — the push/create/delete family emitted from the engine's
 * `onPush` seam.
 *
 * SEAM (packages/git-engine mod.ts:963-970): after `finalizeReceive` returns
 * `committed` with at least one applied ref update, the engine calls
 * `options.onPush({ repo, updates, commitTime }, env)` inside `ctx.waitUntil`
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
 *   - updated ref: the push event with the capped old→new commit list —
 *     `listCommitsRange(old, new, FeedMaxCommitNum)` = the engine's
 *     `rev-list --max-count` equivalent, rendered newest-first, with the
 *     `added/removed/modified` file lists enriched per commit and
 *     `head_commit` naming the new tip regardless of the cap.
 *
 * The builder lives HERE rather than in src/issues/webhooks.ts because it
 * composes api/services converters (`compareUrl`, `toPayloadCommit`,
 * `usernamesByEmail`) and api/services/hooks.ts already imports
 * issues/webhooks.ts — putting api imports under it would close a module
 * cycle. sync.ts's `notifyMirrorSyncDelta` now delegates here (one-for-one:
 * identity + walk seam are parameters — the mirror path passes the owner
 * identity and shares `engineWalk`).
 *
 * PUSHER IDENTITY — DEVIATION (documented, this wave): upstream sets
 * `pusher`/`sender` to the AUTHENTICATED user (services/repository/push.go
 * `opts.Pusher`); our engine's `PushEvent` carries no identity and the gate
 * resolves the D1 user only inside its own frame (git-http/acl.ts
 * `authorizeGitHttp`), so nothing at the seam names the pusher. Until the
 * engine plumbs the authenticated identity into `PushEvent` (engine-package
 * change, its own wave), the fan-out resolves the pusher exactly like the
 * mirror path does — the repository OWNER (upstream's mirror precedent,
 * mirror_pull.go:347 `m.Repo.MustOwner(ctx)` → notifier.go:919-920 sets both
 * `Pusher` and `Sender`). `handleUserPushNotifications` takes an explicit
 * `pusher` users-row override so the wiring upgrade is a one-argument change
 * once a seam provides the real identity.
 *
 * FAILURE POSTURE — the mirror wave's best-effort rule, unchanged: this runs
 * AFTER the receive committed (inside the engine's waitUntil), nothing here
 * may fail the push, per-ref errors log and continue (one ref's failure never
 * silences the others), and a fan-out error (owner resolution, hook query)
 * logs with the already-written delivery rows standing.
 */

import type { CommitJson, DiffResult, PushEvent } from "@cf-gitea/git-engine";

import { toPayloadCommit, usernamesByEmail } from "../api/services/git-models";
import { compareUrl } from "../api/services/hooks";
import {
  apiUserFromRow,
  findRepositoryById,
  findRepositoryByPath,
  toApiRepository,
  type RepositoryWithOwner,
  type UserRow,
  type Viewer,
} from "../api/services/repository";
import {
  enrichCommitsWithFileLists,
  emitWebhookDeliveries,
  type HookEventType,
} from "../issues/webhooks";
import { engineName, type RepoRow } from "../repos/service";

/** The bindings/vars the push fan-out touches (structural, sync.ts pattern). */
export interface WebhookPushEnv extends Env {
  /** Upstream `setting.AppURL` — the instance origin the §2.7 payload URLs
   *  are built against. Optional: HTTP paths take the origin from the request,
   *  and the engine's onPush seam carries none. Unset it falls back to
   *  upstream's own default ROOT_URL, `http://localhost:3000`
   *  (modules/setting/server.go:119-120) — payloads stay upstream-shaped and
   *  absolute, exactly like a default-installed gitea without ROOT_URL. */
  APP_URL?: string;
}

/** Go's zero oid — the create/delete marker of a receive command. */
export const PUSH_ZERO_OID = "0".repeat(40);

/** `setting.UI.FeedMaxCommitNum` (default 5, modules/setting/ui.go:92) — the
 *  push payload's commit cap (§2.5). */
export const FEED_MAX_COMMIT_NUM = 5;

/** Upstream's default ROOT_URL (modules/setting/server.go:119-120); AppURL
 *  additionally always carries the trailing "/" (server.go:50-51) —
 *  `appOrigin` returns it trimmed and the one site that renders the bare
 *  AppURL (the zero-commit push event's compare_url) appends the suffix
 *  explicitly. */
const DEFAULT_APP_URL = "http://localhost:3000";

/** `setting.AppURL` equivalent for the onPush seam (no request to take an
 *  origin from): the optional APP_URL var, trailing slashes trimmed like
 *  upstream's AppURL normalization (server.go:127-137). */
function appOrigin(env: WebhookPushEnv): string {
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
  /** Test clock for the delivery rows. */
  now?: Date;
  /** Log sink override (tests); default console.error. */
  log?: (message: string) => void;
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
 * falls back to the repository owner row — the documented deviation,
 * identical to the mirror path's upstream behavior.
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
    });
  } catch (error) {
    console.error(
      `[push-webhook] ${repo.ownerNamespace}/${repo.slug}: notification pipeline failed (the applied push stands): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The engine `PushEvent` (mod.ts:147-153) — the adapter consumes it verbatim
 *  so the entrypoint wiring stays a one-liner. */
export type PushEventLike = PushEvent;

/**
 * The engine onPush adapter — the shape the entrypoint's wiring passes as the
 * hook (`onPush: (event, env) => handleUserPushEvent(env, event)`). Resolves
 * the D1 repositories row from the event's combined name (case-folded — the
 * engine preserves request casing, D1 is lower-case) and hands the delta to
 * `handleUserPushNotifications`. Repositories without a D1 row (the
 * transitional engine-only population, incl. the e2e suite) and the receive
 * warm-up probes have no hooks to notify — silent no-op, never a log storm.
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
  await handleUserPushNotifications(env, pair.repo, updates, pair.owner);
}
