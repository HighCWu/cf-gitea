/**
 * The SPEC-0005 stub close-out renders: `fork` / `parent` / `mirror` on the
 * `Repository` payload (the fields REDEPLOY reports carried as
 * `TODO(SPEC-0005)` since v1.0 — the columns landed end-to-end since).
 *
 * Upstream shape under test (services/convert/repository.go):
 *  - `Fork: repo.IsFork` (:208) / `Mirror: repo.IsMirror` (:210) — pure
 *    columns, rendered for EVERY viewer (ours: `fork_parent` non-null /
 *    `is_mirror`).
 *  - `Parent` (:209, via the :46-57 `GetBaseRepo` + `isParent` recursion) —
 *    upstream's only gate is base-row existence; this suite pins OUR
 *    documented tightening (the FIXME's "empty is better than wrong",
 *    :52-56): the parent renders only when the doer can READ the base
 *    (`canViewRepository` + `viewerTeamAccessMode` on the base row), so a
 *    reader sees the full base payload and a stranger on a private base
 *    sees the field omitted, never a leaked private row.
 *  - The mirror schedule triple (:161-170 → :261-263) renders real values
 *    only when the 1:1 `repo_mirrors` row exists; otherwise (and on the
 *    query-flat list paths) the upstream zero-defaults.
 *
 * Also pins the `/repos/search` `mode` arms the landed columns un-stub
 * (upstream repo.go:163-176 → repo_list.go:500-513): fork / mirror /
 * source filter their columns; `collaborative` still matches nothing.
 * The template/archived tri-state filters over the landed `is_template`/
 * `is_archived` columns (repo.go:155-157/181-183 → repo_list.go:391-393/
 * 520-522) and the `original_url` render (`SanitizedOriginalURL`,
 * convert/repository.go:215 → models/repo/repo.go:227-234) are pinned the
 * same way.
 */

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import {
  repoMirrors,
  repositories,
  teamMembers,
  teamRepoAccess,
  teams,
  type TeamAccessMode,
} from "../../db/schema";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { applyOrgsDdl, resetOrgTables } from "../../services/orgs/testing";
import {
  GO_ZERO_TIME,
  findRepositoryByPath,
  sanitizedOriginalUrl,
  searchRepositories,
  toApiRepository,
  toApiRepositoryFull,
  type RepositoryRow,
  type Viewer,
} from "./repository";

beforeAll(async () => {
  await applyAuthD1Migrations();
  await applyOrgsDdl();
});

beforeEach(async () => {
  // resetOrgTables sweeps repositories (and users, minus the reserved
  // 'assets' row); repo_mirrors is newer than that sweep — clear it here.
  await env.DB.prepare("DELETE FROM repo_mirrors").run();
  await resetOrgTables();
});

const NOW = new Date("2026-01-01T00:00:00Z");

const anonymous: Viewer = { origin: "https://example.com", requester: null };

/** The `/repos/search` option base the filter suites spread over — every
 * tri-state filter at its "unset" default, no visibility narrowing. */
const searchOpts = {
  page: 1,
  limit: 50,
  keyword: "",
  topicOnly: false,
  includeDesc: false,
  uid: 0,
  exclusive: false,
  priorityOwnerId: 0,
  teamId: 0,
  starredBy: 0,
  includePrivate: false,
  isPrivate: null,
  template: null,
  archived: null,
  mode: "",
  sort: "",
  order: "",
} as const;

async function seedRepo(
  ownerId: number,
  ownerNamespace: string,
  slug: string,
  visibility: "public" | "private",
  extra: Partial<RepositoryRow> = {},
): Promise<string> {
  const id = `fm_${slug.replace(/-/g, "_")}`;
  await drizzle(env.DB).insert(repositories).values({
    id,
    storageKey: `r_${id}`,
    ownerNamespace,
    ownerId,
    slug,
    visibility,
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: NOW,
    ...extra,
  });
  return id;
}

const viewerFor = (user: { id: number; username: string }, isAdmin = false): Viewer => ({
  origin: "https://example.com",
  requester: {
    id: user.id,
    login: user.username,
    email: "",
    full_name: "",
    avatar_url: "",
    html_url: "",
    language: "",
    location: "",
    website: "",
    description: "",
    active: true,
    is_admin: isAdmin,
    prohibit_login: false,
    restricted: false,
    login_name: "",
    source_id: 0,
    followers_count: 0,
    following_count: 0,
    starred_repos_count: 0,
    created: "2026-01-01T00:00:00Z",
    last_login: GO_ZERO_TIME,
    type: "User",
    visibility: "public",
  },
});

