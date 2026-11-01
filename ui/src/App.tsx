import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { api, type Thread } from "./api";
import { Badge, Transcript } from "./Conversation";
import { DemoTranscript, DemoContext, type DemoStage } from "./Demo";
import {
  emptySession,
  errorMessage,
  pendingTurns,
  type Session,
  type Outgoing,
} from "./model";

const demoThread = "A thoughtful first workspace";
const suggestions = [
  "Help me plan a project",
  "Review a pull request",
  "Explore an idea",
];
type Mode = "live" | "demo";

export function App() {
  const [mode, setMode] = useState<Mode>("live");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [threadsError, setThreadsError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [demoStage, setDemoStage] = useState<DemoStage>("waiting");
  const [demoMessages, setDemoMessages] = useState<string[]>([]);
  const [control, setControl] = useState<
    Record<string, { busy?: boolean; message?: string; error?: string }>
  >({});
  const endRef = useRef<HTMLDivElement>(null);
  const navToggleRef = useRef<HTMLButtonElement>(null);
  const navCloseRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const session = selected
    ? (sessions[selected] ?? emptySession())
    : emptySession();
  const pending = pendingTurns(session);
  const draftKey = mode === "demo" ? "demo" : (selected ?? "new");
  const draft = drafts[draftKey] ?? "";
  const isDemo = mode === "demo";
  const currentThread = threads.find((thread) => thread.key === selected);
  const title = isDemo
    ? demoThread
    : selected
      ? (session.outgoing[0]?.text.slice(0, 70) ?? selected)
      : "A little space to think";
  const activeControl = selected ? control[selected] : undefined;

  const update = useCallback((key: string, fn: (value: Session) => Session) => {
    setSessions((previous) => ({
      ...previous,
      [key]: fn(previous[key] ?? emptySession()),
    }));
  }, []);

  useEffect(() => {
    if (!mobileNav) return;
    navCloseRef.current?.focus();
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMobileNav(false);
        navToggleRef.current?.focus();
      }
    }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [mobileNav]);

  useEffect(() => {
    if (mode !== "live") return;
    const controller = new AbortController();
    setThreadsLoading(true);
    api
      .threads(controller.signal)
      .then((items) => {
        if (controller.signal.aborted) return;
        setThreads(items.sort((a, b) => b.createdAt - a.createdAt));
        setThreadsError(undefined);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setThreadsError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setThreadsLoading(false);
      });
    return () => controller.abort();
  }, [mode, refresh]);

  // Polling is serial and scoped to the selected thread. Cleanup prevents stale
  // reads from a previous thread (or demo mode) from changing its transcript.
  const hasThread =
    !!selected &&
    (threads.some((t) => t.key === selected) || session.outgoing.length > 0);
  useEffect(() => {
    if (mode !== "live" || !selected || !hasThread) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const page = await api.replies(selected, controller.signal);
        if (!controller.signal.aborted)
          update(selected, (s) => ({
            ...s,
            replies: page.replies,
            truncated: page.truncated,
            loaded: true,
            error: undefined,
          }));
      } catch (error) {
        if (!controller.signal.aborted)
          update(selected, (s) => ({
            ...s,
            error: errorMessage(error),
            loaded: true,
          }));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 2500);
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [mode, selected, hasThread, refresh, update]);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [
    selected,
    session.replies.length,
    session.outgoing.length,
    demoStage,
    demoMessages.length,
  ]);

  useEffect(() => {
    if (demoStage !== "running") return;
    const timer = setTimeout(() => setDemoStage("completed"), 2200);
    return () => clearTimeout(timer);
  }, [demoStage]);

  async function submit(key: string, outgoing: Outgoing) {
    update(key, (s) => ({
      ...s,
      outgoing: s.outgoing.some((m) => m.requestId === outgoing.requestId)
        ? s.outgoing.map((m) =>
            m.requestId === outgoing.requestId
              ? { ...m, status: "sending" }
              : m,
          )
        : [...s.outgoing, outgoing],
    }));
    try {
      await api.send(key, outgoing.text, outgoing.requestId);
      update(key, (s) => ({
        ...s,
        outgoing: s.outgoing.map((m) =>
          m.requestId === outgoing.requestId
            ? { ...m, status: "submitted" }
            : m,
        ),
      }));
      setRefresh((value) => value + 1);
    } catch (error) {
      update(key, (s) => ({
        ...s,
        error: errorMessage(error),
        outgoing: s.outgoing.map((m) =>
          m.requestId === outgoing.requestId
            ? { ...m, status: "uncertain" }
            : m,
        ),
      }));
    }
  }
  function send(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || (!isDemo && pending.length > 0)) return;
    setDrafts((previous) => ({ ...previous, [draftKey]: "" }));
    if (isDemo) {
      setDemoMessages((messages) => [...messages, text]);
      setDemoStage("running");
      return;
    }
    const key = selected ?? `web:${crypto.randomUUID()}`;
    setSelected(key);
    void submit(key, {
      requestId: `ui:${crypto.randomUUID()}`,
      text,
      status: "sending",
    });
  }
  async function stop() {
    if (!selected) return;
    const key = selected;
    setControl((previous) => ({ ...previous, [key]: { busy: true } }));
    try {
      await api.stop(key);
      update(key, (s) => ({
        ...s,
        outgoing: s.outgoing.map((m) => ({ ...m, status: "stopped" })),
      }));
      setControl((previous) => ({
        ...previous,
        [key]: {
          message:
            "Stop accepted. This is a request, not confirmation that all work has stopped.",
        },
      }));
    } catch (error) {
      setControl((previous) => ({
        ...previous,
        [key]: { error: errorMessage(error) },
      }));
    }
  }
  function newConversation() {
    setMode("live");
    setSelected(null);
    setMobileNav(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  }
  function chooseThread(key: string) {
    setMode("live");
    setSelected(key);
    setMobileNav(false);
  }
  const filtered = threads.filter((thread) =>
    thread.key.toLowerCase().includes(search.toLowerCase()),
  );
  const liveHasMessages =
    session.replies.length > 0 || session.outgoing.length > 0;

  return (
    <div className="workspace">
      <a className="skip-link" href="#conversation">
        Skip to conversation
      </a>
      {mobileNav && (
        <button
          className="nav-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside
        className={`sidebar ${mobileNav ? "open" : ""}`}
        aria-label="Workspace navigation"
        id="workspace-navigation"
      >
        <button
          className="icon-button mobile-close"
          ref={navCloseRef}
          aria-label="Close navigation"
          onClick={() => {
            setMobileNav(false);
            navToggleRef.current?.focus();
          }}
        >
          ×
        </button>
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            newConversation();
          }}
        >
          <span className="brand-mark">
            k<span>•</span>
          </span>
          <span>
            kaeno<small>YOUR WORK, IN GOOD COMPANY</small>
          </span>
        </a>
        <button className="new-button" onClick={newConversation}>
          <span aria-hidden="true">＋</span> New conversation{" "}
          <span aria-hidden="true">↗</span>
        </button>
        <div className="sidebar-section-title">
          WORKSPACE <span>01</span>
        </div>
        <button
          className={`nav-item ${!isDemo ? "active" : ""}`}
          onClick={() => {
            setMode("live");
            setMobileNav(false);
          }}
        >
          <span aria-hidden="true">◫</span> Conversations{" "}
          <span className="nav-count">{threads.length}</span>
        </button>
        <div className="thread-heading">
          <span>YOUR CONVERSATIONS</span>
          <button
            className="icon-button"
            aria-label="Refresh conversations"
            onClick={() => setRefresh((value) => value + 1)}
            disabled={threadsLoading}
          >
            ↻
          </button>
        </div>
        <label className="search">
          <span aria-hidden="true">⌕</span>
          <input
            aria-label="Find a conversation"
            placeholder="Find a conversation"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <nav className="thread-list" aria-label="Conversations">
          {threadsLoading && (
            <p className="sidebar-note" role="status">
              Loading conversations…
            </p>
          )}
          {threadsError && (
            <div className="sidebar-error" role="alert">
              <p>Host unavailable</p>
              <small>{threadsError}</small>
              <button onClick={() => setRefresh((value) => value + 1)}>
                Try again
              </button>
            </div>
          )}
          {!threadsLoading && !threadsError && filtered.length === 0 && (
            <p className="sidebar-note">
              {search
                ? "No matching conversations."
                : "Your next idea starts here."}
            </p>
          )}
          {filtered.map((thread) => (
            <button
              key={
                sessions[thread.key]?.outgoing[0]?.text.slice(0, 45) ??
                thread.key
              }
              className={`thread-item ${selected === thread.key && !isDemo ? "selected" : ""}`}
              onClick={() => chooseThread(thread.key)}
              aria-current={
                selected === thread.key && !isDemo ? "page" : undefined
              }
            >
              <span className="thread-symbol" aria-hidden="true">
                ↳
              </span>
              <span>
                {sessions[thread.key]?.outgoing[0]?.text.slice(0, 45) ??
                  thread.key}
                <small>
                  {new Date(thread.createdAt).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </small>
              </span>
            </button>
          ))}
          {selected && !currentThread && !isDemo && (
            <button
              className="thread-item selected"
              onClick={() => chooseThread(selected)}
            >
              <span aria-hidden="true">↳</span>
              <span>
                New conversation
                <small>
                  {session.outgoing.length ? "This session" : "Draft"}
                </small>
              </span>
            </button>
          )}
        </nav>
        <div className="demo-invite">
          <span className="eyebrow">A LOOK AROUND</span>
          <p>See what working together could feel like.</p>
          <button
            onClick={() => {
              setMode("demo");
              setMobileNav(false);
            }}
          >
            Explore the demo <span aria-hidden="true">↗</span>
          </button>
        </div>
        <div className="owner">
          <span className="owner-avatar">Y</span>
          <div>
            Your workspace<small>Self-hosted · Private by design</small>
          </div>
          <span className="owner-dot" aria-hidden="true" />
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <button
              className="icon-button mobile-toggle"
              aria-label="Open navigation"
              ref={navToggleRef}
              aria-controls="workspace-navigation"
              aria-expanded={mobileNav}
              onClick={() => setMobileNav(true)}
            >
              ☰
            </button>
            <span className="breadcrumb">
              Workspace <span aria-hidden="true">/</span> Conversations
            </span>
          </div>
          <div className="topbar-right">
            <span
              className={`connection-dot ${isDemo || threadsError ? "offline" : ""}`}
            />
            {isDemo
              ? "Demo · no host requests"
              : threadsLoading
                ? "Connecting…"
                : threadsError
                  ? "Host unavailable"
                  : "Host connected"}
          </div>
        </header>
        <div className="conversation-header">
          <div>
            <div className="eyebrow">
              {isDemo ? "INTERACTIVE PREVIEW" : "CONVERSATION"}
            </div>
            <h1>{title}</h1>
          </div>
          <Badge tone={isDemo ? "amber" : "green"}>
            {isDemo ? "Demo data" : "Live API"}
          </Badge>
        </div>
        {isDemo && (
          <div className="demo-banner">
            <span>✧</span>
            <p>
              <strong>A preview, not a live agent.</strong> Messages and work
              below are simulated. Nothing is sent to your host.
            </p>
            <button onClick={() => setMode("live")}>
              Return to live <span aria-hidden="true">↗</span>
            </button>
          </div>
        )}
        <div className="content-grid">
          <section
            className="conversation"
            id="conversation"
            aria-label="Conversation"
            tabIndex={-1}
          >
            <div
              className="transcript"
              aria-label="Messages"
              aria-busy={!isDemo && !!selected && hasThread && !session.loaded}
            >
              {isDemo ? (
                <DemoTranscript
                  stage={demoStage}
                  messages={demoMessages}
                  onChoose={() => setDemoStage("running")}
                />
              ) : (
                <>
                  {selected && hasThread && !session.loaded && (
                    <p className="muted" role="status">
                      Loading replies…
                    </p>
                  )}
                  {session.error && (
                    <div className="notice error" role="alert">
                      <strong>Couldn’t sync this conversation.</strong>
                      <p>{session.error}</p>
                      <button onClick={() => setRefresh((value) => value + 1)}>
                        Retry connection
                      </button>
                    </div>
                  )}
                  {session.truncated && (
                    <div className="notice">
                      Only retained replies are available. Earlier replies may
                      be missing.
                    </div>
                  )}
                  {!liveHasMessages &&
                    (!selected || session.loaded || !hasThread) && (
                      <div className="empty-state">
                        <span className="empty-mark" aria-hidden="true">
                          ✳
                        </span>
                        <span className="eyebrow">
                          MAKE ROOM FOR THE NEXT IDEA
                        </span>
                        <h2>
                          {selected
                            ? "A fresh page in this conversation."
                            : "What’s on your mind?"}
                        </h2>
                        <p>
                          {selected
                            ? "No retained replies yet. Start with a message below."
                            : "A question, a project, a half-formed thought. Start a conversation and take it from there."}
                        </p>
                        <div className="suggestions">
                          {suggestions.map((text) => (
                            <button
                              key={text}
                              onClick={() => {
                                setDrafts((values) => ({
                                  ...values,
                                  [draftKey]: text,
                                }));
                                inputRef.current?.focus();
                              }}
                            >
                              {text}
                              <span aria-hidden="true">↗</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  {selected && session.loaded && session.replies.length > 0 && (
                    <div className="history-note">
                      The host exposes assistant replies, not full chat history.
                      Your outgoing messages are shown for this browser session
                      only.
                    </div>
                  )}
                  <Transcript
                    session={session}
                    retry={(message) => {
                      if (selected) void submit(selected, message);
                    }}
                  />
                  {pending.length > 0 && (
                    <div className="pending-strip" role="status">
                      <span className="pulse-dot" />
                      <div>
                        <strong>
                          {pending.some((m) => m.status === "uncertain")
                            ? "Delivery needs checking"
                            : "Waiting for a reply"}
                        </strong>
                        <small>
                          {pending.some((m) => m.status === "uncertain")
                            ? "Retry uses the same request ID to avoid a duplicate turn."
                            : "The host has no live work-status feed. Replies refresh every 2.5 seconds."}
                        </small>
                      </div>
                    </div>
                  )}
                  {activeControl?.message && (
                    <div className="notice" role="status">
                      {activeControl.message}
                    </div>
                  )}
                  {activeControl?.error && (
                    <div className="notice error" role="alert">
                      {activeControl.error}
                    </div>
                  )}
                </>
              )}
              <div ref={endRef} />
            </div>
            <div className="composer-wrap">
              <form className="composer" onSubmit={send}>
                <label className="sr-only" htmlFor="message-input">
                  Message Kaeno
                </label>
                <textarea
                  ref={inputRef}
                  id="message-input"
                  rows={3}
                  placeholder={
                    isDemo ? "Try a message in the demo…" : "Message Kaeno…"
                  }
                  value={draft}
                  onChange={(event) =>
                    setDrafts((values) => ({
                      ...values,
                      [draftKey]: event.target.value,
                    }))
                  }
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <div className="composer-bottom">
                  <span>
                    <span aria-hidden="true">✧</span>{" "}
                    {isDemo ? "Demo sandbox" : "A conversation with Kaeno"}
                  </span>
                  <div className="button-row">
                    {!isDemo && selected && hasThread && (
                      <button
                        type="button"
                        className="stop-button"
                        disabled={
                          activeControl?.busy ||
                          pending.some((m) => m.status === "sending")
                        }
                        onClick={() => void stop()}
                      >
                        {activeControl?.busy ? "Requesting…" : "Request stop"}
                      </button>
                    )}
                    <button
                      className="send-button"
                      type="submit"
                      aria-label={isDemo ? "Send demo message" : "Send message"}
                      disabled={
                        !draft.trim() || (!isDemo && pending.length > 0)
                      }
                    >
                      Send <span aria-hidden="true">↑</span>
                    </button>
                  </div>
                </div>
              </form>
              <div className="composer-caption">
                <span>
                  {isDemo
                    ? "Simulated interaction · no backend calls"
                    : "Enter to send · Shift + Enter for a new line"}
                </span>
                <span>
                  {isDemo
                    ? "Made for a little less noise."
                    : "Check important results."}
                </span>
              </div>
            </div>
          </section>
          <aside className="context" aria-label="Conversation context">
            <div className="context-title">
              IN THE PICTURE <span aria-hidden="true">◉</span>
            </div>
            {isDemo ? (
              <DemoContext stage={demoStage} />
            ) : (
              <>
                <div className="context-card">
                  <span className="eyebrow">THIS CONVERSATION</span>
                  <h2>
                    {selected ? "Room to keep going" : "Start something good"}
                  </h2>
                  <p>
                    {selected
                      ? "Replies and activity reports from your Kaeno host appear here as they arrive."
                      : "Send your first message to create a thread. Nothing is created just by opening this page."}
                  </p>
                  {selected && (
                    <dl>
                      <dt>Thread key</dt>
                      <dd>{selected}</dd>
                      {currentThread && (
                        <>
                          <dt>Created</dt>
                          <dd>
                            {new Date(currentThread.createdAt).toLocaleString()}
                          </dd>
                        </>
                      )}
                    </dl>
                  )}
                </div>
                <div className="section-label">ACTIVITY</div>
                <div className="context-card">
                  <Badge tone={pending.length ? "blue" : "neutral"}>
                    {pending.length
                      ? "Awaiting reply"
                      : session.replies.length
                        ? "Replies received"
                        : "Ready when you are"}
                  </Badge>
                  <h3>
                    {pending.length
                      ? "Your message is in view."
                      : "No status guessing."}
                  </h3>
                  <p>
                    Live mode shows accepted messages and returned replies.
                    Worker progress, input-needed states, and project details
                    are not available through this API.
                  </p>
                </div>
                <button
                  className="preview-link"
                  onClick={() => setMode("demo")}
                >
                  Preview the work experience <span aria-hidden="true">↗</span>
                </button>
                <div className="context-footnote">
                  <strong>Your host, your boundary.</strong> Use a trusted local
                  network or an authenticated reverse proxy. The Kaeno HTTP
                  adapter has no built-in authentication.
                </div>
              </>
            )}
            <div className="quiet-note">
              <span aria-hidden="true">✳</span> A little less noise.
              <br />A little more forward.
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
