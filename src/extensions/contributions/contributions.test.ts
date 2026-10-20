import { expectTypeOf, it } from "vitest";
import type { Binding, KaenoExtension } from "../../core/application/index.ts";
import type {
  AgentExtension,
  AssignedContributions,
  InstalledExtension,
} from "./index.ts";
import type { DefinitionReader } from "../definitions/index.ts";

it("requires recovery validation when an extension produces private assignment data", () => {
  type Producer = (
    assigned: AssignedContributions,
  ) => Pick<Binding, "version" | "value">;
  expectTypeOf<{
    runtime: KaenoExtension;
    bind: Producer;
  }>().not.toMatchTypeOf<AgentExtension>();
  expectTypeOf<{
    runtime: KaenoExtension & { validateBinding(binding: Binding): void };
    bind: Producer;
  }>().toMatchTypeOf<AgentExtension>();
  expectTypeOf<{ runtime: KaenoExtension }>().toMatchTypeOf<AgentExtension>();
  // Native durable registrations remain the sole tool inventory.
  expectTypeOf<"tools">().not.toMatchTypeOf<keyof AgentExtension>();
  expectTypeOf<AgentExtension>().toMatchTypeOf<InstalledExtension>();
  expectTypeOf<{
    definitionReaders: readonly DefinitionReader[];
  }>().toMatchTypeOf<InstalledExtension>();
  expectTypeOf<{}>().not.toMatchTypeOf<InstalledExtension>();
  expectTypeOf<{
    definitionReaders: readonly DefinitionReader[];
    bind: Producer;
  }>().not.toMatchTypeOf<InstalledExtension>();
  expectTypeOf<{
    runtime: KaenoExtension;
    definitionReaders: readonly DefinitionReader[];
    bind: Producer;
  }>().not.toMatchTypeOf<InstalledExtension>();
});
