/**
 * @module
 * Hand-written TypeScript types matching b3nd.proto.
 *
 * These types are the wire format for gRPC — used by both
 * the server (b3nd-server-grpc) and client (b3nd-client-grpc).
 *
 * Avoids a build-time buf codegen step. The .proto file remains
 * the source of truth for external tooling (grpcurl, buf, etc.).
 */

// ── Request / Response types ────────────────────────────────────────

export interface ReceiveRequest {
  uri: string;
  data: Uint8Array;
  dataIsBinary: boolean;
}

export interface ReceiveResponse {
  accepted: boolean;
  error: string;
}

export interface ReadRequest {
  uris: string[];
}

export interface ReadResponse {
  results: ReadResultProto[];
}

export interface ReadResultProto {
  success: boolean;
  uri: string;
  error: string;
  record?: RecordProto;
}

export interface RecordProto {
  data: Uint8Array;
  dataIsBinary: boolean;
}

export interface ObserveRequest {
  pattern: string;
}

export type StatusRequest = Record<string, never>;

export interface StatusResponse {
  status: string;
  message: string;
  schemaJson: string;
  detailsJson: string;
}
