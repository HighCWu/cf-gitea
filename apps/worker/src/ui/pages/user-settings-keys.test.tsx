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
 *
 * The wave-81 deferred matrix (the tab is NOW MOUNTED — window-2a, 0c2b151):
 * the parsers' full rejection surfaces through the form arms with the exact
 * detail texts (invalid base64, truncated wire keys/blobs, bad armor
 * checksums, unknown algos), the reuse/gate outcomes re-rendered through the
 * LIVE routes (`uiRouter.fetch` + a minted session, the repo-editor-tails
 * harness), the delete arms' 303s (the GPG miss idempotent, the subkey
 * cascade), the AddKeyForm Title MaxSize(50) input cap, and the login gate.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { gpgKeys, publicKeys, users } from "../../db/schema";
import { uiEnv } from "../__tests__/harness";
import { uiRouter } from "../index";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
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
  type AddKeyOutcome,
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

// --- the parser rejection arms (the exact detail texts) ------------------------

describe("the SSH parser rejection arms (services/ssh-gpg-keys.ts, the exact form messages)", () => {
  async function add(content: string): Promise<AddKeyOutcome> {
    const owner = (await loadUserSettingsKeysOwner(env.DB, aliceId))!;
    return addSshKeyFromForm(env.DB, owner, sshForm({ content }));
  }

  it("refuses PEM/SSH2 blocks up front (unsupported public key format)", async () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\n-----END OPENSSH PRIVATE KEY-----";
    expect(await add(pem)).toEqual({
      outcome: "invalid",
      kind: "ssh",
      message: "Cannot verify your SSH key: unsupported public key format (OpenSSH single-line only)",
      field: "content",
    });
    expect(await add("---- BEGIN SSH2 PUBLIC KEY ----\nComment: x")).toEqual({
      outcome: "invalid",
      kind: "ssh",
      message: "Cannot verify your SSH key: unsupported public key format (OpenSSH single-line only)",
      field: "content",
    });
  });

  it("answers whitespace-only content with empty key", async () => {
    expect(await add("   ")).toEqual({
      outcome: "invalid",
      kind: "ssh",
      message: "Cannot verify your SSH key: empty key",
      field: "content",
    });
  });

  it("answers a sub-4-byte decoded blob with invalid key format", async () => {
    // "AAAA" decodes to 3 zero bytes — below the 4-byte wire floor.
    expect(await add("ssh-ed25519 AAAA")).toEqual({
      outcome: "invalid",
      kind: "ssh",
      message: "Cannot verify your SSH key: invalid key format",
      field: "content",
    });
  });

  it("answers an overrunning first wire string with not-enough-length", async () => {
    // A 32-byte string header with no body behind it.
    expect(await add(`ssh-ed25519 ${toBase64(Uint8Array.of(0, 0, 0, 32))}`)).toEqual({
      outcome: "invalid",
      kind: "ssh",
      message: "Cannot verify your SSH key: invalid key format: not enough length",
      field: "content",
    });
  });

  it("answers a declared-type mismatch with both names in the detail", async () => {
    const wire = sshEd25519Key(1).split(" ")[1]!;
    expect(await add(`ssh-rsa ${wire}`)).toEqual({
      outcome: "invalid",
      kind: "ssh",
      message: "Cannot verify your SSH key: key type and content does not match: ssh-rsa - ssh-ed25519",
      field: "content",
    });
  });

  it("answers an overrunning material field with malformed key blob", async () => {
    const type = new TextEncoder().encode("ssh-ed25519");
    const blob = concat(lengthPrefixed(type), Uint8Array.of(0, 0, 0, 99, 1, 2));
    expect(await add(`ssh-ed25519 ${toBase64(blob)}`)).toEqual({
      outcome: "invalid",
      kind: "ssh",
      message: "Cannot verify your SSH key: invalid ssh public key: malformed key blob",
      field: "content",
    });
  });

  it("answers a type-only blob (no material field) with empty key blob", async () => {
    const type = new TextEncoder().encode("ssh-ed25519");
    expect(await add(`ssh-ed25519 ${toBase64(lengthPrefixed(type))}`)).toEqual({
      outcome: "invalid",
      kind: "ssh",
      message: "Cannot verify your SSH key: invalid ssh public key: empty key blob",
      field: "content",
    });
  });

  it("answers an over-cap base64 with the length arm before any decode", async () => {
    // maxKeyBinaryBytes 4096 → the 5461-char base64 cap (the header).
    expect(await add(`ssh-ed25519 ${"A".repeat(5462)}`)).toEqual({
      outcome: "invalid",
      kind: "ssh",
      message: "Cannot verify your SSH key: SSH public key base64 is too long",
      field: "content",
    });
  });
});

