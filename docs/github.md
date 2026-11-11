# GitHub App extension

The optional `src/extensions/github` extension lets a worker discover private repositories, check out code in its existing execution environment, inspect pull request/CI diagnostics, and propose changes through a ready-for-review pull request. GitHub is not a core service or an agent-definition field. Other platforms can supply independent native extensions using the same composition seam.

## Owner setup

1. Create a GitHub App with these repository permissions:
   - **Contents: read and write**
   - **Pull requests: read and write**
   - **Checks: read-only**
   - **Actions: read-only**
   - **Commit statuses: read-only**
   - **Metadata: read-only** (automatic)

   The diagnostic tools require **Pull requests: read**, **Checks: read**, **Actions: read**, **Commit statuses: read**, and **Metadata: read**; existing checkout uses Contents access. Retain Contents/Pull requests write only for the existing publishing workflow. No Workflows write permission is needed for these reads. After changing App permissions, approve the installation's updated permission request on GitHub. No additional Kaeno config keys or credentials are needed.

2. Webhooks are optional. Without them, the tools work as described here and Kaeno hears nothing from GitHub on its own. To let workers hear about reviews, comments, CI results and pushes on their pull requests, see [Events from GitHub](#events-from-github).
3. Install the app on **selected repositories**. Start with a disposable private test repository.
4. Generate an RSA private key and store it on the Kaeno host, outside repositories and sandboxes, for example `~/.kaeno/github-app.pem`. Restrict its permissions to the host owner (`chmod 600`). Do not paste it into chat or commit it.
5. Create an owner-controlled file such as `~/.kaeno/github.json`:

```json
{
  "appId": "123456",
  "privateKeyFile": "github-app.pem",
  "installationId": 12345678
}
```

`appId` is the numeric App ID, not the client ID. `installationId` identifies your installation. `privateKeyFile` resolves relative to this configuration file.

GitHub is the source of truth for accessible repositories and permissions. There are no local permission lists or per-agent repository policies. All agents, including Kaeno and nested workers, use the same installation. GitHub tools are included in their defaults when configured. Explicit `tools` lists still override defaults; omit `github_publish` from an explicit list for a discovery/checkout-only agent.

6. No GitHub-specific agent configuration is required. For example, this worker inherits the configured tools:

```markdown
---
name: coder
description: Implement and test changes in authorized repositories.
---

Discover the requested repository, check it out, make the change, and run relevant
checks. Publish a ready-for-review PR and report its URL and verification evidence.
When review feedback wakes you, address it and reply on the PR with github_comment.
```

Add `skills: [your-engineering-skill]` if you have installed an engineering workflow skill. Skills provide instructions, not permissions. Explicit tool lists remain exact; include WORK tools such as `start_work` and `message_parent` if this worker needs them.

7. Start Kaeno with:

```sh
export KAENO_GITHUB_CONFIG="$HOME/.kaeno/github.json"
npm start
```

Git must be installed on both the host and worker image. The provided Dockerfile includes it. Rebuild the image before using checkout/publish with an older image.

The owner configuration is loaded at startup, not watched. The CLI explicitly permits and defaults GitHub contributions for both roles. Agents that actually select GitHub contributions receive the extension-owned installation binding; an explicit empty tool list with no GitHub skills receives none. Already-admitted work retains its frozen bindings and tools. Start new work to pick up newly enabled capabilities. Revoke installation access, repository access, or permissions on GitHub to deny subsequent operations for saved work too. Changing the configured installation does not silently redirect saved work to another installation: mismatched saved bindings fail recovery closed.

Leaving `KAENO_GITHUB_CONFIG` unset installs no GitHub tools and needs no GitHub secrets. Removing the entire extension while saved conversations depend on it fails recovery closed. Old version-1 GitHub bindings are intentionally unsupported rather than automatically broadening their previously restricted access. Back up and explicitly migrate existing bound data, or use a fresh development database, before adopting this binding change.

The assistant receives the capability too. Set an explicit `tools` list containing only `github_list_repositories` (plus any other desired assistant tools) if it should only discover projects before delegating. Otherwise it can delegate by project name and let the worker discover the repository. Mention authorized-repository work in the worker's description so Kaeno can choose it.

## Tools and discovery

- `github_list_repositories {}` returns IDs, current names, and default branches for repositories currently accessible to the installation.
- `github_checkout { repository, branch? }` prepares one branch per repository in the existing worker environment. It returns the absolute checkout path and initial commit SHA. Repeated calls do not reset files. A different branch needs new work.
- `github_publish { repository, title, body }` snapshots tracked and non-ignored local files, preserving binary files, deletions, executable bits, and symlinks. It publishes a work-specific branch and creates or reuses its ready-for-review PR, converting an existing draft to ready. It does not run tests or move local HEAD. When the caller is a ticket worker, publishing atomically subscribes its ticket to the PR thread alongside recording publish completion. The result includes `thread`, `following`, and `draft: false`; `following` is false for conversations outside a ticket.
- `github_comment { repository, pullRequest, body }` posts a top-level PR comment, for example a reply describing how review feedback was addressed. It does not submit a review or an inline review reply. Router calls require owner basis like other write tools; worker calls use the existing frozen tool selection and installation assignment. Ordinary final answers still report through Kaeno, not GitHub.
- `github_fetch { repository }` fetches the existing work branch into `refs/remotes/kaeno/work`, returning its SHA and checkout path. It does not change HEAD, the index or working files, and does not fetch the PR's base branch. The worker integrates changes using ordinary Git commands; publishing requires the fetched commit to be an ancestor of HEAD. GitHub credentials remain on the host.

Use Conventional Commits for `github_publish.title` and any manual `git commit` messages: `<type>[optional scope]: <description>`, for example `feat: add search`, `fix(github): handle retries`, or `chore: update docs`. The publish title becomes both the PR title and the snapshot commit message; local commits are optional and their history is not published. This is agent guidance, not additional tool input validation.

### Incorporating pushes to a work branch

After another account pushes to the worker's PR branch:

1. Call `github_fetch` for the repository.
2. Inspect `git status` in the returned checkout path. Preserve local edits with a commit or stash, then merge or rebase onto `refs/remotes/kaeno/work`. Publishing snapshots files without moving HEAD, so even previously published files may still appear as local changes; preserve them before merging.
3. Resolve and stage conflicts, finish the merge/rebase, restore any stashed edits, and run tests.
4. Call `github_publish`. The new snapshot is parented to the fetched remote commit. If someone pushes again meanwhile, publication is refused; fetch and integrate again.

For example, using the worker's coding tools after fetching:

```sh
cd <checkout-path>
git status
# If there are local changes to preserve:
git add .
git -c user.name=kaeno -c user.email=bot@kaeno.io commit -m "chore: preserve local work"
git -c user.name=kaeno -c user.email=bot@kaeno.io merge --no-edit refs/remotes/kaeno/work
# Resolve conflicts and complete the merge if necessary, then run project checks.
```

No automatic merge, reset or force-push is performed. Deleted branches and non-forward history changes are rejected. An explicit fetch supersedes any failed publish snapshot while preserving current workspace files; ordinary publish retries, without a fetch, still complete the original immutable snapshot. After a response-loss failure, the fetched branch may already include that snapshot.

### Read tools

Every diagnostic tool takes a positive integer `repository` ID discovered through `github_list_repositories`; no checkout is needed. All IDs below are positive integers. `sha` is an exact 40-character hexadecimal commit SHA, not a branch or arbitrary API path.

| Tool                            | Additional arguments       | Result                                                                                                                                                                                                   |
| ------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github_get_pull_request`       | `pullRequest` (PR number)  | Number, URL, title, state, draft/merged flags; `head` and `base` each include branch `ref`, `sha`, and nullable repository `{ id, full_name }`. Fork head repositories may not themselves be accessible. |
| `github_list_check_runs`        | `sha`, pagination          | Check IDs, names, status/conclusion, URLs, timestamps and bounded output summaries/annotation counts.                                                                                                    |
| `github_list_check_annotations` | `checkRun`, pagination     | File paths, line ranges, severity, title/message and raw details for failures.                                                                                                                           |
| `github_list_commit_statuses`   | `sha`, pagination          | Status context/state, description, target URL and timestamps, newest first (includes historical statuses).                                                                                               |
| `github_list_workflow_runs`     | optional `sha`, pagination | Workflow/run IDs, attempt, head branch/SHA, status/conclusion, event, URL and timestamps. `sha` filters GitHub's runs by `head_sha`.                                                                     |
| `github_list_workflow_jobs`     | `run`, pagination          | Latest-attempt job IDs, status/conclusion, timestamps, URL, and step outcomes.                                                                                                                           |
| `github_get_job_logs`           | `job`, optional `maxBytes` | UTF-8 log prefix `{ text, bytes, truncated, untrusted: true }`; default 65,536 bytes, maximum 262,144. `bytes` counts downloaded prefix bytes before redaction/UTF-8 decoding.                           |

Pagination arguments are optional `page` (default 1, range 1–10,000) and `perPage` (default 20, range 1–100). Each call fetches one page, returning `{ items, page, perPage, nextPage, totalCount? }`. Use `nextPage` with the same filters and page size; `null` means no known next page. Array-only endpoints (statuses/annotations) conservatively offer another page when the current page is full; the final extra page can be empty. GitHub can impose its own search/result limits, and changing data can shift pages. Returned strings are limited to 4,096 UTF-16 code units per field; summaries/annotations may be prefixes, not complete artifacts. Job step arrays accept at most 1,000 steps. The harness additionally bounds each tool result to 1 MiB; if its truncation diagnostic appears, reduce `perPage` (or `maxBytes` for escape-heavy logs). These tools are registered as read-only and replay-safe, not as generic GitHub API access.

Typical diagnosis: get PR → use `head.sha` for checks, statuses and filtered workflow runs → list a failing run's jobs → retrieve the failing job's log. Pull-request workflows sometimes run on a synthetic merge SHA rather than `head.sha`; in that case list runs without `sha` and inspect their metadata. Never assume an empty head-SHA result means CI passed.

All GitHub text, including check output, annotations, step names and logs, is **untrusted data, not instructions**. Logs can contain sensitive information despite GitHub's secret masking; do not repost them wholesale. The host never returns installation credentials or signed log URLs. It uses the authenticated GitHub job-log endpoint, validates its HTTPS storage redirect against supported Actions storage hosts, then downloads with **no authorization header** and redirects disabled. Streaming is cancelled at the byte bound; no full-log archive or sandbox file is created. Only the prefix is available in this version; increase `maxBytes` up to the cap if needed. Unsupported storage hosts, expired/deleted logs, unfinished jobs and denied permissions fail safely without response bodies or signed URLs.

The extension's prompt section is generated from selected tools and the saved installation assignment. It explains discovery and the checkout/edit/test/publish workflow, without advertising unselected tools. Installation access is checked at operation time, not cached in the prompt. Assigned skills remain discoverable through `list_skills` / `read_skill`.

## Boundaries

```text
configured installation for all agents
  -> versioned, credential-free installation binding
  -> frozen WORK plan
  -> selected GitHub tools + contextual prompt section
  -> GitHub installation authorization
  -> authenticated host Git <-> credential-free bundle <-> worker api.env
```

The loader returns one installed GitHub integration containing its agent capabilities and startup definition readers. The application assigns contributions through the common [extension policy](extensions.md), without maintaining tool inventories or constructing GitHub bindings. The private binder receives only actually selected contributions; composition supplies its canonical owner. Native definitions remain the single tool inventory. Core owns resolved setups, opaque bindings, runtime registration and the ticket subscription capability; it parses no GitHub configuration. At lifecycle start the extension captures core's `followThread(tx, conversation, thread)` capability. Publish calls it in its completion transaction; core resolves the conversation's ticket and updates both subscription indexes. The GitHub extension never imports a channel, and core never parses a GitHub tool result or thread format.

A binding records only the installation ID. GitHub enforces repository access and permissions on every operation. A binding never selects tools. Every child worker selecting GitHub contributions receives the same configured installation in its own frozen setup. Private keys, App JWTs, and installation tokens are never written to bindings, prompts, results, Git remote URLs, or worker files.

Authentication lives on the host. The extension mints short-lived tokens inheriting the installation's permissions. Discovery uses installation-wide repository access; checkout, publishing, and each diagnostic read request a fresh token restricted to the single target repository. GitHub rejects requests for repositories outside the installation. Repository targeting is an operation detail, not a local allowlist. Host Git receives its token through an ephemeral process environment. Bare host repositories are temporary, do not check out repository code, ignore system/global Git configuration, and disable hooks, credential helpers, and HTTP redirects. Tool errors exclude raw child-process errors and GitHub error bodies. Workers receive Git bundles with objects and refs, never tokens or authenticated remote configuration.

We chose this over authenticated Git inside the worker: arbitrary project scripts should not receive a token they can read or exfiltrate. We also avoided a platform-wide capability registry: tool definitions, bindings, and native prompt sections already supply the required mechanisms. **Boundary discipline** keeps authentication inside the extension; **subtract before you add** and the **laziness protocol** remove duplicated authorization rules and leave repository access and permissions to GitHub.

## Retries and limitations

Checkout saves its base SHA before materializing files. It stages a clone separately and renames it into place. Recovery adopts an already-renamed checkout without discarding edits. A missing previously-ready workspace is an error, not permission to silently recreate it and lose changes.

Publish saves an immutable intent before network writes. It uses a stable conversation/repository branch, checks the expected remote head, performs ordinary non-force Git pushes, and reconciles an existing PR before creating another. A lost response after pushing or creating a PR can be retried, including after restart. A retry completes the saved snapshot: edits made since that attempt need another publish call. The expected remote head is the last published commit, or the fetched head after the worker integrates it. Unexpected updates are rejected until explicitly fetched and integrated. Closed work PRs and PRs with a different base are rejected before updating their branch; start new work for another proposal. Ready-for-review work PRs remain publishable. Existing drafts are marked ready through GitHub's GraphQL mutation; failed conversion leaves publication incomplete and retryable.

Comments save an immutable pending intent before sending. A hidden invocation-specific HTML marker lets a retry reconcile a posted comment after response loss, including a fresh tool call after restart. Retrying a failed comment for the same repository/PR completes the saved body, not new text passed with the retry; use another call afterward for a different reply. This reconciliation assumes GitHub exposes the posted comment and its marker remains intact; it is not a cross-system exactly-once guarantee. Comment listing is paginated and all authentication remains on the host.

Fetch pins its SHA in the invocation memo before importing objects. Recovery fetches that exact commit and repeats the import without changing workspace files. The fetched SHA is saved with the existing conversation-owned checkout, so publishing after a restart uses the same expected head. Unfinished merges/rebases and unmerged index entries cannot be published.

These are external side effects, not SQLite transactions. GitHub access or PR changes can race an already-authorized in-flight request. There is no claim of exactly-once execution across external systems. **Idempotent operations** provide stable intent and reconciliation instead.

V1 deliberately excludes:

- Merge, force-push, administration, and generic arbitrary GitHub API calls.
- Fetching the PR's base branch into an existing checkout; `github_fetch` only updates the existing work branch. Use new work for a fresh base.
- Recursive submodule checkout and Git LFS object materialization.
- Changes to workflow files unless GitHub separately grants the App the required Workflows permission. The recommended setup does not grant it.
- Large repositories: full-history bundles are limited to 100 MiB. The limit is checked after host fetching/bundling, so this is not a host disk quota.
- Durable workspace restoration after sandbox loss. Existing sandbox lifecycle/reconciliation remains authoritative.
- Windows host support for this adapter (Git configuration uses `/dev/null`).

The extension requires supported, patched host/worker Git versions. Git bundles are untrusted input; credentials never enter the worker, but host Git still parses objects supplied by it. Repository isolation does not make repository code or native extensions trusted.

## Events from GitHub

Kaeno's webhook channel has a `github` source kind (`src/channels/webhooks/github.ts`). It needs Kaeno's webhook listener to be reachable from GitHub, for example through Tailscale Funnel.

1. In the App settings, turn on **Webhook**, set the URL to `https://<public host>/hooks/github`, and set a secret of at least 32 characters (`openssl rand -hex 32`). Choose content type `application/json` if asked; App webhooks always send JSON.
2. Under **Subscribe to events**, select **Pull request**, **Pull request review**, **Pull request review comment**, **Issue comment**, **Issues** and **Workflow run**. Workflow runs need **Actions: read-only**, which the diagnostic tools already ask for. Approve the installation's updated permission request.
3. Add the source to `KAENO_WEBHOOKS_CONFIG`, with the secret in a file next to it:

   ```json
   {
     "name": "github",
     "kind": "github",
     "secretFile": "github.secret",
     "self": "<app-slug>[bot]",
     "trust": { "actors": ["<your-login>", "github-actions"] }
   }
   ```

   The source must be named `github`. `self` is the account Kaeno acts as on GitHub: the App's bot login, shown as the author of its pull requests. `trust` lists the GitHub accounts whose activity may reach workers. CI results report as the actor `github-actions`.

Kaeno checks GitHub's `X-Hub-Signature-256` signature and uses `X-GitHub-Delivery` to skip redeliveries. It turns these deliveries into events on the thread `github:<owner>/<repo>#<number>`:

| Delivery                              | Actions                                                                                             | Actor            | Notes                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------- |
| Pull request                          | opened, reopened, ready for review, converted to draft, pushed to (`synchronize`), closed or merged | Who acted        | Closing or merging ends every ticket's subscription to the thread |
| Issues                                | opened, reopened, closed                                                                            | Who acted        | Closing ends subscriptions                                        |
| Issue comment, review, review comment | created or submitted                                                                                | Who wrote it     | Bodies are cut at 4000 characters                                 |
| Workflow run                          | completed, for runs that belong to pull requests                                                    | `github-actions` | One event on every pull request the run belongs to                |

Anything else, including GitHub's `ping`, is acknowledged and ignored. So are events by `self`: a worker isn't woken by its own pushes and comments.

A push is attributed to the GitHub account that pushed it, as reported by GitHub, not to the commit's author, which anyone can set. The owner pushing to a worker's pull request is a trusted account and wakes the worker; a stranger's push is only recorded and never reaches it.

`github_publish` returns the pull request's `thread` and automatically follows it for the publishing ticket. No separate model-selected `follow_thread` call is required. Trusted events wake the idle ticket, with the limits in [who can reach a worker](routing.md#who-can-reach-a-worker). `follow_thread` is still available for other dependencies, and `unsubscribe_thread` opts out. Republishing follows the work PR again.

The subscription is established after GitHub confirms the PR and in the same durable transaction as local publish completion. Remote writes and SQLite are not one transaction: an event arriving before that subscription commits can still reach the router instead. This does not change core's owner-authority checks for accepting or attaching unsolicited system events.

Use `github_comment` to reply on GitHub after addressing feedback. The bot's resulting webhook is ignored by `self`, preventing self-wake loops. Newly admitted work gets the comment tool through default composition; saved work retains its frozen selection. Existing tickets are not retroactively subscribed merely by upgrading: their next successful publish establishes the subscription, or their worker can explicitly follow the thread.

After someone else pushes to the work branch, the worker can call `github_fetch`, integrate the fetched ref using its coding tools, and publish on top of it. See [incorporating pushes](#incorporating-pushes-to-a-work-branch). The webhook only delivers the notification; it never mutates the worker's workspace.

## Embedding

```ts
import { loadGitHubConfiguration } from "../src/extensions/github/index.ts";
import { loadEnvironment } from "../src/host/composition/index.ts";

const githubExtensions = [
  await loadGitHubConfiguration("./.kaeno/github.json"),
];
const configuration = await loadEnvironment({
  configFile: "./.kaeno/config.json",
  extensions: [...githubExtensions],
  policy: (base) => ({
    assistant: {
      available: [...base.assistant.available, ...githubExtensions],
      defaults: [...base.assistant.defaults, ...githubExtensions],
    },
    worker: {
      available: [...base.worker.available, ...githubExtensions],
      defaults: [...base.worker.defaults, ...githubExtensions],
    },
  }),
});
```

Pass the returned configuration to `openKaeno` with storage/models and the chosen WORK environment, as usual. Each `agentRepositories`/`skillRepositories` declaration requires an explicit `provider`: `github` uses isolated anonymous access; `github-app-<installationId>` uses the configured App's host-only credentials for private definitions. Both readers live inside the configured GitHub integration, with no separate host reader argument. An App reader never falls back to public access on failure. Changing installations changes the reader name, so source configuration and cache identity cannot silently redirect.

Without App configuration, install `githubExtension()` (no arguments) in the same `githubExtensions` list. It provides only the `github` definition reader: no dummy runtime, private binding or agent tools. See [definition-reader selection and migration](extensions.md#definition-readers).

## Verification

`npm run verify` covers native read-tool schemas and execution, PR head metadata, pagination/filtering, scoped-token authorization, missing/mismatched assignments, API permission/not-found failures, bounded log streaming, unsafe redirects and credential-free downloads, as well as installation-wide discovery, contextual instructions, default capability availability in Kaeno, root workers, and nested workers, workflow skill loading, binary-safe local Git transfer, interrupted checkout adoption, immutable pending publish recovery across SQLite restart, PR response-loss reconciliation, dirty-workspace preservation, draft-only publishing, GitHub authorization failures, and unexpected remote-head rejection.

These tests use a mocked GitHub HTTP API and real temporary Git repositories/execution environments. A live installation test remains necessary before claiming compatibility with your GitHub App configuration.
