// AFTER src/host/envd.ts: envd composes the work tool plane from feature-owned recipes.
// Adding a second sandbox MCP server = one recipe in its feature + one entry here + its lock.
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { EnvironmentServer } from "../extensions/execution/index.ts";
import { setupSsh } from "../extensions/github/index.ts";
import { browserRecipe } from "../extensions/browser/index.ts";
import { WorkMcpHost } from "../extensions/mcp/index.ts";

const mcp = new WorkMcpHost([browserRecipe]);
const token = process.env.KAENO_ENV_TOKEN ?? "";
if (token.length < 32) {
  throw new Error("KAENO_ENV_TOKEN must be set");
}
console.log(
  `github ssh: ${(await setupSsh()) ? "configured" : "no key mounted"}`,
);
const port = Number(process.env.PORT ?? 7070);
const server = new EnvironmentServer(
  token,
  (cwd) => new NodeExecutionEnv({ cwd }),
  process.cwd(),
  mcp,
).server.listen(port, () =>
  console.log(`envd listening on :${port}, cwd ${process.cwd()}`),
);
process.once("SIGTERM", () => {
  server.close();
  void mcp.close().finally(() => process.exit(0));
});
