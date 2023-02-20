import { ServerUnaryCall, sendUnaryData } from "@grpc/grpc-js";
import { ProtoRequest } from "../src";
import {
  Customer,
  GetCustomerRequest,
  makeUnaryRequest,
  startServer,
} from "./utils";

describe("metadata", () => {
  let activeRequest: ProtoRequest<GetCustomerRequest, Customer>;
  let thrownEntity: Error | string | object | undefined;

  beforeEach(async () => {
    thrownEntity = undefined;

    const { client } = await startServer({
      GetCustomer: (
        call: ServerUnaryCall<GetCustomerRequest, Customer>,
        callback: sendUnaryData<Customer>
      ) => {
        if (call.request && call.request.id === "github") {
          callback(null, { id: "github", name: "Github" });
        } else {
          callback(new Error(`Customer Not Found`));
        }
      },
    });

    client.useMiddleware(async (req) => {
      activeRequest = req;

      const token = req.metadata.get("auth_token")[0];

      // Auto add auth_token to the metadata if not set
      if (!token) {
        req.metadata.set("auth_token", "foobar");
      }

      if (thrownEntity !== undefined) {
        throw thrownEntity;
      }
    });
  });

  test("should verify auth token gets auto added by middleware", async () => {
    const request = await makeUnaryRequest({ id: "github" });
    expect(request.metadata.get("auth_token")).toEqual(["foobar"]);
    expect(request).toStrictEqual(activeRequest);
  });

  test("should fail the request if an error is thrown in the middleware", async () => {
    thrownEntity = new Error(`Mock Middleware Error`);

    const { error } = await makeUnaryRequest({ id: "github" });
    expect(error?.message).toStrictEqual(`Mock Middleware Error`);
  });

  test("should fail the request if a string is thrown in the middleware", async () => {
    thrownEntity = `Mock String Middleware Error`;

    const { error } = await makeUnaryRequest({ id: "github" });
    expect(error?.message).toStrictEqual(`Mock String Middleware Error`);
  });

  test("should fail the request anything is thrown in the middleware", async () => {
    thrownEntity = { custom: "Some Custom Thrown Object" };

    const { error } = await makeUnaryRequest({ id: "github" });
    expect(error?.message).toStrictEqual(`Unknown Middleware Error`);
  });
});
