import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { runRegistryMigrations } from "./git/migrations";

export type RepoInfo = {
  name: string;
  desc: string;
  owner: string;
  section: string;
  priv: number; // 1 = requires auth for all access, hidden from index
  /** unix millis of the newest commit; the index sort key */
  idle: number;
  /** bumped on every push/config change; used as the page-cache version */
  ver: number;
};

export type RepoConfig = {
  desc?: string;
  owner?: string;
  section?: string;
  priv?: boolean;
};

/** Site-wide list of repositories (one instance, name "registry"). */
export class Registry extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // SPEC-0011 §8 (M3.0): the same forward-only journal mechanism as
    // RepoCell, on this DO's separate SQLite database with its own step list
    // (REGISTRY_MIGRATIONS). The 0001 baseline is the constructor's old
    // inline DDL verbatim — CREATE + the try-ALTER column adds — so every
    // existing registry database (any column vintage) adopts the journal
    // untouched; future registry schema steps append to the list.
    runRegistryMigrations(ctx.storage.sql, { tx: (fn) => ctx.storage.transactionSync(fn) });
  }

  upsert(name: string, idle: number): void {
    // seed ver from the clock so a deleted-and-recreated repo never reuses
    // cache-key versions from its previous incarnation
    this.ctx.storage.sql.exec(
      "INSERT INTO repos (name, idle, ver) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET idle = excluded.idle, ver = ver + 1",
      name,
      idle,
      Date.now()
    );
  }

  setConfig(name: string, cfg: RepoConfig, idle?: number): void {
    const cur = this.get(name);
    if (!cur) return;
    this.ctx.storage.sql.exec(
      "UPDATE repos SET desc = ?, owner = ?, section = ?, priv = ?, idle = ?, ver = ver + 1 WHERE name = ?",
      cfg.desc ?? cur.desc,
      cfg.owner ?? cur.owner,
      cfg.section ?? cur.section,
      cfg.priv === undefined ? cur.priv : cfg.priv ? 1 : 0,
      idle ?? cur.idle,
      name
    );
  }

  remove(name: string): void {
    this.ctx.storage.sql.exec("DELETE FROM repos WHERE name = ?", name);
  }

  get(name: string): RepoInfo | null {
    const rows = this.ctx.storage.sql
      .exec<RepoInfo>("SELECT name, desc, owner, section, priv, idle, ver FROM repos WHERE name = ?", name)
      .toArray();
    return rows[0] ?? null;
  }

  /** Public index page feed: excludes private repos, bounded so a large table
   * can't dump wholesale over RPC. `ns` filters to one namespace ("ns/..."),
   * as a range scan: '0' is the code point after '/'. */
  list(limit = 1000, ns?: string): RepoInfo[] {
    if (ns) {
      return this.ctx.storage.sql
        .exec<RepoInfo>(
          "SELECT name, desc, owner, section, priv, idle, ver FROM repos WHERE priv = 0 AND name >= ? AND name < ? ORDER BY idle DESC LIMIT ?",
          `${ns}/`,
          `${ns}0`,
          limit
        )
        .toArray();
    }
    return this.ctx.storage.sql
      .exec<RepoInfo>(
        "SELECT name, desc, owner, section, priv, idle, ver FROM repos WHERE priv = 0 ORDER BY idle DESC LIMIT ?",
        limit
      )
      .toArray();
  }
}
