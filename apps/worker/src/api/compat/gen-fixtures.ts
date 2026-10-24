/**
 * Tier-1 golden fixtures, derived from the frozen Gitea API contract.
 *
 * SPEC-0004 §2.3/§5.3: the dynamic compat suite enumerates every tier-1
 * operation and asserts status code, body shape and pagination headers.
 * This module produces the expectation records that suite will consume: for
 * each of the 129 tier-1 operations (78 paths, parsed from SPEC-0004
 * appendix A at RUNTIME — never copy-pasted) it normalizes the frozen
 * contract's declared responses into `{status → {fields, modelRef, ...}}`.
 *
 * Framework-free on purpose: pure TypeScript over plain data, importable
 * from the vitest workerd pool, the Node-side runner
 * (`gen-fixtures.runner.mjs`) and the future dynamic suite alike. The single
 * module-level input is the SPEC-0004 markdown text, imported through Vite's
 * `?raw` (resolved at build time by the same vite pipeline vitest and the
 * runner both use — no filesystem access at runtime).
 *
 * Swagger 2.0 quirks handled explicitly (SPEC-0004 §2.5 — never a silent
 * skip):
 *  - `$ref`s are resolved: `#/responses/<Name>` (one level) then
 *    `#/definitions/<Model>` (fields flattened per model);
 *  - the error family (`error`/`forbidden`/`unauthorized`/`validationError`/
 *    `repoArchivedError`/`invalidTopicsError`) declares its runtime JSON body
 *    fields as response HEADERS (swagger-go generation artifact). Converted
 *    to body-field expectations with `convertedFromHeader: true`; field
 *    values come from the declared headers, so a re-pin that adds a header
 *    flows through;
 *  - bodyless responses (`notFound`/`empty`/`conflict`, plus inline
 *    description-only responses) become `kind: "empty"` (204-style empty on
 *    404/405/409);
 *  - the only two responses that declare the `X-*` pagination header family
 *    in the contract (CommitList, ChangedFileList) keep it as
 *    `declaredHeaders` — a contract-declared exception;
 *  - paginated operations (query params `page` + `limit`, or `page` +
 *    `per_page` for git/trees) record the RUNTIME `Link`/`X-Total-Count`
 *    header exception (SPEC-0004 §2.5) as `pagination`;
 *  - union shapes the contract itself distinguishes stay distinct: each
 *    operation carries its own shape (e.g. `repoGetContentsList` is a
 *    `model-array` of ContentsResponse while `repoGetContents` is a `model`).
 *
 * Regenerate the committed JSON (no package.json script — runner is
 * self-contained):
 *   node apps/worker/src/api/compat/gen-fixtures.runner.mjs
 */
import tier1SpecMarkdown from "../../../../../specs/0004-api-v1-core.md?raw";

/**
 * Tier-1 totals documented in SPEC-0004 §2.3. The appendix table is re-counted
 * on every generation/test run; a mismatch means the SPEC tiering drifted.
 */
export const TIER1_EXPECTED_PATHS = 78;
export const TIER1_EXPECTED_OPERATIONS = 129;

/** Paths, relative to the repo root, the fixtures are derived from. */
export const FIXTURE_INPUTS = {
  contract: "apps/worker/src/compat/contract/v1-swagger.generated.json",
  tier1Source: "specs/0004-api-v1-core.md",
  generator: "apps/worker/src/api/compat/gen-fixtures.ts",
} as const;

/** Path of the committed fixture file, relative to the repo root. */
export const FIXTURE_OUTPUT = "apps/worker/src/api/compat/tier1-fixtures.json";

// ---------------------------------------------------------------------------
// Frozen-contract (Swagger 2.0) types — only the members the walker reads.
// ---------------------------------------------------------------------------

export interface Swagger2Schema {
  $ref?: string;
  type?: string;
  format?: string;
  description?: string;
  items?: Swagger2Schema;
  properties?: Record<string, Swagger2Schema>;
  additionalProperties?: Swagger2Schema;
  required?: string[];
}

