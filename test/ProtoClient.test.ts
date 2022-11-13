/* eslint-disable @typescript-eslint/no-explicit-any */
import { Client, Metadata } from "@grpc/grpc-js";
import * as Protobuf from "protobufjs";
import {
  ProtoClient,
  ProtoSettings,
  ProtoRequest,
  StreamReader,
  RequestMethodType,
  RequestMiddleware,
  RequestOptions,
  StreamWriterSandbox,
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

describe("ProtoClient", () => {
  let client: ProtoClient;
  let request: ProtoRequest<any, any>;

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

    request = new ProtoRequest<any, any>(
      client,
      "animals.Animals.GetAnimal",
      RequestMethodType.UnaryRequest,
      undefined
    );
  });

  describe("configureClient", () => {
    test("should close out existing connections before setting up a new one", () => {
      const closeSpy = jest.spyOn(client, "close").mockReturnValue(undefined);

      client.configureClient({
        endpoint: `0.0.0.0:9091`,
      });
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect((client as any).clients).toEqual([
        {
          match: expect.any(Function),
          endpoint: { address: `0.0.0.0:9091` },
          client: expect.any(Client),
        },
      ]);
    });

    test("should create multiple clients for each configured endpoint", () => {
      client.configureClient({
        endpoint: [
          {
            address: `0.0.0.0:9091`,
            match: `foo`,
          },
          {
            address: `0.0.0.0:9092`,
            match: `bar`,
          },
          {
            address: `0.0.0.0:8183`,
            match: `baz`,
          },
        ],
      });
      expect((client as any).clients).toEqual([
        {
          match: expect.any(Function),
          endpoint: { address: `0.0.0.0:9091`, match: `foo` },
          client: expect.any(Client),
        },
        {
          match: expect.any(Function),
          endpoint: { address: `0.0.0.0:9092`, match: `bar` },
          client: expect.any(Client),
        },
        {
          match: expect.any(Function),
          endpoint: { address: `0.0.0.0:8183`, match: `baz` },
          client: expect.any(Client),
        },
      ]);
    });
  });

  describe("configureProtos", () => {
    test("passing proto options should override defaults", () => {
      const resolveAll = jest.fn();
      const loadSyncSpy = jest
        .spyOn(Protobuf.Root.prototype, "loadSync")
        .mockImplementation(() => ({ resolveAll } as any));
      const settings: ProtoSettings = {
        files: PROTO_FILE_PATHS,
        parseOptions: {
          keepCase: false,
          alternateCommentMode: false,
        },
        conversionOptions: {
          defaults: true,
        },
      };

      client.configureProtos(settings);
      expect(client.protoSettings).toStrictEqual(settings);
      expect(loadSyncSpy).toHaveBeenCalledTimes(1);
      expect(loadSyncSpy).toHaveBeenCalledWith(PROTO_FILE_PATHS, {
        keepCase: false,
        alternateCommentMode: false,
      });
    });

    test("passing proto instance should assign to overall client", () => {
      const root = new Protobuf.Root();

      client.configureProtos({ root });
      expect(client.getRoot()).toStrictEqual(root);
    });

    test("should throw when no root or proto files defined", () => {
      expect(() => client.configureProtos({})).toThrow(
        "Must define either a root protobuf object, or path to proto files"
      );
    });
  });

  test("getClient should return the existing client, or throw an error", () => {
    expect(client.getClient(request)).toBeInstanceOf(Client);

    client = new ProtoClient();
    expect(() => client.getClient(request)).toThrow(
      `ProtoClient is not yet configured`
    );

    client.configureClient({
      endpoint: {
        address: `0.0.0.0:9091`,
        match: "foo.bar.baz",
      },
    });
    expect(() => client.getClient(request)).toThrow(
      `Service method '${request.method}' has no configured endpoint`
    );
  });

  test("getRoot should return the proto root object, or throw an error", () => {
    expect(client.getRoot()).toBeInstanceOf(Protobuf.Root);

    client = new ProtoClient();
    expect(() => client.getRoot()).toThrow(
      `ProtoClient protos are not yet configured`
    );
  });

  test("useMiddleware should add middleware function to the stack", () => {
    expect(client.middleware).toEqual([]);

    const middleware = async () => undefined;
    client.useMiddleware(middleware);
    expect(client.middleware).toEqual([middleware]);
  });

  describe("makeRequests", () => {
    let request: ProtoRequest<any, any>;
    let metadata: Metadata;

    beforeEach(() => {
      metadata = new Metadata();
      metadata.set("foo", "bar");

      const generateRequestImpl = async (
        method: string,
        requestMethodType: RequestMethodType,
        requestOptions: AbortController | RequestOptions | undefined
      ) => {
        request = new ProtoRequest<any, any>(
          client,
          method,
          requestMethodType,
          requestOptions
        );

        jest
          .spyOn(request, "makeUnaryRequest")
          .mockImplementation(async () => request);
        jest
          .spyOn(request, "makeClientStreamRequest")
          .mockImplementation(async () => request);
        jest
          .spyOn(request, "makeServerStreamRequest")
          .mockImplementation(async () => request);
        jest
          .spyOn(request, "makeBidiStreamRequest")
          .mockImplementation(async () => request);

        return request;
      };

      jest
        .spyOn(client as any, "generateRequest")
        .mockImplementation(generateRequestImpl as any);
    });

    test("makeUnaryRequest", async () => {
      expect(
        await client.makeUnaryRequest<AnimalRequest, Animal>(
          "animals.Animals.GetAnimal",
          { id: "cow", action: "moo" },
          { metadata }
        )
      ).toEqual(request);
      expect((client as any).generateRequest).toHaveBeenCalledTimes(1);
      expect((client as any).generateRequest).toHaveBeenLastCalledWith(
        "animals.Animals.GetAnimal",
        RequestMethodType.UnaryRequest,
        { metadata }
      );
      expect(request.makeUnaryRequest).toHaveBeenCalledTimes(1);
      expect(request.makeUnaryRequest).toHaveBeenCalledWith({
        id: "cow",
        action: "moo",
      });
    });

    test("makeServerStreamRequest", async () => {
      const streamReader: StreamReader<unknown, Animal> = async () => undefined;

      expect(
        await client.makeServerStreamRequest<unknown, Animal>(
          "animals.Animals.GetAnimals",
          {},
          streamReader,
          { metadata }
        )
      ).toEqual(request);
      expect((client as any).generateRequest).toHaveBeenCalledTimes(1);
      expect((client as any).generateRequest).toHaveBeenLastCalledWith(
        "animals.Animals.GetAnimals",
        RequestMethodType.ServerStreamRequest,
        { metadata }
      );
      expect(request.makeServerStreamRequest).toHaveBeenCalledTimes(1);
      expect(request.makeServerStreamRequest).toHaveBeenCalledWith(
        {},
        streamReader
      );
    });

    test("makeClientStreamRequest", async () => {
      const writeSandbox: StreamWriterSandbox<Animal, AnimalsResponse> = async (
        write
      ) => {
        await write({ id: "cow", action: "moo" });
      };

      expect(
        await client.makeClientStreamRequest<Animal, AnimalsResponse>(
          "animals.Animals.EditAnimal",
          writeSandbox,
          { metadata }
        )
      ).toEqual(request);
      expect((client as any).generateRequest).toHaveBeenCalledTimes(1);
      expect((client as any).generateRequest).toHaveBeenLastCalledWith(
        "animals.Animals.EditAnimal",
        RequestMethodType.ClientStreamRequest,
        { metadata }
      );
      expect(request.makeClientStreamRequest).toHaveBeenCalledTimes(1);
      expect(request.makeClientStreamRequest).toHaveBeenCalledWith(
        writeSandbox
      );
    });

    test("makeBidiStreamRequest", async () => {
      const streamReader: StreamReader<Animal, Animal> = async () => undefined;
      const writeSandbox: StreamWriterSandbox<Animal, Animal> = async (
        write
      ) => {
        await write({ id: "cow", action: "moo" });
      };

      expect(
        await client.makeBidiStreamRequest<Animal, Animal>(
          "animals.Animals.CreateAnimal",
          writeSandbox,
          streamReader,
          { metadata }
        )
      ).toEqual(request);
      expect((client as any).generateRequest).toHaveBeenCalledTimes(1);
      expect((client as any).generateRequest).toHaveBeenLastCalledWith(
        "animals.Animals.CreateAnimal",
        RequestMethodType.BidiStreamRequest,
        { metadata }
      );
      expect(request.makeBidiStreamRequest).toHaveBeenCalledTimes(1);
      expect(request.makeBidiStreamRequest).toHaveBeenCalledWith(
        writeSandbox,
        streamReader
      );
    });
  });

  describe("abortRequests", () => {
    let abort1: AbortController;
    let abort2: AbortController;
    let abort3: AbortController;

    beforeEach(() => {
      abort1 = new AbortController();
      abort2 = new AbortController();
      abort3 = new AbortController();

      client.activeRequests = [
        new ProtoRequest<AnimalRequest, Animal>(
          client,
          "animals.Animals.GetAnimal",
          RequestMethodType.UnaryRequest,
          abort1
        ),
        new ProtoRequest<unknown, Animal>(
          client,
          "animals.Animals.GetAnimals",
          RequestMethodType.ServerStreamRequest,
          abort2
        ),
        new ProtoRequest<Animal, AnimalsResponse>(
          client,
          "animals.Animals.EditAnimal",
          RequestMethodType.ClientStreamRequest,
          abort3
        ),
      ];
    });

    test("string matching", () => {
      client.abortRequests("animals.Animals.GetAnimal");
      expect(abort1.signal.aborted).toStrictEqual(true);
      expect(abort2.signal.aborted).toStrictEqual(false);
      expect(abort3.signal.aborted).toStrictEqual(false);
    });

    test("regex matching", () => {
      client.abortRequests(/\.EditAnimal$/);
      expect(abort1.signal.aborted).toStrictEqual(false);
      expect(abort2.signal.aborted).toStrictEqual(false);
      expect(abort3.signal.aborted).toStrictEqual(true);
    });

    test("function matching", () => {
      client.abortRequests((method) => method === "animals.Animals.GetAnimals");
      expect(abort1.signal.aborted).toStrictEqual(false);
      expect(abort2.signal.aborted).toStrictEqual(true);
      expect(abort3.signal.aborted).toStrictEqual(false);
    });
  });

  test("close should just close the client", () => {
    const rpcClient = client.getClient(request);
    jest.spyOn(rpcClient, "close").mockImplementation(() => undefined);
    jest.spyOn(client, "abortRequests");

    client.close();
    expect(client.abortRequests).toHaveBeenCalledTimes(1);
    expect(rpcClient.close).toHaveBeenCalledTimes(1);

    // rpcClient should be removed after closed, requiring a reconfigure
    expect(() => client.getClient(request)).toThrow(
      `ProtoClient is not yet configured`
    );
  });

  describe("generateRequest", () => {
    let middleware1: RequestMiddleware;
    let middleware2: RequestMiddleware;
    let middleware3: RequestMiddleware;

    beforeEach(() => {
      middleware1 = jest.fn().mockResolvedValue(undefined);
      middleware2 = jest.fn().mockResolvedValue(undefined);
      middleware3 = jest.fn().mockResolvedValue(undefined);

      client.useMiddleware(middleware1);
      client.useMiddleware(middleware2);
      client.useMiddleware(middleware3);
    });

    test("successful generation", async () => {
      const request = await (client as any).generateRequest(
        "animals.Animals.GetAnimal",
        RequestMethodType.UnaryRequest,
        undefined
      );

      expect(middleware1).toHaveBeenCalledTimes(1);
      expect(middleware1).toHaveBeenLastCalledWith(request, client);
      expect(middleware2).toHaveBeenCalledTimes(1);
      expect(middleware3).toHaveBeenCalledTimes(1);
    });

    test("error instance throwing", async () => {
      (middleware2 as jest.Mock).mockRejectedValue(
        new Error("Rejected Error Instance")
      );
      await expect(
        (client as any).generateRequest(
          "animals.Animals.GetAnimal",
          RequestMethodType.UnaryRequest,
          undefined
        )
      ).rejects.toThrow(`Rejected Error Instance`);

      expect(middleware1).toHaveBeenCalledTimes(1);
      expect(middleware1).toHaveBeenLastCalledWith(
        expect.any(ProtoRequest),
        client
      );
      expect(middleware2).toHaveBeenCalledTimes(1);
      expect(middleware3).not.toHaveBeenCalled();
    });

    test("error string throwing", async () => {
      (middleware2 as jest.Mock).mockRejectedValue("Rejected Error String");
      await expect(
        (client as any).generateRequest(
          "animals.Animals.GetAnimal",
          RequestMethodType.UnaryRequest,
          undefined
        )
      ).rejects.toThrow(`Rejected Error String`);

      expect(middleware1).toHaveBeenCalledTimes(1);
      expect(middleware1).toHaveBeenLastCalledWith(
        expect.any(ProtoRequest),
        client
      );
      expect(middleware2).toHaveBeenCalledTimes(1);
      expect(middleware3).not.toHaveBeenCalled();
    });

    test("unknown error throwing", async () => {
      (middleware2 as jest.Mock).mockRejectedValue({ random: "object-thrown" });
      await expect(
        (client as any).generateRequest(
          "animals.Animals.GetAnimal",
          RequestMethodType.UnaryRequest,
          undefined
        )
      ).rejects.toThrow(`Unknown Middleware Error: [object Object]`);

      expect(middleware1).toHaveBeenCalledTimes(1);
      expect(middleware1).toHaveBeenLastCalledWith(
        expect.any(ProtoRequest),
        client
      );
      expect(middleware2).toHaveBeenCalledTimes(1);
      expect(middleware3).not.toHaveBeenCalled();
    });
  });

  describe("generateEndpointMatcher", () => {
    test("should match everything if match is undefined", () => {
      const matcher = (client as any).generateEndpointMatcher();
      expect(matcher).toBeInstanceOf(Function);
      expect(matcher(request.method, request)).toStrictEqual(true);
    });

    test("should match string paths exactly", () => {
      const matcher = (client as any).generateEndpointMatcher(`foo.bar.baz`);
      expect(matcher).toBeInstanceOf(Function);
      expect(matcher("foo.bar.baz", request)).toStrictEqual(true);
      expect(matcher("foo.foo.bar", request)).toStrictEqual(false);
    });

    test("should match service or namespace when defined", () => {
      let matcher = (client as any).generateEndpointMatcher(`foo.bar.*`);
      expect(matcher).toBeInstanceOf(Function);
      expect(matcher("foo.bar.baz", request)).toStrictEqual(true);
      expect(matcher("foo.bar.bar", request)).toStrictEqual(true);
      expect(matcher("foo.baz.foo", request)).toStrictEqual(false);

      matcher = (client as any).generateEndpointMatcher(`foo.*`);
      expect(matcher("foo.bar.baz", request)).toStrictEqual(true);
      expect(matcher("foo.bar.bar", request)).toStrictEqual(true);
      expect(matcher("foo.baz.foo", request)).toStrictEqual(true);
      expect(matcher("bar.foo.baz", request)).toStrictEqual(false);
    });

    test("should use regex matching when defined", () => {
      const matcher = (client as any).generateEndpointMatcher(/^foo\.bar/);
      expect(matcher).toBeInstanceOf(Function);
      expect(matcher("foo.bar.baz", request)).toStrictEqual(true);
      expect(matcher("foo.baz.bar", request)).toStrictEqual(false);
    });

    test("should use filter matching when defined", () => {
      const matcher = (client as any).generateEndpointMatcher(
        (method: string) => method === "foo.bar.baz"
      );
      expect(matcher).toBeInstanceOf(Function);
      expect(matcher("foo.bar.baz", request)).toStrictEqual(true);
      expect(matcher("foo.baz.bar", request)).toStrictEqual(false);
    });
  });
});
