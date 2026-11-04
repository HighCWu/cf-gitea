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
import { parse } from "yaml";
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
// Issue templates — the API arm of upstream's template discovery, ported from
// the pinned tree: services/issue/template.go (ParseTemplatesFromDefaultBranch,
// templateDirCandidates), modules/issue/template (unmarshal.go, template.go
// Validate) and the IssueTemplate JSON contract of modules/structs/issue.go.
// The caller resolves the DEFAULT BRANCH tip; a `ref` query param does not
// exist upstream (v1-swagger repoGetIssueTemplates) and never reaches here.
// ---------------------------------------------------------------------------

/** services/issue/template.go templateDirCandidates — same order (the output
 *  order follows it). DIRECTORIES only: the single-file `issue_template.*`
 *  forms are web-UI-only (routers/web/repo/issue.go IssueTemplateCandidates)
 *  and never enter the API arm. */
const TEMPLATE_DIRS = [
  "ISSUE_TEMPLATE",
  "issue_template",
  ".gitea/ISSUE_TEMPLATE",
  ".gitea/issue_template",
  ".github/ISSUE_TEMPLATE",
  ".github/issue_template",
  ".gitlab/ISSUE_TEMPLATE",
  ".gitlab/issue_template",
];

/** setting.UI.MaxDisplayFileSize default (setting/ui.go:98) — a template blob
 *  over this is a parse error (upstream checks entry.Blob().Size() BEFORE the
 *  content read; ours reads the whole blob via the RPC then rejects on
 *  byteLength — a memory-only difference, the observable result is identical). */
const MAX_DISPLAY_FILE_SIZE = 8_388_608;

/** unmarshal.go ReadWithLimit(r, 1024*1024) — content is hard-truncated to
 *  1 MiB (ReadWithLimit caps the read, it does not fail). */
const TEMPLATE_CONTENT_LIMIT = 1_048_576;

export type IssueTemplateType = "md" | "yaml";

/** structs/issue.go IssueTemplate.Type() — `config.yaml`/`config.yml` basenames
 *  are the special config file (skipped); only .md/.yaml/.yml could be a
 *  template (template.CouldBe's low-cost check). */
export function issueTemplateType(fileName: string): IssueTemplateType | "" {
  const base = fileName.slice(fileName.lastIndexOf("/") + 1);
  if (base === "config.yaml" || base === "config.yml") return "";
  if (base.endsWith(".md")) return "md";
  if (base.endsWith(".yaml") || base.endsWith(".yml")) return "yaml";
  return "";
}

/** structs/issue.go IssueFormField — attributes/validations marshal null when
 *  absent; `visible` is omitempty (dropped when empty). */
export interface TemplateFormField {
  type: string;
  id: string;
  attributes: Record<string, unknown> | null;
  validations: Record<string, unknown> | null;
  visible?: string[];
}

/** One VALID template, in the IssueTemplate struct's Go-marshal semantics:
 *  string empties stay "", nil slices arrive as null (no omitempty). */
export interface ParsedIssueTemplate {
  fileName: string;
  name: string;
  title: string;
  about: string;
  labels: string[] | null;
  assignees: string[] | null;
  ref: string;
  content: string;
  body: TemplateFormField[] | null;
}

/** ParseTemplatesFromDefaultBranch's ret: the valid templates plus the
 *  TemplateErrors map (path → first error). Only the error COUNT crosses the
 *  wire (the X-Gitea-Warning header), but the shape mirrors the upstream map. */
export interface IssueTemplatesResult {
  templates: ParsedIssueTemplate[];
  errors: Record<string, string>;
}

/** truncate.go ellipsisDisplayString — ASCII-width-guessed truncation with a
 *  "…" tail; the .md fallback's about (EllipsisDisplayString(content, 80)). */
