import { apply, type JsonValue, type Op } from "@earendil-works/chord/delta";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

export type Group =
  "record" | "internal" | "task" | "submission" | "entry" | "conversation";

export interface FeedEvent {
  id: number;
  seq: number;
  exact: boolean;
  observedAt: number | null;
  recordedAt: number | null;
  group: Group;
  action: "added" | "changed" | "snapshot" | "retired";
  kind: string;
  name: string;
  summary: string;
  nodes: string[];
}

export interface Change {
  path: string;
  before: unknown;
  after: unknown;
}

export interface EventDetail extends FeedEvent {
  before: unknown;
  after: unknown;
  changes: Change[];
}

interface Draft {
  seq: number;
  exact: boolean;
  recordedAt: number | null;
  group: Group;
  action: FeedEvent["action"];
  kind: string;
  name: string;
  summary: string;
  before: unknown;
  after: unknown;
  owner: number | null;
  nodes: string[];
}

const DocumentRow = z.object({
  id: z.number(),
  kind: z.string(),
  key_value: z.string(),
  scope_kind: z.string(),
  owner_id: z.number(),
  created_at: z.number(),
  retired_at: z.number().nullable(),
});
type DocumentRow = z.infer<typeof DocumentRow>;

const RevisionRow = z.object({
  id: z.number(),
  seq: z.number(),
  revision: z.enum(["base", "delta"]),
  content: z.string(),
});

const StatefulRow = z.object({
  id: z.number(),
  conversation_id: z.number(),
  record: z.string(),
});
type StatefulRow = z.infer<typeof StatefulRow>;

const EntryRow = StatefulRow.extend({ commit_seq: z.number() });
const AnchorRow = z.object({ id: z.number(), seq: z.number() });
const IdRow = z.object({ id: z.number() });
const HeadRow = z.object({ next: z.number() });
const VersionRow = z.object({ data_version: z.number() });

const Label = z.string().optional().catch(undefined);
const Time = z.number().optional().catch(undefined);

const TaskRecord = z.looseObject({
  kind: z.string().catch("unknown"),
  input: z
    .looseObject({ title: Label, ticket: Label })
    .optional()
    .catch(undefined),
  abortRequested: z.boolean().optional().catch(undefined),
  state: z
    .looseObject({
      status: Label,
      outcome: z.looseObject({ status: Label }).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  startedAt: Time,
  endedAt: Time,
});
type TaskRecord = z.infer<typeof TaskRecord>;

const SubmissionRecord = z.looseObject({ type: Label, status: Label });

const EntryRecord = z.looseObject({
  kind: Label,
  model: z
    .array(
      z.looseObject({
        role: Label,
        toolName: Label,
        timestamp: Time,
        content: z
          .union([
            z.string(),
            z.array(z.looseObject({ text: Label, name: Label })),
          ])
          .optional()
          .catch(undefined),
      }),
    )
    .optional()
    .catch(undefined),
});
type EntryRecord = z.infer<typeof EntryRecord>;

const RouterValue = z.looseObject({
  conversation: z.number().nullable(),
  open: z.array(z.string()),
  queue: z.array(z.string()),
  recent: z.array(z.string()),
});
const ThreadValue = z.looseObject({
  subscribers: z.array(z.string()),
  recent: z.array(z.string()),
});
const TicketValue = z.looseObject({
  title: z.string(),
  agent: z.string(),
  conversation: z.number(),
  status: z.string(),
  ownThread: z.string().nullable(),
  assignments: z.array(z.unknown()),
  pending: z.array(z.unknown()),
  reports: z.array(z.looseObject({ state: z.string() })),
});
const TriggerValue = z.looseObject({
  threads: z.array(z.string()).optional(),
});
const StoredValue = z.custom<JsonValue>();
const StoredOps = z.custom<Op[]>();
const Name = z.string();

interface ActiveTask {
  id: number;
  kind: string;
  status: string;
}

export interface Snapshot {
  router: {
    node: string;
    conversation: number | null;
    open: string[];
    queue: string[];
    recent: number;
    tasks: ActiveTask[];
    touched: number;
  };
  threads: {
    node: string;
    key: string;
    label: string;
    subscribers: string[];
    recent: number;
    touched: number;
  }[];
  tickets: {
    node: string;
    id: string;
    title: string;
    agent: string;
    status: string;
    ownThread: string | null;
    pending: number;
    assignments: number;
    report: string | null;
    tasks: ActiveTask[];
    touched: number;
  }[];
}

export interface Feed {
  poll(): void;
  snapshot(): Snapshot;
  since(after: number): FeedEvent[];
  event(id: number): EventDetail | undefined;
}

const MAX_EVENTS = 5000;
const SNIPPET = 80;

function clip(value: string, length = SNIPPET): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function diff(before: unknown, after: unknown, path = ""): Change[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) =>
      diff(before[key], after[key], path ? `${path}.${key}` : key),
    );
  }
  return JSON.stringify(before) === JSON.stringify(after)
    ? []
    : [{ path, before, after }];
}

