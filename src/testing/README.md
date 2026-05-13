# testing

Shared integration-test harness for B3nd transports. Lives in this repo to
verify the transports we ship and to give downstream protocol authors a contract
they can run against their own moves. Publish-excluded — it's workspace-only
code.

## Surface

| File                  | Exports                                                           | Runtime |
| --------------------- | ----------------------------------------------------------------- | ------- |
| `contract.ts`         | `pinContract`, `PinContractOptions`, `ServerFactory`              | Deno    |
| `mcp-spec.ts`         | `mcpSpec`, `McpSpecOptions`, `McpFactory`                         | Deno    |
| `shared-suite.ts`     | `runSharedSuite`, `TestClientFactories`                           | Deno    |
| `mock-http-server.ts` | `MockHttpServer`, `MockServerConfig`, `createMockServers`         | Deno    |
| `factories/*.ts`      | `{http,ws,grpchttp,mcp}InProcess` — boot a real transport in-proc | Deno    |
| `tests/*.test.ts`     | invocations of `pinContract` / `mcpSpec` per transport            | Deno    |

## Concepts

**PIN contract (`pinContract`).** A fixed `Deno.test` suite exercising the
`ProtocolInterfaceNode` invariants — status, receive, read, round-trip, batch
order, observe delivery, observe abort. Each transport supplies a
`ServerFactory` that boots the moving layer in-process on an ephemeral port and
returns a connected client. The contract calls only PIN methods — anything
transport-specific belongs in the transport's own test file.

```typescript
export type ServerFactory = () => Promise<{
  client: ProtocolInterfaceNode;
  cleanup: () => Promise<void> | void;
}>;
```

**MCP spec (`mcpSpec`).** PIN's analog for MCP — same shape, but the client is
an MCP SDK `Client` and the assertions exercise the tool surface
(`b3nd_receive`, `b3nd_read`, `b3nd_status`).

**Shared suite (`runSharedSuite`).** A lower-level client-only suite that
doesn't need a real server — used by `http/client.test.ts` and
`ws/client.test.ts` against a mock backend. Useful when you want to pin the
client's external behavior without standing up a transport.

**Mock HTTP server.** Configurable handlers for the routes `HttpClient` hits —
driven by `runSharedSuite` to exercise edge cases (errors, malformed responses,
slow responses) without rig involvement.

## Layout

```
testing/
  contract.ts            ← PIN contract
  mcp-spec.ts            ← MCP equivalent
  shared-suite.ts        ← client-only suite
  mock-http-server.ts    ← mock for shared-suite
  factories/
    _rig.ts              ← defaultRig() used by every in-process factory
    http.ts ws.ts grpchttp.ts mcp.ts
  tests/
    http.test.ts ws.test.ts grpchttp.test.ts mcp.test.ts
```

## Usage

Register the PIN contract for a new transport:

```typescript
// testing/tests/mytransport.test.ts
import { pinContract } from "../contract.ts";
import { myTransportInProcess } from "../factories/mytransport.ts";

pinContract("mytransport", myTransportInProcess);
```

The factory is responsible for binding `defaultRig()` to the transport on a free
port and returning a `cleanup` that tears it down:

```typescript
// testing/factories/mytransport.ts
import { defaultRig } from "./_rig.ts";

export const myTransportInProcess: ServerFactory = () => {
  const rig = defaultRig();
  // boot transport, get a client pointed at it
  return Promise.resolve({ client, cleanup: () => server.shutdown() });
};
```

## Notes

- `PinContractOptions.sanitizeOps` / `sanitizeResources` exist for known
  upstream quirks (see HTTP observe in `tests/http.test.ts`). Every `false`
  should carry a comment naming the upstream issue.
- Labels prefix every test name so the same contract can register multiple
  factories in one process (e.g. `grpchttp-json` and `grpchttp-binary` both call
  `pinContract`).
- This module is `publish.exclude`d in `deno.json`.
