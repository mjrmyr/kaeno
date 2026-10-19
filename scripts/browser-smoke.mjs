import assert from "node:assert/strict";
import { launchChromium } from "./browser.mjs";

// Controlled inline content: no external site, server or network access needed.
const browser = await launchChromium();
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  await page.setContent(`<!doctype html>
    <title>Kaeno browser smoke</title>
    <main id="result">JavaScript has not run</main>
    <script>
      document.querySelector('#result').textContent = 'JavaScript rendered';
      document.querySelector('#result').dataset.ready = 'true';
    </script>`);
  await page.locator('#result[data-ready="true"]').waitFor();
  assert.equal(
    await page.locator("#result").innerText(),
    "JavaScript rendered",
  );
  assert.equal(await page.title(), "Kaeno browser smoke");
  console.log(
    JSON.stringify({
      check: "browser-smoke",
      chromium: browser.version(),
      uid: process.getuid(),
      rendered: "JavaScript rendered",
    }),
  );
} finally {
  await browser.close();
}
