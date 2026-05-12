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
- `observe: write under subscribed pattern is delivered`
- `observe: abort terminates the iteration cleanly`

## Known sanitizer quirks

`pinContract(label, factory, options?)` accepts
`{ sanitizeOps?, sanitizeResources? }` for factories whose transport has a known
upstream resource quirk. Every override should carry a comment pointing at the
upstream cause so the relaxation is easy to retire once fixed. Today:

- **`http-in-process`** runs with `sanitizeOps: false, sanitizeResources: false`
  because `b3nd-core`'s `httpApi` SSE handler installs a 30s keepalive
  `setInterval` whose `clearInterval` lives in the stream's `cancel` callback —
  Deno's per-test sanitizer fires before the server-side stream cancel resolves.
  Fix is upstream (bind the cleanup to `req.signal`).

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

## MCP tool spec

MCP doesn't fit PIN-over-wire (tool calls + JSON text content vs. typed method
calls + binary payloads), so it has its own `mcpSpec(label, factory, options?)`
alongside `pinContract`. The factory builds a `buildMcpServer(rig)`, an MCP SDK
`Client`, links them via `InMemoryTransport`, and returns the connected client.

```typescript
import { mcpSpec } from "../mod.ts";
import { mcpInProcess } from "../factories/mcp-in-process.ts";

mcpSpec("mcp-in-process", mcpInProcess);
```

Cases covered today:

- `listTools exposes the b3nd surface`
- `b3nd_status reports healthy`
- `b3nd_receive + b3nd_read round-trip a payload`
- `b3nd_read returns one tuple per input url, in order`

| Factory        | Transport                              | Status           |
| -------------- | -------------------------------------- | ---------------- |
| `mcpInProcess` | `buildMcpServer` + `InMemoryTransport` | landed (slice 5) |
