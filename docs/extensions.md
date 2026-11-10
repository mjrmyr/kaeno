# Extension boundary

An extension owns its integration: configuration, clients, business rules, authorization and private durable state. It can offer **tools and skills** to agents, **definition readers** to startup composition, or both. A native runtime projection supplies durable definitions, binding validation and optional lifecycle integration when needed. Core consumes resolved conversation setups and runtime projections, not readers, skill catalogs or extension-specific configuration.

Channels are not extensions. `src/channels/` holds the ways the owner and their systems reach Kaeno: the HTTP API, Telegram and webhooks. Each owns its transport and its own check of who may send, and calls core through `src/core/application/index.ts`. Channels and extensions never import each other. Channels declare consumer-owned capability interfaces (for example `src/channels/api/ports.ts`); the host supplies extension implementations and starts the channels. Keep transport parsing and responses in channels, feature behavior in extensions, and genuinely shared application contracts in core.

Core-managed channels register through `OpenKaenoOptions.channels` as `KaenoChannel`, not through `extensions`. A channel can supply `delivery` (`ChannelDelivery`: send, optional typing and thread creation) and `start(core, signal)` returning optional async cleanup. Incoming-only channels need no delivery capability. Channels cannot register agent tools, execution environments or binding validators. Telegram uses this contract; the API and webhook HTTP servers remain host-managed. Channel state, such as Telegram offsets and reply mappings, remains channel-owned and does not require a native extension registration.

Delivery handlers are registered before recovery checks. Extensions start first, then channels, after recovery checks and before scheduling resumes. Close aborts their shared signal, stops durable work, then runs cleanup in reverse startup order. A channel must clean up its own partial initialization if its start throws before returning cleanup.

## Install, permit, select

These are separate decisions:

| Term      | Meaning                                                                              |
| --------- | ------------------------------------------------------------------------------------ |
| Installed | The integration's capabilities exist for their consumers; no agent access is implied |
| Available | Application policy permits a role or agent to select a contribution                  |
| Default   | Selected only when the corresponding agent profile field is omitted                  |
| Assigned  | The exact resolved tools and skills saved with a conversation or WORK participant    |

`loadEnvironment` is the high-level composition entry point. For example:

```ts
import { loadEnvironment } from "../src/host/composition/index.ts";
import { loadGitHubConfiguration } from "../src/extensions/github/index.ts";
import { browserExtension } from "../src/extensions/browser/index.ts";

const githubExtensions = [
  await loadGitHubConfiguration("./.kaeno/github.json"),
];
const browser = await browserExtension();
const configuration = await loadEnvironment({
  configFile: "./.kaeno/config.json",
  extensions: [...githubExtensions, browser],
  policy: (base) => ({
    assistant: {
      available: [...base.assistant.available, ...githubExtensions],
      defaults: [...base.assistant.defaults, ...githubExtensions],
    },
    worker: {
      available: [...base.worker.available, ...githubExtensions, browser],
      defaults: [...base.worker.defaults, ...githubExtensions, browser],
    },
  }),
});
```

Without policy additions, these extensions are installed but contribute nothing to agent assignments. The standard policy includes the routing tools and skill readers for the router, coding/WORK/ticket/skill readers for workers, and available file-source skills with no default skill assignments. Browser remains excluded from the assistant even if its profile requests a browser tool. Browser also checks the sandbox requirement during execution; policy does not replace that safety boundary.

`available` and `defaults` accept:

- An installed extension object: all of its native tools and catalog skills. A reader-only entry contributes neither.
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

## Owner-configured MCP

