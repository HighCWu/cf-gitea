/**
 * The ⑳ L2/L3 resolve/render pins (v1.5.3, Wave J-2's salvage battery):
 * upstream's API `GetRawFileOrLFS` (routers/api/v1/repo/file.go:154-201) and
 * the web file view's `ReadMetaObject` swap (routers/web/repo/view.go:104-123)
 * — the pointer-probe + meta-row + object-store chain in
 * services/lfs/resolve.ts. The landed web /media arm (ui/pages/raw-files.ts)
 * keeps its own loader and is pinned in its own matrix; this battery covers
 * the API raw/media arms, the ContentsResponse lfs fields, and the file-view
 * page render through the real worker.
 */
import { SELF, env, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { seedVerifiedUser } from "../../auth/testing/seeds";
import { personalAccessTokens, repositories } from "../../db/schema";
import { ensureSeededRepo, type SeedCommit } from "../../ui/testing/seed-repo";
import { RelayLfsStore, lfsKey } from "../../services/lfs/store";
import { LfsStateService } from "../../services/lfs/state";
import { lfsRepoId } from "../../lfs/router";

const OWNER = "lfsview";
const SLUG = "lfs-resolve";
const TOKEN = "cfg_lfsvw1-salvage-battery-token";
const ORIGIN = "https://apisuite.test";

/** A pointer file's bytes (the .gitattributes posture). */
const pointerBytes = (oid: string, size: number): Uint8Array =>
  new TextEncoder().encode(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`);

const OBJECT_BYTES = new TextEncoder().encode("the actual stored LFS payload — not the pointer text\n");

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let OID = "";
let STORAGE_KEY = "";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await applyAuthD1Migrations();
  const owner = await seedVerifiedUser({ username: OWNER });

  OID = await sha256Hex(OBJECT_BYTES);
  const pointerText = (oid: string, size: number): string => new TextDecoder().decode(pointerBytes(oid, size));
  const commits: SeedCommit[] = [
    {
      message: "seed: lfs pointer",
      time: 1_770_000_000,
      files: [
        { path: "asset.bin", content: pointerText(OID, OBJECT_BYTES.byteLength) },
        { path: "ghost.bin", content: pointerText("f".repeat(64), 7) },
        { path: "plain.txt", content: "a plain file\n" },
      ],
    },
  ];
  // ensureSeededRepo arms the PUBLIC posture (its visibility flip) — the
  // anonymous page arm below rides it.
  await ensureSeededRepo({ owner: OWNER, slug: SLUG, commits });
  const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.slug, SLUG)).get();
  if (row === undefined) throw new Error("lfs-resolve repo row missing");
  STORAGE_KEY = row.storageKey;

  // The owner-verifiable object: the R2 store row + the lfs_objects meta row
  // (GetLFSMetaObjectByOid's lookup — the download arms' exact seeding).
  const store = new RelayLfsStore(env.REPO_PACKS);
  await store.put(lfsKey(STORAGE_KEY, OID), OBJECT_BYTES, {
    size: OBJECT_BYTES.byteLength,
    expectedSha256Hex: OID,
  });
  await new LfsStateService(env.DB).insertVerified(lfsRepoId(row.id), OID, OBJECT_BYTES.byteLength, new Date());

  // The owner's PAT row (SPEC-0002's table; the API arms' bearer).
  const digest = await sha256Hex(new TextEncoder().encode(TOKEN));
  await drizzle(env.DB).insert(personalAccessTokens).values({
    userId: owner.id,
    name: "lfsview-salvage",
    prefix: TOKEN.slice(0, 12),
    sha256Digest: digest,
    scopes: "all",
    createdAt: new Date(),
  });
});

const apiGet = (path: string): Promise<Response> =>
  SELF.fetch(new Request(`${ORIGIN}/api/v1${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }));

