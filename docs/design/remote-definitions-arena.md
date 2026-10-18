# Remote definitions: arena record

Design: [Repository-backed agent and skill definitions](remote-definitions.md).

## Grounding

Read-only exploration traced the current source → catalog → setup → binding → frozen WORK flow, inspected legacy `main` source resolution and configuration, and reviewed the homelab draft's init-container workaround. The old application had public GitHub skill repositories, default-HEAD/ref selection, qualified skill selectors, wildcard expansion, and retained skill snapshots. It did **not** have remote agent repositories. Current skill readers and admitted child plans are already self-contained; mandatory assistant loading can still block host startup.

Artifacts for this run are under `/tmp/kaeno-source-design/`: `grounding.md`, `explore-current.out.md`, `explore-history.out.md`, and `explanation.md`.

## Candidates and judge

| Artifact                | Direction                                                                          | Completed runner          |
| ----------------------- | ---------------------------------------------------------------------------------- | ------------------------- |
| `candidate-a/design.md` | Git-backed `DefinitionSource` adapters, existing composition and catalog consumers | OpenAI GPT 6.1 Sol, high  |
| `candidate-b/design.md` | Prepared complete source generations, one broader environment loader               | OpenAI GPT 6.1 Sol, xhigh |
| `judgment.md`           | Independent read-only rubric evaluation of both completed artifacts                | OpenAI GPT 6.1 Sol, high  |

Both candidates were read in full and screened against the architect red flags. The judge inspected exact current code to resolve interface/recovery questions. Candidate A initially targeted Opus: direct Anthropic failed due to quota, and OpenRouter retries failed due to output-reservation/billing and in-flight-budget limits. No Opus artifact completed. A replacement independent Sol run produced A. This is reduced model diversity, not a cross-family verdict.

## Scores and selection

Parent review agrees with the independent judge's scores and base selection:

| Rubric axis, 0–5                         | A      | B      |
| ---------------------------------------- | ------ | ------ |
| Configuration and selection clarity      | 4      | 4      |
| Boundaries and existing-contract reuse   | 4      | 4      |
| Cache, recovery and security correctness | 3      | 3      |
| Functional completeness                  | 4      | 4      |
| Interface depth and subtraction          | 4      | 3      |
| **Total**                                | **19** | **18** |

**Base: A.** It better preserves the existing acquisition/catalog boundary and self-contained WORK machinery. B's broader loader is deep, but its new catalog lifecycle, strict unused-package rejection, and maintenance persona add ownership beyond the requirement. Neither candidate was implementation-ready unchanged.

## Grafts and corrections

From **B**, retain explicit model-default policy, a concrete catalog-free provenance owner, and an explicit local recovery recipe. Retain a private completed-load record so a failed refresh cannot leave the next offline load combining independently advanced source pointers. This does not require B's public generation product, compiled environment cache, or recovery-mode API.

Changes made during synthesis:

- Replace both candidates' broad worker override maps with a concrete worker ID list. Agent repositories remain the authoring source of truth.
- Use one `kaeno.skills` override: omission inherits source defaults, presence replaces them, and native contributions remain additive. Do not expose both override and extra/additive selection knobs.
- Specify the existing `proper-lockfile` dependency and its supported single-active-host model; reject both candidates' unsupported promise of built-in kernel-released Node advisory locks.
- Give private sources a concrete consumer-owned reader port and optional GitHub App implementation, separate from worker coding bundles/tools.
- Fail explicit selections and declared-repository failures rather than silently dropping selected workers. Leave unrelated malformed packages as diagnostics; fail wildcards that would silently omit malformed members.
- Keep one ref per repository, exact explicit tools, one skills binding owner, immutable readers, and host-only credentials.

## Rejected

- Init-container source resolution and deployment-maintained copies of agent manifests/skill lists.
- B's mandatory maintenance persona and second recovery API.
- A broad deployment-side model/tools/skills override language.
- Silent stale fallback, mutable cache checkouts, worker source-cache mounts, installer scripts and GC with new reader leases.
- Claims that all old application features or private-source behavior are existing parity.

## Verification

- The initial sketch typechecked against the current public interfaces before implementation.
- Implementation `npm run verify` passed: 34 test files / 285 tests, typecheck, lint, architecture and formatting.
- Homelab `validate.mjs` passed real pinned public repository acquisition once, profile/20-skill resolution, provenance, offline reload and rendered-resource checks. It correctly reports the legacy image blocker.
- No live cluster resources were applied, Secrets decrypted/read, or image published.

The initial arena pass changed no runtime/deployment files. The subsequent implementation pass changed runtime files and updated homelab PR #11; existing unrelated dirty work was preserved. No credentials were read or modified, and no cluster resources were applied.
