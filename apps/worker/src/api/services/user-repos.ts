import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  serializeCommit,
  serializeTree,
  type ApiObject,
  type Person,
} from "@cf-gitea/git-engine";

import { repositories, users } from "../../db/schema";
import { RepoService, type RepoRow } from "../../repos/service";
import { ApiError } from "../errors";
import type { ApiEnv } from "../env";
import type { CreateRepoOption } from "../models/repository";
import { branchRef, commitApiChangeError, engineCell, ZERO_OID } from "./engine";
import { renderInitTreeFiles } from "./repo-init-templates";
import { saveRepoSettings } from "./repo-settings";
import { tombstoneRepoDO } from "../../repos/purge";

/**
 * `POST /user/repos` service half (createCurrentUserRepo — upstream
 * routers/api/v1/repo/repo.go CreateUserRepo + repo_service.CreateRepository's
 * auto-init half, services/repository/create.go initRepository). Creation goes
 * through the landed repos service (src/repos/service.ts create — the
 * UNIQUE(owner, slug) arbitration, redirect shadow rule, registry mirror);
 * this module adds the upstream option plumbing the API owes on top:
 *
 *   - `description` → the repo-edit stored subset (services/repo-settings.ts —
 *     the same store repoEdit PATCHes; upstream keeps it on the repository
 *     row, the sweep keeps the side table);
 *   - `default_branch` → the row's column (upstream initRepository:
 *     `DefaultBranch = IfZero(opts.DefaultBranch, setting DefaultBranch)`);
 *   - `auto_init` → the initial commit: Worker-built blob + root tree + commit
 *     through the engine's putApiObjects + commitApiChange (SPEC-0001a §4.3
 *     control-plane, the dist-types RepoCell RPCs) landing
 *     `refs/heads/<default_branch>` CAS create-on-empty (ZERO_OID), then the
 *     row flips `is_empty` (upstream: initRepository → SyncRepoBranches).
 *
 * Auto-init fidelity (upstream prepareRepoCommit + initRepoCommit):
 *   - README.md renders the `Default` template — `# {Name}\n\n{Description}`
 *     (options/readme/Default) with the vars expanded; upstream coerces an
 *     empty `readme` to "Default" when auto_init is set (repo.go CreateUserRepo
 *     head) and 400s any other unknown template name. `repo_module.Readmes`
 *     IS the contents of options/readme/ — exactly one file, "Default" — so
 *     the single-entry catalog below is upstream-faithful, 400 message
 *     included.
 *   - `gitignores` / `license` render into the initial tree through
 *     services/repo-init-templates.ts (the build-time inlined options/
 *     catalogs): `.gitignore` is the `# ---> <name>` join of the comma-split
 *     option (create.go:108-124) and `LICENSE` the placeholder-filled
 *     template (create.go:126-146 → modules/repository/license.go). An
 *     UNKNOWN template name fails the pure render AFTER the repo row has
 *     landed (upstream reads the files inside initRepository, create.go:
 *     113-114/:131-135) — this service then runs the cleanupRepository
 *     rollback (create.go:236-241 → :448-456: delete the row + engine
 *     scaffold) and rethrows, so the caller sees the same 500-then-name-is-
 *     free posture as upstream's unmapped-error arm (repo.go:254-259). The
 *     ENGINE transport arms below keep their retryable-unknown posture (no
 *     rollback — the landed note stands; upstream can clean unconditionally
 *     because its init steps are local, ours are DO RPCs whose outcomes are
 *     not provable).
 *   - `issue_labels` is accepted and ignored (the createOrgRepo deferral
 *     note in routes/org-repos.ts stands — no label-template store).
 *   - commit message "Initial commit" (create.go initRepoCommit), author +
 *     committer = the owner's git signature (user.NewGitSig): display name
 *     falling back to the username, and the primary email — the noreply
 *     placeholder when none is set (upstream derives that domain from instance
 *     config; the fixed invalid-domain placeholder is the documented stand-in).
 *   - `trust_model` mirrors upstream ToTrustModel (models/repo/repo.go:127):
 *     case-insensitive, empty/unknown → `default`. Nothing consumes it yet
 *     (signed-commit trust is a SPEC-0005 surface) — it is validated per
 *     contract enum and stored nowhere, like upstream's column we do not have.
 *   - `template` / `object_format_name` are accepted per contract and ignored
 *     (no is_template column; sha1 is the only engine object format).
 */

/** Upstream `repo_module.Readmes` — the contents of options/readme/. */
export const AUTO_INIT_README_TEMPLATES: readonly string[] = ["Default"];

/** D1 row of the `users` table (src/db/schema.ts). */
type UserRow = typeof users.$inferSelect;

/**
 * The upstream CreateUserRepo head: coerce the empty readme to `Default` when
 * auto_init is set, then 400 any name outside the (single-entry) template
 * catalog — `readme template does not exist, available templates: %v`.
 */
