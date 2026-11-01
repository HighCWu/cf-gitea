/**
 * The migrating-home module tests (the render.test.tsx component harness +
 * the repo-migrate-status.test.ts real-D1 posture). Two layers:
 *
 * - COMPONENT (renderToString): migrating.tmpl's DOM contract at the pin —
 *   the poller's `#repo_migrating[data-migrating-repo-link]` handle and
 *   the `#repo_migrating_retry[data-migrating-task-retry-url]` button
 *   targeting the LANDED retry endpoint, the progress/failed blocks, the
 *   `#cancel-repo-modal` form posting the LANDED cancel endpoint, and the
 *   upstream gates (the admin button row on Permission.IsAdmin, the
 *   Failed arm's cancel→(reduced delete) swap, the no_addr failed text).
 * - LOADER (real D1 via @cloudflare/vitest-plugin): the GetMigratingTask
 *   port's data triples — mirror record → the sanitized remoteAddress,
 *   import record → the address-less "" arm, record-null → the
 *   TaskDoesNotExist arm (CloneAddr "" + Failed) — and the canAdminRepo
 *   grant arms (owner / site-admin / stranger / anonymous).
 *
 * The NON-migrating home's unchangedness is pinned by render.test.tsx's
 * home suite (every fixture carries status:"ready", the arm this module
 * adds cannot fire) — the render.tsx branch is a strict equality on
 * "migrating" ahead of loadHomeData.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { renderToString } from "hono/jsx/dom/server";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { repoImports, repoMirrors, repositories } from "../../db/schema";
import type { UiManifest } from "../manifest";
import { shellAssetsFromManifest, type RepoRow, type UiContext } from "../ui-context";
import type { Viewer } from "../viewer";
import { RepoMigratingPage, loadRepoMigratingData, migratingHomeLocale } from "./repo-migrating";

// --- component fixtures --------------------------------------------------------

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const MIRROR_ADDR = "https://src.example.com/org/repo.git";

function repoRow(overrides: Partial<RepoRow> = {}): RepoRow {
  return {
    id: "r_1",
    storageKey: "r_1",
    ownerNamespace: "octocat",
    ownerId: 1,
    slug: "hello",
    visibility: "public",
    defaultBranch: "main",
    isEmpty: true,
    isArchived: false,
    status: "migrating",
    refsVersion: 1,
    backend: "self-hosted",
    numIssues: 0,
    numClosedIssues: 0,
    numPulls: 0,
    numClosedPulls: 0,
    numMilestones: 0,
    closeIssuesViaCommitInAnyBranch: false,
    createdAt: new Date(1700000000 * 1000),
    updatedAt: null,
    forkParent: null,
    isMirror: false,
    originalUrl: null,
    isTemplate: false,
    sizeKb: 0,
    numStars: 0,
    numWatches: 0,
    numForks: 0,
    numClosedMilestones: 0,
    ...overrides,
  } satisfies RepoRow;
}

function ctxWith(repo: RepoRow, viewer: Viewer): UiContext {
  return {
    viewer,
    origin: "https://test.local",
    assets: shellAssetsFromManifest(manifest),
    repo,
  };
}

const anonymous: Viewer = { kind: "anonymous" };
const ownerViewer: Viewer = { kind: "user", id: 1, username: "octocat", isAdmin: false };

const liveData = { cloneAddr: MIRROR_ADDR, failed: false, canAdmin: true };

// --- loader fixtures (real D1) ---------------------------------------------------

const NOW = new Date("2026-01-15T12:00:00Z");
const NOW_UNIX = Math.floor(NOW.getTime() / 1000);

let repoSeq = 0;
let importSeq = 0;
let ownerUserId = 0;

/** A born repositories row; `ownerNamespace` carries the seeded owner's
 *  username (case-folded match = the grant matrix's owner arm). */
