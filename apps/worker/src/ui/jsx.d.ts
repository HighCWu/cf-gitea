/**
 * Custom/web elements the shell renders that hono/jsx does not type
 * intrinsically (SPEC-0008 §2.4.1):
 *  - `overflow-menu` — upstream's tab-strip wrapper
 *    (templates/repo/header.tmpl) whose overflow behavior comes from the
 *    official bundle;
 *  - `relative-time` — the bundle's date web component (loaded by
 *    `web_src/js/index.ts`, nothing extra to serve). The attributes mirror
 *    upstream `DateUtils.TimeSince`/`DateTimeFormat` output
 *    (modules/templates/util_date.go:100-131) plus the tooltip handoff the
 *    templates emit.
 */

import type { Child } from "hono/jsx";

declare module "hono/jsx" {
  namespace JSX {
    interface IntrinsicElements {
      "overflow-menu": { class?: string; children?: Child };
      "relative-time": {
        /** ISO 8601 timestamp (upstream renders `datetime` the same way). */
        datetime?: string;
        /** relative-time-element props the upstream templates emit. */
        prefix?: string;
        tense?: "past" | "future";
        format?: string;
        threshold?: string;
        weekday?: string;
        year?: string;
        month?: string;
        day?: string;
        hour?: string;
        minute?: string;
        second?: string;
        /** Upstream switches title→tippy tooltips via these data attributes. */
        "data-tooltip-content"?: string;
        "data-tooltip-interactive"?: string;
        class?: string;
        children?: Child;
      };
    }
  }
}

