/**
 * The admin user avatar write arms' seam suite (PORT-FIRST: the two POST
 * seams are driven DIRECTLY — the ui/index.ts fold is a recorded handoff
 * riding behind the orchestrator's index.ts ownership; the mount recipe
 * lives in the module header).
 *
 * Coverage (upstream at the pin: web.go:820-821's routes,
 * admin/users.go:684-712's handlers over the shared AvatarForm):
 *
 *   - THE UPLOAD ARM (users.go:684-702): a valid multipart `avatar` part
 *     lands the R2 object at `avatars/u_<id>` (byte-identical under-cap
 *     store, typed PNG) and flips `users.use_custom_avatar`; the redirect
 *     is the target's admin page (`/-/admin/users/{id}`).
 *   - THE EMPTY SUBMIT: no file part is a silent NO-OP (the no-JS
 *     reduction — upstream's `source=""` post would clear the marker
 *     through profile.go:127; the dropped `source` radio must not delete
 *     the target's avatar from a form that cannot express the choice).
 *   - THE PARSE-ERROR ARM: a non-image upload 303s silently (upstream's
 *     flash-error arm, users.go:692-693 — the flash drops), stores nothing.
 *   - THE UNKNOWN-TARGET ARM (prepareUserInfo, users.go:269-278): both
 *     arms redirect to the LIST (`/-/admin/users`), never a 404, and never
 *     read the body / touch the bucket.
 *   - THE DELETE ARM (users.go:701-712): marker + object both die; a
 *     missing object deletes nothing and still succeeds (the API arm's
 *     tolerance); the redirect is unconditional.
 *   - THE ORG-TARGET ARM: any users row passes (orgs ARE users rows,
 *     SPEC-0007 — upstream GetUserByID has no type gate), so an org id
 *     gets its avatar set like the org arm's AsUser delegation.
 *
 * Fixture discipline (the org-settings matrix pattern): tables wiped per
 * test (children first), the shared `avatars/` R2 prefix swept per test,
 * ids captured at seed time — never hardcoded.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { users } from "../../db/schema";
import { avatarExists } from "../../services/avatars";
import {
  ADMIN_USERS_LIST_LINK,
  adminUserAvatarDelete,
  adminUserAvatarUpload,
  adminUserLink,
  loadAdminAvatarUser,
} from "./admin-users-avatar";

// --- fixtures ----------------------------------------------------------------

const T0 = new Date(1_700_000_000 * 1000); // 2023-11-14T22:13:20Z

/** Tables the fixtures touch (children first — the org-settings matrix's
 *  cleanup-list convention; "sessions" explicit because the wipes must not
 *  leave rows behind for the next seed round). */
const FIXTURE_TABLES = ["sessions", "users"];

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  for (const table of FIXTURE_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // The avatar objects live in R2, outside the D1 wipes — sweep the shared
  // `avatars/` prefix so the pair's read-backs start from a clean bucket.
  const listed = await env.REPO_PACKS.list({ prefix: "avatars/" });
  for (const object of listed.objects) {
    await env.REPO_PACKS.delete(object.key);
  }
});

/** A minimal valid PNG (1x1) — the avatar processor's accepted input; small
 *  enough to store VERBATIM (under the origin cap, no resize on Workers). */
const PNG_1X1 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (char) => char.charCodeAt(0),
);

interface Seeded {
  adminId: number; // dave — the site admin (irrelevant at the seam level:
  //   the adminPagePrologue gate rides the mount, the seams are post-gate)
  targetId: number; // alice — the plain user the admin edits
}

async function seedUsers(): Promise<Seeded> {
  const inserted = await drizzle(env.DB)
    .insert(users)
    .values([
      { username: "dave", usernameLower: "dave", isAdmin: true, status: "active", createdAt: T0 },
      { username: "alice", usernameLower: "alice", status: "active", createdAt: T0 },
    ])
    .returning({ id: users.id })
    .all();
  const dave = inserted[0];
  const alice = inserted[1];
  if (dave === undefined || alice === undefined) throw new Error("seed failed");
  return { adminId: dave.id, targetId: alice.id };
}

/** The multipart avatar POST body (upstream AvatarForm's `avatar` file
 *  field); `file: null` posts the empty input (the no-file submit). */
function avatarPostBody(file: Blob | null): Request {
  const form = new FormData();
  if (file !== null) form.set("avatar", file, "avatar.png");
  return new Request("https://test.local/-/admin/users/1/avatar", {
    method: "POST",
    body: form,
  });
}

/** The marker's live value off the row. */
async function marker(userId: number): Promise<boolean> {
  const row = await drizzle(env.DB)
    .select({ useCustomAvatar: users.useCustomAvatar })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  if (row === undefined) throw new Error("marker: user row vanished");
  return row.useCustomAvatar;
}

// --- the upload arm ----------------------------------------------------------

