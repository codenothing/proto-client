import * as Protobuf from "protobufjs";
import { EventEmitter } from "events";
import {
  CallOptions,
  ClientDuplexStream,
  ClientReadableStream,
  ClientUnaryCall,
  ClientWritableStream,
  Metadata,
  ServiceError,
  status,
  StatusObject,
} from "@grpc/grpc-js";
import type { ProtoClient } from "./ProtoClient";
import { RequestError } from "./RequestError";
import { DEFAULT_RETRY_STATUS_CODES, RequestMethodType } from "./constants";
import type {
  GenericRequestParams,
  RequestRetryOptions,
  StreamReader,
  StreamWriterSandbox,
} from "./interfaces";
import { normalizeRetryOptions } from "./util";
import { promisify } from "util";
import type { Readable } from "stream";

// Shortcut types to proto functional parameters
type VerifyArgs = Parameters<typeof Protobuf.Message.verify>;
type CreateArgs = Parameters<typeof Protobuf.Message.create>;

/**
 * Internal reason for resolving request
 * @private
 */
const enum ResolutionType {
  Default,
  Abort,
}

/**
 * Add internal options to external request params
 * @private
 */
interface ProtoRequestProps<RequestType, ResponseType>
  extends GenericRequestParams<RequestType, ResponseType> {
  /**
   * ProtoClient tied to the request
   */
  client: ProtoClient;
  /**
   * For testing purposes only, block starting of the proto request
   */
  blockAutoStart?: true;
}

/**
 * Custom event typings
 */
export interface ProtoRequest<RequestType, ResponseType> {
  on(
    event: "data",
    listener: (
      data: ResponseType,
      request: ProtoRequest<RequestType, ResponseType>
    ) => void
  ): this;
  on(
    event: "response",
    listener: (request: ProtoRequest<RequestType, ResponseType>) => void
  ): this;
  on(
    event: "retry",
    listener: (request: ProtoRequest<RequestType, ResponseType>) => void
  ): this;
  on(
    event: "aborted",
    listener: (request: ProtoRequest<RequestType, ResponseType>) => void
  ): this;
  on(
    event: "error",
    listener: (
      error: Error,
      request: ProtoRequest<RequestType, ResponseType>
    ) => void
  ): this;
  on(
    event: "end",
    listener: (request: ProtoRequest<RequestType, ResponseType>) => void
  ): this;
  on(
    event: "close",
    listener: (request: ProtoRequest<RequestType, ResponseType>) => void
  ): this;

  once(
    event: "data",
    listener: (
      data: ResponseType,
      request: ProtoRequest<RequestType, ResponseType>
    ) => void
  ): this;
  once(
    event: "response",
    listener: (request: ProtoRequest<RequestType, ResponseType>) => void
  ): this;
  once(
    event: "retry",
    listener: (request: ProtoRequest<RequestType, ResponseType>) => void
  ): this;
  once(
    event: "aborted",
    listener: (request: ProtoRequest<RequestType, ResponseType>) => void
  ): this;
  once(
    event: "error",
    listener: (
      error: Error,
      request: ProtoRequest<RequestType, ResponseType>
    ) => void
  ): this;
  once(
    event: "end",
    listener: (request: ProtoRequest<RequestType, ResponseType>) => void
  ): this;
  once(
    event: "close",
    listener: (request: ProtoRequest<RequestType, ResponseType>) => void
  ): this;

  off(
    event: "data",
    listener: (
      data: ResponseType,
      request: ProtoRequest<RequestType, ResponseType>
    ) => void
  ): this;
  off(
    event: "response",
    listener: (request: ProtoRequest<RequestType, ResponseType>) => void
  ): this;
  off(
    event: "retry",
    listener: (request: ProtoRequest<RequestType, ResponseType>) => void
  ): this;
  off(
    event: "aborted",
    listener: (request: ProtoRequest<RequestType, ResponseType>) => void
  ): this;
  off(
    event: "error",
    listener: (
      error: Error,
      request: ProtoRequest<RequestType, ResponseType>
    ) => void
  ): this;
  off(
    event: "end",
    listener: (request: ProtoRequest<RequestType, ResponseType>) => void
  ): this;
  off(
    event: "close",
    listener: (request: ProtoRequest<RequestType, ResponseType>) => void
  ): this;

