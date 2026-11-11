import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage, type JsonObject } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import { ask } from "../mocks/router.ts";
import {
  openKaeno,
  type KaenoExtension,
} from "../../src/core/application/index.ts";
import {
  CLUSTER_TOOLS,
  loadClusterObserverConfiguration,
} from "../../src/extensions/kubernetes/index.ts";

const CANARY = "CANARY-91be";
const TOKEN = "observer-token";

function pod(namespace: string, name: string, ready: boolean, restarts = 0) {
  return {
    metadata: {
      name,
      namespace,
      creationTimestamp: "2026-11-01T00:00:00Z",
      annotations: { note: CANARY },
    },
    spec: {
      nodeName: "node-1",
      containers: [
        {
          name: "app",
          image: "web:1",
          env: [{ name: "SECRET", value: CANARY }],
          args: [`--token=${CANARY}`],
        },
      ],
    },
    status: {
      phase: "Running",
      containerStatuses: [
        {
          name: "app",
          ready,
          restartCount: restarts,
          state: ready
            ? { running: {} }
            : { waiting: { reason: "CrashLoopBackOff" } },
        },
      ],
    },
  };
}
const pods = [
  pod("apps", "web", true),
  pod("apps", "worker", false, 12),
  pod("vault", "vault-0", true),
];
const recent = new Date(Date.now() - 60_000).toISOString();
const events = [
  {
    metadata: { name: "e1", namespace: "apps" },
    involvedObject: { kind: "Pod", namespace: "apps", name: "worker" },
    type: "Warning",
    reason: "BackOff",
    message: "Back-off restarting failed container app",
    count: 30,
    lastTimestamp: recent,
  },
  {
    metadata: { name: "e2", namespace: "vault" },
    involvedObject: { kind: "Pod", namespace: "vault", name: "vault-0" },
    type: "Warning",
    reason: "Unhealthy",
    message: "sealed",
    lastTimestamp: recent,
  },
];