[Host MCP phase 1](mcp.md) adds one ordinary `kaeno-mcp-<id>` extension per configured server.
It derives role policy from independently reviewed tool permissions and registers the
allowlisted tools discovered from each server at startup.
It does not add core machinery or definition readers. Code-declared [WORK MCP](mcp.md#work-mcp-servers-in-the-sandbox)
recipes run stdio servers inside each WORK sandbox; Browser is the first. OAuth is not implemented.

## Author an extension

`AgentExtension` is exported from `src/extensions/contributions/index.ts`:

- `runtime`: the existing `KaenoExtension` runtime integration.
- `skills?`: an immutable `SkillCatalog` produced by the extension.
- `definitionReaders?`: named startup readers, independent of agent permissions.
- `bind?`: a pure private-context snapshot factory receiving only this owner's selected tool/skill IDs. A binding producer must provide `runtime.validateBinding`.

There is no separate `tools` inventory. Native `runtime.durable.tools` is authoritative for definitions, execution and composition. Dynamic discovery, such as Browser's MCP schemas, completes before composition.

A skills-only extension may return `{ runtime: { durable }, skills: catalog }` with no native tools or private binder. It does not construct another skill runtime. Selected packages from all sources aggregate into the single shared `kaeno-skills` snapshot binding.

Private binding producers return only `{ version, value }`, or `undefined`. Composition stamps `runtime.durable.name` as owner, validates the payload and invokes that owner's validator. A producer runs once per effective assignment, only if at least one of its contributions was selected. Installing or approving GitHub without selecting a GitHub contribution creates no private installation binding. A binding can never add tools or skills.

The runtime projection can contain native tasks, sections, hooks and wrappers needed to implement the feature. These retain their native durable identities; there is no second plugin framework. `start` runs only after recovery checks and before scheduling resumes. Close aborts services, waits for durable invocations to stop, then disposes resources in reverse order. Extensions must clean up partial initialization if their own start throws before returning cleanup.

## Definition readers

`InstalledExtension` accepts either an `AgentExtension` or a source-only `{ definitionReaders }` entry, with no runtime, skills or binder. `loadEnvironment` extracts all readers from this single installation list; only native runtime projections go to core. A whole-extension policy selector never grants or selects a reader.

Each reader implements `DefinitionReader` from `src/extensions/definitions/index.ts`: a nonempty `name` and `read({ repository, ref }, destination, signal?)`, returning `{ commit }`. It exports credential-free regular files into the supplied private directory. The existing cache owns bounded tree validation, content hashes, locking, atomic publication and immutable snapshots. This is a Git-shaped definition export contract, not a universal research-library or ingestion API.

Every repository declaration explicitly selects its reader:

```json
{
  "agentRepositories": [
    {
      "provider": "github",
      "repository": "owner/profiles",
      "ref": "main",
      "path": "agents"
    }
  ],
  "skillRepositories": [
    {
      "provider": "github-app-123",
      "repository": "owner/private",
      "path": "skills"
    }
  ]
}
```

`ref` defaults to `HEAD`, `path` to the repository root. The CLI installs `githubExtension()` without an App for public definition access only. A configured GitHub integration includes both the anonymous `github` reader and the `github-app-<installationId>` reader, plus its native agent capabilities. All are wired through `extensions: [...githubExtensions, browser]`; there is no separate reader argument or implicit GitHub construction in `loadEnvironment`.

Duplicate names (including unused readers) and unknown providers fail before acquisition, including offline loads. Selection is exact and case-sensitive; installation order and URL matching do not decide authority. Failures and cancellation never fall back to another reader. Public versus App access remains an explicit source choice even when an App is configured.

Repository/ref export keys, complete-load recipes and new provenance include the provider. Reader names identify stable, nonsecret source/authorization namespaces; use a different name when that namespace changes. Credential rotation within one namespace need not invalidate snapshots. The same repository/ref deduplicates across agents and skills only within one provider. Agent and skill aliases remain repository names; duplicate aliases within either kind fail rather than silently changing existing IDs. Different providers may supply the same alias across kinds; conflicting refs for one provider/repository still fail.

**Migration:** replace old `"owner/repo:ref"` shorthand and provider-less objects with explicit `{ "provider", "repository", "ref" }` declarations. Replace `repositoryReader`/paired GitHub loader results with the installed extension object. Refresh once after changing repository declarations: pre-provider remote cache recipes cannot satisfy the new offline recipe. Local-only caches and saved conversation/WORK snapshots remain valid; historical repository provenance may omit a provider.

## Recovery and infrastructure

Core stores opaque owner/version/value bindings and validates them through installed owners. Saved skill documents, assets, hashes and provenance are immutable snapshots; recovery does not reload producer catalogs or source files. A skills-only producer can disappear while old knowledge remains readable through the installed catalog-free skills runtime. Native definitions or private binding owners required by saved work cannot disappear silently.

New policies govern newly composed profiles. The router conversation is reconfigured when idle; frozen WORK retains its saved assignments; narrowing the worker-role ceiling can fail saved WORK recovery. This is not a new per-agent historical revocation system. Extension authorization, such as GitHub's installation access, is still checked by its operations.

Execution environments and delivery are separate runtime capabilities, not tool/skill bundles. Definition readers are startup capabilities of installed integrations, not agent tools. Explicit execution-provider installation and the Docker/`./docker.json` default are unchanged. See [execution](execution.md) and [GitHub](github.md).

Native extensions are trusted process code. This boundary controls agent composition; it does not sandbox extension implementations or permit executable plugins from Markdown.
