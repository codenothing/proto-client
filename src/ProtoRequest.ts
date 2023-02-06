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
  RequestOptions,
  RequestRetryOptions,
  StreamReader,
  StreamWriterSandbox,
} from "./interfaces";
import { normalizeRetryOptions } from "./util";

// Shortcut types to proto functional parameters
type VerifyArgs = Parameters<typeof Protobuf.Message.verify>;
type CreateArgs = Parameters<typeof Protobuf.Message.create>;

/**
 * Custom event typings
 */
export interface ProtoRequest<RequestType, ResponseType> {
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
    event: "end",
    listener: (request: ProtoRequest<RequestType, ResponseType>) => void
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
    event: "end",
    listener: (request: ProtoRequest<RequestType, ResponseType>) => void
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
    eventName: "end",
    request: ProtoRequest<RequestType, ResponseType>
  ): boolean;
}

/**
 * Individual gRPC request
 */
export class ProtoRequest<RequestType, ResponseType> extends EventEmitter {
  /**
   * Fully qualified path of the method for the request that can be used by protobufjs.lookup
   */
  public readonly method: string;

  /**
   * Generated request path
   */
  public readonly requestPath: string;

  /**
   * Request proto message type
   */
  public readonly requestType: Protobuf.Type;

  /**
   * Response proto message type
   */
  public readonly responseType: Protobuf.Type;

  /**
   * Request method type
   */
  public readonly requestMethodType: RequestMethodType;

  /**
   * Time in milliseconds before cancelling the request
   */
  public timeout: number;

  /**
   * Configured retry options for this request
   */
  public retryOptions: RequestRetryOptions;

  /**
   * AbortController tied to the request
   */
  public abortController: AbortController;

  /**
   * Metadata instance for the request
   */
  public metadata: Metadata;

  /**
   * Request specific options
   */
  public callOptions: CallOptions;

  /**
   * Data response from the service, only valid for unary and client stream requests
   */
  public result?: ResponseType;

  /**
   * Metadata returned from the service
   */
  public responseMetadata?: Metadata;

  /**
   * Metadata returned from the service
   */
  public responseStatus?: StatusObject;

  /**
   * Number of retries made for this request
   */
  public retries = 0;

  /**
   * References any error that may have occured during the request
   */
  public error?: Error;

  /**
   * When retries are enabled, all errors will be stored here
   */
  public readonly responseErrors: Error[] = [];

  /**
   * Internal reference to the parent client instance
   */
  private readonly client: ProtoClient;

  /**
   * Internal reference to determine if request has start yet or not
   */
  private hasRequestBegun = false;

  /**
   * Internal class for managing individual requests
   */
  constructor(
    client: ProtoClient,
    method: string,
    requestMethodType: RequestMethodType,
    requestOptions: AbortController | RequestOptions | undefined
  ) {
    super();

    this.method = method;
    this.client = client;
    this.requestMethodType = requestMethodType;

    // Validate service method exists
    const serviceMethod = this.client
      .getRoot()
      .lookup(this.method) as Protobuf.Method | null;
    if (!serviceMethod) {
      throw new Error(`Method ${this.method} not found`);
    }

    // Validate service method matches called function
    const expectedMethod =
      serviceMethod.requestStream && serviceMethod.responseStream
        ? RequestMethodType.BidiStreamRequest
        : serviceMethod.requestStream
        ? RequestMethodType.ClientStreamRequest
        : serviceMethod.responseStream
        ? RequestMethodType.ServerStreamRequest
        : RequestMethodType.UnaryRequest;
    if (expectedMethod !== requestMethodType) {
      throw new Error(
        `${requestMethodType} does not support method '${this.method}', use ${expectedMethod} instead`
      );
    }

    // Break down the method to configure the path
    const methodParts = this.method.split(/\./g);
    const methodName = methodParts.pop();
    const serviceName = methodParts.join(".");
    this.requestPath = `/${serviceName}/${methodName}`;

    // Assign the request and response types
    this.requestType = this.client
      .getRoot()
      .lookupType(serviceMethod.requestType);
    this.responseType = this.client
      .getRoot()
      .lookupType(serviceMethod.responseType);

    // Use default request options
    if (!requestOptions) {
      this.abortController = new AbortController();
      this.metadata = new Metadata();
      this.callOptions = {};
      this.timeout = this.client.clientSettings.timeout || 0;
      this.retryOptions =
        normalizeRetryOptions(this.client.clientSettings.retryOptions) || {};
    }
    // Only abort controller
    else if (requestOptions instanceof AbortController) {
      this.abortController = requestOptions;
      this.metadata = new Metadata();
      this.callOptions = {};
      this.timeout = this.client.clientSettings.timeout || 0;
      this.retryOptions =
        normalizeRetryOptions(this.client.clientSettings.retryOptions) || {};
    }
    // Full options assignemnt
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
  }

