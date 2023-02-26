import { ProtoClient, ProtoRequest, RequestMethodType } from "../src";
import { UntypedProtoRequest } from "../src/untyped";
import { generateEndpointMatcher, normalizeRetryOptions } from "../src/util";
import { PROTO_FILE_PATHS } from "./utils";

describe("util", () => {
  let request: UntypedProtoRequest;

  beforeEach(() => {
    const client = new ProtoClient({
      clientSettings: {
        endpoint: {
          address: `0.0.0.0:8081`,
        },
        rejectOnAbort: true,
      },
      protoSettings: {
        files: PROTO_FILE_PATHS,
      },
    });

    request = new ProtoRequest<unknown, unknown>(
      {
        method: "customers.Customers.GetCustomer",
        requestMethodType: RequestMethodType.UnaryRequest,
      },
      client
    );
  });

  describe("generateEndpointMatcher", () => {
    test("should match everything if match is undefined", () => {
      const matcher = generateEndpointMatcher();
      expect(matcher).toBeInstanceOf(Function);
      expect(matcher(request.method, request)).toStrictEqual(true);
    });

    test("should match string paths exactly", () => {
      const matcher = generateEndpointMatcher(`foo.bar.baz`);
      expect(matcher).toBeInstanceOf(Function);
      expect(matcher("foo.bar.baz", request)).toStrictEqual(true);
      expect(matcher("foo.foo.bar", request)).toStrictEqual(false);
    });

    test("should match service or namespace when defined", () => {
      let matcher = generateEndpointMatcher(`foo.bar.*`);
      expect(matcher).toBeInstanceOf(Function);
      expect(matcher("foo.bar.baz", request)).toStrictEqual(true);
      expect(matcher("foo.bar.bar", request)).toStrictEqual(true);
      expect(matcher("foo.baz.foo", request)).toStrictEqual(false);

      matcher = generateEndpointMatcher(`foo.*`);
      expect(matcher("foo.bar.baz", request)).toStrictEqual(true);
      expect(matcher("foo.bar.bar", request)).toStrictEqual(true);
      expect(matcher("foo.baz.foo", request)).toStrictEqual(true);
      expect(matcher("bar.foo.baz", request)).toStrictEqual(false);
    });

    test("should use regex matching when defined", () => {
      const matcher = generateEndpointMatcher(/^foo\.bar/);
      expect(matcher).toBeInstanceOf(Function);
      expect(matcher("foo.bar.baz", request)).toStrictEqual(true);
      expect(matcher("foo.baz.bar", request)).toStrictEqual(false);
    });

    test("should use filter matching when defined", () => {
      const matcher = generateEndpointMatcher(
        (method: string) => method === "foo.bar.baz"
      );
      expect(matcher).toBeInstanceOf(Function);
      expect(matcher("foo.bar.baz", request)).toStrictEqual(true);
      expect(matcher("foo.baz.bar", request)).toStrictEqual(false);
    });
  });

  describe("normalizeRetryOptions", () => {
    test("should handle the various permutations to retryOptions", () => {
      expect(normalizeRetryOptions(undefined)).toStrictEqual(undefined);
      expect(normalizeRetryOptions(true)).toStrictEqual({ retryCount: 1 });
      expect(normalizeRetryOptions(false)).toStrictEqual({ retryCount: 0 });
      expect(normalizeRetryOptions(15)).toStrictEqual({ retryCount: 15 });
    });
  });
});
