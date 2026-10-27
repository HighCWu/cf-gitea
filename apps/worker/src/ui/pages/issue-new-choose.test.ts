/**
 * The issue-template CHOOSER seam's tests (pages/issue-new-choose.ts — the
 * `/{owner}/{repo}/issues/new/choose` census slice). The module is the
 * NO-TEMPLATES arm, ported honestly: our side has no issue-template
 * pipeline (no template tables, no default-branch tree walk — the module
 * doc's data-gate section), so upstream's `HasTemplatesOrContactLinks`
 * (services/issue/template.go:182-192) is structurally false at every repo
 * and the page's ONLY reachable arm is the 303 onto `/{o}/{r}/issues/new`
 * with the raw query preserved (issue_new.go:191-195). The choose.tmpl card
 * DOM is deliberately NOT ported — the dead-card rule forbids inventing
 * cards for data that cannot exist.
 *
 * Coverage (the route arm rides the mount recipe — the module header's
 * HANDOFF NOTE; the tail is UNCLAIMED in parseUiRoute today, so the live
 * dispatcher cannot reach the seam yet and these tests drive the module
 * directly, the search-aux convention):
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
 *   - the claim state (the two-stage pin): `parseUiRoute` returns null and
 *     `handlesUiRoute` false for the choose tail — the wiring window flips
 *     these per the HANDOFF — while the sibling shapes prove the recipe's
 *     guards claim nothing extra (the bare `/issues/new` literal, the
 *     case-exact literals, the deeper tails all stay as they are).
 *
 * Pure unit suite — no D1, no engine, no bindings (the seam touches no
 * storage; parseUiRoute is a pure parser).
 */

import { describe, expect, it } from "vitest";

import { handlesUiRoute, parseUiRoute } from "../index";
import { issueNewChooseRedirect } from "./issue-new-choose";

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
