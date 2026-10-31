/**
 * The `/{owner}/{repo}/rss/branch/{name}` + `/{owner}/{repo}/atom/branch/
 * {name}` per-branch commit-feed envelopes — census gap #10(b), PORT-FIRST
 * (the tags-feed twin's shape: the module lands over the landed data, the
 * route seam rides the orchestrator's fold window — the HANDOFF is the mount
 * record below). Byte surfaces over the landed log read (never a
 * self-fetch): no JSX, the two XML documents are composed as strings with
 * the exact Go serializer semantics upstream ships — the gorilla v1.2.0
 * envelope helpers are imported VERBATIM from the landed twin
 * (`user-feed-xml.ts`, efce750) so the escape/format table keeps one copy;
 * only the commit item projection + channel fields live here. Upstream runs
 * the SAME `writeFeed` across the user, releases, tags, and BRANCH families
 * — the fourth and last repo-scoped feed at the pin.
 *
 * ## Verified upstream registrations (submodule pin fc4936884584)
 *
 * `routers/web/web.go:1746-1747` — inside the repo-code group at :1683 whose
 * closing args (:1762) are `optSignIn, context.RepoAssignment,
 * reqUnitCodeReader` (the SAME group stack the commits/raw/media/render
 * families ride):
 *
 *     m.Get("/rss/branch/*", context.RepoRefByType(git.RefTypeBranch), webAuth.AllowBasic, feedEnabled, feed.RenderBranchFeedRSS)
 *     m.Get("/atom/branch/*", context.RepoRefByType(git.RefTypeBranch), webAuth.AllowBasic, feedEnabled, feed.RenderBranchFeedAtom)
 *
 * Per-route middlewares, in order:
 * - `context.RepoRefByType(git.RefTypeBranch)` — the `*` glob remainder is
 *   the BRANCH name (slashable names kept whole; chi `*` captures the rest
 *   of the path), resolved against refs/heads/*; an unknown branch 404s IN
 *   THE MIDDLEWARE (services/context/repo.go) — the route never runs.
 * - `webAuth.AllowBasic` + `feedEnabled` — the feed-token basic-auth family
 *   and `setting.Other.EnableFeed` (pin default TRUE — modules/setting/
 *   other.go:21, every twin's note) — so NO landed EnableFeed arm. The
 *   landed §2.5 session prologue stands in for AllowBasic's token read, the
 *   twins' own posture (their route arms run resolveUiRequest alone).
 *
 * ## Upstream shape (cited — routers/web/feed/{branch,render}.go)
 *
 * `RenderBranchFeed{RSS,Atom}` (render.go:28-33) → `RenderBranchFeed(ctx,
 * format)` (:18-26): `ctx.Repo.TreePath == ""` on this URL family always —
 * `/rss/branch/*` carries no file path — so ONLY `ShowBranchFeed` (branch.go
 * :17-48) is reachable; the file-feed twin (file.go) is a dead arm here:
 *
 * - `checkRepoFeedTokenScope` (render.go:12-15) — the token-scope gate that
 *   rides AllowBasic (above).
 * - `ctx.Repo.Commit.CommitsByRange(ctx, gitRepo, 0, 10, "", "", "")`
 *   (branch.go:23) — the branch tip's FIRST page of 10 (commit.go:92 →
 *   commitsByRangeWithTime: page 0 = the newest 10, tip backwards).
 * - Channel fields (:32-37): Title = the PLAIN CONCAT `"Latest commits for
 *   branch " + ctx.Repo.BranchName` — NOT a TrString: the only feed family
 *   at the pin without a locale title (no TrString call in branch.go at
 *   all); Link = `repo.HTMLURL() + "/" + ctx.Repo.RefTypeNameSubURL()` —
 *   RefWebLinkPath (modules/git/ref.go:238-246) = `"branch/" +
 *   PathEscapeSegments(ShortName)` → `{repo href}/branch/{escaped name}`;
 *   Description = the RAW `repo.Description` (no markdown render);
 *   Created = `time.Now()`. No Author/Image/Copyright.
 * - Items (:38-47), per commit: `Id = commit.ID.String()` — the PLAIN oid,
 *   NOT the release twins' `"%v: %v"` shape; `Title =
 *   commit.MessageTitle()` (commit_message.go:53-58: TrimSpace the UTF-8
 *   message, cut at the first "\n", TrimSpace the line); `Link =
 *   repo.HTMLURL() + "/commit/" + oid` (unescaped — hex is URL-safe);
 *   `Author = {Name: commit.Author.Name, Email: commit.Author.Email}` —
 *   the COMMIT author identity, not a user row (no ghost arm, no lookup);
 *   `Description = commit.MessageUTF8()` (the FULL message —
 *   commit_message.go:42-48, charset-converted; the trailing newline git
 *   stores rides along); `Content = commit.MessageUTF8()` — the SAME value
 *   in both arms; `Created = commit.Committer.When` — the COMMITTER time
 *   (not the author's). Then the shared `writeFeed` (profile.go:91-104) —
 *   content types `application/atom+xml;charset=utf-8` /
 *   `application/rss+xml;charset=utf-8`.
 *
 * The gorilla item deltas vs the release twins (the ONLY families at the
 * pin whose items set Description): RSS keeps the full escaped
 * `<description>` AND the `content:encoded` CDATA; Atom gains the
 * `<summary type="html">` beside `<content type="html">`. IsPermaLink is
 * NEVER set here → the RSS `<guid>` carries NO isPermaLink attribute
 * (omitempty drops it — the attr exists only on the user-feed family's
 * items, convert.go:207).
 *
 * ## Data-source semantics (the documented landed reductions)
 *
 * - The log read is `listLog(branchRef(name), {ofs: 0, n: 10})` — the
 *   commits page's exact read at the feed's fixed page size (the engine
 *   boundary's listLog IS CommitsByRange's shape). `MessageUTF8` folds to
 *   `CommitJson.message` verbatim: engine text is valid UTF-8 (the
 *   user-feed header's charset note) and git stores the trailing newline,
 *   so Description/Content carry it — the RSS description renders it as
 *   `&#xA;`, the CDATA body keeps it raw. `MessageTitle` keeps upstream's
 *   exact trim chain over the message (trim → cut at "\n" → trim) rather
 *   than the engine's `subject` field: the engine's split does NOT trim,
 *   and the pin's semantics do (an edge only whitespace-padded subjects
 *   can expose — the projection keeps the pin's answer).
 * - A missing branch (or a failed refs read — the two are indistinguishable
 *   at this boundary) → `null`: the route 404-shells. That IS
 *   RepoRefByType's middleware arm — this family's URL never reaches the
 *   handler for an unknown branch, and this group (web.go:1683-1762)
 *   carries NO MustBeNotEmpty: the empty repo 404s through the SAME
 *   unknown-branch arm (no refs exist to resolve), not through a
 *   MustBeNotEmpty gate — the loader keeps the single null honest.
 * - A failed log read degrades to the empty item list (the §4.9 posture —
 *   the tags twin's "a failed ref read degrades to the empty list";
 *   upstream ServerErrors, the twins degrade).
 * - The channel description is the RAW repo_settings description (the
 *   store upstream's `repo.Description` reads through on this side — the
 *   tags twin's convention).
 * - Times format in UTC (the user-feed header's zone reduction; the
 *   committer line carries its own offset — the format helpers pin UTC,
 *   upstream renders the server zone, UTC in every default deployment).
 *
 * ## Route seam (the wiring HANDOFF — ui/index.ts is the ORCHESTRATOR's
 *    fold window; this module ships with the recipe, the tags twin's
 *    PORT-FIRST precedent, mounted at 2f7afe9 for that family)
 *
 * 1. Route type (beside the tags twin's `TagsFeedRoute`, index.ts:2237):
 *
 *      /** The per-branch commit feed tails (pages/branch-feed-xml.ts):
 *       *  upstream web.go:1746-1747's `m.Get("/{rss|atom}/branch/*", …,
 *       *  feed.RenderBranchFeed{RSS,Atom})` — the glob remainder IS the
 *       *  branch name (slashable names kept whole, chi `*`). The group's
 *       *  gate is reqUnitCodeReader (web.go:1762) — the §2.5 prologue; a
 *       *  missing branch 404s in upstream's RepoRefByType middleware, so
 *       *  the arm's only null is the loader's. *\/
 *      export interface BranchFeedRoute {
 *        family: "branch-feed-rss" | "branch-feed-atom";
 *        owner: string;
 *        repo: string;
 *        /** the decoded branch name — the `*` glob remainder *\/
 *        branch: string;
 *      }
 *
 *    and add the two families to the `ParsedUiRoute` union (index.ts:3684).
 * 2. Parse claim in `parseUiRoute`, beside the raw/media family's typed
 *    ref claims (index.ts:5695 — the same three-literal sibling shape;
 *    order irrelevant, disjoint heads):
 *
 *      // The per-branch feed tails (pages/branch-feed-xml.ts — upstream
 *      // web.go:1746-1747's static `rss`/`atom` + `branch` literals over
 *      // the `*` glob): the two literals are case-sensitively exact like
 *      // every chi literal; the remainder joins back with "/" (decoded
 *      // segments) and stays claimed even for a junk name — upstream's
 *      // middleware 404s the unknown branch, the loader's null keeps the
 *      // same answer shape.
 *      if (rest.length >= 2 && (head === "rss" || head === "atom") && rest[0] === "branch") {
 *        try {
 *          return {
 *            family: head === "rss" ? "branch-feed-rss" : "branch-feed-atom",
 *            owner,
 *            repo,
 *            branch: rest.slice(1).map((segment) => decodeURIComponent(segment)).join("/"),
 *          };
 *        } catch {
 *          return null;
 *        }
 *      }
 *
 *    (Placed BEFORE the raw/media catch-all arm only if those ever grow a
 *    `rss` head — today the heads are disjoint, order irrelevant.)
 * 3. Registration (the twins' one-constrained-registration convention,
 *    index.ts:16847-16848):
 *
 *      uiRouter.get("/:owner/:repo/rss/branch/*", (c) => branchFeedRoute(c));
 *      uiRouter.get("/:owner/:repo/atom/branch/*", (c) => branchFeedRoute(c));
 *
 *    (the `/render/branch/*` wildcard registration shape, index.ts:17346).
 * 4. Route arm (the tags twin's `tagsFeedRoute`, index.ts:13843-13861):
 *    `resolveUiRequest` (the §2.5 repo read + visibility prologue — this IS
 *    the group's RepoAssignment + reqUnitCodeReader pair) → drift-guard the
 *    family → `loadBranchFeedData(c.env, c.env.DB, repo, route.branch,
 *    url.origin, routeNow())` (null → the §4.5 404 shell — the ONLY null is
 *    the unknown/failed branch resolution, upstream's RepoRefByType
 *    middleware answer; NO MustBeNotEmpty gate exists on this group) →
 *    `renderBranchFeedRss`/`renderBranchFeedAtom` by family →
 *    `new Response(body, { headers: { "content-type":
 *    BRANCH_FEED_CONTENT_TYPES.rss/.atom } })`. No EnableFeed arm (the pin
 *    default is TRUE — the module header). No viewer parameter: the feed's
 *    projection reads no viewer state upstream.
 * 5. The branches page's per-row RSS button (list.tmpl:44-45/:173-174's
 *    EnableFeed anchor, `{RepoLink}/rss/branch/{PathEscapeSegments name}` +
 *    octicon-rss + the `rss_feed` tooltip) flips WITH this fold — the
 *    w129 batch-14 absence pin (branches.matrix.test.tsx, the feed/archive
 *    describe) exists exactly for this moment and flips deliberately to
 *    the rendered-button arms (the dead-link rule holds until the seam
 *    exists; the module alone does not end it).
 */

