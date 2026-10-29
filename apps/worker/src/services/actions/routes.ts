/**
 * The /api/actions connect-RPC mount (SPEC-0012 §2.1/§2.2, M1a): the
 * PingService echo + the RunnerService procedures. Upstream mounts
 * connect handlers under `/<service-name>/` after the /api/actions prefix
 * (actions.go:22-26), so the wire paths are
 *
 *   POST /api/actions/ping.v1.PingService/Ping
 *   POST /api/actions/runner.v1.RunnerService/Register   (no auth)
 *   POST /api/actions/runner.v1.RunnerService/{Method}   (runner auth)
 *
 * Protocol: connect unary. `application/proto` (the codec act_runner uses)
 * and `application/json` (protojson spelling) are both answered; any other
 * content-type answers 415 per the connect spec. The gRPC and gRPC-Web
 * protocol variants are not implemented (unary act_runner traffic is
 * connect; documented divergence, proto/WIRE-FREEZE.md).
 *
 * The interceptor (interceptor.go:36-107): every RunnerService procedure
 * except Register requires `x-runner-uuid` + `x-runner-token`; the token is
 * verified constant-time against the salted digest; heartbeats are
 * debounced (last_online 30 s, last_active 5 s and only on the Update*
 * family — the "major source of DB load" rule). Plain errors reach runners
 * as connect CodeUnknown with their message (withErrorMessages).
 * UpdateTask/UpdateLog are M1b: they authenticate, then answer
 * `unimplemented`.
 */

import { Hono } from "hono";
import type { MiddlewareHandler, Context } from "hono";

import {
  declareRunner,
  registerRunner,
  RUNNER_CAPABILITIES,
  X_GITEA_ACTIONS_CAPABILITIES_HEADER,
} from "./register";
import { fetchTask } from "./dispatch";
import {
  getRunnerByUUID,
  shouldPersistLastActive,
  shouldPersistLastOnline,
  updateRunner,
  verifyRunnerToken,
  type RunnerRow,
} from "./model";
import {
  decodeDeclareRequest,
  decodeFetchTaskRequest,
  decodePingRequest,
  decodeRegisterRequest,
  encodeDeclareResponse,
  encodeFetchTaskResponse,
  encodePingResponse,
  encodeRegisterResponse,
  type DeclareRequest,
  type FetchTaskRequest,
  type PingRequest,
  type RegisterRequest,
} from "./wire";

export const RUNNER_SERVICE_NAME = "runner.v1.RunnerService";
export const PING_SERVICE_NAME = "ping.v1.PingService";

export const UUID_HEADER = "x-runner-uuid";
export const TOKEN_HEADER = "x-runner-token";

/** The connect error codes (the spec's unary table keys). */
type ConnectCode =
  | "canceled"
  | "unknown"
  | "invalid_argument"
  | "deadline_exceeded"
  | "not_found"
  | "already_exists"
  | "permission_denied"
  | "resource_exhausted"
  | "failed_precondition"
  | "aborted"
  | "out_of_range"
  | "unimplemented"
  | "internal"
  | "unavailable"
  | "data_loss"
  | "unauthenticated";

/** connect codes → HTTP status (the connect unary protocol table; raw
 *  Response construction — 499 is not in Hono's status union). */
const CONNECT_HTTP_STATUS: Record<ConnectCode, number> = {
  canceled: 499,
  unknown: 500,
  invalid_argument: 400,
  deadline_exceeded: 504,
  not_found: 404,
  already_exists: 409,
  permission_denied: 403,
  resource_exhausted: 429,
  failed_precondition: 400,
  aborted: 409,
  out_of_range: 400,
  unimplemented: 501,
  internal: 500,
  unavailable: 503,
  data_loss: 500,
  unauthenticated: 401,
};

/** A connect protocol error — thrown by handlers, answered as the JSON
 *  error body {code, message} with the mapped HTTP status. */
export class ConnectError extends Error {
  constructor(
    public readonly code: ConnectCode,
    message: string,
  ) {
    super(message);
  }
}

interface Codec {
  contentType: string;
  isJson: boolean;
}

function negotiate(request: Request): Codec {
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (contentType === "application/proto") {
    return { contentType: "application/proto", isJson: false };
  }
  if (contentType === "application/json") {
    return { contentType: "application/json", isJson: true };
  }
  // The connect spec: unary procedures reject an unrecognized Content-Type
  // with HTTP 415 (the error body is informational).
  throw new UnsupportedContentTypeError(`unsupported content-type: ${contentType || "(none)"}`);
}

/** Thrown by negotiate — answered 415 with the connect JSON error shape. */
class UnsupportedContentTypeError extends Error {}