  emit(
    event: "data",
    data: ResponseType,
    request: ProtoRequest<RequestType, ResponseType>
  ): this;
  emit(
    eventName: "response",
    request: ProtoRequest<RequestType, ResponseType>
  ): boolean;
  emit(
    eventName: "retry",
    request: ProtoRequest<RequestType, ResponseType>
  ): boolean;
  emit(
    eventName: "aborted",
    request: ProtoRequest<RequestType, ResponseType>
  ): boolean;
  emit(
    eventName: "error",
    error: Error,
    request: ProtoRequest<RequestType, ResponseType>
  ): boolean;
  emit(
    eventName: "end",
    request: ProtoRequest<RequestType, ResponseType>
  ): boolean;
  emit(
    eventName: "close",
    request: ProtoRequest<RequestType, ResponseType>
  ): boolean;
}

/**
 * Individual gRPC request
 */
export class ProtoRequest<RequestType, ResponseType> extends EventEmitter {
  /**
   * Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @type {string}
   * @readonly
   */
  public readonly method: string;

  /**
   * Generated request path
   * @type {string}
   * @readonly
   */
  public readonly requestPath: string;

  /**
   * Request proto message type
   * @type {Protobuf.Method}
   * @readonly
   */
  public readonly serviceMethod: Protobuf.Method;

  /**
   * Request proto message type
   * @type {Protobuf.Type}
   * @readonly
   */
  public readonly requestType: Protobuf.Type;

  /**
   * Response proto message type
   * @type {Protobuf.Type}
   * @readonly
   */
  public readonly responseType: Protobuf.Type;

  /**
   * Request method type
   * @type {RequestMethodType}
   * @readonly
   */
  public readonly requestMethodType: RequestMethodType;

  /**
   * Request method type
   * @type {boolean}
   * @readonly
   */
  public readonly isRequestStream: boolean;

  /**
   * Request method type
   * @type {boolean}
   * @readonly
   */
  public readonly isResponseStream: boolean;

  /**
   * Data sent for unary requests
   * @type {RequestType | undefined}
   * @readonly
   */
  public readonly requestData?: RequestType;

  /**
   * Pipes data from a stream to the request stream
   * @type {EventEmitter | Readable | undefined}
   * @readonly
   */
  public readonly pipeStream?: EventEmitter | Readable;

  /**
   * Writer sandbox for request streams
   * @type {StreamWriterSandbox | undefined}
   * @readonly
   */
  public readonly writerSandbox?: StreamWriterSandbox<
    RequestType,
    ResponseType
  >;

  /**
   * Read iterator for response streams
   * @type {StreamReader | undefined}
   * @readonly
   */
  public readonly streamReader?: StreamReader<RequestType, ResponseType>;

  /**
   * Time in milliseconds before cancelling the request
   * @type {number}
   * @readonly
   */
  public readonly timeout: number;

  /**
   * Configured retry options for this request
   * @type {RequestRetryOptions}
   * @readonly
   */
  public readonly retryOptions: RequestRetryOptions;

  /**
   * AbortController tied to the request
   * @type {AbortController}
   * @readonly
   */
  public readonly abortController: AbortController;

  /**
   * Metadata instance for the request
   * @type {Metadata}
   * @readonly
   */
  public readonly metadata: Metadata;

  /**
   * Request specific options
   * @type {CallOptions}
   * @readonly
   */
  public readonly callOptions: CallOptions;

  /**
   * Data response from the service, only valid for unary and client stream requests
   * @type {ResponseType}
   */
  public result?: ResponseType;

  /**
   * Metadata returned from the service
   * @type {Metadata | undefined}
   */
  public responseMetadata?: Metadata;

  /**
   * Metadata returned from the service
   * @type {StatusObject | undefined}
   */
  public responseStatus?: StatusObject;

  /**
   * Number of retries made for this request
   * @type {number}
   */
  public retries = 0;

  /**
   * References any error that may have occurred during the request
   * @type {Error}
   */
  public error?: Error;

