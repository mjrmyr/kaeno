import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTask,
  defineTool,
  watchEvents,
  type ConversationId,
  type Harness,
  type Tx,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { readFile } from "node:fs/promises";
import {
  Agent,
  AgentFactory,
  AgentTraceLogger,
  persistAgentBinding,
  type WorkToolSurface,
} from "../../src/agents/index.ts";
import { ApiServer } from "../../src/api/index.ts";
import { eligibleWorkTemplates, type Config } from "../../src/config/index.ts";
import {
  EnvironmentServer,
  RemoteExecutionEnv,
} from "../../src/execution/index.ts";
import {
  KubernetesClient,
  SandboxCapacity,
  SandboxManager,
  type SandboxClient,
} from "../../src/sandboxes/index.ts";
import type { SandboxImages } from "../../src/skills/index.ts";
import { ThreadDirectory } from "../../src/threads/index.ts";
import {
  TurnCoordinator,
  defineControl,
  type ControlTask,
  type TurnTask,
} from "../../src/turns/index.ts";
import {
  Work,
  type BoundAgent,
  type WorkAgents,
} from "../../src/work/index.ts";
import * as sandboxClient from "./sandbox-fixture.ts";
interface AgentOptions {
  factory: AgentFactory;
  harness: () => Harness;
  images: SandboxImages;
  skillCacheClaim: string;
  sandboxUrl?: (pod: string) => string;
  client?: SandboxClient;
}
export function createAgents(options: AgentOptions): Agent {
  let client = options.client ?? sandboxClient;
  if (process.env.KUBERNETES_API && !options.client) {
    client = new KubernetesClient(
      "kaeno",
      fetch,
      () => readFile(process.env.KUBERNETES_TOKEN_FILE ?? "", "utf8"),
      process.env.KUBERNETES_API,
    );
  }
  const capacity = new SandboxCapacity(options.harness, client);
  const environmentFactory = {
    createEnvironment: (
      pod: string,
      token: string,
      cwd: string,
    ): ExecutionEnv =>
      new RemoteExecutionEnv(
        // Default: a closed local port, so tests without envd fail fast instead of waiting on cluster DNS.
        options.sandboxUrl?.(pod) ?? "http://127.0.0.1:9",
        token,
        `pod:${pod}`,
        cwd,
        fetch,
      ),
  };
  const sandboxes = new SandboxManager(
    options.harness,
    client,
    capacity,
    environmentFactory,
  );
  const logSecrets = Object.entries(process.env)
    .filter(([name]) => /TOKEN|API_KEY|PASSWORD|SECRET|PRIVATE_KEY/i.test(name))
    .flatMap(([, value]) => (value ? [value] : []));
  return new Agent(
    options.factory,
    options.harness,
    sandboxes,
    options.images,
    options.skillCacheClaim,
    new AgentTraceLogger((line) => console.log(line), logSecrets),
  );
}
interface WorkOptions {
  harness: () => Harness;
  Turn: TurnTask;
  Control?: ControlTask;
  config: Config;
  agents: () => WorkAgents;
  maxActive?: number;
}
export function createWork(options: WorkOptions): Work {
  const Control: ControlTask =
    options.Control ??
    defineControl(options.harness, (id, workId): Promise<unknown> =>
      work.cancelWork(id, workId),
    );
  const turns: TurnCoordinator = new TurnCoordinator(
    options.harness,
    options.Turn,
    Control,
  );
  const work: Work = new Work(
    options.harness,
    turns,
    { listWorkTemplates: () => eligibleWorkTemplates(options.config) },
    options.agents,
    options.maxActive,
  );
  return work;
}
export interface ThreadFixture {
  harness: () => Harness;
  threads: ThreadDirectory;
}
export interface ThreadAgentFixture {
  role?: "chat";
  configure(tx: Tx, id: ConversationId): Promise<BoundAgent>;
}
export function createThreadFixture(
  harness: () => Harness,
  agent: ThreadAgentFixture,
): ThreadFixture {
  return {
    harness,
    threads: new ThreadDirectory(harness, {
      configureChatConversation: async (
        tx: Tx,
        id: ConversationId,
      ): Promise<void> => {
        const binding = await agent.configure(tx, id);
        await persistAgentBinding(tx, id, binding, { role: agent.role });
      },
    }),
  };
}
export function thread(
  deps: ThreadFixture,
  key: string,
): Promise<ConversationId> {
  return deps.threads.getOrCreateConversation(key);
}
export function refreshThreads(deps: ThreadFixture): Promise<void> {
  return deps.threads.refreshIdleConversations();
}
interface ApiOptions extends ThreadFixture {
  token: string;
  Turn: TurnTask;
  Control: ControlTask;
  work: Work;
}
export function createApi(options: ApiOptions): ApiServer["server"] {
  const turns = new TurnCoordinator(
    options.harness,
    options.Turn,
    options.Control,
  );
  return new ApiServer(
    options.harness,
    options.threads,
    turns,
    options.work,
    {
      watchConversation: (id: ConversationId, ctx: Context) =>
        watchEvents(options.harness(), id, ctx),
    },
    options.token,
  ).server;
}
export function createEnvServer(options: {
  token: string | (() => string);
  root?: string;
}): EnvironmentServer["server"] {
  return new EnvironmentServer(
    options.token,
    (cwd) => new NodeExecutionEnv({ cwd }),
    options.root,
  ).server;
}
export function sandboxSlots(harness: () => Harness): SandboxCapacity {
  return new SandboxCapacity(harness, sandboxClient);
}
export function createNoopWorkSurface(): WorkToolSurface {
  const tool = (name: string) =>
    defineTool({
      name,
      description: name,
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
  const orchestrationTools = [
    "start_work",
    "list_work",
    "inspect_work",
    "message_work",
    "cancel_work",
  ].map(tool);
  const parentTools = [tool("ask_parent")];
  return {
    orchestrationTools,
    parentTools,
    extension: defineExtension({
      name: "kaeno-work",
      tools: [...orchestrationTools, ...parentTools],
    }),
  };
}
/** Same identity as the production Work definition: lets a test store a queued Work task the real one executes. */
export const queuedWorkTask = defineTask<
  unknown,
  {
    phase: "start";
  },
  unknown
>({
  name: "kaeno.work",
  version: 2,
  initial: () => ({ phase: "start" }),
  phases: { start: async () => {} },
  abort: async () => {},
});
