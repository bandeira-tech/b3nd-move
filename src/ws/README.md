# ws

WebSocket transport for B3nd. Persistent connection, request/response over JSON
frames, server-pushed observe events.

## Surface

| File         | Exports                                                                             | Runtime |
| ------------ | ----------------------------------------------------------------------------------- | ------- |
| `service.ts` | `wsApi`, `WsApi`                                                                    | Deno    |
| `client.ts`  | `WebSocketClient`, `WebSocketClientConfig`, `WebSocketRequest`, `WebSocketResponse` | any     |

## Concepts

**Wire shape.** One persistent socket, JSON frames keyed by `id`:

```text
inbound  → { id, type, payload }
outbound → { id, success: true,  data }
           { id, success: false, error }
```

| `type`           | `payload`        | `data`                                       |
| ---------------- | ---------------- | -------------------------------------------- |
| `receive`        | `Message[]`      | `ReceiveResult[]`                            |
| `read`           | `{ urls }`       | `Output[]`                                   |
| `observe`        | `{ urls }`       | repeated frames, each `string[]` (uri batch) |
| `observe-cancel` | `{}` (reuses id) | no reply — active observe emits terminator   |
| `status`         | `{}`             | `StatusResult`                               |

Observe streams are terminated by a frame with `data: null` (server
end-of-stream) or by `observe-cancel` from the client.

**The pair.**

- `service.ts` (`wsApi(rig, { codec })`) is a fetch handler that upgrades to WS.
  Tied to Deno only because it uses `Deno.upgradeWebSocket`. Exposes a
  `closeAll()` lifecycle hook so callers can drain sockets before shutting down
  the host HTTP server (`Deno.HttpServer.shutdown` waits for in-flight requests,
  and WS connections are long-lived).
- `client.ts` (`WebSocketClient`) speaks the protocol above with configurable
  reconnection.

## Codec pick

`wsApi(rig, { codec })` and `new WebSocketClient({ url, codec, ... })` require
an operator-declared `WsBatchCodec`. Two codecs ship in the catalog
(`@bandeira-tech/b3nd-move/codecs/ws`):

| Codec                  | Byte payloads                           | Use when                                  |
| ---------------------- | --------------------------------------- | ----------------------------------------- |
| `wsJsonEnvelope`       | `{"0":n,"1":n,…}` (lossy — JSON object) | default; matches prior behavior           |
| `wsJsonEnvelopeBase64` | base64 string (byte-faithful)           | round-tripping `Uint8Array` payloads (M1) |

**KNOWN LIMITATION.** The default `wsJsonEnvelope` codec serializes `Uint8Array`
payloads via `JSON.stringify`, which produces `{"0":n,"1":n,…}` rather than a
binary encoding. This matches the behavior of prior b3nd-move releases. Use
`wsJsonEnvelopeBase64` when byte-faithful round-trip is required; the client
decodes the base64 back to `Uint8Array` automatically.

Both codecs accept a `scheduler` option for fan-out control — see
[`../codecs/scheduler.ts`](../codecs/scheduler.ts) for the `Scheduler` contract.

To write a custom codec, implement `WsBatchCodec` from `src/ws/codec.ts`. See
the design spec at
`docs/superpowers/specs/2026-06-30-operator-declared-codecs-design.md`.

## Usage

```typescript
import { wsApi } from "@bandeira-tech/b3nd-move/ws/service";
import { WebSocketClient } from "@bandeira-tech/b3nd-move/ws/client";
import { wsJsonEnvelope } from "@bandeira-tech/b3nd-move/codecs/ws";

const codec = wsJsonEnvelope();
const handler = wsApi(rig, { codec });
const server = Deno.serve({ port: 8080 }, handler);
// On shutdown: drain WS first, then stop the HTTP server.
//   await handler.closeAll();
//   await server.shutdown();

const client = new WebSocketClient({
  url: "ws://localhost:8080",
  codec,
  reconnect: { enabled: true },
});
await client.receive([["mutable://app/x", { name: "thing" }]]);

const ac = new AbortController();
for await (const uris of client.observe(["mutable://app/**"], ac.signal)) {
  console.log("changed:", uris);
}
```

## Notes

- `wsApi` returns 404 for non-upgrade requests — it does only the WS path. If
  you need a sibling HTTP endpoint on the same host, run it on a separate
  handler.
- `WsApi.closeAll()` drains sockets gracefully. Always call it before
  `server.shutdown()` for the same reason `dev/serve.ts` does.
- For local-dev convenience that wires this up for you, use
  `deno task serve -- --ws` (see [`dev/serve.ts`](../../dev/serve.ts)).
- The wire protocol matches `b3nd-core`'s `WebSocketClient` lineage — changing
  it is a breaking wire change.
