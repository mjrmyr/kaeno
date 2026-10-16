import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { HostExtension } from "./index.ts";

/** Explicit opt-in: grants the model filesystem access and local process execution. */
export const localCoding: HostExtension = {
  definition: CodingTools,
  env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
};
