import type { JsonValue } from "@earendil-works/chord";
import { track, type Draft } from "@earendil-works/chord/delta";
import type {
  DocDefinition,
  DocFamilyDefinition,
  DocFamilyToken,
  DocToken,
  Harness,
  JsonObject,
  Tx,
} from "@earendil-works/pi-durable";
import { vi } from "vitest";
async function unexpected(): Promise<never> {
  throw new Error("Unexpected mocked SDK operation");
}
async function document<T extends JsonObject, Seed extends JsonValue>(
  token:
    | DocToken<T, DocDefinition<T>>
    | DocFamilyToken<T, Seed, DocFamilyDefinition<T, Seed>>,
): Promise<Draft<T>> {
  if ("family" in token.definition) {
    throw new Error("Document families are not part of this fixture");
  }
  return track(token.definition.initial()).beginChange().state;
}
export function createMockTransaction(): Tx {
  return {
    conversation: vi.fn<Tx["conversation"]>(),
    entry: unexpected,
    task: vi.fn<Tx["task"]>(),
    scanConversations: vi.fn<Tx["scanConversations"]>(),
    scanEntries: vi.fn<Tx["scanEntries"]>(),
    latestHeadMarker: vi.fn<Tx["latestHeadMarker"]>(),
    scanTasks: vi.fn<Tx["scanTasks"]>(),
    submissionByRequest: vi.fn<Tx["submissionByRequest"]>(),
    createConversation: vi.fn<Tx["createConversation"]>(),
    forkConversation: vi.fn<Tx["forkConversation"]>(),
    appendEntry: unexpected,
    createTask: unexpected,
    createSubmission: vi.fn<Tx["createSubmission"]>(),
    settleSubmission: vi.fn<Tx["settleSubmission"]>(),
    placeSubmission: vi.fn<Tx["placeSubmission"]>(),
    doc: document,
    retireDoc: async () => {},
  };
}
export function createMockRuntime(
  tx = createMockTransaction(),
): Pick<
  Harness,
  "commit" | "snapshot" | "getTask" | "abortTask" | "waitForTask" | "inspect"
> {
  return {
    inspect: unexpected,
    commit: async (change) => change(tx),
    snapshot: async () => undefined,
    getTask: async () => undefined,
    abortTask: vi.fn<Harness["abortTask"]>(),
    waitForTask: unexpected,
  };
}
