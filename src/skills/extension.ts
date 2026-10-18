import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import type { Binding, KaenoExtension } from "../application/index.ts";
import { readBinding } from "../conversation/index.ts";
import {
  readSkillDocument,
  skillPrompt,
  type BoundSkill,
  type SkillCatalog,
} from "./skills.ts";

/** Owner name of skill bindings and the native skill tool/section. */
export const SKILLS_EXTENSION = "kaeno-skills";
export const READ_SKILL = "read_skill";
const VERSION = 1;

const boundSkillSchema = z.object({
  id: z.string().min(1),
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

/** Binds catalog skills to a conversation; satisfies consumers' structural binder ports. */
export function skillBinder(catalog: SkillCatalog): {
  readonly tools: readonly string[];
  bind(references: readonly string[]): Binding;
} {
  return {
    tools: [READ_SKILL],
    bind: (references) => ({
      owner: SKILLS_EXTENSION,
      version: VERSION,
      value: {
        skills: catalog.bind(references).map((skill) => ({
          id: skill.id,
          description: skill.description,
          disableModelInvocation: skill.disableModelInvocation,
          treeHash: skill.treeHash,
          documents: { ...skill.documents },
          ...(skill.assets ? { assets: { ...skill.assets } } : {}),
        })),
      },
    }),
  };
}

/**
 * Native skill support. Built without any catalog: it reads only the bindings saved with each
 * conversation, so recovery never needs the original skill directories.
 */
export function skillsExtension(): KaenoExtension {
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
      tools: [readSkill],
      sections: [
        section("skills", async ({ conversationId, read, agent }, context) => {
          const skills = boundSkills(
            await readBinding(read, conversationId, SKILLS_EXTENSION, context),
          );
          if (agent.tools.some((tool) => tool.name === READ_SKILL)) {
            return skillPrompt(skills);
          }
          const visible = skills.filter(
            (skill) => !skill.disableModelInvocation,
          );
          if (visible.length === 0) {
            return undefined;
          }
          return visible
            .map(
              (skill) =>
                `Assigned skill ${skill.id} (guidance only; grants no tools or access):\n${skill.documents["SKILL.md"]}`,
            )
            .join("\n\n");
        }),
      ],
    }),
    readOnlyTools: [READ_SKILL],
    validateBinding: (binding) => {
      boundSkills(binding);
    },
  };
}
