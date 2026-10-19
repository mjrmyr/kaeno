/** Run inside the candidate WORK image/pod, never on the credential-bearing host. */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { BrowserSession } from "../src/extensions/browser/index.ts";

// Read only fixed kernel metadata: no environment dump, credentials, or private network probes.
for (const path of [
  "/proc/self/status",
  "/proc/self/attr/current",
  "/proc/self/uid_map",
  "/proc/sys/kernel/unprivileged_userns_clone",
  "/proc/sys/user/max_user_namespaces",
  "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
]) {
  try {
    let value = await readFile(path, "utf8");
    if (path.endsWith("/status")) {
      value = value
        .split("\n")
        .filter((line) => /^(Uid|Gid|Cap\w*|NoNewPrivs|Seccomp\w*):/.test(line))
        .join("\n");
    }
    console.log(`${path}:\n${value.trim()}`);
  } catch {
    console.log(`${path}: unavailable`);
  }
}
// Each probe is a disposable child. A successful unshare never changes the parent/pod.
// EPERM alone cannot identify seccomp vs LSM vs kernel/namespace prerequisites.
const probe = spawnSync(
  "python3",
  [
    "-c",
    `
import ctypes, errno
libc = ctypes.CDLL(None, use_errno=True)
for name, flags in [("user", 0x10000000), ("user+mount", 0x10020000), ("user+net", 0x50000000)]:
    import os
    pid = os.fork()
    if pid == 0:
        result = libc.unshare(flags)
        error = ctypes.get_errno()
        print(name + ": " + ("allowed" if result == 0 else errno.errorcode.get(error, str(error))), flush=True)
        os._exit(0)
    os.waitpid(pid, 0)
`,
  ],
  { encoding: "utf8", timeout: 5000 },
);
console.log(
  `namespace probes:\n${probe.stdout || probe.error?.message || probe.stderr}`,
);
if (probe.status !== 0) {
  console.log(
    "Namespace probe unavailable; do not infer policy compatibility.",
  );
}

if (!process.argv.includes("--diagnose-only")) {
  const session = new BrowserSession();
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><title>fixture</title><main>loading</main><script>
      ${request.url === "/" ? "window.name = 'kaeno-persisted';" : ""}
      document.querySelector('main').textContent = 'JavaScript ready ' + window.name;
    </script>`);
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing fixture port");
    }
    const call = async (name: string, args = {}) => {
      const result = await session.call({ name, arguments: args });
      if (result.isError) {
        throw new Error(JSON.stringify(result));
      }
      return result;
    };
    const url = `http://127.0.0.1:${address.port}/`;
    await call("browser_navigate", { url });
    await call("browser_navigate", { url: `${url}second` });
    const snapshot = await call("browser_snapshot");
    if (
      !JSON.stringify(snapshot).includes("JavaScript ready kaeno-persisted")
    ) {
      throw new Error(
        "Controlled JavaScript/session persistence assertion failed",
      );
    }
    const screenshot = await call("browser_take_screenshot", { type: "png" });
    if (!screenshot.content.some((block) => block.type === "image")) {
      throw new Error("Missing real screenshot image");
    }
    await call("browser_close");
    console.log(
      "PASS: sandboxed Chromium, controlled JavaScript, navigation persistence, screenshot, close",
    );
  } finally {
    try {
      // Exercise native close even after MCP returned a browser-initialization error.
      await session.call({ name: "browser_close", arguments: {} });
    } finally {
      await session.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}
