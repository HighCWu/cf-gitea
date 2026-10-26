/**
 * The user settings SSH/GPG keys page module's tests (pages wave 54, the
 * UNMOUNTED `/user/settings/keys` module): the write arms over the landed
 * stores with real D1 via the vitest plugin (generated migrations in
 * beforeAll) — the SSH add's parse/fingerprint/name sequence, the GPG add's
 * parse/email-gate/key-id sequence over a built-from-bytes v4 armor, the
 * deletes, the loader's type/primary filters and the render's DOM contract.
 * The render runs through hono/jsx renderToString (the render.test.tsx
 * harness); the module has no route yet (the HANDOFF NOTE in the module
 * header).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { gpgKeys, publicKeys, users } from "../../db/schema";
import { shellAssetsFromManifest, type UiContext } from "../ui-context";
import type { UiManifest } from "../manifest";
import type { Viewer } from "../viewer";
import {
  addGpgKeyFromForm,
  addSshKeyFromForm,
  deleteGpgKey,
  deleteSshKey,
  formatKeyDate,
  loadUserSettingsKeysOwner,
  loadUserSettingsKeysPageData,
  paddedKeyID,
  parseUserSettingsKeysDeleteForm,
  parseUserSettingsKeysForm,
  renderUserSettingsKeysPage,
  userSettingsKeysLocale,
  type UserSettingsKeysForm,
} from "./user-settings-keys";

// --- fixtures ----------------------------------------------------------------

const NOW = new Date(1_700_000_000_000); // 2023-11-14T22:13:20Z — the fixed clock

const manifest: UiManifest = {
  "web_src/js/iife.ts": { file: "js/iife.abcd1234.js" },
  "web_src/js/index.ts": { file: "js/index.deadbeef.js", css: ["css/index.1111aaaa.css"] },
  "web_src/css/themes/theme-gitea-light.css": { file: "css/theme-gitea-light.4444dddd.css" },
  "web_src/js/user-events.sharedworker.ts": { file: "js/user-events.5555eeee.js" },
};

const selfViewer: Viewer = { kind: "user", id: 1, username: "alice", isAdmin: false };
const ctx: UiContext = {
  viewer: selfViewer,
  origin: "https://test.local",
  assets: shellAssetsFromManifest(manifest),
};

let aliceId = 0;

async function seedUser(username: string, email: string): Promise<number> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({ username, usernameLower: username.toLowerCase(), email, createdAt: NOW })
    .returning()
    .all();
  return rows[0]!.id;
}

// --- byte builders (a real OpenSSH wire key + a real v4 OpenPGP packet set) --

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, part) => acc + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A well-formed `ssh-ed25519 <base64> <comment>` line: the wire blob is the
 *  type string + 32 material bytes (the parser's clean string-sequence walk). */
function sshEd25519Key(seed: number): string {
  const type = new TextEncoder().encode("ssh-ed25519");
  const material = new Uint8Array(32);
  for (let i = 0; i < 32; i++) material[i] = (i + seed) & 0xff;
  return `ssh-ed25519 ${toBase64(concat(lengthPrefixed(type), lengthPrefixed(material)))} alice@laptop`;
}

/** MPI (RFC 4880 §3.2): 2-byte bit length + the octets. */
function mpi(bytes: Uint8Array): Uint8Array {
  let bits = bytes.length * 8;
  const top = bytes[0]!;
  for (let mask = 0x80; mask !== 0 && (top & mask) === 0; mask >>= 1) bits -= 1;
  return concat(new Uint8Array([bits >> 8, bits & 0xff]), bytes);
}

function be32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

/** Old-format packet header (RFC 4880 §4.2): 0x80 | tag<<2 | lengthType. */
function oldPacket(tag: number, body: Uint8Array): Uint8Array {
  if (body.length >= 256) {
    return concat(new Uint8Array([0x80 | (tag << 2) | 2]), new Uint8Array([body.length >> 8, body.length & 0xff]), body);
  }
  return concat(new Uint8Array([0x80 | (tag << 2) | 0]), new Uint8Array([body.length]), body);
}

