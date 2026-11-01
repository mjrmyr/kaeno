import { describe, expect, it } from "vitest";
import { emptySession, pendingTurns, type Session } from "./model";

describe("local submission status", () => {
  it("does not mistake an activity report for a response to the user", () => {
    const session: Session = {
      ...emptySession(),
      outgoing: [{ requestId: "ui:one", text: "Hi", status: "submitted" }],
      replies: [
        {
          id: 1,
          requestId: "ui:one",
          text: "Worker finished",
          source: { kind: "activity-result", activityId: 1 },
          epoch: 0,
        },
      ],
    };
    expect(pendingTurns(session)).toHaveLength(1);
    session.replies[0].source = { kind: "user" };
    expect(pendingTurns(session)).toHaveLength(0);
  });
  it("does not keep stopped local submissions blocking the composer", () => {
    expect(
      pendingTurns({
        ...emptySession(),
        outgoing: [{ requestId: "ui:one", text: "Hi", status: "stopped" }],
      }),
    ).toEqual([]);
  });
});
