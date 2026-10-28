/**
 * The `/{owner}/{repo}/tags.rss` + `/{owner}/{repo}/tags.atom`
 * tags-feed envelopes — pages wave-tags-feeds (PORT-FIRST; MOUNTED at
 * 2f7afe9 — the retired wiring HANDOFF is the mount record below). Byte
 * surfaces over the landed tags data (never a
 * self-fetch): no JSX, the two XML documents are composed as strings with
 * the exact Go serializer semantics upstream ships — the gorilla v1.2.0
 * envelope helpers are imported VERBATIM from the landed twin
 * (`user-feed-xml.ts`, efce750) so the escape/format table keeps one copy;
 * only the tags item projection + channel fields live here (upstream runs
 * the SAME `writeFeed` across the user, releases, and tags families).
 *
 * ## Verified upstream registrations (submodule pin fc4936884584)
 *
 * `routers/web/web.go:1494-1503` — the repo tags group:
 *
 *     m.Group("/{username}/{reponame}", func() { // repo tags
 *         m.Group("/tags", func() {
 *             m.Get("", context.RepoRefByDefaultBranch(), repo.TagsList)
 *             m.Get(".rss", webAuth.AllowBasic, feedEnabled, repo.TagsListFeedRSS)
 *             m.Get(".atom", webAuth.AllowBasic, feedEnabled, repo.TagsListFeedAtom)
 *             m.Get("/list", repo.GetTagList)
 *         }, ctxDataSet(...))
 *         m.Post("/tags/delete", ...)
 *     }, optSignIn, context.RepoAssignment, repo.MustBeNotEmpty, reqUnitCodeReader)
 *
 * Gitea's `Router.getPattern` (modules/web/router.go:104-113) concatenates
 * `curGroupPrefix + pattern` with NO slash, so the two tails bind
 * `/tags` + `.rss`/`.atom` = `/{username}/{reponame}/tags.rss` and
 * `.../tags.atom` (web.go:1497-1498, `TagsListFeed{RSS,Atom}`).
 *
 * **The group's gates DIFFER from the releases twin's** (web.go:1502 vs
 * :1526): the tags family rides `reqUnitCodeReader` — the CODE unit
 * reader — NOT `reqRepoReleaseReader`. Upstream's own convert.go comment
 * says why: "the tags feed only requires code access". Consequences the
 * route arm must honor: an EMPTY repo 404s before the handler
 * (`repo.MustBeNotEmpty`, :1502), but a repo with the releases unit
 * DISABLED still serves this feed (no release-reader gate) — the route
 * must NOT run the landed `releasesReadGate` pair; the releases-unit
 * state instead degrades the ITEM projection (below). `feedEnabled` gates
 * on `setting.Other.EnableFeed`, pin default TRUE (modules/setting/
 * other.go:21 — the twin module's note), so no landed EnableFeed arm.
 *
 * ## Upstream shape (cited — routers/web/feed/release.go + convert.go)
 *
 * `TagsListFeed{RSS,Atom}` (routers/web/repo/release.go:284-296) →
 * `releasesOrTagsFeed(ctx, isReleasesOnly: false, format)` →
 * `feed.ShowReleaseFeed` (routers/web/feed/release.go:17-55):
 * `db.Find[Release](FindReleasesOptions{IncludeTags: !isReleasesOnly,
 * RepoID})` — with `isReleasesOnly=false` that is `IncludeTags: true`:
 * `IncludeDrafts` unset → `is_draft = false` (models/repo/release.go
 * :276-278) and `IncludeTags: true` applies NO `is_tag` condition AT ALL
 * (:279-281) — the tags feed carries the release table's TAG RECORDS and
 * RELEASE ROWS alike (upstream's push-synced table IS its tag universe:
 * every pushed tag owns an `is_tag=true` row, a release upgrades its row
 * to `is_tag=false` with Title/Note). Order `created_unix DESC, id DESC`
 * (ToOrders :313-315), the zero `ListOptions` applies NO pagination —
 * the feed carries every matching row.
 *
 * Channel fields (:27-46, the else-arm): Title =
 * `TrString("repo.release.tags_for", repo.FullName())` —
 * locale_en-US.json:2706 `Tags for %s`; Link = `repo.HTMLURL() + "/tags"`
 * — NOT the releases twin's singular `/release` quirk; the tags arm uses
 * the plain plural tail (release.go:40); Description = the RAW
 * `repo.Description` (no markdown render); Created = `time.Now()`. Then
 * `releasesToFeedItems` and the shared `writeFeed` (profile.go:91-104) —
 * content types `application/atom+xml;charset=utf-8` /
 * `application/rss+xml;charset=utf-8`.
 *
 * The item projection (`convert.go:279-319 releasesToFeedItems`) — the
 * ONE place the tags family branches on a viewer/unit state:
 * `canReadReleases := ctx.Repo.Permission.CanRead(unit.TypeReleases)`.
 * With the releases unit ENABLED and readable (the default): per row —
 * `title = rel.Title` when `!rel.IsTag`, else the TagName (the tags
 * arm's query admits both kinds, so this arm finally matters — a tag
 * record renders its tag name, a release its title; NO empty-fallback on
 * either); `link = rel.HTMLURL()` = `{repo HTMLURL}/releases/tag/
 * {PathEscapeSegments(TagName)}` (models/repo/release.go:144-147 —
 * TagName-keyed for BOTH kinds); `content = markdown.RenderString(
 * NewRenderContextRepoComment + UseAbsoluteLink(true), rel.Note)` — the
 * landed `renderIssueMarkdown` (repo-comment posture, the twin's §3.4
 * note; a pipeline failure degrades to "" where upstream ServerErrors
 * the whole feed); Author = `{Name: Publisher.GetDisplayName(), Email:
 * Publisher.GetEmail()}` with the LoadAttributes ghost arm (release.go
 * :116-125 — a missing publisher row is `NewGhostUser()`: Name "Ghost",
 * Email ""); `Id = fmt.Sprintf("%v: %v", rel.ID, link.Href)`;
 * `Created = rel.PublishedUnix.AsTime()`; `Description`/`IsPermaLink`
 * NEVER set (the twin's envelope deltas: always-empty RSS
 * `<description>`, bare `<guid>`, no Atom `<summary>`).
 * With the releases unit UNREADABLE: title = TagName for EVERY row
 * (the `!rel.IsTag` arm is skipped — release titles never leak),
 * `link = rel.Repo.HTMLURL() + "/src/tag/" +
 * util.PathEscapeSegments(rel.TagName)` (convert.go:294-296 — "list
 * releases as plain tags like the tags page does"), content = "" (the
 * render never runs) — Author/Created/Id are set OUTSIDE the branch and
 * still render.
 *
 * ## Data-source semantics (the documented landed divergence)
 *
 * Upstream feeds the RELEASE TABLE (`IncludeTags: true`) because its
 * push-synced rows ARE the tag universe. This engine has no push-sync
 * subsystem — the D1 `releases` table holds release rows (in practice
 * `is_tag=false` only; no landed writer creates tag records), and the
 * TAG universe is the ENGINE's `refs/tags/*` (the landed tags page's
 * exact posture, pages/tags.tsx: "the push-synced stand-in this engine
 * has no subsystem for"). The loader therefore walks the engine ref
 * universe (byte-asc name order — the tags family's landed sort, the
 * API's sortedTags convention) and joins the D1 non-draft rows of BOTH
 * kinds by `lower_tag_name` (the query upstream runs, minus the
 * unreachable-in-practice kind filter). Divergences this forces, each
 * mirroring an arm the tags page already carries:
 *
 * - An engine tag with no D1 row renders as a plain tag: title = the tag
 *   name, no content, NO author elements (upstream always has a row and
 *   a publisher — the rowless animal is ours), id `0: {link}` (Go's zero
 *   int64 render through upstream's own Sprintf), Created = the epoch
 *   (the zero `PublishedUnix`; the engine boundary carries no tag
 *   timestamps — the tags page's unrendered-time reduction verbatim).
 * - A D1 row whose git tag is gone never renders (upstream's row↔tag
 *   sync keeps such orphans from existing; our delete flow drops the row
 *   with the ref — the tags page's engine-universe rule).
 * - The feed ORDER is byte-asc by tag name, NOT upstream's
 *   `created_unix DESC`: the engine carries no per-tag timestamps, so
 *   upstream's order is unreproducible for the rowless majority (the
 *   tags page's identical choice).
 * - The canReadReleases reduction: upstream = releases unit enabled AND
 *   the viewer holds release read. Landed: the viewer arm collapses into
 *   the route's §2.5 visibility gate (the tags page's "no landed units —
 *   the §2.5 read grant IS the code-read arm" reduction), and the unit
 *   arm is `repo_settings.has_releases` (the `releasesReadGate` pair's
 *   second clause, ui/index.ts:7878-7883) — the projection's
 *   `canReadReleases` is the loaded setting, viewer-invariant.
 * - Under `canReadReleases`, a tag-only record or rowless tag still
 *   links `/src/tag/{name}` (NOT upstream's `rel.HTMLURL()`): upstream's
 *   SingleRelease serves tag-only rows, the LANDED release detail 404s
 *   them (pages/releases.tsx's assertNotTagRecord posture) — the tags
 *   page's dead-link rule picks upstream's OWN else-arm target. A
 *   release-backed row keeps `/releases/tag/{name}`.
 *
 * ## Mount record (MOUNTED at 2f7afe9 — the wiring HANDOFF, kept as the
 *    landed-shape record; the releases twin's recipe)
 *
 * 1. Route type (beside the releases twin's `ReleasesFeedRoute` — its
 *    mount record's step 1):
 *
 *      /** The tags feed tails (pages/tags-feed-xml.ts): upstream
 *       *  web.go:1497-1498's `m.Get(".rss"/".atom", …, repo.TagsListFeed{RSS,Atom})`
 *       *  — group prefix + suffix with no slash (modules/web/router.go
 *       *  getPattern), so the URLs are `/tags.rss` and `/tags.atom`. The
 *       *  tags group's gate is reqUnitCodeReader (web.go:1502) — NOT the
 *       *  releases family's `releasesReadGate`: only MustBeNotEmpty 404s
 *       *  here; a releases-disabled repo still serves (degraded items). *\/
 *      export interface TagsFeedRoute {
 *        family: "tags-feed-rss" | "tags-feed-atom";
 *        owner: string;
 *        repo: string;
 *      }
 *
 *    and add the two families to the `ParsedUiRoute` union (index.ts:2327).
 * 2. Parse claim in `parseUiRoute`, beside the tags family's existing
 *    `head === "tags"` block (index.ts:3370 — disjoint literals, order
 *    irrelevant; the raw segment is the claim, matching the landed
 *    lowercase-exact chi-literal convention — the block's own comment
 *    already promises the tails stay unclaimed until a feed wave lands):
 *
 *      // The feed tails (pages/tags-feed-xml.ts — upstream web.go:1497-
 *      // 1498's static `.rss`/`.atom` literals): the EXACT single dotted
 *      // segment, case-sensitively like every chi literal; anything else
 *      // (`tags.RSS`, a ref named `tags.rss`) stays unclaimed → the
 *      // engine's 404, upstream's pattern-miss answer.
 *      if (tail.length === 1 && (head === "tags.rss" || head === "tags.atom")) {
 *        return {
 *          family: head === "tags.rss" ? "tags-feed-rss" : "tags-feed-atom",
 *          owner,
 *          repo,
 *        };
 *      }
 *
 * 3. Registration (the user-feed family's one-constrained-registration
 *    convention, ui/index.ts:9716-9717):
 *
 *      uiRouter.get("/:owner/:repo/:segment{^tags\\.(rss|atom)$}", (c) => tagsFeedRoute(c));
 *
 * 4. Route arm (the `releaseDownloadTail` shape, ui/index.ts:7509-7547):
 *    `resolveUiRequest` (the §2.5 repo read + visibility prologue — this
 *    IS the group's RepoAssignment + reqUnitCodeReader pair, the tags
 *    page's own gate posture) → drift-guard the family → `loadTagsFeedData(env, db, repo, url.origin)`
 *    (null → the §4.5 404 shell — the ONLY null arm is `MustBeNotEmpty`;
 *    do NOT run `releasesReadGate`, web.go:1502 has no release-reader) →
 *    `renderTagsFeedRss`/`renderTagsFeedAtom` by family → `new Response(body,
 *    { headers: { "content-type": TAGS_FEED_CONTENT_TYPES.rss/.atom } })`.
 *    No EnableFeed arm (the pin default is TRUE — the module header). No
 *    viewer parameter: the drafts exclusion is unconditional upstream
 *    (IncludeDrafts unset → false, even for the owner — release.go:21-24)
 *    and the projection's unit state is the loaded `has_releases`.
 */

