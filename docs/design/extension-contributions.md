# Extension contributions

## Problem

Agent-facing extensions expose tools and skills, backed by a small runtime integration contract. Clients, configuration, business rules, private state and authorization stay extension-owned. Previously `loadEnvironment` required separate extensions/tools/workerTools/bindings/skillsFor inputs: GitHub returned several coordinated lists and the host extracted Browser's native tool names. The application knew extension implementation details.

## Usage (caller's view)

```ts
const github = await loadGitHubConfiguration("./.kaeno/github.json");
const browser = await browserExtension();
const configuration = await loadEnvironment({
  configFile: "./.kaeno/config.json",
  repositoryReader: github.repositoryReader,
  extensions: [github.extension, browser],
  policy: (base) => ({
    assistant: {
      available: [...base.assistant.available, github.extension],
      defaults: [...base.assistant.defaults, github.extension],
    },
    worker: {
      available: [...base.worker.available, github.extension, browser],
      defaults: [...base.worker.defaults, github.extension, browser],
    },
  }),
});
```

Installation alone grants nothing. `available` is a permission ceiling; `defaults` applies only to omitted profile fields. A whole-extension selector includes all native tools and catalog skills; `{ tools: ["github_list_repositories"] }` and `{ skills: ["guides:review"] }` express narrower policy. Whole-extension approval deliberately includes newly added/discovered contributions on upgrade; named ceilings are appropriate for reviewed inventories.

A skills-only extension is `{ runtime: { durable: defineExtension({ name: "guides" }) }, skills: new SkillCatalog(snapshots) }`. Grant it through policy like any other extension. `skills: []` overrides its defaults; `tools: []` remains empty even with assigned knowledge. `forAgent` can narrow role availability and change defaults within that ceiling.

## Shape

`AgentExtension` lives in `src/extensions/contributions/`, outside core:

```ts
type AgentExtension = {
  readonly skills?: SkillCatalog;
} & (
  | { readonly runtime: KaenoExtension; readonly bind?: never }
  | {
      readonly runtime: KaenoExtension & {
        validateBinding(binding: Binding): void;
      };
      bind(assigned: {
        readonly tools: readonly string[];
        readonly skills: readonly string[];
      }): Pick<Binding, "version" | "value"> | undefined;
    }
);
```

Native `runtime.durable.tools` is the one authoritative tool inventory. There is no second executable registry or mirrored name list. The composer derives a local ownership index and rejects collisions, including standard runtime/WORK names. Policies resolve canonical skill references against the complete immutable catalog before checking permission, so ambiguous names and forbidden wildcard members cannot disappear through filtering.

Only effectively selected contributions reach `bind`, grouped by owner. The composer stamps the native runtime name, validates JSON/version and the owner's saved-data contract, and clones each assignment. Bindings cannot grant tools. All selected skills aggregate into the existing `kaeno-skills` snapshot binding; producers do not implement another skill reader. A producer with no private runtime dependency need not survive recovery of its immutable saved skills.

`loadEnvironment` remains the one high-level composition operation. A private resolver handles contribution policy and assignments; existing pure agent-resolution and skill-binding primitives remain useful lower-level building blocks, not alternate high-level policy APIs. Public tools/workerTools/bindings/skillsFor input lanes are removed. Core receives only resolved `ConversationSetup`s and `KaenoExtension` runtime registrations. The existing core type name is retained; its role is explicitly runtime integration.

Worker approval comes from role availability, independently of current defaults, selected workers or per-agent narrowing. This preserves saved WORK's frozen participant plans and existing upper-bound checks. Per-agent narrowing applies to newly resolved profiles, not a new historical revocation system. Pending CHAT retains saved setup; idle CHAT refresh follows existing behavior. Native dependency, binding-owner, binding-version and execution-identity checks precede starts/resume. Shutdown remains abort, harness quiescence, reverse cleanup.

Execution environments and delivery remain separate runtime capabilities. GitHub's startup repository reader stays explicitly wired separately from agent contributions. No plugin discovery, arbitrary module imports, closed extension-name enum, transport protocol or second public composer is introduced.

## Synthesis decision

See [arena record](extension-contributions-arena.md). Candidate 2 is the base. Graft Candidate 1's ownerless binding output and smaller migration scope. Omit Candidate 2's new public `composeAgents`, duplicate agent-input representation and gratuitous core type rename. Preserve native durable execution instead of wrapping its framework concepts.

## Tradeoffs accepted

- Availability and defaults are distinct lists because approval and default assignment are different application decisions. Named selectors are policy restrictions, not duplicate tool definitions.
- The extension-layer contract depends on the existing skill catalog; core remains ignorant of skill/file types.
- Native skill defaults now obey exact explicit `skills` overrides instead of the old additive `skillsFor` hook. Unselected GitHub contributions no longer inject unused private bindings. Saved formats are unchanged.
- Extensions are trusted application code, not sandboxed plugins. Model-facing tool selection is not isolation against arbitrary native transactions.

## Alternatives considered

- Whole-extension assignment/default/WORK-approval lists: repeated three-way policy and no granular ceiling; rejected.
- Extension callbacks that choose their own tools/audience: split authority and implicit self-grant; rejected.
- A core-generic contribution/plugin registry: duplicates native runtime concepts and pulls skills orchestration into core; rejected.
- Host adapters maintaining tool names/private bindings: perpetuates the original ownership leak; rejected.

## Principles

**Boundary discipline:** extension configuration and saved data are validated by their owners; core handles generic invariants. **Foundational thinking:** native definitions and immutable catalogs determine ownership before policy resolution. **Laziness protocol:** retain existing runtime/low-level primitives, remove parallel host inputs, avoid an additional public composer. **Encode lessons in structure:** binder output cannot choose its owner, binding producers require a validator, and tests enforce unassigned/override/ceiling behavior.

## Risks and verification

Named tool ceilings should be used when new discoveries require explicit review. Saved WORK can fail closed when its role ceiling shrinks; finish/cancel old work rather than silently broadening it. Large skill assignments retain existing snapshot limits. Tests cover policy subsets, binding activation, exact overrides, per-agent narrowing, collisions, saved skills without producers, native lifecycle and execution-provider regressions. Verification results are recorded in the arena record.
