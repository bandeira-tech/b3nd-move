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

const reads = new HttpClient({ url: "https://content.example.com" });
const writes = new WebSocketClient({ url: "wss://ingest.example.com" });

const rig = new Rig({
  routes: {
    read: [connection(reads, ["*"])],
    receive: [connection(writes, ["*"])],
  },
});

Deno.serve({ port: 50051 }, grpcHttpApi(rig));
```

A gRPC client hits one endpoint; reads fan out to the HTTP upstream,
receives fan out to the WS upstream. Swap `grpcHttpApi` for `httpApi`,
`wsApi`, or any custom service handler without touching the rig.

## Building custom network APIs

Two layers sit beneath the stock `httpApi` / `wsApi` / `grpcHttpApi`
handlers. Pick the higher one when you can; drop a level when you can't.

The **content facets** front one URI of `rig.read` / `rig.receive` with a
host-controlled response shape or body decoder — for consumers that can't
speak the JSON wire (`<img src>`, file uploads, CDNs):

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

For anything else, build a `Route` directly — `on` matches the request,
`decode` produces the action's args, `action` does the work (typically one
of the standard rig-bound actions), `encode` shapes the wire response:

```typescript
import { dispatchHttp, httpRequest, route } from "@bandeira-tech/b3nd-move/http/router";
import { readAction } from "@bandeira-tech/b3nd-move/actions/standard";
import { json } from "@bandeira-tech/b3nd-move/http/wire";
import { NotFound } from "@bandeira-tech/b3nd-move/router/errors";

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

Deno.serve({ port: 3000 }, (req) => dispatchHttp(rig, [getThing], req));
```

## Transports

Each transport's wire format, route table, and `preSend` hook shape are
documented in its own README. Every layer lives in one file with no barrel
re-exports; runtime binding (`Deno.serve`, `node:http`, framework adapters)
is the host's job. A `deno task serve` helper at
[`dev/serve.ts`](./dev/serve.ts) wires a stub rig to any combination of
transports for ad-hoc testing.

| Transport                                                                | Expected encoding (outbound) | Expected decoding (inbound)              | Surface                                            |
| ------------------------------------------------------------------------ | ---------------------------- | ---------------------------------------- | -------------------------------------------------- |
| [HTTP](./src/http/) — `http/{service,client}`                            | JSON                         | JSON + urlsafe-b64 URI lists + raw bytes | Full PIN (service + client)                        |
| [WebSocket](./src/ws/) — `ws/{service,client}`                           | JSON envelope per frame      | JSON envelope per frame                  | Full PIN (service + client)                        |
| [gRPC-over-HTTP](./src/grpc/http/) — `grpc/http/{service,client}`        | protobuf / JSON (per req)    | protobuf / JSON (per req)                | Full PIN (service + client)                        |
| [MCP](./src/mcp/) — `mcp/service`                                        | JSON-RPC over stdio          | JSON-RPC over stdio                      | Service only; rig surfaced as MCP tools/resources  |
| [HTTP GET content](./src/http-get-content/) — `http-get-content/service` | host-shaped (`payloadResponseMap`) | URI in path                        | Custom — single-URI `rig.read` facet               |
| [HTTP POST content](./src/http-post-content/) — `http-post-content/service` | JSON (`ReceiveResult`)    | host-shaped (`payloadDecoder`)           | Custom — single-URI `rig.receive` facet            |

Shared building blocks live under [`codecs/`](./src/codecs/) (symmetric
encode/decode pairs), `router/{route,errors}` + `http/{router,wire}` +
`actions/standard` (route construction), and `grpc/proto/{types,convert}`
(generated protobuf + b3nd converters).

## Development

```bash
deno task check
deno task test
deno task build:npm   # universal slices → ./npm/
```

One-time per clone, install the pre-push hook so the fast CI subset
(type check, lint, fmt --check, unit, in-process integration) runs
locally before every push:

```bash
deno task hooks:install
```

Bypass with `git push --no-verify` when you really need to.

## Related

- [b3nd-core](https://github.com/bandeira-tech/b3nd-core) — `Rig`,
  `ProtocolInterfaceNode`, shared types
- [b3nd-canon](https://github.com/bandeira-tech/b3nd-canon) — protocol-building
  toolkit

## License

MIT
