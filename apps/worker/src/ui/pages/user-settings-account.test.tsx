/**
 * The user settings ACCOUNT tab's tests (the module is MOUNTED at 2f7afe9 —
 * the routes live in `index.ts`, so the CSRF guard and the 303 arms
 * live at the mounted handlers; the repo-settings-wiki /
 * user-settings-secrets harness): the parse/apply/delete matrix over real
 * D1 through the LANDED stores (generated migrations in beforeAll; migration
 * 0016's `email_addresses` + the SPEC-0010 token/session stores) and the DOM
 * contract of the page render — hono/jsx renderToString. The module-level
 * outcomes below are the handler's full observable surface (the mount
 * record's render map: "added"/"primary"/"redirect" 303, "invalid" re-renders at 200,
 * the deletion's "deleted" 303s onto `/`). Covered: the synthesized-primary
 * read rule and its derivation after a PRIMARY flip, the add arm's
 * validation matrix (syntax, the 254 binding cap, the global used-check
 * ∪ users.email), the PRIMARY demotion materialization, the delete arms'
 * scope guard, and the self-deletion ladder (the PAT re-auth, the admin /
 * owns-repos / has-orgs guards in upstream's order, the cascade sweep with
 * the branch-protection scrub), plus the no-password-model DOM posture.
 */

import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToString } from "hono/jsx/dom/server";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { TokenService } from "../../auth/token-service";
import { serializeRuleConfig } from "../../services/branch-protection";
import {
  emailAddresses,
  issueSubscriptions,
  orgMembers,
  protectedBranches,
  reactions,
  repoCollaborators,
  repositories,
  repoWatchers,
  sessions,
  users,
} from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  applyUserSettingsAccountDeleteForm,
  applyUserSettingsAccountEmailForm,
  deleteUserSettingsAccountEmail,
  loadUserSettingsAccountPageData,
  parseUserSettingsAccountDeleteForm,
  parseUserSettingsAccountEmailDeleteForm,
  parseUserSettingsAccountEmailForm,
  renderUserSettingsAccountPage,
  userSettingsAccountLocale,
  UserSettingsAccountPage,
} from "./user-settings-account";

// --- fixtures ----------------------------------------------------------------

const ORIGIN = "https://test.local";

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const viewer: Viewer = { kind: "user", id: 1, username: "alice", isAdmin: false };

const ctx: UiContext = {
  viewer,
  origin: ORIGIN,
  assets: shellAssetsFromManifest(manifest),
};

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of [
    "protected_branches",
    "issue_subscriptions",
    "reactions",
    "repo_collaborators",
    "repo_watchers",
    "org_members",
    "repositories",
    "sessions",
    "personal_access_tokens",
    "email_addresses",
    "users",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // Alice: the primary email on users.email, no password credential (the
  // landed model — no passwd column exists).
  await env.DB.prepare(
    "INSERT INTO users (id, username, username_lower, email, created_at) VALUES (1, 'alice', 'alice', 'alice@example.com', unixepoch())",
  ).run();
});

async function seedUser(id: number, username: string, email: string | null, isAdmin = false): Promise<void> {
  await drizzle(env.DB).insert(users).values({
    id,
    username,
    usernameLower: username.toLowerCase(),
    email,
    isAdmin,
    createdAt: new Date(),
  });
}

async function seedSecondary(userId: number, email: string): Promise<number> {
  const inserted = await drizzle(env.DB)
    .insert(emailAddresses)
    .values({ userId, email, lowerEmail: email.toLowerCase(), isActivated: true, isPrimary: false })
    .returning({ id: emailAddresses.id })
    .all();
  return inserted[0]!.id;
}

async function loadUserRow(id = 1) {
  const row = await drizzle(env.DB).select().from(users).where(eq(users.id, id)).get();
  if (row === undefined) throw new Error(`seed user ${id} missing`);
  return row;
}

async function userEmail(userId = 1): Promise<string | null> {
  return (await loadUserRow(userId)).email;
}

async function pageHtml(error: string | null = null, email = ""): Promise<string> {
  const data = await loadUserSettingsAccountPageData(env.DB, 1);
  if (data === null) throw new Error("page data missing");
  return renderToString(<UserSettingsAccountPage ctx={ctx} data={data} error={error} email={email} />);
}

// --- the loader ---------------------------------------------------------------

