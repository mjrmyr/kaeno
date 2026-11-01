import { Badge, Message } from "./Conversation";

export type DemoStage = "waiting" | "running" | "completed";

export function DemoTranscript({
  stage,
  messages,
  onChoose,
}: {
  stage: DemoStage;
  messages: string[];
  onChoose: () => void;
}) {
  return (
    <>
      <div className="date-divider">
        <span>DEMO CONVERSATION</span>
      </div>
      <Message role="you" detail="Example message">
        <p>
          Let’s build a quieter place to work with Kaeno. Conversation first,
          with a clear view of what’s happening.
        </p>
      </Message>
      <Message role="kaeno" detail="Example response">
        <p>
          A workspace that gives your ideas room to breathe. I’ll keep the
          conversation at the center, and the work in view.
        </p>
        <p>Before I put the first direction together, one small decision:</p>
        <div className="decision-card">
          <span className="eyebrow">YOUR INPUT NEEDED</span>
          <h3>Where should the focus be?</h3>
          <p>
            A simple conversation, or a workspace with room for project context?
          </p>
          <div className="button-row">
            <button
              className="primary"
              disabled={stage !== "waiting"}
              onClick={onChoose}
            >
              Conversation + context <span aria-hidden="true">↗</span>
            </button>
            <button disabled={stage !== "waiting"} onClick={onChoose}>
              Keep it minimal
            </button>
          </div>
          {stage !== "waiting" && (
            <small>Example decision received. Preparing the demo result.</small>
          )}
        </div>
      </Message>
      {messages.map((text, index) => (
        <Message key={index} role="you" detail="Demo message">
          <p>{text}</p>
        </Message>
      ))}
      {stage === "running" && (
        <Message role="kaeno" detail="Simulated activity">
          <div className="working">
            <span className="pulse-dot" /> Putting the first direction together…
          </div>
        </Message>
      )}
      {stage === "completed" && (
        <Message role="kaeno" detail="Simulated result">
          <p>
            The first direction is ready: a focused conversation, a quiet
            navigation rail, and just enough context to see the next step.
          </p>
          <div className="result-card">
            <span className="result-icon" aria-hidden="true">
              ✓
            </span>
            <div>
              <strong>Workspace direction</strong>
              <small>Example outcome · no files were changed</small>
            </div>
            <Badge tone="green">Completed</Badge>
          </div>
          <p>
            That’s the preview. Switch to live mode to start a real conversation
            with your Kaeno host.
          </p>
        </Message>
      )}
    </>
  );
}

export function DemoContext({ stage }: { stage: DemoStage }) {
  return (
    <>
      <div className="context-card project-card">
        <div className="project-icon" aria-hidden="true">
          ◫
        </div>
        <span className="eyebrow">EXAMPLE PROJECT</span>
        <h2>Kaeno workspace</h2>
        <p>A thoughtful home for conversations and the work around them.</p>
        <div className="project-meta">
          <span>UI exploration</span>
          <span>First iteration</span>
        </div>
      </div>
      <div className="section-label">
        WORK IN VIEW <span>2</span>
      </div>
      <div className="work-card">
        <div className="work-card-top">
          <span className="work-icon" aria-hidden="true">
            ✧
          </span>
          <Badge
            tone={
              stage === "waiting"
                ? "amber"
                : stage === "running"
                  ? "blue"
                  : "green"
            }
          >
            {stage === "waiting"
              ? "Input needed"
              : stage === "running"
                ? "In progress"
                : "Completed"}
          </Badge>
        </div>
        <h3>Shape the workspace</h3>
        <p>
          {stage === "waiting"
            ? "One decision to set the direction."
            : stage === "running"
              ? "Preparing the example direction."
              : "First direction ready to explore."}
        </p>
        <div className="work-footer">
          <span className="tiny-avatar">k</span> Kaeno <span>Simulated</span>
        </div>
      </div>
      <div className="work-card complete">
        <div className="work-card-top">
          <span className="work-icon" aria-hidden="true">
            ✓
          </span>
          <Badge tone="green">Completed</Badge>
        </div>
        <h3>Map the essentials</h3>
        <p>Conversation, activity, and context.</p>
        <div className="work-footer">
          <span className="tiny-avatar">k</span> Kaeno <span>Simulated</span>
        </div>
      </div>
      <div className="context-footnote">
        These cards illustrate possible work states. The current HTTP API does
        not expose worker status or project records.
      </div>
    </>
  );
}
