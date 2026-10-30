import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { MemoryStorage, type JsonObject } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { expect, it, vi } from "vitest";
import {
  openKaeno,
  type KaenoExtension,
} from "../../src/core/application/index.ts";
import {
  loadZoteroConfiguration,
  ZoteroClient,
  zoteroExtension,
  ZOTERO_TOOLS,
} from "../../src/extensions/zotero/index.ts";

const paper = {
  key: "ABCD2345",
  meta: { numChildren: 2 },
  data: {
    key: "ABCD2345",
    version: 7,
    itemType: "journalArticle",
    title: "Attention Is All You Need",
    creators: [
      { creatorType: "author", firstName: "Ashish", lastName: "Vaswani" },
      { creatorType: "author", name: "Google Brain" },
    ],
    abstractNote: "The dominant sequence transduction models...",
    date: "2017",
    publicationTitle: "NeurIPS",
    DOI: "10.48550/arXiv.1706.03762",
    url: "",
    tags: [{ tag: "transformers" }],
    relations: {},
    dateAdded: "2024-01-01T00:00:00Z",
  },
};

function handled(
  handler: (url: URL, init?: RequestInit) => Response | undefined,
) {
  return vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const response = handler(new URL(String(input)), init);
    return response ?? new Response("{}", { status: 404 });
  });
}

async function call(
  extension: KaenoExtension,
  name: string,
  args: JsonObject,
): Promise<{ output: string; error: boolean }> {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  let output = "";
  let error = false;
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
    async (request) => {
      const result = request.messages.findLast(
        (message) => message.role === "toolResult",
      );
      if (result?.role === "toolResult") {
        const content = result.content[0];
        output = content?.type === "text" ? content.text : "";
        error = result.isError;
      }
      return fauxAssistantMessage("Done");
    },
  ]);
  const core = await openKaeno({
    storage: new MemoryStorage(),
    models,
    extensions: [extension],
    assistant: {
      model: { provider: "faux", modelId: "faux-1" },
      instructions: "Read the library",
      tools: [name],
    },
  });
  try {
    const id = await core.threads.getOrCreateConversation("zotero");
    const task = await core.harness.commit(
      (tx) => core.turns.admitUserTurn(tx, id, "Read", "read"),
      context,
    );
    await core.harness.waitForTask(task, context);
    return { output, error };
  } finally {
    await core.close();
  }
}

function zotero(
  handler: (url: URL, init?: RequestInit) => Response | undefined,
) {
  const fetch = handled(handler);
  const extension = zoteroExtension(
    new ZoteroClient({ type: "user", id: 42 }, "secret-key\n", fetch),
  );
  return {
    fetch,
    call: async (name: string, args: JsonObject) => {
      const { output, error } = await call(extension, name, args);
      if (error) {
        throw new Error(output);
      }
      return JSON.parse(output);
    },
    extension,
  };
}

it("registers every tool as read-only and safe to replay", () => {
  const { extension } = zotero(() => undefined);
  expect(extension.readOnlyTools).toEqual([...ZOTERO_TOOLS]);
  expect(extension.durable.tools?.map((tool) => tool.name)).toEqual([
    ...ZOTERO_TOOLS,
  ]);
  for (const tool of extension.durable.tools ?? []) {
    expect(tool.replay).toBe("safe");
  }
});

it("searches a collection with the API key header and summarizes items", async () => {
  const { fetch, call } = zotero((url, init) => {
    const headers = new Headers(init?.headers);
    expect(headers.get("zotero-api-key")).toBe("secret-key");
    expect(headers.get("zotero-api-version")).toBe("3");
    expect(init?.redirect).toBe("error");
    if (url.pathname === "/users/42/collections/COLL2345/items/top") {
      return Response.json([paper], { headers: { "Total-Results": "3" } });
    }
  });
  const result = await call("zotero_search_items", {
    query: "attention",
    everything: true,
    collection: "COLL2345",
    limit: 1,
  });
  const url = new URL(String(fetch.mock.calls[0]?.[0]));
  expect(Object.fromEntries(url.searchParams)).toEqual({
    q: "attention",
    qmode: "everything",
    limit: "1",
    start: "0",
    sort: "dateModified",
    direction: "desc",
  });
  expect(result).toEqual({
    total: 3,
    nextStart: 1,
    items: [
      {
        key: "ABCD2345",
        itemType: "journalArticle",
        title: "Attention Is All You Need",
        creators: ["Ashish Vaswani", "Google Brain"],
        date: "2017",
        publication: "NeurIPS",
        DOI: "10.48550/arXiv.1706.03762",
        tags: ["transformers"],
        numChildren: 2,
      },
    ],
  });
});

