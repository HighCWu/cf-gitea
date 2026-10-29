/**
 * The hand-rolled protobuf wire codec for the Actions runner protocol
 * (SPEC-0012 §2.2, ratified under Open question 2: no protobuf dependency —
 * the frozen shape set is small and pinned by the contract fixtures in
 * `proto/`).
 *
 * Binary path (the codec the server serves — what a stock act_runner speaks
 * over connect unary): per-message typed encode/decode built on the
 * Writer/Reader primitives — every field is compiler-checked against the
 * message interfaces, no casts.
 *
 * Wire-freeze provenance: `proto/WIRE-FREEZE.md` — the shapes are
 * transcribed from gitea.dev/actionslib v1.5.0, hash-verified against the
 * upstream go.sum pin (h1:dC3v2HTWbbvyNBSdg2W3kd4WNC/p+FnZaKpl1MdzM00=).
 *
 * Divergences (documented, protocol-legal):
 *  - int64 values decode through JS numbers (server-side values — row ids,
 *    tasks_version, log indexes — sit far below 2^53; the varint decoder
 *    accumulates in BigInt and converts, throwing on > MAX_SAFE_INTEGER).
 *  - The protojson (application/json) codec is not implemented — the M1a
 *    surface answers JSON connect requests with `unimplemented`
 *    (routes.ts); the binary shapes are the frozen contract.
 *  - Decode skips unknown fields per proto3 rules (forward compatibility).
 */

// ---------------------------------------------------------------------------
// Wire-level primitives
// ---------------------------------------------------------------------------

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const UINT64_MASK = (1n << 64n) - 1n;

class ProtobufWriter {
  private chunks: Uint8Array[] = [];
  private length = 0;

