import { ProtoRequest } from "./ProtoRequest";
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
import type { RequestMethodType } from "./constants";
import type { EventEmitter, Readable } from "stream";

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
   * Indicates if request/response errors should be thrown. Defaults to false
   */
  rejectOnError?: boolean;

  /**
   * Indicates if error should be thrown when caller cancels the request. Defaults to false
   */
  rejectOnAbort?: boolean;

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

/**
 * Parameters for generating any proto request
 */
export interface GenericRequestParams<RequestType, ResponseType> {
  /**
   * Fully qualified path of the method for the request that can be used by protobufjs.lookup
   */
  method: string;
  /**
   * Type of method for the request
   */
  requestMethodType?: RequestMethodType;
  /**
   * Data to be sent for unary requests
   */
  data?: RequestType;
  /**
   * Pipes data from a stream to the request stream
   */
  pipeStream?: EventEmitter | Readable;
  /**
   * Write sandbox for sending data on request streams
   */
  writerSandbox?: StreamWriterSandbox<RequestType, ResponseType>;
  /**
   * Read iterator for listening on response streams
   */
  streamReader?: StreamReader<RequestType, ResponseType>;
  /**
   * Request specific options
   */
  requestOptions?: RequestOptions;
}

/**
 * Unix timestamps of important markers throughout the request lifecycle
 */
export interface RequestLifecycleTiming {
  /** Timestamp of when the request started */
  started_at: number;
  /** Timestamp of when the request resolved with an error */
  errored_at?: number;
  /** Timestamp of when the request resolved */
  ended_at?: number;

  /** Middleware specific time logs */
  middleware: {
    /** Timestamp of when request starts to run all middleware */
    started_at?: number;
    /** Timestamp of when error occurs during middleware */
    errored_at?: number;
    /** Timestamp of when all middleware is complete */
    ended_at?: number;

    /** Individual timestamps for each middleware that is run */
    middleware: Array<{
      /** Timestamp of when individual middleware starts */
      started_at: number;
      /** Timestamp of when individual middleware ends */
      ended_at?: number;
    }>;
  };

  /** Time markers for each attempt (or retry) this request makes */
  attempts: Array<{
    /** Timestamp of when this attempt starts */
    started_at: number;
    /** Timestamp of when this attempt receives response metadata */
    metadata_received_at?: number;
    /** Timestamp of when this attempt receives the status data (includes trailing metadata) */
    status_received_at?: number;
    /** Timestamp of when this attempt finishes with an error */
    errored_at?: number;
    /** Timestamp of when this attempt finishes */
    ended_at?: number;

    /** Time markers for writers sandbox on this attempt */
    write_stream?: {
      /** Timestamp of when the writers sandbox starts */
      started_at: number;
      /** Timestamp of when an error is thrown from the sandbox */
      errored_at?: number;
      /** Timestamp of when the sandbox is complete */
      ended_at?: number;

      /** Time markers for individual writes */
      messages: Array<{
        /** Timestamp of when a write to the stream starts */
        started_at: number;
        /** Timestamp of when a write to the stream completes */
        written_at?: number;
      }>;
    };

    /** Time markers when piping a stream to the request stream for this attempt */
    pipe_stream?: {
      /** Timestamp of when piping starts */
      started_at: number;
      /** Timestamp of when an error is found during piping */
      errored_at?: number;
      /** Timestamp of when piping completes */
      ended_at?: number;

      /** Time markers for individual piped messages */
      messages: Array<{
        /** Timestamp of when a message is received from the pipe */
        received_at: number;
        /** Timestamp of when a message is finishes writing to the request stream */
        written_at?: number;
      }>;
    };

    /** Time markers when reading messages from the response stream for this attempt */
    read_stream?: {
      /** Timestamp of when the reading starts */
      started_at: number;
      /** Timestamp of when an error is found during reading */
      errored_at?: number;
      /** Timestamp of when reading completes */
      ended_at?: number;
      /** Timestamp of when the last [used] message is fully processed */
      last_processed_at?: number;

      /** Time markers for individual read messages */
      messages: Array<{
        /** Timestamp of when a message is received from the response */
        received_at: number;
        /** Timestamp of when a message iteterator completes processing of the message */
        ended_at?: number;
      }>;
    };
  }>;
}
