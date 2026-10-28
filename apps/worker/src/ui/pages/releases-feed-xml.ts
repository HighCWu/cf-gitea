/**
 * The `/{owner}/{repo}/releases.rss` + `/{owner}/{repo}/releases.atom`
 * releases-feed envelopes — pages wave-releases-feeds (PORT-FIRST;
 * MOUNTED at 2f7afe9 — the retired wiring HANDOFF is the mount record
 * below). Byte surfaces over the landed releases
 * data (never a self-fetch): no JSX, the two XML documents are composed as
 * strings with the exact Go serializer semantics upstream ships — the
 * gorilla v1.2.0 envelope helpers are imported VERBATIM from the landed
 * twin (`user-feed-xml.ts`, efce750) so the escape/format table keeps one
 * copy; only the releases item projection + channel fields live here
 * (upstream shares `writeFeed` across both families exactly the same way).
 *
 * ## Verified upstream registrations (submodule pin fc4936884584)
 *
 * `routers/web/web.go:1505-1510` — the repo releases group:
 *
 *     m.Group("/{username}/{reponame}", func() { // repo releases
 *         m.Group("/releases", func() {
 *             m.Get("", repo.Releases)
 *             m.Get(".rss", webAuth.AllowBasic, feedEnabled, repo.ReleasesFeedRSS)
 *             m.Get(".atom", webAuth.AllowBasic, feedEnabled, repo.ReleasesFeedAtom)
 *             ...
 *
 * Gitea's `Router.getPattern` (modules/web/router.go:104-113) concatenates
 * `curGroupPrefix + pattern` with NO slash, so the two tails bind
 * `/releases` + `.rss`/`.atom` = `/{username}/{reponame}/releases.rss` and
 * `.../releases.atom`. There is NO `releases/tags.rss|.atom` registration —
 * the survey's releases row guessed one; the dotted tags tails are the
 * SIBLING tags group's `/tags.rss|.atom` (web.go:1497-1498,
 * `TagsListFeed{RSS,Atom}` — a different family, `isReleasesOnly=false`).
 * Group gates (web.go:1504): `optSignIn`, `context.RepoAssignment`,
 * `repo.MustBeNotEmpty` (an EMPTY repo 404s before the handler) and
 * `reqRepoReleaseReader` (the releases unit reader — the landed
 * `releasesReadGate` pair, ui/index.ts:7865-7870); `feedEnabled` gates on
 * `setting.Other.EnableFeed` whose pin default is TRUE
 * (modules/setting/other.go:21 — the twin module's note), so no landed
 * EnableFeed arm.
 *
 * ## Upstream shape (cited — routers/web/feed/release.go + convert.go)
 *
 * `ReleasesFeed{RSS,Atom}` (routers/web/repo/release.go:278-294) →
 * `releasesOrTagsFeed(ctx, isReleasesOnly: true, format)` →
 * `feed.ShowReleaseFeed` (routers/web/feed/release.go:17-55):
 * `db.Find[Release](FindReleasesOptions{IncludeTags: false, RepoID})` —
 * `IncludeDrafts` unset → `is_draft = false`, `IncludeTags: false` →
 * `is_tag = false` (models/repo/release.go:280-292 ToConds), order
 * `created_unix DESC, id DESC` (ToOrders, release.go:314-316), and the zero
 * `ListOptions` applies NO pagination — the feed carries every matching
 * row. Prereleases are NOT filtered. Channel fields (:33-46): Title =
 * `TrString("repo.release.releases_for", repo.FullName())` —
 * locale_en-US.json `repo.release.releases_for` = `Releases for %s`;
 * Link = `repo.HTMLURL() + "/release"` — the SINGULAR `/release` tail is
 * upstream's own quirk (release.go:35), ported verbatim; Description =
 * the RAW `repo.Description` (no markdown render — unlike the user feed's
 * bio); Created = `time.Now()`. Then `releasesToFeedItems` and the shared
 * `writeFeed` (routers/web/feed/profile.go:91-104) — content types
 * `application/atom+xml;charset=utf-8` / `application/rss+xml;charset=utf-8`.
 *
 * The item projection (`convert.go:279-319 releasesToFeedItems`) over the
 * releases-only query (`canReadReleases` is guaranteed TRUE by the group's
 * `reqRepoReleaseReader` gate, so the else-branch (:294-303) always runs):
 * per release — `title = rel.Title` when `!rel.IsTag` (the query pins
 * `is_tag = false`, so always; NO empty-fallback — an empty release title
 * emits an empty `<title>`, unlike the releases PAGE's a11y fallback,
 * releases.tsx `releaseTitleOf`); `link = rel.HTMLURL()` =
 * `{repo HTMLURL}/releases/tag/{PathEscapeSegments(TagName)}`
 * (models/repo/release.go — no escaping on owner/repo, segments-escape on
 * the tag); `content = markdown.RenderString(NewRenderContextRepoComment +
 * UseAbsoluteLink(true), rel.Note)` — the releases family's landed
 * `renderIssueMarkdown` (repo-comment posture, the page module's §3.4
 * note; a pipeline failure degrades to "" where upstream ServerErrors the
 * whole feed — the landed markdown posture); `Author = {Name:
 * Publisher.GetDisplayName(), Email: Publisher.GetEmail()}` with the
 * LoadAttributes ghost arm (release.go:41-50 — a missing publisher row is
 * `NewGhostUser()`: Name "Ghost", Email ""); `Id = fmt.Sprintf("%v: %v",
 * rel.ID, link.Href)`; `Created = rel.PublishedUnix.AsTime()`; and — the
 * difference from the action items — `Description` and `IsPermaLink` are
 * NEVER set ("" zeros).
 *
 * The serializer is gorilla/feeds v1.2.0 (gitea/go.mod:51) — the twin
 * module's byte-verification note carries the escape/time-format tables.
 * The release-item deltas over the twin's envelopes, re-verified against
 * the v1.2.0 source (rss.go/atom.go in the module cache):
 *
 * - RSS `<guid>`: `IsPermaLink ""` → the `isPermaLink,attr,omitempty` tag
 *   DROPS the attribute → bare `<guid>{id}</guid>` (the action items'
 *   `isPermaLink="false"` never appears here);
 * - RSS `<description>`: gorilla's `xml:"description"` has NO omitempty →
 *   the empty value still emits `<description></description>`;
 * - RSS `<author>`: `xml:"author,omitempty"` over `i.Author.Name` —
 *   present for every real/ghost publisher (name never "");
 * - Atom `<summary>`: `Summary *AtomSummary` built only when the
 *   description is non-empty (atom.go newAtomEntry) — release items set
 *   none → NO summary element ever;
 * - Atom `<author>`: present when name OR email is non-empty; the
 *   `AtomPerson.Name` tag is itself omitempty → `<name>` drops when "";
 * - everything else (header glued to the root element
 *   `xml.Header[:len-1]`, two-space indent, paired empty elements, the
 *   EscapeText/CDATA/RFC1123Z/RFC3339 semantics) is byte-identical to the
 *   twin's verified maps — the helpers are imported, not copied.
 *
 * ## Documented reductions (the §6 method — shared with the twin)
 *
 * - `GetEmail` renders the row's nullable email verbatim (the landed
 *   posture — the twin's header note; `user_settings.hide_email` defaults
 *   false = show, an absent row renders the default).
 * - `GetDisplayName` resolves through `setting.UI.DefaultShowFullName`
 *   (pin default FALSE) → the username; the ghost publisher renders
 *   "Ghost" (user_system.go:13-24).
 * - The repo-comment render context with `UseAbsoluteLink(true)` is the
 *   releases family's landed `renderIssueMarkdown` (issue-detail.tsx) —
 *   the page module's exact §3.4 posture.
 * - Times format in UTC (`+0000` / `Z`) — the twin's note verbatim.
 * - `markup.Sanitize` never runs here (the twin's reduction: our markdown
 *   output is XSS-safe by construction) — the release feed renders only
 *   `rel.Note`, and the sanitizer arm (convert.go:242-244) lives in the
 *   ACTION projection, not `releasesToFeedItems`.
 *
 * ## Mount record (MOUNTED at 2f7afe9 — the wiring HANDOFF, kept as the
 *    landed-shape record; the wave-41 download-tail precedent)
 *
 * 1. Route type (beside `ReleaseDownloadRoute`):
 *
 *      /** The releases feed tails (pages/releases-feed-xml.ts): upstream
 *       *  web.go:1507-1508's `m.Get(".rss"/".atom", …, repo.ReleasesFeed{RSS,Atom})`
 *       *  — group prefix + suffix with no slash (modules/web/router.go
 *       *  getPattern), so the URLs are `/releases.rss` and `/releases.atom`
 *       *  (no `releases/tags.*` exists — that is the tags family's
 *       *  `/tags.rss|.atom`, web.go:1497-1498). The releases group's gates
 *       *  (web.go:1504) ride `releasesReadGate` like the wave-41 tails. *\/
 *      export interface ReleasesFeedRoute {
 *        family: "release-feed-rss" | "release-feed-atom";
 *        owner: string;
 *        repo: string;
 *      }
 *
 *    and add the two families to the `ParsedUiRoute` union.
 * 2. Parse claim in `parseUiRoute`, beside the `head === "releases"` block
 *    (ui/index.ts:3254 — disjoint literals, order irrelevant; the raw
 *    segment is the claim, matching the landed lowercase-exact chi-literal
 *    convention — NOT the owner-feed family's lowercased-endsWith rule,
 *    which exists to keep UsernameSubRoute's suffix family one rule):
 *
 *      // The feed tails (pages/releases-feed-xml.ts — upstream web.go:1507-
 *      // 1508's static `.rss`/`.atom` literals): the EXACT single dotted
 *      // segment, case-sensitively like every chi literal; anything else
 *      // (`releases.RSS`, a ref named `releases.rss`) stays unclaimed → the
 *      // engine's 404, upstream's pattern-miss answer.
 *      if (tail.length === 1 && (head === "releases.rss" || head === "releases.atom")) {
 *        return {
 *          family: head === "releases.rss" ? "release-feed-rss" : "release-feed-atom",
 *          owner,
 *          repo,
 *        };
 *      }
 *
 * 3. Registration (the user-feed family's one-constrained-registration
 *    convention, ui/index.ts:9716-9717):
 *
 *      uiRouter.get("/:owner/:repo/:segment{^releases\\.(rss|atom)$}", (c) => releasesFeedRoute(c));
 *
 * 4. Route arm (the `releaseDownloadTail` shape, ui/index.ts:7509-7547):
 *    `resolveUiRequest` (the §2.5 repo read + visibility prologue) →
 *    drift-guard the family → `releasesReadGate(db, repo)` (the group's
 *    `MustBeNotEmpty` + `reqRepoReleaseReader` pair verbatim) →
 *    `loadReleasesFeedData(db, repo, url.origin)` (null → the §4.5 404
 *    shell) → `renderReleasesFeedRss`/`renderReleasesFeedAtom` by family →
 *    `new Response(body, { headers: { "content-type":
 *    RELEASES_FEED_CONTENT_TYPES.rss/.atom } })`. No EnableFeed arm (the
 *    pin default is TRUE — the module header). No viewer parameter:
 *    upstream's feed query excludes drafts UNCONDITIONALLY
 *    (IncludeDrafts unset → false, even for the owner — release.go:21-24),
 *    and the releases-reader gate already ran.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { loadRepoSettings } from "../../api/services/repo-settings";
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
// The releases item projection (convert.go releasesToFeedItems)
// ---------------------------------------------------------------------------

/** `TrString("repo.release.releases_for", FullName)` — locale_en-US.json
 *  `Releases for %s` (feed/release.go:34). */
