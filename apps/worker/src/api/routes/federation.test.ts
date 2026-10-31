/**
 * Federation Tier A suite (specs/federation.md §6.1 / §7 — W-A1): the
 * discovery pair + the gated 501 stubs on real D1, both routers driven
 * standalone (the HANDOFF mounts in src/index.ts + api/router.ts are the
 * orchestrator's; the sub-apps are mounted verbatim, so these pins carry
 * over unchanged).
 *
 * Arms pinned, each with its upstream cite:
 *   - the FEDERATION_ENABLED gate: strict "true" polarity; disabled web
 *     pair answers Go ctx.HTTPError(404)'s plain `Not Found\n`
 *     (services/context/base.go:105-111, wrapped by web.go:409-414);
 *     disabled API arms answer the router's native 404 — upstream's
 *     registration conditional (api.go:1007) leaves them unregistered;
 *   - GET /.well-known/nodeinfo: the single link, byte-shaped per
 *     nodeinfo.go:23-31 (Go compact struct marshal, href before rel);
 *   - GET /.well-known/webfinger: the complete webfinger.go:38-122 ladder —
 *     same-host acct (foreign host / no-@ / unknown scheme / missing → 400
 *     `Bad Request\n`), mailto with the private-email suppression (the OQ-6
 *     port-faithful arm), the visibility gate (anonymous vs. the session
 *     doer), the noreply arm of GetUserByEmail (user.go:1372-1402), the
 *     type-blind org resolution (GetUserByName has no type filter),
 *     unknown-user 404, and the JRD byte-shape (webfinger.go:87-121:
 *     subject/aliases/links in Go struct order, the in-handler
 *     `Access-Control-Allow-Origin: *` stamp at :116);
 *   - the stubs (api.go:1007-1010 + person.go:12-14): enabled, EVERY arm
 *     (GET /nodeinfo; ANY depth/method under /activitypub/*) answers Go
 *     http.Error's `Not implemented\n` at 501; the activitypub token scope
 *     gate rides the route group — anonymous passes to the stub (upstream's
 *     GetDoerTokenScope early return, api.go:281-283), a scopeless-token
 *     403 carries the exact api.go:300 body, the method-derived level
 *     (read passes GET, write required POST/PUT/PATCH/DELETE).
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import { emailAddresses, userSettings, users } from "../../db/schema";
import type { AuthInfo, AuthUser } from "../../auth/auth-context";
import { ScopeSet } from "../../auth/scopes";
import { giteaErrorHandler } from "../errors";
import type { ApiEnv } from "../env";
import {
  federationEnabled,
  registerFederationApiRoutes,
  wellKnownRouter,
  type FederationEnv,
} from "./federation";
import {
  federationAppUrl,
  parseResource,
  resolveWebfinger,
} from "../../services/federation/webfinger";

const ORIGIN = "https://fed.example";
const HOST = "fed.example";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM email_addresses").run();
  await env.DB.prepare("DELETE FROM user_settings").run();
  await env.DB.prepare("DELETE FROM sessions").run();
  await env.DB.prepare("DELETE FROM users").run();
});

/** The family env: the test bindings with the gate var injected. */
const familyEnv = (federation?: string, appUrl?: string): FederationEnv => ({
  ...env,
  FEDERATION_ENABLED: federation,
  APP_URL: appUrl,
});

/** The /.well-known sub-app, driven like the production "/" mount. */
const wellKnown = async (path: string, federation?: string, appUrl?: string): Promise<Response> =>
  await wellKnownRouter.request(`${ORIGIN}${path}`, {}, familyEnv(federation, appUrl));

/** The /api/v1 router with the federation family registered — exactly the
 *  production registration over OpenAPIHono<ApiEnv>. The auth middleware is
 *  the test's injectable stand-in for the production resolveAuth (it only
 *  has to put an AuthInfo in Variables.auth). The gate var rides the env
 *  through Object.assign — the generated Env does not carry
 *  FEDERATION_ENABLED until the operator's config gains it, and the assign
 *  builds the widened slice without a cast (the vitest env itself already
 *  carries non-config bindings the same way). */
