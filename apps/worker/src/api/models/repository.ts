import { z } from "@hono/zod-openapi";

import { userSchema } from "./user";
import { teamSchema } from "./team";

/**
 * Mirrors of the vendored contract's sub-definitions referenced by
 * `Repository` (gitea/templates/swagger/v1-swagger.generated.json
 * #/definitions/{Permission,InternalTracker,ExternalTracker,ExternalWiki,
 * RepoTransfer}), field-for-field. The contract declares no `required`
 * fields; the schemas mirror that literally.
 */
export const permissionSchema = z.object({
  admin: z
    .boolean()
    .optional()
    .openapi({ description: "Admin indicates if the user is an administrator of the repository." }),
  pull: z
    .boolean()
    .optional()
    .openapi({ description: "Pull indicates if the user can pull code from the repository." }),
  push: z
    .boolean()
    .optional()
    .openapi({ description: "Push indicates if the user can push code to the repository." }),
});

export type Permission = z.infer<typeof permissionSchema>;

export const internalTrackerSchema = z.object({
  allow_only_contributors_to_track_time: z
    .boolean()
    .optional()
    .openapi({ description: "Let only contributors track time (Built-in issue tracker)" }),
  // The 640cd615c4 creation gate (RE-PIN window): "reader" (default, any user
  // with read access), "member" (must be a collaborator with read access) or
  // "writer" (must be a collaborator with write access). Upstream applies it
  // through the PATCH internal_tracker object (repo.go:768 — merged over the
  // loaded IssuesConfig, default CreationRestrictionReader); our tree has no
  // issues-unit config store yet (census B-33), so the accepted-and-ignored
  // posture covers this field too.
  creation_restriction: z
    .string()
    .optional()
    .openapi({
      description:
        'who is allowed to create issues: "reader" (default, any user with read access), "member" (must be a collaborator with read access) or "writer" (must be a collaborator with write access).',
    }),
  enable_issue_dependencies: z
    .boolean()
    .optional()
    .openapi({ description: "Enable dependencies for issues and pull requests (Built-in issue tracker)" }),
  enable_time_tracker: z
    .boolean()
    .optional()
    .openapi({ description: "Enable time tracking (Built-in issue tracker)" }),
});

export type InternalTracker = z.infer<typeof internalTrackerSchema>;

export const externalTrackerSchema = z.object({
  external_tracker_format: z
    .string()
    .optional()
    .openapi({
      description:
        "External Issue Tracker URL Format. Use the placeholders {user}, {repo} and {index} for the username, repository name and issue index.",
    }),
  external_tracker_regexp_pattern: z
    .string()
    .optional()
    .openapi({ description: "External Issue Tracker issue regular expression" }),
  external_tracker_style: z
    .string()
    .optional()
    .openapi({
      description: "External Issue Tracker Number Format, either `numeric`, `alphanumeric`, or `regexp`",
    }),
  external_tracker_url: z
    .string()
    .optional()
    .openapi({ description: "URL of external issue tracker." }),
});

export type ExternalTracker = z.infer<typeof externalTrackerSchema>;

export const externalWikiSchema = z.object({
  external_wiki_url: z.string().optional().openapi({ description: "URL of external wiki." }),
});

export type ExternalWiki = z.infer<typeof externalWikiSchema>;

export const repoTransferSchema = z.object({
  doer: userSchema.optional(),
  recipient: userSchema.optional(),
  teams: z.array(teamSchema).optional(),
});

export type RepoTransfer = z.infer<typeof repoTransferSchema>;

/**
 * Mirror of the vendored contract's `Repository` definition
 * (gitea/templates/swagger/v1-swagger.generated.json
 * #/definitions/Repository) — all 73 properties, field-for-field including
 * formats, enums, and descriptions. The contract declares no `required`
 * fields; the schema mirrors that literally (the contract check diffs
 * declarations against the vendored file, not runtime). The 71 → 73 growth
 * is the RE-PIN window's 640cd615c4 creation-restriction pair
 * (`issues_creation_restriction` / `pull_requests_creation_restriction`,
 * serialized from the unit configs at convert/repository.go:238/:265 with
 * the "reader" default).
 *
 * `parent` is the one recursive reference (`#/definitions/Repository` →
 * `Repository`): the string-form `openapi("Repository")` registers
 * `_internal.refId`, so zod-to-openapi breaks the cycle with
 * `$ref: #/components/schemas/Repository` (the object form
 * `.openapi({ refId })` stores refId as plain metadata and recurses forever).
 * The lazy target is annotated `z.ZodType<unknown>` to stop the static
 * inference cycle — the wire schema stays an exact mirror.
 */
