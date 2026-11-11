import { z } from "zod";
import { redact } from "./redact.ts";

const text = z.string().transform(redact);
const strings = z.record(z.string(), z.string());
const metadata = z.object({
  name: z.string(),
  namespace: z.string().optional(),
  labels: strings.optional(),
  creationTimestamp: z.string().optional(),
  deletionTimestamp: z.string().nullish(),
  ownerReferences: z
    .array(z.object({ kind: z.string(), name: z.string() }))
    .optional(),
});
const conditions = z
  .array(
    z.object({
      type: z.string(),
      status: z.string(),
      reason: z.string().optional(),
      message: text.optional(),
      lastTransitionTime: z.string().nullish(),
    }),
  )
  .optional();
const container = z.object({
  name: z.string(),
  image: z.string().optional(),
  ports: z
    .array(
      z.object({
        name: z.string().optional(),
        containerPort: z.number(),
        protocol: z.string().optional(),
      }),
    )
    .optional(),
  resources: z
    .object({ requests: strings.optional(), limits: strings.optional() })
    .optional(),
});
const template = z
  .object({
    spec: z.object({ containers: z.array(container).optional() }).optional(),
  })
  .optional();
const containerState = z
  .object({
    waiting: z
      .object({ reason: z.string().optional(), message: text.optional() })
      .optional(),
    running: z.object({ startedAt: z.string().nullish() }).optional(),
    terminated: z
      .object({
        exitCode: z.number(),
        reason: z.string().optional(),
        message: text.optional(),
        startedAt: z.string().nullish(),
        finishedAt: z.string().nullish(),
      })
      .optional(),
  })
  .optional();
const containerStatuses = z
  .array(
    z.object({
      name: z.string(),
      ready: z.boolean().optional(),
      restartCount: z.number().optional(),
      image: z.string().optional(),
      state: containerState,
      lastState: containerState,
    }),
  )
  .optional();
const loadBalancer = z
  .object({
    ingress: z
      .array(
        z.object({
          ip: z.string().optional(),
          hostname: z.string().optional(),
        }),
      )
      .optional(),
  })
  .optional();
const replicaStatus = {
  replicas: z.number().optional(),
  readyReplicas: z.number().optional(),
  updatedReplicas: z.number().optional(),
  availableReplicas: z.number().optional(),
  unavailableReplicas: z.number().optional(),
  conditions,
};

