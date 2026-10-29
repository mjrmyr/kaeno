import type { PaneContext, PaneRegistry, PaneSpec } from "./panes.ts";
import type { Store } from "./store.ts";

export type Layout =
  | { kind: "pane"; spec: PaneSpec }
  | {
      kind: "split";
      direction: "row" | "column";
      sizes: readonly number[];
      children: readonly Layout[];
    }
  | { kind: "tabs"; active: number; children: readonly Layout[] };

export function panesOf(_layout: Layout): PaneSpec[] {
  throw new Error("not implemented");
}

export function compact(_layout: Layout): Layout {
  throw new Error("not implemented");
}

export function loadLayout(_key: string, fallback: Layout): Layout {
  return fallback;
}

export function saveLayout(_key: string, _layout: Layout): void {
  throw new Error("not implemented");
}

export function mountLayout(
  _host: HTMLElement,
  _layout: Store<Layout>,
  _narrow: MediaQueryList,
  _panes: PaneRegistry,
  _context: PaneContext,
): () => void {
  throw new Error("not implemented");
}