export interface Swagger2Response {
  $ref?: string;
  description?: string;
  schema?: Swagger2Schema;
  headers?: Record<string, Swagger2Schema>;
}

export interface Swagger2Parameter {
  name: string;
  in: string;
  type?: string;
}

export type Swagger2Method = "get" | "put" | "post" | "delete" | "options" | "head" | "patch";

export interface Swagger2Operation {
  operationId?: string;
  summary?: string;
  tags?: string[];
  parameters?: Swagger2Parameter[];
  responses?: Record<string, Swagger2Response>;
}

export type Swagger2PathItem = Partial<Record<Swagger2Method, Swagger2Operation>>;

export interface Swagger2Spec {
  swagger?: string;
  basePath?: string;
  paths: Record<string, Swagger2PathItem>;
  definitions: Record<string, Swagger2Schema>;
  responses?: Record<string, Swagger2Response>;
}

// ---------------------------------------------------------------------------
// Fixture record types (the committed JSON's shape).
// ---------------------------------------------------------------------------

/** Swagger primitive field types, plus "any" for untyped contract fields. */
export type FieldType = "string" | "integer" | "number" | "boolean" | "object" | "array" | "file" | "any";

/**
 * One top-level body field of a response model. Array/map element models are
 * referenced by name (`itemRef`/`mapValueRef`) instead of being inlined —
 * the element's own fields are available under the same `modelRef` in the
 * definitions the suite resolves against the contract.
 */
export interface FieldExpectation {
  name: string;
  /** Swagger type; "object" for `$ref` properties; "any" when untyped. */
  type: FieldType;
  /** Declared in the model's `required` list (all false today — the contract declares no required fields on response models). */
  required: boolean;
  /** Swagger format (int64, date-time, ...). */
  format?: string;
  /** Definition name when the property itself is a `$ref`. */
  ref?: string;
  /** Array element primitive type (when not a `$ref`). */
  itemType?: FieldType;
  /** Definition name of array elements. */
  itemRef?: string;
  /** Value type of an `additionalProperties` map. */
  mapValueType?: FieldType;
  /** Definition name of an `additionalProperties` map's values. */
  mapValueRef?: string;
}

/**
 * Normalized shape kind of one response body.
 *  - model:        a named `#/definitions/<Model>` object (modelRef set)
 *  - model-array:  an array of one named model (modelRef = element model)
 *  - model-map:    an `additionalProperties` map (fields empty)
 *  - inline-object: an inline object schema (e.g. /users/search {data, ok})
 *  - string:       a plain JSON string body (markdown render, string)
 *  - binary:       a raw byte stream (type: file — raw/media downloads)
 *  - error-body:   the {message,url} APIError body (header-converted)
 *  - empty:        no body (204/404/405/409 empty family)
 */
export type ResponseKind =
  | "model"
  | "model-array"
  | "model-map"
  | "inline-object"
  | "string"
  | "binary"
  | "error-body"
  | "empty";

/** Normalized expectation for one status code of one operation. */
export interface ResponseExpectation {
  kind: ResponseKind;
  /**
   * `#/definitions` name the status resolves to (the element model for
   * `model-array`). For header-converted error bodies this names the upstream
   * Go struct (gitea/services/context/api.go) instead — those have no
   * definition entry. Null when inline or absent.
   */
  modelRef: string | null;
  /** Top-level body fields (element fields for `model-array`); [] when none. */
  fields: FieldExpectation[];
  /** Value type of a `model-map` body. */
  mapValueType?: FieldType;
  /**
   * True when the contract declared these fields as response HEADERS
   * (SPEC-0004 §2.5 quirk) and they were converted to body expectations.
   */
  convertedFromHeader?: boolean;
  /** Pagination header family the CONTRACT declares on this response (CommitList/ChangedFileList). */
  declaredHeaders?: string[];
}

