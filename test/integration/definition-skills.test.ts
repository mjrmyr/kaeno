import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  parseAgent,
  parseAgents,
  resolveAgentSetup,
  resolveAgents,
} from "../../src/extensions/agents/index.ts";
import { openKaeno, type Binding } from "../../src/core/application/index.ts";
import type {
  DefinitionOrigin,
  DefinitionPackage,
} from "../../src/extensions/definitions/index.ts";
import {
  loadSkills,
  readSkillDocument,
  SkillCatalog,
  skillBinder,
  skillsExtension,
  type BoundSkill,
} from "../../src/extensions/skills/index.ts";

const model = { provider: "faux", modelId: "faux-1" };
const repositoryOrigin: DefinitionOrigin = {
  kind: "repository",
  repository: "owner/repo",
  ref: "refs/heads/Main",
  commit: "a".repeat(40),
  path: "skills/guide",
  contentHash: "b".repeat(64),
};
const directoryOrigin: DefinitionOrigin = {
  kind: "directory",
  source: "local",
  path: "guide",
  contentHash: "c".repeat(64),
};
const binary = Buffer.from([0, 255, 128, 1]).toString("base64");
const guide: BoundSkill = {
  id: "owner/repo:guide",
  description: "Guide",
  disableModelInvocation: false,
  treeHash: "d".repeat(64),
  origin: repositoryOrigin,
  documents: { "SKILL.md": "NATIVE GUIDANCE" },
  assets: { "asset.bin": { base64: binary, executable: true } },
};
function bind(
  binder: (references: readonly string[]) => Binding | undefined,
  references: readonly string[],
): Binding {
  const binding = binder(references);
  if (!binding) {
    throw new Error("expected a skills binding");
  }
  return binding;
}
function manifest(name: string): string {
  return `---\nname: ${name}\ndescription: Guide\n---\nInstructions`;
}

it.each([{ tools: [] }, { tools: ["read_skill"] }])(
  "binds native-only skills once and keeps explicit tools exact (%j)",
  async ({ tools }) => {
    const native = structuredClone(guide);
    const binder = skillBinder(new SkillCatalog([]), [native]);
    native.documents["SKILL.md"] = "MUTATED";
    const agent = parseAgent(
      `---\nname: assistant\ndescription: Assistant\nskills: []\ntools: ${JSON.stringify(tools)}\n---\nAnswer`,
      "local",
      "assistant.md",
    );
    const setup = resolveAgentSetup(
      agent,
      { model, tools: ["list_skills"] },
      binder,
    );
    expect(setup.tools).toEqual(tools);
    expect(setup.bindings).toHaveLength(1);
    expect(setup.bindings?.[0].owner).toBe("kaeno-skills");
    expect(setup.bindings?.[0].value).toEqual({ skills: [guide] });
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    let observed = "";
    if (tools.length > 0) {
      faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("read_skill", { skill: guide.id, file: "asset.bin" })],
          { stopReason: "toolUse" },
        ),
        async (request) => {
          observed = JSON.stringify(request.messages);
          return fauxAssistantMessage("DONE");
        },
      ]);
    } else {
      faux.setResponses([
        async (request) => {
          observed = JSON.stringify(request.messages);
          return fauxAssistantMessage("DONE");
        },
      ]);
    }
    const core = await openKaeno({
      storage: new MemoryStorage(),
      models,
      assistant: setup,
      extensions: [skillsExtension()],
    });
    try {
      const id = await core.threads.getOrCreateConversation("native-only");
      const task = await core.harness.commit(
        (tx) => core.turns.admitUserTurn(tx, id, "Question", "request"),
        context,
      );
      await core.harness.waitForTask(task, context);
      expect(
        (await core.harness.snapshot(AgentDoc, id, context))?.tools,
      ).toEqual(tools);
      expect(observed).not.toContain("MUTATED");
      if (tools.length > 0) {
        expect(observed).toContain(binary);
        expect(observed).toContain("executable: true");
      } else {
        expect(observed).toContain("NATIVE GUIDANCE");
        expect(observed).not.toContain("Use read_skill");
      }
    } finally {
      await core.close();
    }
  },
);

