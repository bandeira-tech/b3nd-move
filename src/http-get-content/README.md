# http-get-content

GET-only HTTP read facet. Single URI in, host-shaped response out.

## Full example

```typescript
import { connection, Rig } from "@bandeira-tech/b3nd-core";
import { httpGetContentApi } from "@bandeira-tech/b3nd-move/http-get-content/service";
import { payloadResponseMap as map }
  from "@bandeira-tech/b3nd-move/http-get-content/payload-response-map";

const backend = /* your ProtocolInterfaceNode */;
const rig = new Rig({ routes: { read: [connection(backend, ["*"])] } });

Deno.serve({ port: 3000 }, httpGetContentApi(rig, {
  payloadResponseMap: map.byExtension({
    png:  map.fromField("bytes", { contentType: "image/png" }),
    txt:  map.fromField("text",  { contentType: "text/plain" }),
    json: map.json(),
    "*":  map.json(),
  }),
}));

// Browser, CDN, curl, <img src>, anything that does GET:
//   GET http://localhost:3000/api/v1/content/<encodeURIComponent(uri)>
```

That's the whole surface — one route, one hook, one mapping decision at
instantiation time. Everything below is reference.

## Route

```text
GET /api/v1/content/<url-encoded-uri>   →  rig.read([uri])  (single)
```

| Outcome                        | Status                 |
| ------------------------------ | ---------------------- |
| read OK, hook returns response | `200` (or hook-chosen) |
| `rig.read` throws              | `500`                  |
| hook throws                    | `500`                  |
| no result for URI              | `404`                  |
| URI not extractable from path  | `404` / `400`          |
| non-GET method                 | `405` (`Allow: GET`)   |

## `payloadResponseMap` — the one hook

```ts
type PayloadResponseMap = (
  req: Request,
  output: Output, // [uri, payload]
) => Promise<ContentResponseInit>;

interface ContentResponseInit {
  body: BodyInit;
  headers?: HeadersInit;
  status?: number; // default 200
}
```

Owns content-type, body bytes, extra headers, and (optionally) status in one
decision per output. Miss semantics are the host's call — handle
`payload == null` inside the hook however you want; the facet never
second-guesses payload contents.

## Helpers

All composable: selectors take `PayloadResponseMap` leaves, leaves are
themselves `PayloadResponseMap`.

The primitives (`json`, `text`, `raw`, `fromField`) are thin wrappers around the
`encode` half of codecs in [`src/codecs/`](../codecs/). If you also serve writes
through `http-post-content`, declare the codec once and wire `.encode` here +
`.decode` on the POST side — the wire envelope can't drift.

| Helper                                         | Behavior                                               |
| ---------------------------------------------- | ------------------------------------------------------ |
| `map.json()`                                   | `JSON.stringify(payload)` + `application/json`         |
| `map.text(contentType?)`                       | payload (string) + content-type (default `text/plain`) |
| `map.raw(contentType)`                         | payload must be `Uint8Array \| ArrayBuffer \| string`  |
| `map.fromField(name, { contentType })`         | body = `payload[name]`, content-type as given          |
| `map.fixed(init)`                              | pin a fully-specified response (ignores output)        |
| `map.byExtension({ ext: leaf, … })`            | select by URI extension; `"*"` falls back              |
| `map.byPayloadField(name, { value: leaf, … })` | select by `payload[name]`; `"*"` falls back            |

Custom hooks are just functions — drop in your own where the helpers don't fit:

```typescript
httpGetContentApi(rig, {
  payloadResponseMap: async (req, [uri, payload]) => {
    if (payload == null) return { body: "gone", status: 404 };
    return await map.json()(req, [uri, payload]);
  },
});
```

## Surface

| File                      | Exports                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `service.ts`              | `httpGetContentApi`, `HttpGetContentApiOptions`, `PayloadResponseMap`, `ContentResponseInit` |
| `payload-response-map.ts` | `payloadResponseMap` (helper namespace)                                                      |

The two files are split because they evolve on different cadences — the route
shape is locked at `GET /api/v1/content/<encoded-uri>`; the helper set grows
over time.

## Why this exists

`httpApi` exposes `rig.read` as `POST /api/v1/read` with a JSON-encoded
`Output[]` body. That's fine for SDK-to-SDK calls but actively in the way when:

- A browser wants to embed content (`<img src=...>`, `<a download>`).
- A CDN should cache the response by URL.
- A consumer wants a real `Content-Type` instead of an opaque `application/json`
  envelope around base64 bytes.

`http-get-content` is the specialized GET facet that solves this: same rig, one
URI per request, host-controlled response shape.

## Notes

- The route is fixed at `/api/v1/content/`. The facet is a fully-locked surface
  like the rest of `httpApi` — host-level routing (mount path, middleware, CORS,
  auth) is the runtime's job, wrap the returned handler yourself.
- The facet is service-only by design. The generic `HttpClient` already covers
  programmatic reads; this facet exists for clients that can't speak it — embed
  it in `<img src>`, point a CDN at it, `curl` it.
