import { z } from "zod";

export interface ZoteroLibrary {
  readonly type: "user" | "group";
  readonly id: number;
}

export interface ZoteroSearch {
  readonly query?: string;
  readonly everything?: boolean;
  readonly tag?: string;
  readonly itemType?: string;
  readonly collection?: string;
  readonly limit: number;
  readonly start: number;
}

const itemSchema = z.object({
  key: z.string(),
  meta: z.object({ numChildren: z.number().optional() }).passthrough(),
  data: z.record(z.string(), z.unknown()),
});
type Item = z.infer<typeof itemSchema>;

const collectionSchema = z.object({
  key: z.string(),
  meta: z.object({ numItems: z.number().optional() }).passthrough(),
  data: z.object({
    name: z.string(),
    parentCollection: z.union([z.string(), z.literal(false)]).optional(),
  }),
});

const fulltextSchema = z.object({
  content: z.string(),
  indexedPages: z.number().optional(),
  totalPages: z.number().optional(),
});

type ItemSummary = ReturnType<typeof summary>;
type ItemChild = ReturnType<typeof child>;
type Fulltext = z.infer<typeof fulltextSchema>;
export interface Collection {
  readonly key: string;
  readonly name: string;
  readonly parent: string | undefined;
  readonly numItems: number | undefined;
}
interface Page {
  readonly total: number | undefined;
  readonly nextStart?: number;
}

const STATUS_MESSAGES: Record<number, string> = {
  403: "access denied; check the API key's library permissions",
  404: "not found",
};

export class ZoteroApiError extends Error {
  readonly status: number;
  constructor(path: string, status: number) {
    super(`Zotero ${path}: ${STATUS_MESSAGES[status] ?? `HTTP ${status}`}`);
    this.status = status;
  }
}

export class ZoteroClient {
  private readonly apiKey: string;
  private readonly prefix: string;
  private readonly fetch: typeof globalThis.fetch;
  constructor(
    library: ZoteroLibrary,
    apiKey: string,
    fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.apiKey = z.string().trim().min(1).parse(apiKey);
    this.prefix = `/${library.type}s/${library.id}`;
    this.fetch = fetch;
  }

  private async get(
    path: string,
    query: Record<string, string | number | undefined>,
    signal: AbortSignal | undefined,
  ): Promise<{ body: unknown; total?: number }> {
    const url = new URL(`https://api.zotero.org${this.prefix}${path}`);
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }
    const timeout = AbortSignal.timeout(30_000);
    const response = await this.fetch(url, {
      headers: {
        "Zotero-API-Key": this.apiKey,
        "Zotero-API-Version": "3",
      },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      throw new ZoteroApiError(path, response.status);
    }
    const total = response.headers.get("Total-Results");
    return {
      body: await response.json(),
      ...(total === null ? {} : { total: Number(total) }),
    };
  }

  async search(
    search: ZoteroSearch,
    signal?: AbortSignal,
  ): Promise<Page & { readonly items: ItemSummary[] }> {
    const { body, total } = await this.get(
      search.collection
        ? `/collections/${search.collection}/items/top`
        : "/items/top",
      {
        q: search.query,
        qmode: search.everything ? "everything" : undefined,
        tag: search.tag,
        itemType: search.itemType,
        limit: search.limit,
        start: search.start,
        sort: "dateModified",
        direction: "desc",
      },
      signal,
    );
    const items = z.array(itemSchema).parse(body);
    const next = search.start + items.length;
    return {
      total,
      items: items.map(summary),
      ...(total !== undefined && next < total ? { nextStart: next } : {}),
    };
  }

  async item(
    key: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const { body } = await this.get(`/items/${key}`, {}, signal);
    const { data, meta } = itemSchema.parse(body);
    return { ...withoutBookkeeping(data), numChildren: meta.numChildren };
  }

  async children(key: string, signal?: AbortSignal): Promise<ItemChild[]> {
    const { body } = await this.get(`/items/${key}/children`, {}, signal);
    return z.array(itemSchema).parse(body).map(child);
  }

  async fulltext(key: string, signal?: AbortSignal): Promise<Fulltext> {
    const { body } = await this.get(`/items/${key}/fulltext`, {}, signal);
    return fulltextSchema.parse(body);
  }

  async collections(
    start: number,
    signal?: AbortSignal,
  ): Promise<Page & { readonly collections: Collection[] }> {
    const { body, total } = await this.get(
      "/collections",
      { limit: 100, start },
      signal,
    );
    const collections = z.array(collectionSchema).parse(body);
    const next = start + collections.length;
    return {
      total,
      collections: collections.map(({ key, data, meta }) => ({
        key,
        name: data.name,
        parent: data.parentCollection || undefined,
        numItems: meta.numItems,
      })),
      ...(total !== undefined && next < total ? { nextStart: next } : {}),
    };
  }
}

function withoutBookkeeping(data: Item["data"]) {
  const {
    key: _key,
    version: _version,
    relations: _relations,
    dateAdded: _dateAdded,
    ...rest
  } = data;
  return rest;
}

function creatorNames(creators: unknown): string[] {
  return z
    .array(
      z.object({
        name: z.string().optional(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
      }),
    )
    .catch([])
    .parse(creators)
    .map(
      (creator) =>
        creator.name ??
        [creator.firstName, creator.lastName].filter(Boolean).join(" "),
    );
}

function summary({ key, data, meta }: Item) {
  return {
    key,
    itemType: data.itemType,
    title: data.title,
    creators: creatorNames(data.creators),
    date: data.date || undefined,
    publication: data.publicationTitle || data.bookTitle || undefined,
    DOI: data.DOI || undefined,
    url: data.url || undefined,
    tags: z
      .array(z.object({ tag: z.string() }))
      .catch([])
      .parse(data.tags)
      .map(({ tag }) => tag),
    numChildren: meta.numChildren,
  };
}

function child({ key, data, meta }: Item) {
  switch (data.itemType) {
    case "note":
      return { key, itemType: "note", note: plainText(data.note) };
    case "annotation":
      return {
        key,
        itemType: "annotation",
        annotationType: data.annotationType,
        text: data.annotationText || undefined,
        comment: data.annotationComment || undefined,
        page: data.annotationPageLabel || undefined,
      };
    case "attachment":
      return {
        key,
        itemType: "attachment",
        title: data.title,
        contentType: data.contentType || undefined,
        filename: data.filename || undefined,
        url: data.url || undefined,
        numChildren: meta.numChildren,
      };
    default:
      return { key, itemType: data.itemType, title: data.title };
  }
}

export function plainText(html: unknown): string {
  return String(html ?? "")
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
