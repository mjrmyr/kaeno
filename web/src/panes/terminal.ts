import type { Terminal } from "ghostty-web";
import type { ToolRun } from "../conversation.ts";
import type { Pane } from "../panes.ts";

export const terminalPane: Pane = {
  kind: "terminal",
  title: () => "Terminal",
  mount() {
    throw new Error("not implemented");
  },
};

export function writeToolRun(
  _terminal: Terminal,
  _run: ToolRun,
  _previous: ToolRun | undefined,
): void {
  throw new Error("not implemented");
}
