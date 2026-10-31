/**
 * Census gap #16 suites — the `/.well-known/*` web group's endpoints this
 * module owns (the pin's group, web.go:531-542): change-password's two
 * redirect arms (the fetch-action JSON probe, base.go:150-159 + Go
 * http.Redirect's 303 bytes) and its chi 405 method arm, the passkey
 * document (passkey.go:13-24, byte-exact), the static-file fallback's
 * arms over the empty store (public.go:58-70/86-114 — bare empty 404s,
 * the Allow-bearing 405s of chi's default handler), the bare-path web
 * NotFound (context_response.go:139-141's plain line), and the combined-
 * app specificity proof (a sibling static GET beats this module's `/*`
 * fallback — the mount parity the handoff relies on).
 *
 * The family is D1-free — no migrations, no seeds; the env slice is the
 * real bindings with APP_URL overridden per case (the FederationEnv test
 * posture). Driven standalone like the landed sub-app suites — NO
 * src/index.ts dependency.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import { webWellKnownRouter, type WellKnownEnv } from "./well-known";

const ORIGIN = "https://example.com";

/** The route env slice: the real bindings with APP_URL unset by default
 *  (the request-origin fallback) and per-case overrides. */
const wellKnownEnv = (appUrl?: string): WellKnownEnv => ({
  ...env,
  APP_URL: appUrl,
});

const call = async (path: string, init?: RequestInit, appUrl?: string): Promise<Response> =>
  await webWellKnownRouter.request(`${ORIGIN}${path}`, init, wellKnownEnv(appUrl));

// ---------------------------------------------------------------------------
// GET /.well-known/change-password (web.go:537-539)
// ---------------------------------------------------------------------------

describe("GET /.well-known/change-password", () => {
  it("303 See Other to /user/settings/account with Go's redirect bytes", async () => {
    const response = await call("/.well-known/change-password");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/user/settings/account");
    // http.Redirect's GET arm: Content-Type in GO's spelling (with the
    // space) and the Fprintln'd anchor — the literal's "\n" plus
    // Fprintln's own, so the body ends `</a>.\n\n`.
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toBe('<a href="/user/settings/account">See Other</a>.\n\n');
  });

  it("AppSubURL rides the APP_URL path (server.go:140 — TrimSuffix one slash)", async () => {
    const response = await call("/.well-known/change-password", undefined, `${ORIGIN}/sub`);
    expect(response.headers.get("location")).toBe("/sub/user/settings/account");
    expect(await response.text()).toBe('<a href="/sub/user/settings/account">See Other</a>.\n\n');
  });

  it("APP_URL unset falls back to the request origin (the landed AppURL seam)", async () => {
    const response = await call("/.well-known/change-password", undefined, undefined);
    expect(response.headers.get("location")).toBe("/user/settings/account");
  });

  it("the X-Gitea-Fetch-Action probe answers 200 {redirect} JSON instead of the 303 (base.go:151-156)", async () => {
    const response = await call("/.well-known/change-password", {
      headers: { "x-gitea-fetch-action": "1" },
    });
    expect(response.status).toBe(200);
    // ctx.JSON bytes: compact, no trailing newline, base.go's type spelling.
    expect(await response.text()).toBe('{"redirect":"/user/settings/account"}');
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
  });

  it("non-GET methods take chi's default 405 + Allow: GET — HEAD included (chi v5.4.0 has NO HEAD fallback)", async () => {
    for (const method of ["HEAD", "POST", "OPTIONS", "PUT", "DELETE"]) {
      const response = await call("/.well-known/change-password", { method });
      expect(response.status, method).toBe(405);
      expect(await response.text(), method).toBe("");
      expect(response.headers.get("allow"), method).toBe("GET");
    }
  });
});

// ---------------------------------------------------------------------------
// GET /.well-known/passkey-endpoints (web.go:540 → passkey.go:13-24)
// ---------------------------------------------------------------------------

