/* eslint-disable @typescript-eslint/no-explicit-any */
import { loadSync } from "@grpc/proto-loader";
import {
  loadPackageDefinition,
  Server,
  ServerCredentials,
  ServerUnaryCall,
  sendUnaryData,
  ServerWritableStream,
  ServerReadableStream,
  ServerDuplexStream,
  ServiceError,
  status,
  Metadata,
} from "@grpc/grpc-js";
import { RequestError, ProtoClient, ProtoRequest } from "../src";
import { promisify } from "util";
import { PROTO_FILE_PATHS } from "./utils";

interface Animal {
  id: string;
  action: string;
}

interface AnimalRequest {
  id?: string;
  action?: string;
}

interface AnimalResponse {
  animals: Animal[];
}

class MockServiceError extends Error implements ServiceError {
  public code: status;
  public details: string;
  public metadata: Metadata;

  constructor(code: status, details: string) {
    super(details);
    this.code = code;
    this.details = details;
    this.metadata = new Metadata();
  }
}

describe("ProtoClient Integration Suite", () => {
  let server: Server;
  let client: ProtoClient;
  let RESPONSE_DELAY: number;
  let THROW_ERROR_RESPONSE: boolean;
  let TOGGLE_THROWN_ERROR: boolean;
  let activeRequest: ProtoRequest<any, any>;

  beforeEach(async () => {
    jest.useRealTimers();

    client = new ProtoClient({
      clientSettings: {
        endpoint: `0.0.0.0:8001`,
      },
      protoSettings: {
        files: PROTO_FILE_PATHS,
      },
    });

    client.useMiddleware(async (req) => {
      activeRequest = req;

      // Auto add auth_token to the metadata
      if (!req.metadata.get("auth_token").length) {
        req.metadata.set("auth_token", "foobar");
      }
    });

    THROW_ERROR_RESPONSE = false;
    TOGGLE_THROWN_ERROR = false;
    RESPONSE_DELAY = 0;

    const packageDefinition = loadSync(PROTO_FILE_PATHS, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const animalsProto = loadPackageDefinition(packageDefinition).animals;

    const ANIMALS: Animal[] = [
      {
        id: "dog",
        action: "bark",
      },
      {
        id: "cat",
        action: "meow",
      },
      {
        id: "duck",
        action: "quack",
      },
    ];
    const ANIMALS_HASH: { [id: string]: Animal } = {};

    ANIMALS.forEach((animal) => (ANIMALS_HASH[animal.id] = animal));

    server = new Server();
    server.addService((animalsProto as any).Animals.service, {
      // Unary Endpoint
      GetAnimal: (
        call: ServerUnaryCall<AnimalRequest, Animal>,
        callback: sendUnaryData<Animal>
      ) => {
        if (THROW_ERROR_RESPONSE) {
          if (TOGGLE_THROWN_ERROR) {
            THROW_ERROR_RESPONSE = !THROW_ERROR_RESPONSE;
          }
          callback(
            new MockServiceError(status.INTERNAL, "Generic Service Error")
          );
        } else if (call.metadata.get("auth_token")?.[0] !== "foobar") {
          callback(
            new MockServiceError(status.INTERNAL, "Missing auth_token metadata")
          );
        } else if (
          call.request &&
          call.request.id &&
          ANIMALS_HASH[call.request.id]
        ) {
          const responseMetadata = new Metadata();
          responseMetadata.set("updated_auth_token", "bazboo");
          call.sendMetadata(responseMetadata);

          const animal = ANIMALS_HASH[call.request.id];
          const timerid = setTimeout(
            () => callback(null, animal),
            RESPONSE_DELAY
          );
          call.on("cancelled", () => {
            if (timerid) {
              clearTimeout(timerid);
            }
          });
        } else {
          callback(new Error("Animal Not Found"));
        }
      },

      // Server Stream Endpoint
      GetAnimals: (call: ServerWritableStream<unknown, Animal>) => {
        if (THROW_ERROR_RESPONSE) {
          if (TOGGLE_THROWN_ERROR) {
            THROW_ERROR_RESPONSE = !THROW_ERROR_RESPONSE;
          }
          return call.destroy(
            new MockServiceError(status.INTERNAL, "Generic Service Error")
          );
        } else if (call.metadata.get("auth_token")?.[0] !== "foobar") {
          return call.destroy(
            new MockServiceError(status.INTERNAL, "Missing auth_token metadata")
          );
        }

        const responseMetadata = new Metadata();
        responseMetadata.set("updated_auth_token", "bazboo");
        call.sendMetadata(responseMetadata);

        const timerid = setTimeout(async () => {
          for (const animal of ANIMALS) {
            await promisify(call.write.bind(call))(animal);
          }

          call.end();
        }, RESPONSE_DELAY);

        call.on("cancelled", () => {
          if (timerid) {
            clearTimeout(timerid);
          }
        });
      },

      // Client Stream Endpoint
      EditAnimal: (
        call: ServerReadableStream<unknown, Animal>,
        callback: sendUnaryData<AnimalResponse>
      ) => {
        if (THROW_ERROR_RESPONSE) {
          if (TOGGLE_THROWN_ERROR) {
            THROW_ERROR_RESPONSE = !THROW_ERROR_RESPONSE;
          }
          return callback(
            new MockServiceError(status.INTERNAL, "Generic Service Error")
          );
        } else if (call.metadata.get("auth_token")?.[0] !== "foobar") {
          callback(
            new MockServiceError(status.INTERNAL, "Missing auth_token metadata")
          );
        }

        const animals: Animal[] = [];

        call.on("data", (row: Animal) => {
          if (!row || !row.id || !ANIMALS_HASH[row.id]) {
            return callback(new Error(`Animal ${row?.id} not found`), null);
          }

          ANIMALS_HASH[row.id].action = row.action;
          animals.push(ANIMALS_HASH[row.id]);
        });

        call.on("end", () => {
          const timerid = setTimeout(
            () => callback(null, { animals }),
            RESPONSE_DELAY
          );

          call.on("cancelled", () => {
            if (timerid) {
              clearTimeout(timerid);
            }
          });
        });
      },

      // Bidirectional Endpoint
      CreateAnimal: (call: ServerDuplexStream<Animal, Animal>) => {
        if (THROW_ERROR_RESPONSE) {
          if (TOGGLE_THROWN_ERROR) {
            THROW_ERROR_RESPONSE = !THROW_ERROR_RESPONSE;
          }
          return call.destroy(
            new MockServiceError(status.INTERNAL, "Generic Service Error")
          );
        } else if (call.metadata.get("auth_token")?.[0] !== "foobar") {
          return call.destroy(
            new MockServiceError(status.INTERNAL, "Missing auth_token metadata")
          );
        }

        const writeBackRows: Animal[] = [];
        call.on("data", (row: Animal) => {
          if (!row || !row.id) {
            return call.destroy(new Error("Animal Not Found"));
          }

          ANIMALS_HASH[row.id] = row;
          ANIMALS.push(row);
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

    return new Promise<void>((resolve, reject) => {
      server.bindAsync(
        "0.0.0.0:8001",
        ServerCredentials.createInsecure(),
        (e) => {
          if (e) {
            reject(e);
          } else {
            server.start();
            resolve();
          }
        }
      );
    });
  });

  afterEach(async () => {
    return new Promise((resolve) => {
      server?.tryShutdown(resolve);
    });
  });

  describe("makeUnaryRequest", () => {
    test("should successfully request against the GetAnimal method", async () => {
      const request = await client.makeUnaryRequest<AnimalRequest, Animal>(
        "animals.Animals.GetAnimal",
        { id: "dog" }
      );

      expect(request.result).toEqual({
        id: "dog",
        action: "bark",
      });
    });

    test("should ignore first try failure if the retry is successful", async () => {
      RESPONSE_DELAY = 1000;
      return new Promise<void>((resolve, reject) => {
        client
          .makeUnaryRequest<AnimalRequest, Animal>(
            "animals.Animals.GetAnimal",
            { id: "dog" },
            { timeout: 200, retryOptions: true }
          )
          .then((request) => {
            try {
              expect(request.result).toEqual({
                id: "dog",
                action: "bark",
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

    test("should propogate timeout errors", async () => {
      RESPONSE_DELAY = 1000;
      await expect(
        client.makeUnaryRequest<AnimalRequest, Animal>(
          "animals.Animals.GetAnimal",
          { id: "dog" },
          { timeout: 100 }
        )
      ).rejects.toThrow(
        `makeUnaryRequest for 'animals.Animals.GetAnimal' timed out`
      );
    });

    test("should handle service errors", async () => {
      THROW_ERROR_RESPONSE = true;
      await expect(
        client.makeUnaryRequest<AnimalRequest, Animal>(
          "animals.Animals.GetAnimal",
          { id: "dog" }
        )
      ).rejects.toThrow(`13 INTERNAL: Generic Service Error`);
    });

    test("should ignore aborted requests", async () => {
      RESPONSE_DELAY = 1000;
      return new Promise<void>((resolve, reject) => {
        const abortController = new AbortController();
        client
          .makeUnaryRequest<AnimalRequest, Animal>(
            "animals.Animals.GetAnimal",
            { id: "dog" },
            abortController
          )
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
      client.clientSettings.rejectOnAbort = true;
      return new Promise<void>((resolve, reject) => {
        const abortController = new AbortController();
        client
          .makeUnaryRequest<AnimalRequest, Animal>(
            "animals.Animals.GetAnimal",
            { id: "dog" },
            abortController
          )
          .then(() => reject(new Error(`Should not have a successul return`)))
          .catch((e) => {
            try {
              expect(e).toBeInstanceOf(RequestError);
              expect((e as RequestError).details).toStrictEqual(
                `Cancelled makeUnaryRequest for 'animals.Animals.GetAnimal'`
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

  describe("makeClientStreamRequest", () => {
    test("should successfully request against the EditAnimal method", async () => {
      const request = await client.makeClientStreamRequest<
        Animal,
        AnimalResponse
      >("animals.Animals.EditAnimal", async (write) => {
        await write({
          id: "dog",
          action: "meow",
        });

        await write({
          id: "cat",
          action: "woof",
        });
      });

      expect(request.result).toEqual({
        animals: [
          {
            id: "dog",
            action: "meow",
          },
          {
            id: "cat",
            action: "woof",
          },
        ],
      });
    });

    test("should ignore first try failure if the retry is successful", async () => {
      RESPONSE_DELAY = 1000;
      return new Promise<void>((resolve, reject) => {
        client
          .makeClientStreamRequest<Animal, AnimalResponse>(
            "animals.Animals.EditAnimal",
            async (write) => {
              await write({
                id: "dog",
                action: "meow",
              });

              await write({
                id: "cat",
                action: "woof",
              });
            },
            { timeout: 200, retryOptions: true }
          )
          .then((request) => {
            try {
              expect(request.result).toEqual({
                animals: [
                  {
                    id: "dog",
                    action: "meow",
                  },
                  {
                    id: "cat",
                    action: "woof",
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

    test("should propogate timeout errors", async () => {
      RESPONSE_DELAY = 1000;
      await expect(
        client.makeClientStreamRequest<Animal, AnimalResponse>(
          "animals.Animals.EditAnimal",
          async (write) => {
            await write({
              id: "dog",
              action: "meow",
            });
          },
          { timeout: 100 }
        )
      ).rejects.toThrow(
        `makeClientStreamRequest for 'animals.Animals.EditAnimal' timed out`
      );
    });

    test("should handle service errors", async () => {
      THROW_ERROR_RESPONSE = true;
      await expect(
        client.makeClientStreamRequest<Animal, AnimalResponse>(
          "animals.Animals.EditAnimal",
          async (write) => {
            await write({
              id: "dog",
              action: "meow",
            });
          }
        )
      ).rejects.toThrow(`13 INTERNAL: Generic Service Error`);
    });

    test("should ignore aborted requests", async () => {
      RESPONSE_DELAY = 1000;
      return new Promise<void>((resolve, reject) => {
        const abortController = new AbortController();
        client
          .makeClientStreamRequest<Animal, AnimalResponse>(
            "animals.Animals.EditAnimal",
            async (write) => {
              await write({
                id: "dog",
                action: "meow",
              });
            },
            abortController
          )
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
      client.clientSettings.rejectOnAbort = true;
      return new Promise<void>((resolve, reject) => {
        const abortController = new AbortController();
        client
          .makeClientStreamRequest<Animal, AnimalResponse>(
            "animals.Animals.EditAnimal",
            async (write) => {
              await write({
                id: "dog",
                action: "meow",
              });
            },
            abortController
          )
          .then(() => reject(new Error(`Should not have a successul return`)))
          .catch((e) => {
            try {
              expect(e).toBeInstanceOf(RequestError);
              expect((e as RequestError).details).toStrictEqual(
                `Cancelled makeClientStreamRequest for 'animals.Animals.EditAnimal'`
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

  describe("makeServerStreamRequest", () => {
    test("should successfully request against the GetAnimals method", async () => {
      const animals: Animal[] = [];

      await client.makeServerStreamRequest<Animal>(
        "animals.Animals.GetAnimals",
        async (row) => {
          animals.push(row);
        }
      );

      expect(animals).toEqual([
        {
          id: "dog",
          action: "bark",
        },
        {
          id: "cat",
          action: "meow",
        },
        {
          id: "duck",
          action: "quack",
        },
      ]);
    });

    test("should ignore first try failure if the retry is successful", async () => {
      RESPONSE_DELAY = 1000;
      return new Promise<void>((resolve, reject) => {
        const animals: Animal[] = [];

        client
          .makeServerStreamRequest<unknown, Animal>(
            "animals.Animals.GetAnimals",
            {},
            async (row) => {
              animals.push(row);
            },
            { timeout: 200, retryOptions: true }
          )
          .then((request) => {
            try {
              expect(animals).toEqual([
                {
                  id: "dog",
                  action: "bark",
                },
                {
                  id: "cat",
                  action: "meow",
                },
                {
                  id: "duck",
                  action: "quack",
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

    test("should propogate timeout errors", async () => {
      RESPONSE_DELAY = 1000;
      await expect(
        client.makeServerStreamRequest<unknown, Animal>(
          "animals.Animals.GetAnimals",
          {},
          async () => {
            throw new Error(`Should not get to streamReader`);
          },
          { timeout: 100 }
        )
      ).rejects.toThrow(
        `makeServerStreamRequest for 'animals.Animals.GetAnimals' timed out`
      );
    });

    test("should handle service errors", async () => {
      THROW_ERROR_RESPONSE = true;
      await expect(
        client.makeServerStreamRequest<Animal>(
          "animals.Animals.GetAnimals",
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
        client
          .makeServerStreamRequest<unknown, Animal>(
            "animals.Animals.GetAnimals",
            {},
            async () => {
              throw new Error(`Should not get to streamReader`);
            },
            abortController
          )
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
      client.clientSettings.rejectOnAbort = true;
      return new Promise<void>((resolve, reject) => {
        const abortController = new AbortController();
        client
          .makeServerStreamRequest<unknown, Animal>(
            "animals.Animals.GetAnimals",
            {},
            async () => {
              throw new Error(`Should not get to streamReader`);
            },
            abortController
          )
          .then(() => reject(new Error(`Should not have a successul return`)))
          .catch((e) => {
            try {
              expect(e).toBeInstanceOf(RequestError);
              expect((e as RequestError).details).toStrictEqual(
                `Cancelled makeServerStreamRequest for 'animals.Animals.GetAnimals'`
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

  describe("makeBidiStreamRequest", () => {
    test("should successfully request against the CreateAnimal method", async () => {
      const animals: Animal[] = [
        {
          id: "cow",
          action: "moo",
        },
        {
          id: "bird",
          action: "chirp",
        },
      ];
      const readAnimals: Animal[] = [];

      await client.makeBidiStreamRequest<Animal, Animal>(
        "animals.Animals.CreateAnimal",
        async (write) => {
          await write(animals[0]);
          await write(animals[1]);
        },
        async (row) => {
          readAnimals.push(row);
        }
      );

      expect(readAnimals).toEqual([
        {
          id: "cow",
          action: "moo",
        },
        {
          id: "bird",
          action: "chirp",
        },
      ]);
    });

    test("should ignore first try failure if the retry is successful", async () => {
      RESPONSE_DELAY = 1000;
      return new Promise<void>((resolve, reject) => {
        const animals: Animal[] = [
          {
            id: "cow",
            action: "moo",
          },
          {
            id: "bird",
            action: "chirp",
          },
        ];
        const readAnimals: Animal[] = [];

        client
          .makeBidiStreamRequest<Animal, Animal>(
            "animals.Animals.CreateAnimal",
            async (write) => {
              await write(animals[0]);
              await write(animals[1]);
            },
            async (row) => {
              readAnimals.push(row);
            },
            { timeout: 200, retryOptions: true }
          )
          .then((request) => {
            try {
              expect(readAnimals).toEqual([
                {
                  id: "cow",
                  action: "moo",
                },
                {
                  id: "bird",
                  action: "chirp",
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

    test("should propogate timeout errors", async () => {
      RESPONSE_DELAY = 1000;
      await expect(
        client.makeBidiStreamRequest<unknown, Animal>(
          "animals.Animals.CreateAnimal",
          async (write) => {
            await write({ id: "cow", action: "moo" });
          },
          async () => undefined,
          { timeout: 100 }
        )
      ).rejects.toThrow(
        `makeBidiStreamRequest for 'animals.Animals.CreateAnimal' timed out`
      );
    });

    test("should handle service errors", async () => {
      THROW_ERROR_RESPONSE = true;
      await expect(
        client.makeBidiStreamRequest<unknown, Animal>(
          "animals.Animals.CreateAnimal",
          async (write) => {
            await write({ id: "cow", action: "moo" });
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
        client
          .makeBidiStreamRequest<unknown, Animal>(
            "animals.Animals.CreateAnimal",
            async (write) => {
              await write({ id: "cow", action: "moo" });
            },
            async () => undefined,
            abortController
          )
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
      client.clientSettings.rejectOnAbort = true;
      return new Promise<void>((resolve, reject) => {
        const abortController = new AbortController();
        client
          .makeBidiStreamRequest<unknown, Animal>(
            "animals.Animals.CreateAnimal",
            async (write) => {
              await write({ id: "cow", action: "moo" });
            },
            async () => undefined,
            abortController
          )
          .then(() => reject(new Error(`Should not have a successul return`)))
          .catch((e) => {
            try {
              expect(e).toBeInstanceOf(RequestError);
              expect((e as RequestError).details).toStrictEqual(
                `Cancelled makeBidiStreamRequest for 'animals.Animals.CreateAnimal'`
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

  describe("metadata", () => {
    test("should verify the updated auth token coming back from the server", async () => {
      expect(
        await client.makeUnaryRequest<AnimalRequest, Animal>(
          "animals.Animals.GetAnimal",
          { id: "dog" }
        )
      ).toBeInstanceOf(ProtoRequest);
      expect(activeRequest.responseMetadata?.get(`updated_auth_token`)).toEqual(
        ["bazboo"]
      );
    });

    test("should fail the request if auth token is invalid in metadata", async () => {
      await expect(
        client.makeUnaryRequest<AnimalRequest, Animal>(
          "animals.Animals.GetAnimal",
          { id: "dog" },
          { metadata: { auth_token: "barbaz" } }
        )
      ).rejects.toThrow(`Missing auth_token metadata`);
    });
  });

  describe("retryOptions", () => {
    test("should propogate timeout errors after all retries are exhausted", async () => {
      RESPONSE_DELAY = 2000;
      await expect(
        client.makeUnaryRequest<AnimalRequest, Animal>(
          "animals.Animals.GetAnimal",
          { id: "dog" },
          { timeout: 100, retryOptions: { retryCount: 3 } }
        )
      ).rejects.toThrow(
        `makeUnaryRequest for 'animals.Animals.GetAnimal' timed out`
      );
      expect(activeRequest.responseErrors).toEqual([
        expect.objectContaining({ code: status.DEADLINE_EXCEEDED }),
        expect.objectContaining({ code: status.DEADLINE_EXCEEDED }),
        expect.objectContaining({ code: status.DEADLINE_EXCEEDED }),
        expect.objectContaining({ code: status.DEADLINE_EXCEEDED }),
      ]);
      expect(activeRequest.error).toStrictEqual(
        activeRequest.responseErrors[2]
      );
    });

    test("should ignore previous service error if next request is successful", async () => {
      THROW_ERROR_RESPONSE = true;
      TOGGLE_THROWN_ERROR = true;
      const request = await client.makeUnaryRequest<AnimalRequest, Animal>(
        "animals.Animals.GetAnimal",
        { id: "dog" },
        { timeout: 500, retryOptions: { retryCount: 3 } }
      );
      expect(request.result).toEqual({
        id: "dog",
        action: "bark",
      });
      expect(activeRequest.responseErrors).toEqual([
        expect.objectContaining({ code: status.INTERNAL }),
      ]);
      expect(activeRequest.error).toBeUndefined();
    });

    test("should propogate the last service error after all retries are exhausted", async () => {
      THROW_ERROR_RESPONSE = true;
      await expect(
        client.makeUnaryRequest<AnimalRequest, Animal>(
          "animals.Animals.GetAnimal",
          { id: "dog" },
          { timeout: 500, retryOptions: { retryCount: 3 } }
        )
      ).rejects.toThrow(`13 INTERNAL: Generic Service Error`);
      expect(activeRequest.responseErrors).toEqual([
        expect.objectContaining({ code: status.INTERNAL }),
        expect.objectContaining({ code: status.INTERNAL }),
        expect.objectContaining({ code: status.INTERNAL }),
        expect.objectContaining({ code: status.INTERNAL }),
      ]);
      expect(activeRequest.error).toStrictEqual(
        activeRequest.responseErrors[2]
      );
    });
  });
});
