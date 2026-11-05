import { SQLITE_MIGRATIONS } from "@earendil-works/pi-durable/storage/sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFeed, diff } from "../../scripts/inspect/feed.ts";

describe("inspector feed", () => {
  let directory: string;
  let writer: DatabaseSync;
  let reader: DatabaseSync;
  let seq: number;

  function commit(): number {
    seq += 1;
    writer.prepare("UPDATE durable_metadata SET next_seq = ?").run(seq + 1);
    return seq;
  }

  function addDocument(id: number, kind: string, key: string, value: unknown) {
    const at = commit();
    writer
      .prepare(
        "INSERT INTO documents (id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record) VALUES (?, ?, 1, ?, 'session', 0, ?, NULL, '{}')",
      )
      .run(id, JSON.stringify(kind), JSON.stringify(key), at);
    writer
      .prepare(
        "INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES (?, ?, 'base', 1, ?)",
      )
      .run(id, at, JSON.stringify(value));
  }

  function addDelta(id: number, ops: unknown) {
    writer
      .prepare(
        "INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES (?, ?, 'delta', 1, ?)",
      )
      .run(id, commit(), JSON.stringify(ops));
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "kaeno-inspect-"));
    const path = join(directory, "durable.sqlite");
    writer = new DatabaseSync(path);
    writer.exec("PRAGMA journal_mode = WAL");
    for (const migration of SQLITE_MIGRATIONS) {
      for (const statement of migration.statements) {
        writer.exec(statement);
      }
    }
    writer
      .prepare(
        "INSERT OR REPLACE INTO durable_metadata (singleton, next_id, next_seq) VALUES (1, '1', 1)",
      )
      .run();
    seq = 0;
    addDocument(1, "kaeno.router", "", {
      conversation: 9,
      nextTrigger: 1,
      nextTicket: 2,
      open: [],
      queue: [],
      recent: [],
    });
    addDocument(2, "kaeno.thread", "telegram:1/topic:7", {
      key: "telegram:1/topic:7",
      createdAt: 0,
      lastAt: 0,
      subscribers: ["k1"],
      recent: [],
    });
    addDocument(3, "kaeno.ticket", "k1", {
      id: "k1",
      title: "first",
      agent: "mo",
      conversation: 10,
      ownThread: "telegram:1/topic:7",
      status: "queued",
      assignments: [],
      pending: [],
      reports: [],
    });
    reader = new DatabaseSync(path, { readOnly: true });
  });

  afterEach(() => {
    reader.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("replays stored revisions as start-of-inspection history", () => {
    const feed = createFeed(reader);
    feed.poll();
    const events = feed.since(0);

    expect(events.map((event) => event.kind)).toEqual([
      "kaeno.router",
      "kaeno.thread",
      "kaeno.ticket",
    ]);
    expect(events.every((event) => event.observedAt === null)).toBe(true);
    expect(events.every((event) => event.action === "added")).toBe(true);
    expect(feed.snapshot().threads[0]).toMatchObject({
      label: "topic",
      subscribers: ["k1"],
    });
  });

  it("reports a later delta as an observed change with its diff", () => {
    const feed = createFeed(reader);
    feed.poll();
    const after = feed.since(0).at(-1)?.id ?? 0;
    addDelta(3, [["s", ["status"], "running"]]);
    feed.poll();

    const [event] = feed.since(after);
    expect(event).toMatchObject({
      kind: "kaeno.ticket",
      name: "k1",
      action: "changed",
      exact: true,
      summary: "status: queued → running",
      nodes: ["ticket:k1"],
    });
    expect(event?.observedAt).toEqual(expect.any(Number));
    expect(feed.event(event?.id ?? 0)?.changes).toEqual([
      { path: "status", before: "queued", after: "running" },
    ]);
    expect(feed.snapshot().tickets[0]?.status).toBe("running");
  });

  it("notices task status changes and links them to the owning ticket", () => {
    function task(status: string): string {
      return JSON.stringify({
        id: 20,
        kind: "kaeno.work",
        input: { ticket: null },
        state: { status },
      });
    }
    const insertTask = writer.prepare(
      "INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record) VALUES (20, 10, 'kaeno.work', 'running', 0, 1, ?)",
    );
    insertTask.run(task("running"));
    commit();
    const feed = createFeed(reader);
    feed.poll();
    expect(feed.snapshot().tickets[0]?.tasks).toEqual([
      { id: 20, kind: "kaeno.work", status: "running" },
    ]);
    const after = feed.since(0).at(-1)?.id ?? 0;

    writer
      .prepare("UPDATE tasks SET status = 'terminal', record = ? WHERE id = 20")
      .run(task("terminal"));
    commit();
    feed.poll();

    expect(feed.since(after)).toEqual([
      expect.objectContaining({
        group: "task",
        action: "changed",
        exact: false,
        summary: "running → terminal",
        nodes: ["ticket:k1"],
      }),
    ]);
    expect(feed.snapshot().tickets[0]?.tasks).toEqual([]);
  });

  it("skips work when no other connection committed", () => {
    const feed = createFeed(reader);
    feed.poll();
    const count = feed.since(0).length;
    feed.poll();
    expect(feed.since(0)).toHaveLength(count);
  });

  it("diffs nested objects by leaf and arrays as one value", () => {
    expect(
      diff({ a: { b: 1, c: 2 }, d: [1] }, { a: { b: 1, c: 3 }, d: [1, 2] }),
    ).toEqual([
      { path: "a.c", before: 2, after: 3 },
      { path: "d", before: [1], after: [1, 2] },
    ]);
  });
});
