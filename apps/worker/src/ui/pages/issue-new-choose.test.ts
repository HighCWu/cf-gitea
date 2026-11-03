/**
 * The issue-template CHOOSER seam's tests (pages/issue-new-choose.tsx — the
 * `/{owner}/{repo}/issues/new/choose` page). The module carries BOTH arms
 * since the ISSUE-TEMPLATE pipeline landed (SPEC-0005 §11): the no-templates
 * 303 (issue_new.go:191-195) and the choose.tmpl render (issue_new.go:180-204).
 *
 * THIS FILE keeps the pure-unit coverage (no bindings, no D1):
 *
 *   - the no-templates arm's EXACT shape: 303 See Other, the location
 *     byte-shape `/{o}/{r}/issues/new?{rawQuery}` with the query preserved
 *     VERBATIM (upstream's `ctx.Req.URL.RawQuery` Sprintf — no re-encode,
 *     no filter), and the trailing `?` on an EMPTY query (the Sprintf's
 *     literal separator);
 *   - the viewer-blind contract: the redirect is deterministic on
 *     (repo, url) — no archived gate (upstream has none on this GET), no
 *     viewer input, repeated calls identical;
 *   - the chain terminates on a LANDED surface: the redirect target's path
 *     parses to the wave-4 `issue-new` family;
 *   - the claim state: `parseUiRoute` claims the choose tail beside the
 *     wave-4 literal, and the sibling shapes prove the recipe's guards
 *     claim nothing extra;
 *   - THE RENDER ARM's pure pieces: the invalid-template notice formatter
 *     (renderErrorOfTemplates' sorted `file: error` lines + the %v
 *     summary), the has-anything predicate, and the en-US locale literals.
 *
 * The ENGINE-BACKED arms (discovery over a real tree, the rendered cards,
 * the prefill round-trip) live in pages/issue-templates.matrix.test.tsx.
 */

import { describe, expect, it } from "vitest";

import { handlesUiRoute, parseUiRoute } from "../index";
import {
  formatTemplateErrors,
  hasAnyTemplateOrContactLink,
  issueNewChooseLocale,
  issueNewChooseRedirect,
  type IssueNewChooseData,
} from "./issue-new-choose";

const OWNER = "nimx";
const REPO = "newchoose";
const repoLink = { ownerNamespace: OWNER, slug: REPO };

describe("the no-templates arm's exact shape (issue_new.go:191-195)", () => {
  it("a query-bearing URL 303s onto issues/new with the raw query VERBATIM — no re-encode, no filter, order kept", () => {
    const res = issueNewChooseRedirect(repoLink, new URL(`https://test.local/${OWNER}/${REPO}/issues/new/choose?title=a%20b&labels=bug,ui&milestone=3`));
    expect(res.status).toBe(303); // http.StatusSeeOther — upstream's explicit code
    expect(res.headers.get("location")).toBe(`/${OWNER}/${REPO}/issues/new?title=a%20b&labels=bug,ui&milestone=3`);
    expect(res.body).toBeNull(); // the redirect carries no body (our Response(null) shape)
  });

  it("an EMPTY query keeps the trailing `?` — upstream's Sprintf literal separator", () => {
    const res = issueNewChooseRedirect(repoLink, new URL(`https://test.local/${OWNER}/${REPO}/issues/new/choose`));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${OWNER}/${REPO}/issues/new?`);
  });

  it("a bare `?` (empty RawQuery) is the same byte shape", () => {
    const res = issueNewChooseRedirect(repoLink, new URL(`https://test.local/${OWNER}/${REPO}/issues/new/choose?`));
    expect(res.headers.get("location")).toBe(`/${OWNER}/${REPO}/issues/new?`);
  });

  it("the prefill-shaped query a chooser link emits survives whole (?project={id} — repo-projects.tsx:92's anchor shape)", () => {
    const res = issueNewChooseRedirect(repoLink, new URL(`https://test.local/${OWNER}/${REPO}/issues/new/choose?project=7&template=bug_report.md`));
    expect(res.headers.get("location")).toBe(`/${OWNER}/${REPO}/issues/new?project=7&template=bug_report.md`);
  });
});

describe("the viewer-blind contract (the reqUnitIssuesReader posture)", () => {
  it("no archived gate — an archived repo's GET still 303s (the refusal lives on the POST this page never issues)", () => {
    const res = issueNewChooseRedirect({ ownerNamespace: OWNER, slug: "arch-choose" }, new URL(`https://test.local/${OWNER}/arch-choose/issues/new/choose?x=1`));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/${OWNER}/arch-choose/issues/new?x=1`);
  });

  it("deterministic on (repo, url) — repeated calls are byte-identical (no viewer input exists)", () => {
    const a = issueNewChooseRedirect(repoLink, new URL(`https://test.local/${OWNER}/${REPO}/issues/new/choose?labels=bug`));
    const b = issueNewChooseRedirect(repoLink, new URL(`https://test.local/${OWNER}/${REPO}/issues/new/choose?labels=bug`));
    expect(a.status).toBe(b.status);
    expect(a.headers.get("location")).toBe(b.headers.get("location"));
  });

  it("the chain terminates on a LANDED surface: the target path parses to the wave-4 issue-new family", () => {
    const target = `/${OWNER}/${REPO}/issues/new`;
    expect(parseUiRoute(target)).toMatchObject({ family: "issue-new", owner: OWNER, repo: REPO });
    expect(handlesUiRoute(target)).toBe(true);
  });
});