describe("the GPG parser rejection arms (services/ssh-gpg-keys.ts, the exact form messages)", () => {
  /** An armor block around raw packet bytes (the rejection fixtures drive the
   *  armor/packet walk directly — same layout as rsaV4Armor's render). */
  function armored(packets: Uint8Array[]): string {
    const base64 = toBase64(concat(...packets));
    const lines = base64.match(/.{1,64}/g) ?? [];
    return ["-----BEGIN PGP PUBLIC KEY BLOCK-----", "", ...lines, "-----END PGP PUBLIC KEY BLOCK-----", ""].join("\n");
  }

  async function add(content: string): Promise<AddKeyOutcome> {
    const owner = (await loadUserSettingsKeysOwner(env.DB, aliceId))!;
    return addGpgKeyFromForm(env.DB, owner, { type: "gpg", title: "none", content, signature: "" });
  }

  it("answers an unterminated armor block", async () => {
    expect(await add("-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nAAAA\n")).toEqual({
      outcome: "invalid",
      kind: "gpg",
      message: "Cannot verify your GPG key: unterminated armored public key block",
      field: "content",
    });
  });

  it("answers invalid base64 inside the armor body (invalid armor encoding)", async () => {
    expect(await add("-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n!!!!\n-----END PGP PUBLIC KEY BLOCK-----\n")).toEqual({
      outcome: "invalid",
      kind: "gpg",
      message: "Cannot verify your GPG key: invalid armor encoding",
      field: "content",
    });
  });

  it("answers a wrong CRC-24 checksum line (armor checksum mismatch)", async () => {
    const fixture = await rsaV4Armor({ created: 1_600_000_000, email: "alice@test.local" });
    const badChecksum = fixture.armor.replace(
      "-----END PGP PUBLIC KEY BLOCK-----",
      "=AAAA\n-----END PGP PUBLIC KEY BLOCK-----",
    );
    expect(await add(badChecksum)).toEqual({
      outcome: "invalid",
      kind: "gpg",
      message: "Cannot verify your GPG key: armor checksum mismatch",
      field: "content",
    });
  });

  it("answers a non-packet leading byte (invalid packet header)", async () => {
    // 0x01 clears the high bit — RFC 4880 §4.2's format error.
    expect(await add(armored([Uint8Array.of(0x01, 0x02)]))).toEqual({
      outcome: "invalid",
      kind: "gpg",
      message: "Cannot verify your GPG key: invalid packet header",
      field: "content",
    });
  });

  it("answers a declared body longer than the armor (truncated packet body)", async () => {
    // Old-format header (tag 6, 1-byte length) claiming 200 body bytes.
    expect(await add(armored([Uint8Array.of(0x80 | (6 << 2) | 0, 200, 0x04)]))).toEqual({
      outcome: "invalid",
      kind: "gpg",
      message: "Cannot verify your GPG key: truncated packet body",
      field: "content",
    });
  });

  it("answers a truncated MPI in the key material", async () => {
    // RSA header + an MPI announcing 0x0d30 = 3376 bits (422 octets) with none.
    const body = concat(Uint8Array.of(4), be32(1_600_000_000), Uint8Array.of(1), Uint8Array.of(0x0d, 0x30));
    expect(await add(armored([oldPacket(6, body)]))).toEqual({
      outcome: "invalid",
      kind: "gpg",
      message: "Cannot verify your GPG key: truncated MPI",
      field: "content",
    });
  });

  it("answers a short public key packet", async () => {
    expect(await add(armored([oldPacket(6, Uint8Array.of(4, 0, 0))]))).toEqual({
      outcome: "invalid",
      kind: "gpg",
      message: "Cannot verify your GPG key: short public key packet",
      field: "content",
    });
  });

  it("answers an unknown public key algorithm", async () => {
    const body = concat(Uint8Array.of(4), be32(1_600_000_000), Uint8Array.of(99));
    expect(await add(armored([oldPacket(6, body)]))).toEqual({
      outcome: "invalid",
      kind: "gpg",
      message: "Cannot verify your GPG key: unsupported public key algorithm 99",
      field: "content",
    });
  });

  it("answers a v5 key body (v4 only)", async () => {
    const body = concat(Uint8Array.of(5), be32(1_600_000_000), Uint8Array.of(1));
    expect(await add(armored([oldPacket(6, body)]))).toEqual({
      outcome: "invalid",
      kind: "gpg",
      message: "Cannot verify your GPG key: unsupported public key version 5 (v4 only)",
      field: "content",
    });
  });

  it("answers trailing bytes after the RSA material", async () => {
    const body = concat(rsaV4KeyBody(1_600_000_000, 0), Uint8Array.of(7));
    expect(await add(armored([oldPacket(6, body)]))).toEqual({
      outcome: "invalid",
      kind: "gpg",
      message: "Cannot verify your GPG key: trailing bytes in public key packet",
      field: "content",
    });
  });

  it("answers a subkey packet before any primary key", async () => {
    expect(await add(armored([oldPacket(14, rsaV4KeyBody(1_600_000_000, 1))]))).toEqual({
      outcome: "invalid",
      kind: "gpg",
      message: "Cannot verify your GPG key: subkey before primary key",
      field: "content",
    });
  });

  it("answers a user id packet before any primary key", async () => {
    const uid = new TextEncoder().encode("Test User <alice@test.local>");
    expect(await add(armored([oldPacket(13, uid)]))).toEqual({
      outcome: "invalid",
      kind: "gpg",
      message: "Cannot verify your GPG key: user id before primary key",
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

// --- the mounted routes (window-2a: GET/POST /user/settings/keys + POST /delete) --

describe("the mounted /user/settings/keys routes (index.ts window-2a over the module arms)", () => {
  /** A signed-in POST onto the tab (the repo-editor-tails harness: the real
   *  router over uiEnv, a minted session cookie, the §2.8 origin header). */
  async function postKeys(fields: Record<string, string>): Promise<Response> {
    return uiRouter.fetch(
      new Request("https://test.local/user/settings/keys", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://test.local",
          cookie: `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, aliceId)}`,
        },
        body: new URLSearchParams(fields).toString(),
      }),
      uiEnv,
    );
  }

  /** A signed-in POST onto the delete tail. */
  async function postDelete(fields: Record<string, string>): Promise<Response> {
    return uiRouter.fetch(
      new Request("https://test.local/user/settings/keys/delete", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://test.local",
          cookie: `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, aliceId)}`,
        },
        body: new URLSearchParams(fields).toString(),
      }),
      uiEnv,
    );
  }

  /** A signed-in GET of the tab. */
  async function getKeys(): Promise<Response> {
    return uiRouter.fetch(
      new Request("https://test.local/user/settings/keys", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${await mintSession(env.DB, aliceId)}` },
      }),
      uiEnv,
    );
  }

  it("GET renders the live tab: the ssh title input's maxlength 50 (AddKeyForm MaxSize), both forms", async () => {
    const res = await getKeys();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('class="page-content user settings sshkeys"');
    expect(html).toContain('id="ssh-key-title"');
    // upstream AddKeyForm.Title `binding:"Required;MaxSize(50)"` — the input cap
    expect(html).toContain('maxlength="50"');
    expect(html).toContain('action="/user/settings/keys" method="post"');
  });

  it("an anonymous GET 303s onto the login round-trip (the reqSignIn gate)", async () => {
    const res = await uiRouter.fetch(new Request("https://test.local/user/settings/keys"), uiEnv);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/login?");
  });

  it("POST ssh created 303s onto the tab; the reuse gates re-render their exact lines", async () => {
    const first = await postKeys({ type: "ssh", title: "laptop", content: sshEd25519Key(1), signature: "" });
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/user/settings/keys");
    expect(await drizzle(env.DB).select().from(publicKeys).all()).toHaveLength(1);

    // fingerprint reuse → ssh_key_been_used (the content field's error class)
    const again = await postKeys({ type: "ssh", title: "renamed", content: sshEd25519Key(1), signature: "" });
    expect(again.status).toBe(200);
    const reuseHtml = await again.text();
    expect(reuseHtml).toContain("This SSH key has already been added to the server.");
    expect(reuseHtml).toContain("ui negative message");
    expect(reuseHtml).toContain("field error");

    // name reuse → ssh_key_name_used
    const sameTitle = await postKeys({ type: "ssh", title: "laptop", content: sshEd25519Key(7), signature: "" });
    expect(sameTitle.status).toBe(200);
    expect(await sameTitle.text()).toContain("An SSH key with same name already exists on your account.");
  });

  it("POST ssh with unparseable content re-renders the exact parse text into the ssh form", async () => {
    const res = await postKeys({ type: "ssh", title: "laptop", content: "not a key", signature: "" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Cannot verify your SSH key: invalid key format: illegal base64 data");
    expect(html).toContain("ui negative message");
  });

  it("POST gpg created 303s and lands primary + subkey; key-id reuse and the email gate re-render their exact lines", async () => {
    const fixture = await rsaV4Armor({ created: 1_600_000_000, email: "alice@test.local", withSubkey: true });
    const first = await postKeys({ type: "gpg", title: "none", content: fixture.armor, signature: "" });
    expect(first.status).toBe(303);
    expect(first.headers.get("location")).toBe("/user/settings/keys");
    expect(await drizzle(env.DB).select().from(gpgKeys).all()).toHaveLength(2);

    // key-id reuse → gpg_key_id_used
    const again = await postKeys({ type: "gpg", title: "none", content: fixture.armor, signature: "" });
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("A public GPG key with same ID already exists.");

    // the activated-email gate → gpg_no_key_email_found
    const foreign = await rsaV4Armor({ created: 1_600_000_500, email: "other@elsewhere.example", subkeySeed: 9 });
    const gated = await postKeys({ type: "gpg", title: "none", content: foreign.armor, signature: "" });
    expect(gated.status).toBe(200);
    expect(await gated.text()).toContain("does not match any activated email address associated with your account");
  });

  it("POST gpg with a corrupt-armor checksum re-renders the exact parse text", async () => {
    const fixture = await rsaV4Armor({ created: 1_600_000_000, email: "alice@test.local" });
    const badChecksum = fixture.armor.replace(
      "-----END PGP PUBLIC KEY BLOCK-----",
      "=AAAA\n-----END PGP PUBLIC KEY BLOCK-----",
    );
    const res = await postKeys({ type: "gpg", title: "none", content: badChecksum, signature: "" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Cannot verify your GPG key: armor checksum mismatch");
  });

  it("POST delete ssh removes the row with the 303; POST delete gpg cascades its subkeys", async () => {
    const owner = (await loadUserSettingsKeysOwner(env.DB, aliceId))!;
    await addSshKeyFromForm(env.DB, owner, sshForm());
    const sshRow = (await drizzle(env.DB).select().from(publicKeys).all())[0]!;
    const sshDel = await postDelete({ type: "ssh", id: String(sshRow.id) });
    expect(sshDel.status).toBe(303);
    expect(sshDel.headers.get("location")).toBe("/user/settings/keys");
    expect(await drizzle(env.DB).select().from(publicKeys).all()).toHaveLength(0);

    const fixture = await rsaV4Armor({ created: 1_600_000_000, email: "alice@test.local", withSubkey: true });
    await addGpgKeyFromForm(env.DB, owner, { type: "gpg", title: "none", content: fixture.armor, signature: "" });
    const primary = (await drizzle(env.DB).select().from(gpgKeys).where(eq(gpgKeys.primaryKeyId, "")).all())[0]!;
    const gpgDel = await postDelete({ type: "gpg", id: String(primary.id) });
    expect(gpgDel.status).toBe(303);
    // the subkey cascade rode the same POST
    expect(await drizzle(env.DB).select().from(gpgKeys).all()).toHaveLength(0);
  });

  it("POST delete gpg miss answers the idempotent 303 (DeleteGPGKey's nil-not-exist arm)", async () => {
    const res = await postDelete({ type: "gpg", id: "424242" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/user/settings/keys");
    expect(await drizzle(env.DB).select().from(gpgKeys).all()).toHaveLength(0);
  });

  it("POST delete ssh miss renders the HANDOFF NOTE's error line (keys.go:301-303)", async () => {
    // The module recipe: "An outcome: 'missing' SSH delete renders the error
    // line ('Failed to delete SSH key')" — upstream JSONErrors without the
    // redirect. Pinned as written; a silent 303 here is the wiring wave's bug.
    const res = await postDelete({ type: "ssh", id: "424242" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Failed to delete SSH key");
  });

  it("an anonymous POST 303s onto the login round-trip before any store write", async () => {
    const res = await uiRouter.fetch(
      new Request("https://test.local/user/settings/keys", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ type: "ssh", title: "x", content: "y", signature: "" }).toString(),
      }),
      uiEnv,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/login?");
    expect(await drizzle(env.DB).select().from(publicKeys).all()).toHaveLength(0);
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
