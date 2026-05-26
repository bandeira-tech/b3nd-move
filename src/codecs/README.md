# codecs

Wire-envelope codecs. The foundational concern of moving data on the physical
wire and across external standard protocols.

## Full example — round-trip a blob through both content facets

```typescript
import { connection, Rig } from "@bandeira-tech/b3nd-core";
import { httpGetContentApi } from "@bandeira-tech/b3nd-move/http-get-content/service";
import { httpPostContentApi } from "@bandeira-tech/b3nd-move/http-post-content/service";
import { field } from "@bandeira-tech/b3nd-move/codecs/field";

const backend = /* your ProtocolInterfaceNode */;
const rig = new Rig({
  routes: {
    receive: [connection(backend, ["**"])],
    read:    [connection(backend, ["**"])],
  },
});

// One declaration: the wire envelope is `{ bytes, contentType }`.
const blob = field("bytes", { contentTypeField: "contentType" });

// Both facets share the codec — encode and decode can't drift.
const get  = httpGetContentApi(rig,  { payloadResponseMap: blob.encode });
const post = httpPostContentApi(rig, { payloadDecoder:     blob.decode });

// PUT then GET round-trips the bytes:
//   POST /api/v1/content/<uri>  with Content-Type: image/png  + bytes
//   GET  /api/v1/content/<uri>  →  image/png  + same bytes
```

That's the point of this module — one declaration of the on-the-wire envelope,
both directions use it.

## The contract

```ts
interface Codec {
  encode: (req: Request, output: Output) => Promise<ContentResponseInit>;
  decode: (req: Request) => Promise<unknown>;
}
```

- `encode` is the GET-side hook (`PayloadResponseMap`). Takes a `rig.read`
  output, returns an HTTP response init.
- `decode` is the POST-side hook (`PayloadDecoder`). Takes the request, returns
  the payload that goes into `rig.receive([[uri, payload]])`.

Pair both halves on the same codec to round-trip. Use one half in isolation when
the other direction doesn't apply (read-only resources, write-only inboxes).

## Codecs shipped

| Codec               | Encode (payload → wire)                                                                                 | Decode (wire → payload)                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `json()`            | `JSON.stringify(payload)`, `Content-Type: application/json`                                             | `await req.json()`                                        |
| `text(ct?)`         | payload (must be string), `Content-Type: ct` (default `text/plain`)                                     | `await req.text()`                                        |
| `raw(ct)`           | payload (Uint8Array / ArrayBuffer / string), `Content-Type: ct`                                         | `new Uint8Array(await req.arrayBuffer())`                 |
| `field(name, opts)` | body = `payload[name]`, content-type from `payload[opts.contentTypeField]` or `opts.defaultContentType` | bytes → `{ [name]: bytes, [opts.contentTypeField]?: ct }` |

`field` is the round-trip codec when the content-type travels with the bytes.
`raw` and `text` are when the content-type is fixed at the facet wiring
(`raw("image/png")` only ever serves PNGs). `json` is the default for
protocol-shaped payloads.

## Selectors are NOT codecs

Codecs own _how_ a payload becomes bytes. They do not own _which_ codec runs for
a given request. That's the per-facet selectors:

- GET facet: `byExtension`, `byPayloadField` (in `payloadResponseMap`)
- POST facet: `byContentType` (in `payloadDecoder`)

Selectors stay in the facet helper modules because their inputs differ (URI vs.
payload field vs. request header) and they have no encode/decode symmetry —
response negotiation is read-side; body type matching is write-side.

## List framers

A different shape lives alongside the per-payload codecs: framers that pack /
unpack a _list_ of opaque byte slots into a single buffer using length-prefixed
framing. They don't implement the `Codec` interface (no `Request` / `Response`,
no content-type negotiation) — they're lower-level byte-shovelers used to carry
many slots in one wire envelope.

There's one primitive (`bytes-list`) and one string-shaped wrapper (`url-list`):

```
buf = <lenSize prefix BE><slot bytes> × N
```

`bytes-list` is parameterized over `lenSize`:

- `lenSize: 2` (u16) — slots up to 64 KiB. Used when many short slots share a
  tight envelope (e.g. URLs in a query string under a URL-length ceiling).
- `lenSize: 4` (u32) — slots up to 4 GiB. Used when slots are payload-sized and
  the envelope is an HTTP body.

`url-list` is a thin wrapper: UTF-8 each URL → `bytes-list` (`lenSize: 2`) →
url-safe base64 so the bytes survive transit inside a URL.

| File            | Exports                                                         | Used by                             |
| --------------- | --------------------------------------------------------------- | ----------------------------------- |
| `bytes-list.ts` | `encodeBytesList(slots, opts?)` / `decodeBytesList(buf, opts?)` | `POST /api/v1/receive` request body |
| `url-list.ts`   | `encodeUrlList(urls)` / `decodeUrlList(s, opts?)`               | `?u=<b64>` on every batch route     |

Decoder returns subarray views into the input buffer — no copies.

## File layout

| File            | Exports                                                           |
| --------------- | ----------------------------------------------------------------- |
| `codec.ts`      | `Codec`, `Encoder`, `Decoder`, `ContentResponseInit`              |
| `json.ts`       | `json()`                                                          |
| `text.ts`       | `text(contentType?)`                                              |
| `raw.ts`        | `raw(contentType)`                                                |
| `field.ts`      | `field(name, { contentTypeField?, defaultContentType? })`         |
| `bytes-list.ts` | `encodeBytesList` / `decodeBytesList` (list framer primitive)     |
| `url-list.ts`   | `encodeUrlList` / `decodeUrlList` (string list over `bytes-list`) |

One file per codec — the directory is meant to grow as the project absorbs more
external standards (multipart, signed envelopes, protobuf-over-HTTP, …).