/** The canonical fixture: a private base, a PUBLIC fork of it (upstream's
 * private-after-fork leak shape — the fork stays public when the base goes
 * private), a stranger, and a plain control repo. Only `baseOwner` (and
 * admins / team grantees) can read the private base. */
async function seedForkFixture(): Promise<{
  base: NonNullable<Awaited<ReturnType<typeof findRepositoryByPath>>>;
  fork: NonNullable<Awaited<ReturnType<typeof findRepositoryByPath>>>;
  baseOwner: { id: number; username: string };
  forker: { id: number; username: string };
  stranger: { id: number; username: string };
}> {
  const baseOwner = await seedVerifiedUser({ username: "BaseOwner" });
  const forker = await seedVerifiedUser({ username: "Forker" });
  const stranger = await seedVerifiedUser({ username: "Stranger" });
  const baseId = await seedRepo(baseOwner.id, "baseowner", "secret", "private");
  await seedRepo(forker.id, "forker", "secret-1", "public", { forkParent: baseId });
  const base = await findRepositoryByPath(env.DB, "baseowner", "secret");
  const fork = await findRepositoryByPath(env.DB, "forker", "secret-1");
  if (base === null || fork === null) throw new Error("fixture repos missing");
  return { base, fork, baseOwner, forker, stranger };
}

describe("toApiRepositoryFull — the fork arm (fork + parent)", () => {
  it("a doer who can read the base gets fork:true + the full parent payload (no grandparent nesting)", async () => {
    const { fork, baseOwner } = await seedForkFixture();
    // The base's owner reads their own private base through the fork payload.
    const rendered = await toApiRepositoryFull(env.DB, viewerFor(baseOwner), fork);
    expect(rendered.fork).toBe(true);
    expect(rendered.parent).toBeDefined();
    expect(rendered.parent).toMatchObject({
      full_name: "baseowner/secret",
      name: "secret",
      private: true,
      // upstream renders the base with the CURRENT repo's permission (the
      // FIXME); ours renders the base's own honest matrix — the owner sees
      // admin.
      permissions: { admin: true, push: true, pull: true },
    });
    // The isParent recursion never nests: the base's own parent stays
    // omitted even though the field is now renderable.
    expect(rendered.parent).not.toHaveProperty("parent");
  });

  it("a public base renders the parent to any viewer (readability is the only gate)", async () => {
    const baseOwner = await seedVerifiedUser({ username: "BaseOwner" });
    const forker = await seedVerifiedUser({ username: "Forker" });
    const stranger = await seedVerifiedUser({ username: "Stranger" });
    const baseId = await seedRepo(baseOwner.id, "baseowner", "open", "public");
    await seedRepo(forker.id, "forker", "open-1", "public", { forkParent: baseId });
    const fork = await findRepositoryByPath(env.DB, "forker", "open-1");
    if (fork === null) throw new Error("fixture fork missing");
    const rendered = await toApiRepositoryFull(env.DB, viewerFor(stranger), fork);
    expect(rendered.fork).toBe(true);
    expect(rendered.parent).toMatchObject({
      full_name: "baseowner/open",
      private: false,
      // the stranger's reduced matrix over the base (public ⇒ pull).
      permissions: { admin: false, push: false, pull: true },
    });
  });

  it("a stranger on a private base gets fork:true but parent OMITTED (the gated leak)", async () => {
    const { fork, stranger } = await seedForkFixture();
    const rendered = await toApiRepositoryFull(env.DB, viewerFor(stranger), fork);
    expect(rendered.fork).toBe(true);
    expect(rendered.parent).toBeUndefined();
  });

  it("an org-team reader on the private base sees the parent (the grant rides the base row)", async () => {
    const orgOwner = await seedVerifiedUser({ username: "OrgOwner" });
    const orgs = new OrgService(env.DB);
    const org: OrgRecord = await orgs.createOrg({ name: "acme", ownerId: orgOwner.id });
    const baseId = await seedRepo(org.id, org.usernameLower, "vault", "private");
    const forker = await seedVerifiedUser({ username: "Forker" });
    const reader = await seedVerifiedUser({ username: "BaseReader" });
    const outsider = await seedVerifiedUser({ username: "Outsider" });
    await seedRepo(forker.id, "forker", "vault-1", "public", { forkParent: baseId });
    const fork = await findRepositoryByPath(env.DB, "forker", "vault-1");
    if (fork === null) throw new Error("fixture fork missing");

    const team = await drizzle(env.DB)
      .insert(teams)
      .values({
        orgId: org.id,
        lowerName: "readers",
        name: "readers",
        authorize: "read" as TeamAccessMode,
        includesAllRepositories: false,
        unitsMap: null,
        visibility: "private",
      })
      .returning({ id: teams.id })
      .all();
    const teamId = team[0]!.id;
    await drizzle(env.DB).insert(teamMembers).values({ orgId: org.id, teamId, userId: reader.id });
    await drizzle(env.DB).insert(teamRepoAccess).values({ orgId: org.id, teamId, repoId: baseId });

    expect((await toApiRepositoryFull(env.DB, viewerFor(reader), fork)).parent).toMatchObject({
      full_name: "acme/vault",
    });
    expect(
      (await toApiRepositoryFull(env.DB, viewerFor(outsider), fork)).parent,
    ).toBeUndefined();
  });

  it("a dangling fork edge degrades to an omitted parent (upstream would nil the whole payload)", async () => {
    const forker = await seedVerifiedUser({ username: "Forker" });
    await seedRepo(forker.id, "forker", "ghost-fork", "public", { forkParent: "fm_deleted" });
    const fork = await findRepositoryByPath(env.DB, "forker", "ghost-fork");
    if (fork === null) throw new Error("fixture fork missing");
    const rendered = await toApiRepositoryFull(env.DB, viewerFor(forker), fork);
    expect(rendered.fork).toBe(true);
    expect(rendered.parent).toBeUndefined();
  });
});

