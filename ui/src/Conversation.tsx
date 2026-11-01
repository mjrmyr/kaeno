import type { ReactNode } from "react";
import type { Reply } from "./api";
import type { Session, Outgoing } from "./model";

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <span className={`badge ${tone}`}>
      <span className="status-dot" />
      {children}
    </span>
  );
}
export function Message({
  role,
  children,
  detail,
}: {
  role: "you" | "kaeno";
  children: ReactNode;
  detail?: string;
}) {
  return (
    <article className={`message ${role}`}>
      <div className="message-avatar" aria-hidden="true">
        {role === "kaeno" ? "k" : "Y"}
      </div>
      <div className="message-content">
        <div className="message-heading">
          <strong>{role === "kaeno" ? "Kaeno" : "You"}</strong>
          {detail && <span>{detail}</span>}
        </div>
        <div className="message-body">{children}</div>
      </div>
    </article>
  );
}
function ReplyMessage({ reply }: { reply: Reply }) {
  return (
    <Message
      role="kaeno"
      detail={
        reply.source.kind === "activity-result"
          ? (reply.source.label ?? `Activity ${reply.source.activityId}`)
          : "Reply"
      }
    >
      <p>{reply.text || "This reply contains no text."}</p>
    </Message>
  );
}
function UserMessage({
  outgoing,
  answered,
  retry,
}: {
  outgoing: Outgoing;
  answered: boolean;
  retry: (message: Outgoing) => void;
}) {
  return (
    <Message
      role="you"
      detail={
        answered
          ? "Reply received"
          : {
              sending: "Sending…",
              submitted: "Accepted · awaiting reply",
              uncertain: "Delivery uncertain",
              "stop-requested": "Stop requested (not confirmed)",
            }[outgoing.status]
      }
    >
      <p>{outgoing.text}</p>
      {outgoing.status === "uncertain" && !answered && (
        <div className="inline-warning">
          The request may have reached Kaeno.{" "}
          <button onClick={() => retry(outgoing)}>Retry same request</button>
        </div>
      )}
    </Message>
  );
}
export function Transcript({
  session,
  retry,
}: {
  session: Session;
  retry: (message: Outgoing) => void;
}) {
  const answered = new Set(
    session.replies
      .filter((r) => r.source.kind === "user")
      .map((r) => r.requestId),
  );
  return (
    <>
      {session.replies.map((reply) => (
        <div key={`reply-${reply.id}`}>
          {reply.source.kind === "user" &&
            session.outgoing
              .filter((m) => m.requestId === reply.requestId)
              .map((m) => (
                <UserMessage
                  key={m.requestId}
                  outgoing={m}
                  answered
                  retry={retry}
                />
              ))}
          <ReplyMessage reply={reply} />
        </div>
      ))}
      {session.outgoing
        .filter((m) => !answered.has(m.requestId))
        .map((m) => (
          <UserMessage
            key={m.requestId}
            outgoing={m}
            answered={false}
            retry={retry}
          />
        ))}
    </>
  );
}