describe("loadUserSettingsAccountPageData (GetEmailAddresses + the synthesized primary)", () => {
  it("answers null for a doer without a D1 row (the 404-shell gate)", async () => {
    expect(await loadUserSettingsAccountPageData(env.DB, 99)).toBeNull();
  });

  it("synthesizes the primary first from users.email and lists rows after, id-ordered", async () => {
    await seedSecondary(1, "zeta@example.com");
    await seedSecondary(1, "alpha@example.com");
    const data = await loadUserSettingsAccountPageData(env.DB, 1);
    expect(data!.emails.map((entry) => entry.email)).toEqual([
      "alice@example.com", // the synthesized primary renders first
      "zeta@example.com",
      "alpha@example.com",
    ]);
    expect(data!.emails[0]).toMatchObject({ id: null, isPrimary: true, isActivated: true, canBePrimary: true });
    expect(data!.emails[1]).toMatchObject({ id: 1, isPrimary: false, isActivated: true });
  });

  it("suppresses the synthesis when a row carries users.email (the misc-t3 read rule)", async () => {
    // Direct insert — no write path produces this shape (the add path
    // treats users.email as taken); the read rule must hold regardless.
    // (The id is expect.any — sqlite's autoincrement never resets within a
    // file run, only the rows are cleared.)
    await drizzle(env.DB).insert(emailAddresses).values({ userId: 1, email: "alice@example.com", lowerEmail: "alice@example.com", isActivated: true, isPrimary: false });
    const data = await loadUserSettingsAccountPageData(env.DB, 1);
    expect(data!.emails).toHaveLength(1);
    expect(typeof data!.emails[0]!.id).toBe("number");
    expect(data!.emails[0]).toMatchObject({ isPrimary: true }); // DERIVED from the users.email match
  });

  it("renders no primary when users.email is null and no rows exist", async () => {
    await env.DB.prepare("UPDATE users SET email = NULL WHERE id = 1").run();
    const data = await loadUserSettingsAccountPageData(env.DB, 1);
    expect(data!.emails).toEqual([]);
  });
});

// --- the email form parse -------------------------------------------------------

describe("parseUserSettingsAccountEmailForm (the _method/id/email triple)", () => {
  it("parses the add, PRIMARY, and SENDACTIVATION shapes", () => {
    expect(parseUserSettingsAccountEmailForm(new URLSearchParams({ email: "a@b.co" }))).toEqual({ method: "", id: null, email: "a@b.co" });
    expect(parseUserSettingsAccountEmailForm(new URLSearchParams({ _method: "PRIMARY", id: "7" }))).toEqual({ method: "PRIMARY", id: 7, email: "" });
    expect(parseUserSettingsAccountEmailForm(new URLSearchParams({ _method: "SENDACTIVATION", id: "7" }))).toEqual({
      method: "SENDACTIVATION",
      id: 7,
      email: "",
    });
  });

  it("absent fields parse empty and junk ids parse null (the FormInt64 convention)", () => {
    expect(parseUserSettingsAccountEmailForm(new URLSearchParams())).toEqual({ method: "", id: null, email: "" });
    expect(parseUserSettingsAccountEmailForm(new URLSearchParams({ id: "junk" })).id).toBeNull();
    expect(parseUserSettingsAccountEmailForm(new URLSearchParams({ id: "-1" })).id).toBeNull();
    expect(parseUserSettingsAccountEmailForm(new URLSearchParams({ id: "007" })).id).toBe(7);
  });
});

// --- the email write ------------------------------------------------------------

