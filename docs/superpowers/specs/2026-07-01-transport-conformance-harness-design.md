# Transport Conformance Harness — design

**Date:** 2026-07-01
**Package:** `b3nd-move`
**Status:** approved (design shaped interactively with the architect)

## Problem

`b3nd-move`'s shared expectations already exist as `runMoveSuite`
(`tests/suites/move-suite.ts`) and `mcpSpec` (`tests/suites/mcp-spec.ts`). What
is wrong is the *distribution*: each transport's conformance run is smeared
across five locations, all of them far from the code they exercise:

- `tests/factories/<x>.ts` — boots the server
- `tests/integration/deno/<x>.test.ts` — wires factory + client + codec into the suite
- `tests/integration/browser/<x>.test.ts` — browser driver
- `tests/browser/harnesses/<x>.ts` — browser entry
- `deno.json` task + `.github/workflows/ci.yml` matrix row

Adding or changing a transport touches all five. The tests read as a monolith
sitting *outside* `src/`, coupled to each other through the shared `tests/`
tree rather than to the module they prove.

The sibling package `b3nd-save` already solved the same shape: a central
reusable suite in `tests/runners/shared-store-suite.ts`, invoked by a
co-located `src/<backend>/store.test.ts` next to each backend. This design
makes `b3nd-move` symmetric with that pattern.

## Target

Move owns a **transport conformance kit** — the shared suites, the stub rig,
and the browser runner — kept central and publish-excluded. Each transport
co-locates a single `conformance.test.ts` in `src/<transport>/` that defines a
formal **plug** and runs it against the kit's shared expectations.

## Plug contracts

Move has two distinct shared suites, so there are two plug contracts.

### `MovePlug` — drives `runMoveSuite` (PIN wire fidelity)

```ts
interface MovePlug {
  name: string;
  startServer(rig: Rig): Promise<ServerHandle>; // { url, stop }
  makeClient(
    url: string,
  ): ProtocolInterfaceNode | Promise<ProtocolInterfaceNode>;
  /** Wire payload adapter (HTTP opaque bytes need JSON-encoding first). */
  payload?: (v: unknown) => unknown;
  /** Default true; disable for transports without observe. */
  supportsObserve?: boolean;
}
```

`runMoveSuite(plug)` owns the **entire lifecycle**: build `stubRig()`, call
`plug.startServer(rig)`, run every expectation through `plug.makeClient(url)`,
then tear the server down. This is the core simplification — it dissolves
today's `integration/deno/*.test.ts` boilerplate into one call and removes the
"server booted somewhere else" coupling.

### `McpPlug` — drives `mcpSpec` (MCP tool surface)

```ts
interface McpPlug {
  name: string;
  connect(rig: Rig): Promise<{
    client: Client;
    cleanup: () => void | Promise<void>;
  }>;
}
```

This is today's `McpFactory` given a `rig` parameter and a `name`. MCP does not
fit the PIN-over-method-call shape (tool calls + JSON text vs. typed method
calls + binary payloads), so it keeps its own suite — but it gets the same
plug-and-run ergonomics.

### Granularity

One server + one client config = one conformance run. gRPC's JSON and binary
paths are **two plugs** (`grpcJsonPlug`, `grpcBinaryPlug`), each booting its own
loopback server. Uniformity is worth more than sharing a single server across
two client variants.

## Layout

### Central kit — stays in `tests/`, publish-excluded (unchanged behavior)

- `tests/suites/move-suite.ts` — `runMoveSuite(plug)` + `MovePlug` type.
  Expectations **unchanged**; the signature moves from `(name, { client })` to
  `(plug)` and the suite gains server-lifecycle ownership.
- `tests/suites/mcp-spec.ts` — `mcpSpec(plug)` + `McpPlug` type. Expectations
  **unchanged**; `McpFactory` becomes `McpPlug`.
- `tests/rigs/stub.ts` — shared `stubRig()`. **Unchanged.**
- `tests/browser/{runner.ts, harness.html, deno-stub.ts}` — shared browser
  runner. **Unchanged.**

