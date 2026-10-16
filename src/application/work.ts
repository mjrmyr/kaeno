import type { Harness } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  Agent,
  AgentFactory,
  AgentTraceFileSink,
  AgentTraceLogger,
} from "../agents/index.ts";
import { ArtifactStore } from "../artifacts/index.ts";
import { eligibleWorkTemplates, type Config } from "../config/index.ts";
import { RemoteExecutionEnv } from "../execution/index.ts";
import {
  KubernetesClient,
  SandboxCapacity,
  SandboxManager,
} from "../sandboxes/index.ts";
import { parseSandboxImages, prepareSkills } from "../skills/index.ts";
import type { TurnCoordinator } from "../turns/index.ts";
import { Work } from "../work/index.ts";

export async function prepareWork(
  config: Config,
  harness: () => Harness,
  turns: TurnCoordinator,
  environment: (name: string) => string | undefined,
): Promise<{
  work: Work;
  agent: Agent;
  capacity: SandboxCapacity;
  images: ReturnType<typeof parseSandboxImages>;
}> {
  const sandboxResources = config.sandboxResources;
  if (!sandboxResources) {
    throw new Error("WORK requires sandboxResources");
  }
  const namespace = (
    await readFile(
      "/var/run/secrets/kubernetes.io/serviceaccount/namespace",
      "utf8",
    ).catch((error: unknown) => {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
      return "kaeno";
    })
  ).trim();
  const kubernetes = new KubernetesClient(
    namespace,
    fetch,
    () =>
      readFile(
        environment("KUBERNETES_TOKEN_FILE") ??
          "/var/run/secrets/kubernetes.io/serviceaccount/token",
        "utf8",
      ),
    environment("KUBERNETES_API"),
  );
  const podName = environment("POD_NAME");
  const self = podName ? await kubernetes.getPod(podName) : undefined;
  let executionImage: unknown = environment("SANDBOX_IMAGE");
  if (executionImage === undefined) {
    const raw: unknown = JSON.parse(
      await readFile(
        environment("KAENO_BUILD_INFO") ?? "/app/build-info.json",
        "utf8",
      ),
    );
    executionImage = z
      .object({ sandboxImage: z.string() })
      .parse(raw).sandboxImage;
  }
  const images = parseSandboxImages({ execution: executionImage });
  const skillCacheClaim =
    environment("KAENO_SKILL_CACHE_CLAIM") ??
    self?.spec?.volumes?.find((volume) => volume.name === "skill-cache")
      ?.persistentVolumeClaim?.claimName ??
    "kaeno-skills";
  const skills = await prepareSkills({
    repositories: config.skillRepositories,
    selections: Object.fromEntries(
      Object.values(config.templates).map((template) => [
        template.name,
        template.skills,
      ]),
    ),
    cacheRoot: environment("KAENO_SKILL_CACHE") ?? "/var/lib/kaeno/skills",
  });
  // Artifacts are optional: unset KAENO_ARTIFACTS disables evidence collection.
  const artifactsRoot = environment("KAENO_ARTIFACTS");
  const artifacts =
    artifactsRoot === undefined ? undefined : new ArtifactStore(artifactsRoot);
  const work: Work = new Work(
    harness,
    turns,
    { listWorkTemplates: () => eligibleWorkTemplates(config) },
    () => agent,
    artifacts,
  );
  const factory = new AgentFactory(config, skills);
  const capacity = new SandboxCapacity(harness, kubernetes, sandboxResources);
  const environmentFactory = {
    createEnvironment: (
      pod: string,
      token: string,
      cwd: string,
    ): ExecutionEnv =>
      new RemoteExecutionEnv(
        `http://${pod}.kaeno-sandbox.${namespace}.svc.cluster.local:7070`,
        token,
        `pod:${pod}`,
        cwd,
        fetch,
      ),
    createCaptureEnvironment: (
      pod: string,
      token: string,
      cwd: string,
    ): RemoteExecutionEnv =>
      new RemoteExecutionEnv(
        `http://${pod}.kaeno-sandbox.${namespace}.svc.cluster.local:7070`,
        token,
        `capture:${pod}`,
        cwd,
        fetch,
      ),
  };
  const sandboxes = new SandboxManager(
    harness,
    kubernetes,
    capacity,
    environmentFactory,
    artifacts,
  );
  const logSecrets = Object.entries(process.env)
    .filter(([name]) => /TOKEN|API_KEY|PASSWORD|SECRET|PRIVATE_KEY/i.test(name))
    .flatMap(([, value]) => (value ? [value] : []));
  const logger = new AgentTraceLogger(
    (line) => console.log(line),
    logSecrets,
    artifacts === undefined ? undefined : new AgentTraceFileSink(artifacts),
  );
  const agent: Agent = new Agent(
    factory,
    harness,
    sandboxes,
    images,
    skillCacheClaim,
    logger,
    work,
  );
  return { work, agent, capacity, images };
}
