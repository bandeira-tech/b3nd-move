/**
 * `McpPlug` — the transport plug contract for `mcpSpec`.
 *
 * MCP does not fit the PIN-over-method-call shape (tool calls + JSON text
 * vs. typed method calls + binary payloads), so it has its own shared
 * suite (`mcp-spec.ts`). The plug is the MCP analog of `MovePlug`: it
 * describes how to connect an SDK `Client` to a `buildMcpServer(pin)` over
 * whatever transport is under test. `runMcpPlug` supplies `stubRig` and
 * drives the shared tool-surface spec:
 *
 *     import { runMcpPlug } from "../../tests/suites/mcp-plug.ts";
 *     runMcpPlug(mcpInProcessPlug);
 */

// deno-lint-ignore-file no-import-prefix

import type { ProtocolInterfaceNode } from "@bandeira-tech/b3nd-core/types";
import type { Client } from "npm:@modelcontextprotocol/sdk@^1.0.0/client/index.js";
import { mcpSpec, type McpSpecOptions } from "./mcp-spec.ts";
import { stubRig } from "../rigs/stub.ts";

export interface McpPlug {
  /** Suite label; prefixes every test name. */
  name: string;
  /** Connect an SDK client to an MCP server built around the given pin. */
  connect: (
    pin: ProtocolInterfaceNode,
  ) => Promise<{ client: Client; cleanup: () => void | Promise<void> }>;
}

/** Register the shared MCP tool spec against the plug, wired to `stubRig`. */
export function runMcpPlug(plug: McpPlug, options?: McpSpecOptions): void {
  mcpSpec(plug.name, () => plug.connect(stubRig()), options);
}
