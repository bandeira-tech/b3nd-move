# Wire redesign — URI-as-URL-identity, opaque payloads

**Status:** ready to implement. Scope intentionally narrow: HTTP only, first
pass, see the shape in real code, then iterate. WS, gRPC, MCP follow once HTTP
is real.

**This is not a v2.** The project is at 0.14.0 — pre-1.0, no published SemVer
compatibility promise. We replace the existing wire in place; no parallel mount,
no deprecation window, no version-pinned clients. Breaking change is fine at
this stage and trying to avoid it would just muddy the design.

**Prereqs landed:** `Output<T>` is the canonical PIN tuple (b3nd-core),
`Message` is gone. `observe()` yields `AsyncIterable<readonly string[]>` —
uri batches with no payload slot (b3nd-core 0.20). Type contract is already
where we need it.

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
| HTTP service + client at `/api/v1/*`             | WS, gRPC, MCP                                                                |
| All four actions: status, read, receive, observe | Browser polyfills, perf benchmarks                                           |
| Frame codec module + unit tests                  | Composable cache/auth/signing services (separate proposals)                  |
| Service tests against the stub rig               | Schema discovery (URI-namespace convention is the agreement, doc separately) |
| Integration test: client ↔ service round-trip    |                                                                              |

Replaces the existing HTTP wire in place. WS and gRPC still speak the old shape
after this PR series — they get reshaped in follow-ups using the same codec.

## Decisions (no more "open questions" for first pass)

These were the things flagged for input last round; here are the calls I'm
making so we can ship. Reversible later — we're pre-1.0.

| Decision                  | Choice                                                                                                           | Why                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| URL param name            | `u`                                                                                                              | terse, only one parameter on the URL anyway                          |
| URI list framing          | url-safe-base64 of `<u16 url-len><url-utf8>` × N                                                                 | byte-safe, no separator footguns, ~no space cost                     |
| Body framing              | `<u32 payload-len><payload>` × N                                                                                 | matches receive request and read response, single codec to test      |
| Observe frame             | `<u16 count>[<u16 uri-len><uri-utf8>]*` × N stream                                                               | matches b3nd-core 0.20 observe contract: uri batches only, no payload |
| Endianness                | big-endian (network order)                                                                                       | one less thing to think about across runtimes                        |
| Empty payload             | `payload-len = 0` is legal; presence semantics live above the wire                                               | wire stays policy-free                                               |
| Per-frame size cap        | `1 << 26` (64 MiB) configurable on the service                                                                   | sane DoS protection                                                  |
| Per-request URI count cap | `1024` configurable                                                                                              | matches what the URL-length math allows anyway                       |
| Debuggability             | no NDJSON variant; `b3nd debug` CLI does framing on the client side                                              | wire stays single-shape                                              |
| Content-Type              | request: `application/octet-stream`; response: same for read, `application/json` for receive's `ReceiveResult[]` | bytes are bytes, metadata is metadata                                |
| HTTP methods              | `GET /status`; `POST` everywhere else                                                                            | no cache policy baked in; that's a separate service                  |

## Wire shape

| Action  | Method + URL                   | Request body                                   | Response                                                 |
| ------- | ------------------------------ | ---------------------------------------------- | -------------------------------------------------------- |
| status  | `GET  /api/v1/status`          | —                                              | JSON `StatusResult`                                      |
| read    | `POST /api/v1/read?u=<b64>`    | —                                              | `application/octet-stream` framed payloads × N           |
| receive | `POST /api/v1/receive?u=<b64>` | `application/octet-stream` framed payloads × N | JSON `ReceiveResult[]`                                   |
| observe | `POST /api/v1/observe?u=<b64>` | —                                              | `application/octet-stream` framed observe frames, stream |

## File plan

```
src/wire/
  frame.ts          ← codec primitives (pure, no I/O)
  frame.test.ts     ← roundtrip tests
src/http/
  service.ts        ← rewritten — same export, new wire
  client.ts         ← rewritten — same export, new wire
  service.test.ts   ← updated
  client.test.ts    ← updated (or replaces list.test.ts)
tests/integration/deno/
  http.test.ts      ← updated for new wire
tests/suites/
  move-suite.ts     ← payloads become Uint8Array end-to-end
```

`src/wire/` houses the codec because WS and gRPC will share it once they're
reshaped. Everything else is an in-place rewrite — same module paths, same
exports (`httpApi`, `HttpClient`), new contracts.

## Codec (one module, two functions per direction)

```ts
// src/wire/frame.ts

/** url-safe-base64 of <u16 len><url-utf8> × N */
export function encodeUriList(uris: string[]): string;
export function decodeUriList(param: string): string[];

/** <u32 len><payload> × N — used for receive request body and read response */
export function encodePayloads(payloads: Uint8Array[]): Uint8Array;
export function decodePayloads(body: Uint8Array): Uint8Array[];

/** <u16 count>[<u16 uri-len><uri>]* — one observe frame (uri batch) */
export function encodeObserveFrame(uris: readonly string[]): Uint8Array;

/** Streaming decoder. Yields uri-batch frames as they complete. */
export async function* decodeObserveFrames(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<readonly string[]>;
```

