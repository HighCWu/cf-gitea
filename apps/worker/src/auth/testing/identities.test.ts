/**
 * The multi-identity test rig's own suite (src/auth/testing/identities.ts —
 * the wave-36 capability gap: the stock stub resolver maps ANY token to
 * STUB_USER, so stranger-vs-owner differentials were untestable).
 *
 * Proven here:
 *  1. `seedIdentity` mints DISTINCT real identities (real users rows + real
 *     TokenService tokens — each token verifies through the production
 *     service to its own user);
 *  2. `createIdentityAuthResolver()`'s default arm is byte-identical to
 *     `createStubAuthResolver()` — the same STUB_USER object for any token;
 *  3. mapped tokens resolve their identity, unmapped keep the default, and
 *     the whole thing rides the REAL resolver chain over the full
 *     `createApiRouter({ auth })` seam (header-parse → middleware →
 *     resolveToken, asserted through GET /user's echoed doer);
 *  4. a genuine two-identity differential end-to-end: the user-block octet
 *     (A blocks B → A's list shows B, B's list is empty, the check routes
 *     disagree per doer) — the class of multi-user arm the old rig could
 *     not express.
 */

import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { STUB_USER, createStubAuthResolver } from "../../api/auth";
import { createApiRouter } from "../../api/router";
import { TokenService } from "../token-service";
import { applyAuthD1Migrations } from "./apply-d1-migrations";
import { createIdentityAuthResolver, seedIdentity, tokenHeader } from "./identities";
import { resetAuthTables } from "./seeds";

beforeAll(applyAuthD1Migrations);

beforeEach(resetAuthTables);

const fetchApi =
  (app: ReturnType<typeof createApiRouter>) =>
  async (path: string, init?: RequestInit): Promise<Response> =>
    app.fetch(new Request(`https://example.com${path}`, init), env);

describe("seedIdentity — the multi-identity mint", () => {
  it("mints distinct identities: distinct rows, distinct real tokens, truthful projections", async () => {
    const alice = await seedIdentity({ username: "alice" });
    const bob = await seedIdentity({ username: "bob" });

    expect(alice.id).not.toBe(bob.id);
    expect(alice.token).not.toBe(bob.token);
    expect(alice.user).toMatchObject({ id: alice.id, login: "alice", is_admin: false, active: true });
    expect(bob.user).toMatchObject({ id: bob.id, login: "bob" });
  });

  it("issues REAL tokens — each verifies through the production TokenService to its own user", async () => {
    const admin = await seedIdentity({ username: "root", isAdmin: true });
    const peer = await seedIdentity({ username: "peer" });

    const adminVerified = await new TokenService(env.DB).verify(admin.token);
    const peerVerified = await new TokenService(env.DB).verify(peer.token);
    expect(adminVerified?.user.id).toBe(admin.id);
    expect(adminVerified?.user.isAdmin).toBe(true);
    expect(peerVerified?.user.id).toBe(peer.id);
    // the projection matches what the production chain would project
    expect(admin.user.is_admin).toBe(true);
    expect(peer.user.is_admin).toBe(false);
  });
});

describe("createIdentityAuthResolver — the seam resolver", () => {
  it("with no map, the default arm is byte-identical to the stock stub resolver", async () => {
    const stock = createStubAuthResolver();
    const rig = createIdentityAuthResolver();
    const rigEmpty = createIdentityAuthResolver({});
    for (const token of ["stub-token", "cfg_some-opaque-value", ""]) {
      expect(await rig.resolveToken(token)).toBe(STUB_USER);
      expect(await rigEmpty.resolveToken(token)).toBe(STUB_USER);
      // the same object the production stub hands back — not a lookalike
      expect(await rig.resolveToken(token)).toBe(await stock.resolveToken(token));
    }
  });

  it("mapped tokens resolve their identity; every other token keeps the stub default", async () => {
    const stranger = await seedIdentity({ username: "stranger" });
    const resolver = createIdentityAuthResolver({ [stranger.token]: stranger.user });

    expect(await resolver.resolveToken(stranger.token)).toBe(stranger.user);
    expect(await resolver.resolveToken("stub-token")).toBe(STUB_USER);
    expect(await resolver.resolveToken("some-unmapped-token")).toBe(STUB_USER);
  });
});

describe("the rig rides the real resolver chain over the full router", () => {
  it("each token resolves its own doer through header-parse → middleware → resolveToken", async () => {
    const alice = await seedIdentity({ username: "alice" });
    const bob = await seedIdentity({ username: "bob" });
    const app = createApiRouter({
      auth: createIdentityAuthResolver({ [alice.token]: alice.user, [bob.token]: bob.user }),
    });
    const get = fetchApi(app);

    const asAlice = await get("/user", { headers: tokenHeader(alice) });
    expect(asAlice.status).toBe(200);
    expect(await asAlice.json<{ login: string }>()).toMatchObject({ id: alice.id, login: "alice" });

    const asBob = await get("/user", { headers: tokenHeader(bob) });
    expect(asBob.status).toBe(200);
    expect(await asBob.json<{ login: string }>()).toMatchObject({ id: bob.id, login: "bob" });

    // the default identity still answers unmapped tokens
    const asStub = await get("/user", { headers: { Authorization: "token stub-token" } });
    expect(asStub.status).toBe(200);
    expect(await asStub.json<{ login: string }>()).toMatchObject({ login: STUB_USER.login });

    // and the 401 shape is the middleware's, not the rig's
    const anon = await get("/user");
    expect(anon.status).toBe(401);
    expect(await anon.json<{ message: string }>()).toMatchObject({ message: "token is required" });
  });
});

describe("two-identity differential — the user-block octet over the full router", () => {
  it("A blocks B: A's list shows B, B's list is empty, the check routes disagree per doer", async () => {
    const alice = await seedIdentity({ username: "alice" });
    const bob = await seedIdentity({ username: "bob" });
    const app = createApiRouter({
      auth: createIdentityAuthResolver({ [alice.token]: alice.user, [bob.token]: bob.user }),
    });
    const call = fetchApi(app);
    const jsonHeaders = { headers: { ...tokenHeader(alice), "Content-Type": "application/json" } };

    const before = await call("/user/blocks/bob", { headers: tokenHeader(alice) });
    expect(before.status).toBe(404); // not blocked yet
    const put = await call("/user/blocks/bob", { method: "PUT", ...jsonHeaders });
    expect(put.status).toBe(204);

    // the blocker sees the blockee; the blockee's own list stays empty
    const aliceList = await call("/user/blocks", { headers: tokenHeader(alice) });
    expect(aliceList.status).toBe(200);
    const aliceItems = await aliceList.json<Array<{ login: string }>>();
    expect(aliceItems.map((u) => u.login)).toEqual(["bob"]);

    const bobList = await call("/user/blocks", { headers: tokenHeader(bob) });
    expect(bobList.status).toBe(200);
    expect(await bobList.json<unknown[]>()).toEqual([]);

    // the check routes disagree per doer — the multi-identity arm
    const aliceChecks = await call("/user/blocks/bob", { headers: tokenHeader(alice) });
    expect(aliceChecks.status).toBe(204);
    const bobChecks = await call("/user/blocks/alice", { headers: tokenHeader(bob) });
    expect(bobChecks.status).toBe(404);
  });
});
