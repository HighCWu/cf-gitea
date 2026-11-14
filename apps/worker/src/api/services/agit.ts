/**
 * The agit push-to-propose lane (census B-52 — upstream `refs/for/*`).
 *
 * Upstream shape at the pin (fc493688): a receive-pack whose commands touch
 * `refs/for/<target-branch>[/<topic>]` is routed to the proc-receive hook
 * (`receive.procReceiveRefs = refs/for`, modules/git/config.go:77); the hook
 * calls `agit.ProcReceive` (services/agit/agit.go) which creates or updates a
 * same-repo pull request from the pushed tip and the `topic`/`title`/
 * `description` push options (the `{base64}` prefix decodes), then reports
 * rewritten refs back through the proc-receive protocol (cmd/hook.go
 * runHookProcReceive): the client's `refs/for/...` command is reported ok/ng
 * against the ORIGINAL ref name while the real write lands on
 * `refs/pull/<index>/head` (`UpdateRefForAgit`, services/pull/pull.go:586;
 * `GetGitHeadRefName`, models/issues/pull.go:406). The permission gates live
 * inside the create arm: the blocked-by-owner check
 * (`NewPullRequest`, services/pull/pull.go:66-68 → the hook's UserMsg
 * "Cannot create pull request because you are blocked by the repository
 * owner.", routers/private/hook_proc_receive.go:37-39) and the AGit flow's
 * collaborator-gate SKIP (`canCreate := poster.IsAdmin || Flow == AGit`,
 * pull.go:71 — any pusher who passed write auth may propose; the protected
 * branch itself is not consulted, that is the point of proposing).
 *
 * OUR adaptation — the vendored engine (packages/git-engine) has no
 * proc-receive capability and its receive flow is reject-only
 * (`PushValidator`, mod.d.ts): no hook can rewrite a ref. The gate therefore
 * plays receive-pack itself at the wire level, around an ordinary engine
 * receive:
 *
 *   1. Before the forward it parses the receive-pack request's pkt-line
 *      sections (commands + capabilities + push options — never the pack,
 *      which keeps streaming), plans every `refs/for/*` command against D1
 *      and the repo's branch universe (`planAgitCommands` — the
 *      `ProcReceive` walk), and REBUILDS the forward: `refs/for/*` commands
 *      are translated onto their real head refs (`refs/pull/N/head`; the
 *      create arm pre-allocates the PR row so N is known pre-receive, its
 *      derived title/description fill in post-receive) and structurally
 *      failed commands are dropped from the forward entirely. Ordinary
 *      commands fall through verbatim.
 *   2. The engine receive runs the shared push policy unchanged (branch and
 *      tag protection apply to the FALL-THROUGH commands; translated
 *      `refs/pull/*` commands are branch-protection-exempt exactly like
 *      upstream, whose `hook_pre_receive` checks only `refs/heads/*` and
 *      `refs/tags/*`). The lane's force gate rides the engine's own
 *      classification: a translated update that classifies `force-push`
 *      without the `force-push` push option rejects with upstream's exact
 *      ng text ("request `force-push` push option", agit.go:250-258) — the
 *      ancestry check needs the staged pack, so it lives in the validator,
 *      not the planner.
 *   3. After the response the gate rewrites the report-status: translated
 *      commands render against their ORIGINAL `refs/for/*` names (with
 *      report-status-v2 `option refname/old-oid/new-oid/forced-update`
 *      lines, cmd/hook.go:597-620), plan-rejected commands synthesize their
 *      ng lines in original command order, and the PR URL message rides
 *      sideband band 2 exactly where upstream's hook stderr lands
 *      (hookPrintResult, cmd/hook.go:404-418 — "Visit the existing pull
 *      request:" and the URL; the create arm deliberately keeps the update
 *      wording, agit.go's `IsCreatePR: false` comment). A create whose
 *      translated command did NOT land sweeps its pre-allocated PR rows
 *      (the create route's ref-write-failure cleanup order,
 *      api/routes/pulls.ts — upstream's own cleanup posture,
 *      services/pull/pull.go:157).
 *
 * The update arm runs ALL of upstream's ProcReceive update wall-clock (the
 * tails below): the D1 re-arm (head_sha/status/divergence — the §3.4 sync
 * shape, and the markChecking half of `StartPullRequestCheckImmediately`),
 * the review-stale/dismiss maintenance (`MarkReviewsAsStale`/
 * `DismissApprovalReviews` under the base rule's dismiss_stale_approvals /
 * `MarkReviewsAsNotStale`, agit.go:262-280 — gated on the PR ROW's stored
 * head, not the shared push path's content comparison), the immediate
 * mergeability check (the queue work of `StartPullRequestCheckImmediately`,
 * check.go:76-80, run inline through `ensurePullRequestChecked` — the
 * landed lazy-check family), the type-29 `pull_push` comment (upstream's
 * `CreatePushPullComment` — the SAME comment family as normal PR head
 * pushes, services/pull/comment.go:95-160, with the agit specifics: the
 * doer is the agit pusher, old/new are the head ref's pre-/post-move oids,
 * and isForcePush is the `force-push` OPTION value (agit.go:297), not the
 * shared path's ancestry derivation) with its `PullRequestPushCommits`
 * mail, and the `pull_request` action=opened (create) /
 * `pull_request_sync` action=synchronized (update) webhooks; the D-7c
 * auto-merge re-check enqueues through the shared push tail because the
 * translated command IS a `refs/pull/N/head` command to the collector.
 * Upstream's create arm has NO immediate check either way (NewPullRequest,
 * pull.go:100-193, starts none for either flow — the fresh row waits for
 * its first consumer, our landed §3.4 lazy posture), and it writes the
 * FIRST type-29 comment at create (pull.go:145, both flows — landed here
 * as `createAgitFirstPushComment`, the agit create tail's opening leg).
 * The recorded remainder is now only the github-flow create's own first
 * comment: upstream derives BOTH flows through the same NewPullRequest
 * pin, ours runs through IssuesService.createPullRequest, which does not
 * yet write the row (the shared walk+insert shape to port lives in this
 * module's `createAgitFirstPushComment`/`newestLimitedAgitCommitIds`).
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { Context } from "hono";

import type { ApiEnv } from "../env";
import { ActionType, recordAction, type ActionDraft } from "./activity-feeds";
import { isUserBlockedBy } from "./blocks";
import { branchRef, pullHeadRef } from "./engine";
import { ensurePullRequestChecked, pullRequestDiffShortStatForEnv } from "./pull-engine";
import { apiUserFromRow, findRepositoryById, toApiRepository, type RepositoryRow, type UserRow, type Viewer } from "./repository";
import { toApiPullRequest } from "./pulls";
import { appOrigin, DISMISS_STALE_MESSAGE, MAX_PUSH_COMMITS_IN_COMMENT } from "../../services/webhooks-push";
import { findRule, parseRuleConfig } from "../../services/branch-protection";
import { notifyPullRequestPushCommits } from "../../services/mail/notify";
import { emitWebhookDeliveries, type HookEventType } from "../../issues/webhooks";
import { IssuesService, ellipsisDisplayString, MAX_TITLE_DISPLAY_WIDTH } from "../../issues/service";
import { CommentType } from "../../issues/comment-types";
import { comments, issues, PRFlow, PRStatus, pullRequests, pullReviews, ReviewType, users } from "../../db/schema";

/** Upstream `ForPrefix` (modules/git/ref.go:73). */
export const FOR_PREFIX = "refs/for/";

/** `git.RefName.IsFor` (modules/git/ref.go:123). */
export function isAgitCommandRef(ref: string): boolean {
  return ref.startsWith(FOR_PREFIX);
}

/** `git.RefName.ForBranchName` (modules/git/ref.go:161-163): everything after
 *  the `refs/for/` prefix — `<target-branch>` or `<target-branch>/<topic>`. */
export function agitForBranchName(ref: string): string {
  return ref.slice(FOR_PREFIX.length);
}

/** One receive-pack wire command (the command section, engine's PushCommand). */
export interface AgitWireCommand {
  old: string;
  new: string;
  ref: string;
}

export const AGIT_ZERO_OID = "0000000000000000000000000000000000000000";

/**
 * `parseAgitPushOptionValue` (agit.go:31-36): a `{base64}`-prefixed value
 * decodes from the std alphabet; a failed decode (or no prefix) keeps the
 * raw string.
 */
export function parseAgitPushOptionValue(s: string): string {
  if (s.startsWith("{base64}")) {
    try {
      return atob(s.slice("{base64}".length));
    } catch {
      return s;
    }
  }
  return s;
}

/**
 * The `GIT_PUSH_OPTION_*` map (modules/private/pushoptions.go
 * AddFromKeyValue): `key=value` splits on the first `=`; a bare `key` stores
 * the empty string. Beyond the first `=` the value is verbatim.
 */
export function pushOptionsMap(options: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of options) {
    const eqAt = line.indexOf("=");
    if (eqAt === -1) map.set(line, "");
    else map.set(line.slice(0, eqAt), line.slice(eqAt + 1));
  }
  return map;
}

