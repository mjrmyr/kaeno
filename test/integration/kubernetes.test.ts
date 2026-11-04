import {
  BACKGROUND_CONTEXT as context,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { getCurrentSystemPrompt, Type } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import {
  createRegistry,
  defineExtension,
  defineTask,
  defineTool,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  kubernetesExtension,
  loadKubernetesConfiguration,
  type KubernetesExtensionOptions,
} from "../../src/extensions/kubernetes/index.ts";
import {
  EnvironmentServer,
  RemoteExecutionEnv,
} from "../../src/extensions/execution/index.ts";
import {
  openKaeno,
  type AgentProfile,
} from "../../src/core/application/index.ts";
import type { WorkInstance } from "../../src/core/work/index.ts";
import { ROUTER_ASSISTANT_TOOLS, startTicket } from "../mocks/router.ts";

const resources = {
  requests: { cpu: "100m", memory: "128Mi" },
  limits: { cpu: "1", memory: "1Gi" },
};
const manifestSchema = z
  .object({
    metadata: z.object({
      name: z.string(),
      labels: z.record(z.string(), z.string()),
      annotations: z.record(z.string(), z.string()),
    }),
    spec: z
      .object({
        containers: z.array(z.object({ image: z.string() }).passthrough()),
      })
      .passthrough(),
  })
  .passthrough();
const Hold = defineTask<null, { phase: "hold" }, null>({
  name: "kubernetes-test.hold",
  version: 1,
  initial: () => ({ phase: "hold" }),
  phases: {
    hold: async (_task, runtime, taskContext) => {
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "completed", result: null },
        }),
        taskContext,
      );
    },
  },
  abort: async (_task, runtime, taskContext) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      taskContext,
    );
  },
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function cluster() {
  const pods = new Map<string, z.infer<typeof manifestSchema>>();
  let quota: Record<string, string> = { pods: "1" };
  let waitingReason: string | undefined;
  let status = "Running";
  let ready = true;
  let postStatus = 201;
  let deleting = false;
  let rejectDelete: string | undefined;
  let statusReason: string | undefined;
  let token = "cluster-secret";
  const runtimeClasses = new Map<string, Record<string, string>>();
  const requests: { method: string; path: string; body: string }[] = [];
  const api = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname;
    const body = String(init?.body ?? "");
    requests.push({ method, path, body });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${token}`,
    );
    const runtimeClass =
      /^\/apis\/node\.k8s\.io\/v1\/runtimeclasses\/(.+)$/.exec(path)?.[1];
    if (runtimeClass !== undefined) {
      const podFixed = runtimeClasses.get(runtimeClass);
      return podFixed
        ? Response.json({ handler: "kata", overhead: { podFixed } })
        : new Response(null, { status: 404 });
    }
    if (path.includes("resourcequotas")) {
      return Response.json({ spec: { scopes: ["Terminating"], hard: quota } });
    }
    if (method === "POST") {
      if (postStatus !== 201) {
        return new Response(`exceeded quota ${token} ${body}`, {
          status: postStatus,
        });
      }
      const pod = manifestSchema.parse(JSON.parse(body));
      if (pods.has(pod.metadata.name)) {
        return new Response(null, { status: 409 });
      }
      pods.set(pod.metadata.name, pod);
      return Response.json(pod, { status: 201 });
    }
    const name = path.split("/").at(-1) ?? "";
    if (method === "DELETE") {
      if (name === rejectDelete) {
        return new Response(null, { status: 403 });
      }
      if (!deleting) {
        pods.delete(name);
      }
      return new Response(null, { status: 200 });
    }
    function wire(pod: z.infer<typeof manifestSchema>) {
      return {
        ...pod,
        status: {
          phase: status,
          reason: statusReason,
          conditions: ready ? [{ type: "Ready", status: "True" }] : [],
          containerStatuses: waitingReason
            ? [{ name: "envd", state: { waiting: { reason: waitingReason } } }]
            : [],
        },
      };
    }
    if (name === "pods") {
      const selector = url.searchParams.get("labelSelector") ?? "";
      const owner = /kaeno.io\/owner=([^,]+)/.exec(selector)?.[1];
      return Response.json({
        items: [...pods.values()]
          .filter(
            (pod) => !owner || pod.metadata.labels["kaeno.io/owner"] === owner,
          )
          .map(wire),
      });
    }
    const pod = pods.get(name);
    return pod ? Response.json(wire(pod)) : new Response(null, { status: 404 });
  });
  return {
    pods,
    api,
    requests,
    quota: (value: typeof quota) => {
      quota = value;
    },
    status: (value: string, reason?: string) => {
      status = value;
      statusReason = reason;
    },
    rejectDelete: (name?: string) => {
      rejectDelete = name;
    },
    waiting: (reason: string) => {
      waitingReason = reason;
    },
    ready: (value: boolean) => {
      ready = value;
    },
    postStatus: (value: number) => {
      postStatus = value;
    },
    deleting: (value: boolean) => {
      deleting = value;
    },
    runtimeClass: (name: string, podFixed: Record<string, string>) => {
      runtimeClasses.set(name, podFixed);
    },
    rotate: () => {
      token = "rotated-secret";
    },
    token: () => token,
  };
}

async function fixture(overrides: Partial<KubernetesExtensionOptions> = {}) {
  const server = cluster();
  const options: KubernetesExtensionOptions = {
    namespace: "test",
    owner: "owner",
    image: "test-image",
    resources,
    readToken: async () => server.token(),
    fetch: server.api,
    createEnvironment: ({ url, token, id, cwd }) =>
      new RemoteExecutionEnv(url, token, id, cwd, fetch),
    ...overrides,
  };
  const extension = kubernetesExtension(options);
  const registry = createRegistry();
  registry.install(extension.extension.durable);
  registry.install(defineExtension({ name: "kubernetes-test", tasks: [Hold] }));
  const harness = await Harness.open(
    new MemoryStorage(),
    { registry, models: createModels() },
    context,
  );
  cleanups.push(() => harness.close(context));
  async function work(): Promise<WorkInstance> {
    const conversation = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      context,
    );
    const workId = await harness.commit(
      (tx) =>
        tx.createTask(Hold, null, {
          ownership: { kind: "conversation" },
          conversationId: conversation.id,
          background: true,
        }),
      context,
    );
    return { workId, conversationId: conversation.id };
  }
  return { ...extension, server, harness, work, options };
}

it("creates isolated pods, reuses identity, rotates credentials, and releases idempotently", async () => {
  const rig = await fixture();
  const work = await rig.work();
  await rig.environment.ensure(work, rig.harness, context);
  const creation = rig.server.requests.find(
    (request) => request.method === "POST",
  );
  if (!creation) {
    throw new Error("Missing pod creation");
  }
  const manifest = JSON.parse(creation.body);
  expect(manifest.spec).toMatchObject({
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    activeDeadlineSeconds: 14400,
    securityContext: {
      runAsNonRoot: true,
      runAsUser: 1000,
      seccompProfile: { type: "RuntimeDefault" },
    },
    containers: [
      {
        resources,
        securityContext: {
          readOnlyRootFilesystem: true,
          allowPrivilegeEscalation: false,
          capabilities: { drop: ["ALL"] },
        },
      },
    ],
  });
  expect(JSON.stringify(manifest)).not.toContain("cluster-secret");
  expect(
    manifest.spec.containers[0].env.map(
      (entry: { name: string }) => entry.name,
    ),
  ).toEqual(["KAENO_ENV_TOKEN", "HOME", "TMPDIR"]);
  rig.server.rotate();
  await rig.environment.ensure(work, rig.harness, context);
  expect(
    rig.server.requests.filter((request) => request.method === "POST"),
  ).toHaveLength(1);
  await rig.environment.release(work, rig.harness);
  await rig.environment.release(work, rig.harness);
  expect(rig.server.pods.size).toBe(0);
  expect(
    rig.server.requests.filter((request) => request.method === "DELETE"),
  ).toHaveLength(1);
});

it("queues FIFO against live quota and notices quota increases without restart", async () => {
  const rig = await fixture();
  const first = await rig.work();
  const second = await rig.work();
  const third = await rig.work();
  await rig.environment.ensure(first, rig.harness, context);
  vi.useFakeTimers();
  const waiting = rig.environment.ensure(second, rig.harness, context);
  const last = rig.environment.ensure(third, rig.harness, context);
  await vi.advanceTimersByTimeAsync(250);
  expect(rig.server.pods.size).toBe(1);
  rig.server.quota({ pods: "2" });
  await vi.advanceTimersByTimeAsync(250);
  await waiting;
  expect(rig.server.pods.has(`owner-work-${second.workId}`)).toBe(true);
  expect(rig.server.pods.has(`owner-work-${third.workId}`)).toBe(false);
  await rig.environment.release(first, rig.harness);
  await vi.advanceTimersByTimeAsync(250);
  await last;
  expect(rig.server.pods.size).toBe(2);
});

it("counts foreign physical pods but only sweeps its own orphans", async () => {
  const rig = await fixture();
  const first = await rig.work();
  await rig.environment.ensure(first, rig.harness, context);
  const original = [...rig.server.pods.values()][0];
  rig.server.pods.set("foreign", {
    ...original,
    metadata: {
      ...original.metadata,
      name: "foreign",
      labels: { ...original.metadata.labels, "kaeno.io/owner": "other" },
    },
  });
  const second = await rig.work();
  vi.useFakeTimers();
  const controller = new AbortController();
  const blocked = rig.environment.ensure(
    second,
    rig.harness,
    withAbortSignal(controller.signal, context),
  );
  await Promise.all([
    expect(blocked).rejects.toThrow(/aborted|cancelled/),
    vi
      .advanceTimersByTimeAsync(250)
      .then(() => controller.abort(new Error("cancelled"))),
  ]);
  expect(rig.server.pods.size).toBe(2);
  await rig.environment.release(second, rig.harness);
  rig.harness.resume();
  await rig.harness.waitForTask(first.workId, context);
  await rig.environment.reconcile([], rig.harness);
  expect([...rig.server.pods.keys()]).toEqual(["foreign"]);
});

it.each(["Running", "Succeeded", "Failed"])(
  "reconciles by durable task liveness, not pod phase (%s)",
  async (phase) => {
    const rig = await fixture();
    const work = await rig.work();
    await rig.environment.ensure(work, rig.harness, context);
    rig.server.status(phase);

    // An unfinished task (including one waiting for a reply) keeps its sandbox,
    // even if envd has exited. Also recheck tasks missing from an earlier scan.
    await rig.environment.reconcile([work], rig.harness);
    await rig.environment.reconcile([], rig.harness);
    expect(rig.server.pods.has(`owner-work-${work.workId}`)).toBe(true);
    expect(
      rig.server.requests.filter((request) => request.method === "DELETE"),
    ).toHaveLength(0);

    rig.harness.resume();
    await rig.harness.waitForTask(work.workId, context);
    await rig.environment.reconcile([], rig.harness);
    await rig.environment.reconcile([], rig.harness);
    expect(rig.server.pods.size).toBe(0);
    expect(
      rig.server.requests.filter((request) => request.method === "DELETE"),
    ).toHaveLength(1);
  },
);

it.each(["Succeeded", "Failed"])(
  "detects an expired/stopped sandbox without recreating it (%s)",
  async (phase) => {
    const rig = await fixture();
    const work = await rig.work();
    await rig.environment.ensure(work, rig.harness, context);
    expect(
      await rig.environment.check?.(work, rig.harness, context),
    ).toBeUndefined();
    rig.server.status(
      phase,
      phase === "Failed" ? "DeadlineExceeded" : undefined,
    );
    expect(await rig.environment.check?.(work, rig.harness, context)).toContain(
      phase === "Failed" ? "DeadlineExceeded" : "Succeeded",
    );
    await expect(
      rig.environment.ensure(work, rig.harness, context),
    ).rejects.toThrow(/failed:/);
    expect(
      rig.server.requests.filter((request) => request.method === "POST"),
    ).toHaveLength(1);
  },
);

it("fails rather than recreating a lost admitted workspace on supervision reentry", async () => {
  const rig = await fixture();
  const work = await rig.work();
  await rig.environment.ensure(work, rig.harness, context);
  rig.server.pods.clear();
  expect(await rig.environment.check?.(work, rig.harness, context)).toContain(
    "cannot be restored",
  );
  await expect(
    rig.environment.ensure(work, rig.harness, context),
  ).rejects.toThrow("cannot be restored");
  expect(
    rig.server.requests.filter((request) => request.method === "POST"),
  ).toHaveLength(1);
  await rig.environment.release(work, rig.harness);
});

it("does not misclassify API or identity errors as confirmed sandbox loss", async () => {
  const rig = await fixture();
  const work = await rig.work();
  await rig.environment.ensure(work, rig.harness, context);
  rig.server.api.mockRejectedValueOnce(new Error("API unavailable"));
  await expect(
    rig.environment.check?.(work, rig.harness, context),
  ).rejects.toThrow("API unavailable");
  const pod = [...rig.server.pods.values()][0];
  pod.metadata.annotations["kaeno.io/token-sha256"] = "different";
  await expect(
    rig.environment.check?.(work, rig.harness, context),
  ).rejects.toThrow("identity mismatch");
  expect(
    rig.server.requests.filter((request) => request.method === "DELETE"),
  ).toHaveLength(0);
});

it.each(["api", "identity"])(
  "continues cleanup past a failed reservation without bypassing its %s guard",
  async (mode) => {
    const rig = await fixture();
    rig.server.quota({ pods: "2" });
    const first = await rig.work();
    const second = await rig.work();
    await rig.environment.ensure(first, rig.harness, context);
    await rig.environment.ensure(second, rig.harness, context);
    const firstName = `owner-work-${first.workId}`;
    if (mode === "api") {
      rig.server.rejectDelete(firstName);
    } else {
      const pod = rig.server.pods.get(firstName);
      if (!pod) {
        throw new Error("Missing first sandbox");
      }
      pod.metadata.annotations["kaeno.io/token-sha256"] = "different";
    }
    rig.harness.resume();
    await rig.harness.waitForTask(first.workId, context);
    await rig.harness.waitForTask(second.workId, context);
    await expect(rig.environment.reconcile([], rig.harness)).rejects.toThrow(
      "Kubernetes sandbox reconciliation failed",
    );
    expect([...rig.server.pods.keys()]).toEqual([firstName]);
    if (mode === "api") {
      rig.server.rejectDelete();
      await rig.environment.reconcile([], rig.harness);
      await rig.environment.reconcile([], rig.harness);
      expect(rig.server.pods.size).toBe(0);
    } else {
      // An orphan sweep must not bypass the failed reservation identity check.
      expect(
        rig.server.requests.filter(
          (request) =>
            request.method === "DELETE" && request.path.endsWith(firstName),
        ),
      ).toHaveLength(0);
    }
  },
);

it("continues orphan cleanup after one deletion fails, then retries", async () => {
  const rig = await fixture();
  const work = await rig.work();
  await rig.environment.ensure(work, rig.harness, context);
  const original = [...rig.server.pods.values()][0];
  for (const name of ["orphan-one", "orphan-two"]) {
    rig.server.pods.set(name, {
      ...original,
      metadata: {
        ...original.metadata,
        name,
        annotations: {
          ...original.metadata.annotations,
          "kaeno.io/work": "999999",
        },
      },
    });
  }
  rig.server.rejectDelete("orphan-one");
  await expect(rig.environment.reconcile([work], rig.harness)).rejects.toThrow(
    "Kubernetes sandbox reconciliation failed",
  );
  expect(rig.server.pods.has("orphan-one")).toBe(true);
  expect(rig.server.pods.has("orphan-two")).toBe(false);
  expect(rig.server.pods.has(`owner-work-${work.workId}`)).toBe(true);
  rig.server.rejectDelete();
  await rig.environment.reconcile([work], rig.harness);
  expect([...rig.server.pods.keys()]).toEqual([`owner-work-${work.workId}`]);
});

it.each([400, 404, 500])(
  "propagates POST %i immediately without readiness polling or credential disclosure",
  async (status) => {
    const rig = await fixture();
    rig.server.postStatus(status);
    const work = await rig.work();
    const result = rig.environment.ensure(work, rig.harness, context);
    await expect(result).rejects.toThrow(`HTTP ${status}`);
    await expect(result).rejects.not.toThrow("cluster-secret");
    expect(rig.server.requests.at(-1)?.method).toBe("POST");
    expect(
      rig.server.requests.filter((request) => request.method === "POST"),
    ).toHaveLength(1);
    await rig.environment.release(work, rig.harness);
  },
);

it.each([false, true])(
  "validates identity after a POST conflict (mismatched: %s)",
  async (mismatched) => {
    const rig = await fixture();
    const original = rig.server.api.getMockImplementation();
    if (!original) {
      throw new Error("Missing API transport");
    }
    rig.server.api.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (init?.method !== "POST") {
        return response;
      }
      if (mismatched) {
        for (const pod of rig.server.pods.values()) {
          pod.metadata.annotations["kaeno.io/token-sha256"] =
            "different-owner-token";
        }
      }
      return new Response(null, { status: 409 });
    });
    const work = await rig.work();
    const result = rig.environment.ensure(work, rig.harness, context);
    if (mismatched) {
      await expect(result).rejects.toThrow("identity mismatch");
    } else {
      await result;
    }
    expect(rig.server.pods.size).toBe(1);
  },
);

it("recovers from transient quota rejection without losing its held reservation", async () => {
  const rig = await fixture();
  const original = rig.server.api.getMockImplementation();
  if (!original) {
    throw new Error("Missing API transport");
  }
  let attempts = 0;
  rig.server.api.mockImplementation(async (input, init) => {
    if (init?.method === "POST") {
      attempts++;
      rig.server.postStatus(attempts <= 2 ? 403 : 201);
    }
    return original(input, init);
  });
  const work = await rig.work();
  vi.useFakeTimers();
  await Promise.all([
    rig.environment.ensure(work, rig.harness, context),
    vi.advanceTimersByTimeAsync(2000),
  ]);
  expect(attempts).toBe(3);
  expect(rig.server.pods.size).toBe(1);
  await rig.environment.ensure(work, rig.harness, context);
  expect(attempts).toBe(3);
});

it("bounds quota rejection at five POSTs, then frees its reservation", async () => {
  const rig = await fixture();
  rig.server.postStatus(403);
  const work = await rig.work();
  vi.useFakeTimers();
  await Promise.all([
    expect(rig.environment.ensure(work, rig.harness, context)).rejects.toThrow(
      "after 5 attempts",
    ),
    vi.advanceTimersByTimeAsync(4000),
  ]);
  expect(
    rig.server.requests.filter((request) => request.method === "POST"),
  ).toHaveLength(5);
  rig.server.postStatus(201);
  await rig.environment.ensure(await rig.work(), rig.harness, context);
});

it("does not free a reservation while its pod is still terminating", async () => {
  const rig = await fixture();
  const first = await rig.work();
  await rig.environment.ensure(first, rig.harness, context);
  rig.server.deleting(true);
  vi.useFakeTimers();
  await Promise.all([
    expect(rig.environment.release(first, rig.harness)).rejects.toThrow(
      "capacity remains reserved",
    ),
    vi.advanceTimersByTimeAsync(10_000),
  ]);
  rig.server.deleting(false);
  await rig.environment.release(first, rig.harness);
  await rig.environment.ensure(await rig.work(), rig.harness, context);
});

it.each(["Failed", "Succeeded"])(
  "fails immediately on terminal pod phase %s",
  async (phase) => {
    const rig = await fixture();
    rig.server.status(phase);
    await expect(
      rig.environment.ensure(await rig.work(), rig.harness, context),
    ).rejects.toThrow(`pod ${phase}`);
  },
);

it.each([
  "ImagePullBackOff",
  "ErrImagePull",
  "CreateContainerConfigError",
  "InvalidImageName",
  "CrashLoopBackOff",
])("reports waiting container failure %s immediately", async (reason) => {
  const rig = await fixture();
  rig.server.waiting(reason);
  await expect(
    rig.environment.ensure(await rig.work(), rig.harness, context),
  ).rejects.toThrow(reason);
});

it("bounds readiness waits and supports cancellation", async () => {
  const rig = await fixture({ readyTimeoutMs: 2000 });
  rig.server.ready(false);
  const work = await rig.work();
  vi.useFakeTimers();
  await Promise.all([
    expect(rig.environment.ensure(work, rig.harness, context)).rejects.toThrow(
      "not ready before timeout",
    ),
    vi.advanceTimersByTimeAsync(2000),
  ]);
  const controller = new AbortController();
  await Promise.all([
    expect(
      rig.environment.ensure(
        work,
        rig.harness,
        withAbortSignal(controller.signal, context),
      ),
    ).rejects.toThrow(/aborted|cancelled/),
    vi
      .advanceTimersByTimeAsync(250)
      .then(() => controller.abort(new Error("cancelled"))),
  ]);
});

it("refuses adoption and deletion when a deterministic pod has a different identity", async () => {
  const rig = await fixture();
  const work = await rig.work();
  await rig.environment.ensure(work, rig.harness, context);
  const pod = [...rig.server.pods.values()][0];
  pod.metadata.annotations["kaeno.io/token-sha256"] = "wrong";
  await expect(
    rig.environment.ensure(work, rig.harness, context),
  ).rejects.toThrow("identity mismatch");
  await expect(rig.environment.release(work, rig.harness)).rejects.toThrow(
    "identity mismatch",
  );
  expect(
    rig.server.requests.filter((request) => request.method === "DELETE"),
  ).toHaveLength(0);
});

it("runs pods under a configured RuntimeClass and charges its overhead to quota", async () => {
  const rig = await fixture({ runtimeClassName: "kata-qemu" });
  rig.server.runtimeClass("kata-qemu", { cpu: "250m", memory: "160Mi" });
  // 100m + 250m requests fit twice in 800m; without overhead they would fit eight times.
  rig.server.quota({ "requests.cpu": "800m", pods: "8" });
  expect(await rig.environment.capacity?.(context)).toBe(2);
  // 1Gi + 160Mi limits fit once in 2Gi.
  rig.server.quota({ "limits.memory": "2Gi" });
  expect(await rig.environment.capacity?.(context)).toBe(1);
  await rig.environment.ensure(await rig.work(), rig.harness, context);
  const creation = rig.server.requests.find(
    (request) => request.method === "POST",
  );
  expect(JSON.parse(creation?.body ?? "{}").spec.runtimeClassName).toBe(
    "kata-qemu",
  );
  expect(
    rig.server.requests.some(
      (request) =>
        request.path === "/apis/node.k8s.io/v1/runtimeclasses/kata-qemu",
    ),
  ).toBe(true);
});

it("rejects a configured RuntimeClass that does not exist", async () => {
  const rig = await fixture({ runtimeClassName: "kata-qemu" });
  await expect(rig.environment.capacity?.(context)).rejects.toThrow(
    "RuntimeClass kata-qemu not found",
  );
});

it.each<{ configured?: string; actual?: string }>([
  { actual: "kata-qemu" },
  { configured: "kata-qemu" },
])(
  "refuses to adopt a pod with RuntimeClass $actual when $configured is configured",
  async ({ configured, actual }) => {
    const rig = await fixture(
      configured ? { runtimeClassName: configured } : {},
    );
    if (configured) {
      rig.server.runtimeClass(configured, {});
    }
    const work = await rig.work();
    await rig.environment.ensure(work, rig.harness, context);
    const pod = [...rig.server.pods.values()][0];
    pod.spec = { ...pod.spec, runtimeClassName: actual };
    await expect(
      rig.environment.ensure(work, rig.harness, context),
    ).rejects.toThrow("identity mismatch");
  },
);

it("keeps identities without a RuntimeClass and rejects adding one to saved work", async () => {
  const rig = await fixture();
  expect(rig.environment.identity).toBe(
    `kubernetes:${JSON.stringify({
      api: "https://kubernetes.default.svc",
      namespace: "test",
      owner: "owner",
      resources,
      quota: "kaeno-sandbox",
      service: "kaeno-sandbox",
      serviceAccount: "kaeno-sandbox",
    })}`,
  );
  const work = await rig.work();
  await rig.environment.ensure(work, rig.harness, context);
  const kata = kubernetesExtension({
    ...rig.options,
    runtimeClassName: "kata-qemu",
  });
  expect(kata.environment.identity).not.toBe(rig.environment.identity);
  await expect(kata.environment.reconcile([work], rig.harness)).rejects.toThrow(
    "differs",
  );
});

it("adopts a changed target once no sandbox reservations remain", async () => {
  const rig = await fixture();
  const first = await rig.work();
  await rig.environment.ensure(first, rig.harness, context);
  await rig.environment.release(first, rig.harness);
  // A restart after all work finished, now with Kata configured.
  const kata = kubernetesExtension({
    ...rig.options,
    runtimeClassName: "kata-qemu",
  });
  rig.server.runtimeClass("kata-qemu", {});
  await kata.environment.reconcile([], rig.harness);
  const second = await rig.work();
  await kata.environment.ensure(second, rig.harness, context);
  expect(
    rig.server.pods.get(`owner-work-${second.workId}`)?.spec.runtimeClassName,
  ).toBe("kata-qemu");
  // The adopted target is now the saved one: the previous configuration is refused.
  await expect(
    rig.environment.reconcile([second], rig.harness),
  ).rejects.toThrow("1 sandbox reservation(s) remain");
});

it("validates resource quantities and rejects a quota that cannot fit a sandbox", async () => {
  expect(() =>
    kubernetesExtension({
      namespace: "test",
      owner: "owner",
      image: "image",
      resources: {
        requests: { cpu: "2", memory: "1Gi" },
        limits: { cpu: "1", memory: "1Gi" },
      },
      readToken: async () => "secret",
      createEnvironment: () => {
        throw new Error("unused");
      },
    }),
  ).toThrow("requests <= limits");
  const rig = await fixture();
  rig.server.quota({ pods: "0" });
  await expect(
    rig.environment.ensure(await rig.work(), rig.harness, context),
  ).rejects.toThrow("fits no sandbox");
});

it.each<{ hard: Record<string, string>; slots: number }>([
  {
    hard: { "requests.cpu": "500m", "limits.memory": "1500Mi", pods: "8" },
    slots: 1,
  },
  { hard: { "requests.memory": "1G" }, slots: 7 },
  { hard: { "limits.cpu": "2500m" }, slots: 2 },
  { hard: { pods: "3" }, slots: 3 },
])(
  "derives $slots slots from the tightest quota bound $hard",
  async ({ hard, slots }) => {
    const rig = await fixture();
    rig.server.quota(hard);
    expect(await rig.environment.capacity?.(context)).toBe(slots);
  },
);

it.each<{ hard: Record<string, string>; error: string }>([
  { hard: { "requests.ephemeral-storage": "1Gi" }, error: "ephemeral-storage" },
  {
    hard: { "limits.cpu": "broken" },
    error: "Invalid Kubernetes quota quantity",
  },
  { hard: { services: "5" }, error: "must bound pods, CPU or memory" },
])("rejects unusable quota $hard", async ({ hard, error }) => {
  const rig = await fixture();
  rig.server.quota(hard);
  await expect(rig.environment.capacity?.(context)).rejects.toThrow(error);
});

it("reopens SQLite, adopts saved pod/token/image, and rejects retargeting saved work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-kubernetes-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const rig = await fixture();
  const database = join(directory, "state.sqlite");
  async function open() {
    const registry = createRegistry();
    registry.install(rig.extension.durable);
    registry.install(
      defineExtension({ name: "kubernetes-test", tasks: [Hold] }),
    );
    return Harness.open(
      await openNodeSqliteStorage(database),
      { registry, models: createModels() },
      context,
    );
  }
  const harness = await open();
  const conversation = await harness.createConversation(
    { ownership: { kind: "ownerless" } },
    context,
  );
  const workId = await harness.commit(
    (tx) =>
      tx.createTask(Hold, null, {
        ownership: { kind: "conversation" },
        conversationId: conversation.id,
        background: true,
      }),
    context,
  );
  const work = { workId, conversationId: conversation.id };
  const original = rig.server.api.getMockImplementation();
  if (!original) {
    throw new Error("Missing API transport");
  }
  rig.server.api.mockImplementation(async (input, init) => {
    const response = await original(input, init);
    if (init?.method === "POST") {
      throw new Error("Lost response after pod creation");
    }
    return response;
  });
  await expect(rig.environment.ensure(work, harness, context)).rejects.toThrow(
    "Lost response",
  );
  await harness.close(context);
  const reopened = await open();
  cleanups.push(() => reopened.close(context));
  const replacement = kubernetesExtension({
    ...rig.options,
    image: "new-image",
  });
  await replacement.environment.reconcile([work], reopened);
  await replacement.environment.ensure(work, reopened, context);
  expect(
    rig.server.requests.filter((request) => request.method === "POST"),
  ).toHaveLength(1);
  expect([...rig.server.pods.values()][0].spec.containers[0].image).toBe(
    "test-image",
  );
  const retargeted = kubernetesExtension({
    ...rig.options,
    namespace: "other",
  });
  await expect(
    retargeted.environment.reconcile([work], reopened),
  ).rejects.toThrow("differs");
  rig.server.pods.clear();
  expect(
    await replacement.environment.check?.(work, reopened, context),
  ).toContain("cannot be restored");
  await expect(
    replacement.environment.ensure(work, reopened, context),
  ).rejects.toThrow("cannot be restored");
  expect(
    rig.server.requests.filter((request) => request.method === "POST"),
  ).toHaveLength(1);
  await replacement.environment.release(work, reopened);
});

it("loads explicit configuration with relative token paths and uses the real HTTP transport", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-kubernetes-config-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBe("Bearer local-secret");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ items: [] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing address");
  }
  await writeFile(join(directory, "token"), "local-secret\n");
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({
      api: `http://127.0.0.1:${address.port}`,
      namespace: "test",
      owner: "owner",
      image: "image",
      resources,
      tokenFile: "token",
      caFile: null,
    }),
  );
  const loaded = await loadKubernetesConfiguration(
    join(directory, "config.json"),
    {
      defaultNamespace: "unused",
      createSandboxEnvironment: () => {
        throw new Error("Kubernetes must not construct a sandbox adapter");
      },
      createEnvironment: () => {
        throw new Error("unused");
      },
    },
  );
  expect(loaded.extensions.map((extension) => extension.durable.name)).toEqual([
    "kaeno-kubernetes",
  ]);
  const rig = await fixture();
  await loaded.environment.reconcile([], rig.harness);
});

