import { z } from "zod";

export const identifier = z
  .string()
  .max(253)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/,
  );
export const namespaceName = identifier
  .max(63)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
export const kinds = [
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "Pod",
  "Job",
  "CronJob",
  "PersistentVolumeClaim",
  "Node",
] as const;
export const kindSchema = z.enum(kinds);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
const condition = z.enum(["True", "False", "Unknown"]);
const reason = z.enum([
  "Unknown",
  "Other",
  "ContainerCreating",
  "PodInitializing",
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "CreateContainerConfigError",
  "CreateContainerError",
  "InvalidImageName",
  "RunContainerError",
  "Completed",
  "Error",
  "OOMKilled",
  "ContainerCannotRun",
  "DeadlineExceeded",
  "Evicted",
  "Shutdown",
  "NodeLost",
]);
const timestamp = z.iso.datetime().max(35);
function validSchedule(value: string): boolean {
  if (/^@(yearly|annually|monthly|weekly|daily|midnight|hourly)$/.test(value)) {
    return true;
  }
  const fields = value.split(/[ \t]+/);
  const bounds = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ] as const;
  return (
    fields.length === 5 &&
    fields.every((field, index) => {
      const bound = bounds[index];
      if (!bound) {
        return false;
      }
      const [minimum, maximum] = bound;
      return field.split(",").every((part) => {
        const match = /^(\*|[0-9]+(?:-[0-9]+)?)(?:\/([0-9]+))?$/.exec(part);
        if (!match) {
          return false;
        }
        const step = match[2];
        if (
          step !== undefined &&
          (Number(step) < 1 || Number(step) > maximum + 1)
        ) {
          return false;
        }
        const range = match[1];
        if (range === "*") {
          return true;
        }
        const [start, end = start] = (range ?? "").split("-").map(Number);
        return (
          start !== undefined &&
          end !== undefined &&
          start >= minimum &&
          end <= maximum &&
          end >= start
        );
      });
    })
  );
}
export const factSchema = z
  .object({
    namespace: namespaceName.nullable(),
    kind: kindSchema,
    name: identifier,
    generation: count,
    observedGeneration: count,
    desired: count,
    ready: count,
    available: count,
    updated: count,
    active: count,
    succeeded: count,
    failed: count,
    phase: z.enum([
      "Unknown",
      "Pending",
      "Running",
      "Succeeded",
      "Failed",
      "Bound",
      "Lost",
    ]),
    conditions: z
      .array(
        z
          .object({
            type: z.enum([
              "Ready",
              "MemoryPressure",
              "DiskPressure",
              "PIDPressure",
            ]),
            status: condition,
          })
          .strict(),
      )
      .max(4),
    containers: z
      .array(
        z
          .object({
            name: identifier,
            role: z.enum(["app", "init"]),
            ready: z.boolean().nullable(),
            restarts: count,
            state: z.enum(["Unknown", "Running", "Waiting", "Terminated"]),
            reason,
            exitCode: z
              .number()
              .int()
              .min(-2147483648)
              .max(2147483647)
              .nullable(),
          })
          .strict(),
      )
      .max(64),
    containersIncomplete: z.boolean(),
    schedule: z.string().max(128).refine(validSchedule).nullable(),
    suspended: z.boolean().nullable(),
    lastSuccessfulTime: timestamp.nullable(),
    requestedCapacity: z
      .string()
      .max(32)
      .regex(/^(?:[0-9]+(?:\.[0-9]+)?)(?:[EPTGMK]i|[EPTGMk]|m)?$/)
      .nullable(),
  })
  .strict();
export type ObservationFact = z.infer<typeof factSchema>;
export const coverageSchema = z
  .object({
    namespace: namespaceName.nullable(),
    kind: kindSchema,
    state: z.enum([
      "Complete",
      "Truncated",
      "Forbidden",
      "Unavailable",
      "Invalid",
    ]),
    lastSuccessAt: timestamp.nullable(),
    facts: z.array(factSchema).max(200),
  })
  .strict();
export const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    observedAt: timestamp,
    coverage: z.array(coverageSchema).max(161),
  })
  .strict();
export type Snapshot = z.infer<typeof snapshotSchema>;
export const scopeSchema = z
  .object({
    namespaces: z
      .array(namespaceName)
      .min(1)
      .max(20)
      .refine((values) => new Set(values).size === values.length),
    includeNodes: z.boolean().default(false),
    staleAfterMs: z.number().int().min(1000).max(86_400_000).default(180_000),
  })
  .strict();
export type Scope = z.infer<typeof scopeSchema>;

