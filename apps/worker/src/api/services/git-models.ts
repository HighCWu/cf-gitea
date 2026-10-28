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
import type { EngineReads } from "./engine";
import { apiUserFromRow, type RepositoryWithOwner, type UserRow, type Viewer } from "./repository";

/** Files at or under this many bytes carry base64 `content` on GET contents. */
export const MAX_CONTENTS_RENDER_BYTES = 1024 * 1024;

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

/** convert.ToPayloadCommit. */
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
 * Tag rendering from the refs list — the tag OBJECT bytes are engine-resident
 * and the landed public RPC surface exposes only ref targets + the peel cache,
 * so `message` renders "" and annotated vs lightweight is answered by `peeled`
 * (present = annotated). Documented SPEC-0004 deviation (message text needs a
 * read-tag RPC the boundary does not carry yet).
 */
export function toTag(name: string, tip: { target: string; peeled?: string }, commitSha: string, pair: RepositoryWithOwner, origin: string): Tag {
  const owner = encodeURIComponent(pair.repo.ownerNamespace);
  const slug = encodeURIComponent(pair.repo.slug);
  const htmlUrl = `${origin}/${owner}/${slug}`;
  return {
    name,
    message: "",
    // upstream Tag.ID = the ref target: the tag OBJECT oid for annotated
    // tags, the commit oid for lightweight ones.
    id: tip.target,
    commit: {
      sha: commitSha,
      url: `${origin}/api/v1/repos/${owner}/${slug}/git/commits/${commitSha}`,
    },
    zipball_url: `${htmlUrl}/archive/${encodeURIComponent(`${name}.zip`)}`,
    tarball_url: `${htmlUrl}/archive/${encodeURIComponent(`${name}.tar.gz`)}`,
  };
}

