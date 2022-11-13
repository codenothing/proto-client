import { promises } from "fs";
import color from "cli-color";

/**
 * File building util used in cli
 */
export class FileBuilder {
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

  public indent() {
    this.indentation.push(`\t`);
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
