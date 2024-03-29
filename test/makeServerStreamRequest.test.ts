import { ServerWritableStream, status } from "@grpc/grpc-js";
import { promisify } from "util";
import {
  Customer,
  FindCustomersRequest,
  getClient,
  getServerStreamRequest,
  makeServerStreamRequest,
  startServer,
  wait,
} from "./utils";
import { MockServiceError } from "./MockServiceError";

describe("makeServerStreamRequest", () => {
  let RESPONSE_DELAY: number;
  let THROW_ERROR_RESPONSE: boolean;
  let TOGGLE_THROWN_ERROR: boolean;

  beforeEach(async () => {
    THROW_ERROR_RESPONSE = false;
    TOGGLE_THROWN_ERROR = false;
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
      FindCustomers: (
        call: ServerWritableStream<FindCustomersRequest, Customer>
      ) => {
        if (THROW_ERROR_RESPONSE) {
          if (TOGGLE_THROWN_ERROR) {
            THROW_ERROR_RESPONSE = !THROW_ERROR_RESPONSE;
          }
          return call.destroy(
            new MockServiceError(status.INTERNAL, "Generic Service Error")
          );
        }

        const timerid = setTimeout(async () => {
          for (const customer of CUSTOMERS) {
            await promisify(call.write.bind(call))(customer);
          }

          call.end();
        }, RESPONSE_DELAY);

        call.on("cancelled", () => {
          if (timerid) {
            clearTimeout(timerid);
          }
        });
      },
    });
  });

  test("should successfully request against the FindCustomers method", async () => {
    const customers: Customer[] = [];

    const request = await makeServerStreamRequest(
      async (row, _index, request) => {
        expect(request.isReadable).toStrictEqual(true);
        expect(request.isWritable).toStrictEqual(false);
        expect(request.isActive).toStrictEqual(true);

        customers.push(row);
      }
    );

    expect(request.isReadable).toStrictEqual(false);
    expect(request.isWritable).toStrictEqual(false);
    expect(request.isActive).toStrictEqual(false);

    expect(customers).toEqual([
      {
        id: "github",
        name: "Github",
      },
      {
        id: "npm",
        name: "NPM",
      },
      {
        id: "jira",
        name: "JIRA",
      },
    ]);
  });

  test("should support empty data parameter", async () => {
    const customers: Customer[] = [];

    await makeServerStreamRequest(undefined as never, async (row) => {
      customers.push(row);
    });

    expect(customers).toEqual([
      {
        id: "github",
        name: "Github",
      },
      {
        id: "npm",
        name: "NPM",
      },
      {
        id: "jira",
        name: "JIRA",
      },
    ]);
  });

  test("should support not passing a stream reader", async () => {
    const customers: Customer[] = [];

    const request = getClient().getServerStreamRequest<Customer>(
      "customers.Customers.FindCustomers"
    );
    request.on("data", (row) => {
      customers.push(row);
    });
    await request.waitForEnd();

    expect(customers).toEqual([
      {
        id: "github",
        name: "Github",
      },
      {
        id: "npm",
        name: "NPM",
      },
      {
        id: "jira",
        name: "JIRA",
      },
    ]);
  });

  test("should wait for all read processing to complete before resolving promise", async () => {
    const customers: Customer[] = [];

    await makeServerStreamRequest(async (row) => {
      await wait(15);
      customers.push(row);
    });

    expect(customers).toEqual([
      {
        id: "github",
        name: "Github",
      },
      {
        id: "npm",
        name: "NPM",
      },
      {
        id: "jira",
        name: "JIRA",
      },
    ]);
  });

  test("should ignore first try failure if the retry is successful", async () => {
    RESPONSE_DELAY = 1000;
    const customers: Customer[] = [];
    const request = getServerStreamRequest(
      {},
      async (row) => {
        customers.push(row);
      },
      { timeout: 200, retryOptions: true }
    );

    await wait(100);
    RESPONSE_DELAY = 0;

    await request.waitForEnd();
    expect(customers).toEqual([
      {
        id: "github",
        name: "Github",
      },
      {
        id: "npm",
        name: "NPM",
      },
      {
        id: "jira",
        name: "JIRA",
      },
    ]);
    expect(request.error).toBeUndefined();
    expect(request.responseErrors).toEqual([
      expect.objectContaining({ code: status.DEADLINE_EXCEEDED }),
    ]);
  });

  test("should propagate validation errors", async () => {
    const { error } = await makeServerStreamRequest(
      { name: 1234 } as never,
      async () => {
        throw new Error(`Should not get to streamReader`);
      }
    );

    expect(error?.message).toEqual(`name: string expected`);
  });

  test("should propagate read processing errors", async () => {
    const { error } = await makeServerStreamRequest(async () => {
      throw new Error(`Mock Read Processing Error`);
    });

    expect(error?.message).toEqual(`Mock Read Processing Error`);
  });

  test("should propagate timeout errors", async () => {
    RESPONSE_DELAY = 1000;
    const { error } = await makeServerStreamRequest(
      {},
      async () => {
        throw new Error(`Should not get to streamReader`);
      },
      { timeout: 100 }
    );

    expect(error?.message).toEqual(`4 DEADLINE_EXCEEDED: Deadline exceeded`);
  });

  test("should handle service errors", async () => {
    THROW_ERROR_RESPONSE = true;

    const { error } = await makeServerStreamRequest(async () => {
      throw new Error(`Should not get to streamReader`);
    });

    expect(error?.message).toEqual(`13 INTERNAL: Generic Service Error`);
  });

  test("should ignore aborted requests", async () => {
    RESPONSE_DELAY = 1000;
    const abortController = new AbortController();
    const request = getServerStreamRequest(
      {},
      async () => {
        throw new Error(`Should not get to streamReader`);
      },
      abortController
    );

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
    const request = getServerStreamRequest(
      {},
      async () => {
        throw new Error(`Should not get to streamReader`);
      },
      abortController
    );

    await wait(100);
    abortController.abort();

    await expect(request.waitForEnd()).rejects.toThrow(
      `Cancelled makeServerStreamRequest for 'customers.Customers.FindCustomers'`
    );
  });
});
