/**
 * Fixed-time wiki seeding for the render suites (the render-wallclock audit's
 * follow-up 2, the (c) class): the wiki service stamps the commit's
 * author/committer time into STORED git objects (`services/wiki.ts`
 * wikiPerson), so no render-site fixture can pin a view page's last-edited
 * bytes — the wall clock had to be pinned at WRITE time. The audit's seam
 * (`WikiWriteOptions.now`, unix seconds) landed additively on the service's
 * three write ops; this helper drives it.
 *
 * Not a raw-object writer: the unborn-root commit + putApiObjects +
 * commitApiChange CAS orchestration is the service's own logic (specs/wiki.md
 * §2), and duplicating it engine-side would fork the storage contract this
 * suite is supposed to render. With the seam, the golden's seed rides the
 * LANDED createWikiPage path — real service, real cell, only the stamp and
 * the identity pinned — which is exactly the fixed-time writer the audit
 * sized, one seam cheaper than the raw-object variant.
 *
 * Determinism (§5.2): the pinned stamp fixes the commit oid too (same tree
 * contents + same person lines → same SHA-1), so a re-run after the vitest
 * plugin's storage rollback re-lands the byte-identical commit. The
 * idempotence guard (`readWikiPage`) keeps a persisted-storage re-entry from
 * double-writing.
 *
 * The doer mirrors the UI write path's derivation (ui/index.ts wikiPrologue:
 * the user row's username + stored email, else the `@noreply.<host>`
 * fallback) — for the harness principals (no email column) that is
 * `<username>@noreply.test.local`, deterministic.
 */

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";

import { createWikiPage, readWikiPage, type WikiDoer } from "../../services/wiki";
import { repositories, users } from "../../db/schema";
import type { RepositoryWithOwner } from "../../api/services/repository";

/** The harness render origin (the routes derive it from the request URL). */
const SEED_ORIGIN = "https://test.local";

/** The owner-row pair the service ops take (the routes resolve it from D1). */
async function loadPair(owner: string, slug: string): Promise<RepositoryWithOwner> {
  const db = drizzle(env.DB);
  const repoRow = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerNamespace, owner.toLowerCase()), eq(repositories.slug, slug.toLowerCase())))
    .get();
  if (repoRow === undefined) throw new Error(`wiki seed: repo row missing: ${owner}/${slug}`);
  // ownerId is nullable in the schema; a wiki seed only ever hangs off a
  // harness row whose owner was resolved at create — null is the loud error.
  const ownerRow =
    repoRow.ownerId === null
      ? undefined
      : await db.select().from(users).where(eq(users.id, repoRow.ownerId)).get();
  if (ownerRow === undefined) throw new Error(`wiki seed: owner row missing: ${owner}/${slug}`);
  return { repo: repoRow, owner: ownerRow };
}

export interface SeedWikiPageOptions {
  owner: string;
  slug: string;
  /** The page title (WebPath-coded by the service; "Home" is the view default). */
  title: string;
  /** UTF-8 page content (encoded here; the routes encode the form field). */
  content: string;
  /** Pinned author/committer unix-seconds stamp (the whole point — the
   *  stored commit's wall-clock bytes become fixture bytes). */
  now: number;
  /** Commit identity; default = the owner row through the route derivation
   *  (username + stored email, else `@noreply.test.local`). */
  doer?: WikiDoer;
  /** Empty message → the service's upstream default template. */
  message?: string;
}

/**
 * Land one wiki page through the LANDED createWikiPage op with the commit
 * stamps pinned. Idempotent: a readable page returns null without writing
 * (the golden suites' beforeAll re-runs); otherwise the fresh page read-back
 * comes back (its `last_commit.sha` is the deterministic commit oid).
 */
export async function seedWikiPage(options: SeedWikiPageOptions): Promise<ReturnType<typeof createWikiPage> | null> {
  const pair = await loadPair(options.owner, options.slug);
  const existing = await readWikiPage(env, pair, options.title, SEED_ORIGIN);
  if (existing !== null) return null;
  const doer = options.doer ?? {
    name: pair.owner.username,
    email: pair.owner.email === null || pair.owner.email === "" ? `${pair.owner.username}@noreply.test.local` : pair.owner.email,
  };
  return createWikiPage(
    env,
    pair,
    doer,
    {
      title: options.title,
      content: new TextEncoder().encode(options.content),
      message: options.message ?? "",
    },
    SEED_ORIGIN,
    { now: options.now },
  );
}