  /**
   * When retries are enabled, all errors will be stored here
   * @type {Error[]}
   * @readonly
   */
  public readonly responseErrors: Error[] = [];

  /**
   * Internal reference to the parent client instance
   * @type {ProtoClient}
   * @readonly
   * @private
   */
  private readonly client: ProtoClient;

  /**
   * End promise queue while request is active
   * @type {Promise[]}
   * @private
   */
  private endPromiseQueue: Array<{
    resolve: (request: ProtoRequest<RequestType, ResponseType>) => void;
    reject: (error: Error) => void;
  }> = [];

  /**
   * Reference to the called stream from within the method
   * @type {ClientUnaryCall | ClientReadableStream | ClientWritableStream | ClientDuplexStream | null}
   * @private
   */
  private stream:
    | ClientUnaryCall
    | ClientReadableStream<ResponseType>
    | ClientWritableStream<RequestType>
    | ClientDuplexStream<RequestType, ResponseType>
    | null = null;

  /**
   * Internal reference to tracking activity of the request
   * @type {boolean}
   * @private
   */
  private isRequestActive = true;

  /**
   * Internal representation of how the request was resolved
   * @type {ResolutionType | undefined}
   * @private
   */
  private resolutionType?: ResolutionType;

  /**
   * Internal class for managing individual requests
   * @package
   * @private
   */
  constructor({
    client,
    method,
    requestMethodType,
    data,
    pipeStream,
    writerSandbox,
    streamReader,
    requestOptions,
    blockAutoStart,
  }: ProtoRequestProps<RequestType, ResponseType>) {
    super();

    this.method = method;
    this.client = client;
    this.requestData = data;
    this.pipeStream = pipeStream;
    this.writerSandbox = writerSandbox;
    this.streamReader = streamReader;

    // Break down the method to configure the path
    const methodParts = this.method.split(/\./g);
    const methodName = methodParts.pop();
    const serviceName = methodParts.join(".");
    this.requestPath = `/${serviceName}/${methodName}`;

    // Validate service method exists
    const service = this.client.getRoot().lookupService(serviceName);
    this.serviceMethod = service.methods[methodName as string];
    if (!this.serviceMethod) {
      throw new Error(`Method ${methodName} not found on ${serviceName}`);
    }

    // Mark stream types
    this.isRequestStream = !!this.serviceMethod.requestStream;
    this.isResponseStream = !!this.serviceMethod.responseStream;

    // Validate service method matches called function
    const expectedMethod =
      this.serviceMethod.requestStream && this.serviceMethod.responseStream
        ? RequestMethodType.BidiStreamRequest
        : this.serviceMethod.requestStream
        ? RequestMethodType.ClientStreamRequest
        : this.serviceMethod.responseStream
        ? RequestMethodType.ServerStreamRequest
        : RequestMethodType.UnaryRequest;

    // Only throw on expected method mismatch when defined
    if (requestMethodType) {
      this.requestMethodType = requestMethodType;
      if (expectedMethod !== requestMethodType) {
        throw new Error(
          `${requestMethodType} does not support method '${this.method}', use ${expectedMethod} instead`
        );
      }
    } else {
      this.requestMethodType = expectedMethod;
    }

    // Assign the request and response types
    this.requestType = this.client
      .getRoot()
      .lookupType(this.serviceMethod.requestType);
    this.responseType = this.client
      .getRoot()
      .lookupType(this.serviceMethod.responseType);

    // Use default request options
    if (!requestOptions) {
      this.abortController = new AbortController();
      this.metadata = new Metadata();
      this.callOptions = {};
      this.timeout = this.client.clientSettings.timeout || 0;
      this.retryOptions =
        normalizeRetryOptions(this.client.clientSettings.retryOptions) || {};
    }
    // Full options assignment
    else {
      this.abortController =
        requestOptions.abortController || new AbortController();
      this.callOptions = requestOptions.callOptions || {};
      this.timeout =
        requestOptions.timeout || this.client.clientSettings.timeout || 0;
      this.retryOptions =
        normalizeRetryOptions(requestOptions.retryOptions) ||
        normalizeRetryOptions(this.client.clientSettings.retryOptions) ||
        {};

      // Metadata instance
      if (
        requestOptions.metadata &&
        requestOptions.metadata instanceof Metadata
      ) {
        this.metadata = requestOptions.metadata;
      }
      // Object containing metadata values
      else if (requestOptions.metadata) {
        this.metadata = new Metadata();

        for (const key in requestOptions.metadata) {
          const value = requestOptions.metadata[key];

          if (Array.isArray(value)) {
            value.forEach((item) => this.metadata.add(key, item));
          } else {
            this.metadata.set(key, value);
          }
        }
      }
      // Metadata not passed in at all
      else {
        this.metadata = new Metadata();
      }
    }

    // For internal testing only, allow auto starting of the request
    if (blockAutoStart !== true) {
      this.start();
    }
  }

