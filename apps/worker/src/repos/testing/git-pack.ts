/**
 * Minimal git receive-pack request builder for lifecycle tests (workerd-safe:
 * WebCrypto SHA-1 + CompressionStream only). Produces a self-contained pack
 * (blob → tree → commit, all SHA-1s real) so the engine's connectivity check
 * accepts the push — enough for push-create and first-push flows in vitest.
 */

export const ZERO_OID = "0".repeat(40);

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha1(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-1", bytes));
}

async function sha1Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
}

/** zlib-deflate (git object format) via the workerd-native transform. */
async function zlibDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** pkt-line: 4 HEX digits of (payload + 4) length, then the payload. */
export function pktLine(payload: string): string {
  return `${(payload.length + 4).toString(16).padStart(4, "0")}${payload}`;
}

/** Build one self-contained commit (blob + tree + commit) and its pack. */
export async function buildPack(): Promise<{ oid: string; pack: Uint8Array }> {
  const blob = new TextEncoder().encode("hello push-create\n");
  const blobSha = await sha1(concatArrays([new TextEncoder().encode(`blob ${blob.length}\0`), blob]));

  const treeBody = concatArrays([new TextEncoder().encode("100644 file.txt\0"), rawOid(blobSha)]);
  const treeSha = await sha1(concatArrays([new TextEncoder().encode(`tree ${treeBody.length}\0`), treeBody]));

  const time = 1700000000;
  const commitBody = new TextEncoder().encode(
    `tree ${treeSha}\n` +
      `author Test User <test@example.com> ${time} +0000\n` +
      `committer Test User <test@example.com> ${time} +0000\n\n` +
      "initial push-create\n",
  );
  const commitSha = await sha1(
    concatArrays([new TextEncoder().encode(`commit ${commitBody.length}\0`), commitBody]),
  );

  const entries: { type: number; body: Uint8Array }[] = [
    { type: 3, body: blob }, // OBJ_BLOB
    { type: 2, body: treeBody }, // OBJ_TREE
    { type: 1, body: commitBody }, // OBJ_COMMIT
  ];
  const chunks: Uint8Array[] = [new TextEncoder().encode("PACK"), be32(2), be32(entries.length)];
  for (const entry of entries) {
    chunks.push(objectHeader(entry.type, entry.body.length));
    chunks.push(await zlibDeflate(entry.body));
  }
  chunks.push(await sha1Bytes(concatArrays(chunks)));
  return { oid: commitSha, pack: concatArrays(chunks) };
}

/** A full `git-receive-pack` request body: command section + flush + pack. */
export function buildReceivePackBody(
  updates: { ref: string; oid: string }[],
  pack: Uint8Array,
): Uint8Array {
  let section = "";
  for (const update of updates) {
    section += pktLine(`${ZERO_OID} ${update.oid} ${update.ref}\0report-status side-band-64k`);
  }
  section += "0000";
  return concatArrays([new TextEncoder().encode(section), pack]);
}

function objectHeader(type: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let first = (type << 4) | (size & 0x0f);
  let rest = size >> 4;
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest >>= 7;
  }
  bytes.push(first);
  return new Uint8Array(bytes);
}

function be32(value: number): Uint8Array {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function rawOid(oidHex: string): Uint8Array {
  const raw = new Uint8Array(20);
  for (let i = 0; i < 20; i++) raw[i] = parseInt(oidHex.slice(i * 2, i * 2 + 2), 16);
  return raw;
}

function concatArrays(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}
