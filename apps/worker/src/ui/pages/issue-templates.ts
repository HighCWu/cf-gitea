/**
 * The ISSUE-TEMPLATE pipeline's parser + discovery service — the port of
 * upstream `services/issue/template.go` (discovery + config + the
 * has-anything predicate), `modules/issue/template/{template,unmarshal}.go`
 * (parse, validate, render) and `modules/markup/markdown/meta.go` (front
 * matter). SPEC-0005 §11 carries the derivation; every constant, message and
 * byte shape below cites its upstream site.
 *
 * Storage posture: the tree reads go through the engine-read client
 * (`api/services/engine.ts` `EngineReads` — listTree + readBlob), so this
 * module is storage-agnostic and directly unit-testable with a stub. The
 * handlers in `ui/index.ts` pass `engineReads(env, repo)` with the D1 row's
 * default-branch tip.
 *
 * No database schema: templates live in the git tree only (the D1 side never
 * learns about them), matching upstream's tree-only posture.
 */

import { parse as yamlParse } from "yaml";

import { ellipsisDisplayString } from "../../issues/service";

// ---------------------------------------------------------------------------
// Types (modules/structs/issue.go:146-236 — the IssueTemplate wire family)
// ---------------------------------------------------------------------------

export type IssueTemplateType = "md" | "yaml";

/** IssueFormField (structs/issue.go:157-162): type/id/attributes/validations/
 *  visible. `type` is a plain string — upstream's struct accepts any yaml
 *  scalar and the validator rejects the unknowns with `unknown type`. */
export interface IssueFormField {
  type: string;
  id: string;
  attributes: Record<string, unknown>;
  validations: Record<string, unknown>;
  visible: string[];
}

/** IssueTemplate (structs/issue.go:196-206) — our property style; the JSON
 *  wire projection lives in toApiIssueTemplate (the §11 API shape). */
export interface IssueTemplate {
  name: string;
  title: string;
  about: string;
  labels: string[];
  assignees: string[];
  ref: string;
  content: string;
  fields: IssueFormField[];
  fileName: string;
}

export interface ParsedIssueConfig {
  blankIssuesEnabled: boolean;
  contactLinks: Array<{ name: string; url: string; about: string }>;
}

export const DEFAULT_ISSUE_CONFIG: ParsedIssueConfig = { blankIssuesEnabled: true, contactLinks: [] };

// ---------------------------------------------------------------------------
// Candidates (services/issue/template.go:24-41 + routers/web/repo/issue.go:55-73)
// ---------------------------------------------------------------------------

/** templateDirCandidates (template.go:24-33) — precedence order matters: the
 *  first directory wins nothing per se (ALL dirs' templates accumulate into
 *  one list in this order), but the order IS the render order on the choose
 *  page. */
export const TEMPLATE_DIR_CANDIDATES = [
  "ISSUE_TEMPLATE",
  "issue_template",
  ".gitea/ISSUE_TEMPLATE",
  ".gitea/issue_template",
  ".github/ISSUE_TEMPLATE",
  ".github/issue_template",
  ".gitlab/ISSUE_TEMPLATE",
  ".gitlab/issue_template",
] as const;

/** templateConfigCandidates (template.go:35-40) — each tried `.yaml` then
 *  `.yml` (GetTemplateConfigFromDefaultBranch :169-177). */
export const TEMPLATE_CONFIG_CANDIDATES = [
  ".gitea/ISSUE_TEMPLATE/config",
  ".gitea/issue_template/config",
  ".github/ISSUE_TEMPLATE/config",
  ".github/issue_template/config",
] as const;

/** IssueTemplateCandidates (routers/web/repo/issue.go:55-73) — the fallback
 *  single-file paths the new-issue form tries after `?template=`. */
export const ISSUE_TEMPLATE_CANDIDATES = [
  "ISSUE_TEMPLATE.md",
  "ISSUE_TEMPLATE.yaml",
  "ISSUE_TEMPLATE.yml",
  "issue_template.md",
  "issue_template.yaml",
  "issue_template.yml",
  ".gitea/ISSUE_TEMPLATE.md",
  ".gitea/ISSUE_TEMPLATE.yaml",
  ".gitea/ISSUE_TEMPLATE.yml",
  ".gitea/issue_template.md",
  ".gitea/issue_template.yaml",
  ".gitea/issue_template.yml",
  ".github/ISSUE_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE.yaml",
  ".github/ISSUE_TEMPLATE.yml",
  ".github/issue_template.md",
  ".github/issue_template.yaml",
  ".github/issue_template.yml",
] as const;

/** The read cap `util.ReadWithLimit(r, 1024*1024)` (unmarshal.go:79) — it
 *  TRUNCATES silently (io.go:36-61), it does not error. */
export const TEMPLATE_READ_LIMIT = 1024 * 1024;

/** setting.UI.MaxDisplayFileSize default (setting/ui.go:98) — the blob-size
 *  gate `unmarshalFromEntry` applies before reading (unmarshal.go:69-71). */
export const MAX_DISPLAY_FILE_SIZE = 8388608;

