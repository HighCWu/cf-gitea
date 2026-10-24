/**
 * Test-only environment augmentation: the vitest plugin injects the D1
 * migrations (read on the Node side via `readD1Migrations`) as a plain
 * binding so `applyD1Migrations` can run inside workerd. Never present in
 * production — wrangler.jsonc is untouched.
 */

import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
