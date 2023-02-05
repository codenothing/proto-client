import { sendUnaryData, ServerReadableStream, status } from "@grpc/grpc-js";
import { RequestError, ProtoRequest, StreamWriter } from "../src";
import {
  Customer,
  CustomersResponse,
  getClient,
  makeClientStreamRequest,
  startServer,
  wait,
} from "./utils";
import { MockServiceError } from "./MockServiceError";

describe("makeClientStreamRequest", () => {
  let RESPONSE_DELAY: number;
  let THROW_ERROR_RESPONSE: boolean;
  let activeRequest: ProtoRequest<Customer, CustomersResponse>;

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

    client.useMiddleware(async (req) => {
      activeRequest = req;
    });
  });

  test("should successfully request against the EditCustomer method", async () => {
    const request = await makeClientStreamRequest(async (write) => {
      await write({
        id: "github",
        name: "Github 2000",
      });

      await write({
        id: "npm",
        name: "NPM 2000",
      });
    });

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

  test("should ignore first try failure if the retry is successful", async () => {
    RESPONSE_DELAY = 1000;
    return new Promise<void>((resolve, reject) => {
      makeClientStreamRequest(
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
      )
        .then((request) => {
          try {
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
            resolve();
          } catch (e) {
            reject(e);
          }
        })
        .catch(reject);

      setTimeout(() => (RESPONSE_DELAY = 0), 100);
    });
  });

  test("should propogate write errors", async () => {
    await expect(
      makeClientStreamRequest(async () => {
        await wait(50);
        throw new Error(`Some Mock Write Sandbox Error`);
      })
    ).rejects.toThrow(`Some Mock Write Sandbox Error`);
  });

  test("should propogate invalid write data errors", async () => {
    await expect(
      makeClientStreamRequest(async (write) => {
        await wait(50);
        await write({ id: 1234 } as never);
      })
    ).rejects.toThrow(`id: string expected`);
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

  test("should propogate timeout errors", async () => {
    RESPONSE_DELAY = 1000;
    await expect(
      makeClientStreamRequest(
        async (write) => {
          await write({
            id: "github",
            name: "meow",
          });
        },
        { timeout: 100 }
      )
    ).rejects.toThrow(
      `makeClientStreamRequest for 'customers.Customers.EditCustomer' timed out`
    );
  });

  test("should handle service errors", async () => {
    THROW_ERROR_RESPONSE = true;
    await expect(
      makeClientStreamRequest(async (write) => {
        await write({
          id: "github",
          name: "meow",
        });
      })
    ).rejects.toThrow(`13 INTERNAL: Generic Service Error`);
  });

  test("should ignore aborted requests", async () => {
    RESPONSE_DELAY = 1000;
    return new Promise<void>((resolve, reject) => {
      const abortController = new AbortController();
      makeClientStreamRequest(async (write) => {
        await write({
          id: "github",
          name: "meow",
        });
      }, abortController)
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
      makeClientStreamRequest(async (write) => {
        await write({
          id: "github",
          name: "meow",
        });
      }, abortController)
        .then(() => reject(new Error(`Should not have a successul return`)))
        .catch((e) => {
          try {
            expect(e).toBeInstanceOf(RequestError);
            expect((e as RequestError).details).toStrictEqual(
              `Cancelled makeClientStreamRequest for 'customers.Customers.EditCustomer'`
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
