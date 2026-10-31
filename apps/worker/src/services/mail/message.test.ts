/**
 * Mail message shaping (services/mail/message.ts) — the send-time transform
 * ports against the pin's own constants: the 256-rune clamp
 * (services/mailer/mail.go:32), the FNV-1 64-bit Message-ID hash
 * (sender/message.go:96-105 — the vector below is Go hash/fnv's published
 * `New64()` test value for "a", 0xaf63dc4c8601ec8c), the emailToReplacer
 * strip (models/user/user.go:587-596) and the `ToMessage` header assembly
 * (sender/message.go:44-89).
 */

import { describe, expect, it } from "vitest";

import {
  appDomainFromAppUrl,
  buildSubject,
  fnv64,
  formatAddress,
  generateAutoMessageId,
  htmlToText,
  parseMailFrom,
  sanitizeSubject,
  shapeOutgoingMail,
} from "./message";

describe("sanitizeSubject (mail.go:49-56 port)", () => {
  it("collapses whitespace runs and trims", () => {
    expect(sanitizeSubject("  a\t\tb\n\nc  ")).toBe("a b c");
  });

  it("clamps to 256 RUNES (not bytes)", () => {
    const long = "é".repeat(300);
    expect([...sanitizeSubject(long)]).toHaveLength(256);
    expect(sanitizeSubject(long)).toBe("é".repeat(256));
  });

  it("leaves short subjects byte-identical", () => {
    expect(sanitizeSubject("[cf-gitea] Alice, welcome to Gitea")).toBe(
      "[cf-gitea] Alice, welcome to Gitea",
    );
  });
});

describe("buildSubject (message.go:56-60)", () => {
  it("prepends the prefix when set", () => {
    expect(buildSubject("hello", "[cf-gitea]")).toBe("[cf-gitea] hello");
  });

  it("omits the prefix when unset or empty", () => {
    expect(buildSubject("hello")).toBe("hello");
    expect(buildSubject("hello", "")).toBe("hello");
  });

  it("sanitizes before the prefix joins", () => {
    expect(buildSubject("a   b", "P")).toBe("P a b");
  });
});

describe("fnv64 (Go hash/fnv New64, FNV-1)", () => {
  it("matches Go's published test vectors", () => {
    // Go src/hash/fnv golden sums for New64() (FNV-1: multiply-then-XOR):
    // 0xcbf29ce484222325 for "", 0xaf63bd4c8601b7be for "a",
    // 0x340d8765a4dda9c2 for "foobar". (0xaf63dc4c8601ec8c is the New64a
    // FNV-1a value — deliberately NOT expected here.)
    expect(fnv64("")).toBe(14695981039346656037n);
    expect(fnv64("a")).toBe(12638153115695167422n);
    expect(fnv64("foobar")).toBe(3750802935296928194n);
  });
});

describe("generateAutoMessageId (message.go:96-105)", () => {
  const input = {
    to: "user@example.com",
    subject: "Welcome",
    body: "Alice-body",
    dateMs: 1730000000000,
    appDomain: "cf-gitea.example.org",
  };

  it("renders <autogen-<ms>-<16hex>@<domain>> and is deterministic", () => {
    const id = generateAutoMessageId(input);
    expect(id).toBe(`<autogen-1730000000000-5a0d1d1bc18dca40@cf-gitea.example.org>`);
    expect(generateAutoMessageId(input)).toBe(id);
  });

  it("varies with the body (the hash input is to+subject+body)", () => {
    expect(generateAutoMessageId({ ...input, body: "other" })).not.toBe(
      generateAutoMessageId(input),
    );
  });
});

describe("appDomainFromAppUrl", () => {
  it("takes the APP_URL host", () => {
    expect(appDomainFromAppUrl("https://cf-gitea.demo.workers.dev/x")).toBe(
      "cf-gitea.demo.workers.dev",
    );
  });
  it("falls back to localhost when unset or unparseable", () => {
    expect(appDomainFromAppUrl(undefined)).toBe("localhost");
    expect(appDomainFromAppUrl("")).toBe("localhost");
    expect(appDomainFromAppUrl("not a url")).toBe("localhost");
  });
});

