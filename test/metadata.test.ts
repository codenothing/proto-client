import {
  ServerUnaryCall,
  sendUnaryData,
  status,
  Metadata,
} from "@grpc/grpc-js";
import {
  Customer,
  GetCustomerRequest,
  makeUnaryRequest,
  startServer,
} from "./utils";
import { MockServiceError } from "./MockServiceError";

describe("metadata", () => {
  beforeEach(async () => {
    await startServer({
      GetCustomer: (
        call: ServerUnaryCall<GetCustomerRequest, Customer>,
        callback: sendUnaryData<Customer>
      ) => {
        if (call.metadata.get("auth_token")?.[0] !== "foobar") {
          callback(
            new MockServiceError(status.INTERNAL, "Missing auth_token metadata")
          );
        } else {
          const responseMetadata = new Metadata();
          responseMetadata.set("updated_auth_token", "bazboo");
          call.sendMetadata(responseMetadata);

          callback(null, { id: "github", name: "Github" });
        }
      },
    });
  });

  test("should convert object to metadata and verify the updated auth token coming back from the server", async () => {
    const request = await makeUnaryRequest(
      { id: "github" },
      {
        metadata: {
          auth_token: "foobar",
          companies: ["github", "npm", "circleci"],
        },
      }
    );
    expect(request.metadata.get("auth_token")).toEqual(["foobar"]);
    expect(request.metadata.get("companies")).toEqual([
      "github",
      "npm",
      "circleci",
    ]);
    expect(request.responseMetadata?.get(`updated_auth_token`)).toEqual([
      "bazboo",
    ]);
  });

  test("should verify the updated auth token through a metadata instance", async () => {
    const metadata = new Metadata();
    metadata.set("auth_token", "foobar");

    const request = await makeUnaryRequest({ id: "github" }, { metadata });
    expect(request.responseMetadata?.get(`updated_auth_token`)).toEqual([
      "bazboo",
    ]);
  });

  test("should fail the request if auth token is invalid in metadata", async () => {
    await expect(
      makeUnaryRequest({ id: "github" }, { metadata: { auth_token: "barbaz" } })
    ).rejects.toThrow(`Missing auth_token metadata`);
  });
});