const GO_PARSE_BOOL_TRUE = new Set(["1", "t", "T", "TRUE", "true", "True"]);
const GO_PARSE_BOOL_FALSE = new Set(["0", "f", "F", "FALSE", "false", "False"]);

/**
 * `GitPushOptions.Bool` (modules/private/pushoptions.go:24-34): a present
 * option with an empty value is true (`-o force-push`); a present parseable
 * value parses per Go's strconv.ParseBool; an unparseable value (and an
 * absent key) reads as upstream's `optional.None` → the zero value false.
 */
export function pushOptionBool(map: Map<string, string>, key: string): boolean {
  if (!map.has(key)) return false;
  const value = map.get(key) ?? "";
  if (value === "") return true;
  if (GO_PARSE_BOOL_TRUE.has(value)) return true;
  if (GO_PARSE_BOOL_FALSE.has(value)) return false;
  return false;
}

/**
 * `GetAgitBranchInfo` (agit.go:39-64) over a branch-name universe: the whole
 * `refs/for/<X>` remainder first as a branch, then — at every `/` in byte
 * order, shortest prefix first — `<prefix>` as the base branch with the rest
 * as the topic. `null` = upstream's "base branch does not exist".
 */
export function resolveAgitBaseTopic(branches: readonly string[], forName: string): { base: string; topic: string } | null {
  if (branches.includes(forName)) return { base: forName, topic: "" };
  for (let p = 0; p < forName.length; p++) {
    if (forName[p] !== "/") continue;
    const prefix = forName.slice(0, p);
    if (branches.includes(prefix)) return { base: prefix, topic: forName.slice(p + 1) };
  }
  return null;
}

/**
 * The head-branch prefix rule (agit.go:120-126): topics are namespaced by
 * the (lowercased) pusher so different users can reuse a topic name;
 * an already-prefixed topic rides as-is.
 */
export function agitHeadBranch(userNameLower: string, topic: string): string {
  return topic.startsWith(`${userNameLower}/`) ? topic : `${userNameLower}/${topic}`;
}

/**
 * `CommitMessage.MessageTitle`/`MessageBody` (modules/git/commit_message.go):
 * the trimmed message cuts at the first `\n` — title = the first part,
 * body = the rest (trimmed).
 */
export function splitCommitTitleBody(message: string): { title: string; body: string } {
  const trimmed = message.trim();
  const nl = trimmed.indexOf("\n");
  if (nl === -1) return { title: trimmed, body: "" };
  return { title: trimmed.slice(0, nl), body: trimmed.slice(nl + 1).trim() };
}

// ---------------------------------------------------------------------------
// The plan — one walk over the command section, upstream ProcReceive's
// sequential shape (the in-plan memo replicates its "second command for the
// same proposal finds the PR the walk just created" behavior — agit.go's
// unmerged lookup re-runs per command against its own transaction's writes).
// ---------------------------------------------------------------------------

/** One planned command, index-aligned with the wire command list. */
export type AgitPlanEntry =
  /** Not a `refs/for/*` ref — forward verbatim (the proc-receive
   *  `IsNotMatched` fall-through). */
  | { kind: "fall-through" }
  /** Structurally failed: dropped from the forward, the response renders the
   *  ng line (cmd/hook.go's `ng <ref> <reason>`). */
  | { kind: "reject"; originalRef: string; message: string }
  /** A fresh pull request: the row is ALREADY COMMITTED (pre-receive), the
   *  translated command creates its head ref through the engine's finalize. */
  | {
      kind: "create";
      originalRef: string;
      translatedRef: string;
      old: string;
      new: string;
      issueId: number;
      prId: number;
      index: number;
      headBranch: string;
      baseBranch: string;
      /** Derived text the push options did not carry — filled post-receive
       *  from the tip commit's message (agit.go's GetCommit arm). */
      fillTitle: boolean;
      fillBody: boolean;
    }
  /** An existing unmerged agit PR: the translated command moves its head ref
   *  (CAS on the live tip) — upstream's UpdateRefForAgit arm. */
  | {
      kind: "update";
      originalRef: string;
      translatedRef: string;
      /** The live head-ref tip at plan time — the translated command's CAS
       *  base (upstream reads the ref commit id, agit.go:188-194). */
      old: string;
      new: string;
      issueId: number;
      prId: number;
      index: number;
      headBranch: string;
      baseBranch: string;
      /** The `force-push` OPTION value (agit.go:107 read once per receive;
       *  the shared push path derives force-ness from ancestry instead —
       *  upstream's agit comment and result carry the OPTION's value even
       *  when the history was actually fast-forward, agit.go:297). */
      forcePush: boolean;
    };

export interface AgitPlan {
  /** The wire command list this plan is index-aligned with. */
  wireCommands: readonly AgitWireCommand[];
  /** Index-aligned with `wireCommands`. */
  entries: readonly AgitPlanEntry[];
  /** The parsed push options (the GIT_PUSH_OPTION_* map). */
  options: Map<string, string>;
  /** The verified pusher's user row — resolved once for the login-prefix
   *  rule, the blocked check and the payload senders; null when the row
   *  vanished after the forward's verify (every agit command rejects). */
  pusherRow: UserRow | null;
  /** The client negotiated report-status-v2 — the rewrite renders the
   *  refname/old-oid/new-oid option lines. */
  reportV2: boolean;
  /** true when any command planned translated/rejected — the gate runs the
   *  agit response rewrite; an all-fall-through plan skips it entirely. */
  hasAgitCommands: boolean;
}

/** Upstream ng texts (agit.go + hook_proc_receive.go), verbatim. */
export const AGIT_NG = {
  delete: "Can't delete not exist branch",
  baseBranch: "base-branch does not exist",
  noTopic: "topic-branch is not set",
  sameCommit: "new commit is same with old commit",
  forcePush: "request `force-push` push option",
  blocked: "Cannot create pull request because you are blocked by the repository owner.",
} as const;

/** The planner's engine cell face — the generated `Env.REPO` stub satisfies
 *  it structurally; tests can stub the one read the walk performs. */
export interface AgitCell {
  listRefs(): Promise<{ refs: { name: string; target: string; peeled?: string }[]; head: string | null }>;
}

/** The bindings the planner and tails read (WebhookPushEnv's pattern: the
 *  generated Env satisfies this structurally; optional members stay optional
 *  so varless test envs compose). */
export interface AgitEnv extends Pick<Env, "DB" | "REPO" | "REPO_PACKS" | "REPO_TASKS"> {
  APP_URL?: string;
  MAIL_ENABLED?: string;
  ENABLE_NOTIFY_MAIL?: string;
  MAIL_FROM?: string;
}

/**
 * `ProcReceive` (agit.go:96-330) over one receive's command section. Runs
 * BEFORE the engine forward: every branch/topic/D1 decision upstream's hook
 * makes inside the receive, ours makes against the repo's pre-receive state
 * (the pushed objects are not stored yet — the only decision that NEEDS them,
 * the force-push ancestry check, is deferred to the gate's lane validator
 * where the engine's own classification answers it).
 */
export async function planAgitCommands(
  env: AgitEnv,
  repo: RepositoryRow,
  engineRepo: string,
  pusher: { id: number; login: string },
  commands: readonly AgitWireCommand[],
  pushOptions: readonly string[],
  caps: readonly string[],
): Promise<AgitPlan> {
  const base: AgitPlan = {
    wireCommands: commands,
    entries: [],
    options: pushOptionsMap([...pushOptions]),
    pusherRow: null,
    reportV2: caps.includes("report-status-v2"),
    hasAgitCommands: commands.some((cmd) => isAgitCommandRef(cmd.ref)),
  };
  if (!base.hasAgitCommands) {
    return { ...base, entries: commands.map(() => ({ kind: "fall-through" as const })) };
  }

  const pusherRow = (await drizzle(env.DB)
    .select()
    .from(users)
    .where(eq(users.id, pusher.id))
    .limit(1)
    .all())[0];
  if (pusherRow === undefined) {
    // The identity resolved at the forward vanished before the plan: every
    // agit command rejects (no poster to propose as); fall-through commands
    // are unaffected. Upstream has no arm (the hook resolves the user by id
    // and 500s the whole hook) — the per-command ng is our fail-closed shape.
    return {
      ...base,
      entries: commands.map((cmd) =>
        isAgitCommandRef(cmd.ref)
          ? { kind: "reject", originalRef: cmd.ref, message: "pusher is not resolvable" }
          : { kind: "fall-through" as const },
      ),
    };
  }
  base.pusherRow = pusherRow;

  const cell: AgitCell = env.REPO.getByName(engineRepo);
  const refList = (await cell.listRefs()).refs ?? [];
  // Branch NAMES (upstream IsBranchExist compares the bare name, agit.go
  // GetAgitBranchInfo); the tips map keeps the full ref names for the
  // translated-ref tip reads.
  const branches = refList
    .map((ref) => ref.name)
    .filter((name) => name.startsWith("refs/heads/"))
    .map((name) => name.slice("refs/heads/".length));
  const tips = new Map(refList.map((ref) => [ref.name, ref.target]));

  // The in-plan memo: (headBranch, baseBranch) → the planned proposal. A
  // duplicate `refs/for` command later in the SAME push resolves against it,
  // the way upstream's per-command re-lookup resolves against the PR its own
  // walk just created (the memo'd tip is the oid the earlier command writes).
  const memo = new Map<string, AgitPlanEntry>();

  const entries: AgitPlanEntry[] = [];
  for (const cmd of commands) {
    if (!isAgitCommandRef(cmd.ref)) {
      entries.push({ kind: "fall-through" });
      continue;
    }
    entries.push(await planOne(env, repo, memo, tips, branches, pusherRow, base.options, cmd));
  }
  return { ...base, entries };
}

