import type { Binding, KaenoExtension } from "../../core/application/index.ts";
import type { SkillCatalog } from "../skills/index.ts";

/** Only this extension's effectively selected contributions; never permission requests. */
export interface AssignedContributions {
  readonly tools: readonly string[];
  readonly skills: readonly string[];
}

/** Agent-facing exports backed by one native runtime. Installation grants nothing. */
export type AgentExtension = {
  readonly skills?: SkillCatalog;
} & (
  | { readonly runtime: KaenoExtension; readonly bind?: never }
  | {
      readonly runtime: KaenoExtension & {
        validateBinding(binding: Binding): void;
      };
      /** Snapshot private context. The composer supplies the canonical binding owner. */
      bind(
        assigned: AssignedContributions,
      ): Pick<Binding, "version" | "value"> | undefined;
    }
);
