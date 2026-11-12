# Ticket-owned GitHub publications

This replaces the resume/adoption proposal in #81 with the implemented ownership
model. There is no new resume or adoption tool. Deployment is outside this change.

## Usage

Within a ticket, `github_checkout({repository})` continues its single open
publication in a fresh worker. The returned path belongs only to that worker.
With multiple open PRs in that repository, select one using
`github_checkout({repository, pullRequest})`, or explicitly start another using
`github_checkout({repository, newPublication: true})`. Selection is restricted to
the authoritative owning ticket; there is no model-selected ticket identifier.
A worker still has only one checkout per repository. A different publication
requires fresh work rather than overwriting existing files.

Closed or merged PRs are not continuation candidates: after #75 merges, the next
fresh worker can publish #76, while retaining #75's historical record. Parallel
open PRs remain separate publications instead of overwriting one repository slot.
Ordinary standalone, non-ticket work retains its conversation-local behavior;
cross-ticket transfer is not part of this interface.

## Ownership and safety

- A session document family keyed by ticket stores multiple publication records:
  repository, branch, base, last confirmed published head, and PR number.
- Core resolves ticket ownership through saved WORK ancestry, including children
  without a direct ticket reference. Successful child publication follows the PR
  for that same owning ticket in the completion transaction.
- Checkout files, accepted published head, fetched head, pinned pending snapshot,
  and comment retry intent stay conversation-local. A shared confirmed head never
  reparents another worker's stale files or advances its accepted head.
- A stale worker must fetch and integrate before publishing. Fetch preserves files
  and HEAD; integration is checked before publishing. Ordinary Git remote-head
  checks still reject external races without force-pushing. Shared metadata is
  updated atomically and cannot silently overwrite a newer confirmed publication.
- Response-loss retries retain their original snapshot, expected head, title, and
  body. An explicit fetch supersedes pending publication intent; subsequent edits
  require a new snapshot. GitHub PR lookup reconciles creation retries.
- Every call still checks the calling worker's assigned installation and obtains
  repository-scoped authorization. Sharing metadata never grants permissions.

Startup internally converts saved published/pending workspace records into
missing ticket publication records, even if the original worker environment no
longer exists. Conversion is idempotent and does not copy files, overwrite newer
publication metadata, or pretend a replacement worker has integrated anything.
No model migration tool or manual credential-based operation is required.

## Scope and verification

The Kubernetes ticket-workspace persistence introduced by #78 remains unchanged.
Persistence of a root environment and publication ownership are different concerns:
a fresh child or later worker still needs its own accepted-head and file state.

`ticket-ownership.test.ts` covers direct and nested/ended WORK ownership,
standalone work, cycles, and child auto-follow resolution.
`github-publications.test.ts` uses real durable conversation documents, isolated
worker environments, and real Git repositories to cover child continuation,
stale-worker fetch/integration, parallel PR selection, closed-PR succession,
cross-ticket rejection, authorization, idempotent legacy conversion without the
publisher's files, pinned response-loss intent, and concurrent ordinary pushes.
The existing real-Git integration tests continue to cover dirty files, external
push races, interrupted imports, response loss, and ticket auto-follow. These use
mocked GitHub HTTP APIs; they do not establish live deployment compatibility.