export function resolveAutoInitReadme(form: CreateRepoOption): string | null {
  if (form.auto_init !== true) {
    return null;
  }
  const readme = form.readme === undefined || form.readme === "" ? "Default" : form.readme;
  if (!AUTO_INIT_README_TEMPLATES.includes(readme)) {
    throw new ApiError(400, `readme template does not exist, available templates: [${AUTO_INIT_README_TEMPLATES.join(" ")}]`);
  }
  return readme;
}

/** The D1 row behind the resolved token identity — creation needs the
 *  case-folded login key and the git-signature fields, which the contract
 *  `User` projection does not carry. A token that resolves to no row is the
 *  silent-auth-failure convention (the api middlewares' "token is required"). */
export async function findDoerRow(d1: D1Database, doer: { id?: number }): Promise<UserRow | null> {
  if (doer.id === undefined) {
    return null;
  }
  const row = await drizzle(d1)
    .select()
    .from(users)
    .where(eq(users.id, doer.id))
    .limit(1)
    .then((rows) => rows[0]);
  return row ?? null;
}

const ENCODER = new TextEncoder();

/** Worker-side blob object — `blob <size>\0` + bytes, SHA-1 via WebCrypto
 *  (the services/git-models.ts buildBlobObject shape, mirrored here so this
 *  batch stays independent of that parallel engine-read module). */
async function buildBlobObject(content: Uint8Array): Promise<ApiObject> {
  const header = ENCODER.encode(`blob ${content.byteLength}\0`);
  const raw = new Uint8Array(header.length + content.byteLength);
  raw.set(header, 0);
  raw.set(content, header.length);
  const digest = await crypto.subtle.digest("SHA-1", raw);
  const oid = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { oid, type: "blob", data: content };
}

/** The owner's git signature (user.NewGitSig stand-in — see module doc). */
function gitSignature(owner: UserRow, now: Date): Person {
  const unix = Math.floor(now.getTime() / 1000);
  return {
    name: owner.displayName ?? owner.username,
    email: owner.email ?? `${owner.id}+${owner.usernameLower}@users.noreply.gitea.invalid`,
    time: unix,
    tz: "+0000",
  };
}

/**
 * Build the auto-init commit objects: the rendered README.md blob, the
 * template-rendered .gitignore/LICENSE blobs (create.go prepareRepoCommit's
 * three write arms), the root tree, and the parentless "Initial commit"
 * (SPEC-0001a §4.3 shapes — every oid is Worker-computed; the DO re-verifies
 * before storing). THROWS on an unknown gitignores/license template name —
 * the pure render happens BEFORE any engine write, so the caller's rollback
 * finds exactly the just-created row (upstream's order: the DB row lands,
 * then initRepository reads the templates, then the commit — create.go:226-294).
 */
async function buildInitialCommitObjects(
  owner: UserRow,
  form: CreateRepoOption,
  now: Date,
): Promise<{ objects: ApiObject[]; commitOid: string }> {
  // options/readme/Default verbatim: `# {Name}\n\n{Description}`.
  const readme = await buildBlobObject(ENCODER.encode(`# ${form.name}\n\n${form.description ?? ""}`));
  const templateBlobs: ApiObject[] = [];
  const treeEntries: Array<{ mode: string; name: string; oid: string }> = [];
  // LicenseValues (create.go:126-135): Owner=repo.OwnerName, Email=authorSig.
  // Email (the git signature's email — the placeholder when unset), Repo=
  // repo.Name, Year=now.Format("2006").
  for (const file of renderInitTreeFiles(form, {
    owner: owner.username,
    email: gitSignature(owner, now).email,
    repo: form.name,
    year: String(now.getUTCFullYear()),
  })) {
    const blob = await buildBlobObject(file.content);
    templateBlobs.push(blob);
    treeEntries.push({ mode: "100644", name: file.path, oid: blob.oid });
  }
  // git tree byte-order: ".gitignore" < "LICENSE" < "README.md".
  const tree = serializeTree([...treeEntries, { mode: "100644", name: "README.md", oid: readme.oid }]);
  const commit = serializeCommit({
    tree: tree.oid,
    parents: [],
    author: gitSignature(owner, now),
    committer: gitSignature(owner, now),
    message: "Initial commit",
  });
  return {
    objects: [
      readme,
      ...templateBlobs,
      { oid: tree.oid, type: tree.type, data: tree.data },
      { oid: commit.oid, type: commit.type, data: commit.data },
    ],
    commitOid: commit.oid,
  };
}

