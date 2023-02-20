import { EventEmitter } from "events";
import * as Protobuf from "protobufjs";
import { ChannelCredentials, Client, credentials } from "@grpc/grpc-js";
import { ProtoRequest } from "./ProtoRequest";
import { RequestMethodType } from "./constants";
import type { UntypedProtoRequest } from "./untyped";
import type {
  ClientEndpoint,
  ClientSettings,
  EndpointMatcher,
  GenericRequestParams,
  ProtoSettings,
  RequestMiddleware,
  RequestOptions,
  StreamReader,
  StreamWriterSandbox,
} from "./interfaces";
import { generateEndpointMatcher } from "./util";
import type { Readable } from "stream";

export interface ProtoClient {
  on(event: "request", listener: (request: UntypedProtoRequest) => void): this;

  off(event: "request", listener: (request: UntypedProtoRequest) => void): this;

  emit(eventName: "request", request: UntypedProtoRequest): boolean;
}

/**
 * Shorthand wrapper utilities for gRPC client calls
 */
export class ProtoClient extends EventEmitter {
  /**
   * Client settings
   * @type {ClientSettings}
   */
  public clientSettings: ClientSettings = {
    endpoint: `0.0.0.0:8080`,
  };

  /**
   * Protobuf parsing settings
   * @type {ProtoSettings}
   */
  public protoSettings: ProtoSettings = {};

  /**
   * Internal proto conversion options, for referencing
   * @type {Protobuf.IConversionOptions}
   */
  public protoConversionOptions: Protobuf.IConversionOptions = {
    longs: Number,
    enums: String,
    defaults: false,
    oneofs: true,
  };

  /**
   * List of currently active requests
   * @type {ProtoRequest[]}
   */
  public activeRequests: UntypedProtoRequest[] = [];

  /**
   * Internal reference to middleware list that will run before each request
   * @type {RequestMiddleware[]}
   * @readonly
   * @package
   */
  public readonly middleware: RequestMiddleware[] = [];

  /**
   * Root protobuf object for referencing
   * @type {Protobuf.Root | undefined}
   * @private
   */
  private root?: Protobuf.Root;

  /**
   * Client endpoints list
   * @type {Array<{endpoint: ClientEndpoint, match: EndpointMatcher, client: Client}>}
   * @private
   */
  private clients: Array<{
    endpoint: ClientEndpoint;
    match: EndpointMatcher;
    client: Client;
  }> = [];

  /**
   * Shorthand wrapper utilities for gRPC client calls
   * @param {{clientSettings: ClientSettings, protoSettings: ProtoSettings, conversionOptions: Protobuf.IConversionOptions}} [options] Configuration options for the client
   */
  constructor(options?: {
    clientSettings?: ClientSettings;
    protoSettings?: ProtoSettings;
    conversionOptions?: Protobuf.IConversionOptions;
  }) {
    super();

    if (options?.clientSettings) {
      this.configureClient(options.clientSettings);
    }

    if (options?.protoSettings) {
      this.configureProtos(options.protoSettings);
    }

    if (options?.conversionOptions) {
      this.configureConversionOptions(options.conversionOptions);
    }
  }

  /**
   * Configures settings for client connection
   * @param {ClientSettings} clientSettings Settings for client connection
   */
  public configureClient(clientSettings: ClientSettings): void {
    this.clientSettings = clientSettings;

    this.close();

    const endpoints: Array<string | ClientEndpoint> = Array.isArray(
      clientSettings.endpoint
    )
      ? clientSettings.endpoint
      : [clientSettings.endpoint];

    this.clients = endpoints.map((endpoint) => {
      if (typeof endpoint === "string") {
        return {
          match: generateEndpointMatcher(),
          endpoint: { address: endpoint },
          client: new Client(endpoint, credentials.createInsecure()),
        };
      }

      // Build out credentials (secure/insecure) for this endpoint
      let creds: ChannelCredentials;
      if (
        endpoint.credentials &&
        endpoint.credentials instanceof ChannelCredentials
      ) {
        creds = endpoint.credentials;
      } else if (endpoint.credentials) {
        creds = credentials.createSsl(
          endpoint.credentials.rootCerts,
          endpoint.credentials.privateKey,
          endpoint.credentials.certChain,
          endpoint.credentials.verifyOptions
        );
      } else {
        creds = credentials.createInsecure();
      }

      // Combined matcher with gRPC client connection
      return {
        endpoint,
        match: generateEndpointMatcher(endpoint.match),
        client: new Client(endpoint.address, creds, endpoint.clientOptions),
      };
    });
  }