export const repositorySchema = z
  .object({
  allow_fast_forward_only_merge: z.boolean().optional(),
  allow_manual_merge: z.boolean().optional(),
  allow_merge_commits: z.boolean().optional(),
  allow_merge_update: z.boolean().optional(),
  allow_rebase: z.boolean().optional(),
  allow_rebase_explicit: z.boolean().optional(),
  allow_rebase_update: z.boolean().optional(),
  allow_squash_merge: z.boolean().optional(),
  archived: z.boolean().optional(),
  archived_at: z.string().optional().openapi({ format: "date-time" }),
  autodetect_manual_merge: z.boolean().optional(),
  avatar_url: z.string().optional(),
  branch_count: z.number().int().optional().openapi({ format: "int64" }),
  clone_url: z.string().optional(),
  created_at: z.string().optional().openapi({ format: "date-time" }),
  default_allow_maintainer_edit: z.boolean().optional(),
  default_branch: z.string().optional(),
  default_delete_branch_after_merge: z.boolean().optional(),
  default_merge_style: z.string().optional(),
  default_target_branch: z.string().optional(),
  default_update_style: z.string().optional(),
  description: z.string().optional(),
  empty: z.boolean().optional(),
  external_tracker: externalTrackerSchema.optional(),
  external_wiki: externalWikiSchema.optional(),
  fork: z.boolean().optional(),
  forks_count: z.number().int().optional().openapi({ format: "int64" }),
  full_name: z.string().optional(),
  has_actions: z.boolean().optional(),
  has_code: z.boolean().optional(),
  has_issues: z.boolean().optional(),
  has_packages: z.boolean().optional(),
  has_projects: z.boolean().optional(),
  has_pull_requests: z.boolean().optional(),
  has_releases: z.boolean().optional(),
  has_wiki: z.boolean().optional(),
  html_url: z.string().optional(),
  id: z.number().int().optional().openapi({ format: "int64" }),
  ignore_whitespace_conflicts: z.boolean().optional(),
  internal: z.boolean().optional(),
  internal_tracker: internalTrackerSchema.optional(),
  issues_creation_restriction: z
    .string()
    .optional()
    .openapi({ description: 'who is allowed to create issues: "reader", "member" or "writer"' }),
  language: z.string().optional(),
  languages_url: z.string().optional(),
  licenses: z.array(z.string()).optional(),
  link: z.string().optional(),
  mirror: z.boolean().optional(),
  mirror_interval: z.string().optional(),
  mirror_last_sync_at: z.string().optional().openapi({ format: "date-time" }),
  mirror_updated: z.string().optional().openapi({ format: "date-time" }),
  name: z.string().optional(),
  object_format_name: z
    .enum(["sha1", "sha256"])
    .optional()
    .openapi({ description: "ObjectFormatName of the underlying git repository" }),
  open_issues_count: z.number().int().optional().openapi({ format: "int64" }),
  open_pr_counter: z.number().int().optional().openapi({ format: "int64" }),
  original_url: z.string().optional(),
  owner: userSchema.optional(),
  parent: z.lazy((): z.ZodOptional<z.ZodType<unknown>> => repositorySchema.optional()),
  permissions: permissionSchema.optional(),
  private: z.boolean().optional(),
  projects_mode: z.string().optional(),
  pull_requests_creation_restriction: z
    .string()
    .optional()
    .openapi({ description: 'who is allowed to create pull requests: "reader", "member" or "writer"' }),
  release_counter: z.number().int().optional().openapi({ format: "int64" }),
  repo_transfer: repoTransferSchema.optional(),
  size: z.number().int().optional().openapi({ format: "int64" }),
  squash_merge_commit_message: z.string().optional(),
  ssh_url: z.string().optional(),
  stars_count: z.number().int().optional().openapi({ format: "int64" }),
  template: z.boolean().optional(),
  topics: z.array(z.string()).optional(),
  updated_at: z.string().optional().openapi({ format: "date-time" }),
  url: z.string().optional(),
  watchers_count: z.number().int().optional().openapi({ format: "int64" }),
  website: z.string().optional(),
  })
  // String form: registers `_internal.refId` so zod-to-openapi breaks the
  // `parent` cycle with `$ref: #/components/schemas/Repository` (the object
  // form `.openapi({ refId })` stores refId as plain metadata and recurses
  // forever).
  .openapi("Repository");

export type Repository = z.infer<typeof repositorySchema>;

/** `#/responses/RepositoryList` — plain `Repository[]` (user/org repo lists). */
export const repositoryListSchema = z.array(repositorySchema);

