/**
 * Tag-store service — the ONE implementation of "create a git tag in the
 * engine" shared by every caller that must land a tag ref (SPEC-0004 §3.4
 * commit-builder mapping):
 *   - POST /repos/{owner}/{repo}/tags (routes/tags.ts — repoCreateTag);
 *   - POST /repos/{owner}/{repo}/releases with a fresh `tag_name`
 *     (services/releases.ts createReleaseWithGitTag — upstream auto-creates
 *     the release's git tag, services/release/release.go createTag).
 *
 * The two upstream surfaces order their shared checks differently
 * (tag.go:211-227 resolves target → duplicate → protected;
 * release.go:78-118 orders git-tag-exists → protected → target), so this
 * module exports the MECHANISM primitives — target resolution and the
 * serialize/CAS write — and each caller composes its own upstream checks
 * (existence probe, `isTagControlAllowed`) in its surface's exact order.
 *
 * Upstream citations (submodule pin fc4936884584):
 *   - target resolution: routers/api/v1/repo/tag.go CreateTag 209-218 —
 *     `IfZero(form.Target, DefaultBranch)` then `GetCommit(target)`, answered
 *     404 `target not found: %v`; GetCommit resolves a branch name, a tag
 *     name (peeled to its commit), or an object id.
 *   - the write: services/release/release.go createTag 110-127 — a
 *     `msg` creates an ANNOTATED tag object (CreateAnnotatedTag), otherwise a
 *     lightweight tag (CreateTag); both land `refs/tags/<name>` at the
 *     resolved commit.
 *   - the digest arm: a 40-hex `target` rides GetCommit verbatim. A 40-hex
 *     TAG-OBJECT oid would be peeled upstream (`sha^{commit}`); the engine's
 *     ref-table resolution treats a non-ref 40-hex as a commit oid (the
 *     landed tags-path behavior, kept byte-identical here) — a documented
 *     edge (SPEC-0004 §2.4), not a new divergence.
 *
 * The ref-webhook helpers (emitRefWebhook / zeroCommitPushPayload) moved
 * here from routes/tags.ts so the release path fires the SAME create/delete
 * payloads — upstream's release-created tags notify exactly like API-created
 * ones (release.go createTag 125-148: PushCommits + CreateRef).
 */

import { serializeTag } from "@cf-gitea/git-engine";
import type { Context } from "hono";

import { emitWebhookDeliveries, type HookEventType } from "../../issues/webhooks";
import type { WebhookDeliveryMessage } from "../../webhooks/consumer";
import type { ApiEnv } from "../env";
import { ApiError } from "../errors";
import {
  branchRef,
  commitApiChangeError,
  engineCell,
  engineReads,
  isFullObjectId,
  refTipMap,
  tagRef,
  ZERO_OID,
  type RefTip,
} from "./engine";
import { toApiRepository, viewerOf, type RepositoryWithOwner } from "./repository";

/** The creator identity the tagger render + protected-tag check read. */
export interface TagCreator {
  id?: number | null;
  login?: string | null;
  email?: string | null;
}

export interface TagStoreRepo {
  id: string;
  ownerNamespace: string;
  slug: string;
  defaultBranch: string;
}

/**
 * Resolve a create-target to its commit: an explicit `target` (branch name,
 * tag name — peeled, full ref, or 40-hex oid) or, when absent/empty, the
 * default branch WITHOUT the raw-ref arm (tag.go:209-211's IfZero — the
 * filled default is a branch name, not a user-typed ref).
 * Returns the ref-tip table too, so one listRefs serves the caller's
 * duplicate check (route tag.go:220's CreateNewTag IsReleaseExist).
 */
