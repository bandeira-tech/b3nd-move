/// <reference lib="deno.ns" />
/**
 * @module
 * MCP `b3nd_read` — integration test: rig + `mcpHttpApi(rig)`, end-to-end
 * through the Streamable HTTP transport.
 *
 * Proves the round-3 promise on the MCP wire: a `ReadableStream<Uint8Array>`
 * upstream payload is materialized at the action layer and reaches the
 * MCP client as the JSON-encoded `content[0].text` body. Like WS, MCP's
 * JSON envelope does not preserve `Uint8Array` byte-for-byte — a
 * materialized `Uint8Array` lands as `{"0":n,"1":n,…}` inside the
 * stringified `text` payload. KNOWN LIMITATION test pins that shape.
 *
 * Background:
 * - PR #50 review M1: WS/MCP byte-encoding caveat.
 * - round-3 payload contract.
 */

import { assertEquals } from "@std/assert";
import { connection, Rig } from "@bandeira-tech/b3nd-core/rig";
import type {
  Output,
  ProtocolInterfaceNode,
  ReceiveResult,
  StatusResult,
} from "@bandeira-tech/b3nd-core/types";
import { mcpTextJsonStringify } from "../codecs/mcp/mod.ts";
import { mcpHttpApi } from "./http/service.ts";

// ── Test nodes ─────────────────────────────────────────────────────────

class StreamingNode implements ProtocolInterfaceNode {
  constructor(private bytes: Uint8Array) {}
  read<T = unknown>(urls: string[]): Promise<Output<T>[]> {
    const bytes = this.bytes;
    return Promise.resolve(urls.map((u): Output<T> => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      });
      return [u, stream] as unknown as Output<T>;
    }));
  }
  receive(): Promise<ReceiveResult[]> {
    return Promise.resolve([]);
  }
  async *observe(): AsyncIterable<readonly string[]> {
    yield [] as readonly string[];
  }
  status(): Promise<StatusResult> {
    return Promise.resolve({ status: "healthy" });
  }
}

function buildRig(node: ProtocolInterfaceNode): Rig {
  const c = connection(node, ["s://**"]);
  return new Rig({
    routes: { receive: [c], read: [c], observe: [c] },
  });
}

// ── MCP request helpers ────────────────────────────────────────────────

/**
 * Send a JSON-RPC request to the MCP fetch handler and return the
 * parsed JSON-RPC response. The Streamable HTTP transport responds
 * with either `application/json` (unary) or `text/event-stream` (SSE).
 * For tools/call, modes default to SSE; we read either path.
 */
async function mcpRequest(
  handler: (req: Request) => Promise<Response>,
  body: unknown,
): Promise<{
  jsonrpc: "2.0";
  id: number | string;
  result?: { content: { type: string; text: string }[]; isError?: boolean };
  error?: { code: number; message: string };
}> {
  const resp = await handler(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    }),
  );
  const ct = resp.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return await resp.json();
  }
  // SSE: parse first `data:` line.
  const text = await resp.text();
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) {
      return JSON.parse(line.slice(5).trim());
    }
  }
  throw new Error(`mcpRequest: no data frame found in body:\n${text}`);
}

// ── Tests ──────────────────────────────────────────────────────────────

Deno.test(
  "MCP b3nd_read: ReadableStream payload reaches client (documents JSON-envelope encoding)",
  async () => {
    const node = new StreamingNode(new TextEncoder().encode("streamed"));
    const rig = buildRig(node);
    const handler = mcpHttpApi(rig, { codec: mcpTextJsonStringify() });

    const resp = await mcpRequest(handler, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "b3nd_read", arguments: { urls: ["s://x"] } },
    });
    assertEquals(resp.id, 1);
    // The result.content[0].text is JSON-stringified outputs; parse and
    // confirm the slot reached the client without an encoder error.
    const text = resp.result!.content[0].text;
    const parsed = JSON.parse(text) as { uri: string; payload: unknown }[];
    assertEquals(parsed.length, 1);
    assertEquals(parsed[0].uri, "s://x");
    // After materialize → JSON.stringify(Uint8Array) → object-of-indices.
    // The next test pins the exact shape; here we only assert the slot
    // landed at all.
    assertEquals(
      parsed[0].payload !== null && typeof parsed[0].payload === "object",
      true,
    );
  },
);

Deno.test(
  "MCP b3nd_read: KNOWN LIMITATION — Uint8Array payload encodes as {0:n,1:n,...} via JSON envelope (see README)",
  async () => {
    // Pins the documented lossy shape for MCP. The day someone "fixes"
    // MCP byte-encoding (e.g. base64) without coordinating M1's
    // README + the shared-action JSDoc, this assertion fires.
    const bytes = new Uint8Array([10, 20, 30]);
    const node = new StreamingNode(bytes);
    const rig = buildRig(node);
    const handler = mcpHttpApi(rig, { codec: mcpTextJsonStringify() });

    const resp = await mcpRequest(handler, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "b3nd_read", arguments: { urls: ["s://x"] } },
    });
    const text = resp.result!.content[0].text;
    const parsed = JSON.parse(text) as { uri: string; payload: unknown }[];
    // After JSON.stringify(Uint8Array([10,20,30])) inside MCP's
    // tools/call response text → '{"0":10,"1":20,"2":30}'.
    assertEquals(parsed[0].payload, { "0": 10, "1": 20, "2": 30 });
  },
);
