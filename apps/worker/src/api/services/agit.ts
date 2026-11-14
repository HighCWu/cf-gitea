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
 * The parity remainder (upstream arms the update arm runs that this lane
 * defers — recorded here and in the census row, not silently dropped):
 * `CreatePushPullComment` (the type-29 pull_push comment) and the
 * review-stale/dismiss maintenance (`MarkReviewsAsStale`/
 * `MarkReviewsAsNotStale`/`DismissApprovalReviews`) plus
 * `StartPullRequestCheckImmediately` on the update arm. The lane does run
 * the D1 re-arm (head_sha/status/divergence, the §3.4 sync shape) and the
 * `pull_request` action=opened (create) / `pull_request_sync`
 * action=synchronized (update) webhooks; the D-7c auto-merge re-check
 * enqueues through the shared push tail because the translated command IS a
 * `refs/pull/N/head` command to the collector.
 */

import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { ActionType, recordAction, type ActionDraft } from "./activity-feeds";
import { isUserBlockedBy } from "./blocks";
import { branchRef, pullHeadRef } from "./engine";
import { pullRequestDiffShortStatForEnv } from "./pull-engine";
import { apiUserFromRow, findRepositoryById, toApiRepository, type RepositoryRow, type UserRow, type Viewer } from "./repository";
import { toApiPullRequest } from "./pulls";
import { appOrigin } from "../../services/webhooks-push";
import { emitWebhookDeliveries, type HookEventType } from "../../issues/webhooks";
import { IssuesService, ellipsisDisplayString, MAX_TITLE_DISPLAY_WIDTH } from "../../issues/service";
import { issues, PRFlow, PRStatus, pullRequests, users } from "../../db/schema";

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

    // 2. The opened webhook + action row — the create route's emission shape
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

/** The update arm's post-receive work: the §3.4 re-arm (head_sha cache,
 *  status=checking re-arming the lazy mergeability check, the recomputed
 *  divergence — syncPullRequestHead's D1 shape, CAS-guarded by has_merged=0
 *  like upstream's UpdateColsIfNotMerged), then the `pull_request_sync`
 *  action=synchronized webhook (upstream PullRequestSynchronized,
 *  notifier.go:835-845 — before/after are the head ref's old/new oids).
 *  Upstream's type-29 push comment and the review-stale/dismiss maintenance
 *  are the recorded remainder (module header). */
export async function applyAgitUpdateTail(
  env: AgitEnv,
  repo: RepositoryRow,
  engineRepo: string,
  entry: Extract<AgitPlanEntry, { kind: "update" }>,
  pusherRow: UserRow,
  requestOrigin: string | undefined,
  waitUntil: ((promise: Promise<void>) => void) | undefined,
): Promise<void> {
  try {
    const cell = env.REPO.getByName(engineRepo);
    const divergence = await cell.countDivergence(branchRef(entry.baseBranch), entry.translatedRef);
    await drizzle(env.DB)
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
    const origin = appOrigin(env, requestOrigin);
    const sender = apiUserFromRow(pusherRow, { origin, requester: null });
    const viewer: Viewer = { origin, requester: sender };
    const issueRow = await drizzle(env.DB).select().from(issues).where(eq(issues.id, entry.issueId)).get();
    const prRow = await drizzle(env.DB).select().from(pullRequests).where(eq(pullRequests.id, entry.prId)).get();
    if (issueRow === undefined || prRow === undefined) return;
    const diffStats = await pullRequestDiffShortStatForEnv(env, pair, prRow);
    const rendered = await toApiPullRequest(env.DB, viewer, pair, issueRow, prRow, "payload", diffStats === null ? undefined : { diffStats });
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
    console.error(
      `[agit] ${repo.ownerNamespace}/${repo.slug}: update tail for ${entry.originalRef} failed (the push stands): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
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