/** One agit command's plan arm (the ProcReceive loop body, agit.go:105-330). */
async function planOne(
  env: AgitEnv,
  repo: RepositoryRow,
  memo: Map<string, AgitPlanEntry>,
  tips: Map<string, string>,
  branches: readonly string[],
  pusherRow: UserRow,
  options: Map<string, string>,
  cmd: AgitWireCommand,
): Promise<AgitPlanEntry> {
  try {
    // Deletion (agit.go:105-113): proc-received refs cannot be deleted —
    // "Can't delete not exist branch".
    if (cmd.new === AGIT_ZERO_OID) {
      return { kind: "reject", originalRef: cmd.ref, message: AGIT_NG.delete };
    }

    // Base/topic resolution (agit.go:39-64 + 121-141).
    const resolved = resolveAgitBaseTopic(branches, agitForBranchName(cmd.ref));
    if (resolved === null) {
      return { kind: "reject", originalRef: cmd.ref, message: AGIT_NG.baseBranch };
    }
    const optionTopic = options.get("topic") ?? "";
    let topic = resolved.topic;
    if (topic === "" && optionTopic === "") {
      return { kind: "reject", originalRef: cmd.ref, message: AGIT_NG.noTopic };
    }
    if (topic === "") topic = optionTopic;

    // The username prefix rule (agit.go:120-126).
    const headBranch = agitHeadBranch(pusherRow.usernameLower, topic);
    const memoKey = `${headBranch}\u0000${resolved.base}`;
    const memoHit = memo.get(memoKey);

    let issueId: number;
    let prId: number;
    let index: number;
    let translatedRef: string;
    let tip: string;
    if (memoHit !== undefined && memoHit.kind !== "fall-through" && memoHit.kind !== "reject") {
      // The walk's own earlier command planned this proposal: the head ref
      // will hold the earlier command's oid when the finalize commits, so
      // that is the CAS base and the same-commit comparator.
      issueId = memoHit.issueId;
      prId = memoHit.prId;
      index = memoHit.index;
      translatedRef = memoHit.translatedRef;
      tip = memoHit.new;
    } else {
      // The unmerged lookup (agit.go:128-131 → GetUnmergedPullRequest,
      // models/issues/pull.go — same repo both sides, the exact head/base
      // branches, unmerged, flow=AGit, open issue).
      const existing = await findUnmergedAgitPullRequest(env.DB, repo.id, headBranch, resolved.base);
      if (existing === null) {
        const created = await planCreate(env, repo, pusherRow, options, cmd, headBranch, resolved.base);
        memo.set(memoKey, created);
        return created;
      }
      issueId = existing.issue.id;
      prId = existing.pullRequest.id;
      index = existing.pullRequest.index;
      translatedRef = pullHeadRef(existing.pullRequest.index);
      // The live ref tip is the CAS base (the engine ref is authoritative
      // over the head_sha cache — webhooks-push's sync posture; upstream's
      // GetRefCommitID read, agit.go:188-194). A missing ref (a pre-ref row)
      // creates from the zero oid like createPullHeadRef.
      tip = tips.get(translatedRef) ?? AGIT_ZERO_OID;
    }

    // Same commit (agit.go:196-204).
    if (cmd.new === tip) {
      return { kind: "reject", originalRef: cmd.ref, message: AGIT_NG.sameCommit };
    }
    // The force gate is DEFERRED to the lane validator: it needs the pushed
    // tip's ancestry (upstream rev-lists old ^new, agit.go:206-224) and the
    // objects only exist after the pack stages. The engine classifies the
    // translated command; the gate's validator carries upstream's exact ng
    // text when the classification is force-push without the option.

    const entry: AgitPlanEntry = {
      kind: "update",
      originalRef: cmd.ref,
      translatedRef,
      old: tip,
      new: cmd.new,
      issueId,
      prId,
      index,
      headBranch,
      baseBranch: resolved.base,
      forcePush: pushOptionBool(options, "force-push"),
    };
    memo.set(memoKey, entry);
    return entry;
  } catch (error) {
    // Non-protocol failure (a D1 hiccup): THIS command rejects, the walk
    // continues (the module header's posture). Upstream 500s the whole hook;
    // per-command ng keeps our partial-push shape without orphaning rows.
    console.error(
      `[agit] ${repo.ownerNamespace}/${repo.slug}: planning ${cmd.ref} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { kind: "reject", originalRef: cmd.ref, message: "agit: internal error planning push-to-propose" };
  }
}

/** The create arm (agit.go:133-243): the blocked gate, then the PR row —
 *  pre-committed so the translated command knows its `refs/pull/N/head`
 *  target before the forward. */
async function planCreate(
  env: AgitEnv,
  repo: RepositoryRow,
  pusherRow: UserRow,
  options: Map<string, string>,
  cmd: AgitWireCommand,
  headBranch: string,
  baseBranch: string,
): Promise<AgitPlanEntry> {
  // The blocked gate FIRST (NewPullRequest, services/pull/pull.go:66-68; the
  // AGit flow skips the collaborator gate entirely, pull.go:71 — `canCreate :=
  // poster.IsAdmin || Flow == AGit`). Upstream's exact UserMsg is the ng text
  // (hook_proc_receive.go:37-39).
  if (repo.ownerId !== null && (await isUserBlockedBy(env.DB, { id: pusherRow.id, isAdmin: pusherRow.isAdmin }, repo.ownerId))) {
    return { kind: "reject", originalRef: cmd.ref, message: AGIT_NG.blocked };
  }
  // Title/description from the push options ({base64} decoded); the
  // commit-message fallback derives POST-receive (the objects are not stored
  // yet — agit.go's GetCommit arm runs inside the hook, ours re-reads the
  // stored tip in the tail).
  const optionTitle = parseAgitPushOptionValue(options.get("title") ?? "");
  const optionDescription = parseAgitPushOptionValue(options.get("description") ?? "");

  const service = new IssuesService(env.DB, env);
  const { issue, pullRequest } = await service.createPullRequest({
    repoId: repo.id,
    headRepoId: repo.id,
    baseBranch,
    headBranch,
    title: optionTitle,
    content: optionDescription === "" ? null : optionDescription,
    posterId: pusherRow.id,
    // DefaultAllowMaintainerEdit (the create route's default, the repo unit
    // default upstream).
    allowMaintainerEdit: true,
    headSha: cmd.new,
    // Same-repo creates leave merge_base to the lazy check — the create
    // route's same posture (only cross-repo heads pass mergeBase).
    mergeBase: null,
    flow: PRFlow.AGit,
  });

  return {
    kind: "create",
    originalRef: cmd.ref,
    translatedRef: pullHeadRef(pullRequest.index),
    old: AGIT_ZERO_OID, // a fresh PR's head ref does not exist yet
    new: cmd.new,
    issueId: issue.id,
    prId: pullRequest.id,
    index: pullRequest.index,
    headBranch,
    baseBranch,
    fillTitle: optionTitle === "",
    fillBody: optionDescription === "",
  };
}

/** `GetUnmergedPullRequest` for the AGit flow (models/issues/pull.go:237-247:
 *  same repo both sides, the exact head/base branches, unmerged, flow
 *  matched, issue open). */
async function findUnmergedAgitPullRequest(
  d1: D1Database,
  repoId: string,
  headBranch: string,
  baseBranch: string,
): Promise<{ issue: typeof issues.$inferSelect; pullRequest: typeof pullRequests.$inferSelect } | null> {
  const rows = await drizzle(d1)
    .select({ issue: issues, pullRequest: pullRequests })
    .from(pullRequests)
    .innerJoin(issues, eq(issues.id, pullRequests.issueId))
    .where(
      and(
        eq(pullRequests.headRepoId, repoId),
        eq(pullRequests.baseRepoId, repoId),
        eq(pullRequests.headBranch, headBranch),
        eq(pullRequests.baseBranch, baseBranch),
        eq(pullRequests.hasMerged, false),
        eq(pullRequests.flow, PRFlow.AGit),
        eq(issues.isClosed, false),
      ),
    )
    .limit(1)
    .all();
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// The proc-receive wire: request section parse, forward rebuild, response
// report rewrite. pkt-line framing per gitprotocol-pack (the engine's
// PktParser semantics: 4-byte hex length, flush = 0000, one trailing LF
// chomped per data line).
// ---------------------------------------------------------------------------

export class AgitProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgitProtocolError";
  }
}

/** The command+options sections' buffered-parse cap (real command sections
 *  are kilobytes; this bounds a hostile unbounded section before the engine's
 *  own caps ever see the request). */
const SECTION_MAX_BYTES = 16 * 1024 * 1024;

export interface ReceivePackSections {
  /** The command section in wire order; the first line's capabilities (the
   *  NUL suffix) separated out. */
  commands: AgitWireCommand[];
  caps: string[];
  /** The push-options section's VERBATIM bytes (pkt-lines + flush), present
   *  exactly when the client requested the advertised `push-options`
   *  capability. */
  optionsRaw: Uint8Array | null;
  /** The options as strings (the GIT_PUSH_OPTION_* lines). */
  options: string[];
  /** Everything after the parsed sections — the pack, still a stream. */
  rest: ReadableStream<Uint8Array>;
}

/**
 * Split a receive-pack request body into its pkt-line sections without
 * buffering the pack: commands until the first flush, then — iff the
 * client's capabilities include `push-options` — the options section until
 * its flush; the remainder is re-served as a stream. The caller passes a
 * DECODED body (the gate owns content-encoding handling).
 */
export async function splitReceivePackSections(body: ReadableStream<Uint8Array>): Promise<ReceivePackSections> {
  const reader = body.getReader();
  let buf = new Uint8Array(0);
  let pos = 0;
  let total = 0;
  const read = async (n: number): Promise<boolean> => {
    while (buf.length - pos < n) {
      const { done, value } = await reader.read();
      if (done) return false;
      if (value === undefined || value.length === 0) continue;
      const merged = new Uint8Array(buf.length - pos + value.length);
      merged.set(buf.subarray(pos), 0);
      merged.set(value, buf.length - pos);
      buf = merged;
      pos = 0;
      total += value.length;
      if (total > SECTION_MAX_BYTES) {
        void reader.cancel().catch(() => {});
        throw new AgitProtocolError("receive-pack command section too large");
      }
    }
    return true;
  };
  const decoder = new TextDecoder();
  const commands: AgitWireCommand[] = [];
  let caps: string[] = [];
  // Section 1: commands (the engine's parsePushCommands shape).
  for (;;) {
    if (!(await read(4))) throw new AgitProtocolError("truncated push request");
    const len = parseInt(decoder.decode(buf.subarray(pos, pos + 4)), 16);
    if (len === 0) {
      pos += 4;
      break;
    }
    if (len < 4) throw new AgitProtocolError("bad pkt-line in push request");
    if (!(await read(len))) throw new AgitProtocolError("truncated push request");
    const lineBytes = buf.subarray(pos + 4, pos + len);
    pos += len;
    let text = decoder.decode(lineBytes);
    if (text.endsWith("\n")) text = text.slice(0, -1);
    const nul = text.indexOf("\0");
    if (nul !== -1) {
      caps = text
        .slice(nul + 1)
        .trim()
        .split(" ")
        .filter((c) => c.length > 0);
      text = text.slice(0, nul);
    }
    const m = text.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/);
    if (m) commands.push({ old: m[1]!, new: m[2]!, ref: m[3]! });
  }
  // Section 2: push options, verbatim bytes (present iff the client
  // negotiated the capability — git sends the section, empty or not, iff it
  // passed --push-option).
  let optionsRaw: Uint8Array | null = null;
  const options: string[] = [];
  if (caps.includes("push-options")) {
    const chunks: Uint8Array[] = [];
    for (;;) {
      if (!(await read(4))) throw new AgitProtocolError("truncated push-options section");
      const start = pos;
      const len = parseInt(decoder.decode(buf.subarray(pos, pos + 4)), 16);
      if (len === 0) {
        pos += 4;
        chunks.push(buf.slice(start, pos));
        break;
      }
      if (len < 4) throw new AgitProtocolError("bad pkt-line in push-options section");
      if (!(await read(len))) throw new AgitProtocolError("truncated push-options section");
      pos += len;
      chunks.push(buf.slice(start, pos));
      let text = decoder.decode(buf.subarray(start + 4, pos));
      if (text.endsWith("\n")) text = text.slice(0, -1);
      options.push(text);
    }
    optionsRaw = concatBytes(chunks);
  }

  // The pack: the unconsumed buffer tail, then the untouched reader.
  const head = buf.length > pos ? buf.slice(pos) : null;
  const rest = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head !== null) controller.enqueue(head);
      void pumpStreamInto(reader, controller);
    },
    cancel() {
      void reader.cancel().catch(() => {});
    },
  });

  return { commands, caps, optionsRaw, options, rest };
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const FLUSH_PKT = new TextEncoder().encode("0000");

