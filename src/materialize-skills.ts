// Kubernetes init-container entry point. No harness, tools, credentials or network.
import { materializeSkillSelection, type SkillCopySelection } from "./skills.ts";

const raw: unknown = JSON.parse(process.env.KAENO_SKILL_PLAN ?? "[]");
if (!Array.isArray(raw) || raw.length > 256 || raw.some(s => !s || typeof s.id !== "string" || typeof s.treeHash !== "string"))
  throw new Error("Invalid KAENO_SKILL_PLAN");
await materializeSkillSelection("/skill-cache", raw as SkillCopySelection, "/skills-out");
console.log(`skills: materialized ${raw.length} assigned skills`);
