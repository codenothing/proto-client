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

  test("should ignore extra events emitted from piped stream once request is completed", async () => {
    const stream = new EventEmitter();
    const request = client.getRequest<Customer, CustomersResponse>({
      method: "customers.Customers.EditCustomer",
      pipeStream: stream,
    });

    await wait();
    stream.emit("data", { id: "github", name: "Github" });
    await wait();
    stream.emit("end");

    await request.waitForEnd();
    expect(request.error).toBeUndefined();
    expect(request.result).toEqual({
      customers: [{ id: "github", name: "Github" }],
    });

    // Emitting more data should be ignored
    stream.emit("data", { id: "npm", name: "NPM" });
    await request.waitForEnd();
    expect(request.error).toBeUndefined();
    expect(request.result).toEqual({
      customers: [{ id: "github", name: "Github" }],
    });

    // Emitting an error should be ignored
    stream.emit("error", new Error(`Mock Pipe Error`));
    await request.waitForEnd();
    expect(request.error).toBeUndefined();
    expect(request.result).toEqual({
      customers: [{ id: "github", name: "Github" }],
    });

    // Emitting end event again should be ignored
    stream.emit("end");
    await request.waitForEnd();
    expect(request.error).toBeUndefined();
    expect(request.result).toEqual({
      customers: [{ id: "github", name: "Github" }],
    });
  });
});
