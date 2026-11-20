/**
 * Tests for the tier-1 golden fixtures (SPEC-0004 §2.3/§5.3).
 *
 * The committed `tier1-fixtures.json` must stay a faithful, drift-free
 * projection of (a) the SPEC-0004 appendix-A tier-1 table and (b) the frozen
 * contract `apps/worker/src/compat/contract/v1-swagger.generated.json`.
 * Both inputs are loaded through Vite's `?raw` (resolved at build time — the
 * workerd test pool has no filesystem), re-processed by the pure generator,
 * and compared against the committed file, so any SPEC tiering change or
 * contract re-pin that is not regenerated fails here.
 *
 * Regenerate after an intentional change:
 *   node apps/worker/src/api/compat/gen-fixtures.runner.mjs
 */
import { describe, expect, it } from "vitest";

import contractRaw from "../../compat/contract/v1-swagger.generated.json?raw";
import tier1SpecMarkdown from "../../../../../specs/0004-api-v1-core.md?raw";
import {
  generateTier1Fixtures,
  parseSwagger2Contract,
  parseTier1Fixtures,
  parseTier1Table,
  specTier1Table,
  TIER1_EXPECTED_OPERATIONS,
  TIER1_EXPECTED_PATHS,
} from "./gen-fixtures";
import fixturesRaw from "./tier1-fixtures.json?raw";

const contract = parseSwagger2Contract(contractRaw);
const committed = parseTier1Fixtures(fixturesRaw);
const fresh = generateTier1Fixtures(contract);
const tier1 = specTier1Table();

/** Struct names header-converted error bodies resolve to (no definition entry). */
const HEADER_ERROR_STRUCTS = new Set(
  Object.values(committed.operations)
    .flatMap((operation) => Object.values(operation.responses))
    .filter((response) => response.convertedFromHeader === true)
    .map((response) => response.modelRef)
    .filter((modelRef): modelRef is string => modelRef !== null),
);

