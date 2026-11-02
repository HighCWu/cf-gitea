/**
 * The RELEASE REACTIONS write ladder (ledger R16(f) — pages/
 * release-reaction-writes.ts) driven DIRECTLY over the module's own recipe
 * router (createReleaseReactionWritesRouter — the issue-timeline-writes.test
 * posture; the mounted uiRouter carries none of it until the orchestrator's
 * fold, and the fold flips the render-half pins in releases.matrix.test.tsx).
 * The ladder pins, per upstream repo.ChangeReleaseReaction
 * (routers/web/repo/release.go:708-755 at web.go:1515's mount):
 *
 *   - the GATES: the GET twin's chi-405, anonymous → the login 303, the §2.8
 *     cross-origin 403 fronting it, the empty repo 404 (MustBeNotEmpty), the
 *     releases-unit-off 404 (reqRepoReleaseReader), the archived repo 404
 *     (RepoMustNotBeArchived — the file-editor reduction);
 *   - the TARGET: junk/missing/foreign ids 404 (the repo-scoped lookup —
 *     upstream's ServerError-on-miss reduced), the tag-record and draft rows
 *     404 (release.go:719-722, status-exact NotFound — drafts unreactable
 *     even for the writer);
 *   - the ACTION: an unknown action 404 (the switch default), the empty
 *     content 400 (ReactionForm's Required bind refusal);
 *   - the REACT arm: the row insert with `issue_id = 0, comment_id = 0`,
 *     the idempotent duplicate (ErrReactionAlreadyExist tolerated), the
 *     per-user rows, the forbidden content 403 (`-1`/`confused` are in the
 *     ISSUE set but not the RELEASE set — setting.UI.ReleaseReactions
 *     default, ui.go:103) with NO row written, the blocked-by-publisher 403
 *     (ErrBlockedUser — both unwrap util.ErrPermissionDenied, release.go:
 *     726-729's HTTPError(403));
 *   - the UNREACT arm: the silent delete, the no-row unreact still 303, and
 *     the foreign-content unreact SUCCESS (upstream's unreact runs NO
 *     allowed-set/blocked checks — DeleteReleaseReaction direct).
 *
 * THROWAWAY DISCIPLINE (the 7187797 lesson): the ladders seed their own
 * release rows each test (the full per-test wipe — the releases matrix
 * posture); the seeded repo/engine cells converge idempotently.
 */

import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { saveRepoSettings } from "../../api/services/repo-settings";
import { ALLOWED_RELEASE_REACTIONS, createReleaseReaction, deleteReleaseReaction, listReleaseReactions } from "../../api/services/release-reactions";
import { reactions, releases, repositories, userBlocking } from "../../db/schema";
import { IssuesService, type ReleaseRow } from "../../issues/service";
import { RepoService } from "../../repos/service";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { createReleaseReactionWritesRouter, parseReleaseReactionForm } from "./release-reaction-writes";

// --- the recipe-router harness (the issue-timeline-writes matrix's posture) -------

const reactionRouter = createReleaseReactionWritesRouter();

async function fetchReaction(path: string, init?: RequestInit): Promise<Response> {
  const context = createExecutionContext();
  const response = await reactionRouter.fetch(new Request(`https://test.local${path}`, init), routeEnv, context);
  await waitOnExecutionContext(context);
  return response;
}

/** The synthetic-manifest env (the milestones.matrix fixture shape). */
const manifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

type RouteEnv = Omit<Env, "ASSETS"> & { ASSETS?: { fetch(input: RequestInfo): Promise<Response> } };
const routeEnv: RouteEnv = {
  ...env,
  ASSETS: { fetch: () => Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 })) },
};

async function sessionHeader(userId: number): Promise<string> {
  return `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, userId)}`;
}

/** A same-origin urlencoded form POST (the §2.8 layer-2 guard's happy path). */
function formPost(path: string, body: Record<string, string>, cookie?: string, origin = "https://test.local"): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: new URLSearchParams(body).toString(),
  };
}

// --- fixtures -------------------------------------------------------------------