  /**
   * Sends unary (request/response) request to the service endpoint
   * @param data Data to be sent as part of the request. Defaults to empty object
   */
  public async makeUnaryRequest(data?: RequestType | null): Promise<this> {
    return this.retryWrapper((timeout, completed) => {
      // Data sanitation
      const validationError = this.requestType.verify(data || {});
      if (validationError) {
        this.error = new RequestError(
          status.INVALID_ARGUMENT,
          this,
          validationError
        );
        completed(this.error);
        return;
      }

      // Local references for this cycle
      let call: ClientUnaryCall | null = null;
      let finished = false;

      // Make the actual requests
      call = this.client
        .getClient(this)
        .makeUnaryRequest<RequestType, ResponseType>(
          this.requestPath,
          this.serializeRequest.bind(this),
          this.deserializeResponse.bind(this),
          (data || {}) as RequestType,
          this.metadata,
          this.callOptions,
          (e, result) => {
            if (finished) {
              return;
            }

            // Assign results and signal out the response
            this.error = e || undefined;
            this.result = result;
            this.emit("response", this);

            // Mark request as completed
            finished = true;
            call = null;
            completed(e);
          }
        );

      // Bind response Metadata and Status to the request object
      call.on("metadata", (metadata) => (this.responseMetadata = metadata));
      call.on("status", (status) => (this.responseStatus = status));

      // Cancel the open request when timeout threashold is reached
      timeout(() => {
        call?.cancel();
        call = null;
        finished = true;
      });

      // Listen for caller aborting of this request
      this.abortController.signal.addEventListener("abort", () => {
        if (call) {
          call.cancel();
          call = null;
          finished = true;
          this.error = new RequestError(status.CANCELLED, this);

          if (this.client.clientSettings.rejectOnAbort) {
            completed(this.error);
          }

          this.emit("aborted", this);
        }
      });

      this.client.emit("request", this);
    });
  }

