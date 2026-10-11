// An ExecutionEnv whose files and processes live in another process (a sandbox pod), reached over HTTP.
// The server side (src/envd.ts) wraps pi-durable's NodeExecutionEnv; this file has the client and the wire codec.
//
// Wire protocol: POST /call {method, args, cwd} or POST /handle {handle, method, args}. The response is NDJSON:
//   {"cb": n, "args": [...]}   a callback the client passed (exec onOutput, watch onChange), any number of times
//   {"ret": value}             the method's return value (a Result), exactly once
//   {"err": error}             the method threw instead
// A `watch` response stays open after `ret` to deliver changes until its watcher is closed.
// Aborting the caller's Context aborts the HTTP request, which aborts the server-side Context.
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import {
  ExecutionError, FileError,
  type BinaryReader, type DirReader, type ExecutionEnv, type FileInfo, type FileWatcher, type LineScan, type Result,
  type ShellExecOptions, type ShellExecResult, type TextLine, type TextLineReader, type WatchChange, type WatchTarget,
} from "@earendil-works/pi-durable/env";

// ---- codec: JSON plus bytes, errors, undefined, callbacks, contexts and handles ----

type Fn = (...args: any[]) => unknown;
export type Handle = { id: string; kind: "textLineReader" | "binaryReader" | "dirReader" | "fileWatcher"; mode?: FileWatcher["mode"] };

const isContext = (v: any): v is Context => v !== null && typeof v === "object" && "abortSignal" in v && typeof v.value === "function";

export function encode(value: unknown, onFunction?: (fn: Fn) => number): unknown {
  if (value === undefined) return { $u: 1 };
  if (value instanceof Uint8Array) return { $b: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
  if (value instanceof FileError) return { $fe: { code: value.code, message: value.message, path: value.path ?? null } };
  if (value instanceof ExecutionError) return { $ee: { code: value.code, message: value.message, spillPath: value.spillPath ?? null } };
  if (value instanceof Error) return { $err: value.message };
  if (isContext(value)) return { $ctx: 1 };
  if (typeof value === "function") {
    if (!onFunction) throw new Error("Cannot send a function");
    return { $cb: onFunction(value as Fn) };
  }
  if (Array.isArray(value)) return value.map(v => encode(v, onFunction));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = encode(v, onFunction);
    return out;
  }
  return value;
}

export type DecodeHooks = { callback?: (id: number) => Fn; context?: Context; handle?: (h: Handle) => unknown };

export function decode(wire: any, hooks: DecodeHooks = {}): any {
  if (Array.isArray(wire)) return wire.map(v => decode(v, hooks));
  if (wire === null || typeof wire !== "object") return wire;
  if ("$u" in wire) return undefined;
  if ("$b" in wire) return new Uint8Array(Buffer.from(wire.$b, "base64"));
  if ("$fe" in wire) return new FileError(wire.$fe.code, wire.$fe.message, wire.$fe.path ?? undefined);
  if ("$ee" in wire) {
    const error = new ExecutionError(wire.$ee.code, wire.$ee.message);
    if (wire.$ee.spillPath) error.spillPath = wire.$ee.spillPath;
    return error;
  }
  if ("$err" in wire) return new Error(wire.$err);
  if ("$ctx" in wire) return hooks.context;
  if ("$cb" in wire) {
    if (!hooks.callback) throw new Error("Unexpected callback");
    return hooks.callback(wire.$cb);
  }
  if ("$h" in wire) {
    if (!hooks.handle) throw new Error("Unexpected handle");
    return hooks.handle(wire.$h);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(wire)) out[k] = decode(v, hooks);
  return out;
}

// ---- client ----

export type RemoteEnvOptions = { url: string; token: string; id: string; cwd: string };