/** Runtime pagination exceptions for one list operation (SPEC-0004 §2.5). */
export interface PaginationExpectation {
  pageParam: "page";
  sizeParam: "limit" | "per_page";
  /** Headers upstream sends at runtime but the swagger does not declare. */
  runtimeHeaders: ("Link" | "X-Total-Count")[];
}

/** Normalized expectation record for one tier-1 operation. */
export interface OperationFixture {
  path: string;
  method: Swagger2Method;
  operationId: string;
  pagination?: PaginationExpectation;
  /** Status code (ascending) → expectation. */
  responses: Record<string, ResponseExpectation>;
}

/** The committed `tier1-fixtures.json` document. */
export interface Tier1FixtureFile {
  meta: {
    generator: string;
    contract: string;
    tier1Source: string;
    counts: { paths: number; operations: number };
    conventions: {
      errorBody: string;
      emptyBody: string;
      pagination: string;
    };
  };
  operations: OperationFixture[];
}

/** One appendix-A tier-1 row: contract path and its tier-1 methods. */
export interface Tier1Entry {
  path: string;
  methods: Swagger2Method[];
}

// ---------------------------------------------------------------------------
// Contract quirk tables (SPEC-0004 §2.5).
// ---------------------------------------------------------------------------

/**
 * Error-family responses the contract declares as HEADERS. Values name the
 * upstream Go struct (gitea/services/context/api.go) the fields belong to;
 * the runtime body is that struct's JSON. Field shapes are derived from the
 * declared headers at generation time, not hardcoded.
 */
const HEADER_ERROR_RESPONSES: Record<string, string> = {
  error: "APIError",
  forbidden: "APIForbiddenError",
  unauthorized: "APIUnauthorizedError",
  validationError: "APIValidationError",
  repoArchivedError: "APIRepoArchivedError",
  invalidTopicsError: "APIInvalidTopicsError",
};

/** Bodyless response names (SPEC-0004 §2.5: 204-style empty on 404/405/409). */
const EMPTY_RESPONSES = new Set(["notFound", "empty", "conflict"]);

/** Runtime list headers upstream sends on every paginated list (§2.5). */
const RUNTIME_LIST_HEADERS: ("Link" | "X-Total-Count")[] = ["Link", "X-Total-Count"];

/** Methods that can carry an operation in a Swagger 2.0 paths object. */
const HTTP_METHODS: readonly Swagger2Method[] = ["get", "put", "post", "delete", "options", "head", "patch"];

// ---------------------------------------------------------------------------
// SPEC-0004 appendix A parsing (same rule as scripts/check-openapi.mjs).
// ---------------------------------------------------------------------------

/**
 * Parse the tier-1 rows (`| T1 |`) of SPEC-0004 appendix A into entries, in
 * document order. Exported so tests can re-derive the table and fail on
 * SPEC/fixture drift.
 */
export function parseTier1Table(markdown: string): Tier1Entry[] {
  const entries: Tier1Entry[] = [];
  for (const line of markdown.split("\n")) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*([A-Z, ]+?)\s*\|\s*[a-z]\s*\|\s*T1\s*\|$/u.exec(line);
    if (match === null) {
      continue;
    }
    const [, contractPath, methods] = match;
    if (contractPath === undefined || methods === undefined) {
      continue;
    }
    entries.push({
      path: contractPath,
      methods: methods
        .split(",")
        .map((method) => method.trim().toLowerCase())
        .filter((method): method is Swagger2Method => (HTTP_METHODS as readonly string[]).includes(method)),
    });
  }
  return entries;
}

/** The tier-1 table, parsed from the SPEC text imported at module load. */
export function specTier1Table(): Tier1Entry[] {
  return parseTier1Table(tier1SpecMarkdown);
}

// ---------------------------------------------------------------------------
// Contract parsing helpers.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSwagger2Spec(value: unknown): value is Swagger2Spec {
  return isRecord(value) && isRecord(value.paths) && isRecord(value.definitions);
}

