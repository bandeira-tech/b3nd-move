# v2 wire — URI-as-URL-identity, opaque payloads

**Status:** proposal — not implemented. **Owners:** rafb43, claude **Tracks:**
b3nd-move, b3nd-core, downstream b3nd-save (unchanged)

## Why

Today the move layer parses every payload to read any URI. JSON forces
whole-batch decode; even gRPC's `bytes payload` rides inside a single
`ReceiveRequest` proto that has to parse end-to-end. That couples the transport
to the schema and prevents the natural shape of the system:

> The producing app and the consuming app share a schema. Everything in between
> is a dumb pipe that moves `(uri, bytes)`.

`b3nd-save` already lives at this contract — `(uri, bytes)` storage,
schema-agnostic. The move layer is the missing half. Once both halves match,
capabilities that don't belong in either (caching, signed-upload URLs, auth,
fan-out, replication) compose as separate services above the pipe, each
operating on the same shared handle: the URL.

## Principles

1. **URI is in the transport's identity slot.** HTTP URL, WS frame header, gRPC
   metadata. Routing/auth/observability/sharding work without inspecting bodies.
2. **Payloads are opaque bytes.** Move never deserializes; apps encode at one
   edge, decode at the other.
3. **No baked-in policy.** Caching, signed URLs, auth — these are composable
   services that sit above this pipe. The wire ships policy-free (POST
   everywhere read-or-write happens, GET only for genuinely static metadata like
   `status`).
4. **The core type stays open.** `Output<T>`'s payload remains generic so
   non-byte uses (in-process composition, tests, structured rigs) still work.
   Move-layer transports cast to `Output<Uint8Array>` at their boundary.

## Wire shape

URIs travel in the URL as one `?u=` parameter — a length-prefix-framed,
url-safe-base64 list — so any URI bytes are safe and we waste no space on
repeated `&u=`/percent-encoding. Bodies, when present, carry only
length-prefixed opaque payload bytes, positionally matching the decoded URI
list.

| Action  | Method + URL                   | Body                                    | Response                                   |
| ------- | ------------------------------ | --------------------------------------- | ------------------------------------------ |
| status  | `GET  /api/v2/status`          | —                                       | JSON `StatusResult`                        |
| read    | `POST /api/v2/read?u=<b64>`    | —                                       | binary frames: `<u32 len><payload>` × N    |
| receive | `POST /api/v2/receive?u=<b64>` | binary frames: `<u32 len><payload>` × N | JSON `ReceiveResult[]` (small, structured) |
| observe | `POST /api/v2/observe?u=<b64>` | —                                       | binary frame stream — see below            |

### URL encoding: `?u=<urlsafe-b64>`

The base64 decodes to a length-prefixed byte-record:

```
<u16 url-byte-len><url-utf8> × N
```

Why length-prefixed inside the base64 (vs. simply comma-joined): byte-safe
against any URI content, zero ambiguity, ~no space cost for typical URIs. `u16`
caps a single URI at 64KiB which is plenty (longest sensible URIs are sub-KiB).

Total URL ceiling: roughly 48KiB of URI text after base64 inflation, inside a
64KiB browser-safe URL — hundreds of URIs per request.

### Body framing (receive request, read response)

```
<u32 payload-byte-len><payload> × N
```

`payload-byte-len = 0` is legal — represents a present-but-empty payload. For
deletion / not-present, the API uses a sentinel structure at the rig/save layer;
the wire doesn't need a special encoding for it because read responses are
positional.

Content-Type:

- request: `application/octet-stream` (we're not negotiating schema here)
- response: `application/octet-stream` for read; `application/json` for
  receive's `ReceiveResult[]` (small, structured metadata, not payload)

### Observe response

Each frame is a length-prefixed binary record carrying `<uri, payload>`:

```
<u16 uri-len><uri-utf8><u32 payload-len><payload>
```

terminated by frame-len=0 / connection close. This preserves opacity end-to-end
and matches the receive framing style.

Open question — see below — on whether to keep an NDJSON variant for
debuggability.

## Type contracts

In `b3nd-core`:

- **`Message` is deprecated**; remove from move-layer surfaces. The canonical
  tuple is `Output<T>` for both inputs (receive) and outputs (read, observe
  frames).
- `Output<T = unknown> = [uri: string, payload: T | null]` — payload generic
  stays open. **Do not** narrow the core type to `Uint8Array`; the wire is just
  one consumer of `Output` and shouldn't force its representation upstream.
- `ProtocolInterfaceNode` keeps `Output<T>` everywhere — same generic story.
- Move-layer service/client signatures concretize to `Output<Uint8Array>` at the
  wire boundary. Apps cast: an app that speaks proto on top of move sends
  `Output<Uint8Array>` containing pre-serialized proto bytes; an in-process rig
  composition that never crosses move can keep `Output<MyDecodedType>`.

## Per-transport changes

### HTTP (`src/http/{service,client}.ts`)

- Routes change to `/api/v2/*` as in the table.
- Client builds URL with `u=<framed-b64>`; serializes/deserializes payload
  frames; never JSON-parses payload bytes.
- Service does the inverse.
- `httpApi` keeps its `(Request) => Promise<Response>` signature.

### WS (`src/ws/{service,client}.ts`)

- Per-message envelope becomes two frames over the same `id`:
  1. text frame: `{ id, type, uris: <b64-framed list> }`
  2. binary frame: receive payloads / read response — concatenated
     length-prefixed records
- Observe streams binary frames per match (header text frame at subscribe, then
  binary frames per event, plus a final empty terminator text frame with
  `data: null`).
- `observe-cancel` unchanged.

Why two frames vs. one: WS is a frame protocol and binary frames don't nest.
Keeping the routing metadata on a text frame and bytes on a binary frame matches
how every other WS-binary system does it.

### gRPC-HTTP (`src/grpc/http/{service,client}.ts`)

- Proto schema reshapes:
  - `ReceiveRequest { repeated string uris; repeated bytes payloads }`
  - `ReadRequest { repeated string uris }`
  - `ReadResponse { repeated bytes payloads }`
  - `ObserveRequest { repeated string uris }`
  - `ObserveFrame { string uri; bytes payload }` — streamed
- Already byte-aligned; this is mostly a clean-up of the wrappers.

### MCP (`src/mcp/service.ts`)

- MCP isn't a generic data plane — it's a tool surface for AI clients and is
  allowed to keep structured-JSON payloads. **Out of scope** for v2 wire.
  Document the asymmetry.

## What composes above

These don't go in the move layer. They become wire-able service kinds that
someone runs in front of (or beside) `httpApi(rig)`:

- **Cache service** — owns a GET surface, proxies to v2 POST, decides
  cacheability. The pipe stays cache-policy-free.
- **Signed-URL service** — owns short-lived per-URI URLs for upload / download.
  Hands clients a URL; that URL terminates into the v2 wire.
- **Auth service** — inspects URL, decides yes/no, forwards to v2.
- **Replication / fan-out** — multi-target writer that takes v2 receive, fans
  out to multiple downstream pipes.

Each of these reads only the URL; none parse payload bytes. That's the whole
point — every middlebox shares the same cheap routing primitive.

## Cross-repo ripple

| Repo      | Change                                                                        | Risk |
| --------- | ----------------------------------------------------------------------------- | ---- |
| b3nd-core | Retire `Message`; rig methods take `Output[]`; payload type stays generic.    | Med  |
| b3nd-move | All four transports' service + client + tests rewritten for v2 wire.          | High |
| b3nd-save | No change — already `(uri, bytes)`. Alignment becomes the proof point.        | None |
| Apps      | Encode/decode moves to app boundaries; previously-implicit JSON now explicit. | Med  |

## Migration

- **Path-versioned**: `/api/v2/...` lives next to `/api/v1/...` while both
  server and clients migrate. Servers can mount both; clients pin a version.
- **No coexistence on the same path** — the routing primitive changes (URL
  identity), so a single route can't speak both.
- **Drop v1** at the next minor that ships v2 stably (the project is early
  enough that we don't need a long deprecation window — verify with downstream
  consumers before cutting).

## Open questions

1. **NDJSON variant for observe / read responses?** Binary is opaque-preserving
   but ungrepable. Option: keep a `?debug=1` mode that emits
   NDJSON-of-`{uri, b64}` for inspection. Cheaper option: a
   `b3nd debug read URI` CLI that does the framing on the client side. Probably
   the CLI.
2. **URL param name.** `u` (terse) vs. `urls` (self-documenting). Leaning `u`.
3. **Receive request: per-frame size cap?** Server should reject framed records
   above some max-payload-bytes to protect against pathological clients. What's
   the default? 16 MiB?
4. **gRPC: unary vs. streaming for observe?** Server-streaming RPC is the
   natural fit and aligns frame-by-frame with the HTTP binary stream.
5. **Status payload itself opaque?** No — `StatusResult` is server metadata, not
   domain content. Keep structured JSON.
6. **Codec discovery.** The pipe doesn't negotiate schema. The agreement between
   producer and consumer is out-of-band, usually by URI namespace convention
   (e.g. `b3nd://proto/v1/Foo/...` implies `Foo` proto). Document that
   convention separately; not part of this proposal.

## Sequencing

1. **Land #18** — small actions.ts refactor. Independent of v2; ships either
   way.
2. **b3nd-core v0.18** — `Output`-typed PIN/Rig, `Message` removed. Tested in
   isolation against in-process rigs.
3. **b3nd-move HTTP v2** — service + client + tests behind `/api/v2/*`. Both
   versions live side-by-side until WS + gRPC catch up.
4. **b3nd-move WS v2** — service + client parity.
5. **b3nd-move gRPC v2** — proto reshape + service + client parity.
6. **Cut b3nd-move v0.15** with v2 wire on all transports, v1 still reachable.
7. **Cut v0.16** (or v1.0) removing v1 once downstreams confirm.

## What this does _not_ try to do

- HTTP-cache semantics (composable cache service, separate proposal).
- Auth / capability tokens (composable auth service, separate proposal).
- Signed upload URLs (composable signing service, separate proposal).
- Schema discovery / codec negotiation (out-of-band, URI convention).
- Stream resumption / replay (rig-level concern, not wire).