import type { CommitJson } from "@cf-gitea/git-engine";

import { branchRef, engineReads } from "../../api/services/engine";
import { loadRepoSettings } from "../../api/services/repo-settings";
import type { RepoRow } from "../ui-context";
import { pathEscapeSegments } from "../page-data";
import {
  USER_FEED_CONTENT_TYPES,
  cdataBody,
  escapeXmlText,
  formatRfc1123z,
  formatRfc3339,
} from "./user-feed-xml";

/** `ShowBranchFeed`'s CommitsByRange pageSize (feed/branch.go:23) — the
 *  newest ten commits of the branch, fixed (no page param exists on the
 *  route). */
export const BRANCH_FEED_PAGE_SIZE = 10;

// ---------------------------------------------------------------------------
// The commit item projection (feed/branch.go:38-47 over the log read)
// ---------------------------------------------------------------------------

/** `CommitMessage.MessageTitle` (modules/git/commit_message.go:53-58):
 *  TrimSpace the UTF-8 message, cut at the first "\n", TrimSpace the line.
 *  The engine's `subject` field skips both trims — the projection keeps the
 *  pin's semantics (the module header's data-source note). */
function commitMessageTitle(message: string): string {
  return message.trim().split("\n", 1)[0]?.trim() ?? "";
}

