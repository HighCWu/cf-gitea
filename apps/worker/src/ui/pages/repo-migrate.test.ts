/**
 * The repo-migrate page-module tests (the lastcommit-fragment fixture
 * discipline): the module is UNMOUNTED — the route arm is index-owned (a
 * later index.ts window; the module header's HANDOFF carries the mapping) —
 * so the tests drive the loader, parser, write, and render DIRECTLY, on real
 * D1 + real bindings (workerd, @cloudflare/vitest-plugin).
 *
 * The write legs run the LANDED server-driven migrate arm end-to-end
 * (services/migrate.ts through `resolveMigrateOwner` → `migrateRepository` —
 * the POST /repos/migrate contract path's own service): the mirror arm's
 * queue semantics are asserted with a CAPTURED MIRROR_SYNC_QUEUE (the
 * migrate.test.ts recording-queue pattern — the live dev-queue consumer's
 * real-network sync must never see these messages) and the single birth
 * emission through an owner-level send-everything hook (the f5406c3
 * observer, seeded BEFORE the write). The egress gate env is explicitly
 * lax-ed per write (ADR-0005 D3: the ambient .dev.vars strict list would
 * reject every fixture URL).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { REPO_SETTINGS_DDL_STATEMENTS } from "../../api/services/repo-settings";
import type { MigrateEnv } from "../../services/migrate";
import { OrgService, type OrgRecord } from "../../services/orgs/orgs";
import { RepoService } from "../../repos/service";
import type { RepoEventExecution } from "../../services/repo-events";
import {
  orgMembers,
  repoMirrors,
  repoSettings,
  repositories,
  users,
  webhookDeliveries,
  webhooks,
} from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  loadRepoMigrateData,
  migrateRepoFromForm,
  parseRepoMigrateForm,
  renderRepoMigratePage,
  repoMigrateLocale,
  type RepoMigrateData,
  type RepoMigrateEmission,
  type RepoMigrateForm,
} from "./repo-migrate";

// --- fixtures ----------------------------------------------------------------

const SOURCE_URL = "https://src.example.com/org/repo.git";

/** Synthetic manifest shaped like the real Vite output (the shell.test.tsx
 *  fixture — deterministic, no build dependence). */
const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": {
    file: "js/index.deadbeef.js",
    css: ["css/index.1111aaaa.css"],
  },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

interface RecordingQueue extends Queue {
  sent: unknown[];
}

/** MIRROR_SYNC_QUEUE stub — the write's enqueue is CAPTURED here instead of
 *  reaching the live dev-queue consumer, whose real-network sync would hang
 *  on the fixture host (migrate.test.ts's pattern). */
function recordingQueue(): RecordingQueue {
  const metadata = { metrics: { backlogCount: 0, backlogBytes: 0 } };
  const sent: unknown[] = [];
  return {
    sent,
    send: (body: unknown) => {
      sent.push(body);
      return Promise.resolve({ metadata });
    },
    sendBatch: () => Promise.resolve({ metadata }),
    metrics: () => Promise.resolve({ backlogCount: 0, backlogBytes: 0 }),
  };
}

/** The migrate-write env slice: the egress gate lax-ed (explicit absence —
 *  the ambient .dev.vars values are strict-mode and would reject the fixture
 *  hosts; ADR-0005 D3) over the real bindings, with the queue injected. */
function migrateTestEnv(queue: RecordingQueue): MigrateEnv {
  return {
    ...env,
    MIRROR_ALLOWED_HOST_LIST: undefined,
    MIRROR_EGRESS_MODE: undefined,
    MIRROR_SYNC_QUEUE: queue,
  };
}

const asUser = (seed: { id: number; username: string }, isAdmin = false): Extract<Viewer, { kind: "user" }> => ({
  kind: "user",
  id: seed.id,
  username: seed.username.toLowerCase(),
  isAdmin,
});

/** The in-process emission source — `executionCtx` throws like hono's getter
 *  does for router.fetch-style callers (emitRepoEvent's try/catch arm). */
function makeEmission(): RepoMigrateEmission {
  return {
    request: {
      env,
      get executionCtx(): RepoEventExecution {
        throw new Error("no execution context in tests");
      },
    },
    origin: "https://test.local",
  };
}

const baseForm = (): RepoMigrateForm => ({
  uid: null,
  cloneAddr: SOURCE_URL,
  authUsername: "",
  authPassword: "",
  repoName: "mirrored",
  description: "",
  isPrivate: false,
  mirror: true,
});

