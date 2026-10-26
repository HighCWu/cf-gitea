import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { repositories } from "../../db/schema";
import { tombstoneRepoDO } from "../../repos/purge";
import { replicateRepoCopy, settleForkRow } from "../../repos/fork-task";
import { RepoService, type RepoRow } from "../../repos/service";
import { loadRepoSettings, saveRepoSettings } from "./repo-settings";
import type { RepositoryWithOwner } from "./repository";

/**
 * Template-generate service half (POST /repos/{template_owner}/{template_repo}/generate
 * — upstream GenerateRepository, services/repository/template.go:70-194, on
 * the fork/copy machinery this repo already landed).
 *
 * The upstream flow, reduced to the modeled surface:
 *   1. create the row THROUGH the repos service (UNIQUE(owner,slug)
 *      arbitration, redirect-consume, engine-registry mirror) with
 *      `status='creating'` — upstream's RepositoryBeingMigrated
 *      (template.go:84-98);
 *   2. copy the form metadata: description (the form's, NOT the template's —
 *      GenerateRepoOption.description is "Description of the repository to
 *      create"), default_branch = form's or the template's (the IfZero chain
 *      of generateRepoCommit, generate.go:233);
 *   3. git content — when git_content=true and the template is non-empty
 *      (the `IsEmpty: !opts.GitContent || templateRepo.IsEmpty` birth flag),
 *      replicate the template cell into the new cell via the SAME engine
 *      pass the fork consumer runs (fork-task.ts replicateRepoCopy), then
 *      settle `status='ready'` with the copied emptiness (settleForkRow —
 *      upstream's step-6 flip, template.go:185-189);
 *   4. otherwise settle ready-empty.
 *
 * DOCUMENTED DIVERGENCES from GenerateRepository/GenerateGitContent:
 *   - NO variable substitution: upstream expands `{YEAR}|{REPO_NAME}|…`
 *     transformers in `.gitea/template`-matched files (generate.go:41-118);
 *     out of slice — the copy is byte-faithful.
 *   - FULL-ref copy vs upstream's depth-1 default-branch clone + fresh init
 *     commit (generateRepoCommit, the IfZero chain at generate.go:233): ours
 *     adopts the template's whole catalog (the fork pass), which is a
 *     superset of the default branch.
 *   - the remaining template units are accepted-but-inert: topics
 *     (GenerateTopics), git hooks, webhooks, avatar, issue labels
 *     (GenerateIssueLabels), protected branches (GenerateProtectedBranch)
 *     have no copy arms yet — they still satisfy IsValid()'s "at least one
 *     item" rule so the request succeeds honestly with a bare repo.
 *   - LFS copy (git_model.CopyLFS) and the repo-count limit
 *     (CanCreateRepoIn → ErrReachLimitOfRepo) have no modeled counterpart.
 *   - upstream notifies CreateRepository at the end (template.go:191); the
 *     webhook emission posture for API repo creates is not wired on this
 *     path yet (same as the landed fork path pre-SPEC-0005 §3.5).
 */

/** GenerateRepoOption (structs/repo.go, the frozen contract's definition) —
 *  required: owner, name; everything else optional Go zeros. */
export interface GenerateRepoForm {
  owner?: string;
  name: string;
  default_branch?: string;
  description?: string;
  private?: boolean;
  git_content?: boolean;
  git_hooks?: boolean;
  webhooks?: boolean;
  topics?: boolean;
  avatar?: boolean;
  labels?: boolean;
  protected_branch?: boolean;
}

/** IsValid (generate.go:324-329): at least one template item selected. */
export function generateOptionSelected(form: GenerateRepoForm): boolean {
  return (
    form.git_content === true ||
    form.topics === true ||
    form.git_hooks === true ||
    form.webhooks === true ||
    form.avatar === true ||
    form.labels === true ||
    form.protected_branch === true
  );
}

export interface GenerateRepoResult {
  /** The settled row (status='ready'). */
  repo: RepoRow;
}

