import type { Context } from "@earendil-works/chord";
import type {
  FileError,
  FileInfo,
  LineScan,
  Result,
  TextLine,
} from "@earendil-works/pi-durable/env";
import { z } from "zod";
import {
  directoryPageSchema,
  fileInfoSchema,
  lineScanSchema,
  parseFileResult,
  textLineSchema,
} from "./results.ts";
export interface HandleTransport {
  requestHandle<T>(
    id: string,
    method: string,
    args: unknown[],
    ctx: Context,
    parse: (value: unknown) => T,
  ): Promise<T>;
}
class RemoteHandle {
  protected readonly id: string;
  protected readonly transport: HandleTransport;
  constructor(id: string, transport: HandleTransport) {
    this.id = id;
    this.transport = transport;
  }
  close(ctx: Context): Promise<void> {
    return this.transport.requestHandle(this.id, "close", [], ctx, (value) =>
      z.void().parse(value),
    );
  }
}
export class RemoteTextLineReader extends RemoteHandle {
  readLine(ctx: Context): Promise<Result<TextLine | undefined, FileError>> {
    return this.transport.requestHandle(this.id, "readLine", [], ctx, (value) =>
      parseFileResult(value, (value) => textLineSchema.parse(value)),
    );
  }
}
export class RemoteBinaryReader extends RemoteHandle {
  info(ctx: Context): Promise<Result<FileInfo, FileError>> {
    return this.transport.requestHandle(this.id, "info", [], ctx, (value) =>
      parseFileResult(value, (value) => fileInfoSchema.parse(value)),
    );
  }
  read(
    offset: number,
    length: number,
    ctx: Context,
  ): Promise<Result<Uint8Array, FileError>> {
    return this.transport.requestHandle(
      this.id,
      "read",
      [offset, length],
      ctx,
      (value) =>
        parseFileResult(value, (value) =>
          z.instanceof(Uint8Array).parse(value),
        ),
    );
  }
  scanLines(
    options: {
      startLine: number;
      endLine?: number;
    },
    ctx: Context,
  ): Promise<Result<LineScan, FileError>> {
    return this.transport.requestHandle(
      this.id,
      "scanLines",
      [options],
      ctx,
      (value) => parseFileResult(value, (value) => lineScanSchema.parse(value)),
    );
  }
}
export class RemoteDirectoryReader extends RemoteHandle {
  next(
    maxEntries: number,
    ctx: Context,
  ): Promise<
    Result<
      {
        entries: FileInfo[];
        done: boolean;
      },
      FileError
    >
  > {
    return this.transport.requestHandle(
      this.id,
      "next",
      [maxEntries],
      ctx,
      (value) =>
        parseFileResult(value, (value) => directoryPageSchema.parse(value)),
    );
  }
}
export class RemoteFileWatcher extends RemoteHandle {
  readonly mode: "native" | "polling";
  constructor(
    id: string,
    transport: HandleTransport,
    mode: "native" | "polling",
  ) {
    super(id, transport);
    this.mode = mode;
  }
}
