# `tests/` — Browser Integration Harness

End-to-end proof that the **client half** of each transport, when bundled and
run inside a real browser, talks to its **server half** correctly. The point is
the _move layer_ — encoding, the wire, and decoding — so the server side is a
deterministic stub: no rig, no store, just canned shapes per request URI. If a
test passes, every byte that move owns went out and came back faithfully across
the process boundary.

## Layout

```
tests/
├── helpers/
│   └── browser-deno-stub.ts   ← stubs Deno.test for in-browser collection
└── runners/
    ├── browser-runner.ts      ← esbuild + astral driver
    ├── harness.html           ← page template (server URL injected)
    ├── move-suite.ts          ← per-operation, batch-on-both-sides suite
    └── stubs/
        ├── http-stub.ts       ← HTTP transport stub
        ├── ws-stub.ts         ← WebSocket transport stub
        └── grpc-stub.ts       ← gRPC-HTTP transport stub (JSON encoding)

src/<transport>/
├── _browser/harness.ts        ← bundled entry, wires client to suite
└── integration.test.ts        ← runs the harness against the transport stub
```

## How a run works

1. The transport's `integration.test.ts` boots its stub server on a loopback
   port (returned `url`).
2. `browser-runner.ts` bundles `_browser/harness.ts` with esbuild +
   `@luca/esbuild-deno-loader`, replaces `__B3ND_SERVER_URL__` in `harness.html`
   with the stub URL, and serves the bundle/HTML on a _second_ loopback port.
3. Headless Chromium (`@astral/astral`) loads the harness URL. The harness
   imports `browser-deno-stub.ts` first — that swaps
   `globalThis.Deno = { test: collect }` so the move suite's `Deno.test(...)`
   calls register into an in-page array instead of throwing.
4. `setupHarness()` signals readiness via `__b3ndHarnessReady = true`. The
   runner waits on that, calls `globalThis.runTests()`, gets back
   `{ name, ok, error }[]`, and re-registers each as a `Deno.test` so results
   stream out of `deno test` as if they ran locally.

The harness server and the stub server live on different origins on purpose — it
proves cross-origin works (every stub serves permissive CORS + handles `OPTIONS`
preflight).

## Stub contract

All transport stubs follow the same content-addressed echo rules so a single
move suite drives every transport. See `move-suite.ts` for the authoritative
definition; in short:

| Operation           | Input shape | Stub response                                                                                                                    |
| ------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `receive(msgs)`     | `Message[]` | `[{accepted: true, ref: uri}, …]`, except `uri` containing `/__reject__/` returns `{accepted: false, error: "rejected by stub"}` |
| `read(urls)`        | `string[]`  | `[[url, {echo: url}], …]`, except `url` containing `/__miss__/` returns `[url, null]`                                            |
| `observe(patterns)` | `string[]`  | 3 emitted events per subscribed pattern with synthesized child uris, then stream end                                             |
| `status()`          | —           | `{status:"healthy", fns:["receive","read","observe","status"], message:"stub"}`                                                  |

Every test in `move-suite.ts` uses **batched inputs AND batched outputs** so the
encode/decode paths get exercised in their multi-item shape — that's where
transport bugs usually live (off-by-one slot mapping, lost ordering, dropped
misses).

## Running

```bash
deno task test:integration:http
deno task test:integration:ws
deno task test:integration:grpc
```

`deno task test` (the default) excludes integration tests so they don't pull
Chromium into a normal unit-test loop. On first run, `@astral/astral` downloads
Chromium into its cache (a few hundred MB).

## Adding a new transport

1. Write `tests/runners/stubs/<name>-stub.ts` that follows the contract above
   and returns `{ url, stop }`.
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
   import { startTheStub } from "../../tests/runners/stubs/the-stub.ts";

   await runBrowserSuite({
     harnessEntry: new URL("./_browser/harness.ts", import.meta.url),
     startServer: () => startTheStub(),
   });
   ```
4. Extend `deno.json` `tasks.test --ignore` and add a `test:integration:<name>`
   task.