describe("formatAddress (EmailTo shape, user.go:450-465)", () => {
  it("uses Name <addr> with the injection characters stripped from the name", () => {
    expect(formatAddress("Alice", "a@x")).toBe("Alice <a@x>");
    // emailToReplacer (user.go:587-596): \n \r < > , : ; stripped.
    expect(formatAddress("Ali\nce<>:,;B", "a@x")).toBe("AliceB <a@x>");
  });
  it("falls back to the bare address", () => {
    expect(formatAddress("", "a@x")).toBe("a@x");
    expect(formatAddress("a@x", "a@x")).toBe("a@x");
  });
});

describe("htmlToText (the SPEC §5.6 reduction)", () => {
  it("drops style blocks, turns block closers into newlines, decodes entities", () => {
    const html = `<html><head><style>body{color:red}</style></head><body>
<p>Hi &amp; bye</p><p>a&lt;b &gt; c &quot;d&quot; e&#39;f&nbsp;g</p><br>tail
</body></html>`;
    const text = htmlToText(html);
    expect(text).not.toContain("color:red");
    expect(text).toContain("Hi & bye");
    expect(text).toContain("a<b > c \"d\" e'f g");
    expect(text.endsWith("tail")).toBe(true);
    // No TAG survives (the decoded entities' angle brackets are content).
    expect(text).not.toContain("<p");
    expect(text).not.toContain("</");
  });
});

describe("shapeOutgoingMail (ToMessage port, message.go:44-89)", () => {
  const row = {
    fromAddress: "noreply@example.com",
    fromDisplayName: "Gitea",
    toAddr: "alice@example.org",
    replyTo: null,
    subject: "Welcome",
    bodyHtml: "<p>Hi</p>",
    headers: null,
  };

  it("maps from/to, derives the text half, always sets X-Auto-Response-Suppress", () => {
    const mail = shapeOutgoingMail(row, { appUrl: "https://x.example" });
    expect(mail.from).toBe("Gitea <noreply@example.com>");
    expect(mail.to).toBe("alice@example.org");
    expect(mail.subject).toBe("Welcome");
    expect(mail.html).toBe("<p>Hi</p>");
    expect(mail.text).toBe("Hi");
    expect(mail.replyTo).toBeNull();
    expect(mail.headers["X-Auto-Response-Suppress"]).toBe("All");
    expect(mail.headers["Message-ID"]).toMatch(/^<autogen-\d+-[0-9a-f]{16}@x\.example>$/);
  });

  it("applies the subject prefix and honors a stored Message-ID", () => {
    const mail = shapeOutgoingMail(
      { ...row, headers: JSON.stringify({ "Message-ID": "<fixed@x>" }) },
      { subjectPrefix: "[cf-gitea]", appUrl: "https://x.example" },
    );
    expect(mail.subject).toBe("[cf-gitea] Welcome");
    expect(mail.headers["Message-ID"]).toBe("<fixed@x>");
  });

  it("folds stored single-value headers and degrades malformed JSON", () => {
    const withHeaders = shapeOutgoingMail({
      ...row,
      headers: JSON.stringify({ "X-Gitea-Sender": "root", "List-ID": "Broken <a@b>" }),
    });
    expect(withHeaders.headers["X-Gitea-Sender"]).toBe("root");
    expect(withHeaders.headers["List-ID"]).toBe("Broken <a@b>");

    const malformed = shapeOutgoingMail({ ...row, headers: "{not json" });
    expect(Object.keys(malformed.headers)).toEqual(["Message-ID", "X-Auto-Response-Suppress"]);
  });

  it("treats an empty replyTo as absent", () => {
    expect(shapeOutgoingMail({ ...row, replyTo: "" }).replyTo).toBeNull();
    expect(shapeOutgoingMail({ ...row, replyTo: "no-reply@x" }).replyTo).toBe("no-reply@x");
  });
});

describe("parseMailFrom (mailer.go:180-189 shape)", () => {
  it("parses Name <addr> and <addr>", () => {
    expect(parseMailFrom("Gitea <noreply@x>")).toEqual({ displayName: "Gitea", address: "noreply@x" });
    expect(parseMailFrom("<noreply@x>")).toEqual({ displayName: "", address: "noreply@x" });
    expect(parseMailFrom('"Gitea Bot" <noreply@x>')).toEqual({
      displayName: "Gitea Bot",
      address: "noreply@x",
    });
  });
  it("accepts a bare address and rejects address-less forms", () => {
    expect(parseMailFrom("noreply@x")).toEqual({ displayName: "", address: "noreply@x" });
    expect(parseMailFrom("no address here")).toBeNull();
    expect(parseMailFrom("<no-at-sign>")).toBeNull();
  });
});