/** A fact is evidence, not an inferred application-health verdict. Missing fields stay unknown. */
export function projectFact(
  kind: (typeof kinds)[number],
  namespace: string | null,
  input: unknown,
): ObservationFact {
  const raw = object(input);
  const metadata = object(raw.metadata);
  const spec = object(raw.spec);
  const status = object(raw.status);
  function number(value: unknown): number | null {
    const result = count.safeParse(value);
    return result.success ? result.data : null;
  }
  function pick<T extends z.ZodType>(
    schema: T,
    value: unknown,
    fallback: z.infer<T>,
  ): z.infer<T> {
    const result = schema.safeParse(value);
    return result.success ? result.data : fallback;
  }
  // Explicit construction only. Never copy specs, messages, labels, or upstream reasons.
  const fact: ObservationFact = {
    namespace,
    kind,
    name: identifier.parse(metadata.name),
    generation: number(metadata.generation),
    observedGeneration: number(status.observedGeneration),
    desired: null,
    ready: null,
    available: null,
    updated: null,
    active: null,
    succeeded: null,
    failed: null,
    phase: pick(factSchema.shape.phase, status.phase, "Unknown"),
    conditions: [],
    containers: [],
    containersIncomplete: false,
    schedule: null,
    suspended: null,
    lastSuccessfulTime: null,
    requestedCapacity: null,
  };
  if (namespace !== null && metadata.namespace !== namespace) {
    throw new Error("Invalid resource scope");
  }
  if (kind === "Deployment" || kind === "StatefulSet") {
    // The API's default replicas is one, but absence in an untrusted response isn't evidence.
    fact.desired = number(spec.replicas);
    fact.ready = number(status.readyReplicas);
    fact.available = number(status.availableReplicas);
    fact.updated = number(status.updatedReplicas);
  }
  if (kind === "DaemonSet") {
    fact.desired = number(status.desiredNumberScheduled);
    fact.ready = number(status.numberReady);
    fact.available = number(status.numberAvailable);
    fact.updated = number(status.updatedNumberScheduled);
  }
  if (kind === "Pod" || kind === "Node") {
    const conditions = array(status.conditions);
    for (const type of kind === "Pod"
      ? (["Ready"] as const)
      : (["Ready", "MemoryPressure", "DiskPressure", "PIDPressure"] as const)) {
      const entry = conditions.map(object).find((entry) => entry.type === type);
      fact.conditions.push({
        type,
        status: pick(condition, entry?.status, "Unknown"),
      });
    }
  }
  if (kind === "Pod") {
    const entries = [
      ...array(status.containerStatuses).map((value) => ({
        value,
        role: "app" as const,
      })),
      ...array(status.initContainerStatuses).map((value) => ({
        value,
        role: "init" as const,
      })),
    ];
    const declared = [...array(spec.containers), ...array(spec.initContainers)];
    fact.containersIncomplete =
      entries.length > 64 ||
      declared.length !== entries.length ||
      entries.length === 0;
    fact.containers = entries.slice(0, 64).map(({ value, role }) => {
      const entry = object(value);
      const state = object(entry.state);
      const terminated = state.terminated !== undefined;
      const waiting = state.waiting !== undefined;
      const detail = object(terminated ? state.terminated : state.waiting);
      let containerState: ObservationFact["containers"][number]["state"] =
        "Unknown";
      if (state.running !== undefined) {
        containerState = "Running";
      }
      if (waiting) {
        containerState = "Waiting";
      }
      if (terminated) {
        containerState = "Terminated";
      }
      return {
        name: identifier.parse(entry.name),
        role,
        ready: typeof entry.ready === "boolean" ? entry.ready : null,
        restarts: number(entry.restartCount),
        state: containerState,
        reason:
          detail.reason === undefined
            ? "Unknown"
            : pick(reason, detail.reason, "Other"),
        exitCode: terminated
          ? pick(
              factSchema.shape.containers.element.shape.exitCode,
              detail.exitCode,
              null,
            )
          : null,
      };
    });
  }
  if (kind === "Job") {
    fact.active = number(status.active);
    fact.succeeded = number(status.succeeded);
    fact.failed = number(status.failed);
  }
  if (kind === "CronJob") {
    fact.active = Array.isArray(status.active) ? status.active.length : null;
    fact.schedule = pick(factSchema.shape.schedule, spec.schedule, null);
    fact.suspended = typeof spec.suspend === "boolean" ? spec.suspend : null;
    fact.lastSuccessfulTime = pick(
      factSchema.shape.lastSuccessfulTime,
      status.lastSuccessfulTime,
      null,
    );
  }
  if (kind === "PersistentVolumeClaim") {
    fact.requestedCapacity = pick(
      factSchema.shape.requestedCapacity,
      object(object(spec.resources).requests).storage,
      null,
    );
  }
  return factSchema.parse(fact);
}
export function object(value: unknown): Record<string, unknown> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  return parsed.success ? parsed.data : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Verify the remote contract and scope before anything can enter tool history. */
export function validateSnapshot(value: unknown, scope: Scope): Snapshot {
  const snapshot = snapshotSchema.parse(value);
  const expected = new Set(
    scope.namespaces.flatMap((namespace) =>
      kinds
        .filter((kind) => kind !== "Node")
        .map((kind) => `${namespace}/${kind}`),
    ),
  );
  if (scope.includeNodes) {
    expected.add("null/Node");
  }
  const seen = new Set<string>();
  for (const coverage of snapshot.coverage) {
    const key = `${coverage.namespace}/${coverage.kind}`;
    if (!expected.has(key) || seen.has(key)) {
      throw new Error("Invalid observer coverage");
    }
    seen.add(key);
    if (
      coverage.state !== "Complete" &&
      coverage.state !== "Truncated" &&
      coverage.facts.length
    ) {
      throw new Error("Invalid observer facts");
    }
    if (
      coverage.state === "Complete" &&
      coverage.lastSuccessAt !== snapshot.observedAt
    ) {
      throw new Error("Invalid complete collection timestamp");
    }
    const names = new Set<string>();
    for (const fact of coverage.facts) {
      if (
        fact.namespace !== coverage.namespace ||
        fact.kind !== coverage.kind ||
        names.has(fact.name)
      ) {
        throw new Error("Invalid observer scope");
      }
      names.add(fact.name);
    }
  }
  if (seen.size !== expected.size) {
    throw new Error("Missing observer coverage");
  }
  return snapshot;
}
