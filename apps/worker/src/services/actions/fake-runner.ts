/**
 * The fake-runner harness (SPEC-0012 §6.2, M1a slice): a Node/fetch client
 * speaking the REAL routes over the connect protocol — the standing oracle
 * for the runner protocol. The ratified posture: this harness IS the E2E
 * (a real act_runner binary gates releases manually, M2 docs material).
 *
 * M1a covers the register → declare → fetch loop:
 *   ping → register (with a minted registration token) → declare →
 *   FetchTask poll (with a tasks_version cache, act_runner's semantics).
 * M1b grows it to the full lifecycle (UpdateLog/UpdateTask, artifacts,
 * summaries, OIDC).
 *
 * Every call goes over HTTP as `application/proto` — the harness never
 * imports the server's service layer, only the frozen wire codecs (the same
 * contract fixtures both sides compile against).
 */

import {
  decodeDeclareResponse,
  decodeFetchTaskResponse,
  decodePingResponse,
  decodeRegisterResponse,
  encodeDeclareRequest,
  encodeFetchTaskRequest,
  encodePingRequest,
  encodeRegisterRequest,
  type DeclareRequest,
  type DeclareResponse,
  type FetchTaskRequest,
  type FetchTaskResponse,
  type PingRequest,
  type PingResponse,
  type RegisterRequest,
  type RegisterResponse,
} from "./wire";

export const RUNNER_SERVICE_NAME = "runner.v1.RunnerService";
export const PING_SERVICE_NAME = "ping.v1.PingService";

export const UUID_HEADER = "x-runner-uuid";
export const TOKEN_HEADER = "x-runner-token";

/** The error a runner sees from a connect JSON error body. */
export class RunnerProtocolError extends Error {
  constructor(
    public readonly code: string,
    /** The RAW connect error message (Error.message spells the prefixed
     *  diagnostic form for stacks; tests assert this field). */
    public override readonly message: string,
    public readonly httpStatus: number,
  ) {
    super(`connect ${code}: ${message}`);
  }
}

export interface FakeRunnerOptions {
  /** The base URL of the worker under test. */
  baseUrl: string;
  /** Injectable transport (tests pass SELF.fetch's bound spelling). */
  fetch?: typeof fetch;
}

export interface RegisterOptions {
  token: string;
  name: string;
  version?: string;
  labels?: string[];
  ephemeral?: boolean;
  capabilities?: string[];
}

/**
 * The runner-side session: credentials after Register, the tasks_version
 * cache maintained with act_runner's poll semantics.
 */
export class FakeRunner {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  /** The registered runner identity (undefined until register succeeds). */
  runner: RegisterResponse["runner"];
  /** The X-Gitea-Actions-Capabilities header observed on Declare. */
  serverCapabilities: string | null = null;
  /** act_runner's cached tasks_version — poll() keeps it in lockstep. */
  tasksVersion = 0;

  constructor(options: FakeRunnerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async call<Req, Res>(
    service: string,
    method: string,
    encodeRequest: (value: Req) => Uint8Array,
    decodeResponse: (bytes: Uint8Array) => Res,
    request: Req,
    headers: Record<string, string> = {},
  ): Promise<{ response: Res; responseHeaders: Headers }> {
    const httpResponse = await this.fetchImpl(`${this.baseUrl}/api/actions/${service}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/proto", ...headers },
      body: encodeRequest(request),
    });
    if (httpResponse.status !== 200) {
      let code = "unknown";
      let message = `HTTP ${httpResponse.status}`;
      try {
        const errBody = await httpResponse.json<{ code?: string; message?: string }>();
        code = errBody.code ?? code;
        message = errBody.message ?? message;
      } catch {
        // Non-JSON error body — keep the HTTP-status spelling.
      }
      throw new RunnerProtocolError(code, message, httpResponse.status);
    }
    const bytes = new Uint8Array(await httpResponse.arrayBuffer());
    return { response: decodeResponse(bytes), responseHeaders: httpResponse.headers };
  }

  /** PingService.Ping — the connectivity probe. */
  async ping(data: string): Promise<string> {
    const request: PingRequest = { data };
    const { response } = await this.call<PingRequest, PingResponse>(
      PING_SERVICE_NAME,
      "Ping",
      encodePingRequest,
      decodePingResponse,
      request,
    );
    return response.data;
  }

  /** RunnerService.Register — mints the session credentials. */
  async register(options: RegisterOptions): Promise<RegisterResponse["runner"]> {
    const request: RegisterRequest = {
      name: options.name,
      token: options.token,
      agentLabels: [],
      customLabels: [],
      version: options.version ?? "",
      labels: options.labels ?? [],
      ephemeral: options.ephemeral ?? false,
      capabilities: options.capabilities ?? [],
    };
    const { response } = await this.call<RegisterRequest, RegisterResponse>(
      RUNNER_SERVICE_NAME,
      "Register",
      encodeRegisterRequest,
      decodeRegisterResponse,
      request,
    );
    this.runner = response.runner;
    this.tasksVersion = 0; // a fresh runner starts at version 0
    return this.runner;
  }

  /** RunnerService.Declare — re-advertise labels/version/capabilities. */
  async declare(options: {
    version?: string;
    labels?: string[];
    capabilities?: string[];
  }): Promise<DeclareResponse["runner"]> {
    const request: DeclareRequest = {
      version: options.version ?? "",
      labels: options.labels ?? [],
      capabilities: options.capabilities ?? [],
    };
    const { response, responseHeaders } = await this.call<DeclareRequest, DeclareResponse>(
      RUNNER_SERVICE_NAME,
      "Declare",
      encodeDeclareRequest,
      decodeDeclareResponse,
      request,
      this.authHeaders(),
    );
    this.serverCapabilities = responseHeaders.get("x-gitea-actions-capabilities");
    return response.runner;
  }

  /**
   * One raw FetchTask call with an explicit tasks_version (the assertion
   * surface for the version-counter semantics).
   */
  async fetchTask(tasksVersion: number): Promise<FetchTaskResponse> {
    const request: FetchTaskRequest = { tasksVersion };
    const { response } = await this.call<FetchTaskRequest, FetchTaskResponse>(
      RUNNER_SERVICE_NAME,
      "FetchTask",
      encodeFetchTaskRequest,
      decodeFetchTaskResponse,
      request,
      this.authHeaders(),
    );
    return response;
  }

  /**
   * The act_runner poll loop, one iteration: send the cached version, adopt
   * the server's answer, return the task when claimed.
   */
  async poll(): Promise<FetchTaskResponse["task"]> {
    const response = await this.fetchTask(this.tasksVersion);
    this.tasksVersion = response.tasksVersion;
    return response.task;
  }

  private authHeaders(): Record<string, string> {
    if (this.runner === undefined) {
      throw new Error("fake-runner: not registered");
    }
    return { [UUID_HEADER]: this.runner.uuid, [TOKEN_HEADER]: this.runner.token };
  }
}
