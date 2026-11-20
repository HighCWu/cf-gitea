/**
 * The package webhook seam (GAPS #8 — the SPEC-0016 registry's emissions) —
 * the `package` family's service-side fan-out, the `emitWikiPageEvent`
 * service-seam shape (services/wiki.ts): the write ops (or their routes)
 * hand over committed rows, the seam renders the §2.7 payload and inserts
 * the `webhook_deliveries` rows through the shared `emitWebhookDeliveries`.
 *
 * UPSTREAM DERIVATION (pin fc4936884584a41931906553d96c2601d750e6ef):
 * there is ONE `package` wire event type (`HookEventPackage`,
 * modules/webhook/type.go:37; in AllEvents :74) carrying an ACTION —
 * `HookPackageCreated` "created" / `HookPackageDeleted` "deleted"
 * (modules/structs/hook.go:588-591). A separate "PackageVersion" event does
 * NOT exist upstream; the version-added arm IS the created action:
 *
 *   - created: `notify_service.PackageCreate` fires from
 *     services/packages/packages.go:131 (createPackageAndAddFile) gated on
 *     `created` — which is `versionCreated`, the GetOrInsertVersion
 *     arbiter's answer (createPackageAndVersion returns versionCreated,
 *     packages.go:213; the duplicate-version re-publish fires NOTHING), and
 *     from the container registry's manifest finalize
 *     (routers/api/packages/container/manifest.go:95 — every successful
 *     push, no gate). Every other protocol's upload funnels through
 *     CreatePackageAndAddFile, so "a new version row landed through a
 *     registry write" is the single created condition.
 *   - deleted: `notify_service.PackageDelete` fires from
 *     RemovePackageVersion (:532 — the per-version delete; reached from the
 *     v1 DELETE route api/v1/packages/package.go:186, the generic/nuget/
 *     rubygems/chef/npm/container/terraform registry endpoints, the admin
 *     and user-settings pages), from
 *     RemovePackageFileAndVersionIfUnreferenced (:572 — the file delete that
 *     cascades the version; alpine/arch; NOTIFIED ONLY WHEN THE VERSION
 *     WENT — pd != nil), from RemovePackage (:714 — the whole-package
 *     delete, ONE EVENT PER VERSION DESCRIPTOR, the `for _, pd := range
 *     pds` loop; v1 package.go:146, user/package.go:487), and router-direct
 *     from the debian/rpm/conan delete endpoints (debian.go:297, rpm.go:319,
 *     conan.go:692). SILENT arms upstream: the cleanup cron (it calls the
 *     model-level DeletePackageVersionAndReferences directly,
 *     services/packages/cleanup/cleanup.go:78) and the user-account cascade
 *     (RemoveAllPackages — no notify).
 *
 * PAYLOAD (notifyPackage, services/webhook/notifier.go:976-993 over
 * PackagePayload, modules/structs/hook.go:594-606):
 *   { action, package, repository: null, organization, sender }
 * — the top-level `repository` field is NEVER set by notifyPackage (it
 * marshals null); `organization` renders only when the owner is an
 * organization (ToOrganization, convert.go:928-943), else null; `sender` is
 * ToUser(ctx, sender, nil) — the doer rendered self-visible. The inner
 * `package` object is convert.ToPackage (services/convert/package.go:16-40):
 *   { id: version.id, owner, repository (ONLY when the package row is
 *     repo-linked AND the doer can view it — HasAnyUnitAccess gate),
 *     creator, type, name, version, html_url, created_at }
 * — html_url = VersionHTMLURL (models/packages/descriptor.go:101-104):
 * {owner URL}/-/packages/{type}/{lowerName}/{lowerVersion}, absolute.
 * Our inner render mirrors api/routes/packages.ts `toApiPackage`
 * (the landed ToPackage port) field-for-field but stands alone here so the
 * service tier stays out of the route module (the repo-events.ts import
 * direction).
 *
 * DELIVERY CONDITIONS (PrepareWebhooks, services/webhook/webhook.go:207):
 * EventSource{Repository: pd.Repository, Owner: pd.Owner} — repo hooks when
 * the package row is repo-linked, plus owner-level hooks, plus system
 * hooks; the hook's own `package` subscription flag + branch filter (a
 * payload without a ref is unaffected) decide per hook. Our fan-out passes
 * repoId = the link ("" when unlinked — matches no repo hook, exactly the
 * unlinked upstream source) and ownerId, through emitWebhookDeliveries'
 * isActive/subscription/filter ladder.
 *
 * MECHANICS are the wiki seam's inline off-request posture (emitWikiPageEvent):
 * the delivery-row insert is awaited inline, the Queue producer batch is
 * awaited when the binding exists (the service tier has no hono
 * executionCtx to offload onto), rows stay `pending` without the binding,
 * and the whole emission is caught-and-logged, NEVER thrown — the write
 * already landed and a webhook failure must not fail it.
 */

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { toApiOrganization } from "../../api/services/org-repos";
import {
  apiUserFromRow,
  canViewRepositoryWithTeams,
  findUserByName,
  toApiRepository,
  type RepositoryWithOwner,
  type UserRow,
  type Viewer,
} from "../../api/services/repository";
import { packageVersions, repositories, users } from "../../db/schema";
import { emitWebhookDeliveries } from "../../issues/webhooks";
import { OrgService } from "../orgs/orgs";
import { getPackageByName, getVersionByNameAndVersion, type PackageRow, type PackageVersionRow } from "./model";

