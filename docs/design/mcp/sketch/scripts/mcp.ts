// `npm run mcp -- lock [--config <mcp.json>] [--repoint <id>]... [--forget <id>/<tool>]...`
// `npm run mcp -- lock --builtin`   (developer: re-pin browser; commit the diff)
// Same shape as scripts/auth.ts: an owner/dev command, never a runtime path. Restart to apply.
import { parseArgs } from "node:util";
import { lockMcp } from "../src/extensions/mcp/index.ts";
import { browserLockTarget } from "../src/extensions/browser/index.ts";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      builtin: { type: "boolean" },
      repoint: { type: "string", multiple: true },
      forget: { type: "string", multiple: true },
    },
  });
  if (positionals.join(" ") !== "lock") {
    throw new Error(
      "Usage: npm run mcp -- lock [--config <file> | --builtin] ...",
    );
  }
  // TODO: builtin -> lockMcp(browser/mcp.lock.json, [browserLockTarget()])
  //       else    -> lockMcp(lockFileFor(config), targets parsed from mcp.json)
  //       print LockReport; exit 1 and write nothing on failure.
  void [lockMcp, browserLockTarget, values];
  throw new Error("not implemented");
}
await main();