const RELEASES_FOR = "Releases for %s";

/** The ghost publisher (LoadAttributes' NewGhostUser arm —
 *  models/repo/release.go:41-50 + models/user/user_system.go:13-24): Name
 *  "Ghost", Email "" (GetDisplayName at the pin → the username; GetEmail
 *  → the zero email). */
const GHOST_PUBLISHER = { name: "Ghost", email: "" } as const;

/** `util.PathEscapeSegments` (modules/util/url.go:12-18): split on "/",
 *  `url.PathEscape` each segment, rejoin. Local mirror — the twin's
 *  helper is module-private and index.ts is not this wave's file. */
function pathEscapeSegments(value: string): string {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/** The publisher identity behind one release row (GetDisplayName /
 *  GetEmail — the module header's reductions). */
export interface ReleaseFeedPublisher {
  readonly name: string;
  readonly email: string;
}

/** The upstream feeds.Item — exactly the fields gorilla's serializer reads
 *  (feed.go:36-50) that `releasesToFeedItems` sets for release rows
 *  (convert.go:305-315). `Description` and `IsPermaLink` are NEVER set
 *  upstream for release items — their gorilla consequences (RSS keeps the
 *  empty `<description>`, drops the guid attr; Atom drops the summary)
 *  are the envelope's job, so the fields stay out of the type. */
export interface ReleasesFeedItem {
  /** `rel.Title` verbatim when `!IsTag` (the loader's query pins
   *  is_tag=false; NO empty-fallback — convert.go:295-297). */
  readonly title: string;
  /** `rel.HTMLURL()` — `{repo HTMLURL}/releases/tag/{escaped tag}`. */
  readonly link: string;
  /** The rendered `rel.Note` ("" when absent — no element on either
   *  envelope). */
  readonly content: string;
  /** Author.Name = GetDisplayName (the ghost arm renders "Ghost"). */
  readonly authorName: string;
  /** Author.Email = GetEmail (the row email verbatim; "" → no Atom
   *  `<email>`; RSS copies only the Name anyway). */
  readonly authorEmail: string;
  /** `fmt.Sprintf("%v: %v", rel.ID, link.Href)` (convert.go:313). */
  readonly id: string;
  /** `rel.PublishedUnix.AsTime()` as unix seconds (0 → the epoch, the
   *  draft-stamped column's zero). */
  readonly createdUnix: number;
}

/** One release row → one feeds.Item, element-for-element vs
 *  convert.go:279-319's composer over the releases-only query.
 *  `repoHref` is `repo.HTMLURL()`'s stand-in (`AppURL + FullName()`, NO
 *  escaping — models/repo/repo.go). */
export function releaseFeedItemFromRow(
  row: ReleaseRow,
  publisher: ReleaseFeedPublisher,
  repoHref: string,
  origin: string,
  repo: RepoRow,
): ReleasesFeedItem {
  const link = `${repoHref}/releases/tag/${pathEscapeSegments(row.tagName)}`;
  return {
    title: row.title, // !IsTag arm (convert.go:295-297) — the query pins is_tag=false
    link,
    content: renderIssueMarkdown({ text: row.note ?? "", repo, origin }),
    authorName: publisher.name,
    authorEmail: publisher.email,
    id: `${row.id}: ${link}`,
    createdUnix: row.publishedUnix,
  };
}

// ---------------------------------------------------------------------------
// The envelopes (gorilla/feeds v1.2.0 WriteRss / WriteAtom bytes, the
// releases channel fields + release-item shape)
// ---------------------------------------------------------------------------

/** `writeFeed`'s content types (profile.go:94-104) — the SAME shared
 *  helper upstream uses for every feed family. */
export const RELEASES_FEED_CONTENT_TYPES = USER_FEED_CONTENT_TYPES;

/** The channel-level render input (the Feed struct fields ShowReleaseFeed
 *  sets — feed/release.go:41-46; no Author/Image/Copyright upstream). */
export interface ReleasesFeedEnvelopeInput {
  /** `Releases for {owner}/{repo}` — repo.FullName() verbatim (display
   *  text; the envelopes XML-escape it). */
  readonly title: string;
  /** `repo.HTMLURL() + "/release"` — the SINGULAR tail quirk
   *  (feed/release.go:35), ported verbatim. */
  readonly link: string;
  /** The RAW repo description (no markdown render — release.go:44; ""
   *  renders the empty RSS `<description>`, drops the Atom `<subtitle>`). */
  readonly description: string;
  /** `time.Now()` at handler time. */
  readonly generatedUnix: number;
  readonly items: readonly ReleasesFeedItem[];
}

/** `<?xml version="1.0" encoding="UTF-8"?>` — Go xml.Header minus its
 *  trailing newline (gorilla feed.go:85/94 strips it), straight into the
 *  root element. */
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

/** gorilla `WriteRss` bytes for the releases feed — element-for-element
 *  vs the verified v1.2.0 map (the module header's release-item deltas).
 *  No trailing newline. */
export function renderReleasesFeedRss(input: ReleasesFeedEnvelopeInput): string {
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
      // isPermaLink="false" never appears on release items).
      lines.push(`      <guid>${e(item.id)}</guid>`);
    }
    lines.push(`      <pubDate>${formatRfc1123z(item.createdUnix)}</pubDate>`, "    </item>");
  }
  lines.push("  </channel>", "</rss>");
  return lines.join("\n");
}

