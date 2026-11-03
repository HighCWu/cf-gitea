/**
 * The branches page's FLASH RENDER matrix (pages/branches.tsx's
 * BranchesFlash + FlashBanner — the unit the wave-129 rename rewrite's open
 * issue named: "the branches page renders no rename_error flash block
 * yet"). The DERIVATION at the pin (module header's flash section, cited
 * arm-for-arm there): upstream renders every flash on this page through
 * ONE surface — list.tmpl:5 `{{template "base/alert" .}}`, whose arms push
 * each message through RenderFlashMessage (modules/templates/
 * util_render.go:263-294) into `ui {negative|positive} message
 * flash-message flash-{error|success}` with a `tw-text-center` line — the
 * banner, never an inline arm; success flashes DO render (Flash.Success at
 * branch.go:94/:147, CreateBranch's tail, protected_branch.go:433).
 *
 * COVERAGE SPLIT: branches.matrix.test.tsx pins the WRITE arms' redirect
 * level (the 303 locations' query params — GT's landed describes),
 * ui/__tests__/pages-wave17.test.ts pins the delete flashes' TEXT at the
 * route level, and THIS FILE pins the render per kind: the exact
 * RenderFlashMessage DOM per banner type and the exact upstream message
 * keyed per landed redirect kind —
 *
 *   delete  ?deleted= / ?delete_error={default|protected|failed}&name=
 *   restore ?restored= / ?restore_error={already_exists|failed}&name=
 *   create  ?created= / ?create_error={empty|exists|missing|error}&name=
 *   rename  ?renamed= / ?rename_error={empty|missing|exists|default|
 *           protected}&name=   (GT's rewrite commit's kinds)
 *
 * The create/rename params stay OPTIONAL until the orchestrator's fold
 * wires the GET handler's four reads (the restore params' two-stage
 * convention), so — like the matrix's restore block — these pins run at
 * the module level, over the same component the fold's wiring will feed.
 * The two silent arms (`create_error=missing` / `=error`) pin the PARITY
 * answer: upstream's RepoRefByType 404 middleware and ctx.ServerError
 * carry no flash text, so the page must not invent one.
 */

import { describe, expect, it } from "vitest";

import { renderPage } from "../shell";
import { BranchesFlash, branchesLocale } from "./branches";

const flash = (params: {
  deleted?: string | null;
  errorKind?: string | null;
  errorName?: string | null;
  restored?: string | null;
  restoreError?: string | null;
  created?: string | null;
  createError?: string | null;
  renamed?: string | null;
  renameError?: string | null;
}): string =>
  renderPage(
    <BranchesFlash
      deleted={params.deleted ?? null}
      errorKind={params.errorKind ?? null}
      errorName={params.errorName ?? ""}
      restored={params.restored ?? null}
      restoreError={params.restoreError ?? null}
      created={params.created ?? null}
      createError={params.createError ?? null}
      renamed={params.renamed ?? null}
      renameError={params.renameError ?? null}
    />,
  );

/** The exact banner elements (RenderFlashMessage's single-line DOM), with
 *  the raw text escaped the way the renderer does (`"` → `&quot;`). */
const SUCCESS_BANNER = (text: string): string =>
  `<!DOCTYPE html><div class="ui positive message flash-message flash-success"><div class="tw-text-center">${text.replaceAll(`"`, "&quot;")}</div></div>`;
const ERROR_BANNER = (text: string): string =>
  `<!DOCTYPE html><div class="ui negative message flash-message flash-error"><div class="tw-text-center">${text.replaceAll(`"`, "&quot;")}</div></div>`;

describe("BranchesFlash — the delete family (the landed texts, the RenderFlashMessage DOM)", () => {
  it("renders deletion_success as the positive banner", () => {
    expect(flash({ deleted: "stale" })).toBe(SUCCESS_BANNER(branchesLocale.deletion_success("stale")));
    expect(flash({ deleted: "stale" })).toContain("Branch &quot;stale&quot; has been deleted.");
  });

  it("renders the three delete_error kinds as the negative banner (upstream DeleteBranchPost's JSONError texts)", () => {
    expect(flash({ errorKind: "default", errorName: "main" })).toBe(
      ERROR_BANNER(branchesLocale.default_deletion_failed("main")),
    );
    expect(flash({ errorKind: "protected", errorName: "docs-seed" })).toContain(
      "Branch &quot;docs-seed&quot; is protected. It cannot be deleted.",
    );
    expect(flash({ errorKind: "failed", errorName: "stale" })).toContain("Failed to delete branch &quot;stale&quot;.");
  });

  it("renders the restore family's three arms", () => {
    expect(flash({ restored: "side" })).toContain("Branch &quot;side&quot; has been restored.");
    expect(flash({ restoreError: "already_exists", errorName: "side" })).toContain(
      "A branch named &quot;side&quot; already exists.",
    );
    expect(flash({ restoreError: "failed", errorName: "side" })).toContain(`Failed to restore branch &quot;side&quot;.`);
  });
});