function ellipsisDisplayString(str: string, limit: number): string {
  const runeBytes = (r: string): number => {
    const cp = r.codePointAt(0) ?? 0;
    return cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  };
  const widthOf = (r: string): number => {
    const cp = r.codePointAt(0) ?? 0;
    if (cp <= 255) return 1;
    if (cp === 0x3000) return 2;
    return /[\p{M}\p{Cf}\p{Cs}\p{Z}]/u.test(r) ? 1 : 2;
  };
  const runes = Array.from(str);
  const bytesAt = (start: number): number => runes.slice(start).reduce((n, r) => n + runeBytes(r), 0);
  if (bytesAt(0) <= limit) return str;
  // Go: for i, r := range str { pos = i; if used+w+3 > limit { break }; used += w; offset += runeLen }
  let pos = 0;
  let used = 0;
  const kept: string[] = [];
  for (let i = 0; i < runes.length; i++) {
    pos = i;
    const w = widthOf(runes[i] ?? "");
    if (used + w + 3 > limit) break;
    used += w;
    kept.push(runes[i] ?? "");
  }
  // the remaining-few-runes arm: fewer than 3 runes left → keep everything
  if (bytesAt(pos) <= 12) {
    let nextCnt = 0;
    let nextWidth = 0;
    for (const r of runes.slice(pos)) {
      if (nextCnt >= 4) break;
      nextWidth += widthOf(r);
      nextCnt++;
    }
    if (nextCnt <= 3 && used + nextWidth <= limit) return str;
  }
  if (limit < 3) return kept.join("");
  return `${kept.join("")}…`;
}

/** meta.go isYAMLSeparator: optional leading spaces, 3+ dashes, then only
 *  spaces (the ASCII space subset — upstream also tolerates unicode spaces,
 *  unobservable on real templates). */
function isYamlSeparator(line: string): boolean {
  let idx = 0;
  while (idx < line.length && line[idx] === " ") idx++;
  let dashes = 0;
  while (idx < line.length && line[idx] === "-") {
    dashes++;
    idx++;
  }
  if (dashes < 3) return false;
  while (idx < line.length) {
    if (line[idx] !== " ") return false;
    idx++;
  }
  return true;
}

/** meta.go ExtractMetadataBytes' line scan: front matter between the two
 *  separator lines, content after the second. Null = the upstream error arms
 *  (missing leading/closing separator or an empty front block). */
function extractMetadata(contents: string): { front: string; body: string } | null {
  const lines = contents.split("\n");
  if (!isYamlSeparator(lines[0] ?? "")) return null;
  for (let i = 1; i < lines.length; i++) {
    if (isYamlSeparator(lines[i] ?? "")) {
      const front = lines.slice(1, i).join("\n");
      if (front === "") return null; // "could not determine metadata"
      return { front, body: lines.slice(i + 1).join("\n") };
    }
  }
  return null;
}

const YAML_STRING = "yaml: unmarshal"; // error-family prefix, unobservable (count-only)

/** structs/issue.go IssueTemplateStringSlice.UnmarshalYAML: a comma-separated
 *  scalar or a sequence of strings; absent/null → nil (marshals null); a
 *  scalar that splits to nothing also lands nil; non-string entries error. */
function decodeStringSlice(value: unknown): string[] | null | string {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const list = value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");
    return list.length > 0 ? list : null;
  }
  if (Array.isArray(value)) {
    const list: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") return `${YAML_STRING}: cannot unmarshal into string slice`;
      list.push(entry);
    }
    return list;
  }
  return `${YAML_STRING}: cannot unmarshal into IssueTemplateStringSlice`;
}

/** The metadata keys of an IssueTemplate yaml decode (front matter for .md,
 *  whole document for .yaml). Returns the typed record or an error message.
 *  Every non-string scalar under a string key is a decode error (go-yaml
 *  refuses !!int/!!bool into string fields). */
function decodeTemplateMeta(data: unknown): { meta: Pick<ParsedIssueTemplate, "name" | "title" | "about" | "ref" | "labels" | "assignees">; description: string } | string {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return `${YAML_STRING}: cannot unmarshal into IssueTemplate`;
  }
  const map = data as Record<string, unknown>;
  const strings: Record<string, string> = {};
  for (const key of ["name", "title", "about", "ref"]) {
    const value = map[key];
    if (value === undefined) continue; // absent key → the Go zero value ""
    if (typeof value !== "string") return `${YAML_STRING}: cannot unmarshal non-string scalar into string field`;
    strings[key] = value;
  }
  const labels = decodeStringSlice(map["labels"]);
  if (typeof labels === "string") return labels;
  const assignees = decodeStringSlice(map["assignees"]);
  if (typeof assignees === "string") return assignees;
  // unmarshal.go compatibleTemplate — "description" fills an empty about
  // (decode errors of the compat pass are swallowed upstream)
  const description = typeof map["description"] === "string" ? map["description"] : "";
  return {
    meta: {
      name: strings["name"] ?? "",
      title: strings["title"] ?? "",
      about: strings["about"] ?? "",
      ref: strings["ref"] ?? "",
      labels,
      assignees,
    },
    description,
  };
}

