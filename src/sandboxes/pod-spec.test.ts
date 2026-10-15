import { expect, it, vi } from "vitest";
import { sandboxPod, type SandboxInput } from "./index.ts";
vi.mock("@earendil-works/pi-durable", async () => {
  const { createMockSdk } = await import("../../test/mocks/sdk.ts");
  return createMockSdk();
});
vi.mock("../skills/index.ts", () => ({
  SKILL_ROOT: "/workspace/.agents/skills",
}));
function input(): SandboxInput {
  return {
    name: "pod",
    images: { execution: "saved-image" },
    skillCacheClaim: "saved-cache",
    skills: [],
    token: "secret",
    conversationId: "12",
    taskId: "24",
    template: "worker",
    resources: {
      requests: { cpu: "100m", memory: "128Mi" },
      limits: { cpu: "1", memory: "1Gi" },
    },
  };
}
it("builds an isolated non-root pod without Kubernetes credentials", () => {
  const pod = sandboxPod(input(), "namespace");
  expect(pod.metadata).toMatchObject({
    name: "pod",
    namespace: "namespace",
    annotations: { "kaeno.io/conversation": "12", "kaeno.io/task": "24" },
  });
  expect(pod.spec.automountServiceAccountToken).toBe(false);
  expect(pod.spec.securityContext.runAsNonRoot).toBe(true);
  expect(pod.spec.containers[0].securityContext).toMatchObject({
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
  });
});
it("mounts frozen skills read-only into the main container and keeps the cache init-private", () => {
  const pod = sandboxPod({
    ...input(),
    skills: [{ id: "demo/skills:guide", treeHash: "a".repeat(64) }],
  });
  expect(pod.spec.initContainers?.[0].image).toBe("saved-image");
  expect(pod.spec.volumes).toContainEqual({
    name: "skill-cache",
    persistentVolumeClaim: { claimName: "saved-cache", readOnly: true },
  });
  expect(
    pod.spec.containers[0].volumeMounts.some(
      (mount) => mount.name === "skill-cache",
    ),
  ).toBe(false);
  expect(pod.spec.containers[0].volumeMounts).toContainEqual({
    name: "skills",
    mountPath: "/workspace/.agents/skills",
    readOnly: true,
  });
});
it("does not provision a skill init container when no skills were assigned", () => {
  expect(sandboxPod(input()).spec.initContainers).toBeUndefined();
});
it("sizes envd and the skills init container from the configured resources", () => {
  const pod = sandboxPod({
    ...input(),
    skills: [{ id: "demo/skills:guide", treeHash: "a".repeat(64) }],
  });
  for (const container of [
    ...pod.spec.containers,
    ...(pod.spec.initContainers ?? []),
  ]) {
    expect(container.resources).toEqual(input().resources);
  }
});
