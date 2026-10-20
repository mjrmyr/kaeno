# Repository-backed agent and skill definitions

> Historical design: the native contribution hooks and host composition API below are superseded by [extension contributions](extension-contributions.md). Source acquisition, immutable snapshots and provenance remain in place.

**Status: implemented in the current working tree and homelab PR #11.** This replaces the init-container-centric approach. Local Kaeno, Docker hosts, and Kubernetes use the same loader. The source runtime remains local/unpublished; the homelab PR stays suspended and pinned to the legacy image until a compatible image is deliberately published.

## Problem

We have source discovery, immutable skill catalogs, resolved agent setups, and frozen WORK plans, but no remote definition resolver. Worse, the assistant bypasses the agent catalog and must come from a special local `AGENT.md`. Deployment manifests currently compensate by downloading skills, distributing agent files, and repeating skill selections.

Kaeno should own source acquisition and selection. A deployment should supply configuration, credentials, and persistent storage—not implement the resolver. GitHub and filesystem details remain outside durable core.

## Usage: the owner's view

One owner-controlled configuration declares what can be loaded and what will actually run:

```json
{
  "sourceDirectory": "/var/lib/kaeno/sources",
  "agentRepositories": ["mjrmyr/myriad"],
  "skillRepositories": ["mjrmyr/myriad"],
  "kaeno": {
    "agent": "mjrmyr/myriad:kaeno",
    "skills": ["mjrmyr/myriad:p-mode", "mjrmyr/myriad:how"]
  },
  "workers": ["mjrmyr/myriad:swe"]
}
```

**The example proposes adding `kaeno` and `swe` agent packages to Myriad; it does not claim those agents exist there today.** A separate agent repository works identically. The same repository in both lists is resolved once per load, at one commit.

Proposed source layout:

```text
myriad/
  agents/
    kaeno/AGENT.md
    swe/AGENT.md
  skills/
    p-mode/SKILL.md
    how/SKILL.md
    ...
```

The remote SWE profile declares its own assignments, rather than the deployment copying them:

```markdown
---
name: swe
description: Implement, debug, and review software changes.
model: openai/gpt-6.1-sol
skills:
  - mjrmyr/myriad:*
---

Follow p-mode. Work on a separate branch, verify changes, and report evidence.
```

There is no need to enumerate the current 20 skills in homelab. `:*` is an explicit choice to include the repository's valid skill set when the next configuration is loaded.

### Running locally or on Kubernetes

```sh
KAENO_CONFIG=./.kaeno/config.json npm start
```

Locally, set `sourceDirectory` to a persistent directory, such as `./sources` relative to the configuration file. In Kubernetes, mount a writable host-only PVC at `/var/lib/kaeno/sources`. The loader is identical; it does not know what a PVC is.

Execution selection now belongs to the owner config's `execution` field, with Kubernetes-specific settings in a separate referenced file (see [execution configuration](../execution.md)); `KAENO_GITHUB_CONFIG` remains the existing optional GitHub App integration. Sources and role selection belong together, but they do not need to absorb unrelated backend and credential schemas.

### Explicit selection rules

