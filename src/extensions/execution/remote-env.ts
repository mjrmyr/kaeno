import type { Context } from "@earendil-works/chord";
import type {
  BinaryReader,
  DirReader,
  ExecutionError,
  FileError,
  FileInfo,
  FileWatcher,
  Result,
  ShellExecOptions,
  ShellExecResult,
  TextLineReader,
  WatchChange,
  WatchTarget,
} from "@earendil-works/pi-durable/env";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { decode, encode, type Handle, type WireCallback } from "./codec.ts";
import {
  RemoteBinaryReader,
  RemoteDirectoryReader,
  RemoteFileWatcher,
  RemoteTextLineReader,
} from "./handles.ts";
import {
  fileInfoSchema,
  parseExecutionResult,
  parseFileResult,
  shellResultSchema,
} from "./results.ts";
export class RemoteExecutionEnv {
  readonly id: string;
  cwd: string;
  private readonly client = randomUUID();
  private readonly url: string;
  private readonly token: string;
  private readonly fetch: typeof globalThis.fetch;
  constructor(
    url: string,
    token: string,
    id: string,
    cwd: string,
    fetch: typeof globalThis.fetch,
  ) {
    this.url = url;
    this.token = token;
    this.id = id;
    this.cwd = cwd;
    this.fetch = fetch;
  }
  private post(
    path: string,
    body: object,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.fetch(this.url + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
        "x-env-client": this.client,
      },
      body: JSON.stringify(body),
      signal,
    });
  }
  private async request(
    path: string,
    body: object,
    args: readonly unknown[],
    ctx: Context,
    transportSignal?: AbortSignal,
  ): Promise<unknown> {
    const callbacks: WireCallback[] = [];
    const wireArgs = encode(args, (callback) => callbacks.push(callback) - 1);
    const requestId = randomUUID();
    const transport = new AbortController();
    let cancellationDeadline: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      // Cancellation is an explicit protocol message. Dropping the stream would lose the SDK's aborted Result.
      void this.post("/cancel", { requestId }, AbortSignal.timeout(5000)).then(
        (response) => response.body?.cancel(),
        () => {},
      );
      cancellationDeadline = setTimeout(
        () => transport.abort(ctx.abortSignal?.reason),
        5000,
      );
      cancellationDeadline.unref();
    };
    const signal = ctx.abortSignal;
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
    function detach(): void {
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(cancellationDeadline);
    }
    function resolveCallback(id: number): WireCallback {
      const callback = callbacks.at(id);
      if (!callback) {
        throw new Error(`Unknown remote callback ${id}`);
      }
      return callback;
    }
    let response: Response;
    try {
      response = await this.post(
        path,
        {
          ...body,
          requestId,
          aborted: signal?.aborted ?? false,
          args: wireArgs,
          cwd: this.cwd,
        },
        transportSignal
          ? AbortSignal.any([transport.signal, transportSignal])
          : transport.signal,
      );
    } catch (error) {
      detach();
      throw error;
    }
    const stream = response.body;
    if (!response.ok || !stream) {
      detach();
      throw new Error(
        `remote env ${path}: HTTP ${response.status} ${await response.text()}`,
      );
    }
    const hooks = {
      context: ctx,
      callback: resolveCallback,
      handle: (handle: Handle) => this.createHandleProxy(handle),
    };
    return new Promise((resolve, reject) => {
      let settled = false;
      function settle(action: () => void): void {
        if (!settled) {
          settled = true;
          detach();
          action();
        }
      }
      void (async (): Promise<void> => {
        const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) {
              break;
            }
            buffer += value;
            let newline: number;
            while ((newline = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              if (!line) {
                continue;
              }
              const raw: unknown = JSON.parse(line);
              const frame = z.record(z.string(), z.unknown()).parse(raw);
              if (Object.hasOwn(frame, "cb")) {
                const id = z.number().int().nonnegative().parse(frame.cb);
                resolveCallback(id).invoke(
                  z.array(z.unknown()).parse(decode(frame.args, hooks)),
                );
              } else if (Object.hasOwn(frame, "ret")) {
                settle(() => resolve(decode(frame.ret, hooks)));
              } else if (Object.hasOwn(frame, "err")) {
                settle(() => reject(decode(frame.err, hooks)));
              } else {
                throw new Error("Invalid remote response frame");
              }
            }
          }
          settle(() =>
            reject(
              new Error(`remote env ${path}: stream ended without a result`),
            ),
          );
        } catch (error) {
          // Recovery: settle the waiting call; errors after a watch handshake cannot undo its delivered result.
          settle(() => reject(error));
        } finally {
          reader.releaseLock();
        }
      })();
    });
  }
  private async invoke<T>(
    method: string,
    args: readonly unknown[],
    ctx: Context,
    parseValue: (value: unknown) => T,
  ): Promise<Result<T, FileError>> {
    return parseFileResult(
      await this.request("/call", { method }, args, ctx),
      parseValue,
    );
  }
  async requestHandle<T>(
    id: string,
    method: string,
    args: unknown[],
    ctx: Context,
    parse: (value: unknown) => T,
  ): Promise<T> {
    return parse(
      await this.request("/handle", { handle: id, method }, args, ctx),
    );
  }
  private createHandleProxy(
    handle: Handle,
  ): TextLineReader | BinaryReader | DirReader | FileWatcher {
    switch (handle.kind) {
      case "textLineReader":
        return new RemoteTextLineReader(handle.id, this);
      case "binaryReader":
        return new RemoteBinaryReader(handle.id, this);
      case "dirReader":
        return new RemoteDirectoryReader(handle.id, this);
      case "fileWatcher":
        return new RemoteFileWatcher(handle.id, this, handle.mode ?? "polling");
    }
  }
  absolutePath(path: string, ctx: Context): Promise<Result<string, FileError>> {
    return this.invoke("absolutePath", [path], ctx, (value) =>
      z.string().parse(value),
    );
  }
  joinPath(parts: string[], ctx: Context): Promise<Result<string, FileError>> {
    return this.invoke("joinPath", [parts], ctx, (value) =>
      z.string().parse(value),
    );
  }
  readTextFile(path: string, ctx: Context): Promise<Result<string, FileError>> {
    return this.invoke("readTextFile", [path], ctx, (value) =>
      z.string().parse(value),
    );
  }
  openTextLineReader(
    path: string,
    ctx: Context,
  ): Promise<Result<TextLineReader, FileError>> {
    return this.invoke("openTextLineReader", [path], ctx, (value) =>
      z.instanceof(RemoteTextLineReader).parse(value),
    );
  }
  readTextLines(
    path: string,
    options:
      | {
          maxLines?: number;
        }
      | undefined,
    ctx: Context,
  ): Promise<Result<string[], FileError>> {
    return this.invoke("readTextLines", [path, options], ctx, (value) =>
      z.array(z.string()).parse(value),
    );
  }
  readBinaryFile(
    path: string,
    ctx: Context,
  ): Promise<Result<Uint8Array, FileError>> {
    return this.invoke("readBinaryFile", [path], ctx, (value) =>
      z.instanceof(Uint8Array).parse(value),
    );
  }
  openBinaryReader(
    path: string,
    options:
      | {
          noFollow?: boolean;
        }
      | undefined,
    ctx: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    return this.invoke("openBinaryReader", [path, options], ctx, (value) =>
      z.instanceof(RemoteBinaryReader).parse(value),
    );
  }
  writeFile(
    path: string,
    content: string | Uint8Array,
    ctx: Context,
  ): Promise<Result<void, FileError>> {
    return this.invoke("writeFile", [path, content], ctx, (value) =>
      z.void().parse(value),
    );
  }
  appendFile(
    path: string,
    content: string | Uint8Array,
    ctx: Context,
  ): Promise<Result<void, FileError>> {
    return this.invoke("appendFile", [path, content], ctx, (value) =>
      z.void().parse(value),
    );
  }
  truncateFile(
    path: string,
    size: number,
    ctx: Context,
  ): Promise<Result<void, FileError>> {
    return this.invoke("truncateFile", [path, size], ctx, (value) =>
      z.void().parse(value),
    );
  }
  flushFile(path: string, ctx: Context): Promise<Result<void, FileError>> {
    return this.invoke("flushFile", [path], ctx, (value) =>
      z.void().parse(value),
    );
  }
  renameFile(
    from: string,
    to: string,
    ctx: Context,
  ): Promise<Result<void, FileError>> {
    return this.invoke("renameFile", [from, to], ctx, (value) =>
      z.void().parse(value),
    );
  }
  fileInfo(path: string, ctx: Context): Promise<Result<FileInfo, FileError>> {
    return this.invoke("fileInfo", [path], ctx, (value) =>
      fileInfoSchema.parse(value),
    );
  }
  listDir(path: string, ctx: Context): Promise<Result<FileInfo[], FileError>> {
    return this.invoke("listDir", [path], ctx, (value) =>
      z.array(fileInfoSchema).parse(value),
    );
  }
  openDirReader(
    path: string,
    ctx: Context,
  ): Promise<Result<DirReader, FileError>> {
    return this.invoke("openDirReader", [path], ctx, (value) =>
      z.instanceof(RemoteDirectoryReader).parse(value),
    );
  }
  watch(
    targets: readonly WatchTarget[],
    onChange: (change: WatchChange) => void,
    ctx: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    return this.invoke("watch", [targets, onChange], ctx, (value) =>
      z.instanceof(RemoteFileWatcher).parse(value),
    );
  }
  canonicalPath(
    path: string,
    ctx: Context,
  ): Promise<Result<string, FileError>> {
    return this.invoke("canonicalPath", [path], ctx, (value) =>
      z.string().parse(value),
    );
  }
  exists(path: string, ctx: Context): Promise<Result<boolean, FileError>> {
    return this.invoke("exists", [path], ctx, (value) =>
      z.boolean().parse(value),
    );
  }
  createDir(
    path: string,
    options:
      | {
          recursive?: boolean;
        }
      | undefined,
    ctx: Context,
  ): Promise<Result<void, FileError>> {
    return this.invoke("createDir", [path, options], ctx, (value) =>
      z.void().parse(value),
    );
  }
  remove(
    path: string,
    options:
      | {
          recursive?: boolean;
          force?: boolean;
        }
      | undefined,
    ctx: Context,
  ): Promise<Result<void, FileError>> {
    return this.invoke("remove", [path, options], ctx, (value) =>
      z.void().parse(value),
    );
  }
  createTempDir(
    prefix: string | undefined,
    ctx: Context,
  ): Promise<Result<string, FileError>> {
    return this.invoke("createTempDir", [prefix], ctx, (value) =>
      z.string().parse(value),
    );
  }
  createTempFile(
    options:
      | {
          prefix?: string;
          suffix?: string;
        }
      | undefined,
    ctx: Context,
  ): Promise<Result<string, FileError>> {
    return this.invoke("createTempFile", [options], ctx, (value) =>
      z.string().parse(value),
    );
  }
  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    ctx: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    return parseExecutionResult(
      await this.request("/call", { method: "exec" }, [command, options], ctx),
      (value) => shellResultSchema.parse(value),
    );
  }
  browser(input: object, ctx: Context): Promise<unknown> {
    return this.request("/browser", input, [], ctx);
  }
  async cleanup(ctx: Context): Promise<void> {
    await this.request("/cleanup", {}, [], ctx, ctx.abortSignal);
  }
}
