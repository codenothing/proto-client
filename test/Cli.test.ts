import { promises } from "fs";
import { ProtoCli } from "../src/cli/cli";
import { PROTO_FILE_PATHS } from "./utils";

const OUTPUT_DIR = `${__dirname}/client/`;

describe("Cli", () => {
  beforeAll(async () => {
    try {
      const stat = await promises.stat(OUTPUT_DIR);
      if (stat.isDirectory()) {
        await promises.rm(OUTPUT_DIR, { recursive: true, force: true });
      }
      await promises.mkdir(OUTPUT_DIR);
    } catch {
      await promises.mkdir(OUTPUT_DIR);
    }

    const cli = new ProtoCli([
      `/bin/node`,
      `${__dirname}/../bin/proto-client`,
      `-o`,
      OUTPUT_DIR,
      `--keep-case`,
      ...PROTO_FILE_PATHS,
    ]);
    cli.protoPackagePath = `../../src`;
    await cli.run();
  });

  test("should verify all expected files have been generated", async () => {
    expect(
      (await promises.stat(`${OUTPUT_DIR}raw-protos.json`)).isFile()
    ).toStrictEqual(true);
    expect(
      (await promises.stat(`${OUTPUT_DIR}protos.js`)).isFile()
    ).toStrictEqual(true);
    expect(
      (await promises.stat(`${OUTPUT_DIR}protos.d.ts`)).isFile()
    ).toStrictEqual(true);
    expect(
      (await promises.stat(`${OUTPUT_DIR}client.js`)).isFile()
    ).toStrictEqual(true);
    expect(
      (await promises.stat(`${OUTPUT_DIR}client.d.ts`)).isFile()
    ).toStrictEqual(true);
  });
});