describe("toApiRepositoryFull — the mirror arm (mirror + schedule triple)", () => {
  const MIRROR_UPDATED = new Date("2026-02-03T04:05:06Z");
  const LAST_SYNC = 1_770_000_000; // unix seconds — null-mode integer column

  async function seedMirror(withRow: boolean): Promise<NonNullable<Awaited<ReturnType<typeof findRepositoryByPath>>>> {
    const owner = await seedVerifiedUser({ username: "MirrorOwner" });
    const id = await seedRepo(owner.id, "mirrorowner", "upstream", "public", {
      isMirror: true,
      originalUrl: "https://src.example.invalid/upstream.git",
    });
    if (withRow) {
      await drizzle(env.DB).insert(repoMirrors).values({
        repoId: id,
        remoteAddress: "https://src.example.invalid/upstream.git",
        intervalSeconds: 28800,
        lastSyncAt: LAST_SYNC,
        updatedAt: MIRROR_UPDATED,
      });
    }
    const mirror = await findRepositoryByPath(env.DB, "mirrorowner", "upstream");
    if (mirror === null) throw new Error("fixture mirror missing");
    return mirror;
  }

  it("a mirror with a repo_mirrors row renders mirror:true + interval/updated/last_sync", async () => {
    const mirror = await seedMirror(true);
    const rendered = await toApiRepositoryFull(env.DB, anonymous, mirror);
    expect(rendered.mirror).toBe(true);
    // upstream `pullMirror.Interval.String()` whole-second form (mirror.go:27
    // → renderGoDuration), UpdatedUnix → updated_at (:30), LastSyncUnix →
    // last_sync_at (:32).
    expect(rendered.mirror_interval).toBe("8h0m0s");
    expect(rendered.mirror_updated).toBe(MIRROR_UPDATED.toISOString());
    expect(rendered.mirror_last_sync_at).toBe(new Date(LAST_SYNC * 1000).toISOString());
  });

  it("a mirror without a row keeps mirror:true but the zero-default schedule (upstream GetMirrorByRepoID miss)", async () => {
    const mirror = await seedMirror(false);
    const rendered = await toApiRepositoryFull(env.DB, anonymous, mirror);
    expect(rendered.mirror).toBe(true);
    expect(rendered.mirror_interval).toBe("");
    expect(rendered.mirror_updated).toBe(GO_ZERO_TIME);
    expect(rendered.mirror_last_sync_at).toBe(GO_ZERO_TIME);
  });

  it("the sync converter (list shape) renders the booleans honestly, schedule at the zero-defaults", async () => {
    const mirror = await seedMirror(true);
    const rendered = toApiRepository(anonymous, mirror);
    expect(rendered.mirror).toBe(true);
    expect(rendered.mirror_interval).toBe("");
    expect(rendered.mirror_updated).toBe(GO_ZERO_TIME);
  });
});

