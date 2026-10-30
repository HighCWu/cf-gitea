/**
 * The dynamic compat suite harness (SPEC-0004 §5 stage 3, ADR-0001 D3).
 *
 * Stage 3 of the contract discipline: enumerate the tier-1 golden fixtures
 * (`tier1-fixtures.json`, derived from the frozen contract by gen-fixtures.ts)
 * and drive each IMPLEMENTED operation against the real router in-process,
 * asserting what the fixture records:
 *
 *  - the response status is one the fixture declares for the operation —
 *    except the documented runtime-only responses (the same table
 *    scripts/check-openapi.mjs carries, mirrored in RUNTIME_ONLY_RESPONSES);
 *  - Content-Type follows the response kind (JSON kinds must be
 *    application/json; string/binary kinds must not);
 *  - the body shape matches the fixture fields — every present field must be
 *    DECLARED by the model (unknown fields are the drift the suite exists to
 *    catch), and declared fields are type-checked with recursive modelRef
 *    resolution against the frozen contract's definitions (the same field
 *    extraction gen-fixtures applies at the top level);
 *  - `error-body` responses carry exactly the fixture's field set — the
 *    {message, url} APIError family and the {message, invalidTopics}
 *    APIInvalidTopicsError family (upstream services/context/api.go:68–81);
 *  - `empty` responses are byte-empty — except the 404/405/409 empty family,
 *    where upstream's APIErrorNotFound (services/context/api.go:137–142)
 *    marshals {message, url} at runtime although the contract declares no
 *    schema; the suite accepts either and notes the conversion (SPEC-0004
 *    §2.5: an explicit conversion note, never a silent skip);
 *  - operations whose fixture records `pagination` send the runtime
 *    X-Total-Count header and a well-formed Link header;
 *  - responses that record `declaredHeaders` (CommitList/ChangedFileList, the
 *    contract's own X-* family) send exactly those headers.
 *
 * The suite runs through in-process fetches (a fresh `createApiRouter()` per
 * request against the test worker's real bindings) — no SELF.fetch, no
 * server. Seeding (migrations, users/repositories rows) stays in the suite's
 * beforeAll: the vitest plugin's per-file storage isolation retains schema
 * written there (the src/auth/testing pattern).
 *
 * `runCompatSuite(options)` registers one test per fixture operation —
 * implemented operations run their scenarios and must PASS; unimplemented
 * operations are SKIPPED with an explicit list; an implemented operation
 * without a scenario registers a LOUD failure so the scenario table can never
 * silently fall behind the routes. The returned report carries the coverage
 * counters, computed with the exact algorithm of `pnpm check:api` stage (c).
 */
import { expect, it } from "vitest";

import type {
  FieldExpectation,
  FieldType,
  OperationFixture,
  ResponseExpectation,
  Swagger2Method,
  Swagger2Schema,
  Swagger2Spec,
  Tier1FixtureFile,
} from "./gen-fixtures";

// ---------------------------------------------------------------------------
// Operation identity + the implemented-operation set from the router's OpenAPI
// document (the same normalization scripts/check-openapi.mjs applies).
// ---------------------------------------------------------------------------

/** HTTP methods that can carry an operation in an OpenAPI paths object. */
const HTTP_METHODS: readonly string[] = ["get", "put", "post", "delete", "options", "head", "patch"];

/** The mount prefix routes are declared under in the generated document. */
export const MOUNT_PREFIX = "/api/v1";

/** Canonical operation key: `${method} ${contractPath}` (contract-style path). */
export function operationKey(operation: Pick<OperationFixture, "method" | "path">): string {
  return `${operation.method} ${operation.path}`;
}

/**
 * Mount-prefix-aware path normalization — byte-for-byte the rule of
 * scripts/check-openapi.mjs, so coverage counts cannot drift from the CI job.
 */
