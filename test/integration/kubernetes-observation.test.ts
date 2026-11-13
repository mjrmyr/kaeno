import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { expect, it } from "vitest";
import { openKaeno } from "../../src/core/application/index.ts";
import {
  kubernetesObservationExtension,
  ObservationClient,
  KUBERNETES_OBSERVATION_TOOLS,
  KubernetesObserver,
} from "../../src/extensions/kubernetes/index.ts";
import { ask } from "../mocks/router.ts";

it("keeps raw canaries out of real model tool results and durable SQLite across reopen", async () => {
  const canary = "CANARY-raw-kubernetes-credential";
  const observer = new KubernetesObserver(
    { namespaces: ["pilot"] },
    async (path) => ({
      items: path.includes("/pods?")
        ? [
            {
              metadata: {
                name: "web",
                namespace: "pilot",
                labels: { private: canary },
                annotations: { private: canary },
              },
              spec: {
                containers: [
                  { name: "web", env: [{ value: canary }], image: canary },
                ],
              },
              status: {
                phase: "Running",
                message: canary,
                conditions: [
                  { type: "Ready", status: "False", message: canary },
                ],
                containerStatuses: [
                  {
                    name: "web",
                    ready: false,
                    restartCount: 4,
                    state: { waiting: { reason: canary, message: canary } },
                  },
                ],
              },
            },
          ]
        : [],
    }),
  );
  await observer.poll();
  const extension = kubernetesObservationExtension(
    new ObservationClient({ namespaces: ["pilot"] }, async () =>
      observer.snapshot(),
    ),
  );
  expect(extension.readOnlyTools).toEqual([...KUBERNETES_OBSERVATION_TOOLS]);
  expect(extension.durable.tools?.every((tool) => tool.replay === "safe")).toBe(
    true,
  );
  const directory = await mkdtemp(join(tmpdir(), "kaeno-observation-"));
  const path = join(directory, "core.sqlite");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const results: string[] = [];
  const requests: string[] = [];
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("kubernetes_overview", {})], {
      stopReason: "toolUse",
    }),
    async (request) => {
      requests.push(JSON.stringify(request));
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      results.push(JSON.stringify(result));
      return fauxAssistantMessage(
        [
          fauxToolCall("kubernetes_workload_health", {
            namespace: "pilot",
            kind: "Pod",
            name: "web",
          }),
        ],
        { stopReason: "toolUse" },
      );
    },
    async (request) => {
      requests.push(JSON.stringify(request));
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      results.push(JSON.stringify(result));
      return fauxAssistantMessage(
        "Pod web is unhealthy: not ready, four restarts, reason Other. Kubernetes evidence only.",
      );
    },
  ]);
  const options = {
    models,
    extensions: [extension],
    assistant: {
      model: { provider: "faux", modelId: "faux-1" },
      instructions: "Explain Kubernetes evidence",
      tools: [...KUBERNETES_OBSERVATION_TOOLS],
    },
  };
  try {
    const core = await openKaeno({
      ...options,
      storage: await openNodeSqliteStorage(path),
    });
    try {
      expect(await ask(core, "Check pilot health")).toContain("not ready");
    } finally {
      await core.close();
    }
    expect(results).toHaveLength(2);
    expect(results[1]).toContain("Other");
    expect(requests.join("\n")).not.toContain(canary);
    expect(results.join("\n")).not.toContain(canary);
    const reopened = await openKaeno({
      ...options,
      storage: await openNodeSqliteStorage(path),
    });
    await reopened.close();
    for (const file of await readdir(directory)) {
      expect(
        (await readFile(join(directory, file))).includes(Buffer.from(canary)),
      ).toBe(false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
