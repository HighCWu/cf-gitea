/**
 * Contents-family service logic (SPEC-0004 §2.4 rows repoGetContents(List) /
 * repoCreateFile / repoUpdateFile / repoDeleteFile / repoChangeFiles /
 * repoGetRawFile(OrLFS) / repoGetEditorConfig / repoGetIssueTemplates): the
 * write orchestration over the Worker-side commit builder (git-models
 * buildFileChangeCommit → putApiObjects → commitApiChange), the legacy
 * `{ref}/{filepath}` raw-path resolution (upstream's
 * routers/common/serve.go ref-in-path algorithm), the minimal .editorconfig
 * section matcher (go-editorconfig's fnmatch subset), and the issue-template
 * discovery (modules/issue_template templates from the default branch).
 *
 * Routes stay thin per AGENTS.md — handlers parse, delegate here, respond.
 */

import type { Context } from "hono";
import type { CommitJson, Person } from "@cf-gitea/git-engine";

import type { ApiEnv } from "../env";
import { ApiError } from "../errors";
import {
  branchRef,
  commitApiChangeError,
  engineCell,
  engineReads,
  refTipMap,
  tagRef,
  ZERO_OID,
  type EngineReads,
  type RefTip,
} from "./engine";
import { base64Decode, buildFileChangeCommit, type BuiltChange } from "./git-models";
import { canWriteRepository } from "./repo-access";
import type { RepositoryWithOwner } from "./repository";

export { base64Decode };

// ---------------------------------------------------------------------------
// The shared write orchestration (CreateFile / UpdateFile / DeleteFile /
// ChangeFiles all reduce to upstream ChangeRepoFiles)
// ---------------------------------------------------------------------------

export interface ChangeRequestSpec {
  /** raw bytes (the route decoded the body's base64; invalid base64 → 422 there) */
  content?: Uint8Array;
  sha?: string;
  fromPath?: string;
  operation: "create" | "update" | "delete";
  path: string;
}

export interface ChangeCommitMeta {
  message: string;
  author: Person;
  committer: Person;
}

export interface ApplyChangeResult {
  built: BuiltChange;
  /** the ref the change landed on (branch, or the new_branch) */
  ref: string;
  refTarget: string;
  /** the decoded target path of each change (FileResponse re-reads) */
  paths: string[];
}

/**
 * Build + store + CAS one change set (all-or-nothing: a failed change aborts
 * before any ref moves). Upstream status mapping
 * (handleChangeRepoFilesError): create-already-exists / sha-mismatch /
 * invalid path → 422; missing target file → 404; lost CAS → 409.
 */
export async function applyFileChanges(
  c: Context<ApiEnv>,
  pair: RepositoryWithOwner,
  spec: { branch?: string; new_branch?: string },
  changes: ChangeRequestSpec[],
  meta: ChangeCommitMeta,
): Promise<ApplyChangeResult> {
  if (!(await canWriteRepository(c, pair))) {
    throw new ApiError(403, "user should have a permission to write to the target branch");
  }

  const reads = engineReads(c.env, pair.repo);
  const tips = refTipMap(await reads.listRefs());
  const branch = spec.branch === undefined || spec.branch === "" ? pair.repo.defaultBranch : spec.branch;
  const tip = tips.get(branchRef(branch));
  if (tip === undefined) {
    throw new ApiError(404, `branch does not exist [name: ${branch}]`);
  }

  for (const change of changes) {
    if (change.operation !== "delete" && change.content === undefined) {
      throw new ApiError(422, "content is required");
    }
  }

  const built = await buildFileChangeCommit(
    reads,
    tip.target,
    changes,
    { message: meta.message, author: meta.author, committer: meta.committer },
  );
  if (built === null) {
    throw new ApiError(404, `branch does not exist [name: ${branch}]`);
  }
  const failed = built.outcomes.findIndex((outcome) => !outcome.ok);
  if (failed >= 0) {
    const error = built.outcomes[failed]?.error ?? "";
    if (error.includes("does not exist")) {
      throw new ApiError(404, error);
    }
    throw new ApiError(422, error);
  }

  // new_branch commits the change on a fresh ref; the source branch stays.
  const targetRef = spec.new_branch !== undefined && spec.new_branch !== "" ? branchRef(spec.new_branch) : branchRef(branch);
  const expectedOld = targetRef === branchRef(branch) ? tip.target : ZERO_OID;

  const cell = engineCell(c.env, pair.repo);
  const stored = await cell.putApiObjects(built.objects);
  if (stored.tag !== "ok") {
    throw new ApiError(422, stored.tag === "invalid" ? stored.reason : "change too large");
  }
  const landed = await cell.commitApiChange({ ref: targetRef, expectedOldOid: expectedOld, newOid: built.commitOid });
  if (landed.tag !== "committed") {
    throw commitApiChangeError(landed);
  }
  return { built, ref: targetRef, refTarget: landed.newOid, paths: changes.map((change) => change.path) };
}

