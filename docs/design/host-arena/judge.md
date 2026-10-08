# Cross-judge: Claude Opus on A and B

Cross-judge recommended **A′**, the central StoreHost + fenced Storage RPC architecture, 19/25 over B's isolated local worker stores and sealed result handoff, 17/25. The initial OpenAI judge attempt failed with a workspace spend cap; Claude CLI cross-judge completed successfully. The complete verdict is at `/tmp/arena-kaeno-host/judge/verdict.md` in this design session; this file records the decision-relevant result.

| Criterion (0–5) | A′ | B |
|---|---:|---:|
| Actual Pi frontend without second agent | 4 | 3 |
| Durable/process/storage correctness | 4 | 4 |
| Identity/recovery/cancel/capacity | 3 | 4 |
| Device/service/workspace boundaries | 4 | 3 |
| Small staged build | 4 | 3 |
| **Total** | **19** | **17** |

The judge found both candidates **genuinely distinct and able to run the whole worker agent in a pod**; literal central-Harness+remote-env failed that requirement. It correctly flagged A′'s fatal quota bug (terminal faulted/orphaned native Job can leave an executing pod) and B's unresolved exceptional-reconciliation driver/authorization and PVC concerns. A′'s apparent advantage: central authoritative worker checkpoints, no non-atomic result upload, scoped gateway/fencing and no per-job PVC; B's advantage: supported SQLite per worker without implementing a custom remote Storage service, and a correct held-external-obligation capacity rule.

Judge recommended grafts into A′: B's held-until-quiescent obligation and late-launch claim gate; receipt-scoped client cancellation (not a contact-wide Esc); safe workspace snapshot defaults and convenient local launcher. It also required one coherent commit-consistent projection of *all* state (native + custom docs), actual Storage conformance and epoch-ambiguity tests, no quota release on native terminal receipt, and careful service outage/failover semantics.

**Parent pick differs: B is the smaller implementation base for the first deliverable.** The scoring criterion “small staged build” treated A′'s custom remote Storage and model gateway as one mechanism each, but implementing and conformance-testing an RPC-backed, epoch-fenced, transactional Durable Storage plus model gateway is a large new distributed substrate before local Pi chat works. It also concentrates model operations and every checkpoint behind one service, so a coordinator outage stalls the worker. B's pod-local store plus a bounded sealed result handoff is a narrower application boundary built on shipped Durable storage; read-only v1 needs only a bounded result, not artifact staging. Frontend extraction difficulty applies to either candidate; A′'s candidate text was more detailed, but its mechanics transplant to B. The parent weights preserving supported native storage and minimizing new framework infrastructure above avoiding per-job volume and sealed handoff. Re-evaluate if the handoff or k3s volume management proves more complex than Storage RPC. This is a reasoned disagreement, not claimed judge agreement.

**Adopted from A′:** the explicit extraction/gating/PTY gate; stable execution key and exact resource identity; fence all service-side acceptance by worker identity; transparent service detach/stop; coalesced full client snapshots; optional future resource quotas against orphan pods. **Repaired in B:** durable external obligation survives native task faults; startup + periodic owner-driven reconciliation (not callbacks); Esc withdraws only the active client's *queued* receipt, never aborts another device's turn or worker notice; no automatic retry/replacement based on Pod name/deletion/heartbeat or lease; job result seal retransmits from worker storage without inference; worker bootstrap authorization before model access.

**Red flags screened:** both designs hide large internals behind a small public client; A′ adds new generic Storage RPC and model gateway to local stage; B adds an application-level execution boundary but avoids split ownership by keeping all job/obligation/result policy in `jobs.ts`. Neither public interface exports native task/store/Kubernetes types. Any architecture in which `AgentSession` stores a second active conversation, a Job terminal receipt releases an external reservation, or a Pod name is treated as proof of quiescence is rejected.