describe("GET /repos/{owner}/{repo}/raw (GetRawFileOrLFS — the ⑳ L2 pins)", () => {
  it("/raw serves the POINTER bytes verbatim — upstream's /raw is GetRawFile, NOT the LFS arm (api.go:1309 vs :1310)", async () => {
    const res = await apiGet(`/repos/${OWNER}/${SLUG}/raw/asset.bin`);
    expect(res.status).toBe(200);
    const body = new TextDecoder().decode(await res.arrayBuffer());
    expect(body).toContain(`oid sha256:${OID}`);
  });

  it("/media serves the stored OBJECT bytes for a pointer file (GetRawFileOrLFS, file.go:154-192)", async () => {
    const res = await apiGet(`/repos/${OWNER}/${SLUG}/media/asset.bin`);
    expect(res.status).toBe(200);
    const body = new TextDecoder().decode(await res.arrayBuffer());
    expect(body).toContain("the actual stored LFS payload");
    expect(body).not.toContain("git-lfs.github.com");
  });

  it("/media serves the pointer bytes verbatim when the meta row is absent (the dangling pointer — file.go:170-175)", async () => {
    const res = await apiGet(`/repos/${OWNER}/${SLUG}/media/ghost.bin`);
    expect(res.status).toBe(200);
    const body = new TextDecoder().decode(await res.arrayBuffer());
    expect(body).toContain(`oid sha256:${"f".repeat(64)}`);
  });

  it("a non-pointer file reads unchanged (the probe declines — content.go:249's window)", async () => {
    const res = await apiGet(`/repos/${OWNER}/${SLUG}/raw/plain.txt`);
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toContain("a plain file");
  });

  it("the ContentsResponse carries lfs_oid/lfs_size for the pointer file (content.go:249-260)", async () => {
    const res = await apiGet(`/repos/${OWNER}/${SLUG}/contents/asset.bin?ref=main`);
    expect(res.status).toBe(200);
    const body = await res.json<{ type: string; lfs_oid?: string; lfs_size?: number }>();
    expect(body.type).toBe("file");
    expect(body.lfs_oid).toBe(OID);
    expect(body.lfs_size).toBe(OBJECT_BYTES.byteLength);
  });
});

describe("the file view's LFS render (the ⑳ L3 pin — view.go:104-123's swap)", () => {
  it("the loader swaps the pointer for the OBJECT content when lfsEnv is threaded", async () => {
    const { loadFileViewData } = await import("../../ui/pages/file-view");
    const { engineReads } = await import("../services/engine");
    const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.slug, SLUG)).get();
    if (row === undefined) throw new Error("repo row missing");
    const repo = { ownerNamespace: OWNER, slug: SLUG, defaultBranch: "main", id: row.id, storageKey: row.storageKey };
    const data = await loadFileViewData(engineReads(env, repo), repo, ORIGIN, "branch/main/asset.bin", env);
    if (!("kind" in data) || data.kind !== "blob") throw new Error("expected blob view data");
    const rendered = JSON.stringify(data);
    expect(rendered).toContain("the actual stored LFS payload");
    expect(rendered).not.toContain("git-lfs.github.com/spec");
  });

  it("the loader keeps the pointer text when the meta row is absent (view.go:104-110's badge arm)", async () => {
    const { loadFileViewData } = await import("../../ui/pages/file-view");
    const { engineReads } = await import("../services/engine");
    const row = await drizzle(env.DB).select().from(repositories).where(eq(repositories.slug, SLUG)).get();
    if (row === undefined) throw new Error("repo row missing");
    const repo = { ownerNamespace: OWNER, slug: SLUG, defaultBranch: "main", id: row.id, storageKey: row.storageKey };
    const data = await loadFileViewData(engineReads(env, repo), repo, ORIGIN, "branch/main/ghost.bin", env);
    if (!("kind" in data) || data.kind !== "blob") throw new Error("expected blob view data");
    const rendered = JSON.stringify(data);
    expect(rendered).toContain("git-lfs.github.com/spec");
  });
});
