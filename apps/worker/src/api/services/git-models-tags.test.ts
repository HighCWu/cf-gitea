/**
 * The tag converters' arms fold (residuals-v1.3.2 P3-11 closeout) — pure
 * unit pin over services/git-models.ts toTag/toAnnotatedTag (upstream
 * services/convert/convert.go ToTag convert.go:227 / ToAnnotatedTag
 * convert.go:994):
 *
 *   - the CANONICAL arms arity renders the served message (the annotated
 *     payload or the commit-tipped tag's commit message — services/tags.ts
 *     readTagData output) and, on AnnotatedTag, the ToCommitUser-shaped
 *     tagger (UTC RFC3339 via personDate);
 *   - the arms-less arity — what the landed services/tags.ts renderTag /
 *     renderAnnotatedTag shim calls before its owner folds the spreads into
 *     bare delegation — still renders message "" / tagger null, the
 *     byte-identical pre-fold shape the spreads override.
 *
 * No D1, no engine: the converters are pure URL/field composition.
 */

import { describe, expect, it } from "vitest";

import { personDate, toAnnotatedTag, toTag } from "./git-models";
import type { RepositoryWithOwner } from "./repository";

const PAIR = {
  repo: { ownerNamespace: "owner", slug: "repo" },
  owner: {},
} as unknown as RepositoryWithOwner;
const ORIGIN = "http://localhost:3000";
const TIP = {
  target: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  peeled: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};
const SHA = "cccccccccccccccccccccccccccccccccccccccc";

describe("tag converters' arms fold (P3-11 closeout)", () => {
  it("canonical toTag renders the served message arm (upstream t.MessageUTF8)", () => {
    const tag = toTag("v1.0.0", TIP, SHA, { message: "release notes\n" }, PAIR, ORIGIN);
    expect(tag.name).toBe("v1.0.0");
    expect(tag.message).toBe("release notes\n");
    // upstream Tag.ID = the ref target (tag object oid when annotated)
    expect(tag.id).toBe(TIP.target);
    expect(tag.commit?.sha).toBe(SHA);
    expect(tag.commit?.url).toBe(`${ORIGIN}/api/v1/repos/owner/repo/git/commits/${SHA}`);
    expect(tag.zipball_url).toBe(`${ORIGIN}/owner/repo/archive/v1.0.0.zip`);
    expect(tag.tarball_url).toBe(`${ORIGIN}/owner/repo/archive/v1.0.0.tar.gz`);
  });

  it("canonical toAnnotatedTag renders the message + the ToCommitUser-shaped tagger", () => {
    const tagger = { name: "doer", email: "doer@example.com", time: 1700000000, tz: "+0000" };
    const tag = toAnnotatedTag("v1.0.0", TIP, SHA, { message: "release notes\n", tagger }, PAIR, ORIGIN);
    expect(tag.tag).toBe("v1.0.0");
    expect(tag.message).toBe("release notes\n");
    expect(tag.sha).toBe(TIP.target);
    expect(tag.url).toBe(`${ORIGIN}/api/v1/repos/owner/repo/git/tags/${TIP.target}`);
    expect(tag.object?.sha).toBe(SHA);
    expect(tag.object?.type).toBe("commit");
    expect(tag.object?.url).toBe(`${ORIGIN}/api/v1/repos/owner/repo/git/commits/${SHA}`);
    // ToCommitUser: the UTC RFC3339 render every CommitUser here uses
    expect(tag.tagger).toEqual({ name: "doer", email: "doer@example.com", date: personDate(tagger) });
    expect(tag.tagger?.date).toBe("2023-11-14T22:13:20.000Z");
    expect(tag.verification).toBeNull();
  });

  it("a null tagger arm renders null (dropped header / lightweight)", () => {
    const tag = toAnnotatedTag("v1.0.0", TIP, SHA, { message: "m", tagger: null }, PAIR, ORIGIN);
    expect(tag.message).toBe("m");
    expect(tag.tagger).toBeNull();
  });

  it("arms-less arities keep the landed render-shim shape (message \"\" / tagger null)", () => {
    const tag = toTag("v1.0.0", TIP, SHA, PAIR, ORIGIN);
    expect(tag.message).toBe("");
    const annotated = toAnnotatedTag("v1.0.0", TIP, SHA, PAIR, ORIGIN);
    expect(annotated.message).toBe("");
    expect(annotated.tagger).toBeNull();
  });
});
