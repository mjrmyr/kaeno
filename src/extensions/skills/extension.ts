import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import {
  readBinding,
  type Binding,
  type KaenoExtension,
} from "../../core/application/index.ts";
import { definitionOriginSchema } from "../definitions/index.ts";
import {
  listSkills,
  readSkillDocument,
  skillPrompt,
  snapshotSkills,
  LIST_SKILLS,
  READ_SKILL,
  SKILL_TOOLS,
  type BoundSkill,
  type SkillCatalog,
} from "./skills.ts";

/** Owner name of skill bindings and the native skill tools/section. */
export const SKILLS_EXTENSION = "kaeno-skills";
const VERSION = 1;

const boundSkillSchema = z.object({
  id: z.string().min(1),
  origin: definitionOriginSchema.optional(),
  description: z.string(),
  disableModelInvocation: z.boolean(),
  treeHash: z.string().regex(/^[a-f0-9]{64}$/),
  documents: z
    .record(z.string(), z.string())
    .refine((documents) => Object.hasOwn(documents, "SKILL.md")),
  assets: z
    .record(
      z.string(),
      z.object({ base64: z.string(), executable: z.boolean() }),
    )
    .optional(),
});
const bindingValueSchema = z.object({ skills: z.array(boundSkillSchema) });

function boundSkills(binding: Binding | undefined): BoundSkill[] {
  if (!binding) {
    return [];
  }
  if (binding.version !== VERSION) {
    throw new Error(`Skills: unsupported binding version ${binding.version}`);
  }
  return bindingValueSchema.parse(binding.value).skills;
}

/**
 * Binds catalog skills plus native contributions into one skills binding; satisfies consumers'
 * structural binder ports. Returns undefined when there is nothing to bind.
 */
export function skillBinder(
  catalog: SkillCatalog,
  contributions: readonly BoundSkill[] = [],
): (references: readonly string[]) => Binding | undefined {
  const native = snapshotSkills(
    contributions.map((skill) => boundSkillSchema.parse(skill)),
  );
  return (references) => {
    if (references.length === 0 && native.length === 0) {
      return undefined;
    }
    return {
      owner: SKILLS_EXTENSION,
      version: VERSION,
      value: {
        skills: snapshotSkills([...catalog.bind(references), ...native]).map(
          (skill) => ({
            id: skill.id,
            ...(skill.origin ? { origin: { ...skill.origin } } : {}),
            description: skill.description,
            disableModelInvocation: skill.disableModelInvocation,
            treeHash: skill.treeHash,
            documents: { ...skill.documents },
            ...(skill.assets ? { assets: { ...skill.assets } } : {}),
          }),
        ),
      },
    };
  };
}

/**
 * Native skill support. Built without any catalog: it reads only the bindings saved with each
 * conversation, so recovery never needs the original skill directories.
 */
export function skillsExtension(): KaenoExtension {
  const list = defineTool({
    name: LIST_SKILLS,
    description:
      "List IDs and descriptions of skills assigned to you for automatic use. An empty list means none are available.",
    parameters: Type.Object({}),
    replay: "safe",
    execute: async (_args, api, context) => {
      const binding = await readBinding(
        api,
        api.conversationId,
        SKILLS_EXTENSION,
        context,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(listSkills(boundSkills(binding))),
          },
        ],
      };
    },
  });
  const readSkill = defineTool({
    name: READ_SKILL,
    description:
      "Load instructions or a referenced text file of a skill assigned to you. Does not grant new tools.",
    parameters: Type.Object({
      skill: Type.String({ description: "Skill ID, e.g. local:review" }),
      file: Type.Optional(
        Type.String({
          description: "Relative text file, defaults to SKILL.md",
        }),
      ),
    }),
    replay: "safe",
    execute: async (args, api, context) => {
      const binding = await readBinding(
        api,
        api.conversationId,
        SKILLS_EXTENSION,
        context,
      );
      return {
        content: [
          { type: "text", text: readSkillDocument(boundSkills(binding), args) },
        ],
      };
    },
  });
  return {
    durable: defineExtension({
      name: SKILLS_EXTENSION,
      tools: [list, readSkill],
      sections: [
        section("skills", async ({ conversationId, read, agent }, context) => {
          const skills = boundSkills(
            await readBinding(read, conversationId, SKILLS_EXTENSION, context),
          );
          return skillPrompt(
            skills,
            agent.tools.map((tool) => tool.name),
          );
        }),
      ],
    }),
    readOnlyTools: SKILL_TOOLS,
    validateBinding: (binding) => {
      boundSkills(binding);
    },
  };
}