// ---------------------------------------------------------------------------
// File-form rules (modules/structs/issue.go:268-279 + template.CouldBe)
// ---------------------------------------------------------------------------

/** `IssueTemplate.Type()` (structs/issue.go:268-279): "" marks not-a-template
 *  (config.yaml/yml excluded, unknown extensions skipped). */
export function issueTemplateType(fileName: string): IssueTemplateType | "" {
  const base = fileName.split("/").pop() ?? fileName;
  if (base === "config.yaml" || base === "config.yml") {
    // ignore config.yaml which is a special configuration file
    return "";
  }
  if (fileName.endsWith(".md")) return "md";
  if (fileName.endsWith(".yaml") || fileName.endsWith(".yml")) return "yaml";
  return "";
}

/** `template.CouldBe` (unmarshal.go:21-28) — the low-cost walk filter. */
export function couldBe(fileName: string): boolean {
  return issueTemplateType(fileName) !== "";
}

// ---------------------------------------------------------------------------
// Markdown front matter (modules/markup/markdown/meta.go — exact port)
// ---------------------------------------------------------------------------

/**
 * `isYAMLSeparator` (meta.go:13-45): optional leading spaces, a run of >= 3
 * dashes, then trailing spaces only. ASCII runes must be ' ' to continue;
 * non-ASCII runes must be unicode spaces (the Go port's rune loop).
 */
function isYamlSeparator(line: string): boolean {
  let idx = 0;
  while (idx < line.length) {
    if (line[idx] !== " ") break;
    idx += 1;
  }
  let dashCount = 0;
  while (idx < line.length && line[idx] === "-") {
    dashCount += 1;
    idx += 1;
  }
  if (dashCount < 3) return false;
  while (idx < line.length) {
    const char = line[idx] as string;
    if (char.charCodeAt(0) >= 0x80) {
      if (!/\s/u.test(char)) return false;
    } else if (char !== " ") {
      return false;
    }
    idx += 1;
  }
  return true;
}

export interface ExtractedFrontMatter {
  front: string;
  body: string;
}

/**
 * `ExtractMetadataBytes` (meta.go:64-95): the first line must be a separator;
 * the next separator line closes the front matter; the body is everything
 * after that line's newline (empty when the file ends there). A missing
 * separator or an empty front matter is the failure arm (meta.go:67,89) —
 * for .md templates the caller falls back to the generic-template shape, it
 * is NOT a parse error (unmarshal.go:99-112).
 */