export function normalizeApiPath(declaredPath: string): string {
  const withoutPrefix =
    declaredPath === MOUNT_PREFIX
      ? "/"
      : declaredPath.startsWith(`${MOUNT_PREFIX}/`)
        ? declaredPath.slice(MOUNT_PREFIX.length)
        : declaredPath;
  return withoutPrefix === "" ? "/" : withoutPrefix;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `method path` set the router currently serves, enumerated from the
 * generated OpenAPI document (`getGeneratedSpec()` — the router's own route
 * registry, so the suite's implemented-set is exactly what would deploy).
 */
export function implementedOperations(document: unknown): ReadonlySet<string> {
  const implemented = new Set<string>();
  const paths = isRecord(document) && isRecord(document.paths) ? document.paths : {};
  for (const [declaredPath, pathItem] of Object.entries(paths)) {
    if (!isRecord(pathItem)) {
      continue;
    }
    for (const method of HTTP_METHODS) {
      if (isRecord(pathItem[method])) {
        implemented.add(`${method} ${normalizeApiPath(declaredPath)}`);
      }
    }
  }
  return implemented;
}

// ---------------------------------------------------------------------------
// Runtime-only responses (SPEC-0004 §2.5) — the exact table of
// scripts/check-openapi.mjs RUNTIME_ONLY_RESPONSES, so the static check and
// this suite accept the same documented divergences.
// ---------------------------------------------------------------------------

/**
 * Declared-by-router responses upstream really sends at runtime but the
 * vendored swagger omits. Keyed `path → method → status → reason`; each entry
 * is a documented exception with its upstream reference, never a silent skip.
 */
export const RUNTIME_ONLY_RESPONSES: Readonly<
  Record<string, Partial<Record<Swagger2Method, Readonly<Record<string, string>>>>>
> = {
  "/user": {
    get: {
      // reqToken() 401s anonymous callers (gitea/routers/api/v1/api.go); the
      // contract documents only 200 for userGetCurrent.
      401: "upstream reqToken() rejects anonymous callers; swagger documents only 200",
    },
  },
  "/repositories/{id}": {
    get: {
      401: "upstream reqToken() (token required for repoGetByID); contract documents 200/404 only",
    },
  },
  "/user/repos": {
    get: {
      401: "upstream reqToken() (token required for userCurrentListRepos); contract documents 200 only",
    },
  },
  "/markdown": {
    post: {
      401: "upstream reqToken() (routers/api/v1/api.go:1018); contract documents 200/422 only",
      400: "hono validator rejects malformed JSON before route mapping (upstream bind 422s everything, api.go:841-844) — documented divergence",
    },
  },
  "/markdown/raw": {
    post: {
      401: "upstream reqToken() (routers/api/v1/api.go:1018); contract documents 200/422 only",
    },
  },
  "/repos/{owner}/{repo}/statuses/{sha}": {
    post: {
      422: "non-full-length sha input rejected at runtime (upstream resolves refs via the engine and 500s on unknown — neither reproducible without engine ref resolution); declared set stays {201,400,404}",
    },
  },
  "/repos/{owner}/{repo}/milestones/{id}": {
    patch: {
      400: "due_on parse failure returns upstream's 'invalid date format' at runtime; undeclared in the vendored contract (same class as /user 401)",
    },
  },
};

/** The documented reason when a status is a runtime-only response, else undefined. */
export function runtimeOnlyResponseNote(path: string, method: string, status: number): string | undefined {
  return RUNTIME_ONLY_RESPONSES[path]?.[method as Swagger2Method]?.[String(status)];
}

/**
 * Runtime-only RESPONSE FIELDS — the field-level twin of
 * RUNTIME_ONLY_RESPONSES: keys upstream marshals onto a model at runtime
 * while the frozen contract does not declare them. One entry:
 * `User.MarshalJSON`'s `username` backward-compatibility alias of `login`
 * (modules/structs/user.go:67-73) — sent on EVERY User payload, declared
 * nowhere in swagger, rendered by the canonical converter since the
 * serializer seam (the api review's drift 2; our zod schema declares it for
 * the same reason, models/user.ts). The walk still TYPE-checks the value as
 * a string — only the missing contract declaration is supplied here.
 */
const RUNTIME_ONLY_MODEL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  User: ["username"],
};

// ---------------------------------------------------------------------------
// Tier-1 coverage — the exact stage-(c) algorithm of scripts/check-openapi.mjs
// (a path counts as covered only when EVERY fixture method is implemented), so
// the suite's counters equal `pnpm check:api`'s line by construction.
// ---------------------------------------------------------------------------

export interface Tier1Coverage {
  coveredPaths: number;
  totalPaths: number;
  coveredOperations: number;
  totalOperations: number;
  /** Tier-1 paths not fully implemented yet, with the have/need split. */
  missing: Array<{ path: string; have: Swagger2Method[]; need: Swagger2Method[] }>;
}

/** `22/78 paths, 35/129 operations` — the check:api report format. */
export function formatCoverage(coverage: Tier1Coverage): string {
  return (
    `${coverage.coveredPaths}/${coverage.totalPaths} paths, ` +
    `${coverage.coveredOperations}/${coverage.totalOperations} operations`
  );
}

export function computeTier1Coverage(fixtures: Tier1FixtureFile, implemented: ReadonlySet<string>): Tier1Coverage {
  const methodsByPath = new Map<string, Swagger2Method[]>();
  for (const operation of fixtures.operations) {
    const methods = methodsByPath.get(operation.path) ?? [];
    methods.push(operation.method);
    methodsByPath.set(operation.path, methods);
  }

  let coveredPaths = 0;
  let coveredOperations = 0;
  const missing: Tier1Coverage["missing"] = [];
  for (const [path, methods] of methodsByPath) {
    const have = methods.filter((method) => implemented.has(operationKey({ method, path })));
    coveredOperations += have.length;
    if (have.length === methods.length) {
      coveredPaths += 1;
    } else {
      missing.push({ path, have, need: methods });
    }
  }
  return {
    coveredPaths,
    totalPaths: methodsByPath.size,
    coveredOperations,
    totalOperations: fixtures.operations.length,
    missing,
  };
}

// ---------------------------------------------------------------------------
// Scenarios — how the suite drives one operation.
// ---------------------------------------------------------------------------

/** One HTTP request the harness sends in-process (fresh router per request). */
export interface CompatRequest {
  /** Router-relative path + query (the contract path shape, no /api/v1 prefix). */
  path: string;
  init?: RequestInit;
}

/** Sends a request through a FRESH in-process router with the real bindings. */
export type CompatRequestSender = (request: CompatRequest) => Promise<Response>;

/**
 * What a scenario can reach while building its request: the deterministic
 * seed handles the test file exported into the harness, plus the auth helper
 * carrying the suite token.
 */
export interface CompatScenarioContext {
  /** Named seed handles (owner login, repo path parts, entity ids, sha, ...). */
  readonly seeds: Readonly<Record<string, string | number>>;
  /** Merges the suite's `Authorization: token <token>` header into `init`. */
  withAuth(init?: RequestInit): RequestInit;
}

/** One executable case for a fixture operation, targeting a known status. */
export interface CompatScenarioCase {
  /** Human label for failure messages ("keyword hit", "invalid mode 422"). */
  name: string;
  /** The status this scenario drives the route to produce. */
  status: number;
  /** Link relations that must be present (multi-page lists seed ≥2 rows and force limit=1). */
  linkRels?: readonly string[];
  request: (ctx: CompatScenarioContext) => CompatRequest | Promise<CompatRequest>;
}

export interface CompatSuiteOptions {
  /** The frozen contract, parsed via gen-fixtures' parseSwagger2Contract. */
  contract: Swagger2Spec;
  /** The golden fixtures, parsed via gen-fixtures' parseTier1Fixtures. */
  fixtures: Tier1FixtureFile;
  /** `method path` set the router serves (implementedOperations(spec doc)). */
  implemented: ReadonlySet<string>;
  /** Scenario table keyed by operationId (future route batches extend it). */
  scenarios: Readonly<Record<string, readonly CompatScenarioCase[]>>;
  /** Seed handles exposed to scenarios (filled by the suite's beforeAll). */
  seeds: Readonly<Record<string, string | number>>;
  /** In-process sender (fresh router + real bindings per request). */
  send: CompatRequestSender;
}

export interface CompatSuiteReport {
  /** Fixture operations the suite exercised (implemented ∩ fixtures). */
  ran: string[];
  /** Fixture operations whose routes are not landed yet — the explicit skip list. */
  skipped: string[];
  /** Implemented fixture operations without a scenario (registered as failures). */
  missingScenarios: string[];
  /** Implemented operations with no fixture entry (tier-2 additions — out of scope). */
  outOfSuite: string[];
  /** Coverage counters, equal to `pnpm check:api`'s stage-(c) line. */
  coverage: Tier1Coverage;
}

/**
 * Register one vitest test per tier-1 fixture operation and run the
 * implemented subset against the live router. Returns the bookkeeping report
 * the suite's consistency tests assert on.
 */
export function runCompatSuite(options: CompatSuiteOptions): CompatSuiteReport {
  const { contract, fixtures, implemented, scenarios, seeds, send } = options;

  const resolveFields = contractModelFieldResolver(contract);
  const fixtureKeys = new Set(fixtures.operations.map((operation) => operationKey(operation)));
  const ran: string[] = [];
  const skipped: string[] = [];
  const missingScenarios: string[] = [];

  for (const operation of fixtures.operations) {
    const key = operationKey(operation);
    const label = `${operation.method.toUpperCase()} ${operation.path} (${operation.operationId})`;

    if (!implemented.has(key)) {
      skipped.push(key);
      it.skip(`not implemented yet: ${label}`, () => {});
      continue;
    }

    const cases = scenarios[operation.operationId];
    if (cases === undefined) {
      missingScenarios.push(key);
      it(`implemented without a fixture scenario: ${label}`, () => {
        throw new Error(
          `implemented tier-1 operation ${label} has no compat scenario — ` +
            "add one to the scenario table in suite.test.ts so its fixture assertions run",
        );
      });
      continue;
    }

    ran.push(key);
    it(`${label} matches its tier-1 fixture`, async () => {
      const ctx: CompatScenarioContext = {
        seeds,
        withAuth(init?: RequestInit) {
          const headers = new Headers(init?.headers);
          headers.set("Authorization", `token ${String(seeds.token)}`);
          return { ...init, headers };
        },
      };
      for (const scenarioCase of cases) {
        const problems = await runScenarioCase(operation, scenarioCase, ctx, send, resolveFields);
        expect(problems, `scenario "${scenarioCase.name}" (expecting ${scenarioCase.status})`).toEqual([]);
      }
    });
  }

  const outOfSuite = [...implemented].filter((key) => !fixtureKeys.has(key)).sort();
  return {
    ran,
    skipped,
    missingScenarios,
    outOfSuite,
    coverage: computeTier1Coverage(fixtures, implemented),
  };
}

// ---------------------------------------------------------------------------
// Per-case execution: one request, then the fixture assertions.
// ---------------------------------------------------------------------------

const JSON_CONTENT_TYPE = "application/json";
const LINK_RELATION_PATTERN = /^<[^>]+>;\s*rel="(next|last|first|prev)"$/u;

async function runScenarioCase(
  operation: OperationFixture,
  scenarioCase: CompatScenarioCase,
  ctx: CompatScenarioContext,
  send: CompatRequestSender,
  lookup: FieldLookup,
): Promise<string[]> {
  const request = await scenarioCase.request(ctx);
  const response = await send(request);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const bodyText = new TextDecoder().decode(bytes);

  const at = `${operation.method.toUpperCase()} ${operation.path} [${scenarioCase.name}]`;
  const problems: string[] = [];

  // (1) The scenario drives a known status — anything else is a router or
  // scenario regression and the fixture assertions below would be noise.
  if (response.status !== scenarioCase.status) {
    problems.push(`${at}: expected status ${scenarioCase.status}, got ${response.status} (body: ${clip(bodyText)})`);
    return problems;
  }

  const expectation = operation.responses[String(response.status)];
  if (expectation === undefined) {
    // (2) Not a fixture status: only the documented runtime-only responses are
    // acceptable, and they carry the generic APIError envelope.
    const note = runtimeOnlyResponseNote(operation.path, operation.method, response.status);
    if (note === undefined) {
      problems.push(
        `${at}: status ${response.status} is neither a fixture response ` +
          `{${Object.keys(operation.responses).join(", ")}} nor a documented runtime-only exception`,
      );
      return problems;
    }
    assertRuntimeOnlyErrorEnvelope(bodyText, response, at, note, problems);
    return problems;
  }

  // (3) Content-Type per response kind.
  assertContentType(expectation.kind, response, at, problems);

  // (4) Body shape per response kind.
  const parsed = tryParseJson(bodyText);
  switch (expectation.kind) {
    case "model":
      assertModelShape(parsed.value, expectationBodyFields(expectation, lookup), at, problems, lookup, expectation.modelRef ?? undefined);
      break;
    case "model-array": {
      if (!Array.isArray(parsed.value)) {
        problems.push(`${at}: expected a JSON array, got ${clip(bodyText)}`);
        break;
      }
      const elementFields = expectationBodyFields(expectation, lookup);
      parsed.value.forEach((element, index) =>
        assertModelShape(element, elementFields, `${at}[${index}]`, problems, lookup, expectation.modelRef ?? undefined),
      );
      break;
    }
    case "model-map": {
      if (!isPlainObject(parsed.value)) {
        problems.push(`${at}: expected a JSON object (map), got ${clip(bodyText)}`);
        break;
      }
      for (const [key, value] of Object.entries(parsed.value)) {
        assertPrimitive(value, expectation.mapValueType ?? "any", `${at}.${key}`, problems);
      }
      break;
    }
    case "inline-object":
      assertModelShape(parsed.value, expectation.fields, at, problems, lookup);
      break;
    case "error-body":
      assertErrorBodyShape(parsed, expectation, at, problems);
      break;
    case "string":
      if (bytes.byteLength === 0) {
        problems.push(`${at}: string body is empty`);
      }
      break;
    case "binary":
      if (bytes.byteLength === 0) {
        problems.push(`${at}: binary body is empty`);
      } else if (parsed.ok) {
        problems.push(`${at}: binary body parses as JSON — the bytes are not a raw stream`);
      }
      break;
    case "empty":
      assertEmptyBody(bytes, parsed, at, problems);
      break;
  }

  // (5) Runtime pagination headers on list operations (SPEC-0004 §2.5).
  if (operation.pagination !== undefined && response.status === 200) {
    assertPaginationHeaders(response, scenarioCase.linkRels ?? [], at, problems);
  }

  // (6) The X-* header families the contract itself declares
  // (CommitList/ChangedFileList — not exercised until those routes land).
  for (const header of expectation.declaredHeaders ?? []) {
    if (response.headers.get(header) === null) {
      problems.push(`${at}: contract-declared header "${header}" missing from the response`);
    }
  }

  return problems;
}

/** Resolves a `#/definitions` model name to its flattened field expectations. */
type FieldLookup = (modelRef: string) => FieldExpectation[];

/** The walk list for a model/model-array expectation: its element model's fields. */
function expectationBodyFields(expectation: ResponseExpectation, lookup: FieldLookup): FieldExpectation[] {
  return expectation.modelRef === null ? expectation.fields : lookup(expectation.modelRef);
}

/** Content-Type follows the response kind (SPEC-0004 §5.3). */
function assertContentType(kind: ResponseExpectation["kind"], response: Response, at: string, problems: string[]): void {
  const contentType = response.headers.get("content-type") ?? "";
  const jsonBody = kind !== "string" && kind !== "binary" && kind !== "empty";
  if (jsonBody && !contentType.includes(JSON_CONTENT_TYPE)) {
    problems.push(`${at}: ${kind} response must be ${JSON_CONTENT_TYPE}, got "${contentType}"`);
  }
  if (!jsonBody && kind !== "empty" && contentType.includes(JSON_CONTENT_TYPE)) {
    problems.push(`${at}: ${kind} response must not be ${JSON_CONTENT_TYPE}, got "${contentType}"`);
  }
}

/**
 * The `empty` family: byte-empty per the contract — except that upstream's
 * APIErrorNotFound (services/context/api.go:137) marshals {message, url} on
 * the 404/405/409 empty family at runtime. Both are accepted; anything else
 * fails (with the conversion documented here, never silently).
 */
function assertEmptyBody(bytes: Uint8Array, parsed: JsonResult, at: string, problems: string[]): void {
  if (bytes.byteLength === 0) {
    return;
  }
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    problems.push(`${at}: empty-family response carries a non-empty body that is not the runtime APIError JSON`);
    return;
  }
  assertApiErrorEnvelope(parsed.value, at, problems);
}

