import { status } from "@grpc/grpc-js";

/**
 * Supported gRPC request types
 */
export const enum RequestMethodType {
  UnaryRequest = "makeUnaryRequest",
  ClientStreamRequest = "makeClientStreamRequest",
  ServerStreamRequest = "makeServerStreamRequest",
  BidiStreamRequest = "makeBidiStreamRequest",
}

/**
 * Default list of status that can be retried
 */
export const DEFAULT_RETRY_STATUS_CODES: status[] = [
  status.CANCELLED,
  status.UNKNOWN,
  status.DEADLINE_EXCEEDED,
  status.INTERNAL,
];