function isTier1FixtureFile(value: unknown): value is Tier1FixtureFile {
  return (
    isRecord(value) &&
    isRecord(value.meta) &&
    Array.isArray(value.operations) &&
    value.operations.every(isOperationFixture)
  );
}

/**
 * Parse and structurally validate the frozen contract JSON. The full schema
 * is not validated — the contract is a frozen, verbatim artifact; only the
 * members the walker reads are checked, so the narrowing predicate above is
 * honest about them.
 */
export function parseSwagger2Contract(raw: string): Swagger2Spec {
  const parsed: unknown = JSON.parse(raw);
  if (!isSwagger2Spec(parsed)) {
    throw new Error("contract JSON is not a Swagger 2.0 document (paths/definitions missing)");
  }
  return parsed;
}

/** Parse and structurally validate a `tier1-fixtures.json` document. */
export function parseTier1Fixtures(raw: string): Tier1FixtureFile {
  const parsed: unknown = JSON.parse(raw);
  if (!isTier1FixtureFile(parsed)) {
    throw new Error("tier1-fixtures.json does not match the Tier1FixtureFile shape");
  }
  return parsed;
}

function isOperationFixture(value: unknown): value is OperationFixture {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.path === "string" &&
    typeof value.method === "string" &&
    typeof value.operationId === "string" &&
    isRecord(value.responses) &&
    Object.values(value.responses).every(
      (response) => isRecord(response) && typeof response.kind === "string" && Array.isArray(response.fields),
    )
  );
}

// ---------------------------------------------------------------------------
// The generator.
// ---------------------------------------------------------------------------

/** Resolved (one level) view of a response, keeping its `#/responses` name. */
interface ResolvedResponse {
  name: string | null;
  response: Swagger2Response;
}

/**
 * Generate the tier-1 fixture file from the frozen contract.
 *
 * Pure: same contract → same records, no I/O. The tier-1 operation list is
 * parsed from the SPEC-0004 appendix (module-level `?raw` import). Throws if
 * the contract is missing a tier-1 path/method — that is contract drift and
 * must fail generation loudly.
 */
export function generateTier1Fixtures(contract: Swagger2Spec): Tier1FixtureFile {
  const tier1 = specTier1Table();
  const operations: OperationFixture[] = [];

  for (const entry of tier1) {
    const pathItem = contract.paths[entry.path];
    if (pathItem === undefined) {
      throw new Error(`tier-1 path ${entry.path} (SPEC-0004 appendix A) is missing from the frozen contract`);
    }
    for (const method of entry.methods) {
      const operation = pathItem[method];
      if (operation === undefined) {
        throw new Error(`tier-1 operation ${method.toUpperCase()} ${entry.path} is missing from the frozen contract`);
      }
      operations.push(generateOperationFixture(contract, entry.path, method, operation));
    }
  }

  const paths = new Set(operations.map((operation) => operation.path));
  return {
    meta: {
      generator: FIXTURE_INPUTS.generator,
      contract: FIXTURE_INPUTS.contract,
      tier1Source: FIXTURE_INPUTS.tier1Source,
      counts: { paths: paths.size, operations: operations.length },
      conventions: {
        errorBody:
          "error/forbidden/unauthorized/validationError/repoArchivedError/invalidTopicsError are declared as response HEADERS in the swagger; converted to body fields (convertedFromHeader: true) per SPEC-0004 §2.5",
        emptyBody:
          "notFound/empty/conflict responses and inline description-only responses carry no body (kind: empty)",
        pagination:
          "pagination records the runtime Link/X-Total-Count exception for list operations; declaredHeaders carries the X-* family the contract itself declares (CommitList/ChangedFileList)",
      },
    },
    operations,
  };
}

