import { randomUUID } from "node:crypto";
import {
  Container, Editor, Key, matchesKey, ProcessTerminal, Spacer, Text,
  TuiMainScreen, stripTerminalSequences, type EditorTheme,
} from "@earendil-works/pi-tui";
import { openContact, type ContactState } from "./contact.ts";
import { loadKey, saveKey } from "./credentials.ts";
import { KeyInput } from "./key-input.ts";
import { visibleJobs } from "./job-display.ts";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("Kaeno needs an interactive terminal. Run npm start in a TTY.");
}
const stateDir = ".kaeno";
const tui = new TuiMainScreen(new ProcessTerminal());
const transcript = new Container();
const jobs = new Container();
const status = new Text("Starting…");
const editorTheme: EditorTheme = {
  borderColor: (text) => text,
  selectList: {
    selectedPrefix: (text) => text, selectedText: (text) => text,
    description: (text) => text, scrollInfo: (text) => text, noMatch: (text) => text,
  },
};
const editor = new Editor(tui, editorTheme);
const secretSlot = new Container();
tui.addChild(new Text("kaeno  ·  local Durable assistant"));
tui.addChild(new Text("Enter to send · /stop · /jobs · /job ID · /cancel ID · /key · Ctrl+C to exit"));
tui.addChild(new Spacer(1));
tui.addChild(transcript);
tui.addChild(jobs);
tui.addChild(new Spacer(1));
tui.addChild(status);
tui.addChild(secretSlot);
tui.addChild(editor);

// Text supports ANSI formatting, so treat every message and provider error as untrusted.
function safe(text: string) {
  const cleaned = stripTerminalSequences(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  const key = process.env.OPENAI_API_KEY;
  return key ? cleaned.split(key).join("[redacted]") : cleaned;
}
let contact: Awaited<ReturnType<typeof openContact>> | undefined;
let displayed = "";
let shownJobs = "";
let latest: ContactState | undefined;
let selectedJob: number | undefined;
let showHistory = false;
let busy: boolean | undefined;
let shownError: string | undefined;
let refreshing = false;
let closing = false;
let timer: ReturnType<typeof setInterval> | undefined;
let enteringKey = false;
async function refresh() {
  if (refreshing || closing || !contact) return;
  refreshing = true;
  try {
    const next = await contact.state();
    latest = next;
    const key = JSON.stringify(next.messages);
    if (key !== displayed) {
      transcript.clear();
      for (const message of next.messages) {
        transcript.addChild(new Text(`${message.role === "user" ? "you" : message.role === "job" ? "job" : "kaeno"}  ${safe(message.text)}`));
        transcript.addChild(new Spacer(1));
      }
      displayed = key;
      tui.requestRender();
    }
    const jobKey = JSON.stringify([next.jobs, selectedJob, showHistory]);
    if (jobKey !== shownJobs) {
      jobs.clear();
      const shown = visibleJobs(next.jobs, showHistory, selectedJob);
      if (shown.length) {
        jobs.addChild(new Text(showHistory ? "Recent jobs · /jobs to hide" : "Active jobs"));
        for (const job of shown) {
          const detail = selectedJob === job.id ? job.result?.text : job.result?.text.slice(0, 180);
          jobs.addChild(new Text(`  #${job.id} ${safe(job.agent)}: ${safe(job.objective)} [${job.result?.type ?? job.nativeStatus}]${job.notice ? ` notice: ${job.notice.status}` : ""}${detail ? `\n  ${safe(detail)}` : ""}`));
        }
      }
      shownJobs = jobKey;
      tui.requestRender();
    }
    if (!enteringKey) {
      if (!next.error) shownError = undefined;
      if (next.error && next.error !== shownError) {
        shownError = next.error;
        status.setText(safe(next.error));
        tui.requestRender();
      } else if (next.busy !== busy) {
        busy = next.busy;
        if (!next.error) status.setText(busy ? "kaeno is thinking…" : "Ready");
        tui.requestRender();
      }
    }
  } catch (error) {
    status.setText(`Cannot read conversation: ${safe(String(error))}`);
    tui.requestRender();
  } finally { refreshing = false; }
}
function keyPrompt() {
  enteringKey = true;
  const input = new KeyInput((value) => {
    void (async () => {
      try {
        await saveKey(stateDir, value);
        input.clear();
        secretSlot.clear();
        enteringKey = false;
        if (!contact) {
          contact = await openContact({ stateDir, apiKey: value });
          timer = setInterval(() => { void refresh(); }, 500);
        } else {
          process.env.OPENAI_API_KEY = value;
        }
        status.setText("Key saved locally. Ready.");
        tui.setFocus(editor);
        tui.requestRender();
        await refresh();
      } catch (error) {
        input.clear();
        if (!enteringKey) tui.setFocus(editor);
        status.setText(`Could not configure key: ${safe(String(error))}`);
        tui.requestRender();
      }
    })();
  });
  secretSlot.clear();
  secretSlot.addChild(input);
  status.setText("Key is visible while typing; Ctrl+R hides/reveals it. Beware terminal recordings. Saved with mode 600.");
  tui.setFocus(input);
  tui.requestRender();
}
editor.onSubmit = (text) => {
  const value = text.trim();
  if (!value || closing) return;
  if (value === "/key") { keyPrompt(); return; }
  if (value === "/stop") {
    void contact?.cancelContact().then(() => refresh()).catch((error: unknown) => {
      status.setText(`Cannot stop contact: ${safe(String(error))}`); tui.requestRender();
    });
    return;
  }
  if (value === "/jobs") {
    showHistory = selectedJob === undefined && !showHistory;
    selectedJob = undefined;
    shownJobs = "";
    void refresh();
    return;
  }
  if (value.startsWith("/job ")) {
    const id = Number(value.slice(5));
    if (!Number.isSafeInteger(id) || !latest?.jobs.some(job => job.id === id)) status.setText("Unknown job ID");
    else { selectedJob = id; shownJobs = ""; void refresh(); }
    tui.requestRender(); return;
  }
  if (value.startsWith("/cancel ")) {
    const id = Number(value.slice(8));
    if (!Number.isSafeInteger(id) || !contact) { status.setText("Invalid job ID"); tui.requestRender(); return; }
    void contact.cancelJob(id).then(() => refresh()).catch((error: unknown) => {
      status.setText(`Cannot cancel job: ${safe(String(error))}`); tui.requestRender();
    });
    return;
  }
  if (!contact) { status.setText("Configure an OpenAI key first."); tui.requestRender(); return; }
  const requestId = randomUUID();
  void contact.send(text, requestId).then(() => refresh()).catch((error: unknown) => {
    status.setText(`Send uncertain (${requestId}): ${safe(String(error))}`);
    tui.requestRender();
  });
};
async function close() {
  if (closing) return;
  closing = true;
  if (timer) clearInterval(timer);
  tui.stop();
  await contact?.close();
}
tui.addInputListener((data) => {
  if (!matchesKey(data, Key.ctrl("c"))) return;
  void close().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
  return { consume: true };
});
process.once("SIGTERM", () => { void close().catch(console.error); });
tui.start();
try {
  const savedKey = await loadKey(stateDir);
  if (savedKey) {
    contact = await openContact({ stateDir, apiKey: savedKey });
    tui.setFocus(editor);
    await refresh();
    timer = setInterval(() => { void refresh(); }, 500);
  } else keyPrompt();
} catch (error) {
  status.setText(`Startup failed: ${safe(String(error))}. Try /key or inspect configuration.`);
  tui.setFocus(editor);
  tui.requestRender();
}
