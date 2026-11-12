import { Type, type Static } from "@earendil-works/pi-ai";

function fact(description: string) {
  return Type.String({
    description,
    minLength: 1,
    maxLength: 8000,
    pattern: "\\S",
  });
}

/** Classification is explicit; ordinary tasks do not need an engineering worksheet. */
export const assignmentSchema = Type.Union([
  Type.Object({ kind: Type.Literal("task") }),
  Type.Object({
    kind: Type.Literal("implementation"),
    expectedBehavior: fact(
      "Observable behavior, independent of the proposed solution",
    ),
    observedMismatch: fact(
      "What happens instead, with inspected code, reproduction or other evidence",
    ),
    stateOwner: fact(
      "Which domain/lifecycle rightfully owns the state; say no state if applicable",
    ),
    checks: Type.Array(
      Type.Object({
        scenario: fact(
          "Lifecycle or user scenario, including isolation/continuation where relevant",
        ),
        assertion: fact(
          "Observable result that distinguishes correct behavior from the reported mismatch",
        ),
        run: fact(
          "Executable test command and test to add or run; a plan, not a claim it has passed",
        ),
      }),
      { minItems: 1, maxItems: 16 },
    ),
    design: Type.Union([
      Type.Object({ kind: Type.Literal("local") }),
      Type.Object({
        kind: Type.Literal("architectural"),
        ownershipRepair: fact(
          "Alternative that repairs the rightful ownership or lifecycle",
        ),
        workaround: fact(
          "Alternative that works around the current implementation",
        ),
        decision: fact(
          "Compare the alternatives and explain the chosen direction",
        ),
      }),
    ]),
  }),
]);

/** Save the artifact in the existing durable brief; replay needs no second mutable record. */
export function assignmentBrief(
  brief: string,
  assignment: Static<typeof assignmentSchema>,
): string {
  if (assignment.kind === "task") {
    return brief;
  }
  const { design } = assignment;
  return [
    "# Implementation contract",
    "Behavior is the target; the proposed approach below is not an acceptance criterion. Inspect the actual architecture and revise a mistaken premise before implementing. Run the checks and report exact results, not just this plan.",
    "",
    "## Expected behavior",
    assignment.expectedBehavior,
    "## Observed mismatch and evidence",
    assignment.observedMismatch,
    "## Rightful state owner",
    assignment.stateOwner,
    "## Executable contracts to verify",
    ...assignment.checks.map(
      (check, index) =>
        `${index + 1}. Scenario: ${check.scenario}\n   Assert: ${check.assertion}\n   Run/add: ${check.run}`,
    ),
    ...(design.kind === "architectural"
      ? [
          "## Ownership repair vs workaround",
          `Ownership repair: ${design.ownershipRepair}`,
          `Workaround: ${design.workaround}`,
          `Decision: ${design.decision}`,
        ]
      : []),
    "",
    "## Delegated request / proposed approach",
    brief,
  ].join("\n");
}

export const IMPLEMENTATION_DISPATCH =
  "For implementation delegation, use start_work assignment.kind=implementation: first inspect the relevant architecture, state expected behavior independently of the proposed fix, cite the observed mismatch, identify the rightful state owner, and name executable scenario/assertion/run checks. For architectural changes use design.kind=architectural to compare ownership repair with a workaround. If those facts are unknown, delegate investigation with assignment.kind=task first, not implementation disguised as a task. Ordinary research, reviews and trivial non-implementation tasks use assignment.kind=task. If implementing yourself, establish the same behavior and executable checks before editing; no extra dispatch or owner approval is needed.";