export async function resolveTagTarget(
  env: ApiEnv["Bindings"],
  pair: TagStoreRepo,
  target: string | undefined,
): Promise<{ tag: "ok"; commitSha: string; tips: Map<string, RefTip> } | { tag: "not-found"; target: string }> {
  const explicit = target !== undefined && target !== "";
  const refParam = explicit ? target : pair.defaultBranch;
  const tips = refTipMap(await engineReads(env, pair).listRefs());
  const tip =
    tips.get(branchRef(refParam)) ?? tips.get(tagRef(refParam)) ?? (explicit ? tips.get(refParam) : undefined);
  let sha: string | null;
  if (tip !== undefined) {
    if (tip.peeled !== undefined) {
      sha = tip.peeled;
    } else {
      const commit = await engineReads(env, pair).readCommit(tip.target);
      sha = commit === null ? null : commit.oid;
    }
  } else if (isFullObjectId(refParam)) {
    sha = refParam;
  } else {
    sha = null;
  }
  if (sha === null) {
    return { tag: "not-found", target: refParam };
  }
  return { tag: "ok", commitSha: sha, tips };
}

export interface WriteTagRefInput {
  /** The new tag's name (`refs/tags/<name>`). */
  name: string;
  /** The resolved commit the ref lands at. */
  commitSha: string;
  /** Non-empty → an ANNOTATED tag object (release.go:110-121). */
  message?: string;
  /** The creator — tagger identity (annotated) and nothing else here; the
   *  protected-tag check is the CALLER's, in its surface's order. */
  doer?: TagCreator | null;
  /** The request host, for the `<login>@noreply.<host>` tagger fallback. */
  requestHost: string;
}

export type WriteTagRefResult =
  | { tag: "written"; refTip: string; commitSha: string }
  | { tag: "invalid"; reason: string }
  | { tag: "conflict"; error: ApiError };

/**
 * Land `refs/tags/<name>`: the annotated object (serializeTag →
 * putApiObjects) when `message` is set, then the ref CAS (commitApiChange,
 * expectedOldOid = the zero oid). The duplicate/existence check is the
 * CALLER's (its surface orders it) — the CAS's expectedOldOid makes a raced
 * duplicate fail here as `conflict`.
 */
export async function writeTagRef(env: ApiEnv["Bindings"], pair: TagStoreRepo, input: WriteTagRefInput): Promise<WriteTagRefResult> {
  let newTarget = input.commitSha;
  if (input.message !== undefined && input.message !== "") {
    const now = Math.floor(Date.now() / 1000);
    const tag = serializeTag({
      object: input.commitSha,
      type: "commit",
      tag: input.name,
      tagger:
        input.doer === undefined || input.doer === null
          ? null
          : {
              name: input.doer.login ?? "gitea",
              email:
                input.doer.email === undefined || input.doer.email === null || input.doer.email === ""
                  ? `${input.doer.login ?? "gitea"}@noreply.${input.requestHost}`
                  : input.doer.email,
              time: now,
              tz: "+0000",
            },
      message: input.message,
    });
    const stored = await engineCell(env, pair).putApiObjects([{ oid: tag.oid, type: tag.type, data: tag.data }]);
    if (stored.tag !== "ok") {
      return { tag: "invalid", reason: stored.tag === "invalid" ? stored.reason : "tag object too large" };
    }
    newTarget = tag.oid;
  }
  const result = await engineCell(env, pair).commitApiChange({
    ref: tagRef(input.name),
    expectedOldOid: ZERO_OID,
    newOid: newTarget,
  });
  if (result.tag !== "committed") {
    if (result.tag === "invalid") {
      return { tag: "invalid", reason: result.reason };
    }
    return { tag: "conflict", error: commitApiChangeError(result) };
  }
  return { tag: "written", refTip: newTarget, commitSha: input.commitSha };
}

