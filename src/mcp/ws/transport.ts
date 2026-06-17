/**
 * @module
 * MCP `Transport` impl over a single WebSocket — one JSON-RPC message
 * per frame, no session header (the connection *is* the session), no
 * SSE concerns.
 *
 * Wire framing:
 *
 *   server → client : `socket.send(JSON.stringify(jsonRpcMessage))`
 *   client → server : `JSON.parse(event.data)` → `onmessage(jsonRpcMessage)`
 *
 * Malformed frames (non-JSON, missing `jsonrpc` field) are reported via
 * `onerror` and dropped; the socket stays open. The transport closes
 * when the socket closes (either side).
 *
 * MCP has no official WS transport spec — this is a minimal mapping
 * that matches the JSON-RPC envelope the SDK already uses on stdio,
 * sans the framing layer. Documented locally in `./README.md`.
 */

import type { Transport } from "../web-streamable-http-transport.ts";
import type { JSONRPCMessage } from "../wire.ts";

/**
 * `Transport` impl that wraps a server-side `WebSocket`. The socket is
 * expected to be already open (post-`Deno.upgradeWebSocket`) — `start()`
 * just wires the listeners.
 */
export class WebSocketServerTransport implements Transport {
  readonly #socket: WebSocket;
  #started = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(socket: WebSocket) {
    this.#socket = socket;
  }

  start(): Promise<void> {
    if (this.#started) return Promise.resolve();
    this.#started = true;

    this.#socket.addEventListener("message", (event: MessageEvent) => {
      let frame: JSONRPCMessage;
      try {
        frame = JSON.parse(event.data) as JSONRPCMessage;
      } catch (e) {
        this.onerror?.(
          e instanceof Error
            ? e
            : new Error(`malformed WS frame: ${String(e)}`),
        );
        return;
      }
      this.onmessage?.(frame);
    });

    this.#socket.addEventListener("close", () => {
      this.onclose?.();
    });

    this.#socket.addEventListener("error", () => {
      this.onerror?.(new Error("websocket error"));
    });

    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.#socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("websocket not open"));
    }
    this.#socket.send(JSON.stringify(message));
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (
      this.#socket.readyState === WebSocket.OPEN ||
      this.#socket.readyState === WebSocket.CONNECTING
    ) {
      this.#socket.close();
    }
    return Promise.resolve();
  }
}
