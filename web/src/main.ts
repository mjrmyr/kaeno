import { init } from "ghostty-web";
import { KaenoClient } from "./client.ts";
import { loadLayout, mountLayout, saveLayout, type Layout } from "./layout.ts";
import { chatPane } from "./panes/chat.ts";
import { terminalPane } from "./panes/terminal.ts";
import { workPane } from "./panes/work.ts";
import { paneRegistry } from "./panes.ts";
import { openSession } from "./session.ts";
import { store } from "./store.ts";

const defaultLayout: Layout = {
  kind: "split",
  direction: "row",
  sizes: [0.5, 0.5],
  children: [
    { kind: "pane", spec: { pane: "chat", target: { kind: "thread" } } },
    {
      kind: "split",
      direction: "column",
      sizes: [0.35, 0.65],
      children: [
        { kind: "pane", spec: { pane: "work", target: { kind: "thread" } } },
        {
          kind: "pane",
          spec: { pane: "terminal", target: { kind: "selected" } },
        },
      ],
    },
  ],
};

await init();
const client = new KaenoClient(location.origin);
const threadKey = decodeURIComponent(location.hash.slice(1)) || "web:main";
const layout = store(loadLayout("kaeno.layout", defaultLayout));
layout.subscribe((value) => saveLayout("kaeno.layout", value));
const session = openSession(client, threadKey, layout);
mountLayout(
  document.getElementById("app")!,
  layout,
  matchMedia("(max-width: 720px)"),
  paneRegistry([chatPane, workPane, terminalPane]),
  session.context,
);
