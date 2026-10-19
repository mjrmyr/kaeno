# Flat agent records

**Status: proposed; design only.** No loader, agent profile, cache, deployment, or stored WORK data is changed by this PR. This proposal supersedes only agent layout/discovery portions of [repository-backed definitions](remote-definitions.md), not its skill-package, authority, or frozen-work contracts.

## Problem

An agent is a declarative record indexed by `(source namespace, name)`, not a directory package. Today Kaeno discovers `<directory>/AGENT.md`, derives identity from frontmatter, and never checks that the directory agrees with that name. The requested target is `agents/<name>.md`, with the filename and declared name agreeing. This is a discovery-contract change, not just a Myriad file move: current discovery, provenance, source recipes, tests, and pinned consumers all encode directory packages.

## Usage (caller’s view)

Proposed repository layout (illustrative, not production files):

```text
myriad/
  agents/
    kaeno.md
    swe.md
  skills/
    p-mode/SKILL.md
    how/SKILL.md
```

Illustrative `agents/swe.md`, using **Kaeno** metadata:

```markdown
---
name: swe
description: Implement, debug, and review software changes.
model: openai/gpt-6.1-sol
thinkingLevel: xhigh
skills:
  - mjrmyr/myriad:*
---

Follow p-mode. Work on a separate branch, verify changes, and report evidence.
```

The owner still selects `mjrmyr/myriad:swe`; WORK still starts that same ID. A path or ref is not part of the ID. Proposed configuration:

```json
{
  "sourceDirectory": "./sources",
  "agentRepositories": ["mjrmyr/myriad:<flattened-commit>"],
  "skillRepositories": ["mjrmyr/myriad:<flattened-commit>"],
  "kaeno": "mjrmyr/myriad:kaeno",
  "workers": ["mjrmyr/myriad:swe"]
}
```

`<flattened-commit>` is a placeholder, not a resolvable pin. Keep both declarations at the same ref: the existing configuration rejects conflicting refs for one repository across kinds. An embedding still calls `loadEnvironment({ configFile })` and receives resolved setups, never a live catalog handle. A local owner sets `localDefinitions.agents[].directory` to the actual flat agent root, e.g. `./agents`.

## Normative contract

### Roots and discovery

- An agent source has one exact discovery root. For a repository declaration with **omitted** `path`, the new default is `agents`. An explicitly supplied safe `path` is the exact flat root, not a parent to search recursively; explicit `""` means the repository root. Preserve omitted versus explicit-empty input during configuration normalization. This deliberately changes current agent defaults; skill defaults and recursive repository discovery are unchanged.
- A local agent directory is already the exact root. Do not append `agents` to it. Injected/embedded agent sources must satisfy the same file/name validation as captured sources.
- Enumerate immediate, non-hidden, regular files with the exact lowercase suffix `.md`, in deterministic lexical order. Never recursively discover agent records; never scan all Markdown in a repository. `skills/*/AGENT.md`, `SKILL.md`, README files outside the root, nested Markdown and `.claude/agents` are not alternate discovery locations.
- The root is dedicated to agent records: every immediate non-hidden `.md` file is a candidate and must validate. Put human README material elsewhere. Wrong-case suffixes such as `swe.MD` produce a diagnostic rather than a second convention. Hidden files and unrelated non-Markdown files are not candidates.
- Detect the former immediate-child `<name>/AGENT.md` shape under the configured agent root for a migration diagnostic, but never load it. Do not add recursive legacy scanning or a second loader. A mixed old/new root reports the legacy artifact; a valid new record remains usable. A selected legacy-only ID fails as unavailable with migration guidance.
- Missing roots contribute no records and a source-location diagnostic. A selected missing ID fails; unrelated valid selections may proceed. A root that exists but is a link, special file, unreadable, or unsafe is a source-boundary failure, not an empty catalog.

### Name and identity

- Preserve Kaeno’s existing discovery-name grammar: ASCII `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` (1–64 characters), case-sensitive. Do not replace this with Claude Code’s different name rules as an incidental migration.
- Parse through the existing safe YAML/JSON frontmatter boundary. Required `name` and `description` retain their current trim/validation semantics. Compare the filename stem exactly, case-sensitively, to that **parsed** name. No slugification, Unicode normalization, case folding, or deriving a missing name from the filename. Thus `swe.md` with `name: reviewer` is invalid, while `name: " swe "` retains today’s parsed value `swe`.
- The record ID remains `${source}:${name}`. Repository namespaces are lowercased by existing configuration; local aliases retain their existing case-sensitive grammar. Ref, checkout location, directory depth and cache hash never affect identity. The filename asserts the declared name; neither independently overrides the other.
- Distinct namespaces may contain `swe`. Duplicate IDs within a namespace invalidate **all** otherwise valid records for that ID; never first/last-wins. Report every conflicting location in sorted order. Duplicate source aliases remain configuration errors before catalog construction. Bare skill references retain their existing global-uniqueness rules; owner agent selections remain qualified.
- Known fields remain `name`, `description`, `model`, `thinkingLevel`, `skills`, `tools`. Preserve existing optional-field validation, inert unknown JSON metadata, Markdown body semantics, omitted defaults versus explicit `[]`, native additive instructions, and host tool approval. Do not interpret new Claude-specific keys by virtue of their presence.

