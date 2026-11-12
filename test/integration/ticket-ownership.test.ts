import type { Tx } from "@earendil-works/pi-durable";
import { expect, it, vi } from "vitest";
import { parseConversationId } from "../../src/core/durable/index.ts";
import { WorkScope } from "../../src/core/work/index.ts";
import { Engine, TicketRef } from "../../src/core/router/index.ts";

function fixture() {
  const refs = new Map<number, string>();
  const works = new Map<number, number>();
  const tasks = new Map<number, object>();
  const tx: Tx = Object.assign(Object.create(null), {
    doc: vi.fn<(doc: unknown, id: number) => Promise<object>>(
      async (doc, id) => {
        if (doc === TicketRef) {
          return { ticket: refs.get(id) ?? null };
        }
        if (doc === WorkScope) {
          return { workId: works.get(id) ?? null };
        }
        throw new Error("Unexpected document");
      },
    ),
    task: vi.fn<(id: number) => Promise<object | undefined>>(async (id) =>
      tasks.get(id),
    ),
  });
  const engine: Engine = Object.create(Engine.prototype);
  function resolve(id: number) {
    return engine.ticketOfConversation(tx, parseConversationId(id));
  }
  function work(id: number, parent: object) {
    works.set(id, id);
    tasks.set(id, { input: { parent }, state: { status: "terminal" } });
  }
  return { refs, works, tasks, tx, engine, resolve, work };
}

it("prefers direct ticket ownership over WORK ancestry", async () => {
  const fixtureState = fixture();
  fixtureState.refs.set(1, "k1");
  fixtureState.work(1, { kind: "ticket", ticket: "k2" });
  expect(await fixtureState.resolve(1)).toBe("k1");
  expect(fixtureState.tx.task).not.toHaveBeenCalled();
});

it("resolves ended nested WORK without direct refs", async () => {
  const fixtureState = fixture();
  fixtureState.work(3, { kind: "work", conversationId: 2 });
  fixtureState.work(2, { kind: "work", conversationId: 1 });
  fixtureState.work(1, { kind: "ticket", ticket: "k7" });
  expect(await fixtureState.resolve(3)).toBe("k7");
  fixtureState.refs.set(1, "k8");
  expect(await fixtureState.resolve(3)).toBe("k8");
});

it("leaves standalone and missing WORK records unowned", async () => {
  const fixtureState = fixture();
  expect(await fixtureState.resolve(1)).toBeUndefined();
  fixtureState.work(2, { kind: "work", conversationId: 1 });
  expect(await fixtureState.resolve(2)).toBeUndefined();
  fixtureState.tasks.clear();
  expect(await fixtureState.resolve(2)).toBeUndefined();
});

it("terminates self and multi-conversation ancestry cycles", async () => {
  const fixtureState = fixture();
  fixtureState.work(1, { kind: "work", conversationId: 1 });
  expect(await fixtureState.resolve(1)).toBeUndefined();
  fixtureState.work(1, { kind: "work", conversationId: 2 });
  fixtureState.work(2, { kind: "work", conversationId: 1 });
  expect(await fixtureState.resolve(1)).toBeUndefined();
});

it("follows threads through the same transactional ancestry", async () => {
  const fixtureState = fixture();
  fixtureState.work(2, { kind: "work", conversationId: 1 });
  fixtureState.work(1, { kind: "ticket", ticket: "k7" });
  const follow = vi
    .spyOn(fixtureState.engine, "follow")
    .mockResolvedValue(undefined);
  expect(
    await fixtureState.engine.followConversation(
      fixtureState.tx,
      parseConversationId(2),
      "pr:7",
    ),
  ).toBe(true);
  expect(follow).toHaveBeenCalledExactlyOnceWith(fixtureState.tx, "k7", "pr:7");
  expect(
    await fixtureState.engine.followConversation(
      fixtureState.tx,
      parseConversationId(3),
      "pr:8",
    ),
  ).toBe(false);
  expect(follow).toHaveBeenCalledTimes(1);
});
