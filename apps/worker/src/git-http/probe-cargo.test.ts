import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor, seedVerifiedUser } from "../auth/testing/seeds";
import { buildPack, buildReceivePackBody } from "../repos/testing/git-pack";
import { ensureCargoIndexMirror } from "../services/packages/cargo-index";

const RECEIVE_CT = "application/x-git-receive-pack-request";

describe("probe", () => {
  it("probes the cargo family", async () => {
    await applyAuthD1Migrations();
    const owner = await seedVerifiedUser({ username: "probealice" });
    const result = await ensureCargoIndexMirror({ repo: env.REPO, origin: "https://example.com" }, env.DB, owner.id);
    console.log("ensure result:", JSON.stringify(result));
    const refs = await env.REPO.getByName("probealice/_cargo-index").listRefs();
    console.log("cell refs:", JSON.stringify(refs.refs?.map((r) => r.name)));
    const res = await SELF.fetch("https://example.com/probealice/_cargo-index.git/info/refs?service=git-upload-pack");
    console.log("advert status:", res.status, res.headers.get("content-type"));
    console.log("advert body:", JSON.stringify(new TextDecoder().decode(await res.arrayBuffer()).slice(0, 200)));
    const reg = await env.REGISTRY.getByName("registry").get("probealice/_cargo-index");
    console.log("registry:", JSON.stringify(reg));
  });

  it("a first-ever _cargo-index push births the registry row ALREADY priv=1 — the write arm seeds BEFORE the forward (mod.ts:1399-1401)", async () => {
    await applyAuthD1Migrations();
    // The mirror cell is born registry-less (cargo-index.ts — NO
    // engine-registry entry, the wiki.ts storage convention) and this push is
    // the first protocol traffic the owner's cell ever sees: no read ever
    // seeded the row.
    const owner = await seedVerifiedUser({ username: "cargoseedalice" });
    await ensureCargoIndexMirror({ repo: env.REPO, origin: "https://example.com" }, env.DB, owner.id);
    const token = (await mintFor(owner.id, "w", "write:repository")).plaintext;
    const name = "cargoseedalice/_cargo-index";
    expect(await env.REGISTRY.getByName("registry").get(name)).toBeNull();

    const { oid, pack } = await buildPack();
    const push = await SELF.fetch(`https://example.com/cargoseedalice/_cargo-index.git/git-receive-pack`, {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": RECEIVE_CT },
      body: buildReceivePackBody([{ ref: "refs/heads/notes", oid }], pack),
    });
    expect(push.status).toBe(200);
    const refs = await env.REPO.getByName(name).listRefs();
    expect(refs.refs.map((r) => r.name)).toContain("refs/heads/notes");

    // The invariant: the engine's post-push bookkeeping upsert
    // (mod.ts:1399-1401) would INSERT the row at the DDL default 0 — listed
    // in every engine index, the hiding posture broken. The gate seeded it
    // priv=1 BEFORE the forward, so the engine's upsert rode its ON CONFLICT
    // arm (idle/ver only, registry.ts:37-44).
    const row = await env.REGISTRY.getByName("registry").get(name);
    expect(row).not.toBeNull();
    expect(row?.priv).toBe(1);
  });
});
