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
      [
        "src/extensions/provider",
        "src/extensions/consumer",
        "scripts",
        "test",
      ].map((path) => mkdir(join(directory, path), { recursive: true })),
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
      join(directory, "src/extensions/provider/index.ts"),
      "export class Provider { private secret(): void {} public run(): void {} }",
    );
    await writeFile(
      join(directory, "src/extensions/consumer/index.ts"),
      "export interface Capability { run(): void } export function run(service: Capability): void { service.run(); }",
    );
    expect(
      (await execute(process.execPath, [checker], { cwd: directory })).stdout,
    ).toContain("Architecture checks passed");
    await writeFile(
      join(directory, "src/extensions/consumer/index.ts"),
      'import { Provider } from "../provider/index.ts"; export function run() { return new Provider(); } const t = 1, u = 2; const coerced = t as number; export * from "../provider/index.ts";',
    );
    await writeFile(
      join(directory, "src/extensions/consumer/consumer.test.ts"),
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

it("rejects core and extension imports that cross layer boundaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-core-boundary-"));
  try {
    for (const path of [
      "src/core/work",
      "src/extensions/agents",
      "src/core/application",
      "src/host/composition",
      "src/misc",
      "scripts",
      "test",
    ]) {
      await mkdir(join(directory, path), { recursive: true });
    }
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
      join(directory, "src/extensions/agents/index.ts"),
      'import type { Loaded } from "../../host/composition/index.ts"; export interface Definition { name: string; loaded: Loaded }',
    );
    await writeFile(
      join(directory, "src/core/work/index.ts"),
      'import type { Definition } from "../../extensions/agents/index.ts"; export interface Work { definition: Definition }',
    );
    await writeFile(
      join(directory, "src/core/application/index.ts"),
      'export type { Definition } from "../../extensions/agents/index.ts";',
    );
    await writeFile(
      join(directory, "src/host/composition/index.ts"),
      'import type { Work } from "../../core/work/index.ts"; export interface Loaded { path: string; work: Work }',
    );
    await writeFile(
      join(directory, "src/misc/index.ts"),
      "export interface Misc { name: string }",
    );
    const result = await execute(process.execPath, [checker], {
      cwd: directory,
    }).then(
      () => "unexpected success",
      (error) => z.object({ stderr: z.string() }).parse(error).stderr,
    );
    expect(result).toContain(
      'Core feature "work" cannot import "extensions/agents"',
    );
    expect(result).toContain(
      'Core feature "application" cannot re-export "extensions/agents"',
    );
    expect(result).toContain('Extension "agents" cannot import the host');
    expect(result).toContain(
      "src/host/composition/index.ts:1:1 Import core only through src/core/application/index.ts.",
    );
    expect(result).toContain(
      'Place "src/misc" under src/core, src/extensions or src/host.',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