/** One `body` array entry (unmarshal.go's yaml arm into []*IssueFormField). */
function decodeFormField(value: unknown): TemplateFormField | string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `${YAML_STRING}: cannot unmarshal into IssueFormField`;
  }
  const map = value as Record<string, unknown>;
  // absent string keys decode to the Go zero value "" (only a PRESENT
  // non-string scalar is a decode error)
  const stringOrEmpty = (key: string): string | null => {
    const v = map[key];
    if (v === undefined) return "";
    if (typeof v === "string") return v;
    return null;
  };
  const type = stringOrEmpty("type");
  const id = stringOrEmpty("id");
  if (type === null || id === null) {
    return `${YAML_STRING}: cannot unmarshal non-string scalar into string field`;
  }
  const asRecordOrNull = (v: unknown): Record<string, unknown> | null | string => {
    if (v === undefined || v === null) return null;
    if (typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    return `${YAML_STRING}: cannot unmarshal into map field`;
  };
  const attributes = asRecordOrNull(map["attributes"]);
  if (typeof attributes === "string") return attributes;
  const validations = asRecordOrNull(map["validations"]);
  if (typeof validations === "string") return validations;
  const visibleRaw = map["visible"];
  let visible: string[] | undefined;
  if (visibleRaw !== undefined && visibleRaw !== null) {
    if (!Array.isArray(visibleRaw)) return `${YAML_STRING}: cannot unmarshal into []string`;
    for (const entry of visibleRaw) {
      if (typeof entry !== "string") return `${YAML_STRING}: cannot unmarshal into []string`;
    }
    visible = visibleRaw as string[];
  }
  return { type, id, attributes, validations, ...(visible !== undefined ? { visible } : {}) };
}

/** template.go Validate — returns the first error or null. The type comes
 *  from issueTemplateType, whose "" arm (a non-.md/.yml/.yaml name — Cannot
 *  happen behind the CouldBe filter, but typed honestly) leaves the zero
 *  template to fail the metadata check like upstream's unmarshal no-op. */
