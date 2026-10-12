import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { z } from "zod";

const execute = promisify(execFile);
const checker = fileURLToPath(
  new URL("../../scripts/check-architecture.ts", import.meta.url),
);
it("architecture enforcement accepts public capabilities and rejects concrete coupling, casts and private spies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-architecture-"));
  try {
    await Promise.all(
      ["src/provider", "src/consumer", "scripts", "test"].map((path) =>
        mkdir(join(directory, path), { recursive: true }),
      ),
    );
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2024",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          allowImportingTsExtensions: true,
          noEmit: true,
        },
        include: ["src/**/*.ts"],
      }),
    );
    await writeFile(
      join(directory, "src/provider/index.ts"),
      "export class Provider { private secret(): void {} public run(): void {} }",
    );
    await writeFile(
      join(directory, "src/consumer/index.ts"),
      "export interface Capability { run(): void } export function run(service: Capability): void { service.run(); }",
    );
    expect(
      (await execute(process.execPath, [checker], { cwd: directory })).stdout,
    ).toContain("Architecture checks passed");
    await writeFile(
      join(directory, "src/consumer/index.ts"),
      'import { Provider } from "../provider/index.ts"; export function run() { return new Provider(); } const t = 1, u = 2; const coerced = t as number; export * from "../provider/index.ts";',
    );
    await writeFile(
      join(directory, "src/consumer/consumer.test.ts"),
      'import { Provider } from "../provider/index.ts"; const service = new Provider(); service["secret"](); vi.spyOn(service, "secret");',
    );
    const result = await execute(process.execPath, [checker], {
      cwd: directory,
    }).then(
      () => "unexpected success",
      (error) => z.object({ stderr: z.string() }).parse(error).stderr,
    );
    for (const violation of [
      "explicit return type",
      "Application composition",
      "one variable declaration",
      "descriptive domain",
      "instead of casting",
      "export *",
      "public APIs",
      "mock other feature boundaries",
    ]) {
      expect(result).toContain(violation);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
