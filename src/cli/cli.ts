import { pbjs, pbts } from "protobufjs-cli";
import yargs from "yargs";
import color from "cli-color";
import { hideBin } from "yargs/helpers";
import { promises } from "fs";
import { promisify } from "util";
import { AddMethodsParams, FileBuilder } from "./FileBuilder";

interface Method {
  requestType: string;
  responseType: string;
  requestStream?: boolean;
  responseStream?: boolean;
}

interface ServiceMethodChain {
  [key: string]: {
    namespace: string;
    methods: Record<string, Method & { namespace: string }>;
    nested: ServiceMethodChain;
  };
}

interface RawProtos {
  methods?: {
    [key: string]: Method;
  };
  nested?: {
    [key: string]: RawProtos;
  };
}

/**
 * Cli runner to building typed endpoints for protos defined
 * @private
 * @package
 */
export class ProtoCli {
  public protoPackagePath = "proto-client";
  public protoFiles: string[] = [];
  public rawProtos: RawProtos = {};
  public serviceMethodChain: ServiceMethodChain = {};

  // Cli Args used for parsing
  public argv: string[];

  // Parsed cli options
  public outputDirectory = "";
  public keepCase = false;
  public forceLong = false;
  public forceNumber = false;
  public includePaths: string[] = [];

  constructor(argv: string[]) {
    this.argv = argv;
  }

  // Number conversion argument for pbjs
  public get numberConversion(): string {
    return this.forceLong
      ? `--force-long`
      : this.forceNumber
      ? "--force-number"
      : "";
  }

  // Adds directory include paths to arguments lists
  public get includeDirectoryArgs(): string[] {
    const args: string[] = [];
    this.includePaths.forEach((path) => args.push("-p", path));
    return args;
  }

  // Centralized runner
  public async run() {
    const now = Date.now();

    // Parse CLI Args
    await this.parseArgv();

    // Build out files using protobufjs-cli
    await this.writeRawProtos();
    await this.writeProtosJs();
    await this.writeProtosTypes();

    // Compile client method shortcuts
    this.compileServiceMethods(this.rawProtos, []);
    await this.writeClientJs();
    await this.writeClientTypes();

    // Log the result
    console.log(
      `\n`,
      color.green(`All files generated in ${Date.now() - now}ms`)
    );
  }

  // Logging error and exiting the process
  public exitWithError(message: string, error?: Error | unknown) {
    console.log(color.red(message));
    if (error) {
      console.error(error);
    }
    process.exit(1);
  }

  // Logging filename with check mark
  public logFileWritten(filename: string) {
    console.log(color.green(`✔ ${filename}`));
  }

  // Parsing CLI arguments
  public async parseArgv() {
    const argv = await yargs(hideBin(this.argv))
      .usage("proto-client [options] file1.proto file2.proto ...")
      .option("output", {
        alias: "o",
        describe: "Output directory for compiled files",
        type: "string",
      })
      .option("path", {
        alias: "p",
        describe: "Adds a directory to the include path",
        type: "string",
        array: true,
      })
      .option("keep-case", {
        describe: "Keeps field casing instead of converting to camel case",
        type: "boolean",
      })
      .option("force-long", {
        describe:
          "Enforces the use of 'Long' for s-/u-/int64 and s-/fixed64 fields",
        type: "boolean",
      })
      .option("force-number", {
        describe:
          "Enforces the use of 'number' for s-/u-/int64 and s-/fixed64 fields",
        type: "boolean",
      })
      .help().argv;

    this.outputDirectory = argv.output || process.cwd();
    this.keepCase = argv.keepCase || false;
    this.forceLong = argv.forceLong || false;
    this.forceNumber = argv.forceNumber || false;
    this.includePaths = argv.path || [];
    this.protoFiles = argv._ as string[];

    try {
      const stat = await promises.stat(this.outputDirectory);
      if (!stat.isDirectory()) {
        this.exitWithError(
          `Output path '${this.outputDirectory}' is not a directory`
        );
      }
    } catch (e) {
      this.exitWithError(
        `Output path '${this.outputDirectory}' could not be found`,
        e
      );
    }
  }

