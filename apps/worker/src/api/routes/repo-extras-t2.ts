import { createRoute } from "@hono/zod-openapi";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import type { MergeStyle, RebaseOutcome } from "@cf-gitea/git-engine";

import {
  comments,
  issues,
  releaseAssets,
  repoCollaborators,
  repoTopics,
  repoTransfer,
  users,
} from "../../db/schema";
import { CommentType } from "../../issues/comment-types";
import {
  NotAuthorizedError,
  OwnerNotAssignableError,
  RepoService,
  TransferNotExistError,
} from "../../repos/service";
import { ApiError, apiErrorSchema } from "../errors";
import type { ApiEnv } from "../env";
import { loadRepoSettings } from "../services/repo-settings";
import { branchRef, engineCell, engineReads, refTipMap, resolveNamedRef } from "../services/engine";
import { listRepoAssignees } from "../services/repo-collaborators";
import { findPullRequestByIndex, pullRequestNotExistError, type PullRequestWithIssue } from "../services/pulls";
import { toApiAttachment } from "../services/release-assets";
import { assertDraftVisible, assertNotTagRecord, findReleaseForRepoById } from "../services/releases";
import {
  apiUserFromRow,
  findRepositoryById,
  findUserByName,
  toApiRepository,
  viewerOf,
  type RepositoryWithOwner,
  type Viewer,
} from "../services/repository";
import { canWriteRepository, isRepositoryAdmin, requireVisibleRepo } from "../services/repo-access";
import { lastCommitForPath } from "../services/contents";
import { refMissError, treeEntryMissError } from "./contents";
import { toApiCommit, toContentsEntry, usernamesByEmail } from "../services/git-models";
import { parseListOptions, setPaginationHeaders } from "../pagination";
import { repositorySchema } from "../models/repository";
import { userSchema, type User } from "../models/user";
import { attachmentSchema } from "../models/release";
import { contentsResponseSchema, type ContentsResponse } from "../models/contents";

/**
 * Tier-2 `repository`-tagged extras that need NO database schema changes
 * (SPEC-0004 appendix A table-free remainder rows). Every operation cites its
 * upstream handler in the read-only submodule; declared response codes are a
 * subset of the frozen contract per op.
 *
 * Operations (19; file-contents is a GET+POST pair):
 *   - POST /repos/{owner}/{repo}/transfer/accept (acceptRepoTransfer,
 *     routers/api/v1/repo/transfer.go:137-178): 202 + the moved Repository;
 *     the landed repos service runs the §2.5.4 transaction
 *     (repos/service.ts:415-460).
 *   - POST /repos/{owner}/{repo}/transfer/reject (rejectRepoTransfer,
 *     transfer.go:181-220): 200 + the untouched Repository; the pending-row
 *     delete rides RepoService.cancelTransfer with the eligibility gate
 *     ported HERE (the service's cancelTransfer has none).
 *   - GET /topics/search (topicSearch, routers/api/v1/repo/topic.go:264-312,
 *     registered anonymous at routers/api/v1/api.go:1870): keyword LIKE over
 *     the repo_topics store aggregated per topic name (upstream keeps a
 *     global `topic` table; this store is the denormalized per-repo list —
 *     repo_count is the GROUP BY aggregate, `id` a name-hash surrogate, below).
 *   - GET /repos/{owner}/{repo}/collaborators/{collaborator}/permission
 *     (repoGetRepoPermissions, routers/api/v1/repo/collaborators.go:72-119):
 *     self-or-repo-admin gate, then the effective access mode rendered as
 *     RepoCollaboratorPermission (convert.ToUserAndPermission, services/
 *     convert/user.go:135-142 — role_name mirrors the mode string).
 *   - GET /repos/{owner}/{repo}/assignees/{assignee} (repoCheckAssignee,
 *     collaborators.go:405-408 + issue_assignee.go:150-183): 204 when the
 *     user is in the assignee set (services/repo-collaborators.
 *     listRepoAssignees — the GetRepoAssignees port), 404 unknown-or-ineligible.
 *   - GET /repos/{owner}/{repo}/reviewers (repoGetReviewers,
 *     collaborators.go:304-330 over services/pull/reviewer.go:25-70):
 *     collaborators (mode >= read — every stored mode qualifies) plus the
 *     (non-org) owner, active users, name order — the upstream set with the
 *     org-team term dropped (orgs land with SPEC-0007).
 *   - GET /repos/{owner}/{repo}/issue_config (repoGetIssueConfig) and
 *     /issue_config/validate (repoValidateIssueConfig, routers/api/v1/repo/
 *     repo.go:1204-1252 over services/issue/template.go
 *     GetTemplateConfigFromDefaultBranch:159-181): the config file is read
 *     from the DEFAULT branch through the engine (4 candidate paths, .yaml
 *     before .yml — template.go:35-40), parsed by a yaml-subset parser
 *     (template.go:51-117 semantics), validated with upstream's exact
 *     contact-link error strings. A missing/invalid file answers the DEFAULT
 *     config (blank issues enabled, no links) — the GET handler ignores the
 *     error arm upstream (repo.go:1219), so it never 404s.
 *   - GET /repos/{owner}/{repo}/git/notes/{sha} (repoGetNote,
 *     routers/api/v1/repo/notes.go:16-90): the annotated commit resolves by
 *     ref-or-sha (engine readCommit), the note blob reads out of the
 *     refs/notes/commits tree with git's 2/38 fanout, and `commit` renders
 *     the LAST commit that touched the note (listLog path filter) —
 *     git.GetNoteWithLastCommit semantics.
 *   - POST /repos/{owner}/{repo}/pulls/{index}/comments/{id}/replies
 *     (repoCreatePullReviewCommentReply, routers/api/v1/repo/pull_review.go:
 *     209-287): the parent comment must be a CODE comment of this repo
 *     attached to a review; the reply is a new code comment sharing the
 *     parent's line/tree_path/patch/commit_sha/review_id (one batch with the
 *     numComments counter, the IssuesService.addComment discipline).
 *   - POST /repos/{owner}/{repo}/pulls/comments/{id}/resolve and /unresolve
 *     (repoResolvePullReviewComment / repoUnresolvePullReviewComment,
 *     pull_review.go:290-379 over models/issues/review.go:933-959,961-990):
 *     the MarkConversation port — set/clear comments.resolve_doer_id,
 *     idempotent, gated by CanMarkConversation (issue poster or repo write).
 *   - POST /repos/{owner}/{repo}/pulls/{index}/update (repoUpdatePullRequest,
 *     routers/api/v1/repo/pull.go UpdatePullRequest:1140-1245, registered
 *     api.go:1451): merges (or rebases) the base branch INTO the head branch
 *     through the engine — executeMerge / rebaseOnto + putRebaseObjects with
 *     the head branch as the CAS base (the pull-engine merge choreography,
 *     inverted; pull_service.Update, services/pull/update.go:29-107).
 *   - GET /repos/{owner}/{repo}/contents-ext/{filepath} (repoGetContentsExt,
 *     routers/api/v1/repo/file.go:704-772 over getRepoContents:818-829): the
 *     extended union read — {file_contents} for a file, {dir_contents} for a
 *     directory; "." or "/" lists the root (file.go:709-711).
 *   - GET+POST /repos/{owner}/{repo}/file-contents (repoGetFileContents /
 *     repoGetFileContentsPost, file.go:864-958): the batch read; GET carries
 *     the JSON body in the `body` query param (file.go:889-895), POST the
 *     JSON body; files that cannot be retrieved render as null entries.
 *   - GET+PATCH+DELETE /repos/{owner}/{repo}/releases/{id}/assets/
 *     {attachment_id} (repoGetReleaseAttachment / repoEditReleaseAttachment /
 *     repoDeleteReleaseAttachment, routers/api/v1/repo/release_attachment.go:
 *     40-87, 214-301, 303-360 over checkReleaseMatchRepo:19-34): the
 *     single-attachment sub-family release-assets.ts deferred to tier 2. The
 *     release lookup is the family's 404 rule set (repo-scoped global id,
 *     tag-record and draft invisibility); PATCH renames only
 *     (EditAttachmentOptions.name — release_attachment.go:273-275), DELETE
 *     drops the R2 object before the D1 row (retryable ordering); PATCH
 *     answers 201 and DELETE 204 exactly like upstream.
 *
 * Documented deviations (upstream behavior vs this instance):
 *   - transfer/accept admission: upstream admits ONLY the pending recipient
 *     (models/repo/transfer.go:143-159 CanUserAcceptOrRejectTransfer); the
 *     landed repos service also admits the current repo owner and site admins
 *     (repos/service.ts:422). The service is not edited by this batch — its
 *     broader grant stands.
 *   - transfer/reject admission: upstream-strict recipient-only (admins act
 *     via sudo) — asymmetric with accept by construction (see above).
 *   - resolve/unresolve/replies: upstream registers mustNotBeArchived
 *     (api.go:1445-1447,1475 → runtime 423) but the frozen contract omits 423
 *     for these ops, so no archived gate is declared or enforced here.
 *   - repoGetReviewers: upstream answers 403 "doer has no permission to get
 *     reviewers" for non-writers (collaborators.go:316); 403 is NOT in the
 *     declared response set ({200,404}), so the runtime 403 is the /user-401
 *     class — sent but undeclared (the orchestrator-owned
 *     RUNTIME_ONLY_RESPONSES table is not extended by this batch).
 *   - topicSearch ids: upstream topics carry global sequence ids
 *     (models/repo/topic.go); repo_topics keeps no topic rows, so `id` is a
 *     deterministic name hash (FNV-1a) — stable per name, not
 *     upstream-identical. repo_count is the exact per-topic repo aggregate.
 *   - issue_config parsing: a yaml-subset parser (the canonical config
 *     shape: blank_issues_enabled bool + contact_links list); structurally
 *     invalid files report a generic message where upstream surfaces go-yaml
 *     internals. Contact-link validation messages are upstream-exact
 *     (template.go:87-99); URLs validate per url.ParseRequestURI (absolute
 *     URI or absolute path).
 *   - repoUpdatePullRequest: upstream answers an EMPTY 403 body
 *     (ctx.Status(403)) and 500s on the up-to-date arm ("HeadBranch of PR N
 *     is up to date" → APIErrorInternal, pull.go:1237-1242 + update.go:50-53)
 *     — this instance's 403s carry the {message,url} body (SPEC-0004 §2.5
 *     header→body conversion) and the nothing-to-do engine outcomes
 *     (nothing_to_merge / up_to_date) answer the declared 200 instead of an
 *     undeclarable 500. The maintainer-edit term of upstream's
 *     CheckUserAllowedToUpdate is reduced to repo write access (forks cannot
 *     exist yet, so head repo == base repo). The engine's "importing" outcome
 *     maps to 409 here (405 is not in this op's declared set).
 *   - contents-ext unknown `includes` options and malformed file-contents
 *     `body` params answer upstream's 400s (file.go:750-752, 893-895) even
 *     though the contract declares only {200,404} — runtime-only codes, the
 *     /user-401 class again.
 *   - the attachment trio rides the landed family's stricter release rules
 *     (release-assets.ts): tag-only records are 404 for every release
 *     operation (upstream's checkReleaseMatchRepo never checks IsTag), and
 *     the disabled-releases gate 412s (mustEnableUnit, api.go:1433) —
 *     runtime-only, undeclared in the contract for these ops. PATCH's 422
 *     (allowed-types rejection, release_attachment.go:287-290) is declared
 *     but unreachable: this instance gates attachment uploads at create time
 *     only (the release-assets.ts header note).
 *
 * Ceded by this batch (reasons, for the report):
 *   - repoNewPinAllowed (GET /repos/{owner}/{repo}/new_pin_allowed): NOT
 *     implemented here — the concurrent issue-tables-t2 wave (routes/
 *     issue-tables-t2.ts, backed by the same landed issue_pins store)
 *     registers the identical operationId, and a second registration would
 *     collide (duplicate route + duplicated contract path). This module
 *     drops its copy; that wave's pin-cap handler is the only one.
 *
 * Rejected by this batch (reasons, for the report):
 *   - repoGetLicenses (GET /repos/{owner}/{repo}/licenses): upstream reads
 *     the `repo_license` TABLE populated at push time by the license
 *     detection pipeline (models/repo/license.go:46-52, UpdateRepoLicenses
 *     :66+) — table-dependent.
 *   - repoSigningKey / repoSigningKeySSH (signing-key.gpg/.pub): the contract
 *     declares 200 ONLY; without a configured signing key the only reachable
 *     status is 404 (routers/api/v1/misc/signing.go:14-24), which cannot be
 *     declared — the exact reason routes/misc-t2.ts dropped the global pair.
 *   - branch/tag protections, deploy keys (repos/keys*), repo teams, tracked
 *     times, requested_reviewers, the pulls reviews family: each needs its
 *     own store (protections, public_keys, teams, tracked_times, reviews,
 *     review-request state) — table-dependent.
 *   - activities/feeds: needs the `action` table.
 *   - avatar (POST/DELETE): needs avatar storage plus a repositories column.
 *   - hooks/git family: upstream reads server-side hook FILES from the repo
 *     directory (api.go:1264+); no filesystem or DO hook store exists.
 *   - wiki/*, actions/*, projects/*: tier-3 (SPEC-0004 appendix A).
 *   - /repos/migrate, mirror-sync, push_mirrors*: the SPEC-0009 lane.
 *   - generateRepo: a template-instantiation engine pass of its own.
 */