/** Encode one pkt-line (4-byte hex length + payload; the caller embeds its
 *  own trailing LF). */
function pktLineBytes(payload: string): Uint8Array {
  const body = TEXT_ENCODER.encode(payload);
  const frame = new Uint8Array(4 + body.length);
  frame.set(TEXT_ENCODER.encode((body.length + 4).toString(16).padStart(4, "0")), 0);
  frame.set(body, 4);
  return frame;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function pumpStreamInto(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: ReadableStreamDefaultController<Uint8Array>,
): Promise<void> {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined || value.length === 0) continue;
      controller.enqueue(value);
    }
    controller.close();
  } catch (error) {
    controller.error(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * The rebuilt request body: the KEPT commands (fall-through verbatim,
 * translated onto their real refs) with the capabilities suffix riding the
 * first kept line (the engine reads caps off the first line carrying the NUL
 * — a dropped first command must not strand them), flush, the push-options
 * section verbatim, then the pack stream.
 */
export function rebuildReceivePackForward(
  commands: readonly { old: string; new: string; ref: string }[],
  caps: readonly string[],
  optionsRaw: Uint8Array | null,
  rest: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const head: Uint8Array[] = [];
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]!;
    const suffix = i === 0 && caps.length > 0 ? `\0${caps.join(" ")}` : "";
    head.push(pktLineBytes(`${cmd.old} ${cmd.new} ${cmd.ref}${suffix}\n`));
  }
  head.push(FLUSH_PKT);
  if (optionsRaw !== null) head.push(optionsRaw);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of head) controller.enqueue(chunk);
      void pumpStreamInto(rest.getReader(), controller);
    },
    cancel() {
      void rest.cancel().catch(() => {});
    },
  });
}

// ---------------------------------------------------------------------------
// The response rewrite — report-status in original command order, the PR URL
// message on sideband band 2.
// ---------------------------------------------------------------------------

/** One rewritten report's outcome for the gate's post-response arms. */
export interface AgitReportRewrite {
  bytes: Uint8Array;
  /** Translated commands the engine APPLIED, by originalRef. */
  applied: Set<string>;
  /** Translated commands the engine did NOT apply (ng or missing), by
   *  originalRef — the create arm sweeps these. */
  failed: Set<string>;
}

interface ReportLine {
  kind: "status" | "raw";
  ref: string;
  ok: boolean;
  msg: string;
}

function statusLine(ref: string, ok: boolean, msg = ""): ReportLine {
  return { kind: "status", ref, ok, msg };
}

/** Parse the report-status pkt-lines (engine renderStatus's shape: an
 *  `unpack <msg>` line, per-command `ok/ng` lines, flush). */
function parseReport(report: Uint8Array): { unpack: string; lines: Map<string, ReportLine> } {
  let pos = 0;
  let unpack = "ok";
  const lines = new Map<string, ReportLine>();
  while (pos + 4 <= report.length) {
    const len = parseInt(TEXT_DECODER.decode(report.subarray(pos, pos + 4)), 16);
    if (len === 0) break;
    if (len < 4) break;
    let text = TEXT_DECODER.decode(report.subarray(pos + 4, pos + len));
    pos += len;
    if (text.endsWith("\n")) text = text.slice(0, -1);
    if (text.startsWith("unpack ")) {
      unpack = text.slice("unpack ".length);
      continue;
    }
    if (text.startsWith("ok ")) {
      const ref = text.slice(3);
      lines.set(ref, statusLine(ref, true));
      continue;
    }
    if (text.startsWith("ng ")) {
      const rest = text.slice(3);
      const sp = rest.indexOf(" ");
      const ref = sp === -1 ? rest : rest.slice(0, sp);
      const msg = sp === -1 ? "" : rest.slice(sp + 1);
      lines.set(ref, statusLine(ref, false, msg));
    }
  }
  return { unpack, lines };
}

/** One sideband frame: band byte + payload under a pkt-line length. */
function sidebandFrame(band: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.length);
  frame.set(TEXT_ENCODER.encode((payload.length + 5).toString(16).padStart(4, "0")), 0);
  frame[4] = band;
  frame.set(payload, 5);
  return frame;
}

/** Frame a report payload into band-1 sideband frames (65515-byte payloads,
 *  git's sideband max — the engine's own framing size). */
function frameBand1(payload: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  const MAX = 65515;
  for (let offset = 0; offset < payload.length; offset += MAX) {
    frames.push(sidebandFrame(1, payload.subarray(offset, Math.min(offset + MAX, payload.length))));
  }
  return frames;
}

