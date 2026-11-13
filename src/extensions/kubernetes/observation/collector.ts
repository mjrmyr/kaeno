import { z } from "zod";
import {
  kinds,
  projectFact,
  scopeSchema,
  snapshotSchema,
  type Snapshot,
  type Scope,
} from "./contract.ts";
import { ObservationError } from "./transport.ts";

const resources = {
  Deployment: ["/apis/apps/v1", "deployments"],
  StatefulSet: ["/apis/apps/v1", "statefulsets"],
  DaemonSet: ["/apis/apps/v1", "daemonsets"],
  Pod: ["/api/v1", "pods"],
  Job: ["/apis/batch/v1", "jobs"],
  CronJob: ["/apis/batch/v1", "cronjobs"],
  PersistentVolumeClaim: ["/api/v1", "persistentvolumeclaims"],
  Node: ["/api/v1", "nodes"],
} as const;
const listSchema = z.object({
  items: z.array(z.unknown()).max(200),
  metadata: z.object({ continue: z.string().optional() }).optional(),
});
export type Collect = (path: string, signal?: AbortSignal) => Promise<unknown>;

/** Four-lane bounded polling; only fully constructed sanitized snapshots replace the current one. */
export class KubernetesObserver {
  readonly scope: Scope;
  private current: Snapshot | undefined;
  private readonly collect: Collect;
  private readonly now: () => Date;
  constructor(
    scope: z.input<typeof scopeSchema>,
    collect: Collect,
    now = () => new Date(),
  ) {
    this.collect = collect;
    this.now = now;
    this.scope = scopeSchema.parse(scope);
  }
  snapshot(): Snapshot | undefined {
    return this.current ? structuredClone(this.current) : undefined;
  }
  async poll(signal?: AbortSignal): Promise<void> {
    const observedAt = this.now().toISOString();
    const targets: {
      namespace: string | null;
      kind: (typeof kinds)[number];
    }[] = this.scope.namespaces.flatMap((namespace) =>
      kinds
        .filter((kind) => kind !== "Node")
        .map((kind) => ({ namespace, kind })),
    );
    if (this.scope.includeNodes) {
      targets.push({ namespace: null, kind: "Node" });
    }
    async function collectTarget(
      this: KubernetesObserver,
      { namespace, kind }: (typeof targets)[number],
    ): Promise<Snapshot["coverage"][number]> {
      const previous = this.current?.coverage.find(
        (entry) => entry.namespace === namespace && entry.kind === kind,
      );
      try {
        const [base, resource] = resources[kind];
        const path =
          namespace === null
            ? `${base}/${resource}`
            : `${base}/namespaces/${namespace}/${resource}`;
        const raw = listSchema.parse(
          await this.collect(`${path}?limit=200`, signal),
        );
        const facts: Snapshot["coverage"][number]["facts"] = [];
        let bytes = 0;
        let truncated = !!raw.metadata?.continue;
        for (const item of raw.items) {
          const fact = projectFact(kind, namespace, item);
          bytes += Buffer.byteLength(JSON.stringify(fact)) + 1;
          // Bound the whole snapshot below the host's 16 MiB transport limit,
          // including with 20 namespaces and maximum-size container names.
          if (bytes > 60 * 1024) {
            truncated = true;
            break;
          }
          facts.push(fact);
        }
        if (new Set(facts.map((fact) => fact.name)).size !== facts.length) {
          throw new ObservationError("Invalid");
        }
        return {
          namespace,
          kind,
          state: truncated ? "Truncated" : "Complete",
          lastSuccessAt: truncated
            ? (previous?.lastSuccessAt ?? null)
            : observedAt,
          facts,
        };
      } catch (error) {
        return {
          namespace,
          kind,
          state: error instanceof ObservationError ? error.category : "Invalid",
          lastSuccessAt: previous?.lastSuccessAt ?? null,
          facts: [],
        };
      }
    }
    const coverage: Snapshot["coverage"] = [];
    // Each lane writes a distinct slot. The published snapshot remains unchanged until all finish.
    let next = 0;

    async function lane(this: KubernetesObserver) {
      while (next < targets.length && !signal?.aborted) {
        const index = next++;
        const target = targets[index];
        if (target) {
          coverage[index] = await collectTarget.call(this, target);
        }
      }
    }
    await Promise.all(Array.from({ length: 4 }, () => lane.call(this)));
    if (signal?.aborted) {
      return;
    }
    this.current = snapshotSchema.parse({
      schemaVersion: 1,
      observedAt,
      coverage,
    });
  }
}
