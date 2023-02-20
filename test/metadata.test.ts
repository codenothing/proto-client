import {
  ServerUnaryCall,
  sendUnaryData,
  status,
  Metadata,
  ServerReadableStream,
  ServerWritableStream,
  ServerDuplexStream,
} from "@grpc/grpc-js";
import {
  Customer,
  CustomersResponse,
  FindCustomersRequest,
  GetCustomerRequest,
  makeBidiStreamRequest,
  makeClientStreamRequest,
  makeServerStreamRequest,
  makeUnaryRequest,
  startServer,
} from "./utils";
import { MockServiceError } from "./MockServiceError";

describe("metadata", () => {
  const getResponseMetadata = () => {
    const metadata = new Metadata();
    metadata.set("updated_auth_token", "bazboo");
    return metadata;
  };

  const getTrailingMetadata = () => {
    const metadata = new Metadata();
    metadata.set("trailing_metadata", "trailer-foobar");
    return metadata;
  };

  beforeEach(async () => {
    await startServer({
      GetCustomer: (
        call: ServerUnaryCall<GetCustomerRequest, Customer>,
        callback: sendUnaryData<Customer>
      ) => {
        if (call.metadata.get("auth_token")?.[0] !== "foobar") {
          callback(
            new MockServiceError(status.INTERNAL, "Missing auth_token metadata")
          );
        } else {
          call.sendMetadata(getResponseMetadata());
          callback(
            null,
            { id: "github", name: "Github" },
            getTrailingMetadata()
          );
        }
      },

      EditCustomer: (
        call: ServerReadableStream<Customer, CustomersResponse>,
        callback: sendUnaryData<CustomersResponse>
      ) => {
        if (call.metadata.get("auth_token")?.[0] !== "foobar") {
          return callback(
            new MockServiceError(status.INTERNAL, "Missing auth_token metadata")
          );
        }

        const customers: Customer[] = [];
        call.on("data", (row) => customers.push(row));
        call.on("end", () => {
          call.sendMetadata(getResponseMetadata());
          callback(null, { customers }, getTrailingMetadata());
        });
      },

      FindCustomers: (
        call: ServerWritableStream<FindCustomersRequest, Customer>
      ) => {
        if (call.metadata.get("auth_token")?.[0] !== "foobar") {
          return call.destroy(
            new MockServiceError(status.INTERNAL, "Missing auth_token metadata")
          );
        }

        call.sendMetadata(getResponseMetadata());
        call.write({ id: "github", name: "Github" }, () => {
          call.write({ id: "npm", name: "NPM" }, () => {
            call.end(getTrailingMetadata());
          });
        });
      },

      CreateCustomers: (call: ServerDuplexStream<Customer, Customer>) => {
        if (call.metadata.get("auth_token")?.[0] !== "foobar") {
          return call.destroy(
            new MockServiceError(status.INTERNAL, "Missing auth_token metadata")
          );
        }

        let firstWrite = true;
        call.on("data", (row) => {
          if (call.writable) {
            if (firstWrite) {
              call.sendMetadata(getResponseMetadata());
              firstWrite = false;
            }

            call.write(row);
          }
        });

        call.on("end", () => {
          call.end(getTrailingMetadata());
        });
      },
    });
  });

  describe("Unary Request", () => {
    test("should convert object to metadata and verify the updated auth token coming back from the server", async () => {
      const request = await makeUnaryRequest(
        { id: "github" },
        {
          metadata: {
            auth_token: "foobar",
            companies: ["github", "npm", "circleci"],
          },
        }
      );
      expect(request.metadata.get("auth_token")).toEqual(["foobar"]);
      expect(request.metadata.get("companies")).toEqual([
        "github",
        "npm",
        "circleci",
      ]);
      expect(request.responseMetadata?.get(`updated_auth_token`)).toEqual([
        "bazboo",
      ]);
      expect(request.trailingMetadata?.get("trailing_metadata")).toEqual([
        "trailer-foobar",
      ]);
    });

    test("should verify the updated auth token through a metadata instance", async () => {
      const metadata = new Metadata();
      metadata.set("auth_token", "foobar");

      const request = await makeUnaryRequest({ id: "github" }, { metadata });
      expect(request.responseMetadata?.get(`updated_auth_token`)).toEqual([
        "bazboo",
      ]);
    });

    test("should fail the request if auth token is invalid in metadata", async () => {
      const { error } = await makeUnaryRequest(
        { id: "github" },
        { metadata: { auth_token: "barbaz" } }
      );

      expect(error?.message).toStrictEqual(
        `13 INTERNAL: Missing auth_token metadata`
      );
    });
  });

  describe("Client Stream Request", () => {
    test("should convert object to metadata and verify the updated auth token coming back from the server", async () => {
      const request = await makeClientStreamRequest(
        async (write, request) => {
          // Trailing metadata should not be set until request completes
          expect(request.trailingMetadata).toStrictEqual(undefined);
          await write({ id: "github", name: "Github" });
          await write({ id: "npm", name: "NPM" });
        },
        {
          metadata: {
            auth_token: "foobar",
            companies: ["github", "npm", "circleci"],
          },
        }
      );
      expect(request.metadata.get("auth_token")).toEqual(["foobar"]);
      expect(request.metadata.get("companies")).toEqual([
        "github",
        "npm",
        "circleci",
      ]);
      expect(request.responseMetadata?.get(`updated_auth_token`)).toEqual([
        "bazboo",
      ]);
      expect(request.trailingMetadata?.get("trailing_metadata")).toEqual([
        "trailer-foobar",
      ]);
    });

    test("should verify the updated auth token through a metadata instance", async () => {
      const metadata = new Metadata();
      metadata.set("auth_token", "foobar");

      const request = await makeClientStreamRequest(
        async (write) => {
          await write({ id: "github", name: "Github" });
          await write({ id: "npm", name: "NPM" });
        },
        { metadata }
      );
      expect(request.responseMetadata?.get(`updated_auth_token`)).toEqual([
        "bazboo",
      ]);
    });

    test("should fail the request if auth token is invalid in metadata", async () => {
      const { error } = await makeClientStreamRequest(
        async (write) => {
          await write({ id: "github", name: "Github" });
          await write({ id: "npm", name: "NPM" });
        },
        { metadata: { auth_token: "barbaz" } }
      );

      expect(error?.message).toStrictEqual(
        `13 INTERNAL: Missing auth_token metadata`
      );
    });
  });

  describe("Server Stream Request", () => {
    test("should convert object to metadata and verify the updated auth token coming back from the server", async () => {
      const request = await makeServerStreamRequest(
        {},
        async (_data, _index, request) => {
          // Trailing metadata should not be set until request completes
          expect(request.trailingMetadata).toStrictEqual(undefined);
        },
        {
          metadata: {
            auth_token: "foobar",
            companies: ["github", "npm", "circleci"],
          },
        }
      );
      expect(request.metadata.get("auth_token")).toEqual(["foobar"]);
      expect(request.metadata.get("companies")).toEqual([
        "github",
        "npm",
        "circleci",
      ]);
      expect(request.responseMetadata?.get(`updated_auth_token`)).toEqual([
        "bazboo",
      ]);
      expect(request.trailingMetadata?.get("trailing_metadata")).toEqual([
        "trailer-foobar",
      ]);
    });

    test("should verify the updated auth token through a metadata instance", async () => {
      const metadata = new Metadata();
      metadata.set("auth_token", "foobar");

      const request = await makeServerStreamRequest({}, async () => undefined, {
        metadata,
      });
      expect(request.responseMetadata?.get(`updated_auth_token`)).toEqual([
        "bazboo",
      ]);
    });

    test("should fail the request if auth token is invalid in metadata", async () => {
      const { error } = await makeServerStreamRequest(
        {},
        async () => undefined,
        {
          metadata: { auth_token: "barbaz" },
        }
      );

      expect(error?.message).toStrictEqual(
        `13 INTERNAL: Missing auth_token metadata`
      );
    });
  });

  describe("Bidi Stream Request", () => {
    test("should convert object to metadata and verify the updated auth token coming back from the server", async () => {
      const request = await makeBidiStreamRequest(
        async (write, request) => {
          // Trailing metadata should not be set until request completes
          expect(request.trailingMetadata).toStrictEqual(undefined);
          await write({ id: "github", name: "Github" });
          await write({ id: "npm", name: "NPM" });
        },
        async (_data, _index, request) => {
          // Trailing metadata should not be set until request completes
          expect(request.trailingMetadata).toStrictEqual(undefined);
        },
        {
          metadata: {
            auth_token: "foobar",
            companies: ["github", "npm", "circleci"],
          },
        }
      );
      expect(request.metadata.get("auth_token")).toEqual(["foobar"]);
      expect(request.metadata.get("companies")).toEqual([
        "github",
        "npm",
        "circleci",
      ]);
      expect(request.responseMetadata?.get(`updated_auth_token`)).toEqual([
        "bazboo",
      ]);
      expect(request.trailingMetadata?.get("trailing_metadata")).toEqual([
        "trailer-foobar",
      ]);
    });

    test("should verify the updated auth token through a metadata instance", async () => {
      const metadata = new Metadata();
      metadata.set("auth_token", "foobar");

      const request = await makeBidiStreamRequest(
        async (write) => {
          await write({ id: "github", name: "Github" });
          await write({ id: "npm", name: "NPM" });
        },
        async () => undefined,
        {
          metadata,
        }
      );
      expect(request.responseMetadata?.get(`updated_auth_token`)).toEqual([
        "bazboo",
      ]);
    });

    test("should fail the request if auth token is invalid in metadata", async () => {
      const { error } = await makeBidiStreamRequest(
        async (write) => {
          await write({ id: "github", name: "Github" });
          await write({ id: "npm", name: "NPM" });
        },
        async () => undefined,
        {
          metadata: { auth_token: "barbaz" },
        }
      );

      expect(error?.message).toStrictEqual(
        `13 INTERNAL: Missing auth_token metadata`
      );
    });
  });
});