  /**
   * Configures options for reading/writing proto definitions
   * @param {ProtoSettings} protoSettings Proto reading/writing settings
   * @throws Exception if no root can be configured from the settings
   */
  public configureProtos(protoSettings: ProtoSettings): void {
    this.protoSettings = protoSettings;

    if (this.protoSettings.files) {
      this.root = new Protobuf.Root();
      this.root
        .loadSync(this.protoSettings.files, this.protoSettings.parseOptions)
        .resolveAll();
    } else if (this.protoSettings.root) {
      this.root = this.protoSettings.root;
    } else {
      throw new Error(
        `Must define either a root protobuf object, or path to proto files`
      );
    }
  }

  /**
   * Configures conversion options when decoding proto responses
   * @param {Protobuf.IConversionOptions} options Conversion options
   */
  public configureConversionOptions(
    options: Protobuf.IConversionOptions
  ): void {
    this.protoConversionOptions = options;
  }

  /**
   * Fetches the endpoint matching client instance
   * @param {ProtoRequest} request Active request looking for it's client endpoint
   * @returns {Client} gRPC client interface
   * @throws Exception if client is not yet configured, or no methods match the client
   */
  public getClient(request: UntypedProtoRequest): Client {
    if (!this.clients.length) {
      throw new Error(`ProtoClient is not yet configured`);
    }

    // Find the client which matches the request
    for (const client of this.clients) {
      if (client.match(request.method, request)) {
        return client.client;
      }
    }

    // Raise exception when there is no matching client
    throw new Error(
      `Service method '${request.method}' has no configured endpoint`
    );
  }

  /**
   * Fetches the current proto root object
   * @returns {Protobuf.Root} Root protobuf instance
   * @throws Exception if root is not configured yet
   */
  public getRoot(): Protobuf.Root {
    if (!this.root) {
      throw new Error(`ProtoClient protos are not yet configured`);
    }

    return this.root;
  }

  /**
   * Adds function to the middleware stack
   * @param {RequestMiddleware} middleware Middleware to run before each request
   */
  public useMiddleware(middleware: RequestMiddleware): void {
    this.middleware.push(middleware);
  }

  /**
   * Sends unary (request/response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @returns {ProtoRequest} Request instance
   */
  public async makeUnaryRequest<ResponseType>(
    method: string
  ): Promise<ProtoRequest<unknown, ResponseType>>;

