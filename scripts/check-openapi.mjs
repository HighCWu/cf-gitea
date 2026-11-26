#!/usr/bin/env node
/**
 * Contract check for the `/api/v1` skeleton against the vendored Gitea swagger
 * (SPEC-0004 §5.1 stage 1 — route-contract check; ADR-0001 D3 contract
 * discipline).
 *
 * What it asserts (hard failures exit non-zero):
 *   (a) every path+method declared by our router exists in the frozen contract
 *       copy `apps/worker/src/compat/contract/v1-swagger.generated.json`
 *       (verbatim copy of the vendored swagger at the pinned submodule commit,
 *       per ADR-0002 — never edited; regenerate on re-pin);
 *   (b) our declared response codes per operation are a subset of the
 *       contract's, except responses listed in RUNTIME_ONLY_RESPONSES below
 *       (upstream sends them at runtime but the vendored swagger omits them —
 *       those are warned, never skipped silently), and except the
 *       DEFAULT-FOLD EQUIVALENCE rule: when the vendored op documents
 *       exactly {one 2xx, default} — the shape upstream 5671c5192d left
 *       after folding every explicit error doc into `default` (doc-only;
 *       the wire still answers the explicit codes) — our op declaring that
 *       2xx plus any explicit 4xx/5xx statuses passes as fold-equivalent
 *       (each warned, never skipped silently). A fold-shape op declaring NO
 *       2xx, or a DIFFERENT success code without a wire-derived documented
 *       exception, still fails; ops whose vendored set is NOT the fold
 *       shape keep the strict subset rule;
 *   (c) prints tier-1 coverage (N/78 paths, M/129 operations) parsed from the
 *       SPEC-0004 appendix A table, so "what is still missing" is a query.
 *       Coverage is informational while tier 1 is under construction; pass
 *       `--strict-tier1` to fail unless coverage is complete (use once tier 1
 *       ships).
 *
 * How the TypeScript router runs from plain node (no new deps): the script
 * bundles `apps/worker/src/api/openapi.ts` with the workspace's existing vite
 * (apps/worker devDependency) into a temporary ESM file and imports it. Vite
 * already handles TypeScript and extensionless imports — the same pipeline
 * vitest uses — and the bundled module exports `getGeneratedSpec()`. Run via
 * the root script: `pnpm check:api`.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKER_DIR = path.join(repoRoot, "apps", "worker");
const SPEC_ENTRY = "src/api/openapi.ts";
const VENDORED_SWAGGER = path.join(repoRoot, "apps", "worker", "src", "compat", "contract", "v1-swagger.generated.json");
const SPEC_DOC = path.join(repoRoot, "specs", "0004-api-v1-core.md");

/** HTTP methods that can carry an operation in an OpenAPI paths object. */
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch"]);

/**
 * Declared responses upstream really sends at runtime but the vendored swagger
 * omits (SPEC-0004 §2.5). Warned as documented exceptions, not failures.
 *
 * SPLITTEXT prune (the GATEFIX open's envelope-class pass): the entries whose
 * declared code is a 4xx/5xx on a single-2xx+`default` FOLD-SHAPE op are gone
 * — the DEFAULT-FOLD EQUIVALENCE rule below passes exactly those codes now
 * (each removal verified by a check-openapi run still exiting 0). KEPT: every
 * wire-derived 2xx substitution (the fold rule hard-fails a different 2xx —
 * /packages/…/-/unlink's 204, /repos/…/transfer's 201), every entry on an op
 * that is NOT the fold shape (multi-success or a no-`default` contract — the
 * strict subset rule still needs them), and every entry whose op's contract
 * carries no `default` at all.
 */
