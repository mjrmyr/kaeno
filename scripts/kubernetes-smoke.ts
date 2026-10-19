/** Disposable kind test. Every kubectl call is bound to a private kubeconfig/context. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseAllDocuments } from "yaml";
import { z } from "zod";

// Do not follow a developer Docker context to a remote or live daemon.
const dockerHost = process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock";
process.env.DOCKER_HOST = dockerHost;
delete process.env.DOCKER_CONTEXT;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.slice(2).includes("--keep");
if (process.argv.slice(2).some((arg) => arg !== "--keep")) {
  throw new Error("Usage: npm run test:kubernetes -- [--keep]");
}
const id = `kaeno-smoke-${randomBytes(6).toString("hex")}`;
const context = `kind-${id}`;
const image = `kaeno-kubernetes-smoke:${id}`;
const nodeImage = "kindest/node:v1.32.2";
const namespace = "kaeno";
const artifacts = resolve(
  process.env.KAENO_TEST_ARTIFACTS ?? "artifacts",
  `kubernetes-${id}`,
);
await mkdir(artifacts, { recursive: true });
console.log(`Kubernetes diagnostics: ${artifacts}`);
const passed: string[] = [];
let failureMessage: string | undefined;
let daemonReady = false;
function redact(text: string): string {
  return text
    .replace(/KAENO_ENV_TOKEN[=:]\s*[^\s"',]+/g, "KAENO_ENV_TOKEN=[REDACTED]")
    .replace(/Bearer [A-Za-z0-9._~-]+/g, "Bearer [REDACTED]");
}
const directory = await mkdtemp(join(tmpdir(), `${id}-`));
const kubeconfig = join(directory, "kubeconfig");
const controller = new AbortController();
let clusterAttempted = false;
let failed = true;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    interrupted = true;
    controller.abort(new Error(`Interrupted by ${signal}`));
  });
}

async function run(
  command: string,
  args: string[],
  options: {
    input?: string;
    timeout?: number;
    cleanup?: boolean;
    allowedCodes?: number[];
    privateOutput?: boolean;
  } = {},
): Promise<string> {
  const signal = options.cleanup ? undefined : controller.signal;
  signal?.throwIfAborted();
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, KUBECONFIG: kubeconfig },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      errors += chunk;
    });
    let stopped = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      stopped = true;
      child.kill("SIGTERM");
      forceKill ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    const timer = setTimeout(stop, options.timeout ?? 60_000);
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      signal?.removeEventListener("abort", stop);
      reject(error);
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      clearTimeout(forceKill);
      signal?.removeEventListener("abort", stop);
      try {
        await appendFile(
          join(artifacts, "commands.log"),
          redact(
            `${command} ${args[0] ?? ""} status=${code}\n${options.privateOutput ? "[private output omitted]" : output}${errors}\n`,
          ),
        );
      } catch (error) {
        reject(error);
        return;
      }
      if (
        code !== null &&
        (options.allowedCodes ?? [0]).includes(code) &&
        !stopped
      ) {
        resolveResult(output.trim());
      } else {
        reject(
          new Error(
            `${command} ${args.slice(0, 3).join(" ")} failed (${stopped ? "timeout/interrupted" : code}): ${redact(errors.trim())}`,
          ),
        );
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}
function kubectl(args: string[], options: Parameters<typeof run>[2] = {}) {
  return run(
    "kubectl",
    [
      "--kubeconfig",
      kubeconfig,
      "--context",
      context,
      "--request-timeout=20s",
      "-n",
      namespace,
      ...args,
    ],
    options,
  );
}
async function apply(objects: unknown[]) {
  await kubectl(["apply", "-f", "-"], {
    input: objects.map((value) => JSON.stringify(value)).join("\n---\n"),
  });
}
async function until(
  description: string,
  timeout: number,
  check: () => Promise<boolean>,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    controller.signal.throwIfAborted();
    if (await check()) {
      return;
    }
    await delay(200, undefined, { signal: controller.signal });
  }
  throw new Error(`Timed out waiting for ${description}`);
}
function pvc(name: string) {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: "1Gi" } },
    },
  };
}
function pod(name: string, owner: string, driver: boolean) {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, labels: { "app.kubernetes.io/name": "kaeno" } },
    spec: {
      serviceAccountName: "kaeno-kubernetes-host",
      restartPolicy: "Never",
      securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
      containers: [
        {
          name: "host",
          image,
          imagePullPolicy: "Never",
          ...(driver
            ? { command: ["node", "/app/scripts/work-smoke.ts"] }
            : {}),
          env: [
            { name: "KAENO_CONFIG", value: "/fixture/environment.json" },
            { name: "KAENO_SOURCE_MODE", value: "refresh" },
            {
              name: "KAENO_KUBERNETES_CONFIG",
              value: `/configuration/${owner}.json`,
            },
            { name: "KAENO_SMOKE_DIRECTORY", value: "/data/smoke" },
            ...(driver
              ? [
                  {
                    name: "KAENO_SMOKE_OBSERVE_GATE",
                    value: "/data/worker-observed",
                  },
                ]
              : []),
            { name: "KAENO_SANDBOX_NAMESPACE", value: owner },
            { name: "KAENO_AUTH_FILE", value: "/data/auth.json" },
            { name: "KAENO_DB", value: "/data/kaeno.sqlite" },
          ],
          ...(driver
            ? {}
            : {
                readinessProbe: {
                  httpGet: { path: "/healthz", port: 8080 },
                  periodSeconds: 1,
                },
              }),
          volumeMounts: [
            { name: "storage", mountPath: "/data" },
            {
              name: "configuration",
              mountPath: "/configuration",
              readOnly: true,
            },
            // ConfigMap directory projections use symlinks. Local definitions reject links;
            // individual subPath mounts expose regular files in real parent directories.
            {
              name: "fixture",
              mountPath: "/fixture/environment.json",
              subPath: "environment.json",
              readOnly: true,
            },
            {
              name: "fixture",
              mountPath: "/fixture/agents/host/AGENT.md",
              subPath: "agents/host/AGENT.md",
              readOnly: true,
            },
            ...(driver
              ? // A directory projection also changes Node's realpath/import base for this entrypoint.
                [
                  {
                    name: "driver",
                    mountPath: "/app/scripts/work-smoke.ts",
                    subPath: "work-smoke.ts",
                    readOnly: true,
                  },
                ]
              : []),
          ],
        },
      ],
      volumes: [
        { name: "storage", persistentVolumeClaim: { claimName: name } },
        { name: "configuration", configMap: { name: "configuration" } },
        {
          name: "fixture",
          configMap: {
            name: "fixture",
            items: [
              { key: "environment.json", path: "environment.json" },
              { key: "AGENT.md", path: "agents/host/AGENT.md" },
            ],
          },
        },
        ...(driver ? [{ name: "driver", configMap: { name: "driver" } }] : []),
      ],
    },
  };
}

try {
  if (!dockerHost.startsWith("unix:///")) {
    throw new Error("Kubernetes smoke requires a local unix:// Docker daemon");
  }

  for (const [command, args] of [
    ["docker", ["info"]],
    ["kind", ["version"]],
    ["kubectl", ["version", "--client=true"]],
  ] as const) {
    try {
      await run(command, [...args]);
    } catch (error) {
      throw new Error(
        `test:kubernetes requires Docker CLI/local daemon, kind v0.27.0 and kubectl v1.32.2; ${command} prerequisite failed. No suite was skipped.`,
        { cause: error },
      );
    }
    if (command === "docker") {
      daemonReady = true;
    }
  }
  console.log(`Disposable cluster ${id}; node ${nodeImage}; image ${image}`);
  console.log(
    "NetworkPolicy enforcement assertions DEFERRED: default kind CNI is not an enforcing CNI. This suite does not prove network isolation.",
  );
  await run("docker", ["build", "--tag", image, "."], { timeout: 600_000 });
  const imageId = await run("docker", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    image,
  ]);
  await writeFile(
    join(artifacts, "image.txt"),
    `${image}\n${imageId}\nnode=${nodeImage}\n`,
  );
  passed.push("current Dockerfile built with unique local image");
  clusterAttempted = true;
  await run(
    "kind",
    [
      "create",
      "cluster",
      "--name",
      id,
      "--image",
      nodeImage,
      "--kubeconfig",
      kubeconfig,
      "--wait",
      "180s",
    ],
    { timeout: 240_000 },
  );
  await run("kind", ["load", "docker-image", image, "--name", id], {
    timeout: 180_000,
  });
  await kubectl(["create", "namespace", namespace]);
  const prerequisites = parseAllDocuments(
    await readFile(
      join(root, "src/extensions/kubernetes/cluster.yaml"),
      "utf8",
    ),
  ).map((doc) => {
    if (doc.errors.length) {
      throw doc.errors[0];
    }
    return doc.toJSON();
  });
  await apply(prerequisites);
  const config = (owner: string) =>
    JSON.stringify({
      namespace,
      owner,
      image,
      resources: {
        requests: { cpu: "100m", memory: "128Mi" },
        limits: { cpu: "1", memory: "512Mi" },
      },
      readyTimeoutMs: 180_000,
    });
  await apply([
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "configuration" },
      data: { "host.json": config("host"), "driver.json": config("driver") },
    },
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "fixture" },
      data: {
        "environment.json": await readFile(
          join(root, "scripts/fixtures/infrastructure/environment.json"),
          "utf8",
        ),
        "AGENT.md": await readFile(
          join(root, "scripts/fixtures/infrastructure/agents/host/AGENT.md"),
          "utf8",
        ),
      },
    },
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "driver" },
      data: {
        "work-smoke.ts": await readFile(
          join(root, "scripts/work-smoke.ts"),
          "utf8",
        ),
      },
    },
    pvc("host"),
    pvc("driver"),
    pod("host", "host", false),
  ]);
  await until("normal in-cluster host readiness", 180_000, async () => {
    const ready = await kubectl([
      "get",
      "pod",
      "host",
      "-o",
      'jsonpath={.status.conditions[?(@.type=="Ready")].status}',
    ]);
    return ready === "True";
  });
  // Readiness hits the normal entrypoint, not the deterministic driver's embedded host.
  const hostImage = await kubectl([
    "get",
    "pod",
    "host",
    "-o",
    "jsonpath={.status.containerStatuses[0].imageID}",
  ]);
  if (!hostImage) {
    throw new Error("Host image ID missing");
  }
  console.log(`Normal in-cluster entrypoint Ready: ${hostImage}`);
  await kubectl([
    "exec",
    "host",
    "--",
    "node",
    "--input-type=module",
    "-e",
    `
    import assert from "node:assert/strict";
    import {stat} from "node:fs/promises";
    for (const path of ["/v1/threads", "/v1/threads/durable-smoke/replies"]) {
      const response = await fetch("http://127.0.0.1:8080" + path, {signal: AbortSignal.timeout(5000)});
      assert.equal(response.status, 200);
    }
    assert.ok((await stat("/data/kaeno.sqlite")).size > 0);
    console.log("PASS normal host API and writable SQLite");
  `,
  ]);
  passed.push(
    "normal in-cluster image entrypoint/config/API/service account/writable PVC",
  );
  const hostIdentity = `system:serviceaccount:${namespace}:kaeno-kubernetes-host`;
  const sandboxIdentity = `system:serviceaccount:${namespace}:kaeno-sandbox`;
  for (const [identity, verb, resource, allowed] of [
    [hostIdentity, "create", "pods", true],
    [hostIdentity, "get", "resourcequotas", true],
    [hostIdentity, "get", "secrets", false],
    [hostIdentity, "create", "pods/exec", false],
    [hostIdentity, "patch", "resourcequotas", false],
    [sandboxIdentity, "list", "pods", false],
    [sandboxIdentity, "get", "secrets", false],
  ] as const) {
    const answer = await kubectl(
      ["auth", "can-i", verb, resource, `--as=${identity}`],
      { allowedCodes: [0, 1] },
    );
    if (answer !== (allowed ? "yes" : "no")) {
      throw new Error(
        `Unexpected RBAC decision: ${identity} ${verb} ${resource}`,
      );
    }
  }
  passed.push(
    "namespace-local host/worker RBAC positive and negative decisions",
  );
  await apply([pod("driver", "driver", true)]);
  let observedWorker = false;
  await until("deterministic WORK driver completion", 420_000, async () => {
    // Inspect only safe fields. Never print pod JSON: env contains per-work bearer tokens.
    const workers = z
      .object({
        items: z.array(
          z.object({
            spec: z.object({
              automountServiceAccountToken: z.boolean().optional(),
              serviceAccountName: z.string(),
              volumes: z.array(
                z.object({
                  projected: z.unknown().optional(),
                  secret: z.unknown().optional(),
                }),
              ),
              containers: z.array(z.object({ image: z.string() })),
            }),
          }),
        ),
      })
      .parse(
        JSON.parse(
          await kubectl(
            [
              "get",
              "pods",
              "-l",
              "app.kubernetes.io/name=kaeno-sandbox",
              "-o",
              "json",
            ],
            { privateOutput: true },
          ),
        ),
      );
    for (const worker of workers.items) {
      const spec = worker.spec;
      if (
        spec.automountServiceAccountToken !== false ||
        spec.serviceAccountName !== "kaeno-sandbox" ||
        spec.volumes.some((volume) => volume.projected || volume.secret) ||
        spec.containers.length !== 1 ||
        spec.containers[0]?.image !== image
      ) {
        throw new Error(
          "Worker image/service-account credential isolation assertion failed",
        );
      }
      if (!observedWorker) {
        await kubectl([
          "exec",
          "driver",
          "--",
          "node",
          "-e",
          'require("node:fs").writeFileSync("/data/worker-observed", "observed")',
        ]);
        observedWorker = true;
      }
    }
    const phase = await kubectl([
      "get",
      "pod",
      "driver",
      "-o",
      "jsonpath={.status.phase}",
    ]);
    if (phase === "Failed") {
      throw new Error("Deterministic driver failed");
    }
    return phase === "Succeeded";
  });
  if (!observedWorker) {
    throw new Error(
      "Driver finished without observing a real Kubernetes WORK pod",
    );
  }
  console.log(await kubectl(["logs", "driver"]));
  await until(
    "completed worker pod cleanup",
    30_000,
    async () =>
      (await kubectl([
        "get",
        "pods",
        "-l",
        "app.kubernetes.io/name=kaeno-sandbox",
        "-o",
        "jsonpath={.items[*].metadata.name}",
      ])) === "",
  );
  console.log(
    "PASS: normal host startup, namespace-local RBAC, real WORK pod, credential isolation spec, deterministic tools/report/durable reopen, worker cleanup",
  );
  passed.push(
    "real worker image/no service-account token, shell/file tools, single parent report, SQLite reopen, pod removal",
  );
  failed = false;
} catch (error) {
  failureMessage = redact(
    error instanceof Error ? error.message : String(error),
  );
  console.error(failureMessage);
  process.exitCode = interrupted ? 130 : 1;
} finally {
  // Descriptions are useful, but their environment fields must never expose envd bearer tokens.
  if (clusterAttempted) {
    for (const [name, args] of [
      ["pods", ["get", "pods", "-o", "wide"]],
      ["pod-descriptions", ["describe", "pods"]],
      ["events", ["get", "events", "--sort-by=.lastTimestamp"]],
      ["quota", ["describe", "resourcequota", "kaeno-sandbox"]],
      ["host", ["logs", "host", "--tail=200"]],
      ["driver", ["logs", "driver", "--tail=200"]],
    ] as const) {
      try {
        await writeFile(
          join(artifacts, `${name}.log`),
          redact(await kubectl([...args], { cleanup: true, timeout: 25_000 })),
        );
      } catch (error) {
        await writeFile(
          join(artifacts, `${name}.log`),
          redact(error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }
  if (failed && keep) {
    console.error(
      `Retained failed environment: cluster=${id}; private kubeconfig=${kubeconfig}; context=${context}; image=${image}`,
    );
  } else {
    try {
      if (clusterAttempted) {
        await run(
          "kind",
          ["delete", "cluster", "--name", id, "--kubeconfig", kubeconfig],
          { cleanup: true, timeout: 120_000 },
        );
        const clusters = await run("kind", ["get", "clusters"], {
          cleanup: true,
        });
        assert.equal(
          clusters.split(/\s+/).includes(id),
          false,
          `Cluster leaked: ${id}`,
        );
        const nodes = await run(
          "docker",
          ["ps", "-aq", "--filter", `label=io.x-k8s.kind.cluster=${id}`],
          { cleanup: true },
        );
        assert.equal(nodes, "", `kind node containers leaked for ${id}`);
      }
      if (daemonReady) {
        const exists = await run("docker", ["image", "ls", "-q", image], {
          cleanup: true,
        });
        if (exists) {
          await run("docker", ["image", "rm", image], { cleanup: true });
        }
      }
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      failureMessage = redact(
        error instanceof Error ? error.message : String(error),
      );
      console.error(`Cleanup failed for ${id}: ${failureMessage}`);
      process.exitCode = 1;
      failed = true;
    }
  }
  await writeFile(
    join(artifacts, "results.json"),
    JSON.stringify(
      {
        suite: "kubernetes",
        id,
        context,
        image,
        nodeImage,
        status: failed ? "failed" : "passed",
        kept: failed && keep,
        passed,
        error: failureMessage,
        deferred: [
          "enforcing CNI/network-policy/DNS assertions",
          "quota admission",
          "running-work restart/adoption",
          "cancellation",
        ],
      },
      null,
      2,
    ),
  );
}
