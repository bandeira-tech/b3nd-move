# B3nd Move

Encoding, transport, decoding. The moving layer for B3nd.

`@bandeira-tech/b3nd-core` defines a `ProtocolInterfaceNode` — a small surface
(`receive` / `read` / `observe` / `status`) that every B3nd node speaks — and a
`Rig` that composes those nodes into routes per operation. `b3nd-move` is the
wire layer over that surface: for each supported transport it ships a
**service** (incoming bytes → decode → drive a `Rig` → encode → outgoing bytes)
and a **client** (the inverse, exposed as a `ProtocolInterfaceNode`). The
client side is the load-bearing detail: because every client implements the
core PIN interface, a client over one transport can be wired into a `Rig` as
the backend for a route served over another transport.

Composition falls out of that: any `Rig` can be served over any subset of
HTTP, WebSocket, gRPC-over-HTTP, and MCP — and any route in that rig can
itself be backed by a `b3nd-move` client speaking to some upstream node.

## Example: HTTP-backed reads, WS-backed receives, served over gRPC

```typescript
import { connection, Rig } from "@bandeira-tech/b3nd-core";
import { HttpClient } from "@bandeira-tech/b3nd-move/http/client";
import { WebSocketClient } from "@bandeira-tech/b3nd-move/ws/client";
import { grpcHttpApi } from "@bandeira-tech/b3nd-move/grpc/http/service";

// Two upstream protocol interface nodes, each reached over a different wire.
// `HttpClient` and `WebSocketClient` both implement `ProtocolInterfaceNode`,
// so they plug into a `Rig` route exactly like any in-process backend would.
const reads = new HttpClient({
  url: "https://content.example.com",
});

const writes = new WebSocketClient({
  url: "wss://ingest.example.com",
  reconnect: { enabled: true, backoff: "exponential" },
});

// One rig, two routes:
//   - `rig.read(uris)`    → dispatched to the HTTP upstream
//   - `rig.receive(msgs)` → dispatched to the WS upstream
// `connection(node, patterns)` claims URI patterns; `["*"]` means "everything".
const rig = new Rig({
  routes: {
    read: [connection(reads, ["*"])],
    receive: [connection(writes, ["*"])],
  },
});

// Expose the composed rig as a gRPC-over-HTTP service. The handler is a
// portable `(Request) => Response`, so any fetch-capable host works.
Deno.serve({ port: 50051 }, grpcHttpApi(rig));
```

A gRPC client now talks to one endpoint; behind it, reads fan out to an HTTP
API and receives fan out to a WS API. Swap any layer independently — change
`grpcHttpApi` to `httpApi` or `wsApi` to re-expose the same rig over a
different wire, or replace one of the upstream clients with an in-process
backend without touching the rig consumers. Each client exposes a `preSend`
hook (headers/query for `HttpClient` and `GrpcHttpClient`, per-frame envelope
mutation for `WebSocketClient`) for attaching auth and tracing on the
outbound legs.

## What's in the box

For every transport — **HTTP**, **WebSocket**, **gRPC-over-HTTP**, **MCP** —
there's a portable service handler (`*/service`) and, where the wire is
client-friendly, a `ProtocolInterfaceNode` client (`*/client`). Two
specialized request frontends (`http-get-content`, `http-post-content`) front
a single URI of `rig.read` / `rig.receive` with a host-controlled
response/body shape, for browser-native consumers like `<img src>` and
`<form enctype>` uploads. Underneath both sit the **codecs** — symmetric
`(encode, decode)` pairs over one wire envelope — and the gRPC proto pieces
(`grpc/proto/types`, `grpc/proto/convert`) for downstream codegen.

Each layer lives in exactly one file; there are no barrel exports. Runtime
binding (`Deno.serve`, `node:http`, framework adapters) is **not** part of
this package — pair a `service` handler with whatever your host runtime
provides. For local development the repo ships `dev/serve.ts` (run via
`deno task serve`) which wires a stub rig to any combination of transports
for ad-hoc testing; see [`dev/serve.ts`](./dev/serve.ts).

## Exports

| Subpath                                        | Purpose                                          |
| ---------------------------------------------- | ------------------------------------------------ |
| `b3nd-move/http/service`                       | HTTP request handler                             |
| `b3nd-move/http/client`                        | HTTP PIN client                                  |
| `b3nd-move/ws/service`                         | WebSocket request handler                        |
| `b3nd-move/ws/client`                          | WebSocket PIN client                             |
| `b3nd-move/grpc/http/service`                  | gRPC-over-HTTP request handler                   |
| `b3nd-move/grpc/http/client`                   | gRPC-over-HTTP PIN client                        |
| `b3nd-move/mcp/service`                        | MCP stdio server factory                         |
| `b3nd-move/http-get-content/service`           | Locked-surface `rig.read` front for one URI      |
| `b3nd-move/http-post-content/service`          | Locked-surface `rig.receive` front for one URI   |
| `b3nd-move/codecs/{codec,json,text,raw,field}` | Symmetric encode/decode pairs                    |
| `b3nd-move/grpc/proto/{types,convert}`         | Generated proto types + b3nd converters          |
| `b3nd-move/errors`                             | Shared error types                               |

## Development

```bash
deno task check
deno task test
deno task build:npm   # universal slices → ./npm/
```

## Related

- [b3nd-core](https://github.com/bandeira-tech/b3nd-core) — `Rig`,
  `ProtocolInterfaceNode`, shared types
- [b3nd-canon](https://github.com/bandeira-tech/b3nd-canon) — protocol-building
  toolkit

## License

MIT
