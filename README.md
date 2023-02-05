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

Given the following `customers.proto` file, running the `proto-client` command will generate a js/ts client scaffold for easy functional request making

```proto
syntax = "proto3";

package customers;

message Customer {
	string id = 1;
	string name = 2;
}

message GetCustomerRequest {
	string id = 1;
}

message FindCustomersRequest {
	string name = 1;
}

message CustomersResponse {
	repeated Customer customers = 1;
}

service Customers {
	rpc GetCustomer (GetCustomerRequest) returns (Customer);
	rpc FindCustomers (FindCustomersRequest) returns (stream Customer);
	rpc EditCustomer (stream Customer) returns (CustomersResponse);
	rpc CreateCustomers (stream Customer) returns (stream Customer);
}

```

The `client.js` code generated:

```js
module.exports.customers = {
  Customers: {
    GetCustomer: async (data) =>
      protoClient.makeUnaryRequest("customers.Customers.GetCustomer", data),

    CreateCustomers: async (writerSandbox, streamReader) =>
      protoClient.CreateCustomers(
        "customers.Customers.CreateCustomers",
        writerSandbox,
        streamReader
      ),
  },
};
```

To make calls:

```ts
import { protoClient, customers } from "output/client";

// Configuring service endpoint(s)
protoClient.configureClient({ endpoint: "127.0.0.1:8080" });

// Unary Requests
const request = await customers.Customers.GetCustomer({ name: "Github" });
request.result; // Customer

// Bidrectional Requests
await customers.Customers.CreateCustomers(
  async (write) => {
    await write({ name: "github", action: "Github" });
    await write({ name: "npm", action: "NPM" });
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
    // Matching all rpc methods of the customers.Customers service to a specific service endpoint
    {
      address: "127.0.0.1:8081",
      match: "customers.Customers.*",
    },

    // Matching all rpc methods of the v1.products.TransportationService service to a specific service endpoint
    {
      address: "127.0.0.1:8082",
      match: "v1.products.TransportationService.*",
    },

    // Matching an entire namespace to a specific service endpoint
    {
      address: "127.0.0.1:8083",
      match: "v1.employees.*",
    },
  ],
});
```

## Retry Options

Every request is wrapped in a retry handle allowing for fully customized handling timeouts and retries. Can be configured at both the overall client and individual request levels.

- `timeout`: Time in milliseconds before cancelling the request. Defaults to 0 for no timeout
- `retryOptions`: Retry configuration object
  - `retryCount`: Number of times to retry request. Defaults to none
  - `status`: Status codes request is allowed to retry on. Uses default list of status codes if not defined
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