### Co-located per transport — the plug and its run

- `src/http/conformance.test.ts` → `httpPlug`, `runMoveSuite(httpPlug)`
- `src/ws/conformance.test.ts` → `wsPlug`
- `src/grpc/http/conformance.test.ts` → `runMoveSuite(grpcJsonPlug)` +
  `runMoveSuite(grpcBinaryPlug)`
- `src/mcp/conformance.test.ts` → `mcpSpec(mcpInProcessPlug)`
- `src/mcp/http/conformance.test.ts` → `mcpSpec(mcpHttpPlug)`
- `src/mcp/ws/conformance.test.ts` → `mcpSpec(mcpWsPlug)`
- Browser entries move to `src/<transport>/_browser/harness.ts`
  (from `tests/browser/harnesses/<x>.ts`).

The `Deno.serve` server-boot logic currently in `tests/factories/*` folds into
each transport's `conformance.test.ts` as the plug's `startServer`. Because
`src/**/*.test.ts` is publish-excluded, this runtime-binding code stays out of
the shipped package — consistent with the existing rule that "runtime binding
lives outside `src/`" (it stays out of the *published* `src/`).

## Content transports — explicit carve-out

`src/http-get-content/` and `src/http-post-content/` are **not** PIN-symmetric:
bespoke rigs, content-type mapping, browser-only assertions. They do **not**
join the shared `runMoveSuite`. Each keeps a co-located
`src/<transport>/_browser/harness.ts` plus its own transport-specific assertion
set. Do not force these into `MovePlug`.

## Wiring changes

- **`deno task test`** (runs `src/`) now also runs the in-Deno conformance
  runs, since they live under `src/`. They boot loopback servers only — no
  external dependencies — so this stays the fast, dependency-free lane. This
  **replaces** `test:integration:deno`; the `tests/integration/deno/` tree is
  deleted.
- **Browser** conformance stays opt-in per transport. `test:integration:<x>`
  drives the co-located `src/<transport>/_browser/harness.ts` through the
  central `tests/browser/runner.ts`. The `tests/integration/browser/<x>.test.ts`
  driver either stays as a thin shim or folds into the task; whichever keeps the
  runner reusable.
- **CI** (`.github/workflows/ci.yml`): the `integration-deno` job folds into
  `unit-tests` (both are now `deno task test`). The browser matrix is unchanged.
- **Pre-push hook** (`.githooks/pre-push`): drop the separate
  `test:integration:deno` step (now covered by `deno task test`).
- **`deno.json` publish.exclude:** extend to cover `_browser/` harness files
  (only `*.test.ts` patterns are excluded today). Verify with
  `deno publish --dry-run` that zero test/harness files ship.
- **`deno.json` check task:** update the file list to include the new
  `conformance.test.ts` files and drop deleted paths.

## Migration order (each step independently green)

1. **http** — the template. Fold `factories/http.ts` into `src/http/conformance.test.ts`,
   move the browser harness, delete the old http integration files, confirm
   `deno task test` and `test:integration:http` pass.
2. **ws**
3. **grpc/http** (json + binary)
4. **mcp** (in-process), **mcp/http**, **mcp/ws**
5. **http-get-content**, **http-post-content** (browser-only carve-out)
6. Suite signature refactor (`runMoveSuite(plug)` / `mcpSpec(plug)`), kit
   cleanup, `deno.json` / CI / hook / README updates, publish dry-run check.

The suite-signature refactor (step 6) can also lead — doing it first lets each
transport step consume the final API. Either order works; pick whichever keeps
intermediate commits green.

## Risks

- Two loopback servers for gRPC (json + binary) instead of one — negligible.
- `deno task test` gets slower (boots servers) — acceptable; still no external
  deps, still the pre-push fast lane.
- A harness file could leak into the published package — guarded by the
  `deno publish --dry-run` check in step 6.
