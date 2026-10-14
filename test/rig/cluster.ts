// The rig's cluster: pods are in-memory records, but each record is backed by a
// real envd server on localhost speaking the production protocol. The pod spec is
// the real `sandboxPod` manifest and the envd token is extracted from it — the
// same extraction production artifact collection performs at teardown.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CAPTURE_CAP_BYTES } from "../../src/artifacts/index.ts";
import { EnvironmentServer } from "../../src/execution/index.ts";
import {
  podSchema,
  type Pod,
  type SandboxClient,
} from "../../src/sandboxes/index.ts";
import { serverPort } from "../integration/values.ts";

export interface RigPod {
  pod: Pod;
  url: string;
  workspace: string;
  log: string;
}

export interface RigCluster {
  client: SandboxClient;
  pod(name: string): RigPod | undefined;
  stop(): Promise<void>;
}

export function createRigCluster(root: string): RigCluster {
  const running = new Map<string, RigPod>();
  const servers: EnvironmentServer["server"][] = [];
  const client: SandboxClient = {
    namespace: "kaeno",
    async getPod(name: string): Promise<Pod | undefined> {
      return running.get(name)?.pod;
    },
    async createPod(input: unknown): Promise<void> {
      const pod = podSchema.parse(input);
      const name = pod.metadata.name;
      if (running.has(name)) {
        throw new Error(`Rig pod ${name} already exists`);
      }
      const token = pod.spec?.containers
        ?.flatMap((container) => container.env ?? [])
        .find((variable) => variable.name === "KAENO_ENV_TOKEN")?.value;
      if (token === undefined) {
        throw new Error(`Rig pod ${name} carries no KAENO_ENV_TOKEN`);
      }
      const workspace = join(root, "workspace");
      const home = join(root, "home");
      await mkdir(workspace, { recursive: true });
      await mkdir(home, { recursive: true });
      const server = new EnvironmentServer(
        token,
        (cwd: string) => new NodeExecutionEnv({ cwd }),
        workspace,
        {
          roots: [
            { name: "workspace", dir: workspace },
            { name: "home", dir: home },
          ],
          capBytes: CAPTURE_CAP_BYTES,
        },
      ).server;
      servers.push(server);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      running.set(name, {
        pod: {
          ...pod,
          status: { conditions: [{ type: "Ready", status: "True" }] },
        },
        url: `http://127.0.0.1:${serverPort(server)}`,
        workspace,
        log: `sandbox container log for ${name}\n`,
      });
    },
    async deletePod(name: string): Promise<void> {
      running.delete(name);
    },
    async listSandboxPods(): Promise<Pod[]> {
      return [...running.values()].map((record) => record.pod);
    },
    async getPodLog(name: string): Promise<string | undefined> {
      return running.get(name)?.log;
    },
  };
  return {
    client,
    pod: (name: string) => running.get(name),
    async stop(): Promise<void> {
      for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}