function validateTemplate(template: ParsedIssueTemplate, type: IssueTemplateType | ""): string | null {
  // validateMetadata
  if (template.name.trim() === "") return "'name' is required";
  if (template.about.trim() === "") return "'about' is required";
  if (type !== "yaml") return null; // validateYaml is the yaml-only arm
  // validateYaml
  const body = template.body;
  if (body === null || body.length === 0) return "'body' is required";
  const ids = new Set<string>();
  for (const [idx, field] of body.entries()) {
    const position = `body[${idx}](${field.type})`;
    // validateID (markdown exempt)
    if (field.type !== "markdown") {
      if (field.id === "") return `${position}: 'id' is required`;
      if (/[^A-Za-z0-9_-]/.test(field.id)) return `${position}: 'id' should contain only alphanumeric, '-' and '_'`;
      if (ids.has(field.id)) return `${position}: 'id' should be unique`;
      ids.add(field.id);
    }
    const attrs = field.attributes ?? {};
    const validations = field.validations ?? {};
    const stringItem = (m: Record<string, unknown>, name: string, required: boolean): string | null => {
      const v = m[name];
      if (v === undefined) return required ? `${position}: '${name}' is required` : null;
      if (typeof v !== "string") return `${position}: '${name}' should be a string`;
      if (v.trim() === "" && required) return `${position}: '${name}' is required`;
      return null;
    };
    const boolItem = (m: Record<string, unknown>, name: string): string | null => {
      const v = m[name];
      if (v === undefined) return null;
      if (typeof v !== "boolean") return `${position}: '${name}' should be a bool`;
      return null;
    };
    // validateLabel (markdown exempt)
    if (field.type !== "markdown") {
      const err = stringItem(attrs, "label", true);
      if (err !== null) return err;
    }
    switch (field.type) {
      case "markdown": {
        const err = stringItem(attrs, "value", true);
        if (err !== null) return err;
        break;
      }
      case "textarea": {
        for (const name of ["description", "placeholder", "value", "render"]) {
          const err = stringItem(attrs, name, false);
          if (err !== null) return err;
        }
        break;
      }
      case "input": {
        for (const name of ["description", "placeholder", "value"]) {
          const err = stringItem(attrs, name, false);
          if (err !== null) return err;
        }
        const isNumber = boolItem(validations, "is_number");
        if (isNumber !== null) return isNumber;
        const regex = stringItem(validations, "regex", false);
        if (regex !== null) return regex;
        break;
      }
      case "dropdown": {
        const description = stringItem(attrs, "description", false);
        if (description !== null) return description;
        const multiple = boolItem(attrs, "multiple");
        if (multiple !== null) return multiple;
        const list = boolItem(attrs, "list");
        if (list !== null) return list;
        const options = attrs["options"];
        if (!Array.isArray(options) || options.length === 0) {
          return `${position}: 'options' is required and should be an array`;
        }
        for (const option of options) {
          if (typeof option !== "string") return `${position}, option[${options.indexOf(option)}]: should be a string`;
        }
        const def = attrs["default"];
        if (def !== undefined) {
          if (typeof def !== "number" || !Number.isInteger(def)) {
            return `${position}: 'default' should be an int`;
          }
          if (def < 0 || def >= options.length) {
            return `${position}: the value of 'default' is out of range`;
          }
        }
        break;
      }
      case "checkboxes": {
        const description = stringItem(attrs, "description", false);
        if (description !== null) return description;
        const options = attrs["options"];
        if (!Array.isArray(options) || options.length === 0) {
          return `${position}: 'options' is required and should be an array`;
        }
        for (const [optIdx, option] of options.entries()) {
          const optPosition = `${position}, option[${optIdx}]`;
          if (option === null || typeof option !== "object" || Array.isArray(option)) {
            return `${optPosition}: should be a dictionary`;
          }
          const dict = option as Record<string, unknown>;
          const label = dict["label"];
          if (typeof label !== "string" || label === "") {
            return `${optPosition}: 'label' is required and should be a string`;
          }
          if ("visible" in dict) {
            const visibility = dict["visible"];
            if (!Array.isArray(visibility)) return `${optPosition}: 'visible' should be list`;
            for (const visibleType of visibility) {
              if (visibleType !== "form" && visibleType !== "content") {
                return `${optPosition}: 'visible' list can only contain strings of 'form' and 'content'`;
              }
            }
          }
          if ("required" in dict) {
            if (typeof dict["required"] !== "boolean") {
              return `${optPosition}: 'required' should be a bool`;
            }
            if (dict["required"] === true && "visible" in dict) {
              const isVisible = (dict["visible"] as unknown[]).some((v) => v === "form");
              if (!isVisible) return `${optPosition}: can not require a hidden checkbox`;
            }
          }
        }
        break;
      }
      default:
        return `${position}: unknown type`;
    }
    // validateRequired (markdown/checkboxes exempt)
    if (field.type !== "markdown" && field.type !== "checkboxes") {
      const required = boolItem(validations, "required");
      if (required !== null) return required;
      if (validations["required"] === true) {
        const visible = field.visible ?? [];
        const visibleOnForm = visible.length === 0 || visible.includes("form");
        if (!visibleOnForm) return `${position}: can not require a hidden field`;
      }
    }
  }
  return null;
}

/** unmarshal.go Unmarshal over one blob — returns the parsed template or the
 *  first error message (the TemplateErrors map value). */
