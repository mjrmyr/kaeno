import { z } from "zod";
import type { PersistentVolumeClaim } from "./client.ts";
import { OWNER_LABEL } from "./pod.ts";

/** Storage belongs to a conversation; execution pods and tokens belong to Assignments. */
export interface Workspace {
  conversationId: number;
  claim: string;
  key: string;
  uid: string | null;
  holder: number;
  retiring: boolean;
}

export const workspaceSchema = z
  .object({
    size: z
      .string()
      .regex(/^[1-9]\d*(?:Ki|Mi|Gi|Ti)$/)
      .default("5Gi"),
    storageClassName: z
      .string()
      .min(1)
      .max(253)
      .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
      .optional(),
  })
  .strict()
  .default({ size: "5Gi" });

export function workspaceClaim(
  workspace: Workspace,
  options: {
    namespace: string;
    owner: string;
    workspace: z.output<typeof workspaceSchema>;
  },
): object {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: workspace.claim,
      namespace: options.namespace,
      labels: {
        "app.kubernetes.io/name": "kaeno-workspace",
        [OWNER_LABEL]: options.owner,
      },
      annotations: {
        "kaeno.io/conversation": String(workspace.conversationId),
        "kaeno.io/workspace": workspace.key,
      },
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      volumeMode: "Filesystem",
      ...(options.workspace.storageClassName === undefined
        ? {}
        : { storageClassName: options.workspace.storageClassName }),
      resources: { requests: { storage: options.workspace.size } },
    },
  };
}

export function assertWorkspace(
  claim: PersistentVolumeClaim,
  workspace: Workspace,
  options: { owner: string },
): void {
  if (
    claim.metadata.name !== workspace.claim ||
    claim.metadata.labels[OWNER_LABEL] !== options.owner ||
    claim.metadata.annotations["kaeno.io/conversation"] !==
      String(workspace.conversationId) ||
    claim.metadata.annotations["kaeno.io/workspace"] !== workspace.key ||
    (workspace.uid !== null && claim.metadata.uid !== workspace.uid) ||
    claim.spec.accessModes.length !== 1 ||
    claim.spec.accessModes[0] !== "ReadWriteOnce" ||
    claim.spec.volumeMode !== "Filesystem"
  ) {
    throw new Error(
      `Kubernetes workspace identity mismatch for ${workspace.claim}; refusing to adopt or delete`,
    );
  }
}