| Input                       | Meaning                                                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentRepositories`         | Makes agent definitions available in the catalog; does not expose every agent as a worker.                                                                  |
| `skillRepositories`         | Makes skill packages available; does not assign all of them.                                                                                                |
| `kaeno.agent`               | Required, fully qualified agent identity used for the assistant.                                                                                            |
| `kaeno.skills` omitted      | Use the selected agent's declared skill defaults.                                                                                                           |
| `kaeno.skills` present      | Replace those defaults with this list. `[]` removes source-assigned skills, not native extension contributions.                                             |
| `workers`                   | Concrete, fully qualified worker IDs. Omitted or `[]` means no new workers; installed WORK definitions and saved-work recovery remain available.            |
| Worker skills/model/tools   | Come from each selected remote/local agent profile, with normal host defaults for omitted fields. There is no deployment-side per-worker override language. |
| `defaultModel`, if provided | Fallback for any definition without a model. Workers do not implicitly inherit the selected assistant's model.                                              |

Selected agents must resolve successfully. A selected worker that is unavailable is a configuration error, not a silently omitted worker. Unselected malformed packages may be reported as diagnostics without blocking unrelated valid selections.

Native extension instructions, such as GitHub tool guidance, are a separate channel and remain additive. They are not repository skills. If trusted composition supplies actual built-in skill snapshots, those are merged with source assignments before creating **one** skills binding. User selection cannot replace a native contribution by accidentally creating another binding with the same owner.

Explicit agent `tools` lists—including `[]`—remain exact and must pass installed/host-approved tool checks. Skills never grant tools. Selecting a remote agent is an owner trust decision: its prompt, model, and requested tools are configuration data, not automatically trusted native code.

## Repository and identity rules

- Preserve the useful legacy shorthand: `owner/repo` or `owner/repo:ref`. Normalize GitHub repository identity to lowercase; preserve ref case. Omission means the remote default `HEAD`, not `main`.
- Also accept `{ "repository": "owner/repo", "ref": "...", "path": "agents" }`. `path` restricts discovery to a safe relative subtree. The same form works in either repository list.
- Branches, tags, and HEAD resolve to a concrete commit on refresh. Only a full commit ID is a content-stable pin. Ambiguous short branch/tag names must be qualified with `refs/heads/` or `refs/tags/`.
- One requested ref per repository across both lists. Matching declarations share the same export; conflicting refs fail before fetching. Paths may differ by kind. Multiple versions under the same identity are not supported initially.
- Stable definition IDs are `owner/repo:name`, using frontmatter `name`, not directory name. A ref change does not rename an agent or skill. Local IDs remain `alias:name`.
- Without a `path`, discover the requested manifest recursively in tracked non-hidden paths, including a repository-root manifest. This retains legacy repository-layout flexibility. Reject overlapping same-kind package roots; allow sibling or independent agent/skill roots in one repository.
- Duplicate names invalidate the affected identity; never pick a winner. Qualified IDs distinguish repositories. Bare references inside profiles remain valid only when globally unique; owner selections are qualified.
- Expand only skill selectors of the form `source:*`. Preserve selector order, sort wildcard members, deduplicate overlaps, and fail empty matches. A wildcard must not silently drop malformed packages in its source. Persist concrete IDs and bytes, never wildcard expressions.

### Local definitions

Configured loading also accepts explicit local catalogs:

```json
{
  "sourceDirectory": "./sources",
  "localDefinitions": {
    "agents": [{ "alias": "local", "directory": "./agents" }],
    "skills": [{ "alias": "local", "directory": "./skills" }]
  },
  "kaeno": { "agent": "local:coordinator" },
  "workers": ["local:swe"]
}
```

Local directories use existing `directorySource` package conventions. Paths resolve relative to the configuration file, without shell/environment interpolation. Local packages are captured before catalog interpretation; detected editing races fail that load rather than claiming a filesystem-wide atomic snapshot.

Remove the special assistant-file path and implicit home/project/dedicated-skill precedence from the configured CLI. Existing local users migrate their assistant into an ordinary named catalog package and select it. Do not maintain a second legacy loader with different assignment rules.

## Shape and ownership

```text
Owner configuration
    |
    v
Optional composition: loadEnvironment
    |-- GitHub repository reader: network, authentication, sanitized Git
    |-- host source cache: private staging -> immutable exports
    |-- DefinitionSource views for both manifest kinds
    v
Existing agent/skill parsing and catalogs
    v
Select Kaeno + workers; bind skills once; record provenance
    v
ConversationSetup + Participants + installed native extensions
    v