/**
 * Steps 1-4 of the module header. `targetOwner` is resolved + authorized in
 * the route (the prepareDoerCreateRepoInOrg split). The template row rides
 * in as `templatePair.repo`; emptiness drives step 3.
 *
 * FAILURE CONTRACT (REDEPLOY11 open issue 1): the content copy rides the
 * fork machinery's engine RPC chain synchronously, and the queue consumer's
 * tolerance (at-least-once redelivery, runForkTask's catch → retry) has no
 * request-path equivalent — one throw used to strand the created row at
 * `status='creating'` forever behind a 500. Two upstream-parity arms close
 * that class here:
 *   - ONE immediate retry of the copy (replicateRepoCopy is idempotent by
 *     contract — rows keyed, copies overwrite, and a committed
 *     finalize reads as the already-done success — so a retry converges the
 *     transient blip class the queue retries away);
 *   - on a still-failing copy, upstream's cleanup: GenerateRepository's
 *     `defer cleanupRepository(generateRepo)` (template.go:102-108) deletes
 *     the half-made repo through DeleteRepositoryDirectly (create.go:448-455)
 *     — the row must never linger. Ours deletes through the landed §2.5.5
 *     pipeline (D1 cascade → DO tombstone → registry remove → queue purge),
 *     then rethrows the original error; the route's declared codes are
 *     unchanged (409/422 mappings, anything else 500).
 */
export async function generateRepoFromTemplate(
  env: Env,
  input: {
    template: RepositoryWithOwner;
    targetOwner: { id: number; usernameLower: string };
    form: GenerateRepoForm;
  },
): Promise<GenerateRepoResult> {
  const d1 = env.DB;
  const template = input.template.repo;
  const service = new RepoService(d1, {
    // The engine registry rides the row's create (REDEPLOY8, the forks.ts
    // convention): without the upsert the repo 404s on info/refs until a
    // push lands. queue/tombstone arm the failure-cleanup delete below.
    registry: env.REGISTRY.getByName("registry"),
    queue: env.REPO_TASKS,
    tombstone: (engineName) => tombstoneRepoDO(env, engineName),
  });

  // Step 1 — the row (status='creating' guards git-HTTP pushes mid-copy).
  const created = await service.create({
    owner: input.targetOwner,
    name: input.form.name,
    isPrivate: input.form.private === true,
    status: "creating",
  });

  try {
    // Step 2 — the form metadata. default_branch: the form's or the
    // template's; description: the form's only (side store, the forks.ts
    // convention).
    const defaultBranch = input.form.default_branch ?? template.defaultBranch;
    await drizzle(d1)
      .update(repositories)
      .set({ defaultBranch, updatedAt: new Date() })
      .where(eq(repositories.id, created.id));
    const description = input.form.description ?? "";
    if (description !== "") {
      await saveRepoSettings(d1, created.id, { description }, new Date());
    }

    // Steps 3-4 — the content copy rides the fork machinery; both arms end at
    // `status='ready'` with an honest emptiness (the CAS settle is idempotent).
    const fork = await service.get(created.id);
    if (fork === null) throw new Error(`generate row vanished after creation: ${created.id}`);
    if (input.form.git_content === true && !template.isEmpty) {
      try {
        await replicateRepoCopy(env, template, fork);
      } catch (error) {
        // The queue's redelivery tolerance, request-path sized: one
        // idempotent re-run before the cleanup arm (module header).
        console.error(
          `[repos] generate ${created.id}: content copy failed, retrying once: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        await replicateRepoCopy(env, template, fork);
      }
      await settleForkRow(drizzle(d1), fork, false);
    } else {
      await settleForkRow(drizzle(d1), fork, true);
    }
  } catch (error) {
    // Upstream's cleanupRepository contract (template.go:102-108): the
    // half-made repo never lingers as a `creating` strand. Best-effort — a
    // cleanup failure is logged loudly (create.go:451-453's notice posture),
    // never a mask for the original error.
    try {
      await service.deleteRepository(created.id);
    } catch (cleanupError) {
      console.error(
        `[repos] generate ${created.id}: cleanupRepository failed (row may be stranded): ` +
          `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw error;
  }

  const repo = await service.get(created.id);
  if (repo === null) throw new Error(`generate row vanished after settle: ${created.id}`);
  return { repo };
}

/** The description side-store read for tests/assertions. */
export async function generatedRepoDescription(d1: D1Database, repoId: string): Promise<string> {
  return (await loadRepoSettings(d1, repoId)).description;
}
