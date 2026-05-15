# grpc/http

gRPC service definition served over plain HTTP/1.1. JSON-encoded by default
(devtools-friendly), binary protobuf on opt-in. The same fetch handler answers
both — encoding is decided by `Content-Type`.

## Surface

| File         | Exports                                  | Runtime |
| ------------ | ---------------------------------------- | ------- |
| `service.ts` | `grpcHttpApi`                            | any     |
| `client.ts`  | `GrpcHttpClient`, `GrpcHttpClientConfig` | any     |

## Concepts

**Wire shape.** Methods are routed by URL path, payloads carry the proto
message:

```text
POST /b3nd.v1.B3ndService/<Method>
Content-Type: application/json | application/proto
```

| Method    | Maps to                                                      |
| --------- | ------------------------------------------------------------ |
| `Status`  | `rig.status()`                                               |
| `Receive` | `rig.receive(...)`                                           |
| `Read`    | `rig.read(...)`                                              |
| `Observe` | `rig.observe(...)` (NDJSON stream regardless of binary flag) |

**Encoding split.**

- `application/json` (default) — readable in network inspectors, easy to debug.
- `application/proto` — compact binary wire, opt in via
  `new GrpcHttpClient({ binary: true })`.

Observe always streams NDJSON for compatibility with the JSON wire form; this
means a binary client and a JSON client subscribe to the exact same event
stream.

**The pair.**

- `service.ts` (`grpcHttpApi(rig)`) is a pure `(Request) ⇒ Response` — works in
  any fetch-capable runtime.
- `client.ts` (`GrpcHttpClient`) implements `ProtocolInterfaceNode`; works in
  browsers, Deno, Bun, Node 18+.

Web apps that already use the connect-rpc ecosystem can drive the same handler
with the generated `B3ndService` descriptor — see
[`../proto/`](../proto/README.md).

## Usage

```typescript
import { grpcHttpApi } from "@bandeira-tech/b3nd-move/grpc/http/service";
import { GrpcHttpClient } from "@bandeira-tech/b3nd-move/grpc/http/client";

Deno.serve({ port: 50051 }, grpcHttpApi(rig));

const client = new GrpcHttpClient({
  url: "http://localhost:50051",
  binary: false, // flip to true for application/proto
});
await client.receive([["mutable://app/x", { name: "thing" }]]);
```

## Notes

- Both encodings are tested by the PIN contract — see
  `testing/tests/grpchttp.test.ts` which registers `grpchttp-json` and
  `grpchttp-binary` factories.
- Conversion between proto messages and b3nd's `Output` / `ReceiveResult` /
  `StatusResult` types lives in [`../proto/convert.ts`](../proto/convert.ts).
- For local-dev convenience use `deno task serve -- --grpc` (see
  [`dev/serve.ts`](../../../dev/serve.ts)).
