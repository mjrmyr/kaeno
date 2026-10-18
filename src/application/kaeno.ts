import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
  createRegistry,
  defineExtension,
  Harness,
  type Cursor,
  type Extension,
  type HarnessOptions,
  type HarnessSettings,
  type Storage,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import { assistantToolPolicy } from "../authority/index.ts";
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
import { ThreadDirectory } from "../threads/index.ts";
import { defineControl, defineTurn, TurnCoordinator } from "../turns/index.ts";
import {
  Work,
  workTurns,
  type Participants,
  type WorkEnvironment,
} from "../work/index.ts";

export interface Kaeno {
  harness: Harness;
  threads: ThreadDirectory;
  turns: TurnCoordinator;
  close(): Promise<void>;
}

export interface KaenoExtension {
  /** Native tools, tasks, sections, hooks and wrappers, fixed before the harness opens. */
  durable: Extension;
  /** Tools allowed on result turns. Every other tool is treated as mutating. */
  readOnlyTools?: readonly string[];
  /** The one native execution-environment provider. */
  environment?: HarnessOptions["env"];
  delivery?: {
    channel: string;
    send(address: string, text: string): Promise<void>;
    typing?(address: string): Promise<void>;
  };
  /** Boundary check of this extension's saved bindings; runs before anything resumes. */
  validateBinding?(binding: Binding): void;
  /** Start a listener or reconciler after recovery checks; return its cleanup. */
  start?(
    core: Kaeno,
    signal: AbortSignal,
  ): Promise<void | (() => Promise<void>)>;
}

/** Durable multi-agent WORK. Absent: Kaeno runs standalone without WORK tools. */
export interface WorkOptions {
  participants: Participants;
  /** Where participants run; absent means they only have their selected tools. */
  environment?: WorkEnvironment;
  /** Tool names participants may select, from installed extensions. */
  tools: readonly string[];
  maxDepth?: number;
  maxConcurrent?: number;
}

