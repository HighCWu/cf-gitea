/**
 * `GET /api/v1/swagger` — the API-docs redirect arm (census B-80, module 16
 * MS11). Pins, against the REAL createApiRouter stack (the production
 * registration, middleware included):
 *
 *   - the anonymous 303 (Base.Redirect's default — services/context/
 *     base.go:157 OptionalArg → http.StatusSeeOther) with Location
 *     `/api/swagger` and Go http.Redirect's exact GET anchor body
 *     `<a href="/api/swagger">See Other</a>.\n` over
 *     "text/html; charset=utf-8";
 *   - the fetch-action flip (base.go:153-156 — a non-empty
 *     X-Gitea-Fetch-Action header answers the 200 {"redirect"} JSON with
 *     Base.JSON's exact "application/json;charset=utf-8");
 *   - the chi method tree (mux.go:532-540, the 7538a40 adjudication):
 *     HEAD/OPTIONS/POST all 405 + `Allow: GET` — chi registers ONE method
 *     per m.Get and has NO HEAD→GET fallback;
 *   - the plain-registration contract (api.go:1001-1005's own comment: the
 *     route "renders a web page", NOT an API operation — the path never
 *     enters the generated OpenAPI document, so the check:api surface is
 *     untouched).
 *
 * No D1: the route sits in the "Miscellaneous (no scope required)" group
 * and touches no store; both standalone middleware (the scope gate and the
 * require-sign-in-view gate) no-op for an anonymous standalone request, so
 * `createApiRouter()` with its stub defaults drives it directly.
 */

import { describe, expect, it } from "vitest";

import { SERVER_VERSION } from "../config";
import { createApiRouter } from "../router";
import { isFetchActionRequest, seeOtherRedirectBody, swaggerRedirectResponse } from "./swagger-redirect";
import type { ApiEnv } from "../env";
import type { Context } from "hono";

const ROUTER = createApiRouter();

describe("GET /api/v1/swagger (api.go:1001-1005 — the docs redirect)", () => {
  it("303s anonymously to the viewer with Go's exact GET anchor body", async () => {
    const res = await ROUTER.request("/swagger");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/api/swagger");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe('<a href="/api/swagger">See Other</a>.\n');
  });

  it("redirects through the full /api/v1 mount path shape", async () => {
    // The router-relative request above strips the mount prefix; assert the
    // Location is the ABSOLUTE site path (AppSubURL "" + "/api/swagger"),
    // not a router-relative echo of "/swagger".
    const res = await ROUTER.request("/swagger");
    expect(res.headers.get("location")).not.toBe("/swagger");
  });

  it("flips to the fetch-action JSON 200 on a non-empty X-Gitea-Fetch-Action header", async () => {
    const res = await ROUTER.request("/swagger", { headers: { "X-Gitea-Fetch-Action": "1" } });
    expect(res.status).toBe(200);
    // Base.JSON's exact content-type (base.go:115 — set explicitly; Hono's
    // c.json would write "application/json; charset=UTF-8").
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(await res.json()).toEqual({ redirect: "/api/swagger" });
  });

  it("HEAD/OPTIONS/POST tree-405 + Allow: GET, empty body — chi has NO HEAD→GET fallback", async () => {
    // chi registers ONE method per m.Get; every other method resolves no
    // endpoint and the default methodNotAllowedHandler answers
    // (mux.go:532-540) — the 7538a40 adjudication, the federation family's
    // pinned posture (HEAD's body reads "" through Hono's auto-HEAD strip).
    for (const method of ["HEAD", "OPTIONS", "POST"]) {
      const res = await ROUTER.request("/swagger", { method });
      expect(res.status, `${method} status`).toBe(405);
      expect(res.headers.get("allow"), `${method} allow`).toBe("GET");
      expect(await res.text(), `${method} body`).toBe("");
    }
  });

  it("never enters the generated OpenAPI document (the plain-registration contract)", () => {
    // Upstream: "The route is here but no in API routes because it renders
    // a web page" — the redirect is not an API operation, the vendored
    // swagger carries no such path, and check:api stage (a) compares the
    // GENERATED document against that swagger. A stray registration here
    // would fail the checker; this pin is that posture's tripwire.
    const doc = ROUTER.getOpenAPIDocument({
      openapi: "3.0.3",
      info: { title: "Gitea API", version: SERVER_VERSION },
    });
    expect(Object.keys(doc.paths)).not.toContain("/swagger");
  });
});

describe("the redirect helpers (base.go:150-159 / net/http pieces)", () => {
  const fakeContext = (headers: Record<string, string>, method = "GET"): Context<ApiEnv> => {
    const req = new Request("https://instance.local/api/v1/swagger", { headers, method });
    // The handler touches c.req.header() (HonoRequest's accessor, not the
    // raw Request's .headers) — the minimal slice of the Hono context.
    return { req: { header: (name: string) => req.headers.get(name) } } as unknown as Context<ApiEnv>;
  };

  it("isFetchActionRequest mirrors server_request.go:246-248 — mere presence, any value", () => {
    expect(isFetchActionRequest(fakeContext({}))).toBe(false);
    expect(isFetchActionRequest(fakeContext({ "X-Gitea-Fetch-Action": "" }))).toBe(false);
    expect(isFetchActionRequest(fakeContext({ "X-Gitea-Fetch-Action": "1" }))).toBe(true);
    // NB: Go would treat a whitespace-only value as present, but the fetch
    // Headers spec (workerd and this constructor alike) strips leading and
    // trailing whitespace, so " " normalizes to "" before the handler sees
    // it — the platform boundary, not the helper, owns that difference.
  });

  it("swaggerRedirectResponse is the fetch-action arm verbatim (JSON-first, like Base.Redirect)", () => {
    const res = swaggerRedirectResponse(fakeContext({ "X-Gitea-Fetch-Action": "true" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json;charset=utf-8");
  });

  it("seeOtherRedirectBody escapes the location like net/http's htmlEscape", () => {
    expect(seeOtherRedirectBody("/api/swagger")).toBe('<a href="/api/swagger">See Other</a>.\n');
    // net/http/server.go's htmlRe: " as &#34; and ' as &#39; ("for shorter
    // output") — the goRedirectBody twin's exact table.
    expect(seeOtherRedirectBody('/a?b=1&c<"d\'e>')).toBe(
      '<a href="/a?b=1&amp;c&lt;&#34;d&#39;e&gt;">See Other</a>.\n',
    );
  });
});