/**
 * Split a sideband-framed response body into frames; plain bodies come back
 * as a single null-band frame with the report = the whole body. Band-1
 * frames accumulate into the report until its embedded flush (the report is
 * the ONLY band-1 data a receive-pack result carries).
 */
function parseResponseBody(body: Uint8Array, sideband: boolean): { frames: { band: number | null; payload: Uint8Array }[]; report: Uint8Array | null } {
  if (!sideband) return { frames: [{ band: null, payload: body }], report: body };
  const frames: { band: number | null; payload: Uint8Array }[] = [];
  const reportChunks: Uint8Array[] = [];
  let reportDone = false;
  let pos = 0;
  while (pos + 4 <= body.length) {
    const len = parseInt(TEXT_DECODER.decode(body.subarray(pos, pos + 4)), 16);
    if (len === 0) {
      pos += 4;
      continue; // the stream-terminating flush
    }
    if (len < 5) break; // a sideband frame is at least length + band
    const band = body[pos + 4]!;
    const payload = body.subarray(pos + 5, pos + len);
    pos += len;
    if (band === 1 && !reportDone) {
      reportChunks.push(payload);
      if (hasEmbeddedFlush(reportChunks)) reportDone = true;
    } else {
      frames.push({ band, payload });
    }
  }
  return { frames, report: reportChunks.length > 0 ? concatBytes(reportChunks) : null };
}

function hasEmbeddedFlush(chunks: Uint8Array[]): boolean {
  const bytes = concatBytes(chunks);
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === 0x30 && bytes[i + 1] === 0x30 && bytes[i + 2] === 0x30 && bytes[i + 3] === 0x30) return true;
  }
  return false;
}

function renderReportBytes(unpack: string, lines: readonly ReportLine[]): Uint8Array {
  const chunks: Uint8Array[] = [pktLineBytes(`unpack ${unpack}\n`)];
  for (const line of lines) {
    if (line.kind === "raw") {
      chunks.push(pktLineBytes(line.ref));
      continue;
    }
    chunks.push(pktLineBytes(line.ok ? `ok ${line.ref}\n` : `ng ${line.ref} ${line.msg}\n`));
  }
  chunks.push(FLUSH_PKT);
  return concatBytes(chunks);
}

/**
 * The response rewrite (cmd/hook.go runHookProcReceive's rendering, played
 * by the gate): the engine's report — rendered against the TRANSLATED ref
 * names — re-renders against the ORIGINAL `refs/for/*` names in the client's
 * command order; plan-rejected commands synthesize their ng lines;
 * report-status-v2 clients get the refname/old-oid/new-oid/forced-update
 * option lines of upstream's hook output (:604-620, old-oid only when
 * non-zero); the PR URL message rides band 2 at the tail (upstream's
 * hookPrintResult stderr). `forcedUpdates` maps a translated ref to the
 * engine's force classification (the lane validator's record). The engine's
 * band-2 progress frames pass through before the re-rendered report (their
 * original order — the engine emits progress first, report last).
 *
 * `wantStatus` (the client's report-status negotiation): a client that did
 * not ask for a report gets NONE (the engine emitted no report; a `--quiet`
 * push stays quiet) — the rewrite passes the frames through, appends the
 * message frames, and reports every translated command applied (per-command
 * failures are unobservable without a report — the same blindness
 * upstream's receive-pack has for quiet clients).
 */
export function rewriteReceivePackResponse(
  body: Uint8Array,
  plan: AgitPlan,
  sideband: boolean,
  wantStatus: boolean,
  forcedUpdates: ReadonlyMap<string, boolean>,
  messages: readonly string[],
): AgitReportRewrite {
  const applied = new Set<string>();
  const failed = new Set<string>();

  const { frames, report } = parseResponseBody(body, sideband);
  const engineReport = wantStatus && report !== null && report.length > 0 ? parseReport(report) : null;

  // The per-entry line GROUPS, index-aligned with the plan: an applied
  // report-status-v2 entry carries the ok line PLUS its option lines
  // (upstream renders them as one unit per result, cmd/hook.go:604-620) —
  // the merge must keep each group intact under its entry.
  const entryLines: ReportLine[][] = [];
  for (let i = 0; i < plan.entries.length; i++) {
    const entry = plan.entries[i]!;
    if (entry.kind === "fall-through") {
      const cmd = plan.wireCommands[i]!;
      const line = engineReport?.lines.get(cmd.ref);
      entryLines.push([line ?? statusLine(cmd.ref, false, "internal error")]);
      continue;
    }
    if (entry.kind === "reject") {
      entryLines.push([statusLine(entry.originalRef, false, entry.message)]);
      continue;
    }
    if (engineReport === null) {
      // Quiet client: no report exists to rewrite — every translated command
      // is taken as applied (the module header's blindness note). The add
      // happens BEFORE any engine lookup so `failed` stays clean: the gate's
      // sweep arm keys on `failed`, and a polluted set would sweep a PR the
      // engine actually applied.
      applied.add(entry.originalRef);
      entryLines.push([]);
      continue;
    }
    const engine = engineReport.lines.get(entry.translatedRef);
    if (engine === undefined || !engine.ok) {
      // Not applied (CAS conflict, engine ng, unpack failure): upstream's
      // error text renders against the original name; a missing line (an
      // engine that answered without a report) degrades to a generic ng.
      const msg = engine === undefined ? "internal error" : engine.msg;
      entryLines.push([statusLine(entry.originalRef, false, msg === "" ? "failed" : msg)]);
      failed.add(entry.originalRef);
      continue;
    }
    applied.add(entry.originalRef);
    const lines: ReportLine[] = [statusLine(entry.originalRef, true)];
    if (plan.reportV2) {
      // report-status-v2 option lines (cmd/hook.go:604-620): refname first,
      // old-oid only when non-zero, new-oid always, forced-update when the
      // engine classified the update a force push. Raw pkt-lines — NOT ok
      // lines.
      lines.push({ kind: "raw", ref: `option refname ${entry.translatedRef}\n`, ok: false, msg: "" });
      if (entry.old !== AGIT_ZERO_OID) {
        lines.push({ kind: "raw", ref: `option old-oid ${entry.old}\n`, ok: false, msg: "" });
      }
      lines.push({ kind: "raw", ref: `option new-oid ${entry.new}\n`, ok: false, msg: "" });
      if (forcedUpdates.get(entry.translatedRef) === true) {
        lines.push({ kind: "raw", ref: "option forced-update\n", ok: false, msg: "" });
      }
    }
    entryLines.push(lines);
  }

  // The command-order merge: every entry renders its own group, in order.
  const merged: ReportLine[] = entryLines.flat();

  const unpack = engineReport?.unpack ?? "ok";
  const reportBytes = engineReport !== null ? renderReportBytes(unpack, merged) : null;

  let bytes: Uint8Array;
  if (reportBytes === null) {
    if (!sideband) {
      bytes = new Uint8Array(0);
    } else {
      const chunks: Uint8Array[] = [];
      for (const frame of frames) {
        chunks.push(frame.band === null ? frame.payload : sidebandFrame(frame.band, frame.payload));
      }
      for (const message of messages) {
        chunks.push(sidebandFrame(2, TEXT_ENCODER.encode(message)));
      }
      chunks.push(FLUSH_PKT);
      bytes = concatBytes(chunks);
    }
  } else if (!sideband) {
    bytes = reportBytes;
  } else {
    const chunks: Uint8Array[] = [];
    for (const frame of frames) {
      chunks.push(frame.band === null ? frame.payload : sidebandFrame(frame.band, frame.payload));
    }
    for (const frame of frameBand1(reportBytes)) chunks.push(frame);
    for (const message of messages) {
      chunks.push(sidebandFrame(2, TEXT_ENCODER.encode(message)));
    }
    chunks.push(FLUSH_PKT);
    bytes = concatBytes(chunks);
  }
  return { bytes, applied, failed };
}

/** The all-rejected response (no forward happened): every agit command's ng
 *  line, framed when the client negotiated sideband. A quiet client (no
 *  report-status negotiation) gets the empty body the engine would have
 *  emitted. */
export function renderSynthesizedAgitReport(plan: AgitPlan, sideband: boolean, wantStatus: boolean): Uint8Array {
  if (!wantStatus) return new Uint8Array(0);
  const lines: ReportLine[] = [];
  for (const entry of plan.entries) {
    if (entry.kind === "reject") lines.push(statusLine(entry.originalRef, false, entry.message));
    else if (entry.kind !== "fall-through") lines.push(statusLine(entry.originalRef, false, "internal error"));
  }
  const report = renderReportBytes("ok", lines);
  if (!sideband) return report;
  return concatBytes([...frameBand1(report), FLUSH_PKT]);
}

/**
 * `hookPrintResult` (cmd/hook.go:404-418) — the user-visible sideband lines.
 * The create arm deliberately carries the update wording too (agit.go's
 * `IsCreatePR: false` — "AGit always creates a pull request so there is no
 * point in prompting user to create one"), one frame per upstream stderr
 * write.
 */
