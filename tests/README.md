# `tests/` — Integration tests + shared test infra

Everything outside production code lives here: the integration tests, the shared
transport factories, the stub rig, the named test-set suites, and the browser
runner machinery. `src/` is now purely production code.

Two integration runtime pairings, both running against the same shared suite and
the same single rig:

| Pairing     | Server                  | Client                            | Suite                                |
| ----------- | ----------------------- | --------------------------------- | ------------------------------------ |
| **Deno**    | real transport, in Deno | real client, in Deno              | `moveSuite` (per-operation, batched) |
| **Browser** | real transport, in Deno | real client, in headless Chromium | `moveSuite`                          |

MCP gets its own analog (`mcpSpec`) because tool calls + JSON text content have
a different shape than typed PIN method calls — but the assertions follow the
same conventions.

**Why no real rig?** The rig+store integration is the responsibility of
[`@bandeira-tech/b3nd-stores`](https://jsr.io/@bandeira-tech/b3nd-stores) — its
package tests real rigs against real stores. b3nd-move only needs to prove that
the message passage works: every byte that move owns goes out and comes back
faithfully across the network boundary. That's what `stubRig` lets us do — a
real `Rig` with a deterministic echo backend behind it.

## Layout

```
tests/
├── factories/                # boot real transports — parameterised on rig
│   ├── http.ts               # startHttpServer(rig, { cors? }) → { url, stop }
│   ├── ws.ts                 # startWsServer(rig)              → { url, stop }
│   ├── grpc.ts               # startGrpcServer(rig, { cors? }) → { url, stop }
│   └── mcp.ts                # startMcpInProcess(rig)           → { client, cleanup }
├── rig.ts                    # stubRig() — the only rig the tests use
├── suites/                   # named test-set generators
│   ├── move-suite.ts         # per-operation, batch on both sides
│   └── mcp-spec.ts           # MCP tool surface, same conventions
├── browser/                  # browser harness machinery
│   ├── runner.ts             # esbuild + @astral/astral driver
│   ├── harness.html          # page template (server URL injected)
│   ├── deno-stub.ts          # Deno.test collector for in-browser
│   └── harnesses/            # one bundled entry per transport
│       ├── http.ts
│       ├── ws.ts
│       ├── grpc.ts
│       └── grpc-binary.ts
└── integration/              # .test.ts files that compose everything
    ├── deno/                 # real client + real server, both in Deno
    │   ├── http.test.ts
    │   ├── ws.test.ts
    │   ├── grpc.test.ts      # registers move-suite twice: json + binary
    │   └── mcp.test.ts
    └── browser/              # real client in Chromium, real server in Deno
        ├── http.test.ts
        ├── ws.test.ts
        ├── grpc.test.ts
        └── grpc-binary.test.ts
```

## Running

```bash
deno task test                          # unit/module tests in src/
deno task test:integration:deno         # all in-Deno integration tests
deno task test:integration:http         # browser: HttpClient
deno task test:integration:ws           # browser: WebSocketClient
deno task test:integration:grpc         # browser: GrpcHttpClient (JSON)
deno task test:integration:grpc-binary  # browser: GrpcHttpClient (binary)
```

`deno task test` does not pull Chromium. On first browser-integration run,
`@astral/astral` downloads Chromium into its cache (a few hundred MB);
subsequent runs reuse it.

## How a browser run works

1. The integration test boots the **real** transport server via
   `start<X>Server(stubRig(), { cors: true })` — real `httpApi`/`wsApi`/
   `grpcHttpApi`, real `withCors` where browsers need it, on an ephemeral
   loopback port.
2. `tests/browser/runner.ts` bundles the matching
   `tests/browser/harnesses/<x>.ts` with esbuild + `@luca/esbuild-deno-loader`,
   templates the server URL into `harness.html`, and serves the bundle on a
   _second_ loopback port.
3. Headless Chromium (`@astral/astral`) loads the harness URL. The harness
   imports `tests/browser/deno-stub.ts` first — that swaps
   `globalThis.Deno = { test: collect }` so the move-suite's `Deno.test(...)`
   calls register into an in-page array instead of throwing.
4. `setupHarness()` signals readiness via `__b3ndHarnessReady = true`. The
   runner waits, calls `globalThis.runTests()`, gets back
   `{ name, ok, error }[]`, and re-registers each as a `Deno.test` so results
   stream out of `deno test` as if they ran locally.

The harness page and the API server live on different loopback origins on
purpose — that's what the browser sees in real deployments, and what
`withCors` + `OPTIONS` preflight has to handle to be useful.

## How a Deno-side run works

1. The integration test starts the real transport server with
   `start<X>Server(stubRig())` once at the top level.
2. `runMoveSuite(...)` registers the per-operation test set, each test
   constructing a fresh client pointed at the shared server URL.
3. A trailing cleanup `Deno.test` shuts the server down. Deno runs tests in
   registration order, so the cleanup runs last.

## Stub rig contract

`stubRig()` is a real `Rig` from `@bandeira-tech/b3nd-core` wired to one
deterministic `ProtocolInterfaceNode` on all routes, with a program registered
under `mutable://t` so rejection happens at the pipeline stage (the rig's
backend dispatch is fire-and-forget; only the program/handler outcome surfaces
in `rig.receive`'s return).

The move-suite drives every transport with the same conventions:

| Op              | Convention                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `receive(msgs)` | `[{accepted: true}, …]`; URIs containing `/__reject__/` → `{accepted: false, error: "rejected by stub"}` (rejected at the program)                              |
| `read(urls)`    | `[[url, {echo: url}], …]`; URIs containing `/__miss__/` → `[url, null]`; URIs ending in `/` synthesize a 3-child listing (used by the HTTP SSE observe backlog) |
| `observe(urls)` | 3 frames per subscribed pattern: `[pattern, [` ${pattern}/${i}`]]`, then end                                                                                    |
| `status()`      | `{status: "healthy", message: "stub", fns: ["receive","read","observe","status"]}`                                                                              |

Every test exercises **batched inputs AND batched outputs** so the encode/decode
paths get exercised in their multi-item shape — that's where transport bugs
usually live (off-by-one slot mapping, lost ordering, dropped misses).

## Sharing infra with per-module unit tests

Per-module tests (`src/ws/observe.test.ts`, `src/grpc/http/client.test.ts`,
etc.) can import the shared factory and rig to avoid hand-rolling in-test
setups:

```ts
import { startHttpServer } from "../../../tests/factories/http.ts";
import { stubRig } from "../../../tests/rig.ts";

const server = await startHttpServer(stubRig());
```

The factories and rig are publish-excluded along with the rest of `tests/`, so
they exist only at workspace scope.

## Adding a new transport

1. Add `tests/factories/<name>.ts` exporting `start<Name>Server(rig)` →
   `{ url, stop }`.
2. Add an in-Deno test at `tests/integration/deno/<name>.test.ts`:
   ```ts
   import { runMoveSuite } from "../../suites/move-suite.ts";
   import { start<Name>Server } from "../../factories/<name>.ts";
   import { stubRig } from "../../rig.ts";
   import { TheClient } from "../../../src/<name>/client.ts";

   const server = await start<Name>Server(stubRig());
   runMoveSuite("TheClient (deno)", {
     client: () => new TheClient({ url: server.url }),
   });
   Deno.test({
     name: "TheClient (deno) — cleanup",
     sanitizeOps: false, sanitizeResources: false,
     fn: () => Promise.resolve(server.stop()),
   });
   ```
3. Add a browser harness at `tests/browser/harnesses/<name>.ts`:
   ```ts
   import { serverUrl, setupHarness } from "../deno-stub.ts";
   import { TheClient } from "../../../src/<name>/client.ts";
   import { runMoveSuite } from "../../suites/move-suite.ts";

   runMoveSuite("TheClient (browser)", {
     client: () => new TheClient({ url: serverUrl() }),
   });
   setupHarness();
   ```
4. Add a browser integration test at `tests/integration/browser/<name>.test.ts`:
   ```ts
   import { runBrowserSuite } from "../../browser/runner.ts";
   import { start<Name>Server } from "../../factories/<name>.ts";
   import { stubRig } from "../../rig.ts";

   await runBrowserSuite({
     harnessEntry: new URL("../../browser/harnesses/<name>.ts", import.meta.url),
     startServer: () => start<Name>Server(stubRig(), { cors: true }),
   });
   ```
5. Add a `test:integration:<name>` task to `deno.json` and a matrix entry to
   `.github/workflows/ci.yml`.
