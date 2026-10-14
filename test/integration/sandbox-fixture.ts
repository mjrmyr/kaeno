// An in-memory cluster: created pods are immediately Ready until deleted. Call
// resetCluster between tests. Deliberately vitest-free so runtime tools (the rig)
// can import the integration composition from plain Node; tests reach in with
// vi.spyOn when they need to observe or override.
import { podSchema, type Pod } from "../../src/sandboxes/index.ts";

const pods = new Map<string, Pod>();

export const namespace = "kaeno";

export async function getPod(name: string): Promise<Pod | undefined> {
  return pods.get(name);
}

export async function createPod(pod: unknown): Promise<void> {
  const parsed = podSchema.parse(pod);
  pods.set(parsed.metadata.name, {
    ...parsed,
    status: { conditions: [{ type: "Ready", status: "True" }] },
  });
}

export async function deletePod(name: string): Promise<void> {
  pods.delete(name);
}

export async function listSandboxPods(): Promise<Pod[]> {
  return [...pods.values()];
}

export async function getPodLog(name: string): Promise<string | undefined> {
  return pods.has(name) ? `sandbox container log for ${name}\n` : undefined;
}

export function resetCluster(): void {
  pods.clear();
}

export function runningPods(): string[] {
  return [...pods.keys()];
}
