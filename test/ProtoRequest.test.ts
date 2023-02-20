import { ServerUnaryCall, sendUnaryData, status } from "@grpc/grpc-js";
import {
  startServer,
  GetCustomerRequest,
  Customer,
  getClient,
  getUnaryRequest,
  wait,
  makeUnaryRequest,
} from "./utils";
import { MockServiceError } from "./MockServiceError";
import { ProtoClient, ProtoRequest } from "../src";

describe("ProtoRequest", () => {
  let client: ProtoClient;
  let RESPONSE_DELAY: number;
  let THROW_ERROR: MockServiceError | undefined;
  let methodTimerId: NodeJS.Timeout | undefined;

  beforeEach(async () => {
    RESPONSE_DELAY = 0;
    THROW_ERROR = undefined;
    methodTimerId = undefined;

    await startServer({
      GetCustomer: (
        _call: ServerUnaryCall<GetCustomerRequest, Customer>,
        callback: sendUnaryData<Customer>
      ) => {
        methodTimerId = setTimeout(() => {
          methodTimerId = undefined;
          if (THROW_ERROR) {
            callback(THROW_ERROR);
          } else {
            callback(null, { id: "github", name: "Github" });
          }
        }, RESPONSE_DELAY);
      },
    });

    client = getClient();
  });

  afterEach(() => {
    if (methodTimerId) {
      clearTimeout(methodTimerId);
    }
  });

  test("should queue up multiple run requests", async () => {
    const request = getUnaryRequest();

    const results = await Promise.all([
      request.waitForEnd(),
      request.waitForEnd(),
      request.waitForEnd(),
    ]);

    expect(results.map((req) => req.result)).toEqual([
      { id: "github", name: "Github" },
      { id: "github", name: "Github" },
      { id: "github", name: "Github" },
    ]);

    // Triggering run again should return the current request
    expect(await request.waitForEnd()).toStrictEqual(request);
  });

  test("should rethrow errors when running the same request", async () => {
    THROW_ERROR = new MockServiceError(
      status.INTERNAL,
      "Generic Service Error"
    );

    client.clientSettings.rejectOnError = true;
    const request = getUnaryRequest();

    // Wait for initial response to return
    await expect(request.waitForEnd()).rejects.toThrow(
      `${status.INTERNAL} INTERNAL: Generic Service Error`
    );

    // Running the same request should throw again
    await expect(request.waitForEnd()).rejects.toThrow(
      `${status.INTERNAL} INTERNAL: Generic Service Error`
    );
  });

  test("should throw an error when attempting to request from a service that does not exist", async () => {
    await expect(
      client.makeUnaryRequest("foo.bar.not.here", {})
    ).rejects.toThrow(`no such Service 'foo.bar.not' in Root`);
  });

  test("should throw an error when attempting to request from a method that does not exist on the service", async () => {
    await expect(
      client.makeUnaryRequest("customers.Customers.NotHere", {})
    ).rejects.toThrow(`Method NotHere not found on customers.Customers`);
  });

  test("should throw an error if attempting to request a method with an incorrect type", async () => {
    await expect(
      client.makeServerStreamRequest(
        "customers.Customers.GetCustomer",
        async () => undefined
      )
    ).rejects.toThrow(
      `makeServerStreamRequest does not support method 'customers.Customers.GetCustomer', use makeUnaryRequest instead`
    );
  });

  describe("Queued Errors", () => {
    let request: ProtoRequest<GetCustomerRequest, Customer>;

    beforeEach(async () => {
      THROW_ERROR = new MockServiceError(
        status.INTERNAL,
        "Mock Internal Error"
      );
      RESPONSE_DELAY = 100;
      request = getUnaryRequest();
      await wait(25);
    });

    test("should resolve without throwing by default", async () => {
      await request.waitForEnd();
      expect(request.error?.message).toStrictEqual(
        `13 INTERNAL: Mock Internal Error`
      );
    });

    test("should resolve without throwing when rejectOnError is disabled", async () => {
      client.clientSettings.rejectOnError = false;
      await request.waitForEnd();
      expect(request.error?.message).toStrictEqual(
        `13 INTERNAL: Mock Internal Error`
      );
    });

    test("should throw error when rejectOnError is enabled", async () => {
      client.clientSettings.rejectOnError = true;
      await expect(request.waitForEnd()).rejects.toThrow(
        `13 INTERNAL: Mock Internal Error`
      );
    });

    test("should not resolve when rejectOnAbort is not enabled", async () => {
      return new Promise<void>((resolve, reject) => {
        request
          .waitForEnd()
          .then(() =>
            reject("should not resolve when rejectOnAbort is disabled")
          )
          .catch(() =>
            reject("should not resolve when rejectOnAbort is disabled")
          );

        request.on("aborted", () => {
          setTimeout(() => resolve(), 50);
        });
        request.abortController.abort();
      });
    });

    test("should throw error when rejectOnAbort is enabled", async () => {
      client.clientSettings.rejectOnAbort = true;

      return new Promise<void>((resolve, reject) => {
        request
          .waitForEnd()
          .then(() =>
            reject("should not resolve when rejectOnAbort is enabled")
          )
          .catch((e) => {
            try {
              expect(e).toBeInstanceOf(Error);
              expect((e as Error).message).toStrictEqual(
                `Cancelled makeUnaryRequest for 'customers.Customers.GetCustomer'`
              );
              resolve();
            } catch (testError) {
              reject(testError);
            }
          });

        request.on("aborted", () => {
          setTimeout(
            () =>
              reject(
                `should have already resolved by the time aborted event is called`
              ),
            50
          );
        });
        request.abortController.abort();
      });
    });
  });

  describe("Resolved Errors", () => {
    let request: ProtoRequest<GetCustomerRequest, Customer>;

    beforeEach(async () => {
      THROW_ERROR = new MockServiceError(
        status.INTERNAL,
        "Mock Internal Error"
      );
      request = await makeUnaryRequest();
    });

    test("should return immediately without throwing by default", async () => {
      await request.waitForEnd();
      expect(request.error?.message).toStrictEqual(
        `13 INTERNAL: Mock Internal Error`
      );
    });

    test("should return immediately without throwing when rejectOnError is disabled", async () => {
      client.clientSettings.rejectOnError = false;
      await request.waitForEnd();
      expect(request.error?.message).toStrictEqual(
        `13 INTERNAL: Mock Internal Error`
      );
    });

    test("should throw error immediately when rejectOnError is enabled", async () => {
      client.clientSettings.rejectOnError = true;
      await expect(request.waitForEnd()).rejects.toThrow(
        `13 INTERNAL: Mock Internal Error`
      );
    });

    test("should not return when rejectOnAbort is not enabled", async () => {
      RESPONSE_DELAY = 100;
      request = getUnaryRequest();
      await wait(50);
      request.abortController.abort();
      return new Promise<void>((resolve, reject) => {
        request
          .waitForEnd()
          .then(() =>
            reject("should not resolve when rejectOnAbort is disabled")
          )
          .catch(() =>
            reject("should not resolve when rejectOnAbort is disabled")
          );

        setTimeout(() => {
          if (request.isActive) {
            reject("request is still active, can not confirm abort worked");
          } else {
            resolve();
          }
        }, 75);
      });
    });

    test("should throw error immediately when rejectOnAbort is enabled", async () => {
      client.clientSettings.rejectOnAbort = true;
      RESPONSE_DELAY = 100;
      request = getUnaryRequest();
      await wait(50);
      request.abortController.abort();
      await wait(25);

      expect(request.isActive).toStrictEqual(false);
      await expect(request.waitForEnd()).rejects.toThrow(
        `Cancelled makeUnaryRequest for 'customers.Customers.GetCustomer'`
      );
    });
  });
});
