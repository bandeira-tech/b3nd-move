# `tests/` — Browser Integration Harness

End-to-end proof that the **client half** of each transport, when bundled and
run inside a real browser, talks to its **real server half** correctly. Every
test fires the actual production code paths — the real `httpServer`/`wsServer`/
`grpcHttpServer` running on Deno — with only the **rig** stubbed, so the wire
behavior is exercised without coupling to actual storage. If a test passes,
every byte that move owns went out and came back faithfully across the process
and runtime boundary.

The Deno-side counterpart — "real client + real server, both in Deno" — lives in
[`src/testing/`](../src/testing/README.md) (the `pinContract` suite). Both
halves use the same PIN interface as their pivot; together they cover every
runtime pairing the move layer supports.

## Layout

```
tests/
├── helpers/
│   └── browser-deno-stub.ts   ← stubs Deno.test for in-browser collection
└── runners/
    ├── browser-runner.ts      ← esbuild + astral driver
    ├── harness.html           ← page template (server URL injected)
    ├── move-suite.ts          ← per-operation, batch-on-both-sides suite
    ├── stub-rig.ts            ← Rig instance backed by a stub PIN
    └── servers/
        ├── http-server.ts     ← real httpApi + withCors + stubRig
        ├── ws-server.ts       ← real wsApi + stubRig
        └── grpc-server.ts     ← real grpcHttpApi + withCors + stubRig

src/<transport>/
├── _browser/harness.ts        ← bundled entry, wires client to suite
└── integration.test.ts        ← runs the harness against the real server
```

## How a run works

1. The transport's `integration.test.ts` boots the **real** transport server
   (`httpApi(stubRig())`, `wsApi(stubRig())`, `grpcHttpApi(stubRig())`, wrapped
   in `withCors` where browsers need it) on a loopback port.
2. `browser-runner.ts` bundles `_browser/harness.ts` with esbuild +
   `@luca/esbuild-deno-loader`, replaces `__B3ND_SERVER_URL__` in `harness.html`
   with the server URL, and serves the bundle/HTML on a _second_ loopback port.
3. Headless Chromium (`@astral/astral`) loads the harness URL. The harness
   imports `browser-deno-stub.ts` first — that swaps
   `globalThis.Deno = { test: collect }` so the move suite's `Deno.test(...)`
   calls register into an in-page array instead of throwing.
4. `setupHarness()` signals readiness via `__b3ndHarnessReady = true`. The
   runner waits on that, calls `globalThis.runTests()`, gets back
   `{ name, ok, error }[]`, and re-registers each as a `Deno.test` so results
   stream out of `deno test` as if they ran locally.

The harness page and the API server live on different loopback origins on
purpose — that's what the browser sees in real deployments, and it's what
`withCors` + `OPTIONS` preflight has to handle correctly to be useful.

## Stub rig contract

The stub rig is a real `Rig` from `@bandeira-tech/b3nd-core` wired to one
deterministic `ProtocolInterfaceNode` on all routes, with a program registered
under `mutable://t` so rejection happens at the pipeline stage (the rig's
backend dispatch is fire-and-forget; only the program/handler outcome surfaces
in `rig.receive`'s return).

The move-suite drives every transport with the same content-addressed
conventions:

| Op              | Convention                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `receive(msgs)` | `[{accepted: true}, …]`; URIs containing `/__reject__/` → `{accepted: false, error: "rejected by stub"}` (rejected by the program)                              |
| `read(urls)`    | `[[url, {echo: url}], …]`; URIs containing `/__miss__/` → `[url, null]`; URIs ending in `/` synthesize a 3-child listing (used by the HTTP SSE observe backlog) |
| `observe(urls)` | 3 frames per subscribed pattern: `[pattern, [` ${pattern}/${i}`]]`, then end                                                                                    |
| `status()`      | `{status: "healthy", message: "stub", fns: ["receive","read","observe","status"]}`                                                                              |

Every test exercises **batched inputs AND batched outputs** so the encode/
decode paths get exercised in their multi-item shape — that's where transport
bugs usually live (off-by-one slot mapping, lost ordering, dropped misses).

## Running

```bash
deno task test:integration:http
deno task test:integration:ws
deno task test:integration:grpc           # gRPC-HTTP, JSON encoding
deno task test:integration:grpc-binary    # gRPC-HTTP, application/proto
```

`deno task test` (the default) excludes integration tests so they don't pull
Chromium into a normal unit-test loop. On first run, `@astral/astral` downloads
Chromium into its cache (a few hundred MB).

## Adding a new transport

1. Write `tests/runners/servers/<name>-server.ts` that returns `{ url, stop }`
   after booting `<name>Api(stubRig())` (wrapped in `withCors` if browsers will
   hit it from a different origin):
   ```ts
   import { theApi } from "../../../src/the/service.ts";
   import { withCors } from "../../../src/cors.ts";
   import { stubRig } from "../stub-rig.ts";

   export function startTheServer() {
     const handler = withCors(theApi(stubRig()), { origin: "*" });
     const server = Deno.serve({ port: 0, hostname: "127.0.0.1" }, handler);
     const { port } = server.addr as Deno.NetAddr;
     return Promise.resolve({
       url: `http://127.0.0.1:${port}`,
       stop: () => server.shutdown(),
     });
   }
   ```
2. Add `src/<name>/_browser/harness.ts`:
   ```ts
   import {
     serverUrl,
     setupHarness,
   } from "../../../tests/helpers/browser-deno-stub.ts";
   import { TheClient } from "../client.ts";
   import { runMoveSuite } from "../../../tests/runners/move-suite.ts";

   runMoveSuite("TheClient (browser)", {
     client: () => new TheClient({ url: serverUrl() }),
   });
   setupHarness();
   ```
3. Add `src/<name>/integration.test.ts`:
   ```ts
   import { runBrowserSuite } from "../../tests/runners/browser-runner.ts";
   import { startTheServer } from "../../tests/runners/servers/the-server.ts";

   await runBrowserSuite({
     harnessEntry: new URL("./_browser/harness.ts", import.meta.url),
     startServer: () => startTheServer(),
   });
   ```
4. Extend `deno.json`'s `tasks.test --ignore` and add a
   `test:integration:<name>` task.

## Why not also run move-suite in Deno against the real server?

That role is already filled by `src/testing/`'s `pinContract` — same shape, same
real server, run from a Deno-side client. Adding a Deno-side runner here would
duplicate intent. The point of `tests/` specifically is to exercise what in-Deno
runs can't catch: the browser fetch / WebSocket / SSE / NDJSON paths under real
CORS, real preflight, real cross-origin handshake.
