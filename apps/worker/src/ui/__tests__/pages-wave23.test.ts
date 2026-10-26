/**
 * Pages wave 23 route tests — the UI-parity survey's NEXT tier (the bench
 * after waves 16-20 closed the top-5): the two highest-ranked remaining
 * data-landed rows,
 *
 *   - `GET /org/{org}/members` (survey family B, web.go:965) — the org
 *     members list over the landed `listOrgMemberRows` /
 *     `orgMembersPublicOnly` read (api/services/orgs.ts, the exact arms
 *     GET /orgs/{org}/members serves), anonymous-capable with the
 *     PublicOnly scope as the per-row gate;
 *   - `GET /{username}/-/repositories` (survey family B, web.go:1134) — the
 *     `/-` namespace's repositories route, the org-home DOM through
 *     upstream's second URL (tplOrgHome serves both), user names 404-shelling
 *     like upstream org.Repositories' `org == nil` arm.
 *
 * Fixture recipe mirrors pages-wave16: a public org (one owner, one public
 * member, one private member — the is_public flag decides the anonymous
 * listing), one outsider user, and two org repos (public + private — the
 * §4.7 listing arms). Identities ride minted session cookies.
 *
 * Same harness posture as pages-wave2..20: the router is driven directly
 * with the synthetic ASSETS manifest; D1-only fixtures (no engine content —
 * neither page reads git data).
 */

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { runA11y } from "./a11y";
import { uiEnv } from "./harness";
import { OrgService } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const withCookie = (path: string, cookie: string): RequestInit => ({
  headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
});

// --- fixtures -----------------------------------------------------------------

interface Wave23Fixture {
  ownerCookie: string; // wave23-owner — the org owner
  pubCookie: string; // wave23-pub — a public member
  privCookie: string; // wave23-priv — a private member
  outCookie: string; // wave23-out — a signed-in non-member
}

let wave23Fixture: Wave23Fixture | null = null;

async function ensureWave23Fixtures(): Promise<Wave23Fixture> {
  if (wave23Fixture !== null) return wave23Fixture;
  await applyAuthD1Migrations();

  const owner = await seedVerifiedUser({ username: "wave23-owner" });
  const pub = await seedVerifiedUser({ username: "wave23-pub" });
  const priv = await seedVerifiedUser({ username: "wave23-priv" });
  const out = await seedVerifiedUser({ username: "wave23-out" });

  const orgs = new OrgService(env.DB);
  const org = await orgs.createOrg({
    name: "wave23org",
    ownerId: owner.id,
    visibility: "public",
    fullName: "Wave 23 Forge",
    now: new Date(1_700_000_000 * 1000),
  });
  // The members: one public, one private (addMember's isPublic defaults to
  // the upstream DefaultOrgMemberVisible=false posture; the owner's own
  // membership is private too — the create arm's default).
  await orgs.addMember(org.id, pub.id, { isPublic: true, now: new Date(1_700_000_100 * 1000) });
  await orgs.addMember(org.id, priv.id, { isPublic: false, now: new Date(1_700_000_200 * 1000) });

  // Two org repos: public + private (D1-only — neither page reads engine
  // content; the org-home fixture shape).
  const service = new RepoService(env.DB);
  await service.create({
    owner: { id: org.id, usernameLower: org.usernameLower },
    name: "alpha",
    isPrivate: false,
    status: "ready",
  });
  await service.create({
    owner: { id: org.id, usernameLower: org.usernameLower },
    name: "beta-lab",
    isPrivate: true,
    status: "ready",
  });

  wave23Fixture = {
    ownerCookie: await mintSession(env.DB, owner.id),
    pubCookie: await mintSession(env.DB, pub.id),
    privCookie: await mintSession(env.DB, priv.id),
    outCookie: await mintSession(env.DB, out.id),
  };
  return wave23Fixture;
}

beforeAll(async () => {
  await ensureWave23Fixtures();
});

// --- the parser claims (the route registry's shape contract) --------------------

describe("wave-23 parser claims", () => {
  it("claims exactly the /org/{org}/members and /{owner}/-/repositories shapes", () => {
    expect(parseUiRoute("/org/wave23org/members")).toEqual({ family: "org-members", owner: "wave23org" });
    expect(parseUiRoute("/wave23org/-/repositories")).toEqual({ family: "org-repositories", owner: "wave23org" });
    // The sibling shapes stay unclaimed (the engine's 404), EXCEPT the plain
    // two-segment repo-home shapes, which were already the home family and
    // resolve to nothing at repo time (no owner "org", no repo "-").
    expect(parseUiRoute("/org/wave23org/members/extra")).toBeNull();
    expect(parseUiRoute("/org/wave23org")).toEqual({ family: "home", owner: "org", repo: "wave23org", refSuffix: null });
    expect(parseUiRoute("/wave23org/-/heatmap")).toBeNull();
    expect(parseUiRoute("/wave23org/-")).toEqual({ family: "home", owner: "wave23org", repo: "-", refSuffix: null });
    expect(parseUiRoute("/wave23org/-/packages")).toBeNull();
    // handlesUiRoute (the dispatcher's gate) answers the same.
    expect(handlesUiRoute("/org/wave23org/members")).toBe(true);
    expect(handlesUiRoute("/wave23org/-/repositories")).toBe(true);
    expect(handlesUiRoute("/wave23org/-/heatmap")).toBe(false);
  });
});

// --- the org members page ---------------------------------------------------------

