import { defineConfig } from "drizzle-kit";

// D1 is SQLite-compatible: drizzle-kit emits standard SQLite migrations, and
// wrangler applies them via `pnpm db:migrate:local|remote` (migrations_dir is
// declared in wrangler.jsonc). No `driver` needed — drizzle-kit's d1 driver
// option is only for the remote d1-http introspection flow.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
});
