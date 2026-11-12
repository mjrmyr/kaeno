# Behavior-first implementation dispatch

## Problem and ownership

A request such as “add `github_resume` to recover the PR of a finished worker” can turn an implementation accident into the requirement. The behavior is actually “another worker on the same ticket continues the PR; another ticket cannot inherit it.” Investigating who owns publication identity may eliminate the proposed tool entirely. [PR #82](https://github.com/mjrmyr/kaeno/pull/82) repairs that domain ownership; this workflow change neither implements nor depends on it.

The router cannot establish engineering evidence: it has no execution tools, and deliberately passes owner requests verbatim. The worker inspects architecture. Child admission is where an inspected problem becomes a delegated implementation, so that is where the behavior contract belongs.

## Usage: before and after

Before, this was a complete implementation handoff:

```json
{
  "agent": "local:mo",
  "title": "Recover PR",
  "brief": "Implement github_resume to recover finished workers' PRs."
}
```

Now `start_work` requires an explicit `assignment`. Research, reviews and other non-implementation work need only `"assignment": {"kind":"task"}`. If evidence is missing, investigate first with that branch. Implementation uses:

```json
{
  "agent": "local:mo",
  "title": "Continue a ticket's PR",
  "brief": "Proposed approach: add github_resume. Reassess against the contract.",
  "assignment": {
    "kind": "implementation",
    "expectedBehavior": "Worker B continues the PR published by finished worker A on the same ticket. A different ticket cannot inherit it.",
    "observedMismatch": "Publication lookup is keyed by worker ID; a new worker cannot find the ticket's existing PR (cite the inspected code or reproduction here).",
    "stateOwner": "Ticket owns publication identity; worker owns its checkout.",
    "checks": [
      {
        "scenario": "A publishes and finishes; B continues that ticket; C publishes from another ticket",
        "assertion": "B updates A's PR; C gets a distinct publication identity",
        "run": "Add/run the continuation and isolation cases in test/integration/github-workers.test.ts with npx vitest run --project integration test/integration/github-workers.test.ts"
      }
    ],
    "design": {
      "kind": "architectural",
      "ownershipRepair": "Give the ticket publication identity, retaining worker-local checkout state",
      "workaround": "Add a resume tool that searches finished workers",
      "decision": "Repair ownership: continuation should not need a finished-worker recovery API"
    }
  }
}
```

For a local change use `"design": {"kind":"local"}`; no alternatives essay is needed. Checks can reference existing tests, not necessarily new infrastructure. `run` is a command/test plan, not a passed-test claim. The child receives the contract **before** the proposed approach, with explicit instructions that behavior, not the proposed solution, is the target. The final report must contain actual verification results.

## Shape and guarantees

`assignment.ts` owns the discriminated tool schema and pure brief renderer. The durable tool runner validates the selected branch **before** executing `start_work`. Required text must contain non-whitespace; checks must be nonempty; architectural changes require both alternatives and a decision. Rejected calls do not allocate a task, environment or work slot. `commands.ts` renders valid implementation assignments into the existing `WorkInput.brief`; `task.ts` delivers that saved brief using the existing replay-safe submission path. There is no second artifact store, task version change, owner approval step or GitHub coupling.

This is **contract completeness at declared implementation dispatch**, not enforced engineering correctness. A worker can misclassify a task, supply vacuous evidence, choose the wrong owner, implement directly, or later steer a child with `message_work`. The runtime neither detects those semantic bypasses nor executes the planned checks. Worker instructions explicitly require investigation when facts are unknown and the same behavior-first reasoning for direct implementation, but that part remains guidance. Existing in-flight durable briefs remain unchanged; new `start_work` calls must include the classification.

Executable lifecycle tests, rather than a filled form, establish domain correctness. The WORK integration test proves the mechanism: six malformed calls fail through the real tool validator without admitting a child; a valid call persists and delivers the behavior/evidence/ownership/checks/comparison to the actual child model. It uses the publication scenario as an artifact example, not as a substitute for PR #82's domain tests. Integration cases also cover unchanged ordinary briefs and local changes without architectural ceremony.

## Design decision and alternatives

Two whole-shape candidates were compared, including an independent read-only design review:

- **Typed dispatch contract (chosen).** One call classifies the work, validates the artifact and durably delivers it. Encode lessons in structure replaces an optional free-text handoff with a required schema branch; the laziness protocol keeps one authoritative brief and reuses admission/replay rather than adding a registry. The interface exposes only the judgment the caller must supply; it hides validation and delivery.
- **Ticket-scoped artifact registry plus publication gate (rejected).** This would also reach direct implementers, but requires extra tools, mutable artifact versions and cross-feature lookup. A publication gate arrives after the mistaken design has already been implemented, excludes non-GitHub work, and still cannot judge whether the reasoning is sound. Its larger interface buys bookkeeping, not better architectural judgment.

We accept an explicit classification on ordinary child calls in exchange for rejecting an accidentally omitted implementation artifact. We accept semantic bypasses rather than pretend arbitrary shell execution can be classified or make a huge capability/process framework. The owner should feel a different handoff and reviewable verification target—not an extra approval gate.