  /**
   * Sends client stream (request stream, single response) request to the service endpoint
   * @param writerSandbox Async supported callback for writing data to the open stream
   */
  public async makeClientStreamRequest(
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>
  ): Promise<this> {
    return this.retryWrapper((timeout, completed) => {
      let stream: ClientWritableStream<RequestType> | null = null;
      let finished = false;

      stream = this.client
        .getClient(this)
        .makeClientStreamRequest<RequestType, ResponseType>(
          this.requestPath,
          this.serializeRequest.bind(this),
          this.deserializeResponse.bind(this),
          this.metadata,
          this.callOptions,
          (e, result) => {
            if (finished) {
              return;
            }

            // Assign the results and signal response received
            this.error = e || undefined;
            this.result = result;
            this.emit("response", this);

            // Mark request as completed
            finished = true;
            stream = null;
            completed(e);
          }
        );

      // Bind response Metadata and Status to the request object
      stream.on("metadata", (metadata) => (this.responseMetadata = metadata));
      stream.on("status", (status) => (this.responseStatus = status));

      // Cancel the open request when timeout threashold is reached
      timeout(() => {
        stream?.cancel();
        stream = null;
        finished = true;
      });

      // Listen for caller aborting of this request
      this.abortController.signal.addEventListener("abort", () => {
        stream?.cancel();
        stream = null;
        finished = true;
        this.error = new RequestError(status.CANCELLED, this);

        if (this.client.clientSettings.rejectOnAbort) {
          completed(this.error);
        }

        this.emit("aborted", this);
      });

      // Let the caller start safely writing to the stream
      writerSandbox(async (data: RequestType, encoding?: string) => {
        if (!stream) {
          throw new Error(
            `The write stream has already closed for ${this.method}`
          );
        }

        // Validate the message
        const validationError = this.requestType.verify(data as VerifyArgs[0]);
        if (validationError) {
          throw new RequestError(
            status.INVALID_ARGUMENT,
            this,
            validationError
          );
        }

        // Write message to the stream, waiting for the callback to return
        return await new Promise<void>((writeResolve, writeReject) => {
          if (stream) {
            stream.write(data, encoding, () => writeResolve());
          } else {
            writeReject(
              new Error(
                `The write stream has already closed for ${this.method}`
              )
            );
          }
        });
      }, this)
        .then(() => stream?.end())
        .catch((e) => {
          if (stream) {
            stream?.cancel();
            stream = null;
            finished = true;
            this.error = e;
            completed(e);
          }
        });

      this.client.emit("request", this);
    });
  }