Unchanged durable core: CHAT, admission, saved bindings, frozen WORK plans
```

| Module                            | Owns                                                                                                                                                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/composition/environment.ts`  | Strict owner configuration, selected roles, defaults, source orchestration, and the one public environment-loading operation. Refactors/replaces the current `files.ts` policy rather than wrapping it as another pipeline. |
| `src/definitions/repositories.ts` | Private persistent cache, immutable exports, source-set bookkeeping and publication. Consumes a host repository-reader port; knows neither App credentials nor Kubernetes.                                                  |
| `src/definitions/directory.ts`    | Existing directory source; remote exports are exposed through the same `DefinitionSource`/`DefinitionPackage` boundary with appropriate recursive discovery. Keep the public port, not Git workspaces.                      |
| `src/github/definitions.ts`       | Concrete GitHub reader, URL/ref validation, public/private authentication, safe materialization and error redaction. No reuse of full-history coding bundles as a definition cache.                                         |
| `src/agents/`                     | Existing pure agent parsing and setup/participant resolution; selected definitions retain their original catalog identities.                                                                                                |
| `src/skills/`                     | Existing inspection, catalogs, concrete selector expansion, contribution union, binding size checks, and catalog-free readers.                                                                                              |
| `src/definitions/origin.ts`       | Small catalog-free native provenance binding/validator. Installed by composition before the harness opens.                                                                                                                  |
| Core features                     | Existing resolved setup, tool/owner validation, admission and recovery. No repository, filesystem, cache, or GitHub-specific types/imports.                                                                                 |

This keeps Candidate A's acquisition/catalog boundary. It does **not** introduce a new live catalog service, worker cache mounts, or a release-artifact framework. One small completed-load manifest prevents offline startup from accidentally combining the partially updated per-repository pointers of a failed load.

### Public type sketch

The proposed signatures below are a design contract, not implemented exports. Existing public types are reused.

```ts
type RepositoryDeclaration =
  string | { repository: string; ref?: string; path?: string };

interface OwnerEnvironmentConfig {
  sourceDirectory: string;
  agentRepositories?: readonly RepositoryDeclaration[];
  skillRepositories?: readonly RepositoryDeclaration[];
  localDefinitions?: {
    agents?: readonly { alias: string; directory: string }[];
    skills?: readonly { alias: string; directory: string }[];
  };
  kaeno: { agent: string; skills?: readonly string[] };
  workers?: readonly string[];
  defaultModel?: string;
}

// Consumer-owned in definitions. A trusted host capability, not an agent tool.
interface RepositoryReader {
  read(
    request: { repository: string; ref: string },
    destination: string,
    signal?: AbortSignal,
  ): Promise<{ commit: string }>;
  // Produce only a regular-file export in private destination; never retain
  // credentials, .git metadata, hooks, submodule/LFS execution, or unsafe links.
}

interface LoadEnvironmentOptions {
  configFile: string;
  sourceMode?: "refresh" | "offline"; // Default refresh.
  repositoryReader?: RepositoryReader;
  extensions?: readonly KaenoExtension[];
  tools?: readonly string[];
  bindingsFor?: (agent: AgentDefinition) => readonly Binding[];
  skillsFor?: (
    agent: AgentDefinition,
    role: "assistant" | "worker",
  ) => readonly BoundSkill[];
  environment?: WorkEnvironment;
  maxDepth?: number;
  maxConcurrent?: number;
  signal?: AbortSignal;
}

interface LoadedEnvironment {
  assistant: ConversationSetup;
  extensions: KaenoExtension[];
  work: WorkOptions;
  diagnostics: readonly Diagnostic[];
}

async function loadEnvironment(
  options: LoadEnvironmentOptions,
): Promise<LoadedEnvironment> {
  throw new Error("not implemented");
  // Validate config -> prepare immutable source views -> parse catalogs ->
  // select/resolve roles -> validate contributions -> publish successful-load
  // record -> return the existing core contracts. No public stage handles.
}

function githubRepositoryReader(options?: {
  app?: { appId: string; installationId: number; privateKey: string };
}): RepositoryReader {
  throw new Error("not implemented");
}
```