it("reads an item without bookkeeping fields", async () => {
  const { call } = zotero((url) =>
    url.pathname === "/users/42/items/ABCD2345"
      ? Response.json(paper)
      : undefined,
  );
  const item = await call("zotero_get_item", { key: "ABCD2345" });
  expect(item).toMatchObject({
    title: "Attention Is All You Need",
    abstractNote: "The dominant sequence transduction models...",
    numChildren: 2,
  });
  expect(item).not.toHaveProperty("version");
  expect(item).not.toHaveProperty("relations");
});

it("lists notes as plain text, attachments and annotations", async () => {
  const { call } = zotero((url) =>
    url.pathname === "/users/42/items/ABCD2345/children"
      ? Response.json([
          {
            key: "NOTE2345",
            meta: {},
            data: {
              itemType: "note",
              note: "<p>Key idea:&nbsp;self-attention</p><p>A &amp; B</p>",
            },
          },
          {
            key: "PDF23456",
            meta: { numChildren: 1 },
            data: {
              itemType: "attachment",
              title: "Full Text PDF",
              contentType: "application/pdf",
              filename: "vaswani.pdf",
            },
          },
          {
            key: "ANNO2345",
            meta: {},
            data: {
              itemType: "annotation",
              annotationType: "highlight",
              annotationText: "multi-head attention",
              annotationComment: "",
              annotationPageLabel: "4",
            },
          },
        ])
      : undefined,
  );
  expect(await call("zotero_get_children", { key: "ABCD2345" })).toEqual([
    {
      key: "NOTE2345",
      itemType: "note",
      note: "Key idea: self-attention\nA & B",
    },
    {
      key: "PDF23456",
      itemType: "attachment",
      title: "Full Text PDF",
      contentType: "application/pdf",
      filename: "vaswani.pdf",
      numChildren: 1,
    },
    {
      key: "ANNO2345",
      itemType: "annotation",
      annotationType: "highlight",
      text: "multi-head attention",
      page: "4",
    },
  ]);
});

it("pages through long full text", async () => {
  const content = "a".repeat(30_000) + "b".repeat(5);
  const { call } = zotero((url) =>
    url.pathname === "/users/42/items/PDF23456/fulltext"
      ? Response.json({ content, indexedPages: 9, totalPages: 9 })
      : undefined,
  );
  const first = await call("zotero_get_fulltext", { key: "PDF23456" });
  expect(first).toMatchObject({
    indexedPages: 9,
    totalPages: 9,
    totalChars: 30_005,
    nextOffset: 30_000,
  });
  expect(first.text).toHaveLength(30_000);
  const rest = await call("zotero_get_fulltext", {
    key: "PDF23456",
    offset: 30_000,
  });
  expect(rest.text).toBe("bbbbb");
  expect(rest).not.toHaveProperty("nextOffset");
});

it("lists collections with their parents", async () => {
  const { call } = zotero((url) =>
    url.pathname === "/users/42/collections"
      ? Response.json(
          [
            { key: "COLL2345", meta: { numItems: 4 }, data: { name: "ML" } },
            {
              key: "COLL6789",
              meta: { numItems: 1 },
              data: { name: "Transformers", parentCollection: "COLL2345" },
            },
          ],
          { headers: { "Total-Results": "2" } },
        )
      : undefined,
  );
  expect(await call("zotero_list_collections", {})).toEqual({
    total: 2,
    collections: [
      { key: "COLL2345", name: "ML", numItems: 4 },
      {
        key: "COLL6789",
        name: "Transformers",
        parent: "COLL2345",
        numItems: 1,
      },
    ],
  });
});

it("reports a denied key without echoing it, and rejects malformed keys before any request", async () => {
  const fetch = handled(() => new Response("Forbidden", { status: 403 }));
  const extension = zoteroExtension(
    new ZoteroClient({ type: "user", id: 42 }, "secret-key", fetch),
  );
  const denied = await call(extension, "zotero_get_item", { key: "ABCD2345" });
  expect(denied.error).toBe(true);
  expect(denied.output).toContain("access denied");
  expect(denied.output).not.toContain("secret-key");
  fetch.mockClear();
  const malformed = await call(extension, "zotero_get_item", {
    key: "../../keys",
  });
  expect(malformed.error).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});

it("loads a group library and reads the key file next to the configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kaeno-zotero-"));
  await writeFile(join(directory, "zotero.key"), "group-key\n");
  await writeFile(
    join(directory, "zotero.json"),
    JSON.stringify({
      library: { type: "group", id: 7 },
      apiKeyFile: "zotero.key",
    }),
  );
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json([]));
  const extension = await loadZoteroConfiguration(
    join(directory, "zotero.json"),
  );
  await call(extension, "zotero_list_collections", {});
  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(new URL(String(url)).pathname).toBe("/groups/7/collections");
  expect(new Headers(init?.headers).get("zotero-api-key")).toBe("group-key");
});
