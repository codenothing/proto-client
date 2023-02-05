import { loadSync } from "@grpc/proto-loader";
import {
  loadPackageDefinition,
  Server,
  ServerCredentials,
  UntypedServiceImplementation,
} from "@grpc/grpc-js";
import {
  ProtoClient,
  RequestOptions,
  StreamReader,
  StreamWriterSandbox,
} from "../src";
import { promisify } from "util";

let activeServers: Server[] = [];
let activeClient: ProtoClient | undefined;

export interface Customer {
  id?: string;
  name?: string;
}

export interface GetCustomerRequest {
  id?: string;
}

export interface FindCustomersRequest {
  name?: string;
}

export interface CustomersResponse {
  customers?: Customer[];
}

export const PROTO_FILE_PATHS: string[] = [
  `${__dirname}/protos/customers.proto`,
  `${__dirname}/protos/products.proto`,
];

export const wait = (time?: number) =>
  new Promise((resolve) => setTimeout(resolve, time || 5));

export const getClient = () => {
  if (!activeClient) {
    throw new Error(`Need to run startServer before getting active client`);
  }

  return activeClient;
};

export const makeUnaryRequest = (
  data?: GetCustomerRequest,
  requestOptions?: RequestOptions | AbortController
) =>
  getClient().makeUnaryRequest<GetCustomerRequest, Customer>(
    "customers.Customers.GetCustomer",
    data as GetCustomerRequest,
    requestOptions as RequestOptions
  );

export const makeClientStreamRequest = (
  writerSandbox: StreamWriterSandbox<Customer, CustomersResponse>,
  requestOptions?: RequestOptions | AbortController
) =>
  getClient().makeClientStreamRequest<Customer, CustomersResponse>(
    "customers.Customers.EditCustomer",
    writerSandbox,
    requestOptions as RequestOptions
  );

export const makeServerStreamRequest = (
  data: FindCustomersRequest | StreamReader<FindCustomersRequest, Customer>,
  streamReader?: StreamReader<FindCustomersRequest, Customer>,
  requestOptions?: RequestOptions | AbortController
) =>
  getClient().makeServerStreamRequest<FindCustomersRequest, Customer>(
    "customers.Customers.FindCustomers",
    data as FindCustomersRequest,
    streamReader as StreamReader<FindCustomersRequest, Customer>,
    requestOptions as RequestOptions
  );

export const makeBidiStreamRequest = (
  writerSandbox: StreamWriterSandbox<Customer, Customer>,
  streamReader: StreamReader<Customer, Customer>,
  requestOptions?: RequestOptions | AbortController
) =>
  getClient().makeBidiStreamRequest<Customer, Customer>(
    "customers.Customers.CreateCustomers",
    writerSandbox,
    streamReader,
    requestOptions as RequestOptions
  );

export const generateProtoServer = async (
  serviceImpl: UntypedServiceImplementation
) => {
  const packageDefinition = loadSync(PROTO_FILE_PATHS, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const customersProto = loadPackageDefinition(packageDefinition).customers;

  const server = new Server();
  activeServers.push(server);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.addService((customersProto as any).Customers.service, serviceImpl);

  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync(
      "0.0.0.0:0",
      ServerCredentials.createInsecure(),
      (e, port) => {
        if (e) {
          reject(e);
        } else {
          server.start();
          resolve(port);
        }
      }
    );
  });

  return { server, port };
};

export const startServer = async (
  serviceImpl: UntypedServiceImplementation
) => {
  jest.useRealTimers();

  const results = await generateProtoServer(serviceImpl);

  activeClient = new ProtoClient({
    clientSettings: {
      endpoint: `0.0.0.0:${results.port}`,
    },
    protoSettings: {
      files: PROTO_FILE_PATHS,
    },
  });

  return { client: activeClient, ...results };
};

afterEach(async () => {
  activeClient?.close();
  for (const server of activeServers) {
    await promisify(server.tryShutdown.bind(server))();
  }

  activeClient = undefined;
  activeServers = [];
});
