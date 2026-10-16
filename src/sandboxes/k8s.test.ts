import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it, vi } from "vitest";
import { taskId } from "../../test/mocks/identifiers.ts";
import { KubernetesClient, SandboxCapacity, SandboxManager } from "./index.ts";
vi.mock("@earendil-works/pi-durable", async () => {
  const { createMockSdk } = await import("../../test/mocks/sdk.ts");
  return createMockSdk();
});
vi.mock("../skills/index.ts", () => ({
  SKILL_ROOT: "/workspace/.agents/skills",
}));
function clientWithStatus(status: number, body = "not found") {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => new Response(body, { status }));
  const client = new KubernetesClient(
    "namespace",
    fetch,
    async () => "test-token",
  );
  return { client, fetch };
}
describe("KubernetesClient HTTP errors", () => {
  it("rejects pod creation on HTTP 404 with the API error", async () => {
    const { client, fetch } = clientWithStatus(
      404,
      'namespaces "namespace" not found',
    );
    await expect(
      client.createPod({ metadata: { name: "pod" } }),
    ).rejects.toThrow(
      'POST /api/v1/namespaces/namespace/pods → 404: namespaces "namespace" not found',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("treats an existing pod (POST 409) as an idempotent create", async () => {
    const { client } = clientWithStatus(409, "already exists");
    await expect(
      client.createPod({ metadata: { name: "pod" } }),
    ).resolves.toBeUndefined();
  });
  it("returns undefined when GET finds no pod", async () => {
    const { client } = clientWithStatus(404);
    await expect(client.getPod("pod")).resolves.toBeUndefined();
  });
  it("allows idempotent deletion of an absent pod", async () => {
    const { client } = clientWithStatus(404);
    await expect(client.deletePod("pod")).resolves.toBeUndefined();
  });
  it("returns undefined when logs are gone", async () => {
    const { client } = clientWithStatus(404);
    await expect(client.getPodLog("pod")).resolves.toBeUndefined();
  });
  it("preserves the missing-quota diagnostic on GET 404", async () => {
    const { client } = clientWithStatus(404);
    await expect(client.readSandboxQuota()).rejects.toThrow(
      /ResourceQuota .* not found/,
    );
  });
  it("preserves an empty pod list on GET 404", async () => {
    const { client } = clientWithStatus(404);
    await expect(client.listSandboxPods()).resolves.toEqual([]);
  });
});
it("stops sandbox launch on POST 404 without polling readiness", async () => {
  const { client, fetch } = clientWithStatus(404);
  // A readiness GET would succeed, exposing accidental continuation after POST 404.
  fetch.mockResolvedValueOnce(
    new Response("namespace not found", { status: 404 }),
  );
  fetch.mockImplementation(async () =>
    Response.json({
      metadata: { name: "pod" },
      status: { conditions: [{ type: "Ready", status: "True" }] },
    }),
  );
  const getPod = vi.spyOn(client, "getPod");
  const unused = () => {
    throw new Error("launch must not access the runtime or environment");
  };
  const capacity = new SandboxCapacity(unused, client, {
    requests: { cpu: "100m", memory: "128Mi" },
    limits: { cpu: "1", memory: "1Gi" },
  });
  vi.spyOn(capacity, "acquireSandbox").mockResolvedValue(undefined);
  const manager = new SandboxManager(unused, client, capacity, {
    createEnvironment: unused,
    createCaptureEnvironment: unused,
  });
  await expect(
    manager.ensureSandbox(
      {
        sandbox: {
          pod: "pod",
          token: "test-token",
          images: { execution: "test-image" },
          skillCacheClaim: "test-cache",
        },
        selection: [],
        conversationId: "12",
        taskId: taskId(24),
        template: "worker",
      },
      BACKGROUND_CONTEXT,
    ),
  ).rejects.toThrow(
    "POST /api/v1/namespaces/namespace/pods → 404: namespace not found",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(getPod).not.toHaveBeenCalled();
});
