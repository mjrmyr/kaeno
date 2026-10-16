import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";

it("boots the actual core entrypoint and shuts down cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "kaeno-application-"));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP address");
  }
  await new Promise<void>((done) => reservation.close(() => done()));
  const config = join(root, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      model: "openai/gpt-4.1",
      instructions: "Answer clearly.",
    }),
  );
  const token = "test-token-with-at-least-32-characters";
  const child = spawn(process.execPath, [resolve("src/main.ts")], {
    env: {
      ...process.env,
      KAENO_CONFIG: config,
      KAENO_DB: join(root, "kaeno.sqlite"),
      KAENO_TOKEN: token,
      PORT: String(address.port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  const exited = once(child, "exit");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await vi.waitFor(
      async () => {
        if (child.exitCode !== null) {
          throw new Error(output);
        }
        expect((await fetch(`${base}/healthz`)).status).toBe(200);
      },
      { timeout: 10000, interval: 50 },
    );
    const response = await fetch(`${base}/v1/threads`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    child.kill("SIGTERM");
    const [code, signal] = await exited;
    expect({ code, signal }).toEqual({ code: 0, signal: null });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await exited;
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
