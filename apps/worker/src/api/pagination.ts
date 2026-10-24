import type { Context } from "hono";

import type { ApiEnv } from "./env";

/**
 * Upstream runtime pagination settings (gitea/modules/setting/api.go).
 * Published by `GET /settings/api` (tier 3) — the values must keep matching.
 */
export const DEFAULT_PAGING_NUM = 30;
export const MAX_RESPONSE_ITEMS = 50;

/** Effective list options after upstream's silent clamping (never a 422). */
export interface ListOptions {
  page: number;
  limit: number;
}

/**
 * Integer query param parsed the way upstream's `ctx.FormInt` behaves
 * (strconv.Atoi): absent or non-integer values count as 0.
 */
function intParam(url: URL, key: string): number {
  const raw = url.searchParams.get(key);
  if (raw === null || !/^-?\d+$/.test(raw)) {
    return 0;
  }
  return Number.parseInt(raw, 10);
}

/**
 * Parse `?page`/`?limit` with upstream clamping semantics
 * (gitea/services/convert/utils.go ToCorrectPageSize): `page <= 0` → 1,
 * `limit <= 0` → DEFAULT_PAGING_NUM (30), `limit > MAX_RESPONSE_ITEMS` →
 * capped at 50. Lists that use `per_page` instead of `limit` (git/trees)
 * parse their own params.
 */
export function parseListOptions(url: URL): ListOptions {
  const rawPage = intParam(url, "page");
  const rawLimit = intParam(url, "limit");
  return {
    page: rawPage <= 0 ? 1 : rawPage,
    limit: rawLimit <= 0 ? DEFAULT_PAGING_NUM : Math.min(rawLimit, MAX_RESPONSE_ITEMS),
  };
}

function linkFor(c: Context<ApiEnv>, page: number): string {
  const target = new URL(c.req.url);
  target.searchParams.set("page", String(page));
  return target.toString();
}

/**
 * Set the runtime list headers upstream sends on every paginated list and
 * clients depend on (SPEC-0004 §2.5): `X-Total-Count` always, and `Link` with
 * only the relations that exist, in upstream's order
 * (gitea/services/context/api.go SetLinkHeader + genAPILinks:
 * next, last, first, prev). Relation URLs preserve all other query params and
 * only rewrite `page`.
 */
export function setPaginationHeaders(c: Context<ApiEnv>, total: number, opts: ListOptions): void {
  c.header("X-Total-Count", String(total));

  const totalPages = total > 0 && opts.limit > 0 ? Math.ceil(total / opts.limit) : 0;
  const links: string[] = [];
  if (opts.page < totalPages) {
    links.push(`<${linkFor(c, opts.page + 1)}>; rel="next"`);
    links.push(`<${linkFor(c, totalPages)}>; rel="last"`);
  }
  if (opts.page > 1) {
    links.push(`<${linkFor(c, 1)}>; rel="first"`);
    links.push(`<${linkFor(c, opts.page - 1)}>; rel="prev"`);
  }
  if (links.length > 0) {
    c.header("Link", links.join(","));
  }
}
