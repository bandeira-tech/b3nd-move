/**
 * Mock HTTP Server for testing HttpClient.
 *
 * Acts as a wire-format adapter only — owns HTTP framing (routes, JSON
 * encode/decode, status codes), and keeps received payloads in a
 * minimal `Map<uri, payload>` so subsequent reads can find them.
 *
 * The mock intentionally does NOT use any `Store` implementation —
 * it's a server stand-in, not a Store. Decoupling it from `MemoryStore`
 * keeps the HTTP client tests as pure transport-layer tests, with the
 * backend side reduced to "remember what you were told to remember."
 *
 * Modes:
 * - `happy`               — fully functional
 * - `connectionError`     — server is never started
 * - `validationError`     — receive always rejects with a fixed error
 */

export interface MockServerConfig {
  /** Port to run server on */
  port: number;

  /** Behavior mode */
  mode: "happy" | "connectionError" | "validationError";

  /** Pre-built map for sharing state across mocks. */
  state?: Map<string, unknown>;
}

export class MockHttpServer {
  private server?: Deno.HttpServer;
  private config: MockServerConfig;
  /**
   * The mock's "memory" — a flat `uri → payload` map. No paths, no
   * trees, no `fn=ls`/`fn=count` semantics. The HTTP client tests
   * only need write/read/delete by uri.
   */
  private state: Map<string, unknown>;

  constructor(config: MockServerConfig) {
    this.config = config;
    this.state = config.state ?? new Map();
  }

  async start(): Promise<void> {
    if (this.config.mode === "connectionError") {
      // Don't actually start server for connection error mode
      return;
    }

    const handler = async (req: Request): Promise<Response> => {
      const url = new URL(req.url);

      // Health endpoint
      if (url.pathname === "/api/v1/health") {
        return this.handleHealth();
      }

      // Schema endpoint
      if (url.pathname === "/api/v1/schema") {
        return this.handleSchema();
      }

      // Receive endpoint (unified message interface)
      if (url.pathname === "/api/v1/receive") {
        return await this.handleReceive(req);
      }

      // Read endpoint — batch POST with `{ urls: string[] }`
      if (req.method === "POST" && url.pathname === "/api/v1/read") {
        return await this.handleRead(req);
      }

      return new Response("Not Found", { status: 404 });
    };

    // Create a promise that resolves when the server is actually listening
    let resolveListening: (() => void) | null = null;
    const listeningPromise = new Promise<void>((resolve) => {
      resolveListening = resolve;
    });

    this.server = Deno.serve({
      port: this.config.port,
      hostname: "127.0.0.1",
      onListen: () => {
        if (resolveListening) resolveListening();
      },
    }, handler);

    // Wait for the server to actually be listening
    await listeningPromise;
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.shutdown();
    }
  }

  private handleHealth(): Response {
    return Response.json({
      status: "healthy",
      schema: ["store://"],
      message: "Mock server operational",
    });
  }

  private handleSchema(): Response {
    return Response.json({
      schema: ["store://"],
    });
  }

  private async handleReceive(req: Request): Promise<Response> {
    if (this.config.mode === "validationError") {
      return Response.json(
        [{ accepted: false, error: "Validation failed: Name is required" }],
        { status: 400 },
      );
    }

    // Parse batch of messages: Message[] = [uri, payload][]
    const msgs: unknown = await req.json();

    if (!msgs || !Array.isArray(msgs)) {
      return Response.json(
        [{
          accepted: false,
          error: "Invalid message format: expected Message[]",
        }],
        { status: 400 },
      );
    }

    const results: { accepted: boolean; error?: string }[] = [];

    for (const msg of msgs) {
      if (!Array.isArray(msg) || msg.length < 2) {
        results.push({
          accepted: false,
          error: "Invalid message: expected [uri, payload]",
        });
        continue;
      }

      const [msgUri, msgPayload] = msg;

      // Detect envelope format: { inputs: [...], outputs: [...] }
      const isEnvelope = msgPayload != null &&
        typeof msgPayload === "object" &&
        !Array.isArray(msgPayload) &&
        Array.isArray((msgPayload as Record<string, unknown>).inputs) &&
        Array.isArray((msgPayload as Record<string, unknown>).outputs);

      if (isEnvelope) {
        const { inputs, outputs } = msgPayload as {
          inputs: string[];
          outputs: unknown[][];
        };

        for (const inputUri of inputs) this.state.delete(inputUri);

        for (const output of outputs) {
          if (Array.isArray(output) && output.length >= 2) {
            const [outUri, outPayload] = output;
            this.state.set(outUri as string, outPayload);
          }
        }
      } else {
        // Direct write — remember payload at the message URI
        this.state.set(msgUri as string, msgPayload);
      }

      results.push({ accepted: true });
    }

    return Response.json(results);
  }

  private async handleRead(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const urls = (body as { urls?: unknown })?.urls;
    if (!Array.isArray(urls) || !urls.every((u) => typeof u === "string")) {
      return Response.json(
        { error: "Expected { urls: string[] }" },
        { status: 400 },
      );
    }
    // Payloads pass through as-is; content semantics are not a
    // transport concern. Two cases the mock has to satisfy:
    //   - point read (uri without trailing slash) → look up the key,
    //     return `[url, payload | undefined]`.
    //   - trailing-slash list — the wire-format suite asserts that
    //     reading `prefix/` returns an `Output[]` of entries under
    //     the prefix. The mock answers this with a flat prefix scan
    //     (NOT a tree walk — we don't pretend to be a Store with
    //     specific ls semantics; we just hand back every key that
    //     starts with the prefix so the HTTP client tests have
    //     something to verify the wire frames).
    const out = (urls as string[]).map((u): [string, unknown] => {
      if (u.endsWith("/")) {
        const entries: [string, unknown][] = [];
        for (const [k, v] of this.state) {
          if (k.startsWith(u)) entries.push([k, v]);
        }
        return [u, entries];
      }
      return [u, this.state.get(u)];
    });
    return Response.json(out);
  }
}

/**
 * Create mock server instances for testing
 */
export async function createMockServers(): Promise<{
  happy: MockHttpServer;
  validationError: MockHttpServer;
  cleanup: () => Promise<void>;
}> {
  const happy = new MockHttpServer({
    port: 8765,
    mode: "happy",
  });

  const validationError = new MockHttpServer({
    port: 8766,
    mode: "validationError",
  });

  await happy.start();
  await validationError.start();

  return {
    happy,
    validationError,
    cleanup: async () => {
      await happy.stop();
      await validationError.stop();
    },
  };
}