  // Writing json representation of the raw protos
  public async writeRawProtos() {
    try {
      await promisify(pbjs.main.bind(pbjs))(
        [
          "-t",
          "json",
          this.keepCase ? "--keep-case" : "",
          ...this.includeDirectoryArgs,
          "-o",
          `${this.outputDirectory}/raw-protos.json`,
          ...this.protoFiles,
        ].filter(Boolean)
      );
      this.logFileWritten(`raw-protos.json`);
    } catch (e) {
      this.exitWithError(
        `Failed to write raw-protos.json: ${(e as Error).message}`,
        e
      );
    }

    try {
      const contents = await promises.readFile(
        `${this.outputDirectory}/raw-protos.json`,
        `utf-8`
      );
      this.rawProtos = JSON.parse(contents);
    } catch (e) {
      this.exitWithError(
        `Unable to read raw-protos.json: ${(e as Error).message}`,
        e
      );
    }
  }

  // Write JS converted protos
  public async writeProtosJs() {
    try {
      await promisify(pbjs.main.bind(pbjs))(
        [
          `-t`,
          `static-module`,
          `-w`,
          `commonjs`,
          this.keepCase ? "--keep-case" : "",
          this.numberConversion,
          ...this.includeDirectoryArgs,
          `--no-create`,
          `--no-encode`,
          `--no-decode`,
          `--no-verify`,
          `--no-convert`,
          `--no-delimited`,
          `--es6`,
          "-o",
          `${this.outputDirectory}/protos.js`,
          ...this.protoFiles,
        ].filter(Boolean)
      );
      this.logFileWritten(`protos.js`);
    } catch (e) {
      this.exitWithError(
        `Failed to write protos.js: ${(e as Error).message}`,
        e
      );
    }
  }

  // Write out types of the js protos
  public async writeProtosTypes() {
    try {
      await promisify(pbts.main.bind(pbts))([
        "-o",
        `${this.outputDirectory}/protos.d.ts`,
        `${this.outputDirectory}/protos.js`,
      ]);
      this.logFileWritten(`protos.d.ts`);
    } catch (e) {
      this.exitWithError(
        `Failed to write protos.d.ts: ${(e as Error).message}`,
        e
      );
    }
  }

  // Scans for all service methods from the proto files provided
  public compileServiceMethods(rawProto: RawProtos, chain: string[]) {
    if (!rawProto.nested) {
      return;
    }

    for (const key in rawProto.nested) {
      const subProto = rawProto.nested[key];

      if (subProto.methods) {
        // Prefill the service chain
        let serviceMethodChain = this.serviceMethodChain;
        chain.forEach((name) => {
          serviceMethodChain[name] = serviceMethodChain[name] || {
            nested: {},
            methods: {},
            namespace: "",
          };
          serviceMethodChain = serviceMethodChain[name].nested;
        });

        // Default the current service chain
        const service = serviceMethodChain[key] || {
          nested: {},
          methods: {},
          namespace: [...chain, key].join("."),
        };
        serviceMethodChain[key] = service;

        // Attach request methods
        for (const name in subProto.methods) {
          const method = subProto.methods[name];
          service.methods[name] = {
            requestType:
              subProto.nested && subProto.nested[method.requestType]
                ? `${[...chain, key].join(".")}.I${method.requestType}`
                : `${chain.join(".")}.I${method.requestType}`,
            responseType:
              subProto.nested && subProto.nested[method.responseType]
                ? `${[...chain, key].join(".")}.I${method.responseType}`
                : `${chain.join(".")}.I${method.responseType}`,
            requestStream: method.requestStream,
            responseStream: method.responseStream,
            namespace: [...chain, key, name].join("."),
          };
        }
      }

      this.compileServiceMethods(subProto, [...chain, key]);
    }
  }

  // Builds out client JS shortcuts
  public async writeClientJs() {
    const builder = new FileBuilder(`${this.outputDirectory}/client.js`);
    builder.push(
      `const { ProtoClient } = require("${this.protoPackagePath}");`,
      ``,
      `/**`,
      ` * Configured protoClient used for client shortcuts`,
      ` */`,
      `const protoClient = module.exports.protoClient = new ProtoClient({`,
      `  protoSettings: {`,
      `    files: __dirname + "/raw-protos.json",`,
      `    parseOptions: {`,
      `      keepCase: ${this.keepCase},`,
      `    },`,
      `    conversionOptions: {`,
      `      longs: ${this.forceNumber ? "Number" : "undefined"},`,
      `    },`,
      `  }`,
      `});`
    );

    for (const chainName in this.serviceMethodChain) {
      builder.newline();
      builder.push(
        `/**`,
        ` * ${chainName} Package`,
        ` * @namespace ${chainName}`,
        ` */`,
        `module.exports.${chainName} = {`
      );
      builder.indent();
      this.clientJsMethodChain(
        this.serviceMethodChain[chainName].nested,
        builder
      );
      builder.deindent();
      builder.push(`};`);
    }

    await builder.write();
  }

