/**
 * The stored gitea webhook payloads, as the provider requesters read them —
 * the JSON wire shapes of upstream's `api.*` payload structs
 * (gitea/modules/structs/hook.go + the embedded structs from user.go /
 * repo.go / issue.go / pull.go / issue_comment.go / release.go / package.go /
 * issue_milestone.go / org.go / repo_actions.go; JSON tags verified at the
 * pin). `newPayload` (services/webhook/payloader.go:44-91) re-parses the
 * stored payload per EVENT TYPE into one of these and dispatches it to the
 * provider convertor; this module is that parse+dispatch step.
 *
 * Go's json.Unmarshal maps absent fields to zero values, so every field is
 * optional here and the convertors treat undefined exactly like Go's zero
 * value (empty string / 0 / nil). A nil dereference upstream PANICS inside
 * Deliver (recovered → the delivery fails, services/webhook/deliver.go:153-160);
 * the `nonNil` helper throws the same observable outcome — a terminal
 * ProviderPayloadError the consumer records as a failed delivery.
 */

/** Upstream `api.PayloadUser` (hook.go:126-135). */
export interface PayloadUser {
  name?: string;
  email?: string;
  username?: string;
}

/** Upstream `api.PayloadCommit` — the fields the convertors read (hook.go:142-178). */
export interface PayloadCommit {
  id?: string;
  message?: string;
  url?: string;
  author?: PayloadUser | null;
  committer?: PayloadUser | null;
}

/** Upstream `api.User` (user.go:15-40) — `UserName` serializes as `login`. */
export interface ApiUser {
  id?: number;
  login?: string;
  full_name?: string;
  avatar_url?: string;
  html_url?: string;
}

/** Upstream `api.Repository` (repo.go) — the fields the convertors read. */
export interface ApiRepository {
  name?: string;
  full_name?: string;
  html_url?: string;
}

/** Upstream `api.Milestone` (issue_milestone.go:13-30). */
export interface ApiMilestone {
  id?: number;
  title?: string;
  description?: string;
}

/** Upstream `api.Issue` (issue.go:51-80) — `Index` serializes as `number`, `Poster` as `user`. */
export interface ApiIssue {
  id?: number;
  url?: string;
  html_url?: string;
  number?: number;
  user?: ApiUser | null;
  title?: string;
  body?: string;
  assignees?: ApiUser[] | null;
  milestone?: ApiMilestone | null;
}

/** Upstream `api.PullRequest` (pull.go) — `merged` is `HasMerged`. */
export interface ApiPullRequest {
  id?: number;
  url?: string;
  html_url?: string;
  number?: number;
  user?: ApiUser | null;
  title?: string;
  body?: string;
  merged?: boolean;
  assignees?: ApiUser[] | null;
  milestone?: ApiMilestone | null;
}

/** Upstream `api.Comment` (issue_comment.go:12-30). */
export interface ApiComment {
  html_url?: string;
  pull_request_url?: string;
  issue_url?: string;
  body?: string;
}

/** Upstream `api.Release` (release.go:11-44) — `Note` is `body`, `Title` is `name`. */
export interface ApiRelease {
  tag_name?: string;
  name?: string;
  body?: string;
  url?: string;
  html_url?: string;
  assets?: unknown[] | null;
}

/** Upstream `api.Package` (package.go:12-31). */
export interface ApiPackage {
  html_url?: string;
  name?: string;
  version?: string;
  type?: string;
}

/** Upstream `api.Organization` (org.go:7-18). */
export interface ApiOrganization {
  name?: string;
  full_name?: string;
  avatar_url?: string;
}

/** Upstream `api.ActionWorkflowRun` (repo_actions.go) — the fields the convertors read. */
export interface ActionWorkflowRun {
  html_url?: string;
  display_title?: string;
  id?: number;
  head_sha?: string;
  status?: string;
  conclusion?: string;
}

/** Upstream `api.ActionWorkflowJob` (repo_actions.go:202-227). */
export interface ActionWorkflowJob {
  html_url?: string;
  name?: string;
  run_id?: number;
  head_sha?: string;
  status?: string;
  conclusion?: string;
}

/** Upstream `api.ChangesPayload` (hook.go:474-489). */
export interface ChangesPayload {
  title?: { from?: string } | null;
  body?: { from?: string } | null;
  ref?: { from?: string } | null;
  name?: { from?: string } | null;
  added_assignees?: ApiUser[] | null;
  removed_assignees?: ApiUser[] | null;
}