describe("applyUserSettingsAccountEmailForm — the add arm (AddEmailAddresses, no-mail convention)", () => {
  it("adds an ACTIVATED secondary that renders in the list (RegisterEmailConfirm=false)", async () => {
    const outcome = await applyUserSettingsAccountEmailForm(env.DB, await loadUserRow(), {
      method: "",
      id: null,
      email: "Work@Example.com",
    });
    expect(outcome).toEqual({ outcome: "added" });
    const data = await loadUserSettingsAccountPageData(env.DB, 1);
    const row = data!.emails.find((entry) => entry.email === "Work@Example.com");
    expect(row).toBeDefined();
    expect(row!.isActivated).toBe(true); // nothing is ever pending — the no-mail convention
    expect(row!.isPrimary).toBe(false);
    expect(row!.canBePrimary).toBe(true);
  });

  it("stores the lower-case lookup key alongside the display-case address", async () => {
    await applyUserSettingsAccountEmailForm(env.DB, await loadUserRow(), { method: "", id: null, email: "Mixed@Example.COM" });
    const row = await drizzle(env.DB).select().from(emailAddresses).get();
    expect(row!.email).toBe("Mixed@Example.COM");
    expect(row!.lowerEmail).toBe("mixed@example.com");
  });

  it("rejects the invalid-syntax matrix with form.email_invalid, writing nothing", async () => {
    const invalid = [
      "", // Required
      "no-at-sign",
      "two@ats@here",
      "@leading.local",
      "trailing@",
      ".dot@start.local",
      "dot.@end.local",
      "dou..ble@local",
      "user@.com",
      "user@-dash.com",
      "unicode@éxample.com",
    ];
    for (const email of invalid) {
      const outcome = await applyUserSettingsAccountEmailForm(env.DB, await loadUserRow(), { method: "", id: null, email });
      expect(outcome).toEqual({ outcome: "invalid", message: userSettingsAccountLocale.email_invalid });
    }
    expect((await drizzle(env.DB).select().from(emailAddresses)).length).toBe(0);
  });

  it("enforces the AddEmailForm binding cap at 254 characters (MaxSize → the HasError arm)", async () => {
    // A SYNTAX-valid address over 254: a 64-char local (the format check's
    // own cap) + a long domain — the format check passes, the binding cap
    // fires. One byte shorter answers added.
    const ok = `${"a".repeat(64)}@${"b".repeat(185)}.com`; // 64 + 1 + 189 = 254 exactly
    expect(ok).toHaveLength(254);
    expect(await applyUserSettingsAccountEmailForm(env.DB, await loadUserRow(), { method: "", id: null, email: ok })).toEqual({ outcome: "added" });
    const over = `${"a".repeat(64)}@${"b".repeat(186)}.com`; // 255
    expect(await applyUserSettingsAccountEmailForm(env.DB, await loadUserRow(), { method: "", id: null, email: over })).toEqual({
      outcome: "invalid",
      message: userSettingsAccountLocale.email_invalid,
    });
  });

  it("rejects duplicates of a row (exact and case-folded) with form.email_been_used", async () => {
    await seedSecondary(1, "taken@example.com");
    expect(
      await applyUserSettingsAccountEmailForm(env.DB, await loadUserRow(), { method: "", id: null, email: "taken@example.com" }),
    ).toEqual({ outcome: "invalid", message: userSettingsAccountLocale.email_been_used });
    expect(await applyUserSettingsAccountEmailForm(env.DB, await loadUserRow(), { method: "", id: null, email: "TAKEN@EXAMPLE.COM" })).toEqual({
      outcome: "invalid",
      message: userSettingsAccountLocale.email_been_used,
    });
  });

  it("treats users.email as taken (the synthesized primary) and scans other users' primaries", async () => {
    await seedUser(2, "bob", "bob@example.com");
    // The doer's own synthesized primary.
    expect(await applyUserSettingsAccountEmailForm(env.DB, await loadUserRow(), { method: "", id: null, email: "alice@example.com" })).toEqual({
      outcome: "invalid",
      message: userSettingsAccountLocale.email_been_used,
    });
    // Another user's primary (the global users scan — upstream's
    // materialized signup row makes this a plain row hit).
    expect(await applyUserSettingsAccountEmailForm(env.DB, await loadUserRow(), { method: "", id: null, email: "BOB@example.com" })).toEqual({
      outcome: "invalid",
      message: userSettingsAccountLocale.email_been_used,
    });
    // Another user's SECONDARY row (the global rows check).
    await seedSecondary(2, "bob-second@example.com");
    expect(await applyUserSettingsAccountEmailForm(env.DB, await loadUserRow(), { method: "", id: null, email: "bob-second@example.com" })).toEqual({
      outcome: "invalid",
      message: userSettingsAccountLocale.email_been_used,
    });
    expect((await drizzle(env.DB).select().from(emailAddresses).where(eq(emailAddresses.userId, 1))).length).toBe(0);
  });
});

