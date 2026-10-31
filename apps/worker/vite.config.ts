import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// The Cloudflare Vite plugin reads wrangler.jsonc for the Worker entry point
// and bindings — wrangler.jsonc stays the single source of truth (AGENTS.md).
// Dev runs in workerd via `pnpm dev` (vite dev); `pnpm build` outputs to dist/.
export default defineConfig({
  plugins: [cloudflare()],
  build: {
    rollupOptions: {
      output: {
        // drizzle-orm stays ONE chunk: vite's default code-splitting once
        // spread its internal module graph across startup chunks and the
        // deployed worker died at boot ("Class extends value undefined" in
        // drizzle-orm/sqlite-core — chunk init order; the 28a40b5 six-module
        // import volume crossed the splitting threshold, deployed-bisected).
        // Pinning the package to a single chunk sidesteps the ordering
        // entirely; nothing else changes.
        manualChunks: (id: string) => (id.includes("drizzle-orm") ? "drizzle-orm" : undefined),
      },
    },
  },
});
