/**
 * Page-viewer seam (SPEC-0008 §2.5). Slice 1 is anonymous-only: no cookie, no
 * session, no `/login` route. Every page component takes its viewer from here
 * so a future session SPEC (option (a): PAT-verified session cookie) plugs in
 * at this module and the navbar — page components stay unchanged.
 */

/** The principal viewing a page. Extending this union (e.g.
 *  `{ kind: "user"; userId: number; username: string }`) is additive: pages
 *  branch on `kind`, the navbar renders user chrome, nothing else changes. */
export type Viewer = { readonly kind: "anonymous" };

/** Resolve the viewer for the current request. Anonymous in slice 1 — there
 *  is no session surface to consult (SPEC-0008 §2.5 decision). */
export function resolveViewer(): Viewer {
  return { kind: "anonymous" };
}
