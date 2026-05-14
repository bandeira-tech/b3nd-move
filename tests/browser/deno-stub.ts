/**
 * Browser-side helpers for b3nd-move integration test harnesses.
 *
 * Two responsibilities:
 *
 * 1. Install `globalThis.Deno = { test: (def) => collect }` so the
 *    move suite's `Deno.test` calls register into an in-memory list
 *    instead of running. This is a SIDE EFFECT of importing this
 *    module — it must happen before any module that references
 *    `Deno.test`. ES modules execute in import order, so listing
 *    this side-effect import first in a transport's harness is
 *    sufficient.
 *
 * 2. Expose `setupHarness()` to plumb `globalThis.runTests()` and
 *    `globalThis.__b3ndHarnessReady` for the Deno-side runner to
 *    pick up. The transport harness calls this once after
 *    `runMoveSuite(...)`.
 *
 * The Deno-side runner waits for `__b3ndHarnessReady === true`,
 * calls `runTests()`, and re-registers each returned result as its
 * own `Deno.test`.
 */

export interface BrowserTestDef {
  name: string;
  fn: () => void | Promise<void>;
}

export interface BrowserTestResult {
  name: string;
  ok: boolean;
  error?: string;
}

const collected: BrowserTestDef[] = [];

// deno-lint-ignore no-explicit-any
(globalThis as any).Deno = {
  // deno-lint-ignore no-explicit-any
  test(arg: any, maybeFn?: () => void | Promise<void>) {
    // The move suite uses the object form `Deno.test({ name, fn })`,
    // but accept the string-form variant too for forward compat.
    if (typeof arg === "object" && arg !== null) {
      collected.push({ name: arg.name, fn: arg.fn });
    } else if (typeof arg === "string" && typeof maybeFn === "function") {
      collected.push({ name: arg, fn: maybeFn });
    }
  },
  // Minimal shim — the suite doesn't read these but other Deno-only
  // paths sometimes do. Keep non-crashing.
  env: { get: (_: string) => undefined },
};

async function runTests(): Promise<BrowserTestResult[]> {
  const results: BrowserTestResult[] = [];
  for (const def of collected) {
    try {
      await def.fn();
      results.push({ name: def.name, ok: true });
    } catch (e) {
      const err = e instanceof Error
        ? `${e.name}: ${e.message}${e.stack ? `\n${e.stack}` : ""}`
        : String(e);
      results.push({ name: def.name, ok: false, error: err });
    }
  }
  return results;
}

/**
 * Plumb `globalThis.runTests()` and `__b3ndHarnessReady` so the
 * Deno-side runner can wait for the bundle to finish executing and
 * then trigger the run. Call once at the end of a transport's
 * harness.
 */
export function setupHarness(): void {
  // deno-lint-ignore no-explicit-any
  (globalThis as any).runTests = runTests;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).__b3ndHarnessReady = true;
}

/**
 * The server URL the Deno runner injected into the harness HTML
 * before serving (see `tests/browser/harness.html`). Transport
 * harnesses use this to construct their client.
 */
export function serverUrl(): string {
  // deno-lint-ignore no-explicit-any
  const url = (globalThis as any).__b3ndServerUrl;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(
      "browser-deno-stub: __b3ndServerUrl not set on the harness page",
    );
  }
  return url;
}