  /**
   * Indicates if the request is active (started, but not finished)
   * @type {boolean}
   * @readonly
   */
  public get isActive(): boolean {
    return this.isRequestActive;
  }

  /**
   * Indicates if data can still be sent to the write stream
   * @type {boolean}
   * @readonly
   */
  public get isWritable(): boolean {
    return !!this.writeStream?.writable;
  }

  /**
   * Indicates if the data is still coming from the read stream
   * @type {boolean}
   * @readonly
   */
  public get isReadable(): boolean {
    return !!this.readStream?.readable;
  }

  /**
   * Proxy to the trailing metadata returned at the end of the response
   * @type {Metadata | undefined}
   * @readonly
   */
  public get trailingMetadata(): Metadata | undefined {
    return this.responseStatus?.metadata;
  }

  /**
   * Safety wrapper for typing stream as writable
   * @type {ClientWritableStream | ClientDuplexStream | undefined}
   * @readonly
   * @private
   */
  private get writeStream():
    | ClientWritableStream<RequestType>
    | ClientDuplexStream<RequestType, ResponseType>
    | undefined {
    if (this.isRequestStream && this.stream) {
      return this.stream as
        | ClientWritableStream<RequestType>
        | ClientDuplexStream<RequestType, ResponseType>;
    }
  }

  /**
   * Safety wrapper for typing stream as readable
   * @type {ClientReadableStream | ClientDuplexStream | undefined}
   * @readonly
   * @private
   */
  private get readStream():
    | ClientReadableStream<ResponseType>
    | ClientDuplexStream<RequestType, ResponseType>
    | undefined {
    if (this.isResponseStream && this.stream) {
      return this.stream as
        | ClientReadableStream<ResponseType>
        | ClientDuplexStream<RequestType, ResponseType>;
    }
  }

  /**
   * Kicks off the request, adds abort listener and runs middleware
   * @private
   */
  private start() {
    // Listen for caller aborting of this request
    this.abortController.signal.addEventListener("abort", () => {
      if (this.stream) {
        this.stream.cancel();
        this.resolveRequest(
          ResolutionType.Abort,
          new RequestError(status.CANCELLED, this)
        );
      }
    });

    // Run middleware before entering request loop
    this.runMiddleware()
      .then(this.makeRequest.bind(this))
      .catch((e) => {
        let error: Error;

        if (e instanceof Error) {
          error = e;
        } else if (typeof e === "string") {
          error = new Error(e);
        } else {
          error = new Error(`Unknown Middleware Error`, { cause: e });
        }

        this.resolveRequest(ResolutionType.Default, error);
      });
  }

  /**
   * Runs any middleware attached to the client
   * @private
   */
  private async runMiddleware() {
    for (const middleware of this.client.middleware) {
      if (this.isActive) {
        await middleware(this, this.client);
      }
    }
  }