`DefinitionPackage` gains optional origin metadata so existing local packages remain readable. Repository packages always carry repository, requested ref, resolved commit, and package path. Catalog inspection supplies content hashes. `skillsFor` is a narrow trusted composition hook, not an `extensions` registry or authority grant; `bindingsFor` remains for other owners and rejects a competing skills-owner binding.

### Embedding call sites

```ts
// Local host: same returned contracts as current file composition.
const configuration = await loadEnvironment({
  configFile: "./.kaeno/config.json",
});
const core = await openKaeno({ ...configuration, storage, models });
```

```ts
// Kubernetes remains an independently selected execution backend.
const backend = await loadKubernetesConfiguration(backendFile, {
  defaultNamespace: "application",
  createEnvironment: createEnv,
  createSandboxEnvironment: (options) => new SandboxWorkEnvironment(options),
});
const configuration = await loadEnvironment({
  configFile: "/etc/kaeno/config.json",
  extensions: backend.extensions,
  environment: backend.environment,
});
const core = await openKaeno({ ...configuration, storage, models });
```

```ts
// A private-source reader can be used without installing GitHub worker tools.
const configuration = await loadEnvironment({
  configFile,
  repositoryReader: githubRepositoryReader({ app: hostAppCredentials }),
  ...nativeInputs,
});
const core = await openKaeno({ ...configuration, storage, models });
```

Existing GitHub App CLI composition can return this reader alongside its current tools/bindings when enabled. App authentication remains owned by `src/github/`; source resolving does not interpret App keys or introduce per-agent repository authorization.

## Cache and lifecycle

### One owner, immutable readers

Only host source loading writes the cache. Workers never mount it. Use private `mkdtemp` staging and publish content-addressed regular-file exports under the same filesystem by rename. Catalogs inspect only completed immutable exports, then copy their content into existing setups/bindings.

Serialize writers with the **existing `proper-lockfile` dependency**, already used by the provider credential store. Do not promise unavailable built-in Node kernel `flock`. Use its heartbeat/stale-lock behavior, abort preparation on lock compromise, and check cancellation/ownership before publication. Support a single active host with occasional competing startups, not active-active shared-PVC deployment. Filesystems must support the locking library's atomic directory operations and same-filesystem rename; this requires real filesystem/process tests.

Do not delete another process's staging directory automatically. Each invocation removes only its own staging on normal exit; crashed leftovers and retained snapshots are removed by explicit maintenance with all hosts stopped. No reader leases or automatic GC are needed initially because published exports are never mutated or automatically deleted.

### Publication

1. Normalize declarations and reject conflicting refs/unsafe paths before network access.
2. Read each unique repository once into private staging; capture local inputs safely.
3. Verify concrete commits, safe files, file/size budgets, and export hashes; publish immutable exports idempotently. Revalidate an existing hash destination rather than trusting its name.
4. Use `DefinitionSource` views to parse catalogs, resolve all selected roles/skills, combine native contributions, and check final binding sizes.
5. Only after successful resolution, atomically publish a small **completed-load manifest** containing the source recipe, concrete pins, export hashes and discovery-format version. Update its recipe-keyed pointer last, with file/directory sync.

The manifest records raw source inputs, not another copy of compiled `ConversationSetup` or a new public catalog product. Several repositories cannot be fetched at a globally simultaneous upstream instant; the guarantee is one recorded, fully resolved input set per successful load.

A failed load may leave unused complete exports, but cannot replace the last successful input-set pointer. A crash cannot advertise half-written trees. Corrupt data fails verification; refresh rebuilds through new private staging, never in-place repair. Offline use refuses corruption.

Retain current manifest/package/skill/binding limits. Add bounded export bytes/file counts, a 120-second Git-operation timeout, cancellation, bounded redacted diagnostics, and staging-disk monitoring. Monitoring is not a hard Git pack-size limit; filesystem/PVC quota is the hard disk boundary. Completed snapshots are retained initially, so storage usage needs monitoring and documented stopped-host cleanup. Prefer separate source-cache storage when filling it could endanger the runtime database.