/** Upstream changeFilesCommitMessage — the synthesized default message. */
export function defaultChangeMessage(changes: ReadonlyArray<{ operation: string; path: string }>): string {
  const created: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];
  for (const change of changes) {
    if (change.operation === "create") created.push(change.path);
    else if (change.operation === "update") updated.push(change.path);
    else if (change.operation === "delete") deleted.push(change.path);
  }
  const parts: string[] = [];
  if (created.length > 0) parts.push(`Add ${created.join(", ")}`);
  if (updated.length > 0) parts.push(`Update ${updated.join(", ")}`);
  if (deleted.length > 0) parts.push(`Delete ${deleted.join(", ")}`);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Legacy `{ref}/{filepath}` raw-path resolution (repoGetRawFile's filepath
// doc: "it should be {ref}/{filepath}"; SPEC-0004 §4's algorithm) — prefer an
// explicit `ref` query param, else split the leading segments as a branch
// name, then a tag name, then a 40-char sha prefix, longest first; the whole
// path on the default branch is the final fallback.
// ---------------------------------------------------------------------------

export function resolveRawPath(
  tips: Map<string, RefTip>,
  rawPath: string,
  refParam: string | null,
  defaultBranch: string,
): { target: string; filepath: string } | null {
  const segments = rawPath.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return null;

  if (refParam !== null && refParam !== "") {
    const resolved = tips.get(branchRef(refParam)) ?? tips.get(tagRef(refParam)) ?? tips.get(refParam);
    if (resolved !== undefined) return { target: resolved.target, filepath: segments.join("/") };
    if (/^[0-9a-f]{40}$/.test(refParam)) return { target: refParam, filepath: segments.join("/") };
    return null;
  }

  // longest prefix first; index is the split point (prefix = segments[:i])
  for (let i = segments.length - 1; i >= 1; i--) {
    const prefix = segments.slice(0, i).join("/");
    const branch = tips.get(branchRef(prefix));
    if (branch !== undefined) return { target: branch.target, filepath: segments.slice(i).join("/") };
    const tag = tips.get(tagRef(prefix));
    if (tag !== undefined) return { target: tag.target, filepath: segments.slice(i).join("/") };
  }
  for (let i = segments.length - 1; i >= 1; i--) {
    const prefix = segments.slice(0, i).join("/");
    if (/^[0-9a-f]{40}$/.test(prefix)) return { target: prefix, filepath: segments.slice(i).join("/") };
  }
  const fallback = tips.get(branchRef(defaultBranch));
  if (fallback === undefined) return null;
  return { target: fallback.target, filepath: segments.join("/") };
}

// ---------------------------------------------------------------------------
// .editorconfig — the fnmatch subset go-editorconfig applies: `**` crosses
// directories, `*`/`?` do not. Sections apply in file order; later matches
// override earlier keys. Null when the file has no .editorconfig.
// ---------------------------------------------------------------------------

function globToRegExp(pattern: string): RegExp {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === "*" && pattern[i + 1] === "*") {
      out += ".*";
      i++;
      // `**/` also matches zero directories (git-style fnmatch)
      if (pattern[i + 1] === "/") i++;
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      out += `\\${ch}`;
    } else if (ch === "{") {
      out += "(?:";
    } else if (ch === "}") {
      out += ")";
    } else if (ch === ",") {
      out += "|";
    } else {
      out += ch;
    }
  }
  return new RegExp(`${out}$`, "u");
}

