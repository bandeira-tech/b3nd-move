/**
 * @module
 * gRPC wire schema and converters between b3nd core types and proto types.
 *
 * The .proto file (`libs/b3nd-proto/b3nd.proto`) is the canonical schema
 * for external tooling (grpcurl, buf, etc.).
 */

export type {
  ObserveRequest,
  ReadRequest,
  ReadResponse,
  ReadResultProto,
  ReceiveRequest,
  ReceiveResponse,
  RecordProto,
  StatusRequest,
  StatusResponse,
} from "../libs/b3nd-proto/schema.ts";
export {
  messageToReceiveRequest,
  readResultFromProto,
  readResultToProto,
  receiveRequestToMessage,
  receiveResponseToResult,
  receiveResultToResponse,
  statusResponseToResult,
  statusResultToResponse,
} from "../libs/b3nd-proto/convert.ts";