### Refresh, offline, and errors

- Default **refresh** resolves all configured repositories, including commit pins, on startup/load. This preserves legacy freshness/access-check behavior. There is no watcher, per-turn fetch, or hot reload.
- `KAENO_SOURCE_MODE=offline` / `sourceMode: "offline"` performs no network access. It requires the last verified complete input set for the exact normalized source recipe, including refs and discovery roots. Local inputs are also read from that captured set, not silently refreshed.
- Current role selections are applied against that cached set. Changing only selection can work offline if the requested definitions are present. Changing sources/refs cannot silently fall back to another recipe.
- Never silently mix fresh sources with individual stale ref records. Never automatically activate stale code/knowledge after a network or authorization failure.
- Invalid configuration, any declared-repository transport failure, missing selected agent/skill, incompatible tools, or invalid explicit worker selection fails normal startup with an actionable source/selection error. Do not swallow these through today's diagnostic-only `packagesFrom` behavior.
- Malformed unselected packages remain diagnostics; duplicate identities are unavailable, not first-wins. Wildcards cannot hide malformed members by silently shrinking their selection.

## Authentication and trust

Legacy remote skills were deliberately **public-only**. Private source support is new scope, not inherited from worker GitHub tools.

The default reader uses public GitHub HTTPS with isolated Git configuration and no inherited credential helpers, askpass, tokens, hooks, prompts or custom filters. The optional App-backed reader obtains short-lived host credentials internally. It performs read operations only, even if the installation permits other actions. GitHub controls repository access; do not duplicate its authorization with per-agent policies or local permission lists.

Neither reader writes authorization into URLs, Git configuration, cache manifests, provenance, bindings, worker files or error output. Source exports contain no `.git` directory. Reject symlinks, special files, unsafe traversal, submodule entries and unsupported external-content indirections before publishing readable package trees. Repository `package.json`, install scripts and native extension declarations are never executed or installed.

Cached private bytes and saved bindings remain sensitive after remote access is revoked. Protect the host cache and SQLite/backups. Offline mode intentionally uses retained local content and cannot detect revocation; fresh loading rechecks access. Revocation does not erase already-admitted knowledge.

## Frozen work and provenance

Keep the existing guarantees:

- Root admission saves the complete participant plan and concrete skill snapshots.
- Children use that saved plan, never the current repository catalog.
- Saved skill readers need neither repository access nor cache paths.
- Startup still checks installed native definitions, exact tools, binding owners/versions, and execution-backend compatibility.
- Source updates affect future admission and existing idle-CHAT refresh behavior; active/pending CHAT and admitted WORK retain saved settings.

Add optional skill origin metadata to the existing skill-binding schema, preserving old records without inventing missing provenance. Add a small version-1 `kaeno-definition-origins` binding for the selected agent's identity, commit/path/content hash and effective owner selections. Its catalog-free validator checks shape, not equality with current repository refs. Install that native owner in every configured environment, even with no current workers.

Do not add Git fields to core `ConversationSetup`, change WORK into cache references, or treat a filesystem path as durable provenance.

### Source outage recovery is explicit

Saved content independence is **not** a guarantee that full normal boot succeeds without an assistant source. Normal loading still needs a valid selected assistant, from refresh or the complete offline input set.

If both sources and cache are unavailable, use an explicit recovery configuration selecting a known-good local assistant package, no remote repositories, no new workers, and a fresh writable temporary source directory. Keep all native owners/tools and the original execution backend needed by saved work installed. The same loader and existing `openKaeno` can resume saved work; idle CHAT adopts the selected local recovery profile. Do not add a hidden maintenance persona, automatic assistant substitution, or a second recovery-mode API.

