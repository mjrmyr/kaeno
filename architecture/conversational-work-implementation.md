# Conversational work: implementation

Implemented locally; no commit, push or deployment performed. The architecture synthesis is
[conversational-work.md](conversational-work.md); exploratory candidates are not runtime contracts.

## User contract

- CHAT handles ordinary conversation. Substantial requests get one fresh background WORK conversation and an immediate
  ticket/short planning acknowledgement, not a wait for pod readiness, execution or review.
- WORK uses the configured orchestrator model/settings/skills, reasons independently, and may finish without workers.
  Execution uses foreground WORKER delegates; WORK owns fanout, joins and review. New WORKERs are execution leaves.
- No extra template/model preference or coordinator pod. Provider secrets stay in Kaeno; shell/files/Git stay in workers.
- `/jobs` lists jobs; `/cancel <id>` requests cancellation of one owned job. `/stop` fences prior queued inputs,
  stops the current reply and requests cancellation of this chat's work. `/new` resets CHAT but retains work;
  old-context results are labelled and delivered directly, not inserted into fresh CHAT.
- Telegram receives proactive results. Pi's existing provider shows the current CHAT answer only; ask for status or use
  the API feed. Automatic unsolicited pi TUI injection and steering are deliberately not implemented.
- Lost pods lose workspaces. Reasoning/bindings/images are durable; workspace restoration is not promised.

## Owners and data

- `src/work.ts`: `createWork()` installs the `kaeno.work` task and start/list/cancel tools. The conversation-owned
  background task owns WORK's conversation and its foreground subtree. Native task state is execution status;
  `WorkIndex` only maps originating request IDs to allocated native TaskIds. Different briefs in one request do not
  create multiple coordinators. No detached invocation API or invented deterministic TaskId.
- `src/agents.ts`: CHAT/WORK/WORKER tool surfaces, immutable blueprint capture/configuration, foreground delegates,
  skill reads, pods and bounded cleanup. Blueprint contains templates, model settings, concrete skill bindings,
  execution image and cache claim. Jobs never resolve later delegates through mutable current configuration.
- `src/sandbox-slots.ts`: one session-scoped FIFO/reservation owner. Four held slots, 128 waiting delegates; legacy
  physical pods consume/adopt capacity. Terminal-task cleanup reconciles after restart; release requires confirmed
  pod absence. Namespace quota remains final authority. Quota exhaustion waits; unrelated Forbidden errors fail.
- `src/turns.ts`: one shared admission/delivery owner used by API, Telegram and schedules. `TurnLedger` captures
  provenance, immutable origin route, epoch, receipt/delivery states and replayable replies before tools can run.
  `kaeno.turn` retains its name/version and supports old run/notify checkpoints without prior ledger state.
  Moving this owner out of `threads.ts` avoids a work→agents→threads dependency cycle.
- `src/threads.ts`: durable thread directory and CHAT configuration refresh. Unrelated background work does not pin
  CHAT's configuration; actual foreground/inbox/Turn activity still does. Active WORK remains frozen.
- Channel adapters validate transport inputs and observe/deliver. Production registers all definitions before resume.

Mutating work tools resolve authority from the one active durable submission (`followUpMode: one-at-a-time`).
Work-result provenance is application-owned, not parsed from report text, and cannot start or cancel work.
Internal report request-ID prefixes are reserved from API clients; reuse with different content/provenance is rejected.

## Concurrency and delivery

`kaeno.control` is a durable owner for stop/reset/targeted-cancel commands. Stop/reset admission atomically increments
an epoch and installs a fence. A short durable permit covers native submission admission only. Control waits for any
permit to settle, withdraws old queued inputs, then aborts/resets; new user admission is deferred until the fence is
cleared. Stale model tool calls check the fence/epoch again inside WORK admission. Crash recovery reruns control
idempotently. Telegram's command admission and polling offset advance share one commit.

Completion turns wait for the originating acknowledgement to finish delivery, not simply model generation. Failed or
cancelled acknowledgements unblock results rather than strand WORK. Work completion and delivery failure are separate.
API acknowledgement means a durable server reply, not proof the client read it.

Notification dispatch claims `dispatching` atomically with suppression/epoch checks. Cancellation wins **before** the
claim; afterward the send is in flight and cannot be unsent. Restart retries claimed sends. Telegram delivery is
**at-least-once**: send and SQLite commit are not atomic, and retrying a multi-chunk send can repeat earlier chunks.
Notifications retry up to six attempts; failures are reported and retained in the API feed. No exactly-once claim.

HTTP POST connection loss aborts only observation, disposing event watches/timers without cancelling admitted work.
Trace buffering is bounded/best-effort. `GET /v1/threads/:key/replies?after=N` returns durable ordered replies, next cursor
and truncation indication independently of POST; `GET /v1/threads/:key/work` returns job views.

## Local defaults / retention

- Four sandbox pods globally; 128 waiting delegates.
- 32 active WORK requests per chat; 64 pending replies before deferring/rejecting new user admission.
- Last 500 replay replies; 512 recent terminal receipt/job-index entries plus active entries.
- Suppression history is compacted only when neither WORK nor an independent report Turn can still dispatch.
- Native SQLite task/conversation history and immutable skill artifacts are not garbage-collected by this change.
- Remote cleanup has a five-second hard transport bound; pod deletion still runs afterward. A pod that persists keeps
  its reservation and cancellation remains pending until reconciliation confirms removal.

## Verification

Local full suite: **77 tests across 10 files**, TypeScript check, native Node imports and whitespace checks.
Integration tests use faux models and fake Kubernetes; durable execution tests run a real envd subprocess.
They prove:

- Input B answered while A reasons in WORK; no compulsory pod.
- Instant completion held behind real acknowledgement delivery; captured route survives interleaving.
- SQLite reopen resumes reasoning and real-envd execution, with surviving/recreated sandbox and frozen image/skills.
- Idle CHAT refresh while active WORK stays frozen; legacy foreground delegation still replays.
- Reset preserves work with labelled direct results; queued old user inputs are withdrawn before fresh CHAT.
- Stop fences pre-submission inputs; one request cannot spawn two independent coordinators.
- Result-origin tools cannot mutate work; cross-chat cancellation is rejected and unsent results suppressed.
- Dispatch-claim cutoff, old notify checkpoints, failed acknowledgement fallback and disconnected API replay.
- Four-slot FIFO/adoption/recreation, confirmed physical release, queued cancellation and queue bound.
- Cleanup and cancelled-RPC timeout against a server that never sends headers or acknowledges cancellation.

An independent readonly GPT review found the stop/reset/dispatch races and other correctness gaps; fixes and regression
cases are included. Docker Desktop smoke (`scripts/verify-runtime-skills.sh`) also passed: both generic images build,
all layers exclude skill content, actual Git/npx installation runs under UID10001/read-only root, repeated init converges,
and workers can execute assigned assets without cache/unassigned/write access. Temporary images/volumes were removed.
This is **not** container-level background-orchestration or live Telegram/cloud-model/Kubernetes proof. No live changes
were made.

Before rollout: build normally, obtain approval for push/deploy, and verify Telegram's acknowledgement → second request
→ later result plus real worker cleanup.