function brief(value: unknown): string {
  if (value === undefined) {
    return "∅";
  }
  if (typeof value === "string") {
    return clip(value, 32);
  }
  return Array.isArray(value)
    ? `[${value.length}]`
    : clip(JSON.stringify(value), 32);
}

function describeChanges(changes: Change[]): string {
  if (changes.length === 0) {
    return "no content change";
  }
  const shown = changes.slice(0, 3).map(({ path, before, after }) => {
    if (Array.isArray(before) && Array.isArray(after)) {
      const delta = after.length - before.length;
      return `${path} ${delta >= 0 ? "+" : ""}${delta}`;
    }
    return `${path}: ${brief(before)} → ${brief(after)}`;
  });
  const hidden = changes.length - shown.length;
  return hidden > 0
    ? `${shown.join(" · ")} · +${hidden} more`
    : shown.join(" · ");
}

function describeRevision(
  created: boolean,
  known: boolean,
  before: unknown,
  after: unknown,
): { action: FeedEvent["action"]; summary: string } {
  if (created) {
    return { action: "added", summary: "created" };
  }
  if (known) {
    return { action: "changed", summary: describeChanges(diff(before, after)) };
  }
  return {
    action: "snapshot",
    summary: "snapshot, earlier revisions compacted away",
  };
}

function threadLabel(key: string): string {
  if (key.includes("/topic:")) {
    return "topic";
  }
  if (key.includes("/reply:")) {
    return "reply chain";
  }
  return key.startsWith("telegram:") ? "main chat" : "http";
}

