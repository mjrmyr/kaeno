import { createHash } from "node:crypto";
import type { Resources } from "./resources.ts";
import type { Sandbox } from "./client.ts";

export interface Reservation {
  conversationId: number;
  holder: number;
  sandbox: string;
  token: string;
  image: string;
  phase: "waiting" | "held" | "suspended";
  admitted: boolean;
  fqdn: string | null;
}
export const SANDBOX_LABEL = "app.kubernetes.io/name=kaeno-sandbox";
export const OWNER_LABEL = "kaeno.io/owner";
export const CONVERSATION_ANNOTATION = "kaeno.io/conversation";

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function assertIdentity(
  sandbox: Sandbox,
  reservation: Reservation,
  options: { owner: string; runtimeClassName?: string },
): void {
  const pod = sandbox.spec.podTemplate.spec;
  if (
    sandbox.metadata.labels[OWNER_LABEL] !== options.owner ||
    pod.runtimeClassName !== options.runtimeClassName ||
    sandbox.metadata.annotations[CONVERSATION_ANNOTATION] !==
      String(reservation.conversationId) ||
    sandbox.metadata.annotations["kaeno.io/token-sha256"] !==
      tokenHash(reservation.token) ||
    pod.containers.length !== 1 ||
    pod.containers[0].image !== reservation.image
  ) {
    throw new Error(
      `Kubernetes sandbox identity mismatch for ${reservation.sandbox}; refusing to adopt or delete`,
    );
  }
}

export function sandboxManifest(
  reservation: Reservation,
  options: {
    namespace: string;
    owner: string;
    serviceAccount: string;
    resources: Resources;
    workspace: { size: string; storageClassName?: string };
    runtimeClassName?: string;
  },
): object {
  const labels = {
    "app.kubernetes.io/name": "kaeno-sandbox",
    [OWNER_LABEL]: options.owner,
  };
  return {
    apiVersion: "agents.x-k8s.io/v1beta1",
    kind: "Sandbox",
    metadata: {
      name: reservation.sandbox,
      namespace: options.namespace,
      labels,
      annotations: {
        [CONVERSATION_ANNOTATION]: String(reservation.conversationId),
        "kaeno.io/token-sha256": tokenHash(reservation.token),
      },
    },
    spec: {
      operatingMode: "Running",
      service: true,
      failedPodPolicy: "Retain",
      volumeClaimTemplates: [
        {
          metadata: { name: "state" },
          spec: {
            accessModes: ["ReadWriteOnce"],
            ...(options.workspace.storageClassName === undefined
              ? {}
              : { storageClassName: options.workspace.storageClassName }),
            resources: { requests: { storage: options.workspace.size } },
          },
        },
      ],
      podTemplate: {
        metadata: { labels },
        spec: {
          ...(options.runtimeClassName === undefined
            ? {}
            : { runtimeClassName: options.runtimeClassName }),
          restartPolicy: "Never",
          activeDeadlineSeconds: 4 * 3600,
          terminationGracePeriodSeconds: 5,
          serviceAccountName: options.serviceAccount,
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "envd",
              image: reservation.image,
              imagePullPolicy: "IfNotPresent",
              command: ["node", "/app/src/host/envd.ts"],
              workingDir: "/workspace",
              env: [
                { name: "KAENO_ENV_TOKEN", value: reservation.token },
                { name: "HOME", value: "/home/agent" },
                { name: "TMPDIR", value: "/tmp" },
              ],
              ports: [{ name: "envd", containerPort: 7070 }],
              readinessProbe: {
                httpGet: { path: "/healthz", port: "envd" },
                periodSeconds: 2,
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
              resources: options.resources,
              volumeMounts: [
                {
                  name: "state",
                  mountPath: "/workspace",
                  subPath: "workspace",
                },
                { name: "state", mountPath: "/home/agent", subPath: "home" },
                { name: "tmp", mountPath: "/tmp" },
              ],
            },
          ],
          volumes: [{ name: "tmp", emptyDir: { sizeLimit: "2Gi" } }],
        },
      },
    },
  };
}
