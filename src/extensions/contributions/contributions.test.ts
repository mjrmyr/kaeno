import { expectTypeOf, it } from "vitest";
import type { Binding, KaenoExtension } from "../../core/application/index.ts";
import type { AgentExtension, AssignedContributions } from "./index.ts";

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
});
