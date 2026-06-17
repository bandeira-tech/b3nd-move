// deno-lint-ignore-file require-await
// (Methods are `async` to satisfy the Transport return-type contract
// even when no await is needed — preserved from the original upstream.)
/**
 * @module
 * Web Standards Streamable HTTP server transport for MCP.
 *
 * Vendored from the official MCP SDK (vendored 2026-06). The original
 * is the `WebStandardStreamableHTTPServerTransport` in the SDK's
 * server folder. MIT licensed, Copyright (c) 2024 Anthropic, PBC.
 *
 * Minimal changes vs upstream:
 *   - Imports come from `./wire.ts` instead of the SDK's types module.
 *   - The Zod-backed schema parse calls became `parseJSONRPCMessage`
 *     from `./wire.ts`.
 *   - The `Transport` interface is declared locally rather than
 *     imported from the SDK's shared transport file.
 *   - Translated to TypeScript with the public API matching upstream
 *     so the surface seen by `mcp/http/service.ts` is unchanged.
 */

import {
  DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
  isInitializeRequest,
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type MessageExtraInfo,
  parseJSONRPCMessage,
  type RequestId,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./wire.ts";

export type StreamId = string;
export type EventId = string;

/** Minimal `Transport` shape — what `mcp/http/service.ts` consumes. */
export interface Transport {
  start(): Promise<void>;
  send(
    message: JSONRPCMessage,
    options?: { relatedRequestId?: RequestId },
  ): Promise<void>;
  close(): Promise<void>;
  sessionId?: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
}

export interface EventStore {
  storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId>;
  getStreamIdForEventId?(eventId: EventId): Promise<StreamId | undefined>;
  replayEventsAfter(
    lastEventId: EventId,
    options: {
      send: (eventId: EventId, message: JSONRPCMessage) => Promise<void>;
    },
  ): Promise<StreamId>;
}

export interface WebStandardStreamableHTTPServerTransportOptions {
  sessionIdGenerator?: () => string;
  onsessioninitialized?: (sessionId: string) => void | Promise<void>;
  onsessionclosed?: (sessionId: string) => void | Promise<void>;
  enableJsonResponse?: boolean;
  eventStore?: EventStore;
  /** @deprecated Use external middleware. */
  allowedHosts?: string[];
  /** @deprecated Use external middleware. */
  allowedOrigins?: string[];
  /** @deprecated Use external middleware. */
  enableDnsRebindingProtection?: boolean;
  retryInterval?: number;
}

export interface HandleRequestOptions {
  parsedBody?: unknown;
  authInfo?: unknown;
}

interface StreamSlot {
  controller?: ReadableStreamDefaultController<Uint8Array>;
  encoder?: TextEncoder;
  resolveJson?: (response: Response) => void;
  cleanup: () => void;
}

export class WebStandardStreamableHTTPServerTransport implements Transport {
  private sessionIdGenerator: (() => string) | undefined;
  private _started = false;
  private _hasHandledRequest = false;
  private _streamMapping = new Map<string, StreamSlot>();
  private _requestToStreamMapping = new Map<RequestId, string>();
  private _requestResponseMap = new Map<RequestId, JSONRPCMessage>();
  private _initialized = false;
  private _enableJsonResponse = false;
  private _standaloneSseStreamId = "_GET_stream";
  private _eventStore?: EventStore;
  private _onsessioninitialized?: (
    sessionId: string,
  ) => void | Promise<void>;
  private _onsessionclosed?: (sessionId: string) => void | Promise<void>;
  private _allowedHosts?: string[];
  private _allowedOrigins?: string[];
  private _enableDnsRebindingProtection: boolean;
  private _retryInterval?: number;

  sessionId?: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (
    message: JSONRPCMessage,
    extra?: MessageExtraInfo,
  ) => void;

  constructor(options: WebStandardStreamableHTTPServerTransportOptions = {}) {
    this.sessionIdGenerator = options.sessionIdGenerator;
    this._enableJsonResponse = options.enableJsonResponse ?? false;
    this._eventStore = options.eventStore;
    this._onsessioninitialized = options.onsessioninitialized;
    this._onsessionclosed = options.onsessionclosed;
    this._allowedHosts = options.allowedHosts;
    this._allowedOrigins = options.allowedOrigins;
    this._enableDnsRebindingProtection = options.enableDnsRebindingProtection ??
      false;
    this._retryInterval = options.retryInterval;
  }

  async start(): Promise<void> {
    if (this._started) {
      throw new Error("Transport already started");
    }
    this._started = true;
  }

  private createJsonErrorResponse(
    status: number,
    code: number,
    message: string,
    options?: { data?: unknown; headers?: Record<string, string> },
  ): Response {
    const error: { code: number; message: string; data?: unknown } = {
      code,
      message,
    };
    if (options?.data !== undefined) {
      error.data = options.data;
    }
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error,
        id: null,
      }),
      {
        status,
        headers: {
          "Content-Type": "application/json",
          ...options?.headers,
        },
      },
    );
  }

  private validateRequestHeaders(req: Request): Response | undefined {
    if (!this._enableDnsRebindingProtection) return undefined;
    if (this._allowedHosts && this._allowedHosts.length > 0) {
      const hostHeader = req.headers.get("host");
      if (!hostHeader || !this._allowedHosts.includes(hostHeader)) {
        const error = `Invalid Host header: ${hostHeader}`;
        this.onerror?.(new Error(error));
        return this.createJsonErrorResponse(403, -32000, error);
      }
    }
    if (this._allowedOrigins && this._allowedOrigins.length > 0) {
      const originHeader = req.headers.get("origin");
      if (originHeader && !this._allowedOrigins.includes(originHeader)) {
        const error = `Invalid Origin header: ${originHeader}`;
        this.onerror?.(new Error(error));
        return this.createJsonErrorResponse(403, -32000, error);
      }
    }
    return undefined;
  }

  async handleRequest(
    req: Request,
    options?: HandleRequestOptions,
  ): Promise<Response> {
    // In stateless mode (no sessionIdGenerator), each request must use a
    // fresh transport. Reusing a stateless transport causes message ID
    // collisions between clients.
    if (!this.sessionIdGenerator && this._hasHandledRequest) {
      throw new Error(
        "Stateless transport cannot be reused across requests. Create a new transport per request.",
      );
    }
    this._hasHandledRequest = true;

    const validationError = this.validateRequestHeaders(req);
    if (validationError) return validationError;

    switch (req.method) {
      case "POST":
        return this.handlePostRequest(req, options);
      case "GET":
        return this.handleGetRequest(req);
      case "DELETE":
        return this.handleDeleteRequest(req);
      default:
        return this.handleUnsupportedRequest();
    }
  }

  private async writePrimingEvent(
    controller: ReadableStreamDefaultController<Uint8Array>,
    encoder: TextEncoder,
    streamId: string,
    protocolVersion: string,
  ): Promise<void> {
    if (!this._eventStore) return;
    // Priming events have empty data which older clients cannot handle.
    if (protocolVersion < "2025-11-25") return;
    const primingEventId = await this._eventStore.storeEvent(streamId, {
      jsonrpc: "2.0",
      method: "ping",
    } as unknown as JSONRPCMessage);
    let primingEvent = `id: ${primingEventId}\ndata: \n\n`;
    if (this._retryInterval !== undefined) {
      primingEvent =
        `id: ${primingEventId}\nretry: ${this._retryInterval}\ndata: \n\n`;
    }
    controller.enqueue(encoder.encode(primingEvent));
  }

  private async handleGetRequest(req: Request): Promise<Response> {
    const acceptHeader = req.headers.get("accept");
    if (!acceptHeader?.includes("text/event-stream")) {
      this.onerror?.(
        new Error("Not Acceptable: Client must accept text/event-stream"),
      );
      return this.createJsonErrorResponse(
        406,
        -32000,
        "Not Acceptable: Client must accept text/event-stream",
      );
    }
    const sessionError = this.validateSession(req);
    if (sessionError) return sessionError;
    const protocolError = this.validateProtocolVersion(req);
    if (protocolError) return protocolError;

    if (this._eventStore) {
      const lastEventId = req.headers.get("last-event-id");
      if (lastEventId) return this.replayEvents(lastEventId);
    }

    if (this._streamMapping.get(this._standaloneSseStreamId) !== undefined) {
      this.onerror?.(
        new Error("Conflict: Only one SSE stream is allowed per session"),
      );
      return this.createJsonErrorResponse(
        409,
        -32000,
        "Conflict: Only one SSE stream is allowed per session",
      );
    }

    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        streamController = controller;
      },
      cancel: () => {
        this._streamMapping.delete(this._standaloneSseStreamId);
      },
    });
    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    };
    if (this.sessionId !== undefined) {
      headers["mcp-session-id"] = this.sessionId;
    }
    this._streamMapping.set(this._standaloneSseStreamId, {
      controller: streamController,
      encoder,
      cleanup: () => {
        this._streamMapping.delete(this._standaloneSseStreamId);
        try {
          streamController.close();
        } catch {
          // Controller might already be closed
        }
      },
    });
    return new Response(readable, { headers });
  }

  private async replayEvents(lastEventId: string): Promise<Response> {
    if (!this._eventStore) {
      this.onerror?.(new Error("Event store not configured"));
      return this.createJsonErrorResponse(
        400,
        -32000,
        "Event store not configured",
      );
    }
    try {
      let streamId: string | undefined;
      if (this._eventStore.getStreamIdForEventId) {
        streamId = await this._eventStore.getStreamIdForEventId(lastEventId);
        if (!streamId) {
          this.onerror?.(new Error("Invalid event ID format"));
          return this.createJsonErrorResponse(
            400,
            -32000,
            "Invalid event ID format",
          );
        }
        if (this._streamMapping.get(streamId) !== undefined) {
          this.onerror?.(
            new Error("Conflict: Stream already has an active connection"),
          );
          return this.createJsonErrorResponse(
            409,
            -32000,
            "Conflict: Stream already has an active connection",
          );
        }
      }
      const headers: Record<string, string> = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      };
      if (this.sessionId !== undefined) {
        headers["mcp-session-id"] = this.sessionId;
      }
      const encoder = new TextEncoder();
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const readable = new ReadableStream<Uint8Array>({
        start: (controller) => {
          streamController = controller;
        },
        cancel: () => {
          // Cleanup handled by mapping
        },
      });
      const replayedStreamId = await this._eventStore.replayEventsAfter(
        lastEventId,
        {
          send: async (eventId, message) => {
            const success = this.writeSSEEvent(
              streamController,
              encoder,
              message,
              eventId,
            );
            if (!success) {
              this.onerror?.(new Error("Failed replay events"));
              try {
                streamController.close();
              } catch {
                // already closed
              }
            }
          },
        },
      );
      this._streamMapping.set(replayedStreamId, {
        controller: streamController,
        encoder,
        cleanup: () => {
          this._streamMapping.delete(replayedStreamId);
          try {
            streamController.close();
          } catch {
            // already closed
          }
        },
      });
      return new Response(readable, { headers });
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      return this.createJsonErrorResponse(
        500,
        -32000,
        "Error replaying events",
      );
    }
  }

  private writeSSEEvent(
    controller: ReadableStreamDefaultController<Uint8Array>,
    encoder: TextEncoder,
    message: JSONRPCMessage,
    eventId?: string,
  ): boolean {
    try {
      let eventData = `event: message\n`;
      if (eventId) eventData += `id: ${eventId}\n`;
      eventData += `data: ${JSON.stringify(message)}\n\n`;
      controller.enqueue(encoder.encode(eventData));
      return true;
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      return false;
    }
  }

  private handleUnsupportedRequest(): Response {
    this.onerror?.(new Error("Method not allowed."));
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed.",
        },
        id: null,
      }),
      {
        status: 405,
        headers: {
          Allow: "GET, POST, DELETE",
          "Content-Type": "application/json",
        },
      },
    );
  }

  private async handlePostRequest(
    req: Request,
    options?: HandleRequestOptions,
  ): Promise<Response> {
    try {
      const acceptHeader = req.headers.get("accept");
      if (
        !acceptHeader?.includes("application/json") ||
        !acceptHeader.includes("text/event-stream")
      ) {
        this.onerror?.(
          new Error(
            "Not Acceptable: Client must accept both application/json and text/event-stream",
          ),
        );
        return this.createJsonErrorResponse(
          406,
          -32000,
          "Not Acceptable: Client must accept both application/json and text/event-stream",
        );
      }
      const ct = req.headers.get("content-type");
      if (!ct || !ct.includes("application/json")) {
        this.onerror?.(
          new Error(
            "Unsupported Media Type: Content-Type must be application/json",
          ),
        );
        return this.createJsonErrorResponse(
          415,
          -32000,
          "Unsupported Media Type: Content-Type must be application/json",
        );
      }

      const requestInfo = {
        headers: Object.fromEntries(req.headers.entries()),
        url: new URL(req.url),
      };
      let rawMessage: unknown;
      if (options?.parsedBody !== undefined) {
        rawMessage = options.parsedBody;
      } else {
        try {
          rawMessage = await req.json();
        } catch {
          this.onerror?.(new Error("Parse error: Invalid JSON"));
          return this.createJsonErrorResponse(
            400,
            -32700,
            "Parse error: Invalid JSON",
          );
        }
      }
      let messages: JSONRPCMessage[];
      try {
        if (Array.isArray(rawMessage)) {
          messages = rawMessage.map((msg) => parseJSONRPCMessage(msg));
        } else {
          messages = [parseJSONRPCMessage(rawMessage)];
        }
      } catch {
        this.onerror?.(new Error("Parse error: Invalid JSON-RPC message"));
        return this.createJsonErrorResponse(
          400,
          -32700,
          "Parse error: Invalid JSON-RPC message",
        );
      }

      const isInitializationRequest = messages.some(isInitializeRequest);
      if (isInitializationRequest) {
        if (this._initialized && this.sessionId !== undefined) {
          this.onerror?.(
            new Error("Invalid Request: Server already initialized"),
          );
          return this.createJsonErrorResponse(
            400,
            -32600,
            "Invalid Request: Server already initialized",
          );
        }
        if (messages.length > 1) {
          this.onerror?.(
            new Error(
              "Invalid Request: Only one initialization request is allowed",
            ),
          );
          return this.createJsonErrorResponse(
            400,
            -32600,
            "Invalid Request: Only one initialization request is allowed",
          );
        }
        this.sessionId = this.sessionIdGenerator?.();
        this._initialized = true;
        if (this.sessionId && this._onsessioninitialized) {
          await Promise.resolve(this._onsessioninitialized(this.sessionId));
        }
      }

      if (!isInitializationRequest) {
        const sessionError = this.validateSession(req);
        if (sessionError) return sessionError;
        const protocolError = this.validateProtocolVersion(req);
        if (protocolError) return protocolError;
      }

      const hasRequests = messages.some(isJSONRPCRequest);
      if (!hasRequests) {
        for (const message of messages) {
          this.onmessage?.(message, {
            authInfo: options?.authInfo,
            requestInfo,
          });
        }
        return new Response(null, { status: 202 });
      }

      const streamId = crypto.randomUUID();
      const initRequest = messages.find((m) => isInitializeRequest(m));
      const clientProtocolVersion = initRequest
        ? (initRequest.params?.protocolVersion as string | undefined) ??
          DEFAULT_NEGOTIATED_PROTOCOL_VERSION
        : req.headers.get("mcp-protocol-version") ??
          DEFAULT_NEGOTIATED_PROTOCOL_VERSION;

      if (this._enableJsonResponse) {
        return new Promise<Response>((resolve) => {
          this._streamMapping.set(streamId, {
            resolveJson: resolve,
            cleanup: () => {
              this._streamMapping.delete(streamId);
            },
          });
          for (const message of messages) {
            if (isJSONRPCRequest(message)) {
              this._requestToStreamMapping.set(message.id, streamId);
            }
          }
          for (const message of messages) {
            this.onmessage?.(message, {
              authInfo: options?.authInfo,
              requestInfo,
            });
          }
        });
      }

      // SSE streaming mode
      const encoder = new TextEncoder();
      let streamController!: ReadableStreamDefaultController<Uint8Array>;
      const readable = new ReadableStream<Uint8Array>({
        start: (controller) => {
          streamController = controller;
        },
        cancel: () => {
          this._streamMapping.delete(streamId);
        },
      });
      const headers: Record<string, string> = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      };
      if (this.sessionId !== undefined) {
        headers["mcp-session-id"] = this.sessionId;
      }
      for (const message of messages) {
        if (isJSONRPCRequest(message)) {
          this._streamMapping.set(streamId, {
            controller: streamController,
            encoder,
            cleanup: () => {
              this._streamMapping.delete(streamId);
              try {
                streamController.close();
              } catch {
                // already closed
              }
            },
          });
          this._requestToStreamMapping.set(message.id, streamId);
        }
      }
      await this.writePrimingEvent(
        streamController,
        encoder,
        streamId,
        clientProtocolVersion,
      );
      for (const message of messages) {
        let closeSSEStream: (() => void) | undefined;
        let closeStandaloneSSEStream: (() => void) | undefined;
        if (
          isJSONRPCRequest(message) &&
          this._eventStore &&
          clientProtocolVersion >= "2025-11-25"
        ) {
          closeSSEStream = () => this.closeSSEStream(message.id);
          closeStandaloneSSEStream = () => this.closeStandaloneSSEStream();
        }
        this.onmessage?.(message, {
          authInfo: options?.authInfo,
          requestInfo,
          closeSSEStream,
          closeStandaloneSSEStream,
        } as MessageExtraInfo);
      }
      return new Response(readable, { status: 200, headers });
    } catch (error) {
      this.onerror?.(
        error instanceof Error ? error : new Error(String(error)),
      );
      return this.createJsonErrorResponse(400, -32700, "Parse error", {
        data: String(error),
      });
    }
  }

  private async handleDeleteRequest(req: Request): Promise<Response> {
    const sessionError = this.validateSession(req);
    if (sessionError) return sessionError;
    const protocolError = this.validateProtocolVersion(req);
    if (protocolError) return protocolError;
    if (this.sessionId) {
      await Promise.resolve(this._onsessionclosed?.(this.sessionId));
    }
    await this.close();
    return new Response(null, { status: 200 });
  }

  private validateSession(req: Request): Response | undefined {
    if (this.sessionIdGenerator === undefined) return undefined;
    if (!this._initialized) {
      this.onerror?.(new Error("Bad Request: Server not initialized"));
      return this.createJsonErrorResponse(
        400,
        -32000,
        "Bad Request: Server not initialized",
      );
    }
    const sessionId = req.headers.get("mcp-session-id");
    if (!sessionId) {
      this.onerror?.(
        new Error("Bad Request: Mcp-Session-Id header is required"),
      );
      return this.createJsonErrorResponse(
        400,
        -32000,
        "Bad Request: Mcp-Session-Id header is required",
      );
    }
    if (sessionId !== this.sessionId) {
      this.onerror?.(new Error("Session not found"));
      return this.createJsonErrorResponse(404, -32001, "Session not found");
    }
    return undefined;
  }

  private validateProtocolVersion(req: Request): Response | undefined {
    const protocolVersion = req.headers.get("mcp-protocol-version");
    if (
      protocolVersion !== null &&
      !SUPPORTED_PROTOCOL_VERSIONS.includes(
        protocolVersion as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number],
      )
    ) {
      const msg =
        `Bad Request: Unsupported protocol version: ${protocolVersion} ` +
        `(supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`;
      this.onerror?.(new Error(msg));
      return this.createJsonErrorResponse(400, -32000, msg);
    }
    return undefined;
  }

  async close(): Promise<void> {
    this._streamMapping.forEach(({ cleanup }) => cleanup());
    this._streamMapping.clear();
    this._requestResponseMap.clear();
    this.onclose?.();
  }

  closeSSEStream(requestId: RequestId): void {
    const streamId = this._requestToStreamMapping.get(requestId);
    if (!streamId) return;
    const stream = this._streamMapping.get(streamId);
    if (stream) stream.cleanup();
  }

  closeStandaloneSSEStream(): void {
    const stream = this._streamMapping.get(this._standaloneSseStreamId);
    if (stream) stream.cleanup();
  }

  async send(
    message: JSONRPCMessage,
    options?: { relatedRequestId?: RequestId },
  ): Promise<void> {
    let requestId = options?.relatedRequestId;
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      requestId = (message as { id: RequestId }).id;
    }

    if (requestId === undefined) {
      if (
        isJSONRPCResultResponse(message) ||
        isJSONRPCErrorResponse(message)
      ) {
        throw new Error(
          "Cannot send a response on a standalone SSE stream unless resuming a previous client request",
        );
      }
      let eventId: string | undefined;
      if (this._eventStore) {
        eventId = await this._eventStore.storeEvent(
          this._standaloneSseStreamId,
          message,
        );
      }
      const standaloneSse = this._streamMapping.get(
        this._standaloneSseStreamId,
      );
      if (standaloneSse === undefined) return;
      if (standaloneSse.controller && standaloneSse.encoder) {
        this.writeSSEEvent(
          standaloneSse.controller,
          standaloneSse.encoder,
          message,
          eventId,
        );
      }
      return;
    }

    const streamId = this._requestToStreamMapping.get(requestId);
    if (!streamId) {
      throw new Error(
        `No connection established for request ID: ${String(requestId)}`,
      );
    }
    const stream = this._streamMapping.get(streamId);
    if (!this._enableJsonResponse && stream?.controller && stream?.encoder) {
      let eventId: string | undefined;
      if (this._eventStore) {
        eventId = await this._eventStore.storeEvent(streamId, message);
      }
      this.writeSSEEvent(stream.controller, stream.encoder, message, eventId);
    }

    if (
      isJSONRPCResultResponse(message) ||
      isJSONRPCErrorResponse(message)
    ) {
      this._requestResponseMap.set(requestId, message);
      const relatedIds = Array.from(this._requestToStreamMapping.entries())
        .filter(([_, sid]) => sid === streamId)
        .map(([id]) => id);
      const allResponsesReady = relatedIds.every((id) =>
        this._requestResponseMap.has(id)
      );
      if (allResponsesReady) {
        if (!stream) {
          throw new Error(
            `No connection established for request ID: ${String(requestId)}`,
          );
        }
        if (this._enableJsonResponse && stream.resolveJson) {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };
          if (this.sessionId !== undefined) {
            headers["mcp-session-id"] = this.sessionId;
          }
          const responses = relatedIds.map((id) =>
            this._requestResponseMap.get(id)!
          );
          if (responses.length === 1) {
            stream.resolveJson(
              new Response(JSON.stringify(responses[0]), {
                status: 200,
                headers,
              }),
            );
          } else {
            stream.resolveJson(
              new Response(JSON.stringify(responses), {
                status: 200,
                headers,
              }),
            );
          }
        } else {
          stream.cleanup();
        }
        for (const id of relatedIds) {
          this._requestResponseMap.delete(id);
          this._requestToStreamMapping.delete(id);
        }
      }
    }
  }
}