describe("applyUserSettingsAccountEmailForm — the PRIMARY arm (MakeActiveEmailPrimary)", () => {
  it("flips users.email onto the row and re-derives the rendered primary, no flag write", async () => {
    const id = await seedSecondary(1, "secondary@example.com");
    const outcome = await applyUserSettingsAccountEmailForm(env.DB, await loadUserRow(), { method: "PRIMARY", id, email: "" });
    expect(outcome).toEqual({ outcome: "primary" });
    expect(await userEmail()).toBe("secondary@example.com");
    // The old primary MATERIALIZES as a demoted activated row (the step-2
    // demotion in the synthesized-primary model) — the address survives.
    const data = await loadUserSettingsAccountPageData(env.DB, 1);
    const old = data!.emails.find((entry) => entry.email === "alice@example.com");
    expect(old).toBeDefined();
    expect(typeof old!.id).toBe("number");
    expect(old).toMatchObject({ isPrimary: false, isActivated: true, canBePrimary: true });
    const fresh = data!.emails.find((entry) => entry.email === "secondary@example.com");
    expect(fresh!.isPrimary).toBe(true); // DERIVED — the row's flag never changed
  });

  it("answers the silent redirect for a null id, a foreign id, and a stale id — writing nothing", async () => {
    const id = await seedSecondary(1, "mine@example.com");
    await seedUser(2, "bob", null);
    const foreignId = await seedSecondary(2, "theirs@example.com");
    for (const probe of [null, foreignId, id + 999]) {
      const outcome = await applyUserSettingsAccountEmailForm(env.DB, await loadUserRow(), { method: "PRIMARY", id: probe, email: "" });
      expect(outcome).toEqual({ outcome: "redirect" }); // the email_primary_not_found arm, silent
    }
    expect(await userEmail()).toBe("alice@example.com");
    expect(await drizzle(env.DB).select().from(emailAddresses).where(eq(emailAddresses.userId, 2))).toHaveLength(1);
  });

  it("is idempotent on a re-post of the now-primary row (the flag-rewrite no-op)", async () => {
    const id = await seedSecondary(1, "secondary@example.com");
    await applyUserSettingsAccountEmailForm(env.DB, await loadUserRow(), { method: "PRIMARY", id, email: "" });
    expect(await applyUserSettingsAccountEmailForm(env.DB, await loadUserRow(), { method: "PRIMARY", id, email: "" })).toEqual({ outcome: "redirect" });
    expect(await userEmail()).toBe("secondary@example.com");
    // No duplicate demotion row materialized.
    expect((await drizzle(env.DB).select().from(emailAddresses)).length).toBe(2);
  });

  it("answers the silent redirect for the doer's own UNACTIVATED row (the is_activated gate — nothing written)", async () => {
    // Direct insert — no landed write path produces an unactivated row (the
    // no-mail convention), but upstream makeEmailPrimaryInternal queries
    // `is_activated = isActive` (email_address.go:255-258), so this shape
    // resolves as ErrEmailAddressNotExist → account.go:67-70's flash-error
    // arm → the module's silent 303 (the module header's activated-gate
    // port). Provenance: wave-polish-matrix-2 (2026-10-27).
    const inserted = await drizzle(env.DB)
      .insert(emailAddresses)
      .values({ userId: 1, email: "pending@example.com", lowerEmail: "pending@example.com", isActivated: false, isPrimary: false })
      .returning({ id: emailAddresses.id })
      .all();
    const outcome = await applyUserSettingsAccountEmailForm(env.DB, await loadUserRow(), {
      method: "PRIMARY",
      id: inserted[0]!.id,
      email: "",
    });
    expect(outcome).toEqual({ outcome: "redirect" });
    expect(await userEmail()).toBe("alice@example.com"); // no flip
    const row = await drizzle(env.DB).select().from(emailAddresses).where(eq(emailAddresses.id, inserted[0]!.id)).get();
    expect(row!.isActivated).toBe(false); // the row is untouched — no demotion write either
  });

  it("SENDACTIVATION answers the already-activated silent arm and changes nothing", async () => {
    const id = await seedSecondary(1, "secondary@example.com");
    expect(await applyUserSettingsAccountEmailForm(env.DB, await loadUserRow(), { method: "SENDACTIVATION", id, email: "" })).toEqual({
      outcome: "redirect",
    });
    expect(await userEmail()).toBe("alice@example.com");
  });
});

// --- the email delete ------------------------------------------------------------

describe("deleteUserSettingsAccountEmail (DeleteEmail → DeleteEmailAddresses)", () => {
  it("parses the id field (the FormInt64 convention)", () => {
    expect(parseUserSettingsAccountEmailDeleteForm(new URLSearchParams({ id: "12" }))).toEqual({ id: 12 });
    expect(parseUserSettingsAccountEmailDeleteForm(new URLSearchParams())).toEqual({ id: null });
    expect(parseUserSettingsAccountEmailDeleteForm(new URLSearchParams({ id: "1.5" }))).toEqual({ id: null });
  });

  it("deletes the scoped row and answers missing for null/stale/foreign ids — nothing about foreign ids leaks", async () => {
    const id = await seedSecondary(1, "doomed@example.com");
    await seedUser(2, "bob", null);
    const foreignId = await seedSecondary(2, "theirs@example.com");
    expect(await deleteUserSettingsAccountEmail(env.DB, 1, { id: null })).toBe("missing");
    expect(await deleteUserSettingsAccountEmail(env.DB, 1, { id: foreignId })).toBe("missing");
    expect(await deleteUserSettingsAccountEmail(env.DB, 2, { id })).toBe("missing");
    expect(await deleteUserSettingsAccountEmail(env.DB, 1, { id })).toBe("deleted");
    expect(await deleteUserSettingsAccountEmail(env.DB, 1, { id })).toBe("missing"); // idempotent
    const left = await drizzle(env.DB).select().from(emailAddresses);
    expect(left.map((row) => row.userId)).toEqual([2]);
  });
});

// --- the deletion arm -------------------------------------------------------------

