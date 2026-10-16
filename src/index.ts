import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  configure,
  createRegistry,
  defineDoc,
  Harness,
  type AgentChange,
  type Conversation,
  type ConversationId,
  type EnvTarget,
  type Extension,
  type HarnessSettings,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const Names = defineDoc<{ names: Record<string, ConversationId> }>({
  kind: "kaeno.conversations",
  version: 1,
  scope: "session",
  initial: () => ({ names: {} }),
});

/** Trusted host code, not a sandboxed or dynamically loaded plugin. */
export interface HostExtension {
  readonly definition: Extension;
  readonly env?: (
    target: EnvTarget,
    context: Context,
  ) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;
  /** Start ingress after recovery checks; return its async shutdown function. */
  readonly start?: (workspace: Workspace) => Promise<() => Promise<void>>;
}

export interface Workspace {
  /** Native handles expose submit, steer, abort, reset, fork, watch and commits. */
  conversation(key: string, context?: Context): Promise<Conversation>;
  /** Full-trust access for host extensions; do not expose to untrusted clients. */
  readonly harness: Harness;
  close(): Promise<void>;
}

export interface WorkspaceOptions {
  readonly database: string;
  readonly models: Models;
  readonly agent?: AgentChange;
  readonly settings?: HarnessSettings;
  readonly extensions?: readonly HostExtension[];
}

export async function openWorkspace(
  options: WorkspaceOptions,
): Promise<Workspace> {
  const extensions = options.extensions ?? [];
  const registry = createRegistry();
  const names = new Set<string>();
  let env: HostExtension["env"];
  for (const extension of extensions) {
    if (!extension.definition.name || names.has(extension.definition.name)) {
      throw new Error(
        `Duplicate or empty extension name: ${extension.definition.name}`,
      );
    }
    names.add(extension.definition.name);
    if (extension.env) {
      if (env) {
        throw new Error(
          "Only one extension may provide an execution environment",
        );
      }
      env = extension.env;
    }
    registry.install(extension.definition);
  }

  const storage = await openNodeSqliteStorage(options.database);
  let harness: Harness;
  try {
    harness = await Harness.open(
      storage,
      { models: options.models, registry, settings: options.settings, env },
      BACKGROUND_CONTEXT,
    );
  } catch (error) {
    await storage.close(BACKGROUND_CONTEXT);
    throw error;
  }

  const stops: Array<() => Promise<void>> = [];
  let closing: Promise<void> | undefined;
  const workspace: Workspace = {
    harness,
    async conversation(key, context = BACKGROUND_CONTEXT) {
      if (closing) {
        throw new Error("Workspace is closed");
      }
      if (!key) {
        throw new Error("Conversation key must not be empty");
      }
      // Identity and initial agent are persisted in the same serialized commit.
      const id = await harness.commit(async (tx) => {
        const doc = await tx.doc(Names);
        const name = JSON.stringify(key); // safe even for "__proto__"
        if (Object.hasOwn(doc.names, name)) {
          return doc.names[name];
        }
        const record = await tx.createConversation({
          ownership: { kind: "ownerless" },
        });
        if (options.agent) {
          await configure(tx, record.id, options.agent);
        }
        doc.names[name] = record.id;
        return record.id;
      }, context);
      const conversation = await harness.conversation(id, context);
      if (!conversation) {
        throw new Error(`Named conversation missing: ${key}`);
      }
      return conversation;
    },
    close() {
      closing ??= (async () => {
        const errors: unknown[] = [];
        for (const stop of stops.reverse()) {
          try {
            await stop();
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await harness.close(BACKGROUND_CONTEXT);
        } catch (error) {
          errors.push(error);
        }
        if (errors.length) {
          throw new AggregateError(errors, "Workspace shutdown failed");
        }
      })();
      return closing;
    },
  };

  try {
    const snapshot = registry.snapshot();
    const incompatible = (
      await harness.inspect(BACKGROUND_CONTEXT)
    ).tasks.filter(({ record, state }) => {
      const installed = snapshot.task(record.kind)?.definition;
      return (
        !installed ||
        installed.version !== record.version ||
        state.kind === "blocked"
      );
    });
    if (incompatible.length) {
      throw new Error(
        `Cannot resume pending tasks; install matching definitions: ${incompatible.map(({ record }) => `${record.kind}@${record.version}`).join(", ")}`,
      );
    }
    for (const extension of extensions) {
      if (extension.start) {
        stops.push(await extension.start(workspace));
      }
    }
    harness.resume();
    return workspace;
  } catch (error) {
    try {
      await workspace.close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Workspace startup and cleanup failed",
      );
    }
    throw error;
  }
}
