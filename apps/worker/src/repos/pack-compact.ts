import { parseBundleMinBytes, runQueueCompaction, type QueueCompactionResult } from "@cf-gitea/git-engine";

/** REPO_TASKS message requesting Worker-side streaming pack compaction (SPEC-0024 M4.1). */
export interface PackCompactMessage {
  kind: "pack-compact";
  repo: string;
  force?: boolean;
  maxPacks?: number;
}

export function isPackCompactMessage(body: unknown): body is PackCompactMessage {
  if (!body || typeof body !== "object") return false;
  const candidate = body as { kind?: unknown; repo?: unknown };
  return candidate.kind === "pack-compact" && typeof candidate.repo === "string" && candidate.repo.length > 0;
}

export async function enqueuePackCompact(
  queue: Pick<Queue, "send">,
  repo: string,
  force = false,
  maxPacks?: number,
): Promise<void> {
  await queue.send({
    kind: "pack-compact",
    repo,
    ...(force ? { force: true } : {}),
    ...(typeof maxPacks === "number" ? { maxPacks } : {}),
  } satisfies PackCompactMessage);
}

export type PackCompactEnv = Pick<Env, "REPO" | "REPO_PACKS"> & {
  REPO_TASKS?: Pick<Queue, "send">;
  COMPACTION_QUEUE_ENABLED?: string;
  BUNDLE_URI_ENABLED?: string;
  BUNDLE_MIN_BYTES?: string;
};

export interface PackCompactOutcome {
  retry: boolean;
  delaySeconds?: number;
  result: QueueCompactionResult | null;
}

/**
 * Consume one `{ kind: "pack-compact", repo }` task from `REPO_TASKS`.
 * Defers (asks Queue to retry after 30s) when a concurrent receive/compaction
 * lease holds the repo; re-enqueues another task if active packs still exceed
 * the threshold after committing.
 */
export async function handlePackCompactTask(
  env: PackCompactEnv,
  msg: PackCompactMessage,
): Promise<PackCompactOutcome> {
  if (!env.REPO_PACKS) {
    return { retry: false, result: null };
  }
  const stub = env.REPO.getByName(msg.repo);
  const result = await runQueueCompaction({
    bucket: env.REPO_PACKS,
    stub,
    repo: msg.repo,
    force: msg.force === true,
    ...(typeof msg.maxPacks === "number" ? { maxPacks: msg.maxPacks } : {}),
    generateBundle: env.BUNDLE_URI_ENABLED === "true",
    bundleMinBytes: parseBundleMinBytes(env.BUNDLE_MIN_BYTES),
  });
  if (result.tag === "deferred") {
    return { retry: true, delaySeconds: 30, result };
  }
  if (result.tag === "compacted" && result.moreWork && env.REPO_TASKS) {
    await enqueuePackCompact(env.REPO_TASKS, msg.repo, msg.force === true, msg.maxPacks);
  }
  return { retry: false, result };
}
