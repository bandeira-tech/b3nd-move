# `tests/` — the transport conformance kit

`b3nd-move`'s shared expectations live here as a reusable **kit**; each
transport's _conformance run_ lives next to its code under `src/<transport>/`.
The kit is the contract, the co-located run proves a transport meets it. This
mirrors `b3nd-save`, where one `shared-store-suite` is run by a co-located
`store.test.ts` per backend.

Nothing in `tests/` is production code, and nothing here is published (the whole
tree is `publish.exclude`d, along with each transport's `_conformance/` and
`_browser/` support dirs).

## The kit

```
tests/
├── suites/
│   ├── move-suite.ts   # runMoveSuite(name, config) — PIN wire expectations.
│   │                   #   Browser-safe (no server boot); imported by both
│   │                   #   the in-Deno runner and the bundled browser harnesses.
│   ├── move-plug.ts    # MovePlug + runMovePlug(plug) — the in-Deno runner:
│   │                   #   build stubRig → plug.startServer → runMoveSuite via
│   │                   #   plug.makeClient → teardown. Deno-only.
│   ├── mcp-spec.ts     # mcpSpec(name, factory) — MCP tool-surface expectations.
│   └── mcp-plug.ts     # McpPlug + runMcpPlug(plug) — wires stubRig into mcpSpec.
├── rigs/
│   └── stub.ts         # stubRig() — one deterministic PIN, canned responses.
└── browser/            # shared browser runner (esbuild + @astral/astral)
    ├── runner.ts       #   runBrowserSuite({ harnessEntry, startServer })
    ├── harness.html    #   page template (server URL injected)
    └── deno-stub.ts    #   Deno.test collector for in-browser runs
```

`b3nd-move`'s job is encode → wire → decode. The suites assert that calls reach
the rig with the expected shape and that the rig's response survives the round.
They do **not** assert storage semantics — every run uses `stubRig`
(deterministic canned responses) and asserts the wire delivers those responses
unchanged. See `rigs/stub.ts` for the stub contract (`/__reject__/`,
`/__miss__/`, `/__stream__/`, trailing-slash listings).

Every test exercises **batched inputs AND batched outputs** — that's where
transport bugs hide (off-by-one slot mapping, lost ordering, dropped misses).

## A transport plug

A transport proves conformance by describing itself as a plug and handing it to
the kit. The plug is the single source of truth for how the transport boots and
how a client is built against it — reused by both the in-Deno run and the
browser driver.

```ts
// src/<transport>/_conformance/plug.ts
export const fooPlug: MovePlug = {
  name: "foo",
  startServer: (rig, opts) => {/* Deno.serve … return { url, stop } */},
  makeClient: (url) => new FooClient({ url, codec }),
  payload: (v) => /* adapt to wire, or omit for identity */,
};
```

```ts
// src/<transport>/conformance.test.ts  — runs under `deno task test`
import { runMovePlug } from "../../tests/suites/move-plug.ts";
import { fooPlug } from "./_conformance/plug.ts";
await runMovePlug(fooPlug);
```

MCP transports use `McpPlug` + `runMcpPlug` against `mcpSpec` instead — MCP is
tool calls + JSON text, not the PIN-over-method-call shape, so it has its own
suite.

## Two run modes, same expectations

| Mode        | Server                  | Client                            | Where it runs                                    |
| ----------- | ----------------------- | --------------------------------- | ------------------------------------------------ |
| **Deno**    | real transport, in Deno | real client, in Deno              | `src/<transport>/conformance.test.ts`            |
| **Browser** | real transport, in Deno | real client, in headless Chromium | `src/<transport>/_browser/harness.ts` + a driver |

The in-Deno run is part of `deno task test` (loopback server, no external deps).
The browser run is opt-in per transport via
`deno task test:integration:<transport>`; a thin driver in
`tests/integration/browser/` boots the plug's server (CORS on) and points the
shared runner at the co-located harness.

## Content transports — the carve-out

`http-get-content` and `http-post-content` are **not** PIN-symmetric (bespoke
rigs, content-type mapping, browser-only). They do not plug into `runMoveSuite`;
each keeps its own `_conformance/server.ts` + `_browser/harness.ts` with
transport-specific assertions.

## Running

```bash
deno task test                          # module tests + all in-Deno conformance
deno task test:integration:http         # browser: HttpClient
deno task test:integration:ws           # browser: WebSocketClient
deno task test:integration:grpc         # browser: GrpcHttpClient (JSON)
deno task test:integration:grpc-binary  # browser: GrpcHttpClient (binary)
deno task test:integration:http-get-content
deno task test:integration:http-post-content
```

`deno task test` does not pull Chromium. On first browser run, `@astral/astral`
downloads a pinned Chromium into its cache (a few hundred MB); subsequent runs
reuse it.

## How a browser run works

1. The driver boots the **real** transport server via
   `plug.startServer(stubRig(), { cors: true })` on an ephemeral loopback port.
2. `tests/browser/runner.ts` bundles the co-located
   `src/<transport>/_browser/harness.ts` with esbuild +
   `@luca/esbuild-deno-loader`, templates the server URL into `harness.html`,
   and serves the bundle on a second loopback port.
3. Headless Chromium loads the harness URL. The harness imports
   `tests/browser/deno-stub.ts` first — that swaps
   `globalThis.Deno = { test: collect }` so the suite's `Deno.test(...)` calls
   register into an in-page array instead of throwing.
4. `setupHarness()` signals readiness; the runner calls `runTests()`, gets back
   `{ name, ok, error }[]`, and re-registers each as a `Deno.test` so results
   stream out of `deno test` as if they ran locally.

The harness page and API server live on different loopback origins on purpose —
that's what a browser sees in real deployments, and what `withCors` has to
handle.

## Adding a new transport

1. `src/<name>/_conformance/plug.ts` — export a `MovePlug` (`startServer`,
   `makeClient`, `payload?`).
2. `src/<name>/conformance.test.ts` — `await runMovePlug(<name>Plug)`. Runs
   under `deno task test` automatically.
3. `src/<name>/_browser/harness.ts` — self-contained `runMoveSuite(...)` against
   the browser client; end with `setupHarness()`.
4. `tests/integration/browser/<name>.test.ts` — thin driver:
   `runBrowserSuite({ harnessEntry, startServer: () => <name>Plug.startServer(stubRig(), { cors: true }) })`.
5. Add a `test:integration:<name>` task to `deno.json` and a matrix entry to
   `.github/workflows/ci.yml`.
