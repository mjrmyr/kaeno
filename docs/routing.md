# Routing: one router, many tickets

Kaeno is one agent across every channel: the owner never has to wonder which session knows what. That is a two-level design, after DeepSeek's [Super-agent harness](https://github.com/deepseek-ai/dsh-superagent-prototype):

| Level      | Is                                                                                            | Has                                                    |
| ---------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Router** | One long-lived conversation that every event from every channel reaches. It talks and routes. | Routing tools, owner memory, routine proposals, skills |
| **Worker** | One conversation per **ticket**, isolated from every other. It does the work and reports.     | Execution tools, sandboxes, child WORK                 |

The router never executes anything: it has no execution tools, by host policy rather than by prompt. Workers never talk to the owner: they report to the router, which owns every reply. So unrelated tasks never share a context, the router stays responsive while work runs, and the owner hears one voice.

`src/core/router/` is the design; `src/core/outbox/` sends; WORK (`src/core/work/`) runs the tickets.

## Concepts

| Concept        | Is                                                                                                                                       | ID / key                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Trigger**    | One event: an owner's message, later an email or a CI result. Records its source, threads, authority, content and where a reply goes.    | `t12`; deduplicated by a source key (`telegram:<update>`)    |
| **Thread**     | An event stream as its source defines it. A thread never owns a conversation; it holds **subscriptions**.                                | `telegram:<chat>`, `telegram:<chat>/topic:<id>`, `pi:<hash>` |
| **Ticket**     | One unit of work: a worker conversation that outlives its runs, the threads it follows, its inputs and reports.                          | `k3`                                                         |
| **Assignment** | One run of a ticket: root WORK on the ticket's conversation. A new input after a run ends starts the next Assignment, with context kept. | the work's task ID                                           |

The **Engine** (`engine.ts`) is the only writer of these records. Commands take the caller's transaction and change their records in it; work outside the database (a router submission, steering a worker, a send) is admitted as a durable task in the same commit and done after it. Records are pi-durable document families keyed by ID, so none grows without bound.

## An event's path

1. **Gate (Fast Path filter).** A source hands the Engine a trigger. Code decides per source whether it is `explicit` (the owner asked), `candidate` (nobody asked: judged against the owner's written preferences) or `ignore`. Owner DMs, Pi and HTTP are explicit.
2. **Pass-through (Fast Path routing).** If tickets follow the trigger's primary thread, it goes straight to them: steered into a running worker after its current step, or waking an idle ticket. The router only gets a passive `<passed …>` note that does not wake it, so it keeps track of everything without deciding again.
3. **Router (Slow Path).** Anything else is submitted to the router. Triggers that arrive while the router is busy are placed together in its next turn (`followUpMode: "all"`), so a burst costs one long-input, short-output request instead of many.
4. **Decision.** Every owner trigger gets exactly one: a **reply**; **accept** (a new ticket); or **attach** (to an existing ticket, only when the message clearly refers to it). If a turn holds exactly one owner message and the router answers it directly, that answer is the reply. After each turn, code checks every owner trigger got a decision. One left undecided gets a single reminder; if it is still undecided, the owner hears that it could not be handled. A message is never silently dropped.
5. **Accept.** The Engine creates the ticket's conversation and records, and subscribes the ticket to a thread of its own when the channel offers one (a Telegram topic or reply chain). It sends the router's one-sentence acknowledgement there and queues the first Assignment. The worker receives the owner's message **verbatim**, not a rewritten brief. The router may add a note with facts the message lacks, from memory or other tickets.
6. **Reports.** A worker reports `progress` (a passive note), `waiting` (a question), `blocked`, `ready` (its final answer), `failed` or `dropped` (nothing to do: ends the ticket quietly). The router relays results and questions briefly. The owner's answer in the ticket's thread reaches the worker directly.

## Slots

Accepting never fails for lack of capacity: a ticket waits in the queue (`queued`) until a WORK slot is free (`KAENO_WORK_MAX_CONCURRENT`). Waking a ticket that already ran goes first and may use one reserved slot above the limit, so new work never blocks the owner from continuing a ticket. Launches are idempotent: `k3`'s second Assignment always has the key `k3:2`.

An idle ticket keeps following its threads for 14 days; after that it ends, and a later message there goes to the router.

## Context: Inline & Spill and Chain of Recall

The router's context is a cache. Every object it sees is rendered by `render.ts`:

- **Inline** what is likely needed next. Each trigger shows its ID, thread, the tickets following that thread, the open tickets, a stub of the message it replies to, and its text.
- **Spill** the rest behind a pointer. Text over 4,000 characters is cut and ends with `recall t12 offset=4000`.

`recall` (Chain of Recall) reads one object in full and names its neighbours by ID, so the router can walk the graph hop by hop: a thread lists its recent triggers (newest in full, older ones shorter) and followers; a ticket lists its threads, inputs, Assignments and reports; a trigger lists its tickets. Long router histories are compacted automatically; losing old detail costs one `recall`, not the thread of the conversation. `/new` compacts on request.

## Authority

Messages, reports and documents never grant permissions. Owner authority comes only from an allowlisted owner's own message or a routine run the owner approved:

- `route accept/attach`, `stop_ticket` and every router extension tool that changes something must cite **basis**: the ID of an owner trigger in the batch in front of the router. The tool policy (`src/core/authority/`) adds that parameter to memory and routine tools and checks it. A worker report is not a trigger and can never authorise saving memory, proposing a routine or starting work.
- Ticket roots get `report`, `handback` (an event that is not about their ticket goes back to the router), `unsubscribe_thread` and `follow_thread`. Child WORK keeps `message_parent`.
- Workers never see owner memory; the router puts the facts a task needs into its note.

## Channels

Each delivery channel tells the router its norms. Telegram: at most 100 words per message, enforced by the `reply` tool; conclusions, decisions and single questions; details on demand (`/show k3`). The terminal (Pi, HTTP) may be denser.

Telegram threads:

- The private chat is the owner's main thread; it goes to the router.
- With `"topics": true` (needs the bot's threaded mode) each ticket gets a **topic**. Messages there pass straight to its worker.
- Without topics, or when Telegram refuses to create one, a ticket's thread is a **reply chain** anchored at the owner's message. Replying to any of Kaeno's messages in it continues the ticket.
- Commands are decided by code, not a model: `/stop` (this ticket, or everything in the main chat), `/cancel k3`, `/show k3`, `/jobs`, `/new`.

## Not in this cut

- **Proactive sources** (group chats, email, calendar, GitHub notifications as `candidate` triggers) and **acting ahead** (speculative background work). The gate and its modes exist; the sources do not yet.
- **A watchdog session** that judges whether workers make progress. Durable recovery and the environment reconciler cover infrastructure failures.
- **Bring-your-own-machine endpoints.** Execution providers already separate the agent loop from its environments (Docker, microsandbox, Kubernetes); a remote-host provider fits that seam.
- **Router sharding.** One batched router is enough at this scale.