/** The upstream feeds.Item — exactly the fields gorilla's serializer reads
 *  (feed.go:36-50) that ShowBranchFeed sets (branch.go:38-47). Unlike the
 *  release twins, `description` IS set (the full message), so the Atom
 *  `<summary>` renders and the RSS `<description>` is not the always-empty
 *  stub; `isPermaLink` stays unset — the RSS guid drops the attribute. */
export interface BranchFeedItem {
  /** `commit.ID.String()` — the plain oid (NOT the twins' `%v: %v` shape). */
  readonly id: string;
  /** `commit.MessageTitle()` — the trimmed first line. */
  readonly title: string;
  /** `repo.HTMLURL() + "/commit/" + oid` (unescaped — hex is URL-safe). */
  readonly link: string;
  /** `commit.Author.Name` — the COMMIT author identity, no user lookup. */
  readonly authorName: string;
  /** `commit.Author.Email` ("" → no Atom `<email>`; RSS copies only the
   *  Name anyway). */
  readonly authorEmail: string;
  /** `commit.MessageUTF8()` — the FULL message (the trailing newline git
   *  stores rides along; escaped in the envelopes, raw in the CDATA). */
  readonly description: string;
  /** The SAME full message — upstream sets both arms to MessageUTF8. */
  readonly content: string;
  /** `commit.Committer.When` as unix seconds — the COMMITTER time. */
  readonly createdUnix: number;
}

