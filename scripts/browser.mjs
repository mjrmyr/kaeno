import { chromium } from "playwright";

/**
 * Launch the image's pinned Chromium, never a workspace-installed browser.
 * @returns {Promise<import('playwright').Browser>}
 */
export async function launchChromium() {
  const executablePath = chromium.executablePath();
  if (!executablePath.startsWith("/opt/playwright/")) {
    throw new Error(
      "Browser image required: PLAYWRIGHT_BROWSERS_PATH must be /opt/playwright",
    );
  }
  return chromium.launch({
    executablePath,
    headless: true,
    chromiumSandbox: true,
    timeout: 30_000,
    // Deliberately fixed, not copied from process.env: provider/envd tokens,
    // proxy credentials, NODE_OPTIONS and loader variables must not reach Chromium.
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: "/tmp",
      TMPDIR: "/tmp",
      LANG: "C.UTF-8",
      PLAYWRIGHT_BROWSERS_PATH: "/opt/playwright",
    },
  });
}
