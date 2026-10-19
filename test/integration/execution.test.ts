import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  EnvironmentServer,
  RemoteExecutionEnv,
} from "../../src/extensions/execution/index.ts";

it("serves file operations and cleanup without collecting or deleting workspace contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "kaeno-execution-"));
  const token = "test-environment-token";
  const server = new EnvironmentServer(
    token,
    (cwd) => new NodeExecutionEnv({ cwd }),
    root,
  ).server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP address");
    }
    const url = `http://127.0.0.1:${address.port}`;
    const remote = new RemoteExecutionEnv(url, token, "test", root, fetch);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    expect((await fetch(`${url}/call`, { method: "POST" })).status).toBe(401);
    expect(
      await remote.writeFile("note.txt", "workspace remains writable", context),
    ).toEqual({ ok: true, value: undefined });
    expect(await remote.readTextFile("note.txt", context)).toEqual({
      ok: true,
      value: "workspace remains writable",
    });
    await remote.cleanup(context);
    expect(await readFile(join(root, "note.txt"), "utf8")).toBe(
      "workspace remains writable",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

it("does not expose the removed collection endpoint", async () => {
  const server = new EnvironmentServer(
    "token",
    (cwd) => new NodeExecutionEnv({ cwd }),
  ).server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP address");
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/collect`, {
      method: "POST",
      headers: {
        authorization: "Bearer token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ method: "collect" }),
    });
    expect(await response.text()).toContain("Unknown route: /collect");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("keeps the browser in envd across transient remote clients and cleans it up", async () => {
  let calls = 0;
  let closed = false;
  const server = new EnvironmentServer(
    "token",
    (cwd) => new NodeExecutionEnv({ cwd }),
    process.cwd(),
    {
      async call(input) {
        expect(input).toMatchObject({ name: "browser_snapshot" });
        return { content: [{ type: "text", text: String(++calls) }] };
      },
      async close() {
        closed = true;
      },
    },
  ).server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected TCP address");
    }
    const url = `http://127.0.0.1:${address.port}`;
    const remote = () =>
      new RemoteExecutionEnv(url, "token", "work", process.cwd(), fetch);
    expect((await fetch(`${url}/browser`, { method: "POST" })).status).toBe(
      401,
    );
    expect(
      await remote().browser({ name: "browser_snapshot" }, context),
    ).toMatchObject({ content: [{ text: "1" }] });
    expect(
      await remote().browser({ name: "browser_snapshot" }, context),
    ).toMatchObject({ content: [{ text: "2" }] });
    await remote().cleanup(context);
    expect(closed).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
