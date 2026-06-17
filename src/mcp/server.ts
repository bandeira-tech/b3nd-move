/**
 * @module
 * Minimal MCP server — the dispatch layer between a transport and a set
 * of method handlers.
 *
 * Replaces the small slice of the MCP SDK server we actually used. The
 * upstream `Server` builds on a `Protocol` class that drags in Zod and
 * Ajv for schema validation. b3nd-move doesn't need any of that — the
 * only handlers we register are `tools/list`, `tools/call`,
 * `resources/list`, `resources/read`. Routing by method-name string is
 * plenty.
 *
 * Wire-compatible with what the vendored Streamable HTTP transport and
 * the WS transport expect:
 *
 *   - `await server.connect(transport)` — wires onmessage to dispatch.
 *   - `server.setRequestHandler(method, fn)` — string-keyed.
 *   - `server.setNotificationHandler(method, fn)` — string-keyed.
 *
 * Handles `initialize` automatically — clients send it first per the
 * 2025-* revisions of the spec, and the response is a fixed shape
 * (server info + advertised capabilities). For 2026-* clients which no
 * longer send `initialize`, the dispatch table just never sees one and
 * the equivalent capability method takes its place.
 */

import type {
  JSONRPCErrorResponse,
  JSONRPCMessage,
  JSONRPCRequest,
  JSONRPCResultResponse,
  MessageExtraInfo,
  RequestId,
} from "./wire.ts";
import { isJSONRPCNotification, isJSONRPCRequest } from "./wire.ts";
import type { Transport } from "./web-streamable-http-transport.ts";

/** Minimal context handed to method handlers — extend as needed. */
export interface RequestHandlerExtra {
  signal: AbortSignal;
  authInfo?: unknown;
  requestInfo?: unknown;
  sessionId?: string;
}

export type RequestHandler<TParams = unknown, TResult = unknown> = (
  request: { method: string; params: TParams },
  extra: RequestHandlerExtra,
) => Promise<TResult> | TResult;

export type NotificationHandler<TParams = unknown> = (
  notification: { method: string; params: TParams },
  extra: RequestHandlerExtra,
) => Promise<void> | void;

export interface ServerInfo {
  name: string;
  version: string;
}

export interface ServerCapabilities {
  tools?: Record<string, unknown>;
  resources?: Record<string, unknown>;
  prompts?: Record<string, unknown>;
  logging?: Record<string, unknown>;
}

export interface MinimalServerOptions {
  /**
   * Protocol version this server advertises in the initialize response.
   * Pick the highest revision the vendored transport supports.
   */
  protocolVersion?: string;
}

const DEFAULT_PROTOCOL_VERSION = "2025-11-25";

