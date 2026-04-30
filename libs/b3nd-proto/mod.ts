/**
 * @module
 * b3nd proto — wire types and converters for gRPC transport.
 *
 * Re-exports schema types and conversion functions used by
 * both `@b3nd/server-grpc` and `@b3nd/client-grpc`.
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
} from "./schema.ts";

export {
  messageToReceiveRequest,
  readResultFromProto,
  readResultToProto,
  receiveRequestToMessage,
  receiveResponseToResult,
  receiveResultToResponse,
  statusResponseToResult,
  statusResultToResponse,
} from "./convert.ts";