export function extractFrontMatter(contents: string): ExtractedFrontMatter | null {
  const firstNewline = contents.indexOf("\n");
  const firstLine = firstNewline >= 0 ? contents.slice(0, firstNewline) : contents;
  if (!isYamlSeparator(firstLine)) return null;
  const frontStart = firstNewline >= 0 ? firstNewline + 1 : contents.length;
  let start = frontStart;
  while (start <= contents.length) {
    const newline = contents.indexOf("\n", start);
    const end = newline >= 0 ? newline : contents.length;
    if (isYamlSeparator(contents.slice(start, end))) {
      const front = contents.slice(frontStart, start);
      if (front === "") return null;
      const body = end + 1 < contents.length ? contents.slice(end + 1) : "";
      return { front, body };
    }
    if (newline < 0) break;
    start = newline + 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation (modules/issue/template/template.go — exact messages, first error)
// ---------------------------------------------------------------------------

/** `newErrorPosition` (template.go:296-302): `body[<i>](<type>)[, option[<j>]]`. */
function errorPosition(fieldIndex: number, fieldType: string, optionIndex?: number): string {
  let position = `body[${fieldIndex}](${fieldType})`;
  if (optionIndex !== undefined) position += `, option[${optionIndex}]`;
  return position;
}

/** `validateStringItem` (template.go:235-253). */
function validateStringItem(
  position: string,
  source: Record<string, unknown>,
  required: boolean,
  names: string[],
): string | null {
  for (const name of names) {
    const value = source[name];
    if (value === undefined) {
      if (required) return `${position}: '${name}' is required`;
      return null;
    }
    if (typeof value !== "string") return `${position}: '${name}' should be a string`;
    if (value.trim() === "" && required) return `${position}: '${name}' is required`;
  }
  return null;
}

/** `validateBoolItem` (template.go:255-266). */
function validateBoolItem(position: string, source: Record<string, unknown>, names: string[]): string | null {
  for (const name of names) {
    const value = source[name];
    if (value === undefined) return null;
    if (typeof value !== "boolean") return `${position}: '${name}' should be a bool`;
  }
  return null;
}

/** `validateOptions` (template.go:170-233). */
function validateOptions(field: IssueFormField, fieldIndex: number): string | null {
  const position = errorPosition(fieldIndex, field.type);
  const options = field.attributes["options"];
  if (!Array.isArray(options) || options.length === 0) {
    return `${position}: 'options' is required and should be an array`;
  }
  for (const [optionIndex, option] of options.entries()) {
    const optionPosition = errorPosition(fieldIndex, field.type, optionIndex);
    if (field.type === "dropdown") {
      if (typeof option !== "string") return `${optionPosition}: should be a string`;
    } else if (field.type === "checkboxes") {
      if (option === null || typeof option !== "object" || Array.isArray(option)) {
        return `${optionPosition}: should be a dictionary`;
      }
      const dict = option as Record<string, unknown>;
      const label = dict["label"];
      if (typeof label !== "string" || label === "") {
        return `${optionPosition}: 'label' is required and should be a string`;
      }
      if ("visible" in dict) {
        const visibility = dict["visible"];
        if (!Array.isArray(visibility)) return `${optionPosition}: 'visible' should be list`;
        for (const visibleType of visibility) {
          if (visibleType !== "form" && visibleType !== "content") {
            return `${optionPosition}: 'visible' list can only contain strings of 'form' and 'content'`;
          }
        }
      }
      if ("required" in dict) {
        if (typeof dict["required"] !== "boolean") return `${optionPosition}: 'required' should be a bool`;
        if (dict["required"] === true && "visible" in dict) {
          const visibility = Array.isArray(dict["visible"]) ? (dict["visible"] as unknown[]) : [];
          const isVisible = visibility.some((entry) => entry === "form");
          if (!isVisible) return `${optionPosition}: can not require a hidden checkbox`;
        }
      }
    }
  }
  return null;
}

/** `validateDropdownDefault` (template.go:268-288). */
function validateDropdownDefault(fieldIndex: number, attributes: Record<string, unknown>): string | null {
  const value = attributes["default"];
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return `${errorPosition(fieldIndex, "dropdown")}: 'default' should be an int`;
  }
  const options = attributes["options"];
  if (!Array.isArray(options)) {
    // should not happen
    return `${errorPosition(fieldIndex, "dropdown")}: 'options' is required and should be an array`;
  }
  if (value < 0 || value >= options.length) {
    return `${errorPosition(fieldIndex, "dropdown")}: the value of 'default' is out of range`;
  }
  return null;
}

/** `validateID` (template.go:150-168) — the non-[\w-] charset check. */
function validateId(field: IssueFormField, fieldIndex: number, seen: Set<string>): string | null {
  if (field.type === "markdown") return null; // the ID is not required for a markdown field
  const position = errorPosition(fieldIndex, field.type);
  if (field.id === "") return `${position}: 'id' is required`;
  // Go `[^\w-]` — ASCII word chars and dash are the allowed set (same set as JS \w).
  if (/[^\w-]/.test(field.id)) {
    return `${position}: 'id' should contain only alphanumeric, '-' and '_'`;
  }
  if (seen.has(field.id)) return `${position}: 'id' should be unique`;
  seen.add(field.id);
  return null;
}

/** `validateLabel` (template.go:128-134) — required unless markdown. */
function validateLabel(field: IssueFormField, fieldIndex: number): string | null {
  if (field.type === "markdown") return null;
  return validateStringItem(errorPosition(fieldIndex, field.type), field.attributes, true, ["label"]);
}

/** `validateRequired` (template.go:136-148) — markdown/checkboxes exempt;
 *  a required field must be visible on the form. */
function validateRequired(field: IssueFormField, fieldIndex: number): string | null {
  if (field.type === "markdown" || field.type === "checkboxes") return null;
  const boolError = validateBoolItem(errorPosition(fieldIndex, field.type), field.validations, ["required"]);
  if (boolError !== null) return boolError;
  if (field.validations["required"] === true && !visibleOnForm(field)) {
    return `${errorPosition(fieldIndex, field.type)}: can not require a hidden field`;
  }
  return null;
}

/** `validateYaml` (template.go:52-126) — per-type schema, first error wins. */
function validateYaml(template: IssueTemplate): string | null {
  if (template.fields.length === 0) return "'body' is required";
  const ids = new Set<string>();
  for (const [index, field] of template.fields.entries()) {
    const idError = validateId(field, index, ids);
    if (idError !== null) return idError;
    const labelError = validateLabel(field, index);
    if (labelError !== null) return labelError;

    const position = errorPosition(index, field.type);
    switch (field.type) {
      case "markdown": {
        const error = validateStringItem(position, field.attributes, true, ["value"]);
        if (error !== null) return error;
        break;
      }
      case "textarea": {
        const error = validateStringItem(position, field.attributes, false, ["description", "placeholder", "value", "render"]);
        if (error !== null) return error;
        break;
      }
      case "input": {
        const error = validateStringItem(position, field.attributes, false, ["description", "placeholder", "value"]);
        if (error !== null) return error;
        const isNumberError = validateBoolItem(position, field.validations, ["is_number"]);
        if (isNumberError !== null) return isNumberError;
        const regexError = validateStringItem(position, field.validations, false, ["regex"]);
        if (regexError !== null) return regexError;
        break;
      }
      case "dropdown": {
        const descriptionError = validateStringItem(position, field.attributes, false, ["description"]);
        if (descriptionError !== null) return descriptionError;
        const multipleError = validateBoolItem(position, field.attributes, ["multiple"]);
        if (multipleError !== null) return multipleError;
        const listError = validateBoolItem(position, field.attributes, ["list"]);
        if (listError !== null) return listError;
        const optionsError = validateOptions(field, index);
        if (optionsError !== null) return optionsError;
        const defaultError = validateDropdownDefault(index, field.attributes);
        if (defaultError !== null) return defaultError;
        break;
      }
      case "checkboxes": {
        const descriptionError = validateStringItem(position, field.attributes, false, ["description"]);
        if (descriptionError !== null) return descriptionError;
        const optionsError = validateOptions(field, index);
        if (optionsError !== null) return optionsError;
        break;
      }
      default:
        return `${position}: unknown type`;
    }

    const requiredError = validateRequired(field, index);
    if (requiredError !== null) return requiredError;
  }
  return null;
}

/** `Validate` (template.go:30-40): metadata for both forms; the field schema
 *  for yaml only (a markdown template's only schema is name/about). */
export function validateIssueTemplate(template: IssueTemplate): string | null {
  if (template.name.trim() === "") return "'name' is required";
  if (template.about.trim() === "") return "'about' is required";
  if (issueTemplateType(template.fileName) === "yaml") {
    return validateYaml(template);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Visibility helpers (structs/issue.go:165-181 — the len==0 defaults)
// ---------------------------------------------------------------------------

export function visibleOnForm(field: IssueFormField): boolean {
  if (field.visible.length === 0) return true;
  return field.visible.includes("form");
}

export function visibleInContent(field: IssueFormField): boolean {
  if (field.visible.length === 0) {
    // we have our markdown exception
    return field.type !== "markdown";
  }
  return field.visible.includes("content");
}

// ---------------------------------------------------------------------------
// Parse (modules/issue/template/unmarshal.go)
// ---------------------------------------------------------------------------

/** The strict scalar reads: Go's yaml.Unmarshal type-mismatches a
 *  non-string into the string fields (and treats a yaml null as absent). */
interface ParsedTemplateScalars {
  name: string;
  title: string;
  about: string;
  ref: string;
  description: string;
}

function scalarString(value: unknown): { value: string } | { error: string } {
  if (value === undefined || value === null) return { value: "" };
  if (typeof value === "string") return { value };
  return { error: "cannot unmarshal into string" };
}

function readTemplateScalars(front: Record<string, unknown>): { scalars: ParsedTemplateScalars } | { error: string } {
  const name = scalarString(front["name"]);
  if ("error" in name) return name;
  const title = scalarString(front["title"]);
  if ("error" in title) return title;
  const about = scalarString(front["about"]);
  if ("error" in about) return about;
  const ref = scalarString(front["ref"]);
  if ("error" in ref) return ref;
  const description = scalarString(front["description"]);
  if ("error" in description) return description;
  return {
    scalars: { name: name.value, title: title.value, about: about.value, ref: ref.value, description: description.value },
  };
}

/** The generic-template fallback shape (unmarshal.go:110-112). */

/** `IssueTemplateStringSlice` (structs/issue.go:208-236): a scalar is split on
 *  commas and trimmed (empties skipped); a sequence must be all strings. */
function stringSlice(value: unknown): { slice: string[]; error: string | null } {
  if (value === undefined || value === null) return { slice: [], error: null };
  if (typeof value === "string") {
    const slice: string[] = [];
    for (const part of value.split(",")) {
      const trimmed = part.trim();
      if (trimmed !== "") slice.push(trimmed);
    }
    return { slice, error: null };
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "string") {
        return { slice: [], error: `cannot unmarshal ${typeof entry} into string` };
      }
    }
    return { slice: value as string[], error: null };
  }
  return { slice: [], error: "cannot unmarshal value into string slice" };
}

/** A yaml mapping or absent → a plain record; anything else is the Go
 *  `map[string]any` type error arm. */
function stringMap(value: unknown): { map: Record<string, unknown>; error: string | null } {
  if (value === undefined || value === null) return { map: {}, error: null };
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return { map: value as Record<string, unknown>, error: null };
  }
  return { map: {}, error: "cannot unmarshal value into mapping" };
}

