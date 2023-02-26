import { ServerUnaryCall, sendUnaryData, status } from "@grpc/grpc-js";
import {
  Customer,
  getClient,
  GetCustomerRequest,
  getUnaryRequest,
  makeUnaryRequest,
  startServer,
  wait,
} from "./utils";
import { MockServiceError } from "./MockServiceError";

describe("makeUnaryRequest", () => {
  let RESPONSE_DELAY: number;
  let THROW_ERROR_RESPONSE: boolean;

  beforeEach(async () => {
    THROW_ERROR_RESPONSE = false;
    RESPONSE_DELAY = 0;

    const CUSTOMERS: Customer[] = [
      { id: "github", name: "Github" },
      { id: "npm", name: "NPM" },
      { id: "jira", name: "JIRA" },
    ];
    const CUSTOMERS_HASH: { [id: string]: Customer } = {};

    CUSTOMERS.forEach(
      (customer) => (CUSTOMERS_HASH[customer.id as string] = customer)
    );

    await startServer({
      GetCustomer: (
        call: ServerUnaryCall<GetCustomerRequest, Customer>,
        callback: sendUnaryData<Customer>
      ) => {
        if (THROW_ERROR_RESPONSE) {
          callback(
            new MockServiceError(status.INTERNAL, "Generic Service Error")
          );
        } else if (!call.request.id) {
          callback(null, CUSTOMERS_HASH.github);
        } else if (CUSTOMERS_HASH[call.request.id]) {
          const customer = CUSTOMERS_HASH[call.request.id];
          const timerid = setTimeout(
            () => callback(null, customer),
            RESPONSE_DELAY
          );
          call.on("cancelled", () => {
            if (timerid) {
              clearTimeout(timerid);
            }
          });
        } else {
          callback(new Error("Customer Not Found"));
        }
      },
    });
  });

  test("should successfully request against the GetCustomer method", async () => {
    const request = await makeUnaryRequest({
      id: "github",
    });

    expect(request.result).toEqual({
      id: "github",
      name: "Github",
    });
  });

  test("should support no data passed", async () => {
    const request = await makeUnaryRequest();

    expect(request.result).toEqual({
      id: "github",
      name: "Github",
    });
  });

  test("should ignore first try failure if the retry is successful", async () => {
    RESPONSE_DELAY = 1000;
    const request = getUnaryRequest(
      { id: "github" },
      { timeout: 200, retryOptions: true }
    );

    await wait(100);
    RESPONSE_DELAY = 0;

    await request.waitForEnd();
    expect(request.result).toEqual({
      id: "github",
      name: "Github",
    });
    expect(request.error).toBeUndefined();
    expect(request.responseErrors).toEqual([
      expect.objectContaining({ code: status.DEADLINE_EXCEEDED }),
    ]);
  });

  test("should throw when passing invalid data", async () => {
    const { error } = await makeUnaryRequest({ id: 1234 } as never, {
      timeout: 100,
    });

    expect(error?.message).toStrictEqual(`id: string expected`);
  });

  test("should propagate timeout errors", async () => {
    RESPONSE_DELAY = 1000;
    const { error } = await makeUnaryRequest(
      { id: "github" },
      { timeout: 100 }
    );

    expect(error?.message).toStrictEqual(
      `4 DEADLINE_EXCEEDED: Deadline exceeded`
    );
  });

  test("should handle service errors", async () => {
    THROW_ERROR_RESPONSE = true;
    const { error } = await makeUnaryRequest({ id: "github" });

    expect(error?.message).toStrictEqual(`13 INTERNAL: Generic Service Error`);
  });

  test("should ignore aborted requests", async () => {
    RESPONSE_DELAY = 1000;
    const abortController = new AbortController();
    const request = getUnaryRequest({ id: "github" }, abortController);

    return new Promise<void>((resolve, reject) => {
      request
        .waitForEnd()
        .then(() => reject(new Error(`Should not have a successful return`)))
        .catch(() => reject(new Error(`Should not reject`)));

      setTimeout(() => {
        request.on("aborted", () => resolve());
        abortController.abort();
      }, 100);
    });
  });

  test("should propagate aborted error when configured too", async () => {
    RESPONSE_DELAY = 1000;
    getClient().clientSettings.rejectOnAbort = true;

    const abortController = new AbortController();
    const request = getUnaryRequest({ id: "github" }, abortController);

    await wait(100);
    abortController.abort();

    await expect(request.waitForEnd()).rejects.toThrow(
      `Cancelled makeUnaryRequest for 'customers.Customers.GetCustomer'`
    );
  });
});
