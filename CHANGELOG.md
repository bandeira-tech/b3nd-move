# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.20.0] — Unreleased

### Added

- **`codecs/scheduler`** — `Scheduler` type relocated from `actions/scheduler`
  to `codecs/scheduler` (the new home reflects ownership — schedulers govern
  codec-level materialize fan-out).
- **`codecs/http`** — `httpOutputsFrame()` (today's baked behavior) +
  `httpNdjson()` (streaming-friendly NDJSON). Both accept a `scheduler` option.
- **`codecs/ws`** — `wsJsonEnvelope()` (today's baked behavior, lossy
  `{"0":n,…}` byte encoding per WS README) + `wsJsonEnvelopeBase64()`
  (byte-faithful, resolves PR #50 M1).
- **`codecs/grpc`** — `grpcProto()` (today's baked behavior; resolves PR #50 M3
  stream-encoding stealth bug).
- **`codecs/mcp`** — `mcpTextJsonStringify()` (today's baked behavior) +
  `mcpResourcePerSlot()` (byte-faithful idiomatic MCP resource content).
- **`codecs/materialize`** — shared
  `materializeStreams(outputs, scheduler,
  signal)` helper used by every
  materializing codec.
- **`codecs/base64`** — shared `base64FromBytes` / `bytesFromBase64` helpers
  (Latin-1 idiom).
- **Wire-aware codec interfaces** per transport: `HttpBatchCodec`
  (`src/http/codec.ts`), `WsBatchCodec` (`src/ws/codec.ts`), `GrpcBatchCodec`
  (`src/grpc/http/codec.ts`), `McpBatchCodec` (`src/mcp/codec.ts`).

### Changed (BREAKING)

- **`httpApi(rig, { codec })`** — `codec: HttpBatchCodec` is now a required
  option. No default. Migration: add `{ codec: httpOutputsFrame() }` (one import
  from `@bandeira-tech/b3nd-move/codecs/http`).
- **`new HttpClient({ url, codec })`** — `codec: HttpBatchCodec` is now a
  required field. Migration: same as above.
- **`wsApi(rig, { codec })`** — `codec: WsBatchCodec` is now a required option.
  Migration: add `{ codec: wsJsonEnvelope() }` (from
  `@bandeira-tech/b3nd-move/codecs/ws`).
- **`new WebSocketClient({ url, codec, ... })`** — `codec: WsBatchCodec` is now
  a required field.
- **`grpcHttpApi(rig, { codec })`** — `codec: GrpcBatchCodec` is now a required
  option. Migration: add `{ codec: grpcProto() }` (from
  `@bandeira-tech/b3nd-move/codecs/grpc`).
- **`new GrpcHttpClient({ url, codec, binary })`** — `codec: GrpcBatchCodec` is
  now a required field.
- **`buildMcpServer(rig, { codec, ... })`** — `codec: McpBatchCodec` is now a
  required option. Migration: add `{ codec: mcpTextJsonStringify() }` (from
  `@bandeira-tech/b3nd-move/codecs/mcp`).
- **`readAction`** is now a passthrough: `(rig, [urls]) => rig.read(urls)`.
  Stream materialization has moved into each transport's codec where it belongs.
- **`makeReadAction(scheduler)` REMOVED.** Consumers that used it for fan-out
  control should inject the scheduler into a materializing codec instead — e.g.,
  `httpOutputsFrame({ scheduler })`, `wsJsonEnvelope({ scheduler })`.
- **`@bandeira-tech/b3nd-move/actions/scheduler` REMOVED** (import path). The
  `Scheduler` type is now at `@bandeira-tech/b3nd-move/codecs/scheduler`.
- **`actions/ndjson.ts` → `codecs/ndjson.ts`** (internal relocation; no
  public-API change since the helper was never exported in the JSR map).

### Fixed

- **PR #50 M1**: WS bytes can now round-trip byte-faithfully via
  `wsJsonEnvelopeBase64` codec. The default `wsJsonEnvelope` retains today's
  lossy `{"0":n,…}` shape, documented in `src/ws/README.md`.
- **PR #50 M2**: Custom `http-get-content` `payloadResponseMap` hosts can stream
  payloads through their response body again — the action layer no longer
  materializes, so single-URI streaming is restored.
- **PR #50 M3**: gRPC stealth `JSON.stringify(stream) === "{}"` bug is fixed —
  `grpcProto` materializes streams before `outputToProto` ever sees them.
- **Issue #4** (WS unary frame cancel): unchanged from prior fix; new test
  coverage added at `src/ws/service.test.ts` (replacing the deleted
  per-transport read test infrastructure).

### Removed

- `src/http/read.test.ts`, `src/ws/read.test.ts`, `src/grpc/http/read.test.ts`,
  `src/mcp/read.test.ts` — per-transport ad-hoc tests PR #50 added. Coverage
  moved to:
  - `moveSuite` (read-stream round-trip case via `tests/rigs/stub.ts`'s
    `/__stream__/` sentinel)
  - `mcpSpec` (b3nd_read concrete-content case)
  - Per-codec unit tests in `src/codecs/<wire>/*.test.ts`
  - `src/ws/service.test.ts` (new — WS service-layer inFlight cancel
    bookkeeping)
  - `src/grpc/http/service.test.ts` (new — mid-stream AbortSignal cancel test)
- `src/actions/standard.edge.test.ts` — its assertions targeted the action-layer
  materialize; equivalent coverage is in each materializing codec's unit tests.
- `makeReadAction` factory — see Changed above.

### Architectural notes

- This release follows the design at
  `docs/superpowers/specs/2026-06-30-operator-declared-codecs-design.md`.
- The framework no longer ships defaults at the b3nd-move boundary. The operator
  declares the codec; the app developer declares the matching codec on the
  client side; if they don't match, the app doesn't work (same as any wire
  mismatch).
- b3nd ships no negotiation protocol — codecs may implement wire-native
  negotiation (e.g., HTTP Accept dispatch) using primitives in
  `src/http-get-content/payload-response-map.ts` as the pattern.

## Prior history

For changes before this release, see git log on the `main` branch.
