/**
 * `POST /markdown` + `POST /markdown/raw` (SPEC-0004 §2.4 rows renderMarkdown /
 * renderMarkdownRaw): renderer semantics mirrored from upstream
 * routers/common/markup.go (unit tests), the wire contract (401 for anonymous
 * callers via reqToken, text/html responses, 422 on unsupported modes /
 * malformed bodies), and the raw-variant LimitReader.
 *
 * No D1 reads — the router runs standalone on the stub auth resolver, like
 * api.test.ts.
 */

import { describe, expect, it } from "vitest";

import { ApiError } from "./errors";
import {
  MAX_DISPLAY_FILE_SIZE,
  parseRenderContext,
  readLimitedText,
  renderMarkdownToHtml,
} from "./services/markdown";
import { createApiRouter } from "./router";

const ORIGIN = "http://localhost:3000";

const render = (overrides: Partial<Parameters<typeof renderMarkdownToHtml>[0]> = {}): string =>
  renderMarkdownToHtml({
    text: "",
    mode: "",
    context: "",
    wiki: false,
    origin: ORIGIN,
    ...overrides,
  });

describe("markdown renderer (upstream routers/common/markup.go semantics)", () => {
  it("renders plain CommonMark for the default and explicit markdown modes", () => {
    expect(render({ text: "# Title" })).toBe('<h1 id="user-content-title">Title</h1>\n');
    expect(render({ text: "# Title", mode: "markdown" })).toBe('<h1 id="user-content-title">Title</h1>\n');
  });

  it("renders empty text to an empty body (upstream TestAPI_RenderSimple)", () => {
    expect(render({ text: "" })).toBe("");
  });

  it("keeps [[wiki-syntax]] literal in markdown mode, ignoring the context", () => {
    // upstream TestAPI_RenderSimple golden — raw markdown has no link handling.
    expect(render({ text: "[[special|syntax]]", mode: "markdown", context: "/user2/repo1" })).toBe(
      "<p>[[special|syntax]]</p>\n",
    );
  });

  it("escapes raw HTML (html:false — SPEC-0008 §3.4 posture)", () => {
    const html = render({ text: "<script>alert(1)</script>" });
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("linkifies bare URLs with rel=nofollow", () => {
    expect(render({ text: "visit https://example.com/x now" })).toBe(
      '<p>visit <a href="https://example.com/x" rel="nofollow">https://example.com/x</a> now</p>\n',
    );
  });

  it("rewrites relative links/images into repo URLs in gfm mode (upstream markup_test.go golden)", () => {
    const html = render({
      text: "[Link](test.md)\n![Image](image.png)",
      mode: "gfm",
      context: "/user2/repo1/src/branch/main",
    });
    expect(html).toContain(
      `<a href="${ORIGIN}/user2/repo1/src/branch/main/test.md" rel="nofollow">Link</a>`,
    );
    expect(html).toContain(`src="${ORIGIN}/user2/repo1/media/branch/main/image.png"`);
    expect(html).toContain('alt="Image"');
  });

  it("rewrites image-wrapping anchors with target=_blank + nofollow noopener", () => {
    const html = render({
      text: "[![Alt](image.png)](doc.md)",
      mode: "gfm",
      context: "user2/repo1",
    });
    expect(html).toContain(`<a href="${ORIGIN}/user2/repo1/src/branch/main/doc.md" target="_blank" rel="nofollow noopener">`);
    expect(html).toContain(`src="${ORIGIN}/user2/repo1/media/branch/main/image.png"`);
  });

  it("resolves relative targets against the context's tree path and preserves fragments", () => {
    const html = render({
      text: "[up](../other.md#section)",
      mode: "comment",
      context: "/user2/repo1/src/branch/main/doc",
    });
    expect(html).toContain(`href="${ORIGIN}/user2/repo1/src/branch/main/other.md#section"`);
  });

  it("passes absolute and in-page targets through untouched", () => {
    const html = render({
      text: "[ext](https://example.com/a)[ref](#anchor)[root](/x.png)",
      mode: "gfm",
      context: "user2/repo1",
    });
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('href="#anchor"');
    expect(html).toContain('href="/x.png"');
  });

  it("renders [[wiki-links]] into wiki URLs in wiki mode", () => {
    const html = render({ text: "[[Tips]]\n[[Name|Link]]", mode: "wiki", context: "user2/repo1" });
    expect(html).toContain(`<a href="${ORIGIN}/user2/repo1/wiki/Tips" rel="nofollow">Tips</a>`);
    expect(html).toContain(`<a href="${ORIGIN}/user2/repo1/wiki/Link" rel="nofollow">Name</a>`);
  });

  it("routes wiki image targets through wiki/raw with upstream's title/alt split", () => {
    const html = render({ text: "[[images/icon-bug.png]]", mode: "wiki", context: "/user2/repo1" });
    expect(html).toContain(`<a href="${ORIGIN}/user2/repo1/wiki/images/icon-bug.png" target="_blank" rel="nofollow noopener">`);
    expect(html).toContain(`src="${ORIGIN}/user2/repo1/wiki/raw/images/icon-bug.png"`);
    expect(html).toContain('title="icon-bug.png"');
    expect(html).toContain('alt="images/icon-bug.png"');
  });

  it("lets the deprecated Wiki flag force wiki mode (upstream util.Iif)", () => {
    const html = render({ text: "[[Tips]]", mode: "markdown", context: "user2/repo1", wiki: true });
    expect(html).toContain(`href="${ORIGIN}/user2/repo1/wiki/Tips"`);
  });

  it.each(["gfm", "comment", "file"] as const)(
    "renders repo-context mode %s with src/media rewriting from a bare owner/repo context",
    (mode) => {
      const html = render({ text: "[a](b.md)", mode, context: "user2/repo1" });
      expect(html).toContain(`href="${ORIGIN}/user2/repo1/src/branch/main/b.md"`);
    },
  );

  it("renders repo modes without a usable context as plain markdown", () => {
    expect(render({ text: "[a](b.md)", mode: "gfm", context: "garbage/with/slashes" })).toBe(
      '<p><a href="b.md" rel="nofollow">a</a></p>\n',
    );
  });

  it("throws the upstream 422 for unknown modes", () => {
    try {
      render({ text: "# Test", mode: "unknown" });
      expect.unreachable("expected ApiError");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.status).toBe(422);
      expect(apiError.message).toBe("unsupported render mode: unknown");
    }
  });
});

describe("parseRenderContext (upstream markup.go:52–61)", () => {
  it("parses the 5-field src form, keeping the ref remainder", () => {
    expect(parseRenderContext("/user2/repo1/src/branch/main")).toEqual({
      owner: "user2",
      repo: "repo1",
      refPath: "branch/main",
    });
    expect(parseRenderContext("/user2/repo1/src/branch/main/doc")).toEqual({
      owner: "user2",
      repo: "repo1",
      refPath: "branch/main/doc",
    });
  });

  it("parses the bare owner/repo form with the default branch", () => {
    expect(parseRenderContext("user2/repo1")).toEqual({ owner: "user2", repo: "repo1", refPath: "branch/main" });
  });

  it("returns null for non-repo contexts", () => {
    expect(parseRenderContext("")).toBeNull();
    expect(parseRenderContext("/user2/repo1/src")).toBeNull();
    expect(parseRenderContext("user2/repo1/extra/here")).toBeNull();
    expect(parseRenderContext("/user2/repo1/src/branch")).toBeNull();
  });
});

describe("readLimitedText (upstream io.LimitReader port)", () => {
  it("returns the whole body under the limit", async () => {
    const request = new Request("https://example.com", { method: "POST", body: "hello" });
    await expect(readLimitedText(request, 10)).resolves.toBe("hello");
  });

  it("truncates at the limit in BYTES and discards the rest", async () => {
    // "héllo" is 6 UTF-8 bytes; a 4-byte limit must cut mid-codepoint.
    const request = new Request("https://example.com", { method: "POST", body: "héllo" });
    const result = await readLimitedText(request, 4);
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(4);
    expect(result.startsWith("h")).toBe(true);
    // A replacement char marks the split codepoint — the discarded tail must
    // not leak ("llo" never appears).
    expect(result).not.toContain("llo");
  });

  it("exposes the upstream MaxDisplayFileSize default (8 MiB)", () => {
    expect(MAX_DISPLAY_FILE_SIZE).toBe(8_388_608);
  });
});

describe("POST /markdown (renderMarkdown)", () => {
  const router = createApiRouter();
  const TOKEN = { Authorization: "token stub-token" };

  it("401s anonymous callers with the Gitea error body (upstream reqToken)", async () => {
    const res = await router.request("https://example.com/markdown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Text: "# hi" }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      message: "token is required",
      url: "https://example.com/api/swagger",
    });
  });

  it("renders the default mode as text/html", async () => {
    const res = await router.request("https://example.com/markdown", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TOKEN },
      body: JSON.stringify({ Text: "# hello", Mode: "", Context: "" }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe('<h1 id="user-content-hello">hello</h1>\n');
  });

  it("binds lower-cased body keys like Go's case-insensitive JSON decode", async () => {
    const res = await router.request("https://example.com/markdown", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TOKEN },
      body: JSON.stringify({ text: "# x", mode: "markdown", context: "" }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<h1 id="user-content-x">x</h1>\n');
  });

  it("renders a gfm preview with repo-context rewriting", async () => {
    const res = await router.request("https://example.com/markdown", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TOKEN },
      body: JSON.stringify({ Text: "[Link](test.md)", Mode: "gfm", Context: "/user2/repo1/src/branch/main" }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      '<p><a href="https://example.com/user2/repo1/src/branch/main/test.md" rel="nofollow">Link</a></p>\n',
    );
  });

  it("422s unsupported modes and mistyped bodies with the error family", async () => {
    const badMode = await router.request("https://example.com/markdown", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TOKEN },
      body: JSON.stringify({ Text: "# Test", Mode: "bogus" }),
    });
    expect(badMode.status).toBe(422);
    expect(await badMode.json()).toEqual({
      message: "unsupported render mode: bogus",
      url: "https://example.com/api/swagger",
    });

    const badType = await router.request("https://example.com/markdown", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TOKEN },
      body: JSON.stringify({ Text: 42 }),
    });
    expect(badType.status).toBe(422);
    expect(await badType.json()).toEqual({
      message: "invalid request body",
      url: "https://example.com/api/swagger",
    });
  });

  it("answers malformed JSON with hono's 400 (divergence: upstream 422s bind errors)", async () => {
    // hono's validator middleware rejects unparseable JSON before the route
    // hook can run — declared-body gate behavior, reported as a
    // runtime-only-response candidate (upstream bind failures are 422).
    const badJson = await router.request("https://example.com/markdown", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...TOKEN },
      body: "{not json",
    });
    expect(badJson.status).toBe(400);
    expect(await badJson.json()).toEqual({
      message: "Malformed JSON in request body",
      url: "https://example.com/api/swagger",
    });
  });
});

describe("POST /markdown/raw (renderMarkdownRaw)", () => {
  const router = createApiRouter();
  const TOKEN = { Authorization: "token stub-token" };

  it("401s anonymous callers (upstream reqToken)", async () => {
    const res = await router.request("https://example.com/markdown/raw", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "# raw",
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      message: "token is required",
      url: "https://example.com/api/swagger",
    });
  });

  it("renders the raw body as text/html in markdown mode", async () => {
    const res = await router.request("https://example.com/markdown/raw", {
      method: "POST",
      headers: { "Content-Type": "text/plain", ...TOKEN },
      body: "# raw heading",
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe('<h1 id="user-content-raw-heading">raw heading</h1>\n');
  });

  it("does no context handling — wiki syntax stays literal (upstream TestAPI_RenderSimple)", async () => {
    const res = await router.request("https://example.com/markdown/raw", {
      method: "POST",
      headers: { "Content-Type": "text/plain", ...TOKEN },
      body: "[[special|syntax]]",
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>[[special|syntax]]</p>\n");
  });
});
