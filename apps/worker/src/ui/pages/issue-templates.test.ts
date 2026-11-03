/**
 * The ISSUE-TEMPLATE parser grammar's unit suite (pages/issue-templates.ts —
 * the modules/issue/template + services/issue/template.go port; SPEC-0005
 * §11 carries the derivation). Pure unit — the discovery/config walks run
 * against stub tree reads, no bindings, no D1.
 *
 * Coverage: the file-form rules (CouldBe), the markdown front matter
 * (separator grammar, the silent generic-template fallback), the yaml form
 * (defaults, the strict scalar types), the string-slice dual form, the
 * validation FIRST-error matrix with upstream's exact messages and
 * `body[i](type)` positions, the RenderToMarkdown byte contract (all five
 * field types, the minQuotes text-start anchor quirk), the config
 * validation messages, the discovery walk precedence, and the prefill
 * query filter.
 */

import { describe, expect, it } from "vitest";

import {
  couldBe,
  extractFrontMatter,
  issueTemplateType,
  issuePrefillQuery,
  normalizeTemplateRef,
  parseIssueConfig,
  parseTemplatesFromDefaultBranch,
  renderTemplateToMarkdown,
  unmarshalIssueTemplate,
  validateIssueConfig,
  validateIssueTemplate,
  visibleInContent,
  visibleOnForm,
  type IssueFormField,
  type TemplateTreeReads,
} from "./issue-templates";

// ---------------------------------------------------------------------------
// stub tree reads (the TemplateTreeReads slice)
// ---------------------------------------------------------------------------

interface StubFile {
  path: string;
  content: string;
}

/** A stub over `listTree` + `readBlob`: dirs are the distinct first-path
 *  segments of the files; entries carry their byte sizes. */
function stubReads(files: StubFile[]): TemplateTreeReads & { touched: string[] } {
  const touched: string[] = [];
  return {
    touched,
    listTree: (_ref, path) => {
      touched.push(`tree:${path ?? ""}`);
      const prefix = path === undefined || path === "" ? "" : `${path}/`;
      const names = new Set<string>();
      for (const file of files) {
        if (file.path.startsWith(prefix)) {
          names.add(file.path.slice(prefix.length).split("/")[0] as string);
        }
      }
      if (names.size === 0) return Promise.resolve(null);
      return Promise.resolve({
        oid: "stub",
        entries: [...names].map((name) => ({
          name,
          mode: "100644",
          type: "blob" as const,
          oid: `oid-${name}`,
          size: files.find((file) => file.path === `${prefix}${name}`)?.content.length ?? 0,
        })),
      });
    },
    readBlob: (_ref, path) => {
      touched.push(`blob:${path}`);
      const file = files.find((entry) => entry.path === path);
      if (file === undefined) return Promise.resolve(null);
      return Promise.resolve({ oid: `oid-${path}`, mode: "100644", data: new TextEncoder().encode(file.content) });
    },
  };
}

// ---------------------------------------------------------------------------
// 1. CouldBe / Type (structs/issue.go:268-279)
// ---------------------------------------------------------------------------