/**
 * A runtime-only (swagger-undeclared) status must still speak the APIError
 * envelope — every entry in RUNTIME_ONLY_RESPONSES is an error variant.
 */
function assertRuntimeOnlyErrorEnvelope(
  bodyText: string,
  response: Response,
  at: string,
  note: string,
  problems: string[],
): void {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes(JSON_CONTENT_TYPE)) {
    problems.push(`${at}: runtime-only status ${response.status} (${note}) must be JSON, got "${contentType}"`);
  }
  const parsed = tryParseJson(bodyText);
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    problems.push(`${at}: runtime-only status ${response.status} (${note}) must carry the {message, url} envelope`);
    return;
  }
  assertApiErrorEnvelope(parsed.value, at, problems);
}

/** Upstream APIError (modules/structs/miscellaneous.go): exactly message + url. */
function assertApiErrorEnvelope(body: Record<string, unknown>, at: string, problems: string[]): void {
  const keys = Object.keys(body).sort();
  if (keys.join(",") !== "message,url") {
    problems.push(`${at}: APIError envelope key set ${JSON.stringify(keys)} != ["message","url"]`);
  }
  for (const field of ["message", "url"]) {
    const value = body[field];
    if (value !== undefined && value !== null && typeof value !== "string") {
      problems.push(`${at}.${field}: expected a string, got ${describe(value)}`);
    }
  }
}

