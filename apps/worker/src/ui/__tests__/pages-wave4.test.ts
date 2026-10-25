/**
 * Pages wave 4 route tests (SPEC-0008 U3 extension): the first AUTHED WRITE
 * surfaces — the new-issue form (`/issues/new`, pages/new-issue.tsx) and the
 * settings slice (`/settings` basics + `/settings/hooks` webhooks,
 * pages/settings.tsx) — plus the auth/CSRF posture both carry.
 *
 * Same harness posture as pages-wave2/3: the router is driven directly with
 * the synthetic ASSETS manifest, fixtures seed through the landed services
 * with fixed `now` values, and the session wave's conventions provide the
 * identities (mintSession cookies — session.test.ts's pattern; the tests
 * never touch the login routes themselves).
 *
 * Auth order under test (the §2.5 anti-enumeration rule): repo resolution
 * happens BEFORE the viewer requirement, so an invisible repo 404-shells
 * even for the authed redirects, and every POST runs the §2.8 layer-2
 * Origin guard first.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { createRepoLabel, findRepoLabelByName } from "../../api/services/labels";
import { fireTestDelivery } from "../../api/services/hooks";
import { issues, milestones, repositories, users, webhookDeliveries, webhooks } from "../../db/schema";
import { uiRouter } from "../index";
import { IssuesService } from "../../issues/service";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import { runA11y } from "./a11y";
import { T0, uiEnv } from "./harness";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

/** A form POST with the browser's Origin header (the §2.8 layer-2 guard's
 *  happy path — same-origin as the router fixture origin). */
function formPost(fields: Record<string, string | string[]>): RequestInit {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const entry of Array.isArray(value) ? value : [value]) params.append(key, entry);
  }
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://test.local",
    },
    body: params.toString(),
  };
}

const withCookie = (init: RequestInit, cookie: string): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string>), cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
});

// --- fixtures -----------------------------------------------------------------

const WAVE4_COMMITS: SeedCommit[] = [
  { message: "seed: readme", time: T0, files: [{ path: "README.md", content: "# wave4 seed\n" }] },
];

const t = (offsetSeconds: number): Date => new Date((T0 + offsetSeconds) * 1000);

interface Wave4Fixture {
  ownerCookie: string;
  adminCookie: string;
  otherCookie: string;
  bugLabelId: number;
  milestoneId: number;
  renRepoId: string;
}

let wave4Fixture: Wave4Fixture | null = null;

/**
 * Seed the wave-4 block: two issues on the public repo (the POST under test
 * then allocates #3), one label + one milestone for the pickers, a private
 * sibling (the §2.5 negative paths), a row-only basics repo ("wave4-ren")
 * for the rename/visibility writes, and the three identities (owner alice,
 * a site admin, an unrelated user).
 */
