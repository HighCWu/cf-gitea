/**
 * The ISSUE-TEMPLATE pipeline's ENGINE-BACKED matrix (SPEC-0005 §11 — the
 * discovery walk, the choose page's render arm, the new-issue form's
 * template prefill, and the POST's RenderToMarkdown round-trip, driven over
 * the MOUNTED uiRouter on the issue-new matrix pattern; the pure parser
 * grammar lives in issue-templates.test.ts, the seam pins in
 * issue-new-choose.test.ts).
 *
 * Fixtures (real engine content through the landed receive flow):
 *
 *   - alice/tplbox — `.gitea/ISSUE_TEMPLATE/bug.yaml` (the five field types
 *     + labels: [bug]), `.gitea/ISSUE_TEMPLATE/broken.yaml` (no about — the
 *     invalid-template notice), `.github/ISSUE_TEMPLATE/idea.md` (the md
 *     form + labels: [enhancement]); repo labels bug + enhancement seeded;
 *   - alice/tplroots — root `issue_template.md` only (the FALLBACK-chain
 *     arm: no `?template=`, the candidate list auto-picks it);
 *   - alice/tplpolicy — a dir template + `config.yml` with
 *     blank_issues_enabled: false and one contact link (the blank-issues
 *     303 + the choose cards' gates);
 *   - alice/tplcfgerr — a template + a config whose contact link misses the
 *     url key (the choose page's config-error warning);
 *   - alice/tplbox-priv — private twin (the §2.5 existence arms).
 *
 * Coverage here: the discovery matrix (md root/dir + yaml forms, the
 * invalid file erroring without blocking siblings), the choose render
 * (cards, blank gate, contact links, config error, the invalid-templates
 * notice), the prefill arms (?template= → title/labels/fields, the md body,
 * the ?label= precedence, the fallback chain, ?field:{id}), the POST
 * round-trip (template-file + form-field-* → the exact rendered markdown,
 * D1 read-back), and the blank-issues-disabled redirect.
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { createRepoLabel } from "../../api/services/labels";
import { issues, repositories, users } from "../../db/schema";
import { handlesUiRoute, parseUiRoute, uiRouter } from "../index";
import { uiEnv } from "../__tests__/harness";
import { ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import { mintSession, SESSION_COOKIE_NAME } from "../session";
import type { RepoRow } from "../ui-context";

async function fetchUi(path: string, init?: RequestInit): Promise<Response> {
  return uiRouter.fetch(new Request(`https://test.local${path}`, init), uiEnv);
}

const withCookie = (init: RequestInit, cookie: string): RequestInit => ({
  ...init,
  headers: { ...(init.headers as Record<string, string>), cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
});

const formPost = (fields: Record<string, string | string[]>): RequestInit => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const entry of Array.isArray(value) ? value : [value]) params.append(key, entry);
  }
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://test.local" },
    body: params.toString(),
  };
};

// --- fixtures -----------------------------------------------------------------

const BUG_YAML = `name: Bug Report
title: "[Bug] "
about: Report a reproducible bug
labels:
  - bug
ref: main
body:
  - type: markdown
    id: intro
    attributes:
      value: "Thanks for filling out this bug report!"
  - type: input
    id: summary
    attributes:
      label: Summary
      placeholder: one line
    validations:
      required: true
  - type: textarea
    id: steps
    attributes:
      label: Steps to reproduce
      render: shell
  - type: dropdown
    id: severity
    attributes:
      label: Severity
      options:
        - low
        - high
      multiple: true
  - type: checkboxes
    id: confirmations
    attributes:
      label: Confirmations
      options:
        - label: "I checked existing issues"
          required: true
        - label: "I read the docs"
`;

const BROKEN_YAML = `name: Broken
body:
  - type: input
    id: i
    attributes:
      label: L
`;

const IDEA_MD = `---
name: Idea
title: "[Idea] "
about: Suggest an idea
labels:
  - enhancement
---
### Describe the idea

tell us more
`;

const ROOT_MD = `---
name: Root Template
title: "[Root] "
about: the root fallback
---
### Root body

root content
`;

const ONLY_YAML = `name: Only
about: the only template
body:
  - type: input
    id: one
    attributes:
      label: One
`;

const CONFIG_DISABLED = `blank_issues_enabled: false
contact_links:
  - name: Chat
    url: "https://example.com/chat"
    about: ask here
`;

const CONFIG_BROKEN = `contact_links:
  - name: BrokenLink
    about: no url key
`;

const TPLBOX_COMMITS: SeedCommit[] = [
  {
    message: "seed: issue templates",
    time: 1_700_000_000,
    files: [
      { path: ".gitea/ISSUE_TEMPLATE/bug.yaml", content: BUG_YAML },
      { path: ".gitea/ISSUE_TEMPLATE/broken.yaml", content: BROKEN_YAML },
      { path: ".github/ISSUE_TEMPLATE/idea.md", content: IDEA_MD },
      { path: "README.md", content: "# tplbox\n" },
    ],
  },
];

const TPLROOTS_COMMITS: SeedCommit[] = [
  {
    message: "seed: root template",
    time: 1_700_000_000,
    files: [
      { path: "issue_template.md", content: ROOT_MD },
      { path: "README.md", content: "# tplroots\n" },
    ],
  },
];

const TPLPOLICY_COMMITS: SeedCommit[] = [
  {
    message: "seed: policy templates",
    time: 1_700_000_000,
    files: [
      { path: ".gitea/ISSUE_TEMPLATE/only.yaml", content: ONLY_YAML },
      { path: ".gitea/ISSUE_TEMPLATE/config.yml", content: CONFIG_DISABLED },
      { path: "README.md", content: "# tplpolicy\n" },
    ],
  },
];

const TPLCFGERR_COMMITS: SeedCommit[] = [
  {
    message: "seed: cfgerr templates",
    time: 1_700_000_000,
    files: [
      { path: ".gitea/ISSUE_TEMPLATE/one.yaml", content: ONLY_YAML },
      { path: ".gitea/ISSUE_TEMPLATE/config.yml", content: CONFIG_BROKEN },
      { path: "README.md", content: "# tplcfgerr\n" },
    ],
  },
];

interface TplFixture {
  aliceCookie: string;
  tplbox: RepoRow;
  bugLabelId: number;
  enhancementLabelId: number;
}

let fixture: TplFixture | null = null;

async function repoRow(owner: string, slug: string): Promise<RepoRow> {
  const row =
    (await drizzle(env.DB)
      .select()
      .from(repositories)
      .where(and(eq(repositories.ownerNamespace, owner), eq(repositories.slug, slug)))
      .get()) ?? null;
  if (row === null) throw new Error(`${owner}/${slug} row missing`);
  return row;
}

async function ensureFixtures(): Promise<TplFixture> {
  if (fixture !== null) return fixture;
  await applyAuthD1Migrations();
  // SEQUENTIAL — every seed resolves the owner row first, so parallel calls
  // race the alice insert into a UNIQUE violation (the D1 UNIQUE arm).
  for (const spec of [
    { slug: "tplbox", commits: TPLBOX_COMMITS },
    { slug: "tplroots", commits: TPLROOTS_COMMITS },
    { slug: "tplpolicy", commits: TPLPOLICY_COMMITS },
    { slug: "tplcfgerr", commits: TPLCFGERR_COMMITS },
    {
      slug: "tplbox-priv",
      commits: [{ message: "seed", time: 1_700_000_000, files: [{ path: ".gitea/ISSUE_TEMPLATE/x.yaml", content: ONLY_YAML }] }] as SeedCommit[],
    },
  ]) {
    await ensureSeededRepo({ owner: "alice", slug: spec.slug, commits: spec.commits });
  }
  const tplbox = await repoRow("alice", "tplbox");
  const privRow = await repoRow("alice", "tplbox-priv");
  // The private twin is a direct D1 stamp (the issue-new matrix's archived-twin
  // pattern — RepoService always creates public).
  await drizzle(env.DB).update(repositories).set({ visibility: "private" }).where(eq(repositories.id, privRow.id));

  const alice = (await drizzle(env.DB).select().from(users).where(eq(users.usernameLower, "alice")).get()) ?? null;
  if (alice === null) throw new Error("alice row missing");
  const bugLabel = await createRepoLabel(env.DB, tplbox.id, {
    name: "bug",
    exclusive: false,
    color: "#ee0701",
    description: "Something is broken",
    isArchived: false,
    now: new Date(1_770_000_000_000),
  });
  const enhancementLabel = await createRepoLabel(env.DB, tplbox.id, {
    name: "enhancement",
    exclusive: false,
    color: "#84b6eb",
    description: "New feature or request",
    isArchived: false,
    now: new Date(1_770_000_000_000),
  });
  fixture = {
    aliceCookie: await mintSession(env.DB, alice.id),
    tplbox,
    bugLabelId: bugLabel.id,
    enhancementLabelId: enhancementLabel.id,
  };
  return fixture;
}

beforeAll(async () => {
  await ensureFixtures();
});

// --- 1. the choose page: discovery + render ----------------------------------

describe("the choose page's render arm (choose.tmpl over a real tree)", () => {
  it("the cards carry name/about + the template= links with the prefill tail; the notice lists the invalid file sorted", async () => {
    const response = await fetchUi("/alice/tplbox/issues/new/choose?label=ui&bogus=keepout");
    expect(response.status).toBe(200);
    const html = await response.text();
    // the template cards (discovery order: .gitea dir before .github dir)
    expect(html).toContain("Bug Report");
    expect(html).toContain("Report a reproducible bug");
    expect(html).toContain(`href="/alice/tplbox/issues/new?template=.gitea/ISSUE_TEMPLATE/bug.yaml&amp;label=ui"`);
    expect(html).toContain("Idea");
    expect(html).toContain(`href="/alice/tplbox/issues/new?template=.github/ISSUE_TEMPLATE/idea.md&amp;label=ui"`);
    // the broken file: the notice + the sorted detail line, NOT a card
    expect(html).toContain("Invalid templates have been ignored");
    expect(html).toContain("1 invalid template(s) found");
    expect(html).toContain(".gitea/ISSUE_TEMPLATE/broken.yaml: &#39;about&#39; is required");
    expect(html).not.toContain(">Broken</strong>"); // the invalid template is no card
    // the blank Default card (config default: blank enabled)
    expect(html).toContain("Default");
    expect(html).toContain("Create an issue from default template.");
    expect(html).toContain(`href="/alice/tplbox/issues/new?label=ui"`);
    // the filtered prefill query carried; the unfiltered key did not
    expect(html).not.toContain("bogus=keepout");
  });

  it("ANONYMOUS on a visible repo renders (the reqUnitIssuesReader posture — the page does not gate)", async () => {
    const response = await fetchUi("/alice/tplbox/issues/new/choose");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Bug Report");
  });

  it("the no-templates arm stays the 303 (a repo whose tree carries no template)", async () => {
    const response = await fetchUi("/alice/tplroots/issues/new/choose?title=kept");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/alice/tplroots/issues/new?title=kept");
  });

  it("a root-only template repo still 303s (the walk reads the DIR + config candidates only — the root issue_template.md is the new-issue form's fallback, never a choose card)", async () => {
    const response = await fetchUi("/alice/tplroots/issues/new/choose");
    expect(response.status).toBe(303);
  });

  it("a private repo 404-shells an anonymous viewer BEFORE any discovery could leak", async () => {
    const response = await fetchUi("/alice/tplbox-priv/issues/new/choose");
    expect(response.status).toBe(404);
  });

  it("the policy repo: the contact-link card + NO Default card (blank disabled) + the template card", async () => {
    const response = await fetchUi("/alice/tplpolicy/issues/new/choose");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Only");
    expect(html).toContain("Chat");
    expect(html).toContain("ask here");
    expect(html).toContain(`href="https://example.com/chat"`);
    // blank disabled: no Default card (blank_about only lives on it)
    expect(html).not.toContain("Create an issue from default template.");
    expect(html).not.toContain(`>Default</strong>`);
  });

  it("the config-error warning renders with the upstream message + the parse error", async () => {
    const response = await fetchUi("/alice/tplcfgerr/issues/new/choose");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("The issue config contains errors:");
    expect(html).toContain("contact_link at position 1 is missing url key");
    // the template card still renders (the config error never blocks templates)
    expect(html).toContain("Only");
  });
});

// --- 2. the new-issue GET: the prefill arms ----------------------------------

describe("the new-issue GET's template prefill (setTemplateIfExists)", () => {
  it("?template= loads the yaml form: the title prefill, the hidden template-file, the five field kinds, the label prefill", async () => {
    const fx = await ensureFixtures();
    const response = await fetchUi("/alice/tplbox/issues/new?template=.gitea/ISSUE_TEMPLATE/bug.yaml", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fx.aliceCookie}` },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    // title = the template title (no ?title=)
    expect(html).toContain(`value="[Bug] "`);
    // the fields arm replaces the plain textarea
    expect(html).toContain(`name="template-file" value=".gitea/ISSUE_TEMPLATE/bug.yaml"`);
    expect(html).not.toContain(`id="content"`);
    // input: placeholder + required
    expect(html).toContain(`name="form-field-summary"`);
    expect(html).toContain("one line");
    // textarea (the plain reduction) with the render attribute dropped
    expect(html).toContain(`name="form-field-steps"`);
    // dropdown: the native select with the indexed options
    expect(html).toContain(`name="form-field-severity"`);
    expect(html).toContain(`value="0"`);
    expect(html).toContain(">low</option>");
    expect(html).toContain(">high</option>");
    // checkboxes: required on option 0 only, the markdown labels rendered
    expect(html).toContain(`name="form-field-confirmations-0"`);
    expect(html).toContain(`name="form-field-confirmations-1"`);
    expect(html).toContain("I checked existing issues");
    // the markdown field's rendered intro
    expect(html).toContain("Thanks for filling out this bug report!");
    // the template's label matched the seeded repo label by NAME
    expect(html).toContain(`value="${String(fx.bugLabelId)}" checked`);
    expect(html).not.toContain(`value="${String(fx.enhancementLabelId)}" checked`);
  });

  it("?title= outranks the template title; ?label= outranks the template labels", async () => {
    const fx = await ensureFixtures();
    const response = await fetchUi("/alice/tplbox/issues/new?template=.gitea/ISSUE_TEMPLATE/bug.yaml&title=Query%20Wins&label=enhancement", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fx.aliceCookie}` },
    });
    const html = await response.text();
    expect(html).toContain('value="Query Wins"');
    expect(html).not.toContain('value="[Bug] "');
    expect(html).toContain(`value="${String(fx.enhancementLabelId)}" checked`);
    expect(html).not.toContain(`value="${String(fx.bugLabelId)}" checked`);
  });

  it("an md template prefills the PLAIN textarea (the content arm); the fallback chain auto-picks the root issue_template.md", async () => {
    const fx = await ensureFixtures();
    const withParam = await fetchUi("/alice/tplbox/issues/new?template=.github/ISSUE_TEMPLATE/idea.md", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fx.aliceCookie}` },
    });
    const ideaHtml = await withParam.text();
    expect(ideaHtml).toContain('value="[Idea] "');
    expect(ideaHtml).toContain(`id="content"`);
    expect(ideaHtml).toContain("### Describe the idea");
    expect(ideaHtml).toContain(`value="${String(fx.enhancementLabelId)}" checked`);

    const fallback = await fetchUi("/alice/tplroots/issues/new", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fx.aliceCookie}` },
    });
    const rootHtml = await fallback.text();
    expect(rootHtml).toContain('value="[Root] "');
    expect(rootHtml).toContain("root content");
  });

  it("an unknown ?template= falls through the fallbacks; tplbox has NO candidate-path file (its templates live in dirs), so the plain form answers", async () => {
    const fx = await ensureFixtures();
    const response = await fetchUi("/alice/tplbox/issues/new?template=nope.md", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fx.aliceCookie}` },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    // the 18 candidates are FILE paths (root + dotfile forms) — the dir
    // entries (bug.yaml / idea.md) are never candidates, upstream-exact
    expect(html).toContain('id="content"'); // the plain textarea
    expect(html).not.toContain('name="template-file"');
    expect(html).not.toContain('value="[Idea] "');
  });

  it("field:{id} overrides the input's default value", async () => {
    const fx = await ensureFixtures();
    const response = await fetchUi("/alice/tplbox/issues/new?template=.gitea/ISSUE_TEMPLATE/bug.yaml&field:summary=prefilled%20summary", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fx.aliceCookie}` },
    });
    const html = await response.text();
    expect(html).toContain('value="prefilled summary"');
  });

  it("the blank-issues-disabled 303: no ?template, dir-only templates, blank disabled → the choose page with the raw query", async () => {
    const fx = await ensureFixtures();
    const response = await fetchUi("/alice/tplpolicy/issues/new?label=ui&x=1", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fx.aliceCookie}` },
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/alice/tplpolicy/issues/new/choose?label=ui&x=1");
  });

  it("the invalid-template notice rides the new-issue GET too (the discovery errors merge)", async () => {
    const fx = await ensureFixtures();
    const response = await fetchUi("/alice/tplbox/issues/new", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${fx.aliceCookie}` },
    });
    const html = await response.text();
    expect(html).toContain("1 invalid template(s) found");
    expect(html).toContain(".gitea/ISSUE_TEMPLATE/broken.yaml");
  });
});

// --- 3. the POST round-trip: the rendered markdown ---------------------------

describe("the new-issue POST's RenderToMarkdown round-trip (issue_new.go:354-359)", () => {
  it("template-file + form-field-* render the EXACT upstream byte contract; labels carry; the D1 row reads back", async () => {
    const fx = await ensureFixtures();
    const expectedBody = [
      // intro (markdown, form-only default) is SKIPPED in content
      "### Summary\n\ncrash on save\n\n",
      "### Steps to reproduce\n\n````shell\n```\nrun\n```\n````\n\n",
      "### Severity\n\nlow, high\n\n",
      "### Confirmations\n\n- [x] I checked existing issues\n- [ ] I read the docs\n\n",
    ].join("");
    const response = await fetchUi("/alice/tplbox/issues/new", {
      ...withCookie(
        formPost({
          title: "crash on save",
          content: "",
          "template-file": ".gitea/ISSUE_TEMPLATE/bug.yaml",
          "form-field-summary": "crash on save",
          "form-field-steps": "```\nrun\n```",
          "form-field-severity": "0,1",
          "form-field-confirmations-0": "on",
          label_ids: String(fx.bugLabelId),
          milestone_id: "",
        }),
        fx.aliceCookie,
      ),
    });
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).toBe("/alice/tplbox/issues/1");
    const row = await drizzle(env.DB)
      .select()
      .from(issues)
      .where(and(eq(issues.repoId, fx.tplbox.id), eq(issues.index, 1)))
      .get();
    expect(row?.title).toBe("crash on save"); // the FN-5 property: title carries SQL "name"
    expect(row?.content).toBe(expectedBody);
  });

  it("a missing template-file (plain form) writes the submitted content verbatim", async () => {
    const fx = await ensureFixtures();
    const response = await fetchUi("/alice/tplroots/issues/new", {
      ...withCookie(formPost({ title: "plain", content: "the plain body" }), fx.aliceCookie),
    });
    expect(response.status).toBe(303);
    const rows = await drizzle(env.DB).select().from(issues).where(eq(issues.repoId, (await repoRow("alice", "tplroots")).id)).all();
    const row = rows.find((entry) => entry.title === "plain");
    expect(row?.content).toBe("the plain body");
  });

  it("a template-file naming a MISSING file falls back to the submitted content silently", async () => {
    const fx = await ensureFixtures();
    const response = await fetchUi("/alice/tplbox/issues/new", {
      ...withCookie(
        formPost({ title: "kept", content: "stand-in body", "template-file": ".gitea/ISSUE_TEMPLATE/vanished.yaml", "form-field-summary": "x" }),
        fx.aliceCookie,
      ),
    });
    expect(response.status).toBe(303);
    const rows = await drizzle(env.DB).select().from(issues).where(eq(issues.repoId, fx.tplbox.id)).all();
    const row = rows.find((entry) => entry.title === "kept");
    expect(row?.content).toBe("stand-in body");
  });
});

// --- 4. the parse-claim pins (the family union) -------------------------------

describe("the route claims", () => {
  it("the choose tail + the new-issue literal stay claimed beside each other", () => {
    expect(parseUiRoute("/alice/tplbox/issues/new/choose")).toMatchObject({ family: "issue-new-choose" });
    expect(parseUiRoute("/alice/tplbox/issues/new")).toMatchObject({ family: "issue-new" });
    expect(handlesUiRoute("/alice/tplbox/issues/new/choose")).toBe(true);
    expect(parseUiRoute("/alice/tplbox/issues/new/choose/extra")).toBeNull();
  });
});