describe("applyUserSettingsAccountDeleteForm (DeleteAccount over the PAT-as-password model)", () => {
  async function mintFor(userId: number): Promise<string> {
    return (await new TokenService(env.DB).mint({ userId, name: "reauth", scopes: "all" })).plaintext;
  }

  it("parses the password field (absent → empty, the urlencoded convention)", () => {
    expect(parseUserSettingsAccountDeleteForm(new URLSearchParams({ password: "cfg_x" }))).toEqual({ password: "cfg_x" });
    expect(parseUserSettingsAccountDeleteForm(new URLSearchParams())).toEqual({ password: "" });
  });

  it("re-renders invalid for an absent credential, junk, and another user's PAT — the doer survives", async () => {
    const theirs = await (async () => {
      await seedUser(2, "bob", null);
      return mintFor(2);
    })();
    for (const password of ["", "not-a-token", theirs]) {
      const outcome = await applyUserSettingsAccountDeleteForm(env.DB, await loadUserRow(), { password });
      expect(outcome).toEqual({ outcome: "invalid", message: userSettingsAccountLocale.enterred_invalid_password });
    }
    expect(await loadUserRow()).toBeDefined();
  });

  it("refuses an expired PAT (the verify arm's expiry check)", async () => {
    const plaintext = await mintFor(1);
    await env.DB.prepare("UPDATE personal_access_tokens SET expires_at = unixepoch() - 10").run();
    expect(await applyUserSettingsAccountDeleteForm(env.DB, await loadUserRow(), { password: plaintext })).toEqual({
      outcome: "invalid",
      message: userSettingsAccountLocale.enterred_invalid_password,
    });
  });

  it("answers the admin self-guard for an admin with a VALID credential (upstream's order)", async () => {
    await seedUser(3, "root", null, true);
    const plaintext = await mintFor(3);
    const outcome = await applyUserSettingsAccountDeleteForm(env.DB, await loadUserRow(3), { password: plaintext });
    expect(outcome).toEqual({ outcome: "invalid", message: userSettingsAccountLocale.admin_cannot_delete_self });
    expect(await loadUserRow(3)).toBeDefined();
  });

  it("refuses while the account owns repositories (form.still_own_repo)", async () => {
    const plaintext = await mintFor(1);
    await drizzle(env.DB).insert(repositories).values({ id: "r1", storageKey: "r_r1", ownerNamespace: "alice", ownerId: 1, slug: "one", visibility: "public" });
    expect(await applyUserSettingsAccountDeleteForm(env.DB, await loadUserRow(), { password: plaintext })).toEqual({
      outcome: "invalid",
      message: userSettingsAccountLocale.still_own_repo,
    });
    expect(await loadUserRow()).toBeDefined();
  });

  it("checks the repo guard BEFORE the org guard — an account holding both answers form.still_own_repo (account.go's DeleteUser switch order, services/user/user.go:238-251's in-tx sequence)", async () => {
    // Provenance: wave-polish-matrix-2 (2026-10-27). Upstream DeleteAccount
    // switches IsErrUserOwnRepos first and IsErrUserHasOrgs second
    // (account.go:262-267), so the repo message wins when both guards trip.
    const plaintext = await mintFor(1);
    await drizzle(env.DB).insert(repositories).values({ id: "r2", storageKey: "r_r2", ownerNamespace: "alice", ownerId: 1, slug: "two", visibility: "public" });
    await seedUser(2, "theorg", null);
    await drizzle(env.DB).insert(orgMembers).values({ orgId: 2, userId: 1, role: "member", createdAt: new Date() });
    expect(await applyUserSettingsAccountDeleteForm(env.DB, await loadUserRow(), { password: plaintext })).toEqual({
      outcome: "invalid",
      message: userSettingsAccountLocale.still_own_repo,
    });
    expect(await loadUserRow()).toBeDefined();
  });

  it("the cascade sweeps only the DOER's rows — another user's census rows survive (delete.go:74-103's doer-scoped DeleteBeans census)", async () => {
    // Provenance: wave-polish-matrix-2 (2026-10-27). The batch deletes BY
    // the doer's id; bob's email row, watcher row, and session must all
    // outlive alice's deletion.
    const plaintext = await mintFor(1);
    await seedUser(2, "bob", "bob@example.com");
    await seedSecondary(2, "bob-second@example.com");
    await drizzle(env.DB).insert(repoWatchers).values({ repoId: "r8", userId: 2 });
    await drizzle(env.DB).insert(sessions).values({
      id: "sess000002",
      userId: 2,
      sha256Digest: "b".repeat(64),
      rotatedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      lastSeenAt: new Date(),
    });

    expect(await applyUserSettingsAccountDeleteForm(env.DB, await loadUserRow(), { password: plaintext })).toEqual({ outcome: "deleted" });
    expect(await drizzle(env.DB).select().from(users).where(eq(users.id, 1)).get()).toBeUndefined();
    expect(await drizzle(env.DB).select().from(users).where(eq(users.id, 2)).get()).toBeDefined();
    expect(await drizzle(env.DB).select().from(emailAddresses).where(eq(emailAddresses.userId, 2))).toHaveLength(1);
    expect(await drizzle(env.DB).select().from(repoWatchers).where(eq(repoWatchers.userId, 2))).toHaveLength(1);
    expect(await drizzle(env.DB).select().from(sessions).where(eq(sessions.userId, 2))).toHaveLength(1);
  });

  it("refuses while the account holds org memberships (form.still_has_org)", async () => {
    const plaintext = await mintFor(1);
    await seedUser(2, "theorg", null);
    await drizzle(env.DB).insert(orgMembers).values({ orgId: 2, userId: 1, role: "member", createdAt: new Date() });
    expect(await applyUserSettingsAccountDeleteForm(env.DB, await loadUserRow(), { password: plaintext })).toEqual({
      outcome: "invalid",
      message: userSettingsAccountLocale.still_has_org,
    });
    expect(await loadUserRow()).toBeDefined();
  });

  it("deletes: the users row and its cascades (tokens, sessions, emails) plus the FK-less sweep rows", async () => {
    const plaintext = await mintFor(1);
    await seedSecondary(1, "secondary@example.com");
    // The FK-less associable rows the census sweep owns.
    await drizzle(env.DB).insert(repoWatchers).values({ repoId: "r9", userId: 1 });
    await drizzle(env.DB).insert(repoCollaborators).values({ repoId: "r9", userId: 1 });
    await drizzle(env.DB).insert(reactions).values({ userId: 1, issueId: 5, type: "+1" });
    await drizzle(env.DB).insert(issueSubscriptions).values({ userId: 1, issueId: 5, isWatching: true });
    // A live session row (deleted only through the users FK cascade).
    await drizzle(env.DB).insert(sessions).values({
      id: "sess000001",
      userId: 1,
      sha256Digest: "a".repeat(64),
      rotatedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      lastSeenAt: new Date(),
    });

    const outcome = await applyUserSettingsAccountDeleteForm(env.DB, await loadUserRow(), { password: plaintext });
    expect(outcome).toEqual({ outcome: "deleted" });

    expect(await drizzle(env.DB).select().from(users).where(eq(users.id, 1)).get()).toBeUndefined();
    expect(await drizzle(env.DB).select().from(emailAddresses)).toHaveLength(0); // the FK cascade
    expect(await drizzle(env.DB).select().from(sessions)).toHaveLength(0); // the session dies with the account
    expect(await drizzle(env.DB).select().from(repoWatchers)).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(repoCollaborators)).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(reactions)).toHaveLength(0);
    expect(await drizzle(env.DB).select().from(issueSubscriptions)).toHaveLength(0);
    // The re-auth PAT cascaded with the user.
    expect(await new TokenService(env.DB).verify(plaintext)).toBeNull();
  });

  it("the branch-protection whitelist scrub rides the cascade (RemoveUserIDFromProtectedBranch)", async () => {
    const plaintext = await mintFor(1);
    await drizzle(env.DB).insert(protectedBranches).values({
      repoId: "r9",
      ruleName: "main",
      rules: serializeRuleConfig({
        canPush: false,
        enableWhitelist: true,
        whitelistUserIds: [1, 7],
        whitelistTeamIds: [],
        enableMergeWhitelist: true,
        mergeWhitelistUserIds: [1],
        mergeWhitelistTeamIds: [],
        enableBypassAllowlist: false,
        bypassAllowlistUserIds: [],
        bypassAllowlistTeamIds: [],
        canForcePush: false,
        enableForcePushAllowlist: false,
        forcePushAllowlistUserIds: [],
        forcePushAllowlistTeamIds: [],
        canDelete: false,
        enableDeletionAllowlist: false,
        deletionAllowlistUserIds: [],
        deletionAllowlistTeamIds: [],
        enableStatusCheck: false,
        statusCheckContexts: [],
        enableApprovalsWhitelist: false,
        approvalsWhitelistUserIds: [],
        approvalsWhitelistTeamIds: [],
        requiredApprovals: 0,
        blockOnRejectedReviews: false,
        blockOnOfficialReviewRequests: false,
        blockOnCodeownerReviews: false,
        blockOnOutdatedBranch: false,
        dismissStaleApprovals: false,
        ignoreStaleApprovals: false,
        requireSignedCommits: false,
        protectedFilePatterns: "",
        unprotectedFilePatterns: "",
        blockAdminMergeOverride: false,
      }),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(await applyUserSettingsAccountDeleteForm(env.DB, await loadUserRow(), { password: plaintext })).toEqual({ outcome: "deleted" });
    const rule = await drizzle(env.DB).select().from(protectedBranches).get();
    expect(rule).toBeDefined(); // the rule survives; the id is scrubbed
    const config = JSON.parse(rule!.rules) as Record<string, number[]>;
    expect(config.whitelist_user_ids).toEqual([7]);
    expect(config.merge_whitelist_user_ids).toEqual([]);
  });
});

