# b3nd-testing

Shared integration-test harness for the transports shipped from this repo.
Publish-excluded — internal to the workspace.

## PIN contract

`pinContract(label, factory)` registers a fixed suite of `Deno.test`s that
exercise the framework invariants of `ProtocolInterfaceNode` over the network
boundary. Each transport supplies a factory that boots a rig + transport
in-process on an ephemeral port and returns a connected client; the contract
runs identically against all of them.

```typescript
import { pinContract } from "../mod.ts";
import { httpInProcess } from "../factories/http-in-process.ts";

pinContract("http-in-process", httpInProcess);
```

Cases covered today:

- `status() returns healthy`
- `receive: one ReceiveResult per input, in order`
- `read: one Output per input, with uri echoed`
- `round-trip: payload survives receive → read`
- `batch read: order preserved across mixed hits and misses`

The contract asserts only framework-level invariants. "What a miss looks like"
is a content/protocol concern (per `b3nd-core` 0.15+) and stays out of the spec
— factories pick a backend, and per-transport tests can extend the suite for
transport-specific edges.

## Factories

| Factory                         | Transport / encoding                            | Status           |
| ------------------------------- | ----------------------------------------------- | ---------------- |
| `httpInProcess`                 | core `httpApi` + `HttpClient`                   | landed (slice 1) |
| `grpcHttpInProcess({ binary })` | `grpcHttpApi` + `GrpcHttpClient`, JSON & binary | landed (slice 2) |
| `wsInProcess`                   | `wsApi` + core `WebSocketClient`                | landed (slice 3) |

The MCP transport gets its own (smaller) spec — slice 5 — because tool-call
semantics don't fit PIN-over-wire cleanly.
