# Minimal Kaeno: one Durable contact, native Jobs, custom TUI

**Implemented:** `src/contact.ts` owns one Durable Harness and SQLite store; `src/jobs.ts` installs the creation-only `delegate` and read-only `job_status` tools, a background native Job, and a private task-owned child conversation per assignment; `src/tui.ts` displays the contact and job cards. The TUI is built with `@earendil-works/pi-tui` components, **not** Pi's stock `InteractiveMode`.

## Run it

```sh
npm install
npm start
```

Node 24+ and a TTY are required. Configure the OpenAI API key **inside the terminal prompt** on first start. The field accepts terminal bracketed paste (Cmd+V on macOS). The text is visible while typing for verification; Ctrl+R hides or reveals it. Visible text may appear in terminal recordings or scrollback. `/key` changes it. The secret is stored **unencrypted** at `.kaeno/credentials.json` with `0600` permissions and is loaded into the provider's process environment; no demo mode or user-set environment key is required. OpenAI `gpt-4o-mini` is fixed for both contact and specialists. A previous faux/demo contact is upgraded to this model while retaining its clearly labeled echo messages. A live OpenAI test was not possible without a key; offline tests use an injected scripted provider, not an application demo mode.

The terminal uses Enter to send, Shift+Enter for multiline input, `/jobs` to toggle saved job history (or dismiss a selected card), `/job ID` for one complete saved card, `/cancel ID` to abort a job, `/stop` to stop the contact's current answer, Ctrl+C to exit. It polls committed state every 500 ms and never owns a second conversation. Closing the TUI closes the Harness; work resumes when the process restarts. A loopback bind on port 4317 prevents another *instance of this app* from opening the store and is released on process exit. It does **not** provide a cross-host or alternate-client lock, and no HTTP listener serves requests. Do not open this SQLite file with another writer.

## Delegation boundary

```text
pi-tui ── one Node process ── one Durable Harness ── one SQLite store
                                ├─ contact conversation + kaeno.jobs document
                                └─ background native Job ── private child conversation
```

At boot Kaeno loads trusted `.kaeno/agents/*.json`, creating a starter `reader.json` if absent. Each profile has name, description, instructions, absolute workspace, `modelId: "gpt-4o-mini"`, and `tools: ["read"]` or `[]`. Profiles are pinned with SHA-256 revision and installed runtime revision in the task input. Current active jobs are checked for incompatible runtime revision before scheduling on restart. Changes to the directory require restart. The `"read"` capability also exposes a bounded `list` tool (100 names per call, paged by offset) so the worker can discover files in directories. Paths beginning `~/` expand to the user's home directory; relative paths resolve from the canonical workspace. The read/list boundary distinguishes missing paths, directories passed to read, and paths outside the configured workspace. It refuses reads and listings outside the workspace or in Kaeno's state directory; it does **not** silently approve a path mentioned in chat. To inspect another directory, stop Kaeno, change the trusted profile's absolute `workspace`, and restart. The underlying read tool retains its normal output limits. **Neither the workspace nor the wrapper is a process sandbox**; extensions or new tool capabilities must be treated as trusted code.

`delegate(agent,objective,brief)` checks arguments, deduplicates by origin `api.taskId` and rejects changed arguments for the same origin. In one commit, it reads native task states **before any table writes**, counts all nonterminal jobs (including `completing`), caps global active jobs at 4, per-agent at 2 and retained cards at 1000, then creates a background Job and task-owned child. It does not make model calls inside the tool transaction. A Job submits its fixed brief with `kaeno:work:<taskId>`, waits for the child answer, writes a result card, and tries one root follow-up with `kaeno:notice:<taskId>`. Replay reuses these request IDs. The result stays available even when the notice is unanswered or deferred. Cancellation is cooperative; an admitted child may have had external effects, so an interrupted job gets an `outcome_unknown` card unless cancelled before dispatch. An unexpected native terminal outcome without a card is surfaced as unknown in the UI.

The contact continues accepting input during specialist work; it can inspect cards through `job_status`. Provider failures may yield failed cards rather than findings. Messages and card text are stripped of terminal control sequences before display; the key is shown only in the key-entry prompt while visibility is enabled, not in the chat transcript. The TUI currently repaints committed full history, not streamed tokens, and its ambient job panel shows only nonterminal jobs (including `completing`). Terminal jobs are kept in the store but hidden from that panel; `/jobs` explicitly toggles the ten most recent history cards and `/job ID` or `job_status` can inspect older cards. Conversation messages remain visible as transcript history.

## Evidence and gaps

`npm test` uses a scripted provider **only in tests** to exercise contact dedup, native delegation, saved card/restart, contact responsiveness, cancellation, directory listing and file reads, outside-workspace and private-state refusal, secret file permissions and terminal-only startup. The five earlier [native primitive probes](native-arena/verification.md) cover task ownership, replay, completing, transaction read order and withdrawn stable-ID follow-up. An interactive PTY smoke test checked key entry, persistence, restart and Ctrl+C. There is **no live OpenAI call** in these tests. Pending in-flight OpenAI crash/restart behavior, real-provider tool use, hard deadlines, and exactly what external side effects survived a cancellation need separate verification. SQLite WAL/NORMAL does not guarantee the newest commit on power loss.

Historical explorations of stock Pi frontend reuse and remote pods in [`host-arena/`](host-arena/synthesis.md) are withdrawn. [`kaeno.sketch.ts`](kaeno.sketch.ts) is a pre-implementation sketch, **not** a second job implementation.
