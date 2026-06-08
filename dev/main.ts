/**
 * `deno task serve` entry point.
 *
 * Builds a `stubRig`-backed runner — canned echo semantics — and starts
 * the requested transports. Useful for poking the wire from outside
 * Deno (curl, Postman, browser dev tools); not a real backend.
 * Production deployments build their own rig and runner.
 *
 * Usage:
 *   deno task serve --http               # http on :3000
 *   deno task serve --http=4000          # http on :4000
 *   deno task serve --http --ws --grpc   # all three on defaults
 *   deno task serve --grpc=50051 --hostname=127.0.0.1
 *   deno task serve --mcp                # MCP on stdio (must be alone)
 *   deno task serve --mcp-http           # MCP over Streamable HTTP on :3001
 *   deno task serve --mcp-ws             # MCP over WebSocket on :8081
 */

/// <reference lib="deno.ns" />

import type { Rig } from "@bandeira-tech/b3nd-core/rig";
import { stubRig } from "../tests/rigs/stub.ts";
import { serve, type ServerConfig, type TransportServer } from "./serve.ts";

const HELP = `
deno task serve [flags]

Flags:
  --http[=PORT]      Start HTTP transport (default port 3000)
  --ws[=PORT]        Start WebSocket transport (default port 8080)
  --grpc[=PORT]      Start gRPC-HTTP transport (default port 50051)
  --mcp              Start MCP transport over stdio (mutually exclusive
                     with the network transports — stdout is the wire)
  --mcp-http[=PORT]  Start MCP over Streamable HTTP (default port 3001)
  --mcp-ws[=PORT]    Start MCP over WebSocket (default port 8081)
  --hostname=HOST    Bind hostname for network transports (default 0.0.0.0)
  -h, --help         Show this message

Examples:
  deno task serve --http
  deno task serve --http=4000 --ws
  deno task serve --grpc=50051 --hostname=127.0.0.1
  deno task serve --mcp
`.trim();

interface ParsedArgs {
  configs: ServerConfig[];
  hostname?: string;
  help: boolean;
}

function parsePortFlag(arg: string, prefix: string): number | undefined {
  // --http or --http=3000
  if (arg === prefix) return undefined;
  if (arg.startsWith(`${prefix}=`)) {
    const raw = arg.slice(prefix.length + 1);
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 65535) {
      throw new Error(`Invalid port for ${prefix}: ${raw}`);
    }
    return n;
  }
  return undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { configs: [], help: false };
  for (const arg of argv) {
    // `--` is a no-op separator that some shells / task runners pass through.
    if (arg === "--") continue;
    if (arg === "-h" || arg === "--help") {
      out.help = true;
      continue;
    }
    if (arg === "--http" || arg.startsWith("--http=")) {
      const port = parsePortFlag(arg, "--http");
      out.configs.push({
        transport: "http",
        ...(port !== undefined && { port }),
      });
      continue;
    }
    if (arg === "--ws" || arg.startsWith("--ws=")) {
      const port = parsePortFlag(arg, "--ws");
      out.configs.push({
        transport: "ws",
        ...(port !== undefined && { port }),
      });
      continue;
    }
    if (arg === "--grpc" || arg.startsWith("--grpc=")) {
      const port = parsePortFlag(arg, "--grpc");
      out.configs.push({
        transport: "grpc-http",
        ...(port !== undefined && { port }),
      });
      continue;
    }
    if (arg === "--mcp") {
      out.configs.push({ transport: "mcp" });
      continue;
    }
    if (arg === "--mcp-http" || arg.startsWith("--mcp-http=")) {
      const port = parsePortFlag(arg, "--mcp-http");
      out.configs.push({
        transport: "mcp-http",
        ...(port !== undefined && { port }),
      });
      continue;
    }
    if (arg === "--mcp-ws" || arg.startsWith("--mcp-ws=")) {
      const port = parsePortFlag(arg, "--mcp-ws");
      out.configs.push({
        transport: "mcp-ws",
        ...(port !== undefined && { port }),
      });
      continue;
    }
    if (arg.startsWith("--hostname=")) {
      out.hostname = arg.slice("--hostname=".length);
      continue;
    }
    throw new Error(`Unknown flag: ${arg}`);
  }
  return out;
}

function buildRig(): Rig {
  return stubRig();
}

function applyHostname(
  configs: ServerConfig[],
  hostname: string | undefined,
): ServerConfig[] {
  if (!hostname) return configs;
  return configs.map((c) => {
    if (c.transport === "mcp") return c;
    return { ...c, hostname };
  });
}

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(Deno.args);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error("\n" + HELP);
    Deno.exit(2);
  }

  if (parsed.help) {
    console.log(HELP);
    return;
  }

  if (parsed.configs.length === 0) {
    console.error("No transport flags given.\n");
    console.error(HELP);
    Deno.exit(2);
  }

  const hasMcp = parsed.configs.some((c) => c.transport === "mcp");
  if (hasMcp && parsed.configs.length > 1) {
    console.error(
      "--mcp must be the only transport (it owns stdout for the wire protocol).",
    );
    Deno.exit(2);
  }

  const configs = applyHostname(parsed.configs, parsed.hostname);
  const rig = buildRig();
  const servers: TransportServer[] = configs.map((c) => serve(rig, c));

  await Promise.all(servers.map((s) => s.start()));

  // MCP blocks on stdio internally; once start resolves the client
  // owns the lifecycle, so don't print or wait for signals.
  if (hasMcp) return;

  for (const s of servers) {
    console.error(`[${s.transport}] listening on ${s.address}`);
  }
  console.error("Press Ctrl+C to stop.");

  await waitForShutdownSignal();

  console.error("\nShutting down…");
  await Promise.all(servers.map((s) => s.stop()));
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const onSignal = () => {
      Deno.removeSignalListener("SIGINT", onSignal);
      Deno.removeSignalListener("SIGTERM", onSignal);
      resolve();
    };
    Deno.addSignalListener("SIGINT", onSignal);
    Deno.addSignalListener("SIGTERM", onSignal);
  });
}

if (import.meta.main) {
  await main();
}