/**
 * The bindings the package-family fan-out touches — the RepoEventEnv pattern
 * (a wrangler rename surfaces as a keyof error HERE instead of hiding behind
 * a stale generated file). The generated `Env` satisfies this structurally;
 * the route callers pass their `env` through unchanged.
 */
export type PackageEventEnv = Pick<Env, "DB"> & {
  /** APP_URL wins the origin precedence (webhooks-push.ts appOrigin). */
  APP_URL?: string;
  /** The `WEBHOOK_DELIVERY` producer probe reads this structurally; a
   *  binding gap degrades to `pending` delivery rows. */
  WEBHOOK_DELIVERY?: unknown;
};

/** Upstream `HookPackageAction` (modules/structs/hook.go:588-591). */
export type PackageEventAction = "created" | "deleted";

/** One committed (package, version) pair — the descriptor the payload renders. */
export interface PackageEventDescriptor {
  pkg: PackageRow;
  version: PackageVersionRow;
}

/**
 * The webhook-delivery options a registry write op threads through — the
 * optional input field the protocol services carry (`webhookEnv`);
 * undefined keeps the walk silent (the cleanup-cron / user-cascade posture —
 * upstream's model-level deletes notify nothing either).
 */
export type PackageWebhookOptions = PackageEventEnv;

/**
 * The delete-arm emission input — the trailing optional parameter the
 * cascade-gated delete ops carry (`emit`): `webhookEnv` present means the
 * caller wants the `deleted` event (every registry route passes it);
 * `doerId` is the authenticated remover (upstream ctx.Doer). The descriptor
 * resolution stays INSIDE the delete op, before the version row dies, so
 * the payload renders the pre-delete state exactly like upstream's
 * GetPackageDescriptor-then-delete order (packages.go:521-523).
 */
export interface PackageDeleteEmitOptions {
  webhookEnv?: PackageEventEnv;
  doerId?: number;
}

/** The `WEBHOOK_DELIVERY` Queue producer, when the binding is wired — the
 *  repo-events.ts structural probe. */