/** AnnotatedTag from refs data (same boundary note as toTag). */
export function toAnnotatedTag(
  name: string,
  tip: { target: string; peeled?: string },
  commitSha: string,
  pair: RepositoryWithOwner,
  origin: string,
): AnnotatedTag {
  const owner = encodeURIComponent(pair.repo.ownerNamespace);
  const slug = encodeURIComponent(pair.repo.slug);
  return {
    sha: tip.target,
    tag: name,
    message: "",
    object: {
      sha: commitSha,
      type: "commit",
      url: `${origin}/api/v1/repos/${owner}/${slug}/git/commits/${commitSha}`,
    },
    tagger: null,
    url: `${origin}/api/v1/repos/${owner}/${slug}/git/tags/${tip.target}`,
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

/** GitBlobResponse — base64 content (the LFS fields stay unset pre-LFS-SPEC). */
export function toGitBlob(oid: string, data: Uint8Array, pair: RepositoryWithOwner, origin: string): GitBlobResponse {
  const owner = encodeURIComponent(pair.repo.ownerNamespace);
  const slug = encodeURIComponent(pair.repo.slug);
  return {
    sha: oid,
    url: `${origin}/api/v1/repos/${owner}/${slug}/git/blobs/${oid}`,
    size: data.byteLength,
    content: base64Encode(data),
    encoding: "base64",
  };
}

/**
 * ContentsResponse for one entry. `last_commit_*` enrichment rides a
 * listLog(ref, {path}) RPC per entry (the documented interim fallback — the
 * batched enrichment RPC of SPEC-0008 §3.5 is not on the boundary yet).
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
  const inline = isFile && opts.content !== null && opts.content.byteLength <= MAX_CONTENTS_RENDER_BYTES;
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
    size: opts.size ?? 0,
    encoding: inline ? "base64" : null,
    content: inline ? base64Encode(opts.content as Uint8Array) : null,
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
// from them; the "\ No newline at end of file" marker is not reproduced, a
// documented approximation).
// ---------------------------------------------------------------------------

function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

/** git-style mode column for the index line. */
function indexMode(file: DiffFileJson): string {
  const mode = file.new?.mode ?? file.old?.mode;
  return mode === undefined ? "" : ` ${mode}`;
}

export function renderUnifiedDiff(files: DiffFileJson[]): string {
  const out: string[] = [];
  for (const file of files) {
    const oldPath = file.old === null ? "/dev/null" : `a/${file.path}`;
    const newPath = file.new === null ? "/dev/null" : `b/${file.path}`;
    // git always names both sides after the (new) path here — /dev/null only
    // appears on the ---/+++ lines
    out.push(`diff --git a/${file.path} b/${file.path}`);
    if (file.old === null && file.new !== null) out.push(`new file mode ${file.new.mode}`);
    if (file.new === null && file.old !== null) out.push(`deleted file mode ${file.old.mode}`);
    if (file.old !== null || file.new !== null) {
      out.push(`index ${shortOid(file.old?.oid ?? "0000000")}..${shortOid(file.new?.oid ?? "0000000")}${indexMode(file)}`);
    }
    if (file.kind !== "text") {
      out.push(`Binary files ${oldPath} and ${newPath} differ`);
      continue;
    }
    out.push(`--- ${oldPath}`);
    out.push(`+++ ${newPath}`);
    for (const hunk of file.hunks) {
      out.push(`@@ -${hunk.aStart},${hunk.aLen} +${hunk.bStart},${hunk.bLen} @@`);
      for (const op of hunk.ops) {
        out.push(`${op.tag === "eq" ? " " : op.tag === "del" ? "-" : "+"}${op.line}`);
      }
    }
  }
  return out.join("\n");
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

/**
 * `git format-patch`-style rendering for the `.{diffType}` download family.
 * The trailing `-- \n{version}` signature is git's format-patch default (what
 * the PR download serves — services/pull/patch.go GetPatch); the commit
 * download passes `signature: null` for GetRawDiff's `--no-signature` flag
 * (modules/git/diff.go:73, the web.go:1760 arm).
 */
export function renderPatch(commit: CommitJson, files: DiffFileJson[], options?: { signature?: string | null }): string {
  const signature = options?.signature === undefined ? "2.47.0" : options.signature;
  const body = commit.message.split("\n");
  const subject = body[0] ?? "";
  const rest = body.slice(1).join("\n").replace(/^\n+/, "");
  const out = [
    `From ${commit.oid} Mon Sep 17 00:00:00 2001`,
    `From: ${commit.author.name} <${commit.author.email}>`,
    `Date: ${rfc2822(commit.author)}`,
    `Subject: [PATCH] ${subject}`,
    "",
  ];
  if (rest !== "") out.push(rest, "");
  out.push("---", renderUnifiedDiff(files));
  if (signature !== null) out.push("-- ", signature, "");
  return out.join("\n");
}

/** pulls/{index}/files entries from the PR range diff (ChangedFileList). */
export function toChangedFiles(files: DiffFileJson[], pair: RepositoryWithOwner, origin: string, ref: string): ChangedFile[] {
  const owner = encodeURIComponent(pair.repo.ownerNamespace);
  const slug = encodeURIComponent(pair.repo.slug);
  return files.map((f) => ({
    filename: f.path,
    previous_filename: null,
    status: f.old === null ? "added" : f.new === null ? "removed" : "modified",
    additions: f.add,
    deletions: f.del,
    changes: f.add + f.del,
    html_url: `${origin}/${owner}/${slug}/commit/${ref}#${f.path}`,
    raw_url: `${origin}/${owner}/${slug}/raw/${ref}/${f.path}`,
    contents_url: `${origin}/api/v1/repos/${owner}/${slug}/contents/${f.path}?ref=${ref}`,
  }));
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
      state.entries.set(name, { mode: "100644", oid: blob.oid });
      dirty.add(dir);
      outcomes.push({ ok: true });
      existing.push(false);
    } else if (change.operation === "update") {
      if (current === undefined) {
        // PUT without sha = create (upstream UpdateFile willCreate branch)
        const blob = await buildBlobObject(change.content ?? new Uint8Array());
        objects.push(blob);
        state.entries.set(name, { mode: "100644", oid: blob.oid });
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
      state.entries.set(name, { mode: current.mode, oid: blob.oid });
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