describe("org members page /org/{org}/members", () => {
  it("the anonymous viewer renders the public-only listing (no role lines)", async () => {
    await ensureWave23Fixtures();
    const res = await fetchUi("/org/wave23org/members");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content organization members"');
    expect(html).toContain('href="/wave23-pub"');
    expect(html).not.toContain('href="/wave23-priv"');
    expect(html).not.toContain('href="/wave23-owner"');
    expect(html).not.toContain("Member Role:");
    expect(html).not.toContain("Hidden");
    // The owner prompt row is owner-only.
    expect(html).not.toContain('href="/wave23org/teams"');
  });

  it("the org owner sees every membership with the role lines and the manage prompt", async () => {
    const fixture = await ensureWave23Fixtures();
    const res = await fetchUi("/org/wave23org/members", withCookie("/org/wave23org/members", fixture.ownerCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const username of ["wave23-owner", "wave23-pub", "wave23-priv"]) {
      expect(html).toContain(`href="/${username}"`);
    }
    expect(html).toContain("Hidden");
    expect(html).toContain("Member Role:");
    expect(html).toContain("Owner");
    expect(html).toContain("Member");
    expect(html).toContain("Members are managed through teams.");
    expect(html).toContain('href="/wave23org/teams"');
  });

  it("a signed-in non-member stays public-only (the PublicOnly doer arm)", async () => {
    const fixture = await ensureWave23Fixtures();
    const res = await fetchUi("/org/wave23org/members", withCookie("/org/wave23org/members", fixture.outCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/wave23-pub"');
    expect(html).not.toContain('href="/wave23-priv"');
    expect(html).not.toContain("Member Role:");
    expect(html).not.toContain('href="/wave23org/teams"');
  });

  it("a signed-in private member sees the full listing with the role lines", async () => {
    const fixture = await ensureWave23Fixtures();
    const res = await fetchUi("/org/wave23org/members", withCookie("/org/wave23org/members", fixture.privCookie));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/wave23-priv"');
    expect(html).toContain('href="/wave23-owner"');
    expect(html).toContain("Member Role:");
    expect(html).toContain("Owner");
    // The member themself is private — the badge renders.
    expect(html).toContain("Hidden");
  });

  it("the ?q= keyword narrows the listing and the empty arm renders the miss text", async () => {
    await ensureWave23Fixtures();
    const filtered = await fetchUi("/org/wave23org/members?q=pub");
    expect(filtered.status).toBe(200);
    const filteredHtml = await filtered.text();
    expect(filteredHtml).toContain('href="/wave23-pub"');
    expect(filteredHtml).not.toContain('href="/wave23-priv"');
    // The form re-renders the keyword.
    expect(filteredHtml).toContain('value="pub"');

    const missed = await fetchUi("/org/wave23org/members?q=zzz-not-a-member");
    expect(missed.status).toBe(200);
    expect(await missed.text()).toContain("No matching results found.");
  });

  it("unknown orgs, plain user names, and deeper tails 404-shell", async () => {
    await ensureWave23Fixtures();
    expect((await fetchUi("/org/wave23-nobody/members")).status).toBe(404);
    // The {org} param resolves ORG rows only — a plain user name is a miss
    // (the type gate).
    expect((await fetchUi("/org/wave23-out/members")).status).toBe(404);
    expect((await fetchUi("/org/wave23org/members/extra")).status).toBe(404);
  });
});

// --- the org repositories page ----------------------------------------------------

describe("org repositories page /{org}/-/repositories", () => {
  it("the anonymous viewer renders the org's public repo list", async () => {
    await ensureWave23Fixtures();
    const res = await fetchUi("/wave23org/-/repositories");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/wave23org/alpha"');
    expect(html).not.toContain('href="/wave23org/beta-lab"');
    // The org header + the repositories tab render (the org-home DOM).
    expect(html).toContain("Wave 23 Forge");
    expect(html).toContain("Repositories");
  });

  it("the org owner sees the private rows too (the §4.7 owner arm)", async () => {
    const fixture = await ensureWave23Fixtures();
    const res = await fetchUi(
      "/wave23org/-/repositories",
      withCookie("/wave23org/-/repositories", fixture.ownerCookie),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="/wave23org/alpha"');
    expect(html).toContain('href="/wave23org/beta-lab"');
  });

  it("a plain user name, an unknown owner, and sibling /- tails 404-shell", async () => {
    await ensureWave23Fixtures();
    // Upstream org.Repositories' `org == nil` arm — a user row is a miss.
    expect((await fetchUi("/wave23-out/-/repositories")).status).toBe(404);
    expect((await fetchUi("/wave23-nobody/-/repositories")).status).toBe(404);
    // The rest of the /- namespace stays unclaimed → the engine's 404.
    expect((await fetchUi("/wave23org/-/heatmap")).status).toBe(404);
    expect((await fetchUi("/wave23org/-")).status).toBe(404);
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("wave-23 a11y smoke", () => {
  it("the new renders pass the structural rules", async () => {
    const fixture = await ensureWave23Fixtures();
    for (const [path, init] of [
      ["/org/wave23org/members", undefined],
      ["/org/wave23org/members", withCookie("/org/wave23org/members", fixture.ownerCookie)],
      ["/org/wave23org/members?q=pub", undefined],
      ["/wave23org/-/repositories", undefined],
      ["/wave23org/-/repositories", withCookie("/wave23org/-/repositories", fixture.ownerCookie)],
    ] as Array<[string, RequestInit | undefined]>) {
      const res = await fetchUi(path, init);
      expect(res.status, path).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});