export function agitHookMessageFrames(url: string): string[] {
  return ["\n", "Visit the existing pull request:\n", `  ${url}\n`, "\n"];
}

/** The PR URL of upstream's result (`%s/pulls/%d`, agit.go:229/319) over the
 *  serving origin (appOrigin's chain: APP_URL var first). */
export function agitPullUrl(env: AgitEnv, repo: Pick<RepositoryRow, "ownerNamespace" | "slug">, requestOrigin: string | undefined, index: number): string {
  return `${appOrigin(env, requestOrigin)}/${repo.ownerNamespace}/${repo.slug}/pulls/${index}`;
}

// ---------------------------------------------------------------------------
// Post-response arms: the create fill + opened webhook, the update re-arm +
// synchronized webhook, the failed-create sweep. Best-effort like every
// post-receive consumer: the applied push stands, a tail failure logs.
// ---------------------------------------------------------------------------

/** The `WEBHOOK_DELIVERY` producer probe (webhooks-push's duck-typed shape;
 *  the binding stays out of AgitEnv so varless envs compose). */
function webhookDeliveryQueue(env: object): { sendBatch(messages: { body: { deliveryId: number } }[]): Promise<unknown> } | null {
  const candidate = (env as { WEBHOOK_DELIVERY?: unknown }).WEBHOOK_DELIVERY as
    | { sendBatch?: (messages: { body: { deliveryId: number } }[]) => Promise<unknown> }
    | undefined;
  return candidate !== undefined && typeof candidate.sendBatch === "function" ? { sendBatch: candidate.sendBatch.bind(candidate) } : null;
}