export type RepositoryList = z.infer<typeof repositoryListSchema>;

/**
 * `{data: Repository[], ok: bool}` envelope of `#/definitions/SearchResults`
 * (`GET /repos/search`) — `ok` is always `true` on a 200 upstream.
 */
export const searchResultsSchema = z.object({
  data: z.array(repositorySchema).optional().openapi({ description: "Data contains the repository search results" }),
  ok: z.boolean().optional().openapi({ description: "OK indicates if the search was successful" }),
});

export type SearchResults = z.infer<typeof searchResultsSchema>;

/**
 * Mirror of the vendored contract's `CreateRepoOption`
 * (#/definitions/CreateRepoOption) — field-for-field including the enums.
 * `name` is the one required field. Consumed by `POST /user/repos`,
 * `POST /orgs/{org}/repos` and the admin create; `auto_init` lands the
 * initial commit with the template scaffolding (`readme` 400-validated,
 * `gitignores`/`license` rendered from the inlined options/ catalogs —
 * services/user-repos.ts + services/repo-init-templates.ts), leaving
 * `issue_labels` the one accepted-and-ignored option. `object_format_name`
 * is contract-honest since B-24: the enum's `sha256` member is REFUSED at
 * the create service with upstream's exact text (the engine is sha1-only,
 * SPEC-0001 §5 — the enum mirrors the frozen contract, not an engine
 * capability).
 *
 * RUNTIME error ladder of the three consuming create ops (RE-PIN
 * fc49368845 → 099abf5db4, b3422c0920; the R28 precedent shape — a
 * contract-mirror note, NOT a RUNTIME_ONLY_RESPONSES entry, because every
 * emitted code sits inside each op's frozen-declared set): the frozen
 * contract declares createCurrentUserRepo {201,400,409,422},
 * createOrgRepo {201,400,403,404} (409 runtime-only, documented in the
 * module header) and adminCreateRepo {201,400,403,404,409,422}. At the new
 * pin upstream maps every create error through ctx.APIErrorAuto
 * (repo.go:249-259): a duplicate name answers 409 with
 * ErrRepoAlreadyExist.Error() "repository already exists [owner: %s, repo:
 * %s]" (models/repo/update.go:79-81 — was the pre-repin "The repository
 * with the same name already exists."), and reserved/pattern names answer
 * 400 — ErrNameReserved/ErrNamePatternNotAllowed unwrap
 * util.ErrInvalidArgument (models/db/name.go:31-33/:55-57; was the
 * pre-repin 422, so the runtime 400 rides the ops' declared 400 whose
 * original cite is the readme arm — a declared-set-compatible move, like
 * R28's runtime-only 400 but INSIDE the declared set). Upstream's own
 * new-pin swagger folds these per-op error entries into `default`
 * (5671c5192d #40048) — the frozen copy still carries the old shape until
 * the campaign's re-freeze. The PATCH rename arm keeps its explicit 422s
 * (repo.go:618-627) — a different op, no bearing here.
 */
export const createRepoOptionSchema = z.object({
  auto_init: z.boolean().optional().openapi({ description: "Whether the repository should be auto-initialized?" }),
  default_branch: z
    .string()
    .optional()
    .openapi({ description: "DefaultBranch of the repository (used when initializes and in template)" }),
  description: z.string().optional().openapi({ description: "Description of the repository to create" }),
  gitignores: z.string().optional().openapi({ description: "Gitignores to use" }),
  issue_labels: z.string().optional().openapi({ description: "Label-Set to use" }),
  license: z.string().optional().openapi({ description: "License to use" }),
  name: z.string().openapi({ description: "Name of the repository to create" }),
  object_format_name: z
    .enum(["sha1", "sha256"])
    .optional()
    .openapi({ description: "ObjectFormatName of the underlying git repository, empty string for default (sha1)" }),
  private: z.boolean().optional().openapi({ description: "Whether the repository is private" }),
  readme: z.string().optional().openapi({ description: "Readme of the repository to create" }),
  template: z.boolean().optional().openapi({ description: "Whether the repository is template" }),
  trust_model: z
    .enum(["default", "collaborator", "committer", "collaboratorcommitter"])
    .optional()
    .openapi({ description: "TrustModel of the repository" }),
});

export type CreateRepoOption = z.infer<typeof createRepoOptionSchema>;