function describeTask(task: TaskRecord): string {
  const status = task.state?.status ?? "unknown";
  const outcome = task.state?.outcome?.status;
  const label = task.input?.title ?? task.input?.ticket;
  return [
    outcome ? `${status} (${outcome})` : status,
    task.abortRequested ? "abort requested" : "",
    label ? clip(label, 48) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function describeEntry(entry: EntryRecord): string {
  const message = entry.model?.[0];
  if (!message) {
    return entry.kind ?? "entry";
  }
  const parts =
    typeof message.content === "string"
      ? [message.content]
      : (message.content ?? []).map((part) => part.text ?? part.name ?? "");
  return [message.role, message.toolName, clip(parts.join(" "))]
    .filter(Boolean)
    .join(" · ");
}

export function createFeed(
  db: DatabaseSync,
  now: () => number = Date.now,
): Feed {
  const dataVersion = db.prepare("PRAGMA data_version");
  const selectDocuments = db.prepare(
    "SELECT id, kind, key_value, scope_kind, owner_id, created_at, retired_at FROM documents",
  );
  const selectRevisions = db.prepare(
    "SELECT document_id AS id, seq, kind AS revision, content FROM document_revisions WHERE seq > ? ORDER BY seq, document_id",
  );
  const selectTasks = db.prepare(
    "SELECT id, conversation_id, record FROM tasks ORDER BY id",
  );
  const selectSubmissions = db.prepare(
    "SELECT id, conversation_id, record FROM submissions ORDER BY id",
  );
  const selectEntries = db.prepare(
    "SELECT id, conversation_id, commit_seq, record FROM entries WHERE id > ? ORDER BY id",
  );
  const selectConversations = db.prepare(
    "SELECT id FROM conversations WHERE id > ? ORDER BY id",
  );
  const selectHead = db.prepare(
    "SELECT next_seq AS next FROM durable_metadata",
  );

  const documents = new Map<number, DocumentRow>();
  const values = new Map<number, unknown>();
  const retired = new Set<number>();
  const tasks = new Map<number, { row: StatefulRow; record: TaskRecord }>();
  const submissions = new Map<number, string>();
  const anchors: { id: number; seq: number }[] = [];
  const touched = new Map<string, number>();
  const events: EventDetail[] = [];
  const drafts: Draft[] = [];
  let lastSeq = 0;
  let lastEntry = 0;
  let lastConversation = 0;
  let lastVersion: unknown;
  let nextEvent = 1;
  let started = false;

  function documentsOfKind<T>(
    kind: string,
    schema: z.ZodType<T>,
  ): { key: string; value: T }[] {
    const found: { key: string; value: T }[] = [];
    for (const [id, document] of documents) {
      if (
        Name.parse(JSON.parse(document.kind)) === kind &&
        values.has(id) &&
        !retired.has(id)
      ) {
        found.push({
          key: Name.parse(JSON.parse(document.key_value)),
          value: schema.parse(values.get(id)),
        });
      }
    }
    return found;
  }

  function nodeOfConversation(conversation: number | null): string[] {
    if (conversation === null) {
      return [];
    }
    const [router] = documentsOfKind("kaeno.router", RouterValue);
    if (router?.value.conversation === conversation) {
      return ["router"];
    }
    return documentsOfKind("kaeno.ticket", TicketValue)
      .filter(({ value }) => value.conversation === conversation)
      .map(({ key }) => `ticket:${key}`);
  }

  function nodesOfDocument(
    kind: string,
    key: string,
    value: unknown,
  ): string[] {
    switch (kind) {
      case "kaeno.router":
        return ["router"];
      case "kaeno.thread":
      case "kaeno.outbox":
        return [`thread:${key}`];
      case "kaeno.ticket":
        return [`ticket:${key}`];
      case "kaeno.trigger":
        return (TriggerValue.optional().parse(value)?.threads ?? []).map(
          (thread) => `thread:${thread}`,
        );
      default:
        return [];
    }
  }

  function readDocuments(): void {
    for (const row of z.array(DocumentRow).parse(selectDocuments.all())) {
      documents.set(row.id, row);
    }
    const revisions = z.array(RevisionRow).parse(selectRevisions.all(lastSeq));
    for (const revision of revisions) {
      lastSeq = revision.seq;
      const document = documents.get(revision.id);
      if (!document) {
        continue;
      }
      const known = values.has(revision.id);
      const before = values.get(revision.id);
      const content: unknown = JSON.parse(revision.content);
      const after =
        revision.revision === "base"
          ? content
          : apply(
              StoredValue.parse(structuredClone(before)),
              StoredOps.parse(content),
            );
      values.set(revision.id, after);
      const kind = Name.parse(JSON.parse(document.kind));
      const key = Name.parse(JSON.parse(document.key_value));
      const created = revision.seq === document.created_at;
      drafts.push({
        seq: revision.seq,
        exact: true,
        recordedAt: null,
        group: kind.startsWith("pi.") ? "internal" : "record",
        ...describeRevision(created, known, before, after),
        kind,
        name: key,
        before: known ? before : undefined,
        after,
        owner: document.scope_kind === "session" ? null : document.owner_id,
        nodes: nodesOfDocument(kind, key, after),
      });
    }
    for (const [id, document] of documents) {
      if (document.retired_at !== null && !retired.has(id)) {
        retired.add(id);
        const kind = Name.parse(JSON.parse(document.kind));
        const key = Name.parse(JSON.parse(document.key_value));
        drafts.push({
          seq: document.retired_at,
          exact: true,
          recordedAt: null,
          group: kind.startsWith("pi.") ? "internal" : "record",
          action: "retired",
          kind,
          name: key,
          summary: "retired",
          before: values.get(id),
          after: undefined,
          owner: document.scope_kind === "session" ? null : document.owner_id,
          nodes: nodesOfDocument(kind, key, values.get(id)),
        });
      }
    }
  }

  function estimateSeq(id: number, head: number): number {
    if (started) {
      return head;
    }
    let seq = 0;
    for (const anchor of anchors) {
      if (anchor.id > id) {
        break;
      }
      seq = Math.max(seq, anchor.seq);
    }
    return seq;
  }

  function readEntries(): void {
    const rows = z.array(EntryRow).parse(selectEntries.all(lastEntry));
    for (const row of rows) {
      lastEntry = row.id;
      const entry = EntryRecord.parse(JSON.parse(row.record));
      drafts.push({
        seq: row.commit_seq,
        exact: true,
        recordedAt: entry.model?.[0]?.timestamp ?? null,
        group: "entry",
        action: "added",
        kind: entry.kind ?? "entry",
        name: `#${row.id}`,
        summary: describeEntry(entry),
        before: undefined,
        after: entry,
        owner: row.conversation_id,
        nodes: [],
      });
    }
  }

  function readConversations(head: number): void {
    const rows = z
      .array(IdRow)
      .parse(selectConversations.all(lastConversation));
    for (const { id } of rows) {
      lastConversation = id;
      drafts.push({
        seq: estimateSeq(id, head),
        exact: false,
        recordedAt: null,
        group: "conversation",
        action: "added",
        kind: "conversation",
        name: `#${id}`,
        summary: "created",
        before: undefined,
        after: { id },
        owner: id,
        nodes: [],
      });
    }
  }

  function readTasks(head: number): void {
    for (const row of z.array(StatefulRow).parse(selectTasks.all())) {
      const previous = tasks.get(row.id);
      if (previous?.row.record === row.record) {
        continue;
      }
      const record = TaskRecord.parse(JSON.parse(row.record));
      tasks.set(row.id, { row, record });
      drafts.push({
        seq: estimateSeq(row.id, head),
        exact: false,
        recordedAt: record.endedAt ?? record.startedAt ?? null,
        group: "task",
        action: previous ? "changed" : "added",
        kind: record.kind,
        name: `#${row.id}`,
        summary: previous
          ? `${describeTask(previous.record)} → ${describeTask(record)}`
          : describeTask(record),
        before: previous?.record,
        after: record,
        owner: row.conversation_id,
        nodes: [],
      });
    }
  }

  function readSubmissions(head: number): void {
    for (const row of z.array(StatefulRow).parse(selectSubmissions.all())) {
      const previous = submissions.get(row.id);
      if (previous === row.record) {
        continue;
      }
      submissions.set(row.id, row.record);
      const record = SubmissionRecord.parse(JSON.parse(row.record));
      const before = previous
        ? SubmissionRecord.parse(JSON.parse(previous))
        : undefined;
      drafts.push({
        seq: estimateSeq(row.id, head),
        exact: false,
        recordedAt: null,
        group: "submission",
        action: before ? "changed" : "added",
        kind: record.type ?? "submission",
        name: `#${row.id}`,
        summary: before
          ? `${before.status} → ${record.status}`
          : (record.status ?? "unknown"),
        before,
        after: record,
        owner: row.conversation_id,
        nodes: [],
      });
    }
  }

  function loadAnchors(): void {
    for (const document of documents.values()) {
      anchors.push({ id: document.id, seq: document.created_at });
    }
    for (const entry of z
      .array(AnchorRow)
      .parse(db.prepare("SELECT id, commit_seq AS seq FROM entries").all())) {
      anchors.push(entry);
    }
    anchors.sort((left, right) => left.id - right.id);
  }

  function publish(): void {
    const observedAt = started ? now() : null;
    drafts.sort((left, right) => left.seq - right.seq);
    for (const { owner, ...draft } of drafts.splice(0)) {
      const nodes = [...draft.nodes, ...nodeOfConversation(owner)];
      const event: EventDetail = {
        ...draft,
        id: nextEvent++,
        observedAt,
        nodes,
        changes:
          draft.action === "changed" ? diff(draft.before, draft.after) : [],
      };
      events.push(event);
      for (const node of nodes) {
        touched.set(node, event.id);
      }
    }
    events.splice(0, Math.max(0, events.length - MAX_EVENTS));
  }

  function poll(): void {
    const version = VersionRow.parse(dataVersion.get()).data_version;
    if (started && version === lastVersion) {
      return;
    }
    lastVersion = version;
    db.exec("BEGIN");
    try {
      const head = HeadRow.parse(selectHead.get()).next - 1;
      readDocuments();
      if (!started) {
        loadAnchors();
      }
      readEntries();
      readConversations(head);
      readTasks(head);
      readSubmissions(head);
      lastSeq = head;
    } finally {
      db.exec("COMMIT");
    }
    publish();
    started = true;
  }

  function activeTasks(conversation: number | null): ActiveTask[] {
    const active: ActiveTask[] = [];
    for (const { row, record } of tasks.values()) {
      const status = record.state?.status ?? "unknown";
      if (row.conversation_id === conversation && status !== "terminal") {
        active.push({ id: row.id, kind: record.kind, status });
      }
    }
    return active;
  }

  function snapshot(): Snapshot {
    const [router] = documentsOfKind("kaeno.router", RouterValue);
    const conversation = router?.value.conversation ?? null;
    return {
      router: {
        node: "router",
        conversation,
        open: router?.value.open ?? [],
        queue: router?.value.queue ?? [],
        recent: router?.value.recent.length ?? 0,
        tasks: activeTasks(conversation),
        touched: touched.get("router") ?? 0,
      },
      threads: documentsOfKind("kaeno.thread", ThreadValue).map(
        ({ key, value }) => ({
          node: `thread:${key}`,
          key,
          label: threadLabel(key),
          subscribers: value.subscribers,
          recent: value.recent.length,
          touched: touched.get(`thread:${key}`) ?? 0,
        }),
      ),
      tickets: documentsOfKind("kaeno.ticket", TicketValue).map(
        ({ key, value }) => ({
          node: `ticket:${key}`,
          id: key,
          title: value.title,
          agent: value.agent,
          status: value.status,
          ownThread: value.ownThread,
          pending: value.pending.length,
          assignments: value.assignments.length,
          report: value.reports.at(-1)?.state ?? null,
          tasks: activeTasks(value.conversation),
          touched: touched.get(`ticket:${key}`) ?? 0,
        }),
      ),
    };
  }

  function since(after: number): FeedEvent[] {
    return events
      .filter((event) => event.id > after)
      .map(
        ({ before: _before, after: _after, changes: _changes, ...event }) =>
          event,
      );
  }

  function event(id: number): EventDetail | undefined {
    return events.find((candidate) => candidate.id === id);
  }

  return { poll, snapshot, since, event };
}