  // Nested looping to build namespaces and service methods
  public clientJsMethodChain(
    serviceChain: ServiceMethodChain,
    builder: FileBuilder
  ) {
    for (const [chainName, subChain] of Object.entries(serviceChain)) {
      // Chain entry is a service
      if (Object.keys(subChain.methods).length) {
        builder.push(
          `/**`,
          ` * ${chainName} Service`,
          ` * @namespace ${chainName}`,
          ` */`,
          `${chainName}: {`
        );
        builder.indent();

        // Attach all methods
        for (const [methodName, method] of Object.entries(subChain.methods)) {
          const reqResType = `${method.requestType}, ${method.responseType}`;
          const returnType = `ProtoRequest<${reqResType}>`;

          // Open method wrapper
          builder.push(
            `/**`,
            ` * Request generation for ${methodName}`,
            ` */`,
            `${methodName}: (() => {`
          );

          // Bidirectional
          if (method.requestStream && method.responseStream) {
            builder.pushWithIndent(
              `/**`,
              ` * Bidirectional Request to ${method.namespace}`,
              ` * @param {StreamWriterSandbox<${method.requestType}> | Readable | EventEmitter} [writerSandbox] Optional async supported callback for writing data to the open stream`,
              ` * @param {StreamReader<${method.responseType}>} [streamReader] Optional iteration function that will be called on every response chunk`,
              ` * @param {AbortController | RequestOptions} [requestOptions] Optional request options for this specific request`,
              ` * @returns {Promise<${returnType}>} Request instance`,
              ` */`,
              `const ${methodName} = async (writerSandbox, streamReader, requestOptions) =>`,
              `${builder.indentCharacter}protoClient.makeBidiStreamRequest("${method.namespace}", writerSandbox, streamReader, requestOptions);`,
              `/**`,
              ` * Triggers bidirectional request to ${method.namespace}, returning the ProtoRequest instance`,
              ` * @param {StreamWriterSandbox<${method.requestType}> | Readable | EventEmitter} [writerSandbox] Optional async supported callback for writing data to the open stream`,
              ` * @param {StreamReader<${method.responseType}>} [streamReader] Optional iteration function that will be called on every response chunk`,
              ` * @param {AbortController | RequestOptions} [requestOptions] Optional request options for this specific request`,
              ` * @returns {${returnType}} Request instance`,
              ` */`,
              `${methodName}.get = (writerSandbox, streamReader, requestOptions) =>`,
              `${builder.indentCharacter}protoClient.getBidiStreamRequest("${method.namespace}", writerSandbox, streamReader, requestOptions);`,
              `return ${methodName};`
            );
          }
          // Server Stream
          else if (method.responseStream) {
            builder.pushWithIndent(
              `/**`,
              ` * Server Stream Request to ${method.namespace}`,
              ` * @param {${method.requestType} | StreamReader<${method.responseType}>} [data] Optional data to be sent as part of the request`,
              ` * @param {StreamReader<${method.responseType}>} [streamReader] Optional iteration function that will be called on every response chunk`,
              ` * @param {AbortController | RequestOptions} [requestOptions] Optional request options for this specific request`,
              ` * @returns {Promise<${returnType}>} Request instance`,
              ` */`,
              `const ${methodName} = async (data, streamReader, requestOptions) =>`,
              `${builder.indentCharacter}protoClient.makeServerStreamRequest("${method.namespace}", data, streamReader, requestOptions);`,
              `/**`,
              ` * Triggers server stream request to ${method.namespace}, returning the ProtoRequest instance`,
              ` * @param {${method.requestType} | StreamReader<${method.responseType}>} [data] Optional data to be sent as part of the request`,
              ` * @param {StreamReader<${method.responseType}>} [streamReader] Optional iteration function that will be called on every response chunk`,
              ` * @param {AbortController | RequestOptions} [requestOptions] Optional request options for this specific request`,
              ` * @returns {${returnType}} Request instance`,
              ` */`,
              `${methodName}.get = (data, streamReader, requestOptions) =>`,
              `${builder.indentCharacter}protoClient.getServerStreamRequest("${method.namespace}", data, streamReader, requestOptions);`,
              `return ${methodName};`
            );
          }
          // Server Stream
          else if (method.requestStream) {
            builder.pushWithIndent(
              `/**`,
              ` * Client Stream Request to ${method.namespace}`,
              ` * @param {StreamWriterSandbox<${method.requestType}> | Readable | EventEmitter} [writerSandbox] Optional async supported callback for writing data to the open stream`,
              ` * @param {AbortController | RequestOptions} [requestOptions] Optional request options for this specific request`,
              ` * @returns {Promise<${returnType}>} Request instance`,
              ` */`,
              `const ${methodName} = async (writerSandbox, requestOptions) =>`,
              `${builder.indentCharacter}protoClient.makeClientStreamRequest("${method.namespace}", writerSandbox, requestOptions);`,
              `/**`,
              ` * Triggers client stream request to ${method.namespace}, returning the ProtoRequest instance`,
              ` * @param {StreamWriterSandbox<${method.requestType}> | Readable | EventEmitter} [writerSandbox] Optional async supported callback for writing data to the open stream`,
              ` * @param {AbortController | RequestOptions} [requestOptions] Optional request options for this specific request`,
              ` * @returns {${returnType}} Request instance`,
              ` */`,
              `${methodName}.get = (writerSandbox, requestOptions) =>`,
              `${builder.indentCharacter}protoClient.getClientStreamRequest("${method.namespace}", writerSandbox, requestOptions);`,
              `return ${methodName};`
            );
          }
          // Unary Request
          else {
            builder.pushWithIndent(
              `/**`,
              ` * Unary Request to ${method.namespace}`,
              ` * @param {${method.requestType} | null} [data] Optional Data to be sent as part of the request. Defaults to empty object`,
              ` * @param {AbortController | RequestOptions} [requestOptions] Optional request options for this specific request`,
              ` * @returns {Promise<${returnType}>} Request instance`,
              ` */`,
              `const ${methodName} = async (data, requestOptions) =>`,
              `${builder.indentCharacter}protoClient.makeUnaryRequest("${method.namespace}", data, requestOptions);`,
              `/**`,
              ` * Triggers unary request to ${method.namespace}, returning the ProtoRequest instance`,
              ` * @param {${method.requestType} | null} [data] Optional Data to be sent as part of the request. Defaults to empty object`,
              ` * @param {AbortController | RequestOptions} [requestOptions] Optional request options for this specific request`,
              ` * @returns {${returnType}} Request instance`,
              ` */`,
              `${methodName}.get = (data, requestOptions) =>`,
              `${builder.indentCharacter}protoClient.getUnaryRequest("${method.namespace}", data, requestOptions);`,
              `return ${methodName};`
            );
          }

          // Close out the method wrapper
          builder.push(`})(),`);
        }

        // Close out service
        builder.deindent();
        builder.push(`},`);
      }
      // Keep digging
      else if (Object.keys(subChain.nested).length) {
        builder.push(
          `/**`,
          ` * ${chainName} Package`,
          ` * @namespace ${chainName}`,
          ` */`,
          `${chainName}: {`
        );
        builder.indent();
        this.clientJsMethodChain(subChain.nested, builder);
        builder.deindent();
        builder.push(`},`);
      }
    }
  }

