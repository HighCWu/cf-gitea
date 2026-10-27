/**
 * activity-author-data smoke — PORT-FIRST gates: ONE happy-path smoke
 * (real seeded multi-commit multi-author multi-branch repo → the feed's
 * aggregation shape + the date-range filter), no error-arm matrix (the
 * polish wave owns it — the module doc's arms carry their cites).
 *
 *   1. weekly (the bare route's default): alice's commit (main, 1h ago)
 *      and bob's commit (reachable from BOTH main and topic, 2h ago)
 *      count once each — the all-branches scan + per-oid dedup; alice's
 *      30-day-old commit is OUTSIDE the window; the mapped user entry
 *      carries the account display name + login + home_link + the
 *      avatar-chain link, the unmapped author stays a ghost entry
 *      (empty login/home_link, the default-avatar link); commits-DESC
 *      order and the exact five-field marshal order.
 *   2. daily: the date-range filter — only alice's 1h-old commit remains.
 *   3. parseActivityPeriod: null and an unknown segment fall to weekly
 *      (upstream's default arm), yearly rides Go AddDate month math.
 *   4. activityAuthorDataResponse: the ctx.JSON content-type +
 *      zero-option prod Cache-Control pair, body round-trip.
 *
 * Harness posture: the module functions driven DIRECTLY (the search-aux
 * smoke convention — the route arm is index-owned; the module doc's
 * HANDOFF section carries the mount recipe), against the real workerd
 * bindings (D1 + the REPO cell + REPO_PACKS for the avatar chain).
 */

import { env } from "cloudflare:test";
import { SELF } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { applyAuthD1Migrations } from "../../auth/testing/apply-d1-migrations";
import { basicTokenHeader, mintFor } from "../../auth/testing/seeds";
import { users } from "../../db/schema";
import { buildHistoryPack, buildReceivePackBody, ensureSeededRepo, type SeedCommit } from "../testing/seed-repo";
import {
  activityAuthorDataResponse,
  loadActivityAuthorData,
  parseActivityPeriod,
  type ActivityAuthorData,
} from "./activity-author-data";

// wave-129 full-run contention budget: this file's beforeAll seeding (the
// receive-flow multi-commit multi-author fixture repo) measured a 4.04s hook
// share of the 30s default IN a green 8-worker full run (the suite's
// 260-isolate spawn storm spikes closures up to ~12x their solo time).
// File-local 90s budgets; vitest.config.ts keeps 30s for every other file.
// Membership: the measured >=4s in-run closure/hook set (full-suite junit
// run, 2026-10-27).
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// --- fixtures -----------------------------------------------------------------

const T_NOW = 1_800_000_000_000; // the loader's controlled now (options.now)
const DAY_MS = 24 * 3_600_000;
const ORIGIN = "https://smoke.test";

const AA_DATA_COMMITS: SeedCommit[] = [
  {
    // OUTSIDE the weekly window — the date-range filter's excluded arm.
    message: "aadata smoke: old root commit",
    time: (T_NOW - 30 * DAY_MS) / 1000,
    files: [{ path: "README.md", content: "aadata root\n" }],
    author: { name: "Alice Liddell", email: "alice@example.com" },
  },
  {
    // In-window for WEEKLY, outside DAILY (48h > 24h), reachable from main
    // AND topic (the dedup arm).
    message: "aadata smoke: shared commit",
    time: (T_NOW - 2 * DAY_MS) / 1000,
    files: [{ path: "README.md", content: "aadata root\nshared\n" }],
    author: { name: "Bob Rove", email: "bob@nowhere.example" },
  },
  {
    // In-window, main's tip — the mapped-author arm.
    message: "aadata smoke: tip commit",
    time: (T_NOW - 1 * 3_600_000) / 1000,
    files: [{ path: "README.md", content: "aadata root\nshared\ntip\n" }],
    author: { name: "Alice Liddell", email: "alice@example.com" },
  },
];

/** Idempotent seed: alice (email + the two full-name columns set), the
 *  pushed public `alice/aadata-smoke` (main at the tip commit), and the
 *  second branch `topic` at the SHARED commit (an existing oid re-pushed
 *  as a new ref through the landed receive flow — the all-branches arm). */
