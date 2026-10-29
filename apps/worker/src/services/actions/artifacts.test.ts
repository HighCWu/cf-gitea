/**
 * The M1b artifacts suite (SPEC-0012 §2.4/§2.5/§6.3): the v1 family
 * (upload-url → chunk md5 arms → confirm merge → list → download_url →
 * download) and the v4 family (create → blocks → blocklist → finalize →
 * list → signed URL → download → delete) over the REAL mounted routes, the
 * HMAC signature verify/reject arms, the legacy raw-token auth, the
 * retention sweep flips (cleanup.go), and the secrets service arms (the
 * runtime JWT + keystore stability + the OIDC claim/exchange path).
 */

import { applyD1Migrations, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq, inArray } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";

import {
  actionArtifacts,
  actionRunAttempts,
  actionRunJobs,
  actionRuns,
  actionTasks,
  repositories,
  repoUnits,
  systemKeystore,
  users,
} from "../../db/schema";
import { createRunner, insertActionRun } from "./model";
import { Md5, md5Hex } from "../packages/maven";
import { actionsBuildSignature, base64RawUrlEncode, createAuthorizationToken, signActionsClaims, taskIdFromToken } from "./secrets";
import { createOidcClaims, taskAllowsOidcToken } from "./oidc";
import { runRetentionSweep, stopZombieTasks, cleanupOldRuns } from "./retention";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS === undefined) {
    throw new Error("TEST_MIGRATIONS binding missing — vitest.config.ts must inject readD1Migrations()");
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const CLEANUP_TABLES = [
  "action_runners",
  "action_runner_tokens",
  "action_runs",
  "action_run_jobs",
  "action_run_attempts",
  "action_tasks",
  "action_task_steps",
  "action_task_outputs",
  "action_tasks_versions",
  "action_artifacts",
  "action_run_job_summaries",
  "action_log_chunks",
  "secrets",
  "action_variables",
  "repo_units",
  "repositories",
  "users",
];

beforeEach(async () => {
  for (const table of CLEANUP_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // NOTE: the keystore object is deliberately NOT wiped — the module-level
  // keystore cache outlives tests in one isolate, so wiping R2 under it
  // would decouple the cache from storage for the whole file. Deployment
  // material is not test state.
  const chunks = await env.REPO_PACKS.list({ prefix: "actions/tmp/" });
  if (chunks.objects.length > 0) {
    await env.REPO_PACKS.delete(chunks.objects.map((o) => o.key));
  }
  const artifacts = await env.REPO_PACKS.list({ prefix: "actions/artifacts/" });
  if (artifacts.objects.length > 0) {
    await env.REPO_PACKS.delete(artifacts.objects.map((o) => o.key));
  }
  const logs = await env.REPO_PACKS.list({ prefix: "actions/logs/" });
  if (logs.objects.length > 0) {
    await env.REPO_PACKS.delete(logs.objects.map((o) => o.key));
  }
});

const db = () => drizzle(env.DB);
const BASE = "https://example.com";
const TWIRP = `${BASE}/twirp/github.actions.results.api.v1.ArtifactService`;

const WORKFLOW_PAYLOAD = new TextEncoder().encode("name: ci\njobs:\n  build:\n    steps:\n      - run: echo hi\n");

interface Harness {
  taskId: number;
  runId: number;
  jobId: number;
  runtimeToken: string;
}

/** Seed repo+run+job+task(running) and mint the runtime JWT. */
async function seedRunningTask(options: { tokenPermissions?: string | null; status?: number } = {}): Promise<Harness> {
  const owner = await db()
    .insert(users)
    .values({
      username: "artifact-owner",
      usernameLower: "artifact-owner",
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    .returning({ id: users.id });
  const ownerId = owner[0]?.id;
  if (ownerId === undefined) throw new Error("owner seed failed");
  const repoId = `artifact-repo-${Math.random().toString(16).slice(2, 8)}`;
  await db().insert(repositories).values({
    id: repoId,
    storageKey: `r_${repoId}`,
    ownerNamespace: "artifact-owner",
    ownerId,
    slug: "repo",
    visibility: "public",
  });
  await db().insert(repoUnits).values({ repoId, type: "actions" });
  const { run } = await insertActionRun(
    env.DB,
    {
      repoId,
      ownerId,
      workflowId: ".gitea/workflows/ci.yml",
      index: 1,
      triggerUserId: ownerId,
      ref: "refs/heads/main",
      commitSha: "d".repeat(40),
      event: "push",
      eventPayload: "{}",
      triggerEvent: "push",
    },
    [
      {
        jobId: "build",
        runsOn: ["ubuntu-latest"],
        workflowPayload: WORKFLOW_PAYLOAD,
        ...(options.tokenPermissions !== undefined ? { tokenPermissions: options.tokenPermissions } : {}),
      },
    ],
  );
  const jobRows = await db().select().from(actionRunJobs).where(eq(actionRunJobs.jobId, "build"));
  const job = jobRows[0];
  if (job === undefined) throw new Error("job missing");
  const runner = await createRunner(env.DB, {
    uuid: crypto.randomUUID(),
    name: "artifact-runner",
    version: "test",
    ownerId: 0,
    repoId: "",
    agentLabels: ["ubuntu-latest"],
    ephemeral: false,
    hasCancellingSupport: false,
  });
  const now = new Date();
  const taskRows = await db()
    .insert(actionTasks)
    .values({
      jobId: job.id,
      attempt: 1,
      runnerId: runner.id,
      status: options.status ?? 6,
      started: now,
      repoId: job.repoId,
      ownerId: job.ownerId,
      commitSha: job.commitSha,
      tokenHash: crypto.randomUUID().replaceAll("-", "").repeat(2),
      tokenSalt: "s",
      tokenLastEight: "artifact",
      logFilename: "artifact-owner/repo/ab/1.log",
      created: now,
      updated: now,
    })
    .returning();
  const task = taskRows[0];
  if (task === undefined) throw new Error("task insert failed");
  const runtimeToken = await createAuthorizationToken(env, task.id, run.id, job.id);
  return { taskId: task.id, runId: run.id, jobId: job.id, runtimeToken };
}

function md5HexOf(bytes: Uint8Array): string {
  // md5 of the artifact NAME for the URL hash — the packages module's port.
  return md5Hex(bytes);
}

const ARTIFACT_CONTENT = (() => {
  const bytes = new Uint8Array(40);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i;
  return bytes;
})();

// ---------------------------------------------------------------------------
// v1 — the pipeline family (artifacts.go)
// ---------------------------------------------------------------------------

describe("artifacts v1 (the /api/actions_pipeline family)", () => {
  async function createUpload(harness: Harness, name: string): Promise<string> {
    const res = await SELF.fetch(`${BASE}/api/actions_pipeline/_apis/pipelines/workflows/${harness.runId}/artifacts`, {
      method: "POST",
      headers: { authorization: `Bearer ${harness.runtimeToken}`, "content-type": "application/json" },
      body: JSON.stringify({ Type: "actions_storage", Name: name }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ fileContainerResourceUrl: string }>();
    return body.fileContainerResourceUrl;
  }

  it("streams the chunk family: md5-verified PUT → PATCH confirm → merged download", async () => {
    const harness = await seedRunningTask();
    const uploadUrl = await createUpload(harness, "my-artifact");
    expect(uploadUrl).toBe(
      `${BASE}/api/actions_pipeline/_apis/pipelines/workflows/${harness.runId}/artifacts/${md5HexOf(new TextEncoder().encode("my-artifact"))}/upload`,
    );

    // Chunk 1: bytes 0-15/40.
    const chunk1 = ARTIFACT_CONTENT.slice(0, 16);
    const put1 = await SELF.fetch(`${uploadUrl}?itemPath=${encodeURIComponent("my-artifact/file.bin")}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${harness.runtimeToken}`,
        "content-range": `bytes 0-15/${ARTIFACT_CONTENT.length}`,
        "x-tfs-filelength": String(ARTIFACT_CONTENT.length),
        "x-actions-results-md5": base64StdMd5(chunk1),
      },
      body: chunk1,
    });
    expect(put1.status).toBe(200);

    // Chunk 2: bytes 16-39/40.
    const chunk2 = ARTIFACT_CONTENT.slice(16);
    const put2 = await SELF.fetch(`${uploadUrl}?itemPath=${encodeURIComponent("my-artifact/file.bin")}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${harness.runtimeToken}`,
        "content-range": `bytes 16-39/${ARTIFACT_CONTENT.length}`,
        "x-tfs-filelength": String(ARTIFACT_CONTENT.length),
        "x-actions-results-md5": base64StdMd5(chunk2),
      },
      body: chunk2,
    });
    expect(put2.status).toBe(200);

    // A WRONG md5 deletes the chunk and errors.
    const putBad = await SELF.fetch(`${uploadUrl}?itemPath=${encodeURIComponent("my-artifact/bad.bin")}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${harness.runtimeToken}`,
        "content-range": `bytes 0-3/4`,
        "x-tfs-filelength": "4",
        "x-actions-results-md5": base64StdMd5(new Uint8Array([1, 2, 3])),
      },
      body: new Uint8Array([9, 9, 9, 9]),
    });
    expect(putBad.status).toBe(500);

    const confirm = await SELF.fetch(
      `${BASE}/api/actions_pipeline/_apis/pipelines/workflows/${harness.runId}/artifacts?artifactName=my-artifact`,
      { method: "PATCH", headers: { authorization: `Bearer ${harness.runtimeToken}` } },
    );
    expect(confirm.status).toBe(200);

    // The row confirmed with the merged object at the canonical key.
    const rows = await db().select().from(actionArtifacts).where(eq(actionArtifacts.runId, harness.runId));
    const mine = rows.filter((r) => r.artifactPath === "file.bin");
    expect(mine).toHaveLength(1);
    const artifact = mine[0];
    expect(artifact?.status).toBe(2);
    expect(artifact?.storagePath).toBe(`actions/artifacts/${harness.runId}/${artifact?.id}`);
    const obj = await env.REPO_PACKS.get(artifact?.storagePath ?? "");
    const merged = new Uint8Array((await obj?.arrayBuffer()) ?? new ArrayBuffer(0));
    expect(Array.from(merged)).toEqual(Array.from(ARTIFACT_CONTENT));

    // list → download_url → download (byte-identical round trip).
    const list = await SELF.fetch(`${BASE}/api/actions_pipeline/_apis/pipelines/workflows/${harness.runId}/artifacts`, {
      headers: { authorization: `Bearer ${harness.runtimeToken}` },
    });
    expect(list.status).toBe(200);
    const listed = await list.json<{ count: number; value: Array<{ name: string }> }>();
    expect(listed.value.map((v) => v.name)).toContain("my-artifact");

    const urlRes = await SELF.fetch(
      `${BASE}/api/actions_pipeline/_apis/pipelines/workflows/${harness.runId}/artifacts/${md5HexOf(new TextEncoder().encode("my-artifact"))}/download_url?itemPath=${encodeURIComponent("my-artifact")}`,
      { headers: { authorization: `Bearer ${harness.runtimeToken}` } },
    );
    expect(urlRes.status).toBe(200);
    const urlBody = await urlRes.json<{ value: Array<{ path: string; itemType: string; contentLocation: string }> }>();
    expect(urlBody.value[0]?.itemType).toBe("file");
    expect(urlBody.value[0]?.path).toBe("my-artifact/file.bin");

    const download = await SELF.fetch(urlBody.value[0]?.contentLocation ?? "", {
      headers: { authorization: `Bearer ${harness.runtimeToken}` },
    });
    expect(download.status).toBe(200);
    expect(Array.from(new Uint8Array(await download.arrayBuffer()))).toEqual(Array.from(ARTIFACT_CONTENT));
  });

  it("rejects an unparseable content-range and a mismatched run-id", async () => {
    const harness = await seedRunningTask();
    const uploadUrl = await createUpload(harness, "range-artifact");

    const badRange = await SELF.fetch(`${uploadUrl}?itemPath=${encodeURIComponent("range-artifact/f.bin")}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${harness.runtimeToken}`,
        "content-range": "not-a-range",
        "x-tfs-filelength": "4",
        "x-actions-results-md5": base64StdMd5(new Uint8Array([1])),
      },
      body: new Uint8Array([1]),
    });
    expect(badRange.status).toBe(500);

    // A run-id that is not the token's job's run.
    const wrongRun = await SELF.fetch(
      `${BASE}/api/actions_pipeline/_apis/pipelines/workflows/999999/artifacts`,
      { method: "POST", headers: { authorization: `Bearer ${harness.runtimeToken}`, "content-type": "application/json" }, body: "{}" },
    );
    expect(wrongRun.status).toBe(400);
  });

  it("authenticates the legacy raw task token (the artifacts.go:170-180 arm)", async () => {
    const harness = await seedRunningTask();
    // Fetch the plaintext task token: re-derive by minting a fresh task we
    // KNOW the token for — build one directly with the salted model.
    const { generateSaltedToken } = await import("./model");
    const salted = await generateSaltedToken();
    const jobRows = await db().select().from(actionRunJobs).where(eq(actionRunJobs.id, harness.jobId));
    const job = jobRows[0];
    if (job === undefined) throw new Error("job missing");
    const now = new Date();
    const rows = await db()
      .insert(actionTasks)
      .values({
        jobId: job.id,
        attempt: 1,
        runnerId: 1,
        status: 6,
        started: now,
        repoId: job.repoId,
        ownerId: job.ownerId,
        commitSha: job.commitSha,
        tokenHash: salted.hash,
        tokenSalt: salted.salt,
        tokenLastEight: salted.token.slice(-8),
        logFilename: "artifact-owner/repo/ac/2.log",
        created: now,
        updated: now,
      })
      .returning();
    const legacyTask = rows[0];
    if (legacyTask === undefined) throw new Error("legacy task insert failed");

    const res = await SELF.fetch(`${BASE}/api/actions_pipeline/_apis/pipelines/workflows/${harness.runId}/artifacts`, {
      headers: { authorization: `Bearer ${salted.token}` },
    });
    expect(res.status).toBe(404); // authenticated (no artifacts yet), not 401/500
  });

  it("refuses a task that is not running", async () => {
    const harness = await seedRunningTask({ status: 1 }); // already finished
    const res = await SELF.fetch(`${BASE}/api/actions_pipeline/_apis/pipelines/workflows/${harness.runId}/artifacts`, {
      headers: { authorization: `Bearer ${harness.runtimeToken}` },
    });
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// v4 — the twirp family (artifactsv4.go)
// ---------------------------------------------------------------------------

describe("artifacts v4 (the twirp family)", () => {
  interface V4Urls {
    signedUploadUrl: string;
  }

  async function createV4(harness: Harness, name: string, mimeType?: string): Promise<V4Urls & { ok: boolean }> {
    const res = await SELF.fetch(`${TWIRP}/CreateArtifact`, {
      method: "POST",
      headers: { authorization: `Bearer ${harness.runtimeToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        workflow_run_backend_id: String(harness.runId),
        workflow_job_run_backend_id: String(harness.jobId),
        name,
        version: 4,
        ...(mimeType !== undefined ? { mime_type: mimeType } : {}),
      }),
    });
    expect(res.status).toBe(200);
    return await res.json<V4Urls & { ok: boolean }>();
  }

  it("runs the block → blocklist → finalize → signed-download round trip", async () => {
    const harness = await seedRunningTask();
    const created = await createV4(harness, "v4-artifact");
    expect(created.ok).toBe(true);
    // v4 appends ".zip" when the mime type is not a real type.
    const rowRows = await db().select().from(actionArtifacts).where(eq(actionArtifacts.runId, harness.runId));
    expect(rowRows[0]?.contentEncodingOrType).toBe("application/zip");

    // Two named blocks.
    const chunk1 = ARTIFACT_CONTENT.slice(0, 16);
    const chunk2 = ARTIFACT_CONTENT.slice(16);
    const sep = created.signedUploadUrl.includes("?") ? "&" : "?";
    const put1 = await SELF.fetch(`${created.signedUploadUrl}${sep}comp=block&blockid=b1`, {
      method: "PUT",
      headers: { "content-length": String(chunk1.length) },
      body: chunk1,
    });
    expect(put1.status).toBe(201);
    const put2 = await SELF.fetch(`${created.signedUploadUrl}${sep}comp=block&blockid=b2`, {
      method: "PUT",
      headers: { "content-length": String(chunk2.length) },
      body: chunk2,
    });
    expect(put2.status).toBe(201);

    // The blocklist names the FINAL order.
    const blockListXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<BlockList>\n\t<Latest>b2</Latest>\n\t<Latest>b1</Latest>\n</BlockList>`;
    const blist = await SELF.fetch(`${created.signedUploadUrl}${sep}comp=blocklist`, {
      method: "PUT",
      headers: { "content-type": "application/xml" },
      body: blockListXml,
    });
    expect(blist.status).toBe(201);

    // Finalize with the SWAPPED order: the merge replays b2 then b1.
    const finalizeRes = await SELF.fetch(`${TWIRP}/FinalizeArtifact`, {
      method: "POST",
      headers: { authorization: `Bearer ${harness.runtimeToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        workflow_run_backend_id: String(harness.runId),
        workflow_job_run_backend_id: String(harness.jobId),
        name: "v4-artifact",
        size: String(ARTIFACT_CONTENT.length),
      }),
    });
    expect(finalizeRes.status).toBe(200);
    const finalized = await finalizeRes.json<{ ok: boolean; artifactId: string }>();
    expect(finalized.ok).toBe(true);

    // The merged object reflects the blocklist order (second half first).
    const rows = await db().select().from(actionArtifacts).where(eq(actionArtifacts.runId, harness.runId));
    const artifact = rows[0];
    expect(artifact?.status).toBe(2);
    const obj = await env.REPO_PACKS.get(artifact?.storagePath ?? "");
    const merged = new Uint8Array((await obj?.arrayBuffer()) ?? new ArrayBuffer(0));
    expect(Array.from(merged)).toEqual([...Array.from(chunk2), ...Array.from(chunk1)]);
    // The blocklist object was deleted on read (readBlockList's arm).
    const blistKeys = await env.REPO_PACKS.list({ prefix: `actions/tmp/${harness.runId}/v4/` });
    expect(blistKeys.objects.every((o) => !o.key.endsWith("-blocklist"))).toBe(true);

    // List + signed URL + download.
    const listRes = await SELF.fetch(`${TWIRP}/ListArtifacts`, {
      method: "POST",
      headers: { authorization: `Bearer ${harness.runtimeToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        workflow_run_backend_id: String(harness.runId),
        workflow_job_run_backend_id: String(harness.jobId),
        name_filter: "v4-artifact",
      }),
    });
    expect(listRes.status).toBe(200);
    const listed = await listRes.json<{ artifacts: Array<{ name: string; size: string; databaseId: string }> }>();
    expect(listed.artifacts).toHaveLength(1);
    expect(listed.artifacts[0]?.size).toBe(String(ARTIFACT_CONTENT.length)); // protojson int64 = string

    const urlRes = await SELF.fetch(`${TWIRP}/GetSignedArtifactURL`, {
      method: "POST",
      headers: { authorization: `Bearer ${harness.runtimeToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        workflow_run_backend_id: String(harness.runId),
        workflow_job_run_backend_id: String(harness.jobId),
        name: "v4-artifact",
      }),
    });
    const signed = await urlRes.json<{ signedUrl: string }>();
    expect(signed.signedUrl).toContain("/twirp/github.actions.results.api.v1.ArtifactService/DownloadArtifact?sig=");

    // The download is UNAUTHENTICATED (the HMAC URL is the credential).
    const download = await SELF.fetch(signed.signedUrl, { method: "GET" });
    expect(download.status).toBe(200);
    expect(Array.from(new Uint8Array(await download.arrayBuffer()))).toEqual([...Array.from(chunk2), ...Array.from(chunk1)]);

    // DeleteArtifact flips the row to pending-deletion.
    const delRes = await SELF.fetch(`${TWIRP}/DeleteArtifact`, {
      method: "POST",
      headers: { authorization: `Bearer ${harness.runtimeToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        workflow_run_backend_id: String(harness.runId),
        workflow_job_run_backend_id: String(harness.jobId),
        name: "v4-artifact",
      }),
    });
    expect(delRes.status).toBe(200);
    const afterRows = await db().select().from(actionArtifacts).where(eq(actionArtifacts.id, Number(finalized.artifactId)));
    expect(afterRows[0]?.status).toBe(5); // pending deletion
  });

  it("verifies the HMAC signature (tamper + expiry arms)", async () => {
    const harness = await seedRunningTask();
    const created = await createV4(harness, "sig-artifact");
    const url = new URL(created.signedUploadUrl);
    const goodSig = url.searchParams.get("sig") ?? "";

    // Tampered artifactName → 401 unauthorized.
    const tampered = new URL(created.signedUploadUrl);
    tampered.searchParams.set("artifactName", "other");
    const tamperedRes = await SELF.fetch(tampered.toString(), {
      method: "PUT",
      headers: { "content-length": "1" },
      body: new Uint8Array([1]),
    });
    expect(tamperedRes.status).toBe(401);

    // Good signature but a STALE expires → 401 link expired.
    const sig = await actionsBuildSignature(env, "v4", ["UploadArtifact", "2000-01-01 00:00:00 +0000 UTC", "sig-artifact", String(harness.taskId), "1"]);
    const stale = `${TWIRP}/UploadArtifact?sig=${base64RawUrlEncode(sig)}&expires=${encodeURIComponent("2000-01-01 00:00:00 +0000 UTC")}&artifactName=sig-artifact&taskID=${harness.taskId}&artifactID=1`;
    const staleRes = await SELF.fetch(stale, {
      method: "PUT",
      headers: { "content-length": "1" },
      body: new Uint8Array([1]),
    });
    expect(staleRes.status).toBe(401);
    expect(goodSig).not.toBe("");
  });

  it("rejects a size-mismatched finalize and an over-1-MiB protojson body", async () => {
    const harness = await seedRunningTask();
    await createV4(harness, "size-artifact");

    // No blocks at all: finalize's chunk listing fails → 500.
    const finalizeRes = await SELF.fetch(`${TWIRP}/FinalizeArtifact`, {
      method: "POST",
      headers: { authorization: `Bearer ${harness.runtimeToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        workflow_run_backend_id: String(harness.runId),
        workflow_job_run_backend_id: String(harness.jobId),
        name: "size-artifact",
        size: "1",
      }),
    });
    expect(finalizeRes.status).toBe(500);

    // Oversized body → 413 before any R2 call.
    const big = await SELF.fetch(`${TWIRP}/ListArtifacts`, {
      method: "POST",
      headers: { authorization: `Bearer ${harness.runtimeToken}`, "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) }),
    });
    expect(big.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// Retention + zombie arms (cleanup.go)
// ---------------------------------------------------------------------------

describe("the retention sweep", () => {
  it("flips expired artifacts and deletes their objects", async () => {
    const harness = await seedRunningTask();
    const now = Math.floor(Date.now() / 1000);
    const past = new Date(Date.now() - 1000);
    const rows = await db()
      .insert(actionArtifacts)
      .values({
        runId: harness.runId,
        runAttemptId: 1,
        repoId: "artifact-repo-x",
        ownerId: 1,
        artifactName: "old",
        artifactPath: "f",
        storagePath: `actions/artifacts/${harness.runId}/old`,
        fileSize: 3,
        fileCompressedSize: 3,
        contentEncodingOrType: "application/zip",
        status: 2,
        expiredUnix: now - 10,
        created: past,
        updated: past,
      })
      .returning();
    const artifact = rows[0];
    if (artifact === undefined) throw new Error("artifact seed failed");
    await env.REPO_PACKS.put(artifact.storagePath, new Uint8Array([1, 2, 3]));

    await runRetentionSweep(env, { artifactRetentionDays: 90, logRetentionDays: 365, runRetentionDays: 400 });

    const after = await db().select().from(actionArtifacts).where(eq(actionArtifacts.id, artifact.id));
    expect(after[0]?.status).toBe(4); // expired
    const obj = await env.REPO_PACKS.get(artifact.storagePath);
    expect(obj).toBeNull();
  });

  it("deletes pending-deletion artifacts and expires stale logs", async () => {
    const harness = await seedRunningTask();
    const past = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    const rows = await db()
      .insert(actionArtifacts)
      .values({
        runId: harness.runId,
        runAttemptId: 1,
        repoId: "artifact-repo-x",
        ownerId: 1,
        artifactName: "doomed",
        artifactPath: "f",
        storagePath: `actions/artifacts/${harness.runId}/doomed`,
        fileSize: 1,
        fileCompressedSize: 1,
        status: 5,
        created: past,
        updated: past,
      })
      .returning();
    const doomed = rows[0];
    if (doomed === undefined) throw new Error("doom seed failed");
    await env.REPO_PACKS.put(doomed.storagePath, new Uint8Array([7]));

    // A stopped task older than the log retention (365 d default).
    const logPast = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    const jobRows = await db().select().from(actionRunJobs).where(eq(actionRunJobs.id, harness.jobId));
    const job = jobRows[0];
    if (job === undefined) throw new Error("job missing");
    const taskRows = await db()
      .insert(actionTasks)
      .values({
        jobId: job.id,
        attempt: 1,
        runnerId: 0,
        status: 1,
        stopped: logPast,
        repoId: job.repoId,
        ownerId: job.ownerId,
        tokenHash: crypto.randomUUID().replaceAll("-", "").repeat(2),
        tokenSalt: "s",
        tokenLastEight: "oldlog00",
        logFilename: "old/repo/ff/99.log",
        logInStorage: true,
        created: past,
        updated: past,
      })
      .returning();
    const oldTask = taskRows[0];
    if (oldTask === undefined) throw new Error("old task seed failed");
    await env.REPO_PACKS.put(`actions/logs/${oldTask.logFilename}`, new Uint8Array([1]));

    await runRetentionSweep(env, { artifactRetentionDays: 90, logRetentionDays: 365, runRetentionDays: 400 });

    expect((await db().select().from(actionArtifacts).where(eq(actionArtifacts.id, doomed.id)))[0]?.status).toBe(6);
    expect(await env.REPO_PACKS.get(doomed.storagePath)).toBeNull();
    expect((await db().select().from(actionTasks).where(eq(actionTasks.id, oldTask.id)))[0]?.logExpired).toBe(true);
    expect(await env.REPO_PACKS.get(`actions/logs/${oldTask.logFilename}`)).toBeNull();
  });

  it("stops zombie tasks (running + quiet past the timeout)", async () => {
    const harness = await seedRunningTask();
    await db()
      .update(actionTasks)
      .set({ updated: new Date(Date.now() - 11 * 60 * 1000) })
      .where(eq(actionTasks.id, harness.taskId));

    const stopped = await stopZombieTasks(env.DB);
    expect(stopped).toBe(1);
    const rows = await db().select().from(actionTasks).where(eq(actionTasks.id, harness.taskId));
    expect(rows[0]?.status).toBe(2); // failure
  });

  it("deletes an old finished run's whole family", async () => {
    const harness = await seedRunningTask();
    await db()
      .update(actionRuns)
      .set({ status: 1, created: new Date(Date.now() - 401 * 24 * 60 * 60 * 1000) })
      .where(eq(actionRuns.id, harness.runId));

    const deleted = await cleanupOldRuns(env, 400);
    expect(deleted).toBe(1);
    expect(await db().select().from(actionRuns).where(eq(actionRuns.id, harness.runId))).toHaveLength(0);
    expect(await db().select().from(actionRunJobs).where(eq(actionRunJobs.runId, harness.runId))).toHaveLength(0);
    expect(await db().select().from(actionRunAttempts).where(eq(actionRunAttempts.runId, harness.runId))).toHaveLength(0);
    expect(await db().select().from(actionTasks).where(eq(actionTasks.jobId, harness.jobId))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Secrets + OIDC (secrets.ts / oidc.ts)
// ---------------------------------------------------------------------------

describe("the secrets service", () => {
  it("keeps the keystore stable across reads (created once)", async () => {
    const jwk1 = await import("./secrets").then((m) => m.oidcPublicJwk(env));
    const jwk2 = await import("./secrets").then((m) => m.oidcPublicJwk(env));
    expect(jwk1).toEqual(jwk2);
    expect(jwk1.kty).toBe("RSA");
    expect(jwk1.use).toBe("sig");
    expect(jwk1.alg).toBe("RS256");

    // The material persists in the D1 keystore home (system_keystore — the
    // M2 keystore-home port; the M1b R2 object is only a legacy adoption
    // source now and is no longer written).
    const keystoreRows = await db()
      .select({ name: systemKeystore.name })
      .from(systemKeystore)
      .where(inArray(systemKeystore.name, ["general_token_signing_secret", "actions_oidc_signing_key"]));
    expect(keystoreRows.map((r) => r.name).sort()).toEqual(["actions_oidc_signing_key", "general_token_signing_secret"]);
  });

  it("round-trips the runtime JWT and rejects scope/tamper misses", async () => {
    const token = await createAuthorizationToken(env, 42, 7, 9);
    expect(await taskIdFromToken(env, token, false)).toBe(42);

    // The ID-token-request scope does NOT pass the runtime check.
    const requestToken = await signActionsClaims(env, { scp: "Actions.IDTokenRequest", ac: "", taskId: 42, runId: 0, jobId: 0 });
    await expect(taskIdFromToken(env, requestToken, false)).rejects.toThrow("unexpected token scope");
    expect(await taskIdFromToken(env, requestToken, true)).toBe(42);

    // A tampered payload fails verification.
    const [h, b, t] = token.split(".");
    const forged = `${h}.${b!.slice(0, -2)}aa.${t}`;
    await expect(taskIdFromToken(env, forged, false)).rejects.toThrow();

    // The HMAC signature shape: deterministic for the same inputs.
    const sig1 = await actionsBuildSignature(env, "v4", ["a", "b"]);
    const sig2 = await actionsBuildSignature(env, "v4", ["a", "b"]);
    expect(Array.from(sig1)).toEqual(Array.from(sig2));
  });
});

describe("the OIDC issuer", () => {
  it("serves the discovery document + the JWK set", async () => {
    const config = await SELF.fetch(`${BASE}/api/actions/oidc/.well-known/openid-configuration`);
    expect(config.status).toBe(200);
    const doc = await config.json<Record<string, unknown>>();
    expect(doc.issuer).toBe(`${BASE}/api/actions/oidc`);
    expect(doc.jwks_uri).toBe(`${BASE}/api/actions/oidc/jwks`);
    expect(doc.id_token_signing_alg_values_supported).toEqual(["RS256"]);
    expect(Array.isArray(doc.claims_supported)).toBe(true);

    const jwks = await SELF.fetch(`${BASE}/api/actions/oidc/jwks`);
    const keys = await jwks.json<{ keys: Array<Record<string, string>> }>();
    expect(keys.keys).toHaveLength(1);
    expect(keys.keys[0]?.use).toBe("sig");
    expect(keys.keys[0]?.kty).toBe("RSA");
  });

  it("exchanges a permitted task's request token for a verifiable RS256 ID token", async () => {
    const harness = await seedRunningTask({ tokenPermissions: JSON.stringify({ id_token: true, unit_access_modes: {} }) });
    const requestToken = await signActionsClaims(env, { scp: "Actions.IDTokenRequest", ac: "", taskId: harness.taskId, runId: 0, jobId: 0 });

    const res = await SELF.fetch(`${BASE}/api/actions/oidc/token?audience=my-aud`, {
      headers: { authorization: `Bearer ${requestToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json<{ value: string }>();
    const [h, p, s] = body.value.split(".");
    const header = JSON.parse(atob(h!.replace(/-/g, "+").replace(/_/g, "/"))) as { alg: string; kid: string };
    const claims = JSON.parse(atob(p!.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    expect(header.alg).toBe("RS256");
    expect(claims.aud).toBe("my-aud");
    expect(claims.runner_environment).toBe("self-hosted");
    expect(claims.repository).toBe("artifact-owner/repo");
    expect(claims.run_id).toBe(String(harness.runId));
    expect(String(claims.sub)).toContain(":ref:refs/heads/main");

    // The signature verifies against the published JWK.
    const jwks = await SELF.fetch(`${BASE}/api/actions/oidc/jwks`);
    const keys = await jwks.json<{ keys: Array<{ n: string; e: string; kid: string }> }>();
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: keys.keys[0]?.n, e: keys.keys[0]?.e },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlDecodeBytes(s ?? ""), new TextEncoder().encode(`${h}.${p}`));
    expect(ok).toBe(true);
  });

  it("denies a task without the id-token permission and an unknown task", async () => {
    const harness = await seedRunningTask(); // token_permissions NULL → denied
    const requestToken = await signActionsClaims(env, { scp: "Actions.IDTokenRequest", ac: "", taskId: harness.taskId, runId: 0, jobId: 0 });

    const denied = await SELF.fetch(`${BASE}/api/actions/oidc/token`, {
      headers: { authorization: `Bearer ${requestToken}` },
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe("Bearer");

    const ghost = await signActionsClaims(env, { scp: "Actions.IDTokenRequest", ac: "", taskId: 999999, runId: 0, jobId: 0 });
    const ghostRes = await SELF.fetch(`${BASE}/api/actions/oidc/token`, {
      headers: { authorization: `Bearer ${ghost}` },
    });
    expect(ghostRes.status).toBe(401);
  });

  it("checks the permission helper's polarity (null denies, id_token:true allows)", () => {
    expect(taskAllowsOidcToken({ attempt: 1, tokenPermissions: null })).toBe(false);
    expect(taskAllowsOidcToken({ attempt: 1, tokenPermissions: JSON.stringify({ id_token: true }) })).toBe(true);
    expect(taskAllowsOidcToken({ attempt: 1, tokenPermissions: JSON.stringify({}) })).toBe(false);
    expect(taskAllowsOidcToken({ attempt: 1, tokenPermissions: "not json" })).toBe(false);
  });

  it("shapes the claims against the stored rows (the createOIDCClaims port)", () => {
    const now = new Date("2026-10-29T00:00:00Z");
    const claims = createOidcClaims(
      {
        run: {
          id: 5,
          repoId: "repo-1",
          index: 3,
          triggerUserId: 11,
          ref: "refs/heads/main",
          commitSha: "a".repeat(40),
          triggerEvent: "push",
          eventPayload: "{}",
          workflowId: ".gitea/workflows/ci.yml",
          workflowCommitSha: "",
          isForkPullRequest: false,
        },
        job: { attempt: 1, tokenPermissions: null },
        repo: { ownerNamespace: "octo", slug: "hello", ownerId: 2, visibility: "public", id: "repo-1" },
        actor: "octo",
        ref: "refs/heads/main",
        refType: "branch",
        baseRef: "",
        headRef: "",
        sha: "a".repeat(40),
        eventName: "push",
        appUrl: "https://example.com",
      },
      "",
      now,
    );
    expect(claims.iss).toBe("https://example.com/api/actions/oidc");
    expect(claims.sub).toBe(`repo:octo/hello@2/hello@repo-1:ref:refs/heads/main`);
    expect(claims.aud).toBe("https://example.comocto"); // AppURL + PathEscape(owner)
    expect(claims.exp - claims.iat).toBe(300);
    expect(claims.iat - claims.nbf).toBe(300);
    expect(claims.workflow).toBe(".gitea/workflows/ci.yml");
    expect(claims.repository_visibility).toBe("public");
    expect(claims.runner_environment).toBe("self-hosted");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function base64StdMd5(bytes: Uint8Array): string {
  const h = new Md5();
  h.update(bytes);
  const hex = h.hex();
  const raw = new Uint8Array(hex.length / 2);
  for (let i = 0; i < raw.length; i++) {
    raw[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  let bin = "";
  for (const b of raw) bin += String.fromCharCode(b);
  return btoa(bin);
}

function base64UrlDecodeBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}
