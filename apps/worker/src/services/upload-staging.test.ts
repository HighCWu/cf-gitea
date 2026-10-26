/**
 * The upload staging family's smoke (the PORT-FIRST wave: ONE happy path per
 * arm — the full matrix is a later polish wave):
 *
 *   1. upload-file  — a multipart `file` POST stages into REPO_PACKS under a
 *                     fresh uuid and answers `{"uuid"}` (editor_uploader.go).
 *   2. upload-remove — the `file`=<uuid> POST answers 204 and sweeps the
 *                     staged object (editor_uploader.go:51-60).
 *   3. UploadRepoFiles — `commitUploadFromForm` lands the staged file in a
 *                     SEEDED repo (docs/<name> on the branch, the default
 *                     `Upload files to "docs"` message) and sweeps the
 *                     staging (services/repository/files/upload.go:76-113).
 *
 * Real bindings (workerd): R2 = REPO_PACKS, D1 from the generated migrations,
 * the engine content through the receive-flow seed (ui/testing/seed-repo.ts).
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { applyAuthD1Migrations } from "../auth/testing/apply-d1-migrations";
import { engineReads } from "../api/services/engine";
import { repositories, users } from "../db/schema";
import { ensureSeededRepo, type SeedCommit } from "../ui/testing/seed-repo";
import {
  commitUploadFromForm,
  getRepoUploadByUUID,
  repoUploadKey,
  uploadFileToServer,
  uploadRemoveFromServer,
} from "./upload-staging";

// --- fixtures -----------------------------------------------------------------

const COMMITS: SeedCommit[] = [
  {
    message: "seed: readme",
    time: 1_700_000_000,
    files: [{ path: "README.md", content: "# upload staging seed\n" }],
  },
];

const stagedRequest = (fileName: string, content: string): Request => {
  const form = new FormData();
  form.set("file", new File([content], fileName, { type: "text/plain" }));
  return new Request("https://test.local/alice/upstage/upload-file", { method: "POST", body: form });
};

const removeRequest = (uuid: string): Request => {
  const form = new FormData();
  form.set("file", uuid);
  return new Request("https://test.local/alice/upstage/upload-remove", { method: "POST", body: form });
};

interface Fixture {
  repoRow: typeof repositories.$inferSelect;
  userRow: typeof users.$inferSelect;
}

let fixtures: Fixture | null = null;

async function ensureFixtures(): Promise<Fixture> {
  if (fixtures !== null) return fixtures;
  await applyAuthD1Migrations();
  await ensureSeededRepo({ owner: "alice", slug: "upstage", commits: COMMITS });
  const db = drizzle(env.DB);
  const repoRow = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, "alice"), eq(repositories.slug, "upstage")))
    .get();
  const userRow = await db.select().from(users).where(eq(users.usernameLower, "alice")).get();
  if (repoRow === undefined || userRow === undefined) throw new Error("upload-staging fixtures missing");
  fixtures = { repoRow, userRow };
  return fixtures;
}

// --- the three arms -----------------------------------------------------------

describe("upload staging family (smoke)", () => {
  beforeAll(async () => {
    await ensureFixtures();
  });

  it("upload-file stages a multipart file and answers {uuid}", async () => {
    const response = await uploadFileToServer(env.REPO_PACKS, stagedRequest("hello.txt", "staged bytes\n"));
    expect(response.status).toBe(200);
    const body = await response.json<{ uuid: string }>();
    expect(body.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const upload = await getRepoUploadByUUID(env.REPO_PACKS, body.uuid);
    expect(upload).not.toBeNull();
    expect(upload?.name).toBe("hello.txt");
    expect(upload?.size).toBe("staged bytes\n".length);
    const head = await env.REPO_PACKS.head(repoUploadKey(body.uuid));
    expect(head).not.toBeNull();
  });

  it("upload-remove answers 204 and sweeps the staged object", async () => {
    const staged = await uploadFileToServer(env.REPO_PACKS, stagedRequest("removeme.txt", "gone soon\n"));
    const { uuid } = await staged.json<{ uuid: string }>();
    expect(await env.REPO_PACKS.head(repoUploadKey(uuid))).not.toBeNull();

    const response = await uploadRemoveFromServer(env.REPO_PACKS, removeRequest(uuid));
    expect(response.status).toBe(204);
    expect(await env.REPO_PACKS.head(repoUploadKey(uuid))).toBeNull();
  });

  it("UploadRepoFiles commits a staged file into the seeded repo and sweeps staging", async () => {
    const { repoRow, userRow } = await ensureFixtures();
    const staged = await uploadFileToServer(env.REPO_PACKS, stagedRequest("hello.txt", "uploaded hello\n"));
    const { uuid } = await staged.json<{ uuid: string }>();

    const result = await commitUploadFromForm(env, new Request("https://test.local/alice/upstage/upload/main"), repoRow, userRow, {
      treePath: "docs",
      files: [uuid],
      summary: "",
      body: "",
      branch: "main",
    });
    expect(result.outcome).toBe("committed");
    if (result.outcome !== "committed") return;

    const reads = engineReads(env, { ownerNamespace: repoRow.ownerNamespace, slug: repoRow.slug });
    const blob = await reads.readBlob("main", "docs/hello.txt");
    expect(blob).not.toBeNull();
    expect(new TextDecoder().decode(blob?.data ?? new Uint8Array())).toBe("uploaded hello\n");
    // The landing commit's message is the PageIsUpload default (editor.go:467;
    // the engine's canonical serializer terminates the message with \n).
    const commit = await reads.readCommit(result.commitOid);
    expect(commit?.message).toBe('Upload files to "docs"\n');
    // The staging cleanup rode the commit (upload.go:108-113).
    expect(await env.REPO_PACKS.head(repoUploadKey(uuid))).toBeNull();
  });
});
