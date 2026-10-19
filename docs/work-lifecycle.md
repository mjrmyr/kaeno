# WORK lifecycle

WORK distinguishes **progress**, **questions**, and **completion**. English text
such as “publishing now” does not determine lifecycle state; the operation does.

## Progress continues execution

```json
{
  "kind": "progress",
  "text": "Tests passed; publishing the verified snapshot now."
}
```

Pass these arguments to `message_parent`. The notification is delivered without
terminating the tool round or waiting for a reply. CHAT gets a read-only result
turn; a WORK parent gets a follow-up input. The worker continues to its next
operation. Delivery uses the tool invocation as its idempotency key and does not
wait for the worker to become idle. `inspect_work.progress` retains the latest
progress notification.

Do not send a reply or an automatic “continue” in response to progress.

## Questions block explicitly

```json
{ "kind": "question", "text": "Which target branch should I use?" }
```

Use this only for information or a decision the worker cannot obtain itself.
The tool terminates the worker's run. After delivery, `inspect_work` retains both
`message` (the unanswered text) and `pendingQuestion` (ID, text, and timestamp).
The question and environment survive restart and reconciliation. There is no
automatic resume, timeout cancellation, or deletion of blocked work.

CHAT relays the question to the user. A **real user turn** may then call
`message_work`; a worker-result turn cannot start, message, or cancel work. A
user-role model input is not necessarily an authorized user turn: the durable
turn ledger records its provenance. This authority fence is intentional.

Admitting a reply marks the question answered; its dispatch is idempotent and
replayable. Inspection may briefly show `resuming` before the worker runs, then
`running` even if the supervisor still has an older waiting checkpoint. A WORK
parent can answer its child's question directly under its delegated authority.

For compatibility, an existing `message_parent` call that omits `kind` still
means **question**. New calls should always specify the kind. New generated
worker instructions describe both operations; admitted WORK retains its frozen
profile/instructions, while the installed tool schema explains the new argument.
Previously consumed legacy questions may lack the new pending-question metadata.

## Completion preserves results, then removes the environment

A worker's **final answer** is its report, not a progress or question message.
Before that answer, persist requested outputs: for repository changes, finish
verification and `github_publish` and include the returned PR URL and snapshot
SHA. Read-only tasks do not need publication. Local unpublished files are not a
durable output and will be removed with the environment.

The supervisor checkpoints the final report, quiesces execution/children, admits
the idempotent parent notification, and advances to `cleanup`. The report and
notification are durable **before** sandbox removal; notification admission does
not wait for a human to read it or for the channel's notification retries to end.
Cleanup releases the environment and records the terminal result. Inspection
shows `finishing` during this interval. Restarting cleanup never reruns the model
or publication. Transient removal failures are reported, exposed as
`inspect_work.cleanupError`, and retried every five seconds; they do not turn a
verified report into an unreported task fault. Cancellation uses the same
idempotent removal/retry behavior, but intentionally suppresses cancelled reports.

A final answer saying only “publishing now” is still a final answer, not proof of
publication. The orchestrator must check actual artifact URLs/hashes rather than
infer completion from a promise. No natural-language classifier or blanket
resume policy is used.