describe("GET /.well-known/passkey-endpoints", () => {
  it("the static document, byte-exact: enroll then manage, compact, no trailing newline", async () => {
    const response = await call("/.well-known/passkey-endpoints");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    const text = await response.text();
    expect(text).toBe(
      `{"enroll":"${ORIGIN}/user/settings/security","manage":"${ORIGIN}/user/settings/security"}`,
    );
    expect(text.endsWith("\n")).toBe(false);
  });

  it("AppURL normalization: one trailing slash between host and path (server.go:137)", async () => {
    const response = await call("/.well-known/passkey-endpoints", undefined, `${ORIGIN}/sub`);
    const doc = await response.json<{ enroll: string; manage: string }>();
    expect(doc.enroll).toBe(`${ORIGIN}/sub/user/settings/security`);
    expect(doc.manage).toBe(`${ORIGIN}/sub/user/settings/security`);
  });

  it("APP_URL unset derives the hrefs from the request origin", async () => {
    const doc = await (await call("/.well-known/passkey-endpoints")).json<{ enroll: string }>();
    expect(doc.enroll).toBe(`${ORIGIN}/user/settings/security`);
  });

  it("non-GET methods 405 + Allow: GET (outside the federation gate group — ungated)", async () => {
    for (const method of ["HEAD", "POST", "OPTIONS"]) {
      const response = await call("/.well-known/passkey-endpoints", { method });
      expect(response.status, method).toBe(405);
      expect(await response.text(), method).toBe("");
      expect(response.headers.get("allow"), method).toBe("GET");
    }
  });
});

// ---------------------------------------------------------------------------
// The static fallback (web.go:541 — FileHandlerFunc over the empty store)
// ---------------------------------------------------------------------------

describe("the /.well-known/* static fallback", () => {
  it("GET on an unclaimed tail is the bare missing-file 404 — empty body, no Content-Type", async () => {
    const response = await call("/.well-known/security.txt");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(response.headers.get("content-type")).toBeNull();
  });

  it("HEAD rides the fallback too (both methods registered — router.go:177-190's split)", async () => {
    const response = await call("/.well-known/security.txt", { method: "HEAD" });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("the trailing-slash shape lands on the same arm (PathJoinRelX → missing file)", async () => {
    const response = await call("/.well-known/change-password/");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("known non-GET/HEAD methods 405 with Allow added per method: GET, HEAD", async () => {
    for (const method of ["POST", "OPTIONS", "PUT", "PATCH", "DELETE"]) {
      const response = await call("/.well-known/security.txt", { method });
      expect(response.status, method).toBe(405);
      expect(await response.text(), method).toBe("");
      // Two Headers.append calls → undici's get() joins them; the wire
      // carries two Allow lines (chi's Add-per-method, mux.go).
      expect(response.headers.get("allow"), method).toBe("GET, HEAD");
    }
  });
  // The chi methodMap-miss arm (unknown method → bare 405, no Allow) is
  // NOT driveable here: workerd's Request constructor rejects unknown
  // method strings ("Invalid HTTP method string") before the router sees
  // them. The arm lives in chiMethodNotAllowed — mirror-only.
});

// ---------------------------------------------------------------------------
// The bare /.well-known path (web.go:1819-1823's web NotFound)
// ---------------------------------------------------------------------------

describe("the bare /.well-known path", () => {
  it("the plain NotFound line for every accept (the chrome divergence is recorded in the module header)", async () => {
    for (const headers of [undefined, { accept: "text/html" }]) {
      const response = await call("/.well-known", { headers });
      expect(response.status).toBe(404);
      // Gitea's PlainText spelling — NO space in the type + nosniff
      // (context_response.go:139-141 → plainTextInternal base.go:128-136).
      expect(await response.text()).toBe("Not found.\n");
      expect(response.headers.get("content-type")).toBe("text/plain;charset=utf-8");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("non-GET methods land on the same web NotFound (no pattern claims the bare path upstream)", async () => {
    const response = await call("/.well-known", { method: "POST" });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found.\n");
  });
});

// ---------------------------------------------------------------------------
// Combined-app specificity — the mount handoff's load-bearing proof
// ---------------------------------------------------------------------------

describe("mount parity — static siblings beat the fallback (the Hono merge mirrors chi)", () => {
  it("a sibling's static GET keeps winning over this module's /* fallback; the fallback claims only unclaimed tails", async () => {
    const sibling = new Hono<{ Bindings: WellKnownEnv }>();
    sibling.get("/.well-known/nodeinfo", () => new Response("sibling-doc", { status: 200 }));
    const app = new Hono<{ Bindings: WellKnownEnv }>();
    app.route("/", sibling);
    app.route("/", webWellKnownRouter);

    const claimed = await app.request(`${ORIGIN}/.well-known/nodeinfo`, {}, wellKnownEnv());
    expect(claimed.status).toBe(200);
    expect(await claimed.text()).toBe("sibling-doc");

    const unclaimed = await app.request(`${ORIGIN}/.well-known/other`, {}, wellKnownEnv());
    expect(unclaimed.status).toBe(404);
    expect(await unclaimed.text()).toBe("");
  });
});