/**
 * Mirror of the vendored contract's `EditRepoOption`
 * (#/definitions/EditRepoOption) — all 40 properties, field-for-field.
 * `PATCH /repos/{owner}/{repo}` (repoEdit) applies the MEANINGFUL SUBSET the
 * D1 registry can store today and accepts-and-ignores the rest, exactly like
 * the converter's TODO(SPEC-0005) zero-defaults (routes/repo.ts documents
 * both halves):
 *  - applied: `name` (rename via the landed repos service), `description`,
 *    `website`, `private` (visibility flip), `default_branch` (D1 value +
 *    best-effort engine setHead), `archived` (with the mirror refusal),
 *    `template`, and the has_* unit flags that drive the 412 feature gates
 *    (`has_issues`/`has_wiki`/`has_pull_requests`/`has_releases`
 *    /`has_projects`/`has_packages`/`has_actions` via
 *    services/repo-settings.ts) — plus, since the repoEdit parity wave, the
 *    PR-merge configuration family (`allow_merge_commits`, `allow_rebase`,
 *    `allow_rebase_explicit`, `allow_squash_merge`,
 *    `allow_fast_forward_only_merge`, `allow_manual_merge`,
 *    `autodetect_manual_merge`, `allow_merge_update`,
 *    `allow_rebase_update`, `default_delete_branch_after_merge`,
 *    `default_allow_maintainer_edit`, `default_merge_style`,
 *    `default_update_style`, `squash_merge_commit_message`,
 *    `ignore_whitespace_conflicts` — the repo_units 'pull_requests' row's
 *    PullRequestsConfig, upstream updateRepoUnits repo.go:815-930 at
 *    099abf5db4) and
 *    `projects_mode` (the 'projects' row's ProjectsConfig, repo.go:932-953);
 *  - accepted-and-ignored (no store yet — SPEC-0005 sweep): `has_code`
 *    (needs the creation-seeded code unit row — see services/repo-settings.ts;
 *    census B-32) and the `external_tracker`/`external_wiki`/
 *    `internal_tracker` objects (upstream applies them WITH validation,
 *    repo.go:729-795 at 099abf5db4 — census B-33; the window's 640cd615c4 deepened B-33's
 *    residue — `internal_tracker.creation_restriction` and
 *    `pull_requests_creation_restriction` now carry the issues/PR creation
 *    gate through this very object, repo.go:768/:856, so the B-33 port is
 *    also the creation-gate settings seam);
 *  - applied since the mirror-settings wave (routes/repo.ts
 *    updateMirrorSettings, repo.go:989-1101 at 099abf5db4): the five mirror fields
 *    (`mirror_interval`, `enable_prune`, `mirror_username`/
 *    `mirror_password`/`mirror_token`) — silently skipped for non-mirrors,
 *    which is upstream's own posture (repo.go:995-997).
 */
