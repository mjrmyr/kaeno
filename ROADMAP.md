# Kaeno roadmap

Decided for later; not built yet.

## Second implementation part: files
Exchanging files between the user and kaeno, and between sub-agents and the user. Today sub-agents return text only
and their workspace is deleted with the sandbox. Open design points:
- **In**: attachments from Telegram (photos, documents) and pi into a sub-agent's workspace.
- **Out**: artifacts produced by sub-agents (reports, patches, generated files) delivered back: Telegram documents, a
  download endpoint on the API, or pushed to a git remote (the GitHub deploy key exists).
- **Where they live in between**: kaeno's PVC (durable, small) vs. object storage; retention.
- Likely needs a per-delegation "outbox" directory that kaeno collects before deleting the sandbox.

## Long-lived agents
Multiple persistent agents similar to kaeno (own threads, own memory) next to the one-per-task
sub-agents. pi-durable supports this directly (background subagents owned by an anchor task, messages delivered as
follow-ups; see pi-durable example 23). Needs: naming/addressing agents from channels, their own sandbox lifetime.

## Clients
- Mobile/web app on top of the native API (`/v1/threads/:key/turn`), probably with a live view of a thread
  (pi-durable `watchEvents` already provides the event stream).

## Operations
- Budgets/limits (spend per task, per day), using pi-durable's per-conversation usage (`pi.usage`).
- Backups of `/data/kaeno.sqlite`.
- Workspace persistence across sandbox restarts (PVC per sandbox) if long-running work needs it.
- Remove the local llama.cpp stack (`apps/llama-cpp`) from the homelab if nothing else uses it.
