/**
 * The wire codec suite (SPEC-0012 §2.2, M1a): every frozen message
 * round-trips through the binary codec, pinned byte fixtures lock the
 * encodings to the contract fixtures (proto/runner_v1.proto — the actionslib
 * v1.5.0 descriptors), unknown fields skip forward-compatibly, and the
 * google.protobuf.Struct translation carries the task context's plain-JS
 * shape.
 */

import { describe, expect, it } from "vitest";

import {
  decodeDeclareRequest,
  decodeDeclareResponse,
  decodeFetchTaskRequest,
  decodeFetchTaskResponse,
  decodePingRequest,
  decodePingResponse,
  decodeRegisterRequest,
  decodeRegisterResponse,
  decodeUpdateLogRequest,
  decodeUpdateLogResponse,
  decodeUpdateTaskRequest,
  decodeUpdateTaskResponse,
  encodeDeclareRequest,
  encodeDeclareResponse,
  encodeFetchTaskRequest,
  encodeFetchTaskResponse,
  encodePingRequest,
  encodePingResponse,
  encodeRegisterRequest,
  encodeRegisterResponse,
  encodeUpdateLogRequest,
  encodeUpdateLogResponse,
  encodeUpdateTaskRequest,
  encodeUpdateTaskResponse,
  RunnerStatus,
  Result,
  StepStage,
} from "./wire";

/** The four hops of a connect round trip: client encode → server decode →
 *  server builds+encodes the response → client decode. */
function roundTrip<TReq, TRes>(
  encodeReq: (v: TReq) => Uint8Array,
  decodeReq: (bytes: Uint8Array) => TReq,
  buildResponse: (request: TReq) => TRes,
  encodeRes: (v: TRes) => Uint8Array,
  decodeRes: (bytes: Uint8Array) => TRes,
): (request: TReq) => TRes {
  return (request: TReq) => decodeRes(encodeRes(buildResponse(decodeReq(encodeReq(request)))));
}

describe("actions wire codec — ping.v1", () => {
  it("echoes data through the frozen Ping shape", () => {
    const bytes = encodePingRequest({ data: "world" });
    const serverInput = decodePingRequest(bytes);
    const responseBytes = encodePingResponse({ data: `Hello, ${serverInput.data}!` });
    expect(decodePingResponse(responseBytes)).toEqual({ data: "Hello, world!" });
  });

  it("pins the field-1 varint/string encodings byte-for-byte", () => {
    expect(Array.from(encodePingRequest({ data: "hi" }))).toEqual([
      0x0a, 0x02, 0x68, 0x69, // field 1, LEN, "hi"
    ]);
  });
});

describe("actions wire codec — runner.v1 register/declare", () => {
  it("round-trips RegisterRequest with all eight frozen fields", () => {
    const request = {
      name: "runner-1",
      token: "reg-token",
      agentLabels: ["legacy"],
      customLabels: ["legacy-custom"],
      version: "v1.2.3",
      labels: ["ubuntu-latest"],
      ephemeral: true,
      capabilities: ["cancelling"],
    };
    const decoded = decodeRegisterRequest(encodeRegisterRequest(request));
    expect(decoded).toEqual(request);
  });

  it("pins RegisterRequest{name, token} to the hand-computed bytes", () => {
    expect(Array.from(encodeRegisterRequest({ name: "r", token: "t", agentLabels: [], customLabels: [], version: "", labels: [], ephemeral: false, capabilities: [] })))
      .toEqual([0x0a, 0x01, 0x72, 0x12, 0x01, 0x74]);
  });

  it("omits proto3 zero values from the wire", () => {
    expect(encodeRegisterRequest({ name: "", token: "", agentLabels: [], customLabels: [], version: "", labels: [], ephemeral: false, capabilities: [] })).toHaveLength(0);
  });

  it("round-trips RegisterResponse.runner with the Runner census", () => {
    const response = {
      runner: {
        id: 42,
        uuid: "u-1234",
        token: "runner-token",
        name: "runner-1",
        status: RunnerStatus.RUNNER_STATUS_IDLE,
        agentLabels: ["a"],
        customLabels: [],
        version: "v9",
        labels: ["ubuntu-latest", "with-gpu"],
        ephemeral: true,
      },
    };
    const decoded = decodeRegisterResponse(encodeRegisterResponse(response));
    expect(decoded).toEqual(response);
  });

  it("round-trips DeclareRequest and DeclareResponse", () => {
    const declare = roundTrip(
      encodeDeclareRequest,
      decodeDeclareRequest,
      (request) => ({
        runner: {
          id: 7,
          uuid: "u",
          token: "",
          name: "n",
          status: 0,
          agentLabels: request.labels,
          customLabels: [],
          version: request.version,
          labels: request.labels,
          ephemeral: false,
        },
      }),
      encodeDeclareResponse,
      decodeDeclareResponse,
    );
    const request = { version: "v2", labels: ["l1"], capabilities: ["cancelling"] };
    expect(declare(request)).toEqual({
      runner: {
        id: 7,
        uuid: "u",
        token: "",
        name: "n",
        status: 0,
        agentLabels: ["l1"],
        customLabels: [],
        version: "v2",
        labels: ["l1"],
        ephemeral: false,
      },
    });
  });
});

