/**
 * Issues-service errors — SPEC-0005 §2/§4. Each carries the HTTP status and
 * the exact upstream message the API surface must return (SPEC-0004 §2.5
 * error-body convention); the future route batches map them 1:1.
 */

import type { ContentfulStatusCode } from "hono/utils/http-status";

export class IssueError extends Error {
  /** HTTP status the API surface must respond with. */
  readonly status: ContentfulStatusCode;

  constructor(status: ContentfulStatusCode, message: string) {
    super(message);
    this.name = "IssueError";
    this.status = status;
  }
}

/**
 * CAS loser of a close/reopen race (§4.2). Upstream
 * `ErrIssueAlreadyChanged` (models/issues/issue.go) is a plain
 * invalid-argument error; SPEC-0005 §4.2 pins our mapping to 409.
 */
export class IssueAlreadyChangedError extends IssueError {
  constructor() {
    super(409, "the issue is already changed");
    this.name = "IssueAlreadyChangedError";
  }
}

/** 404 — upstream `ErrIssueNotExist` (models/issues/issue.go). */
export class IssueNotExistError extends IssueError {
  constructor(scope: { id?: number; repoId?: string; index?: number }) {
    super(
      404,
      `issue does not exist [id: ${scope.id ?? 0}, repo_id: ${scope.repoId ?? 0}, index: ${scope.index ?? 0}]`,
    );
    this.name = "IssueNotExistError";
  }
}

/**
 * 409 — duplicate `(repo_id, tag_name)` release (§4.11). Message mirrors
 * upstream `ErrReleaseAlreadyExist.Error()` (models/repo/release.go:38–40).
 */
export class ReleaseAlreadyExistError extends IssueError {
  constructor(tagName: string) {
    super(409, `release tag already exist [tag_name: ${tagName}]`);
    this.name = "ReleaseAlreadyExistError";
  }
}

/** 404 — upstream `ErrReleaseNotExist` (models/repo/release.go). */
export class ReleaseNotExistError extends IssueError {
  constructor(scope: { id?: number; tagName?: string } = {}) {
    super(404, `release tag does not exist [id: ${scope.id ?? 0}, tag_name: ${scope.tagName ?? ""}]`);
    this.name = "ReleaseNotExistError";
  }
}

/**
 * 404 — label not on this repo (nor the owner org, §3.2 labels paragraph).
 * Message mirrors upstream `ErrNoSuchLabel` repo variant
 * (models/issues/label.go:34).
 */
export class NoSuchLabelError extends IssueError {
  constructor(labelId: number, repoId: string) {
    super(404, `label does not exist [label_id: ${labelId}, repo_id: ${repoId}]`);
    this.name = "NoSuchLabelError";
  }
}

/** 404 — upstream `ErrMilestoneNotExist` (models/issues/milestone.go:35–40). */
export class MilestoneNotExistError extends IssueError {
  constructor(scope: { id?: number; repoId?: string; name?: string } = {}) {
    super(
      404,
      scope.name !== undefined
        ? `milestone does not exist [name: ${scope.name}, repo_id: ${scope.repoId ?? 0}]`
        : `milestone does not exist [id: ${scope.id ?? 0}, repo_id: ${scope.repoId ?? 0}]`,
    );
    this.name = "MilestoneNotExistError";
  }
}

/**
 * 500 — `repo_counters` bootstrap hit a foreign-key violation, i.e. the
 * repository row does not exist (§3.1: counters ride along with the repo).
 */
export class RepositoryNotExistError extends IssueError {
  constructor(repoId: string) {
    super(500, `repository does not exist [repo_id: ${repoId}]`);
    this.name = "RepositoryNotExistError";
  }
}
