import {
  ServerUnaryCall,
  sendUnaryData,
  Client,
  ServerReadableStream,
  ServerWritableStream,
  UntypedServiceImplementation,
} from "@grpc/grpc-js";
import * as Protobuf from "protobufjs";
import {
  ProtoClient,
  ProtoRequest,
  ProtoSettings,
  RequestMethodType,
} from "../src";
import {
  startServer,
  GetCustomerRequest,
  Customer,
  PROTO_FILE_PATHS,
  makeUnaryRequest,
  CustomersResponse,
  FindCustomersRequest,
  makeClientStreamRequest,
  makeServerStreamRequest,
  wait,
  generateProtoServer,
} from "./utils";

jest.setTimeout(1000);

describe("ProtoClient", () => {
  let client: ProtoClient;
  let request: ProtoRequest<GetCustomerRequest, Customer>;
  let serviceMethods: UntypedServiceImplementation;
  let RESPONSE_DELAY = 0;

  beforeEach(async () => {
    serviceMethods = {
      // Unary
      GetCustomer: (
        _call: ServerUnaryCall<GetCustomerRequest, Customer>,
        callback: sendUnaryData<Customer>
      ) => {
        setTimeout(() => {
          callback(null, { id: "github", name: "Github" });
        }, RESPONSE_DELAY);
      },

      // Client Stream
      EditCustomer: (
        call: ServerReadableStream<Customer, CustomersResponse>,
        callback: sendUnaryData<CustomersResponse>
      ) => {
        const customers: Customer[] = [];

        call.on("data", (row: Customer) => {
          customers.push(row);
        });

        call.on("end", () => {
          if (call.cancelled) {
            return;
          }

          setTimeout(() => {
            if (!call.cancelled) {
              callback(null, { customers });
            }
          }, RESPONSE_DELAY);
        });
      },

      // Server Stream
      FindCustomers: (
        call: ServerWritableStream<FindCustomersRequest, Customer>
      ) => {
        setTimeout(() => {
          call.write({ id: "github", name: "Github" }, () => {
            if (call.writable) {
              call.write({ id: "npm", name: "NPM" }, () => {
                if (call.writable) {
                  call.end();
                }
              });
            }
          });
        }, RESPONSE_DELAY);
      },
    };

    const results = await startServer(serviceMethods);
    client = results.client;

    request = new ProtoRequest<GetCustomerRequest, Customer>(
      {
        method: "customers.Customers.GetCustomer",
        requestMethodType: RequestMethodType.UnaryRequest,
      },
      client
    );
  });

  test("should proxy settings passed on init to each configuration method", () => {
    const client = new ProtoClient({
      clientSettings: {
        endpoint: `0.0.0.0:8081`,
      },
      protoSettings: {
        files: PROTO_FILE_PATHS,
      },
      conversionOptions: {
        defaults: true,
      },
    });

    expect(client.clientSettings).toEqual({
      endpoint: `0.0.0.0:8081`,
    });
    expect(client.protoSettings).toEqual({
      files: PROTO_FILE_PATHS,
    });
    expect(client.protoConversionOptions).toEqual({
      defaults: true,
    });
  });

  describe("configureClient", () => {
    test("should close out existing connections before setting up a new one", () => {
      const closeSpy = jest.spyOn(client, "close").mockReturnValue(undefined);

      client.configureClient({
        endpoint: `0.0.0.0:9091`,
      });
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("configureProtos", () => {
    test("passing proto options should override defaults", () => {
      const loadSyncSpy = jest.spyOn(Protobuf.Root.prototype, "loadSync");

      const settings: ProtoSettings = {
        files: PROTO_FILE_PATHS,
        parseOptions: {
          keepCase: false,
          alternateCommentMode: false,
        },
        conversionOptions: {
          defaults: true,
        },
      };

      client.configureProtos(settings);
      expect(client.protoSettings).toStrictEqual(settings);
      expect(loadSyncSpy).toHaveBeenCalledTimes(1);
      expect(loadSyncSpy).toHaveBeenCalledWith(PROTO_FILE_PATHS, {
        keepCase: false,
        alternateCommentMode: false,
      });
    });

    test("passing proto instance should assign to overall client", () => {
      const root = new Protobuf.Root();

      client.configureProtos({ root });
      expect(client.getRoot()).toStrictEqual(root);
    });

    test("should throw when no root or proto files defined", () => {
      expect(() => client.configureProtos({})).toThrow(
        "Must define either a root protobuf object, or path to proto files"
      );
    });
  });

  describe("configureConversionOptions", () => {
    test("should assign conversion options for use in deserialization", () => {
      expect(client.protoConversionOptions).toEqual({
        longs: Number,
        enums: String,
        defaults: false,
        oneofs: true,
      });

      client.configureConversionOptions({ defaults: true });
      expect(client.protoConversionOptions).toEqual({ defaults: true });
    });
  });

  describe("getClient", () => {
    test("should return the existing client, or throw an error", () => {
      expect(client.getClient(request)).toBeInstanceOf(Client);

      client = new ProtoClient();
      expect(() => client.getClient(request)).toThrow(
        `ProtoClient is not yet configured`
      );

      client.configureClient({
        endpoint: {
          address: `0.0.0.0:9091`,
          match: "foo.bar.baz",
        },
      });
      expect(() => client.getClient(request)).toThrow(
        `Service method '${request.method}' has no configured endpoint`
      );
    });
  });

  describe("getRoot", () => {
    test("should return the proto root object, or throw an error", () => {
      expect(client.getRoot()).toBeInstanceOf(Protobuf.Root);

      client = new ProtoClient();
      expect(() => client.getRoot()).toThrow(
        `ProtoClient protos are not yet configured`
      );
    });
  });

  describe("abortRequests", () => {
    let abort1: AbortController;
    let abort2: AbortController;
    let abort3: AbortController;

    beforeEach(async () => {
      RESPONSE_DELAY = 50;
      abort1 = new AbortController();
      abort2 = new AbortController();
      abort3 = new AbortController();

      makeUnaryRequest({}, abort1);
      makeServerStreamRequest({}, async () => undefined, abort2);
      makeClientStreamRequest(async () => undefined, abort3);

      await wait(10);
    });
    afterEach(() => client.close());

    test("string matching", () => {
      client.abortRequests("customers.Customers.GetCustomer");
      expect(abort1.signal.aborted).toStrictEqual(true);
      expect(abort2.signal.aborted).toStrictEqual(false);
      expect(abort3.signal.aborted).toStrictEqual(false);
    });

    test("regex matching", () => {
      client.abortRequests(/\.EditCustomer$/);
      expect(abort1.signal.aborted).toStrictEqual(false);
      expect(abort2.signal.aborted).toStrictEqual(false);
      expect(abort3.signal.aborted).toStrictEqual(true);
    });

    test("function matching", () => {
      client.abortRequests(
        (method) => method === "customers.Customers.FindCustomers"
      );
      expect(abort1.signal.aborted).toStrictEqual(false);
      expect(abort2.signal.aborted).toStrictEqual(true);
      expect(abort3.signal.aborted).toStrictEqual(false);
    });
  });

  describe("close", () => {
    test("should abort all requests before closing the client", () => {
      const rpcClient = client.getClient(request);
      jest.spyOn(rpcClient, "close");
      jest.spyOn(client, "abortRequests");

      client.close();
      expect(client.abortRequests).toHaveBeenCalledTimes(1);
      expect(rpcClient.close).toHaveBeenCalledTimes(1);

      // rpcClient should be removed after closed, requiring a reconfigure
      expect(() => client.getClient(request)).toThrow(
        `ProtoClient is not yet configured`
      );
    });
  });

  describe("multiple endpoints", () => {
    test("should be able to connect to multiple servers with the same client", async () => {
      const server1 = await generateProtoServer({
        GetCustomer: serviceMethods.GetCustomer,
      });
      const server2 = await generateProtoServer({
        EditCustomer: serviceMethods.EditCustomer,
      });
      const server3 = await generateProtoServer({
        FindCustomers: serviceMethods.FindCustomers,
      });

      client = new ProtoClient({
        protoSettings: {
          files: PROTO_FILE_PATHS,
        },
        clientSettings: {
          endpoint: [
            {
              address: `0.0.0.0:${server1.port}`,
              match: `customers.Customers.GetCustomer`,
            },
            {
              address: `0.0.0.0:${server2.port}`,
              match: `customers.Customers.EditCustomer`,
            },
            {
              address: `0.0.0.0:${server3.port}`,
              match: `customers.Customers.FindCustomers`,
            },
          ],
        },
      });

      expect(
        await client.makeUnaryRequest("customers.Customers.GetCustomer")
      ).toBeInstanceOf(ProtoRequest);
      expect(
        await client.makeClientStreamRequest(
          "customers.Customers.EditCustomer",
          async (write) => {
            await write({ id: "github", name: "Github" });
          }
        )
      ).toBeInstanceOf(ProtoRequest);
      expect(
        await client.makeServerStreamRequest(
          "customers.Customers.FindCustomers",
          async () => undefined
        )
      ).toBeInstanceOf(ProtoRequest);
    });
  });
});
