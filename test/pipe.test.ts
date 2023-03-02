import {
  sendUnaryData,
  ServerReadableStream,
  ServerWritableStream,
  status,
} from "@grpc/grpc-js";
import { EventEmitter, Readable } from "stream";
import { promisify } from "util";
import { ProtoClient } from "../src";
import { MockServiceError } from "./MockServiceError";
import {
  Customer,
  CustomersResponse,
  FindCustomersRequest,
  getClient,
  getServerStreamRequest,
  makeClientStreamRequest,
  startServer,
  wait,
} from "./utils";

describe("pipe", () => {
  let client: ProtoClient;
  let THROW_FIND_ERROR: MockServiceError | undefined;

  beforeEach(async () => {
    THROW_FIND_ERROR = undefined;

    await startServer({
      EditCustomer: (
        call: ServerReadableStream<Customer, CustomersResponse>,
        callback: sendUnaryData<CustomersResponse>
      ) => {
        const customers: Customer[] = [];
        call.on("data", (row: Customer) => {
          customers.push(row);
        });

        call.on("end", () => {
          callback(null, { customers });
        });
      },

      FindCustomers: async (
        call: ServerWritableStream<FindCustomersRequest, Customer>
      ) => {
        if (THROW_FIND_ERROR) {
          return call.destroy(THROW_FIND_ERROR);
        }

        const CUSTOMERS: Customer[] = [
          { id: "github", name: "Github" },
          { id: "npm", name: "NPM" },
          { id: "circleci", name: "CircleCI" },
        ];

        for (const customer of CUSTOMERS) {
          await promisify(call.write.bind(call))(customer);
        }

        call.end();
      },
    });

    client = getClient();
  });

  test("should handle readable stream passed instead of writer sandbox", async () => {
    const { result } = await client.makeRequest<Customer, CustomersResponse>({
      method: "customers.Customers.EditCustomer",
      pipeStream: Readable.from([
        { id: "github", name: "Github" },
        { id: "npm", name: "NPM" },
      ]),
    });

    expect(result).toEqual({
      customers: [
        {
          id: "github",
          name: "Github",
        },
        {
          id: "npm",
          name: "NPM",
        },
      ],
    });
  });

  test("should handle piping another client request", async () => {
    const readStreamRequest = getServerStreamRequest();
    const { result } = await makeClientStreamRequest(readStreamRequest);
    expect(result).toEqual({
      customers: [
        { id: "github", name: "Github" },
        { id: "npm", name: "NPM" },
        { id: "circleci", name: "CircleCI" },
      ],
    });
  });

  test("should handle piped errors from another client request", async () => {
    THROW_FIND_ERROR = new MockServiceError(
      status.INTERNAL,
      "Mock Find Customers Error"
    );
    const readStreamRequest = getServerStreamRequest();
    const { error, result } = await makeClientStreamRequest(readStreamRequest);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toEqual(`13 INTERNAL: Mock Find Customers Error`);
    expect(result).toBeUndefined();
  });

  test("should handle piped stream errors", async () => {
    const stream = new EventEmitter();
    const request = client.getRequest<Customer, CustomersResponse>({
      method: "customers.Customers.EditCustomer",
      pipeStream: stream,
    });

    request.on("error", () => undefined);
    stream.on("error", () => undefined);

    await wait();
    stream.emit("error", new Error("Mock Pipe Error"));

    await request.waitForEnd();
    expect(request.error?.message).toStrictEqual(`Mock Pipe Error`);
  });

  test("should handle unknown piped stream errors", async () => {
    const stream = new EventEmitter();
    const request = client.getRequest<Customer, CustomersResponse>({
      method: "customers.Customers.EditCustomer",
      pipeStream: stream,
    });

    await wait();
    stream.emit("error", "Mock Pipe String Error");

    await request.waitForEnd();
    expect(request.error?.message).toStrictEqual(`Pipe stream error`);
  });

  describe("transform", () => {
    test("should handle piping a transformed request to another client request", async () => {
      const readStreamRequest = getServerStreamRequest();
      const { result } = await makeClientStreamRequest(
        readStreamRequest.transform<Customer>(async (data) => {
          return { id: data.id, name: data.name?.toUpperCase() };
        })
      );
      expect(result).toEqual({
        customers: [
          { id: "github", name: "GITHUB" },
          { id: "npm", name: "NPM" },
          { id: "circleci", name: "CIRCLECI" },
        ],
      });
    });

    test("should handle a delay in transforming", async () => {
      const readStreamRequest = getServerStreamRequest();
      const { result } = await makeClientStreamRequest(
        readStreamRequest.transform<Customer>(async (data) => {
          await wait(5);
          return { id: data.id, name: data.name?.toUpperCase() };
        })
      );
      expect(result).toEqual({
        customers: [
          { id: "github", name: "GITHUB" },
          { id: "npm", name: "NPM" },
          { id: "circleci", name: "CIRCLECI" },
        ],
      });
    });

    test("should handle errors from the piped request", async () => {
      THROW_FIND_ERROR = new MockServiceError(
        status.INTERNAL,
        `Mock Piped Request Error`
      );
      const readStreamRequest = getServerStreamRequest();
      const { result, error } = await makeClientStreamRequest(
        readStreamRequest.transform<Customer>(async (data) => {
          await wait(5);
          return { id: data.id, name: data.name?.toUpperCase() };
        })
      );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toStrictEqual(
        `13 INTERNAL: Mock Piped Request Error`
      );
      expect(result).toBeUndefined();
    });

    test("should handle transform errors", async () => {
      const readStreamRequest = getServerStreamRequest();
      const { result, error } = await makeClientStreamRequest(
        readStreamRequest.transform(async () => {
          await wait(5);
          throw new Error(`Mock Transform Error`);
        })
      );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toStrictEqual(`Mock Transform Error`);
      expect(result).toBeUndefined();
    });

    test("should ignore all messages after a transform error", async () => {
      let firstTransform = true;
      const readStreamRequest = getServerStreamRequest();
      const { result, error } = await makeClientStreamRequest(
        readStreamRequest.transform(async (data) => {
          if (firstTransform) {
            firstTransform = false;
            await wait(10);
            throw new Error(`Mock Delayed Transform Error`);
          } else {
            await wait(20);
            return { id: data.id, name: data.name?.toUpperCase() };
          }
        })
      );
      // Wait for the delayed transforms to complete
      await wait(30);
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toStrictEqual(`Mock Delayed Transform Error`);
      expect(result).toBeUndefined();
    });
  });
});