/** One log-read commit → one feeds.Item, element-for-element vs
 *  branch.go:38-47. `repoHref` is `repo.HTMLURL()`'s stand-in (`AppURL +
 *  FullName()`, NO escaping — models/repo/repo.go). */
export function branchFeedItemFromCommit(commit: CommitJson, repoHref: string): BranchFeedItem {
  return {
    id: commit.oid,
    title: commitMessageTitle(commit.message),
    link: `${repoHref}/commit/${commit.oid}`,
    authorName: commit.author.name,
    authorEmail: commit.author.email,
    description: commit.message,
    content: commit.message,
    createdUnix: commit.committer.time,
  };
}

// ---------------------------------------------------------------------------
// The envelopes (gorilla/feeds v1.2.0 WriteRss / WriteAtom bytes, the
// branch channel fields + the commit-item shape)
// ---------------------------------------------------------------------------

/** `writeFeed`'s content types (profile.go:94-104) — the SAME shared
 *  helper upstream uses for every feed family. */
export const BRANCH_FEED_CONTENT_TYPES = USER_FEED_CONTENT_TYPES;

/** The channel-level render input (the Feed struct fields ShowBranchFeed
 *  sets — feed/branch.go:32-37; no Author/Image/Copyright upstream). */
export interface BranchFeedEnvelopeInput {
  /** `Latest commits for branch {name}` — the plain literal concat (the
   *  only feed family without a locale title; display text, the envelopes
   *  XML-escape it). */
  readonly title: string;
  /** `{repo href}/branch/{escaped name}` — RefWebLinkPath's shape. */
  readonly link: string;
  /** The RAW repo description (no markdown render; "" renders the empty
   *  RSS `<description>`, drops the Atom `<subtitle>`). */
  readonly description: string;
  /** `time.Now()` at handler time. */
  readonly generatedUnix: number;
  readonly items: readonly BranchFeedItem[];
}

/** `<?xml version="1.0" encoding="UTF-8"?>` — Go xml.Header minus its
 *  trailing newline (gorilla feed.go:85/94 strips it), straight into the
 *  root element. */
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

/** gorilla `WriteRss` bytes for the branch feed — element-for-element vs
 *  the verified v1.2.0 map (the user-feed twin's shape; the commit-item
 *  deltas: the guid carries NO isPermaLink attr — IsPermaLink is never set
 *  on this family). No trailing newline. */
