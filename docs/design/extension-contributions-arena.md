# Extension contributions: arena record

Design: [Extension contributions](extension-contributions.md).

## Grounding and runners

Traced host loading, native runtime installation, explicit CHAT/WORK selection, opaque bindings, immutable skill snapshots, GitHub authorization, Browser sandbox enforcement, frozen WORK plans and recovery/start/cleanup ordering. Baseline `npm run verify` passed (397 tests). Work began from merged PR #39 on main (`88d5bfa`), isolated on `feat/extension-contributions`.

Artifacts: `/tmp/arena-extension-boundary/` contains grounding, rubric, complete independent candidates and judgment.

- Candidate 1: OpenAI GPT-6 Sol, high; whole-offer assignment/default/WORK approval, additive assigned skills.
- Candidate 2: OpenAI GPT-6.1 Sol, high; available/default policy, native-name subsets, effective-assignment bindings and selectable skill catalogs.
- Independent judge: OpenAI GPT-6 Sol, high, read-only repository access.

Anthropic Opus 5.5 failed due to exhausted quota; an initial GPT-5.5 fallback was unsupported by the configured account. Initial OpenAI runs failed OAuth refresh because of network connectivity. IPv4-only per-process networking restored access. Both replacement candidates completed independently before judging; there is reduced model-family diversity, not a cross-family verdict.

## Scores and pick

Both candidates were read in full and screened against architect red flags. Parent agrees with the independent judge:

| Criterion (0–5)                      | Candidate 1 | Candidate 2 |
| ------------------------------------ | ----------- | ----------- |
| Boundary and interface depth         | 4           | 4           |
| Single source of truth / reader load | 3           | 4           |
| Permission correctness               | 2           | 5           |
| Recovery and ownership               | 4           | 4           |
| Implementability / subtraction       | 3           | 3           |
| Total                                | 16          | 20          |

**Base: Candidate 2.** It supports permission subsets independently of defaults and selected worker profiles, gives skills the same exact-override semantics as tools, and binds only actual contributions. Neither candidate ships unchanged.

## Grafts and rejections

From Candidate 1: ownerless private binding output stamped by the composer, and one private composition operation behind the existing environment loader. Keep direct core callers on resolved setups.

Reject Candidate 1's repeated three-list whole-extension policy and additive knowledge despite explicit `skills: []`. Reject Candidate 2's second public composer, parallel agent-input type and broad runtime type rename. Keep native definitions authoritative, avoid a plugin framework, and retain existing lower-level pure resolution/snapshot primitives where they do not create another high-level policy path.

Judge corrections adopted: validate selector identity and ceilings before binding production; check duplicate native/skill/owner names before indexing; scope read-only metadata to its owner; require binder validation; reject duplicate saved binding owners; retain catalog wildcard/invalid-source semantics and all lifecycle/recovery ordering.

## Progress and verification

- Ground, frame, independent fan-out, cross-judge, pick and design graft complete.
- User authorized implementation; no further checkpoint required.
- Implementation complete against the synthesized shape. No repeated architectural friction required scrapping/re-grounding.
- A separate read-only implementation review found that catalog availability accidentally used the 8 MiB assignment snapshot limit, and mixed named selectors ignored their skills. Fixed both at their owning boundaries: catalog ID selection is separate from snapshot binding, and named selectors consume both fields. Regression tests use real large source packages, small/empty/oversized assignments, and mixed selectors.
- Added frozen WORK private-scope recovery coverage: changed owner validation fails before provisioning, reconciliation or service startup, including a participant without a worker conversation yet.
- `npm run verify`: **417 tests across 45 files**, typecheck, lint, architecture (131 TypeScript files), formatting passed. `git diff --check` passed.
- Built current source image `kaeno:extension-contributions` and imported it into microsandbox. Real Docker and microsandbox delegated WORK passed through the new agent-contribution composition path: Linux, UID 1000, `/workspace`, empty skill discovery, Browser tools assigned to WORK but not CHAT.
- Real microsandbox lifecycle smoke passed guest Chromium navigation/JavaScript/session persistence/screenshots, provider adoption, stop/start, envd crash recovery, workspace persistence, active retention and orphan removal. Afterwards no microVM sandboxes or managed WORK containers remained.
- Independent follow-up review confirmed both fixes and the frozen-WORK regression coverage; no new concrete bugs were found in the reviewed paths.
- Native verification ran on macOS/Apple Silicon. Kubernetes configuration/recovery tests pass; no live cluster deployment or credentialed GitHub installation test was performed.