/** error-body: exactly the fixture's field set (the header-converted structs). */
function assertErrorBodyShape(parsed: JsonResult, expectation: ResponseExpectation, at: string, problems: string[]): void {
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    problems.push(`${at}: error-body must be a JSON object, got ${clip(String(parsed.value))}`);
    return;
  }
  const declared = expectation.fields.map((field) => field.name).sort();
  const actual = Object.keys(parsed.value).sort();
  if (actual.join(",") !== declared.join(",")) {
    problems.push(
      `${at}: error-body key set ${JSON.stringify(actual)} != fixture ${JSON.stringify(declared)} ` +
        `(${expectation.modelRef ?? "untyped"})`,
    );
  }
  for (const field of expectation.fields) {
    const value = parsed.value[field.name];
    if (value === null || value === undefined) {
      continue; // nil slices marshal as null (APIInvalidTopicsError.invalidTopics)
    }
    if (field.type === "string") {
      assertPrimitive(value, "string", `${at}.${field.name}`, problems);
    } else if (field.type === "array") {
      if (!Array.isArray(value)) {
        problems.push(`${at}.${field.name}: expected an array, got ${describe(value)}`);
        continue;
      }
      const itemType = field.itemType;
      if (itemType !== undefined && itemType !== "any") {
        value.forEach((element, index) => assertPrimitive(element, itemType, `${at}.${field.name}[${index}]`, problems));
      }
    }
  }
}

