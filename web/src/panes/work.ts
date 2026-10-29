import type { Pane } from "../panes.ts";

export const workPane: Pane = {
  kind: "work",
  title: () => "Work",
  mount() {
    throw new Error("not implemented");
  },
};
