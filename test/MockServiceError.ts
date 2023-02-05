import { ServiceError, status, Metadata } from "@grpc/grpc-js";

export class MockServiceError extends Error implements ServiceError {
  public code: status;
  public details: string;
  public metadata: Metadata;

  constructor(code: status, details?: string) {
    details ||= `${code} ${status[code]}`;
    super(details);
    this.code = code;
    this.details = details;
    this.metadata = new Metadata();
  }
}
