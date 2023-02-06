import { ServerWritableStream, status } from "@grpc/grpc-js";
import { RequestError, ProtoRequest } from "../src";
import { promisify } from "util";
import {
  Customer,
  FindCustomersRequest,
  getClient,
  makeServerStreamRequest,
  startServer,
  wait,
} from "./utils";
import { MockServiceError } from "./MockServiceError";

describe("makeServerStreamRequest", () => {
  let RESPONSE_DELAY: number;
  let THROW_ERROR_RESPONSE: boolean;
  let TOGGLE_THROWN_ERROR: boolean;
  let activeRequest: ProtoRequest<FindCustomersRequest, Customer>;

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

    const { client } = await startServer({
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

    client.useMiddleware(async (req) => {
      activeRequest = req;
    });
  });

  test("should successfully request against the FindCustomers method", async () => {
    const customers: Customer[] = [];

    await makeServerStreamRequest(async (row) => {
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
    return new Promise<void>((resolve, reject) => {
      const customers: Customer[] = [];

      makeServerStreamRequest(
        {},
        async (row) => {
          customers.push(row);
        },
        { timeout: 200, retryOptions: true }
      )
        .then((request) => {
          try {
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

  test("should throw when missing streamReader", async () => {
    await expect(makeServerStreamRequest({ name: "github" })).rejects.toThrow(
      `streamReader not found`
    );
  });

  test("should propagate validation errors", async () => {
    await expect(
      makeServerStreamRequest({ name: 1234 } as never, async () => {
        throw new Error(`Should not get to streamReader`);
      })
    ).rejects.toThrow(`name: string expected`);
  });

  test("should propagate read processing errors", async () => {
    await expect(
      makeServerStreamRequest(async () => {
        throw new Error(`Mock Read Processing Error`);
      })
    ).rejects.toThrow(`Mock Read Processing Error`);
  });

  test("should propagate timeout errors", async () => {
    RESPONSE_DELAY = 1000;
    await expect(
      makeServerStreamRequest(
        {},
        async () => {
          throw new Error(`Should not get to streamReader`);
        },
        { timeout: 100 }
      )
    ).rejects.toThrow(
      `makeServerStreamRequest for 'customers.Customers.FindCustomers' timed out`
    );
  });

  test("should handle service errors", async () => {
    THROW_ERROR_RESPONSE = true;
    await expect(
      makeServerStreamRequest(async () => {
        throw new Error(`Should not get to streamReader`);
      })
    ).rejects.toThrow(`13 INTERNAL: Generic Service Error`);
  });

  test("should ignore aborted requests", async () => {
    RESPONSE_DELAY = 1000;
    return new Promise<void>((resolve, reject) => {
      const abortController = new AbortController();
      makeServerStreamRequest(
        {},
        async () => {
          throw new Error(`Should not get to streamReader`);
        },
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
      makeServerStreamRequest(
        {},
        async () => {
          throw new Error(`Should not get to streamReader`);
        },
        abortController
      )
        .then(() => reject(new Error(`Should not have a successful return`)))
        .catch((e) => {
          try {
            expect(e).toBeInstanceOf(RequestError);
            expect((e as RequestError).details).toStrictEqual(
              `Cancelled makeServerStreamRequest for 'customers.Customers.FindCustomers'`
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
