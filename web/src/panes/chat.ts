import type { Pane } from "../panes.ts";

export const chatPane: Pane = {
  kind: "chat",
  title: () => "Kaeno",
  mount() {
    throw new Error("not implemented");
  },
};