describe("toApiRepository — plain repos and the sync fork boolean", () => {
  it("a plain repo renders fork:false / mirror:false with parent absent", async () => {
    const owner = await seedVerifiedUser({ username: "PlainOwner" });
    await seedRepo(owner.id, "plainowner", "plain", "public");
    const plain = await findRepositoryByPath(env.DB, "plainowner", "plain");
    if (plain === null) throw new Error("fixture repo missing");
    const rendered = toApiRepository(viewerFor(owner), plain);
    expect(rendered.fork).toBe(false);
    expect(rendered.mirror).toBe(false);
    expect("parent" in rendered).toBe(false);
  });

  it("the sync converter still marks a fork fork:true — only the parent arm is async", async () => {
    const { fork } = await seedForkFixture();
    const rendered = toApiRepository(anonymous, fork);
    expect(rendered.fork).toBe(true);
    expect("parent" in rendered).toBe(false);
  });
});

describe("/repos/search mode arms over the landed fork/mirror columns", () => {
  it("mode=fork / mode=mirror / mode=source filter their columns; collaborative stays empty", async () => {
    const owner = await seedVerifiedUser({ username: "SearchOwner" });
    const baseId = await seedRepo(owner.id, "searchowner", "base", "public");
    await seedRepo(owner.id, "searchowner", "plain", "public");
    await seedRepo(owner.id, "searchowner", "forkling", "public", { forkParent: baseId });
    await seedRepo(owner.id, "searchowner", "copycat", "public", { isMirror: true });

    const forkMode = await searchRepositories(env.DB, anonymous, { ...searchOpts, mode: "fork" });
    expect(forkMode.total).toBe(1);
    expect(forkMode.items.map((p) => p.repo.slug)).toEqual(["forkling"]);

    const mirrorMode = await searchRepositories(env.DB, anonymous, { ...searchOpts, mode: "mirror" });
    expect(mirrorMode.total).toBe(1);
    expect(mirrorMode.items.map((p) => p.repo.slug)).toEqual(["copycat"]);

    // source = is_fork false AND is_mirror false — the base and the plain one.
    const sourceMode = await searchRepositories(env.DB, anonymous, { ...searchOpts, mode: "source" });
    expect(sourceMode.total).toBe(2);
    expect(sourceMode.items.map((p) => p.repo.slug).sort()).toEqual(["base", "plain"]);

    const collaborative = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      mode: "collaborative",
    });
    expect(collaborative.total).toBe(0);
  });
});

describe("/repos/search template/archived arms over the landed columns", () => {
  it("template tri-state: true matches only is_template rows, false excludes them, null all (repo.go:155-157 → repo_list.go:391-393)", async () => {
    const owner = await seedVerifiedUser({ username: "TplOwner" });
    await seedRepo(owner.id, "tplowner", "normal", "public");
    await seedRepo(owner.id, "tplowner", "templated", "public", { isTemplate: true });

    const tplTrue = await searchRepositories(env.DB, anonymous, { ...searchOpts, template: true });
    expect(tplTrue.total).toBe(1);
    expect(tplTrue.items.map((p) => p.repo.slug)).toEqual(["templated"]);

    const tplFalse = await searchRepositories(env.DB, anonymous, { ...searchOpts, template: false });
    expect(tplFalse.total).toBe(1);
    expect(tplFalse.items.map((p) => p.repo.slug)).toEqual(["normal"]);

    const tplAll = await searchRepositories(env.DB, anonymous, { ...searchOpts, template: null });
    expect(tplAll.total).toBe(2);
  });

  it("archived tri-state: true matches only is_archived rows, false excludes them, null all (repo.go:181-183 → repo_list.go:520-522)", async () => {
    const owner = await seedVerifiedUser({ username: "ArcOwner" });
    await seedRepo(owner.id, "arcowner", "live", "public");
    await seedRepo(owner.id, "arcowner", "frozen", "public", { isArchived: true });

    const arcTrue = await searchRepositories(env.DB, anonymous, { ...searchOpts, archived: true });
    expect(arcTrue.total).toBe(1);
    expect(arcTrue.items.map((p) => p.repo.slug)).toEqual(["frozen"]);

    const arcFalse = await searchRepositories(env.DB, anonymous, { ...searchOpts, archived: false });
    expect(arcFalse.total).toBe(1);
    expect(arcFalse.items.map((p) => p.repo.slug)).toEqual(["live"]);

    // Both filters compose (independent AND arms, upstream builder.And).
    const composed = await searchRepositories(env.DB, anonymous, {
      ...searchOpts,
      archived: false,
      template: false,
    });
    expect(composed.total).toBe(1);
    expect(composed.items.map((p) => p.repo.slug)).toEqual(["live"]);

    const arcAll = await searchRepositories(env.DB, anonymous, { ...searchOpts, archived: null });
    expect(arcAll.total).toBe(2);
  });
});

