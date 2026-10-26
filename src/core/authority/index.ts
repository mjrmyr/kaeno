import {
  defineExtension,
  wrapTool,
  type Extension,
  type Harness,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { activeTurn, TurnLedger } from "../turns/index.ts";

/**
 * Wrap the complete selected CHAT tool surface, not WORK's delegated tools.
 * Unlisted read names do not grant authority to any tool added later.
 * Explicit activity-result tools may mutate without a new user turn, but remain epoch-fenced.
 * This is an invocation gate, not an atomic external-effect boundary: durable
 * mutations must recheck origin epoch/control in their effect-admission commit.
 */
export function assistantToolPolicy(
  getHarness: () => Harness,
  tools: readonly ToolRegistration[],
  readOnlyNames: readonly string[] = [],
  activityResultTools: readonly string[] = [],
): Extension {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new Error(`Ambiguous assistant tool name: ${tool.name}`);
    }
    names.add(tool.name);
  }
  const reads = new Set(readOnlyNames);
  const autonomous = new Set(activityResultTools);
  return defineExtension({
    name: "kaeno-tool-authority",
    wraps: tools.map((selected) =>
      wrapTool(selected, (tool) => ({
        ...tool,
        async execute(args, api, context) {
          if (!reads.has(tool.name)) {
            const { origin, source } = await activeTurn(
              getHarness(),
              api.conversationId,
              context,
            );
            if (source.kind !== "user" && !autonomous.has(tool.name)) {
              throw new Error("Assistant mutation requires a user turn");
            }
            const ledger = await api.snapshot(
              TurnLedger,
              origin.conversationId,
              context,
            );
            if (!ledger || ledger.control || ledger.epoch !== origin.epoch) {
              throw new Error("Assistant mutation origin is fenced");
            }
          }
          return tool.execute(args, api, context);
        },
      })),
    ),
  });
}