async function seedRepo(overrides: Partial<typeof repositories.$inferInsert> = {}): Promise<RepoRow> {
  repoSeq += 1;
  const id = `r_${String(repoSeq).padStart(4, "0")}`;
  await drizzle(env.DB).insert(repositories).values({
    id,
    storageKey: `k_${id}`,
    ownerNamespace: "miller",
    ownerId: ownerUserId,
    slug: `repo-${repoSeq}`,
    visibility: "public",
    status: "ready",
    isEmpty: true,
    updatedAt: NOW,
    ...overrides,
  });
  const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, id)).get();
  if (row === undefined) throw new Error("repo row vanished after seed");
  return row;
}

/** A 1:1 mirror row (defaults: pending initial population, no error). */
async function seedMirror(
  repoId: string,
  overrides: Partial<Omit<typeof repoMirrors.$inferInsert, "repoId">> = {},
): Promise<void> {
  await drizzle(env.DB).insert(repoMirrors).values({
    repoId,
    remoteAddress: MIRROR_ADDR,
    intervalSeconds: 600,
    syncState: "idle",
    nextSyncAt: NOW_UNIX - 3600,
    lastSyncAt: null,
    lastError: null,
    updatedAt: NOW,
    ...overrides,
  });
}

/** A repo_imports row (defaults: staged, no error). */
async function seedImport(
  repoId: string,
  overrides: Partial<Omit<typeof repoImports.$inferInsert, "repoId">> = {},
): Promise<void> {
  importSeq += 1;
  await drizzle(env.DB).insert(repoImports).values({
    repoId,
    importTokenSha256: `sha-${String(importSeq).padStart(4, "0")}`,
    state: "staged",
    chunkCap: 512 * 1024 * 1024,
    totalBytes: 0,
    staged: "{}",
    error: null,
    heartbeatAt: NOW,
    ...overrides,
  });
}

// --- harness -------------------------------------------------------------------

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of ["repo_mirrors", "repo_imports", "repositories", "personal_access_tokens"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE username_lower != 'assets'").run();
  const owner = await seedVerifiedUser({ username: "Miller" });
  ownerUserId = owner.id;
  repoSeq = 0;
  importSeq = 0;
});

// --- the poller contract (migrating.tmpl's DOM, the LANDED endpoint URLs) --------

describe("RepoMigratingPage — the poller contract", () => {
  it("renders #repo_migrating with data-migrating-repo-link pointing at the repo home", () => {
    const html = renderToString(<RepoMigratingPage ctx={ctxWith(repoRow(), anonymous)} data={liveData} />);
    expect(html).toContain('id="repo_migrating"');
    expect(html).toContain('data-migrating-repo-link="/octocat/hello"');
    expect(html).toContain('src="/assets/img/loading.png"');
  });

  it("renders the hidden retry button with data-migrating-task-retry-url at the LANDED retry endpoint", () => {
    const html = renderToString(<RepoMigratingPage ctx={ctxWith(repoRow(), anonymous)} data={liveData} />);
    expect(html).toContain('id="repo_migrating_retry"');
    expect(html).toContain('data-migrating-task-retry-url="/octocat/hello/settings/migrate/retry"');
    // The poller keeps it hidden until a status-3 answer.
    expect(html).toContain('class="ui basic button tw-hidden"');
  });

  it("renders the poller's message targets and the hidden failed blocks", () => {
    const html = renderToString(<RepoMigratingPage ctx={ctxWith(repoRow(), anonymous)} data={liveData} />);
    expect(html).toContain('id="repo_migrating_progress_message"');
    expect(html).toContain('id="repo_migrating_failed_error"');
    expect(html).toContain('id="repo_migrating_failed"');
    expect(html).toContain('id="repo_migrating_failed_image"');
    expect(html).toContain('src="/assets/img/failed.png"');
  });

  it("renders the progress line with the sanitized CloneAddr inside the locale's <b>", () => {
    const html = renderToString(<RepoMigratingPage ctx={ctxWith(repoRow(), anonymous)} data={liveData} />);
    expect(html).toContain("Migrating from <b>https://src.example.com/org/repo.git</b>…");
  });

  it("HTML-escapes the CloneAddr substitution (the Tr escape equivalent)", () => {
    const html = renderToString(
      <RepoMigratingPage ctx={ctxWith(repoRow(), anonymous)} data={{ ...liveData, cloneAddr: 'https://src.example.com/<b>&x' }} />,
    );
    expect(html).toContain("Migrating from <b>https://src.example.com/&lt;b&gt;&amp;x</b>…");
  });

  it("renders the page-content discriminator and the repo header (upstream migrating.tmpl:2-3)", () => {
    const html = renderToString(<RepoMigratingPage ctx={ctxWith(repoRow(), anonymous)} data={liveData} />);
    expect(html).toContain('class="page-content repository"');
    // The repo header renders ({{template "repo/header" .}}) — its root
    // wrapper and the owner/repo breadcrumb pair.
    expect(html).toContain('class="repo-header flex-left-right"');
    expect(html).toContain('href="/octocat"');
    expect(html).toContain('href="/octocat/hello"');
  });
});