### Security and resource bounds

Reject symlink roots, linked ancestor components during trusted capture, symlink candidates, special files, unsafe relative paths, traversal, Git metadata and unsupported submodule/external-content entries. Use existing immutable captured exports, with no-follow file opens and pre/post-read identity/size checks at the filesystem boundary; do not claim that a mere `lstat` followed by `readFile` closes a race. Local captures retain detected-edit failure semantics, not a promise of filesystem-wide atomicity. Injected source bytes have no authority to read arbitrary paths.

Retain current 256 KiB manifest limit, 512-record bound per source, strict UTF-8 and YAML restrictions (duplicate keys, aliases, custom tags), and 256 MiB/16,384-file export budgets. Count candidate attempts, not only valid records, toward the agent bound; limit diagnostics too. Bounded errors show source, actual file, expected versus declared name and remedy, never credentials or full prompt bytes. Frontmatter and prompt data never execute code, install tools, or grant filesystem/network capabilities.

## Shape

Keep acquisition/cache ownership in `extensions/definitions`, agent validation/catalog semantics in `extensions/agents`, owner selection in host composition, and core unaware of paths. Do not fabricate a directory per flat agent or change skill assets into flat files.

The following is a proposed API sketch, **not implemented exports**. Model the distinction at the source boundary rather than encoding a glob in the filename argument:

```ts
interface AgentDocument {
  readonly source: string;
  readonly manifestPath: string; // Actual location, e.g. agents/swe.md.
  readonly manifest: string; // Captured UTF-8 bytes decoded once.
  readonly origin?: DefinitionOrigin;
}
interface AgentSource {
  readonly alias: string;
  snapshot(): Promise<{
    documents: readonly AgentDocument[];
    diagnostics: readonly Diagnostic[];
  }>;
}

// Existing DefinitionPackage / DefinitionSource stay skill-package contracts.
// DefinitionSources.agents and LoadEnvironmentOptions.agentSources use AgentSource.
function parseAgentDocument(document: AgentDocument): AgentDefinition;
function parseAgentDocuments(documents: readonly AgentDocument[]): {
  agents: AgentDefinition[];
  diagnostics: Diagnostic[];
};
```

The parser receives the real path, validates its stem and frontmatter once, then constructs the unchanged `AgentDefinition`. Any retained low-level `parseAgent(text, source, location)` must enforce the same path/name contract or be private; it must not become a public bypass. `AgentSource.snapshot()` hides bounded enumeration/capture details; callers do not coordinate per-file reads, hashes or validation stages. Reuse internal capture, diagnostic and manifest helpers; do not build a generic package framework. The separate record shape avoids making every skill reader interpret an optional path or fake directory.

Pseudocode inside the existing load transaction:

```text
normalize config with agent-specific root default
capture unique repositories and local inputs through existing safe boundary
construct flat AgentSource views and unchanged skill package views
for each agent root, sorted:
  reject unsafe root/entries; diagnose immediate legacy packages
  read bounded candidate file -> capture its actual path and origin
parse all records -> validate basename/name -> group by source+name
remove every duplicate identity; preserve bounded, deterministic diagnostics
resolve selected assistant/workers and concrete skills; validate tools/bindings
publish completed source-input record only after successful resolution
return existing setups/extensions/WORK options
```

For repository agents, origin `path` becomes the repository-relative **file** path, e.g. `agents/swe.md`; local origin path becomes the original absolute file path rather than a cache directory. Agent `contentHash` is SHA-256 of the exact file bytes, including frontmatter/newlines; skill package tree hashing stays unchanged. The full export tree hash still keys immutable cached trees. Existing saved origin bindings are audit data and remain valid without rewriting: their older directory paths/tree hashes keep their original meaning. New file paths distinguish new records; document the hash convention rather than interpreting old hashes as file hashes.

## Cache and lifecycle

The current successful-load recipe hardcodes version 1 and raw normalized paths. Add a private discovery-policy discriminator (e.g. `agentLayout: "flat-v1"`) to the recipe hash and completed-load record validation. This is distinct from the origin binding’s version. Offline loading must not reinterpret a successful legacy cohort under the new policy: require an exact matching flat-policy completed load and emit `refresh required for flat agent discovery` on a legacy-only cache. Immutable raw export trees may be reused after verification; never mutate or automatically purge old cache trees or successful records. No automatic fallback to an old policy.

