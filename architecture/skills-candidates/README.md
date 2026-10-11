# Archived first-round candidates

These are independent proposals and the cross-review from the initial architecture exploration, not implementation instructions.

The user subsequently required **assigned-only worker filesystem visibility**. Their single shared image assumptions are superseded by `../skills.md` and the implemented runtime types in `../../src/skills.ts`: sibling kaeno/sandbox image targets, with only the former containing the central store, and an init container copying selected skills into a worker-mounted `.agents/skills` volume. Candidate output is retained unmodified as decision history.
