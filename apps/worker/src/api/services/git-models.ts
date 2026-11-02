/**
 * Wire converters for the engine-backed families (branches, tags, refs, trees,
 * blobs, contents, commits, compare, PR diffs) — the ports of upstream
 * `services/convert` (ToPayloadCommit / ToCommitMeta / ToBranch / ToTag /
 * ToCommit) reduced to the engine's CommitJson/DiffResult shapes, plus the
 * Worker-side commit builder the contents-write family needs (SPEC-0004 §3.4
 * delta: tree write → commit write → ref CAS through putApiObjects +
 * commitApiChange, reusing the engine's canonical serializers).
 *
 * Upstream citations (submodule pin fc4936884584):
 *   - ToPayloadCommit (services/convert/git_commit.go:41): author/committer
 *     usernames resolved BY COMMIT EMAIL; url = HTMLURL + "/commit/<sha>";
 *     timestamp = author date; verification unverified.
 *   - ToCommitMeta: url = APIURL + "/git/commits/<sha>".
 *   - ToBranch (convert.go:67): protection flags default off (no rules model
 *     yet — `protected: false`, empty contexts, permissions from the viewer).
 *   - ToTag (convert.go:227): archive URLs on the /archive path.
 *   - Commit message/content rendering: UTF-8 pass-through (MessageUTF8).
 */

import {
  serializeCommit,
  serializeTree,
  type ApiObject,
  type CommitJson,
  type DiffFileJson,
  type DiffResult,
  type Person,
  type TreeEntryJson,
} from "@cf-gitea/git-engine";
import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { users } from "../../db/schema";
import { parsePointer, POINTER_MAX_BYTES } from "../../services/lfs/pointer";
import type {
  AnnotatedTag,
  Branch,
  ChangedFile,
  Commit,
  CommitMeta,
  CommitStats,
  GitBlobResponse,
  GitEntry,
  GitTreeResponse,
  PayloadCommit,
  PayloadCommitVerification,
  Reference,
  RepoCommit,
  Tag,
} from "../models/git";
import type { ContentsResponse } from "../models/contents";
import type { EngineReads, RefTip } from "./engine";
import { apiUserFromRow, type RepositoryWithOwner, type UserRow, type Viewer } from "./repository";

/**
 * The contents-API blob inlining cap — upstream `setting.API.DefaultMaxBlobSize`
 * (modules/setting/api.go:21, default 10 MiB; the `[api] DEFAULT_MAX_BLOB_SIZE`
 * setting): GetBlobBySHA answers `content`/`encoding` null for an over-cap blob
 * WITHOUT reading it (services/repository/files/content.go:233). The former
 * 1 MiB `MAX_CONTENTS_RENDER_BYTES` was an unsanctioned divergence (upstream
 * parity review ㉑ W2). Residual, recorded in SPEC-0004 §3.2: upstream's check
 * rides the tree-entry metadata BEFORE any content read; our engine surface has
 * no size-only RPC, so readBlob's data IS the size probe and an over-cap blob's
 * bytes cross the RPC boundary before the builder drops them — bounded by the
 * same full-blob read /git/blobs already performs uncapped.
 */
export const DEFAULT_MAX_BLOB_SIZE = 10 * 1024 * 1024;

/** Recursive tree walks cap here (truncated=true beyond — upstream behavior). */
export const MAX_RECURSIVE_TREE_ENTRIES = 1000;