Refresh still resolves a repository once per configured ref for both kinds; moving branches are resolved only on load, not per turn. Additions/removals/renames appear when a new captured input set is successfully selected and published. A deleted selected agent fails refresh; it is never resurrected from the prior catalog. Failure cannot replace the last completed cohort, and refresh does not silently activate it. Offline mode intentionally retains its exact recorded snapshot until an explicit refresh.

No watcher, per-agent cache, hot reload, automatic GC, worker cache mount, or core schema migration is needed. Already admitted WORK and children retain saved prompts, tools, skill bytes and IDs without consulting the new path. Future admission uses the new resolved catalog; existing CHAT refresh semantics remain unchanged.

## Migration and compatibility decision

Recommend a **strict new reader with a coordinated, pinned cutover**, not indefinite dual-format support. This is a proposal for follow-up implementation, not permission to move production files now.

1. Implement flat source validation and failing acceptance fixtures in Kaeno; update injected-source callers/tests. Keep the old release available for rollback, not a compatibility branch inside the new reader.
2. In a separate Myriad implementation PR, move only `agents/kaeno/AGENT.md` to `agents/kaeno.md` and `agents/swe/AGENT.md` to `agents/swe.md`; preserve declared names and prompt/frontmatter bytes. Validate all flat records in CI with the same rules as the loader. Update authoring instructions/examples in the same change; do not move `skills/` packages or unrelated `AGENT.md` files.
3. Pin a compatible Kaeno image and the flattened Myriad commit together. Both repository lists must use the same Myriad ref. Update Kaeno examples, local definitions and homelab config validators/fixtures. Explicit old `path` values must become exact flat roots; an explicit `""` remains a root, not the new omitted default.
4. Refresh with the new policy in a non-production validation environment; verify concrete IDs/skills, origin file paths, all-record lint, offline reload and frozen-work recovery. A selected-agent failure must prevent completed-load publication.
5. Deploy only in a separately approved release operation. Verify homelab’s actual release state and explicitly gate the cutover; its README claims suspension but current main does not set `spec.suspend` (see impact map). No merge, image publication, rollout or stored-data rewrite is part of this design PR.

Rollback restores the previous image **and** its old Myriad pin/config as a pair; leave immutable old cache cohorts available. New-to-old path reinterpretation is not supported. This accepts a coordinated rollout boundary in exchange for one discoverable format. Owners needing staggered independent upgrades should pin the old release until ready, rather than depending on a permanent compatibility knob.

## Alternatives and synthesis

| Candidate                              | Shape / interface depth                                                                                                                                                                                                                               | Decision                                                                                                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: strict flat records                 | One exact agent root and one record contract hide enumeration, identity checking and diagnostics. No priority or format knob leaks to owners.                                                                                                         | Recommended base.                                                                                                                                                               |
| B: transitional dual-reader            | Discover both flat files and directory manifests, normalize both to records; reject cross-format duplicates, warn on old packages, remove old reader at a named release. Hides migration mechanics but exposes mixed-format collision/removal policy. | Credible for a staggered ecosystem; not justified for the small pinned deployment here. Borrow explicit legacy diagnostics and rollback discipline, not a second active reader. |
| C: recursive Markdown or manifest glob | Minimal apparent loader change, but makes every repository layout and skill-local instruction file part of agent policy; owners must understand exclusion rules.                                                                                      | Reject: leaks discovery complexity and creates accidental agents.                                                                                                               |

Red-flag screening: A has one identity writer, one admission path and no hand-synced filename/name registry. Agent validation owns the equality check; CI invokes that rule instead of copying it. Separate agent documents preserve skill-package ownership rather than adding optional fields every caller must interpret. No exported prepare/commit lifecycle or live catalog service is introduced. Two independent reviewers challenge current behavior and rollout assumptions; their evidence and final synthesis are recorded in the companion [impact map](flat-agent-records-impact.md).

**Foundational thinking** makes `(namespace, name)` the domain key and treats paths as validated representation/provenance. **Outcome-oriented execution** favors a verified paired cutover over throwaway compatibility code. The accepted tradeoffs are a breaking layout/default-root contract, a small separate record-source port, and preserving existing custom name/metadata semantics rather than claiming full Claude Code interchangeability.

## Acceptance and next step

The companion impact map defines test ownership and concrete pass/fail cases. Implementation is complete only when those cases and the existing `npm run verify` pass, Myriad’s actual flattened records pass the same validation, and homelab renders/validates the paired pins with an explicitly verified deployment gate. This PR validates documentation and the unchanged baseline, **not** the proposed algorithm.

Next implementation step: write failing source/parser fixtures for flat records, exact filename/name matching and skill non-discovery, then implement the record source and parser boundary together.
