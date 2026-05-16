# v2 wire — first pass (HTTP only)

**Status:** ready to implement. Scope intentionally narrow: HTTP only, land it
next to v1, see the shape in real code, then iterate. WS, gRPC, MCP, deprecation
strategy — all deferred to follow-ups.

**Prereq landed:** `Output<T>` is now the canonical PIN tuple (b3nd-core),
`Message` is gone. Type contract change is behind us.

## The idea (one paragraph)

The move layer becomes a true dumb pipe: URI rides in the URL (HTTP's identity
slot), payload rides as opaque bytes (no JSON-parsing). That matches
`b3nd-save`'s `(uri, bytes)` storage shape, lets caching / signed-URL / auth /
fan-out compose above as separate services without peeking at bodies, and pushes
encode/decode to the only two places that have the schema — the producing app
and the consuming app.

## First-pass scope

| In                                               | Out (for now)                                                                |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| HTTP service + client at `/api/v2/*`             | WS, gRPC, MCP                                                                |
| All four actions: status, read, receive, observe | Browser polyfills, perf benchmarks                                           |
| Frame codec module + unit tests                  | v1 deprecation, removal                                                      |
| Service tests against the stub rig               | Composable cache/auth/signing services (separate proposals)                  |
| Integration test: client ↔ service round-trip    | Schema discovery (URI-namespace convention is the agreement, doc separately) |

v1 stays mounted on `/api/v1/*` and untouched. v2 lives at `/api/v2/*`. Both
servers and clients pick a version.

## Decisions (no more "open questions" for first pass)

These were the things flagged for input last round; here are the calls I'm
making so we can ship. Reversible later.

| Decision                  | Choice                                                                                                           | Why                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| URL param name            | `u`                                                                                                              | terse, only one parameter on the URL anyway                          |
| URI list framing          | url-safe-base64 of `<u16 url-len><url-utf8>` × N                                                                 | byte-safe, no separator footguns, ~no space cost                     |
| Body framing              | `<u32 payload-len><payload>` × N                                                                                 | matches receive request and read response, single codec to test      |
| Observe frame             | `<u16 uri-len><uri-utf8><u32 payload-len><payload>` × N stream                                                   | preserves opacity end-to-end; same byte-order/endian as body framing |
| Endianness                | big-endian (network order)                                                                                       | one less thing to think about across runtimes                        |
| Empty payload             | `payload-len = 0` is legal; presence semantics live above the wire                                               | wire stays policy-free                                               |
| Per-frame size cap        | `1 << 26` (64 MiB) configurable on the service                                                                   | sane DoS protection                                                  |
| Per-request URI count cap | `1024` configurable                                                                                              | matches what the URL-length math allows anyway                       |
| Debuggability             | no NDJSON variant in v2; `b3nd debug` CLI does framing on the client side                                        | wire stays single-shape                                              |
| Content-Type              | request: `application/octet-stream`; response: same for read, `application/json` for receive's `ReceiveResult[]` | bytes are bytes, metadata is metadata                                |
| HTTP methods              | `GET /status`; `POST` everywhere else                                                                            | no cache policy baked in; that's a separate service                  |

## Wire shape

| Action  | Method + URL                   | Request body                                   | Response                                                 |
| ------- | ------------------------------ | ---------------------------------------------- | -------------------------------------------------------- |
| status  | `GET  /api/v2/status`          | —                                              | JSON `StatusResult`                                      |
| read    | `POST /api/v2/read?u=<b64>`    | —                                              | `application/octet-stream` framed payloads × N           |
| receive | `POST /api/v2/receive?u=<b64>` | `application/octet-stream` framed payloads × N | JSON `ReceiveResult[]`                                   |
| observe | `POST /api/v2/observe?u=<b64>` | —                                              | `application/octet-stream` framed observe frames, stream |

## File plan

```
src/v2/
  frame.ts          ← codec primitives (pure, no I/O)
  frame.test.ts     ← roundtrip tests
src/http/v2/
  service.ts        ← (Request) => Promise<Response> at /api/v2/*
  client.ts         ← ProtocolInterfaceNode over v2 wire
  service.test.ts   ← unit, with stub rig
  client.test.ts    ← unit, with a stub fetch
tests/integration/deno/
  http-v2.test.ts   ← real Deno.serve(httpV2Api(rig)) + httpV2Client, round-trip
deno.json
  + "./http/v2/service": "./src/http/v2/service.ts"
  + "./http/v2/client":  "./src/http/v2/client.ts"
```

Why `src/v2/` for the codec instead of `src/v2-frame.ts`: WS and gRPC follow-ups
will share the codec, so it earns its own folder. Putting the HTTP-specific
pieces in `src/http/v2/` keeps the v1 HTTP files untouched.

## Codec (one module, two functions per direction)

```ts
// src/v2/frame.ts

/** url-safe-base64 of <u16 len><url-utf8> × N */
export function encodeUriList(uris: string[]): string;
export function decodeUriList(param: string): string[];

/** <u32 len><payload> × N — used for receive request body and read response */
export function encodePayloads(payloads: Uint8Array[]): Uint8Array;
export function decodePayloads(body: Uint8Array): Uint8Array[];

/** <u16 uri-len><uri><u32 payload-len><payload> — used for one observe frame */
export function encodeObserveFrame(out: Output<Uint8Array>): Uint8Array;

/** Streaming decoder. Yields frames as they complete. */
export async function* decodeObserveFrames(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<Output<Uint8Array>>;
```

