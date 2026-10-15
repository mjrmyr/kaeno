// The rig's cluster: pods are in-memory records, but each record is backed by a
// real envd server on localhost speaking the production protocol. The pod spec is
// the real `sandboxPod` manifest and the envd token is extracted from it — the
// same extraction production artifact collection performs at teardown.
import { mkdir, realpath, rm } from "node:fs/promises";
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
        // Production treats 409 AlreadyExists as success: a restarted WORK
        // re-runs ensureSandbox and adopts its existing pod (k8s.ts).
        return;
      }
      const token = pod.spec?.containers
        ?.flatMap((container) => container.env ?? [])
        .find((variable) => variable.name === "KAENO_ENV_TOKEN")?.value;
      if (token === undefined) {
        throw new Error(`Rig pod ${name} carries no KAENO_ENV_TOKEN`);
      }
      // Production pods get a fresh emptyDir workspace/home at a fixed path
      // (/workspace) that equals the client's cwd. The rig keeps the client's
      // path (root/workspace == the factory's sandboxCwd) and gives it emptyDir
      // semantics by wiping it per pod. envd re-applies the request cwd on every
      // call, so a per-pod path different from the client cwd would split writes
      // across two directories. One live pod at a time keeps the path unshared.
      if (running.size > 0) {
        throw new Error(
          "Rig cluster runs one sandbox at a time (sandboxCapacity: 1)",
        );
      }
      const workspace = join(root, "workspace");
      const home = join(root, "home");
      await rm(workspace, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
      await mkdir(workspace, { recursive: true });
      await mkdir(home, { recursive: true });
      const shell = await sandboxShell(workspace, home);
      const server = new EnvironmentServer(
        token,
        (cwd: string) =>
          new NodeExecutionEnv({
            cwd,
            shellPath: shell.shellPath,
            shellEnv: shell.shellEnv,
          }),
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

/**
 * A pod's shell sees a container: its own workspace and home, a minimal
 * environment (no host variables, no LLM keys), and no host user data. On
 * macOS the rig confines bash with sandbox-exec (test/rig/sandbox.sb); elsewhere
 * only the environment is reduced. File tools (read/write via envd) stay
 * unconfined — absolute host paths remain reachable through them.
 */
async function sandboxShell(
  workspace: string,
  home: string,
): Promise<{ shellPath: string | undefined; shellEnv: NodeJS.ProcessEnv }> {
  const shellEnv: NodeJS.ProcessEnv = {
    PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    LANG: "C.UTF-8",
    TMPDIR: home,
  };
  if (process.platform !== "darwin") {
    return { shellPath: undefined, shellEnv };
  }
  return {
    shellPath: join(import.meta.dirname, "sandbox-shell.sh"),
    shellEnv: {
      ...shellEnv,
      RIG_PROFILE: join(import.meta.dirname, "sandbox.sb"),
      RIG_WS: await realpath(workspace),
      RIG_HOME: await realpath(home),
    },
  };
}
