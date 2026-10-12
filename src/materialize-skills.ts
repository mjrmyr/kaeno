import { z } from "zod";
import { materializeSkillSelection } from "./skills/index.ts";
const raw: unknown = JSON.parse(process.env.KAENO_SKILL_PLAN ?? "[]");
const selection = z
  .array(z.object({ id: z.string(), treeHash: z.string() }))
  .max(256)
  .parse(raw);
await materializeSkillSelection("/skill-cache", selection, "/skills-out");
console.log(`skills: materialized ${selection.length} assigned skills`);