it("reports startup cleanup errors without blocking recovery and retries on the periodic sweep", async () => {
  const error = new Error("cleanup API unavailable");
  const reconcile = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(error)
    .mockResolvedValue(undefined);
  const onReport = vi.fn<(error: unknown) => void>();
  vi.useFakeTimers();
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models: createModels(),
    assistant: {
      model: { provider: "faux", modelId: "faux-1" },
      instructions: "CHAT",
    },
    work: {
      agents: [],
      tools: [],
      environment: {
        identity: "test:cleanup",
        cwd: "/workspace",
        ensure: async () => {},
        release: async () => {},
        executionEnvironment: async () => undefined,
        reconcile,
      },
    },
    onReport,
  });
  cleanups.push(() => core.close());
  expect(onReport).toHaveBeenCalledWith(error);
  expect(reconcile).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(reconcile).toHaveBeenCalledTimes(2);
  expect(onReport).toHaveBeenCalledTimes(1);
});

it("runs WORK through a pod execution environment and rejects child admission when quota is full", async () => {
  const root = await mkdtemp(join(tmpdir(), "kaeno-kubernetes-worker-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const rig = await fixture();
  let localUrl = "";
  const extension = kubernetesExtension({
    ...rig.options,
    fetch: async (input, init) => {
      const response = await rig.server.api(input, init);
      if (init?.method === "POST") {
        const manifest = z
          .object({
            spec: z.object({
              containers: z.array(
                z.object({
                  env: z.array(
                    z.object({ name: z.string(), value: z.string() }),
                  ),
                }),
              ),
            }),
          })
          .parse(JSON.parse(String(init.body)));
        const token = manifest.spec.containers[0].env.find(
          (entry) => entry.name === "KAENO_ENV_TOKEN",
        )?.value;
        if (!token) {
          throw new Error("Missing execution token");
        }
        const server = new EnvironmentServer(
          token,
          () => new NodeExecutionEnv({ cwd: root }),
          root,
        ).server;
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        cleanups.push(
          () =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        );
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Missing envd address");
        }
        localUrl = `http://127.0.0.1:${address.port}`;
      }
      return response;
    },
    createEnvironment: ({ url, token, id, cwd }) => {
      expect(url).toMatch(
        /^http:\/\/owner-work-\d+\.kaeno-sandbox\.test\.svc\.cluster\.local:7070$/,
      );
      expect(cwd).toBe("/workspace");
      return new RemoteExecutionEnv(localUrl, token, id, root, fetch);
    },
  });
  const probe = defineTool({
    name: "probe",
    description: "Exercise the worker environment",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_input, api, toolContext) => {
      if (!api.env) {
        throw new Error("Missing worker environment");
      }
      getOrThrow(
        await api.env.writeFile("proof.txt", "pod workspace", toolContext),
      );
      return {
        content: [
          {
            type: "text",
            text: getOrThrow(
              await api.env.readTextFile("proof.txt", toolContext),
            ),
          },
        ],
      };
    },
  });
  const model = { provider: "faux", modelId: "faux-1" };
  const coder: AgentProfile = {
    id: "coder",
    description: "Codes",
    setup: {
      model,
      instructions: "CODER",
      tools: [probe.name, "start_work"],
    },
  };
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let proof = "";
  let refusal = "";
  faux.setResponses(
    Array.from({ length: 20 }, () => async (request) => {
      const worker = getCurrentSystemPrompt(request.messages).includes(
        "You are Kaeno WORK",
      );
      const last = request.messages.findLast(
        (message) => message.role !== "system",
      );
      function call(name: string, input: Record<string, string>) {
        return fauxAssistantMessage([fauxToolCall(name, input)], {
          stopReason: "toolUse",
        });
      }
      if (!worker) {
        return fauxAssistantMessage("REPORTED");
      }
      if (last?.role === "toolResult" && last.toolName === "probe") {
        proof = JSON.stringify(last.content);
        return call("start_work", {
          agent: "coder",
          title: "Child",
          brief: "This must not wait forever for the parent's slot.",
        });
      }
      if (last?.role === "toolResult" && last.toolName === "start_work") {
        refusal = JSON.stringify(last.content);
        return fauxAssistantMessage("DONE");
      }
      return call("probe", {});
    }),
  );
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models,
    assistant: {
      model,
      instructions: "ROUTER",
      tools: [...ROUTER_ASSISTANT_TOOLS],
    },
    extensions: [
      extension.extension,
      { durable: defineExtension({ name: "probe", tools: [probe] }) },
    ],
    work: {
      agents: [coder],
      tools: [probe.name, "start_work"],
      environment: extension.environment,
      maxConcurrent: 4,
    },
  });
  cleanups.push(() => core.close());
  await startTicket(core, {
    agent: "coder",
    title: "Code",
    content: "Exercise the environment, then try to delegate.",
  });
  await vi.waitFor(
    () => {
      expect(proof).toContain("pod workspace");
      expect(refusal).toContain("No free work slot: 1 of 1");
      expect(rig.server.pods.size).toBe(0);
    },
    { timeout: 5000 },
  );
  expect(
    rig.server.requests.filter((request) => request.method === "POST"),
  ).toHaveLength(1);
});
