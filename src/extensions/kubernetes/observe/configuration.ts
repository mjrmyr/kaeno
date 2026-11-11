import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { KaenoExtension } from "../../../core/application/index.ts";
import { ObserverClient } from "./client.ts";
import { clusterObserverExtension } from "./extension.ts";

const serviceAccountRoot = "/var/run/secrets/kubernetes.io/serviceaccount";
const namespace = z
  .string()
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
const configSchema = z
  .object({
    api: z
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          url.pathname === "/" &&
          !url.search &&
          !url.hash
        );
      }, "Use a Kubernetes API origin")
      .default("https://kubernetes.default.svc"),
    tokenFile: z.string().min(1).default(`${serviceAccountRoot}/token`),
    caFile: z
      .string()
      .min(1)
      .nullable()
      .default(`${serviceAccountRoot}/ca.crt`),
    exclude: z.array(namespace).default([]),
    logs: z
      .object({
        namespaces: z.array(namespace).default([]),
        maxLines: z.number().int().min(1).max(2000).default(200),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export async function loadClusterObserverConfiguration(
  path: string,
  fetch?: typeof globalThis.fetch,
): Promise<KaenoExtension> {
  const absolute = resolve(path);
  const { api, tokenFile, caFile, ...policy } = configSchema.parse(
    JSON.parse(await readFile(absolute, "utf8")),
  );
  const tokenPath = resolve(dirname(absolute), tokenFile);
  const ca =
    caFile === null
      ? undefined
      : await readFile(resolve(dirname(absolute), caFile), "utf8");
  return clusterObserverExtension(
    new ObserverClient({
      api: api.replace(/\/$/, ""),
      readToken: () => readFile(tokenPath, "utf8"),
      ca,
      fetch,
    }),
    policy,
  );
}