it("resolves worker-specific native contributions without leaking skills between participants", () => {
  const agents = ["first", "second"].map((name) =>
    parseAgent(
      `---\nname: ${name}\ndescription: Worker\ntools: []\n---\nInstructions`,
      "local",
      `${name}.md`,
    ),
  );
  const [first, second] = resolveAgents({
    agents,
    defaults: { model, tools: ["list_skills", "read_skill"] },
    skills: (agent) =>
      skillBinder(new SkillCatalog([]), agent.name === "first" ? [guide] : []),
  });
  expect(first.setup.tools).toEqual([]);
  expect(first.setup.bindings).toEqual([
    bind(skillBinder(new SkillCatalog([]), [guide]), []),
  ]);
  expect(second.setup.bindings).toEqual([]);
});

it("does not create an empty skills binding without native contributions", () => {
  const binder = skillBinder(new SkillCatalog([]));
  expect(binder([])).toBeUndefined();
  const agent = parseAgent(manifest("assistant"), "local", "assistant.md");
  expect(
    resolveAgentSetup(agent, { model, tools: [] }, binder).bindings,
  ).toEqual([]);
  expect(skillBinder(new SkillCatalog([]), [guide])([])).toBeDefined();
});

it("merges assigned and native snapshots in order, deduplicates identical content, and freezes inputs", () => {
  const local = { ...guide, id: "local:other", origin: directoryOrigin };
  const contributions = [structuredClone(guide), structuredClone(local)];
  const binder = skillBinder(new SkillCatalog([guide]), contributions);
  contributions[1].documents["SKILL.md"] = "changed later";
  const binding = bind(binder, ["owner/repo:*"]);
  expect(binding.value).toEqual({ skills: [guide, local] });
  expect(() => skillsExtension().validateBinding?.(binding)).not.toThrow();
  expect(bind(binder, ["guide"]).value).not.toBe(binding.value);
  expect(bind(binder, ["guide"]).value).toEqual({ skills: [guide, local] });
});

it.each([
  { ...guide, documents: { "SKILL.md": "different instructions" } },
  { ...guide, assets: { "asset.bin": { base64: "AA==", executable: true } } },
  { ...guide, origin: directoryOrigin },
])(
  "rejects conflicting same-ID snapshots even with matching tree hashes",
  (conflict) => {
    expect(() =>
      bind(skillBinder(new SkillCatalog([guide]), [conflict]), ["guide"]),
    ).toThrow(/conflicting.*owner\/repo:guide/);
  },
);

it("checks the combined binding budget, including native assets, rather than each channel alone", () => {
  const assigned = {
    ...guide,
    documents: { "SKILL.md": "x".repeat(4 * 1024 * 1024) },
  };
  const native = {
    ...guide,
    id: "native:large",
    assets: {
      "asset.bin": { base64: "AAAA".repeat(1024 * 1024), executable: false },
    },
  };
  const binder = skillBinder(new SkillCatalog([assigned]), [native]);
  expect(() => bind(binder, ["guide"])).toThrow(/8 MiB/);
  expect(() =>
    skillBinder(new SkillCatalog([]), [
      {
        ...assigned,
        documents: { "SKILL.md": "x".repeat(8 * 1024 * 1024) },
      },
    ]),
  ).toThrow(/8 MiB/);
});

it("expands sorted wildcards in selector order, deduplicates overlaps, and saves only concrete IDs", () => {
  const catalog = new SkillCatalog([
    { ...guide, id: "owner/repo:zulu" },
    { ...guide, id: "other:only" },
    { ...guide, id: "owner/repo:alpha" },
  ]);
  const references = [
    "zulu",
    "owner/repo:*",
    "other:only",
    "owner/repo:alpha",
    "owner/repo:*",
  ];
  expect(catalog.bind(references).map((skill) => skill.id)).toEqual([
    "owner/repo:zulu",
    "owner/repo:alpha",
    "other:only",
  ]);
  expect(bind(skillBinder(catalog), references).value).toEqual({
    skills: catalog.bind(["owner/repo:zulu", "owner/repo:alpha", "other:only"]),
  });
  expect(catalog.bind(["only"])[0].id).toBe("other:only");
  expect(() => catalog.bind(["missing:*"])).toThrow(/empty.*wildcard/);
  expect(() => catalog.bind(["alpha", "unknown"])).toThrow(/unknown skill/);
  expect(() =>
    catalog
      .merge(new SkillCatalog([{ ...guide, id: "other:alpha" }]))
      .bind(["alpha"]),
  ).toThrow(/ambiguous/);
});