  /**
   * Sends a server stream (single request, streamed response) request to the service endpoint
   * @param data Data to be sent as part of the request
   * @param streamReader Iteration function that will get called on every response chunk
   */
  public async makeServerStreamRequest(
    data: RequestType | StreamReader<RequestType, ResponseType>,
    streamReader?: StreamReader<RequestType, ResponseType>
  ): Promise<this> {
    return this.retryWrapper((timeout, completed) => {
      if (typeof data === "function") {
        streamReader = data as StreamReader<RequestType, ResponseType>;
        data = {} as RequestType;
      }

      if (!streamReader) {
        this.error = new RequestError(
          status.INVALID_ARGUMENT,
          this,
          `streamReader not found`
        );
        return completed(this.error);
      }

      // Data sanitation
      const validationError = this.requestType.verify(data || {});
      if (validationError) {
        this.error = new RequestError(
          status.INVALID_ARGUMENT,
          this,
          validationError
        );
        return completed(this.error);
      }

      let counter = 0;
      let responseRowIndex = 0;
      let finished = false;

      let stream: ClientReadableStream<ResponseType> | null = this.client
        .getClient(this)
        .makeServerStreamRequest<RequestType, ResponseType>(
          this.requestPath,
          this.serializeRequest.bind(this),
          this.deserializeResponse.bind(this),
          (data || {}) as RequestType,
          this.metadata,
          this.callOptions
        );

      // Cancel the open request when timeout threashold is reached
      timeout(() => {
        stream?.cancel();
        stream = null;
      });

      // Let the caller start safely writing to the stream
      this.abortController.signal.addEventListener("abort", () => {
        if (stream) {
          stream.cancel();
          stream = null;
          this.error = new RequestError(status.CANCELLED, this);

          if (this.client.clientSettings.rejectOnAbort) {
            completed(this.error);
          }

          this.emit("aborted", this);
        }
      });

      // Bind response Metadata and Status to the request object
      stream.on("metadata", (metadata) => (this.responseMetadata = metadata));
      stream.on("status", (status) => (this.responseStatus = status));

      /**
       * Proxy each chunk of data from the service to the streamReader
       *
       * Request is not resolved until all streamReader operations
       * have completed
       */
      stream.on("data", (row: ResponseType) => {
        if (stream) {
          if (responseRowIndex === 0) {
            this.emit("response", this);
          }

          counter++;
          (streamReader as StreamReader<RequestType, ResponseType>)(
            row,
            responseRowIndex++,
            this
          )
            .then(() => {
              if (--counter < 1 && stream && finished) {
                stream = null;
                completed();
              }
            })
            // Bubble any stream reader errors back to the caller
            .catch((e) => {
              if (stream) {
                stream.cancel();
                stream = null;

                this.error = e;
                completed(e);
              }
            });
        }
      });

      // End event should trigger closure of request as long
      // as all stream reader operations are complete
      stream.on("end", () => {
        finished = true;

        if (stream && counter < 1) {
          completed();
        }
      });

      // Any service error should kill the stream
      stream.on("error", (e) => {
        if (stream) {
          stream = null;
          this.error = e;
          completed(e);
        }
      });

      this.client.emit("request", this);
    });
  }

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param writerSandbox Async supported callback for writing data to the open stream
   * @param streamReader Iteration function that will get called on every response chunk
   */
  public async makeBidiStreamRequest(
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>,
    streamReader: StreamReader<RequestType, ResponseType>
  ): Promise<this> {
    return this.retryWrapper((timeout, completed) => {
      let counter = 0;
      let responseRowIndex = 0;
      let finished = false;

      let stream: ClientDuplexStream<RequestType, ResponseType> | null =
        this.client
          .getClient(this)
          .makeBidiStreamRequest(
            this.requestPath,
            this.serializeRequest.bind(this),
            this.deserializeResponse.bind(this),
            this.metadata,
            this.callOptions
          );

      // Cancel the open request when timeout threashold is reached
      timeout(() => {
        stream?.cancel();
        stream = null;
      });

      // Let the caller start safely writing to the stream
      this.abortController.signal.addEventListener("abort", () => {
        if (stream) {
          stream.cancel();
          stream = null;
          this.error = new RequestError(status.CANCELLED, this);

          if (this.client.clientSettings.rejectOnAbort) {
            completed(this.error);
          }

          this.emit("aborted", this);
        }
      });

      // Bind response Metadata and Status to the request object
      stream.on("metadata", (metadata) => (this.responseMetadata = metadata));
      stream.on("status", (status) => (this.responseStatus = status));

      /**
       * Proxy each chunk of data from the service to the streamReader
       *
       * Request is not resolved until all streamReader operations
       * have completed
       */
      stream.on("data", (row: ResponseType) => {
        if (!stream) {
          return;
        }

        if (responseRowIndex === 0) {
          this.emit("response", this);
        }

        counter++;
        streamReader(row, responseRowIndex++, this)
          .then(() => {
            if (--counter < 1 && stream && finished) {
              stream = null;
              completed();
            }
          })
          // Bubble any stream reader errors back to the caller
          .catch((e) => {
            if (stream) {
              stream.cancel();
              stream = null;
              this.error = e;
              completed(e);
            }
          });
      });

      // End event should trigger closure of request as long
      // as all stream reader operations are complete
      stream.on("end", () => {
        finished = true;

        if (stream && counter < 1) {
          stream = null;
          completed();
        }
      });

      // Any service error should kill the stream
      stream.on("error", (e) => {
        if (stream) {
          stream.cancel();
          stream = null;
          this.error = e;
          completed(e);
        }
      });

      // Let the caller start safely writing to the stream
      writerSandbox(async (data: RequestType, encoding?: string) => {
        if (!stream) {
          throw new Error(
            `The write stream has already closed for ${this.method}`
          );
        }

        // Validate the message
        const validationError = this.requestType.verify(data as VerifyArgs[0]);
        if (validationError) {
          throw new RequestError(
            status.INVALID_ARGUMENT,
            this,
            validationError
          );
        }

        // Write message to the stream, waiting for the callback to return
        await new Promise<void>((writeResolve, writeReject) => {
          if (stream) {
            stream.write(data, encoding, () => writeResolve());
          } else {
            writeReject(
              new Error(
                `The write stream has already closed for ${this.method}`
              )
            );
          }
        });
      }, this)
        .then(() => stream?.end())
        .catch((e) => {
          if (stream) {
            stream.cancel();
            stream = null;
            this.error = e;
            completed(e);
          }
        });

      this.client.emit("request", this);
    });
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
   * Serializing method for outgoing messages
   * @param object Request object passed from the caller
   */
  private serializeRequest(object: RequestType): Buffer {
    return this.requestType
      .encode(this.requestType.create(object as CreateArgs[0]))
      .finish() as Buffer;
  }

  /**
   * Deserializing method for incoming messages
   * @param buffer Buffer object repsonse from the connection
   */
  private deserializeResponse(buffer: Buffer): ResponseType {
    return this.responseType.toObject(
      this.responseType.decode(buffer),
      this.client.protoConversionOptions
    ) as ResponseType;
  }

  /**
   * Determins if this request can be retried on error
   * @param code Status code of the current error
   */
  private canRetry(code?: status) {
    let approvedCodes: status[] = [];

    if (this.retryOptions.status) {
      approvedCodes = Array.isArray(this.retryOptions.status)
        ? this.retryOptions.status
        : [this.retryOptions.status];
    } else {
      approvedCodes = DEFAULT_RETRY_STATUS_CODES;
    }

    return (
      !this.abortController.signal.aborted &&
      this.retryOptions.retryCount &&
      this.retries < this.retryOptions.retryCount &&
      code !== undefined &&
      approvedCodes.includes(code)
    );
  }

  /**
   * Wraps active request calls with retry and timeout handlers
   * @param requestRunner Request wrapper for running through retries
   */
  public async retryWrapper(
    requestRunner: (
      /**
       * Starts the timer for timeouts, and triggers the reached callback
       * once timer threshold has been met
       */
      timeout: (timeoutReached: () => void) => void,

      /**
       * Callback for when the service response has completed
       */
      completed: (error?: Error | ServiceError | null) => void
    ) => void
  ): Promise<this> {
    if (this.hasRequestBegun) {
      throw new Error(
        `${this.requestMethodType} for '${this.method}' has already begun. Only make requests from the client, not the request instance`
      );
    }
    this.hasRequestBegun = true;

    return new Promise<this>((resolve, reject) => {
      const makeRequest = () => {
        let timerid: NodeJS.Timeout | null = null;

        // Send off the gRPC request logic
        requestRunner(
          // Timeout handler
          (timeoutReached) => {
            if (!this.timeout) {
              return;
            }

            timerid = setTimeout(() => {
              timerid = null;
              timeoutReached();

              const error = new RequestError(status.DEADLINE_EXCEEDED, this);
              this.responseErrors.push(error);

              if (
                this.canRetry(status.DEADLINE_EXCEEDED) &&
                this.retryOptions.retryOnClientTimeout !== false
              ) {
                this.retries++;
                this.emit("retry", this);
                makeRequest();
              } else {
                this.error = error;
                reject(this.error);
                this.emit("end", this);
              }
            }, this.timeout);
          },

          // Result handler
          (e) => {
            if (timerid) {
              clearTimeout(timerid);
            }

            if (e) {
              this.responseErrors.push(e);

              if (this.canRetry((e as ServiceError).code)) {
                this.retries++;
                this.error = undefined;
                this.emit("retry", this);
                makeRequest();
              } else {
                reject(e);

                // Only signal request end when it was not aborted
                if (
                  !(e instanceof RequestError) ||
                  e.code !== status.CANCELLED
                ) {
                  this.emit("end", this);
                }
              }
            } else {
              resolve(this);
              this.emit("end", this);
            }
          }
        );
      };

      // Kick off the first request
      makeRequest();
    });
  }
}
