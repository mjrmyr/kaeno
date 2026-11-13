import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { it, expect } from "vitest";
import {
  remoteObservationClient,
  observerHandler,
  KubernetesObserver,
} from "../index.ts";

it("serves only authenticated snapshots, rereads rotated tokens and fails closed", async () => {
  const observer = new KubernetesObserver(
    { namespaces: ["pilot"] },
    async () => ({ items: [] }),
  );
  let token = "a".repeat(32);
  const server = createHttpServer(observerHandler(observer, async () => token));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing address");
  }
  const url = `http://127.0.0.1:${address.port}`;
  async function get(path: string, auth = token, method = "GET") {
    return fetch(url + path, {
      headers: { authorization: `Bearer ${auth}` },
      method,
    });
  }
  try {
    expect((await get("/v1/snapshot", "wrong")).status).toBe(401);
    expect((await get("/v1/snapshot")).status).toBe(503);
    await observer.poll();
    expect((await get("/v1/snapshot")).status).toBe(200);
    expect((await get("/api/v1/pods")).status).toBe(404);
    expect((await get("/v1/snapshot", token, "POST")).status).toBe(404);
    token = "b".repeat(32);
    expect((await get("/v1/snapshot", "a".repeat(32))).status).toBe(401);
    expect((await get("/v1/snapshot")).status).toBe(200);
    token = "";
    expect((await get("/v1/snapshot")).status).toBe(401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("verifies TLS, bounds bytes, rereads credentials, never follows redirects or exposes upstream errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observer-tls-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" },
  );
  const observer = new KubernetesObserver(
    { namespaces: ["pilot"] },
    async () => ({ items: [] }),
  );
  await observer.poll();
  let oversized = false;
  const cert = await readFile(join(directory, "cert.pem"), "utf8");
  const tokens: string[] = [];
  let status = 200;
  const server = createServer(
    { key: await readFile(join(directory, "key.pem")), cert },
    (req, res) => {
      tokens.push(req.headers.authorization ?? "");
      res.writeHead(status, { location: "https://localhost:1/secret" });
      let body = "CANARY-upstream-token";
      if (status === 200) {
        body = oversized
          ? "x".repeat(17 * 1024 * 1024)
          : JSON.stringify(observer.snapshot());
      }
      res.end(body);
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing address");
  }
  const origin = `https://localhost:${address.port}`;
  let token = "first";
  const options = { origin, ca: cert, readToken: async () => token };
  try {
    const client = remoteObservationClient({ namespaces: ["pilot"] }, options);
    const untrusted = remoteObservationClient(
      { namespaces: ["pilot"] },
      { ...options, ca: undefined },
    );
    await expect(untrusted.overview()).rejects.toThrow("unavailable");
    expect(await client.overview()).toMatchObject({
      resourcesIncomplete: false,
    });
    token = "rotated";
    await client.overview();
    expect(tokens).toEqual(["Bearer first", "Bearer rotated"]);
    oversized = true;
    await expect(client.overview()).rejects.toThrow("unavailable");
    oversized = false;
    status = 403;
    await expect(client.overview()).rejects.toThrow(
      /^Kubernetes observation unavailable$/,
    );
    status = 302;
    await expect(client.overview()).rejects.toThrow(
      /^Kubernetes observation unavailable$/,
    );
    const controller = new AbortController();
    controller.abort();
    await expect(client.overview(controller.signal)).rejects.toThrow(
      "unavailable",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);

it("rejects unsafe endpoint origins even when embedded directly", () => {
  for (const origin of [
    "http://localhost",
    "https://user:pass@localhost",
    "https://localhost/path",
    "https://localhost?q=x",
  ]) {
    expect(() =>
      remoteObservationClient(
        { namespaces: ["pilot"] },
        { origin, readToken: async () => "token" },
      ),
    ).toThrow();
  }
});
