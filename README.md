# ProtoClient

A typed gRPC Client with static code generation

## Static Code Generation

Translates `.proto` files into functional API calls

```
proto-client [options] file1.proto file2.proto ...

Options:
      --version       Show version number
  -o, --output        Output directory for compiled files
  -p, --path          Adds a directory to the include path
      --keep-case     Keeps field casing instead of converting to camel case
      --force-long    Enforces the use of 'Long' for s-/u-/int64 and s-/fixed64 fields
      --force-number  Enforces the use of 'number' for s-/u-/int64 and s-/fixed64 fields
      --help          Show help
```

### Example

Given the following `animals.proto` file, running the `proto-client` command will generate a js/ts client scaffold for easy functional request making

```proto
syntax = "proto3";
package animals;

message Animal {
  string id = 1;
  string name = 2;
  string action = 3;
}

message AnimalRequest {
  string name = 1;
}

message CreateAnimalRequest {
  string name = 1;
  string action = 2;
}

service AnimalService {
  rpc GetAnimal (AnimalRequest) returns (Animal);
  rpc CreateAnimal (stream CreateAnimalRequest) returns (stream Animal);
}
```

The `client.js` code generated:

```js
module.exports.animals = {
  AnimalService: {
    GetAnimal: async (data) =>
      protoClient.makeUnaryRequest("animals.AnimalService.GetAnimal", data),

    CreateAnimal: async (writerSandbox, streamReader) =>
      protoClient.CreateAnimal(
        "animals.AnimalService.CreateAnimal",
        writerSandbox,
        streamReader
      ),
  },
};
```

To make calls:

```ts
import { protoClient, animals } from "output/client";

// Configuring service endpoint(s)
protoClient.configureClient({ endpoint: "127.0.0.1:8080" });

// Unary Requests
const request = await animals.AnimalService.GetAnimal({ name: "dog" });
request.result; // Animal

// Bidrectional Requests
await animals.AnimalService.CreateAnimal(
  async (write) => {
    await write({ name: "dog", action: "bark" });
    await write({ name: "cat", action: "meow" });
  },
  async (row) => {
    // ... each streamed row ...
  }
);
```

## Middleware

The `protoClient` instance provides middleware injection to adjust requests before they are sent. A great use case would be adding authentication tokens to the request metadata in one location rather than at each line of code a request is made

```ts
protoClient.useMiddleware((request) => {
  request.metadata.set("authToken", "abc_123");
});
```

## Events

Each request instance extends NodeJS's [EventEmitter](https://nodejs.org/api/events.html#class-eventemitter), allowing callers to hook into specific signal points during the process of a request. To extend the use case above, updates to authentication tokens can be passed back in Metadata and auto assigned in one location rather than at each line of code a request is made

```ts
let authToken = "";

protoClient.useMiddleware((request) => {
  if (authToken) {
    request.metadata.set("authToken", authToken);
  }

  request.on("response", () => {
    const token = request.responseMetadata?.get("updatedAuthToken");
    if (token) {
      authToken = token[0];
    }
  });
});
```

### List of Events

- **ProtoRequest**:
  - `response`: Event emitted right before the first response is sent to the caller
  - `retry`: Event emitted right before a retry request is started
  - `aborted`: Event emitted when the request has been aborted
  - `end`: Event emitted after the last response (or error) has been returned to the caller
- **ProtoClient**:
  - `request`: Event emitted before a request is started, but after all middleware has run. (_will not emit if middleware throws an error_)

## Multi Service Support

For multi service architectures, `ProtoClient` comes with built-in support to configure which requests point to with service endpoint using a matching utility. This is purely configuration, and requires no changes to individual methods/requests

```ts
protoClient.configureClient({
  endpoint: [
    // Matching all rpc methods of the animals.AnimalService to a specific service endpoint
    {
      address: "127.0.0.1:8081",
      match: "animals.AnimalService.*",
    },

    // Matching all rpc methods of the transportation.VehicleService to a specific service endpoint
    {
      address: "127.0.0.1:8082",
      match: "transportation.VehicleService.*",
    },

    // Matching entire namespace to a specific service endpoint
    {
      address: "127.0.0.1:8083",
      match: "veterinarian.*",
    },
  ],
});
```

## Retry Options

Every request is wrapped in a retry function, allowing for fully customized handling of timeouts and retries. Can be configured at both the overall client, and individual request levels.

- `timeout`: Time in milliseconds before cancelling the request. Defaults to 0 for no timeout
- `retryOptions`: Retry configuration object
  - `retryCount`: Number of times to retry request. Defaults to none
  - `status`: Status code(s) request is allowed to retry on. Uses default list of status codes if not defined
  - `retryOnClientTimeout`: Indicates if retries should be allowed when the client times out. Defaults to true.

## Request API

The underneath `ProtoClient` class covers all four gRPC request methods

#### makeUnaryRequest

Making unary requests to a gRPC endpoint.

```ts
function makeUnaryRequest<RequestType, ResponseType>(
  method: string,
  data: RequestType,
  requestOptions?: RequestOptions
): Promise<ProtoRequest>;
```

#### makeClientStreamRequest

Making streamed requests to a gRPC endpoint.

```ts
function makeClientStreamRequest<RequestType, ResponseType>(
  method: string,
  writerSandbox: WriterSandbox<RequestType, ResponseType>,
  requestOptions?: RequestOptions
): Promise<ProtoRequest>;
```

#### makeServerStreamRequest

Making requests to a gRPC endpoint while streaming the response.

```ts
function makeServerStreamRequest<RequestType, ResponseType>(
  method: string,
  data: RequestType,
  streamReader: streamReader<RequestType, ResponseType>,
  requestOptions?: RequestOptions
): Promise<ProtoRequest>;
```

#### makeBidiStreamRequest

Making bidirectional requests to a gRPC endpoint, streaming data to and from the service.

```ts
function makeBidiStreamRequest<RequestType, ResponseType>(
  method: string,
  writerSandbox: WriterSandbox<RequestType, ResponseType>,
  streamReader: streamReader<RequestType, ResponseType>,
  requestOptions?: RequestOptions
): Promise<ProtoRequest>;
```
