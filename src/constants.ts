import { status } from "@grpc/grpc-js";

/**
 * Supported gRPC request types
 * @enum {string}
 * @readonly
 */
export enum RequestMethodType {
  UnaryRequest = "makeUnaryRequest",
  ClientStreamRequest = "makeClientStreamRequest",
  ServerStreamRequest = "makeServerStreamRequest",
  BidiStreamRequest = "makeBidiStreamRequest",
}

/**
 * Default list of status that can be retried
 * @type {status[]}
 */
export const DEFAULT_RETRY_STATUS_CODES: status[] = [
  status.CANCELLED,
  status.UNKNOWN,
  status.DEADLINE_EXCEEDED,
  status.INTERNAL,
];
