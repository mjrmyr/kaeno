import { vi } from "vitest";
import type { SandboxClient } from "../../src/sandboxes/index.ts";
export const namespace = "kaeno";
export const getPod = vi
  .fn<SandboxClient["getPod"]>()
  .mockResolvedValue(undefined);
export const createPod = vi
  .fn<SandboxClient["createPod"]>()
  .mockResolvedValue(undefined);
export const deletePod = vi
  .fn<SandboxClient["deletePod"]>()
  .mockResolvedValue(undefined);
export const listSandboxPods = vi
  .fn<SandboxClient["listSandboxPods"]>()
  .mockResolvedValue([]);
