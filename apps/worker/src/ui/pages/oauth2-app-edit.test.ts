/**
 * The web OAuth2-app write arms' F8 + F3 pins (v1.5.2 ledger §1.3) over the
 * real store (the oauth2-token.test.ts harness shape):
 *
 *   - F8 — RegenerateSecret touches ONLY the client_secret column
 *     (models/auth/oauth2.go:213-224's `Cols("client_secret")`: updatedAt
 *     rides untouched, the drift that bumped it is dead).
 *   - F3 — each successful web write emits its audit row through
 *     services/oauth2/audit-arms.ts's emitOAuth2ApplicationAudit, the
 *     RecordScoped shape whose variant follows the OWNER (an individual ⇒
 *     user:*, an org row ⇒ organization:*, uid 0 ⇒ the system:* variant;
 *     services/audit/scoped.go:39-63 + :108-131); the revoke write half
 *     carries the user-only OAuth2ApplicationRevoke row
 *     (oauth2_common.go:220) and refuses foreign/missing grants
 *     (:204-207).
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { auditEvents, oauth2Applications, users } from "../../db/schema";
import type { OAuth2AppEditForm } from "./oauth2-app-edit";
import {
  createOauth2ApplicationFromForm,
  deleteOauth2ApplicationFromForm,
  regenerateOauth2ApplicationSecret,
  revokeOauth2GrantFromForm,
  saveOauth2ApplicationFromForm,
} from "./oauth2-app-edit";
import { getOrCreateGrant } from "../../services/oauth2/grants";

const T0 = new Date("2026-01-01T00:00:00Z");

beforeAll(applyAuthD1Migrations);

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM audit_event").run();
  await env.DB.prepare("DELETE FROM oauth2_application").run();
  await env.DB.prepare("DELETE FROM oauth2_grant").run();
  await env.DB.prepare("DELETE FROM users").run();
});

const FORM: OAuth2AppEditForm = {
  name: "web app",
  redirectUrisRaw: "https://example.com/callback",
  confidentialClient: true,
  skipSecondaryAuthorization: false,
};

let seq = 0;

async function seedOwner(type: "user" | "org" = "user"): Promise<{ id: number; username: string }> {
  const name = `owner${++seq}`;
  const row = await drizzle(env.DB)
    .insert(users)
    .values({ username: name, usernameLower: name, type, status: "active", createdAt: T0 })
    .returning();
  return { id: row[0]!.id, username: row[0]!.username };
}

async function seedApp(uid: number): Promise<{ id: number; name: string; clientId: string }> {
  const created = await createOauth2ApplicationFromForm(env.DB, uid, FORM, T0);
  if (created.kind !== "created") throw new Error("seed create failed");
  return { id: created.row.id, name: created.row.name, clientId: created.row.clientId };
}

const auditRows = async (): Promise<{ action: string; actorId: number; scopeType: string; scopeId: string; message: string }[]> =>
  (await drizzle(env.DB).select().from(auditEvents).all()).map((row) => ({
    action: row.action,
    actorId: row.actorId,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    message: row.message,
  }));

// ---------------------------------------------------------------------------
// F8 — the regenerate's Cols("client_secret") posture.
// ---------------------------------------------------------------------------

describe("regenerateOauth2ApplicationSecret (F8 — oauth2.go:213-224)", () => {
  it("rotates the secret WITHOUT touching updatedAt", async () => {
    const owner = await seedOwner();
    const app = await seedApp(owner.id);
    const before = (await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, app.id)).get())!;
    expect(before.updatedAt.getTime()).toBe(T0.getTime());

    // the wall clock is now (2026-11+) — a bumped updatedAt would visibly
    // drift off the seeded T0 stamp
    const regenerated = await regenerateOauth2ApplicationSecret(env.DB, owner.id, app.id);
    expect(regenerated.kind).toBe("ok");
    const after = (await drizzle(env.DB).select().from(oauth2Applications).where(eq(oauth2Applications.id, app.id)).get())!;
    // the drift bumped updatedAt here; the pin keeps the created stamp
    expect(after.updatedAt.getTime()).toBe(T0.getTime());
    expect(after.clientSecret).not.toBe(before.clientSecret);
    expect(after.clientSecret).not.toBe("");
    expect(regenerated.kind === "ok" && regenerated.secret.startsWith("gto_")).toBe(true);
  });

  it("a foreign owner's regenerate is the not_found arm (and emits nothing)", async () => {
    const owner = await seedOwner();
    const stranger = await seedOwner();
    const app = await seedApp(owner.id);
    expect(await auditRows()).toHaveLength(1); // the seed create's add row
    expect((await regenerateOauth2ApplicationSecret(env.DB, stranger.id, app.id)).kind).toBe("not_found");
    expect(await auditRows()).toHaveLength(1); // the not_found arm emitted nothing
  });
});

// ---------------------------------------------------------------------------
// F3 — the RecordScoped web arms.
// ---------------------------------------------------------------------------

describe("the web audit arms (F3 — oauth2_common.go:77/:143/:170/:189/:220)", () => {
  it("create emits user:oauth2application:add scoped to the owner", async () => {
    const owner = await seedOwner();
    const app = await seedApp(owner.id);
    const rows = await auditRows();
    expect(rows).toEqual([
      {
        action: "user:oauth2application:add",
        actorId: owner.id,
        scopeType: "user",
        scopeId: String(owner.id),
        message: `Added OAuth2 application ${app.name} for user ${owner.username}.`,
      },
    ]);
  });

  it("an ORG owner's arms render the organization:* variants; uid 0 renders the system:* variants", async () => {
    const org = await seedOwner("org");
    await seedApp(org.id);
    expect((await auditRows()).map((row) => row.action)).toEqual(["organization:oauth2application:add"]);
    expect((await auditRows())[0]!.scopeType).toBe("organization");

    const adminApp = await seedApp(0);
    const adminRows = await auditRows();
    expect(adminRows.map((row) => row.action)).toEqual(["organization:oauth2application:add", "system:oauth2application:add"]);
    const systemRow = (
      await drizzle(env.DB)
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, "system:oauth2application:add"))
        .get()
    )!;
    expect(systemRow.scopeType).toBe("system");
    expect(systemRow.scopeId).toBe("");
    expect(systemRow.scopeName).toBeNull();
    expect(systemRow.message).toBe(`Added instance-wide OAuth2 application ${adminApp.name}.`);
  });

  it("save emits user:oauth2application:update; delete emits user:oauth2application:remove", async () => {
    const owner = await seedOwner();
    const app = await seedApp(owner.id);
    const saved = await saveOauth2ApplicationFromForm(env.DB, owner.id, app.id, { ...FORM, name: "renamed" }, T0);
    expect(saved.kind).toBe("saved");
    const deleted = await deleteOauth2ApplicationFromForm(env.DB, owner.id, app.id);
    expect(deleted.kind).toBe("deleted");

    const rows = await auditRows();
    expect(rows.map((row) => row.action)).toEqual([
      "user:oauth2application:add",
      "user:oauth2application:update",
      "user:oauth2application:remove",
    ]);
    expect(rows[1]!.message).toBe(`Updated OAuth2 application renamed of user ${owner.username}.`);
    // the remove names the app AS LOADED PRE-DELETE — the rename landed, so
    // the current name rides (upstream loads the app first, DeleteApp
    // records app.Name from that row, oauth2_common.go:180-192)
    expect(rows[2]!.message).toBe(`Removed OAuth2 application renamed of user ${owner.username}.`);
  });

  it("regenerate emits user:oauth2application:secret", async () => {
    const owner = await seedOwner();
    const app = await seedApp(owner.id);
    await regenerateOauth2ApplicationSecret(env.DB, owner.id, app.id);
    const rows = await auditRows();
    expect(rows.map((row) => row.action)).toEqual(["user:oauth2application:add", "user:oauth2application:secret"]);
    expect(rows[1]!.message).toBe(`Regenerated secret for OAuth2 application ${FORM.name} of user ${owner.username}.`);
  });

  it("revokeOauth2GrantFromForm: the owner's grant revokes + emits the user-only revoke row; a foreign grant 404-shells", async () => {
    const owner = await seedOwner();
    const stranger = await seedOwner();
    const app = await seedApp(owner.id);
    const { grant: foreignGrant } = await getOrCreateGrant(env.DB, { userId: stranger.id, applicationId: app.id, scope: "openid" }, T0);
    // grants belong to individuals — a grant that is not the owner's takes
    // the same NotFound shell upstream answers (oauth2_common.go:204-207)
    expect((await revokeOauth2GrantFromForm(env.DB, owner.id, foreignGrant.id)).kind).toBe("not_found");
    expect(await auditRows()).toEqual([{ action: "user:oauth2application:add", actorId: owner.id, scopeType: "user", scopeId: String(owner.id), message: `Added OAuth2 application ${app.name} for user ${owner.username}.` }]);

    const { grant } = await getOrCreateGrant(env.DB, { userId: owner.id, applicationId: app.id, scope: "openid" }, T0);
    const revoked = await revokeOauth2GrantFromForm(env.DB, owner.id, grant.id);
    expect(revoked).toEqual({ kind: "revoked", appName: app.name });
    const rows = await auditRows();
    expect(rows[1]).toEqual({
      action: "user:oauth2application:revoke",
      actorId: owner.id,
      scopeType: "user",
      scopeId: String(owner.id),
      message: `Revoked OAuth2 grant for application ${app.name} of user ${owner.username}.`,
    });
  });

  it("the failure arms (invalid form, foreign save) emit nothing beyond the writes that succeeded", async () => {
    const owner = await seedOwner();
    // the bind failure
    expect((await createOauth2ApplicationFromForm(env.DB, owner.id, { ...FORM, name: "" }, T0)).kind).toBe("invalid");
    expect(await auditRows()).toEqual([]);
    await seedApp(owner.id); // the seed's +1 add row
    expect((await saveOauth2ApplicationFromForm(env.DB, owner.id, 999999, FORM, T0)).kind).toBe("not_found");
    expect(await auditRows()).toHaveLength(1); // only the seed's add row
  });
});