All length-prefixed. All big-endian. Limits parameter for `decode*`
(`maxFrameBytes`, `maxCount`) so callers can pass server config in. Pure, no
state, no I/O — trivially testable in isolation.

## Per-action behavior

**status.** `GET /api/v1/status` → `JSON.stringify(await rig.status())`. 200 if
healthy, 503 otherwise. `statusMeta` option preserved.

**read.** `decodeUriList(u)` → `rig.read(uris)` → `encodePayloads` over
`outputs.map(o => o[1] ?? new Uint8Array())`. One payload slot per requested
URI, in order. Null-payload (miss) shows up as length-0 — the client wraps each
slot back into `Output<Uint8Array>` by pairing it with the request's URI list.

**receive.** `decodeUriList(u)` and `decodePayloads(body)` zipped into
`Output<Uint8Array>[]` → `rig.receive(...)` → JSON `ReceiveResult[]`. Count
mismatch → 400.

**observe.** `decodeUriList(u)` → for-await `rig.observe(uris, signal)` → stream
`encodeObserveFrame(batch)` per yielded uri batch → close on iterator end or
request abort. Same abort wiring as the existing `ndjsonResponse`; likely
factor an `octetStreamResponse` sibling next to it in `src/actions.ts`.

Observe is **pure notification** under b3nd-core 0.20+ — each yield is a
`readonly string[]` of uris that fired, no payload slot. Content delivery is
the consumer's job via a follow-up `read`. That keeps the wire's "opaque
bytes" thesis intact: there are no observe payloads to be opaque about.

## Client surface

`HttpClient implements ProtocolInterfaceNode<Uint8Array>` — same class name,
same constructor signature, payloads typed `Uint8Array` at the boundary:

```ts
class HttpClient {
  receive(outputs: Output<Uint8Array>[]): Promise<ReceiveResult[]>;
  read(urls: string[]): Promise<Output<Uint8Array>[]>;
  observe(
    urls: string[],
    signal: AbortSignal,
  ): AsyncIterable<readonly string[]>;
  status(): Promise<StatusResult>;
}
```

Same `url`, `timeout`, `preSend` config. Errors keep the existing typed
hierarchy (`TransportError`, `RequestError`, `TimeoutError`).

## Tests

1. **Codec.** Roundtrip random URIs, payloads, mixed-empty payloads, max-size
   enforcement, malformed-input rejection. Pure.
2. **Service.** Each action against the stub rig (lives at
   `tests/rigs/stub.ts`). Asserts the wire shape — read bytes match
   `encodePayloads(...)`.
3. **Client.** Each action against a stub fetch that asserts URL and body shape,
   returns canned bytes.
4. **Integration.** `Deno.serve(httpApi(rig))` + `new HttpClient(...)` doing the
   move-suite scenarios on `Output<Uint8Array>`.

Goal: integration suite green. That's when the new wire is real.

## What composes above (out of first pass)

- Cache service — owns a GET surface, proxies to POST.
- Signed-URL service — short-lived per-URI URLs that terminate into the wire.
- Auth service — inspects URL, decides, forwards.
- Fan-out / replication — multi-target writer.

None need any move-layer change. Each gets its own proposal.

## Sequencing

1. **This PR: design doc.**
2. **Codec PR** — `src/wire/frame.ts` + tests. Tiny, easy to review, no wire
   change yet. Confidence-builder.
3. **HTTP service+client PR** — rewrite `src/http/{service,client}.ts` and the
   tests that ride along. Old tests for the old wire get replaced with new tests
   for the new wire.
4. **Integration PR** — updated `tests/integration/deno/http.test.ts`, updated
   `tests/suites/move-suite.ts` payload typing. Gates "the wire is real."
5. Decide WS/gRPC shape based on actual HTTP code; iterate from there.

Each step is small, reviewable, reversible.

## What's deferred (and why each is fine to defer)

- **WS + gRPC wire reshape.** Same idea, different framing details. Doing HTTP
  first proves the codec; WS adds binary frames, gRPC collapses into proto
  changes. Straightforward once HTTP is done.
- **MCP.** Different shape of consumer (AI tools), structured JSON is the right
  interface there. Not part of the data-plane story.
- **Composable services (cache, auth, signing).** Each its own design, each
  independent of the wire choice.
- **Schema discovery / codec conventions.** Out-of-band agreement between
  producer/consumer apps. Doc separately when there's a real case study.

## How we know first pass worked

- Integration suite green on the new wire.
- A toy "encode proto → send → store → fetch → decode proto" app on top of HTTP
  works end-to-end without the move layer ever importing the proto schema.
- We have a grounded opinion about WS/gRPC reshape based on actual HTTP code,
  not speculation.

If those three hold, we keep going. If something feels off, we change it before
WS/gRPC follow.
