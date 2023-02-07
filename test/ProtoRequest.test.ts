import { ServerUnaryCall, sendUnaryData } from "@grpc/grpc-js";
import {
  startServer,
  GetCustomerRequest,
  Customer,
  makeUnaryRequest,
  getClient,
} from "./utils";

describe("ProtoRequest", () => {
  beforeEach(async () => {
    await startServer({
      GetCustomer: (
        _call: ServerUnaryCall<GetCustomerRequest, Customer>,
        callback: sendUnaryData<Customer>
      ) => {
        callback(null, { id: "github", name: "Github" });
      },
    });
  });

  test("should throw an error when attempting to request from a service that does not exist", async () => {
    await expect(
      getClient().makeUnaryRequest("foo.bar.not.here", {})
    ).rejects.toThrow(`no such Service 'foo.bar.not' in Root`);
  });

  test("should throw an error when attempting to request from a method that does not exist on the service", async () => {
    await expect(
      getClient().makeUnaryRequest("customers.Customers.NotHere", {})
    ).rejects.toThrow(`Method NotHere not found on customers.Customers`);
  });

  test("should throw an error if attempting to request a method with an incorrect type", async () => {
    await expect(
      getClient().makeServerStreamRequest(
        "customers.Customers.GetCustomer",
        async () => undefined
      )
    ).rejects.toThrow(
      `makeServerStreamRequest does not support method 'customers.Customers.GetCustomer', use makeUnaryRequest instead`
    );
  });

  test("should lock request instance so that it can only run once", async () => {
    const request = await makeUnaryRequest();

    await expect(request.makeUnaryRequest()).rejects.toThrow(
      `makeUnaryRequest for 'customers.Customers.GetCustomer' has already begun. Only make requests from the client, not the request instance`
    );
  });
});