  /**
   * Retry-able requester starter method that sets up the
   * call stream with readers & writers
   * @private
   */
  private makeRequest(): void {
    this.stream = null;
    this.resolutionType = undefined;
    this.error = undefined;
    this.responseMetadata = undefined;
    this.responseStatus = undefined;

    // Apply timeout to the deadline (if not already set)
    const callOptions = Object.create(this.callOptions) as CallOptions;
    if (this.timeout && callOptions.deadline === undefined) {
      callOptions.deadline = Date.now() + this.timeout;
    }

    // Data sanitation
    if (!this.isRequestStream && this.requestData) {
      const validationError = this.requestType.verify(this.requestData);
      if (validationError) {
        return this.resolveRequest(
          ResolutionType.Default,
          new RequestError(status.INVALID_ARGUMENT, this, validationError)
        );
      }
    }

    // Unary Request
    if (this.requestMethodType === RequestMethodType.UnaryRequest) {
      this.stream = this.client
        .getClient(this)
        .makeUnaryRequest<RequestType, ResponseType>(
          this.requestPath,
          this.serializeRequest.bind(this),
          this.deserializeResponse.bind(this),
          (this.requestData || {}) as RequestType,
          this.metadata,
          callOptions,
          this.unaryCallback.bind(this, this.retries)
        );
    }
    // Client Stream Request
    else if (this.requestMethodType === RequestMethodType.ClientStreamRequest) {
      this.stream = this.client
        .getClient(this)
        .makeClientStreamRequest<RequestType, ResponseType>(
          this.requestPath,
          this.serializeRequest.bind(this),
          this.deserializeResponse.bind(this),
          this.metadata,
          callOptions,
          this.unaryCallback.bind(this, this.retries)
        );
    }
    // Server Stream Request
    else if (this.requestMethodType === RequestMethodType.ServerStreamRequest) {
      this.stream = this.client
        .getClient(this)
        .makeServerStreamRequest<RequestType, ResponseType>(
          this.requestPath,
          this.serializeRequest.bind(this),
          this.deserializeResponse.bind(this),
          (this.requestData || {}) as RequestType,
          this.metadata,
          callOptions
        );
    }
    // Bidirectional Stream Request
    else {
      this.stream = this.client
        .getClient(this)
        .makeBidiStreamRequest(
          this.requestPath,
          this.serializeRequest.bind(this),
          this.deserializeResponse.bind(this),
          this.metadata,
          callOptions
        );
    }

    // Bind response Metadata and Status to the request object
    const stream = this.stream;
    const onMetadata = (metadata: Metadata) =>
      (this.responseMetadata = metadata);
    const onStatus = (status: StatusObject) => {
      this.responseStatus = status;

      // Status event comes in after the end event, so need
      // to keep these here
      stream.off("metadata", onMetadata);
      stream.off("status", onStatus);
    };
    stream.once("metadata", onMetadata);
    stream.once("status", onStatus);

    // Setup read/write stream handling
    this.readFromServer();
    this.proxyPipeStreamToServer();
    this.writeToServer();
  }

  /**
   * Callback binded to unary response methods
   * @param attempt Retry attempt number callback is binded for, to prevent old attempts from running
   * @param error Server error, if any
   * @param value Response data
   * @private
   */
  private unaryCallback(
    attempt: number,
    error: ServiceError | null,
    value?: ResponseType
  ): void {
    if (!this.stream || attempt !== this.retries) {
      return;
    }

    this.result = value;
    this.emit("response", this);

    if (value) {
      this.emit("data", value, this);
    }

    this.resolveRequest(ResolutionType.Default, error || undefined);
  }

  /**
   * Listens for data on response streams
   * @private
   */
  private readFromServer(): void {
    const stream = this.readStream;
    if (!this.isResponseStream || !stream) {
      return;
    }

    // Local refs for read stream lifecycle management
    let counter = 0;
    let responseRowIndex = 0;
    let ended = false;

    /**
     * Proxy each chunk of data from the service to the streamReader
     *
     * Request is not resolved until all streamReader operations
     * have completed
     */
    const onData = (row: ResponseType) => {
      if (this.stream !== stream) {
        return removeListeners();
      }

      // Signal first response from the server
      if (responseRowIndex === 0) {
        this.emit("response", this);
      }

      // Pipe to act like a readable stream
      this.emit("data", row, this);

      // Stream reader is optional
      if (!this.streamReader) {
        return;
      }

      // Increment counters while processing
      counter++;
      this.streamReader(row, responseRowIndex++, this)
        .then(() => {
          if (--counter < 1 && ended && this.stream === stream) {
            this.resolveRequest(ResolutionType.Default);
          }
        })
        // Bubble any stream reader errors back to the caller
        .catch((e) => {
          if (this.stream === stream) {
            this.stream.cancel();
            this.resolveRequest(ResolutionType.Default, e);
          }
        });
    };

    // Any service error should kill the stream
    const onError = (e: Error) => {
      ended = true;
      removeListeners();

      if (this.stream === stream) {
        this.resolveRequest(ResolutionType.Default, e);
      }
    };

    // End event should trigger closure of request as long
    // as all stream reader operations are complete
    const onEnd = () => {
      ended = true;
      removeListeners();

      if (this.stream === stream && counter < 1) {
        this.resolveRequest(ResolutionType.Default);
      }
    };

    // Drop listeners once request completes
    const removeListeners = () => {
      stream.off("data", onData);
      stream.off("error", onError);
      stream.off("end", onEnd);
    };

    // Start listening
    stream.on("data", onData);
    stream.on("error", onError);
    stream.on("end", onEnd);
  }