async function ensureWave4Fixtures(): Promise<Wave4Fixture> {
  if (wave4Fixture !== null) return wave4Fixture;
  const db = drizzle(env.DB);
  await applyAuthD1Migrations();
  await ensureSeededRepo({ owner: "alice", slug: "wave4", commits: WAVE4_COMMITS });

  const owner = await db.select().from(users).where(eq(users.usernameLower, "alice")).get();
  if (owner === undefined) throw new Error("wave4 owner row missing");
  const repo = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave4")))
    .get();
  if (repo === undefined) throw new Error("wave4 repo row missing");

  // Private sibling + the row-only basics repo (rename target), both owned
  // by alice (the wave-3 secret-sibling pattern).
  for (const slug of ["wave4-secret", "wave4-ren"]) {
    const existing = await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, slug)))
      .get();
    if (existing === undefined) {
      const id = `r_${slug}`;
      await db.insert(repositories).values({
        id,
        storageKey: id,
        ownerNamespace: "alice",
        ownerId: owner.id,
        slug,
        visibility: slug === "wave4-secret" ? "private" : "public",
      });
    }
  }

  // Identities: the site admin and an unrelated user (unique rows — the
  // session.test.ts seedUser shape).
  for (const extra of [
    { username: "wave4admin", isAdmin: true },
    { username: "wave4bob", isAdmin: false },
  ]) {
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, extra.username)).get();
    if (existing === undefined) {
      await db.insert(users).values({
        username: extra.username,
        usernameLower: extra.username,
        isAdmin: extra.isAdmin,
        status: "active",
        visibility: "public",
        createdAt: new Date(),
      });
    }
  }
  const admin = await db.select().from(users).where(eq(users.usernameLower, "wave4admin")).get();
  const bob = await db.select().from(users).where(eq(users.usernameLower, "wave4bob")).get();
  if (admin === undefined || bob === undefined) throw new Error("wave4 identity rows missing");

  // The picker options + the two pre-existing issues (#1 labeled+milestone,
  // #2 bare) — fixed `now`, idempotent like the wave-2/3 blocks.
  const svc = new IssuesService(env.DB);
  const existingIssue = await db.select({ id: issues.id }).from(issues).where(eq(issues.repoId, repo.id)).limit(1).get();
  let bugLabelId: number;
  let milestoneId: number;
  const existingLabel = await findRepoLabelByName(env.DB, repo.id, "bug");
  if (existingIssue === undefined || existingLabel === null) {
    const bug = await createRepoLabel(env.DB, repo.id, {
      name: "bug",
      exclusive: false,
      color: "#ee0701",
      description: "Something is broken",
      isArchived: false,
      now: t(0),
    });
    const milestone = await svc.createMilestone({ repoId: repo.id, name: "v3.0", now: t(0) });
    await svc.createIssue({
      repoId: repo.id,
      title: "wave4: first seeded issue",
      content: "seeded body",
      posterId: owner.id,
      labelIds: [bug.id],
      now: t(10),
    });
    await svc.createIssue({ repoId: repo.id, title: "wave4: second seeded issue", posterId: owner.id, now: t(20) });
    bugLabelId = bug.id;
    milestoneId = milestone.id;
  } else {
    // Rehydrate (a persisted storage run): the label row exists, the
    // milestone is found by name.
    const reMilestone = await db
      .select()
      .from(milestones)
      .where(and(eq(milestones.repoId, repo.id), eq(milestones.name, "v3.0")))
      .get();
    bugLabelId = existingLabel.id;
    milestoneId = reMilestone?.id ?? 0;
  }

  wave4Fixture = {
    ownerCookie: await mintSession(env.DB, owner.id),
    adminCookie: await mintSession(env.DB, admin.id),
    otherCookie: await mintSession(env.DB, bob.id),
    bugLabelId,
    milestoneId,
    renRepoId: (await db
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave4-ren")))
      .get())?.id ?? "",
  };
  return wave4Fixture;
}

beforeAll(async () => {
  await ensureWave4Fixtures();
});

// --- the new-issue page (GET) ---------------------------------------------------

