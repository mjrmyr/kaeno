# GitHub App extension

The optional `src/extensions/github` extension lets a worker discover private repositories, check out code in its existing execution environment, inspect pull request/CI diagnostics, and propose changes through a draft pull request. GitHub is not a core service or an agent-definition field. Other platforms can supply independent native extensions using the same composition seam.

## Owner setup

1. Create a GitHub App with these repository permissions:
   - **Contents: read and write**
   - **Pull requests: read and write**
   - **Checks: read-only**
   - **Actions: read-only**
   - **Commit statuses: read-only**
   - **Metadata: read-only** (automatic)

   The diagnostic tools require **Pull requests: read**, **Checks: read**, **Actions: read**, **Commit statuses: read**, and **Metadata: read**; existing checkout uses Contents access. Retain Contents/Pull requests write only for the existing publishing workflow. No Workflows write permission is needed for these reads. After changing App permissions, approve the installation's updated permission request on GitHub. No additional Kaeno config keys or credentials are needed.

2. Disable webhooks. This version needs no public callback endpoint, OAuth flow, client secret, or webhook secret.
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
checks. Publish a draft PR and report its URL and the verification evidence.
```

Add `skills: [your-engineering-skill]` if you have installed an engineering workflow skill. Skills provide instructions, not permissions. Explicit tool lists remain exact; include WORK tools such as `start_work` and `message_parent` if this worker needs them.

7. Start Kaeno with:

```sh
export KAENO_GITHUB_CONFIG="$HOME/.kaeno/github.json"
npm start
```

Git must be installed on both the host and worker image. The provided Dockerfile includes it. Rebuild the image before using checkout/publish with an older image.

The owner configuration is loaded at startup, not watched. Enabling it provides the installation and default GitHub tools to every agent in newly admitted work; already-admitted work retains its frozen bindings and tools. Start new work to pick up newly enabled capabilities. Revoke installation access, repository access, or permissions on GitHub to deny subsequent operations for saved work too. Changing the configured installation does not silently redirect saved work to another installation: mismatched saved bindings fail recovery closed.

Leaving `KAENO_GITHUB_CONFIG` unset installs no GitHub tools and needs no GitHub secrets. Removing the entire extension while saved conversations depend on it fails recovery closed. Old version-1 GitHub bindings are intentionally unsupported rather than automatically broadening their previously restricted access. Back up and explicitly migrate existing bound data, or use a fresh development database, before adopting this binding change.

The assistant receives the capability too. Set an explicit `tools` list containing only `github_list_repositories` (plus any other desired assistant tools) if it should only discover projects before delegating. Otherwise it can delegate by project name and let the worker discover the repository. Mention authorized-repository work in the worker's description so Kaeno can choose it.

## Tools and discovery

- `github_list_repositories {}` returns IDs, current names, and default branches for repositories currently accessible to the installation.
- `github_checkout { repository, branch? }` prepares one branch per repository in the existing worker environment. It returns the absolute checkout path and initial commit SHA. Repeated calls do not reset files. A different branch needs new work.
- `github_publish { repository, title, body }` snapshots tracked and non-ignored local files, preserving binary files, deletions, executable bits, and symlinks. It publishes a work-specific branch and creates or reuses its draft PR. It does not run tests.

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

The small generic addition is a host-wide `bindings` list in environment composition; every selected agent carries those bindings. File composition also accepts explicitly installed extensions and additional approved worker tool names. Host-supplied `tools` are included in assistant and worker defaults; explicit tool lists remain authoritative. Core still owns only opaque bindings and native extension selection; it parses no GitHub configuration.

A binding records only the installation ID. GitHub enforces repository access and permissions on every operation. A binding never selects tools. Every child worker receives the same configured installation in its own frozen setup. Private keys, App JWTs, and installation tokens are never written to bindings, prompts, results, Git remote URLs, or worker files.

Authentication lives on the host. The extension mints short-lived tokens inheriting the installation's permissions. Discovery uses installation-wide repository access; checkout, publishing, and each diagnostic read request a fresh token restricted to the single target repository. GitHub rejects requests for repositories outside the installation. Repository targeting is an operation detail, not a local allowlist. Host Git receives its token through an ephemeral process environment. Bare host repositories are temporary, do not check out repository code, ignore system/global Git configuration, and disable hooks, credential helpers, and HTTP redirects. Tool errors exclude raw child-process errors and GitHub error bodies. Workers receive Git bundles with objects and refs, never tokens or authenticated remote configuration.

We chose this over authenticated Git inside the worker: arbitrary project scripts should not receive a token they can read or exfiltrate. We also avoided a platform-wide capability registry: tool definitions, bindings, and native prompt sections already supply the required mechanisms. **Boundary discipline** keeps authentication inside the extension; **subtract before you add** and the **laziness protocol** remove duplicated authorization rules and leave repository access and permissions to GitHub.

## Retries and limitations

Checkout saves its base SHA before materializing files. It stages a clone separately and renames it into place. Recovery adopts an already-renamed checkout without discarding edits. A missing previously-ready workspace is an error, not permission to silently recreate it and lose changes.

Publish saves an immutable intent before network writes. It uses a stable conversation/repository branch, checks the expected remote head, performs ordinary non-force Git pushes, and reconciles an existing PR before creating another. A lost response after pushing or creating a PR can be retried, including after restart. A retry completes the saved snapshot: edits made since that attempt need another publish call. The work branch must remain on the last extension-published commit. Unexpected updates or deletion are rejected. Closed or non-draft work PRs are rejected before updating their branch; start new work for another proposal.

These are external side effects, not SQLite transactions. GitHub access or PR changes can race an already-authorized in-flight request. There is no claim of exactly-once execution across external systems. **Idempotent operations** provide stable intent and reconciliation instead.

V1 deliberately excludes:

- Merge, force-push, administration, webhooks, and generic arbitrary GitHub API calls.
- Pulling new upstream commits into an existing checkout; use new work for a fresh base.
- Recursive submodule checkout and Git LFS object materialization.
- Changes to workflow files unless GitHub separately grants the App the required Workflows permission. The recommended setup does not grant it.
- Large repositories: full-history bundles are limited to 100 MiB. The limit is checked after host fetching/bundling, so this is not a host disk quota.
- Durable workspace restoration after sandbox loss. Existing sandbox lifecycle/reconciliation remains authoritative.
- Windows host support for this adapter (Git configuration uses `/dev/null`).

The extension requires supported, patched host/worker Git versions. Git bundles are untrusted input; credentials never enter the worker, but host Git still parses objects supplied by it. Repository isolation does not make repository code or native extensions trusted.

## Embedding

```ts
import { loadGitHubConfiguration } from "../src/extensions/github/index.ts";
import { loadEnvironment } from "../src/host/composition/index.ts";

const github = await loadGitHubConfiguration("./.kaeno/github.json");
const configuration = await loadEnvironment({
  configFile: "./.kaeno/config.json",
  ...github,
});
```

Pass the returned configuration to `openKaeno` with storage/models and the chosen WORK environment, as usual. When the App configuration is enabled, the same host-only reader can fetch private agent/skill repositories as well as the existing GitHub tools; repository installation permissions remain the authorization boundary. Public repositories use the isolated anonymous reader without an App key.

## Verification

`npm run verify` covers native read-tool schemas and execution, PR head metadata, pagination/filtering, scoped-token authorization, missing/mismatched assignments, API permission/not-found failures, bounded log streaming, unsafe redirects and credential-free downloads, as well as installation-wide discovery, contextual instructions, default capability availability in Kaeno, root workers, and nested workers, workflow skill loading, binary-safe local Git transfer, interrupted checkout adoption, immutable pending publish recovery across SQLite restart, PR response-loss reconciliation, dirty-workspace preservation, draft-only publishing, GitHub authorization failures, and unexpected remote-head rejection.

These tests use a mocked GitHub HTTP API and real temporary Git repositories/execution environments. A live installation test remains necessary before claiming compatibility with your GitHub App configuration.