/** `IssueFormField` rows (structs/issue.go:157-162). */
function formFields(value: unknown): { fields: IssueFormField[]; error: string | null } {
  if (value === undefined || value === null) return { fields: [], error: null };
  if (!Array.isArray(value)) return { fields: [], error: "cannot unmarshal body into fields" };
  const fields: IssueFormField[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { fields: [], error: "cannot unmarshal field into mapping" };
    }
    const raw = entry as Record<string, unknown>;
    const attributes = stringMap(raw["attributes"]);
    if (attributes.error !== null) return { fields: [], error: attributes.error };
    const validations = stringMap(raw["validations"]);
    if (validations.error !== null) return { fields: [], error: validations.error };
    let visible: string[] = [];
    if (raw["visible"] !== undefined && raw["visible"] !== null) {
      if (!Array.isArray(raw["visible"])) return { fields: [], error: "cannot unmarshal visible into list" };
      for (const entry of raw["visible"]) {
        if (typeof entry !== "string") return { fields: [], error: "cannot unmarshal visible into list" };
      }
      visible = raw["visible"] as string[];
    }
    fields.push({
      type: typeof raw["type"] === "string" ? raw["type"] : "",
      id: typeof raw["id"] === "string" ? raw["id"] : "",
      attributes: attributes.map,
      validations: validations.map,
      visible,
    });
  }
  return { fields, error: null };
}

