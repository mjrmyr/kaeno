import { expect, it } from "vitest";
import { CLUSTER_KINDS, projectClusterObject } from "../index.ts";

const CANARY = "CANARY-7f3a";
const metadata = {
  name: "web",
  namespace: "apps",
  labels: { app: "web" },
  creationTimestamp: "2026-11-01T00:00:00Z",
  annotations: {
    "kubectl.kubernetes.io/last-applied-configuration": `{"env":[{"value":"${CANARY}"}]}`,
  },
  managedFields: [{ manager: CANARY }],
  ownerReferences: [{ kind: "ReplicaSet", name: "web-1", uid: CANARY }],
};
const container = {
  name: "app",
  image: "ghcr.io/owner/web:1",
  command: ["/bin/app", `--token=${CANARY}`],
  args: [`--password=${CANARY}`],
  env: [
    { name: "PLAIN", value: CANARY },
    {
      name: "FROM_SECRET",
      valueFrom: { secretKeyRef: { name: CANARY, key: CANARY } },
    },
  ],
  envFrom: [{ secretRef: { name: CANARY } }],
  volumeMounts: [{ name: CANARY, mountPath: `/run/${CANARY}` }],
  resources: { requests: { cpu: "100m" }, limits: { memory: "256Mi" } },
};
const podSpec = {
  containers: [container],
  initContainers: [container],
  volumes: [{ name: "v", secret: { secretName: CANARY } }],
  imagePullSecrets: [{ name: CANARY }],
  nodeName: "node-1",
};
const raw = {
  metadata,
  spec: {
    ...podSpec,
    template: { metadata, spec: podSpec },
    rules: [
      {
        host: "web.home",
        http: {
          paths: [
            {
              path: "/",
              backend: { service: { name: "web", port: { number: 80 } } },
            },
          ],
        },
      },
    ],
    tls: [{ hosts: ["web.home"], secretName: CANARY }],
    csi: { volumeAttributes: { password: CANARY } },
    claimRef: { namespace: "apps", name: "data", uid: CANARY },
  },
  status: {
    phase: "Running",
    message: `failed with password=${CANARY}`,
    containerStatuses: [
      {
        name: "app",
        ready: false,
        restartCount: 7,
        state: {
          waiting: { reason: "CrashLoopBackOff", message: `token: ${CANARY}` },
        },
        lastState: {
          terminated: {
            exitCode: 1,
            reason: "Error",
            message: `Authorization: Bearer ${CANARY}abcdef`,
          },
        },
      },
    ],
    conditions: [
      { type: "Ready", status: "False", message: `secret=${CANARY}` },
    ],
  },
};

it.each(CLUSTER_KINDS)("never projects sensitive fields of %s", (kind) => {
  const { detail, row } = projectClusterObject(kind, raw);
  expect(JSON.stringify({ detail, row })).not.toContain(CANARY);
});

it("keeps what diagnosing a failing pod needs", () => {
  const { row, detail } = projectClusterObject("pods", raw);
  expect(row).toEqual({
    name: "web",
    namespace: "apps",
    status: "CrashLoopBackOff",
    ready: "0/1",
    restarts: 7,
    node: "node-1",
    created: "2026-11-01T00:00:00Z",
  });
  expect(detail).toMatchObject({
    spec: {
      containers: [
        {
          name: "app",
          image: "ghcr.io/owner/web:1",
          resources: { requests: { cpu: "100m" }, limits: { memory: "256Mi" } },
        },
      ],
    },
    status: {
      containerStatuses: [
        { lastState: { terminated: { exitCode: 1, reason: "Error" } } },
      ],
    },
  });
});
