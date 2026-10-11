# Archived first-round candidates

These are independent proposals and the cross-review from the initial architecture exploration, not implementation instructions.

These build-time proposals were superseded first by assigned-only worker filesystem visibility, then by **runtime retrieval independent of container builds**. Current authority: `../skills.md`, `../runtime-skills-plan.md`, and the runtime source types. Both images are now generic; a dedicated runtime cache PVC is mounted privately by init, which copies only assigned skills into the worker's read-only volume. Candidate output is retained unmodified as historical decision evidence, not a source of current requirements.
