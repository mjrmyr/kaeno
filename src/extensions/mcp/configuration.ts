import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { AgentExtension } from "../contributions/index.ts";
import { endpointOf, serverIdSchema, toolPolicySchema } from "./contract.ts";
import { discoverRemote, type HostServer } from "./remote.ts";
import { mcpTools } from "./server.ts";

// Only owner-controlled authentication headers, never routing, cookies, MCP protocol or process env.
const headerNameSchema = z
  .string()
  .regex(/^(authorization|x-api-key|api-key|x-auth-token)$/i);
const configurationSchema = z
  .object({
    servers: z.record(
      serverIdSchema,
      z
        .object({
          url: z.string().transform(endpointOf),
          auth: z
            .object({
              headerFiles: z.record(headerNameSchema, z.string().min(1)),
            })
            .strict()
            .optional(),
          tools: z.array(toolPolicySchema),
        })
        .strict(),
    ),
  })
  .strict();
export type McpConfiguration = z.infer<typeof configurationSchema>;

export async function readConfiguration(
  path: string,
): Promise<McpConfiguration> {
  try {
    const configuration = configurationSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    );
    for (const server of Object.values(configuration.servers)) {
      if (
        new Set(server.tools.map((tool) => tool.upstream)).size !==
          server.tools.length ||
        new Set(
          Object.keys(server.auth?.headerFiles ?? {}).map((name) =>
            name.toLowerCase(),
          ),
        ).size !== Object.keys(server.auth?.headerFiles ?? {}).length
      ) {
        throw new Error("duplicate entry");
      }
    }
    return configuration;
  } catch {
    throw new Error(
      "Invalid MCP configuration: check unique servers/tools, HTTPS endpoint, policy and headerFiles (OAuth/work/commands are not supported in phase 1)",
    );
  }
}

export function hostServer(
  configFile: string,
  id: string,
  configuration: McpConfiguration["servers"][string],
): HostServer {
  return {
    id,
    endpoint: configuration.url,
    headerFiles: Object.fromEntries(
      Object.entries(configuration.auth?.headerFiles ?? {}).map(
        ([name, path]) => [name, resolve(dirname(configFile), path)],
      ),
    ),
  };
}

type Selector = AgentExtension | { readonly tools: readonly string[] };
export interface McpInstallation {
  extensions: AgentExtension[];
  policy: {
    assistant: { available: Selector[]; defaults: Selector[] };
    worker: { available: Selector[]; defaults: Selector[] };
  };
  /** Servers or tools that did not load; their tools stay registered as unavailable placeholders. */
  diagnostics: string[];
}

/**
 * Discovers every configured server at startup. An invalid config throws; an unreachable
 * server or unadvertised tool only produces a diagnostic and placeholder registrations.
 */
export async function loadMcpConfiguration(
  configFile: string,
  signal: AbortSignal = AbortSignal.timeout(30_000),
): Promise<McpInstallation> {
  const config = await readConfiguration(configFile);
  const servers = Object.entries(config.servers)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([id, configured]) => ({
      host: hostServer(configFile, id, configured),
      tools: configured.tools,
    }));
  const discovered = await Promise.allSettled(
    servers.map(({ host }) => discoverRemote(host, signal)),
  );
  const installation: McpInstallation = {
    extensions: [],
    policy: {
      assistant: { available: [], defaults: [] },
      worker: { available: [], defaults: [] },
    },
    diagnostics: [],
  };
  servers.forEach(({ host, tools }, index) => {
    const result = discovered[index];
    if (result.status === "rejected") {
      // discoverRemote only rejects with fixed, secret-free tool errors.
      installation.diagnostics.push(
        `${result.reason instanceof Error ? result.reason.message : `${host.id}: unavailable`}; its tools are unavailable`,
      );
    }
    const set = mcpTools({
      ...host,
      tools,
      advertised: result.status === "fulfilled" ? result.value : new Map(),
    });
    if (result.status === "fulfilled") {
      installation.diagnostics.push(
        ...set.unavailable.map(
          (name) => `${host.id}: ${name} is not advertised; it is unavailable`,
        ),
      );
    }
    installation.extensions.push(set.extension);
    installation.policy.assistant.available.push(set.readOnly);
    installation.policy.worker.available.push(set.extension);
    installation.policy.worker.defaults.push(set.live);
  });
  return installation;
}