/**
 * `cleanupRepository` (create.go:448-456) — the init-failure rollback: the
 * just-created row goes through the full §2.5.5 delete pipeline (D1 cascade
 * → DO tombstone → queue purge), freeing the name exactly like upstream's
 * DeleteRepositoryDirectly. Best-effort: a rollback failure is logged (the
 * CreateRepositoryNotice arm) and never masks the original error.
 */
async function rollbackCreatedRepository(
  d1: D1Database,
  env: ApiEnv["Bindings"],
  repo: RepoRow,
): Promise<void> {
  try {
    await new RepoService(d1, {
      registry: env.REGISTRY.getByName("registry"),
      queue: env.REPO_TASKS,
      tombstone: (engineName) => tombstoneRepoDO(env, engineName),
    }).deleteRepository(repo.id);
  } catch (error) {
    console.error(
      `[user-repos] cleanupRepository failed for ${repo.ownerNamespace}/${repo.slug}:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Create a repository owned by `owner` (the authenticated doer) from the
 * CreateRepoOption body. Engine write RPCs are NOT caught (the
 * services/engine.ts posture — a transport failure is retryable-unknown state
 * and the honest answer is the 500 handler), exactly like upstream, whose
 * create row predates the init commit too. Tagged engine outcomes map through
 * the shared mappers (ref_conflict → the 409 family, invalid → 422).
 * Returns the RE-READ row — upstream reloads the repo "to get a real state
 * after creation" (repo.go CreateUserRepo tail), so `empty` reflects the
 * landed auto-init commit.
 */
export async function createUserRepository(
  d1: D1Database,
  env: ApiEnv["Bindings"],
  owner: UserRow,
  form: CreateRepoOption,
  now: Date,
): Promise<RepoRow> {
  // The engine registry rides the create (REDEPLOY8): bare construction
  // skips seedRepoExtras' upsert, so the repo 404s on info/refs/clone until
  // a push lands (the gate passes the same dep at its receive-pack arm).
  const service = new RepoService(d1, { registry: env.REGISTRY.getByName("registry") });
  const repo = await service.create({
    owner: { id: owner.id, usernameLower: owner.usernameLower },
    name: form.name,
    isPrivate: form.private === true,
  });

  // Metadata the create call carries: default branch (upstream
  // IfZero(opts.DefaultBranch, "main")) and the auto-init is_empty flip.
  const defaultBranch = form.default_branch !== undefined && form.default_branch !== "" ? form.default_branch : repo.defaultBranch;
  if (form.description !== undefined && form.description !== "") {
    await saveRepoSettings(d1, repo.id, { description: form.description }, now);
  }
  await drizzle(d1)
    .update(repositories)
    .set({ defaultBranch, isEmpty: form.auto_init !== true, updatedAt: now })
    .where(eq(repositories.id, repo.id));

  if (form.auto_init === true) {
    const cell = engineCell(env, { ownerNamespace: repo.ownerNamespace, slug: repo.slug });
    // The template render is pure — an unknown gitignores/license name throws
    // before anything engine-side lands, and the rollback deletes the row
    // (create.go:236-241's deferred cleanup; the handler then answers the
    // unmapped-error 500, repo.go:254-259).
    let built: { objects: ApiObject[]; commitOid: string };
    try {
      built = await buildInitialCommitObjects(owner, form, now);
    } catch (error) {
      await rollbackCreatedRepository(d1, env, repo);
      // The template loaders' init-failure text (`GetRepoInitFile[name]…` /
      // `getLicense[name]…`) rides the 500 envelope the way upstream's
      // APIErrorInternal carries err.Error() (repo.go:254-259).
      throw error instanceof ApiError ? error : new ApiError(500, error instanceof Error ? error.message : String(error));
    }
    const put = await cell.putApiObjects(built.objects);
    if (put.tag !== "ok") {
      // Unreachable for the fixed single-file payload (budget/validation are
      // content-shaped); the honest mapping is the internal-error family.
      throw new ApiError(500, put.tag === "invalid" ? put.reason : `initial commit exceeds the object budget [${put.limitBytes}]`);
    }
    const landed = await cell.commitApiChange({
      ref: branchRef(defaultBranch),
      expectedOldOid: ZERO_OID,
      newOid: built.commitOid,
    });
    if (landed.tag !== "committed") {
      throw commitApiChangeError(landed);
    }
    // An explicit non-default branch: D1 is the metadata truth (the gate's
    // synthetic HEAD falls back to it); the engine HEAD fixup is best-effort
    // like the repos service's setDefaultBranch.
    if (defaultBranch !== "main") {
      const head = await cell.setHead(defaultBranch);
      if (head.tag !== "ok") {
        console.error(`[user-repos] auto-init setHead ${repo.id} -> ${defaultBranch} rejected: ${head.tag}`);
      }
    }
  }

  const row = await service.get(repo.id);
  if (row === null) {
    throw new ApiError(500, "repository row vanished after creation");
  }
  return row;
}
