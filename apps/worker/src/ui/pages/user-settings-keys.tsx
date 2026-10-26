/**
 * The user settings SSH/GPG KEYS tab, `/user/settings/keys` — pages wave 54
 * (bench row `wave-settings-keys-tags`, TWO-STAGE UNMOUNTED — the route rides
 * the index.ts window; `index.ts` is orchestrator/sibling-owned).
 *
 * ## HANDOFF NOTE (for the wiring wave)
 *
 * The module is complete end-to-end over the landed stores; upstream's exact
 * route group is web.go:698-700:
 *
 *   GET  /user/settings/keys        → resolveUiSession (signed-in gate, the
 *                user-settings.tsx pattern) → loadUserSettingsKeysPageData →
 *                renderUserSettingsKeysPage; a session doer without a D1 row
 *                404-shells (the silent-auth-failure convention).
 *   POST /user/settings/keys        → the sameOriginGuard + the signed-in
 *                gate, `readUrlEncodedForm`, `parseUserSettingsKeysForm`,
 *                then the `type` dispatch: "ssh" → `addSshKeyFromForm`,
 *                "gpg" → `addGpgKeyFromForm` (upstream KeysPost's switch,
 *                routers/web/user/setting/keys.go:47-230). Both arms take
 *                the doer's D1 row via `loadUserSettingsKeysOwner` (null →
 *                the 404 shell). Success 303s back onto
 *                `/user/settings/keys` (upstream's redirect; the
 *                no-session-flash reduction — the success flash lines
 *                settings.add_key_success / settings.add_gpg_key_success do
 *                not render, the user-settings.tsx convention). An
 *                `outcome: "invalid"` re-renders the page with the
 *                `error` outcome (the `kind` routes it to the submitting
 *                form) + the `form` values carried over (upstream
 *                RenderWithErrDeprecated's re-render arm).
 *   POST /user/settings/keys/delete → `parseUserSettingsKeysDeleteForm` +
 *                `deleteSshKey` / `deleteGpgKey` (upstream DeleteKey's
 *                `type` switch, keys.go:264-310), then 303 back. An
 *                `outcome: "missing"` SSH delete renders the error line
 *                ("Failed to delete SSH key", keys.go:301-303); the GPG
 *                delete is idempotent (DeleteGPGKey returns nil on
 *                ErrGPGKeyNotExist — the misc-t3 DELETE arm's note), so
 *                every GPG delete 303s.
 *
 * Upstream's settings navbar (user/settings/navbar.tmpl) reduces to the
 * landed items — Profile (/user/settings), Applications
 * (/user/settings/applications, this wave's sibling module) and this tab —
 * the dead-link rule; the profile page's own reduced navbar (the private
 * UserSettingsNav in pages/user-settings.tsx) shows only Profile until its
 * owner extends it (handoff).
 *
 * ## Data (§3.2 — the landed stores, never a self-fetch)
 *
 *   SSH list   `public_keys` where owner_id = doer AND type = 1 (upstream
 *              loadKeysData's FindPublicKeyOptions{OwnerID, NotKeytype:
 *              principal}, keys.go:318-327; cf-gitea's deploy-key rows point
 *              at the system principal's owner id, so the owner filter alone
 *              already excludes them — the type filter is the explicit
 *              upstream shape). HasUsed/HasRecentActivity are upstream's
 *              AfterLoad pair (ssh_key.go:62-63) over created/updated; the
 *              landed rows carry updated = created at insert and nothing
 *              bumps it yet (the schema's usage-tracking note), so both are
 *              false and the "No recent activity" arm renders.
 *   GPG list   `gpg_keys` where owner_id = doer AND primary_key_id = ''
 *              (upstream FindGPGKeyOptions, keys.go:336-343) + the shared
 *              `loadSubkeys` (services/account-keys.ts — the account-keys
 *              family this brief pins). The template's `.Emails` matched
 *              identities never render: the store keeps no parsed emails
 *              (account-keys.ts's toApiGpgKey renders `emails: []` — the
 *              parse-time field is never loaded on reads).
 *   SSH add    upstream KeysPost "ssh" (keys.go:196-232): CheckPublicKeyString
 *              → AddPublicKey. The landed API path (routes/misc-t3.ts
 *              `addPublicKey` + `parseSshPublicKey`) is route-PRIVATE, so
 *              this module carries a VERBATIM COPY of both (the
 *              deploy-keys.ts precedent, which names the same consolidation
 *              follow-up in its header; misc-t3's copy of the verification
 *              token carries the identical note). Sequence preserved:
 *              global fingerprint-reuse 422 ("Key content has been used as
 *              non-deploy key" → settings.ssh_key_been_used), per-owner name
 *              422 ("Key title has been used" → settings.ssh_key_name_used),
 *              insert mode=2 / type=1 / verified=false, created=updated=now.
 *   GPG add    upstream KeysPost "gpg" (keys.go:92-155): AddGPGKey. The
 *              landed API path (misc-t3.ts `addGpgKey` +
 *              `parseArmoredGpgKey`, again route-private — verbatim copy
 *              here) reduces the signature arm to the upstream
 *              invalid-token-signature 422 for ANY posted signature (the
 *              add-path RSA verification is not implemented anywhere on our
 *              side), then the activated-email gate
 *              (settings.gpg_no_key_email_found — the misc-t3 404 body's
 *              locale twin), the per-key global key_id 422
 *              (settings.gpg_key_id_used), then the primary + subkey
 *              inserts (a subkey without its own lifetime inherits the
 *              primary's expiry, gpg_key.go:81-84). The verification-token
 *              clock (asymkey_model.VerificationToken) is NOT carried: it
 *              feeds the unrendered verify machinery and the API error
 *              bodies only (the header's verify reduction).
 *
 * ## DOM contract (templates/user/settings/{keys,keys_ssh,keys_principal,
 *  keys_gpg,layout_head}.tmpl at the pin)
 *
 * layout_head's pageClass is the literal `user settings sshkeys`; keys.tmpl
 * wraps the two sections in `.user-setting-content`. Each section is the
 * `h4.ui.top.attached.header` (manage_ssh_keys / manage_gpg_keys) over the
 * `.ui.attached.segment` carrying the add form + the
 * `.flex-divided-list.items-with-main` (the description item first, then one
 * `.item` per key: `.item-leading` key glyph, `.item-main` title/fingerprint
 * or key-id rows, `.item-trailing` Remove).
 *
 * ## Documented reductions (§6 method — never dead controls)
 *
 * - keys_principal.tmpl is UNRENDERED: `.AllowPrincipals` is upstream
 *   setting.SSH.AuthorizedPrincipalsEnabled and cf-gitea models no SSH
 *   server (the template's own `{{if .AllowPrincipals}}` gate is false at
 *   our posture) — principal keys have no landed store either.
 * - The verify flows are UNRENDERED: keys_ssh.tmpl's `?verify_ssh=`
 *   anchor + signature segment and keys_gpg.tmpl's `?verify_gpg=` twin (the
 *   TokenToSign block, keys.go:349-352) have no reachable op in the UI layer
 *   — the SSH verify op is not landed anywhere, and the GPG verify op exists
 *   only as the JSON API route (POST /user/gpg_key_verify, its RSA
 *   signature machinery route-private in account-aggregates). The per-key
 *   Verify anchors and the `.Verified` set-by-verify arm's data
 *   (publicKeys.verified / gpgKeys.verified) render data-driven: a verified
 *   row shows the Verified Key badge; nothing sets it today.
 * - The add forms render directly (no `tw-hidden` panel, no `show-panel`
 *   toggle button, no `hide-panel` Cancel button — the compare.tsx no-JS
 *   reduction: the dead controls are omitted and the form is visible).
 * - The Remove buttons are plain form POSTs to `/user/settings/keys/delete`
 *   (upstream's `data-url="{{$.Link}}/delete?type=…&id=…"` link-action +
 *   `<dialog class="modal-dialog">` confirm are not reproduced — the
 *   hooks-list reduction, wave 4; the external-managed disabled arm is
 *   unreachable, login_source_id is always 0).
 * - DisableSSH (keys_ssh.tmpl's ssh_signonly arm) renders never: cf-gitea
 *   models no SSH server toggle (upstream setting.SSH.Disabled).
 * - The gpg add form carries no signature textarea: upstream renders it only
 *   under Err_Signature (the signature-verify machinery above); a posted
 *   `signature` value answers settings.gpg_invalid_token_signature verbatim
 *   (the landed add path rejects every signature).
 * - The ssh_helper/gpg_helper links render upstream's literal GitHub docs
 *   URLs (external anchors — not app-internal dead links).
 */