it.each([
  "*",
  "owner/repo:*extra",
  "owner/repo:al*",
  "*:guide",
  "owner/repo:**",
  ":*",
  "source:other:*",
])("rejects malformed wildcard %s", (reference) => {
  expect(() => new SkillCatalog([guide]).bind([reference])).toThrow(
    /invalid skill wildcard/,
  );
});

it.each([repositoryOrigin, directoryOrigin])(
  "retains supplied agent and skill provenance (%j), binary assets, and old records",
  async (origin) => {
    const root = await mkdtemp(join(tmpdir(), "kaeno-definition-skills-"));
    try {
      await writeFile(join(root, "SKILL.md"), manifest("guide"));
      await writeFile(join(root, "asset.bin"), Buffer.from(binary, "base64"));
      const definition: DefinitionPackage = {
        source: "source",
        directory: root,
        manifest: manifest("guide"),
        origin,
      };
      const agents = parseAgents([
        {
          source: definition.source,
          manifestPath: join(root, "guide.md"),
          manifest: definition.manifest,
          origin,
        },
      ]);
      expect(agents.diagnostics).toEqual([]);
      expect(agents.agents[0].origin).toEqual(origin);
      const loaded = await loadSkills([definition]);
      expect(loaded.diagnostics).toEqual([]);
      const snapshots = loaded.catalog.bind(["source:*"]);
      expect(snapshots[0].origin).toEqual(origin);
      expect(snapshots[0].origin).not.toBe(origin);
      const binding = bind(skillBinder(loaded.catalog), ["guide"]);
      expect(binding.value).toEqual({ skills: snapshots });
      expect(() => skillsExtension().validateBinding?.(binding)).not.toThrow();
      await rm(root, { recursive: true });
      expect(
        readSkillDocument(snapshots, { skill: "guide", file: "asset.bin" }),
      ).toContain(binary);
      const legacy: BoundSkill = {
        id: "legacy:guide",
        description: "Guide",
        disableModelInvocation: false,
        treeHash: guide.treeHash,
        documents: guide.documents,
      };
      expect(() =>
        skillsExtension().validateBinding?.(
          bind(skillBinder(new SkillCatalog([legacy])), ["guide"]),
        ),
      ).not.toThrow();
      expect(() =>
        skillsExtension().validateBinding?.({
          ...binding,
          value: { skills: [{ ...guide, origin: { kind: "repository" } }] },
        }),
      ).toThrow();
      expect(
        parseAgents([
          {
            source: "legacy",
            manifestPath: join(root, "guide.md"),
            manifest: manifest("guide"),
          },
        ]).agents[0],
      ).not.toHaveProperty("origin");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(["malformed", "duplicate"])(
  "fails invalid-source wildcards rather than shrinking the set (%s), including after catalog merges",
  async (invalid) => {
    const root = await mkdtemp(join(tmpdir(), "kaeno-invalid-skills-"));
    try {
      const packages: DefinitionPackage[] = [];
      for (const [directory, text] of [
        ["good", manifest("guide")],
        [
          "bad",
          invalid === "duplicate"
            ? manifest("guide")
            : "---\nname: bad\n---\nMissing description",
        ],
      ]) {
        const path = join(root, directory);
        await mkdir(path);
        await writeFile(join(path, "SKILL.md"), text);
        packages.push({ source: "source", directory: path, manifest: text });
      }
      const loaded = await loadSkills(packages);
      expect(loaded.diagnostics).toHaveLength(1);
      const merged = loaded.catalog.merge(
        new SkillCatalog([{ ...guide, id: "other:valid" }]),
      );
      expect(() => merged.bind(["source:*"])).toThrow(
        /source source has invalid skill packages/,
      );
      expect(() =>
        new SkillCatalog([]).merge(merged).bind(["source:*"]),
      ).toThrow(/invalid skill packages/);
      expect(merged.bind(["other:*"])[0].id).toBe("other:valid");
      if (invalid === "duplicate") {
        expect(() => merged.bind(["source:guide"])).toThrow(/unknown skill/);
      } else {
        expect(merged.bind(["guide"])[0].id).toBe("source:guide");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("accepts source-level invalidity from discovery without any inspectable malformed package", () => {
  const catalog = new SkillCatalog([guide], ["owner/repo"]);
  expect(catalog.bind(["guide"])).toEqual([guide]);
  expect(() => catalog.bind(["owner/repo:*"])).toThrow(
    /invalid skill packages/,
  );
});