const pod = z.object({
  metadata,
  spec: z
    .object({
      nodeName: z.string().optional(),
      restartPolicy: z.string().optional(),
      priorityClassName: z.string().optional(),
      initContainers: z.array(container).optional(),
      containers: z.array(container).optional(),
    })
    .optional(),
  status: z
    .object({
      phase: z.string().optional(),
      reason: z.string().optional(),
      message: text.optional(),
      podIP: z.string().optional(),
      startTime: z.string().optional(),
      qosClass: z.string().optional(),
      conditions,
      initContainerStatuses: containerStatuses,
      containerStatuses,
    })
    .optional(),
});
const deployment = z.object({
  metadata,
  spec: z
    .object({
      replicas: z.number().optional(),
      strategy: z.object({ type: z.string().optional() }).optional(),
      selector: z.object({ matchLabels: strings.optional() }).optional(),
      template,
    })
    .optional(),
  status: z.object(replicaStatus).optional(),
});
const statefulSet = z.object({
  metadata,
  spec: z
    .object({
      replicas: z.number().optional(),
      serviceName: z.string().optional(),
      template,
    })
    .optional(),
  status: z
    .object({ ...replicaStatus, currentReplicas: z.number().optional() })
    .optional(),
});
const daemonSet = z.object({
  metadata,
  spec: z.object({ template }).optional(),
  status: z
    .object({
      desiredNumberScheduled: z.number().optional(),
      currentNumberScheduled: z.number().optional(),
      numberReady: z.number().optional(),
      numberAvailable: z.number().optional(),
      numberUnavailable: z.number().optional(),
      numberMisscheduled: z.number().optional(),
      updatedNumberScheduled: z.number().optional(),
      conditions,
    })
    .optional(),
});
const replicaSet = z.object({
  metadata,
  spec: z.object({ replicas: z.number().optional() }).optional(),
  status: z.object(replicaStatus).optional(),
});
const job = z.object({
  metadata,
  spec: z
    .object({
      completions: z.number().nullish(),
      parallelism: z.number().nullish(),
      backoffLimit: z.number().nullish(),
      template,
    })
    .optional(),
  status: z
    .object({
      active: z.number().optional(),
      succeeded: z.number().optional(),
      failed: z.number().optional(),
      startTime: z.string().optional(),
      completionTime: z.string().optional(),
      conditions,
    })
    .optional(),
});
const cronJob = z.object({
  metadata,
  spec: z
    .object({
      schedule: z.string().optional(),
      timeZone: z.string().nullish(),
      suspend: z.boolean().optional(),
    })
    .optional(),
  status: z
    .object({
      lastScheduleTime: z.string().optional(),
      lastSuccessfulTime: z.string().optional(),
      active: z.array(z.object({ name: z.string().optional() })).optional(),
    })
    .optional(),
});
const service = z.object({
  metadata,
  spec: z
    .object({
      type: z.string().optional(),
      clusterIP: z.string().optional(),
      selector: strings.optional(),
      ports: z
        .array(
          z.object({
            name: z.string().optional(),
            port: z.number(),
            targetPort: z.union([z.number(), z.string()]).optional(),
            nodePort: z.number().optional(),
            protocol: z.string().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  status: z.object({ loadBalancer }).optional(),
});
const ingress = z.object({
  metadata,
  spec: z
    .object({
      ingressClassName: z.string().optional(),
      rules: z
        .array(
          z.object({
            host: z.string().optional(),
            http: z
              .object({
                paths: z.array(
                  z.object({
                    path: z.string().optional(),
                    pathType: z.string().optional(),
                    backend: z.object({
                      service: z
                        .object({
                          name: z.string(),
                          port: z
                            .object({
                              number: z.number().optional(),
                              name: z.string().optional(),
                            })
                            .optional(),
                        })
                        .optional(),
                    }),
                  }),
                ),
              })
              .optional(),
          }),
        )
        .optional(),
      tls: z
        .array(z.object({ hosts: z.array(z.string()).optional() }))
        .optional(),
    })
    .optional(),
  status: z.object({ loadBalancer }).optional(),
});
const claim = z.object({
  metadata,
  spec: z
    .object({
      storageClassName: z.string().nullish(),
      accessModes: z.array(z.string()).optional(),
      resources: z.object({ requests: strings.optional() }).optional(),
      volumeName: z.string().optional(),
    })
    .optional(),
  status: z
    .object({
      phase: z.string().optional(),
      capacity: strings.optional(),
      conditions,
    })
    .optional(),
});
const volume = z.object({
  metadata,
  spec: z
    .object({
      capacity: strings.optional(),
      storageClassName: z.string().optional(),
      accessModes: z.array(z.string()).optional(),
      persistentVolumeReclaimPolicy: z.string().optional(),
      claimRef: z
        .object({ namespace: z.string().optional(), name: z.string() })
        .optional(),
    })
    .optional(),
  status: z
    .object({
      phase: z.string().optional(),
      reason: z.string().optional(),
      message: text.optional(),
    })
    .optional(),
});
const node = z.object({
  metadata,
  spec: z
    .object({
      unschedulable: z.boolean().optional(),
      taints: z
        .array(
          z.object({
            key: z.string(),
            value: z.string().optional(),
            effect: z.string(),
          }),
        )
        .optional(),
    })
    .optional(),
  status: z
    .object({
      capacity: strings.optional(),
      allocatable: strings.optional(),
      conditions,
      addresses: z
        .array(z.object({ type: z.string(), address: z.string() }))
        .optional(),
      nodeInfo: z
        .object({
          kubeletVersion: z.string().optional(),
          osImage: z.string().optional(),
          kernelVersion: z.string().optional(),
          containerRuntimeVersion: z.string().optional(),
          architecture: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});
const namespace = z.object({
  metadata,
  status: z.object({ phase: z.string().optional() }).optional(),
});
export const eventSchema = z.object({
  metadata,
  involvedObject: z.object({
    kind: z.string().optional(),
    namespace: z.string().optional(),
    name: z.string().optional(),
  }),
  type: z.string().optional(),
  reason: z.string().optional(),
  message: text.optional(),
  count: z.number().optional(),
  firstTimestamp: z.string().nullish(),
  lastTimestamp: z.string().nullish(),
  eventTime: z.string().nullish(),
  source: z.object({ component: z.string().optional() }).optional(),
  reportingComponent: z.string().optional(),
});
export type ClusterEvent = z.output<typeof eventSchema>;
export const usageSchema = z.object({
  metadata: z.object({
    name: z.string(),
    namespace: z.string().optional(),
  }),
  usage: z.object({ cpu: z.string(), memory: z.string() }).optional(),
  containers: z
    .array(
      z.object({
        name: z.string(),
        usage: z.object({ cpu: z.string(), memory: z.string() }),
      }),
    )
    .optional(),
});

function count(values: readonly unknown[] | undefined): number {
  return values?.length ?? 0;
}
function ready(value: { conditions?: z.output<typeof conditions> }) {
  return value.conditions?.find((condition) => condition.type === "Ready")
    ?.status;
}
function of(desired: number | undefined, actual: number | undefined) {
  return `${actual ?? 0}/${desired ?? 0}`;
}

export function podStatus(value: z.output<typeof pod>): string {
  if (value.metadata.deletionTimestamp) {
    return "Terminating";
  }
  for (const status of [
    ...(value.status?.initContainerStatuses ?? []),
    ...(value.status?.containerStatuses ?? []),
  ]) {
    const reason =
      status.state?.waiting?.reason ??
      (status.state?.terminated && status.state.terminated.exitCode !== 0
        ? (status.state.terminated.reason ?? "Error")
        : undefined);
    if (reason) {
      return reason;
    }
  }
  return value.status?.reason ?? value.status?.phase ?? "Unknown";
}

export interface Projected {
  readonly namespace: string | undefined;
  readonly detail: object;
  readonly row: Record<string, unknown>;
}
interface KindDefinition {
  readonly path: string;
  readonly namespaced: boolean;
  project(raw: unknown): Projected;
}

function kind<S extends z.ZodType<{ metadata: z.output<typeof metadata> }>>(
  path: string,
  namespaced: boolean,
  schema: S,
  row: (value: z.output<S>) => Record<string, unknown>,
): KindDefinition {
  return {
    path,
    namespaced,
    project(raw) {
      const detail = schema.parse(raw);
      const { name, namespace, creationTimestamp } = detail.metadata;
      return {
        namespace,
        detail,
        row: {
          name,
          ...(namespace ? { namespace } : {}),
          ...row(detail),
          created: creationTimestamp,
        },
      };
    },
  };
}

export const KIND_NAMES = [
  "pods",
  "deployments",
  "statefulsets",
  "daemonsets",
  "replicasets",
  "jobs",
  "cronjobs",
  "services",
  "ingresses",
  "persistentvolumeclaims",
  "persistentvolumes",
  "nodes",
  "namespaces",
] as const;
export type Kind = (typeof KIND_NAMES)[number];

export const KINDS: Record<Kind, KindDefinition> = {
  pods: kind("/api/v1", true, pod, (value) => {
    const statuses = value.status?.containerStatuses ?? [];
    return {
      status: podStatus(value),
      ready: `${statuses.filter((status) => status.ready).length}/${statuses.length}`,
      restarts: statuses.reduce(
        (sum, status) => sum + (status.restartCount ?? 0),
        0,
      ),
      node: value.spec?.nodeName,
    };
  }),
  deployments: kind("/apis/apps/v1", true, deployment, (value) => ({
    ready: of(value.spec?.replicas, value.status?.readyReplicas),
    updated: value.status?.updatedReplicas ?? 0,
    available: value.status?.availableReplicas ?? 0,
  })),
  statefulsets: kind("/apis/apps/v1", true, statefulSet, (value) => ({
    ready: of(value.spec?.replicas, value.status?.readyReplicas),
  })),
  daemonsets: kind("/apis/apps/v1", true, daemonSet, (value) => ({
    ready: of(value.status?.desiredNumberScheduled, value.status?.numberReady),
    unavailable: value.status?.numberUnavailable ?? 0,
  })),
  replicasets: kind("/apis/apps/v1", true, replicaSet, (value) => ({
    ready: of(value.spec?.replicas, value.status?.readyReplicas),
  })),
  jobs: kind("/apis/batch/v1", true, job, (value) => ({
    active: value.status?.active ?? 0,
    succeeded: value.status?.succeeded ?? 0,
    failed: value.status?.failed ?? 0,
    completed: value.status?.completionTime,
  })),
  cronjobs: kind("/apis/batch/v1", true, cronJob, (value) => ({
    schedule: value.spec?.schedule,
    suspended: value.spec?.suspend ?? false,
    active: count(value.status?.active),
    lastSuccessful: value.status?.lastSuccessfulTime,
  })),
  services: kind("/api/v1", true, service, (value) => ({
    type: value.spec?.type,
    clusterIP: value.spec?.clusterIP,
    ports: value.spec?.ports?.map(
      (port) => `${port.port}/${port.protocol ?? "TCP"}`,
    ),
  })),
  ingresses: kind("/apis/networking.k8s.io/v1", true, ingress, (value) => ({
    hosts: value.spec?.rules?.flatMap((rule) => (rule.host ? [rule.host] : [])),
  })),
  persistentvolumeclaims: kind("/api/v1", true, claim, (value) => ({
    phase: value.status?.phase,
    capacity: value.status?.capacity?.storage,
    storageClass: value.spec?.storageClassName,
    volume: value.spec?.volumeName,
  })),
  persistentvolumes: kind("/api/v1", false, volume, (value) => ({
    phase: value.status?.phase,
    capacity: value.spec?.capacity?.storage,
    claim: value.spec?.claimRef
      ? `${value.spec.claimRef.namespace}/${value.spec.claimRef.name}`
      : undefined,
  })),
  nodes: kind("/api/v1", false, node, (value) => ({
    ready: ready(value.status ?? {}),
    unschedulable: value.spec?.unschedulable ?? false,
    pressure: value.status?.conditions
      ?.filter(
        (condition) =>
          condition.type !== "Ready" && condition.status === "True",
      )
      .map((condition) => condition.type),
    version: value.status?.nodeInfo?.kubeletVersion,
  })),
  namespaces: kind("/api/v1", false, namespace, (value) => ({
    phase: value.status?.phase,
  })),
};
export function project(name: Kind, raw: unknown): Projected {
  return KINDS[name].project(raw);
}
