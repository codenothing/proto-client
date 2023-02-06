import { ServerDuplexStream, status } from "@grpc/grpc-js";
import { RequestError, ProtoRequest, StreamWriter } from "../src";
import { promisify } from "util";
import {
  Customer,
  getClient,
  makeBidiStreamRequest,
  startServer,
  wait,
} from "./utils";
import { MockServiceError } from "./MockServiceError";

describe("makeBidiStreamRequest", () => {
  let RESPONSE_DELAY: number;
  let THROW_ERROR_RESPONSE: boolean;
  let activeRequest: ProtoRequest<Customer, Customer>;

  beforeEach(async () => {
    THROW_ERROR_RESPONSE = false;

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
      CreateCustomers: (call: ServerDuplexStream<Customer, Customer>) => {
        if (THROW_ERROR_RESPONSE) {
          return call.destroy(
            new MockServiceError(status.INTERNAL, "Generic Service Error")
          );
        }

        const writeBackRows: Customer[] = [];
        call.on("data", (row: Customer) => {
          if (!row || !row.id) {
            return call.destroy(new Error("Customer Not Found"));
          }

          CUSTOMERS_HASH[row.id] = row;
          CUSTOMERS.push(row);
          writeBackRows.push(row);
        });

        call.on("end", () => {
          const timerid = setTimeout(async () => {
            for (const row of writeBackRows) {
              await promisify(call.write.bind(call))(row);
            }

            call.end();
          }, RESPONSE_DELAY);

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

  test("should successfully request against the CreateCustomers method", async () => {
    const customers: Customer[] = [
      {
        id: "circleci",
        name: "CircleCI",
      },
      {
        id: "vscode",
        name: "VSCode",
      },
    ];
    const readCustomers: Customer[] = [];

    await makeBidiStreamRequest(
      async (write) => {
        await write(customers[0]);
        await write(customers[1]);
      },
      async (row) => {
        readCustomers.push(row);
      }
    );

    expect(readCustomers).toEqual([
      {
        id: "circleci",
        name: "CircleCI",
      },
      {
        id: "vscode",
        name: "VSCode",
      },
    ]);
  });

  test("should wait for both read and write processing to complete before resolving the promise", async () => {
    const customers: Customer[] = [
      {
        id: "circleci",
        name: "CircleCI",
      },
      {
        id: "vscode",
        name: "VSCode",
      },
    ];
    const readCustomers: Customer[] = [];

    await makeBidiStreamRequest(
      async (write) => {
        await wait(15);
        await write(customers[0]);
        await wait(15);
        await write(customers[1]);
      },
      async (row) => {
        await wait(15);
        readCustomers.push(row);
      }
    );

    expect(readCustomers).toEqual([
      {
        id: "circleci",
        name: "CircleCI",
      },
      {
        id: "vscode",
        name: "VSCode",
      },
    ]);
  });

  test("should ignore first try failure if the retry is successful", async () => {
    RESPONSE_DELAY = 1000;
    return new Promise<void>((resolve, reject) => {
      const customers: Customer[] = [
        {
          id: "circleci",
          name: "CircleCI",
        },
        {
          id: "vscode",
          name: "VSCode",
        },
      ];
      const readCustomers: Customer[] = [];

      makeBidiStreamRequest(
        async (write) => {
          await write(customers[0]);
          await write(customers[1]);
        },
        async (row) => {
          readCustomers.push(row);
        },
        { timeout: 200, retryOptions: true }
      )
        .then((request) => {
          try {
            expect(readCustomers).toEqual([
              {
                id: "circleci",
                name: "CircleCI",
              },
              {
                id: "vscode",
                name: "VSCode",
              },
            ]);
            expect(request.error).toBeUndefined();
            expect(request.responseErrors).toEqual([
              expect.objectContaining({ code: status.DEADLINE_EXCEEDED }),
            ]);
            resolve();
          } catch (e) {
            reject(e);
          }
        })
        .catch((e) => {
          reject(e);
        });

      setTimeout(() => (RESPONSE_DELAY = 0), 100);
    });
  });

  test("should propagate write sandbox errors", async () => {
    await expect(
      makeBidiStreamRequest(
        async () => {
          await wait();
          throw new Error(`Mock Write Sandbox Error`);
        },
        async () => {
          throw new Error(`Should never get to read processing`);
        }
      )
    ).rejects.toThrow(`Mock Write Sandbox Error`);
  });

  test("should propagate invalid write data errors", async () => {
    await expect(
      makeBidiStreamRequest(
        async (write) => {
          await wait();
          await write({ id: 1234 } as never);
        },
        async () => {
          throw new Error(`Should never get to read processing`);
        }
      )
    ).rejects.toThrow(`id: string expected`);
  });

  test("should throw error when trying to write on a closed sandbox", async () => {
    let writer: StreamWriter<Customer> | undefined;

    await makeBidiStreamRequest(
      async (write) => {
        writer = write;

        await write({
          id: "circleci",
          name: "CircleCI",
        });
      },
      async () => undefined
    );

    await expect(
      (writer as StreamWriter<Customer>)({
        id: "vscode",
        name: "VSCode",
      })
    ).rejects.toThrow(
      `The write stream has already closed for customers.Customers.CreateCustomers`
    );
  });

  test("should propagate read sandbox errors", async () => {
    await expect(
      makeBidiStreamRequest(
        async (write) => {
          await write({
            id: "circleci",
            name: "CircleCI",
          });
        },
        async () => {
          throw new Error(`Mock Read Processing Error`);
        }
      )
    ).rejects.toThrow(`Mock Read Processing Error`);
  });

  test("should propagate timeout errors", async () => {
    RESPONSE_DELAY = 1000;
    await expect(
      makeBidiStreamRequest(
        async (write) => {
          await write({ id: "circleci", name: "CircleCI" });
        },
        async () => undefined,
        { timeout: 100 }
      )
    ).rejects.toThrow(
      `makeBidiStreamRequest for 'customers.Customers.CreateCustomers' timed out`
    );
  });

  test("should handle service errors", async () => {
    THROW_ERROR_RESPONSE = true;
    await expect(
      makeBidiStreamRequest(
        async (write) => {
          await write({ id: "circleci", name: "CircleCI" });
        },
        async () => {
          throw new Error(`Should not get to streamReader`);
        }
      )
    ).rejects.toThrow(`13 INTERNAL: Generic Service Error`);
  });

  test("should ignore aborted requests", async () => {
    RESPONSE_DELAY = 1000;
    return new Promise<void>((resolve, reject) => {
      const abortController = new AbortController();
      makeBidiStreamRequest(
        async (write) => {
          await write({ id: "circleci", name: "CircleCI" });
        },
        async () => undefined,
        abortController
      )
        .then(() => reject(new Error(`Should not have a successful return`)))
        .catch(() => reject(new Error(`Should not reject`)));

      setTimeout(() => {
        activeRequest.on("aborted", () => resolve());
        abortController.abort();
      }, 100);
    });
  });

  test("should propagate aborted error when configured too", async () => {
    RESPONSE_DELAY = 1000;
    getClient().clientSettings.rejectOnAbort = true;
    return new Promise<void>((resolve, reject) => {
      const abortController = new AbortController();
      makeBidiStreamRequest(
        async (write) => {
          await write({ id: "circleci", name: "CircleCI" });
        },
        async () => undefined,
        abortController
      )
        .then(() => reject(new Error(`Should not have a successful return`)))
        .catch((e) => {
          try {
            expect(e).toBeInstanceOf(RequestError);
            expect((e as RequestError).details).toStrictEqual(
              `Cancelled makeBidiStreamRequest for 'customers.Customers.CreateCustomers'`
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
