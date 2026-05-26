# http-post-content

POST-only HTTP write facet. Single URI in path, request body becomes the
payload.

## Full example

```typescript
import { connection, Rig } from "@bandeira-tech/b3nd-core";
import { httpPostContentApi } from "@bandeira-tech/b3nd-move/http-post-content/service";
import { payloadDecoder as dec }
  from "@bandeira-tech/b3nd-move/http-post-content/payload-decoder";

const backend = /* your ProtocolInterfaceNode */;
const rig = new Rig({ routes: { receive: [connection(backend, ["**"])] } });

Deno.serve({ port: 3000 }, httpPostContentApi(rig, {
  payloadDecoder: dec.byContentType({
    "application/json": dec.json(),
    "text/plain":       dec.text(),
    "image/*":          dec.intoField("bytes", { keepContentType: true }),
    default:            dec.raw(),
  }),
}));

// Browser, curl, anything that POSTs:
//   POST http://localhost:3000/api/v1/content/<encodeURIComponent(uri)>
//   Body: file bytes / JSON / text — decoded per the byContentType map
```

That's the whole surface — one route, one hook, one decoding decision at
instantiation time. Everything below is reference.

## Route

```text
POST /api/v1/content/<url-encoded-uri>   →  rig.receive([[uri, payload]])
```

| Outcome                       | Status                               |
| ----------------------------- | ------------------------------------ |
| receive completes             | `200` with `ReceiveResult` JSON body |
| `payloadDecoder` throws       | `400`                                |
| `rig.receive` throws          | `500`                                |
| URI not extractable from path | `404` / `400`                        |
| non-POST method               | `405` (`Allow: POST`)                |

Status is `200` even when the rig returns `accepted: false` — accept / reject is
a domain outcome and lives in the body, mirroring `POST /api/v1/receive` on
`httpApi`. Hosts that want HTTP-native status semantics wrap the handler at the
runtime layer.

## `payloadDecoder` — the one hook

```ts
type PayloadDecoder = (req: Request) => Promise<unknown>;
```

Decodes the request body into the payload that goes into
`rig.receive([[uri, payload]])`. Throws → 400.

## Helpers

All composable: `byContentType` takes `PayloadDecoder` leaves, leaves are
themselves `PayloadDecoder`.

The primitives (`json`, `text`, `raw`, `intoField`) are thin wrappers around the
`decode` half of codecs in [`src/codecs/`](../codecs/). If you also serve reads
through `http-get-content`, declare the codec once and wire `.decode` here +
`.encode` on the GET side — the wire envelope can't drift.

| Helper                                                      | Behavior                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| `dec.json()`                                                | `await req.json()`                                         |
| `dec.text()`                                                | `await req.text()`                                         |
| `dec.raw()`                                                 | `new Uint8Array(await req.arrayBuffer())`                  |
| `dec.intoField(name, { keepContentType })`                  | wrap bytes into `{ [name]: bytes, contentType? }`          |
| `dec.byContentType({ "type/sub": leaf, …, default: leaf })` | match request `Content-Type`; `type/*` wildcards supported |

`byContentType` matches case-insensitively and strips parameters
(`;charset=utf-8`, etc.) before comparison. `default` runs when no key matches;
absence → decoder throws → 400.

Custom decoders are just functions — drop in your own when the helpers don't fit
(multipart, protobuf, signed envelopes, …):

```typescript
httpPostContentApi(rig, {
  payloadDecoder: async (req) => {
    const form = await req.formData();
    return { file: await (form.get("file") as File).arrayBuffer() };
  },
});
```

## Surface

| File                 | Exports                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `service.ts`         | `httpPostContentApi`, `HttpPostContentApiOptions`, `PayloadDecoder` |
| `payload-decoder.ts` | `payloadDecoder` (helper namespace)                                 |

Split into two files because the helper set evolves on a different cadence than
the route surface — route shape is locked at
`POST /api/v1/content/<encoded-uri>`; the decoder set grows over time.

## Why this exists

`httpApi` exposes `rig.receive` as `POST /api/v1/receive` with a body of
`[[uri, payload], …]` — JSON-encoded message tuples. That's fine for SDK-to-SDK
calls but actively in the way when:

- A browser uploads a file with `fetch(url, { body: file })`.
- `curl --data-binary @file.bin` pushes raw bytes.
- A client already has the URI in the path it's hitting and doesn't want to
  double-encode it inside the body.

`http-post-content` is the specialized POST facet that solves this: same rig,
one URI in path, raw body decoded by a host-supplied hook.

## Notes

- The route is fixed at `/api/v1/content/`. The facet is a fully-locked surface
  like the rest of `httpApi` — host-level routing (mount path, middleware, CORS,
  auth) is the runtime's job, wrap the returned handler yourself.
- The facet is service-only by design. The generic `HttpClient` already covers
  programmatic receives; this facet exists for clients that can't speak it —
  `fetch` from a browser, `curl --data-binary`, raw HTTP from an embedded
  device.
