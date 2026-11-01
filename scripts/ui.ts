import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer as createTcpServer } from "node:net";
import { createServer } from "vite";
import { z } from "zod";

const portSchema = z.coerce.number().int().min(1).max(65535);
const uiPort = portSchema.parse(process.env.KAENO_UI_PORT ?? 5173);
const backendPort = portSchema.parse(process.env.PORT ?? 8080);
const external = process.env.KAENO_UI_API_URL || undefined;
const target = new URL(external ?? `http://127.0.0.1:${backendPort}`);
if (
  !["http:", "https:"].includes(target.protocol) ||
  target.username ||
  target.password ||
  target.pathname !== "/" ||
  target.search ||
  target.hash
) {
  throw new Error(
    "KAENO_UI_API_URL must be an http(s) origin without credentials, path, query or fragment.",
  );
}
if (!external && uiPort === backendPort) {
  throw new Error("KAENO_UI_PORT and PORT must differ.");
}
const dataDirectory = process.env.KAENO_DATA_DIR ?? resolve(".kaeno/data");
if (!external) {
  await mkdir(dataDirectory, { recursive: true });
}
// No envPrefix change: only explicitly VITE_-prefixed environment variables are browser-visible.
const vite = await createServer({
  configFile: false,
  root: resolve("src/ui"),
  server: {
    host: "127.0.0.1",
    port: uiPort,
    strictPort: true,
    fs: { strict: true, allow: [resolve("src/ui"), resolve("node_modules")] },
    proxy: {
      "/v1": { target: target.origin },
      "/healthz": { target: target.origin },
    },
  },
});
let backend: ReturnType<typeof spawn> | undefined;
let closing = false;
async function close(code: number): Promise<void> {
  if (closing) {
    return;
  }
  closing = true;
  process.exitCode = code;
  backend?.kill("SIGTERM");
  const forceExit = setTimeout(() => {
    backend?.kill("SIGKILL");
    process.exit(code);
  }, 5000);
  forceExit.unref();
  await vite.close();
  if (!backend || backend.exitCode !== null) {
    clearTimeout(forceExit);
    process.exitCode = code;
  }
}
try {
  if (!external) {
    const reservation = createTcpServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(backendPort, "127.0.0.1", () =>
        reservation.close((error) => (error ? reject(error) : resolve())),
      );
    });
    backend = spawn(
      process.execPath,
      ["--env-file-if-exists=.env", "src/host/main.ts"],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          PORT: String(backendPort),
          KAENO_DATA_DIR: dataDirectory,
        },
      },
    );
    backend.once("error", (error) => {
      console.error(error);
      void close(1);
    });
    backend.once("exit", (code) => {
      if (!closing) {
        console.error(
          "Backend exited. Check KAENO_CONFIG, model credentials and execution configuration; see docs/ui.md.",
        );
        void close(code || 1);
      }
    });
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (closing) {
        break;
      }
      try {
        const response = await fetch(`${target.origin}/healthz`, {
          signal: AbortSignal.timeout(500),
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        /* Startup may need to fetch the configured agent sources. */
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready || closing) {
      throw new Error(
        "Backend did not become healthy within 60 seconds. See docs/ui.md for setup and connection options.",
      );
    }
  }
  if (!closing) {
    await vite.listen();
    console.log(
      `Kaeno UI: http://127.0.0.1:${uiPort} → ${target.origin}${external ? " (existing backend)" : " (managed backend)"}`,
    );
  }
} catch (error) {
  console.error(error);
  await close(1);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void close(0);
  });
}