/**
 * The per-procedure plumbing: negotiate the codec, decode the request,
 * invoke the typed handler, encode the response. Plain handler errors map
 * to CodeUnknown with their message (withErrorMessages).
 */
function procedure<Req, Res>(
  decode: (bytes: Uint8Array) => Req,
  encode: (value: Res) => Uint8Array,
  handler: (input: Req, c: Context<{ Bindings: Env; Variables: ActionsVars }>) => Promise<Res> | Res,
  headers?: (res: Res, c: Context<{ Bindings: Env; Variables: ActionsVars }>) => Record<string, string>,
): MiddlewareHandler<{ Bindings: Env; Variables: ActionsVars }> {
  return async (c) => {
    let codec: Codec;
    try {
      codec = negotiate(c.req.raw);
    } catch (err) {
      return connectError(c, err);
    }
    let input: Req;
    try {
      const body = new Uint8Array(await c.req.arrayBuffer());
      input = codec.isJson ? decodeJsonRequest(codec, body, decode) : decode(body);
    } catch (err) {
      return connectError(
        c,
        new ConnectError("invalid_argument", `failed to decode request: ${String(err)}`),
      );
    }
    try {
      const output = await handler(input, c);
      const responseHeaders: Record<string, string> = { "content-type": codec.contentType };
      if (headers !== undefined) {
        Object.assign(responseHeaders, headers(output, c));
      }
      const body = codec.isJson
        ? new TextEncoder().encode(JSON.stringify(encodeJsonResponse(output, encode)))
        : encode(output);
      return c.body(toArrayBuffer(body), 200, responseHeaders);
    } catch (err) {
      return connectError(c, err);
    }
  };
}

/** Hono's Data takes ArrayBuffer — copy the encoded bytes into one (no
 *  views over possibly-shared buffers). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/**
 * JSON request/response paths: M1a's codec is proto-only (the ratified
 * hand-rolled freeze covers what act_runner speaks — application/proto);
 * a JSON connect request answers `unimplemented` per the connect spec.
 * Revisit only if a consumer needs the JSON variant (the freeze note
 * records the decision).
 */
function decodeJsonRequest<Req>(
  _codec: Codec,
  _body: Uint8Array,
  _decode: (bytes: Uint8Array) => Req,
): Req {
  throw new ConnectError("unimplemented", "application/json is not implemented (proto-only codec)");
}

function encodeJsonResponse<Res>(_value: Res, _encode: (value: Res) => Uint8Array): string {
  throw new ConnectError("unimplemented", "application/json is not implemented (proto-only codec)");
}

function connectError(_c: Context<{ Bindings: Env; Variables: ActionsVars }>, err: unknown): Response {
  // Raw Response (not c.json): the connect table's 499 (canceled) is not in
  // Hono's ContentfulStatusCode union, and the error body shape is fixed
  // anyway.
  const headers = { "content-type": "application/json" };
  if (err instanceof UnsupportedContentTypeError) {
    return new Response(JSON.stringify({ code: "internal", message: err.message }), {
      status: 415,
      headers,
    });
  }
  if (err instanceof ConnectError) {
    const status = CONNECT_HTTP_STATUS[err.code] ?? 500;
    return new Response(JSON.stringify({ code: err.code, message: err.message }), { status, headers });
  }
  // withErrorMessages (interceptor.go:36-44): plain errors reach runners as
  // CodeUnknown with their message.
  const message = err instanceof Error ? err.message : String(err);
  return new Response(JSON.stringify({ code: "unknown", message }), { status: 500, headers });
}

/** The interceptor's stash: the authenticated runner row. */
interface ActionsVars {
  actionsRunner: RunnerRow;
}

/**
 * withRunner (interceptor.go:46-113): uuid + token auth, debounced
 * heartbeats, the runner stashed for the handler. Register skips this
 * (separate route).
 */
function withRunner(): MiddlewareHandler<{ Bindings: Env; Variables: ActionsVars }> {
  return async (c, next) => {
    const methodName = c.req.path.split("/").pop() ?? "";
    const uuid = c.req.header(UUID_HEADER) ?? "";
    const token = c.req.header(TOKEN_HEADER) ?? "";

    const runner = await getRunnerByUUID(c.env.DB, uuid);
    if (runner === null) {
      throw new ConnectError("unauthenticated", "unregistered runner");
    }
    if (!(await verifyRunnerToken(runner.tokenHash, runner.tokenSalt, token))) {
      throw new ConnectError("unauthenticated", "unregistered runner");
    }

    // Debounced heartbeats (interceptor.go:72-84): writing on every poll is
    // a major source of DB load — persist only when stale enough to affect
    // the online/active status.
    const now = new Date();
    const cols: Parameters<typeof updateRunner>[2] = {};
    if ((methodName === "UpdateTask" || methodName === "UpdateLog") &&
      shouldPersistLastActive(runner.lastActive, now)) {
      cols.lastActive = now;
    }
    if (shouldPersistLastOnline(runner.lastOnline, now)) {
      cols.lastOnline = now;
    }
    if (cols.lastActive !== undefined || cols.lastOnline !== undefined) {
      await updateRunner(c.env.DB, runner.id, cols);
    }

    c.set("actionsRunner", runner);
    await next();
  };
}

