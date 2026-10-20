# Agent extension boundary

An extension offers **tools and skills** to agents and owns its implementation: configuration, clients, business rules, authorization and private durable state. A small runtime projection supplies native durable definitions, binding validation and optional lifecycle integration. Core consumes resolved conversation setups and runtime projections, not skill catalogs or extension-specific configuration.

## Install, permit, select

These are separate decisions:

| Term      | Meaning                                                                           |
| --------- | --------------------------------------------------------------------------------- |
| Installed | Native definitions and skill packages exist for composition and recovery          |
| Available | Application policy permits a role or agent to select a contribution               |
| Default   | Selected only when the corresponding agent profile field is omitted               |
| Assigned  | The exact resolved tools and skills saved with a conversation or WORK participant |

`loadEnvironment` is the high-level composition entry point. For example:

```ts
import { loadEnvironment } from "../src/host/composition/index.ts";
import { loadGitHubConfiguration } from "../src/extensions/github/index.ts";
import { browserExtension } from "../src/extensions/browser/index.ts";

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

Without policy additions, these extensions are installed but contribute nothing to agent assignments. The standard policy includes WORK orchestration and skill readers for CHAT, coding/WORK/skill readers for workers, and available file-source skills with no default skill assignments. Browser remains excluded from the assistant even if its profile requests a browser tool. Browser also checks the sandbox requirement during execution; policy does not replace that safety boundary.

`available` and `defaults` accept:

- An installed `AgentExtension` object: all of its native tools and catalog skills.
- `{ tools: ["github_list_repositories"] }`: exact native tool names.
- `{ skills: ["guides:review", "local:*"] }`: catalog references, with existing qualified-name/wildcard rules.

Named selectors can combine `tools` and `skills` in one object. Policy resolution reads IDs, not package snapshots: the 8 MiB limit applies to an actual assigned skill binding, not the full available catalog.

Whole-extension selectors deliberately include future additions or newly discovered tools. Use named availability selectors when additions require review. A selector must refer to the actual installed object, not another object with the same name. Unknown names, ambiguous skill aliases, duplicate owners/definitions and defaults outside availability fail composition. Wildcards resolve against the complete catalog before permission checking; forbidden members are errors, not silently filtered results.

Profiles independently override default fields:

```yaml
tools: []
skills: [guides:review]
```

This assigns knowledge and **zero tools**, not even `read_skill`. The existing skills runtime presents model-invocable guidance inline when no reader is selected. `skills: []` likewise suppresses default skills. Skills never select tools, grant access or expand availability.

An optional `forAgent(target, rolePolicy)` on the returned policy can narrow role availability or change defaults within it. `target` contains a qualified agent ID and role. It cannot broaden role permission. WORK's approved tool surface comes from worker-role availability, not defaults, selected profiles or per-agent narrowing; this preserves frozen saved participant plans.

## Author an extension

`AgentExtension` is exported from `src/extensions/contributions/index.ts`:

- `runtime`: the existing `KaenoExtension` runtime integration.
- `skills?`: an immutable `SkillCatalog` produced by the extension.
- `bind?`: a pure private-context snapshot factory receiving only this owner's selected tool/skill IDs. A binding producer must provide `runtime.validateBinding`.

There is no separate `tools` inventory. Native `runtime.durable.tools` is authoritative for definitions, execution and composition. Dynamic discovery, such as Browser's MCP schemas, completes before composition.

A skills-only extension may return `{ runtime: { durable }, skills: catalog }` with no native tools or private binder. It does not construct another skill runtime. Selected packages from all sources aggregate into the single shared `kaeno-skills` snapshot binding.

Private binding producers return only `{ version, value }`, or `undefined`. Composition stamps `runtime.durable.name` as owner, validates the payload and invokes that owner's validator. A producer runs once per effective assignment, only if at least one of its contributions was selected. Installing or approving GitHub without selecting a GitHub contribution creates no private installation binding. A binding can never add tools or skills.

The runtime projection can contain native tasks, sections, hooks and wrappers needed to implement the feature. These retain their native durable identities; there is no second plugin framework. `start` runs only after recovery checks and before scheduling resumes. Close aborts services, waits for durable invocations to stop, then disposes resources in reverse order. Extensions must clean up partial initialization if their own start throws before returning cleanup.

## Recovery and infrastructure

Core stores opaque owner/version/value bindings and validates them through installed owners. Saved skill documents, assets, hashes and provenance are immutable snapshots; recovery does not reload producer catalogs or source files. A skills-only producer can disappear while old knowledge remains readable through the installed catalog-free skills runtime. Native definitions or private binding owners required by saved work cannot disappear silently.

New policies govern newly composed profiles. Pending CHAT and frozen WORK retain their saved assignments; narrowing the worker-role ceiling can fail saved WORK recovery. This is not a new per-agent historical revocation system. Extension authorization, such as GitHub's installation access, is still checked by its operations.

Execution environments and delivery are separate runtime capabilities, not tool/skill bundles. GitHub's repository reader is a separate startup capability. Explicit execution-provider installation and the Docker/`./docker.json` default are unchanged. See [execution](execution.md), [GitHub](github.md), and the [design and arena decision](design/extension-contributions.md).

Native extensions are trusted process code. This boundary controls agent composition; it does not sandbox extension implementations or permit executable plugins from Markdown.
