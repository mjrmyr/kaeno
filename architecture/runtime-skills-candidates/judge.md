## Scores

Higher is better. Scores assess the proposed shapes against the stated constraints.

| Criterion                                  | PVC/init-only | Authenticated HTTP |
| ------------------------------------------ | ------------: | -----------------: |
| Runtime config/image independence          |             5 |                  5 |
| Assigned-only filesystem/network isolation |             5 |                  3 |
| Durable replay and crash consistency       |             4 |                  4 |
| Ownership/interface depth                  |             4 |                  3 |
| Single-node operational fit                |             5 |                  2 |
| **Total /25**                              |        **23** |             **17** |

- **Independence:** Both move resolution to startup and use generic images.
- **Isolation:** PVC preserves worker→kaeno denial and exposes only assigned files to main. Its trusted init can see the full cache. HTTP removes that cache exposure but opens kaeno reachability to main as well as init—contrary to the stated invariant.
- **Durability:** Both retain immutable trees, replay persisted bindings, and fail closed. Neither fully specifies crash-durable publication; atomic rename alone does not establish persistence across storage failure.
- **Depth:** PVC hides delivery in existing pod construction. HTTP adds TLS, grants, Secrets, expiry, UID sequencing, and reconciliation that callers must coordinate.
- **Operations:** PVC matches the accepted single-node/RWO model. HTTP buys topology independence that this deployment does not presently need.

## Red-flag screen

**PVC**

- `open → prepare → fromManifest` exposes preparation/storage coordination; graft HTTP’s consolidated preparation interface.
- Its illustrative `SkillBinding` risks becoming a second, reduced representation beside existing bounded `BoundSkill` documents. Preserve the existing domain binding semantics.
- Public `PublishedTree.path` leaks cache layout. Keep physical paths internal.
- Legacy replay is an intentional exception to “one way”; strictly prohibit new legacy bindings.

**HTTP**

- Grant issuance after pod creation creates temporal coupling across controller, server, and Secret lifecycle.
- Delivery authorization introduces additional state ownership and reconciliation obligations.
- Interface depth does not compensate for violating the existing network constraint. This candidate is unsuitable unless that constraint is explicitly changed.

## Recommendation

**Use Candidate A: dedicated persistent cache PVC, mounted read-only by trusted init only.**

Concrete grafts from HTTP:

1. **One preparation entry point:** return the prepared catalogue/store behind a single runtime-preparation interface; keep staging, publication, and cache paths private.
2. **Preserve domain bindings:** retain existing `BoundSkill` documents and atomic binding/image capture; use an explicit durable cache-versus-legacy source discriminator rather than replacing the binding model.
3. **Canonical artifact validation:** adopt safe-path, file-kind, size-limit, and digest checks at preparation and init boundaries. Validate existing cache entries before reuse.
4. **Complete-selection publication:** init stages and verifies every assigned tree before exposing the finished selection; missing or corrupt artifacts fail closed.
5. **Credential separation:** resolver alone receives optional dedicated Git credentials; installer receives an allowlisted, credential-free environment.
6. **Failure tests:** cover interrupted publication, existing-tree collisions/corruption, interrupted init copying, replay after configuration changes, and missing retained artifacts.

Do **not** graft HTTP delivery, grant machinery, TLS, or network-policy changes. Retain indefinite completed-tree storage and replay-only legacy image support.
