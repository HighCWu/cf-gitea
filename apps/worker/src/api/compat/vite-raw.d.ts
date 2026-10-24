/**
 * Ambient type for Vite's `?raw` imports (vite/client equivalent — the
 * worker tsconfig intentionally does not include all of vite/client). Used
 * by src/api/compat to import the SPEC-0004 markdown and the committed
 * fixture JSON as build-time strings; resolved by the same vite pipeline
 * vitest and gen-fixtures.runner.mjs use.
 */
declare module "*?raw" {
  const content: string;
  export default content;
}