  /** Internal: appends raw bytes (messageField's body callbacks use it). */
  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  varint(value: number): void {
    let v = BigInt(Math.trunc(value));
    // Negative int64 encodes as the 10-byte two's-complement form; the
    // protocol never carries negatives, but the encoder stays total.
    if (v < 0n) {
      v &= UINT64_MASK;
    }
    const bytes: number[] = [];
    while (v > 0x7fn) {
      bytes.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    bytes.push(Number(v));
    this.push(new Uint8Array(bytes));
  }

  tag(fieldNo: number, wireType: number): void {
    this.varint((fieldNo << 3) | wireType);
  }

  bytesField(fieldNo: number, bytes: Uint8Array): void {
    this.tag(fieldNo, WIRE_LEN);
    this.varint(bytes.length);
    this.push(bytes);
  }

  stringField(fieldNo: number, value: string): void {
    this.bytesField(fieldNo, new TextEncoder().encode(value));
  }

  messageField(fieldNo: number, encode: (w: ProtobufWriter) => void): void {
    const body = new ProtobufWriter();
    encode(body);
    this.bytesField(fieldNo, body.finish());
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/** The result of reading one tag: the field number and its wire type. */
interface Tagged {
  fieldNo: number;
  wireType: number;
}

class ProtobufReader {
  private view: DataView;
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** True when every byte has been consumed. */
  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  nextTag(): Tagged {
    const key = this.readVarintBig();
    return { fieldNo: Number(key >> 3n), wireType: Number(key & 0x7n) };
  }

  /** Reads and discards a value of the given wire type (unknown fields). */
  skip(wireType: number): void {
    switch (wireType) {
      case WIRE_VARINT:
        this.readVarintBig();
        return;
      case WIRE_FIXED64:
        this.require(8);
        this.offset += 8;
        return;
      case WIRE_LEN:
        this.skipBytes();
        return;
      default:
        throw new Error(`proto: unsupported wire type ${wireType}`);
    }
  }

  readVarint(): number {
    const v = this.readVarintBig();
    if (v > MAX_SAFE) {
      throw new Error("proto: varint exceeds MAX_SAFE_INTEGER");
    }
    return Number(v);
  }

  readVarintBig(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      this.require(1);
      const byte = this.bytes[this.offset] ?? 0;
      this.offset += 1;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return result & UINT64_MASK;
      }
      shift += 7n;
      if (shift >= 70n) {
        throw new Error("proto: varint too long");
      }
    }
  }

  readBytes(): Uint8Array {
    const len = this.readVarint();
    this.require(len);
    const out = this.bytes.slice(this.offset, this.offset + len);
    this.offset += len;
    return out;
  }

  private skipBytes(): void {
    const len = this.readVarint();
    this.require(len);
    this.offset += len;
  }

  readString(): string {
    return new TextDecoder().decode(this.readBytes());
  }

  readFixed64(): number {
    this.require(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  private require(n: number): void {
    if (this.offset + n > this.bytes.length) {
      throw new Error("proto: truncated message");
    }
  }
}

// ---------------------------------------------------------------------------
// Message interfaces — the frozen shapes (proto/runner_v1.proto,
// proto/ping_v1.proto). camelCase properties; proto3-optional fields are
// `| undefined` (explicit presence); everything else defaults to zero.
// ---------------------------------------------------------------------------

export interface PingRequest {
  data: string;
}
export interface PingResponse {
  data: string;
}

export interface RegisterRequest {
  name: string;
  token: string;
  /** Deprecated on the wire (field 3) — the `labels` field supersedes it. */
  agentLabels: string[];
  /** Deprecated on the wire (field 4). */
  customLabels: string[];
  version: string;
  labels: string[];
  ephemeral: boolean;
  capabilities: string[];
}
export interface RegisterResponse {
  runner: Runner | undefined;
}

export interface DeclareRequest {
  version: string;
  labels: string[];
  capabilities: string[];
}
export interface DeclareResponse {
  runner: Runner | undefined;
}

export interface FetchTaskRequest {
  tasksVersion: number;
}
export interface FetchTaskResponse {
  task: Task | undefined;
  tasksVersion: number;
}

export interface UpdateTaskRequest {
  state: TaskState | undefined;
  outputs: Record<string, string>;
}
export interface UpdateTaskResponse {
  state: TaskState | undefined;
  sentOutputs: string[];
}

export interface UpdateLogRequest {
  taskId: number;
  index: number;
  rows: LogRow[];
  noMore: boolean;
}
export interface UpdateLogResponse {
  ackIndex: number;
}

/** runnerv1.RunnerStatus */
export const RunnerStatus = {
  RUNNER_STATUS_UNSPECIFIED: 0,
  RUNNER_STATUS_IDLE: 1,
  RUNNER_STATUS_ACTIVE: 2,
  RUNNER_STATUS_OFFLINE: 3,
} as const;

/** runnerv1.Result (mirrors models/actions/status.go 0-4). */
export const Result = {
  RESULT_UNSPECIFIED: 0,
  RESULT_SUCCESS: 1,
  RESULT_FAILURE: 2,
  RESULT_CANCELLED: 3,
  RESULT_SKIPPED: 4,
} as const;

/** runnerv1.StepStage */
export const StepStage = {
  STEP_STAGE_UNSPECIFIED: 0,
  STEP_STAGE_SETUP: 1,
  STEP_STAGE_INIT_CONTAINERS: 2,
  STEP_STAGE_PRE: 3,
  STEP_STAGE_MAIN: 4,
  STEP_STAGE_POST: 5,
  STEP_STAGE_STOP_CONTAINERS: 6,
  STEP_STAGE_CLEANUP: 7,
} as const;

export interface Runner {
  id: number;
  uuid: string;
  token: string;
  name: string;
  status: number;
  agentLabels: string[];
  customLabels: string[];
  version: string;
  labels: string[];
  ephemeral: boolean;
}

export interface Task {
  id: number;
  workflowPayload: Uint8Array | undefined;
  /** google.protobuf.Struct as a plain JS object. */
  context: Record<string, unknown> | undefined;
  secrets: Record<string, string>;
  /** Deprecated on the wire (field 5). */
  machine: string;
  needs: Record<string, TaskNeed>;
  vars: Record<string, string>;
}

export interface TaskNeed {
  outputs: Record<string, string>;
  result: number;
}

export interface TaskState {
  id: number;
  result: number;
  startedAt: Timestamp | undefined;
  stoppedAt: Timestamp | undefined;
  steps: StepState[];
  reportedSteps: StepState[];
}

export interface StepState {
  id: number;
  result: number;
  startedAt: Timestamp | undefined;
  stoppedAt: Timestamp | undefined;
  logIndex: number;
  logLength: number;
  name: string;
  stage: number;
  number: number;
}

export interface LogRow {
  time: Timestamp | undefined;
  content: string;
}

/** google.protobuf.Timestamp. */
export interface Timestamp {
  seconds: number;
  nanos: number;
}

// ---------------------------------------------------------------------------
// Per-message BINARY codec — typed, no casts.
// ---------------------------------------------------------------------------

function encodeRepeatedStrings(w: ProtobufWriter, fieldNo: number, values: string[]): void {
  for (const v of values) {
    if (v === "") continue;
    w.stringField(fieldNo, v);
  }
}

function decodeRepeatedStrings(r: ProtobufReader, into: string[]): void {
  into.push(r.readString());
}

function encodeStringMap(w: ProtobufWriter, fieldNo: number, map: Record<string, string>): void {
  for (const [key, value] of Object.entries(map)) {
    w.messageField(fieldNo, (entry) => {
      entry.stringField(1, key);
      entry.stringField(2, value);
    });
  }
}

function decodeStringMapEntry(r: ProtobufReader): [string, string] {
  let key = "";
  let value = "";
  const bytes = r.readBytes();
  const er = new ProtobufReader(bytes);
  while (!er.done) {
    const { fieldNo, wireType } = er.nextTag();
    if (fieldNo === 1 && wireType === WIRE_LEN) {
      key = er.readString();
    } else if (fieldNo === 2 && wireType === WIRE_LEN) {
      value = er.readString();
    } else {
      er.skip(wireType);
    }
  }
  return [key, value];
}

// -- ping.v1 ----------------------------------------------------------------

export function encodePingRequest(v: PingRequest): Uint8Array {
  const w = new ProtobufWriter();
  if (v.data !== "") {
    w.stringField(1, v.data);
  }
  return w.finish();
}

export function decodePingRequest(bytes: Uint8Array): PingRequest {
  const out: PingRequest = { data: "" };
  const r = new ProtobufReader(bytes);
  while (!r.done) {
    const { fieldNo, wireType } = r.nextTag();
    if (fieldNo === 1 && wireType === WIRE_LEN) out.data = r.readString();
    else r.skip(wireType);
  }
  return out;
}

export function encodePingResponse(v: PingResponse): Uint8Array {
  const w = new ProtobufWriter();
  if (v.data !== "") {
    w.stringField(1, v.data);
  }
  return w.finish();
}

export function decodePingResponse(bytes: Uint8Array): PingResponse {
  const out: PingResponse = { data: "" };
  const r = new ProtobufReader(bytes);
  while (!r.done) {
    const { fieldNo, wireType } = r.nextTag();
    if (fieldNo === 1 && wireType === WIRE_LEN) out.data = r.readString();
    else r.skip(wireType);
  }
  return out;
}

// -- runner.v1: register/declare -------------------------------------------

export function encodeRegisterRequest(v: RegisterRequest): Uint8Array {
  const w = new ProtobufWriter();
  if (v.name !== "") {
    w.stringField(1, v.name);
  }
  if (v.token !== "") {
    w.stringField(2, v.token);
  }
  encodeRepeatedStrings(w, 3, v.agentLabels);
  encodeRepeatedStrings(w, 4, v.customLabels);
  if (v.version !== "") {
    w.stringField(5, v.version);
  }
  encodeRepeatedStrings(w, 6, v.labels);
  if (v.ephemeral) {
    w.tag(7, WIRE_VARINT);
    w.varint(1);
  }
  encodeRepeatedStrings(w, 8, v.capabilities);
  return w.finish();
}

export function decodeRegisterRequest(bytes: Uint8Array): RegisterRequest {
  const out: RegisterRequest = {
    name: "",
    token: "",
    agentLabels: [],
    customLabels: [],
    version: "",
    labels: [],
    ephemeral: false,
    capabilities: [],
  };
  const r = new ProtobufReader(bytes);
  while (!r.done) {
    const { fieldNo, wireType } = r.nextTag();
    switch (fieldNo) {
      case 1:
        if (wireType === WIRE_LEN) out.name = r.readString();
        else r.skip(wireType);
        break;
      case 2:
        if (wireType === WIRE_LEN) out.token = r.readString();
        else r.skip(wireType);
        break;
      case 3:
        if (wireType === WIRE_LEN) decodeRepeatedStrings(r, out.agentLabels);
        else r.skip(wireType);
        break;
      case 4:
        if (wireType === WIRE_LEN) decodeRepeatedStrings(r, out.customLabels);
        else r.skip(wireType);
        break;
      case 5:
        if (wireType === WIRE_LEN) out.version = r.readString();
        else r.skip(wireType);
        break;
      case 6:
        if (wireType === WIRE_LEN) decodeRepeatedStrings(r, out.labels);
        else r.skip(wireType);
        break;
      case 7:
        if (wireType === WIRE_VARINT) out.ephemeral = r.readVarint() !== 0;
        else r.skip(wireType);
        break;
      case 8:
        if (wireType === WIRE_LEN) decodeRepeatedStrings(r, out.capabilities);
        else r.skip(wireType);
        break;
      default:
        r.skip(wireType);
    }
  }
  return out;
}

export function encodeRunner(v: Runner): Uint8Array {
  const w = new ProtobufWriter();
  if (v.id !== 0) {
    w.tag(1, WIRE_VARINT);
    w.varint(v.id);
  }
  if (v.uuid !== "") {
    w.stringField(2, v.uuid);
  }
  if (v.token !== "") {
    w.stringField(3, v.token);
  }
  if (v.name !== "") {
    w.stringField(4, v.name);
  }
  if (v.status !== 0) {
    w.tag(5, WIRE_VARINT);
    w.varint(v.status);
  }
  encodeRepeatedStrings(w, 6, v.agentLabels);
  encodeRepeatedStrings(w, 7, v.customLabels);
  if (v.version !== "") {
    w.stringField(8, v.version);
  }
  encodeRepeatedStrings(w, 9, v.labels);
  if (v.ephemeral) {
    w.tag(10, WIRE_VARINT);
    w.varint(1);
  }
  return w.finish();
}

export function decodeRunner(bytes: Uint8Array): Runner {
  const out: Runner = {
    id: 0,
    uuid: "",
    token: "",
    name: "",
    status: 0,
    agentLabels: [],
    customLabels: [],
    version: "",
    labels: [],
    ephemeral: false,
  };
  const r = new ProtobufReader(bytes);
  while (!r.done) {
    const { fieldNo, wireType } = r.nextTag();
    switch (fieldNo) {
      case 1:
        if (wireType === WIRE_VARINT) out.id = r.readVarint();
        else r.skip(wireType);
        break;
      case 2:
        if (wireType === WIRE_LEN) out.uuid = r.readString();
        else r.skip(wireType);
        break;
      case 3:
        if (wireType === WIRE_LEN) out.token = r.readString();
        else r.skip(wireType);
        break;
      case 4:
        if (wireType === WIRE_LEN) out.name = r.readString();
        else r.skip(wireType);
        break;
      case 5:
        if (wireType === WIRE_VARINT) out.status = r.readVarint();
        else r.skip(wireType);
        break;
      case 6:
        if (wireType === WIRE_LEN) decodeRepeatedStrings(r, out.agentLabels);
        else r.skip(wireType);
        break;
      case 7:
        if (wireType === WIRE_LEN) decodeRepeatedStrings(r, out.customLabels);
        else r.skip(wireType);
        break;
      case 8:
        if (wireType === WIRE_LEN) out.version = r.readString();
        else r.skip(wireType);
        break;
      case 9:
        if (wireType === WIRE_LEN) decodeRepeatedStrings(r, out.labels);
        else r.skip(wireType);
        break;
      case 10:
        if (wireType === WIRE_VARINT) out.ephemeral = r.readVarint() !== 0;
        else r.skip(wireType);
        break;
      default:
        r.skip(wireType);
    }
  }
  return out;
}

export function encodeRegisterResponse(v: RegisterResponse): Uint8Array {
  const w = new ProtobufWriter();
  const runner = v.runner;
  if (runner !== undefined) w.messageField(1, (bw) => bw.push(encodeRunner(runner)));
  return w.finish();
}

export function decodeRegisterResponse(bytes: Uint8Array): RegisterResponse {
  const out: RegisterResponse = { runner: undefined };
  const r = new ProtobufReader(bytes);
  while (!r.done) {
    const { fieldNo, wireType } = r.nextTag();
    if (fieldNo === 1 && wireType === WIRE_LEN) out.runner = decodeRunner(r.readBytes());
    else r.skip(wireType);
  }
  return out;
}

export function encodeDeclareRequest(v: DeclareRequest): Uint8Array {
  const w = new ProtobufWriter();
  if (v.version !== "") {
    w.stringField(1, v.version);
  }
  encodeRepeatedStrings(w, 2, v.labels);
  encodeRepeatedStrings(w, 3, v.capabilities);
  return w.finish();
}

export function decodeDeclareRequest(bytes: Uint8Array): DeclareRequest {
  const out: DeclareRequest = { version: "", labels: [], capabilities: [] };
  const r = new ProtobufReader(bytes);
  while (!r.done) {
    const { fieldNo, wireType } = r.nextTag();
    switch (fieldNo) {
      case 1:
        if (wireType === WIRE_LEN) out.version = r.readString();
        else r.skip(wireType);
        break;
      case 2:
        if (wireType === WIRE_LEN) decodeRepeatedStrings(r, out.labels);
        else r.skip(wireType);
        break;
      case 3:
        if (wireType === WIRE_LEN) decodeRepeatedStrings(r, out.capabilities);
        else r.skip(wireType);
        break;
      default:
        r.skip(wireType);
    }
  }
  return out;
}

export function encodeDeclareResponse(v: DeclareResponse): Uint8Array {
  const w = new ProtobufWriter();
  const runner = v.runner;
  if (runner !== undefined) w.messageField(1, (bw) => bw.push(encodeRunner(runner)));
  return w.finish();
}

export function decodeDeclareResponse(bytes: Uint8Array): DeclareResponse {
  const out: DeclareResponse = { runner: undefined };
  const r = new ProtobufReader(bytes);
  while (!r.done) {
    const { fieldNo, wireType } = r.nextTag();
    if (fieldNo === 1 && wireType === WIRE_LEN) out.runner = decodeRunner(r.readBytes());
    else r.skip(wireType);
  }
  return out;
}

// -- runner.v1: fetch --------------------------------------------------------

export function encodeFetchTaskRequest(v: FetchTaskRequest): Uint8Array {
  const w = new ProtobufWriter();
  if (v.tasksVersion !== 0) {
    w.tag(1, WIRE_VARINT);
    w.varint(v.tasksVersion);
  }
  return w.finish();
}

export function decodeFetchTaskRequest(bytes: Uint8Array): FetchTaskRequest {
  const out: FetchTaskRequest = { tasksVersion: 0 };
  const r = new ProtobufReader(bytes);
  while (!r.done) {
    const { fieldNo, wireType } = r.nextTag();
    if (fieldNo === 1 && wireType === WIRE_VARINT) out.tasksVersion = r.readVarint();
    else r.skip(wireType);
  }
  return out;
}

export function encodeTaskNeed(v: TaskNeed): Uint8Array {
  const w = new ProtobufWriter();
  encodeStringMap(w, 1, v.outputs);
  if (v.result !== 0) {
    w.tag(2, WIRE_VARINT);
    w.varint(v.result);
  }
  return w.finish();
}

export function decodeTaskNeed(bytes: Uint8Array): TaskNeed {
  const out: TaskNeed = { outputs: {}, result: 0 };
  const r = new ProtobufReader(bytes);
  while (!r.done) {
    const { fieldNo, wireType } = r.nextTag();
    if (fieldNo === 1 && wireType === WIRE_LEN) {
      const [k, v] = decodeStringMapEntry(r);
      out.outputs[k] = v;
    } else if (fieldNo === 2 && wireType === WIRE_VARINT) {
      out.result = r.readVarint();
    } else r.skip(wireType);
  }
  return out;
}

export function encodeTimestamp(v: Timestamp): Uint8Array {
  const w = new ProtobufWriter();
  if (v.seconds !== 0) {
    w.tag(1, WIRE_VARINT);
    w.varint(v.seconds);
  }
  if (v.nanos !== 0) {
    w.tag(2, WIRE_VARINT);
    w.varint(v.nanos);
  }
  return w.finish();
}

export function decodeTimestamp(bytes: Uint8Array): Timestamp {
  const out: Timestamp = { seconds: 0, nanos: 0 };
  const r = new ProtobufReader(bytes);
  while (!r.done) {
    const { fieldNo, wireType } = r.nextTag();
    if (fieldNo === 1 && wireType === WIRE_VARINT) out.seconds = r.readVarint();
    else if (fieldNo === 2 && wireType === WIRE_VARINT) out.nanos = r.readVarint();
    else r.skip(wireType);
  }
  return out;
}

/**
 * google.protobuf.Struct — the PLAIN JS object representation (the natural
 * shape for the task context): object → Struct, array → ListValue, string /
 * number / boolean / null → their value fields.
 */
export function encodeValue(w: ProtobufWriter, value: unknown): void {
  if (value === null || value === undefined) {
    w.tag(1, WIRE_VARINT);
    w.varint(0); // NULL_VALUE
  } else if (typeof value === "number") {
    w.tag(2, WIRE_FIXED64);
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, value, true);
    w.push(new Uint8Array(buf));
  } else if (typeof value === "string") {
    w.stringField(3, value);
  } else if (typeof value === "boolean") {
    w.tag(4, WIRE_VARINT);
    w.varint(value ? 1 : 0);
  } else if (Array.isArray(value)) {
    w.messageField(6, (lw) => {
      for (const item of value) {
        lw.messageField(1, (vw) => encodeValue(vw, item));
      }
    });
  } else {
    const obj = value as Record<string, unknown>;
    w.messageField(5, (sw) => encodeStructBody(sw, obj));
  }
}

function encodeStructBody(w: ProtobufWriter, obj: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(obj)) {
    w.messageField(1, (entry) => {
      entry.stringField(1, key);
      entry.messageField(2, (vw) => encodeValue(vw, value));
    });
  }
}

export function decodeValue(r: ProtobufReader): unknown {
  const bytes = r.readBytes();
  const vr = new ProtobufReader(bytes);
  let out: unknown = null;
  while (!vr.done) {
    const { fieldNo, wireType } = vr.nextTag();
    switch (fieldNo) {
      case 1:
        if (wireType === WIRE_VARINT) {
          vr.readVarint();
          out = null;
        } else vr.skip(wireType);
        break;
      case 2:
        if (wireType === WIRE_FIXED64) out = vr.readFixed64();
        else vr.skip(wireType);
        break;
      case 3:
        if (wireType === WIRE_LEN) out = vr.readString();
        else vr.skip(wireType);
        break;
      case 4:
        if (wireType === WIRE_VARINT) out = vr.readVarint() !== 0;
        else vr.skip(wireType);
        break;
      case 5:
        if (wireType === WIRE_LEN) out = decodeStructBody(vr);
        else vr.skip(wireType);
        break;
      case 6:
        if (wireType === WIRE_LEN) {
          const lbytes = vr.readBytes();
          const lr = new ProtobufReader(lbytes);
          const list: unknown[] = [];
          while (!lr.done) {
            const lt = lr.nextTag();
            if (lt.fieldNo === 1 && lt.wireType === WIRE_LEN) list.push(decodeValue(lr));
            else lr.skip(lt.wireType);
          }
          out = list;
        } else vr.skip(wireType);
        break;
      default:
        vr.skip(wireType);
    }
  }
  return out;
}

function decodeStructBody(r: ProtobufReader): Record<string, unknown> {
  const bytes = r.readBytes();
  const sr = new ProtobufReader(bytes);
  const out: Record<string, unknown> = {};
  while (!sr.done) {
    const { fieldNo, wireType } = sr.nextTag();
    if (fieldNo === 1 && wireType === WIRE_LEN) {
      const ebytes = sr.readBytes();
      const er = new ProtobufReader(ebytes);
      let key = "";
      let value: unknown = null;
      while (!er.done) {
        const et = er.nextTag();
        if (et.fieldNo === 1 && et.wireType === WIRE_LEN) key = er.readString();
        else if (et.fieldNo === 2 && et.wireType === WIRE_LEN) value = decodeValue(er);
        else er.skip(et.wireType);
      }
      out[key] = value;
    } else sr.skip(wireType);
  }
  return out;
}

export function encodeTask(v: Task): Uint8Array {
  const w = new ProtobufWriter();
  if (v.id !== 0) {
    w.tag(1, WIRE_VARINT);
    w.varint(v.id);
  }
  if (v.workflowPayload !== undefined) w.bytesField(2, v.workflowPayload);
  const context = v.context;
  if (context !== undefined) w.messageField(3, (sw) => encodeStructBody(sw, context));
  encodeStringMap(w, 4, v.secrets);
  if (v.machine !== "") {
    w.stringField(5, v.machine);
  }
  for (const [key, need] of Object.entries(v.needs)) {
    w.messageField(6, (entry) => {
      entry.stringField(1, key);
      entry.messageField(2, (bw) => bw.push(encodeTaskNeed(need)));
    });
  }
  encodeStringMap(w, 7, v.vars);
  return w.finish();
}

export function decodeTask(bytes: Uint8Array): Task {
  const out: Task = {
    id: 0,
    workflowPayload: undefined,
    context: undefined,
    secrets: {},
    machine: "",
    needs: {},
    vars: {},
  };
  const r = new ProtobufReader(bytes);
  while (!r.done) {
    const { fieldNo, wireType } = r.nextTag();
    switch (fieldNo) {
      case 1:
        if (wireType === WIRE_VARINT) out.id = r.readVarint();
        else r.skip(wireType);
        break;
      case 2:
        if (wireType === WIRE_LEN) out.workflowPayload = r.readBytes();
        else r.skip(wireType);
        break;
      case 3:
        if (wireType === WIRE_LEN) out.context = decodeStructBody(r);
        else r.skip(wireType);
        break;
      case 4:
        if (wireType === WIRE_LEN) {
          const [k, v] = decodeStringMapEntry(r);
          out.secrets[k] = v;
        } else r.skip(wireType);
        break;
      case 5:
        if (wireType === WIRE_LEN) out.machine = r.readString();
        else r.skip(wireType);
        break;
      case 6:
        if (wireType === WIRE_LEN) {
          const ebytes = r.readBytes();
          const er = new ProtobufReader(ebytes);
          let key = "";
          let need: TaskNeed = { outputs: {}, result: 0 };
          while (!er.done) {
            const et = er.nextTag();
            if (et.fieldNo === 1 && et.wireType === WIRE_LEN) key = er.readString();
            else if (et.fieldNo === 2 && et.wireType === WIRE_LEN) need = decodeTaskNeed(er.readBytes());
            else er.skip(et.wireType);
          }
          out.needs[key] = need;
        } else r.skip(wireType);
        break;
      case 7:
        if (wireType === WIRE_LEN) {
          const [k, v] = decodeStringMapEntry(r);
          out.vars[k] = v;
        } else r.skip(wireType);
        break;
      default:
        r.skip(wireType);
    }
  }
  return out;
}

export function encodeFetchTaskResponse(v: FetchTaskResponse): Uint8Array {
  const w = new ProtobufWriter();
  const task = v.task;
  if (task !== undefined) w.messageField(1, (bw) => bw.push(encodeTask(task)));
  // tasks_version is proto3-optional in this proto (explicit presence): an
  // explicitly-zero version still encodes.
  if (v.tasksVersion !== 0) {
    w.tag(2, WIRE_VARINT);
    w.varint(v.tasksVersion);
  }
  return w.finish();
}

export function decodeFetchTaskResponse(bytes: Uint8Array): FetchTaskResponse {
  const out: FetchTaskResponse = { task: undefined, tasksVersion: 0 };
  const r = new ProtobufReader(bytes);
  while (!r.done) {
    const { fieldNo, wireType } = r.nextTag();
    if (fieldNo === 1 && wireType === WIRE_LEN) out.task = decodeTask(r.readBytes());
    else if (fieldNo === 2 && wireType === WIRE_VARINT) out.tasksVersion = r.readVarint();
    else r.skip(wireType);
  }
  return out;
}

// -- runner.v1: update family (frozen now; handlers are M1b) ----------------

export function encodeStepState(v: StepState): Uint8Array {
  const w = new ProtobufWriter();
  if (v.id !== 0) {
    w.tag(1, WIRE_VARINT);
    w.varint(v.id);
  }
  if (v.result !== 0) {
    w.tag(2, WIRE_VARINT);
    w.varint(v.result);
  }
  const startedAt = v.startedAt;
  if (startedAt !== undefined) w.messageField(3, (bw) => bw.push(encodeTimestamp(startedAt)));
  const stoppedAt = v.stoppedAt;
  if (stoppedAt !== undefined) w.messageField(4, (bw) => bw.push(encodeTimestamp(stoppedAt)));
  if (v.logIndex !== 0) {
    w.tag(5, WIRE_VARINT);
    w.varint(v.logIndex);
  }
  if (v.logLength !== 0) {
    w.tag(6, WIRE_VARINT);
    w.varint(v.logLength);
  }
  if (v.name !== "") w.stringField(7, v.name);
  if (v.stage !== 0) {
    w.tag(8, WIRE_VARINT);
    w.varint(v.stage);
  }
  if (v.number !== 0) {
    w.tag(9, WIRE_VARINT);
    w.varint(v.number);
  }
  return w.finish();
}

export function decodeStepState(bytes: Uint8Array): StepState {
  const out: StepState = {
    id: 0,
    result: 0,
    startedAt: undefined,
    stoppedAt: undefined,
    logIndex: 0,
    logLength: 0,
    name: "",
    stage: 0,
    number: 0,
  };
  const r = new ProtobufReader(bytes);
  while (!r.done) {
    const { fieldNo, wireType } = r.nextTag();
    switch (fieldNo) {
      case 1:
        if (wireType === WIRE_VARINT) out.id = r.readVarint();
        else r.skip(wireType);
        break;
      case 2:
        if (wireType === WIRE_VARINT) out.result = r.readVarint();
        else r.skip(wireType);
        break;
      case 3:
        if (wireType === WIRE_LEN) out.startedAt = decodeTimestamp(r.readBytes());
        else r.skip(wireType);
        break;
      case 4:
        if (wireType === WIRE_LEN) out.stoppedAt = decodeTimestamp(r.readBytes());
        else r.skip(wireType);
        break;
      case 5:
        if (wireType === WIRE_VARINT) out.logIndex = r.readVarint();
        else r.skip(wireType);
        break;
      case 6:
        if (wireType === WIRE_VARINT) out.logLength = r.readVarint();
        else r.skip(wireType);
        break;
      case 7:
        if (wireType === WIRE_LEN) out.name = r.readString();
        else r.skip(wireType);
        break;
      case 8:
        if (wireType === WIRE_VARINT) out.stage = r.readVarint();
        else r.skip(wireType);
        break;
      case 9:
        if (wireType === WIRE_VARINT) out.number = r.readVarint();
        else r.skip(wireType);
        break;
      default:
        r.skip(wireType);
    }
  }
  return out;
}

export function encodeTaskState(v: TaskState): Uint8Array {
  const w = new ProtobufWriter();
  if (v.id !== 0) {
    w.tag(1, WIRE_VARINT);
    w.varint(v.id);
  }
  if (v.result !== 0) {
    w.tag(2, WIRE_VARINT);
    w.varint(v.result);
  }
  const startedAt = v.startedAt;
  if (startedAt !== undefined) w.messageField(3, (bw) => bw.push(encodeTimestamp(startedAt)));
  const stoppedAt = v.stoppedAt;
  if (stoppedAt !== undefined) w.messageField(4, (bw) => bw.push(encodeTimestamp(stoppedAt)));
  for (const s of v.steps) w.messageField(5, (bw) => bw.push(encodeStepState(s)));
  for (const s of v.reportedSteps) w.messageField(6, (bw) => bw.push(encodeStepState(s)));
  return w.finish();
}

export function decodeTaskState(bytes: Uint8Array): TaskState {
  const out: TaskState = {
    id: 0,
    result: 0,
    startedAt: undefined,
    stoppedAt: undefined,
    steps: [],
    reportedSteps: [],
  };
  const r = new ProtobufReader(bytes);
  while (!r.done) {
    const { fieldNo, wireType } = r.nextTag();
    switch (fieldNo) {
      case 1:
        if (wireType === WIRE_VARINT) out.id = r.readVarint();
        else r.skip(wireType);
        break;
      case 2:
        if (wireType === WIRE_VARINT) out.result = r.readVarint();
        else r.skip(wireType);
        break;
      case 3:
        if (wireType === WIRE_LEN) out.startedAt = decodeTimestamp(r.readBytes());
        else r.skip(wireType);
        break;
      case 4:
        if (wireType === WIRE_LEN) out.stoppedAt = decodeTimestamp(r.readBytes());
        else r.skip(wireType);
        break;
      case 5:
        if (wireType === WIRE_LEN) out.steps.push(decodeStepState(r.readBytes()));
        else r.skip(wireType);
        break;
      case 6:
        if (wireType === WIRE_LEN) out.reportedSteps.push(decodeStepState(r.readBytes()));
        else r.skip(wireType);
        break;
      default:
        r.skip(wireType);
    }
  }
  return out;
}

export function encodeUpdateTaskRequest(v: UpdateTaskRequest): Uint8Array {
  const w = new ProtobufWriter();
  const state = v.state;
  if (state !== undefined) w.messageField(1, (bw) => bw.push(encodeTaskState(state)));
  encodeStringMap(w, 2, v.outputs);
  return w.finish();
}

export function decodeUpdateTaskRequest(bytes: Uint8Array): UpdateTaskRequest {
  const out: UpdateTaskRequest = { state: undefined, outputs: {} };
  const r = new ProtobufReader(bytes);
  while (!r.done) {
    const { fieldNo, wireType } = r.nextTag();
    if (fieldNo === 1 && wireType === WIRE_LEN) out.state = decodeTaskState(r.readBytes());
    else if (fieldNo === 2 && wireType === WIRE_LEN) {
      const [k, v] = decodeStringMapEntry(r);
      out.outputs[k] = v;
    } else r.skip(wireType);
  }
  return out;
}

export function encodeUpdateTaskResponse(v: UpdateTaskResponse): Uint8Array {
  const w = new ProtobufWriter();
  const state = v.state;
  if (state !== undefined) w.messageField(1, (bw) => bw.push(encodeTaskState(state)));
  encodeRepeatedStrings(w, 2, v.sentOutputs);
  return w.finish();
}

export function decodeUpdateTaskResponse(bytes: Uint8Array): UpdateTaskResponse {
  const out: UpdateTaskResponse = { state: undefined, sentOutputs: [] };
  const r = new ProtobufReader(bytes);
  while (!r.done) {
    const { fieldNo, wireType } = r.nextTag();
    if (fieldNo === 1 && wireType === WIRE_LEN) out.state = decodeTaskState(r.readBytes());
    else if (fieldNo === 2 && wireType === WIRE_LEN) decodeRepeatedStrings(r, out.sentOutputs);
    else r.skip(wireType);
  }
  return out;
}

export function encodeLogRow(v: LogRow): Uint8Array {
  const w = new ProtobufWriter();
  const time = v.time;
  if (time !== undefined) w.messageField(1, (bw) => bw.push(encodeTimestamp(time)));
  if (v.content !== "") {
    w.stringField(2, v.content);
  }
  return w.finish();
}

export function decodeLogRow(bytes: Uint8Array): LogRow {
  const out: LogRow = { time: undefined, content: "" };
  const r = new ProtobufReader(bytes);
  while (!r.done) {
    const { fieldNo, wireType } = r.nextTag();
    if (fieldNo === 1 && wireType === WIRE_LEN) out.time = decodeTimestamp(r.readBytes());
    else if (fieldNo === 2 && wireType === WIRE_LEN) out.content = r.readString();
    else r.skip(wireType);
  }
  return out;
}

export function encodeUpdateLogRequest(v: UpdateLogRequest): Uint8Array {
  const w = new ProtobufWriter();
  if (v.taskId !== 0) {
    w.tag(1, WIRE_VARINT);
    w.varint(v.taskId);
  }
  if (v.index !== 0) {
    w.tag(2, WIRE_VARINT);
    w.varint(v.index);
  }
  for (const row of v.rows) w.messageField(3, (bw) => bw.push(encodeLogRow(row)));
  if (v.noMore) {
    w.tag(4, WIRE_VARINT);
    w.varint(1);
  }
  return w.finish();
}

export function decodeUpdateLogRequest(bytes: Uint8Array): UpdateLogRequest {
  const out: UpdateLogRequest = { taskId: 0, index: 0, rows: [], noMore: false };
  const r = new ProtobufReader(bytes);
  while (!r.done) {
    const { fieldNo, wireType } = r.nextTag();
    switch (fieldNo) {
      case 1:
        if (wireType === WIRE_VARINT) out.taskId = r.readVarint();
        else r.skip(wireType);
        break;
      case 2:
        if (wireType === WIRE_VARINT) out.index = r.readVarint();
        else r.skip(wireType);
        break;
      case 3:
        if (wireType === WIRE_LEN) out.rows.push(decodeLogRow(r.readBytes()));
        else r.skip(wireType);
        break;
      case 4:
        if (wireType === WIRE_VARINT) out.noMore = r.readVarint() !== 0;
        else r.skip(wireType);
        break;
      default:
        r.skip(wireType);
    }
  }
  return out;
}

export function encodeUpdateLogResponse(v: UpdateLogResponse): Uint8Array {
  const w = new ProtobufWriter();
  if (v.ackIndex !== 0) {
    w.tag(1, WIRE_VARINT);
    w.varint(v.ackIndex);
  }
  return w.finish();
}

export function decodeUpdateLogResponse(bytes: Uint8Array): UpdateLogResponse {
  const out: UpdateLogResponse = { ackIndex: 0 };
  const r = new ProtobufReader(bytes);
  while (!r.done) {
    const { fieldNo, wireType } = r.nextTag();
    if (fieldNo === 1 && wireType === WIRE_VARINT) out.ackIndex = r.readVarint();
    else r.skip(wireType);
  }
  return out;
}