import { and, asc, eq, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { loadSubkeys } from "../../api/services/account-keys";
import { users, emailAddresses, gpgKeys, publicKeys } from "../../db/schema";
import { BaseLayout, Icon, renderPage } from "../shell";
import type { IconName } from "../icons";
import type { UiContext } from "../ui-context";

// ---------------------------------------------------------------------------
// Page chrome (the component-local locale pattern — locale.ts is shared and
// not this wave's file; every string cites its upstream key)
// ---------------------------------------------------------------------------

export const userSettingsKeysLocale = {
  settings: "User Settings", // "user.settings" (the navbar header)
  profile: "Profile", // "settings.profile"
  applications: "Applications", // "settings.applications"
  ssh_gpg_keys: "SSH / GPG Keys", // "settings.ssh_gpg_keys" (the title + navbar item)
  manage_ssh_keys: "Manage SSH Keys", // "settings.manage_ssh_keys"
  manage_gpg_keys: "Manage GPG Keys", // "settings.manage_gpg_keys"
  add_key: "Add Key", // "settings.add_key"
  key_name: "Key Name", // "settings.key_name"
  key_content: "Content", // "settings.key_content"
  key_content_ssh_placeholder:
    "Begins with 'ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'sk-ecdsa-sha2-nistp256@openssh.com', or 'sk-ssh-ed25519@openssh.com'", // "settings.key_content_ssh_placeholder"
  key_content_gpg_placeholder: "Begins with '-----BEGIN PGP PUBLIC KEY BLOCK-----'", // "settings.key_content_gpg_placeholder"
  ssh_desc:
    "These public SSH keys are associated with your account. The corresponding private keys allow full access to your repositories.", // "settings.ssh_desc"
  ssh_helper_need_help: "Need help?", // "settings.ssh_helper" lead (strong)
  ssh_helper_create: "create your own SSH keys", // "settings.ssh_helper" first anchor
  ssh_helper_problems: "common problems", // "settings.ssh_helper" second anchor
  gpg_desc:
    "These public GPG keys are associated with your account. Keep your private keys safe as they allow commits to be verified.", // "settings.gpg_desc"
  gpg_helper_need_help: "Need help?", // "settings.gpg_helper" lead (strong)
  gpg_helper_about: "about GPG", // "settings.gpg_helper" anchor
  key_state_desc: "This key has been used in the last 7 days", // "settings.key_state_desc"
  ssh_key_verified: "Verified Key", // "settings.ssh_key_verified"
  ssh_key_verified_long:
    "Key has been verified with a token and can be used to verify commits matching any activated email addresses for this user.", // "settings.ssh_key_verified_long"
  gpg_key_verified: "Verified Key", // "settings.gpg_key_verified"
  gpg_key_verified_long:
    "Key has been verified with a token and can be used to verify commits matching any activated email addresses for this user in addition to any matched identities for this key.", // "settings.gpg_key_verified_long"
  added_on: "Added on", // "settings.added_on %s" — the date renders beside it
  last_used: "Last used on", // "settings.last_used"
  no_activity: "No recent activity", // "settings.no_activity"
  remove: "Remove", // "remove"
  key_id: "Key ID", // "settings.key_id"
  subkeys: "Subkeys", // "settings.subkeys"
  valid_until: "Valid until", // "settings.valid_until_date %s" — the date renders beside it
  valid_forever: "Valid forever", // "settings.valid_forever"
  // The write-path messages (upstream flash/error texts the apply functions
  // answer; the handler renders the `error` line with them).
  ssh_key_been_used: "This SSH key has already been added to the server.", // "settings.ssh_key_been_used"
  ssh_key_name_used: "An SSH key with same name already exists on your account.", // "settings.ssh_key_name_used"
  gpg_key_id_used: "A public GPG key with same ID already exists.", // "settings.gpg_key_id_used"
  gpg_no_key_email_found:
    "This GPG key does not match any activated email address associated with your account. It may still be added if you sign the provided token.", // "settings.gpg_no_key_email_found"
  gpg_invalid_token_signature:
    "The provided GPG key, signature and token do not match, or the token is out-of-date.", // "settings.gpg_invalid_token_signature"
  invalid_ssh_key_prefix: "Cannot verify your SSH key: ", // "form.invalid_ssh_key %s"
  invalid_gpg_key_prefix: "Cannot verify your GPG key: ", // "form.invalid_gpg_key %s"
  ssh_delete_failed: "Failed to delete SSH key", // keys.go:301-303's literal
} as const;

// ---------------------------------------------------------------------------
// Verbatim copies (route-private originals — see the header's Data section)
// ---------------------------------------------------------------------------

/** misc-t3.ts's private helpers verbatim (the deploy-keys.ts verbatim-copy
 *  precedent): the base64/text codecs and the SSH fingerprint renderer. A
 *  later consolidation should export these from one shared home and every
 *  copy collapses onto it. (The verification-token clock is NOT carried:
 *  it feeds only the verify machinery and the API error bodies — see the
 *  header's verify reduction.) */

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function shaHex(algo: "SHA-1" | "SHA-256", data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(algo, data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 fingerprint in ssh's rendering: "SHA256:" + unpadded std base64. */
async function sshFingerprint(blob: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", blob));
  return `SHA256:${bytesToBase64(digest).replace(/=+$/, "")}`;
}

// ---------------------------------------------------------------------------
// SSH public-key parsing — verbatim copy of misc-t3.ts's parseSshPublicKey
// (the provable OpenSSH single-line subset, models/asymkey/ssh_key_parse.go;
// the module header there documents the SSH2/PEM arms and Go error-string
// divergences). Error messages carry the upstream 422 detail tails.
// ---------------------------------------------------------------------------

class SshKeyParseError extends Error {}

/** Upstream maxKeyBinaryBytes (ssh_key_parse.go:36) → the base64 cap
 *  maxKeyContentBase64Bytes (4096 * 4 / 3). */
const SSH_MAX_KEY_BASE64_BYTES = 5461;

/** Go strings.SplitN: the last part carries the unsplit remainder. */
function goSplitN(content: string, separator: string, n: number): string[] {
  const parts = content.split(separator);
  if (parts.length <= n) {
    return parts;
  }
  return [...parts.slice(0, n - 1), parts.slice(n - 1).join(separator)];
}

interface ParsedSshKey {
  /** The normalized stored content: "type base64 [comment]" (upstream
   *  parseKeyString's return, whitespace-trimmed). */
  content: string;
  fingerprint: string;
}

async function parseSshPublicKey(raw: string): Promise<ParsedSshKey> {
  const invalid = (detail: string): SshKeyParseError => new SshKeyParseError(detail);
  let content = raw.trim();
  if (content.startsWith("---- BEGIN SSH2 PUBLIC KEY ----") || content.includes("-----BEGIN")) {
    throw invalid("unsupported public key format (OpenSSH single-line only)");
  }
  // Upstream removes all newlines from the OpenSSH form before splitting.
  content = content.replaceAll("\r\n", "").replaceAll("\n", "");
  const parts = goSplitN(content, " ", 3);
  if (parts.length === 0 || (parts[0] ?? "") === "") {
    throw invalid("empty key");
  }
  const declaredType = parts.length === 1 ? "" : parts[0]!;
  const base64Key = parts.length === 1 ? parts[0]! : parts[1]!;
  const comment = parts.length === 3 ? parts[2]! : "";
  if (base64Key.length > SSH_MAX_KEY_BASE64_BYTES) {
    throw invalid("SSH public key base64 is too long");
  }
  let blob: Uint8Array;
  try {
    blob = base64ToBytes(base64Key);
  } catch {
    throw invalid("invalid key format: illegal base64 data");
  }
  if (blob.length < 4) {
    throw invalid("invalid key format");
  }
  // SSH wire walk: length-prefixed strings; the first names the key type.
  const readString = (offset: number): [string, number] | null => {
    if (offset + 4 > blob.length) {
      return null;
    }
    const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const length = view.getUint32(offset);
    if (offset + 4 + length > blob.length) {
      return null;
    }
    return [new TextDecoder().decode(blob.subarray(offset + 4, offset + 4 + length)), offset + 4 + length];
  };
  const first = readString(0);
  if (first === null) {
    throw invalid("invalid key format: not enough length");
  }
  const [wireType, afterType] = first;
  if (declaredType !== "" && declaredType !== wireType) {
    throw invalid(`key type and content does not match: ${declaredType} - ${wireType}`);
  }
  // The remaining fields must be a clean string sequence consuming the blob
  // (a real key carries at least one material field).
  let offset = afterType;
  let fields = 0;
  while (offset < blob.length) {
    const next = readString(offset);
    if (next === null) {
      throw invalid("invalid ssh public key: malformed key blob");
    }
    offset = next[1];
    fields += 1;
  }
  if (fields === 0) {
    throw invalid("invalid ssh public key: empty key blob");
  }
  const stored = parts.length === 1 ? `${wireType} ${base64Key}` : [declaredType, base64Key, comment].filter((p) => p !== "").join(" ");
  return { content: stored.trim(), fingerprint: await sshFingerprint(blob) };
}

// ---------------------------------------------------------------------------
// GPG key parsing — verbatim copy of misc-t3.ts's parseArmoredGpgKey (the
// provable v4 OpenPGP subset; the module header there documents the v5/v6
// and signature-verification omissions).
// ---------------------------------------------------------------------------

class GpgKeyParseError extends Error {}

interface ParsedGpgSubkey {
  keyId: string;
  created: Date;
  /** Unix seconds, or null when no key lifetime is signed. */
  expires: number | null;
  content: string;
  canSign: boolean;
  canEncrypt: boolean;
}

interface ParsedGpgEntity {
  keyId: string;
  created: Date;
  expires: number | null;
  content: string;
  canSign: boolean;
  canEncrypt: boolean;
  identityEmails: string[];
  subkeys: ParsedGpgSubkey[];
}

const GPG_KEY_PACKET = 6;
const GPG_SUBKEY_PACKET = 14;
const GPG_USERID_PACKET = 13;
const GPG_SIGNATURE_PACKET = 2;

/** go-crypto's PubKeyAlgo.CanEncrypt/CanSign (packet/packet.go). */
const GPG_ENCRYPT_ALGOS = new Set([1, 2, 16, 18]);
const GPG_SIGN_ALGOS = new Set([1, 3, 17, 19, 22]);

function gpgParseError(detail: string): GpgKeyParseError {
  return new GpgKeyParseError(detail);
}

/** RFC 4880 §6 CRC-24 (go-crypto armor checks it when the checksum line is
 *  present). */
function crc24(data: Uint8Array): number {
  const POLY = 0x864cfb;
  let crc = 0xb704ce;
  for (const byte of data) {
    crc ^= byte << 16;
    for (let i = 0; i < 8; i++) {
      crc <<= 1;
      if (crc & 0x1000000) {
        crc ^= POLY;
      }
    }
  }
  return crc & 0xffffff;
}

/** Decode the RFC 4880 ASCII armor (the first PUBLIC KEY BLOCK found). */
function dearmor(armored: string): Uint8Array {
  const BEGIN = "-----BEGIN PGP PUBLIC KEY BLOCK-----";
  const END = "-----END PGP PUBLIC KEY BLOCK-----";
  const begin = armored.indexOf(BEGIN);
  if (begin < 0) {
    throw gpgParseError("no armored public key block found");
  }
  const rest = armored.slice(begin + BEGIN.length);
  const end = rest.indexOf(END);
  if (end < 0) {
    throw gpgParseError("unterminated armored public key block");
  }
  const lines = rest.slice(0, end).split(/\r\n|\r|\n/);
  let i = 0;
  // RFC 4880 §6.2: key-value headers, then a blank line, then the base64 body.
  while (i < lines.length && (lines[i] ?? "").trim() !== "") {
    i += 1;
  }
  i += 1;
  const base64Lines: string[] = [];
  let checksumLine: string | null = null;
  for (; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "") {
      continue;
    }
    if (line.startsWith("=")) {
      checksumLine = line;
      break;
    }
    base64Lines.push(line);
  }
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(base64Lines.join(""));
  } catch {
    throw gpgParseError("invalid armor encoding");
  }
  if (checksumLine !== null && checksumLine.length === 5) {
    // The checksum is base64-encoded (4 chars → the 24-bit value).
    const encoded = base64ToBytes(checksumLine.slice(1, 5));
    const expected = (encoded[0]! << 16) | (encoded[1]! << 8) | encoded[2]!;
    if (expected !== crc24(bytes)) {
      throw gpgParseError("armor checksum mismatch");
    }
  }
  return bytes;
}

interface RawPacket {
  tag: number;
  body: Uint8Array;
}

/** Walk the binary packet sequence (RFC 4880 §4.2; partial lengths are a
 *  documented-unsupported arm). */
function walkPackets(bytes: Uint8Array): RawPacket[] {
  const packets: RawPacket[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    const first = bytes[offset]!;
    if ((first & 0x80) === 0) {
      throw gpgParseError("invalid packet header");
    }
    let tag: number;
    let length: number;
    let headerLength: number;
    if ((first & 0x40) === 0) {
      // Old format: 3 tag bits, 2 length-type bits.
      tag = (first >> 2) & 0x0f;
      const lengthType = first & 0x03;
      if (lengthType === 3) {
        throw gpgParseError("indeterminate packet length unsupported");
      }
      headerLength = 1 + (1 << lengthType);
      if (offset + headerLength > bytes.length) {
        throw gpgParseError("truncated packet header");
      }
      length = 0;
      for (let i = 0; i <= lengthType; i++) {
        length = length * 256 + bytes[offset + 1 + i]!;
      }
    } else {
      // New format lengths (RFC 4880 §4.2.3).
      tag = first & 0x3f;
      if (offset + 2 > bytes.length) {
        throw gpgParseError("truncated packet header");
      }
      const b1 = bytes[offset + 1]!;
      if (b1 < 192) {
        length = b1;
        headerLength = 2;
      } else if (b1 <= 223) {
        if (offset + 3 > bytes.length) {
          throw gpgParseError("truncated packet header");
        }
        length = (b1 - 192) * 256 + bytes[offset + 2]! + 192;
        headerLength = 3;
      } else if (b1 === 255) {
        if (offset + 6 > bytes.length) {
          throw gpgParseError("truncated packet header");
        }
        length = view.getUint32(offset + 2);
        headerLength = 6;
      } else {
        throw gpgParseError("partial packet lengths unsupported");
      }
    }
    const bodyStart = offset + headerLength;
    if (bodyStart + length > bytes.length) {
      throw gpgParseError("truncated packet body");
    }
    packets.push({ tag, body: bytes.subarray(bodyStart, bodyStart + length) });
    offset = bodyStart + length;
  }
  return packets;
}

/** MPI reader (RFC 4880 §3.2): 2-bit-length bytes + ceil(bits/8) octets. */
function readMpi(body: Uint8Array, offset: number): number {
  if (offset + 2 > body.length) {
    throw gpgParseError("truncated MPI");
  }
  const bits = (body[offset]! << 8) | body[offset + 1]!;
  const byteLength = Math.ceil(bits / 8);
  if (offset + 2 + byteLength > body.length) {
    throw gpgParseError("truncated MPI");
  }
  return offset + 2 + byteLength;
}

/**
 * Validate a v4 public-key packet body; returns {created, algo, canSign,
 * canEncrypt}. Algorithm-specific material walks (RSA/DSA/ElGamal MPIs,
 * ECC OIDs+points, ECDH KDF tail) per RFC 4880 §5.5.2.
 */
function parseV4PublicKeyBody(body: Uint8Array): {
  created: Date;
  algo: number;
  canSign: boolean;
  canEncrypt: boolean;
} {
  if (body.length < 6) {
    throw gpgParseError("short public key packet");
  }
  const version = body[0]!;
  if (version !== 4) {
    throw gpgParseError(`unsupported public key version ${version} (v4 only)`);
  }
  const created = new Date(
    ((body[1]! << 24) | (body[2]! << 16) | (body[3]! << 8) | body[4]!) * 1000,
  );
  const algo = body[5]!;
  let offset = 6;
  switch (algo) {
    case 1: // RSA
    case 2: // RSA encrypt-only
    case 3: // RSA sign-only
      offset = readMpi(body, offset); // n
      offset = readMpi(body, offset); // e
      break;
    case 16: // ElGamal
      offset = readMpi(body, offset); // p
      offset = readMpi(body, offset); // g
      offset = readMpi(body, offset); // y
      break;
    case 17: // DSA
      offset = readMpi(body, offset); // p
      offset = readMpi(body, offset); // q
      offset = readMpi(body, offset); // g
      offset = readMpi(body, offset); // y
      break;
    case 18: // ECDH
    case 19: // ECDSA
    case 22: // EdDSA
      offset = readMpi(body, offset); // OID
      offset = readMpi(body, offset); // point
      if (algo === 18) {
        if (offset + 1 > body.length) {
          throw gpgParseError("truncated ECDH KDF fields");
        }
        offset += 1 + body[offset]!;
      }
      break;
    default:
      throw gpgParseError(`unsupported public key algorithm ${algo}`);
  }
  if (offset !== body.length) {
    throw gpgParseError("trailing bytes in public key packet");
  }
  return { created, algo, canSign: GPG_SIGN_ALGOS.has(algo), canEncrypt: GPG_ENCRYPT_ALGOS.has(algo) };
}

/** v4 fingerprint: SHA-1 over `0x99 ‖ len16 ‖ body`; the key id is the low 64
 *  bits, hex uppercase (RFC 4880 §12.2). The canonical serialization
 *  (`0x99 ‖ len16 ‖ body`) is also upstream's stored `content`
 *  (Base64EncPubKey → packet.Serialize). */
async function v4KeyIdentity(body: Uint8Array): Promise<{ keyId: string; content: string }> {
  const framed = new Uint8Array(3 + body.length);
  framed[0] = 0x99;
  framed[1] = body.length >> 8;
  framed[2] = body.length & 0xff;
  framed.set(body, 3);
  const digestHex = await shaHex("SHA-1", framed);
  return { keyId: digestHex.slice(-16).toUpperCase(), content: bytesToBase64(framed) };
}

/** Extract the address from a user-id packet (RFC 4880 §5.11 "Name
 *  (Comment) <email>"); bare addresses pass through. */
function userIdEmail(body: Uint8Array): string | null {
  const text = new TextDecoder().decode(body).trim();
  const matches = [...text.matchAll(/<([^<>]*)>/g)];
  const last = matches[matches.length - 1];
  const candidate = (last !== undefined ? last[1] : text) ?? "";
  const trimmed = candidate.trim();
  return /^[^\s<>@]+@[^\s<>@]+$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * Read the key-lifetime subpacket (type 9, RFC 4880 §5.2.3.9) from a v4
 * signature's hashed area; the LAST one found wins (upstream prefers the
 * IsPrimaryId self-signature — the misc-t3 module header documents the
 * corner).
 */
function signatureLifetime(body: Uint8Array): number | null {
  if (body.length < 6 || body[0] !== 4) {
    return null; // v3 signatures carry no lifetime
  }
  const hashedLength = (body[4]! << 8) | body[5]!;
  const hashedEnd = Math.min(6 + hashedLength, body.length);
  let offset = 6;
  let lifetime: number | null = null;
  while (offset < hashedEnd) {
    let subLength: number;
    let headerLength: number;
    const b1 = body[offset]!;
    if (b1 < 192) {
      subLength = b1;
      headerLength = 1;
    } else if (b1 <= 254) {
      if (offset + 2 > hashedEnd) {
        return lifetime;
      }
      subLength = (b1 - 192) * 256 + body[offset + 1]! + 192;
      headerLength = 2;
    } else {
      if (offset + 5 > hashedEnd) {
        return lifetime;
      }
      subLength = (body[offset + 1]! << 24) | (body[offset + 2]! << 16) | (body[offset + 3]! << 8) | body[offset + 4]!;
      headerLength = 5;
    }
    const dataStart = offset + headerLength;
    if (dataStart + subLength > hashedEnd) {
      return lifetime;
    }
    if (subLength === 4 && (body[dataStart]! & 0x7f) === 9) {
      lifetime = (body[dataStart + 1]! << 24) | (body[dataStart + 2]! << 16) | (body[dataStart + 3]! << 8) | body[dataStart + 4]!;
    }
    offset = dataStart + subLength;
  }
  return lifetime;
}

/**
 * Parse an armored OpenPGP key into entities (the CheckArmoredGPGKeyString
 * subset: v4 packets only). Multi-entity armors coalesce per key id exactly
 * like upstream AddGPGKey's id2key merge (gpg_key_add.go:82-112).
 */
async function parseArmoredGpgKey(armored: string): Promise<ParsedGpgEntity[]> {
  const packets = walkPackets(dearmor(armored));
  type Owner = ParsedGpgEntity;
  const owners = new Map<string, Owner>();
  let current: Owner | null = null;
  let currentSubkey: ParsedGpgSubkey | null = null;
  for (const { tag, body } of packets) {
    if (tag === GPG_KEY_PACKET || tag === GPG_SUBKEY_PACKET) {
      const parsed = parseV4PublicKeyBody(body);
      const { keyId, content } = await v4KeyIdentity(body);
      const owner: Owner = {
        keyId,
        created: parsed.created,
        expires: null,
        content,
        canSign: parsed.canSign,
        canEncrypt: parsed.canEncrypt,
        identityEmails: [],
        subkeys: [],
      };
      if (tag === GPG_KEY_PACKET) {
        const existing = owners.get(keyId);
        // Upstream coalesces duplicate primary keys into one entity; the
        // merge keeps the first occurrence's fields and unions subkeys.
        if (existing !== undefined) {
          current = existing;
        } else {
          owners.set(keyId, owner);
          current = owner;
        }
        currentSubkey = null;
      } else {
        if (current === null) {
          throw gpgParseError("subkey before primary key");
        }
        current.subkeys.push(owner);
        currentSubkey = owner;
      }
    } else if (tag === GPG_USERID_PACKET) {
      if (current === null) {
        throw gpgParseError("user id before primary key");
      }
      const email = userIdEmail(body);
      if (email !== null && !current.identityEmails.includes(email)) {
        current.identityEmails.push(email);
      }
      currentSubkey = null;
    } else if (tag === GPG_SIGNATURE_PACKET) {
      const lifetime = signatureLifetime(body);
      if (lifetime !== null) {
        const target = currentSubkey ?? current;
        if (target !== null) {
          target.expires = target.created.getTime() / 1000 + lifetime;
        }
      }
    }
  }
  if (owners.size === 0) {
    throw gpgParseError("no public key found in armor");
  }
  return [...owners.values()];
}

// ---------------------------------------------------------------------------
// The write arms (upstream KeysPost "ssh"/"gpg" over the landed inserts)
// ---------------------------------------------------------------------------

/** asymkey_model.PaddedKeyID (gpg_key.go:63-69) — the template's display id. */
export function paddedKeyID(keyId: string): string {
  if (keyId.length > 15) {
    return keyId;
  }
  return "0000000000000000".slice(0, 16 - keyId.length) + keyId;
}

/** The keys POST body (upstream forms.AddKeyForm's rendered fields —
 *  services/forms/user_form.go:216-225; `signature` is answered with the
 *  invalid-token-signature message, see the header's reductions). */
export interface UserSettingsKeysForm {
  type: string;
  title: string;
  content: string;
  signature: string;
}

/** Parse the urlencoded keys POST (the readUrlEncodedForm convention). */
export function parseUserSettingsKeysForm(params: URLSearchParams): UserSettingsKeysForm {
  return {
    type: params.get("type") ?? "",
    title: params.get("title") ?? "",
    content: params.get("content") ?? "",
    signature: params.get("signature") ?? "",
  };
}

/** The keys/delete POST body (upstream DeleteKey's type + id pair). */
export interface UserSettingsKeysDeleteForm {
  type: string;
  id: number | null;
}

export function parseUserSettingsKeysDeleteForm(params: URLSearchParams): UserSettingsKeysDeleteForm {
  const raw = params.get("id") ?? "";
  return { type: params.get("type") ?? "", id: /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : null };
}

/** The add outcomes the POST handler renders (the org-settings-hooks
 *  create-result pattern): `kind` routes the error line + field error class
 *  to the submitting form (upstream's HasSSHError/HasGPGError pair), `field`
 *  is upstream's Err_Title/Err_Content. */
export type AddKeyOutcome =
  | { outcome: "created"; kind: "ssh" | "gpg"; label: string }
  | { outcome: "invalid"; kind: "ssh" | "gpg"; message: string; field?: "title" | "content" };

/** The one-read owner lookup the POST arms share (the handler's
 *  silent-auth-failure 404 input — the loadUserSettingsPageData slice). */
export async function loadUserSettingsKeysOwner(d1: D1Database, userId: number): Promise<typeof users.$inferSelect | null> {
  return (
    (await drizzle(d1).select().from(users).where(eq(users.id, userId)).get()) ?? null
  );
}

/**
 * The SSH add — upstream KeysPost "ssh" (keys.go:196-232) over the landed
 * API insert sequence (misc-t3.ts addPublicKey): the Required-title binder
 * arm first (the web binder's `Title: Required`, api.go:841-844's spelling),
 * then parse → global fingerprint 422 → per-owner name 422 → insert (mode 2
 * / type 1 / verified false, created = updated = now).
 */
export async function addSshKeyFromForm(d1: D1Database, owner: typeof users.$inferSelect, form: UserSettingsKeysForm): Promise<AddKeyOutcome> {
  if (form.title === "") {
    return { outcome: "invalid", kind: "ssh", message: "Title: Required", field: "title" };
  }
  let parsed: ParsedSshKey;
  try {
    parsed = await parseSshPublicKey(form.content);
  } catch (error) {
    if (error instanceof SshKeyParseError) {
      return { outcome: "invalid", kind: "ssh", message: `${userSettingsKeysLocale.invalid_ssh_key_prefix}${error.message}`, field: "content" };
    }
    throw error;
  }
  const db = drizzle(d1);
  const fingerprintTaken = await db
    .select({ id: publicKeys.id })
    .from(publicKeys)
    .where(eq(publicKeys.fingerprint, parsed.fingerprint))
    .limit(1);
  if (fingerprintTaken.length > 0) {
    return { outcome: "invalid", kind: "ssh", message: userSettingsKeysLocale.ssh_key_been_used, field: "content" };
  }
  const nameTaken = await db
    .select({ id: publicKeys.id })
    .from(publicKeys)
    .where(and(eq(publicKeys.ownerId, owner.id), eq(publicKeys.name, form.title)))
    .limit(1);
  if (nameTaken.length > 0) {
    return { outcome: "invalid", kind: "ssh", message: userSettingsKeysLocale.ssh_key_name_used, field: "title" };
  }
  const now = new Date();
  const inserted = await db
    .insert(publicKeys)
    .values({
      ownerId: owner.id,
      name: form.title,
      fingerprint: parsed.fingerprint,
      content: parsed.content,
      mode: 2,
      type: 1,
      loginSourceId: 0,
      verified: false,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return { outcome: "created", kind: "ssh", label: inserted[0]!.name };
}

/**
 * The GPG add — upstream KeysPost "gpg" (keys.go:92-155) over the landed API
 * insert sequence (misc-t3.ts addGpgKey): the verification token (minutes=1,
 * the exact upstream AddGPGKey argument), the empty-content binder arm, the
 * parse 422, the signature arm (the landed path answers the upstream
 * invalid-token-signature 422 for ANY signature — the header's reduction),
 * the activated-email gate, the per-key global key_id 422, then the primary
 * + subkey inserts.
 */
export async function addGpgKeyFromForm(d1: D1Database, owner: typeof users.$inferSelect, form: UserSettingsKeysForm): Promise<AddKeyOutcome> {
  if (form.content === "") {
    return { outcome: "invalid", kind: "gpg", message: "Content: Required", field: "content" };
  }
  let entities: ParsedGpgEntity[];
  try {
    entities = await parseArmoredGpgKey(form.content);
  } catch (error) {
    if (error instanceof GpgKeyParseError) {
      return { outcome: "invalid", kind: "gpg", message: `${userSettingsKeysLocale.invalid_gpg_key_prefix}${error.message}`, field: "content" };
    }
    throw error;
  }
  if (form.signature !== "") {
    // The landed add path (misc-t3's addGpgKey, checked right after the
    // parse) answers the upstream invalid-token-signature 422 for ANY
    // signature — add-path RSA verification is not implemented anywhere.
    // Upstream's web arm flags BOTH fields for this error (keys.go:132-139:
    // Err_Content + Err_Signature); our form carries no signature field, so
    // the content field takes the error class.
    return { outcome: "invalid", kind: "gpg", message: userSettingsKeysLocale.gpg_invalid_token_signature, field: "content" };
  }
  const db = drizzle(d1);
  // parseGPGKey's email gate (gpg_key.go:163-189): every key needs ≥ 1
  // identity email on an ACTIVATED address of the owner (the synthesized
  // primary counts — misc-t3's note).
  const activated = new Set(
    (
      await db
        .select({ lowerEmail: emailAddresses.lowerEmail })
        .from(emailAddresses)
        .where(and(eq(emailAddresses.userId, owner.id), eq(emailAddresses.isActivated, true)))
    ).map((row) => row.lowerEmail),
  );
  if (owner.email !== null && owner.email !== "") {
    activated.add(owner.email.toLowerCase());
  }
  const now = new Date();
  const inserts: (typeof gpgKeys.$inferInsert)[] = [];
  for (const entity of entities) {
    const keyIdTaken = await db.select({ id: gpgKeys.id }).from(gpgKeys).where(eq(gpgKeys.keyId, entity.keyId)).limit(1);
    if (keyIdTaken.length > 0) {
      return { outcome: "invalid", kind: "gpg", message: userSettingsKeysLocale.gpg_key_id_used, field: "content" };
    }
    if (!entity.identityEmails.some((email) => activated.has(email))) {
      return { outcome: "invalid", kind: "gpg", message: userSettingsKeysLocale.gpg_no_key_email_found, field: "content" };
    }
    inserts.push({
      ownerId: owner.id,
      keyId: entity.keyId,
      primaryKeyId: "",
      content: entity.content,
      verified: false,
      canSign: entity.canSign,
      canEncryptComms: entity.canEncrypt,
      canEncryptStorage: entity.canEncrypt,
      canCertify: entity.canSign,
      createdAt: entity.created,
      expiresAt: entity.expires === null ? null : new Date(entity.expires * 1000),
      addedAt: now,
    });
    for (const subkey of entity.subkeys) {
      // parseSubGPGKey: a subkey without its own lifetime inherits the
      // primary's expiry (gpg_key.go:81-84).
      inserts.push({
        ownerId: owner.id,
        keyId: subkey.keyId,
        primaryKeyId: entity.keyId,
        content: subkey.content,
        verified: false,
        canSign: subkey.canSign,
        canEncryptComms: subkey.canEncrypt,
        canEncryptStorage: subkey.canEncrypt,
        canCertify: subkey.canSign,
        createdAt: subkey.created,
        expiresAt:
          subkey.expires === null ? (entity.expires === null ? null : new Date(entity.expires * 1000)) : new Date(subkey.expires * 1000),
        addedAt: now,
      });
    }
  }
  for (const values of inserts) {
    await db.insert(gpgKeys).values(values);
  }
  // upstream's flash joins the inserted key ids with ", " (keys.go:140-152).
  return { outcome: "created", kind: "gpg", label: entities.map((entity) => entity.keyId).join(", ") };
}

/** The SSH delete — upstream DeleteKey "ssh" (keys.go:284-305): the
 *  externally-managed refusal is unreachable (login_source_id is always 0);
 *  a miss answers the "Failed to delete SSH key" error line (DeletePublicKey's
 *  ErrNotExist arm). */
export async function deleteSshKey(d1: D1Database, userId: number, id: number): Promise<"deleted" | "missing"> {
  const row = (
    await drizzle(d1)
      .select({ id: publicKeys.id })
      .from(publicKeys)
      .where(and(eq(publicKeys.id, id), eq(publicKeys.ownerId, userId), eq(publicKeys.type, 1)))
      .limit(1)
  )[0];
  if (row === undefined) {
    return "missing";
  }
  await drizzle(d1).delete(publicKeys).where(eq(publicKeys.id, row.id));
  return "deleted";
}

/** The GPG delete — upstream DeleteKey "gpg" (keys.go:266-283) over
 *  DeleteGPGKey: idempotent (nil on ErrGPGKeyNotExist — the misc-t3 DELETE
 *  arm's note), and the row's subkeys go with it (DeleteGPGKey deletes the
 *  primary AND every `primary_key_id` child — the misc-t3 delete's or-shape). */
export async function deleteGpgKey(d1: D1Database, userId: number, id: number): Promise<"deleted"> {
  const row = (
    await drizzle(d1)
      .select({ keyId: gpgKeys.keyId })
      .from(gpgKeys)
      .where(and(eq(gpgKeys.id, id), eq(gpgKeys.ownerId, userId)))
      .limit(1)
  )[0];
  if (row !== undefined) {
    await drizzle(d1)
      .delete(gpgKeys)
      .where(or(eq(gpgKeys.keyId, row.keyId), eq(gpgKeys.primaryKeyId, row.keyId)));
  }
  return "deleted";
}

// ---------------------------------------------------------------------------
// The list loader (upstream loadKeysData, keys.go:318-363, minus the
// principals read and the TokenToSign — see the header's reductions)
// ---------------------------------------------------------------------------

/** One rendered SSH key row: the stored row plus upstream's AfterLoad pair
 *  (ssh_key.go:62-63 — HasUsed `updated > created`, HasRecentActivity
 *  `updated + 7d > now`). */
export interface SshKeyListItem {
  row: typeof publicKeys.$inferSelect;
  hasUsed: boolean;
  hasRecentActivity: boolean;
}

/** One rendered GPG key row: the primary row, its subkey rows (the shared
 *  loadSubkeys read) and the precomputed `expired` (keys_gpg.tmpl:59's green
 *  arm — false when the key never expires or expires after the page time). */
export interface GpgKeyListItem {
  row: typeof gpgKeys.$inferSelect;
  subkeys: (typeof gpgKeys.$inferSelect)[];
  expired: boolean;
}

/** The keys tab's render inputs. `form` re-renders the add forms' submitted
 *  values ("" on the plain GET). */
export interface UserSettingsKeysPageData {
  sshKeys: SshKeyListItem[];
  gpgKeys: GpgKeyListItem[];
  form: { title: string; content: string; gpgContent: string };
}

/** The page load — `now` is the HasRecentActivity/expiry clock (fixed-clock
 *  tests, the milestones loader pattern). */
export async function loadUserSettingsKeysPageData(d1: D1Database, userId: number, now: Date = new Date()): Promise<UserSettingsKeysPageData> {
  const db = drizzle(d1);
  const activityFloor = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const sshRows = await db
    .select()
    .from(publicKeys)
    .where(and(eq(publicKeys.ownerId, userId), eq(publicKeys.type, 1)))
    .orderBy(asc(publicKeys.id))
    .all();
  const gpgRows = await db
    .select()
    .from(gpgKeys)
    .where(and(eq(gpgKeys.ownerId, userId), eq(gpgKeys.primaryKeyId, "")))
    .orderBy(asc(gpgKeys.id))
    .all();
  const subkeys = await loadSubkeys(
    d1,
    gpgRows.map((row) => row.keyId),
  );
  return {
    sshKeys: sshRows.map((row) => ({
      row,
      hasUsed: row.updatedAt.getTime() > row.createdAt.getTime(),
      hasRecentActivity: row.updatedAt.getTime() > row.createdAt.getTime() && row.updatedAt.getTime() >= activityFloor,
    })),
    gpgKeys: gpgRows.map((row) => ({
      row,
      subkeys: subkeys.get(row.keyId) ?? [],
      expired: row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime(),
    })),
    form: { title: "", content: "", gpgContent: "" },
  };
}

// ---------------------------------------------------------------------------
// The render (templates/user/settings/keys.tmpl at the pin)
// ---------------------------------------------------------------------------

/** Upstream `DateUtils.AbsoluteShort` ("Jan 2, 2006") — UTC, hand-rolled so
 *  the bytes never depend on the runtime's ICU (the milestones.tsx
 *  formatDueDate precedent). */
export function formatKeyDate(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** The item-leading key glyph. Upstream renders `{{svg "octicon-key" 32}}`;
 *  octicon-key is outside the generated icon allowlist — octicon-shield-lock
 *  is the documented stand-in (the feeds-glyph convention; a later
 *  allowlist extension swaps it per this one-line site). */
const KEY_ICON: IconName = "octicon-shield-lock";

/** Upstream renders `{{svg "octicon-verified"}}` for the Verified badge;
 *  octicon-verified is outside the allowlist — octicon-check stands in. */
const VERIFIED_ICON: IconName = "octicon-check";

/** The settings navbar (user/settings/navbar.tmpl reduced to the landed
 *  items — the module header). `active` marks this tab. */
function UserSettingsKeysNav(props: { active: "profile" | "applications" | "keys" }) {
  return (
    <div class="flex-container-nav">
      <div class="ui fluid vertical menu">
        <div class="header item">{userSettingsKeysLocale.settings}</div>
        <a class={props.active === "profile" ? "active item" : "item"} href="/user/settings">
          {userSettingsKeysLocale.profile}
        </a>
        <a class={props.active === "applications" ? "active item" : "item"} href="/user/settings/applications">
          {userSettingsKeysLocale.applications}
        </a>
        <a class={props.active === "keys" ? "active item" : "item"} href="/user/settings/keys">
          {userSettingsKeysLocale.ssh_gpg_keys}
        </a>
      </div>
    </div>
  );
}

/** The added-on / last-used line (keys_ssh.tmpl:54-56's `.item-body`). */
function KeyUsageLine(props: { addedAt: Date; hasUsed: boolean; lastUsedAt: Date | null; hasRecentActivity: boolean }) {
  return (
    <div class="item-body">
      <i>
        {userSettingsKeysLocale.added_on} {formatKeyDate(props.addedAt)} — <Icon name="octicon-info" />
        {props.hasUsed && props.lastUsedAt !== null ? (
          <>
            {` ${userSettingsKeysLocale.last_used} `}
            <span class={props.hasRecentActivity ? "tw-text-green" : undefined}>{formatKeyDate(props.lastUsedAt)}</span>
          </>
        ) : (
          ` ${userSettingsKeysLocale.no_activity}`
        )}
      </i>
    </div>
  );
}

/** The Remove form (keys_ssh.tmpl:58-61's link-action button as the plain
 *  form POST — the module header's reduction). */
function KeyRemoveForm(props: { type: "ssh" | "gpg"; id: number }) {
  return (
    <form method="post" action="/user/settings/keys/delete">
      <input type="hidden" name="type" value={props.type} />
      <input type="hidden" name="id" value={String(props.id)} />
      <button type="submit" class="ui red tiny button">
        {userSettingsKeysLocale.remove}
      </button>
    </form>
  );
}

/** The failed POST's re-render input: `kind` routes to the submitting form,
 *  `field` is the field error class. */
export type KeysPageError = { kind: "ssh" | "gpg"; message: string; field?: "title" | "content" };

/** The full-document render (the render.tsx pattern). `error` carries the
 *  failed POST's outcome (null on the plain GET) and `data.form` re-renders
 *  the submitting form's values (upstream RenderWithErrDeprecated's arm). */
export function renderUserSettingsKeysPage(ctx: UiContext, data: UserSettingsKeysPageData, error: KeysPageError | null = null): string {
  return renderPage(<UserSettingsKeysPage ctx={ctx} data={data} error={error} />);
}

/** The keys page (§2.4.1 discriminator: `user settings sshkeys` —
 *  layout_head's pageClass). */
export function UserSettingsKeysPage(props: { ctx: UiContext; data: UserSettingsKeysPageData; error: KeysPageError | null }) {
  const { ctx, data } = props;
  const error_ = props.error;
  const sshError = error_?.kind === "ssh" ? error_ : null;
  const gpgError = error_?.kind === "gpg" ? error_ : null;
  return (
    <BaseLayout ctx={ctx} title={userSettingsKeysLocale.ssh_gpg_keys} pageClass="user settings sshkeys">
      <div class="ui container flex-container">
        <UserSettingsKeysNav active="keys" />
        <div class="user-setting-content">
          {/* ------------------------------------------------ SSH (keys_ssh.tmpl) */}
          <h4 class="ui top attached header">
            {userSettingsKeysLocale.manage_ssh_keys}
            {/* The Add Key toggle button is the bundle's show-panel control —
                the no-JS reduction renders the form directly (the header). */}
          </h4>
          <div class="ui attached segment">
            {/* The add panel, rendered open (upstream tw-hidden until the
                toggle; the compare.tsx reduction). The GPG form's hidden
                title=none input is upstream's AddKeyForm.Title filler — the
                ssh form carries the real title field. */}
            <div class="tw-mb-4" id="add-ssh-key-panel">
              <form class="ui form" action="/user/settings/keys" method="post">
                {sshError !== null ? <div class="ui negative message">{sshError.message}</div> : null}
                <div class={sshError?.field === "title" ? "field error" : "field"}>
                  <label for="ssh-key-title">{userSettingsKeysLocale.key_name}</label>
                  <input id="ssh-key-title" name="title" value={data.form.title} required maxlength={50} />
                </div>
                <div class={sshError?.field === "content" ? "field error" : "field"}>
                  <label for="ssh-key-content">{userSettingsKeysLocale.key_content}</label>
                  <textarea id="ssh-key-content" name="content" placeholder={userSettingsKeysLocale.key_content_ssh_placeholder} required>
                    {data.form.content}
                  </textarea>
                </div>
                <input name="type" type="hidden" value="ssh" />
                <button type="submit" class="ui primary button">
                  {userSettingsKeysLocale.add_key}
                </button>
              </form>
            </div>
            <div id="keys-ssh" class="flex-divided-list items-with-main">
              <div class="item">
                <p>
                  {userSettingsKeysLocale.ssh_desc}
                  <br />
                  {/* ssh_helper's literal GitHub docs links (external
                      anchors — not app-internal dead links). */}
                  <strong>{userSettingsKeysLocale.ssh_helper_need_help}</strong> Have a look at GitHub's guide to{" "}
                  <a href="https://docs.github.com/en/free-pro-team@latest/github/authenticating-to-github/connecting-to-github-with-ssh">
                    {userSettingsKeysLocale.ssh_helper_create}
                  </a>{" "}
                  or solve{" "}
                  <a href="https://docs.github.com/en/free-pro-team@latest/github/authenticating-to-github/troubleshooting-ssh">
                    {userSettingsKeysLocale.ssh_helper_problems}
                  </a>{" "}
                  you may encounter using SSH.
                </p>
              </div>
              {data.sshKeys.map((key) => (
                <div class="item" key={key.row.id}>
                  <div class="item-leading">
                    <span
                      class={key.hasRecentActivity ? "tw-text-green" : undefined}
                      data-tooltip-content={key.hasRecentActivity ? userSettingsKeysLocale.key_state_desc : undefined}
                    >
                      <Icon name={KEY_ICON} size={32} />
                    </span>
                  </div>
                  <div class="item-main">
                    {key.row.verified ? (
                      <div class="item-title flex-text-block" data-tooltip-content={userSettingsKeysLocale.ssh_key_verified_long}>
                        <Icon name={VERIFIED_ICON} />
                        {userSettingsKeysLocale.ssh_key_verified}
                      </div>
                    ) : null}
                    <div class="item-title">{key.row.name}</div>
                    <div class="item-body">{key.row.fingerprint}</div>
                    <KeyUsageLine
                      addedAt={key.row.createdAt}
                      hasUsed={key.hasUsed}
                      lastUsedAt={key.row.updatedAt}
                      hasRecentActivity={key.hasRecentActivity}
                    />
                  </div>
                  <div class="item-trailing">
                    <KeyRemoveForm type="ssh" id={key.row.id} />
                  </div>
                </div>
              ))}
            </div>
          </div>
          {/* ------------------------------------------------ GPG (keys_gpg.tmpl) */}
          <h4 class="ui top attached header">
            {userSettingsKeysLocale.manage_gpg_keys}
            {/* The same show-panel toggle reduction as the ssh panel. */}
          </h4>
          <div class="ui attached segment">
            <div class="tw-mb-4" id="add-gpg-key-panel">
              <form class="ui form" action="/user/settings/keys" method="post">
                {gpgError !== null ? <div class="ui negative message">{gpgError.message}</div> : null}
                <input type="hidden" name="title" value="none" />
                <div class={gpgError?.field === "content" ? "field error" : "field"}>
                  <label for="gpg-key-content">{userSettingsKeysLocale.key_content}</label>
                  <textarea id="gpg-key-content" name="content" placeholder={userSettingsKeysLocale.key_content_gpg_placeholder} required>
                    {data.form.gpgContent}
                  </textarea>
                </div>
                {/* No signature textarea: upstream renders it only under
                    Err_Signature — the verify machinery this module does not
                    render (the header). */}
                <input name="type" type="hidden" value="gpg" />
                <button type="submit" class="ui primary button">
                  {userSettingsKeysLocale.add_key}
                </button>
              </form>
            </div>
            <div class="flex-divided-list items-with-main">
              <div class="item">
                <p>
                  {userSettingsKeysLocale.gpg_desc}
                  <br />
                  {/* gpg_helper's literal GitHub docs link. */}
                  <strong>{userSettingsKeysLocale.gpg_helper_need_help}</strong> Have a look at GitHub's guide{" "}
                  <a href="https://docs.github.com/en/free-pro-team@latest/github/authenticating-to-github/about-commit-signature-verification#gpg-commit-signature-verification">
                    {userSettingsKeysLocale.gpg_helper_about}
                  </a>
                  .
                </p>
              </div>
              {data.gpgKeys.map((key) => {
                // keys_gpg.tmpl:59's green arm — green when the key never
                // expires or expires after the page time (the loader's
                // precomputed `expired`, the fixed-clock note).
                const notExpired = !key.expired;
                return (
                  <div class="item" key={key.row.id}>
                    <div class="item-leading">
                      <span class={notExpired ? "tw-text-green" : undefined}>
                        <Icon name={KEY_ICON} size={32} />
                      </span>
                    </div>
                    <div class="item-main">
                      {key.row.verified ? (
                        <span class="flex-text-block" data-tooltip-content={userSettingsKeysLocale.gpg_key_verified_long}>
                          <Icon name={VERIFIED_ICON} /> <strong>{userSettingsKeysLocale.gpg_key_verified}</strong>
                        </span>
                      ) : null}
                      {/* The matched-identities line never renders: the store
                          keeps no parsed emails (the module header). */}
                      <div class="item-body">
                        <b>{userSettingsKeysLocale.key_id}:</b> {paddedKeyID(key.row.keyId)}
                        {key.subkeys.length > 0 ? (
                          <>
                            <b>{userSettingsKeysLocale.subkeys}:</b>
                            {key.subkeys.map((subkey) => (
                              <span key={subkey.id}>{` ${paddedKeyID(subkey.keyId)} `}</span>
                            ))}
                          </>
                        ) : null}
                      </div>
                      <div class="item-body">
                        <i>
                          {userSettingsKeysLocale.added_on} {formatKeyDate(key.row.addedAt)}
                        </i>
                        {" - "}
                        <i>
                          {key.row.expiresAt !== null ? (
                            <>
                              {userSettingsKeysLocale.valid_until} {formatKeyDate(key.row.expiresAt)}
                            </>
                          ) : (
                            userSettingsKeysLocale.valid_forever
                          )}
                        </i>
                      </div>
                    </div>
                    <div class="item-trailing">
                      <KeyRemoveForm type="gpg" id={key.row.id} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </BaseLayout>
  );
}
