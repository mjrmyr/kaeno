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
  normalizeNotify,
  TurnLedger,
  type Notify,
  type Source,
} from "./index.ts";

const taskId = z.custom<TaskId>(
  (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0,
);
const parseTaskId = (value: number): TaskId => taskId.parse(value);

async function fixture() {
  const sent: { notify: Notify; text: string }[] = [];
  const cancelled: (TaskId | undefined)[] = [];
  const Turn = defineTurn(() => ({
    typing: async () => {},
    send: async (notify, text) => {
      sent.push({ notify, text });
    },
  }));
  const Control = defineControl(
    () => harness,
    async (_id, activityId) => {
      cancelled.push(activityId);
    },
  );
  const Work = defineTask<null, { phase: "done" }, null>({
    name: "kaeno.work",
    version: 1,
    initial: () => ({ phase: "done" }),
    abort: async (_task, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      ),
    phases: {
      done: async (_task, runtime, context) => {
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
          }),
          context,
        );
      },
    },
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
    defineExtension({ name: "turn-tests", tasks: [Turn, Control, Work] }),
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
  const coordinator = new TurnCoordinator(() => harness, Turn, Control);
  return {
    harness,
    root,
    foreign,
    coordinator,
    sent,
    cancelled,
    Turn,
    Control,
    Work,
  };
}

it("normalizes legacy routes without mutating them or overriding explicit routes", () => {
  const legacy = { telegram: 123 };
  expect(normalizeNotify(legacy)).toEqual({
    telegram: 123,
    route: { channel: "telegram", address: "123" },
  });
  expect(legacy).toEqual({ telegram: 123 });
  const explicit = {
    telegram: 123,
    route: { channel: "other", address: "dest" },
  };
  expect(normalizeNotify(explicit)).toBe(explicit);
});

