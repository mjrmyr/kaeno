import type { JsonValue } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import type {
  configure,
  DocDefinition,
  DocToken,
  Extension,
  HookRegistration,
  JsonObject,
  PromptSection,
  Task,
  TaskDefinition,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { vi } from "vitest";
function defineDoc<T extends JsonObject>(
  definition: DocDefinition<T>,
): DocToken<T, DocDefinition<T>> {
  return { definition };
}
function defineTask<
  I,
  S extends {
    phase: string;
  },
  R,
  H extends object,
>(definition: TaskDefinition<I, S, R, H>): Task<I, S, R, H> {
  return { definition };
}
function defineExtension(extension: Extension): Extension {
  return extension;
}
function defineTool<Parameters extends TSchema, Details extends JsonValue>(
  tool: ToolRegistration<Parameters, Details>,
): ToolRegistration<Parameters, Details> {
  return tool;
}
function hook(
  task: {
    definition: {
      name: string;
    };
  },
  handlers: object,
): HookRegistration {
  return { task: task.definition.name, handlers };
}
function section(key: string, render: PromptSection["render"]): PromptSection {
  return { key, render };
}
export interface MockSdk {
  defineDoc: typeof defineDoc;
  defineTask: typeof defineTask;
  defineExtension: typeof defineExtension;
  defineTool: typeof defineTool;
  hook: typeof hook;
  section: typeof section;
  configure: typeof configure;
  GenerationTask: {
    definition: {
      name: string;
    };
  };
  CompactionTask: { definition: { name: string } };
  ToolTask: {
    definition: {
      name: string;
    };
  };
  AgentDoc: object;
  AssistantEntry: object;
  UsageDoc: object;
  InboxDoc: object;
  LiveDoc: object;
}
export function createMockSdk(): MockSdk {
  return {
    defineDoc,
    defineTask,
    defineExtension,
    defineTool,
    hook,
    section,
    configure: vi.fn<typeof configure>().mockResolvedValue(undefined),
    GenerationTask: { definition: { name: "pi.generation" } },
    CompactionTask: { definition: { name: "pi.compaction" } },
    ToolTask: { definition: { name: "pi.tool" } },
    AgentDoc: { definition: { initial: () => ({}) } },
    AssistantEntry: {},
    UsageDoc: { definition: { initial: () => ({}) } },
    InboxDoc: { definition: { initial: () => ({ items: [] }) } },
    LiveDoc: { definition: { initial: () => ({}) } },
  };
}
