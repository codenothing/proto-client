# ProtoClient

A simple, typed gRPC Client with static code generation

```ts
const client = new ProtoClient({
  clientSettings: { endpoint: "0.0.0.0:8080" },
  protoSettings: { files: ["protos/v1/customers.proto"] },
});

const { result, error } = await client.makeUnaryRequest(
  "v1.Customers.GetCustomer",
  { id: "github" }
);
result; // Github Customer
error; // Any error that may have occurred during the request
```

Reading data from a streamed response can be done by adding a read iterator

```ts
await client.makeServerStreamRequest(
  "v1.Customers.FindCustomers",
  { name: "git*" },
  async (row) => {
    row; // Incoming response row chunk
  }
);
```

Streaming data to a server can be done through a write sandbox

```ts
const { result } = await client.makeClientStreamRequest(
  "v1.Customers.EditCustomer",
  async (write) => {
    await write({ id: "github", name: "Github" });
    await write({ id: "npm", name: "NPM" });
  }
);
result.customers; // List of customers updated
```

And duplex streams combines both paradigms above into one

```ts
await client.makeBidiStreamRequest(
  "v1.Customers.CreateCustomers",
  async (write) => {
    await write({ id: "github", name: "Github" });
    await write({ id: "npm", name: "NPM" });
  },
  async (row) => {
    row; // Incoming response row chunk
  }
);
```

Requests can also be piped into other request streams

```ts
const request = client.getServerStreamRequest("v1.Customers.FindCustomers", {
  name: "git*",
});

await client.makeBidiStreamRequest(
  "v1.Customers.CreateCustomers",
  request.transform(async (customer) => {
    return { ...customer, isCopied: true };
  }),
  async (row) => {
    row; // Incoming response row chunk
  }
);
```

## Middleware

The `ProtoClient` instance provides middleware injection to adjust requests before they are sent. A great use case would be adding authentication tokens to the request metadata in one location rather than at each line of code a request is made

```ts
client.useMiddleware((request) => {
  request.metadata.set("authToken", "abc_123");
});
```

## Events

Each request instance extends NodeJS's [EventEmitter](https://nodejs.org/api/events.html#class-eventemitter), allowing callers to hook into specific signal points during the process of a request. To extend the use case above, updates to authentication tokens can be passed back in Metadata and auto assigned in one location rather than at each line of code a request is made

```ts
let authToken = "";

client.useMiddleware((request) => {
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
  - `data`: Event emitted each time a response is received from the server (once for unary responses, every chunk for streamed responses)
  - `response`: Event emitted right before the first response is sent to the caller
  - `retry`: Event emitted right before a retry request is started
  - `aborted`: Event emitted when the request has been aborted
  - `error`: Event emitted when the request resolves with an error
  - `end`: Event emitted after the last response (or error) has been returned to the caller
- **ProtoClient**:
  - `request`: Event emitted at creation of a request (before middleware is run)

## Multi Service Support

For multi service architectures, `ProtoClient` comes with built-in support to configure which requests point to with service endpoint using a matching utility. This is purely configuration, and requires no changes to individual methods/requests

```ts
client.configureClient({
  endpoint: [
    // Matching all rpc methods of the v1.Customers service to a specific service endpoint
    {
      address: "127.0.0.1:8081",
      match: "v1.Customers.*",
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

## Automatic Retries

Every request is wrapped in a retry function, allowing for fully customized handling of timeouts and retries. Can be configured at both the overall client, and individual request levels.

- `retryCount`: Number of times to retry request. Defaults to none
- `status`: Status code(s) request is allowed to retry on. Uses default list of status codes if not defined

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

package v1;

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
module.exports.v1 = {
  Customers: {
    GetCustomer: async (data) =>
      protoClient.makeUnaryRequest("v1.Customers.GetCustomer", data),

    CreateCustomers: async (writerSandbox, streamReader) =>
      protoClient.CreateCustomers(
        "v1.Customers.CreateCustomers",
        writerSandbox,
        streamReader
      ),
  },
};
```

To make calls:

```ts
import { protoClient, v1 } from "output/client";

// Configuring service endpoint(s)
protoClient.configureClient({ endpoint: "127.0.0.1:8080" });

// Unary Requests
const { result } = await v1.Customers.GetCustomer({ id: "github" });
result; // Customer

// Bidirectional Requests
await v1.Customers.CreateCustomers(
  async (write) => {
    await write({ name: "github", action: "Github" });
    await write({ name: "npm", action: "NPM" });
  },
  async (row) => {
    // ... each streamed row ...
  }
);
```
