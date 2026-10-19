/** Run inside the candidate WORK image/pod, never on the credential-bearing host. */
import { createServer } from "node:http";
import { once } from "node:events";
import { BrowserSession } from "../src/extensions/browser/index.ts";

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
  if (!JSON.stringify(snapshot).includes("JavaScript ready kaeno-persisted")) {
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
