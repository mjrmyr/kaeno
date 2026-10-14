import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  watchEvents,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ApiServer,
  type ApiThreads,
  type ApiTurns,
  type ConversationEvents,
} from "../../src/api/index.ts";
import { ArtifactStore } from "../../src/artifacts/index.ts";
import {
  Work,
  WorkIndex,
  WorkScope,
  type WorkAgents,
  type WorkResult,
  type WorkTurns,
} from "../../src/work/index.ts";
import { taskId } from "../mocks/identifiers.ts";
import { readObject, serverPort } from "./values.ts";

const token = "x".repeat(32);

async function unexpected(): Promise<never> {
  throw new Error("Unexpected operation in fixture");
}

let harness: Harness;
let api: ApiServer["server"];
let dir: string;
const conversations = new Map<string, ConversationId>();

async function conversation(key: string): Promise<ConversationId> {
  const existing = conversations.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const created = await harness.commit(
    (tx) => tx.createConversation({ ownership: { kind: "ownerless" } }),
    ctx,
  );
  conversations.set(key, created.id);
  return created.id;
}

async function scopedConversation(
  key: string,
  workIdValue: number,
  children: number[] = [],
): Promise<ConversationId> {
  const id = await conversation(key);
  await harness.commit(async (tx) => {
    const scope = await tx.doc(WorkScope, id);
    scope.depth = 1;
    scope.workId = taskId(workIdValue);
    const index = await tx.doc(WorkIndex, id);
    index.launches = Object.fromEntries(
      children.map((child, position) => [
        `call-${position}`,
        taskId<WorkResult>(child),
      ]),
    );
  }, ctx);
  return id;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "kaeno-artifacts-api-"));
  harness = await Harness.open(
    await openNodeSqliteStorage(join(dir, "state.sqlite")),
    { models: createModels(), registry: createRegistry() },
    ctx,
  );
  const store = new ArtifactStore(join(dir, "artifacts"));
  const handle = await store.createRun(
    { workId: 5, taskId: 5 },
    { conversationId: 1, pod: "pod-1", template: "swe" },
  );
  await handle.write("workspace/a.txt", "hello");
  await handle.write("workspace/raw.bin", new Uint8Array([0, 255, 1]));
  await handle.finish();

  const turns: WorkTurns = {
    getActiveTurn: unexpected,
    isOriginFenced: unexpected,
    getPendingReportIds: unexpected,
    suppressWorkReports: unexpected,
    admitWorkReport: unexpected,
    admitWorkCancellation: unexpected,
  };
  const agents: WorkAgents = {
    captureWorkBlueprint: () => {
      throw new Error("Unexpected blueprint capture");
    },
    configureWorkConversation: unexpected,
    provisionWorkSandbox: unexpected,
    releaseWorkSandbox: unexpected,
  };
  const work = new Work(
    () => harness,
    turns,
    { listWorkTemplates: () => [] },
    () => agents,
    store,
  );
  const threads: ApiThreads = {
    getOrCreateConversation: (key) => conversation(key),
    listConversations: async () => [],
  };
  const apiTurns: ApiTurns = {
    admitUserTurn: unexpected,
    admitStop: unexpected,
    readReplies: unexpected,
    readReplyText: unexpected,
  };
  const events: ConversationEvents = {
    watchConversation: (id, eventContext) =>
      watchEvents(harness, id, eventContext),
  };
  api = new ApiServer(() => harness, threads, apiTurns, work, events, token)
    .server;
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
});
afterAll(async () => {
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await harness.close(ctx);
  await rm(dir, { recursive: true, force: true });
});

const base = (): string => `http://127.0.0.1:${serverPort(api)}/v1/threads`;
const headers = { authorization: `Bearer ${token}` };

describe("artifacts API", () => {
  it("serves the run listing and manifest to the CHAT root", async () => {
    const caller = await conversation("root");
    const response = await fetch(
      `${base()}/thread-${caller}/work/5/artifacts`,
      { headers },
    );
    expect(response.status).toBe(200);
    const listing = readObject(await response.json());
    const manifest = readObject(listing.manifest);
    expect(manifest.pod).toBe("pod-1");
    expect(manifest.finishedAt).not.toBeNull();
    const files = z.array(z.string()).parse(listing.files);
    expect(files).toContain("manifest.json");
    expect(files).toContain("workspace/a.txt");
    expect(files).toContain("workspace/raw.bin");
  });

  it("serves text files as text and binary files base64-encoded", async () => {
    const caller = await conversation("root");
    const text = await fetch(
      `${base()}/thread-${caller}/work/5/artifacts/workspace/a.txt`,
      { headers },
    );
    expect(text.status).toBe(200);
    expect(text.headers.get("content-type")).toContain("text/plain");
    expect(await text.text()).toBe("hello");
    const binary = await fetch(
      `${base()}/thread-${caller}/work/5/artifacts/workspace/raw.bin`,
      { headers },
    );
    expect(binary.status).toBe(200);
    expect(await binary.json()).toEqual({
      path: "workspace/raw.bin",
      base64: "AP8B",
    });
  });

  it("rejects traversal, unknown files and unknown runs", async () => {
    const caller = await conversation("root");
    const attempt = async (suffix: string): Promise<number> =>
      (
        await fetch(`${base()}/thread-${caller}/work/5/artifacts/${suffix}`, {
          headers,
        })
      ).status;
    expect(await attempt("..%2Fetc%2Fpasswd")).toBe(404);
    expect(await attempt("workspace/missing.txt")).toBe(404);
    expect(await attempt("%2e%2e%2fsecret")).toBe(404);
    const unknown = await fetch(
      `${base()}/thread-${caller}/work/999/artifacts`,
      {
        headers,
      },
    );
    expect(unknown.status).toBe(404);
  });

  it("hides runs from WORK agents outside the parent↔child edge", async () => {
    // Own run: the WORK conversation's scope points at the run.
    await scopedConversation("own", 5);
    const ownResponse = await fetch(`${base()}/own/work/5/artifacts`, {
      headers,
    });
    expect(ownResponse.status).toBe(200);
    // Sibling run: neither own scope nor a launch edge points at it.
    await scopedConversation("sibling", 7);
    const siblingResponse = await fetch(`${base()}/sibling/work/5/artifacts`, {
      headers,
    });
    expect(siblingResponse.status).toBe(404);
    // Child run: a launch edge points at the run.
    await scopedConversation("parent", 7, [5]);
    const childResponse = await fetch(`${base()}/parent/work/5/artifacts`, {
      headers,
    });
    expect(childResponse.status).toBe(200);
  });
});
