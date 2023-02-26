import { sendUnaryData, ServerReadableStream, status } from "@grpc/grpc-js";
import { StreamWriter } from "../src";
import {
  Customer,
  CustomersResponse,
  getClient,
  getClientStreamRequest,
  makeClientStreamRequest,
  startServer,
  wait,
} from "./utils";
import { MockServiceError } from "./MockServiceError";
import { Readable } from "stream";

describe("makeClientStreamRequest", () => {
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
      EditCustomer: (
        call: ServerReadableStream<Customer, CustomersResponse>,
        callback: sendUnaryData<CustomersResponse>
      ) => {
        if (THROW_ERROR_RESPONSE) {
          return callback(
            new MockServiceError(status.INTERNAL, "Generic Service Error")
          );
        }

        const customers: Customer[] = [];

        call.on("data", (row: Customer) => {
          if (!row || !row.id || !CUSTOMERS_HASH[row.id]) {
            return callback(new Error(`Customer ${row?.id} not found`), null);
          }

          CUSTOMERS_HASH[row.id].name = row.name;
          customers.push(CUSTOMERS_HASH[row.id]);
        });

        call.on("end", () => {
          if (call.cancelled || call.destroyed) {
            return;
          }

          const timerid = setTimeout(
            () => callback(null, { customers }),
            RESPONSE_DELAY
          );

          call.on("cancelled", () => {
            if (timerid) {
              clearTimeout(timerid);
            }
          });
        });
      },
    });
  });

  test("should successfully request against the EditCustomer method", async () => {
    const request = await makeClientStreamRequest(async (write, request) => {
      expect(request.isReadable).toStrictEqual(false);
      expect(request.isWritable).toStrictEqual(true);
      expect(request.isActive).toStrictEqual(true);

      await write({
        id: "github",
        name: "Github 2000",
      });

      await write({
        id: "npm",
        name: "NPM 2000",
      });
    });

    expect(request.isReadable).toStrictEqual(false);
    expect(request.isWritable).toStrictEqual(false);
    expect(request.isActive).toStrictEqual(false);

    expect(request.result).toEqual({
      customers: [
        {
          id: "github",
          name: "Github 2000",
        },
        {
          id: "npm",
          name: "NPM 2000",
        },
      ],
    });
  });

  test("should handle readable stream passed instead of writer sandbox", async () => {
    const { result } = await makeClientStreamRequest(
      Readable.from([
        { id: "github", name: "Github 2000" },
        { id: "npm", name: "NPM 2000" },
      ])
    );

    expect(result).toEqual({
      customers: [
        {
          id: "github",
          name: "Github 2000",
        },
        {
          id: "npm",
          name: "NPM 2000",
        },
      ],
    });
  });

  test("should handle no writer sandbox passed (no data sent to server)", async () => {
    const { result, error } = await makeClientStreamRequest();

    expect(result).toEqual({});
    expect(error).toBeUndefined();
  });

  test("should ignore first try failure if the retry is successful", async () => {
    RESPONSE_DELAY = 1000;
    const request = getClientStreamRequest(
      async (write) => {
        await write({
          id: "github",
          name: "Github 2000",
        });

        await write({
          id: "npm",
          name: "NPM 2000",
        });
      },
      { timeout: 200, retryOptions: true }
    );

    await wait(100);
    RESPONSE_DELAY = 0;

    await request.waitForEnd();
    expect(request.result).toEqual({
      customers: [
        {
          id: "github",
          name: "Github 2000",
        },
        {
          id: "npm",
          name: "NPM 2000",
        },
      ],
    });
    expect(request.error).toBeUndefined();
    expect(request.responseErrors).toEqual([
      expect.objectContaining({ code: status.DEADLINE_EXCEEDED }),
    ]);
  });

  test("should propagate write errors", async () => {
    const { error } = await makeClientStreamRequest(async () => {
      await wait(50);
      throw new Error(`Some Mock Write Sandbox Error`);
    });

    expect(error?.message).toStrictEqual(`Some Mock Write Sandbox Error`);
  });

  test("should propagate invalid write data errors", async () => {
    const { error } = await makeClientStreamRequest(async (write) => {
      await wait(50);
      await write({ id: 1234 } as never);
    });

    expect(error?.message).toStrictEqual(`id: string expected`);
  });

  test("should throw error when trying to write on a closed sandbox", async () => {
    let writer: StreamWriter<Customer> | undefined;

    await makeClientStreamRequest(async (write) => {
      writer = write;
      await write({
        id: "github",
        name: "Github 2000",
      });
    });

    await expect(
      (writer as StreamWriter<Customer>)({
        id: "npm",
        name: "NPM 2000",
      })
    ).rejects.toThrow(
      `The write stream has already closed for customers.Customers.EditCustomer`
    );
  });

  test("should propagate timeout errors", async () => {
    RESPONSE_DELAY = 1000;
    const { error } = await makeClientStreamRequest(
      async (write) => {
        await write({
          id: "github",
          name: "meow",
        });
      },
      { timeout: 100 }
    );

    expect(error?.message).toEqual(`4 DEADLINE_EXCEEDED: Deadline exceeded`);
  });

  test("should handle service errors", async () => {
    THROW_ERROR_RESPONSE = true;
    const { error } = await makeClientStreamRequest(async (write) => {
      await write({
        id: "github",
        name: "meow",
      });
    });

    expect(error?.message).toEqual(`13 INTERNAL: Generic Service Error`);
  });

  test("should ignore aborted requests", async () => {
    RESPONSE_DELAY = 1000;
    const abortController = new AbortController();
    const request = getClientStreamRequest(async (write) => {
      await write({
        id: "github",
        name: "meow",
      });
    }, abortController);

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
    const request = getClientStreamRequest(async (write) => {
      await write({
        id: "github",
        name: "meow",
      });
    }, abortController);

    await wait(100);
    abortController.abort();

    await expect(request.waitForEnd()).rejects.toThrow(
      `Cancelled makeClientStreamRequest for 'customers.Customers.EditCustomer'`
    );
  });
});
