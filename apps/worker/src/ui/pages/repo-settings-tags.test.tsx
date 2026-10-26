/**
 * The repo settings protected-tags panel's tests (the bench-row UNMOUNTED
 * module — the repo-settings-wiki.test.tsx harness): the create/edit/delete
 * arms re-played over real D1 (generated migrations in beforeAll; the same
 * service primitives routes/tag-protections.ts's handlers use) with the
 * exact ApiError texts surfacing as `invalid` re-render lines, and the DOM
 * contract of the single list+form page (tags.tmpl) — hono/jsx
 * renderToString, the module driven directly (no route yet, the HANDOFF
 * NOTE in the module header).
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import type { RepositoryWithOwner } from "../../api/services/repository";
import { protectedTags, repositories, teams, users } from "../../db/schema";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  applyTagProtectionForm,
  deleteTagRuleById,
  editFormOfTag,
  emptyTagProtectionForm,
  loadProtectedTagRules,
  loadTagRuleById,
  parseTagProtectionForm,
  renderTagProtectionPage,
  tagProtectionLocale,
  TagProtectionPage,
  type TagProtectionForm,
  type TagProtectionPageData,
} from "./repo-settings-tags";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const selfViewer: Viewer = { kind: "user", id: 4, username: "alice", isAdmin: false };

/** The render context with the seeded repo row plugged in (set by
 *  seedRepo). */