async function api(
  path: string,
  init?: RequestInit,
  opts?: { federation?: string; auth?: AuthInfo },
): Promise<Response> {
  const app = new OpenAPIHono<ApiEnv>();
  app.onError(giteaErrorHandler);
  if (opts?.auth !== undefined) {
    const auth = opts.auth;
    app.use("*", async (c, next) => {
      c.set("auth", auth);
      await next();
    });
  }
  registerFederationApiRoutes(app);
  const envSlice = Object.assign({}, env, { FEDERATION_ENABLED: opts?.federation });
  // The standalone app registers router-relative paths (no /api/v1 mount) —
  // the prefix strips off, the blocks.test.ts pattern.
  return await app.fetch(new Request(`${ORIGIN}${path}`, init), envSlice);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface SeedOptions {
  username: string;
  email?: string | null;
  visibility?: "public" | "limited" | "private";
  type?: "user" | "org";
  hideEmail?: boolean;
}

/** A users row (+ the optional hideEmail side-store row) — the per-test
 *  world; tables are wiped in beforeEach so ids restart predictably enough
 *  to re-read. */
async function seedUser(options: SeedOptions): Promise<{ id: number; username: string }> {
  const rows = await drizzle(env.DB)
    .insert(users)
    .values({
      username: options.username,
      usernameLower: options.username.toLowerCase(),
      email: options.email ?? null,
      visibility: options.visibility ?? "public",
      type: options.type ?? "user",
      createdAt: new Date(),
    })
    .returning()
    .all();
  const row = rows[0];
  if (row === undefined) throw new Error("user seed failed");
  if (options.hideEmail === true) {
    await drizzle(env.DB).insert(userSettings).values({ userId: row.id, hideEmail: true });
  }
  return { id: row.id, username: row.username };
}

async function seedEmail(userId: number, email: string, activated: boolean): Promise<void> {
  await drizzle(env.DB)
    .insert(emailAddresses)
    .values({ userId, email, lowerEmail: email.toLowerCase(), isActivated: activated, isPrimary: false });
}

/** A fake AuthInfo carrying just the scope the gate reads (the route-level
 *  tests never touch the user fields). */
const authWithScope = (scopes: string): AuthInfo => {
  const user: AuthUser = {
    id: 1,
    username: "tester",
    usernameLower: "tester",
    email: null,
    displayName: null,
    location: null,
    website: null,
    description: null,
    isAdmin: false,
    status: "active",
    createdAt: new Date(),
  };
  return {
    user,
    token: {
      id: 1,
      userId: 1,
      name: "suite",
      prefix: "cfg_abcdef12",
      scopes,
      expiresAt: null,
      lastUsedAt: null,
      createdAt: new Date(),
    },
    scope: ScopeSet.parse(scopes),
    isBasicAuth: true,
  };
};

/** Upstream api.go:300's exact 403 body (Go %v slice rendering). */
const scopeForbidden = (required: string, tokenScope: string): Record<string, string> => ({
  message: `token does not have at least one of required scope(s), required=[${required}], token scope=${tokenScope}`,
  url: `${ORIGIN}/api/swagger`,
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("the FEDERATION_ENABLED gate (federation.go:23, default false)", () => {
  it("arms ONLY on the exact string true — the strict-polarity class", () => {
    const probe = (raw: string | undefined): boolean => federationEnabled({ ...env, FEDERATION_ENABLED: raw });
    expect(probe(undefined)).toBe(false);
    expect(probe("")).toBe(false);
    expect(probe("false")).toBe(false);
    expect(probe("False")).toBe(false);
    expect(probe("true ")).toBe(false);
    expect(probe("1")).toBe(false);
    expect(probe("true")).toBe(true);
  });

  it("parses the resource like Go url.Parse's scheme/opaque split", () => {
    expect(parseResource("acct:alice@example.com")).toEqual({ scheme: "acct", opaque: "alice@example.com" });
    expect(parseResource("ACCT:alice@example.com")).toEqual({ scheme: "acct", opaque: "alice@example.com" });
    expect(parseResource("mailto:Alice@Example.com")).toEqual({ scheme: "mailto", opaque: "Alice@Example.com" });
    // No colon, invalid scheme start, or a bad character before the colon:
    // Go leaves Scheme "" → the switch's default arm 400s.
    expect(parseResource("alice@example.com")).toEqual({ scheme: "", opaque: "" });
    expect(parseResource("")).toEqual({ scheme: "", opaque: "" });
    expect(parseResource("1acct:x")).toEqual({ scheme: "", opaque: "" });
    expect(parseResource("acct x:y")).toEqual({ scheme: "", opaque: "" });
    // Parse errors (control chars, invalid % escape) land on 400 upstream.
    expect(parseResource("acct:ali%zzx")).toEqual({ scheme: "", opaque: "" });
    expect(parseResource("acct:ali\tex")).toEqual({ scheme: "", opaque: "" });
    // The authority form consumes the net-path: Opaque stays empty.
    expect(parseResource("acct://alice@example.com")).toEqual({ scheme: "acct", opaque: "" });
  });

  it("normalizes the AppURL chain to the trailing-slash form (server.go:50-51)", () => {
    expect(federationAppUrl(undefined, ORIGIN)).toBe(`${ORIGIN}/`);
    expect(federationAppUrl("https://custom.example", ORIGIN)).toBe("https://custom.example/");
    expect(federationAppUrl("https://custom.example/", ORIGIN)).toBe("https://custom.example/");
    expect(federationAppUrl("  https://custom.example/  ", ORIGIN)).toBe("https://custom.example/");
    expect(federationAppUrl("", ORIGIN)).toBe(`${ORIGIN}/`);
  });
});

// ---------------------------------------------------------------------------
// /.well-known/nodeinfo — nodeinfo.go:23-31
// ---------------------------------------------------------------------------

describe("GET /.well-known/nodeinfo", () => {
  it("enabled: the single 2.1 link, byte-shaped (href before rel, compact)", async () => {
    const response = await wellKnown("/.well-known/nodeinfo", "true");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      `{"links":[{"href":"${ORIGIN}/api/v1/nodeinfo","rel":"http://nodeinfo.diaspora.software/ns/schema/2.1"}]}`,
    );
  });

  it("enabled: the APP_URL var is the href base (the AppURL chain)", async () => {
    const response = await wellKnown("/.well-known/nodeinfo", "true", "https://custom.example");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      '{"links":[{"href":"https://custom.example/api/v1/nodeinfo","rel":"http://nodeinfo.diaspora.software/ns/schema/2.1"}]}',
    );
  });

  it("disabled: upstream's gate 404 — the plain `Not Found` http.Error line", async () => {
    for (const federation of [undefined, "false"]) {
      const response = await wellKnown("/.well-known/nodeinfo", federation);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Not Found\n");
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});

// ---------------------------------------------------------------------------
// /.well-known/webfinger — webfinger.go:38-122
// ---------------------------------------------------------------------------

describe("GET /.well-known/webfinger — the gate and the 400 arms", () => {
  it("disabled: the same plain `Not Found` 404 the nodeinfo link gets", async () => {
    const response = await wellKnown("/.well-known/webfinger?resource=acct:alice@fed.example", "false");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found\n");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("400s: foreign host, missing @, unknown scheme, missing resource (webfinger.go:53-70)", async () => {
    await seedUser({ username: "alice", email: "alice@example.com" });
    for (const resource of [
      "acct:alice@elsewhere.example", // webfinger.go:57-60 — same-instance only
      "acct:alice", // SplitN finds no @ → 400 (:53-56)
      "acct://alice@fed.example", // the authority form leaves Opaque empty → no @
      "https://fed.example/alice", // :68-70 — any other scheme
      "mailto-no-at-thing", // no valid scheme → the default arm
    ]) {
      const response = await wellKnown(`/.well-known/webfinger?resource=${encodeURIComponent(resource)}`, "true");
      expect(response.status, resource).toBe(400);
      expect(await response.text(), resource).toBe("Bad Request\n");
      expect(response.headers.get("content-type"), resource).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("x-content-type-options"), resource).toBe("nosniff");
    }
    // The missing query param: FormTrim gives "" → Scheme "" → default → 400.
    const missing = await wellKnown("/.well-known/webfinger", "true");
    expect(missing.status).toBe(400);
    expect(await missing.text()).toBe("Bad Request\n");
  });

  it("404s an unknown user with the plain http.Error line (webfinger.go:72-75)", async () => {
    const response = await wellKnown(`/.well-known/webfinger?resource=acct:ghost@${HOST}`, "true");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not Found\n");
  });
});

describe("GET /.well-known/webfinger — the JRD (webfinger.go:87-121)", () => {
  it("acct same-host: the exact byte-shape — subject, aliases, four links, CORS *", async () => {
    const alice = await seedUser({ username: "alice", email: "alice@example.com" });

    const response = await wellKnown(`/.well-known/webfinger?resource=acct:alice@${HOST}`, "true");
    expect(response.status).toBe(200);
    // webfinger.go:116 — the in-handler stamp, gate-open only.
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("content-type")).toContain("application/json");

    const actorIri = `${ORIGIN}/api/v1/activitypub/user-id/${alice.id}`;
    // Go struct-declaration order: Subject, Aliases, Links — one line, the
    // render the omitempty gaps leave exact.
    const body = await response.text();
    expect(body).toBe(
      JSON.stringify({
        subject: `acct:alice@${HOST}`,
        aliases: [`${ORIGIN}/alice`, actorIri, "mailto:alice@example.com"],
        links: [
          { rel: "http://webfinger.net/rel/profile-page", type: "text/html", href: `${ORIGIN}/alice` },
          { rel: "http://webfinger.net/rel/avatar", href: `${ORIGIN}/avatars/alice` },
          { rel: "self", type: "application/activity+json", href: actorIri },
          { rel: "http://openid.net/specs/connect/1.0/issuer", href: `${ORIGIN}/` },
        ],
      }),
    );

    // The self link advertises the actor IRI that 501s at the pin —
    // upstream's own posture (SPEC §2.2: the discovery points at a door
    // that is not built).
    const jrd = JSON.parse(body) as { links: Array<{ rel: string; href: string }> };
    expect(jrd.links.find((link) => link.rel === "self")?.href).toBe(actorIri);
  });

  it("resolution is case-insensitive, the subject keeps the row's display name", async () => {
    await seedUser({ username: "Alice", email: "Alice@Example.com" });
    // The host compare is exact (webfinger.go:57) — only the NAME part may
    // vary in case; the subject renders u.Name, not the queried spelling.
    const response = await wellKnown(`/.well-known/webfinger?resource=acct:${encodeURIComponent("ALICE")}@${HOST}`, "true");
    expect(response.status).toBe(200);
    const jrd = await response.json<{ subject: string }>();
    expect(jrd.subject).toBe(`acct:Alice@${HOST}`);
  });

  it("an org row resolves too — GetUserByName is type-blind (user.go:1120-1135)", async () => {
    const acme = await seedUser({ username: "acme", type: "org" });
    const response = await wellKnown(`/.well-known/webfinger?resource=acct:acme@${HOST}`, "true");
    expect(response.status).toBe(200);
    const jrd = await response.json<{ aliases: string[] }>();
    expect(jrd.aliases[0]).toBe(`${ORIGIN}/acme`);
    expect(jrd.aliases[1]).toBe(`${ORIGIN}/api/v1/activitypub/user-id/${acme.id}`);
    // The org row has no email; with the public default (!KeepEmailPrivate)
    // upstream's unconditional append still emits the degenerate `mailto:`
    // alias (webfinger.go:91-93) — kept faithful.
    expect(jrd.aliases).toEqual([`${ORIGIN}/acme`, `${ORIGIN}/api/v1/activitypub/user-id/${acme.id}`, "mailto:"]);
  });

  it("mailto: the primary address resolves (the SPEC-0002 §3 synthesized primary)", async () => {
    await seedUser({ username: "alice", email: "alice@example.com" });
    const response = await wellKnown(
      `/.well-known/webfinger?resource=${encodeURIComponent("mailto:ALICE@EXAMPLE.COM")}`,
      "true",
    );
    expect(response.status).toBe(200);
    const jrd = await response.json<{ subject: string; aliases: string[] }>();
    expect(jrd.subject).toBe(`acct:alice@${HOST}`);
    expect(jrd.aliases).toContain("mailto:alice@example.com");
  });

  it("mailto: activated secondaries resolve, unactivated ones stay invisible (user.go:1381-1386)", async () => {
    const alice = await seedUser({ username: "alice", email: "alice@example.com" });
    await seedEmail(alice.id, "second@example.com", true);
    const activated = await wellKnown(
      `/.well-known/webfinger?resource=${encodeURIComponent("mailto:second@example.com")}`,
      "true",
    );
    expect(activated.status).toBe(200);

    await seedEmail(alice.id, "third@example.com", false);
    const unactivated = await wellKnown(
      `/.well-known/webfinger?resource=${encodeURIComponent("mailto:third@example.com")}`,
      "true",
    );
    expect(unactivated.status).toBe(404);
    expect(await unactivated.text()).toBe("Not Found\n");
  });

  it("mailto: the private-email suppression reads as not-exist (webfinger.go:65-67) and the alias disappears", async () => {
    const bob = await seedUser({ username: "bob", email: "bob@example.com", hideEmail: true });
    const byMail = await wellKnown(
      `/.well-known/webfinger?resource=${encodeURIComponent("mailto:bob@example.com")}`,
      "true",
    );
    expect(byMail.status).toBe(404);
    expect(await byMail.text()).toBe("Not Found\n");

    // The acct form still resolves — but the JRD omits the mailto alias.
    const byName = await wellKnown(`/.well-known/webfinger?resource=acct:bob@${HOST}`, "true");
    expect(byName.status).toBe(200);
    const jrd = await byName.json<{ aliases: string[] }>();
    expect(jrd.aliases).toEqual([
      `${ORIGIN}/bob`,
      `${ORIGIN}/api/v1/activitypub/user-id/${bob.id}`,
    ]);
  });

  it("mailto: the noreply arm of GetUserByEmail (user.go:1388-1394) — name and id+name forms", async () => {
    const alice = await seedUser({ username: "alice", email: "alice@example.com" });

    const byName = await wellKnown(
      `/.well-known/webfinger?resource=${encodeURIComponent(`mailto:alice@noreply.${HOST}`)}`,
      "true",
    );
    expect(byName.status).toBe(200);
    const byId = await wellKnown(
      `/.well-known/webfinger?resource=${encodeURIComponent(`mailto:${alice.id}+alice@noreply.${HOST}`)}`,
      "true",
    );
    expect(byId.status).toBe(200);

    // A noreply address naming nobody stays 404; the individual-only name arm
    // skips org rows (GetIndividualUserByName).
    const ghost = await wellKnown(
      `/.well-known/webfinger?resource=${encodeURIComponent(`mailto:ghost@noreply.${HOST}`)}`,
      "true",
    );
    expect(ghost.status).toBe(404);
    await seedUser({ username: "acme", type: "org" });
    const orgByNoreply = await wellKnown(
      `/.well-known/webfinger?resource=${encodeURIComponent(`mailto:acme@noreply.${HOST}`)}`,
      "true",
    );
    expect(orgByNoreply.status).toBe(404);
  });

  it("the visibility gate: private and limited users 404 the anonymous webfinger (webfinger.go:82-85)", async () => {
    await seedUser({ username: "carol", email: "carol@example.com", visibility: "private" });
    await seedUser({ username: "dave", email: "dave@example.com", visibility: "limited" });
    for (const name of ["carol", "dave"]) {
      const response = await wellKnown(`/.well-known/webfinger?resource=acct:${name}@${HOST}`, "true");
      expect(response.status, name).toBe(404);
      expect(await response.text(), name).toBe("Not Found\n");
    }
  });
});

describe("resolveWebfinger — the session-viewer arms (IsUserVisibleToViewer)", () => {
  it("a private user sees themself; an admin sees everyone; a limited user admits any signed-in doer", async () => {
    const carol = await seedUser({ username: "carol", email: "carol@example.com", visibility: "private" });
    await seedUser({ username: "dave", email: "dave@example.com", visibility: "limited" });

    const opts = { appUrl: `${ORIGIN}/`, host: HOST, noreplyDomain: HOST };

    const selfView = await resolveWebfinger(env.DB, `acct:carol@${HOST}`, { id: carol.id, isAdmin: false, loginLower: "carol" }, opts);
    expect(selfView.kind).toBe("found");

    const adminView = await resolveWebfinger(env.DB, `acct:carol@${HOST}`, { id: 999, isAdmin: true, loginLower: "root" }, opts);
    expect(adminView.kind).toBe("found");

    const signedInView = await resolveWebfinger(env.DB, `acct:dave@${HOST}`, { id: 999, isAdmin: false, loginLower: "eve" }, opts);
    expect(signedInView.kind).toBe("found");

    // The private row still hides from a signed-in stranger (the ladder's
    // follow/org arms are the landed predicate's own suite's).
    const strangerView = await resolveWebfinger(env.DB, `acct:carol@${HOST}`, { id: 999, isAdmin: false, loginLower: "eve" }, opts);
    expect(strangerView.kind).toBe("not-found");
  });
});

// ---------------------------------------------------------------------------
// The gated API stubs — api.go:1007-1010 + person.go:12-14
// ---------------------------------------------------------------------------

describe("the /api/v1 stubs — registration gate", () => {
  it("disabled: both arms answer the router's native 404 (unregistered at api.go:1007)", async () => {
    for (const federation of [undefined, "false"]) {
      const nodeinfo = await api("/nodeinfo", {}, { federation });
      expect(nodeinfo.status, "nodeinfo disabled").toBe(404);
      expect(await nodeinfo.text(), "nodeinfo disabled").toBe("404 Not Found");

      const activitypub = await api("/activitypub/user-id/1", { method: "POST" }, { federation });
      expect(activitypub.status, "activitypub disabled").toBe(404);
      expect(await activitypub.text(), "activitypub disabled").toBe("404 Not Found");
    }
  });
});

describe("the /api/v1 stubs — enabled: NotImplemented everywhere (person.go:12-14)", () => {
  it("GET /nodeinfo: Go http.Error's exact `Not implemented` line at 501", async () => {
    const response = await api("/nodeinfo", {}, { federation: "true" });
    expect(response.status).toBe(501);
    expect(await response.text()).toBe("Not implemented\n");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("ANY /activitypub/*: anonymous passes the scope gate to the 501 (api.go:281-283)", async () => {
    for (const attempt of [
      { path: "/activitypub/user-id/1", init: {} },
      { path: "/activitypub/user-id/1", init: { method: "POST" } },
      { path: "/activitypub/user-id/1/inbox", init: { method: "POST" } },
      { path: "/activitypub/anything/deeper/still", init: { method: "DELETE" } },
    ]) {
      const response = await api(attempt.path, attempt.init, { federation: "true" });
      expect(response.status, attempt.path).toBe(501);
      expect(await response.text(), attempt.path).toBe("Not implemented\n");
    }
  });

  it("the activitypub scope gate: a token without the category 403s with api.go:300's body", async () => {
    const response = await api("/activitypub/user-id/1", {}, { federation: "true", auth: authWithScope("read:repository") });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual(scopeForbidden("read:activitypub", "read:repository"));
  });

  it("a no-token-scope token 403s the gated arm while /nodeinfo stays gate-free", async () => {
    // /nodeinfo carries NO scope gate upstream (api.go:1008) — a tokened
    // caller stubs identically.
    const nodeinfo = await api("/nodeinfo", {}, { federation: "true", auth: authWithScope("read:repository") });
    expect(nodeinfo.status).toBe(501);

    // The scopeless credential (no-token-scope — the empty bitmap) fails
    // every gated path, as upstream and as the central table's semantics
    // (scope-gate.ts:58-59).
    const scopeless = await api("/activitypub/user-id/1", {}, { federation: "true", auth: authWithScope("no-token-scope") });
    expect(scopeless.status).toBe(403);
    expect(await scopeless.json()).toEqual(scopeForbidden("read:activitypub", "no-token-scope"));
  });

  it("the method-derived level: read passes GET, write required for POST (api.go:285-289)", async () => {
    const readGet = await api("/activitypub/user-id/1", {}, { federation: "true", auth: authWithScope("read:activitypub") });
    expect(readGet.status).toBe(501);

    const readPost = await api("/activitypub/user-id/1", { method: "POST" }, { federation: "true", auth: authWithScope("read:activitypub") });
    expect(readPost.status).toBe(403);
    expect(await readPost.json()).toEqual(scopeForbidden("write:activitypub", "read:activitypub"));

    const writePost = await api("/activitypub/user-id/1", { method: "POST" }, { federation: "true", auth: authWithScope("write:activitypub") });
    expect(writePost.status).toBe(501);

    // `all` carries every category at both levels.
    const allToken = await api("/activitypub/user-id/1", { method: "PUT" }, { federation: "true", auth: authWithScope("all") });
    expect(allToken.status).toBe(501);
  });
});