/**
 * Body-shape walk: every present field must be declared (unknown fields are
 * the semantic drift the suite exists to catch) and declared fields are
 * type-checked. Nulls pass — upstream marshals absent Go values as null and
 * the contract declares no required fields on response models. `modelName`
 * is the model this object level validates against (undefined for
 * inline-object bodies): the undeclared-key check consults
 * RUNTIME_ONLY_MODEL_FIELDS under it, so a documented runtime-only key passes
 * (still type-checked) instead of failing as drift.
 */
function assertModelShape(
  value: unknown,
  fields: FieldExpectation[],
  at: string,
  problems: string[],
  lookup: FieldLookup,
  modelName?: string,
): void {
  if (!isPlainObject(value)) {
    problems.push(`${at}: expected a JSON object, got ${describe(value)}`);
    return;
  }
  const byName = new Map(fields.map((field) => [field.name, field]));
  for (const [key, actual] of Object.entries(value)) {
    const field = byName.get(key);
    if (field === undefined) {
      if (modelName !== undefined && RUNTIME_ONLY_MODEL_FIELDS[modelName]?.includes(key)) {
        assertFieldValue(actual, { name: key, type: "string", required: false }, at, problems, lookup);
        continue;
      }
      problems.push(`${at}.${key}: field not declared by the fixture model (unknown field)`);
      continue;
    }
    assertFieldValue(actual, field, at, problems, lookup);
  }
}