// The two-stage pin: ui/index.ts is not this slice's file, and
// `parseUiRoute` has no arm for the choose tail today — src/index.ts
// consults `handlesUiRoute` BEFORE Hono, so the live dispatcher hands the
// URL to the engine's 404. These pins hold the CURRENT posture honestly and
// name the flip: the wiring window applies the module header's HANDOFF
// NOTE (family arm + handler + uiRouter.get) and inverts BOTH expects, then
// mounts the route-level matrix (the visibility ladder over the real
// dispatcher — anonymous public 303 with the query round-trip; anonymous or
// stranger at a private repo, the 404 shell).
describe("the claim state (two-stage HANDOFF — flipped by the wiring window)", () => {
  it("the choose tail is CLAIMED by the wiring window: parseUiRoute yields the family", () => {
    expect(parseUiRoute(`/${OWNER}/${REPO}/issues/new/choose`)).toMatchObject({ family: "issue-new-choose" });
    expect(handlesUiRoute(`/${OWNER}/${REPO}/issues/new/choose`)).toBe(true);
  });

  it("the recipe's guards overclaim nothing: the sibling shapes keep today's answers", () => {
    // The bare literal stays the wave-4 form family (the length guard keeps it).
    expect(parseUiRoute(`/${OWNER}/${REPO}/issues/new`)).toMatchObject({ family: "issue-new" });
    // Deeper and misspelled tails stay unclaimed — the recipe's
    // rest.length===2 + exact-literal guard claims ONLY the choose tail.
    expect(parseUiRoute(`/${OWNER}/${REPO}/issues/new/choose/extra`)).toBeNull();
    expect(parseUiRoute(`/${OWNER}/${REPO}/issues/new/choosen`)).toBeNull();
    expect(parseUiRoute(`/${OWNER}/${REPO}/issues/newx/choose`)).toBeNull();
    // Family literals are lowercase-exact (the parse comment at ui/index.ts
    // `Family literals are lowercase-exact, like upstream's chi patterns`).
    expect(parseUiRoute(`/${OWNER}/${REPO}/issues/new/Choose`)).toBeNull();
    // The pulls side has no choose twin — but the window-2e wildcard family
    // (web.go:1314's `pulls/new/*`) CLAIMS the shape as a compare redirect;
    // the recipe must not disturb it.
    expect(parseUiRoute(`/${OWNER}/${REPO}/pulls/new/choose`)).toEqual({
      family: "pulls-new-redirect",
      owner: OWNER,
      repo: REPO,
    });
  });
});

// ---------------------------------------------------------------------------
// the render arm's pure pieces (SPEC-0005 §11)
// ---------------------------------------------------------------------------

describe("formatTemplateErrors (renderErrorOfTemplates, issue_new.go:155-177)", () => {
  it("the files sort for the stable output; the lines are `file: error`", () => {
    const errors = new Map<string, string>([
      [".gitea/ISSUE_TEMPLATE/z.yaml", "'about' is required"],
      [".gitea/ISSUE_TEMPLATE/a.md", "too large: 9000000 > MaxDisplayFileSize"],
    ]);
    const formatted = formatTemplateErrors(errors);
    expect(formatted.summary).toBe("2 invalid template(s) found"); // the %v substitution
    expect(formatted.details).toEqual([
      ".gitea/ISSUE_TEMPLATE/a.md: too large: 9000000 > MaxDisplayFileSize",
      ".gitea/ISSUE_TEMPLATE/z.yaml: 'about' is required",
    ]);
  });

  it("an empty errors map formats to the zero summary (the page gates on size before calling)", () => {
    const formatted = formatTemplateErrors(new Map());
    expect(formatted.summary).toBe("0 invalid template(s) found");
    expect(formatted.details).toEqual([]);
  });
});

describe("hasAnyTemplateOrContactLink (HasTemplatesOrContactLinks, template.go:182-190)", () => {
  const base: IssueNewChooseData = {
    templates: [],
    templateErrors: new Map(),
    config: { blankIssuesEnabled: true, contactLinks: [] },
    configError: null,
    prefillQuery: "",
  };

  it("false with no templates and no links (the 303 arm's predicate)", () => {
    expect(hasAnyTemplateOrContactLink(base)).toBe(false);
  });

  it("true on templates alone; true on contact links alone (even with zero templates)", () => {
    expect(hasAnyTemplateOrContactLink({ ...base, templates: [{ name: "x", title: "", about: "a", labels: [], assignees: [], ref: "", content: "", fields: [], fileName: "x.md" }] })).toBe(true);
    expect(hasAnyTemplateOrContactLink({ ...base, config: { blankIssuesEnabled: true, contactLinks: [{ name: "Chat", url: "https://x", about: "a" }] } })).toBe(true);
  });

  it("the locale literals are the en-US pins", () => {
    expect(issueNewChooseLocale.get_started).toBe("Get Started");
    expect(issueNewChooseLocale.open_external_link).toBe("Open");
    expect(issueNewChooseLocale.blank).toBe("Default");
    expect(issueNewChooseLocale.blank_about).toBe("Create an issue from default template.");
    expect(issueNewChooseLocale.ignore_invalid_templates).toBe("Invalid templates have been ignored");
    expect(issueNewChooseLocale.invalid_config).toBe("The issue config contains errors:");
  });
});