/** Guard helper (the index.test.ts seed style — no non-null assertions, no
 *  narrowing casts). */
function expectData(data: RepoMigrateData | null): RepoMigrateData {
  if (data === null) throw new Error("loader returned null where owners were expected");
  return data;
}

/** An owner-level hook created BEFORE the write — the birth emission's
 *  observer (the repo row does not exist until the write, so the hook hangs
 *  off the OWNER; the migrate.test.ts pattern). */
async function seedOwnerEverythingHook(ownerId: number): Promise<void> {
  await drizzle(env.DB).insert(webhooks).values({
    ownerId,
    url: "https://hooks.example.com/migrate",
    events: JSON.stringify({ send_everything: true }),
    isActive: true,
  });
}

/** The delivery log, oldest first — the emission assertion surface. */
const deliveries = () => drizzle(env.DB).select().from(webhookDeliveries).orderBy(webhookDeliveries.id).all();

/** The `repository` action=created rows — the single-emission counter. The
 *  delivery log stores upstream's 2-space MarshalIndent shape, so the match
 *  tolerates the whitespace after the colon. */
const createdEmissions = async (): Promise<typeof webhookDeliveries.$inferSelect[]> => {
  const rows = await deliveries();
  return rows.filter(
    (row) => row.eventType === "repository" && /"action":\s*"created"/.test(row.payloadContent),
  );
};

const repoRow = async (slug: string): Promise<typeof repositories.$inferSelect | null> => {
  const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.slug, slug)).get();
  return row ?? null;
};

// --- harness -----------------------------------------------------------------

let doer: { id: number; username: string } = { id: 0, username: "" };
let doerViewer: Extract<Viewer, { kind: "user" }> = { kind: "user", id: 0, username: "", isAdmin: false };

async function seedOrg(name: string, ownerId: number): Promise<OrgRecord> {
  return new OrgService(env.DB).createOrg({ name, ownerId });
}

async function seedMembership(orgId: number, userId: number, role: "owner" | "member"): Promise<void> {
  await drizzle(env.DB).insert(orgMembers).values({ orgId, userId, role, createdAt: new Date() });
}

async function loadFormData(viewer: Extract<Viewer, { kind: "user" }>): Promise<RepoMigrateData> {
  return expectData(await loadRepoMigrateData(env.DB, viewer));
}

