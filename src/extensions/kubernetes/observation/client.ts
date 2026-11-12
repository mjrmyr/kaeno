import {
  scopeSchema,
  validateSnapshot,
  kindSchema,
  namespaceName,
  identifier,
  type Scope,
  type Snapshot,
  type ObservationFact,
} from "./contract.ts";
import {
  ObservationError,
  readJson,
  type TransportOptions,
  originSchema,
} from "./transport.ts";
import { z } from "zod";
import { assess } from "./health.ts";

type Freshness = "Fresh" | "Stale";
type Assessment = ReturnType<typeof assess>;
interface Overview {
  schemaVersion: 1;
  observedAt: string;
  freshness: Freshness;
  coverage: (Omit<Snapshot["coverage"][number], "facts"> & {
    count: number;
    healthy: number;
    unhealthy: number;
    unknown: number;
  })[];
  resources: (Pick<ObservationFact, "namespace" | "kind" | "name"> & {
    assessment: Assessment;
  })[];
  resourcesIncomplete: boolean;
}
interface WorkloadHealth {
  schemaVersion: 1;
  observedAt: string;
  freshness: Freshness;
  coverage: Pick<Snapshot["coverage"][number], "state" | "lastSuccessAt">;
  assessment: Assessment;
  result: "Observed" | "NotFound" | "Unobserved";
  fact: ObservationFact | null;
}
export class ObservationClient {
  readonly scope: Scope;
  private readonly read: (signal?: AbortSignal) => Promise<unknown>;
  private readonly now: () => number;
  constructor(
    scope: z.input<typeof scopeSchema>,
    read: (signal?: AbortSignal) => Promise<unknown>,
    now = () => Date.now(),
  ) {
    this.read = read;
    this.now = now;
    this.scope = scopeSchema.parse(scope);
  }
  private async snapshot(signal?: AbortSignal): Promise<Snapshot> {
    try {
      const snapshot = validateSnapshot(await this.read(signal), this.scope);
      if (
        Date.parse(snapshot.observedAt) > this.now() + 5_000 ||
        snapshot.coverage.some(
          (entry) =>
            entry.lastSuccessAt !== null &&
            Date.parse(entry.lastSuccessAt) > Date.parse(snapshot.observedAt),
        )
      ) {
        throw new Error("Invalid observation time");
      }
      return snapshot;
    } catch {
      throw new ObservationError("Unavailable");
    }
  }
  private freshness(snapshot: Snapshot): Freshness {
    return this.now() - Date.parse(snapshot.observedAt) >
      this.scope.staleAfterMs
      ? "Stale"
      : "Fresh";
  }
  async overview(signal?: AbortSignal): Promise<Overview> {
    const snapshot = await this.snapshot(signal);
    // No arbitrary truncation of JSON by the tool framework. Overview has counts, detail has evidence.
    return {
      schemaVersion: snapshot.schemaVersion,
      observedAt: snapshot.observedAt,
      freshness: this.freshness(snapshot),
      coverage: snapshot.coverage.map((entry) => ({
        namespace: entry.namespace,
        kind: entry.kind,
        state: entry.state,
        lastSuccessAt: entry.lastSuccessAt,
        count: entry.facts.length,
        healthy:
          this.freshness(snapshot) === "Stale"
            ? 0
            : entry.facts.filter((fact) => assess(fact) === "Healthy").length,
        unhealthy:
          this.freshness(snapshot) === "Stale"
            ? 0
            : entry.facts.filter((fact) => assess(fact) === "Unhealthy").length,
        unknown:
          this.freshness(snapshot) === "Stale"
            ? entry.facts.length
            : entry.facts.filter((fact) => assess(fact) === "Unknown").length,
      })),
      resources: snapshot.coverage
        .flatMap((entry) => entry.facts)
        .sort(
          (left, right) =>
            ["Unhealthy", "Unknown", "Healthy"].indexOf(assess(left)) -
            ["Unhealthy", "Unknown", "Healthy"].indexOf(assess(right)),
        )
        .slice(0, 100)
        .map((fact) => ({
          namespace: fact.namespace,
          kind: fact.kind,
          name: fact.name,
          assessment:
            this.freshness(snapshot) === "Stale" ? "Unknown" : assess(fact),
        })),
      resourcesIncomplete:
        snapshot.coverage.reduce((sum, entry) => sum + entry.facts.length, 0) >
          100 || snapshot.coverage.some((entry) => entry.state !== "Complete"),
    };
  }
  async workload(
    input: { namespace?: string; kind: string; name: string },
    signal?: AbortSignal,
  ): Promise<WorkloadHealth> {
    const kind = kindSchema.parse(input.kind);
    const name = identifier.parse(input.name);
    const namespace =
      kind === "Node" ? null : namespaceName.parse(input.namespace);
    if (
      (kind === "Node" &&
        (!this.scope.includeNodes || input.namespace !== undefined)) ||
      (namespace !== null && !this.scope.namespaces.includes(namespace))
    ) {
      throw new ObservationError("Forbidden");
    }
    const snapshot = await this.snapshot(signal);
    const coverage = snapshot.coverage.find(
      (entry) => entry.namespace === namespace && entry.kind === kind,
    );
    if (!coverage) {
      throw new ObservationError("Unavailable");
    }
    const fact = coverage.facts.find((fact) => fact.name === name) ?? null;
    const freshness = this.freshness(snapshot);
    let result: WorkloadHealth["result"] = "Unobserved";
    if (coverage.state === "Complete" && freshness === "Fresh") {
      result = "NotFound";
    }
    if (fact) {
      result = "Observed";
    }
    return {
      schemaVersion: snapshot.schemaVersion,
      observedAt: snapshot.observedAt,
      freshness,
      coverage: {
        state: coverage.state,
        lastSuccessAt: coverage.lastSuccessAt,
      },
      assessment: fact && freshness === "Fresh" ? assess(fact) : "Unknown",
      result,
      fact,
    };
  }
}
export function remoteObservationClient(
  scope: z.input<typeof scopeSchema>,
  options: TransportOptions,
): ObservationClient {
  originSchema.parse(options.origin);
  return new ObservationClient(scope, (signal) =>
    readJson(options, "/v1/snapshot", 16 * 1024 * 1024, signal),
  );
}
