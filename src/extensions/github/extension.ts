import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  defineTool,
  section,
  type ToolExecutionApi,
  type JsonObject,
} from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { Context } from "@earendil-works/chord";
import { z } from "zod";
import { readBinding, type Kaeno } from "../../core/application/index.ts";
import type {
  AgentExtension,
  InstalledExtension,
} from "../contributions/index.ts";
import { githubRepositoryReader } from "./definitions.ts";
import {
  GITHUB_EXTENSION,
  GITHUB_TOOLS,
  githubPrompt,
  githubBinding,
  readGitHubInstallation,
} from "./access.ts";
import { GitHubClient } from "./client.ts";
import { githubReadTools, GITHUB_READ_TOOLS } from "./read-tools.ts";
import { commitSchema, HostGit, type RepositoryTransport } from "./git.ts";
import {
  exportCheckout,
  installCheckout,
  importFetchedBranch,
  requireIntegratedHead,
  snapshotCheckout,
} from "./workspace.ts";

const branchSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (branch) =>
      !/[\s~^:?*[\\]/.test(branch) &&
      [...branch].every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ) &&
      !branch.includes("..") &&
      !branch.includes("@{") &&
      branch
        .split("/")
        .every(
          (part) =>
            part.length > 0 &&
            !part.startsWith(".") &&
            !part.endsWith(".") &&
            !part.endsWith(".lock"),
        ),
    "Invalid branch name",
  );
const intentSchema = z.object({
  sha: commitSchema,
  expected: commitSchema.nullable(),
  title: z.string(),
  body: z.string(),
});
const checkoutSchema = z.object({
  path: z.string(),
  base: branchSchema,
  branch: branchSchema,
  sha: commitSchema,
  ready: z.boolean(),
  published: commitSchema.nullable(),
  fetched: commitSchema.optional(),
  pending: intentSchema.optional(),
});
const commentIntentSchema = z.object({
  key: z.string().uuid(),
  body: z.string(),
});
const stateSchema = z.object({
  checkouts: z.record(z.string(), checkoutSchema),
  pendingComments: z.record(z.string(), commentIntentSchema).optional(),
});
const Workspace = defineDoc<JsonObject>({
  kind: "kaeno.github-workspace",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ checkouts: {} }),
});

export interface GitHubExtensionOptions {
  appId: string;
  privateKey: string;
  installationId: number;
  fetch?: typeof globalThis.fetch;
  /** Host-side repository transport; default is authenticated Git over HTTPS. */
  transport?: RepositoryTransport;
}