function expectNoDanglingRefs(value: unknown, at: string): void {
  if (typeof value === "string") {
    expect(value.startsWith("#/"), `dangling JSON-pointer ref at ${at}: ${value}`).toBe(false);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((element, index) => expectNoDanglingRefs(element, `${at}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, element] of Object.entries(value)) {
      expect(key, `dangling $ref key at ${at}`).not.toBe("$ref");
      expectNoDanglingRefs(element, `${at}.${key}`);
    }
  }
}

describe("tier-1 fixture counts (SPEC-0004 §2.3)", () => {
  it("parses the appendix-A tier-1 table as exactly 78 paths / 129 operations", () => {
    expect(tier1).toHaveLength(TIER1_EXPECTED_PATHS);
    const operations = tier1.reduce((sum, entry) => sum + entry.methods.length, 0);
    expect(operations).toBe(TIER1_EXPECTED_OPERATIONS);
  });

  it("covers exactly those operations, one fixture per tier-1 operation", () => {
    expect(committed.meta.counts).toEqual({ paths: TIER1_EXPECTED_PATHS, operations: TIER1_EXPECTED_OPERATIONS });
    expect(committed.operations).toHaveLength(TIER1_EXPECTED_OPERATIONS);
    expect(new Set(committed.operations.map((operation) => operation.path))).toHaveLength(TIER1_EXPECTED_PATHS);
  });

  it("keeps SPEC/fixture/generator in sync — the committed file equals a fresh generation", () => {
    expect(committed).toEqual(fresh);
  });
});

describe("fixture/contract agreement", () => {
  it("every fixture path+method exists in the frozen contract with the same operationId", () => {
    for (const operation of committed.operations) {
      const contractOperation = contract.paths[operation.path]?.[operation.method];
      expect(contractOperation, `${operation.method.toUpperCase()} ${operation.path} missing from contract`).toBeDefined();
      expect(operation.operationId).toBe(contractOperation?.operationId ?? "");
    }
  });

  it("every fixture status is declared by the contract for that operation", () => {
    for (const operation of committed.operations) {
      const contractStatuses = new Set(Object.keys(contract.paths[operation.path]?.[operation.method]?.responses ?? {}));
      for (const status of Object.keys(operation.responses)) {
        expect(
          contractStatuses.has(status),
          `${operation.method.toUpperCase()} ${operation.path} ${status} not declared by the contract`,
        ).toBe(true);
      }
    }
  });

  it("resolves every modelRef against the contract definitions (or the header-error structs)", () => {
    for (const operation of committed.operations) {
      for (const [status, response] of Object.entries(operation.responses)) {
        if (response.modelRef === null) {
          continue;
        }
        const known =
          response.modelRef in contract.definitions || HEADER_ERROR_STRUCTS.has(response.modelRef);
        expect(
          known,
          `${operation.method.toUpperCase()} ${operation.path} ${status}: unresolved modelRef ${response.modelRef}`,
        ).toBe(true);
      }
    }
  });

  it("contains no dangling $ref strings — everything is resolved", () => {
    expectNoDanglingRefs(committed, "tier1-fixtures.json");
  });
});

describe("contract quirks (SPEC-0004 §2.5)", () => {
  it("converts every contract header-error response to a body expectation, and only those", () => {
    for (const operation of committed.operations) {
      const contractOperation = contract.paths[operation.path]?.[operation.method];
      for (const [status, response] of Object.entries(operation.responses)) {
        const declared = contractOperation?.responses?.[status];
        const refName = declared?.$ref?.split("/").pop();
        const isHeaderErrorFamily =
          refName !== undefined &&
          ["error", "forbidden", "unauthorized", "validationError", "repoArchivedError", "invalidTopicsError"].includes(
            refName,
          );
        expect(
          response.convertedFromHeader === true,
          `${operation.method.toUpperCase()} ${operation.path} ${status}: header-error ${String(refName)} must set convertedFromHeader`,
        ).toBe(isHeaderErrorFamily);
        if (isHeaderErrorFamily) {
          expect(response.kind).toBe("error-body");
          const fieldNames = response.fields.map((field) => field.name).sort();
          expect(fieldNames).toContain("message");
          for (const field of response.fields) {
            expect(field.required, `${response.modelRef}.${field.name} must be required`).toBe(true);
          }
        }
      }
    }
  });

  it("keeps bodyless responses (notFound/empty/conflict and inline description-only) empty", () => {
    for (const operation of committed.operations) {
      for (const response of Object.values(operation.responses)) {
        if (response.kind === "empty") {
          expect(response.fields).toEqual([]);
          expect(response.modelRef).toBeNull();
        }
      }
    }
    // Spot checks: the empty family lands where the SPEC says it does.
    const star = committed.operations.find((op) => op.path === "/user/starred/{owner}/{repo}" && op.method === "put");
    expect(star?.responses["204"]?.kind).toBe("empty");
    const merge = committed.operations.find(
      (op) => op.path === "/repos/{owner}/{repo}/pulls/{index}/merge" && op.method === "get",
    );
    expect(merge?.responses["204"]?.kind).toBe("empty");
    // Re-pin note (5671c5192d, vendored at 099abf5db4): the op's explicit
    // 404 notFound doc was folded into `default` — the fixture projects the
    // contract verbatim, so the error arm is the default error-body now.
    expect(merge?.responses["default"]?.kind).toBe("error-body");
    expect(merge?.responses["404"]).toBeUndefined();
  });

  it("records pagination exactly on the contract's page+limit|per_page operations", () => {
    for (const entry of tier1) {
      for (const method of entry.methods) {
        const contractOperation = contract.paths[entry.path]?.[method];
        const queryNames = new Set(
          (contractOperation?.parameters ?? []).filter((parameter) => parameter.in === "query").map((p) => p.name),
        );
        const fixture = committed.operations.find((op) => op.path === entry.path && op.method === method);
        const shouldPaginate = queryNames.has("page") && (queryNames.has("limit") || queryNames.has("per_page"));
        expect(
          (fixture?.pagination !== undefined) === shouldPaginate,
          `${method.toUpperCase()} ${entry.path}: pagination flag=${fixture?.pagination !== undefined}, contract paginated=${shouldPaginate}`,
        ).toBe(true);
        if (shouldPaginate) {
          expect(fixture?.pagination?.runtimeHeaders).toEqual(["Link", "X-Total-Count"]);
          expect(fixture?.pagination?.sizeParam).toBe(queryNames.has("per_page") ? "per_page" : "limit");
        }
      }
    }
    // git/trees is the per_page exception; CommitList/ChangedFileList declare the X-* family.
    const trees = committed.operations.find(
      (op) => op.path === "/repos/{owner}/{repo}/git/trees/{sha}" && op.method === "get",
    );
    expect(trees?.pagination?.sizeParam).toBe("per_page");
    const commits = committed.operations.find(
      (op) => op.path === "/repos/{owner}/{repo}/commits" && op.method === "get",
    );
    expect(commits?.responses["200"]?.declaredHeaders).toContain("X-Total-Count");
  });

  it("distinguishes the contract's union shapes (contents list = array, single = model)", () => {
    const list = committed.operations.find(
      (op) => op.path === "/repos/{owner}/{repo}/contents" && op.method === "get",
    );
    expect(list?.responses["200"]).toMatchObject({ kind: "model-array", modelRef: "ContentsResponse" });
    const single = committed.operations.find(
      (op) => op.path === "/repos/{owner}/{repo}/contents/{filepath}" && op.method === "get",
    );
    expect(single?.responses["200"]).toMatchObject({ kind: "model", modelRef: "ContentsResponse" });
    const search = committed.operations.find((op) => op.path === "/users/search" && op.method === "get");
    expect(search?.responses["200"]).toMatchObject({ kind: "inline-object", modelRef: null });
  });

  it("types non-JSON bodies (raw/media = binary, markdown render = string)", () => {
    const raw = committed.operations.find(
      (op) => op.path === "/repos/{owner}/{repo}/raw/{filepath}" && op.method === "get",
    );
    expect(raw?.responses["200"]?.kind).toBe("binary");
    const markdown = committed.operations.find((op) => op.path === "/markdown/raw" && op.method === "post");
    expect(markdown?.responses["200"]?.kind).toBe("string");
  });

  it("pins the EmptyRepository 409 to the default error-body fold (5671c5192d)", () => {
    // The pre-fold contract documented the empty-repo 409 explicitly
    // (#/definitions/APIError schema); upstream 5671c5192d folded it into
    // `default` doc-only — the runtime answer is unchanged: ctx.JSON(409,
    // api.APIError{...}) (gitea/routers/api/v1/repo/commits.go:175-181), the
    // exact {message, url} envelope the default error-body expectation
    // asserts. The fixture projects the vendored contract verbatim, so the
    // 409 is no longer an enumerated status.
    const commits = committed.operations.find(
      (op) => op.path === "/repos/{owner}/{repo}/commits" && op.method === "get",
    );
    expect(Object.keys(commits?.responses ?? {})).toEqual(["200", "default"]);
    expect(commits?.responses["default"]).toMatchObject({
      kind: "error-body",
      modelRef: "APIError",
      convertedFromHeader: true,
    });
    expect(commits?.responses["409"]).toBeUndefined();
  });
});

describe("appendix-A parsing parity", () => {
  it("re-parses the SPEC text deterministically with the documented rule", () => {
    // The same rule scripts/check-openapi.mjs applies to the appendix table.
    expect(parseTier1Table(tier1SpecMarkdown)).toEqual(tier1);
  });
});
