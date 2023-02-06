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
  ProtoSettings,
  RequestMiddleware,
  RequestOptions,
  StreamReader,
  StreamWriterSandbox,
} from "./interfaces";
import { generateEndpointMatcher } from "./util";

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
   */
  public clientSettings: ClientSettings = {
    endpoint: `0.0.0.0:8080`,
  };

  /**
   * Protobuf parsing settings
   */
  public protoSettings: ProtoSettings = {};

  /**
   * Internal proto conversion options, for referencing
   */
  public protoConversionOptions: Protobuf.IConversionOptions = {
    longs: Number,
    enums: String,
    defaults: false,
    oneofs: true,
  };

  /**
   * List of currently active requests
   */
  public activeRequests: UntypedProtoRequest[] = [];

  /**
   * Middleware to run before each request
   */
  public middleware: RequestMiddleware[] = [];

  /**
   * Root protobuf object for referencing
   */
  private root?: Protobuf.Root;

  /**
   * Client endpoints list
   */
  private clients: Array<{
    endpoint: ClientEndpoint;
    match: EndpointMatcher;
    client: Client;
  }> = [];

  /**
   * Shorthand wrapper utilities for gRPC client calls
   * @param options Configuration options for the client
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
   * @param clientSettings Settings for client connection
   */
  public configureClient(clientSettings: ClientSettings) {
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
   * @param protoSettings Proto reading/writing settings
   */
  public configureProtos(protoSettings: ProtoSettings) {
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
   * @param options Conversion options
   */
  public configureConversionOptions(options: Protobuf.IConversionOptions) {
    this.protoConversionOptions = options;
  }

  /**
   * Fetches the endpoint matching client instance
   * throwing an error if not yet configured
   * @param request Active request looking for it's client endpoint
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
   * Fetches the current proto root object, throwing an error if not yet configured
   */
  public getRoot(): Protobuf.Root {
    if (!this.root) {
      throw new Error(`ProtoClient protos are not yet configured`);
    }

    return this.root;
  }

  /**
   * Adds function to the middleware stack
   * @param middleware Middleware to run before each request
   */
  public useMiddleware(middleware: RequestMiddleware) {
    this.middleware.push(middleware);
  }

  /**
   * Sends unary (request/response) request to the service endpoint
   * @param method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   */
  public async makeUnaryRequest<ResponseType>(
    method: string
  ): Promise<ProtoRequest<unknown, ResponseType | undefined>>;

  /**
   * Sends unary (request/response) request to the service endpoint
   * @param method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param data Data to be sent as part of the request
   */
  public async makeUnaryRequest<RequestType, ResponseType>(
    method: string,
    data: RequestType
  ): Promise<ProtoRequest<RequestType, ResponseType | undefined>>;

  /**
   * Sends unary (request/response) request to the service endpoint
   * @param method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param data Data to be sent as part of the request. Defaults to empty object
   * @param abortController Abort controller for canceling the active request
   */
  public async makeUnaryRequest<RequestType, ResponseType>(
    method: string,
    data: RequestType | null,
    abortController: AbortController
  ): Promise<ProtoRequest<RequestType, ResponseType | undefined>>;

  /**
   * Sends unary (request/response) request to the service endpoint
   * @param method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param data Data to be sent as part of the request. Defaults to empty object
   * @param requestOptions Options for this specific request
   */
  public async makeUnaryRequest<RequestType, ResponseType>(
    method: string,
    data: RequestType | null,
    requestOptions: RequestOptions
  ): Promise<ProtoRequest<RequestType, ResponseType | undefined>>;

  // Actual makeUnaryRequest for the overloads above
  public async makeUnaryRequest<RequestType, ResponseType>(
    method: string,
    data?: RequestType | null,
    requestOptions?: AbortController | RequestOptions
  ): Promise<ProtoRequest<RequestType, ResponseType | undefined>> {
    const request = await this.generateRequest<RequestType, ResponseType>(
      method,
      RequestMethodType.UnaryRequest,
      requestOptions
    );

    return request.makeUnaryRequest(data);
  }

  /**
   * Sends client stream (request stream, single response) request to the service endpoint.
   * @param method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param writerSandbox Async supported callback for writing data to the open stream
   */
  public async makeClientStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>
  ): Promise<ProtoRequest<RequestType, ResponseType | undefined>>;

  /**
   * Sends client stream (request stream, single response) request to the service endpoint.
   * @param method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param writerSandbox Async supported callback for writing data to the open stream
   * @param abortController Abort controller for canceling the active request
   */
  public async makeClientStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>,
    abortController: AbortController
  ): Promise<ProtoRequest<RequestType, ResponseType | undefined>>;

  /**
   * Sends client stream (request stream, single response) request to the service endpoint.
   * @param method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param writerSandbox Async supported callback for writing data to the open stream
   * @param requestOptions Options for this specific request
   */
  public async makeClientStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>,
    requestOptions: RequestOptions
  ): Promise<ProtoRequest<RequestType, ResponseType | undefined>>;

  // Actual makeClientStreamRequest for the overloads above
  public async makeClientStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>,
    requestOptions?: AbortController | RequestOptions
  ): Promise<ProtoRequest<RequestType, ResponseType | undefined>> {
    const request = await this.generateRequest<RequestType, ResponseType>(
      method,
      RequestMethodType.ClientStreamRequest,
      requestOptions
    );

    return request.makeClientStreamRequest(writerSandbox);
  }

  /**
   * Sends a server stream (single request, streamed response) request to the service endpoint
   * @param method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param streamReader Iteration function that will be called on every response chunk
   */
  public async makeServerStreamRequest<ResponseType>(
    method: string,
    streamReader: StreamReader<unknown, ResponseType>
  ): Promise<ProtoRequest<unknown, ResponseType>>;

  /**
   * Sends a server stream (single request, streamed response) request to the service endpoint
   * @param method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param data Data to be sent as part of the request
   * @param streamReader Iteration function that will be called on every response chunk
   */
  public async makeServerStreamRequest<RequestType, ResponseType>(
    method: string,
    data: RequestType,
    streamReader: StreamReader<RequestType, ResponseType>
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends a server stream (single request, streamed response) request to the service endpoint
   * @param method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param data Data to be sent as part of the request
   * @param streamReader Iteration function that will be called on every response chunk
   * @param abortController Abort controller for canceling the active request
   */
  public async makeServerStreamRequest<RequestType, ResponseType>(
    method: string,
    data: RequestType,
    streamReader: StreamReader<RequestType, ResponseType>,
    abortController: AbortController
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends a server stream (single request, streamed response) request to the service endpoint
   * @param method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param data Data to be sent as part of the request
   * @param streamReader Iteration function that will be called on every response chunk
   * @param requestOptions Options for this specific request
   */
  public async makeServerStreamRequest<RequestType, ResponseType>(
    method: string,
    data: RequestType,
    streamReader: StreamReader<RequestType, ResponseType>,
    requestOptions: RequestOptions
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  // Actual makeServerStreamRequest for the overloads above
  public async makeServerStreamRequest<RequestType, ResponseType>(
    method: string,
    data: RequestType | StreamReader<RequestType, ResponseType>,
    streamReader?: StreamReader<RequestType, ResponseType>,
    requestOptions?: AbortController | RequestOptions
  ): Promise<ProtoRequest<RequestType, ResponseType>> {
    const request = await this.generateRequest<RequestType, ResponseType>(
      method,
      RequestMethodType.ServerStreamRequest,
      requestOptions
    );

    return request.makeServerStreamRequest(data, streamReader);
  }

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param writerSandbox Async supported callback for writing data to the open stream
   * @param streamReader Iteration function that will be called on every response chunk
   */
  public async makeBidiStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>,
    streamReader: StreamReader<RequestType, ResponseType>
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param writerSandbox Async supported callback for writing data to the open stream
   * @param streamReader Iteration function that will be called on every response chunk
   * @param abortController Abort controller for canceling the active request
   */
  public async makeBidiStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>,
    streamReader: StreamReader<RequestType, ResponseType>,
    abortController: AbortController
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  /**
   * Sends a bi-directional (stream request, stream response) request to the service endpoint
   * @param method Fully qualified path of the method for the request that can be used by protobufjs.lookup
   * @param writerSandbox Async supported callback for writing data to the open stream
   * @param streamReader Iteration function that will be called on every response chunk
   * @param requestOptions Options for this specific request
   */
  public async makeBidiStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>,
    streamReader: StreamReader<RequestType, ResponseType>,
    requestOptions: RequestOptions
  ): Promise<ProtoRequest<RequestType, ResponseType>>;

  // Actual makeBidiStreamRequest for the overloads above
  public async makeBidiStreamRequest<RequestType, ResponseType>(
    method: string,
    writerSandbox: StreamWriterSandbox<RequestType, ResponseType>,
    streamReader: StreamReader<RequestType, ResponseType>,
    requestOptions?: AbortController | RequestOptions
  ): Promise<ProtoRequest<RequestType, ResponseType>> {
    const request = await this.generateRequest<RequestType, ResponseType>(
      method,
      RequestMethodType.BidiStreamRequest,
      requestOptions
    );

    return request.makeBidiStreamRequest(writerSandbox, streamReader);
  }

  /**
   * Aborts all requests that match the method defined
   * @param match Method to match
   */
  public abortRequests(match: string): void;

  /**
   * Aborts all requests whose method passes the regex test
   * @param match Regex run against the method namespace for matching
   */
  public abortRequests(match: RegExp): void;

  /**
   * Aborts all requests that pass the match function
   * @param match Endpoint matcher util
   */
  public abortRequests(match: EndpointMatcher): void;

  // Actual abortRequests for the overloads above
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
   * Manages request within the active requests list
   * @param method Method name for the request
   * @param requestMethodType Method type
   */
  private async generateRequest<RequestType, ResponseType>(
    method: string,
    requestMethodType: RequestMethodType,
    requestOptions: AbortController | RequestOptions | undefined
  ): Promise<ProtoRequest<RequestType, ResponseType>> {
    const request = new ProtoRequest<RequestType, ResponseType>(
      this,
      method,
      requestMethodType,
      requestOptions
    );

    request.on("aborted", () => this.removeActiveRequest(request));
    request.on("end", () => this.removeActiveRequest(request));

    this.activeRequests.push(request);

    // Run middleware
    try {
      for (const middleware of this.middleware) {
        await middleware(request, this);
      }
    } catch (e) {
      if (e instanceof Error) {
        request.error = e;
      } else if (typeof e === "string") {
        request.error = new Error(e);
      } else {
        request.error = new Error(`Unknown Middleware Error: ${e}`);
      }

      this.removeActiveRequest(request);
      request.emit("end", request);

      throw request.error;
    }

    this.emit("request", request);

    return request;
  }

  /**
   * Removes request from the active request list
   * @param request Request to be removed
   */
  private removeActiveRequest(request: UntypedProtoRequest) {
    const index = this.activeRequests.indexOf(request);

    if (index > -1) {
      this.activeRequests.splice(index, 1);
    }
  }
}