function cluster() {
  const requests: { method: string; path: string }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({ method, path: `${url.pathname}${url.search}` });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${TOKEN}`,
    );
    const path = url.pathname;
    if (path === "/api/v1/nodes") {
      return Response.json({
        items: [
          {
            metadata: { name: "node-1" },
            status: {
              conditions: [
                { type: "Ready", status: "True" },
                { type: "MemoryPressure", status: "False" },
              ],
              nodeInfo: { kubeletVersion: "v1.34.1" },
            },
          },
        ],
      });
    }
    if (path === "/apis/metrics.k8s.io/v1beta1/nodes") {
      return Response.json({
        items: [
          {
            metadata: { name: "node-1" },
            usage: { cpu: "1500000000n", memory: "2097152Ki" },
          },
        ],
      });
    }
    if (path === "/api/v1/pods") {
      return Response.json({ items: pods });
    }
    if (path === "/api/v1/namespaces/apps/pods/worker") {
      return Response.json(pods[1]);
    }
    if (path === "/api/v1/namespaces/apps/pods/worker/log") {
      return new Response(
        `2026-11-11T10:00:00Z starting\n2026-11-11T10:00:01Z connecting with password=${CANARY}\n`,
      );
    }
    if (path === "/api/v1/events" || path.endsWith("/events")) {
      return Response.json({ items: events });
    }
    if (path.startsWith("/apis/apps/v1/")) {
      return Response.json({
        items:
          path === "/apis/apps/v1/deployments"
            ? [
                {
                  metadata: { name: "worker", namespace: "apps" },
                  spec: { replicas: 1 },
                  status: { readyReplicas: 0 },
                },
              ]
            : [],
      });
    }
    if (path === "/api/v1/namespaces/apps/secrets") {
      throw new Error("never requested");
    }
    return new Response(`not found ${TOKEN}`, { status: 404 });
  });
  return { fetch, requests };
}

async function observer(
  config: object,
  fetch: typeof globalThis.fetch,
): Promise<KaenoExtension> {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-cluster-"));
  await writeFile(join(directory, "token"), `${TOKEN}\n`);
  await writeFile(
    join(directory, "cluster.json"),
    JSON.stringify({
      api: "http://cluster.test",
      tokenFile: "./token",
      caFile: null,
      ...config,
    }),
  );
  return loadClusterObserverConfiguration(
    join(directory, "cluster.json"),
    fetch,
  );
}

async function call(
  extension: KaenoExtension,
  name: string,
  args: JsonObject,
): Promise<{ output: string; error: boolean }> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let output = "";
  let error = false;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
    async (request) => {
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      if (result?.role === "toolResult") {
        const content = result.content[0];
        output = content?.type === "text" ? content.text : "";
        error = result.isError;
      }
      return fauxAssistantMessage("Done");
    },
  ]);
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models,
    extensions: [extension],
    assistant: {
      model: { provider: "faux", modelId: "faux-1" },
      instructions: "Watch the cluster",
      tools: [name],
    },
  });
  try {
    expect(await ask(core, "Check")).toBe("Done");
    return { output, error };
  } finally {
    await core.close();
  }
}

const config = { exclude: ["vault"], logs: { namespaces: ["apps"] } };

it("registers every tool as read-only and safe to replay", async () => {
  const extension = await observer(config, cluster().fetch);
  expect(extension.readOnlyTools).toEqual([...CLUSTER_TOOLS]);
  for (const tool of extension.durable.tools ?? []) {
    expect(tool.replay).toBe("safe");
  }
});

it("summarizes the cluster without excluded namespaces or secrets, using only GETs", async () => {
  const { fetch, requests } = cluster();
  const { output, error } = await call(
    await observer(config, fetch),
    "cluster_overview",
    {},
  );
  expect(error).toBe(false);
  const overview = JSON.parse(output);
  expect(overview).toMatchObject({
    nodes: [
      {
        name: "node-1",
        ready: "True",
        pressure: [],
        usage: { cpuMillicores: 1500, memoryMiB: 2048 },
      },
    ],
    pods: { total: 2, byStatus: { Running: 1, CrashLoopBackOff: 1 } },
    unhealthyPods: [{ name: "worker", restarts: 12 }],
    degradedWorkloads: [{ kind: "deployments", name: "worker", ready: "0/1" }],
    warningsLastHour: 1,
    recentWarnings: [{ reason: "BackOff", object: "Pod/apps/worker" }],
  });
  expect(output).not.toContain("vault");
  expect(output).not.toContain(CANARY);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  expect(
    requests.some((request) => /secrets|configmaps/.test(request.path)),
  ).toBe(false);
});

it("describes a pod with its events", async () => {
  const { fetch } = cluster();
  const { output } = await call(
    await observer(config, fetch),
    "cluster_describe",
    { kind: "pods", namespace: "apps", name: "worker" },
  );
  expect(JSON.parse(output)).toMatchObject({
    metadata: { name: "worker" },
    status: { containerStatuses: [{ restartCount: 12 }] },
    events: [{ reason: "BackOff" }],
  });
  expect(output).not.toContain(CANARY);
});

it("refuses excluded namespaces and logs outside the allowlist", async () => {
  const { fetch, requests } = cluster();
  const extension = await observer(config, fetch);
  expect(
    await call(extension, "cluster_list", { kind: "pods", namespace: "vault" }),
  ).toEqual({
    output: expect.stringContaining("not visible"),
    error: true,
  });
  expect(
    await call(extension, "cluster_logs", { namespace: "media", pod: "x" }),
  ).toEqual({
    output: expect.stringContaining("not available"),
    error: true,
  });
  expect(requests).toEqual([]);
});

it("reads logs with likely secrets masked", async () => {
  const { fetch, requests } = cluster();
  const { output } = await call(await observer(config, fetch), "cluster_logs", {
    namespace: "apps",
    pod: "worker",
    tailLines: 50,
  });
  expect(output).toContain("starting");
  expect(output).toContain("password=[REDACTED]");
  expect(output).not.toContain(CANARY);
  expect(requests[0]?.path).toBe(
    "/api/v1/namespaces/apps/pods/worker/log?tailLines=50&timestamps=true",
  );
});

it("reports API failures without their bodies", async () => {
  const { fetch } = cluster();
  const { output, error } = await call(
    await observer(config, fetch),
    "cluster_describe",
    { kind: "nodes", name: "missing" },
  );
  expect(error).toBe(true);
  expect(output).toContain("not found");
  expect(output).not.toContain(TOKEN);
});
