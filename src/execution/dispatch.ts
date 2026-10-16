import type { Context } from "@earendil-works/chord";
import type {
  BinaryReader,
  DirReader,
  ExecutionEnv,
  FileWatcher,
  ShellExecOptions,
  TextLineReader,
} from "@earendil-works/pi-durable/env";
import { z } from "zod";
export type EnvironmentHandle =
  | {
      kind: "textLineReader";
      object: TextLineReader;
    }
  | {
      kind: "binaryReader";
      object: BinaryReader;
    }
  | {
      kind: "dirReader";
      object: DirReader;
    }
  | {
      kind: "fileWatcher";
      object: FileWatcher;
    };
export interface EnvironmentResponse {
  result: unknown;
  handle?: EnvironmentHandle;
}
const pathArgs = z.tuple([z.string()]);
const contentArgs = z.tuple([
  z.string(),
  z.union([z.string(), z.instanceof(Uint8Array)]),
]);
const shellOptions = z
  .object({
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    inheritEnv: z.boolean().optional(),
    timeout: z.number().optional(),
    onOutput: z
      .custom<NonNullable<ShellExecOptions["onOutput"]>>(
        (value) => typeof value === "function",
      )
      .optional(),
    spill: z
      .object({ afterBytes: z.number(), afterLines: z.number() })
      .optional(),
    window: z
      .object({
        maxBytes: z.number(),
        maxLines: z.number(),
        minIntervalMs: z.number(),
        bytesPerSecond: z.number(),
      })
      .optional(),
  })
  .optional();
export async function invokeEnvironment(
  env: ExecutionEnv,
  method: string,
  args: unknown[],
  ctx: Context,
): Promise<EnvironmentResponse> {
  switch (method) {
    case "absolutePath":
      return { result: await env.absolutePath(...pathArgs.parse(args), ctx) };
    case "joinPath":
      return {
        result: await env.joinPath(
          ...z.tuple([z.array(z.string())]).parse(args),
          ctx,
        ),
      };
    case "readTextFile":
      return { result: await env.readTextFile(...pathArgs.parse(args), ctx) };
    case "openTextLineReader": {
      const result = await env.openTextLineReader(...pathArgs.parse(args), ctx);
      return {
        result,
        handle: result.ok
          ? { kind: "textLineReader", object: result.value }
          : undefined,
      };
    }
    case "readTextLines":
      return {
        result: await env.readTextLines(
          ...z
            .tuple([
              z.string(),
              z.object({ maxLines: z.number().optional() }).optional(),
            ])
            .parse(args),
          ctx,
        ),
      };
    case "readBinaryFile":
      return { result: await env.readBinaryFile(...pathArgs.parse(args), ctx) };
    case "openBinaryReader": {
      const result = await env.openBinaryReader(
        ...z
          .tuple([
            z.string(),
            z.object({ noFollow: z.boolean().optional() }).optional(),
          ])
          .parse(args),
        ctx,
      );
      return {
        result,
        handle: result.ok
          ? { kind: "binaryReader", object: result.value }
          : undefined,
      };
    }
    case "writeFile":
      return { result: await env.writeFile(...contentArgs.parse(args), ctx) };
    case "appendFile":
      return { result: await env.appendFile(...contentArgs.parse(args), ctx) };
    case "truncateFile":
      return {
        result: await env.truncateFile(
          ...z.tuple([z.string(), z.number()]).parse(args),
          ctx,
        ),
      };
    case "flushFile":
      return { result: await env.flushFile(...pathArgs.parse(args), ctx) };
    case "renameFile":
      return {
        result: await env.renameFile(
          ...z.tuple([z.string(), z.string()]).parse(args),
          ctx,
        ),
      };
    case "fileInfo":
      return { result: await env.fileInfo(...pathArgs.parse(args), ctx) };
    case "listDir":
      return { result: await env.listDir(...pathArgs.parse(args), ctx) };
    case "openDirReader": {
      const result = await env.openDirReader(...pathArgs.parse(args), ctx);
      return {
        result,
        handle: result.ok
          ? { kind: "dirReader", object: result.value }
          : undefined,
      };
    }
    case "watch": {
      const targets = z.array(
        z.object({
          path: z.string(),
          recursive: z.boolean().optional(),
          exclude: z
            .object({
              hidden: z.boolean().optional(),
              names: z.array(z.string()).optional(),
            })
            .optional(),
        }),
      );
      const callback = z.custom<Parameters<ExecutionEnv["watch"]>[1]>(
        (value) => typeof value === "function",
      );
      const result = await env.watch(
        ...z.tuple([targets, callback]).parse(args),
        ctx,
      );
      return {
        result,
        handle: result.ok
          ? { kind: "fileWatcher", object: result.value }
          : undefined,
      };
    }
    case "canonicalPath":
      return { result: await env.canonicalPath(...pathArgs.parse(args), ctx) };
    case "exists":
      return { result: await env.exists(...pathArgs.parse(args), ctx) };
    case "createDir":
      return {
        result: await env.createDir(
          ...z
            .tuple([
              z.string(),
              z.object({ recursive: z.boolean().optional() }).optional(),
            ])
            .parse(args),
          ctx,
        ),
      };
    case "remove":
      return {
        result: await env.remove(
          ...z
            .tuple([
              z.string(),
              z
                .object({
                  recursive: z.boolean().optional(),
                  force: z.boolean().optional(),
                })
                .optional(),
            ])
            .parse(args),
          ctx,
        ),
      };
    case "createTempDir":
      return {
        result: await env.createTempDir(
          ...z.tuple([z.string().optional()]).parse(args),
          ctx,
        ),
      };
    case "createTempFile":
      return {
        result: await env.createTempFile(
          ...z
            .tuple([
              z
                .object({
                  prefix: z.string().optional(),
                  suffix: z.string().optional(),
                })
                .optional(),
            ])
            .parse(args),
          ctx,
        ),
      };
    case "exec":
      return {
        result: await env.exec(
          ...z
            .tuple([z.union([z.string(), z.array(z.string())]), shellOptions])
            .parse(args),
          ctx,
        ),
      };
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}
export async function invokeHandle(
  handle: EnvironmentHandle,
  method: string,
  args: unknown[],
  ctx: Context,
): Promise<unknown> {
  if (method === "close") {
    z.tuple([]).parse(args);
    return handle.object.close(ctx);
  }
  switch (handle.kind) {
    case "textLineReader":
      if (method === "readLine") {
        z.tuple([]).parse(args);
        return handle.object.readLine(ctx);
      }
      break;
    case "binaryReader":
      switch (method) {
        case "info":
          z.tuple([]).parse(args);
          return handle.object.info(ctx);
        case "read":
          return handle.object.read(
            ...z.tuple([z.number(), z.number()]).parse(args),
            ctx,
          );
        case "scanLines":
          return handle.object.scanLines(
            ...z
              .tuple([
                z.object({
                  startLine: z.number(),
                  endLine: z.number().optional(),
                }),
              ])
              .parse(args),
            ctx,
          );
      }
      break;
    case "dirReader":
      if (method === "next") {
        return handle.object.next(...z.tuple([z.number()]).parse(args), ctx);
      }
      break;
    case "fileWatcher":
      break;
  }
  throw new Error(`Unknown handle method: ${handle.kind} ${method}`);
}