function text(value: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

/** Public definitions need no App, native runtime, or agent permissions. */
export function githubExtension(): InstalledExtension;
/** An App adds authenticated definitions and native tools with private assignment bindings. */
export function githubExtension(
  options: GitHubExtensionOptions,
): AgentExtension;
export function githubExtension(
  options?: GitHubExtensionOptions,
): InstalledExtension {
  const publicReader = { name: "github", ...githubRepositoryReader() };
  if (!options) {
    return { definitionReaders: [publicReader] };
  }
  const installationId = z
    .number()
    .int()
    .positive()
    .parse(options.installationId);
  const client = new GitHubClient(options);
  const transport = options.transport ?? new HostGit();
  let followThread: Kaeno["followThread"] | undefined;
  async function tokenFor(
    api: ToolExecutionApi,
    context: Context,
    repositoryId?: number,
  ): Promise<string> {
    const assigned = readGitHubInstallation(
      await readBinding(api, api.conversationId, GITHUB_EXTENSION, context),
    );
    if (assigned !== installationId) {
      throw new Error("GitHub: this installation is not assigned");
    }
    return client.token(installationId, repositoryId, context.abortSignal);
  }

  const list = defineTool({
    name: GITHUB_TOOLS[0],
    description:
      "Discover GitHub repositories currently accessible through your assigned GitHub App installation. Does not grant access.",
    parameters: Type.Object({}),
    replay: "safe",
    executionMode: "sequential",
    execute: async (_args, api, context) => {
      const token = await tokenFor(api, context);
      return text(await client.repositories(token, context.abortSignal));
    },
  });
  const checkout = defineTool({
    name: GITHUB_TOOLS[1],
    description:
      "Prepare one authorized repository branch in your sandbox. Returns its absolute path and base SHA. Repeated calls preserve local changes; only one checkout per repository per work is supported.",
    parameters: Type.Object({
      repository: Type.Integer({ minimum: 1 }),
      branch: Type.Optional(Type.String({ maxLength: 200 })),
    }),
    replay: "safe",
    executionMode: "sequential",
    execute: async (args, api, context) => {
      const env = api.env;
      if (!env) {
        throw new Error(
          "GitHub checkout requires a worker execution environment",
        );
      }
      const token = await tokenFor(api, context, args.repository);
      const repository = await client.repository(
        token,
        args.repository,
        context.abortSignal,
      );
      const state = stateSchema.parse(
        (await api.snapshot(Workspace, api.conversationId, context)) ?? {
          checkouts: {},
        },
      );
      let saved = state.checkouts[String(args.repository)];
      if (saved && args.branch !== undefined && saved.base !== args.branch) {
        throw new Error(
          "GitHub: this work already checked out a different branch; start new work",
        );
      }
      if (saved?.ready) {
        if (!getOrThrow(await env.exists(saved.path, context))) {
          throw new Error(
            "GitHub: saved workspace is missing; refusing to silently discard work. Start new work.",
          );
        }
        return text({
          repository: repository.full_name,
          path: saved.path,
          base: saved.base,
          sha: saved.sha,
        });
      }
      const base =
        saved?.base ??
        branchSchema.parse(args.branch ?? repository.default_branch);
      const remote = `https://github.com/${repository.full_name}.git`;
      const source = await transport.checkout(
        remote,
        saved?.sha ?? `refs/heads/${base}`,
        token,
        context.abortSignal,
      );
      const sha = commitSchema.parse(source.sha);
      if (saved && saved.sha !== sha) {
        throw new Error("GitHub: checkout base changed during recovery");
      }
      const root = getOrThrow(await env.absolutePath(".kaeno-github", context));
      const path = `${root}/${args.repository}`;
      if (!saved) {
        if (getOrThrow(await env.exists(path, context))) {
          throw new Error(
            "GitHub: checkout path already exists without saved ownership; refusing to overwrite it",
          );
        }
        saved = {
          path,
          base,
          branch: `kaeno/${randomUUID()}/${args.repository}`,
          sha,
          ready: false,
          published: null,
        };
        const candidate = saved;
        await api.commit(async (tx) => {
          const doc = await tx.doc(Workspace, api.conversationId);
          const current = stateSchema.parse(doc);
          current.checkouts[String(args.repository)] = candidate;
          doc.checkouts = current.checkouts;
        }, context);
      }
      await installCheckout(env, saved.path, source.bundle, context);
      const ready = { ...saved, ready: true };
      await api.commit(async (tx) => {
        const doc = await tx.doc(Workspace, api.conversationId);
        const current = stateSchema.parse(doc);
        current.checkouts[String(args.repository)] = ready;
        doc.checkouts = current.checkouts;
      }, context);
      return text({
        repository: repository.full_name,
        path: ready.path,
        base: ready.base,
        sha: ready.sha,
      });
    },
  });
  const fetchWork = defineTool({
    name: "github_fetch",
    description:
      "Fetch the existing published work branch into refs/remotes/kaeno/work without changing your files or HEAD. Merge or rebase it with your coding tools, resolve conflicts, and test before publishing. An explicit fetch supersedes a failed publish snapshot; your current files are preserved.",
    parameters: Type.Object({ repository: Type.Integer({ minimum: 1 }) }),
    replay: "safe",
    executionMode: "sequential",
    execute: async (args, api, context) => {
      const env = api.env;
      if (!env) {
        throw new Error(
          "GitHub fetching requires a worker execution environment",
        );
      }
      const token = await tokenFor(api, context, args.repository);
      const repository = await client.repository(
        token,
        args.repository,
        context.abortSignal,
      );
      const state = stateSchema.parse(
        (await api.snapshot(Workspace, api.conversationId, context)) ?? {
          checkouts: {},
        },
      );
      const saved = state.checkouts[String(args.repository)];
      if (!saved?.ready || (!saved.published && !saved.pending)) {
        throw new Error("GitHub: publish a work branch before fetching it");
      }
      const intent = await api.memo("github-fetch", context);
      const source = await transport.checkout(
        `https://github.com/${repository.full_name}.git`,
        intent ? commitSchema.parse(intent) : `refs/heads/${saved.branch}`,
        token,
        context.abortSignal,
      );
      const sha = commitSchema.parse(source.sha);
      if (intent && sha !== intent) {
        throw new Error("GitHub: fetched work branch changed during recovery");
      }
      await api.memo("github-fetch", sha, context);
      await importFetchedBranch(
        env,
        saved.path,
        source.bundle,
        sha,
        saved.fetched ?? saved.published ?? saved.sha,
        context,
      );
      await api.commit(async (tx) => {
        const doc = await tx.doc(Workspace, api.conversationId);
        const current = stateSchema.parse(doc);
        const { pending: _pending, ...checkout } = saved;
        current.checkouts[String(args.repository)] = {
          ...checkout,
          fetched: sha,
        };
        doc.checkouts = current.checkouts;
      }, context);
      return text({
        repository: repository.full_name,
        path: saved.path,
        branch: saved.branch,
        sha,
        ref: "refs/remotes/kaeno/work",
        note: "Files and HEAD are unchanged. Merge or rebase the fetched ref, resolve conflicts, and test before publishing. Any failed publish snapshot has been superseded.",
      });
    },
  });
  const comment = defineTool({
    name: "github_comment",
    description:
      "Post a reply or update on a GitHub pull request. Use this to respond on the PR after addressing review feedback. Does not submit a review or merge the PR.",
    parameters: Type.Object({
      repository: Type.Integer({ minimum: 1 }),
      pullRequest: Type.Integer({ minimum: 1 }),
      body: Type.String({ minLength: 1, maxLength: 60_000 }),
    }),
    replay: "safe",
    executionMode: "sequential",
    execute: async (args, api, context) => {
      const token = await tokenFor(api, context, args.repository);
      const repository = await client.repository(
        token,
        args.repository,
        context.abortSignal,
      );
      const target = `${args.repository}:${args.pullRequest}`;
      const state = stateSchema.parse(
        (await api.snapshot(Workspace, api.conversationId, context)) ?? {
          checkouts: {},
        },
      );
      const saved = await api.memo("github-comment", context);
      const intent = commentIntentSchema.parse(
        saved ??
          (await api.memo(
            "github-comment",
            state.pendingComments?.[target] ?? {
              key: randomUUID(),
              body: args.body,
            },
            context,
          )),
      );
      await api.commit(async (tx) => {
        const doc = await tx.doc(Workspace, api.conversationId);
        const current = stateSchema.parse(doc);
        doc.pendingComments = { ...current.pendingComments, [target]: intent };
      }, context);
      const result = await client.comment(
        token,
        repository,
        args.pullRequest,
        intent.body,
        `<!-- kaeno-comment:${intent.key} -->`,
        context.abortSignal,
      );
      await api.commit(async (tx) => {
        const doc = await tx.doc(Workspace, api.conversationId);
        const current = stateSchema.parse(doc);
        const pending = current.pendingComments ?? {};
        delete pending[target];
        doc.pendingComments = pending;
      }, context);
      return text(result);
    },
  });

  const publish = defineTool({
    name: GITHUB_TOOLS[2],
    description:
      "Snapshot local tracked and non-ignored files from a GitHub checkout, publish a work branch, and create or reuse its ready-for-review PR. Automatically follow its thread when publishing from a ticket. Does not merge, force-push, or run tests. Run checks before publishing. Use a Conventional Commit title; it is also the snapshot commit message.",
    parameters: Type.Object({
      repository: Type.Integer({ minimum: 1 }),
      title: Type.String({
        minLength: 1,
        maxLength: 200,
        description:
          "PR title and snapshot commit message. Use Conventional Commits: <type>[optional scope]: <description>, for example feat: add search, fix(github): handle retries, or chore: update docs.",
      }),
      body: Type.String({ maxLength: 60_000 }),
    }),
    replay: "safe",
    executionMode: "sequential",
    execute: async (args, api, context) => {
      const subscribe = followThread;
      if (!subscribe) {
        throw new Error("GitHub: integration has not started");
      }
      const env = api.env;
      if (!env) {
        throw new Error(
          "GitHub publishing requires a worker execution environment",
        );
      }
      const token = await tokenFor(api, context, args.repository);
      const repository = await client.repository(
        token,
        args.repository,
        context.abortSignal,
      );
      const state = stateSchema.parse(
        (await api.snapshot(Workspace, api.conversationId, context)) ?? {
          checkouts: {},
        },
      );
      const saved = state.checkouts[String(args.repository)];
      if (!saved?.ready) {
        throw new Error("GitHub: check out this repository before publishing");
      }
      let intent = await api.memo("github-publish", context);
      if (!intent) {
        let candidate = saved.pending;
        if (!candidate) {
          const sha = await snapshotCheckout(
            env,
            saved.path,
            saved.fetched ?? saved.published ?? saved.sha,
            args.title,
            new Date().toISOString(),
            context,
          );
          if (saved.fetched) {
            await requireIntegratedHead(
              env,
              saved.path,
              saved.fetched,
              context,
            );
          }
          if (sha === saved.sha && saved.published === null) {
            throw new Error("GitHub: no changes to publish");
          }
          candidate = {
            sha,
            expected: saved.fetched ?? saved.published,
            title: args.title,
            body: args.body,
          };
        }
        intent = await api.memo("github-publish", candidate, context);
      }
      const operation = intentSchema.parse(intent);
      await api.commit(async (tx) => {
        const doc = await tx.doc(Workspace, api.conversationId);
        const current = stateSchema.parse(doc);
        current.checkouts[String(args.repository)] = {
          ...saved,
          pending: operation,
        };
        doc.checkouts = current.checkouts;
      }, context);
      const branch = saved.branch;
      const bundle = await exportCheckout(
        env,
        saved.path,
        operation.sha,
        context,
      );
      // Do not update a branch whose PR an owner has closed.
      await client.findWorkPull(
        token,
        repository,
        branch,
        saved.base,
        context.abortSignal,
      );
      await transport.publish(
        `https://github.com/${repository.full_name}.git`,
        branch,
        bundle,
        operation.sha,
        operation.expected,
        token,
        context.abortSignal,
      );
      const pull = await client.workPull(
        token,
        repository,
        branch,
        saved.base,
        operation.title,
        operation.body,
        context.abortSignal,
      );
      const thread = `github:${repository.full_name}#${pull.number}`;
      const following = await api.commit(async (tx) => {
        const doc = await tx.doc(Workspace, api.conversationId);
        const current = stateSchema.parse(doc);
        const { pending: _pending, fetched: _fetched, ...completed } = saved;
        current.checkouts[String(args.repository)] = {
          ...completed,
          published: operation.sha,
        };
        doc.checkouts = current.checkouts;
        return subscribe(tx, api.conversationId, thread);
      }, context);
      return text({
        repository: repository.full_name,
        branch,
        sha: operation.sha,
        pullRequest: pull.html_url,
        number: pull.number,
        thread,
        following,
        draft: false,
        note: "Published the saved snapshot, ready for review. Edits made after a failed publish require another publish call. Ticket workers automatically follow this PR; use github_comment to reply on GitHub.",
      });
    },
  });
  return {
    definitionReaders: [
      publicReader,
      {
        name: `github-app-${installationId}`,
        ...githubRepositoryReader({
          app: {
            appId: options.appId,
            privateKey: options.privateKey,
            installationId,
          },
          host: { fetch: options.fetch },
        }),
      },
    ],
    runtime: {
      durable: defineExtension({
        name: GITHUB_EXTENSION,
        tools: [
          list,
          checkout,
          publish,
          fetchWork,
          comment,
          ...githubReadTools(client, tokenFor),
        ],
        sections: [
          section(
            "github",
            async ({ conversationId, read, agent }, context) => {
              const tools = agent.tools.map((tool) => tool.name);
              const assigned = readGitHubInstallation(
                await readBinding(
                  read,
                  conversationId,
                  GITHUB_EXTENSION,
                  context,
                ),
              );
              return githubPrompt(tools, assigned === installationId);
            },
          ),
        ],
      }),
      start: async (core) => {
        followThread = core.followThread;
        return async () => {
          followThread = undefined;
        };
      },
      readOnlyTools: [GITHUB_TOOLS[0], ...GITHUB_READ_TOOLS],
      validateBinding: (binding) => {
        if (readGitHubInstallation(binding) !== installationId) {
          throw new Error(
            "GitHub: saved installation does not match the configured installation",
          );
        }
      },
    },
    bind: () => {
      const { version, value } = githubBinding(installationId);
      return { version, value };
    },
  };
}
