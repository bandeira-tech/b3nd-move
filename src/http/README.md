# http

HTTP transport for B3nd. JSON over `fetch`, with NDJSON streaming for observe.

## Surface

| File         | Exports                                     | Runtime |
| ------------ | ------------------------------------------- | ------- |
| `server.ts`  | `httpServer`, `HttpServerOptions`           | Deno    |
| `service.ts` | `httpApi`, `HttpApiOptions`                 | any     |
| `client.ts`  | `HttpClient`, `HttpClientConfig`            | any     |
| `*.test.ts`  | (tests — client, server, list, x-extension) | Deno    |

## Concepts

**Wire shape.** Every route mirrors the `ProtocolInterfaceNode` method it fronts
— the request body is exactly the argument PIN takes:

| Method | Path              | Body                 | Maps to             |
| ------ | ----------------- | -------------------- | ------------------- |
| `GET`  | `/api/v1/status`  | —                    | `rig.status()`      |
| `POST` | `/api/v1/receive` | `[[uri, payload],…]` | `rig.receive(msgs)` |
| `POST` | `/api/v1/read`    | `string[]`           | `rig.read(urls)`    |
| `POST` | `/api/v1/observe` | `string[]`           | `rig.observe(urls)` |

**Observe.** `POST /api/v1/observe` returns an `application/x-ndjson` stream;
each line is a JSON-encoded `[pattern, uris[]]` frame straight from
`rig.observe()`. `HttpClient.observe()` parses the lines and yields frames.

**The triplet.**

- `service.ts` (`httpApi(rig)`) is the pure fetch handler — pair with any
  runtime (Hono, Express, `node:http`, Workers).
- `server.ts` (`httpServer({ port })`) wraps it with `Deno.serve` + CORS and
  returns a `ServerResolver`.
- `client.ts` (`HttpClient`) speaks the routes above; implements
  `ProtocolInterfaceNode`.

## Usage

```typescript
// server side (Deno)
import { createServers } from "@bandeira-tech/b3nd-move/factory";
import { httpServer } from "@bandeira-tech/b3nd-move/http/server";

const [server] = createServers(rig, [httpServer({ port: 3000 })], {
  cors: "*",
});
await server.start();

// client side (anywhere fetch works)
import { HttpClient } from "@bandeira-tech/b3nd-move/http/client";

const client = new HttpClient({ url: "http://localhost:3000" });
await client.receive([["mutable://app/x", { name: "thing" }]]);
const [out] = await client.read(["mutable://app/x"]);
```

For Node / Bun / Workers, skip `server.ts` and feed `service.ts` to your host
runtime:

```typescript
import { httpApi } from "@bandeira-tech/b3nd-move/http/service";
import { withCors } from "@bandeira-tech/b3nd-move/cors";

export default { fetch: withCors(httpApi(rig), { origin: "*" }) };
```

## Notes

- `HttpApiOptions.statusMeta` is merged into status responses.
- `httpServer` honors `composition.cors` from `createServers`; per-server `cors`
  overrides it.