describe("the file-form rules (IssueTemplate.Type)", () => {
  it(".md is the markdown form, .yaml/.yml the yaml form", () => {
    expect(issueTemplateType("bug.md")).toBe("md");
    expect(issueTemplateType("bug.yaml")).toBe("yaml");
    expect(issueTemplateType("bug.yml")).toBe("yaml");
    expect(issueTemplateType(".gitea/ISSUE_TEMPLATE/bug_report.md")).toBe("md");
  });

  it("config.yaml/config.yml are excluded whatever the directory (the special config file)", () => {
    expect(issueTemplateType(".gitea/ISSUE_TEMPLATE/config.yaml")).toBe("");
    expect(issueTemplateType("config.yml")).toBe("");
    // a config name in a sub-path still matches by BASE name
    expect(issueTemplateType("some/dir/config.yaml")).toBe("");
  });

  it("unknown extensions are skipped (CouldBe false)", () => {
    expect(issueTemplateType("bug.txt")).toBe("");
    expect(issueTemplateType("ISSUE_TEMPLATE")).toBe("");
    expect(issueTemplateType("bug.md.yaml")).toBe("yaml");
    expect(couldBe("bug.md")).toBe(true);
    expect(couldBe("bug.txt")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. the markdown front matter (markdown/meta.go)
// ---------------------------------------------------------------------------

describe("the front-matter separator grammar (isYAMLSeparator)", () => {
  it("three or more dashes, optional surrounding spaces", () => {
    const template = "---\nname: x\n---\nbody";
    const extracted = extractFrontMatter(template);
    expect(extracted).toEqual({ front: "name: x\n", body: "body" });
    expect(extractFrontMatter("----\nname: x\n----\nbody")?.front).toBe("name: x\n");
    expect(extractFrontMatter("  ---  \nname: x\n---\nbody")?.front).toBe("name: x\n");
  });

  it("fewer than three dashes is not a separator; a non-separator first line fails", () => {
    expect(extractFrontMatter("--\nname: x\n--\nbody")).toBeNull();
    expect(extractFrontMatter("hello\n---\nx\n---\nbody")).toBeNull();
    expect(extractFrontMatter("```yaml\n---\nx\n---\nbody")).toBeNull();
  });

  it("an empty front matter is the failure arm (meta.go could-not-determine)", () => {
    expect(extractFrontMatter("---\n---\nbody")).toBeNull();
  });

  it("a file ending at the closing separator has an empty body", () => {
    expect(extractFrontMatter("---\nname: x\n---")).toEqual({ front: "name: x\n", body: "" });
  });
});

// ---------------------------------------------------------------------------
// 3. the markdown template form (unmarshal.go:97-120)
// ---------------------------------------------------------------------------

describe("the markdown template form", () => {
  it("front matter keys land; the body is the content; labels accept both forms", () => {
    const parsed = unmarshalIssueTemplate(
      "bug.md",
      "---\nname: Bug Report\ntitle: '[Bug] '\ndescription: the description\nabout: report a bug\nlabels: bug, ui\nassignees:\n  - alice\n---\n# steps to reproduce\n",
    );
    if ("error" in parsed) throw new Error(parsed.error);
    const template = parsed.template;
    expect(template.name).toBe("Bug Report");
    expect(template.title).toBe("[Bug] ");
    expect(template.about).toBe("report a bug");
    expect(template.labels).toEqual(["bug", "ui"]); // the scalar comma-split form
    expect(template.assignees).toEqual(["alice"]); // the sequence form
    expect(template.content).toBe("# steps to reproduce\n");
    expect(template.fileName).toBe("bug.md");
  });

  it("a MISSING about falls back to `description` (the compatible spelling)", () => {
    const parsed = unmarshalIssueTemplate("x.md", "---\nname: N\ndescription: desc wins\n---\nbody");
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.template.about).toBe("desc wins");
  });

  it("NO front matter is the silent generic template (name = base, about = the 80-width ellipsis)", () => {
    const long = "x".repeat(200);
    const parsed = unmarshalIssueTemplate(".gitea/ISSUE_TEMPLATE/plain.md", `# just markdown\n\n${long}\n`);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.template.name).toBe("plain.md");
    expect(parsed.template.content).toBe(`# just markdown\n\n${long}\n`);
    expect(parsed.template.about.length).toBeLessThanOrEqual(81);
    expect(parsed.template.about.endsWith("…")).toBe(true);
  });

  it("BROKEN front-matter yaml is the same fallback (never an error)", () => {
    const parsed = unmarshalIssueTemplate("broken.md", "---\nname: [unclosed\n---\nbody");
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.template.name).toBe("broken.md");
    expect(parsed.template.content).toContain("body");
  });

  it("a WRONG-TYPED front key (labels as a map) is the fallback too — ExtractMetadata's error arm", () => {
    const parsed = unmarshalIssueTemplate("wrongtype.md", "---\nname: N\nabout: A\nlabels:\n  a: b\n---\nbody");
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.template.name).toBe("wrongtype.md"); // the generic shape, not the parsed name
  });

  it("front matter present but name EMPTY is a validation error (not the fallback)", () => {
    const parsed = unmarshalIssueTemplate("x.md", "---\nabout: A\n---\nbody");
    if (!("error" in parsed)) throw new Error("expected a validation error");
    expect(parsed.error).toBe("'name' is required");
  });
});

// ---------------------------------------------------------------------------
// 4. the yaml template form (unmarshal.go:121-144)
// ---------------------------------------------------------------------------

describe("the yaml template form", () => {
  const VALID_BODY = `name: Form
about: a form template
body:
  - type: markdown
    attributes:
      value: intro text
  - type: input
    id: summary
    attributes:
      label: Summary
    validations:
      required: true
`;

  it("defaults: missing ids fill by index; visible defaults per type", () => {
    const parsed = unmarshalIssueTemplate(
      "form.yaml",
      `name: F\nabout: A\nbody:\n  - type: input\n    attributes:\n      label: L\n  - type: markdown\n    attributes:\n      value: v\n`,
    );
    if ("error" in parsed) throw new Error(parsed.error);
    const [input, markdown] = parsed.template.fields;
    expect(input?.id).toBe("0"); // the index default
    expect(input?.visible).toEqual(["form", "content"]);
    expect(markdown?.id).toBe("1");
    expect(markdown?.visible).toEqual(["form"]); // markdown is not submitted by default
  });

  it("an explicit visible list wins over the defaults", () => {
    const parsed = unmarshalIssueTemplate(
      "form.yaml",
      `name: F\nabout: A\nbody:\n  - type: input\n    id: x\n    attributes:\n      label: L\n    visible: [form]\n`,
    );
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.template.fields[0]?.visible).toEqual(["form"]);
  });

  it("broken yaml is the `yaml unmarshal:` error", () => {
    const parsed = unmarshalIssueTemplate("bad.yaml", "name: [unclosed\n");
    if (!("error" in parsed)) throw new Error("expected an error");
    expect(parsed.error.startsWith("yaml unmarshal: ")).toBe(true);
  });

  it("a scalar document is the type error arm; an EMPTY document parses to the empty template (then fails validation)", () => {
    const scalar = unmarshalIssueTemplate("scalar.yaml", "just a string\n");
    if (!("error" in scalar)) throw new Error("expected an error");
    expect(scalar.error.startsWith("yaml unmarshal: ")).toBe(true);
    const empty = unmarshalIssueTemplate("empty.yaml", "");
    if (!("error" in empty)) throw new Error("expected the validation error");
    expect(empty.error).toBe("'name' is required");
  });

  it("a wrong-typed scalar (name as a number) is the yaml error arm", () => {
    const parsed = unmarshalIssueTemplate("num.yaml", "name: 42\nabout: A\n");
    if (!("error" in parsed)) throw new Error("expected an error");
    expect(parsed.error.startsWith("yaml unmarshal: ")).toBe(true);
  });

  it("the happy path parses the whole body (the SPEC §11 example shape)", () => {
    const parsed = unmarshalIssueTemplate("form.yaml", VALID_BODY);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.template.name).toBe("Form");
    expect(parsed.template.fields).toHaveLength(2);
    expect(parsed.template.fields[0]?.type).toBe("markdown");
    expect(parsed.template.fields[1]?.id).toBe("summary");
    expect(parsed.template.fields[1]?.validations["required"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. the validation matrix (modules/issue/template/template.go — exact messages)
// ---------------------------------------------------------------------------

describe("the validation matrix (first error wins, upstream messages)", () => {
  const field = (overrides: Partial<IssueFormField>): IssueFormField => ({
    type: "input",
    id: "f1",
    attributes: { label: "Label" },
    validations: {},
    visible: [],
    ...overrides,
  });

  it("metadata: name/about required, trimmed", () => {
    expect(validateIssueTemplate({ name: "  ", title: "", about: "a", labels: [], assignees: [], ref: "", content: "", fields: [], fileName: "f.yaml" })).toBe(
      "'name' is required",
    );
    expect(validateIssueTemplate({ name: "n", title: "", about: "", labels: [], assignees: [], ref: "", content: "", fields: [], fileName: "f.yaml" })).toBe(
      "'about' is required",
    );
  });

  it("empty body -> 'body' is required", () => {
    const error = validateIssueTemplate({ name: "n", title: "", about: "a", labels: [], assignees: [], ref: "", content: "", fields: [], fileName: "f.yaml" });
    expect(error).toBe("'body' is required");
  });

  it("id: required, charset, uniqueness — in field order", () => {
    const template = {
      name: "n",
      title: "",
      about: "a",
      labels: [],
      assignees: [],
      ref: "",
      content: "",
      fileName: "f.yaml",
      fields: [field({ id: "" }), field({ id: "bad id!" }), field({ id: "dup" }), field({ id: "dup" })],
    };
    expect(validateIssueTemplate(template)).toBe("body[0](input): 'id' is required");
    template.fields = [field({ id: "bad id!" })];
    expect(validateIssueTemplate(template)).toBe("body[0](input): 'id' should contain only alphanumeric, '-' and '_'");
    template.fields = [field({ id: "dup" }), field({ id: "dup" })];
    expect(validateIssueTemplate(template)).toBe("body[1](input): 'id' should be unique");
  });

  it("label required unless markdown; markdown still requires its value; position string carries the type", () => {
    const template = { name: "n", title: "", about: "a", labels: [], assignees: [], ref: "", content: "", fileName: "f.yaml", fields: [field({ attributes: {} })] };
    expect(validateIssueTemplate(template)).toBe("body[0](input): 'label' is required");
    template.fields = [field({ type: "markdown", id: "md", attributes: {} })];
    expect(validateIssueTemplate(template)).toBe("body[0](markdown): 'value' is required"); // markdown skips the LABEL check, not the value
    template.fields = [field({ type: "markdown", id: "md", attributes: { value: "v" } })];
    expect(validateIssueTemplate(template)).toBe(null);
  });

  it("markdown: value required", () => {
    const template = { name: "n", title: "", about: "a", labels: [], assignees: [], ref: "", content: "", fileName: "f.yaml", fields: [field({ type: "markdown", id: "md", attributes: {} })] };
    expect(validateIssueTemplate(template)).toBe("body[0](markdown): 'value' is required");
    template.fields = [field({ type: "markdown", id: "md", attributes: { value: 42 } })];
    expect(validateIssueTemplate(template)).toBe("body[0](markdown): 'value' should be a string");
  });

  it("input: is_number bool, regex string", () => {
    const template = {
      name: "n",
      title: "",
      about: "a",
      labels: [],
      assignees: [],
      ref: "",
      content: "",
      fileName: "f.yaml",
      fields: [field({ validations: { is_number: "yes" } })],
    };
    expect(validateIssueTemplate(template)).toBe("body[0](input): 'is_number' should be a bool");
    template.fields = [field({ validations: { regex: 7 } })];
    expect(validateIssueTemplate(template)).toBe("body[0](input): 'regex' should be a string");
  });

  it("dropdown: options must be a non-empty string array; default an in-range int; option errors carry option[j]", () => {
    const base = { name: "n", title: "", about: "a", labels: [], assignees: [], ref: "", content: "", fileName: "f.yaml" };
    const template = { ...base, fields: [field({ type: "dropdown", attributes: { label: "L" } })] };
    expect(validateIssueTemplate(template)).toBe("body[0](dropdown): 'options' is required and should be an array");
    template.fields = [field({ type: "dropdown", attributes: { label: "L", options: [1, 2] } })];
    expect(validateIssueTemplate(template)).toBe("body[0](dropdown), option[0]: should be a string");
    template.fields = [field({ type: "dropdown", attributes: { label: "L", options: ["a"], default: 1 } })];
    expect(validateIssueTemplate(template)).toBe("body[0](dropdown): the value of 'default' is out of range");
    template.fields = [field({ type: "dropdown", attributes: { label: "L", options: ["a"], default: 1.5 } })];
    expect(validateIssueTemplate(template)).toBe("body[0](dropdown): 'default' should be an int");
    template.fields = [field({ type: "dropdown", attributes: { label: "L", options: ["a"], default: 0 } })];
    expect(validateIssueTemplate(template)).toBe(null);
  });

  it("checkboxes: dict options with required string labels; visible lists of form/content; hidden-required refused", () => {
    const base = { name: "n", title: "", about: "a", labels: [], assignees: [], ref: "", content: "", fileName: "f.yaml" };
    const template = { ...base, fields: [field({ type: "checkboxes", attributes: { label: "L", options: ["str"] } })] };
    expect(validateIssueTemplate(template)).toBe("body[0](checkboxes), option[0]: should be a dictionary");
    template.fields = [field({ type: "checkboxes", attributes: { label: "L", options: [{}] } })];
    expect(validateIssueTemplate(template)).toBe("body[0](checkboxes), option[0]: 'label' is required and should be a string");
    template.fields = [field({ type: "checkboxes", attributes: { label: "L", options: [{ label: "x", visible: "form" }] } })];
    expect(validateIssueTemplate(template)).toBe("body[0](checkboxes), option[0]: 'visible' should be list");
    template.fields = [field({ type: "checkboxes", attributes: { label: "L", options: [{ label: "x", visible: ["elsewhere"] }] } })];
    expect(validateIssueTemplate(template)).toBe("body[0](checkboxes), option[0]: 'visible' list can only contain strings of 'form' and 'content'");
    template.fields = [field({ type: "checkboxes", attributes: { label: "L", options: [{ label: "x", required: "yes" }] } })];
    expect(validateIssueTemplate(template)).toBe("body[0](checkboxes), option[0]: 'required' should be a bool");
    template.fields = [field({ type: "checkboxes", attributes: { label: "L", options: [{ label: "x", required: true, visible: ["content"] }] } })];
    expect(validateIssueTemplate(template)).toBe("body[0](checkboxes), option[0]: can not require a hidden checkbox");
    template.fields = [field({ type: "checkboxes", attributes: { label: "L", options: [{ label: "x", required: true, visible: ["form"] }] } })];
    expect(validateIssueTemplate(template)).toBe(null);
  });

  it("unknown types refuse; required-on-hidden refuses", () => {
    const base = { name: "n", title: "", about: "a", labels: [], assignees: [], ref: "", content: "", fileName: "f.yaml" };
    const template = { ...base, fields: [field({ type: "slider" })] };
    expect(validateIssueTemplate(template)).toBe("body[0](slider): unknown type");
    template.fields = [field({ visible: ["content"], validations: { required: true } })];
    expect(validateIssueTemplate(template)).toBe("body[0](input): can not require a hidden field");
  });

  it("the visibility helpers (structs/issue.go:165-181)", () => {
    const empty: IssueFormField = { type: "input", id: "x", attributes: {}, validations: {}, visible: [] };
    expect(visibleOnForm(empty)).toBe(true);
    expect(visibleInContent(empty)).toBe(true); // non-markdown default
    const markdown: IssueFormField = { ...empty, type: "markdown" };
    expect(visibleInContent(markdown)).toBe(false); // the markdown exception
    const formOnly: IssueFormField = { ...empty, visible: ["form"] };
    expect(visibleInContent(formOnly)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. RenderToMarkdown (template.go:305-492 — the byte contract)
// ---------------------------------------------------------------------------

describe("RenderToMarkdown (the byte contract)", () => {
  const values = (map: Record<string, string>): { get: (name: string) => string | null } => ({
    get: (name) => (name in map ? map[name]! : null),
  });

  it("input: the trimmed value or _No response_", () => {
    const template = {
      name: "n",
      title: "",
      about: "a",
      labels: [],
      assignees: [],
      ref: "",
      content: "",
      fileName: "f.yaml",
      fields: [
        { type: "input", id: "one", attributes: { label: "One" }, validations: {}, visible: [] },
        { type: "input", id: "two", attributes: { label: "Two" }, validations: {}, visible: [] },
      ],
    };
    const rendered = renderTemplateToMarkdown(template, values({ "form-field-one": "  padded  " }));
    expect(rendered).toBe("### One\n\npadded\n\n### Two\n\n_No response_\n\n");
  });

  it("checkboxes: [x]/[ ] per option index; content-hidden options skip", () => {
    const template = {
      name: "n",
      title: "",
      about: "a",
      labels: [],
      assignees: [],
      ref: "",
      content: "",
      fileName: "f.yaml",
      fields: [
        {
          type: "checkboxes",
          id: "checks",
          attributes: {
            label: "Checks",
            options: [
              { label: "first" },
              { label: "second" },
              { label: "hidden", visible: ["form"] }, // content-hidden
            ],
          },
          validations: {},
          visible: [],
        },
      ],
    };
    const rendered = renderTemplateToMarkdown(template, values({ "form-field-checks-0": "on", "form-field-checks-1": "" }));
    expect(rendered).toBe("### Checks\n\n- [x] first\n- [ ] second\n\n");
  });

  it("dropdown: the comma-split index contract; list mode one-per-line; none -> _No response_", () => {
    const mk = (list: boolean) => ({
      name: "n",
      title: "",
      about: "a",
      labels: [],
      assignees: [],
      ref: "",
      content: "",
      fileName: "f.yaml",
      fields: [
        {
          type: "dropdown",
          id: "drop",
          attributes: { label: "Drop", options: ["a", "b", "c"], multiple: true, ...(list ? { list: true } : {}) },
          validations: {},
          visible: [],
        },
      ],
    });
    expect(renderTemplateToMarkdown(mk(false), values({ "form-field-drop": "0,2" }))).toBe("### Drop\n\na, c\n\n");
    expect(renderTemplateToMarkdown(mk(true), values({ "form-field-drop": "0,2" }))).toBe("### Drop\n\n- a\n- c\n\n");
    expect(renderTemplateToMarkdown(mk(false), values({}))).toBe("### Drop\n\n_No response_\n\n");
  });

  it("textarea: bare value, the render fence, and the minQuotes text-start anchor", () => {
    const mk = (render: string) => ({
      name: "n",
      title: "",
      about: "a",
      labels: [],
      assignees: [],
      ref: "",
      content: "",
      fileName: "f.yaml",
      fields: [{ type: "textarea", id: "logs", attributes: { label: "Logs", render }, validations: {}, visible: [] }],
    });
    // bare
    expect(renderTemplateToMarkdown(mk(""), values({ "form-field-logs": "the logs" }))).toBe("### Logs\n\nthe logs\n\n");
    // empty
    expect(renderTemplateToMarkdown(mk("go"), values({}))).toBe("### Logs\n\n_No response_\n\n");
    // render + leading ``` escalates the fence to ````
    expect(renderTemplateToMarkdown(mk("go"), values({ "form-field-logs": "```\ncode\n```" }))).toBe(
      "### Logs\n\n````go\n```\ncode\n```\n````\n\n",
    );
    // an INTERIOR ``` run does NOT escalate (Go's POSIX ^ anchors at text start)
    expect(renderTemplateToMarkdown(mk("go"), values({ "form-field-logs": "intro\n```\ncode" }))).toBe(
      "### Logs\n\n```go\nintro\n```\ncode\n```\n\n",
    );
  });

  it("markdown fields are form-only by default (skipped in content); an explicit content visibility renders; hide_label suppresses; hidden-in-content fields skip", () => {
    const template = {
      name: "n",
      title: "",
      about: "a",
      labels: [],
      assignees: [],
      ref: "",
      content: "",
      fileName: "f.yaml",
      fields: [
        // the unmarshal default for markdown is [form] — form-only, content skips it
        { type: "markdown", id: "intro", attributes: { value: "**skipped** intro" }, validations: {}, visible: [] },
        // an explicit [form, content] markdown renders under NO header
        { type: "markdown", id: "kept", attributes: { value: "**bold** intro" }, validations: {}, visible: ["form", "content"] },
        { type: "input", id: "h", attributes: { label: "H", hide_label: true }, validations: {}, visible: [] },
        { type: "input", id: "gone", attributes: { label: "Gone" }, validations: {}, visible: ["form"] },
      ],
    };
    const rendered = renderTemplateToMarkdown(template, values({ "form-field-h": "visible" }));
    expect(rendered).toBe("**bold** intro\n\nvisible\n\n"); // no ### header for either; `intro` and `gone` skipped
  });
});

// ---------------------------------------------------------------------------
// 7. the config walk pieces (services/issue/template.go:79-117)
// ---------------------------------------------------------------------------

describe("the issue config", () => {
  it("the canonical shape parses; validation messages are upstream-exact", () => {
    const parsed = parseIssueConfig('blank_issues_enabled: false\ncontact_links:\n  - name: Chat\n    url: "https://example.com/chat"\n    about: ask here\n');
    expect(parsed.error).toBe(null);
    expect(parsed.config.blankIssuesEnabled).toBe(false);
    expect(parsed.config.contactLinks).toEqual([{ name: "Chat", url: "https://example.com/chat", about: "ask here" }]);
    expect(validateIssueConfig(parsed.config)).toBe(null);
  });

  it("the contact-link errors: position, missing keys, URL parse", () => {
    expect(validateIssueConfig({ blankIssuesEnabled: true, contactLinks: [{ name: "", url: "https://x", about: "a" }] })).toBe(
      "contact_link at position 1 is missing name key",
    );
    expect(validateIssueConfig({ blankIssuesEnabled: true, contactLinks: [{ name: "n", url: "", about: "a" }] })).toBe(
      "contact_link at position 1 is missing url key",
    );
    expect(validateIssueConfig({ blankIssuesEnabled: true, contactLinks: [{ name: "n", url: "https://x", about: "" }] })).toBe(
      "contact_link at position 1 is missing about key",
    );
    expect(validateIssueConfig({ blankIssuesEnabled: true, contactLinks: [{ name: "n", url: "not a url", about: "a" }] })).toBe(
      "not a url is not a valid URL",
    );
  });

  it("structurally invalid yaml answers the DEFAULT config plus the generic error", () => {
    const parsed = parseIssueConfig("unknown_key: 1\n");
    expect(parsed.config).toEqual({ blankIssuesEnabled: true, contactLinks: [] });
    expect(parsed.error).not.toBe(null);
  });
});

// ---------------------------------------------------------------------------
// 8. the discovery walk (services/issue/template.go:113-155)
// ---------------------------------------------------------------------------

describe("the discovery walk (stub tree reads)", () => {
  it("walks the dir candidates IN ORDER and accumulates the valid templates", async () => {
    const reads = stubReads([
      { path: "ISSUE_TEMPLATE/root.md", content: "---\nname: Root\nabout: r\n---\nbody" },
      { path: ".gitea/ISSUE_TEMPLATE/gitea.yaml", content: "name: Gitea\nabout: g\nbody:\n  - type: input\n    id: i\n    attributes:\n      label: L\n" },
      { path: ".github/ISSUE_TEMPLATE/github.md", content: "---\nname: GitHub\nabout: gh\n---\nbody" },
      { path: "README.md", content: "# not a template dir entry" },
    ]);
    const result = await parseTemplatesFromDefaultBranch(reads, "tipoid");
    expect(result.templates.map((template) => template.name)).toEqual(["Root", "Gitea", "GitHub"]);
    expect(result.errors.size).toBe(0);
    // the 8 candidates were probed in order (the misses answered null)
    expect(reads.touched.filter((entry) => entry.startsWith("tree:")).slice(0, 8)).toEqual([
      "tree:ISSUE_TEMPLATE",
      "tree:issue_template",
      "tree:.gitea/ISSUE_TEMPLATE",
      "tree:.gitea/issue_template",
      "tree:.github/ISSUE_TEMPLATE",
      "tree:.github/issue_template",
      "tree:.gitlab/ISSUE_TEMPLATE",
      "tree:.gitlab/issue_template",
    ]);
  });

  it("invalid templates error per fullName without blocking siblings; config.yaml/yml skip", async () => {
    const reads = stubReads([
      {
        path: ".gitea/ISSUE_TEMPLATE/bad.yaml",
        content: "name: NoAbout\nbody:\n  - type: input\n    id: i\n    attributes:\n      label: L\n",
      },
      { path: ".gitea/ISSUE_TEMPLATE/good.md", content: "---\nname: Good\nabout: g\n---\nbody" },
      { path: ".gitea/ISSUE_TEMPLATE/config.yaml", content: "blank_issues_enabled: false\n" },
    ]);
    const result = await parseTemplatesFromDefaultBranch(reads, "tipoid");
    expect(result.templates.map((template) => template.name)).toEqual(["Good"]);
    expect([...result.errors.keys()]).toEqual([".gitea/ISSUE_TEMPLATE/bad.yaml"]);
    expect(result.errors.get(".gitea/ISSUE_TEMPLATE/bad.yaml")).toBe("'about' is required");
  });

  it("a null tip (empty repo / missing branch) is the empty result", async () => {
    const reads = stubReads([{ path: "ISSUE_TEMPLATE/x.md", content: "---\nname: X\nabout: x\n---\nb" }]);
    const result = await parseTemplatesFromDefaultBranch(reads, null);
    expect(result.templates).toEqual([]);
    expect(result.errors.size).toBe(0);
  });

  it("the ref normalization (:147-149)", () => {
    expect(normalizeTemplateRef("main")).toBe("refs/heads/main");
    expect(normalizeTemplateRef("refs/tags/v1")).toBe("refs/tags/v1");
  });
});

// ---------------------------------------------------------------------------
// 9. the prefill query filter (issue_page_meta.go:144-153)
// ---------------------------------------------------------------------------

describe("issuePrefillQuery (the five-key filter)", () => {
  it("keeps only label/labels/milestone/project/assignee, re-encoded", () => {
    const url = new URL("https://x.test/o/r/issues/new/choose?template=x.md&label=bug&title=keep%20out&milestone=3&bogus=1");
    expect(issuePrefillQuery(url)).toBe("label=bug&milestone=3");
  });

  it("the legacy `labels` fallback key carries; empty values drop", () => {
    const url = new URL("https://x.test/o/r/issues/new/choose?labels=bug,ui&assignee=&project=7");
    expect(issuePrefillQuery(url)).toBe("labels=bug%2Cui&project=7");
  });

  it("an all-empty incoming query filters to the empty string", () => {
    expect(issuePrefillQuery(new URL("https://x.test/o/r/issues/new/choose"))).toBe("");
  });
});
