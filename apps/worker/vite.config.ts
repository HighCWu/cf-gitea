import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// The Cloudflare Vite plugin reads wrangler.jsonc for the Worker entry point
// and bindings — wrangler.jsonc stays the single source of truth (AGENTS.md).
// Dev runs in workerd via `pnpm dev` (vite dev); `pnpm build` outputs to dist/.
export default defineConfig({
  plugins: [cloudflare()],
});
