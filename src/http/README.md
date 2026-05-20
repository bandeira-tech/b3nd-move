# http

HTTP transport for B3nd. JSON over `fetch`, with NDJSON streaming for observe.

## Surface

| File         | Exports                          | Runtime |
| ------------ | -------------------------------- | ------- |
| `service.ts` | `httpApi`, `HttpApiOptions`      | any     |
| `client.ts`  | `HttpClient`, `HttpClientConfig` | any     |
| `*.test.ts`  | (tests — list, x-extension)      | Deno    |

## Concepts

**Wire shape.** URIs ride in the URL as `?u=<b64>` so routing / auth /
observability can decide on a request without parsing the body. The body carries
only what's body-shaped: payloads on `receive`, nothing on `read` or `observe`.
The `?u=` encoding is `urlsafe-base64(<u16 url-len><url-utf8> × N)` — see
[`./uri-list.ts`](./uri-list.ts).

| Method | Path                      | Body        | Maps to                |
| ------ | ------------------------- | ----------- | ---------------------- |
| `GET`  | `/api/v1/status`          | —           | `rig.status()`         |
| `POST` | `/api/v1/receive?u=<b64>` | `unknown[]` | `rig.receive(outputs)` |
| `POST` | `/api/v1/read?u=<b64>`    | —           | `rig.read(urls)`       |
| `POST` | `/api/v1/observe?u=<b64>` | —           | `rig.observe(urls)`    |

`receive` body is the payload array — one slot per `u=` URI, positional. The
route zips them into `Output[]` before calling the rig. Length mismatch → 400.

**Observe.** `POST /api/v1/observe?u=…` returns an `application/x-ndjson`
stream; each line is a JSON-encoded `string[]` — the batch of uris that fired —
straight from `rig.observe()`. `HttpClient.observe()` parses the lines and
yields batches.

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