All length-prefixed. All big-endian. Two limits parameter for `decode*`
(maxFrameBytes, maxCount) so callers can pass server config in. No internal
state, no allocation surprises — these are the only thing the move layer needs
to be correct about, and they're trivially testable in isolation.

## Per-action behavior

**status.** `GET /api/v2/status` → `JSON.stringify(await rig.status())`. 200 if
healthy, 503 otherwise. Same `statusMeta` option as v1.

**read.** `decodeUriList(u)` → `rig.read(uris)` → `encodePayloads` over
`outputs.map(o => o[1] ?? new Uint8Array())`. Response carries one payload slot
per requested URI in order. Null-payload (miss) shows up as length-0 — the
client wraps each slot in `Output<Uint8Array>` by pairing it back with the
request's URI list.

**receive.** `decodeUriList(u)` and `decodePayloads(body)` zipped into
`Output<Uint8Array>[]` → `rig.receive(...)` → JSON `ReceiveResult[]`. URI-count
and payload-count mismatch → 400.

**observe.** `decodeUriList(u)` → for-await `rig.observe(uris, signal)` → stream
`encodeObserveFrame(frame)` per match → close on iterator end or request abort.
Same abort wiring as v1 `ndjsonResponse`; might factor out an
`octetStreamResponse` helper if it's clean.

## Client surface

`HttpV2Client implements ProtocolInterfaceNode<Uint8Array>`:

```ts
class HttpV2Client {
  receive(outputs: Output<Uint8Array>[]): Promise<ReceiveResult[]>;
  read(urls: string[]): Promise<Output<Uint8Array>[]>;
  observe(
    urls: string[],
    signal: AbortSignal,
  ): AsyncIterable<Output<Uint8Array>>;
  status(): Promise<StatusResult>;
}
```

Same shape as v1 `HttpClient`, just typed as `Uint8Array` payloads at the
boundary. Same `url`, `timeout`, `preSend` config. Errors translate to the
existing typed hierarchy (`TransportError`, `RequestError`, `TimeoutError`).

## Tests

1. **Codec.** Roundtrip random URIs, payloads, mixed-empty payloads, max-size
   enforcement, malformed-input rejection. Pure.
2. **Service.** Each action against the stub rig (which already lives in
   `tests/rigs/stub.ts`). Asserts the wire shape — read bytes match
   `encodePayloads(...)`.
3. **Client.** Each action against a stub fetch that asserts URL and body shape,
   returns canned bytes.
4. **Integration.** `Deno.serve(httpV2Api(rig))` + `new HttpV2Client(...)` doing
   the existing move-suite scenarios on `Output<Uint8Array>`.

Goal: integration suite passes. That's when v2 is "real."

## What composes above (still, but explicitly out of first pass)

- Cache service — owns a GET surface, proxies to v2 POST.
- Signed-URL service — short-lived per-URI URLs that terminate into v2.
- Auth service — inspects URL, decides, forwards.
- Fan-out / replication — multi-target writer over v2.

None of these need any move-layer change. They get the same URL handle and never
read payload bytes. Each gets its own proposal when it's its turn.

## Sequencing

1. **This PR: design doc** (you're reading it).
2. **Codec PR** — `src/v2/frame.ts` + tests. Tiny, easy to review, no wire
   change. Confidence-builder.
3. **HTTP service PR** — `src/http/v2/service.ts` + tests, mounted at
   `/api/v2/*`. v1 untouched.
4. **HTTP client PR** — `src/http/v2/client.ts` + tests.
5. **Integration test PR** — round-trip suite. Gates "v2 is real."
6. Then we look at what we've got, decide the WS/gRPC shape based on actual
   feedback from using v2, and iterate from there.

Each step is small, reviewable, reversible. None of them touch v1.

## What's deferred (and why each is fine to defer)

- **WS v2 + gRPC v2** — same idea, different framing details. Doing HTTP first
  proves the codec; WS adds binary frames, gRPC mostly collapses into proto
  changes. Both straightforward once HTTP is done.
- **MCP** — different shape of consumer (AI tools), structured JSON is the right
  interface there. Not part of the data-plane story.
- **v1 deprecation** — happens when downstreams have moved, not on a fixed
  clock.
- **Composable services (cache, auth, signing)** — each is its own design, each
  is independent of move v2's wire choice.
- **Schema discovery / codec conventions** — out-of-band agreement between
  producer/consumer apps. Doc separately when there's a real case study.

## How we know first pass worked

- Integration suite green.
- A toy "encode proto → send → store → fetch → decode proto" app on top of v2
  works end-to-end without move ever importing the proto schema.
- We have an opinion about WS/gRPC v2 that's grounded in actual v2 HTTP code,
  not speculation.

If those three hold, we keep going. If something feels off, we change it before
WS/gRPC follow it.