function runnerOf(c: Context<{ Bindings: Env; Variables: ActionsVars }>): RunnerRow {
  return c.get("actionsRunner");
}

/** Hono context → setting.AppURL analog: the request origin (+ trailing
 *  slash, upstream AppURL always carries one). */
function appUrlOf(c: Context): string {
  return new URL(c.req.url).origin + "/";
}

export function createActionsRouter(): Hono<{ Bindings: Env; Variables: ActionsVars }> {
  const r = new Hono<{ Bindings: Env; Variables: ActionsVars }>();

  // Connect errors thrown from middleware (the interceptor) land here —
  // Hono's default onError would answer a plain-text 500, not the connect
  // JSON error body.
  r.onError((err, c) => connectError(c, err));

  // -- ping.v1.PingService (ping/ping.go:31-42) -----------------------------
  r.post(
    `/${PING_SERVICE_NAME}/Ping`,
    procedure(
      decodePingRequest,
      encodePingResponse,
      (req: PingRequest) => ({ data: `Hello, ${req.data}!` }),
      undefined,
    ),
  );

  // -- runner.v1.RunnerService ----------------------------------------------

  // Register: the ONE unauthenticated procedure (interceptor.go:53-55).
  r.post(
    `/${RUNNER_SERVICE_NAME}/Register`,
    procedure(
      decodeRegisterRequest,
      encodeRegisterResponse,
      async (req: RegisterRequest, c) => {
        const outcome = await registerRunner(c.env.DB, {
          name: req.name,
          token: req.token,
          version: req.version,
          labels: req.labels,
          ephemeral: req.ephemeral,
          capabilities: req.capabilities,
        });
        if (outcome.kind === "error") {
          throw new Error(outcome.message);
        }
        return {
          runner: {
            id: outcome.runner.id,
            uuid: outcome.runner.uuid,
            token: outcome.runner.token,
            name: outcome.runner.name,
            status: 0,
            agentLabels: parseLabels(outcome.runner.agentLabels),
            customLabels: [],
            version: outcome.runner.version,
            labels: parseLabels(outcome.runner.agentLabels),
            ephemeral: outcome.runner.ephemeral,
          },
        };
      },
      undefined,
    ),
  );

  // Declare + FetchTask behind the interceptor.
  r.post(
    `/${RUNNER_SERVICE_NAME}/Declare`,
    withRunner(),
    procedure(
      decodeDeclareRequest,
      encodeDeclareResponse,
      async (req: DeclareRequest, c) => {
        const runner = runnerOf(c);
        const updated = await declareRunner(c.env.DB, runner, {
          version: req.version,
          labels: req.labels,
          capabilities: req.capabilities,
        });
        return {
          runner: {
            id: updated.id,
            uuid: updated.uuid,
            token: "", // upstream's model struct carries no plaintext here
            name: updated.name,
            status: 0,
            agentLabels: parseLabels(updated.agentLabels),
            customLabels: [],
            version: updated.version,
            labels: parseLabels(updated.agentLabels),
            ephemeral: updated.ephemeral,
          },
        };
      },
      // The capabilities header (runner.go:151-154).
      () => ({ [X_GITEA_ACTIONS_CAPABILITIES_HEADER]: RUNNER_CAPABILITIES }),
    ),
  );

  r.post(
    `/${RUNNER_SERVICE_NAME}/FetchTask`,
    withRunner(),
    procedure(
      decodeFetchTaskRequest,
      encodeFetchTaskResponse,
      async (req: FetchTaskRequest, c) => {
        const runner = runnerOf(c);
        const result = await fetchTask(c.env.DB, runner, req.tasksVersion, appUrlOf(c));
        return {
          task: result.task,
          tasksVersion: result.tasksVersion,
        };
      },
      undefined,
    ),
  );

  // UpdateTask / UpdateLog authenticate, then answer unimplemented (M1b,
  // SPEC §7) — the interceptor still runs (heartbeats included).
  for (const method of ["UpdateTask", "UpdateLog"]) {
    r.post(`/${RUNNER_SERVICE_NAME}/${method}`, withRunner(), (c) =>
      c.json({ code: "unimplemented", message: "UpdateTask lands with SPEC-0012 M1b" }, 501, {
        "content-type": "application/json",
      }),
    );
  }

  return r;
}

/** The agent_labels TEXT column is a JSON array. */
function parseLabels(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