describe("BranchesFlash — the create family (?created= / ?create_error=)", () => {
  it("renders create_success as the positive banner (repo.branch.create_success)", () => {
    expect(flash({ created: "feature" })).toBe(SUCCESS_BANNER(branchesLocale.create_success("feature")));
    expect(flash({ created: "feature" })).toContain("Branch &quot;feature&quot; has been created.");
  });

  it("renders the empty kind as the form-binding arm (form.require_error over NewBranchForm's raw field name)", () => {
    // CreateBranch's ctx.HasError → GetErrMsg arm: BuildValidationErrorForUser's
    // ErrRequired message — no form/locale tag on the field, so the display
    // name IS the Go field name (binding.go's fallback).
    expect(flash({ createError: "empty" })).toBe(ERROR_BANNER("NewBranchName cannot be empty."));
  });

  it("renders the exists kind as repo.branch.branch_already_exists (the handler's IsErrBranchAlreadyExists arm)", () => {
    expect(flash({ createError: "exists", errorName: "feature" })).toBe(
      ERROR_BANNER(branchesLocale.branch_already_exists("feature")),
    );
    expect(flash({ createError: "exists", errorName: "feature" })).toContain(
      "Branch &quot;feature&quot; already exists in this repository.",
    );
  });

  it("renders NOTHING for the missing and error kinds — upstream has no flash text for those states", () => {
    // `missing` is upstream's RepoRefByType 404 middleware (an unknown
    // {from} 404s before the handler — the matrix's ghost-redirect note);
    // `error` is ctx.ServerError (branch.go:223). Neither flashes text —
    // an invented banner would be a divergence.
    expect(flash({ createError: "missing", errorName: "feature" })).not.toContain("flash-message");
    expect(flash({ createError: "error", errorName: "feature" })).not.toContain("flash-message");
  });
});

describe("BranchesFlash — the rename family (?renamed= / ?rename_error=, the rewrite commit's kinds)", () => {
  it("renders the default kind as the shared admin-arms message (repo.branch.rename_default_or_protected_branch_error)", () => {
    // Upstream's ONE message covers BOTH admin arms — the :443 default
    // and the :451 exact-named rule — so GT's single landed kind carries
    // both; the message interpolates nothing.
    expect(flash({ renameError: "default", errorName: "main" })).toBe(
      ERROR_BANNER(branchesLocale.rename_default_or_protected_branch_error),
    );
    expect(flash({ renameError: "default", errorName: "main" })).toContain(
      "Only admins can rename default or protected branches.",
    );
  });

  it("renders the protected kind as the shared protection message (repo.branch.rename_protected_branch_failed)", () => {
    // The onto-protected arm (:461-468) and the tx wildcard arm (:381-390)
    // share it; the pin mirrors the wildcard arm with a pattern-named
    // branch.
    expect(flash({ renameError: "protected", errorName: "release-*" })).toBe(
      ERROR_BANNER(branchesLocale.rename_protected_branch_failed),
    );
    expect(flash({ renameError: "protected", errorName: "release-*" })).toContain(
      "Failed to rename branch due to branch protection rules.",
    );
  });

  it("renders the missing kind as from_not_exist (repo.settings.rename_branch_failed_not_exist over the carried from)", () => {
    expect(flash({ renameError: "missing", errorName: "ghost" })).toBe(
      ERROR_BANNER(branchesLocale.rename_branch_failed_not_exist("ghost")),
    );
    expect(flash({ renameError: "missing", errorName: "ghost" })).toContain(
      "Cannot rename branch ghost because it does not exist.",
    );
  });

  it("renders the exists kind as target_exist (repo.settings.rename_branch_failed_exist) — exact in the from==to arm", () => {
    // Upstream interpolates form.To; the redirect carries name={from},
    // which equals the target in the self-rename arm — exact there, the
    // colliding-target arm discloses the budget reduction (the block doc).
    expect(flash({ renameError: "exists", errorName: "main" })).toBe(
      ERROR_BANNER(branchesLocale.rename_branch_failed_exist("main")),
    );
    expect(flash({ renameError: "exists", errorName: "main" })).toContain(
      "Cannot rename branch because target branch main exists.",
    );
  });

  it("splits the empty kind by the binding's first-error order: an empty carried from means From, else To", () => {
    // RenameBranchForm's first field is From, so the binding's first
    // ErrRequired is From's when the carried from-name is empty.
    expect(flash({ renameError: "empty", errorName: "" })).toBe(ERROR_BANNER(branchesLocale.rename_empty_from));
    expect(flash({ renameError: "empty" })).toContain("From cannot be empty.");
    expect(flash({ renameError: "empty", errorName: "main" })).toBe(ERROR_BANNER(branchesLocale.rename_empty_to));
    expect(flash({ renameError: "empty", errorName: "main" })).toContain("To cannot be empty.");
  });

  it("renders the renamed success as the target-only reduction, and the exact two-name message when a from-name rides", () => {
    // The landed success redirect (?renamed={to}) carries no from-name;
    // the exact repo.settings.rename_branch_success interpolates (from, to),
    // so the message renders the target-only reduction until a fold
    // extends the redirect with &name={from} (the locale note).
    expect(flash({ renamed: "side" })).toBe(SUCCESS_BANNER(branchesLocale.rename_branch_success_redirect("side")));
    expect(flash({ renamed: "side" })).toContain("Branch was successfully renamed to side.");
    // A crafted/extended URL with both names renders upstream's exact text.
    expect(flash({ renamed: "side", errorName: "main" })).toBe(
      SUCCESS_BANNER(branchesLocale.rename_branch_success("main", "side")),
    );
    expect(flash({ renamed: "side", errorName: "main" })).toContain("Branch main was successfully renamed to side.");
  });
});

describe("BranchesFlash — the no-flash and precedence arms", () => {
  it("renders nothing at all without params (no banner element of any shape)", () => {
    const html = flash({});
    expect(html).not.toContain("flash-message");
    expect(html).not.toContain("ui negative message");
    expect(html).not.toContain("ui positive message");
    expect(html).not.toContain("ui info message");
  });

  it("keeps the landed family precedence when crafted params overlap (delete → restore → create → rename)", () => {
    expect(flash({ deleted: "stale", renameError: "protected", errorName: "main" })).toContain("has been deleted");
    // create precedes rename — the create banner wins the overlap.
    expect(flash({ renamed: "side", createError: "empty" })).toContain("NewBranchName cannot be empty.");
  });
});