describe("adminUserAvatarUpload (upstream admin.AvatarPost, users.go:684-702)", () => {
  it("stores the PNG verbatim at avatars/u_<id>, flips the marker, 303s onto the admin page", async () => {
    const { targetId } = await seedUsers();

    const outcome = await adminUserAvatarUpload(
      env.REPO_PACKS,
      env.DB,
      targetId,
      avatarPostBody(new Blob([PNG_1X1], { type: "image/png" })),
    );

    expect(outcome).toEqual({ redirect: adminUserLink(targetId) });
    const stored = await env.REPO_PACKS.get(`avatars/u_${targetId}`);
    expect(stored).not.toBeNull();
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(PNG_1X1);
    expect(stored!.httpMetadata?.contentType).toBe("image/png");
    expect(await marker(targetId)).toBe(true);
  });

  it("treats an empty submit (no file part) as a silent no-op — the dropped source radio must not clear the marker", async () => {
    const { targetId } = await seedUsers();
    // The target already HAS a custom avatar: the empty submit must not
    // delete it (upstream's source="" arm would — profile.go:127 — and the
    // no-JS form cannot express that choice).
    await adminUserAvatarUpload(env.REPO_PACKS, env.DB, targetId, avatarPostBody(new Blob([PNG_1X1], { type: "image/png" })));
    expect(await marker(targetId)).toBe(true);

    const outcome = await adminUserAvatarUpload(env.REPO_PACKS, env.DB, targetId, avatarPostBody(null));

    expect(outcome).toEqual({ redirect: adminUserLink(targetId) });
    expect(await avatarExists(env.REPO_PACKS, { kind: "user", principalId: targetId })).toBe(true);
    expect(await marker(targetId)).toBe(true);
  });

  it("answers a non-image upload with the silent redirect (the flash-error arm, dropped) and stores nothing", async () => {
    const { targetId } = await seedUsers();
    const junk = avatarPostBody(new Blob([new Uint8Array([0x00, 0x01, 0x02, 0x03])], { type: "application/octet-stream" }));

    const outcome = await adminUserAvatarUpload(env.REPO_PACKS, env.DB, targetId, junk);

    expect(outcome).toEqual({ redirect: adminUserLink(targetId) });
    expect(await avatarExists(env.REPO_PACKS, { kind: "user", principalId: targetId })).toBe(false);
    expect(await marker(targetId)).toBe(false);
  });

  it("redirects an unknown target to the LIST (prepareUserInfo's arm — never a 404) without reading the body", async () => {
    await seedUsers();

    const outcome = await adminUserAvatarUpload(
      env.REPO_PACKS,
      env.DB,
      424242,
      avatarPostBody(new Blob([PNG_1X1], { type: "image/png" })),
    );

    expect(outcome).toEqual({ redirect: ADMIN_USERS_LIST_LINK });
    expect(await avatarExists(env.REPO_PACKS, { kind: "user", principalId: 424242 })).toBe(false);
  });

  it("accepts an org-typed users row (orgs ARE users rows — upstream GetUserByID has no type gate)", async () => {
    await seedUsers();
    const orgs = await drizzle(env.DB)
      .insert(users)
      .values([
        {
          username: "forge",
          usernameLower: "forge",
          type: "org",
          status: "active",
          createdAt: T0,
        },
      ])
      .returning({ id: users.id })
      .all();
    const orgId = orgs[0]!.id;

    const outcome = await adminUserAvatarUpload(
      env.REPO_PACKS,
      env.DB,
      orgId,
      avatarPostBody(new Blob([PNG_1X1], { type: "image/png" })),
    );

    expect(outcome).toEqual({ redirect: adminUserLink(orgId) });
    expect(await avatarExists(env.REPO_PACKS, { kind: "user", principalId: orgId })).toBe(true);
    expect(await marker(orgId)).toBe(true);
  });
});

// --- the delete arm ----------------------------------------------------------

describe("adminUserAvatarDelete (upstream admin.DeleteAvatar, users.go:701-712)", () => {
  it("clears the marker and the object, 303ing onto the admin page", async () => {
    const { targetId } = await seedUsers();
    await adminUserAvatarUpload(env.REPO_PACKS, env.DB, targetId, avatarPostBody(new Blob([PNG_1X1], { type: "image/png" })));
    expect(await marker(targetId)).toBe(true);

    const outcome = await adminUserAvatarDelete(env.REPO_PACKS, env.DB, targetId);

    expect(outcome).toEqual({ redirect: adminUserLink(targetId) });
    expect(await avatarExists(env.REPO_PACKS, { kind: "user", principalId: targetId })).toBe(false);
    expect(await marker(targetId)).toBe(false);
  });

  it("succeeds as a no-op when no avatar was ever set (the API arm's missing-object tolerance)", async () => {
    const { targetId } = await seedUsers();

    const outcome = await adminUserAvatarDelete(env.REPO_PACKS, env.DB, targetId);

    expect(outcome).toEqual({ redirect: adminUserLink(targetId) });
    expect(await marker(targetId)).toBe(false);
  });

  it("redirects an unknown target to the LIST (prepareUserInfo's arm)", async () => {
    await seedUsers();

    const outcome = await adminUserAvatarDelete(env.REPO_PACKS, env.DB, 424242);

    expect(outcome).toEqual({ redirect: ADMIN_USERS_LIST_LINK });
  });
});

// --- the lookup the arms share ----------------------------------------------

describe("loadAdminAvatarUser (prepareUserInfo, users.go:269-278)", () => {
  it("resolves an existing users row by id and nulls the miss", async () => {
    const { targetId } = await seedUsers();

    expect(await loadAdminAvatarUser(env.DB, targetId)).toEqual({ id: targetId });
    expect(await loadAdminAvatarUser(env.DB, 987654)).toBeNull();
  });
});