const T0 = 1_740_000_000;
const at = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

const RELRX_COMMITS: SeedCommit[] = [
  { message: "relrx: root", time: T0, files: [{ path: "README.md", content: "# relrx\n" }] },
  { message: "relrx: second", time: T0 + 60, files: [{ path: "README.md", content: "# relrx v2\n" }] },
];

interface RelrxFixture {
  ownerId: number;
  readId: number;
  ownerCookie: string;
  readCookie: string;
  repoId: string;
  /** The stable release the happy-path ladders react on. */
  v1: ReleaseRow;
  /** The draft row (unreactable even for its publisher — release.go:719). */
  draft: ReleaseRow;
  /** The pure tag record (unreactable — release.go:719's IsTag arm). */
  tagRecord: ReleaseRow;
  /** A second repo's release — the foreign-id 404 arm. */
  foreign: ReleaseRow;
}

let fixture: RelrxFixture | null = null;

async function ensureFixture(): Promise<RelrxFixture> {
  if (fixture !== null) return fixture;
  const owner = await seedVerifiedUser({ username: "relrx-owner" });
  const read = await seedVerifiedUser({ username: "relrx-read" });
  await ensureSeededRepo({
    owner: "relrx-owner",
    slug: "relrx",
    commits: RELRX_COMMITS,
    tags: [{ name: "v1", commitIndex: 0 }],
  });
  const repoRow = await drizzle(env.DB)
    .select()
    .from(repositories)
    .where(eq(repositories.ownerNamespace, "relrx-owner"))
    .get();
  if (repoRow === undefined) throw new Error("relrx repo row missing");
  if (repoRow.visibility !== "public" || repoRow.isEmpty) {
    // The re-created row forgets the push-create stamps — pin visibility and
    // the non-empty flag to the real state (the releases matrix's posture).
    await drizzle(env.DB).update(repositories).set({ visibility: "public", isEmpty: false }).where(eq(repositories.id, repoRow.id));
  }
  const svc = new IssuesService(env.DB);
  const v1 = await svc.createRelease({
    repoId: repoRow.id,
    publisherId: owner.id,
    tagName: "v1",
    target: "main",
    title: "Relrx v1",
    note: "",
    isDraft: false,
    isPrerelease: false,
    now: at(100),
  });
  const draft = await svc.createRelease({
    repoId: repoRow.id,
    publisherId: owner.id,
    tagName: "wip",
    target: "main",
    title: "Relrx wip",
    note: "",
    isDraft: true,
    isPrerelease: false,
    now: at(101),
  });
  // The pure tag record (the §2.3 is_tag row — a direct insert; most columns
  // default, the tag pair + publisher are the notNull minimum).
  const inserted = await drizzle(env.DB)
    .insert(releases)
    .values({
      repoId: repoRow.id,
      publisherId: owner.id,
      tagName: "just-a-tag",
      lowerTagName: "just-a-tag",
      isTag: true,
      createdAt: at(102),
    })
    .returning()
    .all();
  const tagRecord = inserted[0];
  if (tagRecord === undefined) throw new Error("tag record insert failed");
  // The foreign repo's release (the repo-scoped lookup's cross-repo arm).
  const foreignUser = await seedVerifiedUser({ username: "relrx-other" });
  const foreignRepo = await new RepoService(env.DB).create({
    owner: { id: foreignUser.id, usernameLower: "relrx-other" },
    name: "other",
    isPrivate: false,
    status: "ready",
  });
  await drizzle(env.DB).update(repositories).set({ visibility: "public", isEmpty: false }).where(eq(repositories.id, foreignRepo.id));
  const foreign = await svc.createRelease({
    repoId: foreignRepo.id,
    publisherId: foreignUser.id,
    tagName: "f1",
    target: "main",
    title: "Foreign f1",
    note: "",
    isDraft: false,
    isPrerelease: false,
    now: at(103),
  });
  fixture = {
    ownerId: owner.id,
    readId: read.id,
    ownerCookie: await sessionHeader(owner.id),
    readCookie: await sessionHeader(read.id),
    repoId: repoRow.id,
    v1,
    draft,
    tagRecord,
    foreign,
  };
  return fixture;
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  fixture = null;
  // FK order: leaf rows first, repositories/users before their dependents
  // (the sessions cascade from users — the notifications wipe precedent).
  for (const table of ["reactions", "release_assets", "releases", "repo_collaborators", "repo_settings", "repo_counters", "user_blocking", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

/** The reaction rows of one release (the write assertions' read-back). */
async function rowsOf(releaseId: number): Promise<Array<{ userId: number; type: string }>> {
  const found = await listReleaseReactions(env.DB, [releaseId]);
  return found.map((row) => ({ userId: row.userId, type: row.type }));
}

// --- the parsers -----------------------------------------------------------------

describe("the release reaction form parse", () => {
  it("content is the Required field — present parsed, empty/garbage null (the bind refusal)", () => {
    expect(parseReleaseReactionForm(new URLSearchParams("content=%2B1"))).toBe("+1");
    expect(parseReleaseReactionForm(new URLSearchParams("content=heart"))).toBe("heart");
    expect(parseReleaseReactionForm(new URLSearchParams("content="))).toBeNull();
    expect(parseReleaseReactionForm(new URLSearchParams())).toBeNull();
  });

  it("the allowed release set is the issue set minus -1/confused (ui.go:103, ordered)", () => {
    expect([...ALLOWED_RELEASE_REACTIONS]).toEqual(["+1", "laugh", "hooray", "heart", "rocket", "eyes"]);
  });
});

// --- the gates -------------------------------------------------------------------

describe("the release reaction gates (web.go:1515's mount)", () => {
  it("the GET twin answers chi's 405 with the allow header", async () => {
    const res = await fetchReaction("/relrx-owner/relrx/releases/1/reactions/react");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("anonymous → the §2.5 login 303 with the redirect_to round-trip (reqSignIn)", async () => {
    const f = await ensureFixture();
    const res = await fetchReaction(`/relrx-owner/relrx/releases/${f.v1.id}/reactions/react`, formPost("/x", { content: "+1" }));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      `/login?redirect_to=${encodeURIComponent(`/relrx-owner/relrx/releases/${f.v1.id}/reactions/react`)}`,
    );
    expect(await rowsOf(f.v1.id)).toEqual([]);
  });

  it("a cross-origin POST is the §2.8 guard's 403, fronting every other gate", async () => {
    const f = await ensureFixture();
    const res = await fetchReaction(
      `/relrx-owner/relrx/releases/${f.v1.id}/reactions/react`,
      formPost("/x", { content: "+1" }, f.ownerCookie, "https://evil.local"),
    );
    expect(res.status).toBe(403);
    expect(await rowsOf(f.v1.id)).toEqual([]);
  });

  it("an empty repo 404-shells (repo.MustBeNotEmpty)", async () => {
    const f = await ensureFixture();
    await drizzle(env.DB).update(repositories).set({ isEmpty: true }).where(eq(repositories.id, f.repoId));
    const res = await fetchReaction(`/relrx-owner/relrx/releases/${f.v1.id}/reactions/react`, formPost("/x", { content: "+1" }, f.ownerCookie));
    expect(res.status).toBe(404);
  });

  it("the releases unit off 404-shells (reqRepoReleaseReader)", async () => {
    const f = await ensureFixture();
    await saveRepoSettings(env.DB, f.repoId, { hasReleases: false }, at(110));
    const res = await fetchReaction(`/relrx-owner/relrx/releases/${f.v1.id}/reactions/react`, formPost("/x", { content: "+1" }, f.ownerCookie));
    expect(res.status).toBe(404);
  });

  it("an archived repo 404-shells (RepoMustNotBeArchived — the file-editor reduction of upstream's 403)", async () => {
    const f = await ensureFixture();
    await drizzle(env.DB).update(repositories).set({ isArchived: true }).where(eq(repositories.id, f.repoId));
    const res = await fetchReaction(`/relrx-owner/relrx/releases/${f.v1.id}/reactions/react`, formPost("/x", { content: "+1" }, f.ownerCookie));
    expect(res.status).toBe(404);
  });
});

// --- the target arms --------------------------------------------------------------

describe("the release reaction target (release.go:712-722)", () => {
  it("a junk id segment 404s (PathParamInt64's zero lands the lookup miss)", async () => {
    const f = await ensureFixture();
    const res = await fetchReaction("/relrx-owner/relrx/releases/abc/reactions/react", formPost("/x", { content: "+1" }, f.ownerCookie));
    expect(res.status).toBe(404);
  });

  it("a missing id 404-shells (the repo-scoped lookup — upstream's ServerError-on-miss reduced)", async () => {
    const f = await ensureFixture();
    const res = await fetchReaction("/relrx-owner/relrx/releases/99999/reactions/react", formPost("/x", { content: "+1" }, f.ownerCookie));
    expect(res.status).toBe(404);
  });

  it("a FOREIGN repo's release id 404s (GetReleaseForRepoByID is repo-scoped)", async () => {
    const f = await ensureFixture();
    const res = await fetchReaction(`/relrx-owner/relrx/releases/${f.foreign.id}/reactions/react`, formPost("/x", { content: "+1" }, f.ownerCookie));
    expect(res.status).toBe(404);
    expect(await rowsOf(f.foreign.id)).toEqual([]);
  });

  it("a TAG record 404s (release.go:719's IsTag arm, status-exact NotFound)", async () => {
    const f = await ensureFixture();
    const res = await fetchReaction(`/relrx-owner/relrx/releases/${f.tagRecord.id}/reactions/react`, formPost("/x", { content: "+1" }, f.ownerCookie));
    expect(res.status).toBe(404);
  });

  it("a DRAFT 404s even for its publisher (release.go:719's IsDraft arm — drafts are unreactable)", async () => {
    const f = await ensureFixture();
    const res = await fetchReaction(`/relrx-owner/relrx/releases/${f.draft.id}/reactions/react`, formPost("/x", { content: "+1" }, f.ownerCookie));
    expect(res.status).toBe(404);
    expect(await rowsOf(f.draft.id)).toEqual([]);
  });
});

// --- the action arms ----------------------------------------------------------------

describe("the release reaction toggle (ChangeReleaseReaction)", () => {
  it("an unknown action 404s (the switch default)", async () => {
    const f = await ensureFixture();
    const res = await fetchReaction(`/relrx-owner/relrx/releases/${f.v1.id}/reactions/clap`, formPost("/x", { content: "+1" }, f.ownerCookie));
    expect(res.status).toBe(404);
  });

  it("the empty content is the Required bind refusal — the plain-text 400", async () => {
    const f = await ensureFixture();
    const res = await fetchReaction(`/relrx-owner/relrx/releases/${f.v1.id}/reactions/react`, formPost("/x", { content: "" }, f.ownerCookie));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("content is required");
    expect(await rowsOf(f.v1.id)).toEqual([]);
  });

  it("the react happy path inserts the row with issue_id=0/comment_id=0 and 303s onto the release's page", async () => {
    const f = await ensureFixture();
    const res = await fetchReaction(`/relrx-owner/relrx/releases/${f.v1.id}/reactions/react`, formPost("/x", { content: "+1" }, f.readCookie));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/relrx-owner/relrx/releases/tag/v1");
    const found = await listReleaseReactions(env.DB, [f.v1.id]);
    expect(found).toHaveLength(1);
    expect(found[0]?.userId).toBe(f.readId);
    expect(found[0]?.type).toBe("+1");
    const raw = await drizzle(env.DB).select().from(reactions).all();
    expect(raw).toHaveLength(1);
    expect(raw[0]?.issueId).toBe(0);
    expect(raw[0]?.commentId).toBe(0);
    expect(raw[0]?.releaseId).toBe(f.v1.id);
  });

  it("the duplicate react is the idempotent success (ErrReactionAlreadyExist tolerated, release.go:730)", async () => {
    const f = await ensureFixture();
    for (let i = 0; i < 2; i++) {
      const res = await fetchReaction(`/relrx-owner/relrx/releases/${f.v1.id}/reactions/react`, formPost("/x", { content: "heart" }, f.readCookie));
      expect(res.status).toBe(303);
    }
    expect(await rowsOf(f.v1.id)).toEqual([{ userId: f.readId, type: "heart" }]);
  });

  it("a second user's react on the same type lands its own row (reactions_target_uq is per-user)", async () => {
    const f = await ensureFixture();
    for (const cookie of [f.ownerCookie, f.readCookie]) {
      const res = await fetchReaction(`/relrx-owner/relrx/releases/${f.v1.id}/reactions/react`, formPost("/x", { content: "rocket" }, cookie));
      expect(res.status).toBe(303);
    }
    const rows = await rowsOf(f.v1.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.userId).sort((a, b) => a - b)).toEqual([f.ownerId, f.readId].sort((a, b) => a - b));
  });

  it("a foreign content (`-1`/`confused` — the ISSUE set's extras) is the 403 with NO row (ErrForbiddenIssueReaction → util.ErrPermissionDenied)", async () => {
    const f = await ensureFixture();
    for (const content of ["-1", "confused"]) {
      const res = await fetchReaction(`/relrx-owner/relrx/releases/${f.v1.id}/reactions/react`, formPost("/x", { content }, f.ownerCookie));
      expect(res.status).toBe(403);
      expect(await res.text()).toContain(`'${content}' is not an allowed reaction`);
    }
    expect(await rowsOf(f.v1.id)).toEqual([]);
  });

  it("a viewer blocked BY the publisher/owner is the 403 (ErrBlockedUser, release.go:726-729)", async () => {
    const f = await ensureFixture();
    await drizzle(env.DB).insert(userBlocking).values({ blockerId: f.ownerId, blockeeId: f.readId, note: "", createdAt: at(105) });
    const res = await fetchReaction(`/relrx-owner/relrx/releases/${f.v1.id}/reactions/react`, formPost("/x", { content: "+1" }, f.readCookie));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("user is blocked");
    expect(await rowsOf(f.v1.id)).toEqual([]);
  });

  it("the unreact deletes the row silently and 303s (DeleteReleaseReaction)", async () => {
    const f = await ensureFixture();
    await createReleaseReaction(env.DB, { userId: f.readId, releaseId: f.v1.id, type: "eyes" }, at(106));
    const res = await fetchReaction(`/relrx-owner/relrx/releases/${f.v1.id}/reactions/unreact`, formPost("/x", { content: "eyes" }, f.readCookie));
    expect(res.status).toBe(303);
    expect(await rowsOf(f.v1.id)).toEqual([]);
  });

  it("the no-row unreact is still the 303 (the silent delete — no rows is success)", async () => {
    const f = await ensureFixture();
    const res = await fetchReaction(`/relrx-owner/relrx/releases/${f.v1.id}/reactions/unreact`, formPost("/x", { content: "heart" }, f.readCookie));
    expect(res.status).toBe(303);
  });

  it("the foreign-content unreact is the SUCCESS no-op (upstream's unreact runs no allowed-set check — DeleteReleaseReaction direct)", async () => {
    const f = await ensureFixture();
    const res = await fetchReaction(`/relrx-owner/relrx/releases/${f.v1.id}/reactions/unreact`, formPost("/x", { content: "-1" }, f.ownerCookie));
    expect(res.status).toBe(303);
    expect(await rowsOf(f.v1.id)).toEqual([]);
  });

  it("the service seam's deleteReleaseReaction removes only the acting user's row", async () => {
    const f = await ensureFixture();
    await createReleaseReaction(env.DB, { userId: f.ownerId, releaseId: f.v1.id, type: "laugh" }, at(107));
    await createReleaseReaction(env.DB, { userId: f.readId, releaseId: f.v1.id, type: "laugh" }, at(108));
    await deleteReleaseReaction(env.DB, { userId: f.ownerId, releaseId: f.v1.id, type: "laugh" });
    expect(await rowsOf(f.v1.id)).toEqual([{ userId: f.readId, type: "laugh" }]);
  });
});