const RUNTIME_ONLY_RESPONSES = {
  "/packages/{owner}/{type}/{name}/-/unlink": {
    post: {
      // Upstream's own handler answers ctx.Status(http.StatusNoContent) on
      // success (gitea/routers/api/v1/packages/package.go:465) while its
      // swagger block documents "201 empty" (package.go:439-440) — the
      // runtime-faithful 204 is what we ship; the frozen contract carries
      // the never-emitted 201.
      204: "upstream UnlinkPackage answers StatusNoContent at runtime; its swagger documents 201 empty (package.go:465 vs :439)",
    },
  },
  "/user": {
    get: {
      // reqToken() 401s anonymous callers (gitea/routers/api/v1/api.go); the
      // contract documents only 200 for userGetCurrent.
      401: "upstream reqToken() rejects anonymous callers; swagger documents only 200",
    },
  },
  "/user/repos": {
    get: {
      401: "upstream reqToken() (token required for userCurrentListRepos); contract documents 200 only",
    },
  },
  "/repos/{owner}/{repo}/pulls/{index}/merge": {
    post: {
      // Re-pinned contract (099abf5db4) is {200,201,default}: upstream's own
      // 5671c5192d fold took the previously-explicit error docs to `default`,
      // AND the new swagger now documents the 201 schedule arm itself (the
      // bare StatusCreated pull.go:1004-1006 answers at runtime — the old
      // 201 entry above retired with that gap closed; history keeps it). The
      // 201 moved OUT of exceptions and INTO the contract, so this block
      // carries only the codes still absent from the frozen copy:
      // - 403/404/405/409/423 — all EXPLICIT in the pre-fold contract
      //   ({200,403,404,405,409,423}); 5671c5192d folded them doc-only
      //   (this op kept TWO success codes alongside `default`, so it is not
      //   the single-2xx fold shape and needs these entries).
      // - 422 — wire-derived, never contract-documented at any pin: the
      //   deps-blocked merge, ErrDependenciesLeft = util.ErrorWrap(
      //   util.ErrUnprocessableContent, "is blocked by an open dependency")
      //   (services/pull/check.go:46), rendered 422 by the API error ladder
      //   (services/context/api.go apiErrorAuto → ErrorUnwrapForUser) — the
      //   b1c5fedd17-window behavior PULL2's port declares
      //   (routes/pulls.ts merge route). The family's no-common-history
      //   refusal answers its 422 at PR CREATE (pull.go:417-420), so an
      //   unrelated-histories row never reaches merge.
      403: "pre-fold contract documented {200,403,404,405,409,423}; 5671c5192d folded the error family to `default` (doc-only — the merge handler's permission/not-found/archived answers are untouched)",
      404: "pre-fold contract documented {200,403,404,405,409,423}; 5671c5192d fold (doc-only)",
      405: "pre-fold contract documented {200,403,404,405,409,423}; 5671c5192d fold (doc-only) — the not-mergeable 405 family (CheckPullMergeable) is upstream's own runtime answer",
      409: "pre-fold contract documented {200,403,404,405,409,423}; 5671c5192d fold (doc-only) — the already-scheduled/lost-CAS conflict (automerge.go:43-45)",
      422: "deps-blocked merge: ErrDependenciesLeft wraps util.ErrUnprocessableContent (check.go:46) and the API ladder renders it 422 (services/context/api.go) — the b1c5fedd17-window wire PULL2's port declares; absent from the contract at every pin",
      423: "pre-fold contract documented {200,403,404,405,409,423}; 5671c5192d fold (doc-only) — the archived-repo refusal",
    },
  },
  "/repos/{owner}/{repo}/transfer": {
    post: {
      // The PENDING arm: upstream's own handler answers 201 Created when the
      // repository status is RepositoryPendingTransfer
      // (gitea/routers/api/v1/repo/transfer.go:126-130) while its swagger
      // block documents only the 202 (transfer.go:48-58) — the 202 is the
      // DIRECT-transfer answer (:132-133, transferOwnership run inline for
      // doer-is-admin / self / org-can-create-repo,
      // services/repository/transfer.go:458-477). cf-gitea always files
      // pending, so 201 is the success code we ship; the frozen contract
      // carries only the never-emitted-here 202.
      201: "upstream repoTransfer answers StatusCreated on the pending arm (transfer.go:126-130); its swagger documents only the direct-transfer 202 (transfer.go:48-58 vs :132-133)",
      // The duplicate-request conflict (upstream maps
      // IsErrRepoTransferInProgress to StatusConflict on a pending-duplicate
      // re-request, transfer.go:113-115) rides the default-fold equivalence
      // now (contract {202, default} — the SPLITTEXT prune).
    },
  },
  "/user/followers": {
    get: { 401: "upstream reqToken(); contract documents 200 only" },
  },
  // The /user/following/{username} put/delete 401s, /users/{username}/keys
  // and /users/{username}/gpg_keys get 401s, and the repo milestones patch
  // 400 — all on single-2xx+`default` fold-shape ops — ride the default-fold
  // equivalence now (the SPLITTEXT prune; their route notes keep the
  // derivations).
  "/signing-key.gpg": {
    get: {
      404: "cf-gitea has no signing-key configuration, so the format is blank and upstream's own handler answers APIErrorNotFound(\"no signing key\") at runtime (gitea/routers/api/v1/misc/signing.go:14-24); the contract documents only the 200 text/plain",
    },
  },
  "/signing-key.pub": {
    get: {
      404: "same helper as /signing-key.gpg — SigningKeySSH feeds the SSH expected format into getSigningKey (gitea/routers/api/v1/misc/signing.go:100), so with no signing-key configuration the blank-format arm answers APIErrorNotFound(\"no signing key\") verbatim (signing.go:19-21); the contract documents only the 200 text/plain",
    },
  },
  "/repos/{owner}/{repo}/signing-key.gpg": {
    get: {
      404: "repo arm of the same getSigningKey helper (misc/signing.go:14-24 via api.go:1530) — cf-gitea has no signing-key configuration, so the blank-format arm answers APIErrorNotFound(\"no signing key\") like the landed global pair; the contract documents only the 200 text/plain",
    },
  },
  "/repos/{owner}/{repo}/signing-key.pub": {
    get: {
      404: "repo arm of SigningKeySSH (misc/signing.go:100 via api.go:1531) — same blank-format answer as /repos/{owner}/{repo}/signing-key.gpg; the contract documents only the 200 text/plain",
    },
  },
  // The /repos/{owner}/{repo}/hooks/git family (list/get/patch/delete — the
  // reqToken 401s, reqAdmin 403s, the bind 422) and /admin/users/{username}/
  // keys post (401/404) all sit on single-2xx+`default` fold-shape ops — the
  // default-fold equivalence covers their declared extras (the SPLITTEXT
  // prune; routes/git-hooks.ts + routes/misc-t3.ts keep the derivations).
  // /admin/cron/{task} post 403 (contract {204, default}) rides the same
  // fold pass.
  // The /admin/unadopted/{owner}/{repo} delete-404 entry was removed with the
  // surface: upstream 1554b6c939 deleted the adopt feature (adopt.go gone, no
  // route at api.go), so cf-gitea no longer serves the op (routes/
  // admin-degenerate.ts module header) and there is nothing to except.
  "/user/avatar": {
    post: {
      400: "base64 decode failure answers upstream's exact ctx.APIError(400, err) text (user/avatar.go:33-37); at/over the 262144-byte origin cap cf-gitea 400s (no image pipeline — documented divergence, services/avatars.ts)",
      401: "reqToken() 401s anonymous callers; the contract documents only 204",
      413: "the MAX_AVATAR_WIRE_BYTES guard middleware rejects an over-cap declared Content-Length before any body byte (routes/avatars.ts)",
      422: "zod body bind failures",
      500: "unknown/corrupt/oversized-dimension image is upstream's APIErrorInternal (image.DecodeConfig arms) — the landed constant-fallback convention (routes/avatars.ts header)",
    },
  },
  // The org/repo avatar post blocks ({400,401,403,404,413,422,500} against
  // the contract's {204, default} fold shape) ride the default-fold
  // equivalence now (the SPLITTEXT prune; the /user/avatar block above stays
  // because that op's contract documents {204} with NO `default` — the
  // strict subset rule needs its entries). So do POST /repos/{owner}/{repo}/
  // issues/{index}/comments' 422 (the Go bind arm on
  // CreateIssueCommentOption.Body's binding:"Required",
  // structs/issue_comment.go:37 → api.go:838-845; contract {201, default}).
  "/repos/{owner}/{repo}/issues/comments/{id}": {
    get: {
      // 099abf5db4 fold victims (5671c5192d, doc-only): pre-fold contract
      // documented {200,204,403,404}; this op kept TWO success codes
      // (200,204) alongside `default`, so it is not the single-2xx fold
      // shape and the strict rule needs these entries. Wire: the
      // comment-miss arm (GetIssueComment → APIErrorNotFound) and the
      // issue-unit permission gate 403 still answer at runtime.
      403: "pre-fold contract documented {200,204,403,404}; 5671c5192d folded the error family to `default` (doc-only — issue_comment.go's handlers unchanged)",
      404: "pre-fold contract documented {200,204,403,404}; 5671c5192d fold (doc-only) — the miss arm still answers APIErrorNotFound at runtime",
    },
    patch: {
      // Pre-fold contract: {200,204,403,404,423}. Wire: permission 403, miss
      // 404, and the locked-issue 423 (the EditIssueComment locked arm).
      403: "pre-fold contract documented {200,204,403,404,423}; 5671c5192d fold (doc-only)",
      404: "pre-fold contract documented {200,204,403,404,423}; 5671c5192d fold (doc-only) — the miss arm still answers APIErrorNotFound at runtime",
      422: "same Go bind arm on EditIssueCommentOption.Body's binding:\"Required\" (structs/issue_comment.go:45) — an empty/absent body 422s in the bind middleware before editIssueComment runs; the contract documents {200,204,403,404,423} only",
      423: "pre-fold contract documented {200,204,403,404,423}; 5671c5192d fold (doc-only) — the locked-issue refusal",
    },
  },
  "/orgs/{org}/repos": {
    delete: {
      // 099abf5db4 fold victim: pre-fold contract documented {202,204,403,
      // 404} — {202,204} kept alongside `default` (multi-success, strict
      // rule). Wire: the org-owner permission gate 403 and the org-miss 404
      // both answer before DeleteRepository runs. (The create arm's 500 —
      // the initRepository rollback, create.go:236-241,448-456 — rides the
      // default-fold equivalence now: contract {201, default}, the SPLITTEXT
      // prune.)
      403: "pre-fold contract documented {202,204,403,404}; 5671c5192d fold (doc-only) — the org-owner permission gate still 403s at runtime",
      404: "pre-fold contract documented {202,204,403,404}; 5671c5192d fold (doc-only) — the org-miss arm still answers APIErrorNotFound at runtime",
    },
  },
  // /admin/users/{username}/repos post 500 (the same initRepository rollback
  // arm — admin/repo.go:48) rides the default-fold equivalence now (contract
  // {201, default}, the SPLITTEXT prune).
  // The terraform packages 422s (DELETE /packages/{owner}/{type}/{name} and
  // …/{version} — spec.go:50-62/:64-80's locked/latest-version refusals,
  // util.ErrUnprocessableContent → the errorForUser 422, declared by
  // routes/packages.ts terraformDeleteRefusal) ride the default-fold
  // equivalence now: the 09c2b92 re-baselined contract is {204, default}
  // for both ops (the pre-fold {204,404} note's "removing it hard-fails"
  // verification predates the fold rule and no longer holds — verified:
  // removal + check-openapi exit 0, the SPLITTEXT prune).

  // ─── 5671c5192d fold victims on MULTI-SUCCESS ops (the 099abf5db4 re-pin) ───
  // Upstream 5671c5192d ("refactor: use default error response for swagger",
  // #40048) folded every op's explicit error docs into `default`. The commit
  // is DOC-ONLY at the route layer: its routers/api/v1 diff removes 1,001
  // explicit `#/responses/*Error*` comment refs and replaces them with
  // `default: #/responses/error` — every changed line is a swagger comment
  // (the wire handlers are untouched: e.g. admin/cron.go PostCronTask still
  // answers ctx.APIErrorNotFound() directly under its folded doc; the admin
  // group's reqSiteAdmin still 403s pre-handler). The vendored copy at this
  // pin has 477 ops in the {one 2xx, default} shape — those pass via the
  // DEFAULT-FOLD EQUIVALENCE rule in main() without entries. These ops kept
  // TWO OR MORE success codes alongside `default` (or a 3xx success arm), so
  // they are NOT the fold shape and keep the strict subset rule — each
  // still-folded error code needs its wire derivation HERE. The derivation
  // is upstream's own pre-fold contract: the pinned-out vendored copy
  // documented every code below EXPLICITLY (verified by diffing the two
  // frozen copies: 1,001 error codes moved to `default`, ZERO success codes
  // removed, ZERO codes gained except `default` itself — plus merge's 201,
  // handled above). Upstream's own swagger is the same authority the
  // contract freeze rests on, so pre-fold documentation + the doc-only fold
  // commit carries the R28 wire bar for each entry below. (/repos/{owner}/
  // {repo}/issues/comments/{id} and /orgs/{org}/repos live at their ORIGINAL
  // table positions above, merged with the pre-existing entries there — one
  // literal per key; a second literal would silently clobber.)
  "/repos/{owner}/{repo}/issues/{index}/comments/{id}": {
    patch: {
      // Pre-fold contract: {200,204,403,404} — same EditIssueComment handler
      // family as the /issues/comments/{id} arm above.
      403: "pre-fold contract documented {200,204,403,404}; 5671c5192d fold (doc-only)",
      404: "pre-fold contract documented {200,204,403,404}; 5671c5192d fold (doc-only) — the miss arm still answers APIErrorNotFound at runtime",
    },
  },
  "/orgs/{org}/members/{username}": {
    get: {
      // Pre-fold contract: {204,303,404}. Wire: the member-miss arm still
      // answers APIErrorNotFound (org membership probe) at runtime.
      404: "pre-fold contract documented {204,303,404}; 5671c5192d fold (doc-only) — the member-miss arm still answers APIErrorNotFound at runtime",
    },
  },
  "/repos/{owner}/{repo}/contents/{filepath}": {
    put: {
      // Pre-fold contract: {200,201,403,404,422,423}. Wire: the writer gate
      // 403, path/branch miss 404, the validation 422 family, and the
      // archived-repo 423 all live in UpdateFilesHandlers/DriveCommitFile —
      // untouched by the doc-only fold.
      403: "pre-fold contract documented {200,201,403,404,422,423}; 5671c5192d fold (doc-only) — the writer gate still 403s at runtime",
      404: "pre-fold contract documented {200,201,403,404,422,423}; 5671c5192d fold (doc-only) — the branch/path miss arms still answer at runtime",
      422: "pre-fold contract documented {200,201,403,404,422,423}; 5671c5192d fold (doc-only) — the payload-validation family",
      423: "pre-fold contract documented {200,201,403,404,422,423}; 5671c5192d fold (doc-only) — the archived-repo refusal",
    },
  },
  "/repos/{owner}/{repo}/actions/secrets/{secretname}": {
    put: {
      // Pre-fold contract: {201,204,400,404}. Wire: the secret-name
      // validation 400 and the resolution-miss 404 arms (repo/action.go
      // UpdateSecret) are upstream's own pre-fold documentation.
      400: "pre-fold contract documented {201,204,400,404}; 5671c5192d fold (doc-only) — the secret-name validation arm",
      404: "pre-fold contract documented {201,204,400,404}; 5671c5192d fold (doc-only) — the repo-resolution miss arm",
    },
  },
  "/repos/{owner}/{repo}/actions/variables/{variablename}": {
    put: {
      // Pre-fold contract: {201,204,400,404}. Wire: the variable-name
      // validation 400 and the repo-miss 404 (repo/action.go
      // CreateOrUpdateVariable).
      400: "pre-fold contract documented {201,204,400,404}; 5671c5192d fold (doc-only) — the variable-name validation arm",
      404: "pre-fold contract documented {201,204,400,404}; 5671c5192d fold (doc-only) — the repo-miss arm",
    },
    delete: {
      // Pre-fold contract: {204,400,404}. Wire: same handler family.
      400: "pre-fold contract documented {204,400,404}; 5671c5192d fold (doc-only) — the variable-name validation arm",
      404: "pre-fold contract documented {204,400,404}; 5671c5192d fold (doc-only) — the repo/variable-miss arm",
    },
  },
  "/orgs/{org}/actions/secrets/{secretname}": {
    put: {
      // Pre-fold contract: {201,204,400,404} — the org twin of the repo arm.
      400: "pre-fold contract documented {201,204,400,404}; 5671c5192d fold (doc-only) — the secret-name validation arm",
      404: "pre-fold contract documented {201,204,400,404}; 5671c5192d fold (doc-only) — the org-miss arm",
    },
  },
  "/orgs/{org}/actions/variables/{variablename}": {
    put: {
      // Pre-fold contract: {201,204,400,404} — the org twin of the repo arm.
      400: "pre-fold contract documented {201,204,400,404}; 5671c5192d fold (doc-only) — the variable-name validation arm",
      404: "pre-fold contract documented {201,204,400,404}; 5671c5192d fold (doc-only) — the org-miss arm",
    },
    delete: {
      // Pre-fold contract: {204,400,404} — the org twin of the repo arm.
      400: "pre-fold contract documented {204,400,404}; 5671c5192d fold (doc-only) — the variable-name validation arm",
      404: "pre-fold contract documented {204,400,404}; 5671c5192d fold (doc-only) — the org/variable-miss arm",
    },
  },
  "/user/actions/secrets/{secretname}": {
    put: {
      // Pre-fold contract: {201,204,400,404} — the user twin of the repo arm.
      400: "pre-fold contract documented {201,204,400,404}; 5671c5192d fold (doc-only) — the secret-name validation arm",
      404: "pre-fold contract documented {201,204,400,404}; 5671c5192d fold (doc-only) — the user-miss arm",
    },
  },
  "/user/actions/variables/{variablename}": {
    put: {
      // Pre-fold contract: {201,204,400,404} — the user twin of the repo arm.
      400: "pre-fold contract documented {201,204,400,404}; 5671c5192d fold (doc-only) — the variable-name validation arm",
      404: "pre-fold contract documented {201,204,400,404}; 5671c5192d fold (doc-only) — the user-miss arm",
    },
    delete: {
      // Pre-fold contract: {204,400,404} — the user twin of the repo arm.
      400: "pre-fold contract documented {204,400,404}; 5671c5192d fold (doc-only) — the variable-name validation arm",
      404: "pre-fold contract documented {204,400,404}; 5671c5192d fold (doc-only) — the user/variable-miss arm",
    },
  },
  "/repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches": {
    post: {
      // Pre-fold contract: {200,204,400,403,404,422}. Our op declares the
      // fold victims 403/404/422 (we do not declare the 400 — the route's
      // bind rejects malformed input 400-wise per the hono validator, a
      // checker-invisible arm). Wire: the workflow-miss 404, the
      // actions-unit permission 403, and the dispatch-input validation 422
      // all answer before the dispatch enqueues.
      403: "pre-fold contract documented {200,204,400,403,404,422}; 5671c5192d fold (doc-only) — the actions-unit permission gate still 403s at runtime",
      404: "pre-fold contract documented {200,204,400,403,404,422}; 5671c5192d fold (doc-only) — the workflow-miss arm still answers APIErrorNotFound at runtime",
      422: "pre-fold contract documented {200,204,400,403,404,422}; 5671c5192d fold (doc-only) — the dispatch-input validation arm",
    },
  },
  "/repos/{owner}/{repo}/issues/{index}/reactions": {
    post: {
      // Pre-fold contract: {200,201,403,404}. Wire: issue_reaction.go
      // PostIssueReactions still answers the miss 404 (GetIssueByIndex →
      // APIErrorNotFound) and the permission 403 under its folded doc — the
      // commit diff shows exactly these two comment refs replaced.
      403: "pre-fold contract documented {200,201,403,404}; 5671c5192d folded 403/404 to `default` (doc-only — issue_reaction.go PostIssueReactions' permission gate unchanged)",
      404: "pre-fold contract documented {200,201,403,404}; 5671c5192d fold (doc-only) — the issue-miss arm still answers APIErrorNotFound at runtime",
    },
  },
  "/repos/{owner}/{repo}/issues/comments/{id}/reactions": {
    post: {
      // Pre-fold contract: {200,201,403,404}. Wire: PostIssueCommentReaction
      // — the commit diff itself shows the handler unchanged: GetCommentByID
      // err → notFound, then the permission gate.
      403: "pre-fold contract documented {200,201,403,404}; 5671c5192d folded 403/404 to `default` (doc-only — issue_reaction.go PostIssueCommentReaction's permission gate unchanged)",
      404: "pre-fold contract documented {200,201,403,404}; 5671c5192d fold (doc-only) — GetCommentByID's miss arm still answers APIErrorNotFound at runtime",
    },
  },
  "/repos/{owner}/{repo}/issues/{index}/subscriptions/{user}": {
    put: {
      // Pre-fold contract: {200,201,304,404}. Wire: issue_subscription.go —
      // the user/issue-miss arms still answer APIErrorNotFound; the 403
      // permission text sits at :125.
      404: "pre-fold contract documented {200,201,304,404}; 5671c5192d fold (doc-only) — the subscription-miss arms still answer APIErrorNotFound at runtime",
    },
    delete: {
      // Pre-fold contract: {200,201,304,404} — same handler family.
      404: "pre-fold contract documented {200,201,304,404}; 5671c5192d fold (doc-only) — the subscription-miss arms still answer APIErrorNotFound at runtime",
    },
  },
  "/repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip": {
    get: {
      // Pre-fold contract: {302,400,404}. The success arm is a 302 REDIRECT,
      // not a 2xx, so this op is NOT the fold shape (the rule is 2xx-scoped)
      // and keeps the strict rule. Wire: repo/action.go downloadArtifact
      // (:1901-) still answers the bad-path-param 400 and the miss/expired
      // 404 ("Artifact has expired") under its folded doc at this very pin.
      400: "pre-fold contract documented {302,400,404}; 5671c5192d fold (doc-only) — downloadArtifact's bad-path-param arm still 400s at runtime (repo/action.go:1901-)",
      404: "pre-fold contract documented {302,400,404}; 5671c5192d fold (doc-only) — the artifact-miss/expired arm still answers APIErrorNotFound at runtime (repo/action.go:1901-, \"Artifact has expired\")",
    },
  },
};