export function renderBranchFeedRss(input: BranchFeedEnvelopeInput): string {
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
      // still emits the paired empty element (an empty-message commit
      // renders the stub; the full message normally renders escaped,
      // newlines as &#xA;).
      `      <description>${e(item.description)}</description>`,
    );
    if (item.content !== "") {
      lines.push(`      <content:encoded><![CDATA[${cdataBody(item.content)}]]></content:encoded>`);
    }
    if (item.authorName !== "") {
      // newRssItem copies ONLY the Name into <author> (rss.go :126-128).
      lines.push(`      <author>${e(item.authorName)}</author>`);
    }
    if (item.id !== "") {
      // IsPermaLink unset → the omitempty attr DROPS (this family's bare
      // guid — the user-feed family is the only one that sets it).
      lines.push(`      <guid>${e(item.id)}</guid>`);
    }
    lines.push(`      <pubDate>${formatRfc1123z(item.createdUnix)}</pubDate>`, "    </item>");
  }
  lines.push("  </channel>", "</rss>");
  return lines.join("\n");
}

/** gorilla `WriteAtom` bytes for the branch feed — element-for-element vs
 *  the verified v1.2.0 map. Unlike the release twins, the commit items set
 *  a description → the `<summary type="html">` element renders beside the
 *  content. No trailing newline. */
export function renderBranchFeedAtom(input: BranchFeedEnvelopeInput): string {
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
    // The commit items' description arm (the release twins never set one):
    // AtomSummary is built over any non-empty description — atom.go
    // newAtomEntry.
    if (item.description !== "") {
      lines.push(`    <summary type="html">${e(item.description)}</summary>`);
    }
    if (item.authorName !== "" || item.authorEmail !== "") {
      lines.push("    <author>", `      <name>${e(item.authorName)}</name>`);
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
// The loader (ShowBranchFeed's data arm over the landed sources of truth)
// ---------------------------------------------------------------------------

/**
 * `ShowBranchFeed` (feed/branch.go:17-48) over the landed reads: the
 * BRANCH resolution first — `refs/heads/{name}` must exist in the refs
 * universe (upstream RepoRefByType's middleware arm; a failed refs read is
 * indistinguishable from a missing branch here) — then the tip-backwards
 * log page (`listLog(branchRef, {ofs: 0, n: 10})`, CommitsByRange's shape
 * at the handler's fixed size), the RAW repo_settings description for the
 * channel. `null` = the unknown-branch answer the route must 404-shell:
 * the group (web.go:1683-1762) carries NO MustBeNotEmpty — an EMPTY repo
 * 404s through this same arm (no refs exist to resolve).
 */
export async function loadBranchFeedData(
  env: Env,
  d1: D1Database,
  repo: RepoRow,
  branchName: string,
  origin: string,
  // Wall-clock seam (render-wallclock-audit): the channel Created stamp
  // (generatedUnix → RSS pubDate / Atom updated). Default keeps every
  // caller unchanged; tests pin it for byte-stable feeds.
  now: Date = new Date(),
): Promise<BranchFeedEnvelopeInput | null> {
  // The branch resolution (RepoRefByType's 404 arm): one refs read answers
  // existence AND the tip the log walks from.
  const refs = await engineReads(env, repo).listRefs();
  const tip = (refs?.refs ?? []).find((ref) => ref.name === branchRef(branchName));
  if (tip === undefined) return null;

  // The newest-ten page (branch.go:23's CommitsByRange(0, 10)). A failed
  // log read degrades to the empty item list (§4.9 — the tags twin's
  // failed-ref posture; upstream ServerErrors).
  const log = await engineReads(env, repo).listLog(branchRef(branchName), { ofs: 0, n: BRANCH_FEED_PAGE_SIZE });

  const repoHref = `${origin}/${repo.ownerNamespace}/${repo.slug}`; // repo.HTMLURL() — NO escaping
  const settings = await loadRepoSettings(d1, repo.id);
  return {
    title: `Latest commits for branch ${branchName}`, // branch.go:32's plain concat
    link: `${repoHref}/branch/${pathEscapeSegments(branchName)}`, // RefTypeNameSubURL
    description: settings.description, // RAW — no markdown render
    generatedUnix: Math.floor(now.getTime() / 1000),
    items: (log?.commits ?? []).map((commit) => branchFeedItemFromCommit(commit, repoHref)),
  };
}
