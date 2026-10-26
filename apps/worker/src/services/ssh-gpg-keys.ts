/**
 * The shared SSH/GPG public-key parsers — the single home of the provable
 * upstream subset. This consolidates the three verbatim copies that
 * routes/misc-t3.ts (the route-private originals), api/services/deploy-keys.ts
 * (the "parser seam" header) and ui/pages/user-settings-keys.tsx carried; each
 * now imports from here and keeps only its presentation mapping.
 *
 * ## SSH public keys (the provable OpenSSH single-line subset)
 *
 * Upstream's parser is Go-native (`golang.org/x/crypto/ssh`,
 * models/asymkey/ssh_key_parse.go). cf-gitea implements the provable
 * subset: the OpenSSH single-line format (`type base64 [comment]`),
 * structurally validated (the decoded blob must be a well-formed SSH wire
 * string sequence whose first field names the declared type), with the
 * upstream length caps (maxKeyBinaryBytes 4096 → 5461 base64 chars). The
 * fingerprint is upstream's `ssh.FingerprintSHA256` — "SHA256:" +
 * unpadded-std-base64(sha256(blob)) (ssh_key_fingerprint.go:42-48). NOT
 * ported: the SSH2/PEM arms (rejected up front) and Go's exact non-subset
 * error spellings beyond the detail tails (the module headers at the
 * consumers document the Go error-string divergences).
 *
 * ## GPG public keys (the provable v4 OpenPGP subset)
 *
 * The CheckArmoredGPGKeyString subset: RFC 4880 ASCII armor → binary packet
 * walk → v4 public-key/subkey/user-id/signature packets. NOT ported: v5/v6
 * key versions and signature VERIFICATION (key lifetimes are read from
 * type-9 subpackets, but nothing is cryptographically checked). Multi-entity
 * armors coalesce per key id exactly like upstream AddGPGKey's id2key merge
 * (gpg_key_add.go:82-112).
 *
 * ## The error contract (where the three copies had drifted)
 *
 * The parsers throw the DETAIL-ONLY SshKeyParseError / GpgKeyParseError —
 * the tails upstream prefixes. Each consumer maps the detail to its own
 * presentation, which is the drift the consolidation reconciled:
 *
 *   - the API carriers (misc-t3.ts addPublicKey/addGpgKey, deploy-keys.ts
 *     addDeployKeySsh) wrap into the wired 422 ApiError bodies —
 *     HandleCheckKeyStringError's `Invalid key content: <detail>` and
 *     HandleAddGPGKeyError's IsErrGPGKeyParsing arm (err.Error() prefixes
 *     "failed to parse gpg key ", error.go:134-136);
 *   - the UI carrier (user-settings-keys.tsx) catches the classes and
 *     prepends its locale prefix ("form.invalid_ssh_key %s" /
 *     "form.invalid_gpg_key %s") into the re-rendered form outcome.
 *
 * Parse semantics, detail strings and returned shapes are byte-identical to
 * the copies this module replaces (the misc-t3, deploy-keys and
 * user-settings-keys suites pin them).
 *
 * All binary helpers are Web-standard only — workerd has no Node Buffer.
 */

// ---------------------------------------------------------------------------
// The detail-only parse errors (the error contract above)
// ---------------------------------------------------------------------------

/** An SSH public-key parse violation; `message` is the bare detail tail
 *  (the consumer supplies the presentation prefix/status). */
export class SshKeyParseError extends Error {}

/** A GPG armor/packet parse violation; `message` is the bare detail tail
 *  (the consumer supplies the presentation prefix/status). */
export class GpgKeyParseError extends Error {}

// ---------------------------------------------------------------------------
// Binary helpers (Web-standard only — workerd has no Node Buffer)
// ---------------------------------------------------------------------------

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

/** Hex-encode a WebCrypto digest — the ssh/GPG fingerprint renderer and the
 *  verification-token clock (misc-t3.ts) share it. */
export async function shaHex(algo: "SHA-1" | "SHA-256", data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(algo, data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 fingerprint in ssh's rendering: "SHA256:" + unpadded std base64. */
async function sshFingerprint(blob: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", blob));
  return `SHA256:${bytesToBase64(digest).replace(/=+$/, "")}`;
}

// ---------------------------------------------------------------------------
// SSH public key parsing — the provable OpenSSH single-line subset
// (models/asymkey/ssh_key_parse.go)
// ---------------------------------------------------------------------------

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

export interface ParsedSshKey {
  /** The normalized stored content: "type base64 [comment]" (upstream
   *  parseKeyString's return, whitespace-trimmed). */
  content: string;
  fingerprint: string;
}

/**
 * Structural OpenSSH public key validation + SHA-256 fingerprint. Throws the
 * detail-only SshKeyParseError on any violation (upstream
 * HandleCheckKeyStringError's "Invalid key content: …" family — the consumer
 * supplies the prefix/status; see the error contract above).
 */
export async function parseSshPublicKey(raw: string): Promise<ParsedSshKey> {
  let content = raw.trim();
  const invalid = (detail: string): SshKeyParseError => new SshKeyParseError(detail);
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
// GPG key parsing — the provable v4 OpenPGP subset
// ---------------------------------------------------------------------------

interface ParsedGpgSubkey {
  keyId: string;
  created: Date;
  /** Unix seconds, or null when no key lifetime is signed. */
  expires: number | null;
  content: string;
  canSign: boolean;
  canEncrypt: boolean;
}

export interface ParsedGpgEntity {
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
  // Upstream HandleAddGPGKeyError's IsErrGPGKeyParsing arm prefixes
  // "failed to parse gpg key " (error.go:134-136) — the consumer's mapping.
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
 * like upstream AddGPGKey's id2key merge (gpg_key_add.go:82-112). Throws the
 * detail-only GpgKeyParseError on any violation (upstream
 * HandleAddGPGKeyError's IsErrGPGKeyParsing "failed to parse gpg key …"
 * family — the consumer supplies the prefix/status).
 */
export async function parseArmoredGpgKey(armored: string): Promise<ParsedGpgEntity[]> {
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
