/* eslint-disable @typescript-eslint/no-explicit-any */
import { status } from "@grpc/grpc-js";
import { ProtoClient, ProtoRequest, RequestMethodType } from "../src";
import { RequestError } from "../src/RequestError";
import { PROTO_FILE_PATHS } from "./utils";

describe("RequestError", () => {
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

  test("should assign parameters and auto set code to aborted", () => {
    const error = new RequestError(status.CANCELLED, request);
    expect(error.message).toStrictEqual(
      `Cancelled makeUnaryRequest for 'animals.Animals.GetAnimal'`
    );
    expect(error.code).toStrictEqual(status.CANCELLED);
    expect(error.metadata).toStrictEqual(request.metadata);
  });

  test("should assign default details to non-special codes", () => {
    const error = new RequestError(status.INTERNAL, request);
    expect(error.message).toStrictEqual(
      `13 INTERNAL: makeUnaryRequest for 'animals.Animals.GetAnimal'`
    );
    expect(error.code).toStrictEqual(status.INTERNAL);
    expect(error.metadata).toStrictEqual(request.metadata);
  });
});
