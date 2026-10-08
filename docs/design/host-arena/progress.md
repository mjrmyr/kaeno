# Architect / arena: Pi frontend and local-to-k3s hosting

Scope: update the architecture, signature scaffolds, rationale and presentation. No running Kaeno, server deployment, frontend fork or Kubernetes resources are implemented in this pass.

## Architect phases
- [x] Ground: traced actual InteractiveMode/AgentSessionRuntime coupling, native observation/storage/abort boundaries, and official Kubernetes fencing/storage limitations.
- [x] Sketch: two structurally distinct candidates, usage first; parent disagreed with judge on implementation-size weighting.
- [x] Agree: no checkpoint requested; architecture-only deliverable.
- [x] Implement: updated design artifacts, Pi presentation and explicit not-implemented scaffold only.
- [x] Scrap: replaced single-Harness native-child shape; screened remote storage and capability-only pods.

## Arena phases
- [x] Frame
- [x] Fan out (parallel Claude Opus + OpenAI Codex; both completed)
- [x] Cross-judge (OpenAI judge hit workspace spend cap; Claude CLI judge completed)
- [x] Pick (B despite judge recommendation A′; reason in synthesis)
- [x] Graft (A′ frontend gate/identity, B held obligation, judge client-cancel correction)
- [x] Verify (strict scaffold check; 5 earlier + 2 new native boundary probes; links and static checks)

Requirements: reuse Pi's existing chat TUI, not merely build a similar interface from components; begin on one MacBook; later host one persistent Kaeno service for multiple device clients; in k3s, each specialist assignment creates a new pod. Do not assume native ownership traverses processes, SQLite is multi-host storage, or delivery/pod creation is exactly once.

Rubric (0–5 each):
1. Real Pi frontend reuse with no second execution/persistence authority.
2. Correct Durable/process/storage mapping, grounded in source.
3. Job/pod identity, recovery, cancellation and capacity correctness.
4. Honest multi-device/service/security/workspace boundaries.
5. Small local implementation and a concrete migration path without a distributed platform on day one.

Runners: Claude CLI `claude-opus-5-5` (effort max), and OpenAI Codex `gpt-6.1-sol` (reasoning xhigh), in isolated `/tmp/arena-kaeno-host/candidate-{a,b}/`. Claude model availability probe succeeded. Both receive the same contract/grounding; structurally distinct hypotheses are central native agent tasks + remote capabilities versus isolated whole-worker Harnesses/stores. Historical artifacts remain historical, not proof of frontend extraction or distributed execution.
