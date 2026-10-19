import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import {
  kubernetesList,
  readyDockerHostUrl,
} from "../../scripts/infrastructure-smoke-transport.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

it("encodes multiple Kubernetes resources as one JSON List, not JSON mixed with YAML separators", () => {
  const objects = [
    { apiVersion: "v1", kind: "Namespace", metadata: { name: "kaeno" } },
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "fixture", namespace: "kaeno" },
      data: { text: '---\nquoted: "value"' },
    },
  ];
  expect(JSON.parse(kubernetesList(objects))).toEqual({
    apiVersion: "v1",
    kind: "List",
    items: objects,
  });
});

async function endpoint(status = 200): Promise<string> {
  const server = createServer((request, response) => {
    expect(request.url).toBe("/healthz");
    response.writeHead(status).end();
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP listener");
  }
  return `127.0.0.1:${address.port}`;
}

it("rediscovers the published host port after a restart", async () => {
  let published = await endpoint();
  const docker = vi.fn<(...args: string[]) => Promise<string>>(
    async (...args) => {
      expect(args.at(-1) === "host" || args.at(-1) === "8080/tcp").toBe(true);
      return args[0] === "inspect" ? "true" : published;
    },
  );
  expect(await readyDockerHostUrl(docker, "host")).toBe(`http://${published}`);
  published = await endpoint();
  expect(await readyDockerHostUrl(docker, "host")).toBe(`http://${published}`);
  expect(
    docker.mock.calls.filter(([command]) => command === "port"),
  ).toHaveLength(2);
});

it("fails immediately for an exited host rather than hiding a crash behind a readiness timeout", async () => {
  const docker = vi.fn<() => Promise<string>>(async () => "false");
  await expect(readyDockerHostUrl(docker, "host")).rejects.toThrow(
    "normal image entrypoint exited",
  );
  expect(docker).toHaveBeenCalledTimes(1);
});

it("keeps polling a running host whose API is not healthy yet", async () => {
  const published = await endpoint(503);
  const docker = async (...args: string[]) =>
    args[0] === "inspect" ? "true" : published;
  expect(await readyDockerHostUrl(docker, "host")).toBeUndefined();
});
