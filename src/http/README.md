# http

HTTP transport for B3nd. JSON over `fetch`, with Server-Sent Events for observe
streams.

## Surface

| File         | Exports                                         | Runtime |
| ------------ | ----------------------------------------------- | ------- |
| `server.ts`  | `httpServer`, `HttpServerOptions`               | Deno    |
| `service.ts` | `httpApi`, `HttpApiOptions`                     | any     |
| `client.ts`  | `HttpClient`, `HttpClientConfig`                | any     |
| `sse.ts`     | `openSseStream`, `SseEvent`, `SseStreamOptions` | any     |
| `*.test.ts`  | (tests — client, server, list, x-extension)     | Deno    |

## Concepts

**Wire shape.** Plain HTTP under `/api/v1/`:

| Method | Path                        | Maps to                      |
| ------ | --------------------------- | ---------------------------- |
| `GET`  | `/api/v1/status`            | `rig.status()`               |
| `POST` | `/api/v1/receive`           | `rig.receive([[uri, body]])` |
| `POST` | `/api/v1/read`              | `rig.read(urls)`             |
| `GET`  | `/api/v1/observe/<pattern>` | `rig.observe(pattern)` (SSE) |

URI paths are reconstructed from the URL after the prefix (e.g.
`/api/v1/read/mutable/app/x` → `mutable://app/x`).

**Observe.** Server emits SSE; `HttpClient.observe()` consumes via
`openSseStream` (in `sse.ts`), which handles reconnection and event parsing.

**The triplet.**

- `service.ts` (`httpApi(rig)`) is the pure fetch handler — pair with any
  runtime (Hono, Express, `node:http`, Workers).
- `server.ts` (`httpServer(rig, { port })`) wraps it with `Deno.serve` and
  returns a `TransportServer` with `start`/`stop`.
- `client.ts` (`HttpClient`) speaks the routes above; implements
  `ProtocolInterfaceNode`.

## Usage

```typescript
// server side (Deno)
import { httpServer } from "@bandeira-tech/b3nd-move/http/server";

const server = httpServer(rig, { port: 3000 });
await server.start();

// client side (anywhere fetch works)
import { HttpClient } from "@bandeira-tech/b3nd-move/http/client";

const client = new HttpClient({ url: "http://localhost:3000" });
await client.receive([["mutable://app/x", { name: "thing" }]]);
const [out] = await client.read(["mutable://app/x"]);
```

For Node / Bun / Workers, skip `server.ts` and feed `service.ts` to your host
runtime — that's also where you add CORS, auth, or any other middleware:

```typescript
import { httpApi } from "@bandeira-tech/b3nd-move/http/service";

export default { fetch: httpApi(rig) };
```

## Notes

- `HttpApiOptions.statusMeta` is merged into status responses.
- `httpServer` is a no-frills `Deno.serve` convenience. It does not add CORS —
  wrap `httpApi(rig)` and call `Deno.serve` yourself if you need middleware in
  front of the handler.
- SSE keepalive: `service.ts` installs a 30s interval on observe streams.
  Cleanup binds to stream `cancel`; if a host runtime fires test sanitizers
  before stream cancel resolves, you may see a false-positive op leak (see
  `testing/tests/http.test.ts`).