beforeAll(async () => {
  // The full generated migration ledger + the repo_settings DDL-in-waiting
  // (the description path writes the stored subset — migrate.test.ts's
  // bootstrap, same SCHEMA GAP note).
  await applyAuthD1Migrations();
  for (const statement of REPO_SETTINGS_DDL_STATEMENTS) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  for (const table of [
    "repo_mirrors",
    "repo_imports",
    "repo_settings",
    "repo_counters",
    "repo_units",
    "repo_redirects",
    "repo_transfer",
    "webhook_deliveries",
    "webhooks",
    "repositories",
    "personal_access_tokens",
    "org_members",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
  doer = await seedVerifiedUser({ username: "Miller" });
  doerViewer = asUser(doer);
});

// --- the parser ----------------------------------------------------------------

describe("parseRepoMigrateForm", () => {
  it("parses the urlencoded submission: trims the name/URL, keeps credentials verbatim, field-present checkboxes", () => {
    const parsed = parseRepoMigrateForm(
      new URLSearchParams({
        uid: " 7 ",
        clone_addr: "  https://src.example.com/r.git  ",
        auth_username: " octocat ",
        auth_password: " tr yo pass ",
        repo_name: "  mirrored  ",
        description: "  kept verbatim  ",
        private: "on",
        mirror: "on",
      }),
    );
    expect(parsed).toEqual({
      uid: 7,
      cloneAddr: "https://src.example.com/r.git",
      authUsername: " octocat ", // credentials are not trimmed (verbatim bytes)
      authPassword: " tr yo pass ",
      repoName: "mirrored",
      description: "  kept verbatim  ",
      isPrivate: true,
      mirror: true,
    });
  });

  it("defaults: absent/garbage uid is the doer, checkboxes off, fields empty", () => {
    expect(parseRepoMigrateForm(new URLSearchParams())).toEqual({
      uid: null,
      cloneAddr: "",
      authUsername: "",
      authPassword: "",
      repoName: "",
      description: "",
      isPrivate: false,
      mirror: false,
    });
    expect(parseRepoMigrateForm(new URLSearchParams({ uid: "abc" })).uid).toBeNull();
    expect(parseRepoMigrateForm(new URLSearchParams({ uid: "-3" })).uid).toBeNull();
  });

  it("parses EXACTLY the rendered surface — the reduced fields are not part of the shape", () => {
    // A forged body carrying every reduced module-header field changes
    // nothing: the parser never reads them, so the write's option shape
    // cannot carry them either.
    const parsed = parseRepoMigrateForm(
      new URLSearchParams({
        auth_token: "tok",
        lfs: "on",
        lfs_endpoint: "https://lfs.example.com",
        mirror_interval: "5m",
        wiki: "on",
        issues: "on",
        milestones: "on",
        labels: "on",
        pull_requests: "on",
        releases: "on",
        aws_access_key_id: "aws",
        aws_secret_access_key: "secret",
      }),
    );
    expect(Object.keys(parsed).sort()).toEqual([
      "authPassword",
      "authUsername",
      "cloneAddr",
      "description",
      "isPrivate",
      "mirror",
      "repoName",
      "uid",
    ]);
  });
});

// --- the loader (the gate arms) -------------------------------------------------

describe("loadRepoMigrateData — the owner-family gate arms", () => {
  it("carries the doer plus the orgs the WRITE accepts (isOrgOwner), not the wider create family", async () => {
    const other = await seedVerifiedUser({ username: "OrgOwner" });
    const owned = await seedOrg("mine", doer.id);
    const foreign = await seedOrg("theirs", other.id);
    await seedMembership(foreign.id, doer.id, "member"); // a membership WITHOUT ownership

    const data = expectData(await loadRepoMigrateData(env.DB, doerViewer));
    expect(data.doer.id).toBe(doer.id);
    expect(data.owners).toEqual([
      { id: doer.id, username: "Miller", kind: "user" },
      { id: owned.id, username: "mine", kind: "org" },
      // `theirs` is filtered: resolveMigrateOwner is org-OWNER strict — a
      // plain membership would 403 the write, so the dropdown never offers it
      // (the module-header gate note; repo-create's canCreateOrgRepo family
      // is deliberately wider).
    ]);
  });

  it("bypasses the ownership filter for site admins (resolveMigrateOwner's caller-level arm)", async () => {
    const other = await seedVerifiedUser({ username: "OrgOwner" });
    const foreign = await seedOrg("theirs", other.id);
    const admin = await seedVerifiedUser({ username: "Admin", isAdmin: true });
    await seedMembership(foreign.id, admin.id, "member");
    const adminViewer = asUser(admin, true);

    const data = expectData(await loadRepoMigrateData(env.DB, adminViewer));
    expect(data.owners.some((owner) => owner.id === foreign.id && owner.kind === "org")).toBe(true);
  });

  it("nulls a session principal without a D1 row (the silent-auth-failure convention)", async () => {
    expect(await loadRepoMigrateData(env.DB, { kind: "user", id: 987654, username: "ghost", isAdmin: false })).toBeNull();
  });

  it("refuses an anonymous viewer (the loader contract)", async () => {
    await expect(loadRepoMigrateData(env.DB, { kind: "anonymous" })).rejects.toThrow("requires a signed-in viewer");
  });
});

// --- the write: validation shapes ------------------------------------------------

describe("migrateRepoFromForm — required-field + URL validation shapes", () => {
  it("re-renders the empty clone URL", async () => {
    const result = await migrateRepoFromForm(
      migrateTestEnv(recordingQueue()),
      env.DB,
      doerViewer,
      await loadFormData(doerViewer),
      { ...baseForm(), cloneAddr: "" },
    );
    expect(result).toEqual({ outcome: "invalid", message: repoMigrateLocale.clone_addr_required });
  });

  it("re-renders the empty repository name", async () => {
    const result = await migrateRepoFromForm(
      migrateTestEnv(recordingQueue()),
      env.DB,
      doerViewer,
      await loadFormData(doerViewer),
      { ...baseForm(), repoName: "" },
    );
    expect(result).toEqual({ outcome: "invalid", message: repoMigrateLocale.name_required });
  });

  it("re-renders the mirror=false degradation WITHOUT birthing a stranded migrating row", async () => {
    const queue = recordingQueue();
    const result = await migrateRepoFromForm(
      migrateTestEnv(queue),
      env.DB,
      doerViewer,
      await loadFormData(doerViewer),
      { ...baseForm(), mirror: false },
    );
    expect(result).toEqual({ outcome: "invalid", message: repoMigrateLocale.mirror_required });
    expect(await repoRow("mirrored")).toBeNull();
    expect(queue.sent).toEqual([]);
  });

  it("surfaces the egress gate's 422 texts verbatim: scheme and userinfo arms", async () => {
    const queue = recordingQueue();
    const data = await loadFormData(doerViewer);
    const http = await migrateRepoFromForm(migrateTestEnv(queue), env.DB, doerViewer, data, {
      ...baseForm(),
      cloneAddr: "http://src.example.com/r.git",
    });
    expect(http).toEqual({ outcome: "invalid", message: "The provided URL is invalid." });
    const userinfo = await migrateRepoFromForm(migrateTestEnv(queue), env.DB, doerViewer, data, {
      ...baseForm(),
      cloneAddr: "https://user:pass@src.example.com/r.git",
    });
    expect(userinfo).toEqual({ outcome: "invalid", message: "The provided URL is invalid." });
    expect(await repoRow("mirrored")).toBeNull();
  });

  it("re-renders the KEK pre-flight failure BEFORE any birth write (the §4.2 fail-fast posture)", async () => {
    const envSlice = { ...migrateTestEnv(recordingQueue()), MIRROR_CREDENTIAL_KEY: undefined };
    const result = await migrateRepoFromForm(envSlice, env.DB, doerViewer, await loadFormData(doerViewer), {
      ...baseForm(),
      authUsername: "octocat",
      authPassword: "s3cret",
    });
    expect(result).toEqual({
      outcome: "invalid",
      message: "MIRROR_CREDENTIAL_KEY is not configured; source credentials cannot be stored",
    });
    expect(await repoRow("mirrored")).toBeNull();
  });
});

// --- the write: the mirror arm (the 202/queue semantics) -------------------------

describe("migrateRepoFromForm — the mirror arm's submit semantics", () => {
  it("creates the repository, registers the mirror, kicks exactly one sync, and emits the single birth webhook", async () => {
    await seedOwnerEverythingHook(doer.id);
    const queue = recordingQueue();
    const data = await loadFormData(doerViewer);

    const result = await migrateRepoFromForm(
      migrateTestEnv(queue),
      env.DB,
      doerViewer,
      data,
      { ...baseForm(), description: "mirrored from upstream", isPrivate: true, authUsername: "octocat", authPassword: "pw" },
      makeEmission(),
    );
    expect(result).toEqual({ outcome: "created", ownerNamespace: "miller", slug: "mirrored" });

    // The born row: ready + empty + mirror-flagged + private + sanitized
    // origin — the population is NOT in-request (§2.6 queue semantics).
    const repo = await repoRow("mirrored");
    if (repo === null) throw new Error("the mirror arm did not birth the repo");
    expect(repo.status).toBe("ready");
    expect(repo.isEmpty).toBe(true);
    expect(repo.isMirror).toBe(true);
    expect(repo.visibility).toBe("private");
    expect(repo.originalUrl).toBe(SOURCE_URL);

    // Exactly ONE sync message armed the initial population.
    expect(queue.sent).toEqual([{ kind: "mirror-sync", repoId: repo.id }]);

    // The mirror row: registered due, credentials sealed (never echoed).
    const mirror = await drizzle(env.DB).select().from(repoMirrors).where(eq(repoMirrors.repoId, repo.id)).get();
    expect(mirror).not.toBeUndefined();
    expect(mirror?.remoteAddress).toBe(SOURCE_URL);
    expect(mirror?.credentialsCiphertext).not.toBeNull();

    // The description rides the repo-edit stored subset.
    const settings = await drizzle(env.DB).select().from(repoSettings).where(eq(repoSettings.repoId, repo.id)).get();
    expect(settings?.description).toBe("mirrored from upstream");

    // THE SINGLE BIRTH EMISSION: exactly one repository-created, in-request.
    expect(await createdEmissions()).toHaveLength(1);
  });

  it("succeeds without an emission source (the historical shape) and emits nothing", async () => {
    const result = await migrateRepoFromForm(
      migrateTestEnv(recordingQueue()),
      env.DB,
      doerViewer,
      await loadFormData(doerViewer),
      baseForm(),
    );
    expect(result).toEqual({ outcome: "created", ownerNamespace: "miller", slug: "mirrored" });
    expect(await createdEmissions()).toHaveLength(0);
  });

  it("re-renders the uid gate arms with upstream's exact API-arm texts", async () => {
    const queue = recordingQueue();
    const other = await seedVerifiedUser({ username: "Other" });
    const foreign = await seedOrg("theirs", other.id);
    const data = await loadFormData(doerViewer);

    // Another plain USER target — upstream migrate.go:82-99's 403 text.
    const userTarget = await migrateRepoFromForm(migrateTestEnv(queue), env.DB, doerViewer, data, {
      ...baseForm(),
      uid: other.id,
    });
    expect(userTarget).toEqual({ outcome: "invalid", message: "Given user is not an organization." });

    // A non-owned ORG target — the second 403 text.
    const orgTarget = await migrateRepoFromForm(migrateTestEnv(queue), env.DB, doerViewer, data, {
      ...baseForm(),
      uid: foreign.id,
    });
    expect(orgTarget).toEqual({ outcome: "invalid", message: "Given user is not owner of organization." });

    // An unknown uid — the 422 text.
    const ghost = await migrateRepoFromForm(migrateTestEnv(queue), env.DB, doerViewer, data, {
      ...baseForm(),
      uid: 987654,
    });
    expect(ghost).toEqual({ outcome: "invalid", message: "user does not exist [uid: 987654, name: ]" });

    // Nothing born, nothing enqueued on any gate failure.
    expect(await repoRow("mirrored")).toBeNull();
    expect(queue.sent).toEqual([]);
  });

  it("migrates into an OWNED org target (the dropdown's org arm)", async () => {
    const queue = recordingQueue();
    const owned = await seedOrg("mine", doer.id);
    const result = await migrateRepoFromForm(
      migrateTestEnv(queue),
      env.DB,
      doerViewer,
      await loadFormData(doerViewer),
      { ...baseForm(), uid: owned.id },
    );
    expect(result).toEqual({ outcome: "created", ownerNamespace: "mine", slug: "mirrored" });
    expect(await repoRow("mirrored")).toMatchObject({ ownerNamespace: "mine" });
    expect(queue.sent).toHaveLength(1);
  });

  it("re-renders the 409 collision with upstream's WEB text and the unusable-name service text verbatim", async () => {
    const queue = recordingQueue();
    await new RepoService(env.DB).create({ owner: { id: doer.id, usernameLower: "miller" }, name: "dup", isPrivate: false });
    const data = await loadFormData(doerViewer);

    const collision = await migrateRepoFromForm(migrateTestEnv(queue), env.DB, doerViewer, data, {
      ...baseForm(),
      repoName: "dup",
    });
    expect(collision).toEqual({ outcome: "invalid", message: repoMigrateLocale.name_taken });

    // The service's pattern text renders verbatim (upstream's
    // ErrNamePatternNotAllowed web arm has no interpolable value here).
    const pattern = await migrateRepoFromForm(migrateTestEnv(queue), env.DB, doerViewer, data, {
      ...baseForm(),
      repoName: "in valid",
    });
    expect(pattern).toMatchObject({ outcome: "invalid" });
    if (pattern.outcome === "invalid") {
      expect(pattern.message).toContain("repository name is not allowed");
    }
  });
});

// --- the render (templates/repo/migrate/git.tmpl at the pin) ----------------------

describe("renderRepoMigratePage — the DOM contract", () => {
  /** The render fixture reads the LIVE doer row (the component's doer
   *  projection source is the full users row, like the create form's). */
  async function renderData(owners: RepoMigrateData["owners"]): Promise<RepoMigrateData> {
    const row = await drizzle(env.DB).select().from(users).where(eq(users.id, doer.id)).get();
    if (row === undefined) throw new Error("doer fixture missing");
    return { doer: row, owners };
  }

  const ctx: UiContext = {
    viewer: doerViewer,
    origin: "https://test.local",
    assets: shellAssetsFromManifest(manifest),
  };

  it("renders the git.tmpl skeleton: discriminator, title/aria split, header, form action", async () => {
    const html = renderRepoMigratePage({
      ctx,
      data: await renderData([{ id: doer.id, username: "miller", kind: "user" }]),
      form: baseForm(),
      error: null,
    });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<div role="main" aria-label="New Migration" class="page-content repository new migrate">');
    expect(html).toContain("<title>New Migration - ");
    expect(html).toContain('<h3 class="ui top attached header">Migrate From Git</h3>');
    expect(html).toContain('<form class="ui form left-right-form" action="/repo/migrate" method="post">');
    // The no-JS convention drops upstream's form-fetch-action hook.
    expect(html).not.toContain("form-fetch-action");
    // common-init.tmpl: the service variant pin, no JS hook attribute.
    expect(html).toContain('<input type="hidden" name="service" value="git"/>');
    expect(html).not.toContain("data-global-init");
  });

  it("renders the git.tmpl field set in template order with the binding constraints", async () => {
    const html = renderRepoMigratePage({
      ctx,
      data: await renderData([{ id: doer.id, username: "miller", kind: "user" }]),
      form: { ...baseForm(), cloneAddr: "https://src.example.com/r.git", authUsername: "octocat" },
      error: null,
    });

    // Template composition order (git.tmpl:10-32).
    let last = -1;
    for (const needle of [
      'name="clone_addr"',
      'name="auth_username"',
      'name="auth_password"',
      'name="mirror"',
      'name="uid"',
      'name="repo_name"',
      'name="private"',
      'name="description"',
    ]) {
      const at = html.indexOf(needle);
      expect(at, needle).toBeGreaterThan(last);
      last = at;
    }

    // clone_addr: required + autofocus + the round-tripped value + the
    // https-only help (the local-path tail is reduced away).
    expect(html).toContain(
      '<input id="clone_addr" name="clone_addr" value="https://src.example.com/r.git" required="" autocomplete="off" autofocus=""/>',
    );
    expect(html).toContain("The HTTP(S) or Git &#39;clone&#39; URL of an existing repository");
    expect(html).not.toContain("local server path");

    // The password field renders EMPTY — the template's own shape (the
    // re-render never echoes credentials).
    expect(html).toContain('<input id="auth_password" name="auth_password" type="password" autocomplete="new-password"/>');

    // repo_name / description bindings.
    expect(html).toContain('id="repo_name" name="repo_name" value="mirrored" required="" maxlength="100" autocomplete="off"');
    expect(html).toContain('<textarea id="description" name="description" rows="2" maxlength="2048">');

    // The primary submit.
    expect(html).toContain('<button type="submit" class="ui primary button">Migrate Repository</button>');
  });

  it("round-trips the checkboxes and the owner select (unknown uid falls back to the doer)", async () => {
    const owners = [
      { id: doer.id, username: "miller", kind: "user" as const },
      { id: doer.id + 2, username: "mine", kind: "org" as const },
    ];
    const checked = renderRepoMigratePage({
      ctx,
      data: await renderData(owners),
      form: { ...baseForm(), isPrivate: true, mirror: true, uid: owners[1]?.id ?? null },
      error: null,
    });
    expect(checked).toContain('<input id="mirror" name="mirror" type="checkbox" checked=""/>');
    expect(checked).toContain('<input id="private" name="private" type="checkbox" checked=""/>');
    expect(checked).toContain(`<option value="${owners[1]?.id}" selected="">`);
    expect(checked).toContain(`<option value="${doer.id}">`);

    const unchecked = renderRepoMigratePage({
      ctx,
      data: await renderData(owners),
      form: { ...baseForm(), mirror: false, isPrivate: false },
      error: null,
    });
    expect(unchecked).toContain('<input id="mirror" name="mirror" type="checkbox"/>');
    expect(unchecked).toContain('<input id="private" name="private" type="checkbox"/>');
    expect(unchecked).toContain(`<option value="${doer.id}" selected="">`);

    // A forged/tampered uid renders the doer selected (checkContextUser's
    // fall-through), never a dead option.
    const forged = renderRepoMigratePage({
      ctx,
      data: await renderData(owners),
      form: { ...baseForm(), uid: 424242 },
      error: null,
    });
    expect(forged).toContain(`<option value="${doer.id}" selected="">`);
    expect(forged).not.toContain('value="424242"');
  });

  it("renders the error message and none of the reduced module-header fields", async () => {
    const html = renderRepoMigratePage({
      ctx,
      data: await renderData([{ id: doer.id, username: "miller", kind: "user" }]),
      form: baseForm(),
      error: repoMigrateLocale.name_taken,
    });
    expect(html).toContain('<div class="ui negative message">The repository name is already used.</div>');

    // The reduced surface matrix (module header): none of these inputs exist.
    for (const reduced of [
      'name="auth_token"',
      'name="lfs"',
      'name="lfs_endpoint"',
      'name="mirror_interval"',
      'name="wiki"',
      'name="issues"',
      'name="milestones"',
      'name="labels"',
      'name="pull_requests"',
      'name="releases"',
      'name="aws_access_key_id"',
      'name="aws_secret_access_key"',
    ]) {
      expect(html).not.toContain(reduced);
    }
  });
});