const ctx: UiContext = {
  viewer: selfViewer,
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

let repo: RepoRow;

beforeAll(async () => {
  await applyAuthD1Migrations();
});

let repoSeq = 9100;

beforeEach(async () => {
  for (const table of ["protected_tags", "team_members", "teams", "repositories", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  repoSeq = 9100; // stable slugs for the DOM assertions
  // alice owns the user repo; acme (an org) owns the org repo; bob is a
  // plain user; carol carries a display name (the GetDisplayName render).
  for (const [id, username, displayName, type] of [
    [2, "bob", null, "user"],
    [4, "alice", null, "user"],
    [5, "carol", "Carol Display", "user"],
    [20, "acme", null, "org"],
  ] as const) {
    await env.DB.prepare("INSERT INTO users (id, username, username_lower, display_name, status, type, created_at) VALUES (?, ?, ?, ?, 'active', ?, 0)")
      .bind(id, username, username, displayName, type)
      .run();
  }
  repo = await seedRepo({ orgOwned: false });
});

const db = () => drizzle(env.DB);

async function seedRepo(options: { orgOwned?: boolean; archived?: boolean } = {}): Promise<RepoRow> {
  const repoId = String(repoSeq++);
  await db().insert(repositories).values({
    id: repoId,
    storageKey: `r_${repoId}`,
    ownerNamespace: options.orgOwned === true ? "acme" : "alice",
    ownerId: options.orgOwned === true ? 20 : 4,
    slug: `tagui${repoId}`,
    visibility: "public",
    isArchived: options.archived === true,
    refsVersion: 1,
    backend: "self-hosted",
    createdAt: new Date("2026-02-03T04:05:06Z"),
  });
  const row = await db().select().from(repositories).where(eq(repositories.id, repoId)).get();
  if (row === undefined) throw new Error("fixture repository missing");
  return row;
}

/** The org's team (no membership needed — the settings arms never test
 *  push authorization). */
async function seedTeam(name = "devs"): Promise<number> {
  const inserted = await db()
    .insert(teams)
    .values({ orgId: 20, lowerName: name, name, authorize: "write" })
    .returning({ id: teams.id })
    .all();
  return inserted[0]!.id;
}

/** Insert a rule directly (the raw store shape the loaders render). */
async function seedRule(repoId: string, namePattern: string, userIds: number[] = [], teamIds: number[] = []): Promise<number> {
  const inserted = await db()
    .insert(protectedTags)
    .values({
      repoId,
      namePattern,
      allowlistUserIds: JSON.stringify(userIds),
      allowlistTeamIds: JSON.stringify(teamIds),
      createdAt: new Date("2026-02-03T04:05:06Z"),
      updatedAt: new Date("2026-02-03T04:05:06Z"),
    })
    .returning({ id: protectedTags.id })
    .all();
  return inserted[0]!.id;
}

/** The RepositoryWithOwner pair for a seeded repo — the owner row loaded
 *  for real (the arms read owner.type/owner.id off the full UserRow). */
async function pair(repoRow: RepoRow = repo): Promise<RepositoryWithOwner> {
  const owner = await db().select().from(users).where(eq(users.id, repoRow.ownerId!)).get();
  if (owner === undefined) throw new Error("fixture owner missing");
  return { repo: repoRow, owner };
}

function form(overrides: Partial<TagProtectionForm> = {}): TagProtectionForm {
  return { ...emptyTagProtectionForm(), ...overrides };
}

async function storedRow(repoId: string): Promise<{ namePattern: string; users: number[]; teams: number[] }> {
  const raw = await db().select().from(protectedTags).where(eq(protectedTags.repoId, repoId)).all();
  const row = raw[0]!;
  return { namePattern: row.namePattern, users: JSON.parse(row.allowlistUserIds) as number[], teams: JSON.parse(row.allowlistTeamIds) as number[] };
}

/** The page component under a ctx carrying the seeded repo. */
function PageForTest(props: { data?: Partial<TagProtectionPageData>; error?: string | null }) {
  const data: TagProtectionPageData = {
    rules: props.data?.rules ?? [],
    isOrg: props.data?.isOrg ?? false,
    form: props.data?.form ?? emptyTagProtectionForm(),
    editing: props.data?.editing ?? null,
    saved: props.data?.saved ?? false,
  };
  return <TagProtectionPage ctx={{ ...ctx, repo }} data={data} error={props.error ?? null} />;
}

// --- the loader ---------------------------------------------------------------

describe("loadProtectedTagRules (the landed listProtectedTags read + the label render)", () => {
  it("returns an empty list for a repo without rules", async () => {
    expect(await loadProtectedTagRules(env.DB, repo)).toEqual([]);
  });

  it("renders ids to display names in id order; the display name falls back to the username", async () => {
    await seedRule(repo.id, "v*", [5, 2]); // carol (display name) + bob
    const rules = await loadProtectedTagRules(env.DB, repo);
    expect(rules).toHaveLength(1);
    expect(rules[0]!.row.namePattern).toBe("v*");
    expect(rules[0]!.users.map((user) => user.displayName)).toEqual(["Carol Display", "bob"]); // id order
    expect(rules[0]!.users.map((user) => user.homeLink)).toEqual(["/carol", "/bob"]);
  });

  it("renders vanished principals as nothing (the API render's documented nuance)", async () => {
    await seedRule(repo.id, "v*", [999], [998]);
    const rules = await loadProtectedTagRules(env.DB, repo);
    expect(rules[0]!.users).toEqual([]);
    expect(rules[0]!.teams).toEqual([]);
  });

  it("renders team labels ONLY on an org-owned repo (upstream's $.Teams gate), through the OrganisationLink", async () => {
    const teamId = await seedTeam("devs");
    // The user repo: team ids render as nothing — setTagsContext never
    // populates $.Teams for an individual owner.
    await seedRule(repo.id, "v*", [], [teamId]);
    const userRules = await loadProtectedTagRules(env.DB, repo);
    expect(userRules[0]!.teams).toEqual([]);
    expect(userRules[0]!.users).toEqual([]);

    const orgRepo = await seedRepo({ orgOwned: true });
    await seedRule(orgRepo.id, "v*", [], [teamId]);
    const orgRules = await loadProtectedTagRules(env.DB, orgRepo);
    expect(orgRules[0]!.teams).toEqual([{ id: teamId, name: "devs", teamLink: "/org/acme/teams/devs" }]);
  });

  it("orders the rows by id (the insertion order the renders echo — NO priority arm)", async () => {
    const second = await seedRule(repo.id, "b-*");
    const first = await seedRule(repo.id, "a-*");
    const rules = await loadProtectedTagRules(env.DB, repo);
    expect(rules.map((item) => item.row.id)).toEqual([second, first]); // asc(id), not alphabetical
  });
});

// --- loadTagRuleById ------------------------------------------------------------

describe("loadTagRuleById (selectProtectedTagByContext's repo guard)", () => {
  it("loads a repo-scoped row", async () => {
    const id = await seedRule(repo.id, "v*");
    expect((await loadTagRuleById(env.DB, repo.id, id))?.namePattern).toBe("v*");
  });

  it("a foreign-repo id reads null (the same null as a miss — the plain 404 shell)", async () => {
    const other = await seedRepo({ orgOwned: true });
    const id = await seedRule(other.id, "v*");
    expect(await loadTagRuleById(env.DB, repo.id, id)).toBeNull();
    expect(await loadTagRuleById(env.DB, repo.id, 424242)).toBeNull();
  });
});

// --- the form parse -------------------------------------------------------------

describe("parseTagProtectionForm (tags.tmpl's input names verbatim)", () => {
  it("parses the three fields and a decimal id", () => {
    const parsed = parseTagProtectionForm(new URLSearchParams({ id: "7", name_pattern: "v*", allowlist_users: "alice,bob", allowlist_teams: "devs" }));
    expect(parsed).toEqual({ id: 7, namePattern: "v*", allowlistUsers: "alice,bob", allowlistTeams: "devs" });
  });

  it("absent fields decode as the Go zeros (id 0, empty strings)", () => {
    expect(parseTagProtectionForm(new URLSearchParams())).toEqual(emptyTagProtectionForm());
  });

  it("a junk id reads as 0 (create)", () => {
    expect(parseTagProtectionForm(new URLSearchParams({ id: "abc" })).id).toBe(0);
  });
});

// --- the create arm -------------------------------------------------------------

describe("applyTagProtectionForm create (routes/tag-protections.ts's POST body re-played)", () => {
  it("creates with the trimmed pattern and resolved user ids", async () => {
    const result = await applyTagProtectionForm(env.DB, await pair(), form({ namePattern: "  v*  ", allowlistUsers: "bob,carol" }));
    expect(result).toEqual({ outcome: "created" });
    const stored = await storedRow(repo.id);
    expect(stored.namePattern).toBe("v*");
    expect(stored.users).toEqual([2, 5]);
    expect(stored.teams).toEqual([]);
  });

  it("the empty-pattern 400 with the exact upstream text (the grammatical quirk)", async () => {
    const result = await applyTagProtectionForm(env.DB, await pair(), form({ namePattern: "   " }));
    expect(result).toEqual({ outcome: "invalid", message: "name_pattern are empty" });
  });

  it("the both-empty 400 on the RAW lists (the exact upstream text)", async () => {
    const result = await applyTagProtectionForm(env.DB, await pair(), form({ namePattern: "v*", allowlistUsers: " , " }));
    expect(result).toEqual({ outcome: "invalid", message: "both whitelist_usernames and whitelist_teams are empty" });
  });

  it("the 403 collision on the EXACT trimmed pattern", async () => {
    await seedRule(repo.id, "v*");
    const result = await applyTagProtectionForm(env.DB, await pair(), form({ namePattern: " v* ", allowlistUsers: "bob" }));
    expect(result).toEqual({ outcome: "invalid", message: "Tag protection already exist" });
  });

  it("an unknown user 422s with the LOWERCASED name in the exact text", async () => {
    const result = await applyTagProtectionForm(env.DB, await pair(), form({ namePattern: "v*", allowlistUsers: "NOBODY" }));
    expect(result).toEqual({ outcome: "invalid", message: "user does not exist [uid: 0, name: nobody]" });
  });

  it("an ORG does not resolve (the tag family's ne(type,'org') — no pseudo-principals either)", async () => {
    const result = await applyTagProtectionForm(env.DB, await pair(), form({ namePattern: "v*", allowlistUsers: "acme" }));
    expect(result).toEqual({ outcome: "invalid", message: "user does not exist [uid: 0, name: acme]" });
  });

  it("a user repo silently drops teams (the raw check passed, no error)", async () => {
    await seedTeam("devs");
    const result = await applyTagProtectionForm(env.DB, await pair(), form({ namePattern: "v*", allowlistTeams: "devs" }));
    expect(result).toEqual({ outcome: "created" });
    expect(await storedRow(repo.id)).toMatchObject({ users: [], teams: [] });
  });

  it("an org repo resolves the teams to ids", async () => {
    const orgRepo = await seedRepo({ orgOwned: true });
    const teamId = await seedTeam("devs");
    const result = await applyTagProtectionForm(env.DB, await pair(orgRepo), form({ namePattern: "v*", allowlistTeams: "devs" }));
    expect(result).toEqual({ outcome: "created" });
    expect(await storedRow(orgRepo.id)).toMatchObject({ teams: [teamId] });
  });

  it("an unknown team 422s with the exact org-scoped text", async () => {
    const orgRepo = await seedRepo({ orgOwned: true });
    const result = await applyTagProtectionForm(env.DB, await pair(orgRepo), form({ namePattern: "v*", allowlistTeams: "ghosts" }));
    expect(result).toEqual({ outcome: "invalid", message: "team does not exist [org_id 20, team_id 0, name: ghosts]" });
  });
});

// --- the edit arm ---------------------------------------------------------------

describe("applyTagProtectionForm edit (routes/tag-protections.ts's PATCH body re-played)", () => {
  it("replaces the pattern VERBATIM (no trim — the pointer arm) and the arrays", async () => {
    const id = await seedRule(repo.id, "v*", [2]);
    const result = await applyTagProtectionForm(env.DB, await pair(), form({ id, namePattern: " v1.* ", allowlistUsers: "carol" }));
    expect(result).toEqual({ outcome: "saved" });
    expect(await storedRow(repo.id)).toMatchObject({ namePattern: " v1.* ", users: [5] });
  });

  it("a missing or foreign id reads missing (the 404 shell)", async () => {
    expect(await applyTagProtectionForm(env.DB, await pair(), form({ id: 424242, namePattern: "v*", allowlistUsers: "bob" }))).toEqual({ outcome: "missing" });
    const other = await seedRepo({ orgOwned: true });
    const foreignId = await seedRule(other.id, "v*", [2]);
    expect(await applyTagProtectionForm(env.DB, await pair(), form({ id: foreignId, namePattern: "v*", allowlistUsers: "bob" }))).toEqual({ outcome: "missing" });
  });

  it("teams resolve BEFORE usernames (a both-invalid body 422s on the team name)", async () => {
    const orgRepo = await seedRepo({ orgOwned: true });
    const id = await seedRule(orgRepo.id, "v*");
    const result = await applyTagProtectionForm(env.DB, await pair(orgRepo), form({ id, namePattern: "v2", allowlistTeams: "ghosts", allowlistUsers: "nobody" }));
    expect(result).toEqual({ outcome: "invalid", message: "team does not exist [org_id 20, team_id 0, name: ghosts]" });
  });

  it("a user repo's submitted teams silently replace with []", async () => {
    await seedTeam("devs"); // the team EXISTS — the user-repo arm just never resolves it
    const id = await seedRule(repo.id, "v*", [], [777]); // stored team ids (direct-write fixture)
    const result = await applyTagProtectionForm(env.DB, await pair(), form({ id, namePattern: "v*", allowlistTeams: "devs", allowlistUsers: "bob" }));
    expect(result).toEqual({ outcome: "saved" });
    expect(await storedRow(repo.id)).toMatchObject({ users: [2], teams: [] });
  });

  it("an edit may clear both lists to the No-One rule (no 400s on the edit arm)", async () => {
    const id = await seedRule(repo.id, "v*", [2]);
    const result = await applyTagProtectionForm(env.DB, await pair(), form({ id, namePattern: "v*", allowlistUsers: "" }));
    expect(result).toEqual({ outcome: "saved" });
    expect(await storedRow(repo.id)).toMatchObject({ users: [], teams: [] });
  });

  it("NO collision check on edit (the arm has none) — another rule may take the exact pattern", async () => {
    await seedRule(repo.id, "v*", [2]);
    const other = await seedRule(repo.id, "release-*", [2]);
    const result = await applyTagProtectionForm(env.DB, await pair(), form({ id: other, namePattern: "v*", allowlistUsers: "bob" }));
    expect(result).toEqual({ outcome: "saved" });
    const rows = await db().select().from(protectedTags).where(eq(protectedTags.repoId, repo.id)).all();
    expect(rows.filter((row) => row.namePattern === "v*")).toHaveLength(2);
  });

  it("an unknown user still 422s the whole edit (nothing wrote)", async () => {
    const id = await seedRule(repo.id, "v*", [2]);
    const result = await applyTagProtectionForm(env.DB, await pair(), form({ id, namePattern: "v2", allowlistUsers: "ghost" }));
    expect(result).toEqual({ outcome: "invalid", message: "user does not exist [uid: 0, name: ghost]" });
    expect((await storedRow(repo.id)).namePattern).toBe("v*"); // the stored row kept
  });
});

// --- editFormOfTag ---------------------------------------------------------------

describe("editFormOfTag (the stored row as the edit form's binding)", () => {
  it("joins the ids to names; vanished ids render as nothing", async () => {
    const id = await seedRule(repo.id, "v*", [2, 999]);
    const bound = await editFormOfTag(env.DB, (await loadTagRuleById(env.DB, repo.id, id))!);
    expect(bound).toEqual({ id, namePattern: "v*", allowlistUsers: "bob", allowlistTeams: "" });
  });
});

// --- the delete arm ---------------------------------------------------------------

describe("deleteTagRuleById (the DELETE body's repo guard + row delete)", () => {
  it("deletes the repo-scoped row", async () => {
    const id = await seedRule(repo.id, "v*");
    expect(await deleteTagRuleById(env.DB, await pair(), id)).toBe(true);
    expect(await db().select().from(protectedTags).where(eq(protectedTags.id, id)).all()).toHaveLength(0);
  });

  it("a missing or foreign id reads false (the 404 shell)", async () => {
    expect(await deleteTagRuleById(env.DB, await pair(), 424242)).toBe(false);
    const other = await seedRepo({ orgOwned: true });
    const foreignId = await seedRule(other.id, "v*");
    expect(await deleteTagRuleById(env.DB, await pair(), foreignId)).toBe(false);
    expect(await db().select().from(protectedTags).where(eq(protectedTags.id, foreignId)).all()).toHaveLength(1);
  });
});

// --- the DOM --------------------------------------------------------------------

describe("the protected-tags panel DOM (tags.tmpl at the pin)", () => {
  it("renders the create page: discriminator, form action, fields, Protect Tag button", () => {
    const html = renderToString(<PageForTest />);
    expect(html).toContain("repository settings edit"); // the §2.4.1 discriminator (shared with the branches list page)
    expect(html).toContain('action="/alice/tagui9100/settings/tags"');
    expect(html).toContain('method="post"');
    expect(html).toContain('id="name_pattern" name="name_pattern" type="text" autocomplete="off" value="" placeholder="v*"');
    expect(html).toContain(`>${tagProtectionLocale.pattern_help}</div>`);
    expect(html).toContain('id="allowlist_users" name="allowlist_users" type="text"');
    expect(html).toContain(`>${tagProtectionLocale.create}</button>`);
    expect(html).not.toContain(`>${tagProtectionLocale.save}</button>`); // the create mode has no Save/Cancel pair
    // The full-document render path matches the component path.
    expect(
      renderTagProtectionPage({ ctx: { ...ctx, repo }, data: { rules: [], isOrg: false, form: emptyTagProtectionForm(), editing: null, saved: false }, error: null }),
    ).toContain('action="/alice/tagui9100/settings/tags"');
  });

  it("renders the team field on an org-owned repo only", () => {
    expect(renderToString(<PageForTest data={{ isOrg: true }} />)).toContain('id="allowlist_teams" name="allowlist_teams"');
    expect(renderToString(<PageForTest data={{ isOrg: false }} />)).not.toContain('name="allowlist_teams"');
  });

  it("renders the rules table: pre pattern cell, No-One cell, user label, edit anchor, delete form", async () => {
    const id = await seedRule(repo.id, "v*", [5]);
    await seedRule(repo.id, "release-*"); // the No-One row
    const rules = await loadProtectedTagRules(env.DB, repo);
    const html = renderToString(<PageForTest data={{ rules }} />);
    expect(html).toContain('<table class="ui single line table">');
    expect(html).toContain("<pre>v*</pre>");
    expect(html).toContain("<pre>release-*</pre>");
    expect(html).toContain('class="ui basic label" href="/carol">Carol Display</a>');
    expect(html).toContain(`>${tagProtectionLocale.noone}</td>`);
    expect(html).toContain(`href="/alice/tagui9100/settings/tags/${id}">${tagProtectionLocale.edit}</a>`);
    expect(html).toContain('action="/alice/tagui9100/settings/tags/delete"');
    expect(html).toContain(`name="id" value="${String(id)}"`);
    expect(html).toContain(`>${tagProtectionLocale.remove}</button>`);
    expect(html).not.toContain(tagProtectionLocale.none); // rows exist
  });

  it("renders the empty-state row (colspan 3) when no rules exist", () => {
    const html = renderToString(<PageForTest />);
    expect(html).toContain(`colspan="3">${tagProtectionLocale.none}</td>`);
  });

  it("renders the team label link on an org-owned repo's table (the OrganisationLink shape)", async () => {
    const orgRepo = await seedRepo({ orgOwned: true });
    const teamId = await seedTeam("devs");
    await seedRule(orgRepo.id, "v*", [], [teamId]);
    const rules = await loadProtectedTagRules(env.DB, orgRepo);
    const html = renderToString(<TagProtectionPage ctx={{ ...ctx, repo: orgRepo }} data={{ rules, isOrg: true, form: emptyTagProtectionForm(), editing: null, saved: false }} error={null} />);
    expect(html).toContain('class="ui basic label" href="/org/acme/teams/devs">devs</a>');
  });

  it("renders the edit mode: the id-keyed action, filled values, Save + Cancel", async () => {
    const id = await seedRule(repo.id, "v*", [2]);
    const row = (await loadTagRuleById(env.DB, repo.id, id))!;
    const bound = await editFormOfTag(env.DB, row);
    const html = renderToString(<PageForTest data={{ form: bound, editing: row }} />);
    expect(html).toContain(`action="/alice/tagui9100/settings/tags/${id}"`);
    expect(html).toContain('value="v*"');
    expect(html).toContain('value="bob"');
    expect(html).toContain(`>${tagProtectionLocale.save}</button>`);
    expect(html).toContain(`href="/alice/tagui9100/settings/tags">${tagProtectionLocale.cancel}</a>`);
    expect(html).not.toContain(`>${tagProtectionLocale.create}</button>`);
  });

  it("the error slot renders the service's exact ApiError text as a negative message", () => {
    const html = renderToString(<PageForTest error="name_pattern are empty" />);
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain("name_pattern are empty");
  });

  it("the ?saved=1 flash renders the upstream success text as an info message", () => {
    const html = renderToString(<PageForTest data={{ saved: true }} />);
    expect(html).toContain('class="ui info message"');
    expect(html).toContain(tagProtectionLocale.update_settings_success);
  });

  it("an archived repo renders the warning INSTEAD of the form and the table", () => {
    const archivedCtx = { ...ctx, repo: { ...repo, isArchived: true } };
    const html = renderToString(
      <TagProtectionPage ctx={archivedCtx} data={{ rules: [], isOrg: false, form: emptyTagProtectionForm(), editing: null, saved: false }} error={null} />,
    );
    expect(html).toContain(tagProtectionLocale.archived_unavailable);
    expect(html).not.toContain('name="name_pattern"');
    expect(html).not.toContain("single line table");
  });

  it("the nav scaffold renders the reduced menu with Tags active between Branches and Mirror", () => {
    const html = renderToString(<PageForTest />);
    expect(html).toContain('class="flex-container-nav"');
    expect(html).toContain('href="/alice/tagui9100/settings/branches"');
    expect(html).toContain('class="active item" href="/alice/tagui9100/settings/tags"');
    expect(html).toContain('href="/alice/tagui9100/settings/mirror"');
  });

  it("throws without a resolved repo (the settings pages' ctx.repo contract)", () => {
    expect(() =>
      renderToString(<TagProtectionPage ctx={ctx} data={{ rules: [], isOrg: false, form: emptyTagProtectionForm(), editing: null, saved: false }} error={null} />),
    ).toThrow("TagProtectionPage requires ctx.repo");
  });
});
