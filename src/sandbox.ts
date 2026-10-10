import { spawn, type ChildProcess } from "node:child_process";
import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { Assignment } from "./ledger.ts";

const quote = (path: string) => JSON.stringify(path);
export async function sandboxPolicy(cell: string, mode: "faux" | "openai") {
  if (process.platform !== "darwin") throw new Error("Prototype sandbox requires macOS sandbox-exec; refusing unsandboxed execution");
  const app = await realpath(resolve(import.meta.dirname, ".."));
  const owned = await realpath(cell);
  const node = await realpath(process.execPath);
  const home = await realpath(homedir());
  // This experimental macOS Seatbelt policy excludes other home files and all home writes
  // except this cell. It is NOT a hardened container/microVM or a general-purpose isolation layer.
  return `(version 1) (allow default)
    (deny file-read* (subpath ${quote(home)}))
    (allow file-read-metadata (subpath ${quote(home)}))
    (deny file-write* (subpath ${quote(home)}))
    (allow file-read* (subpath ${quote(resolve(app,"src"))}) (subpath ${quote(resolve(app,"node_modules"))}) (literal ${quote(resolve(app,"package.json"))}) (subpath ${quote(dirname(node))}) (subpath ${quote(owned)}))
    (allow file-write* (subpath ${quote(owned)}))
    ${mode === "faux" ? "(deny network*)" : ""}`;
}
export async function launch(job: Assignment, cell: string, mode: "faux" | "openai"): Promise<ChildProcess> {
  const owned = await realpath(cell);
  const node = await realpath(process.execPath);
  const app = await realpath(resolve(import.meta.dirname, ".."));
  const policy = await sandboxPolicy(cell,mode);
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: owned, TMPDIR: resolve(owned, "tmp") };
  if (mode === "openai") {
    if (!process.env.KAENO_OPENAI_API_KEY) throw new Error("Set KAENO_OPENAI_API_KEY for live mode");
    env.OPENAI_API_KEY = process.env.KAENO_OPENAI_API_KEY; // Process-scoped only; not persisted or sent to the model as text.
  }
  return spawn("/usr/bin/sandbox-exec", ["-p",policy,node,"--experimental-strip-types",resolve(app,"src/worker.ts")],
    {cwd:owned,env,stdio:["ignore","ignore","ignore","ipc"]});
}
