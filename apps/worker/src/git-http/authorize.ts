import { secretsEqual } from "@cf-gitea/git-engine";
import type { AuthContext } from "@cf-gitea/git-engine";

import { TokenService } from "../auth";
import { isGateCleared } from "./gate";

/**
 * Engine authorize hook for the git smart-HTTP surface.
 *
 * SPEC-0003 M1.5 split:
 * - Requests the `gitHttpGate` (src/git-http/gate.ts) already authorized are
 *   waved through — the gate resolved the D1 repositories row and enforced
 *   the ACL matrix (SPEC-0003 §2.4), so re-deciding here would bypass it.
 * - Everything else is the transitional passthrough for repositories that
 *   predate the D1 registry (and the e2e suite): reads of public repositories
 *   are open; everything else requires HTTP Basic credentials whose password
 *   is a personal access token, verified against D1 (prefix lookup +
 *   timing-safe sha256 digest compare + expiry — TokenService.verify).
 *
 * Dev/e2e fallback: the static `GIT_TOKEN` secret still works so the
 * byte-identical e2e suite and local development keep running before repo
 * lifecycle (SPEC-0003 M3) gives every repository a D1 row.
 * TODO(SPEC-0003 M3): remove the fallback; the gate owns all authorization.
 *
 * Failure semantics stay the engine's: `false` → default 401 Basic challenge
 * (git clients prompt and retry exactly like GitHub/Gitea).
 */
export async function authorize(ctx: AuthContext<Env>): Promise<boolean | Response> {
  if (isGateCleared(ctx.request)) return true;

  if (ctx.op === "read" && !ctx.private) return true;

  const pass = ctx.credentials?.pass ?? "";
  if (pass.length >= 8) {
    try {
      const auth = await new TokenService(ctx.env.DB).verify(pass);
      if (auth !== null) {
        // TODO(SPEC-0003 M3): superseded by the gitHttpGate ACL matrix for
        // D1-registered repositories; this branch only serves the
        // passthrough set until lifecycle lands.
        return true;
      }
    } catch {
      // D1 unavailable/unmigrated: fall through to the static-token check —
      // git traffic must fail closed (401 challenge), never 500.
    }
  }

  const token = ctx.env.GIT_TOKEN?.trim();
  if (!token) {
    return new Response("access is disabled: set the GIT_TOKEN secret\n", { status: 403 });
  }
  // timing-safe compare — never `pass === token` (leaks match length)
  return secretsEqual(pass, token);
}
