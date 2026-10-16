import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import {
  configure,
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  MemoryStorage,
  type TaskId,
} from "@earendil-works/pi-durable";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  TurnCoordinator,
  defineControl,
  defineTurn,
  TurnLedger,
  type Notify,
  type Source,
} from "./index.ts";

const parseTaskId = (value: number): TaskId => z.custom<TaskId>().parse(value);
async function fixture() {
  const sent: { notify: Notify; text: string }[] = [];
  const Turn = defineTurn(() => ({
    typing: async () => {},
    send: async (notify, text) => {
      sent.push({ notify, text });
    },
  }));
  const Control = defineControl(() => harness);
  const Activity = defineTask<null, { phase: "wait" }, null>({
    name: "test.activity",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (_task, runtime, context) => {
        await runtime.sleep(runtime.now() + 60_000, context);
      },
    },
    abort: async (_task, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      ),
  });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(
    Array.from({ length: 10 }, () =>
      fauxAssistantMessage([fauxText("ANSWER")]),
    ),
  );
  const registry = createRegistry();
  registry.install(
    defineExtension({ name: "turn-tests", tasks: [Turn, Control, Activity] }),
  );
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry },
    ctx,
  );
  const root = await harness.createConversation(
    { ownership: { kind: "ownerless" } },
    ctx,
  );
  const foreign = await harness.createConversation(
    { ownership: { kind: "ownerless" } },
    ctx,
  );
  await harness.commit(
    (tx) =>
      configure(tx, root.id, {
        model: { provider: "faux", modelId: "faux-1" },
      }),
    ctx,
  );
  return {
    harness,
    root,
    foreign,
    sent,
    Turn,
    Control,
    Activity,
    coordinator: new TurnCoordinator(() => harness, Turn, Control),
  };
}

it.each([false, true])(
  "resumes activity notify checkpoints (suppressed=%s)",
  async (suppressed) => {
    const { harness, root, coordinator, sent } = await fixture();
    const source: Source = {
      kind: "activity-result",
      activityId: parseTaskId(123),
      requestId: "origin",
      epoch: 0,
    };
    const Checkpoint = defineTask<
      unknown,
      { phase: "notify"; text: string },
      null
    >({
      name: "kaeno.turn",
      version: 2,
      initial: () => ({ phase: "notify", text: "PERSISTED" }),
      abort: async () => {
        throw new Error("not used");
      },
      phases: {
        notify: async () => {
          throw new Error("registered definition must resume checkpoint");
        },
      },
    });
    const notify = { route: { channel: "test", address: "destination" } };
    try {
      const task = await harness.commit(
        (tx) =>
          tx.createTask(
            Checkpoint,
            {
              conversationId: root.id,
              content: "result",
              requestId: "persisted",
              source,
              notify,
            },
            {
              ownership: { kind: "conversation" },
              conversationId: root.id,
              background: true,
            },
          ),
        ctx,
      );
      if (suppressed) {
        await harness.commit(
          (tx) =>
            coordinator.suppressActivityResults(tx, root.id, [
              parseTaskId(123),
            ]),
          ctx,
        );
      }
      harness.resume();
      await harness.waitForTask(task, ctx);
      expect(sent).toEqual(suppressed ? [] : [{ notify, text: "PERSISTED" }]);
      expect(
        (await coordinator.readReplies(root.id, 0)).replies.map(
          (reply) => reply.source,
        ),
      ).toEqual(suppressed ? [] : [source]);
      expect(
        (await harness.snapshot(TurnLedger, root.id, ctx))?.receipts.persisted
          ?.delivery,
      ).toBe(suppressed ? "cancelled" : "delivered");
    } finally {
      await harness.close(ctx);
    }
  },
);

it("fences stale results and suppresses future results durably", async () => {
  const { harness, root, coordinator, sent } = await fixture();
  const activityId = parseTaskId(234);
  const origin = {
    conversationId: root.id,
    requestId: "origin",
    epoch: 0,
    notify: { route: { channel: "test", address: "captured" } },
  };
  try {
    await harness.commit(async (tx) => {
      await coordinator.admitReset(tx, root.id);
      expect(await coordinator.isOriginFenced(tx, origin)).toBe(true);
      await expect(
        coordinator.admitUserTurn(tx, root.id, "blocked", "blocked"),
      ).rejects.toThrow(/control/);
    }, ctx);
    const admit = (key: string) =>
      harness.commit(
        (tx) =>
          coordinator.admitActivityResult(tx, {
            activityId,
            key,
            content: "result input",
            report: "VERIFIED",
            origin,
            label: "Build",
          }),
        ctx,
      );
    const stale = await admit("stale");
    expect(
      await harness.commit(
        (tx) => coordinator.getPendingActivityIds(tx, root.id),
        ctx,
      ),
    ).toEqual([activityId]);
    harness.resume();
    await harness.waitForTask(stale, ctx);
    expect(sent[0]?.text).toBe("[Build, started before /new]\nVERIFIED");
    await harness.commit(
      (tx) =>
        coordinator.suppressActivityResults(tx, root.id, [
          activityId,
          activityId,
        ]),
      ctx,
    );
    await harness.waitForTask(await admit("suppressed"), ctx);
    expect(sent).toHaveLength(1);
    expect(
      (await harness.snapshot(TurnLedger, root.id, ctx))?.suppressed,
    ).toEqual([activityId]);
    expect((await coordinator.readReplies(root.id, 0)).replies).toHaveLength(1);
  } finally {
    await harness.close(ctx);
  }
});

