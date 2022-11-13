import { pbjs, pbts } from "protobufjs-cli";
import yargs from "yargs";
import color from "cli-color";
import { hideBin } from "yargs/helpers";
import { promises } from "fs";
import { promisify } from "util";
import { FileBuilder } from "./FileBuilder";

interface Method {
  requestType: string;
  responseType: string;
  requestStream?: boolean;
  responseStream?: boolean;
}

interface ServiceMethodChain {
  [key: string]: {
    nested: ServiceMethodChain;
    method?: Method & {
      namespace: string;
    };
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

  // Logging filename with checkmark
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
      const subproto = rawProto.nested[key];

      if (subproto.methods) {
        let serviceMethodChain = this.serviceMethodChain;
        [...chain, key].forEach((name) => {
          serviceMethodChain[name] = serviceMethodChain[name] || { nested: {} };
          serviceMethodChain = serviceMethodChain[name].nested;
        });

        for (const name in subproto.methods) {
          const method = subproto.methods[name];
          serviceMethodChain[name] = {
            method: {
              requestType:
                subproto.nested && subproto.nested[method.requestType]
                  ? `${[...chain, key].join(".")}.I${method.requestType}`
                  : `${chain.join(".")}.I${method.requestType}`,
              responseType:
                subproto.nested && subproto.nested[method.responseType]
                  ? `${[...chain, key].join(".")}.I${method.responseType}`
                  : `${chain.join(".")}.I${method.responseType}`,
              requestStream: method.requestStream,
              responseStream: method.responseStream,
              namespace: [...chain, key, name].join("."),
            },
            nested: {},
          };
        }
      }

      this.compileServiceMethods(subproto, [...chain, key]);
    }
  }

  // Builds out client JS shortcuts
  public async writeClientJs() {
    const fileContents = new FileBuilder(`${this.outputDirectory}/client.js`);
    fileContents.push(
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

    for (const name in this.serviceMethodChain) {
      fileContents.newline();
      fileContents.push(`module.exports.${name} = {`);
      fileContents.indent();
      this.clientJsMethodChain(
        this.serviceMethodChain[name].nested,
        fileContents
      );
      fileContents.deindent();
      fileContents.push(`};`);
    }

    await fileContents.write();
  }

  // Nested looping to build namespaces and service methods
  public clientJsMethodChain(
    serviceChain: ServiceMethodChain,
    fileContents: FileBuilder
  ) {
    for (const name in serviceChain) {
      const subchain = serviceChain[name];

      if (subchain.method) {
        // Bidirectional
        if (subchain.method.requestStream && subchain.method.responseStream) {
          fileContents.push(
            `/**`,
            ` * Bidrectional Request to ${subchain.method.namespace}`,
            ` * @param writerSandbox Async supported callback for writing data to the open stream`,
            ` * @param streamReader Iteration function that will get called on every response chunk`,
            ` * @param requestOptions Optional AbortController or request options for this specific request`,
            ` */`,
            `${name}: async (writerSandbox, streamReader, requestOptions) =>`
          );
          fileContents.pushWithIndent(
            `protoClient.makeBidiStreamRequest("${subchain.method.namespace}", writerSandbox, streamReader, requestOptions),`
          );
        }
        // Server Stream
        else if (subchain.method.responseStream) {
          fileContents.push(
            `/**`,
            ` * Server Stream Request to ${subchain.method.namespace}`,
            ` * @param data Data to be sent as part of the request`,
            ` * @param streamReader Iteration function that will get called on every response chunk`,
            ` * @param requestOptions Optional AbortController or request options for this specific request`,
            ` */`,
            `${name}: async (data, streamReader, requestOptions) =>`
          );
          fileContents.pushWithIndent(
            `protoClient.makeServerStreamRequest("${subchain.method.namespace}", data, streamReader, requestOptions),`
          );
        }
        // Server Stream
        else if (subchain.method.requestStream) {
          fileContents.push(
            `/**`,
            ` * Client Stream Request to ${subchain.method.namespace}`,
            ` * @param writerSandbox Async supported callback for writing data to the open stream`,
            ` * @param requestOptions Optional AbortController or request options for this specific request`,
            ` */`,
            `${name}: async (writerSandbox, requestOptions) =>`
          );
          fileContents.pushWithIndent(
            `protoClient.makeClientStreamRequest("${subchain.method.namespace}", writerSandbox, requestOptions),`
          );
        }
        // Unary Request
        else {
          fileContents.push(
            `/**`,
            ` * Unary Request to ${subchain.method.namespace}`,
            ` * @param data Data to be sent as part of the request`,
            ` * @param requestOptions Optional AbortController or request options for this specific request`,
            ` */`,
            `${name}: async (data, requestOptions) =>`
          );
          fileContents.pushWithIndent(
            `protoClient.makeUnaryRequest("${subchain.method.namespace}", data, requestOptions),`
          );
        }
      }
    }

    for (const name in serviceChain) {
      if (Object.keys(serviceChain[name].nested).length) {
        fileContents.newline();
        fileContents.push(`${name}: {`);
        fileContents.indent();
        this.clientJsMethodChain(serviceChain[name].nested, fileContents);
        fileContents.deindent();
        fileContents.push(`},`);
      }
    }
  }

  // Writing types for client shortcuts
  public async writeClientTypes() {
    const fileContents = new FileBuilder(`${this.outputDirectory}/client.d.ts`);

    fileContents.push(
      `import { ProtoClient, ProtoRequest, RequestOptions, StreamWriterSandbox, StreamReader } from "${this.protoPackagePath}";`,
      `import protos from "./protos";`,
      ``,
      `/**`,
      ` * Configured protoClient used for client shortcuts`,
      ` */`,
      `export const protoClient: ProtoClient;`
    );

    for (const name in this.serviceMethodChain) {
      fileContents.newline();
      fileContents.push(
        `/** Namespace ${name} */`,
        `export namespace ${name} {`
      );
      fileContents.indent();
      this.clientTypesMethodChain(
        this.serviceMethodChain[name].nested,
        fileContents
      );
      fileContents.deindent();
      fileContents.push(`}`);
    }

    await fileContents.write();
  }

  // Builds nested namespaces and service method typings
  public clientTypesMethodChain(
    serviceChain: ServiceMethodChain,
    fileContents: FileBuilder
  ) {
    for (const name in serviceChain) {
      const subchain = serviceChain[name];

      if (subchain.method) {
        const requestType = `protos.${subchain.method.requestType}`;
        const responseType = `protos.${subchain.method.responseType}`;
        const reqResType = `${requestType}, ${responseType}`;
        const returnType = `Promise<ProtoRequest<${reqResType}>>`;

        // Bidirectional
        if (subchain.method.requestStream && subchain.method.responseStream) {
          fileContents.push(
            `/**`,
            ` * Bidrectional Request to ${subchain.method.namespace}`,
            ` * @param writerSandbox Async supported callback for writing data to the open stream`,
            ` * @param streamReader Iteration function that will get called on every response chunk`,
            ` */`,
            `function ${name}(writerSandbox: StreamWriterSandbox<${reqResType}>, streamReader: StreamReader<${reqResType}>): ${returnType}`
          );
          fileContents.push(
            `/**`,
            ` * Bidrectional Request to ${subchain.method.namespace}`,
            ` * @param writerSandbox Async supported callback for writing data to the open stream`,
            ` * @param streamReader Iteration function that will get called on every response chunk`,
            ` * @param abortController Abort controller for canceling the active request`,
            ` */`,
            `function ${name}(writerSandbox: StreamWriterSandbox<${reqResType}>, streamReader: StreamReader<${reqResType}>, abortController: AbortController): ${returnType}`
          );
          fileContents.push(
            `/**`,
            ` * Bidrectional Request to ${subchain.method.namespace}`,
            ` * @param writerSandbox Async supported callback for writing data to the open stream`,
            ` * @param streamReader Iteration function that will get called on every response chunk`,
            ` * @param requestOptions Request options for this specific request`,
            ` */`,
            `function ${name}(writerSandbox: StreamWriterSandbox<${reqResType}>, streamReader: StreamReader<${reqResType}>, requestOptions: RequestOptions): ${returnType}`
          );
        }
        // Server Stream
        else if (subchain.method.responseStream) {
          fileContents.push(
            `/**`,
            ` * Server Stream Request to ${subchain.method.namespace}`,
            ` * @param streamReader Iteration function that will get called on every response chunk`,
            ` */`,
            `function ${name}(streamReader: StreamReader<${reqResType}>): ${returnType}`
          );
          fileContents.push(
            `/**`,
            ` * Server Stream Request to ${subchain.method.namespace}`,
            ` * @param data Data to be sent as part of the request`,
            ` * @param streamReader Iteration function that will get called on every response chunk`,
            ` */`,
            `function ${name}(data: ${requestType}, streamReader: StreamReader<${reqResType}>): ${returnType}`
          );
          fileContents.push(
            `/**`,
            ` * Server Stream Request to ${subchain.method.namespace}`,
            ` * @param data Data to be sent as part of the request`,
            ` * @param streamReader Iteration function that will get called on every response chunk`,
            ` * @param abortController Abort controller for canceling the active request`,
            ` */`,
            `function ${name}(data: ${requestType}, streamReader: StreamReader<${reqResType}>, abortController: AbortController): ${returnType}`
          );
          fileContents.push(
            `/**`,
            ` * Server Stream Request to ${subchain.method.namespace}`,
            ` * @param data Data to be sent as part of the request`,
            ` * @param streamReader Iteration function that will get called on every response chunk`,
            ` * @param requestOptions Request options for this specific request`,
            ` */`,
            `function ${name}(data: ${requestType}, streamReader: StreamReader<${reqResType}>, requestOptions: RequestOptions): ${returnType}`
          );
        }
        // Server Stream
        else if (subchain.method.requestStream) {
          fileContents.push(
            `/**`,
            ` * Client Stream Request to ${subchain.method.namespace}`,
            ` * @param writerSandbox Async supported callback for writing data to the open stream`,
            ` */`,
            `function ${name}(writerSandbox: StreamWriterSandbox<${reqResType}>): ${returnType}`
          );
          fileContents.push(
            `/**`,
            ` * Client Stream Request to ${subchain.method.namespace}`,
            ` * @param writerSandbox Async supported callback for writing data to the open stream`,
            ` * @param abortController Abort controller for canceling the active request`,
            ` */`,
            `function ${name}(writerSandbox: StreamWriterSandbox<${reqResType}>, abortController: AbortController): ${returnType}`
          );
          fileContents.push(
            `/**`,
            ` * Client Stream Request to ${subchain.method.namespace}`,
            ` * @param writerSandbox Async supported callback for writing data to the open stream`,
            ` * @param requestOptions Request options for this specific request`,
            ` */`,
            `function ${name}(writerSandbox: StreamWriterSandbox<${reqResType}>, requestOptions: RequestOptions): ${returnType}`
          );
        }
        // Unary Request
        else {
          fileContents.push(
            `/**`,
            ` * Unary Request to ${subchain.method.namespace}`,
            ` */`,
            `function ${name}(): ${returnType}`
          );
          fileContents.push(
            `/**`,
            ` * Unary Request to ${subchain.method.namespace}`,
            ` * @param data Data to be sent as part of the request`,
            ` */`,
            `function ${name}(data: ${requestType}): ${returnType}`
          );
          fileContents.push(
            `/**`,
            ` * Unary Request to ${subchain.method.namespace}`,
            ` * @param data Data to be sent as part of the request. Defaults to empty object`,
            ` * @param abortController Abort controller for canceling the active request`,
            ` */`,
            `function ${name}(data: ${requestType} | null, abortController: AbortController): ${returnType}`
          );
          fileContents.push(
            `/**`,
            ` * Unary Request to ${subchain.method.namespace}`,
            ` * @param data Data to be sent as part of the request. Defaults to empty object`,
            ` * @param requestOptions Request options for this specific request`,
            ` */`,
            `function ${name}(data: ${requestType} | null, requestOptions: RequestOptions): ${returnType}`
          );
        }
      }
    }

    for (const name in serviceChain) {
      if (Object.keys(serviceChain[name].nested).length) {
        fileContents.newline();
        fileContents.push(`namespace ${name} {`);
        fileContents.indent();
        this.clientTypesMethodChain(serviceChain[name].nested, fileContents);
        fileContents.deindent();
        fileContents.push(`}`);
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
