/**
 * The fake-runner harness (SPEC-0012 §6.2, the standing E2E oracle): a
 * Node/fetch client speaking the REAL routes over the connect protocol.
 * The ratified posture: this harness IS the E2E (a real act_runner binary
 * gates releases manually, M2 docs material).
 *
 * M1a covered the register → declare → fetch loop. M1b grows it to the FULL
 * lifecycle (§6.2):
 *   - UpdateTask / UpdateLog over connect (with the ack/trim protocol in
 *     the runner's seat: the pending-row cache advanced by ackIndex),
 *   - artifacts v1 (create → chunk PUT with content-range+md5 → PATCH
 *     confirm → list → download_url → download) and v4 (create → block
 *     uploads → blocklist → finalize → list → signed URL → download),
 *   - job-summary upload (GITHUB_STEP_SUMMARY),
 *   - the OIDC exchange (request-token → /token).
 *
 * Every call goes over HTTP as `application/proto` — the harness never
 * imports the server's service layer, only the frozen wire codecs (the same
 * contract fixtures both sides compile against).
 */

import { Md5 } from "../packages/maven";
import {
  decodeDeclareResponse,
  decodeFetchTaskResponse,
  decodePingResponse,
  decodeRegisterResponse,
  decodeUpdateLogResponse,
  decodeUpdateTaskResponse,
  encodeDeclareRequest,
  encodeFetchTaskRequest,
  encodePingRequest,
  encodeRegisterRequest,
  encodeUpdateLogRequest,
  encodeUpdateTaskRequest,
  type DeclareRequest,
  type DeclareResponse,
  type FetchTaskRequest,
  type FetchTaskResponse,
  type LogRow,
  type PingRequest,
  type PingResponse,
  type RegisterRequest,
  type RegisterResponse,
  type StepState,
  type Task,
  type UpdateLogRequest,
  type UpdateLogResponse,
  type UpdateTaskRequest,
  type UpdateTaskResponse,
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

/** The runner's pending UpdateLog buffer: rows not yet acked by the server,
 *  indexed from the row the buffer STARTED at (the protocol's `index`). */
interface PendingLog {
  index: number;
  rows: LogRow[];
  finalized: boolean;
}

/**
 * The runner-side session: credentials after Register, the tasks_version
 * cache maintained with act_runner's poll semantics, the pending-log buffer
 * with act_runner's resend-on-low-ack behavior.
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
  /** The last claimed task (the report/log/artifact seat hangs off it). */
  lastTask: Task | undefined;
  private pendingLog: PendingLog = { index: 0, rows: [], finalized: false };

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
    if (response.task !== undefined) {
      this.lastTask = response.task;
      this.pendingLog = { index: 0, rows: [], finalized: false };
    }
    return response.task;
  }

  // -- UpdateTask (the report seat) -----------------------------------------

  /**
   * UpdateTask — a raw state report (the assertion surface for the
   * state-machine + outputs semantics; the response's state.result is the
   * TASK's status spelled as a result, sentOutputs the stored keys).
   * `reportedSteps` replaces the task's step rows (the runner-reported
   * layout arm).
   */
  async updateTask(
    state: { id: number; result: number; steps?: StepState[]; reportedSteps?: StepState[] },
    outputs: Record<string, string> = {},
    reportedSteps?: StepState[],
  ): Promise<UpdateTaskResponse> {
    const request: UpdateTaskRequest = {
      state: {
        id: state.id,
        result: state.result,
        startedAt: undefined,
        stoppedAt: undefined,
        steps: state.steps ?? [],
        reportedSteps: reportedSteps ?? state.reportedSteps ?? [],
      },
      outputs,
    };
    const { response } = await this.call<UpdateTaskRequest, UpdateTaskResponse>(
      RUNNER_SERVICE_NAME,
      "UpdateTask",
      encodeUpdateTaskRequest,
      decodeUpdateTaskResponse,
      request,
      this.authHeaders(),
    );
    return response;
  }

  // -- UpdateLog (the streaming seat) ---------------------------------------

  /** Buffer rows locally, exactly act_runner's log shipper. */
  writeLogRow(time: Date, content: string): void {
    if (this.pendingLog.finalized) {
      throw new Error("fake-runner: log already finalized");
    }
    this.pendingLog.rows.push({ time: { seconds: Math.floor(time.getTime() / 1000), nanos: 0 }, content });
  }

  /** Flush pending rows (+ optionally finalize). Returns the ackIndex. */
  async updateLog(noMore = false): Promise<UpdateLogResponse["ackIndex"]> {
    const task = this.lastTask;
    if (task === undefined) {
      throw new Error("fake-runner: no task claimed");
    }
    const request: UpdateLogRequest = {
      taskId: task.id,
      index: this.pendingLog.index,
      rows: this.pendingLog.rows,
      noMore,
    };
    const { response } = await this.call<UpdateLogRequest, UpdateLogResponse>(
      RUNNER_SERVICE_NAME,
      "UpdateLog",
      encodeUpdateLogRequest,
      decodeUpdateLogResponse,
      request,
      this.authHeaders(),
    );
    // act_runner's protocol: ackIndex counts rows FROM ZERO — rows the
    // server holds are trimmed on the next send (the runner drops them).
    const ack = response.ackIndex;
    const drop = ack - this.pendingLog.index;
    if (drop > 0) {
      this.pendingLog.rows = this.pendingLog.rows.slice(drop);
    }
    this.pendingLog.index = ack;
    if (noMore) {
      this.pendingLog.finalized = true;
    }
    return ack;
  }

  /** A raw UpdateLog send (the trim/gap/guard arms' assertion surface). */
  async updateLogRaw(taskId: number, index: number, rows: LogRow[], noMore: boolean): Promise<UpdateLogResponse> {
    const request: UpdateLogRequest = { taskId, index, rows, noMore };
    const { response } = await this.call<UpdateLogRequest, UpdateLogResponse>(
      RUNNER_SERVICE_NAME,
      "UpdateLog",
      encodeUpdateLogRequest,
      decodeUpdateLogResponse,
      request,
      this.authHeaders(),
    );
    return response;
  }

  /** The RAW UpdateLog HTTP response (the connect error arms' surface). */
  async rawUpdateLog(taskId: number, index: number, rows: LogRow[], noMore: boolean): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}/api/actions/${RUNNER_SERVICE_NAME}/UpdateLog`, {
      method: "POST",
      headers: { "content-type": "application/proto", ...this.authHeaders() },
      body: encodeUpdateLogRequest({ taskId, index, rows, noMore }),
    });
  }

  // -- the runtime-token seat (artifacts/summaries/OIDC) --------------------

  /** The gitea_runtime_token the claim context carried. */
  runtimeToken(): string {
    const context = this.lastTask?.context;
    const token = context?.["gitea_runtime_token"];
    if (typeof token !== "string" || token === "") {
      throw new Error("fake-runner: claim context carried no gitea_runtime_token");
    }
    return token;
  }

  /** Generic JSON/bytes request from the task's runtime-token seat. An
   *  absolute path (the artifact URLs the server minted) skips the base. */
  async runtimeRequest(
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: BodyInit },
  ): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    return this.fetchImpl(url, {
      method: init.method,
      headers: { authorization: `Bearer ${this.runtimeToken()}`, ...init.headers },
      body: init.body,
    });
  }

  /**
   * The artifacts-v1 round trip (act_runner's azure-pipeline client seat):
   * POST upload-url → PUT chunks (content-range + md5) → PATCH confirm.
   */
  async uploadArtifactV1(runId: number, name: string, content: Uint8Array, retentionDays?: number): Promise<void> {
    const body = JSON.stringify({ Type: "actions_storage", Name: name, RetentionDays: retentionDays ?? 0 });
    const createRes = await this.runtimeRequest(`/api/actions_pipeline/_apis/pipelines/workflows/${runId}/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    if (createRes.status !== 200) {
      throw new Error(`fake-runner: v1 create failed: HTTP ${createRes.status}`);
    }
    const created = await createRes.json<{ fileContainerResourceUrl: string }>();
    const chunkSize = 16; // tiny chunks exercise the range arithmetic
    for (let start = 0; start < content.length; start += chunkSize) {
      const end = Math.min(start + chunkSize, content.length) - 1;
      const chunk = content.slice(start, end + 1);
      const md5 = new Md5();
      md5.update(chunk);
      const sep = created.fileContainerResourceUrl.includes("?") ? "&" : "?";
      const res = await this.runtimeRequest(
        `${created.fileContainerResourceUrl}${sep}itemPath=${encodeURIComponent(`${name}/file.bin`)}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "content-range": `bytes ${start}-${end}/${content.length}`,
            "x-tfs-filelength": String(content.length),
            "x-actions-results-md5": base64Std(md5.hex()),
          },
          body: chunk,
        },
      );
      if (res.status !== 200) {
        throw new Error(`fake-runner: v1 chunk failed: HTTP ${res.status} ${await res.text()}`);
      }
    }
    const confirmRes = await this.runtimeRequest(
      `/api/actions_pipeline/_apis/pipelines/workflows/${runId}/artifacts?artifactName=${encodeURIComponent(name)}`,
      { method: "PATCH" },
    );
    if (confirmRes.status !== 200) {
      throw new Error(`fake-runner: v1 confirm failed: HTTP ${confirmRes.status}`);
    }
  }

  /** The v1 list → download_url → download round trip. */
  async downloadArtifactV1(runId: number, name: string): Promise<Uint8Array> {
    const listRes = await this.runtimeRequest(`/api/actions_pipeline/_apis/pipelines/workflows/${runId}/artifacts`, {
      method: "GET",
    });
    if (listRes.status !== 200) {
      throw new Error(`fake-runner: v1 list failed: HTTP ${listRes.status}`);
    }
    const list = await listRes.json<{ count: number; value: Array<{ name: string; fileContainerResourceUrl: string }> }>();
    const entry = list.value.find((v) => v.name === name);
    if (entry === undefined) {
      throw new Error(`fake-runner: v1 artifact ${name} not listed`);
    }
    const sep = entry.fileContainerResourceUrl.includes("?") ? "&" : "?";
    const urlRes = await this.runtimeRequest(
      `${entry.fileContainerResourceUrl}${sep}itemPath=${encodeURIComponent(name)}`,
      { method: "GET" },
    );
    if (urlRes.status !== 200) {
      throw new Error(`fake-runner: v1 download_url failed: HTTP ${urlRes.status}`);
    }
    const url = await urlRes.json<{ value: Array<{ contentLocation: string }> }>();
    const location = url.value[0]?.contentLocation;
    if (location === undefined) {
      throw new Error("fake-runner: v1 download_url carried no contentLocation");
    }
    // The v1 download sits BEHIND the ArtifactContexter (artifacts.go:124's
    // registered route) — the Bearer rides it, exactly upstream.
    const download = await this.runtimeRequest(location, { method: "GET" });
    if (download.status !== 200) {
      throw new Error(`fake-runner: v1 download failed: HTTP ${download.status}`);
    }
    return new Uint8Array(await download.arrayBuffer());
  }

  /**
   * The artifacts-v4 round trip (actions-toolkit's seat): CreateArtifact →
   * PUT blocks (comp=block/appendBlock) → PUT blocklist → FinalizeArtifact.
   */
  async uploadArtifactV4(runId: number, jobBackendId: number, name: string, content: Uint8Array): Promise<number> {
    const twirpBase = "/twirp/github.actions.results.api.v1.ArtifactService";
    const createRes = await this.runtimeRequest(`${twirpBase}/CreateArtifact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflow_run_backend_id: String(runId),
        workflow_job_run_backend_id: String(jobBackendId),
        name,
        version: 4,
      }),
    });
    if (createRes.status !== 200) {
      throw new Error(`fake-runner: v4 create failed: HTTP ${createRes.status}`);
    }
    const created = await createRes.json<{ ok: boolean; signedUploadUrl: string }>();
    if (!created.ok) {
      throw new Error("fake-runner: v4 create answered not-ok");
    }

    const blockSize = 16;
    const blockIds: string[] = [];
    for (let start = 0; start < content.length; start += blockSize) {
      const chunk = content.slice(start, Math.min(start + blockSize, content.length));
      const blockId = `block-${blockIds.length}`;
      blockIds.push(blockId);
      const sep = created.signedUploadUrl.includes("?") ? "&" : "?";
      const res = await this.fetchImpl(`${created.signedUploadUrl}${sep}comp=block&blockid=${encodeURIComponent(blockId)}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", "content-length": String(chunk.length) },
        body: chunk,
      });
      if (res.status !== 201) {
        throw new Error(`fake-runner: v4 block failed: HTTP ${res.status}`);
      }
    }

    const blockListXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<BlockList>\n${blockIds
      .map((id) => `\t<Latest>${id}</Latest>`)
      .join("\n")}\n</BlockList>`;
    const sep2 = created.signedUploadUrl.includes("?") ? "&" : "?";
    const listRes = await this.fetchImpl(`${created.signedUploadUrl}${sep2}comp=blocklist`, {
      method: "PUT",
      headers: { "content-type": "application/xml" },
      body: blockListXml,
    });
    if (listRes.status !== 201) {
      throw new Error(`fake-runner: v4 blocklist failed: HTTP ${listRes.status}`);
    }

    const finalizeRes = await this.runtimeRequest(`${twirpBase}/FinalizeArtifact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflow_run_backend_id: String(runId),
        workflow_job_run_backend_id: String(jobBackendId),
        name,
        size: String(content.length),
      }),
    });
    if (finalizeRes.status !== 200) {
      throw new Error(`fake-runner: v4 finalize failed: HTTP ${finalizeRes.status}`);
    }
    const finalized = await finalizeRes.json<{ ok: boolean; artifactId: string }>();
    if (!finalized.ok) {
      throw new Error("fake-runner: v4 finalize answered not-ok");
    }
    return Number(finalized.artifactId);
  }

  /** The v4 list → GetSignedArtifactURL → download round trip. */
  async downloadArtifactV4(runId: number, jobBackendId: number, nameFilter: string): Promise<Uint8Array> {
    const twirpBase = "/twirp/github.actions.results.api.v1.ArtifactService";
    const listRes = await this.runtimeRequest(`${twirpBase}/ListArtifacts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflow_run_backend_id: String(runId),
        workflow_job_run_backend_id: String(jobBackendId),
        name_filter: nameFilter,
      }),
    });
    if (listRes.status !== 200) {
      throw new Error(`fake-runner: v4 list failed: HTTP ${listRes.status}`);
    }
    const list = await listRes.json<{ artifacts: Array<{ databaseId: string; name: string }> }>();
    const entry = list.artifacts.find((a) => a.name === nameFilter);
    if (entry === undefined) {
      throw new Error(`fake-runner: v4 artifact ${nameFilter} not listed`);
    }
    const urlRes = await this.runtimeRequest(`${twirpBase}/GetSignedArtifactURL`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflow_run_backend_id: String(runId),
        workflow_job_run_backend_id: String(jobBackendId),
        name: nameFilter,
      }),
    });
    if (urlRes.status !== 200) {
      throw new Error(`fake-runner: v4 signed-url failed: HTTP ${urlRes.status}`);
    }
    const signed = await urlRes.json<{ signedUrl: string }>();
    const download = await this.fetchImpl(signed.signedUrl, { method: "GET" });
    if (download.status !== 200) {
      throw new Error(`fake-runner: v4 download failed: HTTP ${download.status}`);
    }
    return new Uint8Array(await download.arrayBuffer());
  }

  /** PUT a job summary (GITHUB_STEP_SUMMARY). */
  async putJobSummary(runId: number, jobId: number, stepIndex: number, content: string): Promise<Response> {
    return this.runtimeRequest(
      `/api/actions_pipeline/_apis/pipelines/workflows/${runId}/jobs/${jobId}/steps/${stepIndex}/summary`,
      {
        method: "PUT",
        headers: { "content-type": "text/markdown" },
        body: content,
      },
    );
  }

  /** The OIDC exchange (actions/core's seat): the request token → /token. */
  async exchangeOidcToken(requestToken: string, audience?: string): Promise<Response> {
    const url = `/api/actions/oidc/token${audience !== undefined ? `?audience=${encodeURIComponent(audience)}` : ""}`;
    return this.fetchImpl(`${this.baseUrl}${url}`, {
      method: "GET",
      headers: { authorization: `Bearer ${requestToken}` },
    });
  }

  private authHeaders(): Record<string, string> {
    if (this.runner === undefined) {
      throw new Error("fake-runner: not registered");
    }
    return { [UUID_HEADER]: this.runner.uuid, [TOKEN_HEADER]: this.runner.token };
  }
}

function base64Std(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin);
}