export interface OpenKaenoOptions {
  storage: Storage;
  models: HarnessOptions["models"];
  /** Resolved CHAT assistant; core never looks it up by name. */
  assistant: ConversationSetup;
  extensions?: readonly KaenoExtension[];
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
      for (const binding of savedBindings) {
        const owner = owners.get(binding.owner);
        try {
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
  const turn = defineTurn(() => ({
    async send(notify, text) {
      if (!notify.route) {
        return;
      }
      const delivery = deliveries.get(notify.route.channel);
      if (!delivery) {
        throw new Error(`Missing delivery channel: ${notify.route.channel}`);
      }
      await delivery.send(notify.route.address, text);
    },
    async typing(notify) {
      if (notify.route) {
        await deliveries
          .get(notify.route.channel)
          ?.typing?.(notify.route.address);
      }
    },
  }));
  const control = defineControl(reference.getHarness);
  const turns = new TurnCoordinator(reference.getHarness, turn, control);

  const workOptions = options.work;
  if (workOptions) {
    z.object({
      maxDepth: z.number().int().min(1).max(8).optional(),
      maxConcurrent: z.number().int().min(1).optional(),
    }).parse(workOptions);
  }
  let workerSurface: SetupSurface | undefined;
  const work = workOptions
    ? new Work(
        reference.getHarness,
        workTurns(() => turns),
        {
          participants: workOptions.participants,
          environment: workOptions.environment,
          surface: () => {
            if (!workerSurface) {
              throw new Error("WORK used before Kaeno was composed");
            }
            return workerSurface;
          },
          maxDepth: workOptions.maxDepth ?? 2,
          maxConcurrent: workOptions.maxConcurrent ?? 4,
        },
      )
    : undefined;
  const workEnvironment = workOptions?.environment;
  const extensions: KaenoExtension[] = [
    ...(options.extensions ?? []),
    ...(work
      ? [
          {
            durable: work.extension,
            readOnlyTools: ["list_work", "inspect_work"],
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

  const names = new Set(["kaeno-channels", "kaeno-tool-authority"]);
  const deliveries = new Map<string, NonNullable<KaenoExtension["delivery"]>>();
  const byName = new Map<string, KaenoExtension>();
  let environment: HarnessOptions["env"];
  for (const extension of extensions) {
    if (names.has(extension.durable.name)) {
      throw new Error(`Duplicate extension: ${extension.durable.name}`);
    }
    names.add(extension.durable.name);
    byName.set(extension.durable.name, extension);
    if (extension.environment) {
      if (environment) {
        throw new Error("Only one environment provider is allowed");
      }
      environment = extension.environment;
    }
    if (extension.delivery) {
      if (deliveries.has(extension.delivery.channel)) {
        throw new Error(
          `Duplicate delivery channel: ${extension.delivery.channel}`,
        );
      }
      deliveries.set(extension.delivery.channel, extension.delivery);
    }
  }

  const durable = extensions.map((extension) => extension.durable);
  const tools = durable.flatMap((extension) => extension.tools ?? []);
  const policy = assistantToolPolicy(
    reference.getHarness,
    tools,
    extensions.flatMap((extension) => extension.readOnlyTools ?? []),
  );

  // Selection is explicit for both CHAT and WORK. Installed tools are never offered implicitly.
  const chatSurface = surfaceOf(durable, () => true);
  assertSetupFits("Assistant", options.assistant, chatSurface);
  for (const binding of options.assistant.bindings ?? []) {
    byName.get(binding.owner)?.validateBinding?.(binding);
  }
  if (workOptions) {
    if (!durable.some((extension) => extension.name === "kaeno-work")) {
      throw new Error("WORK tool/task definition is not installed");
    }
    for (const name of workOptions.tools) {
      if (!chatSurface.tools.has(name)) {
        throw new Error(`Approved worker tool "${name}" is not installed`);
      }
    }
    const approved = new Set(workOptions.tools);
    // Protocol tools are native tools too: the host must explicitly approve them before a
    // participant definition can select them.
    workerSurface = surfaceOf(durable, (name) => approved.has(name));
  }

  const threads = new ThreadDirectory(reference.getHarness, {
    async configureChatConversation(tx, id) {
      await applySetup(tx, id, {
        setup: options.assistant,
        surface: chatSurface,
        extraExtensions: [policy],
        instructions:
          work && options.assistant.tools?.includes("start_work")
            ? `${options.assistant.instructions}\n\n${work.describeForChat()}`
            : options.assistant.instructions,
        cwd: null,
      });
    },
  });

  const registry = createRegistry();
  for (const extension of [
    ...durable,
    policy,
    defineExtension({ name: "kaeno-channels", tasks: [turn, control] }),
  ]) {
    registry.install(extension);
  }

  const settings: HarnessSettings = {
    extensions: [],
    toolExecution: "parallel",
    followUpMode: "one-at-a-time",
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
    threads,
    turns,
    close() {
      // NOTE: can't we just return that async function using Promise?
      // that would be cleaner
      closing ??= (async () => {
        stopping.abort();
        const errors: unknown[] = [];
        // Keep extension clients alive until in-flight durable invocations stop.
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
      if (record.kind !== "kaeno.turn") {
        continue;
      }

      const { notify } = z
        .object({
          notify: z
            .object({ route: z.object({ channel: z.string() }).optional() })
            .optional(),
        })
        .parse(record.input);

      if (notify?.route && !deliveries.has(notify.route.channel)) {
        throw new Error(
          `Missing delivery channel: ${notify.route.channel} (task ${record.id})`,
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

    await threads.refreshIdleConversations();

    if (work && workEnvironment) {
      await work.reconcileEnvironment(BACKGROUND_CONTEXT);
      const timer = setInterval(() => {
        void work
          .reconcileEnvironment(BACKGROUND_CONTEXT)
          .catch((error: unknown) => {
            options.onReport?.(error);
          });
      }, 5 * 60_000);
      stopping.signal.addEventListener("abort", () => clearInterval(timer), {
        once: true,
      });
      cleanups.push(async () => clearInterval(timer));
    }

    for (const extension of extensions) {
      const cleanup = await extension.start?.(core, stopping.signal);
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