function webhookDeliveryQueue(env: PackageEventEnv): {
  sendBatch(messages: { body: { deliveryId: number } }[]): Promise<unknown>;
} | null {
  const candidate: unknown = (env as { WEBHOOK_DELIVERY?: unknown }).WEBHOOK_DELIVERY;
  if (candidate === undefined || candidate === null) return null;
  const queue = candidate as { sendBatch?: (messages: { body: { deliveryId: number } }[]) => Promise<unknown> };
  return typeof queue.sendBatch === "function" ? { sendBatch: queue.sendBatch.bind(queue) } : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The payload URL origin — appOrigin's chain reduced to the legs a package
 * emission carries (no receive/event origin exists off the registry write;
 * the walk callers are request-serving, the env carries the var when set).
 * The `http://localhost:3000` default is upstream's own ROOT_URL fallback
 * (modules/setting/server.go:119-120, the WebhookPushEnv default's source).
 */
function packageEventOrigin(env: PackageEventEnv): string {
  return (env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// The payload render (§2.7)
// ---------------------------------------------------------------------------

/**
 * The inner `package` object — convert.ToPackage
 * (services/convert/package.go:16-40) over our rows, the toApiPackage
 * field set (api/routes/packages.ts): id keys the VERSION row; the linked
 * repository renders only when the doer can view it (upstream's
 * HasAnyUnitAccess gate); creator null when the version is unattributed
 * (creator_id 0 — the documented null-vs-error divergence toApiPackage
 * carries). `html_url` mirrors VersionHTMLURL's path shape.
 */
export async function renderPackageEventTarget(
  env: PackageEventEnv,
  descriptor: PackageEventDescriptor,
  ownerRow: UserRow,
  viewer: Viewer,
): Promise<Record<string, unknown>> {
  const { pkg, version } = descriptor;
  let linked: RepositoryWithOwner | null = null;
  if (pkg.repoId !== null) {
    const repoRow = (await drizzle(env.DB).select().from(repositories).where(eq(repositories.id, pkg.repoId)).get()) ?? null;
    if (repoRow !== null && (await canViewRepositoryWithTeams(env.DB, viewer, repoRow))) {
      const repoOwner = await findUserByName(env.DB, repoRow.ownerNamespace);
      if (repoOwner !== null) {
        linked = { repo: repoRow, owner: repoOwner };
      }
    }
  }
  const creatorRow =
    version.creatorId === 0
      ? null
      : ((await drizzle(env.DB).select().from(users).where(eq(users.id, version.creatorId)).get()) ?? null);
  const htmlUrl = `${packageEventOrigin(env)}/${encodeURIComponent(ownerRow.username)}/-/packages/${encodeURIComponent(pkg.type)}/${encodeURIComponent(pkg.lowerName)}/${encodeURIComponent(version.lowerVersion)}`;
  return {
    id: version.id,
    owner: apiUserFromRow(ownerRow, viewer),
    repository: linked === null ? null : toApiRepository(viewer, linked),
    creator: creatorRow === null ? null : apiUserFromRow(creatorRow, viewer),
    type: pkg.type,
    name: pkg.name,
    version: version.version,
    html_url: htmlUrl,
    created_at: version.createdUnix.toISOString(),
  };
}

/**
 * The full PackagePayload (modules/structs/hook.go:594-606) — notifyPackage's
 * field-for-field shape: top-level `repository` always null (notifyPackage
 * never sets it), `organization` only for an org owner (ToOrganization;
 * includeEmail true — upstream renders org.Email with no permission gate,
 * and the sender IS authenticated), `sender` the doer self-visible
 * (ToUser(ctx, sender, nil) — the wiki seam's two-pass bootstrap).
 */
export async function packageEventPayload(
  env: PackageEventEnv,
  action: PackageEventAction,
  descriptor: PackageEventDescriptor,
  ownerRow: UserRow,
  doerRow: UserRow,
): Promise<Record<string, unknown>> {
  // Self-render bootstrap: apiUserFromRow reads only login/is_admin off the
  // viewer, so the first pass (anonymous) yields the requester object the
  // second pass needs to authenticate the doer against themself — the wiki
  // seam's exact posture.
  const origin = packageEventOrigin(env);
  const bootstrap: Viewer = { origin, requester: null };
  const viewer: Viewer = { origin, requester: apiUserFromRow(doerRow, bootstrap) };
  let organization: Record<string, unknown> | null = null;
  if (ownerRow.type === "org") {
    // notifyPackage: `if pd.Owner.IsOrganization()` → ToOrganization
    // (notifier.go:984-986). getOrgById re-reads the same row the OrgRecord
    // projection needs (type-gated: a non-org row reads as a miss → null).
    const orgRecord = await new OrgService(env.DB).getOrgById(ownerRow.id);
    if (orgRecord !== null) {
      organization = toApiOrganization(orgRecord, { origin, includeEmail: true });
    }
  }
  return {
    action,
    package: await renderPackageEventTarget(env, descriptor, ownerRow, viewer),
    repository: null,
    organization,
    sender: apiUserFromRow(doerRow, viewer),
  };
}

// ---------------------------------------------------------------------------
// The emitters (notifyPackage's two actions)
// ---------------------------------------------------------------------------

/**
 * Fan one committed package mutation out to its hooks — notifyPackage +
 * PrepareWebhooks in our mechanics. descriptors: one per event (the
 * whole-package delete passes its version descriptors one call each, the
 * upstream `for _, pd := range pds` loop unrolled by the caller). Never
 * throws; returns the delivery ids written across the descriptors.
 */
export async function emitPackageEvents(
  env: PackageEventEnv,
  action: PackageEventAction,
  descriptors: readonly PackageEventDescriptor[],
  doerId: number,
): Promise<number[]> {
  if (descriptors.length === 0) return [];
  try {
    const ownerRow = (await drizzle(env.DB).select().from(users).where(eq(users.id, descriptors[0]!.pkg.ownerId)).get()) ?? null;
    if (ownerRow === null) {
      console.error(`[packages] webhook fan-out skipped (${action}): owner row missing [id: ${descriptors[0]!.pkg.ownerId}]`);
      return [];
    }
    const doerRow =
      doerId === 0 ? null : ((await drizzle(env.DB).select().from(users).where(eq(users.id, doerId)).get()) ?? null);
    if (doerRow === null) {
      // Registry writes are always authenticated (creator_id 0 exists only
      // for system rows) — a missing doer row is the skip arm, the wiki
      // seam's doer-row-missing posture.
      console.error(`[packages] webhook fan-out skipped (${action}): doer row missing [id: ${doerId}]`);
      return [];
    }
    const queue = webhookDeliveryQueue(env);
    const deliveryIds: number[] = [];
    for (const descriptor of descriptors) {
      const payload = await packageEventPayload(env, action, descriptor, ownerRow, doerRow);
      const written = await emitWebhookDeliveries(
        env.DB,
        {
          // EventSource{Repository: pd.Repository, Owner: pd.Owner} — an
          // unlinked package matches no repo hook ("" matches nothing; the
          // deliveries' denormalized repo_id carries the purge sentinel).
          repoId: descriptor.pkg.repoId ?? "",
          ownerId: descriptor.pkg.ownerId,
          eventType: "package",
          payload,
          refName: null,
        },
        {
          enqueue:
            queue !== null
              ? (ids) => queue.sendBatch(ids.map((deliveryId) => ({ body: { deliveryId } }))).then(() => undefined)
              : undefined,
        },
      );
      deliveryIds.push(...written.deliveryIds);
    }
    return deliveryIds;
  } catch (error) {
    console.error(`[packages] webhook fan-out failed (${action}): ${errorMessage(error)}`);
    return [];
  }
}

/** The created arm — the version-added notification (notifyPackage with
 *  HookPackageCreated). Callers gate on their walk's `versionCreated`
 *  (packages.go:131's `if created`), so a re-publish is silent. */
export async function emitPackageCreated(
  env: PackageEventEnv,
  descriptor: PackageEventDescriptor,
  doerId: number,
): Promise<number[]> {
  return emitPackageEvents(env, "created", [descriptor], doerId);
}

/** The deleted arm — notifyPackage with HookPackageDeleted. `descriptors`
 *  carries ONE descriptor per deleted version: the whole-package delete
 *  fires one event per version (packages.go:714's loop), a version delete
 *  exactly one. */
export async function emitPackageDeleted(
  env: PackageEventEnv,
  descriptors: readonly PackageEventDescriptor[],
  doerId: number,
): Promise<number[]> {
  return emitPackageEvents(env, "deleted", descriptors, doerId);
}

// ---------------------------------------------------------------------------
// Descriptor resolvers — the route-side arms (v1 deletes, the generic
// registry's name-keyed deletes) resolve BEFORE their mutation so the
// payload renders the PRE-delete state (upstream GetPackageDescriptor runs
// before the delete in RemovePackageVersion, packages.go:521-523).
// ---------------------------------------------------------------------------

/** One version descriptor by the registry's (owner, type, name, version) key;
 *  null when either row is missing (a just-deleted race renders nothing —
 *  upstream's GetPackageDescriptor would error the notify away too). */
export async function resolvePackageEventDescriptor(
  d1: D1Database,
  ownerId: number,
  type: string,
  name: string,
  version: string,
): Promise<PackageEventDescriptor | null> {
  const pkg = await getPackageByName(d1, ownerId, type, name);
  if (pkg === null) return null;
  const versionRow = await getVersionByNameAndVersion(d1, ownerId, type, name, version);
  if (versionRow === null) return null;
  return { pkg, version: versionRow };
}

/** Every version descriptor of one package, oldest insertion first — the
 *  whole-package delete's per-version event set (RemovePackage's
 *  GetAllPackageDescriptors). Empty when the package row is missing. */
export async function resolvePackageEventAllVersions(
  d1: D1Database,
  ownerId: number,
  type: string,
  name: string,
): Promise<PackageEventDescriptor[]> {
  const pkg = await getPackageByName(d1, ownerId, type, name);
  if (pkg === null) return [];
  const rows = await drizzle(d1)
    .select()
    .from(packageVersions)
    .where(eq(packageVersions.packageId, pkg.id))
    .all();
  return rows.map((version) => ({ pkg, version }));
}