/** gorilla `WriteAtom` bytes for the releases feed — element-for-element
 *  vs the verified v1.2.0 map. No trailing newline. */
export function renderReleasesFeedAtom(input: ReleasesFeedEnvelopeInput): string {
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
    // No <summary>: release items never set Description (the AtomSummary
    // is built only over a non-empty description — atom.go newAtomEntry).
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
// The loader (ShowReleaseFeed's data arm over the landed releases table)
// ---------------------------------------------------------------------------

/** The publisher batch row (`GetDisplayName`/`GetEmail` inputs — the
 *  username + the nullable email verbatim, the twin's reductions). */
interface PublisherRow {
  id: number;
  username: string;
  email: string | null;
}

/**
 * `ShowReleaseFeed`'s data arm (feed/release.go:17-55) over the D1
 * releases table: `FindReleasesOptions{IncludeTags: false}` —
 * `is_draft = false` AND `is_tag = false` (ToConds, models/repo/release.go
 * :280-292), `created_unix DESC, id DESC` (ToOrders), NO pagination (the
 * zero ListOptions — every matching row). Prereleases are NOT filtered.
 * The publisher join carries the ghost arm; the channel description is
 * the RAW repo description (the landed repo_settings store). `null` =
 * upstream's group-gate answer the route must 404-shell:
 * `repo.MustBeNotEmpty` — an EMPTY repo never reaches the handler
 * (web.go:1504; the route ALSO runs `releasesReadGate`, the loader's arm
 * keeps the module honest standalone).
 */
export async function loadReleasesFeedData(
  d1: D1Database,
  repo: RepoRow,
  origin: string,
  // Wall-clock seam (render-wallclock-audit): the channel Created stamp
  // (generatedUnix → RSS pubDate / Atom updated). Default keeps every
  // caller unchanged; tests pin it for byte-stable feeds.
  now: Date = new Date(),
): Promise<ReleasesFeedEnvelopeInput | null> {
  if (repo.isEmpty) return null; // MustBeNotEmpty (web.go:1504)

  const rows = await drizzle(d1)
    .select()
    .from(releases)
    .where(and(eq(releases.repoId, repo.id), eq(releases.isDraft, false), eq(releases.isTag, false)))
    .orderBy(desc(releases.createdAt), desc(releases.id))
    .all();

  // One batched publisher lookup (the page module's enrichEntries pattern);
  // a missing (or non-positive) id renders the ghost — LoadAttributes'
  // NewGhostUser arm.
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

  const repoHref = `${origin}/${repo.ownerNamespace}/${repo.slug}`; // repo.HTMLURL() — NO escaping
  const items = rows.map((row) => {
    const publisher = publishers.get(row.publisherId);
    return releaseFeedItemFromRow(
      row,
      publisher === undefined
        ? GHOST_PUBLISHER
        : { name: publisher.username, email: publisher.email ?? "" },
      repoHref,
      origin,
      repo,
    );
  });

  // The channel fields (feed/release.go:33-46): the releases_for locale
  // title over FullName(), the `/release`-singular link quirk, the RAW
  // description (repo_settings store — no markdown render), Created = now.
  return {
    title: RELEASES_FOR.replace("%s", `${repo.ownerNamespace}/${repo.slug}`),
    link: `${repoHref}/release`,
    description: (await loadRepoSettings(d1, repo.id)).description,
    generatedUnix: Math.floor(now.getTime() / 1000),
    items,
  };
}