  /**
   * Sends unary (request/response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {RequestType} data Data to be sent as part of the request
   * @returns {ProtoRequest} Request instance
   */
  public async makeUnaryRequest<RequestType, ResponseType>(
    method: string,
    data: RequestType
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends unary (request/response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {RequestType | null} data Data to be sent as part of the request
   * @param {AbortController} abortController Abort controller for canceling the active request
   * @returns {ProtoRequest} Request instance
   */
  public async makeUnaryRequest<RequestType, ResponseType>(
    method: string,
    data: RequestType | null,
    abortController: AbortController
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends unary (request/response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {RequestType | null} data Data to be sent as part of the request
   * @param {RequestOptions} requestOptions Options for this specific request
   * @returns {ProtoRequest} Request instance
   */
  public async makeUnaryRequest<RequestType, ResponseType>(
    method: string,
    data: RequestType | null,
    requestOptions: RequestOptions
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends unary (request/response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {RequestType | null} [data] Optional Data to be sent as part of the request. Defaults to empty object
   * @param {AbortController | RequestOptions} [requestOptions] Optional request options for this specific request
   * @returns {ProtoRequest} Request instance
   */
  public async makeUnaryRequest<RequestType, ResponseType>(
    method: string,
    data?: RequestType | null,
    requestOptions?: AbortController | RequestOptions
  ): Promise<ProtoRequest<RequestType, ResponseType>> {
    return await this.getUnaryRequest<RequestType, ResponseType>(
      method,
      data as RequestType,
      requestOptions as RequestOptions
    ).waitForEnd();
  }

  /**
   * Triggers unary (request/response) request to the service endpoint, returning the ProtoRequest instance
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @returns {ProtoRequest} Request instance
   */
  public getUnaryRequest<ResponseType>(
    method: string
  ): ProtoRequest<unknown, ResponseType>;

  /**
   * Triggers unary (request/response) request to the service endpoint, returning the ProtoRequest instance
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {RequestType} data Data to be sent as part of the request
   * @returns {ProtoRequest} Request instance
   */
  public getUnaryRequest<RequestType, ResponseType>(
    method: string,
    data: RequestType
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Triggers unary (request/response) request to the service endpoint, returning the ProtoRequest instance
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {RequestType | null} data Data to be sent as part of the request
   * @param {AbortController} abortController Abort controller for canceling the active request
   * @returns {ProtoRequest} Request instance
   */
  public getUnaryRequest<RequestType, ResponseType>(
    method: string,
    data: RequestType | null,
    abortController: AbortController
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Triggers unary (request/response) request to the service endpoint, returning the ProtoRequest instance
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {RequestType | null} data Data to be sent as part of the request
   * @param {RequestOptions} requestOptions Options for this specific request
   * @returns {ProtoRequest} Request instance
   */
  public getUnaryRequest<RequestType, ResponseType>(
    method: string,
    data: RequestType | null,
    requestOptions: RequestOptions
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Triggers unary (request/response) request to the service endpoint, returning the ProtoRequest instance
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {RequestType | null} [data] Optional Data to be sent as part of the request. Defaults to empty object
   * @param {AbortController | RequestOptions} [requestOptions] Optional request options for this specific request
   * @returns {ProtoRequest} Request instance
   */
  public getUnaryRequest<RequestType, ResponseType>(
    method: string,
    data?: RequestType | null,
    requestOptions?: AbortController | RequestOptions
  ): ProtoRequest<RequestType, ResponseType> {
    return this.getRequest<RequestType, ResponseType>({
      method,
      requestMethodType: RequestMethodType.UnaryRequest,
      data: data === null ? undefined : data,
      requestOptions:
        requestOptions instanceof AbortController
          ? { abortController: requestOptions }
          : requestOptions,
    });
  }

  /**
   * Sends client stream (request stream, single response) request to the service endpoint.
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @returns {ProtoRequest} Request instance
   */
  public async makeClientStreamRequest<RequestType, ResponseType>(
    method: string
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends client stream (request stream, single response) request to the service endpoint.
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {StreamWriterSandbox} writerSandbox Async supported callback for writing data to the open stream
   * @returns {ProtoRequest} Request instance
   */
  public async makeClientStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends client stream (request stream, single response) request to the service endpoint.
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {StreamWriterSandbox} writerSandbox Async supported callback for writing data to the open stream
   * @param {AbortController} abortController Abort controller for canceling the active request
   * @returns {ProtoRequest} Request instance
   */
  public async makeClientStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>,
    abortController: AbortController
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends client stream (request stream, single response) request to the service endpoint.
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {StreamWriterSandbox} writerSandbox Async supported callback for writing data to the open stream
   * @param {RequestOptions} requestOptions Options for this specific request
   * @returns {ProtoRequest} Request instance
   */
  public async makeClientStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>,
    requestOptions: RequestOptions
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends client stream (request stream, single response) request to the service endpoint.
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {Readable | EventEmitter} stream Readable like stream for piping into the request stream
   * @returns {ProtoRequest} Request instance
   */
  public async makeClientStreamRequest<RequestType, ResponseType>(
    method: string,
    stream: Readable | EventEmitter
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends client stream (request stream, single response) request to the service endpoint.
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {Readable | EventEmitter} stream Readable like stream for piping into the request stream
   * @param {AbortController} abortController Abort controller for canceling the active request
   * @returns {ProtoRequest} Request instance
   */
  public async makeClientStreamRequest<RequestType, ResponseType>(
    method: string,
    stream: Readable | EventEmitter,
    abortController: AbortController
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends client stream (request stream, single response) request to the service endpoint.
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {Readable | EventEmitter} stream Readable like stream for piping into the request stream
   * @param {RequestOptions} requestOptions Options for this specific request
   * @returns {ProtoRequest} Request instance
   */
  public async makeClientStreamRequest<RequestType, ResponseType>(
    method: string,
    stream: Readable | EventEmitter,
    requestOptions: RequestOptions
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends client stream (request stream, single response) request to the service endpoint.
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {StreamWriterSandbox | Readable | EventEmitter} writerSandbox Optional async supported callback for writing data to the open stream
   * @param {AbortController | RequestOptions} [requestOptions] Optional request options for this specific request
   * @returns {ProtoRequest} Request instance
   */
  public async makeClientStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox?:
      | StreamWriterSandbox<RequestType, ResponseType>
      | Readable
      | EventEmitter,
    requestOptions?: AbortController | RequestOptions
  ): Promise<ProtoRequest<RequestType, ResponseType>> {
    return await this.getClientStreamRequest<RequestType, ResponseType>(
      method,
      writerSandbox as StreamWriterSandbox<RequestType, ResponseType>,
      requestOptions as RequestOptions
    ).waitForEnd();
  }

  /**
   * Sends client stream (request stream, single response) request to the service endpoint.
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @returns {ProtoRequest} Request instance
   */
  public getClientStreamRequest<RequestType, ResponseType>(
    method: string
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Sends client stream (request stream, single response) request to the service endpoint.
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {StreamWriterSandbox} writerSandbox Async supported callback for writing data to the open stream
   * @returns {ProtoRequest} Request instance
   */
  public getClientStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Sends client stream (request stream, single response) request to the service endpoint.
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {Readable | EventEmitter} stream Readable like stream for piping into the request stream
   * @returns {ProtoRequest} Request instance
   */
  public getClientStreamRequest<RequestType, ResponseType>(
    method: string,
    stream: Readable | EventEmitter
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Sends client stream (request stream, single response) request to the service endpoint.
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {StreamWriterSandbox} writerSandbox Async supported callback for writing data to the open stream
   * @param {AbortController} abortController Abort controller for canceling the active request
   * @returns {ProtoRequest} Request instance
   */
  public getClientStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>,
    abortController: AbortController
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Sends client stream (request stream, single response) request to the service endpoint.
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {Readable | EventEmitter} stream Readable like stream for piping into the request stream
   * @param {AbortController} abortController Abort controller for canceling the active request
   * @returns {ProtoRequest} Request instance
   */
  public getClientStreamRequest<RequestType, ResponseType>(
    method: string,
    stream: Readable | EventEmitter,
    abortController: AbortController
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Sends client stream (request stream, single response) request to the service endpoint.
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {StreamWriterSandbox} writerSandbox Async supported callback for writing data to the open stream
   * @param {RequestOptions} requestOptions Options for this specific request
   * @returns {ProtoRequest} Request instance
   */
  public getClientStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>,
    requestOptions: RequestOptions
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Sends client stream (request stream, single response) request to the service endpoint.
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {Readable | EventEmitter} stream Readable like stream for piping into the request stream
   * @param {RequestOptions} requestOptions Options for this specific request
   * @returns {ProtoRequest} Request instance
   */
  public getClientStreamRequest<RequestType, ResponseType>(
    method: string,
    stream: Readable | EventEmitter,
    requestOptions: RequestOptions
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Triggers client stream (request stream, single response) request to the service endpoint, returning the ProtoRequest instance
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {StreamWriterSandbox | Readable | EventEmitter} writerSandbox Optional async supported callback for writing data to the open stream
   * @param {AbortController | RequestOptions} [requestOptions] Optional request options for this specific request
   * @returns {ProtoRequest} Request instance
   */
  public getClientStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox?:
      | StreamWriterSandbox<RequestType, ResponseType>
      | Readable
      | EventEmitter,
    requestOptions?: AbortController | RequestOptions
  ): ProtoRequest<RequestType, ResponseType> {
    return this.getRequest<RequestType, ResponseType>({
      method,
      requestMethodType: RequestMethodType.ClientStreamRequest,
      writerSandbox:
        typeof writerSandbox === "function" ? writerSandbox : undefined,
      pipeStream:
        typeof writerSandbox === "function" ? undefined : writerSandbox,
      requestOptions:
        requestOptions instanceof AbortController
          ? { abortController: requestOptions }
          : requestOptions,
    });
  }

  /**
   * Sends a server stream (single request, streamed response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @returns {ProtoRequest} Request instance
   */
  public async makeServerStreamRequest<ResponseType>(
    method: string
  ): Promise<ProtoRequest<unknown, ResponseType>>;

  /**
   * Sends a server stream (single request, streamed response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {StreamReader} streamReader Iteration function that will be called on every response chunk
   * @returns {ProtoRequest} Request instance
   */
  public async makeServerStreamRequest<ResponseType>(
    method: string,
    streamReader: StreamReader<unknown, ResponseType>
  ): Promise<ProtoRequest<unknown, ResponseType>>;

  /**
   * Sends a server stream (single request, streamed response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {RequestType} data Data to be sent as part of the request
   * @returns {ProtoRequest} Request instance
   */
  public async makeServerStreamRequest<RequestType, ResponseType = unknown>(
    method: string,
    data: RequestType
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends a server stream (single request, streamed response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {RequestType} data Data to be sent as part of the request
   * @param {StreamReader} streamReader Iteration function that will be called on every response chunk
   * @returns {ProtoRequest} Request instance
   */
  public async makeServerStreamRequest<RequestType, ResponseType>(
    method: string,
    data: RequestType,
    streamReader: StreamReader<RequestType, ResponseType>
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends a server stream (single request, streamed response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {RequestType} data Data to be sent as part of the request
   * @param {StreamReader} streamReader Iteration function that will be called on every response chunk
   * @param {AbortController} abortController Abort controller for canceling the active request
   * @returns {ProtoRequest} Request instance
   */
  public async makeServerStreamRequest<RequestType, ResponseType>(
    method: string,
    data: RequestType,
    streamReader: StreamReader<RequestType, ResponseType>,
    abortController: AbortController
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends a server stream (single request, streamed response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {RequestType} data Data to be sent as part of the request
   * @param {StreamReader} streamReader Iteration function that will be called on every response chunk
   * @param {RequestOptions} requestOptions Options for this specific request
   * @returns {ProtoRequest} Request instance
   */
  public async makeServerStreamRequest<RequestType, ResponseType>(
    method: string,
    data: RequestType,
    streamReader: StreamReader<RequestType, ResponseType>,
    requestOptions: RequestOptions
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends a server stream (single request, streamed response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {RequestType | StreamReader} [data] Optional data to be sent as part of the request
   * @param {StreamReader} [streamReader] Optional iteration function that will be called on every response chunk
   * @param {AbortController | RequestOptions} [requestOptions] Optional request options for this specific request
   * @returns {ProtoRequest} Request instance
   */
  public async makeServerStreamRequest<RequestType, ResponseType>(
    method: string,
    data?: RequestType | StreamReader<RequestType, ResponseType>,
    streamReader?: StreamReader<RequestType, ResponseType>,
    requestOptions?: AbortController | RequestOptions
  ): Promise<ProtoRequest<RequestType, ResponseType>> {
    return await this.getServerStreamRequest(
      method,
      data as RequestType,
      streamReader as StreamReader<RequestType, ResponseType>,
      requestOptions as RequestOptions
    ).waitForEnd();
  }

  /**
   * Triggers server stream (single request, streamed response) request to the service endpoint, returning the ProtoRequest instance
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @returns {ProtoRequest} Request instance
   */
  public getServerStreamRequest<ResponseType>(
    method: string
  ): ProtoRequest<unknown, ResponseType>;

  /**
   * Triggers server stream (single request, streamed response) request to the service endpoint, returning the ProtoRequest instance
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {StreamReader} streamReader Iteration function that will be called on every response chunk
   * @returns {ProtoRequest} Request instance
   */
  public getServerStreamRequest<ResponseType>(
    method: string,
    streamReader: StreamReader<unknown, ResponseType>
  ): ProtoRequest<unknown, ResponseType>;

  /**
   * Triggers server stream (single request, streamed response) request to the service endpoint, returning the ProtoRequest instance
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {RequestType} data Data to be sent as part of the request
   * @returns {ProtoRequest} Request instance
   */
  public getServerStreamRequest<RequestType, ResponseType = unknown>(
    method: string,
    data: RequestType
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Triggers server stream (single request, streamed response) request to the service endpoint, returning the ProtoRequest instance
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {RequestType} data Data to be sent as part of the request
   * @param {StreamReader} streamReader Iteration function that will be called on every response chunk
   * @returns {ProtoRequest} Request instance
   */
  public getServerStreamRequest<RequestType, ResponseType>(
    method: string,
    data: RequestType,
    streamReader: StreamReader<RequestType, ResponseType>
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Triggers server stream (single request, streamed response) request to the service endpoint, returning the ProtoRequest instance
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {RequestType} data Data to be sent as part of the request
   * @param {StreamReader} streamReader Iteration function that will be called on every response chunk
   * @param {AbortController} abortController Abort controller for canceling the active request
   * @returns {ProtoRequest} Request instance
   */
  public getServerStreamRequest<RequestType, ResponseType>(
    method: string,
    data: RequestType,
    streamReader: StreamReader<RequestType, ResponseType>,
    abortController: AbortController
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Triggers server stream (single request, streamed response) request to the service endpoint, returning the ProtoRequest instance
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {RequestType} data Data to be sent as part of the request
   * @param {StreamReader} streamReader Iteration function that will be called on every response chunk
   * @param {RequestOptions} requestOptions Options for this specific request
   * @returns {ProtoRequest} Request instance
   */
  public getServerStreamRequest<RequestType, ResponseType>(
    method: string,
    data: RequestType,
    streamReader: StreamReader<RequestType, ResponseType>,
    requestOptions: RequestOptions
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Triggers server stream (single request, streamed response) request to the service endpoint, returning the ProtoRequest instance
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {RequestType | StreamReader} [data] Optional data to be sent as part of the request
   * @param {StreamReader} [streamReader] Optional iteration function that will be called on every response chunk
   * @param {AbortController | RequestOptions} [requestOptions] Optional request options for this specific request
   * @returns {ProtoRequest} Request instance
   */
  public getServerStreamRequest<RequestType, ResponseType>(
    method: string,
    data?: RequestType | StreamReader<RequestType, ResponseType>,
    streamReader?: StreamReader<RequestType, ResponseType>,
    requestOptions?: AbortController | RequestOptions
  ): ProtoRequest<RequestType, ResponseType> {
    return this.getRequest<RequestType, ResponseType>({
      method,
      requestMethodType: RequestMethodType.ServerStreamRequest,
      data: typeof data === "function" ? undefined : data,
      streamReader:
        typeof data === "function"
          ? (data as StreamReader<RequestType, ResponseType>)
          : streamReader,
      requestOptions:
        requestOptions instanceof AbortController
          ? { abortController: requestOptions }
          : requestOptions,
    });
  }

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @returns {ProtoRequest} Request instance
   */
  public async makeBidiStreamRequest<
    RequestType = unknown,
    ResponseType = unknown
  >(method: string): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {StreamWriterSandbox} writerSandbox Async supported callback for writing data to the open stream
   * @returns {ProtoRequest} Request instance
   */
  public async makeBidiStreamRequest<RequestType, ResponseType = unknown>(
    method: string,
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {StreamWriterSandbox} writerSandbox Async supported callback for writing data to the open stream
   * @param {StreamReader} streamReader Iteration function that will be called on every response chunk
   * @returns {ProtoRequest} Request instance
   */
  public async makeBidiStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>,
    streamReader: StreamReader<RequestType, ResponseType>
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {StreamWriterSandbox} writerSandbox Async supported callback for writing data to the open stream
   * @param {StreamReader} streamReader Iteration function that will be called on every response chunk
   * @param {AbortController} abortController Abort controller for canceling the active request
   * @returns {ProtoRequest} Request instance
   */
  public async makeBidiStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>,
    streamReader: StreamReader<RequestType, ResponseType>,
    abortController: AbortController
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {StreamWriterSandbox} writerSandbox Async supported callback for writing data to the open stream
   * @param {StreamReader} streamReader Iteration function that will be called on every response chunk
   * @param {RequestOptions} requestOptions Options for this specific request
   * @returns {ProtoRequest} Request instance
   */
  public async makeBidiStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>,
    streamReader: StreamReader<RequestType, ResponseType>,
    requestOptions: RequestOptions
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {Readable | EventEmitter} stream Readable like stream for piping into the request stream
   * @returns {ProtoRequest} Request instance
   */
  public async makeBidiStreamRequest<RequestType, ResponseType = unknown>(
    method: string,
    stream: Readable | EventEmitter
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {Readable | EventEmitter} stream Readable like stream for piping into the request stream
   * @param {StreamReader} streamReader Iteration function that will be called on every response chunk
   * @returns {ProtoRequest} Request instance
   */
  public async makeBidiStreamRequest<RequestType, ResponseType>(
    method: string,
    stream: Readable | EventEmitter,
    streamReader: StreamReader<RequestType, ResponseType>
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {Readable | EventEmitter} stream Readable like stream for piping into the request stream
   * @param {StreamReader} streamReader Iteration function that will be called on every response chunk
   * @param {AbortController} abortController Abort controller for canceling the active request
   * @returns {ProtoRequest} Request instance
   */
  public async makeBidiStreamRequest<RequestType, ResponseType>(
    method: string,
    stream: Readable | EventEmitter,
    streamReader: StreamReader<RequestType, ResponseType>,
    abortController: AbortController
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {Readable | EventEmitter} stream Readable like stream for piping into the request stream
   * @param {StreamReader} streamReader Iteration function that will be called on every response chunk
   * @param {RequestOptions} requestOptions Options for this specific request
   * @returns {ProtoRequest} Request instance
   */
  public async makeBidiStreamRequest<RequestType, ResponseType>(
    method: string,
    stream: Readable | EventEmitter,
    streamReader: StreamReader<RequestType, ResponseType>,
    requestOptions: RequestOptions
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {StreamWriterSandbox | Readable | EventEmitter} [writerSandbox] Optional async supported callback for writing data to the open stream
   * @param {StreamReader} [streamReader] Optional iteration function that will be called on every response chunk
   * @param {AbortController | RequestOptions} [requestOptions] Optional request options for this specific request
   * @returns {ProtoRequest} Request instance
   */
  public async makeBidiStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox?:
      | StreamWriterSandbox<RequestType, ResponseType>
      | Readable
      | EventEmitter,
    streamReader?: StreamReader<RequestType, ResponseType>,
    requestOptions?: AbortController | RequestOptions
  ): Promise<ProtoRequest<RequestType, ResponseType>> {
    return await this.getBidiStreamRequest(
      method,
      writerSandbox as StreamWriterSandbox<RequestType, ResponseType>,
      streamReader as StreamReader<RequestType, ResponseType>,
      requestOptions as RequestOptions
    ).waitForEnd();
  }

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @returns {ProtoRequest} Request instance
   */
  public getBidiStreamRequest<RequestType = unknown, ResponseType = unknown>(
    method: string
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {StreamWriterSandbox} writerSandbox Async supported callback for writing data to the open stream
   * @returns {ProtoRequest} Request instance
   */
  public getBidiStreamRequest<RequestType, ResponseType = unknown>(
    method: string,
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {Readable | EventEmitter} stream Readable like stream for piping into the request stream
   * @returns {ProtoRequest} Request instance
   */
  public getBidiStreamRequest<RequestType, ResponseType = unknown>(
    method: string,
    stream: Readable | EventEmitter
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {StreamWriterSandbox} writerSandbox Async supported callback for writing data to the open stream
   * @param {StreamReader} streamReader Iteration function that will be called on every response chunk
   * @returns {ProtoRequest} Request instance
   */
  public getBidiStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>,
    streamReader: StreamReader<RequestType, ResponseType>
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {Readable | EventEmitter} stream Readable like stream for piping into the request stream
   * @param {StreamReader} streamReader Iteration function that will be called on every response chunk
   * @returns {ProtoRequest} Request instance
   */
  public getBidiStreamRequest<RequestType, ResponseType>(
    method: string,
    stream: Readable | EventEmitter,
    streamReader: StreamReader<RequestType, ResponseType>
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {StreamWriterSandbox} writerSandbox Async supported callback for writing data to the open stream
   * @param {StreamReader} streamReader Iteration function that will be called on every response chunk
   * @param {AbortController} abortController Abort controller for canceling the active request
   * @returns {ProtoRequest} Request instance
   */
  public getBidiStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>,
    streamReader: StreamReader<RequestType, ResponseType>,
    abortController: AbortController
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {Readable | EventEmitter} stream Readable like stream for piping into the request stream
   * @param {StreamReader} streamReader Iteration function that will be called on every response chunk
   * @param {AbortController} abortController Abort controller for canceling the active request
   * @returns {ProtoRequest} Request instance
   */
  public getBidiStreamRequest<RequestType, ResponseType>(
    method: string,
    stream: Readable | EventEmitter,
    streamReader: StreamReader<RequestType, ResponseType>,
    abortController: AbortController
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {StreamWriterSandbox} writerSandbox Async supported callback for writing data to the open stream
   * @param {StreamReader} streamReader Iteration function that will be called on every response chunk
   * @param {RequestOptions} requestOptions Options for this specific request
   * @returns {ProtoRequest} Request instance
   */
  public getBidiStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>,
    streamReader: StreamReader<RequestType, ResponseType>,
    requestOptions: RequestOptions
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {Readable | EventEmitter} stream Readable like stream for piping into the request stream
   * @param {StreamReader} streamReader Iteration function that will be called on every response chunk
   * @param {RequestOptions} requestOptions Options for this specific request
   * @returns {ProtoRequest} Request instance
   */
  public getBidiStreamRequest<RequestType, ResponseType>(
    method: string,
    stream: Readable | EventEmitter,
    streamReader: StreamReader<RequestType, ResponseType>,
    requestOptions: RequestOptions
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Triggers bi-directional (stream request, stream response) request to the service endpoint, returning the ProtoRequest instance
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param {StreamWriterSandbox | Readable | EventEmitter} [writerSandbox] Optional async supported callback for writing data to the open stream
   * @param {StreamReader} [streamReader] Optional iteration function that will be called on every response chunk
   * @param {AbortController | RequestOptions} [requestOptions] Optional request options for this specific request
   * @returns {ProtoRequest} Request instance
   */
  public getBidiStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox?:
      | StreamWriterSandbox<RequestType, ResponseType>
      | Readable
      | EventEmitter,
    streamReader?: StreamReader<RequestType, ResponseType>,
    requestOptions?: AbortController | RequestOptions
  ): ProtoRequest<RequestType, ResponseType> {
    return this.getRequest<RequestType, ResponseType>({
      method,
      requestMethodType: RequestMethodType.BidiStreamRequest,
      writerSandbox:
        typeof writerSandbox === "function" ? writerSandbox : undefined,
      pipeStream:
        typeof writerSandbox === "function" ? undefined : writerSandbox,
      streamReader,
      requestOptions:
        requestOptions instanceof AbortController
          ? { abortController: requestOptions }
          : requestOptions,
    });
  }

  /**
   * Starts a proto request, and waits for the results
   * @param {string} method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @returns {ProtoRequest} Request instance
   */
  public async makeRequest<RequestType = unknown, ResponseType = unknown>(
    method: string
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Starts a proto request, and waits for the results
   * @param {GenericRequestParams} params Request parameters for making a proto request
   * @returns {ProtoRequest} Request instance
   */
  public async makeRequest<RequestType = unknown, ResponseType = unknown>(
    params: GenericRequestParams<RequestType, ResponseType>
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Starts a proto request, and waits for the results
   * @param {string | GenericRequestParams} params Method path or request parameters for making a proto request
   * @returns {ProtoRequest} Request instance
   */
  public async makeRequest<RequestType = unknown, ResponseType = unknown>(
    params: string | GenericRequestParams<RequestType, ResponseType>
  ): Promise<ProtoRequest<RequestType, ResponseType>> {
    return await this.getRequest<RequestType, ResponseType>(
      params as GenericRequestParams<RequestType, ResponseType>
    ).waitForEnd();
  }

  /**
   * Generates and starts a proto request
   * @param {string} params Request parameters for making a proto request
   * @returns {ProtoRequest} Request instance
   */
  public getRequest<RequestType = unknown, ResponseType = unknown>(
    method: string
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Generates and starts a proto request
   * @param {GenericRequestParams} params Request parameters for making a proto request
   * @returns {ProtoRequest} Request instance
   */
  public getRequest<RequestType = unknown, ResponseType = unknown>(
    params: GenericRequestParams<RequestType, ResponseType>
  ): ProtoRequest<RequestType, ResponseType>;

  /**
   * Generates and starts a proto request
   * @param {string | GenericRequestParams} params Method path or request parameters for making a proto request
   * @returns {ProtoRequest} Request instance
   */
  public getRequest<RequestType = unknown, ResponseType = unknown>(
    params: string | GenericRequestParams<RequestType, ResponseType>
  ): ProtoRequest<RequestType, ResponseType> {
    if (typeof params === "string") {
      params = { method: params };
    }

    const request = new ProtoRequest<RequestType, ResponseType>({
      client: this,
      ...params,
    });

    // Attach request to the overall client
    this.activeRequests.push(request);
    request.on("aborted", () => this.removeActiveRequest(request));
    request.on("error", () => this.removeActiveRequest(request));
    request.on("end", () => this.removeActiveRequest(request));

    // Let any listeners know
    this.emit("request", request);

    return request;
  }

  /**
   * Aborts all requests that match the method defined
   * @param {string} match Method to match
   */
  public abortRequests(match: string): void;

  /**
   * Aborts all requests whose method passes the regex test
   * @param {RegExp} match Regex run against the method namespace for matching
   */
  public abortRequests(match: RegExp): void;

  /**
   * Aborts all requests that pass the match function
   * @param {EndpointMatcher} match Endpoint matcher util
   */
  public abortRequests(match: EndpointMatcher): void;

  /**
   * Aborts all requests that pass the matcher
   * @param {string | RegExp | EndpointMatcher} match Matching string/regex/function to filter request down that should be aborted
   */
  public abortRequests(match: string | RegExp | EndpointMatcher): void {
    const matcher: EndpointMatcher = generateEndpointMatcher(match);

    this.activeRequests.forEach((request) => {
      if (matcher(request.method, request)) {
        request.abort();
      }
    });
  }

  /**
   * Aborts all active requests and closes all gRPC connections
   */
  public close(): void {
    this.abortRequests(() => true);
    this.clients.forEach((client) => client.client.close());
    this.clients = [];
  }

  /**
   * Removes request from the active request list
   * @param {ProtoRequest} request Request to be removed
   * @private
   */
  private removeActiveRequest(request: UntypedProtoRequest): void {
    const index = this.activeRequests.indexOf(request);

    if (index > -1) {
      this.activeRequests.splice(index, 1);
    }
  }
}
