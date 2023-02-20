import { Metadata, ServiceError, status } from "@grpc/grpc-js";
import type { UntypedProtoRequest } from "./untyped";

/**
 * Utility class to create errors for gRPC requests
 */
export class RequestError extends Error implements ServiceError {
  /**
   * Error status code
   * @type {status}
   * @readonly
   */
  public readonly code: status;

  /**
   * Error details
   * @type {string}
   * @readonly
   */
  public readonly details: string;

  /**
   * Request metadata
   * @type {Metadata}
   * @readonly
   */
  public readonly metadata: Metadata;

  /**
   * Creates custom error for gRPC requests
   * @param {status} code Status code representing the error
   * @param {ProtoRequest} request ProtoRequest instance which triggered this error
   * @param {string} [details] Error details (message)
   */
  constructor(code: status, request: UntypedProtoRequest, details?: string) {
    if (!details) {
      if (code === status.CANCELLED) {
        details = `Cancelled ${request.requestMethodType} for '${request.method}'`;
      } else if (code === status.DEADLINE_EXCEEDED) {
        details = `${request.requestMethodType} for '${request.method}' timed out`;
      } else {
        details = `${code} ${status[code]}: ${request.requestMethodType} for '${request.method}'`;
      }
    }
    super(details);

    this.code = code;
    this.details = details;
    this.metadata = request.metadata;
  }
}
