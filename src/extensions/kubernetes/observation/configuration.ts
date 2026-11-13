import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { KaenoExtension } from "../../../core/application/index.ts";
import { scopeSchema } from "./contract.ts";
import { originSchema, type TransportOptions } from "./transport.ts";
import { remoteObservationClient } from "./client.ts";
import { kubernetesObservationExtension } from "./extension.ts";

export const observerConfigurationSchema = scopeSchema
  .extend({
    api: originSchema.default("https://kubernetes.default.svc"),
    tokenFile: z
      .string()
      .min(1)
      .default("/var/run/secrets/kubernetes.io/serviceaccount/token"),
    caFile: z
      .string()
      .min(1)
      .nullable()
      .default("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"),
    clientTokenFile: z.string().min(1),
    pollIntervalMs: z.number().int().min(10_000).max(3_600_000).default(60_000),
    port: z.number().int().min(1).max(65535).default(8080),
  })
  .strict();
const clientConfigurationSchema = scopeSchema
  .extend({
    endpoint: originSchema,
    tokenFile: z.string().min(1),
    caFile: z.string().min(1).nullable().default(null),
  })
  .strict();
export async function credentials(
  directory: string,
  origin: string,
  tokenFile: string,
  caFile: string | null,
): Promise<TransportOptions> {
  const tokenPath = resolve(directory, tokenFile);
  // Validate at startup; never include raw parser/IO errors or credentials in diagnostics.
  async function readToken() {
    const token = (await readFile(tokenPath, "utf8")).trim();
    if (token.length < 1 || /[\r\n]/.test(token)) {
      throw new Error("Invalid observation credential");
    }
    return token;
  }
  await readToken();
  return {
    origin,
    readToken,
    ca:
      caFile === null
        ? undefined
        : await readFile(resolve(directory, caFile), "utf8"),
  };
}
export async function loadKubernetesObservationConfiguration(
  path: string,
): Promise<KaenoExtension> {
  try {
    const absolute = resolve(path);
    const config = clientConfigurationSchema.parse(
      JSON.parse(await readFile(absolute, "utf8")),
    );
    const transport = await credentials(
      dirname(absolute),
      config.endpoint,
      config.tokenFile,
      config.caFile,
    );
    if ((await transport.readToken()).length < 32) {
      throw new Error("Invalid credential");
    }
    return kubernetesObservationExtension(
      remoteObservationClient(
        {
          namespaces: config.namespaces,
          includeNodes: config.includeNodes,
          staleAfterMs: config.staleAfterMs,
        },
        transport,
      ),
    );
  } catch {
    throw new Error("Invalid Kubernetes observation configuration");
  }
}
