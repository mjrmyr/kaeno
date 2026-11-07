import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { Sandbox } from "microsandbox";
import {
  RemoteExecutionEnv,
  type SandboxIdentity,
} from "../src/extensions/execution/index.ts";
import {
  MicrosandboxEngine,
  MicrosandboxSandboxProvider,
} from "../src/extensions/microsandbox/index.ts";

// Real-runtime test: mutate only the randomly namespaced VM created by this script.
const namespace = `smoke-${randomBytes(6).toString("hex")}`;
const name = `kaeno-work-${namespace}-work-recovery`;
const sandbox: SandboxIdentity = {
  id: "work-recovery",
  token: randomBytes(32).toString("hex"),
  image: process.argv[2] ?? "kaeno:local",
};
const engine = new MicrosandboxEngine();
function providerFor() {
  return new MicrosandboxSandboxProvider({
    engine: new MicrosandboxEngine(),
    namespace,
    createEnvironment: ({ url, token, id, cwd, fetch }) =>
      new RemoteExecutionEnv(url, token, id, cwd, fetch),
  });
}
const provider = providerFor();
async function command(
  current: MicrosandboxSandboxProvider,
  script: string,
): Promise<string> {
  const env = await current.executionEnvironment(sandbox, "/workspace");
  let output = "";
  const result = getOrThrow(
    await env.exec(
      script,
      {
        timeout: 30_000,
        onOutput: (text) => {
          output += text;
        },
      },
      BACKGROUND_CONTEXT,
    ),
  );
  assert.equal(result.exitCode, 0, output);
  return output.trim();
}
try {
  const options = {
    cwd: "/workspace",
    limits: { cpus: 1, memoryBytes: 1073741824 },
  };
  await provider.ensure(sandbox, options);
  assert.equal(
    await command(
      provider,
      "echo persistent-workspace > recovery.txt; cat recovery.txt",
    ),
    "persistent-workspace",
  );
  console.log("created VM and wrote workspace file through envd");
  assert.match(
    await command(provider, "node /app/scripts/browser-runtime-smoke.ts"),
    /PASS: Chromium/,
  );
  console.log(
    "guest Chromium navigation, JavaScript persistence and screenshot passed",
  );

  const restarted = providerFor();
  assert.equal(restarted.identity, provider.identity);
  await restarted.ensure(sandbox, options);
  assert.equal(
    await command(restarted, "cat recovery.txt"),
    "persistent-workspace",
  );
  console.log("new provider adopted the running VM and retained workspace");

  await restarted.stop(sandbox);
  assert.equal((await engine.inspect(name))?.running, false);
  await restarted.stop(sandbox);
  console.log("stop halted the VM and is safe to repeat");

  await restarted.reconcile([sandbox]);
  assert.equal((await engine.inspect(name))?.running, false);
  console.log("reconciliation retained a stopped VM it was told to keep");

  await restarted.ensure(sandbox, options);
  assert.equal(
    await command(restarted, "cat recovery.txt"),
    "persistent-workspace",
  );
  console.log("stopped VM rebooted with envd relaunched and workspace intact");

  const guest = await (await Sandbox.get(name)).connect();
  const killed = await guest.exec("python3", [
    "-c",
    [
      "import os, pathlib, signal",
      "count = 0",
      "for proc in pathlib.Path('/proc').glob('[0-9]*'):",
      "    try:",
      "        args = (proc / 'cmdline').read_bytes().split(b'\\0')",
      "        if len(args) > 1 and args[1] == b'/app/src/host/envd.ts':",
      "            os.kill(int(proc.name), signal.SIGKILL)",
      "            count += 1",
      "    except (FileNotFoundError, ProcessLookupError): pass",
      "print(count)",
    ].join("\n"),
  ]);
  assert.equal(killed.code, 0, killed.stderr());
  assert.equal(killed.stdout().trim(), "1");
  await restarted.ensure(sandbox, options);
  assert.equal(
    await command(restarted, "cat recovery.txt"),
    "persistent-workspace",
  );
  console.log("envd crash recovered without replacing the VM or its workspace");

  await restarted.reconcile([sandbox]);
  assert.equal((await engine.inspect(name))?.running, true);
  await restarted.reconcile([]);
  assert.equal(await engine.inspect(name), undefined);
  console.log("reconciliation retained live work and removed the orphan VM");
} finally {
  await provider.remove(sandbox);
  await provider.remove(sandbox);
  assert.equal(await engine.inspect(name), undefined);
}
