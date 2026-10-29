import type { KaenoClient } from "./client.ts";
import type { Store } from "./store.ts";
import type { ThreadState } from "./thread.ts";

export type Target =
  { kind: "thread" } | { kind: "work"; workId: number } | { kind: "selected" };

export interface PaneSpec {
  pane: string;
  target: Target;
}

export interface PaneContext {
  client: KaenoClient;
  thread: Store<ThreadState>;
  selected: Store<number | undefined>;
  open(spec: PaneSpec): void;
}

export interface Pane {
  kind: string;
  title(target: Target, thread: ThreadState): string;
  mount(host: HTMLElement, target: Target, context: PaneContext): () => void;
}

export type PaneRegistry = ReadonlyMap<string, Pane>;

export function paneRegistry(panes: readonly Pane[]): PaneRegistry {
  return new Map(panes.map((pane) => [pane.kind, pane]));
}

export function conversationOf(
  _target: Target,
  _thread: ThreadState,
  _selected: number | undefined,
): number | undefined {
  throw new Error("not implemented");
}