it.each([
  { kind: "work-result", suppressed: false },
  { kind: "activity-result", suppressed: false },
  { kind: "work-result", suppressed: true },
  { kind: "activity-result", suppressed: true },
])(
  "resumes persisted $kind notify checkpoints (suppressed=$suppressed)",
  async ({ kind, suppressed }) => {
    const setup = await fixture();
    const { harness, root, coordinator, sent } = setup;
    const source: Source =
      kind === "work-result"
        ? {
            kind: "work-result",
            workId: parseTaskId(123),
            requestId: "origin",
            epoch: 0,
          }
        : {
            kind: "activity-result",
            activityId: parseTaskId(123),
            requestId: "origin",
            epoch: 0,
          };
    const Legacy = defineTask<unknown, { phase: "notify"; text: string }, null>(
      {
        name: "kaeno.turn",
        version: 1,
        initial: () => ({ phase: "notify", text: "PERSISTED" }),
        abort: async () => {
          throw new Error("not used");
        },
        phases: {
          notify: async () => {
            throw new Error(
              "registered definition must resume this checkpoint",
            );
          },
        },
      },
    );
    const notify: Notify =
      kind === "work-result"
        ? { telegram: 111 }
        : { route: { channel: "test", address: "destination" } };
    try {
      const task = await harness.commit(
        (tx) =>
          tx.createTask(
            Legacy,
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
      expect(sent).toEqual(
        suppressed
          ? []
          : [{ notify: normalizeNotify(notify), text: "PERSISTED" }],
      );
      const replies = (await coordinator.readReplies(root.id, 0)).replies;
      expect(replies.map((reply) => reply.source)).toEqual(
        suppressed ? [] : [source],
      );
      expect(
        (await harness.snapshot(TurnLedger, root.id, ctx))?.receipts.persisted
          ?.delivery,
      ).toBe(suppressed ? "cancelled" : "delivered");
    } finally {
      await harness.close(ctx);
    }
  },
);

it.each(["work-result", "activity-result"])(
  "fences stale %s results and suppresses future results durably",
  async (kind) => {
    const { harness, root, coordinator, sent } = await fixture();
    const activityId = parseTaskId(234);
    const origin = {
      conversationId: root.id,
      requestId: "origin",
      epoch: 0,
      notify: { telegram: 111 },
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
            kind === "work-result"
              ? coordinator.admitWorkReport(tx, {
                  workId: activityId,
                  key,
                  content: "result input",
                  report: "VERIFIED",
                  origin,
                })
              : coordinator.admitActivityResult(tx, {
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
      expect(
        await harness.commit(
          (tx) => coordinator.getPendingReportIds(tx, root.id),
          ctx,
        ),
      ).toEqual(kind === "work-result" ? [activityId] : []);
      harness.resume();
      await harness.waitForTask(stale, ctx);
      expect(sent[0]?.text).toBe(
        kind === "work-result"
          ? "[Work #234, started before /new]\nVERIFIED"
          : "[Build, started before /new]\nVERIFIED",
      );
      await harness.commit(
        (tx) =>
          coordinator.suppressActivityResults(tx, root.id, [
            activityId,
            activityId,
          ]),
        ctx,
      );
      const suppressed = await admit("suppressed");
      await harness.waitForTask(suppressed, ctx);
      expect(sent).toHaveLength(1);
      expect(
        (await harness.snapshot(TurnLedger, root.id, ctx))?.suppressed,
      ).toEqual([activityId]);
      expect((await coordinator.readReplies(root.id, 0)).replies).toHaveLength(
        1,
      );
    } finally {
      await harness.close(ctx);
    }
  },
);

it("preserves work-only legacy cancellation and validates generic cancellation transactionally", async () => {
  const { harness, root, foreign, coordinator, Work, cancelled } =
    await fixture();
  try {
    const ids = await harness.commit(async (tx) => {
      const work = await tx.createTask(Work, null, {
        ownership: { kind: "conversation" },
        conversationId: root.id,
        background: true,
      });
      const foreignWork = await tx.createTask(Work, null, {
        ownership: { kind: "conversation" },
        conversationId: foreign.id,
        background: true,
      });
      const turn = await coordinator.admitUserTurn(
        tx,
        root.id,
        "hello",
        "user",
      );
      return { work, foreignWork, turn };
    }, ctx);
    for (const invalid of [ids.foreignWork, ids.turn, parseTaskId(99999)]) {
      await expect(
        harness.commit(
          (tx) => coordinator.admitWorkCancellation(tx, root.id, invalid),
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
            ids.work,
            async () => {
              throw new Error("owner rejected");
            },
          ),
        ctx,
      ),
    ).rejects.toThrow("owner rejected");
    const control = await harness.commit(
      (tx) =>
        coordinator.admitActivityCancellation(
          tx,
          root.id,
          ids.turn,
          async (validationTx, conversationId, subject) => {
            const record = await validationTx.task(subject);
            if (
              record?.kind !== "kaeno.turn" ||
              record.conversationId !== conversationId
            ) {
              throw new Error("invalid subject");
            }
          },
        ),
      ctx,
    );
    const legacy = await harness.commit(
      (tx) => coordinator.admitWorkCancellation(tx, root.id, ids.work),
      ctx,
    );
    harness.resume();
    await harness.waitForTask(control, ctx);
    await harness.waitForTask(legacy, ctx);
    expect(cancelled).toEqual(expect.arrayContaining([ids.turn, ids.work]));
  } finally {
    await harness.close(ctx);
  }
});

it.each(["work-result", "activity-result"])(
  "delivers current %s only after its origin reply using the captured route",
  async (kind) => {
    const { harness, root, coordinator, sent } = await fixture();
    const notify = { route: { channel: "test", address: "captured" } };
    const activityId = parseTaskId(345);
    const origin = {
      conversationId: root.id,
      requestId: "user",
      epoch: 0,
      notify,
    };
    try {
      const user = await harness.commit(
        (tx) => coordinator.admitUserTurn(tx, root.id, "start", "user", notify),
        ctx,
      );
      const result = await harness.commit(
        (tx) =>
          kind === "work-result"
            ? coordinator.admitWorkReport(tx, {
                workId: activityId,
                key: "current",
                content: "result",
                report: "fallback",
                origin,
              })
            : coordinator.admitActivityResult(tx, {
                activityId,
                key: "current",
                content: "result",
                report: "fallback",
                origin,
              }),
        ctx,
      );
      harness.resume();
      await harness.waitForTask(result, ctx);
      await harness.waitForTask(user, ctx);
      const replies = (await coordinator.readReplies(root.id, 0)).replies;
      expect(replies.map((reply) => reply.requestId)).toEqual([
        "user",
        kind === "work-result"
          ? "work-report:current"
          : "activity-result:current",
      ]);
      expect(replies[1]?.source.kind).toBe(kind);
      expect(sent).toEqual([
        { notify, text: "ANSWER" },
        { notify, text: "ANSWER" },
      ]);
    } finally {
      await harness.close(ctx);
    }
  },
);

it("uses an injected work-owner validator instead of the legacy fallback", async () => {
  const { harness, root, Turn, Control } = await fixture();
  let validated = false;
  const coordinator = new TurnCoordinator(
    () => harness,
    Turn,
    Control,
    async (_tx, conversationId, activityId) => {
      expect(conversationId).toBe(root.id);
      expect(activityId).toBe(parseTaskId(456));
      validated = true;
      throw new Error("work owner refused");
    },
  );
  try {
    await expect(
      harness.commit(
        (tx) =>
          coordinator.admitWorkCancellation(tx, root.id, parseTaskId(456)),
        ctx,
      ),
    ).rejects.toThrow("work owner refused");
    expect(validated).toBe(true);
    expect(
      (await harness.snapshot(TurnLedger, root.id, ctx))?.control,
    ).toBeUndefined();
  } finally {
    await harness.close(ctx);
  }
});
