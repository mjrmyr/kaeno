# AgentFactory: minimal composition slice

## Caller first (agreed sketch, before implementation)

```ts
const factory = new AgentFactory({ config, skills, work, sandboxCwd });
const agents = createAgents({ config, skills, factory, /* lifecycle deps */ });
// threads' existing transaction + idle gate:
const bound = await factory.configure(tx, id, { role: "chat" }, agents.Kaeno);
// Agents' real metadata adapter:
const root = await factory.configure(tx, id, { role: "work", blueprint }, Kaeno);
state.skills = root.skills; // same result used by configuration
// only after Agents authorizes a direct delegate and finds no existing child:
const child = await factory.configure(tx, id, { role: "worker", agent, blueprint }, Kaeno);
```

```ts
type BoundAgent = { template: Template; skills: SkillBinding };
type AgentSelection =
  | { role: "chat" } // always config.agent
  | { role: "work"; blueprint: WorkBlueprint } // only frozen root
  | { role: "worker"; agent: string; blueprint?: WorkBlueprint }
  | { role: "legacy"; agent: string; blueprint?: WorkBlueprint };
class AgentFactory {
  constructor(deps: { config: Config; skills: SkillCatalog;
    work?: Pick<WorkController, "extension" | "tools">; sandboxCwd?: string });
  bind(agent: string, blueprint?: WorkBlueprint): BoundAgent;
  configure(tx: Tx, id: ConversationId, selection: AgentSelection,
    kaeno: Extension): Promise<BoundAgent>;
}
```

## Runtime / ownership

```text
kaeno.ts --> Work (callbacks to Agents)
         --> AgentFactory(config, SkillCatalog, Work tools)
         --> Agents(factory, lifecycle dependencies)
channels --> threads -- idle gate / existing transaction --> factory.configure
                   \--> AgentState metadata from returned binding
Work checkpoints --> Agents.configureWork --> factory.configure
Agents.delegate -- runtime auth --> adopt existing child (NO configure)
                               \--> new child --> factory.configure
                               \--> AgentState + sandbox lifecycle
factory --> config templates OR validated frozen entry
        --> SkillCatalog.bind (live only)
        --> role policy + exact prompts/order/nulls --> SDK configure
```

Validated config templates already act as AgentRegistry; SkillCatalog.bind is SkillRegistry.
The private concrete role-tool function acts as PermissionRegistry, not a new interface.
The factory never imports/mutates AgentState, owns transactions, creates/submits conversations,
creates tasks or pods, or orchestrates durable work. WORKER is always a leaf. Legacy is
transient compatibility for no-role callers, never a persisted role.

Persisted blueprints cross a replay boundary (execute replay can bypass schemas): a selected
entry validator next to WorkBlueprint/workRoot validates map identity, consumed template fields,
coding tools/sandbox relationship, and bound skill representation. Root resolution, bind, and
frozen delegate descriptions share it. Missing/malformed frozen entries fail closed; no live
lookup/catalog fallback. Agents still checks CHAT/WORKER restrictions, WORK blueprint/root,
direct caller allowlist (not transitive graph membership), then target before child adoption.
Capture still clones templates and records visited nodes before recursion (including self-cycles).

## Synthesis / scope

A (chosen): single concrete composition/configuration factory, reusing the three existing registries.
B (rejected): move lifecycle/orchestration into factory and persist extra permissions; increases
reader load and changes durable semantics. Foundational thinking fixes BoundAgent/selection first;
laziness deletes agentChange/bindSkills rather than adding aliases; reader-load minimization
makes one configure result the source of persisted skills. Boundary discipline keeps replay
validation local, not a duplicate full config schema.

Spawn/start orchestration is deferred. No prompt/config rewrite, schema/version broadening,
dependency upgrades, deployment, or secrets changes. Templates/delegates/skills plus AgentDoc
are frozen; executable role policy is NOT version-frozen, so later code changes may affect replay.
#5 is already merged: preserve selected-root and unconditional leaf compatibility.
#6 logging overlaps only kaeno.ts composition wiring; do not alter or merge its work.

## Implementation / verification

Implemented this sketch in src/agent-factory.ts. Agents now receives the factory; no
agentChange/bindSkills aliases remain. configureWork still writes real WORK metadata;
new workers and threads persist the exact configure result. Adoption bypasses configure.
The selected-entry validator is frozenEntry in work.ts; workRoot additionally checks
image/cache metadata. It checks consumed representations, not the entire config or
artifact integrity schema. Frozen lookup and live lookup require own map entries.

Verified on Node 24.21.0 from main 746a73614b326e573a34782cb41be8469d73493c:
- Baseline: npm ci + check + test, 100 tests / 13 files passed (22.68s).
- Implementation: npm ci + check + test, 124 tests / 14 files passed (22.95s).
- 24 new factory cases: role/template matrix; SDK inherited-tool/cwd/thinking clearing;
  live lookup errors; frozen lookup with forbidden live catalog; self-cycle capture;
  malformed root/delegate identity, tool/sandbox, model, thinking, descriptions and skills;
  single binding persisted for CHAT/WORK/WORKER; existing worker adoption without configure.
- Existing direct-vs-transitive permission and unconditional worker-leaf tests retained
  through API adaptation. All SQLite reopen, pod replay and receipt-first assertions intact.
- Checked work.ts lifecycle suffix and threads idle gate byte-identical to main; role
  prompts unchanged. Full diff reviewed and git diff --check passed.
- npm ci: 139 packages added / 140 audited; unchanged 1 moderate + 2 critical findings.

No architectural deviations. Sketch artifacts live in the existing architecture directory.
No design runners were available; used the caller-approved A/B synthesis and direct review.
No real cluster/deploy validation was attempted. Homelab remained clean at
47a801370902f58bdc43d064b5a01f1bfc17684a. Rechecked main/#5/#6: supplied SHAs unchanged.