function generateOperationFixture(
  contract: Swagger2Spec,
  path: string,
  method: Swagger2Method,
  operation: Swagger2Operation,
): OperationFixture {
  const responses: Record<string, ResponseExpectation> = {};
  const statuses = Object.keys(operation.responses ?? {}).sort((a, b) => Number(a) - Number(b));
  for (const status of statuses) {
    const declared = operation.responses?.[status];
    if (declared === undefined) {
      continue;
    }
    responses[status] = generateResponseExpectation(contract, path, method, status, declared);
  }

  return {
    path,
    method,
    operationId: operation.operationId ?? "",
    pagination: generatePaginationExpectation(operation),
    responses,
  };
}

function generatePaginationExpectation(operation: Swagger2Operation): PaginationExpectation | undefined {
  const queryNames = new Set(
    (operation.parameters ?? []).filter((parameter) => parameter.in === "query").map((parameter) => parameter.name),
  );
  if (!queryNames.has("page")) {
    return undefined;
  }
  const sizeParam = queryNames.has("per_page") ? "per_page" : queryNames.has("limit") ? "limit" : undefined;
  if (sizeParam === undefined) {
    return undefined;
  }
  return { pageParam: "page", sizeParam, runtimeHeaders: RUNTIME_LIST_HEADERS };
}

function resolveResponse(contract: Swagger2Spec, declared: Swagger2Response, context: string): ResolvedResponse {
  if (declared.$ref === undefined) {
    return { name: null, response: declared };
  }
  const name = responseRefName(declared.$ref, context);
  const target = contract.responses?.[name];
  if (target === undefined) {
    throw new Error(`${context}: response $ref "#/responses/${name}" does not resolve in the frozen contract`);
  }
  return { name, response: target };
}

function responseRefName(ref: string, context: string): string {
  const prefix = "#/responses/";
  if (!ref.startsWith(prefix)) {
    throw new Error(`${context}: unsupported response $ref "${ref}" (expected #/responses/<Name>)`);
  }
  return ref.slice(prefix.length);
}

function generateResponseExpectation(
  contract: Swagger2Spec,
  path: string,
  method: Swagger2Method,
  status: string,
  declared: Swagger2Response,
): ResponseExpectation {
  const context = `${method.toUpperCase()} ${path} ${status}`;
  const { name, response } = resolveResponse(contract, declared, context);

  // Quirk 1: the error family declares its runtime JSON body as headers
  // (swagger-go artifact) — convert to body-field expectations.
  if (name !== null && name in HEADER_ERROR_RESPONSES) {
    return generateHeaderErrorExpectation(name, response, context);
  }

  // Quirk 2: bodyless family and inline description-only responses.
  if (response.schema === undefined) {
    if (response.headers !== undefined) {
      // A header-only response outside the known error family would need its
      // own documented conversion — never silently skipped (SPEC-0004 §4).
      throw new Error(
        `${context}: header-only response${name === null ? "" : ` "${name}"`} is outside the documented error family — add it to HEADER_ERROR_RESPONSES with a SPEC note`,
      );
    }
    if (name !== null && !EMPTY_RESPONSES.has(name)) {
      throw new Error(`${context}: schema-less response "${name}" is not in EMPTY_RESPONSES — classify it explicitly`);
    }
    return { kind: "empty", modelRef: null, fields: [] };
  }

  const schema = response.schema;
  // Quirk 3: the X-* pagination header family the contract itself declares.
  const declaredHeaders = Object.keys(response.headers ?? {}).sort();
  const expectation: ResponseExpectation = generateSchemaExpectation(contract, schema, context);
  if (declaredHeaders.length > 0) {
    expectation.declaredHeaders = declaredHeaders;
  }
  return expectation;
}

function generateHeaderErrorExpectation(name: string, response: Swagger2Response, context: string): ResponseExpectation {
  const headers = response.headers ?? {};
  // Swagger headers carry no `required` concept; the upstream Go structs
  // (gitea/services/context/api.go) marshal these fields unconditionally, so
  // the converted body fields are recorded as required (key always present —
  // invalidTopics serializes as null when there are no invalid topics).
  const fields = Object.entries(headers).map(([fieldName, schema]) => fieldFromSchema(fieldName, schema, true, context));
  const structName = HEADER_ERROR_RESPONSES[name];
  if (structName === undefined) {
    throw new Error(`${context}: "${name}" is not a documented header-error response`);
  }
  return {
    kind: "error-body",
    modelRef: structName,
    fields,
    convertedFromHeader: true,
  };
}

