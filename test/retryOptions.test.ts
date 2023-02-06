import { ServerUnaryCall, sendUnaryData, status } from "@grpc/grpc-js";
import { ProtoRequest } from "../src";
import {
  Customer,
  GetCustomerRequest,
  makeUnaryRequest,
  startServer,
} from "./utils";
import { MockServiceError } from "./MockServiceError";

describe("retryOptions", () => {
  let RESPONSE_DELAY: number;
  let THROW_ERROR: MockServiceError | undefined;
  let TOGGLE_THROWN_ERROR: boolean;
  let activeRequest: ProtoRequest<GetCustomerRequest, Customer>;

  beforeEach(async () => {
    THROW_ERROR = undefined;
    TOGGLE_THROWN_ERROR = false;
    RESPONSE_DELAY = 0;

    const { client } = await startServer({
      GetCustomer: (
        call: ServerUnaryCall<GetCustomerRequest, Customer>,
        callback: sendUnaryData<Customer>
      ) => {
        if (THROW_ERROR) {
          callback(THROW_ERROR);
          if (TOGGLE_THROWN_ERROR) {
            THROW_ERROR = undefined;
          }
        } else {
          const timerid = setTimeout(
            () => callback(null, { id: "github", name: "Github" }),
            RESPONSE_DELAY
          );
          call.on("cancelled", () => {
            if (timerid) {
              clearTimeout(timerid);
            }
          });
        }
      },
    });

    client.useMiddleware(async (req) => {
      activeRequest = req;
    });
  });

  test("should propagate timeout errors after all retries are exhausted", async () => {
    RESPONSE_DELAY = 2000;
    await expect(
      makeUnaryRequest(
        { id: "github" },
        { timeout: 100, retryOptions: { retryCount: 3 } }
      )
    ).rejects.toThrow(
      `makeUnaryRequest for 'customers.Customers.GetCustomer' timed out`
    );
    expect(activeRequest.responseErrors).toEqual([
      expect.objectContaining({ code: status.DEADLINE_EXCEEDED }),
      expect.objectContaining({ code: status.DEADLINE_EXCEEDED }),
      expect.objectContaining({ code: status.DEADLINE_EXCEEDED }),
      expect.objectContaining({ code: status.DEADLINE_EXCEEDED }),
    ]);
    expect(activeRequest.error).toStrictEqual(activeRequest.responseErrors[2]);
  });

  test("should ignore previous service error if next request is successful", async () => {
    THROW_ERROR = new MockServiceError(status.INTERNAL);
    TOGGLE_THROWN_ERROR = true;
    const request = await makeUnaryRequest(
      { id: "github" },
      { timeout: 500, retryOptions: { retryCount: 3 } }
    );
    expect(request.result).toEqual({
      id: "github",
      name: "Github",
    });
    expect(activeRequest.responseErrors).toEqual([
      expect.objectContaining({ code: status.INTERNAL }),
    ]);
    expect(activeRequest.error).toBeUndefined();
  });

  test("should successfully retry only on errors specified", async () => {
    TOGGLE_THROWN_ERROR = true;

    THROW_ERROR = new MockServiceError(status.INTERNAL);
    const request = await makeUnaryRequest(
      { id: "github" },
      { retryOptions: { retryCount: 3, status: [status.INTERNAL] } }
    );
    expect(request.result).toEqual({
      id: "github",
      name: "Github",
    });
    expect(request.responseErrors).toEqual([
      expect.objectContaining({ code: status.INTERNAL }),
    ]);

    THROW_ERROR = new MockServiceError(status.NOT_FOUND, `Generic Not Found`);
    await expect(
      makeUnaryRequest(
        { id: "github" },
        { retryOptions: { retryCount: 3, status: [status.INTERNAL] } }
      )
    ).rejects.toThrow(`5 NOT_FOUND: Generic Not Found`);
  });

  test("should support a single entry as the only retryable status", async () => {
    THROW_ERROR = new MockServiceError(status.INTERNAL);
    TOGGLE_THROWN_ERROR = true;
    const request = await makeUnaryRequest(
      { id: "github" },
      { timeout: 500, retryOptions: { retryCount: 3, status: status.INTERNAL } }
    );
    expect(request.result).toEqual({
      id: "github",
      name: "Github",
    });
    expect(activeRequest.responseErrors).toEqual([
      expect.objectContaining({ code: status.INTERNAL }),
    ]);
    expect(activeRequest.error).toBeUndefined();
  });

  test("should propagate the last service error after all retries are exhausted", async () => {
    THROW_ERROR = new MockServiceError(
      status.INTERNAL,
      `Generic Service Error`
    );
    await expect(
      makeUnaryRequest(
        { id: "github" },
        { timeout: 500, retryOptions: { retryCount: 3 } }
      )
    ).rejects.toThrow(`13 INTERNAL: Generic Service Error`);
    expect(activeRequest.responseErrors).toEqual([
      expect.objectContaining({ code: status.INTERNAL }),
      expect.objectContaining({ code: status.INTERNAL }),
      expect.objectContaining({ code: status.INTERNAL }),
      expect.objectContaining({ code: status.INTERNAL }),
    ]);
    expect(activeRequest.error).toStrictEqual(activeRequest.responseErrors[2]);
  });
});
