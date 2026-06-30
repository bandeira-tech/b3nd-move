# Operator-declared codecs on batch-payload routes — Design

**Status:** Draft, pending review.
**Date:** 2026-06-30.
**Branch context:** `feat/scheduler-seam-and-ws-cancel` (PR #50 follow-up).

## Summary

Each transport service factory (`httpApi`, `wsApi`, `grpcHttpApi`, `mcpApi`) requires the operator to declare an explicit `codec` covering the wire's batch-payload routes (read response, receive body). No defaults. The same codec object gets imported on the app developer's client side. The `Scheduler` operational seam relocates from the action layer into the codecs that need it.

This replaces the architecture introduced in PR #50, where `readAction` materialized `ReadableStream<Uint8Array>` payloads as a shared, wire-blind default — preempting a decision that belongs to the codec layer and silently foreclosing streaming for facets that should have it (M2 in the PR disclosure).

## Background

### What PR #50 actually changed

PR #50 hoisted stream-materialization from per-route encoders into a shared `readAction`, on the premise that "three transport encoders had the same problem, so consolidate upstream." The follow-up `feat(actions): typed Scheduler injection seam on readAction` then added a `Scheduler` type at the action layer to give hosts an operational policy hook (concurrency cap, byte budget) over the materialize work.

### What that revealed in retrospect

Materialize-at-action was the wrong layer. The decision "should this payload be coerced into bytes" is:

- **Wire-aware** — JSON envelopes (WS, MCP) physically can't carry a `ReadableStream`; binary frames (HTTP outputs-frame, gRPC proto bytes) can. The action layer is wire-blind.
- **Operator-declared** — different operators of the same wire want different shape contracts (lossy `{0:n,…}` byte encoding vs base64-tagged; outputs-frame vs NDJSON; materialized vs streaming). The action layer is operator-blind.
- **Already-modeled-elsewhere** — the codec pattern in `src/codecs/codec.ts` and its consumers in `httpGetContentApi` / `httpPostContentApi` already express this concern correctly. The action layer duplicated and conflated it.

The Scheduler seam added at the action layer was a partial correction to the same architectural pressure: it gave the host *operational* control while keeping the *shape* decision at the action. Once the shape decision moves out of the action, the Scheduler's binding site needs to move with the work — wherever materialization actually happens.

### Out-of-band conventions vs in-band negotiation

b3nd-move sits between two parties:

- **Known-parties regime** (team coordinating app data): app dev and operator agree on the shape contract out-of-band — they wrote both ends. Coordination is implicit because the contract is shared.
- **Decentralized regime** (app dev consuming a rig whose backend they didn't write): explicit negotiation between the app dev's client and the b3nd-move PIN that fronts the unknown backend. Where it happens, it happens *in the wire's native dialect* (HTTP Accept, gRPC metadata, etc.) — not in a b3nd-defined negotiation protocol.

Both regimes resolve to "pick a codec." The known-parties regime picks one statically; the decentralized regime picks one dynamically (via a codec that itself implements wire-native negotiation, like the existing `byExtension` / `byPayloadField` selectors in `src/http-get-content/payload-response-map.ts`). b3nd ships no negotiation protocol of its own — that would conflict with wire reality, which is what b3nd designs for.

## Architectural principles (forcing functions for every decision below)

1. **The wire is a courier, not a contract holder.** Each wire's only honest assertion is what it physically can carry. Shape decisions are between the parties at each end, not properties of the wire.
2. **Codecs are the seam.** b3nd-move is itself a PIN that translates between wire and rig — encoding and decoding is its one job. Shape coercion goes there, and only there.
3. **Operator declares; mismatches break naturally.** The operator picks a codec when constructing the service; the app dev picks a matching one when constructing the client. If they don't match, the app doesn't work — same as any wire mismatch. b3nd does not detect, warn, or negotiate the mismatch.
4. **No defaults, no auto-wiring at the b3nd-move boundary.** Existing baked behaviors get named as exported codecs so migration is one import + one keyword argument; the framework no longer ships an opinion silently.
5. **Each layer owns the concerns its position knows about.** Actions wrap rig methods. Codecs shape wire payloads. Schedulers, if any, are operational concerns of codecs that do materialize work — they live with that work, not at the layer above.
6. **No b3nd-level negotiation protocol.** Decentralized negotiation is implementable as a codec that dispatches on the wire's native primitives (Accept headers, envelope fields). The framework provides the seam; protocols / apps provide the negotiating codecs they need.

## Design

### Public surface change

Every transport's service factory requires `codec`:

```ts
httpApi(rig, { codec })
wsApi(rig, { codec })
grpcHttpApi(rig, { codec })
mcpApi(rig, { codec })
```

There is no other option on these factories that this design introduces. `codec` is a symmetric `Codec` pair: `.encode` shapes the read response; `.decode` shapes the receive body. No `scheduler?`, no defaults, no fallbacks.

Client side mirrors:

```ts
new HttpClient({ url, codec })
new WebSocketClient({ url, codec })
new GrpcHttpClient({ url, codec })
mcpClient({ codec })
```

The app developer imports the same exported codec the operator imported, and passes it at construction. If they don't, the app fails.

### Codec interface (per-wire types)

Each wire defines its own batch-codec type because each wire's request/response signatures differ. The existing `Codec` in `src/codecs/codec.ts` (HTTP single-URI content, single output) is preserved untouched and continues to serve `httpGetContentApi` / `httpPostContentApi`. New batch-codec types are added per wire:

- **`src/http/codec.ts`** — `HttpBatchCodec` (encodes `Output[]` to `Response`; decodes `Request` to `Output[]`).
- **`src/ws/codec.ts`** — `WsBatchCodec` (encodes `Output[]` to a frame payload — `string` or `Uint8Array` for unary, `AsyncIterable<...>` for streaming variants; decodes inbound frame payload to `Output[]`).
- **`src/grpc/http/codec.ts`** — `GrpcBatchCodec` (encodes `Output[]` to a `ReadResponse` proto message; decodes `ReceiveRequest` proto message to `Output[]`).
- **`src/mcp/codec.ts`** — `McpBatchCodec` (encodes `Output[]` to `McpContent[]` for `CallToolResult.content`; decodes tool-call `arguments` to `Output[]`).

Each `encode` / `decode` accepts a per-request context carrying:
- the dispatcher's `AbortSignal` (signal propagation already established in PR #50 and the cancel fix);
- any wire-specific request handles the codec needs (e.g., HTTP's `Request` object for Accept inspection by negotiating codecs);
- nothing else. No scheduler in the ctx; see below.

### Scheduler lives with the codec, not with the factory

The `Scheduler` type from PR #50's follow-up survives unchanged in shape — it's a useful primitive. What changes is its binding site and home.

- **Move:** `src/actions/scheduler.ts` → `src/codecs/scheduler.ts`. Locations reflect ownership: actions are rig-method wrappers; codecs do wire coercion; schedulers govern materialize fan-out, which only codecs do.
- **Codecs that materialize accept a Scheduler at construction.** Example: `wsJsonEnvelopeMaterializing({ scheduler? })`. The operator constructs the codec with a scheduler when they want fan-out bounded, without when they don't. The factory call doesn't change — still `wsApi(rig, { codec })`.
- **Codecs that stream or otherwise don't materialize have no scheduler in their interface.** They neither accept nor silently ignore one. A `wsBinarySlotStream` codec's constructor signature simply doesn't have that slot.
- **`makeReadAction` is deleted.** `readAction` is the trivial `(rig, [urls]) => rig.read(urls)`. The action layer's role is restored to "wrap a rig method," nothing more.

The deeper principle: a service factory's API should reflect *only* what the factory unambiguously needs. The factory needs a codec (we just decided no defaults). Operational policy (scheduler) is conditional on which codec; conditional concerns live with their condition, not at a higher layer. This matches how `field(name, { contentTypeField, defaultContentType })` and `text(contentType?)` already configure codecs at construction.

### v1 codec catalog

Each wire ships the today's-baked behavior as a named, exported codec, plus 1–2 alternatives with clear use cases. The rest of the menu (sketched in brainstorm; see Appendix B) is open seam — users can write their own; b3nd ships what we know we need.

| Wire | v1 named codecs | Use case |
|---|---|---|
| HTTP | `httpOutputsFrame` | Today's behavior, made explicit. Batch reads + receives over the outputs-frame binary envelope. |
| HTTP | `httpNdjson` | NDJSON one-slot-per-line. Streaming-friendly clients that process slots as they land. |
| WS | `wsJsonEnvelope` | Today's behavior, made explicit. JSON envelope; lossy `{0:n,…}` byte encoding per existing WS README. |
| WS | `wsJsonEnvelopeBase64` | Same envelope, byte-faithful (PR #50's M1 fix). Apps shipping binary blobs alongside JSON. |
| gRPC | `grpcProto` | Today's behavior, made explicit. Proto with binary `payload` slot when `payloadIsBinary`; JSON fallback otherwise. |
| MCP | `mcpTextJsonStringify` | Today's behavior, made explicit. One `TextContent` with stringified `Output[]`. |
| MCP | `mcpResourcePerSlot` | One `ResourceContent` per slot. Bytes → `blob` (base64); text → `text`; object → JSON `text`. Byte-faithful, idiomatic MCP. |

Codecs that materialize and accept a Scheduler ship as factory functions (`wsJsonEnvelope({ scheduler? })`); codecs that don't ship as values. Both shapes are honest about what they accept.

The deferred catalog (`wsBinaryOutputsFrame`, `wsNdjsonText`, `wsBinarySlotStream`, `mcpTextPerSlot`, `mcpMixedContent`, chunked-outputs-frame streaming, server-streaming proto variant) is documented in Appendix B and not implemented in v1.

### `src/actions/ndjson.ts` re-home

The `ndjson` helper today supports the observe encoder (streaming text response). It's a codec-shaped concern that lives in the wrong directory because of historical layering. `src/actions/ndjson.ts` moves to `src/codecs/ndjson.ts`. No semantic change; just relocation. Its only consumer is the observe response encoder, which stays inside the transport's own observe route module — only the import path changes.

(Observe itself is not codec-ified in v1; see "Out of v1" below. The relocation prepares the ground without committing to the larger work.)

## Scope

### In v1

1. New batch-codec types per transport (`HttpBatchCodec`, `WsBatchCodec`, `GrpcBatchCodec`, `McpBatchCodec`) in `src/<transport>/codec.ts` modules.
2. Service factories require `{ codec }`. No defaults. Explicit error if missing.
3. Clients require `{ codec }`. Same enforcement.
4. Today's baked behavior per wire shipped as named codecs in the catalog above.
5. `wsJsonEnvelopeBase64` shipped (resolves PR #50 M1 follow-up).
6. `mcpResourcePerSlot` shipped (gives MCP the byte-faithful path it needs).
7. `httpNdjson` shipped (covers HTTP's streaming-friendly use case without designing chunked outputs-frame).
8. `Scheduler` relocates: `src/actions/scheduler.ts` → `src/codecs/scheduler.ts`. `makeReadAction` deleted. `readAction` is `(rig, [urls]) => rig.read(urls)`.
9. `src/actions/ndjson.ts` → `src/codecs/ndjson.ts` (consistency move).
10. The four `src/<transport>/read.test.ts` files PR #50 added are deleted; coverage moves to `moveSuite` (extended with a stream-payload sentinel through `stubRig`) and `mcpSpec`.
11. `http-get-content` is untouched.

### Out of v1

- **Observe codec-ification.** Observe today encodes to NDJSON via `src/actions/ndjson.ts`. Codec-ifying observe is consistent but out of scope; the existing baked encoding stays. The relocated `ndjson` helper supports it without exposing it as a configurable codec yet.
- **Status codec-ification.** Status returns a small JSON-able object; no meaningful codec menu. Stays baked.
- **Receive's per-content-type dispatch on HTTP.** Today's `byContentType` selector in HTTP receive routes dispatches POST bodies through registered codecs. v1 keeps this but expresses today's behavior as `httpOutputsFrame.decode` for the canonical receive-body shape. Per-content-type dispatch can be expressed as a custom codec built on top.
- **Negotiating codecs.** None shipped. The seam is open; the `byExtension` / `byPayloadField` / `byContentType` selectors in `src/http-get-content/payload-response-map.ts` are the pattern for anyone who wants to build one.
- **`http-get-content`** stays untouched — its codec-pick surface is already correct.

## Migration

v1 is breaking. Today's `httpApi(rig)` etc. no longer compile / runtime-error without `{ codec }`. Mitigation:

- Existing behavior gets named exports per wire. Migration is one import + one keyword argument per service factory and per client:
  ```diff
  - import { httpApi } from "@bandeira-tech/b3nd-move/http";
  - httpApi(rig)
  + import { httpApi } from "@bandeira-tech/b3nd-move/http";
  + import { httpOutputsFrame } from "@bandeira-tech/b3nd-move/codecs/http";
  + httpApi(rig, { codec: httpOutputsFrame })
  ```
- No silent fallbacks, no deprecation warnings. Operators who miss the change get an explicit error at startup.
- CHANGELOG notes the change and points to the codec catalog. README per transport shows the today's-baked-equivalent setup as the first example.

The Scheduler relocation is also breaking for any host using `makeReadAction(scheduler)` or importing from `@bandeira-tech/b3nd-move/actions/scheduler`. Per the same principle:
- `makeReadAction` removed; consumers using it construct a materializing codec with their scheduler instead.
- `Scheduler` re-exported from `@bandeira-tech/b3nd-move/codecs/scheduler`; old path removed.

## Testing strategy

The test consolidation from the earlier plan (`2026-06-29-route-decides-materialize.md`) survives, with one significant adjustment:

- `tests/rigs/stub.ts` gains the `/__stream__/` sentinel.
- `tests/suites/move-suite.ts` gains a stream-payload round-trip test that asserts the configured codec round-trips bytes faithfully or via its documented coercion.
- Each integration test (`tests/integration/deno/<x>.test.ts`) wires the today's-baked codec (`httpOutputsFrame`, `wsJsonEnvelope`, etc.) on both server and client — exercises the codec-pick path end-to-end.
- The `decodeBytes` colocated function from the earlier plan is no longer needed *as a flag adjacent to the test config* — it's now the codec's own `.decode` behavior, exercised by the round-trip test directly. The asymmetric per-transport knowledge ("WS encodes Uint8Array as `{0:n,…}`") now lives in the codec implementation where it belongs, not in test config.
- The four `src/<transport>/read.test.ts` files PR #50 added are deleted.
- The WS cancel-on-close limitation that PR #50 pinned is *already fixed* on this branch (`fix(ws): cancel unary read frames on socket close/error`); no port required.

## Risks and open questions

### Risks

1. **Migration friction at operator scale.** Every existing operator must add a `{ codec: ... }` arg. We considered (and rejected) a "today's behavior remains default" mitigation because it conflicts with principle (4). Mitigation: the migration diff is minimal and exactly one shape per wire; CHANGELOG and READMEs lead with it.
2. **Codec catalog ergonomics.** Two codecs ship per wire in v1 (today's + one alternative for HTTP, WS, MCP). Operators outside that range write their own; we provide the per-wire codec interface and examples. Risk: ecosystem fragmentation. Mitigation: the catalog is open seam by design — that's the point. b3nd ships the seam, not the protocol.
3. **App-dev confusion when codecs mismatch.** Failure mode is "the app doesn't work and the error message doesn't say `codec mismatch`." Mitigation: codecs' decoders surface clear errors when the wire shape isn't what they expect (e.g., `outputs-frame: missing leading flag byte`). Document the pattern. Optional follow-up (not v1): a "codec id" handshake on first request for diagnostic purposes only — never used for negotiation.

### Open questions for review

None blocking — but flagging:

- **Should `httpNdjson` ship in v1?** It's the simplest demonstration of a non-trivial alternative on HTTP. Probably yes, but it's the most discretionary item in the v1 catalog. Easy to drop or defer.
- **Naming: `httpOutputsFrame` or `outputsFrame`?** The codec is HTTP-specific (the type signature uses `Response`/`Request`), so wire-prefixed names disambiguate when multiple wires' codecs are imported in one file. Recommend wire-prefixed throughout the catalog for consistency.

## Appendix A — Surface examples

### Operator setup (today's-equivalent)

```ts
import { Rig, connection } from "@bandeira-tech/b3nd-core/rig";
import { httpApi } from "@bandeira-tech/b3nd-move/http";
import { wsApi } from "@bandeira-tech/b3nd-move/ws";
import { grpcHttpApi } from "@bandeira-tech/b3nd-move/grpc/http";
import { mcpApi } from "@bandeira-tech/b3nd-move/mcp";
import { httpOutputsFrame } from "@bandeira-tech/b3nd-move/codecs/http";
import { wsJsonEnvelope } from "@bandeira-tech/b3nd-move/codecs/ws";
import { grpcProto } from "@bandeira-tech/b3nd-move/codecs/grpc";
import { mcpTextJsonStringify } from "@bandeira-tech/b3nd-move/codecs/mcp";

const rig = new Rig({ /* … */ });

const http = httpApi(rig, { codec: httpOutputsFrame });
const ws = wsApi(rig, { codec: wsJsonEnvelope });
const grpc = grpcHttpApi(rig, { codec: grpcProto });
const mcp = mcpApi(rig, { codec: mcpTextJsonStringify });
```

### Operator setup (byte-faithful WS, MCP resources, scheduler-bounded)

```ts
import { wsJsonEnvelopeBase64 } from "@bandeira-tech/b3nd-move/codecs/ws";
import { mcpResourcePerSlot } from "@bandeira-tech/b3nd-move/codecs/mcp";
import type { Scheduler } from "@bandeira-tech/b3nd-move/codecs/scheduler";
import pLimit from "p-limit";

const limit = pLimit(4);
const scheduler: Scheduler = (slots, signal) =>
  Promise.all(slots.map((slot) => limit(() => slot(signal))));

const ws = wsApi(rig, {
  codec: wsJsonEnvelopeBase64({ scheduler }),
});
const mcp = mcpApi(rig, {
  codec: mcpResourcePerSlot({ scheduler }),
});
```

### App developer client

```ts
import { HttpClient } from "@bandeira-tech/b3nd-move/http";
import { httpOutputsFrame } from "@bandeira-tech/b3nd-move/codecs/http";

const client = new HttpClient({ url: serverUrl, codec: httpOutputsFrame });
const results = await client.read(["s://x", "s://y"]);
```

## Appendix B — Deferred codec menu (not v1)

| Wire | Codec | Why deferred |
|---|---|---|
| HTTP | `httpChunkedOutputsFrame` | Streaming outputs-frame variant. Genuinely useful but requires designing a chunked sub-frame protocol; punt until a real consumer surfaces. |
| WS | `wsBinaryOutputsFrame` | Reuses HTTP's outputs-frame on WS binary frames. Easy to write later; no v1 demand. |
| WS | `wsNdjsonText` | NDJSON over WS text frames. Slot-streaming for WS. Same as HTTP `httpNdjson` analogue; no v1 demand identified. |
| WS | `wsBinarySlotStream` | True per-slot streaming over WS binary frames with framing protocol. Real design work; punt. |
| gRPC | `grpcServerStreamingProto` | Server-streaming RPC variant. Spec-significant change to the gRPC service definition; defer. |
| MCP | `mcpTextPerSlot` | One TextContent per slot, no resources. Easy add; no v1 demand identified. |
| MCP | `mcpMixedContent` | Per-slot content-type-by-payload-shape selection. Real but rich; punt until a consumer surfaces. |
