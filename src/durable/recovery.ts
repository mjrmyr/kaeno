import type { Context } from "@earendil-works/chord";
import {
  AgentDoc,
  type Cursor,
  type Harness,
  type HarnessSettings,
  type RegistryReader,
} from "@earendil-works/pi-durable";

/**
 * Validate the installed release before refreshing saved bindings, resuming, or
 * accepting input. Install all definitions before Harness.open; open itself may
 * write reconciliation state, so take coordinated backups before opening.
 *
 * Uses only native inspection and reads: no task, migration, or wrapper runs.
 * Call with the same extension defaults as Harness.open when overriding them.
 * The application must keep the registry and saved bindings fixed during startup.
 */
export async function assertRecoveryCompatible(
  harness: Harness,
  registry: RegistryReader,
  context: Context,
  settings: Pick<HarnessSettings, "extensions"> = {},
): Promise<void> {
  const snapshot = registry.snapshot();
  const inspection = await harness.inspect(context);
  if (inspection.scheduling !== "paused") {
    throw new Error(
      "Recovery compatibility must be checked before scheduling or accepting input.",
    );
  }
  const problems: string[] = [];
  for (const { record, state } of inspection.tasks) {
    const definition = snapshot.task(record.kind)?.definition;
    let reason: string | undefined;
    if (state.kind === "blocked") {
      reason = state.reason;
    } else if (state.kind === "waiting") {
      // Native inspection prioritizes live dependencies over definition fit.
      // Check waiting tasks too, before their dependencies can make progress.
      if (!definition) {
        reason = "missing_task";
      } else if (definition.version < record.version) {
        reason = "task_too_old";
      } else if (definition.version > record.version && !definition.migrate) {
        reason = "migration_failed (no migration)";
      }
    }
    if (reason) {
      problems.push(
        `Task ${record.id} in conversation ${record.conversationId}: ${reason} (${record.kind}, saved version ${record.version}, installed version ${definition?.version ?? "missing"}).`,
      );
    }
  }

  let cursor: Cursor | undefined;
  do {
    // A read-only Session commit scans tables without creating documents or
    // publishing a storage write. Paginate so idle conversations are checked too.
    const page = await harness.commit(
      (tx) => tx.scanConversations({}, 100, cursor),
      context,
    );
    for (const conversation of page.items) {
      const agent = await harness.snapshot(AgentDoc, conversation.id, context);
      if (!agent) {
        continue;
      }
      const extensions = agent.extensions;
      const requiredExtensions = Array.isArray(extensions)
        ? extensions
        : (extensions?.add ?? []).filter(
            (name) => !extensions?.remove?.includes(name),
          );
      for (const name of new Set(requiredExtensions)) {
        if (!snapshot.extension(name)) {
          problems.push(
            `Conversation ${conversation.id}: missing extension ${JSON.stringify(name)} referenced by pi.agent.`,
          );
        }
      }
      // Removal filters do not require code to remain installed. Only positive
      // tool selections are requirements, in the selected extension scope.
      if (!Array.isArray(agent.tools)) {
        continue;
      }
      let selected: readonly string[];
      if (Array.isArray(extensions)) {
        selected = extensions;
      } else {
        const defaults = settings.extensions ?? snapshot.installed();
        const removed = new Set(extensions?.remove ?? []);
        selected = [
          ...defaults.map((extension) => extension.name),
          ...(extensions?.add ?? []),
        ].filter((name) => !removed.has(name));
      }
      const availableTools = new Set(
        selected.flatMap((name) =>
          (snapshot.extension(name)?.tools ?? []).map((tool) => tool.name),
        ),
      );
      for (const name of new Set(agent.tools)) {
        if (!availableTools.has(name)) {
          problems.push(
            `Conversation ${conversation.id}: missing tool ${JSON.stringify(name)} in its selected extensions, referenced by pi.agent.`,
          );
        }
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);

  if (problems.length > 0) {
    throw new Error(
      [
        "Startup recovery is incompatible with the installed definitions:",
        ...problems.map((problem) => `- ${problem}`),
        "Restore compatible extensions/task versions or provide explicit migrations before restarting. Settle tasks and update saved conversation bindings before retiring code; do not blindly abort missing-code tasks, whose cleanup cannot run.",
      ].join("\n"),
    );
  }
}
