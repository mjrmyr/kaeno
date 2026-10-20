import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import type { InstalledExtension } from "../../src/extensions/contributions/index.ts";
import {
  definitionOriginSchema,
  type DefinitionReader,
  type DefinitionSource,
} from "../../src/extensions/definitions/index.ts";
import {
  githubExtension,
  GITHUB_EXTENSION,
} from "../../src/extensions/github/index.ts";
import {
  loadEnvironment,
  type LoadEnvironmentOptions,
} from "../../src/host/composition/index.ts";

const roots: string[] = [];
async function put(root: string, path: string, text: string) {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), text);
}
function agent(body: string, fields = "") {
  return `---\nname: coordinator\ndescription: Coordinator\nmodel: faux/faux-1\n${fields}---\n${body}`;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kaeno-definition-readers-"));
  roots.push(root);
  await put(root, "agents/coordinator/AGENT.md", agent("LOCAL"));
  const configFile = join(root, "config.json");
  async function configure(fields: Record<string, unknown> = {}) {
    await writeFile(
      configFile,
      JSON.stringify({
        sourceDirectory: "sources",
        localDefinitions: { agents: [{ alias: "local", directory: "agents" }] },
        kaeno: "local:coordinator",
        ...fields,
      }),
    );
  }
  await configure();
  return { root, configFile, configure };
}
function reader(
  name: string,
  body = name,
): DefinitionReader & {
  read: ReturnType<typeof vi.fn<DefinitionReader["read"]>>;
} {
  return {
    name,
    read: vi.fn<DefinitionReader["read"]>(async (_request, destination) => {
      await put(
        destination,
        "agents/coordinator/AGENT.md",
        agent(body, "skills: [owner/shared:literature]\n"),
      );
      await put(
        destination,
        "skills/literature/SKILL.md",
        `---\nname: literature\ndescription: Research\n---\n${body}`,
      );
      return { commit: "a".repeat(40) };
    }),
  };
}
function repositories(agentProvider: string, skillProvider = agentProvider) {
  return {
    agentRepositories: [
      { provider: agentProvider, repository: "owner/shared", path: "agents" },
    ],
    skillRepositories: [
      { provider: skillProvider, repository: "owner/shared", path: "skills" },
    ],
    kaeno: "owner/shared:coordinator",
  };
}
function install(...readers: DefinitionReader[]): InstalledExtension {
  return { definitionReaders: readers };
}
function offer(
  extension: InstalledExtension,
): NonNullable<LoadEnvironmentOptions["policy"]> {
  return (base) => ({
    assistant: {
      available: [...base.assistant.available, extension],
      defaults: [...base.assistant.defaults, extension],
    },
    worker: {
      available: [...base.worker.available, extension],
      defaults: [...base.worker.defaults, extension],
    },
  });
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("composes custom source capabilities without importing GitHub implementations", async () => {
  const { configFile, configure } = await fixture();
  await configure({
    agentRepositories: [{ provider: "custom", repository: "owner/profiles" }],
    kaeno: "owner/profiles:coordinator",
  });
  const script = `
    import { registerHooks } from "node:module";
    import { mkdir, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    registerHooks({ load(url, context, next) {
      if (url.includes("/extensions/github/")) throw new Error("GitHub must not be imported by composition");
      return next(url, context);
    }});
    const { loadEnvironment } = await import(${JSON.stringify(resolve("src/host/composition/index.ts"))});
    const configuration = await loadEnvironment({
      configFile: process.argv[1],
      extensions: [{ definitionReaders: [{ name: "custom", async read(_request, destination) {
        await mkdir(join(destination, "coordinator"));
        await writeFile(join(destination, "coordinator/AGENT.md"), ${JSON.stringify(agent("CUSTOM"))});
        return { commit: "a".repeat(40) };
      } }] }],
    });
    console.log(configuration.assistant.instructions);
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script, configFile],
    { timeout: 10_000 },
  );
  expect(stdout.trim()).toBe("CUSTOM");
});

it("routes equal repository/ref inputs by provider and snapshots each provider's provenance", async () => {
  const { configFile, configure } = await fixture();
  await configure(repositories("profiles", "research"));
  const profiles = reader("profiles", "AGENT FROM PROFILES");
  const research = reader("research", "KNOWLEDGE FROM RESEARCH");
  const composed = await loadEnvironment({
    configFile,
    extensions: [install(profiles, research)],
  });
  expect(profiles.read).toHaveBeenCalledExactlyOnceWith(
    { repository: "owner/shared", ref: "HEAD" },
    expect.any(String),
    expect.any(AbortSignal),
  );
  expect(research.read).toHaveBeenCalledTimes(1);
  expect(composed.assistant.instructions).toBe("AGENT FROM PROFILES");
  expect(composed.assistant.bindings).toContainEqual(
    expect.objectContaining({
      owner: "kaeno-definition-origins",
      value: expect.objectContaining({
        origin: expect.objectContaining({
          provider: "profiles",
          repository: "owner/shared",
        }),
      }),
    }),
  );
  expect(composed.assistant.bindings).toContainEqual(
    expect.objectContaining({
      owner: "kaeno-skills",
      value: {
        skills: [
          expect.objectContaining({
            id: "owner/shared:literature",
            documents: {
              "SKILL.md": expect.stringContaining("KNOWLEDGE FROM RESEARCH"),
            },
            origin: expect.objectContaining({
              provider: "research",
              repository: "owner/shared",
            }),
          }),
        ],
      },
    }),
  );
});

it("deduplicates acquisition across kinds and discovery paths only within the selected provider", async () => {
  const { configFile, configure } = await fixture();
  await configure(repositories("campus"));
  const campus = reader("campus");
  await loadEnvironment({ configFile, extensions: [install(campus)] });
  expect(campus.read).toHaveBeenCalledTimes(1);
});

it("permits a source-only GitHub installation without native runtime, bindings or tool grants", async () => {
  const { configFile } = await fixture();
  const baseline = await loadEnvironment({ configFile });
  const github = githubExtension();
  expect(github.runtime).toBeUndefined();
  expect(github.definitionReaders?.map((reader) => reader.name)).toEqual([
    "github",
  ]);
  const composed = await loadEnvironment({
    configFile,
    extensions: [github],
    policy: offer(github),
  });
  expect(composed.extensions.map((runtime) => runtime.durable.name)).toEqual(
    baseline.extensions.map((runtime) => runtime.durable.name),
  );
  expect(composed.assistant).toEqual(baseline.assistant);
  expect(composed.work.tools).toEqual(baseline.work.tools);
});

it("keeps both public and installation-scoped readers inside the configured GitHub integration", async () => {
  const { root, configFile } = await fixture();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const fetch = vi.fn<typeof globalThis.fetch>();
  const github = githubExtension({
    appId: "123",
    installationId: 42,
    privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    fetch,
  });
  expect(github.definitionReaders?.map((reader) => reader.name)).toEqual([
    "github",
    "github-app-42",
  ]);
  const composed = await loadEnvironment({ configFile, extensions: [github] });
  expect(composed.extensions.map((runtime) => runtime.durable.name)).toContain(
    GITHUB_EXTENSION,
  );
  expect(composed.assistant.tools).not.toContain("github_list_repositories");
  expect(
    composed.assistant.bindings?.some(
      (binding) => binding.owner === GITHUB_EXTENSION,
    ),
  ).toBe(false);
  expect(fetch).not.toHaveBeenCalled();

  // Exercise the embedded App reader's actual auth path, stopping before any remote Git access.
  const appReader = github.definitionReaders?.find(
    (reader) => reader.name === "github-app-42",
  );
  if (!appReader) {
    throw new Error("Missing configured App reader");
  }
  const destination = join(root, "export");
  await mkdir(destination);
  fetch.mockResolvedValue(new Response(null, { status: 403 }));
  await expect(
    appReader.read({ repository: "owner/private", ref: "HEAD" }, destination),
  ).rejects.toThrow("App credentials");
  expect(fetch).toHaveBeenCalledExactlyOnceWith(
    "https://api.github.com/app/installations/42/access_tokens",
    expect.objectContaining({ method: "POST", body: "{}" }),
  );
});

it("rejects uninstalled source-only policy selectors instead of treating them as named selectors", async () => {
  const { configFile } = await fixture();
  const installed = githubExtension();
  await expect(
    loadEnvironment({
      configFile,
      extensions: [installed],
      policy: offer(githubExtension()),
    }),
  ).rejects.toThrow("uninstalled extension: github");
});

it.each(["refresh", "offline"] as const)(
  "rejects all unknown readers before the first acquisition (%s)",
  async (sourceMode) => {
    const { configFile, configure } = await fixture();
    await configure({
      agentRepositories: [
        { provider: "known", repository: "owner/first" },
        { provider: "missing", repository: "owner/second" },
      ],
    });
    const known = reader("known");
    await expect(
      loadEnvironment({ configFile, sourceMode, extensions: [install(known)] }),
    ).rejects.toThrow('unknown reader "missing"');
    expect(known.read).not.toHaveBeenCalled();
  },
);

it.each(["duplicate", "empty"] as const)(
  "rejects %s reader names even when no repository uses them",
  async (invalid) => {
    const { configFile } = await fixture();
    const entry = reader(invalid === "empty" ? "" : "same");
    const extensions =
      invalid === "empty" ? [install(entry)] : [install(entry), install(entry)];
    await expect(loadEnvironment({ configFile, extensions })).rejects.toThrow(
      invalid === "empty"
        ? "reader name must not be empty"
        : 'duplicate reader "same"',
    );
    expect(entry.read).not.toHaveBeenCalled();
  },
);

it.each(["__proto__", "constructor"])(
  "treats %s as an ordinary registered provider name",
  async (name) => {
    const { configFile, configure } = await fixture();
    await configure(repositories(name));
    const custom = reader(name);
    await loadEnvironment({ configFile, extensions: [install(custom)] });
    expect(custom.read).toHaveBeenCalledTimes(1);
  },
);

it("does not reuse another provider's offline cohort and retains both captured snapshots", async () => {
  const { configFile, configure } = await fixture();
  const first = reader("first", "FIRST");
  const second = reader("second", "SECOND");
  const options = { configFile, extensions: [install(first, second)] };
  await configure(repositories("first"));
  const capturedFirst = await loadEnvironment(options);
  await configure(repositories("second"));
  await expect(
    loadEnvironment({ ...options, sourceMode: "offline" }),
  ).rejects.toThrow("offline input set");
  expect(second.read).not.toHaveBeenCalled();
  const capturedSecond = await loadEnvironment(options);
  expect(capturedSecond.assistant.instructions).toBe("SECOND");
  first.read.mockClear();
  second.read.mockClear();
  expect(
    (await loadEnvironment({ ...options, sourceMode: "offline" })).assistant,
  ).toEqual(capturedSecond.assistant);
  await configure(repositories("first"));
  expect(
    (await loadEnvironment({ ...options, sourceMode: "offline" })).assistant,
  ).toEqual(capturedFirst.assistant);
  expect(first.read).not.toHaveBeenCalled();
  expect(second.read).not.toHaveBeenCalled();
});

it("retains the previous multi-provider cohort after failure and never falls back to public access", async () => {
  const { configFile, configure } = await fixture();
  await configure(repositories("private", "research"));
  const privateReader = reader("private", "PRIVATE");
  const research = reader("research", "RESEARCH");
  const publicReader = reader("public");
  const options = {
    configFile,
    extensions: [install(privateReader, research, publicReader)],
  };
  const previous = await loadEnvironment(options);
  research.read.mockRejectedValue(new Error("not authorized"));
  await expect(loadEnvironment(options)).rejects.toThrow("not authorized");
  expect(publicReader.read).not.toHaveBeenCalled();
  privateReader.read.mockClear();
  research.read.mockClear();
  const offline = await loadEnvironment({ ...options, sourceMode: "offline" });
  expect(offline.assistant).toEqual(previous.assistant);
  expect(privateReader.read).not.toHaveBeenCalled();
  expect(research.read).not.toHaveBeenCalled();
});

it("propagates cancellation without consulting another reader or publishing a cohort", async () => {
  const { configFile, configure } = await fixture();
  await configure(repositories("private"));
  const privateReader = reader("private");
  const publicReader = reader("public");
  const controller = new AbortController();
  privateReader.read.mockImplementation(
    async (_request, _destination, signal) => {
      controller.abort(new Error("cancelled by caller"));
      signal?.throwIfAborted();
      throw new Error("expected abort");
    },
  );
  const options = {
    configFile,
    extensions: [install(privateReader, publicReader)],
  };
  await expect(
    loadEnvironment({ ...options, signal: controller.signal }),
  ).rejects.toThrow("cancelled by caller");
  expect(publicReader.read).not.toHaveBeenCalled();
  await expect(
    loadEnvironment({ ...options, sourceMode: "offline" }),
  ).rejects.toThrow("offline input set");
  expect(privateReader.read).toHaveBeenCalledTimes(1);
});

it("rejects injected aliases colliding with configured repositories before fetching", async () => {
  const { configFile, configure } = await fixture();
  await configure(repositories("campus"));
  const campus = reader("campus");
  const injected = {
    alias: "owner/shared",
    snapshot: vi.fn<DefinitionSource["snapshot"]>(async () => ({
      packages: [],
      diagnostics: [],
    })),
  };
  await expect(
    loadEnvironment({
      configFile,
      extensions: [install(campus)],
      agentSources: [injected],
    }),
  ).rejects.toThrow('Duplicate definition source alias "owner/shared"');
  expect(campus.read).not.toHaveBeenCalled();
  expect(injected.snapshot).not.toHaveBeenCalled();
});

it("accepts historical repository origins without inventing a provider identity", () => {
  const historical = {
    kind: "repository",
    repository: "owner/definitions",
    ref: "main",
    commit: "a".repeat(40),
    path: "agents/coordinator",
    contentHash: "b".repeat(64),
  };
  expect(definitionOriginSchema.parse(historical)).toEqual(historical);
  expect(
    definitionOriginSchema.parse({ ...historical, provider: "campus" }),
  ).toEqual({ ...historical, provider: "campus" });
});
