import type { Context, JsonValue } from "@earendil-works/chord";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  configure,
  defineDoc,
  type ConversationId,
  type DocumentReader,
  type Extension,
  type ModelRef,
  type JsonObject,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import { z } from "zod";

/**
 * Private, versioned data of one installed extension for one conversation, for example the
 * skills assigned to it. Core stores it and checks the owner is installed; only the owner
 * interprets `value`. A binding never selects tools or grants authority.
 */
export interface Binding {
  readonly owner: string;
  readonly version: number;
  readonly value: JsonValue;
}

/**
 * Everything one conversation runs with, already resolved. The same shape serves the CHAT
 * assistant and every WORK participant; where it came from (Markdown, code, …) is not core's concern.
 */
export interface ConversationSetup {
  readonly model: ModelRef;
  readonly thinkingLevel?: ModelThinkingLevel;
  readonly instructions: string;
  /** Exact tool names this conversation may call; omitted means none. */
  readonly tools?: readonly string[];
  readonly bindings?: readonly Binding[];
}

const thinking = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);
export const bindingSchema = z.object({
  owner: z.string().min(1),
  version: z.number().int().min(1),
  value: jsonValue,
});
export const setupSchema = z.object({
  model: z.object({ provider: z.string().min(1), modelId: z.string().min(1) }),
  thinkingLevel: thinking.optional(),
  instructions: z.string(),
  tools: z.array(z.string()).optional(),
  bindings: z.array(bindingSchema).optional(),
});

/** Saved bindings of one conversation. Written with its agent configuration in one commit. */
/** JSON storage shape of a binding. */
export interface StoredBinding {
  owner: string;
  version: number;
  value: JsonValue;
}
export const ConversationBindings = defineDoc<JsonObject>({
  kind: "kaeno.conversation-bindings",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ bindings: [] }),
});

/** Tools and extensions a setup is resolved against: the installed native definitions. */
export interface SetupSurface {
  /** Native tools a setup may select, by name, with the installed extension that owns each. */
  readonly tools: ReadonlyMap<
    string,
    { readonly tool: ToolRegistration; readonly extension: Extension }
  >;
  /** Installed extensions by name; binding owners must be among them. */
  readonly extensions: ReadonlyMap<string, Extension>;
}

/**
 * Check a setup against the installed surface: every tool must be selectable and every
 * binding owner installed. Throws an actionable error; used at admission and recovery.
 */
export function assertSetupFits(
  label: string,
  setup: ConversationSetup,
  surface: SetupSurface,
): void {
  for (const name of setup.tools ?? []) {
    if (!surface.tools.has(name)) {
      throw new Error(`${label}: tool "${name}" is not available here`);
    }
  }
  const owners = new Set<string>();
  for (const binding of setup.bindings ?? []) {
    if (owners.has(binding.owner)) {
      throw new Error(`${label}: duplicate binding owner "${binding.owner}"`);
    }
    owners.add(binding.owner);
    if (!surface.extensions.has(binding.owner)) {
      throw new Error(
        `${label}: binding owner "${binding.owner}" is not installed`,
      );
    }
  }
}

/**
 * Configure a conversation from a setup. The selected extensions are the owners of the selected
 * tools and bindings plus any infrastructure the caller adds explicitly (for example WORK protocol
 * tools); nothing is implied by an omitted list.
 */
export async function applySetup(
  tx: Tx,
  id: ConversationId,
  change: {
    setup: ConversationSetup;
    surface: SetupSurface;
    extraExtensions?: readonly Extension[];
    instructions?: string;
    cwd: string | null;
  },
): Promise<void> {
  const extensions = new Map<string, Extension>();
  const tools: ToolRegistration[] = [];
  for (const name of change.setup.tools ?? []) {
    const entry = change.surface.tools.get(name);
    if (!entry) {
      throw new Error(`Tool "${name}" is not available here`);
    }
    tools.push(entry.tool);
    extensions.set(entry.extension.name, entry.extension);
  }
  for (const binding of change.setup.bindings ?? []) {
    const owner = change.surface.extensions.get(binding.owner);
    if (!owner) {
      throw new Error(`Binding owner "${binding.owner}" is not installed`);
    }
    extensions.set(owner.name, owner);
  }
  for (const extension of change.extraExtensions ?? []) {
    extensions.set(extension.name, extension);
  }
  await configure(tx, id, {
    model: { ...change.setup.model },
    thinkingLevel: change.setup.thinkingLevel ?? null,
    extensions: [...extensions.values()],
    tools,
    instructions: change.instructions ?? change.setup.instructions,
    cwd: change.cwd,
  });
  const saved = await tx.doc(ConversationBindings, id);
  saved.bindings = (change.setup.bindings ?? []).map((binding) =>
    bindingSchema.parse(binding),
  );
}

/** Read one owner's binding of a conversation, from tools and prompt sections. */
export async function readBinding(
  read: DocumentReader,
  id: ConversationId,
  owner: string,
  context: Context,
): Promise<Binding | undefined> {
  const saved = await read.snapshot(ConversationBindings, id, context);
  const bindings = z.array(bindingSchema).parse(saved?.bindings ?? []);
  return bindings.find((binding) => binding.owner === owner);
}
