import { Metadata, ServiceError, status } from "@grpc/grpc-js";
import type { ProtoRequest } from "./ProtoRequest";

// Shortcut reference to generic ProtoRequest type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProtoRequest = ProtoRequest<any, any>;

/**
 * Utility class to create errors for gRPC requests
 */
export class RequestError extends Error implements ServiceError {
  /**
   * Error status code
   */
  public code: status;

  /**
   * Error details
   */
  public details: string;

  /**
   * Request metadata
   */
  public metadata: Metadata;

  /**
   * Creates custom error for gRPC requests
   * @param code Status code representing the error
   * @param request ProtoRequest instance which triggered this error
   * @param details Error details (message)
   */
  constructor(code: status, request: AnyProtoRequest, details?: string) {
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