function assertFieldValue(
  value: unknown,
  field: FieldExpectation,
  at: string,
  problems: string[],
  lookup: FieldLookup,
): void {
  if (value === null) {
    return;
  }
  switch (field.type) {
    case "string":
    case "integer":
    case "number":
    case "boolean":
      assertPrimitive(value, field.type, at, problems);
      return;
    case "array": {
      if (!Array.isArray(value)) {
        problems.push(`${at}: expected an array, got ${describe(value)}`);
        return;
      }
      const itemRef = field.itemRef;
      const itemType = field.itemType;
      value.forEach((element, index) => {
        const elementAt = `${at}[${index}]`;
        if (itemRef !== undefined) {
          assertModelShape(element, lookup(itemRef), elementAt, problems, lookup, itemRef);
        } else if (itemType !== undefined && itemType !== "any") {
          assertPrimitive(element, itemType, elementAt, problems);
        }
      });
      return;
    }
    case "object": {
      if (field.ref !== undefined) {
        assertModelShape(value, lookup(field.ref), at, problems, lookup, field.ref);
        return;
      }
      const mapValueRef = field.mapValueRef;
      if (mapValueRef !== undefined) {
        if (!isPlainObject(value)) {
          problems.push(`${at}: expected an object of ${mapValueRef}, got ${describe(value)}`);
          return;
        }
        for (const [key, element] of Object.entries(value)) {
          assertModelShape(element, lookup(mapValueRef), `${at}.${key}`, problems, lookup, mapValueRef);
        }
        return;
      }
      const mapValueType = field.mapValueType;
      if (mapValueType !== undefined && mapValueType !== "any") {
        if (!isPlainObject(value)) {
          problems.push(`${at}: expected an object map, got ${describe(value)}`);
          return;
        }
        for (const [key, element] of Object.entries(value)) {
          assertPrimitive(element, mapValueType, `${at}.${key}`, problems);
        }
        return;
      }
      if (!isPlainObject(value)) {
        problems.push(`${at}: expected an object, got ${describe(value)}`);
      }
      return;
    }
    default:
      return; // "any" / "file" — untyped in the contract
  }
}

