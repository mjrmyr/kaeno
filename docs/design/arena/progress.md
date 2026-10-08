# Arena: challenge minimal Kaeno

- [x] Frame
- [x] Fan out
- [x] Cross-judge
- [x] Pick
- [x] Graft
- [x] Verify (design review only; runtime acceptance tests pending)

Artifact: independent critical review plus replacement minimal design, then one synthesized design and synthesis record.

Rubric (0–5 each):
1. Responsive contact: concrete nonblocking dispatch, serialized conversation ownership, completion delivery.
2. Durability: crash windows, duplicate dispatch/delivery, uncertain side effects, precise recovery guarantees.
3. Pi grounding: distinguish verified Pi APIs from unknown Pi Durable APIs; avoid inventing capabilities.
4. Config and isolation: discoverable specialists, immutable task config, workspace/tool safety.
5. Minimality and verification: small ownership surface, explicit limits, executable acceptance-test scenarios.

Runners: two independent openai-codex/gpt-6-sol:xhigh CLI sessions. Requested Claude default unavailable in `pi --list-models`; same-model runners permitted. No subagent tool is exposed, so launch isolated Pi CLI processes concurrently. Outputs isolated in candidate-a/ and candidate-b/.

Grounding: repo is greenfield except initial design. Installed Pi SDK documents persistent sessions, prompt resolving after run completion, steer/followUp, agent_settled. No Pi Durable source/package found locally; its API remains unverified.