function rsaV4KeyBody(created: number, materialSeed: number): Uint8Array {
  const n = new Uint8Array(128).fill(0xab);
  n[0] = 0xd5; // top bits set → a clean 1024-bit MPI
  const e = Uint8Array.of(0x01, 0x00, 0x01); // 65537
  for (let i = 0; i < n.length; i++) n[i] = (n[i]! + materialSeed) & 0xff;
  n[0] = 0xd5;
  return concat(Uint8Array.of(4), be32(created), Uint8Array.of(1), mpi(n), mpi(e));
}

/** The v4 key id: SHA-1 over `0x99 ‖ len16 ‖ body`, low 64 bits hex upper. */
async function v4KeyId(body: Uint8Array): Promise<string> {
  const framed = concat(Uint8Array.of(0x99, body.length >> 8, body.length & 0xff), body);
  const digest = await crypto.subtle.digest("SHA-1", framed);
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(-16).toUpperCase();
}

/** A minimal armored v4 RSA key: primary (+ optional subkey) + a user id. */
async function rsaV4Armor(options: { created: number; email: string; withSubkey?: boolean; subkeySeed?: number }): Promise<{ armor: string; keyId: string; subkeyId: string | null }> {
  const body = rsaV4KeyBody(options.created, 0);
  const keyId = await v4KeyId(body);
  const packets = [oldPacket(6, body)];
  let subkeyId: string | null = null;
  if (options.withSubkey === true) {
    const subkeyBody = rsaV4KeyBody(options.created + 60, options.subkeySeed ?? 3);
    subkeyId = await v4KeyId(subkeyBody);
    packets.push(oldPacket(14, subkeyBody));
  }
  packets.push(oldPacket(13, new TextEncoder().encode(`Test User <${options.email}>`)));
  const base64 = toBase64(concat(...packets));
  const lines = base64.match(/.{1,64}/g) ?? [];
  const armor = ["-----BEGIN PGP PUBLIC KEY BLOCK-----", "", ...lines, "-----END PGP PUBLIC KEY BLOCK-----", ""].join("\n");
  return { armor, keyId, subkeyId };
}

function sshForm(overrides: Partial<UserSettingsKeysForm> = {}): UserSettingsKeysForm {
  return { type: "ssh", title: "laptop", content: sshEd25519Key(1), signature: "", ...overrides };
}

