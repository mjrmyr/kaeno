import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SANDBOX_RESOURCES,
  fitSandboxes,
  parseSandboxResources,
} from "./index.ts";
vi.mock("@earendil-works/pi-durable", async () => {
  const { createMockSdk } = await import("../../test/mocks/sdk.ts");
  return createMockSdk();
});
vi.mock("../skills/index.ts", () => ({
  SKILL_ROOT: "/workspace/.agents/skills",
}));
const oneCpu = {
  requests: { cpu: "250m", memory: "256Mi" },
  limits: { cpu: "1", memory: "1536Mi" },
};
describe("sandbox resources", () => {
  it("defaults when absent and keeps a complete block verbatim", () => {
    expect(parseSandboxResources(undefined)).toBe(DEFAULT_SANDBOX_RESOURCES);
    expect(parseSandboxResources(oneCpu)).toEqual(oneCpu);
  });
  it("rejects incomplete blocks, invalid quantities and requests above limits", () => {
    expect(() => parseSandboxResources({ limits: oneCpu.limits })).toThrow(
      /sandboxResources/,
    );
    expect(() =>
      parseSandboxResources({
        ...oneCpu,
        limits: { ...oneCpu.limits, cpu: "2 cores" },
      }),
    ).toThrow('sandboxResources.limits.cpu: "2 cores"');
    expect(() =>
      parseSandboxResources({
        ...oneCpu,
        requests: { ...oneCpu.requests, memory: "2Gi" },
      }),
    ).toThrow("requests.memory 2Gi exceeds limits.memory 1536Mi");
  });
});
describe("fitSandboxes", () => {
  it("derives the pool from the binding quota dimension", () => {
    const quota = { pods: "8", "limits.cpu": "8", "limits.memory": "16Gi" };
    expect(fitSandboxes(quota, DEFAULT_SANDBOX_RESOURCES)).toEqual({
      slots: 4,
      summary: "4 (limits.cpu 8 / 2 per sandbox)",
    });
    // 1-CPU sandboxes: memory now binds (16Gi / 1.5Gi = 10), then pods (8).
    expect(fitSandboxes(quota, oneCpu).slots).toBe(8);
    expect(fitSandboxes({ "limits.memory": "16Gi" }, oneCpu).slots).toBe(10);
  });
  it("handles request aliases, fractional and decimal quantities exactly", () => {
    expect(
      fitSandboxes(
        { cpu: "1.5", "requests.memory": "1G" },
        DEFAULT_SANDBOX_RESOURCES,
      ).slots,
    ).toBe(3); // memory: 1e9 / 268435456 = 3.7 → 3; cpu: 1500m / 250m = 6
    expect(fitSandboxes({ "limits.cpu": "1999m" }, oneCpu).slots).toBe(1);
  });
  it("reports zero slots instead of guessing, and rejects quotas it cannot reason about", () => {
    expect(
      fitSandboxes({ "limits.cpu": "1" }, DEFAULT_SANDBOX_RESOURCES).slots,
    ).toBe(0);
    expect(() =>
      fitSandboxes({ services: "2" }, DEFAULT_SANDBOX_RESOURCES),
    ).toThrow(/bounds none of pods, cpu or memory/);
    expect(() =>
      fitSandboxes(
        { pods: "4", "requests.ephemeral-storage": "10Gi" },
        DEFAULT_SANDBOX_RESOURCES,
      ),
    ).toThrow(/ephemeral-storage/);
    expect(() =>
      fitSandboxes({ pods: "four" }, DEFAULT_SANDBOX_RESOURCES),
    ).toThrow(/not a Kubernetes quantity/);
  });
});