/** Base64 of bytes (workerd-native). */
export function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Base64 decode with the whitespace/input tolerance of Go's base64 reader. */
export function base64Decode(text: string): Uint8Array {
  const binary = atob(text.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** RFC3339 (UTC) of a git person timestamp (unix seconds). */
export function personDate(person: Person): string {
  return new Date(person.time * 1000).toISOString();
}

/** Commit e-mail → account username resolution (ToPayloadCommit's GetUserByEmail). */
export async function usernamesByEmail(d1: D1Database, commits: CommitJson[]): Promise<Map<string, string>> {
  const emails = new Set<string>();
  for (const commit of commits) {
    if (commit.author.email !== "") emails.add(commit.author.email.toLowerCase());
    if (commit.committer.email !== "") emails.add(commit.committer.email.toLowerCase());
  }
  const map = new Map<string, string>();
  if (emails.size === 0) return map;
  const rows = await drizzle(d1)
    .select({ email: users.email, username: users.username })
    .from(users)
    .where(inArray(sql`lower(${users.email})`, [...emails]))
    .all();
  for (const row of rows) {
    if (row.email !== null) map.set(row.email.toLowerCase(), row.username);
  }
  return map;
}

/**
 * The same page-batch as usernamesByEmail, carrying the FULL user rows the
 * rich Commit view's author/committer `User` blocks render from
 * (apiUserFromRow). One inArray(lower(email)) select replaces the per-commit
 * findUserRowByEmail pair (the audit A4/B2 dead-batch + 2N re-query fix);
 * first row per lowercased email wins, matching findUserRowByEmail's
 * `limit(1)` parity (not usernamesByEmail's last-wins).
 */
export async function userRowsByEmail(d1: D1Database, commits: CommitJson[]): Promise<Map<string, UserRow>> {
  const emails = new Set<string>();
  for (const commit of commits) {
    if (commit.author.email !== "") emails.add(commit.author.email.toLowerCase());
    if (commit.committer.email !== "") emails.add(commit.committer.email.toLowerCase());
  }
  const map = new Map<string, UserRow>();
  if (emails.size === 0) return map;
  const rows = await drizzle(d1)
    .select()
    .from(users)
    .where(inArray(sql`lower(${users.email})`, [...emails]))
    .all();
  for (const row of rows) {
    if (row.email === null) continue;
    const key = row.email.toLowerCase();
    if (!map.has(key)) map.set(key, row);
  }
  return map;
}

async function findUserRowByEmail(d1: D1Database, email: string) {
  if (email === "") return null;
  const rows = await drizzle(d1)
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
    .limit(1)
    .all();
  return rows[0] ?? null;
}

function toPayloadUser(person: Person, usernames: Map<string, string>): { name: string; email: string; username: string } {
  return {
    name: person.name,
    email: person.email,
    username: usernames.get(person.email.toLowerCase()) ?? "",
  };
}

/** The unverified state ToVerification renders for unsigned commits. */
const UNVERIFIED: PayloadCommitVerification = {
  verified: false,
  reason: "gpg.error.not_signed_commit",
  signature: "",
  signer: null,
  payload: "",
};

/**
 * convert.ToPayloadCommit. The diff lists are ALWAYS emitted: upstream's
 * Added/Removed/Modified carry no omitempty (modules/structs/hook.go:170-175),
 * so an unenriched commit marshals all three as null — ToAPIPayloadCommit's
 * diff-tree fill (commits.go:91-93) is the enrichment that overwrites them
 * with the arrays (our enrichCommitsWithFileLists spread). Branch.commit,
 * webhook push payloads, and every spread site inherit the nulls for free
 * (parity review ㉑ W3: the keys were dropped, not nulled).
 */
export function toPayloadCommit(
  commit: CommitJson,
  pair: RepositoryWithOwner,
  usernames: Map<string, string>,
  origin: string,
): PayloadCommit {
  const owner = encodeURIComponent(pair.repo.ownerNamespace);
  const slug = encodeURIComponent(pair.repo.slug);
  return {
    id: commit.oid,
    message: commit.message,
    url: `${origin}/${owner}/${slug}/commit/${commit.oid}`,
    author: toPayloadUser(commit.author, usernames),
    committer: toPayloadUser(commit.committer, usernames),
    timestamp: personDate(commit.author),
    verification: UNVERIFIED,
    added: null,
    removed: null,
    modified: null,
  };
}

/** convert.ToCommitMeta — the /git/commits url shape. */
export function toCommitMeta(pair: RepositoryWithOwner, origin: string, sha: string, created?: string): CommitMeta {
  const owner = encodeURIComponent(pair.repo.ownerNamespace);
  const slug = encodeURIComponent(pair.repo.slug);
  return {
    sha,
    url: `${origin}/api/v1/repos/${owner}/${slug}/git/commits/${sha}`,
    ...(created === undefined ? {} : { created }),
  };
}

/** commitUser from a git Person (convert.ToCommitUser — UTC RFC3339 date). */
function toCommitUser(person: Person): { name: string; email: string; date: string } {
  return { name: person.name, email: person.email, date: personDate(person) };
}

export interface CommitRenderOptions {
  /** `stat`/`files` query flags (default TRUE upstream — ParseCommitOptions). */
  stat: boolean;
  files: boolean;
  /** The diff for stats/files, precomputed by callers that batch-render. */
  diff?: DiffResult | null;
  /** The page-batched author/committer rows (userRowsByEmail, keyed by
   *  lowercased email) — one inArray select for the whole list instead of a
   *  findUserRowByEmail pair per commit. Absent = the per-commit D1
   *  fallback (single-commit callers keep their 1-2 selects). */
  userRows?: Map<string, UserRow>;
}

/**
 * convert.ToCommit — the rich Commit view. `stats`/`files` ride one readDiff
 * per commit (id..first-parent; root commits diff against the empty tree,
 * matching `git show`). The author/committer `User` blocks resolve via the
 * commit email against the pre-fetched page batch when given (userRows),
 * else the per-commit D1 fallback (null upstream when no account matches).
 */
export async function toApiCommit(
  d1: D1Database,
  reads: EngineReads,
  viewer: Viewer,
  pair: RepositoryWithOwner,
  commit: CommitJson,
  usernames: Map<string, string> | undefined,
  opts: CommitRenderOptions,
): Promise<Commit> {
  const owner = encodeURIComponent(pair.repo.ownerNamespace);
  const slug = encodeURIComponent(pair.repo.slug);
  const htmlUrl = `${viewer.origin}/${owner}/${slug}/commit/${commit.oid}`;
  const apiUrl = `${viewer.origin}/api/v1/repos/${owner}/${slug}`;

  const repoCommit: RepoCommit = {
    author: toCommitUser(commit.author),
    committer: toCommitUser(commit.committer),
    message: commit.message,
    tree: { sha: commit.tree, url: `${apiUrl}/git/trees/${commit.tree}` },
    url: `${apiUrl}/git/commits/${commit.oid}`,
    verification: UNVERIFIED,
  };

  let stats: CommitStats | undefined;
  let files: Commit["files"] | undefined;
  if (opts.stat || opts.files) {
    const resolved = opts.diff !== undefined ? opts.diff : await reads.readDiff(commit.oid);
    if (resolved !== null) {
      if (opts.stat) {
        const additions = resolved.files.reduce((n, f) => n + f.add, 0);
        const deletions = resolved.files.reduce((n, f) => n + f.del, 0);
        stats = { additions, deletions, total: additions + deletions };
      }
      if (opts.files) {
        files = resolved.files.map((f) => ({
          filename: f.path,
          status: f.old === null ? "added" : f.new === null ? "removed" : "modified",
        }));
      }
    }
  }

  // Author/committer rows from the page batch when the caller pre-fetched
  // it (one inArray select per list — the audit A4 fix); the per-commit
  // findUserRowByEmail pair remains the fallback for un-batched callers.
  // findUserRowByEmail answers null for the empty email without querying;
  // the batch never holds an "" key, so the map path degrades identically.
  const resolveUserRow = async (email: string): Promise<UserRow | null> => {
    if (opts.userRows !== undefined) return opts.userRows.get(email.toLowerCase()) ?? null;
    return findUserRowByEmail(d1, email);
  };
  const [authorRow, committerRow] = await Promise.all([
    resolveUserRow(commit.author.email),
    resolveUserRow(commit.committer.email),
  ]);

  return {
    sha: commit.oid,
    html_url: htmlUrl,
    url: `${apiUrl}/git/commits/${commit.oid}`,
    created: personDate(commit.author),
    commit: repoCommit,
    parents: commit.parents.map((oid) => toCommitMeta(pair, viewer.origin, oid)),
    author: authorRow === null ? null : apiUserFromRow(authorRow, viewer),
    committer: committerRow === null ? null : apiUserFromRow(committerRow, viewer),
    ...(stats === undefined ? {} : { stats }),
    ...(files === undefined ? {} : { files }),
  };
}

/** convert.ToBranch — protection model absent: flags default off. */
export function toBranch(
  name: string,
  commit: PayloadCommit,
  viewer: Viewer,
  pair: RepositoryWithOwner,
): Branch {
  const canWrite =
    viewer.requester !== null &&
    (viewer.requester.is_admin === true || viewer.requester.login?.toLowerCase() === pair.repo.ownerNamespace);
  return {
    name,
    commit,
    protected: false, // TODO(SPEC-0005): branch protection rules
    required_approvals: 0,
    enable_status_check: false,
    status_check_contexts: [],
    user_can_push: canWrite,
    user_can_merge: canWrite,
    effective_branch_protection_name: "",
  };
}

/**
 * The served message/tagger arms the tag converters render — structurally
 * services/tags.ts's readTagData answer (upstream's git.Tag surface: the
 * MessageUTF8 / Tagger fields ToTag and ToAnnotatedTag read in
 * services/convert/convert.go). Declared structurally here so the tags
 * service feeds its data with no import cycle.
 */
export interface TagRenderArms {
  /** The annotated tag object's payload (armor-stripped engine-side) or,
   *  for a commit-tipped lightweight tag, the commit's message; "" when the
   *  read degraded (readTagData's transport posture). */
  message: string;
  /** The annotated tagger; null for a lightweight tag or a dropped header
   *  (absent on the Tag shape — the arm is annotated-only upstream). */
  tagger?: Person | null;
}

/** True when the argument carries the arms rather than the repo pair. */
function isTagArms(value: TagRenderArms | RepositoryWithOwner): value is TagRenderArms {
  return "message" in value;
}

/**
 * convert.ToTag (convert.go:227) — archive URLs on the /archive path; `id`
 * is the ref target (the tag OBJECT oid for annotated tags, the commit oid
 * for lightweight ones). `message` renders the served arm (upstream's
 * t.MessageUTF8()): the annotated tag object's payload or, for a
 * commit-tipped lightweight tag, the commit's message — callers feed the
 * services/tags.ts readTagData answer. The arms-less call renders "" (the
 * readTagData degraded posture) and exists only as the landed renderTag
 * shim: that render spreads the same value over it, byte-identical wire,
 * until its owner folds the spread into bare delegation. (The pre-P3-11
 * SPEC-0004 deviation note — "message needs a read-tag RPC the boundary
 * does not carry" — is CLOSED: the readTag RPC landed, residuals-v1.3.2
 * P3-11.)
 */
export function toTag(name: string, tip: RefTip, commitSha: string, data: TagRenderArms, pair: RepositoryWithOwner, origin: string): Tag;
export function toTag(name: string, tip: RefTip, commitSha: string, pair: RepositoryWithOwner, origin: string): Tag;
export function toTag(
  name: string,
  tip: RefTip,
  commitSha: string,
  dataOrPair: TagRenderArms | RepositoryWithOwner,
  pairOrOrigin?: RepositoryWithOwner | string,
  origin?: string,
): Tag {
  const arms = isTagArms(dataOrPair) ? dataOrPair : null;
  const pair = (arms === null ? dataOrPair : pairOrOrigin) as RepositoryWithOwner;
  const base = (arms === null ? pairOrOrigin : origin) as string;
  const owner = encodeURIComponent(pair.repo.ownerNamespace);
  const slug = encodeURIComponent(pair.repo.slug);
  const htmlUrl = `${base}/${owner}/${slug}`;
  return {
    name,
    message: arms?.message ?? "",
    // upstream Tag.ID = the ref target: the tag OBJECT oid for annotated
    // tags, the commit oid for lightweight ones.
    id: tip.target,
    commit: {
      sha: commitSha,
      url: `${base}/api/v1/repos/${owner}/${slug}/git/commits/${commitSha}`,
    },
    zipball_url: `${htmlUrl}/archive/${encodeURIComponent(`${name}.zip`)}`,
    tarball_url: `${htmlUrl}/archive/${encodeURIComponent(`${name}.tar.gz`)}`,
  };
}

/**
 * convert.ToAnnotatedTag (convert.go:994) — the AnnotatedTag surface
 * (GET /git/tags/{sha}, annotated tag objects only): the same served
 * message arm as toTag plus the `tagger` identity rendered ToCommitUser-
 * shaped (UTC RFC3339 via personDate); null when the tag object omits the
 * header (the schema is nullable — upstream's parse defaults it to the
 * empty identity) or the read degraded. The arms-less call is the landed
 * renderAnnotatedTag shim (same note as toTag).
 */
export function toAnnotatedTag(name: string, tip: RefTip, commitSha: string, data: TagRenderArms, pair: RepositoryWithOwner, origin: string): AnnotatedTag;
export function toAnnotatedTag(name: string, tip: RefTip, commitSha: string, pair: RepositoryWithOwner, origin: string): AnnotatedTag;
export function toAnnotatedTag(
  name: string,
  tip: RefTip,
  commitSha: string,
  dataOrPair: TagRenderArms | RepositoryWithOwner,
  pairOrOrigin?: RepositoryWithOwner | string,
  origin?: string,
): AnnotatedTag {
  const arms = isTagArms(dataOrPair) ? dataOrPair : null;
  const pair = (arms === null ? dataOrPair : pairOrOrigin) as RepositoryWithOwner;
  const base = (arms === null ? pairOrOrigin : origin) as string;
  const owner = encodeURIComponent(pair.repo.ownerNamespace);
  const slug = encodeURIComponent(pair.repo.slug);
  const tagger = arms?.tagger ?? null;
  return {
    sha: tip.target,
    tag: name,
    message: arms?.message ?? "",
    object: {
      sha: commitSha,
      type: "commit",
      url: `${base}/api/v1/repos/${owner}/${slug}/git/commits/${commitSha}`,
    },
    tagger: tagger === null ? null : { name: tagger.name, email: tagger.email, date: personDate(tagger) },
    url: `${base}/api/v1/repos/${owner}/${slug}/git/tags/${tip.target}`,
    verification: null,
  };
}

/** Reference — the raw refs-table read. */
export function toReference(fullRef: string, tip: { target: string; peeled?: string }, pair: RepositoryWithOwner, origin: string): Reference {
  const owner = encodeURIComponent(pair.repo.ownerNamespace);
  const slug = encodeURIComponent(pair.repo.slug);
  const isTag = fullRef.startsWith("refs/tags/");
  // Annotated tags point at the tag OBJECT (type "tag"; the peel lives only
  // on the refs row); everything else resolves to its commit.
  const isAnnotated = isTag && tip.peeled !== undefined;
  return {
    ref: fullRef,
    url: `${origin}/api/v1/repos/${owner}/${slug}/git/${isTag ? "tags" : "refs"}/${fullRef}`,
    object: {
      sha: tip.target,
      type: isAnnotated ? "tag" : "commit",
      url: `${origin}/api/v1/repos/${owner}/${slug}/git/${isAnnotated ? "tags" : "commits"}/${tip.target}`,
    },
  };
}

/** GitTreeResponse entry (GitEntry: path/sha — not the engine's name/oid). */
function toGitEntry(entry: TreeEntryJson, path: string, pair: RepositoryWithOwner, origin: string): GitEntry {
  const owner = encodeURIComponent(pair.repo.ownerNamespace);
  const slug = encodeURIComponent(pair.repo.slug);
  const kind = entry.type === "tree" ? "tree" : entry.type === "commit" ? "commit" : "blob";
  return {
    path,
    mode: entry.mode,
    type: kind,
    sha: entry.oid,
    ...(entry.size === undefined ? { size: null } : { size: entry.size }),
    url: `${origin}/api/v1/repos/${owner}/${slug}/git/${kind === "blob" ? "blobs" : kind === "tree" ? "trees" : "tags"}/${entry.oid}`,
  };
}

/**
 * `GetTree` render — paginated with `page`/`per_page` (the contract's
 * exception; SPEC-0004 §2.5) and the `truncated` flag for recursive walks.
 * `entries` is the level (non-recursive) or the flattened recursive walk
 * (collectTreeRecursive below), already carrying full paths on `name`.
 */
export function toGitTree(
  sha: string,
  flattened: Array<TreeEntryJson & { name: string }>,
  truncated: boolean,
  page: number,
  perPage: number,
  pair: RepositoryWithOwner,
  origin: string,
): { tree: GitTreeResponse; total: number } {
  const owner = encodeURIComponent(pair.repo.ownerNamespace);
  const slug = encodeURIComponent(pair.repo.slug);
  const total = flattened.length;
  const start = (page - 1) * perPage;
  const paged = flattened.slice(start, start + perPage);
  return {
    tree: {
      sha,
      url: `${origin}/api/v1/repos/${owner}/${slug}/git/trees/${sha}`,
      tree: paged.map((entry) => toGitEntry(entry, entry.name, pair, origin)),
      page,
      total_count: total,
      truncated,
    },
    total,
  };
}

/**
 * Depth-first recursive flattening via per-level listTree RPCs (the public
 * surface has no walk RPC; the ui engine client documents the same interim
 * pattern). Bounded at MAX_RECURSIVE_TREE_ENTRIES — the flag the response's
 * `truncated` field reports.
 */
export async function collectTreeRecursive(
  reads: EngineReads,
  ref: string,
  entries: TreeEntryJson[],
  budget: { visited: number; dirs: number },
): Promise<{ flattened: Array<TreeEntryJson & { name: string }>; truncated: boolean }> {
  const out: Array<TreeEntryJson & { name: string }> = [];
  let truncated = false;
  const walk = async (level: TreeEntryJson[], prefix: string): Promise<void> => {
    for (const entry of level) {
      if (out.length >= MAX_RECURSIVE_TREE_ENTRIES) {
        truncated = true;
        return;
      }
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      out.push({ ...entry, name: path });
      if (entry.type === "tree") {
        budget.dirs += 1;
        if (budget.dirs > 200) {
          truncated = true;
          return;
        }
        const child = await reads.listTree(ref, path);
        if (child !== null) await walk(child.entries, path);
      }
    }
  };
  await walk(entries, "");
  return { flattened: out, truncated };
}

/**
 * `parsePossibleLfsPointerBuffer` (services/repository/files/content.go:254-260)
 * — the ContentsResponse/GitBlobResponse `lfs_oid`/`lfs_size` writer: the
 * POINTER-DECLARED oid/size when the content parses as a valid pointer, no
 * meta-row lookup (upstream reports the pointer's own fields —
 * content.go:249's GetBlobBySHA probes only while `0 < blobSize <
 * lfs.MetaFileMaxSize`, the 1024-byte window where content is read at all).
 * A malformed pointer (`IsValid() == false`, including InvalidPointerError)
 * reports nothing. Directory listings never inline content, so they never
 * carry the fields at this pin (upstream gates them on
 * `IncludeSingleFileContent`/`IncludeLfsMetadata`, content.go:170-184 — our
 * list payloads pass `content: null`).
 */
function lfsFieldsOf(content: Uint8Array | null): { lfs_oid?: string; lfs_size?: number } {
  if (content === null || content.byteLength === 0 || content.byteLength >= POINTER_MAX_BYTES) return {};
  try {
    const pointer = parsePointer(content, { strict: false });
    return pointer === null ? {} : { lfs_oid: pointer.oid, lfs_size: pointer.size };
  } catch {
    return {}; // InvalidPointerError — the malformed-pointer arm
  }
}

/** GitBlobResponse — base64 content; a pointer blob additionally reports its
 *  lfs_oid/lfs_size (GetBlobBySHA's parse, content.go:249). */
export function toGitBlob(oid: string, data: Uint8Array, pair: RepositoryWithOwner, origin: string): GitBlobResponse {
  const owner = encodeURIComponent(pair.repo.ownerNamespace);
  const slug = encodeURIComponent(pair.repo.slug);
  return {
    sha: oid,
    url: `${origin}/api/v1/repos/${owner}/${slug}/git/blobs/${oid}`,
    size: data.byteLength,
    content: base64Encode(data),
    encoding: "base64",
    ...lfsFieldsOf(data),
  };
}

/**
 * ContentsResponse for one entry. `last_commit_*` enrichment rides a
 * listLog(ref, {path}) RPC per entry (the documented interim fallback — the
 * batched enrichment RPC of SPEC-0008 §3.5 is not on the boundary yet).
 *
 * `mode` is ALWAYS emitted — upstream's field is a non-pointer, non-omitempty
 * string (modules/structs/repo_file.go:143, populated entry.Mode().String() at
 * content.go:136), so every entry type carries its raw git mode (review ㉑ W1:
 * it was dropped despite arriving on opts).
 */
export function toContentsEntry(
  opts: {
    path: string;
    name: string;
    mode: string;
    oid: string;
    type: "file" | "dir" | "symlink" | "submodule";
    size: number | null;
    content: Uint8Array | null;
    target?: string | null;
    lastCommit?: CommitJson | null;
  },
  pair: RepositoryWithOwner,
  origin: string,
): ContentsResponse {
  const owner = encodeURIComponent(pair.repo.ownerNamespace);
  const slug = encodeURIComponent(pair.repo.slug);
  const apiUrl = `${origin}/api/v1/repos/${owner}/${slug}`;
  const htmlUrl = `${origin}/${owner}/${slug}`;
  const isFile = opts.type === "file";
  const inline = isFile && opts.content !== null && opts.content.byteLength <= DEFAULT_MAX_BLOB_SIZE;
  return {
    name: opts.name,
    path: opts.path,
    sha: opts.oid,
    ...(opts.lastCommit === undefined || opts.lastCommit === null
      ? {}
      : {
          last_commit_sha: opts.lastCommit.oid,
          last_committer_date: personDate(opts.lastCommit.committer),
          last_author_date: personDate(opts.lastCommit.author),
          last_commit_message: opts.lastCommit.subject,
        }),
    type: opts.type,
    mode: opts.mode,
    size: opts.size ?? 0,
    encoding: inline ? "base64" : null,
    content: inline ? base64Encode(opts.content as Uint8Array) : null,
    // lfs_oid/lfs_size ride the regular-file arm only when the content was
    // read (upstream content.go:168-177: IsRegular/IsExecutable gates on
    // IncludeSingleFileContent; symlink/submodule/dir arms never set them).
    ...(isFile ? lfsFieldsOf(opts.content) : {}),
    ...(opts.target === undefined || opts.target === null ? {} : { target: opts.target }),
    ...(opts.type === "submodule" ? { submodule_git_url: "" } : {}), // TODO(SPEC-0005): submodule URL resolution
    url: `${apiUrl}/contents/${opts.path}?ref=${pair.repo.defaultBranch}`,
    html_url: `${htmlUrl}/src/branch/${pair.repo.defaultBranch}/${opts.path}`,
    git_url: `${apiUrl}/git/blobs/${opts.oid}`,
    download_url: isFile || opts.type === "symlink" ? `${htmlUrl}/raw/branch/${pair.repo.defaultBranch}/${opts.path}` : null,
    _links: {
      self: `${apiUrl}/contents/${opts.path}?ref=${pair.repo.defaultBranch}`,
      git: `${apiUrl}/git/blobs/${opts.oid}`,
      html: `${htmlUrl}/src/branch/${pair.repo.defaultBranch}/${opts.path}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Unified diff / patch rendering from the engine's structured DiffResult
// (the engine renders text only on its private UI paths; the structured hunks
// are the public surface — the renderer below reproduces git's unified format
// from them). The contract is VERBATIM git bytes — upstream GetPatch is
// documented "able to be used with `git apply`" (modules/git/repo_compare.go:
// 73-77) and the diff/patch downloads round-trip through it — so the byte
// shapes are pinned against real-git output (git 2.43, reproduced in a scratch
// repo at authoring time; the tests carry the recorded literals):
//
//   - a mode-only change (same blob oid, mode moved) prints `old mode` /
//     `new mode` and NOTHING else — no index line (the blob pair is equal),
//     no ---/+++, no hunks; `git apply --check --index` accepts exactly this
//     shape and honors the mode move;
//   - the index line's mode column prints only when both sides exist with the
//     SAME mode — new/deleted files carry it on the new/deleted-file-mode line
//     (`index 0000000..422c2b7`, no column), mode changes under old/new mode;
//   - a created/deleted EMPTY blob prints the header + index and STOPS (no
//     ---/+++ with zero hunks to follow);
//   - hunk headers omit a `,1` single-line count (`@@ -1 +1,2 @@`);
//   - "\ No newline at end of file" follows the emitted line that is the
//     file's last line when that side's blob lacks the trailing newline;
//   - a submodule (gitlink, mode 160000) section is git's virtual one-line
//     file `Subproject commit <full sha>`: the engine's diff carries the
//     del/add hunk for it (the NOTICE-recorded engine adaptation), so the
//     ordinary headers+hunks below emit git's exact shape with no special
//     case here — add `@@ -0,0 +1 @@`/`+Subproject commit …`, change
//     `index abc..def 160000` + `@@ -1 +1 @@`, delete `@@ -1 +0,0 @@`
//     (git 2.43.0 scratch-repo record; upstream parses these very lines
//     into SubmoduleDiffInfo, gitdiff.go:813-858).
//
// The last two facts live in the blobs, not in the structured hunks (the
// engine's line diff is terminator-blind), so they need blob access:
// `renderUnifiedDiffAsync` takes a DiffBlobSource and emits the markers and
// synthesizes the del/add hunk a trailing-newline-only change requires (real
// git prints a full hunk there; a headers-only section is REFUSED by
// `git apply` — exit 128). The sync `renderUnifiedDiff` covers everything
// content-free; a trailing-newline-only section falls through to the
// ---/+++-without-hunks shape git apply rejects — LOUD (the apply refuses the
// whole patch) rather than silently dropping the change — and byte-correct
// callers use the async arm.
// ---------------------------------------------------------------------------

function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

/**
 * git's index-line mode column: ` <mode>` only when BOTH tree sides exist and
 * carry the SAME mode — new/deleted files carry the mode on the
 * new/deleted-file-mode line (`index 0000000..422c2b7`, no column) and mode
 * changes under old/new mode (`index d95f3ad..637f034`, bare).
 */
function indexModeSuffix(file: DiffFileJson): string {
  if (file.old === null || file.new === null || file.old.mode !== file.new.mode) return "";
  return ` ${file.new.mode}`;
}

/** git omits a `,1` single-line hunk-header count (`@@ -1 +1,2 @@`). */
function hunkCount(count: number): string {
  return count === 1 ? "" : `,${count}`;
}

/** The no-newline marker git appends after an unterminated final line. */
export const NO_NEWLINE_MARKER = "\\ No newline at end of file";

export function renderUnifiedDiff(files: DiffFileJson[]): string {
  const out: string[] = [];
  for (const file of files) {
    if (pushFileHeaders(out, file)) continue;
    out.push(`--- ${file.old === null ? "/dev/null" : `a/${file.path}`}`);
    out.push(`+++ ${file.new === null ? "/dev/null" : `b/${file.path}`}`);
    for (const hunk of file.hunks) {
      out.push(`@@ -${hunk.aStart}${hunkCount(hunk.aLen)} +${hunk.bStart}${hunkCount(hunk.bLen)} @@`);
      for (const op of hunk.ops) {
        out.push(`${op.tag === "eq" ? " " : op.tag === "del" ? "-" : "+"}${op.line}`);
      }
    }
  }
  return out.join("\n");
}

/**
 * The header part of one file's section (diff --git through index/binary).
 * Returns TRUE when the section is COMPLETE at the headers — a mode-only
 * change (the mode lines are the whole section), a binary/toolarge file
 * (the differ line), or a created/deleted EMPTY blob (header + index, no
 * ---/+++ with zero hunks behind them — git-apply garbage).
 */
function pushFileHeaders(out: string[], file: DiffFileJson): boolean {
  // git always names both sides after the (new) path here — /dev/null only
  // appears on the ---/+++ lines
  out.push(`diff --git a/${file.path} b/${file.path}`);
  if (file.old === null && file.new !== null) out.push(`new file mode ${file.new.mode}`);
  if (file.new === null && file.old !== null) out.push(`deleted file mode ${file.old.mode}`);
  if (file.old !== null && file.new !== null && file.old.mode !== file.new.mode) {
    out.push(`old mode ${file.old.mode}`);
    out.push(`new mode ${file.new.mode}`);
  }
  // the index line rides a blob-level content change (differing blob oids); a
  // pure mode change keeps the same blob pair and prints NO index line
  if (file.old === null || file.new === null || file.old.oid !== file.new.oid) {
    out.push(`index ${shortOid(file.old?.oid ?? "0000000")}..${shortOid(file.new?.oid ?? "0000000")}${indexModeSuffix(file)}`);
  }
  if (file.kind !== "text") {
    out.push(`Binary files ${file.old === null ? "/dev/null" : `a/${file.path}`} and ${file.new === null ? "/dev/null" : `b/${file.path}`} differ`);
    return true;
  }
  if (file.hunks.length === 0) {
    if (file.old !== null && file.new !== null && file.old.oid === file.new.oid) {
      // mode-only section: the old/new mode lines above are the whole section
      // (git prints no ---/+++/hunks; `git apply --check --index` passes)
      return true;
    }
    if (file.old === null || file.new === null) {
      // a created/deleted EMPTY blob: header + index and stop
      return true;
    }
  }
  return false;
}

/**
 * Blob access for the async renderer: the diff envelope's two tips plus a
 * text reader over the tree blobs. `blobText(null, …)` answers null (a root
 * diff has no old side); a missing/unreadable blob also answers null and the
 * renderer degrades per-file (no markers — the engine hunks still render).
 */
export interface DiffBlobSource {
  oldTip: string | null;
  newTip: string;
  blobText(tip: string | null, path: string): Promise<string | null>;
}

/** The DiffBlobSource over an EngineReads client (readBlob decodes to text). */
export function diffBlobSource(
  reads: Pick<EngineReads, "readBlob">,
  oldTip: string | null,
  newTip: string,
): DiffBlobSource {
  return {
    oldTip,
    newTip,
    blobText: async (tip, path) => {
      if (tip === null) return null;
      const blob = await reads.readBlob(tip, path);
      return blob === null ? null : new TextDecoder().decode(blob.data);
    },
  };
}

/**
 * A caller-supplied blob source for the series walker: per-commit factories
 * need the walker's own read client plus that commit's diff envelope (the
 * old side is the commit's first parent, the new side the commit itself).
 * The default is the plain `diffBlobSource`; the wiki sibling passes the
 * `enginePath`-encoded source (services/wiki.ts — the wiki cell's STORED
 * flat entry names, so the renderer's context-blob fetches must re-encode
 * the diff envelope's paths).
 */
export type DiffBlobSourceFactory = (
  reads: Pick<EngineReads, "readBlob">,
  oldTip: string | null,
  newTip: string,
) => DiffBlobSource;

/** Trailing-newline facts of one blob text ("" = zero lines, never a marker). */
function textFacts(text: string): { lines: string[]; count: number; hasNL: boolean } {
  if (text === "") return { lines: [], count: 0, hasNL: false };
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = body.split("\n");
  return { lines, count: lines.length, hasNL: text.endsWith("\n") };
}

/**
 * The byte-exact arm: everything `renderUnifiedDiff` pins, plus the two
 * blob-derived facts git's output carries and the structured hunks do not —
 *
 *   - the "\ No newline at end of file" marker after the emitted line that is
 *     the file's last line when that side's blob lacks the trailing newline;
 *   - the synthesized hunk a trailing-newline-only change requires (the engine
 *     sees zero line changes there; git prints a full `@@` hunk with the last
 *     line as del/add and the marker on the side lacking the newline — without
 *     it the section is headers-only and `git apply` refuses the whole patch).
 *
 * When the last hunk ENDS on the old file's final line as an eq op (the
 * engine, comparing lines terminator-blind, kept a newline-state move of the
 * final line as one eq), that op is rewritten to git's del/add pair with the
 * marker — the line counts are identical under the rewrite, so the hunk header
 * stays. The documented residual: git re-trims context around that terminal
 * change, so when the eq sits in trailing context AFTER an earlier change in
 * the same hunk, git's `@@` positions differ from ours (apply semantics are
 * still exact — the pre-image matches and the post-image is the new bytes).
 * A failed blob read degrades that file to the sync shape (no markers).
 */
export async function renderUnifiedDiffAsync(files: DiffFileJson[], src: DiffBlobSource): Promise<string> {
  const out: string[] = [];
  for (const file of files) {
    if (file.kind !== "text" || pushFileHeaders(out, file)) {
      continue;
    }
    // Blob reads are only paid where a marker or a synthesis can exist: the
    // new side whenever the section has hunks (or must synthesize one), the
    // old side only when the last hunk's old range reaches the old file's
    // final line (derived from the new count via the add/del ledger — the
    // hunks cover every non-eq op and context outside them counts equally).
    const needsNew = file.new !== null && (file.hunks.length > 0 || file.old !== null);
    const newFacts = needsNew ? textFacts((await src.blobText(src.newTip, file.path)) ?? "") : null;
    const validNew = newFacts !== null && newFacts.count > 0;
    if (file.hunks.length === 0 && file.old !== null && file.new !== null && file.old.oid !== file.new.oid) {
      pushNewlineOnlyTrailer(out, file, validNew ? newFacts : null);
      continue;
    }
    if (file.hunks.length === 0 || !validNew || newFacts === null) {
      // degrade: the sync shape — for a hunk-less both-sides section that is
      // the LOUD posture (---/+++ with no hunks; git apply refuses the whole
      // patch rather than mis-applying); a hunked section renders plainly
      // (no markers) on a failed read.
      out.push(`--- ${file.old === null ? "/dev/null" : `a/${file.path}`}`);
      out.push(`+++ ${file.new === null ? "/dev/null" : `b/${file.path}`}`);
      for (const hunk of file.hunks) {
        out.push(`@@ -${hunk.aStart}${hunkCount(hunk.aLen)} +${hunk.bStart}${hunkCount(hunk.bLen)} @@`);
        for (const op of hunk.ops) {
          out.push(`${op.tag === "eq" ? " " : op.tag === "del" ? "-" : "+"}${op.line}`);
        }
      }
      continue;
    }
    out.push(`--- ${file.old === null ? "/dev/null" : `a/${file.path}`}`);
    out.push(`+++ ${file.new === null ? "/dev/null" : `b/${file.path}`}`);

    const hunks = file.hunks;
    const lastHunk = hunks[hunks.length - 1] as (typeof hunks)[number];
    const totalNew = newFacts.count;
    const totalOld = totalNew - file.add + file.del;
    const oldFacts =
      file.old !== null && src.oldTip !== null && totalOld > 0 && lastHunk.aStart + lastHunk.aLen - 1 === totalOld
        ? textFacts((await src.blobText(src.oldTip, file.path)) ?? "")
        : null;
    const validOld = oldFacts !== null && oldFacts.count === totalOld;

    // the terminal-eq rewrite (see doc): the op at the OLD file's final line
    // (a-position totalOld) in the last hunk is an eq and the old side lacks
    // the newline — the engine, comparing lines terminator-blind, kept a
    // newline-state move of that final line as one eq. Git's shape is the
    // del/add pair; the counts are identical under the rewrite, so the hunk
    // header stays. The generic walk below then places the markers.
    let lastOps = lastHunk.ops;
    if (validOld && oldFacts !== null && !oldFacts.hasNL) {
      let aPos = lastHunk.aStart;
      for (let i = 0; i < lastOps.length; i++) {
        const op = lastOps[i] as (typeof lastOps)[number];
        if (aPos === totalOld) {
          if (op.tag === "eq") {
            lastOps = [...lastOps.slice(0, i), { tag: "del" as const, line: op.line }, { tag: "add" as const, line: op.line }, ...lastOps.slice(i + 1)];
          }
          break;
        }
        if (op.tag !== "add") aPos += 1;
      }
    }

    for (let h = 0; h < hunks.length; h++) {
      const hunk = hunks[h] as (typeof hunks)[number];
      // The walk positions reset PER HUNK from that hunk's own start: the
      // marker fires only at the file's final line (aIdx === totalOld /
      // bIdx === totalNew), and hunks with a gap between clusters would
      // otherwise drag the running counters behind — the final hunk's ops
      // would sit at wrong positions and the old-side marker would be
      // silently dropped (an inapplicable pre-image for git apply).
      let aIdx = hunk.aStart;
      let bIdx = hunk.bStart;
      out.push(`@@ -${hunk.aStart}${hunkCount(hunk.aLen)} +${hunk.bStart}${hunkCount(hunk.bLen)} @@`);
      const hunkOps = h === hunks.length - 1 ? lastOps : hunk.ops;
      for (const op of hunkOps) {
        out.push(`${op.tag === "eq" ? " " : op.tag === "del" ? "-" : "+"}${op.line}`);
        if (op.tag !== "add") {
          if (aIdx === totalOld && validOld && oldFacts !== null && !oldFacts.hasNL) out.push(NO_NEWLINE_MARKER);
          aIdx += 1;
        }
        if (op.tag !== "del") {
          if (bIdx === totalNew && !newFacts.hasNL) out.push(NO_NEWLINE_MARKER);
          bIdx += 1;
        }
      }
    }
  }
  return out.join("\n");
}

/**
 * The trailing-newline-only section's trailer (both sides exist, same lines,
 * differing final-newline state — the engine's zero-hunk shape; the headers
 * are already pushed). Git prints a full hunk: up to three context lines,
 * then the last line as del/add with the marker on the side lacking the
 * newline (both shapes verified against the binary). A null/empty blob read
 * degrades to the sync shape (---/+++ with no hunks — the loud,
 * git-apply-rejected posture).
 */
function pushNewlineOnlyTrailer(
  out: string[],
  file: DiffFileJson,
  newFacts: { lines: string[]; count: number; hasNL: boolean } | null,
): void {
  out.push(`--- a/${file.path}`);
  out.push(`+++ b/${file.path}`);
  if (newFacts === null || newFacts.count === 0) return;
  const { lines, count, hasNL } = newFacts;
  const last = lines[count - 1] as string;
  const context = Math.min(3, count - 1);
  const start = count - context;
  const len = context + 1;
  out.push(`@@ -${start}${hunkCount(len)} +${start}${hunkCount(len)} @@`);
  for (let i = start - 1; i < count - 1; i++) out.push(` ${lines[i] as string}`);
  out.push(`-${last}`);
  // exactly one side lacks the trailing newline (both lacking = equal bytes =
  // no diff): the new text having it means the OLD side lacks it — git puts
  // the marker on the newline-lacking side's emitted line
  if (hasNL) out.push(NO_NEWLINE_MARKER);
  out.push(`+${last}`);
  if (!hasNL) out.push(NO_NEWLINE_MARKER);
}

/** RFC2822 date line for patch headers (format-patch shape). */
function rfc2822(person: Person): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const date = new Date(person.time * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

/** renderPatch options: the signature tail plus the series numbering. */
export interface RenderPatchOptions {
  /** `-- \n{version}` tail; null = `--no-signature` (the commit download). */
  signature?: string | null;
  /**
   * The mail's place in a format-patch SERIES — `Subject: [PATCH i/N]` (git
   * numbers only when the series has more than one mail; a single mail stays
   * bare `[PATCH]`, verified against the binary).
   */
  patchNumber?: { index: number; count: number };
}

/**
 * `git format-patch`-style rendering for the `.{diffType}` download family.
 * The trailing `-- \n{version}` signature is git's format-patch default (what
 * the PR download serves — services/pull/patch.go GetPatch); the commit
 * download passes `signature: null` for GetRawDiff's `--no-signature` flag
 * (modules/git/diff.go:73, the web.go:1760 arm).
 *
 * The mail ends with git's exact stream tail (git 2.43.0 `--stdout` record):
 * exactly one newline past the last content line — after the version line
 * when signed (`…\n-- \n2.43.0\n\n`), after the diff's final line when
 * unsigned (`…\n+line\n`). The series seam (renderPatchSeries) relies on
 * this tail: mails joined by one "\n" reproduce git's recorded inter-mail
 * blank line for BOTH signature states.
 */
export function renderPatch(commit: CommitJson, files: DiffFileJson[], options?: RenderPatchOptions): string {
  const signature = options?.signature === undefined ? "2.47.0" : options.signature;
  const body = commit.message.split("\n");
  const subject = body[0] ?? "";
  const rest = body.slice(1).join("\n").replace(/^\n+/, "");
  const number = options?.patchNumber;
  const subjectTag = number === undefined ? "[PATCH]" : `[PATCH ${number.index}/${number.count}]`;
  const out = [
    `From ${commit.oid} Mon Sep 17 00:00:00 2001`,
    `From: ${commit.author.name} <${commit.author.email}>`,
    `Date: ${rfc2822(commit.author)}`,
    `Subject: ${subjectTag} ${subject}`,
    "",
  ];
  if (rest !== "") out.push(rest, "");
  out.push("---", renderUnifiedDiff(files));
  if (signature !== null) out.push("-- ", signature, "", "");
  else out.push("");
  return out.join("\n");
}

/**
 * The byte-exact twin: renderPatch over `renderUnifiedDiffAsync` (see that
 * function's doc for the blob-derived facts — the no-newline markers and the
 * synthesized trailing-newline-only hunk).
 */
export async function renderPatchAsync(
  commit: CommitJson,
  files: DiffFileJson[],
  src: DiffBlobSource,
  options?: RenderPatchOptions,
): Promise<string> {
  const signature = options?.signature === undefined ? "2.47.0" : options.signature;
  const body = commit.message.split("\n");
  const subject = body[0] ?? "";
  const rest = body.slice(1).join("\n").replace(/^\n+/, "");
  const number = options?.patchNumber;
  const subjectTag = number === undefined ? "[PATCH]" : `[PATCH ${number.index}/${number.count}]`;
  const out = [
    `From ${commit.oid} Mon Sep 17 00:00:00 2001`,
    `From: ${commit.author.name} <${commit.author.email}>`,
    `Date: ${rfc2822(commit.author)}`,
    `Subject: ${subjectTag} ${subject}`,
    "",
  ];
  if (rest !== "") out.push(rest, "");
  out.push("---", await renderUnifiedDiffAsync(files, src));
  if (signature !== null) out.push("-- ", signature, "", "");
  else out.push("");
  return out.join("\n");
}

/**
 * The format-patch SERIES over a commit range — the compare `?output=patch`
 * arm (upstream GetPatch, repo_compare.go:74-78, runs `format-patch --binary
 * --stdout <base><sep><head>` over the head repo; compare.go:131): the
 * NON-MERGE commits of `base..head`, oldest-first, one mail per commit
 * diffed against its own first parent. format-patch NEVER renders a merge as
 * a mail — a merge-only range prints ZERO bytes (git 2.43.0 record) — and
 * mail subjects number only when the series has more than one mail
 * (`[PATCH]` vs `[PATCH i/N]`). The join is git's recorded seam for both
 * signature states: each mail ends with its own trailing newline
 * (renderPatch's tail), the `join("\n")` adds the inter-mail blank line —
 * a signed seam reads `2.43.0\n\n\nFrom`, an unsigned one `+line\n\nFrom` —
 * and the last mail's tail is the stream's tail. The walk pages at
 * PATCH_SERIES_PAGE up to PATCH_SERIES_COMMIT_CAP (a series past the cap
 * truncates, flagged nowhere in git's output either).
 *
 * The blob source is caller-suppliable (`buildDiffBlobSource`, default the
 * plain `diffBlobSource`): a repository family whose STORED entry names need
 * a read-back encode passes its own factory (the wiki sibling's
 * `enginePath`-encoded source — wiki-commit-diff.tsx; the former wiki mirror
 * of this walker collapsed onto it once the hook landed, the D-1 seam).
 */
export const PATCH_SERIES_COMMIT_CAP = 2000;
const PATCH_SERIES_PAGE = 500;

export async function renderPatchSeries(
  reads: Pick<EngineReads, "listCommitsRange" | "readDiff" | "readBlob">,
  base: string,
  head: string,
  options?: RenderPatchOptions,
  buildDiffBlobSource: DiffBlobSourceFactory = diffBlobSource,
): Promise<string> {
  const commits: CommitJson[] = [];
  for (let page = 0; commits.length < PATCH_SERIES_COMMIT_CAP; page++) {
    const walked = (await reads.listCommitsRange(base, head, PATCH_SERIES_PAGE, page)) ?? { commits: [], more: false };
    for (const commit of walked.commits) {
      if (commit.parents.length <= 1) commits.push(commit);
    }
    if (!walked.more) break;
  }
  const numbered = commits.length > 1;
  const mails: string[] = [];
  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i] as CommitJson;
    const parent = commit.parents.length === 1 ? commit.parents[0] : undefined;
    const diff = await reads.readDiff(commit.oid, parent);
    const files = diff?.files ?? [];
    const src = buildDiffBlobSource(reads, diff?.old ?? null, diff?.new ?? commit.oid);
    mails.push(
      await renderPatchAsync(commit, files, src, {
        ...options,
        ...(numbered ? { patchNumber: { index: i + 1, count: commits.length } } : {}),
      }),
    );
  }
  return mails.join("\n");
}

/**
 * pulls/{index}/files entries from the PR range diff (ChangedFileList) —
 * convert.ToChangedFile (services/convert/convert.go:1083-1104). The status
 * vocabulary is upstream's RUNTIME set — "added|deleted|changed|copied|
 * renamed|unchanged" (the swagger doc text says "modified", the code never
 * emits it): deletion is "deleted" (never "removed" — that word belongs to
 * the Commit.files arm, git_commit.go:198-205), an edited file is the
 * default "changed" (never "modified"), and a 0-add/0-del entry (mode-only
 * change) is "unchanged". "copied"/"renamed" are UNREACHABLE here: our
 * engine diff seam carries no rename detection (DiffFileJson is one path per
 * entry — the packages/git-engine NOTICE-recorded adaptation), so a rename
 * surfaces as a delete+add pair; the arms stay documented, not emitted.
 * previous_filename stays ABSENT (upstream's `omitempty` string — only the
 * renamed arm would ever set it), unlike the old explicit null.
 * URLs are upstream's shapes (convert.go:1105-1108): html_url
 * /src/commit/{sha}/{path} (no #fragment), raw_url /raw/commit/{sha}/{path}
 * — the path escaped per segment (PathEscapeSegments,
 * modules/util/url.go:12-19; encodeURIComponent per segment is the repo's
 * documented PathEscape stand-in, labels-t2.ts:47).
 */
export function toChangedFiles(files: DiffFileJson[], pair: RepositoryWithOwner, origin: string, ref: string): ChangedFile[] {
  const owner = encodeURIComponent(pair.repo.ownerNamespace);
  const slug = encodeURIComponent(pair.repo.slug);
  return files.map((f) => {
    const escaped = f.path
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    return {
      filename: f.path,
      status: f.old === null ? "added" : f.new === null ? "deleted" : f.add === 0 && f.del === 0 ? "unchanged" : "changed",
      additions: f.add,
      deletions: f.del,
      changes: f.add + f.del,
      html_url: `${origin}/${owner}/${slug}/src/commit/${ref}/${escaped}`,
      raw_url: `${origin}/${owner}/${slug}/raw/commit/${ref}/${escaped}`,
      contents_url: `${origin}/api/v1/repos/${owner}/${slug}/contents/${escaped}?ref=${ref}`,
    };
  });
}

// ---------------------------------------------------------------------------
// The Worker-side commit builder (contents create/update/delete/batch).
// Objects come back UNSTORED; the caller lands them via putApiObjects and
// CASes the ref via commitApiChange (SPEC-0004 §3.4 mapping).
// ---------------------------------------------------------------------------

export interface FileChange {
  operation: "create" | "update" | "delete";
  path: string;
  /** raw bytes (decoded from the body's base64 by the route) */
  content?: Uint8Array;
  /** the CAS sha (update/delete) */
  sha?: string;
  /** rename source (update with from_path) */
  fromPath?: string;
  /**
   * The target tree mode for create/update (git's file modes: 100644,
   * 100755, 120000). Absent = the contents-family defaults (create 100644,
   * update preserves the entry's current mode). The diffpatch apply sets it
   * from the patch's mode lines — upstream `git apply --index` honors mode
   * changes (verified: a mode-only patch moves the staged entry's mode).
   */
  mode?: string;
}

export interface BuiltChange {
  /** objects to store BEFORE the ref CAS (tree deltas + blobs + commit) */
  objects: ApiObject[];
  commitOid: string;
  baseTip: string;
  /** per-change outcomes the route maps to upstream errors (ordered) */
  outcomes: Array<{ ok: boolean; error?: string }>;
  /** whether the leaf file already existed per change (PUT 200 vs 201) */
  existing: boolean[];
}

const ENCODER = new TextEncoder();

/** Worker-side blob object: `blob <size>\0` + bytes, SHA-1 via WebCrypto. */
export async function buildBlobObject(content: Uint8Array): Promise<ApiObject> {
  const header = ENCODER.encode(`blob ${content.byteLength}\0`);
  const raw = new Uint8Array(header.length + content.byteLength);
  raw.set(header, 0);
  raw.set(content, header.length);
  const digest = await crypto.subtle.digest("SHA-1", raw);
  const oid = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { oid, type: "blob", data: content };
}

interface DirState {
  entries: Map<string, { mode: string; oid: string }>;
}

/**
 * Build one commit applying the ordered file changes on top of `baseTip`'s
 * tree. Reads existing tree levels through `listTree(baseTip, dir)` (the only
 * tree-read the public RPC surface carries), rebuilds affected levels
 * bottom-up (a level emptied by a delete is dropped from its parent, like
 * git), and serializes the commit with the engine's canonical serializer.
 * Any failed change aborts the whole build (upstream ChangeRepoFiles is all-
 * or-nothing per change set).
 */
export async function buildFileChangeCommit(
  reads: EngineReads,
  baseTip: string,
  changes: FileChange[],
  spec: { message: string; author: Person; committer: Person },
): Promise<BuiltChange | null> {
  const head = await reads.readCommit(baseTip);
  if (head === null) return null;

  const levels = new Map<string, DirState>();
  const loadDir = async (dir: string): Promise<DirState> => {
    const hit = levels.get(dir);
    if (hit !== undefined) return hit;
    const found: DirState = { entries: new Map() };
    const tree = await reads.listTree(baseTip, dir);
    if (tree !== null) {
      for (const entry of tree.entries) found.entries.set(entry.name, { mode: entry.mode, oid: entry.oid });
    }
    levels.set(dir, found);
    return found;
  };
  await loadDir("");

  const objects: ApiObject[] = [];
  const dirty = new Set<string>([""]);
  const outcomes: Array<{ ok: boolean; error?: string }> = [];
  const existing: boolean[] = [];

  const removeFromDir = async (path: string): Promise<"ok" | "missing"> => {
    const segments = path.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0) return "missing";
    const name = segments[segments.length - 1] as string;
    const dir = segments.slice(0, -1).join("/");
    const state = await loadDir(dir);
    if (!state.entries.delete(name)) return "missing";
    dirty.add(dir);
    return "ok";
  };

  for (const change of changes) {
    const segments = change.path.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0) {
      outcomes.push({ ok: false, error: "invalid file path" });
      existing.push(false);
      continue;
    }
    const name = segments[segments.length - 1] as string;
    const dir = segments.slice(0, -1).join("/");

    if (change.fromPath !== undefined) {
      if ((await removeFromDir(change.fromPath)) === "missing") {
        outcomes.push({ ok: false, error: `file does not exist [path: ${change.fromPath}]` });
        existing.push(false);
        continue;
      }
    }

    const state = await loadDir(dir);
    const current = state.entries.get(name);
    if (change.operation === "create") {
      if (current !== undefined) {
        outcomes.push({ ok: false, error: `content at path already exists [path: ${change.path}]` });
        existing.push(true);
        continue;
      }
      const blob = await buildBlobObject(change.content ?? new Uint8Array());
      objects.push(blob);
      state.entries.set(name, { mode: change.mode ?? "100644", oid: blob.oid });
      dirty.add(dir);
      outcomes.push({ ok: true });
      existing.push(false);
    } else if (change.operation === "update") {
      if (current === undefined) {
        // PUT without sha = create (upstream UpdateFile willCreate branch)
        const blob = await buildBlobObject(change.content ?? new Uint8Array());
        objects.push(blob);
        state.entries.set(name, { mode: change.mode ?? "100644", oid: blob.oid });
        dirty.add(dir);
        outcomes.push({ ok: true });
        existing.push(false);
        continue;
      }
      if (change.sha !== undefined && change.sha !== "" && change.sha !== current.oid) {
        outcomes.push({ ok: false, error: `sha does not match [given: ${change.sha}, expected: ${current.oid}]` });
        existing.push(true);
        continue;
      }
      const blob = await buildBlobObject(change.content ?? new Uint8Array());
      objects.push(blob);
      state.entries.set(name, { mode: change.mode ?? current.mode, oid: blob.oid });
      dirty.add(dir);
      outcomes.push({ ok: true });
      existing.push(true);
    } else {
      if (current === undefined) {
        outcomes.push({ ok: false, error: `file does not exist [path: ${change.path}]` });
        existing.push(false);
        continue;
      }
      if (change.sha !== undefined && change.sha !== "" && change.sha !== current.oid) {
        outcomes.push({ ok: false, error: `sha does not match [given: ${change.sha}, expected: ${current.oid}]` });
        existing.push(true);
        continue;
      }
      state.entries.delete(name);
      dirty.add(dir);
      outcomes.push({ ok: true });
      existing.push(true);
    }
  }

  if (outcomes.some((outcome) => !outcome.ok)) {
    return { objects: [], commitOid: "", baseTip, outcomes, existing };
  }

  // Bottom-up rebuild of the dirty levels (deepest first); a level emptied by
  // a delete is dropped from its parent (git has no empty trees).
  const ordered = [...dirty].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const dir of ordered) {
    if (dir === "") continue;
    const state = levels.get(dir);
    if (state === undefined) continue;
    if (state.entries.size === 0) {
      const parentDir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
      const parent = parentDir === "" ? levels.get("") : levels.get(parentDir);
      if (parent !== undefined) {
        parent.entries.delete(dir.slice(dir.lastIndexOf("/") + 1));
        dirty.add(parentDir);
      }
      continue;
    }
    const tree = serializeTree([...state.entries.entries()].map(([name, entry]) => ({ name, mode: entry.mode, oid: entry.oid })));
    objects.push({ oid: tree.oid, type: tree.type, data: tree.data });
    const parentDir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    const parent = parentDir === "" ? levels.get("") : levels.get(parentDir);
    if (parent !== undefined) {
      parent.entries.set(dir.slice(dir.lastIndexOf("/") + 1), { mode: "40000", oid: tree.oid });
    }
  }

  const root = levels.get("");
  if (root === undefined) return null;
  const rootTree = serializeTree([...root.entries.entries()].map(([name, entry]) => ({ name, mode: entry.mode, oid: entry.oid })));
  objects.push({ oid: rootTree.oid, type: rootTree.type, data: rootTree.data });

  const commit = serializeCommit({
    tree: rootTree.oid,
    parents: [head.oid],
    author: spec.author,
    committer: spec.committer,
    message: spec.message,
  });
  objects.push({ oid: commit.oid, type: commit.type, data: commit.data });

  return { objects, commitOid: commit.oid, baseTip, outcomes, existing };
}

/**
 * The git `Identity` → engine Person conversion for the write families
 * (author/committer bodies; dates via `dates.author`/`dates.committer`).
 */
export function toPerson(
  identity: { name?: string; email?: string } | null | undefined,
  fallbackName: string,
  fallbackEmail: string,
  date?: string,
): Person {
  const parsed = date === undefined ? Number.NaN : Math.floor(new Date(date).getTime() / 1000);
  const time = Number.isFinite(parsed) ? parsed : Math.floor(Date.now() / 1000);
  const name = identity?.name ?? "";
  const email = identity?.email ?? "";
  return {
    name: name.trim() === "" ? fallbackName : name,
    email: email.trim() === "" ? fallbackEmail : email,
    time,
    tz: "+0000",
  };
}

export { ENCODER };
