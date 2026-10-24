/**
 * Auth failure limiting — SPEC-0002 §2.7.
 *
 * Per-IP failure counter in D1 (`auth_failures`, SPEC-0002 §3): ≥20 failures
 * in a 5-minute window ⇒ blocked. The threshold is deterministically
 * jittered +0–20% per IP (hash-derived) so the exact cutoff is not trivially
 * detectable while staying reproducible. Success clears the counter.
 *
 * Kept behind the `RateLimitHook` interface so the backend can move to a
 * DO/KV implementation without touching callers (orchestrator decision for
 * the current wave: D1, no dedicated DO class — failures are the rare path).
 */

import { eq, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";

import { authFailures } from "../db/schema";

export interface RateLimitVerdict {
  blocked: boolean;
  /** Seconds the client should wait; meaningful when blocked. */
  retryAfterSeconds: number;
}

export interface RateLimitHook {
  check(ip: string, now: Date): Promise<RateLimitVerdict>;
  recordFailure(ip: string, now: Date): Promise<void>;
  /** Clear the counter on successful authentication. */
  reset(ip: string): Promise<void>;
}

export interface FailureLimiterConfig {
  /** Window length in seconds (default: 5 min). */
  windowSeconds: number;
  /** Base failure threshold before jitter (default: 20). */
  baseLimit: number;
}

const DEFAULT_CONFIG: FailureLimiterConfig = { windowSeconds: 5 * 60, baseLimit: 20 };

export class D1FailureLimiter implements RateLimitHook {
  private readonly db: DrizzleD1Database;
  private readonly config: FailureLimiterConfig;

  constructor(d1: D1Database, config?: Partial<FailureLimiterConfig>) {
    this.db = drizzle(d1);
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async check(ip: string, now: Date): Promise<RateLimitVerdict> {
    const row = await this.db.select().from(authFailures).where(eq(authFailures.ip, ip)).get();
    if (row === undefined) return { blocked: false, retryAfterSeconds: 0 };

    const nowSec = toEpochSeconds(now);
    const startSec = toEpochSeconds(row.windowStart);
    if (nowSec - startSec >= this.config.windowSeconds) {
      return { blocked: false, retryAfterSeconds: 0 }; // stale window; rotated lazily
    }
    const limit = this.limitFor(ip);
    if (row.count >= limit) {
      const retryAfterSeconds = Math.max(1, startSec + this.config.windowSeconds - nowSec);
      return { blocked: true, retryAfterSeconds };
    }
    return { blocked: false, retryAfterSeconds: 0 };
  }

  async recordFailure(ip: string, now: Date): Promise<void> {
    const nowSec = toEpochSeconds(now);
    const cutoffSec = nowSec - this.config.windowSeconds;
    // Single upsert: a fresh (unexpired) window increments in place, an
    // expired or missing window starts a new one. Concurrent failures are
    // serialized by D1's write path; count increments in SQL so no
    // read-modify-write race exists.
    await this.db
      .insert(authFailures)
      .values({ ip, windowStart: now, count: 1 })
      .onConflictDoUpdate({
        target: authFailures.ip,
        set: {
          windowStart: sql`case when ${authFailures.windowStart} > ${cutoffSec} then ${authFailures.windowStart} else excluded."window_start" end`,
          count: sql`case when ${authFailures.windowStart} > ${cutoffSec} then ${authFailures.count} + 1 else 1 end`,
        },
      })
      .run();
  }

  async reset(ip: string): Promise<void> {
    await this.db.delete(authFailures).where(eq(authFailures.ip, ip)).run();
  }

  /** Threshold for an IP: base + deterministic 0–20% jitter. */
  private limitFor(ip: string): number {
    const jitter = fnv1a32(ip) % (Math.ceil(this.config.baseLimit * 0.2) + 1);
    return this.config.baseLimit + jitter;
  }
}

/** FNV-1a 32-bit — deterministic jitter source, no state. */
export function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function toEpochSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}
