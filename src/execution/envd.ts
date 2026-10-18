import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { z } from "zod";
import { decode, encode } from "./codec.ts";
import {
  invokeEnvironment,
  invokeHandle,
  type EnvironmentHandle,
} from "./dispatch.ts";
interface Client {
  env: ExecutionEnv;
  handles: Map<
    string,
    EnvironmentHandle & {
      stream?: ServerResponse;
    }
  >;
}
const requestSchema = z.object({
  method: z.string().optional(),
  handle: z.string().optional(),
  args: z.unknown().optional(),
  cwd: z.string().optional(),
  requestId: z.string().optional(),
  aborted: z.boolean().optional(),
});
export class EnvironmentServer {
  readonly server: Server;
  private readonly clients = new Map<string, Client>();
  private readonly running = new Map<string, AbortController>();
  private readonly token: string | (() => string);
  private readonly root: string;
  private readonly createEnvironment: (cwd: string) => ExecutionEnv;
  constructor(
    token: string | (() => string),
    createEnvironment: (cwd: string) => ExecutionEnv,
    root = process.cwd(),
  ) {
    this.token = token;
    this.createEnvironment = createEnvironment;
    this.root = root;
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
  }
  private clientFor(id: string, cwd: string): Client {
    const existing = this.clients.get(id);
    if (existing) {
      existing.env.cwd = cwd;
      return existing;
    }
    const client: Client = {
      env: this.createEnvironment(cwd),
      handles: new Map(),
    };
    this.clients.set(id, client);
    return client;
  }
  private authorized(header: string | undefined): boolean {
    const token = typeof this.token === "function" ? this.token() : this.token;
    const given = Buffer.from(header ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }
  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.url === "/healthz") {
      res.writeHead(200).end("ok");
      return;
    }
    if (req.method !== "POST" || !this.authorized(req.headers.authorization)) {
      res.writeHead(401).end();
      return;
    }
    const write = (frame: object): void => {
      if (!res.writableEnded) {
        res.write(JSON.stringify(frame) + "\n");
      }
    };
    try {
      let raw = "";
      req.setEncoding("utf8");
      for await (const chunk of req) {
        raw += String(chunk);
      }
      const input: unknown = JSON.parse(raw);
      const body = requestSchema.parse(input);
      const clientId = String(req.headers["x-env-client"] ?? "");
      if (req.url === "/cancel") {
        this.running
          .get(body.requestId ?? "")
          ?.abort(new Error("cancelled by client"));
        res.writeHead(204).end();
        return;
      }
      const abort = new AbortController();
      if (body.aborted) {
        abort.abort(new Error("cancelled by client"));
      }
      const requestId = body.requestId ?? randomUUID();
      this.running.set(requestId, abort);
      res.on("close", () => {
        this.running.delete(requestId);
        if (!res.writableFinished) {
          abort.abort(new Error("client went away"));
        }
      });
      const ctx = withAbortSignal(abort.signal, BACKGROUND_CONTEXT);
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      const args = z.array(z.unknown()).parse(
        decode(body.args ?? [], {
          context: ctx,
          callback: (id) => ({
            invoke: (values) => write({ cb: id, args: encode(values) }),
          }),
        }),
      );
      if (req.url === "/cleanup") {
        const client = this.clients.get(clientId);
        if (client) {
          for (const handle of client.handles.values()) {
            // Recovery: close every handle even when another handle has already failed.
            await handle.object.close(ctx).catch(() => {});
            handle.stream?.end();
          }
          await client.env.cleanup(ctx);
          this.clients.delete(clientId);
        }
        write({ ret: encode(undefined) });
        res.end();
        return;
      }
      if (req.url !== "/call" && req.url !== "/handle") {
        throw new Error(`Unknown route: ${req.url}`);
      }
      const client = this.clientFor(clientId, body.cwd ?? this.root);
      const method = z.string().parse(body.method);
      if (req.url === "/handle") {
        const handle = client.handles.get(body.handle ?? "");
        if (!handle) {
          throw new Error(`Unknown handle: ${body.handle}`);
        }
        const result = await invokeHandle(handle, method, args, ctx);
        if (method === "close") {
          handle.stream?.end();
        }
        write({ ret: encode(result) });
        res.end();
        return;
      }
      const { result, handle } = await invokeEnvironment(
        client.env,
        method,
        args,
        ctx,
      );
      if (handle) {
        const id = randomUUID();
        const watching = handle.kind === "fileWatcher";
        client.handles.set(id, {
          ...handle,
          stream: watching ? res : undefined,
        });
        const mode =
          handle.kind === "fileWatcher" ? handle.object.mode : undefined;
        write({
          ret: { ok: true, value: { $h: { id, kind: handle.kind, mode } } },
        });
        if (watching) {
          res.on("close", () => {
            void handle.object.close(BACKGROUND_CONTEXT).catch(() => {});
          });
          return;
        }
      } else {
        write({ ret: encode(result) });
      }
      res.end();
    } catch (error) {
      // Recovery: report an operation failure over the protocol instead of crashing the request loop.
      if (!res.headersSent) {
        res.writeHead(200, { "content-type": "application/x-ndjson" });
      }
      write({
        err: encode(error instanceof Error ? error : new Error(String(error))),
      });
      res.end();
    }
  }
}
export async function setupSsh(source = "/etc/kaeno/ssh"): Promise<boolean> {
  const { copyFile, chmod, mkdir, writeFile, access } =
    await import("node:fs/promises");
  try {
    await access(`${source}/id_ed25519`);
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )) {
      throw error;
    }
    return false;
  }
  const directory = `${process.env.HOME ?? "/home/agent"}/.ssh`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await copyFile(`${source}/id_ed25519`, `${directory}/id_ed25519`);
  await chmod(`${directory}/id_ed25519`, 0o600);
  await copyFile(`${source}/known_hosts`, `${directory}/known_hosts`);
  await writeFile(
    `${directory}/config`,
    `Host github.com\n  IdentityFile ${directory}/id_ed25519\n  IdentitiesOnly yes\n  StrictHostKeyChecking yes\n  UserKnownHostsFile ${directory}/known_hosts\n`,
    { mode: 0o600 },
  );
  return true;
}