/**
 * Tier-1 totals documented in SPEC-0004 §2.3. The appendix table is re-counted
 * on every run; a mismatch is a warning that the SPEC drifted, not a contract
 * violation.
 */
const TIER1_EXPECTED_PATHS = 78;
const TIER1_EXPECTED_OPERATIONS = 129;

/** The mount prefix routes are served under (stripped before comparison). */
const MOUNT_PREFIX = "/api/v1";

function normalizePath(declaredPath) {
  const withoutPrefix =
    declaredPath === MOUNT_PREFIX ? "/"
      : declaredPath.startsWith(`${MOUNT_PREFIX}/`) ? declaredPath.slice(MOUNT_PREFIX.length)
      : declaredPath;
  return withoutPrefix === "" ? "/" : withoutPrefix;
}

/**
 * Bundle the spec entry with the workspace's vite and import it. Returns
 * `getGeneratedSpec()`'s OpenAPI document. (Mechanism documented in the file
 * header.)
 */
async function loadGeneratedSpec() {
  const workerRequire = createRequire(pathToFileURL(path.join(WORKER_DIR, "package.json")));
  const { build } = await import(workerRequire.resolve("vite"));

  const outDir = await mkdtemp(path.join(tmpdir(), "cf-gitea-openapi-"));
  // The bundled api graph reaches the vendored engine's SOURCES (the package
  // entry is src/mod.ts, and the api layer imports its commit serializers at
  // value level), and engine sources `import { DurableObject } from
  // "cloudflare:workers"` — a workerd-virtual module plain-node vite can
  // neither resolve nor execute. Merely marking it external would leave a
  // static import this script's `await import()` cannot serve. getGeneratedSpec()
  // only walks the route registry (no handler runs, no Durable Object is ever
  // constructed), so the module stands in as the bare base class the engine
  // DO classes extend. The stub lives in its own temp dir, removed below.
  const stubDir = await mkdtemp(path.join(tmpdir(), "cf-gitea-openapi-stub-"));
  const workersStub = path.join(stubDir, "cloudflare-workers.mjs");
  await writeFile(workersStub, "export class DurableObject {}\n");
  // B66R's SMTP transport imports cloudflare:sockets at value level — the
  // same workerd-virtual-module class; the stub's connect() is never called
  // (getGeneratedSpec walks the registry only), so the bare shape stands in.
  const socketsStub = path.join(stubDir, "cloudflare-sockets.mjs");
  // B-86's static-wasm carrier module (password-wasm.ts) imports .wasm
  // modules for their default CompiledWasm binding — rollup in this Node
  // build has no wasm plugin. Stub the CARRIER MODULE itself (the contract
  // build never verifies a password); the exports mirror its public face.
  const wasmStub = path.join(stubDir, "password-wasm.mjs");
  await writeFile(
    wasmStub,
    "export function ensurePasswordWasm() {}\n" +
      "export function argon2idBytes() { throw new Error(\"password-wasm stubbed for the contract build\"); }\n" +
      "export function bcryptVerifyCrypt() { throw new Error(\"password-wasm stubbed for the contract build\"); }\n",
  );
  await writeFile(socketsStub, 'export const connect = () => { throw new Error("unreachable in the spec build"); };\n');
  try {
    await build({
      root: WORKER_DIR,
      configFile: false,
      logLevel: "warn",
      build: { ssr: SPEC_ENTRY, outDir, emptyOutDir: true, minify: false },
      resolve: {
        alias: [
          { find: /^cloudflare:workers$/, replacement: workersStub },
          { find: /^cloudflare:sockets$/, replacement: socketsStub },
          // B-86's static-wasm carrier (password-wasm.ts) imports .wasm
          // modules — this Node-side build has no wasm plugin. The find
          // matches the WHOLE specifier (a tail-only regex makes vite-alias
          // rewrite just the matched tail, path-joining the stub onto the
          // importer's directory); the stub is the carrier's inert twin.
          { find: /^.*password-wasm(\.ts)?$/, replacement: wasmStub },
        ],
      },
      ssr: { noExternal: true },
    });
    const module = await import(pathToFileURL(path.join(outDir, "openapi.js")).href);
    return module.getGeneratedSpec();
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(stubDir, { recursive: true, force: true });
  }
}

