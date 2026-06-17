/**
 * @module
 * Wire-shape predicates + constants for MCP Streamable HTTP.
 *
 * Hand-rolled to replace the slices of the MCP SDK `types` module we
 * used. The SDK derives these from Zod schemas (`safeParse` checks);
 * we use plain structural type-guards. Cheaper and lets b3nd-move ship
 * without the SDK at runtime.
 *
 * Background on why we vendored: see the design doc shipped with the
 * 0.18.0 release.
 */

export type RequestId = string | number;

export interface Request {
  method: string;
  params?: Record<string, unknown>;
}

export interface Notification {
  method: string;
  params?: Record<string, unknown>;
}

export interface JSONRPCRequest extends Request {
  jsonrpc: "2.0";
  id: RequestId;
}

export interface JSONRPCNotification extends Notification {
  jsonrpc: "2.0";
}

export interface JSONRPCResultResponse<T = unknown> {
  jsonrpc: "2.0";
  id: RequestId;
  result: T;
}

export interface JSONRPCErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface JSONRPCErrorResponse {
  jsonrpc: "2.0";
  id?: RequestId | null;
  error: JSONRPCErrorBody;
}

export type JSONRPCMessage =
  | JSONRPCRequest
  | JSONRPCNotification
  | JSONRPCResultResponse
  | JSONRPCErrorResponse;

export interface MessageExtraInfo {
  authInfo?: unknown;
  requestInfo?: unknown;
}

export const JSONRPC_VERSION = "2.0" as const;

// Supported protocol revisions for `Mcp-Protocol-Version` negotiation.
// Mirror of the SDK's list at the time of vendoring. The transport
// negotiates the lowest common version with the client.
export const LATEST_PROTOCOL_VERSION = "2025-11-25";
export const DEFAULT_NEGOTIATED_PROTOCOL_VERSION = "2025-03-26";
export const SUPPORTED_PROTOCOL_VERSIONS = [
  LATEST_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isJsonrpc(v: unknown): v is Record<string, unknown> {
  return isObject(v) &&
    (v as Record<string, unknown>).jsonrpc === JSONRPC_VERSION;
}

function hasId(v: Record<string, unknown>): boolean {
  const id = v.id;
  return typeof id === "string" || typeof id === "number";
}

function hasMethod(v: Record<string, unknown>): boolean {
  return typeof v.method === "string";
}

export function isJSONRPCRequest(value: unknown): value is JSONRPCRequest {
  return (
    isJsonrpc(value) && hasId(value) && hasMethod(value)
  );
}

export function isJSONRPCNotification(
  value: unknown,
): value is JSONRPCNotification {
  return (
    isJsonrpc(value) &&
    !hasId(value) &&
    hasMethod(value)
  );
}

export function isJSONRPCResultResponse(
  value: unknown,
): value is JSONRPCResultResponse {
  return (
    isJsonrpc(value) &&
    hasId(value) &&
    isObject((value as Record<string, unknown>).result)
  );
}

export function isJSONRPCErrorResponse(
  value: unknown,
): value is JSONRPCErrorResponse {
  if (!isJsonrpc(value)) return false;
  const err = (value as Record<string, unknown>).error;
  return (
    isObject(err) &&
    typeof (err as Record<string, unknown>).code === "number" &&
    typeof (err as Record<string, unknown>).message === "string"
  );
}

export function isJSONRPCMessage(value: unknown): value is JSONRPCMessage {
  return (
    isJSONRPCRequest(value) ||
    isJSONRPCNotification(value) ||
    isJSONRPCResultResponse(value) ||
    isJSONRPCErrorResponse(value)
  );
}

export function isInitializeRequest(value: unknown): value is JSONRPCRequest {
  return isJSONRPCRequest(value) && value.method === "initialize";
}

/**
 * Parse a JSON-RPC message from already-decoded JSON. Throws on malformed
 * input (the SDK uses `JSONRPCMessageSchema.parse(value)` which throws —
 * we keep the same contract).
 */
export function parseJSONRPCMessage(value: unknown): JSONRPCMessage {
  if (!isJSONRPCMessage(value)) {
    throw new Error("Invalid JSON-RPC message");
  }
  return value;
}