export class RemoteExecutionEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  private readonly client = randomUUID(); // server scopes envs, handles and cleanup per client
  private readonly options: RemoteEnvOptions;

  constructor(options: RemoteEnvOptions) {
    this.options = options;
    this.id = options.id;
    this.cwd = options.cwd;
  }

  private post(path: string, body: object) {
    return fetch(this.options.url + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.options.token}`, "x-env-client": this.client },
      body: JSON.stringify(body),
    });
  }

  // Cancellation is a message, not a dropped connection: the server aborts the operation's own Context and the
  // operation still returns its Result (an `aborted` failure), exactly as a local environment would.
  private async request(path: string, body: object, args: readonly unknown[], context: Context, keepOpen = false): Promise<any> {
    const callbacks: Fn[] = [];
    const wireArgs = encode(args, fn => callbacks.push(fn) - 1);
    const requestId = randomUUID();
    const onAbort = () => { void this.post("/cancel", { requestId }).then(r => r.body?.cancel(), () => {}); };
    const signal = context.abortSignal;
    signal?.addEventListener("abort", onAbort, { once: true });
    const detach = () => signal?.removeEventListener("abort", onAbort);
    const hooks: DecodeHooks = { context, callback: id => callbacks[id]!, handle: h => this.proxy(h) };
    let response: Response;
    try {
      response = await this.post(path, { ...body, requestId, aborted: signal?.aborted ?? false, args: wireArgs, cwd: this.cwd });
    } catch (error) { detach(); throw error; }
    if (!response.ok || !response.body) { detach(); throw new Error(`remote env ${path}: HTTP ${response.status} ${await response.text()}`); }

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => { if (!settled) { settled = true; detach(); fn(); } };
      void (async () => {
        const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            let nl: number;
            while ((nl = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
              if (!line) continue;
              const frame = JSON.parse(line);
              if ("cb" in frame) callbacks[frame.cb]!(...decode(frame.args, hooks));
              else if ("ret" in frame) settle(() => resolve(decode(frame.ret, hooks)));
              else if ("err" in frame) settle(() => reject(decode(frame.err, hooks)));
            }
          }
          settle(() => reject(new Error(`remote env ${path}: stream ended without a result`)));
        } catch (error) {
          settle(() => reject(error));
        }
      })();
    });
  }

  private invoke(method: string, args: readonly unknown[], context: Context, keepOpen = false) {
    return this.request("/call", { method }, args, context, keepOpen);
  }

  private proxy(h: Handle) {
    const call = (method: string) => (...args: any[]) => {
      const context = args.pop() as Context;
      return this.request("/handle", { handle: h.id, method }, args, context);
    };
    switch (h.kind) {
      case "textLineReader": return { readLine: call("readLine"), close: call("close") } satisfies TextLineReader;
      case "binaryReader": return { info: call("info"), read: call("read"), scanLines: call("scanLines"), close: call("close") } satisfies BinaryReader;
      case "dirReader": return { next: call("next"), close: call("close") } satisfies DirReader;
      case "fileWatcher": return { mode: h.mode ?? "polling", close: call("close") } satisfies FileWatcher;
    }
  }

  absolutePath(path: string, c: Context): Promise<Result<string, FileError>> { return this.invoke("absolutePath", [path], c); }
  joinPath(parts: string[], c: Context): Promise<Result<string, FileError>> { return this.invoke("joinPath", [parts], c); }
  readTextFile(path: string, c: Context): Promise<Result<string, FileError>> { return this.invoke("readTextFile", [path], c); }
  openTextLineReader(path: string, c: Context): Promise<Result<TextLineReader, FileError>> { return this.invoke("openTextLineReader", [path], c); }
  readTextLines(path: string, o: { maxLines?: number } | undefined, c: Context): Promise<Result<string[], FileError>> { return this.invoke("readTextLines", [path, o], c); }
  readBinaryFile(path: string, c: Context): Promise<Result<Uint8Array, FileError>> { return this.invoke("readBinaryFile", [path], c); }
  openBinaryReader(path: string, o: { noFollow?: boolean } | undefined, c: Context): Promise<Result<BinaryReader, FileError>> { return this.invoke("openBinaryReader", [path, o], c); }
  writeFile(path: string, content: string | Uint8Array, c: Context): Promise<Result<void, FileError>> { return this.invoke("writeFile", [path, content], c); }
  appendFile(path: string, content: string | Uint8Array, c: Context): Promise<Result<void, FileError>> { return this.invoke("appendFile", [path, content], c); }
  truncateFile(path: string, size: number, c: Context): Promise<Result<void, FileError>> { return this.invoke("truncateFile", [path, size], c); }
  flushFile(path: string, c: Context): Promise<Result<void, FileError>> { return this.invoke("flushFile", [path], c); }
  renameFile(from: string, to: string, c: Context): Promise<Result<void, FileError>> { return this.invoke("renameFile", [from, to], c); }
  fileInfo(path: string, c: Context): Promise<Result<FileInfo, FileError>> { return this.invoke("fileInfo", [path], c); }
  listDir(path: string, c: Context): Promise<Result<FileInfo[], FileError>> { return this.invoke("listDir", [path], c); }
  openDirReader(path: string, c: Context): Promise<Result<DirReader, FileError>> { return this.invoke("openDirReader", [path], c); }
  watch(targets: readonly WatchTarget[], onChange: (change: WatchChange) => void, c: Context): Promise<Result<FileWatcher, FileError>> { return this.invoke("watch", [targets, onChange], c, true); }
  canonicalPath(path: string, c: Context): Promise<Result<string, FileError>> { return this.invoke("canonicalPath", [path], c); }
  exists(path: string, c: Context): Promise<Result<boolean, FileError>> { return this.invoke("exists", [path], c); }
  createDir(path: string, o: { recursive?: boolean } | undefined, c: Context): Promise<Result<void, FileError>> { return this.invoke("createDir", [path, o], c); }
  remove(path: string, o: { recursive?: boolean; force?: boolean } | undefined, c: Context): Promise<Result<void, FileError>> { return this.invoke("remove", [path, o], c); }
  createTempDir(prefix: string | undefined, c: Context): Promise<Result<string, FileError>> { return this.invoke("createTempDir", [prefix], c); }
  createTempFile(o: { prefix?: string; suffix?: string } | undefined, c: Context): Promise<Result<string, FileError>> { return this.invoke("createTempFile", [o], c); }
  exec(command: string | readonly string[], o: ShellExecOptions | undefined, c: Context): Promise<Result<ShellExecResult, ExecutionError>> { return this.invoke("exec", [command, o], c); }
  async cleanup(c: Context): Promise<void> { await this.request("/cleanup", {}, [], c); }
}

export type { LineScan, TextLine };
