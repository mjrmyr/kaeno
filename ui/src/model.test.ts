import { describe, expect, it } from "vitest";
import {
  emptySession,
  markStopRequested,
  pendingTurns,
  type Session,
} from "./model";

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
  it("releases the local submission gate on a stop request, without treating it as completion", () => {
    expect(
      pendingTurns({
        ...emptySession(),
        outgoing: [
          { requestId: "ui:one", text: "Hi", status: "stop-requested" },
        ],
      }),
    ).toEqual([]);
  });
  it("marks only the requested unresolved submissions, preserving past replies and later sends", () => {
    const session: Session = {
      ...emptySession(),
      outgoing: [
        { requestId: "answered", text: "Past", status: "submitted" },
        { requestId: "pending", text: "Now", status: "submitted" },
        { requestId: "later", text: "Later", status: "sending" },
      ],
      replies: [
        {
          id: 1,
          requestId: "answered",
          text: "Answer",
          source: { kind: "user" },
          epoch: 0,
        },
      ],
    };
    expect(
      markStopRequested(session, new Set(["answered", "pending"])).outgoing.map(
        (m) => m.status,
      ),
    ).toEqual(["submitted", "stop-requested", "sending"]);
  });
});
