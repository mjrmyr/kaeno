import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EventEmitter, once } from "node:events";
// Exercises one provider of the extension: "kaeno-local" (default) or "kaeno".
const provider = process.env.KAENO_SMOKE_TARGET ?? "kaeno-local";
if (provider !== "kaeno" && provider !== "kaeno-local") {
  throw new Error(
    `KAENO_SMOKE_TARGET must be "kaeno" or "kaeno-local", not "${provider}"`,
  );
}
const urlVariable = provider === "kaeno" ? "KAENO_URL" : "KAENO_LOCAL_URL";
const tokenVariable =
  provider === "kaeno" ? "KAENO_TOKEN" : "KAENO_LOCAL_TOKEN";
const token = "pi-delivery-smoke-token";
const directory = await mkdtemp(join(tmpdir(), "kaeno-pi-delivery-"));
const agentDirectory = join(directory, "agent");
await mkdir(join(agentDirectory, "extensions"), { recursive: true });
// Match the installed layout, not an explicit -e path: dependency resolution differs.
await symlink(
  resolve("pi-extension/kaeno"),
  join(agentDirectory, "extensions", "kaeno"),
);
// Exercise the same navigation as /tree without depending on the interactive TUI.
await writeFile(
  join(agentDirectory, "extensions", "test-tree.js"),
  `
export default function (pi) {
  pi.registerCommand("test-tree-root", {
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getEntries();
      const target = entries.find(entry => entry.type === "message" && entry.message.role === "system") ?? entries[0];
      if (!target) throw new Error("No tree root");
      await ctx.navigateTree(target.id, { summarize: false });
    },
  });
}
`,
);
const replies = [];
let posts = 0;
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end("missing token");
    return;
  }
  if (req.method === "POST") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }
    const { requestId } = JSON.parse(body);
    posts++;
    replies.push({ id: 1, requestId, text: "ACK_ONCE" });
    setTimeout(
      () =>
        replies.push({
          id: 2,
          requestId: "activity-result:work",
          text: "REPORT_AUTOMATIC",
        }),
      600,
    );
    res.writeHead(202).end(JSON.stringify({ taskId: "task" }));
  } else {
    const after = Number(
      new URL(req.url, "http://local").searchParams.get("after"),
    );
    res.end(
      JSON.stringify({
        replies: replies.filter((reply) => reply.id > after),
        next: replies.at(-1)?.id ?? 0,
        truncated: false,
      }),
    );
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
function start() {
  const child = spawn(
    "pi",
    [
      "--offline",
      "--no-mcp",
      "--mode",
      "rpc",
      "--session-dir",
      join(directory, "sessions"),
      "--session-id",
      "delivery-smoke",
      "--no-tools",
      "--no-skills",
      "--no-context-files",
      "--provider",
      provider,
      "--model",
      provider,
    ],
    {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDirectory,
        [urlVariable]: url,
        [tokenVariable]: token,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const events = new EventEmitter();
  let buffer = "",
    stderr = "";
  const records = [];
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (!line) {
        continue;
      }
      const event = JSON.parse(line);
      records.push(event);
      events.emit("record", event);
    }
  });
  function wait(test) {
    const found = records.find(test);
    if (found) {
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        events.off("record", listener);
        reject(new Error(`Timeout: ${stderr}\n${JSON.stringify(records)}`));
      }, 15000);
      function listener(event) {
        if (test(event)) {
          clearTimeout(timer);
          events.off("record", listener);
          resolve(event);
        }
      }
      events.on("record", listener);
    });
  }
  return {
    child,
    records,
    wait,
    send: (command) => child.stdin.write(JSON.stringify(command) + "\n"),
    close: async () => {
      const done = once(child, "exit");
      child.stdin.end();
      await done;
      if (stderr) {
        console.error(stderr.trim());
      }
    },
  };
}
let client;
try {
  client = start();
  client.send({ id: "send", type: "prompt", message: "start worker" });
  await client.wait(
    (event) =>
      event.type === "message_end" && event.message?.role === "assistant",
  );
  await client.wait(
    (event) =>
      event.type === "message_end" &&
      event.message?.customType === `${provider}-reply`,
  );
  await client.wait(
    (event) =>
      event.type === "entry_appended" && event.entry?.data?.after === 2,
  );
  client.send({ id: "fetch", type: "prompt", message: `/${provider}-replies` });
  await client.wait(
    (event) => event.type === "response" && event.id === "fetch",
  );
  await new Promise((resolve) => setTimeout(resolve, 1200));
  let messages = client.records
    .filter((event) => event.type === "message_end")
    .map((event) => event.message);
  if (
    messages.filter((message) => message.role === "assistant").length !== 1 ||
    messages.filter((message) => message.customType === `${provider}-reply`)
      .length !== 1 ||
    posts !== 1
  ) {
    throw new Error("Duplicate delivery or unintended model call");
  }
  client.send({ id: "rewind", type: "prompt", message: "/test-tree-root" });
  const rewound = await client.wait(
    (event) => event.type === "response" && event.id === "rewind",
  );
  if (!rewound.success) {
    throw new Error(`Tree navigation failed: ${JSON.stringify(rewound)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const afterRewind = client.records.filter(
    (event) => event.type === "message_end",
  );
  if (afterRewind.length !== messages.length) {
    throw new Error("Tree rewind replayed previously delivered replies");
  }
  replies.push({
    id: 3,
    requestId: "activity-result:after-tree",
    text: "REPORT_AFTER_TREE",
  });
  await client.wait(
    (event) =>
      event.type === "message_end" &&
      event.message?.content === "REPORT_AFTER_TREE",
  );
  await client.wait(
    (event) =>
      event.type === "entry_appended" && event.entry?.data?.after === 3,
  );
  await client.close();
  client = undefined;
  replies.push({
    id: 4,
    requestId: "activity-result:offline",
    text: "REPORT_WHILE_OFFLINE",
  });
  client = start();
  await client.wait(
    (event) =>
      event.type === "message_end" &&
      event.message?.customType === `${provider}-reply`,
  );
  await client.wait(
    (event) =>
      event.type === "entry_appended" && event.entry?.data?.after === 4,
  );
  messages = client.records
    .filter((event) => event.type === "message_end")
    .map((event) => event.message);
  if (
    messages.length !== 1 ||
    messages[0].content !== "REPORT_WHILE_OFFLINE" ||
    posts !== 1
  ) {
    throw new Error("Resume replayed old messages");
  }
  await client.close();
  client = undefined;
  console.log(
    "PASS: real Pi RPC: automatic delivery, no replay on manual fetch or tree rewind, new replies after rewind, and only unread replies on resume.",
  );
} finally {
  if (client) {
    client.child.kill("SIGKILL");
  }
  server.close();
  server.closeAllConnections();
  await rm(directory, { recursive: true, force: true });
}
