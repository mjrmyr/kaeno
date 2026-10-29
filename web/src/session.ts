import type { KaenoClient } from "./client.ts";
import type { Layout } from "./layout.ts";
import type { PaneContext } from "./panes.ts";
import type { Store } from "./store.ts";

export interface Session {
  context: PaneContext;
  close(): void;
}

export function openSession(
  _client: KaenoClient,
  _threadKey: string,
  _layout: Store<Layout>,
): Session {
  throw new Error("not implemented");
}

export function watchSet(
  _layout: Layout,
  _context: PaneContext,
): readonly number[] {
  throw new Error("not implemented");
}
