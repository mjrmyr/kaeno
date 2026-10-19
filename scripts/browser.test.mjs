import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { chromium } from "playwright";
import { launchChromium } from "./browser.mjs";

// No browser download needed: inspect the actual Playwright launch boundary.
test("zero-argument launcher enables sandbox and uses only fixed child environment", async (t) => {
  const executablePath = "/opt/playwright/chromium-1234/chrome-linux64/chrome";
  const browser = { close: async () => {} };
  t.mock.method(chromium, "executablePath", () => executablePath);
  const launch = t.mock.method(chromium, "launch", async () => browser);
  const untrusted = {
    KAENO_ENV_TOKEN: "test-envd-token",
    OPENAI_API_KEY: "test-provider-token",
    HTTPS_PROXY: "http://test:secret@proxy.invalid",
    LD_PRELOAD: "/tmp/untrusted.so",
    NODE_OPTIONS: "--require=/tmp/untrusted.js",
    HOME: "/secret/home",
    PATH: "/untrusted/bin",
    TMPDIR: "/secret/tmp",
  };
  for (const [key, value] of Object.entries(untrusted)) {
    const original = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    });
  }
  assert.equal(launchChromium.length, 0);
  assert.equal(await launchChromium(), browser);
  assert.deepEqual(launch.mock.calls[0].arguments, [
    {
      executablePath,
      headless: true,
      chromiumSandbox: true,
      timeout: 30_000,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: "/tmp",
        TMPDIR: "/tmp",
        LANG: "C.UTF-8",
        PLAYWRIGHT_BROWSERS_PATH: "/opt/playwright",
      },
    },
  ]);
});

test("rejects browser paths outside the image instead of using a workspace browser", async (t) => {
  t.mock.method(chromium, "executablePath", () => "/workspace/browser/chrome");
  const launch = t.mock.method(chromium, "launch");
  await assert.rejects(launchChromium(), /Browser image required/);
  assert.equal(launch.mock.callCount(), 0);
});

test.afterEach(() => mock.restoreAll());

test("CI seccomp retains the pinned Docker deny-by-default policy plus only Chromium namespace and chroot exceptions", async () => {
  const { readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { browserSeccompProfile } = await import("./browser-seccomp.mjs");
  const baseline = readFileSync(
    new URL("../.github/seccomp/docker-default-v28.0.0.json", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(baseline).digest("hex"),
    "9c1025c88ccaa517b648da571961838744ea2137f176bfe6a48b21294cae9c76",
  );
  const profile = browserSeccompProfile();
  assert.equal(profile.defaultAction, "SCMP_ACT_ERRNO");
  assert.deepEqual(profile.syscalls.pop(), {
    names: ["chroot"],
    action: "SCMP_ACT_ALLOW",
    comment: "Allow Chromium filesystem isolation inside its user namespace",
  });
  assert.deepEqual(profile.syscalls.pop(), {
    names: ["clone", "setns", "unshare"],
    action: "SCMP_ACT_ALLOW",
    comment:
      "Allow Chromium to establish its unprivileged user namespace sandbox",
  });
  assert.deepEqual(profile, JSON.parse(baseline));
});