function declaredOperations(doc) {
  const operations = [];
  for (const [declaredPath, pathItem] of Object.entries(doc.paths ?? {})) {
    for (const method of Object.keys(pathItem)) {
      if (!HTTP_METHODS.has(method)) {
        continue;
      }
      const responses = Object.keys(pathItem[method]?.responses ?? {});
      operations.push({
        path: normalizePath(declaredPath),
        method,
        responses: new Set(responses),
        operation: pathItem[method]?.operationId ?? "(no operationId)",
      });
    }
  }
  return operations;
}

function contractResponsesFor(gitea, opPath, method) {
  const pathItem = gitea.paths?.[opPath];
  const operation = pathItem?.[method];
  return operation === undefined ? null : new Set(Object.keys(operation.responses ?? {}));
}

/** True for explicit 2xx status codes ("200".."204"…, not ranges, not "default"). */
function is2xxCode(code) {
  return /^2\d\d$/u.test(code);
}

/** True for explicit 4xx/5xx status codes — upstream's folded error family. */
function is4xxOr5xxCode(code) {
  return /^[45]\d\d$/u.test(code);
}

/**
 * The DEFAULT-FOLD EQUIVALENCE shape: upstream 5671c5192d ("refactor: use
 * default error response for swagger", #40048) folded every op's explicit
 * error docs into `default`. The commit is doc-only at the route layer (its
 * routers/api/v1 diff replaces 1,001 explicit `#/responses/*Error*` comment
 * refs with `default: #/responses/error`; handlers untouched — e.g.
 * admin/cron.go PostCronTask still answers ctx.APIErrorNotFound() directly
 * under its folded doc), so the wire still answers the explicit codes and an
 * op declaring the 2xx plus explicit 4xx/5xx statuses is fold-equivalent.
 * Returns the contract's single 2xx code when `contractCodes` is exactly
 * {one 2xx, default} (477 ops of the vendored copy), else null — ops that
 * kept multiple success codes (or a 3xx arm) alongside `default` are NOT the
 * fold shape and stay on the strict subset rule (their still-folded codes
 * carry RUNTIME_ONLY_RESPONSES entries above).
 */
