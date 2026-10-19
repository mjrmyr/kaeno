// Real Docker suite. Deliberately separate from the fast Node-only verify command.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { DockerSandboxProvider } from "../src/extensions/docker/index.ts";
import { RemoteExecutionEnv } from "../src/extensions/execution/index.ts";

// Never follow a developer's remote Docker context into a homelab.
// Rootless/Desktop users may explicitly select another local Unix socket.
const dockerHost = process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock";
process.env.DOCKER_HOST = dockerHost;
delete process.env.DOCKER_CONTEXT;
const execute = promisify(execFile);
const id = `smoke-${Date.now()}-${randomBytes(4).toString("hex")}`;
const namespace = randomBytes(8).toString("hex");
const image = `kaeno-test:${id}`;
const host = `kaeno-host-${id}`;
const volume = `kaeno-data-${id}`;
const artifacts = resolve(
  process.env.KAENO_TEST_ARTIFACTS ?? "artifacts",
  `docker-${id}`,
);
const keep = process.argv.includes("--keep");
if (process.argv.slice(2).some((arg) => arg !== "--keep")) {
  throw new Error("Usage: npm run test:docker -- [--keep]");
}
await mkdir(artifacts, { recursive: true });
console.log(`Docker diagnostics: ${artifacts}`);
// SQLite contains disposable sandbox tokens; never put it in uploaded diagnostics.
const state = await mkdtemp(join(tmpdir(), `kaeno-docker-${id}-`));
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => abort.abort(new Error(`Interrupted: ${signal}`)));
}
function redact(text: string): string {
  return text
    .replace(/KAENO_ENV_TOKEN=[^\s"',]+/g, "KAENO_ENV_TOKEN=[REDACTED]")
    .replace(/Bearer [A-Za-z0-9._~-]+/g, "Bearer [REDACTED]");
}
const passed: string[] = [];
let failure: unknown;
let daemonReady = false;
async function run(
  command: string,
  args: string[],
  options: {
    cleanup?: boolean;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<string> {
  const execution = execute(command, args, {
    timeout: options.timeout ?? 120_000,
    maxBuffer: 16 * 1024 * 1024,
    signal: options.cleanup ? undefined : abort.signal,
    env: options.env ?? process.env,
  });
  try {
    const result = await execution;
    await appendFile(
      resolve(artifacts, "commands.log"),
      redact(`${command} ${args[0] ?? ""}\n${result.stdout}${result.stderr}\n`),
    );
    return result.stdout.trim();
  } catch (error) {
    // Abort rejects execFile before the child necessarily exits. Do not race cleanup
    // against a driver still capable of creating a worker.
    const child = execution.child;
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          done();
        }, 5_000);
        child.once("close", () => {
          clearTimeout(timer);
          done();
        });
      });
    }
    // Log process output, not environment/config or inspect's secret-bearing Config.Env.
    const stdout =
      error instanceof Error && "stdout" in error ? String(error.stdout) : "";
    const stderr =
      error instanceof Error && "stderr" in error ? String(error.stderr) : "";
    await appendFile(
      resolve(artifacts, "commands.log"),
      redact(`${command} ${args[0] ?? ""} FAILED\n${stdout}${stderr}\n`),
    );
    throw error;
  }
}
const docker = (...args: string[]) => run("docker", args);
async function poll(
  check: () => Promise<boolean>,
  label: string,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    abort.signal.throwIfAborted();
    if (await check()) {
      return;
    }
    await delay(200, undefined, { signal: abort.signal });
  }
  throw new Error(`Timed out: ${label}`);
}
async function ownedContainers(): Promise<string[]> {
  const names = await run("docker", ["ps", "-a", "--format", "{{.Names}}"], {
    cleanup: true,
  });
  return names
    .split("\n")
    .filter(
      (name) => name === host || name.startsWith(`kaeno-work-${namespace}-`),
    );
}
async function ownedVolumes(): Promise<string[]> {
  const names = await run("docker", ["volume", "ls", "--format", "{{.Name}}"], {
    cleanup: true,
  });
  return names
    .split("\n")
    .filter(
      (name) =>
        name === volume || name.startsWith(`kaeno-workspace-${namespace}-`),
    );
}
function provider(): DockerSandboxProvider {
  return new DockerSandboxProvider({
    namespace,
    createEnvironment: ({ url, token, id, cwd, fetch }) =>
      new RemoteExecutionEnv(url, token, id, cwd, fetch),
  });
}
try {
  if (!dockerHost.startsWith("unix:///")) {
    throw new Error(
      "Infrastructure suites require a local Unix Docker socket (DOCKER_HOST=unix:///...). Remote Docker daemons are not supported.",
    );
  }

  try {
    await docker("info", "--format", "{{.ServerVersion}}");
  } catch (error) {
    throw new Error(
      "test:docker requires the Docker CLI and an accessible local test Docker daemon. No suite was skipped.",
      { cause: error },
    );
  }
  daemonReady = true;
  await run("docker", ["build", "--tag", image, "."], { timeout: 600_000 });
  const imageId = await docker(
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    image,
  );
  await writeFile(resolve(artifacts, "image.txt"), `${image}\n${imageId}\n`);
  passed.push("current Dockerfile built with unique tag");

  // Exercise the unmodified image CMD, not just a test-only runner.
  await docker("volume", "create", volume);
  await docker(
    "run",
    "-d",
    "--name",
    host,
    "--publish",
    "127.0.0.1::8080",
    "--mount",
    `type=volume,src=${volume},dst=/data`,
    "--mount",
    `type=bind,src=${resolve("scripts/fixtures/infrastructure")},dst=/fixture,readonly`,
    "--env",
    "KAENO_CONFIG=/fixture/environment.json",
    "--env",
    "KAENO_SOURCE_MODE=refresh",
    image,
  );
  assert.equal(
    await docker("inspect", "--format", "{{.Image}}", host),
    imageId,
  );
  const published = await docker("port", host, "8080/tcp");
  const url = `http://${published.split("\n")[0]}`;
  await poll(async () => {
    assert.equal(
      await docker("inspect", "--format", "{{.State.Running}}", host),
      "true",
      "normal image entrypoint exited",
    );
    return fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2_000) }).then(
      (response) => response.ok,
      () => false,
    );
  }, "normal host API readiness");
  assert.equal(
    (await fetch(`${url}/v1/threads`, { signal: AbortSignal.timeout(5_000) }))
      .status,
    200,
  );
  // Creating a conversation through read-only replies does not call any model.
  const replies = await fetch(`${url}/v1/threads/durable-smoke/replies`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(replies.status, 200);
  const before = await (
    await fetch(`${url}/v1/threads`, { signal: AbortSignal.timeout(5_000) })
  ).text();
  await docker("exec", host, "test", "-s", "/data/kaeno.sqlite");
  await docker("restart", "--time", "10", host);
  await poll(
    async () =>
      fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2_000) }).then(
        (response) => response.ok,
        () => false,
      ),
    "restarted host API",
  );
  assert.equal(
    await (
      await fetch(`${url}/v1/threads`, { signal: AbortSignal.timeout(5_000) })
    ).text(),
    before,
  );
  passed.push(
    "normal image entrypoint/config/API and durable host restart without model credentials",
  );

  // Reuse the established deterministic faux driver; shell, transport, SQLite and Docker are real.
  await run(process.execPath, ["scripts/work-smoke.ts"], {
    timeout: 180_000,
    env: {
      ...process.env,
      KAENO_SANDBOX_IMAGE: image,
      KAENO_SANDBOX_NAMESPACE: namespace,
      KAENO_SMOKE_DIRECTORY: join(state, "core"),
      KAENO_KUBERNETES_CONFIG: "",
      KAENO_SMOKE_OBSERVE_GATE: "",
    },
  });
  await poll(
    async () => !(await ownedContainers()).some((name) => name !== host),
    "completed worker container removal",
  );
  assert.deepEqual(
    (await ownedVolumes()).filter((name) => name !== volume),
    [],
    "completed worker volume leaked",
  );
  passed.push(
    "worker shell/file roundtrip, parent report, SQLite reopen, container and volume removal",
  );

  // A new provider adopts the same live identity and workspace rather than duplicating it.
  const sandbox = {
    id: "adoption",
    token: randomBytes(32).toString("hex"),
    image,
  };
  const options = {
    cwd: "/workspace",
    limits: { cpus: 1, memoryBytes: 536870912 },
  };
  await provider().ensure(sandbox, options, abort.signal);
  const name = `kaeno-work-${namespace}-adoption`;
  const original = await docker("inspect", "--format", "{{.Id}}", name);
  assert.equal(
    await docker("inspect", "--format", "{{.Image}}", name),
    imageId,
  );
  await docker(
    "exec",
    name,
    "sh",
    "-c",
    "printf durable > /workspace/adoption.txt",
  );
  await provider().ensure(sandbox, options, abort.signal);
  assert.equal(await docker("inspect", "--format", "{{.Id}}", name), original);
  assert.equal(
    await docker("exec", name, "cat", "/workspace/adoption.txt"),
    "durable",
  );
  assert.equal(
    (await ownedContainers()).filter((item) => item !== host).length,
    1,
  );
  await provider().remove(sandbox);
  await provider().remove(sandbox);
  passed.push(
    "provider re-instantiation adopts one live container/workspace; repeated removal is idempotent",
  );
} catch (error) {
  failure = error;
  console.error(redact(error instanceof Error ? error.message : String(error)));
} finally {
  try {
    const containers = daemonReady ? await ownedContainers() : [];
    for (const container of containers) {
      await run("docker", ["logs", container], { cleanup: true }).catch(
        () => undefined,
      );
      await run(
        "docker",
        ["inspect", "--format", "{{json .State}}", container],
        { cleanup: true },
      );
    }
    if (daemonReady && !(failure && keep)) {
      for (const container of containers) {
        await run("docker", ["rm", "-f", "-v", container], { cleanup: true });
      }
      for (const owned of await ownedVolumes()) {
        await run("docker", ["volume", "rm", owned], { cleanup: true });
      }
      assert.deepEqual(
        await ownedContainers(),
        [],
        "container leak after cleanup",
      );
      assert.deepEqual(await ownedVolumes(), [], "volume leak after cleanup");
      // A failed build may not have created an image at all.
      const exists = await run("docker", ["image", "ls", "-q", image], {
        cleanup: true,
      });
      if (exists) {
        await run("docker", ["image", "rm", image], { cleanup: true });
      }
    } else if (failure && keep) {
      console.error(
        `Retained failed environment: host=${host}, namespace=${namespace}, image=${image}, volume=${volume}, state=${state}`,
      );
    }
  } catch (error) {
    failure ??= error;
    console.error(
      "Diagnostics/cleanup failed (or Docker is unavailable):",
      redact(error instanceof Error ? error.message : String(error)),
    );
  }
  if (!(failure && keep)) {
    await rm(state, { recursive: true, force: true });
  }
  let errorMessage: string | undefined;
  if (failure) {
    errorMessage = redact(
      failure instanceof Error ? failure.message : String(failure),
    );
  }
  await writeFile(
    resolve(artifacts, "results.json"),
    JSON.stringify(
      {
        suite: "docker",
        id,
        image,
        namespace,
        passed,
        status: failure ? "failed" : "passed",
        kept: Boolean(failure && keep),
        error: errorMessage,
      },
      null,
      2,
    ),
  );
}
if (failure) {
  process.exitCode = 1;
} else {
  console.log(`PASS Docker: ${passed.length} checks; ${artifacts}`);
}
