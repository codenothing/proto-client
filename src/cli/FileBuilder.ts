import { promises } from "fs";
import color from "cli-color";

export interface AddMethodsParams {
  methodType: string;
  namespace: string;
  returnType: string;
  args: Record<string, { type: string; shortType: string; desc: string }>;
  combos: string[][];
}

/**
 * File building util used in cli
 * @private
 * @package
 */
export class FileBuilder {
  public indentCharacter = "\t";
  public filePath = "";
  public lines: string[] = [];
  public indentation: string[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  public get contents() {
    return this.lines.join("\n");
  }

  public push(...lines: string[]) {
    const indent = this.indentation.join("");
    lines.forEach((line) => this.lines.push(indent + line));
  }

  public pushWithIndent(...lines: string[]) {
    this.indent();
    this.push(...lines);
    this.deindent();
  }

  public addTypedMethods({
    methodType,
    namespace,
    returnType,
    args,
    combos,
  }: AddMethodsParams) {
    const makeStrings: string[] = [];
    const getStrings: string[] = [];

    for (const combo of combos) {
      const argDocs = combo.map((arg) => {
        const { shortType, desc } = args[arg];
        return ` * @param {${shortType}} ${arg} ${desc}`;
      });

      // Add doc string to make methods
      makeStrings.push(
        `/**`,
        ` * ${methodType} Request to ${namespace}`,
        ...argDocs,
        ` */`
      );

      // Add doc string to get methods
      getStrings.push(
        `/**`,
        ` * Starts ${methodType} Request to ${namespace}`,
        ...argDocs,
        ` */`
      );

      // Put each argument on it's own line when there are more than one
      const argParams = combo.map((arg) => `${arg}: ${args[arg].type}`);
      if (argParams.length > 1) {
        makeStrings.push(`(`);
        getStrings.push(`get(`);

        argParams.forEach((row, index) => {
          const line = `${this.indentCharacter}${row}${
            index === argParams.length ? "" : ","
          }`;

          makeStrings.push(line);
          getStrings.push(line);
        });

        makeStrings.push(`): Promise<${returnType}>;`);
        getStrings.push(`): ${returnType};`);
      } else {
        makeStrings.push(`(${argParams}): Promise<${returnType}>;`);
        getStrings.push(`get(${argParams}): ${returnType};`);
      }
    }

    this.push(...makeStrings, ...getStrings);
  }

  public indent() {
    this.indentation.push(this.indentCharacter);
  }

  public deindent() {
    if (this.indentation.length) {
      this.indentation.pop();
    }
  }

  public newline() {
    this.lines.push(``);
  }

  public async write() {
    const filename = this.filePath.split(/\//g).pop();

    try {
      await promises.writeFile(this.filePath, this.contents, `utf-8`);
      console.log(color.green(`✔ ${filename}`));
    } catch (e) {
      console.log(color.red(`✖ Failed to write ${filename}`));
      console.error(e);
      process.exit(1);
    }
  }
}
