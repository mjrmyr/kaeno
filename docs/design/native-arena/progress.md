# Architect: Kaeno on Pi Durable

## Architect phases

- [x] Ground (traced Durable paths + three published-package primitive probes)
- [x] Sketch (two distinct candidates, cross-judge and synthesized package)
- [x] Agree (no human checkpoint requested; scoped design deliverable)
- [x] Implement (design/types/signature scaffold delivered; bot runtime not implemented)
- [x] Scrap (checked; quota/transaction assumptions repaired in synthesis, no redesign required)

## Arena phases

- [x] Frame
- [x] Fan out
- [x] Cross-judge
- [x] Pick
- [x] Graft
- [x] Verify (strict typecheck, public declaration isolation, five native probes)

Scope: replace the superseded design with one native Pi Durable architecture and a coherent type/signature sketch. No ordinary coding-agent session adapter, parallel task ledger, or new general scheduler.

Rubric, each 0–5:
1. Correct mapping to actual Durable APIs and ownership/replay semantics.
2. Small public interface and concentrated ownership; red-flag screening.
3. Main conversation availability and orchestration, with understandable completion semantics.
4. Reproducible configuration and restart/cancellation correctness.
5. Minimal implementation path and concrete tests against the pinned package.

Runners: two independent openai-codex/gpt-6-sol:xhigh CLI sessions. Default Claude unavailable in local Pi catalog; no exposed subagent tool, so isolated CLI processes provide parallel fan-out. Cross-judge: gpt-6.1-sol:xhigh. Same available model family; not claimed cross-family confirmation. Candidate paths: /tmp/arena-kaeno-native/{candidate-a,candidate-b}/design.md.

Require structurally distinct candidates: job-scoped worker conversations vs persistent named specialist conversations. Shared product requirements and source facts stay identical. Frame differences are ownership/lifetime hypotheses, not a scoring preference.