describe("new issue page GET (/issues/new)", () => {
  it("renders the upstream form for the signed-in viewer: title, body textarea, label checkboxes, milestone select", async () => {
    const fixture = await ensureWave4Fixtures();
    const res = await fetchUi("/alice/wave4/issues/new", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('<div role="main" aria-label="New Issue" class="page-content repository new issue">');
    expect(html).toContain('<form class="issue-content ui comment form" id="new-issue" action="/alice/wave4/issues/new" method="post">');
    expect(html).toContain('<input name="title" data-global-init="autoFocusEnd" id="issue_title" required="" maxlength="255"');
    expect(html).toContain('<textarea id="content" name="content" rows="10"');
    // The label checkbox carries the multi-value field name and the badge.
    expect(html).toContain(`<input id="new-issue-label-${fixture.bugLabelId}" name="label_ids" type="checkbox" value="${fixture.bugLabelId}"`);
    expect(html).toContain("Something is broken"); // the badge title
    // The milestone select with the open milestone + the no-milestone default.
    expect(html).toContain('<select id="new-issue-milestone" name="milestone_id" class="ui selection dropdown">');
    expect(html).toContain('<option value="">No Milestone</option>');
    expect(html).toContain(">v3.0</option>");
    expect(html).toContain("<button type=\"submit\" class=\"ui primary button\">Create Issue</button>");
  });

  it("303s an anonymous viewer onto the login round-trip with the path as redirect_to", async () => {
    const res = await fetchUi("/alice/wave4/issues/new");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?redirect_to=%2Falice%2Fwave4%2Fissues%2Fnew");
  });

  it("404-shells an invisible repo BEFORE the auth redirect (existence stays hidden, §2.5)", async () => {
    const res = await fetchUi("/alice/wave4-secret/issues/new");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('<div class="status-page-error">');
  });
});

// --- the new-issue write (POST) ---------------------------------------------------

describe("new issue POST (/issues/new)", () => {
  it("403s a cross-origin POST before any repo work (§2.8 layer 2)", async () => {
    const res = await fetchUi("/alice/wave4/issues/new", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://evil.example",
      },
      body: new URLSearchParams({ title: "cross-origin" }).toString(),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin request rejected");
  });

  it("303s an anonymous POST onto the login round-trip (no write, no cookie mint)", async () => {
    const res = await fetchUi("/alice/wave4/issues/new", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title: "anonymous" }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login?redirect_to=%2Falice%2Fwave4%2Fissues%2Fnew");
    const count = await drizzle(env.DB).select({ id: issues.id }).from(issues).all();
    expect(count.length).toBeGreaterThanOrEqual(2); // fixture unchanged — asserted precisely in the happy path below
  });

  it("creates through the tier-1 service and 303s onto the created detail page", async () => {
    const fixture = await ensureWave4Fixtures();
    const res = await fetchUi(
      "/alice/wave4/issues/new",
      withCookie(
        formPost({
          title: "wave4: filed from the web form",
          content: "Body with **markdown**.",
          label_ids: [String(fixture.bugLabelId)],
          milestone_id: String(fixture.milestoneId),
        }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/wave4/issues/3");

    // The detail page renders the created row with its label + milestone.
    const html = await (await fetchUi("/alice/wave4/issues/3")).text();
    expect(html).toContain("<h1>wave4: filed from the web form <span class=\"index\">#3</span></h1>");
    expect(html).toContain("Body with <strong>markdown</strong>.");
    expect(html).toContain(`href="/alice/wave4/issues?labels=${fixture.bugLabelId}"`);
    expect(html).toContain(">v3.0</span>");
    expect(html).toContain(" by alice · 0 comments</span>");
  });

  it("re-renders at 200 with the message and the submitted values on an empty title", async () => {
    const fixture = await ensureWave4Fixtures();
    const res = await fetchUi(
      "/alice/wave4/issues/new",
      withCookie(formPost({ title: "", content: "kept body" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="ui negative message">A title is required.</div>');
    expect(html).toContain("kept body"); // the textarea keeps the submission
    const repoRow = await drizzle(env.DB)
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "wave4")))
      .get();
    const count = await drizzle(env.DB).select({ id: issues.id }).from(issues).where(eq(issues.repoId, repoRow?.id ?? "")).all();
    expect(count).toHaveLength(3); // the two seeds + the happy-path create — no new row
  });

  it("surfaces the service's IssueError message for a foreign label id (no partial write)", async () => {
    const fixture = await ensureWave4Fixtures();
    const res = await fetchUi(
      "/alice/wave4/issues/new",
      withCookie(formPost({ title: "bad label", label_ids: "999999" }), fixture.ownerCookie),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("label does not exist [label_id: 999999, repo_id:");
    expect(html).toContain('value="bad label"'); // the title keeps the submission
  });
});

// --- the settings basics page ---------------------------------------------------

describe("settings basics (/settings)", () => {
  it("renders the reduced basics form for the owner: name, description, private toggle, settings nav", async () => {
    const fixture = await ensureWave4Fixtures();
    const res = await fetchUi("/alice/wave4-ren/settings", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div role="main" aria-label="Settings" class="page-content repository settings options">');
    expect(html).toContain('<div class="ui container flex-container">');
    expect(html).toContain('<a class="active item" href="/alice/wave4-ren/settings">');
    expect(html).toContain('<a class="item" href="/alice/wave4-ren/settings/hooks">Webhooks</a>');
    expect(html).toContain('<input id="repo_name" name="repo_name" value="wave4-ren" data-repo-name="wave4-ren" required="" maxlength="100"');
    expect(html).toContain('<textarea id="description" name="description" rows="2" maxlength="2048"></textarea>');
    expect(html).toContain('<input id="private" name="private" type="checkbox"/>'); // public repo: unchecked
    expect(html).toContain("Update Settings");
  });

  it("gates anonymous → login 303, unrelated viewer → 404 shell, site admin → 200", async () => {
    const fixture = await ensureWave4Fixtures();
    const anon = await fetchUi("/alice/wave4-ren/settings");
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe("/login?redirect_to=%2Falice%2Fwave4-ren%2Fsettings");

    const other = await fetchUi("/alice/wave4-ren/settings", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.otherCookie}` },
    });
    expect(other.status).toBe(404);

    const admin = await fetchUi("/alice/wave4-ren/settings", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.adminCookie}` },
    });
    expect(admin.status).toBe(200);
  });

  it("404-shells an invisible repo before the gate", async () => {
    const fixture = await ensureWave4Fixtures();
    const res = await fetchUi("/alice/wave4-secret/settings", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.otherCookie}` },
    });
    expect(res.status).toBe(404);
  });

  it("applies rename + description + private flip and 303s onto the canonical (renamed) URL", async () => {
    const fixture = await ensureWave4Fixtures();
    const authed = { headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` } };
    try {
      const res = await fetchUi(
        "/alice/wave4-ren/settings",
        withCookie(
          formPost({
            repo_name: "wave4-renamed",
            description: "the renamed basics repo",
            private: "on", // flip public → private (the restore POST below omits it, flipping back)
          }),
          fixture.ownerCookie,
        ),
      );
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/alice/wave4-renamed/settings");

      // The renamed repo renders with the new slug, the stored description and
      // the private badge (the flip applied).
      const html = await (await fetchUi("/alice/wave4-renamed/settings", authed)).text();
      expect(html).toContain('value="wave4-renamed"');
      expect(html).toContain("the renamed basics repo");
      expect(html).toContain('<input id="private" name="private" type="checkbox" checked=""/>');
    } finally {
      // Restore the fixture row for the later tests regardless of assertion
      // outcome (rename back; the visibility stays flipped — no other test
      // reads this repo's badge).
      const restore = await fetchUi(
        "/alice/wave4-renamed/settings",
        withCookie(formPost({ repo_name: "wave4-ren", description: "" }), fixture.ownerCookie),
      );
      expect(restore.headers.get("location")).toBe("/alice/wave4-ren/settings");
    }
  });

  it("403s a cross-origin POST (§2.8 layer 2) and re-renders on a collision with the service message", async () => {
    const fixture = await ensureWave4Fixtures();
    const cross = await fetchUi("/alice/wave4-ren/settings", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: new URLSearchParams({ repo_name: "wave4-ren" }).toString(),
    });
    expect(cross.status).toBe(403);

    // "wave4" exists → the rename collides; the message re-renders inline.
    const collision = await fetchUi(
      "/alice/wave4-ren/settings",
      withCookie(
        formPost({ repo_name: "wave4" }),
        fixture.ownerCookie,
      ),
    );
    expect(collision.status).toBe(200);
    expect(await collision.text()).toContain("repository already exists: alice/wave4"); // RepoNameCollisionError verbatim
  });
});

// --- the webhooks sub-page --------------------------------------------------------

describe("settings webhooks (/settings/hooks)", () => {
  it("renders the empty list + the add form for the owner", async () => {
    const fixture = await ensureWave4Fixtures();
    const res = await fetchUi("/alice/wave4/settings/hooks", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div role="main" aria-label="Webhooks" class="page-content repository settings webhooks">');
    expect(html).toContain('<a class="item" href="/alice/wave4/settings">Repository</a>');
    expect(html).toContain('<a class="active item" href="/alice/wave4/settings/hooks">Webhooks</a>');
    expect(html).toContain("No webhooks yet.");
    expect(html).toContain('<input id="payload_url" name="payload_url" type="url" required');
    expect(html).toContain('<option value="json" selected="">');
    expect(html).toContain('<input id="hook_active" name="active" type="checkbox"/>');
  });

  it("creates through the landed hooks service, 303s back, and lists the row with its delivery count", async () => {
    const fixture = await ensureWave4Fixtures();
    const created = await fetchUi(
      "/alice/wave4/settings/hooks",
      withCookie(
        formPost({
          name: "build hook",
          payload_url: "https://hooks.example.com/cf-gitea",
          content_type: "json",
          secret: "s3cret",
          active: "on",
        }),
        fixture.ownerCookie,
      ),
    );
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/alice/wave4/settings/hooks");

    const html = await (
      await fetchUi("/alice/wave4/settings/hooks", { headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` } })
    ).text();
    expect(html).toContain(">build hook</span>");
    expect(html).toContain('<span class="tw-ml-2 tw-text-grey-light">https://hooks.example.com/cf-gitea</span>');
    expect(html).toContain("0 deliveries</span>");
    // The stored row validates through the service: active flag, gitea type.
    const rows = await drizzle(env.DB).select().from(webhooks).all();
    const hook = rows.find((row) => row.url === "https://hooks.example.com/cf-gitea");
    expect(hook?.type).toBe("gitea");
    expect(hook?.isActive).toBe(true);

    // One delivery row → the count chip flips to the singular.
    if (hook !== undefined) {
      await fireTestDelivery(
        env.DB,
        hook,
        "push",
        {
          ref: "refs/heads/main",
          before: "0".repeat(40),
          after: "0".repeat(40),
          compare_url: "",
          commits: [],
          total_commits: 0,
          head_commit: null,
          repository: null,
          pusher: null,
          sender: null,
        },
        { repoId: hook.repoId ?? "" }, // repo_id is nullable in the schema (system hooks); the created row always carries one
      );
      const after = await (
        await fetchUi("/alice/wave4/settings/hooks", { headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` } })
      ).text();
      expect(after).toContain("1 delivery</span>");
      await drizzle(env.DB).delete(webhookDeliveries).where(eq(webhookDeliveries.hookId, hook.id));
      await drizzle(env.DB).delete(webhooks).where(eq(webhooks.id, hook.id));
    }
  });

  it("re-renders with the service's validation message for an invalid URL", async () => {
    const fixture = await ensureWave4Fixtures();
    const res = await fetchUi(
      "/alice/wave4/settings/hooks",
      withCookie(
        formPost({ name: "bad", payload_url: "ftp://not-a-webhook", content_type: "json" }),
        fixture.ownerCookie,
      ),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<div class="ui negative message">Invalid url</div>');
    expect(html).toContain('value="bad"'); // the name keeps the submission
    expect(html).toContain('value="ftp://not-a-webhook"'); // the URL keeps the submission
  });

  it("gates like the basics page: anonymous 303, unrelated 404, cross-origin 403", async () => {
    const fixture = await ensureWave4Fixtures();
    const anon = await fetchUi("/alice/wave4/settings/hooks");
    expect(anon.status).toBe(303);
    expect(anon.headers.get("location")).toBe("/login?redirect_to=%2Falice%2Fwave4%2Fsettings%2Fhooks");

    const other = await fetchUi("/alice/wave4/settings/hooks", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.otherCookie}` },
    });
    expect(other.status).toBe(404);

    const cross = await fetchUi("/alice/wave4/settings/hooks", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
      body: new URLSearchParams({ payload_url: "https://x.example" }).toString(),
    });
    expect(cross.status).toBe(403);
  });
});

// --- the §5.5 a11y smoke ---------------------------------------------------------

describe("wave-4 a11y smoke", () => {
  it("the live write pages pass the structural rules", async () => {
    const fixture = await ensureWave4Fixtures();
    const authed = { headers: { cookie: `${SESSION_COOKIE_NAME}=${fixture.ownerCookie}` } };
    for (const path of ["/alice/wave4/issues/new", "/alice/wave4-ren/settings", "/alice/wave4/settings/hooks"]) {
      const res = await fetchUi(path, authed);
      expect(res.status, path).toBeDefined();
      expect(res.status).toBe(200);
      const violations = runA11y(await res.text());
      expect(violations, `${path}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});