export const editRepoOptionSchema = z.object({
  allow_fast_forward_only_merge: z
    .boolean()
    .optional()
    .openapi({ description: "either `true` to allow fast-forward-only merging pull requests, or `false` to prevent fast-forward-only merging." }),
  allow_manual_merge: z
    .boolean()
    .optional()
    .openapi({ description: "either `true` to allow mark pr as merged manually, or `false` to prevent it." }),
  allow_merge_commits: z
    .boolean()
    .optional()
    .openapi({ description: "either `true` to allow merging pull requests with a merge commit, or `false` to prevent merging pull requests with merge commits." }),
  allow_merge_update: z
    .boolean()
    .optional()
    .openapi({ description: "either `true` to allow updating pull request branch by merge, or `false` to prevent it." }),
  allow_rebase: z
    .boolean()
    .optional()
    .openapi({ description: "either `true` to allow rebase-merging pull requests, or `false` to prevent rebase-merging." }),
  allow_rebase_explicit: z
    .boolean()
    .optional()
    .openapi({ description: "either `true` to allow rebase with explicit merge commits (--no-ff), or `false` to prevent rebase with explicit merge commits." }),
  allow_rebase_update: z
    .boolean()
    .optional()
    .openapi({ description: "either `true` to enable updating pull request branch by rebase, or `false` to prevent it." }),
  allow_squash_merge: z
    .boolean()
    .optional()
    .openapi({ description: "either `true` to allow squash-merging pull requests, or `false` to prevent squash-merging." }),
  archived: z.boolean().optional().openapi({ description: "set to `true` to archive this repository." }),
  autodetect_manual_merge: z
    .boolean()
    .optional()
    .openapi({ description: "either `true` to enable AutodetectManualMerge, or `false` to prevent it. Note: In some special cases, misjudgments can occur." }),
  default_allow_maintainer_edit: z
    .boolean()
    .optional()
    .openapi({ description: "set to `true` to allow edits from maintainers by default" }),
  default_branch: z.string().optional().openapi({ description: "sets the default branch for this repository." }),
  default_delete_branch_after_merge: z
    .boolean()
    .optional()
    .openapi({ description: "set to `true` to delete pr branch after merge by default" }),
  default_merge_style: z
    .string()
    .optional()
    .openapi({ description: 'set to a merge style to be used by this repository: "merge", "rebase", "rebase-merge", "squash", or "fast-forward-only".' }),
  default_update_style: z
    .string()
    .optional()
    .openapi({ description: 'set to an update style to be used by this repository: "merge" or "rebase".' }),
  description: z.string().optional().openapi({ description: "a short description of the repository." }),
  enable_prune: z
    .boolean()
    .optional()
    .openapi({ description: "enable prune - remove obsolete remote-tracking references when mirroring" }),
  external_tracker: externalTrackerSchema.optional(),
  external_wiki: externalWikiSchema.optional(),
  has_actions: z.boolean().optional().openapi({ description: "either `true` to enable actions unit, or `false` to disable them." }),
  has_code: z.boolean().optional().openapi({ description: "either `true` to enable code for this repository or `false` to disable it." }),
  has_issues: z.boolean().optional().openapi({ description: "either `true` to enable issues for this repository or `false` to disable them." }),
  has_packages: z.boolean().optional().openapi({ description: "either `true` to enable packages unit, or `false` to disable them." }),
  has_projects: z.boolean().optional().openapi({ description: "either `true` to enable project unit, or `false` to disable them." }),
  has_pull_requests: z.boolean().optional().openapi({ description: "either `true` to allow pull requests, or `false` to prevent pull request." }),
  has_releases: z.boolean().optional().openapi({ description: "either `true` to enable releases unit, or `false` to disable them." }),
  has_wiki: z.boolean().optional().openapi({ description: "either `true` to enable the wiki for this repository or `false` to disable it." }),
  ignore_whitespace_conflicts: z
    .boolean()
    .optional()
    .openapi({ description: "either `true` to ignore whitespace for conflicts, or `false` to not ignore whitespace." }),
  internal_tracker: internalTrackerSchema.optional(),
  mirror_interval: z
    .string()
    .optional()
    .openapi({ description: "set to a string like `8h30m0s` to set the mirror interval time" }),
  mirror_password: z.string().optional().openapi({ description: "authentication password for the remote repository (mirrors)" }),
  mirror_token: z.string().optional().openapi({ description: "authentication token for the remote repository (mirrors)" }),
  mirror_username: z.string().optional().openapi({ description: "authentication username for the remote repository (mirrors)" }),
  name: z.string().optional().openapi({ description: "name of the repository" }),
  private: z
    .boolean()
    .optional()
    .openapi({ description: "either `true` to make the repository private or `false` to make it public. Note: you will get a 422 error if the repository attempts to private." }),
  projects_mode: z
    .string()
    .optional()
    .openapi({ description: "`repo` to only allow repo-level projects, `owner` to only allow owner projects, `all` to allow both." }),
  pull_requests_creation_restriction: z
    .string()
    .optional()
    .openapi({
      description:
        'who is allowed to create pull requests: "reader" (default, any user with read access), "member" (must be a collaborator with read access) or "writer" (must be a collaborator with write access).',
    }),
  squash_merge_commit_message: z
    .string()
    .optional()
    .openapi({ description: 'set the default squash merge commit message body: "PR_BODY", "COMMIT_MESSAGES", or "BLANK".' }),
  template: z.boolean().optional().openapi({ description: "either `true` to make this repository a template or `false` to make it a normal repository" }),
  website: z.string().optional().openapi({ description: "a URL with more information about the repository." }),
});

export type EditRepoOption = z.infer<typeof editRepoOptionSchema>;

/**
 * Mirror of the vendored contract's `TransferRepoOption`
 * (#/definitions/TransferRepoOption) — `new_owner` is the one required field.
 * `team_ids` rides the landed team ladder (7f2ecd3, the SPEC-0007 team
 * surface): the route validates per upstream transfer.go:79-101 — a list on
 * a non-org target answers the `Teams can only be added to
 * organization-owned repositories` 422, an unknown id the `team %d not
 * found` 422, and a team from another org the `team %d belongs not to org
 * %d` 403 — and the valid ids attach to the pending transfer at accept.
 */
export const transferRepoOptionSchema = z.object({
  new_owner: z.string().openapi({ description: "The new owner's name" }),
  team_ids: z
    .array(z.number().int().openapi({ format: "int64" }))
    .optional()
    .openapi({
      description:
        "ID of the team or teams to add to the repository. Teams can only be added to organization-owned repositories.",
    }),
});

export type TransferRepoOption = z.infer<typeof transferRepoOptionSchema>;
