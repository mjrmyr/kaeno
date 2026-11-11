# Proposal: continue a published PR after its publishing WORK ends

Status: investigation and proposed fix only. No runtime behavior changes.

## Incident and evidence

The reported sequence is: k3 published #75 (merged), delegated the follow-up
#76 to fresh child WORK #1028, then successfully followed #76 after feedback.
`message_work` rejected #1028 as finished; k3's old checkout was unavailable,
and checkout rejected both a missing saved workspace and a different branch.
These are observations supplied with the incident, not independently retrieved
production logs.

Repository inspection was against main at
`a3dc99c7943a3bae4d1e66eb63708ebf54beab6a`. GitHub metadata retrieved during
investigation independently confirmed that
[#76](https://github.com/mjrmyr/kaeno/pull/76) was open, not merged, with:

- head branch: `kaeno/eb456832-0550-4f2f-a2e1-1ce86ff305fb/1410825200`
- head SHA: `39353d486c05617cecaccdd9dae9e0528e3fcb56`
- base: `main`, SHA `a3dc99c7943a3bae4d1e66eb63708ebf54beab6a`

The implementation explains the symptoms without assuming the ticket ended:

| Mechanism           | Actual behavior                                                                                                                                                                                                                                                   | Source                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Child completion    | Final report durably marks the WORK terminal, then frees its environment. Ordinary child conversations are aborted.                                                                                                                                               | `src/core/work/task.ts`, `report`, `freeEnvironment`                                                                                         |
| Message delivery    | `requireChild` rejects terminal **or abort-requested** tasks with `Work #… has already finished`. The tool is not a restart API.                                                                                                                                  | `src/core/work/directory.ts`, `requireChild`                                                                                                 |
| Ticket continuation | A ticket conversation can outlive a successful Assignment. A terminal Assignment is not an ended ticket.                                                                                                                                                          | `src/core/work/task.ts`, `conversationOutlivesRun`; `src/core/router/engine.ts`, `report`                                                    |
| Files               | Docker/microsandbox ticket environments can be suspended and retained; child environments are released. Kubernetes has no suspend implementation and releases even ticket execution environments.                                                                 | `src/core/work/task.ts`, `freeEnvironment`; `src/extensions/execution/sandbox-work-environment.ts`; `src/extensions/kubernetes/extension.ts` |
| Thread following    | Adds the ticket to a thread's subscribers. It neither resumes a child task nor transfers files or GitHub state. Automatic publishing follows only when the publishing conversation has a `TicketRef`; a normal child publish need not follow its parent's ticket. | `src/core/router/engine.ts`, `followConversation`, `follow`; `src/extensions/github/extension.ts`, publish completion                        |
| Checkout ownership  | `kaeno.github-workspace` is conversation-scoped. A ready checkout whose directory disappeared fails closed. Its saved `base`, not its publishing branch, is compared with the requested checkout branch.                                                          | `src/extensions/github/extension.ts`, `Workspace`, checkout                                                                                  |
| New work            | A fresh conversation gets a new generated publishing branch. Checking out an existing PR branch merely uses that branch as the new checkout's base; it does not adopt the PR's publishing identity.                                                               | Same checkout implementation                                                                                                                 |
| Fetch               | Requires this conversation's saved publication or pending publish. Imports into an existing checkout; it is not a lost-workspace or cross-WORK recovery API.                                                                                                      | Same file, `fetchWork`                                                                                                                       |

The exact reason k3's directory disappeared cannot be established from these
sources alone. Backend, reservation history, and cleanup logs would distinguish
normal Kubernetes Assignment release from unexpected sandbox loss. Nor can the
old child task's terminal outcome be independently inspected with this worker's
authorized child tools. The tool error matches the terminal/abort guard above;
it does not prove the ticket closed.

## Root cause

**The publication outlives its publishing execution, but its continuation handle
is stored only in that execution's conversation-local workspace state.** Thread
routing survives independently and gives a misleading impression of resumability.
The sandbox deletion and terminal-task guard are intentional lifecycle behavior;
removing either guard does not provide a sound PR continuation contract.

This also explains why delegating #76 solved the one-checkout limitation after
#75 but did not solve later review edits. The newly created child had the needed
publication state, then finished. Following the PR on k3 repaired routing only.

## Recommended fix: explicit PR adoption in fresh WORK

Add a native tool, proposed signature:

```text
github_resume({ repository, pullRequest })
  -> { path, base, branch, sha, pullRequest, thread, following,
       recovered: "published-commits-only" }
```

Keep task terminality, sandbox cleanup, and ordinary checkout's fail-closed
semantics. Do not resurrect #1028. A new child or ticket Assignment resumes the
**artifact**, not the old execution.

### State and execution contract

1. Persist a publication record independently of sandbox/conversation lifetime,
   keyed by installation, repository ID, and PR number. Record publishing branch,
   PR base branch, confirmed published SHA, and originating conversation for
   provenance. Populate it during publish completion. Do not store tokens or
   bundles in it. Durable publication identity is not a promise to preserve
   uncommitted files.
2. On resume, verify installation assignment and repository access, then retrieve
   current PR metadata. Require open/unmerged status, a same-repository head,
   and identity matching the durable publication record. A `kaeno/` branch name
   alone is not provenance. Reject unsupported fork heads and arbitrary PRs.
   Legacy publications such as #76 need a trusted migration from their saved
   Workspace/publication history; never invent provenance from model text.
3. Read the **current** remote head and pin its SHA as the adoption intent. It
   may contain owner commits newer than the last published SHA. Materialize that
   commit through the existing host-authenticated bundle transport, with no
   credentials in the sandbox. Keep the PR's actual base branch distinct from
   the adopted head SHA; do not set the PR base to the work branch.
4. Seed the new conversation's checkout with the existing publishing branch,
   actual PR base, and adopted SHA as the expected remote head for subsequent
   publication. Preserve the existing PR, not a second generated branch/PR.
   The initial checkout SHA is the adopted commit; no source-workspace pending
   intent is copied. Subsequent edits use ordinary snapshot, publish, and comment.
5. Respect the current one-checkout-per-repository contract. Refuse an unrelated
   checkout or any existing target directory rather than replacing it. For k3's
   stale #75 checkout, use fresh WORK. An identical completed resume is a no-op;
   partial installation may be retried only through its saved ownership/intent,
   using the existing interrupted-checkout installation mechanism.
6. Retain existing publish protections: closed PR checks, expected-head comparison,
   and ancestor checks. If another worker or owner pushes after adoption, fail
   safely and require `github_fetch`, integration, tests, then publish. No force
   push, silent branch recreation, or automatic resetting of local files.
   Concurrent adopters need not lock a whole review cycle: expected-head checks
   reject stale differing publications. Verify this with a race test.
7. Follow the PR for the adopting ticket when there is one. For ordinary child
   WORK, return `following: false` accurately and tell the parent to follow the
   returned thread. Tool text must say that this resumes published commits only;
   unpublished files in a deleted sandbox cannot be recovered.

As with existing publish completion, SQLite and GitHub are not one transaction.
A lost response after remote publication must reconcile through the existing
PR/branch lookup before committing the independent publication record. Resuming
must use a pinned intent across retries, not silently adopt a newer head halfway
through installation.

### Alternatives considered

- **Retain/resurrect every child until PR closure:** couples task capacity and
  sandbox retention to arbitrary external review duration. Does not handle lost
  pods or fresh workers and weakens terminal-task semantics. Not recommended.
- **Reset checkout when a saved path is missing:** risks hiding unpublished loss,
  may restore the original base rather than the PR head, and does not transfer
  publishing identity across conversations. Keep the guard.
- **Broader persistent agent volumes:** useful separately, but unnecessary for
  this published-artifact recovery and insufficient across backend loss. Avoid
  making this fix depend on the continuity phase-2 proposal.

Applied principles: **Make Operations Idempotent** requires pinned recovery
intents and response-loss tests; **Laziness Protocol** favors artifact adoption
using the existing transport/publish guards over a second long-lived execution
lifecycle. This proposal adds only publication identity durability, not generic
workspace persistence.

## Verification and acceptance criteria

Existing targeted tests, run against the inspected revision using Node v24.22.2:

```sh
npm ci --ignore-scripts
npm test -- test/integration/work-lifecycle.test.ts \
  test/integration/work-contracts.test.ts \
  test/integration/ticket-workspaces.test.ts \
  test/integration/ticket-workspaces-restart.test.ts \
  test/integration/github-fetch.test.ts \
  src/extensions/github/github.test.ts
```

Result: **6 files passed, 35 tests passed**. These confirm current lifecycle,
retention, fetch, retry, and routing contracts, not the unimplemented resume API.
The existing suite does not directly assert the three incident error strings.

Required new integration coverage before implementation is considered complete:

- Publish as a child, finish/release it, and reject messaging that terminal child;
  keep its parent ticket open and route subsequent review to it.
- New WORK adopts that PR after the old sandbox is gone; edit/test/publish updates
  the same PR and branch, without creating another PR.
- Adopt a head containing an owner's newer commit; concurrent push after adoption
  rejects stale publish and succeeds only after fetch/integration.
- Repeat resume, restart SQLite during installation, and lose publication/resume
  responses. Reconcile idempotently without deleting or resetting local files.
- Reject unauthorized repository/installation, unknown provenance, fork PR,
  closed/merged PR, missing branch, dirty/unrelated checkout, and mismatched
  metadata. Explicitly cover legacy-record migration for #76-style publications.
- Assert the original missing-workspace/different-base guards still hold and
  that child vs ticket `following` results reflect actual subscription behavior.

## Immediate operational conclusion

No existing tool combination guarantees continuing #76 with its current publishing
identity in a fresh worker. `github_checkout(branch: <PR head>)` would not do it;
`github_fetch` cannot bootstrap absent state; `follow_thread` changes routing only.
Do not claim recovery by retrying these calls, manually copying inaccessible
state, or bypassing credentials. Implement and verify adoption first (including
legacy provenance), or have a human maintainer apply the requested #76 edits via
their normal checkout. This investigation leaves #76 unchanged and deploys nothing.