import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { loadRepoSettings } from "../../api/services/repo-settings";
import { engineReads } from "../../api/services/engine";
import { releases, users } from "../../db/schema";
import type { ReleaseRow } from "../../issues/service";
import { renderIssueMarkdown } from "./issue-detail";
import type { RepoRow } from "../ui-context";
import {
  USER_FEED_CONTENT_TYPES,
  cdataBody,
  escapeXmlText,
  formatRfc1123z,
  formatRfc3339,
} from "./user-feed-xml";

// ---------------------------------------------------------------------------
// The tags item projection (convert.go releasesToFeedItems over the tags arm)
// ---------------------------------------------------------------------------

/** `TrString("repo.release.tags_for", FullName)` — locale_en-US.json:2706
 *  `Tags for %s` (feed/release.go:39). */
const TAGS_FOR = "Tags for %s";

/** The ghost publisher (LoadAttributes' NewGhostUser arm —
 *  models/repo/release.go:116-125 + models/user/user_system.go:13-24):
 *  Name "Ghost", Email "" (GetDisplayName at the pin → the username;
 *  GetEmail → the zero email). */
const GHOST_PUBLISHER = { name: "Ghost", email: "" } as const;

/** A ROWLESS engine tag's author (upstream has no such animal — every tag
 *  owns a push-synced row and a publisher): no author elements on either
 *  envelope (the gorilla omitempty posture). */
