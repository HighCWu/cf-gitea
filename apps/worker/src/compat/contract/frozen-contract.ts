/**
 * The frozen Gitea API contract, `?raw`-imported and parsed exactly once.
 *
 * Test modules MUST consume the contract through this module instead of
 * importing `v1-swagger.generated.json` directly. A direct JSON import makes
 * Vite's dev-SSR transform ship ~3.4 MB (657 KB code + 2.75 MB sourcemap) for
 * the ~1 MB document as a single runner-startup module fetch; under full-suite
 * load that message trips the @cloudflare/vitest-plugin runner WebSocket
 * message cap and kills the file's workerd runner (protocol error 1009,
 * "Message is too large") — a deterministic 17-runner-death, exit-1-on-green
 * crash class (docs/research/workers-vitest-ws1009-issue.md). The `?raw` form
 * ships one plain string module with no generated sourcemap and is empirically
 * immune (the compat suite's fixtures/suite tests always ran clean on it);
 * `parseSwagger2Contract` — the same parser the compat suite and the fixture
 * generator use — restores the typed `Swagger2Spec` view the direct JSON
 * import used to provide.
 */
import { parseSwagger2Contract } from "../../api/compat/gen-fixtures";
import type { Swagger2Method, Swagger2Operation, Swagger2Schema, Swagger2Spec } from "../../api/compat/gen-fixtures";
import contractRaw from "./v1-swagger.generated.json?raw";

export type { Swagger2Method, Swagger2Operation, Swagger2Schema, Swagger2Spec };

/** The frozen contract, structurally validated at module load. */
export const contract: Swagger2Spec = parseSwagger2Contract(contractRaw);

/**
 * The property map of one `#/definitions` model. `Swagger2Schema` leaves
 * `properties` optional (not every definition is an object model), while every
 * caller here reads the field set of a known object model — a missing map is a
 * frozen-contract regression, so this throws with a pointed message instead of
 * leaking `undefined` into `Object.keys`.
 */
export function contractModelProperties(name: string): Record<string, Swagger2Schema> {
  const properties = contract.definitions[name]?.properties;
  if (properties === undefined) {
    throw new Error(`frozen contract: definition "${name}" has no properties`);
  }
  return properties;
}

/**
 * Whether a route-declared response code is contract-conformant: the code is
 * declared verbatim, OR it is an explicit 4xx/5xx on an op carrying the
 * DEFAULT-FOLD shape. Upstream 5671c5192d folded the vendored copy's doc-only
 * error responses into `default: #/responses/error` on every op shaped exactly
 * {one 2xx, default} — provably doc-only at the route layer (the handlers
 * still answer the pre-fold explicit codes), re-aligned as the fold-equivalence
 * rule by 09c2b92. This mirrors scripts/check-openapi.mjs's
 * `defaultFoldSuccessCode` acceptance for the route batteries: a fold-shape op
 * accepts the route's explicit 4xx/5xx spellings; a different success code, or
 * any extra code on a NON-fold op (multi-success / 3xx arms), stays a hard
 * miss (those carry the documented RUNTIME_ONLY exceptions instead).
 */
export function contractAcceptsDeclaredCode(path: string, method: Swagger2Method, code: string): boolean {
  const codes = new Set(Object.keys(contract.paths[path]?.[method]?.responses ?? {}));
  if (codes.has(code)) {
    return true;
  }
  if (codes.size !== 2 || !codes.has("default")) {
    return false;
  }
  const [other] = [...codes].filter((entry) => entry !== "default");
  return (other?.startsWith("2") ?? false) && (code.startsWith("4") || code.startsWith("5"));
}