  /**
   * Pipes a readable like stream to the request stream
   * @private
   */
  private proxyPipeStreamToServer(): void {
    const stream = this.writeStream;
    const pipeStream = this.pipeStream;
    if (!this.isRequestStream || !pipeStream || !stream) {
      return;
    }

    // Transfer incoming data to the request stream
    const onData = (row: RequestType) => {
      if (this.stream === stream) {
        stream.write(row);
      } else {
        removeListeners();
      }
    };

    // Cancel the request if there is an error in the pipe
    const onError = (e: unknown) => {
      removeListeners();
      if (this.stream === stream) {
        const error =
          e instanceof Error ? e : new Error("Pipe stream error", { cause: e });

        this.stream.cancel();
        this.resolveRequest(ResolutionType.Default, error);
      }
    };

    // End the write stream when the pipe completes
    const onEnd = () => {
      removeListeners();
      if (this.stream === stream) {
        stream.end();
      }
    };

    const removeListeners = () => {
      pipeStream.off("data", onData);
      pipeStream.off("error", onError);
      pipeStream.off("end", onEnd);
      pipeStream.off("close", onEnd);
    };

    pipeStream.on("data", onData);
    pipeStream.on("error", onError);
    pipeStream.on("end", onEnd);
    pipeStream.on("close", onEnd);
  }

  /**
   * Opens the writer sandbox if it exists for request streams
   * @private
   */
  private writeToServer(): void {
    const stream = this.writeStream;
    if (!this.isRequestStream || !stream || this.pipeStream) {
      return;
    } else if (!this.writerSandbox) {
      stream.end();
      return;
    }

    // Let the caller start safely writing to the stream
    this.writerSandbox(async (data: RequestType, encoding?: string) => {
      if (stream !== this.stream || !this.isWritable) {
        throw new Error(
          `The write stream has already closed for ${this.method}`
        );
      }

      // Validate the message
      const validationError = this.requestType.verify(data as VerifyArgs[0]);
      if (validationError) {
        throw new RequestError(status.INVALID_ARGUMENT, this, validationError);
      }

      // Write message to the stream, waiting for the callback
      // to return before resolving write
      await promisify(stream.write.bind(stream, data, encoding))();
    }, this)
      .then(() => {
        if (stream === this.stream) {
          stream.end();
        }
      })
      .catch((e) => {
        if (stream === this.stream) {
          this.stream.cancel();
          this.resolveRequest(ResolutionType.Default, e);
        }
      });
  }

