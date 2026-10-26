# Personal continuity

An always-on agent has to remember who it works for and keep what it was working on. Kaeno splits this into two parts:

| Part                     | Means                                                          | Status            |
| ------------------------ | -------------------------------------------------------------- | ----------------- |
| Owner memory             | Preferences and facts, shared by every thread                  | **Phase 1 (now)** |
| Persistent working state | Files, checkouts and browser logins that outlive a single WORK | Phase 2 proposal  |

Ownership (goals, commitments), activation (schedules, events) and delegated authority (approvals) are separate pieces of work. They build on this, but are not part of it.

## Phase 1: owner memory

`src/extensions/memory/` is a standard extension, `kaeno-memory`. Memory has two kinds of entry:

| Kind       | Is                                     | In Kaeno's prompt                 |
| ---------- | -------------------------------------- | --------------------------------- |
| Preference | How the owner wants things done        | In full, so it applies every turn |
| Memory     | A fact, with a title and a longer body | ID, date and title only           |

The prompt carries an **index**: every preference, plus the title of every memory. Kaeno therefore knows what it should always do and what it knows, without carrying every body on every request. It reads the bodies it needs with `memory_read`.

- **State.** One session-scoped durable document, `kaeno.memory` v1: `{ entries: { [id]: { kind, title?, text, savedAt } } }`. It is independent of threads, so it survives `reset` and is shared by every client. It is one document rather than one per entry because pi-durable cannot delete a document, and forgetting must actually remove the text.
- **Tools.** `memory_save({ kind, title?, text, replaces? })`, `memory_forget({ id })` and the read-only `memory_read({ ids })`. Preferences are one line of at most 300 characters, and there are at most 30 of them. Memories need a one-line title of at most 80 characters, keep a body of up to 4000 characters, and there are at most 200 of them. A full kind refuses new saves until an entry is replaced or forgotten, instead of silently evicting.
- **Prompt.** A `memory` section renders the index before each request, so an entry saved in one thread is in the next request of every other thread. It only changes when memory changes, which keeps provider prompt caches warm. Bodies never enter the prompt except as `memory_read` results.
- **Idempotency.** An entry's ID is `m<tool task id>`. A replayed `memory_save` finds its entry and changes nothing, including a replayed `replaces`. Forgetting an absent ID reports it instead of failing.

### HTTP API

The owner can browse and edit memory directly, without a turn:

| Request                 | Does                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `GET /v1/memory`        | The index: `{ preferences: [{ id, text, savedAt }], memories: [{ id, title, savedAt }] }` |
| `GET /v1/memory/:id`    | One full entry                                                                            |
| `PUT /v1/memory/:id`    | Replace `text` (and `title` for a memory) in place; the kind is kept                      |
| `DELETE /v1/memory/:id` | Forget it; `{ removed: false }` if it was already gone                                    |

Like the rest of the API, these routes are unauthenticated: keep the listener on a trusted network.

### Authority

Memory steers every future turn, so a write is a durable prompt injection if the wrong party can make it. Existing structure enforces the rules; nothing new is needed:

- `memory_save` and `memory_forget` are mutating, so `assistantToolPolicy` admits them only on **user turns** that are not fenced by stop/reset. A work report, which is untrusted data, cannot save or forget an entry. If a report contains something worth keeping, Kaeno can save it on the owner's next message.
- The tools are in the **assistant's** standard tools only. They are not in worker availability, so a worker profile that lists one fails startup. Workers also never see the index. They browse untrusted sites inside sandboxes, so the orchestrator copies only the facts a task needs into its brief.

An assistant profile with an explicit `tools:` list must name the memory tools to get them, like any other tool.

### Not in phase 1

- Search. The index lists every title, so Kaeno can pick what to read. Full-text or embedding search earns its place once titles alone stop being enough to choose.
- Automatic extraction from conversations. Saving stays a deliberate model action on a user turn.
- Guaranteed physical erasure. Forgetting removes an entry from the document; whether earlier document versions persist in SQLite is up to pi-durable's storage and has not been verified.

## Phase 2 proposal: persistent working state

Today every WORK starts empty. Docker mounts a fresh `/workspace` volume per sandbox and removes it on release. The browser runs Playwright MCP with `--isolated`, so cookies and logins are gone after each task. An agent cannot continue yesterday's checkout or reuse a site login.

Three options:

| Option                               | Gives                                       | Cost                                                                                                            |
| ------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A. One owner volume in every sandbox | Simplest. Everything is shared.             | Shared blast radius: one injected task reads every other agent's state and logins. This is Grok Bot's weakness. |
| **B. One volume per agent ID**       | Specialists keep their own files and logins | Concurrent works of the same agent must not share one writer                                                    |
| C. A long-lived sandbox per agent    | Running processes and an open browser       | A second lifecycle beside WORK's ensure/release/reconcile, and the hardest to recover                           |

**Recommendation: B.** It matches the specialist model (an inbox agent owns its mail login, an SWE agent its checkouts) and keeps the isolation between roles that per-work sandboxes give today.

Sketch:

1. **Keying.** A persistent volume named from the environment namespace and the frozen agent ID, mounted at `/home/agent` next to the per-work `/workspace`. Opt-in per agent profile (`persistent: true`), because most workers should stay stateless.
2. **Exclusivity.** At most one live WORK per persistent agent. Admission refuses or queues a second one while the first holds the volume. This matches Kubernetes `ReadWriteOnce` PVCs. The rule belongs to admission, not to a lock inside the sandbox.
3. **Browser.** For persistent agents, the browser recipe swaps `--isolated` for a `--user-data-dir` under `/home/agent`, so a login survives. For 2FA or CAPTCHA steps the owner still needs a hand-off; that is a separate, usability-phase item.
4. **Lifecycle.** `release` and `reconcile` never delete persistent volumes. Wiping one is an explicit owner action. The volume namespace becomes part of the environment identity, so a backend switch with persistent state fails closed like unfinished work does today.
5. **Backends.** Docker: named volume. Kubernetes: PVC per agent. microsandbox: needs checking whether its volumes can outlive a VM.

Open questions: whether queuing (instead of refusing) a second WORK of a busy persistent agent is worth the extra state, and how the owner inspects or exports a volume.
