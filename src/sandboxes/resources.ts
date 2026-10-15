// Sandbox sizing and how many sandboxes fit the sandbox ResourceQuota. Pure: k8s.ts reads
// the quota, sandbox-slots.ts asks how many fit. The quota is the only concurrency setting.
import { z } from "zod";

export interface ComputeResources {
  readonly cpu: string;
  readonly memory: string;
}
/**
 * The size of every sandbox pod, in the same shape as a container's `resources:` block in
 * deployment.yaml. Applied to envd and the skills init container alike: a pod is charged
 * max(sum(app containers), max(init containers)), so the pod costs exactly this.
 */
export interface SandboxResources {
  readonly requests: ComputeResources;
  readonly limits: ComputeResources;
}
/** `ResourceQuota.spec.hard` as Kubernetes returns it. */
export type QuotaLimits = Readonly<Record<string, string>>;
export interface SandboxFit {
  /** Sandboxes that fit the empty quota; 0 means none ever can. */
  readonly slots: number;
  /** Operator-facing explanation, e.g. "4 (limits.cpu 8 / 2 per sandbox)". */
  readonly summary: string;
}

export const DEFAULT_SANDBOX_RESOURCES: SandboxResources = {
  requests: { cpu: "250m", memory: "256Mi" },
  limits: { cpu: "2", memory: "2Gi" },
};
export const SANDBOX_QUOTA = "kaeno-sandbox";

const compute = z.object({ cpu: z.string(), memory: z.string() }).strict();
const resourcesSchema = z
  .object({ requests: compute, limits: compute })
  .strict();

/** Config boundary for `sandboxResources`. Absent means the defaults; present must be complete. */
export function parseSandboxResources(raw: unknown): SandboxResources {
  if (raw === undefined) {
    return DEFAULT_SANDBOX_RESOURCES;
  }
  const parsed = resourcesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`sandboxResources: ${parsed.error.message}`);
  }
  const resources = parsed.data;
  for (const name of ["cpu", "memory"] as const) {
    const request = parseQuantity(resources.requests[name]);
    const limit = parseQuantity(resources.limits[name]);
    if (request === undefined || request <= 0n) {
      throw new Error(
        `sandboxResources.requests.${name}: "${resources.requests[name]}" is not a positive Kubernetes quantity`,
      );
    }
    if (limit === undefined || limit <= 0n) {
      throw new Error(
        `sandboxResources.limits.${name}: "${resources.limits[name]}" is not a positive Kubernetes quantity`,
      );
    }
    if (request > limit) {
      throw new Error(
        `sandboxResources: requests.${name} ${resources.requests[name]} exceeds limits.${name} ${resources.limits[name]}`,
      );
    }
  }
  return resources;
}

/** What one sandbox charges per quota key (aliases included), derived from its resources. */
function chargesOf(resources: SandboxResources): Record<string, string> {
  return {
    pods: "1",
    cpu: resources.requests.cpu,
    "requests.cpu": resources.requests.cpu,
    memory: resources.requests.memory,
    "requests.memory": resources.requests.memory,
    "limits.cpu": resources.limits.cpu,
    "limits.memory": resources.limits.memory,
  };
}

/** slots = min over the quota keys a sandbox is charged for of floor(hard / charge). */
export function fitSandboxes(
  hard: QuotaLimits,
  resources: SandboxResources,
): SandboxFit {
  const charges = chargesOf(resources);
  let fit: SandboxFit | undefined;
  for (const [key, value] of Object.entries(hard)) {
    if (key.endsWith("ephemeral-storage")) {
      throw new Error(
        `ResourceQuota ${SANDBOX_QUOTA} bounds ${key}, but sandboxes declare no ephemeral-storage; remove the key`,
      );
    }
    const charge = charges[key];
    if (charge === undefined) {
      continue;
    }
    const allowed = parseQuantity(value);
    if (allowed === undefined) {
      throw new Error(
        `ResourceQuota ${SANDBOX_QUOTA}: ${key} "${value}" is not a Kubernetes quantity`,
      );
    }
    const slots = Number(allowed / required(parseQuantity(charge)));
    if (fit === undefined || slots < fit.slots) {
      fit = {
        slots,
        summary: `${slots} (${key} ${value} / ${charge} per sandbox)`,
      };
    }
  }
  if (fit === undefined) {
    throw new Error(
      `ResourceQuota ${SANDBOX_QUOTA} bounds none of pods, cpu or memory; kaeno sizes its sandbox pool from it`,
    );
  }
  return fit;
}

function required(value: bigint | undefined): bigint {
  if (value === undefined) {
    throw new Error("Sandbox resources were not validated");
  }
  return value;
}

const BINARY = ["Ki", "Mi", "Gi", "Ti", "Pi", "Ei"];
const DECIMAL = ["k", "M", "G", "T", "P", "E"];

/**
 * Kubernetes quantity → exact integer milli-units (millicores, millibytes, millipods),
 * rounded up like Kubernetes. Units cancel in fitSandboxes, so one scale serves all.
 * Undefined for anything else (exponent notation is deliberately unsupported).
 */
function parseQuantity(text: string): bigint | undefined {
  const match = /^(\d+)(?:\.(\d+))?(m|Ki|Mi|Gi|Ti|Pi|Ei|k|M|G|T|P|E)?$/.exec(
    text,
  );
  if (!match) {
    return undefined;
  }
  const [, whole, fraction = "", suffix = ""] = match;
  let numerator = BigInt(whole + fraction) * 1000n;
  let denominator = 10n ** BigInt(fraction.length);
  if (suffix === "m") {
    denominator *= 1000n;
  } else if (BINARY.includes(suffix)) {
    numerator *= 1024n ** BigInt(BINARY.indexOf(suffix) + 1);
  } else if (DECIMAL.includes(suffix)) {
    numerator *= 1000n ** BigInt(DECIMAL.indexOf(suffix) + 1);
  }
  return (numerator + denominator - 1n) / denominator;
}