const NO_PUBLISHER = { name: "", email: "" } as const;

/** `util.PathEscapeSegments` (modules/util/url.go:12-18): split on "/",
 *  `url.PathEscape` each segment, rejoin. Local mirror — the twins'
 *  helpers are module-private and index.ts is not this wave's file. */
function pathEscapeSegments(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/** The publisher identity behind one feed row (GetDisplayName /
 *  GetEmail — the module header's reductions). */
export interface TagsFeedPublisher {
  readonly name: string;
  readonly email: string;
}

/** The upstream feeds.Item — exactly the fields gorilla's serializer reads
 *  (feed.go:36-50) that `releasesToFeedItems` sets for the tags arm's rows
 *  (convert.go:305-315). `Description` and `IsPermaLink` are NEVER set
 *  upstream for release/tag items — their gorilla consequences (RSS keeps
 *  the empty `<description>`, drops the guid attr; Atom drops the summary)
 *  are the envelope's job, so the fields stay out of the type. */
export interface TagsFeedItem {
  /** `rel.Title` when release-backed and readable, else the tag name
   *  (convert.go:287/:299-300 — the IsTag arm plus the !canReadReleases
   *  pin; NO empty-fallback). */
  readonly title: string;
  /** `rel.HTMLURL()` (`/releases/tag/{escaped}`) for release-backed rows
   *  under canReadReleases; `/src/tag/{escaped}` otherwise (the else-arm
   *  target — also the landed dead-link rule for tag-only/rowless tags). */
  readonly link: string;
  /** The rendered `rel.Note` when readable ("" when absent or when the
   *  releases unit is unreadable — no element on either envelope). */
  readonly content: string;
  /** Author.Name = GetDisplayName (the ghost arm renders "Ghost"; a
   *  rowless tag carries ""). */
  readonly authorName: string;
  /** Author.Email = GetEmail (the row email verbatim; "" → no Atom
   *  `<email>`; RSS copies only the Name anyway). */
  readonly authorEmail: string;
  /** `fmt.Sprintf("%v: %v", rel.ID, link.Href)` (convert.go:313); a
   *  rowless tag renders the zero id: `0: {link}`. */
  readonly id: string;
  /** `rel.PublishedUnix.AsTime()` as unix seconds (0 → the epoch — the
   *  zero column, and the rowless tag's only honest value). */
  readonly createdUnix: number;
}

/** One tags-feed row → one feeds.Item, element-for-element vs
 *  convert.go:279-319's composer over the tags arm's query (both row
 *  kinds admitted). `row` null = a rowless engine tag (the module
 *  header's data-source note). `repoHref` is `repo.HTMLURL()`'s stand-in
 *  (`AppURL + FullName()`, NO escaping — models/repo/repo.go). */
export function tagsFeedItemFromRow(
  tagName: string,
  row: ReleaseRow | null,
  publisher: TagsFeedPublisher,
  canReadReleases: boolean,
  repoHref: string,
  origin: string,
  repo: RepoRow,
): TagsFeedItem {
  const releaseBacked = row !== null && !row.isTag;
  // The link: release-backed + readable → rel.HTMLURL(); everything else
  // → upstream's own else-arm target /src/tag/{tag} (convert.go:294-296
  // overrides the link for EVERY row when the releases unit is unreadable
  // — and it doubles as the landed dead-link rule for tag-only/rowless
  // tags, which the release detail would 404 — the tags page's choice).
  const link =
    canReadReleases && releaseBacked
      ? `${repoHref}/releases/tag/${pathEscapeSegments(tagName)}`
      : `${repoHref}/src/tag/${pathEscapeSegments(tagName)}`;
  // The title: TagName, upgraded to rel.Title only for a readable
  // release row (convert.go:287 default + :299-300's !IsTag arm +
  // :294-296's !canReadReleases pin; NO empty-fallback).
  const title = canReadReleases && releaseBacked ? (row?.title ?? "") : tagName;
  // The content: the rendered Note only in the readable else-branch
  // (convert.go:301-303); the !canReadReleases arm leaves it nil. A
  // tag-only row's (always-empty) Note renders "" like upstream's would.
  const content =
    canReadReleases && row !== null ? renderIssueMarkdown({ text: row.note ?? "", repo, origin }) : "";
  return {
    title,
    link,
    content,
    authorName: publisher.name,
    authorEmail: publisher.email,
    id: `${row === null ? 0 : row.id}: ${link}`,
    createdUnix: row === null ? 0 : row.publishedUnix,
  };
}

// ---------------------------------------------------------------------------
// The envelopes (gorilla/feeds v1.2.0 WriteRss / WriteAtom bytes, the
// tags channel fields + the shared release-item shape)
// ---------------------------------------------------------------------------

/** `writeFeed`'s content types (profile.go:94-104) — the SAME shared
 *  helper upstream uses for every feed family. */
export const TAGS_FEED_CONTENT_TYPES = USER_FEED_CONTENT_TYPES;

/** The channel-level render input (the Feed struct fields ShowReleaseFeed
 *  sets over the tags arm — feed/release.go:30-46; no Author/Image/
 *  Copyright upstream). */
export interface TagsFeedEnvelopeInput {
  /** `Tags for {owner}/{repo}` — repo.FullName() verbatim (display
   *  text; the envelopes XML-escape it). */
  readonly title: string;
  /** `repo.HTMLURL() + "/tags"` — the tags arm's link (feed/release.go:40;
   *  no singular-tail quirk here). */
  readonly link: string;
  /** The RAW repo description (no markdown render — release.go:44; ""
   *  renders the empty RSS `<description>`, drops the Atom `<subtitle>`). */
  readonly description: string;
  /** `time.Now()` at handler time. */
  readonly generatedUnix: number;
  readonly items: readonly TagsFeedItem[];
}

/** `<?xml version="1.0" encoding="UTF-8"?>` — Go xml.Header minus its
 *  trailing newline (gorilla feed.go:85/94 strips it), straight into the
 *  root element. */
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

/** gorilla `WriteRss` bytes for the tags feed — element-for-element vs
 *  the verified v1.2.0 map (the releases twin's release-item deltas,
 *  identical here: release/tag items never set Description or
 *  IsPermaLink). No trailing newline. */
export function renderTagsFeedRss(input: TagsFeedEnvelopeInput): string {
  const e = escapeXmlText;
  const lines: string[] = [
    `${XML_HEADER}<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">`,
    "  <channel>",
    `    <title>${e(input.title)}</title>`,
    `    <link>${e(input.link)}</link>`,
    `    <description>${e(input.description)}</description>`,
    `    <pubDate>${formatRfc1123z(input.generatedUnix)}</pubDate>`,
  ];
  for (const item of input.items) {
    lines.push(
      "    <item>",
      `      <title>${e(item.title)}</title>`,
      `      <link>${e(item.link)}</link>`,
      // gorilla's `xml:"description"` — no omitempty: the empty value
      // still emits the paired empty element (release items never set one).
      `      <description>${e("")}</description>`,
    );
    if (item.content !== "") {
      lines.push(`      <content:encoded><![CDATA[${cdataBody(item.content)}]]></content:encoded>`);
    }
    if (item.authorName !== "") {
      // newRssItem copies ONLY the Name into <author> (rss.go :126-128).
      lines.push(`      <author>${e(item.authorName)}</author>`);
    }
    if (item.id !== "") {
      // IsPermaLink "" → the omitempty attr DROPS (the action items'
      // isPermaLink="false" never appears on release/tag items).
      lines.push(`      <guid>${e(item.id)}</guid>`);
    }
    lines.push(`      <pubDate>${formatRfc1123z(item.createdUnix)}</pubDate>`, "    </item>");
  }
  lines.push("  </channel>", "</rss>");
  return lines.join("\n");
}

/** gorilla `WriteAtom` bytes for the tags feed — element-for-element vs
 *  the verified v1.2.0 map (same item deltas as the releases twin). No
 *  trailing newline. */
export function renderTagsFeedAtom(input: TagsFeedEnvelopeInput): string {
  const e = escapeXmlText;
  const lines: string[] = [
    `${XML_HEADER}<feed xmlns="http://www.w3.org/2005/Atom">`,
    `  <title>${e(input.title)}</title>`,
    `  <id>${e(input.link)}</id>`,
    `  <updated>${formatRfc3339(input.generatedUnix)}</updated>`,
  ];
  if (input.description !== "") {
    lines.push(`  <subtitle>${e(input.description)}</subtitle>`);
  }
  lines.push(`  <link href="${e(input.link)}"></link>`);
  for (const item of input.items) {
    lines.push(
      "  <entry>",
      `    <title>${e(item.title)}</title>`,
      `    <updated>${formatRfc3339(item.createdUnix)}</updated>`,
      `    <id>${e(item.id)}</id>`,
    );
    if (item.content !== "") {
      lines.push(`    <content type="html">${e(item.content)}</content>`);
    }
    lines.push(`    <link href="${e(item.link)}" rel="alternate"></link>`);
    // No <summary>: release/tag items never set Description (the
    // AtomSummary is built only over a non-empty description — atom.go
    // newAtomEntry).
    if (item.authorName !== "" || item.authorEmail !== "") {
      lines.push("    <author>");
      if (item.authorName !== "") {
        lines.push(`      <name>${e(item.authorName)}</name>`);
      }
      if (item.authorEmail !== "") {
        lines.push(`      <email>${e(item.authorEmail)}</email>`);
      }
      lines.push("    </author>");
    }
    lines.push("  </entry>");
  }
  lines.push("</feed>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The loader (ShowReleaseFeed's tags arm over the landed sources of truth)
// ---------------------------------------------------------------------------

/** The publisher batch row (`GetDisplayName`/`GetEmail` inputs — the
 *  username + the nullable email verbatim, the twins' reductions). */
interface PublisherRow {
  id: number;
  username: string;
  email: string | null;
}

/**
 * `ShowReleaseFeed`'s tags arm (feed/release.go:17-55) over the landed
 * sources of truth (the module header's data-source note): the ENGINE
 * `refs/tags/*` universe (byte-asc — the tags family's landed sort)
 * joined with the D1 non-draft rows of BOTH kinds by `lower_tag_name`
 * (upstream's `FindReleasesOptions{IncludeTags: true}` semantics:
 * `is_draft = false`, no `is_tag` condition — models/repo/release.go
 * :276-281), the batched publisher join carrying the ghost arm. The
 * channel description is the RAW repo description (repo_settings store).
 * `canReadReleases` is the loaded `has_releases` setting (the releases
 * twin's gate pair's unit clause — the route must NOT 404 on it, the
 * tags group's gate is reqUnitCodeReader, web.go:1502). `null` =
 * upstream's group-gate answer the route must 404-shell:
 * `repo.MustBeNotEmpty` — an EMPTY repo never reaches the handler
 * (web.go:1502; the loader keeps the arm honest standalone).
 */
export async function loadTagsFeedData(
  env: Env,
  d1: D1Database,
  repo: RepoRow,
  origin: string,
  // Wall-clock seam (render-wallclock-audit): the channel Created stamp
  // (generatedUnix → RSS pubDate / Atom updated). Default keeps every
  // caller unchanged; tests pin it for byte-stable feeds.
  now: Date = new Date(),
): Promise<TagsFeedEnvelopeInput | null> {
  if (repo.isEmpty) return null; // MustBeNotEmpty (web.go:1502)

  // The engine tag universe (a failed ref read degrades to the empty
  // list — §4.9, the tags page's exact posture).
  const refs = await engineReads(env, repo).listRefs();
  const tagRefs = (refs?.refs ?? []).filter((ref) => ref.name.startsWith("refs/tags/"));
  const tagNames = tagRefs
    .map((ref) => ref.name.slice("refs/tags/".length))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  // The D1 rows of BOTH kinds, drafts excluded (IncludeTags: true +
  // IncludeDrafts-unset — ToConds :276-281). One read, joined by the
  // lookup key findReleaseByTag uses (lower_tag_name — upstream's own
  // case-insensitive GetRelease key).
  const rows = await drizzle(d1)
    .select()
    .from(releases)
    .where(and(eq(releases.repoId, repo.id), eq(releases.isDraft, false)))
    .all();
  const rowByTag = new Map(rows.map((row) => [row.lowerTagName, row]));

  // One batched publisher lookup (the twins' enrich pattern); a missing
  // (or non-positive) id renders the ghost — LoadAttributes' NewGhostUser
  // arm. A rowless tag has no publisher at all (NO_PUBLISHER).
  const publisherIds = [...new Set(rows.map((row) => row.publisherId).filter((id) => id > 0))];
  const publishers = new Map<number, PublisherRow>();
  if (publisherIds.length > 0) {
    const rowsById = await drizzle(d1)
      .select({ id: users.id, username: users.username, email: users.email })
      .from(users)
      .where(inArray(users.id, publisherIds))
      .all();
    for (const row of rowsById) publishers.set(row.id, row);
  }

  const settings = await loadRepoSettings(d1, repo.id);
  const repoHref = `${origin}/${repo.ownerNamespace}/${repo.slug}`; // repo.HTMLURL() — NO escaping
  const items = tagNames.map((tagName) => {
    const row = rowByTag.get(tagName.toLowerCase()) ?? null;
    const publisher =
      row === null
        ? NO_PUBLISHER
        : ((): TagsFeedPublisher => {
            const publisherRow = publishers.get(row.publisherId);
            return publisherRow === undefined
              ? GHOST_PUBLISHER
              : { name: publisherRow.username, email: publisherRow.email ?? "" };
          })();
    return tagsFeedItemFromRow(
      tagName,
      row,
      publisher,
      settings.hasReleases,
      repoHref,
      origin,
      repo,
    );
  });

  // The channel fields (feed/release.go:30-46): the tags_for locale title
  // over FullName(), the plain `/tags` link, the RAW description
  // (repo_settings store — no markdown render), Created = now.
  return {
    title: TAGS_FOR.replace("%s", `${repo.ownerNamespace}/${repo.slug}`),
    link: `${repoHref}/tags`,
    description: settings.description,
    generatedUnix: Math.floor(now.getTime() / 1000),
    items,
  };
}
