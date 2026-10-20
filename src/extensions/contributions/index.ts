import type { Binding, KaenoExtension } from "../../core/application/index.ts";
import type { DefinitionReader } from "../definitions/index.ts";
import type { SkillCatalog } from "../skills/index.ts";

/** Only this extension's effectively selected contributions; never permission requests. */
export interface AssignedContributions {
  readonly tools: readonly string[];
  readonly skills: readonly string[];
}

/** Agent-facing exports backed by one native runtime. Installation grants nothing. */
export type AgentExtension = {
  readonly skills?: SkillCatalog;
  readonly definitionReaders?: readonly DefinitionReader[];
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

/** One installation list; source-only integrations need no native runtime or agent permissions. */
export type InstalledExtension =
  | AgentExtension
  | {
      readonly definitionReaders: readonly DefinitionReader[];
      readonly runtime?: never;
      readonly skills?: never;
      readonly bind?: never;
    };
