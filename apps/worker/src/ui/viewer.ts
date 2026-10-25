/**
 * Page-viewer seam (SPEC-0008 §2.5 extended by SPEC-0010 §2.5): every page
 * component takes its viewer from here so pages branch on `kind`, the
 * navbar renders the signed-in chrome, and nothing else changes.
 *
 * SPEC-0010: `resolveViewer` reads the `gitea_session` cookie and runs the
 * §2.4 verification (upstream CheckAuthToken port — see ./session). A
 * request without the cookie is anonymous with ZERO D1 session reads, so
 * the anonymous wedge's cost profile and golden snapshots are unchanged.
 * The viewer carries the session principal only; sessions never authorize
 * `/api/v1` or git-HTTP (SPEC-0010 §2.9 — resolveAuth and the gate read
 * only Authorization headers).
 */

import { clearSessionSetCookie, sessionCookieValue, verifySession } from "./session";

/** The principal viewing a page. The `{ kind: "user" }` arm is the
 *  SPEC-0010 §2.5 extension; additive for every page component. */
export type Viewer =
  | { readonly kind: "anonymous" }
  | {
      readonly kind: "user";
      readonly id: number;
      readonly username: string;
      readonly isAdmin: boolean;
    };

/** The viewer plus the session cookie directive the RESPONSE must carry
 *  (§2.4: rotation Set-Cookie on a live page request, dead-cookie clears).
 *  Handlers attach `set-cookie` when non-null; `null` means send nothing. */
export interface ViewerResolution {
  readonly viewer: Viewer;
  readonly setCookie: string | null;
}

export interface ResolveViewerOptions {
  /** Background work sink (`ctx.waitUntil`) for the verification's
   *  side-effects — the expired-row lazy GC and the throttled
   *  `last_seen_at` touch (§2.4, §3). Omitted (e.g. `router.fetch`-style
   *  test invocations without an execution context), the work is settled
   *  inline before returning — never dropped. */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Resolve the viewer for the current request: cookie → §2.4 → viewer.
 * Malformed/absent cookie, missing/expired row, reuse detection, and a
 * non-active or non-individual doer all resolve ANONYMOUS (the caller
 * clears the cookie per the returned directive); a transient D1 failure
 * throws — the page handler fails 500 plain text, never silently anonymous
 * (§4.8, the gate's never-fail-open rule).
 */
export async function resolveViewer(
  env: Env,
  req: Request,
  options?: ResolveViewerOptions,
): Promise<ViewerResolution> {
  const value = sessionCookieValue(req);
  if (value === null) return { viewer: { kind: "anonymous" }, setCookie: null };

  const verification = await verifySession(env.DB, value);
  const settle = (promise: Promise<unknown>): void => {
    if (options?.waitUntil === undefined) void promise.catch(() => {});
    else options.waitUntil(promise);
  };
  for (const work of verification.background) settle(work);

  if (verification.outcome !== "authenticated") {
    return {
      viewer: { kind: "anonymous" },
      setCookie: verification.clearCookie ? clearSessionSetCookie() : null,
    };
  }
  const { id, username, isAdmin } = verification.user;
  return {
    viewer: { kind: "user", id, username, isAdmin },
    setCookie: verification.setCookie,
  };
}
