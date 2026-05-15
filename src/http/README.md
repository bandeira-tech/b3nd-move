# http

HTTP transport for B3nd. JSON over `fetch`, with Server-Sent Events for observe
streams.

## Surface

| File         | Exports                                         | Runtime |
| ------------ | ----------------------------------------------- | ------- |
| `service.ts` | `httpApi`, `HttpApiOptions`                     | any     |
| `client.ts`  | `HttpClient`, `HttpClientConfig`                | any     |
| `sse.ts`     | `openSseStream`, `SseEvent`, `SseStreamOptions` | any     |
| `*.test.ts`  | (tests — client, list, x-extension)             | Deno    |

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

**The pair.**

- `service.ts` (`httpApi(rig)`) is the pure fetch handler — pair with any
  runtime (Deno, Hono, Express, `node:http`, Workers).
- `client.ts` (`HttpClient`) speaks the routes above; implements
  `ProtocolInterfaceNode`.

## Usage

```typescript
// server side — pair with whatever your runtime offers
import { httpApi } from "@bandeira-tech/b3nd-move/http/service";

Deno.serve({ port: 3000 }, httpApi(rig));
// or: export default { fetch: httpApi(rig) };

// client side (anywhere fetch works)
import { HttpClient } from "@bandeira-tech/b3nd-move/http/client";

const client = new HttpClient({ url: "http://localhost:3000" });
await client.receive([["mutable://app/x", { name: "thing" }]]);
const [out] = await client.read(["mutable://app/x"]);
```

For local-dev convenience that wires `httpApi` plus a `MemoryStore`-backed rig
and a `Deno.serve` lifecycle in one go, use `deno task serve -- --http` (see
[`dev/serve.ts`](../../dev/serve.ts)).

## Notes

- `HttpApiOptions.statusMeta` is merged into status responses.
- CORS, auth, and any other middleware happen at the runtime layer — wrap
  `httpApi(rig)` yourself before handing it to `Deno.serve` / Hono / etc.
- SSE keepalive: `service.ts` installs a 30s interval on observe streams.
  Cleanup binds to stream `cancel`; if a host runtime fires test sanitizers
  before stream cancel resolves, you may see a false-positive op leak (see
  `testing/tests/http.test.ts`).
