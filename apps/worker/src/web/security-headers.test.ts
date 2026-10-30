/**
 * The security-headers class matrix (usability F2, docs/usability/
 * findings-latency-health.md) — pins, per RESPONSE CLASS, the header posture
 * upstream stamps tree-wide (SecurityHeadersHandler,
 * routers/common/middleware.go:48-64: nosniff + SAMEORIGIN on everything)
 * plus the page CSP (`WebContentSecurityPolicy`,
 * services/context/context_template.go:116-141, the nonce → 'unsafe-inline'
 * adaptation documented in web/security-headers.ts), and re-verifies the
 * smoke's cache-control postures (findings-latency-health.md: pages private
 * must-revalidate, assets immutable 1y) ride unchanged.
 *
 * Two guards live here because this is the unit that emits the policy:
 * - the platform-served asset class (`public/_headers` — edge-served by the
 *   assets handler, never the Worker) is pinned by content;
 * - the goldens CSP-conformance scan verifies the mission's own gate: nothing
 *   the shell emits needs more than the emitted policy — and pins the exact
 *   byte set that would need page-module edits the day the upstream nonce
 *   policy is adopted verbatim (SPEC-0008 §4.14's listed breakers).
 */

import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { PAGE_CONTENT_SECURITY_POLICY, withSecurityHeaders } from "./security-headers";
import headersFile from "../../public/_headers?raw";

beforeAll(async () => {
  await applyAuthD1Migrations();
});

// Shell-riding arms 503 without the built asset tree — the index.test.ts
// environment probe, verbatim (UI_ASSETS_BUILT there for the rationale).
const UI_ASSETS_BUILT = await env.ASSETS.fetch("https://example.com/assets/.vite/manifest.json").then(
  (res) => res.ok,
  () => false
);

/** The tree-wide pair, present on EVERY class (upstream middleware.go:49-63). */
function expectUniversalPosture(headers: Headers): void {
  expect(headers.get("x-content-type-options")).toBe("nosniff");
  expect(headers.get("x-frame-options")).toBe("SAMEORIGIN");
}