function generateSchemaExpectation(
  contract: Swagger2Spec,
  schema: Swagger2Schema,
  context: string,
): ResponseExpectation {
  // A plain string body: #/responses/string, MarkdownRender.
  if (schema.type === "string") {
    return { kind: "string", modelRef: null, fields: [] };
  }
  // A raw byte stream (type: file): raw/media downloads.
  if (schema.type === "file") {
    return { kind: "binary", modelRef: null, fields: [] };
  }
  // A named model.
  if (schema.$ref !== undefined) {
    const modelRef = definitionRefName(schema.$ref, context);
    const definition = contract.definitions[modelRef];
    if (definition === undefined) {
      throw new Error(`${context}: definition $ref "#/definitions/${modelRef}" does not resolve in the frozen contract`);
    }
    return { kind: "model", modelRef, fields: fieldsOfDefinition(definition, modelRef, context) };
  }
  // An array of one named model (the list responses).
  if (schema.type === "array") {
    const items = schema.items;
    if (items !== undefined && items.$ref !== undefined) {
      const modelRef = definitionRefName(items.$ref, context);
      const definition = contract.definitions[modelRef];
      if (definition === undefined) {
        throw new Error(
          `${context}: element definition $ref "#/definitions/${modelRef}" does not resolve in the frozen contract`,
        );
      }
      return { kind: "model-array", modelRef, fields: fieldsOfDefinition(definition, modelRef, context) };
    }
    throw new Error(`${context}: array response without a named element model — classify it explicitly`);
  }
  // An additionalProperties map (LanguageStatistics).
  if (schema.type === "object" && schema.additionalProperties !== undefined) {
    return {
      kind: "model-map",
      modelRef: null,
      fields: [],
      mapValueType: (schema.additionalProperties.type as FieldType | undefined) ?? "any",
    };
  }
  // An inline object (e.g. /users/search → {data, ok}).
  if (schema.type === "object") {
    const required = schema.required ?? [];
    const fields = Object.entries(schema.properties ?? {}).map(([name, property]) =>
      fieldFromSchema(name, property, required.includes(name), context),
    );
    return { kind: "inline-object", modelRef: null, fields };
  }
  throw new Error(`${context}: unrecognized response schema ${JSON.stringify(schema)} — classify it explicitly`);
}

/** Flatten one `#/definitions` model into its top-level field expectations. */
function fieldsOfDefinition(definition: Swagger2Schema, modelRef: string, context: string): FieldExpectation[] {
  const required = definition.required ?? [];
  return Object.entries(definition.properties ?? {}).map(([name, property]) =>
    fieldFromSchema(name, property, required.includes(name), `${context} (${modelRef}.${name})`),
  );
}

function fieldFromSchema(name: string, schema: Swagger2Schema, required: boolean, context: string): FieldExpectation {
  const field: FieldExpectation = {
    name,
    type: "any",
    required,
  };
  if (schema.$ref !== undefined) {
    // A $ref property is a nested model reference.
    field.type = "object";
    field.ref = definitionRefName(schema.$ref, context);
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
        field.itemRef = definitionRefName(items.$ref, context);
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
        field.mapValueRef = definitionRefName(schema.additionalProperties.$ref, context);
      }
    }
    return field;
  }
  if (schema.type !== undefined) {
    field.type = schema.type as FieldType;
  }
  return field;
}

function definitionRefName(ref: string, context: string): string {
  const prefix = "#/definitions/";
  if (!ref.startsWith(prefix)) {
    throw new Error(`${context}: unsupported definition $ref "${ref}" (expected #/definitions/<Name>)`);
  }
  return ref.slice(prefix.length);
}
