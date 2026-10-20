// Kubernetes quantities and quota arithmetic are private to this extension.
import { z } from "zod";

const compute = z.object({ cpu: z.string(), memory: z.string() }).strict();
export const resourcesSchema = z
  .object({ requests: compute, limits: compute })
  .strict()
  .superRefine((resources, context) => {
    for (const name of ["cpu", "memory"] as const) {
      const request = quantity(resources.requests[name]);
      const limit = quantity(resources.limits[name]);
      if (
        request === undefined ||
        limit === undefined ||
        request <= 0n ||
        limit <= 0n ||
        request > limit
      ) {
        context.addIssue({
          code: "custom",
          message: `resources.${name}: use positive Kubernetes quantities with requests <= limits`,
        });
      }
    }
  });
export type Resources = z.infer<typeof resourcesSchema>;

/** Fixed per-pod RuntimeClass overhead, charged by ResourceQuota on top of container resources. */
export interface Overhead {
  cpu?: string;
  memory?: string;
}

export function capacity(
  hard: Readonly<Record<string, string>>,
  resources: Resources,
  overhead: Overhead = {},
): number {
  // ResourceQuota charges every sandbox pod its container resources PLUS the
  // RuntimeClass overhead (e.g. the Kata VM). Without a RuntimeClass the overhead is 0.
  const overheadCpu = requiredQuantity(
    overhead.cpu ?? "0",
    "RuntimeClass overhead cpu",
  );
  const overheadMemory = requiredQuantity(
    overhead.memory ?? "0",
    "RuntimeClass overhead memory",
  );
  const requestsCpu =
    requiredQuantity(resources.requests.cpu, "requests.cpu") + overheadCpu;
  const requestsMemory =
    requiredQuantity(resources.requests.memory, "requests.memory") +
    overheadMemory;
  const limitsCpu =
    requiredQuantity(resources.limits.cpu, "limits.cpu") + overheadCpu;
  const limitsMemory =
    requiredQuantity(resources.limits.memory, "limits.memory") + overheadMemory;
  const charges: Record<string, bigint> = {
    pods: requiredQuantity("1", "pod count"),
    cpu: requestsCpu,
    memory: requestsMemory,
    "requests.cpu": requestsCpu,
    "requests.memory": requestsMemory,
    "limits.cpu": limitsCpu,
    "limits.memory": limitsMemory,
  };
  let slots: number | undefined;
  for (const [key, value] of Object.entries(hard)) {
    if (key.endsWith("ephemeral-storage")) {
      throw new Error(
        `Kubernetes quota bounds ${key}, but sandbox pods declare no ephemeral-storage`,
      );
    }
    const required = charges[key];
    if (required === undefined) {
      continue;
    }
    const allowed = quantity(value);
    if (allowed === undefined) {
      throw new Error(`Invalid Kubernetes quota quantity for ${key}`);
    }
    const fit = Number(allowed / required);
    slots = slots === undefined ? fit : Math.min(slots, fit);
  }
  if (slots === undefined) {
    throw new Error("Kubernetes quota must bound pods, CPU or memory");
  }
  if (slots < 1) {
    throw new Error(
      "Kubernetes quota fits no sandbox; raise the quota or lower resources",
    );
  }
  return slots;
}

function requiredQuantity(text: string, what: string): bigint {
  const value = quantity(text);
  if (value === undefined) {
    throw new Error(`Invalid Kubernetes quantity for ${what}`);
  }
  return value;
}

function quantity(text: string): bigint | undefined {
  const match = /^(\d+)(?:\.(\d+))?(m|Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/.exec(
    text,
  );
  if (!match) {
    return undefined;
  }
  const [, whole, fraction = "", suffix = ""] = match;
  let numerator = BigInt(whole + fraction) * 1000n;
  let denominator = 10n ** BigInt(fraction.length);
  const binary = ["Ki", "Mi", "Gi", "Ti", "Pi", "Ei"];
  const decimal = ["k", "M", "G", "T", "P", "E"];
  if (suffix === "m") {
    denominator *= 1000n;
  } else if (binary.includes(suffix)) {
    numerator *= 1024n ** BigInt(binary.indexOf(suffix) + 1);
  } else if (decimal.includes(suffix)) {
    numerator *= 1000n ** BigInt(decimal.indexOf(suffix) + 1);
  }
  return (numerator + denominator - 1n) / denominator;
}
