import { createHash } from "node:crypto";
import type { Resources } from "./resources.ts";
import type { Pod } from "./client.ts";

export interface Reservation {
  workId: number;
  conversationId: number;
  pod: string;
  token: string;
  image: string;
  phase: "waiting" | "held";
}
export const SANDBOX_LABEL = "app.kubernetes.io/name=kaeno-sandbox";
export const OWNER_LABEL = "kaeno.io/owner";

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function assertIdentity(
  pod: Pod,
  reservation: Reservation,
  owner: string,
): void {
  if (
    pod.metadata.labels[OWNER_LABEL] !== owner ||
    pod.metadata.annotations["kaeno.io/work"] !== String(reservation.workId) ||
    pod.metadata.annotations["kaeno.io/conversation"] !==
      String(reservation.conversationId) ||
    pod.metadata.annotations["kaeno.io/token-sha256"] !==
      tokenHash(reservation.token) ||
    pod.spec.containers.length !== 1 ||
    pod.spec.containers[0].image !== reservation.image
  ) {
    throw new Error(
      `Kubernetes sandbox identity mismatch for ${reservation.pod}; refusing to adopt or delete`,
    );
  }
}

export function sandboxPod(
  reservation: Reservation,
  options: {
    namespace: string;
    owner: string;
    service: string;
    serviceAccount: string;
    resources: Resources;
  },
): object {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: reservation.pod,
      namespace: options.namespace,
      labels: {
        "app.kubernetes.io/name": "kaeno-sandbox",
        [OWNER_LABEL]: options.owner,
      },
      annotations: {
        "kaeno.io/work": String(reservation.workId),
        "kaeno.io/conversation": String(reservation.conversationId),
        "kaeno.io/token-sha256": tokenHash(reservation.token),
      },
    },
    spec: {
      hostname: reservation.pod,
      subdomain: options.service,
      restartPolicy: "Never",
      activeDeadlineSeconds: 4 * 3600,
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
            { name: "workspace", mountPath: "/workspace" },
            { name: "home", mountPath: "/home/agent" },
            { name: "tmp", mountPath: "/tmp" },
          ],
        },
      ],
      volumes: [
        { name: "workspace", emptyDir: { sizeLimit: "5Gi" } },
        { name: "home", emptyDir: { sizeLimit: "1Gi" } },
        { name: "tmp", emptyDir: { sizeLimit: "2Gi" } },
      ],
    },
  };
}