/** Upstream `api.CreatePayload` (hook.go:212-231). */
export interface CreatePayload {
  sha?: string;
  ref?: string;
  ref_type?: string;
  repository?: ApiRepository | null;
  sender?: ApiUser | null;
}

/** Upstream `api.DeletePayload` (hook.go:243-256). */
export interface DeletePayload {
  ref?: string;
  ref_type?: string;
  repository?: ApiRepository | null;
  sender?: ApiUser | null;
}

/** Upstream `api.ForkPayload` (hook.go:263-273). */
export interface ForkPayload {
  forkee?: ApiRepository | null;
  repository?: ApiRepository | null;
  sender?: ApiUser | null;
}

/** Upstream `api.PushPayload` (hook.go:352-379). */
export interface PushPayload {
  ref?: string;
  before?: string;
  after?: string;
  compare_url?: string;
  commits?: PayloadCommit[] | null;
  total_commits?: number;
  head_commit?: PayloadCommit | null;
  repository?: ApiRepository | null;
  pusher?: ApiUser | null;
  sender?: ApiUser | null;
}

/** Upstream `api.IssuePayload` (hook.go:404-421). */
export interface IssuePayload {
  action?: string;
  number?: number;
  changes?: ChangesPayload | null;
  issue?: ApiIssue | null;
  repository?: ApiRepository | null;
  sender?: ApiUser | null;
}

/** Upstream `api.IssueCommentPayload` (hook.go:296-315). */
export interface IssueCommentPayload {
  action?: string;
  issue?: ApiIssue | null;
  comment?: ApiComment | null;
  repository?: ApiRepository | null;
  sender?: ApiUser | null;
  is_pull?: boolean;
}

/** Upstream `api.PullRequestPayload` (hook.go:495-515) — `Review` carries the review body. */
export interface PullRequestPayload {
  action?: string;
  number?: number;
  changes?: ChangesPayload | null;
  pull_request?: ApiPullRequest | null;
  requested_reviewer?: ApiUser | null;
  repository?: ApiRepository | null;
  sender?: ApiUser | null;
  review?: { type?: string; content?: string } | null;
}

/** Upstream `api.RepositoryPayload` (hook.go:615-631). */
export interface RepositoryPayload {
  action?: string;
  repository?: ApiRepository | null;
  organization?: ApiUser | null;
  sender?: ApiUser | null;
  changes?: ChangesPayload | null;
}

/** Upstream `api.ReleasePayload` (hook.go:337-348). */
export interface ReleasePayload {
  action?: string;
  release?: ApiRelease | null;
  repository?: ApiRepository | null;
  sender?: ApiUser | null;
}

/** Upstream `api.WikiPayload` (hook.go:596-608). */
export interface WikiPayload {
  action?: string;
  repository?: ApiRepository | null;
  sender?: ApiUser | null;
  page?: string;
  comment?: string;
}

/** Upstream `api.PackagePayload` (hook.go:638-651). */
export interface PackagePayload {
  action?: string;
  repository?: ApiRepository | null;
  package?: ApiPackage | null;
  organization?: ApiOrganization | null;
  sender?: ApiUser | null;
}

/** Upstream `api.CommitStatusPayload` (hook.go:707-737). */
export interface CommitStatusPayload {
  context?: string;
  description?: string;
  repository?: ApiRepository | null;
  sender?: ApiUser | null;
  sha?: string;
  target_url?: string;
}

/** Upstream `api.WorkflowRunPayload` (hook.go:744-759). */
export interface WorkflowRunPayload {
  action?: string;
  workflow_run?: ActionWorkflowRun | null;
  repository?: ApiRepository | null;
  sender?: ApiUser | null;
}

/** Upstream `api.WorkflowJobPayload` (hook.go:764-778). */
export interface WorkflowJobPayload {
  action?: string;
  workflow_job?: ActionWorkflowJob | null;
  repository?: ApiRepository | null;
  sender?: ApiUser | null;
}

/** A provider payload error — upstream's `newPayload`/requester error arm. */
export class ProviderPayloadError extends Error {}

/**
 * The recovered-panic equivalence: upstream dereferencing a nil embedded
 * struct panics and Deliver's recover turns it into a failed delivery
 * (deliver.go:153-160); here it throws the error the consumer records the
 * same way.
 */
export function nonNil<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new ProviderPayloadError(`nil payload field: ${what}`);
  }
  return value;
}

/** Go's zero-value accessor for optional string fields. */
export function str(value: string | null | undefined): string {
  return value ?? "";
}

