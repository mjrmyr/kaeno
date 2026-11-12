import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineDocFamily,
  defineExtension,
  defineTool,
  section,
  type ToolExecutionApi,
  type JsonObject,
  type Cursor,
} from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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

// Shared publication identity belongs to the ticket, never to a worker filesystem.
const publicationSchema = z.object({
  repository: z.number().int().positive(),
  branch: branchSchema,
  base: branchSchema,
  head: commitSchema.nullable(),
  pullRequest: z.number().int().positive().optional(),
});
const publicationsSchema = z.object({
  publications: z.record(z.string(), publicationSchema),
});
const Publications = defineDocFamily<JsonObject, null>({
  kind: "kaeno.github-publications",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ publications: {} }),
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
  let ticketOf: Kaeno["ticketOf"] | undefined;
  async function owner(api: ToolExecutionApi, context: Context) {
    return api.commit(
      async (tx) => ticketOf?.(tx, api.conversationId),
      context,
    );
  }
  async function publications(
    api: ToolExecutionApi,
    ticket: string,
    context: Context,
  ) {
    return publicationsSchema.parse(
      (await api.snapshot(Publications, ticket, context)) ?? {
        publications: {},
      },
    ).publications;
  }
  // Import legacy local records without copying their filesystem or accepted head to another worker.
  async function register(
    api: ToolExecutionApi,
    ticket: string | undefined,
    repository: number,
    saved: z.infer<typeof checkoutSchema>,
    context: Context,
  ) {
    if (!ticket) {
      return;
    }
    await api.commit(async (tx) => {
      const doc = await tx.doc(Publications, ticket, null);
      const current = publicationsSchema.parse(doc);
      current.publications[saved.branch] ??= {
        repository,
        branch: saved.branch,
        base: saved.base,
        head: saved.published,
      };
      doc.publications = current.publications;
    }, context);
  }
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
      "Prepare one authorized repository branch in your sandbox. Ticket workers continue its single open publication; select pullRequest if ambiguous or newPublication for a separate PR. Returns its path, branch and base SHA. Repeated calls preserve local changes; only one checkout per repository per work is supported.",
    parameters: Type.Object({
      repository: Type.Integer({ minimum: 1 }),
      branch: Type.Optional(Type.String({ maxLength: 200 })),
      pullRequest: Type.Optional(Type.Integer({ minimum: 1 })),
      newPublication: Type.Optional(Type.Boolean()),
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
      const ticket = await owner(api, context);
      if (args.newPublication && args.pullRequest) {
        throw new Error("GitHub: select a PR or a new publication, not both");
      }
      let selected: z.infer<typeof publicationSchema> | undefined;
      if (!saved && ticket && !args.newPublication) {
        const candidates = Object.values(
          await publications(api, ticket, context),
        ).filter((value) => value.repository === args.repository);
        const active = [];
        for (const candidate of candidates) {
          const pull = await client.lookupWorkPull(
            token,
            repository,
            candidate.branch,
            context.abortSignal,
          );
          if (pull?.state === "open" || (!pull && candidate.head === null)) {
            active.push({ candidate, pull });
          }
        }
        const matching = args.pullRequest
          ? active.filter((value) => value.pull?.number === args.pullRequest)
          : active;
        if (matching.length > 1) {
          throw new Error(
            "GitHub: multiple ticket publications; select pullRequest or newPublication",
          );
        }
        selected = matching[0]?.candidate;
        if (args.pullRequest && !selected) {
          throw new Error(
            "GitHub: PR is not an open publication of this ticket",
          );
        }
      } else if (!saved && args.pullRequest) {
        throw new Error(
          "GitHub: selecting a publication requires an owning ticket",
        );
      }
      if (saved && (args.newPublication || args.pullRequest)) {
        if (args.newPublication) {
          throw new Error(
            "GitHub: this work already has a checkout; start new work for a new publication",
          );
        }
        const pull = await client.lookupWorkPull(
          token,
          repository,
          saved.branch,
          context.abortSignal,
        );
        if (pull?.number !== args.pullRequest) {
          throw new Error(
            "GitHub: checkout belongs to a different publication; start new work",
          );
        }
      }
      if (saved) {
        await register(api, ticket, args.repository, saved, context);
      }
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
          branch: saved.branch,
          sha: saved.sha,
        });
      }
      const base =
        saved?.base ??
        selected?.base ??
        branchSchema.parse(args.branch ?? repository.default_branch);
      if (selected && args.branch && args.branch !== selected.base) {
        throw new Error("GitHub: selected publication has a different base");
      }
      const remote = `https://github.com/${repository.full_name}.git`;
      const source = await transport.checkout(
        remote,
        saved?.sha ?? selected?.head ?? `refs/heads/${base}`,
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
          branch:
            selected?.branch ?? `kaeno/${randomUUID()}/${args.repository}`,
          sha,
          ready: false,
          published: selected?.head ?? null,
        };
        const candidate = saved;
        await api.commit(async (tx) => {
          const doc = await tx.doc(Workspace, api.conversationId);
          const current = stateSchema.parse(doc);
          current.checkouts[String(args.repository)] = candidate;
          doc.checkouts = current.checkouts;
        }, context);
      }
      await register(api, ticket, args.repository, saved, context);
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
        branch: ready.branch,
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
      const ticket = await owner(api, context);
      const known = ticket
        ? (await publications(api, ticket, context))[saved?.branch ?? ""]
        : undefined;
      if (!saved?.ready || (!saved.published && !saved.pending && !known)) {
        throw new Error("GitHub: publish a work branch before fetching it");
      }
      await register(api, ticket, args.repository, saved, context);
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
      "Snapshot local tracked and non-ignored files from a GitHub checkout, publish a work branch, and create or reuse its ready-for-review PR. Automatically follow its thread when publishing from a ticket. Does not merge, force-push, or run tests. Run checks before publishing.",
    parameters: Type.Object({
      repository: Type.Integer({ minimum: 1 }),
      title: Type.String({ minLength: 1, maxLength: 200 }),
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
      const ticket = await owner(api, context);
      await register(api, ticket, args.repository, saved, context);
      const shared = ticket
        ? (await publications(api, ticket, context))[saved.branch]
        : undefined;
      const accepted = saved.fetched ?? saved.published;
      if (
        shared &&
        shared.head !== accepted &&
        shared.head !== saved.pending?.sha
      ) {
        if (saved.fetched && shared.head) {
          await requireIntegratedHead(
            env,
            saved.path,
            shared.head,
            context,
            saved.fetched,
          );
        } else {
          throw new Error(
            "GitHub: ticket publication advanced in another worker; github_fetch and integrate before publishing",
          );
        }
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
        if (ticket) {
          const sharedDoc = await tx.doc(Publications, ticket, null);
          const sharedState = publicationsSchema.parse(sharedDoc);
          const existing = sharedState.publications[branch];
          if (
            existing &&
            existing.head !== operation.expected &&
            existing.head !== shared?.head &&
            existing.head !== operation.sha
          ) {
            throw new Error(
              "GitHub: publication advanced during publish; fetch before retrying",
            );
          }
          sharedState.publications[branch] = {
            repository: args.repository,
            branch,
            base: saved.base,
            head: operation.sha,
            pullRequest: pull.number,
          };
          sharedDoc.publications = sharedState.publications;
        }
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
        ticketOf = core.ticketOf;
        // One internal, idempotent conversion of saved records at startup. This
        // discovers legacy PRs even when their publisher environment is gone.
        let cursor: Cursor | undefined;
        do {
          const page = await core.harness.commit(
            (tx) => tx.scanConversations({}, 100, cursor),
            BACKGROUND_CONTEXT,
          );
          for (const conversation of page.items) {
            const legacy = await core.harness.snapshot(
              Workspace,
              conversation.id,
              BACKGROUND_CONTEXT,
            );
            if (!legacy) {
              continue;
            }
            const local = stateSchema.parse(legacy);
            await core.harness.commit(async (tx) => {
              const ticket = await core.ticketOf(tx, conversation.id);
              if (!ticket) {
                return;
              }
              const doc = await tx.doc(Publications, ticket, null);
              const current = publicationsSchema.parse(doc);
              for (const [repository, saved] of Object.entries(
                local.checkouts,
              )) {
                if (!saved.published && !saved.pending) {
                  continue;
                }
                current.publications[saved.branch] ??= {
                  repository: Number(repository),
                  branch: saved.branch,
                  base: saved.base,
                  head: saved.published,
                };
              }
              doc.publications = current.publications;
            }, BACKGROUND_CONTEXT);
          }
          cursor = page.next;
        } while (cursor);
        return async () => {
          followThread = undefined;
          ticketOf = undefined;
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