This recipe must be tested with real SQLite, removed source repositories/cache, saved skill assets and a previously admitted child plan. Model credentials, missing native code, or an unavailable execution backend remain separate blockers.

## Scope and parity

| Capability                              | Legacy main                   | Current branch                        | Proposed                                                 |
| --------------------------------------- | ----------------------------- | ------------------------------------- | -------------------------------------------------------- |
| GitHub skill sources                    | Public, fresh startup fetch   | External init-container workaround    | Runtime-owned public and optional App-backed reader      |
| Git refs and default HEAD               | Yes                           | Outside Kaeno                         | Yes, with concrete pins recorded                         |
| Repository skill wildcards              | Yes                           | No native expansion                   | Restore deterministic `source:*`                         |
| Persistent source availability          | Retained selected skill trees | No remote source cache                | Immutable host cache and explicit offline input set      |
| Remote agent repositories               | No; inline templates          | No; directory sources only            | Same source mechanism as skills                          |
| Select sourced Kaeno agent              | No                            | Special local assistant file          | Explicit catalog ID                                      |
| Kaeno skill selection                   | Selected template's list      | Assistant frontmatter/dedicated roots | Owner selection with clear defaults and native additions |
| Frozen skills and child plans           | Legacy blueprint/cache        | Self-contained bindings/WORK plans    | Preserve current implementation                          |
| Source-independent normal boot          | No                            | Mandatory assistant can block it      | Explicit offline or local recovery configuration         |
| Telegram, schedules, artifact collector | Other coupled features        | Removed                               | Not resurrected inside source resolution                 |

This restores useful source-resolving scope and adds remote agents. It does not claim to restore every feature of the former application.

## Implementation and deletion plan (completed in the current working tree)

1. **Types and failing fixtures:** normalized repository declarations, identity/provenance, explicit selection semantics, wildcard rules and the reader port. Keep current runtime tests intact while building the new path against fixtures.
2. **Acquisition/cache:** implement the public reader, immutable export publication, real lock/cancellation behavior, completed-load pointer and offline mode. Add the App-backed implementation behind the same port; do not couple to coding bundles or require worker tools.
3. **One composition path:** refactor current file composition into `loadEnvironment`; remove the special assistant-file path, bind selected sourced agents for both roles, merge skills once, and persist origins. Migrate CLI/tests/docs together; no permanent compatibility loader.
4. **Prove recovery:** reopen SQLite with sources/cache gone using a local recovery profile, then resume frozen assets and children. Verify missing native owners still fail closed.
5. **Upstream profiles and homelab:** publish the selected agent packages to the owner's chosen repository. Replace homelab's source-clone init container, `MYRIAD_REV`, skill `emptyDir`, manual agent ConfigMap/files, synthetic home mounts, and expanded 20-skill list with one owner config and host-only cache PVC mount. Keep backend configuration separate.
6. **Cutover separately:** update the compatible image and validators, preserve the current migration gate and legacy PVCs/Secrets, then perform a deliberate deployment smoke test. No deployments, merges, credential publication or old-volume deletion are part of implementing the resolver.

## Verification contract

Use real local Git fixtures plus an injected reader for network/auth edge cases:

- Default-branch movement, branch/tag ambiguity, full pins, same-repository cross-kind deduplication, conflicting declarations and recursive/path-restricted layouts.
- Duplicate names, malformed unselected packages versus selected failures, empty/overlapping wildcards, links/special files, nested manifests, package/binding limits and changing local files.
- Writer races, process death before/after each publication boundary, lock compromise, cancellation, corrupt hashes/manifests, disk-full publication and stale private staging.
- No partially updated input-set pointer; exact offline matching; no network in offline mode; private access failure without leaking credentials or silently falling back.
- Additive native instructions and actual skill contributions with exactly one skills binding owner; conflicting same-ID content fails; explicit tools remain exact.
- Real SQLite source/cache removal recovery, retained binary assets/provenance, frozen child plans, and unchanged installed-native-capability validation.
- Render the simplified homelab Kustomizations, load their real owner configuration through the same resolver, and separately verify live TLS/DNS/CNI/image/provider behavior after deployment approval.