  /**
   * Marks stream as complete, resolving any queued promises
   * @param error Any error that occurred during the request
   * @param resolutionType Indicator for special error handling (like abort & timeout)
   * @private
   */
  private resolveRequest(resolutionType: ResolutionType, error?: Error): void {
    if (!this.isRequestActive) {
      return;
    }

    this.stream = null;
    this.resolutionType = resolutionType;

    if (error) {
      this.responseErrors.push(error);

      // Allow for retries
      if (this.canRetry((error as ServiceError).code, resolutionType)) {
        this.retries++;
        this.emit("retry", this);
        return this.makeRequest();
      }
      // End request with an error
      else {
        this.isRequestActive = false;
        this.error = error;

        // Never reject if rejectOnError is disabled
        if (this.client.clientSettings.rejectOnError === false) {
          this.endPromiseQueue.forEach(({ resolve }) => resolve(this));
        }
        // Always reject when rejectOnError is enabled
        else if (this.client.clientSettings.rejectOnError === true) {
          this.endPromiseQueue.forEach(({ reject }) => reject(error));
        }
        // Abort handling
        else if (resolutionType === ResolutionType.Abort) {
          // Only reject if rejectOnAbort is enabled
          if (this.client.clientSettings.rejectOnAbort === true) {
            this.endPromiseQueue.forEach(({ reject }) => reject(error));
          }

          this.emit("aborted", this);
        }
        // Resolve everything else
        else {
          this.endPromiseQueue.forEach(({ resolve }) => resolve(this));
        }

        this.endPromiseQueue = [];
        this.emit("error", error, this);
      }
    }
    // Successful response
    else {
      this.isRequestActive = false;
      this.endPromiseQueue.forEach(({ resolve }) => resolve(this));
      this.endPromiseQueue = [];
      this.emit("end", this);
    }

    // Request fully resolved
    this.emit("close", this);
  }

  /**
   * Serializing method for outgoing messages
   * @param object Request object passed from the caller
   * @private
   */
  private serializeRequest(object: RequestType): Buffer {
    return this.requestType
      .encode(this.requestType.create(object as CreateArgs[0]))
      .finish() as Buffer;
  }

  /**
   * Deserializing method for incoming messages
   * @param buffer Buffer object response from the connection
   * @private
   */
  private deserializeResponse(buffer: Buffer): ResponseType {
    return this.responseType.toObject(
      this.responseType.decode(buffer),
      this.client.protoConversionOptions
    ) as ResponseType;
  }

  /**
   * Determines if this request can be retried on error
   * @param code Status code of the current error
   * @param resolutionType How the request resolved
   * @private
   */
  private canRetry(
    code: status | undefined,
    resolutionType: ResolutionType
  ): boolean {
    // Request aborts can't be retried
    if (resolutionType === ResolutionType.Abort) {
      return false;
    }

    // Check for custom retry codes, otherwise fallback to default codes
    let approvedCodes: status[] = [];
    if (this.retryOptions.status) {
      approvedCodes = Array.isArray(this.retryOptions.status)
        ? this.retryOptions.status
        : [this.retryOptions.status];
    } else {
      approvedCodes = DEFAULT_RETRY_STATUS_CODES;
    }

    // Check all parameters to see if request can be retried
    return !!(
      !this.abortController.signal.aborted &&
      this.retryOptions.retryCount &&
      this.retries < this.retryOptions.retryCount &&
      code !== undefined &&
      approvedCodes.includes(code) &&
      // Piped streams can not be retried
      !this.pipeStream
    );
  }

  /**
   * Aborts the request if it is still active
   */
  public abort(): void {
    if (!this.abortController.signal.aborted) {
      this.abortController.abort();
    }
  }

  /**
   * Enhanced "end" event listener. Adds promise to a queue, waiting for the request
   * to complete, rejecting on failures only if configured to. If the request is already
   * complete, the result is returned (or exception raised)
   * @returns {ProtoRequest} This ProtoRequest instance
   */
  public async waitForEnd(): Promise<ProtoRequest<RequestType, ResponseType>> {
    return new Promise<ProtoRequest<RequestType, ResponseType>>(
      (resolve, reject) => {
        // Request is still active, wait for it to complete
        if (this.isActive) {
          this.endPromiseQueue.push({ resolve, reject });
        }
        // Error handling
        else if (this.error) {
          // Never reject if rejectOnError is disabled
          if (this.client.clientSettings.rejectOnError === false) {
            resolve(this);
          }
          // Always reject when rejectOnError is enabled
          else if (this.client.clientSettings.rejectOnError === true) {
            reject(this.error);
          }
          // Abort handling
          else if (this.resolutionType === ResolutionType.Abort) {
            // Only reject if rejectOnAbort is enabled
            if (this.client.clientSettings.rejectOnAbort === true) {
              reject(this.error);
            }
          }
          // Nothing configured, default resolve
          else {
            resolve(this);
          }
        }
        // Request already completed successfully
        else {
          resolve(this);
        }
      }
    );
  }
}