it("validates native ownership transactionally and cancels a background activity", async () => {
  const { harness, root, foreign, coordinator, Activity } = await fixture();
  try {
    const ids = await harness.commit(async (tx) => {
      const activity = await tx.createTask(Activity, null, {
        ownership: { kind: "conversation" },
        conversationId: root.id,
        background: true,
      });
      const foreignActivity = await tx.createTask(Activity, null, {
        ownership: { kind: "conversation" },
        conversationId: foreign.id,
        background: true,
      });
      const ordinary = await tx.createTask(Activity, null, {
        ownership: { kind: "conversation" },
        conversationId: root.id,
      });
      const turn = await coordinator.admitUserTurn(
        tx,
        root.id,
        "hello",
        "user",
      );
      return { activity, foreignActivity, ordinary, turn };
    }, ctx);
    for (const invalid of [
      ids.foreignActivity,
      ids.ordinary,
      ids.turn,
      parseTaskId(99999),
    ]) {
      await expect(
        harness.commit(
          (tx) => coordinator.admitActivityCancellation(tx, root.id, invalid),
          ctx,
        ),
      ).rejects.toThrow(/not owned/);
    }
    await expect(
      harness.commit(
        (tx) =>
          coordinator.admitActivityCancellation(
            tx,
            root.id,
            ids.activity,
            async () => {
              throw new Error("owner rejected");
            },
          ),
        ctx,
      ),
    ).rejects.toThrow("owner rejected");
    const control = await harness.commit(
      (tx) => coordinator.admitActivityCancellation(tx, root.id, ids.activity),
      ctx,
    );
    expect(
      (await harness.snapshot(TurnLedger, root.id, ctx))?.suppressed,
    ).toContain(ids.activity);
    harness.resume();
    await harness.waitForTask(control, ctx);
    expect(
      (await harness.waitForTask(ids.activity, ctx)).state.outcome.status,
    ).toBe("aborted");
  } finally {
    await harness.close(ctx);
  }
});

it("stop aborts native background activities but not foreign activities or its own control", async () => {
  const { harness, root, foreign, coordinator, Activity } = await fixture();
  try {
    const ids = await harness.commit(async (tx) => {
      const activity = await tx.createTask(Activity, null, {
        ownership: { kind: "conversation" },
        conversationId: root.id,
        background: true,
      });
      const other = await tx.createTask(Activity, null, {
        ownership: { kind: "conversation" },
        conversationId: foreign.id,
        background: true,
      });
      return { activity, other };
    }, ctx);
    const stop = await harness.commit(
      (tx) => coordinator.admitStop(tx, root.id),
      ctx,
    );
    expect(
      (await harness.snapshot(TurnLedger, root.id, ctx))?.suppressed,
    ).toContain(ids.activity);
    expect(
      (await harness.snapshot(TurnLedger, root.id, ctx))?.suppressed,
    ).not.toContain(ids.other);
    harness.resume();
    expect((await harness.waitForTask(stop, ctx)).state.outcome.status).toBe(
      "completed",
    );
    expect(
      (await harness.waitForTask(ids.activity, ctx)).state.outcome.status,
    ).toBe("aborted");
    expect((await harness.getTask(ids.other, ctx))?.abortRequested).toBe(false);
    expect(
      (await harness.snapshot(TurnLedger, root.id, ctx))?.control,
    ).toBeUndefined();
  } finally {
    await harness.close(ctx);
  }
});

it("delivers results after their origin using the captured route", async () => {
  const { harness, root, coordinator, sent } = await fixture();
  const notify = { route: { channel: "test", address: "captured" } };
  try {
    const user = await harness.commit(
      (tx) => coordinator.admitUserTurn(tx, root.id, "start", "user", notify),
      ctx,
    );
    const result = await harness.commit(
      (tx) =>
        coordinator.admitActivityResult(tx, {
          activityId: parseTaskId(345),
          key: "current",
          content: "result",
          report: "fallback",
          origin: {
            conversationId: root.id,
            requestId: "user",
            epoch: 0,
            notify,
          },
        }),
      ctx,
    );
    harness.resume();
    await harness.waitForTask(result, ctx);
    await harness.waitForTask(user, ctx);
    expect(
      (await coordinator.readReplies(root.id, 0)).replies.map(
        (reply) => reply.requestId,
      ),
    ).toEqual(["user", "activity-result:current"]);
    expect(sent).toEqual([
      { notify, text: "ANSWER" },
      { notify, text: "ANSWER" },
    ]);
  } finally {
    await harness.close(ctx);
  }
});

it("binds request IDs to all result provenance", async () => {
  const { harness, root, coordinator } = await fixture();
  const result = {
    activityId: parseTaskId(345),
    key: "bound",
    content: "result",
    report: "fallback",
    origin: {
      conversationId: root.id,
      requestId: "user",
      epoch: 0,
      notify: {},
    },
  };
  try {
    const id = await harness.commit(
      (tx) => coordinator.admitActivityResult(tx, result),
      ctx,
    );
    expect(
      await harness.commit(
        (tx) => coordinator.admitActivityResult(tx, result),
        ctx,
      ),
    ).toBe(id);
    for (const changed of [
      { ...result, activityId: parseTaskId(346) },
      { ...result, origin: { ...result.origin, requestId: "different" } },
      { ...result, origin: { ...result.origin, epoch: 1 } },
      { ...result, label: "different" },
    ]) {
      await expect(
        harness.commit(
          (tx) => coordinator.admitActivityResult(tx, changed),
          ctx,
        ),
      ).rejects.toThrow(/provenance/);
    }
  } finally {
    await harness.close(ctx);
  }
});
