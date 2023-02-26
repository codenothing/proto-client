import { ServerUnaryCall, sendUnaryData, status } from "@grpc/grpc-js";
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

  beforeEach(async () => {
    THROW_ERROR = undefined;
    TOGGLE_THROWN_ERROR = false;
    RESPONSE_DELAY = 0;

    await startServer({
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
  });

  test("should propagate timeout errors after all retries are exhausted", async () => {
    RESPONSE_DELAY = 2000;
    const request = await makeUnaryRequest(
      { id: "github" },
      { timeout: 100, retryOptions: { retryCount: 3 } }
    );

    expect(request.error?.message).toEqual(
      `4 DEADLINE_EXCEEDED: Deadline exceeded`
    );
    expect(request.responseErrors).toEqual([
      expect.objectContaining({ code: status.DEADLINE_EXCEEDED }),
      expect.objectContaining({ code: status.DEADLINE_EXCEEDED }),
      expect.objectContaining({ code: status.DEADLINE_EXCEEDED }),
      expect.objectContaining({ code: status.DEADLINE_EXCEEDED }),
    ]);
    expect(request.error).toStrictEqual(request.responseErrors[2]);
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
    expect(request.responseErrors).toEqual([
      expect.objectContaining({ code: status.INTERNAL }),
    ]);
    expect(request.error).toBeUndefined();
  });

  test("should successfully retry only on errors specified", async () => {
    TOGGLE_THROWN_ERROR = true;

    THROW_ERROR = new MockServiceError(status.INTERNAL);
    const request1 = await makeUnaryRequest(
      { id: "github" },
      { retryOptions: { retryCount: 3, status: [status.INTERNAL] } }
    );
    expect(request1.result).toEqual({
      id: "github",
      name: "Github",
    });
    expect(request1.responseErrors).toEqual([
      expect.objectContaining({ code: status.INTERNAL }),
    ]);

    THROW_ERROR = new MockServiceError(status.NOT_FOUND, `Generic Not Found`);
    const { error } = await makeUnaryRequest(
      { id: "github" },
      { retryOptions: { retryCount: 3, status: [status.INTERNAL] } }
    );
    expect(error?.message).toEqual(`5 NOT_FOUND: Generic Not Found`);
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
    expect(request.responseErrors).toEqual([
      expect.objectContaining({ code: status.INTERNAL }),
    ]);
    expect(request.error).toBeUndefined();
  });

  test("should propagate the last service error after all retries are exhausted", async () => {
    THROW_ERROR = new MockServiceError(
      status.INTERNAL,
      `Generic Service Error`
    );
    const request = await makeUnaryRequest(
      { id: "github" },
      { timeout: 500, retryOptions: { retryCount: 3 } }
    );
    expect(request.error?.message).toEqual(
      `13 INTERNAL: Generic Service Error`
    );
    expect(request.responseErrors).toEqual([
      expect.objectContaining({ code: status.INTERNAL }),
      expect.objectContaining({ code: status.INTERNAL }),
      expect.objectContaining({ code: status.INTERNAL }),
      expect.objectContaining({ code: status.INTERNAL }),
    ]);
    expect(request.error).toStrictEqual(request.responseErrors[2]);
  });
});
