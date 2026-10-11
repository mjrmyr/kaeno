// Minimal in-cluster Kubernetes client (plain fetch + ServiceAccount token) and the sandbox pod spec.
import { readFile } from "node:fs/promises";
import { SKILL_ROOT, type SandboxImages, type SkillCopySelection } from "./skills.ts";

const SA = "/var/run/secrets/kubernetes.io/serviceaccount";
const API = "https://kubernetes.default.svc";

export const namespace = (await readFile(`${SA}/namespace`, "utf8").catch(() => "kaeno")).trim();

async function call(method: string, path: string, body?: unknown) {
  const token = (await readFile(process.env.KUBERNETES_TOKEN_FILE ?? `${SA}/token`, "utf8")).trim(); // re-read: projected tokens rotate
  const response = await fetch((process.env.KUBERNETES_API ?? API) + path, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 404) return undefined;
  const payload = await response.text();
  if (response.status === 409 && method === "POST") return { alreadyExists: true };
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${payload.slice(0, 300)}`);
  return JSON.parse(payload);
}

const pods = `/api/v1/namespaces/${namespace}/pods`;
export const SANDBOX_LABEL = "app.kubernetes.io/name=kaeno-sandbox";

export const getPod = (name: string) => call("GET", `${pods}/${name}`);
export const createPod = (pod: unknown) => call("POST", pods, pod); // 409 → { alreadyExists } (idempotent)
export const deletePod = (name: string) => call("DELETE", `${pods}/${name}?gracePeriodSeconds=5`);
export const listSandboxPods = async () => ((await call("GET", `${pods}?labelSelector=${encodeURIComponent(SANDBOX_LABEL)}`))?.items ?? []) as any[];

export const isReady = (pod: any) => pod?.status?.conditions?.some((c: any) => c.type === "Ready" && c.status === "True") ?? false;
export const failedReason = (pod: any): string | undefined => {
  if (pod?.status?.phase === "Failed" || pod?.status?.phase === "Succeeded") return `pod ${pod.status.phase}: ${pod.status.reason ?? ""}`;
  for (const status of [...(pod?.status?.initContainerStatuses ?? []), ...(pod?.status?.containerStatuses ?? [])]) {
    const ended = status.state?.terminated;
    if (ended?.exitCode && status.name === "skills") return `skills init exited ${ended.exitCode}: ${ended.message ?? ended.reason ?? "copy failed"}`;
    const waiting = status.state?.waiting;
    if (["ErrImagePull", "ImagePullBackOff", "CreateContainerConfigError", "InvalidImageName", "CrashLoopBackOff"].includes(waiting?.reason))
      return `${status.name}: ${waiting.reason}: ${waiting.message ?? ""}`;
  }
  return undefined;
};

export type SandboxInput = { name: string; images: SandboxImages; skills: SkillCopySelection; token: string; conversationId: string; taskId: string; template: string };

// The model never shapes this spec. A sandbox is an isolated pod: own emptyDir workspace and home, no Kubernetes
// credentials, read-only root filesystem, non-root, internet egress only (see NetworkPolicy), and the GitHub deploy key.
export function sandboxPod(o: SandboxInput) {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: o.name,
      namespace,
      labels: { "app.kubernetes.io/name": "kaeno-sandbox", "kaeno.io/template": o.template },
      annotations: { "kaeno.io/conversation": o.conversationId, "kaeno.io/task": o.taskId },
    },
    spec: {
      hostname: o.name,
      subdomain: "kaeno-sandbox", // DNS: <name>.kaeno-sandbox.<ns>.svc via the headless Service
      restartPolicy: "Never",
      activeDeadlineSeconds: 4 * 3600, // backstop: a leaked sandbox dies on its own
      serviceAccountName: "kaeno-sandbox",
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      securityContext: { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, fsGroup: 10001, seccompProfile: { type: "RuntimeDefault" } },
      ...(o.skills.length ? { initContainers: [{
        name: "skills", image: o.images.skillSource, imagePullPolicy: "IfNotPresent",
        command: ["node", "/app/src/materialize-skills.ts"],
        env: [{ name: "KAENO_SKILL_PLAN", value: JSON.stringify(o.skills) }],
        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
        resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
        volumeMounts: [{ name: "skills", mountPath: "/skills-out" }],
        terminationMessagePolicy: "FallbackToLogsOnError",
      }] } : {}),
      containers: [{
        name: "envd",
        image: o.images.execution,
        imagePullPolicy: "IfNotPresent",
        command: ["node", "/app/src/envd.ts"],
        workingDir: "/workspace",
        env: [
          { name: "KAENO_ENV_TOKEN", value: o.token },
          { name: "HOME", value: "/home/agent" },
          { name: "TMPDIR", value: "/tmp" },
          { name: "GIT_AUTHOR_NAME", value: "kaeno" }, { name: "GIT_AUTHOR_EMAIL", value: "kaeno@homelab" },
          { name: "GIT_COMMITTER_NAME", value: "kaeno" }, { name: "GIT_COMMITTER_EMAIL", value: "kaeno@homelab" },
        ],
        ports: [{ name: "envd", containerPort: 7070 }],
        readinessProbe: { httpGet: { path: "/healthz", port: "envd" }, periodSeconds: 2 },
        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
        resources: { requests: { cpu: "250m", memory: "256Mi" }, limits: { cpu: "2", memory: "2Gi" } },
        volumeMounts: [
          { name: "workspace", mountPath: "/workspace" },
          { name: "skills", mountPath: SKILL_ROOT, readOnly: true },
          { name: "home", mountPath: "/home/agent" },
          { name: "tmp", mountPath: "/tmp" },
          { name: "github-ssh", mountPath: "/etc/kaeno/ssh", readOnly: true },
        ],
      }],
      volumes: [
        { name: "workspace", emptyDir: { sizeLimit: "5Gi" } },
        { name: "skills", emptyDir: { sizeLimit: "256Mi" } },
        { name: "home", emptyDir: { sizeLimit: "1Gi" } },
        { name: "tmp", emptyDir: { sizeLimit: "2Gi" } },
        { name: "github-ssh", secret: { secretName: "kaeno-github-ssh", optional: true, defaultMode: 0o440 } },
      ],
    },
  };
}