// JSON-RPC error codes — mirror of the SDK's `ErrorCode` enum.
export const ErrorCode = {
  ConnectionClosed: -32000,
  RequestTimeout: -32001,
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export class MinimalServer {
  private _requestHandlers = new Map<string, RequestHandler>();
  private _notificationHandlers = new Map<string, NotificationHandler>();
  private _transport?: Transport;
  private _abortControllers = new Map<RequestId, AbortController>();

  readonly serverInfo: ServerInfo;
  readonly capabilities: ServerCapabilities;
  readonly protocolVersion: string;

  constructor(
    serverInfo: ServerInfo,
    capabilities: ServerCapabilities = {},
    options: MinimalServerOptions = {},
  ) {
    this.serverInfo = serverInfo;
    this.capabilities = capabilities;
    this.protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;

    // Built-in `initialize` handler — clients on the 2025-* revisions
    // send this first. Response is a fixed shape derived from the
    // constructor args.
    this.setRequestHandler("initialize", (req) => {
      const params = req.params as
        | { protocolVersion?: string; clientInfo?: unknown }
        | undefined;
      const requestedVersion = params?.protocolVersion;
      // Echo the client's requested version if we support it; otherwise
      // respond with our default. The SDK does the same.
      const negotiated = requestedVersion ?? this.protocolVersion;
      return {
        protocolVersion: negotiated,
        capabilities: this.capabilities,
        serverInfo: this.serverInfo,
      };
    });

    // Built-in no-op handler for `initialized` notification (sent by
    // clients after the initialize round-trip).
    this.setNotificationHandler("notifications/initialized", () => {});
  }

  setRequestHandler<TParams = unknown, TResult = unknown>(
    method: string,
    handler: RequestHandler<TParams, TResult>,
  ): void {
    this._requestHandlers.set(method, handler as RequestHandler);
  }

  setNotificationHandler<TParams = unknown>(
    method: string,
    handler: NotificationHandler<TParams>,
  ): void {
    this._notificationHandlers.set(method, handler as NotificationHandler);
  }

  async connect(transport: Transport): Promise<void> {
    this._transport = transport;
    transport.onmessage = (message, extra) => this._onmessage(message, extra);
    transport.onclose = () => {
      this._transport = undefined;
      for (const ac of this._abortControllers.values()) ac.abort();
      this._abortControllers.clear();
    };
    transport.onerror = (error) => {
      // Surface to console; consumers can override via a wrapper.
      console.error("[MinimalServer] transport error:", error);
    };
    await transport.start();
  }

  async close(): Promise<void> {
    await this._transport?.close();
  }

  private async _onmessage(
    message: JSONRPCMessage,
    extra?: MessageExtraInfo,
  ): Promise<void> {
    if (isJSONRPCNotification(message)) {
      const handler = this._notificationHandlers.get(message.method);
      if (!handler) return; // notifications without handlers are ignored
      try {
        await handler(
          { method: message.method, params: message.params as never },
          this._extra(undefined, extra),
        );
      } catch (err) {
        console.error(
          `[MinimalServer] notification handler ${message.method} threw:`,
          err,
        );
      }
      return;
    }

    if (isJSONRPCRequest(message)) {
      await this._handleRequest(message, extra);
      return;
    }

    // Responses/errors arriving here would mean someone routed wrong —
    // we don't initiate requests in this minimal server, so there's
    // nothing to correlate.
  }

  private _extra(
    requestId: RequestId | undefined,
    extra?: MessageExtraInfo,
  ): RequestHandlerExtra {
    let ac: AbortController | undefined;
    if (requestId !== undefined) {
      ac = new AbortController();
      this._abortControllers.set(requestId, ac);
    }
    return {
      signal: ac?.signal ?? new AbortController().signal,
      authInfo: (extra as { authInfo?: unknown } | undefined)?.authInfo,
      requestInfo: (extra as { requestInfo?: unknown } | undefined)
        ?.requestInfo,
      sessionId: this._transport?.sessionId,
    };
  }

  private async _handleRequest(
    request: JSONRPCRequest,
    extra?: MessageExtraInfo,
  ): Promise<void> {
    const handler = this._requestHandlers.get(request.method);
    if (!handler) {
      await this._send(
        this._errorFor(
          request.id,
          ErrorCode.MethodNotFound,
          `Method not found: ${request.method}`,
        ),
        request.id,
      );
      return;
    }
    try {
      const result = await handler(
        { method: request.method, params: request.params as never },
        this._extra(request.id, extra),
      );
      const response: JSONRPCResultResponse = {
        jsonrpc: "2.0",
        id: request.id,
        result: result as Record<string, unknown>,
      };
      await this._send(response, request.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this._send(
        this._errorFor(request.id, ErrorCode.InternalError, message),
        request.id,
      );
    } finally {
      this._abortControllers.delete(request.id);
    }
  }

  private _errorFor(
    id: RequestId,
    code: number,
    message: string,
    data?: unknown,
  ): JSONRPCErrorResponse {
    const body: { code: number; message: string; data?: unknown } = {
      code,
      message,
    };
    if (data !== undefined) body.data = data;
    return { jsonrpc: "2.0", id, error: body };
  }

  private async _send(
    message: JSONRPCMessage,
    relatedRequestId?: RequestId,
  ): Promise<void> {
    if (!this._transport) {
      throw new Error("Server is not connected to a transport");
    }
    await this._transport.send(message, { relatedRequestId });
  }
}