// ---------------------------------------------------------------------------
// The protected-tag gate is NOT centralized: both surfaces run the SAME
// check (isTagControlAllowed over listProtectedTags) but order it differently
// and answer different 422 bodies — the tags API "user not allowed to create
// protected tag" (tag.go:224-227) vs the release create "release tag name is
// protected [tag_name: …]" (release.go:279-282). Each caller composes it in
// its surface's exact position; an unresolvable viewer id evaluates as
// anonymous (0 — never allowlisted).
// ---------------------------------------------------------------------------
// Ref-webhook fan-out (moved verbatim from routes/tags.ts so the release
// path emits the identical create/delete payloads)
// ---------------------------------------------------------------------------

/** The `WEBHOOK_DELIVERY` Queue producer, when the binding is wired. */
function webhookDeliveryQueue(
  env: ApiEnv["Bindings"],
): { sendBatch(messages: { body: WebhookDeliveryMessage }[]): Promise<unknown> } | null {
  const candidate: unknown = (env as { WEBHOOK_DELIVERY?: unknown }).WEBHOOK_DELIVERY;
  if (candidate === undefined || candidate === null) return null;
  const queue = candidate as { sendBatch?: (messages: { body: WebhookDeliveryMessage }[]) => Promise<unknown> };
  return typeof queue.sendBatch === "function" ? { sendBatch: queue.sendBatch.bind(queue) } : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fan one committed tag ref write out as a `create`/`delete` event. `refName`
 * is the FULL ref, matching what the push family passes to the branch filter
 * (emitPushFamilyUpdates); the payload itself carries upstream's SHORT name.
 */
export async function emitRefWebhook(
  c: Context<ApiEnv>,
  pair: RepositoryWithOwner,
  eventType: Extract<HookEventType, "create" | "delete" | "push">,
  payload: unknown,
  refName: string,
): Promise<void> {
  let execCtx: { waitUntil(promise: Promise<unknown>): void } | undefined;
  try {
    execCtx = c.executionCtx;
  } catch {
    execCtx = undefined; // in-process caller (tests): no execution context
  }
  const queue = webhookDeliveryQueue(c.env);
  try {
    await emitWebhookDeliveries(
      c.env.DB,
      { repoId: pair.repo.id, ownerId: pair.repo.ownerId, eventType, payload, refName },
      {
        enqueue:
          queue !== null && execCtx !== undefined
            ? (deliveryIds) => {
                execCtx.waitUntil(
                  queue.sendBatch(deliveryIds.map((deliveryId) => ({ body: { deliveryId } }))).then(undefined, (error: unknown) => {
                    console.error(`[tags] delivery enqueue failed (${eventType}): ${errorMessage(error)}`);
                  }),
                );
              }
            : undefined,
      },
    );
  } catch (error) {
    console.error(`[tags] webhook fan-out failed (${eventType}): ${errorMessage(error)}`);
  }
}

/**
 * The zero-commit `push` payload around an API tag write — the push family's
 * created/deleted-ref shape (services/webhooks-push.ts:400-410, upstream's
 * mirror path: SyncPushCommits → notifier.go:901-909 with an empty
 * PushCommits struct, mirror_pull.go:347): FULL ref, before/after oids,
 * compare_url the bare origin + "/" (AppURL + CompareURL ""), no commits,
 * head_commit null, and `pusher` AND `sender` the authenticated caller
 * (notifier.go:919-920 — both apiPusher). Upstream's git-push/release tag
 * paths additionally set head_commit + a composed compare URL for created
 * tags (push.go:123-136, release.go:131-134) — the landed family already
 * emits the mirror-path shape for pushed tags, and this stays byte-identical
 * with it (the documented family-level deviation, not a new one).
 */
export function zeroCommitPushPayload(
  c: Context<ApiEnv>,
  pair: RepositoryWithOwner,
  ref: string,
  before: string,
  after: string,
): Record<string, unknown> {
  const sender = c.get("authUser") ?? null;
  return {
    ref,
    before,
    after,
    compare_url: `${viewerOf(c).origin}/`,
    commits: [],
    total_commits: 0,
    head_commit: null,
    repository: toApiRepository(viewerOf(c), pair),
    pusher: sender,
    sender,
  };
}
