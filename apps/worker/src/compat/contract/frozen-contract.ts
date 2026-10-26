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
