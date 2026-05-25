# B3nd Move

Encoding, transport, decoding. The moving layer for B3nd.

For each supported transport, `b3nd-move` ships two halves over a `Rig`:
a **service** (incoming bytes → decode → drive the rig → encode → outgoing
bytes) and a **client** that implements `ProtocolInterfaceNode`. The client
side is the load-bearing detail — a client speaking one wire drops into a
rig route exactly like an in-process node, so any rig can be served over any
subset of HTTP, WebSocket, gRPC-over-HTTP, and MCP while its individual
routes are backed by `b3nd-move` clients pointing at upstream nodes on
whatever wire they happen to speak.

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

## Building custom network APIs

The transport handlers (`httpApi`, `wsApi`, `grpcHttpApi`) are the generic
wire — JSON in, JSON out, four routes covering the full rig surface. When
the consumer can't speak that wire, or wants a different endpoint shape,
two layers of customization sit underneath.

The **content facets** are the high-level door: `http-get-content` fronts
`rig.read` for one URI with a host-controlled response shape, and
`http-post-content` does the same for `rig.receive` with a host-controlled
body decoder. Use them when a browser-native consumer needs
`Content-Type: image/png` from a `<img src>` instead of opaque JSON:

```typescript
import { httpGetContentApi } from "@bandeira-tech/b3nd-move/http-get-content/service";
import { payloadResponseMap as map } from "@bandeira-tech/b3nd-move/http-get-content/payload-response-map";

Deno.serve({ port: 3000 }, httpGetContentApi(rig, {
  payloadResponseMap: map.byExtension({
    png:  map.fromField("bytes", { contentType: "image/png" }),
    json: map.json(),
    "*":  map.json(),
  }),
}));
```

For anything else, drop one level and build a `Route` directly. A route is
four fields — `on` (matcher over the request), `decode` (request → action
args), `action` (the work — usually one of the standard rig-backed actions),
`encode` (result → wire response) — handed to `dispatchHttp` to assemble a
handler:

```typescript
import { dispatchHttp, httpRequest, route } from "@bandeira-tech/b3nd-move/http/router";
import { readAction } from "@bandeira-tech/b3nd-move/actions/standard";
import { json } from "@bandeira-tech/b3nd-move/http/wire";
import { NotFound } from "@bandeira-tech/b3nd-move/router/errors";

// `GET /things/:id` → rig.read([`mutable://things/:id`])[0]
const getThing = route({
  on: httpRequest("GET", "/things/:id"),
  decode: ({ params }) =>
    [[`mutable://things/${params.id}`]] as readonly [string[]],
  action: readAction,
  encode: ([output]) => {
    if (!output || output[1] == null) throw new NotFound();
    return json(output[1]);
  },
});

const handler = (req: Request) => dispatchHttp(rig, [getThing], req);
Deno.serve({ port: 3000 }, handler);
```

The same `Route` shape is the unit every shipped transport handler is
built from internally — the content facets are exactly this pattern with
the `encode` step replaced by a `payloadResponseMap` hook.

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
| `b3nd-move/http/router`                        | `route()`, `httpRequest()`, `dispatchHttp()`     |
| `b3nd-move/http/wire`                          | `json()` / `readJson()` helpers                  |
| `b3nd-move/router/{route,errors}`              | Generic `Route` shape + `HttpError` hierarchy    |
| `b3nd-move/actions/standard`                   | Standard rig-bound action functions              |
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
