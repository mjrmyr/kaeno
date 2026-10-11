// envd: the execution-environment server that runs inside each sandbox pod.
// It exposes pi-durable's NodeExecutionEnv over HTTP (protocol in src/remote-env.ts). It holds no model credentials;
// kaeno's agents call it for every file and shell operation of a sandboxed conversation.
import { createServer, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { decode, encode, type Handle } from "./remote-env.ts";

const METHODS = new Set([
  "absolutePath", "joinPath", "readTextFile", "openTextLineReader", "readTextLines", "readBinaryFile", "openBinaryReader",
  "writeFile", "appendFile", "truncateFile", "flushFile", "renameFile", "fileInfo", "listDir", "openDirReader", "watch",
  "canonicalPath", "exists", "createDir", "remove", "createTempDir", "createTempFile", "exec",
]);
const HANDLE_KINDS: Record<string, Handle["kind"]> = {
  openTextLineReader: "textLineReader", openBinaryReader: "binaryReader", openDirReader: "dirReader", watch: "fileWatcher",
};
const HANDLE_METHODS: Record<Handle["kind"], Set<string>> = {
  textLineReader: new Set(["readLine", "close"]),
  binaryReader: new Set(["info", "read", "scanLines", "close"]),
  dirReader: new Set(["next", "close"]),
  fileWatcher: new Set(["close"]),
};

type Client = { env: NodeExecutionEnv; handles: Map<string, { kind: Handle["kind"]; object: any; stream?: ServerResponse }> };

export function createEnvServer(options: { token: string | (() => string); root?: string }) {
  const clients = new Map<string, Client>();
  const running = new Map<string, AbortController>(); // requestId → the operation's abort, for POST /cancel
  const clientFor = (id: string, cwd: string): Client => {
    let client = clients.get(id);
    if (!client) { client = { env: new NodeExecutionEnv({ cwd }), handles: new Map() }; clients.set(id, client); }
    client.env.cwd = cwd;
    return client;
  };
  const authorized = (header: string | undefined) => {
    const token = typeof options.token === "function" ? options.token() : options.token;
    const given = Buffer.from(header ?? ""), want = Buffer.from(`Bearer ${token}`);
    return given.length === want.length && timingSafeEqual(given, want);
  };

  return createServer(async (req, res) => {
    if (req.url === "/healthz") { res.writeHead(200).end("ok"); return; }
    if (req.method !== "POST" || !authorized(req.headers.authorization)) { res.writeHead(401).end(); return; }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as { method?: string; handle?: string; args?: unknown; cwd?: string; requestId?: string; aborted?: boolean };
    const clientId = String(req.headers["x-env-client"] ?? "");
    if (req.url === "/cancel") {
      running.get(String(body.requestId))?.abort(new Error("cancelled by client"));
      res.writeHead(204).end(); return;
    }
    const abort = new AbortController();
    if (body.aborted) abort.abort(new Error("cancelled by client"));
    const requestId = String(body.requestId ?? randomUUID());
    running.set(requestId, abort);
    res.on("close", () => {
      running.delete(requestId);
      if (!res.writableFinished) abort.abort(new Error("client went away")); // kaeno crashed or restarted
    });
    const context = withAbortSignal(abort.signal, BACKGROUND_CONTEXT);
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    const write = (frame: object) => { if (!res.writableEnded) res.write(JSON.stringify(frame) + "\n"); };
    const args = decode(body.args ?? [], {
      context,
      callback: id => (...values: unknown[]) => write({ cb: id, args: encode(values) }),
    }) as unknown[];

    try {
      if (req.url === "/cleanup") {
        const client = clients.get(clientId);
        if (client) {
          for (const h of client.handles.values()) { await h.object.close?.(context).catch(() => {}); h.stream?.end(); }
          await client.env.cleanup(context);
          clients.delete(clientId);
        }
        write({ ret: encode(undefined) }); res.end(); return;
      }
      const client = clientFor(clientId, body.cwd ?? options.root ?? process.cwd());

      if (req.url === "/handle") {
        const entry = client.handles.get(String(body.handle));
        if (!entry || !HANDLE_METHODS[entry.kind].has(String(body.method))) throw new Error(`Unknown handle or method: ${body.handle} ${body.method}`);
        const result = await entry.object[body.method!](...args, context);
        // Handles stay registered after close: close is idempotent and later calls get the reader's own error.
        if (body.method === "close") entry.stream?.end();
        write({ ret: encode(result) }); res.end(); return;
      }

      if (req.url !== "/call" || !METHODS.has(String(body.method))) throw new Error(`Unknown method: ${body.method}`);
      const result = await (client.env as any)[body.method!](...args, context);
      const kind = HANDLE_KINDS[body.method!];
      if (kind && result?.ok) {
        const id = randomUUID();
        const keepOpen = kind === "fileWatcher";
        client.handles.set(id, { kind, object: result.value, stream: keepOpen ? res : undefined });
        write({ ret: { ok: true, value: { $h: { id, kind, mode: result.value.mode } } } });
        if (keepOpen) {
          // The watch stream stays open for onChange frames; a client that goes away closes its watcher.
          res.on("close", () => { void result.value.close(BACKGROUND_CONTEXT); });
          return;
        }
      } else {
        write({ ret: encode(result) });
      }
      res.end();
    } catch (error) {
      write({ err: encode(error instanceof Error ? error : new Error(String(error))) });
      res.end();
    }
  });
}

// The GitHub deploy key arrives as a Secret volume, which is group-readable under fsGroup; ssh refuses such keys.
// Copy it into $HOME/.ssh with 0600 and point ssh (and so git) at it.
async function setupSsh(source = "/etc/kaeno/ssh") {
  const { copyFile, chmod, mkdir, writeFile, access } = await import("node:fs/promises");
  try { await access(`${source}/id_ed25519`); } catch { return false; }
  const dir = `${process.env.HOME ?? "/home/agent"}/.ssh`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await copyFile(`${source}/id_ed25519`, `${dir}/id_ed25519`);
  await chmod(`${dir}/id_ed25519`, 0o600);
  await copyFile(`${source}/known_hosts`, `${dir}/known_hosts`).catch(() => {});
  await writeFile(`${dir}/config`, `Host github.com\n  IdentityFile ${dir}/id_ed25519\n  IdentitiesOnly yes\n  StrictHostKeyChecking yes\n  UserKnownHostsFile ${dir}/known_hosts\n`, { mode: 0o600 });
  return true;
}

if (process.argv[1] === import.meta.filename) {
  const token = process.env.KAENO_ENV_TOKEN ?? "";
  if (token.length < 32) throw new Error("KAENO_ENV_TOKEN must be set");
  console.log(`github ssh: ${(await setupSsh()) ? "configured" : "no key mounted"}`);
  const port = Number(process.env.PORT ?? 7070);
  const server = createEnvServer({ token, root: process.cwd() }).listen(port, () => console.log(`envd listening on :${port}, cwd ${process.cwd()}`));
  process.once("SIGTERM", () => { server.close(); process.exit(0); }); // deletion is the normal end of a sandbox
}
