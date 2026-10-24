/**
 * Ambient module declarations for Vite's `?raw` suffix and `import.meta.glob`
 * (used to read the committed golden files byte-exactly into the workerd
 * tests — the transform runs on the Node side, so the strings arrive
 * verbatim). The repo does not reference vite/client types; these cover only
 * the two forms the U5 tests use.
 */

declare module "*?raw" {
  const content: string;
  export default content;
}

/** Only the `{ query: "?raw", import: "default", eager: true }` form is used
 *  (with raw queries the values are the file contents). */
interface ImportMeta {
  glob(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
}