## Rationale

**Foundational thinking:** source availability, role selection, assigned knowledge and execution authority are separate data models. Reuse `DefinitionSource`, catalogs and `ConversationSetup` rather than turning deployment mounts into another catalog.

**Boundary discipline:** GitHub owns network/authentication, the optional host loader owns acquisition/configuration, and core sees only resolved setups and native binding owners.

**Laziness protocol:** one loading operation, one skills binding, no second override language, no installer, no worker cache mounts, no maintenance-agent framework, no new compiled-catalog product.

**Make operations idempotent:** immutable exports and last-pointer publication make repeated or interrupted loads converge without mutating trees being read by another runtime.

### Synthesis decision

Use the arena's **source-adapter design (A)** as the base; the independent judge scored it **19/25**, versus **18/25** for the prepared-generation design (B). Graft B's explicit model-default policy, concrete durable provenance owner, and source-independent recovery recipe—but not its maintenance-mode API. Retain one small completed-input-set record to avoid mixed offline source cohorts; this is private bookkeeping, not B's new public catalog lifecycle.

Simplify both candidate schemas: a concrete worker list, remote profiles as the agent-authoring source of truth, and one `kaeno.skills` override rather than extras plus per-worker override maps. This preserves the familiar omitted/explicit-empty selection distinction and leaves extension contributions additive.

The preferred Opus runner could not complete through direct Anthropic or OpenRouter because of quota/billing/in-flight limits. Two independent Sol runs and a separate Sol judge completed instead. This is an actual arena comparison with reduced model diversity, not a claimed cross-family consensus. See [the arena record](remote-definitions-arena.md).

### Tradeoffs accepted

- Explicit offline activation and local recovery in exchange for no silent stale inputs or assistant substitution.
- One requested ref per repository and no host override language in exchange for stable identities and understandable configuration.
- A serialized host cache and explicit stopped-host cleanup in exchange for avoiding distributed writers, reader leases and premature GC.
- Self-contained saved skill bytes in SQLite remain duplicated; the source cache does not replace durable snapshots merely to save disk.
- A small provenance binding adds a native owner that must remain compatible for recovery; core stays source-independent.

### Alternatives considered

- **Keep init-container preparation:** loses because every deployment must coordinate fetching, identities, role manifests and refresh policy. It is the rejected complexity, not a reusable resolver.
- **Lazy adapters with independent last-ref pointers only:** small, but a failed multi-repository refresh can leave an offline mixture that was never successfully resolved together. Keep adapters; add the completed-load record privately.
- **Prepared compiled-catalog generations plus maintenance mode:** hides more lifecycle behavior, but duplicates existing catalog/WORK responsibilities and introduces unnecessary owner concepts. The existing setup/binding boundary is sufficient.
- **CI-built environment bundles:** useful for a future distribution workflow, but makes the owner operate another build/distribution pipeline instead of configuring repositories directly.

### Open questions and risks

- Is `mjrmyr/myriad` the desired home for the new agent profiles, or should they live in a separate repository?
- Is the explicit `kaeno.skills` replacement policy the intended owner control, or is an additive-only policy preferred? The design chooses replacement to avoid two assignment knobs; native contributions remain additive either way.
- Which source-cache storage budget fits the homelab, given immutable retention and the decision not to add automatic GC initially?

### Next implementation step

Implemented the identity/provenance and fixtures, cache-backed GitHub reader and composition selection. The homelab PR removes deployment-side clone/config duplication and uses the same pinned repository profile configuration. Verification passed (`npm run verify`, 285 tests; the homelab validator loaded the pinned repository once, selected both profiles, resolved 20 concrete SWE skills, and successfully reloaded offline). The runtime source remains uncommitted/unpublished; live cluster deployment and image publication were not performed.