describe("toApiRepository — original_url (convert/repository.go:215, SanitizedOriginalURL)", () => {
  it("a null column renders \"\" (the empty-string arm, repo.go:229-231) — plain repos", async () => {
    const owner = await seedVerifiedUser({ username: "PlainOwner" });
    await seedRepo(owner.id, "plainowner", "plain", "public");
    const plain = await findRepositoryByPath(env.DB, "plainowner", "plain");
    if (plain === null) throw new Error("fixture repo missing");
    expect(toApiRepository(anonymous, plain).original_url).toBe("");
  });

  it("userinfo is stripped at render time (repo.go:232 → util/url.go:21-28) and the stored value survives intact", async () => {
    const owner = await seedVerifiedUser({ username: "CredOwner" });
    await seedRepo(owner.id, "credowner", "cred", "public", {
      originalUrl: "https://user:secret@example.invalid/repo.git",
    });
    const cred = await findRepositoryByPath(env.DB, "credowner", "cred");
    if (cred === null) throw new Error("fixture repo missing");
    // The credential NEVER reaches the wire (the same §4.2 rule the mirror
    // suite pins) — SanitizedOriginalURL drops u.User before re-serializing.
    expect(toApiRepository(anonymous, cred).original_url).toBe(
      "https://example.invalid/repo.git",
    );
    // Idempotent over the already-sanitized values our stores write
    // (services/migrate.ts / services/mirror.ts `source.sanitized`): a second
    // pass over the stripped URL is a no-op.
    expect(sanitizedOriginalUrl("https://example.invalid/repo.git")).toBe(
      "https://example.invalid/repo.git",
    );
    expect(sanitizedOriginalUrl(toApiRepository(anonymous, cred).original_url)).toBe(
      "https://example.invalid/repo.git",
    );
  });

  it("an unparseable value degrades to \"\" (Go's swallowed parse error → nil URL, repo.go:232-233)", async () => {
    const owner = await seedVerifiedUser({ username: "RawOwner" });
    await seedRepo(owner.id, "rawowner", "scp", "public", {
      originalUrl: "git@host:owner/repo.git",
    });
    const scp = await findRepositoryByPath(env.DB, "rawowner", "scp");
    if (scp === null) throw new Error("fixture repo missing");
    expect(toApiRepository(anonymous, scp).original_url).toBe("");
  });

  it("the mirror fixture's original_url renders from the row — NOT mirror-gated but honest for mirrors too", async () => {
    const owner = await seedVerifiedUser({ username: "MirrorOwner" });
    await seedRepo(owner.id, "mirrorowner", "upstream", "public", {
      isMirror: true,
      originalUrl: "https://src.example.invalid/upstream.git",
    });
    const mirror = await findRepositoryByPath(env.DB, "mirrorowner", "upstream");
    if (mirror === null) throw new Error("fixture repo missing");
    // Upstream renders the field for ANY repo with a non-empty column
    // (convert/repository.go:215 has no IsMirror arm; migrations set it at
    // create for plain imports too — services/repository/create.go:236).
    expect(toApiRepository(anonymous, mirror).original_url).toBe(
      "https://src.example.invalid/upstream.git",
    );
    expect((await toApiRepositoryFull(env.DB, anonymous, mirror)).original_url).toBe(
      "https://src.example.invalid/upstream.git",
    );
  });
});