async function resetTables(): Promise<void> {
  for (const table of ["gpg_keys", "public_keys", "email_addresses", "users"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
}

beforeAll(async () => {
  await applyAuthD1Migrations();
});

beforeEach(async () => {
  await resetTables();
  aliceId = await seedUser("alice", "alice@test.local");
});

// --- the write arms -----------------------------------------------------------

describe("addSshKeyFromForm (upstream KeysPost \"ssh\" over the landed insert)", () => {
  it("adds a parsed key: normalized content, SHA256 fingerprint, write mode, type user", async () => {
    const owner = (await loadUserSettingsKeysOwner(env.DB, aliceId))!;
    const result = await addSshKeyFromForm(env.DB, owner, sshForm({ content: `  ${sshEd25519Key(1)}\n` }));
    expect(result).toEqual({ outcome: "created", kind: "ssh", label: "laptop" });
    const rows = await drizzle(env.DB).select().from(publicKeys).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ownerId).toBe(aliceId);
    expect(rows[0]!.name).toBe("laptop");
    expect(rows[0]!.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(rows[0]!.content).toBe(sshEd25519Key(1)); // trimmed, comment kept
    expect(rows[0]!.mode).toBe(2);
    expect(rows[0]!.type).toBe(1);
    expect(rows[0]!.verified).toBe(false);
  });

  it("refuses a reused fingerprint globally (settings.ssh_key_been_used, content field)", async () => {
    const owner = (await loadUserSettingsKeysOwner(env.DB, aliceId))!;
    await addSshKeyFromForm(env.DB, owner, sshForm({ title: "first" }));
    const again = await addSshKeyFromForm(env.DB, owner, sshForm({ title: "second" }));
    expect(again).toEqual({ outcome: "invalid", kind: "ssh", message: userSettingsKeysLocale.ssh_key_been_used, field: "content" });
  });

  it("refuses a reused per-owner title (settings.ssh_key_name_used, title field)", async () => {
    const owner = (await loadUserSettingsKeysOwner(env.DB, aliceId))!;
    await addSshKeyFromForm(env.DB, owner, sshForm());
    const again = await addSshKeyFromForm(env.DB, owner, sshForm({ content: sshEd25519Key(7) }));
    expect(again).toEqual({ outcome: "invalid", kind: "ssh", message: userSettingsKeysLocale.ssh_key_name_used, field: "title" });
  });

  it("answers the binder arm for an empty title and the parse 422 for junk content", async () => {
    const owner = (await loadUserSettingsKeysOwner(env.DB, aliceId))!;
    expect(await addSshKeyFromForm(env.DB, owner, sshForm({ title: "" }))).toEqual({
      outcome: "invalid",
      kind: "ssh",
      message: "Title: Required",
      field: "title",
    });
    const junk = await addSshKeyFromForm(env.DB, owner, sshForm({ content: "not a key" }));
    expect(junk).toMatchObject({ outcome: "invalid", kind: "ssh", field: "content" });
    expect((junk as { message: string }).message).toBe("Cannot verify your SSH key: invalid key format: illegal base64 data");
  });
});

describe("addGpgKeyFromForm (upstream KeysPost \"gpg\" over the landed insert)", () => {
  it("adds a parsed primary + subkey: ids, capability flags, expiry inheritance", async () => {
    const owner = (await loadUserSettingsKeysOwner(env.DB, aliceId))!;
    const fixture = await rsaV4Armor({ created: 1_600_000_000, email: "alice@test.local", withSubkey: true });
    const result = await addGpgKeyFromForm(env.DB, owner, { type: "gpg", title: "none", content: fixture.armor, signature: "" });
    expect(result).toEqual({ outcome: "created", kind: "gpg", label: fixture.keyId });
    const rows = await drizzle(env.DB).select().from(gpgKeys).all();
    const primary = rows.find((row) => row.primaryKeyId === "")!;
    const subkey = rows.find((row) => row.primaryKeyId !== "")!;
    expect(rows).toHaveLength(2);
    expect(primary.keyId).toBe(fixture.keyId);
    expect(primary.ownerId).toBe(aliceId);
    expect(primary.canSign).toBe(true); // RSA (algo 1) signs and encrypts
    expect(primary.canEncryptComms).toBe(true);
    expect(primary.canCertify).toBe(true);
    expect(primary.verified).toBe(false);
    expect(primary.createdAt.getTime()).toBe(1_600_000_000_000);
    expect(primary.expiresAt).toBeNull();
    expect(subkey.keyId).toBe(fixture.subkeyId);
    expect(subkey.primaryKeyId).toBe(fixture.keyId);
  });

  it("refuses a key whose identity email is not activated (gpg_no_key_email_found)", async () => {
    const owner = (await loadUserSettingsKeysOwner(env.DB, aliceId))!;
    const fixture = await rsaV4Armor({ created: 1_600_000_000, email: "other@elsewhere.example" });
    const result = await addGpgKeyFromForm(env.DB, owner, { type: "gpg", title: "none", content: fixture.armor, signature: "" });
    expect(result).toEqual({
      outcome: "invalid",
      kind: "gpg",
      message: userSettingsKeysLocale.gpg_no_key_email_found,
      field: "content",
    });
  });

  it("accepts a key matching an activated email_addresses row (not only the primary)", async () => {
    await env.DB.prepare(
      "INSERT INTO email_addresses (user_id, email, lower_email, is_activated, is_primary) VALUES (?, 'Alice@work.local', 'alice@work.local', 1, 0)",
    )
      .bind(aliceId)
      .run();
    const owner = (await loadUserSettingsKeysOwner(env.DB, aliceId))!;
    const fixture = await rsaV4Armor({ created: 1_600_000_000, email: "ALICE@work.local" });
    const result = await addGpgKeyFromForm(env.DB, owner, { type: "gpg", title: "none", content: fixture.armor, signature: "" });
    expect(result).toEqual({ outcome: "created", kind: "gpg", label: fixture.keyId });
  });

  it("refuses a reused key id (gpg_key_id_used) and any posted signature (gpg_invalid_token_signature)", async () => {
    const owner = (await loadUserSettingsKeysOwner(env.DB, aliceId))!;
    const fixture = await rsaV4Armor({ created: 1_600_000_000, email: "alice@test.local" });
    await addGpgKeyFromForm(env.DB, owner, { type: "gpg", title: "none", content: fixture.armor, signature: "" });
    const again = await addGpgKeyFromForm(env.DB, owner, { type: "gpg", title: "none", content: fixture.armor, signature: "" });
    expect(again).toEqual({ outcome: "invalid", kind: "gpg", message: userSettingsKeysLocale.gpg_key_id_used, field: "content" });
    const other = await rsaV4Armor({ created: 1_600_000_500, email: "alice@test.local", subkeySeed: 9 });
    const signed = await addGpgKeyFromForm(env.DB, owner, { type: "gpg", title: "none", content: other.armor, signature: "-----BEGIN PGP SIGNATURE-----" });
    expect(signed).toEqual({
      outcome: "invalid",
      kind: "gpg",
      message: userSettingsKeysLocale.gpg_invalid_token_signature,
      field: "content",
    });
  });

  it("answers the binder arm for empty content and the parse error for non-armor text", async () => {
    const owner = (await loadUserSettingsKeysOwner(env.DB, aliceId))!;
    expect(await addGpgKeyFromForm(env.DB, owner, { type: "gpg", title: "none", content: "", signature: "" })).toEqual({
      outcome: "invalid",
      kind: "gpg",
      message: "Content: Required",
      field: "content",
    });
    const junk = await addGpgKeyFromForm(env.DB, owner, { type: "gpg", title: "none", content: "plainly not a key", signature: "" });
    expect(junk).toEqual({
      outcome: "invalid",
      kind: "gpg",
      message: "Cannot verify your GPG key: no armored public key block found",
      field: "content",
    });
  });
});

describe("the deletes (upstream DeleteKey's type switch)", () => {
  it("removes an owned user key; a foreign or unknown id answers missing", async () => {
    const owner = (await loadUserSettingsKeysOwner(env.DB, aliceId))!;
    await addSshKeyFromForm(env.DB, owner, sshForm());
    const row = (await drizzle(env.DB).select().from(publicKeys).all())[0]!;
    expect(await deleteSshKey(env.DB, aliceId, row.id)).toBe("deleted");
    expect(await drizzle(env.DB).select().from(publicKeys).all()).toHaveLength(0);
    expect(await deleteSshKey(env.DB, aliceId, row.id)).toBe("missing");
  });

  it("removes a GPG primary WITH its subkeys; an unknown id stays idempotent", async () => {
    const owner = (await loadUserSettingsKeysOwner(env.DB, aliceId))!;
    const fixture = await rsaV4Armor({ created: 1_600_000_000, email: "alice@test.local", withSubkey: true });
    await addGpgKeyFromForm(env.DB, owner, { type: "gpg", title: "none", content: fixture.armor, signature: "" });
    const primary = (await drizzle(env.DB).select().from(gpgKeys).where(eq(gpgKeys.primaryKeyId, "")).all())[0]!;
    expect(await deleteGpgKey(env.DB, aliceId, primary.id)).toBe("deleted");
    expect(await drizzle(env.DB).select().from(gpgKeys).all()).toHaveLength(0);
    expect(await deleteGpgKey(env.DB, aliceId, primary.id)).toBe("deleted");
  });
});

// --- the loader ----------------------------------------------------------------

describe("loadUserSettingsKeysPageData (upstream loadKeysData's landed shape)", () => {
  it("lists user-type SSH keys in id order and primary GPG keys with subkeys + expiry flag", async () => {
    const owner = (await loadUserSettingsKeysOwner(env.DB, aliceId))!;
    await addSshKeyFromForm(env.DB, owner, sshForm({ title: "first" }));
    await addSshKeyFromForm(env.DB, owner, sshForm({ title: "second", content: sshEd25519Key(2) }));
    // A deploy-key row (type 2, the system principal's owner shape) is excluded.
    await drizzle(env.DB).insert(publicKeys).values({
      ownerId: aliceId,
      name: "deploy",
      fingerprint: "SHA256:deploy",
      content: "ssh-ed25519 deploy",
      mode: 2,
      type: 2,
      loginSourceId: 0,
      verified: false,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const fixture = await rsaV4Armor({ created: 1_600_000_000, email: "alice@test.local", withSubkey: true });
    await addGpgKeyFromForm(env.DB, owner, { type: "gpg", title: "none", content: fixture.armor, signature: "" });

    const data = await loadUserSettingsKeysPageData(env.DB, aliceId, NOW);
    expect(data.sshKeys.map((key) => key.row.name)).toEqual(["first", "second"]);
    // updated = created at insert → upstream's HasUsed/HasRecentActivity false.
    expect(data.sshKeys[0]).toMatchObject({ hasUsed: false, hasRecentActivity: false });
    expect(data.gpgKeys).toHaveLength(1);
    expect(data.gpgKeys[0]!.row.keyId).toBe(fixture.keyId);
    expect(data.gpgKeys[0]!.subkeys.map((subkey) => subkey.keyId)).toEqual([fixture.subkeyId]);
    expect(data.gpgKeys[0]!.expired).toBe(false);
    expect(data.form).toEqual({ title: "", content: "", gpgContent: "" });
  });

  it("computes HasRecentActivity for a bump-in-place updated column and expiry for a stale key", async () => {
    const owner = (await loadUserSettingsKeysOwner(env.DB, aliceId))!;
    await addSshKeyFromForm(env.DB, owner, sshForm({ title: "fresh" }));
    const row = (await drizzle(env.DB).select().from(publicKeys).all())[0]!;
    const recent = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    await drizzle(env.DB).update(publicKeys).set({ createdAt: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000), updatedAt: recent }).where(eq(publicKeys.id, row.id));
    const data = await loadUserSettingsKeysPageData(env.DB, aliceId, NOW);
    expect(data.sshKeys[0]).toMatchObject({ hasUsed: true, hasRecentActivity: true });

    const stale = await rsaV4Armor({ created: 1_500_000_000, email: "alice@test.local" });
    // Sign a lifetime onto the key: 1s past created — expired long before NOW.
    const armoredWithExpiry = stale.armor;
    await addGpgKeyFromForm(env.DB, owner, { type: "gpg", title: "none", content: armoredWithExpiry, signature: "" });
    await drizzle(env.DB).update(gpgKeys).set({ expiresAt: new Date(1_550_000_000_000) }).where(eq(gpgKeys.primaryKeyId, ""));
    const data2 = await loadUserSettingsKeysPageData(env.DB, aliceId, NOW);
    expect(data2.gpgKeys[0]!.expired).toBe(true);
  });
});

// --- the parse/units -------------------------------------------------------------

describe("parse + display units", () => {
  it("parseUserSettingsKeysForm / DeleteForm carry the upstream field names", () => {
    const params = new URLSearchParams("type=gpg&title=none&content=ARMOR&signature=");
    expect(parseUserSettingsKeysForm(params)).toEqual({ type: "gpg", title: "none", content: "ARMOR", signature: "" });
    expect(parseUserSettingsKeysDeleteForm(new URLSearchParams("type=ssh&id=42"))).toEqual({ type: "ssh", id: 42 });
    expect(parseUserSettingsKeysDeleteForm(new URLSearchParams("type=ssh&id=junk"))).toEqual({ type: "ssh", id: null });
  });

  it("paddedKeyID zero-pads short ids only (gpg_key.go:63-69)", () => {
    expect(paddedKeyID("ABC")).toBe("0000000000000ABC");
    expect(paddedKeyID("0123456789ABCDEF")).toBe("0123456789ABCDEF");
  });

  it("formatKeyDate renders DateUtils.AbsoluteShort in UTC", () => {
    expect(formatKeyDate(new Date(Date.UTC(2023, 10, 14)))).toBe("Nov 14, 2023");
  });
});

// --- the render --------------------------------------------------------------------

describe("renderUserSettingsKeysPage (keys.tmpl + keys_ssh/keys_gpg.tmpl DOM)", () => {
  it("renders the empty page: pageClass, both segments, helper links, open add forms", async () => {
    const data = await loadUserSettingsKeysPageData(env.DB, aliceId, NOW);
    const html = renderUserSettingsKeysPage(ctx, data);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('class="page-content user settings sshkeys"');
    expect(html).toContain("<title>SSH / GPG Keys - cf-gitea</title>");
    expect(html).toContain("Manage SSH Keys");
    expect(html).toContain("Manage GPG Keys");
    expect(html).toContain('id="add-ssh-key-panel"');
    expect(html).toContain('id="add-gpg-key-panel"');
    expect(html).toContain('type="hidden" value="ssh"');
    expect(html).toContain('type="hidden" value="gpg"');
    expect(html).toContain('name="title" value="none"'); // the gpg form's hidden Title filler
    expect(html).toContain("https://docs.github.com/en/free-pro-team@latest/github/authenticating-to-github/connecting-to-github-with-ssh");
    expect(html).toContain("about-commit-signature-verification");
    // the dead controls are omitted
    expect(html).not.toContain("show-panel");
    expect(html).not.toContain("modal-dialog");
    // the settings navbar reduces to the landed items, keys active
    expect(html).toContain('class="active item" href="/user/settings/keys"');
    expect(html).toContain('href="/user/settings/applications"');
  });

  it("renders key rows: fingerprint, verified badge arm, remove forms with type+id", async () => {
    const owner = (await loadUserSettingsKeysOwner(env.DB, aliceId))!;
    await addSshKeyFromForm(env.DB, owner, sshForm());
    const sshRow = (await drizzle(env.DB).select().from(publicKeys).all())[0]!;
    await drizzle(env.DB).update(publicKeys).set({ verified: true }).where(eq(publicKeys.id, sshRow.id));
    const fixture = await rsaV4Armor({ created: 1_600_000_000, email: "alice@test.local", withSubkey: true });
    await addGpgKeyFromForm(env.DB, owner, { type: "gpg", title: "none", content: fixture.armor, signature: "" });

    const data = await loadUserSettingsKeysPageData(env.DB, aliceId, NOW);
    const html = renderUserSettingsKeysPage(ctx, data);
    expect(html).toContain("laptop");
    expect(html).toContain(sshRow.fingerprint);
    expect(html).toContain("Verified Key"); // both the ssh badge and the gpg one
    expect(html).toContain(`Key ID:</b> ${paddedKeyID(fixture.keyId)}`);
    expect(html).toContain(paddedKeyID(fixture.subkeyId!));
    expect(html).toContain("Subkeys");
    expect(html).toContain("Valid forever");
    const gpgRow = data.gpgKeys[0]!.row;
    expect(html).toContain(`Added on ${formatKeyDate(gpgRow.addedAt)}`);
    expect(html).toContain(`name="id" value="${sshRow.id}"`);
    expect(html).toContain('action="/user/settings/keys/delete"');
    expect(html).toContain("No recent activity");
  });

  it("renders Valid-until for an expiring key and routes the error line to its form", async () => {
    const owner = (await loadUserSettingsKeysOwner(env.DB, aliceId))!;
    const fixture = await rsaV4Armor({ created: 1_600_000_000, email: "alice@test.local" });
    await addGpgKeyFromForm(env.DB, owner, { type: "gpg", title: "none", content: fixture.armor, signature: "" });
    await drizzle(env.DB).update(gpgKeys).set({ expiresAt: new Date(Date.UTC(2029, 4, 17)) }).where(eq(gpgKeys.primaryKeyId, ""));

    const data = await loadUserSettingsKeysPageData(env.DB, aliceId, NOW);
    expect(renderUserSettingsKeysPage(ctx, data)).toContain(`Valid until ${formatKeyDate(new Date(Date.UTC(2029, 4, 17)))}`);

    // An SSH failure's line + field class land in the SSH form only.
    const sshErrorHtml = renderUserSettingsKeysPage(ctx, data, {
      kind: "ssh",
      message: userSettingsKeysLocale.ssh_key_been_used,
      field: "content",
    });
    expect(sshErrorHtml).toContain("This SSH key has already been added to the server.");
    expect(sshErrorHtml).toContain("field error");
    const gpgErrorHtml = renderUserSettingsKeysPage(ctx, data, {
      kind: "gpg",
      message: userSettingsKeysLocale.gpg_invalid_token_signature,
      field: "content",
    });
    expect(gpgErrorHtml).toContain("The provided GPG key, signature and token do not match, or the token is out-of-date.");
    expect(gpgErrorHtml).toContain("field error");
  });
});
