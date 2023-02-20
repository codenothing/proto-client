import {
  ServerUnaryCall,
  sendUnaryData,
  ServerDuplexStream,
} from "@grpc/grpc-js";
import { ProtoClient, RequestMethodType } from "../src";
import {
  Customer,
  FindCustomersRequest,
  getClient,
  GetCustomerRequest,
  startServer,
} from "./utils";

describe("makeRequest", () => {
  let client: ProtoClient;

  beforeEach(async () => {
    await startServer({
      GetCustomer: (
        _call: ServerUnaryCall<GetCustomerRequest, Customer>,
        callback: sendUnaryData<Customer>
      ) => {
        callback(null, { id: "github", name: "Github" });
      },

      CreateCustomers: (call: ServerDuplexStream<Customer, Customer>) => {
        call.on("data", (row) => {
          call.write(row);
        });

        call.on("end", () => {
          call.end();
        });
      },
    });

    client = getClient();
  });

  test("should be able to make a request by method only", async () => {
    const { result } = await client.makeRequest<FindCustomersRequest, Customer>(
      "customers.Customers.GetCustomer"
    );

    expect(result).toStrictEqual({ id: "github", name: "Github" });
  });

  test("should be able to make a request by params only", async () => {
    const customers: Customer[] = [];
    await client.makeRequest<Customer, Customer>({
      method: "customers.Customers.CreateCustomers",
      writerSandbox: async (write) => {
        await write({ id: "github", name: "Github" });
        await write({ id: "npm", name: "NPM" });
      },
      streamReader: async (row) => {
        customers.push(row);
      },
    });

    expect(customers).toEqual([
      { id: "github", name: "Github" },
      { id: "npm", name: "NPM" },
    ]);
  });

  test("should only throw an error if attempting to safe guard method type", async () => {
    await expect(
      client.makeRequest({
        method: "customers.Customers.GetCustomer",
        requestMethodType: RequestMethodType.BidiStreamRequest,
      })
    ).rejects.toThrow(
      `makeBidiStreamRequest does not support method 'customers.Customers.GetCustomer', use makeUnaryRequest instead`
    );
  });
});