// --- the cancel modal (the LANDED cancel endpoint's form) ------------------------

describe("RepoMigratingPage — the cancel modal", () => {
  it("renders #cancel-repo-modal posting the LANDED cancel endpoint", () => {
    const html = renderToString(<RepoMigratingPage ctx={ctxWith(repoRow(), anonymous)} data={liveData} />);
    expect(html).toContain('id="cancel-repo-modal"');
    expect(html).toContain('action="/octocat/hello/settings/migrate/cancel"');
    expect(html).toContain('method="post"');
    expect(html).toContain(migratingHomeLocale.cancel_migrating_confirm);
    expect(html).toContain(migratingHomeLocale.cancel_migrating_title);
  });

  it("renders the default No/Yes action arm, text-only (the icon-allowlist reduction)", () => {
    const html = renderToString(<RepoMigratingPage ctx={ctxWith(repoRow(), anonymous)} data={liveData} />);
    expect(html).toContain('class="ui cancel button"');
    expect(html).toContain('class="ui primary ok button"');
    expect(html).toContain(`>${migratingHomeLocale.modal_no}</button>`);
    expect(html).toContain(`>${migratingHomeLocale.modal_yes}</button>`);
  });

  it("drops the form-fetch-action class (reduction 3 — the landed route answers a bare 303)", () => {
    const html = renderToString(<RepoMigratingPage ctx={ctxWith(repoRow(), anonymous)} data={liveData} />);
    expect(html).not.toContain("form-fetch-action");
  });
});

// --- the gates (upstream Permission.IsAdmin / Failed) -----------------------------

describe("RepoMigratingPage — the gates", () => {
  it("hides the whole admin button row from non-admins (cancel AND retry buttons)", () => {
    const html = renderToString(<RepoMigratingPage ctx={ctxWith(repoRow(), anonymous)} data={{ ...liveData, canAdmin: false }} />);
    expect(html).not.toContain('data-modal="#cancel-repo-modal"');
    expect(html).not.toContain('id="repo_migrating_retry"');
    // The dialog itself renders for every viewer (upstream renders both
    // dialogs outside the IsAdmin gate — reduction 5).
    expect(html).toContain('id="cancel-repo-modal"');
  });

  it("shows the cancel opener only for admins on the live arm", () => {
    const html = renderToString(<RepoMigratingPage ctx={ctxWith(repoRow(), ownerViewer)} data={liveData} />);
    expect(html).toContain('data-modal="#cancel-repo-modal"');
    expect(html).toContain(`data-modal="#cancel-repo-modal">${migratingHomeLocale.cancel}</button>`);
  });

  it("swaps the cancel opener out on the Failed arm (upstream's {{if .Failed}} exclusivity; the delete button is reduction 1)", () => {
    const html = renderToString(
      <RepoMigratingPage ctx={ctxWith(repoRow(), ownerViewer)} data={{ ...liveData, failed: true }} />,
    );
    expect(html).not.toContain('data-modal="#cancel-repo-modal"');
    // No delete surface either (reduction 1 — no dead control, the
    // repo-settings-wiki precedent).
    expect(html).not.toContain("delete-repo-modal");
    // The retry button still renders (the poller reveals it on status 3).
    expect(html).toContain('id="repo_migrating_retry"');
  });

  it("renders the failed text with the address on the Failed arm (Tr migrating_failed)", () => {
    const html = renderToString(
      <RepoMigratingPage ctx={ctxWith(repoRow(), ownerViewer)} data={{ ...liveData, failed: true }} />,
    );
    expect(html).toContain("Migrating from <b>https://src.example.com/org/repo.git</b> failed.");
  });

  it("renders the no_addr failed text when CloneAddr is empty (Tr migrating_failed_no_addr)", () => {
    const html = renderToString(
      <RepoMigratingPage ctx={ctxWith(repoRow(), ownerViewer)} data={{ ...liveData, cloneAddr: "", failed: true }} />,
    );
    expect(html).toContain("Migration failed.");
    // The addr-composed failed line is absent (the "</b> failed." shape
    // only exists when a CloneAddr substitutes).
    expect(html).not.toContain("</b> failed.");
  });

  it("renders the address-less progress line for the import channel (empty <b> substitution)", () => {
    const html = renderToString(
      <RepoMigratingPage ctx={ctxWith(repoRow(), anonymous)} data={{ ...liveData, cloneAddr: "" }} />,
    );
    expect(html).toContain("Migrating from <b></b>…");
  });
});

