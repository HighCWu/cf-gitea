import { SELF, env } from "cloudflare:test";
import { describe, it } from "vitest";
import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../auth/testing/seeds";
import { ensureCargoIndexMirror } from "../services/packages/cargo-index";

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
});