function defaultFoldSuccessCode(contractCodes) {
  if (contractCodes.size !== 2 || !contractCodes.has("default")) {
    return null;
  }
  const [other] = [...contractCodes].filter((code) => code !== "default");
  return is2xxCode(other) ? other : null;
}

/** Parse the tier-1 rows (| T1 |) of SPEC-0004 appendix A → Map path → methods[]. */
async function parseTier1Table() {
  const markdown = await readFile(SPEC_DOC, "utf8");
  const tier1 = new Map();
  for (const line of markdown.split("\n")) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*([A-Z, ]+?)\s*\|\s*[a-z]\s*\|\s*T1\s*\|$/u.exec(line);
    if (match === null) {
      continue;
    }
    const [, contractPath, methods] = match;
    tier1.set(contractPath, methods.split(",").map((method) => method.trim().toLowerCase()));
  }
  return tier1;
}

async function main() {
  const strictTier1 = process.argv.includes("--strict-tier1");
  const hardFailures = [];
  const warnings = [];

  const [doc, gitea, tier1] = await Promise.all([
    loadGeneratedSpec(),
    readFile(VENDORED_SWAGGER, "utf8").then((raw) => JSON.parse(raw)),
    parseTier1Table(),
  ]);
  const operations = declaredOperations(doc);

  console.log("cf-gitea /api/v1 contract check (frozen copy: apps/worker/src/compat/contract/v1-swagger.generated.json)");
  console.log(`  declared: ${operations.length} operation(s) across ${doc.paths ? Object.keys(doc.paths).length : 0} path(s)`);

  // (a) every declared path+method exists in the vendored contract.
  // (b) declared response codes ⊆ contract's, modulo documented runtime-only
  //     exceptions AND the DEFAULT-FOLD EQUIVALENCE rule (defaultFoldSuccess-
  //     Code above). Exception lookup runs FIRST, so a wire-derived 2xx
  //     substitution (e.g. /packages/…/-/unlink's runtime 204 against the
  //     contract's never-emitted 201) keeps its documented-exception pass
  //     even on a fold-shape op. The contract's error family declares
  //     {message,url} as response headers (swagger-go artifact) while we
  //     declare them as the JSON body — a body-shape conversion note per
  //     SPEC-0004 §2.5, not a status-code difference, so the subset check is
  //     unaffected.
  let foldEquivalentOps = 0;
  for (const op of operations) {
    const contractCodes = contractResponsesFor(gitea, op.path, op.method);
    if (contractCodes === null) {
      hardFailures.push(`(a) ${op.method.toUpperCase()} ${op.path} (${op.operation}) has no entry in the vendored contract`);
      continue;
    }
    const foldSuccess = defaultFoldSuccessCode(contractCodes);
    const extraCodes = [...op.responses].filter((code) => !contractCodes.has(code));
    // The fold shape carries exactly one success code; an op declaring NO 2xx
    // at all misses the success arm — a genuine contract miss (no exception
    // can cover it, since nothing was declared).
    if (foldSuccess !== null && ![...op.responses].some(is2xxCode)) {
      hardFailures.push(`(b) ${op.method.toUpperCase()} ${op.path} (${op.operation}) declares no 2xx response; the contract's fold shape is {${foldSuccess}, default} — the success arm is missing`);
    }
    const foldPassCodes = [];
    for (const code of extraCodes) {
      const exceptions = RUNTIME_ONLY_RESPONSES[op.path]?.[op.method];
      const reason = exceptions?.[code];
      if (reason !== undefined) {
        warnings.push(`(b) ${op.method.toUpperCase()} ${op.path} response ${code} not in contract {${[...contractCodes].join(", ")}} — documented runtime-only exception: ${reason}`);
        continue;
      }
      if (foldSuccess !== null) {
        if (is4xxOr5xxCode(code)) {
          // The doc-only fold: upstream's wire answers this explicit code;
          // fold-equivalence passes it, warned below (never skipped silently).
          foldPassCodes.push(code);
          continue;
        }
        hardFailures.push(`(b) ${op.method.toUpperCase()} ${op.path} declares success-family response ${code}; the contract's fold shape is {${foldSuccess}, default} — a different 2xx needs a wire-derived documented exception`);
        continue;
      }
      hardFailures.push(`(b) ${op.method.toUpperCase()} ${op.path} declares response ${code}; contract has {${[...contractCodes].join(", ")}} and no documented exception covers it`);
    }
    if (foldPassCodes.length > 0) {
      foldEquivalentOps += 1;
      console.log(`  [ok] ${op.method.toUpperCase()} ${op.path} (${op.operation}) responses {${[...op.responses].join(", ")}} — fold-equivalent to contract {${foldSuccess}, default} (explicit errors {${foldPassCodes.join(", ")}} ride the doc-only 5671c5192d fold)`);
    } else {
      console.log(`  [ok] ${op.method.toUpperCase()} ${op.path} (${op.operation}) responses {${[...op.responses].join(", ")}} ⊆ contract {${[...contractCodes].join(", ")}}`);
    }
  }
  if (foldEquivalentOps > 0) {
    console.log(`  ${foldEquivalentOps} operation(s) passed via default-fold equivalence (declared 2xx + explicit errors against a {2xx, default} contract — the doc-only 5671c5192d fold; see DEFAULT-FOLD above)`);
  }

  // (c) tier-1 coverage, parsed from the SPEC appendix so it cannot drift
  //     from the documented tiering.
  if (tier1.size !== TIER1_EXPECTED_PATHS) {
    warnings.push(`(c) SPEC-0004 appendix A parses as ${tier1.size} tier-1 paths, SPEC §2.3 documents ${TIER1_EXPECTED_PATHS} — tiering drifted, re-verify on re-pin`);
  }
  const tier1Operations = [...tier1.values()].reduce((sum, methods) => sum + methods.length, 0);
  if (tier1Operations !== TIER1_EXPECTED_OPERATIONS) {
    warnings.push(`(c) SPEC-0004 appendix A parses as ${tier1Operations} tier-1 operations, SPEC §2.3 documents ${TIER1_EXPECTED_OPERATIONS}`);
  }
  const declared = new Map(operations.map((op) => [`${op.method} ${op.path}`, op.responses]));
  let coveredPaths = 0;
  let coveredOperations = 0;
  const missing = [];
  for (const [contractPath, methods] of tier1) {
    const have = methods.filter((method) => declared.has(`${method} ${contractPath}`));
    coveredOperations += have.length;
    if (have.length === methods.length) {
      coveredPaths += 1;
    } else {
      missing.push(`${contractPath} (have: ${have.length ? have.join(",") : "none"}; need: ${methods.join(",")})`);
    }
  }
  console.log(`  tier-1 coverage: ${coveredPaths}/${tier1.size} paths, ${coveredOperations}/${tier1Operations} operations`);
  if (missing.length > 0 && missing.length <= 10) {
    console.log(`  missing tier-1 paths:\n    ${missing.join("\n    ")}`);
  } else if (missing.length > 0) {
    console.log(`  missing tier-1 paths: ${missing.length} (first few: ${missing.slice(0, 5).join(" | ")})`);
  }
  if (strictTier1 && coveredPaths !== tier1.size) {
    hardFailures.push(`(c) --strict-tier1: tier-1 coverage incomplete (${coveredPaths}/${tier1.size} paths)`);
  }

  for (const warning of warnings) {
    console.warn(`  [warn] ${warning}`);
  }
  if (hardFailures.length > 0) {
    console.error("CONTRACT CHECK FAILED:");
    for (const failure of hardFailures) {
      console.error(`  [fail] ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("PASS");
}

main().catch((error) => {
  console.error("contract check crashed:", error);
  process.exitCode = 1;
});
