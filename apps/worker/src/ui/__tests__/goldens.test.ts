/**
 * U5 golden DOM snapshots (SPEC-0008 §5.2) + the determinism guard. The five
 * committed goldens (harness.GOLDEN_CASES) are byte-exact renders of the
 * three pages plus the 404 shell (with repo context) and the bare shell
 * (unknown owner/repo), produced through the real route path with the fixed
 * seed fixtures — same commit oids and dates on every machine.
 *
 * The goldens use the SYNTHETIC manifest (fixed pseudo-hashes), so they stay
 * stable across asset rebuilds — §5.2's hash normalization is unnecessary
 * here and intentionally absent: any byte difference is real DOM drift.
 *
 * Regeneration: workerd tests have no filesystem and no shell env vars, so
 * the env-var pattern is not available. Run instead:
 *
 *     node src/ui/__tests__/update-goldens.mjs
 *
 * which empties the goldens, drops the update sentinel, runs this file, and
 * extracts the marker-framed renders printed below back into the committed
 * files.
 */

import { describe, expect, it } from "vitest";

import {
  GOLDEN_CASES,
  GOLDEN_MARKER_END,
  GOLDEN_MARKER_START,
  renderCase,
  renderRoute,
  setupGoldenFixtures,
} from "./harness";

/** Committed golden bytes, read through Vite's `?raw` transform (byte-exact;
 *  typing in raw-modules.d.ts). */
const goldenBodies: Record<string, string> = import.meta.glob("./goldens/*.html", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Update mode = the regeneration script's sentinel file is present. The mjs
 *  removes it in a finally block; a stray copy flips this file into
 *  print-only mode (visible as non-asserting golden tests in the report). */
const updateMode =
  Object.keys(import.meta.glob("./goldens-update-mode*", { query: "?raw", import: "default", eager: true })).length > 0;

function goldenBody(file: string): string | undefined {
  return goldenBodies[`./goldens/${file}`];
}

/** First differing byte offset, with a small window of both sides for the
 *  failure message (a plain `toBe` on 10 kB strings is unreadable). */
function diffWindow(html: string, committed: string): string {
  let at = 0;
  while (at < html.length && at < committed.length && html[at] === committed[at]) at += 1;
  const window = (text: string): string => JSON.stringify(text.slice(Math.max(0, at - 48), at + 48));
  return `first difference at byte ${at} (${html.length} vs ${committed.length} bytes)\n  render:  ${window(html)}\n  golden:  ${window(committed)}`;
}

setupGoldenFixtures();

describe("golden DOM snapshots (§5.2)", () => {
  for (const golden of GOLDEN_CASES) {
    it(`renders ${golden.file} byte-identical (${golden.status})`, async () => {
      const { status, html } = await renderCase(golden);
      expect(status, golden.path).toBe(golden.status);

      const committed = goldenBody(golden.file);
      if (updateMode || committed === undefined) {
        // Regeneration path: print the marker-framed render for the update
        // script; no byte assertion (there is nothing to assert against on
        // the first run, and the sentinel says the operator asked for that).
        console.log(`${GOLDEN_MARKER_START}${golden.file}\n${html}\n${GOLDEN_MARKER_END}`);
        if (!updateMode) {
          throw new Error(
            `golden file goldens/${golden.file} is missing — regenerate with: node src/ui/__tests__/update-goldens.mjs`,
          );
        }
        return;
      }
      if (committed === "") {
        throw new Error(
          `golden file goldens/${golden.file} is empty (interrupted regeneration?) — rerun: node src/ui/__tests__/update-goldens.mjs`,
        );
      }
      if (html !== committed) {
        throw new Error(`render differs from goldens/${golden.file}: ${diffWindow(html, committed)}`);
      }
      expect(html).toBe(committed); // the assertion of record
    });
  }
});

describe("determinism (§5.2)", () => {
  it("renders the same route to identical bytes twice (no template caching, no request-state bleed)", async () => {
    const first = await renderRoute("/alice/golden");
    const second = await renderRoute("/alice/golden");
    expect(second.status).toBe(first.status);
    expect(second.html).toBe(first.html);
  });

  it("renders different fixture seeds to different bytes (guards against accidental template caching)", async () => {
    const golden = await renderRoute("/alice/golden");
    const alt = await renderRoute("/alice/golden-alt");
    expect(alt.status).toBe(200);
    expect(alt.html.length).toBeGreaterThan(0);
    expect(alt.html).not.toBe(golden.html);
  });
});