async function ensureSmokeFixture(): Promise<void> {
  await applyAuthD1Migrations();
  const seeded = await ensureSeededRepo({ owner: "alice", slug: "aadata-smoke", commits: AA_DATA_COMMITS });
  const shared = seeded.tips[1];
  if (shared === undefined) throw new Error("seed produced too few tips");

  // The account arms: email (the commit-author email maps here) and the
  // full-name columns (displayName wins the DisplayName() priority).
  const db = drizzle(env.DB);
  await db
    .update(users)
    .set({ email: "alice@example.com", displayName: "Alice D", fullName: "Alice Doe" })
    .where(eq(users.usernameLower, "alice"))
    .run();

  const refs = await env.REPO.getByName("alice/aadata-smoke").listRefs();
  if (!refs.refs.some((ref) => ref.name === "refs/heads/topic")) {
    const alice = await db.select({ id: users.id }).from(users).where(eq(users.usernameLower, "alice")).get();
    if (alice === undefined) throw new Error("seed owner row missing");
    await env.DB.prepare("DELETE FROM personal_access_tokens WHERE user_id = ? AND name = ?")
      .bind(alice.id, "aadata-smoke-topic")
      .run();
    const token = (await mintFor(alice.id, "aadata-smoke-topic", "write:repository")).plaintext;
    const { pack } = await buildHistoryPack(AA_DATA_COMMITS); // deterministic → same oids
    const response = await SELF.fetch("https://test.local/alice/aadata-smoke.git/git-receive-pack", {
      method: "POST",
      headers: { authorization: basicTokenHeader(token), "content-type": "application/x-git-receive-pack-request" },
      body: buildReceivePackBody([{ ref: "refs/heads/topic", oid: shared }], pack),
    });
    const responseBody = response.status === 200 ? new TextDecoder().decode(await response.arrayBuffer()) : "";
    if (response.status !== 200 || responseBody.includes("ng ")) {
      throw new Error(`topic push failed: ${response.status} ${responseBody.slice(0, 400)}`);
    }
  }
}

// --- the smoke ----------------------------------------------------------------

let weekly: ActivityAuthorData[];

beforeAll(async () => {
  await ensureSmokeFixture();
  const data = await loadActivityAuthorData(
    env,
    { ownerNamespace: "alice", slug: "aadata-smoke", isEmpty: false },
    null, // the bare route — the weekly default
    { origin: ORIGIN, now: new Date(T_NOW) },
  );
  if (data === null) throw new Error("feed loader answered the 404 family on the happy path");
  weekly = data;
});

describe("activity-author-data smoke", () => {
  it("aggregates all branches within the window, mapped users and ghosts, top shape", () => {
    // Bob's commit is reachable from main AND topic → counted once (the
    // --branches=* walk's per-oid dedup); alice's 30-day-old root commit is
    // filtered by the window. One commit each → the name-asc tiebreak.
    expect(weekly).toHaveLength(2);

    const [alice, bob] = weekly as [ActivityAuthorData, ActivityAuthorData];
    // Mapped: name from the ACCOUNT (DisplayName() — the displayName column
    // wins), login/home_link from the row, avatar from the landed chain
    // (the auto-generated identicon's content-hash storage link).
    expect(alice.name).toBe("Alice D");
    expect(alice.login).toBe("alice");
    expect(alice.home_link).toBe("/alice");
    expect(alice.avatar_link).toMatch(/^https:\/\/smoke\.test\/avatars\/[0-9a-f]{64}$/);
    expect(alice.commits).toBe(1);
    // Unmapped: the per-email ghost entry — git's author name, empty
    // login/home_link, the default-avatar link (ghost id −1 arm).
    expect(bob).toEqual({
      name: "Bob Rove",
      login: "",
      avatar_link: `${ORIGIN}/assets/img/avatar_default.png`,
      home_link: "",
      commits: 1,
    });
    // The marshal order is the Go struct's field order.
    expect(Object.keys(alice)).toEqual(["name", "login", "avatar_link", "home_link", "commits"]);
  });

  it("filters by the daily window (the {period} date-range arm)", async () => {
    const daily = await loadActivityAuthorData(
      env,
      { ownerNamespace: "alice", slug: "aadata-smoke", isEmpty: false },
      "daily",
      { origin: ORIGIN, now: new Date(T_NOW) },
    );
    expect(daily).toEqual([
      {
        name: "Alice D",
        login: "alice",
        avatar_link: weekly[0]?.avatar_link,
        home_link: "/alice",
        commits: 1,
      },
    ]);
  });

  it("defaults unknown and bare periods to weekly; yearly rides Go month math", () => {
    const now = new Date(Date.UTC(2026, 2, 31, 12, 0, 0)); // Mar 31
    expect(parseActivityPeriod(null, now)).toEqual({
      period: "weekly",
      from: new Date(now.getTime() - 168 * 3_600_000),
    });
    expect(parseActivityPeriod("fortnightly", now).period).toBe("weekly");
    expect(parseActivityPeriod("yearly", now).from).toEqual(new Date(Date.UTC(2025, 2, 31, 12, 0, 0)));
  });

  it("answers the ctx.JSON content-type + zero-option prod Cache-Control pair", () => {
    const response = activityAuthorDataResponse(weekly);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json;charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("max-age=0, private, must-revalidate");
    return expect(response.json()).resolves.toEqual(weekly);
  });
});
