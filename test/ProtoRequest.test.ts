/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  CallOptions,
  ClientDuplexStream,
  ClientReadableStream,
  ClientUnaryCall,
  ClientWritableStream,
  Metadata,
  requestCallback,
  ServiceError,
  status,
} from "@grpc/grpc-js";
import {
  ProtoClient,
  ProtoRequest,
  RequestError,
  RequestMethodType,
} from "../src";
import { PROTO_FILE_PATHS } from "./utils";

interface Animal {
  id?: string;
  action?: string;
}

interface AnimalRequest {
  id?: string;
  action?: string;
}

interface AnimalsResponse {
  animals?: Animal[];
}

class MockServiceError extends Error implements ServiceError {
  code: status;
  details: string;
  metadata: Metadata;

  constructor(message?: string, code?: status, metadata?: Metadata) {
    super(message || `Foobar Service Error`);
    this.code = code || status.UNKNOWN;
    this.details = message || `Foobar Service Error`;
    this.metadata = metadata || new Metadata();
  }
}

jest.setTimeout(1000);

describe("ProtoRequest", () => {
  let client: ProtoClient;

  beforeEach(() => {
    client = new ProtoClient({
      clientSettings: {
        endpoint: {
          address: `0.0.0.0:9001`,
        },
        rejectOnAbort: true,
      },
      protoSettings: {
        files: PROTO_FILE_PATHS,
      },
    });
  });

  describe("constructor", () => {
    test("should validate method on init", () => {
      const abortController = new AbortController();
      const metadata = new Metadata();
      const callOptions = { host: "foobar" };
      const request = new ProtoRequest(
        client,
        "animals.Animals.GetAnimal",
        RequestMethodType.UnaryRequest,
        { abortController, metadata, callOptions }
      );

      expect(request.method).toStrictEqual(`animals.Animals.GetAnimal`);
      expect(request.requestPath).toStrictEqual(`/animals.Animals/GetAnimal`);
      expect(request.requestType.name).toStrictEqual(`AnimalRequest`);
      expect(request.responseType.name).toStrictEqual(`Animal`);
      expect(request.abortController).toStrictEqual(abortController);
      expect(request.metadata).toStrictEqual(metadata);
      expect(request.callOptions).toStrictEqual(callOptions);
    });

    test("should build metadata object from hash", () => {
      const request = new ProtoRequest(
        client,
        "animals.Animals.GetAnimal",
        RequestMethodType.UnaryRequest,
        { metadata: { foo: ["bar", "baz"], red: "blue" } }
      );

      expect(request.metadata).toBeInstanceOf(Metadata);
      expect(request.metadata.toJSON()).toEqual({
        foo: ["bar", "baz"],
        red: ["blue"],
      });
    });

    test("should default to filling in all the request options", () => {
      const request = new ProtoRequest(
        client,
        "animals.Animals.GetAnimal",
        RequestMethodType.UnaryRequest,
        {}
      );

      expect(request.abortController).toBeInstanceOf(AbortController);
      expect(request.metadata).toBeInstanceOf(Metadata);
      expect(request.callOptions).toEqual({});
    });

    test("should default metadata and callOptions when only passing in abortController", () => {
      const abortController = new AbortController();
      const request = new ProtoRequest(
        client,
        "animals.Animals.GetAnimal",
        RequestMethodType.UnaryRequest,
        abortController
      );

      expect(request.abortController).toStrictEqual(abortController);
      expect(request.metadata).toBeInstanceOf(Metadata);
      expect(request.callOptions).toEqual({});
    });

    test("should default all request options when nothing is passed in", () => {
      const request = new ProtoRequest(
        client,
        "animals.Animals.GetAnimal",
        RequestMethodType.UnaryRequest,
        undefined
      );

      expect(request.abortController).toBeInstanceOf(AbortController);
      expect(request.metadata).toBeInstanceOf(Metadata);
      expect(request.callOptions).toEqual({});
    });

    test("should throw an error if method could not be found", () => {
      expect(
        () =>
          new ProtoRequest(
            client,
            "foo.bar.baz",
            RequestMethodType.UnaryRequest,
            undefined
          )
      ).toThrow(`Method foo.bar.baz not found`);
    });

    test("should throw an error if method does not match request call type", () => {
      // Unary
      expect(
        () =>
          new ProtoRequest(
            client,
            "animals.Animals.GetAnimal",
            RequestMethodType.ClientStreamRequest,
            undefined
          )
      ).toThrow(
        `makeClientStreamRequest does not support method 'animals.Animals.GetAnimal', use makeUnaryRequest instead`
      );

      // Server Stream
      expect(
        () =>
          new ProtoRequest(
            client,
            "animals.Animals.GetAnimals",
            RequestMethodType.UnaryRequest,
            undefined
          )
      ).toThrow(
        `makeUnaryRequest does not support method 'animals.Animals.GetAnimals', use makeServerStreamRequest instead`
      );

      // Client Stream
      expect(
        () =>
          new ProtoRequest(
            client,
            "animals.Animals.EditAnimal",
            RequestMethodType.BidiStreamRequest,
            undefined
          )
      ).toThrow(
        `makeBidiStreamRequest does not support method 'animals.Animals.EditAnimal', use makeClientStreamRequest instead`
      );

      // Bi-directional Stream
      expect(
        () =>
          new ProtoRequest(
            client,
            "animals.Animals.CreateAnimal",
            RequestMethodType.ServerStreamRequest,
            undefined
          )
      ).toThrow(
        `makeServerStreamRequest does not support method 'animals.Animals.CreateAnimal', use makeBidiStreamRequest instead`
      );
    });
  });

  describe("makeUnaryRequest", () => {
    let request: ProtoRequest<AnimalRequest, Animal>;
    let unaryCall: ClientUnaryCall;
    let makeUnaryRequestSpy: jest.Mock;
    let abortController: AbortController;
    let metadata: Metadata;
    let callOptions: CallOptions;

    beforeEach(() => {
      abortController = new AbortController();
      callOptions = { host: "foobar" };

      metadata = new Metadata();
      metadata.set("foo", "bar");

      request = new ProtoRequest(
        client,
        "animals.Animals.GetAnimal",
        RequestMethodType.UnaryRequest,
        { abortController, metadata, callOptions }
      );

      unaryCall = {
        on: jest.fn(),
        cancel: jest.fn(),
      } as any;

      makeUnaryRequestSpy = jest
        .spyOn(client.getClient(request), "makeUnaryRequest")
        .mockImplementation(() => unaryCall) as jest.Mock;
    });

    test("successful unary request", async () => {
      makeUnaryRequestSpy.mockImplementation((...args: any[]) => {
        args.pop()(null, { id: "cow" } as Animal);
        return unaryCall;
      });

      expect(
        await request.makeUnaryRequest({ id: "cow", action: "moo" })
      ).toEqual(request);
      expect(request.result).toStrictEqual({ id: "cow" });
      expect((unaryCall.on as jest.Mock).mock.calls).toEqual([
        ["metadata", expect.any(Function)],
        ["status", expect.any(Function)],
      ]);
      expect(makeUnaryRequestSpy).toHaveBeenCalledTimes(1);
      expect(makeUnaryRequestSpy).toHaveBeenCalledWith(
        `/animals.Animals/GetAnimal`,
        expect.any(Function),
        expect.any(Function),
        { id: "cow", action: "moo" },
        metadata,
        callOptions,
        expect.any(Function)
      );
    });

    test("empty request should not throw any errors", async () => {
      makeUnaryRequestSpy.mockImplementation((...args: any[]) => {
        args.pop()(null, { id: "cow" } as Animal);
        return unaryCall;
      });

      await request.makeUnaryRequest();
      expect(request.result).toStrictEqual({
        id: "cow",
      });
      expect(makeUnaryRequestSpy).toHaveBeenCalledWith(
        `/animals.Animals/GetAnimal`,
        expect.any(Function),
        expect.any(Function),
        {},
        metadata,
        callOptions,
        expect.any(Function)
      );
    });

    test("should raise validation error", async () => {
      jest
        .spyOn(request.requestType, "verify")
        .mockReturnValue(`some validation error`);

      await expect(request.makeUnaryRequest()).rejects.toThrow(
        "some validation error"
      );
    });

    test("failed unary request", async () => {
      const error = new Error("Some Network Error");

      makeUnaryRequestSpy.mockImplementation((...args: any[]) => {
        args.pop()(error);
        return unaryCall;
      });

      await expect(request.makeUnaryRequest()).rejects.toThrow(
        "Some Network Error"
      );
    });

    test("cancelling unary request should trigger cancel on the client unary caller", async () => {
      return new Promise<void>((resolve, reject) => {
        request
          .makeUnaryRequest({ id: "cow", action: "moo" })
          .then(() =>
            reject(`Unary request should have rejected when cancelled`)
          )
          .catch((e) => {
            try {
              expect(e.message).toStrictEqual(
                `Cancelled makeUnaryRequest for 'animals.Animals.GetAnimal'`
              );
              expect(unaryCall.cancel).toHaveBeenCalledTimes(1);
            } catch (error) {
              reject(error);
            }

            resolve();
          });

        abortController.abort();
      });
    });
  });

  describe("makeClientStreamRequest", () => {
    let request: ProtoRequest<Animal, AnimalsResponse>;
    let stream: ClientWritableStream<Animal>;
    let makeClientStreamRequestSpy: jest.Mock;
    let callback: requestCallback<AnimalsResponse>;
    let abortController: AbortController;
    let metadata: Metadata;
    let callOptions: CallOptions;

    beforeEach(() => {
      abortController = new AbortController();
      callOptions = { host: "foobar" };

      metadata = new Metadata();
      metadata.set("foo", "bar");

      request = new ProtoRequest(
        client,
        "animals.Animals.EditAnimal",
        RequestMethodType.ClientStreamRequest,
        { abortController, callOptions, metadata }
      );
      jest.spyOn(request, "emit");
      jest.spyOn(request.requestType, "verify").mockReturnValue(null);

      stream = {
        on: jest.fn(),
        write: jest.fn((...args: any[]) => args.pop()()),
        end: jest.fn(),
        cancel: jest.fn(),
      } as any;

      const makeClientStreamRequestImpl = (...args: any[]) => {
        callback = args.pop();
        return stream;
      };
      makeClientStreamRequestSpy = jest
        .spyOn(client.getClient(request), "makeClientStreamRequest")
        .mockImplementation(makeClientStreamRequestImpl as any) as jest.Mock;
    });

    test("successful client stream request", async () => {
      (stream.end as jest.Mock).mockImplementation(() =>
        callback(null, { animals: [{ id: "cow", action: "moo" }] })
      );

      expect(
        await request.makeClientStreamRequest(async (write) => {
          await write({ id: "cow", action: "moo" });
          await write({ id: "duck", action: "quack" });
        })
      ).toEqual(request);

      expect(request.result).toStrictEqual({
        animals: [{ id: "cow", action: "moo" }],
      });
      expect((stream.on as jest.Mock).mock.calls).toEqual([
        ["metadata", expect.any(Function)],
        ["status", expect.any(Function)],
      ]);
      expect(makeClientStreamRequestSpy).toHaveBeenCalledTimes(1);
      expect(makeClientStreamRequestSpy).toHaveBeenLastCalledWith(
        `/animals.Animals/EditAnimal`,
        expect.any(Function),
        expect.any(Function),
        metadata,
        callOptions,
        expect.any(Function)
      );
      expect((request.requestType.verify as jest.Mock).mock.calls).toEqual([
        [{ id: "cow", action: "moo" }],
        [{ id: "duck", action: "quack" }],
      ]);
      expect((stream.write as jest.Mock).mock.calls).toEqual([
        [{ id: "cow", action: "moo" }, undefined, expect.any(Function)],
        [{ id: "duck", action: "quack" }, undefined, expect.any(Function)],
      ]);
      expect(stream.end).toHaveBeenCalledTimes(1);
    });

    test("no error should be thrown if no data is written", async () => {
      (stream.end as jest.Mock).mockImplementation(() =>
        callback(null, { animals: [{ id: "cow", action: "moo" }] })
      );

      await request.makeClientStreamRequest(async () => undefined);

      expect(request.result).toStrictEqual({
        animals: [{ id: "cow", action: "moo" }],
      });
      expect(request.requestType.verify).not.toHaveBeenCalled();
      expect(stream.write).not.toHaveBeenCalled();
      expect(stream.end).toHaveBeenCalledTimes(1);
    });

    test("validation error should raise exception and cancel the stream request", async () => {
      (stream.end as jest.Mock).mockImplementation(() =>
        callback(null, { animals: [{ id: "cow", action: "moo" }] })
      );
      (request.requestType.verify as jest.Mock).mockImplementation(
        () => "Some Validation Error"
      );

      await expect(
        request.makeClientStreamRequest(async (write) => {
          await write({ id: "cow", action: "moo" });
        })
      ).rejects.toThrow("Some Validation Error");
      expect(stream.cancel).toHaveBeenCalledTimes(1);
      expect(stream.end).not.toHaveBeenCalled();
      expect(stream.write).not.toHaveBeenCalled();
    });

    test("error response from the server should be raised", async () => {
      (stream.end as jest.Mock).mockImplementation(() =>
        callback(new MockServiceError())
      );

      await expect(
        request.makeClientStreamRequest(async (write) => {
          await write({ id: "cow", action: "moo" });
        })
      ).rejects.toThrow("Foobar Service Error");
      expect((request.requestType.verify as jest.Mock).mock.calls).toEqual([
        [{ id: "cow", action: "moo" }],
      ]);
      expect((stream.write as jest.Mock).mock.calls).toEqual([
        [{ id: "cow", action: "moo" }, undefined, expect.any(Function)],
      ]);
      expect(stream.cancel).not.toHaveBeenCalled();
      expect(stream.end).toHaveBeenCalledTimes(1);
    });

    test("canceling mid stream should block any further writes and cancel the underlying stream", async () => {
      return new Promise<void>((resolve, reject) => {
        (stream.end as jest.Mock).mockImplementation(() =>
          callback(null, { animals: [{ id: "cow", action: "moo" }] })
        );

        request
          .makeClientStreamRequest(async (write) => {
            await write({ id: "cow", action: "moo" });
            abortController.abort();
            await expect(
              write({ id: "duck", action: "quack" })
            ).rejects.toThrow(
              "The write stream has already closed for animals.Animals.EditAnimal"
            );
          })
          .then(() =>
            reject(`Client stream request should have rejected when cancelled`)
          )
          .catch((e) => {
            try {
              expect(e.message).toStrictEqual(
                `Cancelled makeClientStreamRequest for 'animals.Animals.EditAnimal'`
              );
              expect(
                (request.requestType.verify as jest.Mock).mock.calls
              ).toEqual([[{ id: "cow", action: "moo" }]]);
              expect((stream.write as jest.Mock).mock.calls).toEqual([
                [{ id: "cow", action: "moo" }, undefined, expect.any(Function)],
              ]);
              expect(stream.end).not.toHaveBeenCalled();
              expect(stream.cancel).toHaveBeenCalledTimes(1);
              resolve();
            } catch (error) {
              reject(error);
            }
          });
      });
    });
  });

  describe("makeServerStreamRequest", () => {
    let request: ProtoRequest<object, Animal>;
    let stream: ClientReadableStream<Animal>;
    let makeServerStreamRequestSpy: jest.Mock;
    let abortController: AbortController;
    let metadata: Metadata;
    let callOptions: CallOptions;

    beforeEach(() => {
      abortController = new AbortController();
      callOptions = { host: "foobar" };

      metadata = new Metadata();
      metadata.set("foo", "bar");

      request = new ProtoRequest(
        client,
        "animals.Animals.GetAnimals",
        RequestMethodType.ServerStreamRequest,
        { abortController, metadata, callOptions }
      );
      jest.spyOn(request, "emit");
      jest.spyOn(request.requestType, "verify").mockReturnValue(null);

      stream = {
        on: jest.fn(),
        cancel: jest.fn(),
      } as any;

      makeServerStreamRequestSpy = jest
        .spyOn(client.getClient(request), "makeServerStreamRequest")
        .mockImplementation(() => stream) as jest.Mock;
    });

    test("successful server stream request", async () => {
      (stream.on as jest.Mock).mockImplementation((name, callback) => {
        if (name === "data") {
          callback({ id: "cow", action: "moo" });
          callback({ id: "duck", action: "quack" });
          callback({ id: "bird", action: "chirp" });
        } else if (name === "end") {
          callback();
        }
      });

      let count = 0;
      expect(
        await request.makeServerStreamRequest({}, async (row, index, req) => {
          expect(req).toEqual(request);

          if (count === 0) {
            expect(index).toStrictEqual(0);
            expect(row).toEqual({ id: "cow", action: "moo" });
          } else if (count === 1) {
            expect(index).toStrictEqual(1);
            expect(row).toEqual({ id: "duck", action: "quack" });
          } else if (count === 2) {
            expect(index).toStrictEqual(2);
            expect(row).toEqual({ id: "bird", action: "chirp" });
          }

          count++;
        })
      ).toEqual(request);

      expect(makeServerStreamRequestSpy).toHaveBeenCalledTimes(1);
      expect(makeServerStreamRequestSpy).toHaveBeenCalledWith(
        `/animals.Animals/GetAnimals`,
        expect.any(Function),
        expect.any(Function),
        {},
        metadata,
        callOptions
      );
      expect((stream.on as jest.Mock).mock.calls).toEqual([
        ["metadata", expect.any(Function)],
        ["status", expect.any(Function)],
        ["data", expect.any(Function)],
        ["end", expect.any(Function)],
        ["error", expect.any(Function)],
      ]);
    });

    test("exception should be thrown if read iterator is not passed", async () => {
      await expect(request.makeServerStreamRequest({})).rejects.toThrow(
        `streamReader not found`
      );
    });

    test("exception should be thrown on any validation error", async () => {
      (request.requestType.verify as jest.Mock).mockImplementation(
        () => "validation error message"
      );
      await expect(
        request.makeServerStreamRequest(async () => undefined)
      ).rejects.toThrow(`validation error message`);
    });

    test("exception raised during read iterator should propagate out", async () => {
      (stream.on as jest.Mock).mockImplementation((name, callback) => {
        if (name === "data") {
          callback({ id: "cow", action: "moo" });
        }
      });

      const mockError = new Error(`Mock Read Error`);
      await expect(
        request.makeServerStreamRequest(async () => {
          throw mockError;
        })
      ).rejects.toThrow(`Mock Read Error`);
    });

    test("exception raised on the stream should propagate out", async () => {
      (stream.on as jest.Mock).mockImplementation((name, callback) => {
        if (name === "error") {
          callback(new Error(`Mock Stream Error`));
        }
      });

      await expect(
        request.makeServerStreamRequest(async () => undefined)
      ).rejects.toThrow(`Mock Stream Error`);
    });

    test("cancelling request should propagte abort error", async () => {
      (stream.on as jest.Mock).mockImplementation((name) => {
        if (name === "error") {
          abortController.abort();
        }
      });

      await expect(
        request.makeServerStreamRequest({}, async () => undefined)
      ).rejects.toThrow(
        `Cancelled makeServerStreamRequest for 'animals.Animals.GetAnimals'`
      );
    });
  });

  describe("makeBidiStreamRequest", () => {
    let request: ProtoRequest<Animal, Animal>;
    let stream: ClientDuplexStream<Animal, Animal>;
    let makeBidiStreamRequestSpy: jest.Mock;
    let abortController: AbortController;
    let metadata: Metadata;
    let callOptions: CallOptions;

    beforeEach(() => {
      abortController = new AbortController();
      callOptions = { host: "foobar" };

      metadata = new Metadata();
      metadata.set("foo", "bar");

      request = new ProtoRequest(
        client,
        "animals.Animals.CreateAnimal",
        RequestMethodType.BidiStreamRequest,
        { abortController, metadata, callOptions }
      );
      jest.spyOn(request, "emit");
      jest.spyOn(request.requestType, "verify").mockReturnValue(null);

      stream = {
        on: jest.fn(),
        cancel: jest.fn(),
        write: jest
          .fn()
          .mockImplementation((data, encoding, callback) => callback()),
        end: jest.fn(),
      } as any;

      makeBidiStreamRequestSpy = jest
        .spyOn(client.getClient(request), "makeBidiStreamRequest")
        .mockImplementation((() => stream) as any) as jest.Mock;
    });

    test("successful server stream request", async () => {
      const streamEvents: Record<string, (param?: any) => void> = {};

      (stream.on as jest.Mock).mockImplementation((name, callback) => {
        streamEvents[name] = callback;
      });

      let count = 0;
      expect(
        await request.makeBidiStreamRequest(
          async (write) => {
            await write({ id: "cow", action: "moo" });
            expect(stream.write).toHaveBeenCalledTimes(1);
            expect(stream.write).toHaveBeenLastCalledWith(
              { id: "cow", action: "moo" },
              undefined,
              expect.any(Function)
            );

            await write({ id: "duck", action: "quack" });
            expect(stream.write).toHaveBeenCalledTimes(2);
            expect(stream.write).toHaveBeenLastCalledWith(
              { id: "duck", action: "quack" },
              undefined,
              expect.any(Function)
            );

            streamEvents.data({ id: "cow", action: "moo" });
            streamEvents.data({ id: "duck", action: "quack" });
            streamEvents.data({ id: "bird", action: "chirp" });
            streamEvents.end();
          },
          async (row, index, req) => {
            expect(req).toEqual(request);

            if (count === 0) {
              expect(index).toEqual(0);
              expect(row).toEqual({ id: "cow", action: "moo" });
            } else if (count === 1) {
              expect(index).toEqual(1);
              expect(row).toEqual({ id: "duck", action: "quack" });
            } else if (count === 2) {
              expect(index).toEqual(2);
              expect(row).toEqual({ id: "bird", action: "chirp" });
            }

            count++;
          }
        )
      ).toEqual(request);

      expect(makeBidiStreamRequestSpy).toHaveBeenCalledTimes(1);
      expect(makeBidiStreamRequestSpy).toHaveBeenCalledWith(
        `/animals.Animals/CreateAnimal`,
        expect.any(Function),
        expect.any(Function),
        metadata,
        callOptions
      );
      expect((stream.on as jest.Mock).mock.calls).toEqual([
        ["metadata", expect.any(Function)],
        ["status", expect.any(Function)],
        ["data", expect.any(Function)],
        ["end", expect.any(Function)],
        ["error", expect.any(Function)],
      ]);
    });

    test("should propogate the abort error", async () => {
      await expect(
        request.makeBidiStreamRequest(
          async (write) => {
            await write({ id: "cow", action: "moo" });
            expect(stream.write).toHaveBeenCalledTimes(1);
            abortController.abort();
          },
          async () => {
            throw new Error(`Should not get to reading`);
          }
        )
      ).rejects.toThrow(
        `Cancelled makeBidiStreamRequest for 'animals.Animals.CreateAnimal'`
      );
      expect(request.error?.message).toStrictEqual(
        `Cancelled makeBidiStreamRequest for 'animals.Animals.CreateAnimal'`
      );
    });

    test("should propogate the error thrown during writing", async () => {
      await expect(
        request.makeBidiStreamRequest(
          async () => {
            throw new Error(`Some Write Sandbox Error`);
          },
          async () => {
            throw new Error(`Should not get to reading`);
          }
        )
      ).rejects.toThrow(`Some Write Sandbox Error`);
      expect(request.error?.message).toStrictEqual(`Some Write Sandbox Error`);
    });

    test("should propogate validation error of written objects", async () => {
      jest
        .spyOn(request.requestType, "verify")
        .mockReturnValue(`Some Validation Error`);

      await expect(
        request.makeBidiStreamRequest(
          async (write) => {
            await write({});
            throw new Error(`Some Write Sandbox Error`);
          },
          async () => {
            throw new Error(`Should not get to reading`);
          }
        )
      ).rejects.toThrow(`Some Validation Error`);
      expect(request.error?.message).toStrictEqual(`Some Validation Error`);
    });

    test("should propogate any read stream error", async () => {
      const streamEvents: Record<string, (param?: any) => void> = {};

      (stream.on as jest.Mock).mockImplementation((name, callback) => {
        streamEvents[name] = callback;
      });

      await expect(
        request.makeBidiStreamRequest(
          async () => {
            streamEvents.error(new Error(`Some Read Stream Error`));
          },
          async () => {
            throw new Error(`Should not get to reading`);
          }
        )
      ).rejects.toThrow(`Some Read Stream Error`);
      expect(stream.cancel).toHaveBeenCalledTimes(1);
      expect(request.error?.message).toStrictEqual(`Some Read Stream Error`);
    });

    test("should propogate any read iterator error", async () => {
      const streamEvents: Record<string, (param?: any) => void> = {};

      (stream.on as jest.Mock).mockImplementation((name, callback) => {
        streamEvents[name] = callback;
      });

      await expect(
        request.makeBidiStreamRequest(
          async () => {
            streamEvents.data({ id: "cow", action: "moo" });
          },
          async (row) => {
            expect(row).toEqual({ id: "cow", action: "moo" });
            throw new Error(`Some Read Iterator Error`);
          }
        )
      ).rejects.toThrow(`Some Read Iterator Error`);
      expect(stream.cancel).toHaveBeenCalledTimes(1);
      expect(request.error?.message).toEqual(`Some Read Iterator Error`);
    });
  });

  test("abort should abort the request as long is it's active", () => {
    const request = new ProtoRequest(
      client,
      "animals.Animals.GetAnimal",
      RequestMethodType.UnaryRequest,
      undefined
    );
    jest.spyOn(request.abortController, "abort");

    expect(request.abortController.signal.aborted).toStrictEqual(false);
    request.abort();
    expect(request.abortController.abort).toHaveBeenCalledTimes(1);
    expect(request.abortController.signal.aborted).toStrictEqual(true);

    // Calling abort again should do nothing if request is already aborted
    request.abort();
    expect(request.abortController.abort).toHaveBeenCalledTimes(1);
  });

  describe("retryWrapper", () => {
    let request: ProtoRequest<AnimalRequest, Animal>;

    beforeEach(() => {
      jest.useRealTimers();

      request = new ProtoRequest(
        client,
        "animals.Animals.GetAnimal",
        RequestMethodType.UnaryRequest,
        undefined
      );
    });

    test("should run the request runner a single time when there are no errors or timeouts", async () => {
      let runCount = 0;
      expect(
        await request.retryWrapper((timeout, completed) => {
          runCount++;
          timeout(() => undefined);
          completed();
        })
      ).toStrictEqual(request);
      expect(runCount).toStrictEqual(1);
    });

    test("should ignore retry error raised is unretryable", async () => {
      let runCount = 0;
      request.timeout = 100;
      request.retryOptions = {
        retryCount: 2,
        retryOnClientTimeout: true,
      };

      await expect(
        request.retryWrapper((timeout, completed) => {
          runCount++;
          timeout(() => undefined);
          completed(new RequestError(status.DATA_LOSS, request));
        })
      ).rejects.toThrow(
        `15 DATA_LOSS: makeUnaryRequest for 'animals.Animals.GetAnimal'`
      );
      expect(request.responseErrors).toEqual([
        expect.objectContaining({ code: status.DATA_LOSS }),
      ]);
      expect(runCount).toStrictEqual(1);
    });

    test("should ignore previous error if second request is successful", async () => {
      let runCount = 0;
      request.timeout = 100;
      request.retryOptions = {
        retryCount: 2,
        retryOnClientTimeout: true,
      };

      expect(
        await request.retryWrapper((timeout, completed) => {
          timeout(() => undefined);
          if (runCount++ === 0) {
            completed(new RequestError(status.UNKNOWN, request));
          } else {
            completed();
          }
        })
      ).toStrictEqual(request);
      expect(request.responseErrors).toEqual([
        expect.objectContaining({ code: status.UNKNOWN }),
      ]);
      expect(runCount).toStrictEqual(2);
    });

    test("should ignore previous timeout if second request is successful", async () => {
      let runCount = 0;
      request.timeout = 100;
      request.retryOptions = {
        retryCount: 2,
        retryOnClientTimeout: true,
      };

      expect(
        await request.retryWrapper((timeout, completed) => {
          timeout(() => undefined);
          if (runCount++ > 0) {
            completed();
          }
        })
      ).toStrictEqual(request);
      expect(request.responseErrors).toEqual([
        expect.objectContaining({ code: status.DEADLINE_EXCEEDED }),
      ]);
      expect(runCount).toStrictEqual(2);
    });

    test("should run request runner three times to waiting for each timeout to fail", async () => {
      let runCount = 0;
      request.timeout = 100;
      request.retryOptions = {
        retryCount: 2,
        retryOnClientTimeout: true,
      };

      await expect(
        request.retryWrapper((timeout) => {
          runCount++;
          timeout(() => undefined);
        })
      ).rejects.toThrow(
        `makeUnaryRequest for 'animals.Animals.GetAnimal' timed out`
      );
      expect(request.responseErrors).toEqual([
        expect.objectContaining({ code: status.DEADLINE_EXCEEDED }),
        expect.objectContaining({ code: status.DEADLINE_EXCEEDED }),
        expect.objectContaining({ code: status.DEADLINE_EXCEEDED }),
      ]);
      expect(runCount).toStrictEqual(3);
    });

    test("should allow timeout, then propogate unretryable error when found", async () => {
      let runCount = 0;
      request.timeout = 100;
      request.retryOptions = {
        retryCount: 2,
        retryOnClientTimeout: true,
      };

      await expect(
        request.retryWrapper((timeout, completed) => {
          timeout(() => undefined);
          if (runCount++ > 0) {
            completed(new RequestError(status.DATA_LOSS, request));
          }
        })
      ).rejects.toThrow(
        `15 DATA_LOSS: makeUnaryRequest for 'animals.Animals.GetAnimal'`
      );
      expect(request.responseErrors).toEqual([
        expect.objectContaining({ code: status.DEADLINE_EXCEEDED }),
        expect.objectContaining({ code: status.DATA_LOSS }),
      ]);
      expect(runCount).toStrictEqual(2);
    });
  });
});