function assertPrimitive(value: unknown, type: FieldType, at: string, problems: string[]): void {
  const matches =
    type === "string"
      ? typeof value === "string"
      : type === "integer"
        ? typeof value === "number" && Number.isInteger(value)
        : type === "number"
          ? typeof value === "number"
          : type === "boolean"
            ? typeof value === "boolean"
            : true; // "any" / "object" / "array" / "file" leaves — nothing to check here
  if (!matches) {
    problems.push(`${at}: expected ${type}, got ${describe(value)}`);
  }
}

/** Runtime list headers upstream sends on every paginated list (§2.5). */
function assertPaginationHeaders(
  response: Response,
  requiredRels: readonly string[],
  at: string,
  problems: string[],
): void {
  const total = response.headers.get("X-Total-Count");
  if (total === null) {
    problems.push(`${at}: paginated list missing the runtime X-Total-Count header`);
  } else if (!/^\d+$/u.test(total)) {
    problems.push(`${at}: X-Total-Count is not numeric: "${total}"`);
  }

  const link = response.headers.get("Link");
  if (link !== null) {
    for (const segment of link.split(",")) {
      if (!LINK_RELATION_PATTERN.test(segment.trim())) {
        problems.push(`${at}: malformed Link relation segment ${JSON.stringify(segment)}`);
      }
    }
  }
  for (const rel of requiredRels) {
    if (link === null || !link.includes(`rel="${rel}"`)) {
      problems.push(`${at}: Link header missing required relation "${rel}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Nested model resolution — the fixture's FieldExpectation shape re-derived
// from the frozen contract's definitions (mirrors gen-fixtures' fieldFromSchema
// so nested recursion matches the generator's top-level extraction exactly).
// ---------------------------------------------------------------------------

/**
 * Cached field resolver over one parsed contract: the recursive walk resolves
 * nested `$ref`s (field.ref / itemRef / mapValueRef) through this, so a model
 * definition is flattened once per suite run.
 */
function contractModelFieldResolver(contract: Swagger2Spec): (modelRef: string) => FieldExpectation[] {
  const cache = new Map<string, FieldExpectation[]>();
  return (modelRef: string) => {
    const cached = cache.get(modelRef);
    if (cached !== undefined) {
      return cached;
    }
    const fields = contractModelFields(contract, modelRef);
    cache.set(modelRef, fields);
    return fields;
  };
}

/** Flattens one `#/definitions` model into field expectations. */
export function contractModelFields(contract: Swagger2Spec, modelRef: string): FieldExpectation[] {
  const definition = contract.definitions[modelRef];
  if (definition === undefined) {
    throw new Error(`fixture model "${modelRef}" does not resolve in the frozen contract definitions`);
  }
  const required = definition.required ?? [];
  return Object.entries(definition.properties ?? {}).map(([name, property]) =>
    fieldFromContractSchema(name, property, required.includes(name)),
  );
}

function fieldFromContractSchema(name: string, schema: Swagger2Schema, required: boolean): FieldExpectation {
  const field: FieldExpectation = { name, type: "any", required };
  if (schema.$ref !== undefined) {
    field.type = "object";
    field.ref = definitionRefName(schema.$ref);
    return field;
  }
  if (schema.format !== undefined) {
    field.format = schema.format;
  }
  if (schema.type === "array") {
    field.type = "array";
    const items = schema.items;
    if (items !== undefined) {
      if (items.$ref !== undefined) {
        field.itemRef = definitionRefName(items.$ref);
      } else if (items.type !== undefined) {
        field.itemType = items.type as FieldType;
      }
    }
    return field;
  }
  if (schema.type === "object") {
    field.type = "object";
    if (schema.additionalProperties !== undefined) {
      field.mapValueType = (schema.additionalProperties.type as FieldType | undefined) ?? "any";
      if (schema.additionalProperties.$ref !== undefined) {
        field.mapValueRef = definitionRefName(schema.additionalProperties.$ref);
      }
    }
    return field;
  }
  if (schema.type !== undefined) {
    field.type = schema.type as FieldType;
  }
  return field;
}

function definitionRefName(ref: string): string {
  const prefix = "#/definitions/";
  if (!ref.startsWith(prefix)) {
    throw new Error(`unsupported definition $ref "${ref}" (expected #/definitions/<Name>)`);
  }
  return ref.slice(prefix.length);
}

// ---------------------------------------------------------------------------
// Small parsing/describing helpers.
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JsonResult = { ok: true; value: unknown } | { ok: false; value: string };

function tryParseJson(text: string): JsonResult {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, value: text };
  }
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }
  if (isPlainObject(value)) {
    return `object{${Object.keys(value).join(",")}}`;
  }
  if (typeof value === "string") {
    return `string(${clip(value)})`;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${typeof value}(${String(value)})`;
  }
  return typeof value;
}

function clip(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