const notFoundResponse = {
  description: "notFound",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const forbiddenResponse = {
  description: "forbidden",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const validationErrorResponse = {
  description: "validationError",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const errorResponse = {
  description: "error",
  content: { "application/json": { schema: apiErrorSchema } },
} as const;

const ownerRepoParams = {
  owner: z.string().min(1).openapi({ description: "owner of the repo" }),
  repo: z.string().min(1).openapi({ description: "name of the repo" }),
} as const;

const formIntParam = (description: string) =>
  z.string().optional().openapi({ type: "integer", format: "int64", description });

/** Body bind hook: upstream's Go bind answers malformed bodies with 422. */
const bodyBind422 = ({ success }: { success: boolean }): undefined => {
  if (!success) {
    throw new ApiError(422, "invalid request body");
  }
  return undefined;
};

type RepoPair = RepositoryWithOwner;

function doerOf(c: Context<ApiEnv>): { id: number; isAdmin: boolean; login: string | null } {
  const doer = c.get("authUser");
  return { id: doer?.id ?? 0, isAdmin: doer?.is_admin === true, login: doer?.login ?? null };
}

/** The upstream "user does not exist [name: x]" message (user_model.ErrUserNotExist). */
function userNotExistError(name: string): ApiError {
  return new ApiError(404, `user does not exist [name: ${name}]`);
}

async function userById(d1: D1Database, id: number) {
  const rows = await drizzle(d1).select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Contract models (vendored definitions rendered inline, misc-t2 convention)
// ---------------------------------------------------------------------------

/** TopicResponse (modules/structs) — json tags: id / topic_name / repo_count. */
const topicResponseSchema = z
  .object({
    id: z.number().openapi({ description: "deterministic name-hash surrogate (upstream: global topic id)" }),
    topic_name: z.string(),
    repo_count: z.number(),
  })
  .openapi("TopicResponse");

const topicListResponseSchema = z.object({ topics: z.array(topicResponseSchema) }).openapi("TopicListResponse");

/** RepoCollaboratorPermission (modules/structs). */
const repoCollaboratorPermissionSchema = z
  .object({
    permission: z.enum(["none", "read", "write", "admin", "owner"]),
    role_name: z.string(),
    user: userSchema,
  })
  .openapi("RepoCollaboratorPermission");

/** IssueConfig + IssueConfigContactLink + IssueConfigValidation (modules/structs). */
const issueConfigContactLinkSchema = z
  .object({
    name: z.string(),
    url: z.string(),
    about: z.string(),
  })
  .openapi("IssueConfigContactLink");

const issueConfigSchema = z
  .object({
    blank_issues_enabled: z.boolean(),
    contact_links: z.array(issueConfigContactLinkSchema),
  })
  .openapi("IssueConfig");

const issueConfigValidationSchema = z
  .object({
    valid: z.boolean(),
    message: z.string(),
  })
  .openapi("IssueConfigValidation");

/** Note (modules/structs): the note text + the full rich Commit of the note. */
const noteSchema = z
  .object({
    message: z.string(),
    commit: z.record(z.string(), z.unknown()),
  })
  .openapi("Note");

/** CreatePullReviewCommentReplyOptions (modules/structs). */
const createReplyOptionsSchema = z
  .object({
    body: z.string().min(1).openapi({ description: "body of the reply" }),
  })
  .openapi("CreatePullReviewCommentReplyOptions");

/** PullReviewComment (modules/structs) — the wire projection of a code comment. */
const pullReviewCommentSchema = z
  .object({
    id: z.number(),
    body: z.string(),
    path: z.string(),
    commit_id: z.string(),
    original_commit_id: z.string(),
    diff_hunk: z.string(),
    position: z.number().nullable(),
    original_position: z.number().nullable(),
    pull_request_review_id: z.number(),
    pull_request_url: z.string(),
    html_url: z.string(),
    user: userSchema.nullable(),
    resolver: userSchema.nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("PullReviewComment");

/** ContentsExtResponse (modules/structs) — exactly one field is set. */
const contentsExtResponseSchema = z
  .object({
    file_contents: contentsResponseSchema.optional(),
    dir_contents: z.array(contentsResponseSchema).optional(),
  })
  .openapi("ContentsExtResponse");

/** GetFilesOptions (modules/structs). */
const getFilesOptionsSchema = z
  .object({
    files: z.array(z.string()).openapi({ description: "Files is the list of file paths to retrieve" }),
  })
  .openapi("GetFilesOptions");

const fileContentsListSchema = z
  .array(contentsResponseSchema.nullable())
  .openapi({ description: "ContentsListResponse — unretrievable files render as null entries (upstream file.go:908-912)" });

// ---------------------------------------------------------------------------
// topicSearch helpers
// ---------------------------------------------------------------------------

/** Deterministic topic-id surrogate: 32-bit FNV-1a over the name, unsigned. */
function topicId(name: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// ---------------------------------------------------------------------------
// issue_config helpers (services/issue/template.go port)
// ---------------------------------------------------------------------------

/** templateConfigCandidates (template.go:35-40), each tried .yaml then .yml. */
const ISSUE_CONFIG_CANDIDATES = [
  ".gitea/ISSUE_TEMPLATE/config",
  ".gitea/issue_template/config",
  ".github/ISSUE_TEMPLATE/config",
  ".github/issue_template/config",
];

const DEFAULT_ISSUE_CONFIG: ParsedIssueConfig = { blankIssuesEnabled: true, contactLinks: [] };

interface ParsedIssueConfig {
  blankIssuesEnabled: boolean;
  contactLinks: Array<{ name: string; url: string; about: string }>;
}

/**
 * The url.ParseRequestURI port: absolute URI (scheme + ":") or an absolute
 * path — anything else "is not a valid URL" (template.go:96-99).
 */
function isParseableRequestUri(raw: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.startsWith("/");
}

/**
 * yaml-subset parser for the canonical issue-config file shape
 * (template.go:51-117 GetTemplateConfig semantics): top-level
 * `blank_issues_enabled` bool and a `contact_links` block list. Returns the
 * DEFAULT config plus an upstream-style error on structural deviation (the
 * Go yaml.Unmarshal error arm).
 */
function parseIssueConfig(source: string): { config: ParsedIssueConfig; error: string | null } {
  const config: ParsedIssueConfig = { blankIssuesEnabled: DEFAULT_ISSUE_CONFIG.blankIssuesEnabled, contactLinks: [] };
  const PARSE_ERROR = "yaml: unmarshal errors: invalid config format";
  let inLinks = false;
  let current: Partial<{ name: string; url: string; about: string }> | null = null;
  const unquote = (value: string): string => {
    const trimmed = value.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  };
  for (const rawLine of source.split("\n")) {
    if (rawLine.trim() === "" || rawLine.trim().startsWith("#")) continue;
    const indented = /^\s/.test(rawLine);
    const line = rawLine.trim();
    if (!indented) {
      current = null;
      inLinks = false;
      const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
      if (match === null) return { config: DEFAULT_ISSUE_CONFIG, error: PARSE_ERROR };
      const [, key, value] = match;
      if (key === "blank_issues_enabled") {
        if (value !== "true" && value !== "false") return { config: DEFAULT_ISSUE_CONFIG, error: PARSE_ERROR };
        config.blankIssuesEnabled = value === "true";
      } else if (key === "contact_links") {
        if (value !== "") return { config: DEFAULT_ISSUE_CONFIG, error: PARSE_ERROR };
        inLinks = true;
      } else {
        return { config: DEFAULT_ISSUE_CONFIG, error: PARSE_ERROR };
      }
      continue;
    }
    if (!inLinks) continue; // nested content outside contact_links: tolerated
    const listMatch = /^-\s*(?:([A-Za-z0-9_-]+)\s*:\s*(.*))?$/.exec(line);
    if (listMatch !== null) {
      if (current !== null) config.contactLinks.push(current as { name: string; url: string; about: string });
      current = {};
      if (listMatch[1] !== undefined) {
        const key = listMatch[1] as "name" | "url" | "about";
        if (key !== "name" && key !== "url" && key !== "about") {
          return { config: DEFAULT_ISSUE_CONFIG, error: PARSE_ERROR };
        }
        current[key] = unquote(listMatch[2] ?? "");
      }
      continue;
    }
    const fieldMatch = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (fieldMatch !== null && current !== null) {
      const key = fieldMatch[1] as "name" | "url" | "about";
      if (key !== "name" && key !== "url" && key !== "about") {
        return { config: DEFAULT_ISSUE_CONFIG, error: PARSE_ERROR };
      }
      current[key] = unquote(fieldMatch[2] ?? "");
    }
  }
  if (current !== null) config.contactLinks.push(current as { name: string; url: string; about: string });
  return { config, error: null };
}

/** template.go:87-99 contact-link validation — upstream-exact messages. */
function validateIssueConfig(config: ParsedIssueConfig): string | null {
  for (const [position, link] of config.contactLinks.entries()) {
    if (link.name === undefined || link.name === "") {
      return `contact_link at position ${position + 1} is missing name key`;
    }
    if (link.url === undefined || link.url === "") {
      return `contact_link at position ${position + 1} is missing url key`;
    }
    if (link.about === undefined || link.about === "") {
      return `contact_link at position ${position + 1} is missing about key`;
    }
    if (!isParseableRequestUri(link.url)) {
      return `${link.url} is not a valid URL`;
    }
  }
  return null;
}

/**
 * GetTemplateConfigFromDefaultBranch (template.go:158-181) over the engine:
 * the DEFAULT branch commit, the 4 candidate paths (.yaml before .yml), the
 * 1 MiB read limit, and the two error arms — returns (config, error) exactly
 * like upstream (a missing file is the DEFAULT config with NO error; a
 * missing branch, an unparseable file or a validation failure is the DEFAULT
 * config WITH the error — GetTemplateConfig always pairs its first failure
 * with the default config, template.go:52-117).
 */
async function issueConfigFromDefaultBranch(
  c: Context<ApiEnv>,
  pair: RepoPair,
): Promise<{ config: ParsedIssueConfig; error: string | null }> {
  if (pair.repo.isEmpty) {
    return { config: { ...DEFAULT_ISSUE_CONFIG, contactLinks: [] }, error: null };
  }
  const reads = engineReads(c.env, pair.repo);
  const tips = refTipMap(await reads.listRefs());
  const defaultTip = tips.get(branchRef(pair.repo.defaultBranch))?.target;
  if (defaultTip === undefined) {
    // GetBranchCommit failure (template.go:164-166) — the ErrBranchNotExist text.
    return {
      config: { ...DEFAULT_ISSUE_CONFIG, contactLinks: [] },
      error: `branch does not exist [name: ${pair.repo.defaultBranch}]`,
    };
  }
  for (const base of ISSUE_CONFIG_CANDIDATES) {
    for (const extension of [".yaml", ".yml"]) {
      const blob = await reads.readBlob(defaultTip, base + extension);
      if (blob === null) continue;
      const parsed = parseIssueConfig(new TextDecoder().decode(blob.data).slice(0, 1024 * 1024));
      if (parsed.error !== null) {
        return { config: { ...DEFAULT_ISSUE_CONFIG, contactLinks: [] }, error: parsed.error };
      }
      const validationError = validateIssueConfig(parsed.config);
      if (validationError !== null) {
        return { config: { ...DEFAULT_ISSUE_CONFIG, contactLinks: [] }, error: validationError };
      }
      return { config: parsed.config, error: null };
    }
  }
  return { config: { ...DEFAULT_ISSUE_CONFIG, contactLinks: [] }, error: null };
}

// ---------------------------------------------------------------------------
// Review-comment helpers (routers/api/v1/repo/pull_review.go ports)
// ---------------------------------------------------------------------------

type CommentRow = typeof comments.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

/**
 * getPullReviewCommentToResolve (pull_review.go:383-400): the repo-scoped
 * comment, which must belong to a pull request and be a CODE comment.
 * Throws the upstream status (404 unknown, 400 not-a-PR / not-a-review-
 * comment); returns the comment row + its issue.
 */
async function resolveReviewCommentTarget(
  c: Context<ApiEnv>,
  found: RepoPair,
  commentId: number,
): Promise<{ comment: CommentRow; issue: IssueRow }> {
  const row = await drizzle(c.env.DB)
    .select({ comment: comments, issue: issues })
    .from(comments)
    .innerJoin(issues, eq(issues.id, comments.issueId))
    .where(and(eq(comments.id, commentId), eq(issues.repoId, found.repo.id)))
    .limit(1);
  const target = row[0];
  if (target === undefined) {
    throw new ApiError(404, "not found");
  }
  if (!target.issue.isPull) {
    throw new ApiError(400, "comment does not belong to a pull request");
  }
  if (target.comment.type !== CommentType.Code) {
    throw new ApiError(400, "comment is not a review comment");
  }
  return target;
}

/**
 * patch2diff (services/convert/pull_review.go:129-135): the stored hunks
 * render as their LAST hunk only — the "@@ …" tail after the final "\n@@".
 */
function patchToDiffHunk(patch: string | null): string {
  if (patch === null) return "";
  const split = patch.split("\n@@");
  return split.length === 2 ? `@@${split[1]}` : "";
}

/** ToPullReviewComment (services/convert/pull_review.go:103-127) wire shape. */
function toPullReviewComment(
  comment: CommentRow,
  issue: IssueRow,
  pair: RepoPair,
  viewer: Viewer,
  poster: User | null,
  resolver: User | null,
): z.infer<typeof pullReviewCommentSchema> {
  const origin = viewer.origin;
  const owner = encodeURIComponent(pair.repo.ownerNamespace);
  const slug = encodeURIComponent(pair.repo.slug);
  const pullUrl = `${origin}/${owner}/${slug}/pulls/${issue.index}`;
  const line = Math.abs(comment.line ?? 0);
  const negative = comment.line !== null && comment.line !== undefined && comment.line < 0;
  const iso = (value: Date | null | undefined) =>
    value === null || value === undefined ? "0001-01-01T00:00:00Z" : value.toISOString();
  return {
    id: comment.id,
    body: comment.content ?? "",
    path: comment.treePath ?? "",
    commit_id: comment.commitSha ?? "",
    original_commit_id: comment.oldRef ?? (comment.commitSha ?? ""),
    diff_hunk: patchToDiffHunk(comment.patch),
    position: negative ? null : line,
    original_position: negative ? line : null,
    pull_request_review_id: comment.reviewId ?? 0,
    pull_request_url: pullUrl,
    html_url: `${pullUrl}#issuecomment-${comment.id}`,
    user: poster,
    resolver,
    created_at: iso(comment.createdAt),
    updated_at: iso(comment.updatedAt),
  };
}

/** The poster User projection (ToAuthor; rows missing render null). */
async function posterUserOf(d1: D1Database, posterId: number | null, viewer: Viewer): Promise<User | null> {
  if (posterId === null) return null;
  const row = await userById(d1, posterId);
  return row === null ? null : apiUserFromRow(row, viewer);
}

// ---------------------------------------------------------------------------
// pulls/{index}/update helpers (routers/api/v1/repo/pull.go UpdatePullRequest)
// ---------------------------------------------------------------------------

function mergePersonOf(c: Context<ApiEnv>): { name: string; email: string; time: number; tz: string } {
  const doer = c.get("authUser");
  const hostname = new URL(c.req.url).hostname;
  const name = doer?.login ?? "Gitea";
  const email = doer?.email && doer.email !== "" ? doer.email : `${name.toLowerCase()}@noreply.${hostname}`;
  return { name, email, time: Math.floor(Date.now() / 1000), tz: "+0000" };
}

/**
 * pull_service.Update port over the engine: merge (or rebase) the BASE branch
 * into the HEAD branch. Outcomes map onto THIS op's declared family — 200
 * empty (committed, or nothing to do: both "already up to date" arms answer
 * 200 instead of upstream's undeclarable 500 — see the header), 409 conflicts
 * / CAS races / import gate, 422 engine refname validation. executeMerge's
 * 405 arm belongs to the merge op and is intentionally not reused: update
 * declares 409 where merge declares 405 (upstream IsErrMergeConflicts → 409
 * here).
 */
async function updatePullRequestBranch(
  c: Context<ApiEnv>,
  pair: RepoPair,
  pr: PullRequestWithIssue,
  rebase: boolean,
): Promise<void> {
  const cell = engineCell(c.env, pair.repo);
  const reads = engineReads(c.env, pair.repo);
  const tips = refTipMap(await reads.listRefs());
  const baseTip = tips.get(branchRef(pr.pullRequest.baseBranch))?.target;
  const headTip = tips.get(branchRef(pr.pullRequest.headBranch))?.target;
  if (baseTip === undefined || headTip === undefined) {
    throw new ApiError(404, "not found");
  }
  const headRef = branchRef(pr.pullRequest.headBranch);
  const message = `Merge branch '${pr.pullRequest.baseBranch}' into ${pr.pullRequest.headBranch}`;
  const person = mergePersonOf(c);

  let style: MergeStyle = "merge";
  let head: string = branchRef(pr.pullRequest.baseBranch);
  if (rebase) {
    const replay: RebaseOutcome = await cell.rebaseOnto({ head: headRef, onto: baseTip, committer: person });
    if (replay.tag === "up_to_date") {
      return; // the head already sits on the base: nothing to replay
    }
    if (replay.tag !== "rebased") {
      if (replay.tag === "conflict") throw new ApiError(409, "rebase failed because of conflict");
      if (replay.tag === "too_many") throw new ApiError(409, `too many commits to rebase [count: ${replay.count}]`);
      throw new ApiError(422, replay.tag);
    }
    const stored = await cell.putRebaseObjects(replay.objects);
    if (stored.tag !== "ok") {
      throw new ApiError(409, stored.tag === "invalid" ? stored.reason : "rebase too large");
    }
    style = "fast-forward-only";
    head = replay.headOid;
  }

  const result = await cell.executeMerge({
    style,
    base: headRef,
    head,
    expectedBaseOid: headTip,
    message,
    author: person,
    committer: person,
    extraRefUpdates: [],
  });
  if (result.tag === "committed" || result.tag === "nothing_to_merge") {
    return; // committed, or nothing to do (the up-to-date arm answers 200 — see the header)
  }
  if (result.tag === "conflict") {
    throw new ApiError(409, "merge failed because of conflict");
  }
  if (result.tag === "not_fast_forward" || result.tag === "ref_conflict") {
    throw new ApiError(409, `The branch update has failed, the ref moved [current: ${result.tag === "ref_conflict" ? result.currentOid : headTip}]`);
  }
  if (result.tag === "invalid") {
    throw new ApiError(422, result.reason);
  }
  throw new ApiError(409, "repository is importing");
}

// ---------------------------------------------------------------------------
// contents-ext / file-contents read helpers (routers/api/v1/repo/file.go)
// ---------------------------------------------------------------------------

/** Resolve the `ref` param (default branch fallback); null → the 404 arm.
 *  The default applies ONLY to the absent param (upstream file.go
 *  resolveRefCommit's util.IfZero); a non-empty unknown ref stays null. */
async function refTargetOrNull(c: Context<ApiEnv>, pair: RepoPair, refParam: string | null): Promise<string | null> {
  const tips = refTipMap(await engineReads(c.env, pair.repo).listRefs());
  if (refParam === null || refParam === "") {
    return tips.get(branchRef(pair.repo.defaultBranch))?.target ?? null;
  }
  return resolveNamedRef(tips, refParam)?.target ?? null;
}

/** Directory-entry render (the contents.ts list projection). */
async function contentsEntryForDirEntry(
  c: Context<ApiEnv>,
  pair: RepoPair,
  reads: ReturnType<typeof engineReads>,
  refTarget: string,
  treePath: string,
  entry: { name: string; mode: string; type: "tree" | "blob" | "commit"; oid: string; size?: number },
): Promise<ContentsResponse> {
  const path = treePath === "" ? entry.name : `${treePath}/${entry.name}`;
  const lastCommit = await lastCommitForPath(reads, refTarget, path);
  const kind: "file" | "dir" | "symlink" | "submodule" =
    entry.type === "tree" ? "dir" : entry.type === "commit" ? "submodule" : entry.mode === "120000" ? "symlink" : "file";
  return toContentsEntry(
    {
      path,
      name: entry.name,
      mode: entry.mode,
      oid: entry.oid,
      type: kind,
      size: entry.size ?? null,
      content: null,
      ...(lastCommit === null ? {} : { lastCommit }),
    },
    pair,
    new URL(c.req.url).origin,
  );
}

/** File (or symlink/submodule) render with optional inline content. */
async function contentsEntryFor(
  c: Context<ApiEnv>,
  pair: RepoPair,
  reads: ReturnType<typeof engineReads>,
  refTarget: string,
  path: string,
  withContent: boolean,
): Promise<ContentsResponse | null> {
  const blob = await reads.readBlob(refTarget, path);
  if (blob === null) {
    return null;
  }
  const lastCommit = await lastCommitForPath(reads, refTarget, path);
  const kind: "file" | "symlink" | "submodule" =
    blob.mode === "120000" ? "symlink" : blob.mode === "160000" ? "submodule" : "file";
  return toContentsEntry(
    {
      path,
      name: path.split("/").pop() ?? path,
      mode: blob.mode,
      oid: blob.oid,
      type: kind,
      size: blob.data.byteLength,
      content: withContent ? blob.data : null,
      ...(kind === "symlink" ? { target: new TextDecoder().decode(blob.data) } : {}),
      ...(lastCommit === null ? {} : { lastCommit }),
    },
    pair,
    new URL(c.req.url).origin,
  );
}

/**
 * file.go:818-829 getRepoContents — the union read behind contents-ext:
 * a directory lists its entries, anything else renders as a file.
 */
async function contentsExtPayload(
  c: Context<ApiEnv>,
  owner: string,
  repo: string,
  treePath: string,
  refParam: string | null,
): Promise<z.infer<typeof contentsExtResponseSchema>> {
  const pair = await requireVisibleRepo(c, { owner, repo });
  const reads = engineReads(c.env, pair.repo);
  const refTarget = await refTargetOrNull(c, pair, refParam);
  if (refTarget === null) {
    throw refMissError(pair.repo.defaultBranch, refParam);
  }
  const dir = treePath === "" ? await reads.listTree(refTarget) : await reads.listTree(refTarget, treePath);
  if (dir !== null) {
    const entries = await Promise.all(
      dir.entries.map((entry) => contentsEntryForDirEntry(c, pair, reads, refTarget, treePath, entry)),
    );
    return { dir_contents: entries };
  }
  const entry = await contentsEntryFor(c, pair, reads, refTarget, treePath, true);
  if (entry === null) {
    // GetContentsOrList → GetTreeEntryByPath — the ErrNotExist family 404
    // (modules/git/error.go:26), not the web locale string.
    throw await treeEntryMissError(reads, refTarget, treePath);
  }
  return { file_contents: entry };
}

/** Lenient GetFilesOptions.files reader for the GET `body` query form. */
function readFilesOption(parsed: unknown): string[] | null {
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const files = (parsed as { files?: unknown }).files;
  if (!Array.isArray(files)) {
    return null;
  }
  return files.filter((entry): entry is string => typeof entry === "string");
}

/** file.go:951-958 handleGetFileContents: per-file ContentsResponse or null. */
async function fileContentsPayload(
  c: Context<ApiEnv>,
  path: { owner: string; repo: string },
  files: string[],
  refParam: string | null,
): Promise<Array<ContentsResponse | null>> {
  const pair = await requireVisibleRepo(c, path);
  const reads = engineReads(c.env, pair.repo);
  const refTarget = await refTargetOrNull(c, pair, refParam);
  if (refTarget === null) {
    throw refMissError(pair.repo.defaultBranch, refParam);
  }
  return Promise.all(files.map((file) => contentsEntryFor(c, pair, reads, refTarget, file, true)));
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerRepoExtrasT2Routes(
  app: OpenAPIHono<ApiEnv>,
  requireAuth: MiddlewareHandler<ApiEnv>,
  optionalAuth: MiddlewareHandler<ApiEnv>,
): void {
  // -------------------------------------------------------------------------
  // GET /topics/search (topicSearch) — anonymous; keyword LIKE, paginated.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/topics/search",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "search topics via keyword",
      operationId: "topicSearch",
      request: {
        query: z.object({
          q: z.string().optional().openapi({ description: "keywords to search" }),
          page: formIntParam("page number of results to return (1-based)"),
          limit: formIntParam("page size of results"),
        }),
      },
      responses: {
        200: {
          description: "TopicListResponse",
          content: { "application/json": { schema: topicListResponseSchema } },
        },
        403: forbiddenResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const url = new URL(c.req.url);
      const options = parseListOptions(url);
      const keyword = (url.searchParams.get("q") ?? "").trim().toLowerCase();
      // NOT LIKE: D1 caps LIKE patterns at 50 bytes, so a long `?q=` needle
      // threw D1_ERROR and the route answered a plain 500. The substring
      // goes through instr() instead — the documented user-search precedent
      // (services/user.ts:81-97, the org-members 943e1e9 shape). The needle
      // pre-lowers and topics are stored lowercase (services/repo-topics.ts:
      // 63), so the pair stays case-insensitive like the LIKE was.
      const filter = keyword === "" ? undefined : sql`instr(${repoTopics.topic}, ${keyword}) > 0`;
      const groupedTotal = drizzle(c.env.DB)
        .select({ topic: repoTopics.topic })
        .from(repoTopics)
        .where(filter === undefined ? sql`1 = 1` : filter)
        .groupBy(repoTopics.topic)
        .as("topics_total");
      const totalRow = await drizzle(c.env.DB)
        .select({ n: sql<number>`count(*)` })
        .from(groupedTotal)
        .get();
      const rows = await drizzle(c.env.DB)
        .select({ topic: repoTopics.topic, repoCount: sql<number>`count(*)` })
        .from(repoTopics)
        .where(filter === undefined ? sql`1 = 1` : filter)
        .groupBy(repoTopics.topic)
        .orderBy(repoTopics.topic)
        .limit(options.limit)
        .offset((options.page - 1) * options.limit)
        .all();
      setPaginationHeaders(c, totalRow?.n ?? 0, options);
      return c.json(
        {
          topics: rows.map((row) => ({
            id: topicId(row.topic),
            topic_name: row.topic,
            repo_count: Number(row.repoCount),
          })),
        },
        200,
      );
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/collaborators/{collaborator}/permission
  // (repoGetRepoPermissions) — self-or-repo-admin gate.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/collaborators/{collaborator}/permission",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Get repository permissions for a user",
      operationId: "repoGetRepoPermissions",
      request: {
        params: z.object({
          ...ownerRepoParams,
          collaborator: z
            .string()
            .min(1)
            .openapi({ description: "username of the collaborator whose permissions are to be obtained" }),
        }),
      },
      responses: {
        200: {
          description: "RepoCollaboratorPermission",
          content: { "application/json": { schema: repoCollaboratorPermissionSchema } },
        },
        403: forbiddenResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      const { collaborator } = c.req.valid("param");
      const doer = doerOf(c);
      const selfQuery = doer.login !== null && doer.login.toLowerCase() === collaborator.toLowerCase();
      if (!doer.isAdmin && !selfQuery && !(await isRepositoryAdmin(c, found))) {
        throw new ApiError(
          403,
          "Only admins can query all permissions, repo admins can query all repo permissions, collaborators can query only their own",
        );
      }
      const target = await findUserByName(c.env.DB, collaborator);
      if (target === null) {
        throw userNotExistError(collaborator);
      }
      // GetIndividualUserRepoPermission reduced: owner → owner, site admin →
      // admin, collaborator row → its mode, else public read / private none.
      let permission: "none" | "read" | "write" | "admin" | "owner";
      if (found.repo.ownerId !== null && found.repo.ownerId === target.id) {
        permission = "owner";
      } else if (target.isAdmin) {
        permission = "admin";
      } else {
        const row = await drizzle(c.env.DB)
          .select({ mode: repoCollaborators.mode })
          .from(repoCollaborators)
          .where(and(eq(repoCollaborators.repoId, found.repo.id), eq(repoCollaborators.userId, target.id)))
          .get();
        permission = row !== undefined ? row.mode : found.repo.visibility === "public" ? "read" : "none";
      }
      const viewer = viewerOf(c);
      return c.json({ permission, role_name: permission, user: apiUserFromRow(target, viewer) }, 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/assignees/{assignee} (repoCheckAssignee).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/assignees/{assignee}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Check if a user can be assigned to issues in a repository",
      operationId: "repoCheckAssignee",
      request: {
        params: z.object({
          ...ownerRepoParams,
          assignee: z
            .string()
            .min(1)
            .openapi({ description: "username of the user to check for being an assignee" }),
        }),
      },
      responses: {
        204: { description: "empty" },
        400: errorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      const { assignee } = c.req.valid("param");
      const user = await findUserByName(c.env.DB, assignee);
      if (user === null) {
        throw userNotExistError(assignee);
      }
      const assignees = await listRepoAssignees(c.env.DB, found.repo);
      if (!assignees.some((row) => row.id === user.id)) {
        throw new ApiError(404, "not found");
      }
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/reviewers (repoGetReviewers) — writer gate
  // (runtime-only 403, undeclared), collaborators + owner by name order.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/reviewers",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Return all users that can be requested to review in this repo",
      operationId: "repoGetReviewers",
      request: { params: z.object(ownerRepoParams) },
      responses: {
        200: {
          description: "UserList",
          content: { "application/json": { schema: z.array(userSchema) } },
        },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      if (!(await canWriteRepository(c, found))) {
        // runtime-only (collaborators.go:316); the declared set stays {200,404}
        throw new ApiError(403, "doer has no permission to get reviewers");
      }
      const rows = await drizzle(c.env.DB)
        .select({ userId: repoCollaborators.userId })
        .from(repoCollaborators)
        .where(eq(repoCollaborators.repoId, found.repo.id))
        .orderBy(sql`rowid ASC`)
        .all();
      const ids = rows.map((row) => row.userId);
      if (found.repo.ownerId !== null && !ids.includes(found.repo.ownerId)) {
        ids.push(found.repo.ownerId); // reviewer.go:65-67 appends the owner last
      }
      const userRows = ids.length === 0 ? [] : await drizzle(c.env.DB).select().from(users).where(inArray(users.id, ids)).all();
      const viewer = viewerOf(c);
      const reviewers = userRows
        .filter((row) => row.status === "active")
        .sort((a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0));
      return c.json(reviewers.map((row) => apiUserFromRow(row, viewer)), 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/issue_config (repoGetIssueConfig) — always 200
  // with the parsed (or default) config; upstream ignores the error arm.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/issue_config",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Returns the issue config for a repo",
      operationId: "repoGetIssueConfig",
      request: { params: z.object(ownerRepoParams) },
      responses: {
        200: {
          description: "RepoIssueConfig",
          content: { "application/json": { schema: issueConfigSchema } },
        },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      const { config } = await issueConfigFromDefaultBranch(c, found);
      return c.json(
        {
          blank_issues_enabled: config.blankIssuesEnabled,
          contact_links: config.contactLinks.map((link) => ({ name: link.name, url: link.url, about: link.about })),
        },
        200,
      );
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/issue_config/validate (repoValidateIssueConfig).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/issue_config/validate",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Returns the validation information for a issue config",
      operationId: "repoValidateIssueConfig",
      request: { params: z.object(ownerRepoParams) },
      responses: {
        200: {
          description: "RepoIssueConfigValidation",
          content: { "application/json": { schema: issueConfigValidationSchema } },
        },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      const { error } = await issueConfigFromDefaultBranch(c, found);
      return c.json({ valid: error === null, message: error ?? "" }, 200);
    },
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/transfer/accept (acceptRepoTransfer) — 202 +
  // the moved Repository; the landed repos service owns the §2.5.4 transaction.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/transfer/accept",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Accept a repo transfer",
      operationId: "acceptRepoTransfer",
      request: { params: z.object(ownerRepoParams) },
      responses: {
        202: {
          description: "Repository",
          content: { "application/json": { schema: repositorySchema } },
        },
        403: forbiddenResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      const doer = doerOf(c);
      try {
        // The registry rides the accept (REDEPLOY8's flagged tail — the
        // repoEdit PATCH threads the same dep): bare construction skips
        // syncRegistryMove, so the moved repo 404s "repository not found" at
        // its NEW url while the registry still advertises the stale old key.
        await new RepoService(c.env.DB, {
          registry: c.env.REGISTRY.getByName("registry"),
        }).acceptTransfer(found.repo.id, { id: doer.id, isAdmin: doer.isAdmin });
      } catch (error) {
        if (error instanceof TransferNotExistError || error instanceof OwnerNotAssignableError) {
          throw new ApiError(404, error.message);
        }
        if (error instanceof NotAuthorizedError) {
          throw new ApiError(403, error.message);
        }
        throw error;
      }
      const moved = await findRepositoryById(c.env.DB, found.repo.id);
      if (moved === null) {
        throw new ApiError(404, "not found"); // unreachable: the row survived the move
      }
      const settings = await loadRepoSettings(c.env.DB, moved.repo.id);
      return c.json(toApiRepository(viewerOf(c), moved, settings), 202);
    },
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/transfer/reject (rejectRepoTransfer) — 200 +
  // the untouched Repository; recipient-only gate (models/repo/transfer.go:
  // 143-159).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/transfer/reject",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Reject a repo transfer",
      operationId: "rejectRepoTransfer",
      request: { params: z.object(ownerRepoParams) },
      responses: {
        200: {
          description: "Repository",
          content: { "application/json": { schema: repositorySchema } },
        },
        403: forbiddenResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      const pending = await drizzle(c.env.DB)
        .select()
        .from(repoTransfer)
        .where(eq(repoTransfer.repoId, found.repo.id))
        .get();
      if (pending === undefined) {
        throw new ApiError(404, `no pending transfer for repository: ${found.repo.id}`);
      }
      const doer = doerOf(c);
      // CanUserAcceptOrRejectTransfer (models/repo/transfer.go:143-159): a
      // user recipient is the only eligible rejecter (org terms land with
      // SPEC-0007); admins act through sudo upstream — mirrored here.
      if (pending.newOwnerId !== doer.id) {
        throw new ApiError(403, "permission denied");
      }
      await new RepoService(c.env.DB).cancelTransfer(found.repo.id);
      const settings = await loadRepoSettings(c.env.DB, found.repo.id);
      return c.json(toApiRepository(viewerOf(c), found, settings), 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/git/notes/{sha} (repoGetNote).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/git/notes/{sha}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get a note corresponding to a single commit from a repository",
      operationId: "repoGetNote",
      request: {
        params: z.object({
          ...ownerRepoParams,
          sha: z.string().min(1).openapi({ description: "a git ref or commit sha" }),
        }),
        query: z.object({
          verification: z
            .string()
            .optional()
            .openapi({ type: "boolean", description: "include verification for every commit (disable for speedup, default 'true')" }),
          files: z
            .string()
            .optional()
            .openapi({ type: "boolean", description: "include a list of affected files for every commit (disable for speedup, default 'true')" }),
        }),
      },
      responses: {
        200: {
          description: "Note",
          content: { "application/json": { schema: noteSchema } },
        },
        422: validationErrorResponse,
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      const { sha } = c.req.valid("param");
      // git.IsValidRefPattern (notes.go:55-58) — the declared 422 arm. The
      // control-character arm scans code points (the no-control-regex rule
      // forbids the literal character class).
      const hasControlChar = [...sha].some((ch) => {
        const code = ch.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
      });
      if (
        /[\s~^:?*[\]\\]/.test(sha) ||
        hasControlChar ||
        sha.includes("..") ||
        sha.startsWith("@{") ||
        sha.endsWith(".lock")
      ) {
        throw new ApiError(422, "no valid ref or sha: " + sha);
      }
      const reads = engineReads(c.env, found.repo);
      const commit = await reads.readCommit(sha);
      if (commit === null) {
        throw new ApiError(404, "not found"); // notes.go:63-67 (APIErrorAuto)
      }
      const noteTip = refTipMap(await reads.listRefs()).get("refs/notes/commits")?.target;
      if (noteTip === undefined) {
        throw new ApiError(404, "not found"); // GetNoteWithLastCommit: no notes ref
      }
      const fanout = `${commit.oid.slice(0, 2)}/${commit.oid.slice(2)}`;
      const blob = await reads.readBlob(noteTip, fanout);
      if (blob === null) {
        throw new ApiError(404, "not found"); // no note for this commit
      }
      // git.GetNoteWithLastCommit: the last commit that touched the note blob.
      const log = await reads.listLog(noteTip, { path: fanout, n: 1 });
      const noteCommit = log?.commits[0] ?? (await reads.readCommit(noteTip));
      if (noteCommit === null) {
        throw new ApiError(500, ""); // transport failure on the notes ref read
      }
      const viewer = viewerOf(c);
      const rendered = await toApiCommit(
        c.env.DB,
        reads,
        viewer,
        found,
        noteCommit,
        await usernamesByEmail(c.env.DB, [noteCommit]),
        { stat: true, files: true },
      );
      return c.json({ message: new TextDecoder().decode(blob.data), commit: rendered }, 200);
    },
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/pulls/comments/{id}/resolve + /unresolve
  // (repoResolvePullReviewComment / repoUnresolvePullReviewComment).
  // -------------------------------------------------------------------------

  /**
   * The MarkConversation arm shared by resolve/unresolve (pull_review.go:
   * 361-383 + models/issues/review.go:933-959,961-990).
   */
  const updateResolveState = async (
    c: Context<ApiEnv>,
    found: RepoPair,
    commentId: number,
    isResolve: boolean,
  ): Promise<Response> => {
    const target = await resolveReviewCommentTarget(c, found, commentId);
    // CanMarkConversation (review.go:961-990): the issue poster, or repo
    // write access (the official-reviewer term lands with the reviews
    // feature). Upstream's archived gate is the undeclared-423 class above.
    const doer = doerOf(c);
    const isPoster = target.issue.posterId !== null && target.issue.posterId === doer.id;
    if (!isPoster && !(await canWriteRepository(c, found))) {
      throw new ApiError(403, "user should have permission to resolve comment");
    }
    // MarkConversation is idempotent: same-state rows are left untouched.
    const resolved = target.comment.resolveDoerId !== null && target.comment.resolveDoerId !== 0;
    if (isResolve === resolved) {
      return c.body(null, 204);
    }
    await drizzle(c.env.DB)
      .update(comments)
      .set({ resolveDoerId: isResolve ? doer.id : null })
      .where(eq(comments.id, target.comment.id));
    return c.body(null, 204);
  };

  const resolveRoute = (variant: "resolve" | "unresolve", operationId: string) =>
    createRoute({
      method: "post",
      path: `/repos/{owner}/{repo}/pulls/comments/{id}/${variant}`,
      middleware: [requireAuth],
      tags: ["repository"],
      summary: `${variant === "resolve" ? "Resolve" : "Unresolve"} a pull request review comment`,
      operationId,
      request: {
        params: z.object({
          ...ownerRepoParams,
          id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the review comment" }),
        }),
      },
      responses: {
        204: { description: "empty" },
        400: validationErrorResponse,
        403: forbiddenResponse,
        404: notFoundResponse,
      },
    });

  app.openapi(resolveRoute("resolve", "repoResolvePullReviewComment"), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    const { id } = c.req.valid("param");
    return updateResolveState(c, found, Number(id), true);
  });
  app.openapi(resolveRoute("unresolve", "repoUnresolvePullReviewComment"), async (c) => {
    const found = await requireVisibleRepo(c, c.req.valid("param"));
    const { id } = c.req.valid("param");
    return updateResolveState(c, found, Number(id), false);
  });

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/pulls/{index}/comments/{id}/replies
  // (repoCreatePullReviewCommentReply).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/pulls/{index}/comments/{id}/replies",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Reply to a pull request review comment",
      operationId: "repoCreatePullReviewCommentReply",
      request: {
        params: z.object({
          ...ownerRepoParams,
          index: z.string().min(1).openapi({ type: "integer", format: "int64", description: "index of the pull request" }),
          id: z
            .string()
            .min(1)
            .openapi({ type: "integer", format: "int64", description: "id of the review comment to reply to" }),
        }),
        body: { content: { "application/json": { schema: createReplyOptionsSchema } } },
      },
      responses: {
        201: {
          description: "PullReviewComment",
          content: { "application/json": { schema: pullReviewCommentSchema } },
        },
        400: validationErrorResponse,
        404: notFoundResponse,
        422: validationErrorResponse,
      },
    }),
    async (c) => {
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      const { index, id } = c.req.valid("param");
      const form = c.req.valid("json");
      const parent = await resolveReviewCommentTarget(c, found, Number(id));
      if (String(parent.issue.index) !== index) {
        // pull_review.go:261-264 — the parent's PR must be the path's {index}
        throw new ApiError(404, "not found");
      }
      if ((parent.comment.reviewId ?? 0) === 0) {
        // pull_review.go:265-268 — replies attach to the parent's review
        throw new ApiError(400, "comment is not a review comment");
      }
      const doer = doerOf(c);
      const now = new Date();
      const results = await drizzle(c.env.DB).batch([
        drizzle(c.env.DB)
          .insert(comments)
          .values({
            type: CommentType.Code,
            posterId: doer.id,
            issueId: parent.issue.id,
            line: parent.comment.line,
            treePath: parent.comment.treePath,
            content: form.body,
            patch: parent.comment.patch,
            commitSha: parent.comment.commitSha,
            reviewId: parent.comment.reviewId,
            createdAt: now,
            updatedAt: now,
          })
          .returning(),
        drizzle(c.env.DB)
          .update(issues)
          .set({ numComments: sql`num_comments + 1`, updatedAt: now })
          .where(eq(issues.id, parent.issue.id)),
      ]);
      const inserted = results[0][0];
      if (inserted === undefined) {
        throw new ApiError(500, "");
      }
      const viewer = viewerOf(c);
      const poster = await posterUserOf(c.env.DB, inserted.posterId, viewer);
      return c.json(toPullReviewComment(inserted, parent.issue, found, viewer, poster, null), 201);
    },
    bodyBind422,
  );

  // -------------------------------------------------------------------------
  // POST /repos/{owner}/{repo}/pulls/{index}/update (repoUpdatePullRequest).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/pulls/{index}/update",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Merge PR's baseBranch into headBranch",
      operationId: "repoUpdatePullRequest",
      request: {
        params: z.object({
          ...ownerRepoParams,
          index: z.string().min(1).openapi({ type: "integer", format: "int64", description: "index of the pull request to get" }),
        }),
        query: z.object({
          style: z
            .string()
            .optional()
            .openapi({ description: "how to update pull request", enum: ["merge", "rebase"] }),
        }),
      },
      responses: {
        200: { description: "empty" },
        403: forbiddenResponse,
        404: notFoundResponse,
        409: errorResponse,
        422: validationErrorResponse,
      },
    }),
    async (c) => {
      const found = await requireVisibleRepo(c, c.req.valid("param"));
      const { index } = c.req.valid("param");
      const pr = await findPullRequestByIndex(c.env.DB, found.repo.id, Number(index));
      if (pr === null) {
        throw pullRequestNotExistError(found.repo.id, Number(index));
      }
      if (pr.pullRequest.hasMerged) {
        throw new ApiError(422, "pull request is already merged");
      }
      if (pr.issue.isClosed) {
        throw new ApiError(422, "pull request is already closed");
      }
      if (!(await canWriteRepository(c, found))) {
        // CheckUserAllowedToUpdate reduced (forks cannot exist yet — the head
        // repo IS this repo); upstream answers an empty 403 body.
        throw new ApiError(403, "Must have write access");
      }
      await updatePullRequestBranch(c, found, pr, c.req.valid("query").style === "rebase");
      return c.body(null, 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET /repos/{owner}/{repo}/contents-ext/{filepath} (repoGetContentsExt).
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/contents-ext/{filepath}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: 'The extended "contents" API, to get file metadata and/or content, or list a directory.',
      operationId: "repoGetContentsExt",
      request: {
        params: z.object({
          ...ownerRepoParams,
          filepath: z.string().openapi({
            description:
              'path of the dir, file, symlink or submodule in the repo. Pass a single dot (".") to get the root directory.',
          }),
        }),
        query: z.object({
          ref: z
            .string()
            .optional()
            .openapi({ description: "the name of the commit/branch/tag, default to the repository’s default branch." }),
          includes: z.string().optional().openapi({
            description:
              'By default this API\'s response only contains file\'s metadata. Use comma-separated "includes" options to retrieve more fields.',
          }),
        }),
      },
      responses: {
        200: {
          description: "ContentsExtResponse",
          content: { "application/json": { schema: contentsExtResponseSchema } },
        },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { owner, repo, filepath } = c.req.valid("param");
      const query = c.req.valid("query");
      for (const include of (query.includes ?? "").split(",")) {
        if (
          include === "" ||
          include === "file_content" ||
          include === "lfs_metadata" ||
          include === "commit_metadata" ||
          include === "commit_message"
        ) {
          continue;
        }
        // upstream answers 400 for unknown options (file.go:750-752); 400 is
        // not in the declared set {200,404} — runtime-only, /user-401 class.
        throw new ApiError(400, `unknown include option "${include}"`);
      }
      const treePath = filepath === "." || filepath === "/" ? "" : filepath;
      return c.json(await contentsExtPayload(c, owner, repo, treePath, query.ref ?? null), 200);
    },
  );

  // -------------------------------------------------------------------------
  // GET+POST /repos/{owner}/{repo}/file-contents (repoGetFileContents /
  // repoGetFileContentsPost) — the batch read; unretrievable files render as
  // null entries exactly like upstream.
  // -------------------------------------------------------------------------
  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/file-contents",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get the metadata and contents of requested files",
      operationId: "repoGetFileContents",
      request: {
        params: z.object(ownerRepoParams),
        query: z.object({
          ref: z
            .string()
            .optional()
            .openapi({ description: "The name of the commit/branch/tag. Default to the repository’s default branch." }),
          body: z
            .string()
            .optional()
            .openapi({ description: 'The JSON encoded body (see the POST request): {"files": ["filename1", "filename2"]}' }),
        }),
      },
      responses: {
        200: {
          description: "ContentsListResponse",
          content: { "application/json": { schema: fileContentsListSchema } },
        },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { owner, repo } = c.req.valid("param");
      const query = c.req.valid("query");
      if (query.body === undefined || query.body === "") {
        // file.go:893-895 (runtime-only 400 — the contract declares {200,404})
        throw new ApiError(400, "invalid body parameter");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(query.body);
      } catch {
        throw new ApiError(400, "invalid body parameter");
      }
      const files = readFilesOption(parsed);
      if (files === null) {
        throw new ApiError(400, "invalid body parameter");
      }
      return c.json(await fileContentsPayload(c, { owner, repo }, files, query.ref ?? null), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/repos/{owner}/{repo}/file-contents",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get the metadata and contents of requested files",
      operationId: "repoGetFileContentsPost",
      request: {
        params: z.object(ownerRepoParams),
        query: z.object({
          ref: z
            .string()
            .optional()
            .openapi({ description: "The name of the commit/branch/tag. Default to the repository’s default branch." }),
        }),
        body: { content: { "application/json": { schema: getFilesOptionsSchema } } },
      },
      responses: {
        200: {
          description: "ContentsListResponse",
          content: { "application/json": { schema: fileContentsListSchema } },
        },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const { owner, repo } = c.req.valid("param");
      const form = c.req.valid("json");
      return c.json(await fileContentsPayload(c, { owner, repo }, form.files, c.req.valid("query").ref ?? null), 200);
    },
    bodyBind422,
  );

  // -------------------------------------------------------------------------
  // GET+PATCH+DELETE /repos/{owner}/{repo}/releases/{id}/assets/{attachment_id}
  // (repoGetReleaseAttachment / repoEditReleaseAttachment /
  // repoDeleteReleaseAttachment) — the single-attachment sub-family
  // release-assets.ts deferred to tier 2. The 401/403 auth classes on the
  // writes and the 412 unit gate are runtime-only here (undeclared in the
  // contract for these ops — the release-assets.ts posture).
  // -------------------------------------------------------------------------

  const attachmentItemParams = {
    ...ownerRepoParams,
    id: z.string().min(1).openapi({ type: "integer", format: "int64", description: "id of the release" }),
    attachment_id: z
      .string()
      .min(1)
      .openapi({ type: "integer", format: "int64", description: "id of the attachment" }),
  };

  /** Go PathParamInt64 — non-integer strings become 0 (lookup miss → 404). */
  const attachmentPathId = (raw: string): number => {
    if (!/^-?\d+$/.test(raw)) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isSafeInteger(parsed) ? parsed : 0;
  };

  /** The disabled-releases gate both landed asset routes share (412
   *  runtime-only; mustEnableUnit(unit.TypeReleases), api.go:1433). */
  const requireAssetsRepo = async (c: Context<ApiEnv>, path: { owner: string; repo: string }) => {
    const found = await requireVisibleRepo(c, path);
    const settings = await loadRepoSettings(c.env.DB, found.repo.id);
    if (!settings.hasReleases) {
      throw new ApiError(412, "releases are disabled for this repo");
    }
    return found;
  };

  /** The single-release 404 rules (repo-scoped global id; tag records
   *  invisible — the release-assets.ts requireReleaseForAssets twin). */
  const requireAssetRelease = async (c: Context<ApiEnv>, found: RepoPair, rawId: string) => {
    const release = await findReleaseForRepoById(c.env.DB, found.repo.id, attachmentPathId(rawId));
    if (release === null) {
      throw new ApiError(404, "not found");
    }
    assertNotTagRecord(release);
    return release;
  };

  /** The writer grant (reqRepoWriter(TypeReleases) reduced — release-assets.ts
   *  requireAssetWriter twin). */
  const requireAssetWriter = async (c: Context<ApiEnv>, found: RepoPair): Promise<void> => {
    if (await canWriteRepository(c, found)) {
      return;
    }
    throw new ApiError(403, "token does not have the required scope or the user does not have write access");
  };

  /** GetAttachmentByID + the ReleaseID match (release_attachment.go:49-59,
   *  238-248, 325-335): 404 when the row is missing or belongs to another
   *  release of this repo. */
  const findAttachmentOfRelease = async (d1: D1Database, releaseId: number, rawAttachmentId: string) => {
    const attachmentId = attachmentPathId(rawAttachmentId);
    if (attachmentId <= 0) {
      return null;
    }
    const row = await drizzle(d1).select().from(releaseAssets).where(eq(releaseAssets.id, attachmentId)).get();
    if (row === undefined || row.releaseId !== releaseId) {
      return null;
    }
    return row;
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/repos/{owner}/{repo}/releases/{id}/assets/{attachment_id}",
      middleware: [optionalAuth],
      tags: ["repository"],
      summary: "Get a release attachment",
      operationId: "repoGetReleaseAttachment",
      request: { params: z.object(attachmentItemParams) },
      responses: {
        200: { description: "Attachment", content: { "application/json": { schema: attachmentSchema } } },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const found = await requireAssetsRepo(c, c.req.valid("param"));
      const { id, attachment_id } = c.req.valid("param");
      const release = await requireAssetRelease(c, found, id);
      // checkReleaseMatchRepo's draft arm: drafts stay 404 without release
      // write access (release_attachment.go:29-32).
      assertDraftVisible({ canWrite: await canWriteRepository(c, found) }, release);
      const attach = await findAttachmentOfRelease(c.env.DB, release.id, attachment_id);
      if (attach === null) {
        throw new ApiError(404, "not found");
      }
      return c.json(toApiAttachment(new URL(c.req.url).origin, attach), 200);
    },
  );

  const editAttachmentRoute = createRoute({
    method: "patch",
    path: "/repos/{owner}/{repo}/releases/{id}/assets/{attachment_id}",
    middleware: [requireAuth],
    tags: ["repository"],
    summary: "Edit a release attachment",
    operationId: "repoEditReleaseAttachment",
    request: {
      params: z.object(attachmentItemParams),
      body: {
        content: {
          "application/json": {
            schema: z
              .object({
                name: z.string().optional().openapi({ description: "Name is the new filename for the attachment" }),
              })
              .openapi("EditAttachmentOptions"),
          },
        },
      },
    },
    responses: {
      // upstream answers 201 on edit (release_attachment.go:297) — kept verbatim
      201: { description: "Attachment", content: { "application/json": { schema: attachmentSchema } } },
      404: notFoundResponse,
      422: validationErrorResponse,
    },
  });

  app.openapi(
    editAttachmentRoute,
    async (c) => {
      const found = await requireAssetsRepo(c, c.req.valid("param"));
      await requireAssetWriter(c, found);
      const { id, attachment_id } = c.req.valid("param");
      const release = await requireAssetRelease(c, found, id);
      assertDraftVisible({ canWrite: true }, release); // writers see drafts
      const attach = await findAttachmentOfRelease(c.env.DB, release.id, attachment_id);
      if (attach === null) {
        throw new ApiError(404, "not found");
      }
      const form = c.req.valid("json");
      // Upstream renames only when a non-empty name arrives
      // (release_attachment.go:273-275); there is no content to re-validate,
      // so the declared 422 arm (allowed-types, :287-290) stays unreachable.
      if (form.name !== undefined && form.name !== "") {
        await drizzle(c.env.DB).update(releaseAssets).set({ name: form.name }).where(eq(releaseAssets.id, attach.id));
      }
      const updated = await drizzle(c.env.DB).select().from(releaseAssets).where(eq(releaseAssets.id, attach.id)).get();
      if (updated === undefined) {
        throw new ApiError(404, "not found"); // deleted concurrently mid-request
      }
      return c.json(toApiAttachment(new URL(c.req.url).origin, updated), 201);
    },
    bodyBind422,
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/repos/{owner}/{repo}/releases/{id}/assets/{attachment_id}",
      middleware: [requireAuth],
      tags: ["repository"],
      summary: "Delete a release attachment",
      operationId: "repoDeleteReleaseAttachment",
      request: { params: z.object(attachmentItemParams) },
      responses: {
        204: { description: "empty" },
        404: notFoundResponse,
      },
    }),
    async (c) => {
      const found = await requireAssetsRepo(c, c.req.valid("param"));
      await requireAssetWriter(c, found);
      const { id, attachment_id } = c.req.valid("param");
      const release = await requireAssetRelease(c, found, id);
      assertDraftVisible({ canWrite: true }, release); // writers see drafts
      const attach = await findAttachmentOfRelease(c.env.DB, release.id, attachment_id);
      if (attach === null) {
        throw new ApiError(404, "not found");
      }
      // Storage first: a failed R2 delete leaves the D1 row intact and the
      // request retryable (upstream DeleteAttachment deletes the file too,
      // release_attachment.go:350-358).
      await c.env.REPO_PACKS.delete(attach.r2Key);
      await drizzle(c.env.DB).delete(releaseAssets).where(eq(releaseAssets.id, attach.id));
      return c.body(null, 204);
    },
  );

  // -------------------------------------------------------------------------
  // Plain-hono catchall OUTSIDE the generated doc (the routes/contents.ts
  // precedent): the multi-segment contents-ext paths the zod-openapi
  // single-param route cannot match. The openapi route wins its shared
  // single-segment requests by registration order; this answers the rest.
  // -------------------------------------------------------------------------
  app.get("/repos/:owner/:repo/contents-ext/*", (c) => {
    const { owner, repo } = c.req.param();
    const prefix = `/${owner}/${repo}/contents-ext/`;
    const index = c.req.path.indexOf(prefix);
    const filepath = decodeURIComponent(index < 0 ? "" : c.req.path.slice(index + prefix.length));
    const treePath = filepath === "." || filepath === "/" ? "" : filepath;
    return contentsExtPayload(c, owner, repo, treePath, c.req.query("ref") ?? null).then((payload) =>
      c.json(payload, 200),
    );
  });
}