function unmarshalTemplate(fileName: string, data: Uint8Array): ParsedIssueTemplate | string {
  const type = issueTemplateType(fileName);
  // ReadWithLimit: hard truncation at 1 MiB, never a size error (io.go:36)
  const content =
    data.byteLength > TEMPLATE_CONTENT_LIMIT
      ? new TextDecoder().decode(data.slice(0, TEMPLATE_CONTENT_LIMIT))
      : new TextDecoder().decode(data);
  const template: ParsedIssueTemplate = { fileName, name: "", title: "", about: "", labels: null, assignees: null, ref: "", content: "", body: null };
  if (type === "md") {
    const extracted = extractMetadata(content);
    const fallback = (): void => {
      // unmarshal.go:99-111 — unreadable metadata is NOT an error: the whole
      // file is the content, name falls back to the base name, about to an
      // ellipsized content preview
      template.content = content;
      template.name = fileName.slice(fileName.lastIndexOf("/") + 1);
      template.about = ellipsisDisplayString(content, 80);
    };
    if (extracted === null) {
      fallback();
    } else {
      // ExtractMetadata's yaml.Unmarshal error arm — a malformed front block
      // degrades to the fallback shape, never a TemplateError
      let parsedFront: unknown;
      try {
        parsedFront = parse(extracted.front);
      } catch {
        parsedFront = null; // decodeTemplateMeta(null) → error message → fallback
      }
      const decoded = decodeTemplateMeta(parsedFront);
      if (typeof decoded === "string") {
        fallback(); // the ExtractMetadata error arm — same fallback shape
      } else {
        template.content = extracted.body;
        template.name = decoded.meta.name;
        template.title = decoded.meta.title;
        template.ref = decoded.meta.ref;
        template.labels = decoded.meta.labels;
        template.assignees = decoded.meta.assignees;
        template.about = decoded.meta.about !== "" ? decoded.meta.about : decoded.description;
      }
    }
  } else if (type === "yaml") {
    let parsed: unknown;
    try {
      parsed = parse(content);
    } catch (error) {
      return `${YAML_STRING}: ${error instanceof Error ? error.message : String(error)}`;
    }
    const decoded = decodeTemplateMeta(parsed);
    if (typeof decoded === "string") return decoded;
    template.name = decoded.meta.name;
    template.title = decoded.meta.title;
    template.ref = decoded.meta.ref;
    template.labels = decoded.meta.labels;
    template.assignees = decoded.meta.assignees;
    template.about = decoded.meta.about !== "" ? decoded.meta.about : decoded.description;
    // the body array
    const rawBody = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>)["body"] : undefined;
    if (rawBody !== undefined && rawBody !== null) {
      if (!Array.isArray(rawBody)) return `${YAML_STRING}: cannot unmarshal into []*IssueFormField`;
      const body: TemplateFormField[] = [];
      for (const entry of rawBody) {
        const field = decodeFormField(entry);
        if (typeof field === "string") return field;
        body.push(field);
      }
      template.body = body;
    }
    // unmarshal.go:130-143 — default id / default visibility
    for (const [i, field] of (template.body ?? []).entries()) {
      if (field.id === "") field.id = String(i);
      if (field.visible === undefined) {
        field.visible = field.type === "markdown" ? ["form"] : ["form", "content"];
      }
    }
  }
  const validationError = validateTemplate(template, type);
  if (validationError !== null) return validationError;
  return template;
}

/**
 * ParseTemplatesFromDefaultBranch (services/issue/template.go:111-155) over
 * one ref target — the caller passes the DEFAULT BRANCH tip (upstream
 * GetBranchCommit). Returns valid templates + the parse-error map; the route
 * emits the X-Gitea-Warning header from `Object.keys(errors).length`.
 */
export async function listIssueTemplates(reads: EngineReads, refTarget: string): Promise<IssueTemplatesResult> {
  const result: IssueTemplatesResult = { templates: [], errors: {} };
  for (const dir of TEMPLATE_DIRS) {
    const tree = await reads.listTree(refTarget, dir);
    if (tree === null) continue; // SubTree miss → next candidate (template.go:129-132)
    for (const entry of tree.entries) {
      if (entry.type !== "blob") continue;
      if (issueTemplateType(entry.name) === "") continue; // template.CouldBe
      const fullName = `${dir}/${entry.name}`; // path.Join(dirName, entry.Name())
      const blob = await reads.readBlob(refTarget, fullName);
      if (blob === null) continue;
      if (blob.data.byteLength > MAX_DISPLAY_FILE_SIZE) {
        result.errors[fullName] = `too large: ${blob.data.byteLength} > MaxDisplayFileSize`;
        continue;
      }
      const parsed = unmarshalTemplate(fullName, blob.data);
      if (typeof parsed === "string") {
        result.errors[fullName] = parsed;
        continue;
      }
      // template.go:147-149 — a bare ref is assumed to be a branch (tags need refs/tags/)
      if (!parsed.ref.startsWith("refs/")) parsed.ref = `refs/heads/${parsed.ref}`;
      result.templates.push(parsed);
    }
  }
  return result;
}

/** The last commit touching a path — the ContentsResponse enrichment input. */
export async function lastCommitForPath(reads: EngineReads, ref: string, path: string): Promise<CommitJson | null> {
  const log = await reads.listLog(ref, { path, n: 1 });
  return log === null ? null : (log.commits[0] ?? null);
}
