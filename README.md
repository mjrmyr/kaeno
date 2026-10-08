# Kaeno

Kaeno is a local personal assistant with **one continuing contact conversation** and configurable background read-only specialists. It uses one Pi Durable Harness and SQLite store, and a custom terminal chat built with `@earendil-works/pi-tui`—not Pi's stock coding-agent screen. No web server, pod workers or demo mode.

## Run

Requires Node.js 24+ and an interactive terminal.

```sh
npm install
npm start
```

On first launch, enter an **OpenAI API key in the TUI**. You can paste it with Cmd+V in a macOS terminal. It is visible while you type so you can check it; Ctrl+R hides or reveals it. Visible input can be captured by terminal recordings or scrollback. It is stored locally in `.kaeno/credentials.json` (mode `0600`, **plaintext**; not an OS keychain). `.kaeno/` is gitignored. `/key` replaces it later. Don't share this file or your process environment. Kaeno uses OpenAI `gpt-4o-mini` for the contact and the starter specialist. No `KAENO_DEMO` or `OPENAI_API_KEY` setting is needed; there is no simulated response mode in the application. This project has **not been tested against the live OpenAI API** without a user-provided key.

Type a message and press Enter; Shift+Enter inserts a newline. Commands:

- The TUI shows running jobs automatically, not completed or failed ones. `/jobs` toggles recent job history on demand; `/job ID` shows a specific saved result. `/jobs` also dismisses a selected card.
- `/stop`: stop the contact's current answer; `/cancel ID`: request cancellation of a specialist job.
- `/key`: update the API key in the TUI; Ctrl+R toggles visibility while entering it.
- Ctrl+C: close the TUI and local Harness. Restarting from the same directory restores the contact and saved jobs.

The initial `reader` specialist is created at `.kaeno/agents/reader.json` on first launch. Edit that trusted JSON **while Kaeno is stopped** to change its instructions or absolute workspace, or add another JSON file with a unique `name`. Allowed `tools` are `[]` or `["read"]`; `"read"` also gives the specialist a workspace-scoped `list` tool for finding files in directories. The model must currently be `gpt-4o-mini`. **If the path you ask it to inspect is outside `workspace`, stop Kaeno, set `workspace` to that directory's absolute path in `reader.json`, then restart.** For example, to inspect `~/docs/daily`, set `workspace` to `/Users/km/docs/daily` (not the literal `~`). Relative paths start at the workspace; user-supplied `~/...` paths expand to your home directory but still require approval. Out-of-workspace reads are refused rather than silently granted. The read and list tools refuse Kaeno's private state, but this is **not an OS sandbox**: all jobs run in the same process with your permissions. Files read by a specialist may be sent to OpenAI. Do not configure untrusted specialist code. Only one Kaeno instance can run locally: a loopback port (`127.0.0.1:4317`) gates startup but serves no HTTP traffic.

The contact can delegate autonomously using its `delegate` tool. Each assignment gets a native background Job and private child conversation. A result card is saved before one stable-ID follow-up is attempted. The contact stays available while a job runs. Native tasks can resume after a restart; **an in-flight OpenAI request may be repeated**, and a follow-up attempt is not proof the user read it. Cards and native status remain inspectable. Use `npm test` for offline scripted-provider integration checks and `npm run check` for TypeScript. The live-provider path, crash windows during actual provider calls, terminal owner-lock limitations and physical-loss SQLite durability still require production verification.

## Design and evidence

- [Current implementation and boundaries](docs/design/minimal-kaeno.md)
- [Tradeoffs](docs/design/kaeno-rationale.md)
- [Original native-job arena and primitive probes](docs/design/native-arena/synthesis.md)
- [Historical typed job sketch (superseded by `src/jobs.ts`)](docs/design/kaeno.sketch.ts)
- [Withdrawn distributed/stock-frontend arena](docs/design/host-arena/synthesis.md)
