# SPEC-0012 §6.1 — the M1a wire freeze (2026-10-29)

The runner protocol's wire truth, fetched and hash-verified per SPEC-0012
§6.1. The `ping_v1.proto` and `runner_v1.proto` files beside this note are
transcribed VERBATIM from the descriptors of the frozen module; the codecs
(`../wire.ts`) and the route shapes (`../routes.ts`) implement exactly these.

## The fetch

- Module: `gitea.dev/actionslib` **v1.5.0** (upstream `gitea/go.mod:11`).
- Fetched from the public Go module proxy:
  `https://proxy.golang.org/gitea.dev/actionslib/@v1.5.0.zip` — HTTP 200.
- **h1 hash (dirhash over file contents, the go.sum scheme):
  `h1:dC3v2HTWbbvyNBSdg2W3kd4WNC/p+FnZaKpl1MdzM00=`** — computed with
  `golang.org/x/mod/sumdb/dirhash.HashZip(zip, dirhash.Hash1)` and EQUAL to
  the in-tree pin `gitea/go.sum:15`. Verified 2026-10-29.
- Raw zip file sha256 (for reference; not the go.sum scheme):
  `71f511f66a60c2eb800b605b1bc1b024dc04cbf19a8dbb5d975bd0aafcfd2a19`.
- Proxy `.info` origin: VCS git, `https://gitea.com/gitea/actionslib`,
  commit `a33e1c6770cc042a04f0448f22ac6dda4322e428`, tag `refs/tags/v1.5.0`,
  tagged 2026-10-21.
- The module ships NO `.proto` sources — only protoc-generated `.pb.go`
  files. The transcription therefore decodes the embedded
  `FileDescriptorProto` raw descriptors (`file_runner_v1_messages_proto_rawDesc`
  etc.) via `protodesc.ToFileDescriptorProto` + `prototext.Format`, and the
  `.proto` fixtures here are the canonical re-rendering of those descriptors
  (field numbers, types, labels, json names, enum values, deprecated options).

## Wire constants from the same fetch

- `pkg/protocol/header.go`: **`UUIDHeader = "x-runner-uuid"`**,
  **`TokenHeader = "x-runner-token"`** (lowercase on the wire; the
  interceptor compares case-insensitively like any HTTP header read).
- Service full names (the connect path segments):
  `runner.v1.RunnerService`, `ping.v1.PingService` — mounted at
  `/api/actions/<service-name>/<Method>` (upstream
  `routers/api/actions/actions.go:22-26` + `runner/runner.go:36`,
  `ping/ping.go:24`: handler path = `"/" + ServiceName + "/"`).
- All five RunnerService procedures and Ping are UNARY.

## Codec decisions ratified under OQ-2 (hand-rolled)

- Protocol: connect unary over `application/proto` (what a stock act_runner
  speaks for the unary RPC family). The gRPC and gRPC-Web protocol variants
  are not implemented (documented divergence); an `application/json` connect
  request answers `unimplemented` per the connect spec (the JSON spelling is
  a SHOULD, not a MUST, for servers — revisit only if a consumer needs it).
- int64 fields decode through JavaScript numbers (all server-side values —
  row ids, tasks_version — sit far below 2^53; the varint decoder masks to
  64 bits with BigInt internally and converts).
- Response compression (upstream's `WithCompressMinBytes(1024)`) is not
  implemented — the server never compresses; runners that advertise
  `Connect-Accept-Encoding` accept identity.

## Scope of the freeze

`UpdateTask`/`UpdateLog` HANDLERS are M1b (SPEC §7), but their message
shapes are frozen here NOW — the codec implements the full frozen message
set (`wire.ts`), so M1b wires handlers without touching the wire.
