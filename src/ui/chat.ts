import { z } from "zod";
const threadsSchema = z.array(
  z.object({ key: z.string(), createdAt: z.number() }),
);
const repliesSchema = z.object({
  replies: z.array(
    z.object({ id: z.number(), requestId: z.string(), text: z.string() }),
  ),
  next: z.number(),
  truncated: z.boolean(),
});
interface Message {
  role: string;
  text: string;
  requestId?: string;
  replyId?: number;
}
interface Conversation {
  messages: Message[];
  cursor: number;
  note: string;
}

/** All content from the network is rendered as text, never HTML. */
export function mountChat(root: HTMLElement): () => void {
  root.innerHTML = `<aside><a class="brand" href="/">kaeno<span>your assistant</span></a><button id="new">＋ New conversation</button><h2>Conversations</h2><nav aria-label="Conversations"></nav><p class="aside-note">Your existing assistant.<br>No simulated activity.</p></aside><main><header><div><p class="eyebrow">CONVERSATION</p><h1>Start a conversation</h1></div><button id="stop" disabled>Stop thread</button></header><p id="connection" role="status">Connecting…</p><p id="error" role="alert" hidden></p><section id="messages" aria-label="Messages" aria-live="polite"></section><footer><p id="note" role="status"></p><form><label for="prompt">Message Kaeno</label><textarea id="prompt" rows="3" placeholder="What would you like to work on?" required></textarea><div class="compose-actions"><small>Enter for a new line · Send to submit</small><button id="send" type="submit">Send message ↑</button></div></form><p class="scope">The API retains assistant replies, not user history. Your messages appear only in this tab. No live run status is available.</p></footer></main>`;
  function element<T extends HTMLElement>(
    selector: string,
    type: { new (): T },
  ): T {
    const found = root.querySelector(selector);
    if (!(found instanceof type)) {
      throw new Error(`Missing ${selector}`);
    }
    return found;
  }
  const nav = element("nav", HTMLElement);
  const title = element("h1", HTMLElement);
  const messages = element("#messages", HTMLElement);
  const error = element("#error", HTMLElement);
  const connection = element("#connection", HTMLElement);
  const note = element("#note", HTMLElement);
  const prompt = element("#prompt", HTMLTextAreaElement);
  const send = element("#send", HTMLButtonElement);
  const stop = element("#stop", HTMLButtonElement);
  const form = element("form", HTMLFormElement);
  const conversations = new Map<string, Conversation>();
  let selected = "";
  let threads: z.infer<typeof threadsSchema> = [];
  let busy = false;
  let disposed = false;
  let polling = false;
  const requests = new Set<AbortController>();
  // A failed/uncertain submission keeps the same id when retried, preventing duplicate admission.
  let retry: { key: string; text: string; requestId: string } | undefined;
  function state(key: string): Conversation {
    let current = conversations.get(key);
    if (!current) {
      current = { messages: [], cursor: 0, note: "" };
      conversations.set(key, current);
    }
    return current;
  }
  function showError(value: unknown): void {
    error.hidden = false;
    error.textContent = value instanceof Error ? value.message : String(value);
  }
  async function request(path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers:
          body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`API ${response.status}: ${await response.text()}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
      requests.delete(controller);
    }
  }
  function render(): void {
    title.textContent = selected || "Start a conversation";
    stop.disabled = !selected || busy;
    send.disabled = busy || !prompt.value.trim();
    prompt.disabled = busy;
    nav.replaceChildren();
    const keys = new Set([
      ...threads.map((thread) => thread.key),
      ...conversations.keys(),
    ]);
    for (const key of keys) {
      const button = document.createElement("button");
      button.textContent = key;
      button.setAttribute("aria-current", String(key === selected));
      button.onclick = () => {
        if (!busy) {
          selected = key;
          error.hidden = true;
          render();
          void poll();
        }
      };
      nav.append(button);
    }
    messages.replaceChildren();
    const current = selected ? state(selected) : undefined;
    note.textContent = current?.note || "";
    if (!current?.messages.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = selected
        ? "No retained replies yet. Send a message to begin."
        : "A little space to think. Start with a question, an idea, or a task.";
      messages.append(empty);
    }
    for (const message of current?.messages ?? []) {
      const article = document.createElement("article");
      article.className =
        message.role === "You" ? "user-message" : "assistant-message";
      const label = document.createElement("h2");
      label.textContent = message.role;
      const text = document.createElement("p");
      text.textContent = message.text;
      article.append(label, text);
      messages.append(article);
    }
  }
  async function poll(): Promise<void> {
    if (polling || disposed) {
      return;
    }
    polling = true;
    const key = selected;
    try {
      threads = threadsSchema.parse(await request("/v1/threads"));
      if (key) {
        const current = state(key);
        const page = repliesSchema.parse(
          await request(
            `/v1/threads/${encodeURIComponent(key)}/replies?after=${current.cursor}`,
          ),
        );
        if (page.truncated) {
          current.note =
            "Earlier replies are no longer retained by the server.";
        }
        for (const reply of page.replies) {
          if (
            !current.messages.some((message) => message.replyId === reply.id)
          ) {
            current.messages.push({
              role: "Kaeno",
              text: reply.text,
              replyId: reply.id,
              requestId: reply.requestId,
            });
          }
        }
        current.cursor = page.next;
        if (page.replies.length && !page.truncated) {
          current.note =
            "Reply received. The API does not expose whether work is still running.";
        }
      }
      connection.textContent =
        "Connected to Kaeno · replies refresh every second";
      if (!disposed) {
        render();
      }
    } catch (failure) {
      if (!disposed) {
        connection.textContent = "Disconnected · retrying automatically";
        showError(failure);
      }
    } finally {
      polling = false;
    }
  }
  element("#new", HTMLButtonElement).onclick = () => {
    if (busy) {
      return;
    }
    selected = `web-${crypto.randomUUID()}`;
    state(selected);
    error.hidden = true;
    render();
    prompt.focus();
  };
  prompt.oninput = () => {
    send.disabled = busy || !prompt.value.trim();
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    const text = prompt.value.trim();
    if (busy || !text) {
      return;
    }
    if (!selected) {
      selected = `web-${crypto.randomUUID()}`;
    }
    const key = selected;
    if (!retry || retry.key !== key || retry.text !== text) {
      retry = { key, text, requestId: crypto.randomUUID() };
    }
    const submission = retry;
    busy = true;
    error.hidden = true;
    render();
    try {
      z.object({ taskId: z.string() }).parse(
        await request(`/v1/threads/${encodeURIComponent(key)}/turn`, {
          text,
          requestId: submission.requestId,
        }),
      );
      const current = state(key);
      const userMessage = {
        role: "You",
        text,
        requestId: submission.requestId,
      };
      const replyIndex = current.messages.findIndex(
        (message) => message.requestId === submission.requestId,
      );
      if (replyIndex < 0) {
        current.messages.push(userMessage);
      } else {
        current.messages.splice(replyIndex, 0, userMessage);
      }
      current.note =
        "Turn accepted. Waiting for a retained reply; run status is not available.";
      prompt.value = "";
      retry = undefined;
    } catch (failure) {
      showError(failure);
      state(key).note =
        "Submission not confirmed. Retry the unchanged message safely, or stop this thread.";
    } finally {
      busy = false;
      if (!disposed) {
        render();
        prompt.focus();
        void poll();
      }
    }
  };
  stop.onclick = async () => {
    if (!selected || busy) {
      return;
    }
    const current = state(selected);
    busy = true;
    error.hidden = true;
    render();
    try {
      z.object({ taskId: z.string() }).parse(
        await request(`/v1/threads/${encodeURIComponent(selected)}/stop`, {}),
      );
      current.note =
        "Stop accepted for this thread (including its work). Cancellation is asynchronous.";
    } catch (failure) {
      showError(failure);
    } finally {
      busy = false;
      if (!disposed) {
        render();
      }
    }
  };
  render();
  void poll();
  const timer = setInterval(() => {
    void poll();
  }, 1000);
  return () => {
    disposed = true;
    clearInterval(timer);
    for (const controller of requests) {
      controller.abort();
    }
    root.replaceChildren();
  };
}
