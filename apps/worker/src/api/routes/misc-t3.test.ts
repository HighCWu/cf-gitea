/**
 * Tier-3 misc stragglers on real bindings (SPEC-0004 appendix A): routes/
 * misc-t3.ts — the always-404 GET /signing-key.gpg and the doer-scoped key
 * families (GET/DELETE /user/keys[/{id}], GET/DELETE /user/gpg_keys[/{id}]).
 * One standalone app per the misc-t2.test.ts convention (the routes ARE
 * registered in router.ts by the orchestrator after this batch lands; the
 * isolated mount keeps the family independently assertable).
 *
 * None of these routes touch D1 — that IS the feature: cf-gitea has no
 * signing-key configuration (misc/signing.go's blank-format arm) and no key
 * storage (the identity.ts no-public_key/gpg-tables divergence), so every
 * answer here is the static honest one: the lists are empty with total 0 and
 * every id is the upstream not-exist 404.
 */

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

import { createStubAuthResolver, createTokenAuthMiddleware } from "../auth";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import { registerMiscT3Routes } from "./misc-t3";

function familyApp(register: (app: OpenAPIHono<ApiEnv>) => void) {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  register(app);
  return async (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(app.fetch(new Request(`https://example.com${path}`, init), env));
}

const authed = (init?: RequestInit): RequestInit => ({
  ...init,
  headers: new Headers({ ...init?.headers, Authorization: "token stub-token" }),
});

const miscSend = familyApp((app) =>
  registerMiscT3Routes(app, createTokenAuthMiddleware(createStubAuthResolver())),
);

// ---------------------------------------------------------------------------
// Declared response codes ⊆ vendored contract (SPEC-0004 §5.2 subset rule,
// asserted on the standalone mount — these ops reach the shared checker only
// after the orchestrator registers the family in router.ts)
// ---------------------------------------------------------------------------

describe("misc-t3 declared operations (misc-t3)", () => {
  it("declares exactly the contract codes, plus the one granted signing-key 404 exception", () => {
    const app = new OpenAPIHono<ApiEnv>();
    app.onError(giteaErrorHandler);
    registerMiscT3Routes(app, createTokenAuthMiddleware(createStubAuthResolver()));
    const doc = app.getOpenAPIDocument({
      openapi: "3.0.3",
      info: { title: "misc-t3", version: "0" },
    });

    /** Declared → contract-allowed (the /signing-key.gpg 404 is the
     *  RUNTIME_ONLY_RESPONSES entry this batch adds to check-openapi.mjs;
     *  every other code is contract-declared verbatim). */
    const expected: Record<string, Record<string, string[]>> = {
      "/signing-key.gpg": {
        get: ["200", "404"], // contract {200}; 404 = the granted runtime-only exception
      },
      "/user/keys": {
        get: ["200", "401", "403"], // contract {200,401,403}
      },
      "/user/keys/{id}": {
        get: ["200", "401", "403", "404"],
        delete: ["204", "401", "403", "404"],
      },
      "/user/gpg_keys": {
        get: ["200", "401", "403"],
      },
      "/user/gpg_keys/{id}": {
        get: ["200", "401", "403", "404"],
        delete: ["204", "401", "403", "404"],
      },
    };

    expect(Object.keys(doc.paths ?? {}).sort()).toEqual(Object.keys(expected).sort());
    for (const [path, methods] of Object.entries(expected)) {
      for (const [method, codes] of Object.entries(methods)) {
        const operation = (doc.paths?.[path] as Record<string, never> | undefined)?.[method] as
          | { responses: Record<string, unknown>; operationId: string }
          | undefined;
        expect(operation, `${method} ${path}`).toBeDefined();
        expect(Object.keys(operation!.responses).sort()).toEqual([...codes].sort());
      }
    }
  });
});

// ---------------------------------------------------------------------------
// GET /signing-key.gpg (the misc/signing.go:14-24 no-key arm)
// ---------------------------------------------------------------------------

describe("GET /signing-key.gpg (misc-t3)", () => {
  it("answers the honest no-signing-key 404 with the {message, url} body, anonymously", async () => {
    // Upstream wires the route in the anonymous misc group (api.go:1015) —
    // no token presented here.
    const response = await miscSend("/signing-key.gpg");
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toEqual({
      message: "no signing key",
      url: "https://example.com/api/swagger",
    });
  });

  it("the 404 is caller-independent (a token cannot conjure a signing key)", async () => {
    const response = await miscSend("/signing-key.gpg", authed());
    expect(response.status).toBe(404);
    const body: Record<string, unknown> = await response.json();
    expect(body.message).toBe("no signing key");
  });
});

// ---------------------------------------------------------------------------
// /user/keys + /user/gpg_keys (the zero-key-storage families)
// ---------------------------------------------------------------------------

describe("GET /user/keys[/{{id}}] (misc-t3)", () => {
  it("anonymous callers get the reqToken 401 (declared in the contract)", async () => {
    const response = await miscSend("/user/keys");
    expect(response.status).toBe(401);
    const body: Record<string, unknown> = await response.json();
    expect(body.message).toBe("token is required");
  });

  it("lists the empty key set with total 0; the fingerprint filter has nothing to filter", async () => {
    for (const query of ["", "?fingerprint=AA:BB:CC"]) {
      const response = await miscSend(`/user/keys${query}`, authed());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
      expect(response.headers.get("X-Total-Count")).toBe("0");
      expect(response.headers.get("Link")).toBeNull(); // page 1, no pages behind a total of 0
    }

    // page > 1 still earns the first/prev relations — the shared
    // setPaginationHeaders behavior (upstream SetLinkHeader), total or not.
    const paged = await miscSend("/user/keys?page=2&limit=5", authed());
    expect(paged.status).toBe(200);
    expect(await paged.json()).toEqual([]);
    expect(paged.headers.get("X-Total-Count")).toBe("0");
    expect(paged.headers.get("Link")).toBe(
      '<https://example.com/user/keys?page=1&limit=5>; rel="first",<https://example.com/user/keys?page=1&limit=5>; rel="prev"',
    );
  });

  it("every id is the upstream not-exist 404 (numeric, huge, and non-numeric alike)", async () => {
    for (const id of ["1", "999999999999", "not-a-number"]) {
      const response = await miscSend(`/user/keys/${id}`, authed());
      expect(response.status).toBe(404);
      const body: Record<string, unknown> = await response.json();
      expect(body.message).toBe("not found");
    }
    expect((await miscSend("/user/keys/1")).status).toBe(401);
  });

  it("DELETE /user/keys/{id} misses the same way (404; anonymous 401)", async () => {
    const response = await miscSend("/user/keys/7", authed({ method: "DELETE" }));
    expect(response.status).toBe(404);
    const body: Record<string, unknown> = await response.json();
    expect(body.message).toBe("not found");
    expect((await miscSend("/user/keys/7", { method: "DELETE" })).status).toBe(401);
  });
});

describe("GET /user/gpg_keys[/{{id}}] (misc-t3)", () => {
  it("anonymous callers get the reqToken 401; the list is the empty GPGKeyList", async () => {
    expect((await miscSend("/user/gpg_keys")).status).toBe(401);

    const response = await miscSend("/user/gpg_keys", authed());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(response.headers.get("X-Total-Count")).toBe("0");
  });

  it("item get/delete are the not-exist 404 for any id (anonymous 401)", async () => {
    const got = await miscSend("/user/gpg_keys/3", authed());
    expect(got.status).toBe(404);
    const body: Record<string, unknown> = await got.json();
    expect(body.message).toBe("not found");

    const deleted = await miscSend("/user/gpg_keys/3", authed({ method: "DELETE" }));
    expect(deleted.status).toBe(404);

    expect((await miscSend("/user/gpg_keys/3")).status).toBe(401);
    expect((await miscSend("/user/gpg_keys/3", { method: "DELETE" })).status).toBe(401);
  });
});
