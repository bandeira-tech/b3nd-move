/**
 * @module
 * MCP tool spec — a fixed set of `Deno.test`s exercising the
 * `b3nd_receive` / `b3nd_read` / `b3nd_status` tools end-to-end through
 * a real MCP SDK `Client` connected to a `buildMcpServer(rig)` over
 * `InMemoryTransport`.
 *
 * MCP doesn't fit the PIN-over-method-call shape (tool calls + JSON
 * text content vs. typed method calls + binary payloads), so this lives
 * alongside `move-suite` rather than reusing it. The goal is to lock
 * the tool surface — names, argument shapes, JSON envelope, slot
 * ordering — not to re-prove backend semantics. Factories are expected
 * to wire `stubRig` (canned responses); the spec asserts that the
 * MCP layer faithfully relays those responses through tool content.
 */

import { assert, assertEquals } from "@std/assert";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/**
 * Factory for an in-process MCP server + connected SDK client.
 *
 * Implementations build a rig, wire it into `buildMcpServer`, link the
 * server and client over `InMemoryTransport`, and return the connected
 * `Client` plus a cleanup hook.
 */
export type McpFactory = () => Promise<{
  client: Client;
  cleanup: () => Promise<void> | void;
}>;

export interface McpSpecOptions {
  sanitizeOps?: boolean;
  sanitizeResources?: boolean;
}

/** Tool call content frames carry text; pull the first text block as a string. */
function firstText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  assert(Array.isArray(content), "tool result missing content array");
  const block = content.find(
    (c): c is { type: "text"; text: string } =>
      typeof c === "object" && c !== null && "type" in c &&
      (c as { type: unknown }).type === "text" && "text" in c &&
      typeof (c as { text: unknown }).text === "string",
  );
  assert(block !== undefined, "tool result had no text content block");
  return block.text;
}

/**
 * Register the MCP tool spec as a suite of `Deno.test`s. The `label`
 * prefixes every test name so multiple factories (in case we grow them)
 * don't collide.
 */
export function mcpSpec(
  label: string,
  factory: McpFactory,
  options: McpSpecOptions = {},
): void {
  const test = (
    name: string,
    body: (client: Client) => Promise<void>,
  ): void => {
    Deno.test({
      name: `[${label}] ${name}`,
      sanitizeOps: options.sanitizeOps ?? true,
      sanitizeResources: options.sanitizeResources ?? true,
      fn: async () => {
        const { client, cleanup } = await factory();
        try {
          await body(client);
        } finally {
          await cleanup();
        }
      },
    });
  };

  test("listTools exposes the b3nd surface", async (client) => {
    const { tools } = await client.listTools();
    const names = (tools as Array<{ name: string }>).map((t) => t.name).sort();
    assertEquals(names, ["b3nd_read", "b3nd_receive", "b3nd_status"]);
  });

  test("b3nd_status reports healthy", async (client) => {
    const result = await client.callTool({
      name: "b3nd_status",
      arguments: {},
    });
    const parsed = JSON.parse(firstText(result)) as { status: string };
    assertEquals(parsed.status, "healthy");
  });

  test("b3nd_receive returns one ack per input message, in order", async (client) => {
    const result = await client.callTool({
      name: "b3nd_receive",
      arguments: {
        messages: [
          ["mutable://t/mcp/a", { v: 1 }],
          ["mutable://t/mcp/__reject__/b", { v: 2 }],
          ["mutable://t/mcp/c", { v: 3 }],
        ],
      },
    });
    const acks = JSON.parse(firstText(result)) as Array<
      { uri: string; accepted: boolean; error?: string }
    >;
    assertEquals(acks.length, 3);
    assertEquals(acks.map((a) => a.uri), [
      "mutable://t/mcp/a",
      "mutable://t/mcp/__reject__/b",
      "mutable://t/mcp/c",
    ]);
    assertEquals(acks.map((a) => a.accepted), [true, false, true]);
  });

  test("b3nd_read returns one tuple per input url, in order", async (client) => {
    const result = await client.callTool({
      name: "b3nd_read",
      arguments: {
        urls: [
          "mutable://t/mcp/a",
          "mutable://t/mcp/__miss__/b",
          "mutable://t/mcp/c",
        ],
      },
    });
    const outputs = JSON.parse(firstText(result)) as Array<
      { uri: string; payload: unknown }
    >;
    assertEquals(outputs.length, 3);
    assertEquals(outputs.map((o) => o.uri), [
      "mutable://t/mcp/a",
      "mutable://t/mcp/__miss__/b",
      "mutable://t/mcp/c",
    ]);
    // Stub echoes { echo: url } on hits, null on misses — the spec
    // checks slot ordering and that the wire carries the rig's response
    // unchanged, not the values themselves.
    assertEquals(outputs[0].payload, { echo: "mutable://t/mcp/a" });
    assertEquals(outputs[1].payload, null);
    assertEquals(outputs[2].payload, { echo: "mutable://t/mcp/c" });
  });
}
