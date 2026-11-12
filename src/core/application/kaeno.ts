import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
  createRegistry,
  defineExtension,
  Harness,
  type ConversationId,
  type Cursor,
  type Extension,
  type HarnessOptions,
  type HarnessSettings,
  type Storage,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import { routerToolPolicy } from "../authority/index.ts";
import {
  applySetup,
  assertSetupFits,
  bindingSchema,
  ConversationBindings,
  type Binding,
  type ConversationSetup,
  type SetupSurface,
} from "../conversation/index.ts";
import {
  assertRecoveryCompatible,
  HarnessReference,
} from "../durable/index.ts";
import { defineDelivery, type ChannelRoute } from "../outbox/index.ts";
import {
  CHANNEL_NORMS,
  Engine,
  ROUTER_EXTENSION,
  ROUTER_TOOLS,
  routerInstructions,
  routerTools,
  ticketTools,
  type GateMode,
  type TriggerDraft,
} from "../router/index.ts";
import {
  WORK_EXTENSION,
  WORK_TOOLS,
  Work,
  type AgentProfile,
  type WorkEnvironment,
  type WorkReports,
} from "../work/index.ts";

export interface Kaeno {
  harness: Harness;
  router: Engine;
  /** Absent when Kaeno runs without WORK: the router can only answer, not accept tickets. */
  work: Work | undefined;
  /** Authoritative owning ticket, including WORK ancestry, in the caller's transaction. */
  ticketOf(tx: Tx, conversation: ConversationId): Promise<string | undefined>;
  /** Join a thread to this conversation's ticket in the caller's transaction. False outside a ticket. */
  followThread(
    tx: Tx,
    conversation: ConversationId,
    thread: string,
  ): Promise<boolean>;
  close(): Promise<void>;
}

/** Runtime integration only. Agent-facing contributions are composed outside core. */
export interface KaenoExtension {
  /** Native tools, tasks, sections, hooks and wrappers, fixed before the harness opens. */
  durable: Extension;
  /** Tools that change nothing. Every other router tool must cite the owner's message asking for it. */
  readOnlyTools?: readonly string[];
  /** The one native execution-environment provider. */
  environment?: HarnessOptions["env"];
  /** Boundary check of this extension's saved bindings; runs before anything resumes. */
  validateBinding?(binding: Binding): void;
  /** Start a listener or reconciler after recovery checks; return its cleanup. */
  start?(
    core: Kaeno,
    signal: AbortSignal,
  ): Promise<void | (() => Promise<void>)>;
}

/** Outbound transport used by core without knowledge of its implementation. */
export interface ChannelDelivery {
  channel: string;
  /** `thread` lets a channel map transport replies back to their application thread. */
  send(route: ChannelRoute, text: string, thread: string): Promise<void>;
  typing?(route: ChannelRoute): Promise<void>;
  maxWords?: number;
  /** A ticket's own topic or reply chain. */
  openThread?(
    route: ChannelRoute,
    title: string,
  ): Promise<{ key: string; route: ChannelRoute } | undefined>;
}

/** Transport integration, with no agent tools, environments or binding ownership. */
export interface KaenoChannel {
  delivery?: ChannelDelivery;
  /** Attach and start after recovery checks, before durable work resumes. */
  start?(
    core: Kaeno,
    signal: AbortSignal,
  ): Promise<void | (() => Promise<void>)>;
}

/** Durable multi-agent WORK. Absent: Kaeno runs standalone without WORK tools. */
export interface WorkOptions {
  /** Agents WORK may start. Copied and checked against the approved worker surface when Kaeno opens. */
  agents: readonly AgentProfile[];
  /** Where agents run; absent means they only have their selected tools. */
  environment?: WorkEnvironment;
  /** Tool names agents may select, from installed extensions. */
  tools: readonly string[];
  maxDepth?: number;
  maxConcurrent?: number;
}

export interface OpenKaenoOptions {
  storage: Storage;
  models: HarnessOptions["models"];
  assistant: ConversationSetup;
  /** The programmatic gate per trigger source; unlisted sources are explicit. */
  sources?: Readonly<Record<string, GateMode>>;
  extensions?: readonly KaenoExtension[];
  channels?: readonly KaenoChannel[];
  work?: WorkOptions;
  onReport?: HarnessOptions["onReport"];
}