// --- the loader (the GetMigratingTask port, on real D1) ----------------------------

describe("loadRepoMigratingData", () => {
  it("resolves a pending mirror population: the stored sanitized remoteAddress, not failed", async () => {
    const repo = await seedRepo({ status: "migrating" });
    await seedMirror(repo.id);
    const data = await loadRepoMigratingData(env, repo, { kind: "user", id: ownerUserId, username: "miller", isAdmin: false });
    expect(data.cloneAddr).toBe(MIRROR_ADDR);
    expect(data.failed).toBe(false);
    // The owner viewer passes the grant matrix's owner arm.
    expect(data.canAdmin).toBe(true);
  });

  it("resolves an in-flight import: no CloneAddr (the push channel stores none), not failed", async () => {
    const repo = await seedRepo({ status: "migrating" });
    await seedImport(repo.id, { state: "indexing" });
    const data = await loadRepoMigratingData(env, repo, { kind: "user", id: ownerUserId, username: "miller", isAdmin: false });
    expect(data.cloneAddr).toBe("");
    expect(data.failed).toBe(false);
    expect(data.canAdmin).toBe(true);
  });

  it("resolves a failed import to the Failed arm (the address-less failed text's data)", async () => {
    const repo = await seedRepo({ status: "migrating" });
    await seedImport(repo.id, { state: "failed", error: "connect refused" });
    const data = await loadRepoMigratingData(env, repo, { kind: "user", id: ownerUserId, username: "miller", isAdmin: false });
    expect(data.cloneAddr).toBe("");
    expect(data.failed).toBe(true);
  });

  it("resolves a record-less migrating repo to the TaskDoesNotExist arm (CloneAddr '', Failed)", async () => {
    const repo = await seedRepo({ status: "migrating" });
    const data = await loadRepoMigratingData(env, repo, { kind: "user", id: ownerUserId, username: "miller", isAdmin: false });
    expect(data.cloneAddr).toBe("");
    expect(data.failed).toBe(true);
  });

  it("refuses the admin row to a stranger and to anonymous (zero-read anonymous arm)", async () => {
    const stranger = await seedVerifiedUser({ username: "Stranger" });
    const repo = await seedRepo({ status: "migrating" });
    await seedMirror(repo.id);
    const strangerData = await loadRepoMigratingData(env, repo, {
      kind: "user",
      id: stranger.id,
      username: "Stranger",
      isAdmin: false,
    });
    expect(strangerData.canAdmin).toBe(false);
    const anonymousData = await loadRepoMigratingData(env, repo, { kind: "anonymous" });
    expect(anonymousData.canAdmin).toBe(false);
    // The data arms stay readable (upstream renders the page for every
    // viewer with unit access — only the button row is gated).
    expect(anonymousData.cloneAddr).toBe(MIRROR_ADDR);
  });

  it("grants the admin row to a site admin regardless of ownership", async () => {
    const repo = await seedRepo({ status: "migrating" });
    await seedMirror(repo.id);
    const data = await loadRepoMigratingData(env, repo, { kind: "user", id: 999, username: "root", isAdmin: true });
    expect(data.canAdmin).toBe(true);
  });
});