const YAML_ERROR_PREFIX = "yaml unmarshal: ";

/** A yaml document that must be a mapping (or empty — Go unmarshals an
 *  empty doc into the struct untouched); a scalar/array doc is the type
 *  error arm. */
function parseYamlMapping(source: string): Record<string, unknown> | null {
  const parsed = yamlParse(source) as unknown;
  if (parsed === undefined || parsed === null) return null;
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("cannot unmarshal document into mapping");
  }
  return parsed as Record<string, unknown>;
}

/** The generic-template fallback shape (unmarshal.go:110-112): the whole
 *  file becomes the content, the name the path base, the about the 80-width
 *  ellipsis of the content. */
function applyGenericTemplate(template: IssueTemplate, fileName: string, content: string): void {
  template.content = content;
  template.name = fileName.split("/").pop() ?? fileName;
  template.about = ellipsisDisplayString(content, 80);
}

/**
 * `unmarshal` + `Unmarshal` (unmarshal.go:31-42,87-147): parse the file into
 * a template, apply the yaml defaults (ids, visible), and validate — the
 * error string is upstream's (first validation failure, yaml prefix for the
 * yaml form). The markdown arm NEVER fails on front-matter trouble: the
 * generic-template fallback is the documented ambiguity arm (:99-112).
 */
export function unmarshalIssueTemplate(fileName: string, content: string): { template: IssueTemplate } | { error: string } {
  const type = issueTemplateType(fileName);
  const template: IssueTemplate = {
    name: "",
    title: "",
    about: "",
    labels: [],
    assignees: [],
    ref: "",
    content: "",
    fields: [],
    fileName,
  };
  if (type === "md") {
    const extracted = extractFrontMatter(content);
    if (extracted === null) {
      // The only thing we know here is that we can't extract metadata from
      // the content (:99-108) — the generic template, never an error.
      applyGenericTemplate(template, fileName, content);
    } else {
      let front: Record<string, unknown> | null;
      try {
        front = parseYamlMapping(extracted.front);
      } catch {
        front = null; // the ExtractMetadata error arm — same fallback shape
      }
      let scalars: ParsedTemplateScalars | null = null;
      if (front !== null) {
        const read = readTemplateScalars(front);
        const labels = stringSlice(front["labels"]);
        const assignees = stringSlice(front["assignees"]);
        if (!("error" in read) && labels.error === null && assignees.error === null) {
          scalars = read.scalars;
          template.labels = labels.slice;
          template.assignees = assignees.slice;
        }
      }
      if (front === null || scalars === null) {
        // ANY metadata trouble is the fallback: ExtractMetadata's error is
        // ambiguous between absent and invalid metadata (:99-112).
        applyGenericTemplate(template, fileName, content);
      } else {
        template.name = scalars.name;
        template.title = scalars.title;
        template.about = scalars.about;
        template.ref = scalars.ref;
        template.content = extracted.body;
        if (template.about === "") {
          // "description" is the compatible spelling (:93-95,116-118)
          template.about = scalars.description;
        }
      }
    }
    return validateOrError(template);
  }
  if (type === "yaml") {
    let front: Record<string, unknown> | null;
    try {
      front = parseYamlMapping(content);
    } catch (error) {
      return { error: `${YAML_ERROR_PREFIX}${error instanceof Error ? error.message : String(error)}` };
    }
    const scalarsRead = readTemplateScalars(front ?? {});
    if ("error" in scalarsRead) return { error: `${YAML_ERROR_PREFIX}${scalarsRead.error}` };
    const scalars = scalarsRead.scalars;
    const labels = stringSlice(front === null ? undefined : front["labels"]);
    if (labels.error !== null) return { error: `${YAML_ERROR_PREFIX}${labels.error}` };
    const assignees = stringSlice(front === null ? undefined : front["assignees"]);
    if (assignees.error !== null) return { error: `${YAML_ERROR_PREFIX}${assignees.error}` };
    const fields = formFields(front === null ? undefined : front["body"]);
    if (fields.error !== null) return { error: `${YAML_ERROR_PREFIX}${fields.error}` };
    template.name = scalars.name;
    template.title = scalars.title;
    template.ref = scalars.ref;
    template.labels = labels.slice;
    template.assignees = assignees.slice;
    template.fields = fields.fields;
    // unmarshal.go:130-142 — default ids and visibility
    for (const [index, field] of template.fields.entries()) {
      if (field.id === "") field.id = String(index);
      if (field.visible.length === 0) {
        field.visible = ["form"];
        if (field.type !== "markdown") field.visible = ["form", "content"];
      }
    }
    template.about = scalars.about === "" ? scalars.description : scalars.about;
    return validateOrError(template);
  }
  // unreachable through the walk (couldBe gates) — kept total anyway
  return { error: "unknown template type" };
}

/** The `Unmarshal` tail (unmarshal.go:37-39): validate, surface the first error. */
function validateOrError(template: IssueTemplate): { template: IssueTemplate } | { error: string } {
  const error = validateIssueTemplate(template);
  if (error !== null) return { error };
  return { template };
}

