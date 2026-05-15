# http

HTTP transport for B3nd. JSON over `fetch`, with NDJSON streaming for observe.

## Surface

| File         | Exports                          | Runtime |
| ------------ | -------------------------------- | ------- |
| `service.ts` | `httpApi`, `HttpApiOptions`      | any     |
| `client.ts`  | `HttpClient`, `HttpClientConfig` | any     |
| `*.test.ts`  | (tests — list, x-extension)      | Deno    |

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

For local-dev convenience that wires `httpApi` plus a `stubRig`-backed runner
and a `Deno.serve` lifecycle in one go, use `deno task serve --http` (see
[`dev/serve.ts`](../../dev/serve.ts)).

## Notes

- `HttpApiOptions.statusMeta` is merged into status responses.
- CORS, auth, and any other middleware happen at the runtime layer — wrap
  `httpApi(rig)` yourself before handing it to `Deno.serve` / Hono / etc.