/** Go's zero-value accessor for optional number fields. */
export function num(value: number | null | undefined): number {
  return value ?? 0;
}

/**
 * Go-style json.Unmarshal error texts (services/webhook/payloader.go:36-42
 * wraps them as "could not unmarshal payload: %w"): the empty-input and the
 * invalid-first-byte messages cover the malformed stored-payload shapes the
 * delivery log can carry; JS JSON.parse's own texts are platform-flavored and
 * never recorded.
 */
export function parseStoredPayload(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new ProviderPayloadError("could not unmarshal payload: unexpected end of JSON input");
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new ProviderPayloadError(
        `could not unmarshal payload: json: cannot unmarshal ${describeJson(parsed)} into Go value of type struct`,
      );
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ProviderPayloadError) throw error;
    // V8 reports the first bad byte differently; upstream's most common
    // invalid-JSON text names the offending character — reconstructed from
    // the input when it starts mid-value.
    const detail = error instanceof SyntaxError ? goJsonErrorDetail(trimmed) : (error as Error).message;
    throw new ProviderPayloadError(`could not unmarshal payload: ${detail}`);
  }
}

function describeJson(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "bool";
  return "object";
}

function goJsonErrorDetail(input: string): string {
  // The two Go texts the delivery log can realistically carry: the empty arm
  // is handled above; anything else that fails V8's parse with a leading
  // non-structural byte renders Go's "invalid character" message.
  const first = input[0] ?? "";
  return `invalid character '${first}' looking for beginning of value`;
}

/**
 * `newPayload` (services/webhook/payloader.go:44-91) — the event→payload-type
 * dispatch every provider convertor rides. The event names are the wire event
 * types (t.EventType); unknown events fail upstream with
 * "newPayload unsupported event: %s" and fail the delivery here the same way.
 */
export type ParsedPayload =
  | { event: "create"; payload: CreatePayload }
  | { event: "delete"; payload: DeletePayload }
  | { event: "fork"; payload: ForkPayload }
  | { event: "issues"; payload: IssuePayload }
  | { event: "issue_comment"; payload: IssueCommentPayload }
  | { event: "push"; payload: PushPayload }
  | { event: "pull_request"; payload: PullRequestPayload }
  | { event: "pull_request_review"; payload: PullRequestPayload; reviewEvent: string }
  | { event: "repository"; payload: RepositoryPayload }
  | { event: "release"; payload: ReleasePayload }
  | { event: "wiki"; payload: WikiPayload }
  | { event: "package"; payload: PackagePayload }
  | { event: "status"; payload: CommitStatusPayload }
  | { event: "workflow_run"; payload: WorkflowRunPayload }
  | { event: "workflow_job"; payload: WorkflowJobPayload };

export function parsePayloadByEvent(event: string, payloadText: string): ParsedPayload {
  const raw = parseStoredPayload(payloadText);
  switch (event) {
    case "create":
      return { event: "create", payload: raw };
    case "delete":
      return { event: "delete", payload: raw };
    case "fork":
      return { event: "fork", payload: raw };
    case "issues":
    case "issue_assign":
    case "issue_label":
    case "issue_milestone":
      return { event: "issues", payload: raw };
    case "issue_comment":
    case "pull_request_comment":
      // The payloader.go comment (:54-65): both comment events carry an
      // IssueCommentPayload (the HookEventPullRequestComment history note).
      return { event: "issue_comment", payload: raw };
    case "push":
      return { event: "push", payload: raw };
    case "pull_request":
    case "pull_request_assign":
    case "pull_request_label":
    case "pull_request_milestone":
    case "pull_request_sync":
    case "pull_request_review_request":
      return { event: "pull_request", payload: raw };
    case "pull_request_review_approved":
    case "pull_request_review_rejected":
    case "pull_request_review_comment":
      // The three review events share the PullRequestPayload + the Review arm
      // (payloader.go:71-74).
      return { event: "pull_request_review", payload: raw, reviewEvent: event };
    case "repository":
      return { event: "repository", payload: raw };
    case "release":
      return { event: "release", payload: raw };
    case "wiki":
      return { event: "wiki", payload: raw };
    case "package":
      return { event: "package", payload: raw };
    case "status":
      return { event: "status", payload: raw };
    case "workflow_run":
      return { event: "workflow_run", payload: raw };
    case "workflow_job":
      return { event: "workflow_job", payload: raw };
    default:
      throw new ProviderPayloadError(`newPayload unsupported event: ${event}`);
  }
}