  // Writing types for client shortcuts
  public async writeClientTypes() {
    const builder = new FileBuilder(`${this.outputDirectory}/client.d.ts`);

    builder.push(
      `import { ProtoClient, ProtoRequest, RequestOptions, StreamWriterSandbox, StreamReader } from "${this.protoPackagePath}";`,
      `import { Readable , EventEmitter } from "stream";`,
      `import protos from "./protos";`,
      ``,
      `/**`,
      ` * Configured protoClient used for client shortcuts`,
      ` */`,
      `export const protoClient: ProtoClient;`
    );

    for (const chainName in this.serviceMethodChain) {
      builder.newline();
      builder.push(
        `/**`,
        ` * ${chainName} Package`,
        ` * @namespace ${chainName}`,
        ` */`,
        `export namespace ${chainName} {`
      );
      builder.indent();
      this.clientTypesMethodChain(
        this.serviceMethodChain[chainName].nested,
        builder
      );
      builder.deindent();
      builder.push(`}`);
    }

    await builder.write();
  }

  // Builds nested namespaces and service method typings
  public clientTypesMethodChain(
    serviceChain: ServiceMethodChain,
    builder: FileBuilder
  ) {
    for (const [chainName, subChain] of Object.entries(serviceChain)) {
      // Chain entry is a service
      if (Object.keys(subChain.methods).length) {
        builder.push(
          `/**`,
          ` * ${chainName} Service`,
          ` * @namespace ${chainName}`,
          ` */`,
          `namespace ${chainName} {`
        );
        builder.indent();

        // Attach all methods
        for (const [methodName, method] of Object.entries(subChain.methods)) {
          const requestType = `protos.${method.requestType}`;
          const responseType = `protos.${method.responseType}`;
          const reqResType = `${requestType}, ${responseType}`;
          const returnType = `ProtoRequest<${reqResType}>`;

          const args: AddMethodsParams["args"] = {
            data: {
              type: `${requestType} | null`,
              shortType: `${requestType} | null`,
              desc: `Data to be sent as part of the request`,
            },
            writerSandbox: {
              type: `StreamWriterSandbox<${reqResType}>`,
              shortType: `StreamWriterSandbox`,
              desc: `Async supported callback for writing data to the open stream`,
            },
            stream: {
              type: `Readable | EventEmitter`,
              shortType: `Readable | EventEmitter`,
              desc: `Readable like stream for piping into the request stream`,
            },
            streamReader: {
              type: `StreamReader<${reqResType}>`,
              shortType: `StreamReader`,
              desc: `Iteration function that will be called on every response chunk`,
            },
            abortController: {
              type: `AbortController`,
              shortType: `AbortController`,
              desc: `Data to be sent as part of the request`,
            },
            requestOptions: {
              type: `RequestOptions`,
              shortType: `RequestOptions`,
              desc: `Request options for this specific request`,
            },
          };

          builder.push(
            `/**`,
            ` * Request generation for ${method.namespace}`,
            ` */`,
            `const ${methodName}: {`
          );
          builder.indent();

          // Bidirectional
          if (method.requestStream && method.responseStream) {
            builder.addTypedMethods({
              methodType: `Bidirectional Stream`,
              namespace: method.namespace,
              returnType,
              args,
              combos: [
                [],
                ["writerSandbox"],
                ["writerSandbox", "streamReader"],
                ["writerSandbox", "streamReader", "abortController"],
                ["writerSandbox", "streamReader", "requestOptions"],
                ["stream"],
                ["stream", "streamReader"],
                ["stream", "streamReader", "abortController"],
                ["stream", "streamReader", "requestOptions"],
              ],
            });
          }
          // Server Stream
          else if (method.responseStream) {
            builder.addTypedMethods({
              methodType: `Server Stream`,
              namespace: method.namespace,
              returnType,
              args,
              combos: [
                [],
                ["streamReader"],
                ["data"],
                ["data", "streamReader"],
                ["data", "streamReader", "abortController"],
                ["data", "streamReader", "requestOptions"],
              ],
            });
          }
          // Server Stream
          else if (method.requestStream) {
            builder.addTypedMethods({
              methodType: `Client Stream`,
              namespace: method.namespace,
              returnType,
              args,
              combos: [
                [],
                ["writerSandbox"],
                ["writerSandbox", "abortController"],
                ["writerSandbox", "requestOptions"],
                ["stream"],
                ["stream", "abortController"],
                ["stream", "requestOptions"],
              ],
            });
          }
          // Unary Request
          else {
            builder.addTypedMethods({
              methodType: `Unary`,
              namespace: method.namespace,
              returnType,
              args,
              combos: [
                [],
                ["data"],
                ["data", "abortController"],
                ["data", "requestOptions"],
              ],
            });
          }

          // Close of method interface
          builder.deindent();
          builder.push(`}`);
        }

        // Close off service
        builder.deindent();
        builder.push(`}`);
      }
      // Keep digging
      else if (Object.keys(subChain.nested).length) {
        builder.push(
          `/**`,
          ` * ${chainName} Package`,
          ` * @namespace ${chainName}`,
          ` */`,
          `namespace ${chainName} {`
        );
        builder.indent();
        this.clientTypesMethodChain(subChain.nested, builder);
        builder.deindent();
        builder.push(`}`);
      }
    }
  }
}

/**
 * CLI auto runner, parses process.ARGV and runs from there
 */
export async function cli() {
  await new ProtoCli(process.argv).run();
}