/**
 * `UnmarshalFromEntry`'s gates over an engine blob (unmarshal.go:68-85): the
 * MaxDisplayFileSize error, the silent 1 MiB truncation, then the parse.
 * (Upstream gates on `entry.Blob.Size` before reading; our transport already
 * holds the bytes, so the gate reads the same number off the buffer.)
 */
export function unmarshalTemplateBlob(fileName: string, data: Uint8Array): { template: IssueTemplate } | { error: string } {
  if (data.byteLength > MAX_DISPLAY_FILE_SIZE) {
    return { error: `too large: ${data.byteLength} > MaxDisplayFileSize` };
  }
  const content = new TextDecoder().decode(data).slice(0, TEMPLATE_READ_LIMIT);
  return unmarshalIssueTemplate(fileName, content);
}

/** The `ParseTemplatesFromDefaultBranch` ref normalization (:147-149). */
export function normalizeTemplateRef(ref: string): string {
  if (!ref.startsWith("refs/")) return `refs/heads/${ref}`;
  return ref;
}

// ---------------------------------------------------------------------------
// Discovery walk (services/issue/template.go:113-155)
// ---------------------------------------------------------------------------

export interface TemplateParseResult {
  templates: IssueTemplate[];
  /** fullName (dir/name) -> the first parse error's message. */
  errors: Map<string, string>;
}

/** The minimal read slice the walk needs (the engineReads client's subset). */
export type TemplateTreeReads = Pick<import("../../api/services/engine").EngineReads, "listTree" | "readBlob">;

/**
 * `ParseTemplatesFromDefaultBranch` (template.go:113-155) over the engine:
 * every dir candidate's direct entries (`listTree` — non-blob entries skip;
 * upstream's ListEntries returns dirs too and their blob read errors, a
 * pathological shape we answer with the same skip posture), the CouldBe
 * filter, the per-file readBlob + unmarshal with errors recorded per
 * fullName, and the ref normalization. `tip === null` (empty repo or missing
 * default branch) is the empty result (:119-126).
 */
export async function parseTemplatesFromDefaultBranch(reads: TemplateTreeReads, tip: string | null): Promise<TemplateParseResult> {
  const templates: IssueTemplate[] = [];
  const errors = new Map<string, string>();
  if (tip === null) return { templates, errors };
  for (const dir of TEMPLATE_DIR_CANDIDATES) {
    const tree = await reads.listTree(tip, dir);
    if (tree === null) continue; // no such subtree — debug and continue (:129-132)
    for (const entry of tree.entries) {
      if (!couldBe(entry.name)) continue;
      if (entry.type !== "blob") continue;
      const fullName = `${dir}/${entry.name}`;
      const blob = await reads.readBlob(tip, fullName);
      if (blob === null) continue; // vanished between the walk and the read — not a template error
      const parsed = unmarshalTemplateBlob(fullName, blob.data);
      if ("error" in parsed) {
        errors.set(fullName, parsed.error);
        continue;
      }
      parsed.template.ref = normalizeTemplateRef(parsed.template.ref);
      templates.push(parsed.template);
    }
  }
  return { templates, errors };
}

// ---------------------------------------------------------------------------
// Config walk (services/issue/template.go:42-117,158-181)
// ---------------------------------------------------------------------------

/** The `url.ParseRequestURI` port (template.go:92): absolute URI or absolute path. */
function isParseableRequestUri(raw: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) || raw.startsWith("/");
}

/** `GetTemplateConfig`'s contact-link validation (:79-96) — exact messages. */
export function validateIssueConfig(config: ParsedIssueConfig): string | null {
  for (const [position, link] of config.contactLinks.entries()) {
    if (link.name === undefined || link.name === "") return `contact_link at position ${position + 1} is missing name key`;
    if (link.url === undefined || link.url === "") return `contact_link at position ${position + 1} is missing url key`;
    if (link.about === undefined || link.about === "") return `contact_link at position ${position + 1} is missing about key`;
    if (!isParseableRequestUri(link.url)) return `${link.url} is not a valid URL`;
  }
  return null;
}

/**
 * The yaml-subset issue-config parse (the canonical shape: `blank_issues_enabled`
 * bool + `contact_links` list) — the repo-extras-t2.ts port's posture: a
 * structurally invalid file answers the DEFAULT config with an error message
 * (upstream surfaces go-yaml internals; recorded reduction SPEC §11.3).
 */