export function editorconfigSection(iniText: string, filepath: string): Record<string, string> | null {
  const definition: Record<string, string> = {};
  let matched = false;
  let current: { raw: string; regexp: RegExp } | null = null;
  for (const line of iniText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const section = /^\[([^[\]]+)\]$/.exec(trimmed);
    if (section !== null) {
      const raw = section[1] as string;
      current = { raw, regexp: globToRegExp(raw) };
      continue;
    }
    const pair = trimmed.split("=", 2);
    if (pair.length !== 2 || current === null) continue;
    const key = pair[0]?.trim() ?? "";
    const value = (pair[1] ?? "").trim();
    if (current.regexp.test(filepath)) {
      matched = true;
      definition[key] = value;
    }
  }
  return matched ? definition : null;
}

// ---------------------------------------------------------------------------
// Issue templates — modules/issue_template: the template directories of the
// default branch (.gitea/.github/ISSUE_TEMPLATE(+lowercase), ISSUE_TEMPLATE)
// plus the single-file forms; .md and .yml/.yaml with YAML front matter.
// The minimal front-matter parser covers the scalar/simple-list keys of the
// contract model (name/about/title/ref/labels/assignees); form-type bodies
// (array<form_field>) stay opaque (documented divergence).
// ---------------------------------------------------------------------------

const TEMPLATE_DIRS = [
  ".gitea/ISSUE_TEMPLATE",
  ".gitea/issue_template",
  ".github/ISSUE_TEMPLATE",
  ".github/issue_template",
  "ISSUE_TEMPLATE",
  "issue_template",
];

const TEMPLATE_FILES = [".gitea/issue_template.md", ".gitea/ISSUE_TEMPLATE.md", ".github/issue_template.md", ".github/ISSUE_TEMPLATE.md", "issue_template.md"];

export interface ParsedTemplate {
  fileName: string;
  frontMatter: Record<string, string>;
  /** .md body after the front-matter block (content field) */
  content: string;
}

export function parseIssueTemplate(fileName: string, text: string): ParsedTemplate {
  const frontMatter: Record<string, string> = {};
  let content = text;
  if (/^---\r?\n/.test(text)) {
    const end = text.indexOf("\n---", 4);
    if (end >= 0) {
      for (const line of text.slice(4, end).split(/\r?\n/)) {
        const pair = line.split(":", 2);
        if (pair.length === 2) {
          frontMatter[(pair[0] ?? "").trim()] = (pair[1] ?? "").trim();
        }
      }
      content = text.slice(end + 4).replace(/^\r?\n/, "");
    }
  }
  return { fileName, frontMatter, content };
}

/**
 * Discover the template files of one ref: dir listings first (every
 * .md/.yml/.yaml entry), then the single-file forms. Ordered per upstream's
 * IssueTemplatesFromDefaultBranch (gitea → github → root).
 */
export async function listIssueTemplates(
  reads: EngineReads,
  refTarget: string,
): Promise<ParsedTemplate[]> {
  const out: ParsedTemplate[] = [];
  const seen = new Set<string>();
  for (const dir of TEMPLATE_DIRS) {
    const tree = await reads.listTree(refTarget, dir);
    if (tree === null) continue;
    for (const entry of tree.entries) {
      if (entry.type !== "blob") continue;
      if (!/\.(md|yaml|yml)$/.test(entry.name)) continue;
      const path = `${dir}/${entry.name}`;
      if (seen.has(path)) continue;
      seen.add(path);
      const blob = await reads.readBlob(refTarget, path);
      if (blob === null) continue;
      out.push(parseIssueTemplate(entry.name, new TextDecoder().decode(blob.data)));
    }
  }
  for (const file of TEMPLATE_FILES) {
    if (seen.has(file)) continue;
    const blob = await reads.readBlob(refTarget, file);
    if (blob === null) continue;
    seen.add(file);
    out.push(parseIssueTemplate(file.split("/").pop() ?? file, new TextDecoder().decode(blob.data)));
  }
  return out;
}

/** The last commit touching a path — the ContentsResponse enrichment input. */
export async function lastCommitForPath(reads: EngineReads, ref: string, path: string): Promise<CommitJson | null> {
  const log = await reads.listLog(ref, { path, n: 1 });
  return log === null ? null : (log.commits[0] ?? null);
}
