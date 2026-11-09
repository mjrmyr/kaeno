import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  getCurrentSystemPrompt,
  type Context as ModelContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage as answer,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  defineExtension,
  MemoryStorage,
  type JsonObject,
} from "@earendil-works/pi-durable";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openKaeno } from "../../src/core/application/index.ts";
import {
  genericAdapter,
  GITHUB_ACTIONS,
  githubAdapter,
  loadWebhooks,
  WebhookServer,
} from "../../src/channels/webhooks/index.ts";

const model = { provider: "faux", modelId: "faux-1" };
const SECRET = "homelab-webhook-secret-with-32-chars";
const SELF = "kaeno-app[bot]";
const PULL = "github:mjrmyr/kaeno#12";
function call(name: string, args: JsonObject) {
  return answer([fauxToolCall(name, args)], { stopReason: "toolUse" });
}
async function until(check: () => boolean | Promise<boolean>, what: string) {
  const end = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > end) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function lastInput(request: ModelContext) {
  return request.messages.findLast((message) => message.role !== "system");
}

async function fixture() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const workerRequests: ModelContext[] = [];
  faux.setResponses(
    Array.from({ length: 100 }, () => async (request: ModelContext) => {
      const last = lastInput(request);
      const text = JSON.stringify(last?.content);
      if (getCurrentSystemPrompt(request.messages).includes("WORKER")) {
        workerRequests.push(request);
        if (last?.role === "toolResult") {
          return answer("Nothing needed.");
        }
        const follow = /FOLLOW ([a-z0-9:#/.-]+)/.exec(text)?.[1];
        if (follow) {
          return call("follow_thread", { thread: follow });
        }
        return text.includes("authority system")
          ? call("report", { state: "quiet", text: "Nothing needed." })
          : answer("Done.");
      }
      if (last?.role === "toolResult") {
        return answer("ok");
      }
      const trigger = /<trigger id=\\"(t[0-9]+)\\"/.exec(text)?.[1];
      return trigger && text.includes('authority=\\"owner\\"')
        ? call("route", {
            items: [
              {
                trigger,
                kind: "accept",
                agent: "worker",
                title: "job",
                ack: "On it.",
              },
            ],
          })
        : answer("nothing to do");
    }),
  );
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models,
    assistant: {
      model,
      instructions: "ROUTER",
      tools: ["route", "reply", "recall", "list_tickets", "stop_ticket"],
    },
    extensions: [
      {
        durable: defineExtension({ name: "test-channel", tools: [] }),
        delivery: {
          channel: "test",
          send: async () => {},
          openThread: async (_route, title) => ({
            key: `test:${title}`,
            route: { channel: "test", address: title },
          }),
        },
      },
    ],
    onReport: (error) => console.error("REPORT", error),
    work: {
      agents: [
        {
          id: "worker",
          description: "Does tasks",
          setup: {
            model,
            instructions: "WORKER",
            tools: ["report", "follow_thread"],
          },
        },
      ],
      tools: ["report", "follow_thread"],
      maxDepth: 1,
      maxConcurrent: 2,
    },
  });
  const server = new WebhookServer(core, [
    { name: "homelab", adapter: genericAdapter(SECRET), trust: "all" },
    {
      name: "ci",
      adapter: genericAdapter(SECRET),
      trust: { actors: ["ci-bot"] },
    },
    {
      name: "github",
      adapter: githubAdapter(SECRET, SELF),
      trust: { actors: ["mjrmyr", GITHUB_ACTIONS] },
    },
  ]).server;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing address");
  }
  const base = `http://127.0.0.1:${address.port}`;
  async function post(
    source: string,
    event: JsonObject,
    secret: string | null = SECRET,
  ) {
    const body = JSON.stringify(event);
    const response = await fetch(`${base}/hooks/${source}`, {
      method: "POST",
      body,
      headers:
        secret === null
          ? {}
          : {
              "x-kaeno-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
            },
    });
    return { status: response.status, body: await response.json() };
  }
  async function postGitHub(
    kind: string,
    payload: JsonObject,
    delivery: string,
    secret = SECRET,
  ) {
    const body = JSON.stringify(payload);
    const response = await fetch(`${base}/hooks/github`, {
      method: "POST",
      body,
      headers: {
        "x-github-event": kind,
        "x-github-delivery": delivery,
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      },
    });
    return { status: response.status, body: await response.json() };
  }
  async function ticket() {
    return (await core.router.listTickets(context, true)).find(
      (value) => value.id === "k1",
    );
  }
  async function idleAfter(runs: number) {
    await until(async () => {
      const current = await ticket();
      return current?.status === "idle" && current.assignments.length === runs;
    }, `idle after ${runs} runs`);
  }
  async function followingTicket(thread: string) {
    await core.harness.commit(
      (tx) =>
        core.router.receive(tx, {
          key: "test:start",
          source: "test",
          threads: ["test:main"],
          actor: "owner",
          authority: "owner",
          content: `FOLLOW ${thread}`,
          route: { channel: "test", address: "main", replyTo: "start" },
        }),
      context,
    );
    await idleAfter(1);
    expect((await ticket())?.followed).toEqual([thread]);
  }
  async function close() {
    server.close();
    server.closeAllConnections();
    await core.close();
  }
  return {
    core,
    post,
    postGitHub,
    ticket,
    idleAfter,
    followingTicket,
    workerRequests,
    close,
  };
}
async function withFixture(
  body: (fx: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
) {
  const fx = await fixture();
  try {
    await body(fx);
  } finally {
    await fx.close();
  }
}
function event(id: string, extra: JsonObject = {}): JsonObject {
  return {
    id,
    thread: "backups",
    actor: "nightly",
    text: "backup finished",
    ...extra,
  };
}

it("refuses requests that are unsigned, wrongly signed or for an unknown source", async () => {
  await withFixture(async (fx) => {
    expect((await fx.post("homelab", event("e1"), null)).status).toBe(401);
    expect((await fx.post("homelab", event("e2"), "x".repeat(40))).status).toBe(
      401,
    );
    expect((await fx.post("unknown", event("e3"))).status).toBe(404);
    expect(await fx.core.router.recentTriggers(context)).toEqual([]);
  });
});

it("wakes a ticket following the source's thread with a system event", async () => {
  await withFixture(async (fx) => {
    await fx.followingTicket("homelab:backups");

    const received = await fx.post("homelab", event("e1"));

    expect(received.status).toBe(202);
    const trigger = await fx.core.router.trigger(
      received.body.trigger,
      context,
    );
    expect(trigger).toMatchObject({
      source: "homelab",
      threads: ["homelab:backups"],
      actor: "nightly",
      authority: "system",
      disposition: { kind: "passed", tickets: ["k1"] },
    });
    await fx.idleAfter(2);
    expect(JSON.stringify(fx.workerRequests.at(-1)?.messages)).toContain(
      "from nightly via homelab",
    );
  });
});

it("gives an untrusted actor of a verified source no access to the worker", async () => {
  await withFixture(async (fx) => {
    await fx.followingTicket("ci:pr-12");
    const seen = fx.workerRequests.length;

    const stranger = await fx.post(
      "ci",
      event("e1", { thread: "pr-12", actor: "stranger" }),
    );
    const bot = await fx.post(
      "ci",
      event("e2", { thread: "pr-12", actor: "ci-bot" }),
    );

    const refused = await fx.core.router.trigger(
      stranger.body.trigger,
      context,
    );
    expect(refused).toMatchObject({
      authority: "none",
      disposition: { kind: "filtered" },
    });
    expect(
      (await fx.core.router.trigger(bot.body.trigger, context)).authority,
    ).toBe("system");
    await fx.idleAfter(2);
    expect(JSON.stringify(fx.workerRequests.slice(seen))).not.toContain(
      "stranger",
    );
  });
});

it("keeps every source inside its own threads", async () => {
  await withFixture(async (fx) => {
    await fx.followingTicket("test:watched");

    const spoofed = await fx.post(
      "homelab",
      event("e1", { thread: "test:watched" }),
    );

    const trigger = await fx.core.router.trigger(spoofed.body.trigger, context);
    expect(trigger.threads).toEqual(["homelab:test:watched"]);
    expect(trigger.disposition?.kind).not.toBe("passed");
    expect((await fx.ticket())?.assignments).toHaveLength(1);
  });
});

it("delivers a closing event, then stops following the thread", async () => {
  await withFixture(async (fx) => {
    await fx.followingTicket("homelab:backups");

    const closing = await fx.post("homelab", event("e1", { closes: true }));

    expect(
      (await fx.core.router.trigger(closing.body.trigger, context)).disposition,
    ).toMatchObject({ kind: "passed", tickets: ["k1"] });
    await fx.idleAfter(2);
    expect((await fx.ticket())?.followed).toEqual([]);
    expect(
      (await fx.core.router.thread("homelab:backups", context))?.subscribers,
    ).toEqual([]);

    const later = await fx.post("homelab", event("e2"));
    expect(
      (await fx.core.router.trigger(later.body.trigger, context)).disposition
        ?.kind,
    ).not.toBe("passed");
    expect((await fx.ticket())?.assignments).toHaveLength(2);
  });
});

it("records a redelivered event once", async () => {
  await withFixture(async (fx) => {
    const first = await fx.post("homelab", event("e1"));
    const again = await fx.post("homelab", event("e1", { closes: true }));

    expect(first.body.duplicate).toBe(false);
    expect(again.body).toEqual({
      trigger: first.body.trigger,
      duplicate: true,
    });
    expect(await fx.core.router.recentTriggers(context)).toEqual([
      first.body.trigger,
    ]);
  });
});

function pull(action: string, sender: string, extra: JsonObject = {}) {
  return {
    action,
    sender: { login: sender },
    repository: { full_name: "mjrmyr/kaeno" },
    pull_request: {
      number: 12,
      title: "Fix the parser",
      html_url: "https://github.com/mjrmyr/kaeno/pull/12",
      merged: false,
      head: { ref: "kaeno/fix", sha: "0123456789abcdef" },
    },
    ...extra,
  };
}

it("wakes the worker on a trusted account's push to its pull request, never on its own or a stranger's", async () => {
  await withFixture(async (fx) => {
    await fx.followingTicket(PULL);
    const seen = fx.workerRequests.length;

    const own = await fx.postGitHub(
      "pull_request",
      pull("synchronize", SELF),
      "d1",
    );
    const stranger = await fx.postGitHub(
      "pull_request",
      pull("synchronize", "stranger"),
      "d2",
    );
    const owner = await fx.postGitHub(
      "pull_request",
      pull("synchronize", "mjrmyr"),
      "d3",
    );

    expect(own.body).toEqual({ ignored: true });
    expect(
      await fx.core.router.trigger(stranger.body.trigger, context),
    ).toMatchObject({
      threads: [PULL],
      authority: "none",
      disposition: { kind: "filtered" },
    });
    expect(
      await fx.core.router.trigger(owner.body.trigger, context),
    ).toMatchObject({
      key: "github:d3",
      actor: "mjrmyr",
      authority: "system",
      disposition: { kind: "passed", tickets: ["k1"] },
    });
    await fx.idleAfter(2);
    const delivered = JSON.stringify(fx.workerRequests.slice(seen));
    expect(delivered).toContain(
      "mjrmyr pushed to pull request mjrmyr/kaeno#12",
    );
    expect(delivered).not.toContain("stranger");
  });
});

it("reports a finished CI run to every pull request it ran for", async () => {
  await withFixture(async (fx) => {
    await fx.followingTicket(PULL);

    const run = await fx.postGitHub(
      "workflow_run",
      {
        action: "completed",
        sender: { login: SELF },
        repository: { full_name: "mjrmyr/kaeno" },
        workflow_run: {
          name: "verify",
          conclusion: "failure",
          head_sha: "fedcba9876543210",
          html_url: "https://github.com/mjrmyr/kaeno/actions/runs/1",
          pull_requests: [{ number: 12 }, { number: 13 }],
        },
      },
      "d1",
    );

    expect(
      await fx.core.router.trigger(run.body.trigger, context),
    ).toMatchObject({
      threads: [PULL, "github:mjrmyr/kaeno#13"],
      actor: GITHUB_ACTIONS,
      authority: "system",
      disposition: { kind: "passed", tickets: ["k1"] },
    });
    await fx.idleAfter(2);
    expect(JSON.stringify(fx.workerRequests.at(-1)?.messages)).toContain(
      'Workflow \\"verify\\" failure at fedcba9',
    );
  });
});

it("stops following a pull request once it is merged", async () => {
  await withFixture(async (fx) => {
    await fx.followingTicket(PULL);

    const merged = await fx.postGitHub(
      "pull_request",
      pull("closed", "mjrmyr", {
        pull_request: {
          ...pull("closed", "mjrmyr").pull_request,
          merged: true,
        },
      }),
      "d1",
    );

    expect(
      (await fx.core.router.trigger(merged.body.trigger, context)).disposition,
    ).toMatchObject({ kind: "passed", tickets: ["k1"] });
    await fx.idleAfter(2);
    expect(JSON.stringify(fx.workerRequests.at(-1)?.messages)).toContain(
      "mjrmyr merged pull request mjrmyr/kaeno#12",
    );
    expect((await fx.ticket())?.followed).toEqual([]);
  });
});

it("refuses GitHub deliveries without GitHub's signature and ignores events Kaeno does not act on", async () => {
  await withFixture(async (fx) => {
    expect(
      (
        await fx.postGitHub(
          "pull_request",
          pull("synchronize", "mjrmyr"),
          "d1",
          "x".repeat(40),
        )
      ).status,
    ).toBe(401);
    expect((await fx.post("github", event("e1"))).status).toBe(401);
    for (const [kind, payload] of [
      ["ping", { zen: "Keep it logically awesome." }],
      ["pull_request", pull("labeled", "mjrmyr")],
      ["constructor", pull("opened", "mjrmyr")],
    ] as const) {
      expect((await fx.postGitHub(kind, payload, "d2")).body).toEqual({
        ignored: true,
      });
    }
    expect(await fx.core.router.recentTriggers(context)).toEqual([]);
  });
});

it("loads sources with secrets next to the config and refuses unsafe ones", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-webhooks-"));
  try {
    const config = join(directory, "webhooks.json");
    await writeFile(join(directory, "homelab.secret"), `${SECRET}\n`);
    await writeFile(join(directory, "short.secret"), "short");
    async function load(sources: JsonObject[]) {
      await writeFile(config, JSON.stringify({ port: 8081, sources }));
      return loadWebhooks({ KAENO_WEBHOOKS_CONFIG: config });
    }
    const homelab = {
      name: "homelab",
      kind: "generic",
      secretFile: "homelab.secret",
      trust: "all",
    };

    const loaded = await load([homelab]);
    expect(loaded?.port).toBe(8081);
    expect(loaded?.sources.map((source) => source.name)).toEqual(["homelab"]);
    expect(await loadWebhooks({})).toBeUndefined();

    await expect(
      load([{ ...homelab, secretFile: "short.secret" }]),
    ).rejects.toThrow("at least 32 characters");
    await expect(load([{ ...homelab, name: "telegram" }])).rejects.toThrow(
      "belong to Kaeno's channels",
    );
    await expect(load([homelab, homelab])).rejects.toThrow("unique");
    const github = {
      name: "github",
      kind: "github",
      secretFile: "homelab.secret",
      self: SELF,
      trust: { actors: ["mjrmyr", GITHUB_ACTIONS] },
    };
    expect(
      (await load([homelab, github]))?.sources.map((source) => source.name),
    ).toEqual(["homelab", "github"]);
    await expect(load([{ ...github, name: "gh" }])).rejects.toThrow(
      "workers follow its threads as github:",
    );
    await expect(load([{ ...homelab, self: SELF }])).rejects.toThrow();
    await expect(
      load([
        { name: "homelab", kind: "generic", secretFile: "homelab.secret" },
      ]),
    ).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
