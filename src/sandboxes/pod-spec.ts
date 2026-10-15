import {
  SKILL_ROOT,
  type SandboxImages,
  type SkillCopySelection,
} from "../skills/index.ts";
export interface SandboxInput {
  name: string;
  images: SandboxImages;
  skillCacheClaim: string;
  skills: SkillCopySelection;
  token: string;
  conversationId: string;
  taskId: string;
  template: string;
}
export interface PodEnvironmentVariable {
  name: string;
  value?: string;
  valueFrom?: {
    secretKeyRef: { name: string; key: string; optional: boolean };
  };
}
export interface PodVolumeMount {
  name: string;
  mountPath: string;
  readOnly?: boolean;
}
export interface ContainerSecurity {
  allowPrivilegeEscalation: boolean;
  readOnlyRootFilesystem: boolean;
  capabilities: { drop: string[] };
}
export interface ContainerResources {
  requests: { cpu: string; memory: string };
  limits: { cpu: string; memory: string };
}
export interface PodContainer {
  name: string;
  image: string;
  imagePullPolicy: string;
  command: string[];
  workingDir?: string;
  env: PodEnvironmentVariable[];
  securityContext: ContainerSecurity;
  resources: ContainerResources;
  volumeMounts: PodVolumeMount[];
  ports?: { name: string; containerPort: number }[];
  readinessProbe?: {
    httpGet: { path: string; port: string };
    periodSeconds: number;
  };
  terminationMessagePolicy?: string;
}
export interface PodVolume {
  name: string;
  emptyDir?: { sizeLimit: string };
  persistentVolumeClaim?: { claimName: string; readOnly: boolean };
  secret?: { secretName: string; optional: boolean; defaultMode: number };
}
export interface SandboxPodManifest {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
    annotations: Record<string, string>;
  };
  spec: {
    containers: PodContainer[];
    initContainers?: PodContainer[];
    volumes: PodVolume[];
    hostname: string;
    subdomain: string;
    restartPolicy: string;
    activeDeadlineSeconds: number;
    serviceAccountName: string;
    automountServiceAccountToken: boolean;
    enableServiceLinks: boolean;
    securityContext: {
      runAsNonRoot: boolean;
      runAsUser: number;
      runAsGroup: number;
      fsGroup: number;
      seccompProfile: { type: string };
    };
  };
}

function skillInitContainers(options: SandboxInput): PodContainer[] {
  if (!options.skills.length) {
    return [];
  }
  const volumeMounts: PodVolumeMount[] = [
    { name: "skills", mountPath: "/skills-out" },
  ];
  if (!options.images.skillSource) {
    volumeMounts.push({
      name: "skill-cache",
      mountPath: "/skill-cache",
      readOnly: true,
    });
  }
  return [
    {
      name: "skills",
      image: options.images.skillSource ?? options.images.execution,
      imagePullPolicy: "IfNotPresent",
      command: ["node", "/app/src/materialize-skills.ts"],
      env: [
        { name: "KAENO_SKILL_PLAN", value: JSON.stringify(options.skills) },
      ],
      securityContext: {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"] },
      },
      resources: {
        requests: { cpu: "50m", memory: "64Mi" },
        limits: { cpu: "500m", memory: "256Mi" },
      },
      volumeMounts,
      terminationMessagePolicy: "FallbackToLogsOnError",
    },
  ];
}
// The model never shapes this spec. A sandbox is an isolated pod: own emptyDir workspace and home, no Kubernetes
// credentials, read-only root filesystem, non-root, internet egress only (see NetworkPolicy), and scoped GitHub credentials.
export function sandboxPod(
  options: SandboxInput,
  namespace = "kaeno",
): SandboxPodManifest {
  const initContainers = skillInitContainers(options);
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: options.name,
      namespace,
      labels: {
        "app.kubernetes.io/name": "kaeno-sandbox",
        "kaeno.io/template": options.template,
      },
      annotations: {
        "kaeno.io/conversation": options.conversationId,
        "kaeno.io/task": options.taskId,
      },
    },
    spec: {
      hostname: options.name,
      subdomain: "kaeno-sandbox", // DNS: <name>.kaeno-sandbox.<ns>.svc via the headless Service
      restartPolicy: "Never",
      activeDeadlineSeconds: 4 * 3600, // backstop: a leaked sandbox dies on its own
      serviceAccountName: "kaeno-sandbox",
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 10001,
        runAsGroup: 10001,
        fsGroup: 10001,
        seccompProfile: { type: "RuntimeDefault" },
      },
      ...(initContainers.length ? { initContainers } : {}),
      containers: [
        {
          name: "envd",
          image: options.images.execution,
          imagePullPolicy: "IfNotPresent",
          command: ["node", "/app/src/envd.ts"],
          workingDir: "/workspace",
          env: [
            { name: "KAENO_ENV_TOKEN", value: options.token },
            { name: "HOME", value: "/home/agent" },
            { name: "TMPDIR", value: "/tmp" },
            { name: "GH_PROMPT_DISABLED", value: "1" },
            {
              name: "GH_TOKEN",
              valueFrom: {
                secretKeyRef: {
                  name: "kaeno-github-api",
                  key: "token",
                  optional: true,
                },
              },
            },
            { name: "GIT_AUTHOR_NAME", value: "kaeno" },
            { name: "GIT_AUTHOR_EMAIL", value: "kaeno@homelab" },
            { name: "GIT_COMMITTER_NAME", value: "kaeno" },
            { name: "GIT_COMMITTER_EMAIL", value: "kaeno@homelab" },
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
          resources: {
            requests: { cpu: "250m", memory: "256Mi" },
            limits: { cpu: "2", memory: "2Gi" },
          },
          volumeMounts: [
            { name: "workspace", mountPath: "/workspace" },
            { name: "skills", mountPath: SKILL_ROOT, readOnly: true },
            { name: "home", mountPath: "/home/agent" },
            { name: "tmp", mountPath: "/tmp" },
            { name: "github-ssh", mountPath: "/etc/kaeno/ssh", readOnly: true },
          ],
        },
      ],
      volumes: [
        { name: "workspace", emptyDir: { sizeLimit: "5Gi" } },
        { name: "skills", emptyDir: { sizeLimit: "256Mi" } },
        ...(options.skills.length && !options.images.skillSource
          ? [
              {
                name: "skill-cache",
                persistentVolumeClaim: {
                  claimName: options.skillCacheClaim,
                  readOnly: true,
                },
              },
            ]
          : []),
        { name: "home", emptyDir: { sizeLimit: "1Gi" } },
        { name: "tmp", emptyDir: { sizeLimit: "2Gi" } },
        {
          name: "github-ssh",
          secret: {
            secretName: "kaeno-github-ssh",
            optional: true,
            defaultMode: 0o440,
          },
        },
      ],
    },
  };
}