function surfaceOf(
  extensions: readonly Extension[],
  selectable: (name: string) => boolean,
): SetupSurface {
  const tools = new Map<
    string,
    { tool: ToolRegistration; extension: Extension }
  >();
  for (const extension of extensions) {
    for (const tool of extension.tools ?? []) {
      if (selectable(tool.name)) {
        tools.set(tool.name, { tool, extension });
      }
    }
  }
  return {
    tools,
    extensions: new Map(
      extensions.map((extension) => [extension.name, extension]),
    ),
  };
}

/** Saved bindings must belong to installed extensions and pass their owner's validation. */
async function assertBindingsValid(
  harness: Harness,
  owners: ReadonlyMap<string, KaenoExtension>,
  context: Context,
): Promise<void> {
  const problems: string[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await harness.commit(
      (tx) => tx.scanConversations({}, 100, cursor),
      context,
    );
    for (const conversation of page.items) {
      const saved = await harness.snapshot(
        ConversationBindings,
        conversation.id,
        context,
      );
      const savedBindings = z.array(bindingSchema).parse(saved?.bindings ?? []);
      const bindingSet = new Set<string>();
      for (const binding of savedBindings) {
        const owner = owners.get(binding.owner);
        try {
          if (bindingSet.has(binding.owner)) {
            throw new Error(`duplicate binding owner "${binding.owner}"`);
          }
          bindingSet.add(binding.owner);
          if (!owner) {
            throw new Error(`owner "${binding.owner}" is not installed`);
          }
          owner.validateBinding?.(binding);
        } catch (error) {
          problems.push(
            `Conversation ${conversation.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);
  if (problems.length > 0) {
    throw new Error(
      [
        "Saved conversation bindings are invalid:",
        ...problems.map((problem) => `- ${problem}`),
      ].join("\n"),
    );
  }
}

/** Explicit native composition. Extensions and raw transactions are trusted application code. */
export async function openKaeno(options: OpenKaenoOptions): Promise<Kaeno> {
  const reference = new HarnessReference();
  const notifier = {
    async send(route: ChannelRoute, text: string, thread: string) {
      const delivery = deliveries.get(route.channel);
      if (!delivery) {
        throw new Error(`Missing delivery channel: ${route.channel}`);
      }
      await delivery.send(route, text, thread);
    },
    async typing(route: ChannelRoute) {
      await deliveries.get(route.channel)?.typing?.(route);
    },
  };
  const delivery = defineDelivery(() => notifier);

  const workOptions = options.work;
  if (workOptions) {
    z.object({
      maxDepth: z.number().int().min(1).max(8).optional(),
      maxConcurrent: z.number().int().min(1).optional(),
      environment: z.object({ identity: z.string().min(1) }).optional(),
    }).parse(workOptions);
  }
  let workerSurface: SetupSurface | undefined;
  const agents = structuredClone(workOptions?.agents ?? []);
  const reportsToRouter: WorkReports = {
    report: (tx, reported) => engine.report(tx, reported),
    ended: (tx, ticket, workId) => engine.assignmentEnded(tx, ticket, workId),
    retainedConversations: (context) => engine.openConversations(context),
  };
  const work = workOptions
    ? new Work(reference.getHarness, reportsToRouter, {
        agents,
        environment: workOptions.environment,
        onReport: options.onReport,
        surface: () => {
          if (!workerSurface) {
            throw new Error("WORK used before Kaeno was composed");
          }
          return workerSurface;
        },
        maxDepth: workOptions.maxDepth ?? 2,
        maxConcurrent: workOptions.maxConcurrent ?? 4,
      })
    : undefined;
  const engine = new Engine({
    harness: reference.getHarness,
    gate: (trigger: TriggerDraft) =>
      options.sources?.[trigger.source] ?? "explicit",
    channel: (name) => deliveries.get(name),
    notifier: () => notifier,
    delivery,
    work,
    onReport: options.onReport,
  });
  const workEnvironment = workOptions?.environment;
  const routerExtension = defineExtension({
    name: ROUTER_EXTENSION,
    tools: [...routerTools(engine), ...ticketTools(engine)],
    tasks: [engine.dispatchTask, delivery],
  });
  const extensions: KaenoExtension[] = [
    { durable: routerExtension, readOnlyTools: ROUTER_TOOLS.readOnly },
    ...(options.extensions ?? []),
    ...(work
      ? [
          {
            durable: work.extension,
            readOnlyTools: WORK_TOOLS.readOnly,
            ...(workEnvironment
              ? {
                  environment: (
                    target: Parameters<
                      WorkEnvironment["executionEnvironment"]
                    >[0],
                    context: Context,
                  ) => workEnvironment.executionEnvironment(target, context),
                }
              : {}),
          },
        ]
      : []),
  ];

  const names = new Set(["kaeno-tool-authority"]);
  const deliveries = new Map<string, ChannelDelivery>();
  const byName = new Map<string, KaenoExtension>();
  let environment: HarnessOptions["env"];
  const toolNames = new Set<string>();
  for (const extension of extensions) {
    if (names.has(extension.durable.name)) {
      throw new Error(`Duplicate extension: ${extension.durable.name}`);
    }
    names.add(extension.durable.name);
    const ownedTools = new Set<string>();
    for (const tool of extension.durable.tools ?? []) {
      if (toolNames.has(tool.name)) {
        throw new Error(`Duplicate tool: ${tool.name}`);
      }
      toolNames.add(tool.name);
      ownedTools.add(tool.name);
    }
    for (const name of extension.readOnlyTools ?? []) {
      if (!ownedTools.has(name)) {
        throw new Error(
          `Extension ${extension.durable.name}: read-only tool "${name}" is not owned here`,
        );
      }
    }
    byName.set(extension.durable.name, extension);
    if (extension.environment) {
      if (environment) {
        throw new Error("Only one environment provider is allowed");
      }
      environment = extension.environment;
    }
  }
  for (const { delivery } of options.channels ?? []) {
    if (!delivery) {
      continue;
    }
    if (deliveries.has(delivery.channel)) {
      throw new Error(`Duplicate delivery channel: ${delivery.channel}`);
    }
    deliveries.set(delivery.channel, delivery);
  }

  const durable = extensions.map((extension) => extension.durable);
  const tools = durable.flatMap((extension) => extension.tools ?? []);
  const workTools = new Set<string>([
    ...WORK_TOOLS.orchestration,
    ...WORK_TOOLS.parent,
  ]);
  const ticketToolNames = new Set<string>(ROUTER_TOOLS.ticket);
  const routerSurface = surfaceOf(
    durable,
    (name) => !workTools.has(name) && !ticketToolNames.has(name),
  );
  const policy = routerToolPolicy(
    engine,
    tools.filter((tool) => routerSurface.tools.has(tool.name)),
    [
      ...ROUTER_TOOLS.router,
      ...extensions.flatMap((extension) => extension.readOnlyTools ?? []),
    ],
  );

  const installed = surfaceOf(durable, () => true);
  assertSetupFits("Assistant", options.assistant, routerSurface);
  for (const binding of options.assistant.bindings ?? []) {
    byName.get(binding.owner)?.validateBinding?.(binding);
  }
  if (workOptions) {
    if (!durable.some((extension) => extension.name === WORK_EXTENSION)) {
      throw new Error("WORK tool/task definition is not installed");
    }
    for (const name of workOptions.tools) {
      if (!installed.tools.has(name)) {
        throw new Error(`Approved worker tool "${name}" is not installed`);
      }
    }
    const approved = new Set(workOptions.tools);
    // Protocol tools are native tools too: the host must explicitly approve them before an
    // agent definition can select them.
    const surface = surfaceOf(durable, (name) => approved.has(name));
    workerSurface = surface;
    const ids = new Set<string>();
    for (const agent of agents) {
      if (ids.has(agent.id)) {
        throw new Error(`Duplicate agent "${agent.id}"`);
      }
      ids.add(agent.id);
      assertSetupFits(`Agent ${agent.id}`, agent.setup, surface);
      for (const binding of agent.setup.bindings ?? []) {
        byName.get(binding.owner)?.validateBinding?.(binding);
      }
    }
  }

  async function configureRouter(tx: Tx, id: ConversationId): Promise<void> {
    await applySetup(tx, id, {
      setup: options.assistant,
      surface: routerSurface,
      extraExtensions: [policy],
      instructions: routerInstructions({
        assistant: options.assistant.instructions,
        agents: work?.describeAgents() ?? "",
        channels: CHANNEL_NORMS,
      }),
      cwd: null,
    });
  }

  const registry = createRegistry();
  for (const extension of [...durable, policy]) {
    registry.install(extension);
  }

  const settings: HarnessSettings = {
    extensions: [],
    toolExecution: "parallel",
    followUpMode: "all",
    retry: { maxRetries: 4 },
  };

  const harness = await Harness.open(
    options.storage,
    {
      models: options.models,
      registry,
      settings,
      env: environment,
      onReport: options.onReport,
    },
    BACKGROUND_CONTEXT,
  );

  reference.setHarness(harness);
  const stopping = new AbortController();
  const cleanups: (() => Promise<void>)[] = [];
  let closing: Promise<void> | undefined;

  const core: Kaeno = {
    harness,
    router: engine,
    work,
    ticketOf: (tx, conversation) =>
      engine.ticketOfConversation(tx, conversation),
    followThread: (tx, conversation, thread) =>
      engine.followConversation(tx, conversation, thread),
    close() {
      closing ??= (async () => {
        stopping.abort();
        const errors: unknown[] = [];
        try {
          await engine.close();
        } catch (error) {
          errors.push(error);
        }
        // Keep extension and channel clients alive until durable invocations stop.
        try {
          await harness.close(BACKGROUND_CONTEXT);
        } catch (error) {
          errors.push(error);
        }
        for (const cleanup of cleanups.toReversed()) {
          try {
            await cleanup();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) {
          throw new AggregateError(errors, "Kaeno shutdown failed");
        }
      })();
      return closing;
    },
  };

  try {
    await assertRecoveryCompatible(
      harness,
      registry,
      BACKGROUND_CONTEXT,
      settings,
    );

    for (const { record } of (await harness.inspect(BACKGROUND_CONTEXT))
      .tasks) {
      if (record.kind !== "kaeno.delivery") {
        continue;
      }

      const { route } = z
        .object({
          route: z.object({ channel: z.string() }).nullable(),
        })
        .parse(record.input);

      if (route && !deliveries.has(route.channel)) {
        throw new Error(
          `Missing delivery channel: ${route.channel} (task ${record.id})`,
        );
      }
    }

    await assertBindingsValid(harness, byName, BACKGROUND_CONTEXT);
    await work?.assertSavedWorkFits(BACKGROUND_CONTEXT);
    await work?.validateSavedBindings((binding) => {
      const owner = byName.get(binding.owner);
      if (!owner) {
        throw new Error(`Binding owner "${binding.owner}" is not installed`);
      }
      owner.validateBinding?.(binding);
    }, BACKGROUND_CONTEXT);

    await engine.open(configureRouter, BACKGROUND_CONTEXT);

    if (work && workEnvironment) {
      // Cleanup is retried by the timer. An unavailable API or one stale resource
      // must not prevent durable work from resuming and delivering its reports.
      await work
        .reconcileEnvironment(BACKGROUND_CONTEXT)
        .catch((error: unknown) => {
          options.onReport?.(error);
        });
      const timer = setInterval(() => {
        void work
          .reconcileEnvironment(BACKGROUND_CONTEXT)
          .catch((error: unknown) => {
            options.onReport?.(error);
          });
      }, 150_000);
      stopping.signal.addEventListener("abort", () => clearInterval(timer), {
        once: true,
      });
      cleanups.push(async () => clearInterval(timer));
    }

    for (const integration of [...extensions, ...(options.channels ?? [])]) {
      const cleanup = await integration.start?.(core, stopping.signal);
      if (cleanup) {
        cleanups.push(cleanup);
      }
    }

    harness.resume();

    return core;
  } catch (error) {
    try {
      await core.close();
    } catch (cleanupError) {
      options.onReport?.(cleanupError);
    }
    throw error;
  }
}
