import type { ProtoRequest } from "./ProtoRequest";
import type * as Protobuf from "protobufjs";
import type { UntypedProtoRequest } from "./untyped";
import type { ProtoClient } from "./ProtoClient";
import type {
  CallOptions,
  ChannelCredentials,
  ClientOptions,
  Metadata,
  MetadataValue,
  status,
} from "@grpc/grpc-js";
import type { VerifyOptions } from "@grpc/grpc-js/build/src/channel-credentials";

/**
 * Method filter function
 * @param method Fully qualified method name to check
 * @param request Request instance to check
 */
export type EndpointMatcher = (
  method: string,
  request: ProtoRequest<unknown, unknown>
) => boolean;

/**
 * Middleware to run before each request
 * @param request Initialized, but not started, gRPC request
 * @param client Parent client instance
 */
export type RequestMiddleware = (
  request: UntypedProtoRequest,
  client: ProtoClient
) => Promise<void>;

/**
 * Service endpoint configuration
 */
export interface ClientEndpoint {
  /**
   * Remote server address (with port built in)
   */
  address: string;

  /**
   * For configuring secure credentials when connecting to service endpoint
   */
  credentials?:
    | ChannelCredentials
    | {
        /**
         * Root certificate data
         */
        rootCerts?: Buffer;

        /**
         * Client certificate private key, if available
         */
        privateKey?: Buffer;

        /**
         * Client certificate key chain, if available
         */
        certChain?: Buffer;

        /**
         * Additional options to modify certificate verification
         */
        verifyOptions?: VerifyOptions;
      };

  /**
   * gRPC client options for a connection
   */
  clientOptions?: ClientOptions;

  /**
   * Custom matching of proto method namespace to client endpoint
   */
  match?: string | RegExp | EndpointMatcher;
}

/**
 * Client Settings
 */
export interface ClientSettings {
  /**
   * Either
   */
  endpoint: string | ClientEndpoint | ClientEndpoint[];

  /**
   * Indicates if error should be thrown when caller cancels the request
   */
  rejectOnAbort?: true;

  /**
   * Time in milliseconds before cancelling the request. Defaults to 0 for no timeout
   */
  timeout?: number;

  /**
   * Retry logic for every request
   */
  retryOptions?: RequestOptions["retryOptions"];
}

/**
 * Protobuf parsing settings
 */
export interface ProtoSettings {
  /**
   * Custom root protobuf namespace, for skipping proto file paths
   */
  root?: Protobuf.Root;

  /**
   * Proto file path(s)
   */
  files?: string | string[];

  /**
   * Parsing options for proto files passed
   */
  parseOptions?: Protobuf.IParseOptions;

  /**
   * Message conversion options
   */
  conversionOptions?: Protobuf.IConversionOptions;
}

/**
 * Iteration callback for streamed responses
 * @param row Streamed response row
 * @param rowIndex Index for the current chunked row
 * @param request Currently active request
 */
export type StreamReader<RequestType, ResponseType> = (
  row: ResponseType,
  rowIndex: number,
  request: ProtoRequest<RequestType, ResponseType>
) => Promise<void>;

/**
 * Writing wrapper for streamed requests
 * @param write Async function for sending an object over the write stream
 * @param request Currently active request
 */
export type StreamWriterSandbox<RequestType, ResponseType> = (
  write: StreamWriter<RequestType>,
  request: ProtoRequest<RequestType, ResponseType>
) => Promise<void>;

/**
 * Writing function for sending objects to the write stream
 * @param data Request data row to be streamed
 * @param encoding Write encoding for the data
 */
export type StreamWriter<RequestType> = (
  data: RequestType,
  encoding?: string
) => Promise<void>;

/**
 * Custom retry logic options
 */
export interface RequestRetryOptions {
  /**
   * Number of times to retry request. Defaults to none
   */
  retryCount?: number;

  /**
   * Status codes request is allowed to retry on
   */
  status?: status | status[];

  /**
   * Indicates if retry should occur after internal client timeout. Defaults to true
   */
  retryOnClientTimeout?: boolean;
}

/**
 * Request specific options
 */
export interface RequestOptions {
  /**
   * Controller for aborting the active request
   */
  abortController?: AbortController;

  /**
   * Metadata to be attached to the request
   */
  metadata?: Record<string, MetadataValue | MetadataValue[]> | Metadata;

  /**
   * Request specific options
   */
  callOptions?: CallOptions;

  /**
   * Time in milliseconds before cancelling the request. Defaults to 0 for no timeout
   */
  timeout?: number;

  /**
   * Indicates retry logic that should be applied to the request
   * @alias boolean Retries the request once for default status code failures when true, disable retry when false
   * @alias number Number of retries to allow for default status code failures
   * @alias RequestRetryOptions Custom retry options
   */
  retryOptions?: boolean | number | RequestRetryOptions;
}
