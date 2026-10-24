/**
 * Custom/web elements the shell renders that hono/jsx does not type
 * intrinsically (SPEC-0008 §2.4.1):
 *  - `overflow-menu` — upstream's tab-strip wrapper
 *    (templates/repo/header.tmpl) whose overflow behavior comes from the
 *    official bundle;
 *  - `relative-time` — the bundle's date web component (loaded by
 *    `web_src/js/index.ts`, nothing extra to serve).
 */

import type { Child } from "hono/jsx";

declare module "hono/jsx" {
  namespace JSX {
    interface IntrinsicElements {
      "overflow-menu": { class?: string; children?: Child };
      "relative-time": {
        /** ISO 8601 timestamp (upstream renders `datetime` the same way). */
        datetime?: string;
        class?: string;
        children?: Child;
      };
    }
  }
}