async function emitAgitWebhook(
  env: AgitEnv,
  waitUntil: ((promise: Promise<void>) => void) | undefined,
  input: { repoId: string; ownerId: number | null; eventType: HookEventType; payload: unknown },
): Promise<void> {
  const queue = webhookDeliveryQueue(env);
  try {
    await emitWebhookDeliveries(
      env.DB,
      { ...input, refName: null },
      {
        enqueue:
          queue !== null && waitUntil !== undefined
            ? (deliveryIds) => {
                waitUntil(
                  queue
                    .sendBatch(deliveryIds.map((deliveryId) => ({ body: { deliveryId } })))
                    .then(undefined, (error: unknown) => {
                      console.error(`[agit] delivery enqueue failed (${input.eventType}): ${error instanceof Error ? error.message : String(error)}`);
                    }),
                );
              }
            : undefined,
      },
    );
  } catch (error) {
    console.error(`[agit] webhook fan-out failed (${input.eventType}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The create arm's post-receive work: the derived title/description fill
 *  (agit.go's GetCommit fallback, run now that the tip is stored), then the
 *  `pull_request` action=opened webhook + the create action row (upstream's
 *  NewPullRequest notify, notifier.go:368 + the create route's action draft). */
export async function applyAgitCreateTail(
  env: AgitEnv,
  repo: RepositoryRow,
  engineRepo: string,
  entry: Extract<AgitPlanEntry, { kind: "create" }>,
  pusherRow: UserRow,
  requestOrigin: string | undefined,
  waitUntil: ((promise: Promise<void>) => void) | undefined,
): Promise<void> {
  try {
    const db = drizzle(env.DB);
    // 1. The derived-text fill — only the fields the push options did not
    // carry. An unreadable tip (crash window) leaves the empty text; the PR
    // stays editable through the PATCH arms — upstream's hook would have
    // failed the whole receive instead; our degradation is recorded in the
    // module header.
    let derivedTitle = "";
    let derivedBody = "";
    if (entry.fillTitle || entry.fillBody) {
      try {
        const commit = await env.REPO.getByName(engineRepo).readCommit(entry.new);
        if (commit !== null) {
          const split = splitCommitTitleBody(commit.message);
          derivedTitle = split.title;
          derivedBody = split.body;
        }
      } catch (error) {
        console.error(
          `[agit] ${repo.ownerNamespace}/${repo.slug}: PR #${entry.index} tip read failed (text left empty): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (entry.fillTitle && derivedTitle !== "") {
      await db
        .update(issues)
        .set({ title: ellipsisDisplayString(derivedTitle, MAX_TITLE_DISPLAY_WIDTH) })
        .where(eq(issues.id, entry.issueId))
        .run();
    }
    if (entry.fillBody && derivedBody !== "") {
      await db.update(issues).set({ content: derivedBody }).where(eq(issues.id, entry.issueId)).run();
    }

    // 2. The FIRST type-29 push comment — upstream lands it inside
    // NewPullRequest for BOTH flows (services/pull/pull.go:145), i.e.
    // BEFORE the opened notification rides out of the tx; ours opens this
    // tail for the same order. Log-and-continue (the lane's recorded
    // degradation posture: upstream's walk failure fails the whole create —
    // the tx rollback + RemoveRef cleanup, pull.go:147-160 — ours keeps the
    // applied push, like every tail leg).
    const log = (message: string) => console.error(`[agit] ${repo.ownerNamespace}/${repo.slug}: ${message}`);
    await createAgitFirstPushComment(env, engineRepo, entry, pusherRow, log);

    // 3. The opened webhook + action row — the create route's emission shape
    // (the PullRequestPayload wrapper, "payload"-mode PR render, the pusher
    // as sender), refetched post-fill so the payload carries the derived
    // title.
    const pair = await findRepositoryById(env.DB, repo.id);
    if (pair === null) return;
    const origin = appOrigin(env, requestOrigin);
    const sender = apiUserFromRow(pusherRow, { origin, requester: null });
    const viewer: Viewer = { origin, requester: sender };
    const issueRow = await db.select().from(issues).where(eq(issues.id, entry.issueId)).get();
    const prRow = await db.select().from(pullRequests).where(eq(pullRequests.id, entry.prId)).get();
    if (issueRow === undefined || prRow === undefined) return;
    const diffStats = await pullRequestDiffShortStatForEnv(env, pair, prRow);
    const rendered = await toApiPullRequest(env.DB, viewer, pair, issueRow, prRow, "payload", diffStats === null ? undefined : { diffStats });
    await emitAgitWebhook(env, waitUntil, {
      repoId: pair.repo.id,
      ownerId: pair.repo.ownerId,
      eventType: "pull_request",
      payload: {
        action: "opened",
        number: issueRow.index,
        pull_request: rendered,
        repository: toApiRepository(viewer, pair),
        sender,
        commit_id: "",
      },
    });
    const draft: ActionDraft = {
      actUserId: pusherRow.id,
      repoId: pair.repo.id,
      opType: ActionType.CreatePullRequest,
      isPrivate: pair.repo.visibility === "private",
      content: `${issueRow.index}|${issueRow.title}`,
    };
    try {
      await recordAction(env.DB, draft);
    } catch (error) {
      console.error(`[agit] action row failed (pull_request): ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    console.error(
      `[agit] ${repo.ownerNamespace}/${repo.slug}: create tail for ${entry.originalRef} failed (the push stands): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * The CREATE arm's FIRST type-29 push comment — upstream's NewPullRequest
 * creates it for BOTH flows with one call (services/pull/pull.go:145):
 * `CreatePushPullComment(ctx, issue.Poster, pr, git.BranchPrefix+pr.BaseBranch,
 * pr.GetGitHeadRefName(), false)`. The create shape derived at that pin:
 *
 *   - oldRef is the BASE BRANCH REF (`refs/heads/<base>`, modules/git/ref.go
 *     BranchPrefix) — never empty, never ZERO_OID — so CreatePushPullComment
 *     resolves it to the base branch's live tip (comment.go:107-113);
 *     newRef is `refs/pull/N/head`, moved moments earlier by
 *     UpdateRefForAgit/PushToBaseRepo. (The doer is `issue.Poster` — the agit
 *     flow's poster IS the pusher, planCreate's posterId.)
 *   - isForcePush is the LITERAL false: the force arm never runs at create —
 *     no merge-base walk, no `{is_force_push, [old, new]}` marker comment,
 *     no old-comment reconcile (comment.go:24-45's force branch).
 *   - The walk is the normal-push shape over the resolved tips:
 *     `rev-list --reverse -n limit baseTip..headTip` (comment.go:43-45 over
 *     GetCommitIDsBetweenReverse, modules/git/compare.go:48-55) — the PR's
 *     own commits, oldest-first, capped at the newest
 *     MAX_PUSH_COMMITS_IN_COMMENT — and an EMPTY walk (a head that adds
 *     nothing beyond its base) creates NO comment (shouldCreate=false,
 *     comment.go:44-45).
 *   - NO `PullRequestPushCommits` mail: the create pin fires none — the
 *     notify rides only the shared push path (pull.go:406-411, the update
 *     callers). The landed update arm's mail arm is deliberately absent
 *     here.
 *
 * Upstream's comment failure FAILS the whole NewPullRequest (pull.go:145-147
 * → the RemoveRef cleanup at :155-160); the lane's recorded posture keeps
 * the applied push and logs (module header) — the same degradation the
 * update arm's `createAgitPushComment` documents. Never throws.
 */
async function createAgitFirstPushComment(
  env: AgitEnv,
  engineRepo: string,
  entry: Extract<AgitPlanEntry, { kind: "create" }>,
  pusherRow: UserRow,
  log: (message: string) => void,
): Promise<void> {
  try {
    const cell = env.REPO.getByName(engineRepo);
    const commitIds = await newestLimitedAgitCommitIds(cell, branchRef(entry.baseBranch), entry.new, log);
    if (commitIds.length === 0) return; // upstream shouldCreate=false — nothing beyond the base
    await new IssuesService(env.DB).addComment({
      issueId: entry.issueId,
      type: CommentType.PullRequestPush,
      posterId: pusherRow.id,
      content: JSON.stringify({ is_force_push: false, commit_ids: commitIds } satisfies PushActionContent),
      now: new Date(),
    });
  } catch (error) {
    log(`the create arm's first push comment failed (the push stands): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The update arm's post-receive work — upstream's whole ProcReceive update
 * wall-clock after UpdateRefForAgit (agit.go:262-330), in upstream's order:
 *
 *   1. the §3.4 re-arm (head_sha cache, status=checking, recomputed
 *      divergence — syncPullRequestHead's D1 shape, CAS-guarded by
 *      has_merged=0 like upstream's UpdateColsIfNotMerged). This is ALSO
 *      the markChecking half of StartPullRequestCheckImmediately
 *      (check.go:64-74 — status=Checking through UpdateColsIfNotMerged);
 *   2. the review-stale/dismiss maintenance (agit.go:262-280), gated on the
 *      PR ROW's stored head vs the new oid (upstream captures
 *      pr.HeadCommitID BEFORE UpdateRefForAgit, agit.go:236-237 — the row
 *      inequality, NOT the shared push path's content comparison,
 *      pull.go:503-538): MarkReviewsAsStale (every row, review.go:624-628),
 *      then DismissApprovalReviews when the BASE branch's rule sets
 *      dismiss_stale_approvals (services/pull/review.go:339-365 — the
 *      undismissed approvals flip dismissed and each lands a type-32
 *      comment), then MarkReviewsAsNotStale against the new head
 *      (review.go:630-635). Every leg log-and-continue (agit.go's
 *      log.Error arms);
 *   3. StartPullRequestCheckImmediately's QUEUE work run inline
 *      (agit.go:279 — upstream enqueues, the worker runs the mergeability
 *      check; ours runs the landed lazy-check family
 *      `ensurePullRequestChecked` right here on the still-checking fresh
 *      row, which self-gates on has_merged/status). The CREATE arm has no
 *      check upstream either (NewPullRequest starts none — module header);
 *   4. `CreatePushPullComment` — the type-29 push comment, the SAME family
 *      as normal PR head pushes (services/pull/comment.go:95-160; the
 *      normal-push caller pull.go:406) with the agit specifics: the doer is
 *      the agit pusher, old/new are the head ref's pre-/post-move oids
 *      (agit.go:188-194 + 296), and isForcePush is the `force-push` OPTION
 *      value (agit.go:297), not the shared path's ancestry derivation.
 *      Errors log-only (agit.go:298); a created comment fires the
 *      `PullRequestPushCommits` mail (:300-302);
 *   5. the `pull_request_sync` action=synchronized webhook (upstream
 *      PullRequestSynchronized, notifier.go:835-845 — before/after are the
 *      head ref's old/new oids), refetched post-check so the payload
 *      carries the settled mergeability.
 *
 * `env` is the FULL bindings type (not the planner's AgitEnv slice): the
 * check leg's `ensurePullRequestChecked` rides a synthetic ApiEnv context
 * (the consumerApiContext pattern, services/pull-automerge.ts:496) whose
 * Bindings is the generated Env.
 */
export async function applyAgitUpdateTail(
  env: Env,
  repo: RepositoryRow,
  engineRepo: string,
  entry: Extract<AgitPlanEntry, { kind: "update" }>,
  pusherRow: UserRow,
  requestOrigin: string | undefined,
  waitUntil: ((promise: Promise<void>) => void) | undefined,
): Promise<void> {
  const log = (message: string) => console.error(`[agit] ${repo.ownerNamespace}/${repo.slug}: ${message}`);
  try {
    const db = drizzle(env.DB);
    // 0. The row's PRE-update head — upstream's staleness gate reads the PR
    // row's stored head BEFORE UpdateRefForAgit moves it (agit.go:236-237).
    const preRow = await db.select().from(pullRequests).where(eq(pullRequests.id, entry.prId)).get();
    const rowHeadChanged = preRow !== undefined && (preRow.headSha ?? "") !== entry.new;

    // 1. The re-arm (steps 1 + 3's markChecking half, see the docstring).
    const cell = env.REPO.getByName(engineRepo);
    const divergence = await cell.countDivergence(branchRef(entry.baseBranch), entry.translatedRef);
    await db
      .update(pullRequests)
      .set({
        headSha: entry.new,
        status: PRStatus.Checking,
        ...(divergence !== null && divergence.tag === "ok" ? { commitsAhead: divergence.ahead, commitsBehind: divergence.behind } : {}),
      })
      .where(and(eq(pullRequests.id, entry.prId), eq(pullRequests.hasMerged, false)))
      .run();

    const pair = await findRepositoryById(env.DB, repo.id);
    if (pair === null) return;
    const issueRow = await db.select().from(issues).where(eq(issues.id, entry.issueId)).get();
    const prRow = await db.select().from(pullRequests).where(eq(pullRequests.id, entry.prId)).get();
    if (issueRow === undefined || prRow === undefined) return;

    // 2. The review maintenance (agit.go:262-280) — log-and-continue per
    // leg, exactly like upstream's log.Error arms.
    if (rowHeadChanged) {
      const now = new Date();
      // 2a. MarkReviewsAsStale — EVERY review row of the issue
      // (models/issues/review.go:625 — no type filter upstream either).
      try {
        await db.update(pullReviews).set({ stale: true, updatedAt: now }).where(eq(pullReviews.issueId, entry.issueId)).run();
      } catch (error) {
        log(`MarkReviewsAsStale failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      // 2b. DismissApprovalReviews under the base rule's
      // dismiss_stale_approvals (GetFirstMatchProtectedBranchRule +
      // pb.DismissStaleApprovals, agit.go:266-276).
      try {
        const rule = await findRule(env.DB, pair.repo.id, entry.baseBranch);
        if (rule !== null && parseRuleConfig(rule.rules).dismissStaleApprovals) {
          const approvals = await db
            .select({ id: pullReviews.id })
            .from(pullReviews)
            .where(and(eq(pullReviews.issueId, entry.issueId), eq(pullReviews.type, ReviewType.Approve), eq(pullReviews.dismissed, false)))
            .all();
          for (const approval of approvals) {
            await db.batch([
              db.update(pullReviews).set({ dismissed: true, updatedAt: now }).where(eq(pullReviews.id, approval.id)),
              db.insert(comments).values({
                type: CommentType.DismissReview,
                posterId: pusherRow.id,
                issueId: entry.issueId,
                content: DISMISS_STALE_MESSAGE,
                reviewId: approval.id,
                createdAt: now,
                updatedAt: now,
              }),
              db.update(issues).set({ numComments: sql`num_comments + 1`, updatedAt: now }).where(eq(issues.id, entry.issueId)),
            ]);
          }
        }
      } catch (error) {
        log(`DismissApprovalReviews failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      // 2c. MarkReviewsAsNotStale against the new head (review.go:630-635 —
      // reviews recorded against the exact new commit are fresh).
      try {
        await db
          .update(pullReviews)
          .set({ stale: false, updatedAt: now })
          .where(and(eq(pullReviews.issueId, entry.issueId), eq(pullReviews.commitId, entry.new)))
          .run();
      } catch (error) {
        log(`MarkReviewsAsNotStale failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 3. StartPullRequestCheckImmediately's queue work, inline (agit.go:279):
    // the re-arm above wrote status=checking (markChecking); the landed
    // lazy-check family settles it right here (self-gated: a merged row or
    // a non-checking status is returned unchanged).
    let checkedRow = prRow;
    if (!prRow.hasMerged && prRow.status === PRStatus.Checking) {
      const api = new Context<ApiEnv>(new Request("https://agit.local/agit-tail", { method: "POST" }), { env });
      checkedRow = await ensurePullRequestChecked(api, pair, prRow);
    }

    // 4. The type-29 push comment (agit.go:296-302).
    if (!prRow.hasMerged) {
      await createAgitPushComment(env, engineRepo, issueRow, checkedRow, entry, pusherRow, log);
    }

    // 5. The synchronized webhook (PullRequestSynchronized), post-check so
    // the payload renders the settled row.
    const origin = appOrigin(env, requestOrigin);
    const sender = apiUserFromRow(pusherRow, { origin, requester: null });
    const viewer: Viewer = { origin, requester: sender };
    const diffStats = await pullRequestDiffShortStatForEnv(env, pair, checkedRow);
    const rendered = await toApiPullRequest(env.DB, viewer, pair, issueRow, checkedRow, "payload", diffStats === null ? undefined : { diffStats });
    await emitAgitWebhook(env, waitUntil, {
      repoId: pair.repo.id,
      ownerId: pair.repo.ownerId,
      eventType: "pull_request_sync",
      payload: {
        action: "synchronized",
        before: entry.old,
        after: entry.new,
        number: issueRow.index,
        pull_request: rendered,
        repository: toApiRepository(viewer, pair),
        sender,
        commit_id: "",
      },
    });
  } catch (error) {
    log(`update tail for ${entry.originalRef} failed (the push stands): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Upstream `PushActionContent` (models/issues/comment.go:375-381) — the
 *  type-29 comment's `content` JSON. */
interface PushActionContent {
  is_force_push: boolean;
  /** is_force_push=true: the [old head, new head] pair; else the pushed
   *  commits, oldest-first. */
  commit_ids: string[];
}

/**
 * `CreatePushPullComment` for the agit update arm (services/pull/comment.go
 * 95-160, called at agit.go:296) — the SAME type-29 family as the shared
 * push path's landed port (services/webhooks-push.ts createPushPullComment),
 * with the agit flow's specifics: isForcePush is the `force-push` OPTION
 * value carried on the plan entry (agit.go:297), and old/new are the head
 * ref's pre-/post-move oids. Normal push: the capped oldest-first
 * old..new list, only when non-empty (shouldCreate, comment.go:44-45).
 * Force push: the merge-base(base, new) whole-PR walk (always created, walk
 * errors logged-only, comment.go:24-39) PLUS the `{is_force_push, [old,
 * new]}` marker comment, with the old-comment reconcile folded in first.
 * The created comment fires the `PullRequestPushCommits` mail
 * (notifyPullRequestPushCommits — agit.go:300-302's notify arm; the shared
 * path's wrapper re-reads the doer, ours already holds pusherRow). Never
 * throws — upstream logs a comment failure and continues (agit.go:298).
 */
async function createAgitPushComment(
  env: Env,
  engineRepo: string,
  issueRow: typeof issues.$inferSelect,
  prRow: typeof pullRequests.$inferSelect,
  entry: Extract<AgitPlanEntry, { kind: "update" }>,
  pusherRow: UserRow,
  log: (message: string) => void,
): Promise<void> {
  try {
    const cell = env.REPO.getByName(engineRepo);
    let commitIds: string[];
    if (entry.forcePush) {
      // comment.go:24-39 — the force arm always creates, walk errors logged.
      const mb = await cell.mergeBase(branchRef(prRow.baseBranch), entry.new);
      commitIds = mb !== null && mb.tag === "ok" && mb.base !== null ? await newestLimitedAgitCommitIds(cell, mb.base, entry.new, log) : [];
      commitIds = await reconcileAgitForcePushComments(env.DB, entry.issueId, commitIds);
    } else {
      commitIds = await newestLimitedAgitCommitIds(cell, entry.old, entry.new, log);
      if (commitIds.length === 0) return; // upstream shouldCreate=false
    }

    const now = new Date();
    const service = new IssuesService(env.DB);
    let normalComment: typeof comments.$inferSelect | null = null;
    if (commitIds.length > 0) {
      normalComment = await service.addComment({
        issueId: entry.issueId,
        type: CommentType.PullRequestPush,
        posterId: pusherRow.id,
        content: JSON.stringify({ is_force_push: false, commit_ids: commitIds } satisfies PushActionContent),
        now,
      });
    }
    let forceComment: typeof comments.$inferSelect | null = null;
    if (entry.forcePush) {
      // The marker comment — CommitIDs is the [old head, new head] pair
      // (models/issues/comment.go:377-379).
      forceComment = await service.addComment({
        issueId: entry.issueId,
        type: CommentType.PullRequestPush,
        posterId: pusherRow.id,
        content: JSON.stringify({ is_force_push: true, commit_ids: [entry.old, entry.new] } satisfies PushActionContent),
        now,
      });
    }
    const comment = entry.forcePush ? forceComment : normalComment;
    if (comment === null) return;
    // notify_service.PullRequestPushCommits (agit.go:300-302) — the mail
    // arm; commits carry their MessageTitle (services/issue/comments.go
    // :157-189's receiver load), the force pair passes none.
    const commits: Array<{ sha: string; title: string }> = [];
    if (!entry.forcePush) {
      for (const id of commitIds) {
        const read = await cell.readCommit(id);
        commits.push({ sha: id, title: read?.subject ?? "" });
      }
    }
    await notifyPullRequestPushCommits(
      env,
      {
        issue: issueRow,
        comment,
        doer: pusherRow,
        headBranch: prRow.headBranch,
        isForcePush: entry.forcePush,
        commits,
        ...(entry.forcePush ? { oldCommit: entry.old, newCommit: entry.new } : {}),
      },
      { now },
    );
  } catch (error) {
    log(`CreatePushPullComment failed (upstream's log-and-continue, agit.go:298): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The newest-capped `start..end` commit-id list, oldest-first — upstream
 * `rev-list --reverse -n limit start..end` (comment.go:47-55 keeps the
 * NEWEST `limit` of the range). The engine's listCommitsRange caps a page
 * keeping the OLDEST, so the newest window is collected by paging; bounded
 * at two pages of the cap — the shared push path's landed walk verbatim
 * (services/webhooks-push.ts newestLimitedCommitIds, the one documented
 * deviation from upstream's exact window noted there).
 */
async function newestLimitedAgitCommitIds(
  cell: { listCommitsRange(base: string, head: string, limit: number, page?: number): Promise<{ commits: Array<{ oid: string }>; more: boolean } | null> },
  start: string,
  end: string,
  log: (message: string) => void,
): Promise<string[]> {
  const collected: string[] = [];
  for (let page = 0; page < 2; page += 1) {
    const result = await cell.listCommitsRange(start, end, MAX_PUSH_COMMITS_IN_COMMENT, page);
    if (result === null) {
      log(`push-comment walk ${start.slice(0, 7)}..${end.slice(0, 7)} failed`);
      return collected.length > 0 ? collected.slice(-MAX_PUSH_COMMITS_IN_COMMENT) : [];
    }
    for (const commit of result.commits) collected.push(commit.oid);
    if (!result.more) break;
    if (page === 1) log(`push-comment walk truncated at ${collected.length} commits`);
  }
  return collected.slice(-MAX_PUSH_COMMITS_IN_COMMENT);
}

/**
 * The force-push comment reconcile (comment.go:41-66 +
 * cleanUpOldCommitCommentsForNewForcePush:70-92): every old NON-force
 * type-29 comment of the issue keeps only commit ids still present in the
 * new force list (emptied comments are deleted, others re-serialized), and
 * ids covered by a surviving old comment are removed from the new list (the
 * new comment carries only NEW ids). Old force-push comments are kept
 * verbatim. Counter-neutral, like upstream's raw update/delete. Parse
 * failures skip the comment. The shared push path's landed port verbatim
 * (services/webhooks-push.ts reconcileForcePushComments).
 */
async function reconcileAgitForcePushComments(db: D1Database, issueId: number, newCommitIds: string[]): Promise<string[]> {
  const oldComments = await drizzle(db)
    .select()
    .from(comments)
    .where(and(eq(comments.issueId, issueId), eq(comments.type, CommentType.PullRequestPush)))
    .all();
  const pending = new Set(newCommitIds);
  const deleteIds: number[] = [];
  const updates: Array<{ id: number; content: string }> = [];
  for (const oldComment of oldComments) {
    let data: PushActionContent;
    try {
      data = JSON.parse(oldComment.content ?? "") as PushActionContent;
    } catch {
      continue;
    }
    if (data.is_force_push === true) continue;
    const kept = data.commit_ids.filter((id) => pending.has(id));
    if (kept.length === 0) {
      deleteIds.push(oldComment.id);
      continue;
    }
    for (const id of kept) pending.delete(id);
    if (kept.length !== data.commit_ids.length) {
      updates.push({ id: oldComment.id, content: JSON.stringify({ is_force_push: false, commit_ids: kept }) });
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

/** A create whose translated command did not land: the pre-allocated rows
 *  die (the create route's ref-write-failure cleanup, api/routes/pulls.ts —
 *  upstream's cleanup order, services/pull/pull.go:157). No ref was written
 *  (the engine refused), so nothing engine-side needs undoing. */
export async function sweepAbandonedAgitCreate(env: AgitEnv, repo: RepositoryRow, entry: Extract<AgitPlanEntry, { kind: "create" }>): Promise<void> {
  try {
    await drizzle(env.DB).delete(issues).where(eq(issues.id, entry.issueId)).run();
    await drizzle(env.DB).delete(pullRequests).where(eq(pullRequests.id, entry.prId)).run();
  } catch (error) {
    console.error(
      `[agit] ${repo.ownerNamespace}/${repo.slug}: sweep of the abandoned create for ${entry.originalRef} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
