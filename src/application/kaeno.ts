import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  configure,
  createRegistry,
  defineExtension,
  Harness,
  type Extension,
  type HarnessOptions,
  type HarnessSettings,
  type ModelRef,
  type Storage,
} from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { z } from "zod";
import { assistantToolPolicy } from "../authority/index.ts";
import {
  assertRecoveryCompatible,
  HarnessReference,
} from "../durable/index.ts";
import { ThreadDirectory } from "../threads/index.ts";
import { defineControl, defineTurn, TurnCoordinator } from "../turns/index.ts";

export interface Kaeno {
  harness: Harness;
  threads: ThreadDirectory;
  turns: TurnCoordinator;
  close(): Promise<void>;
}

export interface KaenoExtension {
  durable: Extension;
  /** Tool names exposed to the default assistant; omitted means all tools in this extension. */
  assistantTools?: readonly string[];
  assistantInstructions?: string;
  readOnlyTools?: readonly string[];
  environment?: HarnessOptions["env"];
  delivery?: {
    channel: string;
    send(address: string, text: string): Promise<void>;
    typing?(address: string): Promise<void>;
  };
  // NOTE: what does that do?
  start?(
    core: Kaeno,
    signal: AbortSignal,
  ): Promise<void | (() => Promise<void>)>;
}

export interface OpenKaenoOptions {
  storage: Storage;
  models: HarnessOptions["models"];
  assistant: {
    model: ModelRef;
    instructions: string;
    thinkingLevel?: ModelThinkingLevel;
  };
  extensions?: readonly KaenoExtension[];
  onReport?: HarnessOptions["onReport"];
}

/** Explicit native composition. Extensions and raw transactions are trusted application code. */
export async function openKaeno(options: OpenKaenoOptions): Promise<Kaeno> {
  const extensions = options.extensions ?? [];
  const names = new Set(["kaeno-channels", "kaeno-tool-authority"]);
  const deliveries = new Map<string, NonNullable<KaenoExtension["delivery"]>>();
  let environment: HarnessOptions["env"];
  for (const extension of extensions) {
    if (names.has(extension.durable.name)) {
      throw new Error(`Duplicate extension: ${extension.durable.name}`);
    }
    names.add(extension.durable.name);
    if (extension.environment) {
      // NOTE: this can't throw, can it?
      if (environment) {
        throw new Error("Only one environment provider is allowed");
      }
      environment = extension.environment;
    }

    if (extension.delivery) {
      if (deliveries.has(extension.delivery.channel)) {
        // NOTE: do we even need to throw? can't we just ignore it?
        throw new Error(
          `Duplicate delivery channel: ${extension.delivery.channel}`,
        );
      }
      deliveries.set(extension.delivery.channel, extension.delivery);
    }
  }

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
  const durable = extensions.map((extension) => extension.durable);
  const tools = durable.flatMap((extension) => extension.tools ?? []);
  const assistantTools = extensions.flatMap((extension) => {
    const extensionTools = extension.durable.tools ?? [];
    return extension.assistantTools === undefined
      ? extensionTools
      : extensionTools.filter((tool) =>
          extension.assistantTools?.includes(tool.name),
        );
  });
  const policy = assistantToolPolicy(
    reference.getHarness,
    tools,
    extensions.flatMap((extension) => extension.readOnlyTools ?? []),
  );

  const threads = new ThreadDirectory(reference.getHarness, {
    async configureChatConversation(tx, id) {
      await configure(tx, id, {
        ...options.assistant,
        instructions: [
          options.assistant.instructions,
          ...extensions.flatMap((extension) =>
            extension.assistantInstructions
              ? [extension.assistantInstructions]
              : [],
          ),
        ].join("\n\n"),
        thinkingLevel: options.assistant.thinkingLevel ?? null,
        extensions: [...durable, policy],
        tools: assistantTools,
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

    await threads.refreshIdleConversations();

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