describe("HTML page class (uiRouter, parent middleware stamp)", () => {
  it.skipIf(!UI_ASSETS_BUILT)("stamps the full page posture on /login", async () => {
    const response = await SELF.fetch("https://example.com/login", {
      headers: { accept: "text/html" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    expectUniversalPosture(response.headers);
    expect(response.headers.get("content-security-policy")).toBe(PAGE_CONTENT_SECURITY_POLICY);
    // The smoke's verified page posture (findings-latency-health.md:98),
    // untouched by this unit — the uiRouter middleware stamps it first and
    // the security-headers pass must not have disturbed it.
    expect(response.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
  });

  it.skipIf(!UI_ASSETS_BUILT)("stamps the full page posture on the 404 shell (dispatcher exit)", async () => {
    // renderNotFoundShellResponse is served DIRECTLY by the fetch dispatcher
    // — never through Hono — so its stamp is the withSecurityHeaders wrap at
    // the exit (src/index.ts), the non-Hono coverage arm.
    const response = await SELF.fetch("https://example.com/no-such-user/no-such-repo/nope", {
      headers: { accept: "text/html" },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    expectUniversalPosture(response.headers);
    expect(response.headers.get("content-security-policy")).toBe(PAGE_CONTENT_SECURITY_POLICY);
  });
});

describe("API JSON class", () => {
  it("stamps nosniff + frame posture, no CSP, on /healthz", async () => {
    const response = await SELF.fetch("https://example.com/healthz");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expectUniversalPosture(response.headers);
    // CSP is a PAGE class — upstream's header arm never touches JSON
    // (markup.go:34/render.go:69 are the only header sites; both render).
    expect(response.headers.get("content-security-policy")).toBeNull();
  });
});

describe("API plain 404 class (Hono default notFound)", () => {
  it("stamps nosniff + frame posture, no CSP, on the plain text answer", async () => {
    const response = await SELF.fetch("https://example.com/api/v1/nope", {
      headers: { accept: "text/html" },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
    expect(await response.text()).toBe("404 Not Found");
    expectUniversalPosture(response.headers);
    expect(response.headers.get("content-security-policy")).toBeNull();
  });
});

describe("git protocol class (gate + engine passthrough)", () => {
  it("stamps the universal pair on the gate's 401 advert challenge", async () => {
    const response = await SELF.fetch(
      "https://example.com/demo/security-headers-f2.git/info/refs?service=git-receive-pack"
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic");
    expectUniversalPosture(response.headers);
    expect(response.headers.get("content-security-policy")).toBeNull();
  });

  it("stamps the universal pair on the engine's plain `not found` passthrough", async () => {
    // A non-GET on a UI-shaped path keeps the engine owner (the carve is
    // GET-only) — the withSecurityHeaders wrap at the gitHttpGate exit covers
    // the passthrough, headers-only, bytes byte-identical.
    const response = await SELF.fetch("https://example.com/explore/xyz", {
      method: "POST",
      headers: { accept: "text/html" },
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toBe("text/html; charset=UTF-8");
    expect(await response.text()).toBe("not found\n");
    expectUniversalPosture(response.headers);
  });
});

describe("withSecurityHeaders (unit)", () => {
  it("returns the SAME response when nothing is missing", () => {
    const res = new Response("x", {
      headers: {
        "content-type": "text/html; charset=UTF-8",
        "x-content-type-options": "nosniff",
        "x-frame-options": "SAMEORIGIN",
        "content-security-policy": PAGE_CONTENT_SECURITY_POLICY,
      },
    });
    expect(withSecurityHeaders(res)).toBe(res);
  });

  it("keeps a handler-set header (set-if-absent, upstream handler-over-middleware order)", () => {
    // The raw/media sandbox matrix (raw-files.ts, wiki-raw.ts — upstream
    // ServeSetHeaders, modules/httplib/serve.go:60-76) sets its own CSP; the
    // pass must never overwrite it.
    const res = withSecurityHeaders(
      new Response("<x/>", {
        headers: { "content-type": "image/svg+xml", "content-security-policy": "sandbox allow-scripts" },
      }),
    );
    expect(res.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("scopes the CSP to text/html and streams the body by reference", () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk"));
        controller.close();
      },
    });
    const html = withSecurityHeaders(new Response(stream, { headers: { "content-type": "text/html" } }));
    expect(html.headers.get("content-security-policy")).toBe(PAGE_CONTENT_SECURITY_POLICY);
    expect(html.body).not.toBeNull();
    const json = withSecurityHeaders(new Response("{}", { headers: { "content-type": "application/json" } }));
    expect(json.headers.get("content-security-policy")).toBeNull();
  });
});

// --- the platform-served asset class ----------------------------------------
// /assets/* files are edge-served by the Workers Static Assets handler
// (wrangler.jsonc assets block, assets-first/worker-on-miss) and NEVER touch
// the Worker — public/_headers is that class's header layer, the same
// mechanism the smoke-verified immutable-1y cache-control rides. Pinned by
// content (?raw — workerd tests have no filesystem, the goldens.test.ts
// precedent).

describe("platform-served asset class (public/_headers)", () => {
  it("carries the universal pair on the catch-all rule", () => {
    const rules = headersFile.split("\n").map((line) => line.trim());
    const catchAll = rules.indexOf("/*");
    expect(catchAll).toBeGreaterThanOrEqual(0);
    const block = rules.slice(catchAll + 1, rules.findIndex((line, i) => i > catchAll && line.startsWith("/")));
    expect(block).toContain("X-Content-Type-Options: nosniff");
    expect(block).toContain("X-Frame-Options: SAMEORIGIN");
  });

  it("keeps the smoke-verified cache-control postures intact (findings-latency-health.md:96)", () => {
    expect(headersFile).toContain("/assets/js/*\n  Cache-Control: public, max-age=31536000, immutable");
    expect(headersFile).toContain("/assets/css/*\n  Cache-Control: public, max-age=31536000, immutable");
    expect(headersFile).toContain("/assets/img/*\n  Cache-Control: public, max-age=3600");
  });
});

// --- the goldens CSP-conformance scan (the mission's VERIFY gate) -----------
// Nothing the shell emits may need more than the emitted policy — and this is
// the ledger of exactly what would need page-module edits under upstream's
// verbatim nonce policy (the SPEC-0008 §4.14 breakers).

const GOLDEN_PAGES: Record<string, string> = {
  ...import.meta.glob("../ui/__tests__/goldens/*.html", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../ui/session-goldens/*.html", { query: "?raw", import: "default", eager: true }),
};

describe("goldens CSP conformance (shell bytes vs the emitted policy)", () => {
  it("has goldens to scan (the glob wiring stays honest)", () => {
    expect(Object.keys(GOLDEN_PAGES).length).toBeGreaterThan(0);
  });

  it("emits no inline event handlers or javascript: URIs on any golden page", () => {
    for (const [name, html] of Object.entries(GOLDEN_PAGES)) {
      // Inline handlers are the classic CSP escape hatch; upstream's nonce
      // policy would kill them instantly. The shell ships none — pin it so a
      // future page module cannot quietly add one.
      expect(html, name).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
      expect(html, name).not.toMatch(/javascript:/i);
    }
  });

  it("keeps every <script> in the accounted inventory (src / data block / static inline)", () => {
    for (const [name, html] of Object.entries(GOLDEN_PAGES)) {
      const tags = html.match(/<script\b[^>]*>/g) ?? [];
      for (const tag of tags) {
        const accounted =
          /\bsrc=/.test(tag) || // the bundle's external scripts (script-src *)
          /type="application\/json"/.test(tag) || // the window-config data block (never executed)
          /^<script( type="module")?>$/.test(tag); // the nonce-less inline artifacts (§4.14)
        expect(accounted, `${name}: ${tag}`).toBe(true);
      }
    }
  });
});