// --- the DOM --------------------------------------------------------------------

describe("the account page DOM (user/settings/account.tmpl at the pin)", () => {
  it("renders the page discriminator, the Account nav item active, and the sibling tabs", async () => {
    const html = await pageHtml();
    expect(html).toContain("user settings account"); // layout_head's pageClass, account.tmpl:1
    expect(html).toContain('class="active item" href="/user/settings/account"'); // navbar.tmpl:7-11
    expect(html).toContain('href="/user/settings"'); // Profile — the item precedes Account
    expect(html).toContain('href="/user/settings/appearance"');
    expect(html).toContain('href="/user/settings/security"');
  });

  it("renders the password section's disabled arm and NO password-change form (the no-password-model rule)", async () => {
    const html = await pageHtml();
    expect(html).toContain(userSettingsAccountLocale.password);
    expect(html).toContain(userSettingsAccountLocale.password_change_disabled);
    expect(html).toContain('class="ui info message"');
    expect(html).not.toContain('name="old_password"'); // account.tmpl:13 — unmounted
    expect(html).not.toContain('name="new_password"');
    expect(html).not.toContain("change_password"); // the form arm's action+button vocabulary
    expect(html).not.toContain("forgot_password"); // rides the form arm only
  });

  it("renders the email rows: the synthesized primary labeled and button-less, secondaries with Remove + Make Primary", async () => {
    const id = await seedSecondary(1, "work@example.com");
    const html = await pageHtml();
    expect(html).toContain(userSettingsAccountLocale.manage_emails);
    expect(html).toContain("<strong>alice@example.com</strong>");
    expect(html).toContain(`<strong>work@example.com</strong>`);
    expect(html).toContain('class="ui primary label"'); // settings.primary
    expect(html).toContain('class="ui green label"'); // settings.activated
    // The synthesized primary renders NO buttons (id-null → no forms).
    const primaryChunk = html.slice(html.indexOf("<strong>alice@example.com</strong>"), html.indexOf("<strong>work@example.com</strong>"));
    expect(primaryChunk).not.toContain("email/delete");
    expect(primaryChunk).not.toContain("PRIMARY");
    // The secondary's Remove + Make Primary forms carry the row id.
    expect(html).toContain('action="/user/settings/account/email/delete"');
    expect(html).toContain(`name="id" value="${String(id)}"`);
    expect(html).toContain('name="_method" value="PRIMARY"');
    expect(html).toContain(userSettingsAccountLocale.delete_email);
    expect(html).toContain(userSettingsAccountLocale.primary_email);
    expect(html).not.toContain("SENDACTIVATION"); // the button never renders
    expect(html).not.toContain("link-action"); // the JS modal pair is not reproduced
    expect(html).not.toContain("show-modal");
  });

  it("renders the add-email form with the upstream contract and the disabled/warning arms absent", async () => {
    const html = await pageHtml();
    expect(html).toContain('action="/user/settings/account/email"');
    expect(html).toContain('id="email" name="email"');
    expect(html).toContain('type="email"');
    expect(html).toContain(userSettingsAccountLocale.add_new_email);
    expect(html).toContain(`>${userSettingsAccountLocale.add_email}</button>`);
    expect(html).not.toContain("disabled"); // CanAddEmails is always true — no pending state exists
    expect(html).not.toContain(userSettingsAccountLocale.requires_activation); // no unactivated row can exist
  });

  it("the error slot renders the negative message and the submitted email re-renders (not secret-like)", async () => {
    const html = await pageHtml(userSettingsAccountLocale.email_been_used, "kept@example.com");
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain(userSettingsAccountLocale.email_been_used);
    expect(html).toContain('value="kept@example.com"');
  });

  it("renders the deletion section: the error header, the prompt with the strong arm, the empty password field", async () => {
    const html = await pageHtml();
    expect(html).toContain('class="ui top attached error header"');
    expect(html).toContain(userSettingsAccountLocale.delete_account);
    expect(html).toContain("This operation will permanently delete your user account. It");
    expect(html).toContain("<strong>CANNOT</strong>");
    expect(html).toContain(" be undone.");
    expect(html).toContain('action="/user/settings/account/delete"');
    expect(html).toContain('id="password-confirmation" name="password"');
    expect(html).toContain('type="password"');
    expect(html).toContain(`>${userSettingsAccountLocale.confirm_delete_account}</button>`);
    // The credential never carries a value (the secrets value rule) — the
    // password input has no value attribute at all.
    expect(html).not.toContain('name="password" value=');
    // The UserDeleteWithComments arm never renders (the setting defaults 0).
    expect(html).not.toContain("ghost comments");
  });

  it("an UNACTIVATED row renders the Requires-activation label, Make-Primary-less but Remove-ful (account.tmpl:44-68's CanBePrimary = IsActivated gate)", async () => {
    // Direct insert — no write path produces this shape (the no-mail
    // convention, the module header); the template arm must hold anyway.
    // Provenance: wave-polish-matrix-2 (2026-10-27).
    await drizzle(env.DB).insert(emailAddresses).values({ userId: 1, email: "pending@example.com", lowerEmail: "pending@example.com", isActivated: false, isPrimary: false });
    const html = await pageHtml();
    expect(html).toContain(userSettingsAccountLocale.requires_activation); // the settings.requires_activation label renders
    const chunk = html.slice(html.indexOf("<strong>pending@example.com</strong>"), html.indexOf('class="ui bottom attached segment"'));
    expect(chunk).toContain('action="/user/settings/account/email/delete"'); // Remove stays buttoned
    expect(chunk).not.toContain(userSettingsAccountLocale.primary_email); // canBePrimary=false → no Make Primary (account.tmpl:62-68)
    expect(chunk).not.toContain('name="_method" value="PRIMARY"');
  });

  it("after a PRIMARY flip the render complements: the new primary is button-less, the DEMOTED old primary is buttoned with its materialized id", async () => {
    // Provenance: wave-polish-matrix-2 (2026-10-27) — the DOM half of the
    // demotion-materialization arm (account.tmpl's `not .IsPrimary` gates
    // over the loader's derived flags; the materialized row id carries the
    // Remove/Make-Primary forms, account.tmpl:58-68).
    const id = await seedSecondary(1, "secondary@example.com");
    await applyUserSettingsAccountEmailForm(env.DB, await loadUserRow(), { method: "PRIMARY", id, email: "" });
    const data = await loadUserSettingsAccountPageData(env.DB, 1);
    if (data === null) throw new Error("page data missing");
    const html = renderToString(<UserSettingsAccountPage ctx={ctx} data={data} error={null} email="" />);
    const demoted = data.emails.find((entry) => entry.email === "alice@example.com");
    expect(demoted).toBeDefined();
    expect(typeof demoted!.id).toBe("number");
    // The new primary's chunk: no forms at all.
    const primaryChunk = html.slice(html.indexOf("<strong>secondary@example.com</strong>"), html.indexOf("<strong>alice@example.com</strong>"));
    expect(primaryChunk).not.toContain("email/delete");
    expect(primaryChunk).not.toContain("PRIMARY");
    // The demoted row's chunk: Remove + Make Primary carry its row id.
    const demotedChunk = html.slice(html.indexOf("<strong>alice@example.com</strong>"), html.indexOf('class="ui bottom attached segment"'));
    expect(demotedChunk).toContain('action="/user/settings/account/email/delete"');
    expect(demotedChunk).toContain(`name="id" value="${String(demoted!.id)}"`);
    expect(demotedChunk).toContain('name="_method" value="PRIMARY"');
  });

  it("the invalid re-render carries the email HTML-ESCAPED (no attribute breakout) and the password field stays valueless — carried email never credential", async () => {
    // Provenance: wave-polish-matrix-2 (2026-10-27) — the mount record's
    // re-render shape `{ error, email }` crossed with the secrets value
    // rule (account.tmpl:55's value="{{.Email}}" carries upstream-side too;
    // the deletion form's password input never does, account.tmpl:122).
    const nasty = 'odd"onmouseover="x@b.co';
    const html = await pageHtml(userSettingsAccountLocale.email_been_used, nasty);
    expect(html).toContain('class="ui negative message"');
    expect(html).toContain(userSettingsAccountLocale.email_been_used);
    expect(html).toContain('value="odd&quot;onmouseover=&quot;x@b.co"'); // hono/jsx escaping
    expect(html).not.toContain('onmouseover="'); // no unescaped attribute breakout
    expect(html).not.toContain('name="password" value='); // the credential never carries back
  });

  it("the plain GET renders no negative message (the error slot is POST-only)", async () => {
    // Provenance: wave-polish-matrix-2 (2026-10-27).
    const html = await pageHtml();
    expect(html).not.toContain("ui negative message");
  });

  it("the full-document render path matches the component path", async () => {
    const data = await loadUserSettingsAccountPageData(env.DB, 1);
    expect(data).not.toBeNull();
    const html = renderUserSettingsAccountPage(ctx, data!, null, "");
    expect(html).toContain("user settings account");
    expect(html).toContain(userSettingsAccountLocale.password_change_disabled);
  });
});
