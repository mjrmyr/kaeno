// An in-memory cluster: created pods are immediately Ready until deleted. Call resetCluster between tests.
import { vi } from "vitest";
import { z } from "zod";
import type { Pod, SandboxClient } from "../../src/sandboxes/index.ts";
const pods = new Map<string, Pod>();
const manifestSchema = z.object({
  metadata: z.object({
    name: z.string(),
    annotations: z.record(z.string(), z.string()).optional(),
  }),
});
export const namespace = "kaeno";
export const getPod = vi.fn<SandboxClient["getPod"]>(async (name) =>
  pods.get(name),
);
export const createPod = vi.fn<SandboxClient["createPod"]>(async (pod) => {
  const { metadata } = manifestSchema.parse(pod);
  pods.set(metadata.name, {
    metadata,
    status: { conditions: [{ type: "Ready", status: "True" }] },
  });
});
export const deletePod = vi.fn<SandboxClient["deletePod"]>(async (name) => {
  pods.delete(name);
});
export const listSandboxPods = vi.fn<SandboxClient["listSandboxPods"]>(
  async () => [...pods.values()],
);
export function resetCluster(): void {
  pods.clear();
}
export function runningPods(): string[] {
  return [...pods.keys()];
}
