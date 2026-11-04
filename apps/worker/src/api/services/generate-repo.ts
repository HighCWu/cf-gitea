import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { labels, protectedBranches, repositories, webhooks } from "../../db/schema";
import { tombstoneRepoDO } from "../../repos/purge";
import { replicateRepoCopy, settleForkRow } from "../../repos/fork-task";
import { RepoService, type RepoRow } from "../../repos/service";
import { listRepoRules } from "../../services/branch-protection";
import { avatarExists, avatarKey } from "../../services/avatars";
import { listRepoTopics, replaceRepoTopics } from "./repo-topics";
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
 *      pass the fork consumer runs (fork-task.ts replicateRepoCopy). The
 *      `status='ready'` settle (settleForkRow — upstream's step-6 flip,
 *      template.go:185-189) runs ONCE after step 4's copy arms, carrying the
 *      copied emptiness;
 *
 * The six non-git_content template units are PORTED copy arms (B-29, census
 * 2026-11-04 — the substrates all exist; upstream order template.go:131-178,
 * BEFORE the status flip):
 *   - topics        GenerateTopics (models/repo/topic.go:329-337) — the
 *                   template's join names onto the new repo through
 *                   replaceRepoTopics (which carries the FN-4 render column
 *                   in the same batch — upstream's syncTopicsInRepository);
 *   - git hooks     GenerateGitHooks (services/repository/hooks.go:54-84) —
 *                   the template's ACTIVE hook files (the persisted R2 edits
 *                   under routes/git-hooks.ts's `githooks/<id>/<name>`
 *                   layout) copied verbatim; inactive hooks stay inactive
 *                   (upstream's Update() empty-content arm is the no-op);
 *   - webhooks      GenerateWebhooks (hooks.go:87-113) — upstream's exact
 *                   field list (url/method/content type/secret/events blob/
 *                   is_active/type/owner/meta); `name`,
 *                   `header_authorization_encrypted` and the delivery status
 *                   ride their defaults, exactly like upstream's explicit
 *                   field copy omits them;
 *   - avatar        generateAvatar (services/repository/avatar.go:98-108) —
 *                   gated on the template HAVING one (`len(Avatar) > 0` /
 *                   our R2 key-existence marker, services/avatars.ts);
 *                   upstream mints a new hash and copies the object, ours
 *                   copies to the new repo's own immutable storage_key — the
 *                   hash exists upstream to dodge cache collisions on a
 *                   SHARED key prefix, a class our per-repo key never has;
 *   - issue labels  GenerateIssueLabels (template.go:22-45) — the five
 *                   copied columns (name/exclusive/exclusive_order/
 *                   description/color); the archived flag is NOT copied
 *                   (upstream's field list omits it — copied labels land
 *                   unarchived), and an empty template set inserts nothing;
 *   - protected branches GenerateProtectedBranch (template.go:47-67) — the
 *                   whole rule rows (name/priority/config JSON) with fresh
 *                   stamps (upstream zeroes CreatedUnix/UpdatedUnix so the
 *                   insert re-stamps them).
 *
 * DOCUMENTED DIVERGENCES from GenerateRepository/GenerateGitContent:
 *   - NO variable substitution: upstream expands `{YEAR}|{REPO_NAME}|…`
 *     transformers in `.gitea/template`-matched files (generate.go:41-118);
 *     out of slice — the copy is byte-faithful.
 *   - FULL-ref copy vs upstream's depth-1 default-branch clone + fresh init
 *     commit (generateRepoCommit, the IfZero chain at generate.go:233): ours
 *     adopts the template's whole catalog (the fork pass), which is a
 *     superset of the default branch.
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

// ---------------------------------------------------------------------------
// The six non-git_content copy arms (upstream template.go:131-178, in order).
// Each is upstream's function reduced to our substrate; all are called only
// when the form's boolean is true, all run BEFORE the settle (upstream runs
// them before the status flip), and all sit inside the caller's cleanup
// try (upstream's `defer cleanupRepository` covers them equally).
// ---------------------------------------------------------------------------

/** The R2 git-hook object key — routes/git-hooks.ts's layout, restated here
 *  with the same id-shape gate so the `githooks/` prefix cannot be escaped.
 *  (The route keeps its private copies; the layout string + the gate are the
 *  shared contract — drift breaks both sides' tests, by construction.) */
const GIT_HOOK_ID_RE = /^[A-Za-z0-9_-]+$/;
const GIT_HOOK_NAMES = ["pre-receive", "update", "post-receive"] as const;

function gitHookCopyKey(repoId: string, name: (typeof GIT_HOOK_NAMES)[number]): string {
  if (!GIT_HOOK_ID_RE.test(repoId)) {
    throw new Error(`invalid repo id for a git-hook key: ${repoId}`);
  }
  return `githooks/${repoId}/${name}`;
}

/** GenerateTopics (models/repo/topic.go:329-337): the template's names onto
 *  the new repo + the render-column sync (replaceRepoTopics carries the FN-4
 *  column in the same batch — upstream's syncTopicsInRepository tail). The
 *  template's names were validated at its own PUT; they are copied verbatim
 *  like upstream's addTopicByNameToRepo loop (which inserts already-valid
 *  names). An empty template set is the no-op both sides share. */
async function generateTopics(d1: D1Database, templateRepoId: string, newRepoId: string): Promise<void> {
  const topics = await listRepoTopics(d1, templateRepoId);
  await replaceRepoTopics(d1, newRepoId, topics);
}

/** GenerateGitHooks (services/repository/hooks.go:54-84): the template's
 *  ACTIVE hook files copied to the new repo. Upstream iterates ListHooks'
 *  fixed vocabulary and assigns each hook's Content — an inactive template
 *  hook (empty content) drives Update()'s remove arm, i.e. the default
 *  inactive state; ours reads the persisted R2 edits (an absent object IS
 *  the inactive state) and copies the rest verbatim, `\r`-stripped like the
 *  route's store arm (hook.go:88). */
async function generateGitHooks(bucket: R2Bucket, templateRepoId: string, newRepoId: string): Promise<void> {
  for (const name of GIT_HOOK_NAMES) {
    const object = await bucket.get(gitHookCopyKey(templateRepoId, name));
    if (object === null) continue;
    await bucket.put(gitHookCopyKey(newRepoId, name), (await object.text()).replaceAll("\r", ""), {
      httpMetadata: { contentType: "text/plain; charset=utf-8" },
    });
  }
}

/** GenerateWebhooks (services/repository/hooks.go:87-113): upstream's exact
 *  field list copied onto fresh rows — url, http method, content type,
 *  secret, the HookEvent JSON blob, is_active, type, owner id and meta.
 *  `name` (ours) and the delivery status ride their defaults, the way
 *  upstream's explicit field copy omits everything else; the optional
 *  encrypted Authorization header is likewise NOT copied (upstream's struct
 *  copy has no such member). */
async function generateWebhooks(d1: D1Database, templateRepoId: string, newRepoId: string): Promise<void> {
  const rows = await drizzle(d1).select().from(webhooks).where(eq(webhooks.repoId, templateRepoId)).all();
  if (rows.length === 0) return;
  await drizzle(d1).insert(webhooks).values(
    rows.map((w) => ({
      repoId: newRepoId,
      ownerId: w.ownerId,
      url: w.url,
      httpMethod: w.httpMethod,
      contentType: w.contentType,
      secret: w.secret,
      events: w.events,
      isActive: w.isActive,
      type: w.type,
      meta: w.meta,
    })),
  );
}

/** generateAvatar (services/repository/avatar.go:98-108): the caller gates on
 *  the template HAVING an avatar (`len(templateRepo.Avatar) > 0` — ours: the
 *  R2 key-existence marker, services/avatars.ts); the copy lands the
 *  template's object under the new repo's own immutable storage_key.
 *  Upstream mints a fresh hash for the same reason the R2 key differs —
 *  never reuse the source object's identity. The move is a get+put (not a
 *  server-side copy): the stored object is the size-capped processed avatar
 *  (services/avatars.ts MAX_AVATAR_WIRE_BYTES), so holding it in memory is
 *  bounded. */
async function generateAvatar(bucket: R2Bucket, templateStorageKey: string, newStorageKey: string): Promise<void> {
  const source = await bucket.get(avatarKey({ kind: "repo", storageKey: templateStorageKey }));
  if (source === null) return;
  await bucket.put(avatarKey({ kind: "repo", storageKey: newStorageKey }), source.body, {
    httpMetadata: source.httpMetadata,
  });
}

/** GenerateIssueLabels (template.go:22-45): the five copied columns per row —
 *  name, exclusive, exclusive_order, description, color — onto fresh rows.
 *  The archived flag is deliberately NOT copied (upstream's field list omits
 *  it), so copied labels land unarchived; an empty template set inserts
 *  nothing (upstream's empty-slice insert guard, template.go:29-31). */
async function generateIssueLabels(d1: D1Database, templateRepoId: string, newRepoId: string): Promise<void> {
  const rows = await drizzle(d1)
    .select({
      name: labels.name,
      exclusive: labels.exclusive,
      exclusiveOrder: labels.exclusiveOrder,
      description: labels.description,
      color: labels.color,
    })
    .from(labels)
    .where(eq(labels.repoId, templateRepoId))
    .all();
  if (rows.length === 0) return;
  await drizzle(d1).insert(labels).values(rows.map((l) => ({ repoId: newRepoId, ...l })));
}

/** GenerateProtectedBranch (template.go:47-67): the whole rule rows —
 *  branch_name, priority and the config JSON — onto fresh rows with fresh
 *  stamps (upstream zeroes both timestamps so the insert re-stamps them). */
async function generateProtectedBranches(
  d1: D1Database,
  templateRepoId: string,
  newRepoId: string,
  now: Date,
): Promise<void> {
  const rules = await listRepoRules(d1, templateRepoId);
  if (rules.length === 0) return;
  await drizzle(d1).insert(protectedBranches).values(
    rules.map((r) => ({
      repoId: newRepoId,
      ruleName: r.ruleName,
      priority: r.priority,
      rules: r.rules,
      createdAt: now,
      updatedAt: now,
    })),
  );
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
    // template's; description: the form's only (GenerateRepoOption.
    // description, template.go:83 `Description: opts.Description` — riding
    // the repositories row since the FN-4 port, migration 0068).
    const defaultBranch = input.form.default_branch ?? template.defaultBranch;
    await drizzle(d1)
      .update(repositories)
      .set({ defaultBranch, description: input.form.description ?? "", updatedAt: new Date() })
      .where(eq(repositories.id, created.id));

    // Steps 3-4 — the content copy rides the fork machinery; the settle at
    // the tail lands `status='ready'` with an honest emptiness (the CAS
    // settle is idempotent). Only the content arm is gated on git_content ×
    // template emptiness — the six unit arms below run on their own
    // booleans regardless (upstream gates ONLY GenerateGitContent,
    // template.go:133).
    const contentRequested = input.form.git_content === true && !template.isEmpty;
    const fork = await service.get(created.id);
    if (fork === null) throw new Error(`generate row vanished after creation: ${created.id}`);
    if (contentRequested) {
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
    }

    // Step 4 — the six non-git_content copy arms (upstream
    // template.go:131-178's order), each only when its boolean is true. They
    // run BEFORE the settle, so every failure here takes the cleanup arm
    // below (upstream's defer covers them equally) and the row never sits
    // ready with a half-copied unit set.
    const newRepoId = fork.id;
    if (input.form.topics === true) {
      await generateTopics(d1, template.id, newRepoId);
    }
    if (input.form.git_hooks === true) {
      await generateGitHooks(env.REPO_PACKS, template.id, newRepoId);
    }
    if (input.form.webhooks === true) {
      await generateWebhooks(d1, template.id, newRepoId);
    }
    if (input.form.avatar === true && (await avatarExists(env.REPO_PACKS, { kind: "repo", storageKey: template.storageKey }))) {
      await generateAvatar(env.REPO_PACKS, template.storageKey, fork.storageKey);
    }
    if (input.form.labels === true) {
      await generateIssueLabels(d1, template.id, newRepoId);
    }
    if (input.form.protected_branch === true) {
      await generateProtectedBranches(d1, template.id, newRepoId, new Date());
    }
    await settleForkRow(drizzle(d1), fork, !contentRequested);
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

/** The description row read for tests/assertions (the repositories column —
 *  the side store retired by the FN-4 port, migration 0068). */
export async function generatedRepoDescription(d1: D1Database, repoId: string): Promise<string> {
  return (
    (
      await drizzle(d1)
        .select({ description: repositories.description })
        .from(repositories)
        .where(eq(repositories.id, repoId))
        .get()
    )?.description ?? ""
  );
}
