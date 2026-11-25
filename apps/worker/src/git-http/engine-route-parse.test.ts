import { describe, expect, it } from "vitest";

import { parseEngineRoute } from "./parse";

/**
 * The engine-route classifier's ADMIN family (the pack-maintenance amendment,
 * SPEC-0011 §5.1/§2 as-built): POST /compact and POST /pack-gc join POST /gc
 * as claimed admin shapes, so a D1-resolved repo takes the gate's
 * owner/site-admin ACL arm BEFORE the engine's own authorize hook — parity
 * with the existing admin family, no new auth surface. Pure function unit:
 * no D1, no DO, no workerd bindings.
 */
describe("parseEngineRoute admin family — /compact and /pack-gc", () => {
  it("claims POST compact/pack-gc as admin, alongside POST gc", () => {
    for (const tail of ["compact", "pack-gc", "gc"]) {
      expect(parseEngineRoute(`/alice/widgets/${tail}`, "POST")).toEqual({
        owner: "alice",
        repo: "widgets",
        kind: "admin",
      });
    }
  });

  it("claims the .git-suffixed form too (the engine's trim is unambiguous)", () => {
    expect(parseEngineRoute("/alice/widgets.git/compact", "POST")).toEqual({
      owner: "alice",
      repo: "widgets",
      kind: "admin",
    });
  });

  it("does NOT claim other methods on the new tails (GET compact is a page shape, pre-auth 404 engine-side)", () => {
    expect(parseEngineRoute("/alice/widgets/compact", "GET")).toBeNull();
    expect(parseEngineRoute("/alice/widgets/pack-gc", "GET")).toBeNull();
    expect(parseEngineRoute("/alice/widgets/gc", "GET")).toBeNull();
    expect(parseEngineRoute("/alice/widgets/compact", "PUT")).toBeNull();
    expect(parseEngineRoute("/alice/widgets/pack-gc", "DELETE")).toBeNull();
  });

  it("does NOT claim look-alike tails (prefixes, sub-paths, encoded variants decode to non-shapes)", () => {
    expect(parseEngineRoute("/alice/widgets/compactify", "POST")).toBeNull();
    expect(parseEngineRoute("/alice/widgets/pack-gc/extra", "POST")).toBeNull();
    expect(parseEngineRoute("/alice/widgets/gc2", "POST")).toBeNull();
  });

  it("keeps the existing admin family verbatim (config/description PUT, repo-root DELETE)", () => {
    expect(parseEngineRoute("/alice/widgets/config", "PUT")?.kind).toBe("admin");
    expect(parseEngineRoute("/alice/widgets/description", "PUT")?.kind).toBe("admin");
    expect(parseEngineRoute("/alice/widgets", "DELETE")?.kind).toBe("admin");
  });

  it("keeps api/* a read-family claim, not admin", () => {
    expect(parseEngineRoute("/alice/widgets/api/refs", "GET")?.kind).toBe("api");
    expect(parseEngineRoute("/alice/widgets/api/compact", "POST")?.kind).toBe("api");
  });
});
