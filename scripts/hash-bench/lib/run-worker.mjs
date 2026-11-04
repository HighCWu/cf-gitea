/* global performance, console, process, AbortSignal -- Web globals provided by Node >= 22 */
/**
 * run-worker.mjs — Node-side runner: boots the pinned miniflare with
 * lib/worker-bench.mjs and dispatches bench ops into the workerd isolate.
 *
 * Two isolate profiles exist on purpose, mirroring the product's real
 * postures (apps/worker/wrangler.jsonc):
 *   - flags-free (the product's current shape: compatibility_date
 *     2026-10-23, NO compatibility_flags) — pbkdf2 / bcrypt / argon2 arms;
 *   - nodejs_compat — the scrypt arm only (node:crypto needs the flag;
 *     Phase C would have to ADD it to wrangler.jsonc to verify scrypt rows).
 * limits.cpuMs is honored from wrangler.jsonc (300000) where relevant; the
 * cpu-limit probe deliberately sets tiny cpuMs values to read CPU time out
 * of workerd's OWN accounting instead of trusting wall≈CPU blindly.
 *
 * Zero npm deps (miniflare is imported in place from the repo's .pnpm
 * store — see lib/miniflare-resolve.mjs). Node >= 22.
 */
import { resolveMiniflare, repoRoot } from "./miniflare-resolve.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const libDir = path.dirname(fileURLToPath(import.meta.url));
const workerRelPath = "lib/worker-bench.mjs";
const vendorRelPath = "vendor/hash-wasm/index.esm.js.vendored";
const benchRoot = path.resolve(libDir, "..");

/** Compatibility date of the product under test (wrangler.jsonc). */
export const COMPAT_DATE = "2026-10-23";
/** Production CPU cap the product ships with (wrangler.jsonc limits.cpu_ms). */
export const PRODUCT_CPU_MS = 300000;
/** Workers default isolate memory ceiling (standard plan; the value every
 *  memory-fit verdict in the report is judged against). */
export const MEMORY_CEILING_MIB = 128;

/**
 * Boot a bench worker isolate.
 * @param {object} opts
 * @param {boolean} opts.nodejsCompat  add ["nodejs_compat"] (scrypt arm)
 * @param {number|null} opts.cpuMs     limits.cpuMs for the isolate (probe tool)
 * @returns {Promise<{dispatch: (op: string, params?: object, opts?: object) => Promise<object>, cpuProbe: (op: string, params: object, cpuMs: number) => Promise<{within: boolean, error?: string, wallMs?: number}>, info: () => Promise<object>, close: () => Promise<void>, miniflareVersion: string}>}
 */
export async function createBenchWorker({ nodejsCompat = false, cpuMs = null } = {}) {
  const { Miniflare, Log, convertV4MiniflareOptions } = await importMiniflare();
  // Miniflare 5's programmatic surface: the flat per-worker options shape
  // (wrangler's shape) goes through the exported convertV4MiniflareOptions
  // before `new Miniflare()` (the raw constructor validates a different,
  // internal legacy shape). The vendor module is declared alongside the
  // worker; miniflare takes the FIRST listed module as the entry, and
  // workerd resolves the relative import against module names.
  const v4Options = {
    workers: [
      {
        name: "hash-bench",
        // Same date the product runs (wrangler.jsonc compatibility_date).
        compatibilityDate: COMPAT_DATE,
        compatibilityFlags: nodejsCompat ? ["nodejs_compat"] : [],
        modules: [
          // Paths must be ABSOLUTE: miniflare resolves non-absolute module
          // paths against its rootPath (the process cwd), not modulesRoot.
          { type: "ESModule", path: path.join(benchRoot, workerRelPath) }, // entry (first = main)
          { type: "ESModule", path: path.join(benchRoot, vendorRelPath) }, // hash-wasm js bundle
          // The wasm binaries as STATIC modules (workerd blocks dynamic
          // compilation; see worker-bench.mjs header). blake2b is needed by
          // hash-wasm's argon2id (H0 computation).
          { type: "CompiledWasm", path: path.join(benchRoot, "vendor/hash-wasm/argon2.wasm") },
          { type: "CompiledWasm", path: path.join(benchRoot, "vendor/hash-wasm/bcrypt.wasm") },
          { type: "CompiledWasm", path: path.join(benchRoot, "vendor/hash-wasm/blake2b.wasm") },
        ],
        modulesRoot: benchRoot,
        ...(cpuMs !== null ? { limits: { cpuMs } } : {}),
      },
    ],
  };
  const mf = new Miniflare({
    ...convertV4MiniflareOptions(v4Options),
    // Quiet the request logs; the CLIs do their own reporting. Flip
    // HASH_BENCH_VERBOSE=1 for workerd request/error logging.
    log: new Log(process.env.HASH_BENCH_VERBOSE ? 4 : 2),
  });

  /** Dispatch one bench op. Retried once if workerd's OOM shutdown races
   *  the request (memory-limit kills surface as transport errors on the
   *  first post-kill request sometimes). Returns the worker's JSON reply. */
  const dispatch = async (op, params = {}, { timeoutMs = 120000, retries = 1 } = {}) => {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await mf.dispatchFetch("http://hash-bench.invalid/bench", {
          method: "POST",
          body: JSON.stringify({ op, params, count: params.count ?? 1, warmup: params.warmup ?? 0 }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const json = await res.json();
        return json;
      } catch (e) {
        lastErr = e;
      }
    }
    // Transport-level failure (isolate died mid-request): surface it in the
    // same {ok,error} shape the worker uses for in-isolate failures.
    return { ok: false, op, error: `transport: ${lastErr?.message ?? String(lastErr)}` };
  };

  /**
   * CPU-time probe against workerd's OWN accounting: boots a SEPARATE
   * isolate with limits.cpuMs = cpuMs and dispatches exactly one op.
   * Workerd throws "exceeded its CPU limit" / "Worker exceeded CPU time
   * limit." when the op needs more CPU than granted — a positive reading
   * of CPU CONSUMPTION (runtime-accounted, not wall-clock). Returns
   * {within, error, wallMs}.
   */
  const cpuProbe = async (op, params, cpuMsLimit) => {
    const probe = await createBenchWorker({ nodejsCompat, cpuMs: cpuMsLimit });
    try {
      const t0 = performance.now();
      const res = await probe.dispatch(op, params, { retries: 0 });
      const wallMs = performance.now() - t0;
      if (res.ok) return { within: true, wallMs };
      return { within: false, error: res.error, wallMs };
    } finally {
      await probe.close();
    }
  };

  const info = async () => (await dispatch("info")).meta;

  const close = async () => mf.dispose();

  const miniflareVersion = cachedMiniflare?.version ?? "unknown";
  return { dispatch, cpuProbe, info, close, miniflareVersion };
}

let cachedMiniflare = null;
async function importMiniflare() {
  if (!cachedMiniflare) {
    const resolved = await resolveMiniflare();
    const mod = await import(resolved.entryUrl);
    cachedMiniflare = {
      Miniflare: mod.Miniflare ?? mod.default?.Miniflare,
      Log: mod.Log ?? mod.default?.Log,
      convertV4MiniflareOptions: mod.convertV4MiniflareOptions,
      version: resolved.version,
    };
  }
  return cachedMiniflare;
}

/** Shared CLI epilogue: the harness never writes repo files — results go to
 *  .bench-results/ (gitignored) or stdout only. */
export function resultsDir() {
  return path.join(repoRoot, ".bench-results");
}

/** Run a list of async steps, printing the deploy-probes-style headers. */
export async function section(title, fn) {
  console.log(`\n[${title}]`);
  return fn();
}