export function parseIssueConfig(source: string): { config: ParsedIssueConfig; error: string | null } {
  const config: ParsedIssueConfig = { blankIssuesEnabled: DEFAULT_ISSUE_CONFIG.blankIssuesEnabled, contactLinks: [] };
  const PARSE_ERROR = "yaml: unmarshal errors: invalid config format";
  const unquote = (value: string): string => {
    const trimmed = value.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  };
  let inLinks = false;
  let current: Partial<{ name: string; url: string; about: string }> | null = null;
  for (const rawLine of source.split("\n")) {
    if (rawLine.trim() === "" || rawLine.trim().startsWith("#")) continue;
    const indented = /^\s/.test(rawLine);
    const line = rawLine.trim();
    if (!indented) {
      current = null;
      inLinks = false;
      const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
      if (match === null) return { config: DEFAULT_ISSUE_CONFIG, error: PARSE_ERROR };
      const [, key, value] = match as unknown as [string, string, string];
      if (key === "blank_issues_enabled") {
        if (value !== "true" && value !== "false") return { config: DEFAULT_ISSUE_CONFIG, error: PARSE_ERROR };
        config.blankIssuesEnabled = value === "true";
      } else if (key === "contact_links") {
        if (value !== "") return { config: DEFAULT_ISSUE_CONFIG, error: PARSE_ERROR };
        inLinks = true;
      } else {
        return { config: DEFAULT_ISSUE_CONFIG, error: PARSE_ERROR };
      }
      continue;
    }
    if (!inLinks) continue;
    const listMatch = /^-\s*(?:([A-Za-z0-9_-]+)\s*:\s*(.*))?$/.exec(line);
    if (listMatch !== null) {
      if (current !== null) {
        config.contactLinks.push({ name: current.name ?? "", url: current.url ?? "", about: current.about ?? "" });
      }
      current = {};
      if (listMatch[1] !== undefined) {
        const key = listMatch[1] as "name" | "url" | "about";
        if (key !== "name" && key !== "url" && key !== "about") {
          return { config: DEFAULT_ISSUE_CONFIG, error: PARSE_ERROR };
        }
        current[key] = unquote(listMatch[2] ?? "");
      }
      continue;
    }
    const fieldMatch = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (fieldMatch !== null && current !== null) {
      const key = fieldMatch[1] as "name" | "url" | "about";
      if (key !== "name" && key !== "url" && key !== "about") {
        return { config: DEFAULT_ISSUE_CONFIG, error: PARSE_ERROR };
      }
      current[key] = unquote(fieldMatch[2] ?? "");
    }
  }
  if (current !== null) {
    // the Go struct zero values: an absent key is the empty string
    config.contactLinks.push({ name: current.name ?? "", url: current.url ?? "", about: current.about ?? "" });
  }
  return { config, error: null };
}

export interface IssueConfigResult {
  config: ParsedIssueConfig;
  error: string | null;
}

/**
 * `GetTemplateConfigFromDefaultBranch` (template.go:158-181) + `GetTemplateConfig`
 * (:51-99) over the engine: the 4 candidate paths, `.yaml` before `.yml`, the
 * 1 MiB truncation, the validation — the DEFAULT config pairs with every
 * failure (never a nil config upstream). `tip === null` is the
 * GetBranchCommit failure arm (the default config plus the branch error).
 */
export async function issueConfigFromDefaultBranch(reads: TemplateTreeReads, tip: string | null, defaultBranch: string): Promise<IssueConfigResult> {
  if (tip === null) {
    return {
      config: { ...DEFAULT_ISSUE_CONFIG, contactLinks: [] },
      error: `branch does not exist [name: ${defaultBranch}]`,
    };
  }
  for (const base of TEMPLATE_CONFIG_CANDIDATES) {
    for (const extension of [".yaml", ".yml"]) {
      const blob = await reads.readBlob(tip, base + extension);
      if (blob === null) continue;
      const source = new TextDecoder().decode(blob.data).slice(0, TEMPLATE_READ_LIMIT);
      const parsed = parseIssueConfig(source);
      if (parsed.error !== null) return { config: { ...DEFAULT_ISSUE_CONFIG, contactLinks: [] }, error: parsed.error };
      const validationError = validateIssueConfig(parsed.config);
      if (validationError !== null) return { config: { ...DEFAULT_ISSUE_CONFIG, contactLinks: [] }, error: validationError };
      return { config: parsed.config, error: null };
    }
  }
  return { config: { ...DEFAULT_ISSUE_CONFIG, contactLinks: [] }, error: null };
}

/**
 * `HasTemplatesOrContactLinks` (template.go:182-190): any valid template OR
 * any parsed contact link. The config ERROR arm yields the default config
 * (zero links) — the caller's errors-map flash shows the parse trouble
 * separately.
 */
export async function hasTemplatesOrContactLinks(reads: TemplateTreeReads, tip: string | null, defaultBranch: string): Promise<boolean> {
  const parsed = await parseTemplatesFromDefaultBranch(reads, tip);
  if (parsed.templates.length > 0) return true;
  const { config } = await issueConfigFromDefaultBranch(reads, tip, defaultBranch);
  return config.contactLinks.length > 0;
}

// ---------------------------------------------------------------------------
// The new-issue arms (routers/web/repo/issue_new.go)
// ---------------------------------------------------------------------------

/** The prefill filter keys (`issuePrefillQuery`, issue_page_meta.go:137-153). */
const PREFILL_KEYS = ["label", "labels", "milestone", "project", "assignee"] as const;

/**
 * `issuePrefillQuery` (issue_page_meta.go:144-153): the incoming query
 * narrowed to the five prefill keys (non-empty values only), re-encoded —
 * the string every choose-page card appends after `template={file}&`.
 */
export function issuePrefillQuery(url: URL): string {
  const query = new URLSearchParams();
  for (const key of PREFILL_KEYS) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== "") query.set(key, value);
  }
  return query.toString();
}