describe("actions wire codec — fetch/task", () => {
  it("pins FetchTaskRequest{tasksVersion: 150} to the varint form", () => {
    expect(Array.from(encodeFetchTaskRequest({ tasksVersion: 150 }))).toEqual([0x08, 0x96, 0x01]);
  });

  it("round-trips FetchTaskResponse with an optional task present", () => {
    const response: Parameters<typeof encodeFetchTaskResponse>[0] = {
      task: {
        id: 9,
        workflowPayload: new Uint8Array([1, 2, 3]),
        context: { repository: "o/r", run_id: "9", nested: { list: [1, "a", true, null] } },
        secrets: { GITHUB_TOKEN: "t", CUSTOM: "s" },
        machine: "",
        needs: { build: { outputs: { out: "v" }, result: Result.RESULT_SUCCESS } },
        vars: { V: "x" },
      },
      tasksVersion: 5,
    };
    const decoded = decodeFetchTaskResponse(encodeFetchTaskResponse(response));
    expect(decoded).toEqual(response);
  });

  it("omits the optional task field entirely when absent", () => {
    const bytes = encodeFetchTaskResponse({ task: undefined, tasksVersion: 3 });
    expect(Array.from(bytes)).toEqual([0x10, 0x03]); // field 2 varint 3 only
  });

  it("round-trips a zero tasks_version (proto3-optional explicit presence is response-side)", () => {
    const decoded = decodeFetchTaskRequest(encodeFetchTaskRequest({ tasksVersion: 0 }));
    expect(decoded).toEqual({ tasksVersion: 0 });
  });
});

describe("actions wire codec — update family (frozen now, handlers M1b)", () => {
  it("round-trips UpdateTaskRequest/Response with outputs and sent_outputs", () => {
    const request = {
      state: {
        id: 3,
        result: Result.RESULT_FAILURE,
        startedAt: { seconds: 1700000000, nanos: 5 },
        stoppedAt: undefined,
        steps: [
          {
            id: 1,
            result: Result.RESULT_SUCCESS,
            startedAt: undefined,
            stoppedAt: undefined,
            logIndex: 0,
            logLength: 2,
            name: "step",
            stage: StepStage.STEP_STAGE_MAIN,
            number: 4,
          },
        ],
        reportedSteps: [],
      },
      outputs: { key: "value" },
    };
    expect(decodeUpdateTaskRequest(encodeUpdateTaskRequest(request))).toEqual(request);
    const response = { state: request.state, sentOutputs: ["key"] };
    expect(decodeUpdateTaskResponse(encodeUpdateTaskResponse(response))).toEqual(response);
  });

  it("round-trips UpdateLogRequest/Response with rows and ack index", () => {
    const request = {
      taskId: 11,
      index: 4,
      rows: [
        { time: { seconds: 1, nanos: 2 }, content: "line one" },
        { time: undefined, content: "" },
      ],
      noMore: true,
    };
    expect(decodeUpdateLogRequest(encodeUpdateLogRequest(request))).toEqual(request);
    expect(decodeUpdateLogResponse(encodeUpdateLogResponse({ ackIndex: 6 }))).toEqual({ ackIndex: 6 });
  });
});

describe("actions wire codec — proto3 edge cases", () => {
  it("skips unknown fields (forward compatibility with future runners)", () => {
    // RegisterRequest bytes with an unknown field 99 (varint 1) appended.
    const bytes = new Uint8Array([
      0x0a, 0x01, 0x72, // field 1 "r"
      0xf8, 0x06, 0x01, // field 99 varint 1
    ]);
    expect(decodeRegisterRequest(bytes)).toEqual({
      name: "r",
      token: "",
      agentLabels: [],
      customLabels: [],
      version: "",
      labels: [],
      ephemeral: false,
      capabilities: [],
    });
  });

  it("accepts repeated occurrences of a repeated field (non-contiguous packing)", () => {
    const bytes = new Uint8Array([
      0x32, 0x01, 0x61, // field 6 (labels) "a"
      0x32, 0x01, 0x62, // field 6 again "b"
    ]);
    expect(decodeRegisterRequest(bytes).labels).toEqual(["a", "b"]);
  });

  it("decodes 64-bit varints that still fit a safe integer", () => {
    // tasks_version = 2^40 — 64-bit wide but safe as a double (digit 32 at
    // shift 35).
    const bytes = new Uint8Array([0x08, 0x80, 0x80, 0x80, 0x80, 0x80, 0x20]);
    expect(decodeFetchTaskRequest(bytes)).toEqual({ tasksVersion: 2 ** 40 });
  });

  it("refuses varints beyond MAX_SAFE_INTEGER (the documented decoder bound)", () => {
    const bytes = new Uint8Array([0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]);
    expect(() => decodeFetchTaskRequest(bytes)).toThrow(/MAX_SAFE_INTEGER/);
  });

  it("refuses truncated messages", () => {
    expect(() => decodePingRequest(new Uint8Array([0x0a, 0x05, 0x61]))).toThrow(/truncated/);
  });
});
