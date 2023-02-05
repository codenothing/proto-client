import { ServerUnaryCall, sendUnaryData, status } from "@grpc/grpc-js";
import { RequestError, ProtoRequest } from "../src";
import {
  Customer,
  getClient,
  GetCustomerRequest,
  makeUnaryRequest,
  startServer,
} from "./utils";
import { MockServiceError } from "./MockServiceError";

describe("makeUnaryRequest", () => {
  let RESPONSE_DELAY: number;
  let THROW_ERROR_RESPONSE: boolean;
  let activeRequest: ProtoRequest<GetCustomerRequest, Customer>;

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

    const { client } = await startServer({
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

    client.useMiddleware(async (req) => {
      activeRequest = req;
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
    return new Promise<void>((resolve, reject) => {
      makeUnaryRequest({ id: "github" }, { timeout: 200, retryOptions: true })
        .then((request) => {
          try {
            expect(request.result).toEqual({
              id: "github",
              name: "Github",
            });
            expect(request.error).toBeUndefined();
            expect(request.responseErrors).toEqual([
              expect.objectContaining({ code: status.DEADLINE_EXCEEDED }),
            ]);
            resolve();
          } catch (e) {
            reject(e);
          }
        })
        .catch(reject);

      setTimeout(() => (RESPONSE_DELAY = 0), 100);
    });
  });

  test("should throw when passing invalid data", async () => {
    await expect(
      makeUnaryRequest({ id: 1234 } as never, { timeout: 100 })
    ).rejects.toThrow(`id: string expected`);
  });

  test("should propogate timeout errors", async () => {
    RESPONSE_DELAY = 1000;
    await expect(
      makeUnaryRequest({ id: "github" }, { timeout: 100 })
    ).rejects.toThrow(
      `makeUnaryRequest for 'customers.Customers.GetCustomer' timed out`
    );
  });

  test("should handle service errors", async () => {
    THROW_ERROR_RESPONSE = true;
    await expect(makeUnaryRequest({ id: "github" })).rejects.toThrow(
      `13 INTERNAL: Generic Service Error`
    );
  });

  test("should ignore aborted requests", async () => {
    RESPONSE_DELAY = 1000;
    return new Promise<void>((resolve, reject) => {
      const abortController = new AbortController();
      makeUnaryRequest({ id: "github" }, abortController)
        .then(() => reject(new Error(`Should not have a successul return`)))
        .catch(() => reject(new Error(`Should not reject`)));

      setTimeout(() => {
        activeRequest.on("aborted", () => resolve());
        abortController.abort();
      }, 100);
    });
  });

  test("should propogate aborted error when configured too", async () => {
    RESPONSE_DELAY = 1000;
    getClient().clientSettings.rejectOnAbort = true;
    return new Promise<void>((resolve, reject) => {
      const abortController = new AbortController();
      makeUnaryRequest({ id: "github" }, abortController)
        .then(() => reject(new Error(`Should not have a successul return`)))
        .catch((e) => {
          try {
            expect(e).toBeInstanceOf(RequestError);
            expect((e as RequestError).details).toStrictEqual(
              `Cancelled makeUnaryRequest for 'customers.Customers.GetCustomer'`
            );
            resolve();
          } catch (matchError) {
            reject(matchError);
          }
        });

      setTimeout(() => abortController.abort(), 100);
    });
  });
});
