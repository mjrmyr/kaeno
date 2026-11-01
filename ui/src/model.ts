import type { Reply } from "./api";

export type Outgoing = {
  requestId: string;
  text: string;
  status: "sending" | "submitted" | "uncertain" | "stopped";
};
export type Session = {
  outgoing: Outgoing[];
  replies: Reply[];
  loaded: boolean;
  truncated: boolean;
  error?: string;
};
export const emptySession = (): Session => ({
  outgoing: [],
  replies: [],
  loaded: false,
  truncated: false,
});
export function pendingTurns(session: Session): Outgoing[] {
  const answered = new Set(
    session.replies
      .filter((r) => r.source.kind === "user")
      .map((r) => r.requestId),
  );
  return session.outgoing.filter(
    (m) => !answered.has(m.requestId) && m.status !== "stopped",
  );
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Could not connect to Kaeno.";
}