// ---------------------------------------------------------------------------
// RenderToMarkdown (modules/issue/template/template.go:305-492 — byte contract)
// ---------------------------------------------------------------------------

/** The form-values view: `url.Values.Get` — the FIRST value of the key. */
export interface FormValues {
  get(name: string): string | null;
}

function fieldLabel(field: IssueFormField): string {
  const label = field.attributes["label"];
  return typeof label === "string" ? label : "";
}

/** `HideLabel` (template.go:396-404): markdown always; else `hide_label`. */
function hideLabel(field: IssueFormField): boolean {
  if (field.type === "markdown") return true;
  return field.attributes["hide_label"] === true;
}

function fieldRender(field: IssueFormField): string {
  const render = field.attributes["render"];
  return typeof render === "string" ? render : "";
}

/** `Value` (template.go:413-415): TrimSpace(Get("form-field-"+ID)). */
function fieldValue(field: IssueFormField, values: FormValues): string {
  return (values.get(`form-field-${field.id}`) ?? "").trim();
}

/** A checkbox option's visible list (template.go:466-480). */
function optionVisibleInContent(option: Record<string, unknown>): boolean {
  if ("visible" in option) {
    const visibility = option["visible"];
    if (Array.isArray(visibility)) {
      return visibility.some((entry) => entry === "content");
    }
  }
  return true;
}

/**
 * `minQuotes` (template.go:482-492): 3 or more back-quotes; the longest run
 * wins plus one. Go's POSIX pattern anchors at TEXT START (no (?m) flag) —
 * only a LEADING run of the value escalates the fence.
 */
function minQuotes(value: string): string {
  let ret = "```";
  const match = /^`{3,}/.exec(value);
  if (match !== null && match[0].length >= ret.length) ret = match[0] + "`";
  return ret;
}

const NO_RESPONSE = "_No response_\n";

/**
 * `RenderToMarkdown` (template.go:305-320 + valuedField.WriteTo :327-387):
 * the issue BODY a yaml template's form values render to. Fields with an
 * empty id or hidden-in-content skip; every field ends with a blank line.
 */
export function renderTemplateToMarkdown(template: IssueTemplate, values: FormValues): string {
  let out = "";
  for (const field of template.fields) {
    if (field.id === "" || !visibleInContent(field)) continue;
    if (!hideLabel(field)) out += `### ${fieldLabel(field)}\n\n`;
    switch (field.type) {
      case "checkboxes": {
        const options = Array.isArray(field.attributes["options"])
          ? (field.attributes["options"] as unknown[]).entries()
          : [].entries();
        for (const [index, option] of options) {
          const dict = option as Record<string, unknown>;
          if (option === null || typeof option !== "object" || Array.isArray(option)) continue;
          if (!optionVisibleInContent(dict)) continue;
          const checked = values.get(`form-field-${field.id}-${index}`) === "on" ? "x" : " ";
          const label = typeof dict["label"] === "string" ? dict["label"] : "";
          out += `- [${checked}] ${label}\n`;
        }
        break;
      }
      case "dropdown": {
        const checks: string[] = [];
        const options = Array.isArray(field.attributes["options"]) ? (field.attributes["options"] as unknown[]) : [];
        const selected = (values.get(`form-field-${field.id}`) ?? "").split(",");
        for (const [index, option] of options.entries()) {
          if (selected.includes(String(index))) {
            checks.push(typeof option === "string" ? option : "");
          }
        }
        if (checks.length > 0) {
          if (field.attributes["list"] === true) {
            for (const check of checks) out += `- ${check}\n`;
          } else {
            out += `${checks.join(", ")}\n`;
          }
        } else {
          out += NO_RESPONSE;
        }
        break;
      }
      case "input": {
        const value = fieldValue(field, values);
        out += value === "" ? NO_RESPONSE : `${value}\n`;
        break;
      }
      case "textarea": {
        const value = fieldValue(field, values);
        if (value === "") {
          out += NO_RESPONSE;
        } else {
          const render = fieldRender(field);
          if (render !== "") {
            const quotes = minQuotes(value);
            out += `${quotes}${render}\n${value}\n${quotes}\n`;
          } else {
            out += `${value}\n`;
          }
        }
        break;
      }
      case "markdown": {
        const value = field.attributes["value"];
        if (typeof value === "string") out += `${value}\n`;
        break;
      }
    }
    out += "\n";
  }
  return out;
}

// ---------------------------------------------------------------------------
// The API wire projection (structs/issue.go json tags — the future
// /issue_templates shape; the route itself lands with the API tier)
// ---------------------------------------------------------------------------

export function toApiIssueTemplate(template: IssueTemplate): Record<string, unknown> {
  return {
    name: template.name,
    title: template.title,
    about: template.about,
    labels: template.labels,
    assignees: template.assignees,
    ref: template.ref,
    content: template.content,
    body: template.fields.map((field) => ({
      type: field.type,
      id: field.id,
      attributes: field.attributes,
      validations: field.validations,
      visible: field.visible,
    })),
    file_name: template.fileName,
  };
}
