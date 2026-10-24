/**
 * Pack fixtures for the invariants tests — workerd-safe (WebCrypto SHA-1 +
 * CompressionStream), same construction as src/repos/imports tests but
 * GENERALIZED: packs may be deliberately thin (a commit-only pack whose tree
 * and parent resolve from an earlier pack), which is what lets the tests
 * place a commit and its tree in DIFFERENT R2 packs and then delete one of
 * them to inject a precise violation kind.
 */

import { ZERO_OID, pktLine } from "../../repos/testing/git-pack";

export interface FixtureObject {
  type: number;
  body: Uint8Array;
  oid: string;
}

function hexBytes(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha1(bytes: Uint8Array): Promise<string> {
  return hexBytes(new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)));
}

async function sha1Bytes(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
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
  for (let i = 0; i < 20; i += 1) raw[i] = Number.parseInt(oidHex.slice(i * 2, i * 2 + 2), 16);
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

async function hashObject(kind: string, body: Uint8Array): Promise<string> {
  return sha1(concatArrays([new TextEncoder().encode(`${kind} ${body.length}\0`), body]));
}

export async function blobObject(content: string): Promise<FixtureObject> {
  const body = new TextEncoder().encode(content);
  return { type: 3, body, oid: await hashObject("blob", body) };
}

export async function treeObject(entries: { name: string; oid: string }[]): Promise<FixtureObject> {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    parts.push(new TextEncoder().encode(`100644 ${entry.name}\0`));
    parts.push(rawOid(entry.oid));
  }
  const body = concatArrays(parts);
  return { type: 2, body, oid: await hashObject("tree", body) };
}

export async function commitObject(
  treeOid: string,
  parents: string[],
  message: string,
  time: number,
): Promise<FixtureObject> {
  const parentLines = parents.map((p) => `parent ${p}\n`).join("");
  const body = new TextEncoder().encode(
    `tree ${treeOid}\n${parentLines}author Invariants <inv@example.com> ${time} +0000\n` +
      `committer Invariants <inv@example.com> ${time} +0000\n\n${message}\n`,
  );
  return { type: 1, body, oid: await hashObject("commit", body) };
}

/** A real git pack over exactly these objects — self-contained, or
 *  deliberately thin against objects an earlier pack carries. */
export async function packOf(objects: FixtureObject[]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [new TextEncoder().encode("PACK"), be32(2), be32(objects.length)];
  for (const object of objects) {
    chunks.push(objectHeader(object.type, object.body.length));
    chunks.push(await deflate(object.body));
  }
  chunks.push(await sha1Bytes(concatArrays(chunks)));
  return concatArrays(chunks);
}

/** One commit's self-contained window pack (blob + tree + commit). */
export async function commitPack(
  message: string,
  parents: string[],
  files: { name: string; content: string }[],
  time: number,
): Promise<{ oid: string; treeOid: string; pack: Uint8Array }> {
  const blobs: FixtureObject[] = [];
  const treeEntries: { name: string; oid: string }[] = [];
  for (const file of files) {
    const blob = await blobObject(file.content);
    blobs.push(blob);
    treeEntries.push({ name: file.name, oid: blob.oid });
  }
  const tree = await treeObject(treeEntries);
  const commit = await commitObject(tree.oid, parents, message, time);
  const pack = await packOf([blobs[0]!, tree, commit]);
  return { oid: commit.oid, treeOid: tree.oid, pack };
}

export interface PushUpdate {
  ref: string;
  oid: string;
  /** CAS base; ZERO_OID (create) when omitted. */
  old?: string;
}

/** A full `git-receive-pack` body: command section (real CAS olds) + flush + pack. */
export function buildPushBody(updates: PushUpdate[], pack: Uint8Array): Uint8Array {
  let section = "";
  for (const update of updates) {
    section += pktLine(
      `${update.old ?? ZERO_OID} ${update.oid} ${update.ref}\0report-status side-band-64k`,
    );
  }
  section += "0000";
  return concatArrays([new TextEncoder().encode(section), pack]);
}
