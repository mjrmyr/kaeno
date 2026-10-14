// An in-memory cluster: created pods are immediately Ready until deleted. Call resetCluster between tests.
import { vi } from "vitest";
import {
  podSchema,
  type Pod,
  type SandboxClient,
} from "../../src/sandboxes/index.ts";
const pods = new Map<string, Pod>();
export const namespace = "kaeno";
export const getPod = vi.fn<SandboxClient["getPod"]>(async (name) =>
  pods.get(name),
);
export const createPod = vi.fn<SandboxClient["createPod"]>(async (pod) => {
  const parsed = podSchema.parse(pod);
  pods.set(parsed.metadata.name, {
    ...parsed,
    status: { conditions: [{ type: "Ready", status: "True" }] },
  });
});
export const deletePod = vi.fn<SandboxClient["deletePod"]>(async (name) => {
  pods.delete(name);
});
export const listSandboxPods = vi.fn<SandboxClient["listSandboxPods"]>(
  async () => [...pods.values()],
);
export const getPodLog = vi.fn<SandboxClient["getPodLog"]>(async (name) =>
  pods.has(name) ? `sandbox container log for ${name}\n` : undefined,
);
export function resetCluster(): void {
  pods.clear();
}
export function runningPods(): string[] {
  return [...pods.keys()];
}
